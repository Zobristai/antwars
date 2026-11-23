import { afterEach, describe, expect, it, vi } from "vitest";
import { C } from "../../../web/src/leaderboard-page/copy.ts";
import { dom, type ElementPort } from "./dom.ts";
import { leaderboardCards } from "./archive.ts";

/**
 * Retired house models on the Leaderboard: every ranking card leaves them out when the page opens, and numbers the rows
 * it shows 1, 2, 3 without gaps. Each card's "Show retired" switch brings them back exactly as they were, with their
 * stored ratings and RETIRED badges; the switch is off on every page load and never stored.
 */
const ENTRIES = [
  { displayName: "antwars/claude-opus-5-5", rating: 1712.4, rd: 61, ratedMatches: 40, thinkingLevel: "high", benchmark: true },
  { displayName: "antwars/claude-fable-5-1", rating: 1698.6, rd: 75, ratedMatches: 31, thinkingLevel: "max", benchmark: true },
  { displayName: "kite/scout", rating: 1650, rd: 90, ratedMatches: 12, thinkingLevel: "low", benchmark: false },
  { displayName: "antwars/qwen4-max-high", rating: 1630, rd: 70, ratedMatches: 20, thinkingLevel: "high", benchmark: true },
  // A builder's model is never retired, whatever its name.
  { displayName: "kite/claude-fable-5-1", rating: 1620, rd: 88, ratedMatches: 9, benchmark: false },
  { displayName: "antwars/claude-fable-5-2", rating: 1601.2, rd: 80, ratedMatches: 8, thinkingLevel: "max", benchmark: true },
  { displayName: "antwars/qwen4-max-low", rating: 1590, rd: 72, ratedMatches: 18, thinkingLevel: "low", benchmark: true },
];
const ALL_RETIRED = [
  { displayName: "antwars/qwen4-max-xhigh", rating: 1580, rd: 70, ratedMatches: 15, thinkingLevel: "xhigh", benchmark: true },
  { displayName: "antwars/gpt-6-2-astra-max", rating: 1570, rd: 70, ratedMatches: 15, thinkingLevel: "max", serviceTier: "fast", benchmark: true },
];

/** The Leaderboard page on a fresh module graph; every read is answered with `entries`. */
async function open(entries: readonly object[] = ENTRIES, search = "") {
  const { mountLeaderboardPage } = await import("../../../web/src/leaderboard-page/page.ts");
  const request = vi.fn(async () => new Response(JSON.stringify({ entries })));
  const port = dom({ search, meta: { "antwar-public-matches": "true" } });
  const dispose = mountLeaderboardPage(port.doc, port.win, { request });
  const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
  const settled = () => vi.waitFor(() => expect(leaderboardCards(root).length > 0 && leaderboardCards(root).every(card => card.busy === "false")).toBe(true));
  await settled();
  const switches = () => root.all().filter(node => node.tag === "input" && node.getAttribute("role") === "switch");
  const turn = async (input: ElementPort, on: boolean) => {
    input.focus();
    (input as unknown as { checked: boolean }).checked = on;
    input.fire("change");
  };
  const choose = async (label: string) => {
    root.all().find(node => node.tag === "button" && node.getAttribute("aria-label") === label)!.click();
    await settled();
  };
  return { port, root, dispose, switches, turn, choose, cards: () => leaderboardCards(root) };
}

afterEach(() => {
  vi.doUnmock("../../../src/rating/houseLabels.ts");
  vi.resetModules();
});

describe("retired models on the Leaderboard", () => {
  it("leaves retired house rows out when the page opens, numbering the shown rows 1, 2, 3 without gaps and counting only them", async () => {
    vi.resetModules();
    const p = await open();
    const card = p.cards()[0]!;
    expect(card.names).toEqual(["Claude Opus 5.5", "kite/scout", "kite/claude-fable-5-1", "Claude Fable 5.2", "Qwen4 Max"]);
    expect(card.cells.map(row => row[0])).toEqual(["1", "2", "3", "4", "5"]);
    expect(card.count).toBe("5 shown");
    expect(card.named.some(name => name.includes("[retired]"))).toBe(false);
    p.dispose();
  });

  it("draws one small Show retired switch on the card, off, a keyboard-reachable checkbox told apart by its card's title", async () => {
    vi.resetModules();
    const p = await open();
    const [input, ...others] = p.switches();
    expect(others).toEqual([]);
    expect(input!.type).toBe("checkbox");
    expect((input as unknown as { checked: boolean }).checked).toBe(false);
    expect(input!.tabIndex).toBe(0);
    expect(input!.getAttribute("aria-describedby")).toBe(p.cards()[0]!.section.getAttribute("aria-labelledby"));
    const label = input!.parent!;
    expect([label.tag, label.className, label.textContent]).toEqual(["label", "d1p-switch", C.showRetired]);
    // In the card's head, beside its title.
    expect(label.parent!.className).toBe("d1p-card-head");
    p.dispose();
  });

  it("turned on, shows exactly the rows, ranks and ratings the server sent, the retired ones badged; turned off, hides them again", async () => {
    vi.resetModules();
    const p = await open();
    await p.turn(p.switches()[0]!, true);
    const on = p.cards()[0]!;
    expect(on.names).toEqual(["Claude Opus 5.5", "Claude Fable 5.1", "kite/scout", "Qwen4 Max", "kite/claude-fable-5-1", "Claude Fable 5.2", "Qwen4 Max"]);
    expect(on.cells.map(row => row[0])).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(on.count).toBe("7 shown");
    expect(on.named.filter(name => name.includes("[retired]"))).toEqual(["Claude Fable 5.1 [max] [retired]", "Qwen4 Max [high] [retired]"]);
    // Focus stays on the switch through the redraw, and it reads on.
    const after = p.switches()[0]!;
    expect((p.port.doc.activeElement as unknown as ElementPort)).toBe(after);
    expect((after as unknown as { checked: boolean }).checked).toBe(true);

    // With the switch on, the card is the card with no handle retired, only the badges differing.
    vi.resetModules();
    vi.doMock("../../../src/rating/houseLabels.ts", async original => ({
      ...await original<typeof import("../../../src/rating/houseLabels.ts")>(),
      RETIRED_HOUSE_HANDLES: new Set<string>(),
      isRetiredHouse: () => false,
    }));
    const none = await open();
    const plain = none.cards()[0]!;
    const others = (cells: readonly (readonly string[])[]) => cells.map(row => row.filter((_, i) => i !== 1));
    expect(others(on.cells)).toEqual(others(plain.cells));
    expect(on.names).toEqual(plain.names);
    none.dispose();

    await p.turn(after, false);
    expect(p.cards()[0]!.names).toEqual(["Claude Opus 5.5", "kite/scout", "kite/claude-fable-5-1", "Claude Fable 5.2", "Qwen4 Max"]);
    p.dispose();
  });

  it("keeps each card's setting while the page stays open, across sizes, and opens off again on the next page load", async () => {
    vi.resetModules();
    const p = await open();
    await p.turn(p.switches()[0]!, true);
    await p.choose("Antwars Model Index 2v2");
    expect((p.switches()[0] as unknown as { checked: boolean }).checked).toBe(true);
    expect(p.cards()[0]!.names).toHaveLength(7);

    // The Ranked board: two cards, each with its own switch, both off until turned.
    await p.choose("Ranked 1v1");
    expect(p.cards().map(card => card.names.length)).toEqual([5, 5]);
    expect(p.switches().map(input => (input as unknown as { checked: boolean }).checked)).toEqual([false, false]);
    await p.turn(p.switches()[1]!, true);
    expect(p.cards().map(card => card.names.length)).toEqual([5, 7]);
    await p.choose("Ranked 2v2");
    expect(p.cards().map(card => card.names.length)).toEqual([5, 7]);
    p.dispose();

    const again = await open();
    expect((again.switches()[0] as unknown as { checked: boolean }).checked).toBe(false);
    expect(again.cards()[0]!.names).toHaveLength(5);
    again.dispose();
  });

  it("says so when every loaded row is retired, with the switch beside it", async () => {
    vi.resetModules();
    const p = await open(ALL_RETIRED);
    const card = p.cards()[0]!;
    expect([card.names, card.count, card.state]).toEqual([[], null, C.onlyRetired]);
    await p.turn(p.switches()[0]!, true);
    expect(p.cards()[0]!.names).toEqual(["Qwen4 Max", "GPT-6.2 Astra"]);
    p.dispose();
  });

  it("hides retired gpt-6-astra behind Show retired and reveals its rating and badges when switched on", async () => {
    vi.resetModules();
    const p = await open([
      { displayName: "antwars/claude-opus-5-5", rating: 1712.4, rd: 61, ratedMatches: 40, thinkingLevel: "high", benchmark: true },
      { displayName: "antwars/gpt-6-astra", rating: 1693, rd: 68, ratedMatches: 25, thinkingLevel: "max", serviceTier: "fast", benchmark: true },
      { displayName: "antwars/gpt-6-luna", rating: 1650, rd: 70, ratedMatches: 20, thinkingLevel: "max", serviceTier: "fast", benchmark: true },
    ]);
    const hidden = p.cards()[0]!;
    expect(hidden.names).toEqual(["Claude Opus 5.5", "GPT-6 Luna"]);
    expect(hidden.cells.map(row => row[0])).toEqual(["1", "2"]);
    expect(hidden.count).toBe("2 shown");
    await p.turn(p.switches()[0]!, true);
    const shown = p.cards()[0]!;
    expect(shown.names).toEqual(["Claude Opus 5.5", "GPT-6 Astra", "GPT-6 Luna"]);
    expect(shown.named[1]).toBe("GPT-6 Astra [max] [Fast] [retired]");
    expect([shown.cells[1]![0], shown.cells[1]![2], shown.cells[1]![3]]).toEqual(["2", "1693 ± 68", "25"]);
    expect(shown.count).toBe("3 shown");
    p.dispose();
  });
});
