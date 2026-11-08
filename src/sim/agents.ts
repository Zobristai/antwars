import { isRockTile, isWaterTile } from "./terrain.js";
import { softMarkHeading } from "./softSeparation.js";
import { noteCombat, noteContact, noteMark } from "./localArrival.js";
import { routeToward } from "./navigation.js";
import { COUNT_MARK_MAX_COUNT, COUNT_MARK_MAX_COUNT_TEXT, SUB } from "./config.js";
import { distance, tileCentre, withinTiles, ZERO, type Vec } from "./geometry.js";
import { forageDirection, toward } from "./forage.js";
import { activeQueens, forEachNear, hasAdjacentEnemy, nextQueenFoundingTick, queenFoundingCost, queenSpacingNests, queensOf, tileIndex, type Grid } from "./map.js";
import { countMarkCasteEligible, localRulesSide, markDirection, parseWords, releaseClaim, trailMark } from "./marks.js";
import { lineSpotOf } from "./lineMarks.js";
import { countMarkVerbs, lineMarksEnabled, nextPatrolWaypoint, patrolChains, patrolWaypoint, reachedPatrolWaypoint, type PatrolChains } from "./patrol.js";
import { BROODS, COUNT_CASTES, type Agent, type Ant, type Brood, type BroodSet, type Caste, type ColonyId, type CountMarkVerb, type InputError, type Mark, type Order, type SimEvent, type SimInput, type SimState } from "./types.js";

type JoinInput = Extract<SimInput, { type: "join" }>;

/**
 * The one pluggable allocator: it places a joining agent in
 * a colony and ranks spare ants for squads. A sub-agent join carries
 * parentAgentId; squad splitting is a follow-up.
 */
export interface Allocator {
  chooseColony(state: SimState, join: JoinInput): ColonyId;
  /** Spare (non-squad) ants of a colony, in the order squads draft them. */
  rankSpare(state: SimState, colony: ColonyId, spare: readonly Ant[]): Ant[];
}

function agentCounts(state: SimState): [number, number] {
  const counts: [number, number] = [0, 0];
  for (const agent of state.agents) counts[agent.colony] += 1;
  return counts;
}

/**
 * Shared by tick placement and the adapter's admission projection. Operator
 * placement wins; named colonies are honoured; unnamed joins choose the colony
 * with fewer agents (colony 0 on a tie). The adapter enforces seating caps.
 */
export function chooseJoinColony(counts: readonly [number, number], join: Pick<JoinInput, "colony" | "placement">): ColonyId {
  if (join.placement === 0 || join.placement === 1) return join.placement;
  if (join.colony !== undefined) return join.colony;
  return counts[1] < counts[0] ? 1 : 0;
}

/**
 * Default allocator. Squads draft nearest the oldest live queen first (lowest
 * ant id on ties). A new nest must not scatter one squad across multiple nests
 * and silently multiply its fog footprint and observe payload.
 */
export const defaultAllocator: Allocator = {
  chooseColony(state, join) {
    return chooseJoinColony(agentCounts(state), join);
  },
  rankSpare(state, colony, spare) {
    const q = activeQueens(state.colonies[colony])[0];
    const d = (a: Ant): number => q === undefined ? Infinity : distance(a.x, a.y, q.queenX, q.queenY);
    return spare
      .slice()
      .sort(
        (a, b) =>
          d(a) - d(b) || a.id - b.id,
      );
  },
};

/** Copy an order into canonical form, or null if it is malformed. */
function normaliseOrder(state: SimState, order: Order): Order | null {
  const inMap = (x: unknown, y: unknown): boolean =>
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    (x as number) >= 0 &&
    (y as number) >= 0 &&
    (x as number) < state.config.mapWidth &&
    (y as number) < state.config.mapHeight;
  switch (order.kind) {
    case "go_to":
    case "attack":
      return inMap(order.tileX, order.tileY) ? { kind: order.kind, tileX: order.tileX, tileY: order.tileY } : null;
    case "forage":
    case "hold":
    case "follow_trail":
      return { kind: order.kind };
    default:
      return null;
  }
}

function squadAnts(state: SimState, agent: Agent): Ant[] {
  return state.ants.filter((ant) => ant.squad === agent.id);
}

export interface InputOutcome {
  readonly agentId: string;
  readonly error: InputError | null;
  readonly countMarkAcceptance?: Extract<SimEvent, { type: "count_mark_accepted" }>;
  /** Rules 27 REMOVE: the removed count mark, whose ants start their defaults this tick. */
  readonly removedMarkId?: number;
  /** Rules 27 set_brood: the queen whose brood was set, and that brood. */
  readonly broodSet?: BroodSet;
}

const NO_OWN_ANT =
  "No mark was laid: none of your squad's ants stands there, and an order carrying this mark was not applied either. Leave out tileX and tileY to lay the mark where one of your squad's ants stands.";

/** A colony-sight count mark without tileX and tileY lands on the squad; with no squad ant it has no tile. */
export const EMPTY_SQUAD_COUNT_MARK =
  "Your squad is empty, so a count mark without tileX and tileY has no tile to land on.";

/** Rules 27: a colony-sight LINE refusal names the end that is out of reach. */
export const LINE_FROM_END_NOT_VISIBLE =
  "LINE's first end (tileX/tileY) is out of reach: both LINE ends must be in reach, each under the same placement rule as a single-tile count mark.";
export const LINE_TO_END_NOT_VISIBLE =
  "LINE's second end (toTileX/toTileY) is out of reach: both LINE ends must be in reach, each under the same placement rule as a single-tile count mark.";

/**
 * Where a tile-less mark lands:
 * the squad ant nearest the mean position of the squad's living ants, ties to
 * the lowest ant id. Distances are compared in exact integers, scaled by n.
 */
function nearestSquadMean(squad: readonly Ant[]): Ant | null {
  const n = squad.length;
  let sumX = 0;
  let sumY = 0;
  for (const ant of squad) {
    sumX += ant.x;
    sumY += ant.y;
  }
  let best: Ant | null = null;
  let bestDist = 0;
  for (const ant of squad) {
    const dx = n * ant.x - sumX;
    const dy = n * ant.y - sumY;
    const dist = dx * dx + dy * dy;
    if (best === null || dist < bestDist || (dist === bestDist && ant.id < best.id)) {
      best = ant;
      bestDist = dist;
    }
  }
  return best;
}

function fail(agentId: string, code: InputError["code"], message: string, nextAllowedTick?: number): InputOutcome {
  const error: InputError = nextAllowedTick === undefined ? { code, message } : { code, message, nextAllowedTick };
  return { agentId, error };
}

/**
 * Apply one agent input at the tick boundary. Every input is an agent call;
 * historical rules refresh squad expiry on any call, command-idle rules only
 * wake on accepted commands. Fresh squads are drafted in the fill pass.
 * Orders and standalone marks share one command floor; an
 * order and the mark it carries count as one command.
 */
export function applyInput(
  state: SimState,
  input: SimInput,
  tick: number,
  allocator: Allocator,
  events: SimEvent[],
): InputOutcome {
  const { config } = state;
  const agentId = input.agentId;
  if (input.type === "join") {
    if (state.agents.some((agent) => agent.id === agentId)) {
      return fail(agentId, "duplicate_agent", "That agent id has already joined; rejoin with it instead.");
    }
    const colony = allocator.chooseColony(state, input);
    const agent: Agent = {
      id: agentId,
      colony,
      joinSeq: state.agents.length,
      modelLabel: input.modelLabel ?? null,
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      parentAgentId: input.parentAgentId ?? null,
      squad: [],
      order: { kind: "forage" },
      lastCallTick: tick,
      lastCommandTick: null,
      ...(config.commandIdleTicks === undefined ? {} : { joinedTick: tick }),
      idle: false,
      pendingEvents: [],
    };
    state.agents.push(agent);
    // Rules 27: a lobby seat's agent owns the live starting queen its seat picked,
    // with her brood and spawn point, even when it joins late and the draw held her meanwhile.
    if (input.queenId !== undefined) {
      const queen = state.colonies[colony].queens?.find((q) => q.id === input.queenId && q.starting === true && q.lostTick === null);
      if (queen !== undefined) queen.owner = agentId;
    }
    events.push({ type: "agent_join", tick, agentId, colony, modelLabel: agent.modelLabel, ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
      ...(agent.serviceTier === undefined ? {} : { serviceTier: agent.serviceTier }), parentAgentId: agent.parentAgentId });
    return { agentId, error: null };
  }

  const agent = state.agents.find((a) => a.id === agentId);
  if (agent === undefined) return fail(agentId, "unknown_agent", "No agent with that id has joined this match; call join.");
  // Refuse the entire retired command before touching timers, orders, brood or marks.
  if (config.wordMarksDisabled) {
    if (input.type === "mark" || (input.type === "order" && input.mark !== undefined)) {
      return fail(agentId, "bad_mark_words", "This command is not available in these rules. Use count_mark or an order without extra fields.");
    }
    if (input.type === "order" && input.order.kind === "follow_trail") {
      return fail(agentId, "bad_order", "Choose go_to, attack, forage or hold.");
    }
  }
  agent.lastCallTick = tick;
  if (config.commandIdleTicks === undefined) agent.idle = false;
  if (input.type === "rejoin" || input.type === "observe") return { agentId, error: null };
  // Rules 27: set_brood is outside the shared command floor, as observe is.
  if (input.type === "set_brood") return setBrood(state, agent, input);

  if (agent.lastCommandTick !== null && tick - agent.lastCommandTick < config.commandFloorTicks) {
    const next = agent.lastCommandTick + config.commandFloorTicks;
    const seconds = Math.ceil(((next - tick) * 10) / config.ticksPerSecond) / 10;
    return fail(
      agentId,
      "rate_limited",
      `One command per ${config.commandFloorTicks / config.ticksPerSecond} s: the next ${config.wordMarksDisabled ? "command" : "order or mark"} is allowed at tick ${next} (in ${seconds} s).`,
      next,
    );
  }

  if (input.type === "found_queen") {
    const error = foundQueen(state, agent.colony, input.tileX, input.tileY, tick, events);
    if (error !== null) return { agentId, error };
    // Rules 27: the agent whose found_queen call founded her owns her; foundQueen appends her last.
    state.colonies[agent.colony].queens!.at(-1)!.owner = agentId;
    agent.lastCommandTick = tick;
    agent.idle = false;
    return { agentId, error: null };
  }

  if (input.type === "count_mark") return applyCountMark(state, agent, input, tick, events);

  let order: Order | null = null;
  let intent: string | null = null;
  let brood: Brood | null = null;
  const markSpec = input.type === "mark" ? input : input.mark;
  if (input.type === "order") {
    order = normaliseOrder(state, input.order);
    if (order === null) return fail(agentId, "bad_order", "Unknown order or target tile outside the map.");
    // The brood choice exists only with the rules switch on; off, it is ignored.
    if (input.brood !== undefined && config.castes !== undefined) {
      if (!(BROODS as readonly unknown[]).includes(input.brood)) {
        return fail(agentId, "bad_order", `brood is one of ${BROODS.join(", ")}.`);
      }
      brood = input.brood;
    }
    if (input.intent !== undefined) {
      if ([...input.intent].length > config.intentMaxChars) {
        return fail(agentId, "intent_too_long", `The intent line is at most ${config.intentMaxChars} characters.`);
      }
      intent = input.intent;
    }
  }
  let words = null;
  let markTile: { tileX: number; tileY: number } | null = null;
  if (markSpec !== undefined) {
    words = parseWords(config, markSpec.words);
    if (words === null) {
      return fail(agentId, "bad_mark_words", `A mark has 1 to ${config.markMaxWords} words from the sixteen-word vocabulary.`);
    }
    const { tileX: markX, tileY: markY } = markSpec;
    if (markX !== undefined && markY !== undefined) {
      const terrain = terrainRefusal(state, agentId, markX, markY, () => nearestSquadTile(state, agent, markX, markY));
      if (terrain !== null) return terrain;
    }
    markTile = markTileFor(state, agent, markSpec);
    if (markTile !== null) {
      const at = markTile;
      const terrain = terrainRefusal(state, agentId, at.tileX, at.tileY, () => nearestSquadTile(state, agent, at.tileX, at.tileY));
      if (terrain !== null) return terrain;
    }
    if (markTile === null) return fail(agentId, "no_own_ant_on_tile", NO_OWN_ANT);
  }

  agent.lastCommandTick = tick;
  agent.idle = false;
  if (brood !== null) agent.brood = brood;
  if (order !== null) {
    agent.order = order;
    events.push({ type: "order", tick, agentId, order, intent });
  }
  if (markTile !== null && words !== null) layMark(state, agent, markTile.tileX, markTile.tileY, words, tick, events);
  return { agentId, error: null };
}

/**
 * Where a mark lands: with no tile, under the squad ant nearest the squad's
 * mean position; otherwise on the named tile, which a squad ant must stand on.
 * Null when neither holds.
 */
function markTileFor(state: SimState, agent: Agent, spec: { readonly tileX?: number; readonly tileY?: number }): { tileX: number; tileY: number } | null {
  const squad = squadAnts(state, agent);
  if (spec.tileX === undefined && spec.tileY === undefined) {
    const here = nearestSquadMean(squad);
    return here === null ? null : { tileX: Math.floor(here.x / SUB), tileY: Math.floor(here.y / SUB) };
  }
  const onTile = squad.some((ant) => Math.floor(ant.x / SUB) === spec.tileX && Math.floor(ant.y / SUB) === spec.tileY);
  return onTile ? { tileX: spec.tileX!, tileY: spec.tileY! } : null;
}

/** Count marks may target current colony sight, not remembered food or enemy sight. */
function countMarkTileFor(state: SimState, agent: Agent, spec: { readonly tileX?: number; readonly tileY?: number }): { tileX: number; tileY: number } | null {
  if (state.config.countMarks?.placement !== "colony_sight" || (spec.tileX === undefined && spec.tileY === undefined)) {
    return markTileFor(state, agent, spec);
  }
  const { tileX, tileY } = spec;
  if (tileX === undefined || tileY === undefined || !Number.isInteger(tileX) || !Number.isInteger(tileY) ||
      tileX < 0 || tileY < 0 || tileX >= state.config.mapWidth || tileY >= state.config.mapHeight) return null;
  return state.ants.some((ant) => ant.colony === agent.colony && ant.hp > 0 &&
    withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), tileX, tileY, state.config.sightTiles))
    ? { tileX, tileY } : null;
}

type Tile = { tileX: number; tileY: number };

/** The candidate nearest (x, y) by squared Euclidean distance; ties to the lower tileY, then the lower tileX. */
function nearestOf(candidates: Iterable<Tile>, x: number, y: number): Tile | null {
  let best: Tile | null = null;
  let bestDist = Infinity;
  for (const tile of candidates) {
    const dist = (tile.tileX - x) ** 2 + (tile.tileY - y) ** 2;
    if (dist < bestDist || (dist === bestDist && best !== null &&
        (tile.tileY < best.tileY || (tile.tileY === best.tileY && tile.tileX < best.tileX)))) {
      best = tile;
      bestDist = dist;
    }
  }
  return best;
}

function* mapTilesWhere(state: SimState, legal: (x: number, y: number) => boolean): Generator<Tile> {
  for (let y = 0; y < state.config.mapHeight; y++) {
    for (let x = 0; x < state.config.mapWidth; x++) if (legal(x, y)) yield { tileX: x, tileY: y };
  }
}

function clearLand(state: SimState, x: number, y: number): boolean {
  return !isWaterTile(state.terrain, x, y) && !isRockTile(state.terrain, x, y);
}

/**
 * A mark on water or rock at (tileX, tileY) refuses with the nearest tile the
 * same command's tile rules accept now (null when none). Null when the tile is
 * clear land. Read-only: refusals change no state.
 */
function terrainRefusal(state: SimState, agentId: string, tileX: number, tileY: number, nearest: () => Tile | null): InputOutcome | null {
  if (isWaterTile(state.terrain, tileX, tileY)) {
    return { agentId, error: { code: "water_tile", message: "Marks require land; water is impassable.", nearestTile: nearest() } };
  }
  if (isRockTile(state.terrain, tileX, tileY)) {
    return { agentId, error: { code: "rock_tile", message: "Marks require clear land; rocks are impassable.", nearestTile: nearest() } };
  }
  return null;
}

/** The nearest clear-land tile one of the agent's own squad ants stands on: where a squad-placed mark is accepted. */
function nearestSquadTile(state: SimState, agent: Agent, tileX: number, tileY: number): Tile | null {
  const tiles = squadAnts(state, agent).map((ant) => ({ tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) }))
    .filter((tile) => clearLand(state, tile.tileX, tile.tileY));
  return nearestOf(tiles, tileX, tileY);
}

/** How far inside the sight circle an offered count-mark tile is kept. */
const SIGHT_MARGIN_TILES = 2;

/**
 * The tile nearest (tileX, tileY) that a colony-sight count mark would be
 * accepted on now: on the map, within sight of a living own ant, and neither
 * water nor rock. Prefers tiles within sightTiles - 2 of a living own ant, so
 * the tile stays in sight after that ant moves one tile (at most sqrt 2); only
 * when no such tile exists does it fall back to the full sight circle. Squared
 * Euclidean distance from the requested point; ties to the lower tileY, then
 * the lower tileX. Read-only: refusals change no state.
 */
function nearestCountMarkTile(state: SimState, agent: Agent, tileX: number, tileY: number): Tile | null {
  const { mapWidth: width, mapHeight: height, sightTiles: r } = state.config;
  const inner = Math.max(0, r - SIGHT_MARGIN_TILES);
  // 2: inside the inner circle of some own ant; 1: inside sight only.
  const seen = new Uint8Array(width * height);
  const origins = new Set<number>();
  for (const ant of state.ants) {
    if (ant.colony !== agent.colony || ant.hp <= 0) continue;
    const ax = Math.floor(ant.x / SUB);
    const ay = Math.floor(ant.y / SUB);
    const key = ay * width + ax;
    if (origins.has(key)) continue;
    origins.add(key);
    for (let y = Math.max(0, ay - r); y <= Math.min(height - 1, ay + r); y++) {
      for (let x = Math.max(0, ax - r); x <= Math.min(width - 1, ax + r); x++) {
        const i = y * width + x;
        if (withinTiles(ax, ay, x, y, inner)) seen[i] = 2;
        else if (seen[i] === 0 && withinTiles(ax, ay, x, y, r)) seen[i] = 1;
      }
    }
  }
  for (const level of [2, 1]) {
    const best = nearestOf(mapTilesWhere(state, (x, y) => seen[y * width + x]! >= level && clearLand(state, x, y)), tileX, tileY);
    if (best !== null) return best;
  }
  return null;
}

/** The nearest tile this match's count-mark placement rule accepts now. */
function nearestCountMarkPlacement(state: SimState, agent: Agent, tileX: number, tileY: number): Tile | null {
  return state.config.countMarks?.placement === "colony_sight"
    ? nearestCountMarkTile(state, agent, tileX, tileY) : nearestSquadTile(state, agent, tileX, tileY);
}

function layMark(
  state: SimState,
  agent: Agent,
  tileX: number,
  tileY: number,
  words: NonNullable<ReturnType<typeof parseWords>>,
  tick: number,
  events: SimEvent[],
  counted?: { readonly verb: CountMarkVerb; readonly count: number; readonly caste?: Caste; readonly toTileX?: number; readonly toTileY?: number },
): void {
  const own = state.marks.filter((mark) => mark.agentId === agent.id);
  if (state.config.marksPerAgent !== undefined && own.length >= state.config.marksPerAgent) {
    const oldest = own.reduce((a, b) => (b.laidTick < a.laidTick || (b.laidTick === a.laidTick && b.id < a.id) ? b : a));
    state.marks = state.marks.filter((mark) => mark.id !== oldest.id);
  }
  const id = state.nextMarkId;
  state.nextMarkId += 1;
  const caste = counted?.caste === undefined ? {} : { caste: counted.caste };
  const to = counted?.toTileX === undefined || counted.toTileY === undefined ? {} : { toTileX: counted.toTileX, toTileY: counted.toTileY };
  const extra = counted === undefined ? {} : { verb: counted.verb, count: counted.count, revision: 0, ...caste,
    ...(state.config.countMarks?.combatTotals ? { antsLost: 0, enemiesKilled: 0 } : {}), ...to };
  state.marks.push({ id, agentId: agent.id, colony: agent.colony, tileX, tileY, words, laidTick: tick, steering: 0, ...extra });
  events.push({ type: "mark_laid", tick, markId: id, agentId: agent.id, colony: agent.colony, words, tileX, tileY, ...(counted === undefined ? {} : { verb: counted.verb, count: counted.count,
    ...(state.config.countMarks?.casteSelection || counted.caste !== undefined ? { caste: counted.caste ?? "any" } : {}), ...to }) });
}

/**
 * A count mark: a verb and a positive whole requested count. It shares the command floor, the own-ant tile rule and the per-agent mark limit
 * with word marks. Re-laying one with the same agent, verb and tile keeps its
 * claimed ants and changes only its count;
 * claims are filled and released in the claim pass (marks.ts).
 */
function applyCountMark(
  state: SimState,
  agent: Agent,
  input: Extract<SimInput, { type: "count_mark" }>,
  tick: number,
  events: SimEvent[],
): InputOutcome {
  // Rules 27 command verbs, not mark verbs.
  if (input.verb === "SPAWN") return applySpawnPoint(state, agent, input, tick);
  if (input.verb === "REMOVE") return removeCountMark(state, agent, input.markId, tick);
  const rules = state.config.countMarks;
  if (rules === undefined) return fail(agent.id, "count_marks_disabled", "Count marks are not part of this match's rules.");
  if (input.caste !== undefined && !(COUNT_CASTES as readonly string[]).includes(input.caste)) {
    return fail(agent.id, "bad_count_mark", `Choose a caste from ${COUNT_CASTES.join(", ")}; omitted means any.`);
  }
  const caste = input.caste === "worker" || input.caste === "soldier" ? input.caste : undefined;
  const verbs = countMarkVerbs(state.config);
  const verb = verbs.find(verb => verb === input.verb) ?? null;
  if (verb === null || !Number.isInteger(input.count) || input.count < 1) {
    return fail(agent.id, "bad_count_mark", `A count mark has one verb from ${verbs.join(", ")} and a whole count of 1 or more.`);
  }
  // Refused, never clamped: a colony never has more ants than this to claim (config.ts).
  if (input.count > COUNT_MARK_MAX_COUNT) {
    return fail(agent.id, "bad_count_mark", `A count mark's count is at most ${COUNT_MARK_MAX_COUNT_TEXT}.`);
  }
  if (verb === "FORAGE" && caste === "soldier") {
    return fail(agent.id, "bad_count_mark", "FORAGE recruits workers only; leave caste out or use worker.");
  }
  const line = lineMarksEnabled(state.config) ? lineEndpoint(state, agent, input, verb) : null;
  if (line !== null && "error" in line) return line.error;
  const to = line === null ? undefined : line.to;
  const { tileX, tileY } = input;
  if (tileX !== undefined && tileY !== undefined) {
    const terrain = terrainRefusal(state, agent.id, tileX, tileY, () => nearestCountMarkPlacement(state, agent, tileX, tileY));
    if (terrain !== null) return terrain;
  }
  const tile = countMarkTileFor(state, agent, input);
  if (tile === null) {
    if (rules.placement !== "colony_sight") return fail(agent.id, "no_own_ant_on_tile", NO_OWN_ANT);
    if (tileX === undefined && tileY === undefined) {
      // Both coordinates omitted fails only with an empty squad: offer a tile at the colony's first living ant.
      const ant = state.ants.find((a) => a.colony === agent.colony && a.hp > 0);
      return { agentId: agent.id, error: { code: "count_mark_not_visible", message: EMPTY_SQUAD_COUNT_MARK,
        nearestTile: ant === undefined ? null : nearestCountMarkTile(state, agent, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)) } };
    }
    const message = to !== undefined ? LINE_FROM_END_NOT_VISIBLE
      : "Choose a whole-number tile currently within sight of a living ant of your colony; omitting the tile still requires a squad ant.";
    if (tileX === undefined || tileY === undefined || !Number.isFinite(tileX) || !Number.isFinite(tileY)) return fail(agent.id, "count_mark_not_visible", message);
    return { agentId: agent.id, error: { code: "count_mark_not_visible", message, nearestTile: nearestCountMarkTile(state, agent, tileX, tileY) } };
  }
  const terrain = terrainRefusal(state, agent.id, tile.tileX, tile.tileY, () => nearestCountMarkPlacement(state, agent, tile.tileX, tile.tileY));
  if (terrain !== null) return terrain;
  const live = state.ants.filter((ant) => ant.colony === agent.colony && ant.hp > 0);
  const marks = new Set(state.marks.filter((mark) => mark.colony === agent.colony && mark.count !== undefined &&
    tick - mark.laidTick < state.config.markLifetimeTicks).map((mark) => mark.id));
  const claimed = live.filter((ant) => ant.squad === null && ant.claim !== undefined && marks.has(ant.claim)).length;
  agent.lastCommandTick = tick;
  agent.idle = false;
  const planner = !localRulesSide(state, agent.colony);
  const free = live.filter((ant) => ant.squad === null && (ant.claim === undefined || !marks.has(ant.claim)) && !(planner && ant.role === "guard")
    && countMarkCasteEligible(state.config, ant, { verb, caste })).length;
  const same = state.marks.find((m) => m.agentId === agent.id && m.verb === verb && m.tileX === tile.tileX && m.tileY === tile.tileY
    && m.toTileX === to?.tileX && m.toTileY === to?.tileY);
  if (same !== undefined) {
    same.count = input.count;
    if (caste === undefined) delete same.caste;
    else same.caste = caste;
    same.revision = (same.revision ?? 0) + 1;
  } else {
    layMark(state, agent, tile.tileX, tile.tileY, [], tick, events, { verb, count: input.count, ...(caste === undefined ? {} : { caste }),
      ...(to === undefined ? {} : { toTileX: to.tileX, toTileY: to.tileY }) });
  }
  if (rules.reportClaimAvailability) {
    const mark = same ?? state.marks.at(-1)!;
    const availability = { claimedAnts: claimed, freeAntsNow: free };
    const event: Extract<SimEvent, { type: "count_mark_accepted" }> = {
      type: "count_mark_accepted", tick, markId: mark.id, agentId: agent.id, colony: agent.colony,
      tileX: tile.tileX, tileY: tile.tileY, verb, count: input.count, availability,
      ...(rules.casteSelection || caste !== undefined ? { caste: caste ?? "any" } : {}),
      ...(to === undefined ? {} : { toTileX: to.tileX, toTileY: to.tileY }),
      message: free === 0 ? "0 free ants now; this mark recruits as ants hatch or free up"
        : `${free} free ants now; this mark recruits as ants hatch or free up`,
    };
    // Bind the explanation to this input's result, not the owner's next arbitrary
    // call: an earlier concurrent observe must not consume the command's metadata.
    events.push(event);
    return { agentId: agent.id, error: null, countMarkAcceptance: event };
  }
  return { agentId: agent.id, error: null };
}

/**
 * Rules 27 set_brood: set the brood of one live queen of the agent's
 * colony that it owns; queenId is needed only when it owns more than one. It
 * never reads or writes the command floor (lastCommandTick) and does not wake a
 * command-idle agent; on acceptance only that queen's brood changes.
 */
function setBrood(state: SimState, agent: Agent, input: Extract<SimInput, { type: "set_brood" }>): InputOutcome {
  const { config } = state;
  if (config.castes === undefined) return fail(agent.id, "bad_brood", "set_brood is not available in these rules.");
  if (!(BROODS as readonly unknown[]).includes(input.brood)) return fail(agent.id, "bad_brood", `brood is one of ${BROODS.join(", ")}.`);
  const owned = (state.colonies[agent.colony].queens ?? []).filter((q) => q.lostTick === null && q.owner === agent.id);
  if (owned.length === 0) return fail(agent.id, "no_owned_queen", "You own no live queen, so there is no brood to set. Found one with found_queen.");
  const queen = input.queenId === undefined ? (owned.length === 1 ? owned[0] : undefined) : owned.find((q) => q.id === input.queenId);
  if (queen === undefined) {
    const ids = owned.map((q) => q.id).join(", ");
    return input.queenId === undefined
      ? fail(agent.id, "bad_brood", `You own ${owned.length} live queens (queenId ${ids}); send queenId to choose one.`)
      : fail(agent.id, "no_owned_queen", `Queen ${input.queenId} is not a live queen you own; yours: queenId ${ids}.`);
  }
  queen.brood = input.brood as Brood;
  return { agentId: agent.id, error: null, broodSet: { queenId: queen.id, brood: queen.brood } };
}

/**
 * Rules 27 SPAWN: set, move or clear the spawn point of one live queen the
 * agent owns. Both coordinates given set or move it to that tile: any
 * passable tile inside the map, with no sight rule. Both omitted clear it,
 * including one already unset. Each queen holds at most one and it never
 * expires. Only her owner may change it: any other agent of the
 * colony, and every agent while she has no owner, is refused with
 * queen_not_owned before anything changes. A refusal spends no command allowance.
 */
function applySpawnPoint(state: SimState, agent: Agent, input: Extract<SimInput, { type: "count_mark" }>, tick: number): InputOutcome {
  const queen = state.colonies[agent.colony].queens?.find((q) => q.id === input.queenId && q.lostTick === null);
  if (queen === undefined) {
    return fail(agent.id, "bad_spawn_point", "SPAWN needs queenId naming a live queen you own.");
  }
  if (queen.owner !== agent.id) {
    return fail(agent.id, "queen_not_owned", queen.owner === undefined
      ? `Queen ${queen.id} has no owner yet: only a queen's owner sets, moves or clears her spawn point.`
      : `Queen ${queen.id} belongs to a teammate: only her owner sets, moves or clears her spawn point.`);
  }
  const { tileX, tileY } = input;
  if (tileX === undefined && tileY === undefined) {
    delete queen.spawnPoint;
  } else {
    const { mapWidth: w, mapHeight: h } = state.config;
    const whole = (v: number | undefined, size: number): v is number => v !== undefined && Number.isInteger(v) && v >= 0 && v < size;
    if (!whole(tileX, w) || !whole(tileY, h)) {
      return fail(agent.id, "bad_spawn_point", `A spawn point needs whole-number tileX 0-${w - 1} and tileY 0-${h - 1}; omit both to clear it.`);
    }
    if (isWaterTile(state.terrain, tileX, tileY) || isRockTile(state.terrain, tileX, tileY)) {
      return fail(agent.id, "bad_spawn_point", "A spawn point needs a passable tile; water and rocks are impassable.");
    }
    queen.spawnPoint = { tileX, tileY };
  }
  agent.lastCommandTick = tick;
  agent.idle = false;
  return { agentId: agent.id, error: null };
}

/**
 * Rules 27 REMOVE: delete one of the agent's own count marks. Like any command
 * it spends the shared allowance only when accepted. It creates no mark or
 * event; the same tick's claim pass releases the removed mark's ants, and step
 * plans them with their defaults that same tick.
 */
function removeCountMark(state: SimState, agent: Agent, markId: number | undefined, tick: number): InputOutcome {
  const mark = state.marks.find((m) => m.id === markId && m.agentId === agent.id && m.count !== undefined);
  if (mark === undefined) return fail(agent.id, "bad_mark_removal", "REMOVE needs markId: the id of one of your own count marks still on the map.");
  state.marks = state.marks.filter((m) => m !== mark);
  agent.lastCommandTick = tick;
  agent.idle = false;
  return { agentId: agent.id, error: null, removedMarkId: mark.id };
}

/**
 * Rules 26: only LINE takes a second endpoint, and LINE needs both endpoints as
 * whole in-map tiles, two different tiles, each clear land within the same
 * placement rule as any count mark. Null for a non-LINE mark without one.
 */
function lineEndpoint(state: SimState, agent: Agent, input: Extract<SimInput, { type: "count_mark" }>, verb: CountMarkVerb):
  { readonly to: { tileX: number; tileY: number } } | { readonly error: InputOutcome } | null {
  const given = input.toTileX !== undefined || input.toTileY !== undefined;
  if (verb !== "LINE") return given ? { error: fail(agent.id, "bad_count_mark", `Only LINE takes toTileX/toTileY; leave them out for ${verb}.`) } : null;
  const whole = (v: number | undefined, size: number) => v !== undefined && Number.isInteger(v) && v >= 0 && v < size;
  const { mapWidth: w, mapHeight: h } = state.config;
  if (!whole(input.tileX, w) || !whole(input.tileY, h) || !whole(input.toTileX, w) || !whole(input.toTileY, h) ||
      (input.tileX === input.toTileX && input.tileY === input.toTileY)) {
    return { error: fail(agent.id, "bad_count_mark", "LINE needs whole-number tileX, tileY, toTileX and toTileY inside the map: two different end tiles.") };
  }
  const to = { tileX: input.toTileX!, tileY: input.toTileY! };
  const terrain = terrainRefusal(state, agent.id, to.tileX, to.tileY, () => nearestCountMarkPlacement(state, agent, to.tileX, to.tileY));
  if (terrain !== null) return { error: terrain };
  if (countMarkTileFor(state, agent, to) === null) return { error: state.config.countMarks?.placement !== "colony_sight"
    ? fail(agent.id, "no_own_ant_on_tile", NO_OWN_ANT)
    // Rules 27: name the second end and offer a tile for it, as its terrain refusal does.
    : { agentId: agent.id, error: { code: "count_mark_not_visible", message: LINE_TO_END_NOT_VISIBLE, nearestTile: nearestCountMarkTile(state, agent, to.tileX, to.tileY) } } };
  return { to };
}

/** Expiry returns squads to the colony; historical configs retain their call-based timer. */
export function lapseSquads(state: SimState, tick: number, events: SimEvent[]): void {
  const lapsed = state.agents.filter((agent) => {
    const timeout = state.config.commandIdleTicks ?? state.config.squadTimerTicks;
    const since = state.config.commandIdleTicks === undefined ? agent.lastCallTick
      : agent.lastCommandTick ?? agent.joinedTick ?? agent.lastCallTick;
    return !agent.idle && tick - since >= timeout;
  });
  // Every seat lapsing this tick is idle before any release, so seated-only
  // release effects see whether the colony is still seated after the tick.
  for (const agent of lapsed) agent.idle = true;
  for (const agent of lapsed) {
    releaseAnts(state, agent, agent.squad.slice(), tick, events);
    if (state.config.commandIdleTicks !== undefined) {
      // Count marks must not retain or recruit ants after their seat lapses.
      // Clear claims before the pre-input planner assigns roles and directions.
      const expired = new Set(state.marks.filter((mark) => mark.agentId === agent.id && mark.count !== undefined).map((mark) => mark.id));
      if (expired.size > 0) {
        state.marks = state.marks.filter((mark) => !expired.has(mark.id));
        for (const ant of state.ants) if (ant.claim !== undefined && expired.has(ant.claim)) releaseClaim(state, ant);
      }
    }
  }
}

function releaseAnts(state: SimState, agent: Agent, ids: readonly number[], tick: number, events: SimEvent[]): void {
  if (ids.length === 0) return;
  const released = new Set(ids);
  for (const ant of state.ants) if (released.has(ant.id)) ant.squad = null;
  agent.squad = agent.squad.filter((id) => !released.has(id));
  events.push({ type: "squad_released", tick, agentId: agent.id, antIds: ids.slice() });
}

function supplyLimit(state: SimState, colony: ColonyId): number {
  let living = 0;
  for (const ant of state.ants) if (ant.colony === colony) living += 1;
  return Math.trunc((living * state.config.squadSupplyPermille) / 1000);
}

/** Drop dead ants from squads. */
export function pruneSquads(state: SimState): void {
  // The living ids are gathered only when some squad has an id to check.
  let living: Set<number> | undefined;
  for (const agent of state.agents) agent.squad = agent.squad.filter((id) => (living ??= new Set(state.ants.map((ant) => ant.id))).has(id));
}

/**
 * Squad supply: squads together hold at most half a
 * colony's living ants. Squads below squadSize fill in join order from spare
 * existing ants within that limit; no ant is created. Used for joins, fresh
 * squads and refills alike.
 */
export function fillSquads(state: SimState, allocator: Allocator, tick: number, events: SimEvent[]): void {
  const size = state.config.squadSize;
  for (const colony of [0, 1] as const) {
    const agents = state.agents.filter((a) => a.colony === colony).sort((a, b) => a.joinSeq - b.joinSeq);
    let used = agents.reduce((n, a) => n + a.squad.length, 0);
    const wanting = agents.filter((a) => !a.idle && a.squad.length < size);
    if (wanting.length === 0) continue;
    const limit = supplyLimit(state, colony);
    if (used >= limit) continue;
    const spare = allocator.rankSpare(
      state,
      colony,
      state.ants.filter((ant) => ant.colony === colony && ant.squad === null && ant.claim === undefined),
    );
    let next = 0;
    for (const agent of wanting) {
      const take = Math.min(size - agent.squad.length, limit - used, spare.length - next);
      if (take <= 0) continue;
      const drafted = spare.slice(next, next + take);
      next += take;
      used += take;
      for (const ant of drafted) {
        ant.squad = agent.id;
        // Rules 27: a drafted walker's spawn walk ends; it does not resume on release.
        delete ant.spawnWalk;
        agent.squad.push(ant.id);
      }
      events.push({ type: "squad_filled", tick, agentId: agent.id, antIds: drafted.map((a) => a.id) });
    }
  }
}

/** If deaths left squads above half the colony, release the latest-joined squads' newest ants. */
export function trimSquads(state: SimState, tick: number, events: SimEvent[]): void {
  for (const colony of [0, 1] as const) {
    const agents = state.agents.filter((a) => a.colony === colony).sort((a, b) => b.joinSeq - a.joinSeq);
    let used = agents.reduce((n, a) => n + a.squad.length, 0);
    // No squad ant to trim: the loop below would stop at once for any limit of 0 or more.
    if (used === 0 && state.config.squadSupplyPermille >= 0) continue;
    const limit = supplyLimit(state, colony);
    for (const agent of agents) {
      if (used <= limit) break;
      const drop = Math.min(used - limit, agent.squad.length);
      releaseAnts(state, agent, agent.squad.slice(agent.squad.length - drop), tick, events);
      used -= drop;
    }
  }
}

/**
 * The enemy nearest the ant among those whose tile lies within r tiles of the
 * target tile (lowest id on ties), or null.
 */
function nearestEnemyNearTarget(state: SimState, grid: Grid, ant: Ant, targetX: number, targetY: number, r: number): Ant | null {
  let best: Ant | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  forEachNear(state, grid, targetX, targetY, r, (other) => {
    if (other.colony === ant.colony) return;
    if (!withinTiles(targetX, targetY, Math.floor(other.x / SUB), Math.floor(other.y / SUB), r)) return;
    const d = distance(ant.x, ant.y, other.x, other.y);
    if (d < bestD || (d === bestD && best !== null && other.id < best.id)) {
      best = other;
      bestD = d;
    }
  });
  return best;
}

/**
 * Directions for one agent's squad under its standing order. Squad ants obey
 * orders only; the house bot never directs them. Returns per-ant directions and
 * the ids of ants that are foraging (so they pick up food).
 */
export function squadDirections(
  state: SimState,
  grid: Grid,
  food: readonly number[],
  agent: Agent,
  tick: number,
): { dirs: Map<number, Vec>; foraging: number[] } {
  const ants = squadAnts(state, agent);
  const dirs = new Map<number, Vec>();
  const foraging: number[] = [];
  const order = agent.order;
  const forage = (ant: Ant): void => {
    dirs.set(ant.id, forageDirection(state, ant, food));
    foraging.push(ant.id);
  };
  if (order.kind === "follow_trail") {
    const mark = trailMark(state, ants, tick);
    if (mark !== null) mark.steering += ants.length;
    for (const ant of ants) {
      if (mark === null || (ant.carrying)) forage(ant);
      else dirs.set(ant.id, markDirection(mark, ant, state));
    }
    return { dirs, foraging };
  }
  for (const ant of ants) {
    if (ant.carrying) {
      forage(ant);
      continue;
    }
    switch (order.kind) {
      case "forage":
        forage(ant);
        break;
      case "hold":
        dirs.set(ant.id, ZERO);
        break;
      case "go_to":
        dirs.set(ant.id, toward(ant, tileCentre(order.tileX), tileCentre(order.tileY), state));
        break;
      case "attack":
        dirs.set(ant.id, attackDirection(state, grid, ant, order.tileX, order.tileY, state.config.attackRadiusTiles));
        break;
    }
  }
  return { dirs, foraging };
}

/**
 * The attack order's direction for one ant: fight what is within combat reach;
 * otherwise march on the target, passing enemies merely in sight. Within r
 * tiles of the target, engage enemies there; with none, hold at the target.
 */
export function attackDirection(state: SimState, grid: Grid, ant: Ant, tileX: number, tileY: number, r: number): Vec {
  if (ant.carrying) return forageDirection(state, ant, []);
  if (hasAdjacentEnemy(state, grid, ant)) { noteContact(state, ant, grid); return ZERO; }
  const atTarget = withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), tileX, tileY, r);
  const enemy = atTarget ? nearestEnemyNearTarget(state, grid, ant, tileX, tileY, r) : null;
  if (enemy !== null) {
    noteCombat(state, ant, enemy, false);
    return routeToward(state, ant, enemy.x, enemy.y);
  }
  return toward(ant, tileCentre(tileX), tileCentre(tileY), state);
}

/** Founding's nest-spacing rule: closer than minDistanceTiles to a spacing nest of either colony. */
function tooCloseToNest(state: SimState, rules: NonNullable<SimState["config"]["queenFounding"]>, tileX: number, tileY: number): boolean {
  for (const c of state.colonies) for (const q of queenSpacingNests(c, rules)) {
    if ((tileX - Math.floor(q.queenX / SUB)) ** 2 + (tileY - Math.floor(q.queenY / SUB)) ** 2 < rules.minDistanceTiles ** 2) return true;
  }
  return false;
}

interface FoundingAttempt {
  readonly state: SimState;
  readonly colonyId: ColonyId;
  readonly colony: SimState["colonies"][number];
  readonly rules: NonNullable<SimState["config"]["queenFounding"]>;
  readonly tileX: number;
  readonly tileY: number;
  readonly tick: number;
}

/** foundQueen's founding checks after terrain, run in this order; the first that refuses wins. */
const FOUNDING_RULES = [
  { code: "queen_tile_not_held", refuses: (a: FoundingAttempt) => a.state.owner[tileIndex(a.state.config, a.tileX, a.tileY)] !== a.colonyId
    ? { message: "Your colony does not hold that tile. Use observe map:true to choose held ground." } : null },
  { code: "queen_too_early", refuses: (a: FoundingAttempt) => a.tick < (a.rules.firstFoundTick ?? 0)
    ? { message: `Founding opens at tick ${a.rules.firstFoundTick}.`, nextAllowedTick: a.rules.firstFoundTick } : null },
  { code: "queen_limit", refuses: (a: FoundingAttempt) => activeQueens(a.colony).length >= (a.rules.maxLiveQueens ?? Infinity)
    ? { message: `Your colony already has the maximum ${a.rules.maxLiveQueens} live queens.` } : null },
  { code: "queen_cooldown", refuses: (a: FoundingAttempt) => {
    const next = nextQueenFoundingTick(a.colony, a.rules);
    return a.tick < next ? { message: `Your colony can found its next queen at tick ${next}.`, nextAllowedTick: next } : null;
  } },
  { code: "queen_too_close", refuses: (a: FoundingAttempt) => tooCloseToNest(a.state, a.rules, a.tileX, a.tileY)
    ? { message: `Choose a tile at least ${a.rules.minDistanceTiles} tiles from every ${a.rules.standingNestsOnly ? "standing nest" : "nest, including lost nests"} of either colony.` } : null },
  { code: "queen_food", refuses: (a: FoundingAttempt) => {
    const cost = queenFoundingCost(a.colony, a.rules);
    return a.colony.foodStore < cost ? { message: `Founding needs ${cost} food; your colony has ${a.colony.foodStore}.` } : null;
  } },
] as const;

export type FoundingCheck = (typeof FOUNDING_RULES)[number]["code"];
/** The founding check codes in the order foundQueen runs them; the founding fix-it text derives from this. */
export const FOUNDING_CHECKS: readonly FoundingCheck[] = FOUNDING_RULES.map(rule => rule.code);

/** The same atomic founding operation for seated agents and the house colony controller. */
export function foundQueen(state: SimState, colonyId: ColonyId, tileX: number, tileY: number, tick: number, events: SimEvent[]): InputError | null {
  const { config } = state;
  const rules = config.queenFounding;
  if (!rules) return { code: "queen_disabled", message: "Queen founding is not enabled in this match's rules." };
  const colony = state.colonies[colonyId];
  if (activeQueens(colony).length === 0) return { code: "no_active_queen", message: "Every queen of this colony has been lost." };
  if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || tileX < 0 || tileY < 0 || tileX >= config.mapWidth || tileY >= config.mapHeight) {
    return { code: "bad_order", message: "Choose a whole-number tile inside the map." };
  }
  // Read-only: the nearest held clear-land tile with nest spacing. Timing, limit and food are still checked there.
  const nearestTile = () => nearestOf(mapTilesWhere(state, (x, y) => state.owner[tileIndex(config, x, y)] === colonyId
    && clearLand(state, x, y) && !tooCloseToNest(state, rules, x, y)), tileX, tileY);
  if (isWaterTile(state.terrain, tileX, tileY)) return { code: "water_tile", message: "A queen requires dry land.", nearestTile: nearestTile() };
  if (isRockTile(state.terrain, tileX, tileY)) return { code: "rock_tile", message: "A queen requires clear land, not a rock tile. Use observe map:true and view.terrain.rocks to choose a held land tile outside rocks and water, with the required nest spacing.", nearestTile: nearestTile() };
  const attempt: FoundingAttempt = { state, colonyId, colony, rules, tileX, tileY, tick };
  for (const check of FOUNDING_RULES) {
    const refusal = check.refuses(attempt);
    if (refusal !== null) return { code: check.code, ...refusal };
  }
  const cost = queenFoundingCost(colony, rules);
  // New-rule states always carry queens. Refuse corrupt states rather than debit without founding.
  if (colony.queens === undefined) return { code: "queen_disabled", message: "This match has no queen-founding state." };
  const id = colony.queens.length;
  colony.queens.push({ id, queenX: tileCentre(tileX), queenY: tileCentre(tileY), foundedTick: tick,
    lastHatchTick: tick, overrunTicks: 0, lostTick: null,
    ...(config.queenHp === undefined ? {} : { hp: config.queenHp.hp, lastBiteTick: -config.queenHp.biteIntervalTicks, regenFromTick: tick }) });
  colony.foodStore -= cost;
  colony.lastQueenFoundedTick = tick;
  events.push({ type: "queen_founded", tick, colony: colonyId, queenId: id, tileX, tileY,
    ...(rules.costMultiplier === undefined ? {} : { foodCost: cost }) });
  return null;
}

/**
 * Where a claimed ant goes under its count mark's verb: ATTACK is
 * today's attack on the mark's tile; DEFEND holds the mark and fights enemies
 * within defendTiles of it; GATHER holds on the mark; FORAGE forages starting
 * from the food nearest the mark, then carries it home as any forager does.
 * Returns the direction and whether the ant is foraging (so it picks up food).
 */
export function countMarkDirection(state: SimState, grid: Grid, food: readonly number[], ant: Ant, mark: Mark, chains?: PatrolChains): { dir: Vec; foraging: boolean } {
  // Return before noteMark/contact can replace the carrier's home arrival goal.
  if (ant.carrying) return { dir: forageDirection(state, ant, food), foraging: true };
  if (state.config.patrolLinkTiles !== undefined && mark.verb === "PATROL") {
    const patrol = chains ?? patrolChains(state), own = patrol.get(mark.id);
    if (own === undefined) return { dir: ZERO, foraging: false };
    const waypoint = patrolWaypoint(ant, own, patrol);
    if (own.chain.length === 1) {
      // Reuse all native DEFEND decisions and the same local-arrival semantics.
      const defend: Mark = { ...mark, verb: "DEFEND" };
      const result = defendMarkDirection(state, grid, ant, mark, patrol);
      noteMark(state, ant, defend);
      return result;
    }
    // Like other free ants, pause for combat in reach, then resume this waypoint.
    if (hasAdjacentEnemy(state, grid, ant)) {
      noteContact(state, ant, grid);
      return { dir: ZERO, foraging: false };
    }
    const dir = toward(ant, tileCentre(waypoint.tileX), tileCentre(waypoint.tileY), state);
    noteMark(state, ant, waypoint);
    if (state.config.softSeparation === undefined && reachedPatrolWaypoint(state, ant, waypoint)) nextPatrolWaypoint(ant, patrol);
    return { dir, foraging: false };
  }
  if (mark.verb === "LINE") {
    // Hold this ant's own spot like DEFEND: combat bites what is in reach; no pursuit.
    const spot = lineSpotOf(state, mark, ant);
    const dir = toward(ant, spot.x, spot.y, state);
    noteMark(state, ant, mark, spot);
    return { dir, foraging: false };
  }
  const result = countMarkDirectionNative(state, grid, food, ant, mark);
  noteMark(state, ant, mark);
  return result;
}
function defendMarkDirection(state: SimState, grid: Grid, ant: Ant, mark: Mark, chains?: PatrolChains): { dir: Vec; foraging: boolean } {
  const rules = state.config.countMarks!;
  // Combat already bites adjacent enemies. Holding never selects a pursuit target.
  return { dir: softMarkHeading(state, ant, mark, rules.defendHolds ? toward(ant, tileCentre(mark.tileX), tileCentre(mark.tileY), state)
    : attackDirection(state, grid, ant, mark.tileX, mark.tileY, rules.defendTiles), chains), foraging: false };
}
function countMarkDirectionNative(state: SimState, grid: Grid, food: readonly number[], ant: Ant, mark: Mark): { dir: Vec; foraging: boolean } {
  switch (mark.verb) {
    case "ATTACK":
      return { dir: softMarkHeading(state, ant, mark, attackDirection(state, grid, ant, mark.tileX, mark.tileY, state.config.attackRadiusTiles)), foraging: false };
    case "DEFEND":
      return defendMarkDirection(state, grid, ant, mark);
    case "GATHER":
      return { dir: toward(ant, tileCentre(mark.tileX), tileCentre(mark.tileY), state), foraging: false };
    case "FORAGE": {
      if (!ant.carrying && (ant.foodTarget < 0 || (state.food[ant.foodTarget] ?? 0) <= 0)) {
        const width = state.config.mapWidth;
        let best = -1;
        let bestD = Number.POSITIVE_INFINITY;
        for (const t of food) {
          if ((state.food[t] ?? 0) <= 0) continue;
          const d = ((t % width) - mark.tileX) ** 2 + (Math.floor(t / width) - mark.tileY) ** 2;
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        ant.foodTarget = best;
      }
      return { dir: forageDirection(state, ant, food), foraging: true };
    }
    default:
      return { dir: ZERO, foraging: false };
  }
}
