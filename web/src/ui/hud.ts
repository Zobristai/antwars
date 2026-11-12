// The spectator HUD as a broadcast window. One score plate at the top centre, the score panel:
// Kills, Territory, Queens and Ants, each a figure and a track per colony, with
// a drawer under each colony's half; the board's window takes the rest of the main column, its controls floating over
// the board; under it one line, the stream's state and Bring your agent; one narrow pane for the name and the pages,
// then the deck's agent panel (agents.ts). That panel, the deck's board look and its 3D view from above are the
// chosen combination.
//
// Overlay exports are read only inside functions: overlays.ts imports this module.
import { domIcon, textIcon } from "../icons/dom.ts";
import "./ui.css";
import type { HudHost, HudView, Mounted } from "./types.ts";
import type { Rect } from "../words.ts";
import { COLONY_NAMES, RULES_NAMES, rulesConfig, type SimConfig } from "../../../src/sim/config.ts";
import { colonyNameNote, colonyNamesOf, type ColonyNamePair } from "../../../src/sim/colonyNames.ts";
import { streamQueens, type StreamQueen, type StreamSetup } from "../../../src/live/format.ts";
import { fallWindow, fallenColonies, fallenQueen, resultShownAt, type Board, type Frame } from "../buffer.ts";
import {
  cardSubject, colonyLedger, colonyCardLines, colonyStats, headline, matchTime, nextAntCells, nextAntState, nextHatchCaste,
  queensUnderAttack, scoreHatchStatus, storyText, storyWhen, territoryWinText,
} from "../overlays.ts";
import { boardQueenHp } from "../variant.ts";
import { INSPIRED_BY_URL, PAGE_COPY, SCORE_COPY, clockTime, matchClock, significant } from "../story.ts";
import { ZOOM_STEP } from "../camera.ts";
import { setBoardLook } from "../board-look.ts";
import { AGENT_ADDRESS_LABEL, AGENT_HEADING, buildAgentPanel, mcpAddress, type Clipboard } from "../agent.ts";
import { STEPPE_LOOK } from "./steppe-look.ts";
import { mountAgents } from "./agents.ts";
import { mountResultModal } from "./deck/result-modal.ts";
import { homeLink } from "./deck/brand.ts";
import {
  CLOSED, boardHref, drawers, holdProgress, isShown, keep, leadLine, liveQueens, shares, spawnFill, stepped, withUnits, withoutCasteGlyph,
  type DrawerEvent, type Drawers,
} from "./format.ts";
import { navigation } from "./nav.ts";

type Colony = 0 | 1;
const COLONIES = [0, 1] as const;
/** Wide from this width (or any landscape screen from 560 px): the window beside a standing pane. */
const WIDE_MIN_PX = 860;
/** The plate's width as drawn on desktop (676 × 154); a narrower column takes the plate at its own width. */
const PLATE_PX = 676;
/**
 * From this plate width each row runs on one line, as the desktop drawing; under it the clock stands over the names and
 * each row's figures over its tracks, as the 390 px phone drawing (358 × 258).
 */
const INLINE_PLATE_MIN_PX = 510;
/** On a narrow screen the pane below keeps at least this much height: its name and pages, and the start of its list. */
const NARROW_PANE_MIN_PX = 132;

/** The 3D board's whole-board control: the whole board from straight above. */
export const OVERVIEW_LABEL = "Whole board, from above";

/** New words this HUD adds; every other string is the page's own. */
export const D2_COPY = {
  details: (colony: Colony, names: ColonyNamePair = COLONY_NAMES) => `${names[colony]} details`,
  board: "Board",
  kills: "Kills",
  /** The clock's time left, as the score panel draws it: "29:20 · 0:40 left". */
  left: (time: string) => `${time} left`,
  /** The spawn chip's name, read aloud only: the colony card's own words for the next hatch ("Food 2/6 · Next ant"). */
  nextAnt: "Next ant",
  /** The spawn chip at the colony's cap: the score's own word for it, SCORE_COPY.full. */
  full: "Full",
  to2d: "Show the 2D board",
  noMatch: "No live match",
  closeCard: "Close ant details",
} as const;

/** A 20 px line icon in a 24 px box and the current ink, as the score panel draws them. */
const lineIcon = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
/** The small icons the score panel draws, in the current ink. */
const ICONS = {
  get whole() { return domIcon("whole", '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg>'); },
  get chevron() { return domIcon("chevron", '<svg viewBox="0 0 14 8" width="14" height="8" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l6 6 6-6"/></svg>'); },
  get flag() { return domIcon("flag", lineIcon("M6 22V3M6 4h12l-3 4.5L18 13H6")); },
  get worker() { return domIcon("worker", lineIcon("M5 21 16 8M6 5c6-4 11-1 14 5L13 7 6 5Z")); },
  get soldier() { return domIcon("soldier", lineIcon("m3 3 8 5-3 3-5-8Zm18 0-8 5 3 3 5-8ZM8 11l11 11M16 11 5 22M15 17l6 1M9 17l-6 1")); },
} as const;

/** The board's rules where its stream names them, or the queen-HP rules it plays (as nextHatchCaste reads them). */
function boardRules(b: Board): SimConfig | null {
  const name = b.setup.rules ?? (boardQueenHp(b) !== undefined ? "redesign" : null);
  return name !== null && (RULES_NAMES as readonly string[]).includes(name) ? rulesConfig(name) : null;
}

export function mountHud(context: HudHost): Mounted<HudView> {
  const { doc, host, tips, replay, teamView, waiting, boardAspect, actions } = context;
  const win = doc.defaultView!;
  const texts = new WeakMap<Node, string>();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const text = (node: HTMLElement, value: string) => { if (texts.get(node) !== value) { texts.set(node, value); node.textContent = value; } };
  const attr = (node: Element, name: string, value: string | null) => {
    if (value === null) { if (node.hasAttribute(name)) node.removeAttribute(name); }
    else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  };
  const flag = (node: Element, cls: string, on: boolean) => { if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on); };
  const show = (node: HTMLElement, on: boolean) => { if (node.hidden === on) node.hidden = !on; };
  const button = (cls: string, label: string, content?: string) => {
    const b = el("button", cls, content);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    return b;
  };
  const icon = (cls: string, svg: string) => {
    const span = el("span", cls);
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = svg;
    return span;
  };
  const search = () => win.location.search;
  const listeners: (() => void)[] = [];
  const listen = <T extends EventTarget>(target: T, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };
  const reducedMotion = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;

  const root = el("div", "d2 d2-hud");
  doc.documentElement.dataset.d2Hud = "";
  /** The last frame and view drawn, and whether its result is showing. */
  let frameNow: Frame | null = null;
  let viewNow: HudView | null = null;
  let ended = false;

  // ---------------------------------------------------------------- the score plate and its drawers
  // Score panel: a header, then
  // Kills, Territory, Queens and Ants. Each row is a figure and a track per colony, the right mirroring the left about
  // the row's label; a status with a clock is a white chip. Each half of the plate opens its colony's drawer.
  const score = el("header", "d2-score");
  const plateWrap = el("div", "d2-plate-wrap");
  const plate = el("div", "d2-plate");
  plate.setAttribute("role", "group");
  plate.setAttribute("aria-label", "Score");
  const halves = COLONIES.map(colony => {
    const half = el("div", `d2-half c${colony}`);
    half.tabIndex = 0;
    half.setAttribute("role", "button");
    half.setAttribute("aria-expanded", "false");
    half.setAttribute("aria-controls", `d2-drawer-${colony}`);
    half.setAttribute("aria-label", D2_COPY.details(colony));
    return half;
  });
  /** Each width written, so a frame that changes nothing writes nothing. */
  const widths = new WeakMap<HTMLElement, string>();
  const width = (node: HTMLElement, value: string) => { if (widths.get(node) !== value) { widths.set(node, value); node.style.width = value; } };
  // The header: each colony's chevron at the plate's outer edge, then its name over its own figures; the clock between.
  const names = COLONIES.map(colony => {
    const name = el("span", `d2-name c${colony}`);
    const chevron = icon("d2-chevron", ICONS.chevron);
    const words = el("span", "d2-name-text", COLONY_NAMES[colony]);
    name.append(...(colony === 0 ? [chevron, words] : [words, chevron]));
    return name;
  });
  const nameWords = names.map(name => name.querySelector<HTMLElement>(".d2-name-text")!);
  /** The colony names shown: the match's own, else the rated names; written again only when they change. */
  let shownNames = `${COLONY_NAMES[0]}\n${COLONY_NAMES[1]}`;
  const paintNames = (setup: StreamSetup | null) => {
    const pair = colonyNamesOf(setup), key = `${pair[0]}\n${pair[1]}`;
    if (key === shownNames) return;
    shownNames = key;
    for (const c of COLONIES) {
      text(nameWords[c]!, pair[c]);
      // A drawn name has its source as its tooltip; the rated names are shown as they were.
      const note = setup?.colonyNames ? colonyNameNote(pair[c]) : null;
      if (note) nameWords[c]!.title = note; else nameWords[c]!.removeAttribute("title");
      attr(halves[c]!, "aria-label", D2_COPY.details(c, pair));
      attr(drawerEls[c]!.drawer, "aria-label", D2_COPY.details(c, pair));
    }
  };
  const clock = el("span", "d2-clock");
  const plateHead = el("div", "d2-head");
  plateHead.append(names[0]!, clock, names[1]!);
  /** A status with a clock: its icon at its colony's end, then a ring filling with the clock, then its words. */
  const chip = (cls: string, colony: Colony, glyph = "") => {
    const node = el("span", `d2-chip ${cls} c${colony}`);
    const iconBox = icon("d2-chip-icon", glyph);
    const ring = icon("d2-chip-ring", '<svg viewBox="0 0 18 18" width="18" height="18"><circle class="d2-pie-track" cx="9" cy="9" r="9"/><circle class="d2-pie" cx="9" cy="9" r="4.5" pathLength="100" transform="rotate(-90 9 9)"/></svg>');
    const words = el("span", "d2-chip-text");
    node.append(iconBox, ring, words);
    return { node, iconBox, pie: ring.querySelector<SVGCircleElement>(".d2-pie")!, words, at: -1 };
  };
  const setFill = (c: { node: HTMLElement; pie: SVGCircleElement; at: number }, at: number) => {
    // A fresh wait starts empty at once; only the filling is eased.
    flag(c.node, "is-restart", at < c.at);
    if (c.at !== at) { c.at = at; c.pie.style.strokeDashoffset = (100 - 100 * at).toFixed(1); }
  };
  /** A share track, filled in the colony's colour from its own end. */
  const track = (colony: Colony) => {
    const node = el("span", `d2-track c${colony}`);
    const fill = el("span", "d2-tfill");
    node.append(fill);
    return { node, fill };
  };
  /** One row: a figure and a track per colony, mirrored about the row's label. */
  const row = <T extends { node: HTMLElement }>(label: string, side: (colony: Colony) => T) => {
    const node = el("div", "d2-srow");
    const figures = COLONIES.map(c => el("span", `d2-fig c${c}`));
    const sides = COLONIES.map(side);
    const name = el("span", "d2-slabel", label);
    node.append(figures[0]!, sides[0]!.node, name, sides[1]!.node, figures[1]!);
    return { node, figures, sides, name };
  };
  // Kills: each colony's kills, which are the other's losses (time-up's first decider), its share of both from its end.
  const kills = row(D2_COPY.kills, track);
  // Territory: each colony's share of the held ground, the six-to-one line, and a hold's chip over the holder's track.
  const territory = row(SCORE_COPY.territory, colony => {
    const t = track(colony);
    const hold = chip("d2-hold", colony, ICONS.flag);
    hold.node.hidden = true;
    t.node.append(el("span", "d2-tick"), hold.node);
    return { ...t, hold };
  });
  const holdWords = el("span", "d2-sr");
  territory.name.append(holdWords);
  // Queens: one cell per standing queen from the colony's end, her HP filling it; a lost queen drops off.
  const queens = row(SCORE_COPY.queens, colony => {
    const node = el("span", `d2-cells c${colony}`);
    node.setAttribute("role", "list");
    return { node };
  });
  // Ants: the living, their share of both from the colony's end; workers solid, soldiers hatched at the inner end.
  const ants = row(SCORE_COPY.ants, colony => {
    const t = track(colony);
    const soldiers = el("span", "d2-soldiers");
    t.fill.append(soldiers);
    return { ...t, soldiers };
  });
  for (const r of [kills, territory, ants]) for (const s of r.sides) s.node.setAttribute("aria-hidden", "true");
  const rows = el("div", "d2-rows");
  rows.append(plateHead, kills.node, territory.node, queens.node, ants.node);
  plate.append(halves[0]!, halves[1]!, rows);
  const drawerEls = COLONIES.map(colony => {
    const drawer = el("section", `d2-drawer c${colony}`);
    drawer.id = `d2-drawer-${colony}`;
    drawer.setAttribute("aria-label", D2_COPY.details(colony));
    drawer.hidden = true;
    const ledger = el("dl", "d2-ledger");
    const pair = (area: string, label: string, cls = "d2-pair") => {
      const box = el("div", cls);
      box.style.gridArea = area;
      const term = el("dt", undefined, label);
      const value = el("dd", "d2-value");
      box.append(term, value);
      ledger.append(box);
      return { box, term, value };
    };
    // The next hatch first, at the colony's outer edge with Food beside it, then the other pairs; the right
    // drawer mirrors the left by column. Losses are the other colony's kills on the plate: not said twice.
    const spawnPair = pair("spawn", D2_COPY.nextAnt, "d2-pair d2-spawn");
    spawnPair.term.className = "d2-sr";
    const spawn = { ...chip("d2-next", colony), box: spawnPair.box, caste: "" };
    spawn.node.setAttribute("role", "img");
    spawnPair.value.append(spawn.node);
    const values = { food: pair("food", "Food"), workers: pair("workers", "Workers"), soldiers: pair("soldiers", "Soldiers"), hatched: pair("hatched", SCORE_COPY.hatched), cap: pair("cap", SCORE_COPY.max) };
    drawer.append(ledger);
    return { drawer, values, spawn };
  });
  plateWrap.append(plate, drawerEls[0]!.drawer, drawerEls[1]!.drawer);
  score.append(plateWrap);

  let state: Drawers = CLOSED;
  const dispatch = (event: DrawerEvent) => { state = drawers(state, event); paintDrawers(); };
  for (const colony of COLONIES) {
    const half = halves[colony]!;
    let pointed = false;
    listen(half, "pointerenter", e => { if ((e as PointerEvent).pointerType === "mouse") dispatch({ kind: "point", colony }); });
    listen(half, "pointerdown", () => { pointed = true; });
    // A tap's own focus waits for its click, which pins; the keyboard's focus previews.
    listen(half, "focus", () => { if (pointed) pointed = false; else dispatch({ kind: "focus", colony }); });
    listen(half, "blur", () => dispatch({ kind: "blur", colony }));
    listen(half, "click", () => { pointed = false; dispatch({ kind: "toggle", colony }); });
    listen(half, "keydown", e => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") { e.preventDefault(); dispatch({ kind: "toggle", colony }); }
    });
  }
  listen(plateWrap, "pointerleave", e => { if ((e as PointerEvent).pointerType === "mouse") dispatch({ kind: "leave" }); });
  listen(plateWrap, "keydown", e => { if ((e as KeyboardEvent).key === "Escape") dispatch({ kind: "close" }); });
  function paintDrawers() {
    for (const colony of COLONIES) {
      const on = isShown(state, colony) && !ended;
      show(drawerEls[colony]!.drawer, on);
      attr(halves[colony]!, "aria-expanded", String(on));
      flag(plate, `open-${colony}`, on);
      flag(drawerEls[colony]!.drawer, "is-pinned", state.pinned[colony]);
    }
    if (frameNow?.board) paintDrawerValues(frameNow, frameNow.board);
  }
  // The shared no-match notice floats under the score and under any open drawer, never over either: its top follows the
  // plate and the drawers whenever either changes size, opening and closing included.
  const placeNotice = () => {
    const wrap = plateWrap.getBoundingClientRect();
    let bottom = wrap.bottom;
    for (const { drawer } of drawerEls) if (!drawer.hidden) bottom = Math.max(bottom, wrap.top + drawer.offsetTop + drawer.offsetHeight);
    doc.documentElement.style.setProperty("--d2-notice-top", `${Math.round(bottom + 12)}px`);
  };
  // The unit-test DOM has no ResizeObserver.
  const noticeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(placeNotice);
  if (noticeObserver) {
    for (const target of [plateWrap, drawerEls[0]!.drawer, drawerEls[1]!.drawer]) noticeObserver.observe(target);
    listeners.push(() => noticeObserver.disconnect());
  }

  // ---------------------------------------------------------------- the window: the board, its controls and its toast
  const stage = el("div", "d2-stage");
  const hole = el("div", "d2-window");
  hole.setAttribute("aria-hidden", "true");
  const lane = el("div", "d2-lane");
  const cluster = el("div", "d2-cluster");
  cluster.setAttribute("role", "group");
  cluster.setAttribute("aria-label", D2_COPY.board);
  // The view, then −, +, then the board itself: one link to the other board, named for where it goes. The view is the
  // whole board, on the 3D board from straight above (main3d.ts overview, built for the deck).
  const overview = actions.overview ?? actions.wholeBoard;
  const whole = button("d2-btn d2-btn-whole", actions.overview ? OVERVIEW_LABEL : PAGE_COPY.wholeBoard);
  whole.innerHTML = ICONS.whole;
  const zoomOut = textIcon("zoom-out", button("d2-btn", PAGE_COPY.zoomOut, "−"));
  const zoomIn = textIcon("zoom-in", button("d2-btn", PAGE_COPY.zoomIn, "+"));
  listen(whole, "click", () => overview?.());
  listen(zoomOut, "click", () => actions.zoom?.(1 / ZOOM_STEP));
  listen(zoomIn, "click", () => actions.zoom?.(ZOOM_STEP));
  // A board without a camera has no view or zoom to offer.
  show(whole, overview !== undefined);
  show(zoomOut, actions.zoom !== undefined);
  show(zoomIn, actions.zoom !== undefined);
  const boardToggle = el("a", "d2-btn d2-btn-board");
  cluster.append(whole, zoomOut, zoomIn, boardToggle);
  const transport = el("div", "d2-transport");
  lane.append(cluster, transport);
  const toast = el("div", "d2-toast");
  toast.setAttribute("role", "status");
  toast.dataset.state = "hidden";
  const toastBar = el("span", "d2-toast-bar"), toastWhen = el("span", "d2-toast-when"), toastWhat = el("span", "d2-toast-what"), toastWho = el("span", "d2-toast-who");
  toast.append(toastBar, toastWhen, toastWhat, toastWho);
  stage.append(hole, toast, lane);

  // ---------------------------------------------------------------- the line under the window: the stream's state, Bring your agent
  const foot = el("footer", "d2-foot");
  const status = el("div", "d2-status");
  status.setAttribute("role", "status");
  const modeLabel = el("span", "d2-mode-label"), modeDetail = el("span", "d2-mode-detail"), connection = el("span", "d2-connection");
  const back = el("a", "d2-back");
  const backText = el("span", "d2-back-text");
  back.append(backText);
  status.append(modeLabel, modeDetail, connection, back);
  // Compact: its name, then the address and its Copy, the live controls themselves.
  const join = el("div", "d2-join");
  join.setAttribute("role", "group");
  join.setAttribute("aria-label", AGENT_HEADING);
  join.title = AGENT_ADDRESS_LABEL;
  join.append(el("span", "d2-join-label", AGENT_HEADING));
  foot.append(status, join);

  // ---------------------------------------------------------------- the pane: the name and the pages, then one list
  const pane = el("aside", "d2-pane");
  pane.setAttribute("aria-label", "Agents and thoughts");
  const head = el("div", "d2-pane-head");
  const brand = el("span", "d2-brand");
  // The wordmark links home, as the deck's emblem and wordmark do (deck/brand.ts); the credit stays plain text.
  const home = homeLink(doc, "d2-home");
  home.append(el("span", "d2-wordmark", PAGE_COPY.name));
  brand.append(home, el("span", "d2-credit", PAGE_COPY.credit));
  head.append(brand, navigation(doc, "watch", search()));
  // An ant picked on the board outside any squad; an agent's details open in its own row instead.
  const card = el("section", "d2-card");
  card.hidden = true;
  card.setAttribute("aria-label", "Selected ant");
  const cardHead = el("div", "d2-card-head");
  const cardTitle = el("span", "d2-card-title");
  const cardClose = textIcon("close", button("d2-close", D2_COPY.closeCard, "×"));
  cardHead.append(cardTitle, cardClose);
  const cardLines = el("div", "d2-card-lines");
  card.append(cardHead, cardLines);
  listen(cardClose, "click", () => { actions.select(null); actions.selectAgent(-1); });
  // The agents: the deck's panel, one row per agent with its newest thought or mark, the key behind its (i). On a
  // phone it stands open under the line, the pane scrolling as a whole.
  const agentsPanel = mountAgents(doc, actions, { search, lightOrder: agent => actions.pointOrder(agent) });
  const paneFoot = el("footer", "d2-pane-foot");
  const links = el("p", "d2-links");
  const rules = el("a", "d2-link", "Rules");
  rules.href = "/rules"; rules.target = "_blank"; rules.rel = "noopener";
  const inspired = el("a", "d2-link", "Inspired by @LambethEthan");
  inspired.href = INSPIRED_BY_URL; inspired.target = "_blank"; inspired.rel = "noopener noreferrer";
  // On a narrow screen the head has no room for the credit; it stands here instead, never in both places.
  links.append(el("span", "d2-credit", PAGE_COPY.credit), rules, inspired);
  paneFoot.append(links);
  pane.append(head, card, agentsPanel.root, paneFoot);

  // Reading and focus order follow the eye: the score, the window's controls, the line under it, the pane.
  // The match result: the deck's modal over the whole screen, shared, at the HUD's root.
  const resultModal = mountResultModal(doc);
  root.append(score, stage, foot, pane, resultModal.dialog);
  host.append(root);
  // the deck's board look, part of the combination: both boards draw it from their next frame and drop it when this
  // view unmounts (board-look.ts); with none set they draw as Current.
  setBoardLook(STEPPE_LOOK);

  // ---------------------------------------------------------------- the board's live controls, with their own listeners
  // The page's address and its Copy (agent.ts buildAgentPanel), as the deck's dialog and the landing page build them.
  join.append(buildAgentPanel(doc, mcpAddress(win.location.origin), win.navigator?.clipboard as Clipboard | undefined).querySelector<HTMLElement>(".aw-byoa-address")!);
  if (replay) transport.append(replay);
  // The board's point-of-view choice (team-view.ts) leads the window's controls.
  if (teamView) cluster.prepend(teamView);
  flag(root, "has-transport", replay !== null);
  for (const tip of tips) root.append(tip);
  if (waiting) stage.append(waiting);

  // ---------------------------------------------------------------- layout: the window owns a fixed rectangle per viewport
  const aspect = () => {
    if (boardAspect !== null) return boardAspect;
    const setup = frameNow?.board?.setup;
    return setup ? (setup.mapW + 4.5) / (setup.mapH + 4.5) : 4 / 3;
  };
  /** Chosen from the viewport alone, the same way the stylesheet reads it, so the window never moves in play. */
  const layout = () => {
    const w = win.innerWidth, h = win.innerHeight;
    const narrow = !(w >= WIDE_MIN_PX || (w >= 560 && w > h * 1.2));
    root.dataset.layout = narrow ? "narrow" : "wide";
    if (!narrow && h < 520) root.dataset.short = ""; else delete root.dataset.short;
    const paneW = w >= 1280 ? 296 : Math.min(296, Math.max(248, 0.17 * w));
    const main = narrow ? w - 16 : w - 36 - paneW;
    // As drawn: 676 px at most, and on a narrow screen 16 px from each edge (the stylesheet's .d2-plate-wrap).
    const plateW = Math.min(PLATE_PX, narrow ? main - 16 : main);
    root.dataset.plate = plateW < INLINE_PLATE_MIN_PX ? "stacked" : "inline";
    if (!narrow) { root.style.removeProperty("--d2-window-h"); return; }
    const css = getComputedStyle(root);
    const px = (name: string) => Number.parseFloat(css.getPropertyValue(name)) || 0;
    const room = h - (6 + px("--d2-plate-h") + 6 + px("--d2-foot")) - NARROW_PANE_MIN_PX;
    root.style.setProperty("--d2-window-h", `${Math.round(Math.max(120, Math.min(w / aspect() + px("--d2-lane"), room)))}px`);
  };
  listen(win, "resize", layout);
  layout();

  // ---------------------------------------------------------------- frame-driven painting
  let boardKey = "";
  function paintBoardToggle(board: HudView["board"]) {
    const keyNow = `${board}|${win.location.href}`;
    if (boardKey === keyNow) return;
    boardKey = keyNow;
    const to = board === "3d" ? "2d" : "3d";
    boardToggle.textContent = to === "2d" ? "2D" : "3D";
    boardToggle.href = boardHref(to, win.location.href);
    const label = to === "2d" ? D2_COPY.to2d : "Try the 3D view; 2D stays available if 3D cannot run";
    attr(boardToggle, "aria-label", label);
    boardToggle.title = label;
  }

  function paintStatus(view: HudView) {
    const noMatch = view.frame === null;
    // The board's live/recorded line (replay.ts modeCopy): a recording's label opens with RECORDING, as the deck's legend reads it.
    const mode = view.mode;
    const recorded = noMatch || !!mode?.label.startsWith("RECORDING");
    const label = noMatch ? D2_COPY.noMatch : mode?.label ?? "";
    const detail = noMatch ? "" : mode?.detail ?? "";
    const href = noMatch ? null : mode?.link?.href ?? null;
    const words = mode?.link?.text ?? "";
    text(modeLabel, label);
    text(modeDetail, withUnits(detail));
    flag(status, "is-replay", recorded);
    text(connection, view.connection);
    // Live with no agents offers the recording in the pane; only Back to live stays on the line.
    const backHere = href !== null && words !== "" && href !== "?replay";
    show(back, backHere);
    if (backHere) { text(backText, words); attr(back, "href", keep(href, search())); }
  }

  /** The board's rules, read again only when its setup changes. */
  let rulesSetup: StreamSetup | null = null;
  let rulesNow: SimConfig | null = null;
  const rulesOf = (b: Board) => {
    if (rulesSetup !== b.setup) { rulesSetup = b.setup; rulesNow = boardRules(b); }
    return rulesNow;
  };

  /** A row's two fills, each from its own end; both empty when neither colony has any. */
  const paintShares = (fills: readonly HTMLElement[], pct: readonly [number, number] | null) => {
    for (const k of COLONIES) width(fills[k]!, pct ? `${pct[k].toFixed(1)}%` : "0%");
  };
  const figuresOf = (k: Colony) => [kills, territory, queens, ants].map(r => r.figures[k]!);

  function paintPlate(frame: Frame | null, b: Board | null) {
    flag(root, "is-empty", b === null);
    if (b === null || frame === null) {
      text(clock, "—");
      for (const c of COLONIES) {
        for (const node of figuresOf(c)) { text(node, ""); flag(node, "is-fallen", false); }
        flag(names[c]!, "is-fallen", false);
        queens.sides[c]!.node.replaceChildren();
        show(territory.sides[c]!.hold.node, false);
      }
      for (const r of [kills, territory, ants]) paintShares(r.sides.map(s => s.fill), null);
      flag(territory.node, "has-lead-line", false);
      text(holdWords, "");
      return;
    }
    const tick = frame.tick;
    const tps = b.setup.ticksPerSecond || 10;
    const config = rulesOf(b);
    // As drawn, "29:20 · 0:40 left"; once the match has ended, the page's "ended" in its place.
    const time = matchClock(tick, b.setup, b.result !== null);
    const left = b.result !== null ? time.left : D2_COPY.left(clockTime(Math.ceil(Math.max(0, b.setup.matchTicks - tick) / tps) * tps, tps));
    text(clock, `${time.elapsed} · ${left}`);
    const fallen = fallenColonies(b);
    // Kills: every death is the other colony's kill (src/sim/territory.ts decideTimeUp).
    const killed: [number, number] = [b.deaths[1], b.deaths[0]];
    paintShares(kills.sides.map(s => s.fill), shares(killed[0], killed[1]));
    // Territory: each colony's share of the held ground; the six-to-one line while the rules have an early win.
    const tiles = shares(b.held[0], b.held[1]);
    paintShares(territory.sides.map(s => s.fill), tiles);
    const early = config?.earlyWin;
    flag(territory.node, "has-lead-line", early !== undefined && b.result === null && tiles !== null);
    if (early) territory.node.style.setProperty("--d2-lead", `${leadLine(early.territoryRatioPermille).toFixed(2)}%`);
    paintHold(b, tick);
    // Ants: the living, workers and soldiers (colonyStats).
    const stats = colonyStats(frame);
    const living = COLONIES.map(k => stats[k].workers + stats[k].soldiers) as [number, number];
    paintShares(ants.sides.map(s => s.fill), shares(living[0], living[1]));
    for (const k of COLONIES) {
      text(kills.figures[k]!, killed[k].toLocaleString("en"));
      text(territory.figures[k]!, tiles ? `${Math.round(tiles[k])}%` : "");
      text(ants.figures[k]!, living[k].toLocaleString("en"));
      width(ants.sides[k]!.soldiers, living[k] > 0 ? `${((100 * stats[k].soldiers) / living[k]).toFixed(1)}%` : "0%");
      for (const node of [names[k]!, ...figuresOf(k)]) flag(node, "is-fallen", fallen[k]);
    }
    paintQueens(frame, b);
  }

  /**
   * A hold's chip over the holding colony's Territory track: a flag, the ring filling over the hold, then the
   * time left to its territory win, only while that win can still land before time-up (headline's "win in"). A hold
   * due after time-up, which the page counts down to the match's end instead, shows no chip.
   */
  function paintHold(b: Board, tick: number) {
    const h = headline(b, tick);
    const holder = h.label === SCORE_COPY.winIn ? h.leader : null;
    const held = holder === null ? null : holdProgress(b.territoryWin, tick);
    for (const k of COLONIES) {
      const c = territory.sides[k]!.hold;
      const on = holder === k && held !== null;
      show(c.node, on);
      if (!on || held === null) { c.at = -1; continue; }
      text(c.words, h.figure);
      setFill(c, held);
    }
    text(holdWords, holder !== null && held !== null ? ` · ${territoryWinText(b, tick) ?? ""}` : "");
  }

  /** A queen out of the match: lost, or overrun to the end where queens have no HP. */
  function queenFallen(q: StreamQueen, b: Board): boolean {
    return q.lostTick !== null || (boardQueenHp(b) === undefined && b.overrunRequired > 0 && q.overrun >= b.overrunRequired);
  }
  const cellCache = new Map<string, { node: HTMLElement; fill: HTMLElement }>();
  function paintQueens(frame: Frame, b: Board) {
    const all = streamQueens(b);
    const hp = boardQueenHp(b);
    const attacked = queensUnderAttack(frame.story, frame.tick);
    for (const colony of COLONIES) {
      const list = queens.sides[colony]!.node;
      const standing = liveQueens(all, colony, q => queenFallen(q, b));
      const cells = standing.map(q => cell(q, frame, b, hp?.hp, attacked));
      if (cells.length !== list.childElementCount || cells.some((node, i) => list.children[i] !== node)) list.replaceChildren(...cells);
      text(queens.figures[colony]!, String(standing.length));
      attr(list, "aria-label", `${colonyNamesOf(b.setup)[colony]}: ${standing.length} standing ${standing.length === 1 ? "queen" : "queens"}`);
    }
  }
  /** One queen's cell: her HP filling it from her colony's end (or, where queens have no HP, her safety from overrun). */
  function cell(q: StreamQueen, frame: Frame, b: Board, fullHp: number | undefined, attacked: Set<string>): HTMLElement {
    const id = `${q.colony}:${q.id}`;
    let entry = cellCache.get(id);
    if (!entry) {
      const node = el("span", "d2-cell");
      node.setAttribute("role", "listitem");
      const fill = el("span", "d2-cell-fill");
      node.append(fill);
      entry = { node, fill };
      cellCache.set(id, entry);
    }
    const progress = fullHp === undefined ? Math.min(100, (100 * q.overrun) / Math.max(1, b.overrunRequired)) : 0;
    const share = fullHp !== undefined ? Math.min(100, (100 * (q.hp ?? 0)) / fullHp) : 100 - progress;
    const hit = frame.hits.some(h => h.colony === q.colony && h.queenId === q.id);
    const under = attacked.has(id) || (fullHp === undefined && q.overrun > 0) || hit;
    flag(entry.node, "is-attacked", under);
    flag(entry.node, "is-hit", hit);
    flag(entry.node, "is-overrun", progress > 0);
    width(entry.fill, `${share.toFixed(1)}%`);
    const reading = fullHp !== undefined ? `${Math.ceil((q.hp ?? 0) / 1000)} HP` : progress > 0 ? `overrun ${Math.round(progress)}%` : "safe";
    attr(entry.node, "aria-label", `${colonyNamesOf(b.setup)[q.colony]} queen ${q.id + 1}: ${reading}${under ? ", under attack" : ""}`);
    return entry.node;
  }

  function paintDrawerValues(frame: Frame, b: Board) {
    const stats = colonyStats(frame);
    const tps = b.setup.ticksPerSecond || 10;
    const config = rulesOf(b);
    for (const colony of COLONIES) {
      if (drawerEls[colony]!.drawer.hidden) continue;
      const living = stats[colony].workers + stats[colony].soldiers;
      const lines = colonyCardLines(colonyLedger(stats[colony], living, b.hatch), stats[colony], "");
      const v = drawerEls[colony]!.values;
      text(v.workers.value, stats[colony].workers.toLocaleString("en")); text(v.soldiers.value, stats[colony].soldiers.toLocaleString("en"));
      text(v.hatched.value, lines.hatched); text(v.cap.value, lines.cap);
      const food = nextAntCells(b.stores[colony], b.hatch, living, frame.tick, tps);
      text(v.food.value, food?.[0] ?? "");
      show(v.food.box, food !== null);
      paintSpawn(colony, b, frame.tick, living, config);
    }
  }

  /**
   * The spawn chip, first in the drawer: the next hatch's caste icon, a ring filling to the hatch, then its wait
   * ("2 s"), the page's own words (scoreHatchStatus). Beyond the drawing: at the colony's
   * cap a grey full ring and "Full", and with a hatch due now a full ring and "Eligible"; short of
   * food, only an empty, still grey ring, with no icon and no words, drawn in d2.css from the
   * "is-food" flag alone.
   */
  function paintSpawn(colony: Colony, b: Board, tick: number, living: number, config: SimConfig | null) {
    const next = drawerEls[colony]!.spawn;
    const store = b.stores[colony], hatch = b.hatch, tps = b.setup.ticksPerSecond;
    const standing = streamQueens(b).some(q => q.colony === colony && !queenFallen(q, b));
    const known = hatch !== null && hatch.cap > 0 && tps > 0 && [store.food, store.nextCost, store.nextHatchTick].every(Number.isFinite) && store.nextCost > 0;
    const state = known && hatch !== null ? nextAntState(store, hatch, living, tick, tps) : null;
    const on = state !== null && standing && b.result === null && tick < b.setup.matchTicks;
    show(next.box, on);
    if (!on || state === null || hatch === null) { next.at = -1; return; }
    const status = scoreHatchStatus(b, colony, living, tick);
    attr(next.node, "aria-label", status.description);
    const full = state.kind === "full";
    flag(next.node, "is-full", full);
    flag(next.node, "is-food", state.kind === "food");
    text(next.words, full ? D2_COPY.full : withoutCasteGlyph(withUnits(status.text)));
    const caste = nextHatchCaste(b, store.nextCost) ?? "";
    if (next.caste !== caste) { next.caste = caste; next.iconBox.innerHTML = caste === "worker" ? ICONS.worker : caste === "soldier" ? ICONS.soldier : ""; }
    const interval = hatch.intervalTicks * (caste === "soldier" ? config?.hatchTiming?.soldierIntervalMultiplier ?? 1 : 1);
    const at = spawnFill(state, store.nextHatchTick, interval, tick);
    setFill(next, reducedMotion?.matches ? stepped(at) : at);
  }

  let toastKey = "";
  function paintToast(frame: Frame, b: Board) {
    const tps = b.setup.ticksPerSecond || 10;
    const fallen = fallWindow(frame);
    const fall = fallen.some(Boolean);
    let lines: { what: string; who: string; when: string; colony: Colony; kind: string } | null = null;
    const e = ended ? null : significant(frame.story, frame.tick, tps);
    if (e) {
      const t = storyText(e, b.agents, frame.tick, b.queens, false, colonyNamesOf(b.setup));
      const when = matchTime(storyWhen(e, frame.tick), tps);
      lines = { what: t.what, who: t.who, when, colony: e.colony, kind: e.kind };
    }
    if (fall && !ended) {
      // The fall is the match's moment: the queen lost, large, whatever the timeline last told.
      const q = fallenQueen(b);
      const colony = fallen.indexOf(true) as Colony;
      const when = matchTime(q?.lostTick ?? frame.tick, tps);
      lines = { what: `Queen ${(q?.id ?? 0) + 1} lost`, who: `${colonyNamesOf(b.setup)[colony]} · ${when}`, when: "", colony, kind: "fall" };
    }
    const keyNow = lines ? JSON.stringify(lines) : "";
    if (keyNow === toastKey) return;
    toastKey = keyNow;
    toast.dataset.state = lines ? "shown" : "hidden";
    if (!lines) return;
    toast.dataset.kind = lines.kind;
    toast.style.color = lines.colony === 0 ? "var(--aw-c0)" : "var(--aw-c1)";
    toastWhen.textContent = lines.when;
    toastWhat.textContent = lines.what;
    toastWho.textContent = lines.who;
  }

  let cardKey = "";
  function paintCard(view: HudView, b: Board | null) {
    const { ant, agent } = cardSubject(view.selected, view.selectedAgent);
    const visible = b !== null && !!ant && agent < 0;
    show(card, visible);
    if (!visible || !ant) { cardKey = ""; return; }
    const lines = [`Ant ${ant.antId} · ${colonyNamesOf(b!.setup)[ant.colony as Colony]}`, "No squad"];
    const keyNow = JSON.stringify(lines);
    if (keyNow === cardKey) return;
    cardKey = keyNow;
    cardTitle.textContent = lines[0]!;
    card.style.borderColor = ant.colony === 0 ? "var(--aw-c0)" : "var(--aw-c1)";
    cardLines.replaceChildren(el("p", "d2-card-line", lines[1]));
  }

  function update(view: HudView) {
    viewNow = view;
    const frame = view.frame;
    const b = frame?.board ?? null;
    frameNow = frame;
    paintBoardToggle(view.board);
    paintStatus(view);
    const wasEnded = ended;
    ended = !!(b && frame && b.result !== null && frame.targetMs >= resultShownAt(b.result, frame.endShown ?? undefined));
    // The result tells the ending: open drawers go with it, held or not.
    if (ended && !wasEnded) state = CLOSED;
    paintDrawers();
    paintNames(b?.setup ?? null);
    paintPlate(frame, b);
    flag(root, "is-falling", !!frame && fallWindow(frame).some(Boolean));
    if (!b || !frame) {
      toast.dataset.state = "hidden"; toastKey = "";
      show(card, false);
      resultModal.update(null);
      agentsPanel.update(null, view.selected, view.selectedAgent);
      return;
    }
    paintToast(frame, b);
    resultModal.update(frame, view.share ?? null);
    paintCard(view, b);
    agentsPanel.update(frame, view.selected, view.selectedAgent);
  }

  function boardArea(): Rect {
    const r = hole.getBoundingClientRect();
    const laneH = lane.getBoundingClientRect().height;
    if (!(r.width > 0 && r.height > laneH)) return { x0: 0, y0: 0, x1: win.innerWidth, y1: win.innerHeight };
    return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom - laneH };
  }

  return {
    update,
    boardArea,
    destroy() {
      for (const off of listeners.splice(0)) off();
      actions.pointOrder(-1);
      setBoardLook(null);
      resultModal.destroy();
      root.remove();
      delete doc.documentElement.dataset.d2Hud;
      doc.documentElement.style.removeProperty("--d2-notice-top");
    },
  };
}
