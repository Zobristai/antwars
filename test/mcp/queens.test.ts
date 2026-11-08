import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { briefing } from "../../src/mcp/briefing.js";
import { createMatch } from "../../src/sim/map.js";
import { foundQueen } from "../../src/sim/agents.js";
import { stateHash } from "../../src/sim/log.js";
import { compareObserveMethods, jsonByteBreakdown, measureQueenObserve } from "./queen-payload.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe("seated MCP queen founding", () => {
  it("explains the shipped guard cap, 60-second overrun and match-start grace", () => {
    const guards = briefing(playable(PUBLIC_CONFIG));
    expect(guards).toContain("each live queen targets the full colony-size guard allotment");
    expect(guards).toContain("at most 60% of all live colony ants in total");
    expect(guards).toContain("At least 40% remain outside house guard assignments");
    expect(guards).toContain("for 60 s permanently loses that queen");
    expect(guards).toContain("before 720 s after match start; founded queens have no extra grace");
    const { guardsPerQueen: _, ...oldRules } = playable(PUBLIC_CONFIG).queenFounding!;
    expect(briefing({ ...playable(PUBLIC_CONFIG), queenFounding: oldRules })).toContain("one colony-size guard allotment is shared");
  });

  it("offers the command with real schema, debits food, and lists queens without a full command view", async () => {
    const config = { ...playable(PUBLIC_CONFIG), queenFounding: { ...playable(PUBLIC_CONFIG).queenFounding!, maxLiveQueens: 4 }, startAnts: 0, commandFloorTicks: 1 };
    const state = createMatch(42, config); state.tick = config.queenFounding!.firstFoundTick! + 1;
    state.owner[10 * config.mapWidth + 18] = 0; state.lastVisit[10 * config.mapWidth + 18] = state.tick;
    const budget = config.queenFounding!.cost + 40; state.colonies[0].foodStore = budget;
    h = await startHarness({ simConfig: config, state });
    const a = await h.connect();
    const tools = await a.client.listTools();
    expect(tools.tools.find((t) => t.name === "found_queen")?.inputSchema.properties).toHaveProperty("tileX");
    const joined = await a.call("join");
    expect(joined.data.briefing).toContain("found_queen");
    expect(joined.data.view.queens).toHaveLength(1);
    const founded = await a.call("found_queen", { tileX: 18, tileY: 10 });
    expect(founded.isError).toBe(false); expect(founded.data.accepted).toBe(true);
    expect(founded.data.view).toBeUndefined();
    expect(founded.data).not.toHaveProperty("events");
    expect(founded.data.queen).toMatchObject({ queenId: 1, tileX: 18, tileY: 10 });
    const observe = await a.call("observe");
    expect(observe.data.view.queens).toHaveLength(2); expect(observe.data.view.territory).toBeUndefined();
    expect(observe.data.view.queenFounding.foodStore).toBeLessThan(budget);
    expect(observe.data.view.queenFounding).toMatchObject({ cost: 800, firstFoundTick: 3000 });
    const refused = await a.call("found_queen", { tileX: 18, tileY: 10 });
    expect(refused.isError).toBe(true); expect(refused.data.error.howToFix).toMatch(/wait|observe/i);
    expect(h.inputsOf(joined.data.agentId).filter((i) => i.type === "found_queen")).toHaveLength(2);
  });
  it("requires a seated session and handles malformed input through the normal refusal boundary", async () => {
    h = await startHarness({ simConfig: playable(PUBLIC_CONFIG) });
    const a = await h.connect();
    expect((await a.call("found_queen", { tileX: 18, tileY: 10 })).data.error.code).toBe("not_joined");
    const joined = await a.call("join");
    for (const args of [{ tileX: "north", tileY: 10 }, { tileX: 18 }, { tileX: null, tileY: 10 }]) {
      const bad = await a.call("found_queen", args);
      expect(bad.isError).toBe(true); expect(bad.data.error.code).toBe("bad_arguments");
    }
    expect(h.inputsOf(joined.data.agentId).filter((i) => i.type === "observe")).toHaveLength(3);
    expect(h.game.match!.state.colonies[0].queens).toHaveLength(1);
  });
  it("explains recorded opening-time and live-cap refusals", async () => {
    const config = { ...playable(PUBLIC_CONFIG), queenFounding: { ...playable(PUBLIC_CONFIG).queenFounding!, maxLiveQueens: 4 }, startAnts: 0, commandFloorTicks: 1 };
    const early = createMatch(42, config);
    early.owner[10 * config.mapWidth + 18] = 0; early.colonies[0].foodStore = 10000;
    h = await startHarness({ simConfig: config, state: early });
    let a = await h.connect(); await a.call("join");
    const before = await a.call("found_queen", { tileX: 18, tileY: 10 });
    expect(before.data.error).toMatchObject({ code: "queen_too_early", howToFix: expect.stringMatching(/wait|opening/i) });
    await h.close(); h = undefined;
    const capped = createMatch(42, config); capped.colonies[0].foodStore = 10000;
    // Three founded queens at least the 32-tile founding distance from each other and both starting nests.
    for (const [i, [x, y]] of [[36, 20], [36, 76], [72, 48]].entries()) {
      capped.owner[y! * config.mapWidth + x!] = 0;
      expect(foundQueen(capped, 0, x!, y!, 3000 + i * 1800, [])).toBeNull();
    }
    capped.tick = 6601; capped.owner[5 * config.mapWidth + 45] = 0; capped.lastVisit.fill(capped.tick);
    h = await startHarness({ simConfig: config, state: capped }); a = await h.connect();
    const joined = await a.call("join");
    // Founded-live pricing: the starting nest is free, so three founded queens price the next at 400 × 2^3.
    expect(joined.data.view.queenFounding).toMatchObject({ slotsRemaining: 0, cost: 3200 });
    const refused = await a.call("found_queen", { tileX: 45, tileY: 5 });
    expect(refused.data.error).toMatchObject({ code: "queen_limit", howToFix: expect.stringMatching(/live slot|slotsRemaining/i) });
    expect(h.game.match!.state.colonies[0].queens).toHaveLength(4);
  });

  it("measures complete observe replies on isolated clones without changing the played match", async () => {
    const state = createMatch(42, playable(PUBLIC_CONFIG)), hash = stateHash(state);
    const results = await measureQueenObserve(state);
    expect(results).toHaveLength(4);
    for (const colony of [0, 1]) {
      const plain = results.find((r) => r.colony === colony && !r.map)!;
      const withMap = results.find((r) => r.colony === colony && r.map)!;
      expect(plain.bytes).toBeGreaterThan(0); expect(withMap.bytes).toBeGreaterThan(plain.bytes);
      expect(plain.sourceTick).toBe(0); expect(plain.observedTick).toBeGreaterThan(0);
      for (const measured of [plain, withMap]) {
        const { tool, view, structured, guardsByQueen } = measured.breakdown;
        expect(tool.totalBytes).toBe(measured.bytes);
        for (const part of [tool, view, structured]) expect(part.framingBytes + Object.values(part.fields).reduce((a, b) => a + b, 0)).toBe(part.totalBytes);
        expect(view.fields).not.toHaveProperty("guardsByQueen");
        expect(view.fields).not.toHaveProperty("foundingDecisions");
        for (const c of guardsByQueen) for (const q of c.queens) {
          expect(Object.keys(q).sort()).toEqual(["count", "queenId"]);
          expect(Number.isInteger(q.count)).toBe(true);
        }
      }
    }
    expect(stateHash(state)).toBe(hash);
  });

  it("isolates adapter/method effects on the same snapshot without changing played state", async () => {
    const state = createMatch(6006, playable(PUBLIC_CONFIG)), hash = stateHash(state);
    const comparison = await compareObserveMethods(state, 0);
    expect(comparison.comparison).toHaveLength(2);
    for (const c of comparison.comparison) expect(c).toMatchObject({ sameObservedTick: true, toolByteDelta: 0, textByteDelta: 0 });
    expect(stateHash(state)).toBe(hash);
    const utf8 = jsonByteBreakdown({ word: "蟻", quoted: "a\\\"b", omitted: undefined });
    expect(utf8.fields.word).toBe(Buffer.byteLength(JSON.stringify("蟻")));
    expect(utf8.fields).not.toHaveProperty("omitted");
  });

  it("does not advertise the new command in historical one-queen rules", async () => {
    h = await startHarness(); const a = await h.connect();
    expect((await a.client.listTools()).tools.some((t) => t.name === "found_queen")).toBe(false);
  });
});
