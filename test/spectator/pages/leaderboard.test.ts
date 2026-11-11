// The Archive Leaderboard through its real data owner: the "Loaded hh:mm UTC" freshness line and the badge
// group. Not rendering or visual evidence: whether the badges stay on one line at ~1200 px is the served build's to show.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountLeaderboardPage } from "../../../web/src/leaderboard-page/page.ts";
import { PAGE_WORDS } from "../../../web/src/ui/pages.ts";
import { dom, type ElementPort } from "./dom.ts";
import { leaderboardCards } from "./archive.ts";

type Pending = { body: { mode: string; scope?: string; cursor?: string }; signal: AbortSignal; resolve(response: Response): void };
const reply = (names: string[], next?: string) => new Response(JSON.stringify({ entries: names.map(displayName => ({ displayName, rating: 1500, ratedMatches: 2 })), ...(next ? { next } : {}) }));
const at = (time: string) => vi.setSystemTime(new Date(`2026-10-27T${time}:00Z`));

function page() {
  const pending: Pending[] = [];
  const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => {
    pending.push({ body: JSON.parse(String(init!.body)), signal: init!.signal!, resolve });
  }));
  const port = dom({ meta: { "antwar-public-matches": "true" } });
  const dispose = mountLeaderboardPage(port.doc, port.win, { request });
  const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
  const button = (test: (node: ElementPort) => boolean) => root.all().find(node => node.tag === "button" && test(node))!;
  /** Answer the one open read for this mode (and cursor), or fail it. */
  const answer = async (mode: string, response: Response, cursor?: string, settle = true) => {
    const index = pending.findIndex(item => !item.signal.aborted && item.body.mode === mode && item.body.cursor === cursor);
    expect(index).toBeGreaterThanOrEqual(0);
    pending.splice(index, 1)[0]!.resolve(response);
    if (settle) await vi.waitFor(() => expect(leaderboardCards(root).every(card => card.busy === "false")).toBe(true));
  };
  return {
    root, dispose, answer,
    loaded: () => root.byClass("d1p-loaded")[0]!.textContent,
    refresh: () => button(node => node.textContent === PAGE_WORDS.refresh).click(),
    more: () => button(node => node.dataset.key?.startsWith("more-") === true).click(),
    choose: (label: string) => button(node => node.getAttribute("aria-label") === label).click(),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("the Loaded time", () => {
  it("moves on a first load, a board switch and every successful Refresh, the same rows and a Refresh during Load more included", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = page();
    expect(p.loaded()).toBe("");
    at("10:00"); await p.answer("house-1v1", reply(["a", "b"], "c1"));
    expect(p.loaded()).toBe("Loaded 10:00 UTC");

    // Refresh returning the same rows.
    at("10:05"); p.refresh(); await p.answer("house-1v1", reply(["a", "b"], "c1"));
    expect(p.loaded()).toBe("Loaded 10:05 UTC");

    // Refresh pressed while a Load more is still loading: the Load more is dropped, the Refresh's first page moves it.
    at("10:10"); p.more(); p.refresh();
    await p.answer("house-1v1", reply(["a", "b"], "c1"));
    expect(p.loaded()).toBe("Loaded 10:10 UTC");

    // A board switch is a first load, here to tables with new ids and then to tables under the same ids.
    at("10:15"); p.choose("Ranked 1v1");
    await p.answer("1v1", reply(["x"]), undefined, false); await p.answer("1v1", reply(["y"]));
    expect(p.loaded()).toBe("Loaded 10:15 UTC");
    at("10:20"); p.choose("Ranked 2v2");
    await p.answer("2v2", reply(["x"]), undefined, false); await p.answer("2v2", reply(["y"]));
    expect(p.loaded()).toBe("Loaded 10:20 UTC");
    p.dispose();
  });

  it("never moves on Load more, on a failed load or on a cursor-only change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = page();
    at("11:00"); await p.answer("house-1v1", reply(["a"], "c1"));
    expect(p.loaded()).toBe("Loaded 11:00 UTC");

    // Load more, adding rows and leaving a further page: an older page, never the top of the list.
    at("11:05"); p.more(); await p.answer("house-1v1", reply(["b"], "c2"), "c1");
    expect(p.loaded()).toBe("Loaded 11:00 UTC");
    // The last Load more: it adds no rows and only its cursor changes, to none.
    at("11:10"); p.more(); await p.answer("house-1v1", reply([]), "c2");
    expect(p.loaded()).toBe("Loaded 11:00 UTC");
    expect(leaderboardCards(p.root)[0]!.names).toEqual(["a", "b"]);

    // A Refresh whose read fails, and a failed Load more.
    at("11:15"); p.refresh(); await p.answer("house-1v1", new Response("unavailable", { status: 503 }));
    expect(p.loaded()).toBe("Loaded 11:00 UTC");
    at("11:20"); p.refresh(); await p.answer("house-1v1", reply(["a"], "c1"));
    expect(p.loaded()).toBe("Loaded 11:20 UTC");
    at("11:25"); p.more(); await p.answer("house-1v1", new Response("unavailable", { status: 503 }), "c1");
    expect(p.loaded()).toBe("Loaded 11:20 UTC");
    p.dispose();
  });
});

describe("Last 5 links keep focus across a redraw", () => {
  // The test DOM tracks the document's active element, including when the focused node is removed; not native focus.
  const withForm = (name: string) => new Response(JSON.stringify({ entries: [
    { displayName: name, rating: 1500, ratedMatches: 1, wins: 1, losses: 0, draws: 0, form: [{ result: "W", replayId: "2026-10-27T10-00-00-000Z-1" }] },
  ] }));
  const formLinks = (root: ElementPort) => root.all().filter(node => node.tag === "a" && node.classes().includes("d1p-form-mark"));

  it("keeps a focused Last 5 link, in the table and in the stacked rows, when the board's other table settles", async () => {
    for (const layout of ["wide", "narrow"] as const) {
      const p = page();
      await p.answer("house-1v1", reply(["a"]));
      p.choose("Ranked 1v1");
      await p.answer("1v1", withForm("x"), undefined, false);
      await vi.waitFor(() => expect(formLinks(p.root)).toHaveLength(2));
      const link = formLinks(p.root).find(node => node.dataset.key?.includes(`|${layout}|`))!;
      link.focus();
      const doc = link.owner!;
      expect(doc.activeElement).toBe(link);
      await p.answer("1v1", withForm("y"));
      expect(link.isConnected).toBe(false);
      expect(doc.activeElement).not.toBe(doc.body);
      expect(doc.activeElement?.dataset.key).toBe(link.dataset.key);
      expect(doc.activeElement?.isConnected).toBe(true);
      p.dispose();
    }
  });
});

describe("the stacked rows' names", () => {
  it("lets a long unbroken name wrap inside its own track, as the table's cells do, rather than run under Elo", () => {
    // A style-contract check on the source rule, not a painted-layout measurement.
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.d1p-lb-rows \.d1p-line\.is-lead \{[^}]*overflow-wrap: anywhere;/);
  });
});

describe("touch targets", () => {
  // A style-contract check on the source rules; the leaderboard capture measures the painted 44 px targets.
  const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
  const block = (query: string) => {
    const start = css.indexOf(`@media ${query} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("\n}\n", start));
  };
  it.each(["(pointer: coarse)", "(pointer: coarse) and (width >= 46rem)"])("scopes every %s rule to the Leaderboard, so other pages are unchanged", query => {
    const rules = block(query).split("\n").slice(1).filter(line => line.includes("{"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule.trim().startsWith('.d1p[data-page="leaderboard"]')).toBe(true);
  });
  it("gives touch screens 44 px pills, board tabs, nav and footer links, and 44 px Last 5 links that keep their width", () => {
    const touch = block("(pointer: coarse)");
    expect(touch).toMatch(/--d2-tap: 44px; --d1-tap: 44px;/);
    for (const control of [".d1p-tab", ".d1-top .d2-nav-link", ".d1p-foot .d2-link"]) expect(touch).toMatch(new RegExp(`${control.replace(/[.]/g, "\\.")} \\{[^}]*min-height: 44px;`));
    const form = block("(pointer: coarse) and (width >= 46rem)");
    expect(form).toMatch(/\.d1p-form-mark \{ height: 44px; \}/);
    expect(form.split("\n").slice(1).join("\n")).not.toMatch(/width/);
  });
});

describe("badges", () => {
  it("holds a name's two badges in one group, in the table and in the stacked rows", async () => {
    const p = page();
    await p.answer("house-1v1", new Response(JSON.stringify({ entries: [
      { displayName: "antwars/gpt-6-astra", rating: 1600, ratedMatches: 4, thinkingLevel: "max", serviceTier: "fast", benchmark: true },
      { displayName: "antwars/claude-opus-5-5", rating: 1550, ratedMatches: 3, thinkingLevel: "high", benchmark: true },
    ] })));
    const groups = p.root.byClass("d1p-tags");
    // Two rows, each drawn in the table and the stacked list.
    expect(groups.map(group => group.children.map(tag => tag.textContent))).toEqual([["max", "Fast"], ["high"], ["max", "Fast"], ["high"]]);
    expect(groups.every(group => group.children.every(tag => tag.classes().includes("d1p-tag")))).toBe(true);
    expect(p.root.byClass("d1p-tag").every(tag => tag.parent!.classes().includes("d1p-tags"))).toBe(true);
    p.dispose();
  });
});

describe("the band and its cyan Refresh", () => {
  it("holds the title, Refresh, Loaded and the board choice in the band, and only Refresh carries the cyan class", async () => {
    const p = page();
    const band = p.root.byClass("d1p-band")[0]!;
    expect(band.byClass("d1p-title")).toHaveLength(1);
    expect(band.byClass("d1p-loaded")).toHaveLength(1);
    // Both ranking groups' four sizes, and nothing else.
    expect(band.byClass("d1p-tab")).toHaveLength(8);
    expect(p.root.byClass("d1p-rail")).toHaveLength(0);
    expect(p.root.byClass("d1p-refresh").map(node => node.textContent)).toEqual([PAGE_WORDS.refresh]);
    expect(band.all().includes(p.root.byClass("d1p-refresh")[0]!)).toBe(true);
    p.dispose();
  });

  it("puts Loaded then Refresh on the title's line, and the challenge bubble after the board choice, its words exactly, the cyan button to the Antwars Model Index 1v1 board keeping the board", () => {
    const port = dom({ search: "?page=leaderboard&board=2d", meta: { "antwar-public-matches": "true" } });
    const dispose = mountLeaderboardPage(port.doc, port.win, { request: vi.fn(() => new Promise<Response>(() => {})) });
    const band = port.body.all().find(node => node.id === "aw-leaderboard-page")!.byClass("d1p-band")[0]!;
    // Two lines: the title's line, then the board choice's.
    expect(band.children.map(node => node.className)).toEqual(["d1p-summary", "d1p-lb-strip"]);
    const [summary, strip] = band.children as [ElementPort, ElementPort];
    // The title, then at its line's end the time and Refresh, in that order, so Refresh holds the end.
    expect(summary.children.map(node => node.className)).toEqual(["d1p-title", "d1p-fresh"]);
    expect(summary.children[1]!.children.map(node => node.className)).toEqual(["d1p-loaded", "d2-pill d1p-refresh"]);
    // The bubble right after the board choice, whose last group is Ranked.
    expect(strip.hidden).toBe(false);
    expect(strip.children.map(node => node.className)).toEqual(["d1p-boards", "d1-agent-button"]);
    expect(strip.children[0]!.children.at(-1)!.byClass("d1p-kicker")[0]!.textContent).toBe("Ranked");
    const bubble = strip.children[1]!;
    expect([bubble.tag, bubble.className, bubble.dataset.key]).toEqual(["a", "d1-agent-button", "challenge-new"]);
    // Its words wrap inside the cyan button on a narrow phone; the grey bubble's rule is gone from ui/ui.css.
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toContain('.d1p .d1-agent-button[data-key="challenge-new"] { white-space: normal;');
    expect(readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8")).not.toContain("challenge-new");
    expect(bubble.textContent).toBe("NEW: Your agent can challenge the top models");
    expect(bubble.href).toBe("/?page=leaderboard&mode=house-1v1&board=2d");
    dispose();
  });

  it("drops the challenge bubble with the board choice where the public leaderboard is not enabled", () => {
    const port = dom({ search: "?page=leaderboard" });
    const dispose = mountLeaderboardPage(port.doc, port.win, { request: vi.fn(() => new Promise<Response>(() => {})) });
    const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
    // The board choice and the bubble share one line, which goes; the title stays, its freshness and Refresh gone.
    const strip = root.byClass("d1p-lb-strip")[0]!;
    expect(strip.hidden).toBe(true);
    expect(root.byClass("d1p-boards")[0]!.parentElement === strip).toBe(true);
    expect(root.all().find(node => node.dataset.key === "challenge-new")!.parentElement === strip).toBe(true);
    expect(root.byClass("d1p-fresh")[0]!.hidden).toBe(true);
    expect(root.byClass("d1p-title")[0]!.hidden).toBe(false);
    dispose();
  });
});

describe("the Leaderboard's layout rules", () => {
  // Style-contract checks on the source rules; the pass captures show the painted layout.
  const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
  const rules = css.split("\n").filter(line => line.includes("{") && !line.trim().startsWith("@"));
  it("scopes every rule for the band's board line and the rating badge's tap area to the Leaderboard, so the front page, Matches and Rules are unchanged", () => {
    const own = rules.filter(rule => /d1p-lb-strip|d1p-elo-badge::before/.test(rule));
    expect(own.length).toBeGreaterThan(0);
    for (const rule of own) expect(rule.trim().startsWith('.d1p[data-page="leaderboard"]')).toBe(true);
    // The band's two lines and the tabs' spacing are the Leaderboard's own as well.
    for (const part of [".d1p-band {", ".d1p-summary {", ".d1p-fresh {", ".d1p-boards {", ".d1p-board-group {", ".d1p-tabs {", ".d1p-tab {"]) {
      expect(css).toContain(`.d1p[data-page="leaderboard"] ${part}`);
    }
  });
  it("keeps the table's columns, resizing only the Leaderboard's rating and Rated matches columns, while the front page's card keeps its widths", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-lb .c-elo { width: calc(var(--d1p-gutter) + 144px); }');
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-lb thead th.c-matches { white-space: nowrap; }');
    expect(css).toContain(".d1p-lb .c-elo { width: calc(var(--d1p-gutter) + 184px); text-align: left; }");
    expect(css).toContain(".d1p-lb thead th.c-matches { white-space: normal; }");
  });
});

describe("the Leaderboard's type rules", () => {
  // Style-contract checks on the source rules; the pass captures show the painted type.
  const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
  const rules = css.split("\n").filter(line => line.includes("{") && !line.trim().startsWith("@"));
  it("sets a card's count as metadata beside its title, the text size in the quiet ink, adding nothing to the title's line", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-card-title > .d1p-count { font-size: 13px; font-weight: 400; line-height: 1; letter-spacing: normal; text-transform: none; }');
  });
  it("gives \"provisional\" its rating badge's 10 px, one step quieter", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-prov { font-size: 10px; color: var(--aw-ink-3); }');
  });
  it("starts a name's wrapped badges on the name's edge, the gap the name's own trailing margin", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] :is(.d1p-card .is-lead, .d1p-lb th.c-name) > span:first-child:has(+ .d1p-tags) { margin-right: 6px; }');
    expect(css).toContain('.d1p[data-page="leaderboard"] :is(.d1p-card .is-lead, .d1p-lb th.c-name) > .d1p-tags > .d1p-tag:first-child { margin-left: 0; }');
  });
  it("scopes every type-pass rule to the Leaderboard, so the front page, Matches and Rules keep their shared rules", () => {
    const own = rules.filter(rule => /> \.d1p-count|span:first-child:has\(\+ \.d1p-tags\)|\.d1p-tags > \.d1p-tag:first-child/.test(rule) || rule.startsWith('.d1p[data-page="leaderboard"] .d1p-prov {'));
    expect(own.length).toBeGreaterThanOrEqual(4);
    for (const rule of own) expect(rule.trim().startsWith('.d1p[data-page="leaderboard"]')).toBe(true);
    expect(css).toContain(".d1p-prov { margin-left: 8px; font-size: 11px; font-weight: 600; line-height: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--aw-ink-2);");
    expect(css).toContain(".d1p-count { margin-left: 6px; color: var(--aw-ink-3); white-space: nowrap; }");
    expect(css).toContain(".d1p-tag { display: inline-block; margin-left: 6px;");
  });
});

describe("the Leaderboard's quieter rules", () => {
  // Style-contract checks on the source rules; the pass captures show the painted page.
  const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
  const rules = css.split("\n").filter(line => line.includes("{") && !line.trim().startsWith("@"));
  it("draws Last 5 a weight lighter and an ink step quieter, keeping every letter, fill, outline and replay link, and brightens a link under the mouse", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-form-mark { font-weight: 600; color: var(--aw-ink-3); }');
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-form-mark[data-result="W"] { color: var(--aw-ink-2); }');
    expect(css).toContain('.d1p[data-page="leaderboard"] a.d1p-form-mark:hover { color: var(--aw-ink-bright); }');
    // A link stays underlined; a win stays filled and a loss or a draw outlined.
    expect(css).toContain(".d1p a.d1p-form-mark { text-decoration: underline; text-underline-offset: 2px; }");
    expect(css).toContain('.d1p-form-mark[data-result="W"]::before { background: var(--aw-raise); box-shadow: none; }');
    expect(css).toMatch(/\.d1p-form-mark::before \{[^}]*box-shadow: inset 0 0 0 1px var\(--aw-line\);/);
    // The Leaderboard's own rules change neither the letters' look nor the link rule in any other way.
    expect(rules.filter(rule => rule.trim().startsWith('.d1p[data-page="leaderboard"]') && rule.includes("d1p-form-mark")).join("\n")).not.toMatch(/text-decoration|background|box-shadow|content:/);
  });
  it("draws each stamp smaller inside an unchanged target: 20 px in the table, 24 px in a phone's 40 × 44 px tap", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-form-mark::before { inset: 2px 4px; }');
    const phone = css.slice(css.indexOf("the Leaderboard's band on a phone */"));
    expect(phone.slice(0, phone.indexOf("\n}\n"))).toContain('.d1p[data-page="leaderboard"] .d1p-form-mark::before { inset: 10px 8px; }');
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) and (width >= 46rem) {"));
    expect(coarse.slice(0, coarse.indexOf("\n}\n"))).toContain('.d1p[data-page="leaderboard"] .d1p-form-mark::before { inset: 12px 4px; }');
    // The targets themselves: 28 × 24 px, 40 × 44 px on a phone, 44 px tall on any touch screen.
    expect(css).toMatch(/\.d1p-form-mark \{ position: relative;[^}]*width: 28px; height: 24px;/);
    expect(css).toContain(".d1p-form-mark { width: 40px; height: 44px; }");
    expect(coarse.slice(0, coarse.indexOf("\n}\n"))).toContain('.d1p[data-page="leaderboard"] .d1p-form-mark { height: 44px; }');
  });
  it("parts one row from the next by the hairline, in the table and the stacked rows, the first row keeping the line", () => {
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-lb tbody tr + tr > :is(th, td) { border-top-color: var(--d1p-hair); }');
    expect(css).toContain('.d1p[data-page="leaderboard"] .d1p-rows > li + li { border-top-color: var(--d1p-hair); }');
  });
  it("scopes every quieter-pass rule to the Leaderboard, so the front page, Matches and Rules keep the shared stamp and row lines", () => {
    const own = rules.filter(rule => /d1p-form-mark|tr \+ tr|li \+ li/.test(rule) && rule.includes("data-page"));
    expect(own.length).toBeGreaterThanOrEqual(8);
    for (const rule of own) expect(rule.trim().startsWith('.d1p[data-page="leaderboard"]')).toBe(true);
    expect(css).toMatch(/\.d1p-form-mark \{ position: relative;[^}]*font-size: 12px; font-weight: 700; line-height: 1; color: var\(--aw-ink-2\);/);
    expect(css).toContain('.d1p-form-mark[data-result="W"] { color: var(--aw-ink-bright); }');
    expect(css).toMatch(/\.d1p-form-mark::before \{ content: ""; position: absolute; inset: 0 2px;/);
    expect(css).toContain(".d1p-form-mark::before { inset: 8px 6px; }");
    expect(css).toMatch(/\.d1p-table th, \.d1p-table td \{[^}]*border-top: 1px solid var\(--aw-line\);/);
    expect(css).toMatch(/\.d1p-rows > li \{[^}]*border-top: 1px solid var\(--aw-line\);/);
  });
});

describe("rating ± RD", () => {
  it("shows each rating with ± its RD in whole points on the Antwars Model Index and the public rankings, and none for a row without an RD", async () => {
    const p = page();
    const rows = (mode: string) => new Response(JSON.stringify({ entries: [
      { displayName: `${mode}-sure`, rating: 1662.6, rd: 86.6, ratedMatches: 30 },
      { displayName: `${mode}-new`, rating: 1337.2, rd: 290.23, ratedMatches: 1 },
      { displayName: `${mode}-historical`, rating: 1300, ratedMatches: 12 },
    ] }));
    await p.answer("house-1v1", rows("house"));
    const shown = () => p.root.byClass("c-elo").map(cell => cell.textContent).filter(text => /\d/.test(text));
    // The table cell, then the stacked row (which names the column for screen readers).
    expect(shown()).toEqual(expect.arrayContaining(["1663 ± 87", "1337 ± 290, provisional", "1300", "Rating 1663 ± 87"]));
    // The in-match cyan badge holds the figure and ± RD (RATING_LOOK "badge"), the ± RD in its tip.
    expect(p.root.byClass("d1-elo").map(node => node.textContent)).toEqual(["1663 ± 87", "1337 ± 290", "1300", "1663 ± 87", "1337 ± 290", "1300"]);
    expect(p.root.byClass("d1-elo").map(node => node.children[0]?.tag === "#text" ? node.children[0].textContent : node.textContent))
      .toEqual(["1663", "1337", "1300", "1663", "1337", "1300"]);
    expect(p.root.byClass("d1p-elo-rd").map(node => node.textContent)).toEqual([" ± 87", " ± 290", " ± 87", " ± 290"]);
    expect(p.root.byClass("d1p-rd")).toEqual([]);
    p.choose("Ranked 1v1");
    await p.answer("1v1", rows("public"), undefined, false); await p.answer("1v1", rows("public"));
    expect(p.root.byClass("d1-elo").map(node => node.textContent)).toContain("1663 ± 87");
    p.dispose();
  });
});

describe("the board choice's links", () => {
  function mount(search: string) {
    const urls: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init!.method} ${String(input)} ${String(init!.body)}`);
      return reply(["a"]);
    });
    const port = dom({ search, meta: { "antwar-public-matches": "true" } });
    const dispose = mountLeaderboardPage(port.doc, port.win, { request });
    const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
    const pressed = () => root.byClass("d1p-tab").filter(node => node.getAttribute("aria-pressed") === "true").map(node => node.getAttribute("aria-label"));
    return { root, urls, dispose, pressed };
  }

  it("offers the two ranking groups and no Challenge choice", () => {
    const p = mount("?page=leaderboard");
    expect(p.root.byClass("d1p-board-group").map(group => group.byClass("d1p-kicker")[0]!.textContent)).toEqual(["Antwars Model Index", "Ranked"]);
    expect(p.root.byClass("d1p-tab").map(node => node.getAttribute("aria-label"))).not.toContain("Challenge 1v1");
    p.dispose();
  });

  it("opens the old Challenge link on the opening board, the Antwars Model Index 1v1, reading only that ranking", async () => {
    const p = mount("?page=leaderboard&mode=challenge");
    expect(p.pressed()).toEqual(["Antwars Model Index 1v1"]);
    await vi.waitFor(() => expect(leaderboardCards(p.root).every(card => card.busy === "false")).toBe(true));
    expect(p.urls).toEqual(['POST /api/leaderboard {"limit":50,"mode":"house-1v1"}']);
    expect(leaderboardCards(p.root).map(card => card.section.byClass("d1p-card-title")[0]!.textContent.startsWith("Antwars Model Index · 1v1"))).toEqual([true]);
    expect(p.root.byClass("d1p-challenge")).toEqual([]);
    p.dispose();
  });

  it("leaves an unknown mode link on the opening mode", async () => {
    const p = mount("?page=leaderboard&mode=bogus");
    expect(p.pressed()).toEqual(["Antwars Model Index 1v1"]);
    await vi.waitFor(() => expect(p.urls).toEqual(['POST /api/leaderboard {"limit":50,"mode":"house-1v1"}']));
    p.dispose();
  });
});

describe("no house slug on the rankings", () => {
  it("shows a Benchmark row whose handle has no row as Unlisted model with no badges, never its slug", async () => {
    const p = page();
    await p.answer("house-1v1", new Response(JSON.stringify({ entries: [
      { displayName: "antwars/not-a-row", rating: 1600, ratedMatches: 3, benchmark: true, thinkingLevel: "max", serviceTier: "fast" },
      { displayName: "antwars/mistral-large-4", rating: 1500, ratedMatches: 1, benchmark: true, thinkingLevel: "high", serviceTier: "standard" },
    ] })));
    const card = leaderboardCards(p.root)[0]!.section;
    expect(card.textContent).toContain("Unlisted model");
    expect(card.textContent).toContain("Mistral Large 4");
    expect(card.textContent).not.toMatch(/not-a-row|mistral-large-4|antwars\//);
    const rows = card.all().filter(node => node.tag === "li" || node.tag === "tr").filter(node => node.textContent.includes("Unlisted model"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.byClass("d1p-tag").map(tag => tag.textContent)).toEqual([]);
    p.dispose();
  });

  it("keeps the changed actions, the challenge bubble and Load more, in the cyan button with no slug on or beside them", async () => {
    const p = page();
    await p.answer("house-1v1", new Response(JSON.stringify({ entries: [
      { displayName: "antwars/abliterated-large-v2", rating: 1600, ratedMatches: 3, benchmark: true, thinkingLevel: "max", serviceTier: "standard" },
      { displayName: "antwars/not-a-row", rating: 1500, ratedMatches: 1, benchmark: true, thinkingLevel: "high", serviceTier: "standard" },
    ], next: "c1" })));
    const [card] = leaderboardCards(p.root);
    const bubble = p.root.all().find(node => node.dataset.key === "challenge-new")!;
    expect(card!.more!.classes()).toEqual(["d1-agent-button"]);
    expect([card!.more!.tag, card!.more!.textContent]).toEqual(["button", "Load more"]);
    expect(bubble.classes()).toEqual(["d1-agent-button"]);
    // The card with its foot, and the band holding the bubble: no house slug anywhere on them.
    for (const node of [card!.section, p.root.byClass("d1p-band")[0]!].flatMap(root => [root, ...root.all()])) {
      for (const shown of [node.textContent, node.title, node.getAttribute("aria-label") ?? ""]) expect(shown).not.toMatch(/abliterated-large-v2|not-a-row|antwars\//);
    }
    expect(card!.section.textContent).toContain("Abliterated GLM-5.3");
    p.dispose();
  });
});
