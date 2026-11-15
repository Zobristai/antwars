import { afterEach, describe, expect, it, vi } from "vitest";
import { dom } from "./dom.ts";
import { leaderboardCards } from "./archive.ts";

/**
 * The retired mark only adds a badge: on the Leaderboard a retired house model keeps its row, its rank and its stored
 * rating, in the order the server sent them, exactly as it would with no handle retired.
 */
const ENTRIES = [
  { displayName: "antwars/claude-opus-5-5", rating: 1712.4, rd: 61, ratedMatches: 40, thinkingLevel: "high", benchmark: true },
  { displayName: "antwars/claude-fable-5-1", rating: 1698.6, rd: 75, ratedMatches: 31, thinkingLevel: "max", benchmark: true },
  { displayName: "kite/scout", rating: 1650, rd: 90, ratedMatches: 12, thinkingLevel: "low", benchmark: false },
  { displayName: "antwars/claude-fable-5-2", rating: 1601.2, rd: 80, ratedMatches: 8, thinkingLevel: "max", benchmark: true },
];

/** The first table of the Leaderboard page, from a fresh module graph, served ENTRIES. */
async function render() {
  const { mountLeaderboardPage } = await import("../../../web/src/leaderboard-page/page.ts");
  const request = vi.fn(async () => new Response(JSON.stringify({ entries: ENTRIES })));
  const port = dom({ meta: { "antwar-public-matches": "true" } });
  const dispose = mountLeaderboardPage(port.doc, port.win, { request });
  const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
  await vi.waitFor(() => expect(leaderboardCards(root)[0]?.names).toHaveLength(ENTRIES.length));
  const card = leaderboardCards(root)[0]!;
  const shown = { names: card.names, named: card.named, cells: card.cells };
  dispose();
  return shown;
}

afterEach(() => {
  vi.doUnmock("../../../src/rating/houseLabels.ts");
  vi.resetModules();
});

describe("a retired model on the Leaderboard", () => {
  it("keeps every row, its rank, order and rating with or without the retired set; only the badge differs", async () => {
    vi.resetModules();
    const withRetired = await render();
    vi.resetModules();
    vi.doMock("../../../src/rating/houseLabels.ts", async original => ({
      ...await original<typeof import("../../../src/rating/houseLabels.ts")>(),
      RETIRED_HOUSE_HANDLES: new Set<string>(),
      isRetiredHouse: () => false,
    }));
    const withoutRetired = await render();

    expect(withRetired.names).toEqual(["Claude Opus 5.5", "Claude Fable 5.1", "kite/scout", "Claude Fable 5.2"]);
    expect(withRetired.names).toEqual(withoutRetired.names);
    // Every cell but the name, rank and rating included, is identical.
    const others = (cells: readonly (readonly string[])[]) => cells.map(row => row.filter((_, i) => i !== 1));
    expect(others(withRetired.cells)).toEqual(others(withoutRetired.cells));
    expect(withRetired.cells.map(row => row[2])).toEqual(withoutRetired.cells.map(row => row[2]));
    expect(withRetired.named).toEqual([
      "Claude Opus 5.5 [high]", "Claude Fable 5.1 [max] [retired]", "kite/scout", "Claude Fable 5.2 [max]",
    ]);
    expect(withoutRetired.named).toEqual([
      "Claude Opus 5.5 [high]", "Claude Fable 5.1 [max]", "kite/scout", "Claude Fable 5.2 [max]",
    ]);
  });
});
