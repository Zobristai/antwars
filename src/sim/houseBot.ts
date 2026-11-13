import { routeToward } from "./navigation.js";
import { isBlockedTile, isWaterTile } from "./terrain.js";
import { SUB, type SimConfig } from "./config.js";
import { gridScaleOf } from "./gridScale.js";
import { distance, tileCentre, withinTiles, ZERO, type Vec } from "./geometry.js";
import { ARRIVE, foodTargetHeld, forageDirection, hasClusterFoodTarget, toward } from "./forage.js";
import { noteCombat, noteContact, noteQueenContact, noteGuard, noteGuardPost, noteHoldPoint } from "./localArrival.js";
import { activeQueens, areaCount, colonyAreaCounts, forEachNear, gridBuckets, hasAdjacentEnemy, nearestQueen, nextQueenFoundingTick, queenFoundingCost, queenSpacingNests, type Grid } from "./map.js";
import { foundQueen } from "./agents.js";
import { localRulesSide } from "./marks.js";
import type { Ant, ColonyId, QueenState, SimEvent, SimState } from "./types.js";

/** Linear interpolation from start to end permille over the match. */
function overMatch(state: SimState, start: number, end: number): number {
  const t = Math.min(state.tick, state.config.matchTicks);
  return start + Math.trunc(((end - start) * t) / state.config.matchTicks);
}

/** Colony-size guard allotment, including ants in squads in the denominator. */
export function guardBudget(colonyAntCount: number, config: Pick<SimConfig, "guardCount" | "guardSharePermille">): number {
  return Math.max(config.guardCount, Math.floor(colonyAntCount * (config.guardSharePermille ?? 0) / 1000));
}

/** One authoritative target calculation for assignment and private diagnostics. */
export function queenGuardTargets(population: number, eligible: number, queens: number, config: SimConfig) {
  const budget = guardBudget(population, config);
  const requested = queens === 0 ? 0 : config.queenFounding?.guardsPerQueen ? budget * queens : budget;
  const share = config.queenFounding?.totalGuardSharePermille;
  const cap = share === undefined ? null : Math.floor(population * share / 1000);
  return { perQueenTarget: config.queenFounding?.guardsPerQueen ? budget : null, requested, cap,
    assignedTarget: Math.min(requested, cap ?? Infinity, eligible),
    clampedByCap: cap !== null && requested > cap, clampedByAvailability: requested > eligible };
}

/** Assignment history is private, immutable and preserved by the ant's shallow clone. */
interface RoleHold { readonly role: Ant["role"]; readonly changedTick: number }
type AssignedAnt = Ant & { houseRoleHold?: RoleHold; houseIntentHold?: IntentHold };
const assignmentHolds = (state: SimState): boolean => state.config.localAnts?.workerHomeGuardHold === true;
function roleHeld(state: SimState, ant: Ant): boolean {
  const old = (ant as AssignedAnt).houseRoleHold;
  return assignmentHolds(state) && old?.role === ant.role && state.tick - old.changedTick < 2 * state.config.ticksPerSecond;
}
function rememberRole(state: SimState, ant: Ant): void {
  if (!assignmentHolds(state)) return;
  const assigned = ant as AssignedAnt;
  if (assigned.houseRoleHold?.role !== ant.role) {
    assigned.houseRoleHold = { role: ant.role, changedTick: state.tick };
    if (assigned.houseIntentHold !== undefined) assigned.houseIntentHold = undefined;
  }
}

/**
 * Rebalance sticky house-bot roles among each colony's non-squad ants, from
 * start-of-tick state: keep the configured guard allotment near each queen,
 * and a fighter share of the rest that rises over the match.
 * Squad ants count toward the budget but are never reassigned by the house bot.
 */
export function rebalanceRoles(state: SimState): void {
  const { config } = state;
  for (const colony of state.colonies) {
    const colonyAnts = state.ants.filter((ant) => ant.colony === colony.id);
    const local = localRulesSide(state, colony.id);
    for (const ant of colonyAnts) {
      const held = ant.squad !== null || ant.claim !== undefined;
      if (held) {
        if ((ant as AssignedAnt).houseRoleHold !== undefined) (ant as AssignedAnt).houseRoleHold = undefined;
        if ((ant as AssignedAnt).houseIntentHold !== undefined) (ant as AssignedAnt).houseIntentHold = undefined;
      }
      // Rules 27: a hold point belongs to a free ant of a seated side; it is taken afresh once the ant is free there again.
      if (ant.holdPoint !== undefined && (held || !local)) delete ant.holdPoint;
    }
    // A seated side under the redesign's local ant rules has no colony planner.
    if (local) continue;
    // Ants a count mark has claimed are directed by it, not the planner.
    const members = colonyAnts.filter((ant) => ant.squad === null && ant.claim === undefined);
    const byQueen = (a: Ant, b: Ant): number =>
      distance(a.x, a.y, colony.queenX, colony.queenY) - distance(b.x, b.y, colony.queenX, colony.queenY) ||
      a.id - b.id;

    if (config.queenFounding !== undefined) {
      rebalanceQueenGuards(state, members, colony.id,
        queenGuardTargets(colonyAnts.length, members.length, activeQueens(colony).length, config).assignedTarget);
    } else {
    const guards = members.filter((ant) => ant.role === "guard");
    const wantGuards = Math.min(guardBudget(colonyAnts.length, config), members.length);
    if (guards.length < wantGuards) {
      const candidates = members.filter((ant) => ant.role !== "guard").sort((a, b) => Number(roleHeld(state, a)) - Number(roleHeld(state, b)) || byQueen(a, b));
      for (const ant of candidates.slice(0, wantGuards - guards.length)) ant.role = "guard";
    } else if (guards.length > wantGuards) {
      for (const ant of guards.sort((a, b) => Number(roleHeld(state, b)) - Number(roleHeld(state, a)) || byQueen(a, b)).slice(wantGuards)) ant.role = ant.caste === "soldier" ? "fighter" : "forager";
    }
    }

    const rest = members.filter((ant) => ant.role !== "guard");
    const share = overMatch(state, config.fighterShareStartPermille, config.fighterShareEndPermille);
    const wantFighters = Math.trunc((rest.length * share) / 1000);
    const fighters = rest.filter((ant) => ant.role === "fighter");
    if (fighters.length < wantFighters) {
      const idle = rest.filter((ant) => ant.role === "forager").sort((a, b) => Number(roleHeld(state, a)) - Number(roleHeld(state, b)) || Number(a.carrying) - Number(b.carrying) || a.id - b.id);
      for (const ant of idle.slice(0, wantFighters - fighters.length)) ant.role = "fighter";
    } else if (fighters.length > wantFighters) {
      // Soldiers are never foragers: only workers step back.
      const workers = fighters.filter((ant) => ant.caste !== "soldier");
      for (const ant of workers.sort((a, b) => Number(roleHeld(state, a)) - Number(roleHeld(state, b)) || b.id - a.id).slice(0, fighters.length - wantFighters)) {
        ant.role = "forager";
      }
    }
    for (const ant of rest) if (ant.caste === "soldier" && ant.role === "forager") ant.role = "fighter";
    for (const ant of members) rememberRole(state, ant);
  }
}

/** Where a colony's rally line sits now, as a sub-tile x. */
export function rallyX(state: SimState, colony: ColonyId): number {
  const own = state.colonies[colony];
  const enemy = state.colonies[colony === 0 ? 1 : 0];
  const permille = overMatch(state, state.config.rallyStartPermille, state.config.rallyEndPermille);
  return own.queenX + Math.trunc(((enemy.queenX - own.queenX) * permille) / 1000);
}

/** Adjacent birth ids from opposite colonies share a lane/post key, without new state. */
function plannerId(state: SimState, ant: Ant): number {
  return ant.id - ant.colony;
}

/** Each fighter's lane across the map, spread by its recorded planner key. */
function laneY(state: SimState, ant: Ant): number {
  const scale = gridScaleOf(state.config);
  const rows = state.config.mapHeight / scale - 4;
  return tileCentre(2 + ((plannerId(state, ant) * 37) % rows)) * scale;
}

/** The nearest-enemy comparison, visited in forEachNear order: nearer wins, lowest id on ties. */
function nearer(best: Ant | null, bestD: number, other: Ant, d: number): boolean {
  return d < bestD || (d === bestD && best !== null && other.id < best.id);
}

export interface SightScan { readonly own: number; readonly enemy: number; readonly nearestEnemy: Ant | null }

/**
 * One pass over the ants within r tiles (Euclidean) of tile (tx, ty): own and enemy
 * counts, and the nearest enemy to the ant (lowest id on ties). Exported for tests.
 */
export function sightScan(state: SimState, grid: Grid, ant: Ant, tx: number, ty: number, r: number): SightScan {
  const dense = gridBuckets(grid);
  // Area counts exist for two-colony matches only; any other count takes the per-ant scan.
  const counts = dense === undefined || !Number.isInteger(r) || r < 0 ? undefined : colonyAreaCounts(state, grid);
  if (dense === undefined || counts === undefined) return scanNear(state, grid, ant, tx, ty, r);
  // The same circle of tiles, row by row: counts from each colony's per-row prefix sums, and the nearest
  // enemy (nearer, then lowest id, which no visiting order changes) from the buckets of rows holding enemies.
  const { mapWidth: width, mapHeight: height } = state.config;
  const half = circleHalfWidths(r);
  const mine = counts[ant.colony], theirs = counts[ant.colony === 0 ? 1 : 0];
  const y0 = Math.max(0, ty - r), y1 = Math.min(height - 1, ty + r);
  let own = 0;
  let enemy = 0;
  for (let y = y0; y <= y1; y += 1) {
    const w = half[Math.abs(y - ty)]!, x0 = Math.max(0, tx - w), x1 = Math.min(width - 1, tx + w);
    if (x0 > x1) continue;
    own += areaCount(mine, width, x0, y, x1, y);
    enemy += areaCount(theirs, width, x0, y, x1, y);
  }
  if (enemy === 0) return { own, enemy, nearestEnemy: null };
  let best: Ant | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let y = y0; y <= y1; y += 1) {
    const w = half[Math.abs(y - ty)]!, x0 = Math.max(0, tx - w), x1 = Math.min(width - 1, tx + w);
    if (x0 > x1 || areaCount(theirs, width, x0, y, x1, y) === 0) continue;
    for (let x = x0; x <= x1; x += 1) {
      const bucket = dense[y * width + x];
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        const other = bucket[i]!;
        if (other.colony === ant.colony) continue;
        const d = distance(ant.x, ant.y, other.x, other.y);
        if (nearer(best, bestD, other, d)) {
          best = other;
          bestD = d;
        }
      }
    }
  }
  return { own, enemy, nearestEnemy: best };
}

/**
 * Whether an enemy may be in sightScan's circle: false only when the circle's bounding square holds no ant of
 * the other colony, read from the same per-colony area counts in four reads; true when they are unavailable.
 */
function enemyMayBeInSight(state: SimState, grid: Grid, ant: Ant, tx: number, ty: number, r: number): boolean {
  if (gridBuckets(grid) === undefined || !Number.isInteger(r) || r < 0) return true;
  const { mapWidth: width, mapHeight: height } = state.config;
  const x0 = Math.max(0, tx - r), x1 = Math.min(width - 1, tx + r), y0 = Math.max(0, ty - r), y1 = Math.min(height - 1, ty + r);
  if (x0 > x1 || y0 > y1) return true;
  const counts = colonyAreaCounts(state, grid);
  return counts === undefined || areaCount(counts[ant.colony === 0 ? 1 : 0], width, x0, y0, x1, y1) !== 0;
}

/** sightScan over forEachNear, for a Map grid without dense buckets. */
function scanNear(state: SimState, grid: Grid, ant: Ant, tx: number, ty: number, r: number): SightScan {
  let own = 0;
  let enemy = 0;
  let best: Ant | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  forEachNear(state, grid, tx, ty, r, (other) => {
    if (!withinTiles(tx, ty, Math.floor(other.x / SUB), Math.floor(other.y / SUB), r)) return;
    if (other.colony === ant.colony) { own += 1; return; }
    enemy += 1;
    const d = distance(ant.x, ant.y, other.x, other.y);
    if (nearer(best, bestD, other, d)) {
      best = other;
      bestD = d;
    }
  });
  return { own, enemy, nearestEnemy: best };
}

/** For each row offset 0..r, the largest column offset w with w² + dy² ≤ r², or -1 when none. */
const halfWidths = new Map<number, Int32Array>();

function circleHalfWidths(r: number): Int32Array {
  let found = halfWidths.get(r);
  if (found === undefined) {
    found = new Int32Array(r + 1);
    for (let dy = 0; dy <= r; dy += 1) {
      let w = -1;
      while ((w + 1) * (w + 1) + dy * dy <= r * r) w += 1;
      found[dy] = w;
    }
    halfWidths.set(r, found);
  }
  return found;
}

/**
 * Enemies of a colony within r tiles of a queen tile, in forEachNear order, shared
 * by every guard of that queen on one grid. Valid because a grid is a snapshot taken
 * where no ant's position, colony or membership changes while directions are chosen:
 * houseDirection runs only in step's house phase, before movement, combat and hatching.
 */
const intruderCandidates = new WeakMap<Grid, Map<number, readonly Ant[]>>();

function queenIntruders(state: SimState, grid: Grid, colony: ColonyId, qx: number, qy: number, r: number): readonly Ant[] {
  let byQueen = intruderCandidates.get(grid);
  if (byQueen === undefined) {
    byQueen = new Map();
    intruderCandidates.set(grid, byQueen);
  }
  const { mapWidth, mapHeight } = state.config;
  // The key leaves room for four colonies per queen tile.
  const key = (r * mapWidth * mapHeight + qy * mapWidth + qx) * 4 + colony;
  let found = byQueen.get(key);
  if (found === undefined) {
    const list: Ant[] = [];
    forEachNear(state, grid, qx, qy, r, (other) => {
      if (other.colony === colony) return;
      if (!withinTiles(qx, qy, Math.floor(other.x / SUB), Math.floor(other.y / SUB), r)) return;
      list.push(other);
    });
    byQueen.set(key, list);
    found = list;
  }
  return found;
}

/** Nearest enemy to the ant within r tiles of queen tile (qx, qy), lowest id on ties. Exported for tests. */
export function nearestIntruder(state: SimState, grid: Grid, ant: Ant, qx: number, qy: number, r: number): Ant | null {
  let best: Ant | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const other of queenIntruders(state, grid, ant.colony, qx, qy, r)) {
    const d = distance(ant.x, ant.y, other.x, other.y);
    if (nearer(best, bestD, other, d)) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

/** Independent stable draws avoid side/parity and small-id bias; no PRNG consumption. */
function antShare(id: number, salt: number): number {
  let x = Math.imul(id ^ salt, 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) % 1000;
}

/** Private, serializable assignment history; step replaces it on its cloned state. */
interface WorkerGuardRole {
  readonly guarding: boolean;
  readonly changedTick: number;
}
type WorkerGuardState = SimState & { workerGuardRoles?: Readonly<Record<number, WorkerGuardRole>> };

/** Record actual membership, including forced releases, without mutating earlier states. */
export function rememberWorkerGuards(state: SimState, assignments: LocalSoldierAssignments | null): void {
  if (assignments?.workerGuards === undefined) return;
  const previous = (state as WorkerGuardState).workerGuardRoles;
  const roles: Record<number, WorkerGuardRole> = {};
  for (const ant of state.ants) {
    if (ant.caste === "soldier") continue;
    const guarding = assignments.workerGuards.has(ant.id);
    const old = previous?.[ant.id];
    roles[ant.id] = old?.guarding === guarding ? old : {
      guarding, changedTick: old === undefined && !guarding ? state.tick - 2 * state.config.ticksPerSecond : state.tick,
    };
  }
  (state as WorkerGuardState).workerGuardRoles = roles;
}

export interface LocalSoldierAssignments {
  readonly front: ReadonlySet<number>;
  readonly patches: ReadonlySet<number>;
  readonly workerGuards?: ReadonlySet<number>;
  readonly workerRecall?: ReadonlyMap<number, Readonly<QueenState>>;
}

/** One allocation per tick, from living free soldiers; stable priority survives unrelated array ordering. */
export function localSoldierAssignments(state: SimState): LocalSoldierAssignments | null {
  const rules = state.config.localAnts;
  if (rules?.soldierAllocation !== "live_share") return null;
  const front = new Set<number>(), patches = new Set<number>(), workerGuards = new Set<number>();
  const workerRecall = new Map<number, Readonly<QueenState>>();
  for (const colony of state.colonies) {
    // Rules 27: an agent-seated colony's free ants follow local rules only — no front share,
    // patch detail, worker home guard or queen-threat recall — so the colony allocates nothing.
    if (localRulesSide(state, colony.id)) continue;
    const free = state.ants.filter((ant) => ant.colony === colony.id && ant.caste === "soldier" &&
      ant.squad === null && ant.claim === undefined).sort((a, b) => antShare(a.id, 17) - antShare(b.id, 17) || a.id - b.id);
    const selected = free.slice(0, Math.floor(free.length * (rules.soldierFrontSharePermille ?? 0) / 1000));
    for (const ant of selected) front.add(ant.id);
    const details = [...selected].sort((a, b) => antShare(a.id, 53) - antShare(b.id, 53) || a.id - b.id)
      .slice(0, Math.floor(selected.length * (rules.soldierPatchSharePermille ?? 0) / 1000));
    for (const ant of details) patches.add(ant.id);
    if (rules.workerIdlePatchPatrol && selected.length === free.length) {
      // Reserve a standing screen before dispatch, not only once attackers arrive.
      // Ownership and deliveries win; still leave a non-carrier available to forage.
      const workers = state.ants.filter((ant) => ant.colony === colony.id && ant.caste !== "soldier" &&
        ant.squad === null && ant.claim === undefined);
      const roles = (state as WorkerGuardState).workerGuardRoles;
      const priority = (ant: Ant): number => {
        const role = roles?.[ant.id];
        if (role?.guarding) return 0;
        return role !== undefined && state.tick - role.changedTick < 2 * state.config.ticksPerSecond ? 2 : 1;
      };
      // Hold incumbents in and recent releases out. Eligibility and exact staffing
      // take precedence: a held-out worker can still fill an otherwise empty slot.
      const available = workers.filter((ant) => !ant.carrying).sort((a, b) => priority(a) - priority(b) || a.id - b.id);
      const target = Math.max(rules.workerHomeGuardCount ?? 0, Math.floor(workers.length * (rules.workerHomeGuardSharePermille ?? 0) / 1000));
      const count = Math.min(target, Math.max(0, available.length - 1));
      for (const worker of available.slice(0, count)) workerGuards.add(worker.id);
    }
    const threatRange = rules.workerQueenThreatTiles;
    if (rules.workerIdlePatchPatrol && threatRange !== undefined) {
      const threatened = activeQueens(colony).filter((queen) => state.ants.some((ant) => ant.colony !== colony.id &&
        ant.caste === "soldier" && ant.hp > 0 && withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB),
          Math.floor(queen.queenX / SUB), Math.floor(queen.queenY / SUB), threatRange)));
      if (threatened.length > 0) {
        const idle = !(colony.seenFood ?? []).some((tile) => (state.food[tile] ?? 0) > 0);
        const candidates = state.ants.filter((ant) => ant.colony === colony.id && ant.caste !== "soldier" && ant.hp > 0 &&
          ant.squad === null && ant.claim === undefined && !ant.carrying &&
          (!rules.workerHomeGuardHold || !workerGuards.has(ant.id)) &&
          (workerGuards.has(ant.id) || idle || antShare(ant.id, 97) < (rules.workerPatchDispatchSharePermille ?? 0)))
          .map((ant) => {
            const queen = threatened.reduce((best, next) => {
              const d = distance(ant.x, ant.y, next.queenX, next.queenY) - distance(ant.x, ant.y, best.queenX, best.queenY);
              return d < 0 || (d === 0 && next.id < best.id) ? next : best;
            });
            return { ant, queen, distance: distance(ant.x, ant.y, queen.queenX, queen.queenY) };
          }).sort((a, b) => Number(workerGuards.has(b.ant.id)) - Number(workerGuards.has(a.ant.id)) ||
            a.distance - b.distance || a.ant.id - b.ant.id);
        for (const { ant, queen } of candidates.slice(0, Math.max(0, rules.workerQueenRecallCount ?? 0))) workerRecall.set(ant.id, queen);
      }
    }
  }
  return { front, patches, ...(rules.workerIdlePatchPatrol ? { workerGuards } : {}),
    ...(rules.workerQueenThreatTiles === undefined ? {} : { workerRecall }) };
}

const workerScreens = new WeakMap<LocalSoldierAssignments, { readonly state: SimState; readonly tick: number; readonly arrived: ReadonlySet<number> }>();

/**
 * Rules 25 workerGuardSettle: the held worker guards that count as arrived at their queen this tick.
 * A guard within the soft arrival radius of its nearest queen is a root; a guard within the arrival link radius
 * of an arrived worker guard of the same queen is arrived too. Positions are the tick's decision positions,
 * so the screen is computed once per allocation and is independent of ant order. Null without soft separation.
 */
export function settledWorkerScreen(state: SimState, allocation: LocalSoldierAssignments): ReadonlySet<number> | null {
  const soft = state.config.softSeparation;
  if (soft === undefined || allocation.workerGuards === undefined) return null;
  const cached = workerScreens.get(allocation);
  if (cached?.state === state && cached.tick === state.tick) return cached.arrived;
  const arrived = new Set<number>();
  const byQueen = new Map<string, Ant[]>();
  for (const ant of state.ants) {
    if (ant.carrying || ant.squad !== null || ant.claim !== undefined || !allocation.workerGuards.has(ant.id)) continue;
    const home = nearestQueen(state.colonies[ant.colony], ant.x, ant.y);
    if (home === null) continue;
    const key = `${ant.colony}/${home.id}`;
    const members = byQueen.get(key);
    if (members === undefined) byQueen.set(key, [ant]); else members.push(ant);
  }
  const root = soft.arrivalSubunits ** 2, link = soft.arrivalLinkRadius ** 2;
  for (const members of byQueen.values()) {
    const home = nearestQueen(state.colonies[members[0]!.colony], members[0]!.x, members[0]!.y)!;
    const queue = members.filter((ant) => (ant.x - home.queenX) ** 2 + (ant.y - home.queenY) ** 2 <= root);
    for (const ant of queue) arrived.add(ant.id);
    for (let at = 0; at < queue.length; at++) {
      const from = queue[at]!;
      for (const other of members) {
        if (arrived.has(other.id) || (other.x - from.x) ** 2 + (other.y - from.y) ** 2 > link) continue;
        arrived.add(other.id);
        queue.push(other);
      }
    }
  }
  workerScreens.set(allocation, { state, tick: state.tick, arrived });
  return arrived;
}

/** Spread a patch detail between flanks, on the home side. */
function patchDirection(state: SimState, ant: Ant): Vec | null {
  const { config } = state;
  const patches = config.foodPatches.filter((p) => p.tileY !== config.nestTileY);
  if (patches.length === 0) return null;
  const patch = patches[antShare(ant.id, 71) % patches.length]!;
  const homeX = ant.colony === 0 ? patch.tileX : config.mapWidth - 1 - patch.tileX;
  return toward(ant, tileCentre(homeX), tileCentre(patch.tileY), state);
}

/**
 * Rules 27: where an idle worker explores. The goal lies on the ray from its nearest own queen
 * through the ant, where that ray reaches the outermost tile centres; an ant still at the queen
 * aims at a stable per-ant edge tile instead. Points on the ray, not snapped tile centres, which
 * would walk an ant along the edge. Draws no randomness.
 */
function outwardGoal(state: SimState, ant: Ant, home: Readonly<QueenState>): { x: number; y: number } {
  const { mapWidth: w, mapHeight: h } = state.config;
  const dx = ant.x - home.queenX, dy = ant.y - home.queenY;
  if (dx * dx + dy * dy <= (ARRIVE * gridScaleOf(state.config)) ** 2) {
    // Walk the edge tiles clockwise from the top-left corner: top, right, bottom, left.
    let p = Math.floor(antShare(ant.id, 89) * (2 * (w + h) - 4) / 1000);
    let tx: number, ty: number;
    if (p < w - 1) [tx, ty] = [p, 0];
    else if ((p -= w - 1) < h - 1) [tx, ty] = [w - 1, p];
    else if ((p -= h - 1) < w - 1) [tx, ty] = [w - 1 - p, h - 1];
    else [tx, ty] = [0, h - 1 - (p - (w - 1))];
    return { x: tileCentre(tx), y: tileCentre(ty) };
  }
  const reach = (d: number, from: number, size: number): number =>
    d > 0 ? (tileCentre(size - 1) - from) / d : d < 0 ? (tileCentre(0) - from) / d : Infinity;
  const t = Math.min(reach(dx, home.queenX, w), reach(dy, home.queenY, h));
  // Integer subunits: routing measures headings exactly.
  return { x: Math.round(home.queenX + dx * t), y: Math.round(home.queenY + dy * t) };
}

type HouseIntent =
  | { readonly kind: "explore"; readonly x: number; readonly y: number }
  | { readonly kind: "chase" | "pursue"; readonly targetId: number; readonly x: number; readonly y: number }
  | { readonly kind: "post" | "retreat"; readonly homeId: number; readonly x: number; readonly y: number }
  | { readonly kind: "rally"; readonly homeId: number; readonly targetId: number; readonly x: number; readonly y: number }
  | { readonly kind: "queen"; readonly targetId: number; readonly x: number; readonly y: number };
interface IntentHold { readonly intent: HouseIntent; readonly role: Ant["role"]; readonly selectedTick: number }
function sameIntent(a: HouseIntent, b: HouseIntent): boolean {
  return a.kind === b.kind && ("homeId" in a ? a.homeId : null) === ("homeId" in b ? b.homeId : null) &&
    ("targetId" in a ? a.targetId : null) === ("targetId" in b ? b.targetId : null);
}
/** Validate only a competing choice; ordinary same-target ticks need no whole-ant scan. */
function liveIntent(state: SimState, ant: Ant, intent: HouseIntent): HouseIntent | null {
  if (intent.kind === "chase" || intent.kind === "pursue") {
    const enemy = state.ants.find(other => other.id === intent.targetId && other.colony !== ant.colony && other.hp > 0);
    return enemy === undefined ? null : { ...intent, x: enemy.x, y: enemy.y };
  }
  if ("homeId" in intent && !activeQueens(state.colonies[ant.colony]).some(q => q.id === intent.homeId)) return null;
  if ((intent.kind === "rally" || intent.kind === "queen") &&
    !activeQueens(state.colonies[ant.colony === 0 ? 1 : 0]).some(q => q.id === intent.targetId)) return null;
  return intent;
}
/** Hold intent/target, not velocity: live enemies still move and routing is unchanged. */
function assignmentDirection(state: SimState, ant: Ant, desired: HouseIntent): Vec {
  let chosen = desired;
  if (assignmentHolds(state) && ant.squad === null && ant.claim === undefined) {
    const assigned = ant as AssignedAnt, old = assigned.houseIntentHold;
    if (old?.role === ant.role && !sameIntent(old.intent, desired) &&
      state.tick - old.selectedTick < 2 * state.config.ticksPerSecond) {
      chosen = liveIntent(state, ant, old.intent) ?? desired;
    }
    assigned.houseIntentHold = { intent: chosen, role: ant.role,
      selectedTick: old?.role === ant.role && sameIntent(old.intent, chosen) ? old.selectedTick : state.tick };
  }
  if (chosen.kind === "chase" || chosen.kind === "pursue") {
    const enemy = state.ants.find(other => other.id === chosen.targetId);
    if (enemy !== undefined) noteCombat(state, ant, enemy, false);
    return routeToward(state, ant, chosen.x, chosen.y);
  }
  const heading = toward(ant, chosen.x, chosen.y, state);
  if (ant.role === "guard" && chosen.kind === "post") noteGuardPost(state, ant);
  return heading;
}

/** Advance only water rallies toward a live queen's land tile. Navigation still
 * chooses the land route; these samples select a destination, not movement. */
function waterRallyGoal(state: SimState, x: number, y: number, queen: QueenState): Vec {
  const gx = Math.floor(x / SUB), gy = Math.floor(y / SUB);
  if (!isWaterTile(state.terrain, gx, gy)) return { x, y };
  const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
  const steps = Math.max(Math.abs(qx - gx), Math.abs(qy - gy));
  for (let i = 1; i <= steps; i++) {
    const tx = gx + Math.round((qx - gx) * i / steps);
    const ty = gy + Math.round((qy - gy) * i / steps);
    if (!isBlockedTile(state.terrain, tx, ty)) return { x: tileCentre(tx), y: tileCentre(ty) };
  }
  // A live queen is on land; the endpoint is included above. Do not silently
  // revert to the own-bank substitution if a malformed map breaks that rule.
  throw new Error("Water rally has no passable destination toward its enemy queen");
}

/**
 * Local push/retreat on the enemies in the ant's own sight: pursue the nearest where
 * own × 1000 ≥ enemy × pushRatioPermille, otherwise fall back toward home. Null with
 * no enemy in sight. Shared by fighterDirection and the rules-27 local soldier.
 */
function pushOrRetreat(state: SimState, grid: Grid, ant: Ant, home: Readonly<QueenState>): Vec | null {
  // No enemy anywhere near: sightScan would find none, and this returns null for that.
  if (!enemyMayBeInSight(state, grid, ant, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), state.config.sightTiles)) return null;
  const { own, enemy, nearestEnemy: target } = sightScan(state, grid, ant, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), state.config.sightTiles);
  if (enemy === 0) return null;
  if (own * 1000 >= enemy * state.config.pushRatioPermille) {
    if (target !== null) return assignmentDirection(state, ant, { kind: "pursue", targetId: target.id, x: target.x, y: target.y });
  }
  return assignmentDirection(state, ant, { kind: "retreat", homeId: home.id, x: home.queenX, y: home.queenY });
}

function fighterDirection(state: SimState, grid: Grid, ant: Ant): Vec {
  const { config } = state;
  const tx = Math.floor(ant.x / SUB);
  const ty = Math.floor(ant.y / SUB);
  const home = nearestQueen(state.colonies[ant.colony], ant.x, ant.y);
  if (home === null) return ZERO;
  const fight = pushOrRetreat(state, grid, ant, home);
  if (fight !== null) return fight;
  const enemyQueen = nearestQueen(state.colonies[ant.colony === 0 ? 1 : 0], ant.x, ant.y);
  if (enemyQueen === null) return ZERO;
  if (withinTiles(tx, ty, Math.floor(enemyQueen.queenX / SUB), Math.floor(enemyQueen.queenY / SUB), config.sightTiles)) {
    return assignmentDirection(state, ant, { kind: "queen", targetId: enemyQueen.id, x: enemyQueen.queenX, y: enemyQueen.queenY });
  }
  const permille = overMatch(state, config.rallyStartPermille, config.rallyEndPermille);
  const rally = config.queenFounding === undefined ? rallyX(state, ant.colony) : home.queenX + Math.trunc((enemyQueen.queenX - home.queenX) * permille / 1000);
  const goal = waterRallyGoal(state, rally, laneY(state, ant), enemyQueen);
  return assignmentDirection(state, ant, { kind: "rally", homeId: home.id, targetId: enemyQueen.id, ...goal });
}

function guardDirection(state: SimState, grid: Grid, ant: Ant): Vec {
  const colony = state.colonies[ant.colony];
  const home = activeQueens(colony).find((q) => q.id === ant.guardQueenId) ?? nearestQueen(colony, ant.x, ant.y);
  if (home === null) return ZERO;
  const qx = Math.floor(home.queenX / SUB);
  const qy = Math.floor(home.queenY / SUB);
  const intruder = nearestIntruder(state, grid, ant, qx, qy, state.config.guardEngageTiles);
  if (intruder !== null) return assignmentDirection(state, ant, { kind: "chase", targetId: intruder.id, x: intruder.x, y: intruder.y });
  const scale = gridScaleOf(state.config);
  const id = plannerId(state, ant);
  const side = ant.colony === 1 ? -1 : 1;
  const ox = ((id % 3) - 1) * SUB * scale * side;
  const oy = ((Math.trunc(id / 3) % 3) - 1) * SUB * scale;
  return assignmentDirection(state, ant, { kind: "post", homeId: home.id, x: home.queenX + ox, y: home.queenY + oy });
}

/**
 * The house bot's direction for one non-squad ant, from start-of-tick
 * state. An ant with an enemy in combat reach stands and fights. Guards hold by
 * the queen and engage intruders; fighters push where locally stronger, fall
 * back where weaker, and otherwise advance to the rally line; foragers forage.
 * Never called for squad ants. Draws no randomness.
 */
export function houseDirection(state: SimState, grid: Grid, food: readonly number[], ant: Ant): Vec {
  if (ant.carrying) return forageDirection(state, ant, food);
  if (hasAdjacentEnemy(state, grid, ant)) { noteContact(state, ant, grid); return ZERO; }
  if (noteQueenContact(state, ant)) return ZERO;
  switch (ant.role) {
    case "guard":
      return guardDirection(state, grid, ant);
    case "fighter":
      return fighterDirection(state, grid, ant);
    case "forager":
      return forageDirection(state, ant, food, assignmentHolds(state));
  }
}

/**
 * Rules 27: a free seated soldier with no fight to take stays within defendTiles
 * of its hold point instead of its queen. localDirection has already fixed the
 * hold point before any fight could move the soldier.
 */
function holdPointDirection(state: SimState, ant: Ant, r: number): { dir: Vec; foraging: boolean } {
  const tx = Math.floor(ant.x / SUB);
  const ty = Math.floor(ant.y / SUB);
  const { tileX, tileY } = ant.holdPoint!;
  const x = tileCentre(tileX), y = tileCentre(tileY);
  const near = withinTiles(tx, ty, tileX, tileY, r);
  const dir = near ? ZERO : toward(ant, x, y, state);
  noteHoldPoint(state, ant, tileX, tileY, x, y, near);
  return { dir, foraging: false };
}

/**
 * Local ant rules for a free ant of a seated redesign side. An ant with an enemy in combat reach stands and bites. One within
 * defendTiles of its own queen goes for the nearest enemy within defendTiles of
 * her. Under rules 27 a soldier then pushes or falls back on enemies in its own
 * sight. Otherwise a soldier, which cannot carry, stays within defendTiles of its
 * queen; a worker forages the nearest food its colony has seen and carries it
 * home. Returns the direction and whether the ant is foraging.
 */
export function localDirection(state: SimState, grid: Grid, ant: Ant, assignments?: LocalSoldierAssignments | null): { dir: Vec; foraging: boolean } {
  // Rules 27: a soldier without a hold point (newly hatched, or freed other than by a count
  // mark's release) takes the tile it stands on at its first local plan, before any fight moves it.
  if (ant.caste === "soldier" && ant.holdPoint === undefined) {
    ant.holdPoint = { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
  }
  if (ant.carrying) return { dir: forageDirection(state, ant, []), foraging: true };
  if (hasAdjacentEnemy(state, grid, ant)) { noteContact(state, ant, grid); return { dir: ZERO, foraging: false }; }
  if (noteQueenContact(state, ant)) return { dir: ZERO, foraging: false };
  const rules = state.config.localAnts!;
  const r = rules.defendTiles;
  const allocation = assignments === undefined ? localSoldierAssignments(state) : assignments;
  const colony = state.colonies[ant.colony];
  const home = nearestQueen(colony, ant.x, ant.y);
  const tx = Math.floor(ant.x / SUB);
  const ty = Math.floor(ant.y / SUB);
  if (home !== null && rules.workerHomeGuardHold && !ant.carrying && allocation?.workerGuards?.has(ant.id)) {
    const screen = rules.workerGuardSettle === true ? settledWorkerScreen(state, allocation) : null;
    if (screen !== null) {
      const arrived = screen.has(ant.id);
      const dir = arrived ? ZERO : toward(ant, home.queenX, home.queenY, state);
      // Arrived guards are held, not merely zero-heading: soft pushes otherwise keep the screen moving.
      noteGuard(state, ant, home.id, home.queenX, home.queenY, arrived, arrived);
      return { dir, foraging: false };
    }
    const dir = toward(ant, home.queenX, home.queenY, state);
    noteGuard(state, ant, home.id, home.queenX, home.queenY, (ant.x - home.queenX) ** 2 + (ant.y - home.queenY) ** 2 <= ARRIVE ** 2);
    return { dir, foraging: false };
  }
  if (home !== null) {
    const qx = Math.floor(home.queenX / SUB);
    const qy = Math.floor(home.queenY / SUB);
    const near = withinTiles(tx, ty, qx, qy, r);
    if (near) {
      const intruder = enemyMayBeInSight(state, grid, ant, qx, qy, r) ? sightScan(state, grid, ant, qx, qy, r).nearestEnemy : null;
      if (intruder !== null) {
        noteCombat(state, ant, intruder, false);
        return { dir: routeToward(state, ant, intruder.x, intruder.y), foraging: false };
      }
    }
    if (ant.caste === "soldier") {
      // Rules 27: a free seated soldier pushes or falls back on the enemies in its own
      // sight, wherever it is; an enemy queen alone in sight is bitten on contact only, not pursued.
      if (localRulesSide(state, ant.colony)) {
        const fight = pushOrRetreat(state, grid, ant, home);
        if (fight !== null) return { dir: fight, foraging: false };
      }
      // Rules 27: no front share, patch detail or template-patch fallback; the soldier holds its point.
      return holdPointDirection(state, ant, r);
    }
  }
  if (rules.workerIdlePatchPatrol && ant.caste !== "soldier" && !ant.carrying) {
    const defend = allocation?.workerRecall?.get(ant.id);
    if (defend !== undefined) return { dir: toward(ant, defend.queenX, defend.queenY, state), foraging: false };
    if (home !== null && allocation?.workerGuards?.has(ant.id)) {
      const near = withinTiles(tx, ty, Math.floor(home.queenX / SUB), Math.floor(home.queenY / SUB), r);
      const dir = near ? ZERO : toward(ant, home.queenX, home.queenY, state);
      noteGuard(state, ant, home.id, home.queenX, home.queenY, near);
      return { dir, foraging: false };
    }
  }
  const known = colony.seenFood ?? [];
  if (ant.foodTarget >= 0 && !known.includes(ant.foodTarget) && !foodTargetHeld(state, ant) && !hasClusterFoodTarget(state, ant)) ant.foodTarget = -1;
  // Rules 27: no patch dispatch; the free worker forages the closest food its colony knows below.
  const explores = localRulesSide(state, ant.colony);
  if ((rules.workerIdlePatchPatrol || explores) && ant.caste !== "soldier" && !ant.carrying && !foodTargetHeld(state, ant) && !hasClusterFoodTarget(state, ant) &&
      !known.some((tile) => (state.food[tile] ?? 0) > 0)) {
    if (explores) {
      // Rules 27: no template-patch patrol. Explore away from the nest, foraging so food found is taken.
      if (home !== null) {
        const goal = outwardGoal(state, ant, home);
        // At the edge the ray's end moves with the ant: stop there, with no point goal to settle around.
        const atEdge = (goal.x - ant.x) ** 2 + (goal.y - ant.y) ** 2 <= (ARRIVE * gridScaleOf(state.config)) ** 2;
        return { dir: atEdge ? ZERO : toward(ant, goal.x, goal.y, state), foraging: true };
      }
    } else {
      // A depleted patch leaves colony memory. Returning every worker to the queen
      // then prevents rediscovery when it regrows beyond her sight: keep scouting.
      const dir = patchDirection(state, ant);
      if (dir !== null) return { dir, foraging: true };
    }
  }
  return { dir: forageDirection(state, ant, known, rules.workerHomeGuardHold === true), foraging: true };
}

function rebalanceQueenGuards(state: SimState, members: Ant[], colony: ColonyId, budget: number): void {
  const assigned = new Set<Ant>();
  // Rank once per nest, not once per guard: the share can be hundreds of ants.
  const queues = activeQueens(state.colonies[colony]).map((q) => ({ q, next: 0, ordered: members.map((ant) => {
    const held = roleHeld(state, ant);
    return { ant, incumbent: Number(ant.role === "guard" && ant.guardQueenId === q.id),
      heldGuard: Number(ant.role === "guard" && held), heldNonGuard: Number(ant.role !== "guard" && held),
      distance: distance(ant.x, ant.y, q.queenX, q.queenY) };
  }).sort((a, b) => b.incumbent - a.incumbent || b.heldGuard - a.heldGuard || a.heldNonGuard - b.heldNonGuard ||
    a.distance - b.distance || a.ant.id - b.ant.id).map(({ ant }) => ant) }));
  // The caller already applied the colony ceiling and eligible-ant limit.
  for (let slot = 0; queues.length > 0 && slot < Math.min(budget, members.length); slot++) {
    const queue = queues[slot % queues.length]!;
    while (queue.next < queue.ordered.length && assigned.has(queue.ordered[queue.next]!)) queue.next++;
    const ant = queue.ordered[queue.next++]!;
    ant.role = "guard";
    ant.guardQueenId = queue.q.id;
    assigned.add(ant);
  }
  for (const ant of members) if (!assigned.has(ant)) {
    if (ant.guardQueenId !== undefined) ant.guardQueenId = undefined;
    if (ant.role === "guard") ant.role = ant.caste === "soldier" ? "fighter" : "forager";
  }
}

/** Keep the hard ceiling and even split true after casualties, founding and hatching. */
export function enforceQueenGuardCap(state: SimState): void {
  if (state.config.queenFounding?.totalGuardSharePermille === undefined) return;
  for (const colony of state.colonies) {
    if (localRulesSide(state, colony.id)) continue;
    const ants = state.ants.filter((a) => a.colony === colony.id), eligible = ants.filter((a) => a.squad === null && a.claim === undefined);
    rebalanceQueenGuards(state, eligible, colony.id,
      queenGuardTargets(ants.length, eligible.length, activeQueens(colony).length, state.config).assignedTarget);
    for (const ant of eligible) rememberRole(state, ant);
  }
}

export type HouseFoundingReason = "agent_controlled" | "food_reserve" | "opening" | "cooldown" |
  "no_live_queen" | "live_cap" | "no_held_tile" | "spacing" | "validator_refusal" | "founded";
export interface HouseFoundingDecision {
  readonly tick: number; readonly colony: ColonyId; readonly reason: HouseFoundingReason;
  readonly foodStore: number; readonly price: number; readonly reserve: number; readonly threshold: number;
  readonly nextFoundTick: number; readonly liveQueens: number;
  readonly searchedHeldTiles: number | null; readonly eligibleSites: number | null;
  readonly refusalCode: string | null;
}
export type HouseFoundingObserver = (decision: HouseFoundingDecision) => void;

/** Old recorded configs retain their original two-hatch reserve. */
export function houseFoundingReserve(state: SimState): number {
  return state.config.queenFounding?.houseReserveFood ?? 2 * Math.max(state.config.hatchCost, state.config.castes?.soldierCost ?? state.config.hatchCost);
}

/** House-only colonies spend through the same validator as found_queen, never for a seated agent. */
export function houseFounding(state: SimState, tick: number, events: SimEvent[], observe?: HouseFoundingObserver): void {
  const rules = state.config.queenFounding;
  // A four-colony match has no house player: no colony founds a queen it was not told to.
  if (!rules || state.colonies.length > 2) return;
  for (const colony of state.colonies) {
    const foodStore = colony.foodStore, price = queenFoundingCost(colony, rules), reserve = houseFoundingReserve(state);
    const threshold = price + reserve, nextFoundTick = nextQueenFoundingTick(colony, rules), live = activeQueens(colony).length;
    let searchedHeldTiles: number | null = null, eligibleSites: number | null = null;
    const report = (reason: HouseFoundingReason, refusalCode: string | null = null) => observe?.({
      tick, colony: colony.id, reason, foodStore, price, reserve, threshold, nextFoundTick, liveQueens: live,
      searchedHeldTiles, eligibleSites, refusalCode });
    if (state.agents.some((a) => a.colony === colony.id && !a.idle)) { report("agent_controlled"); continue; }
    if (rules.houseReserveFood === undefined ? foodStore <= threshold : foodStore < threshold) { report("food_reserve"); continue; }
    if (tick < nextFoundTick) { report(tick < (rules.firstFoundTick ?? 0) ? "opening" : "cooldown"); continue; }
    if (live === 0) { report("no_live_queen"); continue; }
    if (live >= (rules.maxLiveQueens ?? Infinity)) { report("live_cap"); continue; }
    // Pick held ground close to food capacity, far from established nests. No unearned territory.
    let best = -1, bestScore = -Infinity;
    searchedHeldTiles = 0; eligibleSites = 0;
    for (let t = 0; t < state.owner.length; t++) {
      if (state.owner[t] !== colony.id) continue;
      searchedHeldTiles++;
      const x = t % state.config.mapWidth, y = Math.floor(t / state.config.mapWidth);
      if (state.colonies.some((c) => queenSpacingNests(c, rules).some((q) => (x - Math.floor(q.queenX / SUB)) ** 2 + (y - Math.floor(q.queenY / SUB)) ** 2 < rules.minDistanceTiles ** 2))) continue;
      eligibleSites++;
      let food = 0;
      const scale = gridScaleOf(state.config);
      const left = (Math.floor(x / scale) - 2) * scale, top = (Math.floor(y / scale) - 2) * scale;
      for (let dy = 0; dy < 5 * scale; dy++) for (let dx = 0; dx < 5 * scale; dx++) {
        const fx = left + dx, fy = top + dy;
        if (fx >= 0 && fy >= 0 && fx < state.config.mapWidth && fy < state.config.mapHeight) food += state.foodCap[fy * state.config.mapWidth + fx] ?? 0;
      }
      if (food > bestScore) { best = t; bestScore = food; }
    }
    if (best < 0) { report(searchedHeldTiles === 0 ? "no_held_tile" : "spacing"); continue; }
    const refusal = foundQueen(state, colony.id, best % state.config.mapWidth, Math.floor(best / state.config.mapWidth), tick, events);
    report(refusal === null ? "founded" : "validator_refusal", refusal?.code ?? null);
  }
}
