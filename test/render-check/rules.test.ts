// The render check's rules (web/render-check/rules.ts) on small pages in Chromium: each rule fails on a page
// that breaks it and passes on the same page laid out correctly. Fixed fonts (monospace) keep widths predictable.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { RULE_LIMITS, judgePage, type PageJudgement, type RuleId } from "../../web/render-check/rules.ts";
import { TYPEFACES, applyTextSize, drawnFonts, fontconfigFor, rootFontSize, textSizeProblem, type TextSize } from "../../web/render-check/fonts.ts";
import { heldFrom, judge, markdown, type HeldList, type Render } from "../../web/render-check/report.ts";
import type { Finding } from "../../web/render-check/rules.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { ruleSections } from "../../web/rules.ts";
import { RESULTS_KEY } from "../../web/src/pages/top-matches.ts";
import { SURFACES, TEXT_SIZES, WIDTHS, boardProblem, boardReadiness, captureClipState, createGate, hudOnScreen, playRecording, rulesSectionsProblem, saveInvalidEvidence, scrollHome, viewport, watchReadiness, type BoardReadiness, type Playback, type RenderEvidence } from "../../web/render-check/check.ts";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

const BASE = "<style>body{margin:0;font:16px/20px 'Liberation Mono',monospace} p{margin:0} .tile{border:1px solid #888;padding:4px} .grid{display:grid;grid-template-columns:repeat(2,150px);gap:8px}</style>";

async function judged(body: string, width = 400, textSize: TextSize = 16): Promise<PageJudgement> {
  const page = await browser.newPage({ viewport: { width, height: 600 } });
  try {
    if (textSize !== 16) await applyTextSize(page, textSize);
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

  it("judges Rules section titles as one line, including their in-flow children, but lets ordinary headings and prose wrap", async () => {
    const section = (style: string, title = "Autonomous ants") => `<section class="d1p-rule" id="d1-autonomous-ants" aria-labelledby="d1-autonomous-ants-title">`
      + `<h3 class="d1p-rule-title" id="d1-autonomous-ants-title" style="${style}">${title}</h3>`
      + '<p style="width:60px">How an ant finds its way.</p></section>';
    const wraps = (j: PageJudgement) => j.failures.filter(f => f.rule === "wrap").map(f => f.element);
    const titleElement = "section.d1p-rule > h3.d1p-rule-title";
    expect(wraps(await judged(section("width:120px")))).toEqual([titleElement]);
    expect(wraps(await judged(section("width:320px")))).toEqual([]);
    expect(wraps(await judged(section("width:320px", 'Autonomous <span style="display:block">ants</span>')))).toEqual([titleElement]);
    expect(wraps(await judged(section("width:120px", 'Autonomous <span style="display:inline-block;border:1px solid">ants</span>')))).toEqual([titleElement]);
    const clipped = await judged(section("width:90px;white-space:nowrap;overflow:hidden"));
    expect(clipped.failures).toContainEqual(expect.objectContaining({ rule: "clipped", element: titleElement }));
    const headings = (page: string) => `<main data-page="${page}" style="width:100px"><h1 class="d1p-title">Top matches</h1><h2 class="d1p-card-title">Ranking card</h2></main>`;
    expect(wraps(await judged(headings("watch")))).toEqual(["main > h1.d1p-title"]);
    expect(wraps(await judged(headings("leaderboard")))).toEqual([]);
  });

  it("requires the redesign sections to be shown as Rules headings, not just listed in the index", async () => {
    const page = await browser.newPage();
    try {
      const sections = ruleSections(newMatchConfig(rulesConfig("redesign")), { undrawn: true });
      await page.setContent(sections.map(({ title }) => `<a>${title}</a><section class="d1p-rule"><h3 class="d1p-rule-title">${title}</h3></section>`).join(""));
      expect(await rulesSectionsProblem(page)).toBeNull();
      for (const title of ["Autonomous ants", "Flyers", "Battle balance"]) {
        const heading = page.locator("h3").filter({ hasText: title });
        await heading.evaluate(el => el.setAttribute("hidden", ""));
        expect(await rulesSectionsProblem(page)).toBe(`Rules section titles not shown: ${title}`);
        await heading.evaluate(el => el.removeAttribute("hidden"));
      }
    } finally { await page.close(); }
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
    // Icons stacked as blocks on purpose are not a row, so they are not a line wrapped over two.
    const stacked = `<div><span style="display:block">${svg}</span><span style="display:block">${svg}</span></div>`;
    expect(rules(await judged(stacked))).not.toContain("wrap");
    const stackedImages = `<div><svg style="display:block" width="16" height="16"><rect width="16" height="16"/></svg>`
      + `<svg style="display:block" width="16" height="16"><rect width="16" height="16"/></svg></div>`;
    expect(rules(await judged(stackedImages))).not.toContain("wrap");
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

  describe("designed player name ellipses", () => {
    const words = "Riverbank Very Long Model";
    const run = (tile: boolean, css = "", title = words) => {
      const name = `<span class="${tile ? "aw-name" : "d1p-rec-name"} aw-cut" title="${title}" `
        + `style="display:block;width:100px;overflow:hidden;white-space:pre;text-overflow:ellipsis;${css}">`
        + `<b>Riverbank</b><span> Very Long<span class="aw-held" style="display:inline-block"> M</span>odel</span></span>`;
      return tile ? `<a class="aw-tile" aria-label="${words} versus Bob"><span class="aw-player"><span class="aw-who">${name}</span></span></a>`
        : `<span class="d1p-rec-player"><span class="d1p-rec-who">${name}</span></span>`;
    };
    it.each(["tile", "recording"])("allows the %s name to shorten only as designed", async kind => {
      const tile = kind === "tile";
      expect(rules(await judged(run(tile), 390, 32))).toEqual([]);
      expect(rules(await judged(run(tile), 320))).toEqual([]);
      expect(rules(await judged(run(tile), 390))).toContain("clipped");
      expect(rules(await judged(run(tile, "text-overflow:clip"), 390, 32))).toContain("clipped");
      expect(rules(await judged(run(tile, "", "Wrong name"), 390, 32))).toContain("clipped");
    });

    it("does not count a name’s cut state or held spaces as extra tile parts", async () => {
      const cut = run(true);
      const whole = '<a class="aw-tile" aria-label="Bob versus Alice"><span class="aw-player"><span class="aw-who">'
        + '<span class="aw-name" title="Bob"><b>Bob</b></span></span></span></a>';
      const parts = async (extra: string) => (await judged(`<ol class="grid"><li class="tile">${cut}${extra}</li>`
        + `<li class="tile">${whole}</li></ol>`, 320, 32)).failures.filter(f => f.rule === "part-uneven").map(f => f.element);
      expect(await parts("")).toEqual([]);
      expect(await parts('<span class="rating">1500</span>')).toEqual(["ol.grid > span.rating"]);
    });

    it("still fails other cuts to a shortened name and an unrelated name", async () => {
      const nested = run(false).replace("<b>", '<b style="display:inline-block;width:20px;overflow:hidden">');
      expect(rules(await judged(nested, 320))).toContain("clipped");
      expect(rules(await judged(run(false, "height:8px"), 320))).toContain("clipped");
      expect(rules(await judged(`<div style="overflow:hidden;width:50px">${run(false)}</div>`, 320))).toContain("clipped");
      expect(rules(await judged(`<div style="margin-left:300px">${run(false)}</div>`, 320))).toContain("offscreen");
      expect(rules(await judged(run(false).replace("d1p-rec-name", "d1p-name"), 320))).toContain("clipped");
    });
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

  it("allows only the reserved space at the ends of a stacked player block, independent of the picks", async () => {
    const css = await Promise.all(["tokens", "top-match-tile"].map(file => readFile(`web/src/design-system/${file}.css`, "utf8")));
    const tile = (players: number) => `<li><a class="aw-tile"><span class="aw-row aw-meta">Challenge</span><span class="aw-lines">`
      + Array.from({ length: players }, (_, i) => `<span class="aw-row aw-player"><b>Player ${i + 1}</b></span>`).join("")
      + '</span><span class="aw-row aw-date">Nov 18</span></a></li>';
    const page = (cssChange = "", count = 2) => `<style>${css.join("\n")} ${cssChange}</style><main class="d1p"><ol class="aw-grid">${tile(count)}${tile(count)}</ol></main>`;
    const gaps = (j: PageJudgement) => j.failures.filter(f => f.rule === "tile-empty" || f.rule === "page-empty");
    for (const width of [320, 390, 1280]) for (const size of [16, 32] as const) {
      expect(gaps(await judged(page(), width, size))).toEqual([]);
    }
    expect(gaps(await judged(page("", 6), 320, 32))).toEqual([]);
    const excess = gaps(await judged(page(".aw-lines {min-height:12.5rem}"), 320, 32));
    expect(excess.map(f => f.rule)).toEqual(expect.arrayContaining(["tile-empty", "page-empty"]));
    // A smaller gap between players gets no centering budget even if an end gap is larger.
    expect(gaps(await judged(page(".aw-player + .aw-player {margin-top:2rem}"), 320, 32))).toContainEqual(
      expect.objectContaining({ rule: "tile-empty", measure: expect.stringContaining("limit 60 px") }));
    expect(gaps(await judged(page(".aw-date {margin-bottom:2.5rem}"), 390))).toContainEqual(
      expect.objectContaining({ rule: "tile-empty", measure: expect.stringContaining("limit 30 px") }));
  });

  it("scales the page band with text but not the landing page's fixed section spacing", async () => {
    const band = (px: number, fixed: boolean) => `<main class="${fixed ? "fg-inner" : "page"}" style="--fg-gap:${px}px">`
      + '<section>Above</section><section style="margin-top:var(--fg-gap)">Below</section></main>';
    for (const size of [16, 32] as const) {
      const limit = size * 3;
      expect(rules(await judged(band(limit - 8, false), 390, size))).not.toContain("page-empty");
      expect((await judged(band(limit + 8, false), 390, size)).failures).toContainEqual(expect.objectContaining(
        { rule: "page-empty", measure: expect.stringContaining(`limit ${limit} px`) }));
      expect((await judged(band(56, true), 390, size)).failures).toContainEqual(expect.objectContaining(
        { rule: "page-empty", measure: expect.stringContaining("limit 48 px") }));
    }
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
  const render = (failures: Finding[], width = 390, textSize: TextSize = 16): Render => ({ surface: "matches", url: "/", width, textSize, typeface: "Roboto", failures, tight: [], images: [""], failureImages: failures.map(() => ""), fonts: {}, invalid: [], pageErrors: [], fixtures: [] });
  const entry = (text: string, extent: number, width = 390, textSize: TextSize = 16) => ({ surface: "matches", width, textSize, typeface: "Roboto" as const, rule: "clipped" as const, element: "a", text, extent, why: "" });
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
  it("keeps held findings separate by width and text size", () => {
    // Held at 390 px / 16 px does not excuse the same finding at 320 px or at 32 px doubled text.
    const at320 = judge([render([finding("Gemini 4 Hydrogen", 12)], 320, 16)], held);
    expect(at320.passed).toBe(false);
    expect(at320.newFailures).toHaveLength(1);
    const doubled = judge([render([finding("Gemini 4 Hydrogen", 12)], 390, 32)], held);
    expect(doubled.passed).toBe(false);
    expect(doubled.newFailures).toHaveLength(1);
    const md = markdown(doubled, [render([finding("Gemini 4 Hydrogen", 12)], 390, 32)], { build: "head", snapshot: "snap" });
    expect(md).toContain("| Surface | Width | Text size | Typeface |");
    expect(md).toContain("| matches | 390 | 32 px | Roboto |");
  });
  it("fails an invalid render and reports held entries not matched", () => {
    const v = judge([{ ...render([]), invalid: ["wrong typeface"] }], held);
    expect(v.passed).toBe(false);
    expect(v.heldUnused).toHaveLength(2);
  });
  it("writes a held list that holds exactly the run it came from", () => {
    const r = render([finding("Gemini 4 Hydrogen", 7), finding("Claude Opus 5.5", 3)], 320, 32);
    const list = heldFrom([r], { note: "", held: [] }, "reason");
    expect(list.held.map(e => [e.width, e.textSize, e.why])).toEqual([[320, 32, "reason"], [320, 32, "reason"]]);
    expect(judge([r], list).passed).toBe(true);
    expect(judge([render([finding("Gemini 4 Hydrogen", 9)], 320, 32)], list).passed).toBe(false);
  });
});

describe("render check widths and doubled text", () => {
  it("settles scroll-driven animation-frame state at home without moving clipping boxes", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><div id="scroll" style="height:100px;overflow:auto"><div style="height:1000px"></div></div><div id="clip" style="height:100px;overflow:hidden"><div style="height:1000px"></div></div><script>
        const scroll = document.querySelector('#scroll');
        scroll.addEventListener('scroll', () => requestAnimationFrame(() => document.body.dataset.active = scroll.scrollTop ? 'end' : 'home'));
        scroll.scrollTop = 400;
        document.querySelector('#clip').scrollTop = 50;
      </script>`);
      await page.waitForFunction(() => document.body.dataset.active === "end");
      await scrollHome(page);
      expect(await page.evaluate(() => ({ active: document.body.dataset.active, scroll: document.querySelector("#scroll")!.scrollTop, clip: document.querySelector("#clip")!.scrollTop })))
        .toEqual({ active: "home", scroll: 0, clip: 50 });
    } finally { await page.close(); }
  });

  it("renders standard surfaces at 1280, 390 and 320 px at 16 and 32 px text, and zoom surfaces at 1280 px default text (124 renders)", () => {
    expect([...WIDTHS]).toEqual([1280, 390, 320]);
    expect([...TEXT_SIZES]).toEqual([16, 32]);
    expect(viewport(320)).toEqual({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    expect(viewport(390)).toEqual({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    expect(viewport(1280)).toEqual({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    expect(viewport(1280, 2)).toEqual({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    expect(viewport(1280, 4)).toEqual({ viewport: { width: 320, height: 200 }, deviceScaleFactor: 4 });
    let count = 0;
    for (const _typeface of TYPEFACES) {
      for (const width of WIDTHS) for (const textSize of TEXT_SIZES) for (const surface of SURFACES) {
        if (!(surface.widths ?? WIDTHS).includes(width)) continue;
        if (!(surface.textSizes ?? TEXT_SIZES).includes(textSize)) continue;
        count++;
      }
    }
    expect(count).toBe(124);
  });

  it("renders phones at 2x device scale so subpixel glyph wrapping in Liberation Sans at 320 px doubled text is caught", async () => {
    const fontRoot = await mkdtemp(`${tmpdir()}/render-check-dpr-`);
    let fontBrowser: Browser | null = null;
    try {
      const conf = await fontconfigFor("Liberation Sans", fontRoot);
      fontBrowser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"], env: { ...process.env, FONTCONFIG_FILE: conf } });
      const checkPadding = async (padPx: number) => {
        const ctx = await fontBrowser!.newContext({ ...viewport(320) });
        const page = await ctx.newPage();
        const cdp = await applyTextSize(page, 32);
        try {
          await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif} footer{display:flex;flex-wrap:wrap;gap:0 16px;width:100%;box-sizing:border-box;padding:0 ${padPx}px 20px;font-size:0.75rem} a{display:inline-flex;align-items:center;min-height:44px}</style><footer><a>Rules</a><a>Inspired by @LambethEthan</a></footer>`);
          return await page.evaluate(judgePage, RULE_LIMITS);
        } finally {
          await cdp.detach().catch(() => undefined);
          await ctx.close();
        }
      };
      // At 2x device scale, 8 px side padding (304 px box) wraps the 24 px Liberation Sans footer credit; 4 px (312 px box) fits one line.
      expect(rules(await checkPadding(8))).toContain("wrap");
      expect(rules(await checkPadding(4))).not.toContain("wrap");
    } finally {
      await fontBrowser?.close();
      await rm(fontRoot, { recursive: true, force: true });
    }
  });

  it("applies 32 px browser default text through Page.setFontSizes and catches a wrap at 320 px with doubled text", async () => {
    // Two 5.25rem inline-block words (~10.8rem total): fits 390 px at 16/32 px and 320 px at 16 px, wraps only at 320 px with 32 px doubled text.
    const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0} label{display:block;font-size:1rem;line-height:1.25} label span{display:inline-block;width:5.25rem}</style><label><span>First</span> <span>Second</span></label>`;
    const run = async (width: number, textSize: TextSize) => {
      const context = await browser.newContext({ ...viewport(width) });
      const page = await context.newPage();
      const cdp = await applyTextSize(page, textSize);
      try {
        await page.setContent(html);
        const actual = await rootFontSize(page);
        expect(textSizeProblem(textSize, actual)).toBeNull();
        // Reading drawnFonts opens and detaches its own CDP session and must not revert Page.setFontSizes.
        await drawnFonts(page);
        expect(textSizeProblem(textSize, await rootFontSize(page))).toBeNull();
        return await page.evaluate(judgePage, RULE_LIMITS);
      } finally {
        await cdp.detach().catch(() => undefined);
        await context.close();
      }
    };
    expect(rules(await run(390, 16))).not.toContain("wrap");
    expect(rules(await run(320, 16))).not.toContain("wrap");
    expect(rules(await run(390, 32))).not.toContain("wrap");
    // At 320 px with doubled text (root 32 px -> ~346 px wide), it exceeds 320 px and wraps.
    expect(rules(await run(320, 32))).toContain("wrap");
  });

  it("reports a root font-size mismatch as invalid", () => {
    expect(textSizeProblem(16, 16)).toBeNull();
    expect(textSizeProblem(32, 32)).toBeNull();
    expect(textSizeProblem(32, 16)).toMatch(/16 px.*expected 32 px/);
    expect(textSizeProblem(32, Number.NaN)).toMatch(/unreadable.*expected 32 px/);
  });

  it("stops waiting for a Watch board as soon as the top-matches list mounts, while still resolving a live board", async () => {
    const page = await browser.newPage();
    try {
      const t0 = Date.now();
      await page.setContent(`<!doctype html><div id="aw-top-matches-page"></div><script>window.__antwar = { ready: new Promise(() => {}) };</script>`);
      expect(await watchReadiness(page, 5_000)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1_000);
      await page.setContent(`<!doctype html><script>window.__antwar = { ready: new Promise(() => {}) }; setTimeout(() => { const d = document.createElement("div"); d.id = "aw-top-matches-page"; document.body.append(d); }, 50);</script>`);
      expect(await watchReadiness(page, 5_000)).toBeNull();
      await page.setContent(`<!doctype html><script>window.__antwar = { ready: Promise.resolve({}) };</script>`);
      expect(await watchReadiness(page, 5_000)).toEqual({ state: "ready" });
    } finally { await page.close(); }
  });
});

describe("render check replay readiness", () => {
  it("shares one replay permit, transfers it to queued work, and releases it after errors", async () => {
    const gate = createGate(1);
    const order: number[] = [];
    let active = 0, maxActive = 0;
    const job = (id: number, fails = false) => gate(async () => {
      active++; maxActive = Math.max(maxActive, active); order.push(id);
      try { await Promise.resolve(); if (fails) throw new Error("failed replay"); return id; }
      finally { active--; }
    });
    const results = await Promise.allSettled([job(1), job(2, true), job(3), job(4)]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(await job(5)).toBe(5);
  });

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

  it("retains the comparison images and clipping measurements of an invalid HUD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-invalid-"));
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    try {
      // The clock still paints a solid patch below the cut, independently of its font.
      await page.setContent('<div style="position:fixed;inset:0;clip-path:inset(40px 0 0 0)"><div class="d1-hud" style="position:fixed;inset:0"><b>Score Band</b><p style="margin-top:50px;width:40px;background:#ddd">Clock</p></div></div>');
      const evidence: RenderEvidence = { clipState: await captureClipState(page), comparisons: [] };
      expect(await hudOnScreen(page, evidence)).toBe("clipped");
      const ref = await saveInvalidEvidence(dir, "replay-320-32px-roboto", ["HUD clipped"], evidence);
      const saved = JSON.parse(await readFile(join(dir, ref), "utf8"));
      expect(saved.invalid).toEqual(["HUD clipped"]);
      expect(saved.measurements.unclipped.verdict).toBe("clipped");
      expect(saved.clipState.chain).toEqual(expect.arrayContaining([expect.objectContaining({ clipPath: "inset(40px 0px 0px)" })]));
      expect(saved.comparisons.map((c: { kind: string }) => c.kind)).toEqual(["hidden", "hidden", "hidden", "unclipped", "unclipped", "unclipped"]);
      for (const c of saved.comparisons) for (const file of Object.values(c.files) as string[]) {
        expect((await readFile(join(dir, "invalid-evidence", file))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
      const incomplete: RenderEvidence = { clipState: { unavailable: "navigation failed" }, comparisons: [{ kind: "hidden", attempt: 0, before: Buffer.from("partial") }] };
      const partialRef = await saveInvalidEvidence(dir, "partial", ["did not render"], incomplete);
      const partial = JSON.parse(await readFile(join(dir, partialRef), "utf8"));
      expect(partial.comparisons[0].files).toEqual({ before: "partial-hidden-0-before.png", altered: null, after: null });
    } finally { await page.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("does not count a one-pixel change in the hidden shot as paint from a covered HUD", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    try {
      await page.setContent('<div class="d1-hud">Score Band</div><div id="board" style="position:fixed;inset:0;background:#123"></div>');
      const capture = page.screenshot.bind(page);
      let planted = false;
      vi.spyOn(page, "screenshot").mockImplementation(async options => {
        const hidden = await page.locator(".d1-hud").evaluate(e => getComputedStyle(e).visibility === "hidden");
        if (planted || !hidden) return capture(options);
        planted = true;
        const dot = await page.addStyleTag({ content: "#board::after {content:'';position:absolute;left:0;top:0;width:1px;height:1px;background:white}" });
        try { return await capture(options); } finally { await dot.evaluate(e => (e as Element).remove()); }
      });
      const evidence: RenderEvidence = { comparisons: [] };
      expect(await hudOnScreen(page, evidence)).toBe("screen not still");
      expect(planted).toBe(true);
      expect(evidence.measurements?.hidden).toMatchObject({ stableDifferences: 0, alteredVariablePixels: 1 });
      const [noisy, clean] = evidence.comparisons;
      expect(noisy!.before!.equals(noisy!.after!)).toBe(true);
      expect(noisy!.before!.equals(noisy!.altered!)).toBe(false);
      expect(clean!.before!.equals(clean!.altered!)).toBe(true);
    } finally { await page.close(); }
  });

  it("requires more than one percent of the device pixels even for a visibly painted tiny HUD", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 2 });
    try {
      await page.setContent('<div class="d1-hud" style="width:9px;height:10px;background:black"></div>');
      const evidence: RenderEvidence = { comparisons: [] };
      expect(await hudOnScreen(page, evidence)).toBe("insufficient HUD paint");
      expect(evidence.measurements?.hidden).toMatchObject({ width: 200, height: 200, pixelLimit: 400, stableDifferences: 360, variablePixels: 0 });
    } finally { await page.close(); }
  });

  it.each(["clip-path:inset(0 1px 0 0)", "mask-image:linear-gradient(to right, black 31px, transparent 31px)"])(
    "detects a single device pixel removed by %s", async css => {
      const page = await browser.newPage({ viewport: { width: 80, height: 32 }, deviceScaleFactor: 1 });
      try {
        // Only the 1px dot paints in the rightmost column. A separate square proves visibility.
        await page.setContent(`<div class="d1-hud" style="position:fixed;left:0;top:0;width:32px;height:20px;${css}">
          <div style="width:20px;height:20px;background:black"></div>
          <div style="position:absolute;right:0;top:0;width:1px;height:1px;background:black"></div></div>`);
        const evidence: RenderEvidence = { comparisons: [] };
        expect(await hudOnScreen(page, evidence)).toBe("clipped");
        expect(evidence.measurements?.unclipped).toMatchObject({ stableDifferences: 1, variablePixels: 0 });
      } finally { await page.close(); }
    });

  it("does not compare unclipped screenshots when the HUD and its ancestors have no clip or mask", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    try {
      await page.setContent('<div class="d1-hud" style="position:fixed;inset:0;background:#333;color:white">Score Band</div>');
      const evidence: RenderEvidence = { comparisons: [] };
      expect(await hudOnScreen(page, evidence)).toBe("shown");
      expect(evidence.comparisons.map(c => c.kind)).toEqual(["hidden", "hidden", "hidden"]);
      await page.setContent('<div style="position:fixed;left:0;top:0;width:300px;height:30px;overflow:hidden;transform:translateZ(0)"><div class="d1-hud" style="position:fixed;left:0;top:0;width:300px;height:80px;background:#333;color:white">Score Band</div></div>');
      const overflowEvidence: RenderEvidence = { comparisons: [] };
      await hudOnScreen(page, overflowEvidence);
      expect(overflowEvidence.comparisons.map(c => c.kind)).toEqual(["hidden", "hidden", "hidden", "unclipped", "unclipped", "unclipped"]);
    } finally { await page.close(); }
  });

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
    const hud = '<div class="d1 d1-hud" style="width:300px;height:80px;background:#eee">Score Band</div>';
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
    const hud = '<div class="d1 d1-hud" style="width:300px;height:80px;background:#eee">Score Band</div>';
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
    const hud = '<div class="d1 d1-hud" style="width:300px;height:80px;background:#eee">Score Band</div>';
    expect(boardProblem(replay, ready, await play(1, `<div style="clip-path:inset(100%)">${hud}</div>`))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, `<div style="height:0;overflow:hidden">${hud}</div>`))).toMatch(/its match HUD was cut/);
    expect(boardProblem(replay, ready, await play(1, `${hud}<div style="position:fixed;inset:0;background:#123">board</div>`))).toMatch(/no match HUD was shown/);
    expect(boardProblem(replay, ready, await play(1, `<div style="clip-path:inset(-10px)">${hud}</div>`))).toBeNull();
  }, 30_000);

  it("makes a ready replay invalid when part of its HUD is clipped away, by the HUD or an element containing it", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="position:fixed;left:0;top:0;width:300px;height:80px;background:#eee"><b>Score Band</b><p style="margin:40px 0 0">Clock 1:00</p></div>';
    const cut = /its match HUD was cut/;
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;inset:0;clip-path:inset(40px 0 0 0)">${hud}</div>`))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, hud.replace("height:80px", "height:80px;clip-path:inset(0 0 60% 0)")))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;inset:0;-webkit-mask-image:linear-gradient(transparent 40px, #000 40px)">${hud}</div>`))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;left:0;top:0;width:300px;height:30px;overflow:hidden;transform:translateZ(0)">${hud}</div>`))).toMatch(cut);
    expect(boardProblem(replay, ready, await play(1, `<div style="position:fixed;inset:0;overflow:auto">${hud}</div>`))).toBeNull();
  }, 30_000);

  it("judges the HUD on the HUD alone while the board keeps animating", async () => {
    const ready: BoardReadiness = { state: "ready" };
    const hud = '<div class="d1 d1-hud" style="position:fixed;left:0;top:0;width:300px;height:80px;background:#eee">Score Band</div>';
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
    const render: Render = { surface: replay.id, url: replay.url, width: 390, textSize: 16, typeface: "Roboto", failures: [], tight: [], images: [], failureImages: [], failureInView: [], fonts: {}, invalid: [problem], pageErrors: [], fixtures: [] };
    const verdict = judge([render], { note: "", held: [] });
    expect(verdict.passed).toBe(false);
    expect(verdict.invalid).toEqual([{ surface: "replay-free-for-all", width: 390, textSize: 16, typeface: "Roboto", problem }]);
    const withEvidence = judge([{ ...render, invalidEvidence: "invalid-evidence/replay.json" }], { note: "", held: [] });
    expect(withEvidence.invalid[0]?.evidence).toBe("invalid-evidence/replay.json");
    expect(markdown(withEvidence, [render], { build: "test", snapshot: "test" })).toContain("[evidence](invalid-evidence/replay.json)");
  });
});

it("judges Watch's top matches both as a visitor first sees them, results hidden, and in a browser that chose to show them", () => {
  const watch = SURFACES.filter(s => s.url === "/?watch=1");
  expect(watch.map(s => [s.id, s.storage ?? null])).toEqual([["watch", null], ["watch-results-shown", { [RESULTS_KEY]: "true" }]]);
});
