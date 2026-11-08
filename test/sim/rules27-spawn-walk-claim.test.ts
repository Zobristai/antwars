import { describe, expect, it } from "vitest";
import { rulesConfig, SUB } from "../../src/sim/config.js";
import { distance, tileCentre } from "../../src/sim/geometry.js";
import { activeQueens } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import type { Ant, Caste, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Count marks outrank the walk. The walker carries the spawnWalk
// that hatch gives a newborn while its queen has a spawn point; its twin is the
// same ant that never walked. Whatever the walk routing does, a claimed or
// released walker must plan exactly as its twin does.
const MARK = { tileX: 17, tileY: 24 };
const OTHER: Readonly<Record<Caste, Caste>> = { worker: "soldier", soldier: "worker" };

function scene(caste: Caste, walking: boolean, spare = false) {
  const config = rulesConfig("redesign");
  const state = emptyMatch(0, { ...config, rules27: true, commandFloorTicks: 1, startAnts: 0, terrain: undefined,
    foodLayout: undefined, foodPatches: [], hatchIntervalTicks: Number.MAX_SAFE_INTEGER });
  // Synthetic seat only: no join command, network connection or live match.
  state.agents.push({ id: "seat", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
  const queen = activeQueens(state.colonies[0])[0]!;
  const ant = addAnt(state, 0, 14, 24, { caste, role: caste === "soldier" ? "fighter" : "forager",
    ...(walking ? { spawnWalk: { queenId: queen.id, tileX: 14, tileY: 40 } } : {}) });
  // A second, farther ant lets the squad supply (half the colony) take exactly one ant.
  if (spare) addAnt(state, 0, 20, 24, { caste, role: caste === "soldier" ? "fighter" : "forager" });
  expect(state.config.rules27).toBe(true);
  expect(localRulesSide(state, 0)).toBe(true);
  return { state, id: ant.id };
}

const antOf = (state: SimState, id: number): Ant => state.ants.find((a) => a.id === id)!;
const at = (ant: Ant) => ({ x: ant.x, y: ant.y });
const lay = (caste?: Caste): SimInput => ({ type: "count_mark", agentId: "seat", verb: "GATHER", count: 1,
  ...MARK, ...(caste === undefined ? {} : { caste }) });

/** Step walker and twin together; the walker's ant must stand where the twin's does after every tick. */
function together(pair: { walker: SimState; twin: SimState }, id: number, ticks: number, inputs: readonly SimInput[] = []) {
  for (let i = 0; i < ticks; i++) {
    const w = step(pair.walker, i === 0 ? inputs : []), t = step(pair.twin, i === 0 ? inputs : []);
    if (i === 0) for (const out of [w, t]) expect(out.results.every((r) => r.ok)).toBe(true);
    pair.walker = w.state; pair.twin = t.state;
    expect(pair.walker.result).toBeNull();
    const ant = antOf(pair.walker, id);
    expect(ant.spawnWalk).toBeUndefined();
    expect(at(ant)).toEqual(at(antOf(pair.twin, id)));
    expect({ claim: ant.claim, squad: ant.squad }).toEqual({ claim: antOf(pair.twin, id).claim, squad: antOf(pair.twin, id).squad });
  }
}

for (const caste of ["worker", "soldier"] as const) describe(`rules 27: a ${caste} walking to a spawn point`, () => {
  it("is claimed by a count mark like any free ant, does the mark's job, and on release follows its caste's defaults from there without resuming the walk", () => {
    const walker = scene(caste, true), twin = scene(caste, false);
    expect(antOf(walker.state, walker.id).spawnWalk).toBeDefined();
    const pair = { walker: walker.state, twin: twin.state };
    const start = antOf(pair.walker, walker.id);
    const markCentre = { x: tileCentre(MARK.tileX), y: tileCentre(MARK.tileY) };

    // Claimed in the same claim pass as the never-walking twin, and the walk ends.
    together(pair, walker.id, 1, [lay()]);
    const mark = pair.walker.marks.find((m) => m.count !== undefined)!;
    expect(antOf(pair.walker, walker.id).claim).toBe(mark.id);

    // While claimed it does the mark's job: it closes on the mark exactly as the twin does.
    together(pair, walker.id, 20);
    const claimed = antOf(pair.walker, walker.id);
    expect(claimed.claim).toBe(mark.id);
    expect(distance(claimed.x, claimed.y, markCentre.x, markCentre.y)).toBeLessThan(distance(start.x, start.y, markCentre.x, markCentre.y));

    // Re-laying the mark for the other caste releases it where it stands.
    together(pair, walker.id, 1, [lay(OTHER[caste])]);
    const released = antOf(pair.walker, walker.id);
    expect(released.claim).toBeUndefined();
    expect(Math.floor(released.y / SUB)).toBeLessThan(40);

    // From there it plans as the released twin does, never walking on to the spawn tile.
    together(pair, walker.id, 40);
  });

  it("drafted into a squad, ends its walk and is released to its caste's defaults without resuming it", () => {
    const walker = scene(caste, true, true), twin = scene(caste, false, true);
    const pair = { walker: walker.state, twin: twin.state };
    together(pair, walker.id, 1);
    expect(antOf(pair.walker, walker.id).squad).toBe("seat");
    together(pair, walker.id, 10);

    // The farther ant dies: the squad supply drops to zero and the walker is released.
    for (const state of [pair.walker, pair.twin]) state.ants = state.ants.filter((a) => a.id === walker.id);
    together(pair, walker.id, 1);
    expect(antOf(pair.walker, walker.id).squad).toBeNull();
    together(pair, walker.id, 40);
  });
});
