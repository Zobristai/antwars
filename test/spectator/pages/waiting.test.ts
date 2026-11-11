// The Matches page's Waiting card: read-only, directly above Live now, one row per waiting agent with its name,
// mode and time waited, and an empty state when none is waiting. Its rows stand on Live now's grid and column
// order: Waited, Match, then each colony, as a table in a wide card and stacked rows in a narrow one.
import { describe, expect, it } from "vitest";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import { lobbyKind, lobbyText, waitedText, waitingMode } from "../../../web/src/pages/waiting.ts";
import type { MatchesView, WaitingAgent, WaitingLobby } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "./dom.ts";

/** The table's body rows as read: the time waited, the match's kind, then each colony cell's seats with its span. */
const tableRows = (card: ElementPort) => card.byClass("d1p-wide")[0]!.querySelectorAll("tr").filter(row => row.parent?.tag === "tbody")
  .map(row => row.children.map(cell => cell.className === "c-model"
    ? [cell.colSpan, cell.byClass("d1p-model").map(seat => seat.textContent)]
    : [cell.className, cell.textContent]));
/** The stacked rows' lines as read. */
const stackedLines = (card: ElementPort) => card.byClass("d1p-narrow")[0]!.querySelectorAll("li")
  .map(item => item.byClass("d1p-line").map(line => line.textContent));

const view = (waiting: MatchesView["waiting"]): MatchesView =>
  ({ waiting, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows: [] }, next: null });

function page() {
  const port = dom();
  const host = port.doc.createElement("div");
  port.doc.body.append(host);
  const mounted = mountMatches(port.doc, host, { refresh() {}, more() {} });
  const titles = () => port.body.byClass("d1p-card-title").map(node => node.textContent);
  const card = () => port.body.byClass("d1p-waiting")[0]!;
  return { mounted, titles, card };
}

describe("the Waiting card", () => {
  it("stands directly above Live now and lists each agent's name, mode and time waited, with no link", () => {
    const p = page();
    const rows: WaitingAgent[] = [
      { displayName: "sam/first", mode: "1v1", waitingSeconds: 125 },
      { displayName: "bea", mode: "4v4", waitingSeconds: 12 },
      { displayName: "antwars/glm-5-3", mode: "house-2v2", waitingSeconds: 899 },
    ];
    p.mounted.update(view({ status: "ready", rows }));
    expect(p.titles()).toEqual(["Waiting", "Live now", "Recordings"]);
    const card = p.card();
    expect(card.byClass("d1p-state")[0]!.textContent).toBe("3 agents waiting in a ranked queue");
    // Live now's grid: one head row, Waited and Match, then each colony, the second over the record and action columns.
    const table = card.byClass("d1p-wide")[0]!;
    expect(table.classes()).toEqual(["d1p-table", "d1p-wait", "d1p-wide"]);
    expect(table.querySelector("colgroup")!.children.map(col => col.className)).toEqual(["c-start", "c-result", "c-model", "c-model", "c-record", "c-go"]);
    expect(table.querySelector("thead")!.children[0]!.children.map(head => [head.tag, head.className, head.textContent, head.colSpan])).toEqual([
      ["th", "c-start", "Waited", 1], ["th", "c-result", "Match", 1], ["th", "c-model d1p-c0", "Very Large Colony", 1], ["th", "c-model d1p-c1", "Lake Hodges Colony", 3],
    ]);
    // A queued agent has no colony yet: its name spans both colonies' columns. The wait is as of the load.
    expect(tableRows(card)).toEqual([
      [["c-start", "2 minwhen loaded"], ["c-result", "Ranked · 1v1"], [4, ["sam/first"]]],
      [["c-start", "under 1 minwhen loaded"], ["c-result", "Ranked · 4v4"], [4, ["bea"]]],
      // A house handle in the shared row style (rowName), as Live now names it.
      [["c-start", "14 minwhen loaded"], ["c-result", "Index · 2v2"], [4, ["GLM-5.3max"]]],
    ]);
    expect(stackedLines(card)).toEqual([
      ["2 min waiting when loaded", "Ranked · 1v1", "sam/first"],
      ["under 1 min waiting when loaded", "Ranked · 4v4", "bea"],
      ["14 min waiting when loaded", "Index · 2v2", "GLM-5.3max"],
    ]);
    expect(card.all().filter(node => node.tag === "a" || node.tag === "button")).toEqual([]);
    p.mounted.destroy();
  });

  it("says when no agent is waiting, and when the list could not be read", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: [] }));
    expect(p.titles()[0]).toBe("Waiting");
    expect(p.card().byClass("d1p-state")[0]!.textContent).toBe("No agent waiting in a ranked queue or lobby");
    expect(p.card().all().filter(node => node.tag === "li")).toEqual([]);
    p.mounted.update(view({ status: "error", rows: [] }));
    expect(p.card().byClass("d1p-state")[0]!.textContent).toContain("Queue list unavailable");
    p.mounted.destroy();
  });

  it("names every mode in the Recordings badge's words and the wait in whole minutes", () => {
    expect(["1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"].map(mode => waitingMode(mode as WaitingAgent["mode"]))).toEqual([
      "Ranked · 1v1", "Ranked · 2v2", "Ranked · 3v3", "Ranked · 4v4",
      "Index · 1v1", "Index · 2v2", "Index · 3v3", "Index · 4v4",
    ]);
    expect([0, 59, 60, 119, 900].map(waitedText)).toEqual(["under 1 min", "under 1 min", "1 min", "1 min", "15 min"]);
  });
});

describe("the Waiting card's lobby rows", () => {
  const lobbies: WaitingLobby[] = [
    { mode: null, size: 2, seated: 3, colonies: [["ann", "cat"], ["bob"]], waitingSeconds: 250 },
    { mode: null, size: 1, seated: 1, colonies: [["dan"], []], waitingSeconds: 30 },
    { mode: "2v2", size: 2, seated: 4, colonies: [["fay"], ["gus"]], waitingSeconds: 3 },
    { mode: "house-1v1", size: 1, seated: 2, colonies: [["antwars/claude-opus-5-5"], ["antwars/gpt-6-luna"]], waitingSeconds: 0 },
  ];
  it("lists each lobby under its seated names after the unchanged queue rows, still above Live now", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: [{ displayName: "sam/first", mode: "1v1", waitingSeconds: 125 }, ...lobbies] }));
    expect(p.titles()).toEqual(["Waiting", "Live now", "Recordings"]);
    const card = p.card();
    expect(card.byClass("d1p-state")[0]!.textContent).toBe("1 agent waiting in a ranked queue · 4 matches waiting to start");
    // Each colony's seats in its own column; the Match text in the Recordings badge's words; a paired lobby shows its wait too.
    expect(tableRows(card)).toEqual([
      [["c-start", "2 minwhen loaded"], ["c-result", "Ranked · 1v1"], [4, ["sam/first"]]],
      [["c-start", "4 minwhen loaded"], ["c-result", "Lobby · 2v2 · 3 of 4 seats"], [1, ["ann", "cat"]], [3, ["bob"]]],
      [["c-start", "under 1 minwhen loaded"], ["c-result", "Lobby · 1v1 · 1 of 2 seats"], [1, ["dan"]], [3, []]],
      [["c-start", "under 1 minwhen loaded"], ["c-result", "Ranked · 2v2 · paired, starting soon"], [1, ["fay"]], [3, ["gus"]]],
      [["c-start", "under 1 minwhen loaded"], ["c-result", "Index · 1v1 · paired, starting soon"], [1, ["Claude Opus 5.5high"]], [3, ["GPT-6 LunamaxFast"]]],
    ]);
    expect(stackedLines(card)).toEqual([
      ["2 min waiting when loaded", "Ranked · 1v1", "sam/first"],
      ["4 min waiting when loaded", "Lobby · 2v2 · 3 of 4 seats"],
      ["under 1 min waiting when loaded", "Lobby · 1v1 · 1 of 2 seats"],
      ["under 1 min waiting when loaded", "Ranked · 2v2 · paired, starting soon"],
      ["under 1 min waiting when loaded", "Index · 1v1 · paired, starting soon"],
    ]);
    // The stacked lobby rows list each colony under its name, as Live now's do; a colony with no seat yet stays blank.
    const colonies = card.byClass("d1p-narrow")[0]!.querySelectorAll("li").slice(1, 3).map(item => item.byClass("d1p-colonies")[0]!.children
      .map(node => node.tag === "dt" ? node.textContent : node.byClass("d1p-model").map(seat => seat.textContent)));
    expect(colonies).toEqual([["Very Large Colony", ["ann", "cat"], "Lake Hodges Colony", ["bob"]], ["Very Large Colony", ["dan"], "Lake Hodges Colony", []]]);
    expect(card.byClass("d1p-unknown")).toEqual([]);
    expect(card.all().filter(node => node.tag === "a" || node.tag === "button")).toEqual([]);
    p.mounted.destroy();
  });

  it("counts lobbies alone, and says when nothing at all is waiting", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: lobbies.slice(2, 3) }));
    expect(p.card().byClass("d1p-state")[0]!.textContent).toBe("1 match waiting to start");
    p.mounted.update(view({ status: "ready", rows: [] }));
    expect(p.card().byClass("d1p-state")[0]!.textContent).toBe("No agent waiting in a ranked queue or lobby");
    p.mounted.destroy();
  });

  it("words a lobby by its copy, its kind in the Recordings badge's word, its wait in the Waited column", () => {
    expect(lobbyText({ mode: null, size: 4, seated: 5, colonies: [["a"], ["b"]], waitingSeconds: 600 })).toBe("Lobby · 4v4 · 5 of 8 seats");
    expect(lobbyText({ mode: "3v3", size: 3, seated: 6, colonies: [["a"], ["b"]], waitingSeconds: 600 })).toBe("Ranked · 3v3 · paired, starting soon");
    expect(lobbyText({ mode: "house-2v2", size: 2, seated: 4, colonies: [["a"], ["b"]], waitingSeconds: 0 })).toBe("Index · 2v2 · paired, starting soon");
    expect(lobbyText({ mode: null, size: 1, seated: 1, colonies: [[], ["a"]], waitingSeconds: 0, challenge: "house" })).toBe("Challenge · 1v1 · 1 of 2 seats");
  });

  it("tells every lobby's kind by the server's rule for a recording's lobby, in the standing mode names", () => {
    // src/replays/history-routes.ts recordingMatchType: a house-* mode is the Index, another mode Ranked, a modeless lobby a
    // house challenge or else a public or invite-only lobby ("Lobby · NvN").
    const modes = [null, "1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const;
    expect(modes.map(mode => lobbyKind({ mode }))).toEqual(["lobby", "ranked", "ranked", "ranked", "ranked", "index", "index", "index", "index"]);
    expect(lobbyKind({ mode: null, challenge: "house" })).toBe("challenge");
    for (const mode of modes) for (const challenge of [undefined, "house"] as const) {
      expect(lobbyText({ mode, size: 2, seated: 1, colonies: [["a"], []], waitingSeconds: 0, ...(challenge ? { challenge } : {}) })).not.toMatch(/Unranked/i);
    }
  });

  it("shows \"Unranked\" nowhere on the Waiting card", () => {
    const p = page();
    const agents: WaitingAgent[] = [
      { displayName: "sam/first", mode: "1v1", waitingSeconds: 125 },
      { displayName: "antwars/glm-5-3", mode: "house-1v1", waitingSeconds: 5 },
    ];
    const challenge: WaitingLobby = { mode: null, size: 1, seated: 1, colonies: [[], ["probe"]], waitingSeconds: 9, challenge: "house" };
    p.mounted.update(view({ status: "ready", rows: [...agents, ...lobbies, challenge] }));
    const card = p.card();
    expect(card.textContent).not.toMatch(/unranked/i);
    for (const node of card.all()) for (const value of [...Object.values(node.attrs), ...Object.values(node.dataset), node.title]) expect(value).not.toMatch(/unranked/i);
    expect(card.byClass("c-result").map(cell => cell.textContent.split(" · ")[0])).toEqual(
      expect.arrayContaining(["Ranked", "Index", "Lobby", "Challenge"]));
    p.mounted.destroy();
  });
});

describe("house challenges on the Waiting card", () => {
  it("labels a house challenge's lobby as a challenge, and no other lobby", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: [
      { mode: null, size: 1, seated: 1, colonies: [[], ["player-7"]], waitingSeconds: 269, challenge: "house" },
      { mode: null, size: 1, seated: 1, colonies: [["dan"], []], waitingSeconds: 30 },
    ] }));
    expect(tableRows(p.card())).toEqual([
      [["c-start", "4 minwhen loaded"], ["c-result", "Challenge · 1v1 · 1 of 2 seats"], [1, []], [3, ["player-7"]]],
      [["c-start", "under 1 minwhen loaded"], ["c-result", "Lobby · 1v1 · 1 of 2 seats"], [1, ["dan"]], [3, []]],
    ]);
    expect(p.card().all().filter(node => node.tag === "a")).toEqual([]);
    p.mounted.destroy();
  });

  it("offers a house challenge, linking to the Leaderboard's Antwars Model Index 1v1 board, only when nothing at all is waiting", () => {
    const port = dom({ search: "?page=matches&board=3d" });
    const host = port.doc.createElement("div");
    port.doc.body.append(host);
    const mounted = mountMatches(port.doc, host, { refresh() {}, more() {} });
    const card = () => port.body.byClass("d1p-waiting")[0]!;
    const links = () => card().all().filter(node => node.tag === "a").map(node => [node.textContent, node.href]);
    mounted.update(view({ status: "ready", rows: [] }));
    // The state line is unchanged; the offer is a line of its own, keeping the page's kept parameters (ui/format.ts keep).
    expect(card().byClass("d1p-state")[0]!.textContent).toBe("No agent waiting in a ranked queue or lobby");
    expect(links()).toEqual([["challenge a house handle", "/?page=leaderboard&mode=house-1v1&board=3d"]]);
    // The site's cyan button (deck.css .d1-agent-button), not the grey pill; no house slug on the card.
    expect(card().all().find(node => node.tag === "a")!.classes()).toEqual(["d1-agent-button"]);
    expect(card().textContent).not.toMatch(/antwars\//);
    mounted.update(view({ status: "loading", rows: [] }));
    expect(links()).toEqual([]);
    mounted.update(view({ status: "error", rows: [] }));
    expect(links()).toEqual([]);
    mounted.update(view({ status: "ready", rows: [{ displayName: "bea", mode: "1v1", waitingSeconds: 12 }] }));
    expect(links()).toEqual([]);
    mounted.destroy();
  });
});
