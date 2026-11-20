// The Watch page's top matches with no live match, drawn as the design system's Top matches tiles: each tile is one link to
// its replay and nothing on it plays; with results shown every tile has the same rows in the same order (type, the players
// block, how it ended, date with length), the players laid out by game type in one tile size; with results hidden, the default, no tile carries any result; no rating is
// drawn; a builder is shown by its name as stored; a side fielding two seats says so; one button shows or hides every
// result and the browser remembers the choice; and the page says why no live match shows. Test DOM only: never visual evidence.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tileEnding, topMatchTile } from "../../../web/src/design-system/top-match-tile.ts";
import type { Recording } from "../../../web/src/matches-page/data.ts";
import { ALL_RECORDINGS_HREF, RESULTS_KEY, TOP_RETRY_MS, TOP_STATE, TOP_WORDS, mountTopMatchesPage } from "../../../web/src/pages/top-matches.ts";
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
const KINDS = [...ROWS, "aw-side"];
/** The players block: every tile has one, holding its player lines. */
const block = (tile: ElementPort) => tile.byClass("aw-lines")[0]!;
/** The tile's rows, in order, by their kind; the players block's lines in its place. */
const rowKinds = (tile: ElementPort) => link(tile).children.flatMap(row => row.classes().includes("aw-lines") ? row.children : [row])
  .map(row => KINDS.find(kind => row.classes().includes(kind)) ?? row.className);

describe("a top-match tile", () => {
  it("is one link to its replay, keeping the board, with no media to play", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording(), "?board=2d", "shown") as unknown as ElementPort;
    expect(tagged(tile, "a")).toHaveLength(1);
    expect(link(tile).href).toBe("/?replay=2026-11-11T10-34-00-000Z-1&board=2d");
    expect([...tagged(tile, "video"), ...tagged(tile, "img"), ...tagged(tile, "canvas"), ...tagged(tile, "button")]).toEqual([]);
  });

  it("has the five rows in order, the winner first on its colony's band, and no rating anywhere", () => {
    const { doc } = dom();
    for (const r of [recording(), teamMatch(), recording({ winner: null, reason: "time", decidedBy: "time" })]) {
      const tile = topMatchTile(doc, r, "", "shown") as unknown as ElementPort;
      expect(rowKinds(tile)).toEqual(ROWS);
      expect(text(tile)).not.toMatch(/1834|1500/);
      expect(link(tile).getAttribute("aria-label")).not.toMatch(/1834|1500/);
    }
    const tile = topMatchTile(doc, recording(), "", "shown") as unknown as ElementPort;
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
    const tile = topMatchTile(doc, recording(), "", "shown") as unknown as ElementPort;
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
    }), "", "shown") as unknown as ElementPort;
    const winner = tile.byClass("aw-player")[0]!;
    expect(tagged(winner, "b").map(text)).toEqual(["Kain"]);
    const name = winner.byClass("aw-name")[0]!;
    expect(name.textContent.startsWith("Kain ")).toBe(true);
    // The model is its own part, with the space after the builder's name, so a too-long line can shorten it first; the
    // name's title keeps both whole.
    expect(name.byClass("aw-model").map(text)).toEqual([" gpt-6.2-astra"]);
    expect(name.title).toBe("Kain gpt-6.2-astra");
    expect(tile.byClass("aw-player")[1]!.byClass("aw-name")[0]!.title).toBe("GPT-6.1 Terra");
  });

  it("shows a badge of more than eight characters as its first eight and an ellipsis, its full text in its title and the tile's name", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({
      seats: [seat(0, 0, "antwars/gpt-6-1-terra-max-fast"), seat(1, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra", thinkingLevel: "overthinking" })],
    }), "", "shown") as unknown as ElementPort;
    const badge = tile.byClass("aw-player")[0]!.byClass("aw-badge")[0]!;
    expect(text(badge)).toBe("overthin\u2026");
    expect(badge.title).toBe("overthinking");
    expect(link(tile).getAttribute("aria-label")).toContain("(overthinking)");
    expect(tile.byClass("aw-player")[1]!.byClass("aw-badge")[0]!.title).toBe("");
  });

  it("says a team match fields two seats a side, in the type row and with a seat rule per seat on both lines", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, teamMatch(), "", "shown") as unknown as ElementPort;
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Index · 2 per side"]);
    expect(tile.byClass("aw-player").map(p => p.classes().includes("is-team"))).toEqual([true, true]);
    expect(tile.byClass("aw-player").map(text)).toEqual(["K3.1 Pro Highspeedhigh", "GPT-6 Astramax"]);
    expect(link(tile).getAttribute("aria-label")).toContain("K3.1 Pro Highspeed (high), 2 seats beat GPT-6 Astra (max, Fast), 2 seats");
  });

  it("keeps a side of three or four alike seats on one line, with one seat mark per seat", () => {
    const { doc } = dom();
    for (const size of [3, 4] as const) {
      const seats = Array.from({ length: size * 2 }, (_, index) =>
        seat(index, index % 2 === 0 ? 0 : 1, index % 2 === 0 ? "antwars/claude-sonnet-5-5" : "antwars/k3-1-pro-highspeed"));
      const tile = topMatchTile(doc, recording({ matchType: { kind: "index", size }, seats }), "", "shown") as unknown as ElementPort;
      expect(rowKinds(tile)).toEqual(ROWS);
      expect(tile.byClass("aw-meta").map(text)).toEqual([`Index · ${size} per side`]);
      expect(tile.byClass("aw-player").map(p => p.classes().filter(c => c === "is-team" || c.startsWith("is-seats-"))))
        .toEqual([["is-team", `is-seats-${size}`], ["is-team", `is-seats-${size}`]]);
      expect(link(tile).getAttribute("aria-label")).toContain(`K3.1 Pro Highspeed (high), ${size} seats beat`);
    }
  });

  it("gives a side whose seats differ one line per seat group, each builder by its name as stored, as Matches does", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({
      matchType: { kind: "index", size: 2 },
      seats: [seat(0, 0, "antwars/gpt-6-astra"), seat(1, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra" }),
        seat(2, 0, "antwars/gpt-6-astra"), seat(3, 1, "zed_7", { modelLabel: "openai/gpt-6.2-astra" })],
    }), "", "shown") as unknown as ElementPort;
    expect(rowKinds(tile)).toEqual(["aw-meta", "aw-side", "aw-player", "aw-how", "aw-date"]);
    // The sides stand one under the other in one block; the side whose seats differ fills the block's two columns.
    expect(block(tile).classes()).toEqual(["aw-lines", "is-sides"]);
    const side = tile.byClass("aw-side")[0]!;
    expect(side.classes()).toContain("is-winner");
    const lines = side.byClass("aw-player");
    expect(lines.map(line => tagged(line, "b").map(text))).toEqual([["Kain"], ["zed_7"]]);
    expect(lines.map(line => line.classes().includes("is-seats-2"))).toEqual([false, false]);
    expect(text(tile)).not.toMatch(/\+\d/);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^Kain \S+ and zed_7 \S+ beat GPT-6 Astra \(max, Fast\), 2 seats, Index · 2 per side,/);
  });

  it("gives a seat group of two seats on such a side two seat rules and its count in the accessible name", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({
      matchType: { kind: "index", size: 3 },
      seats: [seat(0, 0, "antwars/gpt-6-astra"), seat(1, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra" }),
        seat(2, 0, "antwars/gpt-6-astra"), seat(3, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra" }),
        seat(4, 0, "antwars/gpt-6-astra"), seat(5, 1, "zed_7", { modelLabel: "openai/gpt-6.2-astra" })],
    }), "", "shown") as unknown as ElementPort;
    const lines = tile.byClass("aw-side")[0]!.byClass("aw-player");
    expect(lines.map(line => line.classes().includes("is-seats-2"))).toEqual([true, false]);
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Index · 3 per side"]);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^Kain \S+, 2 seats and zed_7 \S+ beat GPT-6 Astra \(max, Fast\), 3 seats,/);
  });

  it("puts a 1v1's two lines and an alike team's two sides in the players block, the winner first", () => {
    const { doc } = dom();
    const pair = topMatchTile(doc, recording(), "", "shown") as unknown as ElementPort;
    expect(block(pair).classes()).toEqual(["aw-lines", "is-pair"]);
    expect(block(pair).children.map(text)).toEqual(["GPT-6.2 Astralow", "GPT-6.1 Terramax"]);
    const team = topMatchTile(doc, teamMatch(), "", "shown") as unknown as ElementPort;
    expect(block(team).classes()).toEqual(["aw-lines", "is-sides"]);
    expect(block(team).children.map(line => line.classes().includes("is-team"))).toEqual([true, true]);
  });

  it("holds a four-a-side team match with four different builders on one side: that side's four lines, then the other side", () => {
    const { doc } = dom();
    const builders = ["Kain", "zed_7", "acorn", "kain"];
    const tile = topMatchTile(doc, recording({
      matchType: { kind: "unrated", size: 4 },
      seats: [...builders.map((handle, index) => seat(index, 1, handle, { modelLabel: "openai/gpt-6.2-astra" })),
        ...[4, 5, 6, 7].map(index => seat(index, 0, "antwars/gpt-6-astra"))],
    }), "", "shown") as unknown as ElementPort;
    expect(block(tile).classes()).toEqual(["aw-lines", "is-sides"]);
    expect(rowKinds(tile)).toEqual(["aw-meta", "aw-side", "aw-player", "aw-how", "aw-date"]);
    const side = tile.byClass("aw-side")[0]!;
    expect(side.classes()).toContain("is-winner");
    expect(side.byClass("aw-player").map(line => tagged(line, "b").map(text))).toEqual(builders.map(b => [b]));
    expect(block(tile).children[1]!.classes()).toEqual(expect.arrayContaining(["is-team", "is-seats-4"]));
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Unranked · 4 per side"]);
  });

  it("draws an eight-colony free-for-all's colonies in colony order, across then down, only the winner marked", () => {
    const { doc } = dom();
    const handles = ["ann", "bob", "cat", "dan", "eve", "fay", "gus", "hal"];
    const tile = topMatchTile(doc, recording({
      winner: 2, matchType: { kind: "quadrants", size: 1 },
      colonyNames: ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"],
      // The site types a seat's colony 0 to 3; the tile holds up to eight colonies.
      seats: handles.map((handle, colony) => seat(colony, 0, handle, { colony: colony as 0, modelLabel: `${handle}/local` })),
    }), "", "shown") as unknown as ElementPort;
    expect(block(tile).classes()).toEqual(["aw-lines", "is-grid", "is-ffa"]);
    expect(block(tile).children.map(text)).toEqual(handles);
    expect(block(tile).children.map(p => p.classes().includes("is-winner"))).toEqual(handles.map((_, colony) => colony === 2));
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Free-for-all · 8 sides"]);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^cat beat ann, bob, dan, eve, fay, gus and hal, Free-for-all · 8 sides, /);
  });

  it("draws every side of a four-colony free-for-all where its colony starts on the map, only the winner marked", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({
      winner: 2, matchType: { kind: "quadrants", size: 1 },
      colonyNames: ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"],
      seats: ["ann", "bob", "cat", "dan"].map((handle, colony) => seat(colony, colony as 0 | 1, handle, { colony: colony as 0 | 1 | 2 | 3, modelLabel: `${handle}/local` })),
    }), "", "shown") as unknown as ElementPort;
    expect(rowKinds(tile)).toEqual(["aw-meta", "aw-player", "aw-player", "aw-player", "aw-player", "aw-how", "aw-date"]);
    expect(block(tile).classes()).toEqual(["aw-lines", "is-grid", "is-ffa"]);
    // Filled across then down: colony 0 top left, 1 top right, 2 bottom left, 3 bottom right, as the map's starts.
    const players = tile.byClass("aw-player");
    expect(players.map(text)).toEqual(["ann", "bob", "cat", "dan"]);
    expect(players.map(p => p.classes().includes("is-winner"))).toEqual([false, false, true, false]);
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Free-for-all · 4 sides"]);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^cat beat ann, bob and dan, Free-for-all · 4 sides, Last colony standing · queens killed,/);
    expect(tile.byClass("aw-how").map(text)).toEqual(["Queens killed"]);
  });

  it("reads the winner as the rest of the site does: none on an abandoned match, the named one on a result with no reason", () => {
    const { doc } = dom();
    const abandoned = topMatchTile(doc, recording({ reason: "abandoned" }), "", "shown") as unknown as ElementPort;
    expect(abandoned.byClass("aw-player").map(p => p.classes().includes("is-winner"))).toEqual([false, false]);
    expect(abandoned.byClass("aw-player").map(text)).toEqual(["GPT-6.1 Terramax", "GPT-6.2 Astralow"]);
    expect(link(abandoned).style.getPropertyValue("--tile-accent")).toBe("");
    expect(link(abandoned).getAttribute("aria-label")).not.toContain(" beat ");
    const unexplained = topMatchTile(doc, recording({ reason: null }), "", "shown") as unknown as ElementPort;
    expect(unexplained.byClass("aw-player").map(p => p.classes().includes("is-winner"))).toEqual([true, false]);
    expect(link(unexplained).getAttribute("aria-label")).toMatch(/^GPT-6\.2 Astra .* beat GPT-6\.1 Terra/);
  });

  it("shows a two-colony ending without its tie-break step, keeping the full words in its accessible name", () => {
    const { doc } = dom();
    const tile = topMatchTile(doc, recording({ reason: "time_up", decidedBy: "food_delivered" }), "", "shown") as unknown as ElementPort;
    expect(tile.byClass("aw-how").map(text)).toEqual(["Time-up"]);
    expect(link(tile).getAttribute("aria-label")).toContain("Time-up · decided on food delivered");
  });

  it("words an ending without its tie-break step, and a free-for-all's without its leading last colony standing", () => {
    expect(tileEnding("Last colony standing · queens killed", 4)).toBe("Queens killed");
    expect(tileEnding("Last colony standing · seats inactive", 4)).toBe("Seats inactive");
    expect(tileEnding("Time-up · decided on kills", 4)).toBe("Time-up");
    expect(tileEnding("Queens killed · decided on food delivered", 4)).toBe("Queens killed");
    expect(tileEnding("Queens killed", 2)).toBe("Queens killed");
    expect(tileEnding("Queens killed on both sides · decided on ants alive", 2)).toBe("Queens killed on both sides");
    expect(tileEnding("Time-up · decided on territory", 2)).toBe("Time-up");
  });
});

describe("a top-match tile with results hidden", () => {
  const hidden = (r: Recording) => topMatchTile(dom().doc, r, "", "hidden") as unknown as ElementPort;
  /** Nothing in the tile's markup that says who won or how: no winner mark, no colony colour, no ending, no length. */
  const resultFree = (tile: ElementPort) => {
    expect(tile.all().filter(node => node.classes().some(c => c === "is-winner" || c === "aw-how" || c === "aw-len"))).toEqual([]);
    expect(link(tile).style.getPropertyValue("--tile-accent")).toBe("");
    const label = link(tile).getAttribute("aria-label")!;
    expect(link(tile).title).toBe(label);
    expect(`${text(tile)} ${label}`).not.toMatch(/ beat |queens|time-up|killed|standing|decided|\d+ min/i);
  };

  it("shows the type, every side in colony order and the date, and nothing of the result", () => {
    const tile = hidden(recording());
    resultFree(tile);
    expect(rowKinds(tile)).toEqual(["aw-meta", "aw-player", "aw-player", "aw-date"]);
    expect(tile.byClass("aw-player").map(text)).toEqual(["GPT-6.1 Terramax", "GPT-6.2 Astralow"]);
    expect(tile.byClass("aw-date").map(text)).toEqual(["11 Nov 2026"]);
    expect(link(tile).getAttribute("aria-label"))
      .toBe("GPT-6.1 Terra (max, Fast) versus GPT-6.2 Astra (low, Fast, retired model), Index · 1v1, 11 Nov 2026");
  });

  it("draws a team match's seat marks on both sides alike, in colony order", () => {
    const tile = hidden(teamMatch());
    resultFree(tile);
    expect(tile.byClass("aw-player").map(text)).toEqual(["GPT-6 Astramax", "K3.1 Pro Highspeedhigh"]);
    expect(tile.byClass("aw-player").map(p => p.classes().includes("is-team"))).toEqual([true, true]);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^GPT-6 Astra \(max, Fast\), 2 seats versus K3\.1 Pro Highspeed \(high\), 2 seats, Index · 2 per side, 11 Nov 2026$/);
  });

  it("puts a side whose seats differ in its colony's place, with no band", () => {
    const tile = hidden(recording({
      matchType: { kind: "index", size: 2 },
      seats: [seat(0, 0, "antwars/gpt-6-astra"), seat(1, 1, "Kain", { modelLabel: "openai/gpt-6.2-astra" }),
        seat(2, 0, "antwars/gpt-6-astra"), seat(3, 1, "zed_7", { modelLabel: "openai/gpt-6.2-astra" })],
    }));
    resultFree(tile);
    expect(rowKinds(tile)).toEqual(["aw-meta", "aw-player", "aw-side", "aw-date"]);
    expect(link(tile).getAttribute("aria-label")).toMatch(/^GPT-6 Astra \(max, Fast\), 2 seats versus Kain \S+ and zed_7 \S+, Index · 2 per side, 11 Nov 2026$/);
  });

  it("lists a free-for-all's colonies in colony order, none marked", () => {
    const tile = hidden(recording({
      winner: 2, matchType: { kind: "quadrants", size: 1 },
      colonyNames: ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"],
      seats: ["ann", "bob", "cat", "dan"].map((handle, colony) => seat(colony, colony as 0 | 1, handle, { colony: colony as 0 | 1 | 2 | 3, modelLabel: `${handle}/local` })),
    }));
    resultFree(tile);
    expect(tile.byClass("aw-player").map(text)).toEqual(["ann", "bob", "cat", "dan"]);
    expect(tile.byClass("aw-meta").map(text)).toEqual(["Free-for-all · 4 sides"]);
    expect(link(tile).getAttribute("aria-label")).toBe("ann, bob, cat and dan, Free-for-all · 4 sides, 11 Nov 2026");
  });
});

describe("the top-matches page", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const twelve = () => Array.from({ length: 12 }, (_, index) => recording({ id: `2026-11-11T10-34-00-000Z-${index + 1}` }));

  it("says why no live match shows, draws the 12 tiles it reads in order, and links to all recordings", async () => {
    const port = dom({ search: "?watch=1" });
    const rows = twelve();
    const request = vi.fn(async () => Response.json({ matches: rows }));
    const page = mountTopMatchesPage(port.doc, port.win, { state: "idle", request });
    const host = port.body.children.at(-1)!;
    expect(host.byClass("d1p-title").map(text)).toEqual([TOP_WORDS.title]);
    expect(host.byClass("d1p-state").map(text)).toEqual([TOP_STATE.idle]);
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(12));
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
    const rows = twelve();
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
    expect(host.byClass("aw-reveal")).toEqual([]);
    ready = true;
    await vi.advanceTimersByTimeAsync(TOP_RETRY_MS[1]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(host.byClass("aw-tile")).toHaveLength(12);
    expect(host.byClass("aw-status")[0]!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(TOP_RETRY_MS.at(-1)! * 2);
    expect(request).toHaveBeenCalledTimes(3);
  });

  /** A browser's storage for this page: what the visitor chose before; one that refuses every read and write; or one that is
   * full, so it reads and removes but refuses every write. */
  const storage = (port: ReturnType<typeof dom>, stored: Record<string, string> | "blocked" = {}, full = false) => {
    const items = new Map(stored === "blocked" ? [] : Object.entries(stored));
    const refuse = () => { throw new Error("SecurityError"); };
    (port.win as unknown as { localStorage: unknown }).localStorage = stored === "blocked"
      ? { getItem: refuse, setItem: refuse, removeItem: refuse }
      : { getItem: (key: string) => items.get(key) ?? null, removeItem: (key: string) => void items.delete(key),
        setItem: full ? () => { throw new Error("QuotaExceededError"); } : (key: string, value: string) => void items.set(key, value) };
    return items;
  };
  const reveal = (host: ElementPort) => host.byClass("aw-reveal");
  const winners = (host: ElementPort) => host.byClass("is-winner").length;

  it("hides every result by default, with one button that shows them all, remembered in this browser", async () => {
    const port = dom();
    const items = storage(port);
    mountTopMatchesPage(port.doc, port.win, { state: "idle", request: vi.fn(async () => Response.json({ matches: twelve() })) });
    const host = port.body.children.at(-1)!;
    expect(reveal(host)).toEqual([]);
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(12));
    const grid = host.byClass("aw-grid")[0]!;
    expect(grid.dataset.results).toBe("hidden");
    expect(winners(host) + host.byClass("aw-how").length).toBe(0);
    const button = reveal(host);
    expect(button).toHaveLength(1);
    expect(button[0]!.tag).toBe("button");
    expect(text(button[0]!)).toBe(TOP_WORDS.show);
    expect(button[0]!.getAttribute("aria-controls")).toBe(grid.id);
    expect(host.byClass("aw-band-end")[0]!.children.map(child => child.className)).toEqual(["d1p-state", "aw-reveal"]);

    button[0]!.focus();
    button[0]!.click();
    expect(grid.dataset.results).toBe("shown");
    expect(winners(host)).toBe(12);
    expect(host.byClass("aw-how")).toHaveLength(12);
    expect(text(button[0]!)).toBe(TOP_WORDS.hide);
    expect(button[0]!.focused).toBe(true);
    expect(items.get(RESULTS_KEY)).toBe("true");

    button[0]!.click();
    expect(grid.dataset.results).toBe("hidden");
    expect(winners(host) + host.byClass("aw-how").length).toBe(0);
    expect(text(button[0]!)).toBe(TOP_WORDS.show);
    expect(items.has(RESULTS_KEY)).toBe(false);
  });

  it("forgets a choice to show results when the visitor hides them, even where the browser's storage is full", async () => {
    const port = dom();
    const items = storage(port, { [RESULTS_KEY]: "true" }, true);
    mountTopMatchesPage(port.doc, port.win, { state: "idle", request: vi.fn(async () => Response.json({ matches: twelve() })) });
    const host = port.body.children.at(-1)!;
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(12));
    expect(winners(host)).toBe(12);
    reveal(host)[0]!.click();
    expect(winners(host)).toBe(0);
    expect(items.has(RESULTS_KEY)).toBe(false);
  });

  it("draws the results from the first draw where this browser chose to show them", async () => {
    const port = dom();
    storage(port, { [RESULTS_KEY]: "true" });
    mountTopMatchesPage(port.doc, port.win, { state: "idle", request: vi.fn(async () => Response.json({ matches: twelve() })) });
    const host = port.body.children.at(-1)!;
    expect(host.byClass("aw-grid")[0]!.dataset.results).toBe("shown");
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(12));
    expect(winners(host)).toBe(12);
    expect(text(reveal(host)[0]!)).toBe(TOP_WORDS.hide);
  });

  it("hides the results where the browser blocks storage, and still shows them for this page on request", async () => {
    const port = dom();
    storage(port, "blocked");
    mountTopMatchesPage(port.doc, port.win, { state: "idle", request: vi.fn(async () => Response.json({ matches: twelve() })) });
    const host = port.body.children.at(-1)!;
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(12));
    expect(winners(host)).toBe(0);
    reveal(host)[0]!.click();
    expect(winners(host)).toBe(12);
  });

  it("keeps the button beside a new state line", async () => {
    const port = dom();
    storage(port);
    const page = mountTopMatchesPage(port.doc, port.win, { state: "idle", request: vi.fn(async () => Response.json({ matches: twelve() })) });
    const host = port.body.children.at(-1)!;
    await vi.waitFor(() => expect(host.byClass("aw-tile")).toHaveLength(12));
    page.setState("starting");
    expect(host.byClass("aw-band-end")[0]!.children.map(text)).toEqual([TOP_STATE.starting, TOP_WORDS.show]);
    page.destroy();
  });

  it("says there are no top matches yet when the list is empty, and still links to all recordings", async () => {
    const port = dom();
    const request = vi.fn(async () => Response.json({ matches: [] }));
    mountTopMatchesPage(port.doc, port.win, { state: "idle", request });
    const host = port.body.children.at(-1)!;
    await vi.waitFor(() => expect(host.byClass("aw-status").map(text)).toEqual([TOP_WORDS.empty]));
    expect(host.byClass("aw-status")[0]!.hidden).toBe(false);
    expect(host.byClass("aw-tile")).toHaveLength(0);
    expect(host.byClass("aw-reveal")).toEqual([]);
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
