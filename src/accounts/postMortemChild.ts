/**
 * The post-mortem's re-run, in its own process (postMortemJobs.ts forks it with a capped heap and an environment of
 * ANTWAR_POST_MORTEM_CHILD alone): the game version it was proven against over IPC, the public record's bytes on stdin,
 * one answer out. It scans the record itself ("rerun" mode) and re-plays the match from it alone, as
 * test/replays/history.test.ts rebuild does. Findings come only from a re-run that reproduces its record: every call's
 * acceptance and error code, every 100-tick block of stored events, and the whole stored result (less its rating changes).
 *
 * An accepted command has no effect when stepping its tick without it leaves the whole state the same, ignoring only its
 * own seat's lastCommandTick and lastCallTick (Coordinator rulings: at most restarting this seat's own timers). Where the
 * record's house-idle clock puts the seat at its deadline on that tick, whether the command kept the seat from going idle
 * turns on the seat's same-tick observes, classified from the record's reply lines; one the record cannot settle is not
 * listed but counted for its seat. Imports only the simulation, the spectator recorder and the record scan.
 */
import { createHash, type Hash } from "node:crypto";
import { SpectatorRecorder } from "../live/model.js";
import { createMatch } from "../sim/map.js";
import { step, type ServerTerminal } from "../sim/step.js";
import type { SimConfig } from "../sim/config.js";
import type { SimInput, SimState } from "../sim/types.js";
import {
  BLOCK_TICKS, canonicalJson, comparableEvent, LINE_ARGS_KNOWN, LINE_CELLS_CURSOR, LINE_SINCE, LINE_STUB, RecordReadError, scanRecord,
  type CallFact, type ReducedRecord, type ReplyLines,
} from "./postMortemRecord.js";

export interface NoEffect {
  readonly seat: number;
  /** The command's index among its seat's commands. */
  readonly index: number;
  readonly tick: number;
  readonly type: string;
}
export type ChildMessage =
  /** Still working: the re-run's tick, or null while the record is being scanned. */
  | { readonly kind: "progress"; readonly tick: number | null }
  /** undecided: [seat, accepted commands the record cannot settle], seats with none left out. */
  | { readonly kind: "done"; readonly tested: number; readonly findings: NoEffect[]; readonly undecided: [number, number][] }
  | { readonly kind: "mismatch"; readonly tick: number | null }
  | { readonly kind: "no_rerun_data" }
  | { readonly kind: "no_idle_data" }
  /** The record on stdin is not of the game version proven for it. */
  | { readonly kind: "changed" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "threw"; readonly message: string };
export interface ChildRequest { readonly version: string }

/** Commands that are never tested: they read, or seat, and change nothing a player directs. */
const UNTESTED = new Set(["observe", "join", "rejoin"]);
const PROGRESS_TICKS = 100;
/** Reply codes of calls that reach no simulation step (src/mcp/game.ts answer, the MCP SDK). */
const NO_SIM_CALL = new Set(["call_rate", "sdk_error", "not_joined", "unknown_agent", "match_not_played"]);
/** Observe codes that settle the call as not counting: eligibility off before any argument is read, or a cursor proven invalid. */
const NOT_COUNTING = new Set(["bad_arguments", "bad_event_cursor", "bad_cells_cursor"]);
/** Observe codes of a call that passed eligibility as its arguments allow. */
const COUNTING_IF_PLAIN = new Set(["", "observe_reply_too_large"]);

/** Key-order-insensitive equality of two plain states, ignoring only the agent `skipAgent`'s lastCallTick and lastCommandTick. */
export function sameState(a: unknown, b: unknown, skipAgent: string): boolean {
  const equal = (x: unknown, y: unknown, agent: boolean): boolean => {
    if (Object.is(x, y)) return true;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (!equal(x[i], y[i], false)) return false;
      return true;
    }
    if (ArrayBuffer.isView(x) || ArrayBuffer.isView(y)) throw new Error("unsupported state value");
    const px = Object.getPrototypeOf(x), py = Object.getPrototypeOf(y);
    if ((px !== Object.prototype && px !== null) || (py !== Object.prototype && py !== null)) throw new Error("unsupported state value");
    const ox = x as Record<string, unknown>, oy = y as Record<string, unknown>;
    const isSkipped = agent && ox.id === skipAgent;
    const keys = (o: Record<string, unknown>) => Object.keys(o).filter(k => o[k] !== undefined &&
      !(isSkipped && (k === "lastCallTick" || k === "lastCommandTick")));
    const kx = keys(ox), ky = keys(oy);
    if (kx.length !== ky.length) return false;
    for (const k of kx) {
      if (!Object.hasOwn(oy, k) || oy[k] === undefined) return false;
      if (!equal(ox[k], oy[k], false)) return false;
    }
    return true;
  };
  // `agents` is an array: its elements are the agent objects whose timers may be skipped.
  const top = (x: unknown, y: unknown): boolean => {
    if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return Object.is(x, y);
    const ox = x as Record<string, unknown>, oy = y as Record<string, unknown>;
    const kx = Object.keys(ox).filter(k => ox[k] !== undefined);
    const ky = Object.keys(oy).filter(k => oy[k] !== undefined);
    if (kx.length !== ky.length) return false;
    for (const k of kx) {
      if (!Object.hasOwn(oy, k) || oy[k] === undefined) return false;
      if (k === "agents") {
        const ax = ox[k], ay = oy[k];
        if (!Array.isArray(ax) || !Array.isArray(ay) || ax.length !== ay.length) return false;
        for (let i = 0; i < ax.length; i++) if (!equal(ax[i], ay[i], true)) return false;
      } else if (!equal(ox[k], oy[k], false)) return false;
    }
    return true;
  };
  return top(a, b);
}

/** How one same-tick observe line bears on its seat's activity. */
export type LineActivity = "activity" | "non_activity" | "undecidable";

/** One observe or rules line backed by an accepted simulation observe, classified by its tool, code and argument flags. */
export function classifyObserveLine(tool: string, code: string | null, flags: number): LineActivity {
  const c = code ?? "";
  if (tool === "rules") return c === "" ? "activity" : "undecidable";
  if (NOT_COUNTING.has(c)) return "non_activity";
  if (COUNTING_IF_PLAIN.has(c)) {
    if ((flags & LINE_ARGS_KNOWN) === 0) return "undecidable";
    return (flags & (LINE_SINCE | LINE_CELLS_CURSOR)) !== 0 ? "undecidable" : "activity";
  }
  return "undecidable";
}

/**
 * Whether seat `seat` was active on its deadline tick `tick` without the judged command: "active" (judge the command
 * normally), "idle" (the command kept the seat from going idle: an effect) or "undecidable". `calls` are the seat's call
 * events on the tick; its reply lines are those answered at tick + 1.
 */
function seatActivity(lines: ReplyLines | null, byLine: Map<string, number[]>, omittedSpans: Map<number, [number, number][]>,
  seat: number, tick: number, calls: readonly CallFact[]): "active" | "idle" | "undecidable" {
  const observes = calls.filter(c => c.call === "observe");
  if (observes.some(c => !c.accepted)) return "undecidable";
  if (observes.length === 0) return "idle";
  if (lines === null) return "undecidable";
  const at = tick + 1;
  if ((omittedSpans.get(seat) ?? []).some(([from, to]) => from <= at && at <= to)) return "undecidable";
  const indices = byLine.get(`${seat}:${at}`) ?? [];
  const backed: LineActivity[] = [];
  const otherTools = new Map<string, number[]>();
  for (const i of indices) {
    const tool = lines.string(lines.tool.at(i)), codeId = lines.code.at(i), code = codeId === 0 ? null : lines.string(codeId);
    if (code !== null && NO_SIM_CALL.has(code)) continue;
    if (tool === "observe" || tool === "rules") backed.push(classifyObserveLine(tool, code, lines.flags.at(i)));
    else { const list = otherTools.get(tool); if (list) list.push(i); else otherTools.set(tool, [i]); }
  }
  // Another tool's lines beyond its own simulation calls are adapter refusals, each an observe that does not count.
  for (const [tool, list] of otherTools) {
    const extra = list.length - calls.filter(c => c.call === tool).length;
    if (extra < 0) return "undecidable";
    if (list.filter(i => lines.code.at(i) !== 0).length < extra) return "undecidable";
    for (let n = 0; n < extra; n++) backed.push("non_activity");
  }
  if (backed.length !== observes.length) return "undecidable";
  if (backed.includes("activity")) return "active";
  return backed.every(b => b === "non_activity") ? "idle" : "undecidable";
}

/** Re-runs the record; returns its answer. `progress` is told each PROGRESS_TICKS ticks. */
export function rerunRecord(record: ReducedRecord, progress: (tick: number) => void = () => {}): ChildMessage {
  const rerun = record.rerun;
  if (rerun === null || record.result === null) return { kind: "no_rerun_data" };
  const idleTicks = record.houseIdleTicks;
  if (idleTicks === null || record.calls.some(call => call.activity === null)) return { kind: "no_idle_data" };
  const callsAt = new Map<number, CallFact[]>();
  for (const call of record.calls) {
    const list = callsAt.get(call.tick);
    if (list) list.push(call); else callsAt.set(call.tick, [call]);
  }
  const seats = new Map(record.seats.map(seat => [seat.seat, seat]));
  const lines = record.lines;
  const byLine = new Map<string, number[]>();
  const omittedSpans = new Map<number, [number, number][]>();
  if (lines !== null) {
    const lastStub = new Map<number, number>();
    for (let i = 0; i < lines.length; i++) {
      const seat = lines.seat.at(i), tick = lines.tick.at(i);
      const key = `${seat}:${tick}`;
      const list = byLine.get(key);
      if (list) list.push(i); else byLine.set(key, [i]);
      if ((lines.flags.at(i) & LINE_STUB) === 0) continue;
      // A stub's omitted calls were left out since the seat's previous stub: any tick between the two may hold one.
      if (lines.omitted.at(i) > 0) {
        const spans = omittedSpans.get(seat) ?? [];
        spans.push([lastStub.get(seat) ?? -1, tick]);
        omittedSpans.set(seat, spans);
      }
      lastStub.set(seat, tick);
    }
  }
  const stored = new Map(record.blocks.map(([index, count, hash]) => [index, `${count}:${hash}`]));
  const compared = new Set<number>();
  const activity = new Map<number, number>();
  const next = new Map<number, number>();
  const within = (tick: number) => rerun.houseActive.some(([first, last]) => first <= tick && tick <= last);
  let state: SimState = createMatch(rerun.seed, record.config as SimConfig);
  const recorder = new SpectatorRecorder(state);
  let block = 0, count = 0, hash: Hash = createHash("sha256");
  const closeBlock = (): boolean => {
    compared.add(block);
    const mine = count === 0 ? undefined : `${count}:${hash.digest("hex")}`;
    hash = createHash("sha256"); count = 0;
    return stored.get(block) === mine;
  };
  const findings: NoEffect[] = [];
  const undecided = new Map<number, number>();
  let tested = 0;
  while (state.result === null) {
    const tick = state.tick;
    if (Math.floor(tick / BLOCK_TICKS) !== block) {
      if (!closeBlock()) return { kind: "mismatch", tick };
      block = Math.floor(tick / BLOCK_TICKS);
    }
    const facts = callsAt.get(tick) ?? [];
    const calls = facts.map(({ seat }) => {
      const index = next.get(seat) ?? 0;
      next.set(seat, index + 1);
      return { seat, index, command: seats.get(seat)?.commands[index] };
    });
    if (calls.some(call => call.command === undefined || call.command.tick !== tick || call.command.request === null)) return { kind: "mismatch", tick };
    const inputs = calls.map(({ seat, command }) => ({ ...command!.request, agentId: `seat-${seat}` }) as SimInput);
    const idle = rerun.idle.find(entry => entry.tick === tick);
    const abandoned = rerun.abandonments.includes(tick), stopped = rerun.stops.includes(tick);
    const terminal = (idle !== undefined ? { idle: idle.colonies } : abandoned ? "abandoned" : stopped) as ServerTerminal;
    const house = within(tick);
    const out = step(state, inputs, undefined, undefined, undefined, terminal, house);
    for (const [i, result] of out.results.entries()) {
      const command = calls[i]!.command!;
      if (result.ok !== command.accepted || (!result.ok && result.error.code !== command.errorCode)) return { kind: "mismatch", tick };
    }
    for (const [i, { seat, index, command }] of calls.entries()) {
      if (!command!.accepted || UNTESTED.has(command!.type)) continue;
      tested++;
      let without = terminal;
      // The server's idle clock (src/mcp/game.ts advanceMatch): a seat is idle once its last counted call is idleTicks old.
      const atDeadline = !stopped && tick - (activity.get(seat) ?? seats.get(seat)?.joinedTick ?? 0) >= idleTicks
        && facts.filter(f => f.seat === seat && f.accepted && f.call !== "observe").length === 1;
      if (atDeadline) {
        const verdict = seatActivity(lines, byLine, omittedSpans, seat, tick, facts.filter(f => f.seat === seat));
        if (verdict === "undecidable") { undecided.set(seat, (undecided.get(seat) ?? 0) + 1); continue; }
        if (verdict === "idle") {
          const colony = seats.get(seat)!.colony;
          without = (abandoned || record.modelIndex ? "abandoned" : { idle: [...new Set([...(idle?.colonies ?? []), colony])].sort((a, b) => a - b) }) as ServerTerminal;
        }
      }
      const alt = step(state, inputs.filter((_, j) => j !== i), undefined, undefined, undefined, without, house);
      if (sameState(out.state, alt.state, `seat-${seat}`)) findings.push({ seat, index, tick, type: command!.type });
    }
    for (const event of recorder.record(out).events) {
      if (event.kind === "food" || event.kind === "territory" || event.kind === "store") continue;
      hash.update(comparableEvent(tick, event as unknown as Record<string, unknown>) + "\n");
      count++;
    }
    for (const fact of facts) activity.set(fact.seat, fact.activity!);
    state = out.state;
    if (tick % PROGRESS_TICKS === 0) progress(tick);
  }
  if (!closeBlock() || [...stored.keys()].some(index => !compared.has(index))) return { kind: "mismatch", tick: state.tick };
  for (const [seat, seatRecord] of seats) if ((next.get(seat) ?? 0) !== seatRecord.commands.length) return { kind: "mismatch", tick: state.tick };
  const { nextStartMs: _next, ...result } = state.result as unknown as Record<string, unknown>;
  if (canonicalJson(result) !== canonicalJson(record.result)) return { kind: "mismatch", tick: state.tick };
  return { kind: "done", tested, findings, undecided: [...undecided].sort(([a], [b]) => a - b) };
}

// Forked by postMortemJobs.ts: one request, the record on stdin, one answer, then exit (also when the parent goes away).
if (process.send !== undefined && process.env.ANTWAR_POST_MORTEM_CHILD === "1") {
  process.once("disconnect", () => process.exit(0));
  process.once("message", (request: ChildRequest) => {
    void (async (): Promise<ChildMessage> => {
      try {
        const scan = await scanRecord(process.stdin, undefined, "rerun", () => process.send!({ kind: "progress", tick: null } satisfies ChildMessage));
        if (scan.reduced.codeVersion !== request.version) return { kind: "changed" };
        return rerunRecord(scan.reduced, tick => process.send!({ kind: "progress", tick } satisfies ChildMessage));
      } catch (error) {
        if (error instanceof RecordReadError) return { kind: "unreadable" };
        return { kind: "threw", message: error instanceof Error ? error.message.slice(0, 200) : "non-error thrown" };
      }
    })().then(answer => process.send!(answer, () => process.exit(0)));
  });
}
