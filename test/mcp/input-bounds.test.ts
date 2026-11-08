import { afterEach, describe, expect, it } from "vitest";
import { clampIntent, clampWords } from "../../src/mcp/tools.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { WORDS, type SimInput, type SimState } from "../../src/sim/types.js";
import { TEST_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function joined(harness: Harness): Promise<{ agent: TestAgent; agentId: string }> {
  const agent = await harness.connect();
  const r = await agent.call("join");
  expect(r.isError, r.text).toBe(false);
  return { agent, agentId: r.data.agentId };
}

/**
 * Every logged agent input must serialize to at most this many bytes. A tick line
 * holds every input of its tick, so it grows with the agents calling in that tick.
 */
const MAX_INPUT_BYTES = 1024;

const inputBytes = (input: SimInput): number => Buffer.byteLength(JSON.stringify(input), "utf8");

const max = TEST_CONFIG.intentMaxChars;
const longestWord = Math.max(...WORDS.map((w) => [...w].length));

const intents: string[] = [
  "y".repeat(max),
  "x".repeat(max + 1),
  "x".repeat(max + 2),
  "x".repeat(200_000),
  // Astral characters: one code point each, two UTF-16 units, as the sim counts them.
  "😀".repeat(max),
  "😀".repeat(max + 1),
  "😀".repeat(5_000),
];
const wordLists: string[][] = [
  ["FOOD"],
  ["GATHER", "ATTACK", "QUEEN"].slice(0, TEST_CONFIG.markMaxWords),
  [],
  ["FOOD", "HELP", "GO", "N"].slice(0, TEST_CONFIG.markMaxWords + 1),
  Array.from({ length: 10_000 }, () => "FOOD"),
  [""],
  ["FOOD", ""],
  ["food"],
  ["FOOD", "NOT_A_WORD"],
  ["GATHERS"],
  ["GATHERX".repeat(30_000)],
  ["X".repeat(200_000), "FOOD"],
];

/** A match at tick 1 with agent "a" joined. */
function joinedState(): SimState {
  return step(createMatch(1, playable(TEST_CONFIG)), [{ type: "join", agentId: "a" }]).state;
}

function outcome(state: SimState, input: SimInput): unknown {
  const out = step(state, [input]);
  const result = out.results[0]!;
  const agent = out.state.agents.find((a) => a.id === "a")!;
  return {
    ok: result.ok,
    error: result.ok ? null : result.error,
    lastCallTick: agent.lastCallTick,
    lastCommandTick: agent.lastCommandTick,
    idle: agent.idle,
  };
}

describe("the adapter clamps agent text before the sim and the log", () => {
  it("the clamp cuts to one unit over each limit and leaves text within the limits unchanged", () => {
    expect([...clampIntent(TEST_CONFIG, "😀".repeat(5_000))].length).toBe(max + 1);
    expect(clampIntent(TEST_CONFIG, "x".repeat(max + 1))).toBe("x".repeat(max + 1));
    expect(clampIntent(TEST_CONFIG, "y".repeat(max))).toBe("y".repeat(max));
    const cut = clampWords(TEST_CONFIG, Array.from({ length: 50 }, () => "X".repeat(1_000)));
    expect(cut.length).toBe(TEST_CONFIG.markMaxWords + 1);
    for (const w of cut) expect([...w].length).toBe(longestWord + 1);
    for (const words of [["FOOD"], ["GATHER", "ATTACK", "QUEEN"], [], [""]]) expect(clampWords(TEST_CONFIG, words)).toEqual(words);
  });

  it("the sim's results and the squad timer are the same with and without the clamp", () => {
    const state = joinedState();
    const order = (intent: string | undefined, words: string[] | undefined): SimInput => ({
      type: "order",
      agentId: "a",
      order: { kind: "hold" },
      ...(words === undefined ? {} : { mark: { tileX: 1, tileY: 1, words } }),
      ...(intent === undefined ? {} : { intent }),
    });
    const cases: [SimInput, SimInput][] = [];
    for (const intent of intents) {
      cases.push([order(intent, undefined), order(clampIntent(TEST_CONFIG, intent), undefined)]);
      cases.push([order(intent, ["food"]), order(clampIntent(TEST_CONFIG, intent), clampWords(TEST_CONFIG, ["food"]))]);
    }
    for (const words of wordLists) {
      cases.push([order(undefined, words), order(undefined, clampWords(TEST_CONFIG, words))]);
      cases.push([
        { type: "mark", agentId: "a", tileX: 1, tileY: 1, words },
        { type: "mark", agentId: "a", tileX: 1, tileY: 1, words: clampWords(TEST_CONFIG, words) },
      ]);
    }
    const codes = new Set<string>();
    for (const [raw, clamped] of cases) {
      const before = outcome(state, raw);
      expect(outcome(state, clamped)).toEqual(before);
      codes.add((before as { error: { code: string } | null }).error?.code ?? "ok");
    }
    // The cases reach every outcome the clamp could change.
    expect(codes).toEqual(new Set(["ok", "intent_too_long", "bad_mark_words", "no_own_ant_on_tile"]));
  });

  it("an over-long intent or invalid words reach the sim: same fix-it error, clamped log input, squad timer kept", async () => {
    h = await startHarness();
    const { agent, agentId } = await joined(h);
    const own = () => h!.game.match!.state.agents.find((a) => a.id === agentId)!;
    const intentFix = new RegExp(`at most ${max} characters`);
    const wordsFix = new RegExp(`1 to ${TEST_CONFIG.markMaxWords} words`);

    const refused = async (name: string, args: Record<string, unknown>, code: string, fix: RegExp): Promise<SimInput> => {
      h!.advance(5);
      const tickBefore = h!.game.match!.state.tick;
      const r = await agent.call(name, args);
      expect(r.isError, r.text).toBe(true);
      expect(r.data.error.code).toBe(code);
      expect(r.data.error.howToFix).toMatch(fix);
      // An agent call: it keeps the squad timer.
      expect(own().lastCallTick).toBeGreaterThanOrEqual(tickBefore);
      return h!.inputsOf(agentId).at(-1)!;
    };

    const huge = "x".repeat(200_000);
    const logged = await refused("order", { kind: "hold", intent: huge, mark: { tileX: 1, tileY: 1, words: ["food"] } }, "intent_too_long", intentFix);
    expect(logged).toMatchObject({ type: "order", intent: "x".repeat(max + 1) });

    const manyLong = Array.from({ length: 1_000 }, () => "X".repeat(1_000));
    const orderWords = await refused("order", { kind: "forage", mark: { tileX: 1, tileY: 1, words: manyLong } }, "bad_mark_words", wordsFix);
    expect(orderWords).toMatchObject({ type: "order", mark: { words: clampWords(TEST_CONFIG, manyLong) } });
    const markWords = await refused("mark", { tileX: 1, tileY: 1, words: manyLong }, "bad_mark_words", wordsFix);
    expect(markWords).toMatchObject({ type: "mark", words: clampWords(TEST_CONFIG, manyLong) });
  });

  it("every logged input, admitted or clamped, stays within the fixed size", async () => {
    h = await startHarness();
    const { agent, agentId } = await joined(h);
    // Worst cases: each intent and word character escapes to six bytes, and the longest JSON numbers.
    const extreme = -Number.MAX_VALUE;
    const calls: Record<string, unknown>[] = [
      { kind: "attack", tileX: extreme, tileY: extreme, mark: { tileX: extreme, tileY: extreme, words: ["GATHER", "ATTACK", "QUEEN"] }, intent: "\u0001".repeat(max) },
      {
        kind: "attack",
        tileX: extreme,
        tileY: extreme,
        mark: { tileX: extreme, tileY: extreme, words: Array.from({ length: 100 }, () => "\u0001".repeat(100)) },
        intent: "\u0001".repeat(10_000),
      },
      { kind: "attack", tileX: extreme, tileY: extreme, mark: { tileX: extreme, tileY: extreme, words: ["\uD800".repeat(100)] }, intent: "\uD800".repeat(10_000) },
    ];
    for (const args of calls) {
      const logged = h.inputsOf(agentId).length;
      await agent.call("order", args);
      const written = h.inputsOf(agentId).slice(logged);
      expect(written.map((input) => input.type)).toEqual(["order"]);
      expect(inputBytes(written[0]!)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
    }
  });

  it("a tick line shared by several agents carries each agent's clamped input unchanged", async () => {
    h = await startHarness();
    const a = await joined(h);
    const b = await joined(h);
    // Hold the tick until both calls are queued, so their inputs share one tick line.
    const game = h.game;
    const tick = game.tick.bind(game);
    game.tick = () => {
      if (game.pendingInputs < 2) return null;
      game.tick = tick;
      return tick();
    };
    const intent = "\u0001".repeat(10_000);
    const words = Array.from({ length: 100 }, () => "\u0001".repeat(100));
    const args = { kind: "hold", mark: { tileX: 1, tileY: 1, words }, intent };
    const lines = h.log.length;
    const results = await Promise.all([a.agent.call("order", args), b.agent.call("order", args)]);
    for (const r of results) expect(r.data.error.code).toBe("intent_too_long");

    const written = h.log.slice(lines).filter((line) => line.includes('"type":"order"'));
    expect(written.length).toBe(1);
    const inputs = (JSON.parse(written[0]!) as { inputs: SimInput[] }).inputs;
    const clamped = (agentId: string): SimInput => ({
      type: "order",
      agentId,
      order: { kind: "hold" },
      mark: { tileX: 1, tileY: 1, words: clampWords(TEST_CONFIG, words) },
      intent: clampIntent(TEST_CONFIG, intent),
    });
    // The two requests may arrive in either order.
    expect(inputs).toHaveLength(2);
    expect(inputs).toEqual(expect.arrayContaining([clamped(a.agentId), clamped(b.agentId)]));
    for (const input of inputs) expect(inputBytes(input)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
  });

  it("an intent at the limit and valid words are admitted to the sim", async () => {
    h = await startHarness();
    const { agent } = await joined(h);
    const r = await agent.call("order", { kind: "hold", intent: "y".repeat(max) });
    expect(r.isError, r.text).toBe(false);
  });
});
