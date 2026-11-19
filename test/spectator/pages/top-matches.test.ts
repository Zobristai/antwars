// The Watch page's top matches with no live match, drawn as the design system's Top matches tiles: each tile is one link to
// its replay and nothing on it plays; every tile has the same five rows in the same order (type, winner, other side, how it
// ended, date with length); no rating is drawn; a builder is shown by its name as stored; a side fielding two seats says so;
// and the page says why no live match shows. Test DOM only: never visual evidence.
import { afterEach, describe, expect, it, vi } from "vitest";
import { topMatchTile } from "../../../web/src/design-system/top-match-tile.ts";
import type { Recording } from "../../../web/src/matches-page/data.ts";
import { ALL_RECORDINGS_HREF, TOP_RETRY_MS, TOP_STATE, TOP_WORDS, mountTopMatchesPage } from "../../../web/src/pages/top-matches.ts";
import { dom, type ElementPort } from "./dom.ts";

type Seat = Recording["seats"][number];
const rated = { rating: 1834.4, rd: 80, ratedMatches: 12 };
const seat = (seatIndex: number, colony: 0 | 1, handle: string, o: Partial<Seat> = {}): Seat =>
  ({ seat: seatIndex, colony, modelLabel: null, thinkingLevel: null, serviceTier: null, handle, startRating: rated, ...o });
const recording = (o: Partial<Recording> = {}): Recording => ({
  id: "2026-11-11T10-34-00-000Z-1", startedAt: "2026-11-11T10:34:00.000Z", endedAt: null, simulationEndedAt: "2026-11-11T11:19:30.000Z",
  winner: 1, reason: "queens_killed", decidedBy: "queens_killed", status: "complete", unavailable: [], matchType: { kind: "index", size: 1 },
  seats: [seat(0, 0, "antwars/gpt-6-1-terra-max-fast"), seat(1, 1, "antwars/gpt-6-2-astra-low")],
  ...o,
});
const teamMatch = (): Recording => recording({
  matchType: { kind: "index", size: 2 },
  seats: [0, 1, 2, 3].map(index => seat(index, index % 2 === 0 ? 0 : 1, index % 2 === 0 ? "antwars/gpt-6-astra" : "antwars/k3-1-pro-highspeed")),
});
const text = (node: ElementPort) => node.textContent;
const tagged = (node: ElementPort, tag: string) => node.all().filter(child => child.tag === tag);
const link = (tile: ElementPort) => tagged(tile, "a")[0]!;
const ROWS = ["aw-meta", "aw-player", "aw-player", "aw-how", "aw-date"];
/** The tile's rows, in order, by their kind. */
const rowKinds = (tile: ElementPort) => link(tile).children.map(row => ROWS.find(kind => row.classes().includes(kind)) ?? row.className);

describe("a top-match tile", () => {
  it("is one link to its replay, keeping the board, with no media to play", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording(), "?board=2d") as unknown as ElementPort;
    expect(tagged(tile, "a")).toHaveLength(1);
    expect(link(tile).href).toBe("/?replay=2026-11-11T10-34-00-000Z-1&board=2d");
    expect([...tagged(tile, "video"), ...tagged(tile, "img"), ...tagged(tile, "canvas"), ...tagged(tile, "button")]).toEqual([]);
  });

  it("has the five rows in order, the winner first on its colony's band, and no rating anywhere", () => {
    const { doc } = dom();
    for (const r of [recording(), teamMatch(), recording({ winner: null, reason: "time", decidedBy: "time" })]) {
      const tile = topMatchTile(doc, r, "") as unknown as ElementPort;
      expect(rowKinds(tile)).toEqual(ROWS);
      expect(text(tile)).not.toMatch(/1834|1500/);
      expect(link(tile).getAttribute("aria-label")).not.toMatch(/1834|1500/);
    }
    const tile = topMatchTile(doc, recording(), "") as unknown as ElementPort;
    const players = tile.byClass("aw-player");
    expect(players.map(p => p.classes().includes("is-winner"))).toEqual([true, false]);
    expect(players.map(text)).toEqual(["GPT-6.2 Astralow", "GPT-6.1 Terramax"]);
    expect(link(tile).style.getPropertyValue("--tile-accent")).not.toBe("");
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Index · 1v1"]);
    expect(tile.byClass("aw-how").map(text)).toEqual(["Queens killed"]);
    expect(tile.byClass("aw-date").map(text)).toEqual(["11 Nov 202646 min"]);
  });

  it("shows a retired model's mark only in the tile's accessible name and tooltip, and Fast as a bolt in the effort badge", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording(), "") as unknown as ElementPort;
    expect(text(tile).toLowerCase()).not.toContain("retired");
    expect(tile.byClass("aw-badge")[0]!.byClass("aw-bolt")).toHaveLength(1);
    const label = link(tile).getAttribute("aria-label")!;
    expect(label).toContain("GPT-6.2 Astra (low, Fast, retired model) beat GPT-6.1 Terra");
    expect(link(tile).title).toBe(label);
  });

  it("shows a builder by its name exactly as stored, in bold before the model", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({
      seats: [seat(0, 0, "antwars/gpt-6-1-terra-max-fast"), seat(1, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra" })],
    }), "") as unknown as ElementPort;
    const winner = tile.byClass("aw-player")[0]!;
    expect(tagged(winner, "b").map(text)).toEqual(["Kain"]);
    expect(winner.byClass("aw-name")[0]!.textContent.startsWith("Kain ")).toBe(true);
  });

  it("says a team match fields two seats a side, in the type row and with a seat rule per seat on both lines", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, teamMatch(), "") as unknown as ElementPort;
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Index · 2 seats each"]);
    expect(tile.byClass("aw-player").map(p => p.classes().includes("is-team"))).toEqual([true, true]);
    expect(tile.byClass("aw-player").map(text)).toEqual(["K3.1 Pro Highspeedhigh", "GPT-6 Astramax"]);
    expect(link(tile).getAttribute("aria-label")).toContain("K3.1 Pro Highspeed (high), 2 seats beat GPT-6 Astra (max, Fast), 2 seats");
  });

  it("names every builder on a side whose seats differ, each by its name as stored, as Matches does", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({
      matchType: { kind: "index", size: 2 },
      seats: [seat(0, 0, "antwars/gpt-6-astra"), seat(1, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra" }),
        seat(2, 0, "antwars/gpt-6-astra"), seat(3, 1, "zed_7", { modelLabel: "openai/gpt-6.2-astra" })],
    }), "") as unknown as ElementPort;
    const winner = tile.byClass("aw-player")[0]!;
    expect(winner.byClass("aw-entry")).toHaveLength(2);
    expect(tagged(winner, "b").map(text)).toEqual(["Kain", "zed_7"]);
    expect(text(tile)).not.toMatch(/\+\d/);
    expect(tile.byClass("aw-player")[1]!.byClass("aw-entry")).toEqual([]);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^Kain \S+ and zed_7 \S+, 2 seats beat GPT-6 Astra \(max, Fast\), 2 seats,/);
  });
});

describe("the top-matches page", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const sixteen = () => Array.from({ length: 16 }, (_, index) => recording({ id: `2026-11-11T10-34-00-000Z-${index + 1}` }));

  it("says why no live match shows, draws the 16 tiles it reads in order, and links to all recordings", async () => {
    const port = dom({ search: "?watch=1" });
    const rows = sixteen();
    const request = vi.fn(async () => Response.json({ matches: rows }));
    const page = mountTopMatchesPage(port.doc, port.win, { state: "idle", request });
    const host = port.body.children.at(-1)!;
    expect(host.byClass("d1p-title").map(text)).toEqual([TOP_WORDS.title]);
    expect(host.byClass("d1p-state").map(text)).toEqual([TOP_STATE.idle]);
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(16));
    expect(host.byClass("aw-tile").map(tile => tile.href)).toEqual(rows.map(r => `/?replay=${r.id}`));
    expect(request).toHaveBeenCalledWith("/matches/top", expect.anything());
    expect(host.byClass("d1p-card")).toEqual([]);
    expect(tagged(host.byClass("aw-after")[0]!, "a").map(a => a.href)).toEqual([ALL_RECORDINGS_HREF]);
    page.setState("starting");
    expect(host.byClass("d1p-state").map(text)).toEqual([TOP_STATE.starting]);
    page.destroy();
  });

  it("leaves off a match a colony never joined, as the recordings list does", async () => {
    const port = dom({ search: "?watch=1" });
    const joined = recording({ id: "2026-11-11T10-34-00-000Z-1" }), absent = recording({ id: "2026-11-11T10-34-00-000Z-2", seats: [seat(0, 0, "antwars/gpt-6-astra")] });
    const page = mountTopMatchesPage(port.doc, port.win, { state: "idle", request: vi.fn(async () => Response.json({ matches: [absent, joined] })) });
    const host = port.body.children.at(-1)!;
    await vi.waitFor(() => expect(host.byClass("aw-tile").map(tile => tile.href)).toEqual([`/?replay=${joined.id}`]));
    page.destroy();
  });

  it("says when the top matches cannot be read, and keeps reading until the list arrives", async () => {
    // A server whose list cannot be read answers 503 until it can, then serves the list.
    vi.useFakeTimers();
    const port = dom();
    const rows = sixteen();
    let ready = false;
    const request = vi.fn(async () => ready ? Response.json({ matches: rows }) : new Response(null, { status: 503 }));
    mountTopMatchesPage(port.doc, port.win, { state: "failed", request });
    const host = port.body.children.at(-1)!;
    await vi.advanceTimersByTimeAsync(0);
    expect(host.byClass("aw-status").map(text)).toEqual([TOP_WORDS.failed]);
    expect(host.byClass("d1p-state").map(text)).toEqual([TOP_STATE.failed]);
    await vi.advanceTimersByTimeAsync(TOP_RETRY_MS[0]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(host.byClass("aw-tile")).toHaveLength(0);
    ready = true;
    await vi.advanceTimersByTimeAsync(TOP_RETRY_MS[1]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(host.byClass("aw-tile")).toHaveLength(16);
    expect(host.byClass("aw-status")[0]!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(TOP_RETRY_MS.at(-1)! * 2);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("says there are no top matches yet when the list is empty, and still links to all recordings", async () => {
    const port = dom();
    const request = vi.fn(async () => Response.json({ matches: [] }));
    mountTopMatchesPage(port.doc, port.win, { state: "idle", request });
    const host = port.body.children.at(-1)!;
    await vi.waitFor(() => expect(host.byClass("aw-status").map(text)).toEqual([TOP_WORDS.empty]));
    expect(host.byClass("aw-status")[0]!.hidden).toBe(false);
    expect(host.byClass("aw-tile")).toHaveLength(0);
    expect(tagged(host.byClass("aw-after")[0]!, "a").map(a => a.href)).toEqual([ALL_RECORDINGS_HREF]);
  });

  it("stops reading again once the page is closed", async () => {
    vi.useFakeTimers();
    const port = dom();
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    const page = mountTopMatchesPage(port.doc, port.win, { state: "idle", request });
    await vi.advanceTimersByTimeAsync(0);
    page.destroy();
    await vi.advanceTimersByTimeAsync(TOP_RETRY_MS.at(-1)! * 4);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
