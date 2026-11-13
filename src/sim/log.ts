import { RULES_MARKERS, RULES_VERSION, type SimConfig } from "./config.js";
import { createMatch } from "./map.js";
import { gridScaleOf } from "./gridScale.js";
import { colonyCountOf } from "./mapBoard.js";
import { HOLD_BEHAVIOUR, parseHoldBehaviour, type HoldBehaviour } from "./holdBehaviour.js";
import { step, type ServerTerminal } from "./step.js";
import type { ColonyId, EliminationReason, SimInput, SimState } from "./types.js";

/**
 * JSONL match log. Line 1 is the header; each
 * later line holds one tick's inputs, every agent input including rejected
 * ones, so the squad timer replays exactly. Empty ticks are omitted unless a
 * server-only house policy or terminal control must also be replayed.
 * Writing the file is the server's job; these are the line formats.
 */
export interface LogHeader {
  readonly type: "header";
  readonly rulesVersion: number;
  readonly seed: number;
  readonly config: SimConfig;
  /** The assignment/food-hold behaviour the match played; required. */
  readonly holdBehaviour: HoldBehaviour;
}

export interface LogTick {
  readonly tick: number;
  readonly inputs: readonly SimInput[];
  /** Additive server control: adjudicate this terminal tick with the existing time-up rules. */
  readonly stop?: true;
  /** Rated house idle end; separate from operator stop and absent on old logs. */
  readonly abandoned?: true;
  /** Idle end outside the Model Index: the colonies whose seats went idle; absent on old logs. */
  readonly idle?: readonly ColonyId[];
  /** Adapter-owned house activity policy; absent on historical match logs. */
  readonly houseActive?: true;
  /** Four-colony matches: the colonies that left the match on this tick, and why. A record of
   * the tick's outcome, which replay derives again; it is not an input. */
  readonly eliminated?: readonly LoggedElimination[];
}

export interface LoggedElimination {
  readonly colony: ColonyId;
  readonly reason: EliminationReason;
}

/** The colonies a tick's state shows leaving the match on that tick, for its log line. */
export function eliminationsAt(state: SimState, tick: number): LoggedElimination[] {
  return state.colonies.flatMap(colony => colony.eliminated?.tick === tick ? [{ colony: colony.id, reason: colony.eliminated.reason }] : []);
}

export function headerLine(seed: number, config: SimConfig): string {
  const header: LogHeader = { type: "header", rulesVersion: RULES_VERSION, seed, config, holdBehaviour: HOLD_BEHAVIOUR };
  return JSON.stringify(header);
}

export function tickLine(tick: number, inputs: readonly SimInput[], stop: ServerTerminal = false, houseActive = false,
  eliminated: readonly LoggedElimination[] = []): string {
  const terminal = typeof stop === "object" ? { idle: [...stop.idle] } : stop === "abandoned" ? { abandoned: true as const } : stop ? { stop: true as const } : {};
  const line: LogTick = { tick, inputs, ...terminal, ...(houseActive ? { houseActive: true } : {}), ...(eliminated.length === 0 ? {} : { eliminated }) };
  return JSON.stringify(line);
}

export interface ParsedLog {
  readonly header: LogHeader;
  readonly ticks: Map<number, readonly SimInput[]>;
  readonly stops: ReadonlySet<number>;
  readonly abandonments: ReadonlySet<number>;
  readonly idle: ReadonlyMap<number, readonly ColonyId[]>;
  readonly houseActive: ReadonlySet<number>;
}

export function parseLog(lines: readonly string[]): ParsedLog {
  const [first, ...rest] = lines.filter((line) => line.trim() !== "");
  if (first === undefined) throw new Error("empty match log");
  const header = JSON.parse(first) as LogHeader;
  if (header.type !== "header") throw new Error("match log must start with its header");
  // Every match plays at grid scale 2: a header without it, or at scale 1 or 4, is refused.
  try { gridScaleOf(header.config); } catch (error) { throw new RangeError(`match log header: ${(error as Error).message}`); }
  // Only the current rules generation plays: its version, generation markers and hold behaviour.
  if (header.rulesVersion !== RULES_VERSION) throw new Error(`match log rules version ${header.rulesVersion} is not ${RULES_VERSION}, the only rules this build plays`);
  const missing = Object.entries(RULES_MARKERS).filter(([key, value]) => (header.config as unknown as Record<string, unknown>)[key] !== value).map(([key]) => key);
  if (missing.length > 0) throw new Error(`match log header config lacks the rules ${RULES_VERSION} markers: ${missing.join(", ")}`);
  parseHoldBehaviour(header.holdBehaviour);
  const ticks = new Map<number, readonly SimInput[]>();
  const stops = new Set<number>();
  const abandonments = new Set<number>();
  const idle = new Map<number, readonly ColonyId[]>();
  const houseActive = new Set<number>();
  const colonies = colonyCountOf(header.config);
  for (const line of rest) {
    const entry = JSON.parse(line) as LogTick;
    ticks.set(entry.tick, entry.inputs);
    if (entry.stop === true) stops.add(entry.tick);
    if (entry.abandoned === true) abandonments.add(entry.tick);
    if (entry.idle !== undefined) {
      const idleColonies = entry.idle;
      if (!Array.isArray(idleColonies) || idleColonies.length < 1 || idleColonies.length > colonies
        || idleColonies.some(c => !Number.isInteger(c) || c < 0 || c >= colonies) || new Set(idleColonies).size !== idleColonies.length) {
        throw new Error(`invalid idle colonies at log tick ${entry.tick}`);
      }
      idle.set(entry.tick, idleColonies);
    }
    if (entry.houseActive === true) houseActive.add(entry.tick);
  }
  return { header, ticks, stops, abandonments, idle, houseActive };
}

/** The server terminal a log recorded for one tick, as every replayer passes it to step. */
export function terminalAt(log: Pick<ParsedLog, "stops" | "abandonments" | "idle">, tick: number): ServerTerminal {
  const idle = log.idle.get(tick);
  if (idle !== undefined) return { idle };
  return log.abandonments.has(tick) ? "abandoned" : log.stops.has(tick);
}

/**
 * Re-simulate a match from its log lines: step over the parsed inputs from tick
 * 0 until untilTick ticks are done or the match ends. onTick sees each state.
 */
export function replay(
  lines: readonly string[],
  untilTick: number,
  onTick?: (state: SimState) => void,
): SimState {
  const log = parseLog(lines);
  const { header, ticks, houseActive } = log;
  let state = createMatch(header.seed, header.config);
  while (state.tick < untilTick && state.result === null) {
    state = step(state, ticks.get(state.tick) ?? [], undefined, undefined, undefined, terminalAt(log, state.tick), houseActive.has(state.tick)).state;
    onTick?.(state);
  }
  return state;
}

/** FNV-1a over the canonical JSON of the state, two lanes, as 16 hex digits. */
export function stateHash(state: SimState): string {
  const text = JSON.stringify(state);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
