import { describe, expect, it, vi } from "vitest";
import { readLeaderboard } from "../../web/src/leaderboard.ts";
import { benchmarkLabel } from "../../web/src/leaderboard-page/view.ts";
import { mountLeaderboardPage } from "../../web/src/leaderboard-page/page.ts";
import { dom } from "./pages/dom.ts";
import { leaderboardCards } from "./pages/archive.ts";

const entry = { displayName: "antwars/model", rating: 1516, ratedMatches: 7 };
/** The Leaderboard page (Archive) on its opening Antwars Model Index board, served these raw pages in turn. */
function shown(pages: unknown[]) {
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { cursor } = JSON.parse(String(init!.body)) as { cursor?: string };
    const at = cursor === undefined ? 0 : Number(cursor);
    return new Response(JSON.stringify({ ...(pages[at] as object), ...(at + 1 < pages.length ? { next: String(at + 1) } : {}) }));
  });
  const port = dom({ meta: { "antwar-public-matches": "true" } });
  const dispose = mountLeaderboardPage(port.doc, port.win, { request });
  const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
  return { request, root, dispose, card: () => leaderboardCards(root)[0]! };
}

describe("Model Index thinking levels", () => {
  it("preserves the API's nullable level, accepts old responses and rejects malformed metadata without losing numeric values", () => {
    for (const thinkingLevel of ["max", "custom level", "🧠".repeat(32), null]) {
      expect(readLeaderboard({ entries: [{ ...entry, rd: null, thinkingLevel, identityId: "private" }] })).toEqual({ entries: [{ ...entry, rd: null, thinkingLevel, serviceTier: null, benchmark: false, tally: null, form: [] }] });
    }
    expect(readLeaderboard({ entries: [entry] })).toEqual({ entries: [{ ...entry, rd: null, thinkingLevel: null, serviceTier: null, benchmark: false, tally: null, form: [] }] });
    for (const thinkingLevel of [42, false, {}, [], "", "x".repeat(33)]) {
      expect(readLeaderboard({ entries: [{ ...entry, rd: null, thinkingLevel }] })).toBeNull();
    }
  });

  it("shows builder rows as the handle only, whatever level they carry, as safe text on every paginated row, retaining Elo/count cells", async () => {
    const untrusted = "<img src=x onerror=alert(1)>";
    const p = shown([
      { entries: [{ ...entry, rd: null, thinkingLevel: "max" }, { ...entry, rd: null, thinkingLevel: null }, { ...entry, rd: null, displayName: "<script>alert(1)</script>", thinkingLevel: untrusted }] },
      { entries: [{ ...entry, rd: null, displayName: "older-row" }] },
    ]);
    await vi.waitFor(() => expect(p.card().names).toHaveLength(3));
    const head = p.card().table!.querySelector("thead")!.querySelectorAll("th");
    expect(head.map(cell => cell.textContent)).toEqual(["#Rank", "Name", "Rating", "Rated matches", "Record", "Last 5"]);
    expect(head.every(cell => cell.scope === "col")).toBe(true);
    // Rank, the handle alone (no level, no "(not recorded)"), Elo
    // (provisional below 10 rated matches), rated matches, Record, Last 5.
    expect(p.card().named).toEqual([entry.displayName, entry.displayName, "<script>alert(1)</script>"]);
    expect(p.root.textContent).not.toContain(untrusted);
    expect(p.card().cells.map(cells => cells.slice(2))).toEqual(Array(3).fill(["1516, provisional", "7", "", ""]));
    expect(p.root.all().some(node => node.html.includes("alert"))).toBe(false);
    p.card().more!.click();
    await vi.waitFor(() => expect(p.card().names).toHaveLength(4));
    expect(p.request.mock.calls.map(call => JSON.parse(String(call[1]!.body)).cursor)).toEqual([undefined, "1"]);
    expect(p.card().named[3]).toBe("older-row");
    expect(p.card().cells.every(cells => cells.length === 6)).toBe(true);
    p.dispose();
  });
});

describe("Benchmark model names and badges", () => {
  it("validates the tier and Benchmark flag, defaulting both for old responses", () => {
    expect(readLeaderboard({ entries: [{ ...entry, rd: null, serviceTier: "fast", benchmark: true, tally: null, form: [] }] }))
      .toEqual({ entries: [{ ...entry, rd: null, thinkingLevel: null, serviceTier: "fast", benchmark: true, tally: null, form: [] }] });
    for (const bad of [{ serviceTier: "" }, { serviceTier: 1 }, { serviceTier: "x".repeat(33) }, { benchmark: "true" }, { benchmark: 1 }]) {
      expect(readLeaderboard({ entries: [{ ...entry, rd: null, ...bad }] })).toBeNull();
    }
  });

  it.each([
    ["antwars/claude-opus-5-5", "high", null, "Claude Opus 5.5", ["high"]],
    ["antwars/claude-opus-5-5-xhigh", "xhigh", null, "Claude Opus 5.5", ["xhigh"]],
    ["antwars/gpt-6-1-sol-high-fast", "high", "fast", "GPT-6.1 Sol", ["high", "Fast"]],
    ["antwars/gpt-6-astra", "max", "fast", "GPT-6 Astra", ["max", "Fast"]],
    ["antwars/gpt-6-astra", "max", "Fast", "GPT-6 Astra", ["max", "Fast"]],
    ["antwars/gpt-6-1-sol-high", "high", "standard", "GPT-6.1 Sol", ["high"]],
    ["antwars/gpt-6-astra", "max", "ultrafast", "GPT-6 Astra", ["max"]],
    ["antwars/Qwen3-8-Max", "xhigh", null, "Qwen3.8 Max", ["xhigh"]],
    ["antwars/grok-composer-2-5-fast", null, null, "Grok Composer 2.5 Fast", []],
    // An unlisted handle shows "Unlisted model", never its slug.
    ["antwars/unlisted-model", null, null, "Unlisted model", []],
    ["antwars", null, null, "Unlisted model", []],
  ] as const)("%s at %s on %s shows %s with badges %j", (displayName, thinkingLevel, serviceTier, name, badges) => {
    expect(benchmarkLabel({ displayName, thinkingLevel, serviceTier })).toEqual({ name, badges });
  });

  it("renders Benchmark rows as a display name with text badges and other rows as the handle only", async () => {
    const p = shown([{ entries: [
      { displayName: "antwars/gpt-6-astra", rating: 1600, ratedMatches: 4, thinkingLevel: "max", serviceTier: "fast", benchmark: true },
      { displayName: "antwars/claude-opus-5-5", rating: 1550, ratedMatches: 3, thinkingLevel: "high", benchmark: true },
      { displayName: "antwars/gemini-3-1-pro-preview", rating: 1520, ratedMatches: 1, benchmark: true },
      { displayName: "antwars/lookalike", rating: 1500, ratedMatches: 2, thinkingLevel: "high", serviceTier: "fast", benchmark: false },
      { displayName: "kite/gpt-6-1-sol", rating: 1490, ratedMatches: 2, thinkingLevel: "low", serviceTier: "fast", benchmark: false },
      { displayName: "owner/agent", rating: 1450, ratedMatches: 1 },
    ] }]);
    await vi.waitFor(() => expect(p.card().names).toHaveLength(6));
    // A Benchmark name cell holds the name, then one text badge per level and Fast; other rows show the handle only.
    expect(p.card().named).toEqual([
      "GPT-6 Astra [max] [Fast]",
      "Claude Opus 5.5 [high]",
      "Gemini 3.1 Pro Preview",
      "antwars/lookalike",
      "kite/gpt-6-1-sol",
      "owner/agent",
    ]);
    expect(p.card().cells.map(cells => cells.slice(2, 4))).toEqual([["1600, provisional", "4"], ["1550, provisional", "3"], ["1520, provisional", "1"], ["1500, provisional", "2"], ["1490, provisional", "2"], ["1450, provisional", "1"]]);
    const first = p.card().table!.querySelector("tbody")!.children[0]!.children[1]!;
    expect(first.children.map(part => part.className)).toEqual(["", "d1p-tags"]);
    expect(first.children[1]!.children.map(part => part.className)).toEqual(["d1p-tag", "d1p-tag"]);
    p.dispose();
  });
});
