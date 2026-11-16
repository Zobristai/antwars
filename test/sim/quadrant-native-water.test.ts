/** Quadrant maps whose water is in native tiles (layout nativeWater): validation, the covered reading, the native rock
 * test, and the match terrain, log, stream, agent view and rules page carrying the native water undoubled. Every map
 * here is test-only geometry, at each candidate board size (64x48, 96x64, 112x64), played at grid scale 2 in
 * rulesConfig("redesign") through newMatchConfig. */
import { describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.js";
import { SpectatorRecorder } from "../../src/live/model.js";
import { rulesConfig, type MapDefinition, type QuadrantLayout, type SimConfig, type WaterRect } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { generateQuadrantBoard, validateQuadrantMap } from "../../src/sim/quadrantMap.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { SimInput, SimState } from "../../src/sim/types.js";
import { takeView } from "../../src/sim/view.js";
import { ruleSections } from "../../web/rules.js";

const SIZES: readonly (readonly [number, number])[] = [[64, 48], [96, 64], [112, 64]];
const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const SCALE = 2;
const BASE = newMatchConfig(rulesConfig("redesign"));

const r = (x: number, y: number, width: number, height: number): WaterRect => ({ x, y, width, height });
const key = (q: WaterRect) => `${q.x},${q.y},${q.width},${q.height}`;
const doubled = (q: WaterRect) => r(q.x * SCALE, q.y * SCALE, q.width * SCALE, q.height * SCALE);
/** Four images of a top-left rectangle on a board w by h, in quadrant order. */
const images = (w: number, h: number, q: WaterRect): WaterRect[] => {
  const mx = w - q.x - q.width, my = h - q.y - q.height;
  return [q, r(mx, q.y, q.width, q.height), r(q.x, my, q.width, q.height), r(mx, my, q.width, q.height)];
};
const configFor = (map: MapDefinition): SimConfig => ({ ...BASE, terrain: { ...BASE.terrain!, maps: [map] } });

/** An open map: a stepped lake and a shore strip whose native edges fall mid-way through reference tiles. */
function openLayout(W: number, H: number): QuadrantLayout {
  return { referenceWidth: W, referenceHeight: H, centreHalfWidth: 4, centreHalfHeight: 4, nestTileX: 6, nestTileY: 5,
    startArea: r(1, 1, 10, 8), foodPatches: [{ tileX: 14, tileY: 12, radius: 2, perTile: 3 }], centreFood: [{ radius: 2, perTile: 4 }] };
}
function nativeLake(W: number, H: number): WaterRect[] {
  const x0 = 2 * (W / 2 - 14) + 1, y1 = 2 * (H / 2 - 8) + 1;
  return [r(x0 + 1, 13, 3, 1), r(x0, 14, 5, 4), r(x0 + 1, 18, 4, 3), r(x0 + 2, 21, 2, 1), r(5, y1, 11, 2), r(4, y1 + 2, 9, 1)];
}
const openMap = (W: number, H: number): MapDefinition =>
  ({ id: `native-open-${W}x${H}`, name: `Native Open ${W}x${H}`, water: nativeLake(W, H), quadrant: { ...openLayout(W, H), nativeWater: true } });
/** Reference-aligned water: the same in reference tiles unmarked, or doubled with the marker. */
const referenceLake = (W: number, H: number): WaterRect[] => [r(W / 2 - 14, 6, 3, 4), r(2, H / 2 - 8, 6, 2)];
const twins = (W: number, H: number): readonly [MapDefinition, MapDefinition] => [
  { id: `twin-${W}x${H}`, name: `Twin ${W}x${H}`, water: referenceLake(W, H), quadrant: openLayout(W, H) },
  { id: `twin-${W}x${H}`, name: `Twin ${W}x${H}`, water: referenceLake(W, H).map(doubled), quadrant: { ...openLayout(W, H), nativeWater: true } },
];
/** The covered reading of a native rectangle: every reference tile any of its native tiles lies in. */
const covered = (q: WaterRect): WaterRect => {
  const x = Math.floor(q.x / SCALE), y = Math.floor(q.y / SCALE);
  return r(x, y, Math.ceil((q.x + q.width) / SCALE) - x, Math.ceil((q.y + q.height) / SCALE) - y);
};

/**
 * A quadrant of water but for a 7x7 land block round the nest (3,3), whose nest clearance covers it, one corridor along
 * row 3 and down column W/2-1 into the centre, and dead ends C (W/2-2, 5) and, with spareEnd, E (W/2-2, 9). Every other
 * land tile lies on the corridor, so only C and E can hold a rock. Marked, the reference tile D (W/2-3, 5) left of C
 * keeps water only in its left native column, leaving two dry native tiles reached only through C: a rock on C would
 * cut them off. Unmarked, D is reference water, the same land as the marked map's covered reading.
 */
function deadEnds(W: number, H: number, marked: boolean, spareEnd: boolean): MapDefinition {
  const chw = 2, chh = 2, cx = W / 2 - chw, cy = H / 2 - chh;
  const C = [W / 2 - 2, 5], D = [W / 2 - 3, 5], E = [W / 2 - 2, 9];
  const land = (x: number, y: number): boolean => (x <= 6 && y <= 6) || (y === 3 && x >= 7) || (x === W / 2 - 1 && y >= 3)
    || (x === C[0] && y === C[1]) || (spareEnd && x === E[0] && y === E[1]) || (x >= cx && y >= cy);
  const water: WaterRect[] = [];
  for (let y = 0; y < H / 2; y++) {
    let start = -1;
    for (let x = 0; x <= W / 2; x++) {
      const wet = x < W / 2 && !land(x, y) && !(marked && x === D[0] && y === D[1]);
      if (wet && start < 0) start = x;
      if (!wet && start >= 0) { water.push(marked ? doubled(r(start, y, x - start, 1)) : r(start, y, x - start, 1)); start = -1; }
    }
  }
  if (marked) water.push(r(SCALE * D[0]!, SCALE * D[1]!, 1, SCALE));
  return { id: `dead-ends-${W}x${H}`, name: `Dead Ends ${W}x${H}`, water,
    quadrant: { referenceWidth: W, referenceHeight: H, centreHalfWidth: chw, centreHalfHeight: chh, nestTileX: 3, nestTileY: 3,
      startArea: r(0, 0, 5, 5), foodPatches: [], centreFood: [{ radius: 1, perTile: 3 }], ...(marked ? { nativeWater: true as const } : {}) } };
}
const onTile = (rocks: readonly WaterRect[], tx: number, ty: number) => rocks.some(k => tx >= k.x && tx < k.x + k.width && ty >= k.y && ty < k.y + k.height);

/** Native land regions of a match's terrain (4-connected, water and rocks blocked). */
function nativeRegions(s: SimState): number {
  const w = s.config.mapWidth, h = s.config.mapHeight, seen = new Uint8Array(w * h);
  let regions = 0;
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || isBlockedTile(s.terrain, i % w, Math.floor(i / w))) continue;
    regions++;
    const queue = [i];
    seen[i] = 1;
    while (queue.length > 0) {
      const at = queue.pop()!, x = at % w, y = Math.floor(at / w);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        const n = ny * w + nx;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !seen[n] && !isBlockedTile(s.terrain, nx, ny)) { seen[n] = 1; queue.push(n); }
      }
    }
  }
  return regions;
}
const nativeImagesOf = (map: MapDefinition, W: number, H: number) => map.water.flatMap(q => images(W * SCALE, H * SCALE, q));
const joins: SimInput[] = [0, 1, 2, 3].map(seat => ({ type: "join", agentId: `seat-${seat}`, modelLabel: `model-${seat}` }));

describe.each(SIZES)("native-water quadrant map, %ix%i reference board, grid scale 2", (W, H) => {
  const open = openMap(W, H);

  it(`validates the test-only open map at ${W}x${H}, and generates its native water as each rectangle's four native images, its water as the covered reading`, () => {
    expect(() => validateQuadrantMap(open)).not.toThrow();
    const board = generateQuadrantBoard(open, 1);
    expect(board.nativeWater!.map(key)).toEqual(nativeImagesOf(open, W, H).map(key));
    expect(board.water.map(key)).toEqual(open.water.flatMap(q => images(W, H, covered(q))).map(key));
    expect(createMatch(1, configFor(open)).config.mapWidth).toBe(W * SCALE);
  });

  it(`at ${W}x${H}, seeds 1-20: reference water doubled with the marker plays as the same water unmarked`, () => {
    const [plain, marked] = twins(W, H);
    expect(() => validateQuadrantMap(plain)).not.toThrow();
    expect(() => validateQuadrantMap(marked)).not.toThrow();
    for (const seed of SEEDS.slice(0, 20)) {
      const a = generateQuadrantBoard(plain, seed), b = generateQuadrantBoard(marked, seed);
      expect([b.water, b.rocks, b.centreFood, b.quadrantFood, b.nests, b.startAreas], `seed ${seed}`).toEqual([a.water, a.rocks, a.centreFood, a.quadrantFood, a.nests, a.startAreas]);
      expect(b.nativeWater!.map(key), `seed ${seed}`).toEqual(a.water.map(doubled).map(key));
      expect(a).not.toHaveProperty("nativeWater");
      const ma = createMatch(seed, configFor(plain)), mb = createMatch(seed, configFor(marked));
      expect([mb.terrain, mb.food, mb.ants, mb.colonies], `seed ${seed}`).toEqual([ma.terrain, ma.food, ma.ants, ma.colonies]);
    }
  });

  const REFUSALS: readonly (readonly [string, WaterRect, string])[] = [
    ["a non-whole x", r(10.5, 4, 2, 2), "native water rectangles must be positive whole tiles"],
    ["a zero width", r(10, 4, 0, 2), "native water rectangles must be positive whole tiles"],
    ["a negative y", r(10, -1, 2, 2), "native water rectangles must lie inside the native top-left quadrant"],
    ["a rectangle past the native quadrant's right edge", r(W - 1, 4, 2, 1), "native water rectangles must lie inside the native top-left quadrant"],
    ["a rectangle past the native quadrant's bottom edge", r(4, H - 1, 1, 2), "native water rectangles must lie inside the native top-left quadrant"],
    ["a rectangle one native tile into the centre", r(W - 8 - 1, H - 8 - 1, 2, 2), "native water rectangles must not overlap the centre region"],
  ];
  it.each(REFUSALS)(`at ${W}x${H}, refuses %s, never clamping`, (_, bad, why) => {
    const map: MapDefinition = { ...open, water: [...open.water, bad] };
    expect(() => validateQuadrantMap(map)).toThrow(`${open.id}: ${why}`);
    expect(() => createMatch(1, configFor(map))).toThrow(why);
  });

  it(`at ${W}x${H}, reads a reference tile as water when one native tile of it is: food, nest and start area refused`, () => {
    const q = open.quadrant!;
    // One native tile in the food disk's centre tile, the nest's tile, and each tile of a 2x2 start area.
    const food: MapDefinition = { ...open, water: [...open.water, r(2 * 14 + 1, 2 * 12, 1, 1)] };
    expect(() => validateQuadrantMap(food)).toThrow("food templates must lie entirely on land");
    const nest: MapDefinition = { ...open, water: [...open.water, r(2 * q.nestTileX + 1, 2 * q.nestTileY + 1, 1, 1)] };
    expect(() => validateQuadrantMap(nest)).toThrow("the nest must be on land");
    // A 3x3 start area beside the nest (4,4): one native water tile in each of its reference tiles but (2,2) leaves that
    // tile its only land; one more native tile there leaves it none.
    const wetStart = (tiles: readonly (readonly [number, number])[]): MapDefinition => ({ ...open,
      water: [...open.water, ...tiles.map(([tx, ty]) => r(2 * tx + 1, 2 * ty + 1, 1, 1))],
      quadrant: { ...q, startArea: r(0, 0, 3, 3), nestTileX: 4, nestTileY: 4 } });
    const all = [0, 1, 2].flatMap(ty => [0, 1, 2].map(tx => [tx, ty] as const));
    expect(() => validateQuadrantMap(wetStart(all.filter(([tx, ty]) => tx !== 2 || ty !== 2)))).not.toThrow();
    expect(() => validateQuadrantMap(wetStart(all))).toThrow("the start area needs a land tile clear of food");
  });

  it(`at ${W}x${H}, seeds 1-100: no rock or food tile holds native water`, () => {
    const water = new Set<number>(), NW = W * SCALE;
    for (const q of nativeImagesOf(open, W, H)) for (let y = q.y; y < q.y + q.height; y++) for (let x = q.x; x < q.x + q.width; x++) water.add(y * NW + x);
    for (const seed of SEEDS) {
      const s = createMatch(seed, configFor(open));
      const rockTiles = s.terrain!.rocks!.flatMap(k => Array.from({ length: k.width * k.height }, (_, i) => (k.y + Math.floor(i / k.width)) * NW + k.x + (i % k.width)));
      expect(rockTiles.filter(t => water.has(t)).length, `seed ${seed} rocks`).toBe(0);
      expect(s.food.filter((f, t) => f > 0 && water.has(t)).length, `seed ${seed} food`).toBe(0);
      expect(s.terrain!.rocks!.length, `seed ${seed}`).toBeGreaterThan(0);
      expect(nativeRegions(s), `seed ${seed}`).toBe(1);
    }
  });

  it(`at ${W}x${H}, seeds 1-100: a rock that would cut off dry native tiles is never kept; unmarked, the same land takes it`, () => {
    const marked = deadEnds(W, H, true, true), plain = deadEnds(W, H, false, true), C = [W / 2 - 2, 5] as const;
    let plainOnC = 0;
    for (const seed of SEEDS) {
      const b = generateQuadrantBoard(marked, seed);
      expect(onTile(b.rocks, C[0], C[1]), `seed ${seed}`).toBe(false);
      expect(b.rocks.length, `seed ${seed}`).toBeGreaterThan(0);
      expect(nativeRegions(createMatch(seed, configFor(marked))), `seed ${seed}`).toBe(1);
      if (onTile(generateQuadrantBoard(plain, seed).rocks, C[0], C[1])) plainOnC++;
    }
    expect(plainOnC).toBeGreaterThan(0);
  });

  it(`at ${W}x${H}, validation's proof that a rock fits applies the same test: the one spot that would cut off native land leaves no room`, () => {
    expect(() => validateQuadrantMap(deadEnds(W, H, false, false))).not.toThrow();
    expect(() => validateQuadrantMap(deadEnds(W, H, true, false))).toThrow(`dead-ends-${W}x${H}: no room for a rock`);
  });

  it(`at ${W}x${H}, seed 7: the match terrain holds each native rectangle's four images exactly, and rocks doubled`, () => {
    const s = createMatch(7, configFor(open)), board = generateQuadrantBoard(open, 7);
    expect(s.terrain!.water.map(key)).toEqual(nativeImagesOf(open, W, H).map(key));
    expect(s.terrain!.rocks!.map(key)).toEqual(board.rocks.map(doubled).map(key));
  });

  it(`at ${W}x${H}, seed 7: a match log replays to the same terrain and state`, () => {
    const config = configFor(open);
    let state = createMatch(7, config);
    const lines = [headerLine(7, config)];
    for (let tick = 0; tick < 30; tick++) {
      const inputs = tick === 0 ? joins : [];
      const out = step(state, inputs);
      lines.push(tickLine(tick, inputs));
      state = out.state;
    }
    const replayed = replay(lines, state.tick);
    expect(replayed.terrain!.water.map(key)).toEqual(nativeImagesOf(open, W, H).map(key));
    expect(stateHash(replayed)).toBe(stateHash(state));
  });

  it(`at ${W}x${H}, seed 7: the live stream's setup, decoded, carries the native water exactly`, () => {
    const recorder = new SpectatorRecorder(createMatch(7, configFor(open)));
    const message = decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    expect(message.full!.setup.terrain!.water.map(([x, y, width, height]) => key(r(x, y, width, height))))
      .toEqual(nativeImagesOf(open, W, H).map(key));
  });

  it(`at ${W}x${H}, seed 7: the agent view carries the native water exactly`, () => {
    const out = step(createMatch(7, configFor(open)), joins);
    const view = takeView(out.state, buildGrid(out.state), out.state.agents[0]!);
    expect(view.terrain!.water.map(([x, y, width, height]) => key(r(x, y, width, height)))).toEqual(nativeImagesOf(open, W, H).map(key));
  });

  it(`at ${W}x${H}: the rules page lists the native water undoubled`, () => {
    const line = ruleSections(configFor(open)).flatMap(section => section.lines).find(l => l.startsWith(`${open.name}:`))!;
    const listed = [...line.matchAll(/\((\d+), (\d+)\), (\d+) tiles? wide and (\d+) tiles? high/g)].map(m => `${m[1]},${m[2]},${m[3]},${m[4]}`);
    expect(listed).toEqual(nativeImagesOf(open, W, H).map(key));
  });
});
