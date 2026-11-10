// The Archive Matches page: a row link keeps keyboard focus when the other list settles and the page redraws.
// The test DOM tracks the document's active element, including when
// the focused node is removed; it is not native browser focus.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import type { LiveMatch, MatchesView, Recording } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "./dom.ts";

const live = (lobbyId: string): LiveMatch => ({ lobbyId, startedAt: Date.parse("2026-10-27T10:00:00Z"), rated: true, delaySeconds: 60, colonies: [[], []] });
const recording: Recording = {
  id: "2026-10-27T09-00-00-000Z-1", startedAt: "2026-10-27T09:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0,
  reason: "queens_killed", decidedBy: null, seats: [], status: "complete", unavailable: [],
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
    // Waiting's challenge is the cyan primary button; Recordings' Load more stays the grey pill; the row
    // links are the cyan primary button, never the grey pill.
    const grey = root.byClass("d2-pill").filter(node => node.textContent !== "Refresh");
    expect(grey.map(node => node.textContent)).toEqual(["Load more"]);
    const offer = root.all().find(node => node.dataset.key === "waiting-challenge")!;
    expect([offer.tag, offer.className, offer.textContent]).toEqual(["a", "d1-agent-button", "challenge a house handle"]);
    expect(grey.some(node => node.classes().includes("d1p-refresh"))).toBe(false);
    expect(root.byClass("d1p-row-pill").map(node => node.textContent)).toEqual(["Watch", "Watch", "Replay", "Replay"]);
    expect(root.byClass("d1p-row-pill").every(node => node.classes().includes("d1-agent-button") && !node.classes().includes("d2-pill"))).toBe(true);
    p.mounted.destroy();
  });
});

/** A stacked row's colonies as read: each colony's name, then its seats' lines. */
function colonies(item: ElementPort): [string, string[]][] {
  const read: [string, string[]][] = [];
  for (const node of item.byClass("d1p-colonies")[0]!.children) {
    if (node.tag === "dt") read.push([node.textContent, []]);
    else read[read.length - 1]![1].push(...node.byClass("d1p-model").map(seat => seat.textContent));
  }
  return read;
}
const bodyRows = (table: ElementPort) => table.querySelectorAll("tr").filter(row => row.parent?.tag === "tbody");

describe("Live now names both colonies' players in Recordings' row style, In progress under Winner and Watch where Replay sits", () => {
  const seated: LiveMatch = {
    lobbyId: "00000000-0000-4000-8000-0000000000aa", startedAt: Date.parse("2026-10-28T03:00:00Z"), rated: true, delaySeconds: 0,
    colonies: [
      [{ displayName: "antwars/gpt-6-luna", rating: 1549.6, rd: 61.4, ratedMatches: 30 }],
      // One identity holding two seats is named "<name> #1" and "<name> #2" on them (compose.ts SEAT).
      [{ displayName: "kite #1", rating: 1500, rd: 90, ratedMatches: 3 }, { displayName: "kite #2", rating: 1500, rd: 90, ratedMatches: 3 },
        { displayName: "bob", rating: 1490, rd: 80, ratedMatches: 12 }],
    ],
  };
  const unrated: LiveMatch = { lobbyId: "lobby-u", startedAt: Date.parse("2026-10-28T03:01:00Z"), rated: false, delaySeconds: 60,
    colonies: [[{ displayName: "alice", rating: null, rd: null, ratedMatches: null }], [{ displayName: "bob", rating: null, rd: null, ratedMatches: null }]] };
  const unseated: LiveMatch = { ...unrated, lobbyId: "lobby-e", colonies: [[], []] };
  const show = (...rows: LiveMatch[]) => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows }, recordings: { status: "ready", rows: [] }, next: null });
    const card = p.body.byClass("d1p-card")[1]!;
    return { p, card, table: card.byClass("d1p-wide")[0]!, list: card.byClass("d1p-narrow")[0]! };
  };
  const text = (node: ElementPort, cls: string) => node.byClass(cls).map(child => child.textContent);

  it("heads the table as Recordings' head row: Started, Winner, each colony, the second over the record's column, Watch for screen readers", () => {
    const { p, table } = show(seated);
    const heads = table.querySelector("thead")!;
    expect(heads.children).toHaveLength(1);
    expect(heads.children[0]!.children.map(node => [node.tag, node.className, node.textContent, node.colSpan])).toEqual([
      ["th", "c-start", "Started", 1], ["th", "c-result", "Winner", 1], ["th", "c-model d1p-c0", "Very Large Colony", 1],
      ["th", "c-model d1p-c1", "Lake Hodges Colony", 2], ["th", "c-go", "Watch", 1],
    ]);
    // No empty cell: Live now has no record, so its second colony spans that column,
    // on Recordings' six-column grid, so every column's left edge stands under Recordings'.
    expect(table.querySelectorAll("td").concat(table.querySelectorAll("th")).filter(cell => cell.children.length === 0 && cell.textContent === "")).toEqual([]);
    expect(table.querySelector("colgroup")!.children.map(col => col.className)).toEqual(["c-start", "c-result", "c-model", "c-model", "c-record", "c-go"]);
    // Watch's head is read, not shown, as Replay's is.
    expect(heads.byClass("c-go")[0]!.children.map(node => node.className)).toEqual(["d1p-sr"]);
    // No Delay and no Lobby column.
    expect(table.byClass("c-delay").concat(table.byClass("c-lobby"))).toEqual([]);
    expect(table.textContent).not.toMatch(/Delay|Lobby|behind|00000000/);
    p.mounted.destroy();
  });

  it("says In progress alone under Winner, and puts Watch in the far-right column, Replay's pill in Replay's place", () => {
    const { p, table } = show(seated);
    const [row] = bodyRows(table);
    expect(row!.children.map(node => [node.className, node.colSpan])).toEqual([["c-start", 1], ["c-result", 1], ["c-model", 1], ["c-model", 2], ["c-go", 1]]);
    const result = row!.byClass("c-result")[0]!;
    expect(result.children.map(node => [node.tag, node.textContent])).toEqual([["span", "In progress"]]);
    expect(row!.byClass("c-record")).toEqual([]);
    const go = row!.children[4]!;
    expect(go.children.map(node => [node.tag, node.textContent])).toEqual([["a", "Watch"]]);
    const watch = go.children[0]!;
    expect(watch.href).toBe("/?lobby=00000000-0000-4000-8000-0000000000aa&watch=1");
    expect(watch.getAttribute("aria-label")).toBe("Watch, Rated match started 28 Oct 2026 · 03:00 UTC");
    expect(table.byClass("d1p-row-pill")).toHaveLength(1);
    p.mounted.destroy();
  });

  it("builds Watch as Recordings builds Replay: the site's cyan primary button, in the same column, in both forms", () => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [seated] }, recordings: { status: "ready", rows: [recording] }, next: null });
    const [, liveCard, recCard] = p.body.byClass("d1p-card");
    // Each row's last cell, the action column's.
    const cell = (card: ElementPort) => bodyRows(card.byClass("d1p-wide")[0]!)[0]!.children.at(-1)!;
    const [watch, replay] = [cell(liveCard!), cell(recCard!)].map(go => { expect(go.className).toBe("c-go"); return go.children[0]!; });
    expect([watch!.textContent, replay!.textContent]).toEqual(["Watch", "Replay"]);
    expect(watch!.className).toBe(replay!.className);
    // Both carry the site's one cyan primary button (deck.css .d1-agent-button), not the grey pill.
    for (const link of [watch!, replay!]) expect(link.classes()).toEqual(["d1-agent-button", "d1p-row-pill"]);
    // The stacked rows' Watch and Replay are the same button.
    const stacked = [liveCard!, recCard!].map(card => card.byClass("d1p-narrow")[0]!.byClass("d1p-row-pill")[0]!);
    expect(stacked.map(link => [link.textContent, link.className])).toEqual([["Watch", "d1-agent-button d1p-row-pill"], ["Replay", "d1-agent-button d1p-row-pill"]]);
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    // A link in it shows no underline, as the button does.
    expect(css).toMatch(/\.d1-agent-button \{[^}]*text-decoration: none;/);
    p.mounted.destroy();
  });

  it("never shows a house slug in the changed row or its stacked form: the house handle reads as its display name", () => {
    // A changed surface showing a name, badge, row or action proves no house slug renders there.
    const { p, table, list } = show(seated);
    const [row] = bodyRows(table);
    const [item] = list.querySelectorAll("li");
    expect(row!.byClass("d1p-model")[0]!.textContent).toBe("GPT-6 LunamaxFast");
    expect(item!.byClass("d1p-model")[0]!.textContent).toBe("GPT-6 LunamaxFast");
    for (const node of [row!, item!].flatMap(root => [root, ...root.all()])) {
      for (const shown of [node.textContent, node.title, node.getAttribute("aria-label") ?? "", node.href]) {
        expect(shown).not.toMatch(/gpt-6-luna|antwars\//);
      }
    }
    p.mounted.destroy();
  });

  it("names each player with its badges and no rating, an identity holding several seats once with how many", () => {
    const { p, card, table } = show(seated);
    const [first, second] = table.byClass("c-model").filter(node => node.tag === "td");
    // A Benchmark handle: its house display name with its level and Fast badges.
    expect(first!.byClass("d1p-model").map(seat => seat.textContent)).toEqual(["GPT-6 LunamaxFast"]);
    expect(text(first!, "d1p-tag")).toEqual(["max", "Fast"]);
    // "<name> #1" and "<name> #2": one line, "×2" on screen and "2 seats" to a screen reader.
    expect(second!.byClass("d1p-model").map(seat => seat.textContent)).toEqual(["kite×2, 2 seats", "bob"]);
    expect(second!.byClass("d1p-count")[0]!.children.map(node => [node.textContent, node.getAttribute("aria-hidden")])).toEqual([["×2", "true"], [", 2 seats", null]]);
    expect(second!.colSpan).toBe(2);
    // No rating, ± RD or provisional, and no thinking level.
    expect(card.byClass("d1-elo").concat(card.byClass("d1p-elo"), card.byClass("d1p-prov"), card.byClass("d1p-think"))).toEqual([]);
    expect(card.textContent).not.toMatch(/1550|1500|1490|provisional/);
    p.mounted.destroy();
  });

  it("keeps the seat number on a seat an identity holds alone in its colony, grouping only its seats within one colony", () => {
    const player = (displayName: string) => ({ displayName, rating: null, rd: null, ratedMatches: null });
    const split: LiveMatch = { ...unrated, lobbyId: "lobby-s", colonies: [[player("kite #1"), player("alice")], [player("kite #2"), player("kite #3")]] };
    const { p, table, list } = show(split);
    const [first, second] = table.byClass("c-model").filter(node => node.tag === "td");
    expect(first!.byClass("d1p-model").map(seat => seat.textContent)).toEqual(["kite #1", "alice"]);
    expect(second!.byClass("d1p-model").map(seat => seat.textContent)).toEqual(["kite×2, 2 seats"]);
    expect(colonies(list.querySelectorAll("li")[0]!)).toEqual([["Very Large Colony", ["kite #1", "alice"]], ["Lake Hodges Colony", ["kite×2, 2 seats"]]]);
    p.mounted.destroy();
  });

  it("names an unrated match's players, and says so across both colonies when a match's seats could not be read", () => {
    const { p, table } = show(unrated, unseated);
    const [named, empty] = bodyRows(table);
    expect(named!.byClass("d1p-model").map(seat => seat.textContent)).toEqual(["alice", "bob"]);
    expect(empty!.byClass("d1p-unknown").map(node => node.textContent)).toEqual(["Seats not recorded"]);
    expect(empty!.byClass("c-model")[0]!.colSpan).toBe(3);
    expect(empty!.children.map(node => node.className)).toEqual(["c-start", "c-result", "c-model", "c-go"]);
    expect(empty!.byClass("c-go")[0]!.children.map(node => node.textContent)).toEqual(["Watch"]);
    expect(bodyRows(table)).toHaveLength(2);
    expect(table.byClass("d1p-row-pill")).toHaveLength(2);
    p.mounted.destroy();
  });

  it("stacks each row as Recordings' are: its start, then In progress, beside Watch; then each colony's players under its name", () => {
    const { p, list } = show(seated, unseated);
    const [item, none] = list.querySelectorAll("li");
    expect(item!.children.map(node => node.tag)).toEqual(["p", "p", "dl", "a"]);
    expect(item!.byClass("d1p-line").map(line => [line.textContent, line.classes().includes("is-lead")]))
      .toEqual([["Started 28 Oct 2026 · 03:00 UTC", false], ["In progress", true]]);
    expect(colonies(item!)).toEqual([["Very Large Colony", ["GPT-6 LunamaxFast"]], ["Lake Hodges Colony", ["kite×2, 2 seats", "bob"]]]);
    expect(item!.byClass("d1p-row-pill").map(link => link.textContent)).toEqual(["Watch"]);
    expect(none!.byClass("d1p-unknown").map(node => node.textContent)).toEqual(["Seats not recorded"]);
    p.mounted.destroy();
  });
});

describe("Recordings: one head row, the winner a badge in its colony's column, each colony's alike seats once, with no rating", () => {
  const seat = (seat: number, colony: 0 | 1, modelLabel: string | null, thinkingLevel: string | null = null, serviceTier: string | null = null) =>
    ({ seat, colony, modelLabel, thinkingLevel, serviceTier, handle: null });
  const four = (colony: 0 | 1, modelLabel: string, thinkingLevel: string | null, serviceTier: string | null = null) =>
    [0, 1, 2, 3].map(n => seat(n, colony, modelLabel, thinkingLevel, serviceTier));
  const at = (id: string, hour: string, fields: Partial<Recording>): Recording => ({ ...recording, id, startedAt: `2026-10-27T${hour}:00:00.000Z`, ...fields });
  // A 4v4 of alike seats, as most team matches are; a 2v1 whose first colony's seats differ; one colony with no recorded seat.
  const team = at("rec-team", "09", { winner: 1, decidedBy: "queens", seats: [...four(0, "openai/gpt-6.1-sol", "max", "fast"), ...four(1, "anthropic/claude-opus-5-5", "high")] });
  const mixed = at("rec-mixed", "08", { seats: [seat(1, 0, null), seat(0, 0, "openai/gpt-6-luna", "max", "fast"), seat(0, 1, "provider/some-model.2")] });
  const oneSided = at("rec-one", "07", { seats: [seat(0, 0, "zai/glm-5.3", "max")] });
  const show = (...rows: Recording[]) => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows }, next: null });
    const card = p.body.byClass("d1p-card")[2]!;
    return { p, card, table: card.byClass("d1p-wide")[0]!, list: card.byClass("d1p-narrow")[0]! };
  };
  const seats = (row: ElementPort) => row.byClass("c-model").filter(node => node.tag === "td").map(cell => cell.byClass("d1p-model").map(model => model.textContent));

  it("heads the table Time, Game type, each colony and Record on one row, with no Winner, no Models head and no asterisk", () => {
    const { p, card, table } = show(team);
    const heads = table.querySelector("thead")!;
    expect(heads.children).toHaveLength(1);
    // Game type takes Live now's outcome column, so every column stands where Live now's columns stand.
    expect(heads.querySelectorAll("th").map(node => [node.className, node.textContent, node.colSpan, node.rowSpan])).toEqual([
      ["c-start", "Time", 1, 1], ["c-result", "Game type", 1, 1], ["c-model d1p-c0", "Very Large Colony", 1, 1], ["c-model d1p-c1", "Lake Hodges Colony", 1, 1],
      ["c-record", "Record", 1, 1], ["c-go", "Replay", 1, 1]]);
    expect(table.querySelector("colgroup")!.children.map(col => col.className)).toEqual(["c-start", "c-result", "c-model", "c-model", "c-record", "c-go"]);
    expect(bodyRows(table)[0]!.children.map(node => [node.tag, node.className, node.colSpan])).toEqual([
      ["th", "c-start", 1], ["td", "c-result", 1], ["td", "c-model", 1], ["td", "c-model", 1], ["td", "c-record", 1], ["td", "c-go", 1]]);
    // The asterisk is gone with MODELS *, and the page mounts no tip for it.
    expect(card.byClass("d1p-ast").concat(card.byClass("d1p-kicker").filter(node => node.textContent === "Models"))).toEqual([]);
    expect(card.textContent).not.toMatch(/Models|\*/);
    expect(p.body.byClass("d1p-tip")).toEqual([]);
    p.mounted.destroy();
  });

  it("marks the winning colony's column with a Winner badge in its ink, both colonies' with Draw in a draw, or else says the record's own word under the time", () => {
    const pair = [seat(0, 0, "zai/glm-5.3", "max"), seat(0, 1, "anthropic/claude-opus-5-5", "high")];
    const abandoned = at("rec-abandoned", "06", { winner: 1, reason: "abandoned", decidedBy: "inactive", seats: pair });
    const draw = at("rec-draw", "05", { winner: null, reason: "time_up", decidedBy: "draw", seats: pair });
    const unknown = at("rec-unknown", "04", { winner: null, reason: null, decidedBy: null, seats: pair });
    const { p, table, list } = show(team, abandoned, draw, unknown);
    // Each colony cell's badges after its first line's own words: the shared badge (identity.ts d1p-tag), its words in its
    // colony's ink (d1p-c0/d1p-c1, as the colony's head), never a colony name.
    const badges = (line: ElementPort) => line.children.filter(node => node.classes().includes("d1p-tag")).map(node => [node.className, node.textContent]);
    const marks = (scope: ElementPort) => scope.byClass("d1p-colonies").length > 0
      ? scope.byClass("d1p-colonies")[0]!.children.filter(node => node.tag === "dd").map(dd => badges(dd.byClass("d1p-model")[0]!))
      : scope.byClass("c-model").filter(node => node.tag === "td").map(cell => badges(cell.byClass("d1p-model")[0]!));
    const expected = [[[], [["d1p-tag d1p-c1", "Winner"]]], [[], []], [[["d1p-tag d1p-c0", "Draw"]], [["d1p-tag d1p-c1", "Draw"]]], [[], []]];
    expect(bodyRows(table).map(marks)).toEqual(expected);
    expect(list.querySelectorAll("li").map(marks)).toEqual(expected);
    // The badge comes after the name, its level badges and its count, so the name keeps its place in the column.
    expect(bodyRows(table)[0]!.byClass("d1p-model")[1]!.children.map(node => node.className)).toEqual(["", "d1p-tags", "d1p-count", "d1p-tag d1p-c1"]);
    // Where no colony carries a badge, the record's own word stands under the time; no Winner column, no colony name.
    expect(bodyRows(table).map(row => row.byClass("c-start")[0]!.byClass("d1p-result").map(node => node.textContent))).toEqual([[], ["Abandoned"], [], ["Result unknown"]]);
    // The Game type column holds the match type alone, never the record's word.
    expect(table.byClass("c-result").filter(node => node.tag === "td").flatMap(cell => cell.byClass("d1p-result"))).toEqual([]);
    expect(table.querySelector("tbody")!.textContent).not.toMatch(/Very Large Colony|Lake Hodges Colony| won/);
    expect(list.byClass("is-lead").map(line => line.textContent)).toEqual(["", "Abandoned", "", "Result unknown"]);
    expect(list.byClass("d1p-kicker")).toEqual([]);
    expect(list.byClass("d1p-line").filter(line => line.classes().includes("is-meta"))).toEqual([]);
    p.mounted.destroy();
  });

  it("puts the Winner badge after a winning colony's own words where its model is unknown, and none on a row with no recorded seat", () => {
    const unknownModel = at("rec-unknown-model", "06", { winner: 0, seats: [seat(0, 0, null), seat(0, 1, "zai/glm-5.3", "max")] });
    const noColonySeat = at("rec-no-colony", "05", { winner: 1, seats: [seat(0, 0, "zai/glm-5.3", "max")] });
    const noSeats = at("rec-no-seats", "04", { winner: 1, seats: [] });
    const noSeatsDraw = at("rec-no-seats-draw", "03", { winner: null, reason: "time_up", decidedBy: "draw", seats: [] });
    const { p, table, list } = show(unknownModel, noColonySeat, noSeats, noSeatsDraw);
    const [first, second, third, fourth] = bodyRows(table);
    // With no colony line to carry a badge, a draw keeps its own word under the time; a winner's word names a colony, so none.
    expect([third!, fourth!].map(row => row.byClass("c-start")[0]!.byClass("d1p-result").map(node => node.textContent))).toEqual([[], ["Draw"]]);
    expect(list.byClass("is-lead").slice(2).map(line => line.textContent)).toEqual(["", "Draw"]);
    const lines = (scope: ElementPort) => scope.byClass("d1p-model").map(line => line.children.map(node => [node.className, node.textContent]));
    expect(lines(first!)).toEqual([[["", "model unknown"], ["d1p-tag d1p-c0", "Winner"]], [["", "GLM-5.3"], ["d1p-tags", "max"]]]);
    expect(lines(second!)).toEqual([[["", "GLM-5.3"], ["d1p-tags", "max"]], [["", "not recorded"], ["d1p-tag d1p-c1", "Winner"]]]);
    expect(second!.byClass("d1p-unknown").map(node => node.textContent)).toEqual(["not recordedWinner"]);
    // A row with no recorded seat keeps its one spanning cell, with no badge.
    expect(third!.byClass("c-model").map(cell => [cell.colSpan, cell.textContent])).toEqual([[2, "Seats not recorded"]]);
    const resultTags = (scope: ElementPort) => scope.byClass("d1p-tag").filter(node => !node.classes().includes("d1p-type"));
    expect(resultTags(third!)).toEqual([]);
    const [, , stacked] = list.querySelectorAll("li");
    expect(colonies(list.querySelectorAll("li")[1]!)).toEqual([["Very Large Colony", ["GLM-5.3max"]], ["Lake Hodges Colony", ["not recordedWinner"]]]);
    expect(resultTags(stacked!)).toEqual([]);
    expect(table.querySelector("tbody")!.textContent).not.toMatch(/Very Large Colony|Lake Hodges Colony/);
    p.mounted.destroy();
  });

  it("lists a colony's alike seats once with how many, each seat's name and badges on one line, and every seat that differs", () => {
    const { p, table } = show(team, mixed, oneSided);
    const [first, second, third] = bodyRows(table);
    expect(seats(first!)).toEqual([["GPT-6.1 SolmaxFast×4, 4 seats"], ["Claude Opus 5.5high×4, 4 seatsWinner"]]);
    // One line: the name, its badges as one unit, then the count.
    expect(first!.byClass("d1p-model")[0]!.children.map(node => node.className)).toEqual(["", "d1p-tags", "d1p-count"]);
    expect(first!.byClass("d1p-tags").map(tags => tags.children.map(tag => [tag.className, tag.textContent]))).toEqual([[["d1p-tag", "max"], ["d1p-tag", "Fast"]], [["d1p-tag", "high"]]]);
    // Seats that differ keep their own lines, in seat order; a colony with no recorded seat says so.
    expect(seats(second!)).toEqual([["GPT-6 LunamaxFastWinner", "model unknownWinner"], ["some-model.2"]]);
    expect(seats(third!)).toEqual([["GLM-5.3maxWinner"], ["not recorded"]]);
    expect(table.byClass("d1p-elo").concat(table.byClass("d1p-rd"), table.byClass("d1-elo"), table.byClass("d1p-prov"))).toEqual([]);
    p.mounted.destroy();
  });

  it("marks every line of the winning colony, a recorded model after an unknown one included", () => {
    const later = at("rec-later", "06", { winner: 0, seats: [seat(0, 0, null), seat(1, 0, "zai/glm-5.3", "max"), seat(0, 1, "provider/some-model.2")] });
    const { p, table, list } = show(later);
    expect(seats(bodyRows(table)[0]!)).toEqual([["model unknownWinner", "GLM-5.3maxWinner"], ["some-model.2"]]);
    expect(colonies(list.querySelectorAll("li")[0]!)).toEqual([["Very Large Colony", ["model unknownWinner", "GLM-5.3maxWinner"]], ["Lake Hodges Colony", ["some-model.2"]]]);
    p.mounted.destroy();
  });

  it("keeps seats whose records name different model labels apart, even where both show one name", () => {
    const providers = at("rec-providers", "06", { seats: [
      seat(0, 0, "openai/gpt-6.1-sol", "max"), seat(1, 0, "openrouter/gpt-6.1-sol", "max"), seat(2, 0, "openai/gpt-6.1-sol", "max"), seat(0, 1, "zai/glm-5.3", "max"),
    ] });
    const { p, table, list } = show(providers);
    expect(seats(bodyRows(table)[0]!)).toEqual([["GPT-6.1 Solmax×2, 2 seatsWinner", "GPT-6.1 SolmaxWinner"], ["GLM-5.3max"]]);
    expect(colonies(list.querySelectorAll("li")[0]!)).toEqual([["Very Large Colony", ["GPT-6.1 Solmax×2, 2 seatsWinner", "GPT-6.1 SolmaxWinner"]], ["Lake Hodges Colony", ["GLM-5.3max"]]]);
    p.mounted.destroy();
  });

  it("keeps a name too long for its column whole in the page and as its title, cutting only that name on screen", () => {
    // A join may record a label of up to 64 characters. The stylesheet ends such a name in an ellipsis on its
    // one line and never cuts its badges or count; the page keeps the whole name for hover and screen readers.
    const name = "super-long-production-model-release-candidate-2026-10";
    const long = at("rec-long", "06", { seats: [...four(0, `provider/${name}`, "xhigh", "fast"), seat(0, 1, "zai/glm-5.3", "max")] });
    const { p, table, list } = show(long);
    for (const line of [bodyRows(table)[0]!.byClass("d1p-model")[0]!, list.byClass("d1p-model")[0]!]) {
      const [shown, tags, count] = line.children;
      expect([shown!.textContent, shown!.title]).toEqual([name, name]);
      expect([tags!.className, tags!.textContent, count!.textContent]).toEqual(["d1p-tags", "xhighFast", "×4, 4 seats"]);
    }
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toContain(".d1p-model > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
    expect(css).toContain(".d1p-model > :not(:first-child) { flex: none; }");
    p.mounted.destroy();
  });

  it("keeps a self-reported level too wide for the line whole in the page and as its badges' title, the badges capped on screen", () => {
    // A join may record a thinking level of up to 32 characters. The stylesheet stops the badges at 12em so
    // the name keeps room on its one line; the page keeps every badge's whole text, read in full and as their title.
    const level = "W".repeat(32);
    const wide = at("rec-wide", "06", { seats: [...four(0, "openai/gpt-6.1-terra", level, "fast"), seat(0, 1, "zai/glm-5.3", "max")] });
    const { p, table, list } = show(wide);
    for (const line of [bodyRows(table)[0]!.byClass("d1p-model")[0]!, list.byClass("d1p-model")[0]!]) {
      const [shown, tags, count] = line.children;
      expect([shown!.textContent, shown!.title]).toEqual(["GPT-6.1 Terra", "GPT-6.1 Terra"]);
      expect([tags!.textContent, tags!.title, count!.textContent]).toEqual([`${level}Fast`, `${level} Fast`, "×4, 4 seats"]);
    }
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toContain(".d1p-model > .d1p-tags { max-width: 12em; overflow: hidden; }");
    p.mounted.destroy();
  });

  it("stacks each row: its time, then its type, beside Replay; each colony's seats under its name; then the record", () => {
    const { p, list } = show(team, mixed);
    const [first, second] = list.querySelectorAll("li");
    expect(first!.children.map(node => node.tag)).toEqual(["p", "p", "dl", "p", "a"]);
    expect(first!.children[0]!.textContent).toBe("27 Oct 2026 · 09:00 UTC");
    expect(colonies(first!)).toEqual([["Very Large Colony", ["GPT-6.1 SolmaxFast×4, 4 seats"]], ["Lake Hodges Colony", ["Claude Opus 5.5high×4, 4 seatsWinner"]]]);
    expect(colonies(second!)).toEqual([["Very Large Colony", ["GPT-6 LunamaxFastWinner", "model unknownWinner"]], ["Lake Hodges Colony", ["some-model.2"]]]);
    expect(first!.byClass("d1p-stamp").map(node => node.textContent)).toEqual(["Record complete"]);
    expect(first!.byClass("d1p-row-pill").map(link => link.textContent)).toEqual(["Replay"]);
    p.mounted.destroy();
  });
});

// No house slug on any Matches surface. Live now on antwars.ai showed the slugs
// "abliterated-large-v2" and "mistral-large-4"; an unlisted handle shows "Unlisted model" with no badges.
describe("no house slug on Live now, Waiting or Recordings", () => {
  const SLUG = /abliterated-large-v2|mistral-large-4|not-a-row|abliterated-model-large-v2|antwars\//i;
  const seat = (displayName: string) => ({ displayName, rating: 1500, rd: 90, ratedMatches: 3 });
  const match: LiveMatch = { lobbyId: "lobby-912", startedAt: Date.parse("2026-11-07T08:00:00Z"), rated: true, delaySeconds: 0,
    colonies: [[seat("antwars/abliterated-large-v2")], [seat("antwars/mistral-large-4"), seat("antwars/not-a-row")]] };
  const recorded: Recording = { ...recording, id: "2026-11-07T08-00-00-000Z-1", seats: [
    { seat: 0, colony: 0, modelLabel: "abliteration/abliterated-model-large-v2", thinkingLevel: null, serviceTier: null, handle: "antwars/abliterated-large-v2" },
    { seat: 0, colony: 1, modelLabel: "mistral/mistral-large-4", thinkingLevel: "high", serviceTier: "fast", handle: "antwars/not-a-row" },
  ] };
  const view: MatchesView = {
    waiting: { status: "ready", rows: [{ displayName: "antwars/not-a-row", mode: "house-1v1", waitingSeconds: 60 },
      { mode: "house-1v1", size: 1, seated: 2, colonies: [["antwars/mistral-large-4"], ["antwars/not-a-row"]], waitingSeconds: 0 }] },
    live: { status: "ready", rows: [match] }, recordings: { status: "ready", rows: [recorded] }, next: null,
  };
  const models = (node: ElementPort) => node.byClass("d1p-model").map(model => [model.children[0]!.textContent, model.byClass("d1p-tag").map(tag => tag.textContent)]);

  it("names antwars/abliterated-large-v2 and antwars/mistral-large-4 on Live now by their rows, with their level badges", () => {
    const p = page();
    p.mounted.update(view);
    const live = p.body.byClass("d1p-card")[1]!;
    for (const layout of [live.byClass("d1p-wide")[0]!, live.byClass("d1p-narrow")[0]!]) {
      expect(models(layout)).toEqual([["Abliterated GLM-5.3", ["max"]], ["Mistral Large 4", ["high"]], ["Unlisted model", []]]);
    }
    expect(live.textContent).not.toMatch(SLUG);
    p.mounted.destroy();
  });

  it("shows an unlisted handle as Unlisted model with no badges on Waiting and Recordings, and a house seat by its handle's row", () => {
    const p = page();
    p.mounted.update(view);
    const [waiting, , recordings] = p.body.byClass("d1p-card");
    // Waiting's table and its stacked rows both name each seat by its row, never its slug.
    for (const layout of [waiting!.byClass("d1p-wide")[0]!, waiting!.byClass("d1p-narrow")[0]!]) {
      expect(models(layout)).toEqual([["Unlisted model", []], ["Mistral Large 4", ["high"]], ["Unlisted model", []]]);
    }
    expect(models(recordings!.byClass("d1p-wide")[0]!)).toEqual([["Abliterated GLM-5.3", ["max", "Winner"]], ["Unlisted model", []]]);
    for (const card of [waiting!, recordings!]) expect(card.textContent).not.toMatch(SLUG);
    p.mounted.destroy();
  });
});

describe("tap height on a phone", () => {
  it("gives the cyan button the grey pills' 44 px tap under 46rem", () => {
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    const phone = /@media \(width < 46rem\) \{\n(?:.*\n)*?  \.d1p \{ ([^}]*) \}/.exec(css);
    expect(phone).not.toBeNull();
    expect(phone![1]).toMatch(/--d2-tap: 44px;/);
    expect(phone![1]).toMatch(/--d1-tap: 44px;/);
    const deck = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    expect(deck).toMatch(/\.d1-agent-button \{[^}]*min-height: var\(--d1-tap, 36px\);/);
  });
});

describe("Model Index matches show their harness phase", () => {
  it("tags an index recording and a live index match with their phase and flag, in both forms, and no other match", () => {
    const p = page();
    const indexRecording: Recording = { ...recording, id: "2026-10-26T01-38-33-692Z-1", matchType: { kind: "index", size: 1 },
      harnessPhase: { phase: "rounds 1-7", possibleEffortMismatch: true } };
    const ranked: Recording = { ...recording, id: "2026-10-27T08-00-00-000Z-1", matchType: { kind: "ranked", size: 1 } };
    const liveIndex: LiveMatch = { ...live("lobby-i"), harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false } };
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [liveIndex, live("lobby-r")] },
      recordings: { status: "ready", rows: [indexRecording, ranked] }, next: null });
    const tags = (scope: ElementPort) => scope.byClass("d1p-phase").map(node => node.textContent);
    const [liveTable, recTable] = p.body.byClass("d1p-wide");
    const [liveList, recList] = p.body.byClass("d1p-narrow");
    const rows = (scope: ElementPort) => scope.querySelector("tbody")!.querySelectorAll("tr");
    expect(rows(liveTable!).map(tags)).toEqual([["Harness: rounds 26-30"], []]);
    expect(liveList!.querySelectorAll("li").map(tags)).toEqual([["Harness: rounds 26-30"], []]);
    expect(rows(recTable!).map(tags)).toEqual([[], ["Harness: rounds 1-7", "Possible effort mismatch"]]);
    expect(recList!.querySelectorAll("li").map(tags)).toEqual([[], ["Harness: rounds 1-7", "Possible effort mismatch"]]);
    p.mounted.destroy();
  });
});
