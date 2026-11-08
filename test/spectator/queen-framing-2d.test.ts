import { describe, expect, it } from "vitest";
import { Camera, foundingEnvelope, fitFoundingView, type Box } from "../../web/src/camera.ts";
import { fitOpeningView } from "../../web/src/start-framing.ts";
import { nestZoneRect } from "../../web/src/words.ts";
import { QUEEN_FRAME_TILES } from "../../web/src/buffer.ts";
import { SUB_TILE } from "../../src/live/format.ts";

const setup = { mapW: 128, mapH: 96 };
const envelope = foundingEnvelope(setup);
const area: Box = { x0: 24, y0: 163, x1: 1572, y1: 1000 };
function camera(a = area) {
  return new Camera(128, 96, 1920, 1080, a, { x0: 4, y0: 20, x1: 124, y1: 76 },
    { x0: 1, y0: 17, x1: 127, y1: 79 }, 2);
}

describe("opt-in stable 2D founding frame", () => {
  it("uses immutable map dimensions and the diagnostic's border, not current queens", () => {
    expect(envelope).toEqual({ x0: -2.25, y0: -2.25, x1: 130.25, y1: 98.25 });
    expect(envelope.x0).toBe(-QUEEN_FRAME_TILES - 0.25);
  });
  it.each([[1920, 1080], [1366, 768], [390, 844], [360, 780], [844, 390]])(
    "contains every edge tile's whole nest without refitting at %ix%i", (width, height) => {
      // This is mathematical regression coverage, not a rendered browser proof.
      const a = { x0: 0, y0: 0, x1: width, y1: height };
      const c = camera(a); c.setFoundingEnvelope(envelope);
      const before = { ...c.view };
      const tiles = Array.from({ length: 128 }, (_, x) => [[x, 0], [x, 95]]).flat()
        .concat(Array.from({ length: 96 }, (_, y) => [[0, y], [127, y]]).flat());
      for (const [x, y] of tiles) {
        const rect = nestZoneRect({ x: x! * SUB_TILE, y: y! * SUB_TILE }, QUEEN_FRAME_TILES, c.toScreen);
        expect(rect.x0).toBeGreaterThan(a.x0); expect(rect.y0).toBeGreaterThan(a.y0);
        expect(rect.x1).toBeLessThan(a.x1); expect(rect.y1).toBeLessThan(a.y1);
      }
      c.setFoundingEnvelope(foundingEnvelope(setup));
      expect(c.view).toEqual(before);
      expect(c.atHome()).toBe(true);
    });
  it("with a matching stage ratio leaves only the specified edge border and margin off map", () => {
    const ratio = (envelope.x1 - envelope.x0) / (envelope.y1 - envelope.y0);
    const a = { x0: 12, y0: 20, x1: 12 + 300 * ratio, y1: 320 };
    const v = fitFoundingView(envelope, a);
    expect(v.ox + envelope.x0 * v.tilePx).toBeCloseTo(a.x0, 10);
    expect(v.oy + envelope.y0 * v.tilePx).toBeCloseTo(a.y0, 10);
    expect(v.ox + envelope.x1 * v.tilePx).toBeCloseTo(a.x1, 10);
    expect(v.oy + envelope.y1 * v.tilePx).toBeCloseTo(a.y1, 10);
  });
  it("retains the opening phase and then returns to the stable normal home", () => {
    const c = camera(); c.setFoundingEnvelope(envelope);
    const normal = { ...c.view }, opening = { x0: 0, y0: 10, x1: 100, y1: 80 };
    c.setOpeningBounds(opening);
    expect(c.view).toEqual(fitOpeningView(opening, area));
    c.setOpeningBounds(null);
    expect(c.view).toEqual(normal);
    c.setArea({ x0: 0, y0: 0, x1: 480, y1: 360 });
    expect(c.view).toEqual(fitFoundingView(envelope, c.area));
  });
  it.each([[1103.5, 837], [666.78125, 505.75], [390, 295.796875], [360, 273.046875], [445.609375, 338]])(
    "keeps the founding scale on the first gesture in a %ix%i stage", (width, height) => {
      const a = { x0: 24, y0: 163, x1: 24 + width, y1: 163 + height };
      const c = camera(a); c.setFoundingEnvelope(envelope);
      const home = { ...c.view };
      expect(home.tilePx).toBeLessThan(c.fit.tilePx);
      c.panBy(1, 1);
      expect(c.view.tilePx).toBe(home.tilePx);
      expect(c.view.ox).toBeCloseTo(home.ox + 1, 10);
      expect(c.view.oy).toBeCloseTo(home.oy + 1, 10);
      c.panBy(120, 40); // A larger drag may hit the edge clamp, but never changes scale.
      expect(c.view.tilePx).toBe(home.tilePx);
      expect(c.view).not.toEqual(c.fit);
      c.set(home);
      c.zoomBy(1 / 1.5);
      expect(c.view).toEqual(home); // At the minimum: zoom-out must never zoom in.
      c.zoomAt(0.5, a.x0 + width / 3, a.y0 + height / 3);
      expect(c.view).toEqual(home);
      c.zoomBy(1.005); // Even a small zoom below the old map-fit floor is continuous.
      expect(c.view.tilePx).toBeCloseTo(home.tilePx * 1.005, 10);
      c.zoomBy(1 / 1.005);
      expect(c.view).toEqual(home);
      c.panBy(1, 1);
      c.setArea({ ...a, x1: a.x1 - 10 });
      expect(c.view).toEqual(fitFoundingView(envelope, c.area));
    });
  it.each([[{ x0: 0, y0: 0, x1: 1920, y1: 1080 }], [area]])("reset() returns to the founding-envelope home view in %o", (a) => {
    const c = camera(a); c.setFoundingEnvelope(envelope);
    const home = { ...c.view };
    expect(home).toEqual(fitFoundingView(envelope, a));
    c.zoomBy(2); c.panBy(40, -25);
    expect(c.view).not.toEqual(home);
    c.reset();
    expect(c.view).toEqual(home);
    expect(c.view.tilePx).toBeLessThan(c.fit.tilePx);
    expect(c.atHome()).toBe(true);
    const opening = { x0: 0, y0: 10, x1: 100, y1: 80 };
    c.setOpeningBounds(opening);
    c.zoomBy(2); c.panBy(10, 10);
    c.reset();
    expect(c.view).toEqual(fitOpeningView(opening, a));
    c.setOpeningBounds(null);
    expect(c.view).toEqual(home);
  });
  it("reset() keeps the map fit for callers without a founding envelope", () => {
    const c = camera();
    c.zoomBy(2); c.panBy(40, -25);
    c.reset();
    expect(c.view).toEqual(c.fit);
  });
  it("preserves the legacy map-fit minimum for callers without a founding envelope", () => {
    const c = camera(); c.reset();
    c.panBy(1, 1); expect(c.view).toEqual(c.fit);
    c.zoomBy(1 / 1.5); expect(c.view).toEqual(c.fit);
  });
  it("does not opt other Camera callers into the new home or undo a viewer's move", () => {
    const original = camera(), c = camera();
    expect(c.view).toEqual(original.view);
    c.setFoundingEnvelope(envelope);
    c.zoomBy(2); c.panBy(10, 5);
    const moved = { ...c.view };
    c.setFoundingEnvelope(foundingEnvelope(setup));
    expect(c.view).toEqual(moved);
    c.setFoundingEnvelope(null);
    expect(c.view).toEqual(moved);
    c.resize(1920, 1080, area);
    expect(c.view).toEqual(original.view);
  });
});
