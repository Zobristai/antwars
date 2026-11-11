// The 3D board's spectator HUD: the Instrument deck, a hybrid of two earlier designs
// (ported).
//
// One deck holds every figure: the shared score in the middle and each colony's team container at its side.
// The board keeps one fixed window inside a frame whose top rule carries the stream's state ,
// with a lane under the window for the one event and the board controls, so nothing covers the board. From 760 px wide
// the deck stands over the board; narrower, the board comes first and the deck scrolls beneath it.
// A top bar holds the wordmark, the pages and one Bring your agent button; a footer closes the page with Rules and the
// inspiration. Every change is a cut.
// It is given the page's mode line and playback stall through the shared view, and the board's tooltips,
// point-of-view choice and, on an explicit replay, its playback controls (the lane beside the board controls).
//
// Overlay exports are read only inside functions: overlays.ts imports this module.
import "./deck.css";
import { textIcon } from "../../icons/dom.ts";
import type { HudHost, HudView, Mounted } from "../types.ts";
import type { Rect } from "../../words.ts";
import { setBoardLook } from "../../board-look.ts";
import { STEPPE_LOOK } from "../steppe-look.ts";
import { navigation } from "../nav.ts";
import { boardHref, keep } from "../format.ts";
import { h, setAttr, setHidden, setText } from "../dom.ts";
import { INSPIRED_BY_URL, PAGE_COPY } from "../../story.ts";
import { ZOOM_STEP } from "../../camera.ts";
import { D2_COPY, OVERVIEW_LABEL } from "../hud.ts";
import { D1_ICON } from "./icons.ts";
import { mountDeck } from "./deck.ts";
import { deckBrand } from "./brand.ts";
import { mountTeams } from "./pane.ts";
import { mountAgentDialog } from "./dialog.ts";
import { caption, legend, type Caption, type Legend } from "./model.ts";

/** Below this width Bring your agent has no room beside the wordmark and the pages, and stands at the deck's end. */
const BUTTON_IN_BAR = "(min-width: 520px)";
/** From this width the deck stands over the board; narrower, the stacked deck is too tall to come before it. */
const DECK_FIRST = "(min-width: 760px)";
const COLONY_CSS = ["var(--aw-c0)", "var(--aw-c1)"] as const;

export function mountDeckHud(context: HudHost): Mounted<HudView> {
  const { doc, host, tips, replay, teamView, actions } = context;
  const win = doc.defaultView!;
  const search = () => win.location.search;
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: (e: Event) => void) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const root = h(doc, "div", "d1 d1-hud");

  // ---------------------------------------------------------------- the top bar
  const top = h(doc, "header", "d1-top");
  const brand = deckBrand(doc);
  const barSlot = h(doc, "div", "d1-top-end");
  top.append(brand, navigation(doc, "watch", search()), barSlot);

  // ---------------------------------------------------------------- the board's frame: the legend, the window, the lane
  const frameEl = h(doc, "section", "d1-frame");
  frameEl.setAttribute("aria-label", "Board");
  const legendEl = h(doc, "p", "d1-legend");
  legendEl.setAttribute("role", "status");
  const dot = h(doc, "span", "d1-dot"), mode = h(doc, "span", "d1-mode"), rest = h(doc, "span", "d1-legend-rest");
  dot.setAttribute("aria-hidden", "true");
  const back = h(doc, "a", "d1-back");
  back.hidden = true;
  legendEl.append(dot, mode, rest, back);
  const hole = h(doc, "div", "d1-window");
  hole.setAttribute("aria-hidden", "true");
  const lane = h(doc, "div", "d1-lane");
  const cap = h(doc, "div", "d1-caption");
  cap.setAttribute("role", "status");
  const capBar = h(doc, "span", "d1-cap-bar"), capWhat = h(doc, "span", "d1-cap-what"), capMeta = h(doc, "span", "d1-cap-meta");
  const capWhen = h(doc, "span", "d1-cap-when"), capWho = h(doc, "span", "d1-cap-who");
  capBar.setAttribute("aria-hidden", "true");
  capMeta.append(capWhen, capWho);
  cap.append(capBar, capWhat, capMeta);
  const controls = h(doc, "div", "d1-controls");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Board controls");
  const control = (label: string, content: string, markup = false) => {
    const b = h(doc, "button", "d1-btn");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    if (markup) b.innerHTML = content; else b.textContent = content;
    return b;
  };
  // The whole board from above where the board can look down on it (3D), else the whole board; −, +; then the 2D link.
  const overview = actions.overview ?? actions.wholeBoard;
  const whole = control(actions.overview ? OVERVIEW_LABEL : PAGE_COPY.wholeBoard, D1_ICON.whole, true);
  const zoomOut = textIcon("zoom-out", control(PAGE_COPY.zoomOut, "−")), zoomIn = textIcon("zoom-in", control(PAGE_COPY.zoomIn, "+"));
  listen(whole, "click", () => overview?.());
  listen(zoomOut, "click", () => actions.zoom?.(1 / ZOOM_STEP));
  listen(zoomIn, "click", () => actions.zoom?.(ZOOM_STEP));
  setHidden(whole, overview === undefined);
  setHidden(zoomOut, actions.zoom === undefined);
  setHidden(zoomIn, actions.zoom === undefined);
  const boardToggle = h(doc, "a", "d1-btn d1-btn-board");
  // An explicit replay's own speed and position controls, with their listeners, stand just before the board
  // controls; on a phone they take their own row above them (deck.css).
  const transport = h(doc, "div", "d1-transport");
  controls.append(whole, zoomOut, zoomIn, boardToggle);
  lane.append(cap, transport, controls);
  frameEl.append(legendEl, hole, lane);

  // ---------------------------------------------------------------- the deck, its end and the footer
  // The shared score first, then each colony's team container: the score in the middle, the teams at its sides.
  const below = h(doc, "div", "d1-below");
  const deckEl = h(doc, "section", "d1-deck");
  deckEl.setAttribute("aria-label", "Match");
  const deck = mountDeck(doc);
  const teams = mountTeams(doc, actions, { search, economy: deck.economy });
  deckEl.append(deck.score, ...teams.teams);
  const deckEnd = h(doc, "div", "d1-deck-end");
  const foot = h(doc, "footer", "d1-foot");
  const rules = h(doc, "a", "d2-link", "Rules");
  rules.href = "/rules"; rules.target = "_blank"; rules.rel = "noopener";
  const inspired = h(doc, "a", "d2-link", "Inspired by @LambethEthan");
  inspired.href = INSPIRED_BY_URL; inspired.target = "_blank"; inspired.rel = "noopener noreferrer";
  foot.append(rules, inspired, teams.offer, h(doc, "span", "d2-credit d1-foot-credit", PAGE_COPY.credit));
  below.append(deckEl, deckEnd, foot);

  // The result is a modal over the whole screen, not part of the score.
  root.append(top, frameEl, below, teams.result);
  host.append(root);
  const agent = mountAgentDialog(doc, root);

  // One Bring your agent button: in the top bar from 520 px wide; narrower, at the deck's end before the footer.
  const wide = typeof win.matchMedia === "function" ? win.matchMedia(BUTTON_IN_BAR) : null;
  const placeButton = () => {
    const slot = wide === null || wide.matches ? barSlot : deckEnd;
    if (agent.button.parentElement !== slot) slot.append(agent.button);
    setHidden(deckEnd, slot !== deckEnd);
  };
  placeButton();
  if (wide) listen(wide, "change", placeButton);

  // From 760 px wide the deck stands over the board and the footer closes the page; narrower, the board comes first and
  // the deck, its end and the footer scroll beneath it. The nodes move, not only their boxes, so reading and focus order
  // follow what is seen.
  const deckFirst = typeof win.matchMedia === "function" ? win.matchMedia(DECK_FIRST) : null;
  let placed = false;
  const placeDeck = () => {
    const focused = doc.activeElement as HTMLElement | null;
    if (deckFirst === null || deckFirst.matches) {
      top.after(below, frameEl, foot);
    } else {
      below.append(foot);
      top.after(frameEl, below);
    }
    // A moved node loses the focus: a viewer who zooms across the width keeps their place.
    if (focused && focused !== doc.activeElement && root.contains(focused)) focused.focus({ preventScroll: true });
    // The board's window moved: fit the board to it again, as after a resize.
    if (placed) win.requestAnimationFrame(() => win.dispatchEvent(new Event("resize")));
    placed = true;
  };
  placeDeck();
  if (deckFirst) listen(deckFirst, "change", placeDeck);

  // The board's own squad and mark tooltips: shown over this view.
  for (const tip of tips) root.append(tip);
  // An explicit replay's speed and position controls (replay-controls.ts), given only there.
  if (replay) transport.append(replay);
  setHidden(transport, replay === null);
  // The board's point-of-view choice (team-view.ts) leads the board controls.
  if (teamView) controls.prepend(teamView);
  // The board look of the chosen combination, dropped when this view unmounts.
  setBoardLook(STEPPE_LOOK);

  // ---------------------------------------------------------------- painting
  let legendKey = "";
  const paintLegend = (l: Legend) => {
    const keyNow = `${l.dot}|${l.rule}|${l.words.join("|")}|${l.back?.text ?? ""}|${l.back ? keep(l.back.href, search()) : ""}`;
    if (keyNow === legendKey) return;
    legendKey = keyNow;
    frameEl.dataset.rule = l.rule;
    setHidden(dot, l.dot === null);
    dot.dataset.kind = l.dot ?? "";
    setText(mode, l.words[0] ?? "");
    // A no-break space opens the rest: its own leading space would be trimmed beside the mode word. Each word after it is
    // held whole with the separator that follows it, so a phone's wrapped legend breaks only after a "·": never inside a
    // word ("2 agents", "26 Oct 2026"), and no line starts with a separator. The legend reads as before, word for word.
    const words = l.words.slice(1);
    rest.replaceChildren(...(words.length === 0 ? [] : ["\u00a0· ", ...words.flatMap((word, at) => {
      const held = h(doc, "span", "d1-legend-word", at < words.length - 1 ? `${word} ·` : word);
      return at === 0 ? [held] : [" ", held];
    })]));
    setHidden(back, l.back === null);
    if (l.back) { setText(back, l.back.text); setAttr(back, "href", keep(l.back.href, search())); }
  };

  /** Nothing painted yet, so the first frame always writes the lane. */
  let captionKey = "\u0000";
  const paintCaption = (c: Caption | null) => {
    const keyNow = c ? JSON.stringify(c) : "";
    if (keyNow === captionKey) return;
    captionKey = keyNow;
    cap.dataset.kind = c?.kind ?? "none";
    setHidden(capBar, c === null);
    if (!c) { setText(capWhat, ""); setText(capWhen, ""); setText(capWho, ""); return; }
    cap.style.setProperty("--d1-side", COLONY_CSS[c.colony]);
    setText(capWhat, c.what);
    setText(capWhen, c.when);
    setText(capWho, c.who);
  };

  let boardKey = "";
  const paintBoardToggle = (board: HudView["board"]) => {
    const keyNow = `${board}|${win.location.href}`;
    if (keyNow === boardKey) return;
    boardKey = keyNow;
    const to = board === "3d" ? "2d" : "3d";
    setText(boardToggle, to === "2d" ? "2D" : "3D");
    boardToggle.href = boardHref(to, win.location.href);
    const label = to === "2d" ? D2_COPY.to2d : "Try the 3D view; 2D stays available if 3D cannot run";
    setAttr(boardToggle, "aria-label", label);
    boardToggle.title = label;
  };

  function update(view: HudView) {
    const frame = view.frame;
    const b = frame?.board ?? null;
    paintBoardToggle(view.board);
    paintLegend(legend(b !== null, b ? b.agents.length : null, view.connection, view.mode, view.stalled));
    paintCaption(caption(frame));
    deck.update(frame);
    teams.update(view, b === null && /connecting/i.test(view.connection));
  }

  /**
   * The board's window, in viewport CSS pixels: the lane and the frame's rule are outside it, and so is the legend set
   * into the rule, so the board is fitted below it and nothing covers the board.
   */
  function boardArea(): Rect {
    const r = hole.getBoundingClientRect();
    const top = Math.max(r.top, legendEl.getBoundingClientRect().bottom);
    if (!(r.width > 0 && r.bottom - top > 0)) return { x0: 0, y0: 0, x1: win.innerWidth, y1: win.innerHeight };
    return { x0: r.left, y0: top, x1: r.right, y1: r.bottom };
  }
  // A legend that wraps to another line (a long recording's on a phone) moves the window's top: fit the board again.
  let legendH = -1;
  let refit = 0;
  const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    const next = legendEl.offsetHeight;
    if (legendH >= 0 && next !== legendH && !refit) refit = win.requestAnimationFrame(() => { refit = 0; win.dispatchEvent(new Event("resize")); });
    legendH = next;
  });
  watch?.observe(legendEl);
  listeners.push(() => { watch?.disconnect(); if (refit) win.cancelAnimationFrame(refit); });

  return {
    update,
    boardArea,
    destroy() {
      for (const off of listeners.splice(0)) off();
      teams.destroy();
      agent.destroy();
      actions.pointOrder(-1);
      setBoardLook(null);
      root.remove();
    },
  };
}
