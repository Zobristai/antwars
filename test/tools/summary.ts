/// <reference types="node" />
/**
 * Match summary from a playtest's JSONL log,
 * by re-simulating the logged inputs: per colony the marks its
 * agents laid and how many a teammate received through observe, the per-mark
 * reception rate, the median agent loop time, the ants lost in combat and the
 * time of first contact; per agent its call gaps.
 */
import { loadReplayFile } from "../../src/live/replayOptions.js";
import { COLONY_NAMES, SUB, type SimConfig } from "../../src/sim/config.js";
import { withinTiles } from "../../src/sim/geometry.js";
import type { ClaimsRecord, ContentionRecord, HatchBlockedRecord, StepObservers } from "../../src/sim/marks.js";
import { parseLog, terminalAt } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { ColonyId, CountMarkVerb, MatchResult, SimInput, SimState, StepOutput, WinReason } from "../../src/sim/types.js";
import { houseMatch } from "./colonyScale.js";

/**
 * Re-simulate a log, calling onStep with each tick's inputs and output. "last_input"
 * stops after the last tick that has inputs; "result" runs on to the match result.
 * Either way it stops at the result.
 */
export function replaySteps(lines: readonly string[], stop: "last_input" | "result", onStep: (inputs: readonly SimInput[], out: StepOutput) => void, observers?: StepObservers): SimState {
  const log = parseLog(lines);
  const { header, ticks, houseActive } = log;
  const lastTick = stop === "last_input" ? Math.max(-1, ...ticks.keys()) : Number.POSITIVE_INFINITY;
  let state = createMatch(header.seed, header.config);
  while (state.tick <= lastTick && state.result === null) {
    const inputs = ticks.get(state.tick) ?? [];
    const out = step(state, inputs, undefined, undefined, observers, terminalAt(log, state.tick), houseActive.has(state.tick));
    onStep(inputs, out);
    state = out.state;
  }
  return state;
}

export interface AgentSummary {
  readonly agentId: string;
  readonly modelLabel: string | null;
  readonly colony: ColonyId;
  readonly calls: number;
  readonly observes: number;
  /**
   * Call gap: seconds from one game call to the agent's next, from the ticks the
   * server processed them at (0.1 s resolution), the end of one call to the start of
   * the next. It includes any wait the agent asked for, so it is not seconds per
   * decision; that figure (the decision-time measure) subtracts the requested waits, which
   * only the agent's transcript shows.
   */
  readonly callGapSeconds: { readonly median: number | null; readonly p95: number | null; readonly gaps: number };
  /** Median interval between consecutive observe calls. */
  readonly medianLoopSeconds: number | null;
}

export interface ColonySummary {
  readonly colony: ColonyId;
  readonly name: string;
  readonly agents: number;
  readonly marksLaid: number;
  /** Marks laid by an agent of this colony that appeared in a different agent's observe view. */
  readonly marksReceived: number;
  /** marksReceived / marksLaid, or null with no marks. */
  readonly receptionRate: number | null;
  /** Median of every agent's consecutive-observe intervals in this colony. */
  readonly medianLoopSeconds: number | null;
  /** This colony's ants killed in combat. */
  readonly antsLostInCombat: number;
  /** Match time of the first fight between the colonies (the same for both). */
  readonly firstContactSeconds: number | null;
}

export interface MarkReception {
  readonly markId: number;
  readonly layer: string;
  readonly colony: ColonyId;
  readonly laidTick: number;
  /** Each other agent that saw it through observe, with the first tick it did. */
  readonly receivers: readonly { readonly agentId: string; readonly tick: number }[];
}

export interface MatchSummary {
  readonly ticks: number;
  readonly seconds: number;
  readonly result: MatchResult | null;
  readonly agents: readonly AgentSummary[];
  readonly colonies: readonly [ColonySummary, ColonySummary];
  readonly marks: readonly MarkReception[];
  /** The mark pass condition: a mark one agent laid appeared in a teammate's observe view. */
  readonly markPassed: boolean;
}

/** Nearest-rank percentile at index floor((n - 1) * p) of the sorted values, as the capture measure uses. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)]!;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (n: number | null, places = 1): number | null => (n === null ? null : Number(n.toFixed(places)));

export function summarizeMatch(lines: readonly string[]): MatchSummary {
  const { header } = parseLog(lines);
  const tickSeconds = 1 / header.config.ticksPerSecond;
  const calls = new Map<string, number[]>();
  const observes = new Map<string, number[]>();
  const joined = new Map<string, { colony: ColonyId; modelLabel: string | null }>();
  const marks = new Map<number, { layer: string; colony: ColonyId; laidTick: number; receivers: Map<string, number> }>();
  let firstContact: number | null = null;
  const push = (map: Map<string, number[]>, id: string, tick: number): void => {
    const list = map.get(id) ?? [];
    list.push(tick);
    map.set(id, list);
  };
  const state = replaySteps(lines, "result", (inputs, out) => {
    const tick = out.state.tick - 1;
    for (const input of inputs) {
      push(calls, input.agentId, tick);
      if (input.type === "observe") push(observes, input.agentId, tick);
    }
    for (const e of out.events) {
      if (e.type === "agent_join") joined.set(e.agentId, { colony: e.colony, modelLabel: e.modelLabel });
      if (e.type === "mark_laid") marks.set(e.markId, { layer: e.agentId, colony: e.colony, laidTick: e.tick, receivers: new Map() });
      if (e.type === "fight" && firstContact === null) firstContact = e.tick;
    }
    inputs.forEach((input, i) => {
      const r = out.results[i];
      if (input.type !== "observe" || r?.ok !== true) return;
      for (const vm of r.view.marks) {
        const mark = marks.get(vm.markId);
        if (mark !== undefined && mark.layer !== input.agentId && !mark.receivers.has(input.agentId)) mark.receivers.set(input.agentId, tick);
      }
    });
  });

  const gaps = (ticks: readonly number[]): number[] => ticks.slice(1).map((t, i) => (t - ticks[i]!) * tickSeconds);
  const agents: AgentSummary[] = [...joined].map(([agentId, info]) => {
    const g = gaps(calls.get(agentId) ?? []);
    return {
      agentId,
      modelLabel: info.modelLabel,
      colony: info.colony,
      calls: calls.get(agentId)?.length ?? 0,
      observes: observes.get(agentId)?.length ?? 0,
      callGapSeconds: { median: round(median(g)), p95: round(percentile(g, 0.95)), gaps: g.length },
      medianLoopSeconds: round(median(gaps(observes.get(agentId) ?? []))),
    };
  });
  const markList: MarkReception[] = [...marks].map(([markId, m]) => ({
    markId,
    layer: m.layer,
    colony: m.colony,
    laidTick: m.laidTick,
    receivers: [...m.receivers].map(([agentId, tick]) => ({ agentId, tick })),
  }));
  const colony = (c: ColonyId): ColonySummary => {
    const laid = markList.filter((m) => m.colony === c);
    const received = laid.filter((m) => m.receivers.length > 0).length;
    const loops = agents.filter((a) => a.colony === c).flatMap((a) => gaps(observes.get(a.agentId) ?? []));
    return {
      colony: c,
      name: COLONY_NAMES[c],
      agents: agents.filter((a) => a.colony === c).length,
      marksLaid: laid.length,
      marksReceived: received,
      receptionRate: laid.length === 0 ? null : round(received / laid.length, 3),
      medianLoopSeconds: round(median(loops)),
      antsLostInCombat: state.stats.deaths[c],
      firstContactSeconds: firstContact === null ? null : round(firstContact * tickSeconds),
    };
  };
  return {
    ticks: state.tick,
    seconds: round(state.tick * tickSeconds)!,
    result: state.result,
    agents,
    colonies: [colony(0), colony(1)],
    marks: markList,
    markPassed: markList.some((m) => m.receivers.length > 0),
  };
}

const show = (n: number | null, unit = " s"): string => (n === null ? "n/a" : `${n}${unit}`);

/** The summary as output lines; agents by join order and model label (their ids are in the summary JSON). */
export function summaryLines(s: MatchSummary): string[] {
  const result = s.result === null ? "no result" : `${s.result.winner === null ? "draw" : `${COLONY_NAMES[s.result.winner]} won`} (${s.result.reason}) at tick ${s.result.tick}`;
  return [
    `Summary: ${s.seconds} s of match, ${result}.`,
    ...s.colonies.map(
      (c) =>
        `Summary: ${c.name}: ${c.agents} agent(s); marks laid ${c.marksLaid}, received by a teammate ${c.marksReceived}, reception rate ${c.receptionRate ?? "n/a"}; median agent loop time ${show(c.medianLoopSeconds)}; ants lost in combat ${c.antsLostInCombat}; first contact at ${show(c.firstContactSeconds)}.`,
    ),
    ...s.agents.map(
      (a, i) =>
        `Summary: agent ${i + 1} by join order (${a.modelLabel ?? "no model label"}, ${COLONY_NAMES[a.colony]}): ${a.calls} calls, ${a.observes} observes; call gap (includes requested waits) median ${show(a.callGapSeconds.median)}, p95 ${show(a.callGapSeconds.p95)} over ${a.callGapSeconds.gaps} gaps; median loop time ${show(a.medianLoopSeconds)}.`,
    ),
    `Summary: mark pass condition ${s.markPassed ? "met" : "not met"}: ${s.markPassed ? "a mark one agent laid appeared in a teammate's observe view" : "no mark one agent laid appeared in a teammate's observe view"}.`,
  ];
}

/** Summarize the match log at path. */
export function summarizeLog(path: string): MatchSummary {
  return summarizeMatch(loadReplayFile(path).lines);
}

/** The stdout prefix of a comparison-mode match-log line (src/server.ts MATCH_LOG_PREFIX). */
const MATCH_LOG_LINE = /^(?:.*?\s)?ANTWAR_MATCH_LOG (\d+):(\d+) (.*)$/;

/**
 * One match's log lines from a comparison run's stdout capture (Cloud Logging
 * export, in any order, with any leading timestamp or label). Lines are
 * "ANTWAR_MATCH_LOG <match>:<index> <line>"; they are sorted by index, so the
 * header comes first. A missing or repeated index refuses: a recording with a
 * gap cannot be replayed exactly.
 */
export function extractMatchLog(captured: readonly string[], match?: number): string[] {
  const byMatch = new Map<number, Map<number, string>>();
  for (const raw of captured) {
    const m = MATCH_LOG_LINE.exec(raw.trimEnd());
    if (m === null) continue;
    const seq = Number(m[1]);
    const index = Number(m[2]);
    const lines = byMatch.get(seq) ?? new Map<number, string>();
    if (lines.has(index) && lines.get(index) !== m[3]) throw new Error(`match ${seq} log line ${index} appears twice with different content`);
    lines.set(index, m[3]!);
    byMatch.set(seq, lines);
  }
  const seq = match ?? (byMatch.size === 1 ? [...byMatch.keys()][0]! : undefined);
  if (seq === undefined) throw new Error(byMatch.size === 0 ? "no ANTWAR_MATCH_LOG lines found" : `the capture holds matches ${[...byMatch.keys()].join(", ")}; name one`);
  const lines = byMatch.get(seq);
  if (lines === undefined) throw new Error(`no log lines for match ${seq}`);
  const out: string[] = [];
  for (let i = 0; i < lines.size; i += 1) {
    const line = lines.get(i);
    if (line === undefined) throw new Error(`match ${seq} log is missing line ${i}; refusing to replay a recording with a gap`);
    out.push(line);
  }
  return out;
}

/** One count mark's measures. */
export interface CountMarkMeasures {
  readonly markId: number;
  readonly agentId: string;
  readonly colony: ColonyId;
  readonly verb: CountMarkVerb;
  readonly tileX: number;
  readonly tileY: number;
  readonly laidTick: number;
  /** The count asked at each lay and re-lay, with the mark's revision. */
  readonly asked: readonly { readonly tick: number; readonly revision: number; readonly count: number }[];
  /** Unique ants that ever claimed it, and the most claimed at once. */
  readonly assignedUnique: number;
  readonly assignedPeak: number;
  /** Arrival: within 2 tiles (Euclidean) of the mark while assigned; first arrival per assignment episode. */
  readonly arrivedUnique: number;
  readonly arrivedAlreadyNear: number;
  readonly arrivedEntered: number;
  readonly arrivedPeak: number;
  readonly arrivals: readonly { readonly antId: number; readonly tick: number; readonly revision: number; readonly alreadyNear: boolean }[];
  readonly deaths: number;
  /** Claims after the mark's first claim tick, and those that came through the member radius (recruitment). */
  readonly refills: number;
  readonly recruited: number;
  /** Why claims ended: the mark expired or was replaced, its count was lowered (or the ant joined a squad), the ant died, or deaths left the colony above the claim share. */
  readonly releases: { readonly expired: number; readonly replaced: number; readonly lowered: number; readonly died: number; readonly capped: number };
}

export interface ShortfallMeasures {
  readonly blockedNestTicks: number;
  readonly episodes: readonly { readonly queenId: number; readonly startTick: number; readonly ticks: number; readonly maxDeficit: number }[];
}

export interface ContentionMeasures {
  readonly antTicks: number;
  readonly sameVerbAndTarget: number;
  readonly differing: number;
  readonly won: number;
  readonly refused: number;
  readonly episodes: number;
}

export interface VariantSummary {
  readonly rules: string | null;
  readonly players: number | null;
  readonly seed: number;
  readonly ticks: number;
  readonly seconds: number;
  readonly result: MatchResult | null;
  /** Null when the match had no count marks (N/A, not zero). */
  readonly marks: readonly CountMarkMeasures[] | null;
  readonly foodShortfall: readonly [ShortfallMeasures, ShortfallMeasures];
  /** Null when the match had no count marks. */
  readonly contention: readonly [ContentionMeasures, ContentionMeasures] | null;
  /** Queen HP lost per colony (milli-HP); null outside the redesign. */
  readonly queenDamageTaken: readonly [number, number] | null;
}

/** Within the 2-tile arrival radius of the mark. */
const ARRIVE_TILES = 2;

/**
 * The comparison measures for one match log, by replaying it with the
 * read-only step observers. Run it at the exact SHA that played the match.
 */
export function variantSummary(lines: readonly string[]): VariantSummary {
  const { header } = parseLog(lines);
  const config = header.config;
  const tickSeconds = 1 / config.ticksPerSecond;
  const marks = new Map<number, {
    m: CountMarkMeasures & { asked: { tick: number; revision: number; count: number }[]; arrivals: { antId: number; tick: number; revision: number; alreadyNear: boolean }[] };
    assigned: Set<number>; arrived: Set<number>; firstClaimTick: number | null;
    counts: { deaths: number; refills: number; recruited: number; expired: number; replaced: number; lowered: number; died: number; capped: number; assignedPeak: number; arrivedPeak: number };
  }>();
  // Live assignment episodes: antId -> mark, the tick it began and whether it has arrived in this episode.
  const episodes = new Map<number, { markId: number; startTick: number; arrived: boolean }>();
  // The claims each tick's claim pass left, before that tick's combat.
  let passClaims: ClaimsRecord | null = null;
  const shortfall: [Map<number, { start: number; last: number; max: number }>, Map<number, { start: number; last: number; max: number }>] = [new Map(), new Map()];
  const shortfallOut: [{ blockedNestTicks: number; episodes: ShortfallMeasures["episodes"][number][] }, { blockedNestTicks: number; episodes: ShortfallMeasures["episodes"][number][] }] = [{ blockedNestTicks: 0, episodes: [] }, { blockedNestTicks: 0, episodes: [] }];
  const contention = [0, 1].map(() => ({ antTicks: 0, sameVerbAndTarget: 0, differing: 0, won: 0, refused: 0, episodes: 0 })) as [{ -readonly [K in keyof ContentionMeasures]: number }, { -readonly [K in keyof ContentionMeasures]: number }];
  const lastContended = new Map<number, number>();
  const damage: [number, number] = [0, 0];
  const queenHp = new Map<string, number>();
  const observers: StepObservers = {
    hatchBlocked(r: HatchBlockedRecord) {
      const out = shortfallOut[r.colony];
      out.blockedNestTicks += 1;
      const open = shortfall[r.colony].get(r.queenId);
      if (open !== undefined && open.last === r.tick - 1) {
        open.last = r.tick;
        open.max = Math.max(open.max, r.deficit);
      } else {
        if (open !== undefined) out.episodes.push({ queenId: r.queenId, startTick: open.start, ticks: open.last - open.start + 1, maxDeficit: open.max });
        shortfall[r.colony].set(r.queenId, { start: r.tick, last: r.tick, max: r.deficit });
      }
    },
    claims(r: ClaimsRecord) {
      passClaims = r;
    },
    contention(r: ContentionRecord) {
      const c = contention[r.colony];
      c.antTicks += 1;
      const same = r.marks.every((m) => m.verb === r.marks[0]!.verb && m.tileX === r.marks[0]!.tileX && m.tileY === r.marks[0]!.tileY);
      if (same) c.sameVerbAndTarget += 1;
      else c.differing += 1;
      if (r.winner === null) c.refused += 1;
      else c.won += 1;
      if (lastContended.get(r.antId) !== r.tick - 1) c.episodes += 1;
      lastContended.set(r.antId, r.tick);
    },
  };
  let prev: SimState | null = null;
  const state = replaySteps(lines, "result", (_inputs, out) => {
    const tick = out.state.tick - 1;
    const now = out.state;
    for (const e of out.events) {
      if (e.type === "mark_laid" && e.verb !== undefined && e.count !== undefined) {
        marks.set(e.markId, {
          m: { markId: e.markId, agentId: e.agentId, colony: e.colony, verb: e.verb, tileX: e.tileX, tileY: e.tileY, laidTick: e.tick, asked: [{ tick: e.tick, revision: 0, count: e.count }],
            assignedUnique: 0, assignedPeak: 0, arrivedUnique: 0, arrivedAlreadyNear: 0, arrivedEntered: 0, arrivedPeak: 0, arrivals: [], deaths: 0, refills: 0, recruited: 0,
            releases: { expired: 0, replaced: 0, lowered: 0, died: 0, capped: 0 } },
          assigned: new Set(), arrived: new Set(), firstClaimTick: null,
          counts: { deaths: 0, refills: 0, recruited: 0, expired: 0, replaced: 0, lowered: 0, died: 0, capped: 0, assignedPeak: 0, arrivedPeak: 0 },
        });
      }
      if (e.type === "queen_hp") {
        const key = `${e.colony}:${e.queenId}`;
        const before = queenHp.get(key) ?? config.queenHp?.hp ?? e.hp;
        if (e.hp < before) damage[e.colony] += before - e.hp;
        queenHp.set(key, e.hp);
      }
    }
    // Re-lays: a count change on an existing mark.
    for (const mark of now.marks) {
      const rec = mark.count === undefined ? undefined : marks.get(mark.id);
      if (rec === undefined) continue;
      const last = rec.m.asked[rec.m.asked.length - 1]!;
      if ((mark.revision ?? 0) !== last.revision) rec.m.asked.push({ tick, revision: mark.revision ?? 0, count: mark.count! });
    }
    const alive = new Map(now.ants.map((a) => [a.id, a]));
    const liveMarks = new Map(now.marks.map((m) => [m.id, m]));
    // The claim pass's result, before combat: a claim whose ant dies this tick is still an assignment.
    const pass: ClaimsRecord = passClaims !== null && (passClaims as ClaimsRecord).tick === tick ? passClaims : { tick, claims: [] };
    const passed = new Map(pass.claims.map((c) => [c.antId, c.markId]));
    // Releases by the claim pass: episodes whose ant it no longer counts for that mark.
    for (const [antId, ep] of [...episodes]) {
      if (passed.get(antId) === ep.markId) continue;
      const rec = marks.get(ep.markId)!;
      if (!liveMarks.has(ep.markId)) {
        // expireMarks drops a mark at the end of the tick before laidTick + lifetime; its claims go the tick after.
        if (tick - rec.m.laidTick >= config.markLifetimeTicks) rec.counts.expired += 1;
        else rec.counts.replaced += 1;
      } else rec.counts.lowered += 1;
      episodes.delete(antId);
    }
    // New claims by the claim pass, counted once each.
    const claimedPass = new Map<number, number>();
    for (const { antId, markId } of pass.claims) {
      const rec = marks.get(markId);
      if (rec === undefined) continue;
      claimedPass.set(markId, (claimedPass.get(markId) ?? 0) + 1);
      if (episodes.has(antId)) continue;
      // Recruitment: it came from outside smell range of the mark, judged where it stood at the start of the tick.
      const mark = rec.m;
      const before = prev?.ants.find((a) => a.id === antId) ?? alive.get(antId);
      if (rec.firstClaimTick === null) rec.firstClaimTick = tick;
      else if (tick > rec.firstClaimTick) rec.counts.refills += 1;
      if (before !== undefined && !withinTiles(Math.floor(before.x / SUB), Math.floor(before.y / SUB), mark.tileX, mark.tileY, config.smellTiles)) rec.counts.recruited += 1;
      rec.assigned.add(antId);
      episodes.set(antId, { markId, startTick: tick, arrived: false });
    }
    // After combat and the share trim: deaths and capped releases.
    for (const [antId, ep] of [...episodes]) {
      const ant = alive.get(antId);
      if (ant !== undefined && ant.claim === ep.markId) continue;
      const rec = marks.get(ep.markId)!;
      if (ant === undefined) {
        rec.counts.died += 1;
        rec.counts.deaths += 1;
      } else rec.counts.capped += 1;
      episodes.delete(antId);
    }
    // Arrivals on the tick's final positions.
    const arrivedNow = new Map<number, number>();
    for (const ant of now.ants) {
      const ep = episodes.get(ant.id);
      if (ep === undefined) continue;
      const rec = marks.get(ep.markId)!;
      const mark = liveMarks.get(ep.markId);
      if (mark === undefined) continue;
      const near = withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), mark.tileX, mark.tileY, ARRIVE_TILES);
      if (!near) continue;
      arrivedNow.set(ep.markId, (arrivedNow.get(ep.markId) ?? 0) + 1);
      if (ep.arrived) continue;
      ep.arrived = true;
      rec.arrived.add(ant.id);
      rec.m.arrivals.push({ antId: ant.id, tick, revision: mark.revision ?? 0, alreadyNear: ep.startTick === tick });
    }
    for (const [id, n] of claimedPass) marks.get(id)!.counts.assignedPeak = Math.max(marks.get(id)!.counts.assignedPeak, n);
    for (const [id, n] of arrivedNow) marks.get(id)!.counts.arrivedPeak = Math.max(marks.get(id)!.counts.arrivedPeak, n);
    prev = now;
  }, observers);
  for (const colony of [0, 1] as const) {
    for (const [queenId, open] of shortfall[colony]) shortfallOut[colony].episodes.push({ queenId, startTick: open.start, ticks: open.last - open.start + 1, maxDeficit: open.max });
  }
  const markList = [...marks.values()].map(({ m, assigned, arrived, counts }) => ({
    ...m,
    assignedUnique: assigned.size,
    assignedPeak: counts.assignedPeak,
    arrivedUnique: arrived.size,
    arrivedAlreadyNear: m.arrivals.filter((a) => a.alreadyNear).length,
    arrivedEntered: m.arrivals.filter((a) => !a.alreadyNear).length,
    arrivedPeak: counts.arrivedPeak,
    deaths: counts.deaths,
    refills: counts.refills,
    recruited: counts.recruited,
    releases: { expired: counts.expired, replaced: counts.replaced, lowered: counts.lowered, died: counts.died, capped: counts.capped },
  }));
  const counted = config.countMarks !== undefined && markList.length > 0;
  return {
    rules: config.rules ?? null,
    players: config.players ?? null,
    seed: header.seed,
    ticks: state.tick,
    seconds: round(state.tick * tickSeconds)!,
    result: state.result,
    marks: counted ? markList : null,
    foodShortfall: [shortfallOut[0], shortfallOut[1]],
    contention: counted ? [contention[0], contention[1]] : null,
    queenDamageTaken: config.queenHp === undefined ? null : damage,
  };
}

/** House-bot-only match length on a variant config, offline, with today's seed. */
export function houseOnlyLength(config: SimConfig, seed = 6006): { ticks: number; seconds: number; reason: WinReason | null; winner: ColonyId | null } {
  const { final } = houseMatch(seed, config);
  return { ticks: final.tick, seconds: final.tick / config.ticksPerSecond, reason: final.result?.reason ?? null, winner: final.result?.winner ?? null };
}
