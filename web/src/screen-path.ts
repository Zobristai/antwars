/**
 * A straight path in tile space drawn on screen through a board's ground projection, at a bounded cost wherever the
 * camera is: each airborne flyer's line to its destination (flight-lines.ts) and a flyer LINE mark's air segment
 * (words.ts) are both sampled here.
 *
 * The projection gives no screen point (NaN) for ground at or behind the 3D camera's near plane, which a plain
 * projection would mirror onto the screen or throw far off it. Only the part of the path that projects is sampled,
 * about `step` px apart on screen and never in more than `maxSteps` pieces, so a path that projects millions of px long
 * close to the camera costs no more than one across the screen; clipToRect then finds the part of each piece on screen.
 */

export type Project = (tx: number, ty: number) => [number, number];

/** A screen rectangle, px. */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** No bound: the whole screen plane. */
export const EVERYWHERE: ScreenRect = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };

/** The part of a path that projects, sampled: see projectedPath. */
export interface ProjectedPath {
  /** The sampled points in order, the first and last at the ends of the part that projects; null where one does not. */
  points: ([number, number] | null)[];
  /** The path's own ends on screen, or null for an end at or behind the near plane (its part then ends at the plane). */
  start: [number, number] | null;
  end: [number, number] | null;
}

/**
 * The path from tile point from to tile point to, sampled in tile space and projected point by point (on the 3D board
 * it follows the ground's relief): all of it, or, where one end is at or behind the 3D camera's near plane, the part
 * from the other end to where the path crosses that plane. Null when neither end projects.
 */
export function projectedPath(from: readonly [number, number], to: readonly [number, number], toScreen: Project, step: number, maxSteps: number): ProjectedPath | null {
  const along = (t: number) => toScreen(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
  const start = toScreen(from[0], from[1]), end = toScreen(to[0], to[1]);
  if (!projects(start) && !projects(end)) return null;
  const t0 = projects(start) ? 0 : crossing(along, 1, 0), t1 = projects(end) ? 1 : crossing(along, 0, 1);
  const first = t0 === 0 ? start : along(t0), last = t1 === 1 ? end : along(t1);
  const n = Math.min(maxSteps, Math.max(1, Math.ceil(Math.hypot(last[0] - first[0], last[1] - first[1]) / step)));
  const points: ([number, number] | null)[] = [];
  for (let k = 0; k <= n; k++) {
    const p = k === 0 ? first : k === n ? last : along(t0 + (t1 - t0) * k / n);
    points.push(projects(p) ? p : null);
  }
  return { points, start: projects(start) ? start : null, end: projects(end) ? end : null };
}

export function projects(p: readonly [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/** The path parameter, halved from a projecting t toward one that does not, of the last point that still projects. */
function crossing(along: (t: number) => [number, number], shown: number, hidden: number): number {
  for (let i = 0; i < 40; i++) {
    const mid = (shown + hidden) / 2;
    if (projects(along(mid))) shown = mid;
    else hidden = mid;
  }
  return shown;
}

/** The part [t0, t1] of segment a to b inside r (Liang-Barsky), or null when none of it is. */
export function clipToRect(a: readonly [number, number], b: readonly [number, number], r: ScreenRect): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const edge = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return edge(-dx, a[0] - r.x0) && edge(dx, r.x1 - a[0]) && edge(-dy, a[1] - r.y0) && edge(dy, r.y1 - a[1]) ? [t0, t1] : null;
}
