// The render check's rules (web/render-check/rules.ts) on small pages in Chromium: each rule fails on a page
// that breaks it and passes on the same page laid out correctly. Fixed fonts (monospace) keep widths predictable.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { RULE_LIMITS, judgePage, type PageJudgement, type RuleId } from "../../web/render-check/rules.ts";
import { judge, type HeldList, type Render } from "../../web/render-check/report.ts";
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

  it("fails text cut by an overflow box or an ellipsis", async () => {
    const clipped = await judged('<div style="width:80px;overflow:hidden;white-space:nowrap"><span>A long colony name</span></div>');
    expect(rules(clipped).some(r => r === "clipped" || r === "cut")).toBe(true);
    const ellipsis = await judged('<div style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long colony name</div>');
    expect(rules(ellipsis).some(r => r === "clipped" || r === "cut")).toBe(true);
    const fits = await judged('<div style="width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long colony name</div>');
    expect(rules(fits)).toEqual([]);
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

  it("fails a tile part shown on some tiles but not others", async () => {
    const tile = (rating: boolean) => `<li class="tile"><span class="who">Name</span>${rating ? '<span class="rating"> 1500</span>' : '<span class="x"> </span>'}</li>`;
    expect(rules(await judged(`<ol class="grid">${tile(true)}${tile(false)}</ol>`))).toContain("part-uneven");
    expect(rules(await judged(`<ol class="grid">${tile(true)}${tile(true)}</ol>`))).not.toContain("part-uneven");
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
  const finding = (element: string): Finding => ({ rule: "clipped", element, text: "", measure: "", box: null });
  const render = (failures: Finding[]): Render => ({ surface: "matches", url: "/", width: 390, typeface: "Roboto", failures, tight: [], image: "", fonts: {}, invalid: [], pageErrors: [], fixtures: [] });
  const held: HeldList = { note: "", held: [{ surface: "matches", width: 390, typeface: "Roboto", rule: "clipped", element: "a", count: 2, why: "" }] };

  it("passes failures the held list holds, up to its count", () => {
    expect(judge([render([finding("a"), finding("a")])], held).passed).toBe(true);
  });
  it("fails a failure above its held count, or one not held", () => {
    expect(judge([render([finding("a"), finding("a"), finding("a")])], held).newFailures).toHaveLength(1);
    expect(judge([render([finding("b")])], held).passed).toBe(false);
  });
  it("fails an invalid render and reports held entries no longer found", () => {
    const v = judge([{ ...render([]), invalid: ["wrong typeface"] }], held);
    expect(v.passed).toBe(false);
    expect(v.heldUnused).toHaveLength(1);
  });
});
