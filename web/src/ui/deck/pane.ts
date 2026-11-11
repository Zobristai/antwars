// The Instrument deck: a team container at each side of the shared score,
// each holding its colony's state: its name with a small row per agent under it, its economy, and below them
// its game history, full width, every command and major event with its time and the member who acted, and
// for a live viewer arriving mid-match each agent's standing order at arrival. A pick on the board or an agent row
// opens the Selected card in that colony's container in place of its history, its agents and economy kept. The result
// shows as a modal over the whole screen; the page places it and the recording's offer, shown when there are no agents.
//
// Overlay exports are read only inside functions: overlays.ts imports this HUD, which imports this module.
import type { Frame } from "../../buffer.ts";
import type { HudActions, HudView } from "../types.ts";
import type { AgentLineModel } from "../hud-model.ts";
import { tps } from "../hud-model.ts";
import { crownIcon, markIcon, orderIcon } from "../icons.ts";
import { h, setAttr, setHidden, setMarkup, setText } from "../dom.ts";
import { keep } from "../format.ts";
import { OFFER_TEXT } from "../../replay.ts";
import { D1_ICON } from "./icons.ts";
import { mountResultModal } from "./result-modal.ts";
import {
  COLONIES, D1_COPY, NOTHING, PAGE_WORDS, arrival as arrivalOf, arrivalRows, colonyName, history as gameHistory, roster, selected,
  type Arrival, type Colony, type Group, type HistoryGlyph, type HistoryRow, type Member, type Player, type Row, type Selected,
} from "./model.ts";

const COLONY_CSS = ["var(--aw-c0)", "var(--aw-c1)"] as const;

export interface TeamHooks {
  /** The page's query, carried on the recording's link. */
  search(): string;
  /** Each colony's economy (deck.ts), placed under its name. */
  readonly economy: readonly [HTMLElement, HTMLElement];
}
export interface Teams {
  /** Very Large Colony's container and Lake Hodges Colony's, for the deck's sides. */
  readonly teams: readonly [HTMLElement, HTMLElement];
  /** The result's modal dialog, for the page to place over the whole screen. */
  readonly result: HTMLDialogElement;
  /** The recording's offer, for the footer. */
  readonly offer: HTMLElement;
  /** connecting: no frame yet while the stream connects, when there are no rows and no offer. */
  update(view: HudView, connecting: boolean): void;
  destroy(): void;
}

function flag(node: Element, cls: string, on: boolean) {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

/** A thought or mark as one short line: a mark's symbol, filled as on the board, then its words or compact count (Current's writeLine). */
function writeLine(icon: HTMLElement, text: HTMLElement, line: AgentLineModel | null, shade: string): void {
  setMarkup(icon, line?.kind === "mark" ? markIcon(line.words ? undefined : line.verb, shade, 14) : "");
  setHidden(icon, line?.kind !== "mark");
  setText(text, line?.text ?? "");
  const cls = `d1-said${line ? ` is-${line.kind}` : ""}${line?.words ? " is-words" : ""}${line && line.kind === "mark" && !line.live ? " is-faded" : ""}`;
  if (text.className !== cls) text.className = cls;
}

interface RowNode {
  index: number;
  item: HTMLLIElement;
  button: HTMLButtonElement;
  badge: HTMLElement;
  title: HTMLElement;
  tags: HTMLElement;
  model: HTMLElement;
  modelTags: HTMLElement;
  ast: HTMLElement;
  elo: HTMLElement;
  result: HTMLElement;
  /** The rating's "± RD", shown in the tip; "" for none. */
  rd: string;
  written: string;
}

export function mountTeams(doc: Document, actions: HudActions, hooks: TeamHooks): Teams {
  const win = doc.defaultView!;
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: (e: Event) => void) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };

  // ---------------------------------------------------------------- the floating tip: the self-reported asterisk's
  // explanation, and a team member's handle, model and Elo
  const tip = h(doc, "div", "d1-tip");
  tip.id = "d1-ast-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  let tipFor: Element | null = null;
  let tipKey = "";
  const showTip = (target: Element, lines: readonly string[] = [D1_COPY.selfReported]) => {
    tipFor = target;
    const keyNow = lines.join("\n");
    if (keyNow !== tipKey) { tipKey = keyNow; tip.replaceChildren(...lines.map(line => h(doc, "span", "d1-tip-line", line))); }
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth, ht = tip.offsetHeight;
    const x = Math.max(8, Math.min(r.left - 12, win.innerWidth - w - 8));
    const below = r.bottom + 6;
    const y = below + ht <= win.innerHeight - 8 ? below : Math.max(8, r.top - 6 - ht);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };
  const hideTip = () => { tipFor = null; tip.hidden = true; };
  // A finger lifting is not a pointer leaving: a tap keeps the tip until the next tap elsewhere.
  const leaveTip = (e: Event) => {
    const p = e as PointerEvent;
    if (p.pointerType === "touch") return;
    const to = p.relatedTarget as Node | null;
    if (!(to && (tip.contains(to) || tipFor?.contains(to)))) hideTip();
  };
  listen(tip, "pointerleave", leaveTip);
  /**
   * A rating badge's "± RD" in the same tip as the asterisk's: a mouse or pen over it shows it, a tap shows it without
   * opening the row's card, and keyboard focus on the badge (the heading's) or its row (an agent row's) shows it too.
   */
  const rdTip = (badge: HTMLElement, rd: () => string) => {
    listen(badge, "pointerenter", e => { if ((e as PointerEvent).pointerType !== "touch" && rd()) showTip(badge, [rd()]); });
    listen(badge, "pointerleave", leaveTip);
    listen(badge, "click", e => { if (!rd()) return; e.stopPropagation(); showTip(badge, [rd()]); });
  };
  listen(doc, "pointerdown", e => { const at = e.target as Node | null; if (tipFor && !(at && (tip.contains(at) || tipFor.contains(at)))) hideTip(); });

  // ---------------------------------------------------------------- the team containers
  const teamNodes = COLONIES.map(colony => {
    const section = h(doc, "section", `d1-team c${colony}`);
    section.tabIndex = -1;
    const head = h(doc, "header", "d1-team-head");
    const name = h(doc, "h2", `d1-name c${colony}`, colonyName(colony));
    name.id = `d1-team-${colony}`;
    section.setAttribute("aria-labelledby", name.id);
    // One icon per member, then the one player's name, which gives way before its Elo, always shown in full.
    const members = h(doc, "span", "d1-team-members"), player = h(doc, "span", "d1-team-player");
    // The one player's line in the Matches order: its name and model, which give way first, then its level and Fast badges,
    // its rating, its seat count and the colony's result, always shown in full.
    const playerName = h(doc, "span", "d1-team-player-name"), playerTitle = h(doc, "span", "d1-title"), playerModel = h(doc, "span", "d1-model");
    playerName.append(playerTitle, playerModel);
    const playerTags = h(doc, "span", "d1-tags"), playerElo = h(doc, "span", "d1-tag d1-elo");
    const playerSeats = h(doc, "span", "d1-seats"), playerResult = h(doc, "span", `d1-tag d1-result c${colony}`);
    player.append(playerName, playerTags, playerElo, playerSeats, playerResult);
    head.append(name, members, player);
    // The agents: one small row each under the colony name, its badge, name, model and rating; none for one
    // player, whose heading names it once.
    const rows = h(doc, "ol", "d1-agents");
    rows.setAttribute("aria-label", `${colonyName(colony)} agents`);
    // The game history, the whole panel below: every row newest first, in every match; empty, one quiet line of a
    // row's height, which the first row replaces.
    const line = h(doc, "section", "d1-timeline");
    line.setAttribute("aria-label", `${colonyName(colony)} ${D1_COPY.history.toLowerCase()}`);
    const entries = h(doc, "ol", "d1-tl");
    const none = h(doc, "li", "d1-tl-entry d1-tl-none", D1_COPY.timelineNone);
    line.append(h(doc, "h3", "d1-kicker", D1_COPY.history), entries);
    section.append(head, rows, hooks.economy[colony], line);
    // Each row's node by its key, written again only when what it shows changes.
    const lineNodes = new Map<string, { li: HTMLLIElement; written: string }>();
    return { section, members, membersKey: "", player, playerName, playerTitle, playerModel, playerTags, playerElo, playerSeats, playerResult,
      playerRd: "", playerKey: "", rows, line, entries, none, lineNodes };
  });

  for (const team of teamNodes) {
    rdTip(team.playerElo, () => team.playerRd);
    listen(team.playerElo, "focus", () => { if (team.playerRd) showTip(team.playerElo, [team.playerRd]); });
    listen(team.playerElo, "blur", () => { if (tipFor === team.playerElo) hideTip(); });
  }

  // ---------------------------------------------------------------- the rows
  let selectedAgent = -1;
  /** The agent whose order Show target keeps lit, or -1. */
  let targetFor = -1;
  /** A row chosen from the keyboard or the pointer: the card it opens takes the focus. */
  let focusCard = false;
  const light = (agent: number) => actions.pointOrder(agent);
  const rowNodes = new Map<number, RowNode>();
  const makeRow = (index: number): RowNode => {
    const item = h(doc, "li", "d1-agent-item");
    const button = h(doc, "button", "d1-agent");
    button.type = "button";
    const badge = h(doc, "span", "d1-badge");
    const who = h(doc, "span", "d1-who"), title = h(doc, "span", "d1-title"), model = h(doc, "span", "d1-model");
    const titleBox = h(doc, "span", "d1-title-box"), modelBox = h(doc, "span", "d1-model-box");
    // A Benchmark handle's badges as one unit beside its name, never split or shrunk (the Leaderboard's d1p-tags).
    const tags = h(doc, "span", "d1-tags");
    // The self-reported asterisk follows the model it marks, its explanation the same tip: a pointer
    // over it shows it, a tap shows it without opening the card; never a stop for the keyboard,
    // the row's own name says "self-reported".
    const ast = h(doc, "span", "d1-ast-mark", "*");
    titleBox.append(title);
    // The model's own level and tier badges after it, in the same badge style.
    const modelTags = h(doc, "span", "d1-tags");
    modelBox.append(model, modelTags);
    // The Matches order: name, model, level and Fast badges, the asterisk after a self-reported model, the rating as the
    // cyan badge (the figure, its "± RD" in the tip), then the colony's result once the match has ended.
    const elo = h(doc, "span", "d1-tag d1-elo"), result = h(doc, "span", "d1-tag d1-result");
    who.append(titleBox, modelBox, tags, ast, elo, result);
    button.append(badge, who);
    for (const child of button.children) child.setAttribute("aria-hidden", "true");
    item.append(button);
    listen(ast, "pointerenter", () => showTip(ast));
    listen(ast, "click", e => { e.stopPropagation(); showTip(ast); });
    listen(ast, "pointerleave", leaveTip);
    rdTip(elo, () => node.rd);
    // Pointing at a row, or focusing it, lights its squad and its order's tile; choosing it opens its card.
    const point = () => { actions.hover(index); light(index); };
    const leave = () => { actions.hover(selectedAgent); light(targetFor); };
    listen(button, "pointerenter", point);
    listen(button, "pointerleave", leave);
    listen(button, "focus", () => { point(); if (node.rd && button.matches(":focus-visible")) showTip(elo, [node.rd]); });
    listen(button, "blur", () => { leave(); if (tipFor === elo) hideTip(); });
    listen(button, "click", () => { focusCard = true; actions.select(null); actions.selectAgent(index); });
    const node: RowNode = { index, item, button, badge, title, tags, model, modelTags, ast, elo, result, rd: "", written: "" };
    return node;
  };

  const writeRow = (node: RowNode, row: Row) => {
    const isSelected = row.index === selectedAgent;
    const written = [row.shade, row.title, row.badges.join(" "), row.model, row.modelBadges.join(" "), row.asterisk, row.elo, row.rd, row.result, row.label, isSelected].join("|");
    if (node.written === written) return;
    node.written = written;
    node.item.className = `d1-agent-item c${row.colony}${isSelected ? " is-selected" : ""}`;
    setAttr(node.button, "aria-current", isSelected ? "true" : null);
    setMarkup(node.badge, row.badge);
    setText(node.title, row.title);
    // Provider text is set as text, never markup.
    node.tags.replaceChildren(...row.badges.map(text => h(doc, "span", "d1-tag", text)));
    setHidden(node.tags, row.badges.length === 0);
    setText(node.model, row.model);
    node.modelTags.replaceChildren(...row.modelBadges.map(text => h(doc, "span", "d1-tag", text)));
    setHidden(node.modelTags, row.modelBadges.length === 0);
    setHidden(node.model.parentElement!, row.model === "");
    setHidden(node.ast, !row.asterisk);
    if (!row.asterisk && tipFor === node.ast) hideTip();
    setText(node.elo, row.elo ?? "");
    setHidden(node.elo, row.elo === null);
    node.rd = row.elo === null ? "" : row.rd;
    if (tipFor === node.elo && !node.rd) hideTip();
    setAttr(node.elo, "data-rd", node.rd === "" ? null : "");
    setText(node.result, row.result ?? "");
    setHidden(node.result, row.result === null);
    node.result.className = `d1-tag d1-result c${row.colony}`;
    setAttr(node.button, "aria-label", row.label);
  };

  /**
   * A colony's member icons: each a labelled image, never a stop for the keyboard, whose
   * tip a pointer shows while over it and a tap shows until the next tap elsewhere.
   */
  const writeMembers = (team: (typeof teamNodes)[number], members: readonly Member[]) => {
    const keyNow = members.map(m => `${m.badge}|${m.lines.join("\n")}|${m.label}`).join("~");
    if (keyNow === team.membersKey) return;
    team.membersKey = keyNow;
    if (tipFor && team.members.contains(tipFor)) hideTip();
    team.members.replaceChildren(...members.map(m => {
      const icon = h(doc, "span", "d1-member");
      icon.setAttribute("role", "img");
      icon.setAttribute("aria-label", m.label);
      icon.innerHTML = m.badge;
      for (const type of ["pointerenter", "click"]) icon.addEventListener(type, () => showTip(icon, m.lines));
      icon.addEventListener("pointerleave", leaveTip);
      return icon;
    }));
  };

  /** The one player's line in its colony's head, in the Matches order; none hides it. */
  const writePlayer = (team: (typeof teamNodes)[number], p: Player | null) => {
    const key = p === null ? "" : JSON.stringify(p);
    if (key === team.playerKey) return;
    team.playerKey = key;
    setHidden(team.player, p === null);
    team.playerRd = p?.rd ?? "";
    if (tipFor === team.playerElo && !team.playerRd) hideTip();
    if (p === null) return;
    setText(team.playerTitle, p.name);
    setText(team.playerModel, p.model);
    setHidden(team.playerModel, p.model === "");
    team.playerName.title = [p.name, p.model].filter(Boolean).join(" ");
    team.playerTags.replaceChildren(...p.badges.map(text => h(doc, "span", "d1-tag", text)));
    setHidden(team.playerTags, p.badges.length === 0);
    setText(team.playerElo, p.elo);
    // With an RD the badge is the heading's one stop for it: focus shows its "± RD" as a pointer or a tap does.
    team.playerElo.tabIndex = p.rd ? 0 : -1;
    setAttr(team.playerElo, "aria-label", `Rating ${p.elo}${p.rd ? ` ${p.rd}` : ""}`);
    setAttr(team.playerElo, "data-rd", p.rd === "" ? null : "");
    setText(team.playerSeats, p.seats > 1 ? `×${p.seats}` : "");
    setAttr(team.playerSeats, "aria-label", p.seats > 1 ? `${p.seats} seats` : null);
    setHidden(team.playerSeats, p.seats < 2);
    setText(team.playerResult, p.result ?? "");
    setHidden(team.playerResult, p.result === null);
  };

  /** Each colony's small agent rows under its own head, its member icons and any one player beside its name; one player or an empty colony shows no rows. */
  const writeGroups = (groups: readonly Group[]) => {
    for (const colony of COLONIES) {
      const g = groups.find(group => group.colony === colony);
      const team = teamNodes[colony]!;
      const n = g?.rows.length ?? 0;
      writeMembers(team, g?.members ?? []);
      writePlayer(team, g?.player ?? null);
      setHidden(team.rows, n === 0);
      if (!g) { team.rows.replaceChildren(); continue; }
      const items = g.rows.map(row => {
        let node = rowNodes.get(row.index);
        if (!node) { node = makeRow(row.index); rowNodes.set(row.index, node); }
        writeRow(node, row);
        return node.item;
      });
      if (items.length !== team.rows.childElementCount || items.some((item, i) => team.rows.children[i] !== item)) team.rows.replaceChildren(...items);
    }
    if (tipFor && !tipFor.isConnected) hideTip();
  };

  const glyphMarkup = (glyph: HistoryGlyph, colony: Colony, shade: string): string => {
    switch (glyph?.kind) {
      case "order": return orderIcon(glyph.order, glyph.guard, 13);
      case "mark": return markIcon(glyph.verb, shade, 13);
      case "queen": return crownIcon(COLONY_CSS[colony], 13);
      default: return "";
    }
  };
  /**
   * A history row: its time, the badge of the member who acted, its symbol, its words, an order's intent, refused; an
   * arrival row no time, "On arrival" before its standing order, then its newest live mark.
   */
  const writeHistoryRow = (li: HTMLLIElement, row: HistoryRow, colony: Colony) => {
    li.className = `d1-tl-entry d1-log${row.refused ? " is-refused" : ""}${row.arrival ? " is-arrival" : ""}`;
    li.setAttribute("aria-label", row.reading);
    const who = h(doc, "span", "d1-log-who");
    if (row.member) setMarkup(who, row.member.badge);
    const icon = h(doc, "span", "d1-log-icon");
    setMarkup(icon, glyphMarkup(row.glyph, colony, row.member?.shade ?? COLONY_CSS[colony]));
    const what = h(doc, "span", "d1-tl-what");
    // An arrival row says so before its order, its time column left blank: it is a state, not a timed event.
    if (row.arrival) what.append(h(doc, "span", "d1-log-lead", D1_COPY.onArrival));
    what.append(h(doc, "span", "d1-log-text", row.what));
    if (row.intent) what.append(h(doc, "span", "d1-log-intent", row.intent));
    if (row.mark) {
      const mark = h(doc, "span", "d1-log-mark");
      const markSymbol = h(doc, "span", "d1-log-icon");
      setMarkup(markSymbol, markIcon(row.mark.verb, row.member?.shade ?? COLONY_CSS[colony], 13));
      mark.append(h(doc, "span", "d1-log-mark-word", D1_COPY.arrivalMark), markSymbol, h(doc, "span", "d1-log-text", row.mark.text));
      what.append(mark);
    }
    const parts: HTMLElement[] = [h(doc, "span", "d1-when", row.when), who, icon, what];
    if (row.refused) parts.push(h(doc, "span", "d1-log-refused", D1_COPY.refused));
    for (const part of parts) part.setAttribute("aria-hidden", "true");
    li.replaceChildren(...parts);
  };

  /** A colony's game history, keyed: a row is made once, written again only when its words change, and moved in place. */
  const writeHistory = (colony: Colony, rows: readonly HistoryRow[]) => {
    const team = teamNodes[colony]!;
    const list = team.entries;
    if (rows.length === 0) {
      team.lineNodes.clear();
      if (list.childElementCount !== 1 || list.firstElementChild !== team.none) list.replaceChildren(team.none);
      return;
    }
    const keep = new Set<string>();
    const items = rows.map(row => {
      keep.add(row.key);
      let node = team.lineNodes.get(row.key);
      if (!node) { node = { li: h(doc, "li", "d1-tl-entry"), written: "" }; team.lineNodes.set(row.key, node); }
      const written = `${row.when}|${row.what}|${row.intent}|${row.refused}|${row.arrival}|${row.mark?.verb ?? ""}|${row.mark?.text ?? ""}|${row.member?.badge ?? ""}|${row.reading}`;
      if (node.written !== written) { node.written = written; writeHistoryRow(node.li, row, colony); }
      return node.li;
    });
    for (const key of [...team.lineNodes.keys()]) if (!keep.has(key)) team.lineNodes.delete(key);
    // New rows arrive at the top: insert only what is out of place, then drop what is left.
    let at = list.firstElementChild;
    for (const item of items) {
      if (item === at) at = at.nextElementSibling;
      else list.insertBefore(item, at);
    }
    while (at) { const next = at.nextElementSibling; at.remove(); at = next; }
  };

  // ---------------------------------------------------------------- Selected: the card for whatever was picked
  const selectedEl = h(doc, "section", "d1-selected");
  selectedEl.setAttribute("aria-label", D1_COPY.selected);
  selectedEl.tabIndex = -1;
  selectedEl.hidden = true;
  const card = h(doc, "div", "d1-sel");
  const cardHead = h(doc, "div", "d1-sel-head");
  const cardBadge = h(doc, "span", "d1-badge");
  cardBadge.setAttribute("aria-hidden", "true");
  const names = h(doc, "div", "d1-sel-names");
  const cardTitle = h(doc, "p", "d1-sel-title"), cardName = h(doc, "span", "d1-sel-name"), cardModel = h(doc, "span", "d1-model"), cardAst = h(doc, "span", "d1-ast-mark", "*");
  const cardAstSr = h(doc, "span", "d1-sr", ", self-reported");
  // The model's level and tier badges, after the model (or after the name where the model is the name).
  const cardTags = h(doc, "span", "d1-tags");
  cardTitle.append(cardName, cardModel, cardTags, cardAst, cardAstSr);
  cardAst.setAttribute("aria-hidden", "true");
  const cardSub = h(doc, "p", "d1-sel-sub");
  names.append(cardTitle, cardSub);
  const close = h(doc, "button", "d1-close");
  close.type = "button";
  close.setAttribute("aria-label", PAGE_WORDS.close);
  close.innerHTML = D1_ICON.close;
  cardHead.append(cardBadge, names, close);
  const orderRow = h(doc, "div", "d1-sel-order");
  const orderLine = h(doc, "p", "d1-sel-line");
  const showTarget = h(doc, "button", "d1-chip", D1_COPY.showTarget);
  showTarget.type = "button";
  showTarget.setAttribute("aria-pressed", "false");
  orderRow.append(orderLine, showTarget);
  const cardLines = h(doc, "div", "d1-sel-lines");
  const recent = h(doc, "div", "d1-sel-recent");
  const historyHead = h(doc, "h3", "d1-kicker", PAGE_WORDS.recent);
  const history = h(doc, "ol", "d1-history");
  recent.append(historyHead, history);
  card.append(cardHead, orderRow, cardLines, recent);
  const antCard = h(doc, "div", "d1-sel d1-sel-ant");
  const antHead = h(doc, "div", "d1-sel-head");
  const antTitle = h(doc, "p", "d1-sel-title"), antLine = h(doc, "p", "d1-sel-sub");
  const antNames = h(doc, "div", "d1-sel-names");
  antNames.append(antTitle, antLine);
  const antClose = h(doc, "button", "d1-close");
  antClose.type = "button";
  antClose.setAttribute("aria-label", PAGE_WORDS.close);
  antClose.innerHTML = D1_ICON.close;
  antHead.append(antNames, antClose);
  antCard.append(antHead);
  selectedEl.append(card, antCard);

  let current: Selected = NOTHING;
  const closeSelection = () => {
    const was = selectedAgent;
    const home = current.kind === "none" ? null : teamNodes[current.colony]!.section;
    actions.select(null);
    actions.selectAgent(-1);
    if (targetFor >= 0) { targetFor = -1; light(-1); }
    // The card goes at once, so the focus never stays in it: back to the row it came from, else to its colony.
    place(NOTHING);
    const row = rowNodes.get(was);
    if (row && row.item.isConnected) row.button.focus(); else home?.focus();
  };
  listen(close, "click", closeSelection);
  listen(antClose, "click", closeSelection);
  listen(selectedEl, "keydown", e => { if ((e as KeyboardEvent).key === "Escape" && current.kind !== "none") { e.preventDefault(); closeSelection(); } });
  listen(showTarget, "click", () => {
    if (current.kind !== "agent") return;
    targetFor = targetFor === current.index ? -1 : current.index;
    setAttr(showTarget, "aria-pressed", String(targetFor >= 0));
    light(targetFor);
  });

  /** The card in its colony's container, in place of its history, its agent rows kept; nothing picked, no card. */
  const place = (sel: Selected) => {
    current = sel;
    for (const colony of COLONIES) flag(teamNodes[colony]!.section, "is-picked", sel.kind !== "none" && sel.colony === colony);
    if (sel.kind === "none") { selectedEl.hidden = true; return; }
    const home = teamNodes[sel.colony]!.section;
    if (selectedEl.parentElement !== home) home.append(selectedEl);
    selectedEl.hidden = false;
  };

  let cardKey = "";
  let historyKey = "";
  const writeSelected = (sel: Selected) => {
    place(sel);
    setHidden(card, sel.kind !== "agent");
    setHidden(antCard, sel.kind !== "ant");
    if (sel.kind === "ant") {
      setText(antTitle, sel.title);
      setText(antLine, sel.line);
      antCard.style.setProperty("--d1-side", COLONY_CSS[sel.colony]);
      return;
    }
    if (sel.kind !== "agent") return;
    const keyNow = [sel.key, sel.title, sel.model, sel.badges.join(" "), sel.asterisk, sel.sub, sel.order, sel.target, sel.lines.join("\n")].join("|");
    if (keyNow !== cardKey) {
      cardKey = keyNow;
      card.style.setProperty("--d1-side", COLONY_CSS[sel.colony]);
      setMarkup(cardBadge, sel.badge);
      setText(cardName, sel.title);
      setText(cardModel, sel.model);
      setHidden(cardModel, sel.model === "");
      cardTags.replaceChildren(...sel.badges.map(text => h(doc, "span", "d1-tag", text)));
      setHidden(cardTags, sel.badges.length === 0);
      setHidden(cardAst, !sel.asterisk);
      setHidden(cardAstSr, !sel.asterisk);
      setText(cardSub, sel.sub);
      setHidden(cardSub, sel.sub === "");
      setText(orderLine, sel.order);
      setHidden(showTarget, !sel.target);
      cardLines.replaceChildren(...sel.lines.map(line => h(doc, "p", "d1-sel-line", line)));
    }
    setAttr(showTarget, "aria-pressed", String(targetFor === sel.index));
    const hKey = sel.history.map(l => `${l.line.tick}|${l.line.markId}|${l.text}|${l.live}`).join("~") + sel.shade;
    if (hKey === historyKey) return;
    historyKey = hKey;
    setHidden(recent, sel.history.length === 0);
    history.replaceChildren(...sel.history.map(l => {
      const li = h(doc, "li", "d1-history-line");
      li.setAttribute("aria-label", l.reading);
      const when = h(doc, "span", "d1-when", l.when), icon = h(doc, "span", "d1-said-icon"), text = h(doc, "span", "d1-said");
      writeLine(icon, text, l, sel.shade);
      for (const part of [when, icon, text]) part.setAttribute("aria-hidden", "true");
      li.append(when, icon, text);
      if (l.kind === "mark" && l.live) {
        const go = h(doc, "button", "d1-chip", D1_COPY.showOnBoard);
        go.type = "button";
        go.setAttribute("aria-label", `${D1_COPY.showOnBoard}: ${l.reading}`);
        go.addEventListener("click", () => actions.focusMark(l.line.markId, l.line.tileX, l.line.tileY));
        li.append(go);
      } else if (l.kind === "mark") {
        const gone = h(doc, "span", "d1-gone", D1_COPY.noLonger);
        gone.setAttribute("aria-hidden", "true");
        li.append(gone);
      }
      return li;
    }));
  };

  // ---------------------------------------------------------------- Result: a modal over the whole screen
  // Shared with the 2D board (result-modal.ts); once closed it stays closed for that match's end.
  const resultModal = mountResultModal(doc);

  // Escape closes the asterisk's explanation.
  listen(doc, "keydown", e => { if ((e as KeyboardEvent).key === "Escape" && !tip.hidden) hideTip(); });

  // ---------------------------------------------------------------- the offer, for the page to place
  const offer = h(doc, "a", "d2-pill d1-offer", OFFER_TEXT);
  offer.hidden = true;
  // The tooltip floats over the page, so it sits beside the containers rather than inside one.
  teamNodes[0]!.section.append(tip);

  // ---------------------------------------------------------------- update
  let lastSecond = -1;
  let lastChat: unknown = null;
  let lastSubject = "";
  let lastCount = -1;
  let lastSelection = "";
  let lastResult: unknown = null;
  let lastStory = -1;
  let lastCommands: unknown = null;
  /** What each agent stood on when this viewer arrived at the match shown; kept through a reconnect to it. */
  let arrived: Arrival | null = null;
  let lastSeed: readonly HistoryRow[] = [];
  return {
    teams: [teamNodes[0]!.section, teamNodes[1]!.section],
    result: resultModal.dialog,
    offer,
    update(view, connecting) {
      const frame: Frame | null = view.frame;
      const b = frame?.board ?? null;
      selectedAgent = view.selectedAgent;
      const none = !frame || !b || b.agents.length === 0;
      // With no agents, or no match, the footer holds the recording's offer, once; while connecting, nothing yet.
      setHidden(offer, !none || connecting);
      const href = keep("/?replay", hooks.search());
      if (offer.getAttribute("href") !== href) offer.href = href;
      if (none) {
        if (rowNodes.size) rowNodes.clear();
        writeGroups([]);
        lastSecond = -1; lastChat = null; lastCount = -1;
      } else {
        // Rows change at most once a playback second, or when the chat, the count, the choice or the result moves.
        const second = Math.floor(frame!.tick / tps(b!));
        const newest = frame!.chat.at(-1) ?? null;
        const selection = `${view.selectedAgent}|${view.selected?.antId ?? -1}`;
        if (second !== lastSecond || newest !== lastChat || b!.agents.length !== lastCount || selection !== lastSelection || b!.result !== lastResult) {
          lastSecond = second; lastChat = newest; lastCount = b!.agents.length; lastSelection = selection; lastResult = b!.result;
          // An asterisk's explanation goes with its asterisk (writeRow); a member's tip stays while its icon does.
          writeGroups(roster(frame!).groups);
          lastStory = -1;
        }
      }
      // The history moves with the rows' second, or when playback reaches a new entry or command.
      const stories = frame?.story.length ?? 0;
      const commands = frame?.commands ?? null;
      arrived = arrivalOf(arrived, frame);
      const seed = arrivalRows(arrived, view.mode);
      if (stories !== lastStory || commands !== lastCommands || seed !== lastSeed || none) {
        lastStory = stories;
        lastCommands = commands;
        lastSeed = seed;
        for (const colony of COLONIES) writeHistory(colony, gameHistory(frame, colony, seed));
      }
      const sel = selected(frame, view.selected, view.selectedAgent);
      if (sel.kind !== "agent" || sel.index !== targetFor) { if (targetFor >= 0) { targetFor = -1; light(-1); } }
      writeSelected(sel);
      // A row chosen opens its card with the focus in it; a pick on the board leaves the focus where it is.
      const subject = sel.kind === "none" ? "" : sel.key;
      if (subject !== lastSubject) {
        lastSubject = subject;
        if (subject !== "" && focusCard) selectedEl.focus();
        focusCard = false;
      }
      resultModal.update(frame, view.share ?? null);
    },
    destroy() {
      for (const off of listeners.splice(0)) off();
      if (targetFor >= 0) light(-1);
      tip.remove();
      resultModal.destroy();
    },
  };
}
