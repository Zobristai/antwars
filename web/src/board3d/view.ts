/**
 * The 3D board's two camera views: the prototype's tilted hero angle, the default, and a
 * top-down view, as orbit-camera poses (alpha, beta, radius about a ground target). Both frame
 * the board as the 2D board's initial view does, centred on the area between the overlay panels:
 * the whole board, or the fight lane between the nests given as `frame` (web/src/camera.ts
 * fightLane), no further than HOME_TILE_PX per tile at the lane's middle; the viewer then
 * orbits, pans and zooms freely from either.
 */
import { antLengthPx } from "../ants.ts";
import { FALL_FILL, FALL_ZOOM, HOME_TILE_PX } from "../camera.ts";
import { FALL_EMBLEM_PX, QUEEN_FRAME_TILES } from "../buffer.ts";

/** An orbit camera's pose: alpha the yaw (-PI/2 looks north), beta the angle from straight down, radius the distance. */
export interface Pose {
  alpha: number;
  beta: number;
  radius: number;
  /** World point looked at: [x, y, z], with z = mapH - tile y. */
  target: [number, number, number];
}

export type ViewName = "tilted" | "top";

/** Vertical field of view, radians. */
export const FOV = 0.6;
/**
 * The default tilted view looks due north, 34 degrees from straight down (which lets the
 * framing change the camera's default fit): the prototype's hero still orbited a little west
 * of north at 56 degrees, but so steep a tilt cannot fill a desktop's wide stage with the board and keep both
 * nests in view, since the far rows spread wide while the near ones crowd; from 34 degrees the lane shows end to
 * end on a 1080p stage, the board filling it, the ants at their largest, and the relief still reads as ground.
 * Where both nests kept in frame need the camera backed off, the tilt comes down as far as filling the stage asks
 * (fitTilted keepIn): about 24 degrees on a 1080p stage, 17 on a phone in landscape; where even the top view falls
 * short of filling (a portrait phone whose stage is taller than the board's rows span at the distance that keeps
 * both nests: 333 px at 390 px wide), the camera comes nearer at the top view by what the fill asks.
 */
export const HERO_ALPHA = -Math.PI / 2;
export const HERO_BETA = 0.6;
/** Straight down, north up (the orbit camera's beta cannot be exactly 0). */
const TOP_ALPHA = -Math.PI / 2;
export const TOP_BETA = 0.01;

/** The 2D board's fit: the screen point of tile (0, 0) and the pixels per tile (web/src/camera.ts). */
export interface Fit {
  ox: number;
  oy: number;
  tilePx: number;
}

/** A screen rectangle in CSS px: the board area between the overlay panels (web/src/overlays.ts boardArea). */
export interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The tilted view's board spans this share of the board area's width along the area's middle row,
 * where widthFill is measured (0.88-0.92 at 1080p); the board's soft edge adds about 0.03
 * on screen there, so this aims a little under 0.90...
 */
export const FILL_WIDTH = 0.88;
/** ...and on a portrait screen this share (at least 0.88 on the phone, where the edge adds nothing measurable)... */
export const PORTRAIT_FILL_WIDTH = 0.92;
/** ...unless that would make it taller than this share of the area's height. */
export const FILL_HEIGHT = 0.94;
/** A portrait screen tilts much less than the hero angle, so the board uses more of the height. */
export const PORTRAIT_BETA = 0.45;
/** The orbit camera's nearest allowed distance (main3d.ts lowerRadiusLimit); the solver never goes closer. */
export const MIN_RADIUS = 4;

/**
 * Where world point p lands on a w x h CSS px screen seen from pose, as Babylon's ArcRotateCamera
 * draws it: left-handed, y up, the camera at target + radius (cos a sin b, cos b, sin a sin b),
 * and a vertical field of view of FOV (Babylon's default FOVMODE_VERTICAL_FIXED), so a portrait
 * screen sees less across than down. Null for a point behind the camera.
 */
export function project(pose: Pose, w: number, h: number, p: readonly [number, number, number]): [number, number] | null {
  return projector(pose, w, h)(p);
}

/** Reuse the camera basis when projecting a fixed envelope of many terrain points. */
export function projector(pose: Pose, w: number, h: number): (p: readonly [number, number, number]) => [number, number] | null {
  const [tx, ty, tz] = pose.target;
  const sb = Math.sin(pose.beta);
  const ex = tx + pose.radius * Math.cos(pose.alpha) * sb;
  const ey = ty + pose.radius * Math.cos(pose.beta);
  const ez = tz + pose.radius * Math.sin(pose.alpha) * sb;
  // Forward f, right = up x f, camera up = f x right (Babylon's LookAtLH).
  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl; fy /= fl; fz /= fl;
  let rx = fz, rz = -fx;
  const rl = Math.hypot(rx, rz);
  rx /= rl; rz /= rl;
  const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;
  const k = h / 2 / Math.tan(FOV / 2);
  return (p) => {
    const dx = p[0] - ex, dy = p[1] - ey, dz = p[2] - ez;
    const z = dx * fx + dy * fy + dz * fz;
    if (z <= 1e-6) return null;
    const x = dx * rx + dz * rz;
    const y = dx * ux + dy * uy + dz * uz;
    return [w / 2 + (x / z) * k, h / 2 - (y / z) * k];
  };
}

/**
 * The ground point (world x and z, on the plane y = 0) seen at screen point (sx, sy) from pose: project's inverse,
 * or null for a point at or above the horizon, which sees no ground.
 */
export function groundAt(pose: Pose, w: number, h: number, sx: number, sy: number): [number, number] | null {
  const [tx, ty, tz] = pose.target;
  const sb = Math.sin(pose.beta);
  const ex = tx + pose.radius * Math.cos(pose.alpha) * sb;
  const ey = ty + pose.radius * Math.cos(pose.beta);
  const ez = tz + pose.radius * Math.sin(pose.alpha) * sb;
  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl; fy /= fl; fz /= fl;
  let rx = fz, rz = -fx;
  const rl = Math.hypot(rx, rz);
  rx /= rl; rz /= rl;
  const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;
  const k = h / 2 / Math.tan(FOV / 2);
  const x = (sx - w / 2) / k, y = (h / 2 - sy) / k;
  const dx = x * rx + y * ux + fx, dy = y * uy + fy, dz = x * rz + y * uz + fz;
  if (dy >= -1e-9) return null;
  const t = -ey / dy;
  return [ex + t * dx, ez + t * dz];
}

/** The ground the area shows from pose: the box of its four corners' ground points, in world x and z; null where a corner sees the sky. */
export function groundBox(pose: Pose, w: number, h: number, area: Area): { x0: number; z0: number; x1: number; z1: number } | null {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [sx, sy] of [[area.x0, area.y0], [area.x1, area.y0], [area.x0, area.y1], [area.x1, area.y1]] as const) {
    const g = groundAt(pose, w, h, sx, sy);
    if (!g) return null;
    x0 = Math.min(x0, g[0]); x1 = Math.max(x1, g[0]);
    z0 = Math.min(z0, g[1]); z1 = Math.max(z1, g[1]);
  }
  return { x0, z0, x1, z1 };
}

/** How far inside the board's edge, in tiles, the ground at the area's corners is kept: the ground's soft edge stays out of the stage. */
export const COVER_MARGIN = 0.5;

/**
 * Whether pose shows only board in the area (the board fills its area, no empty bands):
 * the ground at every corner of the area lies on the board, COVER_MARGIN inside its edge.
 */
export function covers(pose: Pose, mapW: number, mapH: number, w: number, h: number, area: Area): boolean {
  const g = groundBox(pose, w, h, area);
  return g !== null && g.x0 >= COVER_MARGIN - 1e-6 && g.x1 <= mapW - COVER_MARGIN + 1e-6 && g.z0 >= COVER_MARGIN - 1e-6 && g.z1 <= mapH - COVER_MARGIN + 1e-6;
}

/**
 * pose brought to show only board in the area, its angles kept. The ground the area shows moves with the target
 * one for one, so the camera first comes nearer, by bisection, until that ground is no larger than the board, and
 * the target then slides along the ground until the ground shown lies within the board's edge, as the 2D camera
 * stops the board at the area's edge (web/src/camera.ts clamped). With an aim (a ground point and the screen point
 * it is to land on) the nearer pose is aimed again before it slides, so the slide is only what the edge asks; with
 * the aim held, the camera comes nearer instead until the ground shown lies within the board as aimed, and nothing
 * slides (the default view keeps the lane's middle at the stage's middle: a stage off the screen's centre sees ground
 * skewed to one side, which a slide would leave off-centre). A pose that covers already comes back unchanged.
 */
export function coverBoard(pose: Pose, mapW: number, mapH: number, w: number, h: number, area: Area, aim?: { ground: readonly [number, number]; at: readonly [number, number]; hold?: boolean }): Pose {
  const at = (radius: number): Pose => (aim ? aimAt({ ...pose, radius, target: [...pose.target] }, w, h, aim.ground, aim.at) : { ...pose, radius, target: [...pose.target] });
  const shown = (radius: number) => groundBox(at(radius), w, h, area);
  const inside = (g: ReturnType<typeof groundBox>) => g !== null && g.x0 >= COVER_MARGIN && g.x1 <= mapW - COVER_MARGIN && g.z0 >= COVER_MARGIN && g.z1 <= mapH - COVER_MARGIN;
  const fits = (g: ReturnType<typeof groundBox>) => (aim?.hold ? inside(g) : g !== null && g.x1 - g.x0 <= mapW - 2 * COVER_MARGIN && g.z1 - g.z0 <= mapH - 2 * COVER_MARGIN);
  let radius = pose.radius;
  if (!fits(shown(radius))) {
    let lo = MIN_RADIUS, hi = radius;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(shown(mid))) lo = mid;
      else hi = mid;
    }
    radius = lo;
  }
  const p = at(radius);
  const g = groundBox(p, w, h, area);
  if (g === null) return p;
  const [tx, ty, tz] = p.target;
  const slide = (t: number, lo: number, hi: number) => (lo <= hi ? Math.min(Math.max(t, lo), hi) : (lo + hi) / 2);
  p.target = [slide(tx, COVER_MARGIN - (g.x0 - tx), mapW - COVER_MARGIN - (g.x1 - tx)), ty, slide(tz, COVER_MARGIN - (g.z0 - tz), mapH - COVER_MARGIN - (g.z1 - tz))];
  return p;
}

/**
 * pose with its target moved on the ground so that the ground point (gx, gz) lands at screen point (sx, sy): the
 * board moves by -J d for a target move d, so each of up to six Newton steps solves the screen's local response to
 * a one-tile move; a pose whose target or its neighbours fall behind the camera is returned as it was.
 */
export function aimAt(pose: Pose, w: number, h: number, ground: readonly [number, number], at: readonly [number, number]): Pose {
  const p: Pose = { ...pose, target: [...pose.target] };
  for (let i = 0; i < 6; i++) {
    const [tx, ty, tz] = p.target;
    const o = project(p, w, h, [ground[0], 0, ground[1]]);
    const po = project(p, w, h, [tx, 0, tz]);
    const px = project(p, w, h, [tx + 1, 0, tz]);
    const pz = project(p, w, h, [tx, 0, tz + 1]);
    if (!o || !po || !px || !pz) return p;
    const ex = o[0] - at[0], ey = o[1] - at[1];
    if (Math.hypot(ex, ey) < 0.25) return p;
    const j00 = px[0] - po[0], j10 = px[1] - po[1], j01 = pz[0] - po[0], j11 = pz[1] - po[1];
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-9) return p;
    p.target = [tx + (j11 * ex - j01 * ey) / det, ty, tz + (-j10 * ex + j00 * ey) / det];
  }
  return p;
}

/**
 * The fall window's pose:
 * the view's default pose turned onto the middle of the fallen colony's nests (box, in tiles) at the middle of the
 * area and brought nearer — at least FALL_ZOOM times, and until the box spans FALL_FILL of the area on its larger
 * side, found by bisection, never the box fitted — then kept to the board (coverBoard), so near the board's edge the
 * nests sit off-centre with the board's edge at the stage's, as on the 2D board. Kept to the board, the fallen queen
 * (queen: buffer.ts fallenQueenBox, every fallen queen's tile and QUEEN_FRAME_TILES around) can still be cut: the slide
 * puts the board's edge at the stage's far corner, and the near corners, which see less ground, start tiles further
 * in. Then the camera comes nearer again until her box lies whole in the area, since a smaller trapezoid starts fewer
 * tiles in: in steps to a distance that shows her whole, then by bisection back towards the farthest that does. Where
 * no nearer distance shows them whole (a colony of several nests, far apart), the camera stands back instead, below
 * the FALL_ZOOM floor: in steps to a distance that shows the nests' box, on the board, whole —
 * every fallen queen with her zone and FALL_FRAME_PAD tiles around as the margin, as the 2D fall fits it — then by
 * bisection back towards the nearest that does; where the board's edge stops it first (coverBoard), as far back as
 * the board allows. Her box is judged at the
 * ground's height under its corners (heightAt), as the board draws her and the stills measure her: the relief she
 * stands on raises her box on the screen and spreads it a little (the 653a229 stills cut her by 7 to 10 px at the
 * stage's left for it, judged flat).
 */
export function fallPose(base: Pose, box: Area, queen: Area, mapW: number, mapH: number, w: number, h: number, area: Area, heightAt: HeightAt = FLAT): Pose {
  const ground: readonly [number, number] = [(box.x0 + box.x1) / 2, mapH - (box.y0 + box.y1) / 2];
  const middle: readonly [number, number] = [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];
  const at = (radius: number): Pose => aimAt({ ...base, radius, target: [...base.target] }, w, h, ground, middle);
  /** The share of the area the box spans from pose q, on its larger side; everything, with a corner behind the camera. */
  const span = (q: Pose): number => {
    const b = boardBox(q, mapW, mapH, w, h, box);
    return b === null ? Infinity : Math.max((b.x1 - b.x0) / (area.x1 - area.x0), (b.y1 - b.y0) / (area.y1 - area.y0));
  };
  let hi = Math.max(MIN_RADIUS, base.radius / FALL_ZOOM);
  if (span(at(hi)) < FALL_FILL) {
    let lo = MIN_RADIUS;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (span(at(mid)) > FALL_FILL) lo = mid;
      else hi = mid;
    }
  }
  const kept = (radius: number): Pose => coverBoard(at(radius), mapW, mapH, w, h, area, { ground, at: middle });
  /** Whether pose q shows the frame (the queen's box unless named), at its ground's height, whole in the area. */
  const whole = (q: Pose, frame: Area = queen): boolean => {
    const b = boardBox(q, mapW, mapH, w, h, frame, heightAt);
    return b !== null && b.x0 >= area.x0 && b.y0 >= area.y0 && b.x1 <= area.x1 && b.y1 <= area.y1;
  };
  /** From the step in (near), the nearest distance at or beyond it that shows the nests' box (on the board) whole; or the farthest the board allows. */
  const standBack = (near: number): Pose => {
    const nests = { x0: Math.max(COVER_MARGIN, box.x0), y0: Math.max(COVER_MARGIN, box.y0), x1: Math.min(mapW - COVER_MARGIN, box.x1), y1: Math.min(mapH - COVER_MARGIN, box.y1) };
    let far = near;
    for (;;) {
      far /= 0.85;
      const q = kept(far);
      if (whole(q, nests)) break;
      if (q.radius < far) return q;
      near = far;
    }
    for (let i = 0; i < 30; i++) {
      const mid = (near + far) / 2;
      if (whole(kept(mid), nests)) far = mid;
      else near = mid;
    }
    return kept(far);
  };
  /**
   * Where even the farthest the board allows
   * cuts a fallen queen's box (a colony of nests down the board's height), the stage stays only board, and each fallen
   * queen keeps her tile and her emblem (buffer.ts FALL_EMBLEM_PX) whole down the area and her ground margin whole
   * across: only her zone and ground margin give way, at the stage's top and bottom. Their column is centred down the
   * stage, at the viewer's tilt where that holds them, else at the nearest tilt that does (the move into the fall turns
   * to it), as near as holds them. Where no tilt keeps her ground margin whole across as well (the near rows, larger,
   * reach past the stage's side: the 1366x768 stage), her tile and emblem are kept whole across instead; where no tilt
   * does even that, back as it was.
   */
  const trimmed = (back: Pose): Pose => {
    // Only a box that runs past the stage's top or bottom gives way: across, the fall stands as it was.
    const tall = boardBox(back, mapW, mapH, w, h, queen, heightAt);
    if (whole(back) || (tall !== null && tall.y0 >= area.y0 && tall.y1 <= area.y1)) return back;
    const q = QUEEN_FRAME_TILES;
    const tiles: Area = { x0: queen.x0 + q, y0: queen.y0 + q, x1: queen.x1 - q, y1: queen.y1 - q };
    const at = (p: Pose, tx: number, ty: number) => project(p, w, h, [tx, heightAt(tx, ty), mapH - ty]);
    let margin = true;
    /** Whether p holds them (only board shown is coverBoard's), and how far the column's middle lies below the area's, px. */
    const held = (p: Pose): { ok: boolean; off: number } => {
      const across = boardBox(p, mapW, mapH, w, h, margin ? queen : tiles, heightAt);
      const down = boardBox(p, mapW, mapH, w, h, tiles, heightAt);
      if (across === null || down === null) return { ok: false, off: 0 };
      let top = down.y0, bottom = down.y1, left = across.x0, right = across.x1;
      for (const x of [tiles.x0 + 0.5, tiles.x1 - 0.5]) {
        for (const y of [tiles.y0 + 0.5, tiles.y1 - 0.5]) {
          const c = at(p, x, y);
          if (!c) return { ok: false, off: 0 };
          top = Math.min(top, c[1] - FALL_EMBLEM_PX);
          bottom = Math.max(bottom, c[1] + FALL_EMBLEM_PX);
          left = Math.min(left, c[0] - FALL_EMBLEM_PX);
          right = Math.max(right, c[0] + FALL_EMBLEM_PX);
        }
      }
      const ok = left >= area.x0 && right <= area.x1 && top >= area.y0 && bottom <= area.y1;
      return { ok, off: (top + bottom) / 2 - middle[1] };
    };
    /** At tilt beta and distance radius, kept to the board, the nests' middle aimed so the column sits centred down the area where the board allows. */
    const centred = (beta: number, radius: number): Pose => {
      let y = middle[1], p = back;
      for (let i = 0; i < 6; i++) {
        const aim: readonly [number, number] = [middle[0], y];
        p = coverBoard(aimAt({ ...base, beta, radius, target: [...base.target] }, w, h, ground, aim), mapW, mapH, w, h, area, { ground, at: aim });
        const { off } = held(p);
        if (Math.abs(off) < 0.25) break;
        y -= off;
      }
      return p;
    };
    const wide = 4 * Math.max(back.radius, base.radius);
    for (const keep of [true, false]) {
      margin = keep;
      for (let k = 0; k <= 60; k++) {
        for (const beta of k === 0 ? [base.beta] : [base.beta + k * 0.01, base.beta - k * 0.01]) {
          if (beta < TOP_BETA || beta > 1.2) continue;
          const far = centred(beta, wide);
          if (!held(far).ok) continue;
          if (held(centred(beta, hi)).ok) return centred(beta, hi);
          let near = hi, out = far.radius;
          for (let i = 0; i < 30; i++) {
            const mid = (near + out) / 2;
            if (held(centred(beta, mid)).ok) out = mid;
            else near = mid;
          }
          return centred(beta, out);
        }
      }
    }
    return back;
  };
  const pose = kept(hi);
  if (whole(pose)) return pose;
  // Very near, her box outgrows the area again, so the near bound is found by stepping in, not taken at MIN_RADIUS.
  let lo = hi;
  do {
    lo *= 0.85;
    if (lo < MIN_RADIUS) return trimmed(standBack(hi));
  } while (!whole(kept(lo)));
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (whole(kept(mid))) lo = mid;
    else hi = mid;
  }
  return kept(lo);
}

/** The pose part way (t, 0..1) from a to b: the camera's move into the fall, eased by the caller (web/src/camera.ts easeInOut). */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const m = (x: number, y: number) => x + (y - x) * t;
  return { alpha: m(a.alpha, b.alpha), beta: m(a.beta, b.beta), radius: m(a.radius, b.radius), target: [m(a.target[0], b.target[0]), m(a.target[1], b.target[1]), m(a.target[2], b.target[2])] };
}

/** CSS px per tile across the screen at the pose's target: how big the board draws at its centre. */
export function viewTilePx(pose: Pose, w: number, h: number): number {
  const [x, y, z] = pose.target;
  const a = project(pose, w, h, [x - 0.5, y, z]);
  const b = project(pose, w, h, [x + 0.5, y, z]);
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
}

/** The whole board as a frame on the ground, in tiles. */
const wholeBoard = (mapW: number, mapH: number): Area => ({ x0: 0, y0: 0, x1: mapW, y1: mapH });

/** The ground's height at a tile corner, in world units above the plane: flat without one, the relief's where the board gives its own (main3d.ts ground.heightAt). */
export type HeightAt = (tx: number, ty: number) => number;
const FLAT: HeightAt = () => 0;

/**
 * The screen box of a ground frame's four corners (tiles; the whole board by default), each at the height the ground
 * has there (heightAt; flat by default), as the board projects them (main3d.ts toScreen) — or null if one is behind
 * the camera.
 */
export function boardBox(pose: Pose, mapW: number, mapH: number, w: number, h: number, frame: Area = wholeBoard(mapW, mapH), heightAt: HeightAt = FLAT): Area | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [tx, ty] of [[frame.x0, frame.y1], [frame.x1, frame.y1], [frame.x0, frame.y0], [frame.x1, frame.y0]] as const) {
    const s = project(pose, w, h, [tx, heightAt(tx, ty), mapH - ty]);
    if (!s) return null;
    x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]);
    y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The frame's width on screen along row y: where the screen row crosses its projected outline. A
 * tilted board is a trapezoid, narrower in the middle than at its near edge. Null if the row
 * misses the frame or a corner is behind the camera.
 */
export function rowWidth(pose: Pose, mapW: number, mapH: number, w: number, h: number, y: number, frame: Area = wholeBoard(mapW, mapH)): number | null {
  const z0 = mapH - frame.y1, z1 = mapH - frame.y0;
  const q = ([[frame.x0, 0, z1], [frame.x1, 0, z1], [frame.x1, 0, z0], [frame.x0, 0, z0]] as const).map((c) => project(pose, w, h, c));
  let x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if (!a || !b) return null;
    if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
    const x = a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
  }
  return x1 > x0 ? x1 - x0 : null;
}

/**
 * The tilted view fitted to the board area: the frame (the whole board, or the fight lane) spans
 * FILL_WIDTH (PORTRAIT_FILL_WIDTH on a portrait screen) of the area's width along the area's middle
 * row, where widthFill is measured, FILL_HEIGHT of its height at most, its corners' box centred in
 * the area, never nearer than MIN_RADIUS. Perspective makes this nonlinear, so it iterates: scale
 * the distance by the fill error, then move the target on the ground by the centring error through
 * the screen's local response to a one-tile move. converged is false if it did not settle. A fight
 * lane is then brought no further than HOME_TILE_PX per tile at its middle, so the ants read.
 */
export function fitTilted(mapW: number, mapH: number, w: number, h: number, area: Area, frame?: Area, keep?: Area): { pose: Pose; converged: boolean } {
  const aw = area.x1 - area.x0;
  const ah = area.y1 - area.y0;
  const acx = (area.x0 + area.x1) / 2;
  const acy = (area.y0 + area.y1) / 2;
  const portrait = h > w;
  const fill = portrait ? PORTRAIT_FILL_WIDTH : FILL_WIDTH;
  const f = frame ?? wholeBoard(mapW, mapH);
  const pose: Pose = { alpha: HERO_ALPHA, beta: portrait ? PORTRAIT_BETA : HERO_BETA, radius: Math.max(mapW, mapH) * 2, target: [(f.x0 + f.x1) / 2, 0, mapH - (f.y0 + f.y1) / 2] };
  /** Move the target on the ground so that screen point o lands at (acx, acy): the board moves by -J d for a move d (one Newton step). */
  const aim = (p: Pose, o: readonly [number, number]): boolean => {
    const [tx, , tz] = p.target;
    const po = project(p, w, h, [tx, 0, tz]);
    const px = project(p, w, h, [tx + 1, 0, tz]);
    const pz = project(p, w, h, [tx, 0, tz + 1]);
    if (!po || !px || !pz) return false;
    const ex = o[0] - acx, ey = o[1] - acy;
    const j00 = px[0] - po[0], j10 = px[1] - po[1], j01 = pz[0] - po[0], j11 = pz[1] - po[1];
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-9) return false;
    p.target = [tx + (j11 * ex - j01 * ey) / det, 0, tz + (-j10 * ex + j00 * ey) / det];
    return true;
  };
  /**
   * A fight lane, once fitted, is brought nearer where it must be: to HOME_TILE_PX per tile at its
   * middle, so the ants read, and until the board's near edge (its last row) lies at or below the area's
   * bottom, so no void shows under the board; the lane's middle stays at the area's middle. Both grow as the
   * camera nears, so the farthest such distance is found by bisection. Then the board is made to fill the
   * area on every side (coverBoard): nearer where the area still sees past the
   * board's far or side edges, the lane sliding off the area's middle only as far as the board's edge asks.
   */
  const settle = (p: Pose): Pose => {
    if (frame === undefined) return p;
    const cx = (f.x0 + f.x1) / 2, cz = mapH - (f.y0 + f.y1) / 2;
    const at = (radius: number): Pose => aimAt({ ...p, radius, target: [...p.target] }, w, h, [cx, cz], [acx, acy]);
    const fine = (q: Pose): boolean => {
      const near = project(q, w, h, [cx, 0, 0]);
      return viewTilePx(q, w, h) >= HOME_TILE_PX - 1e-6 && near !== null && near[1] >= area.y1 - 0.5;
    };
    const cover = (q: Pose): Pose => coverBoard(q, mapW, mapH, w, h, area, { ground: [cx, cz], at: [acx, acy], hold: true });
    /** Whether the box to keep (both queens' nests) lies within the area from pose q. */
    const kept = (q: Pose): boolean => {
      if (keep === undefined) return true;
      const b = boardBox(q, mapW, mapH, w, h, keep);
      return b !== null && b.x0 >= area.x0 - 0.5 && b.x1 <= area.x1 + 0.5 && b.y0 >= area.y0 - 0.5 && b.y1 <= area.y1 + 0.5;
    };
    /**
     * Both queens stay in frame at every viewport (a fixed requirement), ahead of the ant-size
     * floor and the cover: where the near pose has lost one, the camera backs off to the nearest distance that keeps
     * them, the lane's middle still at the area's middle. Backed off at the view's own tilt, a wide stage's far
     * corners see past the board's side edges, since the far rows spread wide (at 1080p and in landscape the stage's top
     * left corner was left empty); so where the kept pose no longer
     * covers, the tilt comes down (beta, towards straight down) to the steepest at which the nearest keeping pose
     * covers, found by bisection: flatter, the rows spread less, and the stage sees only board with both queens
     * across it. Where even the top view's keeping pose falls short of covering — a stage taller than the board's
     * rows span at the distance that keeps both nests: the 390 px phone's once the key folded (the e4df5fe stills:
     * 333 px, the top corners empty at the mark moment and filled at the action's, 0.2 px shorter) — the camera
     * comes nearer at the top view until it covers (coverBoard, the lane's middle held), the nests' box giving way
     * by only what the fill asks: a hair there, the brackets' outer tiles on a taller stage.
     */
    const keepIn = (far: Pose, near: Pose): Pose => {
      if (kept(near)) return near;
      if (!kept(far)) return far;
      const atTilt = (radius: number, beta: number): Pose => aimAt({ ...p, beta, radius, target: [...p.target] }, w, h, [cx, cz], [acx, acy]);
      /** The nearest pose at tilt beta, between near's distance and far's, that keeps both queens' nests; null where far's does not at that tilt. */
      const keeping = (beta: number): Pose | null => {
        if (!kept(atTilt(far.radius, beta))) return null;
        let lo = near.radius, hi = far.radius;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (kept(atTilt(mid, beta))) hi = mid;
          else lo = mid;
        }
        return atTilt(hi, beta);
      };
      const fills = (q: Pose | null): q is Pose => q !== null && covers(q, mapW, mapH, w, h, area);
      const own = keeping(p.beta)!;
      if (fills(own)) return own;
      const top = keeping(TOP_BETA);
      if (top === null) return own;
      if (!fills(top)) return cover(top);
      let lo = TOP_BETA, hi = p.beta;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (fills(keeping(mid))) lo = mid;
        else hi = mid;
      }
      return keeping(lo)!;
    };
    const fitted = at(p.radius);
    if (fine(fitted)) return keepIn(fitted, cover(fitted));
    let lo = MIN_RADIUS, hi = p.radius;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fine(at(mid))) lo = mid;
      else hi = mid;
    }
    return keepIn(fitted, cover(at(lo)));
  };
  for (let i = 0; i < 60; i++) {
    const box = boardBox(pose, mapW, mapH, w, h, f);
    if (!box) {
      pose.radius *= 1.5;
      continue;
    }
    const mid = rowWidth(pose, mapW, mapH, w, h, acy, f) ?? box.x1 - box.x0;
    const s = Math.min((fill * aw) / mid, (FILL_HEIGHT * ah) / (box.y1 - box.y0));
    const ex = (box.x0 + box.x1) / 2 - acx;
    const ey = (box.y0 + box.y1) / 2 - acy;
    if (Math.abs(s - 1) < 1e-4 && Math.hypot(ex, ey) < 0.25) return { pose: settle(pose), converged: true };
    if (pose.radius <= MIN_RADIUS && s > 1 && Math.hypot(ex, ey) < 0.25) return { pose: settle(pose), converged: true };
    pose.radius = Math.max(MIN_RADIUS, pose.radius / s);
    if (!aim(pose, [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2])) break;
  }
  return { pose: settle(pose), converged: false };
}

/**
 * A view's pose for a screen of w x h CSS px. Tilted: fitted to the board area (fitTilted), on the
 * frame when one is given. Top: as in rev 10, looking at the tile at the screen's centre from far
 * enough that the ground there spans as many tiles across the screen as the 2D board's view
 * (`fit`: its initial view) shows.
 */
export function viewPose(name: ViewName, mapW: number, mapH: number, w: number, h: number, fit: Fit, area: Area, frame?: Area, keep?: Area, physicalScale = 1): Pose {
  // Solve in original physical units so padding, minimum radius and pixel-size floors
  // remain identical. Convert only the resulting world-space pose back to fine tiles.
  if (physicalScale !== 1) {
    const physicalBox = (box: Area | undefined): Area | undefined => box && ({
      x0: box.x0 / physicalScale, y0: box.y0 / physicalScale,
      x1: box.x1 / physicalScale, y1: box.y1 / physicalScale,
    });
    const pose = viewPose(name, mapW / physicalScale, mapH / physicalScale, w, h,
      { ...fit, tilePx: fit.tilePx * physicalScale }, area, physicalBox(frame), physicalBox(keep));
    return { ...pose, radius: pose.radius * physicalScale,
      target: [pose.target[0] * physicalScale, pose.target[1] * physicalScale, pose.target[2] * physicalScale] };
  }
  if (name === "tilted") return fitTilted(mapW, mapH, w, h, area, frame, keep).pose;
  const cx = (w / 2 - fit.ox) / fit.tilePx;
  const cy = (h / 2 - fit.oy) / fit.tilePx;
  const hfov = 2 * Math.atan(Math.tan(FOV / 2) * (w / h));
  const radius = w / 2 / fit.tilePx / Math.tan(hfov / 2);
  return { alpha: TOP_ALPHA, beta: TOP_BETA, radius, target: [cx, 0, mapH - cy] };
}

/** Whether two poses are the same view, within what applying a pose and reading it back can change. */
export function samePose(a: Pose, b: Pose): boolean {
  return (
    Math.abs(a.alpha - b.alpha) < 1e-3 &&
    Math.abs(a.beta - b.beta) < 1e-3 &&
    Math.abs(a.radius - b.radius) <= 1e-3 * Math.max(1, b.radius) &&
    Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]) < 1e-2
  );
}

/**
 * The pose after a resize: the new default only while the camera still stands at the last
 * default it was given; once the viewer has moved it, a resize (a phone's address bar hiding
 * fires one) keeps their view.
 */
export function poseAfterResize(current: Pose, lastDefault: Pose, nextDefault: Pose): Pose {
  return samePose(current, lastDefault) ? nextDefault : current;
}

/** The 3D ant's body, abdomen tip to head, in the mesh's units (ants3d.ts buildAntGeometry: x -0.505 to 0.37). */
export const ANT_BODY = 0.875;
/**
 * Ant length in tiles, the mesh's scale, at px CSS px per tile: the ant's body, abdomen to head,
 * spans the 2D board's own ant length (web/src/ants.ts antLengthPx) on screen.
 */
export function antTiles(px: number, physicalScale = 1): number {
  return antLengthPx(px * physicalScale) / px / ANT_BODY;
}

/** How far from an ant a hover or tap still picks it, in tiles, as on the 2D board (web/src/main.ts antAt). */
export const PICK_TILES = 1.2;

/**
 * The ant nearest a screen point (x, y), as a frame index, or -1: of n ants, each at screen
 * point at(i), the nearest whose distance is within PICK_TILES tiles at that ant's own zoom,
 * tilePx(i) screen px per tile where it stands (a tilted view shows near tiles larger), or
 * within minPx screen px where that is more (a finger's tolerance).
 */
export function pickNearest(n: number, at: (i: number) => readonly [number, number], tilePx: (i: number) => number, x: number, y: number, minPx = 0): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const [sx, sy] = at(i);
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestD && d <= Math.max(PICK_TILES * tilePx(i), minPx)) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
