// The render check's rules (web/render-check/rules.ts) on small pages in Chromium: each rule fails on a page
// that breaks it and passes on the same page laid out correctly. Fixed fonts (monospace) keep widths predictable.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { RULE_LIMITS, judgePage, type PageJudgement, type RuleId } from "../../web/render-check/rules.ts";
import { heldFrom, judge, type HeldList, type Render } from "../../web/render-check/report.ts";
import type { Finding } from "../../web/render-check/rules.ts";

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

  it("fails a label or a table heading that wraps, inside prose too, or broken by hand", async () => {
    expect(rules(await judged('<p>Show <label style="display:inline-block;width:60px">Rated matches</label> only.</p>', 390))).toContain("wrap");
    expect(rules(await judged('<label style="display:block;width:300px">Rated<br>Matches</label>', 390))).toContain("wrap");
    expect(rules(await judged('<label style="display:block;width:100px">Show rated matches</label>', 390))).toContain("wrap");
    expect(rules(await judged('<label style="display:block;width:300px">Show rated matches</label>', 390))).not.toContain("wrap");
    const table = (w: number) => `<table style="width:${w}px;border-collapse:collapse"><thead><tr><th>Rated matches</th><th>Win rate</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`;
    expect(rules(await judged(table(120), 390))).toContain("wrap");
    expect(rules(await judged(table(360), 390))).not.toContain("wrap");
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
    // Sections that each hold a heading and running text are a reading column, not tiles.
    const section = (n: number) => `<section class="tile"><h2>Part</h2>${"<p>Running text of the rules page.</p>".repeat(n)}</section>`;
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

  it("lists a near-full one-line item as tight without failing it", async () => {
    const j = await judged('<div style="width:120px"><span>Riverbank 12</span></div>');
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
