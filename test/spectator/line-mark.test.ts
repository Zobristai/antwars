// A rules-26 LINE mark reads on both boards as a dotted line between its two ends, with the count marks'
// label, and in the feed; every other mark, and recordings made before LINE existed, draw as before.
import { describe, expect, it } from "vitest";
import { Graphics } from "pixi.js";
import { type StreamMark } from "../../src/live/format.ts";
import type { ChatLine, Frame } from "../../web/src/buffer.ts";
import { fitTilted, projector } from "../../web/src/board3d/view.ts";
import { GLYPHS, MARK_DOT, glyphPolygon } from "../../web/src/compose.ts";
import { markSymbol, markSymbolPolygon } from "../../web/src/mark-symbols.ts";
import { agentLine } from "../../web/src/ui/hud-model.ts";
import { markIcon } from "../../web/src/ui/icons.ts";
import { LINE_DOTS, Words, boardLabel, lineEnd, markLabel, markReading } from "../../web/src/words.ts";

type Shape = { type: string; x?: number; y?: number; radius?: number; points?: number[] };
type Instruction = { action: string; data: { path: { shapePath: { shapePrimitives: { shape: Shape }[] } } } };
const shapes = (g: Graphics, type: string, action = "fill"): Shape[] =>
  (g.context.instructions as unknown as Instruction[]).filter((i) => i.action === action)
    .flatMap((i) => i.data.path.shapePath.shapePrimitives.map((p) => p.shape).filter((s) => s.type === type));

const W = 64, H = 48;
const line: StreamMark = { id: 5, agent: 2, colony: 1, tileX: 10, tileY: 30, toTileX: 50, toTileY: 30, words: [], verb: "LINE", count: 20, claimed: 12, answered: 12, laidTick: 1 };
const frameOf = (...marks: StreamMark[]): Frame => ({ tick: 10, board: { marks, agents: [] }, marks: marks.map((mark) => ({ mark, ageMs: 5000 })) }) as unknown as Frame;

const flat2d = (w: number) => {
  const px = w / W;
  return (tx: number, ty: number): [number, number] => [tx * px, ty * px];
};
const relief = (tx: number, ty: number) => 0.4 * Math.sin(tx / 3) * Math.cos(ty / 4);
const tilted3d = (w: number, h: number) => {
  const project = projector(fitTilted(W, H, w, h, { x0: 0, y0: 0, x1: w, y1: h }).pose, w, h);
  return (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), H - ty]) ?? [NaN, NaN];
};

describe("LINE mark symbol", () => {
  it("has its own silhouette, distinct from the count verbs and every agent glyph, also in the HUD icon", () => {
    expect(markSymbol("LINE")).toBe("LINE");
    expect(markSymbol("PATROL")).toBeNull();
    const poly = markSymbolPolygon("LINE", MARK_DOT.glyph);
    for (const verb of ["DEFEND", "FORAGE", "ATTACK", "GATHER"] as const) expect(poly).not.toEqual(markSymbolPolygon(verb, MARK_DOT.glyph));
    for (let agent = 0; agent < GLYPHS.length; agent++) expect(poly).not.toEqual(glyphPolygon(agent, MARK_DOT.glyph));
    expect(poly.every((v) => Math.abs(v) <= MARK_DOT.glyph)).toBe(true);
    expect(markIcon("LINE", "#fff")).toContain("<polygon");
  });
});

describe("LINE mark on the boards", () => {
  const views = [
    { board: "2D", w: 1920, h: 1080, toScreen: flat2d(1920) },
    { board: "2D", w: 390, h: 844, toScreen: flat2d(390) },
    { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080) },
    { board: "3D", w: 390, h: 844, toScreen: tilted3d(390, 844) },
  ];

  it.each(views)("draws a dotted line end to end with the count label on the $board board at $w x $h", ({ w, h, toScreen }) => {
    const words = new Words({ w, h });
    words.update(frameOf(line), toScreen, [], "v");
    const [sx, sy] = toScreen(10.5, 30.5).map(Math.round) as [number, number];
    const [ex, ey] = toScreen(50.5, 30.5);
    const [drawn] = words.drawnLines();
    expect(drawn!.id).toBe(5);
    expect(drawn!.end[0]).toBeCloseTo(ex);
    expect(drawn!.end[1]).toBeCloseTo(ey);
    // Dots fill the gap between the marker ring and the end dot, about LINE_DOTS.step apart, every one on screen.
    const length = Math.hypot(ex - sx, ey - sy);
    expect(drawn!.dots.length).toBeGreaterThanOrEqual(Math.floor((length - MARK_DOT.ring - LINE_DOTS.endR) / LINE_DOTS.step) - 2);
    for (const [x, y] of [...drawn!.dots, drawn!.end]) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(w);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(h);
    }
    for (let i = 1; i < drawn!.dots.length; i++) {
      const gap = Math.hypot(drawn!.dots[i]![0] - drawn!.dots[i - 1]![0], drawn!.dots[i]![1] - drawn!.dots[i - 1]![1]);
      expect(gap).toBeGreaterThan(LINE_DOTS.step * 0.5);
      expect(gap).toBeLessThan(LINE_DOTS.step * 1.5);
    }
    // Drawn: two ring strokes, every dot and the end dot as circles; the LINE symbol inside the ring.
    const g = words.layer.children[0] as Graphics;
    const circles = shapes(g, "circle");
    expect(circles.filter((c) => c.radius === LINE_DOTS.r)).toHaveLength(drawn!.dots.length);
    expect(circles.filter((c) => c.radius === LINE_DOTS.endR)).toHaveLength(1);
    expect(shapes(g, "circle", "stroke").filter((c) => c.radius === MARK_DOT.ring)).toHaveLength(2);
    expect(shapes(g, "polygon").map((p) => p.points)).toEqual([markSymbolPolygon("LINE", MARK_DOT.glyph).map((v, i) => v + (i % 2 === 0 ? sx : sy))]);
    // The label is the count marks' own: claimed/count on its backing, placed on screen.
    const [label] = words.drawnLabels();
    expect(label!.text).toBe("12/20");
    expect(label!.rect.x0).toBeGreaterThanOrEqual(0);
    expect(label!.rect.x1).toBeLessThanOrEqual(w);
    expect(label!.rect.y0).toBeGreaterThanOrEqual(0);
    expect(label!.rect.y1).toBeLessThanOrEqual(h);
    // The end dot is kept clear of the label.
    expect(label!.rect.x1 < drawn!.end[0] - LINE_DOTS.endR || label!.rect.x0 > drawn!.end[0] + LINE_DOTS.endR || label!.rect.y1 < drawn!.end[1] - LINE_DOTS.endR || label!.rect.y0 > drawn!.end[1] + LINE_DOTS.endR).toBe(true);
  });

  it("follows the 3D ground's relief, not a straight screen segment", () => {
    const toScreen = tilted3d(1920, 1080);
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf(line), toScreen, [], "v");
    const [drawn] = words.drawnLines();
    const [sx, sy] = toScreen(10.5, 30.5);
    const [ex, ey] = toScreen(50.5, 30.5);
    const off = drawn!.dots.map(([x, y]) => Math.abs((ex - sx) * (sy - y) - (sx - x) * (ey - sy)) / Math.hypot(ex - sx, ey - sy));
    expect(Math.max(...off)).toBeGreaterThan(0.5);
  });

  it("shows the caste in the label (as its icon on the board), and its reading and tooltip as the other count marks", () => {
    const m: StreamMark = { ...line, caste: "worker" };
    expect(markLabel(m)).toBe("worker · 12/20");
    expect(boardLabel(m)).toEqual({ figure: "12/20", caste: "worker" });
    expect(markReading(m)).toBe("LINE · worker · 20 requested · 12 answered");
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf(line), flat2d(1920), [], "v");
    words.focus = words.markAt(Math.round(10.5 * 30), Math.round(30.5 * 30));
    expect(words.tipContent()!.rows[0]!.head).toBe("LINE · 20 requested · 12 answered");
  });

  it("draws a LINE mark missing its second end, and every other mark, as a single marker", () => {
    const toScreen = flat2d(1920);
    const others: StreamMark[] = [
      { ...line, id: 1, verb: "DEFEND", toTileX: undefined, toTileY: undefined, tileY: 5 },
      { ...line, id: 2, verb: "PATROL", toTileX: undefined, toTileY: undefined, tileY: 10 },
      { ...line, id: 3, verb: undefined, words: [0, 1], tileY: 15 },
      { ...line, id: 4, toTileX: undefined, tileY: 20 },
    ];
    expect(others.map(lineEnd)).toEqual([null, null, null, null]);
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf(...others), toScreen, [], "v");
    expect(words.drawnLines()).toEqual([]);
    const g = words.layer.children[0] as Graphics;
    expect(shapes(g, "circle")).toEqual([]);
    const rings = shapes(g, "circle", "stroke");
    expect(rings).toHaveLength(2 * others.length);
    expect(rings.every((c) => c.radius === MARK_DOT.ring)).toBe(true);
  });
});

describe("LINE mark in the feed", () => {
  const posted: ChatLine = { kind: "mark", tick: 20, agent: 2, colony: 1, text: "", words: [], verb: "LINE", count: 20, markId: 5, tileX: 10, tileY: 30, laidTick: 1 };

  it("names it as a LINE mark with its counts, live and after it leaves the board", () => {
    expect(markReading(line)).toBe("LINE · 20 requested · 12 answered");
    expect(markReading(posted)).toBe("LINE · 20 requested");
  });

  it("shows the HUD agent line as the board label with the LINE symbol", () => {
    const frame = { ...frameOf(line), board: { marks: [line], agents: [], setup: { ticksPerSecond: 10 } } } as unknown as Frame;
    const model = agentLine(posted, frame, new Map([[5, line]]));
    expect(model).toMatchObject({ kind: "mark", verb: "LINE", text: "12/20", live: true });
    expect(model.reading).toContain("LINE · 20 requested · 12 answered");
  });
});
