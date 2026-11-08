import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeMessage } from "../../src/live/format.js";
import { playScripted, recordLog } from "../../src/live/record.js";
import { Game } from "../../src/mcp/game.js";
import { PUBLIC_CONFIG, SUB } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimInput, SimState } from "../../src/sim/types.js";
import { startHarness, type Harness } from "../mcp/harness.js";
import { HISTORICAL_CONFIG, squadOf } from "./fixtures.js";
import { playable } from "../playable.ts";

/**
 * The RULES_VERSION 3 determinism golden. The values were
 * computed on main 5949b6173982de21a88ec644af427949656d8861, before the caste
 * rules existed. With the rules switch off the simulation hashes must never change.
 * Intentionally updates only MCP copy/schema pins: concise join, full
 * rules call, dense views and paged events; no gameplay or stream pin changes.
 * Repins only the briefing's configured MCP seating text. Historical
 * simulation, stream and order-tool pins remain unchanged.
 */
const GOLDEN_V3 = {
  // Commit 692fb4785f40335cd1b97a8e82642a31b228d622: agent observation uses colony sight with no rules-version gate, so
  // agents[].pendingEvents differ. Compared every tick with its parent 18b444d058a28bbc6ae2d94ddbb45086c0c7fde1:
  // the state without pendingEvents (ants, colonies, food, queens, marks, territory, result) is identical,
  // first differing tick 63 and end included. Previously 1000 c56567dfcf49c1e6, 2000 ec86f572849dd0ef,
  // 3000 ed698a0de16615f2, 4000 203111908fd45d57, 5000 7474677fbe691c22, end 42067fdb4256bc0e.
  // Every match plays at grid scale 2, so the
  // determinism golden is pinned to the scripted match played at grid scale 2 on this code. The reference-grid values were
  // 1000 292dd37d0bdfcc16, 2000 c9973031d7f96b72, 3000 1c4f1111bd63e7ba, 4000 416ecfdd0c2aa462, 5000 5c2b9e8d7cd08f22, end 8a4440717013604c.
  sampled: {
    1000: "1fadb2301d0b02df",
    2000: "aab7a004d46d121f",
    3000: "ad6e064b0977f2ac",
    4000: "8ebc019d99dabffc",
  } as Record<number, string>,
  end: "f5a2303c12ad0ac5",
  // Reconnect/countdown/post-match copy only; gameplay/order-tool pins unchanged.
  // Commit 692fb4785f40335cd1b97a8e82642a31b228d622: rules-text digest only. Its observe copy now describes colony
  // sight and adds the cell-paging legend; unchanged since. Previously 668798c5d92ab20acd7e26e4afc90777ba6f1f6024fd49b8a2b3395b14e0231b.
  // Idle-rule copy only (the one idle-rule line, countdown wording, squad-timer line removed); gameplay pins unchanged.
  // Previously 702dc4499ad8eda652cd0a49ad92ae4bdd41391817aabbb2e87e13a5b35b52a4.
  // Grid scale 2 — 13 sentences carry doubled distances/sizes and 5 carry the existing current-agent
  // copy (rules >= 11) the scaled historical config now reaches; full 18-sentence classification in the review notes.
  // Previously acd6b7e011a742888a6b6fcbde05027bcf884670d86b423301e84a5f69758a4c.
  briefing: "1aa4b2cdb92298992199babd5254d5917deccc14532bc6bda5ee3a54a2cef422",
  orderTool: "e7ddbc08a65d491d0649256f1f6f790eb0447411f2bdfd72e4ed9674c4a4fb95",
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const SEED = 11;
const SAMPLE_EVERY = 1000;

function onAnt(state: SimState, agentId: string): { tileX: number; tileY: number } {
  const ant = squadOf(state, agentId)[0];
  return ant === undefined ? { tileX: 0, tileY: 0 } : { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

/** replay.test.ts's scripted session: joins, orders with marks and intents, marks, a lapse and a rejoin. */
function goldenInputs(state: SimState): SimInput[] {
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
          order: { kind: "go_to", tileX: 30, tileY: 20 },
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
      return [{ type: "order", agentId: "b", order: { kind: "attack", tileX: 20, tileY: 24 }, intent: "hit their flank" }];
    case 700:
      return [{ type: "mark", agentId: "a", ...onAnt(state, "a"), words: ["HELP"] }, { type: "observe", agentId: "c" }];
    case 1500:
      return [{ type: "rejoin", agentId: "b" }, { type: "join", agentId: "d", modelLabel: "model-d" }];
    default:
      return state.tick % 400 === 100 ? [{ type: "observe", agentId: "a" }] : [];
  }
}

/** Play the scripted session to its result; returns the sampled and end hashes. */
function playGolden(
  initial: SimState,
  inputs: (s: SimState) => SimInput[] = goldenInputs,
): { sampled: Record<number, string>; end: string; hatched: Set<string> } {
  let state = initial;
  const sampled: Record<number, string> = {};
  const hatched = new Set<string>();
  while (state.result === null) {
    const out = step(state, inputs(state));
    for (const e of out.events) if (e.type === "hatch" && e.caste !== undefined) hatched.add(e.caste);
    state = out.state;
    if (state.tick % SAMPLE_EVERY === 0) sampled[state.tick] = stateHash(state);
  }
  return { sampled, end: stateHash(state), hatched };
}

/** The scripted session with brood choices: a picks soldiers, b picks workers, d leaves it unset. */
// Every match plays at grid scale 2: the scripted sessions play the same configs at grid scale 2, and the
// state-hash pins above are that grid-scale-2 play.
describe("the historical config without castes", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ simConfig: playable(HISTORICAL_CONFIG) });
  });
  afterAll(async () => {
    await h.close();
  });

  // The public game is the Game built with no config. While its rules switch is
  // off it must be RULES_VERSION 3; switching it on skips this.
  it.skipIf(PUBLIC_CONFIG.castes !== undefined)("the public game, switch off, reproduces the same pinned hashes", () => {
    const { sampled, end } = playGolden(createMatch(SEED, new Game().simConfig));
    expect(sampled).toEqual(GOLDEN_V3.sampled);
    expect(end).toBe(GOLDEN_V3.end);
  }, 60_000);

  it("offers the pinned order tool", async () => {
    const a = await h.connect();
    const { tools } = await a.client.listTools();
    const order = tools.find((t) => t.name === "order")!;
    expect(sha(JSON.stringify({ description: order.description, inputSchema: order.inputSchema }))).toBe(GOLDEN_V3.orderTool);
  });

  it("streams no caste", () => {
    const { lines } = playScripted({ seed: 6006, config: playable(HISTORICAL_CONFIG), agents: 4, ticks: 900, attack: true });
    const messages = recordLog(lines).map(decodeMessage);
    expect(messages.length).toBeGreaterThan(900);
    for (const m of messages) expect("caste" in m.ants).toBe(false);
  });
});
