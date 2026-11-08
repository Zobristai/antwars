// The front page: the Field guide hero as built, then the Leaderboard's and the Matches page's own cards,
// mounted through their real data owners on the Archive pages' test DOM port. Not
// rendering or visual evidence: the served build's captures are that.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERO } from "../../../web/src/landing-page/hero/hero.ts";
import { LANDING_COPY } from "../../../web/src/landing-page/copy.ts";
import { heroView, recordedOn } from "../../../web/src/landing-page/model.ts";
import { MATCHES_HREF, RANKINGS_HREF, mountLandingPage } from "../../../web/src/landing-page/page.ts";
import { mountLeaderboardPage } from "../../../web/src/leaderboard-page/page.ts";
import { C } from "../../../web/src/leaderboard-page/copy.ts";
import type { Recording } from "../../../web/src/matches-page/data.ts";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import { EMBLEM_SRC } from "../../../web/src/ui/deck/brand.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const entry = (index: number) => ({ displayName: `player-${index}`, rating: 1800 - index * 10, ratedMatches: 12 });
const saved = (minute: number): Recording => ({
  id: `2026-10-25T00-${String(minute).padStart(2, "0")}-00-000Z-1`, startedAt: `2026-10-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
  endedAt: null, simulationEndedAt: null, winner: 1, reason: "queens_killed", decidedBy: "queens_killed",
  seats: [{ seat: 0, colony: 0, modelLabel: "anthropic/claude-opus-5-5", thinkingLevel: null, serviceTier: null, handle: null }, { seat: 1, colony: 1, modelLabel: "zai/glm-5.3", thinkingLevel: null, serviceTier: null, handle: null }], status: "complete", unavailable: [],
});
type Reply = Response | Promise<Response> | "fail";
/** A request that answers each endpoint as the test says, and records what was asked. */
function server(answers: { leaderboard?: () => Reply; matches?: () => Reply; catalog?: () => Reply } = {}) {
  const asked: { path: string; body: { mode?: string; scope?: string; limit?: number } | null; signal: AbortSignal }[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    asked.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, signal: init!.signal! });
    const reply = path === "/api/leaderboard" ? answers.leaderboard?.() ?? json({ entries: [] })
      : path.startsWith("/matches") ? answers.matches?.() ?? json({ matches: [], nextPageToken: null })
      : answers.catalog?.() ?? json({ matches: [] });
    if (reply === "fail") throw new Error("offline");
    return reply;
  });
  return { request, asked, json };
}
function landing(answers: Parameters<typeof server>[0] = {}, search = "", leaderboard = true) {
  const port = dom({ search, meta: leaderboard ? { "antwar-public-matches": "true" } : {} });
  const api = server(answers);
  const dispose = mountLandingPage(port.doc, port.win, { request: api.request as unknown as typeof fetch });
  const root = port.body.all().find(node => node.id === "aw-landing-page")!;
  const card = (title: string) => root.byClass("d1p-card").find(node => node.querySelector(".d1p-card-title")?.textContent.startsWith(title));
  const state = (title: string) => card(title)!.querySelector(".d1p-state")?.textContent ?? "";
  const count = (title: string) => card(title)!.querySelector(".d1p-count")?.textContent ?? null;
  const rows = (title: string) => card(title)!.querySelector("table")!.querySelector("tbody")!.children;
  const link = (text: string) => root.all().find(node => node.tag === "a" && node.textContent === text)!;
  return { port, root, dispose, card, state, count, rows, link, ...api };
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.useRealTimers(); });

describe("the hero, as designed", () => {
  it("carries the title and subtitle character for character, with \"real time\" held on one line", () => {
    expect(LANDING_COPY.proposition).toBe("Two ant colonies battle for control");
    expect(LANDING_COPY.lede).toBe("Agents command each colony in a real time strategy game of tactics and skill");
    const p = landing();
    expect(p.root.querySelector("h1")!.textContent).toBe(LANDING_COPY.proposition);
    const lede = p.root.querySelector(".fg-lede")!;
    expect(lede.textContent).toBe(LANDING_COPY.lede);
    expect(lede.querySelectorAll(".fg-keep").map(node => node.textContent)).toEqual(["real time"]);
    p.dispose();
  });

  it("sets one frame of a stored match: the phone's portrait crop and the desktop crop, each in the sizes a screen needs", () => {
    const p = landing();
    const picture = p.root.querySelector("picture")!;
    const [source, image] = picture.children as unknown as (ElementPort & Record<string, unknown>)[];
    expect(source!.tag).toBe("source");
    expect(source!.media).toBe("(max-width: 719px)");
    expect(source!.srcset).toBe(HERO.phone.files.map(file => `${file.src} ${file.width}w`).join(", "));
    expect(image!.tag).toBe("img");
    expect(image!.srcset).toBe(HERO.desktop.files.map(file => `${file.src} ${file.width}w`).join(", "));
    expect(image!.src).toBe(HERO.desktop.files[0]!.src);
    expect(image!.alt).toBe(heroView(HERO, "").alt);
    for (const file of [...HERO.phone.files, ...HERO.desktop.files]) {
      const name = file.src.split("/").pop()!.split("?")[0]!;
      expect(readFileSync(new URL(`../../../web/src/landing-page/hero/${name}`, import.meta.url)).subarray(8, 12).toString()).toBe("WEBP");
    }
    p.dispose();
  });

  it("names the frame's recording by map and date, with its Replay", () => {
    expect(recordedOn(HERO.replayId)).toBe("28 Oct 2026");
    const p = landing({}, "?board=2d");
    expect(p.root.querySelector(".fg-recording")!.textContent).toBe("Recorded match on Isthmus · 28 Oct 2026 · Replay");
    expect(p.link("Replay").href).toBe(`/?replay=${HERO.replayId}&board=2d`);
    // The site's cyan row button, as the Recordings card's Replay; landing.css keeps no rule of its own for it.
    expect(p.root.querySelector(".fg-recording")!.querySelector("a")!.className).toBe("d1-agent-button d1p-row-pill");
    const css = readFileSync(new URL("../../../web/src/landing-page/landing.css", import.meta.url), "utf8");
    expect(css).not.toContain("fg-replay");
    // No house slug on the changed line.
    expect(p.root.querySelector(".fg-recording")!.textContent).not.toMatch(/antwars\/|[a-z]+-[a-z0-9]+-[a-z0-9]+/);
    p.dispose();
  });

  it("offers Watch any match and the rankings, and the pages, every one keeping the chosen board", () => {
    const p = landing({}, "?board=2d");
    const watch = p.link(LANDING_COPY.watchAny);
    expect(watch.href).toBe("/?watch=1&board=2d");
    // Watch any match is the site's cyan button (deck.css .d1-agent-button), with no house slug on it, a
    // 44 px tap at every width through the hero actions' --d1-tap; landing.css keeps no .fg-cta rule of its own.
    expect([watch.title, ...Object.values(watch.attrs)].join(" ")).not.toMatch(/antwars\//);
    expect(watch.className).toBe("d1-agent-button");
    expect(watch.textContent).not.toMatch(/antwars\//);
    const css = readFileSync(new URL("../../../web/src/landing-page/landing.css", import.meta.url), "utf8");
    expect(css).toContain(".fg-hero-actions { --d1-tap: 44px; }");
    expect(css).not.toContain("fg-cta");
    expect(p.root.querySelector(".fg-quiet")!.href).toBe("/?page=leaderboard&mode=house-1v1&board=2d");
    const nav = p.root.querySelector("nav")!;
    expect(nav.querySelectorAll("a").map(a => [a.textContent, a.href])).toEqual([
      ["Watch", "/?watch=1&board=2d"], ["Matches", "/?page=matches&board=2d"], ["Leaderboard", "/?page=leaderboard&board=2d"],
    ]);
    // The front page is no tab of its own.
    expect(nav.querySelectorAll("a").some(a => a.hasAttribute("aria-current"))).toBe(false);
    expect(p.root.querySelector(".fg-emblem")!.src).toBe(EMBLEM_SRC);
    p.dispose();
  });

  it("offers the challenge bubble in the hero's actions, the words exactly, the cyan button to the Challenge choice keeping the board", () => {
    const p = landing({}, "?board=2d");
    const actions = p.root.querySelector(".fg-hero-actions")!;
    const bubble = actions.children.find(node => node.dataset.key === "challenge-new")!;
    expect(bubble.tag).toBe("a");
    expect(bubble.textContent).toBe("NEW: Your agent can challenge the top models");
    // The site's cyan button (deck.css .d1-agent-button), with no house slug on it.
    expect(bubble.className).toBe("d1-agent-button");
    expect(bubble.textContent).not.toMatch(/antwars\//);
    expect(bubble.href).toBe("/?page=leaderboard&mode=challenge&board=2d");
    // After Watch any match and Rankings, which are unchanged.
    expect(actions.children.map(node => node.className)).toEqual(["d1-agent-button", "d2-link fg-quiet", "d1-agent-button"]);
    p.dispose();
  });

  it("offers today's MCP address with Copy under Bring your agent, and the pages' footer", () => {
    const p = landing();
    const agent = p.root.querySelector(".fg-agent")!;
    expect(agent.querySelector(".fg-section-title")!.textContent).toBe("Bring your agent");
    expect(agent.querySelector(".aw-byoa-url")!.textContent).toContain("https://antwars.example");
    expect(agent.querySelector(".aw-byoa-copy")).not.toBeNull();
    expect(p.root.querySelector(".fg-foot")!.querySelectorAll("a").map(a => a.textContent)).toEqual(["Rules", LANDING_COPY.inspired]);
    p.dispose();
  });

  it("starts reading at the title, and leaves nothing behind and asks nothing more once closed", async () => {
    const p = landing();
    await settle();
    expect((p.port.doc.activeElement as unknown as ElementPort | null)?.id).toBe("fg-title");
    p.dispose();
    expect(p.root.isConnected).toBe(false);
    expect(p.asked.every(call => call.signal.aborted)).toBe(true);
  });
});

describe("the Leaderboard's and the Matches page's own cards", () => {
  it("shows the top ten of the Antwars Model Index · 1v1 and the newest five recordings, with links to the full pages and no Load more", async () => {
    const p = landing({
      leaderboard: () => new Response(JSON.stringify({ entries: Array.from({ length: 12 }, (_, i) => entry(i)), next: "more" })),
      matches: () => new Response(JSON.stringify({ matches: Array.from({ length: 7 }, (_, i) => saved(i)), nextPageToken: null })),
    });
    await vi.waitFor(() => expect(p.state("Recordings")).not.toContain("Loading"));
    await vi.waitFor(() => expect(p.state(C.houseModeTitle)).not.toContain("Loading"));
    expect(p.asked.find(call => call.path === "/api/leaderboard")!.body).toEqual({ limit: 50, mode: "house-1v1" });
    expect(p.card(C.houseModeTitle)!.querySelector(".d1p-card-title")!.textContent).toBe("Antwars Model Index · 1v1 10 shown");
    expect(p.rows(C.houseModeTitle)).toHaveLength(10);
    expect([p.count(C.houseModeTitle), p.state(C.houseModeTitle)]).toEqual(["10 shown", ""]);
    expect(p.rows("Recordings")).toHaveLength(5);
    expect(p.state("Recordings")).toBe("5 recordings loaded, newest first · more remain");
    expect(p.card(C.houseModeTitle)!.querySelector(".d1p-card-foot")!.querySelectorAll("a").map(a => [a.textContent, a.href])).toEqual([["Leaderboard", RANKINGS_HREF]]);
    expect(p.card("Recordings")!.querySelector(".d1p-card-foot")!.querySelectorAll("a").map(a => [a.textContent, a.href])).toEqual([["Matches", MATCHES_HREF]]);
    expect(p.root.textContent).not.toContain("Load more");
    expect(p.root.all().some(node => node.tag === "button" && node.dataset.key?.startsWith("more"))).toBe(false);
    // Each foot link in the site's cyan button, not the grey pill.
    for (const title of [C.houseModeTitle, "Recordings"]) {
      expect(p.card(title)!.querySelector(".d1p-card-foot")!.querySelectorAll("a").map(a => a.className)).toEqual(["d1-agent-button"]);
    }
    p.dispose();
  });

  it("shows no house slug on either card or its foot link, a house handle by its row", async () => {
    const house = [
      { displayName: "antwars/abliterated-large-v2", rating: 1600, ratedMatches: 3, benchmark: true, thinkingLevel: "max", serviceTier: "standard" },
      { displayName: "antwars/not-a-row", rating: 1500, ratedMatches: 1, benchmark: true, thinkingLevel: "high", serviceTier: "standard" },
    ];
    const recorded: Recording = { ...saved(4), seats: [
      { seat: 0, colony: 0, modelLabel: "abliteration/abliterated-model-large-v2", thinkingLevel: null, serviceTier: null, handle: "antwars/abliterated-large-v2" },
      { seat: 1, colony: 1, modelLabel: "mistral/mistral-large-4", thinkingLevel: "high", serviceTier: null, handle: "antwars/mistral-large-4" },
    ] };
    const p = landing({
      leaderboard: () => new Response(JSON.stringify({ entries: house })),
      matches: () => new Response(JSON.stringify({ matches: [recorded], nextPageToken: null })),
    });
    await vi.waitFor(() => expect(p.state("Recordings")).not.toContain("Loading"));
    await vi.waitFor(() => expect(p.state(C.houseModeTitle)).not.toContain("Loading"));
    expect(p.card(C.houseModeTitle)!.textContent).toContain("Abliterated GLM-5.3");
    expect(p.card("Recordings")!.textContent).toContain("Mistral Large 4");
    const slug = /abliterated-large-v2|abliterated-model-large-v2|mistral-large-4|not-a-row|antwars\//;
    for (const card of [p.card(C.houseModeTitle)!, p.card("Recordings")!, p.root.querySelector(".fg-hero")!]) {
      for (const node of [card, ...card.all()]) {
        for (const shown of [node.textContent, node.title, node.getAttribute("aria-label") ?? ""]) expect(shown).not.toMatch(slug);
      }
    }
    p.dispose();
  });

  it("gives each recording's Replay the site's cyan primary button, as the Matches page does", async () => {
    const p = landing({ matches: () => new Response(JSON.stringify({ matches: [saved(3), saved(2)], nextPageToken: null })) });
    await vi.waitFor(() => expect(p.state("Recordings")).not.toContain("Loading"));
    const replays = p.card("Recordings")!.byClass("d1p-row-pill");
    // Two rows, each in the table and the stacked list.
    expect(replays).toHaveLength(4);
    for (const link of replays) expect([link.textContent, link.className]).toEqual(["Replay", "d1-agent-button d1p-row-pill"]);
    p.dispose();
  });

  it("draws each row as the Leaderboard page and the Matches page draw the same row", async () => {
    const entries = Array.from({ length: 3 }, (_, i) => entry(i)), recordings = [saved(3), saved(2)];
    const p = landing({
      leaderboard: () => new Response(JSON.stringify({ entries })),
      matches: () => new Response(JSON.stringify({ matches: recordings, nextPageToken: null })),
    });
    await vi.waitFor(() => expect(p.state("Recordings")).not.toContain("Loading"));
    await vi.waitFor(() => expect(p.state(C.houseModeTitle)).not.toContain("Loading"));

    const board = dom({ meta: { "antwar-public-matches": "true" } });
    const close = mountLeaderboardPage(board.doc, board.win, { request: (async () => new Response(JSON.stringify({ entries }))) as unknown as typeof fetch });
    const boardRoot = board.body.all().find(node => node.id === "aw-leaderboard-page")!;
    await vi.waitFor(() => expect(boardRoot.byClass("d1p-card")[0]!.getAttribute("aria-busy")).toBe("false"));
    // The whole card, state line, table and stacked rows, matches the page's own wherever nothing is cut; only the landing's
    // link to the full page in the foot is its own.
    const foot = (card: ElementPort) => card.byClass("d1p-card-foot");
    const markup = (card: ElementPort) => card.all().filter(node => !foot(card).some(block => block.contains(node)))
      .map(node => [node.tag, node.className, node.dataset.key ?? "", node.href, node.children.length === 0 ? node.textContent : ""]);
    expect(markup(p.card(C.houseModeTitle)!)).toEqual(markup(boardRoot.byClass("d1p-card")[0]!));
    expect([p.count(C.houseModeTitle), p.state(C.houseModeTitle)]).toEqual(["3 shown", ""]);
    close();

    const matchesPort = dom();
    const host = matchesPort.doc.createElement("div") as unknown as ElementPort; matchesPort.body.append(host);
    const page = mountMatches(matchesPort.doc, host as unknown as HTMLElement, { refresh() {}, more() {} });
    page.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows: recordings }, next: null });
    const theirs = host.byClass("d1p-card").find(node => node.querySelector(".d1p-card-title")!.textContent === "Recordings")!;
    expect(markup(p.card("Recordings")!)).toEqual(markup(theirs));
    page.destroy(); p.dispose();
  });

  it("says loading, empty and unavailable once each, in each card's own words", async () => {
    let releaseBoard!: (response: Response) => void, releaseMatches!: (response: Response) => void;
    const loading = landing({
      leaderboard: () => new Promise<Response>(resolve => { releaseBoard = resolve; }),
      matches: () => new Promise<Response>(resolve => { releaseMatches = resolve; }),
    });
    expect([loading.count(C.houseModeTitle), loading.state(C.houseModeTitle)]).toEqual([null, C.tableLoading]);
    await vi.waitFor(() => expect(loading.state("Recordings")).toBe("Loading recordings…"));
    releaseBoard(new Response(JSON.stringify({ entries: [] }))); releaseMatches(new Response(JSON.stringify({ matches: [], nextPageToken: null })));
    await vi.waitFor(() => expect(loading.state(C.houseModeTitle)).toBe(C.tableEmpty));
    expect(loading.count(C.houseModeTitle)).toBeNull();
    await vi.waitFor(() => expect(loading.state("Recordings")).toBe("No recordings yet"));
    loading.dispose();

    const failed = landing({ leaderboard: () => "fail", matches: () => "fail" });
    await vi.waitFor(() => expect(failed.state(C.houseModeTitle)).toBe(C.tableFailed));
    await vi.waitFor(() => expect(failed.state("Recordings")).toBe("Recordings unavailable. Refresh to try again."));
    expect(failed.root.textContent).not.toContain("Load more");
    failed.dispose();
  });
});

describe("a server without the public leaderboard", () => {
  it("asks for no ranking and draws no Index card, as the Leaderboard page does, and still shows the recordings", async () => {
    const p = landing({}, "", false);
    await vi.waitFor(() => expect(p.state("Recordings")).toBe("No recordings yet"));
    expect(p.card(C.houseModeTitle)).toBeUndefined();
    expect(p.asked.some(call => call.path === "/api/leaderboard")).toBe(false);
    // Nor the challenge bubble, whose Challenge choice is part of that leaderboard.
    expect(p.root.all().some(node => node.dataset.key === "challenge-new")).toBe(false);
    p.dispose();
  });
});

describe("the Leaderboard reads the mode from its link", () => {
  const opened = async (search: string) => {
    const port = dom({ search, meta: { "antwar-public-matches": "true" } });
    const modes: string[] = [];
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      modes.push(JSON.parse(String(init!.body)).mode);
      return new Response(JSON.stringify({ entries: [] }));
    });
    const close = mountLeaderboardPage(port.doc, port.win, { request: request as unknown as typeof fetch });
    const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
    const pressed = root.all().filter(node => node.tag === "button" && node.getAttribute("aria-pressed") === "true").map(node => node.getAttribute("aria-label"));
    close();
    return { modes, pressed };
  };
  it("opens the Antwars Model Index · 1v1 from the landing's link", async () => {
    expect(await opened(`?${RANKINGS_HREF.split("?")[1]}`)).toEqual({ modes: ["house-1v1"], pressed: ["Antwars Model Index 1v1"] });
  });
  it("opens any other listed mode the link names, and the opening mode for none or an unknown one", async () => {
    expect((await opened("?page=leaderboard&mode=2v2")).modes).toEqual(["2v2", "2v2"]);
    expect((await opened("?page=leaderboard")).modes).toEqual(["house-1v1"]);
    expect((await opened("?page=leaderboard&mode=house-9v9")).modes).toEqual(["house-1v1"]);
  });
});
