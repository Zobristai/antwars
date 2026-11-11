// The Archive Matches page: one row layout for every list (the signed-off rows drawing), and a row link or rating badge
// keeps keyboard focus when another list settles and the page redraws. The test DOM tracks the document's active element,
// including when the focused node is removed; it is not native browser focus.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import type { LiveMatch, MatchesView, Recording } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "./dom.ts";

const live = (lobbyId: string): LiveMatch => ({ lobbyId, startedAt: Date.parse("2026-10-27T10:00:00Z"), rated: true, delaySeconds: 60, colonies: [[], []] });
const recording: Recording = {
  id: "2026-10-27T09-00-00-000Z-1", startedAt: "2026-10-27T09:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0,
  reason: "queens_killed", decidedBy: null, seats: [{ seat: 0, colony: 0, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "alice" }, { seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "bob" }], status: "complete", unavailable: [],
};

function page() {
  const port = dom();
  const host = port.doc.createElement("div");
  port.doc.body.append(host);
  const mounted = mountMatches(port.doc, host, { refresh() {}, more() {} });
  const active = () => port.doc.activeElement as unknown as ElementPort | null;
  const link = (key: string) => (host as unknown as ElementPort).all().find(node => node.tag === "a" && node.dataset.key === key)!;
  return { mounted, active, link, body: port.body };
}

describe("Matches row links keep focus across a redraw", () => {
  it("keeps a focused Watch link when Recordings settles", () => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [live("lobby-a")] }, recordings: { status: "loading", rows: [] }, next: null });
    const watch = p.link("live|wide|lobby-a");
    watch.focus();
    expect(p.active()).toBe(watch);
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [live("lobby-a")] }, recordings: { status: "ready", rows: [recording] }, next: null });
    expect(watch.isConnected).toBe(false);
    expect(p.active()).not.toBe(p.body);
    expect(p.active()?.dataset.key).toBe("live|wide|lobby-a");
    expect(p.active()?.isConnected).toBe(true);
    p.mounted.destroy();
  });

  it("keeps a focused stacked-list Replay link, not its hidden table copy, when Live now changes", () => {
    const p = page();
    const view: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows: [recording] }, next: null };
    p.mounted.update(view);
    const replay = p.link(`rec|narrow|${recording.id}`);
    replay.focus();
    p.mounted.update({ ...view, live: { status: "ready", rows: [live("lobby-b")] } });
    expect(replay.isConnected).toBe(false);
    expect(p.active()?.dataset.key).toBe(`rec|narrow|${recording.id}`);
    expect(p.active()?.isConnected).toBe(true);
    p.mounted.destroy();
  });
});

describe("the band and its cyan Refresh", () => {
  it("holds the title and Refresh above the cards, and only Refresh carries the cyan class", () => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [live("lobby-c")] }, recordings: { status: "ready", rows: [recording] }, next: "next-page" });
    const root = p.body.byClass("d1p")[0]!;
    const band = root.byClass("d1p-band")[0]!;
    expect(band.byClass("d1p-title")[0]!.textContent).toBe("Matches");
    expect(root.byClass("d1p-rail")).toHaveLength(0);
    const cyan = root.byClass("d1p-refresh");
    expect(cyan.map(node => node.textContent)).toEqual(["Refresh"]);
    expect(band.all().includes(cyan[0]!)).toBe(true);
    // Waiting's challenge, Recordings' Load more and the row links are the cyan primary button, never the grey pill.
    const grey = root.byClass("d2-pill").filter(node => node.textContent !== "Refresh");
    expect(grey).toEqual([]);
    const more = root.all().find(node => node.dataset.key === "more")!;
    expect([more.tag, more.className, more.textContent]).toEqual(["button", "d1-agent-button", "Load more"]);
    const offer = root.all().find(node => node.dataset.key === "waiting-challenge")!;
    expect([offer.tag, offer.className, offer.textContent]).toEqual(["a", "d1-agent-button", "challenge a house handle"]);
    expect(grey.some(node => node.classes().includes("d1p-refresh"))).toBe(false);
    expect(root.byClass("d1p-row-pill").map(node => node.textContent)).toEqual(["Watch", "Watch", "Replay", "Replay"]);
    expect(root.byClass("d1p-row-pill").every(node => node.classes().includes("d1-agent-button") && !node.classes().includes("d2-pill"))).toBe(true);
    p.mounted.destroy();
  });
});

/** A stacked row's colonies as read: each colony's name, then its lines. */
function colonies(item: ElementPort): [string, string[]][] {
  const read: [string, string[]][] = [];
  for (const node of item.byClass("d1p-colonies")[0]!.children) {
    if (node.tag === "dt") read.push([node.textContent, []]);
    else read[read.length - 1]![1].push(...node.byClass("d1p-model").map(seat => seat.textContent));
  }
  return read;
}
const bodyRows = (table: ElementPort) => table.querySelectorAll("tr").filter(row => row.parent?.tag === "tbody");
/** A table row's cells as read: each cell's class and words, its lines' words where it holds player lines. */
const cells = (row: ElementPort) => row.children.map(cell => {
  const lines = cell.byClass("d1p-model");
  return [cell.className, lines.length > 0 ? lines.map(line => line.textContent) : cell.textContent];
});
/** A player line's parts in order, each by its role. */
const lineParts = (line: ElementPort) => line.children.map(node => {
  if (node.classes().includes("d1p-name")) return ["name", node.children.map(part => `${part.className ?? ""}:${part.textContent}`).filter(part => part !== ":" && part !== ": ")];
  if (node.classes().includes("d1p-tags")) return ["badges", node.children.map(tag => tag.textContent)];
  if (node.classes().includes("d1p-elo-badge")) return ["rating", node.textContent];
  if (node.classes().includes("d1p-count")) return ["seats", node.children[0]!.textContent];
  if (node.classes().includes("d1p-result-tag")) return ["result", node.textContent];
  return ["other", node.textContent];
});
const css = () => readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");

const rated = (rating: number, rd = 80, ratedMatches = 12) => ({ rating, rd, ratedMatches });
const seat = (seatNo: number, colony: 0 | 1, modelLabel: string | null, handle: string | null, more: Partial<Recording["seats"][number]> = {}) =>
  ({ seat: seatNo, colony, modelLabel, thinkingLevel: null, serviceTier: null, handle, ...more });
const at = (id: string, fields: Partial<Recording>): Recording => ({ ...recording, id, ...fields });

function show(view: Partial<MatchesView>) {
  const p = page();
  p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows: [] }, next: null, ...view });
  const [waiting, liveCard, recordings] = p.body.byClass("d1p-card");
  const parts = (card: ElementPort) => ({ card, table: card.byClass("d1p-wide")[0]!, list: card.byClass("d1p-narrow")[0]! });
  return { p, waiting: parts(waiting!), live: parts(liveCard!), recordings: parts(recordings!) };
}

describe("one six-column layout in every list", () => {
  const waitingRow = { displayName: "coffee-ant", mode: "1v1" as const, waitingSeconds: 60, since: Date.parse("2026-11-11T05:01:00Z"), rating: rated(1540) };
  const liveIndex: LiveMatch = { ...live("lobby-i"), matchType: { kind: "index", size: 1 }, colonies: [
    [{ displayName: "antwars/gpt-6-luna", rating: 1500, rd: 90, ratedMatches: 3 }], [{ displayName: "antwars/gpt-6-luna", rating: 1482, rd: 70, ratedMatches: 20 }]] };

  it("heads Waiting, Live now and Recordings alike: Time, Game type, each colony, Status, and the button's head read only", () => {
    const { p, waiting, live: liveList, recordings } = show({ waiting: { status: "ready", rows: [waitingRow] }, live: { status: "ready", rows: [liveIndex] },
      recordings: { status: "ready", rows: [recording] } });
    const heads = [waiting, liveList, recordings].map(({ table }) => table.querySelector("thead")!.children[0]!.children.map(node => [node.className, node.textContent, node.colSpan]));
    const shared = [["c-start", "Time", 1], ["c-type", "Game type", 1], ["c-model d1p-c0", "Very Large Colony", 1], ["c-model d1p-c1", "Lake Hodges Colony", 1], ["c-status", "Status", 1]];
    expect(heads).toEqual([[...shared, ["c-go", "", 1]], [...shared, ["c-go", "Watch", 1]], [...shared, ["c-go", "Replay", 1]]]);
    for (const { table } of [waiting, liveList, recordings]) {
      expect(table.querySelector("colgroup")!.children.map(col => col.className)).toEqual(["c-start", "c-type", "c-model", "c-model", "c-status", "c-go"]);
      expect(table.querySelector("thead")!.byClass("c-go")[0]!.children.every(node => node.className === "d1p-sr")).toBe(true);
    }
    // Every row has the six cells, none spanning another's column.
    for (const { table } of [waiting, liveList, recordings]) expect(bodyRows(table).every(row => row.children.length === 6 && row.children.every(cell => cell.colSpan === 1))).toBe(true);
    p.mounted.destroy();
  });

  it("drops Live now's Winner column, Waiting's Waited and Match columns and the loose result word under a recording's time", () => {
    const abandoned = at("rec-ab", { winner: null, reason: "abandoned", decidedBy: null });
    const unknown = at("rec-unknown", { winner: null, reason: "time_up", decidedBy: null });
    const { p, waiting, live: liveList, recordings } = show({ waiting: { status: "ready", rows: [waitingRow] }, live: { status: "ready", rows: [liveIndex] },
      recordings: { status: "ready", rows: [abandoned, unknown] } });
    expect(liveList.card.textContent).not.toMatch(/Winner|In progress|Started/);
    expect(waiting.card.textContent).not.toMatch(/Waited|when loaded|Match\b|min\b/);
    for (const row of bodyRows(recordings.table)) expect(row.byClass("c-start")[0]!.children.map(node => node.className)).toEqual(["d1p-date", "d1p-time"]);
    expect(recordings.card.textContent).not.toMatch(/Result unknown/);
    expect(recordings.card.byClass("d1p-result")).toEqual([]);
    p.mounted.destroy();
  });

  it("stacks every row in one order: time, game type and status, each colony's name over its lines, the button", () => {
    const { p, waiting, live: liveList, recordings } = show({ waiting: { status: "ready", rows: [waitingRow] }, live: { status: "ready", rows: [liveIndex] },
      recordings: { status: "ready", rows: [{ ...recording, matchType: { kind: "unranked", size: 1 } }] } });
    const [w] = waiting.list.querySelectorAll("li"), [l] = liveList.list.querySelectorAll("li"), [r] = recordings.list.querySelectorAll("li");
    expect(w!.children.map(node => node.tag)).toEqual(["p", "p", "dl"]);
    expect([l, r].map(item => item!.children.map(node => node.tag))).toEqual([["p", "p", "dl", "a"], ["p", "p", "dl", "a"]]);
    expect([w, l, r].map(item => item!.children[0]!.textContent)).toEqual(["11 Nov 2026 · 05:01 UTC", "27 Oct 2026 · 10:00 UTC", "27 Oct 2026 · 09:00 UTC"]);
    expect([w, l, r].map(item => item!.children[1]!.children.map(node => node.textContent)))
      .toEqual([["Ranked · 1v1", "Status Waiting"], ["Index · 1v1", "Status Live"], ["Unranked · 1v1", "Status complete"]]);
    expect(colonies(w!)).toEqual([["Very Large Colony", ["coffee-ant1540 ± 80"]], ["Lake Hodges Colony", ["no opponent yet"]]]);
    p.mounted.destroy();
  });

  it("keeps the badges, the rating and the stamps whole on one line, the name alone cut with an ellipsis", () => {
    const sheet = css();
    expect(sheet).toContain(".d1p-model > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
    expect(sheet).toContain(".d1p-model > :not(:first-child) { flex: none; }");
    expect(sheet).toContain(".d1p-match tbody :is(th, td) { vertical-align: middle; }");
    expect(sheet).toContain(".d1p-match :is(th, td):is(.c-type, .c-status, .c-go) { text-align: center; }");
    expect(sheet).toContain(".d1p-match-rows > li > .d1p-row-pill { grid-row: 1 / span 2; align-self: center; margin-top: 0; }");
    expect(sheet).toMatch(/\.d1p-stamp \{[^}]*white-space: nowrap;/);
    expect(sheet).toMatch(/\.d1p-tag \{[^}]*white-space: nowrap;/);
  });
});

describe("the one player line", () => {
  it("draws username, model, level, Fast, rating, seats and result in that order", () => {
    const team = at("rec-team", { winner: 0, decidedBy: "territory", matchType: { kind: "ranked", size: 2 }, seats: [
      seat(0, 0, "openai/gpt-6.1-terra", "coffee-ant", { thinkingLevel: "high", serviceTier: "fast", startRating: rated(1540) }),
      seat(1, 0, "openai/gpt-6.1-terra", "coffee-ant", { thinkingLevel: "high", serviceTier: "fast", startRating: rated(1540) }),
      seat(0, 1, null, "omp-dolphin", { startRating: rated(1460) }), seat(1, 1, null, "omp-dolphin", { startRating: rated(1460) })] });
    const { p, recordings } = show({ recordings: { status: "ready", rows: [team] } });
    for (const layout of [recordings.table, recordings.list]) {
      const [winner, other] = layout.byClass("d1p-model");
      expect(lineParts(winner!)).toEqual([["name", ["d1p-user:coffee-ant", "d1p-mname:GPT-6.1 Terra"]], ["badges", ["high", "Fast"]],
        ["rating", "1540 ± 80"], ["seats", "×2"], ["result", "Winner"]]);
      // A builder that named no model: its username alone, then its rating; no result on the losing colony.
      expect(lineParts(other!)).toEqual([["name", ["d1p-user:omp-dolphin"]], ["rating", "1460 ± 80"], ["seats", "×2"]]);
      expect(winner!.byClass("d1p-result-tag")[0]!.classes()).toContain("d1p-c0");
    }
    // The badge is figure only; its ± RD a tip, no provisional word on a row.
    const badge = recordings.table.byClass("d1p-elo-badge")[0]!;
    expect([badge.tag, badge.children[0]!.textContent ?? "", badge.byClass("d1p-elo-rd")[0]!.textContent]).toEqual(["button", "1540", " ± 80"]);
    expect(recordings.card.byClass("d1p-prov")).toEqual([]);
    expect(recordings.card.textContent).not.toMatch(/provisional/i);
    p.mounted.destroy();
  });

  it("leads a house model's line with its model, level and Fast, with no username", () => {
    const house = at("rec-house", { winner: 1, decidedBy: "queens", matchType: { kind: "challenge", size: 1 }, seats: [
      seat(0, 0, "anthropic/claude-haiku-5-5", "antwarsos-harness", { thinkingLevel: "max" }),
      seat(0, 1, "openai/gpt-6.1-terra", "antwars/gpt-6-1-terra-max-fast", { startRating: rated(1979, 60, 40) })] });
    const { p, recordings } = show({ recordings: { status: "ready", rows: [house] } });
    const [builder, model] = recordings.table.byClass("d1p-model");
    expect(lineParts(builder!)).toEqual([["name", ["d1p-user:antwarsos-harness", "d1p-mname:Claude Haiku 5.5"]], ["badges", ["max"]]]);
    // The house seat: its model name leads with no username, then its rating, then its colony's result.
    expect(model!.byClass("d1p-user")).toEqual([]);
    expect(lineParts(model!).map(part => part[0]).filter(kind => kind !== "badges")).toEqual(["name", "rating", "result"]);
    expect(recordings.card.textContent).not.toMatch(/antwars\//);
    p.mounted.destroy();
  });

  it("shows no rating badge on an older recording, which stored none, and never today's rating in its place", () => {
    const { p, recordings } = show({ recordings: { status: "ready", rows: [recording] } });
    expect(recordings.card.byClass("d1p-elo-badge")).toEqual([]);
    expect(bodyRows(recordings.table)[0]!.byClass("d1p-model").map(line => line.textContent)).toEqual(["aliceWinner", "bob"]);
    p.mounted.destroy();
  });

  it("keeps a long name whole as its title and in the page, cutting only the name on screen", () => {
    const name = "super-long-production-model-release-candidate-2026-10";
    const long = at("rec-long", { seats: [seat(0, 0, `provider/${name}`, "omp-dolphin", { thinkingLevel: "xhigh" }), seat(0, 1, "zai/glm-5.3", "kite")] });
    const { p, recordings } = show({ recordings: { status: "ready", rows: [long] } });
    const line = recordings.table.byClass("d1p-model")[0]!;
    expect([line.children[0]!.textContent, line.children[0]!.title]).toEqual([`omp-dolphin ${name}`, `omp-dolphin ${name}`]);
    expect(line.children.slice(1).map(node => node.textContent)).toEqual(["xhigh", "Winner"]);
    p.mounted.destroy();
  });
});

describe("Live now rows", () => {
  const match: LiveMatch = { lobbyId: "00000000-0000-4000-8000-0000000000aa", startedAt: Date.parse("2026-11-11T03:50:00Z"), rated: false, delaySeconds: 60,
    matchType: { kind: "challenge", size: 1 }, colonies: [
      [{ displayName: "antwars/gpt-6-luna", rating: 1979, rd: 60, ratedMatches: 40 }],
      [{ displayName: "kain", modelLabel: "openai/gpt-6.1-terra", thinkingLevel: "high", serviceTier: "fast", rating: 1612, rd: 80, ratedMatches: 12 }]] };

  it("types the match, rates every seat (an unrated match too), says LIVE and offers Watch", () => {
    const { p, live: liveList } = show({ live: { status: "ready", rows: [match] } });
    const [row] = bodyRows(liveList.table);
    expect(cells(row!)).toEqual([
      ["c-start", "11 Nov 202603:50 UTC"], ["c-type", "Challenge · 1v1"], ["c-model", ["GPT-6 LunamaxFast1979 ± 60"]],
      ["c-model", ["kain GPT-6.1 TerrahighFast1612 ± 80"]], ["c-status", "Status Live"], ["c-go", "Watch"]]);
    // The builder's line in the drawing's order: username, model, then the level and Fast it reported on joining.
    expect(lineParts(row!.byClass("d1p-model")[1]!).filter(part => part[0] !== "rating")).toEqual([["name", ["d1p-user:kain", "d1p-mname:GPT-6.1 Terra"]], ["badges", ["high", "Fast"]]]);
    const watch = row!.byClass("d1p-row-pill")[0]!;
    expect(watch.href).toBe("/?lobby=00000000-0000-4000-8000-0000000000aa&watch=1");
    expect(watch.getAttribute("aria-label")).toBe("Watch, Unrated match started 11 Nov 2026 · 03:50 UTC");
    // No result while live; the LIVE stamp is drawn red (archive.css .is-live).
    expect(liveList.card.byClass("d1p-result-tag")).toEqual([]);
    expect(row!.byClass("d1p-stamp").map(node => node.className)).toEqual(["d1p-stamp is-live"]);
    p.mounted.destroy();
  });

  it("lists an identity's seats once with how many, keeps a lone seat's number, and says not recorded for a match with no seats", () => {
    const player = (displayName: string) => ({ displayName, rating: null, rd: null, ratedMatches: null });
    const split: LiveMatch = { ...live("lobby-s"), colonies: [[player("kite #1"), player("alice")], [player("kite #2"), player("kite #3")]] };
    const { p, live: liveList } = show({ live: { status: "ready", rows: [split, live("lobby-e")] } });
    const [first, empty] = bodyRows(liveList.table);
    expect(cells(first!).slice(2, 4)).toEqual([["c-model", ["kite #1", "alice"]], ["c-model", ["kite×2, 2 seats"]]]);
    expect(cells(empty!).slice(1, 4)).toEqual([["c-type", "not recorded"], ["c-model", ["not recorded"]], ["c-model", ["not recorded"]]]);
    p.mounted.destroy();
  });

  it("shows a builder whose label only repeats its name by its username alone, and a reported model after the username", () => {
    const own: LiveMatch = { ...live("lobby-o"), colonies: [
      [{ displayName: "coffee-ant", modelLabel: "coffee-ant/local", rating: null, rd: null, ratedMatches: null }],
      [{ displayName: "kain", modelLabel: "openai/antwars/gpt-6-luna", rating: null, rd: null, ratedMatches: null }]] };
    const { p, live: liveList } = show({ live: { status: "ready", rows: [own] } });
    const [a, b] = liveList.table.byClass("d1p-model");
    expect(lineParts(a!)).toEqual([["name", ["d1p-user:coffee-ant"]]]);
    // A builder's reported model is drawn as given, never read as a house handle.
    expect(lineParts(b!)).toEqual([["name", ["d1p-user:kain", "d1p-mname:antwars/gpt-6-luna"]]]);
    p.mounted.destroy();
  });
});

describe("Recordings rows", () => {
  it("stamps each record's state, words an unrated match and a lobby Unranked, and puts each result on its colony: Winner, Draw on both, Abandoned on both", () => {
    const hour = (h: number) => `2026-10-27T0${h}:00:00.000Z`;
    const won = at("rec-won", { startedAt: hour(5), winner: 1, decidedBy: "queens", matchType: { kind: "index", size: 1 } });
    const draw = at("rec-draw", { startedAt: hour(4), winner: null, reason: "time_up", decidedBy: "draw", matchType: { kind: "unrated", size: 1 } });
    const abandoned = at("rec-ab", { startedAt: hour(3), winner: null, reason: "abandoned", decidedBy: null, matchType: { kind: "unranked", size: 1 } });
    const partial = at("rec-partial", { startedAt: hour(2), status: "partial", winner: 0, seats: [seat(0, 0, "openai/gpt-6.1-sol", "antwars/gpt-6-1-sol")] });
    const unavailable = at("rec-none", { startedAt: hour(1), status: "unavailable", winner: null, seats: [] });
    const { p, recordings } = show({ recordings: { status: "ready", rows: [won, draw, abandoned, partial, unavailable] } });
    const read = bodyRows(recordings.table).map(row => cells(row).slice(1, 5));
    expect(read).toEqual([
      [["c-type", "Index · 1v1"], ["c-model", ["alice"]], ["c-model", ["bobWinner"]], ["c-status", "Status complete"]],
      [["c-type", "Unranked · 1v1"], ["c-model", ["aliceDraw"]], ["c-model", ["bobDraw"]], ["c-status", "Status complete"]],
      [["c-type", "Unranked · 1v1"], ["c-model", ["aliceAbandoned"]], ["c-model", ["bobAbandoned"]], ["c-status", "Status complete"]],
      [["c-type", ""], ["c-model", ["GPT-6.1 SolmaxFastWinner"]], ["c-model", ["did not join"]], ["c-status", "Status partial"]],
      [["c-type", "not recorded"], ["c-model", ["not recorded"]], ["c-model", ["not recorded"]], ["c-status", "Status unavailable"]],
    ]);
    expect(recordings.table.byClass("d1p-stamp").map(stamp => stamp.className)).toEqual(
      ["d1p-stamp is-complete", "d1p-stamp is-complete", "d1p-stamp is-complete", "d1p-stamp is-partial", "d1p-stamp is-unavailable"]);
    expect(recordings.card.textContent).not.toMatch(/Lobby|Unrated/);
    p.mounted.destroy();
  });

  it("lists no match a colony never joined", () => {
    const never = at("rec-never", { seats: [seat(0, 0, null, "alice")] });
    const { p, recordings } = show({ recordings: { status: "ready", rows: [never, recording] } });
    expect(bodyRows(recordings.table)).toHaveLength(1);
    p.mounted.destroy();
  });
});

describe("a rating badge keeps keyboard focus across a redraw", () => {
  it("keeps a focused Live now badge when Recordings settles, in the table and the stacked rows", () => {
    const rated: LiveMatch = { ...live("lobby-f"), colonies: [[{ displayName: "alice", rating: 1612, rd: 80, ratedMatches: 12 }], []] };
    const p = page();
    const base: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [rated] }, recordings: { status: "loading", rows: [] }, next: null };
    p.mounted.update(base);
    for (const key of ["live|wide|lobby-f|0|0|rating", "live|narrow|lobby-f|0|0|rating"]) {
      const badge = (p.body.all().find(node => node.dataset.key === key))!;
      expect(badge.tag).toBe("button");
      badge.focus();
      p.mounted.update({ ...base, recordings: { status: "ready", rows: [recording] } });
      expect(badge.isConnected).toBe(false);
      expect(p.active()?.dataset.key).toBe(key);
      expect(p.active()?.isConnected).toBe(true);
      p.mounted.update(base);
    }
    p.mounted.destroy();
  });
});

// No house slug on any Matches surface; an unlisted handle shows "Unlisted model" with no badges.
describe("no house slug on Live now, Waiting or Recordings", () => {
  const SLUG = /abliterated-large-v2|mistral-large-4|not-a-row|abliterated-model-large-v2|antwars\//i;
  const player = (displayName: string) => ({ displayName, rating: 1500, rd: 90, ratedMatches: 3 });
  const match: LiveMatch = { lobbyId: "lobby-912", startedAt: Date.parse("2026-11-07T08:00:00Z"), rated: true, delaySeconds: 0,
    colonies: [[player("antwars/abliterated-large-v2")], [player("antwars/mistral-large-4"), player("antwars/not-a-row")]] };
  const recorded: Recording = { ...recording, id: "2026-11-07T08-00-00-000Z-1", seats: [
    seat(0, 0, "abliteration/abliterated-model-large-v2", "antwars/abliterated-large-v2"),
    seat(0, 1, "mistral/mistral-large-4", "antwars/not-a-row", { thinkingLevel: "high", serviceTier: "fast" }),
  ] };
  const view: Partial<MatchesView> = {
    waiting: { status: "ready", rows: [{ displayName: "antwars/not-a-row", mode: "house-1v1", waitingSeconds: 60, since: 0 },
      { mode: "house-1v1", size: 1, seated: 2, colonies: [["antwars/mistral-large-4"], ["antwars/not-a-row"]], waitingSeconds: 0, since: 0 }] },
    live: { status: "ready", rows: [match] }, recordings: { status: "ready", rows: [recorded] },
  };
  const models = (node: ElementPort) => node.byClass("d1p-model").filter(line => !line.classes().includes("d1p-unknown"))
    .map(line => [line.children[0]!.textContent, line.byClass("d1p-tag").filter(tag => !tag.classes().includes("d1p-result-tag")).map(tag => tag.textContent)]);

  it("names house handles by their rows on every list, an unlisted one Unlisted model with no badges", () => {
    const { p, waiting, live: liveList, recordings } = show(view);
    for (const layout of [liveList.table, liveList.list]) {
      expect(models(layout)).toEqual([["Abliterated GLM-5.3", ["max"]], ["Mistral Large 4", ["high"]], ["Unlisted model", []]]);
    }
    for (const layout of [waiting.table, waiting.list]) {
      expect(models(layout)).toEqual([["Unlisted model", []], ["Mistral Large 4", ["high"]], ["Unlisted model", []]]);
    }
    expect(models(recordings.table)).toEqual([["Abliterated GLM-5.3", ["max"]], ["Unlisted model", []]]);
    for (const { card } of [waiting, liveList, recordings]) expect(card.textContent).not.toMatch(SLUG);
    p.mounted.destroy();
  });
});

describe("tap height on a phone", () => {
  it("gives the cyan button the grey pills' 44 px tap under 46rem", () => {
    const sheet = css();
    const phone = /@media \(width < 46rem\) \{\n(?:.*\n)*?  \.d1p \{ ([^}]*) \}/.exec(sheet);
    expect(phone).not.toBeNull();
    expect(phone![1]).toMatch(/--d2-tap: 44px;/);
    expect(phone![1]).toMatch(/--d1-tap: 44px;/);
    const deck = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    expect(deck).toMatch(/\.d1-agent-button \{[^}]*min-height: var\(--d1-tap, 36px\);/);
  });
});

describe("no match shows a harness phase", () => {
  it("draws no phase label on an index recording or a live index match the server sends a phase for, in either form", () => {
    const p = page();
    // The server still sends a Model Index match's phase; the page parses it away and draws nothing for it.
    const indexRecording = { ...recording, id: "2026-10-26T01-38-33-692Z-1", matchType: { kind: "index", size: 1 },
      harnessPhase: { phase: "rounds 1-7", possibleEffortMismatch: true } } as Recording;
    const ranked: Recording = { ...recording, id: "2026-10-27T08-00-00-000Z-1", matchType: { kind: "ranked", size: 1 } };
    const liveIndex = { ...live("lobby-i"), harnessPhase: { phase: "from round 31 onward", possibleEffortMismatch: false } } as LiveMatch;
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [liveIndex, live("lobby-r")] },
      recordings: { status: "ready", rows: [indexRecording, ranked] }, next: null });
    expect(p.body.byClass("d1p-phase")).toEqual([]);
    for (const scope of [...p.body.byClass("d1p-wide"), ...p.body.byClass("d1p-narrow")])
      expect(scope.textContent ?? "").not.toMatch(/harness|effort mismatch|rounds \d|round 31|pin onward/i);
    p.mounted.destroy();
  });
});

describe("a model label with nothing after its provider prefix", () => {
  it("shows the whole label on a Live now row and a Recordings row, never no model", () => {
    const bare: LiveMatch = { ...live("lobby-bare"), colonies: [
      [{ displayName: "kain", modelLabel: "local/", rating: null, rd: null, ratedMatches: null }],
      [{ displayName: "kite", modelLabel: "zai/glm-5.3", rating: null, rd: null, ratedMatches: null }]] };
    const rec = at("rec-bare", { seats: [seat(0, 0, "local/", "omp-dolphin", { thinkingLevel: "high" }), seat(0, 1, "zai/glm-5.3", "kite")] });
    const { p, live: liveList, recordings } = show({ live: { status: "ready", rows: [bare] }, recordings: { status: "ready", rows: [rec] } });
    expect(lineParts(liveList.table.byClass("d1p-model")[0]!)).toEqual([["name", ["d1p-user:kain", "d1p-mname:local/"]]]);
    const line = recordings.table.byClass("d1p-model")[0]!;
    expect(lineParts(line)[0]).toEqual(["name", ["d1p-user:omp-dolphin", "d1p-mname:local/"]]);
    expect(lineParts(line)[1]).toEqual(["badges", ["high"]]);
    p.mounted.destroy();
  });
});
