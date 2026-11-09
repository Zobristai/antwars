// The Matches page's Waiting card: every agent waiting in a ranked queue, read-only, directly above Live now. One
// row per agent with its public name, the queue's mode and how long it had waited when the list was read; an empty state
// when none is waiting. GET /watch/queue sends only those three facts. The card says its own state once, as Live now does,
// and has no Refresh of its own: the page's one Refresh reads it again. Like Live now it does not update while open, so each
// row says its time waited is as of the load (no polling, no ticking clock).
//
// After the queue rows, one row per public lobby with a seated agent whose match has not begun, from the same
// read, each colony's seated names in its colony's column. Private lobbies are never sent. A row leaves once its match begins.
//
// One row style: Live now's grid and column order (matches.ts rowParts, MATCH_COLUMNS), a
// table in a wide card and its stacked rows in a narrow one. Waited stands in the start column, the match's kind in the
// outcome column, then the colonies; Waiting has no record and no action, so the second colony spans those columns, and a
// queued agent, which has no colony yet, spans both colonies'. A lobby's kind takes the standing mode names:
// "Index", "Challenge", "Ranked", and "Lobby" for a public or invite-only lobby, told by the rule the server
// types a recording's lobby by (src/replays/history-routes.ts recordingMatchType); "Unranked" is not a mode name and never
// shows here. A queued agent's mode takes the same words.
//
// When nothing at all is waiting the card offers "challenge a house handle", a link to the Leaderboard's Challenge choice,
// in the site's cyan button.
import type { MatchesView, WaitingAgent, WaitingLobby, WaitingRow } from "../matches-page/data.ts";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { rowName } from "../ui/deck/model.ts";
import { MATCH_TYPE_WORDS, keep, type SectionState } from "../ui/format.ts";
import { h } from "../ui/dom.ts";
import { stateLine } from "./chrome.ts";
import type { RowParts } from "./matches.ts";
import { CHALLENGE_HREF, sectionLine, sizeOf, type SeatGroup } from "./model.ts";

export const WAITING_TITLE = "Waiting";
/** The table's heads before the colonies': the time waited, then the match's kind. */
export const WAITING_HEADS = ["Waited", "Match"] as const;
/** The time waited is as of the list's load. */
const WHEN_LOADED = "when loaded";
const COLONIES = [0, 1] as const;
/** The empty card's offer, linking to the Leaderboard's Challenge choice. */
export const CHALLENGE_OFFER = "challenge a house handle";

/** A queue's mode in the Recordings badge's words, as a lobby's: "Index · 1v1" for a house
 * mode, "Ranked · 2v2" otherwise. */
export function waitingMode(mode: WaitingAgent["mode"]): string {
  return `${WAITING_KIND_WORDS[lobbyKind({ mode })]} · ${sizeOf(mode)}`;
}

/** Time waited at the read, in whole minutes: the queue's own expiry (12 hours; 15 minutes in a house mode) bounds it. */
export function waitedText(seconds: number): string {
  return seconds < 60 ? "under 1 min" : `${Math.floor(seconds / 60)} min`;
}

const isLobby = (row: WaitingRow): row is WaitingLobby => "colonies" in row;

/** The standing mode names: the Recordings badge's words for the index,
 * ranked and challenge kinds, and "Lobby" for a public or invite-only lobby, never "Unranked". */
export const WAITING_KIND_WORDS = {
  index: MATCH_TYPE_WORDS.index, ranked: MATCH_TYPE_WORDS.ranked, challenge: MATCH_TYPE_WORDS.challenge, lobby: "Lobby",
} as const;

/** A lobby's kind, by the rule the server types a recording's lobby by (src/replays/history-routes.ts
 * recordingMatchType): a house-* mode is the Antwars Model Index, any other mode the ranked queue, a modeless lobby a house
 * challenge or else a public or invite-only lobby. */
export function lobbyKind(lobby: Pick<WaitingLobby, "mode" | "challenge">): keyof typeof WAITING_KIND_WORDS {
  if (lobby.mode !== null) return lobby.mode.startsWith("house-") ? "index" : "ranked";
  return lobby.challenge === "house" ? "challenge" : "lobby";
}

/** A lobby row's Match text, its kind in the standing mode name: a
 * queue pairing "Ranked · 2v2 · paired, starting soon", a lobby "Lobby · 2v2 · 3 of 4 seats". Its time waited stands in
 * the Waited column. */
export function lobbyText(lobby: WaitingLobby): string {
  const kind = `${WAITING_KIND_WORDS[lobbyKind(lobby)]} · ${lobby.size}v${lobby.size}`;
  return lobby.mode !== null ? `${kind} · paired, starting soon` : `${kind} · ${lobby.seated} of ${2 * lobby.size} seats`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function waitingState(view: Pick<MatchesView, "waiting">): SectionState {
  const { status, rows } = view.waiting;
  if (status === "loading") return { tone: "loading", text: rows.length ? "Refreshing the ranked queues…" : "Loading the ranked queues…" };
  if (status === "error") return { tone: "error", text: rows.length ? "Queue list unavailable · showing the last list loaded" : "Queue list unavailable" };
  const lobbies = rows.filter(isLobby).length, agents = rows.length - lobbies;
  if (rows.length === 0) return { tone: "empty", text: "No agent waiting in a ranked queue or lobby" };
  const parts = [
    ...(agents > 0 ? [`${plural(agents, "agent", "agents")} waiting in a ranked queue`] : []),
    ...(lobbies > 0 ? [`${plural(lobbies, "match", "matches")} waiting to start`] : []),
  ];
  return { tone: "complete", text: parts.join(" · ") };
}

export function waitingCard(doc: Document, view: Pick<MatchesView, "waiting">, parts: RowParts): HTMLElement {
  const { headCell, matchGrid, seatBlock, colonyList } = parts;
  const state = sectionLine(waitingState(view), view.waiting.rows.length);
  const section = h(doc, "section", "d1p-card d1p-waiting");
  section.setAttribute("aria-labelledby", "d1p-waiting-title");
  const head = h(doc, "div", "d1p-card-head");
  const title = h(doc, "h2", "d1p-card-title", WAITING_TITLE);
  title.id = "d1p-waiting-title";
  head.append(title, stateLine(doc, state.glyph, state.text));
  section.append(head);
  if (view.waiting.status === "ready" && view.waiting.rows.length === 0) {
    // Nothing waiting: the state line stays as it was, and the card's foot offers a house challenge in the site's cyan
    // button (deck.css .d1-agent-button), as the Matches rows' Watch and Replay are.
    const foot = h(doc, "div", "d1p-card-foot");
    const link = h(doc, "a", "d1-agent-button", CHALLENGE_OFFER);
    link.href = keep(CHALLENGE_HREF, doc.defaultView?.location.search ?? "");
    link.dataset.key = "waiting-challenge";
    foot.append(link);
    section.append(foot);
  }
  if (view.waiting.rows.length > 0) {
    const table = h(doc, "table", "d1p-table d1p-wait d1p-wide");
    table.setAttribute("aria-labelledby", "d1p-waiting-title");
    matchGrid(table);
    // Live now's head row: Waited, Match, then each colony under its name, the second spanning the record and action
    // columns Waiting does not have.
    const labels = h(doc, "tr");
    labels.append(headCell(WAITING_HEADS[0], "c-start"), headCell(WAITING_HEADS[1], "c-result"));
    const colonyHeads = COLONIES.map(colony => headCell(COLONY_NAMES[colony], `c-model d1p-c${colony}`));
    colonyHeads[1]!.colSpan = 3;
    labels.append(...colonyHeads);
    const thead = h(doc, "thead");
    thead.append(labels);
    const tbody = h(doc, "tbody");
    const list = h(doc, "ul", "d1p-rows d1p-match-rows d1p-narrow");
    list.setAttribute("aria-labelledby", "d1p-waiting-title");
    /** A seat on its own line in the shared row style (matches.ts seatBlock), named through the HUD's rowName. */
    const seat = (name: string): HTMLElement => {
      const shown = rowName(name, undefined);
      const group: SeatGroup = { parts: { name: shown.name, badges: shown.badges, quiet: null }, seats: 1 };
      return seatBlock(group);
    };
    for (const row of view.waiting.rows) {
      const waited = waitedText(row.waitingSeconds);
      const match = isLobby(row) ? lobbyText(row) : waitingMode(row.mode);
      const line = h(doc, "tr");
      // The start column's two lines: the time waited over "when loaded".
      const when = h(doc, "th", "c-start");
      when.scope = "row";
      when.append(h(doc, "span", "d1p-date", waited), h(doc, "span", "d1p-time", WHEN_LOADED));
      const kind = h(doc, "td", "c-result");
      kind.append(h(doc, "span", "d1p-result", match));
      line.append(when, kind);
      const item = h(doc, "li");
      item.append(h(doc, "p", "d1p-line", `${waited} waiting ${WHEN_LOADED}`), h(doc, "p", "d1p-line is-lead", match));
      if (isLobby(row)) {
        COLONIES.forEach(colony => {
          const cell = h(doc, "td", "c-model");
          if (colony === 1) cell.colSpan = 3;
          cell.append(...row.colonies[colony].map(seat));
          line.append(cell);
        });
        // A colony with no seat yet is left blank: the Match text says how many seats are taken.
        item.append(colonyList(COLONIES.map(colony => row.colonies[colony].map(seat)), null));
      } else {
        // A queued agent has no colony yet: its name spans both colonies' columns.
        const cell = h(doc, "td", "c-model");
        cell.colSpan = 4;
        cell.append(seat(row.displayName));
        line.append(cell);
        const named = h(doc, "p", "d1p-line is-model");
        named.append(seat(row.displayName));
        item.append(named);
      }
      tbody.append(line);
      list.append(item);
    }
    table.append(thead, tbody);
    section.append(table, list);
  }
  return section;
}
