// The Instrument deck: the shared score in the deck's middle, and each colony's economy for its team
// container at its side, left and right. The score holds the clock, Balance (Kills, Territory, Ants) and Win conditions (a bar per
// queen, a territory hold), each row mirrored about its label with Very Large Colony at the left.
// Reading order follows the figures: each row's label first, then each colony's figure with its colony's name.
import type { Frame } from "../../buffer.ts";
import { h, setAttr, setHidden, setMarkup, setText } from "../dom.ts";
import { D1_ICON, RING } from "./icons.ts";
import {
  COLONIES, D1_COPY, PAGE_WORDS, balance, clock, colonyName, dials, mapName, resultShown, winConditions,
  type Colony, type Dial, type Gauge, type Lamp, type NextAntView,
} from "./model.ts";
import { SCORE_COPY } from "../../story.ts";

/** Every colony-named screen-reader text in the deck, rewritten when the match's colony names change. */
type SaidName = { readonly node: HTMLElement; readonly colony: Colony; readonly after: string };

/** A figure with its colony's name for a screen reader, which hears it without its column. */
function figure(doc: Document, colony: Colony, cls: string, named: SaidName[], after = " ") {
  const node = h(doc, "span", `${cls} c${colony}`);
  const value = h(doc, "span");
  const said = h(doc, "span", "d1-sr", `${colonyName(colony)}${after}`);
  named.push({ node: said, colony, after });
  node.append(said, value);
  return { node, value };
}

/** A half-track filled from its colony's own end; the 6:1 line dotted where the rules give one. */
function track(doc: Document, colony: Colony) {
  const node = h(doc, "span", `d1-track c${colony}`);
  node.setAttribute("aria-hidden", "true");
  const fill = h(doc, "span", "d1-fill"), lead = h(doc, "span", "d1-lead");
  node.append(fill, lead);
  return { node, fill, lead };
}

function setWidth(node: HTMLElement, value: string) {
  if (node.style.getPropertyValue("width") !== value) node.style.setProperty("width", value);
}
function setVar(node: HTMLElement, name: string, value: string) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}
function flag(node: Element, cls: string, on: boolean) {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}
/** Set a ring's fill, 0..1, in hundredths of its circumference. */
function setRing(ring: SVGCircleElement | null, fill: number) {
  if (ring) setAttr(ring, "stroke-dasharray", `${(100 * fill).toFixed(1)} 100`);
}

export interface Deck {
  /** The shared score: the clock, Balance and Win conditions; at the match's end Win conditions give way (is-ended), the result a modal (pane.ts). */
  readonly score: HTMLElement;
  /** Each colony's economy, for its team container. */
  readonly economy: readonly [HTMLElement, HTMLElement];
  update(frame: Frame | null): void;
}

export function mountDeck(doc: Document): Deck {
  const score = h(doc, "section", "d1-score");
  score.setAttribute("aria-label", "Score");
  const clockEl = h(doc, "p", "d1-clock");
  const named: SaidName[] = [];

  // ---------------------------------------------------------------- Balance and Win conditions
  const gauge = (label: string) => {
    const row = h(doc, "div", "d1-gauge");
    const figs = COLONIES.map(c => figure(doc, c, "d1-fig", named));
    const tracks = COLONIES.map(c => track(doc, c));
    row.append(h(doc, "span", "d1-glabel", label), figs[0]!.node, tracks[0]!.node, tracks[1]!.node, figs[1]!.node);
    return { row, figs, tracks };
  };
  const kills = gauge(PAGE_WORDS.kills);
  const territory = gauge(SCORE_COPY.territory);
  const ants = gauge(SCORE_COPY.ants);
  const queensRow = h(doc, "div", "d1-queens");
  const counts = COLONIES.map(c => figure(doc, c, "d1-fig", named, " standing: "));
  const lampLists = COLONIES.map(c => {
    const list = h(doc, "span", `d1-lamps c${c}`);
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", `${colonyName(c)} queens`);
    return list;
  });
  queensRow.append(h(doc, "span", "d1-glabel", SCORE_COPY.queens), counts[0]!.node, lampLists[0]!, counts[1]!.node, lampLists[1]!);
  const holdRow = h(doc, "div", "d1-hold");
  const holdLabel = h(doc, "span", "d1-glabel", D1_COPY.territoryHold);
  const holdSr = h(doc, "span", "d1-sr");
  holdLabel.append(holdSr);
  const holds = COLONIES.map(c => {
    const dash = h(doc, "span", `d1-hold-dash c${c}`, "—");
    const win = h(doc, "span", `d1-hold-win c${c}`);
    const ring = h(doc, "span", "d1-ring");
    ring.innerHTML = RING;
    const words = h(doc, "span", "d1-hold-text");
    win.append(...(c === 0 ? [words, ring] : [ring, words]));
    for (const node of [dash, win]) node.setAttribute("aria-hidden", "true");
    return { dash, win, fill: ring.querySelector<SVGCircleElement>(".d1-ring-fill"), words };
  });
  holdRow.append(holdLabel, holds[0]!.dash, holds[0]!.win, holds[1]!.dash, holds[1]!.win);
  // Win conditions as one group, hidden once the result shows (is-ended; the result itself is a modal).
  const winGroup = h(doc, "div", "d1-win");
  winGroup.append(h(doc, "h3", "d1-kicker", D1_COPY.winConditions), queensRow, holdRow);
  // The map, under Territory hold and outside Win conditions, so it stays once they give way at the end.
  // Hidden where the stream carries no map.
  const mapRow = h(doc, "p", "d1-map");
  const mapNameEl = h(doc, "span", "d1-map-name");
  mapRow.append(h(doc, "span", "d1-glabel", D1_COPY.map), h(doc, "span", "d1-sr", ": "), mapNameEl);
  setHidden(mapRow, true);
  score.append(clockEl, h(doc, "h3", "d1-kicker", D1_COPY.balance), kills.row, territory.row, ants.row, winGroup, mapRow);

  // ---------------------------------------------------------------- each colony's economy: a cell per measure
  type Key = "workers" | "soldiers" | "food" | "next" | "ants";
  const measures: [Key, string][] = [["workers", PAGE_WORDS.workers], ["soldiers", PAGE_WORDS.soldiers], ["food", PAGE_WORDS.food], ["next", PAGE_WORDS.nextSpawn], ["ants", SCORE_COPY.ants]];
  const economies = COLONIES.map(c => {
    const root = h(doc, "div", `d1-econ c${c}`);
    const values = measures.map(([key, label]) => {
      const cell = h(doc, "div", "d1-cell");
      const value = figure(doc, c, "d1-mv", named);
      cell.append(h(doc, "span", "d1-ml", label), value.node);
      root.append(cell);
      return { key, value: value.value };
    });
    // The next spawn: its ring with the coming unit's icon inside, in the colony's colour; no seconds.
    const value = values[3]!.value;
    value.className = "d1-next";
    const ring = h(doc, "span", "d1-ring"), caste = h(doc, "span", "d1-caste"), words = h(doc, "span", "d1-next-text");
    ring.innerHTML = RING;
    ring.append(caste);
    for (const node of [ring, words]) node.setAttribute("aria-hidden", "true");
    const said = h(doc, "span", "d1-sr");
    value.append(ring, words, said);
    return { root, values, next: { value, fill: ring.querySelector<SVGCircleElement>(".d1-ring-fill"), caste, words, said, casteKey: "" } };
  });

  const paintGauge = (g: typeof kills, model: Gauge, lead: number | null) => {
    for (const c of COLONIES) {
      setText(g.figs[c]!.value, model.figures[c]);
      setWidth(g.tracks[c]!.fill, `${model.fill[c].toFixed(1)}%`);
      setHidden(g.tracks[c]!.lead, lead === null);
      if (lead !== null) setVar(g.tracks[c]!.lead, "--d1-lead", `${lead.toFixed(2)}%`);
    }
  };

  const lampCache = new Map<string, { node: HTMLElement; hp: HTMLElement; on: HTMLElement }>();
  const lampNode = (lamp: Lamp) => {
    let entry = lampCache.get(lamp.key);
    if (!entry) {
      const node = h(doc, "span", "d1-lamp");
      node.setAttribute("role", "listitem");
      const fill = h(doc, "span", "d1-lamp-fill"), hp = h(doc, "span", "d1-lamp-hp"), on = h(doc, "span", "d1-lamp-hp is-on");
      for (const part of [fill, hp, on]) part.setAttribute("aria-hidden", "true");
      node.append(fill, hp, on);
      entry = { node, hp, on };
      lampCache.set(lamp.key, entry);
    }
    flag(entry.node, "is-lost", lamp.lost);
    flag(entry.node, "is-attacked", lamp.attacked);
    flag(entry.node, "is-inferred", lamp.inferred && !lamp.lost);
    setVar(entry.node, "--d1-f", `${(100 * lamp.fill).toFixed(1)}%`);
    const words = lamp.lost ? SCORE_COPY.queenLost : lamp.hp;
    setText(entry.hp, words);
    setText(entry.on, lamp.lost ? "" : lamp.hp);
    setAttr(entry.node, "aria-label", lamp.label);
    return entry.node;
  };

  const paintNext = (c: Colony, view: NextAntView, said: string) => {
    const n = economies[c]!.next;
    n.value.dataset.kind = view.kind;
    setRing(n.fill, view.kind === "waiting" ? view.fill : view.kind === "full" ? 1 : 0);
    const caste = view.kind === "waiting" ? view.caste ?? "" : "";
    if (n.casteKey !== caste) { n.casteKey = caste; setMarkup(n.caste, caste === "worker" ? D1_ICON.worker : caste === "soldier" ? D1_ICON.soldier : ""); }
    setHidden(n.caste, caste === "");
    setText(n.words, view.kind === "none" ? "—" : "");
    setText(n.said, said);
  };

  let shownNames = `${colonyName(0)}\n${colonyName(1)}`;
  const writeNames = (setup: Parameters<typeof colonyName>[1]) => {
    const names = `${colonyName(0, setup)}\n${colonyName(1, setup)}`;
    if (names === shownNames) return;
    shownNames = names;
    for (const said of named) setText(said.node, `${colonyName(said.colony, setup)}${said.after}`);
    for (const c of COLONIES) lampLists[c]!.setAttribute("aria-label", `${colonyName(c, setup)} queens`);
  };

  return {
    score,
    economy: [economies[0]!.root, economies[1]!.root],
    update(frame) {
      writeNames(frame?.board?.setup ?? null);
      setText(clockEl, clock(frame));
      flag(score, "is-ended", resultShown(frame));
      const bal = balance(frame);
      paintGauge(kills, bal.kills, null);
      paintGauge(territory, bal.territory, bal.lead);
      paintGauge(ants, bal.ants, null);
      // The lead line's plain words, on hover over its row; no legend line of its own.
      setAttr(territory.row, "title", bal.leadText === "" ? null : bal.leadText);
      const win = winConditions(frame);
      for (const c of COLONIES) {
        setText(counts[c]!.value, win.standing[c]);
        const nodes = win.lamps[c].map(lampNode);
        const list = lampLists[c]!;
        if (nodes.length !== list.childElementCount || nodes.some((node, i) => list.children[i] !== node)) list.replaceChildren(...nodes);
        flag(list, "is-crowded", nodes.length > 3);
        const hold = win.hold[c];
        setHidden(holds[c]!.dash, hold !== null);
        setHidden(holds[c]!.win, hold === null);
        if (hold) { setText(holds[c]!.words, hold.text); setRing(holds[c]!.fill, hold.fill); }
      }
      setText(holdSr, win.holdText ? `: ${win.holdText}` : "");
      const map = mapName(frame);
      setText(mapNameEl, map ?? "");
      setHidden(mapRow, map === null);
      const ds: readonly [Dial, Dial] = dials(frame);
      for (const c of COLONIES) {
        for (const cell of economies[c]!.values) {
          if (cell.key === "next") continue;
          setText(cell.value, ds[c][cell.key]);
        }
        paintNext(c, ds[c].next, ds[c].nextText);
      }
    },
  };
}
