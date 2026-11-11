// The game-mode names: the site's match labels are "Index · NvN",
// "Challenge · 1v1", "Ranked · NvN" and "Unranked · NvN" (a public or invite-only lobby, against Ranked); the ranked ladder
// is "Ranked" everywhere; and no shown or agent-facing text says "house challenge", "rated challenge", "Antwars
// Benchmark", "Benchmark mode" or "Open Rankings", nor any other than the match labels "Unranked". Stored values (recording kind "unranked", challenge.kind "house", house-* mode ids) stay as they are.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MATCH_TYPE_WORDS, recordingType } from "../../../web/src/ui/format.ts";
import { waitingType } from "../../../web/src/pages/waiting.ts";
import { tableTitle } from "../../../web/src/pages/model.ts";
import { C } from "../../../web/src/leaderboard-page/copy.ts";
import { ACCOUNT_OPERATIONS } from "../../../src/accounts/service.ts";
import { HOUSE_IDLE_PROMPT_TEXT, IDLE_COUNTDOWN_TEXT, briefing, houseIdleText, joinBriefing } from "../../../src/mcp/briefing.ts";
import { rulesConfig } from "../../../src/sim/config.ts";
import { playable } from "../../playable.ts";

const RETIRED = [/house challenge/i, /\brated challenge/i, /antwars benchmark/i, /benchmark modes?\b/i, /open rankings/i, /\bunranked\b/i];
/** The match labels' own words: "Unranked" is one of them. */
const LABEL_RETIRED = RETIRED.filter(word => !word.test("Unranked"));

describe("site match labels", () => {
  it("Recordings words each match type by its standing mode name", () => {
    expect(recordingType({ kind: "index", size: 2 })).toBe("Index · 2v2");
    expect(recordingType({ kind: "challenge", size: 1 })).toBe("Challenge · 1v1");
    expect(recordingType({ kind: "ranked", size: 3 })).toBe("Ranked · 3v3");
    expect(recordingType({ kind: "unranked", size: 4 })).toBe("Unranked · 4v4");
    expect(recordingType({ kind: "unrated", size: 1 })).toBe("Unrated · 1v1");
    for (const word of Object.values(MATCH_TYPE_WORDS)) for (const retired of LABEL_RETIRED) expect(word).not.toMatch(retired);
  });

  it("Waiting words queues and lobbies with the same names", () => {
    const agent = { displayName: "a", waitingSeconds: 0, since: 0 };
    expect(waitingType({ ...agent, mode: "house-1v1" })).toBe("Index · 1v1");
    expect(waitingType({ ...agent, mode: "2v2" })).toBe("Ranked · 2v2");
    const lobby = { size: 1 as const, seated: 1, colonies: [["a"], []] as [string[], string[]], waitingSeconds: 0, since: 0 };
    expect(waitingType({ ...lobby, mode: null, challenge: "house" })).toBe("Challenge · 1v1");
    expect(waitingType({ ...lobby, mode: null })).toBe("Unranked · 1v1");
  });

  it("the ranked ladder is Ranked in both of its tables; the Antwars Model Index heads only its own leaderboard", () => {
    expect(tableTitle({ id: "aw-everyone-ranking", title: "" }, "2v2")).toBe("Ranked · 2v2");
    expect(tableTitle({ id: "aw-house-ranking", title: "" }, "2v2")).toBe("Ranked · 2v2 · house models");
    expect(tableTitle({ id: "aw-house-mode-ranking", title: "" }, "house-2v2")).toBe("Antwars Model Index · 2v2");
    for (const text of Object.values(C).flat()) for (const retired of RETIRED) expect(String(text)).not.toMatch(retired);
  });
});

describe("agent-facing copy", () => {
  it("operation descriptions, briefings and idle texts use no retired mode name", () => {
    const config = playable(rulesConfig("redesign"));
    const texts = [
      ...ACCOUNT_OPERATIONS.map(op => op.description), briefing(config), joinBriefing(config),
      briefing(config, undefined, { house: true }), joinBriefing(config, undefined, false, { house: true }),
      houseIdleText(), HOUSE_IDLE_PROMPT_TEXT, IDLE_COUNTDOWN_TEXT,
    ];
    for (const text of texts) for (const retired of RETIRED) expect(text).not.toMatch(retired);
  });

  it("the source of refusals, nest tools, the launchable handle list and the spectator doc uses no retired mode name", () => {
    for (const file of ["src/accounts/service.ts", "src/mcp/nestTools.ts", "src/mcp/briefing.ts", "src/lobby/houseLaunchable.ts",
      "docs/spectator-access.md"]) {
      const text = readFileSync(file, "utf8");
      for (const retired of [/house challenge/i, /\brated challenge/i, /antwars benchmark/i, /benchmark modes?\b/i, /open rankings/i]) {
        expect(text, file).not.toMatch(retired);
      }
    }
  });
});
