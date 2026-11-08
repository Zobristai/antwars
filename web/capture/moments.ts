/**
 * The moments of a recording the stills show (the redesign's stills contract):
 * a mark with its owner, the colonies in action, a queen under attack and a colony's fall, with
 * the result that follows it. Each is read from the recording's own messages, so the scenes
 * follow the match rather than fixed ticks; a moment the recording never reaches is null and its
 * scene is reported as missing, never rendered from another tick.
 */
import type { StreamMessage } from "../../src/live/format.ts";
import { SUB_TILE, TICK_MS } from "../../src/live/snapshot.ts";
import { HIT_FLASH_MS, MARK_LIFE_MS, QUEEN_COLLAPSE_MS, RESULT_BEAT_MS } from "../src/buffer.ts";

export interface Moments {
  /** A few seconds after the sixth mark laid (or the last, in a quieter match): several marks ring the board with their owners' glyphs. */
  mark: number | null;
  /** The message with the most bites between ants: both colonies' squads, marks and free ants at work. */
  action: number | null;
  /**
   * The tick after a bite on the queen whose loss is the fall, the latest at least ATTACK_LEAD_MS before it: her emblem flashing, "Queen N under attack — H HP" on the lower third, her HP bars falling, the
   * fall still to come. Without a fall, the tick after the bite that brought a queen lowest while she lived.
   */
  attack: number | null;
  /** Half-way into the collapse of the queen whose loss left her colony with none standing: the colony falling, not a queen before it. */
  fall: number | null;
  /** The match's end, once the result card has followed the fall by its beat. */
  result: number | null;
}

/** Ticks after a mark's message before its scene, so the marker has faded in (words.ts FADE_IN_MS) and more marks have joined it. */
const MARK_SETTLE_TICKS = 15;
const MARKS_BEFORE_SCENE = 6;
/** The under-attack scene leads the fall by at least this long, so her HP is seen falling with the fall still to come. */
const ATTACK_LEAD_MS = 2000;

export function sceneMoments(messages: readonly StreamMessage[]): Moments {
  const tps = messages[0]?.full?.setup.ticksPerSecond || 10;
  const ticks = (ms: number) => Math.ceil((ms * tps) / 1000);
  const markTicks: number[] = [];
  let bestFights = 0;
  let action: number | null = null;
  const lastHp = new Map<string, number>();
  // Each colony's standing queens, from the first snapshot and the queen events: the fall is the loss that leaves a colony none.
  const standing: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const q of messages[0]?.full?.queens ?? []) {
    if (q.hp !== undefined) lastHp.set(`${q.colony}:${q.id}`, q.hp);
    if (q.lostTick === null) standing[q.colony].add(q.id);
  }
  let lowest: { tick: number; hp: number } | null = null;
  /** Each bite that left a queen alive (an HP drop), by queen, in message order. */
  const bites: { key: string; tick: number }[] = [];
  let fall: number | null = null;
  let fallKey: string | null = null;
  let end: number | null = null;
  for (const m of messages) {
    let fights = 0;
    for (const e of m.events) {
      if (e.kind === "mark") markTicks.push(m.tick);
      else if (e.kind === "fight") fights++;
      else if (e.kind === "queenHp") {
        const key = `${e.colony}:${e.queenId}`;
        const before = lastHp.get(key);
        if (before !== undefined && e.hp < before && e.hp > 0) {
          bites.push({ key, tick: m.tick });
          if (lowest === null || e.hp < lowest.hp) lowest = { tick: m.tick, hp: e.hp };
        }
        lastHp.set(key, e.hp);
      } else if (e.kind === "queenFounded") standing[e.queen.colony].add(e.queen.id);
      else if (e.kind === "queenLost") {
        standing[e.queen.colony].delete(e.queen.id);
        if (standing[e.queen.colony].size === 0 && fall === null) {
          fall = m.tick;
          fallKey = `${e.queen.colony}:${e.queen.id}`;
        }
      } else if (e.kind === "end") end ??= m.tick;
    }
    if (fights > bestFights) {
      bestFights = fights;
      action = m.tick;
    }
  }
  const markLaid = markTicks[Math.min(MARKS_BEFORE_SCENE, markTicks.length) - 1];
  const last = messages.at(-1)?.tick ?? 0;
  const lastMark = markTicks.at(-1);
  // The attack: the fallen queen's latest bite at least ATTACK_LEAD_MS before the fall, else her latest before it, else
  // the bite that brought a queen lowest while she lived.
  const hers = fall === null ? [] : bites.filter((b) => b.key === fallKey && b.tick < fall!);
  const attack = hers.filter((b) => b.tick <= fall! - ticks(ATTACK_LEAD_MS)).at(-1) ?? hers.at(-1) ?? lowest;
  return {
    mark: markLaid === undefined ? null : Math.min(last, markLaid + MARK_SETTLE_TICKS),
    // Before any bite between ants (the combat grace), the colonies are at work around their newest mark.
    action: action ?? (lastMark === undefined ? null : Math.min(last, lastMark + MARK_SETTLE_TICKS)),
    // One tick into the flash: bright, and the HP readouts already down.
    attack: attack === null ? null : Math.min(last, attack.tick + 1),
    // Half-way into the last queen's collapse, which plays on past a recording's last message (buffer.ts
    // Frame.targetMs) and runs from the message that carried the loss: the view turned onto her, her emblem
    // half gone, the row reading lost, the colony's sides of the bug and dock dimming, the result card still to come.
    fall: fall === null ? null : fall + Math.max(1, Math.round(ticks(QUEEN_COLLAPSE_MS) / 2)),
    result: end === null ? null : end + ticks(RESULT_BEAT_MS + HIT_FLASH_MS),
  };
}

/** The stills' squad tap: which agent's ant to tap, and when. */
export interface SquadTap {
  /** The message tick: the agent's squad is the largest of any then, and one of its ants stands on the tile of a live mark of its own, or a tile adjacent to it. */
  tick: number;
  agent: number;
  /** The squad's ants at that tick. */
  squad: number;
}

/**
 * The ticks for the squad tap (so the directions' squad-tap stills compare
 * like with like), nearest `near` first (the action moment, where the squad tap has always been; the
 * earlier of two as near), at most `limit` of them: each a tick at which an agent whose squad is the
 * largest then (the lowest index among equals that qualify) has an ant on the tile of one of its own
 * marks still shown (laid, not gone, within MARK_LIFE_MS of its first showing, as the board draws
 * them), or on a tile adjacent to it. The stills try
 * them in turn on each viewport, since the ant must also stand on the uncovered board there. Empty
 * when no tick qualifies: the scene cannot show the rule on this recording.
 */
export function squadTapCandidates(messages: readonly StreamMessage[], near: number, limit = Infinity): SquadTap[] {
  const tps = messages[0]?.full?.setup.ticksPerSecond || 10;
  const lifeTicks = Math.ceil((MARK_LIFE_MS * tps) / 1000);
  /** Each mark on the board, by id: its owner, tile and the tick it was first shown from. */
  const marks = new Map<number, { agent: number; tileX: number; tileY: number; shown: number }>();
  const found: SquadTap[] = [];
  for (const m of messages) {
    if (m.full !== null) for (const mk of m.full.marks) marks.set(mk.id, { agent: mk.agent, tileX: mk.tileX, tileY: mk.tileY, shown: Math.min(m.tick, mk.laidTick + 1) });
    for (const e of m.events) {
      // A count mark re-laid or whose claims changed comes as another mark event: its first showing stands.
      if (e.kind === "mark") marks.set(e.mark.id, { agent: e.mark.agent, tileX: e.mark.tileX, tileY: e.mark.tileY, shown: marks.get(e.mark.id)?.shown ?? m.tick });
      else if (e.kind === "markGone") marks.delete(e.markId);
    }
    const ants = m.ants;
    const sizes = new Map<number, number>();
    for (let i = 0; i < ants.count; i++) if (ants.agent[i]! >= 0) sizes.set(ants.agent[i]!, (sizes.get(ants.agent[i]!) ?? 0) + 1);
    const largest = Math.max(0, ...sizes.values());
    if (largest === 0) continue;
    for (const agent of [...sizes].filter(([, n]) => n === largest).map(([a]) => a).sort((a, b) => a - b)) {
      const own = [...marks.values()].filter((mk) => mk.agent === agent && m.tick >= mk.shown && m.tick - mk.shown < lifeTicks);
      let stands = false;
      for (let i = 0; i < ants.count && !stands; i++) {
        if (ants.agent[i] !== agent) continue;
        const tx = Math.floor(ants.x[i]! / SUB_TILE);
        const ty = Math.floor(ants.y[i]! / SUB_TILE);
        stands = own.some((mk) => Math.abs(mk.tileX - tx) <= 1 && Math.abs(mk.tileY - ty) <= 1);
      }
      if (!stands) continue;
      found.push({ tick: m.tick, agent, squad: largest });
      break;
    }
  }
  return found.sort((a, b) => Math.abs(a.tick - near) - Math.abs(b.tick - near) || a.tick - b.tick).slice(0, limit);
}

/** The squad tap's first choice: the qualifying tick nearest `near`, or null when none qualifies. */
export function squadTapMoment(messages: readonly StreamMessage[], near: number): SquadTap | null {
  return squadTapCandidates(messages, near, 1)[0] ?? null;
}

/** How a recording's match ended, from its end event: the message tick, the stream's reason and what it was decided on, and the winner; null before any end. */
export function matchEnd(messages: readonly StreamMessage[]): { tick: number; reason: string; decidedBy: string; winner: number | null } | null {
  for (const m of messages) {
    for (const e of m.events) if (e.kind === "end") return { tick: m.tick, reason: e.result.reason, decidedBy: e.result.decidedBy, winner: e.result.winner };
  }
  return null;
}

/**
 * The clock time (ms) at which the delayed playback shows a tick, as the capture tools step it. A recording
 * plays from its first message, which the client takes as arriving at clock 0 (web/src/main.ts feeds message
 * i at i × TICK_MS; buffer.ts Playback anchors its tick there), so the clock counts from that message's tick,
 * `firstTick`: a recording captured mid-match is stepped to its own ticks, not past its last message.
 */
export function clockAt(tick: number, renderDelayMs: number, firstTick = 0): number {
  return renderDelayMs + (tick - firstTick) * TICK_MS;
}
