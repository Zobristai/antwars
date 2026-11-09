import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mountLeaderboardPage } from "../src/leaderboard-page/page.ts";
import { C } from "../src/leaderboard-page/copy.ts";
import { loadRanking, type PageLoader, type RankingView } from "../src/leaderboard-page/view.ts";
import { dispatchPage, isLeaderboardPage, isMatchesPage } from "../src/leaderboard-page/route.ts";
import { type LeaderboardPage } from "../src/leaderboard.ts";
import { INSPIRED_BY_URL } from "../src/story.ts";
import { PAGE_WORDS } from "../src/ui/pages.ts";
import { mountMatches } from "../src/pages/matches.ts";
import { dom, type ElementPort } from "../../test/spectator/pages/dom.ts";
import { leaderboardCards } from "../../test/spectator/pages/archive.ts";

// The Leaderboard and Matches pages draw the Archive; these checks read what it shows.
const ticks = async () => { for (let tick = 0; tick < 10; tick++) await Promise.resolve(); };
type Row = { displayName: string; rating: number; ratedMatches: number; wins?: number; losses?: number; draws?: number; form?: { result: "W" | "L" | "D"; replayId: string | null }[] };
const row = (displayName: string, rating = 1500): Row => ({ displayName, rating, ratedMatches: 2 });
const reply = (entries: Row[], next?: string) => new Response(JSON.stringify({ entries, ...(next ? { next } : {}) }));
const SIZES = ["1v1", "2v2", "3v3", "4v4"] as const;
type Body = { limit: number; mode?: string; scope?: string; cursor?: string };
const sent = (request: { mock: { calls: unknown[][] } }) => request.mock.calls.map(call => String((call[1] as RequestInit).body));
/** A fake server keyed by read ("2v2/house", "2v2", "house-3v3"); a cursor is honoured only by the read that issued it. */
function server(reads: Record<string, (Row[] | "fail")[]>) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as Body;
    const read = body.scope === undefined ? String(body.mode) : `${body.mode}/${body.scope}`;
    const pages = reads[read];
    let at = 0;
    if (body.cursor !== undefined) {
      const [issuer, index] = body.cursor.split("#");
      if (issuer !== read) return new Response("invalid_cursor", { status: 400 });
      at = Number(index);
    }
    const page = pages?.[at];
    if (!pages || !page || page === "fail") return new Response("unavailable", { status: 503 });
    return reply(page, at + 1 < pages.length ? `${read}#${at + 1}` : undefined);
  });
}
function mount(request: typeof fetch, enabled = true) {
  const port = dom({ meta: { "antwar-public-matches": enabled ? "true" : "false" } });
  const waiting = port.doc.createElement("div") as unknown as ElementPort; waiting.id = "aw-waiting"; port.body.append(waiting);
  (port.doc as { title: string }).title = "Spectator";
  const dispose = mountLeaderboardPage(port.doc, port.win, { request });
  const root = port.body.all().find(node => node.id === "aw-leaderboard-page")!;
  const modes = () => root.byClass("d1p-tab");
  const refresh = root.all().find(node => node.tag === "button" && node.textContent === PAGE_WORDS.refresh)!;
  return {
    doc: port.doc as unknown as { title: string }, root, waiting, refresh, dispose, listeners: port.events.listeners,
    shown: () => leaderboardCards(root),
    modes: () => modes().map(node => node.getAttribute("aria-label")),
    pressed: () => modes().filter(node => node.getAttribute("aria-pressed") === "true").map(node => node.getAttribute("aria-label")),
    choose: (label: string) => modes().find(node => node.getAttribute("aria-label") === label)!.click(),
    settled: () => vi.waitFor(() => expect(leaderboardCards(root).every(table => table.busy === "false")).toBe(true)),
  };
}
const publicReads = (modes: readonly string[], house: (mode: string) => Row[], everyone: (mode: string) => Row[]) =>
  Object.fromEntries(modes.flatMap(mode => [[`${mode}/house`, [house(mode)]], [mode, [everyone(mode)]]]));
const MODEL_INDEX = SIZES.map(size => `house-${size}`);
const emptyIndex = Object.fromEntries(MODEL_INDEX.map(mode => [mode, [[]]])) as Record<string, Row[][]>;

describe("leaderboard page mode choice", () => {
  it("opens on the Antwars Model Index 1v1, offers both groups 1v1 to 4v4, and reads each ranked mode's house and everyone rankings separately", async () => {
    const request = server({ ...emptyIndex, ...publicReads(SIZES, mode => [row(`antwars/${mode}-model`, 1600)], mode => [row(`${mode}-player`, 1700), row(`antwars/${mode}-model`, 1600)]) });
    const p = mount(request);
    // Then Challenge, the third choice, which reads no ranking.
    expect(p.modes()).toEqual([...SIZES.map(size => `Antwars Model Index ${size}`), ...SIZES.map(size => `Ranked ${size}`), "Challenge 1v1"]);
    expect(p.pressed()).toEqual(["Antwars Model Index 1v1"]);
    await p.settled();
    expect(sent(request)).toEqual(['{"limit":50,"mode":"house-1v1"}']);
    expect(p.shown().map(table => table.title)).toEqual(["Antwars Model Index · 1v1"]);
    for (const mode of SIZES) {
      const before = request.mock.calls.length;
      p.choose(`Ranked ${mode}`); await p.settled();
      expect(p.pressed()).toEqual([`Ranked ${mode}`]);
      expect(sent(request).slice(before)).toEqual([`{"limit":50,"mode":"${mode}","scope":"house"}`, `{"limit":50,"mode":"${mode}"}`]);
      expect(p.shown().map(table => [table.title, table.names])).toEqual([
        [`Ranked · ${mode} · house models`, [`antwars/${mode}-model`]], [`Ranked · ${mode}`, [`${mode}-player`, `antwars/${mode}-model`]]]);
    }
    for (const [, options] of request.mock.calls) {
      expect(options).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
    }
    p.dispose();
    expect(p.doc.title).toBe("Spectator"); expect(p.root.isConnected).toBe(false); expect(p.listeners.get("pagehide")?.size ?? 0).toBe(0);
  });
  it("fills the house table only from the house-scope read, in server order, never from display names", async () => {
    const request = server({
      ...emptyIndex,
      "1v1/house": [[row("antwars/real", 1600), row("house-owned-plain-name", 1700)]],
      "1v1": [[row("antwars/impostor", 1800), row("house-owned-plain-name", 1700), row("antwars/real", 1600)]],
    });
    const p = mount(request); await p.settled(); p.choose("Ranked 1v1"); await p.settled();
    const [house, everyone] = p.shown();
    expect(house!.names).toEqual(["antwars/real", "house-owned-plain-name"]);
    expect(house!.names).not.toContain("antwars/impostor");
    expect(everyone!.names).toEqual(["antwars/impostor", "house-owned-plain-name", "antwars/real"]);
    p.dispose();
  });
  it("shows exactly the everyone read, house agents included, under a heading that is not \"Everyone else\"", async () => {
    const request = server({
      ...emptyIndex,
      "3v3/house": [[row("antwars/one", 1650)]],
      "3v3": [[row("player", 1700), row("antwars/one", 1650)], [row("antwars/two", 1500), row("other/agent", 1400)]],
    });
    const p = mount(request); await p.settled(); p.choose("Ranked 3v3"); await p.settled();
    let everyone = p.shown()[1]!;
    expect(everyone.settled).toBe("partial"); everyone.more!.click(); await p.settled();
    everyone = p.shown()[1]!;
    expect(everyone.names).toEqual(["player", "antwars/one", "antwars/two", "other/agent"]);
    expect(everyone.title).toBe("Ranked · 3v3");
    expect(p.root.textContent).not.toContain("Everyone else");
    expect(sent(request).at(-1)).toBe('{"limit":50,"mode":"3v3","cursor":"3v3#1"}');
    expect(everyone.settled).toBe("complete"); expect([everyone.count, everyone.state]).toEqual(["4 shown", ""]); expect(everyone.more).toBeNull();
    p.dispose();
  });
  it.each(SIZES)("offers the Antwars Model Index at %s and pages its one ranking to its last entry", async size => {
    const mode = `house-${size}`;
    const pages = [[row("antwars/a", 1700), row("antwars/b", 1650)], [row("antwars/c", 1600)], [row("antwars/d", 1550)]];
    const request = server({ ...emptyIndex, [mode]: pages });
    const p = mount(request); await p.settled();
    if (size !== "1v1") { p.choose("Ranked 1v1"); await p.settled(); p.choose(`Antwars Model Index ${size}`); await p.settled(); }
    expect(p.pressed()).toEqual([`Antwars Model Index ${size}`]);
    const before = sent(request).lastIndexOf(`{"limit":50,"mode":"${mode}"}`);
    for (let page = 1; page < pages.length; page++) {
      const [table] = p.shown();
      expect(table!.settled).toBe("partial"); expect([table!.count, table!.state]).toEqual([`${page + 1} shown`, ""]); expect(table!.more).not.toBeNull();
      table!.more!.click(); await p.settled();
    }
    const tables = p.shown();
    expect(tables).toHaveLength(1);
    expect(tables[0]!.title).toBe(`Antwars Model Index · ${size}`);
    expect(tables[0]!.names).toEqual(["antwars/a", "antwars/b", "antwars/c", "antwars/d"]);
    expect(tables[0]!.settled).toBe("complete"); expect([tables[0]!.count, tables[0]!.state]).toEqual(["4 shown", ""]); expect(tables[0]!.more).toBeNull();
    expect(sent(request).slice(before)).toEqual([`{"limit":50,"mode":"${mode}"}`, `{"limit":50,"mode":"${mode}","cursor":"${mode}#1"}`, `{"limit":50,"mode":"${mode}","cursor":"${mode}#2"}`]);
    p.dispose();
  });
  it("replaces what is shown on a mode change and ignores responses still arriving for the previous mode", async () => {
    const pending: { body: string; signal: AbortSignal; resolve(response: Response): void }[] = [];
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => { pending.push({ body: String(init!.body), signal: init!.signal!, resolve }); }));
    const take = (body: string) => { const at = pending.findIndex(item => item.body === body); expect(at).toBeGreaterThanOrEqual(0); return pending.splice(at, 1)[0]!; };
    const p = mount(request);
    const opening = take('{"limit":50,"mode":"house-1v1"}');
    const first = p.shown().map(table => table.section);
    p.choose("Ranked 2v2");
    expect(opening.signal.aborted).toBe(true);
    expect(first.every(section => !section.isConnected)).toBe(true);
    take('{"limit":50,"mode":"2v2","scope":"house"}').resolve(reply([row("antwars/two-house", 1600)]));
    take('{"limit":50,"mode":"2v2"}').resolve(reply([row("two-player", 1700)], "2v2-next"));
    await p.settled();
    opening.resolve(reply([row("antwars/late-one", 1900)]));
    await ticks();
    expect(p.shown().map(table => [table.title, table.names])).toEqual([["Ranked · 2v2 · house models", ["antwars/two-house"]], ["Ranked · 2v2", ["two-player"]]]);
    // A Load more still in flight for the previous mode is ignored too, across ranked and Model Index modes.
    p.shown()[1]!.more!.click();
    const lateMore = take('{"limit":50,"mode":"2v2","cursor":"2v2-next"}');
    p.choose("Antwars Model Index 3v3");
    expect(lateMore.signal.aborted).toBe(true);
    take('{"limit":50,"mode":"house-3v3"}').resolve(reply([row("antwars/three", 1650)]));
    await p.settled();
    lateMore.resolve(reply([row("late-two", 1300)]));
    await ticks();
    expect(p.shown().map(table => [table.title, table.names])).toEqual([["Antwars Model Index · 3v3", ["antwars/three"]]]);
    expect(p.pressed()).toEqual(["Antwars Model Index 3v3"]);
    expect(pending).toHaveLength(0); p.dispose();
  });
  it("pages, completes and fails the page's house and everyone tables each on its own, without waiting for the other", async () => {
    const pending: { body: string; resolve(response: Response): void }[] = [];
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => { pending.push({ body: String(init!.body), resolve }); }));
    const take = (body: string) => { const at = pending.findIndex(item => item.body === body); expect(at).toBeGreaterThanOrEqual(0); return pending.splice(at, 1)[0]!; };
    const p = mount(request);
    take('{"limit":50,"mode":"house-1v1"}').resolve(reply([]));
    await p.settled(); p.choose("Ranked 1v1");
    const house = () => p.shown()[0]!, everyone = () => p.shown()[1]!;
    expect(p.shown().map(table => table.title)).toEqual(["Ranked · 1v1 · house models", "Ranked · 1v1"]);
    // The house table pages to its own last entry with its own Load more while the everyone read is still out.
    take('{"limit":50,"mode":"1v1","scope":"house"}').resolve(reply([row("antwars/one", 1700)], "house-next"));
    await vi.waitFor(() => expect(house().settled).toBe("partial"));
    expect(everyone().settled).toBe("loading"); expect(everyone().more).toBeNull();
    house().more!.click();
    take('{"limit":50,"mode":"1v1","scope":"house","cursor":"house-next"}').resolve(reply([row("antwars/two", 1600)]));
    await vi.waitFor(() => expect(house().settled).toBe("complete"));
    expect(house().names).toEqual(["antwars/one", "antwars/two"]); expect([house().count, house().state]).toEqual(["2 shown", ""]); expect(house().more).toBeNull();
    expect(everyone().settled).toBe("loading");
    // A failed everyone read leaves the house table showing.
    take('{"limit":50,"mode":"1v1"}').resolve(new Response("unavailable", { status: 503 }));
    await p.settled();
    expect([everyone().settled, everyone().state, everyone().more]).toEqual(["failed", C.tableFailed, null]);
    expect(house().names).toEqual(["antwars/one", "antwars/two"]); expect(house().settled).toBe("complete");
    // And the other way round: a failed house read leaves the everyone table usable to its own last entry.
    p.refresh.click();
    take('{"limit":50,"mode":"1v1","scope":"house"}').resolve(new Response("unavailable", { status: 503 }));
    take('{"limit":50,"mode":"1v1"}').resolve(reply([row("player", 1800)], "everyone-next"));
    await p.settled();
    expect([house().settled, house().state, house().names]).toEqual(["failed", C.tableFailed, []]);
    expect(everyone().settled).toBe("partial"); expect(everyone().more).toMatchObject({ hidden: false, disabled: false });
    everyone().more!.click();
    take('{"limit":50,"mode":"1v1","cursor":"everyone-next"}').resolve(reply([row("antwars/one", 1700)]));
    await p.settled();
    expect(everyone().names).toEqual(["player", "antwars/one"]); expect(everyone().settled).toBe("complete");
    expect(house().settled).toBe("failed"); expect(pending).toHaveLength(0); p.dispose();
  });
  it("keeps the other table usable when one fails, tells failure from empty, and refreshes the chosen mode from a new snapshot", async () => {
    const reads: Record<string, (Row[] | "fail")[]> = { ...emptyIndex, "1v1/house": [[]], "1v1": [[]], "4v4/house": ["fail"], "4v4": [[row("first", 1700)], [row("second", 1600)]] };
    const request = server(reads);
    const p = mount(request); await p.settled();
    p.choose("Ranked 1v1"); await p.settled();
    expect(p.shown().map(table => [table.settled, table.state])).toEqual([["complete", C.tableEmpty], ["complete", C.tableEmpty]]);
    p.choose("Ranked 4v4"); await p.settled();
    let [house, everyone] = p.shown();
    expect([house!.settled, house!.state, house!.more]).toEqual(["failed", C.tableFailed, null]);
    expect(everyone!.settled).toBe("partial");
    everyone!.more!.click(); await p.settled();
    [house, everyone] = p.shown();
    expect(everyone!.names).toEqual(["first", "second"]); expect(everyone!.settled).toBe("complete");
    expect(house!.state).toBe(C.tableFailed);
    reads["4v4/house"] = [[row("antwars/back", 1650)]];
    const before = request.mock.calls.length;
    p.refresh.click(); await p.settled();
    expect(p.pressed()).toEqual(["Ranked 4v4"]);
    expect(sent(request).slice(before)).toEqual(['{"limit":50,"mode":"4v4","scope":"house"}', '{"limit":50,"mode":"4v4"}']);
    expect(p.shown().map(table => [table.names, table.settled])).toEqual([[["antwars/back"], "complete"], [["first"], "partial"]]);
    p.dispose();
  });
  it("renders hostile provider text literally and never renders unexpected fields", async () => {
    const hostile = { ...row("<img onerror=alert(1)>"), identityId: "private-id", modelLabel: "not-supported", key: "secret" } as Row;
    const p = mount(server({ ...emptyIndex, "1v1/house": [[row("antwars/house")]], "1v1": [[hostile]], "house-1v1": [[row("antwars/index")]] })); await p.settled();
    p.choose("Ranked 1v1"); await p.settled();
    expect(p.shown()[1]!.cells).toEqual([["1", "<img onerror=alert(1)>", "1500, provisional", "2", "", ""]]);
    expect(p.root.all().some(node => node.html.includes("onerror"))).toBe(false);
    expect(p.root.textContent).not.toMatch(/private-id|not-supported|secret/);
    expect(p.shown().map(table => table.table!.getAttribute("aria-labelledby"))).toEqual(["d1p-aw-house-ranking", "d1p-aw-everyone-ranking"]);
    p.choose("Antwars Model Index 1v1");
    expect(p.shown().map(table => table.table!.getAttribute("aria-labelledby"))).toEqual(["d1p-aw-house-mode-ranking"]);
    await p.settled(); p.dispose();
  });
  it("aborts and ignores late responses on page exit", async () => {
    const resolvers: ((response: Response) => void)[] = [];
    const request = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(done => { resolvers.push(done); }));
    const p = mount(request); const tables = p.shown();
    p.listeners.get("pagehide")!.forEach(listener => listener({}));
    for (const resolve of resolvers) resolve(reply([row("late")]));
    await ticks();
    expect(p.root.isConnected).toBe(false); expect(tables.every(table => !table.section.isConnected)).toBe(true);
    expect(p.root.textContent).not.toContain("late");
    expect(request.mock.calls.every(call => call[1]!.signal!.aborted)).toBe(true);
  });
  it("does not fetch when public-matches capability is disabled", () => {
    const request = vi.fn(); const p = mount(request, false);
    expect(request).not.toHaveBeenCalled(); expect(p.root.byClass("d1p-notice")[0]!.textContent).toContain("not enabled");
    expect(p.root.byClass("d1p-fresh")[0]!.hidden).toBe(true);
    expect(p.shown()).toHaveLength(0); expect(p.root.byClass("d1p-boards")[0]!.hidden).toBe(true); p.dispose();
  });
  it("keeps the page in one main landmark", () => {
    const p = mount(server({ ...emptyIndex }));
    expect(p.root.querySelectorAll("main")).toHaveLength(1); p.dispose();
  });
  it("shows no lobby, queue or account surface", async () => {
    const p = mount(server({ ...emptyIndex })); await p.settled();
    expect(p.root.textContent).not.toMatch(/lobb|queue|account|sign in|username/i);
    expect(p.root.querySelectorAll("a").map(link => link.href)).toEqual(["/?watch=1", "/?page=matches", "/?page=leaderboard", "/?page=leaderboard&mode=challenge", "/rules", INSPIRED_BY_URL]); p.dispose();
  });
});

function controlledLoader() {
  const calls: { cursor: string | undefined; signal: AbortSignal; resolve(page: LeaderboardPage): void; reject(error: unknown): void }[] = [];
  const load = vi.fn<PageLoader>((cursor, signal) => new Promise<LeaderboardPage>((resolve, reject) => { calls.push({ cursor, signal, resolve, reject }); }));
  return { load, calls };
}
/** One headless ranking and every view it has published, newest last. */
function ranking(id: string, load: PageLoader) {
  const views: RankingView[] = [];
  const handle = loadRanking({ title: id, id, load }, view => views.push(view));
  return { handle, views, last: () => views.at(-1)!, names: () => views.at(-1)!.rows.map(entry => entry.displayName) };
}
const page = (names: string[], next?: string): LeaderboardPage => ({ entries: names.map(name => ({ ...row(name), thinkingLevel: null, serviceTier: null, benchmark: false, tally: null, form: [] })), ...(next ? { next } : {}) });
const settled = () => new Promise(resolve => setTimeout(resolve, 0));
function twoTables() {
  const houseLoad = controlledLoader(), everyoneLoad = controlledLoader();
  return { houseLoad, everyoneLoad, house: ranking("aw-house-ranking", houseLoad.load), everyone: ranking("aw-everyone-ranking", everyoneLoad.load) };
}

describe("independently paging ranking", () => {
  it("pages each ranking to its own last entry with its own Load more and completes it without waiting for the other", async () => {
    const { house, everyone, houseLoad, everyoneLoad } = twoTables();
    expect(houseLoad.calls.map(call => call.cursor)).toEqual([undefined]);
    expect(everyoneLoad.calls.map(call => call.cursor)).toEqual([undefined]);
    expect(house.last()).toMatchObject({ id: "aw-house-ranking", status: "loading", rows: [], next: undefined });

    houseLoad.calls[0]!.resolve(page(["<img onerror=alert(1)>", "house/two"], "house-next")); await settled();
    expect(house.names()).toEqual(["<img onerror=alert(1)>", "house/two"]);
    expect(house.last()).toMatchObject({ status: "ready", next: "house-next" });
    house.handle.more(); house.handle.more();
    expect(houseLoad.calls.map(call => call.cursor)).toEqual([undefined, "house-next"]);
    houseLoad.calls[1]!.resolve(page(["house/three"])); await settled();
    expect(house.names()).toEqual(["<img onerror=alert(1)>", "house/two", "house/three"]);
    expect(house.last()).toMatchObject({ status: "ready", next: undefined });
    house.handle.more();
    expect(houseLoad.load).toHaveBeenCalledTimes(2);

    // The house ranking finished while the everyone ranking is still on its first read.
    expect(everyone.last().status).toBe("loading");
    everyoneLoad.calls[0]!.resolve(page(["everyone/one"], "everyone-next")); await settled();
    everyone.handle.more();
    expect(everyoneLoad.calls.map(call => call.cursor)).toEqual([undefined, "everyone-next"]);
    everyoneLoad.calls[1]!.resolve(page(["everyone/two"])); await settled();
    expect(everyone.names()).toEqual(["everyone/one", "everyone/two"]); expect(everyone.last()).toMatchObject({ status: "ready", next: undefined });
  });
  it("keeps a failed ranking's rows and stops it while the other stays usable", async () => {
    const { house, everyone, houseLoad, everyoneLoad } = twoTables();
    houseLoad.calls[0]!.resolve(page(["house/one"], "house-next"));
    everyoneLoad.calls[0]!.resolve(page(["everyone/one"], "everyone-next")); await settled();
    house.handle.more(); houseLoad.calls[1]!.reject(new Error("503")); await settled();
    expect(house.names()).toEqual(["house/one"]); expect(house.last()).toMatchObject({ status: "error", next: undefined });
    house.handle.more(); expect(houseLoad.load).toHaveBeenCalledTimes(2);
    everyone.handle.more(); everyoneLoad.calls[1]!.resolve(page(["everyone/two"])); await settled();
    expect(everyone.names()).toEqual(["everyone/one", "everyone/two"]); expect(everyone.last().status).toBe("ready");
  });
  it("reports a failed first read as an error, never as empty, while the other loads to its end", async () => {
    const { house, everyone, houseLoad, everyoneLoad } = twoTables();
    houseLoad.calls[0]!.reject(new Error("offline")); await settled();
    expect(house.last()).toMatchObject({ status: "error", rows: [] });
    expect(everyone.last().status).toBe("loading");
    everyoneLoad.calls[0]!.resolve(page([])); await settled();
    expect(everyone.last()).toMatchObject({ status: "ready", rows: [], next: undefined });
  });
  it("destroy aborts only its own read and ignores its late response", async () => {
    const { house, everyone, houseLoad, everyoneLoad } = twoTables();
    house.handle.destroy();
    expect(houseLoad.calls[0]!.signal.aborted).toBe(true);
    const published = house.views.length;
    houseLoad.calls[0]!.resolve(page(["late"], "late-next")); await settled();
    expect(house.views).toHaveLength(published);
    expect(everyoneLoad.calls[0]!.signal.aborted).toBe(false);
    everyoneLoad.calls[0]!.resolve(page(["everyone/one"])); await settled();
    expect(everyone.names()).toEqual(["everyone/one"]);
  });
});

describe("independent entry wiring", () => {
  it("dispatches leaderboard without loading the spectator module", async () => {
    const starts = { leaderboard: vi.fn(async () => {}), matches: vi.fn(async () => {}), landing: vi.fn(async () => {}), spectator: vi.fn(async () => {}) };
    await dispatchPage(new URL("http://example.test/?page=leaderboard&lobby=private#invite=secret"), starts);
    expect(starts.leaderboard).toHaveBeenCalledOnce(); expect(starts.matches).not.toHaveBeenCalled(); expect(starts.landing).not.toHaveBeenCalled(); expect(starts.spectator).not.toHaveBeenCalled();
    expect(isLeaderboardPage(new URL("http://example.test/other?page=leaderboard"))).toBe(false);
  });
  it("puts the Matches page in one main landmark", () => {
    const port = dom();
    const host = port.doc.createElement("div") as unknown as ElementPort; port.body.append(host);
    const page = mountMatches(port.doc, host as unknown as HTMLElement, { refresh() {}, more() {} });
    expect(host.querySelectorAll("main")).toHaveLength(1); page.destroy();
  });
  it("dispatches matches without loading the spectator module", async () => {
    const starts = { leaderboard: vi.fn(async () => {}), matches: vi.fn(async () => {}), landing: vi.fn(async () => {}), spectator: vi.fn(async () => {}) };
    await dispatchPage(new URL("http://example.test/?page=matches&board=2d"), starts);
    expect(starts.matches).toHaveBeenCalledOnce(); expect(starts.leaderboard).not.toHaveBeenCalled(); expect(starts.landing).not.toHaveBeenCalled(); expect(starts.spectator).not.toHaveBeenCalled();
    expect(isMatchesPage(new URL("http://example.test/other?page=matches"))).toBe(false);
  });
  const route = async (path: string) => {
    const order: string[] = [];
    await dispatchPage(new URL(path, "http://example.test"), { leaderboard: async () => { order.push("leaderboard"); }, matches: async () => { order.push("matches"); }, landing: async () => { order.push("landing"); }, spectator: async () => { order.push("spectator"); } });
    return order;
  };
  // The bare front page is the landing; every watch, lobby, replay, recording or capture link keeps the viewer.
  it.each(["/", "/index.html", "/?board=2d", "/?board=3d"])("opens the landing, not the spectator module, for %s", async path => {
    expect(await route(path)).toEqual(["landing"]);
  });
  it.each(["/?watch=1", "/?watch=1&board=2d", "/?replay", "/?replay=2026-10-28T02-56-44-192Z-130372309286179", "/?lobby=example&watch=1", "/?lobby=example#invite=secret", "/?recording=finer-grid&capture=1", "/?capture=1", "/?page=other"])("keeps the spectator module for %s", async path => {
    expect(await route(path)).toEqual(["spectator"]);
  });
  it("wires only the new dispatcher, retaining literal existing module imports", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('src="./src/leaderboard-page/entry.ts"');
    const entry = readFileSync(new URL("../src/leaderboard-page/entry.ts", import.meta.url), "utf8");
    expect(entry).not.toContain("lobby-controls"); expect(entry).toContain('import("../main.ts")');
    expect(entry).not.toContain("houseUsername");
  });
});

describe("record and last-5 form columns", () => {
  const REPLAY = "2026-10-26T08-00-00-000Z-3";
  const played = (displayName: string, rating: number, wins: number, losses: number, draws: number, letters: string, replays: Record<number, string> = {}): Row => ({
    displayName, rating, ratedMatches: wins + losses + draws, wins, losses, draws,
    form: ([...letters] as ("W" | "L" | "D")[]).map((result, index) => ({ result, replayId: replays[index] ?? null })),
  });
  const rows = () => [
    played("antwars/linked", 1700, 7, 3, 0, "WLWWL", { 0: REPLAY, 3: "2026-10-26T07-00-00-000Z-1" }),
    played("drawer", 1600, 2, 1, 1, "DLW"),
    { ...row("not-reconciled", 1500), ratedMatches: 4 },
  ];
  const formCell = (line: ElementPort) => line.children[5]!.children.map(mark => ({
    tag: mark.tag, text: mark.children[0]!.textContent, href: mark.href, label: mark.children[1]!.textContent, result: mark.dataset.result,
  }));
  const tables = (p: ReturnType<typeof mount>) => p.shown().map(table => ({
    head: table.table!.querySelector("thead")!.querySelectorAll("th").map(cell => cell.textContent),
    cells: table.cells.map(cells => cells.slice(2, 5)),
    letters: table.table!.querySelector("tbody")!.children.map(line => line.children[5]!.children.map(mark => mark.children[0]!.textContent).join("")),
  }));
  const expected = {
    head: ["#Rank", "Model", "Rating", "Matches", "W–LWins and losses", "Last 5"],
    // wins–losses; draws only for a player who has any; empty, never partial, without a reconciled record.
    cells: [["1700", "10", "7–3"], ["1600, provisional", "4", "2–1–1"], ["1500, provisional", "4", ""]],
    letters: ["WLWWL", "DLW", ""],
  };

  it("shows Record beside Rated matches and Last 5 on the house, everyone and Antwars Model Index tables", async () => {
    const p = mount(server({ ...emptyIndex, "1v1/house": [rows()], "1v1": [rows()], "house-1v1": [rows()] })); await p.settled();
    expect(tables(p)).toEqual([expected]);
    p.choose("Ranked 1v1"); await p.settled();
    expect(tables(p)).toEqual([expected, expected]);
    p.dispose();
  });

  it("links a mark to its replay only when a replay id is stored, newest first, and shows the rest unlinked", async () => {
    const p = mount(server({ ...emptyIndex, "house-1v1": [rows()] })); await p.settled();
    const [linked, drawer] = p.shown()[0]!.table!.querySelector("tbody")!.children;
    expect(formCell(linked!)).toEqual([
      { tag: "a", text: "W", href: `/?replay=${REPLAY}`, label: "Win, watch replay", result: "W" },
      { tag: "span", text: "L", href: "", label: "Loss", result: "L" },
      { tag: "span", text: "W", href: "", label: "Win", result: "W" },
      { tag: "a", text: "W", href: "/?replay=2026-10-26T07-00-00-000Z-1", label: "Win, watch replay", result: "W" },
      { tag: "span", text: "L", href: "", label: "Loss", result: "L" },
    ]);
    expect(formCell(drawer!).map(mark => mark.label)).toEqual(["Draw", "Loss", "Win"]);
    p.dispose();
  });
});
