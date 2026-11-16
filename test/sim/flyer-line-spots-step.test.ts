import { describe, expect, it, vi } from "vitest";
import { FLYER_RULES, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { tileCentre, withinTiles, type Vec } from "../../src/sim/geometry.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { Agent, Ant, Mark, SimInput, SimState, Terrain } from "../../src/sim/types.js";
import { addAnt, antById, emptyMatch } from "./fixtures.js";

/**
 * Every call the engine makes to the flyer LINE spot rule, passed through unchanged, so a test can check
 * each spot against the state exactly as the engine stood when it asked.
 */
const probe = vi.hoisted(() => ({
  observe: null as ((state: SimState, mark: Mark, ant: Ant, spot: Vec | null) => void) | null,
}));
vi.mock("../../src/sim/lineMarks.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/sim/lineMarks.js")>();
  return {
    ...real,
    flyerLineSpotOf: (state: SimState, mark: Mark, ant: Ant): Vec | null => {
      const spot = real.flyerLineSpotOf(state, mark, ant);
      probe.observe?.(state, mark, ant, spot);
      return spot;
    },
  };
});

// Test plan check 8, "Seen LINE spots", through the engine's step: the grid-scale-2 match map at
// 10 ticks/s, after the combat grace period, so flyers really take off, fly and hover with combat live.
const config: SimConfig = { ...rulesConfig("redesign"), flyers: FLYER_RULES, startAnts: 0, squadSize: 0,
  terrain: undefined, foodLayout: undefined, foodPatches: [], commandFloorTicks: 0, earlyWin: undefined };
const START = config.combatGraceTicks + 100;
const A = { x: 8, y: 48 }, B = { x: 118, y: 48 };
// Rock and water lie across the line, so some even spots fall on them.
const TERRAIN: Terrain = { mapId: "test", mapName: "test",
  water: [{ x: 86, y: 30, width: 10, height: 37 }], rocks: [{ x: 60, y: 40, width: 6, height: 17, appearance: 0 }] };
const HOME = { x: 8, y: 52 };

const centre = (x: number, y: number): Vec => ({ x: tileCentre(x), y: tileCentre(y) });
const tileOf = (p: Vec) => ({ x: Math.floor(p.x / SUB), y: Math.floor(p.y / SUB) });

function scene(): SimState {
  const state = emptyMatch(START, config);
  (state as { terrain?: Terrain }).terrain = TERRAIN;
  for (const colony of state.colonies) colony.foodStore = 0;
  for (const colony of [0, 1] as const) {
    const agent: Agent = { id: colony === 0 ? "a" : "b", colony, joinSeq: colony, modelLabel: null, parentAgentId: null,
      squad: [], order: { kind: "hold" }, lastCallTick: START, lastCommandTick: START, idle: false, pendingEvents: [] };
    state.agents.push(agent);
  }
  return state;
}

/** A worker held on its own DEFEND mark, so it stays where it is put. */
function heldWorker(state: SimState, colony: 0 | 1, x: number, y: number): Ant {
  state.marks.push({ id: state.nextMarkId++, agentId: colony === 0 ? "a" : "b", colony, tileX: x, tileY: y, words: [],
    laidTick: START - 1, steering: 0, verb: "DEFEND", count: 1, revision: 0, caste: "worker" });
  return addAnt(state, colony, x, y);
}

/** The agent's flyer LINE order from A to B: laid, or re-laid on the same ends with a new count. */
const line = (count: number): SimInput =>
  ({ type: "count_mark", agentId: "a", verb: "LINE", tileX: A.x, tileY: A.y, toTileX: B.x, toTileY: B.y, count, caste: "flyer" });

/** The mark's claimed ants outside squads, in line order from its first end, then by id. */
function membersOf(state: SimState, mark: Mark): Ant[] {
  const a = centre(mark.tileX, mark.tileY), b = centre(mark.toTileX!, mark.toTileY!);
  const along = (ant: Ant) => (ant.x - a.x) * (b.x - a.x) + (ant.y - a.y) * (b.y - a.y);
  return state.ants.filter((ant) => ant.claim === mark.id && ant.squad === null).sort((p, q) => along(p) - along(q) || p.id - q.id);
}

/** The i-th of n evenly spread points from end to end, a lone one at the midpoint. */
function even(mark: Mark, i: number, n: number): Vec {
  const a = centre(mark.tileX, mark.tileY), b = centre(mark.toTileX!, mark.toTileY!);
  return n === 1 ? { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
    : { x: a.x + Math.round(((b.x - a.x) * i) / (n - 1)), y: a.y + Math.round(((b.y - a.y) * i) / (n - 1)) };
}

/** The colony's current sight, tile by tile: within sightTiles of a living ant of the colony. */
function sightOf(state: SimState, colony: number): (x: number, y: number) => boolean {
  const eyes = state.ants.filter((ant) => ant.colony === colony && ant.hp > 0).map((ant) => tileOf(ant));
  return (x, y) => eyes.some((eye) => withinTiles(eye.x, eye.y, x, y, state.config.sightTiles));
}

interface Expected { readonly even: Vec; readonly spot: Vec | null; readonly moved: "no" | "unseen" | "blocked" }
/**
 * The rule, by brute force over every tile of the map: a spot passes when its tile is land in the colony's
 * current sight. Each member keeps its even spot when that passes; otherwise it gets the centre of the passing
 * tile nearest the even spot by straight-line distance (row-major order breaks ties), or null with none.
 */
function expected(state: SimState, mark: Mark, seen: (x: number, y: number) => boolean): Map<number, Expected> {
  const { mapWidth: width, mapHeight: height } = state.config;
  const passes = (x: number, y: number) => !isBlockedTile(state.terrain, x, y) && seen(x, y);
  const passing: { x: number; y: number }[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (passes(x, y)) passing.push({ x, y });
  const members = membersOf(state, mark);
  return new Map(members.map((ant, i): [number, Expected] => {
    const point = even(mark, i, members.length), tile = tileOf(point);
    if (passes(tile.x, tile.y)) return [ant.id, { even: point, spot: point, moved: "no" }];
    let best: { x: number; y: number } | null = null, bestD = Infinity;
    for (const t of passing) {
      const d = (point.x - tileCentre(t.x)) ** 2 + (point.y - tileCentre(t.y)) ** 2;
      if (d < bestD) { best = t; bestD = d; }
    }
    return [ant.id, { even: point, spot: best === null ? null : centre(best.x, best.y),
      moved: isBlockedTile(state.terrain, tile.x, tile.y) ? "blocked" : "unseen" }];
  }));
}

/** What the engine asked of the spot rule on one tick, and the rule worked out on the state it asked from. */
interface Asked {
  expected: Map<number, Expected> | null;
  seen: ((x: number, y: number) => boolean) | null;
  readonly spots: Map<number, Vec | null>;
}

describe("seen LINE spots through the engine's step (test plan check 8)", () => {
  it("gives each flyer, on every tick, a spot that is land in current colony sight, moving unseen spots to the nearest seen land tile", () => {
    let state = scene();
    heldWorker(state, 0, A.x, A.y);
    const scoutB = heldWorker(state, 0, B.x, B.y);
    heldWorker(state, 1, 40, 48); // an enemy over the middle gives colony 0 no sight
    for (let i = 0; i < 5; i++) addAnt(state, 0, HOME.x, HOME.y, { flyer: true });

    let asked: Asked = { expected: null, seen: null, spots: new Map() };
    probe.observe = (at, mark, ant, spot) => {
      // The rule settles each tick's spots from the state as it stands at the first ask, so the check does too.
      if (asked.expected === null) {
        asked.seen = sightOf(at, mark.colony);
        asked.expected = expected(at, mark, asked.seen);
      }
      asked.spots.set(ant.id, spot);
    };

    const stats: Record<string, { unseen: number; blocked: number; endMoved: number; members: Set<number> }> = {};
    let phase = "laid", markId: number | null = null;
    try {
      for (let t = 0; t < 220; t++) {
        const inputs: SimInput[] = [];
        if (t === 0) inputs.push(line(5));
        if (t === 10) { // a member killed: the middle one in line order
          const dead = membersOf(state, state.marks.find((m) => m.id === markId)!)[2]!;
          state.ants = state.ants.filter((ant) => ant.id !== dead.id);
          phase = "member killed";
        }
        if (t === 20) { // the count raised from 5 to 6: two more flyers wait at home and join
          for (let i = 0; i < 2; i++) addAnt(state, 0, HOME.x, HOME.y, { flyer: true });
          inputs.push(line(6));
          phase = "count raised";
        }
        if (t === 30) { inputs.push(line(3)); phase = "count lowered"; }
        if (t === 40) { // one end's scout killed, while no flyer is near that end
          state.ants = state.ants.filter((ant) => ant.id !== scoutB.id);
          phase = "end scout killed";
        }

        asked = { expected: null, seen: null, spots: new Map() };
        const out = step(state, inputs);
        for (const result of out.results) expect(result.ok ? null : result.error).toBeNull();
        state = out.state;
        const tick = state.tick - 1;
        const mark = state.marks.find((m) => m.verb === "LINE")!;
        markId = mark.id;

        // Every claimed flyer asked for its spot, and each got exactly the rule's spot on that tick's state.
        const want = asked.expected!;
        expect([...asked.spots.keys()].sort((p, q) => p - q), `tick ${tick} members asked`).toEqual([...want.keys()].sort((p, q) => p - q));
        for (const [id, spot] of asked.spots) {
          expect(spot, `tick ${tick} flyer ${id}`).toEqual(want.get(id)!.spot);
          expect(spot, `tick ${tick} flyer ${id} has no spot`).not.toBeNull();
          const tile = tileOf(spot!);
          expect(isBlockedTile(state.terrain, tile.x, tile.y), `tick ${tick} flyer ${id} spot on water or rock`).toBe(false);
          expect(asked.seen!(tile.x, tile.y), `tick ${tick} flyer ${id} spot unseen`).toBe(true);
          // It flies to that spot in the air, and hovers only on it.
          const ant = antById(state, id)!;
          expect(ant.air, `tick ${tick} flyer ${id} airborne`).toMatchObject({ destX: spot!.x, destY: spot!.y, released: false });
          if (ant.air!.hovering) expect({ x: ant.x, y: ant.y }, `tick ${tick} flyer ${id} hovering`).toEqual(spot);
        }

        const counts = stats[phase] ??= { unseen: 0, blocked: 0, endMoved: 0, members: new Set() };
        counts.members.add(want.size);
        const order = [...want.values()];
        for (const e of order) {
          if (e.moved === "unseen") counts.unseen++;
          if (e.moved === "blocked") counts.blocked++;
        }
        const end = order[order.length - 1]!;
        if (end.spot!.x !== end.even.x || end.spot!.y !== end.even.y) counts.endMoved++;
      }
    } finally {
      probe.observe = null;
    }

    // Each change took effect on its own tick: 5 members as laid, 4 after the kill, 6 after the raise, then 3.
    expect(Object.fromEntries(Object.entries(stats).map(([name, s]) => [name, [...s.members]]))).toEqual({
      "laid": [5], "member killed": [4], "count raised": [6], "count lowered": [3], "end scout killed": [3] });

    // The scenario reaches each case: unseen middle spots moved while the line had 5, 4 and 6 members, and the
    // far end's spot once its scout died; spots on rock or water moved while it had 5 and 3.
    for (const name of ["laid", "member killed", "count raised", "end scout killed"]) expect(stats[name]!.unseen, name).toBeGreaterThan(0);
    for (const name of ["laid", "count lowered"]) expect(stats[name]!.blocked, name).toBeGreaterThan(0);
    for (const name of ["laid", "member killed", "count raised", "count lowered"]) expect(stats[name]!.endMoved, name).toBe(0);
    expect(stats["end scout killed"]!.endMoved).toBeGreaterThan(0);

    // At the end three flyers hover on the line: on both ends, seen again once a flyer reached the far one,
    // and beside the rock on the middle's nearest land tile.
    const mark = state.marks.find((m) => m.verb === "LINE")!;
    const members = membersOf(state, mark);
    expect(members.map((ant) => ({ x: ant.x, y: ant.y, hovering: ant.air?.hovering }))).toEqual(
      [centre(A.x, A.y), centre(66, 48), centre(B.x, B.y)].map((p) => ({ ...p, hovering: true })));
  });
});
