import { describe, expect, it } from "vitest";
import { PUBLIC_CONFIG, DEFAULT_CONFIG } from "../../src/sim/config.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { updateOverrun } from "../../src/sim/territory.js";
import type { SimEvent } from "../../src/sim/types.js";
import { decodeMessage, encodeMessage, streamQueens } from "../../src/live/format.js";
import { queensForStream, SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { playScripted, recordLog } from "../../src/live/record.js";
import { addAnt } from "../sim/fixtures.js";

import { playable } from "../playable.ts";
it("round-trips queen founding, per-nest progress, loss and late full snapshots", () => {
  const config = { ...PUBLIC_CONFIG, queenFounding: { ...PUBLIC_CONFIG.queenFounding!, firstFoundTick: 0 }, startAnts: 0, commandFloorTicks: 1, overrunTicks: 2, overrunGraceTicks: 0 };
  let state = createMatch(42, playable(config));
  state.owner[10 * state.config.mapWidth + 18] = 0; state.colonies[0].foodStore = config.queenFounding.cost + 40;
  state = step(state, [{ type: "join", agentId: "a" }]).state;
  const recorder = new SpectatorRecorder(state);
  const init = decodeMessage(encodeMessage({ tick: state.tick, ants: recorder.initial().ants, full: recorder.initialFull(), events: [] }));
  expect(init.full?.queens).toHaveLength(2);
  const spectator = new SpectatorState(init.full!, init.tick, init.ants);
  const out = step(state, [{ type: "found_queen", agentId: "a", tileX: 18, tileY: 10 }]);
  state = out.state;
  const rec = decodeMessage(encodeMessage({ ...recorder.record(out), full: null }));
  expect(rec.events).toContainEqual(expect.objectContaining({ kind: "call", call: "found_queen", accepted: true }));
  expect(rec.events).toContainEqual(expect.objectContaining({ kind: "queenFounded" }));
  spectator.apply(rec); expect(spectator.full.queens).toEqual(queensForStream(state));
  addAnt(state, 1, 18, 10);
  for (let i = 0; i < 2; i++) {
    const events: SimEvent[] = []; updateOverrun(state, buildGrid(state), state.tick, events); state.tick++;
    spectator.apply(decodeMessage(encodeMessage({ ...recorder.record({ state, events, results: [] }), full: null })));
  }
  expect(spectator.full.queens).toEqual(queensForStream(state));
  expect(spectator.full.queens?.find((q) => q.colony === 0 && q.id === 1)?.lostTick).not.toBeNull();
  const reconnect = decodeMessage(encodeMessage(spectator.message()));
  expect(reconnect.full?.queens).toEqual(queensForStream(state));
});

// Version-4 full snapshots no longer decode; the legacy derivation still serves a snapshot without queens.
it("keeps legacy queen derivation for a snapshot without queens", () => {
  const full = new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG))).initialFull();
  delete full.queens;
  expect(streamQueens(full)).toHaveLength(2);
});

it("sources version-5 full hatch totals from sim stats, maintains births and preserves reconnect totals", () => {
  const config = { ...PUBLIC_CONFIG, startAnts: 0 };
  let state = createMatch(42, playable(config));
  state.stats.hatched = [11, 9]; state.colonies[0].foodStore = config.hatchCost; state.colonies[1].foodStore = config.hatchCost;
  const recorder = new SpectatorRecorder(state);
  const full = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() })).full!;
  expect(full.hatched).toEqual([11, 9]);
  const spectator = new SpectatorState(full, 0, recorder.initial().ants);
  const out = step(state); state = out.state;
  spectator.apply(decodeMessage(encodeMessage({ ...recorder.record(out), full: null })));
  expect(spectator.full.hatched).toEqual(state.stats.hatched);
  expect(spectator.full.hatched).toEqual([12, 10]);
  expect(decodeMessage(encodeMessage(spectator.message())).full?.hatched).toEqual(state.stats.hatched);
  expect(decodeMessage(encodeMessage({ tick: state.tick, ants: spectator.ants, full: new SpectatorRecorder(state).initialFull(), events: [] })).full?.hatched).toEqual(state.stats.hatched);
});

it("reproduces cumulative hatch totals when a private recording is replayed from its log", () => {
  const config = { ...PUBLIC_CONFIG, matchTicks: 200, guardCount: 0, fighterShareStartPermille: 0, fighterShareEndPermille: 0,
    foodLayout: undefined, foodPatches: [{ tileX: 8, tileY: 24, radius: 4, perTile: 10 }] };
  const played = playScripted({ seed: 17, config: playable(config), ticks: 200, agents: 0 });
  const messages = recordLog(played.lines).map(decodeMessage);
  const first = messages[0]!, spectator = new SpectatorState(first.full!, first.tick, first.ants);
  for (const m of messages.slice(1)) spectator.apply(m);
  expect(played.state.stats.hatched[0]).toBeGreaterThan(0);
  expect(spectator.full.hatched).toEqual(played.state.stats.hatched);
});
