import { SUB, type SimConfig } from "./config.js";
import { distance, idiv, tileCentre, UNIT, withinTiles, ZERO, type Vec } from "./geometry.js";
import { ARRIVE, dropFoodTarget, toward } from "./forage.js";
import { gridScaleOf } from "./gridScale.js";
import { lineDistance } from "./lineMarks.js";
import { WORDS, type Ant, type ColonyId, type CountMarkVerb, type Mark, type SimState, type Word } from "./types.js";

const PULL: ReadonlySet<Word> = new Set<Word>(["FOOD", "HELP", "ATTACK", "GATHER", "HOLD"]);
const HEADINGS: Readonly<Record<string, Vec>> = {
  N: { x: 0, y: -UNIT },
  S: { x: 0, y: UNIT },
  E: { x: UNIT, y: 0 },
  W: { x: -UNIT, y: 0 },
};

/** What a mark does to ants: pull toward it, push away, send one way, or nothing. */
export type MarkEffect =
  | { readonly kind: "toward" }
  | { readonly kind: "away" }
  | { readonly kind: "go"; readonly heading: Vec }
  | null;

/**
 * The mark's effect is its first word that steers: FOOD, HELP, ATTACK,
 * GATHER or HOLD pull; AVOID repels; GO steers only with a direction word in
 * the mark (the first one). Other words carry information only.
 */
export function markEffect(words: readonly Word[]): MarkEffect {
  for (const word of words) {
    if (PULL.has(word)) return { kind: "toward" };
    if (word === "AVOID") return { kind: "away" };
    if (word === "GO") {
      const dir = words.find((w) => HEADINGS[w] !== undefined);
      if (dir !== undefined) return { kind: "go", heading: HEADINGS[dir]! };
    }
  }
  return null;
}

/** Validate mark words: one to markMaxWords words, all from the vocabulary. */
export function parseWords(config: SimConfig, words: readonly string[]): Word[] | null {
  if (words.length < 1 || words.length > config.markMaxWords) return null;
  const vocabulary: readonly string[] = WORDS;
  if (!words.every((w) => vocabulary.includes(w))) return null;
  return words.slice() as Word[];
}

/**
 * Strength (permille) of a mark at an ant's tile: markStrengthPermille at the
 * mark, falling linearly to zero at markReachTiles and over the mark's life.
 */
export function markStrength(config: SimConfig, mark: Mark, antTileX: number, antTileY: number, tick: number): number {
  const reach = config.markReachTiles * SUB;
  const d = distance(tileCentre(antTileX), tileCentre(antTileY), tileCentre(mark.tileX), tileCentre(mark.tileY));
  const near = reach - d;
  const life = config.markLifetimeTicks - (tick - mark.laidTick);
  if (near <= 0 || life <= 0) return 0;
  return idiv(config.markStrengthPermille * near * life, reach * config.markLifetimeTicks);
}

/** The one mark-direction function: where this mark sends this ant, at full strength. */
export function markDirection(mark: Mark, ant: Ant, state?: SimState): Vec {
  const effect = markEffect(mark.words);
  if (effect === null) return ZERO;
  if (effect.kind === "go") return effect.heading;
  // Repulsion stays straight (never route toward an obstacle and invert that
  // route), but its dead-zone has the same physical radius as attraction.
  if (effect.kind === "away" && state !== undefined) {
    const dx = tileCentre(mark.tileX) - ant.x, dy = tileCentre(mark.tileY) - ant.y;
    const arrival = ARRIVE * gridScaleOf(state.config);
    if (dx * dx + dy * dy <= arrival * arrival) return ZERO;
  }
  const toMark = toward(ant, tileCentre(mark.tileX), tileCentre(mark.tileY), effect.kind === "toward" ? state : undefined);
  return effect.kind === "toward" ? toMark : { x: -toMark.x, y: -toMark.y };
}

/**
 * Follow trail: the colony's strongest steering mark
 * within smell range of any of the squad's ants, measured at its nearest squad
 * ant; null when none is in range (the squad then forages).
 */
export function trailMark(state: SimState, squad: readonly Ant[], tick: number): Mark | null {
  const { config } = state;
  let best: Mark | null = null;
  let bestW = -1;
  for (const mark of state.marks) {
    if (squad.length === 0 || mark.colony !== squad[0]!.colony || markEffect(mark.words) === null) continue;
    let w = -1;
    for (const ant of squad) {
      const tx = Math.floor(ant.x / SUB);
      const ty = Math.floor(ant.y / SUB);
      if (!withinTiles(tx, ty, mark.tileX, mark.tileY, config.smellTiles)) continue;
      w = Math.max(w, markStrength(config, mark, tx, ty, tick));
    }
    if (w > bestW) {
      best = mark;
      bestW = w;
    }
  }
  return bestW >= 0 ? best : null;
}

/** Remove marks whose lifetime is over by the next tick. */
export function expireMarks(state: SimState, nextTick: number): void {
  state.marks = state.marks.filter((mark) => nextTick - mark.laidTick < state.config.markLifetimeTicks);
}

/**
 * Whether a colony plays the local ant rules this tick: the
 * redesign is on and, on a new match (localAnts.everyColony), always; on a match
 * recorded before that, only while at least one of its agents is seated (not idle).
 * Such a side has no colony planner.
 */
export function localRulesSide(state: SimState, colony: ColonyId): boolean {
  const local = state.config.localAnts;
  return local !== undefined && (local.everyColony === true || state.agents.some((a) => a.colony === colony && !a.idle));
}

/**
 * Release one ant's count-mark claim: every count-mark release goes through
 * here. Under rules 27, where its colony plays local ant rules, the released
 * ant resumes its caste's local defaults from where it is: a soldier takes its
 * current tile as its hold point, and a worker drops the food its mark chose.
 */
export function releaseClaim(state: SimState, ant: Ant): void {
  ant.claim = undefined;
  if (!localRulesSide(state, ant.colony)) return;
  if (ant.caste === "soldier") ant.holdPoint = { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
  else dropFoodTarget(ant);
}

/** One contention record: a free ant eligible for unfilled marks of two or more teammates. */
export interface ContentionRecord {
  readonly tick: number;
  readonly colony: ColonyId;
  readonly antId: number;
  /** The competing marks, in allocation order. */
  readonly marks: readonly { readonly markId: number; readonly agentId: string; readonly verb: CountMarkVerb; readonly tileX: number; readonly tileY: number }[];
  /** The mark that claimed the ant this tick, or null when it was refused (cap or no vacancy left). */
  readonly winner: number | null;
}

/** Read-only observers for the comparison report; they never change state or order. */
export interface StepObservers {
  readonly contention?: (record: ContentionRecord) => void;
  readonly hatchBlocked?: (record: HatchBlockedRecord) => void;
  /** Every count-mark claim as the claim pass leaves it, before movement and combat. */
  readonly claims?: (record: ClaimsRecord) => void;
  /** Local guards settled at their queen this tick (rules 25 guardSettle), after movement. */
  readonly settledLocalGuards?: (record: { readonly tick: number; readonly antIds: ReadonlySet<number> }) => void;
}

/** The claims standing after one tick's claim pass: so a claim whose ant dies in that tick's combat is still seen. */
export interface ClaimsRecord {
  readonly tick: number;
  readonly claims: readonly { readonly antId: number; readonly markId: number }[];
}

/** One food-shortfall record at the hatch-processing point. */
export interface HatchBlockedRecord {
  readonly tick: number;
  readonly colony: ColonyId;
  readonly queenId: number;
  readonly store: number;
  readonly cost: number;
  readonly deficit: number;
}

function centreDistance(ant: Ant, mark: Mark): number {
  if (mark.verb === "LINE") return lineDistance(ant, mark);
  return distance(ant.x, ant.y, tileCentre(mark.tileX), tileCentre(mark.tileY));
}

/** Caste eligibility shared by recruitment, retained claims and acceptance counts. */
export function countMarkCasteEligible(config: SimConfig, ant: Ant, mark: Pick<Mark, "verb" | "caste">): boolean {
  const caste = ant.caste ?? "worker";
  return !(mark.verb === "FORAGE" && caste !== "worker")
    && (mark.caste === undefined || mark.caste === caste);
}

/**
 * The count-mark claim pass. Claims of marks that are gone (expired or
 * replaced by a different mark) are dropped; dead ants are already gone. A
 * group above its count releases its farthest ants first. Then, in laid order,
 * each group below its count claims the nearest free ants that are within smell
 * range of its mark, or within recruitTiles of any member (of the mark's tile
 * when the group is empty). Free means in no squad, unclaimed, and not a house
 * guard of a colony whose planner runs.
 */
export function claimCountMarks(state: SimState, tick: number, observers?: StepObservers): void {
  const rules = state.config.countMarks;
  if (rules === undefined) return;
  const { config } = state;
  const marks = new Map<number, Mark>();
  for (const mark of state.marks) if (mark.count !== undefined) marks.set(mark.id, mark);
  const members = new Map<number, Ant[]>();
  for (const ant of state.ants) {
    if (ant.claim === undefined) continue;
    const mark = marks.get(ant.claim);
    if (mark === undefined || ant.squad !== null || !countMarkCasteEligible(config, ant, mark)) {
      releaseClaim(state, ant);
      continue;
    }
    const list = members.get(ant.claim);
    if (list) list.push(ant);
    else members.set(ant.claim, [ant]);
  }
  const ordered = [...marks.values()].sort((a, b) => a.laidTick - b.laidTick || a.id - b.id);
  for (const mark of ordered) {
    const group = members.get(mark.id) ?? [];
    if (group.length <= mark.count!) continue;
    // Farthest first; on equal distance the higher id goes first.
    group.sort((a, b) => centreDistance(b, mark) - centreDistance(a, mark) || b.id - a.id);
    for (const ant of group.splice(0, group.length - mark.count!)) releaseClaim(state, ant);
  }

  for (const colony of [0, 1] as const) {
    const colonyMarks = ordered.filter((m) => m.colony === colony);
    if (colonyMarks.length === 0) continue;
    const live = state.ants.filter((a) => a.colony === colony);
    const guardsExcluded = !localRulesSide(state, colony);
    const free = live.filter((a) => a.squad === null && a.claim === undefined && !(guardsExcluded && a.role === "guard"));
    const eligible = (ant: Ant, mark: Mark): boolean => {
      if (!countMarkCasteEligible(config, ant, mark)) return false;
      if (rules.recruitColonyWide) return true;
      const tx = Math.floor(ant.x / SUB);
      const ty = Math.floor(ant.y / SUB);
      if (withinTiles(tx, ty, mark.tileX, mark.tileY, config.smellTiles)) return true;
      const group = members.get(mark.id) ?? [];
      if (group.length === 0) return withinTiles(tx, ty, mark.tileX, mark.tileY, rules.recruitTiles);
      return group.some((m) => withinTiles(tx, ty, Math.floor(m.x / SUB), Math.floor(m.y / SUB), rules.recruitTiles));
    };
    const unfilled = colonyMarks.filter((m) => (members.get(m.id)?.length ?? 0) < m.count!);
    if (unfilled.length === 0) continue;

    // Contention is judged before allocation.
    const contested = new Map<number, Mark[]>();
    if (observers?.contention !== undefined) {
      for (const ant of free) {
        const options = unfilled.filter((m) => eligible(ant, m));
        if (new Set(options.map((m) => m.agentId)).size >= 2) contested.set(ant.id, options);
      }
    }

    const won = new Map<number, number>();
    for (const mark of unfilled) {
      const group = members.get(mark.id) ?? [];
      const want = mark.count! - group.length;
      if (want <= 0) continue;
      const candidates = free
        .filter((a) => a.claim === undefined && eligible(a, mark))
        .sort((a, b) => centreDistance(a, mark) - centreDistance(b, mark) || a.id - b.id)
        .slice(0, want);
      for (const ant of candidates) {
        ant.claim = mark.id;
        // Rules 27: a count mark outranks the spawn walk; a released walker never resumes it.
        delete ant.spawnWalk;
        // A new FORAGE claim works the food nearest its mark, not food it was heading for before.
        // A carrier still delivers first: it holds no target while carrying.
        if (mark.verb === "FORAGE") ant.foodTarget = -1;
        won.set(ant.id, mark.id);
      }
      if (candidates.length > 0) members.set(mark.id, [...group, ...candidates]);
    }

    for (const [antId, options] of contested) {
      observers!.contention!({
        tick,
        colony,
        antId,
        marks: options.map((m) => ({ markId: m.id, agentId: m.agentId, verb: m.verb!, tileX: m.tileX, tileY: m.tileY })),
        winner: won.get(antId) ?? null,
      });
    }
  }
}
