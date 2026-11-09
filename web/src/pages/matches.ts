// The Archive (ported): Matches, following `main`. Three record cards, each saying its own state once: Waiting, Live now,
// and Recordings. The band's Refresh is the page's only one: a failed card says so in its state line and carries no second
// Refresh. Real column tables, the three lists on one column grid with one head row each; in a card under 52rem each row
// stacks into labelled lines (archive.css). Rows and links come from today's helpers (ui/format.ts), read-only.
// Layout: rows are model-first. Recordings follows the result, not the side: Match, Winner, Defeated, Ended by, Replay;
// the winning model always in the Winner column, bold, each model after its colony's dot (a legend in the card's head, the
// colony's name read to screen readers). A draw, an abandoned match or an unknown result has no winner: its two sides share
// one cell after the record's own word, so neither is shown as winner or defeated. Live now has no winner yet: its sides
// stand under their colonies' names. Each seat's level and Fast are quiet words under its name, a colony's alike seats once
// with how many they are. No rating anywhere, and no self-reported asterisk.
import type { LiveMatch, LiveSeat, MatchesView, Recording } from "../matches-page/data.ts";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { SEAT, rowName } from "../compose.ts";
import { liveRow, recordingRows, utcStamp } from "../ui/format.ts";
import { PAGE_WORDS, pill } from "../ui/pages.ts";
import { h } from "../ui/dom.ts";
import type { Mounted } from "../ui/types.ts";
import { mountFrame, rebuild, stateLine } from "./chrome.ts";
import { waitingCard } from "./waiting.ts";
import {
  RECORDINGS_LIST, colonySeats, endedBy, liveKind, liveLine, loadedText, loadsSettled, matchesLists, outcomeOf, recordingsLine, seatGroups,
  sideOrder, stampWord, startLine, whenParts, type LoadsSeen, type NameParts, type SeatEntry, type SeatGroup,
} from "./model.ts";

/** The HUD's tooltip words, held as a placeholder (‡): these
 * pages follow whatever wording the HUD lands, and never say "house matches". */
const SELF_REPORTED = "Self-reported: outside the Antwars Model Index, each agent names its own model.";
const LIVE_HEADS = ["Started", "Status"] as const;
/** Live now's one status. */
const IN_PROGRESS = "In progress";
/** Recordings' heads, and the stacked rows' labels for each side. */
export const RECORDING_HEADS = ["Match", "Winner", "Defeated", "Ended by"] as const;
export const SIDE_WORDS = { won: "Won", lost: "Lost" } as const;
/** Ended by where the record does not say. */
const NOT_RECORDED = "not recorded";
const COLONIES = [0, 1] as const;
/** One column grid for every Matches list (archive.css): the start; two sides; how it ended (Live now's status, Waiting's
 * match); the action. */
export const MATCH_COLUMNS = ["c-start", "c-side", "c-side", "c-how", "c-go"] as const;

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
  const { card, skeleton, headCell, srHead, columns, startCell, rowPill, seatBlock, sideCell, sides } = parts;

  // ---------------------------------------------------------------- Live now
  const started = (match: LiveMatch) => utcStamp(match.startedAt) ?? "Start unknown";
  /** A live colony's players in the one row style every Matches list shares: the name, its level and Fast as quiet words
   * through the HUD's rowName, no rating and no provisional. An identity holding several seats is "<name> #<seat>" on each
   * (compose.ts SEAT): where a colony holds several of them it is listed there once, with how many seats it holds, as alike
   * recorded seats are; a seat it holds alone in its colony keeps its "#<seat>". */
  const players = (seats: readonly LiveSeat[], colony: 0 | 1): HTMLElement[] => seatGroups(seats.map((seat): SeatEntry => {
    const who = SEAT.exec(seat.displayName)?.[1] ?? seat.displayName;
    const shown = (name: string): NameParts => { const named = rowName(name, undefined); return { name: named.name, badges: named.badges, quiet: null }; };
    return { who, parts: shown(seat.displayName), alike: shown(who) };
  })).map(group => seatBlock(group, colony));
  const liveCard = (view: MatchesView): HTMLElement => {
    const state = liveLine(view);
    const rows = view.live.rows, loading = view.live.status === "loading" && rows.length === 0;
    const body: Node[] = [];
    if (rows.length > 0 || loading) {
      const table = h(doc, "table", "d1p-table d1p-live d1p-wide");
      table.setAttribute("aria-labelledby", "d1p-live-title");
      // Recordings' grid: Started, each colony's players under its name, the status where Recordings says how a match
      // ended, and Watch where Replay sits, headed for screen readers. Nobody has won yet, so no side is a winner.
      columns(table, MATCH_COLUMNS);
      const head = h(doc, "thead"), labels = h(doc, "tr");
      labels.append(headCell(LIVE_HEADS[0], "c-start"));
      for (const colony of COLONIES) labels.append(colonyHead(doc, colony));
      labels.append(headCell(LIVE_HEADS[1], "c-how"), srHead("Watch", "c-go"));
      head.append(labels);
      const tbody = h(doc, "tbody");
      const list = h(doc, "ul", "d1p-rows d1p-match-rows d1p-narrow");
      list.setAttribute("aria-labelledby", "d1p-live-title");
      if (loading) {
        table.setAttribute("aria-hidden", "true"); list.hidden = true;
        for (let line = 0; line < 2; line++) tbody.append(skeleton(5, ["84px", "128px", "128px", "84px"]));
      }
      for (const match of rows) {
        const row = liveRow(match, search), when = started(match);
        const name = `Watch, ${liveKind(match)} started ${when}`;
        const seated = match.colonies[0].length + match.colonies[1].length > 0;
        const line = h(doc, "tr");
        line.append(startCell(when));
        if (!seated) {
          const none = h(doc, "td", "c-side");
          none.colSpan = 2;
          none.append(h(doc, "span", "d1p-unknown", "Seats not recorded"));
          line.append(none);
        } else {
          for (const colony of COLONIES) line.append(sideCell(colony, players(match.colonies[colony], colony)));
        }
        const status = h(doc, "td", "c-how");
        status.append(h(doc, "span", "d1p-status", IN_PROGRESS));
        // Watch where Replay sits, by the same rowPill.
        const go = h(doc, "td", "c-go");
        go.append(rowPill("Watch", row.href, name, `live|wide|${row.id}`));
        line.append(status, go);
        tbody.append(line);

        // The stacked row: the start, then the status, beside Watch; then each side's players after their colony's dot.
        const item = h(doc, "li");
        item.append(h(doc, "p", "d1p-line", `Started ${when}`), h(doc, "p", "d1p-line is-lead", IN_PROGRESS));
        if (!seated) item.append(h(doc, "p", "d1p-line d1p-unknown", "Seats not recorded"));
        else item.append(sides(COLONIES.map(colony => [colony, players(match.colonies[colony], colony)] as const)));
        item.append(rowPill("Watch", row.href, name, `live|narrow|${row.id}`));
        list.append(item);
      }
      table.append(head, tbody);
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

/** A colony's dot, in its ink; decorative, since its colony is always named beside it or read to screen readers. */
function dot(doc: Document, colony: 0 | 1): HTMLElement {
  const node = h(doc, "span", `d1p-dot d1p-c${colony}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}
/** A colony's column head, Live now's and Waiting's: its dot, then its name in its ink. */
function colonyHead(doc: Document, colony: 0 | 1, cls = "c-side"): HTMLTableCellElement {
  const cell = h(doc, "th", `${cls} d1p-c${colony}`);
  cell.scope = "col";
  cell.append(dot(doc, colony), COLONY_NAMES[colony]);
  return cell;
}

// ---------------------------------------------------------------- one row's parts, shared by every list
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
  const card = (id: string, heading: string, lines: Node[], body: Node[], actionsRow: HTMLElement[], aside: Node[] = []) => {
    const section = h(doc, "section", "d1p-card");
    section.setAttribute("aria-labelledby", id);
    const head = h(doc, "div", "d1p-card-head");
    const titleNode = h(doc, "h2", "d1p-card-title", heading);
    titleNode.id = id;
    head.append(titleNode, ...aside, ...lines);
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
  /** A row's start as its date over its time, then any further lines (a recording's match type), the row's header. */
  const startCell = (when: string, ...more: Node[]) => {
    const parts = whenParts(when);
    const cell = h(doc, "th", "c-start");
    cell.scope = "row";
    cell.append(h(doc, "span", "d1p-date", parts.date));
    if (parts.time) cell.append(h(doc, "span", "d1p-time", parts.time));
    cell.append(...more);
    return cell;
  };
  /** A seat as every list shows it: its colony's dot (none for a queued agent, which has no colony yet), the model's name
   * and, for alike seats, how many they are, on one line; its level and Fast as quiet words under it. A name too long for
   * its column ends in an ellipsis there, so its whole text is its title on hover; a screen reader reads the text itself,
   * which is never cut. */
  const seatBlock = ({ parts, seats }: SeatGroup, colony: 0 | 1 | null) => {
    const node = h(doc, "span", "d1p-seat");
    const line = h(doc, "span", "d1p-model");
    if (colony !== null) line.append(dot(doc, colony));
    const name = h(doc, "span", "d1p-name", parts.name);
    name.title = parts.name;
    line.append(name);
    if (seats > 1) {
      const count = h(doc, "span", "d1p-count");
      const shown = h(doc, "span", undefined, `×${seats}`);
      shown.setAttribute("aria-hidden", "true");
      count.append(shown, h(doc, "span", "d1p-sr", `, ${seats} seats`));
      line.append(count);
    }
    node.append(line);
    if (parts.badges.length > 0) {
      const meta = h(doc, "span", "d1p-meta", parts.badges.join(" · "));
      meta.title = parts.badges.join(" · ");
      node.append(h(doc, "span", "d1p-sr", ", "), meta);
    }
    return node;
  };
  /** A side's seats with its colony's name read to screen readers first; "not recorded" where none was. */
  const sideNodes = (colony: 0 | 1, seats: readonly HTMLElement[] | null): Node[] => [
    h(doc, "span", "d1p-sr", `${COLONY_NAMES[colony]}: `),
    ...(seats && seats.length > 0 ? seats : [unknownSide(colony)]),
  ];
  /** A side whose models were not recorded: its colony's dot and name, so the result still reads. */
  const unknownSide = (colony: 0 | 1) => {
    const node = h(doc, "span", "d1p-seat");
    const line = h(doc, "span", "d1p-model");
    line.append(dot(doc, colony), h(doc, "span", "d1p-name", COLONY_NAMES[colony]));
    node.append(line, h(doc, "span", "d1p-sr", ", "), h(doc, "span", "d1p-meta", "models not recorded"));
    return node;
  };
  const sideCell = (colony: 0 | 1, seats: readonly HTMLElement[] | null, cls = "c-side") => {
    const cell = h(doc, "td", cls);
    cell.append(...sideNodes(colony, seats));
    return cell;
  };
  /** The stacked rows' sides: each side's seats one per line, the sides apart; a side with none "not recorded", or left out
   * where none is null (Waiting's open seats). */
  const sides = (entries: readonly (readonly [0 | 1, readonly HTMLElement[] | null])[], none: boolean = true) => {
    const block = h(doc, "div", "d1p-sides");
    for (const [colony, seats] of entries) {
      if (!none && (seats === null || seats.length === 0)) continue;
      const side = h(doc, "div", "d1p-side");
      side.append(...sideNodes(colony, seats));
      block.append(side);
    }
    return block;
  };
  /** The one five-column grid every Matches list stands on. */
  const matchGrid = (table: HTMLTableElement) => columns(table, MATCH_COLUMNS);
  return { card, skeleton, headCell, srHead, columns, matchGrid, startCell, rowPill, seatBlock, sideCell, sideNodes, sides, colonyHead: (colony: 0 | 1, cls?: string) => colonyHead(doc, colony, cls) };
}

// ---------------------------------------------------------------- Recordings

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
  const { card, skeleton, headCell, srHead, columns, startCell, rowPill, seatBlock, sideCell, sideNodes } = rowParts(doc);
  /** The record stamp, only where a record is partial or unavailable: a complete record needs no word. */
  const stamp = (status: Recording["status"]) => {
    if (status === "complete") return [];
    const node = h(doc, "span", `d1p-stamp is-${status}`);
    node.append(h(doc, "span", "d1p-sr", "Record "), stampWord(status));
    return [node];
  };
  /** Each colony's recorded models, the seats that recorded one model label with the same badges once with how many they
   * are (seatGroups); null for a colony with no recorded seat. No rating: a recording carries none. */
  const recordedSeats = (seats: ReturnType<typeof colonySeats>, colony: 0 | 1): HTMLElement[] | null =>
    seats?.[colony] ? seatGroups(seats[colony]).map(group => seatBlock(group, colony)) : null;
  /** The word that stands in place of a winner: Draw, Abandoned or Result unknown, as text, outlined. */
  const mark = (word: string) => h(doc, "span", "d1p-mark", word);
  /** A row with no winner: its two sides in one cell after the record's own word, colony order, neither bold. */
  const evenNodes = (word: string, seats: ReturnType<typeof colonySeats>): Node[] => {
    const pair = h(doc, "span", "d1p-even");
    COLONIES.forEach(colony => {
      if (colony === 1) pair.append(h(doc, "span", "d1p-vs", "vs"));
      const side = h(doc, "span", "d1p-side");
      side.append(...sideNodes(colony, recordedSeats(seats, colony)));
      pair.append(side);
    });
    return [mark(word), pair];
  };
  const legend = () => {
    const node = h(doc, "p", "d1p-legend");
    for (const colony of COLONIES) {
      const item = h(doc, "span", `d1p-legend-item d1p-c${colony}`);
      item.append(dot(doc, colony), COLONY_NAMES[colony]);
      node.append(item);
    }
    return node;
  };
  const all = recordingRows(view, search);
  // A limited card shows the newest rows; where more remain it says so in the list's own words, never Load more.
  const rows = options.limit === undefined ? all : all.slice(0, options.limit);
  const byId = new Map(view.recordings.rows.map(r => [r.id, r]));
  const state = recordingsLine(rows.length < all.length ? { ...view, next: view.next ?? "" } : view, rows.length);
  const loading = view.recordings.status === "loading" && rows.length === 0;
  const lines: Node[] = [stateLine(doc, state.glyph, state.text)];
  const body: Node[] = [];
  if (rows.length > 0 || loading) {
    const table = h(doc, "table", "d1p-table d1p-rec d1p-wide");
    table.setAttribute("aria-labelledby", "d1p-rec-title");
    columns(table, MATCH_COLUMNS);
    // One head row: Match, Winner, Defeated, Ended by, and Replay's head for screen readers.
    const head = h(doc, "thead"), labels = h(doc, "tr");
    labels.append(headCell(RECORDING_HEADS[0], "c-start"), headCell(RECORDING_HEADS[1], "c-side"), headCell(RECORDING_HEADS[2], "c-side"),
      headCell(RECORDING_HEADS[3], "c-how"), srHead(PAGE_WORDS.replay, "c-go"));
    head.append(labels);
    const tbody = h(doc, "tbody");
    const list = h(doc, "ul", "d1p-rows d1p-match-rows d1p-narrow");
    list.setAttribute("aria-labelledby", "d1p-rec-title");
    // The stacked list has no skeleton rows: while the first page loads, the card's state line alone says so.
    if (loading) {
      table.setAttribute("aria-hidden", "true"); list.hidden = true;
      for (let line = 0; line < 2; line++) tbody.append(skeleton(5, ["84px", "128px", "128px", "96px"]));
    }
    for (const row of rows) {
      const r = byId.get(row.id)!;
      const seats = colonySeats(r.seats);
      const outcome = outcomeOf(r);
      const how = endedBy(r);
      const name = `Replay, recording started ${row.when}`;
      const line = h(doc, "tr");
      line.append(startCell(row.when, ...(row.type === null ? [] : [h(doc, "span", "d1p-time d1p-type", row.type)]), ...stamp(r.status)));
      if (outcome.kind === "won") {
        const [winner, loser] = sideOrder(outcome);
        const won = sideCell(winner, recordedSeats(seats, winner));
        won.classList.add("is-win");
        line.append(won, sideCell(loser, recordedSeats(seats, loser)));
      } else {
        const even = h(doc, "td", "c-side is-even");
        even.colSpan = 2;
        even.append(...evenNodes(outcome.word, seats));
        line.append(even);
      }
      const ended = h(doc, "td", "c-how");
      ended.append(how === null ? h(doc, "span", "d1p-unknown", NOT_RECORDED) : how);
      const go = h(doc, "td", "c-go");
      go.append(rowPill(PAGE_WORDS.replay, row.href, name, `rec|wide|${row.id}`));
      line.append(ended, go);
      tbody.append(line);

      // The stacked row: its time and match type beside Replay; the winner's models after Won, the beaten side's after
      // Lost, or both sides after the record's word where none won; then how it ended, and a stamp where one is due.
      const item = h(doc, "li");
      item.append(h(doc, "p", "d1p-line", startLine(row.when, row.type)));
      const result = h(doc, "dl", "d1p-outcome");
      if (outcome.kind === "won") {
        for (const [word, colony] of [[SIDE_WORDS.won, outcome.winner], [SIDE_WORDS.lost, outcome.loser]] as const) {
          const block = h(doc, "dd", colony === outcome.winner ? "is-win" : undefined);
          block.append(...sideNodes(colony, recordedSeats(seats, colony)));
          result.append(h(doc, "dt", undefined, word), block);
        }
      } else {
        const block = h(doc, "dd");
        for (const colony of COLONIES) block.append(...sideNodes(colony, recordedSeats(seats, colony)));
        result.append(h(doc, "dt", undefined, outcome.word), block);
      }
      item.append(result);
      if (how !== null) item.append(h(doc, "p", "d1p-line is-meta", how));
      const stamped = stamp(r.status);
      if (stamped.length > 0) { const stampLine = h(doc, "p", "d1p-line"); stampLine.append(...stamped); item.append(stampLine); }
      item.append(rowPill(PAGE_WORDS.replay, row.href, name, `rec|narrow|${row.id}`));
      list.append(item);
    }
    table.append(head, tbody);
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
  return card("d1p-rec-title", PAGE_WORDS.recordings, lines, body, act, rows.length > 0 ? [legend()] : []);
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
