/**
 * Composition rules (web/src/compose.ts) and the placement they drive
 * (web/src/words.ts Placer, web/src/squads.ts badges); the markers.
 */
import { WORDS } from "../../src/sim/types.ts";
import { describe, expect, it } from "vitest";
import { BitmapText, Container, Graphics, GraphicsPath, Matrix, Texture, type Particle, type Renderer } from "pixi.js";
import { CONNECTING_LINE, ENDED_LINE, GLYPHS, RECONNECTING_LINE, TIP_EDGE, TOUCH_TARGET_PX, agentGlyph, agentHandle, agentModel, badgeAnchors, badgeRadiusPx, glyphPolygon, linkLine, MARK_DOT, tiltOn, tipBand, tipFit, tipHeight, tipRect } from "../../web/src/compose.ts";
import { OPEN_COPY } from "../../web/src/story.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ants, COLONY_TINT, DIM_TINT, FALLEN_ALPHA, FALLEN_TINT, SOLDIER_ABDOMEN, SOLDIER_HEAD, SOLDIER_SCALE, antTint } from "../../web/src/ants.ts";
import { agentHues, agentShade, cssColour } from "../../web/src/squads.ts";
import { CASTE_ICON_PATH } from "../../web/src/ui/deck/icons.ts";
import { LABEL_PLATE_ALPHA, MARK_EXIT_MS, Placer, Words, boardLabel, exitAlpha, labelSize, labelSpots, leaderLine, markAge, markByline, markLabel, markReading, markerRect, nestRects, nestZoneRect, overlaps, placeBadges, wordlessMarkTip, wordsText, type Rect } from "../../web/src/words.ts";
import { Squads, squadCentres, squadTipText } from "../../web/src/squads.ts";
import { Frame, MARK_LIFE_MS, Playback } from "../../web/src/buffer.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { DEFAULT_CONFIG, RULES_V4_CONFIG } from "../../src/sim/config.ts";
import { playable } from "../playable.ts";
import type { StreamMark } from "../../src/live/format.ts";

/** A small seeded generator, so the crowded scenes are the same every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("marks as ground markers", () => {
  const mark = (id: number, tileX: number, tileY: number, answered: number, words = [0, 1]): StreamMark => ({ id, agent: id % 3, colony: (id % 2) as 0 | 1, tileX, tileY, words, laidTick: 1, answered });
  const frameOf = (marks: StreamMark[], ages: number[] = []) => ({ tick: 10, board: { marks }, marks: marks.map((m, i) => ({ mark: m, ageMs: ages[i] ?? 5000 })) }) as unknown as Frame;
  const toScreen = (tx: number, ty: number): [number, number] => [tx * 20, ty * 20];

  /**
   * What the markers layer actually drew for the marker at screen point (x, y): each circle (the
   * halo, the ring) and each polygon within the ring (the owner's glyph, filled then outlined) the
   * draw passed to the graphics, in draw order, with its radius, stroke width, alpha and points.
   */
  const drawnAt = (words: Words, x: number, y: number) => {
    const g = words.layer.children.find((c) => c instanceof Graphics) as Graphics;
    type Shape = { type: string; x?: number; y?: number; radius?: number; points?: number[] };
    type Ins = { action: string; data: { style: { alpha: number; width?: number }; path: { shapePath: { shapePrimitives: { shape: Shape }[] } } } };
    const here = (s: Shape) => (s.type === "circle" ? s.x === x && s.y === y : s.type === "polygon" && s.points!.every((v, i) => Math.abs(v - (i % 2 === 0 ? x : y)) <= MARK_DOT.ring));
    return (g.context.instructions as unknown as Ins[]).flatMap((ins) =>
      ins.data.path.shapePath.shapePrimitives
        .filter((p) => here(p.shape))
        .map((p) => ({ action: ins.action, type: p.shape.type, radius: p.shape.radius ?? null, points: p.shape.points ?? null, width: ins.action === "stroke" ? ins.data.style.width : null, alpha: ins.data.style.alpha })),
    );
  };

  it("draws every live mark's marker at full size and opacity, fading only with its age, never by how many ants it steers, with its owner's glyph in the ring", () => {
    const words = new Words({ w: 1920, h: 1080 });
    // Two marks of the same age, one steering no ant and one steering seven; a third, older, steering none.
    const marks = [mark(1, 10, 10, 0), mark(2, 30, 10, 7), mark(3, 50, 10, 0)];
    words.update(frameOf(marks, [5000, 5000, 120_000]), toScreen, [], "v1");
    const none = drawnAt(words, 210, 210);
    const seven = drawnAt(words, 610, 210);
    const old = drawnAt(words, 1010, 210);
    // The halo and the ring, then the glyph filled and outlined.
    expect(none.map((d) => [d.action, d.type])).toEqual([["stroke", "circle"], ["stroke", "circle"], ["fill", "polygon"], ["stroke", "polygon"]]);
    // Steering no ant changes nothing that is drawn but the owner's own glyph.
    const sans = (d: (typeof none)[number]) => ({ ...d, points: null });
    expect(none.map(sans)).toEqual(seven.map(sans));
    // Full size: a ring several times an ant's few pixels, still small.
    const [halo, ring, glyph, outline] = none;
    expect(ring!.radius).toBe(MARK_DOT.ring);
    expect(ring!.width).toBe(MARK_DOT.ringW);
    expect(halo!.radius).toBe(MARK_DOT.ring);
    expect(MARK_DOT.ring).toBeGreaterThanOrEqual(7);
    expect(MARK_DOT.ring).toBeLessThanOrEqual(12);
    // The glyph is the owner's (mark 1 is agent 1's, mark 2 agent 2's), the shape its badge and swatch draw, inside the ring.
    expect(glyph!.points).toEqual(glyphPolygon(1, MARK_DOT.glyph).map((v) => v + 210));
    expect(outline!.points).toEqual(glyph!.points);
    expect(seven[2]!.points).toEqual(glyphPolygon(2, MARK_DOT.glyph).map((v, i) => v + (i % 2 === 0 ? 610 : 210)));
    expect(MARK_DOT.glyph).toBeLessThan(MARK_DOT.ring - MARK_DOT.ringW / 2);
    // Full opacity, less only the age fade: at 5 s a mark is all but fully opaque.
    expect(ring!.alpha).toBeGreaterThan(0.95);
    expect(glyph!.alpha).toBe(ring!.alpha);
    // The age fade: the older mark is the same size, drawn fainter.
    expect(old.map((d) => [d.radius, d.width])).toEqual(none.map((d) => [d.radius, d.width]));
    expect(old[1]!.alpha).toBeLessThan(ring!.alpha);
    expect(old[1]!.alpha).toBeGreaterThan(0.4);
    // The layout reserves the whole ping, so a badge never covers it.
    const r = markerRect(0, 0);
    expect(r.x1).toBeGreaterThanOrEqual(MARK_DOT.ring + MARK_DOT.ringW / 2);
  });

  // Regression caught in review: badges and fades stepping at 100 to 1000 ms because the
  // whole drawing was cached with the placement; and a mark and its label vanishing at once at the end of its life.
  it("paints every frame on the cached placement: a badge follows its anchor ant between layouts at the offset the layout chose, and a mark's ring, plate and reading fade out together over its last MARK_EXIT_MS", () => {
    const words = new Words({ w: 1920, h: 1080 });
    const counted: StreamMark = { ...mark(2, 30, 20, 0), words: [], verb: "DEFEND", count: 15, claimed: 12 };
    const frame = frameOf([counted], [5000]);
    words.update(frame, toScreen, [], "v1", [[0, 300, 300]], 10);
    const placer = words.placer;
    const spot = words.badges.get(0)!;
    // The same frame key, the anchor ant 4 px on: no new layout; the badge 4 px on, at the same offset.
    words.update(frame, toScreen, [], "v1", [[0, 304, 300]], 10);
    expect(words.placer).toBe(placer);
    expect(words.badges.get(0)).toEqual({ x0: spot.x0 + 4, y0: spot.y0, x1: spot.x1 + 4, y1: spot.y1 });
    // Mid-life: the backing at its constant translucency and the count whole, the ring at its age's alpha.
    const plateG = words.layer.children[1] as Graphics;
    const plateAlpha = () => (plateG.context.instructions as unknown as { action: string; data: { style: { alpha: number } } }[]).find((i) => i.action === "fill")!.data.style.alpha;
    const textAlpha = () => (words.layer.children[2] as Container).children[0]!.alpha;
    const ringAlpha = () => drawnAt(words, 610, 410)[1]!.alpha;
    const rect = words.drawnLabels()[0]!.rect;
    expect(plateAlpha()).toBe(LABEL_PLATE_ALPHA);
    expect(textAlpha()).toBe(1);
    expect(ringAlpha()).toBeGreaterThan(0.95);
    // Half way through the exit: ring, plate and reading at half their alpha, the label where it was.
    const half = MARK_LIFE_MS - MARK_EXIT_MS / 2;
    expect(exitAlpha(half)).toBe(0.5);
    words.update(frameOf([counted], [half]), toScreen, [], "v1", [[0, 304, 300]], 10);
    expect(plateAlpha()).toBeCloseTo(LABEL_PLATE_ALPHA / 2, 6);
    expect(textAlpha()).toBeCloseTo(0.5, 6);
    expect(ringAlpha()).toBeCloseTo((0.45 + 0.55 * (1 - half / MARK_LIFE_MS)) / 2, 6);
    expect(words.drawnLabels()[0]!.rect).toEqual(rect);
    // The frame before playback drops it: all but gone, still in place; and no exit before the last MARK_EXIT_MS.
    words.update(frameOf([counted], [MARK_LIFE_MS - 1]), toScreen, [], "v1", [[0, 304, 300]], 10);
    expect(textAlpha()).toBeCloseTo(1 / MARK_EXIT_MS, 6);
    expect(words.drawnLabels()[0]!.rect).toEqual(rect);
    expect(exitAlpha(MARK_LIFE_MS - MARK_EXIT_MS)).toBe(1);
    expect(exitAlpha(0)).toBe(1);
  });

  it("keeps a count mark's age when it is re-laid in place or its claims change (another mark event with its id)", () => {
    const setup = { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] as [[number, number], [number, number]] };
    const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
    const counted: StreamMark = { id: 4, agent: 0, colony: 0, tileX: 3, tileY: 3, words: [], laidTick: 9, answered: 0, verb: "DEFEND", count: 8, claimed: 0, revision: 0 };
    const p = new Playback();
    p.push({ tick: 0, ants, full: { setup, territory: new Uint8Array(64), marks: [], agents: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null }, events: [] }, 0);
    p.push({ tick: 10, ants, full: null, events: [{ kind: "mark", mark: counted }] }, 1000);
    p.push({ tick: 50, ants, full: null, events: [{ kind: "mark", mark: { ...counted, claimed: 5 } }] }, 5000);
    p.push({ tick: 80, ants, full: null, events: [{ kind: "mark", mark: { ...counted, count: 3, claimed: 3, revision: 1 } }] }, 8000);
    p.push({ tick: 100, ants, full: null, events: [] }, 10_000);
    const f = new Frame();
    p.sample(10_000 + 250, f);
    expect(f.marks).toHaveLength(1);
    expect(f.marks[0]!.ageMs).toBe((100 - 10) * TICK_MS);
    expect(f.marks[0]!.mark).toMatchObject({ count: 3, claimed: 3, revision: 1 });
    // One log line for the mark, at the tick it was first laid, carrying the order the board carries now (a regression:
    // it once carried the first count beside the current answered ants).
    expect(f.chat.filter((l) => l.kind === "mark")).toHaveLength(1);
    expect(f.chat[0]).toMatchObject({ markId: 4, tick: 10, verb: "DEFEND", count: 3 });
  });

  // Regression caught: "claimed", "count mark" or a raw identifier reaching a viewer; a count mark's numbers written into
  // the client rather than read from the stream; then a gloss
  // composed on the client ("holds and fights within 3 tiles", "attack a few of us, to the west") passed off as the mark.
  it("reads a count mark as its verb, count and answered ants from the stream in the set form, a word mark as its words as written, and gives a wordless mark from a stream without them no reading", () => {
    expect(markReading({ words: [] })).toBe("");
    expect(markReading({ words: [], verb: "DEFEND", count: 15, claimed: 12 })).toBe("DEFEND · 15 requested · 12 answered");
    expect(markReading({ words: [], verb: "DEFEND", count: 12 })).toBe("DEFEND · 12 requested");
    expect(markReading({ words: [], verb: "FORAGE", count: 5, claimed: 0 })).toBe("FORAGE · 5 requested · 0 answered");
    // ATTACK W FEW, as written, each word set off; never a sentence; quoted as the agent's own words.
    const attack = [WORDS.indexOf("ATTACK"), WORDS.indexOf("W"), WORDS.indexOf("FEW")];
    expect(markReading({ words: attack })).toBe("“ATTACK · W · FEW”");
    expect(wordsText(attack)).toBe("ATTACK · W · FEW");
    // The byline says who laid it and when, never what it claimed; every character drawn on the board is in the word font.
    expect(markByline({ agent: 0, laidTick: 1 }, 121, 10)).toBe("by Diamond, 12s ago");
    for (const t of ["DEFEND · 15 requested · 12 answered", wordsText([0, 1])]) expect(t).toMatch(/^[A-Za-z0-9 ·]+$/);
  });

  // Regression caught: a count mark on the board saying nothing; a label in any form but
  // the set one; any other text on the board (a word mark's words, a fallback name); labels over a marker or each other.
  it("labels each live count mark with its compact answered/requested count beside its marker, clear of markers and other labels", () => {
    const words = new Words({ w: 1920, h: 1080 });
    // Board-only compact counts; tooltip and feed retain their full reading.
    const COMPACT = /^\d+\/\d+$/;
    const counted: StreamMark = { ...mark(2, 30, 20, 0), words: [], verb: "DEFEND", count: 15, claimed: 12 };
    const unanswered: StreamMark = { ...mark(3, 50, 40, 0), words: [], verb: "FORAGE", count: 5, claimed: 0 };
    const marks = [mark(1, 10, 10, 3), counted, unanswered, mark(4, 52, 40, 7)];
    words.update(frameOf(marks), toScreen, [], "v1");
    expect(words.stats.marks).toBe(4);
    expect(words.stats.markers).toBe(4);
    expect(words.stats.labels).toBe(2);
    const labels = words.drawnLabels();
    expect(labels.map((l) => [l.id, l.text])).toEqual([[2, "12/15"], [3, "0/5"]]);
    for (const l of labels) expect(l.text).toMatch(COMPACT);
    expect(markLabel(counted)).toBe("12/15");
    // Beside its marker, to the right where that is free, clear of the ring's halo by the layout's gap; sized from the monospace advance.
    const first = labels.find((l) => l.id === 2)!;
    expect(first.rect).toEqual(labelSpots(610, 410, first.rect.x1 - first.rect.x0, first.rect.y1 - first.rect.y0)[0]);
    expect(first.rect.x0).toBeGreaterThanOrEqual(markerRect(610, 410).x1 + 4);
    expect(first.rect.x1 - first.rect.x0).toBe(labelSize("12/15", 14, false).w);
    for (const a of labels) for (const b of labels) if (a !== b) expect(overlaps(a.rect, b.rect)).toBe(false);
    for (const l of labels) for (const m of marks) expect(overlaps(l.rect, markerRect(m.tileX * 20 + 10, m.tileY * 20 + 10))).toBe(false);
    // Two marks close together: the label gives way to the neighbouring marker and sits on the other side.
    const third = labels.find((l) => l.id === 3)!;
    expect(third.rect.x1).toBeLessThanOrEqual(markerRect(1010, 810).x0 - 4);
    // The board's text is exactly those labels: in the owner's shade, fading with the marker; word marks and the tooltip add none.
    const texts = (c: Container): BitmapText[] => c.children.flatMap((ch) => (ch instanceof BitmapText ? [ch] : ch instanceof Container ? texts(ch) : []));
    const drawn = texts(words.layer);
    expect(drawn.map((t) => t.text).sort()).toEqual(["0/5", "12/15"]);
    expect(drawn.find((t) => t.text === "12/15")!.tint).toBe(agentShade(0, 2, []));
    expect(drawn[0]!.alpha).toBeGreaterThan(0.95);
    expect(words.tipContent()).toBeNull();
    // A tap on a label opens its mark whatever lies under it: the tap
    // is the label's, even on touch with an ant under it, and the plate's own box is the target; off every label and
    // marker, on touch with an ant under it, no mark opens. A hover on the plate shows the mark too.
    const [lx, ly] = [(first.rect.x0 + first.rect.x1) / 2, (first.rect.y0 + first.rect.y1) / 2];
    expect(words.labelAt(lx, ly)).toBe(2);
    expect(words.labelAt(first.rect.x1 + 1, ly)).toBeNull();
    // On touch the plate's box is at least 44 px tall: a tap just under the
    // plate still opens its mark; a mouse keeps the plate's own box.
    const pad = Math.max(0, (TOUCH_TARGET_PX - (first.rect.y1 - first.rect.y0)) / 2);
    expect(pad).toBeGreaterThan(0);
    expect(words.labelAt(lx, first.rect.y1 + pad - 1, true)).toBe(2);
    expect(words.labelAt(lx, first.rect.y1 + pad - 1)).toBeNull();
    expect(words.labelAt(lx, first.rect.y1 + pad + 1, true)).toBeNull();
    expect(words.tapAt(lx, first.rect.y1 + pad - 1, true, true)).toBe(true);
    expect(words.focus).toBe(2);
    expect(words.tapAt(lx, ly, true, true)).toBe(true);
    expect(words.focus).toBe(2);
    expect(words.tapAt(5, 5, true, true)).toBe(false);
    expect(words.focus).toBeNull();
    words.hoverAt(lx, ly);
    expect(words.focus).toBe(2);
    words.clearFocus();
    // No text at all for word marks, a count mark without the stream's fields, or one short of the set form's numbers.
    const none = new Words({ w: 1920, h: 1080 });
    none.update(frameOf([mark(1, 10, 10, 3), { ...mark(5, 20, 10, 0), words: [] }, { ...mark(6, 30, 10, 0), words: [], verb: "ATTACK", count: 9 }]), toScreen, [], "v1");
    expect(none.stats.markers).toBe(3);
    expect(none.stats.labels).toBe(0);
    expect(texts(none.layer)).toHaveLength(0);
    expect([markLabel(mark(1, 10, 10, 3)), markLabel({ words: [] }), markLabel({ words: [], verb: "ATTACK", count: 9 })]).toEqual([null, null, null]);
    // Where the overlays leave no room, the marker stays and its reading waits in the tooltip.
    const crowded = new Words({ w: 1920, h: 1080 });
    crowded.update(frameOf([counted]), toScreen, [{ x0: 0, y0: 0, x1: 1920, y1: 1080 }], "v1");
    expect(crowded.stats.markers).toBe(1);
    expect(crowded.stats.labels).toBe(0);
    expect(texts(crowded.layer).filter((t) => t.visible)).toHaveLength(0);
    // A mark gone from the board takes its label with it.
    words.update(frameOf([counted]), toScreen, [], "v2");
    expect(words.drawnLabels().map((l) => l.id)).toEqual([2]);
    expect(texts(words.layer)).toHaveLength(1);
  });

  // The caste's icon in place of its word, then the count; no kind
  // symbol and never an icon alone; smaller than the old "caste · m/n" plate; the tooltip keeps the whole reading.
  it("labels a count mark with its caste's icon and its count, the count alone for any or no caste, and no kind symbol", () => {
    type Ins = { action: string; data: { style: { width: number; color: number; alpha: number }; path: { instructions: { action: string; data: unknown[] }[] } } };
    const base: StreamMark = { ...mark(2, 30, 20, 0), words: [], verb: "ATTACK", count: 10, claimed: 10 };
    const soldier: StreamMark = { ...base, caste: "soldier" };
    expect(boardLabel(soldier)).toEqual({ figure: "10/10", caste: "soldier" });
    expect(boardLabel({ ...base, caste: "worker" })).toEqual({ figure: "10/10", caste: "worker" });
    expect(boardLabel({ ...base, caste: "any" })).toEqual({ figure: "10/10", caste: null });
    expect(boardLabel(base)).toEqual({ figure: "10/10", caste: null });
    expect(boardLabel({ ...base, claimed: undefined })).toBeNull();
    // markLabel, the HUD's line, is unchanged.
    expect(markLabel(soldier)).toBe("soldier · 10/10");
    const iconPaths = (w: Words) => ((w.layer.children[1] as Graphics).context.instructions as unknown as Ins[])
      .filter((i) => i.action === "stroke")
      .flatMap((i) => i.data.path.instructions.filter((p) => p.action === "addPath").map((p) => ({ style: i.data.style, path: p.data[0] as GraphicsPath, at: p.data[1] as Matrix })));
    for (const caste of ["soldier", "worker"] as const) {
      const words = new Words({ w: 1920, h: 1080 });
      words.update(frameOf([{ ...base, caste }]), toScreen, [], "v1");
      const [label] = words.drawnLabels();
      // The drawn text is the count alone, after the icon; the box is the icon's square, a gap and the count.
      expect(label!.text).toBe("10/10");
      expect(label!.rect.x1 - label!.rect.x0).toBe(labelSize("10/10", 14, true).w);
      const texts = (c: Container): BitmapText[] => c.children.flatMap((ch) => (ch instanceof BitmapText ? [ch] : ch instanceof Container ? texts(ch) : []));
      const [text] = texts(words.layer);
      expect(text!.text).toBe("10/10");
      expect(text!.x).toBeGreaterThanOrEqual(label!.rect.x0 + 4 + 14);
      // The caste's own path (ui/deck/icons.ts), scaled from its 24-unit box into a 14 px square at the label's start:
      // a dark outline, then the owner's shade.
      const icons = iconPaths(words);
      expect(icons).toHaveLength(2);
      for (const icon of icons) {
        expect(icon.path.instructions).toEqual(new GraphicsPath(CASTE_ICON_PATH[caste]).instructions);
        expect([icon.at.a, icon.at.d, icon.at.tx]).toEqual([14 / 24, 14 / 24, label!.rect.x0 + 4]);
      }
      expect(icons.map((i) => i.style.color)).toEqual([0x000000, agentShade(0, 2, [])]);
      // No kind symbol on the label: the marker beside it carries that.
      const fills = ((words.layer.children[1] as Graphics).context.instructions as unknown as Ins[]).filter((i) => i.action === "fill");
      expect(fills).toHaveLength(1);
    }
    // Any caste, or none: the count alone, no icon, a narrower box; never an empty label.
    const plain = new Words({ w: 1920, h: 1080 });
    plain.update(frameOf([{ ...base, caste: "any" }]), toScreen, [], "v1");
    const [only] = plain.drawnLabels();
    expect(only!.text).toBe("10/10");
    expect(only!.rect.x1 - only!.rect.x0).toBe(labelSize("10/10", 14, false).w);
    expect(iconPaths(plain)).toHaveLength(0);
    // Smaller than the old plate for the same mark, "soldier · 10/10" after the kind symbol.
    const old = 14 + 4 + Math.ceil("soldier · 10/10".length * 14 * 0.6) + 2 + 8;
    expect(labelSize("10/10", 14, true).w).toBeLessThan(old / 2);
    // The tooltip, on hover of the label, keeps the whole reading, kind and caste included.
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf([soldier]), toScreen, [], "v1");
    const r = words.drawnLabels()[0]!.rect;
    words.hoverAt((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
    expect(words.tipContent()!.rows[0]!.head).toBe("ATTACK · soldier · 10 requested · 10 answered");
  });

  // Review: a squad badge must never cover a mark label (badges draw above labels), and the fix must not hide
  // the label either (second review): the label stays shown and tappable. A badge prefers a spot clear of labels; one
  // its moving ant carries onto a label moves to a spot beside the ant clear of every label, and keeps it; where every
  // spot beside the ant is on a label, the covered label moves to another spot beside its marker instead.
  it("keeps every mark label shown, tappable and clear of the squad badges: the badge moves, or else the label does", () => {
    const counted: StreamMark = { ...mark(2, 30, 20, 0), words: [], verb: "DEFEND", count: 15, claimed: 12, caste: "soldier" };
    const frame = frameOf([counted]);
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frame, toScreen, [], "v1", [[0, 300, 300]], 10);
    const label = words.drawnLabels()[0]!;
    expect(words.stats.labels).toBe(1);
    const badge = words.badges.get(0)!;
    const off = [(badge.x0 + badge.x1) / 2 - 300, (badge.y0 + badge.y1) / 2 - 300];
    // The ant walks so its badge at its layout offset would sit on the label: the badge moves off; the label stays put.
    const [lx, ly] = [(label.rect.x0 + label.rect.x1) / 2, (label.rect.y0 + label.rect.y1) / 2];
    const [ax, ay] = [lx - off[0]!, ly - off[1]!];
    words.update(frame, toScreen, [], "v1", [[0, ax, ay]], 10);
    const moved = words.badges.get(0)!;
    expect(overlaps(moved, label.rect)).toBe(false);
    expect(Math.hypot((moved.x0 + moved.x1) / 2 - ax, (moved.y0 + moved.y1) / 2 - ay)).toBeLessThanOrEqual(2 * Math.SQRT2 * 16);
    expect(words.drawnLabels()).toEqual([label]);
    expect(words.labelAt(lx, ly)).toBe(2);
    expect(words.stats.labels).toBe(1);
    const fills = () => ((words.layer.children[1] as Graphics).context.instructions as unknown as { action: string }[]).filter((i) => i.action === "fill");
    expect(fills()).toHaveLength(1);
    // It keeps its new spot as the ant walks on (no flicker back onto the label).
    words.update(frame, toScreen, [], "v1", [[0, ax + 1, ay]], 10);
    expect(words.badges.get(0)).toEqual({ x0: moved.x0 + 1, y0: moved.y0, x1: moved.x1 + 1, y1: moved.y1 });
    expect(words.drawnLabels()).toEqual([label]);

    // The ant walks so its badge would sit on the marker: the badge moves to a spot clear of the marker, so a tap on the
    // marker reaches the mark (taps go to badges first, within 4 px of a badge: squads.ts badgeAt).
    const [px, py] = [words.markers()[0]!.x, words.markers()[0]!.y];
    const keep = words.badges.get(0)!;
    const o2 = [(keep.x0 + keep.x1) / 2 - (ax + 1), (keep.y0 + keep.y1) / 2 - ay];
    words.update(frame, toScreen, [], "v1", [[0, px - o2[0]!, py - o2[1]!]], 10);
    const offMarker = words.badges.get(0)!;
    expect(overlaps(offMarker, markerRect(px, py))).toBe(false);
    expect(px >= offMarker.x0 - 4 && px <= offMarker.x1 + 4 && py >= offMarker.y0 - 4 && py <= offMarker.y1 + 4).toBe(false);
    expect(words.markAt(px, py)).toBe(2);
    for (const d of words.drawnLabels()) expect(overlaps(offMarker, d.rect)).toBe(false);
    expect(words.stats.labels).toBe(1);

    // Three labelled marks stacked two tiles apart: an ant on the middle label has every one of its first spots on a
    // marker or a label, so its badge takes the nearest further spot clear of both; no label moves.
    const stack = [2, 3, 4].map((id, i): StreamMark => ({ ...mark(id, 30, 20 + 2 * i, 0), words: [], verb: "DEFEND", count: 15, claimed: 12, caste: "soldier" }));
    const crowd = frameOf(stack);
    const busy = new Words({ w: 1920, h: 1080 });
    busy.update(crowd, toScreen, [], "v1", [[0, 300, 300]], 10);
    expect(busy.stats.labels).toBe(3);
    const before = busy.drawnLabels();
    const mid = before.find((d) => d.id === 3)!;
    const b0 = busy.badges.get(0)!;
    const o = [(b0.x0 + b0.x1) / 2 - 300, (b0.y0 + b0.y1) / 2 - 300];
    const [mx, my] = [(mid.rect.x0 + mid.rect.x1) / 2, (mid.rect.y0 + mid.rect.y1) / 2];
    const ant = [mx - o[0]!, my - o[1]!] as const;
    const markerRects = busy.markers().map((p) => markerRect(p.x, p.y));
    busy.update(crowd, toScreen, [], "v1", [[0, ant[0], ant[1]]], 10);
    const further = busy.badges.get(0)!;
    expect(busy.drawnLabels()).toEqual(before);
    for (const d of before) expect(overlaps(further, d.rect)).toBe(false);
    for (const d of markerRects) expect(overlaps(further, d)).toBe(false);
    expect(Math.hypot((further.x0 + further.x1) / 2 - ant[0], (further.y0 + further.y1) / 2 - ant[1])).toBeLessThanOrEqual(56);

    // The same, with panels all round the stack but for room for a label left of the markers (beyond the badge's
    // reach): no spot near the ant is clear, so the badge stays on the middle label and the label moves left of its
    // marker, shown and tappable there.
    const midMarker = busy.markers().find((p) => p.id === 3)!;
    const left = labelSpots(midMarker.x, midMarker.y, mid.rect.x1 - mid.rect.x0, mid.rect.y1 - mid.rect.y0)[1]!;
    const all = [...before.map((d) => d.rect), ...markerRects, left];
    const box = { x0: Math.min(...all.map((q) => q.x0)) - 5, y0: Math.min(...all.map((q) => q.y0)) - 5, x1: Math.max(...all.map((q) => q.x1)) + 5, y1: Math.max(...all.map((q) => q.y1)) + 5 };
    const panels = [{ x0: 0, y0: 0, x1: 1920, y1: box.y0 }, { x0: 0, y0: box.y1, x1: 1920, y1: 1080 }, { x0: 0, y0: box.y0, x1: box.x0, y1: box.y1 }, { x0: box.x1, y0: box.y0, x1: 1920, y1: box.y1 }];
    const boxed = new Words({ w: 1920, h: 1080 });
    boxed.update(crowd, toScreen, panels, "v2", [[0, 300, 300]], 10);
    expect(boxed.drawnLabels()).toEqual(before);
    boxed.update(crowd, toScreen, panels, "v2", [[0, ant[0], ant[1]]], 10);
    const stuck = boxed.badges.get(0)!;
    const shown = boxed.drawnLabels();
    expect(shown.map((d) => d.id).sort()).toEqual([2, 3, 4]);
    const now = shown.find((d) => d.id === 3)!;
    expect(now.rect).toEqual(left);
    for (const d of shown) expect(overlaps(stuck, d.rect)).toBe(false);
    for (const d of markerRects) expect(overlaps(stuck, d)).toBe(false);
    expect(boxed.labelAt((now.rect.x0 + now.rect.x1) / 2, (now.rect.y0 + now.rect.y1) / 2)).toBe(3);
    expect(boxed.stats.labels).toBe(3);

    // Where no spot is free, a badge takes one clear of markers and labels; else one clear of markers, on a label (which
    // then moves), never one on a marker while a marker-clear spot exists (third review: taps go to badges first).
    const placer = new Placer(400, 400, [{ x0: 0, y0: 0, x1: 400, y1: 400 }]);
    const over = { x0: 190, y0: 170, x1: 210, y1: 190 };
    const placed = placeBadges(placer, [[0, 200, 200]], 7, [], [over]).get(0)!;
    expect(overlaps(placed, over)).toBe(false);
    // Markers everywhere but the spot above the ant, which a label covers: the badge takes that spot, on the label.
    const around = [{ x0: 0, y0: 0, x1: 400, y1: 179 }, { x0: 0, y0: 195, x1: 400, y1: 400 }, { x0: 0, y0: 179, x1: 192, y1: 195 }, { x0: 208, y0: 179, x1: 400, y1: 195 }];
    const onLabel = placeBadges(new Placer(400, 400, [{ x0: 0, y0: 0, x1: 400, y1: 400 }]), [[0, 200, 200]], 7, around, [over]).get(0)!;
    expect(onLabel).toEqual({ x0: 193, y0: 180, x1: 207, y1: 194 });
    for (const d of around) expect(overlaps(onLabel, d)).toBe(false);
    expect(placeBadges(new Placer(400, 400, [{ x0: 0, y0: 0, x1: 400, y1: 400 }]), [[0, 200, 200]], 7, []).get(0)).toEqual({ x0: 193, y0: 180, x1: 207, y1: 194 });
  });

  // Regression caught: a fading mark's label fading plate and text
  // together into the ants, and labels laid across a nest. The backing was then made translucent: still constant
  // through the mark's life, no longer opaque.
  it("keeps every label on a constant translucent backing with a short leader from its ring, whatever the mark's age, and lays none across a nest", () => {
    type Ins = { action: string; data: { style: { alpha: number; width?: number; color?: number } } };
    const counted: StreamMark = { ...mark(2, 30, 20, 0), words: [], verb: "DEFEND", count: 15, claimed: 12 };
    const words = new Words({ w: 1920, h: 1080 });
    // An old mark: its ring is faint, its label is not.
    words.update(frameOf([counted], [150_000]), toScreen, [], "v1");
    const plate = (words.layer.children[1] as Graphics).context.instructions as unknown as Ins[];
    expect(plate.find((i) => i.action === "fill")!.data.style.alpha).toBe(LABEL_PLATE_ALPHA);
    expect(LABEL_PLATE_ALPHA).toBeGreaterThan(0);
    expect(LABEL_PLATE_ALPHA).toBeLessThanOrEqual(0.5);
    const leader = plate.find((i) => i.action === "stroke")!;
    expect(leader.data.style).toMatchObject({ width: 1.5, color: agentShade(0, 2, []) });
    const label = words.drawnLabels()[0]!;
    const texts = (c: Container): BitmapText[] => c.children.flatMap((ch) => (ch instanceof BitmapText ? [ch] : ch instanceof Container ? texts(ch) : []));
    expect(texts(words.layer)[0]!.alpha).toBe(1);
    // The leader runs from the ring's edge to the plate's near edge, on the side the plate lies.
    expect(leaderLine(610, 410, label.rect)).toEqual([610 + MARK_DOT.ring, 410, label.rect.x0, 410]);
    expect(leaderLine(610, 410, { x0: 500, y0: 400, x1: 580, y1: 420 })).toEqual([600, 410, 580, 410]);
    expect(leaderLine(610, 410, { x0: 570, y0: 430, x1: 650, y1: 450 })).toEqual([610, 420, 610, 430]);
    expect(leaderLine(610, 410, { x0: 570, y0: 370, x1: 650, y1: 390 })).toEqual([610, 400, 610, 390]);
    // A standing queen's nest, her tile and the zone's radius around it, is kept clear; a lost queen's is not.
    const nests = nestRects([{ x: 33.5 * 256, y: 20.5 * 256, lostTick: null }, { x: 5 * 256, y: 5 * 256, lostTick: 10 }], 2, toScreen);
    expect(nests).toEqual([{ x0: 31 * 20, y0: 18 * 20, x1: 36 * 20, y1: 23 * 20 }]);
    const clear = new Words({ w: 1920, h: 1080 });
    clear.update(frameOf([counted]), toScreen, nests, "v1");
    const placed = clear.drawnLabels()[0]!;
    expect(overlaps(placed.rect, nests[0]!)).toBe(false);
    expect(placed.rect.x1).toBeLessThan(610);
    // The stills' fall check reads a nest's zone, lost or standing, as the box of all four corners: on a tilted
    // board (here sheared) the far corners lie outside the box two corners would give.
    expect(nestZoneRect({ x: 33.5 * 256, y: 20.5 * 256 }, 2, toScreen)).toEqual(nests[0]);
    expect(nestZoneRect({ x: 33.5 * 256, y: 20.5 * 256 }, 2, (tx, ty) => [tx * 20 + ty * 5, ty * 20])).toEqual({ x0: 710, y0: 360, x1: 835, y1: 460 });
  });

  it("finds the marker under the pointer, each mark on its own, and none away from them", () => {
    const words = new Words({ w: 1920, h: 1080 });
    // Two marks of one colony with the same words, close together: each is its own marker.
    const a = mark(2, 50, 40, 1, [0, 1]);
    const b = mark(4, 52, 40, 9, [0, 1]);
    words.update(frameOf([a, b]), toScreen, [], "v1");
    expect(words.markAt(50.5 * 20 + 3, 40.5 * 20)).toBe(2);
    expect(words.markAt(52.5 * 20 - 2, 40.5 * 20 + 2)).toBe(4);
    expect(words.markAt(5, 5)).toBeNull();
  });

  it("lists every mark on the focused marker's tile in its tooltip, so marks sharing a tile can each be read", () => {
    const words = new Words({ w: 1920, h: 1080 });
    // The simulation lets two live marks share a tile (src/sim/agents.ts layMark); a third lies apart.
    const first = mark(5, 30, 20, 2, [0, 1]);
    const second = mark(6, 30, 20, 0, [1]);
    const apart = mark(7, 40, 20, 4, [0]);
    words.update(frameOf([first, second, apart]), toScreen, [], "v1");
    words.focus = words.markAt(30.5 * 20, 20.5 * 20);
    expect(words.focus).not.toBeNull();
    expect(words.tipMarks().map((m) => m.id)).toEqual([6, 5]);
    words.focus = 7;
    expect(words.tipMarks().map((m) => m.id)).toEqual([7]);
    words.focus = null;
    expect(words.tipMarks()).toEqual([]);
  });

  it("keeps a mark chosen from its log line focused while the pointer moves over the board", () => {
    const words = new Words({ w: 1920, h: 1080 });
    const chosen = mark(5, 30, 20, 2);
    const other = mark(7, 40, 20, 4);
    words.update(frameOf([chosen, other]), toScreen, [], "v1");
    words.choose(5);
    // The pointer then crosses empty board, as it does on its way back from the log: still the chosen mark.
    words.hoverAt(1918, 1078);
    expect(words.focus).toBe(5);
    expect(words.tipMarks().map((m) => m.id)).toEqual([5]);
    // On another marker, that marker; off it again, back to the chosen one; leaving the board keeps it.
    words.hoverAt(40.5 * 20, 20.5 * 20);
    expect(words.focus).toBe(7);
    words.hoverAt(5, 5);
    expect(words.focus).toBe(5);
    words.hoverAt();
    expect(words.focus).toBe(5);
    // A click elsewhere, Escape or another control clears it; hovering then focuses only what is under the pointer.
    words.clearFocus();
    words.hoverAt(5, 5);
    expect(words.focus).toBeNull();
  });

  // Regression caught: a tap on an ant standing on a mark opening the agent's card with the mark's tooltip beside
  // it (the boards' earlier wiring), or a mouse click on the same spot losing main's tooltip.
  it("on touch the ant wins: a tap with an ant under it shows no mark tooltip, one on a bare marker shows the mark, a mouse click keeps the mark", () => {
    const words = new Words({ w: 1920, h: 1080 });
    words.update(frameOf([mark(5, 30, 20, 2), mark(7, 40, 20, 4)]), toScreen, [], "v1");
    words.choose(7);
    words.tapAt(30.5 * 20, 20.5 * 20, true, true);
    expect(words.focus).toBeNull();
    // The chosen log line is let go by the tap, as by any click or tap on the board.
    words.hoverAt();
    expect(words.focus).toBeNull();
    words.tapAt(30.5 * 20, 20.5 * 20, false, true);
    expect(words.focus).toBe(5);
    words.tapAt(30.5 * 20, 20.5 * 20, true, false);
    expect(words.focus).toBe(5);
    words.tapAt(5, 5, false, true);
    expect(words.focus).toBeNull();
  });

  // Regression caught by design: the stills' squad tap landing on an ant of another agent's mark, two tiles from its
  // own, or not the nearest to its marker (one of the agent's ants
  // standing on its own mark's tile or a tile adjacent to it).
  it("lists an agent's ants standing on or beside a mark of its own, the nearest to its marker first, for the stills' squad tap", () => {
    const words = new Words({ w: 1920, h: 1080 });
    // Agent 2 owns mark 5 at (30, 20); agent 1 owns mark 7 at (40, 20); agent 0 owns mark 9 at (31, 20).
    const marks = [mark(5, 30, 20, 2), mark(7, 40, 20, 4), mark(9, 31, 20, 0)];
    const ants: [agent: number, x: number, y: number][] = [
      [2, 30.9, 20.6], // on mark 5's tile, 16.5 px from its marker at 40 px a tile
      [1, 30.5, 20.5], // on mark 5's tile, but agent 1's own mark is elsewhere
      [2, 30.2, 20.5], // on mark 5's tile, 12 px from its marker: the tap
      [2, 31.1, 20.5], // on mark 9's tile (agent 0's), beside mark 5's: counts, but farther from its marker
      [2, 45, 30],
      [1, 39.2, 20.5], // beside mark 7's tile, agent 1's own: its tap
      [0, 33, 20], // two tiles from mark 9: not on it
    ];
    const frame = { ...frameOf(marks), count: ants.length, x: Float32Array.from(ants, (a) => a[1]), y: Float32Array.from(ants, (a) => a[2]), agent: Int16Array.from(ants, (a) => a[0]) } as unknown as Frame;
    const zoomed = (tx: number, ty: number): [number, number] => [tx * 40, ty * 40];
    words.update(frame, zoomed, [], "v1");
    // The frame's positions are 32-bit floats: each point is compared to the pixel.
    const near = (points: [number, number][], expected: [number, number][]) => {
      expect(points.length).toBe(expected.length);
      points.forEach((p, i) => {
        expect(p[0]).toBeCloseTo(expected[i]![0], 3);
        expect(p[1]).toBeCloseTo(expected[i]![1], 3);
      });
    };
    // Agent 2: the ant 12 px from its marker, then the one 16.5 px off, then the one on the neighbouring tile.
    near(words.antsOnOwnMark(frame, 2, zoomed), [[30.2 * 40, 20.5 * 40], [30.9 * 40, 20.6 * 40], [31.1 * 40, 20.5 * 40]]);
    near(words.antsOnOwnMark(frame, 1, zoomed), [[39.2 * 40, 20.5 * 40]]);
    expect(words.antsOnOwnMark(frame, 0, zoomed)).toEqual([]);
    words.update(frame, toScreen, [], "v2");
    expect(words.antsOnOwnMark(frame, 2, toScreen)[0]![0]).toBeCloseTo(30.2 * 20, 3);
  });

  // Regression caught: one board's copy of the pick drifting from the other's, so the ant wins on touch on one board only,
  // or a label's tap picking the ant under it on one board.
  it.each(["../../web/src/main.ts", "../../web/src/board3d/main3d.ts"])("%s tells a touch from a mouse at the press, hands it to the pick, and lets a mark's label take the tap whole", (entry) => {
    const source = readFileSync(new URL(entry, import.meta.url), "utf8");
    expect(source).toMatch(/touched = e\.pointerType === "touch"/);
    expect(source).toMatch(/pickAnt\(e\.offsetX, e\.offsetY, touched\)/);
    // The exact pick decides whether an ant is under the tap; on touch, with none and no marker hit, the finger's tolerance picks.
    expect(source).toMatch(/const exact = antAt\(x, y\);\s*(\/\/[^\n]*\n\s*)*if \(words\.tapAt\(x, y, exact >= 0, touch\)\) \{\s*squads\.focused = -1;\s*return null;\s*\}\s*(\/\/[^\n]*\n\s*)*const best = exact >= 0 \? exact : touch && words\.focus === null \? antAt\(x, y, TOUCH_RADIUS_PX\) : -1;/);
  });

  // Regression caught: a tooltip naming one of the marks sharing a tile, or any but the newest first, or a row without its owner.
  it("gives the focused marker's tooltip a block per mark on its tile, the newest first, beside the marker in the newest mark's owner's shade (web/src/tip.ts draws it)", () => {
    const words = new Words({ w: 844, h: 390 });
    // Twelve marks on one tile, three from each of four agents.
    const marks = Array.from({ length: 12 }, (_, i) => ({ ...mark(i + 1, 21, 9, i), agent: i % 4 }));
    words.update(frameOf(marks), toScreen, [], "v1");
    expect(words.tipContent()).toBeNull();
    words.focus = words.markAt(21.5 * 20, 9.5 * 20);
    const tip = words.tipContent()!;
    expect(tip.rows).toHaveLength(12);
    expect(tip.target).toEqual(markerRect(21.5 * 20, 9.5 * 20));
    expect(tip.colour).toBe(agentShade(marks[11]!.colony, marks[11]!.agent, []));
    // The newest mark (12, agent 3: Circle) first: its words as written, no gloss, then who laid it and when, at the frame's tick 10.
    expect(tip.rows[0]).toEqual({ head: `“${wordsText([0, 1])}”`, body: "", meta: "by Circle, 1s ago" });
    expect(tip.rows.map((r) => r.meta)).toEqual(marks.map((m) => markByline(m, 10, 10)).reverse());
    // A wordless mark the stream carries no verb for: its detail
    // is "<Handle>'s mark · tile X, Y" with the one line that the recording lacks the command's details; a count mark
    // with its verb reads the set form and never that line.
    const bare = new Words({ w: 844, h: 390 });
    const wordless: StreamMark = { ...mark(20, 30, 32, 0), agent: 1, words: [] };
    const counted: StreamMark = { ...mark(21, 30, 32, 0), agent: 2, words: [], verb: "DEFEND", count: 15, claimed: 12 };
    bare.update(frameOf([wordless, counted]), toScreen, [], "v1");
    bare.focus = 20;
    expect(bare.tipContent()!.rows).toEqual([
      { head: "DEFEND · 15 requested · 12 answered", body: "", meta: markByline(counted, 10, 10) },
      { head: "Triangle's mark · tile 30, 32", body: "Command details unavailable in this recording", meta: "" },
    ]);
    expect(wordlessMarkTip({ agent: 1, tileX: 30, tileY: 32 })).toBe("Triangle's mark · tile 30, 32");
  });

  it("shows a mark's words as written in the tooltip, with no gloss and no steering count", () => {
    expect(markReading({ words: [0] })).toBe(`“${WORDS[0]}”`);
    expect(markReading({ words: [0, 5, 12] })).toBe(`“${WORDS[0]} · ${WORDS[5]} · ${WORDS[12]}”`);
  });

  it("names the squad in its badge tooltip by its handle, then its model, labelled plainly, with no intent", () => {
    // The model as the HUD names it, its badges after it in plain text, never the provider/model key.
    expect(squadTipText(0, { modelLabel: "anthropic/claude-opus-5-5" })).toBe("Diamond\nModel: Claude Opus 5.5");
    expect(squadTipText(0, { modelLabel: "openai/gpt-6.1-sol", thinkingLevel: "high", serviceTier: "fast" })).toBe("Diamond\nModel: GPT-6.1 Sol (high · Fast)");
    expect(squadTipText(0, { modelLabel: "gpt-x" })).toBe("Diamond\nModel: gpt-x");
    expect(squadTipText(2, { modelLabel: "" })).toBe("Square");
    // The HUD keeps the model's own words for a label whose provider part is the seat's handle (only the Matches lists name
    // such a seat by its handle).
    expect(agentModel({ modelLabel: "coffee-ant/local", identity: { displayName: "coffee-ant" } })?.name).toBe("local");
  });

  it("adds who laid each mark and how long ago to its tooltip, current to the playback second, in the tooltip font's characters", () => {
    // tick 1 laid; ten ticks a second.
    expect(markByline({ agent: 1, laidTick: 1 }, 121, 10)).toBe("by Triangle, 12s ago");
    expect(markByline({ agent: 9, laidTick: 1 }, 626, 10)).toBe("by Triangle 2, 1m 02s ago");
    expect(markAge(5, 0, 10)).toBe("0s ago");
    // The gloss font's characters: letters, digits, space and " -.,:!?'+".
    for (const a of [0, 7, 8, 15]) expect(markByline({ agent: a, laidTick: 0 }, 1799, 10)).toMatch(/^[A-Za-z0-9 \-.,:!?'+]+$/);
  });

  it("writes the focused tooltip's ages again as playback moves on a second", () => {
    const words = new Words({ w: 1920, h: 1080 });
    const marks = [mark(5, 30, 20, 0)];
    const at = (tick: number) => ({ ...frameOf(marks), tick, board: { marks, setup: { ticksPerSecond: 10 } } }) as unknown as Frame;
    words.update(at(10), toScreen, [], "v1");
    words.focus = 5;
    // Laid at tick 1 (match second 0); tick 10 is match second 1.
    expect(words.tipContent()!.rows[0]!.meta).toBe("by Square, 1s ago");
    words.update(at(125), toScreen, [], "v1");
    expect(words.tipContent()!.rows[0]!.meta).toBe("by Square, 12s ago");
  });
});

describe("agent handles", () => {
  it("gives every agent of a match its own handle, named for the glyph its badge and swatch draw", () => {
    const handles = Array.from({ length: 20 }, (_, i) => agentHandle(i));
    expect(new Set(handles).size).toBe(handles.length);
    for (let i = 0; i < handles.length; i++) expect(handles[i]!.toLowerCase().startsWith(agentGlyph(i))).toBe(true);
    expect(handles.slice(0, GLYPHS.length)).toEqual(["Diamond", "Triangle", "Square", "Circle", "Star", "Hexagon", "Chevron", "Cross"]);
    expect(agentHandle(8)).toBe("Diamond 2");
    expect(agentHandle(17)).toBe("Triangle 3");
  });
});

describe("tooltips", () => {
  const screen = { w: 390, h: 844 };
  it("sit centred above what was pointed at, on screen", () => {
    const r = tipRect({ x0: 190, y0: 400, x1: 210, y1: 420 }, 120, 40, screen);
    expect(r).toEqual({ x0: 140, y0: 354, x1: 260, y1: 394 });
  });
  it("flip below at the top edge or under an overlay, and stay across the screen at its sides, TIP_EDGE in from the edge (the 031b9eb phone stills: a plate flush with the edge read as cut)", () => {
    expect(TIP_EDGE).toBe(6);
    expect(tipRect({ x0: 0, y0: 10, x1: 20, y1: 30 }, 120, 40, screen)).toEqual({ x0: 6, y0: 36, x1: 126, y1: 76 });
    const panel = { x0: 0, y0: 0, x1: 390, y1: 380 };
    const r = tipRect({ x0: 370, y0: 400, x1: 390, y1: 420 }, 120, 40, screen, [panel]);
    expect(r).toEqual({ x0: 264, y0: 426, x1: 384, y1: 466 });
    expect(overlaps(r, panel)).toBe(false);
  });
  it("show every row that fits, else the most that fit above one '+N more' line", () => {
    const rows = [37, 37, 37, 37];
    expect(tipFit(rows, 4, 5, 17, tipHeight(rows, 4, 5))).toBe(4);
    for (const maxH of [60, 100, 140, 160]) {
      const k = tipFit(rows, 4, 5, 17, maxH);
      expect(k).toBeLessThan(rows.length);
      expect(tipHeight(rows.slice(0, k), 4, 5, 17)).toBeLessThanOrEqual(maxH);
      expect(tipHeight(rows.slice(0, k + 1), 4, 5, 17)).toBeGreaterThan(maxH);
    }
  });
  it("find the free rows between the overlays above and below, across the tooltip's whole width", () => {
    const phone = { w: 844, h: 390 };
    const marker = { x0: 410, y0: 180, x1: 430, y1: 200 };
    const header = { x0: 6, y0: 6, x1: 838, y1: 100 };
    const bar = { x0: 6, y0: 350, x1: 838, y1: 384 };
    expect(tipBand(marker, 200, phone, [header, bar])).toEqual({ y0: 100, y1: 350 });
    // A panel off the marker's own column but under the tooltip's span bounds it too.
    const corner = { x0: 480, y0: 0, x1: 600, y1: 140 };
    expect(tipBand(marker, 200, phone, [corner, bar])).toEqual({ y0: 140, y1: 350 });
    expect(tipBand(marker, 40, phone, [corner, bar])).toEqual({ y0: 0, y1: 350 });
    // A side panel spanning the marker's height does not bound it.
    expect(tipBand(marker, 200, phone, [{ x0: 0, y0: 6, x1: 340, y1: 340 }])).toEqual({ y0: 0, y1: 390 });
  });
  it("stay inside the screen when the free rows cannot hold one row and the '+N more' line", () => {
    const phone = { w: 844, h: 390 };
    const marker = { x0: 410, y0: 120, x1: 430, y1: 140 };
    const blocked = [{ x0: 0, y0: 0, x1: 844, y1: 115 }, { x0: 0, y0: 145, x1: 844, y1: 390 }];
    const band = tipBand(marker, 200, phone, blocked);
    expect(band.y1 - band.y0).toBe(30);
    const rows = [37, 37, 37];
    expect(tipFit(rows, 4, 5, 17, band.y1 - band.y0)).toBe(0);
    // Only the more line: 22 px, inside the 30 px band.
    const h = tipHeight([], 4, 5, 17);
    const r = tipRect(marker, 200, h, phone, blocked);
    expect(r.y0).toBeGreaterThanOrEqual(band.y0);
    expect(r.y1).toBeLessThanOrEqual(band.y1);
    // Taller than the band: clamped into the screen.
    const tall = tipRect(marker, 200, 60, phone, blocked);
    expect(tall.y0).toBeGreaterThanOrEqual(0);
    expect(tall.y1).toBeLessThanOrEqual(phone.h);
  });
  it("take no space in the layout: a squad's tooltip is beside its badge and leaves the placer as it was", () => {
    const placer = new Placer(1920, 1080);
    const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const squads = new Squads(renderer, 1920);
    const ants = { count: 1, id: new Uint32Array([1]), x: new Float32Array([40]), y: new Float32Array([30]), agent: new Int16Array([0]) };
    const frame = { ...ants, tick: 1, board: { agents: [{ colony: 0, modelLabel: "m0", intent: "" }] } } as unknown as Frame;
    const toScreen = (tx: number, ty: number): [number, number] => [tx * 18, ty * 18];
    const badges = placeBadges(placer, squads.anchors(frame, toScreen), squads.badgeR, []);
    const before = [...placer.rects];
    squads.focused = 0;
    squads.updateBadges(frame, toScreen, badges);
    const tip = squads.tipContent(frame)!;
    expect(placer.rects).toEqual(before);
    // Beside its badge, in the agent's hue: its handle, then its model, as web/src/tip.ts draws it.
    expect(tip.target).toEqual(badges.get(0));
    expect(tip.colour).toBe(agentShade(0, 0, []));
    expect(tip.rows).toEqual([{ head: "Diamond", body: "Model: m0", meta: "" }]);
    // The plate sits centred above the badge, taking no space in the layout.
    const r = tipRect(tip.target, 160, 30, { w: 1920, h: 1080 });
    expect(r.y1).toBeLessThan(tip.target.y0);
    expect(Math.abs((r.x0 + r.x1) / 2 - (tip.target.x0 + tip.target.x1) / 2)).toBeLessThanOrEqual(1);
  });

  it("keeps the tooltip on roster hover and gives none for the selected agent: its card names it", () => {
    const placer = new Placer(1920, 1080);
    const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const squads = new Squads(renderer, 1920);
    const ants = { count: 1, id: new Uint32Array([1]), x: new Float32Array([40]), y: new Float32Array([30]), agent: new Int16Array([0]) };
    const frame = { ...ants, tick: 1, board: { agents: [{ colony: 0, modelLabel: "", intent: "" }] } } as unknown as Frame;
    const toScreen = (tx: number, ty: number): [number, number] => [tx * 18, ty * 18];
    const badges = placeBadges(placer, squads.anchors(frame, toScreen), squads.badgeR, []);
    squads.updateBadges(frame, toScreen, badges);
    // Hovering its roster row with nothing selected: the tooltip shows, as before; no model label, no second line.
    squads.hovered = 0;
    expect(squads.tipContent(frame, -1)).toEqual({ target: badges.get(0), colour: agentShade(0, 0, []), rows: [{ head: "Diamond", body: "", meta: "" }] });
    // Selected (overlays pass the selection as hovered too), and also tapped on the board: no tooltip.
    squads.focused = 0;
    expect(squads.tipContent(frame, 0)).toBeNull();
    // Selection cleared, the pointer still on the squad: the tooltip shows again.
    squads.hovered = -1;
    expect(squads.tipContent(frame, -1)).not.toBeNull();
    // An agent with no badge drawn (no ants) has none.
    squads.focused = 1;
    expect(squads.tipContent(frame, -1)).toBeNull();
  });
});

describe("sizes follow the screen", () => {
  it("rescales the badges when the screen changes size; the tooltips are the page's own type", () => {
    expect(badgeRadiusPx(3840)).toBeGreaterThan(badgeRadiusPx(1920));
    expect(badgeRadiusPx(1280)).toBeLessThan(badgeRadiusPx(1920));
  });
});

describe("the masthead's stream line", () => {
  it("says the match ended once playback has the result, whatever the stream does", () => {
    for (const state of ["connecting", "open", "reconnecting"] as const) expect(linkLine(state, true)).toBe(ENDED_LINE);
    expect(ENDED_LINE).toBe("Match ended");
  });
  it("names the stream's state mid-match in the set words, and says nothing while it is open", () => {
    expect(linkLine("connecting", false)).toBe(CONNECTING_LINE);
    expect(linkLine("reconnecting", false)).toBe(RECONNECTING_LINE);
    expect(linkLine("open", false)).toBe("");
    expect([CONNECTING_LINE, RECONNECTING_LINE]).toEqual(["Connecting", "Reconnecting…"]);
  });
});

describe("agent badges", () => {
  it("anchors each squad's badge on its ant nearest the squad's mean, ties to the lowest ant id; no ants, no badge", () => {
    // Agent 0's squad is split in two; its mean lies between them, on no ant.
    const ants = { count: 5, id: [7, 3, 9, 5, 11], x: [0, 0, 10, 10, 4], y: [0, 1, 0, 1, 4], agent: [0, 0, 0, 0, -1] };
    const anchors = badgeAnchors(ants, squadCentres(ants as unknown as Frame));
    expect([...anchors.keys()]).toEqual([0]);
    // All four ants are equally near the mean: the lowest id, 3, carries the badge.
    expect(anchors.get(0)).toEqual({ x: 0, y: 1, n: 4, ant: 3 });
  });

  it("in a crowded scene every agent with ants has a badge drawn", () => {
    const r = rng(6);
    const agents = 20;
    const n = 400;
    const id = new Uint32Array(n);
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const agent = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      id[i] = i;
      agent[i] = i % (agents + 1) === agents ? -1 : i % (agents + 1);
      x[i] = 20 + r() * 8;
      y[i] = 20 + r() * 8;
    }
    const frame = { count: n, id, x, y, agent, tick: 1, board: { agents: Array.from({ length: agents }, (_, i) => ({ colony: i % 2, modelLabel: `m${i}`, intent: "" })) } } as unknown as Frame;
    // The screen is already full of labels: no free spot anywhere near the squads.
    const placer = new Placer(1920, 1080);
    for (let gx = 0; gx < 1920; gx += 100) for (let gy = 0; gy < 1080; gy += 40) placer.occupy({ x0: gx, y0: gy, x1: gx + 96, y1: gy + 36 });
    const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const squads = new Squads(renderer, 1920);
    const toScreen = (tx: number, ty: number): [number, number] => [tx * 18, ty * 18];
    const badges = placeBadges(placer, squads.anchors(frame, toScreen), squads.badgeR, []);
    squads.updateBadges(frame, toScreen, badges);
    expect(squads.badgeAgents().sort((a, b) => a - b)).toEqual(Array.from({ length: agents }, (_, i) => i));
    expect(squads.shown.full).toBe(agents);
  });

  it("draws each badge as a square plate in its 2r footprint, never a circle like a mark's ping", () => {
    type Prim = { shape: { type: string; x: number; y: number; width?: number; height?: number; radius?: number; points?: number[] } };
    type Ins = { data: { path?: { shapePath: { shapePrimitives: Prim[] } } } };
    const shapes = (g: Graphics) => (g.context.instructions as unknown as Ins[]).flatMap((ins) => ins.data.path?.shapePath.shapePrimitives.map((p) => p.shape) ?? []);
    const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const squads = new Squads(renderer, 390);
    const frame = { count: 1, id: new Uint32Array([1]), x: new Float32Array([10]), y: new Float32Array([10]), agent: new Int16Array([0]), tick: 1, board: { agents: [{ colony: 0, modelLabel: "m0", intent: "" }] } } as unknown as Frame;
    const toScreen = (tx: number, ty: number): [number, number] => [tx * 18, ty * 18];
    const badges = placeBadges(new Placer(390, 844), squads.anchors(frame, toScreen), squads.badgeR, []);
    squads.updateBadges(frame, toScreen, badges);
    const spot = badges.get(0)!;
    const badge = shapes(squads.layer.children.find((c) => c instanceof Graphics) as Graphics);
    expect(badge.some((s) => s.type === "circle")).toBe(false);
    const plate = badge.find((s) => s.type === "roundedRectangle")!;
    expect(plate).toMatchObject({ x: spot.x0, y: spot.y0, width: spot.x1 - spot.x0, height: spot.y1 - spot.y0 });
    expect(plate.radius).toBeLessThanOrEqual(3);
    // A mark's marker, by contrast, is round: a ring on its halo, holding its owner's glyph and never a plate.
    const words = new Words({ w: 390, h: 844 });
    const m: StreamMark = { id: 1, agent: 0, colony: 0, tileX: 4, tileY: 4, words: [0, 1], laidTick: 1, answered: 0 };
    words.update({ tick: 10, board: { marks: [m] }, marks: [{ mark: m, ageMs: 5000 }] } as unknown as Frame, toScreen, [], "v1");
    const marker = shapes(words.layer.children.find((c) => c instanceof Graphics) as Graphics);
    expect(marker.filter((s) => s.type === "circle")).toHaveLength(2);
    expect(marker.some((s) => s.type === "roundedRectangle")).toBe(false);
    const glyphs = marker.filter((s) => s.type === "polygon");
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]!.points).toEqual(glyphPolygon(0, MARK_DOT.glyph).map((v) => v + 81));
  });

  it("draws a distinct glyph for each of eight agents", () => {
    const shapes = new Set<string>();
    for (let a = 0; a < 8; a++) {
      const pts = glyphPolygon(a, 4.5);
      shapes.add(pts.map((v) => v.toFixed(2)).join(","));
    }
    expect(shapes.size).toBe(8);
    expect(glyphPolygon(8, 4.5)).toEqual(glyphPolygon(0, 4.5));
  });

  // Every agent shows its colony's one colour, whatever its place in join order; agents within a colony are told apart
  // by glyph (above) and name.
  it("gives every agent its colony's one colour", () => {
    const agents = ([0, 1, 1, 0, 0, 1, 0, 1, 0] as const).map((colony) => ({ colony }));
    expect(agentHues(agents).map(cssColour)).toEqual(agents.map((a) => (a.colony === 0 ? "#ffb000" : "#00c2ff")));
    expect(agentShade(1, 2, agents)).toBe(0x00c2ff);
  });
});

describe("the selected squad leads", () => {
  const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
  it("selects the squad hovered in the roster, else the one pointed at or tapped on the board", () => {
    const squads = new Squads(renderer, 1920);
    expect(squads.selected).toBe(-1);
    squads.focused = 2;
    expect(squads.selected).toBe(2);
    squads.hovered = 5;
    expect(squads.selected).toBe(5);
    squads.hovered = -1;
    squads.focused = -1;
    expect(squads.selected).toBe(-1);
  });

  // Regression caught: squad ants tinted only while selected, a free
  // ant taking a hue, or a dimmed squad losing its hue.
  it("tints squad ants in their agent's hue at all times and leaves free ants plain; a selected squad is ringed and every other ant dimmed, a squad ant keeping its hue under the dim", () => {
    expect(antTint(3, -1, 0xff0000)).toBe(0xff0000);
    expect(antTint(-1, -1, 0xff0000)).toBe(0xffffff);
    expect(antTint(3, 3, 0xff0000)).toBe(0xff0000);
    expect(antTint(4, 3, 0xff0000)).toBe(0x770000);
    expect(antTint(-1, 3, 0xff0000)).toBe(DIM_TINT);
    // Dimmed means darker on every channel than plain chitin.
    for (const shift of [16, 8, 0]) expect((DIM_TINT >> shift) & 0xff).toBeLessThan(0xc0);
    // A tapped squad on the board (no roster hover, as on a phone) gets the rings.
    const squads = new Squads(renderer, 390);
    const frame = { count: 3, x: new Float32Array([1, 2, 3]), y: new Float32Array([1, 2, 3]), agent: new Int16Array([0, 1, 0]), alpha: new Float32Array([1, 1, 1]), board: { agents: [{ colony: 0 }, { colony: 1 }] } } as unknown as Frame;
    squads.focused = 0;
    expect(squads.updateRings(frame, 1)).toBe(2);
    // A fallen colony's ants are dimmed as fallen whatever squad is selected; the other colony's are untouched.
    const ants = new Ants({ generateTexture: () => Texture.WHITE } as unknown as Renderer, 16, 12.5);
    const f = new Frame();
    f.ensure(3);
    f.count = 3;
    f.colony.set([0, 1, 1]);
    f.agent.set([0, 1, -1]);
    f.alpha.set([1, 1, 0.5]);
    f.id.set([1, 2, 3]);
    const hues = [0x00ff00, 0xff0000];
    ants.update(f, 1, hues, [false, true]);
    const drawn = ants.antLayer.particleChildren as Particle[];
    expect(drawn.slice(0, 3).map((p) => p.tint)).toEqual([0x007000, FALLEN_TINT, FALLEN_TINT]);
    expect(drawn.slice(0, 3).map((p) => p.alpha)).toEqual([1, FALLEN_ALPHA, 0.5 * FALLEN_ALPHA]);
    // With no squad selected, each squad ant still carries its agent's hue; the free ant stays plain.
    ants.update(f, -1, hues);
    expect(drawn.slice(0, 3).map((p) => p.tint)).toEqual([0x00ff00, 0xff0000, 0xffffff]);
    ants.update(f);
    expect(drawn.slice(0, 3).map((p) => [p.tint, p.alpha])).toEqual([[0xffffff, 1], [0xffffff, 1], [0xffffff, 0.5]]);
  });
});

describe("tilt-shift", () => {
  it("is off by default and on only when asked for", () => {
    expect(tiltOn(new URLSearchParams(""))).toBe(false);
    expect(tiltOn(new URLSearchParams("tilt=0"))).toBe(false);
    expect(tiltOn(new URLSearchParams("tilt=1"))).toBe(true);
  });
});

describe("badges and markers", () => {
  it("puts a badge beside its ant clear of a mark's marker where a spot is free, and clear of markers where none is", () => {
    const dot = markerRect(200, 183);
    const placer = new Placer(390, 844);
    placer.occupy(dot);
    const b = placeBadges(placer, [[0, 200, 200]], 7, [dot]).get(0)!;
    expect(overlaps(b, dot)).toBe(false);
    // Everything near the ant is taken by overlays: the badge still avoids the marker.
    const full = new Placer(390, 844, [{ x0: 0, y0: 0, x1: 390, y1: 844 }]);
    full.occupy(dot);
    const b2 = placeBadges(full, [[0, 200, 200]], 7, [dot]).get(0)!;
    expect(overlaps(b2, dot)).toBe(false);
  });
});

describe("soldiers drawn larger", () => {
  it("the board carries each ant's caste from the stream into the frame, and draws soldiers from their own frames at 2x", () => {
    const script = { seed: 6007, config: playable(RULES_V4_CONFIG), agents: 6, ticks: 1200, attack: true };
    const messages = recordLog(playScripted(script).lines, 1200).map((m) => decodeMessage(m));
    const last = messages.at(-1)!;
    const pb = new Playback();
    for (const m of messages) pb.push(m, m.tick * TICK_MS);
    const frame = new Frame();
    pb.sample(last.tick * TICK_MS + 60_000, frame);
    expect(frame.count).toBe(last.ants.count);
    const castes = [...frame.caste.subarray(0, frame.count)];
    expect(castes).toEqual([...(last.ants.caste ?? new Uint8Array(last.ants.count))]);
    expect(castes).toContain(1);

    const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const ants = new Ants(renderer, 20, 10);
    ants.update(frame);
    const drawn = ants.antLayer.particleChildren.slice(0, frame.count);
    // Drawn size is the frame's size times the particle's scale.
    const size = (i: number) => [drawn[i]!.texture.orig.width * drawn[i]!.scaleX, drawn[i]!.texture.orig.height * drawn[i]!.scaleY];
    const [workerW, workerH] = size(castes.indexOf(0));
    const [soldierW, soldierH] = size(castes.indexOf(1));
    expect(SOLDIER_SCALE).toBe(2);
    expect(soldierW / workerW).toBeCloseTo(2, 12);
    expect(soldierH / workerH).toBeCloseTo(2, 12);
    // A soldier is never a worker's frame scaled up: its frames are its own (its silhouette), baked at its size.
    const soldierFrames = new Set(drawn.filter((_, i) => castes[i] === 1).map((p) => p.texture));
    const workerFrames = new Set(drawn.filter((_, i) => castes[i] === 0).map((p) => p.texture));
    expect([...soldierFrames].some((t) => workerFrames.has(t))).toBe(false);
    drawn.forEach((p, i) => {
      expect(p.scaleY).toBe(p.scaleX);
      expect(size(i)).toEqual(castes[i] === 1 ? [soldierW, soldierH] : [workerW, workerH]);
    });

    // An ant that changes caste in a pooled slot takes the other frame and size.
    const swapped = new Frame();
    pb.sample(last.tick * TICK_MS + 60_000, swapped);
    for (let i = 0; i < swapped.count; i++) swapped.caste[i] = 1 - swapped.caste[i]!;
    ants.update(swapped);
    ants.antLayer.particleChildren.slice(0, swapped.count).forEach((p, i) => {
      expect(p.texture.orig.width * p.scaleX).toBeCloseTo(castes[i] === 1 ? workerW : soldierW, 12);
    });
  }, 60_000);

  it("with the rules switch off every ant is drawn from a worker's frames at the worker size", () => {
    const script = { seed: 6007, config: playable(DEFAULT_CONFIG), agents: 6, ticks: 300, attack: true };
    const messages = recordLog(playScripted(script).lines, 300).map((m) => decodeMessage(m));
    const pb = new Playback();
    for (const m of messages) pb.push(m, m.tick * TICK_MS);
    const frame = new Frame();
    pb.sample(messages.at(-1)!.tick * TICK_MS + 60_000, frame);
    expect([...frame.caste.subarray(0, frame.count)].every((c) => c === 0)).toBe(true);
    const renderer = { generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const ants = new Ants(renderer, 20, 10);
    ants.update(frame);
    const widths = new Set(ants.antLayer.particleChildren.slice(0, frame.count).map((p) => p.texture.orig.width * p.scaleX));
    expect(widths.size).toBe(1);
  }, 60_000);
  /** The Graphics the atlas is baked from (0: workers and corpses, 1: soldiers), as plain draw instructions. */
  const atlasDrawing = (which: 0 | 1) => {
    let holder: Container | null = null;
    const renderer = { resolution: 1, generateTexture: (o: { target: Container }) => ((holder = o.target), Texture.WHITE) } as unknown as Renderer;
    new Ants(renderer, 20, 10);
    const g = holder!.children[which] as Graphics;
    type Ins = { action: string; data: { style: { color: number; width?: number; alpha: number }; path: { shapePath: { shapePrimitives: { shape: Record<string, unknown> }[] } } } };
    return (g.context.instructions as unknown as Ins[]).map((i) => ({
      a: i.action,
      c: i.data.style.color,
      w: i.data.style.width,
      al: i.data.style.alpha,
      s: i.data.path.shapePath.shapePrimitives.map((p) => ({ ...p.shape }) as { type: string; x?: number; y?: number; halfWidth?: number; radius?: number }),
    }));
  };

  it("a soldier's head and abdomen are filled with the colony colour and outlined thin and dark; no body part is pale chitin", () => {
    const drawn = atlasDrawing(1);
    for (const colony of [0, 1]) {
      for (let f = 0; f < 3; f++) {
        for (const part of [SOLDIER_HEAD, SOLDIER_ABDOMEN]) {
          const at = (i: (typeof drawn)[number]) => i.s.some((s) => s.type === "ellipse" && s.x === f * 64 + part.x && s.y === colony * 48 + 24 && s.halfWidth === part.rx);
          const fill = drawn.find((i) => i.a === "fill" && at(i));
          const outline = drawn.find((i) => i.a === "stroke" && at(i));
          expect(fill?.c).toBe(COLONY_TINT[colony]);
          expect(outline?.c).toBe(0x0b0907);
          expect(outline!.w!).toBeLessThanOrEqual(1.5);
        }
      }
    }
    // The old pale square head (and any pale body part): no chitin fill on a closed shape.
    const PALE = 0xece4d4;
    expect(drawn.filter((i) => i.a === "fill" && i.c === PALE)).toEqual([]);
    expect(drawn.some((i) => i.s.some((s) => s.type === "roundedRectangle"))).toBe(false);
  });

  it("workers are drawn exactly as before the soldier changes (the atlas's worker drawing, pinned at 1ba2eb7)", () => {
    const json = JSON.stringify(atlasDrawing(0));
    expect(createHash("sha256").update(json).digest("hex")).toBe("af70924f4879d82a17cd84c7a9939c0f26bbb9878dd0122c38a8f88fcd96642a");
  });
});

it.each(["any", "worker", "soldier"] as const)("shows %s caste in count-mark labels and tooltip readings without changing legacy labels", caste => {
  const mark = { words: [], verb: "FORAGE", count: 12, claimed: 8, caste };
  expect(markReading(mark)).toBe(`FORAGE · ${caste} · 12 requested · 8 answered`);
  expect(markLabel(mark)).toBe(`${caste} · 8/12`);
  const { caste: _caste, ...legacy } = mark;
  expect(markReading(legacy)).toBe("FORAGE · 12 requested · 8 answered");
  expect(markLabel(legacy)).toBe("8/12");
});
