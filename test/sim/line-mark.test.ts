import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, speedPerTick, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { tileCentre, type Vec } from "../../src/sim/geometry.js";
import { lineSpots } from "../../src/sim/lineMarks.js";
import { stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { Agent, Ant, SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { addAnt } from "./fixtures.js";

function scene(mapId = "open-field", patch: Partial<SimConfig> = {}): SimState {
  const base = rulesConfig("redesign");
  // No squad: colony sight comes from the free ants, and no squad lapse frees extra ants mid-test.
  const config = newMatchConfig({ ...base, startAnts: 0, squadSize: 0, commandFloorTicks: 1, hatchIntervalTicks: 1_000_000,
    terrain: { ...base.terrain!, mapId }, ...patch });
  const state = createMatch(4530, config);
  state.ants = [];
  state.tick = 1000; // past the opening combat delay
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: null, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return state;
}
const errorOf = (out: StepOutput) => { const result = out.results[0]!; return result.ok ? null : result.error; };
const tileOf = (state: SimState, ant: Ant) => ({ x: Math.floor(ant.x / SUB), y: Math.floor(ant.y / SUB) });
function lay(state: SimState, input: Partial<Extract<SimInput, { type: "count_mark" }>>) {
  return step(state, [{ type: "count_mark", agentId: "a", verb: "LINE", count: 1, ...input } as SimInput]);
}

function lineScene(n: number, from: Vec = { x: 24, y: 40 }, to: Vec = { x: 24, y: 58 }, mapId = "open-field") {
  const state = scene(mapId);
  for (const end of [from, to]) addAnt(state, 0, end.x, end.y); // colony sight over both ends
  // Spare free ants: house rules may keep some home, so the line can still fill.
  for (let i = 0; i < 2 * n + 4; i++) addAnt(state, 0, 18 + (i % 3), 47 + (i % 5));
  const out = lay(state, { tileX: from.x, tileY: from.y, toTileX: to.x, toTileY: to.y, count: n });
  return out;
}
const members = (state: SimState) => state.ants.filter(ant => ant.claim === state.marks[0]?.id);
/** Steps, checking that no ant ever moves faster than a lone ant. */
function settle(state: SimState, ticks = 400, inputs: SimInput[] = []): SimState {
  const speed = speedPerTick(state.config);
  for (let t = 0; t < ticks; t++) {
    const before = new Map(state.ants.map(ant => [ant.id, { x: ant.x, y: ant.y }]));
    state = step(state, t === 0 ? inputs : []).state;
    for (const ant of state.ants) {
      const old = before.get(ant.id);
      if (old !== undefined) expect(Math.hypot(ant.x - old.x, ant.y - old.y)).toBeLessThanOrEqual(speed);
    }
  }
  return state;
}
/** Claimed ants ordered along the line, each standing on its own evenly spaced spot. */
function expectOnSpots(state: SimState, expected: readonly Vec[]) {
  const along = members(state).sort((p, q) => p.y - q.y || p.x - q.x);
  expect(along).toHaveLength(expected.length);
  along.forEach((ant, i) => {
    expect(Math.hypot(ant.x - expected[i]!.x, ant.y - expected[i]!.y)).toBeLessThanOrEqual(SUB / 4);
    const tile = tileOf(state, ant);
    expect(isBlockedTile(state.terrain, tile.x, tile.y)).toBe(false);
  });
}
const even = (n: number, a: Vec, b: Vec): Vec[] => Array.from({ length: n }, (_, i) => n === 1
  ? { x: (tileCentre(a.x) + tileCentre(b.x)) / 2, y: (tileCentre(a.y) + tileCentre(b.y)) / 2 }
  : { x: tileCentre(a.x) + ((tileCentre(b.x) - tileCentre(a.x)) * i) / (n - 1), y: tileCentre(a.y) + ((tileCentre(b.y) - tileCentre(a.y)) * i) / (n - 1) });

const A = { x: 24, y: 40 }, B = { x: 24, y: 58 };

describe("rules 26 LINE count marks", () => {
  it("spreads its answering ants evenly from end to end on walkable tiles and holds them there", () => {
    const out = lineScene(5);
    expect(errorOf(out)).toBeNull();
    const state = settle(out.state);
    expectOnSpots(state, even(5, A, B));
    // Holding: another stretch of play leaves every ant on its spot.
    const before = members(state).map(ant => ({ id: ant.id, x: ant.x, y: ant.y }));
    const later = settle(state, 100);
    for (const old of before) {
      const ant = later.ants.find(item => item.id === old.id)!;
      expect(Math.hypot(ant.x - old.x, ant.y - old.y)).toBeLessThanOrEqual(SUB / 4);
    }
  });

  it("puts a lone ant at the midpoint", () => {
    const state = settle(lineScene(1).state);
    expectOnSpots(state, even(1, A, B));
    expect(members(state)[0]!.y).toBe((tileCentre(A.y) + tileCentre(B.y)) / 2);
  });

  it("re-spreads when an ant dies and when the count is raised", () => {
    let state = settle(lineScene(5).state);
    const dead = members(state).sort((p, q) => p.y - q.y)[2]!;
    // No spare free ants, so the vacancy stays open and the line closes up over four.
    state.ants = state.ants.filter(ant => ant.id !== dead.id && ant.claim !== undefined);
    state = settle(state);
    expectOnSpots(state, even(4, A, B));
    for (let i = 0; i < 8; i++) addAnt(state, 0, 18 + (i % 3), 47 + (i % 5));
    state = settle(state, 400, [{ type: "count_mark", agentId: "a", verb: "LINE", count: 6, ...{ tileX: A.x, tileY: A.y, toTileX: B.x, toTileY: B.y } }]);
    expect(state.marks).toHaveLength(1);
    expect(state.marks[0]!.count).toBe(6);
    expectOnSpots(state, even(6, A, B));
  });

  it("bites an enemy in reach without leaving its spot, and never chases one out of reach", () => {
    let state = settle(lineScene(3).state);
    const middle = members(state).sort((p, q) => p.y - q.y)[1]!;
    const spot = { x: middle.x, y: middle.y };
    const tile = tileOf(state, middle);
    const near = addAnt(state, 1, tile.x + 1, tile.y, { order: undefined } as Partial<Ant>);
    const far = addAnt(state, 1, tile.x + 4, tile.y + 1);
    near.hp = 4000; far.hp = 4000;
    // Hold both enemies still so only the line ants could close the distance.
    const pin = (s: SimState) => { for (const id of [near.id, far.id]) { const e = s.ants.find(a => a.id === id); if (e) { e.x = tileCentre(id === near.id ? tile.x + 1 : tile.x + 4); e.y = tileCentre(id === near.id ? tile.y : tile.y + 1); } } };
    for (let t = 0; t < 30; t++) { pin(state); state = step(state).state; }
    const after = state.ants.find(ant => ant.id === middle.id)!;
    expect(Math.hypot(after.x - spot.x, after.y - spot.y)).toBeLessThanOrEqual(SUB / 2);
    const bitten = state.ants.find(ant => ant.id === near.id);
    expect(bitten === undefined || bitten.hp < 4000).toBe(true);
    const untouched = state.ants.find(ant => ant.id === far.id)!;
    expect(untouched.hp).toBe(4000);
  });

  it("never rests an ant on water or rock when the line crosses blocked tiles", () => {
    const base = scene("open-field");
    // Find a straight row segment that crosses a rock between two land ends near colony 0.
    const w = base.config.mapWidth;
    let ends: { a: Vec; b: Vec } | undefined;
    for (let y = 30; y < 70 && ends === undefined; y++) for (let x = 20; x < 50 && ends === undefined; x++) {
      if (!isBlockedTile(base.terrain, x, y) && isBlockedTile(base.terrain, x + 3, y) && !isBlockedTile(base.terrain, x + 8, y) && x + 8 < w) ends = { a: { x, y }, b: { x: x + 8, y } };
    }
    expect(ends).toBeDefined();
    const out = lineScene(9, ends!.a, ends!.b);
    expect(errorOf(out)).toBeNull();
    const state = settle(out.state);
    expect(members(state)).toHaveLength(9);
    for (const ant of members(state)) {
      const tile = tileOf(state, ant);
      expect(isBlockedTile(state.terrain, tile.x, tile.y)).toBe(false);
    }
    for (const spot of lineSpots(state, state.marks[0]!, 9)) expect(isBlockedTile(state.terrain, Math.floor(spot.x / SUB), Math.floor(spot.y / SUB))).toBe(false);
  });

  it("gives the same state from the same seed and inputs", () => {
    expect(stateHash(settle(lineScene(5).state, 200))).toBe(stateHash(settle(lineScene(5).state, 200)));
  });
});

describe("rules 26 LINE refusals", () => {
  const cases: readonly [string, Partial<Extract<SimInput, { type: "count_mark" }>>, string][] = [
    ["a missing second end", { tileX: A.x, tileY: A.y, toTileX: B.x }, "bad_count_mark"],
    ["a missing first end", { toTileX: B.x, toTileY: B.y }, "bad_count_mark"],
    ["a fractional end", { tileX: A.x, tileY: A.y, toTileX: B.x + 0.5, toTileY: B.y }, "bad_count_mark"],
    ["an end outside the map", { tileX: A.x, tileY: A.y, toTileX: 500, toTileY: B.y }, "bad_count_mark"],
    ["two identical ends", { tileX: A.x, tileY: A.y, toTileX: A.x, toTileY: A.y }, "bad_count_mark"],
    ["an end outside colony sight", { tileX: A.x, tileY: A.y, toTileX: 80, toTileY: 20 }, "count_mark_not_visible"],
  ];
  it.each(cases)("refuses %s, changing no marks", (_name, input, code) => {
    const state = scene();
    addAnt(state, 0, A.x, A.y); addAnt(state, 0, B.x, B.y);
    const out = lay(state, input);
    expect(errorOf(out)?.code).toBe(code);
    expect(out.state.marks).toHaveLength(0);
  });

  it("refuses a rock or water second end", () => {
    const state = scene();
    const w = state.config.mapWidth, h = state.config.mapHeight;
    let rock: Vec | undefined;
    for (let y = 0; y < h && rock === undefined; y++) for (let x = 0; x < w / 2 && rock === undefined; x++) if (isBlockedTile(state.terrain, x, y)) rock = { x, y };
    addAnt(state, 0, rock!.x - 1, rock!.y);
    const out = lay(state, { tileX: rock!.x - 1, tileY: rock!.y, toTileX: rock!.x, toTileY: rock!.y });
    expect(["rock_tile", "water_tile"]).toContain(errorOf(out)?.code);
    expect(out.state.marks).toHaveLength(0);
  });

  it.each(["DEFEND", "FORAGE", "ATTACK", "GATHER", "PATROL"])("refuses a second end on %s", verb => {
    const state = scene();
    addAnt(state, 0, A.x, A.y);
    const out = lay(state, { verb, tileX: A.x, tileY: A.y, toTileX: A.x, toTileY: A.y + 2 });
    expect(errorOf(out)?.code).toBe("bad_count_mark");
    expect(out.state.marks).toHaveLength(0);
  });

});

