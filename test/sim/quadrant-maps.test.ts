/** The Quadrants map pool, Four Coves, Crossroads and Strait in that order: the Quadrants rotation serves exactly these,
 * no two-colony rotation can draw one, each streams, records and replays its native water exactly at its own board
 * size, and each passes the design's correctness checks on the native board its match plays (its own reference board at
 * grid scale 2, with its water in native tiles) over seeds 1-100, default nests, no picks, in the four-colony test config
 * (rulesConfig("redesign") through newMatchConfig). */
import { beforeAll, describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.js";
import { SpectatorRecorder } from "../../src/live/model.js";
import { MAPS, RULES_NAMES, rulesConfig, withoutHousePausedMaps, type MapDefinition, type SimConfig, type WaterRect } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { createMapShapes, houseMatchMaps, newMatchMaps, quadrantMatchMaps, retiredSevenMapRotation, retiredSixMapHouseRotation } from "../../src/sim/mapShapes.js";
import { CROSSROADS, FOUR_COVES, QUADRANT_MAPS, STRAIT, quadrantMapConfig } from "../../src/sim/quadrantMaps.js";
import { generateQuadrantBoard, validateQuadrantMap, type QuadrantBoard } from "../../src/sim/quadrantMap.js";
import { SCALE2_MAPS } from "../../src/sim/scale2Maps.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile, selectMap } from "../../src/sim/terrain.js";
import { tuningMapConfig } from "../../src/sim/tuningMap.js";
import type { SimInput, SimState } from "../../src/sim/types.js";
import { takeView } from "../../src/sim/view.js";

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const SCALE = 2;
const POOL_IDS = ["four-coves", "crossroads", "strait"];
const JOINS: SimInput[] = [0, 1, 2, 3].map(seat => ({ type: "join", agentId: `seat-${seat}`, modelLabel: `model-${seat}` }));

type Edge = "left" | "right" | "top" | "bottom";
/** A named route, measured on the native board as vertex-disjoint 4-connected land paths inside its corridor from its
 * source edges to its sink tiles, with that seed's rocks. Corridor and sink are given in reference tiles for the top-left
 * instance and measured doubled to native tiles; stated is the native width. Every mirror image is measured. */
interface Route { readonly name: string; readonly stated: number; readonly corridor: WaterRect; readonly source: readonly Edge[]; readonly sink: WaterRect }
const r = (x: number, y: number, width: number, height: number): WaterRect => ({ x, y, width, height });

const CASES: readonly { readonly map: MapDefinition; readonly width: number; readonly height: number; readonly routes: readonly Route[] }[] = [
  { map: FOUR_COVES, width: 64, height: 48, routes: [
    { name: "cove north exit", stated: 8, corridor: r(18, 0, 5, 8), source: ["left"], sink: r(22, 0, 1, 8) },
    { name: "cove side exit", stated: 8, corridor: r(0, 12, 8, 5), source: ["top"], sink: r(0, 16, 8, 1) },
    { name: "north border", stated: 30, corridor: r(30, 0, 4, 18), source: ["left"], sink: r(33, 0, 1, 18) },
    { name: "west border", stated: 36, corridor: r(0, 22, 24, 4), source: ["top"], sink: r(0, 25, 24, 1) },
  ] },
  { map: CROSSROADS, width: 96, height: 64, routes: [
    { name: "north and south fords", stated: 10, corridor: r(44, 8, 8, 8), source: ["left"], sink: r(51, 8, 1, 8) },
    { name: "west and east fords", stated: 12, corridor: r(12, 28, 8, 8), source: ["top"], sink: r(12, 35, 8, 1) },
    { name: "plaza mouth", stated: 14, corridor: r(30, 17, 18, 15), source: ["left", "top"], sink: r(38, 25, 10, 7) },
  ] },
  { map: STRAIT, width: 112, height: 64, routes: [
    { name: "edge route", stated: 10, corridor: r(51, 0, 10, 8), source: ["left"], sink: r(60, 0, 1, 8) },
    { name: "inner route", stated: 14, corridor: r(51, 14, 10, 10), source: ["left"], sink: r(60, 14, 1, 10) },
    { name: "plaza crossing", stated: 40, corridor: r(46, 27, 20, 10), source: ["top"], sink: r(46, 36, 20, 1) },
    { name: "plaza mouth", stated: 21, corridor: r(36, 14, 20, 18), source: ["left", "top"], sink: r(46, 24, 10, 8) },
  ] },
];

const key = (q: WaterRect) => `${q.x},${q.y},${q.width},${q.height}`;
const mirrorX = (w: number, q: WaterRect): WaterRect => ({ ...q, x: w - q.x - q.width });
const mirrorY = (h: number, q: WaterRect): WaterRect => ({ ...q, y: h - q.y - q.height });
const images = (w: number, h: number, q: WaterRect) => [q, mirrorX(w, q), mirrorY(h, q), mirrorX(w, mirrorY(h, q))];
const rectTiles = (q: WaterRect, w: number): number[] => {
  const tiles: number[] = [];
  for (let y = q.y; y < q.y + q.height; y++) for (let x = q.x; x < q.x + q.width; x++) tiles.push(y * w + x);
  return tiles;
};

const LAND = 0, WATER = 1, ROCK = 2;
const native = (q: WaterRect): WaterRect => ({ x: q.x * SCALE, y: q.y * SCALE, width: q.width * SCALE, height: q.height * SCALE });
/** Native grid of a match at tick 0: land, water or rock per tile, from its terrain. */
function grid(s: SimState): Uint8Array {
  const w = s.config.mapWidth, g = new Uint8Array(w * s.config.mapHeight);
  for (const q of s.terrain!.water) for (const t of rectTiles(q, w)) g[t] = WATER;
  for (const k of s.terrain!.rocks!) for (const t of rectTiles(k, w)) g[t] = ROCK;
  return g;
}
/** 4-connected land distances from the starts; -1 where unreachable. */
function landDistances(g: Uint8Array, w: number, h: number, starts: readonly number[]): Int32Array {
  const d = new Int32Array(w * h).fill(-1), queue = new Int32Array(w * h);
  let read = 0, write = 0;
  for (const s of starts) if (g[s] === LAND && d[s] < 0) { d[s] = 0; queue[write++] = s; }
  while (read < write) {
    const at = queue[read++], x = at % w, y = Math.floor(at / w);
    for (const n of [x > 0 ? at - 1 : -1, x + 1 < w ? at + 1 : -1, y > 0 ? at - w : -1, y + 1 < h ? at + w : -1]) {
      if (n >= 0 && g[n] === LAND && d[n] < 0) { d[n] = d[at] + 1; queue[write++] = n; }
    }
  }
  return d;
}
/** Sizes of the land regions, largest first. */
function landRegions(g: Uint8Array, w: number, h: number): number[] {
  const seen = new Uint8Array(w * h), sizes: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (g[i] !== LAND || seen[i]) continue;
    const d = landDistances(g, w, h, [i]);
    let n = 0;
    for (let j = 0; j < w * h; j++) if (d[j] >= 0) { seen[j] = 1; n++; }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}
/** Vertex-disjoint 4-connected land paths inside the corridor from the source tiles to the sink tiles (unit-capacity
 * max flow over split tiles). */
function routeWidth(g: Uint8Array, w: number, c: WaterRect, source: ReadonlySet<number>, sink: ReadonlySet<number>): number {
  const cells: number[] = [], index = new Map<number, number>();
  for (const t of rectTiles(c, w)) if (g[t] === LAND) { index.set(t, cells.length); cells.push(t); }
  const n = cells.length, nodes = 2 * n + 2, S = 2 * n, T = 2 * n + 1;
  const head = new Int32Array(nodes).fill(-1), to: number[] = [], cap: number[] = [], next: number[] = [];
  const add = (u: number, v: number) => {
    to.push(v); cap.push(1); next.push(head[u]); head[u] = to.length - 1;
    to.push(u); cap.push(0); next.push(head[v]); head[v] = to.length - 1;
  };
  const inside = (x: number, y: number) => x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height;
  cells.forEach((t, k) => {
    add(2 * k, 2 * k + 1);
    const x = t % w, y = Math.floor(t / w);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      const j = index.get(ny * w + nx);
      if (inside(nx, ny) && j !== undefined) add(2 * k + 1, 2 * j);
    }
    if (source.has(t)) add(S, 2 * k);
    if (sink.has(t)) add(2 * k + 1, T);
  });
  let flow = 0;
  for (;;) {
    const prev = new Int32Array(nodes).fill(-1);
    prev[S] = -2;
    const queue = [S];
    for (let i = 0; i < queue.length && prev[T] === -1; i++) {
      for (let e = head[queue[i]]; e >= 0; e = next[e]) if (cap[e] > 0 && prev[to[e]] === -1) { prev[to[e]] = e; queue.push(to[e]); }
    }
    if (prev[T] === -1) return flow;
    for (let v = T; v !== S; v = to[prev[v] ^ 1]) { cap[prev[v]] -= 1; cap[prev[v] ^ 1] += 1; }
    flow++;
  }
}
function edgeTiles(c: WaterRect, edges: readonly Edge[], w: number): Set<number> {
  const tiles = new Set<number>();
  for (let y = c.y; y < c.y + c.height; y++) for (let x = c.x; x < c.x + c.width; x++) {
    if ((edges.includes("left") && x === c.x) || (edges.includes("right") && x === c.x + c.width - 1)
      || (edges.includes("top") && y === c.y) || (edges.includes("bottom") && y === c.y + c.height - 1)) tiles.add(y * w + x);
  }
  return tiles;
}
/** The distinct mirror images of a top-left route: corridor, sink and source edges flip with each mirror. */
function routeImages(w: number, h: number, route: Route) {
  const flipX = (e: Edge): Edge => (e === "left" ? "right" : e === "right" ? "left" : e);
  const flipY = (e: Edge): Edge => (e === "top" ? "bottom" : e === "bottom" ? "top" : e);
  const all = [
    { corridor: route.corridor, sink: route.sink, source: route.source },
    { corridor: mirrorX(w, route.corridor), sink: mirrorX(w, route.sink), source: route.source.map(flipX) },
    { corridor: mirrorY(h, route.corridor), sink: mirrorY(h, route.sink), source: route.source.map(flipY) },
    { corridor: mirrorX(w, mirrorY(h, route.corridor)), sink: mirrorX(w, mirrorY(h, route.sink)), source: route.source.map(e => flipX(flipY(e))) },
  ];
  return all.filter((im, i) => all.findIndex(o => key(o.corridor) + key(o.sink) === key(im.corridor) + key(im.sink)) === i);
}

const ids = (maps: readonly MapDefinition[]) => maps.map(map => map.id);
const centreLayout = (b: QuadrantBoard) => b.centreFood.map(p => `${p.tileX},${p.tileY},${p.radius},${p.perTile}`).join(";");

describe("the Quadrants pool", () => {
  it("lists the three pool maps by id, in pool order, with their own board sizes and no ant cap, match length, board or grid scale of their own", () => {
    expect(QUADRANT_MAPS.map(m => [m.id, m.quadrant?.referenceWidth, m.quadrant?.referenceHeight]))
      .toEqual([["four-coves", 64, 48], ["crossroads", 96, 64], ["strait", 112, 64]]);
    for (const map of QUADRANT_MAPS) {
      expect([map.colonyCap, map.matchTicks, map.board, map.gridScale]).toEqual([undefined, undefined, undefined, undefined]);
      expect(map.quadrant!.nativeWater, `${map.id} holds its water in native tiles`).toBe(true);
    }
  });

  it.each(CASES.map(c => [c.map.id, c.width, c.height, c.map] as const))(
    "%s: its explicit id yields its definition alone in a four-colony config, and a match at grid scale 2 takes its %ix%i board (seed 1)",
    (id, width, height, map) => {
      const config = quadrantMapConfig(id);
      expect(config.terrain!.maps).toEqual([map]);
      expect(config.gridScale).toBe(SCALE);
      const match = createMatch(1, config);
      expect([match.config.mapWidth, match.config.mapHeight]).toEqual([width * SCALE, height * SCALE]);
      expect(new Set(match.ants.map(a => a.colony))).toEqual(new Set([0, 1, 2, 3]));
    });

  it("refuses an id that names no pool map", () => {
    expect(() => quadrantMapConfig("open-field")).toThrow(RangeError);
    expect(() => quadrantMapConfig("Four Coves")).toThrow(RangeError);
  });

  it("is the Quadrants rotation: quadrantMatchMaps() serves Four Coves, Crossroads and Strait in that order", () => {
    expect(ids(quadrantMatchMaps())).toEqual(POOL_IDS);
    expect(quadrantMatchMaps()).toEqual([FOUR_COVES, CROSSROADS, STRAIT]);
  });

  it("seeds 1-100 on the shipped rotation: every match plays one of the three at its own board size, with the default 512-ant cap and match length", () => {
    const base = newMatchConfig(rulesConfig("redesign"));
    const config: SimConfig = { ...base, terrain: { ...base.terrain!, maps: quadrantMatchMaps() } };
    const sizes: Record<string, readonly [number, number]> = { "four-coves": [128, 96], "crossroads": [192, 128], "strait": [224, 128] };
    const drawn = new Set<string>();
    for (const seed of SEEDS) {
      const id = selectMap(seed, config.terrain!).id;
      drawn.add(id);
      const match = createMatch(seed, config);
      expect([match.terrain!.mapId, match.config.mapWidth, match.config.mapHeight], `seed ${seed}`).toEqual([id, ...sizes[id]!]);
      expect([match.config.colonyCap, match.config.matchTicks], `seed ${seed}`).toEqual([512, base.matchTicks]);
    }
    expect([...drawn].sort()).toEqual([...POOL_IDS].sort());
  });
});

describe("no two-colony rotation draws a pool map", () => {
  const ROTATIONS: readonly (readonly [string, readonly MapDefinition[]])[] = [
    ["recorded three-map MAPS", MAPS], ["createMapShapes()", createMapShapes()], ["retiredSevenMapRotation()", retiredSevenMapRotation()],
    ["newMatchMaps()", newMatchMaps()], ["houseMatchMaps()", houseMatchMaps()], ["retiredSixMapHouseRotation()", retiredSixMapHouseRotation()],
    ["SCALE2_MAPS", SCALE2_MAPS],
    ...[undefined, ...RULES_NAMES].flatMap(name => {
      const config = newMatchConfig(rulesConfig(name));
      return [[`newMatchConfig(rulesConfig(${name ?? ""}))`, config.terrain!.maps],
        [`withoutHousePausedMaps(newMatchConfig(rulesConfig(${name ?? ""})))`, withoutHousePausedMaps(config).terrain!.maps]] as const;
    }),
    ["tuningMapConfig(500)", tuningMapConfig(500).terrain!.maps],
  ];

  it.each(ROTATIONS)("%s holds no pool map", (_, maps) => {
    expect(ids(maps).filter(id => POOL_IDS.includes(id))).toEqual([]);
  });

  it.each(POOL_IDS)("a two-colony rotation with %s added is refused", id => {
    const base = newMatchConfig(rulesConfig("redesign"));
    const map = QUADRANT_MAPS.find(m => m.id === id)!;
    const mixed: SimConfig = { ...base, terrain: { ...base.terrain!, maps: [...base.terrain!.maps, map] } };
    expect(() => newMatchConfig(mixed)).toThrow(`${id}: a quadrant map plays only in a four-colony rotation`);
  });
});

for (const { map, width: W, height: H, routes } of CASES) {
  const q = map.quadrant!, NW = W * SCALE, NH = H * SCALE;
  // Centre food layouts are counted here so the count can be reported in the test name.
  const layouts = new Set(SEEDS.map(seed => centreLayout(generateQuadrantBoard(map, seed))));

  describe(`${map.name} (${map.id}), ${W}x${H} reference board played as ${NW}x${NH} native tiles, native water, grid scale 2, seeds 1-100, default nests, no picks, rulesConfig("redesign") through newMatchConfig`, () => {
    const boards = new Map<number, QuadrantBoard>(), grids = new Map<number, Uint8Array>(), matches = new Map<number, SimState>();
    beforeAll(() => {
      for (const seed of SEEDS) {
        const b = generateQuadrantBoard(map, seed), s = createMatch(seed, quadrantMapConfig(map.id));
        boards.set(seed, b); matches.set(seed, s); grids.set(seed, grid(s));
      }
    });

    it("validates", () => {
      expect(() => validateQuadrantMap(map)).not.toThrow();
    });

    it("generates its board size with native water, covered water, rocks, quadrant food, nests and start areas mirrored four ways", () => {
      for (const seed of SEEDS) {
        const b = boards.get(seed)!;
        expect([b.width, b.height], `seed ${seed}`).toEqual([W, H]);
        expect(b.nativeWater!.filter((_, i) => i % 4 === 0).map(key), `seed ${seed} native water`).toEqual(map.water.map(key));
        for (const [what, list, w, h] of [["native water", b.nativeWater!, NW, NH], ["covered water", b.water, W, H], ["rocks", b.rocks, W, H],
          ["start areas", b.startAreas, W, H]] as const) {
          expect(list.length % 4, `seed ${seed} ${what}`).toBe(0);
          for (let i = 0; i < list.length; i += 4) {
            expect(list.slice(i, i + 4).map(key), `seed ${seed} ${what} ${i}`).toEqual(images(w, h, list[i]).map(key));
          }
        }
        const n = b.nests[0];
        expect(b.nests.map(t => [t.tx, t.ty]), `seed ${seed} nests`)
          .toEqual([[n.tx, n.ty], [W - 1 - n.tx, n.ty], [n.tx, H - 1 - n.ty], [W - 1 - n.tx, H - 1 - n.ty]]);
        expect([n.tx, n.ty], `seed ${seed} default nest`).toEqual([q.nestTileX, q.nestTileY]);
        expect(b.quadrantFood.length, `seed ${seed} quadrant food`).toBe(q.foodPatches.length * 4);
        for (let i = 0; i < b.quadrantFood.length; i += 4) {
          const p = b.quadrantFood[i];
          expect(b.quadrantFood.slice(i, i + 4), `seed ${seed} food ${i}`).toEqual([
            p, { ...p, tileX: W - 1 - p.tileX }, { ...p, tileY: H - 1 - p.tileY }, { ...p, tileX: W - 1 - p.tileX, tileY: H - 1 - p.tileY }]);
        }
      }
    });

    it("at tick 0 lays the native water exactly and mirrors native terrain and quadrant food four ways, with mirrored start ants and queens", () => {
      for (const seed of SEEDS) {
        const s = matches.get(seed)!;
        expect([s.config.mapWidth, s.config.mapHeight], `seed ${seed}`).toEqual([NW, NH]);
        expect(s.terrain!.water.map(key), `seed ${seed} water`).toEqual(boards.get(seed)!.nativeWater!.map(key));
        const c = boards.get(seed)!.centre;
        const inCentre = (x: number, y: number) => x >= c.x * SCALE && x < (c.x + c.width) * SCALE && y >= c.y * SCALE && y < (c.y + c.height) * SCALE;
        let terrainMismatches = 0, foodMismatches = 0;
        for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
          const blocked = isBlockedTile(s.terrain, x, y);
          if (blocked !== isBlockedTile(s.terrain, NW - 1 - x, y) || blocked !== isBlockedTile(s.terrain, x, NH - 1 - y)) terrainMismatches++;
          if (inCentre(x, y)) continue;
          const f = s.food[y * NW + x];
          if (f !== s.food[y * NW + NW - 1 - x] || f !== s.food[(NH - 1 - y) * NW + x]) foodMismatches++;
        }
        expect([terrainMismatches, foodMismatches], `seed ${seed} terrain, food`).toEqual([0, 0]);
        const byColony = [0, 1, 2, 3].map(k => s.ants.filter(a => a.colony === k));
        expect(byColony.map(l => l.length), `seed ${seed} start ants`).toEqual(Array.from({ length: 4 }, () => s.config.startAnts));
        const SW = NW * 1000, SH = NH * 1000;
        byColony[0].forEach((a, i) => {
          expect([1, 2, 3].map(k => [byColony[k][i].x, byColony[k][i].y]), `seed ${seed} ant ${i}`)
            .toEqual([[SW - a.x, a.y], [a.x, SH - a.y], [SW - a.x, SH - a.y]]);
        });
        const queens = s.colonies.map(col => col.queens![0]), q0 = queens[0];
        expect(queens.slice(1).map(qn => [qn.queenX, qn.queenY]), `seed ${seed} queens`)
          .toEqual([[SW - q0.queenX, q0.queenY], [q0.queenX, SH - q0.queenY], [SW - q0.queenX, SH - q0.queenY]]);
      }
    });

    it("keeps all native land in one region with that seed's rocks", () => {
      for (const seed of SEEDS) expect(landRegions(grids.get(seed)!, NW, NH).length, `seed ${seed}`).toBe(1);
    });

    it("reaches every food tile over native land from all four start areas", () => {
      for (const seed of SEEDS) {
        const b = boards.get(seed)!, g = grids.get(seed)!, s = matches.get(seed)!;
        const food = s.food.flatMap((f, t) => (f > 0 ? [t] : []));
        expect(food.length, `seed ${seed}`).toBeGreaterThan(0);
        b.startAreas.forEach((area, k) => {
          const d = landDistances(g, NW, NH, rectTiles(native(area), NW));
          expect(food.filter(t => g[t] !== LAND || d[t] < 0).length, `seed ${seed} start area ${k}`).toBe(0);
        });
      }
    });

    it("gives the four start areas equal numbers of legal native nest tiles (land, no rock, no food), at least one each", () => {
      for (const seed of SEEDS) {
        const b = boards.get(seed)!, g = grids.get(seed)!, s = matches.get(seed)!;
        const counts = b.startAreas.map(area => rectTiles(native(area), NW).filter(t => g[t] === LAND && s.food[t] === 0).length);
        expect(new Set(counts).size, `seed ${seed} ${counts.join("/")}`).toBe(1);
        expect(counts[0], `seed ${seed}`).toBeGreaterThanOrEqual(1);
      }
    });

    it("places rocks on every seed", () => {
      for (const seed of SEEDS) expect(boards.get(seed)!.rocks.length, `seed ${seed}`).toBeGreaterThan(0);
    });

    it.each(routes.map(route => [route.name, route.stated, route] as const))(
      "measures the %s at least %i native tiles wide at every mirror image with each seed's rocks", (_, stated, route) => {
        const doubled: Route = { ...route, corridor: native(route.corridor), sink: native(route.sink) };
        for (const seed of SEEDS) {
          const g = grids.get(seed)!;
          for (const im of routeImages(NW, NH, doubled)) {
            const width = routeWidth(g, NW, im.corridor, edgeTiles(im.corridor, im.source, NW), new Set(rectTiles(im.sink, NW)));
            expect(width, `seed ${seed} corridor ${key(im.corridor)}`).toBeGreaterThanOrEqual(stated);
          }
        }
      });

    it(`centre food: the same seed gives the same layout, and the layouts differ across seeds (${layouts.size} distinct in ${SEEDS.length})`, () => {
      for (const seed of SEEDS) expect(centreLayout(generateQuadrantBoard(map, seed)), `seed ${seed}`).toBe(centreLayout(boards.get(seed)!));
      expect(layouts.size).toBeGreaterThan(1);
    });

    // The board's native water: each native rectangle's four images, quadrant order, in native tiles.
    const nativeWater = generateQuadrantBoard(map, 1).nativeWater!.map(key);

    it(`seed 1: a match log replays to the same ${NW}x${NH} board, native water and state`, () => {
      const config = quadrantMapConfig(map.id);
      let state = createMatch(1, config);
      const lines = [headerLine(1, config)];
      for (let tick = 0; tick < 20; tick++) {
        const inputs = tick === 0 ? JOINS : [];
        lines.push(tickLine(tick, inputs));
        state = step(state, inputs).state;
      }
      const replayed = replay(lines, state.tick);
      expect([replayed.config.mapWidth, replayed.config.mapHeight]).toEqual([NW, NH]);
      expect(replayed.terrain!.water.map(key)).toEqual(nativeWater);
      expect(stateHash(replayed)).toBe(stateHash(state));
    });

    it(`seed 1: the live stream's setup, decoded, carries the native water exactly on the ${NW}x${NH} board`, () => {
      const recorder = new SpectatorRecorder(createMatch(1, quadrantMapConfig(map.id)));
      const message = decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() }));
      expect(message.full!.setup.terrain!.water.map(([x, y, width, height]) => key(r(x, y, width, height)))).toEqual(nativeWater);
    });

    it("seed 1: the agent view carries the native water exactly", () => {
      const out = step(createMatch(1, quadrantMapConfig(map.id)), JOINS);
      const view = takeView(out.state, buildGrid(out.state), out.state.agents[0]!);
      expect(view.terrain!.water.map(([x, y, width, height]) => key(r(x, y, width, height)))).toEqual(nativeWater);
    });
  });
}
