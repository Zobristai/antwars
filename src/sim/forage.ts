import { landBirthPosition, segmentOnLand } from "./terrain.js";
import { gridScaleOf, resourceCellIndex } from "./gridScale.js";
import { clearLocalGoal, foodWithinReach, noteFood, noteHome, notePoint } from "./localArrival.js";
import { routeToward } from "./navigation.js";
import { SUB } from "./config.js";
import { chebyshev, direction, tileCentre, ZERO, type Vec } from "./geometry.js";
import { activeQueens, nearestQueen, newAnt, tileIndex } from "./map.js";
import { startSpawnWalk } from "./spawnWalk.js";
import type { HatchBlockedRecord } from "./marks.js";
import type { Ant, Brood, Caste, ColonyId, ColonyState, QueenState, SimEvent, SimState } from "./types.js";

/** Indices of tiles holding food, computed once per tick for forager targeting. */
export function foodTiles(state: SimState): number[] {
  const tiles: number[] = [];
  for (let i = 0; i < state.food.length; i += 1) if ((state.food[i] ?? 0) > 0) tiles.push(i);
  return tiles;
}

/** Arrival radius in sub-tile units: closer than this, an ant stops. */
export const ARRIVE = 300;

/** Direction toward a point, or zero once within the arrival radius. */
export function toward(ant: Ant, x: number, y: number, state?: SimState): Vec {
  if (state !== undefined) notePoint(state, ant, x, y, true);
  const dx = x - ant.x;
  const dy = y - ant.y;
  const arrival = ARRIVE * (state === undefined ? 1 : gridScaleOf(state.config));
  if (dx * dx + dy * dy <= arrival * arrival) return ZERO;
  return state === undefined ? direction(dx, dy) : routeToward(state, ant, x, y);
}

interface FoodTargetHold {
  readonly target: number;
  readonly selectedTick: number;
}
type TargetedAnt = Ant & { foodTargetHold?: FoodTargetHold };

/** A local worker's assignment survives brief depletion en route, but never parks it on an empty target. */
export function foodTargetHeld(state: SimState, ant: Ant): boolean {
  const hold = (ant as TargetedAnt).foodTargetHold;
  return state.config.localAnts?.workerHomeGuardHold === true && !ant.carrying && ant.caste !== "soldier" &&
    ant.squad === null && ant.claim === undefined && hold !== undefined && ant.foodTarget >= 0 &&
    hold.target === ant.foodTarget && state.tick - hold.selectedTick < 2 * state.config.ticksPerSecond &&
    ((state.food[ant.foodTarget] ?? 0) > 0 ||
      !foodWithinReach(state, ant, ant.foodTarget));
}

/**
 * The one forage behaviour, shared by house foragers, the forage order and
 * follow trail with no mark: carry food home, otherwise head for the nearest
 * food tile. Ties break by row then colony-relative x. May update ant.foodTarget.
 */
export function forageDirection(state: SimState, ant: Ant, tiles: readonly number[], holdTarget = false): Vec {
  const colony = state.colonies[ant.colony];
  // The nearest queen is found only when the ant heads home; nothing here moves the ant first.
  const goHome = (): Vec => {
    const home = nearestQueen(colony, ant.x, ant.y);
    if (home === null) return ZERO;
    const dir = toward(ant, home.queenX, home.queenY, state);
    noteHome(state, ant, home.id, home.queenX, home.queenY);
    return dir;
  };
  // A soldier cannot carry food: on forage it goes to its queen.
  holdTarget = holdTarget && state.config.localAnts?.workerHomeGuardHold === true && ant.squad === null && ant.claim === undefined;
  if (ant.carrying || ant.caste === "soldier" || !holdTarget) {
    if ((ant as TargetedAnt).foodTargetHold !== undefined) (ant as TargetedAnt).foodTargetHold = undefined;
  }
  if (ant.carrying || ant.caste === "soldier") return goHome();
  const width = state.config.mapWidth;
  if ((ant.foodTarget < 0 || (state.food[ant.foodTarget] ?? 0) <= 0) && !(holdTarget && foodTargetHeld(state, ant))) {
    const atx = Math.floor(ant.x / SUB);
    const aty = Math.floor(ant.y / SUB);
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    const rank = (tile: number): number => Math.floor(tile / width) * width +
      (ant.colony === 0 ? tile % width : width - 1 - tile % width);
    for (const t of tiles) {
      if ((state.food[t] ?? 0) <= 0) continue;
      const dx = (t % width) - atx;
      const dy = Math.floor(t / width) - aty;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && (best < 0 || rank(t) < rank(best)))) {
        bestD = d;
        best = t;
      }
    }
    ant.foodTarget = best;
  }
  if (holdTarget) {
    const targeted = ant as TargetedAnt;
    if (ant.foodTarget < 0) { if (targeted.foodTargetHold !== undefined) targeted.foodTargetHold = undefined; }
    else if (targeted.foodTargetHold?.target !== ant.foodTarget) {
      // Immutable entries survive the ant's shallow clone without sharing mutable history.
      targeted.foodTargetHold = { target: ant.foodTarget, selectedTick: state.tick };
    }
  }
  if (ant.foodTarget < 0) return goHome();
  const tx = ant.foodTarget % width;
  const ty = Math.floor(ant.foodTarget / width);
  const reached = foodWithinReach(state, ant, ant.foodTarget);
  noteFood(state, ant, ant.foodTarget, reached);
  if (reached) return ZERO;
  // The soft arrival radius (0.6 tile at scale 2) can stop an ant in the adjacent
  // resource cell, out of pickup reach; new rules walk on until the cell is reached.
  return routeToward(state, ant, tileCentre(tx), tileCentre(ty), state.config.forageReachArrival === true ? 0 : undefined);
}

/** Forget a worker's chosen food, its assignment hold and its cluster target: its next forage chooses afresh. */
export function dropFoodTarget(ant: Ant): void {
  ant.foodTarget = -1;
  delete (ant as TargetedAnt).foodTargetHold;
  delete ant.softFoodTarget;
}

export function hasClusterFoodTarget(state: SimState, ant: Ant): boolean {
  return state.config.softSeparation !== undefined && ant.softFoodTarget === ant.foodTarget && ant.foodTarget >= 0
    && ((state.food[ant.foodTarget] ?? 0) > 0 || foodTargetHeld(state, ant));
}
/** The sole authorised food-choice override. An empty alternative list delegates
 * to main's ordinary no-food forage fallback, never to an error or a queue.
 */
export function retargetClusterForager(state: SimState, ant: Ant): Vec {
  const old = resourceCellIndex(state.config, ant.foodTarget);
  const alternatives = foodTiles(state).filter(tile => resourceCellIndex(state.config, tile) !== old);
  ant.foodTarget = -1;
  if ((ant as TargetedAnt).foodTargetHold !== undefined) (ant as TargetedAnt).foodTargetHold = undefined;
  if (ant.softFoodTarget !== undefined) ant.softFoodTarget = undefined;
  clearLocalGoal(state, ant);
  const dir = forageDirection(state, ant, alternatives, state.config.localAnts?.workerHomeGuardHold === true);
  if (ant.foodTarget >= 0) ant.softFoodTarget = ant.foodTarget;
  return dir;
}

/** Foraging ants on a food tile pick up 1 food; carriers near their nest deliver it. */
export function pickupAndDeliver(state: SimState, foraging: ReadonlySet<number>): void {
  const { config } = state;
  // Each colony's live queens, read once: delivery changes no queen.
  const live = [activeQueens(state.colonies[0]), activeQueens(state.colonies[1])];
  for (const ant of state.ants) {
    const tx = Math.floor(ant.x / SUB);
    const ty = Math.floor(ant.y / SUB);
    if (ant.carrying) {
      const nests = live[ant.colony]!;
      if (nests.some((q) => chebyshev(tx, ty, Math.floor(q.queenX / SUB), Math.floor(q.queenY / SUB)) <= config.nestDeliverTiles)) {
        ant.carrying = false;
        state.colonies[ant.colony].foodStore += 1;
        state.stats.delivered[ant.colony] += 1;
      }
    } else if (foraging.has(ant.id) && ant.caste !== "soldier") {
      let i = tileIndex(config, tx, ty);
      const scale = gridScaleOf(config);
      if ((state.food[i] ?? 0) <= 0) {
        // A resource cell retains its original pickup footprint, but fine walls
        // still block pickup across water/rock inside that footprint.
        const left = Math.floor(tx / scale) * scale, top = Math.floor(ty / scale) * scale;
        search: for (let y = top; y < top + scale; y++) for (let x = left; x < left + scale; x++) {
          const candidate = tileIndex(config, x, y);
          if ((state.food[candidate] ?? 0) > 0 && segmentOnLand(config, state.terrain,
            ant.x, ant.y, tileCentre(x), tileCentre(y))) { i = candidate; break search; }
        }
      }
      if ((state.food[i] ?? 0) > 0) {
        state.food[i] = (state.food[i] ?? 0) - 1;
        ant.carrying = true;
        ant.foodTarget = -1;
        if (config.softSeparation !== undefined && ant.softFoodTarget !== undefined) ant.softFoodTarget = undefined;
        if ((ant as TargetedAnt).foodTargetHold !== undefined) (ant as TargetedAnt).foodTargetHold = undefined;
      }
    }
  }
}

/**
 * The brood a colony breeds: the choice most of its
 * seated (not idle) agents set. Agents that set none do not vote; no votes, or
 * a tie among the voters, is mixed.
 */
export function colonyBrood(state: SimState, colony: ColonyId): Brood {
  const votes = { workers: 0, soldiers: 0, mixed: 0 };
  for (const agent of state.agents) {
    if (agent.colony === colony && !agent.idle && agent.brood !== undefined) votes[agent.brood] += 1;
  }
  const top = Math.max(votes.workers, votes.soldiers, votes.mixed);
  const leaders = (["workers", "soldiers", "mixed"] as const).filter((b) => votes[b] === top);
  return top === 0 || leaders.length > 1 ? "mixed" : leaders[0]!;
}

/** The caste a colony hatches next: its brood's, with mixed alternating worker, soldier. */
export function nextCaste(state: SimState, colony: ColonyState): Caste {
  const brood = colonyBrood(state, colony.id);
  if (brood === "workers") return "worker";
  if (brood === "soldiers") return "soldier";
  return colony.mixedNext ?? "worker";
}

/**
 * Rules 27: the caste this queen hatches next. In a colony with at least one
 * agent, her own brood (absent: mixed), mixed alternating per queen from worker;
 * otherwise the colony's caste as nextCaste gives it.
 */
export function queenNextCaste(state: SimState, colony: ColonyState, queen: QueenState): Caste {
  if (!state.agents.some((agent) => agent.colony === colony.id)) return nextCaste(state, colony);
  const brood = queen.brood ?? "mixed";
  if (brood === "workers") return "worker";
  if (brood === "soldiers") return "soldier";
  return queen.mixedNext ?? "worker";
}

/**
 * A queen hatches one ant per hatchCost food, at most one per interval, never above the cap.
 * With the rules switch on the caste follows the colony's brood; a soldier costs
 * soldierCost, and the hatch waits until the store covers the next caste.
 * Rules 27: in a colony with an agent each queen follows her own brood instead.
 * Stored hatch timing charges the next caste's full interval at its own nest.
 */
export function hatch(state: SimState, tick: number, events: SimEvent[], observeShortfall?: (record: HatchBlockedRecord) => void): void {
  const { config } = state;
  for (const colony of state.colonies) {
    // Historical states use the colony's original timer; new rules have one timer per live nest.
    const nests = colony.queens === undefined ? [colony] : activeQueens(colony);
    // Rules 27: the same condition queenNextCaste tests; agents never leave the state mid-hatch.
    const ownBrood = colony.queens !== undefined && state.agents.some((agent) => agent.colony === colony.id);
    for (const nest of nests) {
    const caste = config.castes === undefined ? undefined
      : colony.queens === undefined ? nextCaste(state, colony) : queenNextCaste(state, colony, nest as QueenState);
    const cost = caste === "soldier" ? config.castes!.soldierCost : config.hatchCost;
    const interval = config.hatchIntervalTicks *
      (caste === "soldier" ? config.hatchTiming?.soldierIntervalMultiplier ?? 1 : 1);
    if (colony.foodStore < cost) {
      // Food-shortfall measure: the nest could hatch now but for food. Read-only.
      if (observeShortfall !== undefined && tick - nest.lastHatchTick >= interval) {
        let living = 0;
        for (const ant of state.ants) if (ant.colony === colony.id) living += 1;
        if (living < config.colonyCap) {
          observeShortfall({ tick, colony: colony.id, queenId: colony.queens === undefined ? 0 : (nest as QueenState).id, store: colony.foodStore, cost, deficit: cost - colony.foodStore });
        }
      }
      continue;
    }
    if (tick - nest.lastHatchTick < interval) continue;
    let living = 0;
    for (const ant of state.ants) if (ant.colony === colony.id) living += 1;
    if (living >= config.colonyCap) continue;
    const position = landBirthPosition(config, state.terrain, nest.queenX, nest.queenY, colony.id);
    if (position === null) continue;
    const id = state.nextAntId;
    state.nextAntId += 1;
    const born = newAnt(config, id, colony.id, position.x, position.y, caste);
    state.ants.push(born);
    if (colony.queens !== undefined) startSpawnWalk(state, nest as QueenState, born);
    colony.foodStore -= cost;
    if (caste !== undefined && ownBrood) {
      const queen = nest as QueenState;
      if ((queen.brood ?? "mixed") === "mixed") queen.mixedNext = caste === "worker" ? "soldier" : "worker";
    } else if (caste !== undefined && colonyBrood(state, colony.id) === "mixed") colony.mixedNext = caste === "worker" ? "soldier" : "worker";
    nest.lastHatchTick = tick;
    state.stats.hatched[colony.id] += 1;
    events.push({
      type: "hatch",
      tick,
      antId: id,
      colony: colony.id,
      tileX: Math.floor(position.x / SUB),
      tileY: Math.floor(position.y / SUB),
      ...(caste === undefined ? {} : { caste }),
    });
    }
  }
}

/** Regrow patch food on its own cadence. */
export function regrow(state: SimState, tick: number): void {
  if (tick === 0 || tick % state.config.foodRegrowTicks !== 0) return;
  const scale = gridScaleOf(state.config);
  const width = state.config.mapWidth;
  for (let top = 0; top < state.config.mapHeight; top += scale) for (let left = 0; left < width; left += scale) {
    // Exactly one unit regrows per original cell per interval, not per subdivision.
    cell: for (let y = top; y < top + scale; y++) for (let dx = 0; dx < scale; dx++) {
      const x = left + (left < width / 2 ? dx : scale - 1 - dx), i = y * width + x;
      if (state.food[i]! < state.foodCap[i]!) { state.food[i]! += 1; break cell; }
    }
  }
}
