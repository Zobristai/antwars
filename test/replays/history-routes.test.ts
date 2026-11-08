import { createServer } from "node:http";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { historyBytes, type HistoryInput } from "../../src/replays/history.ts";
import { cachedLobbyLookup, historyRoutes, lobbySeatHandles, recordingMatchType, recordingMatchTypes, type RecordingLobby,
  type TypedHistorySummary } from "../../src/replays/history-routes.ts";
import type { HistoryPage, HistorySource, HistorySummary } from "../../src/replays/history-source.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { colonyModels } from "../../web/src/pages/model.ts";
import { playable } from "../playable.ts";

const HOUSE = "antwars/gpt-6-1-sol-xhigh", HOUSE_FAST = "antwars/gpt-6-1-sol-high-fast";
type SeatSpec = { colony: 0 | 1; handle?: string | null; thinkingLevel?: string | null };
function row(id: string, seats: SeatSpec[]): HistorySummary {
  return { id, startedAt: "2026-10-20T10:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0, reason: "time_up", decidedBy: "territory",
    seats: seats.map((seat, index) => ({ seat: index, colony: seat.colony, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: seat.thinkingLevel ?? null,
      serviceTier: null, handle: seat.handle ?? null })),
    status: "complete", unavailable: [] };
}
const page = (...matches: HistorySummary[]): HistoryPage => ({ matches, nextPageToken: null });
const seat = (id: string, displayName: string) => ({ id, displayName });
const handles = (summary: HistorySummary) => summary.seats.map(seat => seat.handle);

/** A lookup over fixed lobbies by replay id, counting store reads per id. */
function lobbies(byReplay: Record<string, RecordingLobby | null | "pending" | Error>) {
  const reads: string[] = [];
  return { reads, lookup: async (replayId: string) => {
    reads.push(replayId);
    const lobby = byReplay[replayId];
    if (lobby instanceof Error) throw lobby;
    return lobby ?? null;
  } };
}

describe("older Recordings take each colony's handle from its lobby", () => {
  const fourVsFour = "2026-10-31T07-20-50-000Z-1";
  it("fills all four seats of a colony whose four seats hold one identity (one stored seat id), and their badges", async () => {
    // A queue-made 4v4: one identity holds every seat of its colony.
    const { lookup } = lobbies({ [fourVsFour]: { kind: "public", size: 4, mode: "house-4v4", colonies: [
      [seat("house-a", HOUSE), seat("house-a", HOUSE), seat("house-a", HOUSE), seat("house-a", HOUSE)],
      [seat("house-b", HOUSE_FAST), seat("house-b", HOUSE_FAST), seat("house-b", HOUSE_FAST), seat("house-b", HOUSE_FAST)],
    ] } });
    const recorded = row(fourVsFour, [0, 1, 0, 1, 0, 1, 0, 1].map(colony => ({ colony: colony as 0 | 1 })));
    const filled = (await lobbySeatHandles(lookup)(page(recorded))).matches[0]!;
    expect(handles(filled)).toEqual([HOUSE, HOUSE_FAST, HOUSE, HOUSE_FAST, HOUSE, HOUSE_FAST, HOUSE, HOUSE_FAST]);
    // The badge rule, unchanged: each handle's fixed level and tier.
    expect(colonyModels(filled.seats)?.map(colony => colony?.map(model => model.badges))).toEqual([
      [["xhigh"], ["xhigh"], ["xhigh"], ["xhigh"]], [["high", "Fast"], ["high", "Fast"], ["high", "Fast"], ["high", "Fast"]]]);
    expect(handles(recorded)).toEqual(Array(8).fill(null)); // The listed row itself is not rewritten.
  });

  it("leaves a colony blank when its seats carry different identities, filling only the single-identity colony", async () => {
    const id = "2026-10-31T07-41-12-000Z-1";
    const { lookup } = lobbies({ [id]: { kind: "public", size: 1, mode: null, colonies: [
      // Same display name, different ids: distinctness is by stored seat id, so this colony is mixed.
      [seat("alice", "alice/bot"), seat("bob", "alice/bot")],
      [seat("house-c", HOUSE), seat("house-c", HOUSE)],
    ] } });
    const filled = (await lobbySeatHandles(lookup)(page(row(id, [{ colony: 0 }, { colony: 1 }, { colony: 0 }, { colony: 1 }])))).matches[0]!;
    expect(handles(filled)).toEqual([null, HOUSE, null, HOUSE]);
  });

  it("keeps recorded handles and does no lookup for a fully recorded row; fills only missing seats otherwise", async () => {
    const full = "2026-10-31T08-00-00-000Z-1", partial = "2026-10-31T08-10-00-000Z-1";
    const { lookup, reads } = lobbies({
      [full]: { kind: "public", size: 1, mode: null, colonies: [[seat("x", "antwars/other")], [seat("y", "antwars/other")]] },
      [partial]: { kind: "public", size: 1, mode: null, colonies: [[seat("x", "antwars/lobby")], [seat("y", HOUSE)]] },
    });
    const result = await lobbySeatHandles(lookup)(page(
      row(full, [{ colony: 0, handle: HOUSE_FAST }, { colony: 1, handle: HOUSE }]),
      row(partial, [{ colony: 0, handle: HOUSE_FAST }, { colony: 1 }]),
    ));
    expect(result.matches.map(handles)).toEqual([[HOUSE_FAST, HOUSE], [HOUSE_FAST, HOUSE]]);
    expect(reads).toEqual([partial]);
  });

  it("leaves rows with no lobby, a private lobby or a failed lookup unfilled; caches results but not failures", async () => {
    const scheduled = "2026-10-31T09-00-00-000Z-1", hidden = "2026-10-31T09-10-00-000Z-1", broken = "2026-10-31T09-20-00-000Z-1", house = "2026-10-31T09-30-00-000Z-1";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = {
      [scheduled]: null,
      [hidden]: { kind: "private", size: 1, mode: null, colonies: [[seat("p", "alice/private")], [seat("q", "bob/private")]] },
      [broken]: new Error("store unavailable"),
      [house]: { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] },
    };
    const { lookup, reads } = lobbies(byReplay);
    const fill = lobbySeatHandles(lookup);
    const listing = page(...[scheduled, hidden, broken, house].map(id => row(id, [{ colony: 0 }, { colony: 1 }])));
    const first = await fill(listing);
    expect(first.matches.map(handles)).toEqual([[null, null], [null, null], [null, null], [HOUSE, HOUSE_FAST]]);
    expect(reads.sort()).toEqual([scheduled, hidden, broken, house].sort());
    // A repeated listing reads the store again only for the failed row, which now succeeds.
    byReplay[broken] = { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] };
    reads.length = 0;
    const second = await fill(listing);
    expect(reads).toEqual([broken]);
    expect(second.matches.map(handles)).toEqual([[null, null], [null, null], [HOUSE, HOUSE_FAST], [HOUSE, HOUSE_FAST]]);
    reads.length = 0;
    await fill(listing);
    expect(reads).toEqual([]);
  });

  it("looks a pending recording up again until its lobby link publishes, then caches it; a no-lobby answer is read once", async () => {
    // The replay link publishes after the recording is saved, so a record can be listed while its lobby match reads "pending".
    const id = "2026-10-20T10-00-00-000Z-9", scheduled = "2026-10-20T10-00-00-000Z-10";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = { [id]: "pending", [scheduled]: null };
    const { lookup, reads } = lobbies(byReplay);
    const fill = lobbySeatHandles(lookup);
    const listing = page(row(id, [{ colony: 0 }, { colony: 1 }]), row(scheduled, [{ colony: 0 }, { colony: 1 }]));
    expect((await fill(listing)).matches.map(handles)).toEqual([[null, null], [null, null]]);
    expect((await fill(listing)).matches.map(handles)).toEqual([[null, null], [null, null]]);
    // Pending is looked up on every listing; the scheduled match's no-lobby answer only once, however recent.
    expect(reads.filter(read => read === id)).toEqual([id, id]);
    expect(reads.filter(read => read === scheduled)).toEqual([scheduled]);
    byReplay[id] = { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] };
    expect((await fill(listing)).matches.map(handles)).toEqual([[HOUSE, HOUSE_FAST], [null, null]]);
    reads.length = 0;
    await fill(listing);
    expect(reads).toEqual([]); // Both answers are now cached.
  });
});

describe("Recordings carry each recording's match type", () => {
  const lobby = (fields: Partial<RecordingLobby>): RecordingLobby =>
    ({ kind: "public", size: 2, mode: null, colonies: [[seat("a", "alice/bot")], [seat("b", "bob/bot")]], ...fields });
  const typed = (rated: boolean | null, modelIndex: boolean, seats: SeatSpec[]) => ({ ...row("2026-10-20T10-00-00-000Z-1", seats), rated, modelIndex });
  const twoVsTwo: SeatSpec[] = [{ colony: 0 }, { colony: 1 }, { colony: 0 }, { colony: 1 }];

  it("types a row from its lobby: house mode Index, queue mode Ranked, house challenge, player-made Unranked", () => {
    // The record's own setup is ignored where a lobby was read: here it says unrated with no marker.
    const record = typed(false, false, twoVsTwo);
    expect(recordingMatchType(record, lobby({ mode: "house-2v2" }))).toEqual({ kind: "index", size: 2 });
    expect(recordingMatchType(record, lobby({ mode: "3v3", size: 3 }))).toEqual({ kind: "ranked", size: 3 });
    expect(recordingMatchType(record, lobby({ size: 1, challenge: { kind: "house" } }))).toEqual({ kind: "challenge", size: 1 });
    expect(recordingMatchType(record, lobby({ size: 4 }))).toEqual({ kind: "unranked", size: 4 });
  });

  it("falls back to the record's setup with no readable lobby: marker, unrated, and rated by seat handles", () => {
    for (const none of [null, undefined]) {
      expect(recordingMatchType(typed(true, true, twoVsTwo), none)).toEqual({ kind: "index", size: 2 });
      expect(recordingMatchType(typed(false, false, twoVsTwo), none)).toEqual({ kind: "unrated", size: 2 });
      expect(recordingMatchType(typed(true, false, [{ colony: 0, handle: HOUSE }, { colony: 1, handle: HOUSE_FAST }]), none))
        .toEqual({ kind: "index", size: 1 });
      expect(recordingMatchType(typed(true, false, [{ colony: 0, handle: HOUSE }, { colony: 1, handle: "alice/bot" }]), none))
        .toEqual({ kind: "ranked", size: 1 });
      // A non-house handle decides Ranked even beside a blank one.
      expect(recordingMatchType(typed(true, false, [{ colony: 0 }, { colony: 1, handle: "alice/bot" }]), none)).toEqual({ kind: "ranked", size: 1 });
    }
    // NvN is the larger colony's seat count; a record with no seats has none.
    expect(recordingMatchType(typed(false, false, [{ colony: 0 }, { colony: 1 }, { colony: 1 }]), null)).toEqual({ kind: "unrated", size: 2 });
    expect(recordingMatchType(typed(false, false, []), null)).toEqual({ kind: "unrated", size: null });
  });

  it("gives no type, never Ranked on the rated flag alone, to a rated lobby-less row with blank handles, or with no setup", () => {
    expect(recordingMatchType(typed(true, false, twoVsTwo), null)).toBeNull();
    expect(recordingMatchType(typed(true, false, [{ colony: 0, handle: HOUSE }, { colony: 1 }]), null)).toBeNull();
    expect(recordingMatchType(typed(true, false, []), null)).toBeNull();
    expect(recordingMatchType(typed(null, false, [{ colony: 0, handle: "alice/bot" }, { colony: 1 }]), null)).toBeNull();
    // A summary built without the setup fields reads as unknown, too.
    expect(recordingMatchType(row("2026-10-20T10-00-00-000Z-1", twoVsTwo), null)).toBeNull();
  });

  it("types a pending or failed lookup's row from its record for that listing, then from its lobby once it reads", async () => {
    const pending = "2026-10-31T11-00-00-000Z-1", broken = "2026-10-31T11-10-00-000Z-1", scheduled = "2026-10-31T11-20-00-000Z-1", found = "2026-10-31T11-30-00-000Z-1";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = {
      [pending]: "pending", [broken]: new Error("store unavailable"), [scheduled]: null, [found]: lobby({ mode: "2v2" }),
    };
    const { lookup, reads } = lobbies(byReplay);
    const types = recordingMatchTypes(cachedLobbyLookup(lookup));
    const listing = page(...[pending, broken, scheduled, found].map(id => ({ ...row(id, twoVsTwo), rated: false, modelIndex: false })));
    const kinds = async () => ((await types(listing)).matches as TypedHistorySummary[]).map(match => match.matchType?.kind ?? null);
    expect(await kinds()).toEqual(["unrated", "unrated", "unrated", "ranked"]);
    expect(reads.sort()).toEqual([pending, broken, scheduled, found].sort());
    byReplay[pending] = lobby({ size: 1, challenge: { kind: "house" } });
    byReplay[broken] = lobby({ mode: "house-2v2" });
    reads.length = 0;
    expect(await kinds()).toEqual(["challenge", "index", "unrated", "ranked"]);
    // Only the pending and failed rows are read again; no lobby and a found lobby were cached.
    expect(reads.sort()).toEqual([pending, broken].sort());
    reads.length = 0;
    await kinds();
    expect(reads).toEqual([]);
  });

  it("types every row from its record when the server has no lobby lookup", async () => {
    const listed = await recordingMatchTypes(undefined)(page({ ...row("2026-10-31T12-00-00-000Z-1", twoVsTwo), rated: true, modelIndex: true }));
    expect(listed.matches.map(match => match.matchType)).toEqual([{ kind: "index", size: 2 }]);
  });
});

describe("GET /matches with a lobby lookup", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  it("serves lobby-filled handles and still serves the listing when the lookup fails", async () => {
    const ok = "2026-10-31T10-00-00-000Z-1", failing = "2026-10-31T10-10-00-000Z-1";
    const source: HistorySource = {
      async list() { return page(row(ok, [{ colony: 0 }, { colony: 1 }]), row(failing, [{ colony: 0 }, { colony: 1 }])); },
      async open() { return null; },
    };
    const { lookup } = lobbies({ [ok]: { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] }, [failing]: new Error("store unavailable") });
    const handler = historyRoutes(source, lookup);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`);
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { matches: TypedHistorySummary[] };
    expect(listed.matches.map(handles)).toEqual([[HOUSE, HOUSE_FAST], [null, null]]);
    // Each row carries its match type: the lobby's where it read, the record's (here unknown: no setup fields) where it failed.
    expect(listed.matches.map(match => match.matchType)).toEqual([{ kind: "unranked", size: 1 }, null]);
  });

  it("reads each recording's lobby once for both the handle fill and the match type", async () => {
    const id = "2026-10-31T10-20-00-000Z-1";
    const source: HistorySource = {
      async list() { return page({ ...row(id, [{ colony: 0 }, { colony: 1 }]), rated: true, modelIndex: false }); },
      async open() { return null; },
    };
    const { lookup, reads } = lobbies({ [id]: { kind: "public", size: 1, mode: "1v1", colonies: [[seat("h", HOUSE)], [seat("a", "alice/bot")]] } });
    const handler = historyRoutes(source, lookup);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`;
    for (let listing = 0; listing < 2; listing++) {
      const listed = (await (await fetch(url)).json()) as { matches: TypedHistorySummary[] };
      expect(listed.matches.map(match => [handles(match), match.matchType])).toEqual([[[HOUSE, "alice/bot"], { kind: "ranked", size: 1 }]]);
    }
    expect(reads).toEqual([id]);
  });
});

/** A short two-seat match's binary and log: the input the record service hands the real record writer. */
function matchInput(id: string): HistoryInput {
  const config = { ...playable(rulesConfig("redesign")), matchTicks: 4, commandFloorTicks: 100, startAnts: 16 };
  let state = createMatch(6006, config);
  const recorder = new SpectatorRecorder(state);
  const messages = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const lines = [headerLine(state.seed, config)];
  while (state.result === null) {
    const inputs: SimInput[] = state.tick === 0
      ? ["model-V1", "model-L1"].map((modelLabel, index) => ({ type: "join", agentId: `seat-private-${index}`, modelLabel })) : [];
    if (inputs.length) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    messages.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    state = out.state;
  }
  return { id, binary: gzipSync(packMessages(messages)), logLines: lines, endedAt: Date.parse("2026-10-20T02:00:00.404Z") };
}

describe("GET/HEAD /matches/<id> cache headers across an unavailable record's replacement", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  const id = "2026-10-20T02-00-00-000Z-18";

  /** Serves records as the record store holds them: one body per id, replaced in place, read in `chunk`-byte pieces. */
  async function serve(stored: Map<string, Uint8Array>, chunk = Infinity) {
    const pieces = (body: Uint8Array) => {
      const out: Buffer[] = [];
      for (let at = 0; at < body.length; at += Math.min(chunk, body.length)) out.push(Buffer.from(body.subarray(at, at + chunk)));
      return out;
    };
    const source: HistorySource = {
      async list() { return page(); },
      async open(match) { const body = stored.get(match); return body === undefined ? null : Readable.from(pieces(body)); },
    };
    const handler = historyRoutes(source);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string, method = "GET") => {
      const response = await fetch(base + path, { method });
      return { status: response.status, cacheControl: response.headers.get("cache-control"), body: new Uint8Array(await response.arrayBuffer()) };
    };
  }

  const IMMUTABLE = "public, max-age=31536000, immutable", SHORT = "public, max-age=60";

  // The real record writer (history worker), so a change in its key order fails here instead of silently dropping caching:
  // an undecodable binary yields the unavailable record, a binary alone the partial one, a verified log the complete one.
  const status = (body: Uint8Array) => (JSON.parse(new TextDecoder().decode(body)) as { status: string }).status;

  it("serves an unavailable record briefly and the complete record that replaces it as immutable, both from the real writer", async () => {
    const unavailable = await historyBytes({ id, binary: new Uint8Array([1, 2, 3]) });
    const complete = await historyBytes(matchInput(id));
    expect([status(unavailable), status(complete)]).toEqual(["unavailable", "complete"]);
    const stored = new Map([[id, unavailable]]);
    const get = await serve(stored);
    for (const method of ["GET", "HEAD"]) {
      expect(await get(`/matches/${id}`, method)).toMatchObject({ status: 200, cacheControl: SHORT });
    }
    expect((await get(`/matches/${id}`)).body).toEqual(unavailable);
    stored.set(id, complete); // The record store replaces the unavailable record in place.
    for (const method of ["GET", "HEAD"]) {
      expect(await get(`/matches/${id}`, method)).toMatchObject({ status: 200, cacheControl: IMMUTABLE });
    }
    expect((await get(`/matches/${id}`)).body).toEqual(complete);
    expect(await get("/matches")).toMatchObject({ status: 200, cacheControl: "no-store" });
    expect(await get("/matches/2026-10-20T02-00-00-000Z-19")).toMatchObject({ status: 404, cacheControl: "no-store" });
  });

  it("serves a partial record briefly, and decides from the record's opening bytes however the body is chunked", async () => {
    const { logLines: _log, ...binaryOnly } = matchInput(id);
    const partial = await historyBytes(binaryOnly);
    const complete = await historyBytes(matchInput(id));
    expect(status(partial)).toBe("partial");
    for (const chunk of [1, 7, Infinity]) {
      const stored = new Map([[id, partial]]);
      const get = await serve(stored, chunk);
      expect(await get(`/matches/${id}`)).toEqual({ status: 200, cacheControl: SHORT, body: partial });
      expect(await get(`/matches/${id}`, "HEAD")).toMatchObject({ status: 200, cacheControl: SHORT });
      stored.set(id, complete);
      expect(await get(`/matches/${id}`)).toEqual({ status: 200, cacheControl: IMMUTABLE, body: complete });
    }
  });

  it("serves an unrecognised or shorter-than-prefix body unchanged with the short header", async () => {
    const complete = await historyBytes(matchInput(id));
    const otherId = new TextEncoder().encode(new TextDecoder().decode(complete).replace(id, "2026-10-20T02-00-00-000Z-17"));
    for (const body of [new TextEncoder().encode("{}"), new Uint8Array(0), otherId]) {
      const get = await serve(new Map([[id, body]]), 3);
      expect(await get(`/matches/${id}`)).toEqual({ status: 200, cacheControl: SHORT, body });
    }
  });
});

describe("GET /matches/<id> is bounded by no progress, not by total time", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  const id = "2026-10-20T02-00-00-000Z-18";
  const IDLE_MS = 200;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /** Serves one record body from `open`, with the server's responses observable. */
  async function serve(open: () => Readable) {
    const responses: { finished: boolean; closed: Promise<void> }[] = [];
    const source: HistorySource = { async list() { return page(); }, async open() { return open(); } };
    const handler = historyRoutes(source, undefined, { recordIdleMs: IDLE_MS });
    const server = createServer((req, res) => {
      const seen = { finished: false, closed: once(res, "close").then(() => { seen.finished = res.writableFinished; }) };
      responses.push(seen);
      void handler(req, res, undefined as never);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { port: (server.address() as AddressInfo).port, responses };
  }

  it("delivers a large record streamed slowly in full, long past the idle bound in total", async () => {
    const chunk = 64 * 1024, chunks = 48; // 3 MiB
    const record = Buffer.alloc(chunk * chunks);
    for (let at = 0; at < record.length; at++) record[at] = (at * 31 + 7) & 0xff;
    const { port } = await serve(() => Readable.from((async function* () {
      for (let at = 0; at < record.length; at += chunk) { await sleep(IDLE_MS / 4); yield record.subarray(at, at + chunk); }
    })()));
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/matches/${id}`);
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    expect(body.equals(record)).toBe(true);
    expect(elapsed).toBeGreaterThan(IDLE_MS * 10);
  });

  it("ends the wait for a record's opening bytes at the idle bound and releases the upstream record", async () => {
    const upstream = new Readable({ read() {} }); // Opens, then never sends a byte.
    const { port } = await serve(() => upstream);
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/matches/${id}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Match history temporarily unavailable. Please try again." });
    expect(Date.now() - started).toBeLessThan(IDLE_MS * 25);
    expect(upstream.destroyed).toBe(true);
  });

  it("serves a record whose source yields string chunks, byte for byte", async () => {
    const { port } = await serve(() => Readable.from(["{\"id\":", "\"é\"}"]));
    const response = await fetch(`http://127.0.0.1:${port}/matches/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("{\"id\":\"é\"}"));
  });

  it("drops a client that stops reading and releases the upstream record", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20), total = 1024; // 64 MiB, far past any socket buffering
    let sent = 0;
    const upstream = Readable.from((function* () { for (; sent < total; sent++) yield chunk; })());
    const { port, responses } = await serve(() => upstream);
    const client = connect(port, "127.0.0.1");
    client.on("error", () => {});
    close.push(async () => { client.destroy(); });
    await once(client, "connect");
    client.write(`GET /matches/${id} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n`);
    const [first] = await once(client, "data") as [Buffer];
    expect(first.toString("latin1")).toMatch(/^HTTP\/1\.1 200 /);
    client.pause(); // Stalled: takes nothing more.
    const started = Date.now();
    await responses[0]!.closed;
    expect(Date.now() - started).toBeLessThan(IDLE_MS * 25);
    expect(responses[0]!.finished).toBe(false);
    expect(sent).toBeLessThan(total);
    expect(upstream.destroyed).toBe(true);
  });
});
