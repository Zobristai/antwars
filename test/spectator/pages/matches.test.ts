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

/** A stacked row's sides as read: each side's colony (read to screen readers) and its seats as heard. */
function sidesOf(item: ElementPort): [string, string[]][] {
  return item.byClass("d1p-side").map(side => [side.byClass("d1p-sr")[0]!.textContent.replace(/: $/, ""), side.byClass("d1p-seat").map(seat => seat.textContent)]);
}
const bodyRows = (table: ElementPort) => table.querySelectorAll("tr").filter(row => row.parent?.tag === "tbody");
/** A cell's seats as heard: the model's name (and ×N), then its level and Fast after a comma. */
const seatsOf = (cell: ElementPort) => cell.byClass("d1p-seat").map(seat => seat.textContent);
const heads = (table: ElementPort) => table.querySelector("thead")!.children[0]!.children.map(node => [node.className, node.textContent, node.colSpan]);

describe("Live now: model-first rows under each colony's name, In progress, Watch where Replay sits, and no winner", () => {
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

  it("heads the table Started, each colony after its dot, Status, and Watch for screen readers, on Recordings' five columns", () => {
    const { p, table } = show(seated);
    expect(table.querySelector("thead")!.children).toHaveLength(1);
    expect(heads(table)).toEqual([
      ["c-start", "Started", 1], ["c-side d1p-c0", "Very Large Colony", 1], ["c-side d1p-c1", "Lake Hodges Colony", 1], ["c-how", "Status", 1], ["c-go", "Watch", 1],
    ]);
    expect(table.querySelector("thead")!.byClass("d1p-dot").map(dot => [dot.className, dot.getAttribute("aria-hidden")]))
      .toEqual([["d1p-dot d1p-c0", "true"], ["d1p-dot d1p-c1", "true"]]);
    expect(table.querySelector("colgroup")!.children.map(col => col.className)).toEqual(["c-start", "c-side", "c-side", "c-how", "c-go"]);
    // Nobody has won yet: no Winner head, no result badge and no winner styling.
    expect(table.textContent).not.toMatch(/Winner|Defeated|Draw/);
    expect(table.byClass("is-win").concat(table.byClass("d1p-badge"))).toEqual([]);
    expect(table.textContent).not.toMatch(/Delay|Lobby|behind|00000000/);
    p.mounted.destroy();
  });

  it("says In progress under Status and puts Watch in the far-right column, Replay's pill in Replay's place", () => {
    const { p, table } = show(seated);
    const [row] = bodyRows(table);
    expect(row!.children.map(node => [node.className, node.colSpan])).toEqual([["c-start", 1], ["c-side", 1], ["c-side", 1], ["c-how", 1], ["c-go", 1]]);
    expect(row!.byClass("c-how")[0]!.textContent).toBe("In progress");
    const watch = row!.children[4]!.children[0]!;
    expect([watch.tag, watch.textContent]).toEqual(["a", "Watch"]);
    expect(watch.href).toBe("/?lobby=00000000-0000-4000-8000-0000000000aa&watch=1");
    expect(watch.getAttribute("aria-label")).toBe("Watch, Rated match started 28 Oct 2026 · 03:00 UTC");
    expect(table.byClass("d1p-row-pill")).toHaveLength(1);
    p.mounted.destroy();
  });

  it("builds Watch as Recordings builds Replay: the site's cyan primary button, in the same column, in both forms", () => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [seated] }, recordings: { status: "ready", rows: [recording] }, next: null });
    const [, liveCard, recCard] = p.body.byClass("d1p-card");
    const cell = (card: ElementPort) => bodyRows(card.byClass("d1p-wide")[0]!)[0]!.children.at(-1)!;
    const [watch, replay] = [cell(liveCard!), cell(recCard!)].map(go => { expect(go.className).toBe("c-go"); return go.children[0]!; });
    expect([watch!.textContent, replay!.textContent]).toEqual(["Watch", "Replay"]);
    for (const link of [watch!, replay!]) expect(link.classes()).toEqual(["d1-agent-button", "d1p-row-pill"]);
    const stacked = [liveCard!, recCard!].map(card => card.byClass("d1p-narrow")[0]!.byClass("d1p-row-pill")[0]!);
    expect(stacked.map(link => [link.textContent, link.className])).toEqual([["Watch", "d1-agent-button d1p-row-pill"], ["Replay", "d1-agent-button d1p-row-pill"]]);
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.d1-agent-button \{[^}]*text-decoration: none;/);
    p.mounted.destroy();
  });

  it("never shows a house slug in the row or its stacked form: the house handle reads as its display name", () => {
    const { p, table, list } = show(seated);
    const [row] = bodyRows(table);
    const [item] = list.querySelectorAll("li");
    expect(seatsOf(row!)[0]).toBe("GPT-6 Luna, max · Fast");
    expect(seatsOf(item!)[0]).toBe("GPT-6 Luna, max · Fast");
    for (const node of [row!, item!].flatMap(root => [root, ...root.all()])) {
      for (const shown of [node.textContent, node.title, node.getAttribute("aria-label") ?? "", node.href]) expect(shown).not.toMatch(/gpt-6-luna|antwars\//);
    }
    p.mounted.destroy();
  });

  it("names each player after its colony's dot with its level quiet under it, no rating, an identity's several seats once with how many", () => {
    const { p, card, table } = show(seated);
    const [first, second] = table.byClass("c-side").filter(node => node.tag === "td");
    // Each side's colony is read to screen readers before its seats.
    expect([first!, second!].map(cell => cell.children[0]!.textContent)).toEqual(["Very Large Colony: ", "Lake Hodges Colony: "]);
    expect(first!.byClass("d1p-name").map(name => [name.textContent, name.title])).toEqual([["GPT-6 Luna", "GPT-6 Luna"]]);
    expect(first!.byClass("d1p-meta").map(meta => meta.textContent)).toEqual(["max · Fast"]);
    expect(first!.byClass("d1p-dot").map(dot => dot.className)).toEqual(["d1p-dot d1p-c0"]);
    // "<name> #1" and "<name> #2": one line, "×2" on screen and "2 seats" to a screen reader.
    expect(seatsOf(second!)).toEqual(["kite×2, 2 seats", "bob"]);
    expect(second!.byClass("d1p-count")[0]!.children.map(node => [node.textContent, node.getAttribute("aria-hidden")])).toEqual([["×2", "true"], [", 2 seats", null]]);
    expect(card.byClass("d1-elo").concat(card.byClass("d1p-elo"), card.byClass("d1p-prov"), card.byClass("d1p-think"))).toEqual([]);
    expect(card.textContent).not.toMatch(/1550|1500|1490|provisional/);
    p.mounted.destroy();
  });

  it("keeps the seat number on a seat an identity holds alone in its colony, grouping only its seats within one colony", () => {
    const player = (displayName: string) => ({ displayName, rating: null, rd: null, ratedMatches: null });
    const split: LiveMatch = { ...unrated, lobbyId: "lobby-s", colonies: [[player("kite #1"), player("alice")], [player("kite #2"), player("kite #3")]] };
    const { p, table, list } = show(split);
    const [first, second] = table.byClass("c-side").filter(node => node.tag === "td");
    expect(seatsOf(first!)).toEqual(["kite #1", "alice"]);
    expect(seatsOf(second!)).toEqual(["kite×2, 2 seats"]);
    expect(sidesOf(list.querySelectorAll("li")[0]!)).toEqual([["Very Large Colony", ["kite #1", "alice"]], ["Lake Hodges Colony", ["kite×2, 2 seats"]]]);
    p.mounted.destroy();
  });

  it("names an unrated match's players, and says so across both sides when a match's seats could not be read", () => {
    const { p, table } = show(unrated, unseated);
    const [named, empty] = bodyRows(table);
    expect(seatsOf(named!)).toEqual(["alice", "bob"]);
    expect(empty!.byClass("d1p-unknown").map(node => node.textContent)).toEqual(["Seats not recorded"]);
    expect(empty!.children.map(node => [node.className, node.colSpan])).toEqual([["c-start", 1], ["c-side", 2], ["c-how", 1], ["c-go", 1]]);
    expect(table.byClass("d1p-row-pill")).toHaveLength(2);
    p.mounted.destroy();
  });

  it("stacks each row: its start, then In progress, beside Watch; then each side's players after their colony's dot", () => {
    const { p, list } = show(seated, unseated);
    const [item, none] = list.querySelectorAll("li");
    expect(item!.children.map(node => node.tag)).toEqual(["p", "p", "div", "a"]);
    expect(item!.byClass("d1p-line").map(line => [line.textContent, line.classes().includes("is-lead")]))
      .toEqual([["Started 28 Oct 2026 · 03:00 UTC", false], ["In progress", true]]);
    expect(sidesOf(item!)).toEqual([["Very Large Colony", ["GPT-6 Luna, max · Fast"]], ["Lake Hodges Colony", ["kite×2, 2 seats", "bob"]]]);
    expect(item!.textContent).not.toMatch(/Won|Lost|Winner|Draw/);
    expect(list.byClass("d1p-badge")).toEqual([]);
    expect(none!.byClass("d1p-unknown").map(node => node.textContent)).toEqual(["Seats not recorded"]);
    p.mounted.destroy();
  });
});

describe("Recordings: one column per colony, the result as a badge in the side's own column", () => {
  const seat = (seat: number, colony: 0 | 1, modelLabel: string | null, thinkingLevel: string | null = null, serviceTier: string | null = null) =>
    ({ seat, colony, modelLabel, thinkingLevel, serviceTier, handle: null });
  const four = (colony: 0 | 1, modelLabel: string, thinkingLevel: string | null, serviceTier: string | null = null) =>
    [0, 1, 2, 3].map(n => seat(n, colony, modelLabel, thinkingLevel, serviceTier));
  const at = (id: string, hour: string, fields: Partial<Recording>): Recording => ({ ...recording, id, startedAt: `2026-10-27T${hour}:00:00.000Z`, ...fields });
  // A 4v4 the second colony won; a 2v1 the first colony won, whose first colony's seats differ; one colony with no recorded seat.
  const team = at("rec-team", "09", { winner: 1, decidedBy: "queens_killed", seats: [...four(0, "openai/gpt-6.1-sol", "max", "fast"), ...four(1, "anthropic/claude-opus-5-5", "high")] });
  const mixed = at("rec-mixed", "08", { seats: [seat(1, 0, null), seat(0, 0, "openai/gpt-6-luna", "max", "fast"), seat(0, 1, "provider/some-model.2")] });
  const oneSided = at("rec-one", "07", { seats: [seat(0, 0, "zai/glm-5.3", "max")] });
  const abandoned = at("rec-abandoned", "06", { winner: 1, reason: "abandoned", decidedBy: "inactive", seats: [seat(0, 0, "zai/glm-5.3", "max"), seat(0, 1, "openai/gpt-6.1-sol")] });
  const draw = at("rec-draw", "05", { winner: null, reason: "time_up", decidedBy: "draw", seats: [seat(0, 0, "moonshot/k3.1-pro", "max"), seat(0, 1, "zai/glm-5.3", "max")] });
  const unknown = at("rec-unknown", "04", { winner: null, reason: null, decidedBy: null });
  const show = (...rows: Recording[]) => {
    const p = page();
    p.mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows }, next: null });
    const card = p.body.byClass("d1p-card")[2]!;
    return { p, card, table: card.byClass("d1p-wide")[0]!, list: card.byClass("d1p-narrow")[0]! };
  };
  /** A row's two sides in colony order: bold or not, and each seat as heard, its badge first where it carries one. */
  const sides = (row: ElementPort) => row.byClass("c-side").filter(node => node.tag === "td").map(cell => [cell.classes().includes("is-win"), seatsOf(cell)]);
  /** Each side's badge as drawn: its classes and word, or null for a side with none; the badge always on a model's line. */
  const badges = (scope: ElementPort, side: string) => scope.byClass(side).filter(node => node.tag !== "th").map(node => {
    const found = node.byClass("d1p-badge");
    expect(found.length).toBeLessThanOrEqual(1);
    if (found.length === 0) return null;
    expect(found[0]!.parent!.classes()).toContain("d1p-model");
    return [found[0]!.className, found[0]!.textContent];
  });

  it("heads the table Match, each colony's name in its ink, Ended by and Replay on one row; no Winner or Defeated column", () => {
    // Guards the ruling against the separate Winner column returning.
    const { p, card, table } = show(team);
    expect(table.querySelector("thead")!.children).toHaveLength(1);
    expect(heads(table)).toEqual([
      ["c-start", "Match", 1], ["c-side d1p-c0", "Very Large Colony", 1], ["c-side d1p-c1", "Lake Hodges Colony", 1], ["c-how", "Ended by", 1], ["c-go", "Replay", 1],
    ]);
    expect(table.textContent).not.toMatch(/Defeated/);
    expect(table.querySelector("thead")!.textContent).not.toMatch(/Winner/);
    // The legend names the colonies for the stacked rows only (archive.css shows it with them).
    expect(card.byClass("d1p-card-head")[0]!.byClass("d1p-legend")[0]!.children.map(item => [item.className, item.textContent]))
      .toEqual([["d1p-legend-item d1p-c0", "Very Large Colony"], ["d1p-legend-item d1p-c1", "Lake Hodges Colony"]]);
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toMatch(/\n\.d1p-legend \{ display: none;/);
    expect(/@container d1p-card \(width < 52rem\) \{\n([\s\S]*?)\n\}/.exec(css)![1]).toContain(".d1p-legend { display: flex; }");
    expect(card.byClass("d1p-ast")).toEqual([]);
    expect(card.textContent).not.toMatch(/Models|\*/);
    expect(p.body.byClass("d1p-tip")).toEqual([]);
    p.mounted.destroy();
  });

  it("puts WINNER beside the winning side's first model, in its own colony's column, bold, whichever colony won", () => {
    // Guards against the badge on the wrong side or the beaten side, or the winner shown as a colony name again.
    const { p, table } = show(team, mixed);
    const [first, second] = bodyRows(table);
    expect(sides(first!)).toEqual([[false, ["GPT-6.1 Sol×4, 4 seats, max · Fast"]], [true, ["Winner, Claude Opus 5.5×4, 4 seats, high"]]]);
    expect(badges(first!, "c-side")).toEqual([null, ["d1p-badge is-win d1p-c1", "Winner"]]);
    expect(first!.byClass("c-side")[1]!.children[0]!.textContent).toBe("Lake Hodges Colony: ");
    expect(sides(second!)).toEqual([[true, ["Winner, GPT-6 Luna, max · Fast", "model unknown"]], [false, ["some-model.2"]]]);
    expect(badges(second!, "c-side")).toEqual([["d1p-badge is-win d1p-c0", "Winner"], null]);
    expect(first!.byClass("c-how")[0]!.textContent).toBe("Queens killed");
    expect(second!.byClass("c-how")[0]!.textContent).toBe("not recorded");
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.is-win \.d1p-name \{[^}]*font-weight: 700;/);
    expect(css).toMatch(/\.d1p-badge \{[^}]*font-size: 16px;/);
    p.mounted.destroy();
  });

  it("marks a side with no recorded models by its colony, and still badges it when it won", () => {
    const { p, table } = show(oneSided, at("rec-blank-win", "03", { winner: 1, seats: [seat(0, 0, "zai/glm-5.3", "max")] }));
    const [one, blank] = bodyRows(table);
    expect(sides(one!)).toEqual([[true, ["Winner, GLM-5.3, max"]], [false, ["Lake Hodges Colony, models not recorded"]]]);
    expect(sides(blank!)).toEqual([[false, ["GLM-5.3, max"]], [true, ["Winner, Lake Hodges Colony, models not recorded"]]]);
    p.mounted.destroy();
  });

  it("puts DRAW on both sides of a draw, and Abandoned or Result unknown on both sides, never WINNER and nothing bold", () => {
    // Guards against a draw, an abandoned match or an unknown result being shown as a win.
    const { p, table, list } = show(abandoned, draw, unknown);
    const rows = bodyRows(table);
    expect(rows.map(row => row.children.map(cell => [cell.className, cell.colSpan]))).toEqual(Array(3).fill(
      [["c-start", 1], ["c-side", 1], ["c-side", 1], ["c-how", 1], ["c-go", 1]]));
    expect(rows.map(row => badges(row, "c-side"))).toEqual([
      [["d1p-badge is-even", "Abandoned"], ["d1p-badge is-even", "Abandoned"]],
      [["d1p-badge is-even", "Draw"], ["d1p-badge is-even", "Draw"]],
      [["d1p-badge is-even", "Result unknown"], ["d1p-badge is-even", "Result unknown"]],
    ]);
    expect(rows.map(sides)).toEqual([
      [[false, ["Abandoned, GLM-5.3, max"]], [false, ["Abandoned, GPT-6.1 Sol"]]],
      [[false, ["Draw, K3.1 Pro, max"]], [false, ["Draw, GLM-5.3, max"]]],
      [[false, ["Result unknown, Very Large Colony, models not recorded"]], [false, ["Result unknown, Lake Hodges Colony, models not recorded"]]],
    ]);
    expect(rows[1]!.byClass("c-how")[0]!.textContent).toBe("Time-up · decided on draw");
    expect(list.querySelectorAll("li").map(item => badges(item, "d1p-side"))).toEqual(rows.map(row => badges(row, "c-side")));
    expect(table.byClass("is-win").concat(list.byClass("is-win"))).toEqual([]);
    expect(table.textContent.concat(list.textContent)).not.toMatch(/Winner|Won|Lost/);
    p.mounted.destroy();
  });

  it("lists a colony's alike seats once with how many, and every seat that differs, keeping different labels apart", () => {
    const providers = at("rec-providers", "06", { seats: [
      seat(0, 0, "openai/gpt-6.1-sol", "max"), seat(1, 0, "openrouter/gpt-6.1-sol", "max"), seat(2, 0, "openai/gpt-6.1-sol", "max"), seat(0, 1, "zai/glm-5.3", "max"),
    ] });
    const { p, table } = show(team, providers);
    const [, many] = bodyRows(table);
    // On a team, the badge sits on the first model's line only.
    expect(sides(many!)).toEqual([[true, ["Winner, GPT-6.1 Sol×2, 2 seats, max", "GPT-6.1 Sol, max"]], [false, ["GLM-5.3, max"]]]);
    expect(table.byClass("d1p-elo").concat(table.byClass("d1p-rd"), table.byClass("d1-elo"), table.byClass("d1p-prov"))).toEqual([]);
    p.mounted.destroy();
  });

  it("keeps a long name and a long self-reported level whole in the page and as their titles, cutting only on screen", () => {
    const name = "super-long-production-model-release-candidate-2026-10";
    const level = "W".repeat(32);
    const long = at("rec-long", "06", { seats: [...four(0, `provider/${name}`, level, "fast"), seat(0, 1, "zai/glm-5.3", "max")] });
    const { p, table, list } = show(long);
    for (const scope of [bodyRows(table)[0]!, list]) {
      const first = scope.byClass("d1p-seat")[0]!;
      const shown = first.byClass("d1p-name")[0]!, meta = first.byClass("d1p-meta")[0]!;
      expect([shown.textContent, shown.title]).toEqual([name, name]);
      expect([meta.textContent, meta.title]).toEqual([`${level} · Fast`, `${level} · Fast`]);
      expect(first.byClass("d1p-count")[0]!.textContent).toBe("×4, 4 seats");
      expect(first.byClass("d1p-badge").map(badge => badge.textContent)).toEqual(["Winner"]);
    }
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toContain(".d1p-model > .d1p-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
    expect(css).toContain(".d1p-model > :not(.d1p-name) { flex: none; }");
    p.mounted.destroy();
  });

  it("stacks each row: its start and type beside Replay; each side's models in colony order, WINNER on the model line; how it ended; a stamp only where due", () => {
    const partial = at("rec-partial", "06", { status: "partial", seats: [seat(0, 0, "zai/glm-5.3", "max"), seat(0, 1, "openai/gpt-6.1-sol")] });
    const { p, table, list } = show(team, partial);
    const [first, second] = list.querySelectorAll("li");
    expect(first!.children.map(node => node.tag)).toEqual(["p", "div", "p", "a"]);
    expect(first!.children[0]!.textContent).toBe("27 Oct 2026 · 09:00 UTC");
    expect(sidesOf(first!)).toEqual([["Very Large Colony", ["GPT-6.1 Sol×4, 4 seats, max · Fast"]], ["Lake Hodges Colony", ["Winner, Claude Opus 5.5×4, 4 seats, high"]]]);
    expect(first!.byClass("d1p-side").map(side => side.classes().includes("is-win"))).toEqual([false, true]);
    expect(badges(first!, "d1p-side")).toEqual([null, ["d1p-badge is-win d1p-c1", "Winner"]]);
    expect(sidesOf(second!).map(([, seats]) => seats)).toEqual([["Winner, GLM-5.3, max"], ["GPT-6.1 Sol"]]);
    expect(first!.byClass("is-meta").map(line => line.textContent)).toEqual(["Queens killed"]);
    expect(first!.textContent).not.toMatch(/Won|Lost/);
    // A complete record carries no stamp; a partial one says so, in both forms.
    expect(first!.byClass("d1p-stamp")).toEqual([]);
    expect(second!.byClass("d1p-stamp").map(node => node.textContent)).toEqual(["Record partial"]);
    expect(bodyRows(table).map(row => row.byClass("d1p-stamp").map(node => node.textContent))).toEqual([[], ["Record partial"]]);
    expect(first!.byClass("d1p-row-pill").map(link => link.textContent)).toEqual(["Replay"]);
    p.mounted.destroy();
  });

  it("keeps the WINNER badge's dark text at AA contrast on either colony's ink", () => {
    // Guards against a colony colour or the badge's ink changing to an unreadable pair.
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.d1p-badge\.is-win \{ color: var\(--aw-bg\); \}/);
    const hex = (name: string) => /#[0-9a-f]{6}/i.exec(new RegExp(`--aw-${name}: (#[0-9a-f]{6})`, "i").exec(css)![1]!)![0]!;
    const luminance = (colour: string) => {
      const [r, g, b] = [1, 3, 5].map(at => parseInt(colour.slice(at, at + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (const colony of ["c0", "c1"]) {
      const [light, dark] = [luminance(hex(colony)), luminance(hex("bg"))];
      expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
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
  const models = (node: ElementPort) => node.byClass("d1p-seat").map(seat => [seat.byClass("d1p-name")[0]!.textContent, seat.byClass("d1p-meta").map(meta => meta.textContent)]);

  it("names antwars/abliterated-large-v2 and antwars/mistral-large-4 on Live now by their rows, with their levels", () => {
    const p = page();
    p.mounted.update(view);
    const live = p.body.byClass("d1p-card")[1]!;
    for (const layout of [live.byClass("d1p-wide")[0]!, live.byClass("d1p-narrow")[0]!]) {
      expect(models(layout)).toEqual([["Abliterated GLM-5.3", ["max"]], ["Mistral Large 4", ["high"]], ["Unlisted model", []]]);
    }
    expect(live.textContent).not.toMatch(SLUG);
    p.mounted.destroy();
  });

  it("shows an unlisted handle as Unlisted model with no level on Waiting and Recordings, and a house seat by its handle's row", () => {
    const p = page();
    p.mounted.update(view);
    const [waiting, , recordings] = p.body.byClass("d1p-card");
    for (const layout of [waiting!.byClass("d1p-wide")[0]!, waiting!.byClass("d1p-narrow")[0]!]) {
      expect(models(layout)).toEqual([["Unlisted model", []], ["Mistral Large 4", ["high"]], ["Unlisted model", []]]);
    }
    expect(models(recordings!.byClass("d1p-wide")[0]!)).toEqual([["Abliterated GLM-5.3", ["max"]], ["Unlisted model", []]]);
    for (const card of [waiting!, recordings!]) expect(card.textContent).not.toMatch(SLUG);
    p.mounted.destroy();
  });
});

describe("the 16 px floor", () => {
  it("sets no text on the Leaderboard, Matches or Rules pages below 16 px", () => {
    // Guards the acceptance floor: every label and value on these pages, heads, badges and stamps included, at 16 px or more.
    const css = readFileSync(new URL("../../../web/src/pages/archive.css", import.meta.url), "utf8");
    const sizes = [...css.matchAll(/font(?:-size)?: (?:\d+ )?(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(20);
    expect(sizes.filter(size => size < 16)).toEqual([]);
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
