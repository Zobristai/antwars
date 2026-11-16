// Each airborne flyer, flying or hovering, shows a line on the ground to its current destination on both boards,
// following the destination when it moves, in live and recorded playback, after a seek and when joining while
// flyers are airborne; a message with no flyer draws nothing. Every message reaches the board through the stream's bytes.
import { describe, expect, it } from "vitest";
import { SUB_TILE, decodeMessage, encodeMessage, encodeReplayMessage, type StreamFlyer, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { fitTilted, projector } from "../../web/src/board3d/view.ts";
import { colonyTint } from "../../web/src/colony-palette.ts";
import { FLIGHT_LINE, FlightLines, flightLines, flightPath, type FlightLine } from "../../web/src/flight-lines.ts";
import { flyerOf } from "../../web/src/flyer-state.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

/** One initial snapshot for its board; every ant below is constructed, no match is played. */
const head = decodeMessage(scale2Packets(1)[0]!);
const W = head.full!.setup.mapW, H = head.full!.setup.mapH;

type Ant = { id: number; colony: 0 | 1; x: number; y: number; flyer: StreamFlyer | null };
const flying = (x: number, y: number): StreamFlyer => ({ state: "flying", destX: Math.round(x * SUB_TILE), destY: Math.round(y * SUB_TILE) });
const hovering = (x: number, y: number): StreamFlyer => ({ state: "hovering", destX: Math.round(x * SUB_TILE), destY: Math.round(y * SUB_TILE) });

/**
 * Colony 0 near (20, 20), colony 1 far off at (110, 80), out of colony 0's sight. Ant 1 (colony 1) is not a flyer
 * and sorts first, so a colony 0 view shifts every colony 0 ant's index; ant 2 flies to a destination that moves
 * at tick 5, ant 3 hovers, ant 4 is grounded, ant 5 (colony 1) is locked out, and ant 6 (colony 1) flies within
 * colony 0's sight toward its own side.
 */
function ants(tick: number, flyers = true): Ant[] {
  const t = tick - head.tick;
  return [
    { id: 1, colony: 1, x: 110, y: 80, flyer: null },
    { id: 2, colony: 0, x: 24 + t * 0.5, y: 20, flyer: flying(t < 5 ? 60 : 70, t < 5 ? 40 : 30) },
    { id: 3, colony: 0, x: 18, y: 24, flyer: hovering(18.25, 24.5) },
    { id: 4, colony: 0, x: 20, y: 18, flyer: { state: "grounded" } },
    { id: 5, colony: 1, x: 112, y: 82, flyer: { state: "lockedOut", takeOffTick: tick + 20 } },
    { id: 6, colony: 1, x: 26, y: 22, flyer: flying(100, 70) },
  ].map((a) => ({ ...a, flyer: flyers ? a.flyer : null })) as Ant[];
}

function message(tick: number, options: { full?: boolean; flyers?: boolean } = {}): StreamMessage {
  const rows = ants(tick, options.flyers ?? true);
  const n = rows.length;
  return {
    tick,
    full: options.full ? structuredClone(head.full) : null,
    ants: {
      count: n,
      id: Uint32Array.from(rows.map((a) => a.id)),
      x: Uint16Array.from(rows.map((a) => Math.round(a.x * SUB_TILE))),
      y: Uint16Array.from(rows.map((a) => Math.round(a.y * SUB_TILE))),
      heading: new Uint8Array(n), colony: Uint8Array.from(rows.map((a) => a.colony)),
      agent: new Int16Array(n).fill(-1), caste: new Uint8Array(n), carrying: new Uint8Array(n),
      ...(options.flyers ?? true ? { flyers: rows.map((a) => a.flyer) } : {}),
    },
    events: [],
  };
}

/** Messages from tick `from` for `count` ticks, the first a full snapshot, as a recording or the live stream sends them. */
function rows(from: number, count: number, flyers = true): StreamMessage[] {
  return Array.from({ length: count }, (_, i) => message(from + i, { full: i === 0, flyers }));
}

/**
 * A Playback fed every row on arrival at its own tick time, then the frame at `tick` (live waits out its opening buffer).
 * Each row goes through the stream's own bytes first, as the live stream or a recording sends it.
 */
function frameAt(live: boolean, feed: readonly StreamMessage[], tick: number): Frame {
  const pb = new Playback({ live });
  for (const m of feed) pb.push(decodeMessage(live ? encodeMessage(m) : encodeReplayMessage(m)), (m.tick - feed[0]!.tick) * TICK_MS);
  const f = new Frame();
  for (let now = 0; now < 120_000; now += 10) {
    if (pb.sample(now + (live ? 0 : RENDER_DELAY_MS), f) && f.renderMs >= tick * TICK_MS) return f;
  }
  throw new Error(`no frame reached tick ${tick}`);
}

const lineOf = (f: Frame, id: number) => flightLines(f).find((l) => l.antId === id);
const at = (f: Frame, id: number): [number, number] => {
  const i = f.id.subarray(0, f.count).indexOf(id);
  return [f.drawX?.[i] ?? f.x[i]!, f.drawY?.[i] ?? f.y[i]!];
};

describe("flight lines from the sampled stream", () => {
  for (const live of [false, true]) describe(live ? "live playback" : "recorded playback", () => {
    it("draws one line per flying or hovering flyer, from where its body is to its destination, and none for any other ant", () => {
      const f = frameAt(live, rows(head.tick, 4), head.tick + 1);
      const lines = flightLines(f);
      expect(lines.map((l) => l.antId)).toEqual([2, 3, 6]);
      expect(lines.map((l) => l.hovering)).toEqual([false, true, false]);
      expect(lines.map((l) => l.colony)).toEqual([0, 0, 1]);
      expect(lineOf(f, 2)!.from).toEqual(at(f, 2));
      expect(lineOf(f, 2)!.to).toEqual([60, 40]);
      expect(lineOf(f, 3)!.to).toEqual([18.25, 24.5]);
      expect(lineOf(f, 6)!.to).toEqual([100, 70]);
    });

    it("follows the destination when it moves, and the flyer as it flies", () => {
      const feed = rows(head.tick, 10);
      const before = frameAt(live, feed, head.tick + 3), after = frameAt(live, feed, head.tick + 7);
      expect(lineOf(before, 2)!.to).toEqual([60, 40]);
      expect(lineOf(after, 2)!.to).toEqual([70, 30]);
      expect(lineOf(after, 2)!.from[0]).toBeGreaterThan(lineOf(before, 2)!.from[0]);
      expect(lineOf(after, 2)!.from).toEqual(at(after, 2));
    });

    it("shows every airborne flyer's line on the first frame after a seek or on joining mid-flight", () => {
      // A seek starts a fresh Playback at a later snapshot; joining live starts at whatever snapshot the stream sends.
      const f = frameAt(live, rows(head.tick + 40, 3), head.tick + 40);
      expect(flightLines(f).map((l) => [l.antId, l.to])).toEqual([[2, [70, 30]], [3, [18.25, 24.5]], [6, [100, 70]]]);
    });
  });

  it("in a colony's view, finds each shown flyer by id and shows only that colony's own flyers' destinations", () => {
    const f = frameAt(false, rows(head.tick, 4), head.tick + 1);
    const view = new TeamView();
    view.choice = 0;
    const own = view.apply(f);
    // The enemy flyer in sight is shown; the far enemy ants are not, so no shown index is the message's.
    expect([...own.id.subarray(0, own.count)]).toEqual([2, 3, 4, 6]);
    expect([0, 1, 2, 3].map((i) => flyerOf(own, i)?.state)).toEqual(["flying", "hovering", "grounded", "flying"]);
    expect(flightLines(own, 0).map((l) => [l.antId, l.to])).toEqual([[2, [60, 40]], [3, [18.25, 24.5]]]);
    const layer = new FlightLines();
    layer.update(own, (tx, ty) => [tx * 10, ty * 10], 0);
    expect(layer.drawn().map((d) => d.antId)).toEqual([2, 3]);
    // TeamView reuses its output frame, so the other colony's view is applied only once the first is checked.
    view.choice = 1;
    const theirs = view.apply(f);
    expect(flightLines(theirs, 1).map((l) => [l.antId, l.to])).toEqual([[6, [100, 70]]]);
  });

  it("draws nothing for a message with no flyer, and clears what it drew when flyers are gone", () => {
    const lines = new FlightLines();
    const flat = (tx: number, ty: number): [number, number] => [tx * 10, ty * 10];
    const quiet = frameAt(false, rows(head.tick, 4, false), head.tick + 1);
    expect(quiet.ants!.flyers).toBeUndefined();
    expect(flightLines(quiet)).toEqual([]);
    lines.update(quiet, flat);
    expect(lines.layer.context.instructions).toHaveLength(0);
    lines.update(frameAt(false, rows(head.tick, 4), head.tick + 1), flat);
    expect(lines.drawn()).toHaveLength(3);
    lines.update(quiet, flat);
    expect(lines.drawn()).toHaveLength(0);
    expect(lines.layer.context.instructions).toHaveLength(0);
  });
});

type Ins = { action: string; data: { style: { color: number; width: number } } };
const relief = (tx: number, ty: number) => 0.4 * Math.sin(tx / 3) * Math.cos(ty / 4);
const views = [
  { board: "2D", w: 1920, h: 1080, toScreen: (tx: number, ty: number): [number, number] => [tx * 1920 / W, ty * 1920 / W] },
  { board: "2D", w: 390, h: 844, toScreen: (tx: number, ty: number): [number, number] => [tx * 390 / W, ty * 390 / W] },
  ...[[1920, 1080], [390, 844]].map(([w, h]) => {
    const project = projector(fitTilted(W, H, w!, h!, { x0: 0, y0: 0, x1: w!, y1: h! }).pose, w!, h!);
    return { board: "3D", w: w!, h: h!, toScreen: (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), H - ty]) ?? [NaN, NaN] };
  }),
];

describe("flight lines on the boards", () => {
  it.each(views)("draws a dashed line on the ground from the flyer to a ring at its destination on the $board board at $w x $h", ({ toScreen }) => {
    const f = frameAt(false, rows(head.tick, 4), head.tick + 1);
    const layer = new FlightLines();
    layer.update(f, toScreen);
    const drawn = layer.drawn().find((d) => d.antId === 2)!;
    const line = lineOf(f, 2)!;
    const start = toScreen(...line.from), end = toScreen(...line.to);
    expect(drawn.end![0]).toBeCloseTo(end[0]);
    expect(drawn.end![1]).toBeCloseTo(end[1]);
    // The ground under the line, densely projected: every dash point lies on it, so on 3D it follows the relief.
    const ground = Array.from({ length: 2001 }, (_, k) => toScreen(line.from[0] + (line.to[0] - line.from[0]) * k / 2000, line.from[1] + (line.to[1] - line.from[1]) * k / 2000));
    const off = (p: [number, number]) => Math.min(...ground.map((g) => Math.hypot(g[0] - p[0], g[1] - p[1])));
    const points = drawn.dashes.flat();
    for (const p of points) expect(off(p)).toBeLessThan(1);
    // Dashes of the pattern's length, clear of the flyer and of the end ring.
    const first = drawn.dashes[0]![0]!, last = drawn.dashes.at(-1)!.at(-1)!;
    expect(Math.hypot(first[0] - start[0], first[1] - start[1])).toBeGreaterThan(FLIGHT_LINE.startGap - 1);
    expect(Math.hypot(last[0] - end[0], last[1] - end[1])).toBeGreaterThan(FLIGHT_LINE.endR - 1);
    const length = (d: [number, number][]) => d.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - d[k]![0], p[1] - d[k]![1]), 0);
    for (const d of drawn.dashes.slice(0, -1)) expect(length(d)).toBeCloseTo(FLIGHT_LINE.dash, 3);
    const span = length(ground);
    expect(drawn.dashes.length).toBeGreaterThanOrEqual(Math.floor((span - FLIGHT_LINE.startGap - FLIGHT_LINE.endR) / (FLIGHT_LINE.dash + FLIGHT_LINE.gap)) - 1);
    // Stroked in the flyer's colony colour over a dark edge.
    const strokes = (layer.layer.context.instructions as unknown as Ins[]).filter((i) => i.action === "stroke");
    expect(strokes.some((s) => s.data.style.color === colonyTint(0) && s.data.style.width === FLIGHT_LINE.width)).toBe(true);
    expect(strokes.some((s) => s.data.style.color === 0x000000)).toBe(true);
    for (const p of [...points, drawn.end!]) {
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
    }
  });

  it.each([1, 3, 6, 9.5, 12, 19.5])("keeps a visible connector from the flyer to its ring when they are %s px apart", (px) => {
    const flat = (tx: number, ty: number): [number, number] => [tx, ty];
    const drawn = flightPath({ antId: 1, colony: 0, hovering: false, from: [100, 100], to: [100 + px * 0.6, 100 + px * 0.8], alpha: 1 }, flat)!;
    expect(drawn.dashes.length).toBeGreaterThan(0);
    const length = (d: [number, number][]) => d.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - d[k]![0], p[1] - d[k]![1]), 0);
    expect(drawn.dashes.reduce((s, d) => s + length(d), 0)).toBeGreaterThanOrEqual(Math.min(FLIGHT_LINE.dash, px / 2) - 1e-9);
    const first = drawn.dashes[0]![0]!;
    expect(Math.hypot(first[0] - 100, first[1] - 100)).toBeCloseTo(Math.min(FLIGHT_LINE.startGap, px * FLIGHT_LINE.shortGapShare));
  });

  // Each pair puts a dash bound within rounding of a sampled point at this scale, which once stalled the walk.
  it.each([
    [[123.3, 63.05], [122.22, 62]], [[35.49, 32.53], [34.13, 32.79]], [[13.32, 39.68], [12.57, 38.35]],
    [[55.89, 25.24], [57.16, 24.59]], [[45.04, 80.64], [46.54, 80.34]],
  ] as [number, number][][])("finishes the line from %j to %j when a dash bound rounds onto a sampled point", (from, to) => {
    const scaled = (tx: number, ty: number): [number, number] => [tx * 15, ty * 15];
    const drawn = flightPath({ antId: 1, colony: 0, hovering: false, from: from!, to: to!, alpha: 1 }, scaled)!;
    const length = (d: [number, number][]) => d.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - d[k]![0], p[1] - d[k]![1]), 0);
    expect(drawn.dashes.length).toBeGreaterThan(0);
    for (const d of drawn.dashes) expect(length(d)).toBeLessThanOrEqual(FLIGHT_LINE.dash + 1e-9);
  });

  it("keeps every on-screen dash of a line that runs off screen, and cuts none off it", () => {
    const flat = (tx: number, ty: number): [number, number] => [tx * 10, ty * 10];
    const line: FlightLine = { antId: 1, colony: 0, hovering: false, from: [20, 20], to: [80, 50], alpha: 1 };
    const screen = { x0: 0, y0: 0, x1: 390, y1: 844 };
    const all = flightPath(line, flat)!, shown = flightPath(line, flat, screen)!;
    const pad = FLIGHT_LINE.width / 2 + FLIGHT_LINE.edge + 1;
    const inside = (d: [number, number][]) => d.every((p) => p[0] >= -pad && p[0] <= 390 + pad && p[1] >= -pad && p[1] <= 844 + pad);
    expect(shown.dashes.every(inside)).toBe(true);
    expect(shown.dashes.length).toBeLessThan(all.dashes.length);
    expect(shown.dashes.filter((d) => d.every((p) => p[0] < 390 + pad - 1e-9))).toEqual(all.dashes.filter(inside));
    expect(shown.end).toEqual(all.end);
  });

  it("cuts a 3D route that projects millions of px off screen near the camera only where it shows", () => {
    // A close tilted camera on a 128 x 128 board: this route's flyer end projects about nine million px off screen.
    const [w, h] = [1920, 1080];
    const project = projector({ alpha: 315 * Math.PI / 180, beta: 1.2, radius: 4, target: [50, 0, 50] }, w, h);
    const toScreen = (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), 128 - ty]) ?? [NaN, NaN];
    const line: FlightLine = { antId: 1, colony: 0, hovering: false, from: [51, 83], to: [51, 82], alpha: 1 };
    const start = toScreen(...line.from), end = toScreen(...line.to);
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeGreaterThan(1e6);
    const drawn = flightPath(line, toScreen, { x0: 0, y0: 0, x1: w, y1: h })!;
    const pad = FLIGHT_LINE.width / 2 + FLIGHT_LINE.edge + 1;
    for (const p of drawn.dashes.flat()) {
      expect(p[0]).toBeGreaterThanOrEqual(-pad - 1e-9);
      expect(p[0]).toBeLessThanOrEqual(w + pad + 1e-9);
      expect(p[1]).toBeGreaterThanOrEqual(-pad - 1e-9);
      expect(p[1]).toBeLessThanOrEqual(h + pad + 1e-9);
    }
    // No more dashes than fit across the screen's diagonal.
    expect(drawn.dashes.length).toBeLessThanOrEqual(Math.ceil(Math.hypot(w + 2 * pad, h + 2 * pad) / (FLIGHT_LINE.dash + FLIGHT_LINE.gap)) + 1);
  });

  it("draws the visible route of a 3D flyer whose destination is behind the camera, with no ring", () => {
    // A close tilted camera on a 128 x 128 board: the flyer at (50, 78) is on screen, its destination at (50, 83) behind the camera.
    const [w, h] = [1920, 1080];
    const project = projector({ alpha: -Math.PI / 2, beta: 1.2, radius: 4, target: [50, 0, 50] }, w, h);
    const toScreen = (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), 128 - ty]) ?? [NaN, NaN];
    const line: FlightLine = { antId: 1, colony: 0, hovering: false, from: [50, 78], to: [50, 83], alpha: 1 };
    const flyer = toScreen(...line.from);
    expect(flyer[0] >= 0 && flyer[0] <= w && flyer[1] >= 0 && flyer[1] <= h).toBe(true);
    expect(Number.isFinite(toScreen(...line.to)[0])).toBe(false);
    const drawn = flightPath(line, toScreen, { x0: 0, y0: 0, x1: w, y1: h })!;
    expect(drawn.end).toBeNull();
    expect(drawn.dashes.length).toBeGreaterThan(0);
    // The line leaves the flyer as any line does, a start gap away from it.
    const first = drawn.dashes[0]![0]!;
    expect(Math.hypot(first[0] - flyer[0], first[1] - flyer[1])).toBeCloseTo(FLIGHT_LINE.startGap);
    // Every dash on the ground under the route's visible part.
    const ground = Array.from({ length: 4001 }, (_, k) => toScreen(50, 78 + 5 * k / 4000)).filter((p) => Number.isFinite(p[0]));
    const off = (p: [number, number]) => Math.min(...ground.map((g) => Math.hypot(g[0] - p[0], g[1] - p[1])));
    for (const p of drawn.dashes.flat()) expect(off(p)).toBeLessThan(1);
  });

  it("draws a flyer's line up to where its destination stops projecting, and no ring for it", () => {
    // Ant 2 flies to (60, 40); nothing at or beyond tile x 59 projects here.
    const cut = (tx: number, ty: number): [number, number] => (tx >= 59 ? [NaN, NaN] : [tx * 10, ty * 10]);
    const layer = new FlightLines();
    layer.update(frameAt(false, rows(head.tick, 4), head.tick + 1), cut);
    const drawn = layer.drawn().find((d) => d.antId === 2)!;
    expect(drawn.end).toBeNull();
    expect(drawn.dashes.length).toBeGreaterThan(0);
    for (const p of drawn.dashes.flat()) expect(p[0]).toBeLessThanOrEqual(590 + 1e-6);
    expect(Math.max(...drawn.dashes.flat().map((p) => p[0]))).toBeGreaterThan(590 - FLIGHT_LINE.dash - FLIGHT_LINE.gap);
  });

  it("redraws the line to a moved destination on the next frame", () => {
    const feed = rows(head.tick, 10);
    const layer = new FlightLines();
    const { toScreen } = views[2]!;
    layer.update(frameAt(false, feed, head.tick + 3), toScreen);
    expect(layer.drawn().find((d) => d.antId === 2)!.end).toEqual(toScreen(60, 40));
    layer.update(frameAt(false, feed, head.tick + 7), toScreen);
    expect(layer.drawn().find((d) => d.antId === 2)!.end).toEqual(toScreen(70, 30));
  });
});
