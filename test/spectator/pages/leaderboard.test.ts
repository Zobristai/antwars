// The Archive Leaderboard through its real data owner: the "Loaded hh:mm UTC" freshness line and the badge
// group. Not rendering or visual evidence: whether the badges stay on one line at ~1200 px is the served build's to show.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountLeaderboardPage } from "../../../web/src/leaderboard-page/page.ts";
import { PAGE_WORDS } from "../../../web/src/ui/pages.ts";
import { baselineTable } from "../../../src/rating/vanillaBaseline.ts";
import { houseDisplayName } from "../../../src/rating/houseLabels.ts";
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
    const index = leaderboardCards(p.root)[0]!.section;
    const groups = index.byClass("d1p-tags");
    // Two rows, each drawn in the table and the stacked list.
    expect(groups.map(group => group.children.map(tag => tag.textContent))).toEqual([["max", "Fast"], ["high"], ["max", "Fast"], ["high"]]);
    expect(groups.every(group => group.children.every(tag => tag.classes().includes("d1p-tag")))).toBe(true);
    expect(index.byClass("d1p-tag").every(tag => tag.parent!.classes().includes("d1p-tags"))).toBe(true);
    p.dispose();
  });
});

describe("the band and its cyan Refresh", () => {
  it("holds the title, Refresh, Loaded and the board choice in the band, and only Refresh carries the cyan class", async () => {
    const p = page();
    const band = p.root.byClass("d1p-band")[0]!;
    expect(band.byClass("d1p-title")).toHaveLength(1);
    expect(band.byClass("d1p-loaded")).toHaveLength(1);
    // Both ranking groups' four sizes, then Challenge's one choice.
    expect(band.byClass("d1p-tab")).toHaveLength(9);
    expect(p.root.byClass("d1p-rail")).toHaveLength(0);
    expect(p.root.byClass("d1p-refresh").map(node => node.textContent)).toEqual([PAGE_WORDS.refresh]);
    expect(band.all().includes(p.root.byClass("d1p-refresh")[0]!)).toBe(true);
    p.dispose();
  });

  it("holds the challenge bubble under Refresh, its words exactly, the cyan button to the Challenge choice keeping the board", () => {
    const port = dom({ search: "?page=leaderboard&board=2d", meta: { "antwar-public-matches": "true" } });
    const dispose = mountLeaderboardPage(port.doc, port.win, { request: vi.fn(() => new Promise<Response>(() => {})) });
    const summary = port.body.all().find(node => node.id === "aw-leaderboard-page")!.byClass("d1p-summary")[0]!;
    const row = summary.children[2]!;
    expect(summary.children.map(node => node.className)).toEqual(["d1p-title", "d1p-fresh", "d1p-fresh"]);
    expect(row.hidden).toBe(false);
    const bubble = row.children[0]!;
    expect([bubble.tag, bubble.className, bubble.dataset.key]).toEqual(["a", "d1-agent-button", "challenge-new"]);
    // Its words wrap inside the cyan button on a narrow phone; the grey bubble's rule is gone from ui/ui.css.
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toContain('.d1p .d1-agent-button[data-key="challenge-new"] { white-space: normal;');
    expect(readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8")).not.toContain("challenge-new");
    expect(bubble.textContent).toBe("NEW: Your agent can challenge the top models");
    expect(bubble.href).toBe("/?page=leaderboard&mode=challenge&board=2d");
    dispose();
  });

  it("drops the challenge bubble with the board choice where the public leaderboard is not enabled", () => {
    const port = dom({ search: "?page=leaderboard" });
    const dispose = mountLeaderboardPage(port.doc, port.win, { request: vi.fn(() => new Promise<Response>(() => {})) });
    const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
    expect(root.byClass("d1p-boards")[0]!.hidden).toBe(true);
    expect(root.all().find(node => node.dataset.key === "challenge-new")!.parentElement!.hidden).toBe(true);
    dispose();
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
    // The Antwars Model Index card; the vanilla baseline beside it draws its own rows.
    const index = leaderboardCards(p.root)[0]!.section;
    const shown = () => index.byClass("c-elo").map(cell => cell.textContent).filter(text => /\d/.test(text));
    // The table cell, then the stacked row (which names the column for screen readers).
    expect(shown()).toEqual(expect.arrayContaining(["1663 ± 87", "1337 ± 290, provisional", "1300", "Rating 1663 ± 87"]));
    // The in-match cyan badge holds the figure and ± RD (RATING_LOOK "badge"), the ± RD in its tip.
    expect(index.byClass("d1-elo").map(node => node.textContent)).toEqual(["1663 ± 87", "1337 ± 290", "1300", "1663 ± 87", "1337 ± 290", "1300"]);
    expect(index.byClass("d1-elo").map(node => node.children[0]?.tag === "#text" ? node.children[0].textContent : node.textContent))
      .toEqual(["1663", "1337", "1300", "1663", "1337", "1300"]);
    expect(index.byClass("d1p-elo-rd").map(node => node.textContent)).toEqual([" ± 87", " ± 290", " ± 87", " ± 290"]);
    expect(p.root.byClass("d1p-rd")).toEqual([]);
    p.choose("Ranked 1v1");
    await p.answer("1v1", rows("public"), undefined, false); await p.answer("1v1", rows("public"));
    expect(p.root.byClass("d1-elo").map(node => node.textContent)).toContain("1663 ± 87");
    p.dispose();
  });
});

describe("the Challenge choice", () => {
  // Keyed by URL: the Challenge list is POST /api/list_challenge_opponents plus the Antwars Model Index 1v1 ranking it follows.
  const opponents = [
    { handle: "antwars/claude-opus-5-5", displayName: "Claude Opus 5.5", level: "high", tier: null, available: true, reason: null },
    { handle: "antwars/claude-opus-5-5-low", displayName: "Claude Opus 5.5", level: "low", tier: null, available: false, reason: "marked unavailable by the house owner" },
    { handle: "antwars/gpt-6-astra", displayName: "GPT-6 Astra", level: "max", tier: "fast", available: true, reason: null },
    { handle: "antwars/glm-5-3-highspeed", displayName: "GLM-5.3 Highspeed", level: null, tier: null, available: false, reason: "last launch failed" },
    { handle: "antwars/mistral-large-latest", displayName: "Mistral Large", level: null, tier: null, available: true, reason: null },
  ];
  const listed = () => new Response(JSON.stringify({ opponents, allowanceLeft: 20, resetsAt: 0 }));
  /** The Model Index 1v1 in two pages: an unlisted handle, and ratings in the ranking's own case. */
  const index = (body: { cursor?: string }) => new Response(JSON.stringify(body.cursor === undefined
    ? { entries: [{ displayName: "antwars/gpt-6-astra", rating: 1612, ratedMatches: 14 }, { displayName: "antwars/not-listed", rating: 1590, ratedMatches: 12 }], next: "page-2" }
    : { entries: [{ displayName: "Antwars/Mistral-Large-Latest", rating: 1540, ratedMatches: 3 }, { displayName: "antwars/claude-opus-5-5-low", rating: 1533, ratedMatches: 11 },
      { displayName: "antwars/claude-opus-5-5", rating: 1501, ratedMatches: 12 }] }));
  function mount(search: string, list: () => Response, ranking: (body: { mode?: string; cursor?: string }) => Response = index) {
    const urls: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init!.method} ${String(input)} ${String(init!.body)}`);
      if (String(input) === "/api/list_challenge_opponents") return list();
      const body = JSON.parse(String(init!.body)) as { mode?: string; cursor?: string };
      return body.mode === "house-1v1" ? ranking(body) : reply(["ranked"]);
    });
    const port = dom({ search, meta: { "antwar-public-matches": "true" } });
    const dispose = mountLeaderboardPage(port.doc, port.win, { request });
    const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
    const card = () => root.byClass("d1p-challenge")[0];
    const items = () => card()!.all().filter(node => node.tag === "li");
    const rows = () => items().map(item => ({
      lines: item.byClass("d1p-line").map(line => line.textContent),
      badges: item.byClass("d1p-tag").map(tag => tag.textContent),
      rating: item.byClass("d1p-elo-badge").map(badge => badge.textContent),
    }));
    const pressed = () => root.byClass("d1p-tab").filter(node => node.getAttribute("aria-pressed") === "true").map(node => node.getAttribute("aria-label"));
    const choose = (label: string) => root.byClass("d1p-tab").find(node => node.getAttribute("aria-label") === label)!.click();
    return { root, urls, dispose, card, items, rows, pressed, choose };
  }

  it("is the third group, after both ranking groups, and its link opens on it and reads the house handle list and the whole Model Index 1v1", async () => {
    const p = mount("?page=leaderboard&mode=challenge", listed);
    expect(p.root.byClass("d1p-board-group").map(group => group.byClass("d1p-kicker")[0]!.textContent)).toEqual(["Antwars Model Index", "Ranked", "Challenge"]);
    expect(p.pressed()).toEqual(["Challenge 1v1"]);
    await vi.waitFor(() => expect(p.card()?.getAttribute("aria-busy")).toBe("false"));
    expect(p.urls).toEqual([
      "POST /api/list_challenge_opponents {}", 'POST /api/leaderboard {"limit":50,"mode":"house-1v1"}',
      'POST /api/leaderboard {"limit":50,"mode":"house-1v1","cursor":"page-2"}']);
    expect(p.root.byClass("d1p-card-title").map(node => node.textContent)).toEqual(["Challenge · 1v1"]);
    expect(p.card()!.byClass("d1p-state")[0]!.textContent).toBe("5 house handles · 3 available");
    p.dispose();
  });

  it("draws each row in the shared style, in Model Index 1v1 order with its rating badge, unrated handles last, unavailable ones badged in place", async () => {
    const p = mount("?page=leaderboard&mode=challenge", listed);
    await vi.waitFor(() => expect(p.card()?.getAttribute("aria-busy")).toBe("false"));
    // Ranked order (antwars/not-listed is not a listed handle, so it has no row), then antwars/glm-5-3-highspeed, which the
    // ranking does not rate. Badges are the list's level and tier through the Model Index rows' own badges, then
    // "unavailable"; antwars/mistral-large-latest's level record holds no level, so it shows none.
    expect(p.rows()).toEqual([
      { lines: ["GPT-6 AstramaxFast", "Ask your agent: challenge antwars/gpt-6-astra on Antwars"], badges: ["max", "Fast"], rating: ["1612"] },
      { lines: ["Mistral Large", "Ask your agent: challenge antwars/mistral-large-latest on Antwars"], badges: [], rating: ["1540"] },
      { lines: ["Claude Opus 5.5lowunavailable"], badges: ["low", "unavailable"], rating: ["1533"] },
      { lines: ["Claude Opus 5.5high", "Ask your agent: challenge antwars/claude-opus-5-5 on Antwars"], badges: ["high"], rating: ["1501"] },
      { lines: ["GLM-5.3 Highspeedunavailable"], badges: ["unavailable"], rating: [] },
    ]);
    // A provisional rating keeps its word, as on the ranking rows.
    expect(p.items()[1]!.byClass("d1p-prov").map(node => node.textContent)).toEqual(["provisional"]);
    // No handle slug after a name, no meta line, no placeholder; the handle appears only as code in the ask.
    expect(p.card()!.byClass("d1p-think")).toEqual([]);
    expect(p.card()!.byClass("is-meta")).toEqual([]);
    expect(p.card()!.textContent).not.toMatch(/not set|Level |Tier /);
    expect(p.card()!.all().filter(node => node.tag === "code").map(node => node.textContent))
      .toEqual(["antwars/gpt-6-astra", "antwars/mistral-large-latest", "antwars/claude-opus-5-5"]);
    // The handle is the command the agent types, in the agent URL's command style, and nowhere else on the row; the row's
    // name is its display name.
    expect(p.card()!.all().filter(node => node.tag === "code").map(node => node.className)).toEqual(["aw-byoa-url", "aw-byoa-url", "aw-byoa-url"]);
    for (const item of p.items()) {
      expect(item.byClass("is-lead")[0]!.textContent).not.toMatch(/antwars\//);
      let rest = item.textContent;
      for (const code of item.all().filter(node => node.tag === "code")) rest = rest.replace(code.textContent, "");
      expect(rest).not.toMatch(/antwars\//);
    }
    expect(p.card()!.textContent).not.toContain("marked unavailable");
    expect(p.card()!.textContent).not.toContain("last launch failed");
    p.dispose();
  });

  it("says a failed read of either list once, Refresh reads both again, and leaving for a ranking reads that ranking as before", async () => {
    let failList = true, failIndex = false;
    const p = mount("?page=leaderboard&mode=challenge",
      () => failList ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ opponents: [] })),
      body => failIndex ? new Response("unavailable", { status: 503 }) : index(body));
    const failed = "The house handle list is unavailable. Refresh the leaderboard to try again.";
    const refresh = () => p.root.all().find(node => node.tag === "button" && node.textContent === PAGE_WORDS.refresh)!.click();
    await vi.waitFor(() => expect(p.card()?.byClass("d1p-state")[0]!.textContent).toBe(failed));
    failList = false; failIndex = true;
    refresh();
    await vi.waitFor(() => expect(p.card()?.getAttribute("aria-busy")).toBe("false"));
    expect(p.card()!.byClass("d1p-state")[0]!.textContent).toBe(failed);
    expect(p.items()).toEqual([]);
    failIndex = false;
    refresh();
    await vi.waitFor(() => expect(p.card()?.byClass("d1p-state")[0]!.textContent).toBe("No house handles listed."));
    const before = p.urls.length;
    p.choose("Ranked 2v2");
    await vi.waitFor(() => expect(leaderboardCards(p.root).every(card => card.busy === "false")).toBe(true));
    expect(p.card()).toBeUndefined();
    expect(p.pressed()).toEqual(["Ranked 2v2"]);
    expect(p.urls.slice(before)).toEqual([
      'POST /api/leaderboard {"limit":50,"mode":"2v2","scope":"house"}', 'POST /api/leaderboard {"limit":50,"mode":"2v2"}']);
    p.dispose();
  });

  it("leaves an unknown mode link on the opening mode", async () => {
    const p = mount("?page=leaderboard&mode=bogus", () => new Response("{}"));
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

describe("the vanilla baseline: rounds 26-30", () => {
  const titles = (root: ElementPort) => leaderboardCards(root).map(card => card.title);
  it("stands beside the Antwars Model Index 1v1, which is unchanged, with the re-rated rows and no read of its own", async () => {
    const p = page();
    await p.answer("house-1v1", reply(["antwars/claude-opus-5-5"]));
    expect(titles(p.root)).toEqual(["Antwars Model Index · 1v1", "Vanilla baseline: rounds 26-30"]);
    const [index, baseline] = leaderboardCards(p.root);
    // The index card holds exactly the server's rows, and none of the baseline's.
    expect(index!.count).toBe("1 shown");
    expect(index!.section.textContent).toContain("antwars/claude-opus-5-5");
    expect(index!.section.textContent).not.toContain("Abliterated GLM-5.3");
    const expected = baselineTable();
    const rows = baseline!.section.querySelector("tbody")!.children;
    expect(rows).toHaveLength(expected.length);
    expected.forEach((row, at) => expect(rows[at]!.textContent).toContain(houseDisplayName(row.displayName)));
    expect(baseline!.section.textContent).toContain(`${Math.round(expected[0]!.rating)} ± ${Math.round(expected[0]!.rd)}`);
    expect(baseline!.more).toBeNull();
    p.dispose();
  });

  it("is 1v1 only: the larger Model Index boards and the public rankings show no baseline", async () => {
    const p = page();
    await p.answer("house-1v1", reply(["a"]));
    p.choose("Antwars Model Index 2v2");
    await p.answer("house-2v2", reply(["b"]));
    expect(titles(p.root)).toEqual(["Antwars Model Index · 2v2"]);
    p.choose("Ranked 1v1");
    await p.answer("1v1", reply(["c"]), undefined, false); await p.answer("1v1", reply(["d"]));
    expect(titles(p.root)).not.toContain("Vanilla baseline: rounds 26-30");
    p.dispose();
  });
});
