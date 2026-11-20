// The render check's rules (web/render-check/rules.ts) on small pages in Chromium: each rule fails on a page
// that breaks it and passes on the same page laid out correctly. Fixed fonts (monospace) keep widths predictable.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { RULE_LIMITS, judgePage, type PageJudgement, type RuleId } from "../../web/render-check/rules.ts";
import { heldFrom, judge, type HeldList, type Render } from "../../web/render-check/report.ts";
import type { Finding } from "../../web/render-check/rules.ts";
import { RESULTS_KEY } from "../../web/src/pages/top-matches.ts";
import { SURFACES, boardProblem, boardReadiness, playRecording, type BoardReadiness, type Playback } from "../../web/render-check/check.ts";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

const BASE = "<style>body{margin:0;font:16px/20px monospace} p{margin:0} .tile{border:1px solid #888;padding:4px} .grid{display:grid;grid-template-columns:repeat(2,150px);gap:8px}</style>";

async function judged(body: string, width = 400): Promise<PageJudgement> {
  const page = await browser.newPage({ viewport: { width, height: 600 } });
  try {
    await page.setContent(`<!doctype html><html><head>${BASE}</head><body>${body}</body></html>`);
    return await page.evaluate(judgePage, RULE_LIMITS);
  } finally { await page.close(); }
}
const rules = (j: PageJudgement): RuleId[] => j.failures.map(f => f.rule);

describe("render check rules", () => {
  it("fails a one-line item that wraps, but not prose", async () => {
    expect(rules(await judged('<div style="width:100px"><span>Riverbank GPT-6.1 Sol</span></div>'))).toContain("wrap");
    expect(rules(await judged('<div style="width:300px"><span>Riverbank GPT-6.1 Sol</span></div>'))).not.toContain("wrap");
    expect(rules(await judged('<p style="width:100px">A sentence that wraps over lines.</p>'))).not.toContain("wrap");
  });

  it("fails a card's state line that wraps: it is a paragraph, but a one-line item", async () => {
    // As web/src/pages/chrome.ts stateLine builds it: a glyph, then the words, in a p with role status.
    const state = (width: number, words: string) => `<div style="width:${width}px"><p class="d1p-state" role="status" style="display:flex;gap:8px;min-width:0">`
      + `<span class="d1p-glyph" aria-hidden="true" style="flex:none;width:8px;height:8px"></span><span>${words}</span></p></div>`;
    const wrapped = (await judged(state(140, "Loaded 2 minutes ago from the archive"))).failures.filter(f => f.rule === "wrap");
    expect(wrapped.map(f => f.element)).toEqual([expect.stringContaining("p.d1p-state")]);
    expect(wrapped[0]!.text).toBe("Loaded 2 minutes ago from the archive");
    expect(rules(await judged(state(400, "Loaded 2 minutes ago")))).not.toContain("wrap");
    // Beside running text it is still one line, and the other paragraph stays prose.
    expect(rules(await judged(`<section><p style="width:100px">Running text that wraps here.</p>${state(140, "Loaded 2 minutes ago from the archive")}</section>`))
      .filter(r => r === "wrap")).toHaveLength(1);
  });

  it("fails a label or a table heading that wraps, inside prose too, or broken by hand", async () => {
    expect(rules(await judged('<p>Show <label style="display:inline-block;width:60px">Rated matches</label> only.</p>', 390))).toContain("wrap");
    expect(rules(await judged('<label style="display:block;width:300px">Rated<br>Matches</label>', 390))).toContain("wrap");
    expect(rules(await judged('<label style="display:block;width:100px">Show rated matches</label>', 390))).toContain("wrap");
    expect(rules(await judged('<label style="display:block;width:300px">Show rated matches</label>', 390))).not.toContain("wrap");
    const table = (w: number) => `<table style="width:${w}px;border-collapse:collapse"><thead><tr><th>Rated matches</th><th>Win rate</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`;
    expect(rules(await judged(table(120), 390))).toContain("wrap");
    expect(rules(await judged(table(360), 390))).not.toContain("wrap");
  });

  it("fails a button inside a paragraph, or a long label, that wraps, whatever its length or place", async () => {
    expect(rules(await judged('<p>Then <button style="width:80px">Bring your agent</button> to play.</p>', 390))).toContain("wrap");
    expect(rules(await judged('<p>Then <button>Go</button> to play.</p>', 390))).not.toContain("wrap");
    const long = "Show only the rated matches of the agents you follow, newest first, with their levels";
    expect(rules(await judged(`<label style="display:block;width:200px">${long}</label>`, 390))).toContain("wrap");
    expect(rules(await judged(`<button style="width:200px">${long}</button>`, 390))).toContain("wrap");
  });

  it("fails a row of icon-only items that wraps (a colony's seat badges), even as controls allowed to wrap", async () => {
    // As the Score Band builds grouped seats: buttons holding only a glyph, in a row that may wrap.
    const svg = '<svg width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
    const seats = (width: number) => `<div style="display:flex;align-items:center;gap:7px"><h2 style="margin:0;font-size:15px">Lake Hodges</h2>`
      + `<span class="d1-team-members" style="display:inline-flex;flex-wrap:wrap;gap:4px;width:${width}px">`
      + `<button aria-label="seat 1" style="display:inline-flex;padding:0;border:0">${svg}</button>`
      + `<button aria-label="seat 2" style="display:inline-flex;padding:0;border:0">${svg}</button></span></div>`;
    const wrapped = (await judged(seats(24))).failures.filter(f => f.rule === "wrap");
    expect(wrapped.map(f => f.element)).toEqual([expect.stringContaining("span.d1-team-members")]);
    expect(wrapped[0]!.extent).toBe(2);
    expect(rules(await judged(seats(60)))).not.toContain("wrap");
    // Buttons with text allowed to wrap are still a set of controls, not a line.
    const words = `<div style="display:flex;flex-wrap:wrap;width:120px;gap:4px"><button>Matches</button><button>Leaderboard</button><button>Rules</button></div>`;
    expect(rules(await judged(words))).not.toContain("wrap");
  });

  it("fails a badge that wraps inside a paragraph, by its own drawn box, but not the paragraph's wrapping prose", async () => {
    const tag = (style: string, words: string) => `<span style="padding:0 5px;border-radius:3px;${style}">${words}</span>`;
    const block = tag("display:inline-block;width:50px;background:#333", "Free for all");
    const pill = tag("display:inline-flex;width:50px;border:1px solid #888", "Free for all");
    const inline = tag("background:#333", "Free for all");
    for (const badge of [block, pill]) {
      const wrapped = (await judged(`<p style="width:300px">Strait, four colonies ${badge} ended.</p>`, 390)).failures.filter(f => f.rule === "wrap");
      expect(wrapped.map(f => f.text)).toEqual(["Free for all"]);
    }
    // An inline badge broken across the paragraph's lines.
    expect(rules(await judged(`<p style="width:150px">Strait, four colonies, ${inline} ended.</p>`, 390))).toContain("wrap");
    // The paragraph itself wraps, its badge on one line: prose, not a defect.
    expect(rules(await judged(`<p style="width:150px">A sentence that wraps over lines ${tag("background:#333", "Rated")} and on.</p>`, 390))).not.toContain("wrap");
    expect(rules(await judged('<p style="width:100px">A sentence that wraps over lines, with <a href="#">a link</a> and <em>emphasis</em>.</p>', 390))).not.toContain("wrap");
  });

  it("does not count a tooltip positioned out of a badge's line, and judges a stacked heading block by block", async () => {
    const tip = (open: boolean) => `<p>Rating <button style="position:relative">1995<span style="position:absolute;left:0;bottom:120%;white-space:nowrap${open ? "" : ";width:1px;height:1px;overflow:hidden;clip-path:inset(50%)"}"> ± 107</span></button></p>`;
    expect(rules(await judged(tip(false), 390))).not.toContain("wrap");
    expect(rules(await judged(`<div style="height:60px"></div>${tip(true)}`, 390))).not.toContain("wrap");
    const start = (w: number) => `<table style="border-collapse:collapse"><tbody><tr><th style="width:${w}px;text-align:left"><span style="display:block">18 Nov 2026</span><span style="display:block">13:44 UTC</span></th><td>Ranked</td></tr></tbody></table>`;
    expect(rules(await judged(start(140), 390))).not.toContain("wrap");
    // Each stacked block is still one line: one broken onto two fails.
    expect(rules(await judged(start(50), 390))).toContain("wrap");
  });

  it("fails text cut by an overflow box or an ellipsis", async () => {
    const clipped = await judged('<div style="width:80px;overflow:hidden;white-space:nowrap"><span>A long colony name</span></div>');
    expect(rules(clipped).some(r => r === "clipped" || r === "cut")).toBe(true);
    const ellipsis = await judged('<div style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long colony name</div>');
    expect(rules(ellipsis).some(r => r === "clipped" || r === "cut")).toBe(true);
    const fits = await judged('<div style="width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long colony name</div>');
    expect(rules(fits)).toEqual([]);
  });

  it("fails text cut by its own box, and an image or control cut by its container, but not an image cropped within its box", async () => {
    expect(rules(await judged('<div style="width:80px;white-space:nowrap;overflow:hidden">A long colony name</div>', 390))).toContain("clipped");
    expect(rules(await judged('<div style="width:80px;overflow:hidden"><img style="display:block;margin-left:40px;width:60px;height:20px" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>'))).toContain("clipped");
    expect(rules(await judged('<div style="width:80px;overflow:hidden"><button style="width:120px">Go</button></div>'))).toContain("clipped");
    expect(rules(await judged('<div style="width:80px;overflow:hidden"><img style="display:block;width:160px;height:20px" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>', 390))).toContain("clipped");
    expect(rules(await judged('<p>Top</p><div style="width:200px;height:40px;overflow:hidden"><img style="display:block;width:200px;height:40px;object-fit:cover" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>'))).not.toContain("clipped");
    // Each axis on its own: a box that scrolls sideways still cuts what overflows it vertically.
    expect(rules(await judged('<div style="width:150px;height:8px;white-space:nowrap;overflow-x:auto;overflow-y:hidden">Rated matches</div>', 390))).toContain("clipped");
  });

  it("does not fail content the reader can scroll to inside a box that clips, but fails the scroller cut by that box", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `<div>Row ${i + 1}</div>`).join("");
    const panel = (scrollerHeight: number) => `<div style="height:200px;overflow:hidden"><div style="height:${scrollerHeight}px;overflow-y:auto">${rows}</div></div>`;
    expect(rules(await judged(panel(150), 390))).toEqual([]);
    expect(rules(await judged(panel(300), 390))).toContain("clipped");
    const wide = '<div style="width:200px;overflow:hidden"><div style="overflow-x:auto;white-space:nowrap">A long row of colony names that scrolls sideways</div></div>';
    expect(rules(await judged(wide, 390))).not.toContain("clipped");
  });

  it("measures how far a finding breaks its rule", async () => {
    const cut = (w: number) => judged(`<div style="width:${w}px;white-space:nowrap;overflow:hidden">A long colony name</div>`, 390);
    const [a, b] = [await cut(120), await cut(60)];
    expect(b.failures[0]!.extent).toBeGreaterThan(a.failures[0]!.extent + 50);
  });

  it("ignores visually hidden screen-reader text", async () => {
    const sr = '<div style="width:80px;overflow:hidden"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">A long hidden label for readers</span><span>Shown</span></div>';
    expect(rules(await judged(sr))).toEqual([]);
  });

  it("fails text off the viewport's side, sideways scrolling and a page wider than the viewport", async () => {
    expect(rules(await judged('<div style="margin-left:360px;white-space:nowrap">Leaderboard</div>'))).toEqual(expect.arrayContaining(["offscreen", "page-wider"]));
    expect(rules(await judged('<div style="width:200px;overflow-x:auto;white-space:nowrap">Watch Matches Leaderboard Rules Recordings</div>'))).toContain("sideways");
    expect(rules(await judged('<div style="width:380px;overflow-x:auto;white-space:nowrap">Watch Matches</div>'))).toEqual([]);
    // An image alone overflowing a box that scrolls sideways.
    const img = (w: number) => `<div style="width:80px;overflow-x:auto"><img style="display:block;width:${w}px;height:20px" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>`;
    expect(rules(await judged(img(160), 390))).toContain("sideways");
    expect(rules(await judged(img(80), 390))).toEqual([]);
  });

  it("fails tiles of unequal height and an empty band inside a tile", async () => {
    const uneven = await judged('<ol class="grid" style="align-items:start"><li class="tile"><span>One</span></li><li class="tile"><span>Two</span><br><span>lines</span></li></ol>');
    expect(rules(uneven)).toEqual(expect.arrayContaining(["row-uneven", "grid-uneven"]));
    const even = await judged('<ol class="grid"><li class="tile"><span>One</span></li><li class="tile"><span>Two</span></li></ol>');
    expect(rules(even)).toEqual([]);
    const empty = await judged('<ol class="grid"><li class="tile" style="height:120px"><span>One</span></li><li class="tile" style="height:120px"><span>Two</span></li></ol>');
    expect(rules(empty)).toContain("tile-empty");
  });

  it("judges a grid laid out in one column, as at phone width", async () => {
    const column = (a: number, b: number) => `<ol class="grid" style="grid-template-columns:1fr"><li class="tile" style="height:${a}px"><span>One</span></li><li class="tile" style="height:${b}px"><span>Two</span></li></ol>`;
    expect(rules(await judged(column(30, 50), 390))).toContain("grid-uneven");
    expect(rules(await judged(column(30, 30), 390))).toEqual([]);
    expect(rules(await judged(column(120, 120), 390))).toContain("tile-empty");
    // A card taller than the screen is still a card.
    const tall = (h: number) => `<li class="tile" style="height:${h}px"><canvas width="10" height="10" style="display:block;width:100%;height:100%"></canvas></li>`;
    expect(rules(await judged(`<ol class="grid" style="grid-template-columns:1fr">${tall(850)}${tall(50)}</ol>`, 390))).toContain("grid-uneven");
    // Cards that each hold a heading and a paragraph are still cards.
    const card = (h: number) => `<article class="tile" style="height:${h}px"><h3>Colony</h3><p>Running text.</p></article>`;
    expect(rules(await judged(`<div class="grid" style="grid-template-columns:1fr">${card(80)}${card(110)}</div>`, 390))).toContain("grid-uneven");
    // Plain reading sections, with no drawn edge or background, are not tiles.
    const section = (n: number) => `<section><h2>Part</h2>${"<p>Running text of the rules page.</p>".repeat(n)}</section>`;
    expect(rules(await judged(`<div class="grid" style="grid-template-columns:1fr">${section(2)}${section(9)}</div>`, 390))).not.toContain("grid-uneven");
  });

  it("fails a tile part shown on some tiles but not others", async () => {
    const tile = (rating: boolean) => `<li class="tile"><span class="who">Name</span>${rating ? '<span class="rating"> 1500</span>' : '<span class="x"> </span>'}</li>`;
    expect(rules(await judged(`<ol class="grid">${tile(true)}${tile(false)}</ol>`))).toContain("part-uneven");
    expect(rules(await judged(`<ol class="grid">${tile(true)}${tile(true)}</ol>`))).not.toContain("part-uneven");
  });

  it("measures a page band to a button in a box that scrolls, scrolled out of view", async () => {
    const page = (gap: number) => `<div style="height:200px;overflow-y:auto">${"<p>Line</p>".repeat(20)}<button style="display:block;height:60px">Bring your agent</button><div style="height:${gap}px"></div><p>Rules</p></div>`;
    expect(rules(await judged(page(30), 390))).not.toContain("page-empty");
    expect(rules(await judged(page(RULE_LIMITS.pageBandPx + 12), 390))).toContain("page-empty");
    // The same scroller inside a box that clips (a HUD's panel): the button still counts where the reader scrolls to it.
    const inPanel = (gap: number) => `<div style="height:300px;overflow:hidden">${page(gap)}</div>`;
    expect(rules(await judged(inPanel(30), 390))).not.toContain("page-empty");
    expect(rules(await judged(inPanel(RULE_LIMITS.pageBandPx + 12), 390))).toContain("page-empty");
  });

  it("fails an empty page band over the limit, counting a board's canvas as content", async () => {
    const band = (px: number) => `<p>Top</p><div style="height:${px}px"></div><p>Below</p>`;
    expect(rules(await judged(band(RULE_LIMITS.pageBandPx + 12)))).toContain("page-empty");
    expect(rules(await judged(band(RULE_LIMITS.pageBandPx - 20)))).not.toContain("page-empty");
    expect(rules(await judged('<p>Top</p><canvas width="300" height="300" style="display:block"></canvas><p>Below</p>'))).not.toContain("page-empty");
  });

  it("fails a keyed column cell that does not start on its head's x, and judges a hidden head's cells against each other", async () => {
    // As the Recordings list keys them: a head row and rows on one grid, each cell carrying its column's key.
    // Stacked (a phone's rows): the head hidden, each cell on its own line.
    const sub = "display:grid;grid-column:1/-1;grid-template-columns:subgrid";
    const table = (offset: number, stacked = false) => `<div data-col-table style="display:grid;grid-template-columns:120px 120px;width:240px">`
      + `<div data-col-head style="${stacked ? "display:none" : sub}"><span data-col="when">Time</span><span data-col="who">Player</span></div>`
      + `<ol style="${sub};margin:0;padding:0;list-style:none">`
      + ["alice", "bob"].map((who, i) => `<li style="${stacked ? "display:block;grid-column:1/-1" : sub}"><span data-col="when" style="display:block">0${i}:00</span>`
        + `<span data-col="who" style="display:block;padding-left:${i ? offset : 0}px">${who}</span></li>`).join("") + "</ol></div>";
    expect(rules(await judged(table(0)))).not.toContain("column-start");
    const off = (await judged(table(1))).failures.filter(f => f.rule === "column-start");
    expect(off.map(f => [f.text, f.extent])).toEqual([["bob", 1]]);
    expect(off[0]!.measure).toContain("its column head");
    // With the head hidden (a phone's stacked rows) a key's cells must still start at one x.
    expect((await judged(table(4, true))).failures.filter(f => f.rule === "column-start").map(f => [f.text, f.extent])).toEqual([["bob", 4]]);
    expect(rules(await judged(table(0, true)))).not.toContain("column-start");
  });

  it("judges a phone start line's display: contents cells by their text, failing a date that starts off its column's x", async () => {
    // As a phone's Recordings rows draw them: the head hidden, and the time and type cells display: contents inside the
    // start line, so they have no box of their own; their text is judged.
    const row = (offset: number) => `<li style="display:block;border-top:1px solid #888"><div style="display:flex;flex-wrap:wrap;column-gap:12px">`
      + `<p data-col="when" style="display:contents"><span style="margin-left:${offset}px">18 Nov</span> <span>09:12</span></p>`
      + `<p data-col="type" style="display:contents"><span>Index 1v1</span></p></div></li>`;
    const table = (offset: number) => `<div data-col-table style="width:300px"><div data-col-head style="display:none"><span data-col="when">Time</span>`
      + `<span data-col="type">Game type</span></div><ol style="display:grid;margin:0;padding:0;list-style:none">${row(0)}${row(0)}${row(offset)}</ol></div>`;
    expect(rules(await judged(table(0)))).not.toContain("column-start");
    const off = (await judged(table(6))).failures.filter(f => f.rule === "column-start");
    expect(off.map(f => [f.text, f.extent])).toEqual([["18 Nov 09:12", 6]]);
    expect(off[0]!.measure).toContain("the other cells of its column (column when)");
  });

  it("does not hold a cell continuing a line another keyed cell of its row starts, and judges such a table's rows as rows, not tiles", async () => {
    // A phone's start line: the date, then the type after it on the same line, or alone on the next where it does not fit.
    const row = (type: string) => `<li style="display:flex;flex-wrap:wrap;column-gap:12px;width:180px;border-top:1px solid #888">`
      + `<span data-col="when">18 Nov</span><span data-col="type">${type}</span>${type === "Index" ? "<b>×2</b>" : ""}</li>`;
    const j = await judged(`<div data-col-table><ol style="display:grid;margin:0;padding:0;list-style:none">${row("Index")}${row("Challenge type")}</ol></div>`);
    expect(rules(j)).not.toContain("column-start");
    // The rows have parts some rows lack and unequal heights: neither is a tile finding here.
    expect(rules(j)).not.toContain("part-uneven");
  });

  it("lists a near-full one-line item as tight without failing it", async () => {
    // 12 characters in a box 12.5 characters wide (ch, in its monospace font): 4% to spare whatever that font's width.
    const j = await judged('<div style="width:12.5ch"><span>Riverbank 12</span></div>');
    expect(j.failures).toEqual([]);
    expect(j.tight.map(t => t.rule)).toEqual(["tight"]);
  });
});

describe("render check verdict", () => {
  const finding = (text: string, extent: number): Finding => ({ rule: "clipped", element: "a", text, measure: "", extent, box: null });
  const render = (failures: Finding[]): Render => ({ surface: "matches", url: "/", width: 390, typeface: "Roboto", failures, tight: [], images: [""], failureImages: failures.map(() => ""), fonts: {}, invalid: [], pageErrors: [], fixtures: [] });
  const entry = (text: string, extent: number) => ({ surface: "matches", width: 390, typeface: "Roboto" as const, rule: "clipped" as const, element: "a", text, extent, why: "" });
  const held: HeldList = { note: "", held: [entry("Gemini 4 Hydrogen", 20), entry("Gemini 4 Hydrogen", 12)] };

  it("passes the findings the held list holds, no worse than held", () => {
    expect(judge([render([finding("Gemini 4 Hydrogen", 12), finding("Gemini 4 Hydrogen", 21)])], held).passed).toBe(true);
  });
  it("fails a held finding that gets worse, one more of it, or one not held", () => {
    const worse = judge([render([finding("Gemini 4 Hydrogen", 12), finding("Gemini 4 Hydrogen", 40)])], held);
    expect(worse.passed).toBe(false);
    expect(worse.newFailures[0]!.measure).toContain("held at 20, now 40");
    expect(judge([render([finding("Gemini 4 Hydrogen", 1), finding("Gemini 4 Hydrogen", 1), finding("Gemini 4 Hydrogen", 1)])], held).newFailures).toHaveLength(1);
    expect(judge([render([finding("Claude Opus 5.5", 1)])], held).passed).toBe(false);
  });
  it("fails an invalid render and reports held entries not matched", () => {
    const v = judge([{ ...render([]), invalid: ["wrong typeface"] }], held);
    expect(v.passed).toBe(false);
    expect(v.heldUnused).toHaveLength(2);
  });
  it("writes a held list that holds exactly the run it came from", () => {
    const r = render([finding("Gemini 4 Hydrogen", 7), finding("Claude Opus 5.5", 3)]);
    const list = heldFrom([r], { note: "", held: [] }, "reason");
    expect(list.held.map(e => e.why)).toEqual(["reason", "reason"]);
    expect(judge([r], list).passed).toBe(true);
    expect(judge([render([finding("Gemini 4 Hydrogen", 9)])], list).passed).toBe(false);
  });
});

describe("render check replay readiness", () => {
  const replay = SURFACES.find(s => s.id === "replay-free-for-all")!;
  const watch = SURFACES.find(s => s.id === "watch")!;
  const played: Playback = { startTick: 6_000, playbackTick: 6_040, playbackMs: 604_000, hud: "shown", error: null };

  async function readiness(ready: string): Promise<BoardReadiness> {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><p>Could not load this replay.</p><script>window.__antwar = { ready: ${ready} };</script>`);
      return await boardReadiness(page, 300);
    } finally { await page.close(); }
  }

  /**
   * A stand-in client: its board shows firstTick after `blank` frames of tick 0 and advances ticksPerStep each frame
   * after that, and the page holds hud as its HUD markup. playRecording asks for a frame at each of its 10 steps, and
   * draws the last moment twice: before and after what that frame loads.
   */
  async function play(ticksPerStep: number, hud: string, error: string | null = null, firstTick = 0, blank = 0): Promise<Playback> {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html>${hud}<script>
        window.__replayTime = 0; let tick = ${firstTick}; let blank = ${blank};
        window.__antwar = { ready: Promise.resolve(),
          recording: () => ({ stats: { bufferedMessages: 9 }, complete: true, lastTick: 0, time: 0, error: ${JSON.stringify(error)} }),
          frame: () => { if (blank > 0) { blank--; return { playbackTick: 0, playbackMs: 0 }; }
            tick += ${ticksPerStep}; return { playbackTick: tick, playbackMs: tick * 100 }; } };
      </script>`);
      return await playRecording(page, 1_000);
    } finally { await page.close(); }
  }

  it("makes a replay invalid when its board fails to load or never becomes ready", async () => {
    const rejected = await readiness('Promise.reject(new Error("recording 404"))');
    expect(rejected).toEqual({ state: "rejected", reason: "recording 404" });
    expect(boardProblem(replay, rejected, null)).toMatch(/never reached a ready, playing HUD.*failed to load \(recording 404\)/);
    const stuck = await readiness("new Promise(() => {})");
    expect(stuck).toEqual({ state: "timed out", ms: 300 });
    expect(boardProblem(replay, stuck, null)).toMatch(/never reached a ready, playing HUD.*not ready after 0.3 s/);
  });

  it("makes a ready replay invalid unless its recording plays and its HUD is shown", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="width:300px;height:80px">Score Band</div>';
    expect(boardProblem(replay, ready, null)).toMatch(/recording was never played/);
    expect(boardProblem(replay, ready, await play(0, hud))).toMatch(/did not play: the board was still at its first tick \(0\)/);
    expect(boardProblem(replay, ready, await play(1, hud, "This recording is damaged."))).toMatch(/failed while playing \(This recording is damaged\.\)/);
    expect(boardProblem(replay, ready, await play(1, "<p>Could not show the match.</p>"))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, '<div class="d2 d2-hud" style="display:none">Score</div>'))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, '<div class="d1 d1-hud" style="width:300px;height:80px;visibility:hidden">Score Band</div>'))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, '<div class="d1 d1-hud" style="width:300px;height:80px;opacity:0">Score Band</div>'))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, `<div style="visibility:hidden">${hud}</div>`))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, '<div class="d1 d1-hud" style="width:300px;height:80px;transform:translateY(-5000px)">Score Band</div>'))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, '<div class="d2 d2-hud" style="position:fixed;left:0;top:0;width:300px;height:80px;translate:0 -60px">Score</div>'))).toMatch(/no match HUD was shown/);
    const good = await play(1, hud);
    expect(good).toEqual({ startTick: 1, playbackTick: 12, playbackMs: 1_200, hud: "shown", error: null });
    expect(boardProblem(replay, ready, good)).toBeNull();
  }, 30_000);

  it("makes a replay invalid when it stays at its own first tick, which is not tick 0", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="width:300px;height:80px">Score Band</div>';
    // An excerpt that starts 6000 ticks into its match and never moves.
    const frozen = await play(0, hud, null, 6_000);
    expect(frozen).toMatchObject({ startTick: 6_000, playbackTick: 6_000 });
    expect(boardProblem(replay, ready, frozen)).toMatch(/did not play: the board was still at its first tick \(6000\)/);
    // Frames before its data arrive (tick 0) are not its first tick: it still has to move past 6000.
    const frozenAfterBlank = await play(0, hud, null, 6_000, 3);
    expect(frozenAfterBlank).toMatchObject({ startTick: 6_000, playbackTick: 6_000 });
    expect(boardProblem(replay, ready, frozenAfterBlank)).toMatch(/still at its first tick \(6000\)/);
    const playing = await play(1, hud, null, 6_000, 3);
    expect(playing).toMatchObject({ startTick: 6_001, playbackTick: 6_009 });
    expect(boardProblem(replay, ready, playing)).toBeNull();
  }, 30_000);

  it("makes a ready replay invalid when its HUD is boxed and visible but nothing of it reaches the screen", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="width:300px;height:80px">Score Band</div>';
    expect(boardProblem(replay, ready, await play(1, `<div style="clip-path:inset(100%)">${hud}</div>`))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, `<div style="height:0;overflow:hidden">${hud}</div>`))).toMatch(/its match HUD was cut/);
    expect(boardProblem(replay, ready, await play(1, `${hud}<div style="position:fixed;inset:0;background:#123">board</div>`))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, `<div style="clip-path:inset(-10px)">${hud}</div>`))).toBeNull();
  }, 30_000);

  it("makes a ready replay invalid when part of its HUD is clipped away, by the HUD or an element containing it", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="position:fixed;left:0;top:0;width:300px;height:80px"><b>Score Band</b><p style="margin:40px 0 0">Clock 1:00</p></div>';
    const cut = /its match HUD was cut/;
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;inset:0;clip-path:inset(40px 0 0 0)">${hud}</div>`))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, hud.replace("height:80px", "height:80px;clip-path:inset(0 0 60% 0)")))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;inset:0;-webkit-mask-image:linear-gradient(transparent 40px, #000 40px)">${hud}</div>`))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;left:0;top:0;width:300px;height:30px;overflow:hidden;transform:translateZ(0)">${hud}</div>`))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;inset:0;overflow:auto">${hud}</div>`))).toBeNull();
  }, 30_000);

  it("judges the HUD on the HUD alone while the board keeps animating", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="position:fixed;left:0;top:0;width:300px;height:80px">Score Band</div>';
    const board = '<div id="b" style="position:fixed;left:0;top:100px;width:200px;height:200px"></div>';
    // A board drawn every animation frame, and one drawn by a timer, which holding frames does not stop.
    const byFrame = `${board}<script>let n = 0; const f = () => { b.style.background = "#" + (n++ % 4096).toString(16).padStart(3, "0"); requestAnimationFrame(f); }; requestAnimationFrame(f);</script>`;
    const byTimer = `${board}<script>let n = 0; setInterval(() => { b.style.background = "#" + (n++ % 4096).toString(16).padStart(3, "0"); }, 5);</script>`;
    const clipped = `<div style="clip-path:inset(100%)">${hud}</div>`;
    expect(boardProblem(replay, ready, await play(1, clipped + byFrame))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, clipped + byTimer))).toMatch(/screen kept changing.*could not be judged/);
    expect(boardProblem(replay, ready, await play(1, hud + byFrame))).toBeNull();
  }, 30_000);

  it("accepts Watch with no board at all", async () => {
    expect(boardProblem(watch, await readiness("new Promise(() => {})"), null)).toBeNull();
    expect(boardProblem(replay, { state: "ready" }, played)).toBeNull();
  });

  it("names the page, width and typeface of a replay that never became ready", () => {
    const problem = boardProblem(replay, { state: "timed out", ms: 30_000 }, null)!;
    const render: Render = { surface: replay.id, url: replay.url, width: 390, typeface: "Roboto", failures: [], tight: [], images: [], failureImages: [], failureInView: [], fonts: {}, invalid: [problem], pageErrors: [], fixtures: [] };
    const verdict = judge([render], { note: "", held: [] });
    expect(verdict.passed).toBe(false);
    expect(verdict.invalid).toEqual([{ surface: "replay-free-for-all", width: 390, typeface: "Roboto", problem }]);
  });
});

it("judges Watch's top matches both as a visitor first sees them, results hidden, and in a browser that chose to show them", () => {
  const watch = SURFACES.filter(s => s.url === "/?watch=1");
  expect(watch.map(s => [s.id, s.storage ?? null])).toEqual([["watch", null], ["watch-results-shown", { [RESULTS_KEY]: "true" }]]);
});
