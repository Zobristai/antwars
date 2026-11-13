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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Identities } from "../identity/identities.js";
import type { Lobbies, Lobby } from "../lobby/lobbies.js";
import type { WatchRegistry } from "../live/watch-registry.js";
import { lobbySeats } from "../live/watch-controller.js";
import { payload } from "../mcp/replies.js";
import { isReplayId } from "../replays/access.js";
import type { HistorySource } from "../replays/history-source.js";
import type { PrivateArchive } from "../replays/private-archive.js";
import { accountRefusal, refusesSeatClient } from "./seatClientAdmission.js";
import { JobsBusy, type PostMortemJobs, type RerunOutcome } from "./postMortemJobs.js";
import {
  PAGE_BYTES, RecordReadError, scanRecord, type NoEffectEntry, type Page, type RecordScan, type RefusedEntry, type SeatMap, type Window,
} from "./postMortemRecord.js";
import type { VersionSource } from "./postMortemVersion.js";

export const POST_MORTEM_TOOL = "match_post_mortem";
/** A reply waits at most this long for a record scan, well inside a seat client's 30 s. */
export const SCAN_WAIT_MS = 20_000;
/** A re-run that stopped without an answer is not retried for this long: replies say to ask again later. */
export const RETRY_AFTER_MS = 60_000;
const CACHE_ENTRIES = 64;
/** Kept pages and no-effect answers, each sized by its bytes; pages are dropped first, so no answer depends on one. */
export const CACHE_BYTES = 8 * 1024 * 1024;
/** A reply holds at most two pages and this much besides. */
export const REPLY_HEADER_BYTES = 8 * 1024;
export const REPLY_BYTES = 2 * PAGE_BYTES + REPLY_HEADER_BYTES;

export const REFUSALS = {
  invalid_key: "That key is not valid.",
  not_found: "No match of yours has that id.",
  ownership_unconfirmed: "Ownership of this match can't be confirmed.",
  not_ended: "This match has not ended yet. Its post-mortem is available once it has ended and its delayed playback has finished.",
  record_unavailable: "This match has no stored record to read.",
  record_unreadable: "This match's stored record could not be read.",
  still_reading: "Still reading this match's record. Ask again in a minute.",
  busy: "The server is busy reading other records. Ask again in a minute.",
  bad_arguments: "Send your key and exactly one of lobbyId or matchId, and any refusedOffset or noEffectOffset as a whole number of 0 or more.",
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
  readonly history?: Pick<HistorySource, "open">;
  readonly archive?: Pick<PrivateArchive, "consume">;
  readonly versions?: VersionSource;
  readonly jobs: PostMortemJobs;
  readonly now?: () => number;
  readonly scanWaitMs?: number;
  /** Tests only: another cap than CACHE_BYTES. */
  readonly cacheBytes?: number;
}

export interface PostMortemQuery {
  readonly key: string; readonly lobbyId?: string | null; readonly matchId?: string | null;
  readonly refusedOffset?: number | null; readonly noEffectOffset?: number | null;
}

/** One request's pages of a match record, for the caller's own colonies only. */
interface PageRead {
  readonly seats: readonly { seat: number; colony: 0 | 1 }[];
  readonly refused: Page<RefusedEntry>;
  /** "calls": the record's call replies; "commands": its seats' refused commands, where it holds no replies array. */
  readonly refusedFrom: "calls" | "commands";
  /** Null where no re-run findings were given, or a seat's command count disagreed with them. */
  readonly noEffect: Page<NoEffectEntry> | null;
  readonly omitted: readonly [number, number][];
  readonly ticksPerSecond: number | null;
  /** The match's rules have no command idle allowance: any call keeps a seat awake. */
  readonly callIdle: boolean;
  /** The re-run's inputs: whether the record carries re-run data, and its game version. */
  readonly hasRerun: boolean;
  readonly codeVersion: string | null;
}
interface CacheEntry { value: PageRead | NoEffectStatus; retryAfter?: number; bytes: number; kind: "page" | "noEffect" }

const refuse = (error: RefusalCode): PostMortemReply => ({ ok: false, body: { error, message: REFUSALS[error] } });

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

const validOffset = (value: number | null | undefined) => value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
/** A refused entry's bytes in a reply, at its largest: the longer tick basis and a viewer's seconds. */
const refusedBytes = (entry: RefusedEntry) => JSON.stringify(shapeRefused(entry, "calls", 7)).length + 32;
const noEffectBytes = (entry: NoEffectEntry) => JSON.stringify(shapeNoEffectEntry(entry, 7)).length + 32;
const statusBytes = (status: NoEffectStatus) => status.status === "shown"
  ? status.bits.byteLength + 32 * (status.counts.length + status.undecided.length) + 64 : JSON.stringify(status).length;

export function createPostMortem(deps: PostMortemDeps) {
  const now = deps.now ?? Date.now;
  const scanWaitMs = deps.scanWaitMs ?? SCAN_WAIT_MS;
  const cacheCap = deps.cacheBytes ?? CACHE_BYTES;
  const cache = new Map<string, CacheEntry>();
  let cacheBytes = 0;
  const scans = new Map<string, Promise<PageRead>>();

  /**
   * Keeps a page or a no-effect answer, most recent last. Over the byte or entry cap, pages are dropped oldest first,
   * and only then no-effect answers, so a no-effect answer outlives the pages read with it.
   */
  function remember(key: string, kind: CacheEntry["kind"], value: CacheEntry["value"], retryAfter?: number): void {
    const old = cache.get(key);
    if (old) { cache.delete(key); cacheBytes -= old.bytes; }
    const bytes = kind === "page" ? JSON.stringify(value).length : statusBytes(value as NoEffectStatus);
    cache.set(key, { value, retryAfter, bytes, kind });
    cacheBytes += bytes;
    for (const pass of ["page", "noEffect"] as const) {
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
  const noEffectKey = (id: string) => `noEffect ${id}`;
  const noEffectEntry = (id: string) => cache.get(noEffectKey(id));
  const setNoEffect = (id: string, status: NoEffectStatus, retryAfter?: number) => remember(noEffectKey(id), "noEffect", status, retryAfter);

  /** One record pass, with a second only where the first met entries before what places them. */
  async function readPages(id: string, visibility: "public" | "private", lobbyId: string, window: Window): Promise<PageRead> {
    const pass = async (known?: SeatMap): Promise<RecordScan | null> => {
      const signal = AbortSignal.timeout(5 * 60_000);
      const w: Window = known === undefined ? window : { ...window, known };
      if (visibility === "private") {
        if (!deps.archive?.consume) throw new RecordReadError();
        // consume returns only once the whole record has authenticated; what it says is read after that, outside
        // this wrapper, which turns every failure of the read itself into one unreadable error.
        try { return await deps.archive.consume({ lobbyId, replayId: id, kind: "match-record" }, signal, plaintext => scanRecord(plaintext, undefined, "refused", undefined, w)); }
        catch { throw new RecordReadError(); }
      }
      if (!deps.history) throw new MissingRecord();
      const stream = await deps.history.open(id, signal);
      if (stream === null) throw new MissingRecord();
      try { return await scanRecord(stream, signal, "refused", undefined, w); } finally { stream.destroy(); }
    };
    let read = await pass();
    // No record, or one the record service marked unavailable (it is replaced once a complete one is stored): nothing is kept.
    if (read === null || read.status === "unavailable") throw new MissingRecord();
    if (read.window!.undecided) {
      read = await pass(read.window!.known);
      if (read === null || read.status === "unavailable") throw new MissingRecord();
    }
    const result = read.window!;
    const seats = read.reduced.seats.filter(seat => window.colonies.has(seat.colony)).map(({ seat, colony }) => ({ seat, colony }));
    const mine = new Set(seats.map(seat => seat.seat));
    const config = read.reduced.config;
    return {
      seats, refused: result.refused, refusedFrom: read.refusedFrom,
      noEffect: window.findings === null || result.findingsMismatch ? null : result.noEffect,
      omitted: [...read.omitted].filter(([seat]) => mine.has(seat)), ticksPerSecond: read.ticksPerSecond,
      callIdle: typeof config === "object" && config !== null && (config as { commandIdleTicks?: unknown }).commandIdleTicks === undefined,
      hasRerun: read.reduced.rerun !== null, codeVersion: read.reduced.codeVersion,
    };
  }

  /** One read per page key at a time, in the jobs' scan pool; kept once read. */
  function pageOf(key: string, id: string, visibility: "public" | "private", lobbyId: string, window: Window): Promise<PageRead> {
    let scan = scans.get(key);
    if (scan === undefined) {
      scan = deps.jobs.scan(() => readPages(id, visibility, lobbyId, window));
      scans.set(key, scan);
      const settled = scan;
      void settled.then(page => remember(key, "page", page), () => {}).finally(() => { if (scans.get(key) === settled) scans.delete(key); });
    }
    return scan;
  }

  /** Settles why no-effect is not available, or queues the re-run; never awaited by a reply. */
  function startNoEffect(id: string, page: PageRead): void {
    const entry = noEffectEntry(id);
    const status = entry?.value as NoEffectStatus | undefined;
    if (status?.status === "shown" || status?.status === "not_available") return;
    if (status?.status === "being_worked_out") return;
    if (entry?.retryAfter !== undefined && now() < entry.retryAfter) return;
    if (deps.jobs.pending(id)) return;
    const set = (noEffect: NoEffectStatus, retryAfter?: number) => setNoEffect(id, noEffect, retryAfter);
    if (!page.hasRerun) { set({ status: "not_available", reason: "This match's stored record carries no re-run data." }); return; }
    const version = page.codeVersion;
    if (version === null) { set({ status: "not_available", reason: "This match's game version is unknown." }); return; }
    if (deps.versions === undefined) { set(tryLater("game versions can't be checked on this server"), now() + RETRY_AFTER_MS); return; }
    const requestedAt = now();
    set({ status: "being_worked_out", reason: "Checking this match's game version. Ask again shortly." });
    void deps.versions.lookup(version, requestedAt).then(answer => {
      if (answer === "absent") { set({ status: "not_available", reason: "This match's game version is not in the game's published history." }); return; }
      if (answer === "unavailable") { set(tryLater("the game's history could not be read just now"), now() + RETRY_AFTER_MS); return; }
      const history = deps.history;
      if (history === undefined) { set(tryLater("the record could not be read again"), now() + RETRY_AFTER_MS); return; }
      // The queue holds the match id and its proven version; the child reads the record afresh on each attempt.
      const queued = deps.jobs.rerun(id, version, signal => history.open(id, signal));
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

  async function query(query: PostMortemQuery): Promise<PostMortemReply> {
    if (typeof query.key !== "string" || query.key === "" || (query.lobbyId == null) === (query.matchId == null)
      || !validOffset(query.refusedOffset) || !validOffset(query.noEffectOffset)) return refuse("bad_arguments");
    const refusedOffset = query.refusedOffset ?? 0, noEffectOffset = query.noEffectOffset ?? 0;
    const auth = await authorize(query);
    if ("ok" in auth) return auth;
    const { replayId, visibility, lobby, colonies } = auth;
    let status: NoEffectStatus | null = visibility === "private"
      ? { status: "not_available", reason: "No-effect commands are not available for private matches." }
      : noEffectEntry(replayId)?.value as NoEffectStatus | undefined ?? null;
    const findings = status?.status === "shown" ? { counts: status.counts, bits: status.bits } : null;
    const key = `page ${replayId} ${[...colonies].sort().join(",")} ${refusedOffset} ${noEffectOffset} ${findings === null ? "-" : "f"}`;
    let page = recall(key)?.value as PageRead | undefined;
    if (page === undefined) {
      const window: Window = { colonies, refusedOffset, noEffectOffset, findings, measureRefused: refusedBytes, measureNoEffect: noEffectBytes };
      let timer: NodeJS.Timeout | undefined;
      try {
        page = await Promise.race([pageOf(key, replayId, visibility, lobby.id, window),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StillReading()), scanWaitMs); })]);
      } catch (error) {
        if (error instanceof StillReading) return refuse("still_reading");
        if (error instanceof JobsBusy) return refuse("busy");
        if (error instanceof MissingRecord) return refuse("record_unavailable");
        return refuse("record_unreadable");
      } finally { clearTimeout(timer); }
    }
    // The owned colonies hold none of the record's seats: nothing of this record is the caller's.
    if (page.seats.length === 0) return refuse("ownership_unconfirmed");
    if (visibility === "public") {
      const entry = noEffectEntry(replayId);
      const due = entry === undefined || (entry.value as NoEffectStatus).status === "not_computed_now" && entry.retryAfter !== undefined && now() >= entry.retryAfter;
      if (due) startNoEffect(replayId, page);
      status = noEffectEntry(replayId)?.value as NoEffectStatus | undefined ?? status;
      // Findings that arrived after this page was read are shown once a page is read with them.
      if (status?.status === "shown" && page.noEffect === null) {
        status = findings === null ? { status: "being_worked_out", reason: "No-effect commands have just been worked out. Ask again to see them." } : tryLater("the record could not be matched with its re-run");
      }
    }
    return { ok: true, body: shape(replayId, lobby.id, page, status, refusedOffset, noEffectOffset) };
  }

  return { query };
}

class StillReading extends Error {}
class MissingRecord extends Error {}

/** A temporary status: nothing is settled now, and asking again later may. */
function tryLater(why: string): NoEffectStatus {
  return { status: "not_computed_now", reason: `No-effect commands are not available right now (${why}). Ask again later.` };
}

export function noEffectOf(outcome: RerunOutcome): NoEffectStatus {
  switch (outcome.kind) {
    case "findings": return { status: "shown", counts: outcome.counts, bits: outcome.bits, undecided: outcome.undecided };
    case "not_reproduced": return { status: "not_available", reason: "Re-running this match did not reproduce its stored record, so no-effect commands are not available for this match." };
    case "no_rerun_data": return { status: "not_available", reason: "This match's stored record carries no re-run data." };
    case "no_idle_data": return { status: "not_available", reason: "This match's stored record lacks the idle-clock data its re-run needs, so no-effect commands are not available for this match." };
    case "engine_error": return { status: "not_available", reason: "This match could not be re-run on the current game version, so no-effect commands are not available for this match." };
    case "too_large": return { status: "not_available", reason: TOO_LARGE };
    case "stopped": return tryLater(outcome.cause === "admission" || outcome.cause === "memory" || outcome.cause === "meter" ? "the server is short of memory" : outcome.cause === "stalled" ? "the re-run stalled" : "the re-run failed");
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

/** One page's position: how many in all, from where, how many more, and how to ask for them. */
function paging(total: number, offset: number, shown: number, name: string, what: string): Record<string, unknown> {
  const next = offset + shown, remaining = Math.max(0, total - next);
  return { total, offset, shown, remaining, ...(remaining === 0 ? {} : { nextOffset: next, more: `${remaining} more ${what}: ask again with ${name} ${next}.` }) };
}

/** The no-effect answer as the caller may see it: a page of its own seats' commands, and its own seats' undecided count. */
export function ownNoEffect(status: NoEffectStatus, entries: readonly NoEffectEntry[], mine: ReadonlySet<number>, callIdle: boolean, ticksPerSecond: number | null): Record<string, unknown> {
  if (status.status !== "shown") return status;
  const undecided = status.undecided.filter(([seat]) => mine.has(seat)).reduce((sum, [, n]) => sum + n, 0);
  return { status: "shown", note: callIdle ? `${NO_EFFECT_NOTE} ${CALL_IDLE_NOTE}` : NO_EFFECT_NOTE,
    commands: entries.filter(entry => mine.has(entry.seat)).map(entry => shapeNoEffectEntry(entry, ticksPerSecond)),
    ...(undecided === 0 ? {} : { notListed: undecidedSentence(undecided) }) };
}

function shape(matchId: string, lobbyId: string, page: PageRead, status: NoEffectStatus | null, refusedOffset: number, noEffectOffset: number): Record<string, unknown> {
  const mine = new Set(page.seats.map(seat => seat.seat));
  const rate = page.ticksPerSecond;
  const basis = page.refusedFrom === "calls" ? "calls" : "step";
  const noEffect = status ?? { status: "being_worked_out", reason: "Ask again shortly." };
  const shown = noEffect.status === "shown" ? page.noEffect : null;
  return {
    matchId, lobbyId,
    ...(rate === null ? { timeNote: TICKS_ONLY_NOTE } : {}),
    seats: page.seats.map(seat => ({
      seat: seat.seat, colony: seat.colony,
      refused: page.refused.entries.filter(entry => entry.seat === seat.seat).map(entry => shapeRefused(entry, basis, rate)),
      refusedNotRetained: page.omitted.find(([s]) => s === seat.seat)?.[1] ?? 0,
    })),
    refusedFrom: page.refusedFrom,
    refusedPage: paging(page.refused.total, refusedOffset, page.refused.entries.length, "refusedOffset", "refused calls"),
    noEffect: ownNoEffect(noEffect, shown?.entries ?? [], mine, page.callIdle, rate),
    ...(shown === null ? {} : { noEffectPage: paging(shown.total, noEffectOffset, shown.entries.length, "noEffectOffset", "no-effect commands") }),
  };
}

export const POST_MORTEM_DESCRIPTION = "After a match you played has ended and its delayed playback has finished: which of your seats' calls were refused (tool, error code, the time the server received the call, and the recorded tick with how it was taken: the tick the call was answered at, or the simulation step that refused it, plus the tick a viewer of the match sees it at and that viewer's seconds where the match records a tick rate), and, for a public match whose re-run reproduces its stored record, which accepted commands had no effect (with the same times, and commandIndex: the command's 0-based position in its seat's commands list in the published match record, which tells apart commands of one type in one step; calls refused before reaching the game may be absent from that list). Needs the key of the identity that held the seat, and exactly one of lobbyId or matchId. Shows only your own seats. Where the stored records cannot establish who held a seat, ownership can't be confirmed and nothing is shown. Private matches, records without re-run data, records whose re-run does not reproduce and records too large to re-run within the re-run's fixed memory limits say no-effect commands are not available; refused calls are still shown. A re-run can take minutes: until then noEffect says so, and asking again later shows the result. Long lists come in pages: refusedPage and noEffectPage give each list's total and, where more remain, the refusedOffset or noEffectOffset to ask again with.";

export function registerPostMortemTool(server: McpServer, postMortem: ReturnType<typeof createPostMortem>, options: { seatClientAdmission?: boolean } = {}): void {
  server.registerTool(POST_MORTEM_TOOL, {
    description: POST_MORTEM_DESCRIPTION,
    inputSchema: {
      key: z.string().min(1).max(200).describe("The key of the username or handle that held the seat."),
      lobbyId: z.string().max(100).nullish().describe("The match's lobby id."),
      matchId: z.string().max(100).nullish().describe("The match's id, as the match list shows it."),
      refusedOffset: z.number().int().min(0).nullish().describe("Where the refused calls' page starts: a reply's refusedPage.nextOffset."),
      noEffectOffset: z.number().int().min(0).nullish().describe("Where the no-effect commands' page starts: a reply's noEffectPage.nextOffset."),
    },
  }, async (args) => {
    if (options.seatClientAdmission === true && refusesSeatClient(server)) return accountRefusal();
    const reply = await postMortem.query(args);
    return payload({ ...reply.body }, !reply.ok);
  });
}
