/**
 * The 3D fall on a fall recording (a 64x48 board, Lake Hodges' three queens at
 * x 55, y 8, 24 and 40, zone radius 8): the stage stays only board, and each fallen queen keeps her tile and her emblem whole; only her zone and ground margin
 * give way, at the stage's top and bottom. At 58cb35d the farthest the board allowed cut the top and bottom queens
 * (3d-1 at 1920x1080, 3d-2 at 1366x768). Each case starts from the viewer's tilt as those stills show it (fitted to
 * their queen boxes: 24.1 degrees at 1920x1080, 25.9 at 1366x768).
 */
import { describe, expect, it } from "vitest";
import { FALL_EMBLEM_PX, FALL_FRAME_PAD, QUEEN_FRAME_TILES } from "../../web/src/buffer.ts";
import { QUEEN_EMBLEM } from "../../web/src/effects.ts";
import { COVER_MARGIN, HERO_ALPHA, boardBox, fallPose, groundBox, project, type Pose } from "../../web/src/board3d/view.ts";

const W = 64, H = 48, x = 55, ys = [8, 24, 40] as const, pad = 8 + FALL_FRAME_PAD, q = QUEEN_FRAME_TILES;
const nests = { x0: x - pad, y0: ys[0] - pad, x1: x + 1 + pad, y1: ys[2] + 1 + pad };
const queens = { x0: x - q, y0: ys[0] - q, x1: x + 1 + q, y1: ys[2] + 1 + q };

it("counts a queen's emblem as the boards draw it: its disc and half its ring, in CSS px", () => {
  expect(FALL_EMBLEM_PX).toBe(QUEEN_EMBLEM.r + QUEEN_EMBLEM.ringW / 2);
});

describe("the 3D fall of a colony of nests down the board's height", () => {
  const cases = [
    { name: "1920x1080", w: 1920, h: 1080, area: { x0: 24, y0: 163, x1: 1572, y1: 1000 }, beta: 0.4209 },
    { name: "1366x768", w: 1366, h: 768, area: { x0: 24, y0: 182.25, x1: 1018, y1: 688 }, beta: 0.4514 },
  ];
  for (const { name, w, h, area, beta } of cases) {
    it(`at ${name}: only board in the stage, each fallen queen's tile and emblem whole`, () => {
      const base: Pose = { alpha: HERO_ALPHA, beta, radius: 90, target: [32, 0, 24] };
      const fall = fallPose(base, nests, queens, W, H, w, h, area);
      // Only board: the ground the stage shows lies within the board's edge (coverBoard's margin).
      const g = groundBox(fall, w, h, area)!;
      expect(Math.min(g.x0, g.z0) - COVER_MARGIN).toBeGreaterThanOrEqual(-1e-6);
      expect(W - COVER_MARGIN - g.x1).toBeGreaterThanOrEqual(-1e-6);
      expect(H - COVER_MARGIN - g.z1).toBeGreaterThanOrEqual(-1e-6);
      for (const y of ys) {
        const tile = boardBox(fall, W, H, w, h, { x0: x, y0: y, x1: x + 1, y1: y + 1 })!;
        const [cx, cy] = project(fall, w, h, [x + 0.5, 0, H - (y + 0.5)])!;
        expect(Math.min(tile.x0, cx - FALL_EMBLEM_PX) - area.x0).toBeGreaterThanOrEqual(-1e-6);
        expect(Math.min(tile.y0, cy - FALL_EMBLEM_PX) - area.y0).toBeGreaterThanOrEqual(-1e-6);
        expect(area.x1 - Math.max(tile.x1, cx + FALL_EMBLEM_PX)).toBeGreaterThanOrEqual(-1e-6);
        expect(area.y1 - Math.max(tile.y1, cy + FALL_EMBLEM_PX)).toBeGreaterThanOrEqual(-1e-6);
      }
      const margins = ys.map((y) => boardBox(fall, W, H, w, h, { x0: x - q, y0: y - q, x1: x + 1 + q, y1: y + 1 + q })!);
      if (name === "1920x1080") {
        // The viewer's tilt holds them, each with her ground margin whole across; at 58cb35d the top and bottom queens were cut.
        expect(fall.beta).toBe(beta);
        for (const m of margins) expect(m.x0 >= area.x0 && m.x1 <= area.x1).toBe(true);
      } else {
        // No tilt holds them with her ground margin whole across here: the camera tilts further over, to 36.7 degrees, and
        // the bottom queen's margin gives way at the stage's right by 5.4 px, her tile and emblem whole.
        expect(fall.beta * 180 / Math.PI).toBeCloseTo(36.7, 1);
        expect(margins[2]!.x1 - area.x1).toBeCloseTo(5.4, 1);
      }
    });
  }
});
