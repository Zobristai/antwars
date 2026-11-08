/**
 * Rules 27 (including the reply limit for observe, join and found_queen):
 * in rules 27 observe shows each of the caller's colony's live queens with her owner ("you"
 * or the teammate's name) and brood, in place of the earlier colony brood and myBrood fields, and the
 * brood_vote_lost notice no longer exists.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NEW_QUEEN_BROOD_TEXT } from "../../src/mcp/briefing.js";
import { DEFAULT_REPLY_LIMITS, OBSERVE_REPLY_LIMITS, type ReplyLimits } from "../../src/mcp/replies.js";
import { COLONY_NAMES, PUBLIC_CONFIG, SUB, type SimConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import type { Brood } from "../../src/sim/types.js";
import { NEW_MATCH_REPLY_MAP_IDS, measureReplies } from "./response-size-fixture.js";
import { startHarness, type CallResult, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

const base = playable(PUBLIC_CONFIG);
const config: SimConfig = { ...base, queenFounding: { ...base.queenFounding!, maxLiveQueens: 8 }, startAnts: 0, commandFloorTicks: 1 };

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

/** Characters of the reply's text content; bytes of the complete tool result, both copies. */
function within(reply: CallResult, limits: ReplyLimits): void {
  expect(reply.text.length).toBeLessThanOrEqual(limits.textChars);
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: reply.text }], structuredContent: reply.data })))
    .toBeLessThanOrEqual(limits.bytes);
}

async function seat(args: Record<string, unknown> = {}): Promise<{ client: TestAgent; id: string; token: string }> {
  const client = await h!.connect();
  const joined = await client.call("join", { colony: COLONY_NAMES[0], ...args });
  expect(joined.isError, joined.text).toBe(false);
  return { client, id: joined.data.agentId as string, token: joined.data.reconnectToken as string };
}

/** Five more live queens and one lost one beside colony 0's starting queen, as copies of her. */
function addQueens(simConfig: SimConfig): ReturnType<typeof createMatch> {
  const state = createMatch(42, simConfig);
  const first = state.colonies[0].queens![0]!;
  for (let i = 1; i <= 6; i++) {
    state.colonies[0].queens!.push({ ...first, id: i, queenX: (20 + 8 * i) * SUB + 500, queenY: 20 * SUB + 500,
      foundedTick: 0, lostTick: i === 6 ? 0 : null });
  }
  return state;
}

/** Owners and broods set directly on the sim's queens. */
function setQueens(owners: readonly (string | undefined)[], broods: readonly (Brood | undefined)[]): void {
  for (const [i, queen] of h!.game.match!.state.colonies[0].queens!.entries()) {
    if (owners[i] === undefined) delete queen.owner; else queen.owner = owners[i];
    if (broods[i] === undefined) delete queen.brood; else queen.brood = broods[i];
  }
}

const queenFields = (reply: CallResult) => (reply.data.view.queens as { queenId: number; lostTick: number | null; owner?: string; brood?: Brood }[])
  .map(({ queenId, lostTick, owner, brood }) => ({ queenId, lostTick, ...(owner === undefined ? {} : { owner }), ...(brood === undefined ? {} : { brood }) }));

describe("rules 27 observe shows each live queen's owner and brood", () => {
  it("names the owner as you or the teammate, shows her brood, and drops the colony vote fields", async () => {
    h = await startHarness({ simConfig: config, state: addQueens(config) });
    const own = await seat({ displayName: "Ada" });
    const bea = await seat({ displayName: "Bea", modelLabel: "model-b" });
    const labelled = await seat({ modelLabel: "model-x" });
    const anonymous = await seat();
    setQueens([own.id, bea.id, labelled.id, anonymous.id, "agent-with-no-record", undefined, own.id],
      ["soldiers", "workers", undefined, "mixed", "soldiers", undefined, "soldiers"]);
    const expected = [
      { queenId: 0, lostTick: null, owner: "you", brood: "soldiers" },
      { queenId: 1, lostTick: null, owner: "Bea", brood: "workers" },
      { queenId: 2, lostTick: null, owner: "model-x", brood: "mixed" },
      { queenId: 3, lostTick: null, owner: "a teammate", brood: "mixed" },
      { queenId: 4, lostTick: null, owner: "a teammate", brood: "soldiers" },
      // Left unowned, she is drawn an owner on the next tick (the seeded draw picks this seat); no brood breeds mixed.
      { queenId: 5, lostTick: null, owner: "you", brood: "mixed" },
      // A lost queen keeps her history entry but shows neither field.
      { queenId: 6, lostTick: 0 },
    ];
    const observed = await own.client.call("observe");
    expect(observed.isError, observed.text).toBe(false);
    expect(queenFields(observed)).toEqual(expected);
    expect(observed.data.view).not.toHaveProperty("brood");
    expect(observed.data.view).not.toHaveProperty("myBrood");
    for (const id of [own.id, bea.id, labelled.id, anonymous.id]) expect(JSON.stringify(observed.data.view.queens)).not.toContain(id);
    within(observed, OBSERVE_REPLY_LIMITS);

    // The teammate's own observe reads the same queens from its side.
    const fromBea = await bea.client.call("observe");
    expect(queenFields(fromBea).slice(0, 2)).toEqual([
      { queenId: 0, lostTick: null, owner: "Ada", brood: "soldiers" },
      { queenId: 1, lostTick: null, owner: "you", brood: "workers" },
    ]);

    // A reconnecting join carries the same view mapping.
    await own.client.end();
    const again = await h.connect();
    const rejoined = await again.call("join", { reconnectToken: own.token });
    expect(rejoined.isError, rejoined.text).toBe(false);
    expect(queenFields(rejoined)).toEqual(expected);
    expect(rejoined.data.view).not.toHaveProperty("brood");
    expect(rejoined.data.view).not.toHaveProperty("myBrood");
    within(rejoined, OBSERVE_REPLY_LIMITS);
  });

});


describe("rules 27 reply limits with queen owners and brood", () => {
  it("keeps the found_queen reply's queen entry mapped and within the command reply limit", async () => {
    const state = createMatch(42, config); state.tick = config.queenFounding!.firstFoundTick! + 1;
    state.owner[10 * config.mapWidth + 18] = 0; state.lastVisit[10 * config.mapWidth + 18] = state.tick;
    state.colonies[0].foodStore = config.queenFounding!.cost + 40;
    h = await startHarness({ simConfig: config, state });
    const own = await seat({ displayName: "Ada" });
    const founded = await own.client.call("found_queen", { tileX: 18, tileY: 10 });
    expect(founded.isError, founded.text).toBe(false);
    expect(founded.data.queen).toMatchObject({ queenId: 1, tileX: 18, tileY: 10, brood: "mixed" });
    // The founder owns her, which reads as "you": never an agentId.
    expect(founded.data.queen.owner).toBe("you");
    expect(JSON.stringify(founded.data.queen)).not.toContain(own.id);
    // The reply says she breeds mixed until her owner calls set_brood, alongside what it carried before.
    expect(founded.data.broodNote).toBe(NEW_QUEEN_BROOD_TEXT);
    expect(founded.data).toHaveProperty("foodStore");
    expect(founded.data).toHaveProperty("nextFoundTick");
    within(founded, DEFAULT_REPLY_LIMITS);
  });

  // The largest view main's own size tests use: eight seats, 512 ants per colony, dense front and
  // spread (nine nests per colony), with every live queen owned and breeding a set brood.
  // New-match configs measure the current maps in MAPS' three positions.
  it.each(NEW_MATCH_REPLY_MAP_IDS.map(mapId => ({ mapId })))("keeps join, observe and found_queen within their limits on $mapId", async ({ mapId }) => {
    const broods: readonly Brood[] = ["soldiers", "workers", "mixed"];
    const own = (harness: Harness): void => {
      const state = harness.game.match!.state;
      for (const colony of state.colonies) {
        const seats = state.agents.filter(agent => agent.colony === colony.id);
        for (const [i, queen] of colony.queens!.entries()) {
          if (queen.lostTick !== null) continue;
          queen.owner = seats[i % seats.length]!.id;
          queen.brood = broods[i % broods.length]!;
        }
      }
    };
    for (const spread of [false, true]) {
      const result = await measureReplies("redesign", spread, mapId, undefined, false, c => c, own);
      for (const tool of ["join", "observe", "found_queen"]) {
        const samples = result.samples.filter(sample => sample.tool === tool);
        expect(samples, tool).toHaveLength(8);
        const limits = tool === "found_queen" ? DEFAULT_REPLY_LIMITS : OBSERVE_REPLY_LIMITS;
        for (const sample of samples) {
          expect(sample.completeBytes, JSON.stringify(sample)).toBeLessThanOrEqual(limits.bytes);
          expect(sample.textChars, JSON.stringify(sample)).toBeLessThanOrEqual(limits.textChars);
        }
        console.log(`queen-owner size ${mapId} ${spread ? "spread" : "dense-front"} ${tool}: ${Math.max(...samples.map(s => s.textChars))} chars / ${Math.max(...samples.map(s => s.completeBytes))} bytes`);
      }
    }
  }, 60_000);
});
