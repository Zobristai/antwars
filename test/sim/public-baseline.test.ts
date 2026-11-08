import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_CONFIG as CURRENT_PUBLIC_CONFIG, SUB, type SimConfig } from "../../src/sim/config.js";
import { headerLine, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimInput, SimState } from "../../src/sim/types.js";
import { startHarness, type Harness } from "../mcp/harness.js";
import { HISTORICAL_PUBLIC_CONFIG as PUBLIC_CONFIG, squadOf } from "./fixtures.js";
import { playable } from "../playable.ts";

/**
 * Today's public rules, pinned before the variant existed. The values
 * were computed on main 7690c1563aa462b8bf4438b09ff008a49f11e94a (the variant
 * landed, tree 12cfd4bcbd9dd3fcebb7876a9c2d85cd9f524e31) with no other change.
 * Nothing the variant adds may move them while ANTWAR_RULES is unset.
 * The briefing value was re-derived on main c32d0be5fe22c6f1425fc31ea293a23d310b30eb
 * (after the shared command-limit line and the /rules line) with no
 * other change; the earlier 7690c15 value was
 * dbab5a30b8a3a07976232377d23a035b398681e4c8dfa9bb2231be88d63f7907.
 * Repins only MCP briefing/tool copy and schemas for the approved
 * compact-reply/rules-tool contract. Simulation, header and stream pins stay
 * byte-for-byte unchanged.
 * Repins only the configured MCP seating text in briefing and join
 * tool copy/schema; all simulation, header and stream pins remain unchanged.
 */
// Simulation/header/stream use the original explicit controls from fixtures.ts.
// MCP copy is a live contract and is pinned separately below.

// Every match plays at grid scale 2: the scripted session plays the historical controls at grid scale 2
// (reference tiles doubled). The simulation, header,
// stream and pre-frontline briefing pins are that grid-scale-2 output on this code. The reference-grid values were
// 500 625be86aab258197, 1000 bce63ebbd5049b76, 1500 ff59a248db024e83, 2000 8e6a13ceea05188f, 2500 b1da53ec1c059661,
// 3000 b1f00cbc91e1b011, end ecf115c5a524d504; briefing 00b6b2d3bdeae8c7a0fd4aae2c3e967042bebf8e2389d229f103e102ab7186d1;
// header d3e5050371b6e33796388e5c256953a5bbc4ba5e22ae6878b0a98cbf5ee09cc9; stream 5b7fd15aaa6f8c662af9db37db79734f0b3222d37b2fa67f3e14c75f04b14e65.
const PUBLIC_BASELINE = {
  sampled: {
    500: "44afce0906f304be",
    1000: "fca63caf58eb2fde",
    1500: "3abc61413e6b6cd4",
    2000: "81cf16a650962ba3",
    2500: "4c327a959f04fbf6",
    3000: "efaa6131ca41f09c",
  } as Record<number, string>,
  end: "42cf01b7c7114fec",
  briefing: "b058f8597265bfd191759bd8db6a10af7f90f05d321b86a270cf49439a100b3c",
  header: "ecd0b05a717a702fd53bbd540bf9ad9e6010fd48588a256bf63f39e80f6cebab",
  stream: "a2d648de17ecf7cf3d0c26258880e56cd0a57a33daf0256cd86b2d75943cb0d8",
  // Current live guidance only.
  // Join advertises optional self-reported thinkingLevel; no historical pins change.
  // Observe description only (countdown wording and the one idle rule at the harness limit). Previously 7d1743d8b087ee4e1d676cdd6f11b6970e94e0ed043143aab21b4819a4484e5d.
  // The public config is rules 27, so the found_queen description adds the set_brood ownership
  // and owner-only spawn-point statements and the observe seat notice drops brood_vote_lost.
  // The order tool carries no brood field, keeps unadvertised fields to refuse brood by name, and its
  // description names set_brood, queen ownership and the owner-only spawn point; no other tool changes. Previously
  // 860010dc6020e0567cd24fdc1a551e659f15d1b665432d4da33cd8d7fe9baf06.
  // The tool list also adds set_brood; no historical pin changes. Previously
  // 24e9d1bf174fb2444d8f69d3163a6629761668e17b10d4d21f233502dd2b82dd.
  // "A newly founded queen breeds mixed until her owner calls set_brood for her." joins the shared brood statement in
  // the tool descriptions; with it removed the list hashes to the previous pin. Previously
  // 815bc71ed4f084db6ceda5a2dbf923faac520ccbd1d6acac879caf43749ce23e.
  // The observe description says "index match" for the Model Index as a game (two phrases); the previous
  // wording restores efc75f66a322ed498d498f79aa0a4026fe11b9b225c4c0821274dd10ef8b0e2b, so nothing else changed.
  tools: "d5a05cecfbb6bc552b6b5f0740c303697b3556c7f6d89cda4785250921e09ecd",
};

const sha = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

const SEED = 6006;
const TICKS = 3100;
const SAMPLE_EVERY = 500;

function onAnt(state: SimState, agentId: string): { tileX: number; tileY: number } {
  const ant = squadOf(state, agentId)[0];
  return ant === undefined ? { tileX: 0, tileY: 0 } : { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

/** Joins, every order kind, a tile mark and a tile-less mark, and founding before and after it opens. */
function baselineInputs(state: SimState): SimInput[] {
  switch (state.tick) {
    case 0:
      return [
        { type: "join", agentId: "a", modelLabel: "model-a" },
        { type: "join", agentId: "b", modelLabel: "model-b" },
        { type: "join", agentId: "c", colony: 0 },
      ];
    case 30:
      return [
        { type: "order", agentId: "a", order: { kind: "go_to", tileX: 60, tileY: 40 }, mark: { ...onAnt(state, "a"), words: ["GO", "E"] }, intent: "centre" },
        { type: "observe", agentId: "b" },
      ];
    case 200:
      return [{ type: "mark", agentId: "b", words: ["FOOD", "MANY"] }];
    case 400:
      return [{ type: "order", agentId: "b", order: { kind: "attack", tileX: 40, tileY: 48 }, intent: "flank" }];
    case 700:
      return [
        { type: "order", agentId: "c", order: { kind: "hold" } },
        { type: "mark", agentId: "a", ...onAnt(state, "a"), words: ["HELP"] },
      ];
    case 1100:
      return [{ type: "order", agentId: "a", order: { kind: "follow_trail" } }];
    case 1500:
      return [{ type: "rejoin", agentId: "b" }, { type: "join", agentId: "d", modelLabel: "model-d" }];
    case 1900:
      return [{ type: "order", agentId: "d", order: { kind: "forage" } }];
    case 2500:
      return [{ type: "found_queen", agentId: "a", tileX: 28, tileY: 48 }];
    case 3050:
      return [{ type: "found_queen", agentId: "c", tileX: 24, tileY: 40 }, { type: "found_queen", agentId: "b", tileX: 102, tileY: 48 }];
    default:
      return state.tick % 400 === 100 ? [{ type: "observe", agentId: "a" }] : [];
  }
}

/** Play the scripted session for TICKS ticks; returns sampled and end hashes and the match log lines. */
function playBaseline(config: SimConfig, hash: (state: SimState) => string = stateHash): { sampled: Record<number, string>; end: string; lines: string[] } {
  let state = createMatch(SEED, config);
  const sampled: Record<number, string> = {};
  const lines = [headerLine(SEED, config)];
  while (state.tick < TICKS && state.result === null) {
    const inputs = baselineInputs(state);
    if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
    state = step(state, inputs).state;
    if (state.tick % SAMPLE_EVERY === 0) sampled[state.tick] = hash(state);
  }
  return { sampled, end: hash(state), lines };
}

describe("historical public simulation pins and current live guidance", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ simConfig: playable(CURRENT_PUBLIC_CONFIG) });
  });
  afterAll(async () => {
    await h.close();
  });

  const config = playable(PUBLIC_CONFIG);
  // Compare runs on gameplay state only: the config each run names is normalized to the same one.
  const run = playBaseline(config, (state) => stateHash({ ...state, config }));

  it("an explicit ANTWAR_RULES=v4 run plays the same trajectory; only its config names the rules and players", () => {
    const explicit = playBaseline(playable({ ...PUBLIC_CONFIG, rules: "v4", players: 2 }), (state) => stateHash({ ...state, config }));
    expect(explicit.sampled).toEqual(run.sampled);
    // Six samples (ticks 500 to 3000): the scripted session ran its full length, so the comparison is not vacuous.
    expect(Object.keys(explicit.sampled)).toHaveLength(6);
    expect(explicit.end).toBe(run.end);
    expect(explicit.lines.slice(1)).toEqual(run.lines.slice(1));
  }, 60_000);

  it("offers the pinned live tools", async () => {
    const a = await h.connect();
    const { tools } = await a.client.listTools();
    const listed = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    // The pin was taken on the reference grid. At grid scale 2 exactly two observe phrases differ:
    // sight doubles (6 -> 12 tiles) and territoryTiles is explained as original-size areas.
    const scaled = [" territoryTiles counts original-size tile areas, not fine tiles.", "(12 tiles around each colony ant)"];
    for (const phrase of scaled) expect(listed.split(phrase)).toHaveLength(2);
    const reference = listed.replace(scaled[0]!, "").replace(scaled[1]!, "(6 tiles around each colony ant)");
    expect(sha(reference)).toBe(PUBLIC_BASELINE.tools);
  });
});
