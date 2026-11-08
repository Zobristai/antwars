import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SUB } from "../../src/sim/config.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimInput, SimState } from "../../src/sim/types.js";
import { HISTORICAL_CONFIG as HISTORICAL_TEMPLATE, squadOf } from "./fixtures.js";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: order and mark tiles below are fine tiles (reference tiles doubled).
const HISTORICAL_CONFIG = playable(HISTORICAL_TEMPLATE);
const SEED = 11;
const SAMPLE_EVERY = 500;

it("replays an additive operator-stop tick without changing the config, rules version or natural outcomes", () => {
  const config = { ...HISTORICAL_CONFIG, matchTicks: 10, startAnts: 8 };
  const original = createMatch(SEED, config);
  const inputs: SimInput[] = [{ type: "join", agentId: "queued" }];
  const natural = step(original, inputs);
  expect(natural.state.result).toBeNull();
  expect(stateHash(step(original, inputs, undefined, undefined, undefined, false).state)).toBe(stateHash(natural.state));
  const stopped = step(original, inputs, undefined, undefined, undefined, true);
  expect(original.result).toBeNull();
  expect(stopped.state.result).toMatchObject({ reason: "time_up", tick: 0 });
  expect(stopped.state.config).toEqual(config);
  expect(stopped.results[0]!.view!.result).toEqual(stopped.state.result);
  expect(stopped.events.filter(e => e.type === "match_end")).toHaveLength(1);
  const lines = [headerLine(SEED, config), tickLine(0, inputs, true)];
  expect(JSON.parse(lines[0]!).rulesVersion).toBe(JSON.parse(headerLine(SEED, original.config)).rulesVersion);
  expect(parseLog(lines).stops).toEqual(new Set([0]));
  expect(stateHash(replay(lines, Infinity))).toBe(stateHash(stopped.state));
  const oldLines = [headerLine(SEED, config), tickLine(0, inputs)];
  expect(parseLog(oldLines).stops.size).toBe(0);
  expect(JSON.parse(oldLines[1]!)).not.toHaveProperty("stop");
  expect(stateHash(replay(oldLines, 1))).toBe(stateHash(natural.state));
  const final = createMatch(SEED, { ...config, matchTicks: 1 });
  expect(step(final, [], undefined, undefined, undefined, true)).toEqual(step(final));
});

function onAnt(state: SimState, agentId: string): { tileX: number; tileY: number } {
  const ant = squadOf(state, agentId)[0];
  return ant === undefined ? { tileX: 0, tileY: 0 } : { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

/** A scripted session: joins with labels, calls, orders carrying marks and intents, marks, an idle lapse and a rejoin. */
function inputsFor(state: SimState): SimInput[] {
  switch (state.tick) {
    case 0:
      return [
        { type: "join", agentId: "a", modelLabel: "model-a" },
        { type: "join", agentId: "b", modelLabel: "model-b" },
        { type: "join", agentId: "c", colony: 0 },
      ];
    case 30:
      return [
        {
          type: "order",
          agentId: "a",
          order: { kind: "go_to", tileX: 60, tileY: 40 },
          mark: { ...onAnt(state, "a"), words: ["GO", "E"] },
          intent: "push to the centre",
        },
        { type: "observe", agentId: "b" },
      ];
    case 60:
      return [
        { type: "order", agentId: "a", order: { kind: "forage" } },
        { type: "mark", agentId: "b", ...onAnt(state, "b"), words: ["FOOD", "MANY"] },
      ];
    case 400:
      return [{ type: "order", agentId: "b", order: { kind: "attack", tileX: 40, tileY: 48 }, intent: "hit their flank" }];
    case 700:
      return [{ type: "mark", agentId: "a", ...onAnt(state, "a"), words: ["HELP"] }, { type: "observe", agentId: "c" }];
    case 1500:
      return [{ type: "rejoin", agentId: "b" }, { type: "join", agentId: "d", modelLabel: "model-d" }];
    default:
      return state.tick % 400 === 100 ? [{ type: "observe", agentId: "a" }] : [];
  }
}

describe("replay from the JSONL log", () => {
  it("re-simulates to equal state hashes at sampled ticks and at the end", () => {
    // Keep this long scenario on its original economy; colonyScale covers the new public config.
    let state = createMatch(SEED, HISTORICAL_CONFIG);
    const lines = [headerLine(SEED, HISTORICAL_CONFIG)];
    const sampled = new Map<number, string>();
    let lapsed = false;
    let rejected = 0;
    while (state.result === null) {
      const inputs = inputsFor(state);
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      const out = step(state, inputs);
      rejected += out.results.filter((r) => !r.ok).length;
      if (out.events.some((e) => e.type === "squad_released")) lapsed = true;
      state = out.state;
      if (state.tick % SAMPLE_EVERY === 0) sampled.set(state.tick, stateHash(state));
    }
    // The script covers what the log must replay.
    expect(lapsed).toBe(true);
    expect(rejected).toBeGreaterThan(0);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);

    const replayed = new Map<number, string>();
    const end = replay(lines, HISTORICAL_CONFIG.matchTicks, (s) => {
      if (s.tick % SAMPLE_EVERY === 0) replayed.set(s.tick, stateHash(s));
    });
    expect(replayed).toEqual(sampled);
    expect(stateHash(end)).toBe(stateHash(state));
    expect(end.result).toEqual(state.result);
  }, 60_000);
});

it.each([undefined, "kills-first"] as const)("replays the recorded scoring config %s without applying live defaults", adjudication => {
  const config = playable({ ...DEFAULT_CONFIG, matchTicks: 3, ...(adjudication === undefined ? {} : { adjudication }) });
  let state = createMatch(6006, config);
  while (state.result === null) state = step(state).state;
  const lines = [headerLine(6006, config)];
  expect(parseLog(lines).header.config.adjudication).toBe(adjudication);
  expect(stateHash(replay(lines, Infinity))).toBe(stateHash(state));
});
