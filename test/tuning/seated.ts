/**
 * Seated tuning-loop matches: the rated-harness start (redesign rules, Wide Plain,
 * perSide ants prefilled per colony, one scripted front agent seated per colony at
 * tick 0) ticked under server policy, as Game.tick runs a live match.
 */
import { rulesConfig, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { WIDE_PLAIN } from "../../src/sim/scale2Maps.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch, mirrorX, newAnt } from "../../src/sim/map.js";
import { advance } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import { TUNING_MAP_ID, tuningMapConfig } from "../../src/sim/tuningMap.js";
import type { ColonyId, SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { frontAgent } from "../benchmark/agents.js";
import { namedColonyAllocator, type Brain, type Command } from "../benchmark/match.js";

export const DEFAULT_START = { map: "wide-plain", perSide: 768 } as const;

/**
 * The loop's Wide Plain: production's map with the loop's 768 ants per colony and 27,000 ticks pinned here, so the
 * loop's state does not follow production's Wide Plain limits (since moved to 1024 / 36,000). Keys keep
 * WIDE_PLAIN's order, so a seated start's config is byte for byte what it was at 768 / 27,000.
 */
const LOOP_WIDE_PLAIN: MapDefinition = { ...WIDE_PLAIN, colonyCap: 768, matchTicks: 27_000 };

/** Simulated per-call agent latency in ticks, as the rated harness. */
const DELAY = 30;

/**
 * The match config a seated start uses. Wide Plain places no starting ants; startSeated fills them. The tuning map
 * places its own (config.startAnts = perSide), so it gets no manual prefill. Unknown map throws.
 */
export function startConfig(map: string, perSide: number): SimConfig {
  if (map === TUNING_MAP_ID) return tuningMapConfig(perSide);
  if (map === "wide-plain") {
    const base = newMatchConfig(rulesConfig("redesign"));
    const maps = base.terrain!.maps.map(map => map.id === LOOP_WIDE_PLAIN.id ? LOOP_WIDE_PLAIN : map);
    return { ...base, colonyCap: perSide, startAnts: 0, terrain: { ...base.terrain!, maps, mapId: "wide-plain" } };
  }
  throw new Error(`unknown start map ${map}`);
}

export interface SeatedMatch { state: SimState }

interface Seat {
  readonly id: string;
  readonly colony: ColonyId;
  readonly brain: Brain;
  nextObserve: number;
  pending: { readonly tick: number; readonly command: Command } | null;
}

/** The scripted seats' loops: harness state outside SimState, never saved. */
const seats = new WeakMap<SeatedMatch, readonly Seat[]>();

export function startSeated(start: { map: string; perSide: number; seed: number }): SeatedMatch {
  const config = startConfig(start.map, start.perSide);
  const state = createMatch(start.seed, config);
  // A start whose config places no ants of its own (Wide Plain) is filled here; one that places its own is not.
  if (config.startAnts === 0) prefill(state, start.perSide);
  const c = state.config;
  const match: SeatedMatch = { state };
  seats.set(match, ([0, 1] as const).map((colony): Seat =>
    ({ id: `a${colony}`, colony, brain: frontAgent(c.markLifetimeTicks, c.mapWidth, c.mapHeight), nextObserve: 1, pending: null })));
  return match;
}

/** Each colony's back 40% band gets perSide ants, alternating castes, mirrored (the rated harness's method). */
function prefill(state: SimState, perSide: number): void {
  const c = state.config;
  const band = Math.floor(c.mapWidth * 0.4), cols = Math.round(Math.sqrt((perSide * band) / c.mapHeight)), rows = Math.ceil(perSide / cols);
  const taken = new Set<number>();
  const land = (x: number, y: number) => {
    for (let r = 0; r < c.mapWidth; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || tx >= band || ty < 0 || ty >= c.mapHeight || taken.has(ty * c.mapWidth + tx)) continue;
      if (isBlockedTile(state.terrain, tx, ty) || isBlockedTile(state.terrain, c.mapWidth - 1 - tx, ty)) continue;
      return { x: tx, y: ty };
    }
    throw new Error("no land");
  };
  for (let i = 0; i < perSide; i++) {
    const t = land(Math.floor(((i % cols) + 0.5) * band / cols), Math.floor((Math.floor(i / cols) + 0.5) * c.mapHeight / rows));
    taken.add(t.y * c.mapWidth + t.x);
    const x = tileCentre(t.x), y = tileCentre(t.y), caste = i % 2 === 0 ? "worker" : "soldier";
    state.ants.push(newAnt(c, state.nextAntId++, 0, x, y, caste));
    state.ants.push(newAnt(c, state.nextAntId++, 1, mirrorX(c, x), y, caste));
  }
}

/** One server-policy tick (houseActive true) with the seats' inputs; the seats then read their views. */
export function tickSeated(match: SeatedMatch): StepOutput & { readonly inputs: readonly SimInput[] } {
  const loops = seats.get(match);
  if (loops === undefined) throw new Error("not a seated match");
  const tick = match.state.tick;
  const inputs: SimInput[] = [], owners: (Seat | null)[] = [];
  if (tick === 0) for (const seat of loops) { inputs.push({ type: "join", agentId: seat.id, colony: seat.colony }); owners.push(null); }
  for (const seat of loops) {
    if (seat.pending?.tick === tick) {
      const k = seat.pending.command;
      inputs.push(k.type === "order"
        ? k.mark === undefined ? { type: "order", agentId: seat.id, order: k.order } : { type: "order", agentId: seat.id, order: k.order, mark: k.mark }
        : { type: "mark", agentId: seat.id, tileX: k.tileX, tileY: k.tileY, words: k.words });
      owners.push(null);
      seat.pending = null;
    }
    if (seat.nextObserve === tick) { inputs.push({ type: "observe", agentId: seat.id }); owners.push(seat); }
  }
  const out = advance(match.state, inputs, namedColonyAllocator, undefined, undefined, false, true);
  match.state = out.state;
  out.results.forEach((result, i) => {
    const seat = owners[i];
    if (seat === null || seat === undefined || result.view === null) return;
    const command = seat.brain.decide(result.view, tick + DELAY);
    if (command === null) seat.nextObserve = tick + DELAY;
    else { seat.pending = { tick: tick + DELAY, command }; seat.nextObserve = tick + 2 * DELAY; }
  });
  return { ...out, inputs };
}

/** Tick until the first death, then afterFirstDeath more ticks. Throws if the match ends first. */
export function playToBattle(match: SeatedMatch, afterFirstDeath = 0): void {
  let remaining = -1;
  while (remaining !== 0) {
    if (match.state.result !== null) throw new Error(`match ended at tick ${match.state.tick} before the battle point`);
    const out = tickSeated(match);
    if (remaining > 0) remaining -= 1;
    else if (remaining < 0 && out.events.some((e) => e.type === "death")) remaining = afterFirstDeath;
  }
}
