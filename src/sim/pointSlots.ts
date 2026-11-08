import { SUB, type SimConfig, type PointArrivalRules } from './config.js';
import { passableMask } from './terrain.js';
import { withinTiles, type Vec } from './geometry.js';
import type { LocalGoal } from './localArrival.js';
import type { Ant, SimState } from './types.js';

export interface Topology { readonly component: Int32Array; readonly land: readonly boolean[] }
const topologies = new WeakMap<SimConfig, Map<SimState['terrain'], Topology>>();
const layouts = new WeakMap<SimConfig, Map<string, readonly Vec[]>>();
/** Read-only static connectivity, including the navigation system's no-corner-cut rule. */
function topology(state: SimState): Topology {
  let cache = topologies.get(state.config);
  if (cache === undefined) { cache = new Map(); topologies.set(state.config, cache); }
  const old = cache.get(state.terrain); if (old !== undefined) return old;
  const { mapWidth: w, mapHeight: h } = state.config;
  const land = state.terrain === undefined ? Object.freeze(new Array<boolean>(w * h).fill(true))
    : passableMask(state.config, state.terrain);
  const component = new Int32Array(w * h).fill(-1), queue = new Int32Array(w * h);
  let id = 0;
  for (let root = 0; root < component.length; root++) {
    if (!land[root] || component[root] !== -1) continue;
    let first = 0, last = 1; queue[0] = root; component[root] = id;
    while (first < last) {
      const at = queue[first++]!, x = at % w, y = Math.floor(at / w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !land[next] || component[next] !== -1 ||
          (dx !== 0 && dy !== 0 && (!land[y * w + nx] || !land[ny * w + x]))) continue;
        component[next] = id; queue[last++] = next;
      }
    }
    id++;
  }
  const result = { land, component }; cache.set(state.terrain, result); return result;
}
/** The same static land and connectivity the resting layout uses (LINE spots reuse it). */
export function pointRestTopology(state: SimState): Topology { return topology(state); }
function hash(seed: number, a: number, b: number): number {
  let n = seed ^ Math.imul(a, 0x9e3779b9) ^ Math.imul(b, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d); n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
function unit(seed: number, a: number, b: number): number { return hash(seed, a, b) / 0x100000000; }
class SiteIndex {
  private readonly cells = new Map<number, Vec[]>();
  private readonly size: number;
  private readonly stride: number;
  constructor(size: number, width: number) {
    this.size = size;
    // Leave a column on either side for neighbouring-cell lookups at map edges.
    this.stride = Math.ceil(width / size) + 2;
  }
  hasNear(p: Vec): boolean {
    const cx = Math.floor(p.x / this.size), cy = Math.floor(p.y / this.size);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const cell = this.cells.get(x + y * this.stride);
      if (cell === undefined) continue;
      for (const q of cell) if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 < this.size ** 2) return true;
    }
    return false;
  }
  add(p: Vec): void {
    const key = Math.floor(p.x / this.size) + Math.floor(p.y / this.size) * this.stride;
    const cell = this.cells.get(key); if (cell === undefined) this.cells.set(key, [p]); else cell.push(p);
  }
}
/** Generate an exact distance-ordered prefix of the same seeded organic layout. */
function candidates(state: SimState, anchor: Vec, colony: number, rules: PointArrivalRules, reach: number): readonly Vec[] {
  let cache = layouts.get(state.config);
  if (cache === undefined) { cache = new Map(); layouts.set(state.config, cache); }
  const key = `${state.seed}/${colony}/${anchor.x},${anchor.y}/${JSON.stringify(rules)}/${reach}`;
  const cached = cache.get(key); if (cached !== undefined) return cached;
  const w = state.config.mapWidth * SUB, h = state.config.mapHeight * SUB;
  const raw: Vec[] = [], seed = hash(state.seed, anchor.x, anchor.y), mirror = colony === 0 ? 1 : -1;
  const add = (dx: number, dy: number) => {
    const x = Math.round(anchor.x + dx * mirror), y = Math.round(anchor.y + dy);
    if (x >= 0 && y >= 0 && x < w && y < h &&
      (x - anchor.x) ** 2 + (y - anchor.y) ** 2 <= reach ** 2) raw.push({ x, y });
  };
  const rowPitch = rules.pitch * Math.sqrt(3) / 2;
  // Include every jittered, rounded site in the radius, including staggered rows.
  const rows = Math.ceil((reach + rules.jitter + 1) / rowPitch);
  const columns = Math.ceil((reach + rules.pitch / 2 + rules.jitter + 1) / rules.pitch);
  for (let y = -rows; y <= rows; y++) for (let x = -columns; x <= columns; x++) {
    const offset = (y & 1) ? rules.pitch / 2 : 0;
    const jitterX = (unit(seed, x, y) * 2 - 1) * rules.jitter;
    const jitterY = (unit(seed ^ 0x632be5ab, x, y) * 2 - 1) * rules.jitter;
    add(x * rules.pitch + offset + jitterX, y * rowPitch + jitterY);
  }
  raw.sort((a, b) => (a.x - anchor.x) ** 2 + (a.y - anchor.y) ** 2 - (b.x - anchor.x) ** 2 - (b.y - anchor.y) ** 2 ||
    a.y - b.y || mirror * (a.x - b.x));
  const index = new SiteIndex(rules.minimumSpacing, w), result: Vec[] = [];
  for (const p of raw) if (!index.hasNear(p)) { index.add(p); result.push(p); }
  // Only memoized static candidates: eviction changes performance, never assignments.
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, result); return result;
}
export class PointRestCapacityError extends Error {
  readonly requested: number;
  readonly assigned: number;
  readonly anchor: Vec;
  constructor(requested: number, assigned: number, anchor: Vec) {
    super(`Point resting capacity exhausted: assigned ${assigned} of ${requested} near ${anchor.x},${anchor.y}`);
    this.name = 'PointRestCapacityError';
    this.requested = requested; this.assigned = assigned; this.anchor = anchor;
  }
}
const preparationKey = Symbol('point-rest-preparation');
type Rest = NonNullable<Ant['pointRest']>;
interface AllocationInputs {
  readonly config: SimConfig;
  readonly terrain: SimState['terrain'];
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly rules: PointArrivalRules;
  readonly defendArea: number | undefined;
  readonly attackArea: number;
  readonly ants: readonly { readonly id: number; readonly colony: number; readonly x: number; readonly y: number; readonly rest: Rest | undefined }[];
  readonly goals: ReadonlyMap<number, LocalGoal>;
  readonly marks: readonly { readonly id: number; readonly verb: SimState['marks'][number]['verb'] }[];
}
/** Opaque, process-local preparation; never part of a recorded simulation state. */
export interface PointRestPreparation {
  readonly [preparationKey]: {
    readonly inputs: AllocationInputs;
    readonly next: readonly (Rest | undefined)[];
    readonly rests: ReadonlyMap<number, Vec>;
  };
}
const copyRest = (rest: Ant['pointRest']): Rest | undefined => rest === undefined ? undefined : Object.freeze({ ...rest });
const sameRest = (a: Rest | undefined, b: Rest | undefined): boolean => a === undefined || b === undefined ? a === b
  : a.key === b.key && Object.is(a.x, b.x) && Object.is(a.y, b.y);
const sameGoal = (a: LocalGoal | undefined, b: LocalGoal | undefined): boolean => a === undefined || b === undefined ? a === b
  : a.key === b.key && a.kind === b.kind && a.nativeReached === b.nativeReached && a.guardPost === b.guardPost && a.passingThrough === b.passingThrough &&
    Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.targetId, b.targetId);
function matches(state: SimState, goals: ReadonlyMap<number, LocalGoal>, old: AllocationInputs): boolean {
  const rules = state.config.pointArrival!;
  if (state.config !== old.config || state.terrain !== old.terrain || !Object.is(state.seed, old.seed) ||
      state.config.mapWidth !== old.width || state.config.mapHeight !== old.height ||
      rules.variant !== old.rules.variant || !Object.is(rules.pitch, old.rules.pitch) ||
      !Object.is(rules.jitter, old.rules.jitter) || !Object.is(rules.minimumSpacing, old.rules.minimumSpacing) ||
      state.config.countMarks?.defendTiles !== old.defendArea || state.config.attackRadiusTiles !== old.attackArea ||
      state.ants.length !== old.ants.length || state.marks.length !== old.marks.length || goals.size !== old.goals.size) return false;
  for (let i = 0; i < old.ants.length; i++) {
    const ant = state.ants[i]!, before = old.ants[i]!;
    if (ant.id !== before.id || ant.colony !== before.colony || !Object.is(ant.x, before.x) || !Object.is(ant.y, before.y) ||
        !sameRest(ant.pointRest, before.rest)) return false;
  }
  for (let i = 0; i < old.marks.length; i++) {
    if (state.marks[i]!.id !== old.marks[i]!.id || state.marks[i]!.verb !== old.marks[i]!.verb) return false;
  }
  for (const [id, goal] of old.goals) if (!sameGoal(goals.get(id), goal)) return false;
  return true;
}
/** Build static connectivity during setup; direct simulation callers keep the lazy fallback. */
export function preparePointRestTopology(state: SimState): void {
  if (state.config.pointArrival !== undefined) topology(state);
}
/** Prepare the original allocation on private ants; no published state or RNG is changed. */
export function preparePointRests(state: SimState, goals: ReadonlyMap<number, LocalGoal>): PointRestPreparation | undefined {
  if (state.config.pointArrival === undefined) return undefined;
  const inputs: AllocationInputs = Object.freeze({
    config: state.config, terrain: state.terrain, seed: state.seed, width: state.config.mapWidth, height: state.config.mapHeight,
    rules: Object.freeze({ ...state.config.pointArrival }), defendArea: state.config.countMarks?.defendTiles,
    attackArea: state.config.attackRadiusTiles,
    ants: Object.freeze(state.ants.map(ant => Object.freeze({ id: ant.id, colony: ant.colony, x: ant.x, y: ant.y, rest: copyRest(ant.pointRest) }))),
    goals: new Map([...goals].map(([id, goal]) => [id, Object.freeze({ ...goal })])),
    marks: Object.freeze(state.marks.map(mark => Object.freeze({ id: mark.id, verb: mark.verb }))),
  });
  preparePointRestTopology(state);
  const draft = { ...state, ants: state.ants.map(ant => ({ ...ant })) };
  const allocated = assignPointRests(draft, goals);
  const next = Object.freeze(draft.ants.map(ant => copyRest(ant.pointRest)));
  // Preserve result insertion order independently of the complete next-rest state.
  const byId = new Map(draft.ants.map((ant, i) => [ant.id, next[i]]));
  const rests = new Map([...allocated.keys()].map(id => [id, byId.get(id)!]));
  return Object.freeze({ [preparationKey]: Object.freeze({ inputs, next, rests }) });
}
/** Deterministic resting destinations, not collision boxes or moving-ant obstacles. */
export function assignPointRests(state: SimState, goals: ReadonlyMap<number, LocalGoal>, prepared?: PointRestPreparation): ReadonlyMap<number, Vec> {
  const rules = state.config.pointArrival;
  if (rules === undefined) return new Map();
  const ready = prepared?.[preparationKey];
  if (ready !== undefined && matches(state, goals, ready.inputs)) {
    for (let i = 0; i < state.ants.length; i++) {
      const rest = ready.next[i];
      if (rest === undefined) { if (state.ants[i]!.pointRest !== undefined) state.ants[i]!.pointRest = undefined; }
      else state.ants[i]!.pointRest = rest;
    }
    return new Map(ready.rests);
  }
  // With no point or mark goal to rest at and no resting ant, the pass below changes nothing and finds no rest.
  let resting = false;
  for (const goal of goals.values()) if ((goal.kind === 'point' || goal.kind === 'mark') && goal.passingThrough !== true) { resting = true; break; }
  if (!resting) for (const ant of state.ants) if (ant.pointRest !== undefined) { resting = true; break; }
  if (!resting) return new Map();
  const graph = topology(state), w = state.config.mapWidth;
  const groups = new Map<string, { anchor: Vec; ants: Ant[]; colony: number; component: number; area?: number }>();
  const rest = new Map<number, Vec>(), occupied = new SiteIndex(rules.minimumSpacing, w * SUB);
  const signature = JSON.stringify(rules);
  for (const ant of [...state.ants].sort((a, b) => a.id - b.id)) {
    const goal = goals.get(ant.id);
    if ((goal?.kind !== 'point' && goal?.kind !== 'mark') || goal.passingThrough === true) {
      // Combat temporarily overrides, but does not surrender, an existing resting destination.
      if (goal?.kind === 'combat' && ant.pointRest !== undefined) occupied.add(ant.pointRest);
      else if (ant.pointRest !== undefined) ant.pointRest = undefined;
      continue;
    }
    if (goal.x === undefined || goal.y === undefined) continue;
    const mark = goal.kind === 'mark' ? state.marks.find(m => m.id === goal.targetId) : undefined;
    if (mark?.verb === 'LINE') {
      // A LINE spot is the ant's own resting place: no cluster layout around it.
      if (ant.pointRest?.key !== goal.key || ant.pointRest.x !== goal.x || ant.pointRest.y !== goal.y) {
        ant.pointRest = { key: goal.key, x: goal.x, y: goal.y };
      }
      rest.set(ant.id, ant.pointRest); occupied.add(ant.pointRest);
      continue;
    }
    const component = graph.component[Math.floor(ant.y / SUB) * w + Math.floor(ant.x / SUB)]!;
    const key = `${signature}/${ant.colony}/${goal.x},${goal.y}/${component}`;
    if (ant.pointRest !== undefined && ant.pointRest.key !== key) ant.pointRest = undefined;
    let group = groups.get(key);
    if (group === undefined) {
      group = { anchor: { x: goal.x, y: goal.y }, ants: [], colony: ant.colony, component };
      groups.set(key, group);
    }
    if (mark?.verb === 'DEFEND' || mark?.verb === 'ATTACK') {
      group.area = mark.verb === 'DEFEND' ? state.config.countMarks!.defendTiles : state.config.attackRadiusTiles;
    }
    group.ants.push(ant);
    if (ant.pointRest !== undefined) { rest.set(ant.id, ant.pointRest); occupied.add(ant.pointRest); }
  }
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const pending = group.ants.filter(ant => ant.pointRest === undefined);
    if (pending.length === 0) continue;
    const maximumReach = Math.hypot(w * SUB, state.config.mapHeight * SUB);
    // Local work scales with the group, not map size. Include the entire held
    // area before considering overflow; its tile boundary needs one tile of padding.
    let reach = Math.min(maximumReach, Math.max((Math.ceil(Math.sqrt(group.ants.length)) + 1) * rules.pitch,
      group.area === undefined ? 0 : (group.area + 1) * SUB));
    const inside = (site: Vec) => group.area === undefined || withinTiles(
      Math.floor(site.x / SUB), Math.floor(site.y / SUB),
      Math.floor(group.anchor.x / SUB), Math.floor(group.anchor.y / SUB), group.area);
    let at = 0;
    while (at < pending.length) {
      const sites = candidates(state, group.anchor, group.colony, rules, reach);
      // Each expansion preserves the same nearest-site prefix. Assigned ants
      // remain reserved; terrain or occupied sites alone cause an outward search.
      const ordered = group.area === undefined ? sites : [...sites.filter(inside), ...sites.filter(site => !inside(site))];
      for (const site of ordered) {
        const tile = Math.floor(site.y / SUB) * w + Math.floor(site.x / SUB);
        if (!graph.land[tile] || graph.component[tile] !== group.component || occupied.hasNear(site)) continue;
        const ant = pending[at++]!;
        ant.pointRest = { key, x: site.x, y: site.y }; rest.set(ant.id, ant.pointRest); occupied.add(site);
        if (at === pending.length) break;
      }
      if (at === pending.length || reach === maximumReach) break;
      reach = Math.min(maximumReach, reach * 2);
    }
    if (at < pending.length) throw new PointRestCapacityError(group.ants.length, group.ants.length - pending.length + at, group.anchor);
  }
  return rest;
}
