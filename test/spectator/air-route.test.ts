// A chain of flyer PATROL marks reads on both boards as an air route: straight dashes on a light halo from marker to
// marker in chain order, closed into a loop for three or more marks, linked exactly as the simulation links patrol
// marks. Ground patrol marks, a lone flyer mark and matches without patrol rules draw as before. The route is drawn
// from the sampled message's marks, so live and recorded playback, a seek and a join all show it, on the public
// stream, which withholds the rules' name. Its dashes are cut only on screen and in front of the 3D camera's near
// plane, so a camera close to the ground costs no more than one that shows the whole route. A colony's view, which
// shows only the marks its ants smell, links each chain from the whole board and draws only the legs between marks it
// shows, never one between marks the chain does not fly between.
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Graphics } from "pixi.js";
import { FLYER_STREAM_VERSION, decodeMessage, type StreamMark, type StreamMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import type { ReplayObject } from "../../src/replays/store.ts";
import { comparisonOptions } from "../../src/server.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { linkPatrolMarks } from "../../src/sim/patrol.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { MIN_RADIUS, fitTilted, projector, type Pose } from "../../web/src/board3d/view.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { MARK_DOT } from "../../web/src/compose.ts";
import { openRecording, type Recording } from "../../web/src/recording.ts";
import { clipToRect } from "../../web/src/screen-path.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { AIR_ROUTE, LINE_DOTS, Words, airRouteDashes, airRoutes, patrolRangeTiles } from "../../web/src/words.ts";
import { addAnt } from "../sim/fixtures.ts";

type Shape = { type: string; x?: number; y?: number; radius?: number; points?: number[]; closePath?: boolean };
type Instruction = { action: string; data: { style: { color: number; width: number; alpha: number }; path: { shapePath: { shapePrimitives: { shape: Shape }[] } } } };
const instructions = (g: Graphics) => g.context.instructions as unknown as Instruction[];
const shapes = (g: Graphics, type: string, action = "fill"): Shape[] =>
  instructions(g).filter((i) => i.action === action)
    .flatMap((i) => i.data.path.shapePath.shapePrimitives.map((p) => p.shape).filter((s) => s.type === type));
/** The stroked open paths: the route's dashes, with their stroke style (a marker's glyph is a closed polygon). */
const lineStrokes = (g: Graphics) => instructions(g).filter((i) => i.action === "stroke" && i.data.path.shapePath.shapePrimitives.length > 0
  && i.data.path.shapePath.shapePrimitives.every((p) => p.shape.type === "polygon" && p.shape.closePath === false));

const W = 64, H = 48;
/** A redesign board as the public stream carries it: no rules' name, the queens' HP streamed. */
const PUBLIC = { setup: { gridScale: 2, ticksPerSecond: 10 }, queens: [{ id: 0, colony: 0, hp: 100_000 }] } as const;
/** A redesign board of a comparison stream, which names its rules. */
const NAMED = { setup: { rules: "redesign", gridScale: 2, ticksPerSecond: 10 } } as const;
const patrol = (id: number, tileX: number, tileY: number, extra: Partial<StreamMark> = {}): StreamMark =>
  ({ id, agent: 0, colony: 0, tileX, tileY, words: [], verb: "PATROL", count: 4, claimed: 2, answered: 0, laidTick: id, caste: "flyer", ...extra });
/** A frame of these marks on a board with this setup and these queens; null for a board whose setup the frame lacks. */
const frameOf = (marks: StreamMark[], board: { setup: object; queens?: readonly object[] } | null = PUBLIC): Frame =>
  ({ tick: 100, board: { marks, agents: [], setup: board?.setup, queens: board?.queens }, marks: marks.map((mark) => ({ mark, ageMs: 5000 })) }) as unknown as Frame;
/** patrolRangeTiles of a board with only the fields it reads. */
const rangeOf = (board: object | undefined) => patrolRangeTiles(board as Parameters<typeof patrolRangeTiles>[0]);

const flat2d = (w: number, tilesW = W) => {
  const px = w / tilesW;
  return (tx: number, ty: number): [number, number] => [tx * px, ty * px];
};
const relief = (tx: number, ty: number) => 0.4 * Math.sin(tx / 3) * Math.cos(ty / 4);
const tilted3d = (w: number, h: number, tilesW = W, tilesH = H) => {
  const project = projector(fitTilted(tilesW, tilesH, w, h, { x0: 0, y0: 0, x1: w, y1: h }).pose, w, h);
  return (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), tilesH - ty]) ?? [NaN, NaN];
};
const views = [
  { board: "2D", w: 1920, h: 1080, toScreen: flat2d(1920) },
  { board: "2D", w: 390, h: 844, toScreen: flat2d(390) },
  { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080) },
  { board: "3D", w: 390, h: 844, toScreen: tilted3d(390, 844) },
];
const markerAt = (toScreen: (tx: number, ty: number) => [number, number], m: StreamMark) => toScreen(m.tileX + 0.5, m.tileY + 0.5).map(Math.round) as [number, number];
/** Distance from (x, y) to the segment a-b. */
const offSegment = ([x, y]: readonly [number, number], [ax, ay]: readonly [number, number], [bx, by]: readonly [number, number]) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
};
/** Which legs (from marker i to marker j) a route's dashes lie on. */
const legsOf = (dashes: readonly [number, number, number, number][], points: readonly [number, number][]) => {
  const legs = new Set<string>();
  for (const [x0, y0, x1, y1] of dashes) {
    for (let i = 0; i < points.length; i++) for (let j = 0; j < points.length; j++) {
      if (i !== j && offSegment([x0, y0], points[i]!, points[j]!) < 0.01 && offSegment([x1, y1], points[i]!, points[j]!) < 0.01) legs.add(`${Math.min(i, j)}-${Math.max(i, j)}`);
    }
  }
  return [...legs].sort();
};

describe("which patrol marks make an air route", () => {
  it("takes its range from the match's rules at its grid scale, named or known by queen HP, and has none without patrol rules", () => {
    const range = newMatchConfig(rulesConfig("redesign")).patrolLinkTiles;
    expect(range).toBe(12);
    expect(rangeOf(PUBLIC)).toBe(range);
    expect(rangeOf(NAMED)).toBe(range);
    expect(rangeOf({ setup: { gridScale: 2 } })).toBeNull();
    expect(rangeOf({ setup: {}, queens: PUBLIC.queens })).toBeNull();
    expect(rangeOf({ setup: { rules: "v4", gridScale: 2 }, queens: PUBLIC.queens })).toBeNull();
    expect(rangeOf({ setup: { rules: "count-marks", gridScale: 2 } })).toBeNull();
    expect(rangeOf(undefined)).toBeNull();
  });

  it("links flyer marks only with flyer marks of their colony within range, transitively, in laid order", () => {
    const marks = [
      patrol(4, 30, 10), patrol(1, 10, 10), patrol(2, 20, 10), // one flyer chain, laid 1, 2, 4
      patrol(3, 15, 12, { caste: undefined }), patrol(5, 25, 12, { caste: "soldier" }), // ground marks among them
      patrol(6, 20, 14, { colony: 1 }), // the other colony's flyer mark
      patrol(7, 43, 10), // beyond 12 tiles of the chain's nearest mark
      patrol(8, 20, 30, { verb: "DEFEND" }), patrol(9, 32, 30), // a flyer DEFEND mark does not link a lone patrol mark
    ];
    expect(airRoutes(marks, 12).map((r) => r.map((m) => m.id))).toEqual([[1, 2, 4]]);
    // The ground marks keep their own chain, linked as before: flyer marks between them do not bridge it.
    const chains = linkPatrolMarks(marks, 12);
    expect(chains.get(3)!.chain.map((m) => m.id)).toEqual([3, 5]);
    expect(chains.get(1)!.chain).toBe(chains.get(4)!.chain);
    expect(chains.get(6)!.chain.map((m) => m.id)).toEqual([6]);
    expect(chains.get(7)!.chain.map((m) => m.id)).toEqual([7]);
    expect(airRoutes(marks, null)).toEqual([]);
    // Exactly at the range links; just past it does not.
    expect(airRoutes([patrol(1, 10, 10), patrol(2, 22, 10)], 12)).toHaveLength(1);
    expect(airRoutes([patrol(1, 10, 10), patrol(2, 22, 11)], 12)).toEqual([]);
  });

  it("puts a leg between consecutive marks, closes the loop for three or more, and keeps clear of the rings", () => {
    const points: [number, number][] = [[0, 0], [200, 0], [200, 100]];
    expect(legsOf(airRouteDashes(points.slice(0, 2)), points)).toEqual(["0-1"]);
    expect(legsOf(airRouteDashes(points), points)).toEqual(["0-1", "0-2", "1-2"]);
    expect(airRouteDashes(points.slice(0, 1))).toEqual([]);
    expect(airRouteDashes([[0, 0], [NaN, NaN]])).toEqual([]);
    // A waypoint not drawn has no legs; the loop's other legs stay as they are.
    expect(legsOf(airRouteDashes([points[0]!, null, points[2]!]), points)).toEqual(["0-2"]);
    expect(airRouteDashes([points[0]!, null])).toEqual([]);
    for (const [x0, y0, x1, y1] of airRouteDashes(points)) {
      for (const [px, py] of points) {
        expect(Math.hypot(x0 - px, y0 - py)).toBeGreaterThanOrEqual(MARK_DOT.ring);
        expect(Math.hypot(x1 - px, y1 - py)).toBeGreaterThanOrEqual(MARK_DOT.ring);
      }
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeLessThanOrEqual(AIR_ROUTE.dash + 1e-9);
    }
  });
});

describe("air route on the boards", () => {
  const loop = [patrol(1, 10, 10), patrol(2, 20, 10), patrol(3, 20, 20)];

  it.each(views)("draws a closed loop through three flyer marks on the $board board at $w x $h, distinct from ground marks", ({ w, h, toScreen }) => {
    const words = new Words({ w, h });
    words.update(frameOf(loop), toScreen, [], "v");
    const points = loop.map((m) => markerAt(toScreen, m));
    const [route] = words.drawnRoutes();
    expect(words.drawnRoutes()).toHaveLength(1);
    expect(route!.ids).toEqual([1, 2, 3]);
    expect(legsOf(route!.dashes, points)).toEqual(["0-1", "0-2", "1-2"]);
    for (const [x0, y0, x1, y1] of route!.dashes) {
      for (const x of [x0, x1]) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(w); }
      for (const y of [y0, y1]) { expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(h); }
    }
    // Each flyer mark keeps its marker; the route is drawn as two line strokes, a light halo then the owner's shade,
    // never as dots: a ground LINE mark is dots, and a ground mark's outline is dark.
    const g = words.layer.children[0] as Graphics;
    expect(shapes(g, "circle", "stroke").filter((c) => c.radius === MARK_DOT.ring)).toHaveLength(2 * loop.length);
    expect(shapes(g, "circle").filter((c) => c.radius === LINE_DOTS.r || c.radius === LINE_DOTS.endR)).toEqual([]);
    const strokes = lineStrokes(g);
    expect(strokes).toHaveLength(2);
    expect(strokes[0]!.data.style).toMatchObject({ color: 0xffffff, width: AIR_ROUTE.halo });
    expect(strokes[1]!.data.style.width).toBe(AIR_ROUTE.width);
    expect(strokes[1]!.data.style.color).not.toBe(0x000000);
    for (const s of strokes) expect(s.data.path.shapePath.shapePrimitives).toHaveLength(route!.dashes.length);
    expect(shapes(g, "circle", "stroke").filter((c) => c.radius === AIR_ROUTE.ringR).map((c) => [c.x, c.y])).toEqual(points);
  });

  it.each(views)("draws two flyer marks as one leg, and a lone one as its marker only, on the $board board at $w x $h", ({ w, h, toScreen }) => {
    const words = new Words({ w, h });
    words.update(frameOf(loop.slice(0, 2)), toScreen, [], "v");
    const points = loop.slice(0, 2).map((m) => markerAt(toScreen, m));
    expect(words.drawnRoutes().map((r) => r.ids)).toEqual([[1, 2]]);
    expect(legsOf(words.drawnRoutes()[0]!.dashes, points)).toEqual(["0-1"]);
    words.update(frameOf([patrol(9, 40, 30)]), toScreen, [], "v2");
    expect(words.drawnRoutes()).toEqual([]);
    expect(lineStrokes(words.layer.children[0] as Graphics)).toEqual([]);
    expect(shapes(words.layer.children[0] as Graphics, "circle", "stroke").filter((c) => c.radius === AIR_ROUTE.ringR)).toEqual([]);
  });

  // The redesign board at grid scale 2 is 128 x 96 tiles, so on a phone fitting the whole board linked marks a few
  // tiles apart are only a few px apart.
  const real = { w: 128, h: 96 };
  const realViews = [
    { board: "2D", w: 390, h: 844, toScreen: flat2d(390, real.w) },
    { board: "3D", w: 390, h: 844, toScreen: tilted3d(390, 844, real.w, real.h) },
    { board: "2D", w: 1920, h: 1080, toScreen: flat2d(1920, real.w) },
    { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080, real.w, real.h) },
  ];
  it.each(realViews)("shows a route between near waypoints at real board scale on the $board board at $w x $h", ({ w, h, toScreen }) => {
    const config = newMatchConfig(rulesConfig("redesign"));
    expect([config.mapWidth, config.mapHeight]).toEqual([real.w, real.h]);
    const edge = MARK_DOT.ring + (MARK_DOT.ringW + 2.5) / 2;
    let crossed = 0;
    for (let d = 1; d <= 12; d++) {
      const words = new Words({ w, h });
      const pair = [patrol(1, 60, 50), patrol(2, 60 + d, 50)];
      words.update(frameOf(pair), toScreen, [], "v");
      const points = pair.map((m) => markerAt(toScreen, m));
      const [a, b] = points as [[number, number], [number, number]];
      const [route] = words.drawnRoutes();
      expect(route!.ids).toEqual([1, 2]);
      // Wherever the markers' outlines leave a gap, a dash crosses it; only touching markers have none.
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) - 2 * edge >= 1) {
        crossed++;
        expect(legsOf(route!.dashes, points)).toEqual(["0-1"]);
        for (const [x0, y0, x1, y1] of route!.dashes) for (const [px, py] of points) {
          expect(Math.hypot(x0 - px, y0 - py)).toBeGreaterThanOrEqual(edge - 1e-9);
          expect(Math.hypot(x1 - px, y1 - py)).toBeGreaterThanOrEqual(edge - 1e-9);
        }
      } else {
        expect(route!.dashes).toEqual([]);
      }
      // Either way each of the route's markers wears its light ring, which no ground mark has.
      const rings = shapes(words.layer.children[0] as Graphics, "circle", "stroke").filter((c) => c.radius === AIR_ROUTE.ringR);
      expect(rings.map((c) => [c.x, c.y])).toEqual(points);
    }
    expect(crossed).toBeGreaterThan(0);
  });

  it("is straight on the 3D board, flown over the ground, not laid along its relief like a LINE mark's dots", () => {
    const toScreen = tilted3d(1920, 1080);
    const words = new Words({ w: 1920, h: 1080 });
    const pair = [patrol(1, 30, 30), patrol(2, 42, 30)];
    words.update(frameOf(pair), toScreen, [], "v");
    const [a, b] = pair.map((m) => markerAt(toScreen, m));
    const dashes = words.drawnRoutes()[0]!.dashes;
    expect(dashes.length).toBeGreaterThan(5);
    for (const [x0, y0, x1, y1] of dashes) {
      expect(offSegment([x0, y0], a, b)).toBeLessThan(0.01);
      expect(offSegment([x1, y1], a, b)).toBeLessThan(0.01);
    }
  });

  it("leaves ground patrol marks exactly as they were drawn without the route, and draws no route without patrol rules", () => {
    const toScreen = flat2d(1920);
    const ground = loop.map((m) => ({ ...m, caste: undefined }));
    const drawn = (marks: StreamMark[], board: Parameters<typeof frameOf>[1]) => {
      const words = new Words({ w: 1920, h: 1080 });
      words.update(frameOf(marks, board), toScreen, [], "v");
      return { routes: words.drawnRoutes(), instructions: instructions(words.layer.children[0] as Graphics).map((i) => ({ action: i.action, style: i.data.style, shapes: i.data.path.shapePath.shapePrimitives.map((p) => p.shape) })) };
    };
    const before = drawn(ground, null);
    expect(drawn(ground, PUBLIC)).toEqual(before);
    expect(drawn(ground, NAMED)).toEqual(before);
    expect(before.routes).toEqual([]);
    expect(drawn(loop, NAMED).routes).toEqual(drawn(loop, PUBLIC).routes);
    // Flyer marks in a match whose rules carry no patrol marks, or an unnamed board without HP: markers only, as ground marks.
    for (const board of [{ setup: { gridScale: 2 } }, { setup: { rules: "v4", gridScale: 2 }, queens: PUBLIC.queens }, null]) {
      expect(drawn(loop, board).routes).toEqual([]);
      expect(drawn(loop, board).instructions).toEqual(before.instructions);
    }
  });

  it("follows a moved flyer mark, which keeps its id, and drops a mark that has left the board", () => {
    const toScreen = flat2d(1920);
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf(loop), toScreen, [], "v");
    const moved = [loop[0]!, loop[1]!, { ...loop[2]!, tileX: 14, tileY: 18, revision: 1 }];
    words.update(frameOf(moved), toScreen, [], "v");
    const points = moved.map((m) => markerAt(toScreen, m));
    expect(words.drawnRoutes()[0]!.ids).toEqual([1, 2, 3]);
    expect(legsOf(words.drawnRoutes()[0]!.dashes, points)).toEqual(["0-1", "0-2", "1-2"]);
    words.update(frameOf(moved.slice(1)), toScreen, [], "v");
    expect(words.drawnRoutes().map((r) => r.ids)).toEqual([[2, 3]]);
  });
});

// What the boards drew before a route's dashes were cut only on screen and in front of the 3D camera's near plane:
// every leg cut whole between its markers' points, wherever they project. A route on screen is drawn exactly so still.
const uncut = (points: readonly (readonly [number, number])[]) => {
  const legs = points.length < 2 ? 0 : points.length === 2 ? 1 : points.length;
  const clear = MARK_DOT.ring + 3, edge = MARK_DOT.ring + (MARK_DOT.ringW + 2.5) / 2;
  const dashes: [number, number, number, number][] = [];
  for (let i = 0; i < legs; i++) {
    const [ax, ay] = points[i]!, [bx, by] = points[(i + 1) % points.length]!;
    const length = Math.hypot(bx - ax, by - ay);
    if (!Number.isFinite(length)) continue;
    const ux = (bx - ax) / length, uy = (by - ay) / length;
    if (length - 2 * clear >= AIR_ROUTE.dash) {
      for (let s = clear; s < length - clear; s += AIR_ROUTE.dash + AIR_ROUTE.gap) {
        const e = Math.min(s + AIR_ROUTE.dash, length - clear);
        dashes.push([ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e]);
      }
    } else if (length - 2 * edge >= 1) dashes.push([ax + ux * edge, ay + uy * edge, bx - ux * edge, by - uy * edge]);
  }
  return dashes;
};
const sameDash = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
const PERIOD = AIR_ROUTE.dash + AIR_ROUTE.gap;

describe("air route drawn as before where its markers show", () => {
  const real = { w: 128, h: 96 };
  const ordinary = [
    ...views,
    { board: "2D", w: 390, h: 844, toScreen: flat2d(390, real.w) },
    { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080, real.w, real.h) },
  ];
  const loop = [patrol(1, 10, 10), patrol(2, 20, 10), patrol(3, 20, 20)];
  it.each(ordinary)("cuts the same dashes as before on the $board board at $w x $h", ({ w, h, toScreen }) => {
    let cut = 0;
    for (const marks of [loop, loop.slice(0, 2), [patrol(1, 30, 30), patrol(2, 33, 30)], [patrol(1, 30, 20), patrol(2, 38, 20)]]) {
      const words = new Words({ w, h });
      words.update(frameOf(marks), toScreen, [], "v");
      const before = uncut(marks.map((m) => markerAt(toScreen, m)));
      const [route] = words.drawnRoutes();
      expect(route!.dashes).toHaveLength(before.length);
      route!.dashes.forEach((d, i) => expect(sameDash(d, before[i]!)).toBe(true));
      cut += before.length;
    }
    expect(cut).toBeGreaterThan(0);
  });
});

// The 3D board with its orbit camera close to the ground, as main3d.ts allows it (radius down to MIN_RADIUS, a near
// plane at minZ 0.5). The board places markers through its plain projection, Babylon's ProjectToRef, which throws ground
// just in front of the camera millions of px off screen and mirrors ground behind it onto the screen, and hands Words its
// guarded projection, which gives no point at or behind the near plane. Each test drives Words as main3d.ts does.
describe("air route with the 3D camera close to the ground", () => {
  const [w, h] = [1920, 1080];
  const NEAR = 0.5, MAP_H = 96;
  /** The board's two projections of flat ground at pose, and the guarded one's calls. */
  const camera = (pose: Pose) => {
    const project = projector(pose, w, h);
    const [tx, ty, tz] = pose.target, sb = Math.sin(pose.beta);
    const eye = [tx + pose.radius * Math.cos(pose.alpha) * sb, ty + pose.radius * Math.cos(pose.beta), tz + pose.radius * Math.sin(pose.alpha) * sb] as const;
    const at = (x: number, y: number) => [x, 0, MAP_H - y] as const;
    /** A ground point's depth in front of the camera: the projected point's clip w. */
    const depth = (x: number, y: number) => {
      const p = at(x, y);
      return ((p[0] - eye[0]) * (tx - eye[0]) + (p[1] - eye[1]) * (ty - eye[1]) + (p[2] - eye[2]) * (tz - eye[2])) / pose.radius;
    };
    // ProjectToRef divides by depth whatever its sign: a point behind the camera lands where its mirror through the eye does.
    const toScreen = (x: number, y: number): [number, number] => {
      const p = at(x, y);
      return project(p) ?? project([2 * eye[0] - p[0], 2 * eye[1] - p[1], 2 * eye[2] - p[2]]) ?? [NaN, NaN];
    };
    const view = { calls: 0, toScreen, inFront: (x: number, y: number): [number, number] => {
      view.calls++;
      return depth(x, y) > NEAR ? toScreen(x, y) : [NaN, NaN];
    } };
    return view;
  };
  /** A permitted pose looking along the board, with mark m's tile centre at depth d in front of the camera. */
  const poseFor = (m: StreamMark, d: number): Pose => ({ alpha: -Math.PI / 2, beta: 1.2, radius: MIN_RADIUS, target: [50.5, 0, MAP_H - (m.tileY + 0.5) + (MIN_RADIUS - d) / Math.sin(1.2)] });
  const pad = AIR_ROUTE.halo / 2 + 1;
  const padded = { x0: -pad, y0: -pad, x1: w + pad, y1: h + pad };
  const onScreen = ([x, y]: readonly [number, number]) => x > 0 && x < w && y > 0 && y < h;
  const reaches = ([x0, y0, x1, y1]: readonly number[]) => clipToRect([x0!, y0!], [x1!, y1!], padded) !== null;
  /** At most one screen's diagonal of dashes, and a part dash, per leg. */
  const bound = (legs: number) => legs * (Math.ceil(Math.hypot(w + 2 * pad, h + 2 * pad) / PERIOD) + 2);
  /** The last point of the ground from tile centre a to b that the guarded projection gives, toward the near plane. */
  const lastInFront = (view: ReturnType<typeof camera>, a: StreamMark, b: StreamMark) => {
    const ground = Array.from({ length: 4001 }, (_, k) => view.inFront(a.tileX + 0.5 + (b.tileX - a.tileX) * k / 4000, a.tileY + 0.5 + (b.tileY - a.tileY) * k / 4000));
    return ground.filter((p) => Number.isFinite(p[0])).at(-1)!;
  };
  const near = patrol(1, 50, 77), close = patrol(2, 54, 85);

  it.each([
    { where: "between the camera and its near plane", d: 1e-4 },
    { where: "behind the camera", d: -1 },
  ])("draws a pair's leg toward the near plane, on screen only, with its other mark $where", ({ d }) => {
    const view = camera(poseFor(close, d));
    const a = markerAt(view.toScreen, near), b = view.toScreen(close.tileX + 0.5, close.tileY + 0.5);
    expect(onScreen(a)).toBe(true);
    expect(Number.isFinite(b[0]) && Number.isFinite(b[1])).toBe(true);
    expect(Number.isFinite(view.inFront(close.tileX + 0.5, close.tileY + 0.5)[0])).toBe(false);
    // Cut between the markers' points, the leg would take hundreds of thousands of dashes, or run the wrong way.
    if (d > 0) expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / PERIOD).toBeGreaterThan(1e5);
    const words = new Words({ w, h });
    view.calls = 0;
    words.update(frameOf([near, close]), view.toScreen, [], "v", [], 0, view.inFront);
    expect(view.calls).toBeLessThan(50);
    const [route] = words.drawnRoutes();
    expect(route!.ids).toEqual([1, 2]);
    const { dashes } = route!;
    expect(dashes.length).toBeGreaterThan(10);
    expect(dashes.length).toBeLessThanOrEqual(bound(1));
    // From clear of the marker's ring in front, straight on screen toward where the leg meets the near plane, to the
    // screen's edge.
    const far = lastInFront(view, near, close);
    expect(onScreen(far)).toBe(false);
    for (const [x0, y0, x1, y1] of dashes) {
      expect(reaches([x0, y0, x1, y1])).toBe(true);
      expect(offSegment([x0, y0], a, far)).toBeLessThan(1);
      expect(offSegment([x1, y1], a, far)).toBeLessThan(1);
    }
    expect(Math.hypot(dashes[0]![0] - a[0], dashes[0]![1] - a[1])).toBeCloseTo(MARK_DOT.ring + 3, 6);
    expect(onScreen([dashes.at(-1)![2], dashes.at(-1)![3]])).toBe(false);
    // Drawn as every route is: a light halo, then the owner's shade, one path per dash.
    const strokes = lineStrokes(words.layer.children[0] as Graphics);
    expect(strokes).toHaveLength(2);
    for (const s of strokes) expect(s.data.path.shapePath.shapePrimitives).toHaveLength(dashes.length);
  });

  it.each([
    { board: "3D", where: "just in front of the near plane", view: () => camera(poseFor(close, NEAR + 0.01)) },
    { board: "2D", where: "zoomed in", view: () => ({ calls: 0, toScreen: (x: number, y: number): [number, number] => [(x - 45) * 200, (y - 75) * 200], inFront: undefined }) },
  ])("cuts only the dashes on screen of a leg that runs far off the $board board $where, as they were cut before", ({ view: make }) => {
    const view = make();
    const a = markerAt(view.toScreen, near), b = markerAt(view.toScreen, close);
    expect(onScreen(a)).toBe(true);
    expect(onScreen(b)).toBe(false);
    const words = new Words({ w, h });
    words.update(frameOf([near, close]), view.toScreen, [], "v", [], 0, view.inFront ?? view.toScreen);
    const { dashes } = words.drawnRoutes()[0]!;
    const before = uncut([a, b]);
    const shown = before.filter(reaches);
    expect(shown.length).toBeLessThan(before.length);
    expect(dashes.length).toBeLessThanOrEqual(bound(1));
    expect(dashes).toHaveLength(shown.length);
    dashes.forEach((dash, i) => expect(sameDash(dash, shown[i]!)).toBe(true));
  });

  it("closes a loop through a mark between the camera and its near plane with two legs toward that plane", () => {
    const third = patrol(3, 48, 79);
    const view = camera(poseFor(close, 1e-4));
    const a = markerAt(view.toScreen, near), c = markerAt(view.toScreen, third);
    expect(onScreen(a) && onScreen(c)).toBe(true);
    const words = new Words({ w, h });
    words.update(frameOf([near, close, third]), view.toScreen, [], "v", [], 0, view.inFront);
    const [route] = words.drawnRoutes();
    expect(route!.ids).toEqual([1, 2, 3]);
    expect(route!.dashes.length).toBeLessThanOrEqual(bound(3));
    // Each dash on one leg: near mark to the plane, the third mark to the plane, or between the two in front, that one as before.
    const legs = [[a, lastInFront(view, near, close)], [c, lastInFront(view, third, close)], [c, a]] as const;
    const on = legs.map(() => 0);
    for (const dash of route!.dashes) {
      expect(reaches(dash)).toBe(true);
      const leg = legs.findIndex(([p, q]) => offSegment([dash[0], dash[1]], p, q) < 1 && offSegment([dash[2], dash[3]], p, q) < 1);
      expect(leg).toBeGreaterThanOrEqual(0);
      on[leg]!++;
    }
    expect(on.every((n) => n > 0)).toBe(true);
    const between = uncut([c, a]);
    expect(route!.dashes.filter((dash) => between.some((b) => sameDash(dash, b)))).toHaveLength(between.length);
    expect(on[2]).toBe(between.length);
  });
});

describe("air route on the public live and recorded stream", () => {
  // A served match (the default server config, whose public stream withholds the rules' name, seed and players) at
  // grid scale 2: three seats of colony 0 lay flyer PATROL marks through the engine's own inputs, two at tick 3 and a
  // third at tick 10, and the third's owner moves it at tick 115. Two flyers stand by the nest, so the marks send them
  // up. Each message goes out as the hub's public payload, and is recorded as the hub records it; a late spectator
  // joins on the full snapshot the hub builds at tick 120, while the flyers are airborne.
  const { simConfig, includeComparisonSetup } = comparisonOptions({}, DEFAULT_MCP_CONFIG);
  const lay = (agentId: string, tileX: number, tileY: number, markId?: number): SimInput =>
    ({ type: "count_mark", agentId, verb: "PATROL", caste: markId === undefined ? "flyer" : undefined, count: 2, tileX, tileY, markId });
  const inputs = (state: SimState): SimInput[] =>
    state.tick === 1 ? ["a", "b", "c"].map((agentId): SimInput => ({ type: "join", agentId, colony: 0 }))
    : state.tick === 3 ? [lay("a", 12, 40), lay("b", 20, 40)]
    : state.tick === 10 ? [lay("c", 20, 50)]
    : state.tick === 115 ? [lay("c", 22, 48, 3)] : [];
  const TICKS = 130, JOIN = 120;
  let state = createMatch(7001, simConfig!);
  for (const tileX of [16, 17]) addAnt(state, 0, tileX, 44, { caste: "worker", flyer: true });
  const recorder = new SpectatorRecorder(state);
  const hub = new LiveHub({ includeComparisonSetup });
  const opening = { ...recorder.initial(), full: recorder.initialFull() };
  const released = new SpectatorState(recorder.initialFull(), opening.tick, opening.ants);
  const payloads = [hub.payload(opening)];
  let join: Uint8Array | undefined;
  const joinAfter: Uint8Array[] = [];
  for (let i = 0; i < TICKS; i++) {
    const out = step(state, inputs(state));
    expect(out.results.every((r) => r.ok)).toBe(true);
    state = out.state;
    const record = recorder.record(out);
    released.apply(record);
    const payload = hub.payload({ ...record, full: null });
    payloads.push(payload);
    if (join !== undefined) joinAfter.push(payload);
    if (record.tick === JOIN) {
      const m = released.message();
      join = hub.payload({ ...m, full: { ...m.full!, match: 1 } });
    }
  }
  const decoded = payloads.map(decodeMessage);
  const joining = [join!, ...joinAfter].map(decodeMessage);
  const moved = { tileX: 22, tileY: 48 };

  // Both boards at the real board's size: 2D flat, 3D tilted over relief.
  const real = { w: simConfig!.mapWidth, h: simConfig!.mapHeight };
  const boards = [
    { board: "2D", toScreen: flat2d(1920, real.w) }, { board: "2D", toScreen: flat2d(390, real.w), w: 390, h: 844 },
    { board: "3D", toScreen: tilted3d(1920, 1080, real.w, real.h) }, { board: "3D", toScreen: tilted3d(390, 844, real.w, real.h), w: 390, h: 844 },
  ];
  /** The route each board draws for the frame, the same on every board; on a desktop screen every leg has its dashes. */
  const routeAt = (frame: Frame) => {
    const drawn = boards.map(({ toScreen, w = 1920, h = 1080 }) => {
      const words = new Words({ w, h });
      words.update(frame, toScreen, [], "v");
      if (w === 1920) expect(words.drawnRoutes().every((r) => r.dashes.length > 0)).toBe(true);
      return words.drawnRoutes().map((r) => r.ids);
    });
    for (const ids of drawn) expect(ids).toEqual(drawn[0]);
    return drawn[0];
  };
  const livePlay = (stream: readonly StreamMessage[], ms: number) => {
    const playback = new Playback(), frame = new Frame();
    for (let i = 0; i < stream.length && i * 100 <= ms + RENDER_DELAY_MS; i++) playback.push(stream[i]!, i * 100);
    playback.sample(ms + RENDER_DELAY_MS, frame);
    return frame;
  };

  it("carries the flyer marks with their caste on the public stream, which names no rules, at the flyer stream version", () => {
    expect(includeComparisonSetup).toBeUndefined();
    for (const full of [decoded[0]!.full!, joining[0]!.full!]) for (const field of ["rules", "seed", "players"]) expect(full.setup).not.toHaveProperty(field);
    expect(payloads[4]![2]).toBe(FLYER_STREAM_VERSION);
    expect(decoded[4]!.events.flatMap((e) => (e.kind === "mark" ? [[e.mark.id, e.mark.caste]] : []))).toEqual([[1, "flyer"], [2, "flyer"]]);
    expect(patrolRangeTiles(livePlay(decoded, 500).board!)).toBe(simConfig!.patrolLinkTiles);
  });

  it("draws the route live on both boards as marks are laid and moved", () => {
    expect(routeAt(livePlay(decoded, 500))).toEqual([[1, 2]]);
    expect(routeAt(livePlay(decoded, 1500))).toEqual([[1, 2, 3]]);
    const late = livePlay(decoded, 12_500);
    expect(late.board!.marks.find((m) => m.id === 3)).toMatchObject(moved);
    expect(routeAt(late)).toEqual([[1, 2, 3]]);
  });

  it("draws the route on both boards for a spectator who joins on the hub's snapshot while flyers are airborne", () => {
    expect(joining[0]!.ants.flyers?.filter((f) => f !== null && (f.state === "flying" || f.state === "hovering"))).toHaveLength(2);
    const joined = livePlay(joining, 500);
    expect(joined.board!.marks.map((m) => m.id).sort()).toEqual([1, 2, 3]);
    expect(routeAt(joined)).toEqual([[1, 2, 3]]);
  });

  const active: Recording[] = [];
  afterEach(() => { for (const r of active.splice(0)) r.close(); });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("draws the route on both boards in the stored recording, and after seeking forward and back", async () => {
    const objects: ReplayObject[] = [];
    const recording = new ReplayRecording(0, 1, { create: async (object) => { objects.push(object); } }, undefined, { includeComparisonSetup });
    for (const payload of payloads) recording.append(payload);
    expect(await recording.finish()).toBe(true);
    const bytes = new Uint8Array(gunzipSync(objects[0]!.body));
    for (const field of ["rules", "seed", "players"]) expect(decodeMessage(unpackMessages(bytes)[0]!).full!.setup).not.toHaveProperty(field);
    const r = openRecording("/recording", undefined, async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } })), { controls: true, endTick: async () => TICKS });
    active.push(r);
    await r.first;
    await vi.waitFor(() => expect(r.duration).toBe(TICKS * 100));
    const seek = async (ms: number) => {
      r.seek(ms);
      const playback = new Playback(), frame = new Frame();
      for (let i = 0; i < 100; i++) {
        await turn();
        for (const arrival of r.take(i * 16)) playback.push(arrival.m, arrival.at);
        playback.sample(r.time, frame);
        if (!r.seeking) return frame;
      }
      throw new Error("Seek never completed");
    };
    for (const [ms, ids] of [[12_500, [1, 2, 3]], [500, [1, 2]], [3000, [1, 2, 3]]] as const) {
      expect(routeAt(await seek(ms))).toEqual([ids]);
    }
    expect((await seek(12_500)).board!.marks.find((m) => m.id === 3)).toMatchObject(moved);
  });
});

describe("air route of a chain a colony's view shows only part of, live and recorded", () => {
  // A served match at grid scale 2, as above. At tick 3 each colony lays a four-mark flyer PATROL chain through the
  // engine's own inputs, its tiles in sight of a scout that has moved on by the next tick. From then on the colony's own
  // ants, about their nest, smell only some of its marks, so its view shows only those: colony 0 its chain's first and
  // third marks, which the chain never flies between though they lie within link range of each other; colony 1 its first
  // three, whose own loop would close from the third back to the first, a leg the chain does not fly (it flies the third
  // to the fourth, and the fourth back to the first). Full view draws every leg of both chains; a colony's view draws
  // only the legs between marks it shows, on both boards, live, after a join and in the stored recording after seeking.
  const { simConfig, includeComparisonSetup } = comparisonOptions({}, DEFAULT_MCP_CONFIG);
  const tiles = [[[31, 40], [42, 40], [31, 50], [42, 50]], [[96, 40], [96, 50], [100, 45], [86, 45]]] as const;
  const seats = [["a", "b", "c", "d"], ["e", "f", "g", "h"]] as const;
  const inputs = (state: SimState): SimInput[] =>
    state.tick === 1 ? seats.flatMap((ids, colony) => ids.map((agentId): SimInput => ({ type: "join", agentId, colony: colony as 0 | 1 })))
    : state.tick === 3 ? seats.flatMap((ids, colony) => ids.map((agentId, i): SimInput =>
      ({ type: "count_mark", agentId, verb: "PATROL", caste: "flyer", count: 2, tileX: tiles[colony]![i]![0], tileY: tiles[colony]![i]![1] })))
    : [];
  const TICKS = 30, JOIN = 20;
  let state = createMatch(7001, simConfig!);
  const scouts = [addAnt(state, 0, 36, 45), addAnt(state, 1, 91, 45)].map((ant) => ant.id);
  const recorder = new SpectatorRecorder(state);
  const hub = new LiveHub({ includeComparisonSetup });
  const opening = { ...recorder.initial(), full: recorder.initialFull() };
  const released = new SpectatorState(recorder.initialFull(), opening.tick, opening.ants);
  const payloads = [hub.payload(opening)];
  let join: Uint8Array | undefined;
  const joinAfter: Uint8Array[] = [];
  for (let i = 0; i < TICKS; i++) {
    const out = step(state, inputs(state));
    expect(out.results.every((r) => r.ok)).toBe(true);
    state = out.state;
    if (state.tick === 4) state.ants = state.ants.filter((ant) => !scouts.includes(ant.id));
    const record = recorder.record(out);
    released.apply(record);
    const payload = hub.payload({ ...record, full: null });
    payloads.push(payload);
    if (join !== undefined) joinAfter.push(payload);
    if (record.tick === JOIN) {
      const m = released.message();
      join = hub.payload({ ...m, full: { ...m.full!, match: 1 } });
    }
  }
  const decoded = payloads.map(decodeMessage);
  const joining = [join!, ...joinAfter].map(decodeMessage);
  const real = { w: simConfig!.mapWidth, h: simConfig!.mapHeight };
  const boards = [
    { board: "2D", w: 1920, h: 1080, toScreen: flat2d(1920, real.w) }, { board: "2D", w: 390, h: 844, toScreen: flat2d(390, real.w) },
    { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080, real.w, real.h) }, { board: "3D", w: 390, h: 844, toScreen: tilted3d(390, 844, real.w, real.h) },
  ];
  // Each chain's legs in its own order: the first mark to the second, the second to the third, and so on round the loop.
  const LOOP = ["0-1", "0-3", "1-2", "2-3"];
  const expected = {
    full: { marks: [1, 2, 3, 4, 5, 6, 7, 8], routes: [{ ids: [1, 2, 3, 4], legs: LOOP }, { ids: [5, 6, 7, 8], legs: LOOP }] },
    0: { marks: [1, 3], routes: [{ ids: [1, 3], legs: [] }] },
    1: { marks: [5, 6, 7], routes: [{ ids: [5, 6, 7], legs: ["0-1", "1-2"] }] },
  } as const;

  /** For each point of view, on each board: the marks shown, and each route's drawn marks and the legs its dashes lie on. */
  const check = (frame: Frame) => {
    const chains = [...new Set([...linkPatrolMarks(frame.board!.marks, simConfig!.patrolLinkTiles!).values()].map((p) => p.chain))];
    expect(chains.map((chain) => chain.map((m) => m.id))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    for (const choice of ["full", 0, 1] as const) {
      const view = new TeamView();
      view.choice = choice;
      const shown = view.apply(frame);
      const want = expected[choice];
      expect(shown.marks.map((v) => v.mark.id).sort((a, b) => a - b)).toEqual(want.marks);
      if (choice !== "full") {
        // Linked from only the marks shown, they would make a different loop: the first and third, or the first three.
        expect(airRoutes(shown.board!.marks, patrolRangeTiles(shown.board!)).map((r) => r.map((m) => m.id))).toEqual([want.marks]);
      }
      for (const { w, h, toScreen } of boards) {
        const words = new Words({ w, h });
        words.update(shown, toScreen, [], "v");
        const routes = words.drawnRoutes();
        expect(routes.map((r) => r.ids)).toEqual(want.routes.map((r) => r.ids));
        routes.forEach((route, i) => {
          const chain = chains.find((c) => c.some((m) => m.id === route.ids[0]))!;
          const legs = legsOf(route.dashes, chain.map((m) => markerAt(toScreen, m)));
          // Never a leg the chain does not fly; on a desktop screen every leg it flies between shown marks has its dashes.
          for (const leg of legs) expect(want.routes[i]!.legs).toContain(leg);
          if (w === 1920) expect(legs).toEqual(want.routes[i]!.legs);
        });
        // Each shown mark of a route wears the route's light ring.
        const rings = shapes(words.layer.children[0] as Graphics, "circle", "stroke").filter((c) => c.radius === AIR_ROUTE.ringR);
        expect(rings).toHaveLength(want.routes.reduce((n, r) => n + r.ids.length, 0));
      }
    }
  };
  const livePlay = (stream: readonly StreamMessage[], ms: number) => {
    const playback = new Playback(), frame = new Frame();
    for (let i = 0; i < stream.length && i * 100 <= ms + RENDER_DELAY_MS; i++) playback.push(stream[i]!, i * 100);
    playback.sample(ms + RENDER_DELAY_MS, frame);
    return frame;
  };

  it("draws only the legs each chain flies, in full view and each colony's view, live and after a join", () => {
    for (const ms of [800, 1500, 2500]) check(livePlay(decoded, ms));
    check(livePlay(joining, 500));
  });

  const active: Recording[] = [];
  afterEach(() => { for (const r of active.splice(0)) r.close(); });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("draws only the legs each chain flies in the stored recording, after seeking forward and back", async () => {
    const objects: ReplayObject[] = [];
    const recording = new ReplayRecording(0, 1, { create: async (object) => { objects.push(object); } }, undefined, { includeComparisonSetup });
    for (const payload of payloads) recording.append(payload);
    expect(await recording.finish()).toBe(true);
    const bytes = new Uint8Array(gunzipSync(objects[0]!.body));
    const r = openRecording("/recording", undefined, async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } })), { controls: true, endTick: async () => TICKS });
    active.push(r);
    await r.first;
    await vi.waitFor(() => expect(r.duration).toBe(TICKS * 100));
    const seek = async (ms: number) => {
      r.seek(ms);
      const playback = new Playback(), frame = new Frame();
      for (let i = 0; i < 100; i++) {
        await turn();
        for (const arrival of r.take(i * 16)) playback.push(arrival.m, arrival.at);
        playback.sample(r.time, frame);
        if (!r.seeking) return frame;
      }
      throw new Error("Seek never completed");
    };
    for (const ms of [2500, 800, 1500]) check(await seek(ms));
  });
});
