import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { decodeMessage, encodeMessage, encodePublicMessage, HOUSE_IDLE_STREAM_VERSION, IDLE_STREAM_VERSION, isIdle, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { RankedMode } from "../../src/rating/ratings.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";
import { ManualClock } from "./helpers.ts";

import { playable } from "../playable.ts";
const roundtrip = (message: StreamMessage) => decodeMessage(encodeMessage(message));
const seats = [{ identityId: "left", displayName: "Left", colony: 0 as const }, { identityId: "right", displayName: "Right", colony: 1 as const }];

async function fixture(mode: RankedMode | null = "house-1v1", houseIdleSeconds = 2) {
  const game = new Game({ simConfig: playable({ ...HISTORICAL_CONFIG, commandIdleTicks: 3, startAnts: 0, matchTicks: 5000 }),
    mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds },
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  game.seatLobby("00000000-0000-4000-8000-000000000436", seats, mode);
  for (const seat of seats) await game.joinSeated(seat.identityId);
  game.startMatch(436);
  const recorder = new SpectatorRecorder(game.match!.state, { rated: mode !== null, houseIdle: game.spectatorHouseIdle(game.match!.seq),
    modelIndex: mode?.startsWith("house-") === true });
  const opening = roundtrip({ ...recorder.initial(), full: recorder.initialFull() });
  const viewer = new SpectatorState(opening.full!, opening.tick, opening.ants);
  const messages = [encodePublicMessage(opening)];
  const tick = () => {
    const out = game.tick()!;
    const message = roundtrip({ ...recorder.record(out), full: null });
    messages.push(encodeMessage(message)); viewer.apply(message);
    return message;
  };
  tick();
  return { game, recorder, viewer, tick, messages };
}

const idle = (viewer: SpectatorState, index = 0) => isIdle(viewer.full.agents[index]!, viewer.tick, viewer.full.setup.idleTicks, viewer.full.setup.houseIdleTicks);

it("uses accepted observe-only house activity through delta and reconnect snapshots, with the exact server deadline", async () => {
  const { game, recorder, viewer, tick } = await fixture();
  expect(viewer.full.setup.houseIdleTicks).toBe(20);
  for (const time of [19, 38, 57]) {
    game.match!.state.tick = time;
    const calls = game.match!.state.agents.map(a => game.call(a.id, { type: "observe", agentId: a.id }));
    const delta = tick(); await Promise.all(calls);
    expect(encodeMessage(delta)[2]).toBe(HOUSE_IDLE_STREAM_VERSION);
    expect(viewer.full.agents[0]).toMatchObject({ lastCommandTick: -1, lastHouseCallTick: time });
    expect(game.match!.state.result).toBeNull();
    expect(idle(viewer)).toBe(false);
    const reconnected = roundtrip(viewer.message());
    expect(reconnected.full!.setup.houseIdleTicks).toBe(20);
    expect(reconnected.full!.agents).toEqual(viewer.full.agents);
  }
  // Reusing initialFull cannot leak later activity into the opening snapshot.
  expect(recorder.initialFull().agents).toEqual([]);
  game.match!.state.tick = 76; tick(); expect(idle(viewer)).toBe(false);
  tick(); expect(idle(viewer)).toBe(true);
  expect(game.match!.state.result).toMatchObject({ reason: "abandoned", tick: 77 });
  const reconnect = roundtrip(viewer.message());
  expect(reconnect.full!.setup.rated).toBe(false); // abandoned, but the house clock is retained
  expect(reconnect.full!.agents[0]!.lastHouseCallTick).toBe(57);
});

it("captures a populated opening clock before later accepted calls and isolates the next match", async () => {
  const { game, tick } = await fixture();
  game.match!.state.tick = 10;
  const calls = game.match!.state.agents.map(a => game.call(a.id, { type: "observe", agentId: a.id }));
  tick(); await Promise.all(calls);
  const houseIdle = game.spectatorHouseIdle(game.match!.seq)!;
  const recorder = new SpectatorRecorder(game.match!.state, { houseIdle });
  game.match!.state.tick = 15;
  const later = game.match!.state.agents.map(a => game.call(a.id, { type: "observe", agentId: a.id }));
  tick(); await Promise.all(later);
  expect(roundtrip({ ...recorder.initial(), full: recorder.initialFull() }).full!.agents[0]!.lastHouseCallTick).toBe(10);
  const id = game.match!.state.agents[0]!.id;
  game.tick(true); game.startMatch(437);
  expect(houseIdle.activityTick(id)).toBeUndefined();
});

it.each([0.25, 180, 245])("uses the configured %s-second limit independently of command-idle rules", async seconds => {
  const { game, viewer, tick } = await fixture("house-1v1", seconds);
  expect(viewer.full.setup.houseIdleTicks).toBe(seconds * 10);
  const deadline = Math.ceil(seconds * 10);
  game.match!.state.tick = deadline - 1; tick(); expect(idle(viewer)).toBe(false);
  tick(); expect(idle(viewer)).toBe(true);
  expect(game.match!.state.result).toMatchObject({ reason: "abandoned", tick: deadline });
});

it("does not mistake a refused command or synthetic error-observe for accepted house activity", async () => {
  const { game, viewer, tick } = await fixture();
  const [a, b] = game.match!.state.agents;
  const order = game.call(a!.id, { type: "order", agentId: a!.id, order: { kind: "hold" } });
  tick(); await order;
  game.match!.state.tick = 20;
  const calls = [game.call(a!.id, { type: "order", agentId: a!.id, order: { kind: "hold" } }),
    game.call(a!.id, { type: "observe", agentId: a!.id }, false),
    game.call(b!.id, { type: "observe", agentId: b!.id })];
  tick();
  expect(await calls[0]).toMatchObject({ kind: "error", code: "rate_limited" });
  await Promise.all(calls.slice(1));
  expect(viewer.full.agents[0]).toMatchObject({ lastCallTick: 20, lastHouseCallTick: 1 });
  expect(idle(viewer)).toBe(false);
  tick(); expect(idle(viewer)).toBe(true); expect(idle(viewer, 1)).toBe(false);
});

// Outside the Model Index the same accepted-call clock drives the label and ends the match as an idle loss or draw.
it.each(["1v1", null] as const)("%s carries the one idle clock outside the Model Index in additive v23 bytes", async mode => {
  const { game, recorder, viewer, tick, messages } = await fixture(mode, 0.1);
  expect(game.spectatorHouseIdle(game.match!.seq)).toMatchObject({ idleTicks: 1 });
  expect(viewer.full.setup.houseIdleTicks).toBe(1);
  expect(viewer.full.setup).not.toHaveProperty("modelIndex");
  expect(messages[0]![2]).toBe(IDLE_STREAM_VERSION);
  game.match!.state.tick = 3;
  const calls = game.match!.state.agents.map(a => game.call(a.id, { type: "observe", agentId: a.id }));
  tick(); await Promise.all(calls);
  expect(idle(viewer)).toBe(false);
  expect(viewer.full.agents[0]).toMatchObject({ lastHouseCallTick: 3 });
  const end = tick();
  expect(idle(viewer)).toBe(true);
  expect(game.match!.state.result).toMatchObject({ reason: "idle", winner: null, decidedBy: "draw", tick: 4 });
  expect(encodeMessage(end)[2]).toBe(IDLE_STREAM_VERSION);
  const reconnect = roundtrip(viewer.message());
  expect(reconnect.full!.setup).toMatchObject({ houseIdleTicks: 1 });
  expect(reconnect.full!.setup).not.toHaveProperty("modelIndex");
  expect(reconnect.full!.result).toMatchObject({ reason: "idle", winner: null });
  // A recorder without the clock keeps the pre-change encoding.
  const ordinary = new SpectatorRecorder(game.match!.state, { rated: mode !== null });
  const absent = new SpectatorRecorder(game.match!.state, { rated: mode !== null, houseIdle: undefined });
  expect(encodeMessage({ ...ordinary.initial(), full: ordinary.initialFull() }))
    .toEqual(encodeMessage({ ...absent.initial(), full: absent.initialFull() }));
  expect(encodeMessage({ ...ordinary.initial(), full: ordinary.initialFull() })[2]).not.toBe(IDLE_STREAM_VERSION);
  expect(recorder.setup.houseIdleTicks).toBe(1);
});

it("saved binary house recordings retain the server clock through replay redaction, gzip and reconnect", async () => {
  const { game, viewer, tick, messages } = await fixture("house-1v1", 2);
  game.match!.state.tick = 19;
  const calls = game.match!.state.agents.map(a => game.call(a.id, { type: "observe", agentId: a.id }));
  tick(); await Promise.all(calls);
  game.match!.state.tick = 38; tick(); expect(idle(viewer)).toBe(false);
  tick(); expect(idle(viewer)).toBe(true);
  let saved: Uint8Array | undefined;
  const recording = new ReplayRecording(0, 436, { create: async object => { saved = object.body; } });
  for (const bytes of messages) recording.append(bytes);
  expect(await recording.finish()).toBe(true);
  const decoded = unpackMessages(gunzipSync(saved!)).map(decodeMessage);
  const first = decoded[0]!, replay = new SpectatorState(first.full!, first.tick, first.ants);
  expect(first.full!.setup).not.toHaveProperty("rules");
  expect(first.full!.setup.houseIdleTicks).toBe(20);
  for (const message of decoded.slice(1, -1)) replay.apply(message);
  expect(idle(replay)).toBe(false);
  replay.apply(decoded.at(-1)!);
  expect(idle(replay)).toBe(true);
  expect(roundtrip(replay.message()).full!.agents).toEqual(viewer.full.agents);
});

it("wires the real Game activity through watch-controller and live hub without disclosing internal ids", async () => {
  const { game } = await fixture();
  const { store } = memoryWatchStore();
  const accounts = { ratings: { readRating: async () => ({ rating: 1000 }) }, lobbies: {
    readLobby: async () => ({ ok: true, value: { id: "00000000-0000-4000-8000-000000000436", kind: "public", rated: true, mode: "house-1v1", state: "holding", slot: "public-0" } }),
    resolveSlot: async () => ({ runId: "label-run" }), isInviteCurrent: async () => false,
  } } as unknown as AccountStores;
  const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
  const encoded: Uint8Array[] = [], clock = new ManualClock();
  const hub = new LiveHub({ ...controller.hubOptions, clock, replayStore: { create: async () => {} }, encode: message => { const bytes = encodeMessage(message); encoded.push(bytes); return bytes; } });
  try {
    await controller.prepare("00000000-0000-4000-8000-000000000436", seats);
    controller.started(game.match!.seq, game.match!.state, game, hub);
    game.match!.state.tick = 19;
    const calls = game.match!.state.agents.map(a => game.call(a.id, { type: "observe", agentId: a.id }));
    hub.pushTick(game.match!.seq, game.tick()!); await Promise.all(calls); clock.advance(100);
    const opening = encoded.map(decodeMessage).find(message => message.full)!;
    expect(opening.full!.setup.houseIdleTicks).toBe(20);
    expect(opening.full!.agents[0]!.lastHouseCallTick).toBe(0);
    expect(encoded.map(decodeMessage).some(message => message.events.some(event => event.kind === "call" && event.houseActivityTick === 19))).toBe(true);
    for (const bytes of encoded) for (const agent of game.match!.state.agents) expect(Buffer.from(bytes).includes(Buffer.from(agent.id))).toBe(false);
  } finally { hub.close(); controller.close(); }
});
