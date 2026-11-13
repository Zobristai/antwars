// The spectator HUD agent panel model: read from the delayed playback frame only.
// Every value comes from the stream through the existing HUD helpers; nothing here draws or invents data.
import { RULES_NAMES, rulesConfig, type SimConfig } from "../../../src/sim/config.ts";
import { colonyNamesOf } from "../../../src/sim/colonyNames.ts";
import { isIdle, type OrderKind, type StreamMark } from "../../../src/live/format.ts";
import type { Board, ChatLine, Frame } from "../buffer.ts";
import { MODEL_LABEL, agentCard, cardSubject, matchTime, orderTarget, orderText, THOUGHT_LABEL, type AntInfo } from "../overlays.ts";
import { agentModelText, modelLine, playerLabel, rowName } from "../compose.ts";
import { agentShade, cssColour } from "../squads.ts";
import { boardQueenHp } from "../variant.ts";
import { isCountMark, markLabel, markReading } from "../words.ts";
import { badge } from "./icons.ts";

export type Colony = 0 | 1;
const TPS_FALLBACK = 10;
export const tps = (b: Board) => b.setup.ticksPerSecond || TPS_FALLBACK;

// ------------------------------------------------------------------ the rules a board plays

/**
 * The rules this board plays, only where the stream identifies them: a named comparison run, or streamed queen HP
 * (the redesign rules, as web/src/variant.ts reads them). An unnamed board without HP may be a recording of older
 * rules the stream does not name, so nothing here asserts a rule for it.
 */
export function boardRules(b: Pick<Board, "setup" | "queens">): SimConfig | null {
  const name = b.setup.rules ?? (boardQueenHp(b) !== undefined ? "redesign" : undefined);
  return name !== undefined && (RULES_NAMES as readonly string[]).includes(name) ? rulesConfig(name) : null;
}

/** One thought or mark: a thought's own words, or a mark's symbol and compact count (as the board labels it). */
export interface AgentLineModel {
  line: ChatLine;
  kind: "thought" | "mark";
  /** A word mark is the agent's own words, quoted like a thought; a count mark reads as its symbol and count. */
  words: boolean;
  verb: string | undefined;
  live: boolean;
  /** What the line shows: quoted words, or the compact count ("any · 12/20"). */
  text: string;
  /** The whole reading for assistive technology and the pointer's title (overlays.ts chatLine's words). */
  reading: string;
  when: string;
}

export function liveMarks(frame: Frame): Map<number, StreamMark> {
  return new Map(frame.marks.map(m => [m.mark.id, m.mark]));
}

export function agentLine(line: ChatLine, frame: Frame, live: ReadonlyMap<number, StreamMark>): AgentLineModel {
  const rate = tps(frame.board!);
  const when = matchTime(line.tick, rate);
  if (line.kind === "intent") {
    return { line, kind: "thought", words: true, verb: undefined, live: false, text: `“${line.text}”`, reading: `Thought, ${when}: “${line.text}”`, when };
  }
  const mark = live.get(line.markId);
  const source = mark ?? line;
  const words = !isCountMark(line);
  const reading = markReading(source);
  const count = source.count === undefined ? "" : `${source.caste === undefined ? "" : `${source.caste} · `}${source.count}`;
  return {
    line, kind: "mark", words, verb: source.verb, live: mark !== undefined,
    text: words ? reading : markLabel(source) ?? count,
    reading: `Mark, ${when}: ${reading}${mark === undefined ? ", no longer on the board" : ""}`, when,
  };
}

/**
 * An agent's standing thought once its own lines have left the chat window (CHAT_LINES in buffer.ts): the board
 * still carries its intent, though not when it was stated, so the line goes undated rather than blank.
 */
function standingThought(text: string, agent: number, colony: Colony): AgentLineModel {
  const line: ChatLine = { kind: "intent", tick: -1, agent, colony, text, words: [], markId: -1, tileX: 0, tileY: 0, laidTick: -1 };
  return { line, kind: "thought", words: true, verb: undefined, live: false, text: `“${text}”`, reading: `Thought: “${text}”`, when: "" };
}

export interface AgentEntry {
  index: number;
  colony: Colony;
  shade: string;
  badge: string;
  /** The identity's name as the Leaderboard shows it (compose.ts rowName) where the stream carries one; else none, the badge being the agent's identity. */
  name: string | null;
  model: string;
  elo: string | null;
  idle: boolean;
  order: { kind: OrderKind; guard: boolean; text: string; target: Colony | null };
  latest: AgentLineModel | null;
  /** The row's whole reading for assistive technology. */
  label: string;
}

/** Each agent of the board, its newest thought or mark beside it (frame.chat, newest last), else its standing thought. */
export function agentEntries(frame: Frame): AgentEntry[] {
  const b = frame.board!;
  const live = liveMarks(frame);
  const newest = new Map<number, ChatLine>();
  for (const line of frame.chat) newest.set(line.agent, line);
  return b.agents.map((a, index): AgentEntry => {
    const colony = a.colony as Colony;
    const shade = cssColour(agentShade(a.colony, index, b.agents));
    const target = orderTarget(a.orderX, a.orderY, b);
    const directed = a.order === "go_to" || a.order === "attack";
    const guard = directed && !!target?.liveQueen && target.colony === a.colony;
    const text = orderText(a, target);
    const idle = isIdle(a, frame.tick, b.setup.idleTicks, b.setup.houseIdleTicks);
    const elo = a.identity?.elo === undefined ? null : String(Math.round(a.identity.elo));
    const line = newest.get(index);
    return {
      index, colony, shade, badge: badge(index, shade), name: a.identity ? rowName(a.identity.displayName, undefined).name : null, model: agentModelText(a), elo, idle,
      order: { kind: a.order, guard, text, target: directed && target ? target.colony : null },
      latest: line ? agentLine(line, frame, live) : a.intent ? standingThought(a.intent, index, colony) : null,
      label: [playerLabel(index, a), colonyNamesOf(b.setup)[colony], modelLine(a, MODEL_LABEL), text, idle ? "idle" : ""]
        .filter(Boolean).join(" · "),
    };
  });
}

/** An opened agent: its card's lines that the row does not already show (overlays.ts agentCard), and its recent lines. */
export function agentDetail(frame: Frame, agent: number, recent = 6): { lines: string[]; history: AgentLineModel[] } | null {
  const b = frame.board;
  const a = b?.agents[agent];
  if (!b || !a) return null;
  const card = agentCard(agent, a, b.marks, frame.tick, tps(b), orderTarget(a.orderX, a.orderY, b), colonyNamesOf(b.setup));
  const live = liveMarks(frame);
  const history: AgentLineModel[] = [];
  for (let i = frame.chat.length - 1; i >= 0 && history.length < recent; i--) {
    const line = frame.chat[i]!;
    if (line.agent === agent) history.push(agentLine(line, frame, live));
  }
  // The card's title is the row; its latest mark is the history's, and so is its thought while the history holds one.
  const dated = history.some(l => l.kind === "thought");
  const lines = card.slice(1).filter(line => !(dated && line.startsWith(`${THOUGHT_LABEL}:`)) && !line.startsWith("Latest active mark") && line !== "No active marks")
    // The model takes its own line under its label, so a long model and its level stay on one line.
    .map(line => line.startsWith(`${MODEL_LABEL}: `) ? `${MODEL_LABEL}:\n${line.slice(MODEL_LABEL.length + 2)}` : line);
  return { lines, history };
}

/** The agent a selection opens in the list: the selected agent, or a clicked ant's (overlays.ts cardSubject). */
export function openAgent(selected: AntInfo | null, selectedAgent: number): number {
  return cardSubject(selected, selectedAgent).agent;
}
