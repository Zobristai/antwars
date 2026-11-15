import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, type SimConfig, type WaterRect } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { tileCentre, withinTiles, type Vec } from "../../src/sim/geometry.js";
import { flyerLineSpotOf, lineDistance, lineSpots } from "../../src/sim/lineMarks.js";
import { cloneState, createMatch } from "../../src/sim/map.js";
import { isBlockedTile, isWaterTile } from "../../src/sim/terrain.js";
import type { Ant, Mark, Rock, SimState } from "../../src/sim/types.js";
import { addAnt } from "./fixtures.js";

/** A scripted match on an open board with the given water and rock (by board size), no ants and no marks. */
function scene(obstacles: (width: number, height: number) => { water?: WaterRect[]; rocks?: Rock[] } = () => ({})): SimState {
  const config: SimConfig = newMatchConfig({ ...rulesConfig("redesign"), startAnts: 0 });
  const match = createMatch(4531, config), { water = [], rocks = [] } = obstacles(match.config.mapWidth, match.config.mapHeight);
  const state: SimState = { ...match, terrain: { mapId: "flyer-line", mapName: "Flyer line", water, rocks } };
  state.ants = [];
  state.marks = [];
  state.tick = 1000;
  return state;
}

// Mark.caste "flyer" and Ant.flyer are the flyer fields of the breeding change; they are set here as
// plain data so these scripted states read as the engine's, and the spot rule reads neither.
function flyerLine(state: SimState, from: Vec, to: Vec, count: number): Mark {
  const mark: Mark = { id: 1, agentId: "a", colony: 0, tileX: from.x, tileY: from.y, toTileX: to.x, toTileY: to.y,
    words: [], laidTick: state.tick, steering: 0, verb: "LINE", count, revision: 0 };
  Object.assign(mark, { caste: "flyer" });
  state.marks.push(mark);
  return mark;
}
const flyer = (state: SimState, mark: Mark, x: number, y: number): Ant =>
  Object.assign(addAnt(state, 0, x, y, { claim: mark.id }), { flyer: true as const });
const scout = (state: SimState, x: number, y: number): Ant => addAnt(state, 0, x, y);
const centre = (x: number, y: number): Vec => ({ x: tileCentre(x), y: tileCentre(y) });
const tileOf = (p: Vec) => ({ x: Math.floor(p.x / SUB), y: Math.floor(p.y / SUB) });

/** Current colony sight, exactly as a count mark's placement tests it: a living own ant within sightTiles. */
function seen(state: SimState, colony: number, x: number, y: number): boolean {
  return state.ants.some(ant => ant.colony === colony && ant.hp > 0 &&
    withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), x, y, state.config.sightTiles));
}
const passes = (state: SimState, colony: number, x: number, y: number) => !isBlockedTile(state.terrain, x, y) && seen(state, colony, x, y);

/** The mark's claimed flyers in line order, then by id. */
function membersOf(state: SimState, mark: Mark): Ant[] {
  const a = centre(mark.tileX, mark.tileY), b = centre(mark.toTileX!, mark.toTileY!);
  const along = (ant: Ant) => (ant.x - a.x) * (b.x - a.x) + (ant.y - a.y) * (b.y - a.y);
  return state.ants.filter(ant => ant.claim === mark.id && ant.squad === null).sort((p, q) => along(p) - along(q) || p.id - q.id);
}

/** The i-th of n evenly spread points from end to end, a lone one at the midpoint. */
function even(mark: Mark, i: number, n: number): Vec {
  const a = centre(mark.tileX, mark.tileY), b = centre(mark.toTileX!, mark.toTileY!);
  return n === 1 ? { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
    : { x: a.x + Math.round(((b.x - a.x) * i) / (n - 1)), y: a.y + Math.round(((b.y - a.y) * i) / (n - 1)) };
}

interface Expected { readonly even: Vec; readonly spot: Vec | null; readonly moved: "no" | "unseen" | "blocked" }
/**
 * The rule, by brute force over every tile: the even spot when its tile passes; otherwise the centre of
 * the passing tile nearest the even spot by straight-line distance (row-major order breaks ties); null
 * when no tile on the map passes.
 */
function expected(state: SimState, mark: Mark): Map<number, Expected> {
  const { mapWidth: width, mapHeight: height } = state.config;
  const passing: Vec[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (passes(state, mark.colony, x, y)) passing.push({ x, y });
  const members = membersOf(state, mark);
  return new Map(members.map((ant, i): [number, Expected] => {
    const point = even(mark, i, members.length), tile = tileOf(point);
    if (passes(state, mark.colony, tile.x, tile.y)) return [ant.id, { even: point, spot: point, moved: "no" }];
    let best: Vec | null = null, bestD = Infinity;
    for (const t of passing) {
      const d = (point.x - tileCentre(t.x)) ** 2 + (point.y - tileCentre(t.y)) ** 2;
      if (d < bestD) { best = t; bestD = d; }
    }
    return [ant.id, { even: point, spot: best === null ? null : centre(best.x, best.y),
      moved: isBlockedTile(state.terrain, tile.x, tile.y) ? "blocked" : "unseen" }];
  }));
}

/** Every member's spot this tick, checked against the rule; returns the expectations for reporting. */
function checkTick(state: SimState, mark: Mark): Map<number, Expected> {
  const want = expected(state, mark);
  for (const ant of membersOf(state, mark)) {
    const spot = flyerLineSpotOf(state, mark, ant);
    expect(spot, `tick ${state.tick} flyer ${ant.id}`).toEqual(want.get(ant.id)!.spot);
    if (spot === null) continue;
    const tile = tileOf(spot);
    expect(isBlockedTile(state.terrain, tile.x, tile.y), `tick ${state.tick} flyer ${ant.id} on water or rock`).toBe(false);
    expect(seen(state, mark.colony, tile.x, tile.y), `tick ${state.tick} flyer ${ant.id} unseen`).toBe(true);
  }
  return want;
}

/** The flight the engine flies: straight toward the spot at 8 tiles a second; on null it keeps its last spot. */
function fly(state: SimState, mark: Mark, last: Map<number, Vec>): void {
  const step = (8 * SUB) / state.config.ticksPerSecond;
  for (const ant of membersOf(state, mark)) {
    const spot = flyerLineSpotOf(state, mark, ant) ?? last.get(ant.id);
    if (spot === undefined) continue;
    last.set(ant.id, spot);
    const dx = spot.x - ant.x, dy = spot.y - ant.y, d = Math.hypot(dx, dy);
    if (d <= step) { ant.x = spot.x; ant.y = spot.y; } else { ant.x += Math.round((dx * step) / d); ant.y += Math.round((dy * step) / d); }
  }
}

describe("flyer LINE spots", () => {
  it("keeps every flyer's spot on seen land on every tick through a death, count changes and a lost scout", () => {
    // A long line whose ends are seen by scouts and whose middle is not; rock and water lie across it.
    const A = { x: 8, y: 48 }, B = { x: 118, y: 48 };
    const state = scene(() => ({ water: [{ x: 86, y: 30, width: 10, height: 37 }], rocks: [{ x: 60, y: 40, width: 6, height: 17, appearance: 0 }] }));
    expect(state.config.sightTiles).toBe(12);
    const mark = flyerLine(state, A, B, 5);
    scout(state, A.x, A.y);
    const scoutB = scout(state, B.x, B.y);
    addAnt(state, 1, 40, 48); // an enemy over the middle gives colony 0 no sight
    addAnt(state, 0, 75, 48, { hp: 0 }); // nor does a dead own ant
    const home = { x: 8, y: 52 };
    for (let i = 0; i < 5; i++) flyer(state, mark, home.x, home.y);
    const last = new Map<number, Vec>();
    const stats: Record<string, { unseen: number; blocked: number; endMoved: number }> = {};
    let phase = "laid";
    for (let t = 0; t < 200; t++) {
      if (t === 30) { // a member killed: the middle one in line order
        const dead = membersOf(state, mark)[2]!;
        state.ants = state.ants.filter(ant => ant.id !== dead.id);
        phase = "member killed";
      }
      if (t === 60) { // the count raised from 5 to 6: two more flyers join from home
        mark.count = 6;
        for (let i = 0; i < 2; i++) flyer(state, mark, home.x, home.y);
        phase = "count raised";
      }
      if (t === 90) { // the count lowered to 3: the farthest from the line are released first
        mark.count = 3;
        const farthest = membersOf(state, mark).sort((p, q) => lineDistance(q, mark) - lineDistance(p, mark) || q.id - p.id);
        for (const ant of farthest.slice(0, farthest.length - 3)) delete ant.claim;
        phase = "count lowered";
      }
      if (t === 120) { // one end's scout killed
        state.ants = state.ants.filter(ant => ant.id !== scoutB.id);
        phase = "end scout killed";
      }
      const want = checkTick(state, mark);
      const counts = stats[phase] ??= { unseen: 0, blocked: 0, endMoved: 0 };
      const members = membersOf(state, mark);
      for (const ant of members) {
        const e = want.get(ant.id)!;
        if (e.moved === "unseen") counts.unseen++;
        if (e.moved === "blocked") counts.blocked++;
      }
      const end = want.get(members[members.length - 1]!.id)!;
      if (end.spot !== null && (end.spot.x !== end.even.x || end.spot.y !== end.even.y)) counts.endMoved++;
      fly(state, mark, last);
      state.tick += 1;
    }
    // The scenario reaches each case: unseen middle spots moved while the line is laid, after the death
    // and after the raise; spots on rock or water moved; and the far end's spot moved once its scout died.
    for (const name of ["laid", "member killed", "count raised", "end scout killed"]) expect(stats[name]!.unseen, name).toBeGreaterThan(0);
    for (const name of ["laid", "count lowered", "end scout killed"]) expect(stats[name]!.blocked, name).toBeGreaterThan(0);
    for (const name of ["laid", "member killed", "count raised", "count lowered"]) expect(stats[name]!.endMoved, name).toBe(0);
    expect(stats["end scout killed"]!.endMoved).toBeGreaterThan(0);
    expect(membersOf(state, mark)).toHaveLength(3);
  });

  it("moves a spot over water to the nearest seen land tile across it, where a ground LINE spot keeps to its end's bank", () => {
    // A river six tiles wide, the board's full height, crosses the line nearer its east bank; both ends are seen.
    const state = scene((_width, height) => ({ water: [{ x: 56, y: 0, width: 6, height }] }));
    const A = { x: 50, y: 40 }, B = { x: 70, y: 40 };
    const mark = flyerLine(state, A, B, 3);
    scout(state, A.x, A.y); scout(state, B.x, B.y);
    for (let i = 0; i < 3; i++) flyer(state, mark, A.x, A.y + 1);
    const middle = membersOf(state, mark)[1]!;
    expect(isWaterTile(state.terrain, 60, 40)).toBe(true); // the middle even spot is on water
    expect(flyerLineSpotOf(state, mark, middle)).toEqual(centre(62, 40));
    expect(lineSpots(state, mark, 3)[1]).toEqual(centre(55, 40));
    checkTick(state, mark);
  });

  it("is null when no tile on the map passes, and takes a spot on the next tick once one does", () => {
    // A lone flyer over the middle of a lake: everything it sees is water, and no other own ant sees anything.
    const state = scene(() => ({ water: [{ x: 30, y: 20, width: 40, height: 56 }] }));
    const mark = flyerLine(state, { x: 20, y: 48 }, { x: 80, y: 48 }, 1);
    const lone = flyer(state, mark, 50, 48);
    expect(flyerLineSpotOf(state, mark, lone)).toBeNull();
    checkTick(state, mark);
    scout(state, 80, 48);
    expect(flyerLineSpotOf(state, mark, lone)).toBeNull(); // settled for this tick
    state.tick += 1;
    expect(flyerLineSpotOf(state, mark, lone)).toEqual(centre(70, 48));
    checkTick(state, mark);
  });

  it("settles each tick's spots once and re-spreads them from the next tick's sight", () => {
    const state = scene();
    const A = { x: 20, y: 48 }, B = { x: 60, y: 48 };
    const mark = flyerLine(state, A, B, 3);
    scout(state, A.x, A.y); const far = scout(state, B.x, B.y);
    const members = [flyer(state, mark, A.x, A.y), flyer(state, mark, 40, 48), flyer(state, mark, B.x, B.y)];
    const before = members.map(ant => flyerLineSpotOf(state, mark, ant));
    expect(before).toEqual([even(mark, 0, 3), even(mark, 1, 3), even(mark, 2, 3)]);
    // Within the tick, moves and deaths change nothing; a copy of the state, or the next tick, sees them.
    state.ants = state.ants.filter(ant => ant.id !== far.id);
    members[2]!.x = tileCentre(40); members[1]!.x = tileCentre(30);
    expect(members.map(ant => flyerLineSpotOf(state, mark, ant))).toEqual(before);
    const copy = cloneState(state);
    expect(flyerLineSpotOf(copy, mark, copy.ants.find(ant => ant.id === members[2]!.id)!)).toEqual(centre(52, 48));
    state.tick += 1;
    expect(flyerLineSpotOf(state, mark, members[2]!)).toEqual(centre(52, 48));
    checkTick(state, mark);
  });

  it("spreads flyers evenly end to end in line order, a lone flyer at the midpoint", () => {
    const state = scene();
    const A = { x: 30, y: 40 }, B = { x: 46, y: 52 };
    const mark = flyerLine(state, A, B, 4);
    scout(state, 38, 46);
    // Claimed in reverse line order: the flyer nearest the first end takes the first spot, so none cross.
    const members = [flyer(state, mark, B.x, B.y), flyer(state, mark, 41, 48), flyer(state, mark, 35, 44), flyer(state, mark, A.x, A.y)];
    expect(members.map(ant => flyerLineSpotOf(state, mark, ant))).toEqual([3, 2, 1, 0].map(i => even(mark, i, 4)));
    checkTick(state, mark);
    // An ant the mark has not claimed has no spot on it.
    expect(flyerLineSpotOf(state, mark, scout(state, 38, 47))).toBeNull();
    state.ants = state.ants.filter(ant => ant.claim !== mark.id || ant.id === members[1]!.id);
    state.tick += 1;
    expect(flyerLineSpotOf(state, mark, members[1]!)).toEqual({ x: (tileCentre(A.x) + tileCentre(B.x)) / 2, y: (tileCentre(A.y) + tileCentre(B.y)) / 2 });
    checkTick(state, mark);
  });
});
