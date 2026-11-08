/**
 * Live stream message format, version 4 (extends the snapshot
 * format; protocol).
 *
 * Every message carries every ant (stable id, sub-tile position, heading,
 * colony, and the agent whose squad holds it, if any) plus the events since the
 * previous message. Territory and marks travel as change events; a full
 * message, which every connection receives first, also carries the whole
 * board: territory, marks with their answered counts, every agent with its
 * model label, call ticks, order and intent line, overrun progress, the death
 * count so far, and the result once playback has reached the final tick.
 * Version 4 adds the economy: each ant's carrying flag, the food on
 * every tile, the hatch rule, and each colony's food store and next hatch tick,
 * in the full message and as change events.
 *
 * A message's tick is the number of match ticks completed; its events happened
 * during the step that completed it (tick - 1 in the sim's numbering). This
 * A full message names its match, so a client that reconnects to
 * /live/current can tell a new match from the one it was showing; EventSource
 * cannot read the hub's x-antwar-match header. The name is the match's
 * identity, unique across server restarts, not its /live/:match
 * number, which each server process counts from 1. Recordings name none. This
 * module is the binary payload only; the hub deflates it (raw deflate) and
 * base64-encodes it into one SSE data line.
 *
 * Payload layout (little-endian; v = unsigned LEB128 varint; s = v byte length + UTF-8):
 *   header   u16 magic 'AW' | u8 version 4 | u8 flags (bit 0: full, bit 1: public setup redaction) | v tick
 *   ants     v count | v idDelta[n] (ids ascending) | u16 x[n] | u16 y[n] | u8 heading[n]
 *            | u8 bits[n] (bit 0 colony, bit 1 in a squad, bit 2 soldier: caste switch on only, bit 3 carrying food)
 *            | u8 agent[k] for the k ants in a squad
 *   full     v match+1 (0: none) | setup | u8 territory[mapW*mapH] | marks | agents | v overrun[2] | v required
 *            | v deaths[2] | result? | v foodTiles | (v tileDelta, v amount)[foodTiles] (tiles ascending)
 *            | v hatchCost | v hatchIntervalTicks | v colonyCap | (v food, v nextHatchTick, v nextCost)[2]
 *            (present only when flags bit 0)
 *   events   v count | per event: u8 code | fields (see writeEvent)
 *   version 6: each queen record ends with v hp+1 (0: none), and a full
 *            snapshot ends with u8 rules+1 (0: none) | v seed | v players (0: none)
 *   version 7: extends version 6; every mark ends with u8 presence bits
 *            (verb: 1, count: 2, claimed: 4, revision: 8), then the present
 *            fields in that order (u8 verb index, other fields unsigned varints).
 *            Used only when a full snapshot or mark event carries count metadata.
 *   version 8: extends version 7; each full-snapshot agent ends with v commandTick
 *            (0 absent, 1 no accepted command, otherwise tick+2); after the setup's
 *            version-6 fields comes v commandIdleTicks. Deltas keep existing call
 *            events; accepted commands update the clock, other calls do not.
 *   version 9: adds the sustained-territory terminal reason. The final setup
 *            clock extension has u8 presence, then v commandIdleTicks if present,
 *            keeping an absent clock distinct from a configured zero.
 *   version 10: extends version 9 with full-snapshot terrain map id/name and water geometry.
 *   version 11: extends version 9 with u8 terrain-present, then version-10 terrain if present;
 *            a full snapshot ends with u8 leader+1 (0: none), then v qualifying-start-tick |
 *            v conditional-win-tick when present. territoryWin events use the lead payload;
 *            leader 0 clears the state. Landed version-10 terrain bytes remain unchanged.
 *   version 12: extends version 11 terrain with v rock-count | (v x,y,width,height,appearance)[rock-count]
 *            after water rectangles. Used only when rock geometry is present, including an empty list.
 *   version 17: extends landed version 16 (finalized starting boxes and queen identities). Each full agent and join event adds identity presence, then
 *            display name and f64 Elo when present. Each result adds rating-change presence,
 *            then count and (u8 agent, f64 before, f64 after) entries. Full snapshots finish with
 *            rated classification (0 absent, 1 unrated, 2 rated), after the starting-layout payload.
 *   version 18: extends exact landed version 17 with explicit grid scale (0 absent, 1, 2 or 4),
 *            after rated classification. All older field positions stay unchanged.
 *   version 20: extends version 19 (abandonment); full snapshots append u8 house-idle presence,
 *            then f64 house-idle ticks and v (last accepted house-call tick + 1) per agent (0 absent).
 *            Each call event appends v (authoritative house activity tick + 1), 0 absent.
 *            Only explicit house metadata selects 20; other messages retain their version and bytes.
 *   version 23: extends version 22 with result reason and decidedBy "idle", and house-idle
 *            presence 2: the accepted-call idle clock of a match outside the Antwars Model Index.
 *            Presence 1 stays the Model Index clock, so house-only messages keep their version and bytes.
 *            Only an idle result or a clock outside the Model Index selects 23.
 */
import { SNAPSHOT_MAGIC, SUB_TILE, type Colony } from "./snapshot.js";
import { gridScaleOf, type GridScale } from "../sim/gridScale.js";
import { MAX_BOARD_SIDE_TILES } from "../sim/mapBoard.js";

export { SUB_TILE };
export const STREAM_VERSION = 4;
/** Multi-queen extension; legacy one-queen recordings retain version 4 bytes. */
export const QUEEN_STREAM_VERSION = 5;
/**
 * Private comparison extension: setup carries the rules, seed and player
 * count; queens carry HP; the queenHp event. Used only for a message that carries
 * any of these, so unset-rules recordings keep their version 4 and 5 bytes.
 */
export const VARIANT_STREAM_VERSION = 6;
/** Count-mark extension; messages without count metadata retain versions 4–6. */
export const COUNT_MARK_STREAM_VERSION = 7;
/** Accepted-command idle timing; version-8 recordings retain their bytes. */
export const COMMAND_IDLE_STREAM_VERSION = 8;
/** Sustained-territory result extension, composed with command-idle fields. */
export const EARLY_WIN_STREAM_VERSION = 9;
/** Public map identity and static water geometry in full snapshots. */
export const TERRAIN_STREAM_VERSION = 10;
/** Live qualifying-lead state, composed with optional terrain; landed terrain remains version 10. */
export const TERRITORY_WIN_STREAM_VERSION = 11;
/** Static rock footprints, composed with terrain and optional qualifying-lead state. */
export const ROCK_STREAM_VERSION = 12;
/** Optional count-mark caste; preserves absence of terrain rock geometry. */
export const CASTE_STREAM_VERSION = 13;
/** Finalized lobby boxes and stable starting identities. Landed version-16 bytes remain unchanged. */
export const START_LAYOUT_STREAM_VERSION = 16;
/** Spectator identity/rating extension, composed with the landed version-16 fields. */
export const SPECTATOR_STREAM_VERSION = 17;
/** Explicit physical scale; historical large maps remain scale-one recordings. */
export const GRID_SCALE_STREAM_VERSION = 18;
/** Only messages carrying an abandoned result select this additive version. */
export const ABANDONED_STREAM_VERSION = 19;
/** House-only accepted-call clock; absent metadata retains every prior encoding. */
export const HOUSE_IDLE_STREAM_VERSION = 20;
/** Per-seat self-reported thinking level; selected only when metadata is present. */
export const THINKING_LEVEL_STREAM_VERSION = 21;
// Version 21 extends v20: join events and snapshot agents append a UTF-8 string
// after identity metadata; empty means not given. No change to earlier bytes.
/** Rules-26 LINE marks: count-mark flag 32 appends toTileX, toTileY; selected only when a mark carries them. */
export const LINE_MARK_STREAM_VERSION = 22;
/** One idle rule for every match: the idle result and an idle clock outside the Model Index. */
export const IDLE_STREAM_VERSION = 23;
/** Per-seat self-reported service tier; selected only when metadata is present. */
export const SERVICE_TIER_STREAM_VERSION = 24;
// Version 24 extends v23: join events and snapshot agents append a UTF-8 string
// after the thinking level; empty means not given. No change to earlier bytes.
export const STREAM_COUNT_CASTES = ["any", "worker", "soldier"] as const;
/** Append-only count-mark wire indexes; the first four preserve the legacy vocabulary. */
export const STREAM_COUNT_VERBS = ["DEFEND", "FORAGE", "ATTACK", "GATHER", "PATROL", "LINE"] as const;
/** ANTWAR_RULES values on the wire (index + 1; 0 none). Mirrors RULES_NAMES in src/sim/config.ts. */
export const STREAM_RULES = ["v4", "count-marks", "redesign"] as const;

export const ORDER_KINDS = ["go_to", "forage", "hold", "attack", "follow_trail"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const CALL_KINDS = ["join", "rejoin", "observe", "order", "mark", "found_queen", "count_mark", "set_brood"] as const;
export type CallKind = (typeof CALL_KINDS)[number];
export const WIN_REASONS = ["overrun", "time_up", "double_overrun", "queens_killed", "sustained_territory", "abandoned", "idle"] as const;
export const DECIDED_BY = ["overrun", "territory", "ants_alive", "food_delivered", "draw", "queens_killed", "kills", "idle"] as const;

/** Every ant of one message, ids ascending. agent is the index of the agent whose squad holds the ant, or -1. */
export interface StreamAnts {
  count: number;
  id: Uint32Array;
  /** Sub-tile units, SUB_TILE per tile. */
  x: Uint16Array;
  y: Uint16Array;
  /** Facing, 0..255 mapped to 0..2π. */
  heading: Uint8Array;
  colony: Uint8Array;
  agent: Int16Array;
  /**
   * 1 for a soldier, 0 for a worker (bit 2 of the ant bits). Absent when no ant in
   * the message is a soldier: always with the caste switch off, so those bytes are unchanged.
   */
  caste?: Uint8Array;
  /** 1 while the ant carries food home (bits byte, bit 3). Optional for senders; decode always sets it. */
  carrying?: Uint8Array;
}

/** Public display projection only: account ids, seat keys and invite tokens never enter the stream. */
export interface StreamIdentity {
  readonly displayName: string;
  /** Absent for a seat with no rating to show (a house challenge seat its Index has not rated yet). */
  readonly elo?: number;
}
export interface StreamRatingChange {
  readonly agent: number;
  readonly before: number;
  readonly after: number;
}

/** An agent, addressed by its index: its position in join order, which is also its squad's id. */
export interface StreamAgent {
  identity?: StreamIdentity;
  colony: Colony;
  /** Self-reported model label, "" when none was given. */
  modelLabel: string;
  /** Absent in older streams and when the seat gave no level. */
  thinkingLevel?: string;
  /** Absent in older streams and when the seat gave no tier. */
  serviceTier?: string;
  joinTick: number;
  /** Sim tick of the agent's latest call, and of the one before it (-1 when there is none). */
  lastCallTick: number;
  prevCallTick: number;
  /** Present with command-idle rules; -1 until the first accepted command. */
  lastCommandTick?: number;
  /** Authoritative accepted game-call tick, only with houseIdleTicks. */
  lastHouseCallTick?: number;
  order: OrderKind;
  orderX: number;
  orderY: number;
  /** The intent line of the current order, "" when it has none. */
  intent: string;
}

export interface StreamMark {
  id: number;
  agent: number;
  colony: Colony;
  tileX: number;
  tileY: number;
  /** Indexes into the sim's sixteen-word vocabulary (WORDS in src/sim/types.ts). */
  words: number[];
  laidTick: number;
  /** Squad ants following the mark under follow_trail now. */
  answered: number;
  /** Count-mark metadata (version 7); absent on legacy word marks. */
  verb?: (typeof STREAM_COUNT_VERBS)[number];
  count?: number;
  /** Living ants whose Ant.claim names this mark; distinct from answered. */
  claimed?: number;
  /** In-place re-lays, including zero for a newly laid count mark. */
  revision?: number;
  caste?: (typeof STREAM_COUNT_CASTES)[number];
  /** A LINE mark's second endpoint (version 22); absent on every other mark. */
  toTileX?: number;
  toTileY?: number;
}

export interface StreamResult {
  /** Present only with the delayed final result of a rated match. */
  ratingChanges?: readonly StreamRatingChange[];
  winner: Colony | null;
  reason: (typeof WIN_REASONS)[number];
  decidedBy: (typeof DECIDED_BY)[number];
  /** Sim tick of the final step. */
  tick: number;
  /** When the next match starts (ms since the epoch), when the server has said. */
  nextStartMs: number | null;
}

export interface StreamStartBox { x: number; y: number; width: number; height: number }

export interface StreamSetup {
  /** Fine tiles per original tile edge: 2 on every decoded setup. */
  gridScale?: GridScale;
  /** Finalized lobby start boxes, in half-open integer tile coordinates. */
  startBoxes?: [StreamStartBox, StreamStartBox];
  /** Immutable per-colony starting identities, retained in reconnect snapshots. */
  startingQueenIds?: [number[], number[]];
  /** Absent in historical recordings; false explicitly identifies an unrated lobby match. */
  rated?: boolean;
  terrain?: { mapId: string; mapName: string; water: readonly (readonly [number, number, number, number])[];
    rocks?: readonly (readonly [number, number, number, number, number])[] };
  mapW: number;
  mapH: number;
  ticksPerSecond: number;
  matchTicks: number;
  /** Idle timeout: call-based historically, accepted-command-based when commandIdleTicks is present. */
  idleTicks: number;
  commandIdleTicks?: number;
  /** Live server accepted-call idle limit; Model Index only before version 23, every live match after; absent historically. */
  houseIdleTicks?: number;
  /** With houseIdleTicks: the match is in the Antwars Model Index (house-*). Decoded from presence 1. */
  modelIndex?: true;
  overrunRadiusTiles: number;
  /** Queen positions in sub-tile units, per colony. */
  queens: [[number, number], [number, number]];
  /** Comparison runs only (version 6): the ANTWAR_RULES value, the match seed and the expected players. */
  rules?: (typeof STREAM_RULES)[number];
  seed?: number;
  players?: number;
}

/** The sim's hatch rule: one ant per cost food, at most one per intervalTicks, never above cap living ants. */
export interface StreamHatch {
  cost: number;
  intervalTicks: number;
  cap: number;
}

/** A colony's delivered food not yet spent on hatching, and the first sim tick its queen may hatch again. */
export interface StreamStore {
  food: number;
  nextHatchTick: number;
  /**
   * The food the colony's next hatch needs: hatchCost, or with the rules switch on the
   * cost of the caste the sim hatches next (soldierCost for a soldier).
   */
  nextCost: number;
}

export interface StreamQueen {
  id: number;
  colony: Colony;
  x: number;
  y: number;
  foundedTick: number;
  lostTick: number | null;
  overrun: number;
  /** Milli-HP (redesign, version 6 only). */
  hp?: number;
}

/** Queen records for legacy recordings are derived, never invented on the wire. */
export function streamQueens(full: { queens?: readonly StreamQueen[]; setup: StreamSetup; overrun?: readonly [number, number] }): readonly StreamQueen[] {
  return full.queens ?? ([0, 1] as const).map((colony) => ({ id: 0, colony, x: full.setup.queens[colony][0], y: full.setup.queens[colony][1],
    foundedTick: 0, lostTick: null, overrun: full.overrun?.[colony] ?? 0 }));
}

/** The server evaluator's conditional territory win. Ticks use simulation-step numbering, like StreamResult.tick. */
export interface StreamTerritoryWin {
  readonly colony: Colony;
  readonly startTick: number;
  readonly winTick: number;
}

export interface StreamFull {
  /** Authoritative nest list in multi-queen streams; absent in version 4 recordings. */
  queens?: StreamQueen[];
  /** Cumulative hatch totals per colony, from sim stats. Present in version 5, absent in version 4. */
  hatched?: [number, number];
  /** The match's identity, unique across server restarts (not its /live/:match number); absent when the sender did not say (recordings). */
  match?: number;
  setup: StreamSetup;
  /** Absent without a qualifying sustained lead (and in historical streams). */
  territoryWin?: StreamTerritoryWin;
  /** Tile owners, row-major: 0 neutral, 1 colony 0, 2 colony 1. */
  territory: Uint8Array;
  marks: StreamMark[];
  agents: StreamAgent[];
  /** Consecutive ticks of enemy majority at each colony's queen. */
  overrun: [number, number];
  overrunRequired: number;
  /** Ants of each colony that have died so far. */
  deaths: [number, number];
  /** Present only once playback has reached the final tick. */
  result: StreamResult | null;
  /** Food on each tile, row-major. Optional for senders; decode always sets it. */
  food?: Uint32Array;
  /** Optional for senders; decode always sets it. */
  hatch?: StreamHatch;
  /** Per colony. Optional for senders; decode always sets it. */
  stores?: [StreamStore, StreamStore];
}

export type StreamEvent =
  | { kind: "territoryWin"; progress: StreamTerritoryWin | null }
  | { kind: "birth"; antId: number }
  | { kind: "death"; antId: number; colony: Colony; x: number; y: number }
  | { kind: "fight"; antId: number; targetId: number; colony: Colony; tileX: number; tileY: number }
  | { kind: "mark"; mark: StreamMark }
  | { kind: "markGone"; markId: number }
  | { kind: "answered"; markId: number; count: number }
  | { kind: "territory"; tiles: number[]; owners: number[] }
  | { kind: "overrun"; colony: Colony; progress: number; required: number }
  | { kind: "join"; agent: number; colony: Colony; modelLabel: string; thinkingLevel?: string; serviceTier?: string; identity?: StreamIdentity }
  | { kind: "call"; agent: number; call: CallKind; accepted: boolean; houseActivityTick?: number }
  | { kind: "order"; agent: number; order: OrderKind; tileX: number; tileY: number; intent: string }
  | { kind: "end"; result: StreamResult }
  /** Tiles whose food changed this step, ascending, with their new amounts. */
  | { kind: "food"; tiles: number[]; amounts: number[] }
  /** A colony's store, next hatch tick or next hatch cost changed this step. */
  | { kind: "store"; colony: Colony; food: number; nextHatchTick: number; nextCost: number }
  | { kind: "queenFounded" | "queenLost"; queen: StreamQueen }
  | { kind: "queenOverrun"; colony: Colony; queenId: number; progress: number; required: number }
  /** Redesign (version 6): a queen's HP changed. */
  | { kind: "queenHp"; colony: Colony; queenId: number; hp: number };

export interface StreamMessage {
  tick: number;
  ants: StreamAnts;
  full: StreamFull | null;
  events: StreamEvent[];
}

/** Message tick is the completed state: the last processed simulation tick is tick - 1. */
export function isIdle(agent: StreamAgent, tick: number, idleTicks: number, houseIdleTicks?: number): boolean {
  if (houseIdleTicks !== undefined) return tick - 1 - (agent.lastHouseCallTick ?? agent.joinTick) >= houseIdleTicks;
  const since = agent.lastCommandTick === undefined ? agent.lastCallTick
    : agent.lastCommandTick < 0 ? agent.joinTick : agent.lastCommandTick;
  return tick - 1 - since >= idleTicks;
}

const EVENT_CODES = {
  birth: 1,
  death: 2,
  fight: 3,
  mark: 4,
  markGone: 5,
  answered: 6,
  territory: 7,
  overrun: 8,
  join: 9,
  call: 10,
  order: 11,
  end: 12,
  food: 13,
  store: 14,
  queenFounded: 15,
  queenLost: 16,
  queenOverrun: 17,
  queenHp: 18,
  territoryWin: 19,
} as const satisfies Record<StreamEvent["kind"], number>;

const NO_STORE: StreamStore = { food: 0, nextHatchTick: 0, nextCost: 0 };

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

/** Exported for tests only: the stream and recording byte writer. */
export class Writer {
  buf = new Uint8Array(1 << 16);
  dv = new DataView(this.buf.buffer);
  o = 0;
  private room(n: number) {
    if (this.o + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.o + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.o));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.o++] = v;
  }
  u16(v: number) {
    this.room(2);
    this.dv.setUint16(this.o, v, true);
    this.o += 2;
  }
  f64(v: number) {
    this.room(8);
    this.dv.setFloat64(this.o, v, true);
    this.o += 8;
  }
  /**
   * An unsigned LEB128 varint. Only safe integers: beyond 2^53 a number is no longer exact, so Reader.v could
   * not read it back. Room is made for the encoded length itself (up to 8 bytes for 2^53 - 1).
   */
  v(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`varint out of range: ${n}`);
    let length = 1;
    for (let rest = n; rest >= 0x80; rest = Math.floor(rest / 0x80)) length += 1;
    this.room(length);
    while (n >= 0x80) {
      this.buf[this.o++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.o++] = n;
  }
  str(s: string) {
    const b = utf8.encode(s);
    this.v(b.length);
    this.room(b.length);
    this.buf.set(b, this.o);
    this.o += b.length;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.o);
    this.o += b.length;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.o);
  }
}

/** Exported for tests only: the stream and recording byte reader. */
export class Reader {
  o = 0;
  readonly b: Uint8Array;
  readonly dv: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8() {
    if (this.o >= this.b.length) throw new Error("truncated stream message");
    return this.b[this.o++]!;
  }
  u16() {
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }
  v() {
    let n = 0;
    let scale = 1;
    for (;;) {
      const byte = this.u8();
      n += (byte & 0x7f) * scale;
      if (byte < 0x80) return n;
      scale *= 0x80;
    }
  }
  str() {
    const len = this.v();
    const s = utf8d.decode(this.b.subarray(this.o, this.o + len));
    this.o += len;
    return s;
  }
  bytes(n: number) {
    const out = this.b.slice(this.o, this.o + n);
    if (out.length !== n) throw new Error("truncated stream message");
    this.o += n;
    return out;
  }
}

function hasCountMetadata(m: StreamMark): boolean {
  return m.verb !== undefined || m.count !== undefined || m.claimed !== undefined || m.revision !== undefined || m.caste !== undefined;
}

function hasLineEnd(m: StreamMark): boolean {
  return m.toTileX !== undefined || m.toTileY !== undefined;
}

function writeMark(w: Writer, m: StreamMark, version: number) {
  w.v(m.id);
  w.u8(m.agent);
  w.u8(m.colony);
  w.u8(m.tileX);
  w.u8(m.tileY);
  w.u8(m.words.length);
  for (const word of m.words) w.u8(word);
  w.v(m.laidTick);
  w.v(m.answered);
  if (version >= COUNT_MARK_STREAM_VERSION) {
    const flags = (m.verb === undefined ? 0 : 1) | (m.count === undefined ? 0 : 2) |
      (m.claimed === undefined ? 0 : 4) | (m.revision === undefined ? 0 : 8) | (m.caste === undefined ? 0 : 16) |
      (version >= LINE_MARK_STREAM_VERSION && hasLineEnd(m) ? 32 : 0);
    w.u8(flags);
    if (m.verb !== undefined) {
      const verb = STREAM_COUNT_VERBS.indexOf(m.verb);
      if (verb < 0) throw new Error(`unknown count-mark verb ${m.verb}`);
      w.u8(verb);
    }
    if (m.count !== undefined) w.v(m.count);
    if (m.claimed !== undefined) w.v(m.claimed);
    if (m.revision !== undefined) w.v(m.revision);
    if (m.caste !== undefined) {
      const caste = STREAM_COUNT_CASTES.indexOf(m.caste);
      if (caste < 0) throw new Error(`unknown count-mark caste ${m.caste}`);
      w.u8(caste);
    }
    if (flags & 32) {
      w.u8(m.toTileX!);
      w.u8(m.toTileY!);
    }
  }
}

function readMark(r: Reader, version: number): StreamMark {
  const id = r.v();
  const agent = r.u8();
  const colony = r.u8() as Colony;
  const tileX = r.u8();
  const tileY = r.u8();
  const n = r.u8();
  const words: number[] = [];
  for (let i = 0; i < n; i++) words.push(r.u8());
  const mark: StreamMark = { id, agent, colony, tileX, tileY, words, laidTick: r.v(), answered: r.v() };
  if (version >= COUNT_MARK_STREAM_VERSION) {
    const flags = r.u8();
    if (flags & ~(version >= LINE_MARK_STREAM_VERSION ? 63 : version >= CASTE_STREAM_VERSION ? 31 : 15)) throw new Error(`unknown count-mark flags ${flags}`);
    if (flags & 1) {
      const verb = STREAM_COUNT_VERBS[r.u8()];
      if (verb === undefined) throw new Error("unknown count-mark verb");
      mark.verb = verb;
    }
    if (flags & 2) mark.count = r.v();
    if (flags & 4) mark.claimed = r.v();
    if (flags & 8) mark.revision = r.v();
    if (flags & 16) {
      const caste = STREAM_COUNT_CASTES[r.u8()];
      if (caste === undefined) throw new Error("unknown count-mark caste");
      mark.caste = caste;
    }
    if (flags & 32) {
      mark.toTileX = r.u8();
      mark.toTileY = r.u8();
    }
  }
  return mark;
}

function rating(value: number): number {
  if (!Number.isFinite(value)) throw new Error("invalid spectator rating");
  return value;
}

/** Identity presence: 0 none, 1 name and rating (unchanged since it was introduced), 2 name with no rating. */
function writeIdentity(w: Writer, identity: StreamIdentity | undefined): void {
  const rated = identity?.elo !== undefined;
  w.u8(identity === undefined ? 0 : rated ? 1 : 2);
  if (identity === undefined) return;
  if (!identity.displayName || utf8.encode(identity.displayName).length > 256) throw new Error("invalid spectator display name");
  w.str(identity.displayName);
  if (rated) w.f64(rating(identity.elo!));
}
function readIdentity(r: Reader): StreamIdentity | undefined {
  const present = r.u8();
  if (present === 0) return undefined;
  if (present !== 1 && present !== 2) throw new Error("invalid spectator identity presence");
  const displayName = r.str();
  if (!displayName || utf8.encode(displayName).length > 256) throw new Error("invalid spectator display name");
  return present === 1 ? { displayName, elo: rating(r.f64()) } : { displayName };
}

function writeResult(w: Writer, res: StreamResult, version: number) {
  w.u8(res.winner ?? 255);
  w.u8(WIN_REASONS.indexOf(res.reason));
  w.u8(DECIDED_BY.indexOf(res.decidedBy));
  w.v(res.tick);
  w.u8(res.nextStartMs === null ? 0 : 1);
  if (res.nextStartMs !== null) w.f64(res.nextStartMs);
  if (version >= SPECTATOR_STREAM_VERSION) {
    w.u8(res.ratingChanges === undefined ? 0 : 1);
    if (res.ratingChanges !== undefined) {
      if (res.ratingChanges.length > 255) throw new Error("too many spectator rating changes");
      const seen = new Set<number>();
      w.v(res.ratingChanges.length);
      for (const change of res.ratingChanges) {
        if (!Number.isInteger(change.agent) || change.agent < 0 || change.agent > 254 || seen.has(change.agent)) throw new Error("invalid rating agent");
        seen.add(change.agent);
        w.u8(change.agent); w.f64(rating(change.before)); w.f64(rating(change.after));
      }
    }
  }
}

function readResult(r: Reader, version: number): StreamResult {
  const winner = r.u8();
  const reason = WIN_REASONS[r.u8()];
  const decidedBy = DECIDED_BY[r.u8()];
  if (reason === undefined || decidedBy === undefined || (reason === "abandoned" && version < ABANDONED_STREAM_VERSION) ||
    ((reason === "idle" || decidedBy === "idle") && version < IDLE_STREAM_VERSION)) throw new Error("unknown match result");
  const tick = r.v();
  const nextStartMs = r.u8() === 1 ? r.f64() : null;
  let ratingChanges: StreamRatingChange[] | undefined;
  if (version >= SPECTATOR_STREAM_VERSION) {
    const present = r.u8();
    if (present > 1) throw new Error("invalid rating changes presence");
    if (present) {
      const count = r.v();
      if (count > 255) throw new Error("too many spectator rating changes");
      const seen = new Set<number>();
      ratingChanges = Array.from({ length: count }, () => {
        const agent = r.u8();
        if (agent > 254 || seen.has(agent)) throw new Error("invalid rating agent");
        seen.add(agent);
        return { agent, before: rating(r.f64()), after: rating(r.f64()) };
      });
    }
  }
  return { winner: winner === 255 ? null : (winner as Colony), reason, decidedBy, tick, nextStartMs,
    ...(ratingChanges === undefined ? {} : { ratingChanges }) };
}

function writeTerritoryWin(w: Writer, progress: StreamTerritoryWin | null | undefined): void {
  w.u8(progress == null ? 0 : progress.colony + 1);
  if (progress != null) { w.v(progress.startTick); w.v(progress.winTick); }
}

function readTerritoryWin(r: Reader): StreamTerritoryWin | undefined {
  const present = r.u8();
  if (present === 0) return undefined;
  if (present !== 1 && present !== 2) throw new Error("unknown territory-win colony");
  const startTick = r.v(), winTick = r.v();
  if (winTick < startTick) throw new Error("territory win precedes its qualifying lead");
  return { colony: (present - 1) as Colony, startTick, winTick };
}

function writeEvent(w: Writer, e: StreamEvent, version: number) {
  w.u8(EVENT_CODES[e.kind]);
  switch (e.kind) {
    case "territoryWin":
      writeTerritoryWin(w, e.progress);
      return;
    case "queenFounded":
    case "queenLost":
      writeQueen(w, e.queen, version);
      return;
    case "queenHp":
      w.u8(e.colony); w.v(e.queenId); w.v(e.hp);
      return;
    case "queenOverrun":
      w.u8(e.colony); w.v(e.queenId); w.v(e.progress); w.v(e.required);
      return;
    case "birth":
      w.v(e.antId);
      return;
    case "death":
      w.v(e.antId);
      w.u8(e.colony);
      w.u16(e.x);
      w.u16(e.y);
      return;
    case "fight":
      w.v(e.antId);
      w.v(e.targetId);
      w.u8(e.colony);
      w.u8(e.tileX);
      w.u8(e.tileY);
      return;
    case "mark":
      writeMark(w, e.mark, version);
      return;
    case "markGone":
      w.v(e.markId);
      return;
    case "answered":
      w.v(e.markId);
      w.v(e.count);
      return;
    case "territory": {
      w.v(e.tiles.length);
      let last = 0;
      for (let i = 0; i < e.tiles.length; i++) {
        w.v(e.tiles[i]! - last);
        last = e.tiles[i]!;
        w.u8(e.owners[i]!);
      }
      return;
    }
    case "overrun":
      w.u8(e.colony);
      w.v(e.progress);
      w.v(e.required);
      return;
    case "join":
      w.u8(e.agent);
      w.u8(e.colony);
      w.str(e.modelLabel);
      if (version >= SPECTATOR_STREAM_VERSION) writeIdentity(w, e.identity);
      if (version >= THINKING_LEVEL_STREAM_VERSION) w.str(e.thinkingLevel ?? "");
      if (version >= SERVICE_TIER_STREAM_VERSION) w.str(e.serviceTier ?? "");
      return;
    case "call":
      w.u8(e.agent);
      w.u8(CALL_KINDS.indexOf(e.call));
      w.u8(e.accepted ? 1 : 0);
      if (version >= HOUSE_IDLE_STREAM_VERSION) w.v(e.houseActivityTick === undefined ? 0 : e.houseActivityTick + 1);
      return;
    case "order":
      w.u8(e.agent);
      w.u8(ORDER_KINDS.indexOf(e.order));
      w.u8(e.tileX);
      w.u8(e.tileY);
      w.str(e.intent);
      return;
    case "end":
      writeResult(w, e.result, version);
      return;
    case "food": {
      w.v(e.tiles.length);
      let last = 0;
      for (let i = 0; i < e.tiles.length; i++) {
        w.v(e.tiles[i]! - last);
        last = e.tiles[i]!;
        w.v(e.amounts[i]!);
      }
      return;
    }
    case "store":
      w.u8(e.colony);
      w.v(e.food);
      w.v(e.nextHatchTick);
      w.v(e.nextCost);
      return;
  }
}

function readEvent(r: Reader, version: number): StreamEvent {
  const code = r.u8();
  switch (code) {
    case EVENT_CODES.territoryWin:
      if (version < TERRITORY_WIN_STREAM_VERSION) throw new Error("territory-win event needs version 11");
      return { kind: "territoryWin", progress: readTerritoryWin(r) ?? null };
    case EVENT_CODES.queenFounded:
      return { kind: "queenFounded", queen: readQueen(r, version) };
    case EVENT_CODES.queenLost:
      return { kind: "queenLost", queen: readQueen(r, version) };
    case EVENT_CODES.queenHp:
      return { kind: "queenHp", colony: r.u8() as Colony, queenId: r.v(), hp: r.v() };
    case EVENT_CODES.queenOverrun:
      return { kind: "queenOverrun", colony: r.u8() as Colony, queenId: r.v(), progress: r.v(), required: r.v() };
    case EVENT_CODES.birth:
      return { kind: "birth", antId: r.v() };
    case EVENT_CODES.death:
      return { kind: "death", antId: r.v(), colony: r.u8() as Colony, x: r.u16(), y: r.u16() };
    case EVENT_CODES.fight:
      return { kind: "fight", antId: r.v(), targetId: r.v(), colony: r.u8() as Colony, tileX: r.u8(), tileY: r.u8() };
    case EVENT_CODES.mark:
      return { kind: "mark", mark: readMark(r, version) };
    case EVENT_CODES.markGone:
      return { kind: "markGone", markId: r.v() };
    case EVENT_CODES.answered:
      return { kind: "answered", markId: r.v(), count: r.v() };
    case EVENT_CODES.territory: {
      const n = r.v();
      const tiles: number[] = [];
      const owners: number[] = [];
      let last = 0;
      for (let i = 0; i < n; i++) {
        last += r.v();
        tiles.push(last);
        owners.push(r.u8());
      }
      return { kind: "territory", tiles, owners };
    }
    case EVENT_CODES.overrun:
      return { kind: "overrun", colony: r.u8() as Colony, progress: r.v(), required: r.v() };
    case EVENT_CODES.join: {
      const agent = r.u8(), colony = r.u8() as Colony, modelLabel = r.str();
      const identity = version >= SPECTATOR_STREAM_VERSION ? readIdentity(r) : undefined;
      const thinkingLevel = version >= THINKING_LEVEL_STREAM_VERSION ? r.str() : "";
      const serviceTier = version >= SERVICE_TIER_STREAM_VERSION ? r.str() : "";
      return { kind: "join", agent, colony, modelLabel, ...(identity === undefined ? {} : { identity }),
        ...(thinkingLevel === "" ? {} : { thinkingLevel }), ...(serviceTier === "" ? {} : { serviceTier }) };
    }
    case EVENT_CODES.call: {
      const agent = r.u8(), call = CALL_KINDS[r.u8()]!, accepted = r.u8() === 1;
      const activity = version >= HOUSE_IDLE_STREAM_VERSION ? r.v() : 0;
      return { kind: "call", agent, call, accepted, ...(activity === 0 ? {} : { houseActivityTick: activity - 1 }) };
    }
    case EVENT_CODES.order:
      return { kind: "order", agent: r.u8(), order: ORDER_KINDS[r.u8()]!, tileX: r.u8(), tileY: r.u8(), intent: r.str() };
    case EVENT_CODES.end:
      return { kind: "end", result: readResult(r, version) };
    case EVENT_CODES.food: {
      const n = r.v();
      const tiles: number[] = [];
      const amounts: number[] = [];
      let last = 0;
      for (let i = 0; i < n; i++) {
        last += r.v();
        tiles.push(last);
        amounts.push(r.v());
      }
      return { kind: "food", tiles, amounts };
    }
    case EVENT_CODES.store:
      return { kind: "store", colony: r.u8() as Colony, food: r.v(), nextHatchTick: r.v(), nextCost: r.v() };
    default:
      throw new Error(`unknown stream event code ${code}`);
  }
}

export function encodeMessage(m: StreamMessage): Uint8Array {
  const w = new Writer();
  w.u16(SNAPSHOT_MAGIC);
  // Keep historical one-queen recording bytes stable. Every message is self-describing.
  const variant = m.full?.setup.rules !== undefined || m.full?.queens?.some((q) => q.hp !== undefined) === true ||
    m.events.some((e) => e.kind === "queenHp" || ((e.kind === "queenFounded" || e.kind === "queenLost") && e.queen.hp !== undefined));
  const counted = m.full?.marks.some(hasCountMetadata) === true || m.events.some((e) => e.kind === "mark" && hasCountMetadata(e.mark));
  const earlyWin = m.full?.result?.reason === "sustained_territory" || m.events.some((e) => e.kind === "end" && e.result.reason === "sustained_territory");
  const commandIdle = m.full?.setup.commandIdleTicks !== undefined;
  const territoryWin = m.full?.territoryWin !== undefined || m.events.some((e) => e.kind === "territoryWin");
  const caste = m.full?.marks.some(mark => mark.caste !== undefined) === true ||
    m.events.some(event => event.kind === "mark" && event.mark.caste !== undefined);
  const hasStartingLayout = m.full?.setup.startBoxes !== undefined || m.full?.setup.startingQueenIds !== undefined;
  const spectator = m.full?.setup.rated !== undefined || m.full?.agents.some(agent => agent.identity !== undefined) === true ||
    m.full?.result?.ratingChanges !== undefined || m.events.some(event =>
      (event.kind === "join" && event.identity !== undefined) || (event.kind === "end" && event.result.ratingChanges !== undefined));
  const abandoned = m.full?.result?.reason === "abandoned" || m.events.some(e => e.kind === "end" && e.result.reason === "abandoned");
  const houseIdle = m.full?.setup.houseIdleTicks !== undefined || m.events.some(e => e.kind === "call" && e.houseActivityTick !== undefined);
  const thinkingLevel = m.full?.agents.some(agent => agent.thinkingLevel !== undefined) === true ||
    m.events.some(event => event.kind === "join" && event.thinkingLevel !== undefined);
  const lineEnds = m.full?.marks.some(hasLineEnd) === true || m.events.some(e => e.kind === "mark" && hasLineEnd(e.mark));
  const idleEnd = m.full?.result?.reason === "idle" || m.events.some(e => e.kind === "end" && e.result.reason === "idle");
  const outsideIndexClock = m.full?.setup.houseIdleTicks !== undefined && m.full.setup.modelIndex !== true;
  const serviceTier = m.full?.agents.some(agent => agent.serviceTier !== undefined) === true ||
    m.events.some(event => event.kind === "join" && event.serviceTier !== undefined);
  const version = serviceTier ? SERVICE_TIER_STREAM_VERSION : idleEnd || outsideIndexClock ? IDLE_STREAM_VERSION : lineEnds ? LINE_MARK_STREAM_VERSION : thinkingLevel ? THINKING_LEVEL_STREAM_VERSION : houseIdle ? HOUSE_IDLE_STREAM_VERSION : abandoned ? ABANDONED_STREAM_VERSION : m.full?.setup.gridScale !== undefined ? GRID_SCALE_STREAM_VERSION : spectator ? SPECTATOR_STREAM_VERSION : hasStartingLayout ? START_LAYOUT_STREAM_VERSION : caste ? CASTE_STREAM_VERSION : m.full?.setup.terrain?.rocks !== undefined ? ROCK_STREAM_VERSION : territoryWin ? TERRITORY_WIN_STREAM_VERSION : m.full?.setup.terrain !== undefined ? TERRAIN_STREAM_VERSION : earlyWin ? EARLY_WIN_STREAM_VERSION : commandIdle ? COMMAND_IDLE_STREAM_VERSION : counted ? COUNT_MARK_STREAM_VERSION : variant ? VARIANT_STREAM_VERSION : m.full?.queens !== undefined || m.events.some((e) => e.kind === "queenFounded" || e.kind === "queenLost" || e.kind === "queenOverrun" || (e.kind === "call" && e.call === "found_queen")) ? QUEEN_STREAM_VERSION : STREAM_VERSION;
  w.u8(version);
  w.u8(m.full ? 1 : 0);
  w.v(m.tick);

  const a = m.ants;
  const n = a.count;
  w.v(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const id = a.id[i]!;
    if (i > 0 && id <= last) throw new Error("stream ants must be in ascending id order");
    w.v(id - last);
    last = id;
  }
  for (let i = 0; i < n; i++) w.u16(a.x[i]!);
  for (let i = 0; i < n; i++) w.u16(a.y[i]!);
  w.bytes(a.heading.subarray(0, n));
  const carrying = a.carrying;
  for (let i = 0; i < n; i++) w.u8(a.colony[i]! | (a.agent[i]! >= 0 ? 2 : 0) | (a.caste?.[i] === 1 ? 4 : 0) | (carrying?.[i] ? 8 : 0));
  for (let i = 0; i < n; i++) {
    const agent = a.agent[i]!;
    if (agent < 0) continue;
    if (agent > 254) throw new Error("agent index too large for the stream format");
    w.u8(agent);
  }

  if (m.full) {
    const f = m.full;
    const s = f.setup;
    w.v(f.match === undefined ? 0 : f.match + 1);
    if (s.mapW > MAX_BOARD_SIDE_TILES || s.mapH > MAX_BOARD_SIDE_TILES) throw new Error(`stream format supports maps up to ${MAX_BOARD_SIDE_TILES} tiles a side`);
    w.v(s.mapW);
    w.v(s.mapH);
    w.v(s.ticksPerSecond);
    w.v(s.matchTicks);
    w.v(s.idleTicks);
    w.v(s.overrunRadiusTiles);
    for (const [qx, qy] of s.queens) {
      w.u16(qx);
      w.u16(qy);
    }
    if (f.territory.length !== s.mapW * s.mapH) throw new Error("territory size does not match map");
    w.bytes(f.territory);
    w.v(f.marks.length);
    for (const mark of f.marks) writeMark(w, mark, version);
    w.v(f.agents.length);
    for (const ag of f.agents) {
      w.u8(ag.colony);
      w.str(ag.modelLabel);
      w.v(ag.joinTick);
      w.v(ag.lastCallTick);
      w.v(ag.prevCallTick + 1);
      w.u8(ORDER_KINDS.indexOf(ag.order));
      w.u8(ag.orderX);
      w.u8(ag.orderY);
      w.str(ag.intent);
      if (version >= COMMAND_IDLE_STREAM_VERSION) w.v(ag.lastCommandTick === undefined ? 0 : ag.lastCommandTick + 2);
      if (version >= SPECTATOR_STREAM_VERSION) writeIdentity(w, ag.identity);
      if (version >= THINKING_LEVEL_STREAM_VERSION) w.str(ag.thinkingLevel ?? "");
      if (version >= SERVICE_TIER_STREAM_VERSION) w.str(ag.serviceTier ?? "");
    }
    w.v(f.overrun[0]);
    w.v(f.overrun[1]);
    w.v(f.overrunRequired);
    w.v(f.deaths[0]);
    w.v(f.deaths[1]);
    w.u8(f.result ? 1 : 0);
    if (f.result) writeResult(w, f.result, version);
    const food = f.food ?? new Uint32Array(0);
    if (f.food !== undefined && food.length !== s.mapW * s.mapH) throw new Error("food size does not match map");
    let foodTiles = 0;
    for (let i = 0; i < food.length; i++) if (food[i]! > 0) foodTiles++;
    w.v(foodTiles);
    let lastTile = 0;
    for (let i = 0; i < food.length; i++) {
      if (food[i]! === 0) continue;
      w.v(i - lastTile);
      lastTile = i;
      w.v(food[i]!);
    }
    const hatch = f.hatch ?? { cost: 0, intervalTicks: 0, cap: 0 };
    w.v(hatch.cost);
    w.v(hatch.intervalTicks);
    w.v(hatch.cap);
    for (const st of f.stores ?? [NO_STORE, NO_STORE]) {
      w.v(st.food);
      w.v(st.nextHatchTick);
      w.v(st.nextCost);
    }
    if (version >= 5) {
      w.v(m.full.queens?.length ?? 0);
      for (const q of m.full.queens ?? []) writeQueen(w, q, version);
      if (f.hatched === undefined) throw new Error("version-5 full snapshots require cumulative hatched counts");
      w.v(f.hatched[0]); w.v(f.hatched[1]);
    }
    if (version >= 6) {
      w.u8(s.rules === undefined ? 0 : STREAM_RULES.indexOf(s.rules) + 1);
      w.v(s.seed ?? 0);
      w.v(s.players ?? 0);
    }
    if (version >= EARLY_WIN_STREAM_VERSION) {
      w.u8(s.commandIdleTicks === undefined ? 0 : 1);
      if (s.commandIdleTicks !== undefined) w.v(s.commandIdleTicks);
    } else if (version >= COMMAND_IDLE_STREAM_VERSION) w.v(s.commandIdleTicks ?? 0);
    if (version >= TERRITORY_WIN_STREAM_VERSION) w.u8(s.terrain === undefined ? 0 : 1);
    if (version === TERRAIN_STREAM_VERSION || (version >= TERRITORY_WIN_STREAM_VERSION && s.terrain !== undefined)) {
      const terrain = s.terrain!;
      w.str(terrain.mapId); w.str(terrain.mapName);
      w.v(terrain.water.length);
      for (const rect of terrain.water) for (const value of rect) w.v(value);
      if (version >= CASTE_STREAM_VERSION) w.u8(terrain.rocks === undefined ? 0 : 1);
      if (version >= ROCK_STREAM_VERSION && (version < CASTE_STREAM_VERSION || terrain.rocks !== undefined)) {
        w.v(terrain.rocks?.length ?? 0);
        for (const rect of terrain.rocks ?? []) for (const value of rect) w.v(value);
      }
    }
    if (version >= TERRITORY_WIN_STREAM_VERSION) writeTerritoryWin(w, f.territoryWin);
    if (version >= START_LAYOUT_STREAM_VERSION) writeStartingLayout(w, s);
    if (version >= SPECTATOR_STREAM_VERSION) w.u8(s.rated === undefined ? 0 : s.rated ? 2 : 1);
    // Zero reserves absence for later extensions that do not carry scale metadata.
    if (version >= GRID_SCALE_STREAM_VERSION) w.u8(s.gridScale === undefined ? 0 : gridScaleOf(s));
    if (version >= HOUSE_IDLE_STREAM_VERSION) {
      // 1: the Model Index clock (the only clock before version 23); 2: any other match's clock.
      w.u8(s.houseIdleTicks === undefined ? 0 : s.modelIndex === true ? 1 : 2);
      if (s.houseIdleTicks !== undefined) {
        // f64 preserves fractional-second settings without moving the deadline.
        if (!Number.isFinite(s.houseIdleTicks) || s.houseIdleTicks <= 0) throw new Error("invalid house idle ticks");
        w.f64(s.houseIdleTicks);
        for (const agent of f.agents) w.v(agent.lastHouseCallTick === undefined ? 0 : agent.lastHouseCallTick + 1);
      }
    }
  }

  w.v(m.events.length);
  for (const e of m.events) writeEvent(w, e, version);
  return w.done();
}

/** Public setup-redaction flag; historical unmarked bytes keep their original decoding. */
const SETUP_REDACTED = 2;

/** Public live and stored snapshots omit comparison metadata, not display labels or queen HP. */
export function encodePublicMessage(message: StreamMessage, encode = encodeMessage): Uint8Array {
  if (message.full === null) return encode(message);
  const { rules: _rules, seed: _seed, players: _players, ...setup } = message.full.setup;
  const bytes = encode({ ...message, full: { ...message.full, setup } });
  // Versions 6 and later have fixed comparison slots. They contain zero placeholders,
  // not the original values; the marker prevents inventing a decoded seed=0.
  bytes[3] = bytes[3]! | SETUP_REDACTED;
  return bytes;
}

/** Backwards-compatible entry point for recording a public message. */
export function encodeReplayMessage(message: StreamMessage): Uint8Array {
  return encodePublicMessage(message);
}

export function decodeMessage(bytes: Uint8Array): StreamMessage {
  const r = new Reader(bytes);
  if (r.u16() !== SNAPSHOT_MAGIC) throw new Error("not a stream message");
  const version = r.u8();
  if (version !== SERVICE_TIER_STREAM_VERSION && version !== IDLE_STREAM_VERSION && version !== LINE_MARK_STREAM_VERSION && version !== THINKING_LEVEL_STREAM_VERSION && version !== HOUSE_IDLE_STREAM_VERSION && version !== ABANDONED_STREAM_VERSION && version !== STREAM_VERSION && version !== QUEEN_STREAM_VERSION && version !== VARIANT_STREAM_VERSION && version !== COUNT_MARK_STREAM_VERSION && version !== COMMAND_IDLE_STREAM_VERSION && version !== EARLY_WIN_STREAM_VERSION && version !== TERRAIN_STREAM_VERSION && version !== TERRITORY_WIN_STREAM_VERSION && version !== ROCK_STREAM_VERSION && version !== CASTE_STREAM_VERSION && version !== START_LAYOUT_STREAM_VERSION && version !== GRID_SCALE_STREAM_VERSION && version !== SPECTATOR_STREAM_VERSION) throw new Error(`unsupported stream message version ${version}`);
  const flags = r.u8();
  const tick = r.v();

  const n = r.v();
  const ants: StreamAnts = {
    count: n,
    id: new Uint32Array(n),
    x: new Uint16Array(n),
    y: new Uint16Array(n),
    heading: new Uint8Array(n),
    colony: new Uint8Array(n),
    agent: new Int16Array(n),
    carrying: new Uint8Array(n),
  };
  let id = 0;
  for (let i = 0; i < n; i++) ants.id[i] = id += r.v();
  for (let i = 0; i < n; i++) ants.x[i] = r.u16();
  for (let i = 0; i < n; i++) ants.y[i] = r.u16();
  ants.heading.set(r.bytes(n));
  const bits = r.bytes(n);
  for (let i = 0; i < n; i++) {
    ants.colony[i] = bits[i]! & 1;
    ants.agent[i] = bits[i]! & 2 ? r.u8() : -1;
    ants.carrying![i] = bits[i]! & 8 ? 1 : 0;
  }
  if (bits.some((b) => (b & 4) !== 0)) ants.caste = bits.map((b) => (b >> 2) & 1);

  let full: StreamFull | null = null;
  if (flags & 1) {
    const match = r.v() - 1;
    const mapW = r.v();
    const mapH = r.v();
    const ticksPerSecond = r.v();
    const matchTicks = r.v();
    const idleTicks = r.v();
    const overrunRadiusTiles = r.v();
    const queens: StreamSetup["queens"] = [
      [r.u16(), r.u16()],
      [r.u16(), r.u16()],
    ];
    const territory = r.bytes(mapW * mapH);
    const marks: StreamMark[] = [];
    for (let i = r.v(); i > 0; i--) marks.push(readMark(r, version));
    const agents: StreamAgent[] = [];
    for (let i = r.v(); i > 0; i--) {
      agents.push({
        colony: r.u8() as Colony,
        modelLabel: r.str(),
        joinTick: r.v(),
        lastCallTick: r.v(),
        prevCallTick: r.v() - 1,
        order: ORDER_KINDS[r.u8()]!,
        orderX: r.u8(),
        orderY: r.u8(),
        intent: r.str(),
      });
      if (version >= COMMAND_IDLE_STREAM_VERSION) {
        const commandTick = r.v();
        if (commandTick > 0) agents[agents.length - 1]!.lastCommandTick = commandTick - 2;
      }
      if (version >= SPECTATOR_STREAM_VERSION) {
        const identity = readIdentity(r);
        if (identity !== undefined) agents[agents.length - 1]!.identity = identity;
      }
      if (version >= THINKING_LEVEL_STREAM_VERSION) {
        const thinkingLevel = r.str();
        if (thinkingLevel !== "") agents[agents.length - 1]!.thinkingLevel = thinkingLevel;
      }
      if (version >= SERVICE_TIER_STREAM_VERSION) {
        const serviceTier = r.str();
        if (serviceTier !== "") agents[agents.length - 1]!.serviceTier = serviceTier;
      }
    }
    const overrun: [number, number] = [r.v(), r.v()];
    const overrunRequired = r.v();
    const deaths: [number, number] = [r.v(), r.v()];
    const result = r.u8() === 1 ? readResult(r, version) : null;
    const food = new Uint32Array(mapW * mapH);
    let tile = 0;
    for (let i = r.v(); i > 0; i--) {
      tile += r.v();
      if (tile >= food.length) throw new Error("food tile outside the map");
      food[tile] = r.v();
    }
    const hatch: StreamHatch = { cost: r.v(), intervalTicks: r.v(), cap: r.v() };
    const stores: [StreamStore, StreamStore] = [
      { food: r.v(), nextHatchTick: r.v(), nextCost: r.v() },
      { food: r.v(), nextHatchTick: r.v(), nextCost: r.v() },
    ];
    full = {
      ...(match >= 0 ? { match } : {}),
      setup: { mapW, mapH, ticksPerSecond, matchTicks, idleTicks, overrunRadiusTiles, queens },
      territory,
      marks,
      agents,
      overrun,
      overrunRequired,
      deaths,
      result,
      food,
      hatch,
      stores,
      ...(version >= 5 ? { queens: Array.from({ length: r.v() }, () => readQueen(r, version)), hatched: [r.v(), r.v()] as [number, number] } : {}),
    };
    if (version >= 6) {
      const rules = STREAM_RULES[r.u8() - 1];
      const seed = r.v();
      const players = r.v();
      // Public redaction and terrain-only snapshots must not invent comparison
      // metadata. Unredacted historical version-6–9 decoding stays unchanged.
      if ((flags & SETUP_REDACTED) === 0 && (version < TERRAIN_STREAM_VERSION || rules !== undefined)) {
        full.setup = { ...full.setup, ...(rules === undefined ? {} : { rules }), seed, ...(players === 0 ? {} : { players }) };
      }
    }
    if (version >= EARLY_WIN_STREAM_VERSION) {
      const clockPresent = r.u8();
      if (clockPresent > 1) throw new Error("unknown command-idle clock presence");
      if (clockPresent === 1) full.setup.commandIdleTicks = r.v();
    } else if (version >= COMMAND_IDLE_STREAM_VERSION) full.setup.commandIdleTicks = r.v();
    let terrainPresent = version === TERRAIN_STREAM_VERSION;
    if (version >= TERRITORY_WIN_STREAM_VERSION) {
      const present = r.u8();
      if (present > 1) throw new Error("unknown terrain presence");
      terrainPresent = present === 1;
    }
    if (terrainPresent) {
      const mapId = r.str(), mapName = r.str();
      const water = Array.from({ length: r.v() }, () => [r.v(), r.v(), r.v(), r.v()] as const);
      const rockPresence = version >= CASTE_STREAM_VERSION ? r.u8() : undefined;
      if (rockPresence !== undefined && rockPresence > 1) throw new Error("unknown rock presence");
      const rocks = version >= ROCK_STREAM_VERSION && rockPresence !== 0
        ? Array.from({ length: r.v() }, () => [r.v(), r.v(), r.v(), r.v(), r.v()] as const) : undefined;
      full.setup.terrain = { mapId, mapName, water, ...(rocks === undefined ? {} : { rocks }) };
    }
    if (version >= TERRITORY_WIN_STREAM_VERSION) {
      const progress = readTerritoryWin(r);
      if (progress !== undefined) full.territoryWin = progress;
    }
    if (version >= START_LAYOUT_STREAM_VERSION) readStartingLayout(r, full.setup);
    if (version >= SPECTATOR_STREAM_VERSION) {
      const rated = r.u8();
      if (rated > 2) throw new Error("invalid spectator rated flag");
      if (rated !== 0) full.setup.rated = rated === 2;
    }
    // Every playable stream setup carries grid scale 2; delta messages carry no setup and are unaffected.
    if (version < GRID_SCALE_STREAM_VERSION) throw new RangeError(`stream setup version ${version} carries no grid scale: every match plays at grid scale 2`);
    const scale = r.u8();
    full.setup.gridScale = gridScaleOf({ gridScale: scale === 0 ? undefined : scale });
    if (version >= HOUSE_IDLE_STREAM_VERSION) {
      const present = r.u8();
      if (present > (version >= IDLE_STREAM_VERSION ? 2 : 1)) throw new Error("invalid house idle presence");
      if (present === 1) full.setup.modelIndex = true;
      if (present !== 0) {
        full.setup.houseIdleTicks = r.f64();
        if (!Number.isFinite(full.setup.houseIdleTicks) || full.setup.houseIdleTicks <= 0) throw new Error("invalid house idle ticks");
        for (const agent of full.agents) { const activity = r.v(); if (activity > 0) agent.lastHouseCallTick = activity - 1; }
      }
    }
  }

  const events: StreamEvent[] = [];
  for (let i = r.v(); i > 0; i--) events.push(readEvent(r, version));
  if (r.o !== bytes.byteLength) throw new Error("trailing bytes in stream message");
  return { tick, ants, full, events };
}

function validateStartingLayout(setup: StreamSetup): void {
  const boxes = setup.startBoxes, ids = setup.startingQueenIds;
  if (boxes === undefined || ids === undefined || boxes.length !== 2 || ids.length !== 2) {
    throw new Error("starting boxes and queen identities must be supplied together");
  }
  for (const box of boxes) {
    if (![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) || box.x < 0 || box.y < 0
      || box.width <= 0 || box.height <= 0 || box.x + box.width > setup.mapW || box.y + box.height > setup.mapH) {
      throw new Error("invalid starting box");
    }
  }
  for (const team of ids) {
    if (team.length === 0 || team.length > 255 || new Set(team).size !== team.length
      || team.some(id => !Number.isSafeInteger(id) || id < 0 || id > 0xffff_ffff)) throw new Error("invalid starting queen identities");
  }
}

function writeStartingLayout(w: Writer, setup: StreamSetup): void {
  const present = setup.startBoxes !== undefined || setup.startingQueenIds !== undefined;
  w.u8(present ? 1 : 0);
  if (!present) return;
  validateStartingLayout(setup);
  for (const box of setup.startBoxes!) { w.v(box.x); w.v(box.y); w.v(box.width); w.v(box.height); }
  for (const ids of setup.startingQueenIds!) { w.v(ids.length); for (const id of ids) w.v(id); }
}

function readStartingLayout(r: Reader, setup: StreamSetup): void {
  const present = r.u8();
  if (present > 1) throw new Error("invalid starting layout presence");
  if (!present) return;
  const box = (): StreamStartBox => ({ x: r.v(), y: r.v(), width: r.v(), height: r.v() });
  setup.startBoxes = [box(), box()];
  const ids = (): number[] => {
    const count = r.v();
    if (count === 0 || count > 255) throw new Error("invalid starting queen identities");
    return Array.from({ length: count }, () => r.v());
  };
  setup.startingQueenIds = [ids(), ids()];
  validateStartingLayout(setup);
}

function writeQueen(w: Writer, q: StreamQueen, version: number): void {
  w.v(q.id); w.u8(q.colony); w.u16(q.x); w.u16(q.y); w.v(q.foundedTick); w.v((q.lostTick ?? -1) + 1); w.v(q.overrun);
  // Version 6: hp + 1, 0 for a queen without HP.
  if (version >= 6) w.v(q.hp === undefined ? 0 : q.hp + 1);
}
function readQueen(r: Reader, version: number): StreamQueen {
  const id = r.v(), colony = r.u8() as Colony, x = r.u16(), y = r.u16(), foundedTick = r.v(), lost = r.v() - 1, overrun = r.v();
  const hp = version >= 6 ? r.v() - 1 : -1;
  return { id, colony, x, y, foundedTick, lostTick: lost < 0 ? null : lost, overrun, ...(hp < 0 ? {} : { hp }) };
}
