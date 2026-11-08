/**
 * Stream resumes: a match handed over to another server keeps its live
 * stream. The match is pushed into one hub and saved there with saveMatch, resumed with resumeMatch
 * into a second hub, saved again and resumed into a third, and so on. Each hub is served over real HTTP and its
 * stream called directly at /watch/live/<lobby>, as a reconnecting browser calls it at the same lobby
 * path. Interim test level: the
 * save travels from hub to hub directly here; the real server handover is tested with the Spectator
 * save wiring.
 *
 * A reference hub is pushed the same ticks with no handover. The resumed stream is checked against it:
 * its deltas are byte-identical and its full snapshots equal but for the match identity, which stays
 * the first server's. The delay rules are today's: 300 s for a rated match outside the house modes, 60 s
 * unrated, 0 s for house matches although they are rated; 10 ticks a second.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { createRng } from "../../src/sim/rng.ts";
import { WIDE_PLAIN } from "../../src/sim/scale2Maps.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState, StepOutput } from "../../src/sim/types.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import type { StreamMessage } from "../../src/live/format.ts";
import { SPECTATOR_SAVE_META_BYTES } from "../../src/live/handover.ts";
import { HEARTBEAT, LiveHub } from "../../src/live/hub.ts";
import type { MatchAccess } from "../../src/live/match-access.ts";
import { scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import { decodeData, delivered, ManualClock, RecordedServer, served, SseClient, type ServedResponse } from "./helpers.ts";
import { playable } from "../playable.ts";

const LOBBY = "00000000-0000-4000-8000-000000000735";
const TICK_MS = 100;
/** The handover's pause: the match does not advance while the next server loads its save. */
const PAUSE_MS = 25_000;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Served { readonly hub: LiveHub; readonly server: RecordedServer; retire(): Promise<void> }

async function serve(clock: ManualClock): Promise<Served> {
  const hub = new LiveHub({ clock, config: DEFAULT_LIVE_CONFIG, requireMatchAccess: true });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  let open = true;
  const retire = async () => { if (!open) return; open = false; hub.close(); await server.close(); };
  cleanup.push(retire);
  return { hub, server, retire };
}

interface Watcher { readonly client: SseClient; readonly response: ServedResponse }

/** A spectator at the lobby path, once the server has its request. */
async function watch(at: Served): Promise<Watcher> {
  const n = at.server.responses.length;
  const client = await SseClient.connect(at.server.url(`/watch/live/${LOBBY}`));
  cleanup.push(async () => client.close());
  return { client, response: await served(at.server, n + 1) };
}

interface Frame { readonly text: string; readonly message: StreamMessage }

function frames(response: ServedResponse, from = 0): Frame[] {
  return response.writes.slice(from).filter(w => w.text.startsWith("data: ")).map(w => ({ text: w.text, message: decodeData(w.text.slice(6).trim()) }));
}

/** A full snapshot without the identity it names its match by. */
function board(message: StreamMessage): StreamMessage {
  return { ...message, full: { ...message.full!, match: undefined } };
}

interface Leg {
  /** The match's tick when this server's stream was saved, or at its result for the last server. */
  readonly matchTick: number;
  readonly frames: Frame[];
  /** Written to this server's spectator after the save: heartbeats only. */
  readonly afterSave: string[];
  /** A spectator joining the reference hub when this server's spectator connected: its full snapshot. */
  readonly referenceFull: Frame | null;
}

/**
 * One match of matchTicks pushed tick by tick, handed over at each of the given ticks: saved on the
 * serving hub, the clock moved on by the pause, resumed into a new hub, and the spectator reconnected
 * there. Plays out to the end of delayed playback.
 */
async function handOver(access: MatchAccess, matchTicks: number, at: readonly number[]) {
  const config = playable({ ...DEFAULT_CONFIG, matchTicks });
  const script: ScriptOptions = { seed: 6006, config, agents: 2, ticks: matchTicks, attack: false };
  const clock = new ManualClock();
  let state = createMatch(script.seed, config);
  const reference = await serve(clock);
  reference.hub.startMatch(1, state, access);
  const referenceWatcher = await watch(reference);
  let serving = { at: await serve(clock), seq: 1 };
  serving.at.hub.startMatch(1, state, access);
  let watcher = await watch(serving.at);
  let referenceFull: Frame | null = null;
  const legs: Leg[] = [];
  // Both spectators read as they go: one that falls a mebibyte behind is dropped as a slow reader.
  const read = async () => { await delivered(watcher.client, watcher.response); await delivered(referenceWatcher.client, referenceWatcher.response); };
  for (;;) {
    const out = step(state, scriptedInputs(state, script));
    reference.hub.pushTick(1, out);
    serving.at.hub.pushTick(serving.seq, out);
    clock.advance(TICK_MS);
    state = out.state;
    if (state.result !== null) break;
    if (state.tick % 50 === 0) await read();
    if (!at.includes(state.tick)) continue;
    await delivered(watcher.client, watcher.response);
    const saved = watcher.response.writes.length;
    const save = await serving.at.hub.saveMatch(serving.seq);
    clock.advance(PAUSE_MS);
    await delivered(watcher.client, watcher.response);
    legs.push({ matchTick: state.tick, frames: frames(watcher.response), afterSave: watcher.response.writes.slice(saved).map(w => w.text), referenceFull });
    // The next server numbers the match itself.
    const next = { at: await serve(clock), seq: serving.seq + 4 };
    await next.at.hub.resumeMatch(next.seq, state, save);
    watcher.client.close();
    await serving.at.retire();
    serving = next;
    watcher = await watch(serving.at);
    const late = await watch(reference);
    await delivered(watcher.client, watcher.response);
    await delivered(late.client, late.response);
    referenceFull = frames(late.response)[0] ?? null;
    late.client.close();
  }
  const resultTick = state.tick;
  for (let i = 0; i < 1_000 && !serving.at.hub.watchStatus(LOBBY)?.playbackFinished; i++) { clock.advance(1_000); await read(); }
  clock.advance(1_000);
  await read();
  legs.push({ matchTick: resultTick, frames: frames(watcher.response), afterSave: [], referenceFull });
  return { legs, reference: frames(referenceWatcher.response) };
}

/** Checks every leg of a handed-over stream against the reference and the delay; returns the final leg's frames. */
function expectResumedStream(run: Awaited<ReturnType<typeof handOver>>, delayTicks: number): Frame[] {
  const deltas = new Map(run.reference.filter(f => f.message.full === null).map(f => [f.message.tick, f.text]));
  const identity = run.legs.find(leg => leg.frames.length > 0)!.frames[0]!.message.full!.match;
  expect(identity).toBeGreaterThan(0);
  run.legs.forEach((leg, i) => {
    if (leg.frames.length === 0) {
      // Saved before playback began: nothing was released on this server.
      expect(leg.matchTick).toBeLessThan(delayTicks);
      expect(i).toBeLessThan(run.legs.length - 1);
    }
    const [full, ...rest] = leg.frames;
    if (full !== undefined) {
      expect(full.message.full).not.toBeNull();
      // The same match: the first server's identity, on every server.
      expect(full.message.full!.match).toBe(identity);
    }
    const before = run.legs[i - 1];
    if (full !== undefined && before !== undefined) {
      const lastSeen = before.frames.at(-1)?.message.tick;
      if (lastSeen === undefined) {
        // Playback had not begun before the save: it begins from the match's start here.
        expect(board(full.message)).toEqual(board(run.reference[0]!.message));
      } else {
        // No earlier than the spectator had seen, no later than the delay allows.
        expect(full.message.tick).toBeGreaterThanOrEqual(lastSeen);
        expect(full.message.tick).toBeLessThanOrEqual(before.matchTick - delayTicks);
        // The delay is kept exactly: playback stands delayTicks behind the match, as it did before the save.
        expect(full.message.tick).toBe(before.matchTick - delayTicks);
        expect(lastSeen).toBe(before.matchTick - delayTicks);
        expect(board(full.message)).toEqual(board(leg.referenceFull!.message));
      }
    }
    // Then a delta for every tick, each byte-identical to the uninterrupted stream's.
    rest.forEach((frame, j) => {
      expect(frame.message.full).toBeNull();
      expect(frame.message.tick).toBe(full!.message.tick + j + 1);
      expect(frame.text).toBe(deltas.get(frame.message.tick));
    });
    // A saved stream releases nothing more on the old server; its spectator hears only heartbeats.
    if (i < run.legs.length - 1) {
      expect(leg.afterSave.length).toBeGreaterThan(0);
      expect(leg.afterSave.every(text => text === HEARTBEAT)).toBe(true);
    }
  });
  return run.legs.at(-1)!.frames;
}

describe("a spectator reconnecting at the same lobby path after a handover", () => {
  it("gets the same rated match from where it was, 300 s behind the match, then deltas to its result, across three handovers, the first before playback began", { timeout: 120_000 }, async () => {
    const delayTicks = 300 * DEFAULT_CONFIG.ticksPerSecond;
    const run = await handOver({ lobbyId: LOBBY, visibility: "public", rated: true, mode: "1v1" }, delayTicks + 1_400, [1_000, delayTicks + 300, delayTicks + 800]);
    expect(run.legs).toHaveLength(4);
    expect(run.legs[0]!.frames).toEqual([]);
    const final = expectResumedStream(run, delayTicks);
    const end = final.at(-1)!.message.events.find(e => e.kind === "end");
    expect(end).toEqual(run.reference.at(-1)!.message.events.find(e => e.kind === "end"));
    expect(end).toMatchObject({ kind: "end", result: { reason: "time_up" } });
  });
});

describe("delays across a handover", () => {
  it.each([
    { name: "an unrated match keeps its 60 s delay", access: { lobbyId: LOBBY, visibility: "public", rated: false } as const, seconds: 60 },
    { name: "a house match keeps its 0 s delay although it is rated", access: { lobbyId: LOBBY, visibility: "public", rated: true, mode: "house-1v1" } as const, seconds: 0 },
  ])("$name", { timeout: 120_000 }, async ({ access, seconds }) => {
    const delayTicks = seconds * DEFAULT_CONFIG.ticksPerSecond;
    const run = await handOver(access, delayTicks + 1_400, [delayTicks + 300, delayTicks + 800]);
    expect(run.legs).toHaveLength(3);
    const final = expectResumedStream(run, delayTicks);
    expect(final.at(-1)!.message.events.some(e => e.kind === "end")).toBe(true);
  });
});

describe("restoring a save", () => {
  it("refuses a save of another tick than the match it would resume", async () => {
    const clock = new ManualClock();
    const config = playable({ ...DEFAULT_CONFIG, matchTicks: 200 });
    const script: ScriptOptions = { seed: 6006, config, agents: 2, ticks: 200, attack: false };
    let state = createMatch(script.seed, config);
    const old = await serve(clock), next = await serve(clock);
    old.hub.startMatch(1, state, { lobbyId: LOBBY, visibility: "public", rated: false });
    for (let i = 0; i < 50; i++) { const out = step(state, scriptedInputs(state, script)); old.hub.pushTick(1, out); clock.advance(TICK_MS); state = out.state; }
    const save = await old.hub.saveMatch(1);
    expect(() => old.hub.pushTick(1, step(state, []))).toThrow(/saved for a handover/);
    await expect(next.hub.resumeMatch(1, step(state, []).state, save)).rejects.toThrow(/saved at tick 50/);
    expect(next.hub.hasLobby(LOBBY)).toBe(false);
    await next.hub.resumeMatch(1, state, save);
    expect(next.hub.hasLobby(LOBBY)).toBe(true);
  });
});

/** Firestore's storage size of a UTF-8 string: its bytes plus one. */
const stringSize = (text: string) => Buffer.byteLength(text, "utf8") + 1;
const FIRESTORE = { document: 1_048_576, fieldValue: 1_048_487, request: 10 * 1024 * 1024 };

/** The Wide Plain board at 1,024 ants a side, both agents seated. */
function widePlain(): SimState {
  const base = newMatchConfig(rulesConfig("redesign"));
  const config = newMatchConfig({ ...base, startAnts: 1_024, startAntLayout: "fill-start-area", terrain: { ...base.terrain!, mapId: WIDE_PLAIN.id } });
  return step(createMatch(7, config), [{ type: "join", agentId: "agent-a", placement: 0 }, { type: "join", agentId: "agent-b", placement: 1 }]).state;
}

/**
 * The next tick with every ant moved and none dying, without running the sim: 300 s of held ticks at
 * this size take the sim minutes to step, and what the stream holds per tick is each ant's position,
 * heading and bits. One ant in four stands still from tick 100 on, so its heading is carried, not read.
 */
function moved(state: SimState, rng: ReturnType<typeof createRng>): StepOutput {
  const w = state.config.mapWidth * 1000, h = state.config.mapHeight * 1000;
  const ants = state.ants.map(ant => {
    const still = ant.id % 4 === 0 && state.tick >= 100;
    const vx = still ? 0 : Math.round((rng.next() - 0.5) * 400), vy = still ? 0 : Math.round((rng.next() - 0.5) * 400);
    return { ...ant, vx, vy, x: Math.min(w - 1, Math.max(0, ant.x + vx)), y: Math.min(h - 1, Math.max(0, ant.y + vy)) };
  });
  return { state: { ...state, tick: state.tick + 1, ants }, events: [], results: [] };
}

describe("the stream state of a rated Wide Plain match at 1,024 ants a side under the 300 s delay", () => {
  it("is saved and restored, with its meta within SPECTATOR_SAVE_META_BYTES and Firestore's limits", { timeout: 600_000 }, async () => {
    const clock = new ManualClock();
    const access: MatchAccess = { lobbyId: LOBBY, visibility: "public", rated: true, mode: "1v1" };
    let state = widePlain();
    expect(state.terrain?.mapId).toBe("wide-plain");
    expect([0, 1].map(colony => state.ants.filter(ant => ant.colony === colony).length)).toEqual([1024, 1024]);
    const rng = createRng(735);
    const reference = await serve(clock), first = await serve(clock);
    reference.hub.startMatch(1, state, access);
    first.hub.startMatch(1, state, access);
    const delayTicks = 300 * state.config.ticksPerSecond;
    for (let i = 0; i < delayTicks + 100; i++) {
      const out = moved(state, rng);
      reference.hub.pushTick(1, out);
      first.hub.pushTick(1, out);
      clock.advance(TICK_MS);
      state = out.state;
    }
    const before = await watch(first);
    await delivered(before.client, before.response);
    const identity = frames(before.response)[0]!.message.full!.match;
    before.client.close();

    let t = performance.now();
    const save = await first.hub.saveMatch(1);
    const saveMs = performance.now() - t;
    await first.retire();

    // Only the meta reaches Firestore; the parts go to the bucket.
    const meta = JSON.stringify(save.meta);
    const metaBytes = Buffer.byteLength(meta, "utf8");
    expect(metaBytes).toBeLessThanOrEqual(SPECTATOR_SAVE_META_BYTES);
    expect(stringSize(meta)).toBeLessThanOrEqual(FIRESTORE.fieldValue);
    // Even alone in a document of its own, with its write request.
    const document = stringSize("namespaces") + stringSize("antwar") + stringSize("matchSaves") + stringSize(LOBBY) + 16 + stringSize("spectator") + stringSize(meta) + 32;
    expect(document).toBeLessThanOrEqual(FIRESTORE.document);
    const request = JSON.stringify({ writes: [{ update: { name: `projects/p/databases/(default)/documents/namespaces/antwar/matchSaves/${LOBBY}`, fields: { spectator: { stringValue: meta } } }, currentDocument: { exists: false } }] });
    expect(Buffer.byteLength(request, "utf8")).toBeLessThanOrEqual(FIRESTORE.request);
    for (const name of save.parts.keys()) expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    const partBytes = [...save.parts.values()].reduce((n, part) => n + part.byteLength, 0);

    clock.advance(PAUSE_MS);
    const next = await serve(clock);
    t = performance.now();
    await next.hub.resumeMatch(2, state, save);
    const resumeMs = performance.now() - t;
    const resumed = await watch(next), uninterrupted = await watch(reference);
    for (let i = 0; i < 50; i++) {
      const out = moved(state, rng);
      reference.hub.pushTick(1, out);
      next.hub.pushTick(2, out);
      clock.advance(TICK_MS);
      state = out.state;
    }
    await delivered(resumed.client, resumed.response);
    await delivered(uninterrupted.client, uninterrupted.response);
    const got = frames(resumed.response), want = frames(uninterrupted.response);
    expect(got).toHaveLength(51);
    expect(got[0]!.message.full!.match).toBe(identity);
    expect(got[0]!.message.tick).toBe(state.tick - 50 - delayTicks);
    expect(board(got[0]!.message)).toEqual(board(want[0]!.message));
    expect(got.slice(1).map(f => f.text)).toEqual(want.slice(1).map(f => f.text));
    console.log(`Wide Plain 1,024 a side, ${delayTicks} held ticks: meta ${metaBytes} bytes, parts ${partBytes} bytes, save ${Math.round(saveMs)} ms, resume ${Math.round(resumeMs)} ms`);
  });
});
