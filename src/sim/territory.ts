import { SUB } from "./config.js";
import { clearLostQueenSpawn, forEachNear, hasAdjacentEnemy, type Grid } from "./map.js";
import { gridScaleOf, physicalTileArea } from "./gridScale.js";
import { passableMask } from "./terrain.js";
import type { Ant, ColonyId, MatchResult, SimEvent, SimState } from "./types.js";

/**
 * Presence territory. A tile goes to
 * the colony whose ant stands on it and returns to neutral territoryDecayTicks
 * after that colony's last visit. While an ant on a tile has an enemy within
 * combat reach the tile is locked: it cannot change owner, to the other colony
 * or to neutral. The decay clock is not held: only an ant of the owning colony
 * standing on the tile refreshes its last visit, so a tile whose owner has been
 * away 20 s goes neutral as soon as the fight on it ends.
 */
/** Per-call scratch for updateTerritory, reused while the map size stays the same. */
let scratchSize = -1, cellStamp = new Int32Array(0), cellHead = new Int32Array(0), cellTail = new Int32Array(0), stamp = 0;
let present = new Uint8Array(0), occupied = new Uint8Array(0), antNext = new Int32Array(0), cellOrder = new Int32Array(0);

/** grid: not read (presence is taken from the ants); callers may omit it. */
export function updateTerritory(state: SimState, grid: Grid | undefined, tick: number): void {
  const { config } = state;
  const scale = gridScaleOf(config);
  const width = config.mapWidth, height = config.mapHeight, owner = state.owner, lastVisit = state.lastVisit;
  const ants = state.ants, n = ants.length, size = owner.length;
  if (scratchSize !== size) {
    scratchSize = size; cellStamp = new Int32Array(size); cellHead = new Int32Array(size); cellTail = new Int32Array(size);
    present = new Uint8Array(size); occupied = new Uint8Array(size); stamp = 0;
  } else { present.fill(0); occupied.fill(0); }
  if (antNext.length < n) { antNext = new Int32Array(Math.max(n, antNext.length * 2)); cellOrder = new Int32Array(antNext.length); }
  stamp += 1;
  // Presence covers the same original cell, subdivided only for terrain fidelity.
  // Do not let a fine-cell subdivision multiply area held, income or decay clocks.
  // Each original cell's ants as a list in state.ants order, and the cells in the order first stood on
  // (as the Map keyed by cell held them). present: the colonies standing on each tile (bit 1 << colony).
  let cells = 0;
  for (let i = 0; i < n; i++) {
    const ant = ants[i]!;
    const x = Math.floor(ant.x / (SUB * scale)) * scale;
    const y = Math.floor(ant.y / (SUB * scale)) * scale;
    const index = y * width + x;
    antNext[i] = -1;
    if (cellStamp[index] !== stamp) { cellStamp[index] = stamp; cellHead[index] = i; cellOrder[cells++] = index; }
    else antNext[cellTail[index]!] = i;
    cellTail[index] = i;
    present[Math.floor(ant.y / SUB) * width + Math.floor(ant.x / SUB)]! |= 1 << ant.colony;
  }
  // hasAdjacentEnemy on the synced grid: an enemy on a tile within Chebyshev reach. enemy: every
  // colony bit but the ant's own (colonies 0 to 3).
  const adjacentEnemy = (ant: Ant): boolean => {
    const tx = Math.floor(ant.x / SUB), ty = Math.floor(ant.y / SUB), enemy = 0b1111 & ~(1 << ant.colony);
    const x0 = Math.max(0, tx - scale), x1 = Math.min(width - 1, tx + scale);
    const y1 = Math.min(height - 1, ty + scale);
    for (let y = Math.max(0, ty - scale); y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) if ((present[row + x]! & enemy) !== 0) return true;
    }
    return false;
  };
  const land = state.terrain === undefined ? undefined : passableMask(config, state.terrain);
  for (let c = 0; c < cells; c++) {
    const origin = cellOrder[c]!, head = cellHead[origin]!;
    let locked: boolean | undefined;
    let colony: ColonyId | null = null;
    let colonies = 0;
    for (let i = head; i !== -1; i = antNext[i]!) { colony = ants[i]!.colony; colonies |= 1 << colony; }
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const index = origin + y * width + x;
      if (land !== undefined && !land[index]) continue;
      occupied[index] = 1;
      // Two or more colonies in one original cell are within combat reach of each other.
      if (locked === undefined) {
        locked = (colonies & (colonies - 1)) !== 0;
        for (let i = head; !locked && i !== -1; i = antNext[i]!) locked = adjacentEnemy(ants[i]!);
      }
      if (locked) {
        const own = owner[index];
        for (let i = head; i !== -1; i = antNext[i]!) if (ants[i]!.colony === own) { lastVisit[index] = tick; break; }
        continue;
      }
      if (colony === null) continue;
      const previous = owner[index];
      if (previous !== -1 && previous !== colony) state.stats.ownerChanges += 1;
      owner[index] = colony;
      lastVisit[index] = tick;
    }
  }
  const decay = config.territoryDecayTicks;
  for (let i = 0; i < size; i += 1) {
    if (owner[i] === -1 || occupied[i] === 1) continue;
    if (tick - lastVisit[i]! >= decay) owner[i] = -1;
  }
}

/** Physical original-tile areas held by each colony, including partial terrain cells. */
export function territoryCounts(state: SimState): [number, number] {
  const counts: [number, number] = [0, 0];
  for (const owner of state.owner) if (owner !== -1) counts[owner] += 1;
  const area = physicalTileArea(state.config);
  return [counts[0] / area, counts[1] / area];
}

function antsAlive(state: SimState): [number, number] {
  const counts: [number, number] = [0, 0];
  for (const ant of state.ants) counts[ant.colony] += 1;
  return counts;
}

function compare(values: readonly [number, number]): ColonyId | null {
  if (values[0] > values[1]) return 0;
  if (values[1] > values[0]) return 1;
  return null;
}

/** Shared time-up / simultaneous last-queen-loss scoring. Old configs keep territory first. */
export function decideTimeUp(state: SimState, tick: number, reason: "time_up" | "double_overrun" | "queens_killed"): MatchResult {
  if (state.config.adjudication === "kills-first") {
    // Every ant death is caused by the opposing colony, including its queens.
    const byKills = compare([state.stats.deaths[1], state.stats.deaths[0]]);
    if (byKills !== null) return { winner: byKills, reason, decidedBy: "kills", tick };
  }
  const byTiles = compare(territoryCounts(state));
  if (byTiles !== null) return { winner: byTiles, reason, decidedBy: "territory", tick };
  const byAnts = compare(antsAlive(state));
  if (byAnts !== null) return { winner: byAnts, reason, decidedBy: "ants_alive", tick };
  const byFood = compare([state.stats.delivered[0], state.stats.delivered[1]]);
  if (byFood !== null) return { winner: byFood, reason, decidedBy: "food_delivered", tick };
  return { winner: null, reason, decidedBy: "draw", tick };
}

/** Advance one consecutive-tick sustained-lead clock; ties and insufficient leads reset it. */
export function sustainedTerritoryWin(state: SimState, tick: number): MatchResult | null {
  const rules = state.config.earlyWin;
  if (rules === undefined) return null;
  const held = territoryCounts(state);
  const leader = compare(held);
  const qualifies = tick >= rules.minTick && leader !== null && held[leader] >= rules.minHeldTiles &&
    held[leader] * 1000 >= Math.max(1, held[leader === 0 ? 1 : 0]) * rules.territoryRatioPermille;
  const previous = state.earlyWinProgress;
  const progress = qualifies
    ? { leader, ticks: previous?.leader === leader ? previous.ticks + 1 : 1 }
    : { leader: null, ticks: 0 };
  state.earlyWinProgress = progress;
  if (!qualifies || progress.ticks < rules.holdTicks) return null;
  return { winner: leader, reason: "sustained_territory", decidedBy: "territory", tick };
}

/**
 * Queen overrun. After the grace period, each tick an enemy majority
 * within overrunRadiusTiles (Chebyshev) of a queen adds one tick of progress;
 * anything else resets it. Reaching overrunTicks wins for the enemy; both
 * queens on the same tick is decided as at time-up.
 */
export function updateOverrun(state: SimState, grid: Grid, tick: number, events: SimEvent[]): MatchResult | null {
  const { config } = state;
  if (tick < config.overrunGraceTicks) return null;
  if (config.queenFounding !== undefined) return updateQueensOverrun(state, grid, tick, events);
  const overrun: ColonyId[] = [];
  for (const colony of state.colonies) {
    let own = 0;
    let enemy = 0;
    forEachNear(
      state,
      grid,
      Math.floor(colony.queenX / SUB),
      Math.floor(colony.queenY / SUB),
      config.overrunRadiusTiles,
      (ant) => {
        if (ant.colony === colony.id) own += 1;
        else if (!ant.carrying) enemy += 1;
      },
    );
    const before = colony.overrunTicks;
    colony.overrunTicks = enemy > own ? before + 1 : 0;
    if (colony.overrunTicks > 0 || before > 0) {
      events.push({
        type: "overrun_progress",
        tick,
        colony: colony.id,
        progressTicks: colony.overrunTicks,
        requiredTicks: config.overrunTicks,
      });
    }
    if (colony.overrunTicks >= config.overrunTicks) overrun.push(colony.id);
  }
  if (overrun.length === 2) return decideTimeUp(state, tick, "double_overrun");
  const lost = overrun[0];
  if (lost === undefined) return null;
  return { winner: lost === 0 ? 1 : 0, reason: "overrun", decidedBy: "overrun", tick };
}


function updateQueensOverrun(state: SimState, grid: Grid, tick: number, events: SimEvent[]): MatchResult | null {
  for (const colony of state.colonies) for (const q of colony.queens ?? []) {
    if (q.lostTick !== null) continue;
    let own = 0, enemy = 0;
    forEachNear(state, grid, Math.floor(q.queenX / SUB), Math.floor(q.queenY / SUB), state.config.overrunRadiusTiles, (ant) => {
      if (ant.colony === colony.id) own++;
      else if (!ant.carrying) enemy++;
    });
    const before = q.overrunTicks;
    q.overrunTicks = enemy > own ? before + 1 : 0;
    if (q.overrunTicks > 0 || before > 0) events.push({ type: "overrun_progress", tick, colony: colony.id, queenId: q.id,
      progressTicks: q.overrunTicks, requiredTicks: state.config.overrunTicks });
    if (q.overrunTicks >= state.config.overrunTicks) {
      q.lostTick = tick;
      events.push({ type: "queen_lost", tick, colony: colony.id, queenId: q.id,
        tileX: Math.floor(q.queenX / SUB), tileY: Math.floor(q.queenY / SUB) });
      clearLostQueenSpawn(state, colony.id, q);
    }
  }
  const lost = state.colonies.map((c) => (c.queens ?? []).every((q) => q.lostTick !== null));
  if (lost[0] && lost[1]) return decideTimeUp(state, tick, "double_overrun");
  if (!lost[0] && !lost[1]) return null;
  return { winner: lost[0] ? 1 : 0, reason: "overrun", decidedBy: "overrun", tick };
}

/**
 * Queens with HP: a colony loses when all its queens are
 * dead, won as "queens killed". Both colonies losing their last queen on the
 * same tick uses the recorded config's shared adjudication order, as at time-up.
 */
export function queensKilled(state: SimState, tick: number): MatchResult | null {
  const lost = state.colonies.map((c) => (c.queens ?? []).every((q) => q.lostTick !== null));
  if (lost[0] && lost[1]) return decideTimeUp(state, tick, "queens_killed");
  if (!lost[0] && !lost[1]) return null;
  return { winner: lost[0] ? 1 : 0, reason: "queens_killed", decidedBy: "queens_killed", tick };
}
