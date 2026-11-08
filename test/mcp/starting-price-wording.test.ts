import { describe, expect, it } from "vitest";
import { briefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { PUBLIC_CONFIG, type QueenRules } from "../../src/sim/config.js";
import { ruleSections } from "../../web/rules.js";
import { playable } from "../playable.ts";

describe("founding price text for starting queens", () => {
  it("describes founded-queen pricing in the default rules page and briefing", () => {
    const agent = briefing(playable(PUBLIC_CONFIG), DEFAULT_MCP_CONFIG);
    const viewer = ruleSections(playable(PUBLIC_CONFIG)).flatMap(section => section.lines).join("\n");
    for (const text of [agent, viewer]) {
      expect(text).toContain("additional living founded queen; starting queens do not count");
      expect(text).toContain("400 stored food");
      expect(text).not.toContain("additional live queen");
      expect(text).not.toContain("queen ever founded, including replacements");
    }
  });

  it.each([
    ["live", "additional live queen"],
    ["historical", "queen ever founded, including replacements"],
    ["founded-live", "additional living founded queen; starting queens do not count"],
  ] as const)("describes %s without changing the older price rules", (costBasis: QueenRules["costBasis"], expected) => {
    const config = { ...playable(PUBLIC_CONFIG), queenFounding: { ...playable(PUBLIC_CONFIG).queenFounding!, costBasis } };
    const agent = briefing(config, DEFAULT_MCP_CONFIG);
    const viewer = ruleSections(config).flatMap(section => section.lines).join("\n");
    for (const text of [agent, viewer]) {
      expect(text).toContain(expected);
      expect(text).toContain("400 stored food");
      if (costBasis === "founded-live") expect(text).not.toContain("queen ever founded, including replacements");
      else expect(text).not.toContain("starting queens do not count");
    }
  });
});
