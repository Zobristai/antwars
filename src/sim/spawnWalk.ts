import { SUB } from "./config.js";
import { tileCentre, withinTiles, type Vec } from "./geometry.js";
import { gridScaleOf } from "./gridScale.js";
import { clearLocalGoal } from "./localArrival.js";
import { localRulesSide } from "./marks.js";
import { routeToward } from "./navigation.js";
import type { Ant, QueenState, SimState } from "./types.js";

/**
 * Rules 27 arrival radii in reference tiles (scaled to the config grid): a walking
 * worker arrives within 1 tile of its spawn tile, a soldier on entering the 3 tiles
 * it then holds within. Exact-tile arrival would let held
 * soldiers block later walkers.
 */
export const SPAWN_ARRIVAL_TILES = { worker: 1, soldier: 3 } as const;

/** Rules 27: a newborn of a seated colony walks to the spawn point its queen has now, if any. */
export function startSpawnWalk(state: SimState, queen: QueenState, ant: Ant): void {
  const point = queen.spawnPoint;
  if (point === undefined || !localRulesSide(state, ant.colony)) return;
  ant.spawnWalk = { queenId: queen.id, tileX: point.tileX, tileY: point.tileY };
}

/**
 * Rules 27 house phase for a free ant walking to a spawn point: its direction, or
 * null when it takes its ordinary planning this tick. A walk ends for good when its
 * colony has no active seat (house-bot planning takes the ant) and on arrival, where
 * a soldier takes the spawn tile as its hold point and both castes start their
 * rules-27 defaults the same tick. A moved or cleared spawn point does not change it.
 */
export function spawnWalkDirection(state: SimState, ant: Ant, seated: boolean): Vec | null {
  const walk = ant.spawnWalk;
  if (walk === undefined) return null;
  const tiles = SPAWN_ARRIVAL_TILES[ant.caste === "soldier" ? "soldier" : "worker"] * gridScaleOf(state.config);
  if (!seated || withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), walk.tileX, walk.tileY, tiles)) {
    delete ant.spawnWalk;
    if (seated && ant.caste === "soldier") ant.holdPoint = { tileX: walk.tileX, tileY: walk.tileY };
    return null;
  }
  const dir = routeToward(state, ant, tileCentre(walk.tileX), tileCentre(walk.tileY));
  // A walker passes through: no resting slot or cluster arrival short of its arrival radius.
  clearLocalGoal(state, ant);
  return dir;
}
