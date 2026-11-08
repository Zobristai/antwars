import { SUB, speedPerTick } from './config.js';
import { direction, velocity, withinTiles, type Vec } from './geometry.js';
import { segmentOnLand } from './terrain.js';
import type { PatrolChains } from './patrol.js';
import type { Ant, Mark, SimState } from './types.js';

interface Area { readonly x: number; readonly y: number; readonly radius: number }
interface Point extends Vec {
  readonly id: number; readonly soldier: boolean; readonly colony: number;
  /** Whether settledLocal and pointRests hold this ant, read once instead of per neighbour pair. */
  readonly local: boolean; readonly rest: boolean;
}
export interface SoftMetrics {
  antTicks: number; pushedAntTicks: number; increasedNativeDisplacement: number;
  exceededNativeSpeed: number; maxAddedDisplacement: number; maxTotalDisplacement: number;
  maxCorrection: number; neighbourChecks: number;
}
export interface SoftObservation { readonly colonies: readonly SoftMetrics[] }
function area(state: SimState, ant: Ant, mark: Mark | undefined, chains?: PatrolChains): Area | undefined {
  if (state.config.softSeparation === undefined || ant.caste !== 'soldier' || mark === undefined) return undefined;
  const lonePatrol = state.config.patrolLinkTiles !== undefined && mark.verb === 'PATROL'
    && chains?.get(mark.id)?.chain.length === 1;
  if (mark.verb !== 'DEFEND' && mark.verb !== 'ATTACK' && !lonePatrol) return undefined;
  return { x: mark.tileX * SUB + SUB / 2, y: mark.tileY * SUB + SUB / 2,
    radius: mark.verb === 'DEFEND' || lonePatrol ? state.config.countMarks!.defendTiles : state.config.attackRadiusTiles };
}
function contains(p: Vec, target: Area): boolean {
  return withinTiles(Math.floor(p.x / SUB), Math.floor(p.y / SUB), Math.floor(target.x / SUB), Math.floor(target.y / SUB), target.radius);
}
function cappedStep(delta: Vec, maximum: number): Vec {
  const length = Math.hypot(delta.x, delta.y), scale = length > maximum ? maximum / length : 1;
  return { x: Math.trunc(delta.x * scale), y: Math.trunc(delta.y * scale) };
}
function endpoint(state: SimState, p: Vec, delta: Vec): Vec {
  return { x: Math.max(0, Math.min(state.config.mapWidth * SUB - 1, p.x + delta.x)),
    y: Math.max(0, Math.min(state.config.mapHeight * SUB - 1, p.y + delta.y)) };
}
/** A local order boundary, never a reserved destination or an ant-body veto. */
export function softMarkHeading(state: SimState, ant: Ant, mark: Mark, heading: Vec, chains?: PatrolChains): Vec {
  const target = area(state, ant, mark, chains); if (target === undefined) return heading;
  const inward = direction(target.x - ant.x, target.y - ant.y);
  if (!contains(ant, target)) return inward;
  const next = endpoint(state, ant, velocity(heading, speedPerTick(state.config)));
  return contains(next, target) ? heading : inward;
}
interface CellTables {
  full: (Point[] | undefined)[]; soldier: (Point[] | undefined)[]; worker: (Point[] | undefined)[];
  readonly touched: number[]; readonly fineTouched: number[];
}
const tables: CellTables = { full: [], soldier: [], worker: [], touched: [], fineTouched: [] };
/** The shared cell tables, sized for these cell counts and holding no bucket. */
function cellTables(cells: number, fineCells: number): CellTables {
  if (tables.full.length !== cells) { tables.full = new Array(cells); tables.soldier = new Array(cells); tables.touched.length = 0; }
  if (tables.worker.length !== fineCells) { tables.worker = new Array(fineCells); tables.fineTouched.length = 0; }
  for (const key of tables.touched) { tables.full[key] = undefined; tables.soldier[key] = undefined; }
  for (const key of tables.fineTouched) tables.worker[key] = undefined;
  tables.touched.length = 0; tables.fineTouched.length = 0;
  return tables;
}
/** Jacobi update: all ants read one immutable local snapshot, then move together.
 * No ant is a solid obstacle. Current settled guards hold their posts; other
 * pushes are constrained only by static terrain and the ant's own mark area.
 */
/** origins: each ant's origin by id, or by its place in state.ants. */
export function applySoftSeparation(state: SimState, origins: ReadonlyMap<number, Vec> | readonly Vec[], settledGuards: ReadonlySet<number> = new Set(), chains?: PatrolChains, pointRests: ReadonlyMap<number, Vec> = new Map(), settledLocal: ReadonlySet<number> = new Set(), observe = true,
  /** Every ant reached its current position from its origin by a step that passed the land test this tick. */
  nativeChecked = false): SoftObservation {
  const rules = state.config.softSeparation!;
  // Each ant's own point, origin and result are held by its place in state.ants (ids are unique), not looked up by id.
  const ants = state.ants;
  const originOf: readonly Vec[] = origins instanceof Map ? ants.map(a => origins.get(a.id)!) : origins as readonly Vec[];
  const own: Point[] = ants.map(a => ({ id: a.id, x: a.x, y: a.y, soldier: a.caste === "soldier", colony: a.colony,
    local: settledLocal.has(a.id), rest: pointRests.has(a.id) }));
  const points = own.slice().sort((a, b) => a.id - b.id);
  const cell = Math.max(rules.radius, rules.soldierRadius ?? rules.radius);
  // One number per cell: on-map cells and their neighbours, -1 up to one past the last row or column, are distinct.
  const stride = Math.floor((state.config.mapHeight * SUB - 1) / cell) + 3;
  // A worker's neighbours inside rules.radius are found from cells that wide; soldiers, whose reach can be
  // the larger radius, from the full cells. Both keep every bucket in id order, as buckets does.
  const fineCell = rules.radius, fineStride = Math.floor((state.config.mapHeight * SUB - 1) / fineCell) + 3;
  // Both cell kinds are arrays indexed by that number.
  const cells = (Math.floor((state.config.mapWidth * SUB - 1) / cell) + 3) * stride;
  // The cell tables are kept between calls and emptied of the last call's cells first, so they hold exactly this call's buckets.
  const fineCells = fineCell > 0 ? (Math.floor((state.config.mapWidth * SUB - 1) / fineCell) + 3) * fineStride : 0;
  const scratch = cellTables(cells, fineCells);
  const buckets = scratch.full, soldierBuckets = scratch.soldier, workerBuckets = scratch.worker, touched = scratch.touched, fineTouched = scratch.fineTouched;
  for (const p of points) {
    const key = (Math.floor(p.x / cell) + 1) * stride + Math.floor(p.y / cell) + 1;
    const bucket = buckets[key]; if (bucket === undefined) { buckets[key] = [p]; touched.push(key); } else bucket.push(p);
    if (!(fineCell > 0)) continue;
    if (p.soldier) { const list = soldierBuckets[key]; if (list === undefined) soldierBuckets[key] = [p]; else list.push(p); continue; }
    const at = (Math.floor(p.x / fineCell) + 1) * fineStride + Math.floor(p.y / fineCell) + 1;
    const list = workerBuckets[at]; if (list === undefined) { workerBuckets[at] = [p]; fineTouched.push(at); } else list.push(p);
  }
  // A worker's neighbours in reach, as parallel columns (no object per pair); nearIdx orders them by nearOrder.
  const nearOrder: number[] = [], nearOther: Point[] = [], nearDx: number[] = [], nearDy: number[] = [], nearD: number[] = [], nearR: number[] = [], nearIdx: number[] = [];
  let nearCount = 0;
  const marks = new Map(state.marks.map(m => [m.id, m]));
  const next: Vec[] = new Array(ants.length);
  const colonies = [0, 1].map((): SoftMetrics => ({ antTicks: 0, pushedAntTicks: 0,
    increasedNativeDisplacement: 0, exceededNativeSpeed: 0, maxAddedDisplacement: 0,
    maxTotalDisplacement: 0, maxCorrection: 0, neighbourChecks: 0 }));
  for (let i = 0; i < ants.length; i++) {
    const ant = ants[i]!, p = own[i]!, metrics = colonies[ant.colony]!;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    let fx = 0, fy = 0, count = 0;
    if (!p.rest && fineCell > 0 && !p.soldier) {
      // The same neighbours in the same order as the full scan below: each one in reach is ordered by
      // its full cell's place in that scan, then by id, before its push is added.
      if (observe) {
        let checks = -1;
        for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) checks += buckets[(x + 1) * stride + y + 1]?.length ?? 0;
        metrics.neighbourChecks += checks;
      }
      nearCount = 0;
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        const bucket = soldierBuckets[(x + 1) * stride + y + 1]; if (bucket === undefined) continue;
        for (const other of bucket) {
          const dx = p.x - other.x, dy = p.y - other.y;
          const small = p.local || (p.colony === other.colony && (other.local || (rules.restPass === true && other.rest)));
          const radius = !small ? rules.soldierRadius ?? rules.radius : rules.radius;
          // Farther than radius + 1 (squared) is out of reach before Math.hypot is needed: hypot is then above radius.
          if (dx * dx + dy * dy > (radius + 1) * (radius + 1)) continue;
          const d = Math.hypot(dx, dy);
          if (d > radius) continue;
          nearOrder[nearCount] = ((y - cy + 1) * 3 + x - cx + 1) * 2 ** 32 + other.id; nearOther[nearCount] = other;
          nearDx[nearCount] = dx; nearDy[nearCount] = dy; nearD[nearCount] = d; nearR[nearCount] = radius; nearCount++;
        }
      }
      const gx = Math.floor(p.x / fineCell), gy = Math.floor(p.y / fineCell);
      for (let y = gy - 1; y <= gy + 1; y++) for (let x = gx - 1; x <= gx + 1; x++) {
        const bucket = workerBuckets[(x + 1) * fineStride + y + 1]; if (bucket === undefined) continue;
        for (const other of bucket) {
          if (other.id === p.id) continue;
          const dx = p.x - other.x, dy = p.y - other.y;
          if (dx * dx + dy * dy > (rules.radius + 1) * (rules.radius + 1)) continue;
          const d = Math.hypot(dx, dy);
          if (d > rules.radius) continue;
          const at = (Math.floor(other.y / cell) - cy + 1) * 3 + Math.floor(other.x / cell) - cx + 1;
          nearOrder[nearCount] = at * 2 ** 32 + other.id; nearOther[nearCount] = other;
          nearDx[nearCount] = dx; nearDy[nearCount] = dy; nearD[nearCount] = d; nearR[nearCount] = rules.radius; nearCount++;
        }
      }
      // Insertion sort by order; every order is distinct (a cell place and a unique id), so this is the order sort gives.
      for (let k = 0; k < nearCount; k++) {
        const key = nearOrder[k]!;
        let j = k;
        while (j > 0 && nearOrder[nearIdx[j - 1]!]! > key) { nearIdx[j] = nearIdx[j - 1]!; j--; }
        nearIdx[j] = k;
      }
      for (let k = 0; k < nearCount; k++) {
        const n = nearIdx[k]!, other = nearOther[n]!, dx = nearDx[n]!, dy = nearDy[n]!, d = nearD[n]!, radius = nearR[n]!;
        count++;
        if (d === 0) {
          const sign = p.id < other.id ? -1 : 1;
          const lo = Math.min(p.id, other.id), hi = Math.max(p.id, other.id);
          const parity = (Math.imul(lo ^ 0x9e3779b9, hi | 1) >>> 0) & 1 ? 1 : -1;
          fx += sign * Math.SQRT1_2; fy += sign * parity * Math.SQRT1_2;
        } else {
          const weight = Math.max(rules.epsilon, radius - d) / radius;
          fx += weight * dx / d; fy += weight * dy / d;
        }
      }
    } else if (!p.rest) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const bucket = buckets[(x + 1) * stride + y + 1]; if (bucket === undefined) continue;
      for (const other of bucket) {
        if (other.id === p.id) continue;
        metrics.neighbourChecks++;
        const dx = p.x - other.x, dy = p.y - other.y;
        // A settled local guard, and a same-colony worker meeting one, use the small radius:
        // guards stop shoving each other and carriers can still reach the nest.
        // So does a worker meeting its own colony's point-resting soldier, so the fixed rest
        // does not hold a passing forager at the soldier-radius edge.
        const small = p.local || (!p.soldier && p.colony === other.colony && (other.local
          || (rules.restPass === true && other.soldier && other.rest)));
        const radius = !small && (p.soldier || other.soldier) ? rules.soldierRadius ?? rules.radius : rules.radius;
        if (dx * dx + dy * dy > (radius + 1) * (radius + 1)) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        count++;
        if (d === 0) {
          const sign = p.id < other.id ? -1 : 1;
          const lo = Math.min(p.id, other.id), hi = Math.max(p.id, other.id);
          const parity = (Math.imul(lo ^ 0x9e3779b9, hi | 1) >>> 0) & 1 ? 1 : -1;
          fx += sign * Math.SQRT1_2; fy += sign * parity * Math.SQRT1_2;
        } else {
          const weight = Math.max(rules.epsilon, radius - d) / radius;
          fx += weight * dx / d; fy += weight * dy / d;
        }
      }
    }
    const scale = count === 0 ? 0 : rules.strength / count;
    const origin = originOf[i]!;
    const combined = cappedStep({ x: p.x - origin.x + fx * scale, y: p.y - origin.y + fy * scale }, p.rest ? Math.min(rules.maxStep, speedPerTick(state.config)) : rules.maxStep);
    // A guard at its current post stays put, but remains in the local snapshot:
    // travelers still spread around it and can pass through, never body-vetoed.
    let candidate = !p.rest && settledGuards.has(ant.id) ? origin : endpoint(state, origin, combined);
    const target = p.rest ? undefined : area(state, ant, ant.claim === undefined ? undefined : marks.get(ant.claim), chains);
    if (target !== undefined && contains(origin, target) && !contains(candidate, target)) {
      const inward = cappedStep(velocity(direction(target.x - origin.x, target.y - origin.y), rules.maxStep), rules.maxStep);
      candidate = endpoint(state, origin, inward);
      if (!contains(candidate, target)) candidate = origin;
    }
    // An unpushed ant keeps its own step, which already passed this test (or stayed at its origin, the fallback).
    if (!(nativeChecked && candidate.x === p.x && candidate.y === p.y) &&
        !segmentOnLand(state.config, state.terrain, origin.x, origin.y, candidate.x, candidate.y)) candidate = origin;
    if ((candidate.x - origin.x) ** 2 + (candidate.y - origin.y) ** 2 > rules.maxStep ** 2) throw new Error('Combined soft step exceeded cap');
    next[i] = candidate;
    // Metrics only: the tick's own call does not read them.
    if (!observe) continue;
    const native = Math.hypot(p.x - origin.x, p.y - origin.y);
    const total = Math.hypot(candidate.x - origin.x, candidate.y - origin.y);
    const correction = Math.hypot(candidate.x - p.x, candidate.y - p.y);
    metrics.antTicks++;
    if (correction > 0) metrics.pushedAntTicks++;
    if (total > native + 1e-9) metrics.increasedNativeDisplacement++;
    if (total > speedPerTick(state.config) + 1) metrics.exceededNativeSpeed++;
    metrics.maxAddedDisplacement = Math.max(metrics.maxAddedDisplacement, total - native);
    metrics.maxTotalDisplacement = Math.max(metrics.maxTotalDisplacement, total);
    metrics.maxCorrection = Math.max(metrics.maxCorrection, correction);
  }
  for (let i = 0; i < ants.length; i++) {
    const ant = ants[i]!, p = next[i]!, origin = originOf[i]!;
    ant.x = p.x; ant.y = p.y; ant.vx = p.x - origin.x; ant.vy = p.y - origin.y;
  }
  return { colonies };
}
