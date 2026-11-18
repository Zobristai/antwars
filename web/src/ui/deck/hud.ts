// Score Band is the shared spectator HUD for both board renderers and every match mode.
// Desktop: comparison above colony rows. Phone: board first, then clock/map, colony cards and comparison.
// Existing controls, selection, history and the result modal stay attached to the displayed playback frame.
// Match metadata is separate from the single-line connection state; neither loses information to fit.
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
import { COLONY_INK, h, setAttr, setColonyText, setHidden, setText } from "../dom.ts";
import { INSPIRED_BY_URL, PAGE_COPY } from "../../story.ts";
import { ZOOM_STEP } from "../../camera.ts";
import { D2_COPY, OVERVIEW_LABEL } from "../hud.ts";
import { D1_ICON } from "./icons.ts";
import { ICON } from "../icons.ts";
import { LOG_EXPLAINER, VISUAL_KEY, keyText } from "../../overlays.ts";
import { logExplainer } from "../../../rules.ts";
import { boardRules } from "../hud-model.ts";
import { mountDeck } from "./deck.ts";
import { deckBrand } from "./brand.ts";
import { mountTeams } from "./pane.ts";
import { mountAgentDialog } from "./dialog.ts";
import { caption, colonyCount, legend, type Caption, type Legend } from "./model.ts";

/** Below this width Bring your agent has no room beside the wordmark and the pages, and stands at the deck's end. */
const BUTTON_IN_BAR = "(min-width: 520px)";
/** From this width aligned colony rows fit; narrower, the stacked deck follows the board. */
const DECK_FIRST = "(min-width: 1100px)";

export function mountDeckHud(context: HudHost): Mounted<HudView> {
  const { doc, host, tips, replay, teamView, actions } = context;
  const win = doc.defaultView!;
  const search = () => win.location.search;
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: (e: Event) => void) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const root = h(doc, "div", "d1 d1-hud score-band");

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
  legendEl.append(dot, mode, rest);
  // Match metadata is separate from the single-line connection state, so neither is truncated on a phone.
  const metadata = h(doc, "div", "sb-metadata");
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
  frameEl.append(legendEl, metadata, hole, lane);

  // ---------------------------------------------------------------- the deck, its end and the footer
  // One band followed by aligned colony rows; on phones comparison moves after the cards.
  const below = h(doc, "div", "d1-below");
  const deckEl = h(doc, "section", "d1-deck");
  deckEl.setAttribute("aria-label", "Match");
  const deck = mountDeck(doc);
  const teams = mountTeams(doc, actions, { search, economy: deck.economy });
  const band = h(doc, "div", "sb-band");
  band.append(deck.header, deck.score);
  deckEl.append(band, deck.columns, ...teams.teams);
  const deckEnd = h(doc, "div", "d1-deck-end");
  const foot = h(doc, "footer", "d1-foot");
  const rules = h(doc, "a", "d2-link", "Rules");
  rules.href = "/rules"; rules.target = "_blank"; rules.rel = "noopener";
  const inspired = h(doc, "a", "d2-link", "Inspired by @LambethEthan");
  inspired.href = INSPIRED_BY_URL; inspired.target = "_blank"; inspired.rel = "noopener noreferrer";
  const rulesKey = h(doc, "span", "sb-rules-key"), keyToggle = h(doc, "button", "d2-link sb-key-toggle");
  keyToggle.type = "button"; keyToggle.title = "Key";
  keyToggle.setAttribute("aria-label", "Key");
  keyToggle.setAttribute("aria-expanded", "false");
  keyToggle.setAttribute("aria-controls", "score-band-key");
  const keyIcon = h(doc, "span"); keyIcon.setAttribute("aria-hidden", "true"); keyIcon.innerHTML = ICON.info;
  keyToggle.append(keyIcon, "Key");
  const key = h(doc, "div", "sb-key"); key.id = "score-band-key"; key.hidden = true;
  const keyLine = h(doc, "p", undefined, keyText(VISUAL_KEY)), explainer = h(doc, "p", undefined, LOG_EXPLAINER);
  key.append(keyLine, explainer);
  listen(keyToggle, "click", () => {
    key.hidden = !key.hidden;
    setAttr(keyToggle, "aria-expanded", String(!key.hidden));
  });
  rulesKey.append(rules, keyToggle);
  foot.append(rulesKey, inspired, teams.offer, h(doc, "span", "d2-credit d1-foot-credit", PAGE_COPY.credit), key);
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

  // From 1100 px wide the deck stands over the board and the footer closes the page; narrower, the board comes first and
  // the deck, its end and the footer scroll beneath it. The nodes move, not only their boxes, so reading and focus order
  // follow what is seen.
  const deckFirst = typeof win.matchMedia === "function" ? win.matchMedia(DECK_FIRST) : null;
  let placed = false;
  const placeDeck = () => {
    const focused = doc.activeElement as HTMLElement | null;
    if (deckFirst === null || deckFirst.matches) {
      band.append(deck.score);
      top.after(below, frameEl, foot);
    } else {
      deckEl.append(deck.score);
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
  /** Keep connection state intact; other mode facts retain individual, unbroken metadata cells. */
  const paintLegend = (l: Legend, four: boolean) => {
    const keyNow = `${four}|${l.dot}|${l.rule}|${l.words.join("|")}|${l.back?.text ?? ""}|${l.back ? keep(l.back.href, search()) : ""}`;
    if (keyNow === legendKey) return;
    legendKey = keyNow;
    frameEl.dataset.rule = l.rule;
    if (legendEl.classList.contains("is-four") !== four) legendEl.classList.toggle("is-four", four);
    setHidden(dot, l.dot === null);
    dot.dataset.kind = l.dot ?? "";
    setText(mode, l.words[0] ?? "");
    const isState = (word: string) => /waiting for new data|connect/i.test(word);
    const state = l.words.slice(1).filter(isState);
    setText(rest, state.length ? `\u00a0· ${state.join(" · ")}` : "");
    metadata.replaceChildren(...l.words.slice(1).filter(word => !isState(word)).map(word => h(doc, "span", "sb-meta-item", word)), back);
    setHidden(metadata, metadata.childElementCount === 1 && l.back === null);
    setHidden(back, l.back === null);
    if (l.back) { setText(back, l.back.text); setAttr(back, "href", keep(l.back.href, search())); }
  };

  /** Nothing painted yet, so the first frame always writes the lane. */
  let captionKey = "\u0000";
  /** drawn: the match's drawn colony names (unrated), each then shown in its colony's colour with its source note. */
  const paintCaption = (c: Caption | null, drawn: readonly string[] | undefined) => {
    const keyNow = c ? JSON.stringify([c, drawn ?? null]) : "";
    if (keyNow === captionKey) return;
    captionKey = keyNow;
    cap.dataset.kind = c?.kind ?? "none";
    setHidden(capBar, c === null);
    if (!c) { setText(capWhat, ""); setText(capWhen, ""); setText(capWho, ""); return; }
    cap.style.setProperty("--d1-side", COLONY_INK[c.colony]!);
    // The fallen colony's id, for its headline colour.
    if (drawn) cap.dataset.colony = String(c.colony);
    else delete cap.dataset.colony;
    setColonyText(doc, capWhat, c.what, drawn);
    setText(capWhen, c.when);
    setColonyText(doc, capWho, c.who, drawn);
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
    const config = b ? boardRules(b) : null;
    setText(explainer, config ? logExplainer(config) : LOG_EXPLAINER);
    paintBoardToggle(view.board);
    paintLegend(legend(b !== null, b ? b.agents.length : null, view.connection, view.mode, view.stalled), b !== null && colonyCount(b.setup) > 2);
    paintCaption(caption(frame), frame?.board?.setup.colonyNames);
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
  let deckH = -1;
  let metadataH = -1;
  let footerH = -1;
  let refit = 0;
  const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    const next = legendEl.offsetHeight;
    const nextDeck = deckEl.offsetHeight, nextMetadata = metadata.offsetHeight, nextFooter = foot.offsetHeight;
    if (legendH >= 0 && (next !== legendH || nextDeck !== deckH || nextMetadata !== metadataH || nextFooter !== footerH) && !refit) refit = win.requestAnimationFrame(() => { refit = 0; win.dispatchEvent(new Event("resize")); });
    legendH = next; deckH = nextDeck; metadataH = nextMetadata; footerH = nextFooter;
  });
  watch?.observe(legendEl);
  watch?.observe(deckEl);
  watch?.observe(metadata);
  watch?.observe(foot);
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
