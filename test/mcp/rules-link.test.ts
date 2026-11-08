import { describe, expect, it } from "vitest";
import { startHarness } from "./harness.ts";
import { briefing, joinBriefing } from "../../src/mcp/briefing.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { playable } from "../playable.ts";

describe("the shared rules link", () => {
  it.each([
    { ...playable(PUBLIC_CONFIG), ticksPerSecond: 10, commandFloorTicks: 100 },
    { ...playable(PUBLIC_CONFIG), ticksPerSecond: 20, commandFloorTicks: 140 },
  ])("names all commands sharing the configured allowance (%#)", (config) => {
    const line = briefing(config).split("\n").find((line) => line.startsWith("- One command per"));
    expect(line).toBe(`- One command per ${config.commandFloorTicks / config.ticksPerSecond} s: order, mark and found_queen share one allowance per agent; an order and the mark it carries count as one command. observe does not use this allowance.`);
    const historical = briefing({ ...config, queenFounding: undefined }).split("\n").find((line) => line.startsWith("- One command per"));
    expect(historical).toContain("order and mark share one allowance per agent");
    expect(historical).not.toContain("found_queen");
  });
  it("points agents to the same origin-relative page as spectators", () => {
    expect(briefing(playable(PUBLIC_CONFIG)).split("\n").filter((line) => line.includes("/rules"))).toEqual([
      "Rules for humans and agents: /rules on this server (same origin as your MCP address).",
    ]);
  });
  it("is present in the actual join reply", async () => {
    const harness = await startHarness();
    try {
      const agent = await harness.connect();
      const reply = await agent.call("join", {});
      expect(reply.isError).toBe(false);
      expect(reply.data.briefing).toContain("If your nest window is open, call pick_nest first, then read rules.");
    } finally {
      await harness.close();
    }
  });
});

it("teaches pick-first conditionally in both briefing forms and the static rules description", async () => {
  for (const config of [playable(PUBLIC_CONFIG), { ...playable(PUBLIC_CONFIG), rules: undefined, countMarks: undefined }]) {
    expect(joinBriefing(config)).toContain("If your nest window is open, call pick_nest first, then read rules.");
    expect(joinBriefing(config)).toContain("A legal repick replaces yours.");
    expect(joinBriefing(config)).not.toContain("Read rules now");
  }
  const h = await startHarness();
  try {
    const agent = await h.connect();
    const tools = await agent.client.listTools();
    const rules = tools.tools.find(tool => tool.name === "rules")!;
    expect(rules.description).toContain("If your nest window is open, call pick_nest first, then read this.");
    expect(rules.description).toContain("A legal repick replaces yours.");
  } finally { await h.close(); }
});
