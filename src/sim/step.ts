import { assignPointRests, preparePointRests, type PointRestPreparation } from "./pointSlots.js";
import { moveToPointRest } from "./navigation.js";
import { moveOnLand } from "./terrain.js";
import { applySoftSeparation } from "./softSeparation.js";
import { beginLocalGoals, clearLocalGoal, clusterArrivals, currentLocalGoals, takeLocalGoals, type LocalArrival } from "./localArrival.js";
import { speedPerTick, SUB } from "./config.js";
import { velocity, ZERO, type Vec } from "./geometry.js";
import {
  applyInput,
  countMarkDirection,
  defaultAllocator,
  fillSquads,
  lapseSquads,
  pruneSquads,
  squadDirections,
  trimSquads,
  type Allocator,
  type InputOutcome,
} from "./agents.js";
import { resolveCombat } from "./combat.js";
import { foodTiles, hatch, pickupAndDeliver, regrow, retargetClusterForager } from "./forage.js";
import { enforceQueenGuardCap, houseDirection, houseFounding, localDirection, localSoldierAssignments, rebalanceRoles, rememberWorkerGuards, type HouseFoundingObserver } from "./houseBot.js";
import { buildGrid, cloneState, GridTracker, type Grid } from "./map.js";
import { claimCountMarks, expireMarks, localRulesSide, type StepObservers } from "./marks.js";
import { assignQueenOwners } from "./queenOwners.js";
import { clearReleasedPatrolWaypoints, nextPatrolWaypoint, patrolChains, type PatrolChains } from "./patrol.js";
import { spawnWalkDirection } from "./spawnWalk.js";
import { decideTimeUp, queensKilled, sustainedTerritoryWin, updateOverrun, updateTerritory } from "./territory.js";
import type { ColonyId, InputResult, SimEvent, SimInput, SimState, StepOutput } from "./types.js";
import { createVisibility, recordSeenFood, recordSightings, takeView } from "./view.js";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The original pre-input phase, shared with private match-start preparation. */
function housePhase(state: SimState, gridOf: (state: SimState) => Grid = buildGrid) {
  const { config } = state;
  // 1. Original house phase, before inputs change the world. Never reorder it
  // for active seats: roles, food targets and all later randomness stay stable.
  rebalanceRoles(state);
  const startGrid = gridOf(state);
  const food = foodTiles(state);
  const house = new Map<number, Vec>();
  const foraging = new Set<number>();
  const local = [localRulesSide(state, 0), localRulesSide(state, 1)];
  const soldiers = local.some(Boolean) ? localSoldierAssignments(state) : null;
  rememberWorkerGuards(state, soldiers);
  for (const ant of state.ants) {
    if (ant.squad !== null || ant.claim !== undefined) continue;
    const walk = spawnWalkDirection(state, ant, local[ant.colony] === true);
    if (walk !== null) {
      house.set(ant.id, walk);
      continue;
    }
    if (local[ant.colony]) {
      const own = localDirection(state, startGrid, ant, soldiers);
      house.set(ant.id, own.dir);
      if (own.foraging) foraging.add(ant.id);
      continue;
    }
    house.set(ant.id, houseDirection(state, startGrid, food, ant));
    if (ant.role === "forager") foraging.add(ant.id);
  }

  return { startGrid, food, house, foraging, soldiers };
}

const initialPointRests = new WeakMap<SimState, PointRestPreparation>();

/**
 * Each running match's one neighbour grid, synced at every phase that reads
 * one instead of rebuilt. advance keeps it across ticks; step's copy starts its own.
 */
const liveGrids = new WeakMap<SimState, GridTracker>();
/** The grid tracker a running match's ticks use, once it has ticked; for tests and measurement. */
export function liveGridTracker(state: SimState): GridTracker | undefined {
  return liveGrids.get(state);
}
/** Prepare only private planning/arrival data, never a full tick or a published ant. */
export function prepareInitialPointRests(previous: SimState): PointRestPreparation | undefined {
  if (previous.tick !== 0 || previous.result !== null ||
      previous.config.pointArrival === undefined || previous.config.softSeparation === undefined) return undefined;
  const ready = initialPointRests.get(previous);
  if (ready !== undefined) return ready;
  const planning = cloneState(previous);
  beginLocalGoals(planning);
  housePhase(planning);
  const prepared = preparePointRests(planning, currentLocalGoals(planning));
  takeLocalGoals(planning);
  if (prepared !== undefined) initialPointRests.set(previous, prepared);
  return prepared;
}

/** The same complete intent/arrival/forage/motion phase is used by step and probes. */
/** detail false (the tick's own call, which reads only settledLocalGuards) skips the frame's copies, native positions and motion metrics; play is the same. */
export function advanceSoftAnts(state: SimState, nativeDirections: ReadonlyMap<number, Vec>, foraging: ReadonlySet<number>, chains?: PatrolChains, prepared?: PointRestPreparation, detail = true) {
  const config = state.config, rules = config.softSeparation!;
  const patrol = config.patrolLinkTiles === undefined ? undefined : (chains ?? patrolChains(state));
  // The tick's own call keeps each origin by the ant's place in state.ants, and reads the frame's goals in place:
  // a retarget below replaces only the retargeted ant's own goal, after that ant's goal was read.
  const origins = new Map<number, { x: number; y: number }>(), originList: Vec[] = [];
  if (detail) for (const ant of state.ants) origins.set(ant.id, { x: ant.x, y: ant.y });
  else for (const ant of state.ants) originList.push({ x: ant.x, y: ant.y });
  const decisionGoals = detail ? new Map(currentLocalGoals(state)) : currentLocalGoals(state);
  const pointRests = assignPointRests(state, decisionGoals, prepared);
  const decisionArrival = clusterArrivals(state.ants.filter(ant => !pointRests.has(ant.id)), decisionGoals, rules.arrivalLinkRadius);
  for (const ant of state.ants) {
    const rest = pointRests.get(ant.id); if (rest === undefined) continue;
    const arrived = ant.x === rest.x && ant.y === rest.y;
    decisionArrival.set(ant.id, { key: decisionGoals.get(ant.id)!.key, arrived, native: arrived,
      rootId: arrived ? ant.id : null, parentId: null, hops: arrived ? 0 : null });
  }
  const arrivals = detail ? new Map<number, LocalArrival>(decisionArrival) : decisionArrival;
  const directions = detail ? new Map(nativeDirections) : nativeDirections as Map<number, Vec>;
  const retargeted: number[] = [];
  for (const ant of state.ants) {
    const goal = decisionGoals.get(ant.id), arrival = arrivals.get(ant.id);
    if (arrival?.arrived) directions.set(ant.id, ZERO);
    if (state.config.patrolLinkTiles !== undefined && goal?.kind === 'mark' && arrival?.arrived
      && goal.targetId === ant.patrolWaypoint && ant.claim !== undefined) {
      const own = patrol!.get(ant.claim), target = patrol!.get(goal.targetId!);
      if (own !== undefined && target?.chain === own.chain) nextPatrolWaypoint(ant, patrol!);
    }
    // Rules 27: a seated colony's workers, free or claimed, keep the food they chose
    // and may crowd it; only house-bot sides keep the crowding retarget.
    if (goal?.kind === 'food' && !ant.carrying && ant.caste !== 'soldier' && foraging.has(ant.id)
      && arrival?.arrived && !goal.nativeReached && !(localRulesSide(state, ant.colony))) {
      directions.set(ant.id, retargetClusterForager(state, ant));
      retargeted.push(ant.id);
      const replacement = currentLocalGoals(state).get(ant.id);
      if (replacement === undefined) arrivals.delete(ant.id);
      else arrivals.set(ant.id, { key: replacement.key, native: replacement.nativeReached, arrived: replacement.nativeReached,
        rootId: replacement.nativeReached ? ant.id : null, parentId: null, hops: replacement.nativeReached ? 0 : null });
    }
  }
  const goals = takeLocalGoals(state);
  const speed = speedPerTick(config), maxX = config.mapWidth * SUB - 1, maxY = config.mapHeight * SUB - 1;
  for (const ant of state.ants) {
    if (ant.softFoodTarget !== undefined && goals.get(ant.id)?.kind !== 'food') ant.softFoodTarget = undefined;
    const rest = pointRests.get(ant.id);
    if (rest !== undefined) {
      moveToPointRest(state, ant, rest, speed);
      continue;
    }
    const dir = directions.get(ant.id) ?? ZERO;
    if (state.terrain !== undefined) moveOnLand(config, state.terrain, ant, dir, speed);
    else { const v = velocity(dir, speed); ant.x = clamp(ant.x + v.x, 0, maxX); ant.y = clamp(ant.y + v.y, 0, maxY); ant.vx = v.x; ant.vy = v.y; }
  }
  const nativePositions = new Map<number, { x: number; y: number }>();
  // Hold only a currently reachable, selected guard post. No historical arrival
  // survives a changed goal, lost contact chain, or combat choice on the next tick.
  const settledGuards = new Set<number>();
  // Local-rules guards settled at their queen stay soft, not held, but feel only the
  // small radius instead of the soldier personal space. Absent on stored matches.
  const settledLocalGuards = new Set<number>(), guardSettle = rules.guardSettle === true;
  // One pass in ant order fills all three exactly as the separate map and filters would.
  for (const ant of state.ants) {
    if (detail) nativePositions.set(ant.id, { x: ant.x, y: ant.y });
    const goal = goals.get(ant.id);
    if (goal === undefined) continue;
    if (goal.guardPost && arrivals.get(ant.id)?.arrived) settledGuards.add(ant.id);
    if (guardSettle && goal.kind === 'guard' && arrivals.get(ant.id)?.arrived) settledLocalGuards.add(ant.id);
  }
  const motion = applySoftSeparation(state, detail ? origins : originList, settledGuards, patrol, pointRests, settledLocalGuards, detail, true);
  return { pointRests, goals, decisionGoals, arrivals, decisionArrival, nativeDirections, directions, origins, nativePositions, retargeted, settledLocalGuards, motion };
}

/**
 * Server-only terminal control for one tick: operator stop (true), rated house
 * abandonment, or an idle end naming the colonies whose seats went idle (one or both).
 */
export type ServerTerminal = boolean | "abandoned" | { readonly idle: readonly ColonyId[] };

/**
 * Advance the match by one tick: step(state, inputsForTick) -> { state, events, results }.
 * Pure: the input state is not modified (the tick runs on a copy). Inputs apply in the given order.
 * The live server and replay re-runs use advance, which runs the same tick in place.
 *
 * Phases, in order:
 * 1. roles and house-bot directions, from the start-of-tick state, before any input;
 * 2. agent inputs; 3. squad timer, then squads fill in join order;
 * command-idle rules settle expiry before phase 1 from the previous tick's
 * accepted commands; a command waking a seat changes free-ant planning next tick;
 * 4. velocities (house bot for non-squad ants, orders for squads; marks steer squads only under follow_trail);
 * 5. movement; 6. combat and deaths; 7. territory; 8. food and hatching;
 * 9. squad upkeep and mark expiry; 10. overrun and time-up;
 * 11. fogged sightings, then one result (with the agent's view) per input.
 *
 * Variants only: count-mark claims are settled after squads fill and
 * claimed ants follow their mark, and claims are trimmed back to their share
 * after the tick's deaths and births; a seated redesign side's free ants follow
 * local ant rules; queens with HP replace the overrun timer. observers watch
 * the comparison measures and never change state or order.
 */
export function step(
  previous: SimState,
  inputs: readonly SimInput[] = [],
  allocator: Allocator = defaultAllocator,
  observeHouseFounding?: HouseFoundingObserver,
  observers?: StepObservers,
  /** Server-only terminal tick; not an agent input or a simulation rule. */
  stopNow: ServerTerminal = false,
  /** Logged server policy: live seats never lapse into command-idle takeover. */
  houseActive = false,
): StepOutput {
  return tickInPlace(cloneState(previous), initialPointRests.get(previous), inputs, allocator, observeHouseFounding, observers, stopNow, houseActive);
}

/**
 * The same tick as step, run in place: the given state is modified and returned
 * as out.state, with no whole-state copy. Identical play to step on the same input.
 */
export function advance(
  state: SimState,
  inputs: readonly SimInput[] = [],
  allocator: Allocator = defaultAllocator,
  observeHouseFounding?: HouseFoundingObserver,
  observers?: StepObservers,
  /** Server-only terminal tick; not an agent input or a simulation rule. */
  stopNow: ServerTerminal = false,
  /** Logged server policy: live seats never lapse into command-idle takeover. */
  houseActive = false,
): StepOutput {
  // Point rests are prepared only for a tick-0 state; the same object must not reuse them on a later tick.
  const prepared = state.tick === 0 ? initialPointRests.get(state) : undefined;
  return tickInPlace(state, prepared, inputs, allocator, observeHouseFounding, observers, stopNow, houseActive);
}

function tickInPlace(
  state: SimState,
  preparedPointRests: PointRestPreparation | undefined,
  inputs: readonly SimInput[],
  allocator: Allocator,
  observeHouseFounding: HouseFoundingObserver | undefined,
  observers: StepObservers | undefined,
  stopNow: ServerTerminal,
  houseActive: boolean,
): StepOutput {
  const events: SimEvent[] = [];
  const { config } = state;
  const tick = state.tick;

  if (state.result !== null) {
    const grid = buildGrid(state);
    const results: InputResult[] = inputs.map((input) => {
      const agent = state.agents.find((a) => a.id === input.agentId);
      return {
        ok: false,
        error: { code: "match_over", message: "This match has ended; call join for the next match." },
        view: agent === undefined ? null : takeView(state, grid, agent),
      };
    });
    return { state, events, results };
  }

  let tracker = liveGrids.get(state);
  if (tracker === undefined) { tracker = new GridTracker(); liveGrids.set(state, tracker); }
  const liveGrid = (s: SimState): Grid => tracker.sync(s);

  if (config.softSeparation !== undefined) beginLocalGoals(state);

  // Settle command-idle expiry once, from the previous tick's accepted commands.
  // Waking commands apply below, so free-ant planning takes control back next tick.
  if (!houseActive && config.commandIdleTicks !== undefined) lapseSquads(state, tick, events);

  const { startGrid, food, house, foraging, soldiers } = housePhase(state, liveGrid);

  // 2-3. Agent inputs, squad timer, squad supply.
  const outcomes: InputOutcome[] = [];
  for (const input of inputs) {
    const outcome = applyInput(state, input, tick, allocator, events);
    outcomes.push(outcome);
    events.push({ type: "agent_call", tick, agentId: input.agentId, call: input.type, accepted: outcome.error === null });
  }
  // Rules 27: a live queen still unowned once the tick's agents have joined is drawn an owner.
  assignQueenOwners(state);
  if (!houseActive && config.commandIdleTicks === undefined) lapseSquads(state, tick, events);
  fillSquads(state, allocator, tick, events);
  // Rules 27 REMOVE: the claim pass releases the removed marks' ants, which the
  // house phase skipped while claimed; they start their defaults this tick.
  const removed = new Set(outcomes.flatMap((outcome) => outcome.removedMarkId === undefined ? [] : [outcome.removedMarkId]));
  const unmarked = removed.size === 0 ? [] : state.ants.filter((ant) => ant.claim !== undefined && removed.has(ant.claim));
  claimCountMarks(state, tick, observers);
  for (const ant of unmarked) {
    if (ant.squad !== null || ant.claim !== undefined || !localRulesSide(state, ant.colony)) continue;
    // A released ant never resumes a spawn walk; it ends at claim time.
    delete ant.spawnWalk;
    const own = localDirection(state, startGrid, ant, soldiers ?? undefined);
    house.set(ant.id, own.dir);
    if (own.foraging) foraging.add(ant.id);
  }
  if (observers?.claims !== undefined && config.countMarks !== undefined) {
    observers.claims({ tick, claims: state.ants.filter((a) => a.claim !== undefined).map((a) => ({ antId: a.id, markId: a.claim! })) });
  }

  // 4-5. Velocities and movement.
  for (const mark of state.marks) mark.steering = 0;
  const softMode = config.softSeparation !== undefined;
  // Soft mode sets every ant's direction below, so it fills the house map in place instead of a copy:
  // a free ant's entry is read before it is set, and squad entries are only squad members'.
  const dirs = softMode ? house : new Map<number, Vec>();
  if (softMode) for (const ant of state.ants) if (ant.squad !== null || ant.claim !== undefined) clearLocalGoal(state, ant);
  const squadForaging = new Set<number>();
  for (const agent of state.agents) {
    const squad = squadDirections(state, startGrid, food, agent, tick);
    for (const [id, dir] of squad.dirs) dirs.set(id, dir);
    for (const id of squad.foraging) squadForaging.add(id);
  }
  const speed = speedPerTick(config);
  const maxX = config.mapWidth * SUB - 1;
  const maxY = config.mapHeight * SUB - 1;
  const markById = new Map(state.marks.map((m) => [m.id, m]));
  const patrol = config.patrolLinkTiles === undefined ? undefined : patrolChains(state);
  if (config.patrolLinkTiles !== undefined) clearReleasedPatrolWaypoints(state);
  for (const ant of state.ants) {
    let dir: Vec;
    if (ant.squad !== null) {
      dir = dirs.get(ant.id) ?? ZERO;
      if (squadForaging.has(ant.id)) foraging.add(ant.id);
      else foraging.delete(ant.id);
    } else if (ant.claim !== undefined) {
      const claimed = countMarkDirection(state, startGrid, food, ant, markById.get(ant.claim)!, patrol);
      dir = claimed.dir;
      if (claimed.foraging) foraging.add(ant.id);
      else foraging.delete(ant.id);
    } else {
      dir = house.get(ant.id) ?? ZERO;
    }
    if (softMode) { dirs.set(ant.id, dir); continue; }
    if (state.terrain !== undefined) { moveOnLand(config, state.terrain, ant, dir, speed); continue; }
    const v = velocity(dir, speed);
    ant.vx = v.x;
    ant.vy = v.y;
    ant.x = clamp(ant.x + ant.vx, 0, maxX);
    ant.y = clamp(ant.y + ant.vy, 0, maxY);
  }

  if (softMode) {
    const frame = advanceSoftAnts(state, dirs, foraging, patrol, preparedPointRests, false);
    observers?.settledLocalGuards?.({ tick, antIds: frame.settledLocalGuards });
  }

  // 6. Combat on the moved positions.
  resolveCombat(state, liveGrid(state), tick, events);
  pruneSquads(state);

  // 7. Territory on the survivors.
  // Territory reads the ants, not a grid: no sync is needed for it.
  updateTerritory(state, undefined, tick);

  // 8. Food, house-only founding, and hatching. Founding cannot take an agent colony's store.
  houseFounding(state, tick, events, observeHouseFounding);
  // Rules 27: a queen the house founded for an all-idle seated colony is drawn an owner too.
  assignQueenOwners(state);
  pickupAndDeliver(state, foraging);
  hatch(state, tick, events, observers?.hatchBlocked);
  regrow(state, tick);

  // 9. Squads stay within half the colony; marks fade.
  trimSquads(state, tick, events);
  expireMarks(state, tick + 1);
  if (config.patrolLinkTiles !== undefined) clearReleasedPatrolWaypoints(state);

  // 10. Win conditions.
  // Overrun counts the ants alive now, including any hatched this tick.
  let result = config.queenHp !== undefined ? queensKilled(state, tick) : updateOverrun(state, liveGrid(state), tick, events);
  if (result === null) result = sustainedTerritoryWin(state, tick);
  if (result === null && (stopNow || tick + 1 >= config.matchTicks)) result = decideTimeUp(state, tick, "time_up");
  // A server abandonment has no winner, even if a natural win coincides with
  // its terminal tick. Historical ticks (including operator stop) are unchanged.
  if (stopNow === "abandoned") result = { winner: null, reason: "abandoned", decidedBy: "draw", tick };
  // A server idle end likewise decides its terminal tick: the idle colony loses; both idle is a draw.
  if (typeof stopNow === "object") result = stopNow.idle.length === 1
    ? { winner: stopNow.idle[0] === 0 ? 1 : 0, reason: "idle", decidedBy: "idle", tick }
    : { winner: null, reason: "idle", decidedBy: "draw", tick };
  enforceQueenGuardCap(state);
  state.tick = tick + 1;
  if (result !== null) {
    state.result = result;
    events.push({ type: "match_end", tick, result });
  }

  // 11. Fog, then each call's result with its view.
  const visibility = createVisibility(state);
  recordSightings(state, events, visibility);
  recordSeenFood(state, visibility);
  // Only the views read the end-of-tick grid: a tick without inputs syncs none.
  const endGrid = outcomes.length === 0 ? undefined : liveGrid(state);
  const results: InputResult[] = outcomes.map((outcome) => {
    const agent = state.agents.find((a) => a.id === outcome.agentId);
    const baseView = agent === undefined ? null : takeView(state, endGrid!, agent, visibility);
    const view = baseView === null || outcome.countMarkAcceptance === undefined ? baseView
      : { ...baseView, events: [...baseView.events, outcome.countMarkAcceptance] };
    if (outcome.error === null && view !== null) return outcome.broodSet === undefined ? { ok: true, view } : { ok: true, view, broodSet: outcome.broodSet };
    return { ok: false, error: outcome.error ?? { code: "unknown_agent", message: "No such agent." }, view };
  });
  return { state, events, results };
}

