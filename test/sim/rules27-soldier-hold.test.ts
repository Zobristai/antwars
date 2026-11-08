import { describe, expect, it } from "vitest";
import { defaultAllocator } from "../../src/sim/agents.js";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { activeQueens } from "../../src/sim/map.js";
import { releaseClaim } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Ant, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

/** The hold radius is 3 reference tiles, 6 fine tiles at grid scale 2. Stated here, not read from config. */
const HOLD_FINE_TILES = 6;

type Tile = { readonly tileX: number; readonly tileY: number };
const tileOf = (ant: Ant): Tile => ({ tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) });
const tileDistance = (a: Tile, b: Tile): number => Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);
const byId = (state: SimState, id: number): Ant => state.ants.find((ant) => ant.id === id)!;

/** A seated colony 0 on the live redesign rules at grid scale 2, open ground, no enemy ants. */
function scene(overrides: Partial<SimConfig> = {}): { state: SimState; agent: Agent; queen: Tile } {
  const base = withGridScale(rulesConfig("redesign"));
  const config: SimConfig = { ...base, startAnts: 0, terrain: undefined,
    foodLayout: undefined, foodPatches: [], hatchIntervalTicks: Number.MAX_SAFE_INTEGER, commandFloorTicks: 1,
    // No automatic squad drafting: every soldier here stays free unless a test drafts it.
    squadSize: 0, ...overrides };
  const state = emptyMatch(0, config);
  for (const colony of state.colonies) colony.foodStore = 0;
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  const home = activeQueens(state.colonies[0])[0]!;
  return { state, agent, queen: { tileX: Math.floor(home.queenX / SUB), tileY: Math.floor(home.queenY / SUB) } };
}

/** One tick; live seats never lapse into command-idle takeover. */
function tick(state: SimState, inputs: readonly SimInput[] = []): { state: SimState; events: SimEvent[] } {
  const out = step(state, inputs, defaultAllocator, undefined, undefined, false, true);
  expect(out.results.filter((result) => !result.ok).map((result) => result.error)).toEqual([]);
  return { state: out.state, events: out.events };
}

/**
 * Three soldiers 30 fine tiles out from the queen are claimed by a soldier GATHER mark 8 fine tiles
 * farther out and walk to it; the returned state has all three claimed and settled at the mark.
 */
function claimedAtMark(overrides: Partial<SimConfig> = {}) {
  const s = scene(overrides);
  const out = { tileX: s.queen.tileX + 30, tileY: s.queen.tileY };
  const soldiers = [0, 1, 2].map((dy) => addAnt(s.state, 0, out.tileX, out.tileY + dy, { caste: "soldier", role: "fighter" }).id);
  const mark = { tileX: out.tileX + 8, tileY: out.tileY + 1 };
  let { state } = tick(s.state, [{ type: "count_mark", agentId: "a", tileX: mark.tileX, tileY: mark.tileY, verb: "GATHER", count: 3, caste: "soldier" }]);
  for (let t = 0; t < 200; t++) state = tick(state).state;
  const markId = state.marks[0]!.id;
  for (const id of soldiers) {
    const ant = byId(state, id);
    expect(ant.claim).toBe(markId);
    expect(ant.holdPoint).toBeUndefined();
    expect(tileDistance(tileOf(ant), mark)).toBeLessThanOrEqual(HOLD_FINE_TILES);
  }
  return { ...s, state, soldiers, mark, markId };
}

/** Expire the mark at the end of the next tick; the claim pass of the tick after releases its ants. */
function expireAndRelease(state: SimState): { state: SimState; releaseTiles: Map<number, Tile> } {
  state.marks[0] = { ...state.marks[0]!, laidTick: state.tick + 1 - state.config.markLifetimeTicks };
  let next = tick(state).state;
  expect(next.marks).toEqual([]);
  const releaseTiles = new Map(next.ants.filter((ant) => ant.claim !== undefined).map((ant) => [ant.id, tileOf(ant)]));
  next = tick(next).state;
  for (const id of releaseTiles.keys()) expect(byId(next, id).claim).toBeUndefined();
  return { state: next, releaseTiles };
}

describe("rules 27: a free seated soldier holds at its hold point", () => {
  it("a soldier hatched while seated takes the tile where it hatched and stays within 3 tiles of it", () => {
    const s = scene({ hatchIntervalTicks: 10 });
    for (const q of s.state.colonies[0].queens!) q.brood = "soldiers"; // Rules 27: her own brood.
    s.state.colonies[0].foodStore = s.state.config.castes!.soldierCost;
    let state = s.state;
    let hatched: Extract<SimEvent, { type: "hatch" }> | undefined;
    for (let t = 0; t < 100 && hatched === undefined; t++) {
      const out = tick(state);
      state = out.state;
      hatched = out.events.find((event): event is Extract<SimEvent, { type: "hatch" }> => event.type === "hatch");
    }
    expect(hatched).toMatchObject({ colony: 0, caste: "soldier" });
    const hatchTile = { tileX: hatched!.tileX, tileY: hatched!.tileY };
    expect(byId(state, hatched!.antId).holdPoint).toBeUndefined();
    for (let t = 0; t < 600; t++) {
      state = tick(state).state;
      const ant = byId(state, hatched!.antId);
      expect(ant.squad).toBeNull();
      expect(ant.claim).toBeUndefined();
      expect(ant.holdPoint).toEqual(hatchTile);
      expect(tileDistance(tileOf(ant), hatchTile)).toBeLessThanOrEqual(HOLD_FINE_TILES);
    }
  });

  it("a soldier hatched while an intruder is by its queen keeps the hatch tile through the fight, then holds there", () => {
    const s = scene({ hatchIntervalTicks: 10 });
    for (const q of s.state.colonies[0].queens!) q.brood = "soldiers"; // Rules 27: her own brood.
    s.state.colonies[0].foodStore = s.state.config.castes!.soldierCost;
    // Within 3 tiles of the queen, so a free seated ant there chases it; pinned so it neither leaves nor closes in.
    const spot = { tileX: s.queen.tileX + 5, tileY: s.queen.tileY };
    const enemy = addAnt(s.state, 1, spot.tileX, spot.tileY, { caste: "soldier", role: "fighter" }).id;
    const pin = (state: SimState): SimState => {
      const ant = byId(state, enemy);
      ant.x = (spot.tileX + 0.5) * SUB;
      ant.y = (spot.tileY + 0.5) * SUB;
      return state;
    };
    let state = s.state;
    let hatched: Extract<SimEvent, { type: "hatch" }> | undefined;
    for (let t = 0; t < 100 && hatched === undefined; t++) {
      const out = tick(pin(state));
      state = out.state;
      hatched = out.events.find((event): event is Extract<SimEvent, { type: "hatch" }> => event.type === "hatch");
    }
    expect(hatched).toMatchObject({ colony: 0, caste: "soldier" });
    const hatchTile = { tileX: hatched!.tileX, tileY: hatched!.tileY };
    const start = { x: byId(state, hatched!.antId).x, y: byId(state, hatched!.antId).y };
    for (let t = 0; t < 30; t++) {
      state = tick(pin(state)).state;
      expect(byId(state, hatched!.antId).holdPoint).toEqual(hatchTile);
    }
    const fought = byId(state, hatched!.antId);
    expect(Math.hypot(fought.x - start.x, fought.y - start.y)).toBeGreaterThan(SUB);
    state.ants = state.ants.filter((ant) => ant.id !== enemy);
    for (let t = 0; t < 300; t++) {
      state = tick(state).state;
      const ant = byId(state, hatched!.antId);
      expect(ant.holdPoint).toEqual(hatchTile);
      expect(tileDistance(tileOf(ant), hatchTile)).toBeLessThanOrEqual(HOLD_FINE_TILES);
    }
  });

  it("a soldier released by an expiring count mark holds where it was released and does not walk back to its queen", () => {
    const s = claimedAtMark();
    let { state, releaseTiles } = expireAndRelease(s.state);
    expect([...releaseTiles.keys()].sort()).toEqual([...s.soldiers].sort());
    for (const id of s.soldiers) expect(byId(state, id).holdPoint).toEqual(releaseTiles.get(id));
    for (let t = 0; t < 600; t++) {
      state = tick(state).state;
      for (const id of s.soldiers) {
        const ant = byId(state, id), hold = releaseTiles.get(id)!;
        expect(ant.claim).toBeUndefined();
        expect(ant.holdPoint).toEqual(hold);
        expect(tileDistance(tileOf(ant), hold)).toBeLessThanOrEqual(HOLD_FINE_TILES);
        // No walk home: it never comes within 3 tiles of where its queen's defence starts.
        expect(tileDistance(tileOf(ant), s.queen)).toBeGreaterThan(tileDistance(hold, s.queen) - HOLD_FINE_TILES - 1);
      }
    }
  });

  it("a soldier moved off its hold point walks back to within 3 tiles of it, not to its queen", () => {
    const s = claimedAtMark();
    let { state, releaseTiles } = expireAndRelease(s.state);
    const id = s.soldiers[0]!, hold = releaseTiles.get(id)!;
    const ant = byId(state, id);
    // 16 fine tiles farther from the queen than its hold point: outside both the hold radius and the queen's.
    ant.x = (hold.tileX + 16 + 0.5) * SUB;
    ant.y = (hold.tileY + 0.5) * SUB;
    expect(tileDistance(tileOf(ant), hold)).toBeGreaterThan(HOLD_FINE_TILES);
    for (let t = 0; t < 200; t++) state = tick(state).state;
    const back = byId(state, id);
    expect(back.holdPoint).toEqual(hold);
    expect(tileDistance(tileOf(back), hold)).toBeLessThanOrEqual(HOLD_FINE_TILES);
    expect(tileDistance(tileOf(back), s.queen)).toBeGreaterThan(20);
  });

  it("shrinking a mark's count releases the farthest soldiers first, as captured, each holding where it was released", () => {
    const shrink = () => {
      const s = claimedAtMark();
      const { state } = tick(s.state, [{ type: "count_mark", agentId: "a", tileX: s.mark.tileX, tileY: s.mark.tileY, verb: "GATHER", count: 1, caste: "soldier" }]);
      return { s, before: s.state, state };
    };
    const now = shrink();
    const released = (state: SimState, ids: readonly number[]) => ids.filter((id) => byId(state, id).claim === undefined).sort();
    const ids = released(now.state, now.s.soldiers);
    expect(ids).toHaveLength(2);
    // Farthest from the mark first, the higher id on equal distance (the mark lifecycle and FORAGE loop).
    const centre = { x: (now.s.mark.tileX + 0.5) * SUB, y: (now.s.mark.tileY + 0.5) * SUB };
    const order = [...now.s.soldiers].map((id) => byId(now.before, id))
      .sort((a, b) => Math.hypot(b.x - centre.x, b.y - centre.y) - Math.hypot(a.x - centre.x, a.y - centre.y) || b.id - a.id);
    expect(ids).toEqual(order.slice(0, 2).map((ant) => ant.id).sort());
    for (const id of ids) expect(byId(now.state, id).holdPoint).toEqual(tileOf(byId(now.before, id)));
    const kept = now.s.soldiers.find((id) => !ids.includes(id))!;
    expect(byId(now.state, kept).claim).toBe(now.s.markId);
    expect(byId(now.state, kept).holdPoint).toBeUndefined();
  });
});

describe("releaseClaim gates the hold point on a seated colony", () => {
  it("sets it only for a soldier of a seated colony", () => {
    const cases = [
      { idle: false, caste: "soldier" as const, hold: true },
      { idle: true, caste: "soldier" as const, hold: false },
      { idle: false, caste: "worker" as const, hold: false },
    ];
    for (const c of cases) {
      const s = scene();
      s.agent.idle = c.idle;
      const ant = addAnt(s.state, 0, s.queen.tileX + 25, s.queen.tileY + 3, { caste: c.caste, claim: 1 });
      releaseClaim(s.state, ant);
      expect(ant.claim).toBeUndefined();
      expect(ant.holdPoint).toEqual(c.hold ? { tileX: s.queen.tileX + 25, tileY: s.queen.tileY + 3 } : undefined);
    }
  });
});

describe("rules 27: a soldier freed other than by hatching or mark release holds where it is then", () => {
  it("a seat activating fixes the hold point where the soldier stands, and a lapse clears it", () => {
    const s = scene();
    s.agent.idle = true;
    const id = addAnt(s.state, 0, s.queen.tileX + 30, s.queen.tileY, { caste: "soldier", role: "fighter" }).id;
    let state = tick(s.state).state;
    expect(byId(state, id).holdPoint).toBeUndefined();
    state.agents[0]!.idle = false;
    const seatedAt = tileOf(byId(state, id));
    state = tick(state).state;
    expect(byId(state, id).holdPoint).toEqual(seatedAt);
    for (let t = 0; t < 300; t++) state = tick(state).state;
    expect(tileDistance(tileOf(byId(state, id)), seatedAt)).toBeLessThanOrEqual(HOLD_FINE_TILES);
    expect(tileDistance(tileOf(byId(state, id)), s.queen)).toBeGreaterThan(20);
    state.agents[0]!.idle = true;
    state = tick(state).state;
    expect(byId(state, id).holdPoint).toBeUndefined();
  });

  it("a soldier in a squad has no hold point, and takes its tile when it leaves the squad", () => {
    const s = scene();
    const ant = addAnt(s.state, 0, s.queen.tileX + 30, s.queen.tileY, { caste: "soldier", role: "fighter" });
    let state = tick(s.state).state;
    expect(byId(state, ant.id).holdPoint).toEqual({ tileX: s.queen.tileX + 30, tileY: s.queen.tileY });
    byId(state, ant.id).squad = "a";
    state.agents[0]!.squad.push(ant.id);
    state = tick(state).state;
    expect(byId(state, ant.id).holdPoint).toBeUndefined();
    const drafted = byId(state, ant.id);
    drafted.x = (s.queen.tileX + 40 + 0.5) * SUB;
    // Released from the squad (trimSquads may already have done so this tick).
    drafted.squad = null;
    state.agents[0]!.squad = [];
    state = tick(state).state;
    expect(byId(state, ant.id).holdPoint).toEqual({ tileX: s.queen.tileX + 40, tileY: s.queen.tileY });
  });
});

