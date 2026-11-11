import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamAgent, StreamEvent, StreamMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { CORRECTION_MARKER, NEVER_JOINED, SOL_MOVES } from "../../src/rating/correctionPlan.ts";
import { CORRECTION_KIND } from "../../src/rating/unrateNeverJoined.ts";
import { isAbandonedRecord, isAbandonedResult, rewriteMessages } from "../../src/replays/abandonRecording.ts";
import type { ReplaySource } from "../../src/replays/access.ts";
import { CORRECTED_REPLAY_IDS, correctedHistorySource, correctedReplaySource } from "../../src/replays/correctedRecordings.ts";
import { binaryRecord, type MatchRecord } from "../../src/replays/history.ts";
import { historyRoutes } from "../../src/replays/history-routes.ts";
import type { HistorySource, HistorySummary } from "../../src/replays/history-source.ts";
import { replayRoutes } from "../../src/replays/replay-routes.ts";
import type { Fields, Store } from "../../src/store/firestore.ts";
import type { LiveGame, MountHandler } from "../../src/server.ts";
import { ratedRecording } from "./never-joined-fixture.ts";

const [SOL, SOL2] = [SOL_MOVES[0]!, SOL_MOVES[1]!];
const OTHER = "2026-11-02T10-00-00-000Z-7";
const NEVER_JOINED_RECORD: Fields = { kind: CORRECTION_KIND, lobbyId: NEVER_JOINED.lobbyId, replayId: NEVER_JOINED.replayId, runId: "run" };
const SOL_MARKER: Fields = { planDigest: "d".repeat(64), appliedAt: "2026-11-12T00:00:00.000Z" };
/** The moved handle as a whole handle: not as the start of the -fast handle. */
const OLD_HANDLE = new RegExp(`${SOL.from}(?![\\w-])`);

interface Stored { readonly binary: Uint8Array; readonly record: Uint8Array; readonly row: HistorySummary }
function stored(id: string, recording: { binary: Uint8Array; record: MatchRecord; recordBody: Uint8Array }): Stored {
  const r = recording.record;
  return { binary: recording.binary, record: recording.recordBody, row: { id, startedAt: r.startedAt, endedAt: r.endedAt, simulationEndedAt: r.simulationEndedAt,
    winner: r.result?.winner ?? null, reason: r.result?.reason ?? null, decidedBy: r.result?.decidedBy ?? null, status: r.status, unavailable: r.unavailable,
    rated: r.setup?.rated ?? null, modelIndex: false,
    seats: r.seats.map(({ seat, colony, modelLabel, thinkingLevel, serviceTier, handle }) => ({ seat, colony, modelLabel, thinkingLevel, serviceTier, handle })) } };
}

/** The three corrected recordings, stored, plus one no correction touches. */
function bucket(overrides: Partial<Record<string, Partial<Stored>>> = {}) {
  const objects = new Map<string, Stored>([
    [NEVER_JOINED.replayId, stored(NEVER_JOINED.replayId, ratedRecording([1]))],
    [SOL.replayId, stored(SOL.replayId, ratedRecording([0, 1], { names: [SOL.from, "antwars/glm-5-3"], id: SOL.replayId }))],
    [SOL2.replayId, stored(SOL2.replayId, ratedRecording([0, 1], { names: ["antwars/grok-4-7", SOL2.from], id: SOL2.replayId }))],
    [OTHER, stored(OTHER, ratedRecording([0, 1], { names: [SOL.from, "antwars/glm-5-3"], id: OTHER }))],
  ]);
  for (const [id, override] of Object.entries(overrides)) objects.set(id, { ...objects.get(id)!, ...override });
  const replays: ReplaySource = { async open(id) { const o = objects.get(id); return o ? { body: Readable.from([Buffer.from(o.binary)]) } : null; } };
  const history: HistorySource = {
    async list() { return { matches: [...objects.values()].map(o => o.row), nextPageToken: null }; },
    async open(id) { const o = objects.get(id); return o ? Readable.from([Buffer.from(o.record)]) : null; },
  };
  return { objects, replays, history };
}

/** The correction records, in memory; every read is counted, and `fail` makes each read throw. */
function store(docs: Record<string, Fields> = {}, fail = false) {
  const reads: string[] = [];
  const get = vi.fn(async (path: string) => { reads.push(path); if (fail) throw new Error("store down"); return docs[path] ?? null; });
  return { store: { get } as Pick<Store, "get">, reads };
}

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve)); vi.restoreAllMocks(); });
async function serve(docs: Record<string, Fields>, overrides: Parameters<typeof bucket>[0] = {}, fail = false) {
  const b = bucket(overrides);
  const s = store(docs, fail);
  const replays = replayRoutes(correctedReplaySource(b.replays, s.store));
  const history = historyRoutes(correctedHistorySource(b.history, s.store));
  const route = (handler: MountHandler) => handler;
  const server = createServer((req, res) => void route(req.url!.startsWith("/replays/") ? replays : history)(req, res, {} as LiveGame));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  /** The response exactly as sent: no content decoding. */
  const get = (path: string) => new Promise<{ status: number; cache: string | undefined; body: Buffer }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({ status: res.statusCode!, cache: res.headers["cache-control"], body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  const list = async () => JSON.parse((await get("/matches")).body.toString()).matches as HistorySummary[];
  return { ...b, ...s, get, list };
}
const unzip = (body: Buffer) => new Uint8Array(body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body);
const replayOf = (id: string, body: Buffer) => binaryRecord({ id, binary: new Uint8Array(body) });
const handles = (record: MatchRecord) => record.seats.map(seat => seat.handle);
const joinNames = (record: MatchRecord) => record.events.flatMap(({ event }) => event.kind === "join" && event.identity ? [event.identity.displayName] : []);

describe("the matches the rating corrections changed, as served", () => {
  it("serves all three exactly as stored while neither correction reads applied, undecodable bytes included", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const w = await serve({}, { [SOL.replayId]: { binary: garbage, record: garbage } });
    for (const id of CORRECTED_REPLAY_IDS) {
      const [replay, record] = [await w.get(`/replays/${id}`), await w.get(`/matches/${id}`)];
      expect([replay.status, record.status]).toEqual([200, 200]);
      expect(new Uint8Array(replay.body)).toEqual(w.objects.get(id)!.binary);
      expect(new Uint8Array(record.body)).toEqual(w.objects.get(id)!.record);
    }
    const rows = await w.list();
    expect(rows.map(row => row.id)).toEqual([...w.objects.keys()]);
    rows.forEach((row, i) => expect(row).toMatchObject([...w.objects.values()][i]!.row));
  });

  it("caches the three for a minute only, before and after the apply; every other recording stays immutable", async () => {
    const applied: Record<string, Fields> = { [`ratingCorrections/${NEVER_JOINED.lobbyId}`]: NEVER_JOINED_RECORD, [CORRECTION_MARKER]: SOL_MARKER };
    for (const docs of [{}, applied]) {
      const w = await serve(docs);
      for (const id of CORRECTED_REPLAY_IDS) {
        expect((await w.get(`/replays/${id}`)).cache).toBe("public, max-age=60, no-transform");
        expect((await w.get(`/matches/${id}`)).cache).toBe("public, max-age=60");
      }
      expect((await w.get(`/replays/${OTHER}`)).cache).toBe("public, max-age=31536000, immutable, no-transform");
    }
  });

  it("serves the never-joined match abandoned and unrated once its correction record names it, and counts it unrated", async () => {
    const w = await serve({ [`ratingCorrections/${NEVER_JOINED.lobbyId}`]: NEVER_JOINED_RECORD });
    const stored = w.objects.get(NEVER_JOINED.replayId)!;
    expect(stored.row.rated).toBe(true);
    const replay = replayOf(NEVER_JOINED.replayId, (await w.get(`/replays/${NEVER_JOINED.replayId}`)).body);
    expect(isAbandonedResult(replay.result)).toBe(true);
    expect(replay.setup?.rated).toBe(false);
    const record = JSON.parse((await w.get(`/matches/${NEVER_JOINED.replayId}`)).body.toString()) as MatchRecord;
    expect(isAbandonedRecord(record)).toBe(true);
    // Every tick and event is kept: only the result and the rated flag change.
    expect(record.events.length).toBe(JSON.parse(Buffer.from(stored.record).toString()).events.length);
    const rows = await w.list();
    expect(rows.find(row => row.id === NEVER_JOINED.replayId)).toMatchObject({ ...stored.row, winner: null, reason: "abandoned", decidedBy: "draw", rated: false });
    expect(rows.filter(row => row.rated === true).map(row => row.id)).toEqual([SOL.replayId, SOL2.replayId, OTHER]);
    // The Sol match is not touched by the never-joined correction.
    expect(new Uint8Array((await w.get(`/replays/${SOL.replayId}`)).body)).toEqual(w.objects.get(SOL.replayId)!.binary);
  });

  it("does not read a correction record that names another recording as applied", async () => {
    const w = await serve({ [`ratingCorrections/${NEVER_JOINED.lobbyId}`]: { ...NEVER_JOINED_RECORD, replayId: OTHER } });
    expect(new Uint8Array((await w.get(`/replays/${NEVER_JOINED.replayId}`)).body)).toEqual(w.objects.get(NEVER_JOINED.replayId)!.binary);
  });

  it("names the -fast handle on the Sol match's replay, record and row once the Sol move is recorded applied, and never the old one", async () => {
    const before = await serve({ [`ratingCorrections/${NEVER_JOINED.lobbyId}`]: NEVER_JOINED_RECORD });
    expect(handles(replayOf(SOL.replayId, (await before.get(`/replays/${SOL.replayId}`)).body))).toEqual([SOL.from, "antwars/glm-5-3"]);

    const w = await serve({ [CORRECTION_MARKER]: SOL_MARKER });
    const replayBody = (await w.get(`/replays/${SOL.replayId}`)).body;
    const replay = replayOf(SOL.replayId, replayBody);
    expect(handles(replay)).toEqual([SOL.to, "antwars/glm-5-3"]);
    expect(joinNames(replay)).toEqual([SOL.to, "antwars/glm-5-3"]);
    expect(JSON.stringify(replay)).not.toMatch(OLD_HANDLE);
    expect(Buffer.from(unzip(replayBody)).toString("latin1")).not.toMatch(OLD_HANDLE);
    // The result, ticks and recorded rating figures are as recorded.
    const original = replayOf(SOL.replayId, Buffer.from(w.objects.get(SOL.replayId)!.binary));
    expect(replay.result).toEqual(original.result);
    expect(replay.events.length).toBe(original.events.length);

    const text = (await w.get(`/matches/${SOL.replayId}`)).body.toString();
    expect(text).not.toMatch(OLD_HANDLE);
    const record = JSON.parse(text) as MatchRecord;
    expect(handles(record)).toEqual([SOL.to, "antwars/glm-5-3"]);
    expect(joinNames(record)).toEqual([SOL.to, "antwars/glm-5-3"]);
    expect(record.result).toEqual(JSON.parse(Buffer.from(w.objects.get(SOL.replayId)!.record).toString()).result);

    const rows = await w.list();
    expect(rows.find(row => row.id === SOL.replayId)!.seats.map(seat => seat.handle)).toEqual([SOL.to, "antwars/glm-5-3"]);
    // Another match the same handle played is unchanged, and so is the never-joined one.
    expect(rows.find(row => row.id === SOL2.replayId)!.seats.map(seat => seat.handle)).toEqual(["antwars/grok-4-7", SOL2.to]);
    expect(rows.find(row => row.id === OTHER)).toMatchObject(w.objects.get(OTHER)!.row);
    expect(new Uint8Array((await w.get(`/replays/${OTHER}`)).body)).toEqual(w.objects.get(OTHER)!.binary);
    expect(new Uint8Array((await w.get(`/replays/${NEVER_JOINED.replayId}`)).body)).toEqual(w.objects.get(NEVER_JOINED.replayId)!.binary);
  });

  it("answers 503, never the stored bytes, for an undecodable Sol replay or record once the Sol move is applied", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const garbage = new Uint8Array([0x1f, 0x8b, 9, 9, 9]);
    const w = await serve({ [CORRECTION_MARKER]: SOL_MARKER }, { [SOL.replayId]: { binary: garbage, record: new TextEncoder().encode(`{"x":"${SOL.from}"`) } });
    for (const path of [`/replays/${SOL.replayId}`, `/matches/${SOL.replayId}`]) {
      const response = await w.get(path);
      expect(response.status).toBe(503);
      expect(response.cache).toBe("no-store");
      expect(response.body.toString()).not.toMatch(OLD_HANDLE);
      expect(response.body.includes(Buffer.from(garbage))).toBe(false);
    }
  });

  it("never serves the old handle from a field the move does not rename: the record replaces it, the replay and row answer 503", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = bucket().objects.get(SOL.replayId)!;
    const mapName = `Field of ${SOL.from}`;
    // The old handle stored where the move replaces nothing: the replay's map name, the record's, and a row's thinking level.
    const binary = rewriteMessages(original.binary, message => message.full === null ? null
      : { ...message, full: { ...message.full, setup: { ...message.full.setup, terrain: { ...message.full.setup.terrain!, mapName } } } }).body!;
    expect(Buffer.from(unzip(Buffer.from(binary))).toString("latin1")).toMatch(OLD_HANDLE);
    const record = new TextEncoder().encode(Buffer.from(original.record).toString().replaceAll('"Open Field"', JSON.stringify(mapName)));
    expect(Buffer.from(record).toString()).toMatch(OLD_HANDLE);
    const row = { ...original.row, seats: original.row.seats.map(seat => seat.seat === 1 ? { ...seat, thinkingLevel: SOL.from } : seat) };
    const w = await serve({ [CORRECTION_MARKER]: SOL_MARKER }, { [SOL.replayId]: { binary, record, row } });

    const replay = await w.get(`/replays/${SOL.replayId}`);
    expect([replay.status, replay.cache]).toEqual([503, "no-store"]);
    expect(Buffer.from(unzip(replay.body)).toString("latin1")).not.toMatch(OLD_HANDLE);
    const matches = await w.get("/matches");
    expect([matches.status, matches.cache]).toEqual([503, "no-store"]);
    expect(matches.body.toString()).not.toMatch(OLD_HANDLE);
    const text = (await w.get(`/matches/${SOL.replayId}`)).body.toString();
    expect(text).not.toMatch(OLD_HANDLE);
    expect(handles(JSON.parse(text) as MatchRecord)).toEqual([SOL.to, "antwars/glm-5-3"]);
    expect(text).toContain(`Field of ${SOL.to}`);

    // Before the move is applied, the same stored bytes are served as stored.
    const before = await serve({}, { [SOL.replayId]: { binary, record, row } });
    expect(new Uint8Array((await before.get(`/replays/${SOL.replayId}`)).body)).toEqual(binary);
    expect((await before.get("/matches")).status).toBe(200);
  });

  it("replaces the old handle in model labels and intent lines on the Sol replay and row, and serves none of it", async () => {
    const original = bucket().objects.get(SOL.replayId)!;
    const agent: StreamAgent = { identity: { displayName: SOL.from, elo: 1500 }, colony: 0, modelLabel: `${SOL.from} (agents)`, joinTick: 0,
      lastCallTick: 0, prevCallTick: -1, order: "hold", orderX: 1, orderY: 1, intent: `agent holds for ${SOL.from}` };
    let first = true;
    const binary = rewriteMessages(original.binary, (message): StreamMessage | null => {
      const full = message.full !== null && first ? { ...message.full, agents: [agent] } : message.full;
      first = false;
      const events = message.events.flatMap((event): StreamEvent[] => event.kind !== "join" ? [event]
        : [{ ...event, modelLabel: `${SOL.from} (join ${event.agent})` },
          { kind: "order" as const, agent: event.agent, order: "hold" as const, tileX: 1, tileY: 1, intent: `order for ${SOL.from}` }]);
      return { ...message, full, events };
    }).body!;
    const row = { ...original.row, seats: original.row.seats.map(seat => ({ ...seat, modelLabel: `${SOL.from} (row)` })) };
    const w = await serve({ [CORRECTION_MARKER]: SOL_MARKER }, { [SOL.replayId]: { binary, row } });

    const response = await w.get(`/replays/${SOL.replayId}`);
    expect(response.status).toBe(200);
    expect(Buffer.from(unzip(response.body)).toString("latin1")).not.toMatch(OLD_HANDLE);
    const seen: StreamMessage[] = [];
    const messages = rewriteMessages(new Uint8Array(response.body), message => { seen.push(message); return null; });
    const events = seen.flatMap(message => message.events);
    const joins = events.flatMap(event => event.kind === "join" ? [[event.identity?.displayName, event.modelLabel]] : []);
    expect(joins).toEqual([[SOL.to, `${SOL.to} (join 0)`], ["antwars/glm-5-3", `${SOL.to} (join 1)`]]);
    expect(events.flatMap(event => event.kind === "order" ? [event.intent] : [])).toEqual([`order for ${SOL.to}`, `order for ${SOL.to}`]);
    expect(messages.messages).toBeGreaterThan(0);
    expect(seen[0]!.full!.agents).toHaveLength(1);
    expect(seen[0]!.full!.agents[0]).toMatchObject({ identity: { displayName: SOL.to }, modelLabel: `${SOL.to} (agents)`, intent: `agent holds for ${SOL.to}` });

    const rows = await w.list();
    const solRow = rows.find(r => r.id === SOL.replayId)!;
    expect(solRow.seats.map(seat => seat.modelLabel)).toEqual([`${SOL.to} (row)`, `${SOL.to} (row)`]);
    expect(JSON.stringify(solRow)).not.toMatch(OLD_HANDLE);
  });
  it("answers 503 for an empty Sol replay, or one that names no moved seat, once the Sol move is applied", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const empties = [new Uint8Array(0), new Uint8Array(gzipSync(packMessages([]))), bucket().objects.get(SOL2.replayId)!.binary];
    for (const binary of empties) {
      const before = await serve({}, { [SOL.replayId]: { binary } });
      expect(new Uint8Array((await before.get(`/replays/${SOL.replayId}`)).body)).toEqual(binary);
      const w = await serve({ [CORRECTION_MARKER]: SOL_MARKER }, { [SOL.replayId]: { binary } });
      const response = await w.get(`/replays/${SOL.replayId}`);
      expect([response.status, response.cache]).toEqual([503, "no-store"]);
    }
  });

  it("answers 503 for the three when the correction state cannot be read, and never reads it for any other recording", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await serve({}, {}, true);
    for (const id of CORRECTED_REPLAY_IDS) {
      expect((await w.get(`/replays/${id}`)).status).toBe(503);
      expect((await w.get(`/matches/${id}`)).status).toBe(503);
    }
    expect((await w.get("/matches")).status).toBe(503);
    const reads = w.reads.length;
    const other = await w.get(`/replays/${OTHER}`);
    expect(other.status).toBe(200);
    expect(new Uint8Array(other.body)).toEqual(w.objects.get(OTHER)!.binary);
    expect((await w.get(`/matches/${OTHER}`)).status).toBe(200);
    expect(w.reads.length).toBe(reads);
  });

  it("reads each correction until it is applied, then keeps that answer", async () => {
    const docs: Record<string, Fields> = {};
    const w = await serve(docs);
    await w.get(`/replays/${SOL.replayId}`);
    await w.get(`/replays/${SOL.replayId}`);
    expect(w.reads).toEqual([CORRECTION_MARKER, CORRECTION_MARKER]);
    docs[CORRECTION_MARKER] = SOL_MARKER;
    expect(handles(replayOf(SOL.replayId, (await w.get(`/replays/${SOL.replayId}`)).body))[0]).toBe(SOL.to);
    await w.get(`/replays/${SOL.replayId}`);
    expect(w.reads).toEqual([CORRECTION_MARKER, CORRECTION_MARKER, CORRECTION_MARKER]);
  });
});
