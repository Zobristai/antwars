import { describe, expect, it } from 'vitest';
import { SUB, rulesConfig, speedPerTick, type SimConfig, type PointArrivalRules } from '../../src/sim/config.js';
import { newMatchConfig, withGridScale } from '../../src/sim/gridScale.js';
import { createMatch, cloneState, newAnt, buildGrid } from '../../src/sim/map.js';
import { assignPointRests, preparePointRests, preparePointRestTopology } from '../../src/sim/pointSlots.js';
import { beginLocalGoals, notePoint, readLocalGoal, type LocalGoal } from '../../src/sim/localArrival.js';
import { moveToPointRest, routeToward } from '../../src/sim/navigation.js';
import { countMarkDirection } from '../../src/sim/agents.js';
import { tileCentre, withinTiles, type Vec } from '../../src/sim/geometry.js';
import { advanceSoftAnts, step } from '../../src/sim/step.js';
import { isPassable, isBlockedTile, segmentOnLand } from '../../src/sim/terrain.js';
import type { Ant, SimState } from '../../src/sim/types.js';
import { sevenMapRotation } from './seven-map-rotation.js';

function scene(count: number, mapId = 'open-field') {
  const base = rulesConfig('redesign');
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  const config = sevenMapRotation(newMatchConfig({ ...base, startAnts: 0, terrain: { ...base.terrain!, mapId } }));
  const state = createMatch(7004, config); state.ants = [];
  const home = state.colonies[0];
  for (let i = 0; i < count; i++) state.ants.push(newAnt(config, state.nextAntId++, 0, home.queenX, home.queenY, i % 2 ? 'worker' : 'soldier'));
  return state;
}
function goals(state: SimState, x = 64500, y = 48500) {
  return new Map(state.ants.map(ant => [ant.id, { key: 'point', kind: 'point', x, y, nativeReached: false } as LocalGoal]));
}
function phase(state: SimState, x: number, y: number) {
  beginLocalGoals(state);
  for (const ant of state.ants) notePoint(state, ant, x, y);
  const out = advanceSoftAnts(state, new Map(), new Set());
  for (const ant of state.ants) {
    const origin = out.origins.get(ant.id)!;
    expect((ant.x - origin.x) ** 2 + (ant.y - origin.y) ** 2).toBeLessThanOrEqual(speedPerTick(state.config) ** 2);
  }
  state.tick++;
}
/** Frozen pre-optimization selector: keep its candidate construction and ties. */
function referencePointStep(state: SimState, ant: Ant, rest: Vec, speed: number): void {
  const direct = segmentOnLand(state.config, state.terrain, ant.x, ant.y, rest.x, rest.y);
  const heading = direct ? { x: rest.x - ant.x, y: rest.y - ant.y } : routeToward(state, ant, rest.x, rest.y, 0);
  const choose = (dx: number, dy: number): Vec | undefined => {
    const length = Math.hypot(dx, dy), scale = length > speed ? speed / length : 1;
    const x = dx * scale, y = dy * scale;
    const candidates = [...new Set([Math.floor(x), Math.ceil(x)])].flatMap(vx =>
      [...new Set([Math.floor(y), Math.ceil(y)])].map(vy => ({ x: vx, y: vy })));
    candidates.sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - (b.x - x) ** 2 - (b.y - y) ** 2 || a.y - b.y || a.x - b.x);
    return candidates.find(v => v.x ** 2 + v.y ** 2 <= speed ** 2 &&
      ant.x + v.x >= 0 && ant.x + v.x < state.config.mapWidth * SUB &&
      ant.y + v.y >= 0 && ant.y + v.y < state.config.mapHeight * SUB &&
      segmentOnLand(state.config, state.terrain, ant.x, ant.y, ant.x + v.x, ant.y + v.y));
  };
  let delta = choose(heading.x, heading.y);
  if (delta === undefined || (delta.x === 0 && delta.y === 0 && (ant.x !== rest.x || ant.y !== rest.y))) {
    delta = choose(tileCentre(Math.floor(ant.x / SUB)) - ant.x, tileCentre(Math.floor(ant.y / SUB)) - ant.y);
  }
  ant.vx = delta?.x ?? 0; ant.vy = delta?.y ?? 0;
  ant.x += ant.vx; ant.y += ant.vy;
}
/** Frozen allocator from 71568f24: independent of preparation and its caches. */

interface referenceTopology { readonly component: Int32Array; readonly land: readonly boolean[] }
const referenceTopologies = new WeakMap<SimConfig, Map<SimState['terrain'], referenceTopology>>();
const referenceLayouts = new WeakMap<SimConfig, Map<string, readonly Vec[]>>();
/** Read-only static connectivity, including the navigation system's no-corner-cut rule. */
function referenceTopology(state: SimState): referenceTopology {
  let cache = referenceTopologies.get(state.config);
  if (cache === undefined) { cache = new Map(); referenceTopologies.set(state.config, cache); }
  const old = cache.get(state.terrain); if (old !== undefined) return old;
  const { mapWidth: w, mapHeight: h } = state.config;
  const land = Array.from({ length: w * h }, (_, i) => !isBlockedTile(state.terrain, i % w, Math.floor(i / w)));
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
function referenceHash(seed: number, a: number, b: number): number {
  let n = seed ^ Math.imul(a, 0x9e3779b9) ^ Math.imul(b, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d); n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
function referenceUnit(seed: number, a: number, b: number): number { return referenceHash(seed, a, b) / 0x100000000; }
class referenceSiteIndex {
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
function referenceCandidates(state: SimState, anchor: Vec, colony: number, rules: PointArrivalRules, reach: number): readonly Vec[] {
  let cache = referenceLayouts.get(state.config);
  if (cache === undefined) { cache = new Map(); referenceLayouts.set(state.config, cache); }
  const key = `${state.seed}/${colony}/${anchor.x},${anchor.y}/${JSON.stringify(rules)}/${reach}`;
  const cached = cache.get(key); if (cached !== undefined) return cached;
  const w = state.config.mapWidth * SUB, h = state.config.mapHeight * SUB;
  const raw: Vec[] = [], seed = referenceHash(state.seed, anchor.x, anchor.y), mirror = colony === 0 ? 1 : -1;
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
    const jitterX = (referenceUnit(seed, x, y) * 2 - 1) * rules.jitter;
    const jitterY = (referenceUnit(seed ^ 0x632be5ab, x, y) * 2 - 1) * rules.jitter;
    add(x * rules.pitch + offset + jitterX, y * rowPitch + jitterY);
  }
  raw.sort((a, b) => (a.x - anchor.x) ** 2 + (a.y - anchor.y) ** 2 - (b.x - anchor.x) ** 2 - (b.y - anchor.y) ** 2 ||
    a.y - b.y || mirror * (a.x - b.x));
  const index = new referenceSiteIndex(rules.minimumSpacing, w), result: Vec[] = [];
  for (const p of raw) if (!index.hasNear(p)) { index.add(p); result.push(p); }
  // Only memoized static referenceCandidates: eviction changes performance, never assignments.
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, result); return result;
}
class referencePointRestCapacityError extends Error {
  readonly requested: number;
  readonly assigned: number;
  readonly anchor: Vec;
  constructor(requested: number, assigned: number, anchor: Vec) {
    super(`Point resting capacity exhausted: assigned ${assigned} of ${requested} near ${anchor.x},${anchor.y}`);
    this.name = 'referencePointRestCapacityError';
    this.requested = requested; this.assigned = assigned; this.anchor = anchor;
  }
}
/** Deterministic resting destinations, not collision boxes or moving-ant obstacles. */
function referenceAssignPointRests(state: SimState, goals: ReadonlyMap<number, LocalGoal>): ReadonlyMap<number, Vec> {
  const rules = state.config.rules25 === true ? state.config.pointArrival : undefined;
  if (rules === undefined) return new Map();
  const graph = referenceTopology(state), w = state.config.mapWidth;
  const groups = new Map<string, { anchor: Vec; ants: Ant[]; colony: number; component: number; area?: number }>();
  const rest = new Map<number, Vec>(), occupied = new referenceSiteIndex(rules.minimumSpacing, w * SUB);
  const signature = JSON.stringify(rules);
  for (const ant of [...state.ants].sort((a, b) => a.id - b.id)) {
    const goal = goals.get(ant.id);
    if (goal?.kind !== 'point' && goal?.kind !== 'mark') {
      // Combat temporarily overrides, but does not surrender, an existing resting destination.
      if (goal?.kind === 'combat' && ant.pointRest !== undefined) occupied.add(ant.pointRest);
      else delete ant.pointRest;
      continue;
    }
    if (goal.x === undefined || goal.y === undefined) continue;
    const component = graph.component[Math.floor(ant.y / SUB) * w + Math.floor(ant.x / SUB)]!;
    const key = `${signature}/${ant.colony}/${goal.x},${goal.y}/${component}`;
    if (ant.pointRest?.key !== key) delete ant.pointRest;
    let group = groups.get(key);
    if (group === undefined) {
      group = { anchor: { x: goal.x, y: goal.y }, ants: [], colony: ant.colony, component };
      groups.set(key, group);
    }
    const mark = goal.kind === 'mark' ? state.marks.find(m => m.id === goal.targetId) : undefined;
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
      const sites = referenceCandidates(state, group.anchor, group.colony, rules, reach);
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
    if (at < pending.length) throw new referencePointRestCapacityError(group.ants.length, group.ants.length - pending.length + at, group.anchor);
  }
  return rest;
}

describe('point-rest setup preparation', () => {
  // Run these before other layouts in this worker: connectivity is prepared,
  // but each match's full-cap goal has never generated or assigned any sites.
  it.each(['open-field', 'central-lake', 'three-crossings'])('reports the largest cold fallback assignment on %s', mapId => {
    const state = scene(4096, mapId);
    state.tick = 100;
    preparePointRestTopology(state);
    const input = goals(state);
    const started = performance.now();
    const rests = assignPointRests(state, input);
    const assignmentMs = performance.now() - started;
    expect(rests.size).toBe(4096);
    console.info('Point-rest cold fallback timing', JSON.stringify({
      mapId, seed: state.seed, ants: state.ants.length, assignmentMs,
      connectivity: 'prepared', layout: 'first-use', phase: 'mid-match',
    }));
  });
  it.each(['open-field', 'central-lake', 'three-crossings'])('preserves exact allocator results, order and source state on %s', mapId => {
    for (const scenario of ['point', 'existing', 'combat', 'mark'] as const) {
      const source = scene(80, mapId);
      source.ants = source.ants.map((ant, i) => ({ ...ant, colony: i % 2 as 0 | 1 }));
      const input = goals(source);
      if (scenario === 'existing' || scenario === 'combat') {
        referenceAssignPointRests(source, input);
        source.ants.splice(0, 2);
        if (scenario === 'combat') {
          for (const ant of source.ants.slice(0, 5)) input.set(ant.id, { key: 'combat', kind: 'combat', nativeReached: true });
        }
      }
      if (scenario === 'mark') {
        source.marks = [{ id: 1, agentId: 'preparation', colony: 0, tileX: 64, tileY: 48,
          words: [], laidTick: 0, steering: 0, verb: 'DEFEND', count: 80 }];
        for (const [id, goal] of input) input.set(id, { ...goal, kind: 'mark', targetId: 1 });
      }
      const before = cloneState(source);
      const prepared = preparePointRests(source, input)!;
      expect(source).toEqual(before);
      const actual = cloneState(source), original = cloneState(source), repeated = cloneState(source);
      const expected = referenceAssignPointRests(original, input);
      const got = assignPointRests(actual, input, prepared);
      expect([...got]).toEqual([...expected]);
      expect(actual).toEqual(original);
      const again = assignPointRests(repeated, input, prepared);
      expect([...again]).toEqual([...expected]);
      // Shared immutable results prove the prepared path really was reused.
      for (const [id, rest] of got) {
        expect(Object.isFrozen(rest)).toBe(true);
        expect(again.get(id)).toBe(rest);
      }
    }
  });
  it.each(['goal', 'membership', 'position', 'colony', 'seed', 'terrain', 'config', 'rules', 'area', 'rest', 'mark', 'order'])('invalidates prepared allocations after a changed %s input', changed => {
    let state = scene(12);
    state = { ...state, config: { ...state.config, pointArrival: { ...state.config.pointArrival! }, countMarks: { ...state.config.countMarks! } } };
    state.marks = [{ id: 1, agentId: 'preparation', colony: 0, tileX: 64, tileY: 48,
      words: [], laidTick: 0, steering: 0, verb: 'DEFEND', count: 12 }];
    const input = new Map([...goals(state)].map(([id, goal]) => [id, { ...goal, kind: 'mark' as const, targetId: 1 }]));
    const prepared = preparePointRests(state, input)!;
    switch (changed) {
      case 'goal': input.set(state.ants[0]!.id, { ...input.get(state.ants[0]!.id)!, x: 53500 }); break;
      case 'membership': state.ants.pop(); break;
      case 'position': state.ants[0]!.x += 13; break;
      case 'colony': state.ants[0] = { ...state.ants[0]!, colony: 1 }; break;
      case 'seed': state = { ...state, seed: state.seed + 1 }; break;
      case 'terrain': state = { ...state, terrain: structuredClone(state.terrain) }; break;
      case 'config': state = { ...state, config: { ...state.config } }; break;
      case 'rules': Object.assign(state.config.pointArrival!, { jitter: state.config.pointArrival!.jitter + 1 }); break;
      case 'area': Object.assign(state.config.countMarks!, { defendTiles: state.config.countMarks!.defendTiles + 1 }); break;
      case 'rest': state.ants[0]!.pointRest = { key: 'old', x: 50500, y: 40500 }; break;
      case 'mark': state.marks[0]!.verb = 'ATTACK'; break;
      case 'order': state.ants.reverse(); break;
    }
    const original = cloneState(state);
    expect([...assignPointRests(state, input, prepared)]).toEqual([...referenceAssignPointRests(original, input)]);
    expect(state).toEqual(original);
  });
  it('retains terrain-free allocation and disabled stored-config behavior', () => {
    const state = { ...scene(30), terrain: undefined };
    const input = goals(state), prepared = preparePointRests(state, input)!;
    const original = cloneState(state);
    expect([...assignPointRests(state, input, prepared)]).toEqual([...referenceAssignPointRests(original, input)]);
    const stored = { ...cloneState(state), config: { ...state.config, pointArrival: undefined } };
    const before = cloneState(stored);
    expect(preparePointRests(stored, input)).toBeUndefined();
    expect([...assignPointRests(stored, input, prepared)]).toEqual([]);
    expect(stored).toEqual(before);
  });
});

describe('organic point arrival', () => {
  it.each(['open-field', 'central-lake', 'three-crossings'])('selects identical integer steps and trajectories to the frozen selector on %s', mapId => {
    const state = scene(1, mapId), reference = { ...cloneState(state), terrain: structuredClone(state.terrain) };
    const points: Vec[] = [];
    for (let y = 0; y < state.config.mapHeight; y += 11) for (let x = 0; x < state.config.mapWidth; x += 13) {
      if (isPassable(state, x, y)) points.push({ x: tileCentre(x), y: tileCentre(y) });
    }
    for (const speed of [0, 1, 199, speedPerTick(state.config)]) for (let i = 0; i < points.length; i += 5) {
      const start = points[i]!, target = points[(i * 31 + 7) % points.length]!;
      const actual = { ...state.ants[0]!, x: start.x, y: start.y }, original = { ...actual };
      for (let tick = 0; tick < 60; tick++) {
        moveToPointRest(state, actual, target, speed);
        referencePointStep(reference, original, target, speed);
        expect([actual.x, actual.y, actual.vx, actual.vy]).toEqual([original.x, original.y, original.vx, original.vy]);
      }
    }
  });
  it('matches the frozen selector at boundaries, tiny steps, signed axes and rounding ties', () => {
    const base = scene(1), state = { ...base, terrain: undefined };
    const right = state.config.mapWidth * SUB - 1, bottom = state.config.mapHeight * SUB - 1;
    for (const start of [{ x: 0, y: 0 }, { x: right, y: bottom }, { x: 20500, y: 40500 }]) {
      for (const dx of [-1001, -200, -1, -0, 0, 1, 200, 1001]) for (const dy of [-1001, -1, 0, 1, 1001]) {
        for (const speed of [0, 1, 2, 199, 200, 400]) {
          const actual = { ...state.ants[0]!, ...start }, original = { ...actual };
          const target = { x: start.x + dx, y: start.y + dy };
          moveToPointRest(state, actual, target, speed); referencePointStep(state, original, target, speed);
          expect([actual.x, actual.y, actual.vx, actual.vy]).toEqual([original.x, original.y, original.vx, original.vy]);
        }
      }
    }
  });
  it.each(['open-field', 'central-lake', 'three-crossings'])('matches legacy routes and trajectories on %s with independent terrain caches', mapId => {
    const modern = scene(1, mapId), copy = cloneState(modern);
    // cloneState intentionally shares immutable terrain. Separate copies ensure
    // neither traversal can borrow the other's cached field and fake equality.
    const legacy: SimState = { ...copy, config: { ...copy.config, pointArrival: undefined }, terrain: structuredClone(modern.terrain) };
    const points: { x: number; y: number }[] = [];
    for (let y = 0; y < modern.config.mapHeight; y += 11) {
      for (let x = 0; x < modern.config.mapWidth; x += 13) {
        if (isPassable(modern, x, y)) points.push({ x: x * SUB + SUB / 2, y: y * SUB + SUB / 2 });
      }
    }
    const FOLLOW_EVERY = 16;
    let indirect = 0;
    for (const colony of [0, 1] as const) {
      const current = { ...modern.ants[0]!, colony }, original = { ...legacy.ants[0]!, colony };
      for (let goal = 0; goal < points.length; goal += 9) {
        const target = points[goal]!;
        for (const start of points) {
          current.x = original.x = start.x; current.y = original.y = start.y;
          expect(routeToward(modern, current, target.x, target.y, 0)).toEqual(routeToward(legacy, original, target.x, target.y, 0));
          if (segmentOnLand(modern.config, modern.terrain, start.x, start.y, target.x, target.y)) continue;
          // Every route is compared above; following every indirect pair as well
          // is too slow, so follow a fixed deterministic sample of them.
          if (indirect++ % FOLLOW_EVERY !== 0) continue;
          // Interleave distinct goals to exercise scratch-queue reuse while old
          // fields remain cached, then follow their terrain-safe integer steps.
          for (let tick = 0; tick < 40; tick++) {
            moveToPointRest(modern, current, target, speedPerTick(modern.config));
            moveToPointRest(legacy, original, target, speedPerTick(legacy.config));
            expect([current.x, current.y, current.vx, current.vy]).toEqual([original.x, original.y, original.vx, original.vy]);
          }
        }
      }
    }
    expect(indirect).toBeGreaterThan(0);
  });
  it('preserves the nearest organic prefix when group size changes', () => {
    const small = scene(8), large = scene(200);
    const nearest = [...assignPointRests(small, goals(small)).values()];
    expect(nearest).toEqual([...assignPointRests(large, goals(large)).values()].slice(0, nearest.length));
  });
  it('expands beyond a blocked neighbourhood without changing the nearest reachable site', () => {
    // The lake centre has no nearby land for a one-ant search; a large group
    // searches a broader radius immediately. Both must choose the same first site.
    const small = scene(1, 'central-lake'), large = scene(512, 'central-lake');
    const nearest = [...assignPointRests(small, goals(small, 63500, 48500)).values()][0]!;
    expect(nearest).toEqual([...assignPointRests(large, goals(large, 63500, 48500)).values()][0]);
    expect(isPassable(small, Math.floor(nearest.x / SUB), Math.floor(nearest.y / SUB))).toBe(true);
  });
  it('keeps survivors stable through membership changes and ant iteration order', () => {
    const state = scene(30), input = goals(state);
    assignPointRests(state, input);
    const original = new Map(state.ants.map(ant => [ant.id, ant.pointRest]));
    state.ants.shift(); state.ants.reverse();
    assignPointRests(state, input);
    for (const ant of state.ants) expect(ant.pointRest).toEqual(original.get(ant.id));
    const copy = cloneState(state); copy.ants.reverse();
    expect([...assignPointRests(copy, input)].sort()).toEqual([...assignPointRests(state, input)].sort());
  });
  it('places workers and soldiers beside an obstacle only on reachable land', () => {
    const state = scene(30, 'central-lake');
    assignPointRests(state, goals(state, 63500, 48500));
    for (let tick = 0; tick < 800; tick++) phase(state, 63500, 48500);
    for (const ant of state.ants) {
      expect(isPassable(state, Math.floor(ant.pointRest!.x / SUB), Math.floor(ant.pointRest!.y / SUB))).toBe(true);
      expect([ant.x, ant.y]).toEqual([ant.pointRest!.x, ant.pointRest!.y]);
    }
  }, 120000);
  it('produces identical complete match states for the same seed', () => {
    const first = scene(30); let a = first, b = cloneState(first);
    for (let i = 0; i < 100; i++) { a = step(a).state; b = step(b).state; }
    expect(a).toEqual(b);
  });
  it.each(['DEFEND', 'ATTACK'] as const)('%s fills the held area then selects the nearest walkable overflow', verb => {
    const pool = scene(200), state = scene(100);
    const all = [...assignPointRests(pool, goals(pool)).values()];
    const mark = { id: 1, agentId: 'overflow', colony: 0 as const, tileX: 64, tileY: 48,
      words: [], laidTick: 0, steering: 0, verb, count: 100 };
    state.marks = [mark];
    const radius = verb === 'DEFEND' ? state.config.countMarks!.defendTiles : state.config.attackRadiusTiles;
    const inside = (p: { x: number; y: number }) => withinTiles(Math.floor(p.x / SUB), Math.floor(p.y / SUB), mark.tileX, mark.tileY, radius);
    const input = new Map([...goals(state)].map(([id, goal]) => [id, { ...goal, kind: 'mark' as const, targetId: mark.id }]));
    const rests = [...assignPointRests(state, input).values()];
    const inner = all.filter(inside), outer = all.filter(p => !inside(p));
    expect(inner.length).toBeGreaterThan(0);
    // Use the live radius and spacing, with enough ants to exhaust its sites.
    expect(inner.length).toBeLessThan(state.ants.length);
    expect(rests.slice(0, inner.length).map(p => [p.x, p.y])).toEqual(inner.map(p => [p.x, p.y]));
    expect(rests.length).toBeGreaterThan(inner.length);
    expect(rests.slice(inner.length).map(p => [p.x, p.y])).toEqual(outer.slice(0, rests.length - inner.length).map(p => [p.x, p.y]));
    for (const p of rests) expect(isPassable(state, Math.floor(p.x / SUB), Math.floor(p.y / SUB))).toBe(true);
    for (const ant of state.ants) ant.claim = mark.id;
    for (let tick = 0; tick < 400; tick++) {
      beginLocalGoals(state);
      const grid = buildGrid(state);
      const directions = new Map(state.ants.map(ant => [ant.id, countMarkDirection(state, grid, [], ant, mark).dir]));
      const frame = advanceSoftAnts(state, directions, new Set());
      for (const ant of state.ants) {
        const origin = frame.origins.get(ant.id)!;
        expect((ant.x - origin.x) ** 2 + (ant.y - origin.y) ** 2).toBeLessThanOrEqual(speedPerTick(state.config) ** 2);
      }
      state.tick++;
    }
    for (const ant of state.ants) expect([ant.x, ant.y]).toEqual([ant.pointRest!.x, ant.pointRest!.y]);
    expect(state.config.countMarks!.defendTiles).toBe(rulesConfig('redesign').countMarks!.defendTiles * 2);
    expect(state.config.attackRadiusTiles).toBe(rulesConfig('redesign').attackRadiusTiles * 2);
  });
  it('keeps ATTACK pursuit targets inside the original mark area even with resting overflow enabled', () => {
    const config = newMatchConfig(rulesConfig('redesign'));
    const state = createMatch(7004, { ...config, startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] });
    const ant = newAnt(state.config, state.nextAntId++, 0, 40500, 40500, 'soldier');
    const radius = state.config.attackRadiusTiles;
    const enemy = newAnt(state.config, state.nextAntId++, 1, (40 + radius + 1) * SUB + 500, 40500, 'soldier');
    const mark = { id: 1, agentId: 'combat', colony: 0 as const, tileX: 40, tileY: 40, words: [], laidTick: 0, steering: 0, verb: 'ATTACK' as const, count: 1 };
    state.ants = [ant, enemy]; state.marks = [mark]; ant.claim = mark.id;
    beginLocalGoals(state); countMarkDirection(state, buildGrid(state), [], ant, mark);
    expect(readLocalGoal(state, ant)?.kind).toBe('mark');
    enemy.x -= SUB;
    beginLocalGoals(state); countMarkDirection(state, buildGrid(state), [], ant, mark);
    expect(readLocalGoal(state, ant)).toMatchObject({ kind: 'combat', targetId: enemy.id });
  });
});
it('scales every resting length but does not inject the opt-in into stored configs', () => {
  const base = rulesConfig('redesign'), fine = withGridScale(base);
  for (const key of ['pitch', 'jitter', 'minimumSpacing'] as const) expect(fine.pointArrival![key]).toBe(base.pointArrival![key] * 2);
  const { pointArrival: _point, ...old } = base;
  expect(withGridScale(old)).not.toHaveProperty('pointArrival');
});
it.each([[21982,77831,22796,85337],[91608,4065,102781,2199]])('walks past the exact speed-clamp corner regression at %i,%i', (x,y,tx,ty) => {
  const state = scene(1), ant = state.ants[0]!; ant.x = x; ant.y = y;
  const original = { ...ant }, reference = { ...cloneState(state), terrain: structuredClone(state.terrain) };
  const speed = speedPerTick(state.config);
  for (let tick = 0; tick < 100; tick++) {
    const ox = ant.x, oy = ant.y; moveToPointRest(state, ant, { x: tx, y: ty }, speed);
    referencePointStep(reference, original, { x: tx, y: ty }, speed);
    expect([ant.x, ant.y, ant.vx, ant.vy]).toEqual([original.x, original.y, original.vx, original.vy]);
    expect((ant.x - ox) ** 2 + (ant.y - oy) ** 2).toBeLessThanOrEqual(speed ** 2);
  }
  expect([ant.x, ant.y]).toEqual([tx, ty]);
});
