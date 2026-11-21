// Score Band: one comparison band and the same colony figures in every match mode.
// Values come only from the displayed frame; unknown historical totals remain unknown.
import type { Frame } from "../../buffer.ts";
import { COLONY_INK, h, setAttr, setHidden, setMarkup, setText } from "../dom.ts";
import { D1_ICON, RING } from "./icons.ts";
import {
  D1_COPY, PAGE_WORDS, QUEEN_KILLS_UNRECORDED, balance, clock, coloniesOf, colonyName, dials, mapName, queenKills, winConditions,
  type Gauge, type Lamp, type NextAntView,
} from "./model.ts";
import { SCORE_COPY } from "../../story.ts";

function flag(node: Element, cls: string, on: boolean) {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}
function setRing(ring: SVGCircleElement | null, fill: number) {
  if (ring) setAttr(ring, "stroke-dasharray", `${(100 * fill).toFixed(1)} 100`);
}

export interface Deck {
  readonly header: HTMLElement;
  readonly columns: HTMLElement;
  readonly score: HTMLElement;
  readonly economy: readonly HTMLElement[];
  update(frame: Frame | null): void;
}

export function mountDeck(doc: Document): Deck {
  // Pools keep focus and node identity stable across two/four-colony handovers.
  const slots = [0, 1, 2, 3];
  const header = h(doc, "header", "sb-clock-map");
  const clockEl = h(doc, "p", "d1-clock");
  const mapRow = h(doc, "p", "d1-map");
  const mapNameEl = h(doc, "span", "d1-map-name");
  mapRow.append(h(doc, "span", "d1-glabel", D1_COPY.map), h(doc, "span", "d1-sr", ": "), mapNameEl);
  setHidden(mapRow, true);
  header.append(clockEl, mapRow);

  const score = h(doc, "section", "d1-score sb-comparison");
  score.setAttribute("aria-label", "Match comparison and win conditions");
  const gauge = (label: string) => {
    const row = h(doc, "div", "sb-gauge");
    const bar = h(doc, "div", "sb-bar");
    bar.setAttribute("aria-hidden", "true");
    const values = h(doc, "div", "sb-values");
    const segments = slots.map(c => {
      const segment = h(doc, "span", `sb-segment c${c}`);
      segment.style.setProperty("--sb-ink", COLONY_INK[c]!);
      const item = h(doc, "span", `sb-figure c${c}`);
      item.style.setProperty("--sb-ink", COLONY_INK[c]!);
      const said = h(doc, "span", "d1-sr");
      const value = h(doc, "span", "sb-value");
      item.append(said, value);
      bar.append(segment); values.append(item);
      return { segment, item, said, value };
    });
    const leads = [h(doc, "span", "sb-lead"), h(doc, "span", "sb-lead")];
    bar.append(...leads);
    const unknown = h(doc, "p", "sb-unavailable", "Not recorded");
    setHidden(unknown, true);
    row.append(h(doc, "h3", "d1-ml", label), bar, values, unknown);
    return { row, bar, values, segments, leads, unknown };
  };
  const kills = gauge(PAGE_WORDS.kills), territory = gauge(SCORE_COPY.territory), ants = gauge(SCORE_COPY.ants);
  const holdRow = h(doc, "section", "sb-hold");
  holdRow.setAttribute("aria-label", D1_COPY.winConditions);
  const holdName = h(doc, "span", "sb-holder");
  const holdWords = h(doc, "span", "sb-hold-words", "—");
  const holdRing = h(doc, "span", "d1-ring");
  holdRing.innerHTML = RING;
  holdRing.setAttribute("aria-hidden", "true");
  setHidden(holdRing, true);
  const holdValue = h(doc, "div", "sb-hold-value");
  holdValue.append(holdRing, holdWords);
  const holdRule = h(doc, "span", "sb-rule");
  holdRow.append(h(doc, "h3", "d1-ml", D1_COPY.territoryHold), holdName, holdValue, holdRule);
  score.append(kills.row, territory.row, ants.row, holdRow);

  const columns = h(doc, "div", "sb-columns");
  columns.setAttribute("aria-hidden", "true");
  const labels = ["Colony", PAGE_WORDS.workers, PAGE_WORDS.soldiers, PAGE_WORDS.flyers, PAGE_WORDS.food,
    PAGE_WORDS.nextSpawn, SCORE_COPY.ants, SCORE_COPY.queens, "Queen kills", D1_COPY.history];
  const headings = labels.map(label => h(doc, "span", "d1-ml", label));
  columns.append(...headings);

  type Key = "workers" | "soldiers" | "flyers" | "food" | "next" | "ants";
  const measures: [Key, string][] = [["workers", PAGE_WORDS.workers], ["soldiers", PAGE_WORDS.soldiers],
    ["flyers", PAGE_WORDS.flyers], ["food", PAGE_WORDS.food], ["next", PAGE_WORDS.nextSpawn], ["ants", SCORE_COPY.ants]];
  const economies = slots.map(c => {
    const root = h(doc, "div", `d1-econ c${c}`);
    root.style.setProperty("--sb-ink", COLONY_INK[c]!);
    const values = measures.map(([key, label]) => {
      const cell = h(doc, "div", `d1-cell sb-${key}`);
      const value = h(doc, "span", "d1-mv");
      cell.append(h(doc, "span", "d1-ml", label), value);
      setHidden(cell, key === "flyers"); root.append(cell);
      return { key, cell, value };
    });
    const nextValue = values.find(v => v.key === "next")!.value;
    nextValue.className = "d1-next";
    const ring = h(doc, "span", "d1-ring"), caste = h(doc, "span", "d1-caste"), words = h(doc, "span", "d1-next-text");
    ring.innerHTML = RING; ring.append(caste);
    for (const part of [ring, words]) part.setAttribute("aria-hidden", "true");
    const said = h(doc, "span", "d1-sr");
    nextValue.append(ring, words, said);
    const queens = h(doc, "div", "d1-cell sb-queens");
    const queenValue = h(doc, "div", "sb-queen-value");
    const count = h(doc, "span", "d1-mv");
    const lamps = h(doc, "span", `d1-lamps c${c}`);
    lamps.setAttribute("role", "list");
    queenValue.append(count, lamps);
    queens.append(h(doc, "span", "d1-ml", SCORE_COPY.queens), queenValue);
    const queenKillsCell = h(doc, "div", "d1-cell sb-queen-kills");
    const queenKillsValue = h(doc, "span", "d1-mv", "—");
    queenKillsValue.setAttribute("aria-label", QUEEN_KILLS_UNRECORDED);
    queenKillsValue.title = QUEEN_KILLS_UNRECORDED;
    queenKillsCell.append(h(doc, "span", "d1-ml", "Queen kills"), queenKillsValue);
    root.append(queens, queenKillsCell);
    return { root, values, count, lamps, queenKills: queenKillsValue, next: { value: nextValue, fill: ring.querySelector<SVGCircleElement>(".d1-ring-fill"), caste, words, said, casteKey: "" } };
  });

  const lampCache = new Map<string, { node: HTMLElement; hp: HTMLElement; on: HTMLElement }>();
  const lampNode = (lamp: Lamp) => {
    let entry = lampCache.get(lamp.key);
    if (!entry) {
      const node = h(doc, "span", "d1-lamp"); node.setAttribute("role", "listitem");
      const fill = h(doc, "span", "d1-lamp-fill"), hp = h(doc, "span", "d1-lamp-hp"), on = h(doc, "span", "d1-lamp-hp is-on");
      for (const part of [fill, hp, on]) part.setAttribute("aria-hidden", "true");
      node.append(fill, hp, on); entry = { node, hp, on }; lampCache.set(lamp.key, entry);
    }
    flag(entry.node, "is-lost", lamp.lost); flag(entry.node, "is-attacked", lamp.attacked);
    flag(entry.node, "is-inferred", lamp.inferred && !lamp.lost);
    entry.node.style.setProperty("--d1-f", `${(100 * lamp.fill).toFixed(1)}%`);
    setText(entry.hp, lamp.lost ? SCORE_COPY.queenLost : lamp.hp);
    setText(entry.on, lamp.lost ? "" : lamp.hp);
    setAttr(entry.node, "aria-label", lamp.label); entry.node.title = lamp.label;
    return entry.node;
  };
  const paintNext = (c: number, view: NextAntView, said: string) => {
    const n = economies[c]!.next;
    n.value.dataset.kind = view.kind;
    setRing(n.fill, view.kind === "waiting" ? view.fill : view.kind === "full" ? 1 : 0);
    const caste = view.kind === "waiting" ? view.caste ?? "" : "";
    if (n.casteKey !== caste) {
      n.casteKey = caste;
      setMarkup(n.caste, caste === "worker" ? D1_ICON.worker : caste === "soldier" ? D1_ICON.soldier : "");
    }
    setHidden(n.caste, caste !== "worker" && caste !== "soldier");
    setText(n.words, view.kind === "none" ? "—" : ""); setText(n.said, said);
    n.value.title = said;
  };
  const paintGauge = (g: typeof kills, model: Gauge, count: number, setup: Parameters<typeof colonyName>[1], lead: number | null = null) => {
    const unavailable = model.figures.every(v => v === "—");
    flag(g.bar, "is-unknown", unavailable);
    setHidden(g.unknown, !unavailable); setHidden(g.values, unavailable);
    g.values.style.setProperty("--sb-count", String(count));
    for (const c of slots) {
      const node = g.segments[c]!;
      setHidden(node.segment, c >= count); setHidden(node.item, c >= count);
      setText(node.value, model.figures[c] ?? "—");
      setText(node.said, `${colonyName(c, setup)}: `);
      node.item.title = `${colonyName(c, setup)}: ${model.figures[c] ?? "—"}`;
      node.segment.style.setProperty("width", `${model.fill[c] ?? 0}%`);
    }
    g.leads.forEach((node, i) => {
      setHidden(node, lead === null);
      if (lead !== null) node.style.setProperty("left", `${i === 0 ? 100 - lead : lead}%`);
    });
  };

  return {
    header, columns, score, economy: economies.map(e => e.root),
    update(frame) {
      const colonies = coloniesOf(frame), count = colonies.length, setup = frame?.board?.setup ?? null;
      setText(clockEl, clock(frame));
      const map = mapName(frame);
      setText(mapNameEl, map ?? ""); setHidden(mapRow, map === null);
      const bal = balance(frame);
      paintGauge(kills, bal.kills, count, setup);
      paintGauge(territory, bal.territory, count, setup, bal.lead);
      setText(territory.unknown, frame?.board ? D1_COPY.noTerritory : "Not recorded");
      paintGauge(ants, bal.ants, count, setup);
      setAttr(territory.row, "title", bal.leadText || null);
      const win = winConditions(frame), holder = win.hold.findIndex(h => h !== null);
      const hold = holder < 0 ? null : win.hold[holder]!;
      setText(holdName, hold ? colonyName(holder, setup) : "");
      setHidden(holdName, !hold);
      setText(holdWords, hold?.text ?? "—");
      setHidden(holdRing, !hold);
      setRing(holdRing.querySelector<SVGCircleElement>(".d1-ring-fill"), hold?.fill ?? 0);
      holdRow.style.setProperty("--sb-ink", holder < 0 ? "var(--aw-ink)" : COLONY_INK[holder]!);
      setAttr(holdRow, "title", win.holdText || null);
      setText(holdRule, count > 2 ? ">50% majority" : "");
      setHidden(holdRule, count <= 2);
      const ds = dials(frame), qk = queenKills(frame);
      setHidden(headings[3]!, !ds.some(d => d.flyers !== null));
      for (const c of slots) {
        const e = economies[c]!, d = ds[c];
        setHidden(e.root, c >= count);
        if (!d) continue;
        flag(e.root, "has-flyers", d.flyers !== null);
        for (const cell of e.values) {
          if (cell.key === "next") continue;
          const value = d[cell.key];
          setHidden(cell.cell, value === null); setText(cell.value, value ?? "");
        }
        paintNext(c, d.next, d.nextText);
        setText(e.count, win.standing[c] ?? "—");
        e.count.setAttribute("aria-label", `${colonyName(c, setup)} standing queens: ${win.standing[c] ?? "—"}`);
        e.lamps.setAttribute("aria-label", `${colonyName(c, setup)} queens`);
        const queenKillFigure = qk[c] ?? null;
        const killsSaid = queenKillFigure === null ? QUEEN_KILLS_UNRECORDED : `${colonyName(c, setup)} queen kills: ${queenKillFigure}`;
        setText(e.queenKills, queenKillFigure ?? "—");
        setAttr(e.queenKills, "aria-label", killsSaid);
        if (e.queenKills.title !== killsSaid) e.queenKills.title = killsSaid;
        const nodes = (win.lamps[c] ?? []).map(lampNode);
        if (nodes.length !== e.lamps.childElementCount || nodes.some((node, i) => e.lamps.children[i] !== node)) e.lamps.replaceChildren(...nodes);
      }
    },
  };
}
