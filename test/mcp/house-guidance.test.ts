import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { describe, expect, it } from "vitest";
import { briefing, joinBriefing, observeDetailText, houseIdleText } from "../../src/mcp/briefing.js";
import { rulesConfig } from "../../src/sim/config.js";
import { startHarness } from "./harness.js";
import { playable } from "../playable.ts";

function expectHouseInstructions(text: string): void {
  expect(text).toMatch(/Index matches, modes house-1v1\.\.house-4v4/i);
  expect(text).toMatch(/only antwars-owned handles join/i);
  expect(text).not.toMatch(/house modes|house agents|rated house|house matches/i);
  expect(text).toMatch(/house-4v4: only antwars-owned handles join; each has its own rating/i);
}

describe("house mode guidance", () => {
  it("both current briefing forms describe house mode, its sizes, admission and per-size rating", () => {
    const config = playable(rulesConfig("redesign"));
    for (const house of [false, true]) for (const text of [briefing(config, undefined, { house }), joinBriefing(config, undefined, false, { house })]) expectHouseInstructions(text);
  });

  // One idle rule for every match type, stated identically in house and other contexts.
  it.each([180, 45])("every briefing and observe state the live %s-second one-rule policy once", houseIdleSeconds => {
    const mcp = { ...DEFAULT_MCP_CONFIG, houseIdleSeconds };
    const config = playable(rulesConfig("redesign"));
    for (const house of [true, false]) for (const text of [briefing(config, mcp, { house }), joinBriefing(config, mcp, false, { house }), observeDetailText(config, mcp, { house })]) {
      expect(text.split(houseIdleText(mcp))).toHaveLength(2);
      expect(text).not.toMatch(/rated house|house idle limit|command-only idle takeover/i);
      expect(text).toContain(`Idle, every match: a seat with no accepted authenticated game-tool call (observe, rules, join count; refusals do not) for ${houseIdleSeconds} s is idle; no bot takeover.`);
      expect(text).toContain("Index match (house-*): match abandoned, unrated.");
      expect(text).toContain("Ranked match, a seat not joined by the limit counted from match start: match abandoned, unrated.");
      expect(text).toContain("Other matches: the idle seat's colony loses (rated if ranked); both colonies idle on one tick: draw.");
    }
    // Briefings open with the idle rule, ahead of the nest-window line.
    for (const house of [true, false]) for (const text of [briefing(config, mcp, { house }), joinBriefing(config, mcp, true, { house }), joinBriefing(config, mcp, false, { house })]) {
      expect(text.split("\n")[0]).toBe(houseIdleText(mcp));
    }
  });

  it("the default idle limit is 300 s", () => {
    expect(houseIdleText(DEFAULT_MCP_CONFIG)).toContain("for 300 s is idle");
    expect(briefing(playable(rulesConfig("redesign")), DEFAULT_MCP_CONFIG, { house: true }).split("\n")[0]).toBe(houseIdleText(DEFAULT_MCP_CONFIG));
  });

  it("only the one idle-rule line follows the server setting", () => {
    // The idle rule is one line, and the live-limit note names the server setting.
    // The rules-25 text these renderings were once pinned to was removed with that rules generation.
    const renders = [briefing, joinBriefing, observeDetailText] as const;
    const current = playable(rulesConfig("redesign"));
    const { soldierRadius: _soldierRadius, ...preArrivalSoft } = current.softSeparation!;
    const historical = { ...current, pointArrival: undefined, softSeparation: preArrivalSoft };
    for (const render of renders) for (const houseIdleSeconds of [180, 45]) {
      const mcp = { ...DEFAULT_MCP_CONFIG, houseIdleSeconds };
      // Repin: the idle-rule line (and observe's live-limit note) is stripped before hashing.
      const strip = (text: string) => text.replace(`${houseIdleText(mcp)}\n`, "").replace(` houseIdleSeconds is the live server limit. ${houseIdleText(mcp)}`, "");
      const text = render(historical, mcp);
      expect(text.split(houseIdleText(mcp))).toHaveLength(2);
      const currentText = render(current, mcp);
      expect(strip(currentText)).toBe(render(current, { ...DEFAULT_MCP_CONFIG, houseIdleSeconds: 180 }).replace(`${houseIdleText({ ...DEFAULT_MCP_CONFIG, houseIdleSeconds: 180 })}\n`, "").replace(` houseIdleSeconds is the live server limit. ${houseIdleText({ ...DEFAULT_MCP_CONFIG, houseIdleSeconds: 180 })}`, ""));
    }
  });

  it.each(["house-1v1", "house-4v4", "1v1", null] as const)("wires the live idle rule to %s callers before, during and after play", async mode => {
    // Every mode states the one idle rule and reports the live limit.
    const house = true;
    const mcp = { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1_000_000, houseIdleSeconds: 45 };
    const h = await startHarness({ start: false, simConfig: playable(rulesConfig("redesign")), mcpConfig: mcp,
      slot: { identityOf: async key => key === "left" || key === "right" ? key : undefined, locate: async () => undefined } });
    try {
      h.game.seatLobby("guidance", [{ identityId: "left", displayName: "Left", colony: 0 }, { identityId: "right", displayName: "Right", colony: 1 }], mode);
      const left = await h.connect(), right = await h.connect();
      const check = (text: string) => expect(text.includes(houseIdleText(mcp))).toBe(house);
      check((await left.call("rules")).data.rules);
      const tools = await left.client.listTools();
      check(tools.tools.find(tool => tool.name === "observe")!.description!);
      const joined = await left.call("join", { key: "left" });
      expect(joined.isError).toBe(false); check(joined.data.briefing);
      await right.call("join", { key: "right" });
      check((await left.call("rules")).data.rules);
      h.game.startMatch(429); h.advance(1);
      check((await left.call("rules")).data.rules);
      const observed = await left.call("observe");
      expect(observed.isError).toBe(false);
      expect(observed.data.houseIdleSeconds).toBe(45);
      h.game.tick(true);
      check((await left.call("rules")).data.rules);
      // A reused slot must not give the ended caller the next lobby's mode.
      h.game.seatLobby("next-guidance", [], mode?.startsWith("house-") ? "1v1" : "house-1v1");
      check((await left.call("rules")).data.rules);
    } finally { await h.close(); }
  });
});
