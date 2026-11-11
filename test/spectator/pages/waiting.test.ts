// The Matches page's Waiting card: read-only, directly above Live now, in the one Matches row layout: when the wait
// began, the game type, the two colonies, the status stamp and no button, as a table in a wide card and stacked rows in a
// narrow one. A waiting builder shows its username and rating; a house model its model, level and Fast.
import { describe, expect, it } from "vitest";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import { lobbyKind, waitingType } from "../../../web/src/pages/waiting.ts";
import type { MatchesView, WaitingAgent, WaitingLobby } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "./dom.ts";

/** The table's body rows as read: each cell's words, a colony cell's lines. */
const tableRows = (card: ElementPort) => card.byClass("d1p-wide")[0]!.querySelectorAll("tr").filter(row => row.parent?.tag === "tbody")
  .map(row => row.children.map(cell => cell.className === "c-model" ? cell.byClass("d1p-model").map(seat => seat.textContent) : cell.textContent));

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

const T = Date.parse("2026-11-11T05:01:00Z");
const rating = (value: number) => ({ rating: value, rd: 80, ratedMatches: 12 });

describe("the Waiting card", () => {
  const agents: WaitingAgent[] = [
    { displayName: "coffee-ant", mode: "1v1", waitingSeconds: 90, since: T, rating: rating(1540) },
    { displayName: "antwars/gpt-6-luna", mode: "house-2v2", waitingSeconds: 5, since: T + 60_000, rating: null },
  ];

  it("stands directly above Live now and draws each queued agent in the first colony, no opponent yet in the second, WAITING and no button", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: agents }));
    expect(p.titles()).toEqual(["Waiting", "Live now", "Recordings"]);
    expect(tableRows(p.card())).toEqual([
      ["11 Nov 202605:01 UTC", "Ranked · 1v1", ["coffee-ant1540 ± 80"], ["no opponent yet"], "Status Waiting", ""],
      ["11 Nov 202605:02 UTC", "Index · 2v2", ["GPT-6 LunamaxFast"], ["no opponent yet"], "Status Waiting", ""],
    ]);
    expect(p.card().all().filter(node => node.tag === "a")).toEqual([]);
    expect(p.card().byClass("d1p-state")[0]!.textContent).toBe("2 agents waiting in a ranked queue");
    // A builder's line is its username alone (with its rating); a house model leads with its model and has no username.
    const [builder, house] = p.card().byClass("d1p-wide")[0]!.byClass("d1p-model");
    expect(builder!.byClass("d1p-user").map(node => node.textContent)).toEqual(["coffee-ant"]);
    expect(builder!.byClass("d1p-mname")).toEqual([]);
    expect(house!.byClass("d1p-user")).toEqual([]);
    expect(p.card().textContent).not.toMatch(/antwars\/|Waited|when loaded|min\b/);
    p.mounted.destroy();
  });

  it("says when no agent is waiting, and when the list could not be read", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: [] }));
    expect(p.card().byClass("d1p-state")[0]!.textContent).toBe("No agent waiting in a ranked queue or lobby");
    expect(p.card().byClass("d1p-wide")).toEqual([]);
    p.mounted.update(view({ status: "error", rows: [] }));
    expect(p.card().byClass("d1p-state")[0]!.textContent).toMatch(/^Queue list unavailable/);
    p.mounted.destroy();
  });
});

describe("the Waiting card's lobby rows", () => {
  const lobbies: WaitingLobby[] = [
    { mode: null, size: 2, seated: 3, colonies: [["omp-dolphin", "omp-dolphin/spar"], ["coffee-ant"]], ratings: [[null, null], [rating(1540)]],
      waitingSeconds: 30, since: T - 180_000 },
    { mode: "house-1v1", size: 1, seated: 2, colonies: [["antwars/gpt-6-luna"], ["antwars/gpt-6-luna"]], ratings: [[rating(1500)], [rating(1337)]],
      waitingSeconds: 2, since: T + 60_000 },
    { mode: null, size: 1, seated: 1, colonies: [[], ["kain"]], ratings: [[], [null]], waitingSeconds: 400, since: T - 4_620_000, challenge: "house" },
    // An older server sends no ratings: the names stand alone.
    { mode: null, size: 1, seated: 2, colonies: [["ann"], ["bob"]], waitingSeconds: 1, since: T },
  ];

  it("draws each lobby's seated players in their colonies with their ratings, an open seat, a held seat not joined, and its stamp", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: lobbies }));
    expect(tableRows(p.card()).map(row => row.slice(1, 5))).toEqual([
      ["Unranked · 2v2", ["omp-dolphin", "omp-dolphin/spar"], ["coffee-ant1540 ± 80", "seat open"], "Status 3 of 4 seats"],
      ["Index · 1v1", ["GPT-6 LunamaxFast1500 ± 80"], ["GPT-6 LunamaxFast1337 ± 80"], "Status Starting"],
      ["Challenge · 1v1", ["not joined yet"], ["kain"], "Status 1 of 2 seats"],
      ["Unranked · 1v1", ["ann"], ["bob"], "Status Starting"],
    ]);
    expect(tableRows(p.card()).map(row => row[0])).toEqual(["11 Nov 202604:58 UTC", "11 Nov 202605:02 UTC", "11 Nov 202603:44 UTC", "11 Nov 202605:01 UTC"]);
    expect(p.card().byClass("d1p-state")[0]!.textContent).toBe("4 matches waiting to start");
    // The stacked rows carry the same lines.
    const item = p.card().byClass("d1p-narrow")[0]!.querySelectorAll("li")[0]!;
    expect(item.byClass("d1p-model").map(line => line.textContent)).toEqual(["omp-dolphin", "omp-dolphin/spar", "coffee-ant1540 ± 80", "seat open"]);
    p.mounted.destroy();
  });

  it("tells every lobby's kind by the server's rule for a recording's lobby, Unranked for a public or invite-only lobby", () => {
    expect(lobbyKind({ mode: "house-3v3" })).toBe("index");
    expect(lobbyKind({ mode: "2v2" })).toBe("ranked");
    expect(lobbyKind({ mode: null, challenge: "house" })).toBe("challenge");
    expect(lobbyKind({ mode: null })).toBe("unranked");
    expect(waitingType({ mode: null, size: 3, seated: 1, colonies: [["a"], []], waitingSeconds: 0, since: 0 })).toBe("Unranked · 3v3");
    expect(waitingType({ displayName: "a", mode: "house-4v4", waitingSeconds: 0, since: 0 })).toBe("Index · 4v4");
  });

  it("shows \"Lobby\" nowhere on the Waiting card", () => {
    const p = page();
    p.mounted.update(view({ status: "ready", rows: lobbies }));
    expect(p.card().textContent).not.toMatch(/Lobby/);
    p.mounted.destroy();
  });
});

describe("house challenges on the Waiting card", () => {
  it("offers a house challenge, linking to the Leaderboard's Challenge choice, only when nothing at all is waiting", () => {
    const port = dom({ search: "?page=matches&board=3d" });
    const host = port.doc.createElement("div");
    port.doc.body.append(host);
    const mounted = mountMatches(port.doc, host, { refresh() {}, more() {} });
    const card = () => port.body.byClass("d1p-waiting")[0]!;
    const links = () => card().all().filter(node => node.tag === "a").map(node => [node.textContent, node.href]);
    mounted.update(view({ status: "ready", rows: [] }));
    // The state line is unchanged; the offer is a line of its own, keeping the page's kept parameters (ui/format.ts keep).
    expect(card().byClass("d1p-state")[0]!.textContent).toBe("No agent waiting in a ranked queue or lobby");
    expect(links()).toEqual([["challenge a house handle", "/?page=leaderboard&mode=challenge&board=3d"]]);
    // The site's cyan button (deck.css .d1-agent-button), not the grey pill; no house slug on the card.
    expect(card().all().find(node => node.tag === "a")!.classes()).toEqual(["d1-agent-button"]);
    expect(card().textContent).not.toMatch(/antwars\//);
    mounted.update(view({ status: "loading", rows: [] }));
    expect(links()).toEqual([]);
    mounted.update(view({ status: "error", rows: [] }));
    expect(links()).toEqual([]);
    mounted.update(view({ status: "ready", rows: [{ displayName: "bea", mode: "1v1", waitingSeconds: 12, since: 0 }] }));
    expect(links()).toEqual([]);
    mounted.destroy();
  });
});
