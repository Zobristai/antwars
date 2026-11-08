/// <reference types="node" />
import { gunzipSync, gzipSync } from "node:zlib";
import type { AppliedCall, LineupSeat, LobbySeat, ObserveEvent } from "../mcp/game.js";
import type { SavedStart } from "../mcp/lobbyStart.js";
import type { RankedMode } from "../rating/ratings.js";
import { parseHoldBehaviour, type HoldBehaviour } from "../sim/holdBehaviour.js";
import type { ColonyId, MatchResult, SimInput, SimState } from "../sim/types.js";
import type { ViewCell } from "../sim/view.js";

/**
 * A begun match as Game.saveMatch captures it for a handover: everything Game needs to
 * resume it at the same tick, as plain data. Process-owned continuations (pending calls, join-activity
 * acknowledgements, MCP sessions) are not part of it. A match whose nest-pick window is still open,
 * before its first tick, is a start save; any later one is a match save.
 */
export type GameSave = MatchGameSave | StartGameSave;

/** A running match, saved at a tick boundary. */
export interface MatchGameSave {
  readonly format: typeof GAME_SAVE_FORMAT;
  readonly phase: "match";
  readonly seed: number;
  /** state.tick: the next tick() of the resumed match applies this tick. */
  readonly tick: number;
  /** The replay hold behaviour, which the config carries in a Symbol that JSON drops. */
  readonly holdBehaviour: HoldBehaviour;
  readonly state: SimState;
  /** Joins startMatch queued for the match's first tick and not yet applied; empty after tick 0. */
  readonly startJoins: readonly Extract<SimInput, { type: "join" }>[];
  /** Accepted-call idle clock: agent id and tick. */
  readonly houseActivity: readonly (readonly [string, number])[];
  /** The match's agents, in admission order. */
  readonly records: readonly SavedAgentRecord[];
  /** Call reply lines held for the match before its first tick, not yet in its recording; absent in saves that predate them. */
  readonly replies?: readonly HeldReply[];
  /** The seated lobby whose match this is; null for a match without one. */
  readonly lobby: SavedLobby | null;
  /** The last lobby whose match was not played on the saving server. */
  readonly notPlayed: { readonly lobbyId: string; readonly identities: readonly string[] } | null;
}

/** A begun match whose nest-pick window is still open: no tick has been played. */
export interface StartGameSave {
  readonly format: typeof GAME_SAVE_FORMAT;
  readonly phase: "start";
  readonly seed: number;
  /** The resumed match's first tick is tick 0. */
  readonly tick: 0;
  readonly start: SavedStart;
  /** The lobby's seats that have joined, queued for the first tick, in the order they joined. */
  readonly records: readonly SavedAgentRecord[];
  /** Its seats' call reply lines so far, oldest first, for the match recording once it begins; absent in saves that predate them. */
  readonly replies?: readonly HeldReply[];
  readonly lobby: SavedLobby;
  /** The last lobby whose match was not played on the saving server. */
  readonly notPlayed: { readonly lobbyId: string; readonly identities: readonly string[] } | null;
}

export interface SavedAgentRecord {
  readonly agentId: string;
  readonly token: string;
  readonly houseMatch: boolean;
  readonly displayName: string | null;
  readonly modelLabel: string | null;
  readonly thinkingLevel: string | null;
  readonly serviceTier: string | null;
  /** Absent when the join named no colony. */
  readonly colony?: ColonyId;
  readonly seat: LineupSeat | null;
  readonly callTimes: readonly number[];
  readonly sawResult: boolean;
  readonly finalResult: { readonly result: MatchResult | null; readonly notPlayed?: true };
  readonly seatKey: string | null;
  readonly identityId: string | null;
  readonly events: readonly ObserveEvent[];
  readonly lastSquad: readonly number[] | null;
  readonly broodVoteLost: boolean;
  readonly eventCursor: number;
  readonly currentEventCursor: number;
  readonly priorityEvents: readonly number[];
  readonly cellSnapshot: {
    readonly id: string;
    readonly tick: number;
    readonly cells: readonly ViewCell[];
    readonly squadCells: number;
    readonly offsets: readonly number[];
  } | null;
  /** The seat's applied calls with a call id: a repeat on the resuming server gets the original reply. */
  readonly appliedCalls: readonly AppliedCall[];
}

/** One seat's call reply line (src/replays/recording.ts replyLine) held until its match's recording begins. */
export interface HeldReply {
  readonly agentId: string;
  readonly line: string;
  /** The seat's closing stub: its calls still left out when saved, held open again on resume (src/mcp/game.ts). */
  readonly closing?: true;
}

export interface SavedLobby {
  readonly id: string;
  readonly mode: RankedMode | null;
  readonly seats: readonly LobbySeat[];
  /** The finished pick window's starting queen per seat key; null when the match had no pick window. */
  readonly startingQueens: readonly (readonly [string, number])[] | null;
}

export const GAME_SAVE_FORMAT = "antwar.game-save/1";

/**
 * Plain JSON would not read back what a running match holds: it drops a key whose value is undefined,
 * which the simulation sets on ants (so a later write would move the key and change the state hash),
 * writes -0 as 0, and NaN or Infinity as null. Each such value is written as a one-key object instead.
 */
const MARK = "\u0000save";
const MARKED = new Set(["undefined", "-0", "NaN", "Infinity", "-Infinity"]);

function writeValue(_key: string, value: unknown): unknown {
  if (value === undefined) return { [MARK]: "undefined" };
  if (typeof value === "number" && (value === 0 ? Object.is(value, -0) : !Number.isFinite(value))) {
    return { [MARK]: Object.is(value, -0) ? "-0" : String(value) };
  }
  return value;
}

/** The value a marked one-key object stands for. */
function markedValue(object: Record<string, unknown>): unknown {
  const text = object[MARK];
  if (Object.keys(object).length !== 1 || typeof text !== "string" || !MARKED.has(text)) throw new Error("game save holds a malformed value");
  return text === "undefined" ? undefined : Number(text);
}

const isMarked = (value: object): value is Record<string, unknown> => !Array.isArray(value) && Object.hasOwn(value, MARK);

/**
 * Puts every marked value of parsed JSON back, in one pass over it. A JSON.parse reviver would call back for every
 * value, which at a late match's size (tens of megabytes, mostly the seats' event histories) costs the resuming
 * server several seconds of its restore.
 */
function readValues(root: unknown): unknown {
  if (root === null || typeof root !== "object") return root;
  if (isMarked(root)) return markedValue(root);
  const stack: object[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value: unknown = node[i];
        if (value !== null && typeof value === "object") { if (isMarked(value)) node[i] = markedValue(value); else stack.push(value); }
      }
    } else {
      const object = node as Record<string, unknown>;
      for (const key of Object.keys(object)) {
        const value = object[key];
        if (value !== null && typeof value === "object") { if (isMarked(value)) object[key] = markedValue(value); else stack.push(value); }
      }
    }
  }
  return root;
}

/** Gzipped JSON that reads back exactly. */
export function encodeGameSave(save: GameSave): Uint8Array {
  const zipped = gzipSync(JSON.stringify(save, writeValue));
  return new Uint8Array(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}

/** Either phase's fields, any of them missing, as read back before they are checked. */
type ReadSave = Partial<Omit<MatchGameSave, "phase" | "tick" | "lobby">> & Partial<Omit<StartGameSave, "phase" | "tick" | "lobby">>
  & { readonly phase?: unknown; readonly tick?: number; readonly lobby?: SavedLobby | null };

/** Throws on bytes that are not a whole game save of this format. */
export function decodeGameSave(bytes: Uint8Array): GameSave {
  const save = readValues(JSON.parse(gunzipSync(bytes).toString("utf8"))) as ReadSave | null;
  if (save === null || typeof save !== "object" || save.format !== GAME_SAVE_FORMAT) throw new Error(`not a ${GAME_SAVE_FORMAT} game save`);
  if (!Number.isSafeInteger(save.seed) || !Number.isSafeInteger(save.tick) || !Array.isArray(save.records) || save.notPlayed === undefined) {
    throw new Error("game save is incomplete");
  }
  if (save.replies !== undefined && !(Array.isArray(save.replies) && save.replies.every(held =>
    typeof held === "object" && held !== null && typeof held.agentId === "string" && typeof held.line === "string"
    && (held.closing === undefined || held.closing === true)))) {
    throw new Error("game save holds malformed reply lines");
  }
  if (save.phase === "start") {
    const start = save.start;
    if (save.tick !== 0 || typeof save.lobby !== "object" || save.lobby === null || typeof start !== "object" || start === null
      || typeof start.config !== "object" || start.config === null || !Array.isArray(start.seats) || !Array.isArray(start.picks)
      || typeof start.requireAllPicks !== "boolean" || !Number.isFinite(start.closesAt) || !Number.isFinite(start.remainingMs)) {
      throw new Error("game save is incomplete");
    }
    parseHoldBehaviour(start.holdBehaviour);
    return save as StartGameSave;
  }
  if (save.phase !== "match") throw new Error("game save has no known phase");
  parseHoldBehaviour(save.holdBehaviour);
  if (typeof save.state !== "object" || save.state === null || save.state.tick !== save.tick
    || !Array.isArray(save.startJoins) || !Array.isArray(save.houseActivity) || save.lobby === undefined) {
    throw new Error("game save is incomplete");
  }
  return save as MatchGameSave;
}
