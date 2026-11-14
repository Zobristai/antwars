/**
 * The builder post-mortem, served as the match_post_mortem tool on the entry server only: after a match has ended,
 * a seat's owner reads which of that seat's calls were refused, and, for a public match whose re-run reproduces its
 * stored record, which accepted commands had no effect, each with its time.
 *
 * Ownership is proven only by the identity ids the lobby record holds for the match's seats, compared with the
 * identity the presented key resolves to: never by a display name or a time. The key is resolved before anything else
 * is read. A colony whose lobby seats name exactly one identity gives that identity all the colony's record seats; a
 * colony of several identities gives none. Asked by lobby id, every refusal before ownership is proven (an unknown or
 * unreadable lobby, one with no recorded seats, one the caller holds no seat of) is the same ownership refusal. Asked by
 * match id, a match the caller holds no seat of gets the same refusal as one that does not exist, and a match with no
 * recorded seat identity, or whose link to its lobby or whose lobby cannot be read now, is refused as one whose
 * ownership cannot be confirmed. Nothing else is said. Nothing is read from a live match: a match is served only
 * once its delayed playback has finished, so nothing reaches a seat during a match or precedes the spectator delay.
 * Nothing is stored or changed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { addAbortSignal, finished, type Readable, type Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Identities } from "../identity/identities.js";
import type { Lobbies, Lobby } from "../lobby/lobbies.js";
import type { WatchRegistry } from "../live/watch-registry.js";
import { lobbySeats } from "../live/watch-controller.js";
import { payload } from "../mcp/replies.js";
import { isReplayId } from "../replays/access.js";
import { CORRECTED_REPLAY_IDS } from "../replays/correctedRecordings.js";
import { storedIdentity, type HistorySource } from "../replays/history-source.js";
import type { PrivateArchive } from "../replays/private-archive.js";
import { accountRefusal, refusesSeatClient } from "./seatClientAdmission.js";
import { JobsBusy, MAX_RERUN_BITS, type PostMortemJobs, type RerunOutcome } from "./postMortemJobs.js";
import {
  EMPTY_PREFIX, PAGE_BYTES, PAGE_SCAN_BYTES, paddedBits, readRecordPage, RecordChanged, RecordReadError, surveyRecord,
  type Checkpoint, type Findings, type NoEffectEntry, type PageSpec, type RecordScan, type RefusedEntry, type SeatElement,
} from "./postMortemRecord.js";
import type { VersionSource } from "./postMortemVersion.js";

export const POST_MORTEM_TOOL = "match_post_mortem";
/** A reply waits at most this long for a record scan, well inside a seat client's 30 s. */
export const SCAN_WAIT_MS = 20_000;
/** A re-run that stopped without an answer is not retried for this long: replies say to ask again later. */
export const RETRY_AFTER_MS = 60_000;
const CACHE_ENTRIES = 64;
/** Kept pages, first passes and no-effect answers, each sized by its bytes; pages go first, no-effect answers last. */
export const CACHE_BYTES = 8 * 1024 * 1024;
/** A reply holds at most two pages and this much besides, two continuations included. */
export const REPLY_HEADER_BYTES = 8 * 1024 + 2 * 16 * 1024;
export const REPLY_BYTES = 2 * PAGE_BYTES + REPLY_HEADER_BYTES;
/**
 * Replies being delivered at once, per process: each holds its slot from just before it is shaped until its HTTP
 * response has finished or closed (postMortemJobs.ts DELIVERY_BUDGET_MIB). Over this, a caller is told the server is busy.
 */
export const DELIVERY_SLOTS = 4;

export const REFUSALS = {
  invalid_key: "That key is not valid.",
  not_found: "No match of yours has that id.",
  ownership_unconfirmed: "Ownership of this match can't be confirmed.",
  not_ended: "This match has not ended yet. Its post-mortem is available once it has ended and its delayed playback has finished.",
  record_unavailable: "This match has no stored record to read.",
  record_unreadable: "This match's stored record could not be read.",
  read_timed_out: "Reading this match's record took too long. Ask again later.",
  start_again: "This match's record changed, or that continuation is no longer valid. Ask again without a continuation to start from the first page.",
  still_reading: "Still reading this match's record. Ask again in a minute.",
  busy: "The server is busy with other post-mortems. Ask again in a minute.",
  one_per_request: "Only one match_post_mortem call is answered per request. Send each call in a request of its own.",
  bad_arguments: "Send your key and exactly one of lobbyId or matchId, and any refusedContinuation or noEffectContinuation exactly as a reply gave it.",
} as const;
export type RefusalCode = keyof typeof REFUSALS;

/** Where a match's record carries no tick rate. */
export const TICKS_ONLY_NOTE = "This match's record carries no tick rate, so times are shown in match ticks only.";
/** A refusal the record kept neither a tick nor a receive time for: still listed. */
export const TIME_NOT_RECORDED = "Time not recorded";
/** How an entry's recorded tick was taken: a call's reply line, or the simulation step that refused or ran a command. */
export const TICK_BASIS = { calls: "answered at tick", step: "simulation step" } as const;

/** Opens the accepted-commands list: what a command's own timers may do without counting as an effect. */
export const NO_EFFECT_NOTE = "These accepted commands changed nothing in the game, except at most restarting this seat's own timers.";
/** Added where the match's rules let any call keep a seat awake (no command idle allowance). */
export const CALL_IDLE_NOTE = "Under this match's rules any call, observe included, keeps this seat awake the same way.";
/** The caller's own seats' commands that the record cannot settle: never listed, never silently left out. */
export function undecidedSentence(n: number): string {
  return n === 1
    ? "1 other accepted command is not listed because this match's record cannot show whether it kept this seat from going idle."
    : `${n} other accepted commands are not listed because this match's record cannot show whether they kept this seat from going idle.`;
}
export const TOO_LARGE = "This match is too large to re-run within the re-run's fixed memory limits, so no-effect commands are not available for this match.";

export type NoEffectStatus =
  | { readonly status: "shown";
      /** [seat, its recorded commands] and one bit per command set where it had no effect (postMortemChild.ts packFindings). */
      readonly counts: readonly [number, number][]; readonly bits: Uint8Array;
      /** [seat, commands the record cannot settle], every seat; replies show only the caller's own seats' total. */
      readonly undecided: readonly [number, number][] }
  | { readonly status: "not_available"; readonly reason: string }
  | { readonly status: "being_worked_out" | "not_computed_now"; readonly reason: string };

export type PostMortemReply =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly body: { readonly error: RefusalCode; readonly message: string } };

export interface PostMortemDeps {
  readonly identities: Pick<Identities, "resolveKey">;
  readonly lobbies: Pick<Lobbies, "readLobby">;
  readonly registry: Pick<WatchRegistry, "read" | "replayLobby">;
  /** Public records as served: a corrected recording's record is read through it (correctedRecordings.ts). */
  readonly history?: Pick<HistorySource, "open">;
  /** Public records as stored, read pinned to a generation; every record but a corrected one is read through it. */
  readonly storedHistory?: Pick<HistorySource, "open">;
  readonly archive?: Pick<PrivateArchive, "consume">;
  readonly versions?: VersionSource;
  readonly jobs: PostMortemJobs;
  readonly now?: () => number;
  readonly scanWaitMs?: number;
  /** Tests only: another cap than CACHE_BYTES. */
  readonly cacheBytes?: number;
  /** Tests only: another bit limit than MAX_RERUN_BITS, page scan budget than PAGE_SCAN_BYTES, and read guard than READ_GUARD_MS. */
  readonly maxRerunBits?: number;
  readonly pageScanBytes?: number;
  readonly readGuardMs?: number;
}

export interface PostMortemQuery {
  readonly key: string; readonly lobbyId?: string | null; readonly matchId?: string | null;
  readonly refusedContinuation?: string | null; readonly noEffectContinuation?: string | null;
}

/**
 * Which stored bytes a record's pages are read from: a public record's generation and stored length as its reply gave
 * them (null where its source gives none), and the decoded record's length and SHA-256.
 */
type RecordIdentity =
  | { readonly kind: "public"; readonly generation: string | null; readonly storedLength: number | null; readonly length: number; readonly digest: string }
  | { readonly kind: "private"; readonly length: number; readonly digest: string };

/** What a record's first pass settled, for every owner: kept by record id until it is found obsolete. */
interface Initial {
  readonly identity: RecordIdentity;
  readonly source: "calls" | "commands";
  readonly elements: readonly SeatElement[];
  readonly agentSeats: Readonly<Record<string, number>>;
  readonly replyRefused: readonly [number, number][];
  readonly omitted: readonly [number, number][];
  readonly ticksPerSecond: number | null;
  /** The match's rules have no command idle allowance: any call keeps a seat awake. */
  readonly callIdle: boolean;
  readonly hasRerun: boolean;
  readonly codeVersion: string | null;
}

/** One owner's view of a record, carried by every continuation: its seats and what their pages need. */
interface Base {
  readonly replayId: string;
  readonly visibility: "public" | "private";
  readonly lobbyId: string;
  readonly colonies: readonly number[];
  readonly identity: RecordIdentity;
  readonly source: "calls" | "commands";
  readonly seats: readonly { seat: number; colony: 0 | 1 }[];
  readonly ownedPositions: readonly [number, number][];
  readonly ownedAgents: readonly [string, number][];
  readonly omitted: readonly [number, number][];
  readonly ticksPerSecond: number | null;
  readonly callIdle: boolean;
  /** Every seat element's commands as [seat, count], ascending by seat: what a re-run's findings must match. */
  readonly commandCounts: readonly [number, number][];
  readonly refusedTotal: number;
}
/** Where one list's next page starts. */
interface Cursor {
  readonly v: 1;
  readonly list: "refused" | "noEffect";
  readonly base: Base;
  readonly total: number;
  readonly ordinal: number;
  readonly checkpoint: Checkpoint | null;
  readonly prefix: string;
  readonly findingsDigest: string | null;
}
/** One page as read: its entries and the continuation to the next, if any. */
interface PageOut { readonly entries: readonly (RefusedEntry | NoEffectEntry)[]; readonly next: string | null; readonly nextOffset: number | null }
interface CacheEntry { value: PageOut | NoEffectStatus | Initial; retryAfter?: number; bytes: number; kind: "page" | "initial" | "noEffect" }

const refuse = (error: RefusalCode): PostMortemReply => ({ ok: false, body: { error, message: REFUSALS[error] } });

/** One HTTP request's handling: whether its response is done, whether a call of it has been answered, and that answer's slot. */
interface ResponseScope { closed: boolean; claimed: boolean; release: (() => void) | null }
const responseScope = new AsyncLocalStorage<ResponseScope>();

/**
 * Runs one HTTP request's handling (server.ts /mcp) in its response scope, with one listener on the response however
 * many calls the request carries. The request's calls then share it: the first whose ownership is proven is the one
 * answered, a call stops its work once the response has finished or closed, and the answer's delivery slot is freed
 * once the response is done with it.
 */
export function withResponseScope<T>(res: Writable, run: () => T): T {
  // A response already done is seen at once; finished() would say so only on a later tick.
  const scope: ResponseScope = { closed: res.destroyed || res.writableFinished, claimed: false, release: null };
  finished(res, () => {
    scope.closed = true;
    const release = scope.release;
    scope.release = null;
    release?.();
  });
  return responseScope.run(scope, run);
}
/** Whether this code runs inside an HTTP request's response scope. */
export const inResponseScope = (): boolean => responseScope.getStore() !== undefined;
/** The longest continuation a caller may send back. */
export const CONTINUATION_MAX = 16 * 1024;
/** One record read, initial pass or page, is stopped after this long. */
export const READ_GUARD_MS = 5 * 60_000;

/**
 * The colonies the caller owns: those whose lobby seats name the caller's identity and no other. A colony of several
 * identities is not served to any of them; no name or handle is read. Empty when the caller owns none.
 */
export function ownedColonies(lobby: Pick<Lobby, "colonies">, identityId: string): Set<0 | 1> {
  const seats = lobbySeats(lobby.colonies);
  const owned = new Set<0 | 1>();
  for (const colony of [0, 1] as const) {
    const identities = new Set(seats.filter(seat => seat.colony === colony).map(seat => seat.identityId));
    if (identities.size === 1 && identities.has(identityId)) owned.add(colony);
  }
  return owned;
}

const validContinuation = (value: string | null | undefined) => value === undefined || value === null
  || (typeof value === "string" && value.length > 0 && value.length <= CONTINUATION_MAX);
/** A refused entry's bytes in a reply, at its largest: the longer tick basis and a viewer's seconds. */
const refusedBytes = (entry: RefusedEntry) => JSON.stringify(shapeRefused(entry, "calls", 7)).length + 32;
const noEffectBytes = (entry: NoEffectEntry) => JSON.stringify(shapeNoEffectEntry(entry, 7)).length + 32;
const statusBytes = (status: NoEffectStatus) => status.status === "shown"
  ? status.bits.byteLength + 32 * (status.counts.length + status.undecided.length) + 64 : JSON.stringify(status).length;
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const findingsDigest = (status: { counts: readonly (readonly [number, number])[]; bits: Uint8Array }) => sha256(`${JSON.stringify(status.counts)}:${Buffer.from(status.bits).toString("hex")}`);
/** The key a record's no-effect answer is kept under: its id and the stored bytes it was worked out for. */
const identityKey = (identity: RecordIdentity) => identity.kind === "public" && identity.generation !== null ? `g${identity.generation}` : `d${identity.digest}`;
const sameIdentity = (a: RecordIdentity, b: RecordIdentity) => JSON.stringify(a) === JSON.stringify(b);

/** Continuations sealed with a key of this process: the caller can neither read nor forge one, and a restart voids them. */
function sealer() {
  const key = randomBytes(32);
  const aad = Buffer.from("antwar post-mortem continuation v1");
  return {
    seal(cursor: Cursor): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(JSON.stringify(cursor), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },
    open(token: string): Cursor | null {
      try {
        const raw = Buffer.from(token, "base64url");
        if (raw.length < 29 || raw.toString("base64url") !== token) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(raw.subarray(12, 28));
        const cursor = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as Cursor;
        return cursor.v === 1 ? cursor : null;
      } catch { return null; }
    },
  };
}

/** Bits set in one seat's findings, its first `count` commands only. */
function popcount(bits: Uint8Array, offset: number, count: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) if ((bits[offset + (i >> 3)]! & (1 << (i & 7))) !== 0) n++;
  return n;
}

export function createPostMortem(deps: PostMortemDeps) {
  const now = deps.now ?? Date.now;
  const scanWaitMs = deps.scanWaitMs ?? SCAN_WAIT_MS;
  const cacheCap = deps.cacheBytes ?? CACHE_BYTES;
  const maxRerunBits = deps.maxRerunBits ?? MAX_RERUN_BITS;
  const pageScanBytes = deps.pageScanBytes ?? PAGE_SCAN_BYTES;
  const readGuardMs = deps.readGuardMs ?? READ_GUARD_MS;
  const cache = new Map<string, CacheEntry>();
  let cacheBytes = 0;
  const work = new Map<string, Promise<unknown>>();
  const tokens = sealer();
  let deliveries = 0;

  /**
   * Keeps a page, a first pass or a no-effect answer, most recent last. Over the byte or entry cap, pages are dropped
   * oldest first, then first passes, and only then no-effect answers, so a no-effect answer outlives the reads made with it.
   */
  function remember(key: string, kind: CacheEntry["kind"], value: CacheEntry["value"], retryAfter?: number): void {
    const old = cache.get(key);
    if (old) { cache.delete(key); cacheBytes -= old.bytes; }
    const bytes = kind === "noEffect" ? statusBytes(value as NoEffectStatus) : JSON.stringify(value).length;
    cache.set(key, { value, retryAfter, bytes, kind });
    cacheBytes += bytes;
    for (const pass of ["page", "initial", "noEffect"] as const) {
      for (const [k, entry] of cache) {
        if (cache.size <= CACHE_ENTRIES && cacheBytes <= cacheCap) return;
        if (entry.kind !== pass) continue;
        cache.delete(k);
        cacheBytes -= entry.bytes;
      }
    }
  }
  function recall(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cache.set(key, entry); }
    return entry;
  }
  function forget(key: string): void {
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cacheBytes -= entry.bytes; }
  }
  const initialKey = (id: string) => `initial ${id}`;
  const noEffectKey = (id: string, identity: RecordIdentity) => `noEffect ${id} ${identityKey(identity)}`;
  const noEffectEntry = (id: string, identity: RecordIdentity) => cache.get(noEffectKey(id, identity));

  /** One job per key at a time, in the jobs' scan pool; its value kept once read. */
  function shared<T extends CacheEntry["value"]>(key: string, kind: CacheEntry["kind"], run: () => Promise<T>): Promise<T> {
    const kept = recall(key);
    if (kept !== undefined) return Promise.resolve(kept.value as T);
    let job = work.get(key) as Promise<T> | undefined;
    if (job === undefined) {
      job = deps.jobs.scan(run);
      work.set(key, job);
      const settled = job;
      void settled.then(value => remember(key, kind, value), () => {}).finally(() => { if (work.get(key) === settled) work.delete(key); });
    }
    return job;
  }

  /** A public record's bytes: a corrected recording through the served view, every other through the stored source, pinned. */
  async function openPublic(id: string, signal: AbortSignal, generation: string | null) {
    if (CORRECTED_REPLAY_IDS.has(id) || deps.storedHistory === undefined) {
      if (deps.history === undefined) throw new MissingRecord();
      return deps.history.open(id, signal);
    }
    return deps.storedHistory.open(id, signal, generation ?? undefined);
  }
  /** Whether an opened public stream carries the stored bytes a continuation was made from. */
  function carries(stream: Readable, identity: RecordIdentity): boolean {
    if (identity.kind !== "public") return false;
    const reply = storedIdentity(stream);
    return (reply?.generation ?? null) === identity.generation && (reply?.storedLength ?? null) === identity.storedLength;
  }
  /** A read's failure as this module answers it: aborted by its guard, missing, changed, or unreadable. */
  function failure(error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) return new ReadTimedOut();
    if (error instanceof MissingRecord || error instanceof RecordChanged) return error;
    return new RecordReadError();
  }

  /** A record's first pass: its survey, read once, emitting nothing. An unavailable record is missing and nothing is kept. */
  async function initialPass(id: string, visibility: "public" | "private", lobbyId: string): Promise<Initial> {
    const signal = AbortSignal.timeout(readGuardMs);
    let survey: { scan: RecordScan; length: number; digest: string } | null;
    let identity: RecordIdentity;
    try {
      if (visibility === "private") {
        if (!deps.archive?.consume) throw new RecordReadError();
        // consume returns only once the whole record has authenticated; what it says is read after that.
        survey = await deps.archive.consume({ lobbyId, replayId: id, kind: "match-record" }, signal, plaintext => surveyRecord(plaintext));
        if (survey === null) throw new MissingRecord();
        identity = { kind: "private", length: survey.length, digest: survey.digest };
      } else {
        const stream = await openPublic(id, signal, null);
        if (stream === null) throw new MissingRecord();
        const reply = storedIdentity(stream);
        // The guard ends a read that stops arriving, as well as one that runs long.
        try { survey = await surveyRecord(addAbortSignal(signal, stream), signal); } finally { stream.destroy(); }
        identity = { kind: "public", generation: reply?.generation ?? null, storedLength: reply?.storedLength ?? null, length: survey.length, digest: survey.digest };
      }
    } catch (error) { throw failure(error, signal); }
    const { scan } = survey;
    // No record, or one the record service marked unavailable (it is replaced once a complete one is stored): nothing is kept.
    if (scan.status === "unavailable") throw new MissingRecord();
    const config = scan.reduced.config;
    return {
      identity, source: scan.survey.source, elements: scan.survey.elements, agentSeats: scan.survey.agentSeats,
      replyRefused: [...scan.survey.replyRefused], omitted: [...scan.omitted], ticksPerSecond: scan.ticksPerSecond,
      callIdle: typeof config === "object" && config !== null && (config as { commandIdleTicks?: unknown }).commandIdleTicks === undefined,
      hasRerun: scan.reduced.rerun !== null, codeVersion: scan.reduced.codeVersion,
    };
  }

  /** One owner's view of a record from its first pass. */
  function baseOf(initial: Initial, replayId: string, visibility: "public" | "private", lobbyId: string, colonies: ReadonlySet<number>): Base {
    const ownedPositions: [number, number][] = [];
    const seats = new Map<number, 0 | 1>();
    initial.elements.forEach((element, position) => {
      if (!colonies.has(element.colony)) return;
      ownedPositions.push([position, element.seat]);
      seats.set(element.seat, element.colony);
    });
    const owned = new Set(seats.keys());
    const refusedTotal = initial.source === "commands"
      ? initial.elements.filter(e => colonies.has(e.colony)).reduce((sum, e) => sum + e.refused, 0)
      : initial.replyRefused.filter(([seat]) => owned.has(seat)).reduce((sum, [, n]) => sum + n, 0);
    const counts = new Map<number, number>();
    for (const e of initial.elements) counts.set(e.seat, (counts.get(e.seat) ?? 0) + e.commands);
    return {
      replayId, visibility, lobbyId, colonies: [...colonies].sort(), identity: initial.identity, source: initial.source,
      seats: [...seats].sort(([a], [b]) => a - b).map(([seat, colony]) => ({ seat, colony })),
      ownedPositions, ownedAgents: Object.entries(initial.agentSeats).filter(([, seat]) => owned.has(seat)),
      omitted: initial.omitted.filter(([seat]) => owned.has(seat)), ticksPerSecond: initial.ticksPerSecond, callIdle: initial.callIdle,
      commandCounts: [...counts].sort(([a], [b]) => a - b), refusedTotal,
    };
  }

  /** A list's first page. */
  function firstCursor(base: Base, list: "refused" | "noEffect", findings: Findings | null): Cursor {
    let total = base.refusedTotal;
    if (list === "noEffect") {
      const owned = new Set(base.seats.map(s => s.seat));
      let offset = 0;
      total = 0;
      for (const [seat, count] of findings!.counts) { if (owned.has(seat)) total += popcount(findings!.bits, offset, count); offset += Math.ceil(count / 8); }
    }
    return { v: 1, list, base, total, ordinal: 0, checkpoint: null, prefix: EMPTY_PREFIX,
      findingsDigest: list === "noEffect" ? findingsDigest(findings as { counts: readonly (readonly [number, number])[]; bits: Uint8Array }) : null };
  }

  /** One page of one list, read from the record's start and pinned to the bytes its continuation was made from. */
  async function readPage(cursor: Cursor, findings: Findings | null): Promise<PageOut> {
    const { base } = cursor;
    const spec: PageSpec = {
      list: cursor.list, source: base.source, ownedPositions: new Map(base.ownedPositions), ownedSeats: new Set(base.seats.map(s => s.seat)),
      ownedAgents: new Map(base.ownedAgents), findings, measure: cursor.list === "refused" ? refusedBytes as PageSpec["measure"] : noEffectBytes as PageSpec["measure"],
      resume: cursor.checkpoint, skip: 0, ordinal: cursor.ordinal, total: cursor.total, scanBytes: pageScanBytes,
    };
    const signal = AbortSignal.timeout(readGuardMs);
    const identity = base.identity;
    let read;
    try {
      if (identity.kind === "private") {
        if (!deps.archive?.consume) throw new RecordReadError();
        // Every page authenticates the whole record: consume returns only after the tag has verified, and the page's
        // read keeps what it found to itself until then.
        read = await deps.archive.consume({ lobbyId: base.lobbyId, replayId: base.replayId, kind: "match-record" }, signal,
          plaintext => readRecordPage(plaintext, undefined, spec, cursor.prefix, true));
        if (read === null || read.length !== identity.length || read.digest !== identity.digest) throw new RecordChanged();
      } else {
        // A missing pinned generation, or a reply of other bytes, is a changed record: start again.
        const stream = await openPublic(base.replayId, signal, identity.generation);
        if (stream === null) throw new RecordChanged();
        try {
          if (!carries(stream, identity)) throw new RecordChanged();
          read = await readRecordPage(addAbortSignal(signal, stream), signal, spec, cursor.prefix, false);
        } finally { stream.destroy(); }
      }
    } catch (error) {
      // A changed record's first pass is obsolete: the next fresh start reads it again.
      const cause = failure(error, signal);
      if (cause instanceof RecordChanged) forget(initialKey(base.replayId));
      throw cause;
    }
    const next = read.page.next;
    return { entries: read.page.entries, nextOffset: next?.offset ?? null,
      next: next === null || read.nextPrefix === null ? null : tokens.seal({ ...cursor, ordinal: cursor.ordinal + read.page.entries.length, checkpoint: next, prefix: read.nextPrefix }) };
  }

  /** A list's page: none to read once its entries are all shown. */
  function pageOf(cursor: Cursor, key: string, findings: Findings | null): Promise<PageOut> {
    if (cursor.ordinal >= cursor.total) return Promise.resolve({ entries: [], next: null, nextOffset: null });
    return shared(key, "page", () => readPage(cursor, findings));
  }
  const firstKey = (cursor: Cursor) => `page first ${cursor.list} ${cursor.base.replayId} ${cursor.base.colonies.join(",")} ${identityKey(cursor.base.identity)} ${cursor.findingsDigest ?? "-"}`;

  /** Whether a re-run's findings are of this record: each seat they count has the commands its first pass counted. */
  const matches = (base: Base, findings: Findings) => {
    const counts = new Map(base.commandCounts);
    return findings.counts.every(([seat, n]) => counts.get(seat) === n);
  };

  /** Settles why no-effect is not available, or queues the re-run; never awaited by a reply. */
  function startNoEffect(id: string, initial: Initial): void {
    const key = noEffectKey(id, initial.identity);
    const entry = cache.get(key);
    const status = entry?.value as NoEffectStatus | undefined;
    if (status?.status === "shown" || status?.status === "not_available") return;
    if (status?.status === "being_worked_out") return;
    if (entry?.retryAfter !== undefined && now() < entry.retryAfter) return;
    if (deps.jobs.pending(id)) return;
    const set = (noEffect: NoEffectStatus, retryAfter?: number) => remember(key, "noEffect", noEffect, retryAfter);
    if (!initial.hasRerun) { set({ status: "not_available", reason: "This match's stored record carries no re-run data." }); return; }
    // Over the bit limit the record cannot fit the re-run's fixed limits: settled for good, with no fork.
    if (paddedBits(initial.elements.map(e => e.commands)) > maxRerunBits) { set({ status: "not_available", reason: TOO_LARGE }); return; }
    const version = initial.codeVersion;
    if (version === null) { set({ status: "not_available", reason: "This match's game version is unknown." }); return; }
    if (deps.versions === undefined) { set(tryLater("game versions can't be checked on this server"), now() + RETRY_AFTER_MS); return; }
    const requestedAt = now();
    set({ status: "being_worked_out", reason: "Checking this match's game version. Ask again shortly." });
    void deps.versions.lookup(version, requestedAt).then(answer => {
      if (answer === "absent") { set({ status: "not_available", reason: "This match's game version is not in the game's published history." }); return; }
      if (answer === "unavailable") { set(tryLater("the game's history could not be read just now"), now() + RETRY_AFTER_MS); return; }
      // The queue holds the match id and its proven version; each attempt opens the record afresh, pinned to the bytes
      // this first pass read. Other bytes give no answer now, and the record's next first pass is read afresh.
      const open = async (signal: AbortSignal) => {
        const identity = initial.identity;
        const stream = await openPublic(id, signal, identity.kind === "public" ? identity.generation : null);
        if (stream !== null && carries(stream, identity)) return stream;
        stream?.destroy();
        forget(initialKey(id));
        return null;
      };
      const queued = deps.jobs.rerun(id, version, open, maxRerunBits);
      if (queued.state === "busy" || queued.outcome === undefined) { set(tryLater("the re-run queue is full"), now() + RETRY_AFTER_MS); return; }
      set({ status: "being_worked_out", reason: queued.state === "running" ? "This match is being re-run. Ask again shortly." : "This match is queued for a re-run. Ask again shortly." });
      void queued.outcome.then(outcome => {
        const settled = noEffectOf(outcome);
        set(settled, settled.status === "not_computed_now" ? now() + RETRY_AFTER_MS : undefined);
      });
    }, () => set(tryLater("the game's history could not be read just now"), now() + RETRY_AFTER_MS));
  }

  /**
   * The caller's record id, lobby and owned colonies, once ownership is proven from the lobby alone: before any cache,
   * scan or record is read. A refusal otherwise.
   */
  async function authorize(query: PostMortemQuery): Promise<PostMortemReply | { lobby: Lobby; replayId: string; visibility: "public" | "private"; colonies: Set<0 | 1> }> {
    let identityId: string;
    try {
      const resolved = await deps.identities.resolveKey(query.key);
      if (!resolved.ok) return refuse("invalid_key");
      identityId = resolved.value.id;
    } catch { return refuse("ownership_unconfirmed"); }
    let lobbyId = query.lobbyId ?? null;
    const matchId = query.matchId ?? null;
    try {
      if (matchId !== null) {
        if (!isReplayId(matchId)) return refuse("not_found");
        const link = await deps.registry.replayLobby(matchId);
        if (link.state === "pending") return refuse("ownership_unconfirmed");
        if (link.state === "none") {
          // A stored public record with no lobby link has no recorded seat identity.
          const stream = await deps.history?.open(matchId, AbortSignal.timeout(10_000));
          if (stream === null || stream === undefined) return refuse("not_found");
          stream.destroy();
          return refuse("ownership_unconfirmed");
        }
        lobbyId = link.lobbyId;
      }
      // An unknown or unreadable lobby, one with no recorded seats, or (by lobby id) one the caller holds no seat of:
      // its seat identities can't be read, or don't name the caller.
      const read = await deps.lobbies.readLobby(lobbyId!);
      if (!read.ok) return refuse("ownership_unconfirmed");
      const lobby = read.value;
      const seats = lobbySeats(lobby.colonies);
      if (seats.length === 0) return refuse("ownership_unconfirmed");
      if (!seats.some(seat => seat.identityId === identityId)) return refuse(matchId !== null ? "not_found" : "ownership_unconfirmed");
      // The caller holds a seat of this lobby; it owns only a colony whose seats name it alone.
      const colonies = ownedColonies(lobby, identityId);
      if (colonies.size === 0) return refuse("ownership_unconfirmed");
      const match = await deps.registry.read(lobby.id);
      if (match === null) return refuse(lobby.state === "ended" || lobby.state === "expired" ? "record_unavailable" : "not_ended");
      if (matchId !== null && match.replayId !== matchId) return refuse("ownership_unconfirmed");
      if (!match.playbackFinished) return refuse("not_ended");
      if (match.replayId === undefined) return refuse("record_unavailable");
      return { lobby, replayId: match.replayId, visibility: match.visibility, colonies };
    } catch { return refuse("ownership_unconfirmed"); }
  }

  /**
   * One call. signal is the MCP request's own: the SDK aborts it when the client cancels the call (as its timeout does),
   * then drops the reply. A caller that has gone, by that signal or by its HTTP response finishing or closing, or whose
   * wait has run out, gets no further page, re-run, slot or reply; a first pass it started runs on for every owner.
   */
  async function query(query: PostMortemQuery, signal?: AbortSignal): Promise<PostMortemReply> {
    if (typeof query.key !== "string" || query.key === "" || (query.lobbyId == null) === (query.matchId == null)
      || !validContinuation(query.refusedContinuation) || !validContinuation(query.noEffectContinuation)) return refuse("bad_arguments");
    const scope = responseScope.getStore();
    const auth = await authorize(query);
    if ("ok" in auth) return auth;
    // Of one request's calls, only the first whose ownership is proven is answered.
    if (scope !== undefined) {
      if (scope.claimed) return refuse("one_per_request");
      scope.claimed = true;
    }
    let timedOut = false;
    const stopped = () => timedOut || scope?.closed === true || signal?.aborted === true;
    const { replayId, visibility, lobby, colonies } = auth;
    // A continuation is opened only once ownership is proven, and serves only this owner, this match and its own list.
    const colonyList = [...colonies].sort().join(",");
    const opened = (token: string | null | undefined, list: Cursor["list"]): Cursor | null | undefined => {
      if (token === undefined || token === null) return undefined;
      const cursor = tokens.open(token);
      return cursor !== null && cursor.list === list && cursor.base.replayId === replayId && cursor.base.colonies.join(",") === colonyList ? cursor : null;
    };
    const refusedCursor = opened(query.refusedContinuation, "refused"), noEffectCursor = opened(query.noEffectContinuation, "noEffect");
    if (refusedCursor === null || noEffectCursor === null) return refuse("start_again");
    if (refusedCursor && noEffectCursor && !sameIdentity(refusedCursor.base.identity, noEffectCursor.base.identity)) return refuse("start_again");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([answer(replayId, visibility, lobby.id, colonies, query, refusedCursor, noEffectCursor, stopped, scope),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new StillReading()); }, scanWaitMs); })]);
    } catch (error) {
      if (error instanceof StillReading || error instanceof Stopped) return refuse("still_reading");
      if (error instanceof JobsBusy) return refuse("busy");
      if (error instanceof MissingRecord) return refuse("record_unavailable");
      if (error instanceof RecordChanged) return refuse("start_again");
      if (error instanceof ReadTimedOut) return refuse("read_timed_out");
      return refuse("record_unreadable");
    } finally { clearTimeout(timer); }
  }

  /**
   * The reply to an owner whose ownership is proven: its first pass (on a fresh start), then each list's page. Once
   * stopped() (the caller gone or its wait run out), nothing more is read, re-run or shaped for it: it is checked after
   * the first pass, between the two pages, and before the reply's slot is taken. A first pass already asked for runs on
   * in the scan pool, under its own guard, and is kept for the next caller.
   */
  async function answer(replayId: string, visibility: "public" | "private", lobbyId: string, colonies: ReadonlySet<number>, query: PostMortemQuery,
    refusedCursor: Cursor | undefined, noEffectCursor: Cursor | undefined, stopped: () => boolean, scope: ResponseScope | undefined): Promise<PostMortemReply> {
    let initial: Initial | undefined;
    let base: Base;
    const carried = refusedCursor ?? noEffectCursor;
    if (carried !== undefined) base = carried.base;
    else {
      initial = await shared(initialKey(replayId), "initial", () => initialPass(replayId, visibility, lobbyId));
      base = baseOf(initial, replayId, visibility, lobbyId, colonies);
    }
    if (stopped()) throw new Stopped();
    // The owned colonies hold none of the record's seats: nothing of this record is the caller's.
    if (base.seats.length === 0) return refuse("ownership_unconfirmed");
    let status: NoEffectStatus | null = visibility === "private"
      ? { status: "not_available", reason: "No-effect commands are not available for private matches." }
      : noEffectEntry(replayId, base.identity)?.value as NoEffectStatus | undefined ?? null;
    if (visibility === "public") {
      const entry = noEffectEntry(replayId, base.identity);
      const due = entry === undefined || (entry.value as NoEffectStatus).status === "not_computed_now" && entry.retryAfter !== undefined && now() >= entry.retryAfter;
      if (due) {
        // A continuation whose first pass and no-effect answer were both dropped from the cache reads the first pass
        // again, so the re-run can start again; a first pass of other bytes means the record changed.
        let first = initial ?? recall(initialKey(replayId))?.value as Initial | undefined;
        if (first === undefined) {
          first = await shared(initialKey(replayId), "initial", () => initialPass(replayId, visibility, lobbyId));
          if (stopped()) throw new Stopped();
        }
        if (!sameIdentity(first.identity, base.identity)) throw new RecordChanged();
        startNoEffect(replayId, first);
      }
      status = noEffectEntry(replayId, base.identity)?.value as NoEffectStatus | undefined ?? status;
    }
    const refusedAt = refusedCursor ?? firstCursor(base, "refused", null);
    const refused = await pageOf(refusedAt, refusedCursor ? `page ${sha256(query.refusedContinuation!)}` : firstKey(refusedAt), null);
    let noEffect: { cursor: Cursor; page: PageOut } | null = null;
    if (status?.status === "shown") {
      const findings: Findings = { counts: status.counts, bits: status.bits };
      if (!matches(base, findings)) status = tryLater("the record could not be matched with its re-run");
      else if (noEffectCursor !== undefined && noEffectCursor.findingsDigest !== findingsDigest(findings)) throw new RecordChanged();
      else {
        if (stopped()) throw new Stopped();
        const at = noEffectCursor ?? firstCursor(base, "noEffect", findings);
        noEffect = { cursor: at, page: await pageOf(at, noEffectCursor ? `page ${sha256(query.noEffectContinuation!)}` : firstKey(at), findings) };
      }
    }
    if (stopped()) throw new Stopped();
    // The reply's delivery slot: held until its HTTP response has finished or closed, or, outside one, until it is shaped.
    if (deliveries >= DELIVERY_SLOTS) return refuse("busy");
    deliveries++;
    let held = true;
    const release = () => { if (held) { held = false; deliveries--; } };
    try {
      return { ok: true, body: shape(base, status, { cursor: refusedAt, page: refused }, noEffect) };
    } finally {
      if (scope !== undefined) scope.release = release;
      else release();
    }
  }

  /** Replies holding a delivery slot now. */
  const deliveriesHeld = () => deliveries;

  return { query, deliveriesHeld };
}

class StillReading extends Error {}
/** The caller has gone, or its wait has run out: nothing more is done for it. */
class Stopped extends Error {}
class MissingRecord extends Error {}
class ReadTimedOut extends Error {}

/** A temporary status: nothing is settled now, and asking again later may. */
function tryLater(why: string): NoEffectStatus {
  return { status: "not_computed_now", reason: `No-effect commands are not computed now (${why}). Try later.` };
}
/** The temporary status of a re-run the server had no memory for. */
const SHORT_OF_MEMORY: NoEffectStatus = { status: "not_computed_now", reason: "No-effect commands are not available right now (the server is short of memory). Ask again later." };

export function noEffectOf(outcome: RerunOutcome): NoEffectStatus {
  switch (outcome.kind) {
    case "findings": return { status: "shown", counts: outcome.counts, bits: outcome.bits, undecided: outcome.undecided };
    case "not_reproduced": return { status: "not_available", reason: "Re-running this match did not reproduce its stored record, so no-effect commands are not available for this match." };
    case "no_rerun_data": return { status: "not_available", reason: "This match's stored record carries no re-run data." };
    case "no_idle_data": return { status: "not_available", reason: "This match's stored record lacks the idle-clock data its re-run needs, so no-effect commands are not available for this match." };
    case "engine_error": return { status: "not_available", reason: "This match could not be re-run on the current game version, so no-effect commands are not available for this match." };
    case "too_large": return { status: "not_available", reason: TOO_LARGE };
    case "stopped": return outcome.cause === "admission" || outcome.cause === "memory" || outcome.cause === "meter" ? SHORT_OF_MEMORY
      : tryLater(outcome.cause === "stalled" ? "the re-run stalled" : "the re-run failed");
  }
}

/**
 * An entry's time: its recorded tick and how it was taken, the tick a viewer of the match sees it at (a reply line's
 * own tick; a simulation step's next tick, when the viewer shows that step), and the viewer's seconds where the record
 * carries a tick rate. Null when there is no recorded tick.
 */
export function timeOf(tick: number | null, basis: keyof typeof TICK_BASIS, ticksPerSecond: number | null): Record<string, unknown> | null {
  if (tick === null) return null;
  const viewerTick = basis === "calls" ? tick : tick + 1;
  return { tick, tickBasis: TICK_BASIS[basis], viewerTick, ...(ticksPerSecond === null ? {} : { viewerSeconds: viewerTick / ticksPerSecond }) };
}

function shapeRefused({ tick, at, tool, code }: RefusedEntry, basis: keyof typeof TICK_BASIS, rate: number | null): Record<string, unknown> {
  const time = timeOf(tick, basis, rate);
  const iso = at === null || !Number.isFinite(at) ? null : new Date(at).toISOString();
  return { ...(time ?? { tick: null }), at: iso, ...(time === null && iso === null ? { time: TIME_NOT_RECORDED } : {}), tool, code };
}
function shapeNoEffectEntry({ seat, index, tick, type }: NoEffectEntry, rate: number | null): Record<string, unknown> {
  return { seat, commandIndex: index, type, ...timeOf(tick, "step", rate) };
}

/**
 * One page's position: how many entries in all, the first one shown and how many, how many remain, how far into the
 * record's decoded bytes the page read, and, where more remain, the continuation to send back for the next page.
 */
function paging(cursor: Cursor, page: PageOut, name: string, what: string): Record<string, unknown> {
  const shown = page.entries.length, remaining = Math.max(0, cursor.total - cursor.ordinal - shown);
  const recordBytes = cursor.base.identity.length;
  return { total: cursor.total, first: cursor.ordinal, shown, remaining, scannedBytes: page.nextOffset ?? recordBytes, recordBytes,
    ...(page.next === null ? {} : { continuation: page.next, more: `${remaining} more ${what}: ask again with ${name} set to this page's continuation.` }) };
}

/** The no-effect answer as the caller may see it: a page of its own seats' commands, and its own seats' undecided count. */
export function ownNoEffect(status: NoEffectStatus, entries: readonly NoEffectEntry[], mine: ReadonlySet<number>, callIdle: boolean, ticksPerSecond: number | null): Record<string, unknown> {
  if (status.status !== "shown") return status;
  const undecided = status.undecided.filter(([seat]) => mine.has(seat)).reduce((sum, [, n]) => sum + n, 0);
  return { status: "shown", note: callIdle ? `${NO_EFFECT_NOTE} ${CALL_IDLE_NOTE}` : NO_EFFECT_NOTE,
    commands: entries.filter(entry => mine.has(entry.seat)).map(entry => shapeNoEffectEntry(entry, ticksPerSecond)),
    ...(undecided === 0 ? {} : { notListed: undecidedSentence(undecided) }) };
}

function shape(base: Base, status: NoEffectStatus | null, refused: { cursor: Cursor; page: PageOut }, noEffect: { cursor: Cursor; page: PageOut } | null): Record<string, unknown> {
  const mine = new Set(base.seats.map(seat => seat.seat));
  const rate = base.ticksPerSecond;
  const basis = base.source === "calls" ? "calls" : "step";
  const settled = status ?? { status: "being_worked_out", reason: "Ask again shortly." };
  const shown = settled.status === "shown" ? noEffect : null;
  const entries = refused.page.entries as readonly RefusedEntry[];
  return {
    matchId: base.replayId, lobbyId: base.lobbyId,
    ...(rate === null ? { timeNote: TICKS_ONLY_NOTE } : {}),
    seats: base.seats.map(seat => ({
      seat: seat.seat, colony: seat.colony,
      refused: entries.filter(entry => entry.seat === seat.seat).map(entry => shapeRefused(entry, basis, rate)),
      refusedNotRetained: base.omitted.find(([s]) => s === seat.seat)?.[1] ?? 0,
    })),
    refusedFrom: base.source,
    refusedPage: paging(refused.cursor, refused.page, "refusedContinuation", "refused calls"),
    noEffect: ownNoEffect(settled, (shown?.page.entries ?? []) as readonly NoEffectEntry[], mine, base.callIdle, rate),
    ...(shown === null ? {} : { noEffectPage: paging(shown.cursor, shown.page, "noEffectContinuation", "no-effect commands") }),
  };
}

export const POST_MORTEM_DESCRIPTION = "After a match you played has ended and its delayed playback has finished: which of your seats' calls were refused (tool, error code, the time the server received the call, and the recorded tick with how it was taken: the tick the call was answered at, or the simulation step that refused it, plus the tick a viewer of the match sees it at and that viewer's seconds where the match records a tick rate), and, for a public match whose re-run reproduces its stored record, which accepted commands had no effect (with the same times, and commandIndex: the command's 0-based position in its seat's commands list in the published match record, which tells apart commands of one type in one step; calls refused before reaching the game may be absent from that list). Needs the key of the identity that held the seat, and exactly one of lobbyId or matchId. Shows only your own seats. Where the stored records cannot establish who held a seat, ownership can't be confirmed and nothing is shown. Private matches, records without re-run data, records whose re-run does not reproduce and records too large to re-run within the re-run's fixed memory limits say no-effect commands are not available; refused calls are still shown. A re-run can take minutes: until then noEffect says so, and asking again later shows the result. Long lists come in pages: refusedPage and noEffectPage give each list's total, how many remain and how far into the record the page read, and, where more remain, a continuation: ask again with it as refusedContinuation or noEffectContinuation for the next page. Reading a large record can take a while: until a page is ready the tool says to ask again. If the record changes, or the server restarts, a continuation stops working: ask again without one to start from the first page. Only one match_post_mortem call is answered per request: send each call in a request of its own.";

export function registerPostMortemTool(server: McpServer, postMortem: Pick<ReturnType<typeof createPostMortem>, "query">, options: { seatClientAdmission?: boolean } = {}): void {
  server.registerTool(POST_MORTEM_TOOL, {
    description: POST_MORTEM_DESCRIPTION,
    inputSchema: {
      key: z.string().min(1).max(200).describe("The key of the username or handle that held the seat."),
      lobbyId: z.string().max(100).nullish().describe("The match's lobby id."),
      matchId: z.string().max(100).nullish().describe("The match's id, as the match list shows it."),
      refusedContinuation: z.string().max(CONTINUATION_MAX).nullish().describe("For the next page of refused calls: a reply's refusedPage.continuation, exactly as given."),
      noEffectContinuation: z.string().max(CONTINUATION_MAX).nullish().describe("For the next page of no-effect commands: a reply's noEffectPage.continuation, exactly as given."),
    },
  }, async (args, extra) => {
    if (options.seatClientAdmission === true && refusesSeatClient(server)) return accountRefusal();
    const reply = await postMortem.query(args, extra.signal);
    return payload({ ...reply.body }, !reply.ok);
  });
}
