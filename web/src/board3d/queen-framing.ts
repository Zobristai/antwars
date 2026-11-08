/** Stable normal-play framing. Founding changes the nests, never this envelope. */
import { QUEEN_FRAME_TILES } from "../buffer.ts";
import { aimAt, MIN_RADIUS, project, projector, type Area, type Pose } from "./view.ts";

type Point = readonly [number, number, number];
export interface FoundingFrame {
  readonly mapW: number;
  readonly mapH: number;
  readonly points: readonly Point[];
}

/** nests() projects the integer corners of every queen tile plus QUEEN_FRAME_TILES.
 * Any map tile may become held later. Freeze all possible corner positions at setup,
 * using the renderer's interpolated terrain, rather than a flat box or live queen list.
 * This includes edge nests' off-map borders, but no arbitrary world-space padding.
 */
export function foundingFrame(mapW: number, mapH: number, heightAt: (x: number, y: number) => number): FoundingFrame {
  const points: Point[] = [];
  for (let y = -QUEEN_FRAME_TILES; y <= mapH + QUEEN_FRAME_TILES; y++) {
    for (let x = -QUEEN_FRAME_TILES; x <= mapW + QUEEN_FRAME_TILES; x++) {
      points.push([x, heightAt(x, y), mapH - y]);
    }
  }
  return { mapW, mapH, points };
}

export function foundingProjection(frame: FoundingFrame, pose: Pose, w: number, h: number): Area | null {
  const box: Area = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const screen = projector(pose, w, h);
  for (const point of frame.points) {
    const p = screen(point);
    if (!p) return null;
    box.x0 = Math.min(box.x0, p[0]); box.x1 = Math.max(box.x1, p[0]);
    box.y0 = Math.min(box.y0, p[1]); box.y1 = Math.max(box.y1, p[1]);
  }
  return box;
}

/** One CSS pixel outside the complete diagnostic rectangle, not a replacement for it. */
export const NEST_FRAME_MARGIN = 1;

/** Nearest distance containing the fixed envelope at the existing view angles.
 * Recenter its actual projected bounds, including terrain relief. Never call coverBoard
 * afterwards: that old final step is precisely what cropped the protected nests.
 * The caller caches this setup/layout-only calculation; it is not a per-frame solver.
 */
export function fitFoundingPose(base: Pose, frame: FoundingFrame, w: number, h: number, area: Area, physicalScale = 1): Pose {
  const mid: [number, number] = [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];
  const ground: [number, number] = [frame.mapW / 2, frame.mapH / 2];
  const margin = Math.min(NEST_FRAME_MARGIN, (area.x1 - area.x0) / 4, (area.y1 - area.y0) / 4);
  const at = (radius: number) => {
    let pose = aimAt({ ...base, radius, target: [ground[0], 0, ground[1]] }, w, h, ground, mid);
    for (let i = 0; i < 5; i++) {
      const box = foundingProjection(frame, pose, w, h);
      const anchor = project(pose, w, h, [ground[0], 0, ground[1]]);
      if (!box || !anchor) break;
      const dx = (box.x0 + box.x1) / 2 - mid[0], dy = (box.y0 + box.y1) / 2 - mid[1];
      if (Math.hypot(dx, dy) < 0.05) break;
      // aimAt tolerates a quarter pixel. A sub-quarter-pixel residual is already
      // comfortably inside the one-pixel containment margin.
      pose = aimAt(pose, w, h, ground, [anchor[0] - dx, anchor[1] - dy]);
    }
    return pose;
  };
  const fits = (pose: Pose) => {
    const b = foundingProjection(frame, pose, w, h);
    return b !== null && b.x0 >= area.x0 + margin && b.y0 >= area.y0 + margin &&
      b.x1 <= area.x1 - margin && b.y1 <= area.y1 - margin;
  };
  let lo = MIN_RADIUS * physicalScale, hi = Math.max(lo, base.radius);
  for (let i = 0; i < 32 && !fits(at(hi)); i++) hi *= 2;
  for (let i = 0; i < 30; i++) {
    const midRadius = (lo + hi) / 2;
    if (fits(at(midRadius))) hi = midRadius;
    else lo = midRadius;
  }
  return at(hi);
}

/** A renderer-owned ratio, independent of the measured stage or live queen count.
 * Measure the fixed envelope at a canonical square viewport and the view's fixed
 * orientation. The stage allocator then gives leftover space back to its own layout.
 */
export function foundingAspect(frame: FoundingFrame, orientation: Pick<Pose, "alpha" | "beta">): number {
  const size = 1024;
  const base: Pose = { ...orientation, radius: Math.max(frame.mapW, frame.mapH) * 2,
    target: [frame.mapW / 2, 0, frame.mapH / 2] };
  const pose = fitFoundingPose(base, frame, size, size, { x0: 0, y0: 0, x1: size, y1: size });
  const box = foundingProjection(frame, pose, size, size)!;
  return (box.x1 - box.x0 + 2 * NEST_FRAME_MARGIN) / (box.y1 - box.y0 + 2 * NEST_FRAME_MARGIN);
}
