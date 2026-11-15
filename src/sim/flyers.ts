/**
 * Flyers: worker-caste ants that fly. What a flyer is doing is read from its own fields, so the agent
 * view and the spectator stream report one state from one rule.
 *
 * A flyer mark's claim flies one straight at flight speed over water, rock and ants toward its mark's
 * current tile. On ATTACK and DEFEND it lands on arrival, starting its lockout, and then acts as a ground
 * ant on the verb; on GATHER, LINE and PATROL it stays airborne: hovering over the tile, its LINE spot or
 * a lone PATROL mark, or flying a PATROL chain without stopping. Airborne flyers stay in state.ants.
 */
import { SUB, type SimConfig } from "./config.js";
import { distance, idiv, tileCentre, ZERO, type Vec } from "./geometry.js";
import { toward } from "./forage.js";
import { flyerLineSpotOf } from "./lineMarks.js";
import { noteHoldPoint } from "./localArrival.js";
import { nextPatrolWaypoint, patrolWaypoint, type PatrolChains } from "./patrol.js";
import type { Ant, Mark, SimEvent, SimState } from "./types.js";

export type FlyerStateName = "grounded" | "flying" | "hovering" | "lockedOut";

/** A flyer's displayed state: its take-off tick while locked out, its destination (sub-tile units) while airborne. */
export interface FlyerState { readonly state: FlyerStateName; readonly takeOffTick?: number; readonly destX?: number; readonly destY?: number }

/**
 * The state of a flyer once processedTick, the last tick the state has completed (state.tick - 1 after step), is
 * done: null for a non-flyer; airborne, hovering or flying toward its destination; on the ground, locked out until
 * its take-off tick, then grounded.
 */
export function flyerState(ant: Ant, processedTick: number): FlyerState | null {
  if (ant.flyer !== true) return null;
  const air = ant.air;
  if (air !== undefined) return { state: air.hovering ? "hovering" : "flying", destX: air.destX, destY: air.destY };
  if (ant.takeOffTick !== undefined && processedTick < ant.takeOffTick) return { state: "lockedOut", takeOffTick: ant.takeOffTick };
  return { state: "grounded" };
}

/**
 * A free grounded flyer's direction: it holds its hold point, the tile it hatched on, landed on or was released on.
 * Off that tile it walks back toward the tile's centre; on it, or with no hold point, it stays put. It settles like a
 * rules-27 soldier holding its point, clustered per hold tile, so flyers sharing a hold tile rest beside it, and
 * keepOnHoldTiles stops any spacing push at the tile's edge.
 */
export function freeFlyerDirection(state: SimState, ant: Ant): Vec {
  const hold = ant.holdPoint;
  if (hold === undefined) return ZERO;
  const x = tileCentre(hold.tileX), y = tileCentre(hold.tileY);
  const on = Math.floor(ant.x / SUB) === hold.tileX && Math.floor(ant.y / SUB) === hold.tileY;
  const dir = on ? ZERO : toward(ant, x, y, state);
  noteHoldPoint(state, ant, hold.tileX, hold.tileY, x, y, on);
  return dir;
}

/** The free grounded flyers standing on their hold tile before this tick's ground movement. */
export function heldFlyers(state: SimState): Ant[] {
  return state.ants.filter((ant) => ant.flyer === true && ant.air === undefined && ant.squad === null && ant.claim === undefined &&
    ant.holdPoint !== undefined && Math.floor(ant.x / SUB) === ant.holdPoint.tileX && Math.floor(ant.y / SUB) === ant.holdPoint.tileY);
}

/**
 * After ground movement each held flyer is back inside its hold tile: soft spacing may push it, but never off the tile,
 * so a flyer stays where it hatched (or landed, or was released) however many flyers share that tile.
 */
export function keepOnHoldTiles(held: readonly Ant[]): void {
  for (const ant of held) {
    const hold = ant.holdPoint!;
    ant.x = Math.min(Math.max(ant.x, hold.tileX * SUB), hold.tileX * SUB + SUB - 1);
    ant.y = Math.min(Math.max(ant.y, hold.tileY * SUB), hold.tileY * SUB + SUB - 1);
  }
}

/** Flight distance per tick in sub-tile units: speed in the match map's tiles, never grid-scaled. */
export function flightStep(config: SimConfig): number {
  return Math.trunc((config.flyers!.speedTilesPerSecond * SUB) / config.ticksPerSecond);
}

/** Verbs whose flyers stay airborne; every other flyer mark lands its flyers on arrival. */
function airborneVerb(mark: Mark): boolean {
  return mark.verb === "GATHER" || mark.verb === "LINE" || mark.verb === "PATROL";
}

/**
 * Where a claimed flyer heads this tick, read from its mark's current tile: ATTACK, DEFEND and GATHER
 * the mark tile's centre; PATROL its current waypoint's tile centre (a lone mark is its own waypoint);
 * LINE its spot, or the destination it already has when no spot passes (null when it has none).
 */
function destinationOf(state: SimState, ant: Ant, mark: Mark, chains: PatrolChains | undefined): Vec | null {
  if (mark.verb === "LINE") return flyerLineSpotOf(state, mark, ant) ?? (ant.air === undefined ? null : { x: ant.air.destX, y: ant.air.destY });
  const own = mark.verb === "PATROL" ? chains?.get(mark.id) : undefined;
  const target = own === undefined ? mark : patrolWaypoint(ant, own, chains!);
  return { x: tileCentre(target.tileX), y: tileCentre(target.tileY) };
}

/**
 * A PATROL chain with waypoints on two or more tiles, which its flyers fly without stopping. A chain
 * whose marks all lie on one tile is held like a lone mark: its flyers hover over that tile.
 */
function sweeping(mark: Mark, chains: PatrolChains | undefined): boolean {
  if (mark.verb !== "PATROL") return false;
  const chain = chains?.get(mark.id)?.chain;
  return chain !== undefined && chain.some((w) => w.tileX !== chain[0]!.tileX || w.tileY !== chain[0]!.tileY);
}

/**
 * Turn a sweeping flyer standing on its waypoint for the next waypoint in chain order that lies on
 * another tile, passing over any laid on the tile it stands on; a sweeping chain always has one.
 */
function turnAtWaypoint(ant: Ant, chains: PatrolChains): void {
  const tileX = Math.floor(ant.x / SUB), tileY = Math.floor(ant.y / SUB);
  for (let turns = chains.get(ant.patrolWaypoint!)?.chain.length ?? 0; turns > 0; turns--) {
    nextPatrolWaypoint(ant, chains);
    const at = chains.get(ant.patrolWaypoint!)!;
    const waypoint = at.chain[at.position]!;
    if (waypoint.tileX !== tileX || waypoint.tileY !== tileY) return;
  }
}

function tileEvent(ant: Ant, tick: number) {
  return { tick, tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB), antId: ant.id, colony: ant.colony };
}

/**
 * A PATROL flyer keeps its own mark's tile and the chain it flies, its marks' ids in laid order. When the chain
 * changes (a mark removed, re-cast, expired, moved in or out of range, or newly linked) it re-targets the nearest
 * mark of the chain it is on now, even where its old waypoint is still in the chain. When the chain is the same but
 * its own mark has moved, it turns for that mark's new tile.
 */
function notePatrol(ant: Ant, mark: Mark, chains: PatrolChains | undefined): void {
  const ids = chains?.get(mark.id)?.chain.map((m) => m.id) ?? [mark.id];
  const last = ant.flyerPatrol;
  if (last !== undefined) {
    const sameChain = last.chain.length === ids.length && last.chain.every((id, i) => id === ids[i]);
    const sameTile = last.markId === mark.id && last.tileX === mark.tileX && last.tileY === mark.tileY;
    if (sameChain && sameTile) return;
    if (!sameChain) delete ant.patrolWaypoint;
    else if (last.markId === mark.id) ant.patrolWaypoint = mark.id;
  }
  ant.flyerPatrol = { markId: mark.id, tileX: mark.tileX, tileY: mark.tileY, chain: ids };
}

/** Land at once where it stands: the lockout starts, and with no mark it holds this tile. */
function land(state: SimState, ant: Ant, tick: number, events: SimEvent[], mark: Mark | undefined): void {
  delete ant.air;
  delete ant.flyerPatrol;
  ant.takeOffTick = tick + state.config.flyers!.lockoutTicks;
  ant.holdPoint = { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
  if (mark === undefined) delete ant.flyerLanded;
  else ant.flyerLanded = { markId: mark.id, tileX: mark.tileX, tileY: mark.tileY };
  events.push({ type: "flyer_landing", ...tileEvent(ant, tick) });
}

/**
 * Whether the flyer mark claiming this grounded flyer sends it into the air: always on GATHER, LINE and
 * PATROL; on ATTACK or DEFEND unless it has already landed for this mark at the mark's current tile (a new
 * claim, or the mark moved). Until it can take off it waits where it stands, never walking that order.
 */
export function awaitsFlight(ant: Ant, mark: Mark): boolean {
  if (airborneVerb(mark)) return true;
  const landed = ant.flyerLanded;
  return landed === undefined || landed.markId !== mark.id || landed.tileX !== mark.tileX || landed.tileY !== mark.tileY;
}

/** Whether a grounded flyer claimed by this mark takes off now: its lockout is over and its order sends it up. */
function takesOff(ant: Ant, mark: Mark, tick: number): boolean {
  return (ant.takeOffTick === undefined || tick >= ant.takeOffTick) && awaitsFlight(ant, mark);
}

/** One straight flight step toward (x, y); within one step it stands on it. Ignores terrain and ants. */
function flyToward(ant: Ant, x: number, y: number, step: number): void {
  const d = distance(ant.x, ant.y, x, y);
  const nx = d <= step ? x : ant.x + idiv((x - ant.x) * step, d);
  const ny = d <= step ? y : ant.y + idiv((y - ant.y) * step, d);
  ant.vx = nx - ant.x;
  ant.vy = ny - ant.y;
  ant.x = nx;
  ant.y = ny;
}

/**
 * The flight pass, once a tick in the movement phase, after claims and before any ground ant moves
 * and before combat: take-offs, flight, arrivals, hovering and landings. A flyer taking off this
 * tick is airborne before combat; one landing this tick is on the ground before combat. Returns the
 * flyers that were airborne during this tick, in state.ants order: they have moved, and they sit out
 * ground directions and ground movement for the tick.
 */
export function flyFlyers(state: SimState, marks: ReadonlyMap<number, Mark>, chains: PatrolChains | undefined, tick: number, events: SimEvent[]): Ant[] {
  const flown: Ant[] = [];
  const step = flightStep(state.config);
  for (const ant of state.ants) {
    if (ant.flyer !== true) continue;
    const mark = ant.claim === undefined ? undefined : marks.get(ant.claim);
    if (ant.air === undefined) {
      if (mark === undefined || !takesOff(ant, mark, tick)) continue;
      const dest = destinationOf(state, ant, mark, chains);
      // A LINE flyer with no spot that passes stays on the ground.
      if (dest === null) continue;
      events.push({ type: "flyer_takeoff", ...tileEvent(ant, tick) });
      delete ant.flyerLanded;
      ant.air = { destX: dest.x, destY: dest.y, hovering: false, released: false };
    } else if (mark === undefined && !ant.air.released) {
      ant.air = { ...ant.air, released: true };
    }
    flown.push(ant);
    const air = ant.air;
    if (air.released) {
      // An ended order: a hoverer lands on the tile under it at once; a flyer in flight flies on
      // to the destination it was heading for and lands there.
      if (air.hovering) { ant.vx = 0; ant.vy = 0; }
      else flyToward(ant, air.destX, air.destY, step);
      if (air.hovering || (ant.x === air.destX && ant.y === air.destY)) land(state, ant, tick, events, undefined);
      continue;
    }
    const claimed = mark!;
    if (claimed.verb === "PATROL") notePatrol(ant, claimed, chains);
    let dest = destinationOf(state, ant, claimed, chains)!;
    // A sweeping flyer standing on its waypoint (a chain that just grew, changed or gained a second tile) heads on at once.
    if (sweeping(claimed, chains) && ant.x === dest.x && ant.y === dest.y) {
      turnAtWaypoint(ant, chains!);
      dest = destinationOf(state, ant, claimed, chains)!;
    }
    flyToward(ant, dest.x, dest.y, step);
    const arrived = ant.x === dest.x && ant.y === dest.y;
    if (arrived && !airborneVerb(claimed)) {
      land(state, ant, tick, events, claimed);
      continue;
    }
    if (arrived && sweeping(claimed, chains)) {
      // Reaching a waypoint is not a stop: it turns for the next one on another tile.
      turnAtWaypoint(ant, chains!);
      dest = destinationOf(state, ant, claimed, chains)!;
      ant.air = { destX: dest.x, destY: dest.y, hovering: false, released: false };
      continue;
    }
    ant.air = { destX: dest.x, destY: dest.y, hovering: arrived, released: false };
  }
  return flown;
}

/** Take the given ants (in state.ants order) out of state.ants for the ground movement phase. */
export function liftAnts(state: SimState, lifted: readonly Ant[]): void {
  if (lifted.length === 0) return;
  const out = new Set(lifted);
  state.ants = state.ants.filter((ant) => !out.has(ant));
}

/** Return lifted ants to state.ants in id order; both lists are in ascending id order, as hatching appends. */
export function mergeAnts(state: SimState, lifted: readonly Ant[]): void {
  if (lifted.length === 0) return;
  const merged: Ant[] = [], ants = state.ants;
  let i = 0, j = 0;
  while (i < ants.length || j < lifted.length) {
    if (j >= lifted.length || (i < ants.length && ants[i]!.id < lifted[j]!.id)) merged.push(ants[i++]!);
    else merged.push(lifted[j++]!);
  }
  state.ants = merged;
}
