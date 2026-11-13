import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, RULES_MARKERS, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { createMatch, newAnt, tileIndex } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { playable } from "../playable.ts";
import type { Ant, ColonyId, SimEvent, SimInput, SimState, StepOutput, TileOwner } from "../../src/sim/types.js";

/** Stored pre-frontline tuning, not live defaults with one field overridden. Every config plays
 * RULES_VERSION 27, so each carries the current rules markers. */
const stamped = (config: SimConfig): SimConfig => ({ ...RULES_MARKERS, ...config });
export const PRE_FRONTLINE_CONFIGS = Object.fromEntries(Object.entries(JSON.parse(readFileSync(
  new URL("./fixtures/pre-frontline-configs.json", import.meta.url), "utf8",
)) as Record<string, SimConfig>).map(([name, config]) => [name, stamped(config)])) as Readonly<Record<"public" | "count-marks" | "redesign", SimConfig>>;
export const PRE_FRONTLINE_PUBLIC_CONFIG = PRE_FRONTLINE_CONFIGS.public;
/** The default tuning before nest picks, read from a stored log header, with the current rules markers. */
export const HISTORICAL_DEFAULT_CONFIG = stamped((JSON.parse(readFileSync(
  new URL("./fixtures/pre-pick-default.jsonl", import.meta.url), "utf8",
).split("\n")[0]!) as { config: SimConfig }).config);
export const HISTORICAL_CASTE_CONFIG: SimConfig = {
  ...HISTORICAL_DEFAULT_CONFIG, castes: PRE_FRONTLINE_PUBLIC_CONFIG.castes,
};

/** Historical economy at main 271809a567bf2896de04baa29bba55658e9af536.
 * Keep old scenario/golden fixtures independent of the new public tuning. */
export const HISTORICAL_CONFIG: SimConfig = {
  ...HISTORICAL_DEFAULT_CONFIG,
  matchTicks: 12 * 60 * 10,
  overrunGraceTicks: 600,
  overrunTicks: 100,
  guardCount: 2,
  guardSharePermille: undefined,
  guardEngageTiles: 3,
  colonyCap: 150,
  hatchCost: 3,
  hatchIntervalTicks: 18,
  foodRegrowTicks: 150,
  foodPatches: [
    { tileX: 12, tileY: 24, radius: 2, perTile: 2 },
    { tileX: 18, tileY: 9, radius: 2, perTile: 3 },
    { tileX: 18, tileY: 39, radius: 2, perTile: 3 },
    { tileX: 30, tileY: 24, radius: 3, perTile: 8 },
  ],
};

/** Recorded public controls at main 0d0139c3e122cc400304cc7ed9039835344933b3.
 * Preserve field order as well as values: historical header/state hashes include it.
 * This fixture predates seeded food and terrain; their old-header tests opt out explicitly.
 */
export const HISTORICAL_PUBLIC_CONFIG: SimConfig = {
  ...HISTORICAL_CASTE_CONFIG,
  guardSharePermille: 400,
  queenFounding: {
    cost: 400, costMultiplier: 2, costBasis: "live", maxLiveQueens: 4,
    firstFoundTick: 3000, cooldownTicks: 1800, minDistanceTiles: 16,
    houseReserveFood: 200, standingNestsOnly: true,
    guardsPerQueen: true, totalGuardSharePermille: 600,
  },
};

export const FIXTURE_SEED = 10;
/** Snapshots of the shared house-only match are kept every SNAPSHOT_EVERY ticks. */
export const SNAPSHOT_EVERY = 300;

export interface HouseOnlyMatch {
  readonly initial: SimState;
  readonly final: SimState;
  /** State after each multiple of SNAPSHOT_EVERY ticks, keyed by state.tick. */
  readonly snapshots: ReadonlyMap<number, SimState>;
  readonly events: readonly SimEvent[];
}

let memo: HouseOnlyMatch | null = null;

/** One seeded house-only match on the historical config, played once per test file. */
export function houseOnlyMatch(): HouseOnlyMatch {
  if (memo !== null) return memo;
  const initial = createMatch(FIXTURE_SEED, playable(HISTORICAL_CONFIG));
  const snapshots = new Map<number, SimState>([[0, initial]]);
  const events: SimEvent[] = [];
  let state = initial;
  while (state.result === null) {
    const out = step(state);
    state = out.state;
    events.push(...out.events);
    if (state.tick % SNAPSHOT_EVERY === 0) snapshots.set(state.tick, state);
  }
  memo = { initial, final: state, snapshots, events };
  return memo;
}

/** A match with no ants at the given tick, for scripted scenarios. */
export function emptyMatch(tick = 0, config: SimConfig = DEFAULT_CONFIG): SimState {
  const state = createMatch(FIXTURE_SEED, playable(config));
  state.ants = [];
  state.tick = tick;
  return state;
}

/** Place an ant at a tile centre; returns the ant (owned by the state). */
export function addAnt(state: SimState, colony: ColonyId, tx: number, ty: number, patch: Partial<Ant> = {}): Ant {
  const ant: Ant = { ...newAnt(state.config, state.nextAntId, colony, tileCentre(tx), tileCentre(ty)), ...patch };
  state.nextAntId += 1;
  state.ants.push(ant);
  return ant;
}

export function setOwner(state: SimState, tx: number, ty: number, owner: TileOwner): void {
  state.owner[tileIndex(state.config, tx, ty)] = owner;
}

export function ownerAt(state: SimState, tx: number, ty: number): TileOwner {
  return state.owner[tileIndex(state.config, tx, ty)] ?? -1;
}

export function antById(state: SimState, id: number): Ant | undefined {
  return state.ants.find((ant) => ant.id === id);
}

/** Step n ticks, collecting events. */
export function run(state: SimState, ticks: number): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  let current = state;
  for (let i = 0; i < ticks && current.result === null; i += 1) {
    const out = step(current);
    current = out.state;
    events.push(...out.events);
  }
  return { state: current, events };
}

/** Step one tick with these inputs. */
export function send(state: SimState, inputs: readonly SimInput[]): StepOutput {
  return step(state, inputs);
}

export function squadOf(state: SimState, agentId: string): Ant[] {
  return state.ants.filter((ant) => ant.squad === agentId);
}
