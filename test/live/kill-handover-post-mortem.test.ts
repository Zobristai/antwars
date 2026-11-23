/**
 * Current-format four-colony saves keep the same event history as uninterrupted recording, and a post-mortem compares
 * kill totals, queen bites and queen kills only where the stored record carries them: an older-format recording (made
 * before any of them, or before queen kills alone, was streamed) re-runs cleanly, while a current-format one still
 * catches a difference in any of them.
 */
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { rerunRecord } from "../../src/accounts/postMortemChild.ts";
import { scanRecord } from "../../src/accounts/postMortemRecord.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage, encodeMessage, KILLS_STREAM_VERSION, QUEEN_BITES_STREAM_VERSION, QUEEN_KILLS_STREAM_VERSION, withoutKillTotals, withoutQueenBites, withoutQueenKills, type StreamMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { decodeInput } from "../../src/records/inputs.ts";
import { matchRecord, type MatchRecord } from "../../src/replays/history.ts";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { eliminationsAt, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { ManualClock } from "./helpers.ts";

const QUADRANTS: MapDefinition = {
  id: "handover-quadrants", name: "Handover Quadrants", water: [],
  quadrant: { referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
    startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }] },
};
const CODE = "a".repeat(40);
/** Long enough on the quadrant board for soldiers to meet and kills to be credited. */
const KILL_MATCH_TICKS = 750;

/** A record's post-mortem re-run answer, through the re-run scan as the post-mortem child reads it. */
async function rerun(record: MatchRecord) {
  const scanned = await scanRecord(Readable.from([Buffer.from(JSON.stringify(record))]), undefined, "rerun");
  return rerunRecord(scanned.reduced);
}

/** The recording as an earlier stream wrote it, each message in that stream's format: before any of the three kinds was carried, or before queen kills alone. */
const EARLIER_FORMATS = {
  kills: (message: StreamMessage) => withoutQueenKills(withoutQueenBites(withoutKillTotals(message))),
  queenKills: withoutQueenKills,
} as const;
function earlierFormat(binary: Uint8Array, before: keyof typeof EARLIER_FORMATS): Uint8Array {
  return gzipSync(packMessages(unpackMessages(gunzipSync(binary)).map(bytes => encodeMessage(EARLIER_FORMATS[before](decodeMessage(bytes))))));
}

interface Options {
  /** Match length; the default match is stopped by the server at tick 8. */
  readonly matchTicks?: number;
  /** Every colony breeds soldiers from tick 1, so kills are credited. */
  readonly fight?: boolean;
  /** Queens unshielded and frail enough for the fight to kill some, so queen kills are credited. */
  readonly queensFall?: boolean;
  /** Build the record from the recording re-encoded in the format used before kill totals (and all since), or queen kills, were streamed. */
  readonly before?: keyof typeof EARLIER_FORMATS;
}

async function recorded(delaySeconds: number, handovers: readonly number[], options: Options = {}) {
  const live = newMatchConfig(rulesConfig("redesign"));
  const config = { ...live, matchTicks: options.matchTicks ?? 40,
    ...(options.queensFall === true ? { queenHp: { ...live.queenHp!, shieldTicks: 0, hp: 1000 } } : {}), terrain: { ...live.terrain!, maps: [QUADRANTS] } };
  let state = createMatch(404, config);
  expect(state.colonies).toHaveLength(4);
  const clock = new ManualClock(), inputs = new Map<string, Uint8Array>(), published = new Map<string, Uint8Array>();
  const handoff = createRecordHandoff({ codeVersion: CODE, store: { create: async object => { inputs.set(object.name, object.body); } } });
  const hubs: LiveHub[] = [], released: boolean[] = [];
  const activity = new Map<string, number>();
  const houseIdle = { idleTicks: 1000, activityTick: (id: string) => activity.get(id) };
  const identity = (id: string) => ({ displayName: `Player ${id.slice(-1)}` });
  const serve = () => {
    const hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds }, captureMatchLogs: true,
      replayStore: { create: async object => { published.set(object.name, object.body); } }, recordHandoff: handoff });
    hubs.push(hub); return hub;
  };
  let hub = serve(), seq = 1;
  hub.startMatch(seq, state, undefined, identity, houseIdle);
  try {
    while (state.result === null) {
      if (handovers.includes(state.tick)) {
        const save = await hub.saveMatch(seq);
        released.push((save.meta.stream as { released: boolean }).released);
        // The save crosses servers as JSON metadata and independent part bytes.
        const carried = { meta: JSON.parse(JSON.stringify(save.meta)) as typeof save.meta,
          parts: new Map([...save.parts].map(([name, bytes]) => [name, bytes.slice()])) };
        hub.close(); hub = serve(); seq++;
        await hub.resumeMatch(seq, state, carried, identity, houseIdle);
      }
      const tick = state.tick;
      const calls: SimInput[] = tick === 0
        ? [0, 1, 2, 3].map(colony => ({ type: "join", agentId: `agent-${colony}`, modelLabel: `model-${colony}` }))
        : options.fight === true ? tick === 1 ? [0, 1, 2, 3].map(colony => ({ type: "set_brood", agentId: `agent-${colony}`, brood: "soldiers" })) : []
          : tick === 1 || tick === 4 ? [{ type: "set_brood", agentId: "agent-2", brood: "soldiers" }] : [];
      const stop = options.matchTicks === undefined && tick === 8;
      const out = step(state, calls, undefined, undefined, undefined, stop, true);
      calls.forEach((call, i) => { if (out.results[i]?.ok) activity.set(call.agentId, tick); });
      hub.appendLog(seq, tickLine(tick, calls, stop, true, eliminationsAt(out.state, tick)));
      clock.advance(100); hub.pushTick(seq, out); state = out.state;
    }
    clock.advance((delaySeconds + 2) * 1000);
    await vi.waitFor(() => expect([inputs.size, published.size]).toEqual([1, 1]));
    const input = decodeInput([...inputs.values()][0]!);
    const liveQueenBites = unpackMessages(gunzipSync(input.binary)).map(decodeMessage)
      .some(message => message.events.some(event => event.kind === "queenBites"));
    const binary = options.before === undefined ? input.binary : earlierFormat(input.binary, options.before);
    const versions = unpackMessages(gunzipSync(binary)).map(bytes => bytes[2]!);
    const messages = unpackMessages(gunzipSync(binary)).map(decodeMessage);
    const record = { ...matchRecord({ id: input.id, binary, logLines: input.logLines, endedAt: input.endedAt, rerun: true }), codeVersion: CODE };
    expect(record.status).toBe("complete");
    return { answer: await rerun(record), record, messages, versions, released, liveQueenBites,
      kills: state.colonies.map(colony => colony.kills ?? 0), queenKills: state.colonies.map(colony => colony.queenKills ?? 0) };
  } finally { hubs.forEach(hub => hub.close()); }
}

it("resumes from the newest held kill totals rather than the delayed full board", async () => {
  const live = newMatchConfig(rulesConfig("redesign"));
  let state = createMatch(404, { ...live, terrain: { ...live.terrain!, maps: [QUADRANTS] } });
  const clock = new ManualClock(), messages: StreamMessage[] = [];
  const first = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 60 } });
  const next = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 60 },
    encode: message => { messages.push(structuredClone(message)); return encodeMessage(message); } });
  try {
    first.startMatch(1, state);
    // Deliberate recorder fixture: a new total is held behind the initial zero-total board.
    state.colonies[2]!.kills = 7;
    let out = step(state, []); first.pushTick(1, out); state = out.state;
    const save = await first.saveMatch(1);
    expect((save.meta.stream as { released: boolean }).released).toBe(false);
    await next.resumeMatch(2, state, save);
    out = step(state, [], undefined, undefined, undefined, true);
    next.pushTick(2, out);
    clock.advance(62_000);
    expect(messages.some(message => message.events.some(event => event.kind === "kills" && event.totals[2] === 7))).toBe(true);
    const final = messages.filter(message => message.tick === out.state.tick && message.full === null);
    expect(final.length).toBeGreaterThan(0);
    expect(final.flatMap(message => message.events.filter(event => event.kind === "kills"))).toEqual([]);
  } finally { first.close(); next.close(); }
});

it.each([0, 60])("keeps a saved/resumed current-format record reproducible with %s seconds of playback delay", async delaySeconds => {
  const control = await recorded(delaySeconds, []);
  expect(control.answer).toMatchObject({ kind: "done", undecided: [] });
  const resumed = await recorded(delaySeconds, [3, 6]);
  expect(resumed.released).toEqual([delaySeconds === 0, delaySeconds === 0]);
  expect(resumed.answer).toMatchObject({ kind: "done", undecided: [] });
  expect(resumed.answer).toEqual(control.answer);
  expect(resumed.messages[0]!.full!.kills).toEqual([0, 0, 0, 0]);
  expect(resumed.messages.flatMap(message => message.events.filter(event => event.kind === "kills"))).toEqual([]);
  expect(resumed.messages.map(message => message.events)).toEqual(control.messages.map(message => message.events));
});

describe("post-mortem of a four-colony match that credited kills", () => {
  const killEvents = (record: MatchRecord) => record.events.filter(({ event }) => event.kind === "kills");
  const queenBiteEvents = (record: MatchRecord) => record.events.filter(({ event }) => event.kind === "queenBites");

  it("re-runs an older-format recording, which carries no kill totals or queen bites, without a mismatch", async () => {
    const older = await recorded(0, [], { matchTicks: KILL_MATCH_TICKS, fight: true, before: "kills" });
    expect(older.kills.some(n => n > 0)).toBe(true);
    // Queens were bitten in the live match, but the older-format record stores none of those bites.
    expect(older.liveQueenBites).toBe(true);
    expect(queenBiteEvents(older.record)).toEqual([]);
    expect(older.versions.every(version => version < KILLS_STREAM_VERSION)).toBe(true);
    expect(older.messages.some(message => message.full?.kills !== undefined || message.events.some(event => event.kind === "kills"))).toBe(false);
    expect(killEvents(older.record)).toEqual([]);
    expect(older.answer).toMatchObject({ kind: "done", undecided: [] });
  }, 120_000);

  it("still compares a current-format recording's kill totals", async () => {
    const current = await recorded(0, [], { matchTicks: KILL_MATCH_TICKS, fight: true });
    expect(current.versions).toContain(KILLS_STREAM_VERSION);
    const stored = killEvents(current.record);
    expect(stored.length).toBeGreaterThan(0);
    expect(current.answer).toMatchObject({ kind: "done", undecided: [] });
    // One stored kill total altered: the re-run's block holding it no longer matches.
    const first = stored[0]!;
    const altered = structuredClone(current.record);
    const event = altered.events.find(e => e.tick === first.tick && e.event.kind === "kills")!.event as { kind: "kills"; totals: number[] };
    event.totals[0] = event.totals[0]! + 1;
    expect(await rerun(altered)).toEqual({ kind: "mismatch", tick: (Math.floor(first.tick / 100) + 1) * 100 });
  }, 120_000);

  it("still compares a current-format recording's queen bites", async () => {
    const current = await recorded(0, [], { matchTicks: KILL_MATCH_TICKS, fight: true });
    const stored = queenBiteEvents(current.record);
    expect(stored.length).toBeGreaterThan(0);
    expect(current.answer).toMatchObject({ kind: "done", undecided: [] });
    // One stored queen bite altered: the re-run's block holding it no longer matches.
    const first = stored[0]!;
    const altered = structuredClone(current.record);
    const event = altered.events.find(e => e.tick === first.tick && e.event.kind === "queenBites")!.event as { kind: "queenBites"; targetId: number | null };
    event.targetId = event.targetId === null ? 0 : event.targetId + 1;
    expect(await rerun(altered)).toEqual({ kind: "mismatch", tick: (Math.floor(first.tick / 100) + 1) * 100 });
  }, 120_000);
});

describe("post-mortem of a match that credited queen kills", () => {
  const ofKind = (record: MatchRecord, kind: string) => record.events.filter(({ event }) => event.kind === kind);
  const match = { matchTicks: KILL_MATCH_TICKS, fight: true, queensFall: true } as const;

  it("re-runs a recording from before queen kills, which carries kill totals and queen bites but none of them, without a mismatch", async () => {
    const earlier = await recorded(0, [], { ...match, before: "queenKills" });
    expect(earlier.queenKills.some(n => n > 0)).toBe(true);
    expect(earlier.versions).toContain(QUEEN_BITES_STREAM_VERSION);
    expect(earlier.versions.every(version => version <= QUEEN_BITES_STREAM_VERSION)).toBe(true);
    expect(earlier.messages[0]!.full).not.toHaveProperty("queenKills");
    expect(ofKind(earlier.record, "kills").length).toBeGreaterThan(0);
    expect(ofKind(earlier.record, "queenBites").length).toBeGreaterThan(0);
    expect(ofKind(earlier.record, "queenKills")).toEqual([]);
    expect(earlier.answer).toMatchObject({ kind: "done", undecided: [] });
  }, 120_000);

  it("re-runs a recording from before kill totals, which carries none of the three, without a mismatch", async () => {
    const older = await recorded(0, [], { ...match, before: "kills" });
    expect(older.queenKills.some(n => n > 0)).toBe(true);
    for (const kind of ["kills", "queenBites", "queenKills"]) expect(ofKind(older.record, kind)).toEqual([]);
    expect(older.answer).toMatchObject({ kind: "done", undecided: [] });
  }, 120_000);

  it("still compares a current-format recording's queen kills", async () => {
    const current = await recorded(0, [], match);
    const stored = ofKind(current.record, "queenKills");
    expect(stored.length).toBeGreaterThan(0);
    // The bite that killed the queen and the kill it credited are in one message, at the queen-kill version.
    const both = current.messages.findIndex(m => m.events.some(e => e.kind === "queenKills") && m.events.some(e => e.kind === "queenBites"));
    expect(both).toBeGreaterThan(0);
    expect(current.versions[both]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expect(current.answer).toMatchObject({ kind: "done", undecided: [] });
    // One stored queen kill altered: the re-run's block holding it no longer matches.
    const first = stored[0]!;
    const altered = structuredClone(current.record);
    const event = altered.events.find(e => e.tick === first.tick && e.event.kind === "queenKills")!.event as { kind: "queenKills"; totals: number[] };
    event.totals[0] = event.totals[0]! + 1;
    expect(await rerun(altered)).toEqual({ kind: "mismatch", tick: Math.min((Math.floor(first.tick / 100) + 1) * 100, KILL_MATCH_TICKS) });
  }, 120_000);
});
