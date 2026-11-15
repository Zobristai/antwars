// A flyer LINE mark, the wall its flyers hold in the air, reads on both boards as an air segment: a solid bar lifted
// above the ground between its two ends, with a post at each end and a shadow on the ground, never the ground LINE's
// dotted line. Live, recorded, after a seek and on joining, it is drawn from the marks of the message shown, so it
// follows a moved mark.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Graphics } from "pixi.js";
import { decodeMessage, encodeMessage, type StreamEvent, type StreamMark, type StreamMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { fitTilted, projector, type Pose } from "../../web/src/board3d/view.ts";
import { MARK_DOT } from "../../web/src/compose.ts";
import { openRecording, type Recording } from "../../web/src/recording.ts";
import { AIR_SEGMENT, LINE_DOTS, Words, airLineEnd, lineEnd } from "../../web/src/words.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

type Shape = { type: string; x?: number; y?: number; radius?: number; points?: number[] };
type Instruction = { action: string; data: { path: { shapePath: { shapePrimitives: { shape: Shape }[] } } } };
const shapes = (g: Graphics, type: string, action = "fill"): Shape[] =>
  (g.context.instructions as unknown as Instruction[]).filter((i) => i.action === action)
    .flatMap((i) => i.data.path.shapePath.shapePrimitives.map((p) => p.shape).filter((s) => s.type === type));
const flat = (points: readonly (readonly [number, number])[]) => points.flatMap(([x, y]) => [x, y]);

const W = 64, H = 48;
const ground: StreamMark = { id: 5, agent: 2, colony: 1, tileX: 10, tileY: 30, toTileX: 50, toTileY: 30, words: [], verb: "LINE", count: 20, claimed: 12, answered: 12, laidTick: 1 };
const air: StreamMark = { ...ground, id: 6, tileY: 10, toTileY: 18, caste: "flyer" };
const frameOf = (...marks: StreamMark[]): Frame => ({ tick: 10, board: { marks, agents: [] }, marks: marks.map((mark) => ({ mark, ageMs: 5000 })) }) as unknown as Frame;

const flat2d = (w: number) => {
  const px = w / W;
  return (tx: number, ty: number): [number, number] => [tx * px, ty * px];
};
const relief = (tx: number, ty: number) => 0.4 * Math.sin(tx / 3) * Math.cos(ty / 4);
const tilted3d = (w: number, h: number, mapW = W, mapH = H) => {
  const project = projector(fitTilted(mapW, mapH, w, h, { x0: 0, y0: 0, x1: w, y1: h }).pose, w, h);
  return (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), mapH - ty]) ?? [NaN, NaN];
};

describe("flyer LINE mark on the boards", () => {
  const views = [
    { board: "2D", w: 1920, h: 1080, toScreen: flat2d(1920) },
    { board: "2D", w: 390, h: 844, toScreen: flat2d(390) },
    { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080) },
    { board: "3D", w: 390, h: 844, toScreen: tilted3d(390, 844) },
  ];

  it.each(views)("draws an air segment, not the ground LINE's dots, on the $board board at $w x $h", ({ w, h, toScreen }) => {
    const words = new Words({ w, h });
    words.update(frameOf(air), toScreen, [], "v");
    const [sx, sy] = toScreen(10.5, 10.5).map(Math.round) as [number, number];
    const [ex, ey] = toScreen(50.5, 18.5);
    expect(words.drawnLines()).toEqual([]);
    const [seg] = words.drawnAirSegments();
    expect(seg!.id).toBe(6);
    // The ground path runs whole from the marker to the far end's tile centre through the board's projection, with a
    // post at each end; the bar is the same path lifted up the screen.
    expect(seg!.ground).toHaveLength(1);
    const [path] = seg!.ground, [bar] = seg!.air;
    expect(path![0]).toEqual([sx, sy]);
    expect(path!.at(-1)![0]).toBeCloseTo(ex);
    expect(path!.at(-1)![1]).toBeCloseTo(ey);
    expect(seg!.start).toEqual(path![0]);
    expect(seg!.end).toEqual(path!.at(-1));
    expect(bar).toEqual(path!.map(([x, y]) => [x, y - AIR_SEGMENT.lift]));
    expect(path!.length).toBeGreaterThanOrEqual(Math.ceil(Math.hypot(ex - sx, ey - sy) / AIR_SEGMENT.step));
    for (const [x, y] of [...path!, ...bar!]) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(w);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(h);
    }
    const g = words.layer.children[0] as Graphics;
    // None of the ground LINE's dots or its end dot: the only filled circles are none, the rings are the marker's.
    expect(shapes(g, "circle")).toEqual([]);
    expect(shapes(g, "circle", "stroke").filter((c) => c.radius === MARK_DOT.ring)).toHaveLength(2);
    // Stroked: the ground shadow once, each post and the lifted bar each on a dark casing and in the owner's shade.
    const strokes = shapes(g, "polygon", "stroke").map((p) => p.points);
    expect(strokes.filter((p) => JSON.stringify(p) === JSON.stringify(flat(path!)))).toHaveLength(1);
    expect(strokes.filter((p) => JSON.stringify(p) === JSON.stringify(flat(bar!)))).toHaveLength(2);
    for (const i of [0, path!.length - 1]) {
      expect(strokes.filter((p) => JSON.stringify(p) === JSON.stringify(flat([path![i]!, bar![i]!])))).toHaveLength(2);
    }
    // The count label stays the count marks' own, beside the marker, and clear of the far end's post.
    const [label] = words.drawnLabels();
    expect(label!.text).toBe("12/20");
    const [gx, gy] = seg!.end!;
    const post = { x0: gx - AIR_SEGMENT.w, y0: gy - AIR_SEGMENT.lift - AIR_SEGMENT.w, x1: gx + AIR_SEGMENT.w, y1: gy + AIR_SEGMENT.w };
    expect(label!.rect.x1 < post.x0 || label!.rect.x0 > post.x1 || label!.rect.y1 < post.y0 || label!.rect.y0 > post.y1).toBe(true);
  });

  it.each(views)("keeps the ground LINE beside it dotted, with no air segment, on the $board board at $w x $h", ({ w, h, toScreen }) => {
    const words = new Words({ w, h });
    words.update(frameOf(ground, air), toScreen, [], "v");
    expect(words.drawnLines().map((l) => l.id)).toEqual([5]);
    expect(words.drawnAirSegments().map((s) => s.id)).toEqual([6]);
    const g = words.layer.children[0] as Graphics;
    const [line] = words.drawnLines();
    expect(shapes(g, "circle").filter((c) => c.radius === LINE_DOTS.r)).toHaveLength(line!.dots.length);
    expect(shapes(g, "circle").filter((c) => c.radius === LINE_DOTS.endR)).toHaveLength(1);
  });

  it("draws no air segment for any ground mark, a worker or soldier LINE included, nor for a flyer mark of another verb", () => {
    const marks: StreamMark[] = [
      ground,
      { ...ground, id: 7, tileY: 5, toTileY: 5, caste: "worker" },
      { ...ground, id: 8, tileY: 15, toTileY: 15, caste: "soldier" },
      { ...ground, id: 9, verb: "PATROL", toTileX: undefined, toTileY: undefined, tileY: 20, caste: "flyer" },
      { ...ground, id: 10, verb: "GATHER", toTileX: undefined, toTileY: undefined, tileY: 25, caste: "flyer" },
      { ...ground, id: 11, verb: undefined, words: [0, 1], toTileX: undefined, toTileY: undefined, tileY: 35 },
      { ...air, id: 12, toTileX: undefined, toTileY: undefined, tileY: 40 },
    ];
    expect(marks.map(airLineEnd)).toEqual([null, null, null, null, null, null, null]);
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf(...marks), flat2d(1920), [], "v");
    expect(words.drawnAirSegments()).toEqual([]);
    expect(words.drawnLines().map((l) => l.id)).toEqual([5, 7, 8]);
    expect(airLineEnd(air)).toEqual(lineEnd(air));
  });
});

// A camera close to the ground, as the 3D board's orbit allows: a segment end near the camera's near plane projects
// millions of px off screen, and one behind the camera does not project at all (the board's guarded projection gives
// it no screen point). What is drawn is the part on screen, at a cost that does not grow with how far the rest projects.
describe("flyer LINE mark with the 3D camera close to the ground", () => {
  const [w, h] = [1920, 1080];
  const mark: StreamMark = { ...air, id: 20, tileX: 50, tileY: 77, toTileX: 51, toTileY: 82 };
  /** A 128 x 128 board's ground through pose, as the 3D board's guarded projection gives it, counting its calls. */
  const close = (pose: Pose, height: (tx: number, ty: number) => number) => {
    const project = projector(pose, w, h);
    const counted = { calls: 0, toScreen: (tx: number, ty: number): [number, number] => {
      counted.calls++;
      return project([tx, height(tx, ty), 128 - ty]) ?? [NaN, NaN];
    } };
    return counted;
  };
  // Everything drawn is on screen, with room for the bar's stroke and its lift above the ground.
  const margin = AIR_SEGMENT.lift + AIR_SEGMENT.w + 4;
  const nearScreen = ([x, y]: readonly [number, number]) => x >= -margin && x <= w + margin && y >= -margin && y <= h + margin;
  const onScreen = ([x, y]: readonly [number, number]) => x > 0 && x < w && y > 0 && y < h;

  it("draws its part on screen with bounded samples when its far end projects millions of px away", () => {
    // Flat ground; the far end's tile centre is 0.0001 in front of the camera.
    const pose: Pose = { alpha: -Math.PI / 2, beta: 1.2, radius: 4, target: [50.5, 0, 45.5 + (4 - 0.0001) / Math.sin(1.2)] };
    const view = close(pose, () => 0);
    const start = view.toScreen(50.5, 77.5), end = view.toScreen(51.5, 82.5);
    expect(onScreen(start)).toBe(true);
    // Sampled AIR_SEGMENT.step px apart on screen with no bound, it would take millions of points.
    expect(Math.hypot(end[0] - start[0], end[1] - start[1]) / AIR_SEGMENT.step).toBeGreaterThan(1e6);
    const words = new Words({ w, h });
    view.calls = 0;
    words.update(frameOf(mark), view.toScreen, [], "v");
    // About one projection per sample: the marker's point, the ends, and at most AIR_SEGMENT.maxSteps pieces.
    expect(view.calls).toBeLessThan(2 * AIR_SEGMENT.maxSteps);
    const [seg] = words.drawnAirSegments();
    // The marker's post and the bar from the marker to the screen's edge; no post for the far end, far off screen.
    expect(seg!.start).toEqual(start.map(Math.round));
    expect(seg!.end).toBeNull();
    expect(seg!.ground).toHaveLength(1);
    const [path] = seg!.ground, [bar] = seg!.air;
    expect(path![0]).toEqual(seg!.start);
    expect(onScreen(path!.at(-1)!)).toBe(false);
    expect(bar).toEqual(path!.map(([x, y]) => [x, y - AIR_SEGMENT.lift]));
    for (const p of [...path!, ...bar!]) expect(nearScreen(p)).toBe(true);
    // On flat ground the segment is straight on screen: every point drawn lies on it.
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const [ux, uy] = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
    for (const [x, y] of path!) expect(Math.abs((x - start[0]) * uy - (y - start[1]) * ux)).toBeLessThan(1);
    // Drawn as the shadow once and the bar on its casing and in the owner's shade, and one post on its casing and shade.
    const g = words.layer.children[0] as Graphics;
    const strokes = shapes(g, "polygon", "stroke").map((p) => p.points);
    expect(strokes.filter((p) => JSON.stringify(p) === JSON.stringify(flat(path!)))).toHaveLength(1);
    expect(strokes.filter((p) => JSON.stringify(p) === JSON.stringify(flat(bar!)))).toHaveLength(2);
    expect(strokes.filter((p) => p!.length === 4)).toHaveLength(2);
  });

  it("draws the part in front of the camera when its far end is behind it, on the ground's relief, with no post there", () => {
    const pose: Pose = { alpha: -Math.PI / 2, beta: 1.2, radius: 4, target: [50, 0, 50] };
    const view = close(pose, relief);
    const behind = { ...mark, toTileX: 50 };
    const start = view.toScreen(50.5, 77.5);
    expect(onScreen(start)).toBe(true);
    expect(Number.isFinite(view.toScreen(50.5, 82.5)[0])).toBe(false);
    const words = new Words({ w, h });
    view.calls = 0;
    words.update(frameOf(behind), view.toScreen, [], "v");
    // As above, with the search for where the segment crosses the near plane.
    expect(view.calls).toBeLessThan(2 * AIR_SEGMENT.maxSteps);
    const [seg] = words.drawnAirSegments();
    expect(seg!.start).toEqual(start.map(Math.round));
    expect(seg!.end).toBeNull();
    expect(seg!.ground.length).toBeGreaterThan(0);
    expect(seg!.ground[0]![0]).toEqual(seg!.start);
    for (const p of [...seg!.ground.flat(), ...seg!.air.flat()]) expect(nearScreen(p)).toBe(true);
    // Every point drawn on the ground under the segment's part in front of the camera.
    const ground = Array.from({ length: 4001 }, (_, k) => view.toScreen(50.5, 77.5 + 5 * k / 4000)).filter((p) => Number.isFinite(p[0]));
    const off = (p: [number, number]) => Math.min(...ground.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
    for (const p of seg!.ground.flat()) expect(off(p)).toBeLessThan(1);
  });

  it("draws only the part on screen of a segment that runs off a zoomed-in 2D board, sampled as one on screen is", () => {
    const zoomed = (tx: number, ty: number): [number, number] => [tx * 100, ty * 100];
    const long = { ...mark, tileX: 5, tileY: 5, toTileX: 40, toTileY: 5 };
    const words = new Words({ w, h });
    words.update(frameOf(long), zoomed, [], "v");
    const [seg] = words.drawnAirSegments();
    expect(seg!.start).toEqual([550, 550]);
    expect(seg!.end).toBeNull();
    expect(seg!.ground).toHaveLength(1);
    const [path] = seg!.ground;
    expect(path![0]).toEqual([550, 550]);
    expect(path!.at(-1)![0]).toBeGreaterThan(w);
    for (const p of path!) expect(nearScreen(p)).toBe(true);
    for (let i = 1; i < path!.length; i++) expect(path![i]![0] - path![i - 1]![0]).toBeLessThanOrEqual(AIR_SEGMENT.step);
  });

  it("is sampled on the 3D board through the board's projection that gives no point at or behind the near plane", () => {
    const src = readFileSync("web/src/board3d/main3d.ts", "utf8");
    expect(src).toMatch(/words\.update\(shown, toScreen, [^;]*, toScreenInFront\);/);
  });
});

// Playback, live and recorded, through the production buffer: a full snapshot, then one-tick deltas; a flyer LINE
// mark is laid at message LAID and moved (same id, raised revision, new ends) at message MOVED.
const first = decodeMessage(scale2Packets(1)[0]!);
const { mapW, mapH } = first.full!.setup;
const LAID = 5, MOVED = 30, COUNT = 50;
const laid: StreamMark = {
  id: 900, agent: 0, colony: 0, tileX: Math.round(mapW * 0.3), tileY: Math.round(mapH * 0.4), toTileX: Math.round(mapW * 0.6), toTileY: Math.round(mapH * 0.4),
  words: [], verb: "LINE", count: 4, claimed: 0, answered: 0, revision: 0, caste: "flyer", laidTick: first.tick + LAID,
};
const moved: StreamMark = { ...laid, tileY: Math.round(mapH * 0.6), toTileX: Math.round(mapW * 0.7), toTileY: Math.round(mapH * 0.7), revision: 1 };
const groundLine: StreamMark = { ...laid, id: 901, caste: undefined, revision: 0, tileY: Math.round(mapH * 0.2), toTileY: Math.round(mapH * 0.2) };
const events = (i: number): StreamEvent[] => i === LAID ? [{ kind: "mark", mark: laid }, { kind: "mark", mark: groundLine }] : i === MOVED ? [{ kind: "mark", mark: moved }] : [];
const messages: StreamMessage[] = Array.from({ length: COUNT }, (_, i) => ({
  ...first, tick: first.tick + i, full: i === 0 ? structuredClone(first.full) : null, events: events(i),
}));
// As stored and as sent: every message through its bytes.
const sent = messages.map((m) => decodeMessage(encodeMessage(m)));
const bytes = packMessages(messages.map(encodeMessage));

/** A viewer playing messages from `from`, each arriving 100 ms after the one before, sampled at message `at`. */
function live(at: number, list: readonly StreamMessage[] = sent, from = 0): Frame {
  const playback = new Playback(), frame = new Frame();
  for (let i = from; i <= at; i++) playback.push(list[i]!, (i - from) * 100);
  playback.sample((at - from) * 100 + RENDER_DELAY_MS, frame);
  return frame;
}

const active: Recording[] = [];
afterEach(() => { for (const r of active.splice(0)) r.close(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function seek(r: Recording, ms: number): Promise<Frame> {
  r.seek(ms);
  const playback = new Playback(), frame = new Frame();
  for (let i = 0; i < 100; i++) {
    await turn();
    for (const arrival of r.take(i * 16)) playback.push(arrival.m, arrival.at);
    playback.sample(r.time, frame);
    if (!r.seeking) return frame;
  }
  throw new Error("Seek never completed");
}

/** The flyer LINE as each board draws it from a frame: its marker's tile and far end, and that it is in the air. */
function drawn(frame: Frame) {
  const out: { board: string; tile: [number, number]; end: [number, number]; airborne: boolean; groundLines: number[] }[] = [];
  for (const [board, toScreen] of [["2D", (tx: number, ty: number): [number, number] => [tx * 10, ty * 10]], ["3D", tilted3d(1920, 1080, mapW, mapH)]] as const) {
    const words = new Words({ w: Math.max(1920, mapW * 10), h: Math.max(1080, mapH * 10) });
    words.update(frame, toScreen, [], "v");
    const seg = words.drawnAirSegments().find((s) => s.id === 900);
    const mark = frame.marks.find((v) => v.mark.id === 900)?.mark;
    if (!seg || !mark) continue;
    const [ex, ey] = toScreen(mark.toTileX! + 0.5, mark.toTileY! + 0.5);
    const [sx, sy] = toScreen(mark.tileX + 0.5, mark.tileY + 0.5).map(Math.round) as [number, number];
    expect(seg.ground).toHaveLength(1);
    const [path] = seg.ground, [bar] = seg.air;
    expect(path![0]).toEqual([sx, sy]);
    expect(path!.at(-1)![0]).toBeCloseTo(ex);
    expect(path!.at(-1)![1]).toBeCloseTo(ey);
    const airborne = seg.start !== null && seg.end !== null && bar!.every(([x, y], i) => x === path![i]![0] && y === path![i]![1] - AIR_SEGMENT.lift);
    out.push({ board, tile: [mark.tileX, mark.tileY], end: [mark.toTileX!, mark.toTileY!], airborne, groundLines: words.drawnLines().map((l) => l.id) });
  }
  return out;
}
const expectDrawn = (frame: Frame, mark: StreamMark) => {
  expect(drawn(frame)).toEqual(["2D", "3D"].map((board) => ({ board, tile: [mark.tileX, mark.tileY], end: [mark.toTileX, mark.toTileY], airborne: true, groundLines: [901] })));
};

describe("flyer LINE mark in playback", () => {
  it("keeps its flyer caste and both ends through the stream's bytes", () => {
    const decoded = sent[LAID]!.events.find((e) => e.kind === "mark" && e.mark.id === 900);
    expect(decoded).toEqual({ kind: "mark", mark: laid });
    expect(sent[MOVED]!.events).toEqual([{ kind: "mark", mark: moved }]);
  });

  it("is drawn live from when it is laid, and follows the mark when it moves", () => {
    expect(drawn(live(LAID - 1))).toEqual([]);
    expectDrawn(live(LAID + 2), laid);
    expectDrawn(live(MOVED - 1), laid);
    expectDrawn(live(MOVED + 2), moved);
  });

  it("is drawn for a viewer joining after it moved, from the join snapshot alone", () => {
    const at = MOVED + 5;
    const snapshot: StreamMessage = { ...sent[at]!, full: { ...structuredClone(first.full!), marks: [groundLine, moved] }, events: [] };
    const joined = [...sent.slice(0, at), decodeMessage(encodeMessage(snapshot)), ...sent.slice(at + 1)];
    expectDrawn(live(at + 3, joined, at), moved);
  });

  it("is drawn in recorded playback after seeking forward past the move, back before it, and forward again", async () => {
    // Each request (the opening read and every seek) streams the stored bytes afresh, in uneven pieces.
    const stream = () => {
      let at = 0;
      return new ReadableStream<Uint8Array>({ pull(c) {
        if (at === bytes.length) c.close();
        else { c.enqueue(bytes.slice(at, at + 719)); at = Math.min(bytes.length, at + 719); }
      } });
    };
    const r = openRecording("/recording", undefined, async () => new Response(stream()), { controls: true, endTick: async () => first.tick + COUNT - 1 });
    active.push(r);
    await r.first;
    await vi.waitFor(() => expect(r.duration).toBe((COUNT - 1) * 100));
    expectDrawn(await seek(r, (MOVED + 5) * 100), moved);
    expectDrawn(await seek(r, (LAID + 5) * 100), laid);
    expect(drawn(await seek(r, (LAID - 2) * 100))).toEqual([]);
    expectDrawn(await seek(r, (COUNT - 2) * 100), moved);
  });
});
