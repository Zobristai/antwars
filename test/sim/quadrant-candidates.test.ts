/** The three candidate quadrant maps: each is chosen only by its explicit map id, no rotation can draw it, and each
 * passes the design's correctness checks on its own board at grid scale 2 over seeds 1-100, default nests, no picks,
 * in the four-colony test config (rulesConfig("redesign") through newMatchConfig). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MAPS, RULES_NAMES, rulesConfig, withoutHousePausedMaps, type MapDefinition, type SimConfig, type WaterRect } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { createMapShapes, houseMatchMaps, newMatchMaps, retiredSevenMapRotation, retiredSixMapHouseRotation } from "../../src/sim/mapShapes.js";
import { CROSSROADS, FOUR_COVES, QUADRANT_CANDIDATES, STRAIT, quadrantCandidateConfig } from "../../src/sim/quadrantCandidates.js";
import { generateQuadrantBoard, validateQuadrantMap, type QuadrantBoard } from "../../src/sim/quadrantMap.js";
import { SCALE2_MAPS } from "../../src/sim/scale2Maps.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import { tuningMapConfig } from "../../src/sim/tuningMap.js";
import type { SimState } from "../../src/sim/types.js";

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const SCALE = 2;
const CANDIDATE_IDS = ["four-coves", "crossroads", "strait"];

type Edge = "left" | "right" | "top" | "bottom";
/** A named route, measured as vertex-disjoint 4-connected land paths inside its corridor from its source edges to
 * its sink tiles, with that seed's rocks. Given for the top-left instance; every mirror image is measured. */
interface Route { readonly name: string; readonly stated: number; readonly corridor: WaterRect; readonly source: readonly Edge[]; readonly sink: WaterRect }
const r = (x: number, y: number, width: number, height: number): WaterRect => ({ x, y, width, height });

const CASES: readonly { readonly map: MapDefinition; readonly width: number; readonly height: number; readonly routes: readonly Route[] }[] = [
  { map: FOUR_COVES, width: 64, height: 48, routes: [
    { name: "cove north exit", stated: 4, corridor: r(18, 0, 5, 8), source: ["left"], sink: r(22, 0, 1, 8) },
    { name: "cove side exit", stated: 4, corridor: r(0, 12, 8, 5), source: ["top"], sink: r(0, 16, 8, 1) },
    { name: "north border", stated: 15, corridor: r(30, 0, 4, 18), source: ["left"], sink: r(33, 0, 1, 18) },
    { name: "west border", stated: 18, corridor: r(0, 22, 24, 4), source: ["top"], sink: r(0, 25, 24, 1) },
  ] },
  { map: CROSSROADS, width: 96, height: 64, routes: [
    { name: "north and south fords", stated: 5, corridor: r(44, 8, 8, 8), source: ["left"], sink: r(51, 8, 1, 8) },
    { name: "west and east fords", stated: 6, corridor: r(12, 28, 8, 8), source: ["top"], sink: r(12, 35, 8, 1) },
    { name: "plaza mouth", stated: 7, corridor: r(30, 17, 18, 15), source: ["left", "top"], sink: r(38, 25, 10, 7) },
  ] },
  { map: STRAIT, width: 112, height: 64, routes: [
    { name: "edge route", stated: 5, corridor: r(51, 0, 10, 8), source: ["left"], sink: r(60, 0, 1, 8) },
    { name: "inner route", stated: 7, corridor: r(51, 14, 10, 10), source: ["left"], sink: r(60, 14, 1, 10) },
    { name: "plaza crossing", stated: 20, corridor: r(46, 27, 20, 10), source: ["top"], sink: r(46, 36, 20, 1) },
    { name: "plaza mouth", stated: 10, corridor: r(36, 14, 20, 18), source: ["left", "top"], sink: r(46, 24, 10, 8) },
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
const diskTiles = (p: { tileX: number; tileY: number; radius: number }, w: number): number[] => {
  const tiles: number[] = [];
  for (let dy = -p.radius; dy <= p.radius; dy++) for (let dx = -p.radius; dx <= p.radius; dx++) {
    if (dx * dx + dy * dy <= p.radius * p.radius) tiles.push((p.tileY + dy) * w + p.tileX + dx);
  }
  return tiles;
};

const LAND = 0, WATER = 1, ROCK = 2;
/** Reference grid of a generated board: land, water or rock per tile. */
function grid(b: QuadrantBoard): Uint8Array {
  const g = new Uint8Array(b.width * b.height);
  for (const w of b.water) for (const t of rectTiles(w, b.width)) g[t] = WATER;
  for (const k of b.rocks) for (const t of rectTiles(k, b.width)) g[t] = ROCK;
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

describe("candidate selection", () => {
  it("lists the three candidates by id with their own board sizes and no ant cap, match length, board or grid scale of their own", () => {
    expect(QUADRANT_CANDIDATES.map(m => [m.id, m.quadrant?.referenceWidth, m.quadrant?.referenceHeight]))
      .toEqual([["four-coves", 64, 48], ["crossroads", 96, 64], ["strait", 112, 64]]);
    for (const map of QUADRANT_CANDIDATES) {
      expect([map.colonyCap, map.matchTicks, map.board, map.gridScale]).toEqual([undefined, undefined, undefined, undefined]);
    }
  });

  it.each(CASES.map(c => [c.map.id, c.width, c.height, c.map] as const))(
    "%s: its explicit id yields its definition alone in a four-colony config, and a match at grid scale 2 takes its %ix%i board (seed 1)",
    (id, width, height, map) => {
      const config = quadrantCandidateConfig(id);
      expect(config.terrain!.maps).toEqual([map]);
      expect(config.gridScale).toBe(SCALE);
      const match = createMatch(1, config);
      expect([match.config.mapWidth, match.config.mapHeight]).toEqual([width * SCALE, height * SCALE]);
      expect(new Set(match.ants.map(a => a.colony))).toEqual(new Set([0, 1, 2, 3]));
    });

  it("refuses an id that names no candidate", () => {
    expect(() => quadrantCandidateConfig("open-field")).toThrow(RangeError);
    expect(() => quadrantCandidateConfig("Four Coves")).toThrow(RangeError);
  });
});

describe("no rotation draws a candidate", () => {
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

  it.each(ROTATIONS)("%s holds no candidate", (_, maps) => {
    expect(ids(maps).filter(id => CANDIDATE_IDS.includes(id))).toEqual([]);
  });

  it.each(CANDIDATE_IDS)("a two-colony rotation with %s added is refused", id => {
    const base = newMatchConfig(rulesConfig("redesign"));
    const map = QUADRANT_CANDIDATES.find(m => m.id === id)!;
    const mixed: SimConfig = { ...base, terrain: { ...base.terrain!, maps: [...base.terrain!.maps, map] } };
    expect(() => newMatchConfig(mixed)).toThrow(`${id}: a quadrant map plays only in a four-colony rotation`);
  });

  it("no source module imports the candidates, so no rotation built in src can hold one", () => {
    const root = join(import.meta.dirname, "../../src");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter(f => /\.(ts|mts|mjs|js)$/.test(f) && !f.endsWith("quadrantCandidates.ts"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(f => readFileSync(join(root, f), "utf8").includes("quadrantCandidates"))).toEqual([]);
  });
});

for (const { map, width: W, height: H, routes } of CASES) {
  const q = map.quadrant!;
  // Centre food layouts are counted here so the count can be reported in the test name.
  const layouts = new Set(SEEDS.map(seed => centreLayout(generateQuadrantBoard(map, seed))));

  describe(`${map.name} (${map.id}), ${W}x${H} reference board, grid scale 2, seeds 1-100, default nests, no picks, rulesConfig("redesign") through newMatchConfig`, () => {
    const boards = new Map<number, QuadrantBoard>(), grids = new Map<number, Uint8Array>(), matches = new Map<number, SimState>();
    beforeAll(() => {
      for (const seed of SEEDS) {
        const b = generateQuadrantBoard(map, seed);
        boards.set(seed, b); grids.set(seed, grid(b)); matches.set(seed, createMatch(seed, quadrantCandidateConfig(map.id)));
      }
    });

    it("validates", () => {
      expect(() => validateQuadrantMap(map)).not.toThrow();
    });

    it("generates its board size with water, rocks, quadrant food, nests and start areas mirrored four ways", () => {
      for (const seed of SEEDS) {
        const b = boards.get(seed)!;
        expect([b.width, b.height], `seed ${seed}`).toEqual([W, H]);
        for (const [what, list] of [["water", b.water], ["rocks", b.rocks], ["start areas", b.startAreas]] as const) {
          expect(list.length % 4, `seed ${seed} ${what}`).toBe(0);
          for (let i = 0; i < list.length; i += 4) {
            expect(list.slice(i, i + 4).map(key), `seed ${seed} ${what} ${i}`).toEqual(images(W, H, list[i]).map(key));
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

    it("at tick 0 mirrors native terrain and quadrant food four ways, with mirrored start ants and queens", () => {
      for (const seed of SEEDS) {
        const s = matches.get(seed)!, NW = s.config.mapWidth, NH = s.config.mapHeight;
        expect([NW, NH], `seed ${seed}`).toEqual([W * SCALE, H * SCALE]);
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

    it("keeps all land in one region with that seed's rocks", () => {
      for (const seed of SEEDS) expect(landRegions(grids.get(seed)!, W, H).length, `seed ${seed}`).toBe(1);
    });

    it("reaches every quadrant and centre food tile over land from all four start areas", () => {
      for (const seed of SEEDS) {
        const b = boards.get(seed)!, g = grids.get(seed)!;
        const food = [...b.quadrantFood, ...b.centreFood].flatMap(p => diskTiles(p, W));
        b.startAreas.forEach((area, k) => {
          const d = landDistances(g, W, H, rectTiles(area, W));
          expect(food.filter(t => g[t] !== LAND || d[t] < 0).length, `seed ${seed} start area ${k}`).toBe(0);
        });
      }
    });

    it("gives the four start areas equal numbers of legal nest tiles (land, no rock, no food), at least one each, in reference and native tiles", () => {
      for (const seed of SEEDS) {
        const b = boards.get(seed)!, g = grids.get(seed)!, s = matches.get(seed)!, NW = s.config.mapWidth;
        const foodTiles = new Set(b.quadrantFood.flatMap(p => diskTiles(p, W)));
        const reference = b.startAreas.map(area => rectTiles(area, W).filter(t => g[t] === LAND && !foodTiles.has(t)).length);
        const native = b.startAreas.map(area => rectTiles({ x: area.x * SCALE, y: area.y * SCALE, width: area.width * SCALE, height: area.height * SCALE }, NW)
          .filter(t => !isBlockedTile(s.terrain, t % NW, Math.floor(t / NW)) && s.food[t] === 0).length);
        for (const counts of [reference, native]) {
          expect(new Set(counts).size, `seed ${seed} ${counts.join("/")}`).toBe(1);
          expect(counts[0], `seed ${seed}`).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it("places rocks on every seed", () => {
      for (const seed of SEEDS) expect(boards.get(seed)!.rocks.length, `seed ${seed}`).toBeGreaterThan(0);
    });

    it.each(routes.map(route => [route.name, route.stated, route] as const))(
      "measures the %s at least %i wide at every mirror image with each seed's rocks", (_, stated, route) => {
        for (const seed of SEEDS) {
          const g = grids.get(seed)!;
          for (const im of routeImages(W, H, route)) {
            const width = routeWidth(g, W, im.corridor, edgeTiles(im.corridor, im.source, W), new Set(rectTiles(im.sink, W)));
            expect(width, `seed ${seed} corridor ${key(im.corridor)}`).toBeGreaterThanOrEqual(stated);
          }
        }
      });

    it(`centre food: the same seed gives the same layout, and the layouts differ across seeds (${layouts.size} distinct in ${SEEDS.length})`, () => {
      for (const seed of SEEDS) expect(centreLayout(generateQuadrantBoard(map, seed)), `seed ${seed}`).toBe(centreLayout(boards.get(seed)!));
      expect(layouts.size).toBeGreaterThan(1);
    });
  });
}
