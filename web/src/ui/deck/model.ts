// The Instrument deck: what the deck, the frame and the pane show, read from the delayed playback
// frame only. Pure: every value comes from the stream through the HUD's existing helpers, and no DOM is touched.
// Each value is named by the stream field behind it.
//
// Overlay exports are read only inside functions: overlays.ts imports this HUD, which imports this module.
import { COLONY_NAMES } from "../../../../src/sim/config.ts";
import { colonyNameNote, colonyNamesOf, type ColonyNamePair } from "../../../../src/sim/colonyNames.ts";
import { streamQueens, type CallKind, type OrderKind, type StreamAgent, type StreamMark, type StreamQueen, type StreamResult } from "../../../../src/live/format.ts";
import { fallWindow, fallenQueen, resultShownAt, type Board, type CommandEntry, type Frame, type StoryEntry } from "../../buffer.ts";
import { isCountMark, markReading } from "../../words.ts";
import {
  MODEL_LABEL, cardSubject, colonyStats, headline, matchTime, nextAntCells, nextAntState, nextHatchCaste, orderTarget,
  orderText, queensUnderAttack, scoreHatchStatus, storyText, storyWhen, territoryWinText, type AntInfo,
} from "../../overlays.ts";
import { OPEN_COPY, PAGE_COPY, SCORE_COPY, clockTime, decisive, resultHow, significant } from "../../story.ts";
import { CONNECTING_LINE, ENDED_LINE, SEAT, agentHandle, agentModel, isBenchmark, namedText, ratingResultRows, rowName, type RatingRow, type RowName } from "../../compose.ts";
import { agentShade, cssColour } from "../../squads.ts";
import { seatModelName } from "../../pages/model.ts";
import { boardQueenHp } from "../../variant.ts";
import type { ModeCopy } from "../../replay.ts";
import { WAITING_COPY } from "../../waiting.ts";
import { agentDetail, agentEntries, boardRules, tps, type AgentEntry, type AgentLineModel } from "../hud-model.ts";
import { holdProgress, leadLine, resultHeadline, shares, spawnFill, stepped } from "../format.ts";
import { badge } from "../icons.ts";

export type Colony = 0 | 1;
export const COLONIES = [0, 1] as const;

/**
 * The words the deck adds; every other string is the page's own.
 */
export const D1_COPY = {
  /** The figure keeps its unit on its line, as withUnits writes it (ui/format.ts). */
  policyDelay: (seconds: string) => `${seconds}\u00a0s policy delay`,
  waiting: "Waiting for new data",
  balance: "Balance",
  winConditions: "Win conditions",
  territoryHold: "Territory hold",
  /** The map row under Territory hold. */
  map: "Map",
  selected: "Selected",
  showTarget: "Show target",
  showOnBoard: "Show on board",
  noLonger: "no longer on the board",
  /** The Territory row's tooltip while its dotted lead line shows (plain words, never where a value comes from). */
  leadLine: (ratio: string) => `Dotted line: a ${ratio}:1 territory lead, which ends the match early if held`,
  /** The model header's asterisk (placeholder name). */
  selfReported: "Self-reported: outside the Antwars Model Index, each agent names its own model.",
  /** An empty history's one line: the stream starts where the viewer arrived. */
  timelineNone: "Nothing since you started watching",
  /** The game history's heading: a scrolling history of the game. */
  history: "History",
  /** A command the game refused, beside its row. */
  refused: "refused",
  /** An arrival row's lead: what an agent stood on when a live viewer arrived mid-match, not a timed event. */
  onArrival: "On arrival",
  /** Before an arrival row's newest live mark. */
  arrivalMark: "mark",
} as const;

/** Words the page already has, in the one place the deck reads them. */
export const PAGE_WORDS = {
  noMatch: "No live match",
  kills: "Kills",
  workers: "Workers",
  soldiers: "Soldiers",
  food: "Food",
  nextSpawn: "Next spawn",
  agents: "Agents",
  result: "Result",
  close: "Close",
  share: "Share on X",
  noSquad: "No squad",
  recent: "Recent thoughts and marks",
  left: (time: string) => `${time} left`,
} as const;

const EM = "—";
const fmt = (n: number) => n.toLocaleString("en");
/** An Elo as the HUD writes it: a whole number (hud-model.ts agentEntries, compose.ts playerLabel). */
export const eloText = (elo: number): string => String(Math.round(elo));

// ---------------------------------------------------------------- the frame's legend

export type Rule = "solid" | "double" | "dashed" | "hairline";
export interface Legend {
  /** The filled live dot, the hollow recording ring, or none. */
  readonly dot: "live" | "recording" | null;
  /** The mode word first, then its parts in modeCopy's order (web/src/replay.ts). */
  readonly words: readonly string[];
  /** The board frame's rule says the state again: solid live, double recording, dashed stalled or reconnecting, hairline connecting or no match. */
  readonly rule: Rule;
  /** A recording's Back to live, as today's HUD offers it; the live page's own recording offer stays in the footer. */
  readonly back: { readonly text: string; readonly href: string } | null;
}
/** The page's mode line, as the board computes it (web/src/replay.ts modeCopy). */
export type ModeText = Pick<ModeCopy, "label" | "detail"> & Partial<Pick<ModeCopy, "link">>;

/** The detail may carry a no-break space between the figure and its unit (ui/format.ts withUnits). */
const DELAY = /^(\d+)\s+s behind the match$/;
const AGENT_COUNT = /^\d+\s+agents?$/;
const NO_AGENTS = "No agents";
const parts = (text: string) => text.split(" · ").map(p => p.replace(/^·\s*/, "").trim()).filter(Boolean);
/** Whether the page's mode line says LIVE, as the legend's dot reads it. */
export const liveMode = (mode: ModeText | null): boolean => parts(mode?.label ?? "")[0] === "LIVE";

/**
 * The stream's state in the board frame's top rule (the frame's legend): LIVE or RECORDING, the rating, the agents,
 * the selected catalog entry's delay worded as policy, a stand-in's reason and date, and the connection.
 * It reads the page's own mode line (modeCopy) and playback: stalled is Playback.underrun while the match still runs.
 * The agent count follows the frame shown. "Match ended" is left out: the clock says ended.
 */
export function legend(hasFrame: boolean, agents: number | null, connection: string, mode: ModeText | null, stalled: boolean): Legend {
  if (!hasFrame) {
    return { dot: null, words: [/connecting/i.test(connection) ? WAITING_COPY.connecting : PAGE_WORDS.noMatch], rule: "hairline", back: null };
  }
  const head = parts(mode?.label ?? "");
  const detail = parts(mode?.detail ?? "");
  const dot = head[0] === "LIVE" ? "live" : head[0]?.startsWith("RECORDING") ? "recording" : null;
  const words = head.filter(p => p !== NO_AGENTS && !AGENT_COUNT.test(p));
  if (dot === "live" && agents === 0) words.push(NO_AGENTS);
  if (dot === "recording" && agents !== null) words.push(`${agents} ${agents === 1 ? "agent" : "agents"}`);
  for (const p of detail) {
    if (p === NO_AGENTS || AGENT_COUNT.test(p)) continue;
    const delay = DELAY.exec(p);
    words.push(delay ? D1_COPY.policyDelay(delay[1]!) : p);
  }
  let rule: Rule = dot === "recording" ? "double" : dot === "live" ? "solid" : "hairline";
  if (stalled) { words.push(D1_COPY.waiting); rule = "dashed"; }
  if (connection !== "" && connection !== ENDED_LINE && /connecting/i.test(connection)) {
    words.push(connection === CONNECTING_LINE ? WAITING_COPY.connecting : connection);
    rule = "dashed";
  }
  // As today's HUD: the live page's "?replay" offer is not a way back.
  const link = mode?.link ?? null;
  const back = link && link.text !== "" && link.href !== "?replay" ? { text: link.text, href: link.href } : null;
  return { dot, words, rule, back };
}

// ---------------------------------------------------------------- the clock and whether the result shows

/** Whether playback shows the result: the result card follows the match's end by its beat (Current's rule). */
export function resultShown(frame: Frame | null): boolean {
  const b = frame?.board;
  return !!(frame && b && b.result !== null && frame.targetMs >= resultShownAt(b.result, frame.endShown ?? undefined));
}

/** "12:34 · 17:26 left", and once the stream carries the result "18:22 · ended", the one place it is said. */
export function clock(frame: Frame | null): string {
  const b = frame?.board;
  if (!frame || !b) return EM;
  const rate = tps(b);
  const elapsed = clockTime(Math.min(frame.tick, b.setup.matchTicks), rate);
  if (b.result !== null) return `${elapsed} · ${PAGE_COPY.ended}`;
  return `${elapsed} · ${PAGE_WORDS.left(clockTime(Math.ceil(Math.max(0, b.setup.matchTicks - frame.tick) / rate) * rate, rate))}`;
}

// ---------------------------------------------------------------- the map

/**
 * The match's map name as the stream's setup carries it (setup.terrain.mapName), live and on replay alike, or null
 * where the stream has no terrain (a pre-terrain recording): the deck then shows no map rather than a guessed one.
 */
export function mapName(frame: Frame | null): string | null {
  const name = frame?.board?.setup.terrain?.mapName.trim();
  return name ? name : null;
}

// ---------------------------------------------------------------- balance: kills, territory and ants

export interface Gauge {
  readonly figures: readonly [string, string];
  /** Each colony's share of the whole, in percent, filled from its own end of its half-track; 50 is even. */
  readonly fill: readonly [number, number];
}
export interface Balance {
  readonly kills: Gauge;
  readonly territory: Gauge;
  /** Each colony's living ants, filled to its share as Kills is. */
  readonly ants: Gauge;
  /** Where a 6:1 lead sits on each half-track, in percent from the colony's end, while the rules have an early win (inferred). */
  readonly lead: number | null;
  /** The lead line in plain words while it shows (D1_COPY.leadLine), else "". */
  readonly leadText: string;
}

const NO_GAUGE: Gauge = { figures: [EM, EM], fill: [0, 0] };

export function balance(frame: Frame | null): Balance {
  const b = frame?.board;
  if (!frame || !b) return { kills: NO_GAUGE, territory: NO_GAUGE, ants: NO_GAUGE, lead: null, leadText: "" };
  // Every death is the other colony's kill (src/sim/territory.ts decideTimeUp).
  const killed = [b.deaths[1], b.deaths[0]] as const;
  const k = shares(killed[0], killed[1]);
  const t = shares(b.held[0], b.held[1]);
  // The same living count the economy's Ants cell reads (dials).
  const stats = colonyStats(frame);
  const living = [stats[0].workers + stats[0].soldiers, stats[1].workers + stats[1].soldiers] as const;
  const a = shares(living[0], living[1]);
  const early = boardRules(b)?.earlyWin;
  const shown = early !== undefined && b.result === null && t !== null;
  return {
    kills: { figures: [fmt(killed[0]), fmt(killed[1])], fill: k ? [k[0], k[1]] : [0, 0] },
    territory: { figures: t ? [`${Math.round(t[0])}%`, `${Math.round(t[1])}%`] : [EM, EM], fill: t ? [t[0], t[1]] : [0, 0] },
    ants: { figures: [fmt(living[0]), fmt(living[1])], fill: a ? [a[0], a[1]] : [0, 0] },
    lead: shown ? leadLine(early.territoryRatioPermille) : null,
    leadText: shown ? D1_COPY.leadLine(String(early.territoryRatioPermille / 1000)) : "",
  };
}

// ---------------------------------------------------------------- win conditions: queens and a territory hold

export interface Lamp {
  readonly key: string;
  readonly lost: boolean;
  /** Whole HP where the stream carries HP; "" otherwise. */
  readonly hp: string;
  /** 0..1: HP against the rules' maximum, or where queens have no HP her safety from overrun (1 − overrun ÷ required). */
  readonly fill: number;
  readonly attacked: boolean;
  /** The housing is the rules' maximum, a client constant: drawn dotted. */
  readonly inferred: boolean;
  readonly label: string;
}
export interface HoldSide {
  /** The hold so far, in quarters. */
  readonly fill: number;
  readonly text: string;
}
export interface WinConditions {
  /** Each colony's queens in founding order from its own end; a lost queen keeps her lamp, marked lost. */
  readonly lamps: readonly [readonly Lamp[], readonly Lamp[]];
  readonly standing: readonly [string, string];
  readonly hold: readonly [HoldSide | null, HoldSide | null];
  /** The hold read in full ("Very Large Colony · win in 1:20"), or "". */
  readonly holdText: string;
}

/** A queen out of the match: lost, or overrun to the end where queens have no HP (Current's rule). */
export function queenOut(q: StreamQueen, b: Pick<Board, "queens" | "overrunRequired">): boolean {
  return q.lostTick !== null || (boardQueenHp(b) === undefined && b.overrunRequired > 0 && q.overrun >= b.overrunRequired);
}

export function winConditions(frame: Frame | null): WinConditions {
  const b = frame?.board;
  if (!frame || !b) return { lamps: [[], []], standing: [EM, EM], hold: [null, null], holdText: "" };
  const full = boardQueenHp(b)?.hp;
  const attacked = queensUnderAttack(frame.story, frame.tick);
  const all = streamQueens(b);
  const lamps = COLONIES.map(colony => all.filter(q => q.colony === colony)
    .sort((x, y) => x.foundedTick - y.foundedTick || x.id - y.id)
    .map(q => lamp(q, frame, b, full, attacked))) as [Lamp[], Lamp[]];
  const h = headline(b, frame.tick);
  // A hold due after time-up shows no countdown.
  const holder = h.label === SCORE_COPY.winIn ? h.leader : null;
  const held = holder === null ? null : holdProgress(b.territoryWin, frame.tick);
  return {
    lamps,
    standing: [String(lamps[0].filter(l => !l.lost).length), String(lamps[1].filter(l => !l.lost).length)],
    hold: COLONIES.map(c => c === holder && held !== null ? { fill: stepped(held), text: `${SCORE_COPY.winIn} ${h.figure}` } : null) as [HoldSide | null, HoldSide | null],
    holdText: holder !== null && held !== null ? territoryWinText(b, frame.tick) ?? "" : "",
  };
}

function lamp(q: StreamQueen, frame: Frame, b: Board, fullHp: number | undefined, attackedSet: ReadonlySet<string>): Lamp {
  const lost = queenOut(q, b);
  const hpMode = fullHp !== undefined;
  const overrun = hpMode ? 0 : Math.min(1, q.overrun / Math.max(1, b.overrunRequired));
  const fill = lost ? 0 : hpMode ? Math.max(0, Math.min(1, (q.hp ?? 0) / fullHp)) : 1 - overrun;
  const hit = frame.hits.some(x => x.colony === q.colony && x.queenId === q.id);
  const attacked = !lost && (attackedSet.has(`${q.colony}:${q.id}`) || hit || (!hpMode && q.overrun > 0));
  const hp = hpMode && !lost ? String(Math.ceil((q.hp ?? 0) / 1000)) : "";
  const state = lost ? SCORE_COPY.queenLost : hpMode ? `${hp} HP` : overrun > 0 ? `overrun ${Math.round(100 * overrun)}%` : "safe";
  return {
    key: `${q.colony}:${q.id}`, lost, hp, fill, attacked, inferred: hpMode,
    label: `${colonyNamesOf(b.setup)[q.colony]} Queen ${q.id + 1}: ${state}${attacked ? `, ${OPEN_COPY.underAttack}` : ""}`,
  };
}

// ---------------------------------------------------------------- the colony dials: economy

export type Caste = "worker" | "soldier";
export type NextAntView =
  | { readonly kind: "none" }
  | { readonly kind: "food" }
  | { readonly kind: "full" }
  /** The ring's fill and the coming unit, drawn inside the ring; no seconds. */
  | { readonly kind: "waiting"; readonly fill: number; readonly caste: Caste | null };
export interface Dial {
  readonly workers: string;
  readonly soldiers: string;
  /** The store, or "2/6" short of the next ant's cost (nextAntCells). */
  readonly food: string;
  readonly next: NextAntView;
  /** The next hatch read in full (scoreHatchStatus), which a screen reader hears. */
  readonly nextText: string;
  /** Living ants over the streamed cap ("212/512"); the count alone where the stream carries no cap. */
  readonly ants: string;
}
const EMPTY_DIAL: Dial = { workers: EM, soldiers: EM, food: EM, next: { kind: "none" }, nextText: "", ants: EM };

export function dials(frame: Frame | null): readonly [Dial, Dial] {
  const b = frame?.board;
  if (!frame || !b) return [EMPTY_DIAL, EMPTY_DIAL];
  const stats = colonyStats(frame);
  const rate = tps(b);
  return COLONIES.map((colony): Dial => {
    const s = stats[colony];
    const living = s.workers + s.soldiers;
    const food = nextAntCells(b.stores[colony], b.hatch, living, frame.tick, rate);
    const cap = b.hatch !== null && b.hatch.cap > 0 ? b.hatch.cap : null;
    return {
      workers: fmt(s.workers), soldiers: fmt(s.soldiers), food: food?.[0] ?? EM,
      next: nextAnt(b, colony, living, frame.tick), nextText: scoreHatchStatus(b, colony, living, frame.tick).description,
      ants: cap === null ? fmt(living) : `${fmt(living)}/${fmt(cap)}`,
    };
  }) as [Dial, Dial];
}

/** The next ant, as Current's spawn chip decides it: no food is the empty ring alone. */
function nextAnt(b: Board, colony: Colony, living: number, tick: number): NextAntView {
  const store = b.stores[colony], hatch = b.hatch, rate = b.setup.ticksPerSecond;
  const standing = streamQueens(b).some(q => q.colony === colony && !queenOut(q, b));
  const known = hatch !== null && hatch.cap > 0 && rate > 0 && [store.food, store.nextCost, store.nextHatchTick].every(Number.isFinite) && store.nextCost > 0;
  if (!known || hatch === null || !standing || b.result !== null || tick >= b.setup.matchTicks) return { kind: "none" };
  const state = nextAntState(store, hatch, living, tick, rate);
  const caste = nextHatchCaste(b, store.nextCost);
  switch (state.kind) {
    case "unknown": return { kind: "none" };
    case "full": return { kind: "full" };
    case "food": return { kind: "food" };
    // Due now: the full ring at no wait, never a word such as "eligible".
    case "ready": return { kind: "waiting", caste, fill: 1 };
    case "waiting": {
      const interval = hatch.intervalTicks * (caste === "soldier" ? boardRules(b)?.hatchTiming?.soldierIntervalMultiplier ?? 1 : 1);
      // Every change is a cut: the ring steps in quarters.
      return { kind: "waiting", caste, fill: stepped(spawnFill(state, store.nextHatchTick, interval, tick)) };
    }
  }
}

// ---------------------------------------------------------------- the lane's one event

export interface Caption {
  readonly kind: "event" | "fall";
  readonly colony: Colony;
  /** The entry's time, m:ss; "" for the fall, whose time follows its colony. */
  readonly when: string;
  readonly what: string;
  readonly who: string;
}
/** The "— 22 HP" tail of an attack under way: the lamp shows her HP. */
const HP_TAIL = / — \d+ HP$/;

/**
 * The one significant event (story.ts significant): its colony's bar, its time, storyText's words without the HP tail,
 * and the colony; during a fall, the queen lost, large. Nothing once the result shows.
 */
export function caption(frame: Frame | null): Caption | null {
  const b = frame?.board;
  if (!frame || !b || resultShown(frame)) return null;
  const rate = tps(b);
  const fallen = fallWindow(frame);
  if (fallen.some(Boolean)) {
    const q = fallenQueen(b);
    const colony = fallen.indexOf(true) as Colony;
    return { kind: "fall", colony, when: "", what: `Queen ${(q?.id ?? 0) + 1} lost`, who: `${colonyNamesOf(b.setup)[colony]} · ${matchTime(q?.lostTick ?? frame.tick, rate)}` };
  }
  const e = significant(frame.story, frame.tick, rate);
  if (!e) return null;
  return {
    kind: "event", colony: e.colony, when: matchTime(storyWhen(e, frame.tick), rate),
    what: storyText(e, b.agents, frame.tick, b.queens, false, colonyNamesOf(b.setup)).what.replace(HP_TAIL, ""), who: colonyNamesOf(b.setup)[e.colony],
  };
}

// ---------------------------------------------------------------- a colony's game history

/** The team member a history row is tied to: the badge the roster and the board give it, and its name. */
export interface HistoryMember {
  readonly index: number;
  readonly shade: string;
  readonly badge: string;
  readonly name: string;
}
/** A row's symbol: an order's outline, a mark's filled symbol (a word mark's ring), a queen's crown, or none. */
export type HistoryGlyph =
  | { readonly kind: "order"; readonly order: OrderKind; readonly guard: boolean }
  | { readonly kind: "mark"; readonly verb: string | undefined }
  | { readonly kind: "queen" }
  | null;
export interface HistoryRow {
  /** Stable across frames: "c" and the command's id, or "s" and the timeline entry's. */
  readonly key: string;
  readonly tick: number;
  /** The row's time, m:ss. */
  readonly when: string;
  /** Who acted: the agent that called, or the squad an event names; null for a colony's event with no squad. */
  readonly member: HistoryMember | null;
  readonly glyph: HistoryGlyph;
  /** The command, or storyText's words told as past without an attack's HP tail, which the queen's bar shows. */
  readonly what: string;
  /** An order's own intent line, quoted; "" without one. */
  readonly intent: string;
  /** A command the game refused. */
  readonly refused: boolean;
  /** An arrival row: the agent's standing order when a live viewer arrived, untimed. */
  readonly arrival: boolean;
  /** An arrival row's newest live mark at arrival, its symbol and reading; null otherwise. */
  readonly mark: { readonly verb: string | undefined; readonly text: string } | null;
  /** Everything the row shows, for assistive technology. */
  readonly reading: string;
}

/** A call's words where it set nothing to tell (refused, or an older stream): its kind, plainly. */
const CALL_WORDS: Record<CallKind, string> = {
  join: "joined", rejoin: "rejoined", observe: "observed", order: "order", mark: "mark", found_queen: "found a queen", count_mark: "count mark", set_brood: "set brood",
};

function actor(b: Board, index: number): HistoryMember | null {
  const a = b.agents[index];
  if (!a) return null;
  const shade = cssColour(agentShade(a.colony, index, b.agents));
  return { index, shade, badge: badge(index, shade, 14), name: a.identity ? rowName(a.identity.displayName, undefined).name : (agentModel(a)?.name ?? agentHandle(index)) };
}

function commandRow(c: CommandEntry, b: Board, rate: number): HistoryRow {
  const when = matchTime(c.tick, rate);
  let glyph: HistoryGlyph = null, what = CALL_WORDS[c.call], intent = "";
  if (c.order) {
    const a = { colony: c.colony, order: c.order.kind, orderX: c.order.tileX, orderY: c.order.tileY };
    const target = orderTarget(c.order.tileX, c.order.tileY, b);
    const directed = c.order.kind === "go_to" || c.order.kind === "attack";
    glyph = { kind: "order", order: c.order.kind, guard: directed && !!target?.liveQueen && target.colony === c.colony };
    what = orderText(a, target);
    intent = c.order.intent ? `“${c.order.intent}”` : "";
  } else if (c.mark) {
    glyph = { kind: "mark", verb: isCountMark(c.mark) ? c.mark.verb : undefined };
    what = markReading(c.mark) || what;
  } else if (c.call === "found_queen" && c.accepted) glyph = { kind: "queen" };
  const who = actor(b, c.agent);
  const reading = `${when}, ${who?.name ?? colonyNamesOf(b.setup)[c.colony]}: ${what}${intent ? ` ${intent}` : ""}${c.accepted ? "" : `, ${D1_COPY.refused}`}`;
  return { key: `c${c.id}`, tick: c.tick, when, member: who, glyph, what, intent, refused: !c.accepted, arrival: false, mark: null, reading };
}

function eventRow(e: StoryEntry, b: Board, now: number, rate: number): HistoryRow {
  const when = matchTime(storyWhen(e, now), rate);
  const what = storyText(e, b.agents, now, b.queens, true, colonyNamesOf(b.setup)).what.replace(HP_TAIL, "");
  const who = e.agent >= 0 ? actor(b, e.agent) : null;
  return {
    key: `s${e.id}`, tick: e.tick, when, member: who, glyph: null, what, intent: "", refused: false, arrival: false, mark: null,
    reading: `${when}, ${who?.name ?? colonyNamesOf(b.setup)[e.colony]}: ${what}`,
  };
}

/**
 * A colony's game history, a scrolling list of each command and major event with a timestamp, each
 * row attached to a team member, in every match, 1v1 and team alike: every command playback
 * has reached (Frame.commands) from an agent of this colony, and every timeline entry whose colony is this one (the
 * colony that acted, or for a queen attacked or lost her own), newest first. An observe is a board read, not a command
 * (the stream's command-idle rule, src/live/model.ts), so it has no row; a refused command keeps its row, marked. The
 * page keeps what it received, so a live viewer's history starts where they arrived and a replay's is the whole match.
 */
export function history(frame: Frame | null, colony: Colony, seed: readonly HistoryRow[] = []): readonly HistoryRow[] {
  const b = frame?.board;
  if (!frame || !b) return [];
  const rate = tps(b);
  const rows: HistoryRow[] = [];
  for (const c of frame.commands) if (c.colony === colony && c.call !== "observe") rows.push(commandRow(c, b, rate));
  for (const e of frame.story) if (e.colony === colony) rows.push(eventRow(e, b, frame.tick, rate));
  // Newest first; within a tick the event after the commands that led to it, then the later of each.
  const order = (r: HistoryRow) => (r.key[0] === "s" ? 1 : 0);
  const id = (r: HistoryRow) => Number(r.key.slice(1));
  rows.sort((x, y) => y.tick - x.tick || order(y) - order(x) || id(y) - id(x));
  // The arrival rows sit at the oldest end: on top as the viewer arrives, every later row stacking above them.
  for (const r of seed) if (r.member !== null && b.agents[r.member.index]?.colony === colony) rows.push(r);
  return rows;
}

// ---------------------------------------------------------------- what a live viewer arriving mid-match missed

/**
 * The state at a viewer's arrival, each move shown against its agent: the first board
 * the page showed of this match, and from it one row per agent with its standing order and its newest live mark, the
 * two things its history cannot have, since the page keeps only what it received.
 */
export interface Arrival {
  /** The match the page arrived at, so a reconnect to it keeps the rows and another match takes its own. */
  readonly key: string;
  readonly tick: number;
  readonly rows: readonly HistoryRow[];
}

/**
 * The match a board belongs to, as far as the board says: its setup, which a reconnect to the same match carries
 * again; a new match on the same setup restarts its tick (buffer.ts restart's own same-match rule reads map size and
 * tick). Seats are left out: an agent joining later is the same match, and its join is already history.
 */
function matchKey(b: Board): string {
  const s = b.setup;
  return JSON.stringify([s.mapW, s.mapH, s.matchTicks, s.ticksPerSecond, s.queens, s.terrain?.mapId ?? null]);
}

function arrivalRow(b: Board, index: number, tick: number): HistoryRow | null {
  const a = b.agents[index];
  const who = actor(b, index);
  if (!a || !who) return null;
  const target = orderTarget(a.orderX, a.orderY, b);
  const directed = a.order === "go_to" || a.order === "attack";
  const what = orderText(a, target);
  const intent = a.intent ? `“${a.intent}”` : "";
  // Its newest mark still on the board, as LATEST showed it at arrival; a mark with no reading tells nothing.
  let newest: StreamMark | null = null;
  for (const mk of b.marks) {
    if (mk.agent !== index || markReading(mk) === "") continue;
    if (!newest || mk.laidTick > newest.laidTick || (mk.laidTick === newest.laidTick && mk.id > newest.id)) newest = mk;
  }
  const mark = newest && { verb: isCountMark(newest) ? newest.verb : undefined, text: markReading(newest) };
  return {
    key: `a${index}`, tick, when: "", member: who, glyph: { kind: "order", order: a.order, guard: directed && !!target?.liveQueen && target.colony === a.colony },
    what, intent, refused: false, arrival: true, mark,
    reading: `${D1_COPY.onArrival}, ${who.name}: ${what}${intent ? ` ${intent}` : ""}${mark ? `, ${D1_COPY.arrivalMark} ${mark.text}` : ""}`,
  };
}

/**
 * The arrival this frame belongs to: the one already held while the frame is of the same match and no earlier, else
 * this frame's own, taken from its board once. Pure; the panel keeps what it returns.
 */
export function arrival(held: Arrival | null, frame: Frame | null): Arrival | null {
  const b = frame?.board;
  if (!frame || !b) return held;
  const key = matchKey(b);
  if (held && held.key === key && frame.tick >= held.tick) return held;
  const rows = b.agents.map((_, i) => arrivalRow(b, i, frame.tick)).filter((r): r is HistoryRow => r !== null);
  return { key, tick: frame.tick, rows };
}

/**
 * The arrival rows a history shows: only on a live match the viewer joined after it began. A replay, fed from the
 * start, and a viewer there from the first tick have every command already, so they get none.
 */
export function arrivalRows(held: Arrival | null, mode: ModeText | null): readonly HistoryRow[] {
  return held && held.tick > 0 && liveMode(mode) ? held.rows : NO_ROWS;
}
const NO_ROWS: readonly HistoryRow[] = [];

// ---------------------------------------------------------------- the result

export interface Moment { readonly when: string; readonly what: string; readonly who: string; readonly colony: Colony }
export interface ResultView {
  readonly headline: string;
  readonly winner: Colony | null;
  /** The reason, with the deciding measure where it differs (resultHow). */
  readonly how: string;
  /** Each rating line: the shown name, a Benchmark name's level and Fast badges, then the change. */
  readonly ratings: readonly RatingRow[];
  readonly moments: readonly Moment[];
  readonly next: string;
}

export function resultView(frame: Frame | null): ResultView | null {
  const b = frame?.board;
  const r = resultShown(frame) ? b?.result ?? null : null;
  if (!frame || !b || r === null) return null;
  const rate = tps(b);
  return {
    headline: resultHeadline(r, colonyNamesOf(b.setup)), winner: r.winner, how: resultHow(r, b.queens !== undefined),
    ratings: ratingResultRows(b.setup.rated, b.agents, r),
    moments: decisive(frame.story, r.reason, r.winner).map(m => ({
      when: matchTime(storyWhen(m, frame.tick), rate), what: storyText(m, b.agents, frame.tick, b.queens, true, colonyNamesOf(b.setup)).what, who: colonyNamesOf(b.setup)[m.colony], colony: m.colony,
    })),
    next: r.nextStartMs === null ? "Next match · not announced"
      : `Next match · ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(r.nextStartMs)}`,
  };
}

// ---------------------------------------------------------------- sharing the result

/**
 * One side's player(s) as the post names them: each distinct shown name in seat order (a seat's "#n" dropped, so one
 * player holding every seat is named once), a Benchmark's level and Fast in brackets after its name, joined with "&".
 */
export function sideNames(agents: readonly Pick<StreamAgent, "identity" | "colony" | "modelLabel" | "thinkingLevel" | "serviceTier">[], colony: Colony,
  colonyNames: ColonyNamePair = COLONY_NAMES): string {
  const names: string[] = [];
  agents.forEach((a, index) => {
    if (a.colony !== colony) return;
    let name: string;
    if (a.identity) {
      const seat = SEAT.exec(a.identity.displayName);
      const shown = rowName(seat ? seat[1]! : a.identity.displayName, undefined);
      name = namedText(shown);
    } else {
      // No identity (older recordings): the model as the HUD names it (compose.ts agentModel), never its key.
      const model = agentModel(a);
      name = model ? namedText(model) : agentHandle(index);
    }
    if (!names.includes(name)) names.push(name);
  });
  return names.length > 0 ? names.join(" & ") : colonyNames[colony];
}

/**
 * The post's text: "{winner} beat {loser} on Antwars — {how it ended}. Watch:
 * {url}", or "{A} and {B} drew on Antwars — …" for a draw; null without a shown result or a link to share.
 */
export function shareText(frame: Frame | null, url: string | null): string | null {
  const shown = resultView(frame);
  if (shown === null || url === null) return null;
  const agents = frame!.board!.agents, names = colonyNamesOf(frame!.board!.setup);
  const [a, b] = shown.winner === null ? [0, 1] as const : [shown.winner, (1 - shown.winner) as Colony];
  const players = shown.winner === null ? `${sideNames(agents, a, names)} and ${sideNames(agents, b, names)} drew` : `${sideNames(agents, a, names)} beat ${sideNames(agents, b, names)}`;
  return `${players} on Antwars — ${shown.how}. Watch: ${url}`;
}

/** The result's Share on X link: X's post intent with the text prefilled; null where there is nothing to share. */
export function shareHref(frame: Frame | null, url: string | null): string | null {
  const text = shareText(frame, url);
  return text === null ? null : `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------- the team section's agents

/**
 * A match in the Antwars Model Index, our harness's own (once called house matches), is marked setup.modelIndex
 * (src/live/hub.ts; decoded from the stream's house-idle presence) and shows a proven model; everywhere else each
 * agent names its own model. Every live match now carries houseIdleTicks.
 */
export const selfReported = (b: Pick<Board, "setup">): boolean => b.setup.modelIndex !== true;

/** A colony's result on its player line once the match has ended, the words a Matches row gives it (pages/matches.ts
 * colonyResult): Abandoned on both colonies of an abandoned match, Winner on the winning colony, Draw on both in a draw. */
export type ColonyResult = "Winner" | "Draw" | "Abandoned";
export function colonyResult(result: Pick<StreamResult, "winner" | "reason" | "decidedBy"> | null, colony: Colony): ColonyResult | null {
  if (result === null) return null;
  if (result.reason === "abandoned") return "Abandoned";
  if (result.winner !== null) return result.winner === colony ? "Winner" : null;
  return result.decidedBy === "draw" ? "Draw" : null;
}

/** The rating deviation beside a shown rating, "± 87" in whole points; "" where the stream carries none (older streams). */
export const rdShown = (identity: StreamAgent["identity"]): string =>
  identity?.elo !== undefined && identity.rd !== undefined ? `± ${Math.round(identity.rd)}` : "";

/**
 * The one player holding every seat of a colony, as its heading's player line reads it, in the Matches order: its name
 * (a builder's username, a Benchmark handle's house display name), the model it reported beside a builder's name with that
 * model's level and Fast badges (a Benchmark's fixed ones after its name), its rating (figure; rd its "± RD"), how many seats
 * it holds, and the colony's result once the match has ended.
 */
export interface Player {
  readonly name: string;
  readonly model: string;
  readonly badges: readonly string[];
  readonly elo: string;
  readonly rd: string;
  readonly seats: number;
  readonly result: ColonyResult | null;
}
/**
 * One agent's small row in its team section, under the colony name: its badge, then one player line in the Matches order:
 * its name, its model, its level and Fast badges, its rating, and the colony's result once the match has ended. Its order
 * and its calls are the history's.
 */
export interface Row {
  readonly index: number;
  readonly colony: Colony;
  readonly shade: string;
  readonly badge: string;
  /** The shown name as the Leaderboard names it (pages/model.ts nameParts), else the model. */
  readonly title: string;
  /** The model beside a name, as the HUD names it (compose.ts agentModel), never its provider/model key; "" where the
   * model is the title, the agent gave none, or the row is a Benchmark handle's. */
  readonly model: string;
  /** The model's level and tier badges, after it; empty where there is no model beside the name. */
  readonly modelBadges: readonly string[];
  /** Whether the row's title is a self-reported model (no identity, outside the Model Index): its asterisk follows it. A builder's row outside the Index carries none. */
  readonly asterisk: boolean;
  /** The title's badges: a Benchmark handle's fixed level and Fast, as the Leaderboard shows them; a self-reported model's
   * own when it is the title; else, where no model stands beside the name, the level the stream carries, as a badge. */
  readonly badges: readonly string[];
  readonly elo: string | null;
  /** "± RD" beside the rating, shown on hover, tap or focus; "" where the stream carries none. */
  readonly rd: string;
  readonly result: ColonyResult | null;
  /** Everything the row shows, for assistive technology: its visible title first, its badge's shape word last. */
  readonly label: string;
}
/**
 * One team member's icon in its colony's head, whose hover shows its handle, model and rating: its badge, and the lines its tip shows, only those the stream carries.
 */
export interface Member {
  readonly index: number;
  /** The agent's badge, at the head's 16 px. */
  readonly badge: string;
  /** The shown name (AgentEntry.name, as the Leaderboard names it), the model (modelLabel) and "Rating n" (the stream's Elo, worded as the deck words it since the Glicko switch), each only where the stream carries it; the badge's shape word where it carries none. */
  readonly lines: readonly string[];
  /** The icon's accessible name: its lines, then its badge's shape word. */
  readonly label: string;
}
export interface Group {
  readonly colony: Colony;
  readonly heading: string;
  /** Where one player holds every seat of a colony, its player line once, here, the name as the rows name it. */
  readonly player: Player | null;
  /** One icon per member in the head, in seat order. */
  readonly members: readonly Member[];
  /** One small row per agent, in seat order; none for one player, whose heading already names it once. */
  readonly rows: readonly Row[];
}

/** A member's icon: what its tip shows, nothing the stream does not carry. */
export function member(e: Pick<AgentEntry, "index" | "shade" | "name" | "model" | "elo">): Member {
  const shape = `badge ${agentHandle(e.index)}`;
  const carried = [e.name ?? "", e.model, e.elo !== null ? `Rating ${e.elo}` : ""].filter(Boolean);
  const lines = carried.length > 0 ? carried : [shape];
  return { index: e.index, badge: badge(e.index, e.shade, 16), lines, label: carried.length > 0 ? `${carried.join(" · ")} · ${shape}` : shape };
}
export interface Roster {
  readonly groups: readonly Group[];
  readonly count: number;
}

// The Leaderboard-style name lives in compose.ts, so every agent name shown anywhere uses it.
export { isBenchmark, rowName, type RowName };

/**
 * The one player holding every seat of a colony (a ranked team mode), or null: needs two seats or more, one name, one Elo,
 * and the same model, level and Fast on every seat. Each seat joins with its own report, so seats that differ keep their
 * own rows rather than all showing the first seat's.
 */
export function teamPlayer(agents: readonly Pick<StreamAgent, "identity" | "modelLabel" | "thinkingLevel" | "serviceTier">[]): { readonly name: string; readonly elo: string } | null {
  if (agents.length < 2) return null;
  const report = (a: Pick<StreamAgent, "modelLabel" | "thinkingLevel" | "serviceTier">) => [a.modelLabel ?? "", a.thinkingLevel ?? "", a.serviceTier ?? ""].join("\n");
  let name: string | null = null, elo: number | null = null, reported: string | null = null;
  for (const a of agents) {
    const seat = a.identity ? SEAT.exec(a.identity.displayName) : null;
    if (!seat || !a.identity) return null;
    if (name === null) { name = seat[1]!; elo = a.identity.elo ?? null; reported = report(a); }
    else if (seat[1] !== name || (a.identity.elo ?? null) !== elo || report(a) !== reported) return null;
  }
  return name === null || elo === null ? null : { name, elo: eloText(elo) };
}

/** One agent's line parts: its title and badges, the model beside it with that model's badges, and its asterisk. */
function lineParts(a: StreamAgent, reported: boolean) {
  // Named from the raw identity, so a Benchmark handle is still known as one (e.name is already the shown name).
  const named = a.identity ? rowName(a.identity.displayName, a.thinkingLevel) : null;
  // A builder in a non-Index match: the user holds the rating and may switch models, so the row names only this
  // match's model, with no asterisk.
  const builder = reported && named !== null;
  // The model as the HUD names it, with its own badges; without an identity it is the title and its badges the title's.
  const shownModel = agentModel(a);
  // A builder whose label only repeats its own name ("coffee-ant/local" on coffee-ant) shows its name alone, as on a Matches
  // line (pages/model.ts seatModelName).
  const handle = a.identity ? SEAT.exec(a.identity.displayName)?.[1] ?? a.identity.displayName : null;
  const repeats = handle !== null && a.modelLabel !== "" && seatModelName(a.modelLabel, handle) === handle;
  const beside = named !== null && !named.benchmark && !repeats ? shownModel : null;
  // A level the stream carries with no model to badge it is a badge after the name, never quiet text; a builder outside the
  // Index shows a level only with a model, as on a Matches line.
  const level = !builder && beside === null && (named === null ? shownModel === null : !named.benchmark) && a.thinkingLevel ? [a.thinkingLevel] : [];
  const badges = named?.benchmark ? named.badges : named === null && shownModel !== null ? shownModel.badges : level;
  const title = named?.name ?? shownModel?.name ?? "";
  // Without an identity the self-reported model is the title itself, and its asterisk follows it.
  const asterisk = reported && named === null && shownModel !== null;
  return { named, title, badges, beside, model: beside?.name ?? "", modelBadges: beside?.badges ?? [], asterisk };
}

export function roster(frame: Frame): Roster {
  const b = frame.board!;
  const reported = selfReported(b);
  const entries = agentEntries(frame);
  const groups: Group[] = [];
  for (const colony of COLONIES) {
    const members = entries.filter(e => e.colony === colony).sort((x, y) => x.index - y.index);
    if (members.length === 0) continue;
    const result = colonyResult(b.result, colony);
    // The one player's line as the rows name it: a Benchmark handle's house display name, any other its own.
    const first = b.agents[members[0]!.index]!;
    const found = teamPlayer(members.map(e => b.agents[e.index]!));
    const player: Player | null = found && (() => {
      const parts = lineParts(first, reported);
      return { name: rowName(found.name, undefined).name, model: parts.model, badges: [...parts.badges, ...parts.modelBadges],
        elo: found.elo, rd: rdShown(first.identity), seats: members.length, result };
    })();
    // One player: its heading carries its line once and its member icons are the player icons.
    const rows = player ? [] : members.map((e): Row => {
      const a = b.agents[e.index]!;
      const handle = agentHandle(e.index);
      const { named, title, badges, beside, model, modelBadges, asterisk } = lineParts(a, reported);
      const rd = rdShown(a.identity);
      // The accessible name leads with the shown name in full, then its badges.
      const shown = named ? [named.name, ...badges].join(" ") : title ? [title, ...badges].join(" ") : handle;
      const label = [shown, e.elo ? `Rating ${e.elo}${rd ? ` ${rd}` : ""}` : "", colonyNamesOf(b.setup)[colony], beside ? namedText(beside) : "", asterisk ? "self-reported" : "",
        result ?? "", e.name || e.model ? `badge ${handle}` : ""].filter(Boolean).join(" · ");
      return { index: e.index, colony, shade: e.shade, badge: e.badge, title, model, modelBadges, asterisk, badges, elo: e.elo, rd, result, label };
    });
    groups.push({ colony, heading: `${colonyNamesOf(b.setup)[colony]} · ${members.length} ${members.length === 1 ? "agent" : "agents"}`, player, members: members.map(member), rows });
  }
  return { groups, count: groups.reduce((n, g) => n + g.rows.length, 0) };
}

// ---------------------------------------------------------------- the Selected card

export type Selected =
  | { readonly kind: "none" }
  | { readonly kind: "ant"; readonly key: string; readonly colony: Colony; readonly title: string; readonly line: string }
  | {
    readonly kind: "agent"; readonly key: string; readonly index: number; readonly colony: Colony; readonly shade: string; readonly badge: string;
    readonly title: string; readonly model: string; readonly asterisk: boolean;
    /** The model's level and tier badges, after the model (or after the title where the model is the title). */
    readonly badges: readonly string[];
    /** The agent's Elo where it has one, else ""; the card sits under its colony's heading, which names the colony. */
    readonly sub: string;
    /** "Squad order: …" (agentCard), and whether its tile can be lit on the board (go to, attack, hold). */
    readonly order: string; readonly target: boolean;
    /** The card's other lines: a standing thought and the call interval. */
    readonly lines: readonly string[];
    readonly history: readonly AgentLineModel[];
  };
export const NOTHING: Selected = { kind: "none" };

/**
 * The query panel for whatever the board or the table picked (cardSubject): an agent's card lines, without the
 * "self-reported model" editorial, and its recent thoughts and marks; or an ant outside
 * a squad, as today's card names it.
 */
export function selected(frame: Frame | null, picked: AntInfo | null, pickedAgent: number): Selected {
  const b = frame?.board;
  if (!frame || !b) return NOTHING;
  const { ant, agent } = cardSubject(picked, pickedAgent);
  const a = agent >= 0 ? b.agents[agent] : undefined;
  if (a) {
    const colony = a.colony as Colony;
    const shade = cssColour(agentShade(a.colony, agent, b.agents));
    const name = a.identity?.displayName ?? null;
    const shownModel = agentModel(a);
    const detail = agentDetail(frame, agent);
    const orderLine = `Squad order: ${orderText(a, orderTarget(a.orderX, a.orderY, b))}`;
    return {
      kind: "agent", key: `agent:${agent}`, index: agent, colony, shade, badge: badge(agent, shade, 18),
      // The name as the rows name it; the model beside it and its asterisk are unchanged.
      title: name !== null ? rowName(name, a.thinkingLevel).name : shownModel?.name ?? agentHandle(agent),
      model: name ? shownModel?.name ?? "" : "", badges: shownModel?.badges ?? [], asterisk: selfReported(b) && a.modelLabel !== "",
      sub: a.identity?.elo !== undefined ? `Rating ${eloText(a.identity.elo)}` : "",
      order: orderLine, target: a.order === "go_to" || a.order === "attack" || a.order === "hold",
      lines: (detail?.lines ?? []).filter(line => !line.startsWith(`${MODEL_LABEL}:`) && !line.startsWith("Squad order:")),
      history: detail?.history ?? [],
    };
  }
  if (ant && ant.agent < 0) {
    const colony = ant.colony as Colony;
    return { kind: "ant", key: `ant:${ant.antId}`, colony, title: `Ant ${ant.antId} · ${colonyNamesOf(b.setup)[colony]}`, line: PAGE_WORDS.noSquad };
  }
  return NOTHING;
}

/** The line's colony name, to say before a figure a screen reader hears without its column: the match's own (setup), else the rated names. */
export const colonyName = (colony: Colony, setup?: Pick<Board["setup"], "colonyNames"> | null): string => colonyNamesOf(setup)[colony];

/** A drawn colony name's one-line source note, shown as its tooltip; empty for the rated names, which are shown as they were. */
export const colonyNote = (colony: Colony, setup?: Pick<Board["setup"], "colonyNames"> | null): string =>
  setup?.colonyNames ? colonyNameNote(colonyName(colony, setup)) ?? "" : "";
