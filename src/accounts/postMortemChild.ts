/**
 * The post-mortem's re-run, in its own process (postMortemJobs.ts forks it with a capped heap): one reduced record in
 * over IPC, one answer out. It re-plays the match from the record alone, as test/replays/history.test.ts rebuild does,
 * and stops at the first call whose acceptance or error code, or at a result, that differs from the record: findings
 * come only from a re-run that reproduces its record. An accepted command has no effect when stepping its tick without
 * it leaves the whole state the same, ignoring every agent's pending events and the caller's own call bookkeeping.
 * Imports only the simulation.
 */
import { createMatch } from "../sim/map.js";
import { step, type ServerTerminal } from "../sim/step.js";
import type { SimConfig } from "../sim/config.js";
import type { SimInput, SimState } from "../sim/types.js";
import type { ReducedRecord } from "./postMortemRecord.js";

export interface NoEffect {
  readonly seat: number;
  /** The command's index among its seat's commands. */
  readonly index: number;
  readonly tick: number;
  readonly type: string;
}
export type ChildMessage =
  | { readonly kind: "progress"; readonly tick: number }
  | { readonly kind: "done"; readonly tested: number; readonly findings: NoEffect[] }
  | { readonly kind: "mismatch"; readonly tick: number | null }
  | { readonly kind: "threw"; readonly message: string };

/** Commands that are never tested: they read, or seat, and change nothing a player directs. */
const UNTESTED = new Set(["observe", "join", "rejoin"]);
const PROGRESS_TICKS = 100;

/** Key-order-insensitive equality of two plain states, ignoring pendingEvents and, on the agent `skip`, its call bookkeeping. */
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
    const keys = (o: Record<string, unknown>) => Object.keys(o).filter(k => o[k] !== undefined && k !== "pendingEvents" &&
      !(isSkipped && (k === "lastCallTick" || k === "lastCommandTick")));
    const kx = keys(ox), ky = keys(oy);
    if (kx.length !== ky.length) return false;
    for (const k of kx) {
      if (!Object.hasOwn(oy, k) || oy[k] === undefined) return false;
      if (!equal(ox[k], oy[k], false)) return false;
    }
    return true;
  };
  // `agents` is an array: its elements are the agent objects whose bookkeeping may be skipped.
  const top = (x: unknown, y: unknown): boolean => {
    if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return Object.is(x, y);
    const ox = x as Record<string, unknown>, oy = y as Record<string, unknown>;
    const kx = Object.keys(ox).filter(k => ox[k] !== undefined && k !== "pendingEvents");
    const ky = Object.keys(oy).filter(k => oy[k] !== undefined && k !== "pendingEvents");
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

/** Re-runs the record; returns its answer. `progress` is told each PROGRESS_TICKS ticks. */
export function rerunRecord(record: ReducedRecord, progress: (tick: number) => void = () => {}): ChildMessage {
  const rerun = record.rerun;
  if (rerun === null || record.result === null) return { kind: "mismatch", tick: null };
  const order = new Map<number, number[]>();
  for (const [tick, seat] of record.calls) {
    const list = order.get(tick);
    if (list) list.push(seat); else order.set(tick, [seat]);
  }
  const seats = new Map(record.seats.map(seat => [seat.seat, seat]));
  const next = new Map<number, number>();
  const within = (tick: number) => rerun.houseActive.some(([first, last]) => first <= tick && tick <= last);
  let state: SimState = createMatch(rerun.seed, record.config as SimConfig);
  const findings: NoEffect[] = [];
  let tested = 0;
  while (state.result === null) {
    const tick = state.tick;
    const calls = (order.get(tick) ?? []).map(seat => {
      const index = next.get(seat) ?? 0;
      next.set(seat, index + 1);
      const command = seats.get(seat)?.commands[index];
      return { seat, index, command };
    });
    if (calls.some(call => call.command === undefined || call.command.tick !== tick || call.command.request === null)) return { kind: "mismatch", tick };
    const inputs = calls.map(({ seat, command }) => ({ ...command!.request, agentId: `seat-${seat}` }) as SimInput);
    const idle = rerun.idle.find(entry => entry.tick === tick);
    const terminal = (idle !== undefined ? { idle: idle.colonies } : rerun.abandonments.includes(tick) ? "abandoned" : rerun.stops.includes(tick)) as ServerTerminal;
    const house = within(tick);
    const out = step(state, inputs, undefined, undefined, undefined, terminal, house);
    for (const [i, result] of out.results.entries()) {
      const command = calls[i]!.command!;
      if (result.ok !== command.accepted || (!result.ok && result.error.code !== command.errorCode)) return { kind: "mismatch", tick };
    }
    for (const [i, { seat, index, command }] of calls.entries()) {
      if (!command!.accepted || UNTESTED.has(command!.type)) continue;
      tested++;
      const without = step(state, inputs.filter((_, j) => j !== i), undefined, undefined, undefined, terminal, house);
      if (sameState(out.state, without.state, `seat-${seat}`)) findings.push({ seat, index, tick, type: command!.type });
    }
    state = out.state;
    if (tick % PROGRESS_TICKS === 0) progress(tick);
  }
  for (const [seat, seatRecord] of seats) if ((next.get(seat) ?? 0) !== seatRecord.commands.length) return { kind: "mismatch", tick: state.tick };
  const result = state.result as { winner: unknown; reason: unknown };
  if (JSON.stringify(result.winner) !== JSON.stringify(record.result.winner) || result.reason !== record.result.reason) return { kind: "mismatch", tick: state.tick };
  return { kind: "done", tested, findings };
}

// Forked by postMortemJobs.ts: one record, one answer, then exit (also when the parent goes away).
if (process.send !== undefined && process.env.ANTWAR_POST_MORTEM_CHILD === "1") {
  process.once("disconnect", () => process.exit(0));
  process.once("message", (record: ReducedRecord) => {
    let answer: ChildMessage;
    try {
      answer = rerunRecord(record, tick => process.send!({ kind: "progress", tick } satisfies ChildMessage));
    } catch (error) {
      answer = { kind: "threw", message: error instanceof Error ? error.message.slice(0, 200) : "non-error thrown" };
    }
    process.send!(answer, () => process.exit(0));
  });
}
