import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, speedPerTick, SUB } from "../../src/sim/config.js";
import { direction, scaleTo, UNIT, velocity } from "../../src/sim/geometry.js";
import { buildGrid, createMatch, hasAdjacentEnemy, mirrorTileX, mirrorX, nestTile, tileIndex } from "../../src/sim/map.js";
import { updateOverrun, updateTerritory } from "../../src/sim/territory.js";
import { addAnt, antById, emptyMatch, houseOnlyMatch, ownerAt, run, send, squadOf } from "./fixtures.js";

beforeAll(() => {
  houseOnlyMatch();
}, 60_000);

describe("colonies, hatching and the cap", () => {
  it("starts each colony with 30 ants", () => {
    const state = createMatch(1);
    expect(state.ants.filter((a) => a.colony === 0)).toHaveLength(30);
    expect(state.ants.filter((a) => a.colony === 1)).toHaveLength(30);
  });

  it("hatches one worker per 3 food, at most one every second", () => {
    // Isolate hatching: no patch regrowth/foraging income during this scenario.
    const state = emptyMatch(0, { ...DEFAULT_CONFIG, foodRegrowTicks: 100_000 });
    state.food.fill(0);
    state.colonies[0].foodStore = 10;
    const { state: after, events } = run(state, 80);
    const hatches = events.filter((e) => e.type === "hatch" && e.colony === 0).map((e) => e.tick);
    expect(hatches).toEqual([0, 10, 20]);
    expect(after.colonies[0].foodStore).toBe(1);
    expect(after.ants.filter((a) => a.colony === 0)).toHaveLength(3);
  });

  it("never hatches above the cap of 512", () => {
    const state = emptyMatch();
    for (let i = 0; i < 512; i += 1) addAnt(state, 0, 1 + (i % 20), 1 + Math.floor(i / 20));
    state.colonies[0].foodStore = 30;
    const { state: after, events } = run(state, 60);
    expect(events.some((e) => e.type === "hatch" && e.colony === 0)).toBe(false);
    expect(after.ants.filter((a) => a.colony === 0)).toHaveLength(512);
  });

  it("gives a losing colony no extra ants: hatches only ever come from delivered food", () => {
    const state = emptyMatch();
    state.food.fill(0);
    addAnt(state, 1, 62, 1);
    state.colonies[0].foodStore = 6;
    const { events } = run(state, 40);
    expect(events.filter((e) => e.type === "hatch" && e.colony === 0)).toHaveLength(2);
    expect(events.filter((e) => e.type === "hatch" && e.colony === 1)).toHaveLength(0);

    const { snapshots } = houseOnlyMatch();
    for (const snap of snapshots.values()) {
      for (const c of [0, 1] as const) {
        expect(snap.stats.hatched[c] * DEFAULT_CONFIG.hatchCost).toBeLessThanOrEqual(snap.stats.delivered[c]);
      }
    }
  });
});

describe("the map", () => {
  const state = createMatch(3);
  const { mapWidth: w, mapHeight: h } = state.config;

  // Every match plays at grid scale 2: reference lengths double, so the 64 by 48 reference
  // board is 128 by 96 fine tiles.
  it("is 64 by 48 tiles", () => {
    expect([w, h]).toEqual([64 * 2, 48 * 2]);
    expect(state.food).toHaveLength(64 * 2 * 48 * 2);
  });

  it("mirrors food, nests and starting ants between the two nests", () => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        expect(state.food[tileIndex(state.config, x, y)]).toBe(state.food[tileIndex(state.config, mirrorTileX(state.config, x), y)]);
      }
    }
    expect(state.colonies[1].queenX).toBe(mirrorX(state.config, state.colonies[0].queenX));
    expect(state.colonies[1].queenY).toBe(state.colonies[0].queenY);
    const left = state.ants.filter((a) => a.colony === 0).map((a) => `${mirrorX(state.config, a.x)},${a.y}`).sort();
    const right = state.ants.filter((a) => a.colony === 1).map((a) => `${a.x},${a.y}`).sort();
    expect(left).toEqual(right);
  });

  it("puts the nests about 48 tiles apart", () => {
    const apart = nestTile(state.config, 1).tx - nestTile(state.config, 0).tx;
    expect(apart).toBeGreaterThanOrEqual(46 * 2);
    expect(apart).toBeLessThanOrEqual(50 * 2);
  });

  it("puts the richest food in the contested centre", () => {
    const band = (x0: number, x1: number): number => {
      let sum = 0;
      for (let y = 0; y < h; y += 1) for (let x = x0; x <= x1; x += 1) sum += state.food[tileIndex(state.config, x, y)] ?? 0;
      return sum;
    };
    // Reference columns 24-39, 0-15 and 48-63 are fine columns 48-79, 0-31 and 96-127.
    const centre = band(48, 79);
    expect(centre).toBeGreaterThan(band(0, 31));
    expect(centre).toBeGreaterThan(band(96, 127));
    const richest = Math.max(...state.food);
    const richestTile = state.food.indexOf(richest) % w;
    expect(richestTile).toBeGreaterThanOrEqual(48);
    expect(richestTile).toBeLessThanOrEqual(79);
  });

  it("leaves 1 food where an ant dies", () => {
    const s = emptyMatch(600);
    addAnt(s, 0, 40, 40, { hp: 50000 });
    const victim = addAnt(s, 1, 41, 40, { hp: 100 });
    const before = s.food[tileIndex(s.config, 41, 40)] ?? 0;
    const { state: after, events } = run(s, 1);
    expect(events).toContainEqual(expect.objectContaining({ type: "death", antId: victim.id }));
    expect(after.food[tileIndex(s.config, 41, 40)]).toBe(before + 1);
  });
});

describe("sub-tile movement", () => {
  it("keeps positions as integers in sub-tile units", () => {
    for (const snap of houseOnlyMatch().snapshots.values()) {
      for (const ant of snap.ants) {
        expect(Number.isInteger(ant.x) && Number.isInteger(ant.y)).toBe(true);
      }
    }
    expect(SUB).toBe(1000);
  });

  it("moves a steadily walking ant every tick, with per-tick distance varying by at most one unit", () => {
    const config = { ...DEFAULT_CONFIG, guardCount: 0, fighterShareStartPermille: 1000, fighterShareEndPermille: 1000 };
    const state = emptyMatch(0, config);
    const walker = addAnt(state, 0, 4, 40, { role: "fighter" });
    let current = state;
    const steps: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const before = antById(current, walker.id)!;
      current = run(current, 1).state;
      const after = antById(current, walker.id)!;
      expect(after.x !== before.x || after.y !== before.y).toBe(true);
      steps.push(Math.hypot(after.x - before.x, after.y - before.y));
    }
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThanOrEqual(1);
    // It walks diagonally, so the check covers more than an axis-aligned step.
    const last = antById(current, walker.id)!;
    expect(last.vx).not.toBe(0);
    expect(last.vy).not.toBe(0);
  });

  it("normalises every direction to its length within half a unit, keeping its heading, down to the shortest vectors", () => {
    // Every direction in the sim is normalised by scaleTo: through direction() (house bot, forage, go to, attack,
    // marks toward and AVOID) at UNIT, and through velocity() (house, blended, held and squad headings) at the speed.
    // Raw direction() inputs and blends can be as short as one sub-tile unit, so every vector up to 40 units is swept,
    // plus every heading at map-scale lengths.
    const check = (dx: number, dy: number, length: number): void => {
      const v = scaleTo(dx, dy, length);
      const len = Math.hypot(v.x, v.y);
      expect(Math.abs(len - length)).toBeLessThan(0.5);
      // Perpendicular deviation from the true heading stays within one unit.
      expect(Math.abs(dx * v.y - dy * v.x) / Math.hypot(dx, dy)).toBeLessThanOrEqual(1);
      expect(dx * v.x + dy * v.y).toBeGreaterThan(0);
    };
    const speed = speedPerTick(DEFAULT_CONFIG);
    for (const length of [speed, UNIT]) {
      for (let dx = -40; dx <= 40; dx += 1) for (let dy = -40; dy <= 40; dy += 1) if (dx !== 0 || dy !== 0) check(dx, dy, length);
      for (let deg = 0; deg < 360; deg += 1) {
        const rad = (deg * Math.PI) / 180;
        for (const r of [301, 4000, 64000]) check(Math.round(Math.cos(rad) * r), Math.round(Math.sin(rad) * r), length);
      }
    }
    expect(scaleTo(0, 0, UNIT)).toEqual({ x: 0, y: 0 });
  });

  it("keeps a short blended heading when it becomes a step (seed 5 review case)", () => {
    expect(velocity({ x: -2, y: -2 }, speedPerTick(DEFAULT_CONFIG))).toEqual({ x: -142, y: -141 }); // was (0, -200), 45° off
    expect(direction(1, 1)).toEqual({ x: 707, y: 707 });
  });

  it("varies a squad's go-to step by at most one unit as its heading changes", () => {
    let s = send(createMatch(5), [{ type: "join", agentId: "a" }]).state;
    s = send(s, [{ type: "order", agentId: "a", order: { kind: "go_to", tileX: 10, tileY: 32 } }]).state;
    const ids = squadOf(s, "a").map((ant) => ant.id);
    const steps: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const before = s;
      s = run(s, 1).state;
      for (const id of ids) {
        const from = antById(before, id)!;
        const to = antById(s, id)!;
        const moved = Math.hypot(to.x - from.x, to.y - from.y);
        if (moved > 0) steps.push(moved); // walking, not arrived
      }
    }
    expect(steps.length).toBeGreaterThan(200);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThanOrEqual(1);
  });

  it("applies tile rules to the tile a position falls in", () => {
    const state = emptyMatch(600);
    const a = addAnt(state, 0, 0, 10);
    const b = addAnt(state, 1, 0, 10);
    // Grid scale 2: combat reach is one reference tile, two fine tiles, counted by containing fine tile.
    // 2.001 fine tiles apart but three apart by containing tile: not adjacent.
    a.x = 1999;
    b.x = 4000;
    expect(hasAdjacentEnemy(state, buildGrid(state), a)).toBe(false);
    // 2.999 fine tiles apart but two apart by containing tile: adjacent.
    a.x = 1000;
    b.x = 3999;
    expect(hasAdjacentEnemy(state, buildGrid(state), a)).toBe(true);

    // Territory claims the containing tile.
    const t = emptyMatch(0);
    const c = addAnt(t, 0, 5, 5);
    c.x = 5999;
    updateTerritory(t, buildGrid(t), 0);
    expect(ownerAt(t, 5, 5)).toBe(0);
    expect(ownerAt(t, 6, 5)).toBe(-1);

    // The overrun radius counts by containing tile: 2 reference tiles (4 fine tiles) from the queen's tile
    // counts, 5 fine tiles does not.
    const o = emptyMatch(600);
    const queenTile = Math.floor(o.colonies[0].queenX / SUB);
    const near = addAnt(o, 1, queenTile + 4, Math.floor(o.colonies[0].queenY / SUB));
    near.x = (queenTile + 5) * SUB - 1;
    updateOverrun(o, buildGrid(o), DEFAULT_CONFIG.overrunGraceTicks, []);
    expect(o.colonies[0].overrunTicks).toBe(1);
    near.x = (queenTile + 5) * SUB;
    updateOverrun(o, buildGrid(o), DEFAULT_CONFIG.overrunGraceTicks + 1, []);
    expect(o.colonies[0].overrunTicks).toBe(0);
  });
});

describe("stable ant ids", () => {
  it("never reuses an id, including for ants hatched after deaths, and carries it on ants and events", () => {
    const { initial, snapshots, events } = houseOnlyMatch();
    const seen = new Set(initial.ants.map((a) => a.id));
    expect(seen.size).toBe(initial.ants.length);
    const dead = new Set<number>();
    let maxId = Math.max(...seen);
    for (const event of events) {
      if (event.type === "death") {
        expect(seen.has(event.antId)).toBe(true);
        dead.add(event.antId);
      }
      if (event.type === "hatch") {
        expect(seen.has(event.antId)).toBe(false);
        expect(event.antId).toBeGreaterThan(maxId);
        maxId = event.antId;
        seen.add(event.antId);
      }
      if (event.type === "fight") {
        expect(seen.has(event.antId) && seen.has(event.targetId)).toBe(true);
      }
    }
    expect(dead.size).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "hatch" && e.tick > Math.min(...events.filter((d) => d.type === "death").map((d) => d.tick)))).toBe(true);
    for (const snap of snapshots.values()) {
      const ids = snap.ants.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
      const deadBefore = new Set(events.filter((e) => e.type === "death" && e.tick < snap.tick).map((e) => (e.type === "death" ? e.antId : -1)));
      for (const id of ids) expect(deadBefore.has(id)).toBe(false);
    }
  });
});
