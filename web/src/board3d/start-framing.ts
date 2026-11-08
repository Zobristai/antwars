/** A separate opening fit: preserve the live/fall solvers and all board geometry. */
import type { Box } from "../camera.ts";
import { OPENING_MARGIN } from "../start-framing.ts";
import { aimAt, MIN_RADIUS, project, type Pose } from "./view.ts";

/** Keep the full ground/mesh prism in the actual board area at the existing view angles.
 * Ground noise (noise.ts) is bounded by [-1.69, 2.39] physical tiles; [-2, 3] also
 * encloses its interpolated relief. nestHeight encloses the unchanged mound and queen.
 * Perspective maps a convex prism inside its projected vertices while all are in front.
 * No coverBoard call: enforcing cover again can crop the content we just fitted.
 */
export function fitOpeningPose(base: Pose, bounds: Box, mapH: number, w: number, h: number,
  area: Box, physicalScale = 1, nestHeight = 3 * physicalScale): Pose {
  const ground: [number, number] = [(bounds.x0 + bounds.x1) / 2, mapH - (bounds.y0 + bounds.y1) / 2];
  const middle: [number, number] = [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];
  const margin = Math.min(OPENING_MARGIN, (area.x1 - area.x0) / 4, (area.y1 - area.y0) / 4);
  const points: [number, number, number][] = [];
  for (const x of [bounds.x0, bounds.x1]) for (const y of [bounds.y0, bounds.y1]) {
    for (const height of [-2 * physicalScale, 3 * physicalScale + nestHeight]) points.push([x, height, mapH - y]);
  }
  const at = (radius: number) => aimAt({ ...base, radius, target: [ground[0], 0, ground[1]] }, w, h, ground, middle);
  const fits = (pose: Pose) => points.every(point => {
    const p = project(pose, w, h, point);
    return p !== null && p[0] >= area.x0 + margin && p[0] <= area.x1 - margin &&
      p[1] >= area.y0 + margin && p[1] <= area.y1 - margin;
  });
  let lo = MIN_RADIUS * physicalScale;
  let hi = Math.max(lo, base.radius);
  for (let i = 0; i < 32 && !fits(at(hi)); i++) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(at(mid))) hi = mid;
    else lo = mid;
  }
  return at(hi);
}
