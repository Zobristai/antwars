/** Shared body facing and travel presentation. Canonical coordinates, hits and labels never move.
 * Fixed 1 ms steps are cached per stream interval: 30/60 fps, holds and seeks sample
 * the same trajectory, rather than integrating a different filter per renderer.
 */
import { SUB_TILE, type StreamAnts, type StreamSetup } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { adjacentWithSlack, type Engagement } from "./bite.ts";
import { gridScale } from "./grid-scale.ts";

/** The single drawn-body tuning point, shared by both boards and all facing paths. */
export const BODY_TURN_SPEED_DEGREES_PER_SECOND = 540;
const BODY_TURN_PER_MS = BODY_TURN_SPEED_DEGREES_PER_SECOND * Math.PI / 180 / 1000;
const REVERSAL_ARC = 150 * Math.PI / 180;
const REVERSAL_WINDOW_MS = 600;
const REVERSAL_EPISODE_MS = 2000;
const REVERSAL_GUIDE_SLOP = Math.PI / 180;
// Internal positional steering only. Slowing this controller would increase trail.
const POSITION_STEER_PER_MS = Math.PI / 200;
const CATCHUP_PER_MS = 0.0042;
const MOVE_CONE = Math.PI / 3; // 30 degrees spare for a rounded 30 fps observation.
const EPS = 1e-6;
const delta = (a: number, b: number) => {
  const d = (b - a) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
};
const turn = (a: number, b: number) => a + Math.max(-POSITION_STEER_PER_MS, Math.min(POSITION_STEER_PER_MS, delta(a, b)));
// Stream coordinates are bounded to the board; no overflow-rescaling is needed.
const distanceOf = (x: number, y: number) => Math.sqrt(x * x + y * y);
const sameRoundedCell = (a: number, b: number) => Math.floor((a - 1) / SUB_TILE) === Math.floor((b - 1) / SUB_TILE) &&
  Math.floor((a + 1) / SUB_TILE) === Math.floor((b + 1) / SUB_TILE);
type Rect = readonly [number, number, number, number];

interface Tick {
  tick: number;
  ants: StreamAnts;
  index: ReadonlyMap<number, number>;
  board: { setup: StreamSetup };
  facing: ReadonlyMap<number, { rotation: number; target: number | null }>;
  engagements: readonly Engagement[];
}
interface State { x: number; y: number; rotation: number; since: number | null; recovering: boolean }
interface Trail { values: Float64Array; moving: Uint8Array; end: State; ground?: boolean }
interface FacingHistory {
  canonical: number | null;
  goal: number | null;
  pending: { readonly at: number; readonly rotation: number } | null;
  qualified: { readonly at: number; readonly sign: -1 | 1 } | null;
}
interface FacingTrail { values: Float64Array | null; end: number; history?: FacingHistory }

/** Qualify the final physical net arc, not a peak reached before a retarget. */
function finishTravelTurn(history: FacingHistory, rotation: number): void {
  if (!history.pending) return;
  const net = rotation - history.pending.rotation;
  if (Math.abs(net) >= REVERSAL_ARC) history.qualified = { at: history.pending.at, sign: net > 0 ? 1 : -1 };
  history.pending = null;
}

interface Interval { trails: Map<number, Trail>; facings: Map<number, FacingTrail>; span: number; full: boolean }
export interface TravelFrame {
  count: number; id: Uint32Array; x: Float32Array; y: Float32Array;
  drawX: Float64Array | null; drawY: Float64Array | null; drawRotation: Float64Array | null;
  walk: Uint8Array;
}

/** A catch-up chord may not cut an obstacle corner, even if its endpoints are dry. */
function visible(ax: number, ay: number, bx: number, by: number, rects: readonly Rect[]): boolean {
  for (const [x, y, w, h] of rects) {
    let lo = 0, hi = 1;
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) < 1e-12) { if (ax < x || ax >= x + w) continue; }
    else { const a = (x - ax) / dx, b = (x + w - ax) / dx; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); }
    if (Math.abs(dy) < 1e-12) { if (ay < y || ay >= y + h) continue; }
    else { const a = (y - ay) / dy, b = (y + h - ay) / dy; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); }
    if (hi >= lo && hi >= 0 && lo <= 1) return false;
  }
  return true;
}

type Point = readonly [number, number];
interface GroundRoute { points: readonly Point[]; length: number }
interface GroundPaths {
  rects: readonly Rect[];
  clear(a: Point, b: Point): boolean;
  route(a: Point, b: Point): GroundRoute | null;
}
// Geometric clearance and arithmetic tolerance, not a widened trail bound.
const GROUND_CLEARANCE = 0.00001;
const GROUND_ROUNDING = 1e-12;
const pointDistance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pointBetween = (a: Point, b: Point, u: number): Point => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];

/** Static geometry only: no stream, ant or facing history belongs in this cache. */
function groundPaths(setup: StreamSetup): GroundPaths {
  const rects: Rect[] = [...(setup.terrain?.water ?? []), ...(setup.terrain?.rocks ?? []).map(r => [r[0], r[1], r[2], r[3]] as const)];
  const padded: Rect[] = rects.map(([x, y, w, h]) => [x - GROUND_CLEARANCE, y - GROUND_CLEARANCE, w + 2 * GROUND_CLEARANCE, h + 2 * GROUND_CLEARANCE]);
  const inside = (p: Point, [x, y, w, h]: Rect) => p[0] > x + GROUND_ROUNDING && p[0] < x + w - GROUND_ROUNDING &&
    p[1] > y + GROUND_ROUNDING && p[1] < y + h - GROUND_ROUNDING;
  const legal = (p: Point) => p[0] >= 0 && p[1] >= 0 && p[0] < setup.mapW && p[1] < setup.mapH && !padded.some(r => inside(p, r));
  const clear = (a: Point, b: Point): boolean => {
    if (!legal(a) || !legal(b)) return false;
    for (const [x, y, w, h] of padded) {
      let lo = 0, hi = 1;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      if (Math.abs(dx) < GROUND_ROUNDING) { if (a[0] <= x + GROUND_ROUNDING || a[0] >= x + w - GROUND_ROUNDING) continue; }
      else { const p = (x - a[0]) / dx, q = (x + w - a[0]) / dx; lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q)); }
      if (Math.abs(dy) < GROUND_ROUNDING) { if (a[1] <= y + GROUND_ROUNDING || a[1] >= y + h - GROUND_ROUNDING) continue; }
      else { const p = (y - a[1]) / dy, q = (y + h - a[1]) / dy; lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q)); }
      if (hi - lo > GROUND_ROUNDING && inside(pointBetween(a, b, (lo + hi) / 2), [x, y, w, h])) return false;
    }
    return true;
  };
  // Keep source rectangle/corner order. Equal-cost routes have a stable first winner.
  const corners: Point[] = padded.flatMap(([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as Point[]).filter(legal);
  let cornerEdges: number[][] | undefined;
  const project = (p: Point): Point | null => {
    if (legal(p)) return p;
    const candidates = [...corners];
    for (const [x, y, w, h] of padded) candidates.push([x, p[1]], [x + w, p[1]], [p[0], y], [p[0], y + h]);
    // Projection is only the recorded endpoint's small boundary/quantisation repair.
    // An impossible endpoint/route cannot fall back to a teleport.
    return candidates.filter(legal).sort((a, b) => pointDistance(a, p) - pointDistance(b, p))[0] ?? null;
  };
  const route = (a: Point, b: Point): GroundRoute | null => {
    const start = project(a), end = project(b);
    if (!start || !end) return null;
    let points: Point[];
    if (clear(start, end)) points = [start, end];
    else {
      cornerEdges ??= corners.map((p, i) => corners.map((q, j) => i !== j && clear(p, q) ? pointDistance(p, q) : Infinity));
      const nodes = [start, end, ...corners], n = nodes.length;
      const costs = new Array<number>(n).fill(Infinity), previous = new Array<number>(n).fill(-1), seen = new Array<boolean>(n).fill(false);
      costs[0] = 0;
      for (let k = 0; k < n; k++) {
        let i = -1;
        for (let j = 0; j < n; j++) if (!seen[j] && (i < 0 || costs[j]! < costs[i]!)) i = j;
        if (i < 0 || !Number.isFinite(costs[i]!)) break;
        if (i === 1) break;
        seen[i] = true;
        for (let j = 0; j < n; j++) if (j !== i && !seen[j]) {
          const edge = i >= 2 && j >= 2 ? cornerEdges[i - 2]![j - 2]! : clear(nodes[i]!, nodes[j]!) ? pointDistance(nodes[i]!, nodes[j]!) : Infinity;
          const cost = costs[i]! + edge;
          if (cost < costs[j]!) { costs[j] = cost; previous[j] = i; }
        }
      }
      if (!Number.isFinite(costs[1]!)) return null;
      points = [];
      for (let i = 1; i >= 0; i = previous[i]!) { points.unshift(nodes[i]!); if (i === 0) break; }
    }
    return { points, length: points.slice(1).reduce((sum, p, i) => sum + pointDistance(points[i]!, p), 0) };
  };
  return { rects, clear, route };
}

function groundPoint(route: GroundRoute, distance: number): Point {
  let remaining = Math.max(0, Math.min(route.length, distance));
  for (let k = 1; k < route.points.length; k++) {
    const a = route.points[k - 1]!, b = route.points[k]!, length = pointDistance(a, b);
    if (remaining <= length) return pointBetween(a, b, length ? remaining / length : 0);
    remaining -= length;
  }
  return route.points[route.points.length - 1]!;
}

export class Pivots {
  private intervals = new WeakMap<Tick, Interval>();
  private grounds = new WeakMap<StreamSetup, GroundPaths>();

  reset(): void { this.intervals = new WeakMap(); this.grounds = new WeakMap(); }

  private ground(setup: StreamSetup): GroundPaths {
    let paths = this.grounds.get(setup);
    if (!paths) { paths = groundPaths(setup); this.grounds.set(setup, paths); }
    return paths;
  }

  private prepare(ticks: readonly Tick[], at: number): Interval {
    const cached = this.intervals.get(ticks[at]!);
    if (cached?.full) return cached;
    let from = at;
    // Facing holds across a missing message; positional history still resets at
    // that boundary in build(). Reconstruct both from the nearest checkpoint.
    while (from > 0 && !this.intervals.has(ticks[from - 1]!)) from--;
    let result: Interval | undefined;
    for (let q = from; q <= at; q++) {
      const old = this.intervals.get(ticks[q]!);
      result = old && (q !== at || old.full) ? old : this.build(ticks, q, q >= at - 8);
      // A cold jump through a long recording needs only occasional end-state
      // checkpoints. Do not retain thousands of per-ant intermediate states.
      const previous = ticks[q - 1];
      if (previous && q - 1 < at - 8 && (q - 1) % 32 !== 0 && !this.intervals.get(previous)?.full) this.intervals.delete(previous);
    }
    return result!;
  }

  private facing(A: Tick, B: Tick | undefined, C: Tick | undefined, previous: Interval | undefined,
    span: number, full: boolean, pairs: ReadonlyMap<number, Engagement>): Map<number, FacingTrail> {
    const trails = new Map<number, FacingTrail>();
    const reach = gridScale(A.board.setup);
    for (let i = 0; i < A.ants.count; i++) {
      const id = A.ants.id[i]!, j = B?.index.get(id), z = C?.index.get(id);
      let rotation = previous?.facings.get(id)?.end ?? A.ants.heading[i]! / 256 * 2 * Math.PI;
      if (span > TICK_MS) {
        // No inferred facing or retained bite through missing messages. Keep
        // the last known body angle until a fresh tick supplies a new target.
        trails.set(id, { values: null, end: rotation });
        continue;
      }
      const ax = A.ants.x[i]! / SUB_TILE, ay = A.ants.y[i]! / SUB_TILE;
      const bx = j === undefined ? ax : B!.ants.x[j]! / SUB_TILE, by = j === undefined ? ay : B!.ants.y[j]! / SUB_TILE;
      let vx = z === undefined ? bx - ax : C!.ants.x[z]! / SUB_TILE - bx;
      let vy = z === undefined ? by - ay : C!.ants.y[z]! / SUB_TILE - by;
      if (distanceOf(vx, vy) < 1e-8) { vx = bx - ax; vy = by - ay; }
      const length = distanceOf(vx, vy);
      const gx = span ? (bx - ax) / span + (length > 1e-8 ? vx / length * 0.2 : 0) : 0;
      const gy = span ? (by - ay) / span + (length > 1e-8 ? vy / length * 0.2 : 0) : 0;
      const travel = distanceOf(gx, gy) > 1e-8 ? Math.atan2(gy, gx) : A.ants.heading[i]! / 256 * 2 * Math.PI;
      const facing = A.facing.get(id), pair = pairs.get(id);
      const targetA = pair ? A.index.get(pair.b) : undefined, targetB = pair ? B?.index.get(pair.b) : undefined;
      const values = full ? new Float64Array(span + 1) : null;
      if (values) values[0] = rotation;
      const before = previous?.facings.get(id)?.history;
      // Nested records are immutable; rebuilding a cold interval cannot mutate
      // the checkpoint that a later seek will reconstruct from.
      const history: FacingHistory = before ? { ...before } : { canonical: null, goal: null, pending: null, qualified: null };
      if (facing?.target == null) {
        const initial = rotation, time = A.tick * TICK_MS;
        let dh = delta(initial, travel);
        const realGuide = distanceOf(gx, gy) > 1e-8;
        if (bx !== ax || by !== ay) history.canonical = Math.atan2(by - ay, bx - ax);
        const cx = z === undefined ? bx : C!.ants.x[z]! / SUB_TILE;
        const cy = z === undefined ? by : C!.ants.y[z]! / SUB_TILE;
        if (history.goal !== null) {
          if (realGuide && Math.abs(delta(history.goal, travel)) <= REVERSAL_GUIDE_SLOP) {
            history.goal += delta(history.goal, travel);
            dh = history.goal - initial;
          } else history.goal = null;
        }
        if (j !== undefined && z !== undefined && (cx !== bx || cy !== by) && history.canonical !== null &&
          Math.abs(delta(history.canonical, Math.atan2(cy - by, cx - bx))) >= REVERSAL_ARC) {
          // The lookahead starts this physical turn one tick before the
          // canonical reversal. Microturns and holds do not erase history.
          finishTravelTurn(history, initial);
          const shortest = delta(initial, travel);
          if (Math.abs(shortest) >= REVERSAL_ARC) {
            const last = history.qualified;
            const sign = Math.sign(shortest);
            const preferred = last && time - last.at <= REVERSAL_EPISODE_MS ? -last.sign : sign;
            // Negating the magnitude would miss the target. Retain the actual
            // other winding even after its remaining arc exceeds pi.
            dh = preferred === sign ? shortest : shortest - sign * 2 * Math.PI;
            history.goal = initial + dh;
          }
          history.pending = { at: time, rotation: initial };
        }
        const at = (ms: number) => initial + Math.sign(dh) * Math.min(Math.abs(dh), BODY_TURN_PER_MS * ms);
        if (history.pending && history.pending.at + REVERSAL_WINDOW_MS <= time + span) {
          finishTravelTurn(history, at(Math.max(0, history.pending.at + REVERSAL_WINDOW_MS - time)));
        }
        if (values) for (let ms = 1; ms <= span; ms++) values[ms] = at(ms);
        rotation = at(span);
        if (history.goal !== null && Math.abs(history.goal - rotation) < 1e-12) history.goal = null;
      } else for (let ms = 1; ms <= span; ms++) {
        const u = ms / span, sx = ax + (bx - ax) * u, sy = ay + (by - ay) * u;
        const tx = targetA === undefined ? 0 : A.ants.x[targetA]! + ((targetB === undefined ? A.ants.x[targetA]! : B!.ants.x[targetB]!) - A.ants.x[targetA]!) * u;
        const ty = targetA === undefined ? 0 : A.ants.y[targetA]! + ((targetB === undefined ? A.ants.y[targetA]! : B!.ants.y[targetB]!) - A.ants.y[targetA]!) * u;
        const biting = pair !== undefined && (pair.terminalTick !== undefined || (targetA !== undefined && adjacentWithSlack(sx * SUB_TILE, sy * SUB_TILE, tx, ty, reach)));
        const desired = biting ? facing.target : travel;
        rotation += Math.max(-BODY_TURN_PER_MS, Math.min(BODY_TURN_PER_MS, delta(rotation, desired)));
        if (values) values[ms] = rotation;
      }
      // Combat keeps its existing target/arc controller; travel history must
      // not bias the first reversal after combat ownership changes.
      if (facing?.target != null) {
        history.canonical = null; history.goal = null; history.pending = null; history.qualified = null;
      }
      trails.set(id, { values, end: rotation, history });
    }
    return trails;
  }

  private build(ticks: readonly Tick[], at: number, full: boolean): Interval {
    const A = ticks[at]!, B = ticks[at + 1];
    const reach = gridScale(A.board.setup);
    const prior = at > 0 ? this.intervals.get(ticks[at - 1]!) : undefined;
    const previous = at > 0 && ticks[at - 1]!.tick + 1 === A.tick ? prior : undefined;
    const span = B ? (B.tick - A.tick) * TICK_MS : 0;
    const candidate = ticks[at + 2];
    const C = B && candidate?.tick === B.tick + 1 ? candidate : undefined;
    const pairs = new Map(A.engagements.map(p => [p.a, p]));
    const result: Interval = { trails: new Map(), facings: this.facing(A, B, C, prior, span, full, pairs), span, full };
    // Never infer motion across a missing message. A full snapshot resets the owner.
    if (span > TICK_MS) { this.intervals.set(A, result); return result; }
    const ground = this.ground(A.board.setup), water = ground.rects;
    for (let i = 0; i < A.ants.count; i++) {
      const id = A.ants.id[i]!, j = B?.index.get(id), z = C?.index.get(id);
      const ax = A.ants.x[i]! / SUB_TILE, ay = A.ants.y[i]! / SUB_TILE;
      const bx = j === undefined ? ax : B!.ants.x[j]! / SUB_TILE, by = j === undefined ? ay : B!.ants.y[j]! / SUB_TILE;
      const before = previous?.trails.get(id)?.end;
      let groundRouteUsed = false;
      if (!before && ax === bx && ay === by) continue; // Legacy stationary/combat-only frames need no travel filter.
      const ah = A.ants.heading[i]! / 256 * 2 * Math.PI;
      const bh = j === undefined ? ah : B!.ants.heading[j]! / 256 * 2 * Math.PI;
      const s: State = before ? { ...before } : { x: ax, y: ay, rotation: A.facing.get(id)?.rotation ?? ah, since: null, recovering: false };
      // A jump need only advance old state, not allocate every unsampled frame.
      // Retain dense samples for the reachable seek window; old intervals can
      // regenerate them from their cached predecessor if explicitly requested.
      const values = new Float64Array(full ? (span + 1) * 3 : 0), moving = new Uint8Array(full ? span + 1 : 0);
      let vx = z === undefined ? bx - ax : C!.ants.x[z]! / SUB_TILE - bx;
      let vy = z === undefined ? by - ay : C!.ants.y[z]! / SUB_TILE - by;
      if (distanceOf(vx, vy) < 1e-8) { vx = bx - ax; vy = by - ay; }
      const length = distanceOf(vx, vy), facing = A.facing.get(id);
      const pair = pairs.get(id), targetA = pair ? A.index.get(pair.b) : undefined, targetB = pair ? B?.index.get(pair.b) : undefined;
      if (full) values.set([s.x, s.y, s.rotation]);
      // If neither actor crosses an adjacency boundary, the confirmed bite
      // target and its eligibility are constant for this interval. Its capped
      // arc is exact in closed form too; retain the per-ms branch at boundaries.
      if (span > 0 && facing?.target != null && targetA !== undefined && targetB !== undefined && j !== undefined &&
        sameRoundedCell(A.ants.x[i]!, B!.ants.x[j]!) && sameRoundedCell(A.ants.y[i]!, B!.ants.y[j]!) &&
        sameRoundedCell(A.ants.x[targetA]!, B!.ants.x[targetB]!) && sameRoundedCell(A.ants.y[targetA]!, B!.ants.y[targetB]!) &&
        adjacentWithSlack(A.ants.x[i]!, A.ants.y[i]!, A.ants.x[targetA]!, A.ants.y[targetA]!, reach)) {
        const initial = s.rotation, dh = delta(initial, facing.target), moves = ax !== bx || ay !== by;
        if (full) for (let ms = 1; ms <= span; ms++) {
          values[ms * 3] = ax + (bx - ax) * ms / span; values[ms * 3 + 1] = ay + (by - ay) * ms / span;
          values[ms * 3 + 2] = initial + Math.sign(dh) * Math.min(Math.abs(dh), POSITION_STEER_PER_MS * ms);
          moving[ms] = moves ? 1 : 0;
        }
        s.x = bx; s.y = by; s.rotation = initial + Math.sign(dh) * Math.min(Math.abs(dh), POSITION_STEER_PER_MS * span);
        s.recovering = true; s.since = null;
        result.trails.set(id, { values, moving, end: s });
        continue;
      }
      // The common case catches the canonical point on every 1 ms step. Its
      // error is exactly the constant per-ms velocity, so the controller's
      // guide is constant too. Solve that branch analytically, without a
      // hundred atan2/exp calls per ant per tick (the large replay exercises it).
      const dx = bx - ax, dy = by - ay;
      const guideX = span ? dx / span + (length > 1e-8 ? vx / length * 0.2 : 0) : 0;
      const guideY = span ? dy / span + (length > 1e-8 ? vy / length * 0.2 : 0) : 0;
      const guide = distanceOf(guideX, guideY) > 1e-8 ? Math.atan2(guideY, guideX) : s.rotation;
      const motion = Math.atan2(dy, dx), distance = distanceOf(dx, dy);
      if (span > 0 && facing?.target == null && !s.recovering && distanceOf(s.x - ax, s.y - ay) < 1e-10 &&
        distance / span <= CATCHUP_PER_MS && (distance === 0 ||
          (Math.abs(delta(s.rotation, motion)) <= MOVE_CONE && Math.abs(delta(guide, motion)) <= MOVE_CONE)) &&
        visible(ax, ay, bx, by, water)) {
        const dh = delta(s.rotation, guide), initial = s.rotation;
        if (full) for (let ms = 1; ms <= span; ms++) {
          values[ms * 3] = ax + dx * ms / span; values[ms * 3 + 1] = ay + dy * ms / span;
          values[ms * 3 + 2] = initial + Math.sign(dh) * Math.min(Math.abs(dh), POSITION_STEER_PER_MS * ms);
          moving[ms] = distance > 1e-8 ? 1 : 0;
        }
        s.x = bx; s.y = by; s.rotation = initial + Math.sign(dh) * Math.min(Math.abs(dh), POSITION_STEER_PER_MS * span); s.since = null;
        result.trails.set(id, { values, moving, end: s });
        continue;
      }
      for (let ms = 1; ms <= span; ms++) {
        const time = A.tick * TICK_MS + ms, u = ms / span;
        const sx = ax + (bx - ax) * u, sy = ay + (by - ay) * u;
        const oldX = s.x, oldY = s.y;
        const groundBlocked = !visible(oldX, oldY, sx, sy, water);
        const targetX = targetA === undefined ? 0 : A.ants.x[targetA]! + ((targetB === undefined ? A.ants.x[targetA]! : B!.ants.x[targetB]!) - A.ants.x[targetA]!) * u;
        const targetY = targetA === undefined ? 0 : A.ants.y[targetA]! + ((targetB === undefined ? A.ants.y[targetA]! : B!.ants.y[targetB]!) - A.ants.y[targetA]!) * u;
        // Bites checks interpolated adjacency too. A tick-confirmed pair that
        // has already separated must not keep dragging an unbiting body backwards.
        const biting = pair !== undefined && (pair.terminalTick !== undefined || (targetA !== undefined &&
          adjacentWithSlack(sx * SUB_TILE, sy * SUB_TILE, targetX, targetY, reach)));
        if (facing?.target != null && biting) {
          // Legacy combat steering drives only the unchanged positional path.
          s.rotation = turn(s.rotation, facing.target); s.recovering = true;
          s.x = sx; s.y = sy; s.since = null;
        } else if (s.recovering) {
          const h = ah + delta(ah, bh) * u;
          s.rotation = turn(s.rotation, h);
          s.recovering = Math.abs(delta(s.rotation, h)) > 1e-9;
          // Once the bite has ended, recovery may not drag a backwards-facing
          // walking body along the canonical velocity. Resume the same gated
          // catch-up used by travel; confirmed bite geometry still owns its anchor.
          const dx = sx - s.x, dy = sy - s.y, distance = distanceOf(dx, dy);
          if (distance > 1e-8 && Math.abs(delta(s.rotation, Math.atan2(dy, dx))) <= MOVE_CONE) {
            const step = Math.min(CATCHUP_PER_MS, distance), x = s.x + dx / distance * step, y = s.y + dy / distance * step;
            if (visible(s.x, s.y, x, y, water)) { s.x = x; s.y = y; }
          }
          s.since = null;
        } else {
          let tx = sx, ty = sy;
          if (!visible(s.x, s.y, tx, ty, water)) {
            tx = s.x; ty = s.y;
            // Follow a visible recorded waypoint instead of cutting across water.
            for (let q = at; q >= Math.max(0, at - 8); q--) {
              const tick = ticks[q]!, p = tick.index.get(id);
              if (p === undefined) continue;
              const x = tick.ants.x[p]! / SUB_TILE, y = tick.ants.y[p]! / SUB_TILE;
              if (distanceOf(x - s.x, y - s.y) > 1e-8 && visible(s.x, s.y, x, y, water)) { tx = x; ty = y; break; }
            }
          }
          const ex = tx - s.x, ey = ty - s.y, distance = distanceOf(ex, ey);
          if (distanceOf(sx - s.x, sy - s.y) > EPS) s.since ??= time;
          else s.since = null;
          const age = s.since === null ? 0 : time - s.since;
          let gx = ex, gy = ey;
          if (age < 100 || distance <= 1e-8) {
            const anticipation = 0.2 * Math.exp(-age / 50), gain = 1 + age / 50;
            gx = ex * gain + (length > 1e-8 ? vx / length * anticipation : 0);
            gy = ey * gain + (length > 1e-8 ? vy / length * anticipation : 0);
          }
          // A retarget can bring the sim back across the drawn point within
          // this tick. Chasing the old positional error then turns the wrong
          // way for another half-circle. Anticipate that crossing instead;
          // the translation gate still forbids moving backwards.
          if (length > 1e-8 && distance <= length && ex * vx + ey * vy < 0) { gx = vx; gy = vy; }
          if (distanceOf(gx, gy) > 1e-8) s.rotation = turn(s.rotation, Math.atan2(gy, gx));
          if (distance > 1e-8 && Math.abs(delta(s.rotation, Math.atan2(ey, ex))) <= MOVE_CONE) {
            const step = Math.min(CATCHUP_PER_MS, distance);
            const x = s.x + ex / distance * step, y = s.y + ey / distance * step;
            if (visible(s.x, s.y, x, y, water)) { s.x = x; s.y = y; }
          }
          if (distanceOf(sx - s.x, sy - s.y) <= EPS) s.since = null;
        }
        // Leave the ordinary steering/gates intact. Only a blocked terrain chord
        // takes a legal corner route; facing and the internal steering angle do not.
        if (groundBlocked) {
          const route = ground.route([oldX, oldY], [sx, sy]);
          const next = route ? groundPoint(route, Math.min(CATCHUP_PER_MS, route.length)) : [oldX, oldY];
          s.x = next[0]!; s.y = next[1]!; s.since = null;
          groundRouteUsed ||= route !== null;
        }
        if (full) {
          values[ms * 3] = s.x; values[ms * 3 + 1] = s.y; values[ms * 3 + 2] = s.rotation;
          moving[ms] = distanceOf(s.x - oldX, s.y - oldY) > 1e-8 ? 1 : 0;
        }
      }
      result.trails.set(id, { values, moving, end: s, ground: groundRouteUsed });
    }
    // A held newest tick can later acquire its next message. Do not freeze an
    // empty interval and thereby discard that newly available travel forever.
    if (B) this.intervals.set(A, result);
    return result;
  }

  sample(ticks: readonly Tick[], at: number, time: number, frame: TravelFrame): void {
    const interval = this.prepare(ticks, at);
    if (!frame.drawX || frame.drawX.length < frame.id.length) {
      frame.drawX = new Float64Array(frame.id.length); frame.drawY = new Float64Array(frame.id.length);
    }
    const age = Math.min(interval.span, Math.max(0, time - ticks[at]!.tick * TICK_MS));
    const lo = Math.floor(age), hi = Math.min(interval.span, lo + 1), u = age - lo;
    for (let i = 0; i < frame.count; i++) {
      const id = frame.id[i]!, trail = interval.trails.get(id), facing = interval.facings.get(id)!;
      frame.drawRotation![i] = facing.values
        ? facing.values[lo]! + (facing.values[hi]! - facing.values[lo]!) * u : facing.end;
      frame.drawX[i] = frame.x[i]!; frame.drawY![i] = frame.y[i]!;
      if (!trail) continue;
      const v = trail.values;
      frame.drawX[i] = v[lo * 3]! + (v[hi * 3]! - v[lo * 3]!) * u;
      frame.drawY![i] = v[lo * 3 + 1]! + (v[hi * 3 + 1]! - v[lo * 3 + 1]!) * u;
      // Linear interpolation between dry 1 ms anchors can still re-cut a corner.
      if (trail.ground) {
        const ground = this.ground(ticks[at]!.board.setup);
        const a: Point = [v[lo * 3]!, v[lo * 3 + 1]!], b: Point = [v[hi * 3]!, v[hi * 3 + 1]!];
        if (!ground.clear(a, b)) {
          const route = ground.route(a, b), next = route ? groundPoint(route, route.length * u) : a;
          frame.drawX[i] = next[0]; frame.drawY![i] = next[1];
        }
      }
      frame.walk[i] = trail.moving[hi] ? (Math.floor(time / 90) + frame.id[i]!) % 3 : 0;
    }
  }
}
