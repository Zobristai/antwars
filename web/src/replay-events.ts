/** The replay scrubber's marks: the moments a watcher looks for, derived from a recording's own messages.
 * Everything here is read from the recording the viewer can already play, so a mark tells nothing playback would not. */
import type { StreamMessage } from "../../src/live/format.ts";
import { TICK_HZ, TICK_MS, type Colony } from "../../src/live/snapshot.ts";

export type ReplayEventKind = "fight" | "nest" | "food";

export interface ReplayEvent {
  readonly kind: ReplayEventKind;
  /** The recorded tick the mark stands at. */
  readonly tick: number;
  /** Playback time of that tick, from the recording's first tick (the scrubber's scale). */
  readonly ms: number;
  /** Nest lost: the colony that lost it. Food lead: the colony that took it. A fight belongs to neither. */
  readonly colony: Colony | null;
}

/** A fight ends once this long passes with no bite. */
export const FIGHT_QUIET_TICKS = 5 * TICK_HZ;
/** A fight is marked only when at least this many ants died in it (both colonies). */
export const FIGHT_MIN_DEATHS = 20;
/** The food lead changes sides only by more than the larger of this share of all food gathered... */
export const FOOD_LEAD_MARGIN = 0.02;
/** ...and this much food, so the first trickle of deliveries does not flip it back and forth. */
export const FOOD_LEAD_FLOOR = 50;

/** Fed every message of one recording in order; `events()` returns its marks, in tick order.
 * - Fight: a run of ticks with bites, ending after FIGHT_QUIET_TICKS with none, marked at its first bite when
 *   at least FIGHT_MIN_DEATHS ants died from that bite until the run ended.
 * - Nest lost: each queen lost, at the message that reports it. Recordings without a queen list: the overrun end.
 * - Food lead: the colony that has gathered more food so far (store increases; hatching never lowers it) changes,
 *   by more than the margin. The match's first lead is not a change. Recordings without stores have none. */
export class ReplayEventScan {
  private first: number | null = null;
  private readonly out: ReplayEvent[] = [];
  private run: { start: number; last: number; deaths: number } | null = null;
  private store: [number, number] | null = null;
  private readonly gathered: [number, number] = [0, 0];
  private leader: Colony | null = null;
  private queenList = false;
  private readonly lost = new Set<string>();

  push(m: StreamMessage): void {
    if (this.first === null) {
      this.first = m.tick;
      this.queenList = m.full?.queens !== undefined;
      const stores = m.full?.stores;
      if (stores) this.store = [stores[0].food, stores[1].food];
    }
    for (const q of m.full?.queens ?? []) if (q.lostTick !== null) this.nest(q.colony, q.id, m.tick);
    if (this.run && m.tick - this.run.last > FIGHT_QUIET_TICKS) this.closeRun();
    let bites = 0;
    let deaths = 0;
    for (const e of m.events) {
      if (e.kind === "fight") bites++;
      else if (e.kind === "death") deaths++;
      else if (e.kind === "queenLost") this.nest(e.queen.colony, e.queen.id, m.tick);
      else if (e.kind === "store" && this.store) {
        const before = this.store[e.colony];
        if (e.food > before) this.gathered[e.colony] += e.food - before;
        this.store[e.colony] = e.food;
      } else if (e.kind === "end" && !this.queenList) {
        const { reason, winner } = e.result;
        if (reason === "double_overrun") for (const c of [0, 1] as const) this.nest(c, 0, m.tick);
        else if (reason === "overrun" && winner !== null) this.nest(winner === 0 ? 1 : 0, 0, m.tick);
      }
    }
    if (bites > 0) {
      if (this.run) this.run.last = m.tick;
      else this.run = { start: m.tick, last: m.tick, deaths: 0 };
    }
    if (this.run) this.run.deaths += deaths;
    const [a, b] = this.gathered;
    const need = Math.max(FOOD_LEAD_MARGIN * (a + b), FOOD_LEAD_FLOOR);
    const lead: Colony | null = a - b > need ? 0 : b - a > need ? 1 : null;
    if (lead !== null && lead !== this.leader) {
      if (this.leader !== null) this.add("food", m.tick, lead);
      this.leader = lead;
    }
  }

  /** The marks so far, closing a fight still running at the recording's end. */
  events(): ReplayEvent[] {
    this.closeRun();
    return [...this.out].sort((x, y) => x.tick - y.tick);
  }

  private closeRun(): void {
    if (this.run && this.run.deaths >= FIGHT_MIN_DEATHS) this.add("fight", this.run.start, null);
    this.run = null;
  }

  private nest(colony: Colony, id: number, tick: number): void {
    const key = `${colony}:${id}`;
    if (this.lost.has(key)) return;
    this.lost.add(key);
    this.add("nest", tick, colony);
  }

  private add(kind: ReplayEventKind, tick: number, colony: Colony | null): void {
    this.out.push({ kind, tick, ms: (tick - this.first!) * TICK_MS, colony });
  }
}
