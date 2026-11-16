/**
 * Where each airborne flyer is going, on both boards: a dashed line on the ground from each flying flyer to its
 * current destination, in its colony's colour, ending in a small ring. A hovering flyer holds over its destination, so
 * its ground point is the destination itself: its line runs from its body, lifted above that point as the board draws
 * it, straight down to the ring, at least FLIGHT_LINE.minDrop px long so it shows wherever the lift projects short.
 *
 * It is rebuilt every frame from the sampled message's flyer states, so a destination that moves (a moved
 * mark, the next patrol waypoint, a LINE spot) moves the line with it, and the line is there at once after
 * a seek or when joining while flyers are airborne: nothing is carried from earlier messages.
 *
 * Drawn in screen space over the board through the board's own ground projection, as the marks' markers are
 * (words.ts lineDots): points are sampled in tile space between the flyer's ground point and its destination
 * and projected one by one, so on the 3D board the line follows the ground's relief. A flyer-free message
 * draws nothing. In one colony's view (team-view.ts) only that colony's own flyers show where they are going:
 * an enemy flyer in sight is drawn, but its destination is not something the colony knows.
 */
import { Graphics } from "pixi.js";
import { SUB_TILE } from "../../src/live/format.ts";
import type { Frame } from "./buffer.ts";
import { colonyTint } from "./colony-palette.ts";
import { flyerOf, isAirborne } from "./flyer-state.ts";
import { EVERYWHERE, clipToRect, projectedPath, projects, type Project, type ScreenRect } from "./screen-path.ts";

/**
 * Screen px: dash and gap lengths, the stroke and its dark edge, the space left at the flyer, the end ring, and the
 * sampling step; on a short line each end's space is at most shortGapShare of its length. minDrop is the least length of
 * a hovering flyer's drop from its body to the ground, so that some of it shows between the flyer and the ring.
 */
export const FLIGHT_LINE = { dash: 6, gap: 4, width: 2, edge: 1.5, startGap: 6, endR: 3.5, step: 8, maxSteps: 256, shortGapShare: 0.25, minDrop: 14 } as const;

/** One airborne flyer's line, in tiles: from its ground point to its destination. */
export interface FlightLine {
  antId: number;
  colony: number;
  hovering: boolean;
  from: [number, number];
  to: [number, number];
  alpha: number;
}

/** What one line drew on screen: its dashes (each a polyline) and its end, in screen px; null end when the destination does not project. */
export interface DrawnFlightLine {
  antId: number;
  colony: number;
  dashes: [number, number][][];
  end: [number, number] | null;
}

/**
 * Every airborne flyer's line this frame, from where its body is drawn on the ground to its destination; with
 * own, the colony whose view the board shows, only that colony's flyers.
 */
export function flightLines(frame: Frame, own: number | null = null): FlightLine[] {
  const out: FlightLine[] = [];
  if (!frame.ants?.flyers) return out;
  for (let i = 0; i < frame.count; i++) {
    if (own !== null && frame.colony[i] !== own) continue;
    // By ant id (flyer-state.ts): a colony's view compacts the frame's ants while frame.ants stays the whole message.
    const f = flyerOf(frame, i);
    if (f === null || !isAirborne(f) || f.destX === undefined || f.destY === undefined) continue;
    out.push({
      antId: frame.id[i]!,
      colony: frame.colony[i]!,
      hovering: f.state === "hovering",
      from: [frame.drawX?.[i] ?? frame.x[i]!, frame.drawY?.[i] ?? frame.y[i]!],
      to: [f.destX / SUB_TILE, f.destY / SUB_TILE],
      alpha: frame.alpha[i]!,
    });
  }
  return out;
}

/** An airborne body's screen point over a ground point: the ground projection, moved px up the screen (the 2D board's lift). */
export function liftedBy(toScreen: Project, px: number): Project {
  return (tx, ty) => {
    const [x, y] = toScreen(tx, ty);
    return [x, y - px];
  };
}

/**
 * Where a hovering flyer's drop starts on screen: its body, aloft over its ground point, where that is at least
 * FLIGHT_LINE.minDrop px above the ground point; otherwise minDrop px from the ground point toward the body (straight up
 * the screen when the body projects onto its ground point, as on the 3D board seen from straight above). Null when the
 * ground point does not project.
 */
function dropTop(from: readonly [number, number], toScreen: Project, aloft: Project): [number, number] | null {
  const ground = toScreen(from[0], from[1]);
  if (!projects(ground)) return null;
  const body = aloft(from[0], from[1]);
  const dx = projects(body) ? body[0] - ground[0] : 0, dy = projects(body) ? body[1] - ground[1] : 0;
  const len = Math.hypot(dx, dy);
  if (len >= FLIGHT_LINE.minDrop) return body;
  const [ux, uy] = len > 1e-9 ? [dx / len, dy / len] : [0, -1];
  return [ground[0] + ux * FLIGHT_LINE.minDrop, ground[1] + uy * FLIGHT_LINE.minDrop];
}

/**
 * One line's dashes on screen: the path sampled in tile space about FLIGHT_LINE.step px apart and projected
 * point by point, then cut into dashes, leaving FLIGHT_LINE.startGap px clear at the flyer and the end ring's
 * radius at the destination; a short line keeps a solid connector (see FLIGHT_LINE.shortGapShare). Non-finite
 * projected points break the path. Dashes are cut only where the path is inside screen, padded by the stroke, so a
 * path that projects far off screen (on the 3D board, a ground point close to the camera's near plane) costs only
 * its sampled points and what shows. Where only one end projects (the other at or behind the 3D camera's near plane)
 * the part of the route that does is drawn, with no ring when the destination is the end that does not. Null when
 * neither end projects. A hovering flyer's line starts at its body, aloft gives the screen point of an airborne body
 * over a ground point, and drops from there to its ground point (dropTop) before running on to its destination.
 */
export function flightPath(line: FlightLine, toScreen: Project, screen: ScreenRect = EVERYWHERE, aloft: Project = toScreen): DrawnFlightLine | null {
  // The part of the route that projects: all of it, or, where one end is at or behind the 3D camera's near plane, the
  // part from the other end to where the route crosses that plane; nothing when neither end projects.
  const path = projectedPath(line.from, line.to, toScreen, FLIGHT_LINE.step, FLIGHT_LINE.maxSteps);
  if (path === null) return null;
  const points = line.hovering ? [dropTop(line.from, toScreen, aloft), ...path.points] : path.points;
  // The path's segments by the distance each starts at; a point that does not project breaks the path there, and an
  // empty segment neither breaks nor extends it.
  const segments: { a: [number, number]; b: [number, number]; s: number; len: number; joined: boolean }[] = [];
  let total = 0, joined = false;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    if (!a || !b) { joined = false; continue; }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    segments.push({ a, b, s: total, len, joined });
    total += len;
    joined = true;
  }
  // Dash k spans the distance from + k * period to a dash's length on, each bound computed from its own index and
  // never accumulated, so rounding cannot stall the walk. A short line keeps a visible connector between flyer and
  // ring: its gaps shrink to a share of its length, and a line too short for one dash and gap is drawn solid.
  const from = Math.min(FLIGHT_LINE.startGap, total * FLIGHT_LINE.shortGapShare);
  const to = total - Math.min(FLIGHT_LINE.endR, total * FLIGHT_LINE.shortGapShare);
  const period = FLIGHT_LINE.dash + FLIGHT_LINE.gap;
  const solid = to - from < period;
  const pad = FLIGHT_LINE.width / 2 + FLIGHT_LINE.edge + 1;
  const r = { x0: screen.x0 - pad, y0: screen.y0 - pad, x1: screen.x1 + pad, y1: screen.y1 + pad };
  // Each segment's part on screen, cut by the dashes it meets; a dash reaching a segment's end runs on into the next.
  const dashes: [number, number][][] = [];
  let current: [number, number][] | null = null, currentK = -1;
  for (const g of segments) {
    const part = clipToRect(g.a, g.b, r);
    if (!g.joined || part === null || part[0] > 0) current = null;
    if (part === null) continue;
    const lo = Math.max(from, g.s + part[0] * g.len), hi = Math.min(to, g.s + part[1] * g.len);
    const at = (d: number): [number, number] => [g.a[0] + (g.b[0] - g.a[0]) * (d - g.s) / g.len, g.a[1] + (g.b[1] - g.a[1]) * (d - g.s) / g.len];
    const first = solid ? 0 : Math.max(0, Math.floor((lo - from) / period));
    const last = solid ? 0 : Math.ceil((hi - from) / period);
    for (let k = first; k <= last; k++) {
      const p = solid ? from : from + k * period;
      const a = Math.max(p, lo), b = Math.min(solid ? to : p + FLIGHT_LINE.dash, hi);
      if (a >= b) continue;
      if (current === null || currentK !== k) dashes.push(current = [at(a)]);
      current.push(at(b));
      currentK = k;
    }
  }
  return { antId: line.antId, colony: line.colony, dashes, end: path.end };
}

/** The lines' layer: one Graphics redrawn each frame, over the board and under the marks' markers and badges. */
export class FlightLines {
  readonly layer = new Graphics();
  private drawnLines: DrawnFlightLine[] = [];

  /**
   * Redraw for this frame; own is the colony whose view the board shows, or null for the full view, screen the board's
   * screen, outside which nothing is cut into dashes, and aloft where the board draws an airborne flyer's body over a
   * ground point (a hovering flyer's line starts there).
   */
  update(frame: Frame, toScreen: Project, own: number | null = null, screen: ScreenRect = EVERYWHERE, aloft: Project = toScreen): void {
    const g = this.layer;
    const lines = flightLines(frame, own);
    if (lines.length === 0 && this.drawnLines.length === 0) return;
    g.clear();
    this.drawnLines = [];
    for (const line of lines) {
      const drawn = flightPath(line, toScreen, screen, aloft);
      if (drawn === null) continue;
      this.drawnLines.push(drawn);
      const tint = colonyTint(line.colony);
      const a = line.alpha;
      // A dark edge under the colony's colour, so the line reads on every ground.
      const strokes = [
        { width: FLIGHT_LINE.width + 2 * FLIGHT_LINE.edge, color: 0x000000, alpha: 0.6 * a },
        { width: FLIGHT_LINE.width, color: tint, alpha: 0.95 * a },
      ];
      for (const stroke of strokes) {
        if (drawn.dashes.length > 0) {
          for (const dash of drawn.dashes) {
            g.moveTo(dash[0]![0], dash[0]![1]);
            for (let k = 1; k < dash.length; k++) g.lineTo(dash[k]![0], dash[k]![1]);
          }
          g.stroke({ ...stroke, cap: "round", join: "round" });
        }
        if (drawn.end) g.circle(drawn.end[0], drawn.end[1], FLIGHT_LINE.endR).stroke(stroke);
      }
    }
  }

  /** What the layer drew in the last update, in screen px (the boards' flightLines() reads it). */
  drawn(): readonly DrawnFlightLine[] {
    return this.drawnLines;
  }
}
