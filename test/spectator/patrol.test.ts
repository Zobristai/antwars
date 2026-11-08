import { describe, expect, it } from "vitest";
import { ruleSections } from "../../web/rules.ts";
import { markSymbol } from "../../web/src/mark-symbols.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";

describe("patrol spectator rules and existing owner-glyph fallback", () => {
  it("uses the existing fallback, not a new symbol or a guessed DEFEND symbol", () => {
    expect(markSymbol("PATROL")).toBeNull();
    expect(markSymbol("DEFEND")).toBe("DEFEND");
  });

  it("states this match’s range, loop and lone-mark rule from config", () => {
    const config = { ...newMatchConfig(rulesConfig("redesign")), patrolLinkTiles: 9 };
    const text = ruleSections(config).flatMap(section => section.lines).join("\n");
    expect(text).toContain("PATROL");
    expect(text).toContain("within 9 tiles (Euclidean)");
    expect(text).toContain("ants loop oldest to newest (laidTick, then id) and back");
    expect(text).toContain("A lone patrol mark holds exactly like DEFEND");
    expect(text).toContain("bridging mark");
    const { patrolLinkTiles: _patrol, ...old } = config;
    expect(ruleSections(old).flatMap(section => section.lines).join("\n")).not.toContain("PATROL");
  });
});
