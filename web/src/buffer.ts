/**
 * Message buffer and delayed playback, on the live stream format
 * (src/live/format.ts).
 * Pure: no Pixi, no DOM, no clock of its own. Every method takes the current
 * client time in ms, so one stepped clock drives it in the browser and tests
 * drive it with simulated time.
 *
 * - draws RENDER_DELAY_MS behind the newest tick, mapped from message arrival;
 * - interpolates each ant by stable id between the bracketing messages;
 * - plays events at their message's tick on the delayed clock;
 * - never predicts ahead: past the newest message it holds the last positions;
 * - keeps the whole board (territory, marks, roster, overrun, deaths, result,
 *   and tile food and the colonies' stores)
 *   per tick, applying each message to the first full snapshot, so overlays
 *   show what the delayed playback has reached and nothing later;
 * - a full snapshot after the first (a reconnect) restarts playback from it.
 *
 * It also derives the battle's story for the timeline: first contact, lead changes and overrun
 * attempts, each with its colony, squad and place; and the chat log: one line per new intent and per newly laid
 * mark, read as differences between consecutive boards; and every command the
 * stream carries: one entry per call event, with the order or mark it
 * set, for each team's game history.
 */
import { TICK_MS } from "../../src/live/snapshot.ts";
import {
  SUB_TILE,
  streamQueens,
  type CallKind,
  type OrderKind,
  type StreamQueen,
  type StreamAgent,
  type StreamAnts,
  type StreamFull,
  type StreamHatch,
  type StreamMark,
  type StreamMessage,
  type StreamResult,
  type StreamSetup,
  type StreamStore,
  type StreamTerritoryWin,
} from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { EngagementTracker, type Engagement } from "./bite.ts";
import { boardQueenHp } from "./variant.ts";
import { Playout } from "./playout.ts";
import { Pivots } from "./pivot.ts";
import { isStartingQueen } from "./start-boxes.ts";
import { gridScale } from "./grid-scale.ts";

export type Colony = 0 | 1;

export const RENDER_DELAY_MS = 250;
export const SPAWN_FADE_MS = 400;
export const CORPSE_FADE_MS = 3000;
export const FIGHT_EFFECT_MS = 900;
export const MARK_LIFE_MS = 180_000;
/**
 * Event-driven motion, all on the playback clock: a bite on a queen flashes her
 * emblem and HP readouts, a lost queen's emblem collapses, and the result card follows the match's
 * end by one beat (2.5 s), so the fall is seen before the ending is told.
 */
export const HIT_FLASH_MS = 600;
export const QUEEN_COLLAPSE_MS = 2000;
export const RESULT_BEAT_MS = 2500;
/** An attack on a queen with HP ends in the timeline once no bite has landed for this many seconds. */
export const ATTACK_LULL_S = 15;
/**
 * Ant-traffic trail: a grid TRAIL_RES cells per tile side, so paths come out thin;
 * per-tick decay and per-ant deposit, per colony.
 */
export const TRAIL_RES = 4;
export const TRAIL_DECAY_PER_TICK = 0.975;
export const TRAIL_DEPOSIT = 0.06;
/** A colony leads the tug-of-war once it holds this share of owned tiles more than the other. */
export const LEAD_MARGIN = 0.02;

/** What the overlays read at one tick. Each part is a new object only when it changed. */
export interface Board {
  setup: StreamSetup;
  territoryWin?: StreamTerritoryWin;
  queens?: readonly StreamQueen[];
  /** Tile owners: 0 neutral, 1 colony 0, 2 colony 1. */
  territory: Uint8Array;
  /** Tiles held by each colony. */
  held: [number, number];
  marks: readonly StreamMark[];
  agents: readonly StreamAgent[];
  overrun: [number, number];
  overrunRequired: number;
  deaths: [number, number];
  /** Cumulative births from the v5 stream, unknown in older recordings. */
  hatched?: readonly [number, number];
  result: StreamResult | null;
  /** Food on each tile, row-major. */
  food: Uint32Array;
  /** The sim's hatch rule; null when the sender gave none. */
  hatch: StreamHatch | null;
  /** Each colony's food store and the first sim tick its queen may hatch again. */
  stores: readonly [StreamStore, StreamStore];
}

const NO_STORES: readonly [StreamStore, StreamStore] = [
  { food: 0, nextHatchTick: 0, nextCost: 0 },
  { food: 0, nextHatchTick: 0, nextCost: 0 },
];

interface Held {
  tick: number;
  ants: StreamAnts;
  /** id -> index in ants. */
  index: Map<number, number>;
  /** Trail intensity, two floats (colony 0, colony 1) per trail cell, 0..1. */
  trails: Float32Array;
  board: Board;
  /** Event-confirmed combat at this message's tick, independent of ground effects. */
  engagements: readonly Engagement[];
  /** Combat target and legacy positional-steering history, not final drawn facing. */
  facing: ReadonlyMap<number, CombatFacing>;
}

interface CombatFacing {
  rotation: number;
  /** Desired body direction, or null while recovering to travel heading. */
  target: number | null;
  /** One raw terminal bearing, not a retained target or a recursively filtered angle. */
  terminalBearing?: number;
}

// Internal positional-steering history only: preserve its existing path.
// Pivots owns all final drawn facing through BODY_TURN_SPEED_DEGREES_PER_SECOND.
const COMBAT_STEER_PER_MS = Math.PI / 200;
const angleDelta = (a: number, b: number) => ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
function combatSteeringAt(f: CombatFacing, travelA: number, travelB: number, span: number, age: number): { rotation: number; recovering: boolean } {
  if (f.target !== null) {
    const delta = angleDelta(f.rotation, f.target);
    return { rotation: f.rotation + Math.sign(delta) * Math.min(Math.abs(delta), COMBAT_STEER_PER_MS * age), recovering: true };
  }
  // Only the legacy steering state resumes interpolated heading on catch-up;
  // this state is never used as the final drawn-body rotation.
  const delta = angleDelta(f.rotation, travelA), direction = Math.sign(delta);
  const travelDelta = angleDelta(travelA, travelB);
  const closing = COMBAT_STEER_PER_MS - direction * (span > 0 ? travelDelta / span : 0);
  const catchMs = Math.abs(delta) < 1e-9 ? 0 : closing > 0 ? Math.abs(delta) / closing : Infinity;
  if (age >= catchMs) return { rotation: travelA + (span > 0 ? travelDelta * age / span : 0), recovering: false };
  return { rotation: f.rotation + direction * COMBAT_STEER_PER_MS * age, recovering: true };
}

export interface Corpse {
  antId: number;
  x: number;
  y: number;
  colony: Colony;
  heading: number;
  ageMs: number;
}

export interface Fight {
  a: number;
  b: number;
  x: number;
  y: number;
  tick: number;
  ageMs: number;
}

export interface VisibleMark {
  mark: StreamMark;
  ageMs: number;
}

/** A bite that landed on a queen with HP, at her tile, aged on the delayed clock for the hit flash. */
export interface QueenHit {
  colony: Colony;
  queenId: number;
  x: number;
  y: number;
  ageMs: number;
}

/**
 * A lost queen's age since her fall, for the collapse; negative before it. Measured on the
 * playback target (Frame.targetMs), which keeps moving after a stream's last message, so a fall
 * that ends the match still plays out. shownTick: the tick playback showed the loss at
 * (Frame.lossShown); the fall runs from that where a stream carried it later than the tick it stamps it with.
 */
export function queenLossAge(q: Pick<StreamQueen, "lostTick">, targetMs: number, shownTick = (q.lostTick ?? 0) + 1): number | null {
  return q.lostTick === null ? null : targetMs - Math.max(q.lostTick + 1, shownTick) * TICK_MS;
}

/** The colonies that have fallen: every queen the stream lists for the colony is lost. Nothing on a stream that lists no queens. */
export function fallenColonies(b: Pick<Board, "queens">): [boolean, boolean] {
  const queens = b.queens ?? [];
  return [0, 1].map((c) => queens.some((q) => q.colony === c) && queens.every((q) => q.colony !== c || q.lostTick !== null)) as [boolean, boolean];
}

/** The queen whose loss felled her colony (fallenColonies): its last lost, or null while both colonies stand. */
export function fallenQueen(b: Pick<Board, "queens">): StreamQueen | null {
  const fallen = fallenColonies(b);
  let felled: StreamQueen | null = null;
  for (const q of b.queens ?? []) if (fallen[q.colony] && q.lostTick !== null && (felled === null || q.lostTick > felled.lostTick!)) felled = q;
  return felled;
}

/**
 * The colonies whose fall the board is showing: fallen, with the result card not yet up — the
 * beat from the last queen's death to the card, in which the board dims the colony's ants; after the card, neither.
 */
export function fallWindow(frame: Pick<Frame, "board" | "targetMs" | "endShown">): [boolean, boolean] {
  const b = frame.board;
  if (!b || (b.result !== null && frame.targetMs >= resultShownAt(b.result, frame.endShown ?? undefined))) return [false, false];
  return fallenColonies(b);
}

/** Ground framed around a fallen colony's nest zones, in tiles, beyond the zones' own radius. */
export const FALL_FRAME_PAD = 4;

/**
 * The box the fall window frames: the fallen colony's nests, its queens'
 * tiles with their zone radius and FALL_FRAME_PAD tiles around; null while both colonies stand.
 */
export function fallenNests(b: Pick<Board, "queens" | "setup">): { x0: number; y0: number; x1: number; y1: number } | null {
  const felled = fallenQueen(b);
  if (felled === null) return null;
  const pad = b.setup.overrunRadiusTiles + FALL_FRAME_PAD;
  const xs = (b.queens ?? []).filter((q) => q.colony === felled.colony).map((q) => Math.floor(q.x / SUB_TILE));
  const ys = (b.queens ?? []).filter((q) => q.colony === felled.colony).map((q) => Math.floor(q.y / SUB_TILE));
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + 1 + pad, y1: Math.max(...ys) + 1 + pad };
}

/**
 * Ground counted as a queen herself, in tiles around her tile: her mound and rim on the 3D board (board3d/nests.ts
 * MOUND_R) and her emblem on the 2D one. The fall keeps the fallen queen's box whole in the stage at every viewport,
 * and the stills check it.
 */
export const QUEEN_FRAME_TILES = 2;

/**
 * Fall framing only (narrowing the stage filled on both
 * boards): where her ground margin (QUEEN_FRAME_TILES) cannot stay whole down the stage, each fallen queen keeps her tile
 * and her emblem whole, and only her zone and ground margin give way, at the stage's top and bottom. Her emblem is drawn
 * at one size on both boards whatever the zoom (effects.ts QUEEN_EMBLEM: a disc of radius r and its ring, centred on
 * her), so it is counted in CSS px from her tile's centre: r plus half the ring. Read by camera.ts fallView,
 * board3d/view.ts fallPose and the stills' fall check (web/capture/stills.ts).
 */
export const FALL_EMBLEM_PX = 12.25;

/**
 * The fallen queens' box: the box around every queen of the fallen colony (fallenQueen's), each her tile and
 * QUEEN_FRAME_TILES around, in tiles — one fallen queen's own box where the colony had one (the fall
 * frames every fallen queen whole); null while both colonies stand. Its callers are the 3D fall's framing (fallPose) and the 2D one (camera.ts fallView), which never cuts it.
 */
export function fallenQueenBox(b: Pick<Board, "queens">): { x0: number; y0: number; x1: number; y1: number } | null {
  const felled = fallenQueen(b);
  if (felled === null) return null;
  const fallen = (b.queens ?? []).filter((q) => q.colony === felled.colony);
  const xs = fallen.map((q) => Math.floor(q.x / SUB_TILE));
  const ys = fallen.map((q) => Math.floor(q.y / SUB_TILE));
  return { x0: Math.min(...xs) - QUEEN_FRAME_TILES, y0: Math.min(...ys) - QUEEN_FRAME_TILES, x1: Math.max(...xs) + 1 + QUEEN_FRAME_TILES, y1: Math.max(...ys) + 1 + QUEEN_FRAME_TILES };
}

/** The playback target at which the result card follows the match's end by its beat; shownTick as queenLossAge's (Frame.endShown). */
export function resultShownAt(result: Pick<StreamResult, "tick">, shownTick = result.tick + 1): number {
  return Math.max(result.tick + 1, shownTick) * TICK_MS + RESULT_BEAT_MS;
}

/** One timeline entry. Fields that settle later are shown only once playback reaches endTick. */
export interface StoryEntry {
  id: number;
  /** queen_attack: bites landing on a queen with HP, from the first bite until she is lost, healed or left alone. */
  kind: "contact" | "lead" | "overrun" | "queen_founded" | "queen_lost" | "queen_attack";
  queenId?: number;
  tick: number;
  /** The colony that acted: the first to strike, the new leader, or the attacker; for a queen attacked, her own colony. */
  colony: Colony;
  /** The squad involved (its agent index), or -1. */
  agent: number;
  /** Where on the board, in tiles. */
  x: number;
  y: number;
  /** Overrun attempts: the tick it ended, its peak progress and required ticks, and how it ended. */
  endTick?: number;
  peak?: number;
  required?: number;
  outcome?: "repelled" | "took" | "unfinished";
  /** A queen attack: the lowest HP (milli-HP) she was brought to. */
  lowHp?: number;
}

/**
 * One chat line: an agent's new intent, or a mark it laid. Lines are
 * read from the boards, not from events, so a reconnect's full snapshot
 * recovers what a dropped message carried and repeats nothing already posted.
 */
export interface ChatLine {
  kind: "intent" | "mark";
  tick: number;
  agent: number;
  colony: Colony;
  /** The intent line ("" for a mark). */
  text: string;
  /** A mark's vocabulary word indexes ([] for an intent, and for a count mark). */
  words: readonly number[];
  /** A count mark's verb and count, once the stream carries them. */
  verb?: string;
  count?: number;
  caste?: StreamMark["caste"];
  /**
   * The mark this line tells of, as the board carried it when the line was posted:
   * its id, tile and laid tick, kept after the mark fades. -1 for an intent.
   */
  markId: number;
  tileX: number;
  tileY: number;
  laidTick: number;
}

/**
 * One command: a call event as the stream carries it, joined with the order or the mark the same agent set
 * in the same message. Read from events, so a live page has the commands from its arrival and a replay every one.
 */
export interface CommandEntry {
  id: number;
  tick: number;
  agent: number;
  colony: Colony;
  call: CallKind;
  accepted: boolean;
  /** The order an accepted order call set. */
  order?: { kind: OrderKind; tileX: number; tileY: number; intent: string };
  /** The mark an accepted mark or count-mark call laid, as the stream carried it then. */
  mark?: StreamMark;
}

/** A bite on a queen, read from this message's queenHp events. */
interface QueenBite {
  colony: Colony;
  queenId: number;
  tick: number;
  x: number;
  y: number;
  /** Her HP after the bite. */
  hp: number;
}

/** The chat keeps this many lines. */
export const CHAT_LINES = 200;

/** One frame of interpolated state, reused between frames to avoid allocation. */
export class Frame {
  renderMs = 0;
  /**
   * The delayed playback time asked for, before clamping to the newest message: the same as
   * renderMs while the buffer has messages ahead, and still moving once a stream has ended, so
   * a fall's collapse and the result's beat play out at a match's end, as the finale fade does.
   */
  targetMs = 0;
  /** Tick of the earlier bracketing message. */
  tick = 0;
  count = 0;
  /** Territory blend between owner grids A and B, 0..1. */
  blend = 0;
  mapW = 0;
  mapH = 0;
  territoryA: Uint8Array = new Uint8Array(0);
  territoryB: Uint8Array = new Uint8Array(0);
  /** Trails of the earlier message; they fade slowly, so they are not blended. */
  trails: Float32Array = new Float32Array(0);
  id = new Uint32Array(0);
  /** Positions in tiles. */
  x = new Float32Array(0);
  y = new Float32Array(0);
  rotation = new Float32Array(0);
  alpha = new Float32Array(0);
  colony = new Uint8Array(0);
  /** Agent whose squad holds the ant, or -1. */
  agent = new Int16Array(0);
  /** Walk-cycle frame 0..2. */
  walk = new Uint8Array(0);
  /** 1 for a soldier, 0 for a worker (always 0 with the rules switch off). */
  caste = new Uint8Array(0);
  /** 1 while the ant carries food home. */
  carrying = new Uint8Array(0);
  corpses: Corpse[] = [];
  fights: Fight[] = [];
  /** Delayed, event-confirmed pairs; never reconstructed from proximity alone. */
  engagements: readonly Engagement[] = [];
  /** Shared capped travel/combat facing; null for hand-built frames. Canonical rotation stays untouched. */
  drawRotation: Float64Array | null = null;
  /** Travel-only body coordinates. Hits, labels and marks still use x/y; bite poses take priority. */
  drawX: Float64Array | null = null;
  drawY: Float64Array | null = null;
  marks: VisibleMark[] = [];
  /** Bites on a queen within HIT_FLASH_MS. */
  hits: QueenHit[] = [];
  /**
   * The tick playback showed each queen's loss at (by "colony:id") and the match's end at: the message
   * that carried it, or the stream's own tick where a snapshot restated it. The collapse, the lingering
   * row and the result's beat run from these (queenLossAge, resultShownAt), so a loss a stream carries
   * later than its stamped tick (a recording caught from the public stream) still plays out when seen.
   */
  lossShown: ReadonlyMap<string, number> = new Map();
  endShown: number | null = null;
  /**
   * The match this frame is of, as Playback counts them (Playback.matches): a reconnect to the same match keeps it,
   * another match changes it; a fresh Playback (a replay seek) counts from the first again. 0 before any board.
   */
  match = 0;
  /** The board at the earlier bracketing message; null before the first full snapshot. */
  board: Board | null = null;
  /** That message's stream ants, index-aligned with id..carrying (a colony's sight is built from these). */
  ants: StreamAnts | null = null;
  /** One colony's sight, one byte per tile (1 seen), when the board shows that colony's view; null for Full view. */
  fog: Uint8Array | null = null;
  /** Timeline entries playback has reached, oldest first. */
  story: StoryEntry[] = [];
  /** Chat lines playback has reached, oldest first (the newest last). */
  chat: ChatLine[] = [];
  /** Commands playback has reached, oldest first; the same array while none is added. */
  commands: CommandEntry[] = [];

  ensure(n: number) {
    if (this.id.length >= n) return;
    const cap = Math.max(n, this.id.length * 2, 64);
    this.id = new Uint32Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.rotation = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.colony = new Uint8Array(cap);
    this.agent = new Int16Array(cap);
    this.walk = new Uint8Array(cap);
    this.caste = new Uint8Array(cap);
    this.carrying = new Uint8Array(cap);
  }
}

const TAU = Math.PI * 2;

function heldTiles(territory: Uint8Array): [number, number] {
  let a = 0;
  let b = 0;
  for (let i = 0; i < territory.length; i++) {
    const o = territory[i]!;
    if (o === 1) a++;
    else if (o === 2) b++;
  }
  return [a, b];
}

function cloneFull(f: StreamFull): StreamFull {
  return {
    ...(f.match !== undefined ? { match: f.match } : {}),
    setup: f.setup,
    ...(f.territoryWin === undefined ? {} : { territoryWin: { ...f.territoryWin } }),
    ...(f.queens === undefined ? {} : { queens: f.queens.map((q) => ({ ...q })) }),
    ...(f.hatched === undefined ? {} : { hatched: [...f.hatched] as [number, number] }),
    territory: f.territory.slice(),
    marks: f.marks.map((m) => ({ ...m, words: m.words.slice() })),
    agents: f.agents.map((a) => ({ ...a })),
    overrun: [f.overrun[0], f.overrun[1]],
    overrunRequired: f.overrunRequired,
    deaths: [f.deaths[0], f.deaths[1]],
    result: f.result,
    ...(f.food !== undefined ? { food: f.food.slice() } : {}),
    ...(f.hatch !== undefined ? { hatch: { ...f.hatch } } : {}),
    ...(f.stores !== undefined ? { stores: [{ ...f.stores[0] }, { ...f.stores[1] }] as [StreamStore, StreamStore] } : {}),
  };
}

/**
 * A colony's queen zone, as the sim defines it: the queen's tile (tx, ty) and
 * the Chebyshev radius r in tiles, so the zone is tiles tx-r..tx+r by ty-r..ty+r.
 * The overrun bar's squads and the board's queen-home brackets both read it.
 */
export function queenZone(setup: StreamSetup, colony: Colony): { tx: number; ty: number; r: number } {
  return { tx: Math.floor(setup.queens[colony][0] / SUB_TILE), ty: Math.floor(setup.queens[colony][1] / SUB_TILE), r: setup.overrunRadiusTiles };
}

/**
 * The squads of one colony with ants within the queen zone of the other colony's queen, most ants first.
 * The zone is the sim's: an ant's tile within overrunRadiusTiles of the queen's tile in both axes (Chebyshev).
 */
export function squadsInQueenZone(ants: StreamAnts, setup: StreamSetup, defender: Colony): number[] {
  const { tx: qtx, ty: qty, r } = queenZone(setup, defender);
  const counts = new Map<number, number>();
  for (let i = 0; i < ants.count; i++) {
    const agent = ants.agent[i]!;
    if (agent < 0 || ants.colony[i] === defender) continue;
    const dx = Math.floor(ants.x[i]! / SUB_TILE) - qtx;
    const dy = Math.floor(ants.y[i]! / SUB_TILE) - qty;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= r) counts.set(agent, (counts.get(agent) ?? 0) + 1);
  }
  return [...counts].sort((p, q) => q[1] - p[1] || p[0] - q[0]).map(([agent]) => agent);
}

/**
 * The commands playback has reached by tick (they are kept in tick order): the frame's own array again while that is
 * still the same prefix, so a reader can tell nothing was added without comparing every entry.
 */
function reached(all: readonly CommandEntry[], tick: number, shown: CommandEntry[]): CommandEntry[] {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid]!.tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo === shown.length && (lo === 0 || shown[lo - 1] === all[lo - 1]) ? shown : all.slice(0, lo);
}

/**
 * Derives timeline entries, chat lines and commands from messages in order. A Story lasts
 * one match: a full snapshot of the same match (a reconnect) keeps it.
 */
class Story {
  readonly entries: StoryEntry[] = [];
  readonly chat: ChatLine[] = [];
  /** Every command of the match this page received, oldest first, kept whole as the timeline entries are. */
  readonly commands: CommandEntry[] = [];
  private nextCommand = 1;
  /** Each agent's intent as last read; null before the match's first board. */
  private intents: Map<number, string> | null = null;
  /** Marks already seen, by mark id: the line each posted, or null for one that posted none. */
  private markLines = new Map<number, ChatLine | null>();
  /** The board parts last read for the chat: it reads them again only when they change. */
  private chatAgents: Board["agents"] | null = null;
  private chatMarks: Board["marks"] | null = null;
  private contact = false;
  private leader: Colony | null = null;
  private open: [StoryEntry | null, StoryEntry | null] = [null, null];
  private nextId = 1;
  private queenOpen = new Map<string, StoryEntry>();
  private queenSeen = new Set<string>();
  /** Each attacked queen's open attack entry and the tick of the last bite on her. */
  private attackOpen = new Map<string, StoryEntry>();
  private attackLast = new Map<string, number>();

  observe(m: StreamMessage, board: Board, bites: readonly QueenBite[] = []): void {
    this.observeCommands(m, board);
    this.observeChat(m.tick, board);
    this.observeAttacks(m, board, bites);
    const ants = m.ants;
    const at = (id: number) => {
      // Ant ids ascend; binary search.
      let lo = 0;
      let hi = ants.count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = ants.id[mid]!;
        if (v === id) return mid;
        if (v < id) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    };
    if (!this.contact) {
      // First contact names the squad involved where there is one: of this tick's fights, the first
      // whose striking ant is in a squad (named with its colony), else the first whose struck ant is
      // (named with that ant's colony), else the first fight, with no squad.
      const squadOf = (id: number): { agent: number; colony: Colony } | null => {
        const i = at(id);
        return i >= 0 && ants.agent[i]! >= 0 ? { agent: ants.agent[i]!, colony: ants.colony[i]! as Colony } : null;
      };
      let pick: { colony: Colony; agent: number; x: number; y: number } | null = null;
      for (const e of m.events) {
        if (e.kind !== "fight") continue;
        const x = e.tileX + 0.5;
        const y = e.tileY + 0.5;
        const striker = squadOf(e.antId);
        if (striker !== null) {
          pick = { colony: e.colony, agent: striker.agent, x, y };
          break;
        }
        const struck = squadOf(e.targetId);
        if (struck !== null && (pick === null || pick.agent < 0)) pick = { colony: struck.colony, agent: struck.agent, x, y };
        else pick ??= { colony: e.colony, agent: -1, x, y };
      }
      if (pick !== null) {
        this.contact = true;
        this.add({ kind: "contact", tick: m.tick, ...pick });
      }
    }
    for (const e of m.events) {
      if (e.kind === "queenOverrun") {
        const key = `${e.colony}:${e.queenId}`;
        const q = board.queens?.find((q) => q.colony === e.colony && q.id === e.queenId);
        if (!q) continue;
        let open = this.queenOpen.get(key);
        if (e.progress > 0 && !open) {
          open = this.add({ kind: "overrun", queenId: q.id, tick: m.tick, colony: (1 - q.colony) as Colony, agent: -1, x: q.x / SUB_TILE, y: q.y / SUB_TILE, peak: e.progress, required: e.required });
          this.queenOpen.set(key, open);
        } else if (open) {
          open.peak = Math.max(open.peak ?? 0, e.progress);
          if (e.progress === 0) { open.endTick = m.tick; open.outcome = "repelled"; this.queenOpen.delete(key); }
        }
      } else if (e.kind === "overrun") {
        const defender = e.colony;
        const open = this.open[defender];
        if (e.progress > 0 && open === null) {
          const squads = squadsInQueenZone(ants, board.setup, defender);
          const [qx, qy] = board.setup.queens[defender];
          const entry = this.add({ kind: "overrun", tick: m.tick, colony: (1 - defender) as Colony, agent: squads[0] ?? -1, x: qx / SUB_TILE, y: qy / SUB_TILE });
          entry.peak = e.progress;
          entry.required = e.required;
          this.open[defender] = entry;
        } else if (open !== null) {
          open.peak = Math.max(open.peak ?? 0, e.progress);
          if (e.progress === 0) {
            open.endTick = m.tick;
            open.outcome = "repelled";
            this.open[defender] = null;
          }
        }
      } else if (e.kind === "end") {
        for (const defender of [0, 1] as const) {
          const open = this.open[defender];
          if (open === null) continue;
          open.endTick = m.tick;
          // Only an overrun ending takes the queen; any other end under an open attempt (time-up, or an end main may add) leaves it unfinished.
          const reason: string = e.result.reason;
          const took = (reason === "overrun" && e.result.winner === open.colony) || reason === "double_overrun";
          open.outcome = took ? "took" : reason === "overrun" ? "repelled" : "unfinished";
          if (took) open.peak = open.required;
          this.open[defender] = null;
        }
      }
    }
    // Queen history also comes with full reconnect snapshots, so a lost delta loses no landmark or event line.
    for (const q of board.queens ?? []) {
      const key = `${q.colony}:${q.id}`;
      for (const kind of ["queen_founded", "queen_lost"] as const) {
        const tick = kind === "queen_founded" ? (isStartingQueen(board.setup, q) ? null : q.foundedTick) : q.lostTick;
        if (tick === null || this.queenSeen.has(`${key}:${kind}`)) continue;
        this.queenSeen.add(`${key}:${kind}`);
        // A loss is told from the message that carried it, as its collapse plays (Frame.lossShown), never from before.
        this.add({ kind, tick: kind === "queen_lost" ? Math.max(tick + 1, m.tick) : tick + 1, colony: q.colony, queenId: q.id, agent: -1, x: q.x / SUB_TILE, y: q.y / SUB_TILE });
      }
      const open = this.queenOpen.get(key);
      if (open && (q.lostTick !== null || board.result !== null)) {
        open.endTick = q.lostTick === null ? m.tick : q.lostTick + 1;
        open.outcome = q.lostTick === null ? "unfinished" : "took";
        if (q.lostTick !== null) open.peak = open.required;
        this.queenOpen.delete(key);
      }
    }
    this.entries.sort((a, b) => a.tick - b.tick || a.id - b.id);
    // Lead changes in the tug-of-war: only a change from one colony to the other counts.
    const [a, b] = board.held;
    const total = Math.max(1, a + b);
    const lead: Colony | null = a - b >= LEAD_MARGIN * total ? 0 : b - a >= LEAD_MARGIN * total ? 1 : null;
    if (lead !== null && lead !== this.leader) {
      if (this.leader !== null) {
        const flipped = m.events.flatMap((e) => (e.kind === "territory" ? e.tiles.filter((_, k) => e.owners[k] === lead + 1) : []));
        const W = board.setup.mapW;
        let x = board.setup.mapW / 2;
        let y = board.setup.mapH / 2;
        if (flipped.length > 0) {
          x = flipped.reduce((s, t) => s + (t % W), 0) / flipped.length + 0.5;
          y = flipped.reduce((s, t) => s + Math.floor(t / W), 0) / flipped.length + 0.5;
        }
        // The leader's squad with the most ants on the tiles it just took.
        const onTiles = new Set(flipped);
        const counts = new Map<number, number>();
        for (let i = 0; i < ants.count; i++) {
          const agent = ants.agent[i]!;
          if (agent < 0 || ants.colony[i] !== lead) continue;
          const tile = Math.floor(ants.y[i]! / SUB_TILE) * W + Math.floor(ants.x[i]! / SUB_TILE);
          if (onTiles.has(tile)) counts.set(agent, (counts.get(agent) ?? 0) + 1);
        }
        const top = [...counts].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0];
        this.add({ kind: "lead", tick: m.tick, colony: lead, agent: top?.[0] ?? -1, x, y });
      }
      this.leader = lead;
    }
  }

  /**
   * An attack on a queen with HP: opened by the first bite on her, deepened by each
   * bite (lowHp), and ended when she is lost (took), when the match ends under it (unfinished),
   * or when she is back at full HP or no bite has landed for ATTACK_LULL_S (repelled). Her own
   * colony is the entry's, as for a queen lost.
   */
  private observeAttacks(m: StreamMessage, board: Board, bites: readonly QueenBite[]): void {
    for (const b of bites) {
      const key = `${b.colony}:${b.queenId}`;
      const open = this.attackOpen.get(key);
      if (open) open.lowHp = Math.min(open.lowHp ?? b.hp, b.hp);
      else this.attackOpen.set(key, this.add({ kind: "queen_attack", queenId: b.queenId, tick: m.tick, colony: b.colony, agent: -1, x: b.x, y: b.y, lowHp: b.hp }));
      this.attackLast.set(key, m.tick);
    }
    const maxHp = boardQueenHp(board)?.hp;
    const lull = ATTACK_LULL_S * (board.setup.ticksPerSecond || 10);
    for (const [key, open] of this.attackOpen) {
      const q = board.queens?.find((q) => `${q.colony}:${q.id}` === key);
      const end = (endTick: number, outcome: StoryEntry["outcome"]) => {
        open.endTick = endTick;
        open.outcome = outcome;
        this.attackOpen.delete(key);
        this.attackLast.delete(key);
      };
      if (q === undefined) continue;
      if (q.lostTick !== null) {
        open.lowHp = 0;
        end(q.lostTick + 1, "took");
      } else if (board.result !== null) end(m.tick, "unfinished");
      else if ((maxHp !== undefined && (q.hp ?? 0) >= maxHp) || m.tick - (this.attackLast.get(key) ?? m.tick) >= lull) end(m.tick, "repelled");
    }
  }

  /**
   * Commands from this message's call events, each with the order or mark its agent set in the same message,
   * taken in event order so two calls of one agent each find their own. An agent the board does not hold is skipped.
   */
  private observeCommands(m: StreamMessage, board: Board): void {
    const used = new Set<StreamMessage["events"][number]>();
    for (const e of m.events) {
      if (e.kind !== "call") continue;
      const a = board.agents[e.agent];
      if (!a) continue;
      const entry: CommandEntry = { id: this.nextCommand++, tick: m.tick, agent: e.agent, colony: a.colony as Colony, call: e.call, accepted: e.accepted };
      if (e.accepted && e.call === "order") {
        const set = m.events.find((o) => o.kind === "order" && o.agent === e.agent && !used.has(o));
        if (set?.kind === "order") {
          used.add(set);
          entry.order = { kind: set.order, tileX: set.tileX, tileY: set.tileY, intent: set.intent };
        }
      } else if (e.accepted && (e.call === "mark" || e.call === "count_mark")) {
        const laid = m.events.find((o) => o.kind === "mark" && o.mark.agent === e.agent && !used.has(o));
        if (laid?.kind === "mark") {
          used.add(laid);
          entry.mark = { ...laid.mark, words: laid.mark.words.slice() };
        }
      }
      this.commands.push(entry);
    }
  }

  /**
   * Chat lines from the board after the message at tick: an agent's intent when
   * it is not empty and differs from the one last read for that agent; a mark the
   * first time its id is seen. The match's first board posts each agent's current
   * intent and no line for the marks already live.
   */
  private observeChat(tick: number, board: Board): void {
    const first = this.intents === null;
    const intents = (this.intents ??= new Map());
    if (board.agents !== this.chatAgents) {
      this.chatAgents = board.agents;
      board.agents.forEach((a, i) => {
        if (a.intent !== "" && a.intent !== (intents.get(i) ?? "")) this.post({ kind: "intent", tick, agent: i, colony: a.colony, text: a.intent, words: [], markId: -1, tileX: 0, tileY: 0, laidTick: -1 });
        intents.set(i, a.intent);
      });
    }
    if (board.marks !== this.chatMarks) {
      this.chatMarks = board.marks;
      for (const mk of board.marks) {
        const line = this.markLines.get(mk.id);
        if (line !== undefined) {
          // A count mark laid again in place keeps its id (StreamMark.revision; the stream sends the mark again): its
          // line follows it, so the feed reads the order the board carries now, never one revision's requested count
          // beside another's answered ants (a past regression).
          if (line !== null) Object.assign(line, { verb: mk.verb, count: mk.count, caste: mk.caste, tileX: mk.tileX, tileY: mk.tileY, laidTick: mk.laidTick });
          continue;
        }
        // A count mark's verb and count ride along. A wordless mark the stream carries no verb for (an older
        // recording) has no reading and posts no line (nothing in the
        // feed, never a dash or a lone "here"); its marker still shows on the board.
        if (first || (mk.words.length === 0 && mk.verb === undefined)) {
          this.markLines.set(mk.id, null);
          continue;
        }
        const posted: ChatLine = { kind: "mark", tick, agent: mk.agent, colony: mk.colony, text: "", words: mk.words.slice(), ...(mk.verb === undefined ? {} : { verb: mk.verb }), ...(mk.count === undefined ? {} : { count: mk.count }), ...(mk.caste === undefined ? {} : { caste: mk.caste }), markId: mk.id, tileX: mk.tileX, tileY: mk.tileY, laidTick: mk.laidTick };
        this.markLines.set(mk.id, posted);
        this.post(posted);
      }
    }
  }

  private post(line: ChatLine): void {
    this.chat.push(line);
    if (this.chat.length > CHAT_LINES) this.chat.splice(0, this.chat.length - CHAT_LINES);
  }

  private add(e: Omit<StoryEntry, "id">): StoryEntry {
    const entry: StoryEntry = { id: this.nextId++, ...e };
    this.entries.push(entry);
    return entry;
  }
}

/** A prepared full board or just its changed parts. Cloning never forces unchanged textures/rows to update. */
export type PreparedTick = {
  m: StreamMessage;
  index: Map<number, number>;
  trails: Float32Array;
} & ({ kind: "full"; board: Board } | { kind: "delta"; board: Partial<Board> });

/** Decode-adjacent state preparation only: event/story/engagement derivation stays in Playback. */
export class TickPreparation {
  private state: SpectatorState | null = null;
  private previous: { tick: number; board: Board } | null = null;
  private trailSeed = new Float32Array(0);

  prepare(m: StreamMessage): PreparedTick | null {
    if (m.full !== null) {
      this.state = new SpectatorState(cloneFull(m.full), m.tick, m.ants);
      this.previous = null;
      this.trailSeed = new Float32Array(0);
    } else {
      if (this.state === null || (this.previous && m.tick <= this.previous.tick)) return null;
      this.state.apply(m);
    }
    const prev = this.previous;
    const board = this.nextBoard(m, this.state!.full, prev?.board ?? null);
    const index = new Map<number, number>();
    const ants = m.ants;
    for (let i = 0; i < ants.count; i++) index.set(ants.id[i]!, i);
    const tw = board.setup.mapW * TRAIL_RES;
    const size = tw * board.setup.mapH * TRAIL_RES * 2;
    if (this.trailSeed.length !== size) this.trailSeed = new Float32Array(size);
    else if (prev) {
      const decay = TRAIL_DECAY_PER_TICK ** (m.tick - prev.tick);
      for (let i = 0; i < size; i++) this.trailSeed[i] = this.trailSeed[i]! * decay;
    }
    for (let i = 0; i < ants.count; i++) {
      const tx = Math.floor(ants.x[i]! * TRAIL_RES / SUB_TILE);
      const ty = Math.floor(ants.y[i]! * TRAIL_RES / SUB_TILE);
      const k = (ty * tw + tx) * 2 + ants.colony[i]!;
      this.trailSeed[k] = Math.min(1, this.trailSeed[k]! + TRAIL_DEPOSIT);
    }
    // Retain one reusable seed; transfer the tick's copy without detaching future preparation.
    const trails = this.trailSeed.slice();
    this.previous = { tick: m.tick, board };
    if (!prev) return { kind: "full", m, board, index, trails };
    const changed: Partial<Board> = {};
    for (const key of Object.keys(board) as (keyof Board)[]) {
      if (board[key] !== prev.board[key]) Object.assign(changed, { [key]: board[key] });
    }
    return { kind: "delta", m, board: changed, index, trails };
  }

  /** The board after message m, sharing every part that did not change with the previous board. */
  private nextBoard(m: StreamMessage, f: StreamFull, prev: Board | null): Board {
    // Read the received full on reconnect and the spectator model on deltas; never infer totals.
    const source = m.full ?? f;
    const hatched = source.hatched ? [source.hatched[0], source.hatched[1]] as const : undefined;
    if (prev === null) {
      const territory = f.territory.slice();
      return {
        setup: f.setup,
        ...(f.territoryWin === undefined ? {} : { territoryWin: { ...f.territoryWin } }),
        ...(f.queens === undefined ? {} : { queens: f.queens.map((q) => ({ ...q })) }),
        territory,
        held: heldTiles(territory),
        marks: f.marks.map((x) => ({ ...x })),
        agents: f.agents.map((a) => ({ ...a })),
        overrun: [f.overrun[0], f.overrun[1]],
        overrunRequired: f.overrunRequired,
        deaths: [f.deaths[0], f.deaths[1]],
        hatched,
        result: f.result,
        food: f.food?.slice() ?? new Uint32Array(f.setup.mapW * f.setup.mapH),
        hatch: f.hatch ? { ...f.hatch } : null,
        stores: f.stores ? [{ ...f.stores[0] }, { ...f.stores[1] }] : NO_STORES,
      };
    }
    const kinds = new Set(m.events.map((e) => e.kind));
    const territory = kinds.has("territory") ? f.territory.slice() : prev.territory;
    const marksChanged = kinds.has("mark") || kinds.has("markGone") || kinds.has("answered");
    const agentsChanged = kinds.has("join") || kinds.has("call") || kinds.has("order");
    const deathsChanged = kinds.has("death");
    const overrunChanged = kinds.has("overrun") || kinds.has("queenOverrun");
    const queensChanged = kinds.has("queenFounded") || kinds.has("queenLost") || kinds.has("queenOverrun") || kinds.has("overrun") || kinds.has("queenHp");
    return {
      setup: f.setup,
      // An explicit undefined must cross the partial-board boundary to clear a previously shown lead.
      territoryWin: f.territoryWin === undefined ? undefined : kinds.has("territoryWin") ? { ...f.territoryWin } : prev.territoryWin,
      ...(f.queens === undefined ? {} : { queens: queensChanged ? f.queens.map((q) => ({ ...q })) : prev.queens }),
      territory,
      held: territory === prev.territory ? prev.held : heldTiles(territory),
      marks: marksChanged ? f.marks.map((x) => ({ ...x })) : prev.marks,
      agents: agentsChanged ? f.agents.map((a) => ({ ...a })) : prev.agents,
      overrun: overrunChanged ? [f.overrun[0], f.overrun[1]] : prev.overrun,
      overrunRequired: f.overrunRequired,
      deaths: deathsChanged ? [f.deaths[0], f.deaths[1]] : prev.deaths,
      hatched,
      result: f.result,
      food: kinds.has("food") && f.food ? f.food.slice() : prev.food,
      hatch: prev.hatch,
      stores: kinds.has("store") && f.stores ? [{ ...f.stores[0] }, { ...f.stores[1] }] : prev.stores,
    };
  }

}

export class Playback {
  private readonly playout: Playout | null;

  /** Live opts into buffered/rate-controlled playback. Recording/capture callers retain their exact mapping. */
  constructor(options: { live?: boolean } = {}) {
    this.playout = options.live ? new Playout() : null;
  }

  private held: Held[] = [];
  private readonly pivots = new Pivots();
  private offsetMs: number | null = null;
  private readonly preparation = new TickPreparation();
  private matchId: number | undefined;
  private board: Board | null = null;
  /** Borrow the latest output; during same-match refill sample leaves it untouched. One frame, not old tick history. */
  private drawnFrame: Frame | null = null;
  private bufferingFrame: Frame | null = null;
  private births = new Map<number, number>();
  private deaths: { antId: number; tick: number; x: number; y: number; colony: Colony }[] = [];
  private dead = new Set<number>();
  private fights: { a: number; b: number; tick: number; x: number; y: number }[] = [];
  private readonly engagementTracker = new EngagementTracker();
  /** Each queen's HP as last streamed, and the bites read as drops in it. */
  private lastHp = new Map<string, number>();
  private hits: QueenBite[] = [];
  /** Frame.lossShown and Frame.endShown: the message that first carried each loss and the end, within one match. */
  private lossShown = new Map<string, number>();
  private endShown: number | null = null;
  /** Tick from which each mark is shown: the message that carried it. */
  private markShown = new Map<number, number>();
  /** Heading of each ant at its last sighting, for its corpse. */
  private lastHeading = new Map<number, number>();
  private story = new Story();
  /** Full snapshots received, the first included. */
  resets = 0;
  /** Distinct matches started (a full snapshot of another match), the first included: the page opens each on the fight. */
  matches = 0;

  /** Recording/test route; live pages supply the same preparation from a worker. */
  push(m: StreamMessage, arrivalMs: number): void {
    const prepared = this.preparation.prepare(m);
    if (prepared) this.pushPrepared(prepared, arrivalMs);
  }

  /** Adopt precomputed state without decoding, rebuilding grids or applying the model on this thread. */
  pushPrepared(prepared: PreparedTick, arrivalMs: number): void {
    const { m, index, trails } = prepared;
    if (prepared.kind === "full") this.restart(m, arrivalMs);
    else if (this.board === null || m.tick <= this.newestTick) return;
    if (this.offsetMs === null) this.offsetMs = arrivalMs - m.tick * TICK_MS;
    const prev = this.held.at(-1) ?? null;
    const board = prepared.kind === "full" ? prepared.board : { ...this.board!, ...prepared.board };
    this.board = board;
    // A loss or an end first seen here is shown from this message; one a first snapshot restates, from its own tick.
    for (const q of board.queens ?? []) {
      if (q.lostTick === null) continue;
      const key = `${q.colony}:${q.id}`;
      if (!this.lossShown.has(key)) this.lossShown.set(key, prev === null ? q.lostTick + 1 : m.tick);
    }
    if (board.result !== null && this.endShown === null) this.endShown = prev === null ? board.result.tick + 1 : m.tick;

    const ants = m.ants;
    for (let i = 0; i < ants.count; i++) this.lastHeading.set(ants.id[i]!, (ants.heading[i]! / 256) * TAU);
    for (const e of m.events) {
      if (e.kind === "birth") this.births.set(e.antId, m.tick);
      else if (e.kind === "death") this.addDeath(e.antId, m.tick, e.x, e.y, e.colony);
      else if (e.kind === "fight") {
        const i = index.get(e.antId);
        const j = index.get(e.targetId);
        let x = (e.tileX + 0.5) * SUB_TILE;
        let y = (e.tileY + 0.5) * SUB_TILE;
        if (i !== undefined && j !== undefined) {
          x = (ants.x[i]! + ants.x[j]!) / 2;
          y = (ants.y[i]! + ants.y[j]!) / 2;
        }
        this.fights.push({ a: e.antId, b: e.targetId, tick: m.tick, x, y });
      } else if (e.kind === "mark" && !this.markShown.has(e.mark.id)) {
        // A count mark re-laid in place, or whose claims changed, comes as another mark event: its age is its first showing's.
        this.markShown.set(e.mark.id, m.tick);
      }
    }
    if (m.full !== null) for (const mk of board.marks) if (!this.markShown.has(mk.id)) this.markShown.set(mk.id, Math.min(m.tick, mk.laidTick + 1));
    // A dropped message takes its events with it. Births and deaths are also
    // visible in the ant sets themselves, so recover them from those: an ant
    // that appears unannounced fades in from this tick, and one that vanishes
    // unannounced leaves a corpse where it was last seen. (A dropped message's
    // fights are not recoverable and are not shown.)
    if (prev) {
      const p = prev.ants;
      for (let i = 0; i < ants.count; i++) {
        const id = ants.id[i]!;
        if (!prev.index.has(id) && !this.births.has(id)) this.births.set(id, m.tick);
      }
      for (let i = 0; i < p.count; i++) {
        const id = p.id[i]!;
        if (!index.has(id)) this.addDeath(id, m.tick, p.x[i]!, p.y[i]!, p.colony[i]! as Colony);
      }
    }
    const bites = this.queenBites(m, board);
    this.hits.push(...bites);
    this.story.observe(m, board, bites);
    const engagements = this.engagementTracker.observe(m, gridScale(board.setup));
    const facing = new Map<number, CombatFacing>();
    const pairs = new Map(engagements.map((p) => [p.a, p]));
    for (let i = 0; i < ants.count; i++) {
      const id = ants.id[i]!, travel = ants.heading[i]! / 256 * TAU;
      const previous = prev?.tick === m.tick - 1 ? prev.facing.get(id) : undefined;
      let rotation = travel, recovering = false;
      const pi = prev?.index.get(id);
      if (previous && pi !== undefined) {
        const end = combatSteeringAt(previous, prev!.ants.heading[pi]! / 256 * TAU, travel, TICK_MS, TICK_MS);
        rotation = end.rotation; recovering = end.recovering;
      }
      const pair = pairs.get(id), targetIndex = pair ? index.get(pair.b) : undefined;
      // A confirmed terminal hit may target an ant absent from the live arrays.
      // Its last held coordinates are the same boundary used for its corpse.
      const lastTarget = pair ? prev?.index.get(pair.b) : undefined;
      const tx = targetIndex !== undefined ? ants.x[targetIndex] : lastTarget !== undefined ? prev!.ants.x[lastTarget] : undefined;
      const ty = targetIndex !== undefined ? ants.y[targetIndex] : lastTarget !== undefined ? prev!.ants.y[lastTarget] : undefined;
      if (pair && tx !== undefined && ty !== undefined) {
        const dx = tx - ants.x[i]!, dy = ty - ants.y[i]!;
        const bearing = dx === 0 && dy === 0 ? (id < pair.b ? 0 : Math.PI) : Math.atan2(dy, dx);
        const terminal = pair.terminalTick !== undefined;
        const prior = previous?.terminalBearing;
        const change = prior === undefined ? 0 : angleDelta(prior, bearing);
        // Successive terminal victims can alternate sides every tick. Average
        // only their two raw bearings: a stable direction is exact next tick,
        // and live targets/recovery never inherit this history. Opposed bearings
        // have no unique mean, so prefer the current confirmed direction.
        const target = terminal && prior !== undefined && Math.abs(Math.abs(change) - Math.PI) > 1e-9
          ? prior + change / 2 : bearing;
        facing.set(id, { rotation, target, ...(terminal ? { terminalBearing: bearing } : {}) });
      } else if (recovering && Math.abs(angleDelta(rotation, travel)) > 1e-9) {
        facing.set(id, { rotation, target: null });
      }
    }
    this.held.push({ tick: m.tick, ants, index, trails, board, engagements, facing });
  }

  /**
   * This message's bites on a queen: each queenHp event below the HP last streamed for
   * that queen, at her tile. A full snapshot restates every queen's HP, so a drop a dropped message
   * carried is not read as a bite. Regeneration raises HP and is no bite.
   */
  private queenBites(m: StreamMessage, board: Board): QueenBite[] {
    if (m.full !== null) {
      this.lastHp = new Map();
      for (const q of m.full.queens ?? []) if (q.hp !== undefined) this.lastHp.set(`${q.colony}:${q.id}`, q.hp);
    }
    const out: QueenBite[] = [];
    for (const e of m.events) {
      if (e.kind !== "queenHp") continue;
      const key = `${e.colony}:${e.queenId}`;
      const before = this.lastHp.get(key);
      const q = board.queens?.find((q) => q.colony === e.colony && q.id === e.queenId);
      if (before !== undefined && e.hp < before && q !== undefined) out.push({ colony: e.colony, queenId: e.queenId, tick: m.tick, x: q.x / SUB_TILE, y: q.y / SUB_TILE, hp: e.hp });
      this.lastHp.set(key, e.hp);
    }
    return out;
  }

  /**
   * A full snapshot: the first, or a reconnect. Playback restarts from it; the
   * story carries on only within one match. The stream names its match; a
   * full from a different match, or one naming a match when the previous did
   * not (or the reverse), always starts a fresh story. Only when neither names
   * one (a recording) is the match inferred from map size and tick.
   */
  private restart(m: StreamMessage, arrivalMs: number) {
    const full = m.full!;
    const last = this.held.at(-1)?.tick ?? -1;
    const prev = this.board;
    const sameMatch =
      prev !== null && full.match === this.matchId && m.tick >= last && full.setup.mapW === prev.setup.mapW && full.setup.mapH === prev.setup.mapH;
    // Keep the last running drawing while fresh same-match history fills, even
    // if the match ended during the gap. Never borrow a never-drawn snapshot.
    const drawn = this.bufferingFrame ?? this.drawnFrame;
    this.bufferingFrame = this.playout && sameMatch && full.match !== undefined && prev?.result === null && drawn?.board?.result === null
      ? drawn : null;
    this.drawnFrame = null;
    // Only a known live match already received as ended may skip its beat. A first
    // attachment, a new match and recordings keep their normal startup/ending clocks.
    const resumeResultAt = this.playout && sameMatch && full.match !== undefined && prev?.result && full.result
      ? Math.max(this.targetMs(arrivalMs), resultShownAt(full.result, this.endShown ?? undefined)) : null;
    this.matchId = full.match;
    this.resets++;
    this.held = [];
    this.pivots.reset();
    this.offsetMs = arrivalMs - m.tick * TICK_MS;
    this.playout?.reset(m.tick * TICK_MS, arrivalMs);
    if (resumeResultAt !== null) this.playout!.resumeEnded(resumeResultAt, arrivalMs);
    this.deaths = [];
    this.dead = new Set();
    this.fights = [];
    this.hits = [];
    this.births = new Map();
    if (!sameMatch) {
      this.matches++;
      this.story = new Story();
      this.markShown = new Map();
      this.lossShown = new Map();
      this.endShown = null;
    }
    this.board = null;
  }


  private addDeath(antId: number, tick: number, x: number, y: number, colony: Colony) {
    if (this.dead.has(antId)) return;
    this.dead.add(antId);
    this.deaths.push({ antId, tick, x, y, colony });
  }

  get newestTick(): number {
    return this.held.at(-1)?.tick ?? -1;
  }

  /** The newest board received (not the delayed one), or null. */
  get latestBoard(): Board | null {
    return this.board;
  }

  /** Delayed playback time in match ms; a terminal clock continues after the newest tick for its ending. */
  targetMs(nowMs: number): number {
    if (this.playout) return this.playout.at(nowMs, this.newestTick * TICK_MS, this.board?.result != null) ?? (this.held[0]?.tick ?? 0) * TICK_MS;
    return nowMs - (this.offsetMs ?? 0) - RENDER_DELAY_MS;
  }

  /** Whether data has run out, distinct from the live clock intentionally buffering before its first frame. */
  underrun(nowMs: number): boolean {
    if (this.held.length === 0) return true;
    const target = this.targetMs(nowMs);
    if (this.playout) return this.playout.ready && this.board?.result === null && target >= this.newestTick * TICK_MS;
    return target > this.newestTick * TICK_MS;
  }

  /** Fill frame for client time nowMs. Idempotent for the same nowMs and pushes. */
  sample(nowMs: number, frame: Frame): boolean {
    const held = this.held;
    if (held.length === 0) return false;
    const target = this.targetMs(nowMs);
    if (this.playout && !this.playout.ready) {
      if (this.bufferingFrame) {
        // Both renderers reuse Frame, but an alternate output can borrow this same
        // immutable drawing too. No old tick backlog or per-frame array copy.
        if (frame !== this.bufferingFrame) Object.assign(frame, this.bufferingFrame);
        return true;
      }
      // First attachment and another match still wait with no stale overlays.
      frame.board = null;
      frame.ants = null;
      frame.count = 0;
      frame.corpses.length = frame.fights.length = frame.marks.length = frame.hits.length = 0;
      frame.engagements = [];
      frame.story = [];
      frame.chat = [];
      frame.commands = [];
      return false;
    }
    this.bufferingFrame = null;
    const first = held[0]!.tick * TICK_MS;
    const rt = Math.min(Math.max(target, first), this.newestTick * TICK_MS);
    frame.renderMs = rt;
    frame.targetMs = target;

    // Latest message at or before rt, and the next one after it.
    let ai = held.length - 1;
    while (ai > 0 && held[ai]!.tick * TICK_MS > rt) ai--;
    const A = held[ai]!;
    const B = held[ai + 1] ?? A;
    const span = (B.tick - A.tick) * TICK_MS;
    const u = span > 0 ? (rt - A.tick * TICK_MS) / span : 0;

    const a = A.ants;
    const b = B.ants;
    const n = a.count;
    frame.ensure(n);
    frame.tick = A.tick;
    frame.count = n;
    frame.mapW = A.board.setup.mapW;
    frame.mapH = A.board.setup.mapH;
    frame.blend = u;
    frame.territoryA = A.board.territory;
    frame.territoryB = B.board.territory;
    frame.trails = A.trails;
    frame.board = A.board;
    frame.ants = a;
    frame.engagements = A.engagements;
    if (!frame.drawRotation || frame.drawRotation.length < n) frame.drawRotation = new Float64Array(frame.id.length);
    const walkPhase = Math.floor(rt / 90);
    for (let i = 0; i < n; i++) {
      const id = a.id[i]!;
      const j = B.index.get(id);
      const ax = a.x[i]! / SUB_TILE;
      const ay = a.y[i]! / SUB_TILE;
      const ah = (a.heading[i]! / 256) * TAU;
      let x = ax;
      let y = ay;
      let h = ah;
      let moving = false;
      if (j !== undefined) {
        const bx = b.x[j]! / SUB_TILE;
        const by = b.y[j]! / SUB_TILE;
        x = ax + (bx - ax) * u;
        y = ay + (by - ay) * u;
        let dh = (b.heading[j]! / 256) * TAU - ah;
        dh = ((((dh + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
        h = ah + dh * u;
        moving = bx !== ax || by !== ay;
      }
      frame.id[i] = id;
      frame.x[i] = x;
      frame.y[i] = y;
      frame.rotation[i] = h;
      // Seed only; Pivots supplies every live ant's final capped facing below.
      frame.drawRotation[i] = h;
      frame.colony[i] = a.colony[i]!;
      frame.agent[i] = a.agent[i]!;
      frame.caste[i] = a.caste?.[i] ?? 0;
      frame.carrying[i] = a.carrying?.[i] ?? 0;
      const born = this.births.get(id);
      frame.alpha[i] = born === undefined ? 1 : Math.min(1, Math.max(0, (rt - born * TICK_MS) / SPAWN_FADE_MS));
      frame.walk[i] = moving ? (walkPhase + id) % 3 : 0;
    }

    if (target >= first) this.pivots.sample(held, ai, rt, frame);
    else { frame.drawX = null; frame.drawY = null; }

    // Events on the delayed clock.
    frame.corpses.length = 0;
    for (const d of this.deaths) {
      const age = rt - d.tick * TICK_MS;
      if (age >= 0 && age < CORPSE_FADE_MS) {
        frame.corpses.push({ antId: d.antId, x: d.x / SUB_TILE, y: d.y / SUB_TILE, colony: d.colony, heading: this.lastHeading.get(d.antId) ?? 0, ageMs: age });
      }
    }
    frame.fights.length = 0;
    for (const f of this.fights) {
      const age = rt - f.tick * TICK_MS;
      if (age >= 0 && age < FIGHT_EFFECT_MS) frame.fights.push({ a: f.a, b: f.b, tick: f.tick, x: f.x / SUB_TILE, y: f.y / SUB_TILE, ageMs: age });
    }
    frame.marks.length = 0;
    for (const m of A.board.marks) {
      const age = rt - (this.markShown.get(m.id) ?? m.laidTick + 1) * TICK_MS;
      if (age >= 0 && age < MARK_LIFE_MS) frame.marks.push({ mark: m, ageMs: age });
    }
    frame.hits.length = 0;
    for (const h of this.hits) {
      const age = rt - h.tick * TICK_MS;
      if (age >= 0 && age < HIT_FLASH_MS) frame.hits.push({ colony: h.colony, queenId: h.queenId, x: h.x, y: h.y, ageMs: age });
    }
    frame.lossShown = this.lossShown;
    frame.endShown = this.endShown;
    frame.match = this.matches;
    frame.story = this.story.entries.filter((e) => e.tick <= A.tick);
    frame.chat = this.story.chat.filter((l) => l.tick <= A.tick);
    frame.commands = reached(this.story.commands, A.tick, frame.commands);

    // Drop history nothing can reach any more (playback never moves backward far).
    if (ai > 4) this.held.splice(0, ai - 4);
    if (this.deaths.length > 4096) this.deaths = this.deaths.filter((d) => rt - d.tick * TICK_MS < CORPSE_FADE_MS);
    if (this.fights.length > 4096) this.fights = this.fights.filter((f) => rt - f.tick * TICK_MS < FIGHT_EFFECT_MS);
    if (this.hits.length > 1024) this.hits = this.hits.filter((h) => rt - h.tick * TICK_MS < HIT_FLASH_MS);
    if (this.playout) this.drawnFrame = frame;
    return true;
  }
}
