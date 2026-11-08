/// <reference types="node" />
/**
 * Recorded matches for the stream's tests, the client's offline harnesses and
 * capture.
 *
 * - playScripted runs a match on the real sim with scripted agents that join,
 *   observe, and order at the rules' rate (one command per commandFloorTicks,
 *   each carrying a mark, so at most marksPerAgent live marks each), writing the
 *   JSONL match log as the server does.
 * - recordLog re-simulates a match from its JSONL log (parseLog and step, as
 *   Replay does) and encodes it with this member's encoder: a full
 *   message at tick 0, then one message per tick.
 *
 * CLI: node --import ./src/ts-resolve.mjs src/live/record.ts --size default|large
 *        [--ticks N] [--agents N] [--seed N] [--rules 3|4] [--out DIR]
 * writes DIR/<size>.jsonl and DIR/<size>.bin (messages packed as in snapshot.ts).
 * --rules 4 plays with the rules switch on (castes; the scripted agents leave the
 * brood unset, so each colony breeds mixed) and names the files <size>-rules4.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CASTE_RULES, DEFAULT_CONFIG, SUB, type SimConfig } from "../sim/config.js";
import { headerLine, parseLog, terminalAt, tickLine } from "../sim/log.js";
import { withGridScale } from "../sim/gridScale.js";
import { createMatch } from "../sim/map.js";
import { createRng } from "../sim/rng.js";
import { step } from "../sim/step.js";
import { WORDS, type ColonyId, type SimInput, type SimState, type StepOutput, type Word } from "../sim/types.js";
import { encodeMessage, type StreamMessage } from "./format.js";
import { SpectatorRecorder } from "./model.js";
import { packMessages } from "./snapshot.js";
import { loadReplayFile } from "./replayOptions.js";

/** The default recording config: DEFAULT_CONFIG's rules at grid scale 2, a 128x96 board. */
export const RECORD_CONFIG: SimConfig = withGridScale(DEFAULT_CONFIG);

/** About 2,000 ants on a 128x96 board, the size the budgets are measured at: the same grid-scale-2
 * board as RECORD_CONFIG (never doubled again), with more ants. */
export const LARGE_CONFIG: SimConfig = {
  ...RECORD_CONFIG,
  startAnts: 1000,
  colonyCap: 1030,
};

export interface ScriptOptions {
  readonly seed: number;
  readonly config: SimConfig;
  /** Agents joining at tick 0, split between the colonies by the sim's allocator. */
  readonly agents: number;
  /** Stop after this many ticks, or earlier when the match ends. */
  readonly ticks: number;
  /** Order attack on the enemy queen (true), or go to the centre then hold (false). */
  readonly attack?: boolean;
  /** Pad model labels and intent lines to these lengths (the MCP and sim maxima are 64 and 80). */
  readonly labelChars?: number;
  readonly intentChars?: number;
  /**
   * With labelChars and intentChars: random printable ASCII of those lengths in
   * place of padded names. ASCII is sent uncut and compresses worst, so this is
   * the largest text a stream carries.
   */
  readonly randomText?: boolean;
}

const MODELS = ["claude-opus-4.1", "gpt-5", "gemini-2.5-pro", "grok-4", "deepseek-v3.1", "qwen3-max", "kimi-k2", "llama-4-maverick"];
const MARKS: readonly (readonly Word[])[] = [
  ["ATTACK", "QUEEN"],
  ["ENEMY", "MANY", "E"],
  ["HELP"],
  ["GATHER", "NEST"],
  ["FOOD", "N", "MANY"],
  ["HOLD"],
  ["AVOID", "ENEMY"],
  ["GO", "W"],
];
const INTENTS = [
  "storm their queen while the front is thin",
  "hold the centre food until help arrives",
  "flank north and cut their supply lines",
  "draw them off the queen, then push",
  "rally at the nest and break their charge",
];

export function agentId(i: number): string {
  return `agent-${String(i).padStart(2, "0")}`;
}

function pad(s: string, n: number | undefined): string {
  return n === undefined ? s : s.padEnd(n, ".").slice(0, n);
}

/** Seeded random printable ASCII, n characters. */
function noiseText(rng: { next(): number }, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(0x21 + Math.floor(rng.next() * 94));
  return s;
}

function text(o: ScriptOptions, rng: () => { next(): number }, s: string, n: number | undefined): string {
  return o.randomText === true && n !== undefined ? noiseText(rng(), n) : pad(s, n);
}

/** The scripted agents' calls for the step about to run (state.tick). */
export function scriptedInputs(state: SimState, o: ScriptOptions): SimInput[] {
  const tick = state.tick;
  const c = state.config;
  const inputs: SimInput[] = [];
  if (tick === 0) {
    const textRng = createRng((o.seed * 7919) >>> 0);
    for (let i = 0; i < o.agents; i++) {
      inputs.push({ type: "join", agentId: agentId(i), modelLabel: text(o, () => textRng, `${MODELS[i % MODELS.length]}#${i}`, o.labelChars) });
    }
    return inputs;
  }
  const rng = createRng((o.seed * 31 + tick) >>> 0);
  for (let i = 0; i < o.agents; i++) {
    const id = agentId(i);
    const agent = state.agents.find((a) => a.id === id);
    if (agent === undefined) continue;
    if ((tick - 1 - 2 * i) % c.commandFloorTicks === 0) {
      const enemy = state.colonies[(1 - agent.colony) as ColonyId];
      const spread = Math.floor((rng.next() - 0.5) * 8);
      const target =
        o.attack !== false
          ? { kind: "attack" as const, tileX: Math.floor(enemy.queenX / SUB), tileY: clamp(Math.floor(enemy.queenY / SUB) + spread, 0, c.mapHeight - 1) }
          : { kind: "go_to" as const, tileX: Math.floor(c.mapWidth / 2), tileY: clamp(Math.floor(c.mapHeight / 2) + spread * 2, 0, c.mapHeight - 1) };
      const squad = state.ants.filter((a) => a.squad === id);
      const ant = squad.length > 0 ? squad[Math.floor(rng.next() * squad.length)]! : null;
      const words = MARKS[(i + Math.floor(tick / c.commandFloorTicks)) % MARKS.length]!;
      inputs.push({
        type: "order",
        agentId: id,
        order: target,
        intent: text(o, () => createRng((o.seed * 104_729 + tick * 64 + i) >>> 0), INTENTS[(i + tick) % INTENTS.length]!, o.intentChars),
        ...(ant === null ? {} : { mark: { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB), words } }),
      });
    } else if ((tick + 7 * i) % 60 === 0) {
      inputs.push({ type: "observe", agentId: id });
    }
  }
  return inputs;
}

/**
 * Play a scripted match on the sim. onStep sees every step's output; the
 * returned log lines are the match's JSONL log.
 */
export function playScripted(o: ScriptOptions, onStep?: (out: StepOutput, inputs: readonly SimInput[]) => void): { lines: string[]; state: SimState } {
  let state = createMatch(o.seed, o.config);
  const lines = [headerLine(o.seed, o.config)];
  while (state.tick < o.ticks && state.result === null) {
    const inputs = scriptedInputs(state, o);
    if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    onStep?.(out, inputs);
    state = out.state;
  }
  return { lines, state };
}

/**
 * Re-simulate a match from its JSONL log and encode it: a full message at the
 * starting state, then one message per tick until the match ends or untilTick.
 */
export function recordLog(lines: readonly string[], untilTick = Number.POSITIVE_INFINITY): Uint8Array[] {
  const log = parseLog(lines);
  const { header, ticks, houseActive } = log;
  let state = createMatch(header.seed, header.config);
  const recorder = new SpectatorRecorder(state);
  const first: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
  const out: Uint8Array[] = [encodeMessage(first)];
  while (state.tick < untilTick && state.result === null) {
    const result = step(state, ticks.get(state.tick) ?? [], undefined, undefined, undefined, terminalAt(log, state.tick), houseActive.has(state.tick));
    state = result.state;
    const rec = recorder.record(result);
    out.push(encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events }));
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      size: { type: "string", default: "default" },
      ticks: { type: "string" },
      agents: { type: "string" },
      seed: { type: "string", default: "6006" },
      rules: { type: "string", default: "3" },
      out: { type: "string", default: "out/recordings" },
      log: { type: "string" },
    },
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  let lines: readonly string[];
  let name: string;
  if (values.log !== undefined) {
    lines = loadReplayFile(values.log).lines;
    name = values.log.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  } else {
    const large = values.size === "large";
    if (values.rules !== "3" && values.rules !== "4") throw new Error("--rules is 3 or 4");
    const rules4 = values.rules === "4";
    const base = large ? LARGE_CONFIG : RECORD_CONFIG;
    const config = rules4 ? { ...base, castes: CASTE_RULES } : base;
    lines = playScripted({
      seed: Number(values.seed),
      config,
      agents: Number(values.agents ?? (large ? 50 : 10)),
      ticks: Number(values.ticks ?? config.matchTicks),
    }).lines;
    name = rules4 ? `${values.size!}-rules4` : values.size!;
    writeFileSync(join(out, `${name}.jsonl`), `${lines.join("\n")}\n`);
  }
  const messages = recordLog(lines);
  writeFileSync(join(out, `${name}.bin`), packMessages(messages));
  console.log(JSON.stringify({ name, log: join(out, `${name}.jsonl`), recording: join(out, `${name}.bin`), messages: messages.length }));
}
