/**
 * The viewer's camera in a board area that is not the whole screen.
 *
 * Choosing a mark in the log brings it to the middle of the board area,
 * the space between the overlay panels, so a side panel does not cover it; at the
 * whole-board view the board stays as it is (web/src/camera.ts centreOn).
 *
 * As on a phone, where the stage sits under the masthead
 * and bug and above the page's controls: Show on board, the zoom buttons and
 * Whole board.
 */
import { describe, expect, it, vi } from "vitest";
import { antLengthPx } from "../../web/src/ants.ts";
import { Camera, FALL_FILL, FALL_MOVE_MS, FALL_ZOOM, HOME_TILE_PX, LANE_PAD, LOCATE_ZOOM, MAX_ZOOM, QUEENS_PAD, easeInOut, fightLane, keepPinch, lerpView, queensBox } from "../../web/src/camera.ts";
import { boardBox, covers, fitTilted, project, viewTilePx } from "../../web/src/board3d/view.ts";
import { FALL_EMBLEM_PX, FALL_FRAME_PAD, QUEEN_FRAME_TILES, fallenNests, fallenQueenBox } from "../../web/src/buffer.ts";

describe("the initial view frames the fight lane", () => {
  /** The public map at grid scale 2: 64x48 physical tiles, 128x96 fine tiles; the nests in physical tiles (8, 24)
   * and (55, 24). Every tile coordinate below is a fine tile: S times the physical one. */
  const S = 2 as const, W = 64 * S, H = 48 * S;
  const setup = { mapW: W, mapH: H, gridScale: S, queens: [[8 * S * 256 + 128, 24 * S * 256 + 128], [55 * S * 256 + 128, 24 * S * 256 + 128]] as [[number, number], [number, number]] };
  const lane = fightLane(setup);

  it("is the ground between the nests, LANE_PAD tiles beyond their tiles, within the map", () => {
    expect(lane).toEqual({ x0: 0, y0: (24 - LANE_PAD) * S, x1: W, y1: (25 + LANE_PAD) * S });
    expect(fightLane({ mapW: 8, mapH: 8, queens: [[16, 16], [100, 100]] })).toEqual({ x0: 0, y0: 0, x1: 8, y1: 8 });
  });

  // Regression caught: a first-time viewer landing on the whole board, most of it empty, with ants too small to read.
  it("on a 1080p desktop stage shows the lane end to end, both nests in view, with the ants at their largest", () => {
    const area = { x0: 194, y0: 106, x1: 1726, y1: 916 };
    const cam = new Camera(W, H, 1920, 1080, area, lane, undefined, S);
    expect(cam.zoom).toBeGreaterThan(1);
    const [x0] = cam.toScreen(lane.x0, lane.y0);
    const [x1] = cam.toScreen(lane.x1, lane.y1);
    expect(x0).toBeGreaterThanOrEqual(area.x0);
    expect(x1).toBeLessThanOrEqual(area.x1);
    expect(antLengthPx(cam.view.tilePx * S)).toBe(28);
    // The lane's middle row sits at the area's middle.
    expect(cam.toScreen(32 * S, 24.5 * S)[1]).toBeCloseTo((area.y0 + area.y1) / 2);
    // The board spans the area both ways, so no band of it lies empty beside the board.
    expect(cam.toScreen(0, 0)[0]).toBeLessThanOrEqual(area.x0 + 1e-6);
    expect(cam.toScreen(W, H)[0]).toBeGreaterThanOrEqual(area.x1 - 1e-6);
    expect(cam.toScreen(0, 0)[1]).toBeLessThanOrEqual(area.y0 + 1e-6);
    expect(cam.toScreen(W, H)[1]).toBeGreaterThanOrEqual(area.y1 - 1e-6);
    // Whole board, and zooming all the way out, still give the whole board; a resize shows the lane again.
    cam.reset();
    expect(cam.view).toEqual(cam.fit);
    expect(cam.atHome()).toBe(false);
    cam.resize(1920, 1080, area);
    expect(cam.view).toEqual(cam.homeView());
    expect(cam.view).not.toEqual(cam.fit);
    // The page fits the board again as its panels change only while the viewer has not moved the view.
    expect(cam.atHome()).toBe(true);
    // (A sideways pan goes nowhere: the board spans the area's width exactly, so it is kept over the area; a pan up moves it.)
    cam.panBy(0, 12);
    expect(cam.atHome()).toBe(false);
    cam.resize(1920, 1080, { ...area, y0: area.y0 + 20 });
    expect(cam.atHome()).toBe(true);
    // The fall window: the fallen
    // colony's nests brought to the area's middle, near enough that their box spans FALL_FILL of the area on its larger
    // side and at least FALL_ZOOM times the initial view's zoom — never the box fitted (which magnified the ants' legs) —
    // within the viewer's own zoom limits.
    const home = cam.homeView();
    const nests = { x0: 25 * S, y0: 18 * S, x1: 38 * S, y1: 31 * S };
    cam.set(cam.fallView(nests));
    const [fx, fy] = cam.toScreen(31.5 * S, 24.5 * S);
    expect(fx).toBeCloseTo((area.x0 + area.x1) / 2, 6);
    expect(fy).toBeCloseTo((area.y0 + 20 + area.y1) / 2, 6);
    // On this wide stage the step in is the nearer of the two, and holds; the box then spans more than FALL_FILL of the area.
    const span = Math.max(((nests.x1 - nests.x0) * cam.view.tilePx) / (area.x1 - area.x0), ((nests.y1 - nests.y0) * cam.view.tilePx) / (area.y1 - area.y0 - 20));
    expect(cam.view.tilePx).toBeCloseTo(home.tilePx * FALL_ZOOM, 6);
    expect(span).toBeGreaterThanOrEqual(FALL_FILL - 1e-6);
    expect(cam.zoom).toBeLessThan(MAX_ZOOM);
    expect(cam.atHome()).toBe(false);
    // On a tall phone stage the initial view is far out (the board spans the stage's width), so the fill holds instead:
    // nearer than the step, the box spanning FALL_FILL of the stage's width.
    const tall = new Camera(W, H, 390, 844, { x0: 0, y0: 100, x1: 390, y1: 800 }, lane, { x0: 5 * S, y0: 21 * S, x1: 59 * S, y1: 28 * S }, S);
    tall.set(tall.fallView(nests));
    expect(tall.view.tilePx).toBeGreaterThan(tall.homeView().tilePx * FALL_ZOOM);
    expect(Math.max(((nests.x1 - nests.x0) * tall.view.tilePx) / 390, ((nests.y1 - nests.y0) * tall.view.tilePx) / 700)).toBeCloseTo(FALL_FILL, 6);
    // Nests at the board's edge: the board's edge stops at the area's edge, the nests inside the area, off its middle, and
    // the fallen queen herself (her tile and QUEEN_FRAME_TILES around, buffer.ts) whole in the area.
    cam.set(cam.fallView({ x0: 2 * S, y0: 18 * S, x1: 15 * S, y1: 31 * S }));
    expect(cam.view.ox).toBeCloseTo(area.x0, 6);
    expect(cam.toScreen(8.5 * S, 24.5 * S)[0]).toBeGreaterThan(area.x0 + 100);
    expect(cam.toScreen(8.5 * S, 24.5 * S)[0]).toBeLessThan((area.x0 + area.x1) / 2);
    const [qx0, qy0] = cam.toScreen(8 * S - QUEEN_FRAME_TILES, 24 * S - QUEEN_FRAME_TILES);
    const [qx1, qy1] = cam.toScreen(8 * S + 1 + QUEEN_FRAME_TILES, 24 * S + 1 + QUEEN_FRAME_TILES);
    expect(qx0).toBeGreaterThanOrEqual(area.x0);
    expect(qy0).toBeGreaterThanOrEqual(area.y0 + 20);
    expect(qx1).toBeLessThanOrEqual(area.x1);
    expect(qy1).toBeLessThanOrEqual(area.y1);
    // The move into the fall: a short one, eased from rest to rest.
    expect(FALL_MOVE_MS).toBeGreaterThanOrEqual(500);
    expect(FALL_MOVE_MS).toBeLessThanOrEqual(1500);
    expect([easeInOut(-1), easeInOut(0), easeInOut(0.5), easeInOut(1), easeInOut(2)]).toEqual([0, 0, 0.5, 1, 1]);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
    const a = { ox: 0, oy: 10, tilePx: 20 }, b = { ox: 100, oy: -30, tilePx: 30 };
    expect(lerpView(a, b, 0)).toEqual(a);
    expect(lerpView(a, b, 1)).toEqual(b);
    expect(lerpView(a, b, 0.5)).toEqual({ ox: 50, oy: -10, tilePx: 25 });
  });

  // Regression: on phones no queen in frame, the ant-size
  // floor having taken the view in to the lane's middle.
  it("on a phone's stage keeps both queens in frame, ahead of the ant-size floor, the lane's middle at the area's middle; the floor still holds where the queens allow", () => {
    const area = { x0: 0, y0: 112, x1: 390, y1: 404 };
    const queens = queensBox(setup);
    expect(queens).toEqual({ x0: (8 - QUEENS_PAD) * S, y0: (24 - QUEENS_PAD) * S, x1: (56 + QUEENS_PAD) * S, y1: (25 + QUEENS_PAD) * S });
    const cam = new Camera(W, H, 390, 844, area, lane, queens, S);
    expect(cam.view.tilePx * S).toBeLessThan(HOME_TILE_PX);
    for (const [qx, qy] of [[8 * S + 0.5, 24 * S + 0.5], [55 * S + 0.5, 24 * S + 0.5]]) {
      const [sx, sy] = cam.toScreen(qx, qy);
      expect(sx).toBeGreaterThanOrEqual(area.x0 + 2 * cam.view.tilePx);
      expect(sx).toBeLessThanOrEqual(area.x1 - 2 * cam.view.tilePx);
      expect(sy).toBeGreaterThanOrEqual(area.y0 + 2 * cam.view.tilePx);
      expect(sy).toBeLessThanOrEqual(area.y1 - 2 * cam.view.tilePx);
    }
    const [sx, sy] = cam.toScreen((lane.x0 + lane.x1) / 2, (lane.y0 + lane.y1) / 2);
    expect(sx).toBeCloseTo((area.x0 + area.x1) / 2);
    expect(sy).toBeCloseTo((area.y0 + area.y1) / 2);
    expect(cam.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    // With nothing to keep, the floor as before: HOME_TILE_PX, where an ant reads at 16 px.
    expect(new Camera(W, H, 390, 844, area, lane, undefined, S).view.tilePx * S).toBe(HOME_TILE_PX);
    expect(antLengthPx(HOME_TILE_PX)).toBeGreaterThanOrEqual(16);
    // On the 1080p stage the queens were in frame already: the view is unchanged.
    const desktop = { x0: 194, y0: 106, x1: 1726, y1: 916 };
    expect(new Camera(W, H, 1920, 1080, desktop, lane, queens, S).view).toEqual(new Camera(W, H, 1920, 1080, desktop, lane, undefined, S).view);
    // Without a lane the camera starts, as before, at the whole board.
    expect(new Camera(W, H, 390, 844, area, undefined, undefined, S).view).toEqual(new Camera(W, H, 390, 844, area, undefined, undefined, S).fit);
  });

  // Regression caught: the tilted 3D view leaving much of the viewport dark void below the board, the ants small; then
  // (the c969822 stills) the board a tilted patch leaving every corner of the stage empty.
  it("brings the tilted 3D view onto the lane: both nests in view at 1080p, the ants at their largest, the lane's middle at the area's middle, the board filling the area", () => {
    const w = 1920, h = 1080;
    const area = { x0: 194, y0: 106, x1: 1726, y1: 916 };
    const { pose, converged } = fitTilted(W, H, w, h, area, lane);
    expect(converged).toBe(true);
    const middle = project(pose, w, h, [32 * S, 0, (48 - 24.5) * S])!;
    expect(middle[0]).toBeCloseTo((area.x0 + area.x1) / 2, 0);
    expect(middle[1]).toBeCloseTo((area.y0 + area.y1) / 2, 0);
    for (const nest of [[8 * S + 0.5, 0, H - (24 * S + 0.5)], [55 * S + 0.5, 0, H - (24 * S + 0.5)]] as const) {
      const s = project(pose, w, h, nest)!;
      expect(s[0]).toBeGreaterThan(area.x0 + 40);
      expect(s[0]).toBeLessThan(area.x1 - 40);
      expect(s[1]).toBeGreaterThan(area.y0);
      expect(s[1]).toBeLessThan(area.y1);
    }
    expect(antLengthPx(viewTilePx(pose, w, h) * S)).toBe(28);
    expect(covers(pose, W, H, w, h, area)).toBe(true);
    // The ground's near edge (fine tile row 96) lands under the area, so no void shows below the board.
    const near = project(pose, w, h, [32 * S, 0, 0])!;
    expect(near[1]).toBeGreaterThanOrEqual(area.y1 - 0.5);
    // Closer than the whole board's fit, whose near edge leaves the area's bottom dark.
    const whole = fitTilted(W, H, w, h, area).pose;
    expect(pose.radius).toBeLessThan(whole.radius);
    expect(project(whole, w, h, [32 * S, 0, 0])![1]).toBeLessThan(area.y1 - 20);
    // A portrait phone and a landscape one: HOME_TILE_PX at the lane's middle, the near edge under the area, the board
    // filling the area, the whole board's fit otherwise untouched.
    for (const [pw, ph, a] of [[390, 844, { x0: 0, y0: 112, x1: 390, y1: 404 }], [844, 390, { x0: 0, y0: 0, x1: 504, y1: 390 }]] as const) {
      const p = fitTilted(W, H, pw, ph, a, lane).pose;
      expect(viewTilePx(p, pw, ph)).toBeGreaterThanOrEqual(HOME_TILE_PX - 0.01);
      expect(project(p, pw, ph, [32 * S, 0, 0])![1]).toBeGreaterThanOrEqual(a.y1 - 0.5);
      expect(covers(p, W, H, pw, ph, a)).toBe(true);
      const c = project(p, pw, ph, [32 * S, 0, (48 - 24.5) * S])!;
      expect(c[0]).toBeCloseTo((a.x0 + a.x1) / 2, 0);
      expect(c[1]).toBeCloseTo((a.y0 + a.y1) / 2, 0);
      // The whole board's own fit, with no frame, is as it was: its middle row within the area's width.
      const whole = fitTilted(W, H, pw, ph, a).pose;
      const box = boardBox(whole, W, H, pw, ph)!;
      expect(box.y0).toBeGreaterThanOrEqual(a.y0 - 1);
      expect(box.y1).toBeLessThanOrEqual(a.y1 + 1);
      expect(viewTilePx(whole, pw, ph)).toBeLessThan(HOME_TILE_PX);
    }
  });

  // Regression: at 1080p the nests cropped by the stage's
  // edge, and on phones no queen in frame.
  it("keeps both queens in frame on the tilted view at every viewport, backing off from the cover and the ant-size floor only as far as that asks", () => {
    const queens = queensBox(setup);
    for (const [pw, ph, a] of [[1920, 1080, { x0: 194, y0: 106, x1: 1726, y1: 916 }], [390, 844, { x0: 0, y0: 112, x1: 390, y1: 404 }], [844, 390, { x0: 0, y0: 0, x1: 504, y1: 390 }]] as const) {
      const p = fitTilted(W, H, pw, ph, a, lane, queens).pose;
      const box = boardBox(p, W, H, pw, ph, queens)!;
      expect(box.x0).toBeGreaterThanOrEqual(a.x0 - 0.5);
      expect(box.x1).toBeLessThanOrEqual(a.x1 + 0.5);
      expect(box.y0).toBeGreaterThanOrEqual(a.y0 - 0.5);
      expect(box.y1).toBeLessThanOrEqual(a.y1 + 0.5);
      // The lane's middle stays at the area's middle, and the view is no farther than the lane's own fit.
      const c = project(p, pw, ph, [32 * S, 0, (48 - 24.5) * S])!;
      expect(c[0]).toBeCloseTo((a.x0 + a.x1) / 2, 0);
      expect(c[1]).toBeCloseTo((a.y0 + a.y1) / 2, 0);
      expect(p.radius).toBeLessThanOrEqual(fitTilted(W, H, pw, ph, a).pose.radius + 1e-6);
    }
  });
});

describe("the camera's centreOn", () => {
  // 1920x1080 with 300 px panels either side and a header and bar: the fit area is off-centre on screen.
  const area = { x0: 320, y0: 150, x1: 1500, y1: 1020 };
  const centre = [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];

  it("puts a mid-board point at the middle of the fit area when zoomed in", () => {
    const cam = new Camera(64, 48, 1920, 1080, area);
    cam.zoomAt(2.5, 960, 540);
    const tilePx = cam.view.tilePx;
    cam.centreOn(30.5, 22.5);
    const [sx, sy] = cam.toScreen(30.5, 22.5);
    expect(Math.abs(sx - centre[0]!)).toBeLessThan(1);
    expect(Math.abs(sy - centre[1]!)).toBeLessThan(1);
    // The zoom is the viewer's: unchanged.
    expect(cam.view.tilePx).toBe(tilePx);
  });

  it("brings a point near any edge of the board into the fit area, clear of the panels, when zoomed in", () => {
    for (const [tx, ty] of [[1.5, 20.5], [62.5, 20.5], [30.5, 0.5], [30.5, 47.5], [0.5, 0.5]] as const) {
      const cam = new Camera(64, 48, 1920, 1080, area);
      cam.zoomAt(2.5, 960, 540);
      cam.centreOn(tx, ty);
      const [sx, sy] = cam.toScreen(tx, ty);
      expect(sx).toBeGreaterThanOrEqual(area.x0);
      expect(sx).toBeLessThanOrEqual(area.x1);
      expect(sy).toBeGreaterThanOrEqual(area.y0);
      expect(sy).toBeLessThanOrEqual(area.y1);
      // A small drag from there moves the board by no more than the drag: no jump back under a panel.
      const { ox, oy } = cam.view;
      cam.panBy(2, 2);
      cam.panBy(-2, -2);
      expect(Math.abs(cam.view.ox - ox)).toBeLessThanOrEqual(2);
      expect(Math.abs(cam.view.oy - oy)).toBeLessThanOrEqual(2);
    }
  });

  it("leaves the whole-board view as the fit", () => {
    const cam = new Camera(64, 48, 1920, 1080, area);
    cam.centreOn(5.5, 40.5);
    expect(cam.view).toEqual(cam.fit);
  });
});

describe("the board's area changing under the view: a panel opening or closing beside the board", () => {
  // Regression: after a zoom or pan, opening the Agents rail
  // narrowed the stage but the camera kept the old area, so the board ran on beneath the rail and Whole board fitted the
  // obsolete area (web/src/main.ts refitArea gave up on a moved camera instead of keeping its view over the new area).
  const setup = { mapW: 64, mapH: 48, queens: [[8 * 256 + 128, 24 * 256 + 128], [55 * 256 + 128, 24 * 256 + 128]] as [[number, number], [number, number]] };
  const lane = fightLane(setup);
  const wide = { x0: 194, y0: 106, x1: 1726, y1: 916 };
  const railed = { ...wide, x1: 1380 };
  const fitOf = (area: { x0: number; y0: number; x1: number; y1: number }) => new Camera(64, 48, 1920, 1080, area).fit;

  it("fits the initial view again, keeps a moved view where it is over the new area, and keeps the whole board whole", () => {
    const cam = new Camera(64, 48, 1920, 1080, wide, lane, queensBox(setup));
    cam.setArea(railed);
    expect(cam.area).toEqual(railed);
    expect(cam.fit).toEqual(fitOf(railed));
    expect(cam.atHome()).toBe(true);
    // The lane's middle at the narrower area's middle, the board spanning it.
    expect(cam.toScreen((lane.x0 + lane.x1) / 2, (lane.y0 + lane.y1) / 2)[0]).toBeCloseTo((railed.x0 + railed.x1) / 2);
    expect(cam.toScreen(64, 48)[0]).toBeGreaterThanOrEqual(railed.x1 - 1e-6);
    // The viewer zooms in and pans; the rail closes and opens again: the zoom holds, the board stays over each area.
    cam.zoomBy(2);
    cam.panBy(-300, -60);
    const moved = { ...cam.view };
    expect(cam.atHome()).toBe(false);
    cam.setArea(wide);
    expect(cam.view.tilePx).toBe(moved.tilePx);
    expect(cam.fit).toEqual(fitOf(wide));
    cam.setArea(railed);
    expect(cam.view.tilePx).toBe(moved.tilePx);
    expect(cam.atHome()).toBe(false);
    expect(cam.toScreen(0, 0)[0]).toBeLessThanOrEqual(railed.x0 + 1e-6);
    expect(cam.toScreen(64, 48)[0]).toBeGreaterThanOrEqual(railed.x1 - 1e-6);
    // Whole board fits the area as it is now, clear of the rail.
    cam.reset();
    expect(cam.view).toEqual(fitOf(railed));
    expect(cam.toScreen(64, 48)[0]).toBeLessThanOrEqual(railed.x1 + 1e-6);
    // At the whole board, the rail closing keeps the whole board: fitted to the wider area again.
    cam.setArea(wide);
    expect(cam.view).toEqual(fitOf(wide));
  });
});

describe("on a phone's stage", () => {
  /** A 390x844 phone whose stage spans the width from y 112 to y 404. */
  const area = { x0: 0, y0: 112, x1: 390, y1: 404 };
  const camera = () => new Camera(64, 48, 390, 844, area);
  const centre = { x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2 };

  describe("Show on board", () => {
    // Regression caught: the place centred on the screen rather than on the board's area, under the controls.
    it("shows the place at the centre of the board's area, at three times the whole board", () => {
      const c = camera();
      c.centreOn(32, 20, LOCATE_ZOOM);
      const [sx, sy] = c.toScreen(32, 20);
      expect(sx).toBeCloseTo(centre.x);
      expect(sy).toBeCloseTo(centre.y);
      expect(c.zoom).toBeCloseTo(LOCATE_ZOOM);
    });

    it("near the board's edge, as near the centre as keeping the board over its area allows", () => {
      const c = camera();
      c.centreOn(0, 0, LOCATE_ZOOM);
      expect(c.view.ox).toBeCloseTo(area.x0);
      expect(c.view.oy).toBeCloseTo(area.y0);
    });
  });

  describe("zoomed in", () => {
    // Regression caught: a board kept on the screen rather than over its area, so its edges cannot be panned into view there.
    it("every edge of the board can be panned into the area, and the board never leaves it", () => {
      const c = camera();
      c.zoomBy(2);
      c.panBy(-5000, -5000);
      expect(c.view.ox + 64 * c.view.tilePx).toBeCloseTo(area.x1);
      expect(c.view.oy + 48 * c.view.tilePx).toBeCloseTo(area.y1);
      c.panBy(5000, 5000);
      expect(c.view.ox).toBeCloseTo(area.x0);
      expect(c.view.oy).toBeCloseTo(area.y0);
    });
  });

  describe("the zoom buttons and the whole board", () => {
    it("zoom about the area's centre, between the whole board and the closest zoom", () => {
      const c = camera();
      c.centreOn(30, 22, 2);
      const before = c.toTile(centre.x, centre.y);
      c.zoomBy(1.5);
      const after = c.toTile(centre.x, centre.y);
      expect(after[0]).toBeCloseTo(before[0]);
      expect(after[1]).toBeCloseTo(before[1]);
      c.zoomBy(1000);
      expect(c.zoom).toBeCloseTo(MAX_ZOOM);
      c.zoomBy(1 / 1000);
      expect(c.view).toEqual(c.fit);
    });

    it("the whole board is the board fitted in its area", () => {
      const c = camera();
      c.centreOn(10, 10, LOCATE_ZOOM);
      c.reset();
      expect(c.view).toEqual(c.fit);
      const [x0, y0] = c.toScreen(0, 0);
      const [x1, y1] = c.toScreen(64, 48);
      expect(x0).toBeGreaterThanOrEqual(area.x0);
      expect(y0).toBeGreaterThanOrEqual(area.y0);
      expect(x1).toBeLessThanOrEqual(area.x1);
      expect(y1).toBeLessThanOrEqual(area.y1);
    });
  });
});

describe("board wheel zoom stays on the board", () => {
  // Node has EventTarget but no WheelEvent; supply the wheel fields read by the camera.
  const wheel = (ctrlKey: boolean) => Object.assign(new Event("wheel", { cancelable: true }), { ctrlKey, deltaY: -120, offsetX: 300, offsetY: 200 });

  it.each([false, true])("keepPinch cancels wheel with ctrlKey=%s only on its element, without blocking other wheel listeners", (ctrlKey) => {
    const board = new EventTarget();
    const outside = new EventTarget();
    const registration = vi.spyOn(board, "addEventListener");
    keepPinch(board as unknown as HTMLElement);
    expect(registration).toHaveBeenCalledWith("wheel", expect.any(Function), { passive: false });
    let delivered = false;
    board.addEventListener("wheel", () => { delivered = true; });
    const onBoard = wheel(ctrlKey);
    expect(board.dispatchEvent(onBoard)).toBe(false);
    expect(onBoard.defaultPrevented).toBe(true);
    expect(delivered).toBe(true);
    const offBoard = wheel(ctrlKey);
    expect(outside.dispatchEvent(offBoard)).toBe(true);
    expect(offBoard.defaultPrevented).toBe(false);
    registration.mockRestore();
  });

  it.each([false, true])("Camera.attach still zooms for wheel with ctrlKey=%s while cancelling the page default", (ctrlKey) => {
    const board = new EventTarget();
    const camera = new Camera(64, 48, 800, 600);
    camera.attach(board as unknown as HTMLElement);
    const before = camera.zoom;
    const event = wheel(ctrlKey);
    board.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(camera.zoom).toBeGreaterThan(before);
    expect(camera.zoom).toBeCloseTo(before * Math.exp(120 * 0.0015));
  });
});

describe("pinch zoom on the 2D board", () => {
  const lane = { x0: 0, y0: 14, x1: 64, y1: 35 };
  const pointer = (pointerId: number, x: number, y: number) => ({ pointerId, offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault() {} });
  function element() {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const el = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]), setPointerCapture() {} } as unknown as HTMLElement;
    return { el, fire: (type: string, e: unknown) => listeners.get(type)?.forEach((fn) => fn(e)) };
  }

  it("two fingers drawing apart zoom in by their distance's growth, the ground under their midpoint following it; the press is a drag, not a click; the finger left drags on; a still press stays a click", () => {
    const area = { x0: 0, y0: 100, x1: 390, y1: 700 };
    const cam = new Camera(64, 48, 390, 844, area, lane);
    const { el, fire } = element();
    const press = cam.attach(el);
    const z0 = cam.zoom;
    fire("pointerdown", pointer(1, 170, 400));
    fire("pointerdown", pointer(2, 230, 400));
    const [tx, ty] = cam.toTile(200, 400);
    // 60 px apart to 90, then to 120: twice the zoom; the midpoint moves 15 px and back, the ground under it with it.
    fire("pointermove", pointer(1, 140, 400));
    fire("pointermove", pointer(2, 260, 400));
    expect(cam.zoom).toBeCloseTo(z0 * 2, 6);
    const [tx1, ty1] = cam.toTile(200, 400);
    expect(tx1).toBeCloseTo(tx, 6);
    expect(ty1).toBeCloseTo(ty, 6);
    // One finger up: the other drags from where it is, no jump.
    fire("pointerup", pointer(2, 260, 400));
    const ox = cam.view.ox;
    fire("pointermove", pointer(1, 150, 400));
    expect(cam.view.ox).toBeCloseTo(ox + 10, 6);
    fire("pointerup", pointer(1, 150, 400));
    expect(press.dragged()).toBe(true);
    fire("pointerdown", pointer(1, 50, 300));
    fire("pointerup", pointer(1, 50, 300));
    expect(press.dragged()).toBe(false);
  });

  // Regression caught: a pinch on a landscape phone zoomed the page, not the board.
  // The pointer events above never see a browser that takes the pinch for itself: the touch moves of a two-finger
  // gesture, and Safari's gesture start, are refused on the board, so the pinch stays the board's in either orientation.
  it("keeps a pinch the board's: a two-finger touch move and a gesture start on the board are refused to the browser, a one-finger move is not", () => {
    const cam = new Camera(64, 48, 844, 390, { x0: 0, y0: 0, x1: 504, y1: 390 }, lane);
    const { el, fire } = element();
    cam.attach(el);
    const touch = (fingers: number) => {
      let prevented = false;
      fire("touchmove", { touches: Array.from({ length: fingers }, () => ({})), preventDefault: () => (prevented = true) });
      return prevented;
    };
    expect(touch(2)).toBe(true);
    expect(touch(1)).toBe(false);
    let gesture = false;
    fire("gesturestart", { preventDefault: () => (gesture = true) });
    expect(gesture).toBe(true);
  });
});

// The fall left fallen queens off the board at 1080p and on the desktop, where a
// colony of several nests fell and the step in (FALL_ZOOM times the initial view) was nearer than their box allows.
describe("the fall frames every fallen queen whole, with a margin", () => {
  const setup = { mapW: 64, mapH: 48, queens: [[8 * 256 + 128, 24 * 256 + 128], [55 * 256 + 128, 24 * 256 + 128]] as [[number, number], [number, number]] };
  const lane = fightLane(setup);
  const keep = queensBox(setup);
  /** A queen on tile (tx, ty), lost at lostTick, or standing (null). */
  const queen = (id: number, colony: number, tx: number, ty: number, lostTick: number | null) => ({ id, colony, x: tx * 256 + 128, y: ty * 256 + 128, hp: 0, lostTick });
  /** Lake Hodges Colony founded a second nest far across the board and lost both; Very Large Colony stands. */
  const fallen: [number, number][] = [[5, 24], [58, 30]];
  const board = { setup: { overrunRadiusTiles: 2 }, queens: [queen(0, 0, 55, 24, null), queen(0, 1, 5, 24, 900), queen(1, 1, 58, 30, 1000)] } as unknown as Parameters<typeof fallenNests>[0];
  const stages = [
    ["1080p", 1920, 1080, { x0: 24, y0: 124, x1: 1596, y1: 926 }],
    ["1280 px desktop", 1280, 720, { x0: 16, y0: 150, x1: 956, y1: 600 }],
    ["390 px phone", 390, 844, { x0: 0, y0: 177, x1: 390, y1: 399 }],
    ["phone in landscape", 844, 390, { x0: 0, y0: 0, x1: 504, y1: 301 }],
    ["360 px phone", 360, 800, { x0: 0, y0: 170, x1: 360, y1: 372 }],
  ] as const;

  it("fallenQueenBox spans every fallen queen's own box; a colony of one, hers alone", () => {
    const q = QUEEN_FRAME_TILES;
    expect(fallenQueenBox(board)).toEqual({ x0: 5 - q, y0: 24 - q, x1: 58 + 1 + q, y1: 30 + 1 + q });
    const one = { queens: [queen(0, 0, 55, 24, null), queen(0, 1, 8, 24, 900)] } as unknown as Parameters<typeof fallenQueenBox>[0];
    expect(fallenQueenBox(one)).toEqual({ x0: 8 - q, y0: 24 - q, x1: 8 + 1 + q, y1: 24 + 1 + q });
    // A colony still standing (one of its two queens left) has no fall to frame.
    expect(fallenQueenBox({ queens: [queen(0, 0, 55, 24, null), queen(0, 1, 8, 24, 900), queen(1, 1, 44, 30, null)] } as unknown as Parameters<typeof fallenQueenBox>[0])).toBeNull();
  });

  for (const [name, w, h, area] of stages) {
    it(`at ${name}: the 2D fall shows each fallen queen whole in the area with a tile of ground around her, the step in giving way where it must`, () => {
      const cam = new Camera(64, 48, w, h, area, lane, keep);
      const nests = fallenNests(board)!;
      cam.set(cam.fallView(nests));
      for (const [tx, ty] of fallen) {
        const m = QUEEN_FRAME_TILES + 1;
        const [x0, y0] = cam.toScreen(tx - m, ty - m);
        const [x1, y1] = cam.toScreen(tx + 1 + m, ty + 1 + m);
        expect(x0).toBeGreaterThanOrEqual(area.x0 - 1e-6);
        expect(y0).toBeGreaterThanOrEqual(area.y0 - 1e-6);
        expect(x1).toBeLessThanOrEqual(area.x1 + 1e-6);
        expect(y1).toBeLessThanOrEqual(area.y1 + 1e-6);
      }
      // The nests' box is never cut: at most it is fitted to the area.
      expect(cam.view.tilePx).toBeLessThanOrEqual(Math.min((area.x1 - area.x0) / (nests.x1 - nests.x0), (area.y1 - area.y0) / (nests.y1 - nests.y0)) + 1e-9);
      // On the desktops the step in would have cut them, so the floor gave way: further out than FALL_ZOOM times the initial view.
      if (w >= 1280) expect(cam.view.tilePx).toBeLessThan(cam.homeView().tilePx * FALL_ZOOM);
    });
  }
});

// The fall fills the
// stage, each fallen queen keeping her tile and her emblem (FALL_EMBLEM_PX from her tile's centre) whole; only her zone and
// ground margin give way, at the stage's top and bottom. The case as a fall recording
// shows it: a 64x48 board, Lake Hodges' three queens at x 55, y 8, 24 and 40, zone radius 8, each stage as its 58cb35d
// stills measured it. Keeping her ground margin whole had left a 100.2 px band at 1920x1080 and 118.8 px at 1366x768.
it("fills the stage at the fall, each fallen queen's tile and emblem whole (Lake Hodges' three nests)", () => {
  const x = 55, ys = [8, 24, 40] as const, pad = 8 + FALL_FRAME_PAD, q = QUEEN_FRAME_TILES;
  const nests = { x0: x - pad, y0: ys[0] - pad, x1: x + 1 + pad, y1: ys[2] + 1 + pad };
  const queens = { x0: x - q, y0: ys[0] - q, x1: x + 1 + q, y1: ys[2] + 1 + q };
  const stages = [
    // The board covers the stage: 1548 / 64 px a tile, no band.
    { w: 1920, h: 1080, area: { x0: 24, y0: 163, x1: 1572, y1: 1000 }, tilePx: 1548 / 64, band: 0 },
    // At the covering zoom the tiles and emblems would overrun the stage's 505.75 px height, so the emblems set the zoom
    // and the narrow band accepted at 1366 stays: 31.5 px.
    { w: 1366, h: 768, area: { x0: 24, y0: 182.25, x1: 1018, y1: 688 }, tilePx: (505.75 - 2 * FALL_EMBLEM_PX) / 32, band: 31.5 },
  ];
  for (const { w, h, area, tilePx, band } of stages) {
    const cam = new Camera(64, 48, w, h, area);
    // Without the queens' box, fallView frames exactly as before (7bb913cb): the nests' box fitted lies further out than
    // the whole board here, so the whole board.
    expect(cam.fallView(nests)).toEqual({ ...cam.fit });
    cam.set(cam.fallView(nests, queens));
    expect(cam.view.tilePx).toBeCloseTo(tilePx, 9);
    // Every fallen queen's tile and emblem whole in the area.
    for (const y of ys) {
      const [tx0, ty0] = cam.toScreen(x, y), [tx1, ty1] = cam.toScreen(x + 1, y + 1), [cx, cy] = cam.toScreen(x + 0.5, y + 0.5);
      expect(Math.min(tx0, cx - FALL_EMBLEM_PX) - area.x0).toBeGreaterThanOrEqual(-1e-6);
      expect(Math.min(ty0, cy - FALL_EMBLEM_PX) - area.y0).toBeGreaterThanOrEqual(-1e-6);
      expect(area.x1 - Math.max(tx1, cx + FALL_EMBLEM_PX)).toBeGreaterThanOrEqual(-1e-6);
      expect(area.y1 - Math.max(ty1, cy + FALL_EMBLEM_PX)).toBeGreaterThanOrEqual(-1e-6);
    }
    // Trimmed only at the top and bottom: the nests' box, on the board, still fits across.
    expect(cam.toScreen(Math.max(0, nests.x0), 0)[0]).toBeGreaterThanOrEqual(area.x0 - 1e-6);
    expect(cam.toScreen(Math.min(64, nests.x1), 0)[0]).toBeLessThanOrEqual(area.x1 + 1e-6);
    // The board covers the area's height, and across leaves at most the band.
    const [bx0, by0] = cam.toScreen(0, 0), [bx1, by1] = cam.toScreen(64, 48);
    expect(by0).toBeLessThanOrEqual(area.y0 + 1e-6);
    expect(by1).toBeGreaterThanOrEqual(area.y1 - 1e-6);
    expect(Math.max(0, bx0 - area.x0) + Math.max(0, area.x1 - bx1)).toBeCloseTo(band, 6);
  }
});
