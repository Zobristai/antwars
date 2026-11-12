/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chooseJoinColony } from "../sim/agents.js";
import { COLONY_NAMES, PUBLIC_CONFIG, withoutHousePausedMaps, type SimConfig } from "../sim/config.js";
import { lobbyColonyNames, type ColonyNamePair } from "../sim/colonyNames.js";
import { newMatchConfig } from "../sim/gridScale.js";
import { headerLine, tickLine } from "../sim/log.js";
import { cloneState, createMatch } from "../sim/map.js";
import { advance, prepareInitialPointRests, step, type ServerTerminal } from "../sim/step.js";
import type { Agent, BroodSet, ColonyId, InputErrorCode, InputResult, MatchResult, SimInput, SimState, StepOutput, VisibleEvent } from "../sim/types.js";
import type { AgentView } from "../sim/view.js";
import { HOLD_BEHAVIOUR } from "../sim/holdBehaviour.js";
import { GAME_SAVE_FORMAT, type GameSave, type SavedAgentRecord, type StartGameSave } from "../handover/matchSave.js";
import { finishedStart, LobbyStart, type FinishedStart } from "./lobbyStart.js";
import type { RankedMode } from "../rating/ratings.js";
import { captureCells, cellOffset, type CellSnapshot } from "./cellPages.js";
import { startPickWindowMsFor, type StartPickError, type StartTerrain } from "../sim/startPlacement.js";
import { agentsPerColony, DEFAULT_MCP_CONFIG, houseIdleSecondsOf, type McpConfig } from "./config.js";
import { keepsStub, replyLine, stubLine, STUBS_PER_WINDOW, textLine, type ReplyEntry, type StubCall } from "../replays/recording.js";
import type { ServedText } from "./replies.js";

/** A call answered not_applied while its server hands the match over may be made again after this long. */
export const NOT_APPLIED_RETRY_MS = 1000;

/** When the next match starts: a scheduled time, held until its caller starts it, or not known. */
export type NextStart = { readonly kind: "scheduled"; readonly at: Date } | { readonly kind: "held" } | null;

/** Errors the adapter raises itself; every other code is the sim's. */
export type AdapterErrorCode = "unknown_token" | "agent_cap" | "colony_full" | "call_rate" | "not_started" | "match_not_played" | "not_applied";
export type GameErrorCode = InputErrorCode | AdapterErrorCode;

/**
 * Compact receipt shared with bound sessions; survives only as long as its holders do.
 * notPlayed, set only on a slot server whose match was replaced or failed to start,
 * overrides any result: such a match is not played, with no winner.
 */
export interface FinalResultReceipt {
  readonly result: MatchResult | null;
  readonly notPlayed?: true;
}

/** One seat of the lobby whose match this slot server plays. An identity may hold several seats of its colony. */
export interface LobbySeat {
  readonly identityId: string;
  readonly displayName: string;
  readonly colony: ColonyId;
  /** 1-based ordinal among the seats its identity holds, in stored order; 1 for a single-seat identity. Absent counts as 1. */
  readonly seat?: number;
}

/** A seat's key: its identity id for the identity's first seat (seat 1 or absent), `identityId#seat` for a later one. */
export function seatKeyOf(seat: { readonly identityId: string; readonly seat?: number }): string {
  return (seat.seat ?? 1) === 1 ? seat.identityId : `${seat.identityId}#${seat.seat}`;
}

/** Where a lobby's match is played, as the slot servers resolve it for any caller. */
export interface MatchAddress {
  readonly slot: string | null;
  readonly mcpUrl: string | null;
  readonly spectatorUrl: string | null;
}

/** A slot server's store-backed lookups for the MCP tools. Absent on every other server. */
export interface SlotAccess {
  /** The identity a key belongs to, or undefined. */
  identityOf(key: string): Promise<string | undefined>;
  /**
   * The identity a key verifier (keyVerifier of the key) still holds, or undefined once that key was replaced.
   * When present, a session joined by key re-checks its key with it and ends when the key no longer holds its seat.
   */
  holderOfVerifier?(verifier: string): Promise<string | undefined>;
  /** Undefined for an unknown lobby. */
  locate(lobbyId: string): Promise<MatchAddress | undefined>;
  /** Durable record of an actually admitted join/rejoin, never a queued seat. */
  recordJoin?(identityId: string, at: number): Promise<void>;
  /** The lobby holding this slot in the store, when it seats the identity; undefined otherwise. */
  assignedLobby?(identityId: string): Promise<string | undefined>;
}

/** Adapter-only observe fields, captured with the sim view, never by taking another view. */
export interface ObserveInfo {
  /** Present for a rated-house seat; the live server setting, not a rules value. */
  readonly houseIdleSeconds?: number;
  /** Compact, documented seat metadata; reset tool names are space-separated. */
  readonly status: readonly [
    idleSecondsLeft: number | null,
    idleResetCommands: string,
    enemyTerritorySharePermille?: number,
  ];
}

export interface CallTiming {
  readonly tick: number | null;
  readonly nextCommandTick: number | null;
  readonly retryAfterMs: number;
}

export type Outcome = (
  | { readonly kind: "view"; readonly view: AgentView; /** Rules 27: what an accepted set_brood set. */ readonly broodSet?: BroodSet }
  | { readonly kind: "queued"; readonly nextStart: NextStart }
  | {
      readonly kind: "error";
      readonly code: GameErrorCode;
      /** The sim's own message, when the sim raised the error. */
      readonly simMessage?: string;
      /** count_mark_not_visible: the nearest tile the same count mark would be accepted on, or null. */
      readonly nearestTile?: { readonly tileX: number; readonly tileY: number } | null;
      /** The view the call's sim input produced, when one reached the sim. */
      readonly view: AgentView | null;
      /** An ended match's result, for a refused call that produced no view. */
      readonly result?: MatchResult | null;
      readonly timing?: CallTiming;
    }) & { readonly observeInfo?: ObserveInfo };

export interface NestSelection {
  /** Every seat must pick in house modes; no missing seat receives a default. */
  readonly required: boolean;
  /** This lobby's window length in ms: 240 s in index matches, 120 s otherwise. */
  readonly windowMs: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly closesAt: number;
  readonly terrain?: StartTerrain;
  readonly picks: readonly { readonly displayName: string; readonly mine: boolean; readonly tileX: number; readonly tileY: number }[];
}

export type NestPickOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: StartPickError | "call_rate" | "match_not_played"; readonly retryAfterMs?: number };

export interface JoinOutcome {
  readonly agentId: string | null;
  readonly token: string | null;
  /** Config the agent's match runs with (the next match's for a queued join). */
  readonly config: SimConfig;
  readonly outcome: Outcome;
}

export interface JoinRequest {
  readonly token?: string;
  readonly displayName?: string;
  readonly modelLabel?: string;
  readonly thinkingLevel?: string;
  readonly colony?: ColonyId;
}

/** Seat-private adapter notices; never simulation events or recording inputs. */
export type SeatNotice = {
  readonly type: "squad_replaced";
  readonly tick: number;
  readonly agentId: string;
  readonly colony: ColonyId;
};

export type ObserveEvent = VisibleEvent | SeatNotice;

export type AgentStatus = "live" | "queued" | "ended" | "unknown";

/** A lobby seat an agent joined into: its seat key and the colony it is placed on. */
export interface LineupSeat {
  readonly key: string;
  readonly colony: ColonyId;
}

/** Where a queued agent will be placed when the next match starts. */
export interface QueuedPlacement {
  readonly agentId: string;
  /** The lobby seat key it joined with; null for a join without a seat. */
  readonly key: string | null;
  readonly colony: ColonyId;
}

export interface GameOptions {
  /** Config for matches started without one, and for briefings before a match starts. */
  readonly simConfig?: SimConfig;
  /** Explicit test-only duration; omission keeps the production pick window: 240 s in index matches, 120 s otherwise. */
  readonly startPickWindowMs?: number;
  /**
   * How long a seated seat waits before its nest pick opens on a slot server: the lobby countdown plus one slot poll
   * (src/server.ts derives it from their config). With the pick window it sets the seat's pre-match recording
   * allowance (preMatchFullEntries); omitted (a bare Game in tests), the allowance covers the pick window alone.
   */
  readonly preStartMs?: number;
  readonly mcpConfig?: McpConfig;
  /** Wall clock in ms, for the per-agent rate limit. */
  readonly now?: () => number;
  /** Receives the match log, line by line, in the sim's JSONL format. */
  readonly onLogLine?: (line: string) => void;
  /** Called whenever a call input is queued for the next tick. */
  readonly onInputQueued?: () => void;
  /**
   * Receives each seat's call reply line (recordReply) for match seq, in call order: the match recording's only
   * source of replies. Never the match log: a reply line is not a simulation input.
   */
  readonly onReply?: (seq: number, line: string) => void;
  /** Set only on a slot server: joins are by lobby key, never by token or colony. */
  readonly slot?: SlotAccess;
}

/**
 * A mutating call's call id (the seat client's params._meta["antwars/callId"]) and the
 * reply it was answered with when the match applied it. A repeat of the id gets this reply and
 * takes no second effect, on this server or, through the handover save, on the one resuming it.
 */
export interface AppliedCall {
  readonly callId: string;
  readonly reply: CallToolResult;
}

/** A call id to remember once its call is applied, with how its tool renders the applied outcome. */
export interface CallIdentity {
  readonly callId: string;
  /** Called as the tick applies the call, before any reply leaves, so a save at that tick carries the record. */
  readonly reply: (outcome: Outcome) => CallToolResult;
}

/** A thrown value as one bounded log fragment: its name and the first 160 characters of its message, never a stack. */
export function failureSummary(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return `${name}: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160)}`;
}

interface Pending {
  /** False for an adapter refusal represented internally as an observe input. */
  readonly countsAsHouseActivity?: boolean;
  readonly input: SimInput;
  readonly settle: (result: InputResult) => void;
  /** Answers the call unapplied: not played when its match is abandoned before the next tick, not applied when it stops for a handover save. */
  readonly refuse: (outcome: Outcome) => void;
  /** A queued seat's join that startMatch adds for the first tick: no caller waits on it, and a handover save keeps it. */
  readonly startJoin?: true;
}

interface Match {
  readonly seq: number;
  readonly seed: number;
  state: SimState;
  pending: Pending[];
  /** The lobby colonies whose seat never joined, set only when that ended the match abandoned. */
  absentColonies?: readonly ColonyId[];
}

interface AgentRecord {
  readonly agentId: string;
  readonly token: string;
  /** The one match this agent belongs to. */
  readonly matchSeq: number;
  /** Captured at admission so an ended caller keeps its own match mode. */
  readonly houseMatch: boolean;
  /** The colony names of this agent's match, captured at admission (and recomputed from the lobby on resume). */
  readonly colonyNames: ColonyNamePair;
  readonly displayName: string | null;
  readonly modelLabel: string | null;
  readonly thinkingLevel: string | null;
  /** Lobby-slot seats only: the first join's self-reported service tier. Adapter metadata, never a simulation input. */
  readonly serviceTier: string | null;
  readonly colony: ColonyId | undefined;
  readonly seat: LineupSeat | null;
  callTimes: number[];
  /** Sessions keep only this receipt, not a retired record's events or match state. */
  readonly finalResult: { result: MatchResult | null; notPlayed?: true };
  /** Slot servers: the lobby and seat key this seat belongs to, its rejoin key. */
  readonly seatKey: string | null;
  /** Slot servers: the identity holding this seat, whose join activity is recorded. */
  readonly identityId: string | null;
  /** Already fog-filtered events, retained through this match and its reconnects. */
  events: ObserveEvent[];
  /** Last nonempty squad seen by any admitted call; empty views retain it. */
  lastSquad: ReadonlySet<number> | null;
  /** Kept in the save format; always false, since rules 27 has no colony brood vote. */
  broodVoteLost: boolean;
  /** Continuation for explicit chronological history replay only. */
  eventCursor: number;
  /** History boundary considered by the last current/default reply. */
  currentEventCursor: number;
  /** History indexes of own queen/mark events and seat notices not yet sent in a current reply. */
  priorityEvents: number[];
  /** Replaced, never appended, on a fresh observe; released with this record. */
  cellSnapshot: CellSnapshot | null;
  /**
   * Every applied call with a call id in this match, oldest first, kept until the match ends: an MCP
   * client may make a call again at any time, so none is dropped earlier. Bounded by the call limits:
   * commands at most one per commandFloorTicks, set_brood at most callsPerSecond. Plain data, carried in the handover save.
   */
  appliedCalls: AppliedCall[];
}

export interface MatchInfo {
  readonly seq: number;
  readonly seed: number;
  readonly state: SimState;
  readonly result: MatchResult | null;
}

/**
 * The live game behind the MCP tools: the current match, agents queued for the
 * next one, and each agent's token and match. Rules are the sim's; this only
 * turns calls into sim inputs at the next tick boundary. The server member
 * drives tick() at 10 Hz, starts matches and writes the log lines.
 */
export class Game {
  readonly mcpConfig: McpConfig;
  readonly simConfig: SimConfig;
  private readonly houseActivity = new Map<string, number>();
  private readonly houseIdleSeconds: number;
  private readonly now: () => number;
  private readonly startPickWindowMs: number | undefined;
  private readonly onLogLine: (line: string) => void;
  private readonly onInputQueued: () => void;
  private readonly onReply: (seq: number, line: string) => void;
  /** Reply lines of seats whose match has not started, oldest first; its first tick or live reply hands them on. */
  private heldReplies: { readonly seq: number; readonly agentId: string; readonly line: string }[] = [];
  /**
   * Per seat, its held stubs under the stub rule (keepsStub), so a flood before the match begins holds at most
   * STUBS_PER_WINDOW stubs a second: the answer times of those held in the last window, the calls left out since the
   * last one held, and the last of those, handed on after the held lines as a closing stub counting the rest. held is
   * how many it holds: fewer than preMatchStubs, so with its one closing stub a seat holds at most preMatchStubs;
   * past it a call is only counted.
   */
  private readonly heldStubs = new Map<string, { readonly seq: number; kept: number[]; omitted: number; last: StubCall | null; held: number }>();
  /**
   * Per seat, how many full entries it has recorded before its match began: at
   * most preMatchFullEntries, the slot pre-match allowance, so a stuck start or a held start waiting on its players
   * cannot grow the record; calls beyond it are stubs.
   */
  private readonly heldFull = new Map<string, { readonly seq: number; count: number }>();
  /** The countdown plus one slot poll before a seat's nest pick opens; with the lobby's window, its pre-match period. */
  private readonly preStartMs: number;
  private replyFailureReported = false;
  /** Per seat, the answer times of its calls recorded in full in the last second: its recording budget (recordsInFull). */
  private readonly recordedTimes = new Map<string, number[]>();
  /** Per match seq: the digests of the served texts already handed to its recording or held for it. */
  private textsSent = new Map<number, Set<string>>();
  private current: Match | null = null;
  private previous: Match | null = null;
  /** The tick the live match stopped at for a handover save (stopForSave); it never advances on this server again. */
  private stoppedAt: number | null = null;
  private next: NextStart = null;
  private readonly records = new Map<string, AgentRecord>();
  private readonly byToken = new Map<string, AgentRecord>();
  /** Slot servers: seats by lobby and seat key, so a rejoin never reaches another lobby's ended seat. */
  private readonly bySeat = new Map<string, AgentRecord>();
  /**
   * Slot servers: the lobby whose match this server plays next, now, or played last.
   * matchSeq is null during its countdown, then the sequence of its one match.
   * start is its finished pick window, which gave each seat its starting queen; null before then.
   */
  private lobby: { readonly id: string; readonly mode: RankedMode | null; readonly seats: ReadonlyMap<string, LobbySeat>; notPlayed: boolean; matchSeq: number | null; start: FinishedStart | null } | null = null;
  /** Slot servers: the identities of the last lobby whose match was not played here. */
  private notPlayed: { readonly lobbyId: string; readonly identities: ReadonlySet<string> } | null = null;
  readonly slot: SlotAccess | undefined;
  private starting: { readonly seed: number; readonly window: LobbyStart } | null = null;
  /**
   * The pick time a restored start had left when saved, until activateResumedStart opens its
   * window again once this server has adopted it; null otherwise.
   */
  private restoredStartMs: number | null = null;
  /** True while a match restored from a handover save waits for this server to adopt it. */
  private resuming = false;
  private readonly joinActivity = new Set<{ identityId: string; at: number; acknowledge: () => void }>();
  private writingJoinActivity = false;
  private joinActivityClosed = false;
  private joinActivityRetry: ReturnType<typeof setTimeout> | undefined;

  /** Shutdown stops only this instance's recording retries, never the shared retention epoch. */
  closeJoinActivity(): void {
    this.joinActivityClosed = true;
    if (this.joinActivityRetry !== undefined) clearTimeout(this.joinActivityRetry);
  }

  /** Actual admissions persist before their live join reply; failures retain the event for retry. */
  private flushJoinActivity(): void {
    if (this.writingJoinActivity || this.joinActivityClosed || !this.slot?.recordJoin || this.joinActivity.size === 0) return;
    this.writingJoinActivity = true;
    const record = this.slot.recordJoin.bind(this.slot);
    void Promise.all([...this.joinActivity].map(async event => {
      try {
        await record(event.identityId, event.at);
        this.joinActivity.delete(event);
        event.acknowledge();
      } catch {
        console.warn("antwar successful match join activity update failed", { identityId: event.identityId });
      }
    })).finally(() => {
      this.writingJoinActivity = false;
      if (this.joinActivity.size > 0 && !this.joinActivityClosed) {
        this.joinActivityRetry = setTimeout(() => this.flushJoinActivity(), 1_000);
        this.joinActivityRetry.unref();
      }
    });
  }

  constructor(options: GameOptions = {}) {
    this.simConfig = options.simConfig ?? newMatchConfig(PUBLIC_CONFIG);
    this.mcpConfig = options.mcpConfig ?? DEFAULT_MCP_CONFIG;
    this.houseIdleSeconds = houseIdleSecondsOf(this.mcpConfig);
    this.now = options.now ?? Date.now;
    this.startPickWindowMs = options.startPickWindowMs;
    this.preStartMs = options.preStartMs ?? 0;
    this.onLogLine = options.onLogLine ?? (() => {});
    this.onInputQueued = options.onInputQueued ?? (() => {});
    this.onReply = options.onReply ?? (() => {});
    this.slot = options.slot;
  }

  /** Slot servers: seat the lobby whose match is next; only its identities may join, each seat by its seat key. */
  seatLobby(lobbyId: string, seats: readonly LobbySeat[], mode: RankedMode | null = null): void {
    this.starting = null;
    this.lobby = { id: lobbyId, mode, seats: new Map(seats.map((seat) => [seatKeyOf(seat), seat])), notPlayed: false, matchSeq: null, start: null };
    // An earlier lobby's seat queued for a match that never started was not played; it never joins this lobby's match.
    const started = this.current?.seq ?? 0;
    for (const rec of this.records.values()) {
      if (rec.seatKey !== null && !rec.seatKey.startsWith(`${lobbyId}/`) && rec.matchSeq > started) rec.finalResult.notPlayed = true;
    }
  }

  /** The seated lobby's pre-draw config, before its seed draws a map: house modes leave out the paused maps. */
  get undrawnConfig(): SimConfig {
    return this.lobby?.mode?.startsWith("house-") === true ? withoutHousePausedMaps(this.simConfig) : this.simConfig;
  }

  /** A seated house lobby whose match has not started: its pre-draw config, which the rules page shows
   * instead of a retained earlier match; null otherwise, so other modes keep the order. */
  get seatedHouseUndrawnConfig(): SimConfig | null {
    const lobby = this.lobby;
    return lobby !== null && lobby.matchSeq === null && !lobby.notPlayed && lobby.mode?.startsWith("house-") === true
      ? this.undrawnConfig : null;
  }

  /** Lobby-only preparation: no log header, match state or spectator publication. */
  beginLobbyStart(seed: number): number {
    if (this.slot === undefined || this.lobby === null || this.lobby.notPlayed || this.lobby.matchSeq !== null) {
      throw new Error("No seated lobby to start");
    }
    if (this.starting !== null) throw new Error("Lobby pick window already open");
    // Picks are per seat: the starting roster is keyed by seat key, never by identity.
    const roster = [...this.lobby.seats].map(([key, seat]) => ({ identityId: key, colony: seat.colony }));
    const window = new LobbyStart(seed, this.undrawnConfig, roster, this.now(), this.nestWindowMs(), this.lobby.mode?.startsWith("house-") === true);
    this.starting = { seed, window };
    this.setNextStart({ kind: "scheduled", at: new Date(window.closesAt) });
    return window.closesAt;
  }

  /** The seated lobby's nest-pick window length: the test override, else 240 s in index matches and 120 s otherwise. */
  nestWindowMs(): number {
    return this.startPickWindowMs ?? startPickWindowMsFor(this.lobby?.mode?.startsWith("house-") === true);
  }

  /** Finalization is atomic; a premature call leaves every pick intact. */
  finishLobbyStart(): void {
    const starting = this.starting, lobby = this.lobby;
    if (starting === null || lobby === null || lobby.notPlayed) throw new Error("No lobby pick window");
    const state = starting.window.finish(this.now());
    lobby.start = starting.window;
    this.startMatch(starting.seed, { state });
    this.starting = null;
  }

  /** Read-only, server-bound team projection; never included on public status. */
  nestSelection(agentId: string, includeTerrain = false): NestSelection | null {
    const rec = this.records.get(agentId);
    if (rec === undefined || rec.finalResult.notPlayed || rec.seat === null || this.lobby === null
      || rec.seatKey !== `${this.lobby.id}/${rec.seat.key}` || this.starting === null) return null;
    const view = this.starting.window.teamView(rec.seat.key, includeTerrain && this.now() < this.starting.window.closesAt);
    return view === null ? null : { required: this.lobby.mode?.startsWith("house-") === true, windowMs: this.nestWindowMs(), box: view.box, closesAt: view.closesAt,
      ...(view.terrain === undefined ? {} : { terrain: view.terrain }), picks: view.picks.map(pick => ({
      displayName: this.seatName(this.lobby!.seats.get(pick.identityId)!), mine: pick.identityId === rec.seat!.key,
      tileX: pick.tileX, tileY: pick.tileY,
    })) };
  }

  /** How many seats of the seated lobby an identity holds; 0 when it holds none. */
  seatsHeld(identityId: string): number {
    let count = 0;
    for (const seat of this.lobby?.seats.values() ?? []) if (seat.identityId === identityId) count += 1;
    return count;
  }

  /** A seat's name for its teammates: `<displayName> #<seat>` when its identity holds several seats. */
  private seatName(seat: LobbySeat): string {
    return this.seatsHeld(seat.identityId) > 1 ? `${seat.displayName} #${seat.seat ?? 1}` : seat.displayName;
  }

  /** Placement is a rate-limited adapter action, not a simulation command/tick. */
  pickNest(agentId: string, tileX: number, tileY: number): NestPickOutcome {
    const rec = this.records.get(agentId);
    if (rec === undefined || rec.seat === null) return { ok: false, reason: "not_seated" };
    if (rec.finalResult.notPlayed) return { ok: false, reason: "match_not_played" };
    if (this.lobby === null || rec.seatKey !== `${this.lobby.id}/${rec.seat.key}`) {
      return { ok: false, reason: "window_closed" };
    }
    const retryAfterMs = this.overRate(rec);
    if (retryAfterMs !== null) return { ok: false, reason: "call_rate", retryAfterMs };
    return this.starting?.window.pick(rec.seat.key, tileX, tileY, this.now()) ?? { ok: false, reason: "window_closed" };
  }

  /**
   * Slot servers: true when the lobby holding this slot seats the identity but
   * this server has not seated that lobby yet, so a join should be retried shortly. The
   * store is read only when the seated lobby cannot serve the identity: none is seated,
   * it holds no seat of the identity, or its match was not played or has ended.
   */
  async lobbyLoading(identityId: string): Promise<boolean> {
    const lobby = this.lobby;
    // A restored match is not playable here until this server has adopted it.
    if (this.resuming && lobby !== null && this.seatsHeld(identityId) > 0 && !lobby.notPlayed) return true;
    if (lobby !== null && this.seatsHeld(identityId) > 0 && !lobby.notPlayed && !this.lobbyMatchEnded(lobby)) return false;
    const assigned = await this.slot?.assignedLobby?.(identityId);
    return assigned !== undefined && assigned !== this.lobby?.id;
  }

  /**
   * True from restoring a handover save until this server adopts the match, false once it
   * has; meanwhile the restored match does not advance and its seats' key joins answer lobby_loading.
   */
  setResuming(resuming: boolean): void {
    this.resuming = resuming;
  }

  /**
   * A restored match this server will not play (its restore failed, or it was not
   * adopted) ends here not played, at its saved tick and with no tick, log line or feed, so a
   * later lobby's match can start. Nothing while no restored match awaits adoption. A restored
   * start (its nest-pick window reopened) ends not played the same way, before any match exists.
   */
  dropResumed(): void {
    const m = this.current, start = this.openStart;
    if (!this.resuming || (m === null && start === null)) return;
    this.resuming = false;
    this.restoredStartMs = null;
    this.endNotPlayed();
    if (start === null) m!.state.result ??= { winner: null, reason: "abandoned", decidedBy: "draw", tick: m!.state.tick };
  }

  private lobbyMatchEnded(lobby: { readonly matchSeq: number | null }): boolean {
    const matchSeq = lobby.matchSeq;
    return matchSeq !== null && (this.current?.seq !== matchSeq || this.current.state.result !== null);
  }

  /**
   * Slot servers: an identity's join to one of its seats in the seated lobby's match,
   * or its rejoin to that seat there. seat is the 1-based ordinal among the seats the
   * identity holds (1 by default). Placement is the lobby's colony; no token is used.
   * Null when the identity does not hold that seat in that lobby.
   */
  async joinSeated(identityId: string, modelLabel?: string, seatNumber = 1, thinkingLevel?: string, serviceTier?: string): Promise<JoinOutcome | null> {
    const lobby = this.lobby;
    const key = seatKeyOf({ identityId, seat: seatNumber });
    const seat = lobby?.seats.get(key);
    if (lobby === null || seat === undefined) {
      return this.notPlayed?.identities.has(identityId) ? { agentId: null, token: null, config: this.simConfig, outcome: adapterError("match_not_played", null) } : null;
    }
    if (lobby.notPlayed) return { agentId: null, token: null, config: this.simConfig, outcome: adapterError("match_not_played", null) };
    const seatKey = `${lobby.id}/${key}`;
    const existing = this.bySeat.get(seatKey);
    if (existing !== undefined) {
      return { agentId: existing.agentId, token: null, config: this.configFor(existing), outcome: await this.call(existing.agentId, { type: "rejoin", agentId: existing.agentId }) };
    }
    const matchSeq = lobby.matchSeq;
    if (this.lobbyMatchEnded(lobby)) {
      // The lobby's match has ended: a first join sees its result and never queues for a later lobby's match.
      const result = this.current?.seq === matchSeq ? this.current.state.result : null;
      return { agentId: null, token: null, config: this.simConfig, outcome: { kind: "error", code: "match_over", view: null, result } };
    }
    const live = matchSeq !== null;
    const rec = this.newRecord(matchSeq ?? (this.current?.seq ?? 0) + 1, {
      displayName: seat.displayName, modelLabel: modelLabel ?? null, thinkingLevel: thinkingLevel ?? null, serviceTier: serviceTier ?? null, colony: undefined,
      seat: { key, colony: seat.colony }, seatKey, identityId,
    });
    this.bySeat.set(seatKey, rec);
    const outcome: Outcome = live ? await this.submit(this.current!, this.seatJoinInput(rec)) : { kind: "queued", nextStart: this.next };
    return { agentId: rec.agentId, token: null, config: this.configFor(rec), outcome };
  }

  /**
   * Slot servers: a lobby's match was not played (a successor took the slot, the
   * match failed to start, or, for `lobby`, an earlier run of this slot began it and
   * is gone). By default the seated lobby. Every seat of it, live, queued or already
   * finished, and every key join by its identities is answered match_not_played with
   * no winner from now on, waiting calls included.
   */
  endNotPlayed(lobby: { readonly id: string; readonly identityIds: readonly string[] } | null = null): void {
    const target = lobby ?? (this.lobby === null ? null : { id: this.lobby.id, identityIds: [...this.lobby.seats.values()].map(seat => seat.identityId) });
    if (target === null) return;
    // Kept for the last such lobby only, so its identities learn the outcome even after the next lobby is seated.
    this.notPlayed = { lobbyId: target.id, identities: new Set(target.identityIds) };
    for (const rec of this.records.values()) {
      if (rec.seatKey !== null && rec.seatKey.startsWith(`${target.id}/`)) rec.finalResult.notPlayed = true;
    }
    if (this.lobby?.id !== target.id) return;
    this.lobby.notPlayed = true;
    this.starting = null;
    const pending = this.current?.pending ?? [];
    if (this.current !== null) this.current.pending = [];
    for (const p of pending) p.refuse(adapterError("match_not_played", null));
  }

  /**
   * Handover save step: stops the live match at this tick boundary for good on this
   * server, so it never advances here again. Every call still waiting for the next tick, and
   * every call that reaches the match from now on, is answered not_applied with a retry hint
   * and is not part of the match: the server that resumes it applies the call once it is made
   * again there. Queued seats' start joins, which no caller waits on, stay for the save.
   * Returns the tick the match stopped at; null when no match is running.
   */
  stopForSave(): number | null {
    const m = this.current;
    if (m === null || (this.stoppedAt === null && m.state.result !== null)) return null;
    this.stoppedAt ??= m.state.tick;
    const calls = m.pending.filter((p) => p.startJoin !== true);
    m.pending = m.pending.filter((p) => p.startJoin === true);
    for (const p of calls) p.refuse(this.notApplied());
    return this.stoppedAt;
  }

  /** A stopped match's answer to a call it did not apply: call again after the hint, by when another server plays the match. */
  private notApplied(): Outcome {
    return { kind: "error", code: "not_applied", view: null, timing: { tick: this.stoppedAt, nextCommandTick: null, retryAfterMs: NOT_APPLIED_RETRY_MS } };
  }

  /** The open start window's config (its drawn map), or null when no window is open. */
  get startWindowConfig(): SimConfig | null {
    return this.starting?.window.config ?? null;
  }

  /** The current match (running or ended), or null before the first. */
  get match(): MatchInfo | null {
    const m = this.current;
    return m === null ? null : { seq: m.seq, seed: m.seed, state: m.state, result: m.state.result };
  }

  /** Slot servers: the seated lobby whose begun match is running here, not ended or marked not played; null otherwise. */
  get matchLobbyId(): string | null {
    const lobby = this.lobby, m = this.current;
    return lobby !== null && !lobby.notPlayed && m !== null && lobby.matchSeq === m.seq && m.state.result === null ? lobby.id : null;
  }

  get nextStart(): NextStart {
    return this.next;
  }

  setNextStart(next: NextStart): void {
    this.next = next;
  }

  /** The colonies whose lobby seat never joined the current match, when that ended it abandoned; otherwise none. */
  matchAbsentColonies(): readonly ColonyId[] {
    return this.current?.state.result?.reason === "abandoned" ? this.current.absentColonies ?? [] : [];
  }

  /** Accepted simulation metadata for the current match, using only each identity's seat 1. */
  matchThinkingLevels(): Readonly<Record<string, string | null>> {
    const levels: Record<string, string | null> = {};
    for (const agent of this.current?.state.agents ?? []) {
      const rec = this.records.get(agent.id);
      if (rec?.identityId == null || rec.seat?.key !== rec.identityId) continue;
      // Historical agents can predate thinking-level recording.
      levels[rec.identityId] = "thinkingLevel" in agent && typeof agent.thinkingLevel === "string" ? agent.thinkingLevel : null;
    }
    return levels;
  }

  /** Self-reported service tier of each identity's seat 1 in the current match; null when that seat gave none. */
  matchServiceTiers(): Readonly<Record<string, string | null>> {
    const tiers: Record<string, string | null> = {};
    for (const agent of this.current?.state.agents ?? []) {
      const rec = this.records.get(agent.id);
      if (rec?.identityId == null || rec.seat?.key !== rec.identityId) continue;
      tiers[rec.identityId] = rec.serviceTier;
    }
    return tiers;
  }

  /** Self-reported model label of each identity's seat 1 in the current match; null when that seat gave none. */
  matchModelLabels(): Readonly<Record<string, string | null>> {
    const labels: Record<string, string | null> = {};
    for (const agent of this.current?.state.agents ?? []) {
      const rec = this.records.get(agent.id);
      if (rec?.identityId == null || rec.seat?.key !== rec.identityId) continue;
      labels[rec.identityId] = rec.modelLabel;
    }
    return labels;
  }

  /** Agents joined for the next match and waiting for it to start. */
  get queuedAgents(): number {
    const seq = this.current?.seq ?? 0;
    let count = 0;
    for (const rec of this.records.values()) if (rec.matchSeq > seq) count += 1;
    return count;
  }

  /** Inputs waiting for the next tick. */
  get pendingInputs(): number {
    return this.current?.pending.length ?? 0;
  }

  /** Display name and model label an agent gave at join, and its lobby seat's key on a slot server, for spectators. */
  agentInfo(agentId: string): { displayName: string | null; modelLabel: string | null; seatKey: string | null } | undefined {
    const rec = this.records.get(agentId);
    return rec === undefined ? undefined
      : { displayName: rec.displayName, modelLabel: rec.modelLabel, seatKey: rec.seatKey === null || rec.seat === null ? null : rec.seat.key };
  }

  /**
   * Where each agent queued for the next match will be placed: its queued joins
   * stepped on a scratch match, exactly as the next match's first tick places
   * them (placement reads only the joins, never the map or seed).
   */
  queuedLineup(): QueuedPlacement[] {
    const seq = (this.current?.seq ?? 0) + 1;
    const queued = [...this.records.values()].filter((rec) => this.joinsAt(rec, seq));
    const placed = step(createMatch(0, this.simConfig), queued.map(joinInput)).state.agents;
    return queued.map((rec) => {
      const agent = placed.find((a) => a.id === rec.agentId);
      if (agent === undefined) throw new Error(`queued agent ${rec.agentId} was not placed`);
      return { agentId: rec.agentId, key: rec.seat?.key ?? null, colony: agent.colony };
    });
  }

  status(agentId: string | null): AgentStatus {
    const rec = agentId === null ? undefined : this.records.get(agentId);
    return rec === undefined ? "unknown" : this.locate(rec).kind;
  }

  /**
   * Start the next match. Agents queued for it join on its first tick, in the
   * order they called join, so the sim places them by the same rule as a live
   * join. `state` replaces the fresh match (tests use scripted states).
   */
  startMatch(seed: number, options: { config?: SimConfig; state?: SimState } = {}): void {
    if (this.current !== null && this.current.state.result === null) throw new Error("a match is already running");
    const seq = (this.current?.seq ?? 0) + 1;
    // The match advances in place; a supplied state is copied once so the caller's object is left unchanged.
    const state = options.state !== undefined ? cloneState(options.state) : createMatch(seed, options.config ?? this.simConfig);
    prepareInitialPointRests(state);
    this.retireRecordsBefore(seq);
    this.previous = this.current;
    this.current = { seq, seed, state, pending: [] };
    this.houseActivity.clear();
    // A seat already in the starting state (scripted test states) enters its match now; its idle clock starts here.
    for (const agent of state.agents) this.houseActivity.set(agent.id, state.tick);
    this.next = null;
    this.heldReplies = this.heldReplies.filter(held => held.seq >= seq);
    for (const [agentId, seat] of this.heldStubs) if (seat.seq < seq) this.heldStubs.delete(agentId);
    for (const [agentId, seat] of this.heldFull) if (seat.seq < seq) this.heldFull.delete(agentId);
    this.onLogLine(headerLine(seed, state.config));
    if (this.lobby !== null && this.lobby.matchSeq === null && !this.lobby.notPlayed) this.lobby.matchSeq = seq;
    for (const rec of this.records.values()) {
      if (this.joinsAt(rec, seq)) this.current.pending.push({ input: this.seatJoinInput(rec), settle: () => {}, refuse: () => {}, startJoin: true });
    }
  }

  /** Keep only the match just ended before match seq, so its agents can still read the winner. */
  private retireRecordsBefore(seq: number): void {
    for (const rec of [...this.records.values()]) {
      if (rec.matchSeq < seq - 1) {
        rec.cellSnapshot = null;
        this.records.delete(rec.agentId);
        this.recordedTimes.delete(rec.agentId);
        this.byToken.delete(rec.token);
        if (rec.seatKey !== null) this.bySeat.delete(rec.seatKey);
      }
    }
  }

  /**
   * Handover save: the running match at this tick boundary, as a copy later play cannot
   * change; nothing here changes the game. Calls waiting for the next tick are left out, and so is
   * the record of a seat whose join has not been applied, so that its next join on the resuming
   * server seats it afresh; only the joins startMatch queued for the first tick are carried.
   */
  saveMatch(): GameSave {
    const start = this.openStart;
    if (start !== null) return this.saveStart();
    const m = this.current;
    if (m === null || m.state.result !== null) throw new Error("No running match to save");
    const startJoins = m.pending.flatMap(p => p.startJoin === true && p.input.type === "join" ? [p.input] : []);
    const inMatch = new Set([...m.state.agents.map(agent => agent.id), ...startJoins.map(input => input.agentId)]);
    const records = [...this.records.values()].filter(rec => rec.matchSeq === m.seq && inMatch.has(rec.agentId)).map(savedRecord);
    const lobby = this.lobby?.matchSeq === m.seq ? this.lobby : null;
    const save: GameSave = {
      format: GAME_SAVE_FORMAT, phase: "match", seed: m.seed, tick: m.state.tick, holdBehaviour: HOLD_BEHAVIOUR, state: m.state, startJoins,
      houseActivity: [...this.houseActivity], records, replies: this.heldRepliesOf(m.seq),
      lobby: lobby === null ? null : { id: lobby.id, mode: lobby.mode, seats: [...lobby.seats.values()],
        startingQueens: lobby.start === null ? null : [...lobby.start.startingQueens()] },
      notPlayed: this.notPlayed === null ? null : { lobbyId: this.notPlayed.lobbyId, identities: [...this.notPlayed.identities] },
    };
    // A deep copy: the live state, records and event histories keep changing after this returns.
    return structuredClone(save);
  }

  /**
   * Handover resume: installs a saved match as this game's next match and seats its lobby,
   * with no header or other log line; the next tick() applies tick save.tick. The save is not changed.
   */
  resumeMatch(save: GameSave): void {
    if (this.current !== null && this.current.state.result === null) throw new Error("a match is already running");
    if (save.phase === "start") return this.reopenStart(save);
    const seq = (this.current?.seq ?? 0) + 1;
    const restored = structuredClone(save);
    const state: SimState = { ...restored.state };
    prepareInitialPointRests(state);
    this.retireRecordsBefore(seq);
    this.previous = this.current;
    this.current = { seq, seed: restored.seed, state,
      pending: restored.startJoins.map(input => ({ input, settle: () => {}, refuse: () => {}, startJoin: true as const })) };
    this.houseActivity.clear();
    for (const [agentId, tick] of restored.houseActivity) this.houseActivity.set(agentId, tick);
    this.next = null;
    this.starting = null;
    const lobby = restored.lobby;
    this.lobby = lobby === null ? null : { id: lobby.id, mode: lobby.mode, seats: new Map(lobby.seats.map(seat => [seatKeyOf(seat), seat])),
      notPlayed: false, matchSeq: seq, start: lobby.startingQueens === null ? null : finishedStart(new Map(lobby.startingQueens)) };
    this.notPlayed = restored.notPlayed === null ? null : { lobbyId: restored.notPlayed.lobbyId, identities: new Set(restored.notPlayed.identities) };
    this.restoreRecords(restored.records, seq);
    this.restoreHeldReplies(restored.replies, seq);
  }

  /**
   * Slot servers: the seated lobby's begun match while its nest-pick window is open, before its
   * first tick: the lobby, the seed its match starts from and when the window closes;
   * null otherwise. The server finishes the window at closesAt, as after beginLobbyStart.
   */
  get openStart(): { readonly lobbyId: string; readonly seed: number; readonly closesAt: number } | null {
    const lobby = this.lobby, starting = this.starting;
    return lobby === null || starting === null || lobby.notPlayed || lobby.matchSeq !== null ? null
      : { lobbyId: lobby.id, seed: starting.seed, closesAt: starting.window.closesAt };
  }

  /** Handover save of an open start: its window and picks, and the seats queued for its first tick. */
  private saveStart(): StartGameSave {
    const lobby = this.lobby!, starting = this.starting!;
    const seq = (this.current?.seq ?? 0) + 1;
    const records = [...this.records.values()]
      .filter(rec => rec.matchSeq === seq && rec.seatKey !== null && rec.seatKey.startsWith(`${lobby.id}/`) && rec.finalResult.notPlayed !== true)
      .map(savedRecord);
    const save: StartGameSave = {
      format: GAME_SAVE_FORMAT, phase: "start", seed: starting.seed, tick: 0, start: starting.window.save(this.now()), records, replies: this.heldRepliesOf(seq),
      lobby: { id: lobby.id, mode: lobby.mode, seats: [...lobby.seats.values()], startingQueens: null },
      notPlayed: this.notPlayed === null ? null : { lobbyId: this.notPlayed.lobbyId, identities: [...this.notPlayed.identities] },
    };
    // A deep copy: the window and the queued seats' records keep changing after this returns.
    return structuredClone(save);
  }

  /**
   * Handover resume of an open start: seats its lobby and opens its pick window again now,
   * with the picks made so far and the time it had left, and queues its joined seats for the first
   * tick. Its seats cannot join until this server adopts it, so activateResumedStart opens the window
   * again then, with that same time left. The save is not changed.
   */
  private reopenStart(save: StartGameSave): void {
    if (this.slot === undefined) throw new Error("No slot to seat the saved lobby on");
    const restored = structuredClone(save);
    const window = LobbyStart.reopen(restored.seed, restored.start, this.now());
    const seq = (this.current?.seq ?? 0) + 1;
    this.lobby = { id: restored.lobby.id, mode: restored.lobby.mode, seats: new Map(restored.lobby.seats.map(seat => [seatKeyOf(seat), seat])),
      notPlayed: false, matchSeq: null, start: null };
    this.starting = { seed: restored.seed, window };
    this.notPlayed = restored.notPlayed === null ? null : { lobbyId: restored.notPlayed.lobbyId, identities: new Set(restored.notPlayed.identities) };
    this.restoreRecords(restored.records, seq);
    this.restoreHeldReplies(restored.replies, seq);
    this.restoredStartMs = restored.start.remainingMs;
    this.setNextStart({ kind: "scheduled", at: new Date(window.closesAt) });
  }

  /**
   * Handover resume of an open start, once this server has adopted it: its window opens
   * again now with the picks it holds and the time it had left when saved, so neither the restore nor
   * the adoption takes any of the seats' pick time; the server finishes it at the closesAt returned.
   * Null when no restored start awaits activation.
   */
  activateResumedStart(): { readonly lobbyId: string; readonly seed: number; readonly closesAt: number } | null {
    const remainingMs = this.restoredStartMs, starting = this.starting, lobby = this.lobby;
    this.restoredStartMs = null;
    if (remainingMs === null || starting === null || lobby === null) return null;
    const now = this.now();
    const window = LobbyStart.reopen(starting.seed, { ...starting.window.save(now), remainingMs }, now);
    this.starting = { seed: starting.seed, window };
    this.setNextStart({ kind: "scheduled", at: new Date(window.closesAt) });
    return { lobbyId: lobby.id, seed: starting.seed, closesAt: window.closesAt };
  }

  /** Saved agent records, in their saved order, as records of match seq here. */
  private restoreRecords(records: readonly SavedAgentRecord[], seq: number): void {
    for (const saved of records) {
      const { lastSquad, cellSnapshot, callTimes, events, priorityEvents, finalResult, appliedCalls, ...fields } = saved;
      const rec: AgentRecord = { ...fields, colony: saved.colony, colonyNames: this.seatColonyNames(saved.seatKey), matchSeq: seq, callTimes: [...callTimes], events: [...events],
        priorityEvents: [...priorityEvents], finalResult: { ...finalResult }, lastSquad: lastSquad === null ? null : new Set(lastSquad),
        appliedCalls: [...appliedCalls],
        cellSnapshot: cellSnapshot === null ? null : { ...cellSnapshot, offsets: new Set(cellSnapshot.offsets) } };
      this.records.set(rec.agentId, rec);
      this.byToken.set(rec.token, rec);
      if (rec.seatKey !== null) this.bySeat.set(rec.seatKey, rec);
    }
  }

  /**
   * Rules 27: a seated lobby seat's join, queued or live, carries the starting
   * queen its lobby's pick window gave that seat, which its agent owns. Every other join
   * is joinInput unchanged.
   */
  private seatJoinInput(rec: AgentRecord): Extract<SimInput, { type: "join" }> {
    const lobby = this.lobby;
    const queenId = rec.seat === null || lobby === null || rec.seatKey !== `${lobby.id}/${rec.seat.key}`
      ? undefined : lobby.start?.queenIdOf(rec.seat.key);
    return { ...joinInput(rec), ...(queenId === undefined ? {} : { queenId }) };
  }

  /** Whether a queued record joins match seq; on a slot server only the seated lobby's own playable seats do. */
  private joinsAt(rec: AgentRecord, seq: number): boolean {
    if (rec.matchSeq !== seq) return false;
    if (rec.seatKey === null) return true;
    return !rec.finalResult.notPlayed && this.lobby !== null && rec.seatKey.startsWith(`${this.lobby.id}/`);
  }

  /** Advance the current match one tick with the calls that arrived since the last. Null when no match is running. */
  tick(stopNow = false): StepOutput | null {
    const m = this.current;
    if (m === null || m.state.result !== null || this.stoppedAt !== null) return null;
    this.handOnHeldReplies(m.seq);
    // One idle rule for every live match: the logged houseActive policy
    // retires command-idle takeover, and the accepted-call clock ends the match.
    const pending = m.pending;
    m.pending = [];
    const tick = m.state.tick;
    try {
      return this.advanceMatch(m, pending, tick, stopNow);
    } catch (err) {
      return this.abandonFailedTick(m, pending, tick, err);
    }
  }

  /**
   * A tick that threw advances the match in place, so its state may be partly applied: the match ends here
   * abandoned, which no lobby, recording or rating counts. Its
   * waiting calls are answered match_not_played and the failed tick writes no log line. The terminal output
   * carries match_end, so the server's normal end path stops the timer and publishes the end; the end frame
   * shows the partly-applied state. Logged with the match, tick and error only, never match state.
   */
  private abandonFailedTick(m: Match, pending: readonly Pending[], tick: number, err: unknown): StepOutput {
    console.error(`antwar match ${m.seq} tick ${tick} failed in tick: ${failureSummary(err)}; match ended abandoned and unrated`);
    for (const p of pending) p.refuse(adapterError("match_not_played", null));
    const result: MatchResult = { winner: null, reason: "abandoned", decidedBy: "draw", tick };
    m.state.result = result;
    for (const rec of this.records.values()) {
      if (rec.matchSeq === m.seq) rec.finalResult.result = result;
    }
    return { state: m.state, events: [{ type: "match_end", tick, result }], results: [] };
  }

  private advanceMatch(m: Match, pending: readonly Pending[], tick: number, stopNow: boolean): StepOutput {
    const house = this.isRatedHouse(m.seq);
    const inputs = pending.map((p) => p.input);
    const idleTicks = this.houseIdleSeconds * m.state.config.ticksPerSecond;
    const isIdle = (agent: Agent) => tick - (this.houseActivity.get(agent.id) ?? agent.joinedTick ?? 0) >= idleTicks;
    // The tick advances the match in place. An idle end re-runs it from its start state,
    // so keep a copy only when an idle end is possible: a seat already at its deadline
    // before this tick's calls (calls only move a seat's activity later), a seat joining
    // this tick, a lobby seat that has not joined, or no idle allowance at all.
    // A lobby seat that never joins ends the match abandoned, unrated, in every lobby mode: at its deadline,
    // counted from match start (tick 0) since it has no join tick, or at any earlier natural end. Until then
    // (at most the idle limit) each tick keeps a copy, since a natural end cannot be known in advance.
    const seated = !stopNow && this.isSeatedLobby(m.seq);
    const start = !stopNow && (idleTicks <= 0 || inputs.some((input) => input.type === "join") || m.state.agents.some(isIdle)
      || (seated && this.lobbySeatMissing(m.state)))
      ? cloneState(m.state) : null;
    let terminal: ServerTerminal = stopNow;
    let out = advance(m.state, inputs, undefined, undefined, undefined, terminal, true);
    pending.forEach((call, index) => {
      if (call.countsAsHouseActivity !== false && out.results[index]?.ok) this.houseActivity.set(call.input.agentId, tick);
    });
    // Settle accepted calls first: an observe arriving on the deadline tick
    // counts, but a refused command or synthetic error-observe cannot save it.
    // Likewise a lobby seat whose join is accepted on its deadline tick has joined.
    const idle = [...new Set(out.state.agents.filter(isIdle).map(agent => agent.colony))].sort();
    const absent = seated && (tick >= idleTicks || out.state.result !== null) ? this.lobbyAbsentColonies(out.state) : [];
    const neverJoined = absent.length > 0;
    if (!stopNow && (neverJoined || idle.length > 0)) {
      if (start === null) throw new Error(`match ${m.seq} tick ${tick}: idle end without its start state`);
      // The Model Index abandons, unrated, and so does any lobby match with a seat that never joined;
      // every other match: the idle colony loses, both idle draw.
      terminal = house || neverJoined ? "abandoned" : { idle };
      out = advance(start, inputs, undefined, undefined, undefined, terminal, true);
      if (neverJoined) m.absentColonies = absent;
    }
    this.onLogLine(tickLine(tick, inputs, terminal, true));
    m.state = out.state;
    if (out.state.result !== null) {
      for (const rec of this.records.values()) {
        if (rec.matchSeq === m.seq) rec.finalResult.result = out.state.result;
      }
    }
    pending.forEach((p, i) => {
      const result = out.results[i];
      if (result !== undefined) {
        this.retainEvents(p.input.agentId, result.view);
        const identityId = this.records.get(p.input.agentId)?.identityId;
        if (result.ok && identityId && this.slot?.recordJoin && (p.input.type === "join" || p.input.type === "rejoin")) {
          this.joinActivity.add({ identityId, at: this.now(), acknowledge: () => p.settle(result) });
        } else {
          p.settle(result);
        }
      }
    });
    this.flushJoinActivity();
    return out;
  }

  async join(req: JoinRequest): Promise<JoinOutcome> {
    if (req.token !== undefined) {
      const rec = this.byToken.get(req.token);
      if (rec === undefined) return { agentId: null, token: null, config: this.simConfig, outcome: adapterError("unknown_token", null) };
      return { agentId: rec.agentId, token: rec.token, config: this.configFor(rec), outcome: await this.call(rec.agentId, { type: "rejoin", agentId: rec.agentId }) };
    }
    const live = this.current !== null && this.current.state.result === null;
    const seq = live ? this.current!.seq : (this.current?.seq ?? 0) + 1;
    let count = 0;
    for (const r of this.records.values()) if (r.matchSeq === seq) count += 1;
    // Admission is synchronous, before issuing a token or waiting for a tick.
    // Project earlier pending/queued joins with exactly the sim's placement rule.
    if (req.colony !== undefined && this.joinCounts(seq)[req.colony] >= agentsPerColony(this.mcpConfig)) {
      return { agentId: null, token: null, config: this.simConfig, outcome: adapterError("colony_full", null) };
    }
    if (count >= this.mcpConfig.maxAgentsPerMatch) {
      return { agentId: null, token: null, config: this.simConfig, outcome: adapterError("agent_cap", null) };
    }
    const rec = this.newRecord(seq, { displayName: req.displayName ?? null, modelLabel: req.modelLabel ?? null, thinkingLevel: req.thinkingLevel ?? null, serviceTier: null, colony: req.colony, seat: null, seatKey: null, identityId: null });
    const outcome: Outcome = live ? await this.submit(this.current!, joinInput(rec)) : { kind: "queued", nextStart: this.next };
    return { agentId: rec.agentId, token: rec.token, config: this.configFor(rec), outcome };
  }

  private newRecord(
    matchSeq: number,
    fields: Pick<AgentRecord, "displayName" | "modelLabel" | "thinkingLevel" | "serviceTier" | "colony" | "seat" | "seatKey" | "identityId">,
  ): AgentRecord {
    const rec: AgentRecord = {
      agentId: randomUUID(),
      token: randomUUID(),
      matchSeq,
      houseMatch: fields.seatKey !== null && this.lobby?.mode?.startsWith("house-") === true,
      colonyNames: this.seatColonyNames(fields.seatKey),
      ...fields,
      callTimes: [this.now()],
      finalResult: { result: null },
      events: [],
      lastSquad: null,
      broodVoteLost: false,
      eventCursor: 0,
      currentEventCursor: 0,
      priorityEvents: [],
      cellSnapshot: null,
      appliedCalls: [],
    };
    this.records.set(rec.agentId, rec);
    this.byToken.set(rec.token, rec);
    return rec;
  }

  /** Seating after all earlier joins for this match, without advancing the sim. */
  private joinCounts(seq: number): [number, number] {
    const counts: [number, number] = [0, 0];
    const match = this.current;
    if (match !== null && match.seq === seq) {
      for (const agent of match.state.agents) counts[agent.colony] += 1;
      for (const { input } of match.pending) {
        if (input.type === "join") counts[chooseJoinColony(counts, input)] += 1;
      }
    } else {
      for (const rec of this.records.values()) {
        if (rec.matchSeq === seq) counts[chooseJoinColony(counts, joinInput(rec))] += 1;
      }
    }
    return counts;
  }

  /**
   * One call by a joined agent, and the only place the per-agent rate limit is
   * checked. A call over the limit is refused here: it is not a sim input, so it
   * changes no sim state, adds nothing to the log, keeps no squad timer and
   * leaves the agent's events pending for its next admitted call. A refused call
   * from an agent whose match has ended gets the match-ended error with the winner.
   * With an identity, the call's reply is remembered under its call id if the match applies it.
   */
  async call(agentId: string, input: SimInput, countsAsHouseActivity = true, identity?: CallIdentity): Promise<Outcome> {
    return this.answer(agentId, input, countsAsHouseActivity, identity);
  }

  /** The reply of this seat's applied call with that call id, if it is still remembered. */
  appliedCall(agentId: string, callId: string): CallToolResult | undefined {
    return this.records.get(agentId)?.appliedCalls.find((call) => call.callId === callId)?.reply;
  }

  /**
   * One call by the seat this session plays, as the match recording stores it: a line for that seat's
   * match, at its current tick: a stub (stubLine) when call is always one or the seat is past its recording budget,
   * otherwise its entry after a text line for each served text not yet handed on for that match; handed on
   * at once while the match has begun, held until its first tick while the seat waits for it. A session bound to no
   * seat, or a seat of an earlier match, records nothing. Never throws: a reply that cannot be recorded is answered as
   * usual, and the first such failure of this Game instance is reported (later ones, in any match, are not). build runs
   * only when the call is recorded in full.
   */
  recordReply(agentId: string | null, call: StubCall & { readonly alwaysStub: boolean },
    build: () => { readonly entry: ReplyEntry; readonly texts: readonly ServedText[] }): void {
    try {
      const rec = agentId === null ? undefined : this.records.get(agentId);
      if (rec === undefined || rec.finalResult.notPlayed) return;
      const m = this.current;
      const live = m !== null && rec.matchSeq === m.seq;
      if (!live && rec.matchSeq <= (m?.seq ?? 0)) return;
      const tick = live ? m.state.tick : null;
      // The call's entry and the served text lines before it, or null when the call is a stub.
      let lines: string[] | null = null;
      if (!call.alwaysStub && (live || this.preMatchAllows(rec.matchSeq, rec.agentId)) && this.recordsInFull(rec.agentId, call.answeredAt)) {
        try {
          const { entry, texts } = build();
          // Served text first, once per match: the entries naming its digest follow it.
          lines = [...this.unsentTexts(rec.matchSeq, texts).map(textLine), replyLine(rec.agentId, tick, entry)];
          if (!live) this.heldFull.get(rec.agentId)!.count += 1;
        } catch (error) {
          // A call whose entry cannot be built is still recorded, as a stub. Arguments nested past the stack do not
          // reach here (storedCall drops and names them); only a defect in building the entry does.
          this.reportReplyFailure(error);
        }
      }
      if (live) {
        this.handOnHeldReplies(m.seq);
        for (const line of lines ?? [stubLine(rec.agentId, tick, call)]) this.onReply(m.seq, line);
      } else if (lines !== null) {
        for (const line of lines) this.heldReplies.push({ seq: rec.matchSeq, agentId: rec.agentId, line });
      } else {
        this.holdStub(rec.matchSeq, rec.agentId, call);
      }
    } catch (error) {
      this.reportReplyFailure(error);
    }
  }

  /** Reports a reply recording failure once per Game instance, across all its matches; later failures are not reported. */
  private reportReplyFailure(error: unknown): void {
    if (this.replyFailureReported) return;
    this.replyFailureReported = true;
    console.error(`antwar call reply not recorded in full (later failures are not reported): ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * The seat's recording budget: at most
   * callsPerSecond calls per rolling second are recorded in full, every call taking a place in arrival order, game
   * and account tools alike, apart from the game's own call window so play is unchanged. A call past it is a stub.
   * The one place this choice is made.
   */
  private recordsInFull(agentId: string, at: number): boolean {
    const recent = (this.recordedTimes.get(agentId) ?? []).filter(t => at - t < 1000);
    if (recent.length >= this.mcpConfig.callsPerSecond) {
      this.recordedTimes.set(agentId, recent);
      return false;
    }
    recent.push(at);
    this.recordedTimes.set(agentId, recent);
    return true;
  }

  /** texts not yet handed on for match seq, now marked handed on. Earlier matches' marks are let go. */
  private unsentTexts(seq: number, texts: readonly ServedText[]): readonly ServedText[] {
    if (texts.length === 0) return texts;
    for (const old of this.textsSent.keys()) if (old < (this.current?.seq ?? 0)) this.textsSent.delete(old);
    let sent = this.textsSent.get(seq);
    if (sent === undefined) this.textsSent.set(seq, sent = new Set());
    const fresh = texts.filter(text => !sent.has(text.digest));
    for (const text of fresh) sent.add(text.digest);
    return fresh;
  }

  /** This game's wall clock, in UTC milliseconds: a recorded call's received and answered times. */
  wallClock(): number {
    return this.now();
  }

  /** The pre-match allowance of full entries: the recording budget's rate over the countdown, a poll and the seated lobby's nest pick. */
  private preMatchFullEntries(): number {
    return Math.floor(this.mcpConfig.callsPerSecond * (this.preStartMs + this.nestWindowMs()) / 1000);
  }

  /**
   * The pre-match bound on held stubs: the stub rule's rate (STUBS_PER_WINDOW a second) over the same period, so a stuck
   * or held start holds a fixed number of stubs and the calls past it only raise the closing stub's omitted count.
   */
  private preMatchStubs(): number {
    return Math.floor(STUBS_PER_WINDOW * (this.preStartMs + this.nestWindowMs()) / 1000);
  }

  /** Whether the seat may still record a full entry before match seq begins: fewer than preMatchFullEntries so far. */
  private preMatchAllows(seq: number, agentId: string): boolean {
    let held = this.heldFull.get(agentId);
    if (held === undefined || held.seq !== seq) this.heldFull.set(agentId, held = { seq, count: 0 });
    return held.count < this.preMatchFullEntries();
  }

  /**
   * A stub held before its match begins, under the stub rule the recording applies (keepsStub) and the bound: with the
   * one closing stub kept free, at most preMatchStubs. A held one carries the count of the seat's calls left out since
   * the last one held; a call past the rule or the bound is only counted and remembered, for the closing stub.
   */
  private holdStub(seq: number, agentId: string, call: StubCall): void {
    let seat = this.heldStubs.get(agentId);
    if (seat === undefined || seat.seq !== seq) this.heldStubs.set(agentId, seat = { seq, kept: [], omitted: 0, last: null, held: 0 });
    if (seat.held >= this.preMatchStubs() - 1 || !keepsStub(seat, call.answeredAt)) {
      seat.omitted += 1;
      seat.last = { tool: call.tool, receivedAt: call.receivedAt, answeredAt: call.answeredAt, code: call.code };
      return;
    }
    this.heldReplies.push({ seq, agentId, line: stubLine(agentId, null, call, seat.omitted === 0 ? undefined : seat.omitted) });
    seat.held += 1;
    seat.omitted = 0;
    seat.last = null;
  }

  /** The held reply lines of match seq, in order, to the recording; none are held for it afterwards. */
  private handOnHeldReplies(seq: number): void {
    if (this.heldReplies.length === 0 && this.heldStubs.size === 0) return;
    const lines = this.heldRepliesOf(seq);
    this.heldReplies = this.heldReplies.filter(held => held.seq !== seq);
    for (const [agentId, seat] of this.heldStubs) if (seat.seq === seq) this.heldStubs.delete(agentId);
    for (const { line } of lines) this.onReply(seq, line);
  }

  /**
   * Match seq's held reply lines, in order, then for each seat with calls left out since its last held stub, its last
   * such call as a stub counting the rest, marked closing so a save's resume holds it as still open rather than as one
   * more held stub: only seats still of that match, so a lobby not played leaves none for the next.
   */
  private heldRepliesOf(seq: number): { agentId: string; line: string; closing?: true }[] {
    const playing = (agentId: string) => this.records.has(agentId) && this.records.get(agentId)!.finalResult.notPlayed !== true;
    const closing = [...this.heldStubs].filter(([agentId, seat]) => seat.seq === seq && seat.last !== null && playing(agentId))
      .map(([agentId, seat]) => ({ agentId, line: stubLine(agentId, null, seat.last!, seat.omitted === 1 ? undefined : seat.omitted - 1), closing: true as const }));
    return [...this.heldReplies.filter(held => held.seq === seq && playing(held.agentId)).map(({ agentId, line }) => ({ agentId, line })), ...closing];
  }

  /**
   * A save's held lines held again for match seq. A closing stub is the seat's calls still left out: held open again,
   * its call the last of them and its count theirs, so a later save or the first tick closes them once, in one stub,
   * however many handovers the start crosses.
   */
  private restoreHeldReplies(held: readonly { readonly agentId: string; readonly line: string; readonly closing?: true }[] | undefined, seq: number): void {
    const open = (held ?? []).filter(entry => entry.closing !== true);
    this.heldReplies = [...this.heldReplies.filter(entry => entry.seq !== seq), ...open.map(({ agentId, line }) => ({ seq, agentId, line }))];
    for (const [agentId, seat] of this.heldStubs) if (seat.seq === seq) this.heldStubs.delete(agentId);
    // The pre-match allowance and stub bound already spent travel as the restored entries and stubs.
    for (const [agentId, seat] of this.heldFull) if (seat.seq === seq) this.heldFull.delete(agentId);
    const heldStub = (agentId: string) => {
      let seat = this.heldStubs.get(agentId);
      if (seat === undefined) this.heldStubs.set(agentId, seat = { seq, kept: [], omitted: 0, last: null, held: 0 });
      return seat;
    };
    for (const { agentId, line } of (held ?? []).filter(entry => entry.closing === true)) {
      const stub = JSON.parse(line) as StubCall & { readonly omitted?: number };
      const seat = heldStub(agentId);
      seat.omitted = 1 + (stub.omitted ?? 0);
      seat.last = { tool: stub.tool, receivedAt: stub.receivedAt, answeredAt: stub.answeredAt, code: stub.code };
    }
    for (const { agentId, line } of open) {
      if (line.startsWith('{"type":"stub",')) {
        heldStub(agentId).held += 1;
        continue;
      }
      if (!line.startsWith('{"type":"reply",')) continue;
      const count = this.heldFull.get(agentId);
      if (count === undefined) this.heldFull.set(agentId, { seq, count: 1 });
      else count.count += 1;
    }
  }

  private rememberApplied(agentId: string, callId: string, reply: CallToolResult): void {
    this.records.get(agentId)?.appliedCalls.push({ callId, reply });
  }

  /** No extra store or retention: a bound session may hold this small receipt after record cleanup. */
  finalResultReceipt(agentId: string): FinalResultReceipt | undefined {
    return this.records.get(agentId)?.finalResult;
  }

  /** Bound by the server-owned agent record; never accepts an agent from the cursor. */
  cellsFor(view: AgentView, config: SimConfig, cursor?: string, replace = true): { snapshot: CellSnapshot; offset: number } | null {
    const rec = this.records.get(view.agentId);
    if (rec === undefined || rec.finalResult.notPlayed) return null;
    if (cursor === undefined) {
      if (!replace && rec.cellSnapshot !== null) return { snapshot: rec.cellSnapshot, offset: 0 };
      const snapshot = captureCells(view, config);
      rec.cellSnapshot = snapshot;
      return { snapshot, offset: 0 };
    }
    const snapshot = rec.cellSnapshot;
    if (snapshot === null) return null;
    const offset = cellOffset(snapshot, cursor);
    return offset === null ? null : { snapshot, offset };
  }

  /** Validation only; an invalid pagination request must not refresh house activity. */
  validCellsCursor(agentId: string, cursor?: string): boolean {
    if (cursor === undefined) return true;
    const snapshot = this.records.get(agentId)?.cellSnapshot;
    return snapshot != null && cellOffset(snapshot, cursor) !== null;
  }

  /** History is scoped by the server-bound agent, never by a caller-supplied seat. */
  eventHistory(agentId: string): readonly ObserveEvent[] {
    return this.records.get(agentId)?.events ?? [];
  }

  eventCursor(agentId: string): number {
    return this.records.get(agentId)?.eventCursor ?? 0;
  }

  acknowledgeEvents(agentId: string, cursor: number): void {
    const rec = this.records.get(agentId);
    if (rec !== undefined) rec.eventCursor = Math.max(rec.eventCursor, cursor);
  }

  currentEventCursor(agentId: string): number {
    return this.records.get(agentId)?.currentEventCursor ?? 0;
  }

  pendingPriorityEvents(agentId: string): readonly number[] {
    return this.records.get(agentId)?.priorityEvents ?? [];
  }

  /** Sampling never acknowledges history; priorities leave the queue only when sent. */
  acknowledgeCurrentEvents(agentId: string, cursor: number, priorityCount: number): void {
    const rec = this.records.get(agentId);
    if (rec !== undefined) {
      rec.currentEventCursor = Math.max(rec.currentEventCursor, cursor);
      rec.priorityEvents.splice(0, priorityCount);
    }
  }

  private retainEvents(agentId: string, view: AgentView | null): void {
    const rec = this.records.get(agentId);
    if (rec !== undefined && view !== null) {
      const retain = (event: ObserveEvent): void => {
        if (event.type === "squad_replaced"
          || ((event.type === "queen_founded" || event.type === "queen_lost") && event.colony === view.colony)
          || ((event.type === "mark_laid" || event.type === "count_mark_accepted") && event.agentId === agentId)) {
          rec.priorityEvents.push(rec.events.length);
        }
        rec.events.push(event);
      };
      // No spread: a long offline backlog must not overflow the argument stack.
      for (const event of view.events) retain(event);
      if (view.squad.length > 0) {
        if (rec.lastSquad !== null && view.squad.every(ant => !rec.lastSquad!.has(ant.antId))) {
          retain({ type: "squad_replaced", tick: view.tick, agentId, colony: view.colony });
        }
        rec.lastSquad = new Set(view.squad.map(ant => ant.antId));
      }
    }
  }

  private async answer(agentId: string, input: SimInput, countsAsHouseActivity: boolean, identity: CallIdentity | undefined): Promise<Outcome> {
    const rec = this.records.get(agentId);
    if (rec === undefined) return { kind: "error", code: "unknown_agent", view: null };
    // A replaced or failed slot match is not played, even if it had reached a result.
    if (rec.finalResult.notPlayed) return adapterError("match_not_played", null);
    const where = this.locate(rec);
    const retryAfterMs = this.overRate(rec);
    const state = where.kind === "queued" ? null : where.match?.state ?? null;
    const observe = input.type === "observe" ? { observeInfo: this.observeInfoForAgent(agentId) } : {};
    if (retryAfterMs !== null) {
      const agent = state?.agents.find(a => a.id === agentId);
      const tick = state?.tick ?? null;
      const nextCommandTick = state === null || agent === undefined || where.kind === "ended" ? null
        : agent.lastCommandTick === null ? state.tick : Math.max(state.tick, agent.lastCommandTick + state.config.commandFloorTicks);
      return { kind: "error", code: "call_rate", view: null, timing: { tick, nextCommandTick, retryAfterMs },
        ...(where.kind === "ended" ? { result: where.match?.state.result ?? null } : {}), ...observe };
    }
    if (where.kind === "queued") return input.type === "observe" || input.type === "rejoin" ? { kind: "queued", nextStart: this.next, ...observe } : adapterError("not_started", null);
    if (where.kind === "ended") {
      if (where.match === null) return { kind: "error", code: "match_over", view: null, ...observe };
      // The sim answers every call after the end with match_over and a view carrying the winner. After the end
      // step only takes views, so keeping its state advances nothing but marks the agent's events delivered.
      const out = step(where.match.state, [input]);
      where.match.state = out.state;
      const result = out.results[0];
      if (result !== undefined) this.retainEvents(agentId, result.view);
      if (input.type === "observe" && result?.view != null) return { kind: "view", view: result.view, ...observe };
      return result === undefined ? { kind: "error", code: "match_over", view: null } : toOutcome(result);
    }
    return this.submit(where.match, input, countsAsHouseActivity, identity);
  }

  private isRatedHouse(seq: number): boolean {
    return this.lobby?.matchSeq === seq && this.lobby.mode?.startsWith("house-") === true;
  }

  /** The seated lobby plays match seq, in any mode: ranked, Model Index, house challenge or unranked. */
  private isSeatedLobby(seq: number): boolean {
    const lobby = this.lobby;
    return lobby !== null && lobby.matchSeq === seq;
  }

  /** Whether any seat of the seated lobby has no agent in this match state: it has never joined the match. */
  private lobbySeatMissing(state: SimState): boolean {
    return this.lobbyAbsentColonies(state).length > 0;
  }

  /** The colonies of the seated lobby with a seat that has no agent in this match state, ascending. */
  private lobbyAbsentColonies(state: SimState): ColonyId[] {
    const lobby = this.lobby;
    if (lobby === null) return [];
    const absent = new Set<ColonyId>();
    for (const [key, seat] of lobby.seats) {
      const rec = this.bySeat.get(`${lobby.id}/${key}`);
      if (rec === undefined || !state.agents.some(agent => agent.id === rec.agentId)) absent.add(seat.colony);
    }
    return [...absent].sort((a, b) => a - b);
  }

  /** Authoritative accepted-call idle clock of the live match; internal ids never enter the wire. */
  spectatorHouseIdle(seq: number): { readonly idleTicks: number; readonly activityTick: (agentId: string) => number | undefined } | undefined {
    if (this.current?.seq !== seq) return undefined;
    return { idleTicks: this.houseIdleSeconds * this.current.state.config.ticksPerSecond,
      activityTick: agentId => this.current?.seq !== seq ? undefined
        : this.houseActivity.get(agentId) ?? this.current.state.agents.find(agent => agent.id === agentId)?.joinedTick };
  }

  observeInfoForAgent(agentId: string): ObserveInfo {
    const rec = this.records.get(agentId);
    const where = rec === undefined ? null : this.locate(rec);
    const state = where === null || where.kind === "queued" ? null : where.match?.state ?? null;
    const config = rec === undefined ? this.undrawnConfig : this.configFor(rec);
    const base = observeInfo(state, agentId, config);
    if (rec === undefined) return base;
    const agent = state?.agents.find(agent => agent.id === agentId);
    const since = this.houseActivity.get(agentId) ?? agent?.joinedTick ?? 0;
    const left = state === null || agent === undefined || state.result !== null ? null
      : Math.max(0, Math.ceil(this.houseIdleSeconds - (state.tick - since) / config.ticksPerSecond));
    // An accepted set_brood refreshes this house-activity timer, never the command-idle one.
    const brood = config.castes !== undefined ? ["set_brood"] : [];
    const resets = [...new Set([...base.status[1].split(" "), ...brood, "observe", "rules", "join"])].join(" ");
    return { houseIdleSeconds: this.houseIdleSeconds,
      status: base.status[2] === undefined ? [left, resets] : [left, resets, base.status[2]] };
  }

  /**
   * The colony names a seat's match uses: an unrated lobby's drawn pair, otherwise COLONY_NAMES
   * (rated lobbies and matches outside a lobby).
   */
  private seatColonyNames(seatKey: string | null): ColonyNamePair {
    const lobby = this.lobby;
    return seatKey === null || lobby === null || !seatKey.startsWith(`${lobby.id}/`) ? COLONY_NAMES : lobbyColonyNames(lobby.id, lobby.mode !== null);
  }

  /** Unjoined callers see the seated lobby's names (COLONY_NAMES outside a lobby); joined callers keep their own match's. */
  colonyNames(agentId: string | null = null): ColonyNamePair {
    if (agentId !== null) {
      const rec = this.records.get(agentId);
      if (rec !== undefined) return rec.colonyNames;
    }
    const lobby = this.lobby;
    return lobby === null ? COLONY_NAMES : lobbyColonyNames(lobby.id, lobby.mode !== null);
  }

  /** Unjoined callers see the slot mode; joined callers retain their own mode. */
  isHouseMatch(agentId: string | null = null): boolean {
    return agentId === null ? this.lobby?.mode?.startsWith("house-") === true
      : this.records.get(agentId)?.houseMatch === true;
  }

  configForAgent(agentId: string): SimConfig {
    const rec = this.records.get(agentId);
    return rec === undefined ? this.undrawnConfig : this.configFor(rec);
  }

  /** Whether the config this agent reads is its match's drawn map (a match or an open start
   * window), rather than the rotation before the seed draws one. */
  mapDrawnFor(agentId: string | null): boolean {
    const rec = agentId === null ? undefined : this.records.get(agentId);
    if (rec === undefined) return false;
    const where = this.locate(rec);
    return where.kind === "queued" || where.match === null ? this.starting !== null : true;
  }

  private configFor(rec: AgentRecord): SimConfig {
    const where = this.locate(rec);
    return where.kind === "queued" || where.match === null ? (this.starting?.window.config ?? this.undrawnConfig) : where.match.state.config;
  }

  private locate(rec: AgentRecord): { kind: "live"; match: Match } | { kind: "queued" } | { kind: "ended"; match: Match | null } {
    const m = this.current;
    if (m !== null && rec.matchSeq === m.seq) return m.state.result === null ? { kind: "live", match: m } : { kind: "ended", match: m };
    if (rec.matchSeq > (m?.seq ?? 0)) return { kind: "queued" };
    return { kind: "ended", match: this.previous !== null && this.previous.seq === rec.matchSeq ? this.previous : null };
  }

  /** Sliding one-second window of admitted calls; a refusal never records another call. */
  private overRate(rec: AgentRecord): number | null {
    const now = this.now();
    rec.callTimes = rec.callTimes.filter((t) => now - t < 1000);
    if (rec.callTimes.length >= this.mcpConfig.callsPerSecond) return Math.ceil(1000 - (now - rec.callTimes[0]!));
    rec.callTimes.push(now);
    return null;
  }

  private submit(match: Match, input: SimInput, countsAsHouseActivity = true, identity?: CallIdentity): Promise<Outcome> {
    // Stopped for a handover save: the match takes no further input on this server.
    if (this.stoppedAt !== null) return Promise.resolve(this.notApplied());
    return new Promise((resolve) => {
      match.pending.push({ input, countsAsHouseActivity, settle: result => {
        // tick() has installed this exact state; capture before resolving any async caller.
        const info = input.type === "observe" ? this.observeInfoForAgent(input.agentId) : undefined;
        const outcome: Outcome = { ...toOutcome(result), ...(info === undefined ? {} : { observeInfo: info }) };
        // Remembered inside the tick, so a save taken at the next tick boundary already carries it.
        if (identity !== undefined && result.ok) this.rememberApplied(input.agentId, identity.callId, identity.reply(outcome));
        resolve(outcome);
      }, refuse: resolve });
      this.onInputQueued();
    });
  }
}

/** No view-taking, event consumption, timer reset or opponent map disclosure. */
export function observeInfo(state: SimState | null, agentId: string, config: SimConfig): ObserveInfo {
  // Rules 27 names mark only where the mark tool exists.
  const mark = config.wordMarksDisabled === true ? [] : ["mark"];
  const commands = ["order", ...mark, ...(config.countMarks === undefined ? [] : ["count_mark"]), ...(config.queenFounding === undefined ? [] : ["found_queen"])];
  const commandIdle = config.commandIdleTicks !== undefined;
  const agent = state?.agents.find(a => a.id === agentId);
  const since = agent === undefined ? null : commandIdle
    ? agent.lastCommandTick ?? agent.joinedTick ?? agent.lastCallTick : agent.lastCallTick;
  const ticks = state === null || since === null ? null
    : Math.max(0, (config.commandIdleTicks ?? config.squadTimerTicks) - (state.tick - since));
  let enemyTiles = 0;
  if (state !== null && agent !== undefined && config.rules === "redesign") {
    for (const owner of state.owner) if (owner === 1 - agent.colony) enemyTiles += 1;
  }
  const secondsLeft = state?.result != null ? null : agent?.idle ? 0 : ticks === null ? null : Math.ceil(ticks / config.ticksPerSecond);
  const resets = (commandIdle ? commands : [...commands, "observe", "rules", "join"]).join(" ");
  return {
    status: state === null || agent === undefined || config.rules !== "redesign"
      ? [secondsLeft, resets]
      : [secondsLeft, resets, Math.trunc(enemyTiles * 1000 / (config.mapWidth * config.mapHeight))],
  };
}

function savedRecord(rec: AgentRecord): SavedAgentRecord {
  return {
    agentId: rec.agentId, token: rec.token, houseMatch: rec.houseMatch, displayName: rec.displayName, modelLabel: rec.modelLabel,
    thinkingLevel: rec.thinkingLevel, serviceTier: rec.serviceTier, ...(rec.colony === undefined ? {} : { colony: rec.colony }), seat: rec.seat,
    callTimes: rec.callTimes, finalResult: rec.finalResult, seatKey: rec.seatKey, identityId: rec.identityId,
    events: rec.events, lastSquad: rec.lastSquad === null ? null : [...rec.lastSquad], broodVoteLost: rec.broodVoteLost,
    eventCursor: rec.eventCursor, currentEventCursor: rec.currentEventCursor, priorityEvents: rec.priorityEvents,
    cellSnapshot: rec.cellSnapshot === null ? null : { ...rec.cellSnapshot, offsets: [...rec.cellSnapshot.offsets] },
    appliedCalls: rec.appliedCalls,
  };
}

function joinInput(rec: AgentRecord): Extract<SimInput, { type: "join" }> {
  return {
    type: "join",
    agentId: rec.agentId,
    ...(rec.colony === undefined ? {} : { colony: rec.colony }),
    ...(rec.seat === null ? {} : { placement: rec.seat.colony }),
    ...(rec.modelLabel === null ? {} : { modelLabel: rec.modelLabel }),
    ...(rec.thinkingLevel === null ? {} : { thinkingLevel: rec.thinkingLevel }),
    ...(rec.serviceTier === null ? {} : { serviceTier: rec.serviceTier }),
  };
}

function toOutcome(result: InputResult): Outcome {
  if (result.ok) return result.broodSet === undefined ? { kind: "view", view: result.view } : { kind: "view", view: result.view, broodSet: result.broodSet };
  return { kind: "error", code: result.error.code, simMessage: result.error.message, view: result.view,
    ...(result.error.nearestTile === undefined ? {} : { nearestTile: result.error.nearestTile }) };
}

function adapterError(code: AdapterErrorCode, view: AgentView | null): Outcome {
  return { kind: "error", code, view };
}
