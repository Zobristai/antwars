/**
 * A match handed over once, or twice,
 * finishes with one replay id, and its readable record verifies complete against the log from tick 0 to the result,
 * carrying the committed rating changes; a Wide Plain match's recording state at 1,024 ants a side under the 300 s
 * delay is saved and restored, its meta within SPECTATOR_SAVE_META_BYTES and Firestore's limits.
 *
 * Each match plays on real LiveHubs: the serving hub saves it (LiveHub.saveMatch, which carries the recording's part) and
 * a new hub resumes it (LiveHub.resumeMatch), the save crossing servers as a handover's does, with the watch metadata
 * through WatchController.save and resume.
 * Ratings are committed by the lobby's own rating transaction on the emulator and read through the resumed watch
 * controller's resultRatings.
 */
import { randomUUID } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { SPECTATOR_SAVE_META_BYTES } from "../../src/live/handover.ts";
import { LiveHub, type HubSave } from "../../src/live/hub.ts";
import type { MatchAccess } from "../../src/live/match-access.ts";
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createRecordHandoff, type RecordHandoff } from "../../src/records/handoff.ts";
import type { InputStore } from "../../src/records/input-store.ts";
import { decodeInput, type RecordInput } from "../../src/records/inputs.ts";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { createRecordService } from "../../src/records/service.ts";
import { matchRecord, type MatchRecord } from "../../src/replays/history.ts";
import { RECORDING_PARTS, recordingPart, ReplayRecording, replayId } from "../../src/replays/recording.ts";
import { ReplayCreateError, type ReplayStore } from "../../src/replays/store.ts";
import type { LiveGame } from "../../src/server.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { tileCentre } from "../../src/sim/geometry.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { tickLine } from "../../src/sim/log.ts";
import { createMatch, mirrorX, newAnt } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { isBlockedTile } from "../../src/sim/terrain.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { createFirestore, type Store, type Write } from "../../src/store/firestore.ts";
import { playable } from "../playable.ts";
import { ManualClock } from "./helpers.ts";
import { createOnlyRecords } from "../records/create-only-records.js";

// Runs inside `firebase emulators:exec --only firestore`, which sets FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const CODE = "a".repeat(40);
const RUN = "run-p";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); });

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** Create-only replay and record-input objects, and the handoff writing inputs to them. */
function storage() {
  const published = new Map<string, Uint8Array>(), inputs = new Map<string, Uint8Array>();
  const createOnly = (objects: Map<string, Uint8Array>): ReplayStore => ({ async create(object) {
    if (objects.has(object.name)) throw new ReplayCreateError(412);
    objects.set(object.name, object.body);
  } });
  const replayStore = createOnly(published);
  const handoff: RecordHandoff = createRecordHandoff({ codeVersion: CODE, store: createOnly(inputs) });
  return { published, inputs, replayStore, handoff };
}
type Storage = ReturnType<typeof storage>;

/** A save as it crosses servers: meta through JSON (Firestore holds it as text), parts as copies (object storage). */
function carried<M>(saved: { readonly meta: M; readonly parts: ReadonlyMap<string, Uint8Array> }): { meta: M; parts: Map<string, Uint8Array> } {
  return { meta: JSON.parse(JSON.stringify(saved.meta)) as M, parts: new Map([...saved.parts].map(([name, bytes]) => [name, bytes.slice()])) };
}

function frames(body: Uint8Array): Buffer { return gunzipSync(body); }

/** The names of a held copy's first count parts. */
function partNames(copy: "released" | "checkpoint", count: number): string[] {
  return Array.from({ length: count }, (_, i) => recordingPart(copy, i));
}

/** A held copy's bytes: its parts in order, joined. */
function savedCopy(parts: ReadonlyMap<string, Uint8Array>, copy: "released" | "checkpoint"): Buffer {
  const held: Uint8Array[] = [];
  for (let i = 0; parts.has(recordingPart(copy, i)); i++) held.push(parts.get(recordingPart(copy, i))!);
  return Buffer.concat(held);
}

/** A copy's frames as a reader decodes them, each full frame's match identity set aside: every hub draws its own. */
function decodedFrames(body: Uint8Array): StreamMessage[] {
  return unpackMessages(frames(body)).map(decodeMessage).map(message => message.full === null ? message : { ...message, full: { ...message.full, match: undefined } });
}

/** Whole gzip members in body, as Node writes them (10-byte header, 8-byte trailer): readers that stop after one need one. */
function gzipMembers(body: Uint8Array): number {
  let count = 0;
  for (let at = 0; at < body.length; count++) {
    const { engine } = inflateRawSync(body.subarray(at + 10), { info: true }) as unknown as { engine: { bytesWritten: number } };
    at += 10 + engine.bytesWritten + 8;
  }
  return count;
}

async function savedInput(target: Storage): Promise<RecordInput> {
  await vi.waitFor(() => expect(target.inputs.size).toBe(1));
  return decodeInput([...target.inputs.values()][0]!);
}

/** The record service's own sweep over these objects: the readable record it publishes. */
async function readableRecord(target: Storage, id: string, now: number): Promise<MatchRecord> {
  const inputs: InputStore = { list: async () => [...target.inputs.keys()], get: async name => target.inputs.get(name) ?? null,
    createMarker: async () => true, markerReason: async () => null, delete: async name => { target.inputs.delete(name); } };
  const logs: string[] = [];
  await createRecordService({ inputs, records: createOnlyRecords(target.replayStore), codeVersion: CODE, now: () => now, log: line => logs.push(line),
    replays: createRecordReplayStore({ publicStore: target.replayStore, readPublic: async replay => target.published.get(`${replay}.bin`) ?? null }) }).sweep();
  expect(logs).toEqual([]);
  return JSON.parse(new TextDecoder().decode(target.published.get(`${id}.json`)!)) as MatchRecord;
}

function emulatorStore(request?: typeof fetch): Store {
  return createFirestore({ projectId, namespace: `t${process.pid}-${randomUUID()}`, emulatorHost: host, request });
}

describe("a recording across a handover", () => {
  it("is inert on the server that saved it: nothing more is recorded, uploaded or handed off there", async () => {
    const target = storage();
    const recording = new ReplayRecording(0, 1, target.replayStore, undefined, { handoff: target.handoff, logHeader: "{}" });
    expect((await recording.save()).meta).toMatchObject({ id: replayId(0, 1), released: 1, checkpoint: 1, log: true });
    recording.appendLog("{}");
    recording.ended(1, { publishAfter: 2, rated: false });
    expect(await recording.finish()).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect([target.published.size, target.inputs.size]).toEqual([0, 0]);
  });

  it("refuses to resume from a malformed save or one missing a held part", () => {
    const meta = { id: replayId(0, 1), endedAt: null, checkpointed: false, captureFailed: false, released: 1, checkpoint: 0, log: false };
    const resume = (saved: unknown) => () => new ReplayRecording(0, 2, storage().replayStore, undefined, { resume: { meta: saved, parts: new Map() } });
    expect(resume(meta)).toThrow(`no ${recordingPart("released", 0)} part`);
    expect(resume({ ...meta, id: "../elsewhere" })).toThrow("invalid recording save");
    expect(resume({ ...meta, log: "yes" })).toThrow("invalid recording save");
  });

  it("leaves a match whose replay had already failed before the handover without a replay, as without one", async () => {
    const target = storage(), errors: string[] = [];
    const recording = new ReplayRecording(0, 1, target.replayStore, line => errors.push(line), { handoff: target.handoff, logHeader: "{}" });
    // An undecodable public full message: today's encoding-failure path, which drops the replay.
    recording.append(Uint8Array.of(0, 0, 0, 1));
    expect(errors).toEqual([expect.stringContaining("replay upload failed")]);
    const saved = await recording.save();
    expect(saved).toEqual({ meta: expect.objectContaining({ released: 0, checkpoint: 0, log: false }), parts: new Map() });
    const resumed = new ReplayRecording(5, 2, target.replayStore, undefined, { handoff: target.handoff, resume: carried(saved) });
    expect(await resumed.finish()).toBe(false);
    expect([target.published.size, target.inputs.size]).toEqual([0, 0]);
  });
});

describe.skipIf(!host)("a handed-over match's replay covers the whole match", { timeout: 300_000 }, () => {
  /** A rated public 1v1 lobby holding public-0, begun by RUN, between two claimed identities. */
  async function ratedLobby() {
    const store = emulatorStore();
    const identities = createIdentities(store), ratings = createRatings(store), lobbies = createLobbies(store, identities);
    const agents = await Promise.all(["Ada", "Bea"].map(async name => value(await identities.claimUsername(name)).identity));
    const lobbyId = randomUUID(), at = String(Date.now());
    const lobby: Write = { op: "create", path: `lobbies/${lobbyId}`, fields: {
      kind: "public", size: "1", creatorId: agents[0]!.id, createdAt: at, state: "holding", rated: "true", slot: "public-0",
      seats: JSON.stringify(agents.map((agent, colony) => ({ id: agent.id, displayName: agent.displayName, colony }))),
      inviteVerifier: "", startsAt: at, matchRunId: RUN, outcome: "", mode: "1v1" } };
    await store.transaction<null>(async () => ({ result: null, writes: [lobby, { op: "create", path: "slots/public-0", fields: { lobbyId } }] }));
    await lobbies.registerInstance("public-0", { runId: RUN, mcpUrl: "http://p.test/mcp", spectatorUrl: "http://p.test/" });
    return { store, ratings, lobbies, agents, lobbyId };
  }

  /**
   * One rated match past the 300 s delay, handed over before each tick in `handovers` as a server hands it over: the
   * serving watch controller and hub save it (WatchController.save, LiveHub.saveMatch) and close, the save crosses
   * servers, and a new server's controller and hub resume it under another sequence number (WatchController.resume,
   * LiveHub.resumeMatch). It ends on the last server, its rating committed by the lobby's ending.
   */
  async function handedOverMatch(handovers: readonly number[]) {
    const { store, ratings, lobbies, agents, lobbyId } = await ratedLobby();
    const accounts = { ratings, lobbies } as unknown as AccountStores;
    // Every server shares the replay and record-input buckets, and wall-clock time.
    const target = storage(), clock = new ManualClock();
    const server = () => {
      const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
      const hub = new LiveHub({ clock, replayStore: target.replayStore, recordHandoff: target.handoff, captureMatchLogs: true, ...controller.hubOptions });
      cleanup.push(() => { hub.close(); controller.close(); });
      return { controller, hub };
    };
    const seats = agents.map((agent, colony) => ({ identityId: agent.id, displayName: agent.displayName, colony: colony as 0 | 1, seat: 1 }));
    const live = { agentInfo: (agentId: string) => {
      const seat = seats[Number(agentId.slice(-1))]!;
      return { displayName: seat.displayName, modelLabel: null, seatKey: seat.identityId };
    } } as unknown as LiveGame;
    // One tick a second, so the 300 s delay is 300 ticks; the match runs 60 s past it, so released frames exist before every handover.
    let state = createMatch(736, playable({ ...rulesConfig("redesign"), ticksPerSecond: 1, matchTicks: 360 }));
    let { controller, hub } = server(), seq = 1;
    await controller.prepare(lobbyId, seats);
    controller.started(seq, state, live, hub);
    const saves: HubSave[] = [];
    while (state.result === null) {
      if (handovers.includes(state.tick)) {
        const watch = JSON.stringify(controller.save(lobbyId));
        const save = await hub.saveMatch(seq);
        saves.push(save);
        hub.close();
        controller.close();
        // Another server: its own sequence number, which must not change the replay id.
        ({ controller, hub } = server());
        seq += 6;
        const { identity } = await controller.resume(JSON.parse(watch), live);
        await hub.resumeMatch(seq, state, carried(save), identity);
      }
      const inputs: SimInput[] = state.tick === 0 ? seats.map(seat => ({ type: "join", agentId: `agent-${seat.colony}`, placement: seat.colony })) : [];
      hub.appendLog(seq, tickLine(state.tick, inputs, false, true));
      const out = step(state, inputs, undefined, undefined, undefined, false, true);
      clock.advance(1_000); hub.pushTick(seq, out); state = out.state;
    }
    const winner = state.result.winner;
    value(await lobbies.endMatch(lobbyId, RUN, winner === null ? "draw" : winner === 0 ? "colony_0_won" : "colony_1_won"));
    clock.advance(301_000);
    await vi.waitFor(() => expect(target.published.size).toBe(1), { timeout: 30_000 });
    const changes = (await ratings.readMatchChanges(lobbyId))!;
    const committed = seats.map((seat, agent) => {
      const row = changes.find(change => change.identityId === seat.identityId)!;
      return { agent, before: row.before, after: row.after };
    });
    return { target, saves, committed, ticks: state.tick, now: clock.now() };
  }

  it.each([[[320]], [[320, 340]]])("handed over before ticks %j: one replay id, a complete record from tick 0 with the committed ratings", async handovers => {
    const { target, saves, committed, ticks, now } = await handedOverMatch(handovers);
    expect(ticks).toBeGreaterThan(340);

    // One replay and one record input were stored, under one id: the id every save carried.
    expect(target.published.size).toBe(1);
    const id = [...target.published.keys()][0]!.replace(/\.bin$/, "");
    expect([...target.published.keys()]).toEqual([`${id}.bin`]);
    const input = await savedInput(target);
    expect([...target.inputs.keys()]).toEqual([`${id}.input`]);
    expect(saves.map(save => (save.meta.recording as { id: string }).id)).toEqual(handovers.map(() => id));
    // Each save held the recording so far, released frames included (the first was released at tick 300).
    // Each copy's parts are the pieces each server held it in: one per server so far at this size; the log and the call
    // reply lines are one part each.
    for (const [index, save] of saves.entries()) expect([...save.parts.keys()].filter(name => name.startsWith("recording-")).sort())
      .toEqual([...partNames("checkpoint", index + 1), RECORDING_PARTS.log, RECORDING_PARTS.replies, ...partNames("released", index + 1)].sort());
    expect(unpackMessages(frames(savedCopy(saves[0]!.parts, "released"))).length).toBeGreaterThan(0);

    // The whole match, every tick once and in order, in the released replay, the private checkpoint and the log,
    // each copy one gzip member however many servers recorded it.
    const everyTick = Array.from({ length: ticks + 1 }, (_, tick) => tick);
    const replay = target.published.get(`${id}.bin`)!;
    expect(unpackMessages(frames(replay)).map(decodeMessage).map(frame => frame.tick)).toEqual(everyTick);
    expect(unpackMessages(frames(input.binary)).map(decodeMessage).map(frame => frame.tick)).toEqual(everyTick);
    expect([gzipMembers(replay), gzipMembers(input.binary)]).toEqual([1, 1]);
    expect(input.logLines.slice(1).map(line => (JSON.parse(line) as { tick: number }).tick)).toEqual(everyTick.slice(0, -1));

    // The record service verifies the published replay against the log from tick 0 to the result.
    const record = await readableRecord(target, id, now);
    expect(record).toMatchObject({ id, source: "match-log", status: "complete", result: { tick: ticks - 1, ratingChanges: committed } });
    expect(committed.every(change => change.after !== change.before)).toBe(true);
    // And the private checkpoint verifies the same way, should the replay be lost.
    expect(matchRecord({ id, binary: input.binary, logLines: input.logLines, endedAt: input.endedAt })).toMatchObject({ status: "complete" });
  });

  it("saves and restores a Wide Plain recording at 1,024 ants a side under the 300 s delay within Firestore's limits", async () => {
    const access: MatchAccess = { lobbyId: randomUUID(), visibility: "public", rated: true, mode: "1v1" };
    // An uninterrupted reference hub is fed the same ticks.
    const target = storage(), reference = storage(), clock = new ManualClock();
    const serve = (into = target) => {
      const hub = new LiveHub({ clock, replayStore: into.replayStore, recordHandoff: into.handoff, captureMatchLogs: true });
      cleanup.push(() => hub.close());
      return hub;
    };
    const referenceHub = serve(reference);
    let state = widePlain(42);
    expect(state.config).toMatchObject({ colonyCap: 1_024, matchTicks: 36_000 });
    expect([0, 1].map(colony => state.ants.filter(ant => ant.colony === colony).length)).toEqual([1_024, 1_024]);
    const requests: number[] = [];
    const store = emulatorStore(async (url, init) => { requests.push(Buffer.byteLength(String(init?.body ?? ""))); return fetch(url, init); });
    const path = `matchSaves/${access.lobbyId}`;
    let meta = "", parts = new Map<string, Uint8Array>();
    let hub = serve();
    for (const each of [referenceHub, hub]) each.startMatch(1, state, access);
    // The server stops it at tick 60, so its recording finishes without playing 36,000 ticks.
    while (state.result === null) {
      if (state.tick === 40) {
        // Saved after tick 40 of 60: everything held, nothing yet released under the 300 s delay.
        const save = await hub.saveMatch(1);
        // The spectator meta, the only part of the save that reaches Firestore, as one string field.
        meta = JSON.stringify(save.meta);
        parts = save.parts;
        await store.transaction<null>(async () => ({ result: null, writes: [{ op: "create", path, fields: { spectator: meta } }] }));
        const read = (await store.get(path))!;
        hub.close();
        hub = serve();
        await hub.resumeMatch(1, state, { meta: JSON.parse(read.spectator!) as HubSave["meta"], parts: carried(save).parts });
      }
      const inputs: SimInput[] = state.tick === 0 ? [0, 1].map(colony => ({ type: "join", agentId: `agent-${colony}`, placement: colony as 0 | 1 })) : [];
      const stop = state.tick === 59;
      for (const each of [referenceHub, hub]) each.appendLog(1, tickLine(state.tick, inputs, stop, true));
      const out = step(state, inputs, undefined, undefined, undefined, stop, true);
      clock.advance(100);
      for (const each of [referenceHub, hub]) each.pushTick(1, out);
      state = out.state;
    }
    clock.advance(301_000);
    await vi.waitFor(() => expect([reference.published.size, target.published.size]).toEqual([1, 1]), { timeout: 30_000 });
    const id = [...target.published.keys()][0]!.replace(/\.bin$/, "");
    const input = await savedInput(target);

    // The recording's parts held every frame captured so far, at 2,048 ants, the log lines and the call reply lines; none was released yet.
    expect([...parts.keys()].filter(name => name.startsWith("recording-")).sort())
      .toEqual([recordingPart("checkpoint", 0), RECORDING_PARTS.log, RECORDING_PARTS.replies, recordingPart("released", 0)].sort());
    const checkpoint = unpackMessages(frames(savedCopy(parts, "checkpoint"))).map(decodeMessage);
    expect(checkpoint.map(frame => frame.tick)).toEqual(Array.from({ length: 41 }, (_, tick) => tick));
    expect(checkpoint.every(frame => frame.ants.count === 2_048)).toBe(true);
    expect(frames(savedCopy(parts, "released")).length).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(parts.get(RECORDING_PARTS.log)!))).toEqual(input.logLines.slice(0, 41));
    // Firestore storage-size rules: strings are UTF-8 bytes + 1; a name adds 16, a document 32.
    const metaBytes = Buffer.byteLength(meta);
    expect(metaBytes).toBeLessThanOrEqual(SPECTATOR_SAVE_META_BYTES);
    const nameBytes = ["namespaces", store.namespace, "matchSaves", access.lobbyId].reduce((sum, segment) => sum + Buffer.byteLength(segment) + 1, 0) + 16;
    expect(metaBytes + 1).toBeLessThanOrEqual(1_048_487);
    expect(nameBytes + Buffer.byteLength("spectator") + 1 + metaBytes + 1 + 32).toBeLessThanOrEqual(1_048_576);
    expect(requests.length).toBeGreaterThan(0);
    expect(Math.max(...requests)).toBeLessThanOrEqual(10 * 1_048_576);

    // Resumed from what Firestore and the copied parts returned, the recording finishes the whole match under the one id.
    expect([...target.published.keys()]).toEqual([`${id}.bin`]);
    expect((JSON.parse(meta) as { recording: { id: string } }).recording.id).toBe(id);
    const everyTick = Array.from({ length: 61 }, (_, tick) => tick);
    expect(unpackMessages(frames(target.published.get(`${id}.bin`)!)).map(decodeMessage).map(frame => frame.tick)).toEqual(everyTick);
    expect(unpackMessages(frames(input.binary)).map(decodeMessage).map(frame => frame.tick)).toEqual(everyTick);
    expect(input.logLines.slice(1).map(line => (JSON.parse(line) as { tick: number }).tick)).toEqual(everyTick.slice(0, -1));
    // And as the uninterrupted hub recorded it: released replay, private checkpoint and log.
    const before = await savedInput(reference), referenceId = [...reference.published.keys()][0]!.replace(/\.bin$/, "");
    expect(decodedFrames(target.published.get(`${id}.bin`)!)).toEqual(decodedFrames(reference.published.get(`${referenceId}.bin`)!));
    expect(decodedFrames(input.binary)).toEqual(decodedFrames(before.binary));
    expect(input.logLines).toEqual(before.logLines);
  });
});

/** Wide Plain as a match draws it (1,024-ant cap, 36,000 ticks), each colony filled to its cap as the rated harness fills it (test/tuning/seated.ts). */
function widePlain(seed: number): SimState {
  const base = newMatchConfig(rulesConfig("redesign"));
  const state = createMatch(seed, { ...base, startAnts: 0, terrain: { ...base.terrain!, mapId: "wide-plain" } });
  const c = state.config, perSide = c.colonyCap;
  const band = Math.floor(c.mapWidth * 0.4), cols = Math.round(Math.sqrt((perSide * band) / c.mapHeight)), rows = Math.ceil(perSide / cols);
  const taken = new Set<number>();
  const land = (x: number, y: number) => {
    for (let r = 0; r < c.mapWidth; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || tx >= band || ty < 0 || ty >= c.mapHeight || taken.has(ty * c.mapWidth + tx)) continue;
      if (isBlockedTile(state.terrain, tx, ty) || isBlockedTile(state.terrain, c.mapWidth - 1 - tx, ty)) continue;
      return { x: tx, y: ty };
    }
    throw new Error("no land");
  };
  for (let i = 0; i < perSide; i++) {
    const t = land(Math.floor(((i % cols) + 0.5) * band / cols), Math.floor((Math.floor(i / cols) + 0.5) * c.mapHeight / rows));
    taken.add(t.y * c.mapWidth + t.x);
    const x = tileCentre(t.x), y = tileCentre(t.y), caste = i % 2 === 0 ? "worker" : "soldier";
    state.ants.push(newAnt(c, state.nextAntId++, 0, x, y, caste));
    state.ants.push(newAnt(c, state.nextAntId++, 1, mirrorX(c, x), y, caste));
  }
  return state;
}
