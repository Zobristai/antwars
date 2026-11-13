/**
 * The spectator model: turns the sim's state and step events into
 * one stream record per tick, and keeps the whole-board state a full message
 * needs by applying those records in order.
 *
 * Model labels, calls, orders and intent lines are read from the sim's step
 * events, so a match re-simulated from its JSONL log streams them too.
 * Territory, mark expiry, each
 * mark's answered count, tile food and the colonies' stores are read
 * as differences between consecutive states.
 */
import { SUB } from "../sim/config.js";
import { gridScaleOf } from "../sim/gridScale.js";
import { activeQueens, cloneState, queensOf } from "../sim/map.js";
import { startBoxes } from "../sim/startPlacement.js";
import { nextCaste, queenNextCaste } from "../sim/forage.js";
import type { SimEvent, SimState, StepOutput } from "../sim/types.js";
import { asTwoColony, WORDS } from "../sim/types.js";
import {
  ORDER_KINDS,
  SUB_TILE,
  type StreamAgent,
  type StreamAnts,
  type StreamEvent,
  type StreamFull,
  type StreamHatch,
  type StreamIdentity,
  type StreamMark,
  type StreamMessage,
  type StreamQueen,
  type StreamResult,
  type StreamSetup,
  type StreamStore,
  type StreamTerritoryWin,
} from "./format.js";

/** What one tick contributes to the stream: every ant, and the events of the step that completed it. */
export interface TickRecord {
  readonly tick: number;
  readonly ants: StreamAnts;
  readonly events: StreamEvent[];
}

const TAU = Math.PI * 2;

/**
 * The stream's text limits: a model label is sent as
 * at most 64 UTF-8 bytes and an intent line as at most 80, so a full snapshot
 * of 50 agents stays inside the 25 KB message budget whatever script they use.
 */
export const LABEL_BYTES = 64;
/** 32 Unicode code points, including four-byte characters, without truncation. */
export const THINKING_LEVEL_BYTES = 128;
/** The service tier's same 32-code-point limit (src/mcp/config.ts serviceTierMaxChars). */
export const SERVICE_TIER_BYTES = 128;
export const INTENT_BYTES = 80;

const utf8 = new TextEncoder();

/** text cut to at most maxBytes of UTF-8 at a character boundary; text within the limit is returned whole. */
export function cutUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes || utf8.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return text.slice(0, end);
}

function toSubTile(v: number, tiles: number): number {
  const s = Math.round((v * SUB_TILE) / SUB);
  return s < 0 ? 0 : s > tiles * SUB_TILE - 1 ? tiles * SUB_TILE - 1 : s;
}

export function setupOf(state: SimState): StreamSetup {
  const c = state.config;
  const queen = (i: 0 | 1): [number, number] => [toSubTile(state.colonies[i].queenX, c.mapWidth), toSubTile(state.colonies[i].queenY, c.mapHeight)];
  return {
    mapW: c.mapWidth,
    mapH: c.mapHeight,
    gridScale: gridScaleOf(c),
    ...(c.initialQueens === undefined ? {} : {
      startBoxes: startBoxes(c),
      startingQueenIds: [c.initialQueens[0].map((_, id) => id), c.initialQueens[1].map((_, id) => id)] as [number[], number[]],
    }),
    ...(state.terrain === undefined ? {} : { terrain: { mapId: state.terrain.mapId, mapName: state.terrain.mapName,
      water: state.terrain.water.map(r => [r.x, r.y, r.width, r.height] as const),
      ...(state.terrain.rocks === undefined ? {} : { rocks: state.terrain.rocks.map(r => [r.x, r.y, r.width, r.height, r.appearance] as const) }) } }),
    ticksPerSecond: c.ticksPerSecond,
    matchTicks: c.matchTicks,
    idleTicks: c.commandIdleTicks ?? c.squadTimerTicks,
    ...(c.commandIdleTicks === undefined ? {} : { commandIdleTicks: c.commandIdleTicks }),
    overrunRadiusTiles: c.overrunRadiusTiles,
    queens: [queen(0), queen(1)],
    // Comparison runs carry their rules, seed and player count in the live header.
    ...(c.rules === undefined ? {} : { rules: c.rules, seed: state.seed, ...(c.players === undefined ? {} : { players: c.players }) }),
  };
}

export function hatchOf(state: SimState): StreamHatch {
  const c = state.config;
  return { cost: c.hatchCost, intervalTicks: c.hatchIntervalTicks, cap: c.colonyCap };
}

/**
 * Each colony's food store, the first sim tick a queen may hatch again (the sim's own
 * hatch interval rule) and the food that hatch needs: hatchCost, or with the rules switch
 * on the cost of the caste the sim picks, as hatch() charges it. With queens, the earliest
 * live queen gives both, ties to the first in array order as hatch() visits them; her
 * caste is queenNextCaste's, which is the colony's nextCaste except for a rules-27 colony
 * with an agent, where each queen hatches her own brood.
 */
export function storesOf(state: SimState): [StreamStore, StreamStore] {
  const { config } = state;
  const intervalOf = (soldier: boolean) => config.hatchIntervalTicks * (soldier ? config.hatchTiming?.soldierIntervalMultiplier ?? 1 : 1);
  const store = (i: 0 | 1): StreamStore => {
    const colony = state.colonies[i];
    let soldier = config.castes !== undefined && nextCaste(state, colony) === "soldier";
    let nextHatchTick = colony.lastHatchTick + intervalOf(soldier);
    if (colony.queens !== undefined) {
      let earliest = Infinity;
      for (const queen of activeQueens(colony)) {
        const own = config.castes !== undefined && queenNextCaste(state, colony, queen) === "soldier";
        const ready = queen.lastHatchTick + intervalOf(own);
        if (ready < earliest) { earliest = ready; soldier = own; }
      }
      nextHatchTick = Math.min(earliest, config.matchTicks);
    }
    return { food: colony.foodStore, nextHatchTick, nextCost: soldier ? config.castes!.soldierCost : config.hatchCost };
  };
  return [store(0), store(1)];
}

export function streamResult(result: NonNullable<SimState["result"]>, nextStartMs: number | null): StreamResult {
  return { winner: result.winner === null ? null : asTwoColony(result.winner), reason: result.reason, decidedBy: result.decidedBy, tick: result.tick, nextStartMs };
}

/** Read the evaluator's existing progress; never re-evaluate territory qualification here.
 * state.tick counts completed steps, while progress includes the step at state.tick - 1.
 */
export function territoryWinOf(state: SimState): StreamTerritoryWin | undefined {
  const progress = state.earlyWinProgress, rules = state.config.earlyWin;
  if (state.result !== null || rules === undefined || progress?.leader == null || progress.ticks <= 0) return undefined;
  const startTick = state.tick - progress.ticks;
  return { colony: asTwoColony(progress.leader), startTick, winTick: startTick + rules.holdTicks - 1 };
}

export interface SpectatorPlayerOptions {
  /** Explicit adapter projection of the accepted-call idle clock, never inferred from ordinary call events. */
  readonly houseIdle?: { readonly idleTicks: number; readonly activityTick: (agentId: string) => number | undefined };
  /** With houseIdle: the match is in the Antwars Model Index (house-*), from its captured access policy. */
  readonly modelIndex?: boolean;
  readonly rated?: boolean;
  /** Resolves seated identity by the sim's internal id; never writes that id to the stream. */
  readonly identity?: (agentId: string) => StreamIdentity | undefined;
}

/**
 * What a recorder resumed from a handover save carries on from. Everything else it diffs
 * against (territory, food, stores, marks, the territory-win lead) is read from the resumed state,
 * which is the state of the last tick the saving server recorded.
 */
export interface RecorderResume {
  /** The stream's setup as the saving server sent it. */
  readonly setup: StreamSetup;
  /** Each sim agent id with its stream index. */
  readonly agents: readonly (readonly [string, number])[];
  /** A fresh copy of the starting board on each call while no record has been released; otherwise null. */
  readonly initialFull: (() => StreamFull) | null;
  /** The last recorded tick's ants: headings and death positions carry on from them. */
  readonly ants: StreamAnts;
}

/** Explicit projection: an adapter returning extra account/key fields cannot disclose them. */
function playerIdentity(value: StreamIdentity | undefined): { identity?: StreamIdentity } {
  if (value === undefined) return {};
  if (!value.displayName || (value.elo !== undefined && !Number.isFinite(value.elo))) throw new Error("Invalid spectator player identity");
  const displayName = cutUtf8(value.displayName, 256);
  if (value.elo === undefined) return { identity: Object.freeze({ displayName }) };
  // The RD read with the rating, as the live catalog shows it; the stream carries it only beside a rating.
  const rd = typeof value.rd === "number" && Number.isFinite(value.rd) && value.rd > 0 ? value.rd : undefined;
  return { identity: Object.freeze(rd === undefined ? { displayName, elo: value.elo } : { displayName, elo: value.elo, rd }) };
}

/** Records one match: call initial() once, then record() with each step's output in order. */
export class SpectatorRecorder {
  readonly setup: StreamSetup;
  private readonly agentIndex = new Map<string, number>();
  private owner: number[];
  private food: number[];
  private stores: [StreamStore, StreamStore];
  private marks: Map<number, StreamMark>;
  private heading = new Map<number, number>();
  private lastPos = new Map<number, [number, number]>();
  /** null when resumed: the match did not start on this server. */
  private readonly initialState: SimState | null;
  private readonly resumedInitialFull: (() => StreamFull) | null;
  private readonly players: SpectatorPlayerOptions;
  private readonly initialIdentities: ReadonlyMap<string, { identity?: StreamIdentity }>;
  private readonly initialHouseActivity: ReadonlyMap<string, number>;
  private territoryWin: StreamTerritoryWin | undefined;

  /** With resume, initial is the state of the last tick the saving server recorded, and recording continues from it. */
  constructor(initial: SimState, players: SpectatorPlayerOptions = {}, resume?: RecorderResume) {
    this.players = players;
    this.territoryWin = territoryWinOf(initial);
    this.owner = initial.owner.slice();
    this.food = initial.food.slice();
    this.stores = storesOf(initial);
    if (resume !== undefined) {
      this.initialState = null;
      this.resumedInitialFull = resume.initialFull;
      this.setup = resume.setup;
      this.initialHouseActivity = new Map();
      this.initialIdentities = new Map();
      for (const [id, index] of resume.agents) this.agentIndex.set(id, index);
      const ants = resume.ants;
      for (let i = 0; i < ants.count; i++) {
        this.heading.set(ants.id[i]!, ants.heading[i]!);
        this.lastPos.set(ants.id[i]!, [ants.x[i]!, ants.y[i]!]);
      }
      this.marks = this.marksOf(initial);
      return;
    }
    // The caller may advance its state in place; the starting board is kept as it was.
    this.initialState = cloneState(initial);
    this.resumedInitialFull = null;
    this.setup = { ...setupOf(initial), ...(players.rated === undefined ? {} : { rated: players.rated }),
      ...(players.houseIdle === undefined ? {} : { houseIdleTicks: players.houseIdle.idleTicks, ...(players.modelIndex === true ? { modelIndex: true as const } : {}) }) };
    this.initialHouseActivity = new Map(initial.agents.map(a => [a.id, players.houseIdle?.activityTick(a.id) ?? a.joinedTick ?? 0]));
    initial.agents.forEach((a, i) => this.agentIndex.set(a.id, i));
    this.initialIdentities = new Map(initial.agents.map(a => [a.id, playerIdentity(players.identity?.(a.id))]));
    this.marks = this.marksOf(initial);
  }

  /** Each sim agent id with its stream index, as a resumed recorder takes them. */
  agentIndexes(): [string, number][] {
    return [...this.agentIndex];
  }

  /** The whole board at the match's starting state. */
  initialFull(): StreamFull {
    if (this.resumedInitialFull !== null) return { ...this.resumedInitialFull(), setup: this.setup };
    const s = this.initialState;
    if (s === null) throw new Error("a resumed match's starting board has already been released");
    return {
      setup: this.setup,
      ...(this.territoryWin === undefined ? {} : { territoryWin: { ...this.territoryWin } }),
      // Stream version is independent of the match's rules. Historical matches
      // have the same authoritative birth stats and one queen per colony.
      queens: queensForStream(s),
      hatched: [...s.stats.hatched] as [number, number],
      territory: Uint8Array.from(s.owner, (o) => o + 1),
      marks: [...this.marksOf(s).values()],
      agents: s.agents.map(
        (a): StreamAgent => ({
          colony: asTwoColony(a.colony),
          modelLabel: cutUtf8(a.modelLabel ?? "", LABEL_BYTES),
          ...(a.thinkingLevel === undefined ? {} : { thinkingLevel: cutUtf8(a.thinkingLevel, THINKING_LEVEL_BYTES) }),
          ...(a.serviceTier === undefined ? {} : { serviceTier: cutUtf8(a.serviceTier, SERVICE_TIER_BYTES) }),
          ...this.initialIdentities.get(a.id),
          ...(this.players.houseIdle === undefined ? {} : { lastHouseCallTick: this.initialHouseActivity.get(a.id)! }),
          joinTick: a.joinedTick ?? a.lastCallTick,
          lastCallTick: a.lastCallTick,
          prevCallTick: -1,
          ...(s.config.commandIdleTicks === undefined ? {} : { lastCommandTick: a.lastCommandTick ?? -1 }),
          order: a.order.kind,
          orderX: "tileX" in a.order ? a.order.tileX : 0,
          orderY: "tileY" in a.order ? a.order.tileY : 0,
          intent: "",
        }),
      ),
      overrun: s.colonies.map((c) => Math.max(0, ...activeQueens(c).map((q) => q.overrunTicks))) as [number, number],
      overrunRequired: s.config.overrunTicks,
      deaths: [s.stats.deaths[0], s.stats.deaths[1]],
      result: null,
      food: Uint32Array.from(s.food),
      hatch: hatchOf(s),
      stores: storesOf(s),
    };
  }

  initial(): TickRecord {
    if (this.initialState === null) throw new Error("a resumed match has no starting record");
    return { tick: this.initialState.tick, ants: this.ants(this.initialState), events: [] };
  }

  record(out: StepOutput): TickRecord {
    const state = out.state;
    const events: StreamEvent[] = [];
    const marks = this.marksOf(state);
    for (const e of out.events) {
      const se = this.event(state, e, marks);
      if (se !== null) events.push(se);
    }
    // Territory: every tile whose owner changed this step.
    const tiles: number[] = [];
    const owners: number[] = [];
    for (let i = 0; i < state.owner.length; i++) {
      if (state.owner[i] !== this.owner[i]) {
        tiles.push(i);
        owners.push(state.owner[i]! + 1);
      }
    }
    if (tiles.length > 0) events.push({ kind: "territory", tiles, owners });
    this.owner = state.owner.slice();
    // Count marks can be re-laid in place without a mark_laid sim event.
    // Replacements also carry claim changes; answered keeps its squad-only meaning.
    for (const id of this.marks.keys()) if (!marks.has(id)) events.push({ kind: "markGone", markId: id });
    for (const [id, mark] of marks) {
      const before = this.marks.get(id);
      if (before === undefined) continue; // Newly laid marks already came from the sim events.
      if (before.caste !== mark.caste || before.verb !== mark.verb || before.count !== mark.count || before.claimed !== mark.claimed || before.revision !== mark.revision) {
        events.push({ kind: "mark", mark });
      } else if (before.answered !== mark.answered) {
        events.push({ kind: "answered", markId: id, count: mark.answered });
      }
    }
    this.marks = marks;
    // Food: every tile whose amount changed this step (regrowth, pickups, corpses).
    const foodTiles: number[] = [];
    const amounts: number[] = [];
    for (let i = 0; i < state.food.length; i++) {
      if (state.food[i] !== this.food[i]) {
        foodTiles.push(i);
        amounts.push(state.food[i]!);
      }
    }
    if (foodTiles.length > 0) events.push({ kind: "food", tiles: foodTiles, amounts });
    this.food = state.food.slice();
    // Stores: a colony whose food store, next hatch tick or next hatch cost changed.
    const stores = storesOf(state);
    for (const c of [0, 1] as const) {
      const was = this.stores[c];
      const is = stores[c];
      if (is.food !== was.food || is.nextHatchTick !== was.nextHatchTick || is.nextCost !== was.nextCost) {
        events.push({ kind: "store", colony: c, food: is.food, nextHatchTick: is.nextHatchTick, nextCost: is.nextCost });
      }
    }
    this.stores = stores;
    const lead = territoryWinOf(state), before = this.territoryWin;
    if (lead?.colony !== before?.colony || lead?.startTick !== before?.startTick || lead?.winTick !== before?.winTick) {
      events.push({ kind: "territoryWin", progress: lead ?? null });
    }
    this.territoryWin = lead;
    return { tick: state.tick, ants: this.ants(state), events };
  }

  private marksOf(state: SimState): Map<number, StreamMark> {
    // One pass over living ants, not a full scan per mark.
    const claims = new Map<number, number>();
    for (const ant of state.ants) {
      if (ant.claim !== undefined) claims.set(ant.claim, (claims.get(ant.claim) ?? 0) + 1);
    }
    const agents = new Map(state.agents.map((agent, i) => [agent.id, i]));
    return new Map(state.marks.map((m) => [m.id, this.mark(m, claims.get(m.id) ?? 0, agents.get(m.agentId)!, state.config.countMarks?.casteSelection === true)]));
  }

  private mark(m: SimState["marks"][number], claimed: number, agent: number, casteSelection: boolean): StreamMark {
    return {
      id: m.id,
      agent,
      colony: asTwoColony(m.colony),
      tileX: m.tileX,
      tileY: m.tileY,
      words: m.words.map((w) => WORDS.indexOf(w)),
      laidTick: m.laidTick,
      answered: m.steering,
      ...(m.verb === undefined ? {} : { verb: m.verb, claimed,
        ...(casteSelection || m.caste !== undefined ? { caste: m.caste ?? "any" } : {}) }),
      ...(m.count === undefined ? {} : { count: m.count }),
      ...(m.revision === undefined ? {} : { revision: m.revision }),
      ...(m.toTileX === undefined || m.toTileY === undefined ? {} : { toTileX: m.toTileX, toTileY: m.toTileY }),
    };
  }

  private event(state: SimState, e: SimEvent, marks: ReadonlyMap<number, StreamMark>): StreamEvent | null {
    switch (e.type) {
      case "hatch":
        return { kind: "birth", antId: e.antId };
      case "death": {
        const [x, y] = this.lastPos.get(e.antId) ?? [e.tileX * SUB_TILE + SUB_TILE / 2, e.tileY * SUB_TILE + SUB_TILE / 2];
        return { kind: "death", antId: e.antId, colony: asTwoColony(e.colony), x, y };
      }
      case "fight":
        return { kind: "fight", antId: e.antId, targetId: e.targetId, colony: asTwoColony(e.colony), tileX: e.tileX, tileY: e.tileY };
      case "mark_laid": {
        const mark = marks.get(e.markId);
        return mark === undefined ? null : { kind: "mark", mark };
      }
      case "queen_founded":
      case "queen_lost": {
        const queen = queensForStream(state).find((q) => q.colony === e.colony && q.id === e.queenId);
        return queen ? { kind: e.type === "queen_founded" ? "queenFounded" : "queenLost", queen } : null;
      }
      case "queen_hp":
        return { kind: "queenHp", colony: asTwoColony(e.colony), queenId: e.queenId, hp: e.hp };
      case "overrun_progress":
        return e.queenId === undefined ? { kind: "overrun", colony: asTwoColony(e.colony), progress: e.progressTicks, required: e.requiredTicks }
          : { kind: "queenOverrun", colony: asTwoColony(e.colony), queenId: e.queenId, progress: e.progressTicks, required: e.requiredTicks };
      case "match_end":
        return { kind: "end", result: streamResult(e.result, null) };
      case "agent_join": {
        const agent = this.agentIndex.size;
        this.agentIndex.set(e.agentId, agent);
        return { kind: "join", agent, colony: asTwoColony(e.colony), modelLabel: cutUtf8(e.modelLabel ?? "", LABEL_BYTES),
          ...(e.thinkingLevel === undefined ? {} : { thinkingLevel: cutUtf8(e.thinkingLevel, THINKING_LEVEL_BYTES) }),
          ...(e.serviceTier === undefined ? {} : { serviceTier: cutUtf8(e.serviceTier, SERVICE_TIER_BYTES) }), ...playerIdentity(this.players.identity?.(e.agentId)) };
      }
      case "agent_call": {
        const agent = this.agentIndex.get(e.agentId);
        if (agent === undefined) return null;
        const houseActivityTick = this.players.houseIdle?.activityTick(e.agentId);
        return { kind: "call", agent, call: e.call, accepted: e.accepted,
          ...(houseActivityTick === undefined ? {} : { houseActivityTick }) };
      }
      case "order": {
        const agent = this.agentIndex.get(e.agentId)!;
        const o = e.order;
        return { kind: "order", agent, order: o.kind, tileX: "tileX" in o ? o.tileX : 0, tileY: "tileY" in o ? o.tileY : 0, intent: cutUtf8(e.intent ?? "", INTENT_BYTES) };
      }
      default:
        return null;
    }
  }

  private ants(state: SimState): StreamAnts {
    const list = state.ants.slice();
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.id < list[i - 1]!.id) {
        list.sort((a, b) => a.id - b.id);
        break;
      }
    }
    const n = list.length;
    const out: StreamAnts = {
      count: n,
      id: new Uint32Array(n),
      x: new Uint16Array(n),
      y: new Uint16Array(n),
      heading: new Uint8Array(n),
      colony: new Uint8Array(n),
      agent: new Int16Array(n),
      carrying: new Uint8Array(n),
    };
    const W = state.config.mapWidth;
    const H = state.config.mapHeight;
    const lastPos = new Map<number, [number, number]>();
    for (let i = 0; i < n; i++) {
      const a = list[i]!;
      out.id[i] = a.id;
      const x = toSubTile(a.x, W);
      const y = toSubTile(a.y, H);
      out.x[i] = x;
      out.y[i] = y;
      lastPos.set(a.id, [x, y]);
      let h = this.heading.get(a.id) ?? 0;
      if (a.vx !== 0 || a.vy !== 0) {
        h = Math.round(((Math.atan2(a.vy, a.vx) + TAU) % TAU) * (256 / TAU)) & 255;
        this.heading.set(a.id, h);
      }
      out.heading[i] = h;
      out.colony[i] = a.colony;
      out.agent[i] = a.squad === null ? -1 : (this.agentIndex.get(a.squad) ?? -1);
      out.carrying![i] = a.carrying ? 1 : 0;
    }
    // Castes ride only when a soldier is present, as the decoder reads them (format.ts StreamAnts.caste).
    if (list.some((a) => a.caste === "soldier")) out.caste = Uint8Array.from(list, (a) => (a.caste === "soldier" ? 1 : 0));
    for (const id of this.heading.keys()) if (!lastPos.has(id)) this.heading.delete(id);
    this.lastPos = lastPos;
    return out;
  }
}

/**
 * The whole board as a spectator sees it at one tick, kept by applying stream
 * records in order. The hub keeps one at the delayed playback position, so a
 * full message never runs ahead of the stream, and the client keeps its own.
 */
export class SpectatorState {
  tick: number;
  ants: StreamAnts;
  readonly full: StreamFull;

  constructor(full: StreamFull, tick: number, ants: StreamAnts) {
    this.full = full;
    this.tick = tick;
    this.ants = ants;
  }

  apply(rec: { tick: number; ants: StreamAnts; events: readonly StreamEvent[] }): void {
    const f = this.full;
    const t = rec.tick - 1;
    for (const e of rec.events) {
      switch (e.kind) {
        case "territoryWin":
          if (e.progress === null) delete f.territoryWin;
          else f.territoryWin = { ...e.progress };
          break;
        case "birth": {
          const i = rec.ants.id.indexOf(e.antId);
          if (f.hatched !== undefined && i >= 0) f.hatched[rec.ants.colony[i] as 0 | 1]++;
          break;
        }
        case "queenFounded":
        case "queenLost": {
          const queens = f.queens ??= [];
          const i = queens.findIndex((q) => q.colony === e.queen.colony && q.id === e.queen.id);
          if (i < 0) queens.push({ ...e.queen }); else queens[i] = { ...e.queen };
          queens.sort((a, b) => a.colony - b.colony || a.id - b.id);
          f.overrun[e.queen.colony] = Math.max(0, ...queens.filter((q) => q.colony === e.queen.colony && q.lostTick === null).map((q) => q.overrun));
          break;
        }
        case "queenHp": {
          const q = f.queens?.find((q) => q.colony === e.colony && q.id === e.queenId);
          if (q) q.hp = e.hp;
          break;
        }
        case "queenOverrun": {
          const q = f.queens?.find((q) => q.colony === e.colony && q.id === e.queenId);
          if (q) q.overrun = e.progress;
          f.overrun[e.colony] = Math.max(0, ...(f.queens ?? []).filter((q) => q.colony === e.colony && q.lostTick === null).map((q) => q.overrun));
          f.overrunRequired = e.required;
          break;
        }
        case "death":
          f.deaths[e.colony] += 1;
          break;
        case "mark":
          f.marks = f.marks.filter((m) => m.id !== e.mark.id);
          f.marks.push({ ...e.mark, words: e.mark.words.slice() });
          break;
        case "markGone":
          f.marks = f.marks.filter((m) => m.id !== e.markId);
          break;
        case "answered": {
          const m = f.marks.find((mark) => mark.id === e.markId);
          if (m) m.answered = e.count;
          break;
        }
        case "territory":
          for (let i = 0; i < e.tiles.length; i++) f.territory[e.tiles[i]!] = e.owners[i]!;
          break;
        case "overrun": {
          f.overrun[e.colony] = e.progress;
          f.overrunRequired = e.required;
          // Historical rules emit colony-level progress; v5 names their single queen.
          const queen = f.queens?.find((q) => q.colony === e.colony && q.id === 0);
          if (queen) queen.overrun = e.progress;
          break;
        }
        case "join":
          f.agents[e.agent] = {
            colony: e.colony,
            modelLabel: e.modelLabel,
            ...(e.thinkingLevel === undefined ? {} : { thinkingLevel: e.thinkingLevel }),
            ...(e.serviceTier === undefined ? {} : { serviceTier: e.serviceTier }),
            ...(e.identity === undefined ? {} : { identity: { ...e.identity } }),
            joinTick: t,
            lastCallTick: -1,
            prevCallTick: -1,
            ...(f.setup.commandIdleTicks === undefined ? {} : { lastCommandTick: -1 }),
            ...(f.setup.houseIdleTicks === undefined ? {} : { lastHouseCallTick: t }),
            order: ORDER_KINDS[4],
            orderX: 0,
            orderY: 0,
            intent: "",
          };
          break;
        case "call": {
          const a = f.agents[e.agent];
          if (a && f.setup.houseIdleTicks !== undefined && e.houseActivityTick !== undefined) a.lastHouseCallTick = e.houseActivityTick;
          // A refused join (a duplicate id) is not a call by the agent already holding that id: the sim leaves its call tick alone.
          if (a && !(e.call === "join" && !e.accepted)) {
            a.prevCallTick = a.lastCallTick;
            a.lastCallTick = t;
            // Rules 27: set_brood is outside the shared command floor, so, like observe, it leaves the command clock alone.
            if (f.setup.commandIdleTicks !== undefined && e.accepted && e.call !== "join" && e.call !== "rejoin" && e.call !== "observe" && e.call !== "set_brood") {
              a.lastCommandTick = t;
            }
          }
          break;
        }
        case "order": {
          const a = f.agents[e.agent];
          if (a) {
            a.order = e.order;
            a.orderX = e.tileX;
            a.orderY = e.tileY;
            a.intent = e.intent;
          }
          break;
        }
        case "end":
          if (e.result.reason === "abandoned") f.setup.rated = false;
          f.result = e.result;
          break;
        case "food": {
          const food = (f.food ??= new Uint32Array(f.setup.mapW * f.setup.mapH));
          for (let i = 0; i < e.tiles.length; i++) food[e.tiles[i]!] = e.amounts[i]!;
          break;
        }
        case "store": {
          const stores = (f.stores ??= [
            { food: 0, nextHatchTick: 0, nextCost: 0 },
            { food: 0, nextHatchTick: 0, nextCost: 0 },
          ]);
          stores[e.colony] = { food: e.food, nextHatchTick: e.nextHatchTick, nextCost: e.nextCost };
          break;
        }
        default:
          break;
      }
    }
    this.tick = rec.tick;
    this.ants = rec.ants;
  }

  /** The full message for the current tick. It carries no events: its state already includes them. */
  message(): StreamMessage {
    return { tick: this.tick, ants: this.ants, full: this.full, events: [] };
  }
}

export function queensForStream(state: SimState): StreamQueen[] {
  return state.colonies.flatMap((c) => queensOf(c).map((q) => ({ id: q.id, colony: asTwoColony(c.id),
    x: toSubTile(q.queenX, state.config.mapWidth), y: toSubTile(q.queenY, state.config.mapHeight),
    foundedTick: q.foundedTick, lostTick: q.lostTick, overrun: q.overrunTicks, ...(q.hp === undefined ? {} : { hp: q.hp }) })));
}
