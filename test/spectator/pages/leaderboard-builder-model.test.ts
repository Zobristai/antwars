// A Leaderboard builder row's player line: username, then the model, level and Fast of its latest rated match, as a Matches
// player line reads them; house rows, columns and the stacked rows' order unchanged. Not rendering evidence.
import { describe, expect, it } from "vitest";
import { readLeaderboard, type LeaderboardRow } from "../../../web/src/leaderboard.ts";
import type { RankingView } from "../../../web/src/leaderboard-page/view.ts";
import { rankingCard } from "../../../web/src/pages/leaderboard.ts";
import { dom, type ElementPort } from "./dom.ts";
import { leaderboardCards, nameText } from "./archive.ts";

const base = { rating: 1540, rd: 80, ratedMatches: 12, tally: { wins: 8, losses: 4, draws: 0 }, form: [] } as const;
const rows: LeaderboardRow[] = [
  { ...base, displayName: "antwars/gpt-6-1-terra-max-fast", thinkingLevel: "max", serviceTier: "fast", benchmark: true },
  { ...base, displayName: "coffee-ant", thinkingLevel: "high", serviceTier: "fast", benchmark: false, model: "openai/gpt-6.1-terra" },
  { ...base, displayName: "coffeebot-ant", thinkingLevel: "high", serviceTier: "fast", benchmark: false },
  { ...base, displayName: "omp-dolphin", thinkingLevel: "high", serviceTier: null, benchmark: false, model: "omp-dolphin/local" },
];

function card(entries: readonly LeaderboardRow[]) {
  const port = dom();
  const table: RankingView = { id: "aw-everyone-ranking", title: "Ranked", status: "ready", rows: entries, next: undefined };
  const section = rankingCard(port.doc, table, "1v1", { search: "" }) as unknown as ElementPort;
  port.body.append(section);
  return { section, port, card: leaderboardCards(port.body)[0]! };
}
/** The stacked rows' name lines, read as nameText reads a cell. */
const stacked = (section: ElementPort) => section.byClass("d1p-lb-rows")[0]!.children.map(item => nameText(item.byClass("is-lead")[0]!));

describe("a builder row's model on the Leaderboard", () => {
  it("reads username, model, level and Fast after it; a builder with no model, or one only repeating its handle, shows its username alone", () => {
    const { card: shown, section } = card(rows);
    const lines = [shown.named, stacked(section)];
    for (const named of lines) {
      expect(named[1]).toBe("coffee-ant GPT-6.1 Terra [high] [Fast]");
      expect(named[2]).toBe("coffeebot-ant");
      expect(named[3]).toBe("omp-dolphin");
    }
    // The model is its own regular-weight span inside the name, after the username, before the badges.
    const builder = shown.table!.querySelector("tbody")!.children[1]!.children[1]!;
    expect(builder.children.map(part => part.className)).toEqual(["", "d1p-tags"]);
    expect(builder.children[0]!.children.filter(part => part.tag !== "#text").map(part => [part.className, part.textContent])).toEqual([["d1p-mname", "GPT-6.1 Terra"]]);
  });

  it("leaves house rows, every column and head, the row order and the stacked layout as they were", () => {
    const without = card(rows.map(({ model: _model, ...row }) => row));
    const withModel = card(rows);
    expect(withModel.card.named[0]).toBe(without.card.named[0]);
    expect(withModel.card.names.slice(2)).toEqual(without.card.names.slice(2));
    const heads = (c: ReturnType<typeof card>) => c.card.table!.querySelector("thead")!.textContent;
    expect(heads(withModel)).toBe(heads(without));
    // Every cell but the builder's name is the same.
    expect(withModel.card.cells.map((cells, index) => index === 1 ? [...cells.slice(0, 1), ...cells.slice(2)] : cells))
      .toEqual(without.card.cells.map((cells, index) => index === 1 ? [...cells.slice(0, 1), ...cells.slice(2)] : cells));
    const item = (c: ReturnType<typeof card>) => c.section.byClass("d1p-lb-rows")[0]!.children[1]!.children.map(part => part.className);
    expect(item(withModel)).toEqual(item(without));
  });

  it("shows a model label with nothing after its provider prefix whole, never as no model", () => {
    const { card: shown } = card([{ ...rows[1]!, model: "local/" }]);
    expect(shown.named[0]).toBe("coffee-ant local/ [high] [Fast]");
    // Only whitespace after the prefix is nothing too.
    const spaced = card([{ ...rows[1]!, model: "local/ " }]).section.byClass("d1p-mname")[0]!;
    expect(spaced.textContent).toBe("local/ ");
  });

  it("a house row never shows a model, even one a server sent", () => {
    const { card: shown } = card([{ ...rows[0]!, model: "lab/other" }]);
    expect(shown.named[0]).toBe(card([rows[0]!]).card.named[0]);
  });
});

describe("the leaderboard reader's model", () => {
  const page = (model: unknown) => ({ entries: [{ displayName: "coffee-ant", rating: 1500, ratedMatches: 1, model }] });
  it("keeps a model label, reads a missing or null one as none, and refuses any other value", () => {
    expect(readLeaderboard(page("openai/gpt-6.1-terra"))!.entries[0]!.model).toBe("openai/gpt-6.1-terra");
    expect(readLeaderboard(page(null))!.entries[0]).not.toHaveProperty("model");
    expect(readLeaderboard({ entries: [{ displayName: "coffee-ant", rating: 1500, ratedMatches: 1 }] })!.entries[0]).not.toHaveProperty("model");
    for (const bad of ["", "x".repeat(257), 7, {}]) expect(readLeaderboard(page(bad))).toBeNull();
  });
});
