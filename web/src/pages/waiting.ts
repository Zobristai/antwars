// The Matches page's Waiting card: every agent waiting in a ranked queue or Quadrants, read-only, directly above Live now,
// then one row per public lobby with a seated agent whose match has not begun, from the same read (GET /watch/queue). Private
// lobbies are never sent; a row leaves once its match begins. The card says its own state once, as Live now does, and has no
// Refresh of its own: the page's one Refresh reads it again, and it does not update while open (no polling).
//
// Each row is drawn by the one Matches row builder (matches.ts matchCard), in the same six columns: when the wait began,
// the game type, the two colonies, the status stamp and no button (there is nothing to watch yet). A ranked queued agent
// stands in the first colony with "no opponent yet" in the second. A queued Free-for-all agent has no assigned colony:
// its identity spans both colony columns under Agent, without an opponent placeholder. A lobby's seated players stand in their colonies, a held house
// seat not yet taken "not joined yet", and a colony with room "seat open". A queued pairing is STARTING; a lobby shows how
// many seats are taken, STARTING once full. A Quadrants lobby is a four-colony row, each colony under its Quadrants name
// and colour as Live now draws one, and always shows its seats taken out of four; Free-for-all ratings are not displayed here. A player line is drawn as everywhere: a builder by its username and rating
// (the server learns a builder's model only when it joins a match), a house model by its model, level and Fast.
//
// A lobby's kind takes the Game type badge's words (ui/format.ts MATCH_TYPE_WORDS): Index, Ranked, Challenge, Quadrants
// (with no NvN), and Unranked for a public or invite-only lobby, told by the rule the server types a recording's lobby by
// (src/replays/recorded-match-type.ts).
//
// When nothing at all is waiting the card offers "challenge a house handle", a link to the Leaderboard's Antwars Model
// Index 1v1 board, in the site's cyan button.
import type { MatchesView, ShownRating, WaitingLobby, WaitingRow } from "../matches-page/data.ts";
import { rowName } from "../ui/deck/model.ts";
import { SEAT } from "../compose.ts";
import { NO_BADGES } from "../leaderboard-page/view.ts";
import { MATCH_TYPE_WORDS, RETRY, keep, listedNames, utcStamp, type SectionState } from "../ui/format.ts";
import { h } from "../ui/dom.ts";
import { STAMPS, seatsStamp, type ColonyCell, type MatchRow, type RowParts } from "./matches.ts";
import { CHALLENGE_HREF, houseBadges, seatGroups, sectionLine, sizeOf, type PlayerParts, type SeatEntry, type SeatGroup } from "./model.ts";

export const WAITING_TITLE = "Waiting";
/** The empty card's offer, linking to the Leaderboard's Antwars Model Index 1v1 board. */
export const CHALLENGE_OFFER = "challenge a house handle";
/** A house challenge's held colony (src/lobby/challenges.ts HELD_COLONY). */
const HELD_COLONY = 0;
export const NO_OPPONENT = "no opponent yet";
export const NOT_JOINED_YET = "not joined yet";
export const SEAT_OPEN = "seat open";

const isLobby = (row: WaitingRow): row is WaitingLobby => "colonies" in row;
const QUADRANTS = "quadrants";

/** A lobby's kind, by the rule the server types a recording's lobby by (src/replays/recorded-match-type.ts): quadrants is
 * Quadrants, a house-* mode the Antwars Model Index, any other mode the ranked queue, a modeless lobby a house challenge or
 * else a public or invite-only (unranked) lobby. */
export function lobbyKind(lobby: Pick<WaitingLobby, "mode" | "challenge">): "index" | "ranked" | "challenge" | "unranked" | "quadrants" {
  if (lobby.mode === QUADRANTS) return "quadrants";
  if (lobby.mode !== null) return lobby.mode.startsWith("house-") ? "index" : "ranked";
  return lobby.challenge === "house" ? "challenge" : "unranked";
}

/** A waiting row's Game type: "Ranked · 1v1" for a queued agent, a lobby's kind and size; "Free-for-all" alone, whose four
 * colonies are no NvN. */
export function waitingType(row: WaitingRow): string {
  if (row.mode === QUADRANTS) return MATCH_TYPE_WORDS.quadrants;
  if (!isLobby(row)) return `${MATCH_TYPE_WORDS[lobbyKind({ mode: row.mode })]} · ${sizeOf(row.mode)}`;
  return `${MATCH_TYPE_WORDS[lobbyKind(row)]} · ${row.size}v${row.size}`;
}

/** A waiting seat: a house handle by its own row's model name, level and Fast (rowName); any other identity by its username
 * alone; each with its rating where the server sends one. Its name is who holds it: the queue sends no other identity. */
export function waitingSeat(name: string, rating: ShownRating | null): SeatEntry {
  const row = rowName(name, undefined);
  const parts: PlayerParts = row.benchmark ? { user: null, model: row.name, badges: houseBadges(SEAT.exec(name)?.[1] ?? name) } : { user: name, model: null, badges: NO_BADGES };
  return { who: name, parts, rating };
}

/** A colony's waiting seats as player lines (seatGroups): one identity holding several seats once, with ×N. The server lists
 * each identity once per colony with how many seats it holds there (one each where it sends no count). */
export function waitingPlayers(names: readonly string[], ratings: readonly (ShownRating | null | undefined)[] | undefined,
  seats?: readonly number[]): SeatGroup[] {
  return seatGroups(names.flatMap((name, at) =>
    Array.from({ length: seats?.[at] ?? 1 }, () => waitingSeat(name, ratings?.[at] ?? null))));
}

/** A waiting row as the one row builder draws it. Its id is its place in the list: rows carry no public id. */
export function waitingMatchRow(row: WaitingRow, index: number): MatchRow {
  const when = utcStamp(row.since) ?? "Start unknown";
  const base = { id: String(index), when, type: waitingType(row), action: null };
  if (!isLobby(row)) {
    if (row.mode === QUADRANTS) {
      return { ...base, stamp: { text: STAMPS.waiting, look: "waiting" }, colonies: [],
        queuedAgent: { ...waitingSeat(row.displayName, null), seats: 1 } };
    }
    return { ...base, stamp: { text: STAMPS.waiting, look: "waiting" },
      colonies: [{ lines: waitingPlayers([row.displayName], [row.rating ?? null]), result: null, note: null }, { lines: [], result: null, note: NO_OPPONENT, absent: true }] };
  }
  const colonies = row.colonies.length, seats = colonies * row.size;
  const full = row.seated >= seats;
  const colony = (names: readonly string[], index: number): ColonyCell => {
    const lines = waitingPlayers(names, row.ratings?.[index], row.seats?.[index]);
    const open = names.length < row.size && !full;
    const note = !open ? null : row.challenge === "house" && index === HELD_COLONY ? NOT_JOINED_YET : SEAT_OPEN;
    return { lines, result: null, note, ...(lines.length === 0 ? { absent: true as const } : {}) };
  };
  const stamp = row.mode === QUADRANTS ? seatsStamp(row.seated, seats) : row.mode !== null || full ? STAMPS.starting : seatsStamp(row.seated, seats);
  // A four-colony row always names its colonies (its own names, else the four in table order), as Live now does.
  const names = colonies > 2 ? listedNames(row, colonies) : row.colonyNames ?? undefined;
  return { ...base, stamp: { text: stamp, look: "waiting" }, colonies: row.colonies.map(colony), ...(names ? { colonyNames: names } : {}) };
}

/** What is waiting, one tally per kind, under the card's "Waiting" title: ranked-queue agents, Free-for-all agents, public
 * lobbies whose match has not begun. A tally has no singular or plural ("Ranked queue: 1", "Ranked queue: 12"). */
export function waitingParts(rows: readonly WaitingRow[]): string[] {
  const lobbies = rows.filter(isLobby).length;
  const quadrants = rows.filter(row => !isLobby(row) && row.mode === QUADRANTS).length, agents = rows.length - lobbies - quadrants;
  return [
    ...(agents > 0 ? [`Ranked queue: ${agents}`] : []),
    ...(quadrants > 0 ? [`${MATCH_TYPE_WORDS.quadrants}: ${quadrants}`] : []),
    ...(lobbies > 0 ? [`Lobbies: ${lobbies}`] : []),
  ];
}

export const QUEUES_UNAVAILABLE = "Queues unavailable";
export const LAST_LIST_SHOWN = "Showing the last list";

export function waitingState(view: Pick<MatchesView, "waiting">): SectionState {
  const { status, rows } = view.waiting;
  if (status === "loading") return { tone: "loading", text: rows.length ? "Refreshing…" : "Loading…" };
  if (status === "error") return { tone: "error", text: rows.length ? `${QUEUES_UNAVAILABLE} · ${LAST_LIST_SHOWN}` : QUEUES_UNAVAILABLE };
  if (rows.length === 0) return { tone: "empty", text: "No agent waiting" };
  return { tone: "complete", text: waitingParts(rows).join(" · ") };
}

/** The state's one-line items where it has several: each kind of wait; or the failure, the last list where one is still
 * shown, and how to recover (RETRY), so each stays on one line at any text size. */
function waitingItems(view: Pick<MatchesView, "waiting">, state: SectionState): readonly string[] | null {
  if (state.tone === "complete") return waitingParts(view.waiting.rows);
  if (state.tone === "error") return [QUEUES_UNAVAILABLE, ...(view.waiting.rows.length ? [LAST_LIST_SHOWN] : []), RETRY];
  return null;
}

export function waitingCard(doc: Document, view: Pick<MatchesView, "waiting">, parts: RowParts): HTMLElement {
  const foot: HTMLElement[] = [];
  if (view.waiting.status === "ready" && view.waiting.rows.length === 0) {
    // Nothing waiting: the card's foot offers a house challenge in the site's cyan button (deck.css .d1-agent-button).
    const link = h(doc, "a", "d1-agent-button", CHALLENGE_OFFER);
    link.href = keep(CHALLENGE_HREF, doc.defaultView?.location.search ?? "");
    link.dataset.key = "waiting-challenge";
    foot.push(link);
  }
  const state = waitingState(view), rows = view.waiting.rows, items = waitingItems(view, state);
  return parts.matchCard({
    list: "wait", titleId: "d1p-waiting-title", title: WAITING_TITLE, cardClass: "d1p-waiting",
    // Each kind of wait, and each part of a failure, is a one-line item of its own (chrome.ts stateList), never one wrapped line.
    state: { ...sectionLine(state, rows.length), ...(items ? { parts: items } : {}) },
    rows: view.waiting.rows.map(waitingMatchRow), loading: false, actionHead: "", foot,
  });
}
