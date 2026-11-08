/**
 * Which board the page starts and what it shows when none can start
 * (web/src/webgl2.ts), that the 3D board's code stays out of the 2D page
 * (web/src/main.ts), and where the queens stand (web/src/board3d/nests.ts).
 *
 * The regressions these catch: the 2D page asking for WebGL2 or showing the message on a good
 * start; ?board=3d without WebGL2 starting the 3D board or showing a message instead of the 2D
 * board; the message replacing a board that failed for another reason; a board started, or an
 * error logged, with WebGL off; the WebGL2 probe leaking its context; a
 * static import pulling Babylon into the 2D page; queens drawn off their tiles.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NEEDS_WEBGL_HEADING, boardMode, fallbackUrl, hasWebGL2, runBoard, type Starters } from "../webgl2.ts";
import { queenTiles } from "./nests.ts";
import { FALLBACK_MS, GIVE_UP_MS, PASS_MS, QualityController, TIERS, WINDOW, startTier, type Decision } from "./quality.ts";
import { antLengthPx } from "../ants.ts";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { CLEAR_RGB } from "./ground.ts";
import { ANT_BODY, COVER_MARGIN, FILL_HEIGHT, FILL_WIDTH, HERO_ALPHA, HERO_BETA, MIN_RADIUS, PICK_TILES, PORTRAIT_BETA, PORTRAIT_FILL_WIDTH, TOP_BETA, aimAt, antTiles, boardBox, coverBoard, covers, fallPose, fitTilted, groundAt, groundBox, lerpPose, pickNearest, poseAfterResize, project, rowWidth, samePose, viewTilePx, type HeightAt, type Pose } from "./view.ts";
import { FALL_FILL, FALL_ZOOM, HOME_TILE_PX, fightLane, queensBox } from "../camera.ts";
import { QUEEN_FRAME_TILES } from "../buffer.ts";

/** Every starter recorded; start2d and start3d resolve unless told to fail. */
function starters(o: { webgl2?: boolean; webgl?: boolean; fail2d?: Error; fail3d?: Error } = {}) {
  const calls: string[] = [];
  const errors: { logged: unknown[]; rejected: unknown[] } = { logged: [], rejected: [] };
  const s: Starters = {
    probe2: () => (calls.push("probe2"), o.webgl2 ?? true),
    start3d: async () => {
      calls.push("start3d");
      if (o.fail3d) throw o.fail3d;
    },
    start2d: async () => {
      calls.push("start2d");
      if (o.fail2d) throw o.fail2d;
    },
    webglSupported: () => (calls.push("webglSupported"), o.webgl ?? true),
    show: () => calls.push("show"),
    fallback2d: () => calls.push("fallback2d"),
    log: (e) => errors.logged.push(e),
    reject: (e) => errors.rejected.push(e),
  };
  return { s, calls, errors };
}

describe("board mode", () => {
  it("defaults to 3D; only board=2d explicitly selects 2D", () => {
    expect(boardMode(new URLSearchParams(""))).toBe("3d");
    expect(boardMode(new URLSearchParams("match=4&tilt=0"))).toBe("3d");
    expect(boardMode(new URLSearchParams("board=2d"))).toBe("2d");
    expect(boardMode(new URLSearchParams("board=3D"))).toBe("3d");
    expect(boardMode(new URLSearchParams("board=3d"))).toBe("3d");
  });
});

describe("starting a board", () => {
  it("2D: a good start asks whether WebGL is there, never for WebGL2, and shows no message", async () => {
    const { s, calls, errors } = starters();
    await runBoard("2d", s);
    expect(calls).toEqual(["webglSupported", "start2d"]);
    expect(errors).toEqual({ logged: [], rejected: [] });
  });

  // Regression caught in the stills' WebGL-off pass (baseline to db23bd5): the 2D board started on Pixi's canvas
  // renderer and threw reading renderer.gl, logged as a console error, before the message showed.
  it("2D without WebGL: no board starts, nothing is logged, ready rejects with the needs-WebGL reason and the message shows", async () => {
    const { s, calls, errors } = starters({ webgl: false });
    await runBoard("2d", s);
    expect(calls).toEqual(["webglSupported", "show"]);
    expect(errors.logged).toEqual([]);
    expect(errors.rejected).toEqual([expect.objectContaining({ message: NEEDS_WEBGL_HEADING })]);
  });

  it("2D: a failed start while WebGL works shows no message, and the failure still propagates", async () => {
    const fail = new Error("stream closed");
    const { s, calls, errors } = starters({ webgl: true, fail2d: fail });
    await runBoard("2d", s);
    expect(calls).toEqual(["webglSupported", "start2d"]);
    expect(errors).toEqual({ logged: [fail], rejected: [fail] });
  });

  it("3D without WebGL2: the 3D start is not called, the 2D start is, and no message shows", async () => {
    const { s, calls, errors } = starters({ webgl2: false });
    await runBoard("3d", s);
    expect(calls).toEqual(["probe2", "webglSupported", "start2d"]);
    expect(errors).toEqual({ logged: [], rejected: [] });
  });

  it("3D with WebGL2: the 3D start is called and the 2D start is not", async () => {
    const { s, calls } = starters({ webgl2: true });
    await runBoard("3d", s);
    expect(calls).toEqual(["probe2", "start3d"]);
  });

  it("3D without WebGL2 or WebGL: no board starts and the message shows, with nothing logged", async () => {
    const { s, calls, errors } = starters({ webgl2: false, webgl: false });
    await runBoard("3d", s);
    expect(calls).toEqual(["probe2", "webglSupported", "show"]);
    expect(errors.logged).toEqual([]);
    expect(errors.rejected).toEqual([expect.objectContaining({ message: NEEDS_WEBGL_HEADING })]);
  });

  it("3D start failure (its code fails to load, or it throws): the page reloads as 2D, with no message and no rejection", async () => {
    const fail = new TypeError("Failed to fetch dynamically imported module");
    const { s, calls, errors } = starters({ webgl2: true, fail3d: fail });
    await runBoard("3d", s);
    expect(calls).toEqual(["probe2", "start3d", "fallback2d"]);
    expect(errors).toEqual({ logged: [fail], rejected: [] });
  });
});

describe("the reload to 2D", () => {
  it("sets board=2d and keeps every other parameter", () => {
    expect(fallbackUrl("http://localhost:4718/index.html?recording=sample&capture=1&board=3d&tilt=1")).toBe("http://localhost:4718/index.html?recording=sample&capture=1&board=2d&tilt=1");
    expect(fallbackUrl("https://example.test/?board=3d&frametime=1&match=7")).toBe("https://example.test/?board=2d&frametime=1&match=7");
    expect(fallbackUrl("https://example.test/?board=3d")).toBe("https://example.test/?board=2d");
  });
});

describe("quality step-down and slow fallback", () => {
  /** Feed n frames each `ms` apart, starting where the last left off; returns every non-hold decision with its tier after. */
  const feed = (q: QualityController, at: { t: number }, n: number, ms: number) => {
    const out: { d: Decision; tier: number }[] = [];
    for (let i = 0; i < n; i++) {
      at.t += ms;
      const d = q.frame(at.t);
      if (d !== "hold") out.push({ d, tier: q.tier });
    }
    return out;
  };

  it("starts phones (coarse pointer or short side of 500 px or less) one tier down", () => {
    expect(startTier({ coarsePointer: false, shortSide: 1080 })).toBe(0);
    expect(startTier({ coarsePointer: false, shortSide: 390 })).toBe(1);
    expect(startTier({ coarsePointer: true, shortSide: 900 })).toBe(1);
  });

  it("holds at the line: a 34 ms median (a phone capped near 30 fps) never steps down", () => {
    const q = new QualityController(1);
    expect(feed(q, { t: 0 }, (WINDOW + 1) * 10, 34)).toEqual([]);
    expect(q.tier).toBe(1);
    expect(q.lastMedian).toBe(34);
    expect(34 <= PASS_MS).toBe(true);
  });

  it("one slow window holds; two in a row step down one tier; it never steps back up", () => {
    const q = new QualityController(0);
    const at = { t: 0 };
    expect(feed(q, at, WINDOW + 1, 40)).toEqual([]);
    expect(feed(q, at, WINDOW, 16)).toEqual([]);
    expect(feed(q, at, WINDOW, 40)).toEqual([]);
    expect(feed(q, at, WINDOW, 40)).toEqual([{ d: "step", tier: 1 }]);
    expect(feed(q, at, (WINDOW + 1) * 5, 8)).toEqual([]);
    expect(q.tier).toBe(1);
  });

  it("decides only on a full window at the new tier: the window empties on a step", () => {
    const q = new QualityController(0);
    const at = { t: 0 };
    feed(q, at, 2 * WINDOW + 1, 40);
    expect(q.tier).toBe(1);
    expect(q.filling).toBe(0);
    // The first frame at the new tier starts the window; 60 more frames fill it.
    expect(feed(q, at, WINDOW, 40)).toEqual([]);
    expect(q.filling).toBe(WINDOW - 1);
    expect(feed(q, at, WINDOW + 1, 40)).toEqual([{ d: "step", tier: 2 }]);
  });

  it("at the last tier, one full window above about 55 ms falls back at once", () => {
    const last = TIERS.length - 1;
    const slow = new QualityController(last);
    expect(feed(slow, { t: 0 }, WINDOW + 1, FALLBACK_MS + 1)).toEqual([{ d: "fallback", tier: last }]);
  });

  it("at any tier, one full window above GIVE_UP_MS falls back at once; a window at it does not", () => {
    // The boundary pair pins the threshold: at GIVE_UP_MS tier 0 holds (one slow window), one ms over falls back.
    expect(feed(new QualityController(0), { t: 0 }, WINDOW + 1, GIVE_UP_MS)).toEqual([]);
    expect(feed(new QualityController(0), { t: 0 }, WINDOW + 1, GIVE_UP_MS + 1)).toEqual([{ d: "fallback", tier: 0 }]);
    // The preview's slow desktop: 385 ms a frame from tier 0 falls back on frame 61, about 23 s in, not after 7 windows.
    const q = new QualityController(0);
    const at = { t: 0 };
    expect(feed(q, at, WINDOW, 385)).toEqual([]);
    expect(feed(q, at, 1, 385)).toEqual([{ d: "fallback", tier: 0 }]);
    expect(at.t).toBe((WINDOW + 1) * 385);
  });

  it("below GIVE_UP_MS, 70 ms windows still step 0 to 1 to 2 to 3 before falling back", () => {
    const q = new QualityController(0);
    expect(feed(q, { t: 0 }, 10 * (WINDOW + 1), 70).slice(0, 4)).toEqual([
      { d: "step", tier: 1 },
      { d: "step", tier: 2 },
      { d: "step", tier: 3 },
      { d: "fallback", tier: 3 },
    ]);
  });

  it("at the last tier, the first window above 34.3 ms holds; a second in a row falls back", () => {
    const last = TIERS.length - 1;
    const q = new QualityController(last);
    const at = { t: 0 };
    expect(feed(q, at, WINDOW + 1, 46)).toEqual([]);
    expect(q.lastMedian).toBe(46);
    expect(feed(q, at, WINDOW, 46)).toEqual([{ d: "fallback", tier: last }]);
  });

  it("at the last tier, a smooth board holds, and a slow window then a smooth one holds", () => {
    const last = TIERS.length - 1;
    const smooth = new QualityController(last);
    expect(feed(smooth, { t: 0 }, (WINDOW + 1) * 5, 34)).toEqual([]);
    const q = new QualityController(last);
    const at = { t: 0 };
    expect(feed(q, at, WINDOW + 1, 50)).toEqual([]);
    expect(feed(q, at, WINDOW, 30)).toEqual([]);
    expect(feed(q, at, WINDOW, 50)).toEqual([]);
  });

  it("the emulated phone at 46 ms (start tier 1) steps 1 to 2 to 3, then falls back on the second tier-3 window", () => {
    const q = new QualityController(1);
    // The page reloads on the first fallback (main3d.ts giveUp); later decisions are never acted on.
    expect(feed(q, { t: 0 }, 20 * (WINDOW + 1), 46).slice(0, 3)).toEqual([
      { d: "step", tier: 2 },
      { d: "step", tier: 3 },
      { d: "fallback", tier: 3 },
    ]);
  });

  it("a steadily slow board walks down every tier and then falls back", () => {
    const q = new QualityController(1);
    const decisions = feed(q, { t: 0 }, 20 * (WINDOW + 1), 60).slice(0, 3);
    expect(decisions).toEqual([
      { d: "step", tier: 2 },
      { d: "step", tier: 3 },
      { d: "fallback", tier: 3 },
    ]);
  });
});

describe("picking an ant on the 3D board", () => {
  const at = (pts: [number, number][]) => (i: number) => pts[i]!;

  it("picks the nearest ant within 1.2 tiles at that ant's own zoom", () => {
    const pts: [number, number][] = [[0, 0], [10, 0], [40, 0]];
    expect(PICK_TILES).toBe(1.2);
    expect(pickNearest(3, at(pts), () => 10, 8, 0)).toBe(1);
    expect(pickNearest(3, at(pts), () => 10, 29, 0)).toBe(2);
    expect(pickNearest(3, at(pts), () => 10, 25, 0)).toBe(-1);
  });

  it("a nearer ant drawn small (far away in the tilted view) is out of reach where a larger one is not", () => {
    const pts: [number, number][] = [[0, 0], [14, 0]];
    const tile = [4, 20];
    expect(pickNearest(2, at(pts), (i) => tile[i]!, 6, 0)).toBe(1);
    expect(pickNearest(0, at([]), () => 10, 0, 0)).toBe(-1);
  });

  it("a finger's tolerance: within minPx an ant is picked however small its tile is drawn, the nearest of several, and no further", () => {
    const pts: [number, number][] = [[0, 0], [50, 0]];
    // 1.2 tiles at 10 px a tile is 12 px: at 20 px neither ant is in reach by the tile rule; within 22 px the nearer one is.
    expect(pickNearest(2, at(pts), () => 10, 20, 0)).toBe(-1);
    expect(pickNearest(2, at(pts), () => 10, 20, 0, 22)).toBe(0);
    expect(pickNearest(2, at(pts), () => 10, 32, 0, 22)).toBe(1);
    expect(pickNearest(2, at(pts), () => 10, 75, 0, 22)).toBe(-1);
    // A tile drawn larger than the tolerance keeps its own reach: 48 px at 40 px a tile.
    expect(pickNearest(2, at(pts), () => 40, 90, 0, 22)).toBe(1);
  });
});

describe("the WebGL2 probe", () => {
  const doc = (getContext: (kind: string) => unknown) => ({ createElement: () => ({ getContext }) }) as unknown as Pick<Document, "createElement">;

  it("releases its test context with loseContext", () => {
    let lost = 0;
    const kinds: string[] = [];
    const gl = { getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: () => lost++ } : null) };
    expect(
      hasWebGL2(
        doc((kind) => {
          kinds.push(kind);
          return gl;
        }),
      ),
    ).toBe(true);
    expect(kinds).toEqual(["webgl2"]);
    expect(lost).toBe(1);
  });

  it("is false when no WebGL2 context can be made, or making one throws", () => {
    expect(hasWebGL2(doc(() => null))).toBe(false);
    expect(
      hasWebGL2(
        doc(() => {
          throw new Error("blocked");
        }),
      ),
    ).toBe(false);
  });
});

describe("framing the tilted view", () => {
  // A 128 x 96 tile map; board areas as the overlays leave them at 1080p and on a 390 px phone.
  const cases = [
    { name: "1080p", w: 1920, h: 1080, area: { x0: 320, y0: 60, x1: 1600, y1: 1020 } },
    { name: "390 px phone", w: 390, h: 844, area: { x0: 0, y0: 110, x1: 390, y1: 780 } },
    { name: "phone in landscape", w: 844, h: 390, area: { x0: 0, y0: 40, x1: 844, y1: 350 } },
  ];
  for (const c of cases) {
    const fill = c.h > c.w ? PORTRAIT_FILL_WIDTH : FILL_WIDTH;
    it(`converges at ${c.name}: the board is centred in the area, ${fill} of its width on the middle row or ${FILL_HEIGHT} of its height`, () => {
      const { pose, converged } = fitTilted(128, 96, c.w, c.h, c.area);
      expect(converged).toBe(true);
      const b = boardBox(pose, 128, 96, c.w, c.h)!;
      // Width where stills.ts measures widthFill: along the area's middle row, not the corners' box.
      const wf = rowWidth(pose, 128, 96, c.w, c.h, (c.area.y0 + c.area.y1) / 2)! / (c.area.x1 - c.area.x0);
      const hf = (b.y1 - b.y0) / (c.area.y1 - c.area.y0);
      expect(Math.max(wf / fill, hf / FILL_HEIGHT)).toBeCloseTo(1, 3);
      expect(wf).toBeLessThanOrEqual(fill + 1e-3);
      expect(hf).toBeLessThanOrEqual(FILL_HEIGHT + 1e-3);
      expect((b.x0 + b.x1) / 2).toBeCloseTo((c.area.x0 + c.area.x1) / 2, 0);
      expect((b.y0 + b.y1) / 2).toBeCloseTo((c.area.y0 + c.area.y1) / 2, 0);
    });
  }

  it("tilts less on a portrait screen, so the board uses more of the height", () => {
    expect(fitTilted(128, 96, 390, 844, cases[1]!.area).pose.beta).toBe(PORTRAIT_BETA);
    expect(fitTilted(128, 96, 1920, 1080, cases[0]!.area).pose.beta).toBe(HERO_BETA);
    expect(PORTRAIT_BETA).toBeLessThan(HERO_BETA);
  });

  it("never stands nearer than the camera's lower zoom limit", () => {
    const { pose } = fitTilted(4, 3, 1920, 1080, cases[0]!.area);
    expect(pose.radius).toBeGreaterThanOrEqual(MIN_RADIUS);
  });

  it("fills the phone's width on the middle row and the board's corners stay inside the area", () => {
    const area = cases[1]!.area;
    const { pose } = fitTilted(128, 96, 390, 844, area);
    expect(rowWidth(pose, 128, 96, 390, 844, (area.y0 + area.y1) / 2)! / (area.x1 - area.x0)).toBeGreaterThanOrEqual(0.88);
    const b = boardBox(pose, 128, 96, 390, 844)!;
    expect(b.x0).toBeGreaterThanOrEqual(area.x0 - 1);
    expect(b.x1).toBeLessThanOrEqual(area.x1 + 1);
  });

  it("ants' bodies, abdomen to head, span the 2D board's ant length at the board's centre: 10 px on the phone", () => {
    const { pose } = fitTilted(128, 96, 390, 844, cases[1]!.area);
    const px = viewTilePx(pose, 390, 844);
    expect(antLengthPx(px)).toBe(10);
    expect(antTiles(px) * ANT_BODY * px).toBeCloseTo(10, 6);
    const d = fitTilted(128, 96, 1920, 1080, cases[0]!.area).pose;
    const dpx = viewTilePx(d, 1920, 1080);
    expect(antTiles(dpx) * ANT_BODY * dpx).toBeCloseTo(antLengthPx(dpx), 6);
  });
});

describe("the board fills the stage (the c969822 stills left every stage corner empty)", () => {
  /**
   * The public map's lane and its queens' box (both nests kept in frame), and
   * the stages the page's layouts leave at the capture viewports (as the 653a229 stills measured them) and a 1280 px desktop.
   */
  // Every match plays at grid scale 2: the public map's grid-scale-2 setup, its lane and queens' box read back in
  // the 64x48 reference board's physical tiles that this geometry measures in (test/spectator/grid-scale.test.ts ties the two).
  const setup = { mapW: 128, mapH: 96, gridScale: 2 as const, queens: [[2 * (8 * 256 + 128), 2 * (24 * 256 + 128)], [2 * (55 * 256 + 128), 2 * (24 * 256 + 128)]] as [[number, number], [number, number]] };
  const physical = (box: { x0: number; y0: number; x1: number; y1: number }) => ({ x0: box.x0 / 2, y0: box.y0 / 2, x1: box.x1 / 2, y1: box.y1 / 2 });
  const lane = physical(fightLane(setup));
  const keep = physical(queensBox(setup));
  const stages = [
    ["1080p", 1920, 1080, { x0: 24, y0: 124, x1: 1596, y1: 926 }],
    ["1280 px desktop", 1280, 720, { x0: 16, y0: 150, x1: 956, y1: 600 }],
    ["390 px phone", 390, 844, { x0: 0, y0: 177, x1: 390, y1: 399 }],
    ["phone in landscape", 844, 390, { x0: 0, y0: 0, x1: 504, y1: 301 }],
    ["360 px phone", 360, 800, { x0: 0, y0: 170, x1: 360, y1: 372 }],
  ] as const;
  const far: Pose = { alpha: HERO_ALPHA, beta: HERO_BETA, radius: 300, target: [32, 0, 48 - 24.5] };
  /** A frame's box lies in the area, within the half pixel the stills allow (scene-checks.ts within). */
  const within = (b: { x0: number; y0: number; x1: number; y1: number } | null, area: { x0: number; y0: number; x1: number; y1: number }) =>
    b !== null && b.x0 >= area.x0 - 0.5 && b.y0 >= area.y0 - 0.5 && b.x1 <= area.x1 + 0.5 && b.y1 <= area.y1 + 0.5;
  /** The fallen colony's nests (her zone and FALL_FRAME_PAD around) and the fallen queen's own box (her tile and QUEEN_FRAME_TILES around: her mound). */
  const nests = { x0: 8 - 6, y0: 24 - 6, x1: 8 + 1 + 6, y1: 24 + 1 + 6 };
  const queen = { x0: 8 - QUEEN_FRAME_TILES, y0: 24 - QUEEN_FRAME_TILES, x1: 8 + 1 + QUEEN_FRAME_TILES, y1: 24 + 1 + QUEEN_FRAME_TILES };
  /** Ground a tile high everywhere: the relief the board draws and the stills measure through (main3d.ts toScreen), where the fit's plane is flat. */
  const hill: HeightAt = () => 1;

  // A colony of several nests, far apart, falls — here queens on tiles (8, 24) and
  // (44, 30), their nests' box (buffer.ts fallenNests) and every fallen queen's box (fallenQueenBox) — and no nearer
  // distance shows them whole: the camera stands back, below FALL_ZOOM, until each is whole with ground around her.
  for (const [name, w, h, area] of stages) {
    it(`at ${name}: the fall shows every queen of a fallen colony of several nests whole, with ground around her`, () => {
      const { pose } = fitTilted(64, 48, w, h, area, lane, keep);
      const several = { x0: 2, y0: 18, x1: 51, y1: 37 };
      const queens = { x0: 8 - QUEEN_FRAME_TILES, y0: 24 - QUEEN_FRAME_TILES, x1: 44 + 1 + QUEEN_FRAME_TILES, y1: 30 + 1 + QUEEN_FRAME_TILES };
      for (const heightAt of [undefined, hill]) {
        const fall = fallPose(pose, several, queens, 64, 48, w, h, area, heightAt);
        expect(fall.alpha).toBe(pose.alpha);
        expect(fall.beta).toBe(pose.beta);
        expect(covers(fall, 64, 48, w, h, area)).toBe(true);
        // Each queen's own box (her tile and QUEEN_FRAME_TILES around, as the stills measure her) whole in the stage, and
        // a tile of ground around it too — but on the landscape phone's short, wide stage, where the camera stands as far
        // back as the board lets it (coverBoard) and the queen on the left keeps 8 px of ground on the relief.
        const m = name === "phone in landscape" ? QUEEN_FRAME_TILES : QUEEN_FRAME_TILES + 1;
        for (const [tx, ty] of [[8, 24], [44, 30]] as const) expect(within(boardBox(fall, 64, 48, w, h, { x0: tx - m, y0: ty - m, x1: tx + 1 + m, y1: ty + 1 + m }, heightAt), area)).toBe(true);
        // On the desktops the step in would cut them: the camera stood back, past FALL_ZOOM's step.
        if (w >= 1280) expect(fall.radius).toBeGreaterThan(pose.radius / FALL_ZOOM);
      }
    });
  }

  it("groundAt is project's inverse on the ground, and null for a point that sees the sky", () => {
    const pose: Pose = { alpha: -1.3, beta: 0.7, radius: 60, target: [30, 0, 20] };
    for (const [x, z] of [[0, 0], [64, 48], [12.25, 40.5], [31, 23]] as const) {
      const s = project(pose, 1920, 1080, [x, 0, z])!;
      const g = groundAt(pose, 1920, 1080, s[0], s[1])!;
      expect(g[0]).toBeCloseTo(x, 6);
      expect(g[1]).toBeCloseTo(z, 6);
    }
    // Looking nearly level, the top of the screen sees the sky.
    expect(groundAt({ ...pose, beta: 1.5 }, 1920, 1080, 960, 0)).toBeNull();
  });

  for (const [name, w, h, area] of stages) {
    it(`at ${name}: the default view shows only board in the stage, every corner of the stage ${COVER_MARGIN} tiles inside the board's edge, both nests in frame, the ants readable`, () => {
      const { pose } = fitTilted(64, 48, w, h, area, lane, keep);
      expect(covers(pose, 64, 48, w, h, area)).toBe(true);
      const g = groundBox(pose, w, h, area)!;
      expect(g.x0).toBeGreaterThanOrEqual(COVER_MARGIN - 1e-6);
      expect(g.z0).toBeGreaterThanOrEqual(COVER_MARGIN - 1e-6);
      expect(g.x1).toBeLessThanOrEqual(64 - COVER_MARGIN + 1e-6);
      expect(g.z1).toBeLessThanOrEqual(48 - COVER_MARGIN + 1e-6);
      // Both queens' nests whole in the stage (the 653a229 stills: backed off at the hero tilt to keep them, the stage's top
      // left corner saw past the board at 1080p and in landscape).
      expect(within(boardBox(pose, 64, 48, w, h, keep), area)).toBe(true);
      // The ants' size floor holds where both nests fit at it (the desktops); where it would lose one (the phones), the
      // camera stands at the nearest distance that keeps both: a little nearer loses a nest.
      if (viewTilePx(pose, w, h) < HOME_TILE_PX - 1e-6) {
        expect(["390 px phone", "phone in landscape", "360 px phone"]).toContain(name);
        const nearer = aimAt({ ...pose, radius: pose.radius * 0.99 }, w, h, [32, 48 - 24.5], [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2]);
        expect(within(boardBox(nearer, 64, 48, w, h, keep), area)).toBe(false);
      }
      // The fall pose: at least FALL_ZOOM nearer than the default, nearer
      // until the fallen nests' box spans FALL_FILL of the stage on its larger side, and nearer still until the fallen queen
      // (her tile and QUEEN_FRAME_TILES around: her mound) lies whole in the stage, the stage still only board — the nests
      // in view even at the board's edge, where the board's edge lies at the stage's far corner and its near corners, which
      // see less ground, start tiles further in (the hero tilt cut her at the landscape stage).
      const fall = fallPose(pose, nests, queen, 64, 48, w, h, area);
      expect(fall.radius).toBeLessThanOrEqual(Math.max(MIN_RADIUS, pose.radius / FALL_ZOOM) + 1e-6);
      expect(fall.alpha).toBe(pose.alpha);
      expect(fall.beta).toBe(pose.beta);
      const fb = boardBox(fall, 64, 48, w, h, nests)!;
      expect(Math.max((fb.x1 - fb.x0) / (area.x1 - area.x0), (fb.y1 - fb.y0) / (area.y1 - area.y0))).toBeGreaterThanOrEqual(FALL_FILL - 1e-6);
      expect(within(boardBox(fall, 64, 48, w, h, queen), area)).toBe(true);
      expect(covers(fall, 64, 48, w, h, area)).toBe(true);
      const nest = project(fall, w, h, [8.5, 0, 48 - 24.5])!;
      expect(nest[0]).toBeGreaterThan(area.x0);
      expect(nest[0]).toBeLessThan((area.x0 + area.x1) / 2);
      expect(nest[1]).toBeGreaterThan(area.y0);
      expect(nest[1]).toBeLessThan(area.y1);
      expect(groundBox(fall, w, h, area)!.x0).toBeCloseTo(COVER_MARGIN, 6);
      // Her box judged at the ground's height under it, as the board draws her: whole in the stage on the relief too.
      expect(within(boardBox(fallPose(pose, nests, queen, 64, 48, w, h, area, hill), 64, 48, w, h, queen, hill), area)).toBe(true);
    });
  }

  it("keeps both nests at the steepest tilt that still fills the stage: down from the hero tilt at 1080p and in landscape, where backing off at it left the top left corner empty (the 653a229 stills), and the portrait tilt as it is on the phones", () => {
    const beta = (i: number) => fitTilted(64, 48, stages[i][1], stages[i][2], stages[i][3], lane, keep).pose.beta;
    for (const i of [0, 3] as const) {
      const [, w, h, area] = stages[i];
      const { pose } = fitTilted(64, 48, w, h, area, lane, keep);
      expect(pose.beta).toBeLessThan(HERO_BETA);
      expect(pose.beta).toBeGreaterThan(0.25);
      // Backed off at the hero tilt instead, the nearest pose that keeps both nests sees past the board's side.
      let radius = pose.radius;
      let hero = aimAt({ ...pose, beta: HERO_BETA }, w, h, [32, 48 - 24.5], [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2]);
      while (!within(boardBox(hero, 64, 48, w, h, keep), area)) {
        radius *= 1.01;
        hero = aimAt({ ...hero, radius }, w, h, [32, 48 - 24.5], [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2]);
      }
      expect(covers(hero, 64, 48, w, h, area)).toBe(false);
    }
    expect(beta(2)).toBe(PORTRAIT_BETA);
    expect(beta(4)).toBe(PORTRAIT_BETA);
    // Without the nests to keep, the hero tilt stands.
    expect(fitTilted(64, 48, stages[0][1], stages[0][2], stages[0][3], lane).pose.beta).toBe(HERO_BETA);
  });

  it("where even the top view falls short of filling with both nests kept, comes nearer at the top view by what the fill asks: the 390 px phone's stage once the key folded (the e4df5fe stills: 333 px, its top corners empty at the mark moment, filled at the action's, 0.2 px shorter)", () => {
    const w = 390, h = 844;
    const queens = [{ x0: 8, y0: 24, x1: 9, y1: 25 }, { x0: 55, y0: 24, x1: 56, y1: 25 }];
    /** The nearest keeping distance's own middle aim, a little farther: the stage then sees past the board again. */
    const farther = (pose: Pose, area: { x0: number; y0: number; x1: number; y1: number }) => aimAt({ ...pose, radius: pose.radius * 1.01 }, w, h, [32, 48 - 24.5], [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2]);
    // The 3d-phone-mark stage, 333.125 px: the top view's keeping pose falls short by a hair, so the camera comes nearer
    // there by a hair — the stage filled, the nests' box past the stage's sides by under a pixel, both queens whole.
    const mark = { x0: 0, y0: 176.875, x1: 390, y1: 510 };
    const atMark = fitTilted(64, 48, w, h, mark, lane, keep).pose;
    expect(covers(atMark, 64, 48, w, h, mark)).toBe(true);
    expect(atMark.beta).toBe(TOP_BETA);
    const kb = boardBox(atMark, 64, 48, w, h, keep)!;
    expect(kb.x0).toBeGreaterThan(mark.x0 - 1);
    expect(kb.x1).toBeLessThan(mark.x1 + 1);
    for (const q of queens) expect(within(boardBox(atMark, 64, 48, w, h, q), mark)).toBe(true);
    expect(covers(farther(atMark, mark), 64, 48, w, h, mark)).toBe(false);
    // The 3d-phone-action stage, 0.2 px shorter: a tilt still fills it with the nests' box whole, as before.
    const action = { x0: 0, y0: 176.875, x1: 390, y1: 509.775 };
    const atAction = fitTilted(64, 48, w, h, action, lane, keep).pose;
    expect(covers(atAction, 64, 48, w, h, action)).toBe(true);
    expect(atAction.beta).toBeGreaterThan(TOP_BETA);
    expect(atAction.beta).toBeLessThan(PORTRAIT_BETA);
    expect(within(boardBox(atAction, 64, 48, w, h, keep), action)).toBe(true);
    // A taller stage (350 px): filled from the top view, both queens whole, the brackets' outer tiles past the stage's sides — under two tiles each, and only what the fill asks.
    const tall = { x0: 0, y0: 176.875, x1: 390, y1: 526.875 };
    const atTall = fitTilted(64, 48, w, h, tall, lane, keep).pose;
    expect(covers(atTall, 64, 48, w, h, tall)).toBe(true);
    expect(atTall.beta).toBe(TOP_BETA);
    for (const q of queens) expect(within(boardBox(atTall, 64, 48, w, h, q), tall)).toBe(true);
    const tb = boardBox(atTall, 64, 48, w, h, keep)!;
    const tile = viewTilePx(atTall, w, h);
    expect(tb.x0).toBeLessThan(tall.x0 - 0.5);
    expect(tb.x0).toBeGreaterThan(tall.x0 - 2 * tile);
    expect(tb.x1).toBeLessThan(tall.x1 + 2 * tile);
    expect(covers(farther(atTall, tall), 64, 48, w, h, tall)).toBe(false);
  });

  it("judges the fallen queen's box at the relief's height: judged flat from the hero tilt at the landscape stage, the ground she stands on pushed her box past the stage's edge (the 653a229 stills: 10 px)", () => {
    const [, w, h, area] = stages[3];
    const { pose } = fitTilted(64, 48, w, h, area, lane);
    expect(pose.beta).toBe(HERO_BETA);
    const flat = fallPose(pose, nests, queen, 64, 48, w, h, area);
    expect(within(boardBox(flat, 64, 48, w, h, queen), area)).toBe(true);
    expect(boardBox(flat, 64, 48, w, h, queen, hill)!.x0).toBeLessThan(area.x0 - 0.5);
    const judged = fallPose(pose, nests, queen, 64, 48, w, h, area, hill);
    expect(within(boardBox(judged, 64, 48, w, h, queen, hill), area)).toBe(true);
    expect(covers(judged, 64, 48, w, h, area)).toBe(true);
    expect(judged.beta).toBe(pose.beta);
  });

  it("on a 1080p stage looks due north, so both nests sit on one row well inside the stage, the lane's middle at the stage's middle", () => {
    const [, w, h, area] = stages[0];
    const { pose } = fitTilted(64, 48, w, h, area, lane);
    expect(pose.alpha).toBe(-Math.PI / 2);
    const [a, b] = [project(pose, w, h, [8.5, 0, 48 - 24.5])!, project(pose, w, h, [55.5, 0, 48 - 24.5])!];
    expect(a[1]).toBeCloseTo(b[1], 6);
    expect(a[0] - area.x0).toBeGreaterThan(60);
    expect(area.x1 - b[0]).toBeGreaterThan(60);
    expect(a[0] - area.x0).toBeCloseTo(area.x1 - b[0], 0);
    const mid = project(pose, w, h, [32, 0, 48 - 24.5])!;
    expect(mid[0]).toBeCloseTo((area.x0 + area.x1) / 2, 0);
    expect(mid[1]).toBeCloseTo((area.y0 + area.y1) / 2, 0);
  });

  it("coverBoard brings a far pose nearer until the stage sees only board, slides one aimed past the board's edge until the edge lies at the stage's, and leaves a covering pose as it is", () => {
    const [, w, h, area] = stages[0];
    const aim = { ground: [32, 48 - 24.5] as const, at: [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2] as const };
    expect(covers(far, 64, 48, w, h, area)).toBe(false);
    const near = coverBoard(far, 64, 48, w, h, area, aim);
    expect(near.radius).toBeLessThan(far.radius);
    expect(covers(near, 64, 48, w, h, area)).toBe(true);
    // The farthest such pose: a little farther no longer covers.
    expect(covers({ ...near, radius: near.radius * 1.02 }, 64, 48, w, h, area)).toBe(false);
    expect(samePose(coverBoard(near, 64, 48, w, h, area, aim), near)).toBe(true);
    // Aimed at the board's west edge: the same distance, the target slid east until the stage's left edge lies on the board's.
    const edge = coverBoard(near, 64, 48, w, h, area, { ground: [2, 48 - 24.5], at: aim.at });
    expect(edge.radius).toBeCloseTo(near.radius, 6);
    expect(edge.target[0]).toBeGreaterThan(aimAt(near, w, h, [2, 48 - 24.5], aim.at).target[0]);
    expect(groundBox(edge, w, h, area)!.x0).toBeCloseTo(COVER_MARGIN, 6);
    // The aim held (the default view): the stage, off the screen's centre, sees ground skewed west, so a slide would leave
    // the lane's middle off the stage's; the camera comes a little nearer instead and the lane's middle stays put.
    const held = coverBoard(far, 64, 48, w, h, area, { ...aim, hold: true });
    expect(held.radius).toBeLessThan(near.radius);
    expect(held.radius).toBeGreaterThan(near.radius * 0.9);
    expect(covers(held, 64, 48, w, h, area)).toBe(true);
    const mid = project(held, w, h, [32, 0, 48 - 24.5])!;
    expect(mid[0]).toBeCloseTo(aim.at[0], 0);
    expect(mid[1]).toBeCloseTo(aim.at[1], 0);
    expect(project(near, w, h, [32, 0, 48 - 24.5])![0]).toBeLessThan(aim.at[0] - 10);
  });

  it("lerpPose moves every part of the pose part way", () => {
    const a: Pose = { alpha: -1.5, beta: 0.6, radius: 60, target: [30, 0, 20] };
    const b: Pose = { alpha: -1.3, beta: 0.8, radius: 40, target: [10, 0, 24] };
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
    expect(lerpPose(a, b, 0.5)).toEqual({ alpha: -1.4, beta: 0.7, radius: 50, target: [20, 0, 22] });
  });
});

describe("resizing the 3D board", () => {
  const at: Pose = { alpha: -1.42, beta: 0.98, radius: 200, target: [64, 0, 48] };
  const next: Pose = { alpha: -1.42, beta: 0.98, radius: 230, target: [62, 0, 47] };

  it("re-fits while the camera is still at its default view", () => {
    expect(poseAfterResize({ ...at, target: [...at.target] }, at, next)).toBe(next);
  });

  it("keeps the viewer's view once they have moved the camera (a phone's address bar hiding fires resize)", () => {
    for (const moved of [{ ...at, radius: 120 }, { ...at, alpha: -1.1 }, { ...at, target: [80, 0, 40] as Pose["target"] }]) {
      expect(poseAfterResize(moved, at, next)).toBe(moved);
    }
  });
});

describe("the 3D board stays out of the 2D page", () => {
  it("web/src/main.ts imports the 3D board only inside the injected 3D start", () => {
    const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\b[^;]*board3d/m);
    expect(src).not.toMatch(/@babylonjs/);
    const imports = [...src.matchAll(/import\(\s*["'][^"']*board3d[^"']*["']\s*\)/g)];
    expect(imports).toHaveLength(1);
    expect(src).toMatch(/start3d:\s*\(\)\s*=>\s*start3dWithRecovery\(\{\s*load:\s*\(\)\s*=>\s*import\("\.\/board3d\/main3d\.ts"\)/);
    const recovery = readFileSync(new URL("../3d-recovery.ts", import.meta.url), "utf8");
    expect(recovery).not.toMatch(/\b(?:import|export)\b[^;]*board3d/);
  });
});

describe("queens", () => {
  it("stand at the stream's queen positions, converted from sub-tile units to tiles", () => {
    expect(queenTiles({ queens: [[2048, 6144], [14592, 6400]] })).toEqual([[8, 24], [57, 25]]);
    expect(queenTiles({ queens: [[384, 640], [0, 65280]] })).toEqual([[1.5, 2.5], [0, 255]]);
  });
});

describe("the 3D board's background", () => {
  it("the linear clear colour comes back as #121719 through the image-processing pass's gamma conversion", () => {
    // main3d.ts writes the clear colour linear; the pass converts every pixel with pow(c, 1/2.2) (Babylon's toGammaSpace).
    const linear = new Color4(...CLEAR_RGB, 1).toLinearSpace();
    const shown = [linear.r, linear.g, linear.b].map((c) => Math.pow(c, 1 / 2.2) * 255);
    shown.forEach((c, i) => expect(Math.abs(c - [0x12, 0x17, 0x19][i]!)).toBeLessThanOrEqual(1));
    // Unconverted, as before, it showed far lighter than the page background.
    expect(Math.pow(CLEAR_RGB[0], 1 / 2.2) * 255).toBeGreaterThan(0x12 + 12);
  });
});

describe("the fall keeps the viewer's own rotation", () => {
  it.each([-Math.PI + 0.01, Math.PI - 0.01, 2.84, -1.2])("zooms and recentres at yaw %f without angular travel", (alpha) => {
    const base: Pose = { alpha, beta: 0.45, radius: 150, target: [27, 0, 20] };
    const area = { x0: 24, y0: 140, x1: 1000, y1: 700 };
    const fall = fallPose(base, { x0: 2, y0: 18, x1: 15, y1: 31 }, { x0: 6, y0: 22, x1: 11, y1: 27 }, 64, 48, 1366, 768, area);
    expect(fall.alpha).toBe(base.alpha);
    expect(fall.beta).toBe(base.beta);
    for (const t of [0, 0.1, 0.5, 0.9, 1]) {
      const pose = lerpPose(base, fall, t);
      expect(pose.alpha).toBe(base.alpha);
      expect(pose.beta).toBe(base.beta);
    }
    expect(fall.radius).toBeLessThan(base.radius);
  });
});
