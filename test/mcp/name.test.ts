import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("the agent-facing game name", () => {
  it("initializes as antwars with the unchanged version at /mcp", async () => {
    h = await startHarness();
    expect(h.url.pathname).toBe("/mcp");
    const agent = await h.connect();
    expect(agent.client.getServerVersion()).toEqual({ name: "antwars", version: "0.1.0" });
  });

  it.each([true, false])("names Antwars in tool discovery, rules and the join briefing (running: %s)", async (start) => {
    h = await startHarness({ start });
    const agent = await h.connect();
    const { tools } = await agent.client.listTools();
    expect(tools.find((tool) => tool.name === "join")?.description).toMatch(/^Join Antwars, or rejoin/);

    const rules = await agent.call("rules");
    expect(rules.isError).toBe(false);
    expect(rules.data.rules).toContain("Antwars: two supercolonies,");
    expect(rules.data.rules).not.toContain("Ant war:");

    const joined = await agent.call("join");
    expect(joined.isError).toBe(false);
    // Briefings open with the one idle rule, then name Antwars.
    expect(joined.data.briefing.split("\n")[1]).toMatch(/^Antwars: /);
    expect(joined.data.briefing).not.toContain("Ant war:");
  });
});
