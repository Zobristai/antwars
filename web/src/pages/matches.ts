// The Archive (ported): Matches, following `main`. Two record cards, each saying its own state once: Live now,
// and Recordings with one models column per colony. The band's Refresh is the page's only one: a failed card says so in
// its state line and carries no second Refresh. Real column tables, the two lists on one column grid with one
// head row each, in a card at least 56rem wide; in a narrower card each row stacks into labelled lines (archive.css). Rows
// and links come from today's helpers (ui/format.ts), read-only.
// Layout: every seat on one line with its badges, a colony's alike
// seats once with how many they are; the columns: Recordings' Time over the start column and its Game type over the outcome
// column, the winner a WINNER badge (DRAW in a draw) in its own colony's column and ink; Live now's Winner, "In progress", in
// place of Delay, and its Watch in Recordings'
// action column, where Replay sits; no Lobby and no rating in Live now; no MODELS * head and no self-reported asterisk anywhere.
import type { LiveMatch, LiveSeat, MatchesView, Recording } from "../matches-page/data.ts";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { SEAT, isBenchmark, rowName } from "../compose.ts";
import { liveRow, phaseDividers, recordingRows, utcStamp } from "../ui/format.ts";
import { PAGE_WORDS, pill } from "../ui/pages.ts";
import { h } from "../ui/dom.ts";
import type { Mounted } from "../ui/types.ts";
import { mountFrame, rebuild, stateLine } from "./chrome.ts";
import { nameNodes } from "./identity.ts";
import { waitingCard } from "./waiting.ts";
import {
  RECORDINGS_LIST, colonySeats, liveKind, liveLine, loadedText, loadsSettled, matchesLists, modelName, recordingsLine, seatGroups, seatModelName, stampWord,
  whenParts, winnerOf, type LoadsSeen, type NameParts, type SeatEntry, type SeatGroup,
} from "./model.ts";

/** The HUD's tooltip words, held as a placeholder (‡): these
 * pages follow whatever wording the HUD lands, and never say "house matches". */
const SELF_REPORTED = "Self-reported: outside the Antwars Model Index, each agent names its own model.";
const LIVE_HEADS = ["Started", "Winner"] as const;
/** Live now's one result. */
const IN_PROGRESS = "In progress";
const RECORDING_HEADS = ["Time", "Game type", "Record"] as const;
const COLONIES = [0, 1] as const;
/** One column grid for both lists (archive.css), so Live now's columns stand under Recordings' at every width. */
const MATCH_COLUMNS = ["c-start", "c-result", "c-model", "c-model", "c-record", "c-go"] as const;

export interface MatchesActions { refresh(): void; more(): void }

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
  const { card, skeleton, headCell, srHead, columns, startCell, rowPill, seatBlock, colonyList, phaseRows } = parts;
  /** Live now's second colony cell spans the record column Live now does not have. */
  const spanRecord = <T extends HTMLTableCellElement>(colony: 0 | 1, cell: T): T => { if (colony === 1) cell.colSpan = 2; return cell; };

  // ---------------------------------------------------------------- Live now
  const started = (match: LiveMatch) => utcStamp(match.startedAt) ?? "Start unknown";
  /** A live colony's players in the one row style every page shares (identity.ts), as Recordings lists its models:
   * the name and level/Fast badges through the HUD's rowName, no rating and no provisional,
   * and no thinking level for another player: the catalog carries none. An identity holding several seats is "<name> #<seat>" on
   * each (compose.ts SEAT): where a colony holds several of them it is listed there once, with how many seats it holds, as
   * alike recorded seats are; a seat it holds alone in its colony keeps
   * its "#<seat>", as before. A seat that self-reported a model shows that model, named as Recordings names it (modelName), in
   * its name's place (its own name where the model's provider part is that name, seatModelName); a seat that reported none
   * shows its name; a house handle always shows its own row's name. */
  const players = (seats: readonly LiveSeat[]): HTMLElement[] => seatGroups(seats.map((seat): SeatEntry => {
    const who = SEAT.exec(seat.displayName)?.[1] ?? seat.displayName;
    const reported = seat.modelLabel && !isBenchmark(who) ? seat.modelLabel : null;
    const model = reported !== null ? seatModelName(reported, who) : null;
    // A reported model is drawn as given, never read as a house handle; a seat with none keeps its own row's name.
    const shown = (name: string): NameParts => {
      if (model !== null) return { name: `${model}${name.slice(who.length)}`, badges: [], quiet: null };
      const row = rowName(name, undefined); return { name: row.name, badges: row.badges, quiet: null };
    };
    // Seats group by identity, the model each reported and the name it shows, so an identity's seats that differ in either
    // each keep their line.
    return { who: JSON.stringify([who, reported !== null ? modelName(reported) : null, model]), parts: shown(seat.displayName), alike: shown(who) };
  })).map(group => seatBlock(group));
  const notRecorded = (text: string) => h(doc, "span", "d1p-model d1p-unknown", text);
  const liveCard = (view: MatchesView): HTMLElement => {
    const state = liveLine(view);
    const rows = view.live.rows, loading = view.live.status === "loading" && rows.length === 0;
    const shown = rows.map(match => liveRow(match, search));
    // A divider before the first row of each harness phase (ui/format.ts phaseDividers). Live now's rows carry no Index
    // badge, so a match outside the Index (no phase sent) ends the divider above it, as does an Index match whose phase
    // the page cannot read.
    const dividers = phaseDividers(rows.map((match, at) =>
      shown[at]!.phase.length > 0 ? shown[at]!.phase : match.harnessPhase === undefined ? "outside" : "unknown"));
    const body: Node[] = [];
    if (rows.length > 0 || loading) {
      const table = h(doc, "table", "d1p-table d1p-live d1p-wide");
      table.setAttribute("aria-labelledby", "d1p-live-title");
      // Recordings' grid and head row: Winner, each colony's players under its models, and Watch in the action column,
      // headed for screen readers, as Replay is. Live now has no record, so its second colony spans the record's column:
      // no empty cell, and every column's left edge still stands under Recordings'.
      columns(table, MATCH_COLUMNS);
      const head = h(doc, "thead"), labels = h(doc, "tr");
      labels.append(headCell(LIVE_HEADS[0], "c-start"), headCell(LIVE_HEADS[1], "c-result"));
      for (const colony of COLONIES) labels.append(spanRecord(colony, headCell(COLONY_NAMES[colony], `c-model d1p-c${colony}`)));
      labels.append(srHead("Watch", "c-go"));
      head.append(labels);
      const list = h(doc, "ul", "d1p-rows d1p-match-rows d1p-narrow");
      list.setAttribute("aria-labelledby", "d1p-live-title");
      const groups = phaseRows(list);
      if (loading) {
        table.setAttribute("aria-hidden", "true"); list.hidden = true;
        for (let line = 0; line < 2; line++) groups.body().append(skeleton(6, ["84px", "120px", "128px", "128px"]));
      }
      for (const [at, match] of rows.entries()) {
        const row = shown[at]!, when = started(match);
        const name = `Watch, ${liveKind(match)} started ${when}`;
        const seated = match.colonies[0].length + match.colonies[1].length > 0;
        groups.divide(dividers[at]!);
        const line = h(doc, "tr");
        const result = h(doc, "td", "c-result");
        result.append(h(doc, "span", "d1p-result", IN_PROGRESS));
        line.append(startCell(when), result);
        if (!seated) {
          const none = h(doc, "td", "c-model");
          none.colSpan = 3;
          none.append(notRecorded("Seats not recorded"));
          line.append(none);
        } else {
          for (const colony of COLONIES) {
            const cell = h(doc, "td", "c-model");
            const seats = players(match.colonies[colony]);
            cell.append(...(seats.length > 0 ? seats : [notRecorded("not recorded")]));
            line.append(spanRecord(colony, cell));
          }
        }
        // Watch where Replay sits, by the same rowPill.
        const go = h(doc, "td", "c-go");
        go.append(rowPill("Watch", row.href, name, `live|wide|${row.id}`));
        line.append(go);
        groups.body().append(line);

        // Recordings' stacked row: the start, then the result, beside Watch; then each colony's players.
        const item = h(doc, "li");
        const lead = h(doc, "p", "d1p-line is-lead", IN_PROGRESS);
        item.append(h(doc, "p", "d1p-line", `Started ${when}`), lead);
        if (!seated) item.append(h(doc, "p", "d1p-line is-model d1p-unknown", "Seats not recorded"));
        else item.append(colonyList(COLONIES.map(colony => players(match.colonies[colony]))));
        item.append(rowPill("Watch", row.href, name, `live|narrow|${row.id}`));
        list.append(item);
      }
      table.append(head, ...groups.bodies());
      body.push(table, list);
    }
    return card("d1p-live-title", PAGE_WORDS.live, [stateLine(doc, state.glyph, state.text)], body, []);
  };

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

// ---------------------------------------------------------------- one row's parts, shared by both lists
/** The parts the Matches lists' rows are built from, so Waiting, Live now and Recordings stand on one column grid. */
export type RowParts = ReturnType<typeof rowParts>;
function rowParts(doc: Document) {
  /** A row's link, Watch or Replay, in the site's one cyan primary button (deck.css .d1-agent-button), keyed by its list,
   * layout and row, so a redraw of the other list keeps focus on it. */
  const rowPill = (text: string, href: string, label: string, key: string) => {
    const link = h(doc, "a", "d1-agent-button d1p-row-pill", text);
    link.href = href;
    link.dataset.key = key;
    link.setAttribute("aria-label", label);
    return link;
  };
  const card = (id: string, heading: string, lines: Node[], body: Node[], actionsRow: HTMLElement[]) => {
    const section = h(doc, "section", "d1p-card");
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
  const srHead = (text: string, cls: string) => { const cell = h(doc, "th", cls); cell.scope = "col"; cell.append(h(doc, "span", "d1p-sr", text)); return cell; };
  const columns = (table: HTMLTableElement, classes: readonly string[]) => {
    const group = h(doc, "colgroup");
    for (const cls of classes) group.append(h(doc, "col", cls));
    table.append(group);
  };
  /** A row's start as its date over its time, the row's header, in both lists. */
  const startCell = (when: string) => {
    const parts = whenParts(when);
    const cell = h(doc, "th", "c-start");
    cell.scope = "row";
    cell.append(h(doc, "span", "d1p-date", parts.date));
    if (parts.time) cell.append(h(doc, "span", "d1p-time", parts.time));
    return cell;
  };
  /** A seat on its own line, in both lists and both forms: its name and badges and, for alike seats, how many they are,
   * held on one line (archive.css .d1p-model). A name too long for its column ends in an ellipsis there, so its whole text
   * is its title on hover; a screen reader reads the text itself, which is never cut. */
  const seatBlock = ({ parts, seats }: SeatGroup) => {
    const node = h(doc, "span", "d1p-model");
    const [name, ...rest] = nameNodes(doc, parts);
    // nameNodes' first node is always the name's own span, then its badges' unit where it has any (identity.ts).
    (name as HTMLElement).title = parts.name;
    if (parts.badges.length > 0) (rest[0] as HTMLElement).title = parts.badges.join(" ");
    node.append(name!, ...rest);
    if (seats > 1) {
      const count = h(doc, "span", "d1p-count");
      const shown = h(doc, "span", undefined, `×${seats}`);
      shown.setAttribute("aria-hidden", "true");
      count.append(shown, h(doc, "span", "d1p-sr", `, ${seats} seats`));
      node.append(count);
    }
    return node;
  };
  /** The stacked rows' colonies, in every list: each colony's name in its ink, its seats one per line beside it, as the
   * table's colony columns hold them; a colony with none "not recorded", or blank where none is null (Waiting's open seats). */
  const colonyList = (seats: readonly (readonly HTMLElement[] | null)[], none: string | null = "not recorded") => {
    const list = h(doc, "dl", "d1p-colonies");
    for (const colony of COLONIES) {
      const lines = seats[colony];
      const block = h(doc, "dd");
      if (lines && lines.length > 0) block.append(...lines);
      else if (none !== null) block.append(h(doc, "span", "d1p-model d1p-unknown", none));
      list.append(h(doc, "dt", `d1p-colony d1p-c${colony}`, COLONY_NAMES[colony]), block);
    }
    return list;
  };
  /** The one six-column grid every Matches list stands on. */
  const matchGrid = (table: HTMLTableElement) => columns(table, MATCH_COLUMNS);
  /** A list's rows grouped by harness phase (ui/format.ts phaseDividers), in both forms: in the table, each divider opens
   * a row group with a divider row, its one header naming the phase for every row in the group; in the stacked list, a
   * divider item (archive.css .d1p-phase-divider). divide opens a group before the next row where a divider is due;
   * body is the group rows go in. */
  const phaseRows = (list: HTMLElement) => {
    const groups: HTMLTableSectionElement[] = [];
    const open = () => { const group = h(doc, "tbody"); groups.push(group); return group; };
    return {
      body: () => groups.at(-1) ?? open(),
      divide(divider: string | null) {
        if (divider === null) return;
        const row = h(doc, "tr", "d1p-phase-divider"), head = h(doc, "th", undefined, divider);
        head.scope = "rowgroup"; head.colSpan = MATCH_COLUMNS.length;
        row.append(head);
        open().append(row);
        list.append(h(doc, "li", "d1p-phase-divider", divider));
      },
      bodies: () => groups.length > 0 ? groups : [open()],
    };
  };
  return { card, skeleton, headCell, srHead, columns, matchGrid, startCell, rowPill, seatBlock, colonyList, phaseRows };
}

// ---------------------------------------------------------------- Recordings

/** A recorded colony nobody joined: its record holds no seat of it. */
const NOT_JOINED = "did not join";

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

/** The Recordings list as the Matches page draws it: a record card saying its own state once, its table and stacked rows. */
export function recordingsCard(doc: Document, view: MatchesView, options: RecordingsCardOptions): HTMLElement {
  const { search } = options;
  const { card, skeleton, headCell, srHead, columns, startCell, rowPill, seatBlock, colonyList, phaseRows } = rowParts(doc);
  /** A colony's result badge, in the shared badge style (identity.ts d1p-tag) with its words in the colony's ink: Winner on
   * the winning colony where the record names a winner and the match was not abandoned, never on a colony nobody joined
   * (no recorded seat); Draw on both colonies in a draw; none otherwise. */
  const markOf = (r: Recording, colony: 0 | 1, seats: NonNullable<ReturnType<typeof colonySeats>>): string | null => {
    const winner = winnerOf(r);
    if (winner !== null) return winner === colony && seats[colony] !== null ? "Winner" : null;
    return r.reason !== "abandoned" && r.decidedBy === "draw" ? "Draw" : null;
  };
  /** The record's own word (ui/format.ts recordingResult) where no colony carries a badge and the record names no winner:
   * Abandoned or Result unknown, and Draw on a row with no recorded seat. A winner's word names its colony, never shown. */
  const outcome = (r: Recording, text: string, marked: boolean) =>
    !marked && winnerOf(r) === null ? [h(doc, "span", "d1p-result", text)] : [];
  /** The match-type badge (ui/format.ts recordingType): in the table's Game type column, in the stacked row's line after
   * the time; none where the type is unknown. */
  const typeBadge = (type: string | null) => type === null ? [] : [h(doc, "span", "d1p-tag d1p-type", type)];
  const stamp = (status: Recording["status"]) => {
    const node = h(doc, "span", `d1p-stamp is-${status}`);
    node.append(h(doc, "span", "d1p-sr", "Record "), stampWord(status));
    return node;
  };
  /** Each colony's recorded models, the seats that recorded one model label with the same badges once with how many they are
   * (seatGroups), in both forms; null for a colony with no recorded seat. No rating: a recording carries none. */
  const recordedSeats = (seats: NonNullable<ReturnType<typeof colonySeats>>) =>
    COLONIES.map(colony => seats[colony] && seatGroups(seats[colony]).map(group => seatBlock(group)));
  /** Each colony's lines, a colony with no recorded seat "did not join" (nobody joined it), its result badge after each of its
   * lines' own words, so every model the colony fielded carries it, every name keeps its place and no other text stands in for
   * a model. */
  const markedSeats = (r: Recording, seats: NonNullable<ReturnType<typeof colonySeats>>) =>
    recordedSeats(seats).map((models, colony) => {
      const mark = markOf(r, colony as 0 | 1, seats);
      if (mark === null) return models ?? [h(doc, "span", "d1p-model d1p-unknown", NOT_JOINED)];
      // The line's words stay its first child (archive.css .d1p-model > :first-child), the badge after them.
      const lines = models ?? [h(doc, "span", "d1p-model d1p-unknown")];
      if (models === null) lines[0]!.append(h(doc, "span", undefined, NOT_JOINED));
      for (const line of lines) line.append(h(doc, "span", `d1p-tag d1p-c${colony}`, mark));
      return lines;
    });
  const all = recordingRows(view, search);
  // A limited card shows the newest rows; where more remain it says so in the list's own words, never Load more.
  const rows = options.limit === undefined ? all : all.slice(0, options.limit);
  const byId = new Map(view.recordings.rows.map(r => [r.id, r]));
  const state = recordingsLine(rows.length < all.length ? { ...view, next: view.next ?? "" } : view, rows.length);
  const loading = view.recordings.status === "loading" && rows.length === 0;
  // A divider before the first row of each harness phase (ui/format.ts phaseDividers). A row its badge marks as another
  // kind of match carries no phase and stands under the divider above it; an Index row whose phase the page cannot read,
  // or a recording whose kind is not known (no badge), ends that divider instead of taking its phase.
  const dividers = phaseDividers(rows.map(row => {
    if (row.phase.length > 0) return row.phase;
    const kind = byId.get(row.id)!.matchType?.kind;
    return kind === "index" || kind == null ? "unknown" : null;
  }));
  // No note under the state (no editorial copy): the record stamp says each record's fidelity.
  const lines: Node[] = [stateLine(doc, state.glyph, state.text)];
  const body: Node[] = [];
  if (rows.length > 0 || loading) {
    const table = h(doc, "table", "d1p-table d1p-rec d1p-wide");
    table.setAttribute("aria-labelledby", "d1p-rec-title");
    columns(table, MATCH_COLUMNS);
    // One head row on Live now's grid: Time over the start column, Game type over the outcome column (under Live now's
    // Winner), each colony's models under its name, Record, and Replay's head for screen readers. No Winner column: the
    // winner's badge stands in its own colony's column.
    const head = h(doc, "thead"), labels = h(doc, "tr");
    labels.append(headCell(RECORDING_HEADS[0], "c-start"), headCell(RECORDING_HEADS[1], "c-result"));
    for (const colony of COLONIES) labels.append(headCell(COLONY_NAMES[colony], `c-model d1p-c${colony}`));
    labels.append(headCell(RECORDING_HEADS[2], "c-record"), srHead(PAGE_WORDS.replay, "c-go"));
    head.append(labels);
    const list = h(doc, "ul", "d1p-rows d1p-match-rows d1p-narrow");
    list.setAttribute("aria-labelledby", "d1p-rec-title");
    const groups = phaseRows(list);
    // The stacked list has no skeleton rows: while the first page loads, the card's state line alone says so.
    if (loading) {
      table.setAttribute("aria-hidden", "true"); list.hidden = true;
      for (let line = 0; line < 2; line++) groups.body().append(skeleton(6, ["84px", "", "128px", "128px", "70px"]));
    }
    for (const [at, row] of rows.entries()) {
      const r = byId.get(row.id)!;
      groups.divide(dividers[at]!);
      const seats = colonySeats(r.seats);
      // A row with no recorded seat has no colony line to carry a badge.
      const marked = seats !== null && (markOf(r, 0, seats) !== null || markOf(r, 1, seats) !== null);
      const name = `Replay, recording started ${row.when}`;
      const line = h(doc, "tr");
      const start = startCell(row.when);
      start.append(...outcome(r, row.result, marked));
      const type = h(doc, "td", "c-result");
      type.append(...typeBadge(row.type));
      line.append(start, type);
      if (seats === null) {
        const none = h(doc, "td", "c-model");
        none.colSpan = 2;
        none.append(h(doc, "span", "d1p-model d1p-unknown", "Seats not recorded"));
        line.append(none);
      } else {
        for (const models of markedSeats(r, seats)) {
          const cell = h(doc, "td", "c-model");
          cell.append(...models);
          line.append(cell);
        }
      }
      const record = h(doc, "td", "c-record");
      record.append(stamp(r.status));
      const go = h(doc, "td", "c-go");
      go.append(rowPill(PAGE_WORDS.replay, row.href, name, `rec|wide|${row.id}`));
      line.append(record, go);
      groups.body().append(line);

      // The stacked row: its time, then the record's own word where no colony carries a badge and its type, beside Replay;
      // then each colony's models, the winner's badge on its colony's line as in the table, then the record.
      const item = h(doc, "li");
      const lead = h(doc, "p", "d1p-line is-lead");
      lead.append(...outcome(r, row.result, marked), ...typeBadge(row.type));
      item.append(h(doc, "p", "d1p-line", row.when), lead);
      if (seats === null) item.append(h(doc, "p", "d1p-line is-model d1p-unknown", "Seats not recorded"));
      else item.append(colonyList(markedSeats(r, seats)));
      const stampLine = h(doc, "p", "d1p-line");
      stampLine.append(stamp(r.status));
      item.append(stampLine, rowPill(PAGE_WORDS.replay, row.href, name, `rec|narrow|${row.id}`));
      list.append(item);
    }
    table.append(head, ...groups.bodies());
    body.push(table, list);
  }
  let act: HTMLElement[] = [];
  if (options.foot) act = [options.foot];
  else if (view.next !== null && options.more) {
    const button = pill(doc, PAGE_WORDS.more);
    button.dataset.key = "more"; button.disabled = view.recordings.status === "loading";
    button.addEventListener("click", options.more);
    act = [button];
  }
  return card("d1p-rec-title", PAGE_WORDS.recordings, lines, body, act);
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
