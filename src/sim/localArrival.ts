import { SUB } from './config.js';
import { adjacentEnemyQueen } from './combat.js';
import { gridScaleOf, resourceCellIndex } from './gridScale.js';
import { forEachNear, gridBuckets, type Grid } from './map.js';
import { segmentOnLand } from './terrain.js';
import type { Ant, Mark, SimState } from './types.js';
export type GoalKind = 'point' | 'food' | 'home' | 'fallback' | 'guard' | 'mark' | 'combat';
export interface LocalGoal {
  readonly key: string; readonly nativeReached: boolean; readonly kind?: GoalKind;
  readonly x?: number; readonly y?: number; readonly targetId?: number;
  readonly guardPost?: true;
  /** A linked patrol visits this waypoint; it does not hold a resting site there. */
  readonly passingThrough?: true;
}
export interface LocalArrival {
  readonly key: string; readonly arrived: boolean; readonly native: boolean;
  readonly rootId: number | null; readonly parentId: number | null; readonly hops: number | null;
}
/** A frame-scoped intent collector. Entries are current native choices, not assignments.
 * Each state's collector is explicitly begun and consumed in one step; no arrival history exists.
 */
const frames = new WeakMap<SimState, Map<number, LocalGoal>>();
/** The state last looked up and its frame (undefined for none): a tick's many notes read the WeakMap once. */
let lastState: SimState | undefined, lastFrame: Map<number, LocalGoal> | undefined;
function frameOf(state: SimState): Map<number, LocalGoal> | undefined {
  if (state !== lastState) { lastState = state; lastFrame = frames.get(state); }
  return lastFrame;
}
export function beginLocalGoals(state: SimState): void { const frame = new Map<number, LocalGoal>(); frames.set(state, frame); lastState = state; lastFrame = frame; }
export function readLocalGoal(state: SimState, ant: Ant): LocalGoal | undefined { return frameOf(state)?.get(ant.id); }
export function clearLocalGoal(state: SimState, ant: Ant): void { frameOf(state)?.delete(ant.id); }
export function currentLocalGoals(state: SimState): ReadonlyMap<number, LocalGoal> { return frameOf(state) ?? new Map(); }
export function takeLocalGoals(state: SimState): Map<number, LocalGoal> {
  const result = frames.get(state); frames.delete(state);
  if (lastState === state) { lastState = undefined; lastFrame = undefined; }
  return result ?? new Map();
}
/**
 * Goal keys by a number standing for (colony, coordinates or id), so the goals a tick repeats reuse one
 * string instead of building it each time; the strings are the ones the template would build. Only whole
 * non-negative values below 2^21 are cached; each cache is emptied once it holds 2^16 keys.
 */
const KEY_RANGE = 2 ** 21, KEY_LIMIT = 2 ** 16;
const pointKeys = new Map<number, string>(), holdKeys = new Map<number, string>(), foodKeys = new Map<number, string>();
const homeKeys = new Map<number, string>(), fallbackKeys = new Map<number, string>();
function cacheable(value: number): boolean { return Number.isInteger(value) && value >= 0 && value < KEY_RANGE; }
function cachedKey(cache: Map<number, string>, slot: number, key: () => string): string {
  let found = cache.get(slot);
  if (found === undefined) {
    if (cache.size >= KEY_LIMIT) cache.clear();
    found = key();
    cache.set(slot, found);
  }
  return found;
}
function pairKey(cache: Map<number, string>, colony: number, a: number, b: number, key: () => string): string {
  return (colony === 0 || colony === 1) && cacheable(a) && cacheable(b) ? cachedKey(cache, (colony * KEY_RANGE + b) * KEY_RANGE + a, key) : key();
}
function idKey(cache: Map<number, string>, colony: number, id: number, key: () => string): string {
  return (colony === 0 || colony === 1) && cacheable(id) ? cachedKey(cache, colony * KEY_RANGE + id, key) : key();
}
function record(state: SimState, ant: Ant, goal: LocalGoal): void { frameOf(state)?.set(ant.id, goal); }
export function notePoint(state: SimState, ant: Ant, x: number, y: number, force = false): void {
  if (frameOf(state) === undefined) return;
  const old = readLocalGoal(state, ant);
  if (!force && old?.x === x && old.y === y) return;
  record(state, ant, { key: pairKey(pointKeys, ant.colony, x, y, () => `${ant.colony}/point/${x},${y}`), kind: 'point', x, y,
    nativeReached: (ant.x - x) ** 2 + (ant.y - y) ** 2 <= state.config.softSeparation!.arrivalSubunits ** 2 });
}
/** Food occupies an original physical cell; a finer obstacle still vetoes reaching across it. */
export function foodWithinReach(state: SimState, ant: Ant, tile: number): boolean {
  const width = state.config.mapWidth;
  const occupied = Math.floor(ant.y / SUB) * width + Math.floor(ant.x / SUB);
  if (resourceCellIndex(state.config, occupied) !== resourceCellIndex(state.config, tile)) return false;
  return segmentOnLand(state.config, state.terrain,
    ant.x, ant.y, (tile % width + 0.5) * SUB, (Math.floor(tile / width) + 0.5) * SUB);
}
/** Tag only the selected house post, after routing has recorded its actual point goal. */
export function noteGuardPost(state: SimState, ant: Ant): void {
  const goal = readLocalGoal(state, ant);
  if (goal?.kind === 'point') record(state, ant, { ...goal, guardPost: true });
}
/** reached: foodWithinReach(state, ant, tile), when the caller has it already. */
export function noteFood(state: SimState, ant: Ant, tile: number, reached?: boolean): void {
  if (frameOf(state) === undefined) return;
  const tx = tile % state.config.mapWidth, ty = Math.floor(tile / state.config.mapWidth);
  const cell = resourceCellIndex(state.config, tile);
  record(state, ant, { key: idKey(foodKeys, ant.colony, cell, () => `${ant.colony}/food/${cell}`), kind: 'food', targetId: tile,
    x: tx * SUB + SUB / 2, y: ty * SUB + SUB / 2,
    nativeReached: reached ?? foodWithinReach(state, ant, tile) });
}
export function noteHome(state: SimState, ant: Ant, id: number, x: number, y: number): void {
  if (frameOf(state) === undefined) return;
  const kind = ant.carrying ? 'home' : 'fallback';
  const dx = Math.abs(Math.floor(ant.x / SUB) - Math.floor(x / SUB));
  const dy = Math.abs(Math.floor(ant.y / SUB) - Math.floor(y / SUB));
  record(state, ant, { key: idKey(kind === 'home' ? homeKeys : fallbackKeys, ant.colony, id, () => `${ant.colony}/${kind}/${id}`), kind, targetId: id, x, y,
    nativeReached: ant.carrying ? Math.max(dx, dy) <= state.config.nestDeliverTiles
      : (ant.x - x) ** 2 + (ant.y - y) ** 2 <= state.config.softSeparation!.arrivalSubunits ** 2 });
}
/** hold: an arrived rules-25 worker guard is held at its post like a selected house guard post. */
export function noteGuard(state: SimState, ant: Ant, id: number, x: number, y: number, nativeReached: boolean, hold = false): void {
  record(state, ant, { key: `${ant.colony}/guard/${id}`, kind: 'guard', targetId: id, x, y, nativeReached, ...(hold ? { guardPost: true as const } : {}) });
}
/** Rules 27: a free seated soldier holding at its own hold point settles like a local queen guard, clustered per hold tile. */
export function noteHoldPoint(state: SimState, ant: Ant, tileX: number, tileY: number, x: number, y: number, nativeReached: boolean): void {
  record(state, ant, { key: pairKey(holdKeys, ant.colony, tileX, tileY, () => `${ant.colony}/hold/${tileX},${tileY}`), kind: 'guard', x, y, nativeReached });
}
export function noteCombat(state: SimState, ant: Ant, enemy: Ant, reached: boolean): void {
  record(state, ant, { key: `${ant.colony}/combat/${enemy.id}`, kind: 'combat', targetId: enemy.id,
    x: enemy.x, y: enemy.y, nativeReached: reached });
}
/** Point resting must not pull an ant out of a live queen bite. Historical movement is unchanged. */
export function noteQueenContact(state: SimState, ant: Ant): boolean {
  const { config } = state;
  if (frameOf(state) === undefined || config.pointArrival === undefined ||
      config.queenHp === undefined || state.tick < config.combatGraceTicks || state.tick < config.queenHp.shieldTicks) return false;
  const queen = adjacentEnemyQueen(state, ant);
  if (queen === null) return false;
  record(state, ant, { key: `${ant.colony}/combat/queen/${queen.id}`, kind: 'combat', targetId: queen.id,
    x: queen.queenX, y: queen.queenY, nativeReached: true });
  return true;
}
const contactMemo = new WeakMap<Grid, Map<number, Ant | null>>();
/** The weakest live enemy of colony within reach of tile (tx, ty), ties to the lower id; the pick no visiting order changes. */
function weakestEnemyNear(state: SimState, grid: Grid, colony: number, tx: number, ty: number, reach: number): Ant | null {
  let best: Ant | null = null;
  const dense = gridBuckets(grid);
  if (dense === undefined) {
    forEachNear(state, grid, tx, ty, reach, (other) => {
      if (other.colony === colony || !(other.hp > 0)) return;
      if (best === null || other.hp < best.hp || (other.hp === best.hp && other.id < best.id)) best = other;
    });
    return best;
  }
  const { mapWidth, mapHeight } = state.config;
  const x0 = Math.max(0, tx - reach), x1 = Math.min(mapWidth - 1, tx + reach), y1 = Math.min(mapHeight - 1, ty + reach);
  for (let y = Math.max(0, ty - reach); y <= y1; y += 1) {
    const row = y * mapWidth;
    for (let x = x0; x <= x1; x += 1) {
      const bucket = dense[row + x];
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        const other = bucket[i]!;
        if (other.colony === colony || !(other.hp > 0)) continue;
        if (best === null || other.hp < best.hp || (other.hp === best.hp && other.id < best.id)) best = other;
      }
    }
  }
  return best;
}
/** grid, when given: the neighbour grid of the ants' current tiles, searched instead of every ant (same pick). */
export function noteContact(state: SimState, ant: Ant, grid?: Grid): boolean {
  if (frameOf(state) === undefined) return false;
  const tx = Math.floor(ant.x / SUB), ty = Math.floor(ant.y / SUB);
  const reach = gridScaleOf(state.config);
  if (grid !== undefined) {
    // Ants of one colony on one tile pick the same enemy, and no position or HP changes while one grid is current.
    let memo = contactMemo.get(grid);
    if (memo === undefined) { memo = new Map(); contactMemo.set(grid, memo); }
    const key = (ty * state.config.mapWidth + tx) * 2 + ant.colony;
    let best = memo.get(key);
    if (best === undefined) { best = weakestEnemyNear(state, grid, ant.colony, tx, ty, reach); memo.set(key, best); }
    if (best === null) return false;
    noteCombat(state, ant, best, true); return true;
  }
  const adjacent = state.ants.filter(other => other.colony !== ant.colony && other.hp > 0
    && Math.abs(Math.floor(other.x / SUB) - tx) <= reach && Math.abs(Math.floor(other.y / SUB) - ty) <= reach)
    .sort((a, b) => a.hp - b.hp || a.id - b.id)[0];
  if (adjacent === undefined) return false;
  noteCombat(state, ant, adjacent, true); return true;
}
/** spot: a LINE mark's own standing point for this ant, recorded in place of the mark tile. */
export function noteMark(state: SimState, ant: Ant, mark: Mark, spot?: { readonly x: number; readonly y: number }): void {
  if (frameOf(state) === undefined || mark.verb === 'FORAGE') return;
  const old = readLocalGoal(state, ant), prefix = `${ant.colony}/mark/${mark.id}/${mark.verb}/${mark.tileX},${mark.tileY}${spot === undefined ? '' : `/${spot.x},${spot.y}`}`;
  const dx = Math.floor(ant.x / SUB) - mark.tileX, dy = Math.floor(ant.y / SUB) - mark.tileY;
  const radius = mark.verb === 'DEFEND' ? state.config.countMarks!.defendTiles : state.config.attackRadiusTiles;
  const returningToArea = ant.caste === 'soldier' && (mark.verb === 'DEFEND' || mark.verb === 'ATTACK') && dx * dx + dy * dy > radius ** 2;
  if (old?.kind === 'combat' && !returningToArea) { record(state, ant, { ...old, key: `${prefix}/${old.key}` }); return; }
  const x = spot?.x ?? mark.tileX * SUB + SUB / 2, y = spot?.y ?? mark.tileY * SUB + SUB / 2;
  record(state, ant, { key: prefix, kind: 'mark', targetId: mark.id, x, y,
    ...(mark.verb === 'PATROL' ? { passingThrough: true as const } : {}),
    nativeReached: (ant.x - x) ** 2 + (ant.y - y) ** 2 <= state.config.softSeparation!.arrivalSubunits ** 2 });
}
/** One number per link cell, distinct for every cell from (-1, -1) up to 2^17 - 2 on each axis. */
function cellKey(cx: number, cy: number): number { return (cx + 1) * 131_072 + cy + 1; }
/** Fresh reachability in the same-goal local contact graph. No previous flags are inputs.
 * Root/parent/hop values are witnesses of a current chain, never assigned positions.
 */
export function clusterArrivals(ants: readonly Ant[], goals: ReadonlyMap<number, LocalGoal>, radius: number): Map<number, LocalArrival> {
  const ordered = [...ants].sort((a, b) => a.id - b.id), buckets = new Map<number, Ant[]>();
  const result = new Map<number, LocalArrival>(), queue: Ant[] = [];
  for (const ant of ordered) {
    const goal = goals.get(ant.id); if (goal === undefined) continue;
    result.set(ant.id, { key: goal.key, arrived: goal.nativeReached, native: goal.nativeReached,
      rootId: goal.nativeReached ? ant.id : null, parentId: null, hops: goal.nativeReached ? 0 : null });
    if (goal.nativeReached) { queue.push(ant); continue; }
    // Only an ant with a goal not yet reached can be linked below, so only those are bucketed (still in id order).
    const key = cellKey(Math.floor(ant.x / radius), Math.floor(ant.y / radius));
    const bucket = buckets.get(key); if (bucket === undefined) buckets.set(key, [ant]); else bucket.push(ant);
  }
  for (let at = 0; at < queue.length; at++) {
    const ant = queue[at]!, own = result.get(ant.id)!;
    const cx = Math.floor(ant.x / radius), cy = Math.floor(ant.y / radius), reach = radius ** 2;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const bucket = buckets.get(cellKey(x, y));
      if (bucket === undefined) continue;
      for (const other of bucket) {
        // The same tests as before, cheapest first; none has a side effect.
        if (other.colony !== ant.colony || (other.x - ant.x) ** 2 + (other.y - ant.y) ** 2 > reach) continue;
        const candidate = result.get(other.id);
        if (candidate === undefined || candidate.arrived || candidate.key !== own.key) continue;
        result.set(other.id, { ...candidate, arrived: true, rootId: own.rootId, parentId: ant.id, hops: own.hops! + 1 });
        queue.push(other);
      }
    }
  }
  return result;
}
