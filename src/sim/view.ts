import { COLONY_NAMES, SUB, type RulesName } from "./config.js";
import { tileCentre, withinTiles } from "./geometry.js";
import { ARRIVE } from "./forage.js";
import { gridScaleOf, physicalTileArea } from "./gridScale.js";
import { activeQueens, hasAdjacentEnemy, nextQueenFoundingTick, queenFoundingCost, queensOf, tileIndex, type Grid } from "./map.js";
import { trailMark } from "./marks.js";
import { patrolChains, type PatrolChains } from "./patrol.js";
import { terrainView } from "./terrain.js";
import type { Agent, Ant, Brood, Caste, ColonyId, CountCaste, CountMarkVerb, MatchResult, Order, SimEvent, SimState, VisibleEvent, Word } from "./types.js";

export interface ViewCell {
  readonly tileX: number;
  readonly tileY: number;
  readonly food: number;
  /** caste is present only with the rules switch on. */
  readonly ants: readonly { readonly antId: number; readonly colony: ColonyId; readonly hp: number; readonly caste?: Caste }[];
  /** Owning colony of the queen on this tile (0/1), not a queen id; equals AgentView.colony for an own queen. */
  readonly queen?: ColonyId;
  /** That queen's HP in milli-HP. */
  readonly queenHp?: number;
}

interface CountMarkFields {
  readonly verb?: CountMarkVerb;
  readonly count?: number;
  readonly claimed?: number;
  readonly caste?: CountCaste;
  /** Cumulative combat totals since laying, not reset by observing or changing count/caste. */
  readonly lost?: number;
  readonly kills?: number;
  /** Patrol only: oldest mark id and zero-based place in laid-order loop. */
  readonly chain?: number;
  readonly position?: number;
}

export interface ViewMark extends CountMarkFields {
  readonly markId: number;
  readonly words: readonly Word[];
  readonly tileX: number;
  readonly tileY: number;
  readonly ticksLeft: number;
  readonly mine: boolean;
}

export interface AgentView {
  readonly terrain?: ReturnType<typeof terrainView>;
  /** The ANTWAR_RULES this match plays; absent when it was unset. */
  readonly rules?: RulesName;
  /** The tick this view describes (ticks completed). */
  readonly tick: number;
  readonly agentId: string;
  readonly colony: ColonyId;
  /** Absent for a colony without a name (colonies 2 and 3 of a four-colony match). */
  readonly colonyName?: string;
  readonly idle: boolean;
  readonly ticksLeft: number;
  readonly secondsLeft: number;
  readonly squad: readonly {
    readonly antId: number;
    readonly x: number;
    readonly y: number;
    readonly tileX: number;
    readonly tileY: number;
    readonly hp: number;
    readonly carrying: boolean;
    /** Rules switch on only. */
    readonly caste?: Caste;
  }[];
  /** Own nests are known even outside colony sight; enemy nests remain fogged. */
  readonly queens?: readonly { readonly queenId: number; readonly tileX: number; readonly tileY: number; readonly foundedTick: number; readonly lostTick: number | null; readonly overrunTicks: number; readonly hp?: number; readonly maxHp?: number; readonly owner?: string; readonly brood?: Brood }[];
  readonly queenFounding?: { readonly cost: number; readonly cooldownTicks: number; readonly minDistanceTiles: number; readonly foodStore: number; readonly nextFoundTick: number; readonly maxLiveQueens?: number; readonly slotsRemaining?: number; readonly firstFoundTick?: number };
  readonly order: Order;
  readonly orderStatus: string;
  /** First tick at which an order change or standalone mark is accepted. */
  readonly nextCommandTick: number;
  /** Non-empty tiles within sight of any living ant of the colony. */
  readonly cells: readonly ViewCell[];
  /** The colony's marks within smell range of any living ant of the colony. */
  readonly marks: readonly ViewMark[];
  /** Each of the agent's own live marks, wherever it lies, with the squad ants following it under follow_trail now.
   * tileX/tileY is the mark's tile; a LINE mark adds its second end as toTileX/toTileY. */
  readonly myMarks: readonly (CountMarkFields & { readonly markId: number; readonly steering: number; readonly tileX: number; readonly tileY: number; readonly toTileX?: number; readonly toTileY?: number })[];
  /** The colony's own territory: one string per map row, '#' own tile, '.' otherwise. */
  readonly territoryRows: readonly string[];
  /** Original-tile physical area; fine terrain may leave a fractional boundary cell. */
  readonly territoryTiles: number;
  /** Own tiles as a permille share of the map. */
  readonly territorySharePermille: number;
  /** Events within colony sight when they happened, since this agent's previous call. */
  readonly events: readonly VisibleEvent[];
  readonly result: MatchResult | null;
}

/** How each agent-visible event kind reaches agents. Exhaustive over VisibleEvent:
 * adding a kind to VisibleEvent without classifying it here fails compilation.
 * sighted: recordSightings queues it into agents' events while within colony sight.
 * publicCaste: observe replies drop a caste other than worker/soldier (publicCountCaste). */
export interface VisibleEventKind {
  readonly sighted: boolean;
  readonly publicCaste: boolean;
}
export type VisibleEventKinds<K extends string = VisibleEvent["type"]> = { readonly [P in K]: VisibleEventKind };

export const VISIBLE_EVENT_KINDS: VisibleEventKinds = {
  hatch: { sighted: true, publicCaste: false },
  fight: { sighted: true, publicCaste: false },
  death: { sighted: true, publicCaste: false },
  mark_laid: { sighted: true, publicCaste: true },
  queen_founded: { sighted: true, publicCaste: false },
  queen_lost: { sighted: true, publicCaste: false },
  // Never sighted: placing a count mark pushes it straight onto the placing agent's pendingEvents.
  count_mark_accepted: { sighted: false, publicCaste: true },
};

const SIGHTED_KINDS: ReadonlySet<string> = new Set(
  Object.entries(VISIBLE_EVENT_KINDS).filter(([, kind]) => kind.sighted).map(([type]) => type));

export function isVisibleEvent(event: SimEvent): event is VisibleEvent {
  return SIGHTED_KINDS.has(event.type);
}

function squadOf(state: SimState, agent: Agent): Ant[] {
  return state.ants.filter((ant) => ant.squad === agent.id);
}

/** Ephemeral post-movement projections. The caller discards this with the tick. */
export interface VisibilityContext {
  range(colony: ColonyId, range: number): Uint8Array;
  cells(colony: ColonyId, grid: Grid): readonly ViewCell[];
}

export function createVisibility(state: SimState): VisibilityContext {
  const { config } = state;
  // Each colony's occupied tiles, once each in first-seen order (the order a Set of them iterates in).
  const origins: number[][] = state.colonies.map(() => []);
  const seenBy = new Uint8Array(config.mapWidth * config.mapHeight);
  for (const ant of state.ants) if (ant.hp > 0) {
    const tile = tileIndex(config, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)), bit = 1 << ant.colony;
    if (tile >= 0 && tile < seenBy.length) {
      if ((seenBy[tile]! & bit) === 0) { seenBy[tile] = seenBy[tile]! | bit; origins[ant.colony].push(tile); }
    } else if (!origins[ant.colony].includes(tile)) origins[ant.colony].push(tile);
  }
  const masks = new Map<string, Uint8Array>();
  const projections = new WeakMap<Grid, Map<ColonyId, readonly ViewCell[]>>();
  const queens = new Map<number, { colony: ColonyId; hp?: number }>();
  for (const colony of state.colonies) for (const queen of activeQueens(colony)) {
    const index = tileIndex(config, Math.floor(queen.queenX / SUB), Math.floor(queen.queenY / SUB));
    // Preserve the original first-colony/first-queen selection on a shared tile.
    if (!queens.has(index)) queens.set(index, { colony: colony.id, ...(queen.hp === undefined ? {} : { hp: queen.hp }) });
  }
  const range = (colony: ColonyId, radius: number): Uint8Array => {
    const key = colony + ":" + radius;
    const cached = masks.get(key);
    if (cached !== undefined) return cached;
    const seen = new Uint8Array(config.mapWidth * config.mapHeight);
    if (Number.isInteger(radius)) {
      // The same union of row spans as the fills below, without filling each span: every span adds one
      // start and one end count to its row (one slot past each row's end), and the rows the spans reach
      // are then swept once, a tile seen while any span is open.
      const width = config.mapWidth, height = config.mapHeight, row = width + 1, edges = new Int32Array(row * height);
      let top = height, bottom = -1;
      // Each row offset's half-width, by the same expression the rows below used per origin.
      const half = new Float64Array(radius + 1);
      for (let d = 0; d <= radius; d++) half[d] = Math.floor(Math.sqrt(radius * radius - d ** 2));
      for (const origin of origins[colony]) {
        const ax = origin % width, ay = Math.floor(origin / width);
        const from = Math.max(0, ay - radius), to = Math.min(height - 1, ay + radius);
        if (from < top) top = from;
        if (to > bottom) bottom = to;
        for (let y = from; y <= to; y++) {
          const dx = half[y < ay ? ay - y : y - ay]!;
          edges[y * row + Math.max(0, ax - dx)]! += 1;
          edges[y * row + Math.min(width - 1, ax + dx) + 1]! -= 1;
        }
      }
      for (let y = top; y <= bottom; y++) {
        let open = 0;
        for (let x = 0, at = y * row, tile = y * width; x < width; x++) {
          open += edges[at + x]!;
          seen[tile + x] = open > 0 ? 1 : 0;
        }
      }
      masks.set(key, seen);
      return seen;
    }
    for (const origin of origins[colony]) {
      const ax = origin % config.mapWidth, ay = Math.floor(origin / config.mapWidth);
      for (let y = Math.max(0, ay - radius); y <= Math.min(config.mapHeight - 1, ay + radius); y++) {
        const dx = Math.floor(Math.sqrt(radius * radius - (y - ay) ** 2));
        seen.fill(1, y * config.mapWidth + Math.max(0, ax - dx), y * config.mapWidth + Math.min(config.mapWidth - 1, ax + dx) + 1);
      }
    }
    masks.set(key, seen);
    return seen;
  };
  return { range, cells(colony, grid) {
    let byColony = projections.get(grid);
    if (byColony === undefined) { byColony = new Map(); projections.set(grid, byColony); }
    const cached = byColony.get(colony);
    if (cached !== undefined) return cached;
    const sight = range(colony, config.sightTiles), cells: ViewCell[] = [];
    for (let index = 0; index < sight.length; index++) {
      if (sight[index] === 0) continue;
      const food = state.food[index] ?? 0, occupants = grid.get(index), queen = queens.get(index);
      if (food === 0 && (occupants?.length ?? 0) === 0 && queen === undefined) continue;
      cells.push({ tileX: index % config.mapWidth, tileY: Math.floor(index / config.mapWidth), food,
        ants: (occupants ?? []).map(a => ({ antId: a.id, colony: a.colony, hp: a.hp, ...casteOf(a) })),
        ...(queen === undefined ? {} : { queen: queen.colony, ...(queen.hp === undefined ? {} : { queenHp: queen.hp }) }) });
    }
    byColony.set(colony, cells);
    return cells;
  } };
}

/**
 * Add events within current living-colony sight to each agent's own queue.
 * Own queen events remain global; mark events remain private to their colony.
 */
export function recordSightings(state: SimState, events: readonly SimEvent[], visibility = createVisibility(state)): void {
  const visible = events.filter(isVisibleEvent);
  if (visible.length === 0) return;
  for (const colony of state.colonies) {
    const agents = state.agents.filter((agent) => agent.colony === colony.id);
    if (agents.length === 0) continue;
    const seen = visibility.range(colony.id, state.config.sightTiles);
    for (const agent of agents) {
      for (const event of visible) {
        if (event.type === "mark_laid" && event.colony !== colony.id) continue;
        const ownQueen = (event.type === "queen_founded" || event.type === "queen_lost") && event.colony === colony.id;
        if (ownQueen || seen[tileIndex(state.config, event.tileX, event.tileY)] === 1) agent.pendingEvents.push(event);
      }
    }
  }
}

/**
 * Known food: each tile within sight of a colony ant joins
 * the colony memory while it holds food and leaves it when seen empty. Only
 * colonies that keep a memory (redesign) are updated; the list stays sorted.
 */
export function recordSeenFood(state: SimState, visibility = createVisibility(state)): void {
  for (const colony of state.colonies) {
    if (colony.seenFood === undefined) continue;
    const seen = visibility.range(colony.id, state.config.sightTiles);
    // The same ascending, duplicate-free list as the Set below, kept as one flag per tile; a stored
    // entry that is not a tile index takes the Set path, which keeps such entries as they are.
    const stored = colony.seenFood;
    let ascending = true;
    for (let k = 0; k < stored.length && ascending; k += 1) {
      const i = stored[k]!;
      ascending = Number.isInteger(i) && i >= 0 && i < seen.length && (k === 0 || i > stored[k - 1]!);
    }
    if (ascending) {
      // A strictly ascending list of tile indices: one pass in tile order keeps each unseen known tile and each
      // seen tile holding food, the same list the flags below would give, already in order.
      const next: number[] = [];
      for (let i = 0, k = 0; i < seen.length; i += 1) {
        const wasKnown = k < stored.length && stored[k] === i;
        if (wasKnown) k += 1;
        if (seen[i] === 0 ? wasKnown : (state.food[i] ?? 0) > 0) next.push(i);
      }
      colony.seenFood = next;
      continue;
    }
    if (colony.seenFood.every((i) => Number.isInteger(i) && i >= 0 && i < seen.length)) {
      const flags = new Uint8Array(seen.length);
      for (const i of colony.seenFood) flags[i] = 1;
      for (let i = 0; i < seen.length; i += 1) if (seen[i] !== 0) flags[i] = (state.food[i] ?? 0) > 0 ? 1 : 0;
      const next: number[] = [];
      for (let i = 0; i < flags.length; i += 1) if (flags[i] === 1) next.push(i);
      colony.seenFood = next;
      continue;
    }
    const known = new Set(colony.seenFood);
    for (let i = 0; i < seen.length; i += 1) {
      if (seen[i] === 0) continue;
      if ((state.food[i] ?? 0) > 0) known.add(i);
      else known.delete(i);
    }
    colony.seenFood = [...known].sort((a, b) => a - b);
  }
}

function orderStatus(state: SimState, grid: Grid, agent: Agent, squad: readonly Ant[]): string {
  if (agent.idle) return state.config.commandIdleTicks === undefined
    ? "idle: no squad until your next call" : "idle: no squad until your next accepted command";
  if (squad.length === 0) return "waiting for spare ants";
  const engaged = squad.filter((ant) => hasAdjacentEnemy(state, grid, ant)).length;
  const fighting = engaged > 0 ? `; ${engaged} fighting` : "";
  const order = agent.order;
  switch (order.kind) {
    case "go_to":
    case "attack": {
      const cx = tileCentre(order.tileX);
      const cy = tileCentre(order.tileY);
      const arrival = ARRIVE * gridScaleOf(state.config);
      const arrived = squad.filter((a) => (a.x - cx) ** 2 + (a.y - cy) ** 2 <= arrival * arrival).length;
      return `${arrived === squad.length ? "arrived" : `moving (${arrived}/${squad.length} arrived)`}${fighting}`;
    }
    case "forage":
      return `foraging (${squad.filter((a) => a.carrying).length} carrying)${fighting}`;
    case "hold":
      return `holding${fighting}`;
    case "follow_trail": {
      if (state.config.wordMarksDisabled) return "unavailable order";
      const mark = trailMark(state, squad, state.tick);
      return `${mark === null ? "no mark in smell range: foraging" : `following mark ${mark.id}`}${fighting}`;
    }
  }
}

/** An ant's caste field: set only with the caste switch on. */
function casteOf(ant: Ant): { caste?: Caste } {
  return ant.caste === undefined ? {} : { caste: ant.caste };
}

/**
 * The agent's one view,
 * stamped with its tick. Takes and clears the agent's pending events,
 * so each event reaches it exactly once.
 */
export function takeView(state: SimState, grid: Grid, agent: Agent, visibility = createVisibility(state)): AgentView {
  const { config } = state;
  const squad = squadOf(state, agent);
  const cells = visibility.cells(agent.colony, grid);
  const smell = visibility.range(agent.colony, config.smellTiles);
  const patrol = config.patrolLinkTiles === undefined ? undefined : patrolChains(state);

  const marks: ViewMark[] = state.marks
    .filter((m) => m.colony === agent.colony && smell[tileIndex(config, m.tileX, m.tileY)] === 1)
    .map((m) => ({
      markId: m.id,
      words: m.words,
      tileX: m.tileX,
      tileY: m.tileY,
      ticksLeft: config.markLifetimeTicks - (state.tick - m.laidTick),
      mine: m.agentId === agent.id,
      ...countOf(state, m, patrol),
    }));

  const rows: string[] = [];
  let own = 0;
  for (let ty = 0; ty < config.mapHeight; ty += 1) {
    let row = "";
    for (let tx = 0; tx < config.mapWidth; tx += 1) {
      const mine = state.owner[tileIndex(config, tx, ty)] === agent.colony;
      if (mine) own += 1;
      row += mine ? "#" : ".";
    }
    rows.push(row);
  }

  const events = agent.pendingEvents;
  agent.pendingEvents = [];
  const ticksLeft = Math.max(0, config.matchTicks - state.tick);
  return {
    ...(config.rules === undefined ? {} : { rules: config.rules }),
    ...(state.terrain === undefined ? {} : { terrain: terrainView(state.terrain) }),
    tick: state.tick,
    agentId: agent.id,
    colony: agent.colony,
    ...(COLONY_NAMES[agent.colony] === undefined ? {} : { colonyName: COLONY_NAMES[agent.colony] }),
    idle: agent.idle,
    ticksLeft,
    secondsLeft: Math.ceil(ticksLeft / config.ticksPerSecond),
    squad: squad.map((a) => ({
      antId: a.id,
      x: a.x,
      y: a.y,
      tileX: Math.floor(a.x / SUB),
      tileY: Math.floor(a.y / SUB),
      hp: a.hp,
      carrying: a.carrying,
      ...casteOf(a),
    })),
    // Rules 27: no colony vote; each live queen entry carries her owner and brood.
    ...(config.queenFounding === undefined ? {} : {
      queens: queensOf(state.colonies[agent.colony]).map((q) => ({ queenId: q.id, tileX: Math.floor(q.queenX / SUB), tileY: Math.floor(q.queenY / SUB),
        foundedTick: q.foundedTick, lostTick: q.lostTick, overrunTicks: q.overrunTicks,
        ...(q.hp === undefined || config.queenHp === undefined ? {} : { hp: q.hp, maxHp: config.queenHp.hp }),
        ...(q.lostTick !== null ? {} : { ...(q.owner === undefined ? {} : { owner: q.owner }),
          ...(config.castes === undefined ? {} : { brood: q.brood ?? "mixed" }) }) })),
      queenFounding: { ...config.queenFounding, cost: queenFoundingCost(state.colonies[agent.colony], config.queenFounding), foodStore: state.colonies[agent.colony].foodStore,
        ...(config.queenFounding.maxLiveQueens === undefined ? {} : { slotsRemaining: Math.max(0, config.queenFounding.maxLiveQueens - activeQueens(state.colonies[agent.colony]).length) }),
        nextFoundTick: Math.max(state.tick, nextQueenFoundingTick(state.colonies[agent.colony], config.queenFounding)) },
    }),
    order: agent.order,
    orderStatus: orderStatus(state, grid, agent, squad),
    nextCommandTick: agent.lastCommandTick === null ? state.tick : Math.max(state.tick, agent.lastCommandTick + config.commandFloorTicks),
    cells,
    marks,
    myMarks: state.marks.filter((m) => m.agentId === agent.id).map((m) => ({ markId: m.id, steering: m.steering, tileX: m.tileX, tileY: m.tileY,
      ...(m.toTileX === undefined || m.toTileY === undefined ? {} : { toTileX: m.toTileX, toTileY: m.toTileY }), ...countOf(state, m, patrol) })),
    territoryRows: rows,
    territoryTiles: own / physicalTileArea(config),
    territorySharePermille: Math.trunc((own * 1000) / (config.mapWidth * config.mapHeight)),
    events,
    result: state.result,
  };
}

/** A count mark's current claims and optional cumulative combat totals; nothing for a word mark. */
function countOf(state: SimState, mark: SimState["marks"][number], patrol?: PatrolChains): CountMarkFields {
  if (mark.count === undefined || mark.verb === undefined) return {};
  let claimed = 0;
  for (const ant of state.ants) if (ant.claim === mark.id) claimed += 1;
  return { verb: mark.verb, count: mark.count, claimed,
    ...(state.config.countMarks?.casteSelection || mark.caste !== undefined ? { caste: mark.caste ?? "any" } : {}),
    ...(state.config.countMarks?.combatTotals ? { lost: mark.antsLost ?? 0, kills: mark.enemiesKilled ?? 0 } : {}),
    ...(patrol?.has(mark.id) ? { chain: patrol.get(mark.id)!.chain[0]!.id, position: patrol.get(mark.id)!.position } : {}) };
}

/** Lossless MCP-only cell table. Simulation/stream consumers keep AgentView. */
export interface DenseCells {
  readonly width: number;
  readonly height: number;
  readonly encoding: string;
  readonly foodRadix: number;
  /** Four-colony matches only: the colony count n of the ant kind encoding. */
  readonly colonies?: number;
  readonly data: string;
}

export const CELL_ENCODING = "base36 integers (signed); cells separated by ;: p[,queenColony[,queenHp]][:ants]. Reset previousIndex=0 (i) per page; d=floor(p/foodRadix); food=p-d*foodRadix; i+=d; x=i%width; y=floor(i/width). Food-only p*n repeats n times (n base36), updating i each time. queenColony=colony0/1 (own=view.colony), not queenId. Ants=antId.k separated by /; hp=floor(k/6), kind=k%6; kind 0/1=no caste, 2/3=worker, 4/5=soldier; even=colony0, odd=colony1. HP and queenHp are milli-HP. Absent queen/ants or empty data means none.";

/** The four-colony legend: ant kind k packs colony and caste over n colonies. */
export const FOUR_COLONY_CELL_ENCODING = "base36 integers (signed); cells separated by ;: p[,queenColony[,queenHp]][:ants]. Reset previousIndex=0 (i) per page; d=floor(p/foodRadix); food=p-d*foodRadix; i+=d; x=i%width; y=floor(i/width). Food-only p*n repeats n times (n base36), updating i each time. queenColony=colony id 0 to colonies-1 (own=view.colony), not queenId. Ants=antId.k separated by /; n=colonies; hp=floor(k/(3n)), r=k%(3n); colony=r%n; caste=floor(r/n): 0=no caste, 1=worker, 2=soldier. HP and queenHp are milli-HP. Absent queen/ants or empty data means none.";

function base36(value: number): string {
  if (!Number.isSafeInteger(value)) throw new RangeError("Cell integer exceeds the safe integer range");
  return value.toString(36);
}

/** colonies: the match's colony count; two colonies give today's bytes (k = hp*6 + colony + 2*caste). */
export function denseCells(cells: readonly ViewCell[], width: number, height: number, colonies = 2): DenseCells {
  const foodRadix = cells.reduce((max, cell) => Math.max(max, cell.food + 1), 1);
  const runs: { token: string; count: number; foodOnly: boolean }[] = [];
  let previousIndex = 0;
  for (const cell of cells) {
    const index = cell.tileY * width + cell.tileX;
    const header = [base36((index - previousIndex) * foodRadix + cell.food),
      ...(cell.queen === undefined ? [] : [base36(cell.queen), ...(cell.queenHp === undefined ? [] : [base36(cell.queenHp)])])].join(",");
    previousIndex = index;
    const ants = cell.ants.map(ant => [ant.antId, ant.hp * 3 * colonies +
      ant.colony + colonies * (ant.caste === undefined ? 0 : ant.caste === "worker" ? 1 : 2)].map(base36).join(".")).join("/");
    const token = ants === "" ? header : `${header}:${ants}`;
    const foodOnly = cell.queen === undefined && ants === "";
    const last = runs.at(-1);
    if (foodOnly && last?.foodOnly && last.token === token) last.count += 1;
    else runs.push({ token, count: 1, foodOnly });
  }
  return { width, height, encoding: colonies === 2 ? CELL_ENCODING : FOUR_COLONY_CELL_ENCODING, foodRadix, ...(colonies === 2 ? {} : { colonies }),
    data: runs.map(run => run.count === 1 ? run.token : `${run.token}*${base36(run.count)}`).join(";") };
}

/** Decoder for the one delta/run-length text grammar, not a second simulation view. */
export function expandCells(table: DenseCells): ViewCell[] {
  if (table.data === "") return [];
  const n = (value: string) => {
    if (!/^-?[0-9a-z]+$/.test(value)) throw new RangeError("Invalid base36 cell integer");
    const parsed = parseInt(value, 36);
    if (!Number.isSafeInteger(parsed)) throw new RangeError("Cell integer exceeds the safe integer range");
    return parsed;
  };
  if (!Number.isSafeInteger(table.foodRadix) || table.foodRadix < 1) throw new RangeError("Invalid food radix");
  const colonies = table.colonies ?? 2, kinds = 3 * colonies;
  const cells: ViewCell[] = [];
  let previousIndex = 0;
  for (const row of table.data.split(";")) {
    const [token, repeat] = row.split("*") as [string, string?];
    const count = repeat === undefined ? 1 : n(repeat);
    if (count < 1 || cells.length + count > table.width * table.height || (repeat !== undefined && /[:,]/.test(token))) throw new RangeError("Invalid cell repeat count");
    const [header, body = ""] = token.split(":") as [string, string?];
    const [packedTile, queen, queenHp] = header.split(",").map(n) as [number, ColonyId?, number?];
    const delta = Math.floor(packedTile / table.foodRadix), food = packedTile - delta * table.foodRadix;
    const ants = body === "" ? [] : body.split("/").map(record => {
      const [antId, packed] = record.split(".").map(n) as [number, number];
      const hp = Math.floor(packed / kinds), kind = packed % kinds, caste = Math.floor(kind / colonies);
      return { antId, hp, colony: (kind % colonies) as ColonyId,
        ...(caste === 0 ? {} : { caste: (caste === 1 ? "worker" : "soldier") as Caste }) };
    });
    for (let i = 0; i < count; i++) {
      const index = previousIndex + delta;
      if (!Number.isSafeInteger(index) || index < 0 || index >= table.width * table.height) throw new RangeError("Cell index outside map");
      previousIndex = index;
      cells.push({ tileX: index % table.width, tileY: Math.floor(index / table.width), food, ants,
        ...(queen === undefined ? {} : { queen }), ...(queenHp === undefined ? {} : { queenHp }) });
    }
  }
  return cells;
}
