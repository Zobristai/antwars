// The broadcast HUD: the agent panel taken from the Instrument deck for this combination.
// One dense list of the agents, each with its newest thought or mark, so a glance tells who is doing what;
// choosing an agent opens it in place, with its card's lines and its recent thoughts and marks. Adapted from the
// deck's pane (ui/deck/pane.ts): its model, icons and DOM helpers are imported unchanged; the markup and styles
// (d2.css, "the agents") are this view's. The colonies meet where the rows' edge colour changes, over a gap.
//
// Overlay exports are read only inside functions: overlays.ts imports the HUD, which imports this module.
import type { Frame } from "../buffer.ts";
import { LOG_EXPLAINER, VISUAL_KEY, keyText, type AntInfo } from "../overlays.ts";
import { logExplainer } from "../../rules.ts";
import { OFFER_TEXT } from "../replay.ts";
import type { HudActions } from "./types.ts";
import { agentDetail, agentEntries, boardRules, openAgent, tps, type AgentEntry, type AgentLineModel } from "./hud-model.ts";
import { ICON, crownIcon, markIcon, orderIcon } from "./icons.ts";
import { h, setAttr, setHidden, setMarkup, setText } from "./dom.ts";
import { keep } from "./format.ts";

const COLONY_CSS = ["var(--aw-k0, var(--aw-c0))", "var(--aw-k1, var(--aw-c1))"] as const;

interface Row {
  index: number;
  item: HTMLLIElement;
  button: HTMLButtonElement;
  badge: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  elo: HTMLElement;
  order: HTMLElement;
  idle: HTMLElement;
  latestIcon: HTMLElement;
  latestText: HTMLElement;
  latestWhen: HTMLElement;
  detail: HTMLElement;
  detailLines: HTMLElement;
  history: HTMLOListElement;
  written: string;
  historyKey: string;
}

export interface AgentPanel {
  readonly root: HTMLElement;
  /** Draws the panel from the frame. No board, or no agents, empties it and offers the recording instead. */
  update(frame: Frame | null, selected: AntInfo | null, selectedAgent: number): void;
}

export interface AgentPanelHooks {
  /** The page's query, carried on the recording's link. */
  search(): string;
  /** Lights on the board the order of the agent a row points at; -1 for none. */
  lightOrder(agent: number): void;
}

/** A thought or mark as one short line: a mark's symbol (filled, as on the board), then its words or count. */
function writeLine(icon: HTMLElement, text: HTMLElement, line: AgentLineModel | null, shade: string): void {
  setMarkup(icon, line?.kind === "mark" ? markIcon(line.words ? undefined : line.verb, shade) : "");
  setHidden(icon, line?.kind !== "mark");
  setText(text, line?.text ?? "");
  text.className = `d2-said${line ? ` is-${line.kind}` : ""}${line?.words ? " is-words" : ""}${line && line.kind === "mark" && !line.live ? " is-faded" : ""}`;
}

export function mountAgents(doc: Document, actions: HudActions, hooks: AgentPanelHooks): AgentPanel {
  const root = h(doc, "section", "d2-agents");
  root.setAttribute("aria-labelledby", "d2-agents-title");
  // A head with the count and the key behind one control, then one row per agent.
  const head = h(doc, "div", "d2-agents-head");
  const title = h(doc, "h2", "d2-agents-title", "Agents");
  title.id = "d2-agents-title";
  const keyToggle = h(doc, "button", "d2-key-toggle");
  keyToggle.type = "button";
  keyToggle.setAttribute("aria-expanded", "false");
  keyToggle.setAttribute("aria-controls", "d2-key");
  keyToggle.setAttribute("aria-label", "Key");
  keyToggle.title = "Key";
  keyToggle.innerHTML = ICON.info;
  head.append(title, keyToggle);
  const key = h(doc, "div", "d2-key");
  key.id = "d2-key";
  key.hidden = true;
  const keyLine = h(doc, "p", undefined, keyText(VISUAL_KEY)), explainer = h(doc, "p", undefined, LOG_EXPLAINER);
  key.append(keyLine, explainer);
  keyToggle.addEventListener("click", () => {
    key.hidden = !key.hidden;
    keyToggle.setAttribute("aria-expanded", String(!key.hidden));
  });
  const list = h(doc, "ol", "d2-agent-list");
  list.setAttribute("aria-labelledby", "d2-agents-title");
  // With no agents, or no match, the status line says so; the panel offers the recording alone, once.
  const empty = h(doc, "div", "d2-empty");
  const offer = h(doc, "a", "d2-pill", OFFER_TEXT);
  offer.href = keep("/?replay", hooks.search());
  empty.append(offer);
  empty.hidden = true;
  root.append(head, key, list, empty);

  let rows: Row[] = [];
  let selectedNow = -1;
  let openNow = -1;

  const makeRow = (index: number): Row => {
    const item = h(doc, "li", "d2-agent-item");
    const button = h(doc, "button", "d2-agent");
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    const detailId = `d2-agent-detail-${index}`;
    button.setAttribute("aria-controls", detailId);
    const badge = h(doc, "span", "d2-badge");
    const title = h(doc, "span", "d2-agent-title"), sub = h(doc, "span", "d2-agent-sub");
    const elo = h(doc, "span", "d2-agent-elo"), order = h(doc, "span", "d2-order"), idle = h(doc, "span", "d2-idle");
    idle.innerHTML = ICON.idle;
    const said = h(doc, "span", "d2-agent-said");
    const latestIcon = h(doc, "span", "d2-said-icon"), latestText = h(doc, "span", "d2-said"), latestWhen = h(doc, "span", "d2-said-when");
    said.append(latestIcon, latestText, latestWhen);
    const name = h(doc, "span", "d2-agent-name");
    name.append(title, sub);
    button.append(badge, name, elo, order, idle, said);
    // The row's own label carries all of it; words an icon shows are not read twice.
    for (const el of button.children) el.setAttribute("aria-hidden", "true");
    const detail = h(doc, "div", "d2-agent-detail");
    detail.id = detailId;
    detail.hidden = true;
    const detailLines = h(doc, "p", "d2-agent-lines");
    const history = h(doc, "ol", "d2-history");
    history.setAttribute("aria-label", "Recent thoughts and marks");
    detail.append(detailLines, history);
    item.append(button, detail);
    // Pointing at a row lights its squad and its order's tile; choosing it opens the agent (and selects it on the
    // board), choosing it again closes it. Leaving gives the highlight back to the selected agent.
    button.addEventListener("pointerenter", () => { actions.hover(index); hooks.lightOrder(index); });
    button.addEventListener("pointerleave", () => { actions.hover(selectedNow); hooks.lightOrder(-1); });
    button.addEventListener("click", () => { actions.select(null); actions.selectAgent(openNow === index ? -1 : index); });
    return { index, item, button, badge, title, sub, elo, order, idle, latestIcon, latestText, latestWhen, detail, detailLines, history, written: "", historyKey: "" };
  };

  const writeRow = (row: Row, e: AgentEntry, open: boolean) => {
    const latest = e.latest;
    const written = `${e.shade}|${e.name}|${e.model}|${e.elo}|${e.idle}|${e.order.kind}|${e.order.guard}|${e.order.target}|${e.order.text}|${latest?.line.tick}|${latest?.text}|${latest?.live}|${open}`;
    if (row.written === written) return;
    row.written = written;
    row.item.className = `d2-agent-item c${e.colony}${e.idle ? " is-idle" : ""}${open ? " is-open" : ""}`;
    row.button.setAttribute("aria-expanded", String(open));
    setHidden(row.detail, !open);
    setMarkup(row.badge, e.badge);
    row.badge.dataset.shade = e.shade;
    // The badge is the agent's identity: a name shows only where the stream carries one, else its self-reported model.
    setText(row.title, e.name ?? e.model);
    setText(row.sub, e.name ? e.model : "");
    setText(row.elo, e.elo ?? "");
    setMarkup(row.order, orderIcon(e.order.kind, e.order.guard) + (e.order.target === null ? "" : crownIcon(COLONY_CSS[e.order.target])));
    setAttr(row.order, "title", e.order.text);
    setHidden(row.idle, !e.idle);
    writeLine(row.latestIcon, row.latestText, latest, e.shade);
    setText(row.latestWhen, latest?.when ?? "");
    setAttr(row.button, "aria-label", latest ? `${e.label}. ${latest.reading}` : e.label);
    setAttr(row.button, "title", latest?.reading ?? null);
  };

  const writeDetail = (row: Row, frame: Frame) => {
    const d = agentDetail(frame, row.index);
    if (!d) return;
    setText(row.detailLines, d.lines.join("\n"));
    const shade = row.badge.dataset.shade ?? "currentColor";
    const historyKey = d.history.map(l => `${l.line.tick}|${l.line.markId}|${l.text}|${l.live}`).join("~");
    if (row.historyKey === historyKey) return;
    row.historyKey = historyKey;
    row.history.replaceChildren(...d.history.map(l => {
      const li = h(doc, "li", "d2-history-line");
      // A mark still on the board is a control that shows it there; any other line is text.
      const host = l.kind === "mark" && l.live ? h(doc, "button", "d2-history-button") : h(doc, "span", "d2-history-button");
      if (host instanceof HTMLButtonElement) {
        host.type = "button";
        host.addEventListener("click", () => actions.focusMark(l.line.markId, l.line.tileX, l.line.tileY));
      }
      const icon = h(doc, "span", "d2-said-icon"), text = h(doc, "span", "d2-said"), when = h(doc, "span", "d2-said-when", l.when);
      writeLine(icon, text, l, shade);
      host.append(icon, text, when);
      host.setAttribute("aria-label", l.reading);
      for (const el of host.children) el.setAttribute("aria-hidden", "true");
      li.append(host);
      return li;
    }));
  };

  const updateAgents = (frame: Frame, open: number) => {
    const b = frame.board!;
    const entries = agentEntries(frame).sort((x, y) => x.colony - y.colony || x.index - y.index);
    if (rows.length !== entries.length || rows.some((r, i) => r.index !== entries[i]!.index)) {
      rows = entries.map(e => rows.find(r => r.index === e.index) ?? makeRow(e.index));
      list.replaceChildren(...rows.map(r => r.item));
    }
    entries.forEach((e, i) => {
      const row = rows[i]!;
      writeRow(row, e, open === e.index);
      if (open === e.index) writeDetail(row, frame);
    });
    // The colonies meet where the list's colour changes; no heading repeats what the colour says.
    rows.forEach((r, i) => r.item.classList.toggle("is-first", i > 0 && entries[i]!.colony !== entries[i - 1]!.colony));
    setText(title, entries.length ? `Agents · ${entries.length}` : "Agents");
    const rules = boardRules(b);
    setText(explainer, rules ? logExplainer(rules) : LOG_EXPLAINER);
    // A pick on the board, or a list rebuilt after the stream came back, brings the opened row into view.
    if (open !== openNow && open >= 0) rows.find(r => r.index === open)?.item.scrollIntoView?.({ block: "nearest" });
    openNow = open;
  };

  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && openNow >= 0) { actions.select(null); actions.selectAgent(-1); }
  });

  let lastSecond = -1;
  let lastChat: unknown = null;
  return {
    root,
    update(frame, selected, selectedAgent) {
      selectedNow = selectedAgent;
      const b = frame?.board ?? null;
      const none = !frame || !b || b.agents.length === 0;
      setHidden(empty, !none);
      setHidden(list, none);
      setHidden(head, none);
      if (!frame || !b || b.agents.length === 0) {
        setHidden(key, true);
        keyToggle.setAttribute("aria-expanded", "false");
        // The rows went with the stream or the match; the next list built is a fresh one.
        if (rows.length) { rows = []; list.replaceChildren(); }
        openNow = -1;
        lastSecond = -1;
        lastChat = null;
        return;
      }
      // Rows change at most once a playback second, or when the chat or the choice moves.
      const second = Math.floor(frame.tick / tps(b));
      const open = openAgent(selected, selectedAgent);
      const newest = frame.chat.at(-1) ?? null;
      if (second !== lastSecond || open !== openNow || rows.length !== b.agents.length || newest !== lastChat) {
        lastSecond = second;
        lastChat = newest;
        updateAgents(frame, open);
      }
    },
  };
}
