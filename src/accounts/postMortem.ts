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
import { RecordReadError, scanRecord, type RecordScan, type ReducedRecord } from "./postMortemRecord.js";
import type { VersionSource } from "./postMortemVersion.js";

export const POST_MORTEM_TOOL = "match_post_mortem";
/** A reply waits at most this long for a record scan, well inside a seat client's 30 s. */
export const SCAN_WAIT_MS = 20_000;
/** A re-run that stopped without an answer is not retried for this long: replies say to try later. */
export const RETRY_AFTER_MS = 60_000;
const CACHE_ENTRIES = 64;
/** Kept summaries and no-effect answers together; summaries are dropped first, so a reply never depends on one. */
export const CACHE_BYTES = 8 * 1024 * 1024;

export const REFUSALS = {
  invalid_key: "That key is not valid.",
  not_found: "No match of yours has that id.",
  ownership_unconfirmed: "Ownership of this match can't be confirmed.",
  not_ended: "This match has not ended yet. Its post-mortem is available once it has ended and its delayed playback has finished.",
  record_unavailable: "This match has no stored record to read.",
  record_unreadable: "This match's stored record could not be read.",
  still_reading: "Still reading this match's record. Ask again in a minute.",
  busy: "The server is busy reading other records. Ask again in a minute.",
  bad_arguments: "Send your key and exactly one of lobbyId or matchId.",
} as const;
export type RefusalCode = keyof typeof REFUSALS;

/** Where a match's record carries no tick rate. */
export const TICKS_ONLY_NOTE = "This match's record carries no tick rate, so times are shown in match ticks only.";
/** A refusal the record kept neither a tick nor a receive time for: still listed. */
export const TIME_NOT_RECORDED = "Time not recorded";
/** How an entry's recorded tick was taken: a call's reply line, or the simulation step that refused or ran a command. */
export const TICK_BASIS = { calls: "answered at tick", step: "simulation step" } as const;

/** Opens the accepted-commands list (Coordinator rulings on what a command's own timers may do). */
export const NO_EFFECT_NOTE = "These accepted commands changed nothing in the game, except at most restarting this seat's own timers.";
/** Added where the match's rules let any call keep a seat awake (no command idle allowance). */
export const CALL_IDLE_NOTE = "Under this match's rules any call, observe included, keeps this seat awake the same way.";
/** The caller's own seats' commands that the record cannot settle: never listed, never silently left out. */
export function undecidedSentence(n: number): string {
  return n === 1
    ? "1 other accepted command is not listed because this match's record cannot show whether it kept this seat from going idle."
    : `${n} other accepted commands are not listed because this match's record cannot show whether they kept this seat from going idle.`;
}

export type NoEffectStatus =
  | { readonly status: "shown";
      /** index: the command's 0-based position in its seat's commands list in the stored match record. */
      readonly commands: readonly { seat: number; index: number; tick: number; type: string }[];
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

export interface PostMortemQuery { readonly key: string; readonly lobbyId?: string | null; readonly matchId?: string | null }

/** What is kept of a scanned record, for every seat; replies filter it to the caller's own seats. */
interface ScanSummary {
  readonly seats: readonly { seat: number; colony: 0 | 1 }[];
  readonly refused: readonly { seat: number; tick: number | null; at: string | null; tool: string; code: string }[];
  /** "calls": the record's call replies; "commands": its seats' refused commands, where it kept no replies. */
  readonly refusedFrom: "calls" | "commands";
  readonly omitted: readonly [number, number][];
  readonly ticksPerSecond: number | null;
  /** The match's rules have no command idle allowance: any call keeps a seat awake. */
  readonly callIdle: boolean;
}
/** A match's kept summary (null once dropped for space) and no-effect answer, each with its size. */
interface CacheEntry { summary: ScanSummary | null; noEffect: NoEffectStatus | null; retryAfter?: number; summaryBytes: number; noEffectBytes: number }
/** What one record scan gives the server: the summary replies are shaped from, and the re-run's inputs. */
interface Scanned { readonly summary: ScanSummary; readonly reduced: ReducedRecord }

const refuse = (error: RefusalCode): PostMortemReply => ({ ok: false, body: { error, message: REFUSALS[error] } });
class Unconfirmed extends Error {}

/**
 * The record seats the caller owns: every record seat of a colony whose lobby seats name the caller's identity and no
 * other. A colony of several identities is not served to any of them; no name or handle is read.
 */
export function ownedSeats(lobby: Pick<Lobby, "colonies">, identityId: string, recordSeats: ScanSummary["seats"]): number[] {
  const seats = lobbySeats(lobby.colonies);
  const owned: number[] = [];
  for (const colony of [0, 1] as const) {
    const identities = new Set(seats.filter(seat => seat.colony === colony).map(seat => seat.identityId));
    if (identities.size !== 1 || !identities.has(identityId)) continue;
    owned.push(...recordSeats.filter(seat => seat.colony === colony).map(seat => seat.seat));
  }
  if (owned.length === 0) throw new Unconfirmed();
  return owned;
}

function summarize(scan: RecordScan): ScanSummary {
  const iso = (at: number | null) => at === null || !Number.isFinite(at) ? null : new Date(at).toISOString();
  const refused = scan.refusals !== null
    ? scan.refusals.flatMap(r => r.seat === null ? [] : [{ seat: r.seat, tick: r.tick, at: iso(r.receivedAt), tool: r.tool, code: r.code }])
    : scan.reduced.seats.flatMap(seat => seat.commands.filter(c => !c.accepted)
      .map(c => ({ seat: seat.seat, tick: c.tick, at: null, tool: c.type, code: c.errorCode ?? "refused" })));
  const config = scan.reduced.config;
  return {
    seats: scan.reduced.seats.map(({ seat, colony }) => ({ seat, colony })),
    refused, refusedFrom: scan.refusals !== null ? "calls" : "commands", omitted: [...scan.omitted], ticksPerSecond: scan.ticksPerSecond,
    callIdle: typeof config === "object" && config !== null && (config as { commandIdleTicks?: unknown }).commandIdleTicks === undefined,
  };
}

export function createPostMortem(deps: PostMortemDeps) {
  const now = deps.now ?? Date.now;
  const scanWaitMs = deps.scanWaitMs ?? SCAN_WAIT_MS;
  const cacheCap = deps.cacheBytes ?? CACHE_BYTES;
  const cache = new Map<string, CacheEntry>();
  let cacheBytes = 0;
  const scans = new Map<string, Promise<Scanned>>();
  const sizeOf = (value: unknown) => value === null ? 0 : JSON.stringify(value).length;

  /**
   * Keeps a match's summary and no-effect answer, most recent last. Over the byte cap, summaries are dropped oldest
   * first (the newest too), and only then whole entries, so a no-effect answer outlives its summary; over the entry
   * cap, the oldest entries go.
   */
  function remember(id: string, change: { summary?: ScanSummary; noEffect?: NoEffectStatus; retryAfter?: number }): void {
    const old = cache.get(id);
    if (old) { cache.delete(id); cacheBytes -= old.summaryBytes + old.noEffectBytes; }
    const summary = change.summary ?? old?.summary ?? null;
    const noEffect = "noEffect" in change ? change.noEffect! : old?.noEffect ?? null;
    const retryAfter = "noEffect" in change ? change.retryAfter : old?.retryAfter;
    const entry: CacheEntry = { summary, noEffect, retryAfter, summaryBytes: sizeOf(summary), noEffectBytes: sizeOf(noEffect) };
    cache.set(id, entry);
    cacheBytes += entry.summaryBytes + entry.noEffectBytes;
    for (const value of cache.values()) {
      if (cacheBytes <= cacheCap) break;
      if (value.summary === null) continue;
      cacheBytes -= value.summaryBytes;
      value.summary = null;
      value.summaryBytes = 0;
    }
    for (const [key, value] of cache) {
      if (cache.size <= CACHE_ENTRIES && cacheBytes <= cacheCap) break;
      cache.delete(key);
      cacheBytes -= value.summaryBytes + value.noEffectBytes;
    }
  }
  function recall(id: string): CacheEntry | undefined {
    const entry = cache.get(id);
    if (entry) { cache.delete(id); cache.set(id, entry); }
    return entry;
  }

  /** One scan per match at a time, in the jobs' scan pool; a public scan also starts the match's no-effect work. */
  function scanOf(id: string, visibility: "public" | "private", lobbyId: string): Promise<Scanned> {
    let scan = scans.get(id);
    if (scan === undefined) {
      scan = deps.jobs.scan(async (): Promise<Scanned> => {
        const signal = AbortSignal.timeout(5 * 60_000);
        let read: RecordScan | null;
        if (visibility === "private") {
          if (!deps.archive?.consume) throw new RecordReadError();
          // consume returns only once the whole record has authenticated; what it says is read after that, outside
          // this wrapper, which turns every failure of the read itself into one unreadable error.
          try { read = await deps.archive.consume({ lobbyId, replayId: id, kind: "match-record" }, signal, plaintext => scanRecord(plaintext)); }
          catch { throw new RecordReadError(); }
        } else {
          if (!deps.history) throw new MissingRecord();
          const stream = await deps.history.open(id, signal);
          if (stream === null) throw new MissingRecord();
          try { read = await scanRecord(stream, signal); } finally { stream.destroy(); }
        }
        // No record, or one the record service marked unavailable (it is replaced once a complete one is stored): nothing is kept.
        if (read === null || read.status === "unavailable") throw new MissingRecord();
        return { summary: summarize(read), reduced: read.reduced };
      });
      scans.set(id, scan);
      const settled = scan;
      void settled.then(({ summary, reduced }) => {
        remember(id, { summary });
        if (visibility === "public") startNoEffect(id, reduced);
      }, () => {}).finally(() => { if (scans.get(id) === settled) scans.delete(id); });
    }
    return scan;
  }

  /** Settles why no-effect is not available, or queues the re-run; never awaited by a reply, and needs no kept summary. */
  function startNoEffect(id: string, record: ReducedRecord): void {
    const entry = cache.get(id);
    if (entry?.noEffect?.status === "shown" || entry?.noEffect?.status === "not_available") return;
    if (entry?.retryAfter !== undefined && now() < entry.retryAfter) return;
    if (deps.jobs.pending(id)) return;
    const set = (noEffect: NoEffectStatus, retryAfter?: number) => remember(id, { noEffect, retryAfter });
    if (record.rerun === null) { set({ status: "not_available", reason: "This match's stored record carries no re-run data." }); return; }
    if (record.codeVersion === null) { set({ status: "not_available", reason: "This match's game version is unknown." }); return; }
    if (deps.versions === undefined) { set(tryLater("game versions can't be checked on this server"), now() + RETRY_AFTER_MS); return; }
    const requestedAt = now();
    set({ status: "being_worked_out", reason: "Checking this match's game version. Ask again shortly." });
    void deps.versions.lookup(record.codeVersion, requestedAt).then(answer => {
      if (answer === "absent") { set({ status: "not_available", reason: "This match's game version is not in the game's published history." }); return; }
      if (answer === "unavailable") { set(tryLater("the game's history could not be read just now"), now() + RETRY_AFTER_MS); return; }
      const history = deps.history;
      if (history === undefined) { set(tryLater("the record could not be read again"), now() + RETRY_AFTER_MS); return; }
      // The queue holds the match id and its proven version; the child reads the record afresh on each attempt.
      const queued = deps.jobs.rerun(id, record.codeVersion!, signal => history.open(id, signal));
      if (queued.state === "busy" || queued.outcome === undefined) { set(tryLater("the re-run queue is full"), now() + RETRY_AFTER_MS); return; }
      set({ status: "being_worked_out", reason: queued.state === "running" ? "This match is being re-run. Ask again shortly." : "This match is queued for a re-run. Ask again shortly." });
      void queued.outcome.then(outcome => {
        const status = noEffectOf(outcome);
        set(status, status.status === "not_computed_now" ? now() + RETRY_AFTER_MS : undefined);
      });
    }, () => set(tryLater("the game's history could not be read just now"), now() + RETRY_AFTER_MS));
  }

  /** The caller's record id and lobby, once ownership is proven; a refusal otherwise. */
  async function authorize(query: PostMortemQuery): Promise<PostMortemReply | { identityId: string; lobby: Lobby; replayId: string; visibility: "public" | "private" }> {
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
      // From here the caller holds a seat of this lobby.
      const match = await deps.registry.read(lobby.id);
      if (match === null) return refuse(lobby.state === "ended" || lobby.state === "expired" ? "record_unavailable" : "not_ended");
      if (matchId !== null && match.replayId !== matchId) return refuse("ownership_unconfirmed");
      if (!match.playbackFinished) return refuse("not_ended");
      if (match.replayId === undefined) return refuse("record_unavailable");
      return { identityId, lobby, replayId: match.replayId, visibility: match.visibility };
    } catch { return refuse("ownership_unconfirmed"); }
  }

  async function query(query: PostMortemQuery): Promise<PostMortemReply> {
    if (typeof query.key !== "string" || query.key === "" || (query.lobbyId == null) === (query.matchId == null)) return refuse("bad_arguments");
    const auth = await authorize(query);
    if ("ok" in auth) return auth;
    const { replayId, visibility, lobby, identityId } = auth;
    let summary = recall(replayId)?.summary ?? null;
    const fromCache = summary !== null;
    if (summary === null) {
      // The reply is shaped from this scan's own answer, whether or not its summary is kept.
      let timer: NodeJS.Timeout | undefined;
      try {
        summary = (await Promise.race([scanOf(replayId, visibility, lobby.id),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StillReading()), scanWaitMs); })])).summary;
      } catch (error) {
        if (error instanceof StillReading) return refuse("still_reading");
        if (error instanceof JobsBusy) return refuse("busy");
        if (error instanceof MissingRecord) return refuse("record_unavailable");
        return refuse("record_unreadable");
      } finally { clearTimeout(timer); }
    }
    let owned: number[];
    try { owned = ownedSeats(lobby, identityId, summary.seats); } catch { return refuse("ownership_unconfirmed"); }
    let noEffect: NoEffectStatus | null;
    if (visibility === "private") noEffect = { status: "not_available", reason: "No-effect commands are not available for private matches." };
    else {
      const entry = cache.get(replayId);
      noEffect = entry?.noEffect ?? null;
      const due = noEffect === null || noEffect.status === "not_computed_now" && entry?.retryAfter !== undefined && now() >= entry.retryAfter;
      // A summary from the cache with no-effect not yet computed, or a try-later whose wait has passed: read the record
      // again for its re-run, in the background. A fresh scan has already started that work.
      if (fromCache && due && !scans.has(replayId) && !deps.jobs.pending(replayId)) {
        noEffect = { status: "being_worked_out", reason: "This match is being prepared for a re-run. Ask again shortly." };
        remember(replayId, { noEffect });
        void scanOf(replayId, visibility, lobby.id).catch(() => {
          remember(replayId, { noEffect: tryLater("the record could not be read again"), retryAfter: now() + RETRY_AFTER_MS });
        });
      }
    }
    return { ok: true, body: shape(replayId, lobby.id, summary, noEffect, owned) };
  }

  return { query };
}

class StillReading extends Error {}
class MissingRecord extends Error {}

function tryLater(why: string): NoEffectStatus {
  return { status: "not_computed_now", reason: `No-effect commands are not computed now (${why}). Try later.` };
}

export function noEffectOf(outcome: RerunOutcome): NoEffectStatus {
  switch (outcome.kind) {
    case "findings": return { status: "shown", commands: outcome.findings.map(f => ({ seat: f.seat, index: f.index, tick: f.tick, type: f.type })), undecided: outcome.undecided };
    case "not_reproduced": return { status: "not_available", reason: "Re-running this match did not reproduce its stored record, so no-effect commands are not available for this match." };
    case "no_rerun_data": return { status: "not_available", reason: "This match's stored record carries no re-run data." };
    case "no_idle_data": return { status: "not_available", reason: "This match's stored record lacks the idle-clock data its re-run needs, so no-effect commands are not available for this match." };
    case "engine_error": return { status: "not_available", reason: "This match could not be re-run on the current game version, so no-effect commands are not available for this match." };
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

/** The no-effect answer as the caller may see it: its own seats' commands and count only. */
export function ownNoEffect(noEffect: NoEffectStatus, mine: ReadonlySet<number>, callIdle: boolean, ticksPerSecond: number | null): Record<string, unknown> {
  if (noEffect.status !== "shown") return noEffect;
  const undecided = noEffect.undecided.filter(([seat]) => mine.has(seat)).reduce((sum, [, n]) => sum + n, 0);
  return { status: "shown", note: callIdle ? `${NO_EFFECT_NOTE} ${CALL_IDLE_NOTE}` : NO_EFFECT_NOTE,
    commands: noEffect.commands.filter(c => mine.has(c.seat)).map(c => ({ seat: c.seat, commandIndex: c.index, type: c.type, ...timeOf(c.tick, "step", ticksPerSecond) })),
    ...(undecided === 0 ? {} : { notListed: undecidedSentence(undecided) }) };
}

function shape(matchId: string, lobbyId: string, summary: ScanSummary, noEffect: NoEffectStatus | null, owned: readonly number[]): Record<string, unknown> {
  const mine = new Set(owned);
  const rate = summary.ticksPerSecond;
  const basis = summary.refusedFrom === "calls" ? "calls" : "step";
  return {
    matchId, lobbyId,
    ...(rate === null ? { timeNote: TICKS_ONLY_NOTE } : {}),
    seats: summary.seats.filter(seat => mine.has(seat.seat)).map(seat => ({
      seat: seat.seat, colony: seat.colony,
      refused: summary.refused.filter(r => r.seat === seat.seat).map(({ tick, at, tool, code }) => {
        const time = timeOf(tick, basis, rate);
        return { ...(time ?? { tick: null }), at, ...(time === null && at === null ? { time: TIME_NOT_RECORDED } : {}), tool, code };
      }),
      refusedNotRetained: summary.omitted.find(([s]) => s === seat.seat)?.[1] ?? 0,
    })),
    refusedFrom: summary.refusedFrom,
    noEffect: ownNoEffect(noEffect ?? { status: "being_worked_out", reason: "Ask again shortly." }, mine, summary.callIdle, rate),
  };
}

export const POST_MORTEM_DESCRIPTION = "After a match you played has ended and its delayed playback has finished: which of your seats' calls were refused (tool, error code, the time the server received the call, and the recorded tick with how it was taken: the tick the call was answered at, or the simulation step that refused it, plus the tick a viewer of the match sees it at and that viewer's seconds where the match records a tick rate), and, for a public match whose re-run reproduces its stored record, which accepted commands had no effect (with the same times, and commandIndex: the command's 0-based position in its seat's commands list in the published match record, which tells apart commands of one type in one step; calls refused before reaching the game may be absent from that list). Needs the key of the identity that held the seat, and exactly one of lobbyId or matchId. Shows only your own seats. Where the stored records cannot establish who held a seat, ownership can't be confirmed and nothing is shown. Private matches, records without re-run data and records whose re-run does not reproduce say no-effect commands are not available; refused calls are still shown. A re-run can take minutes: until then noEffect says so, and asking again later shows the result.";

export function registerPostMortemTool(server: McpServer, postMortem: ReturnType<typeof createPostMortem>, options: { seatClientAdmission?: boolean } = {}): void {
  server.registerTool(POST_MORTEM_TOOL, {
    description: POST_MORTEM_DESCRIPTION,
    inputSchema: {
      key: z.string().min(1).max(200).describe("The key of the username or handle that held the seat."),
      lobbyId: z.string().max(100).nullish().describe("The match's lobby id."),
      matchId: z.string().max(100).nullish().describe("The match's id, as the match list shows it."),
    },
  }, async (args) => {
    if (options.seatClientAdmission === true && refusesSeatClient(server)) return accountRefusal();
    const reply = await postMortem.query(args);
    return payload({ ...reply.body }, !reply.ok);
  });
}
