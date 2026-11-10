// The Archive: the Leaderboard. The band at the container's top is two lines: the title, with the freshness line and the page's one
// Refresh (no eligibility line) at the line's end; then the board choice, the Antwars Model Index first, with the challenge bubble after
// the Challenge group it opens. Each table is a record card that says its own state once.
// Rows are the page's data owner's (leaderboard-page/page.ts), read-only; every change goes through its actions.
import type { LeaderboardMode, LeaderboardRow } from "../leaderboard.ts";
import { C } from "../leaderboard-page/copy.ts";
import type { RankingView } from "../leaderboard-page/view.ts";
import { keep } from "../ui/format.ts";
import { PAGE_WORDS, pill } from "../ui/pages.ts";
import { h } from "../ui/dom.ts";
import type { Mounted } from "../ui/types.ts";
import { mountFrame, rebuild, stateLine } from "./chrome.ts";
import { nameNodes, ratingNodes } from "./identity.ts";
import {
  BOARD_GROUPS, CHALLENGE, CHALLENGE_HREF, CHALLENGE_SIZE, OPENING_MODE, challengeBadges, challengeState, formMarks, leaderboardLists, loadedText,
  loadsSettled, nameParts, ranks, recordOf, sizeOf, tableCount, tableState, tableTitle, type BoardChoice, type ChallengeView, type ListLoad,
  type LoadsSeen,
} from "./model.ts";

/** The capability, the board shown and each of its tables, as the page's data owner publishes them. */
export interface LeaderboardView {
  readonly mode: BoardChoice;
  readonly enabled: boolean;
  readonly tables: readonly RankingView[];
  /** Present only while Challenge is shown. */
  readonly challenge?: ChallengeView;
}
export interface LeaderboardActions {
  chooseMode(mode: BoardChoice): void;
  refresh(): void;
  more(tableId: string): void;
}

export function mountLeaderboard(doc: Document, host: HTMLElement, actions: LeaderboardActions): Mounted<LeaderboardView> {
  const search = doc.defaultView!.location.search;
  const frame = mountFrame(doc, host, "leaderboard");

  // ---------------------------------------------------------------- the band: the title's line, then the board choice
  const summary = h(doc, "div", "d1p-summary");
  const title = h(doc, "h1", "d1p-title", C.title);
  title.tabIndex = -1;
  // No eligibility line (the old page help goes as editorial copy). At the title line's end, the time the lists were last
  // read, then the page's one Refresh, which reads the board shown again: one group, and the time's arrival moves nothing,
  // since Refresh holds the line's end.
  const fresh = h(doc, "div", "d1p-fresh");
  const loaded = h(doc, "p", "d1p-loaded");
  const refresh = pill(doc, PAGE_WORDS.refresh);
  // The page's one Refresh in main's cyan.
  refresh.classList.add("d1p-refresh");
  refresh.dataset.key = "refresh";
  refresh.addEventListener("click", () => { continuing = new Set(); actions.refresh(); });
  fresh.append(loaded, refresh);
  summary.append(title, fresh);
  // The board choice, then the challenge bubble after the Challenge group it opens: the site's cyan button
  // (deck.css .d1-agent-button), linking to the Challenge choice as the Waiting card does.
  const strip = h(doc, "div", "d1p-lb-strip");
  const boards = h(doc, "div", "d1p-boards");
  boards.setAttribute("role", "group");
  boards.setAttribute("aria-label", C.modes);
  let mode: BoardChoice = OPENING_MODE;
  const tabs: { readonly mode: BoardChoice; readonly button: HTMLButtonElement }[] = [];
  // The two ranking groups, then Challenge, its one choice drawn as the groups' are.
  const groups: readonly { readonly label: string; readonly choices: readonly { readonly mode: BoardChoice; readonly size: string }[] }[] = [
    ...BOARD_GROUPS.map(group => ({ label: group.label, choices: group.modes.map(choice => ({ mode: choice, size: sizeOf(choice) })) })),
    { label: C.challengeTitle, choices: [{ mode: CHALLENGE, size: CHALLENGE_SIZE }] },
  ];
  groups.forEach((group, index) => {
    const block = h(doc, "div", "d1p-board-group");
    const label = h(doc, "p", "d1p-kicker", group.label);
    label.id = `d1p-boards-${index}`;
    block.setAttribute("role", "group");
    block.setAttribute("aria-labelledby", label.id);
    const row = h(doc, "div", "d1p-tabs");
    for (const { mode: choice, size } of group.choices) {
      const button = h(doc, "button", "d1p-tab");
      button.type = "button";
      button.append(h(doc, "span", undefined, size));
      // The size repeats in every row, so the name carries its group.
      button.setAttribute("aria-label", `${group.label} ${size}`);
      button.addEventListener("click", () => { if (choice !== mode) { continuing = new Set(); actions.chooseMode(choice); } });
      row.append(button);
      tabs.push({ mode: choice, button });
    }
    block.append(label, row);
    boards.append(block);
  });
  const bubble = h(doc, "a", "d1-agent-button", C.challengeNew);
  bubble.href = keep(CHALLENGE_HREF, search);
  bubble.dataset.key = "challenge-new";
  strip.append(boards, bubble);
  frame.band.append(summary, strip);
  // The page's own heading takes focus once, unless the visitor is already somewhere else.
  queueMicrotask(() => { if (title.isConnected && (doc.activeElement === null || doc.activeElement === doc.body)) title.focus({ preventScroll: true }); });

  const notEnabled = (): HTMLElement => {
    const section = h(doc, "section", "d1p-card d1p-notice");
    section.setAttribute("aria-label", C.title);
    const head = h(doc, "div", "d1p-card-head");
    head.append(stateLine(doc, "ring", C.serviceUnavailable));
    section.append(head);
    return section;
  };

  // ---------------------------------------------------------------- update
  let drawn = "", seen: LoadsSeen = new Map(), loadedAt: number | null = null;
  // Tables whose load is this page's Load more. A Refresh or a board choice starts every table again from its first page,
  // under the same ids, so it clears them first: a Refresh pressed while a Load more is loading moves the time once its
  // first page lands.
  let continuing: ReadonlySet<string> = new Set();
  return {
    update(view: LeaderboardView) {
      mode = view.mode;
      const lists: ListLoad[] = [...leaderboardLists(view.tables), ...(view.challenge ? [{ id: CHALLENGE, status: view.challenge.status }] : [])];
      const settled = loadsSettled(seen, lists, continuing);
      seen = settled.seen; continuing = settled.continuing;
      if (settled.moved) loadedAt = Date.now();
      const text = loadedAt === null ? "" : loadedText(loadedAt);
      if (loaded.textContent !== text) loaded.textContent = text;
      // Not enabled: the band keeps its title; Refresh, freshness, the choice and the challenge bubble go.
      fresh.hidden = !view.enabled;
      strip.hidden = !view.enabled;
      for (const tab of tabs) tab.button.setAttribute("aria-pressed", String(tab.mode === view.mode));
      const next = JSON.stringify([view.enabled, view.mode, view.tables, view.challenge]);
      if (next === drawn) return;
      drawn = next;
      const shown = view.mode;
      rebuild(doc, frame.content, () => !view.enabled ? [notEnabled()]
        : shown === CHALLENGE ? (view.challenge ? [challengeCard(doc, view.challenge)] : [])
        : view.tables.map(table => rankingCard(doc, table, shown, {
          search, more: () => { continuing = new Set([...continuing, table.id]); actions.more(table.id); },
        })));
    },
    destroy() { frame.destroy(); },
  };
}

// ---------------------------------------------------------------- record cards

/** How a ranking card is drawn: with the page's Load more (more), or, where a page shows only a ranking's first rows
 * (limit), with that page's own link in the card's foot in place of Load more (foot). */
export interface RankingCardOptions {
  readonly search: string;
  readonly more?: () => void;
  readonly limit?: number;
  readonly foot?: HTMLElement;
}

/** One ranking as the Leaderboard draws it: a record card saying its own state once, its table and its stacked rows. */
export function rankingCard(doc: Document, table: RankingView, shown: LeaderboardMode, options: RankingCardOptions): HTMLElement {
  // A limited card shows the first rows and says how many it shows, never Load more.
  if (options.limit !== undefined) table = { ...table, rows: table.rows.slice(0, options.limit), next: undefined };
  const section = h(doc, "section", "d1p-card");
  const titleId = `d1p-${table.id}`;
  section.setAttribute("aria-labelledby", titleId);
  section.setAttribute("aria-busy", String(table.status === "loading"));
  const head = h(doc, "div", "d1p-card-head");
  const heading = h(doc, "h2", "d1p-card-title", tableTitle(table, shown));
  heading.id = titleId;
  // The count stands beside the title; the state line says only loading, failed or empty, never editorial copy.
  const count = tableCount(table);
  if (count !== null) heading.append(" ", h(doc, "span", "d1p-count", count));
  head.append(heading);
  const state = tableState(table);
  if (state !== null) head.append(stateLine(doc, state.glyph, state.text));
  section.append(head);
  if (table.rows.length > 0 || table.status === "loading") section.append(...rankingTable(doc, table, titleId, options.search));
  // A failed table says so in its state line; its retry is the band's Refresh, which mounts the tables again
  // (leaderboard-page/view.ts). No second Refresh in the card: each state is shown once.
  if (options.foot) section.append(foot(doc, options.foot));
  else if (table.status !== "error" && table.next !== undefined && options.more) {
    // Load more in the site's cyan button (deck.css .d1-agent-button).
    const button = h(doc, "button", "d1-agent-button", C.more);
    button.type = "button";
    button.dataset.key = `more-${table.id}`;
    button.addEventListener("click", options.more);
    button.disabled = table.status === "loading";
    section.append(foot(doc, button));
  }
  return section;
}
/** The Challenge list as a record card saying its own state once: one row per house handle in the shared row
 * style, in the Antwars Model Index 1v1 order: its name with
 * the shared level, Fast and "unavailable" badges, its Model Index 1v1 rating in the shared rating badge where it has one,
 * and, only where it can be challenged now, what to ask an agent. */
function challengeCard(doc: Document, list: ChallengeView): HTMLElement {
  const section = h(doc, "section", "d1p-card d1p-challenge");
  const titleId = "d1p-challenge-title";
  section.setAttribute("aria-labelledby", titleId);
  section.setAttribute("aria-busy", String(list.status === "loading"));
  const head = h(doc, "div", "d1p-card-head");
  const heading = h(doc, "h2", "d1p-card-title", `${C.challengeTitle} · ${CHALLENGE_SIZE}`);
  heading.id = titleId;
  const state = challengeState(list);
  head.append(heading, stateLine(doc, state.glyph, state.text));
  section.append(head);
  if (list.rows.length > 0) {
    const rows = h(doc, "ul", "d1p-rows");
    rows.setAttribute("aria-labelledby", titleId);
    for (const { opponent: entry, rating } of list.rows) {
      const item = h(doc, "li");
      const lead = h(doc, "p", "d1p-line is-lead");
      lead.append(...nameNodes(doc, { name: entry.displayName, badges: challengeBadges(entry) }));
      item.append(lead);
      // The rating beside the name, in the row's second column, as a stacked ranking row has it; that column is one column
      // down the whole list (archive.css), so every badge stands under the one above it.
      if (rating !== null) {
        const elo = h(doc, "p", "c-elo");
        elo.append(h(doc, "span", "d1p-sr", `${C.eloColumn} `), ...ratingNodes(doc, rating));
        item.append(elo);
      }
      if (entry.available) {
        const ask = h(doc, "p", "d1p-line d1p-ask");
        // The handle is the command the agent types, never the row's name:
        // only here, in the agent URL's command style (aw-byoa-url); the row's name is its display name, above.
        ask.append(C.challengeAsk[0], h(doc, "code", "aw-byoa-url", entry.handle), C.challengeAsk[1]);
        item.append(ask);
      }
      rows.append(item);
    }
    section.append(rows);
  }
  return section;
}
function foot(doc: Document, ...nodes: HTMLElement[]): HTMLElement {
  const block = h(doc, "div", "d1p-card-foot");
  block.append(...nodes);
  return block;
}
// ---------------------------------------------------------------- one row's parts, shared by the table and the stacked rows
/** The name: an antwars-owned model's display name and badges, any other its handle only, with no thinking level,
 * in the one row style every page shares (identity.ts). */
const nameOf = (doc: Document, entry: LeaderboardRow): Node[] => nameNodes(doc, { ...nameParts(entry), quiet: null });
/** The rating, ± its RD and the provisional word, in the shared rating look (identity.ts). */
const eloNodes = (doc: Document, entry: LeaderboardRow): Node[] => ratingNodes(doc, entry);
/** Last 5, newest first: a result stamp each, a link to its replay where one is stored. Each link is keyed by
 * its table and layout (place), player and replay, so a redraw of another table keeps focus on it. */
const formNodes = (doc: Document, entry: LeaderboardRow, search: string, place: string): HTMLElement[] => formMarks(entry, search).map(mark => {
  const letter = h(doc, "span", undefined, mark.result);
  letter.setAttribute("aria-hidden", "true");
  const words = h(doc, "span", "d1p-sr", mark.label);
  let node: HTMLElement;
  if (mark.href === null) node = h(doc, "span", "d1p-form-mark");
  else {
    const link = h(doc, "a", "d1p-form-mark");
    link.href = mark.href;
    link.title = mark.label;
    link.dataset.key = `form|${place}|${entry.displayName}|${mark.href}`;
    node = link;
  }
  node.dataset.result = mark.result;
  node.append(letter, words);
  return node;
});

/** The board as a real table on wide screens, and as labelled stacked rows under 46rem, as Matches does. */
function rankingTable(doc: Document, table: RankingView, titleId: string, search: string): HTMLElement[] {
  const grid = h(doc, "table", "d1p-table d1p-lb d1p-wide");
  grid.setAttribute("aria-labelledby", titleId);
  const head = h(doc, "thead"), labels = h(doc, "tr");
  const rank = h(doc, "th", "c-rank");
  rank.scope = "col";
  // Rank numbers: "#" on screen, "Rank" to a screen reader.
  const glyph = h(doc, "span", undefined, "#");
  glyph.setAttribute("aria-hidden", "true");
  rank.append(glyph, h(doc, "span", "d1p-sr", "Rank"));
  labels.append(rank);
  // Record and Last 5 follow main, beside rated matches.
  const columns = [
    [C.nameColumn, "c-name"], [C.eloColumn, "c-elo"], [C.matchesColumn, "c-matches"], [C.recordColumn, "c-record"], [C.formColumn, "c-form"],
  ] as const;
  for (const [text, cls] of columns) {
    const cell = h(doc, "th", cls, text);
    cell.scope = "col";
    labels.append(cell);
  }
  head.append(labels);
  const body = h(doc, "tbody");
  if (table.rows.length === 0) {
    // Loading with nothing yet: a still skeleton, no pulse; the state line says what is happening.
    grid.setAttribute("aria-hidden", "true");
    for (let line = 0; line < 3; line++) {
      const row = h(doc, "tr");
      const bars = [["c-rank", "16px"], ["c-name", "180px"], ["c-elo", "36px"], ["c-matches", "20px"], ["c-record", "32px"], ["c-form", "120px"]] as const;
      for (const [cls, width] of bars) {
        const cell = h(doc, "td", cls), bar = h(doc, "span", "d1p-skel");
        bar.style.width = width;
        cell.append(bar);
        row.append(cell);
      }
      body.append(row);
    }
    grid.append(head, body);
    return [grid];
  }
  const order = ranks(table.rows);
  const narrow = h(doc, "div", "d1p-narrow");
  // The stacked rows' own head names the first line's figures once; screen readers hear each row's labels instead.
  const narrowHead = h(doc, "div", "d1p-rows-head d1p-lb-head");
  narrowHead.setAttribute("aria-hidden", "true");
  narrowHead.append(h(doc, "span", "d1p-kicker c-rank", "#"), h(doc, "span", "d1p-kicker", C.nameColumn), h(doc, "span", "d1p-kicker c-elo", C.eloColumn));
  const list = h(doc, "ul", "d1p-rows d1p-lb-rows");
  list.setAttribute("aria-labelledby", titleId);
  narrow.append(narrowHead, list);
  const stat = (label: string, ...value: (Node | string)[]) => {
    const node = h(doc, "span", "d1p-stat");
    node.append(h(doc, "span", "d1p-kicker", label), " ", ...value);
    return node;
  };
  table.rows.forEach((entry, index) => {
    const record = recordOf(entry);
    const row = h(doc, "tr");
    const place = h(doc, "td", "c-rank", String(order[index]));
    const name = h(doc, "th", "c-name");
    name.scope = "row";
    name.append(...nameOf(doc, entry));
    const elo = h(doc, "td", "c-elo");
    elo.append(...eloNodes(doc, entry));
    const form = h(doc, "td", "c-form");
    form.append(...formNodes(doc, entry, search, `${titleId}|wide`));
    row.append(place, name, elo, h(doc, "td", "c-matches", String(entry.ratedMatches)), h(doc, "td", "c-record", record), form);
    body.append(row);

    const item = h(doc, "li");
    const itemPlace = h(doc, "span", "c-rank");
    itemPlace.append(h(doc, "span", "d1p-sr", "Rank "), String(order[index]));
    const itemName = h(doc, "p", "d1p-line is-lead");
    itemName.append(...nameOf(doc, entry));
    const itemElo = h(doc, "p", "c-elo");
    itemElo.append(h(doc, "span", "d1p-sr", `${C.eloColumn} `), ...eloNodes(doc, entry));
    const stats = h(doc, "p", "d1p-line d1p-lb-stats");
    stats.append(stat(C.matchesColumn, String(entry.ratedMatches)));
    // Without a reconciled record, Record and Last 5 show nothing, as the table's cells do.
    if (record !== "") stats.append(stat(C.recordColumn, record));
    const marks = formNodes(doc, entry, search, `${titleId}|narrow`);
    if (marks.length > 0) {
      const letters = h(doc, "span", "d1p-form");
      letters.append(...marks);
      stats.append(stat(C.formColumn, letters));
    }
    item.append(itemPlace, itemName, itemElo, stats);
    list.append(item);
  });
  grid.append(head, body);
  return [grid, narrow];
}
