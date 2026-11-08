import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, encodePublicMessage, GRID_SCALE_STREAM_VERSION, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState, territoryWinOf } from "../../src/live/model.ts";
import { Game, observeInfo } from "../../src/mcp/game.ts";
import { pagedView } from "../../src/mcp/replies.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { buildGrid, cloneState } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { takeView } from "../../src/sim/view.ts";
import { emptyMatch } from "../sim/fixtures.ts";

import { playable } from "../playable.ts";
function scenario(holdTicks = 4) {
  const base = rulesConfig("redesign");
  // Pin the landed water/countdown composition; rocks.test.ts covers its new extension.
  const config = { ...base, terrain: { ...base.terrain!, rocks: undefined }, hatchIntervalTicks: 100_000, groundFoodIntervalTicks: 0,
    earlyWin: { minTick: 10, holdTicks, territoryRatioPermille: 3000, minHeldTiles: 30 } };
  const state = emptyMatch(9, config);
  // Four fine tiles hold one physical tile at grid scale 2: 30 physical tiles against 10.
  state.owner.fill(-1); state.owner.fill(0, 0, 120); state.owner.fill(1, 120, 160);
  state.lastVisit.fill(state.tick);
  return state;
}

const fullOf = (recorder: SpectatorRecorder, tick: number): StreamMessage => ({ ...recorder.initial(), tick, full: recorder.initialFull() });

it("streams the evaluator's exact start and winning simulation ticks, not a second rule evaluation", () => {
  let state = scenario();
  const recorder = new SpectatorRecorder(state);
  const model = new SpectatorState(recorder.initialFull(), state.tick, recorder.initial().ants);
  expect(model.full.territoryWin).toBeUndefined();
  for (let completed = 10; completed <= 14; completed++) {
    const out = step(state);
    const before = JSON.stringify(out.state);
    const record = recorder.record(out);
    model.apply(decodeMessage(encodePublicMessage({ ...record, full: null })));
    expect(JSON.stringify(out.state)).toBe(before);
    state = out.state;
    if (completed === 10 || completed === 14) expect(model.full.territoryWin).toBeUndefined();
    else expect(model.full.territoryWin).toEqual({ colony: 0, startTick: 10, winTick: 13 });
    if (completed === 11) expect(record.events.filter(e => e.kind === "territoryWin")).toHaveLength(1);
    if (completed === 12 || completed === 13) expect(record.events.some(e => e.kind === "territoryWin")).toBe(false);
  }
  expect(state.result).toMatchObject({ reason: "sustained_territory", tick: 13 });
  expect(model.full.result?.tick).toBe(13);
});

it("resets and changes the leader from the same server progress; reconnects mid-lead with no history", () => {
  let state = step(step(scenario(20)).state).state;
  const recorder = new SpectatorRecorder(state);
  const opening = decodeMessage(encodePublicMessage(fullOf(recorder, state.tick)));
  expect(opening.full!.territoryWin).toEqual({ colony: 0, startTick: 10, winTick: 29 });
  expect(opening.full!.setup).not.toHaveProperty("rules");
  expect(opening.full!.setup).not.toHaveProperty("seed");
  const model = new SpectatorState(opening.full!, opening.tick, opening.ants);
  state.owner.fill(-1); state.owner.fill(0, 0, 80); state.owner.fill(1, 80, 160);
  let out = step(state), record = recorder.record(out);
  expect(record.events).toContainEqual({ kind: "territoryWin", progress: null });
  model.apply(record); expect(model.full).not.toHaveProperty("territoryWin");
  state = out.state;
  state.owner.fill(-1); state.owner.fill(1, 0, 120); state.owner.fill(0, 120, 160);
  out = step(state); record = recorder.record(out); model.apply(record);
  expect(model.full.territoryWin).toEqual({ colony: 1, startTick: 12, winTick: 31 });
  const reconnected = new SpectatorRecorder(out.state);
  expect(decodeMessage(encodePublicMessage(fullOf(reconnected, out.state.tick))).full!.territoryWin).toEqual(model.full.territoryWin);
});

it("clears a stale qualifying lead when a queen loss takes precedence", () => {
  const state = step(step(scenario()).state).state;
  const recorder = new SpectatorRecorder(state);
  state.colonies[0].queens![0]!.lostTick = state.tick - 1;
  const out = step(state);
  expect(out.state.result?.reason).toBe("queens_killed");
  expect(territoryWinOf(out.state)).toBeUndefined();
  expect(recorder.record(out).events).toContainEqual({ kind: "territoryWin", progress: null });
});

it.each([1, 7, 201])("uses configured hold duration %s and preserves public full/delta round trips", holdTicks => {
  let state = scenario(holdTicks);
  // Start with actual evaluated progress; a one-tick hold ends immediately and carries no live countdown.
  state = step(step(state).state).state;
  const recorder = new SpectatorRecorder(state), message = fullOf(recorder, state.tick);
  const bytes = encodePublicMessage(message), decoded = decodeMessage(bytes);
  expect(decoded.full!.territoryWin).toEqual(holdTicks === 1 ? undefined : { colony: 0, startTick: 10, winTick: 10 + holdTicks - 1 });
  if (holdTicks !== 1) {
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(encodePublicMessage(decoded)).toEqual(bytes);
    const delta: StreamMessage = { tick: state.tick + 1, ants: message.ants, full: null, events: [{ kind: "territoryWin", progress: null }] };
    expect(decodeMessage(encodeMessage(delta))).toEqual(delta);
  }
});

it("does not invent lead state without evaluated progress", () => {
  const state = scenario(); state.earlyWinProgress = { leader: null, ticks: 0 };
  const message = fullOf(new SpectatorRecorder(state), state.tick);
  expect(decodeMessage(encodePublicMessage(message)).full).not.toHaveProperty("territoryWin");
});

// The landed version-10 terrain packet and the version-4 recording no longer decode (their setups carry
// no grid scale); the countdown is composed with a grid-scale-2 setup instead.
it.each([false, true])("composes the countdown with optional terrain (%s) at grid scale 2", terrainPresent => {
  const message = fullOf(new SpectatorRecorder(scenario()), 9);
  if (!terrainPresent) delete message.full!.setup.terrain;
  else expect(message.full!.setup.terrain).toBeDefined();
  const setup = structuredClone(message.full!.setup);
  message.full!.territoryWin = { colony: 1, startTick: 120, winTick: 149 };
  const bytes = encodeMessage(message), decoded = decodeMessage(bytes);
  expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
  expect(decoded.full!.setup).toEqual(setup);
  expect(decoded.full!.territoryWin).toEqual(message.full!.territoryWin);
  expect(encodeMessage(decoded)).toEqual(bytes);
});

it("leaves the serialized MCP observe reply and simulation state byte-unchanged when producing spectator state", () => {
  const state = step(step(scenario()).state).state;
  state.agents.push({ id: "scripted-observer", colony: 0, joinSeq: 0, modelLabel: "fixture", parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, joinedTick: 0, idle: false, pendingEvents: [] });
  // Build the same ongoing-match reply as the MCP observe adapter, with independent clones because takeView consumes events.
  const observe = () => {
    const copy = cloneState(state), agent = copy.agents[0]!;
    return JSON.stringify(pagedView(new Game({ simConfig: playable(copy.config) }), copy.config,
      takeView(copy, buildGrid(copy), agent), true, { ...observeInfo(copy, agent.id, copy.config) }));
  };
  const before = observe(), stateBefore = JSON.stringify(state);
  const recorder = new SpectatorRecorder(state), message = decodeMessage(encodePublicMessage(fullOf(recorder, state.tick)));
  expect(message.full!.territoryWin).toBeDefined();
  const model = new SpectatorState(message.full!, message.tick, message.ants);
  const out = step(state); model.apply(recorder.record(out)); encodePublicMessage(model.message());
  expect(JSON.stringify(state)).toBe(stateBefore);
  expect(observe()).toBe(before);
  expect(before).not.toMatch(/territoryWin|startTick|winTick/);
});
