import { describe, expect, it } from "vitest";
import type { StreamAgent, StreamResult } from "../../src/live/format.ts";
import { agentHandle, playerLabel, playerName, ratingResultRows } from "../../web/src/compose.ts";
import { agentCard } from "../../web/src/overlays.ts";
import { squadTipText } from "../../web/src/squads.ts";
import { modeCopy } from "../../web/src/replay.ts";

const player: StreamAgent = { colony: 0, modelLabel: "anthropic/claude-sonnet-5-5", identity: { displayName: "owner/agent", elo: 1234.5 },
  joinTick: 0, lastCallTick: 0, prevCallTick: -1, order: "hold", orderX: 0, orderY: 0, intent: "Hold the nest" };
const result: StreamResult = { winner: 0, reason: "time_up", decidedBy: "territory", tick: 20, nextStartMs: null,
  ratingChanges: [{ agent: 0, before: 1234.5, after: 1250.5 }, { agent: 1, before: 1000, after: 984 }] };

describe("spectator player identity presentation", () => {
  it("uses recorded names and Elo without guessing an identity for legacy recordings", () => {
    expect(playerName(0, player)).toBe("owner/agent");
    expect(playerLabel(0, player)).toBe("owner/agent · Rating 1235");
    expect(playerLabel(0)).toBe(agentHandle(0));
    expect(playerLabel(0, { identity: undefined })).toBe(agentHandle(0));
    // A seat with a name and no rating (a house challenge seat the Index has not rated) shows the name alone.
    expect(playerLabel(0, { identity: { displayName: "antwars/gpt-6-luna" } })).toBe("GPT-6 Luna");
  });
  it("labels model claims plainly as the model, with no self-reported editorial, on cards and badge tooltips", () => {
    expect(agentCard(0, player, [], 1, 10)[0]).toContain("owner/agent · Rating 1235");
    // The model as the HUD names it, never its provider/model key.
    expect(agentCard(0, player, [], 1, 10)[1]).toBe("Model: Claude Sonnet 5.5");
    expect(agentCard(0, { ...player, thinkingLevel: "high" }, [], 1, 10)[1]).toBe("Model: Claude Sonnet 5.5 (high)");
    // A builder's self-reported label shows as reported.
    expect(agentCard(0, { ...player, modelLabel: "Example model" }, [], 1, 10)[1]).toBe("Model: Example model");
    expect(squadTipText(0, player)).toBe("owner/agent · Rating 1235\nModel: Claude Sonnet 5.5");
  });
  it("names a Benchmark identity by its display name on labels, cards, badge tooltips and result lines, never its antwars/ handle", () => {
    const bench: StreamAgent = { ...player, identity: { displayName: "antwars/gpt-6-luna #2", elo: 1198.33 } };
    expect(playerName(0, bench)).toBe("GPT-6 Luna #2");
    expect(playerLabel(0, bench)).toBe("GPT-6 Luna #2 · Rating 1198");
    expect(agentCard(0, bench, [], 1, 10)[0]).toBe("GPT-6 Luna #2 · Rating 1198 · Very Large Colony");
    // A house identity's model is named by its own row, with its fixed level and tier: no provider/model key.
    expect(squadTipText(0, bench)).toBe("GPT-6 Luna #2 · Rating 1198\nModel: GPT-6 Luna (max · Fast)");
    expect(agentCard(0, bench, [], 1, 10).join("\n")).not.toMatch(/anthropic\/|openai\/|antwars\//);
    const ended = { ...result, ratingChanges: [{ agent: 0, before: 1198.33, after: 1144.46 }, { agent: 1, before: 1000, after: 984 }] };
    expect(ratingResultRows(true, [bench], ended)).toEqual([
      { name: "GPT-6 Luna #2", badges: ["max", "Fast"], text: "Rating 1198 → 1144 (-54)" },
      // A seat the stream carries no identity for keeps its generated handle.
      { name: agentHandle(1), badges: [], text: "Rating 1000 → 984 (-16)" },
    ]);
    expect(ratingResultRows(true, [bench], ended)[0]).toEqual({ name: "GPT-6 Luna #2", badges: ["max", "Fast"], text: "Rating 1198 → 1144 (-54)" });
    expect(ratingResultRows(false, [bench], ended)).toEqual([{ name: "", badges: [], text: "Unrated match · no rating change" }]);
  });
  it("discloses the match's rated delay and keeps historical mode copy unchanged", () => {
    expect(modeCopy("live", 2, false, "/", null, true)).toMatchObject({ label: "LIVE · rated match", detail: "300 s behind the match" });
    expect(modeCopy("live", 2, false, "/", null, false)).toMatchObject({ label: "LIVE · unrated match", detail: "60 s behind the match" });
    expect(modeCopy("live", 0, false, "/", null, true).detail).toContain("300 s behind the match");
    expect(modeCopy("live", 2, false, "/").label).toBe("LIVE");
    expect(modeCopy("replay", 2, false, "/", "2026-10-20T10-00-00-000Z-1", false).label).toContain("unrated match");
  });

  it("does not present rating results before playback has a final result", () => {
    expect(ratingResultRows(true, [player], null)).toEqual([]);
    expect(ratingResultRows(false, [player], null)).toEqual([]);
    expect(ratingResultRows(undefined, [player], result)).toEqual([]);
  });
  it("reports signed per-player changes only for rated matches and distinguishes pending from zero", () => {
    const other = { ...player, identity: { displayName: "other/agent", elo: 1000 } };
    expect(ratingResultRows(true, [player, other], result)).toEqual([
      { name: "owner/agent", badges: [], text: "Rating 1235 → 1251 (+16)" }, { name: "other/agent", badges: [], text: "Rating 1000 → 984 (-16)" },
    ]);
    expect(ratingResultRows(false, [player], result)).toEqual([{ name: "", badges: [], text: "Unrated match · no rating change" }]);
    expect(ratingResultRows(true, [player], { ...result, ratingChanges: undefined })).toEqual([{ name: "", badges: [], text: "Rated match · rating update pending" }]);
    expect(ratingResultRows(true, [player], { ...result, ratingChanges: [{ agent: 0, before: 1000, after: 1000 }] })).toEqual([{ name: "owner/agent", badges: [], text: "Rating 1000 → 1000 (0)" }]);
  });
  it("shows every rating, before, after and change as a whole number whose change adds up", () => {
    const rated = { ...player, identity: { displayName: "owner/agent", elo: 1577.27 } };
    expect(playerLabel(0, rated)).toBe("owner/agent · Rating 1577");
    // Raw change -42.5 would round to -42; the shown change is between the shown numbers.
    const changes = [{ agent: 0, before: 1530.5, after: 1488 }, { agent: 0, before: 1500.4, after: 1500.6 }];
    expect(ratingResultRows(true, [rated], { ...result, ratingChanges: changes }).map(r => r.text))
      .toEqual(["Rating 1531 → 1488 (-43)", "Rating 1500 → 1501 (+1)"]);
  });
});
