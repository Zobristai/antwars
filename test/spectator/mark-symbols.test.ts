import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Graphics, Polygon } from "pixi.js";
import { COUNT_VERBS } from "../../src/sim/types.ts";
import type { StreamMark } from "../../src/live/format.ts";
import type { Frame } from "../../web/src/buffer.ts";
import { GLYPHS, MARK_DOT, glyphPolygon } from "../../web/src/compose.ts";
import { markSymbol, markSymbolPolygon } from "../../web/src/mark-symbols.ts";
import { Words, markLabel, markReading } from "../../web/src/words.ts";

const toScreen = (x: number, y: number): [number, number] => [x * 20, y * 20];
const mark = (verb?: StreamMark["verb"]): StreamMark => ({ id: 1, agent: 0, colony: 0, tileX: 7, tileY: 7, words: [], verb, count: 20, claimed: 12, answered: 12, laidTick: 1 });
const frameOf = (m: StreamMark): Frame => ({ tick: 10, board: { marks: [m] }, marks: [{ mark: m, ageMs: 5000 }] }) as unknown as Frame;
const polygons = (g: Graphics) => {
  type Instruction = { action: string; data: { path: { shapePath: { shapePrimitives: { shape: { type: string; points?: number[] } }[] } } } };
  return (g.context.instructions as unknown as Instruction[]).filter((i) => i.action === "fill").flatMap((i) => i.data.path.shapePath.shapePrimitives.filter((p) => p.shape.type === "polygon").map((p) => p.shape.points!));
};

// One sample per CSS pixel: guards coarse silhouette features, not browser antialiasing.
const pixelMask = (points: number[], diameter: number): boolean[][] => {
  const polygon = new Polygon(points);
  return Array.from({ length: diameter }, (_, y) => Array.from({ length: diameter }, (_, x) =>
    polygon.contains(x + 0.5 - diameter / 2, y + 0.5 - diameter / 2)));
};

// Actual vector paths, not just names: the board and label must draw the same shape.
describe("board mark kind symbols", () => {
  it("covers every verb with a distinct silhouette, not an agent glyph, at marker size", () => {
    const symbols = COUNT_VERBS.map((v) => markSymbolPolygon(v, MARK_DOT.glyph));
    expect(new Set(symbols.map((s) => JSON.stringify(s))).size).toBe(COUNT_VERBS.length);
    for (const [i, verb] of COUNT_VERBS.entries()) {
      expect(markSymbol(verb)).toBe(verb);
      expect(symbols[i]!.every((v) => Number.isFinite(v) && Math.abs(v) <= MARK_DOT.glyph)).toBe(true);
      for (let agent = 0; agent < GLYPHS.length; agent++) expect(symbols[i]).not.toEqual(glyphPolygon(agent, MARK_DOT.glyph));
    }
    expect(markSymbol(undefined)).toBeNull();
    expect(markSymbol("unknown")).toBeNull();
    expect(markSymbol("toString")).toBeNull();
  });

  it.each([10, 11, MARK_DOT.glyph * 2])("keeps DEFEND's open notch, two shoulders and flat base at %i CSS pixels", (diameter) => {
    const radius = diameter / 2;
    const mask = pixelMask(markSymbolPolygon("DEFEND", radius), diameter);
    const centre = Math.floor(diameter / 2);
    // The notch stays at least three pixels wide through the upper half, flanked by solid shoulders.
    for (const row of mask.slice(1, Math.floor(diameter / 2))) {
      expect(row.slice(centre - 1, centre + 2)).toEqual([false, false, false]);
      expect(row[1]).toBe(true);
      expect(row[diameter - 2]).toBe(true);
    }
    expect(mask[diameter - 2]!.every(Boolean)).toBe(true);
    for (let agent = 0; agent < GLYPHS.length; agent++) {
      expect(mask, GLYPHS[agent]).not.toEqual(pixelMask(glyphPolygon(agent, radius), diameter));
    }
    for (const verb of COUNT_VERBS.filter((v) => v !== "DEFEND")) {
      expect(mask, verb).not.toEqual(pixelMask(markSymbolPolygon(verb, radius), diameter));
    }
  });

  it.each(COUNT_VERBS.flatMap((verb) => [{ w: 360, h: 800 }, { w: 390, h: 844 }].map((screen) => ({ verb, ...screen }))))("draws $verb inside the marker, and only the count on its label, on a $w-pixel phone", ({ verb, w, h }) => {
    const words = new Words({ w, h });
    const m = mark(verb);
    words.update(frameOf(m), toScreen, [], "paused");
    expect(polygons(words.layer.children[0] as Graphics)).toEqual([markSymbolPolygon(verb, MARK_DOT.glyph).map((v) => v + 150)]);
    const label = words.drawnLabels()[0]!;
    expect(label.text).toBe("12/20");
    // The kind symbol is the marker's alone: the label draws no symbol.
    expect(polygons(words.layer.children[1] as Graphics)).toEqual([]);
    expect(markReading(m)).toBe(`${verb} · 20 requested · 12 answered`);
    expect(label.rect.x0).toBeGreaterThanOrEqual(0);
    expect(label.rect.x1).toBeLessThanOrEqual(w);
  });

  it.each([{ words: [] }, { words: [0, 1] }])("keeps owner glyphs and no board label for verbless words $words", ({ words }) => {
    const m = { ...mark(), words, agent: 6 };
    const layer = new Words({ w: 390, h: 844 });
    layer.update(frameOf(m), toScreen, [], "v");
    expect(polygons(layer.layer.children[0] as Graphics)).toEqual([glyphPolygon(6, MARK_DOT.glyph).map((v) => v + 150)]);
    expect(layer.drawnLabels()).toEqual([]);
    expect(markLabel(m)).toBeNull();
  });

  it("retains zero counts and does not invent missing claims or unknown command labels", () => {
    expect(markLabel({ words: [], verb: "ATTACK", count: 0, claimed: 0 })).toBe("0/0");
    expect(markLabel({ words: [], verb: "ATTACK", count: 20 })).toBeNull();
    expect(markLabel({ words: [], verb: "unknown", count: 20, claimed: 12 })).toBeNull();
  });

  it("hides only labels immediately, drops their hit targets, and restores them on the same paused frame", () => {
    const words = new Words({ w: 390, h: 844 });
    const frame = frameOf(mark("DEFEND"));
    const anchors = [[0, 300, 300]] as const;
    words.update(frame, toScreen, [], "paused", anchors, 10);
    const labels = words.drawnLabels();
    const r = labels[0]!.rect;
    const x = (r.x0 + r.x1) / 2, y = (r.y0 + r.y1) / 2;
    const markers = words.markers();
    const vectors = polygons(words.layer.children[0] as Graphics);
    words.setLabelsVisible(false);
    expect(words.labelsVisible).toBe(false);
    expect(words.drawnLabels()).toEqual([]);
    expect(words.labelAt(x, y, true)).toBeNull();
    expect(words.stats.labels).toBe(0);
    expect((words.layer.children[1] as Graphics).context.instructions).toHaveLength(0);
    words.update(frame, toScreen, [], "paused", anchors, 10);
    expect(words.markers()).toEqual(markers);
    expect(polygons(words.layer.children[0] as Graphics)).toEqual(vectors);
    expect(words.badges.size).toBe(1);
    expect(words.layer.visible).toBe(true);
    words.focus = words.markAt(150, 150);
    expect(words.tipContent()!.rows[0]!.head).toBe("DEFEND · 20 requested · 12 answered");
    words.resize({ w: 844, h: 390 });
    words.update(frame, toScreen, [], "paused", anchors, 10);
    expect(words.drawnLabels()).toEqual([]);
    words.resize({ w: 390, h: 844 });
    words.setLabelsVisible(true);
    words.update(frame, toScreen, [], "paused", anchors, 10);
    expect(words.drawnLabels()).toEqual(labels);
    expect(words.labelAt(x, y)).toBe(1);
  });
});

describe("mark labels", () => {
  it("hide only the board's mark labels, never its layer", () => {
    const words = new Words({ w: 390, h: 844 });
    words.setLabelsVisible(false);
    expect(words.labelsVisible).toBe(false);
    expect(words.layer.visible).toBe(true);
    words.setLabelsVisible(true);
    expect(words.labelsVisible).toBe(true);
  });

  it("wires the capture option into both real board entry points", () => {
    for (const file of ["main.ts", "board3d/main3d.ts"]) {
      const source = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
      expect(source).toContain("words.setLabelsVisible(o.markLabels)");
      expect(source).toContain("markLabels: words.labelsVisible");
    }
    const source = readFileSync(new URL("../../web/src/words.ts", import.meta.url), "utf8");
    expect(source).toContain('" /-.,:!?\'+·"');
  });
});
