// The Archive (ported): Matches, following `main`. Three record cards, each saying its own state once: Waiting, Live now
// and Recordings (and the landing page's list, which draws Recordings' card). The band's Refresh is the page's only one: a
// failed card says so in its state line and carries no second Refresh.
//
// One row layout for every record (the signed-off rows drawing): six columns in every table, Time (date over UTC time;
// Waiting's when the wait began), Game type (one badge), the two colonies, Status (one stamp: WAITING, STARTING,
// n OF m SEATS, LIVE, COMPLETE, PARTIAL or UNAVAILABLE) and the button (Watch for live, Replay for a recording, none while
// waiting). Each colony holds its players one line each, in one order everywhere: username (builders only), model, level,
// Fast, the cyan rating badge (figure only, ± on hover, tap or focus), ×N seats, then the colony's result (WINNER, DRAW or
// ABANDONED, in its ink; none while waiting or live). In a card too narrow for the table each row stacks in the same
// order in every list (archive.css): time, game type and status, each colony's name over its player lines, the button.
// Rows and links come from today's helpers (ui/format.ts), read-only.
import type { LiveMatch, LiveSeat, MatchesView, Recording } from "../matches-page/data.ts";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { colonyColours, colonyNameNote, colonyNamesOf, colourCss, type ColonyNamePair } from "../../../src/sim/colonyNames.ts";
import { SEAT, isBenchmark, rowName } from "../compose.ts";
import { benchmarkLabel } from "../leaderboard-page/view.ts";
import { liveRow, recordingRows, recordingType, utcStamp } from "../ui/format.ts";
import { PAGE_WORDS, pill } from "../ui/pages.ts";
import { h } from "../ui/dom.ts";
import type { Mounted } from "../ui/types.ts";
import { mountFrame, rebuild, stateLine } from "./chrome.ts";
import { rowRatingNode } from "./identity.ts";
import { waitingCard } from "./waiting.ts";
import {
  RECORDINGS_LIST, colonySeats, liveKind, liveLine, loadedText, loadsSettled, matchesLists, recordingsLine, seatGroups, seatModelName, stampWord,
  whenParts, winnerOf, type CardState, type LoadsSeen, type PlayerParts, type SeatEntry, type SeatGroup,
} from "./model.ts";

/** The HUD's tooltip words, held as a placeholder (‡): these
 * pages follow whatever wording the HUD lands, and never say "house matches". */
const SELF_REPORTED = "Self-reported: outside the Antwars Model Index, each agent names its own model.";
/** Every table's heads, the button's read by screen readers only. */
export const MATCH_HEADS = ["Time", "Game type", "Status"] as const;
/** The colony columns' heads where a list's rows name their colonies differently: each cell then names its own. */
export const COLONY_HEADS = ["First colony", "Second colony"] as const;
const COLONIES = [0, 1] as const;
/** One column grid for every list (archive.css). */
const MATCH_COLUMNS = ["c-start", "c-type", "c-model", "c-model", "c-status", "c-go"] as const;
/** A colony's result, on each of its player lines. */
export type ColonyResult = "Winner" | "Draw" | "Abandoned";
/** The Status column's stamps besides a record's own (stampWord). */
export const STAMPS = { waiting: "Waiting", starting: "Starting", live: "Live" } as const;
export const seatsStamp = (seated: number, of: number): string => `${seated} of ${of} seats`;
/** A row's start when the record gives none. */
const START_UNKNOWN = "Start unknown";

export interface MatchesActions { refresh(): void; more(): void }

/** One colony of one row: its player lines, its result, and a quiet line where it has no player or an open seat. */
export interface ColonyCell {
  readonly lines: readonly SeatGroup[];
  readonly result: ColonyResult | null;
  /** Shown in place of lines where there are none ("did not join", "no opponent yet"), or after them ("seat open"). */
  readonly note: string | null;
}
/** One row of any Matches list, as the one row builder draws it in both forms. */
export interface MatchRow {
  /** Unique in its list: the focus keys of its button and rating badges build on it. */
  readonly id: string;
  readonly when: string;
  /** The Game type badge's words ("Ranked · 1v1"); null for no badge, or the quiet words where it is not recorded. */
  readonly type: string | null;
  readonly typeNote?: string;
  readonly colonies: readonly [ColonyCell, ColonyCell];
  /** The status stamp: its words and its look, as the drawing draws it: a record's (complete, partial, unavailable) solid, a
   * waiting row's (WAITING, STARTING, n OF m SEATS) dashed, a live match's red. */
  readonly stamp: { readonly text: string; readonly look: "complete" | "partial" | "unavailable" | "waiting" | "live" };
  readonly action: { readonly text: string; readonly href: string; readonly label: string } | null;
  /** The match's own colony names (an unrated match's drawn pair); absent where it uses the rated names. */
  readonly colonyNames?: ColonyNamePair;
}
/** One Matches list's card. */
export interface MatchList {
  /** The list's key prefix ("wait", "live", "rec") and its title's id. */
  readonly list: string;
  readonly titleId: string;
  readonly title: string;
  readonly state: CardState;
  readonly rows: readonly MatchRow[];
  /** Skeleton rows while the first load is in flight. */
  readonly loading: boolean;
  /** The button column's head, read by screen readers. */
  readonly actionHead: string;
  readonly cardClass?: string;
  readonly foot?: readonly HTMLElement[];
}

export function mountMatches(doc: Document, host: HTMLElement, actions: MatchesActions): Mounted<MatchesView> {
  const win = doc.defaultView!;
  const search = win.location.search;
  const frame = mountFrame(doc, host, "matches");

  // ---------------------------------------------------------------- the band: title, then Refresh with its freshness
  const summary = h(doc, "div", "d1p-summary");
  const title = h(doc, "h1", "d1p-title", PAGE_WORDS.matchesTitle);
  title.tabIndex = -1;
  const fresh = h(doc, "div", "d1p-fresh");
  const loaded = h(doc, "p", "d1p-loaded");
  const refresh = pill(doc, PAGE_WORDS.refresh);
  // The page's one Refresh in main's cyan.
  refresh.classList.add("d1p-refresh");
  refresh.dataset.key = "refresh";
  refresh.addEventListener("click", () => actions.refresh());
  // Refresh under the title, the time it last read after it: one group, and the time's arrival moves nothing.
  fresh.append(refresh, loaded);
  summary.append(title, fresh);
  frame.band.append(summary);
  queueMicrotask(() => { if (title.isConnected && (doc.activeElement === null || doc.activeElement === doc.body)) title.focus({ preventScroll: true }); });

  const parts = rowParts(doc);

  // ---------------------------------------------------------------- Live now
  const liveCard = (view: MatchesView): HTMLElement => parts.matchCard({
    list: "live", titleId: "d1p-live-title", title: PAGE_WORDS.live, state: liveLine(view),
    rows: view.live.rows.map(match => liveMatchRow(match, search)),
    loading: view.live.status === "loading" && view.live.rows.length === 0, actionHead: "Watch",
  });

  // ---------------------------------------------------------------- update
  let drawn = "", seen: LoadsSeen = new Map();
  let loadedAt: number | null = null;
  // Recordings while its load is this page's Load more, not a Refresh.
  let continuing: ReadonlySet<string> = new Set();
  return {
    update(view: MatchesView) {
      const settled = loadsSettled(seen, matchesLists(view), continuing);
      seen = settled.seen; continuing = settled.continuing;
      if (settled.moved) loadedAt = Date.now();
      const text = loadedAt === null ? "" : loadedText(loadedAt);
      if (loaded.textContent !== text) loaded.textContent = text;
      // As today: Refresh waits while either list is loading.
      refresh.disabled = view.live.status === "loading" || view.recordings.status === "loading";
      const next = JSON.stringify(view);
      if (next === drawn) return;
      drawn = next;
      const more = () => { continuing = new Set([...continuing, RECORDINGS_LIST]); actions.more(); };
      rebuild(doc, frame.content, () => [waitingCard(doc, view, parts), liveCard(view), recordingsCard(doc, view, { search, more })]);
    },
    destroy() { frame.destroy(); },
  };
}

// ---------------------------------------------------------------- Live now's rows

/** A live colony's players, one line each: a house handle by its own row's model name and badges (the HUD's rowName), with
 * no username; a builder by its username, then the model it self-reported (seatModelName; none where the label only repeats
 * the username) with the level and Fast badges it reported on joining (benchmarkLabel; only with a model), then its rating
 * badge where the catalog gives one. An identity holding several seats is "<name> #<seat>"
 * on each (compose.ts SEAT): where a colony holds several of them it is listed there once, with how many seats it holds;
 * a seat it holds alone in its colony keeps its "#<seat>". */
export function livePlayers(seats: readonly LiveSeat[]): SeatGroup[] {
  return seatGroups(seats.map((seat): SeatEntry => {
    const who = SEAT.exec(seat.displayName)?.[1] ?? seat.displayName;
    const house = isBenchmark(who);
    const reported = seat.modelLabel && !house ? seatModelName(seat.modelLabel, who) : null;
    const model = reported !== null && reported !== who ? reported : null;
    const shown = (name: string): PlayerParts => {
      if (house) { const row = rowName(name, undefined); return { user: null, model: row.name, badges: row.badges }; }
      const badges = model === null ? [] : benchmarkLabel({ displayName: "", thinkingLevel: seat.thinkingLevel ?? null, serviceTier: seat.serviceTier ?? null }).badges;
      return { user: name, model, badges };
    };
    const rating = seat.rating === null ? null : { rating: seat.rating, rd: seat.rd, ratedMatches: seat.ratedMatches };
    // Seats group by identity, the model, level and tier each reported and its rating, so an identity's seats that differ
    // in any keep their own line.
    return { who: JSON.stringify([who, seat.modelLabel ?? null, seat.thinkingLevel ?? null, seat.serviceTier ?? null]), parts: shown(seat.displayName), alike: shown(who), rating };
  }));
}

/** A live match as the one row builder draws it: its start, the type the catalog gives, each colony's players with no
 * result, LIVE, and Watch. */
export function liveMatchRow(match: LiveMatch, search: string): MatchRow {
  const row = liveRow(match, search), when = utcStamp(match.startedAt) ?? START_UNKNOWN;
  const seated = match.colonies[0].length + match.colonies[1].length > 0;
  const colony = (index: 0 | 1): ColonyCell => {
    const lines = livePlayers(match.colonies[index]);
    return { lines, result: null, note: lines.length > 0 ? null : "not recorded" };
  };
  const type = recordingType(match.matchType);
  return {
    id: row.id, when, type, colonies: [colony(0), colony(1)],
    ...(type === null && !seated ? { typeNote: "not recorded" } : {}),
    stamp: { text: STAMPS.live, look: "live" },
    action: { text: "Watch", href: row.href, label: `Watch, ${liveKind(match)} started ${when}` },
    ...(match.colonyNames ? { colonyNames: match.colonyNames } : {}),
  };
}

// ---------------------------------------------------------------- one row's parts, shared by every list
/** The parts the Matches lists are built from, so Waiting, Live now and Recordings stand on one column grid. */
export type RowParts = ReturnType<typeof rowParts>;
function rowParts(doc: Document) {
  /** A row's link, Watch or Replay, in the site's one cyan primary button (deck.css .d1-agent-button), keyed by its list,
   * layout and row, so a redraw of another list keeps focus on it. */
  const rowPill = (text: string, href: string, label: string, key: string) => {
    const link = h(doc, "a", "d1-agent-button d1p-row-pill", text);
    link.href = href;
    link.dataset.key = key;
    link.setAttribute("aria-label", label);
    return link;
  };
  const card = (id: string, heading: string, lines: Node[], body: Node[], actionsRow: readonly HTMLElement[], cls?: string) => {
    const section = h(doc, "section", cls ? `d1p-card ${cls}` : "d1p-card");
    section.setAttribute("aria-labelledby", id);
    const head = h(doc, "div", "d1p-card-head");
    const titleNode = h(doc, "h2", "d1p-card-title", heading);
    titleNode.id = id;
    head.append(titleNode, ...lines);
    section.append(head, ...body);
    if (actionsRow.length) {
      const foot = h(doc, "div", "d1p-card-foot");
      foot.append(...actionsRow);
      section.append(foot);
    }
    return section;
  };
  const skeleton = (cells: number, widths: readonly string[]) => {
    const row = h(doc, "tr");
    for (let index = 0; index < cells; index++) {
      const cell = h(doc, "td"), bar = h(doc, "span", "d1p-skel");
      if (widths[index]) { bar.style.width = widths[index]!; cell.append(bar); }
      row.append(cell);
    }
    return row;
  };
  const headCell = (text: string, cls: string) => { const cell = h(doc, "th", cls, text); cell.scope = "col"; return cell; };
  const srHead = (text: string, cls: string) => { const cell = h(doc, "th", cls); cell.scope = "col"; if (text) cell.append(h(doc, "span", "d1p-sr", text)); return cell; };
  const columns = (table: HTMLTableElement, classes: readonly string[]) => {
    const group = h(doc, "colgroup");
    for (const cls of classes) group.append(h(doc, "col", cls));
    table.append(group);
  };
  /** A row's start as its date over its time, the row's header. */
  const startCell = (when: string) => {
    const parts = whenParts(when);
    const cell = h(doc, "th", "c-start");
    cell.scope = "row";
    cell.append(h(doc, "span", "d1p-date", parts.date));
    if (parts.time) cell.append(h(doc, "span", "d1p-time", parts.time));
    return cell;
  };
  /** A stacked row's start line: the date with its dot, then the time, each held whole (archive.css .d1p-keep), so a row
   * too narrow for both breaks only between them. */
  const startLine = (when: string) => {
    const parts = whenParts(when);
    const line = h(doc, "p", "d1p-line");
    if (parts.time === null) line.append(h(doc, "span", "d1p-keep", parts.date));
    else line.append(h(doc, "span", "d1p-keep", `${parts.date} ·`), " ", h(doc, "span", "d1p-keep", parts.time));
    return line;
  };
  /** One player line, in its one order: username (builders only), model, level and Fast badges, rating badge, ×N seats,
   * then the colony's result in its ink. The username and model are one name unit, the line's first child: too long for
   * its column, it ends in an ellipsis there, its whole text its title on hover and read in full by a screen reader;
   * badges, the rating, the count and the result are never cut. `key` keys its rating badge for focus across redraws. */
  const playerLine = ({ parts, seats, rating }: SeatGroup, colony: 0 | 1, result: ColonyResult | null, key: string) => {
    const node = h(doc, "span", "d1p-model");
    const name = h(doc, "span", "d1p-name");
    if (parts.user !== null) name.append(h(doc, "span", "d1p-user", parts.user));
    if (parts.user !== null && parts.model !== null) name.append(" ");
    if (parts.model !== null) name.append(h(doc, "span", "d1p-mname", parts.model));
    name.title = [parts.user, parts.model].filter(word => word !== null).join(" ");
    node.append(name);
    if (parts.badges.length > 0) {
      const tags = h(doc, "span", "d1p-tags");
      tags.append(...parts.badges.map(badge => h(doc, "span", "d1p-tag", badge)));
      tags.title = parts.badges.join(" ");
      node.append(tags);
    }
    if (rating) node.append(rowRatingNode(doc, rating, `${key}|rating`));
    if (seats > 1) {
      const count = h(doc, "span", "d1p-count");
      const shown = h(doc, "span", undefined, `×${seats}`);
      shown.setAttribute("aria-hidden", "true");
      count.append(shown, h(doc, "span", "d1p-sr", `, ${seats} seats`));
      node.append(count);
    }
    if (result !== null) node.append(h(doc, "span", `d1p-tag d1p-result-tag d1p-c${colony}`, result));
    return node;
  };
  const note = (text: string) => h(doc, "span", "d1p-model d1p-unknown", text);
  /** A colony's lines in a row, in either form: its players, then its quiet note ("seat open"), or the note alone. */
  const colonyLines = (cell: ColonyCell, colony: 0 | 1, key: string): HTMLElement[] => [
    ...cell.lines.map((group, index) => playerLine(group, colony, cell.result, `${key}|${colony}|${index}`)),
    ...(cell.note !== null ? [note(cell.note)] : []),
  ];
  const typeNodes = (row: MatchRow) => row.type !== null ? [h(doc, "span", "d1p-tag d1p-type", row.type)]
    : row.typeNote ? [h(doc, "span", "d1p-unknown", row.typeNote)] : [];
  const stampNode = (row: MatchRow) => {
    const node = h(doc, "span", `d1p-stamp is-${row.stamp.look}`);
    node.append(h(doc, "span", "d1p-sr", "Status "), row.stamp.text);
    return node;
  };
  /** A row naming its own colonies inks them in their names' colours (--aw-k0, --aw-k1, archive.css .d1p-c0 and .d1p-c1). */
  const inkColonies = (node: HTMLElement, row: MatchRow) => {
    if (row.colonyNames === undefined) return;
    const colours = colonyColours(row.colonyNames);
    for (const colony of COLONIES) node.style.setProperty(`--aw-k${colony}`, colourCss(colours[colony]));
  };
  /** A colony's name in its ink; a drawn name has its source as its tooltip, and the rated names are shown as they were. */
  const colonyLabel = (tag: "dt" | "span", row: MatchRow, colony: 0 | 1) => {
    const name = colonyNamesOf(row)[colony];
    const node = h(doc, tag, `d1p-colony d1p-c${colony}`, name);
    const note = row.colonyNames === undefined ? null : colonyNameNote(name);
    if (note) node.title = note;
    return node;
  };
  /** The stacked rows' colonies: each colony's name in its ink over (or beside) its lines. */
  const colonyList = (row: MatchRow, lines: readonly (readonly HTMLElement[])[]) => {
    const list = h(doc, "dl", "d1p-colonies");
    for (const colony of COLONIES) {
      const block = h(doc, "dd");
      block.append(...lines[colony]!);
      list.append(colonyLabel("dt", row, colony), block);
    }
    return list;
  };
  /** One Matches list's card: its state line, then its table and its stacked rows, both from the same rows. */
  const matchCard = (spec: MatchList): HTMLElement => {
    const body: Node[] = [];
    if (spec.rows.length > 0 || spec.loading) {
      const table = h(doc, "table", `d1p-table d1p-match d1p-${spec.list} d1p-wide`);
      table.setAttribute("aria-labelledby", spec.titleId);
      columns(table, MATCH_COLUMNS);
      const head = h(doc, "thead"), labels = h(doc, "tr");
      labels.append(headCell(MATCH_HEADS[0], "c-start"), headCell(MATCH_HEADS[1], "c-type"));
      // The rated names head their columns while every row uses them; otherwise each cell names its own colonies.
      const ownNames = spec.rows.some(row => row.colonyNames !== undefined);
      // A colony's ink is its name's, so the general heads over rows naming their own colonies take none.
      for (const colony of COLONIES) labels.append(headCell(ownNames ? COLONY_HEADS[colony] : COLONY_NAMES[colony], ownNames ? "c-model" : `c-model d1p-c${colony}`));
      labels.append(headCell(MATCH_HEADS[2], "c-status"), srHead(spec.actionHead, "c-go"));
      head.append(labels);
      const tbody = h(doc, "tbody");
      const list = h(doc, "ul", "d1p-rows d1p-match-rows d1p-narrow");
      list.setAttribute("aria-labelledby", spec.titleId);
      if (spec.loading) {
        table.setAttribute("aria-hidden", "true"); list.hidden = true;
        for (let line = 0; line < 2; line++) tbody.append(skeleton(6, ["84px", "84px", "128px", "128px", "70px"]));
      }
      for (const row of spec.rows) {
        const wide = `${spec.list}|wide|${row.id}`, narrow = `${spec.list}|narrow|${row.id}`;
        const line = h(doc, "tr");
        inkColonies(line, row);
        const type = h(doc, "td", "c-type");
        type.append(...typeNodes(row));
        line.append(startCell(row.when), type);
        for (const colony of COLONIES) {
          const cell = h(doc, "td", "c-model");
          if (ownNames) cell.append(colonyLabel("span", row, colony));
          cell.append(...colonyLines(row.colonies[colony], colony, wide));
          line.append(cell);
        }
        const status = h(doc, "td", "c-status");
        status.append(stampNode(row));
        const go = h(doc, "td", "c-go");
        if (row.action) go.append(rowPill(row.action.text, row.action.href, row.action.label, wide));
        line.append(status, go);
        tbody.append(line);

        // The stacked row: its time, then its type and status, beside the button; then each colony's lines under its name.
        const item = h(doc, "li");
        inkColonies(item, row);
        const lead = h(doc, "p", "d1p-line is-lead");
        lead.append(...typeNodes(row), stampNode(row));
        item.append(startLine(row.when), lead);
        item.append(colonyList(row, COLONIES.map(colony => colonyLines(row.colonies[colony], colony, narrow))));
        if (row.action) item.append(rowPill(row.action.text, row.action.href, row.action.label, narrow));
        list.append(item);
      }
      table.append(head, tbody);
      body.push(table, list);
    }
    return card(spec.titleId, spec.title, [stateLine(doc, spec.state.glyph, spec.state.text)], body, spec.foot ?? [], spec.cardClass);
  };
  return { card, matchCard, rowPill };
}

// ---------------------------------------------------------------- Recordings

/** A recorded colony nobody joined: its record holds no seat of it. */
const NOT_JOINED = "did not join";
/** A record that saved nothing about its players. */
const NOT_RECORDED = "not recorded";

/** A recorded colony's result: Abandoned on each colony that joined an abandoned match; Winner on the winning colony where
 * the record names one, never on a colony nobody joined; Draw on both colonies in a draw; none otherwise. */
export function colonyResult(r: Pick<Recording, "winner" | "reason" | "decidedBy">, colony: 0 | 1, joined: boolean): ColonyResult | null {
  if (!joined) return null;
  if (r.reason === "abandoned") return "Abandoned";
  const winner = winnerOf(r);
  if (winner !== null) return winner === colony ? "Winner" : null;
  return r.decidedBy === "draw" ? "Draw" : null;
}

/** A recording as the one row builder draws it: its start, its type, each colony's recorded players with their rating at
 * the match's start where stored and the colony's result, its record stamp, and Replay. */
export function recordingMatchRow(r: Recording, row: ReturnType<typeof recordingRows>[number]): MatchRow {
  const seats = colonySeats(r.seats);
  const colony = (index: 0 | 1): ColonyCell => {
    if (seats === null) return { lines: [], result: null, note: NOT_RECORDED };
    const entries = seats[index];
    if (entries === null) return { lines: [], result: null, note: NOT_JOINED };
    return { lines: seatGroups(entries), result: colonyResult(r, index, true), note: null };
  };
  return {
    id: row.id, when: row.when, type: row.type, ...(row.type === null && seats === null ? { typeNote: NOT_RECORDED } : {}),
    colonies: [colony(0), colony(1)],
    stamp: { text: stampWord(r.status), look: r.status },
    action: { text: PAGE_WORDS.replay, href: row.href, label: `Replay, recording started ${row.when}` },
    ...(r.colonyNames ? { colonyNames: r.colonyNames } : {}),
  };
}

/** How the Recordings card is drawn: with the page's Load more (more), or, where a page shows only the newest rows (limit),
 * with that page's own link in the card's foot in place of Load more (foot). The card draws no asterisk,
 * so it reads no tip; the field stays for the landing page, which still passes one. */
export interface RecordingsCardOptions {
  readonly search: string;
  readonly tip?: ReturnType<typeof mountTip>;
  readonly more?: () => void;
  readonly limit?: number;
  readonly foot?: HTMLElement;
}

/** The Recordings list as the Matches page and the landing page draw it: a record card saying its own state once, in the
 * one row layout. */
export function recordingsCard(doc: Document, view: MatchesView, options: RecordingsCardOptions): HTMLElement {
  const { matchCard } = rowParts(doc);
  const all = recordingRows(view, options.search);
  // A limited card shows the newest rows; where more remain it says so in the list's own words, never Load more.
  const rows = options.limit === undefined ? all : all.slice(0, options.limit);
  const byId = new Map(view.recordings.rows.map(r => [r.id, r]));
  const state = recordingsLine(rows.length < all.length ? { ...view, next: view.next ?? "" } : view, rows.length);
  let foot: HTMLElement[] = [];
  if (options.foot) foot = [options.foot];
  else if (view.next !== null && options.more) {
    // Load more in the site's cyan button (deck.css .d1-agent-button), as the Leaderboard's is.
    const button = h(doc, "button", "d1-agent-button", PAGE_WORDS.more);
    button.type = "button";
    button.dataset.key = "more"; button.disabled = view.recordings.status === "loading";
    button.addEventListener("click", options.more);
    foot = [button];
  }
  return matchCard({
    list: "rec", titleId: "d1p-rec-title", title: PAGE_WORDS.recordings, state,
    rows: rows.map(row => recordingMatchRow(byId.get(row.id)!, row)),
    loading: view.recordings.status === "loading" && rows.length === 0, actionHead: PAGE_WORDS.replay, foot,
  });
}

/** The HUD's self-reported tooltip: focus, pointing or a tap on the asterisk opens it beside the
 * asterisk; it stays while pointed at, a tap elsewhere, Escape, leaving or scrolling the page closes it. Neither Matches
 * card draws the asterisk now; the landing page still mounts this. */
export function mountTip(doc: Document, scroller: HTMLElement, root: HTMLElement) {
  const win = doc.defaultView!;
  const tip = h(doc, "div", "d1p-tip", SELF_REPORTED);
  tip.id = "d1p-ast-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  root.append(tip);
  let owner: HTMLElement | null = null;
  const show = (target: HTMLElement) => {
    if (owner !== target) owner?.removeAttribute("data-open");
    owner = target; target.dataset.open = "";
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const width = tip.offsetWidth, height = tip.offsetHeight;
    const x = Math.max(8, Math.min(r.left - 12, win.innerWidth - width - 8));
    const below = r.bottom + 6;
    const y = below + height <= win.innerHeight - 8 ? below : Math.max(8, r.top - 6 - height);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };
  const hide = () => { owner?.removeAttribute("data-open"); owner = null; tip.hidden = true; };
  // A finger lifting is not a pointer leaving: a tap keeps the tip until the next tap elsewhere.
  const leave = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") return;
    const to = pointer.relatedTarget as Node | null;
    if (!(to && (tip.contains(to) || owner?.contains(to)))) hide();
  };
  const outside = (event: Event) => { const at = event.target as Node | null; if (owner && !(at && (tip.contains(at) || owner.contains(at)))) hide(); };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !tip.hidden) hide(); };
  tip.addEventListener("pointerleave", leave);
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("keydown", escape);
  scroller.addEventListener("scroll", hide, { passive: true });
  return {
    button(): HTMLButtonElement {
      const ast = h(doc, "button", "d1p-ast", "*");
      ast.type = "button";
      ast.setAttribute("aria-label", "Asterisk");
      ast.setAttribute("aria-describedby", tip.id);
      for (const type of ["focus", "pointerenter", "click"]) ast.addEventListener(type, () => show(ast));
      ast.addEventListener("blur", hide);
      ast.addEventListener("pointerleave", leave);
      return ast;
    },
    /** After a redraw, a tip whose asterisk was replaced closes. */
    settle() { if (owner && !owner.isConnected) hide(); },
    destroy() {
      doc.removeEventListener("pointerdown", outside);
      doc.removeEventListener("keydown", escape);
      scroller.removeEventListener("scroll", hide);
      tip.remove();
    },
  };
}
