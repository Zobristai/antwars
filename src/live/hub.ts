/// <reference types="node" />
/**
 * The live spectator stream: Server-Sent Events at /live/:match,
 * one-way, running a configured delay behind the match.
 *
 * The composing server calls startMatch with a match's starting state and
 * pushTick with each step's output; this module serves what it is given. Each
 * tick becomes one record, held until the match has run delaySeconds of match
 * time past it, then released to every spectator as one message. When a match
 * ends the remaining records play out on the hub's own clock at the match's
 * tick rate, so the result, which rides on the final tick's record, reaches a
 * spectator only when delayed playback reaches that tick. Releases are paced to
 * paceBytesPerSecond, so a backlog left by a stall drains within the per-second
 * budget instead of in one burst. A spectator's first message is a full one,
 * built from the board at the delayed playback position.
 *
 * Wire: each message is the format.ts payload, raw-deflated, base64-encoded,
 * as one `data:` line; when nothing else has been written for heartbeatMs a
 * comment line is written instead, and every stream opens with one. A
 * result-bearing message is followed by one
 * immediate heartbeat and one further heartbeat 100 ms later to release buffered
 * result bytes. Every write is one complete SSE message.
 */
import { randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { deflateRaw, deflateRawSync, inflateRaw } from "node:zlib";
import type { SimState, StepOutput } from "../sim/types.js";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "./config.js";
import { decodeMessage, encodeMessage, encodePublicMessage, type StreamAgent, type StreamMessage, type StreamRatingChange } from "./format.js";
import { SpectatorRecorder, SpectatorState, type RecorderResume, type SpectatorPlayerOptions, type TickRecord } from "./model.js";
import { ReplayRecording } from "../replays/recording.js";
import type { RecordHandoff } from "../records/handoff.js";
import type { ReplayStore } from "../replays/store.js";
import type { Activity } from "../slots/activity.js";
import { headerLine } from "../sim/log.js";
import { admitMatchWatch, captureMatchAccess, isHouseMatch, spectatorDelaySeconds, type MatchAccess, type CurrentInvite } from "./match-access.js";
import { matchWatchStatus, type CatalogMatch, type MatchWatchStatus } from "./match-catalog.js";
import { createAdmissionCap, EXEMPT, refuseBusy, type AdmissionCap } from "../net/admission.js";
import { clientSource } from "../server/clientSource.js";
import { RELAY_HEADER, verifyRelay } from "./relay-signature.js";

/** The hub's clock: real time by default; tests drive a manual one. */
export interface LiveClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: LiveClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface LiveHubOptions {
  readonly config?: LiveConfig;
  readonly clock?: LiveClock;
  /** Payload encoder; tests substitute one to show the budget checks can fail. */
  readonly encode?: (message: StreamMessage) => Uint8Array;
  /** Gap between records played out after a match ends; defaults to one tick of match time. */
  readonly playoutMs?: number;
  /** Finished matches kept for late spectators. */
  readonly keepMatches?: number;
  /** Omitted means no recording allocations, upload, or replay discovery route. */
  readonly replayStore?: ReplayStore;
  /** Explicit ANTWAR_RULES comparison opt-in; public streams omit setup metadata by default. */
  readonly includeComparisonSetup?: boolean;
  /** Server supplies every simulation input through appendLog when this is true. */
  readonly captureMatchLogs?: boolean;
  /** Slot servers refuse to create an unclassified stream. Local/offline callers retain legacy behavior. */
  readonly requireMatchAccess?: boolean;
  readonly currentInvite?: CurrentInvite;
  /** Must encrypt/isolate both binary and JSON objects; never falls back to replayStore. */
  readonly privateReplayStore?: (lobbyId: string) => ReplayStore | undefined;
  /** Hands each recorded match's inputs to the record service; omitted means no readable record. */
  readonly recordHandoff?: RecordHandoff;
  readonly onPlaybackFinished?: (access: MatchAccess) => void;
  readonly onReplaySaved?: (access: MatchAccess, replayId: string) => void;
  /** null means the match's actual rating transaction has not committed yet; retain the final tick. */
  readonly resultRatings?: (access: MatchAccess, agents: readonly StreamAgent[]) => Promise<readonly StreamRatingChange[] | null>;
  /** The slot server's outstanding work; omitted means nothing holds a server up. */
  readonly activity?: Activity;
  /**
   * Verifies the entry service's relay signature (relay-signature.ts); a verified relay skips only
   * the per-source spectator bound. Omitted means every request is checked per source.
   */
  readonly relayKey?: Uint8Array;
}

/** The comment line written when nothing else has been written for heartbeatMs. */
export const HEARTBEAT = ": keep-alive\n\n";
/** Separate the final flush from its data burst without changing the idle cadence. */
const FINAL_FLUSH_MS = 100;

/** One SSE message: the payload raw-deflated and base64-encoded on a data line. */
export function sseFrame(payload: Uint8Array): string {
  return `data: ${deflateRawSync(payload).toString("base64")}\n\n`;
}

/** The handover save part holding the stream's board and not-yet-released records. */
const STREAM_PART = "stream";
const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n);
  return b;
}

/**
 * The stream part, raw-deflated: the agents' stream indexes as JSON, the board as a format.ts message, the
 * record count, then each record as its wall release time (f64, NaN for none) and a format.ts
 * message; the JSON and every message are prefixed by their u32 byte length.
 */
async function encodeStreamPart(agents: readonly (readonly [string, number])[], board: StreamMessage,
  queue: readonly { readonly record: TickRecord; readonly releaseAt: number | undefined }[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const add = (bytes: Uint8Array) => chunks.push(u32(bytes.length), bytes);
  add(Buffer.from(JSON.stringify(agents), "utf8"));
  add(encodeMessage(board));
  chunks.push(u32(queue.length));
  for (const { record, releaseAt } of queue) {
    const at = Buffer.allocUnsafe(8);
    at.writeDoubleLE(releaseAt ?? Number.NaN);
    chunks.push(at);
    add(encodeMessage({ tick: record.tick, ants: record.ants, full: null, events: record.events }));
  }
  return deflate(Buffer.concat(chunks));
}

function invalidSave(detail: string): Error {
  return new Error(`Invalid spectator stream save: ${detail}`);
}

/** The stream side of a handover save, checked against the match it resumes. */
async function readStreamSave(save: HubSave, state: SimState): Promise<{ access: MatchAccess | undefined; resume: StreamResume }> {
  const meta = save.meta.stream as Partial<StreamSaveMeta> | undefined;
  if (typeof meta !== "object" || meta === null || meta.format !== 1) throw invalidSave("unknown format");
  const { identity, startedAt, tick, released, delaySeconds, nextStartMs } = meta;
  if (!Number.isSafeInteger(identity) || identity! < 1 || identity! >= 2 ** 48) throw invalidSave("identity");
  if (!Number.isFinite(startedAt) || !Number.isFinite(delaySeconds) || delaySeconds! < 0) throw invalidSave("start time or delay");
  if (typeof released !== "boolean" || (nextStartMs !== null && !Number.isFinite(nextStartMs))) throw invalidSave("playback position");
  if (tick !== state.tick || state.result !== null) throw invalidSave(`saved at tick ${String(tick)}, resuming a running match at tick ${state.tick}`);
  const access = meta.access === null || meta.access === undefined ? undefined : captureMatchAccess(meta.access);
  const part = save.parts.get(STREAM_PART);
  if (part === undefined) throw invalidSave("no stream part");

  const bytes = await inflate(part);
  let o = 0;
  const need = (n: number) => { if (o + n > bytes.length) throw invalidSave("truncated"); };
  const take = (): Uint8Array => {
    need(4);
    const n = bytes.readUInt32LE(o);
    o += 4;
    need(n);
    o += n;
    return bytes.subarray(o - n, o);
  };
  const agents: unknown = JSON.parse(Buffer.from(take()).toString("utf8"));
  if (!Array.isArray(agents) || !agents.every(a => Array.isArray(a) && a.length === 2 && typeof a[0] === "string" && Number.isSafeInteger(a[1]))) {
    throw invalidSave("agents");
  }
  // Copied into its own memory (Buffer.slice would share the whole inflated part): the starting board outlives the rest of the part.
  const boardBytes = new Uint8Array(take());
  const board = decodeMessage(boardBytes);
  if (board.full === null) throw invalidSave("board");
  need(4);
  const count = bytes.readUInt32LE(o);
  o += 4;
  const queue: { record: TickRecord; releaseAt: number | undefined }[] = [];
  let last = released ? board.tick : -1;
  for (let i = 0; i < count; i++) {
    need(8);
    const at = bytes.readDoubleLE(o);
    o += 8;
    const message = decodeMessage(take());
    if (message.full !== null || message.tick <= last) throw invalidSave("records out of order");
    last = message.tick;
    queue.push({ record: { tick: message.tick, ants: message.ants, events: message.events }, releaseAt: Number.isNaN(at) ? undefined : at });
  }
  if (o !== bytes.length) throw invalidSave("trailing bytes");
  if (last !== tick || (!released && queue[0]?.record.tick !== board.tick)) throw invalidSave("records do not reach the saved tick");

  const full = board.full;
  return { access, resume: {
    identity: identity!, startedAt: startedAt!, delaySeconds: delaySeconds!, nextStartMs: nextStartMs ?? null,
    released: released ? new SpectatorState(full, board.tick, board.ants) : null,
    queue,
    recorder: { setup: full.setup, agents, ants: queue.at(-1)?.record.ants ?? board.ants,
      initialFull: released ? null : () => decodeMessage(boardBytes).full! },
  } };
}

interface Spectator {
  readonly res: ServerResponse;
  readonly stream: MatchStream;
  needsFull: boolean;
  timer: unknown;
  finalFlushTimer: unknown;
}

/**
 * One match stream's side of a handover save: JSON-safe meta and bulky parts by name
 * ([a-z0-9-]{1,64}). meta.stream and the part named stream are the live stream's; meta.recording
 * and parts named recording-* belong to the match's recording.
 */
export interface HubSave {
  readonly meta: { readonly [key: string]: unknown };
  readonly parts: Map<string, Uint8Array>;
}

/** meta.stream: everything about the stream that is not bulky. */
interface StreamSaveMeta {
  readonly format: 1;
  /** Kept, so a reconnecting browser sees the same match (web/src/buffer.ts sameMatch). */
  readonly identity: number;
  readonly startedAt: number;
  /** The last tick pushed: the match's tick at the save. */
  readonly tick: number;
  /** False while no record has been released: the saved board is then the match's starting board. */
  readonly released: boolean;
  /** The release rule: how far playback runs behind the match. */
  readonly delaySeconds: number;
  readonly nextStartMs: number | null;
  readonly access: MatchAccess | null;
}

/** A stream restored from its save, for the MatchStream that carries it on. */
interface StreamResume {
  readonly identity: number;
  readonly startedAt: number;
  readonly delaySeconds: number;
  readonly nextStartMs: number | null;
  readonly released: SpectatorState | null;
  /** Not-yet-released records in tick order, each with its wall-clock release time when the stream has access. */
  readonly queue: readonly { readonly record: TickRecord; readonly releaseAt: number | undefined }[];
  readonly recorder: RecorderResume;
}

class MatchStream {
  readonly seq: number;
  readonly access: Readonly<MatchAccess> | undefined;
  readonly startedAt: number;
  private readonly releaseAt = new WeakMap<TickRecord, number>();
  /**
   * The match as full snapshots name it (format.ts StreamFull.match): random, so
   * it differs across server restarts, where seq starts again at 1, and
   * kept when a handover moves the match to another server.
   */
  readonly identity: number;
  private readonly recorder: SpectatorRecorder;
  private readonly recording: ReplayRecording | null;
  /** Board at the delayed playback position; null until the first record is released. */
  private released: SpectatorState | null = null;
  /** Records not yet released, in tick order. Releasing one writes it. */
  private readonly queue: TickRecord[] = [];
  private readonly delaySeconds: number;
  private readonly delayTicks: number;
  private readonly delayMs: number;
  private readonly tickMs: number;
  private latestTick: number;
  private ended = false;
  private closed = false;
  /** Saved for a handover: nothing more is released or pushed here; the next server carries the stream on. */
  private frozen = false;
  private ratingChanges: readonly StreamRatingChange[] | undefined;
  private readingRatings = false;
  /** Clock time at which the final tick was pushed. */
  private endedAt = 0;
  private nextStartMs: number | null = null;
  /** Releases this stream's hold on the server's activity; null when the hub has none. */
  private readonly releasePlayback: (() => void) | null;
  /** The one pending drain timer: the queue head's due time, or when the byte window frees. */
  private timer: unknown = null;
  /** Tick-message bytes this match released in the last second, counted once per match. */
  private readonly window: { t: number; bytes: number }[] = [];
  private windowBytes = 0;
  readonly spectators = new Set<Spectator>();
  private readonly hub: LiveHub;

  /**
   * With resume, state is the match at the saved tick and the stream carries on from its save;
   * recording is that save's recording side (meta.recording and its recording-* parts), continued here.
   */
  constructor(hub: LiveHub, seq: number, state: SimState, access?: MatchAccess, identity?: SpectatorPlayerOptions["identity"], houseIdle?: SpectatorPlayerOptions["houseIdle"],
    resume?: StreamResume, recording?: { readonly meta: unknown; readonly parts: ReadonlyMap<string, Uint8Array> }) {
    this.hub = hub;
    this.seq = seq;
    this.access = access === undefined ? undefined : captureMatchAccess(access);
    this.identity = resume?.identity ?? randomInt(1, 2 ** 48);
    this.startedAt = resume?.startedAt ?? hub.clock.now();
    this.recorder = new SpectatorRecorder(state, { rated: this.access?.rated, identity,
      // Every live match carries its accepted-call idle clock; the Model Index is marked explicitly.
      ...(houseIdle === undefined ? {} : { houseIdle, modelIndex: this.access !== undefined && isHouseMatch(this.access) }) }, resume?.recorder);
    const store = this.access?.visibility === "private" ? hub.privateReplayStore?.(this.access.lobbyId) : hub.replayStore;
    // A recording started part-way through a match would publish a replay of only that part:
    // a resumed stream records only by continuing the saved recording.
    this.recording = store === undefined || (resume !== undefined && recording === undefined) ? null
      // Lobby servers share storage: process-local sequence numbers collide across instances.
      // The already-random match identity fits the existing positive-integer replay-id format.
      : new ReplayRecording(this.startedAt, this.access === undefined ? seq : this.identity, store, undefined, { includeComparisonSetup: hub.includeComparisonSetup,
        onBinarySaved: id => hub.savedReplay(seq, this.identity, id, this.access),
        handoff: hub.recordHandoff, lobbyId: this.access?.visibility === "private" ? this.access.lobbyId : null,
        ...(hub.captureMatchLogs ? { logHeader: headerLine(state.seed, state.config) } : {}), resume: recording });
    // House matches are live even under the default (or a larger configured) delay.
    // All other matches retain the configured floor and rated/unrated minimums.
    // A resumed stream keeps the delay it was saved with.
    const delay = resume?.delaySeconds ?? (this.access === undefined ? hub.config.delaySeconds
      : isHouseMatch(this.access) ? 0 : Math.max(hub.config.delaySeconds, spectatorDelaySeconds(this.access)));
    this.delaySeconds = delay;
    this.delayTicks = Math.round(delay * state.config.ticksPerSecond);
    this.delayMs = Math.max(delay * 1000, this.delayTicks * (hub.playoutMs ?? 1000 / state.config.ticksPerSecond));
    this.tickMs = 1000 / state.config.ticksPerSecond;
    this.latestTick = state.tick;
    if (resume !== undefined) {
      this.released = resume.released;
      this.nextStartMs = resume.nextStartMs;
      for (const { record, releaseAt } of resume.queue) {
        this.queue.push(record);
        if (releaseAt !== undefined) this.releaseAt.set(record, releaseAt);
      }
    } else {
      const initial = this.recorder.initial();
      this.queue.push(initial);
      if (this.recording?.capturesInputs) this.recording.capture(this.hub.payload({ ...initial, full: { ...this.recorder.initialFull(), match: this.identity } }));
      if (this.access) this.releaseAt.set(initial, this.startedAt + spectatorDelaySeconds(this.access) * 1000);
    }
    this.releasePlayback = hub.activity?.hold(`delayed playback of match ${seq}`) ?? null;
    this.drain();
  }

  /** True once every record, the final one included, has been released. */
  get finished(): boolean {
    return this.ended && this.queue.length === 0;
  }

  push(out: StepOutput): void {
    if (this.ended) throw new Error(`match ${this.seq} has ended`);
    if (this.frozen) throw new Error(`match ${this.seq} has been saved for a handover`);
    const rec = this.recorder.record(out);
    this.latestTick = rec.tick;
    if (this.recording?.capturesInputs) this.recording.capture(this.hub.payload({ ...rec, full: null, events: rec.events.map(event => event.kind === "end"
      ? { ...event, result: { ...event.result, nextStartMs: this.nextStartMs } } : event) }));
    if (out.state.result !== null) {
      this.ended = true;
      this.endedAt = this.hub.clock.now();
      this.recording?.ended(this.endedAt, { publishAfter: this.endedAt + this.delayMs, rated: out.state.result.reason === "abandoned" ? false : this.access?.rated ?? false });
    }
    this.queue.push(rec);
    if (this.access) this.releaseAt.set(rec, this.hub.clock.now() + spectatorDelaySeconds(this.access) * 1000);
    this.drain();
  }

  appendLog(line: string): void { this.recording?.appendLog(line); }

  setNextStart(at: Date | null): void {
    this.nextStartMs = at === null ? null : at.getTime();
  }

  /**
   * The recording's part of this stream's handover save: meta.recording and its recording-* parts.
   * The recording is inert here afterwards; a stream without one adds nothing. A rejection is a failed save.
   */
  async saveRecording(meta: Record<string, unknown>, parts: Map<string, Uint8Array>): Promise<void> {
    if (this.recording === null) return;
    const saved = await this.recording.save();
    meta.recording = saved.meta;
    for (const [name, bytes] of saved.parts) parts.set(name, bytes);
  }

  /**
   * Milliseconds until a record is due. While the match runs, record r is due
   * once tick r + delayTicks has been pushed (Infinity until then). After the
   * end the remaining records play out where the match's own ticks would have
   * put them, had it gone on: delayTicks + r - final ticks after the end. In a
   * match shorter than the delay the first record is still due a whole delay
   * after its own tick.
   */
  private dueIn(rec: TickRecord): number {
    const wallDelay = Math.max(0, (this.releaseAt.get(rec) ?? 0) - this.hub.clock.now());
    if (rec.tick + this.delayTicks <= this.latestTick) return wallDelay;
    if (!this.ended) return Number.POSITIVE_INFINITY;
    const step = this.hub.playoutMs ?? this.tickMs;
    return Math.max(wallDelay, this.endedAt + (rec.tick + this.delayTicks - this.latestTick) * step - this.hub.clock.now());
  }

  /**
   * Release every due record at the head of the queue, in order, as long as
   * this match's tick messages over the last second stay within
   * paceBytesPerSecond. On time the stream sits far below it; after a stall
   * (a late push burst, or overdue playout timers) the backlog goes out at the
   * budget and drains, since the budget is well above the stream's own rate.
   * Otherwise one timer waits for the head's due time or for the window to free.
   */
  private drain(): void {
    if (this.timer !== null) this.hub.clock.clearTimeout(this.timer);
    this.timer = null;
    while (this.queue.length > 0 && !this.frozen) {
      const rec = this.queue[0]!;
      const due = this.dueIn(rec);
      if (due === Number.POSITIVE_INFINITY) return;
      if (due > 0) return this.wake(due);
      const now = this.hub.clock.now();
      while (this.window.length > 0 && this.window[0]!.t <= now - 1000) this.windowBytes -= this.window.shift()!.bytes;
      let events = rec.events;
      if (events.some((e) => e.kind === "end")) {
        if (!events.some(e => e.kind === "end" && e.result.reason === "abandoned") && this.access?.rated && this.hub.resultRatings && this.ratingChanges === undefined) {
          if (!this.readingRatings) {
            this.readingRatings = true;
            void this.hub.resultRatings(this.access, this.released?.full.agents ?? []).then(changes => {
              if (changes !== null) this.ratingChanges = changes;
            }).catch(() => {}).finally(() => {
              this.readingRatings = false;
              if (!this.closed) { if (this.ratingChanges === undefined) this.wake(1000); else this.drain(); }
            });
          }
          return;
        }
        // Neither the final result nor its ratings move ahead of the delayed final tick.
        events = events.map((e) => (e.kind === "end" ? { kind: "end", result: { ...e.result, nextStartMs: this.nextStartMs,
          ...(this.ratingChanges === undefined ? {} : { ratingChanges: this.ratingChanges }) } } : e));
      }
      const record = { tick: rec.tick, ants: rec.ants, events };
      const payload = this.hub.payload({ tick: record.tick, ants: record.ants, full: null, events: record.events });
      const delta = sseFrame(payload);
      // An empty window always admits one record, so a message larger than the budget cannot stall the stream.
      if (this.window.length > 0 && this.windowBytes + delta.length > this.hub.config.paceBytesPerSecond) {
        return this.wake(this.window[0]!.t + 1000 - now);
      }
      this.queue.shift();
      this.window.push({ t: now, bytes: delta.length });
      this.windowBytes += delta.length;
      this.release(record, delta, payload);
    }
  }

  private wake(ms: number): void {
    if (this.frozen) return;
    this.timer = this.hub.clock.setTimeout(() => {
      this.timer = null;
      this.drain();
    }, ms);
  }

  private release(record: TickRecord, delta: string, payload: Uint8Array): void {
    const first = this.released === null;
    if (this.released === null) {
      this.released = new SpectatorState(this.recorder.initialFull(), record.tick, record.ants);
      if (record.events.length > 0) this.released.apply(record);
    } else {
      this.released.apply(record);
    }
    let full: string | null = null;
    if (this.recording !== null) {
      if (first) {
        const opening = this.fullPayload(this.released);
        this.recording.append(opening);
        full = sseFrame(opening);
      } else {
        this.recording.append(payload);
      }
    }
    for (const s of this.spectators) {
      if (s.needsFull) {
        full ??= this.fullFrame(this.released);
        this.hub.write(s, full);
        s.needsFull = false;
      } else {
        this.hub.write(s, delta);
      }
      // A dropped slow reader must not be written to or have its timer re-armed.
      if (record.events.some(event => event.kind === "end") && this.spectators.has(s)) this.hub.flushFinal(s);
    }
    if (this.finished) {
      if (this.access) this.hub.playbackFinished(this.access);
      if (this.recording !== null) {
        // Held until the save settles; its replay-saved publication opens its own hold before this one is released.
        const saved = this.hub.activity?.hold(`match ${this.seq} recording save`);
        void this.recording.finish().finally(saved);
      }
      // Last, so any hold the finish work above opens is already open.
      this.releasePlayback?.();
    }
  }

  /** The full snapshot at the delayed playback position, naming this match by its identity. */
  private fullFrame(released: SpectatorState): string {
    return sseFrame(this.fullPayload(released));
  }

  private fullPayload(released: SpectatorState): Uint8Array {
    const m = released.message();
    return this.hub.payload({ ...m, full: { ...m.full!, match: this.identity } });
  }

  attach(s: Spectator): void {
    this.spectators.add(s);
    if (this.released !== null) {
      this.hub.write(s, this.fullFrame(this.released));
      if (this.released.full.result !== null && this.spectators.has(s)) this.hub.flushFinal(s);
      s.needsFull = false;
    }
  }

  /**
   * The handover save step's stream side, after the last pushed tick. Releasing stops here for good,
   * so no spectator of this server gets ahead of where the next server's stream starts.
   */
  async save(): Promise<HubSave> {
    if (this.ended) throw new Error(`match ${this.seq} has ended`);
    this.frozen = true;
    if (this.timer !== null) this.hub.clock.clearTimeout(this.timer);
    this.timer = null;
    const meta: StreamSaveMeta = { format: 1, identity: this.identity, startedAt: this.startedAt, tick: this.latestTick,
      released: this.released !== null, delaySeconds: this.delaySeconds, nextStartMs: this.nextStartMs, access: this.access ?? null };
    // Unreleased, the queue's head is the starting record and the board is the starting board.
    const board = this.released?.message() ?? { ...this.queue[0]!, full: this.recorder.initialFull(), events: [] };
    const part = await encodeStreamPart(this.recorder.agentIndexes(), board, this.queue.map(record => ({ record, releaseAt: this.releaseAt.get(record) })));
    const result = { meta: { stream: meta } as Record<string, unknown>, parts: new Map([[STREAM_PART, part]]) };
    await this.saveRecording(result.meta, result.parts);
    return result;
  }

  close(): void {
    this.closed = true;
    this.recording?.discard();
    if (this.timer !== null) this.hub.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const s of [...this.spectators]) this.hub.detach(this, s, true);
    this.releasePlayback?.();
  }
}

/**
 * All live match streams. mount handle() under /live: GET /live/:match serves
 * that match (its sequence number), and GET /live/current serves the match
 * whose delayed playback is still running, or else the newest.
 */
export class LiveHub {
  readonly config: LiveConfig;
  readonly clock: LiveClock;
  readonly playoutMs: number | undefined;
  readonly replayStore: ReplayStore | undefined;
  readonly includeComparisonSetup: boolean;
  readonly captureMatchLogs: boolean;
  readonly privateReplayStore: LiveHubOptions["privateReplayStore"];
  readonly recordHandoff: RecordHandoff | undefined;
  readonly resultRatings: LiveHubOptions["resultRatings"];
  readonly activity: Activity | undefined;
  private readonly requireMatchAccess: boolean;
  private readonly currentInvite: CurrentInvite;
  private readonly onPlaybackFinished: LiveHubOptions["onPlaybackFinished"];
  private readonly onReplaySaved: LiveHubOptions["onReplaySaved"];
  private readonly encode: (message: StreamMessage) => Uint8Array;
  private readonly keepMatches: number;
  private readonly relayKey: Uint8Array | undefined;
  /** Live spectator streams open at once on this server, and per source. */
  readonly spectatorCap: AdmissionCap;
  private readonly streams = new Map<number, MatchStream>();
  private readonly replays = new Map<number, { seq: number; match: number; replayId: string }>();
  private closed = false;

  constructor(options: LiveHubOptions = {}) {
    this.config = options.config ?? DEFAULT_LIVE_CONFIG;
    this.clock = options.clock ?? realClock;
    this.encode = options.encode ?? encodeMessage;
    this.playoutMs = options.playoutMs;
    this.keepMatches = options.keepMatches ?? 3;
    this.replayStore = options.replayStore;
    this.includeComparisonSetup = options.includeComparisonSetup === true;
    this.captureMatchLogs = options.captureMatchLogs === true;
    this.privateReplayStore = options.privateReplayStore;
    this.recordHandoff = options.recordHandoff;
    this.resultRatings = options.resultRatings;
    this.activity = options.activity;
    this.requireMatchAccess = options.requireMatchAccess === true;
    this.currentInvite = options.currentInvite ?? (async () => false);
    this.onPlaybackFinished = options.onPlaybackFinished;
    this.onReplaySaved = options.onReplaySaved;
    this.relayKey = options.relayKey;
    this.spectatorCap = createAdmissionCap("live spectators", { max: this.config.maxSpectators, perSource: this.config.maxSpectatorsPerSource });
  }

  /** Begin streaming a match from its starting state (tick 0, before any step). */
  startMatch(seq: number, state: SimState, access?: MatchAccess, identity?: SpectatorPlayerOptions["identity"], houseIdle?: SpectatorPlayerOptions["houseIdle"]): void {
    if (this.requireMatchAccess && access === undefined) throw new Error("Match access metadata required");
    this.add(seq, access, () => new MatchStream(this, seq, state, access, identity, houseIdle));
  }

  /**
   * The handover save step's stream side of match seq, after its last pushed tick. The stream
   * stops releasing at once and for good; recording, upload, record handoff and playback-finished
   * publication are left to the server that resumes it. Rejects on any failure.
   */
  async saveMatch(seq: number): Promise<HubSave> {
    return this.stream(seq).save();
  }

  /**
   * Carry on a match saved by saveMatch on another server, as match seq of this one: state is the
   * match at the saved tick, and the next pushTick is the tick after it. The stream keeps its identity,
   * start time, delay and playback position. Rejects when the save cannot be restored.
   */
  async resumeMatch(seq: number, state: SimState, save: HubSave, identity?: SpectatorPlayerOptions["identity"], houseIdle?: SpectatorPlayerOptions["houseIdle"]): Promise<void> {
    const { access, resume } = await readStreamSave(save, state);
    if (this.requireMatchAccess && access === undefined) throw new Error("Match access metadata required");
    const recording = save.meta.recording === undefined ? undefined : { meta: save.meta.recording, parts: save.parts };
    this.add(seq, access, () => new MatchStream(this, seq, state, access, identity, houseIdle, resume, recording));
  }

  private add(seq: number, access: MatchAccess | undefined, create: () => MatchStream): void {
    if (this.streams.has(seq)) throw new Error(`match ${seq} is already streaming`);
    if (access && this.byLobby(access.lobbyId)) throw new Error("Lobby is already streaming");
    this.streams.set(seq, create());
    const done = [...this.streams.values()].filter((m) => m.finished && m.seq !== seq).sort((a, b) => a.seq - b.seq);
    while (this.streams.size > this.keepMatches && done.length > 0) {
      const old = done.shift()!;
      old.close();
      this.streams.delete(old.seq);
    }
  }

  /** Recording-only inputs, not spectator payloads or agent-facing state. */
  appendLog(seq: number, line: string): void { this.stream(seq).appendLog(line); }

  /** One step's output for a streaming match, in tick order. */
  pushTick(seq: number, out: StepOutput): void {
    this.stream(seq).push(out);
  }

  /** The next match's start, delivered with this match's result. */
  setNextStart(seq: number, at: Date | null): void {
    this.stream(seq).setNextStart(at);
  }

  /** The match /live/current serves: the oldest whose playback is still running, else the newest. */
  currentSeq(): number | null {
    const all = [...this.streams.values()].filter(m => m.access === undefined || m.access.visibility === "public").sort((a, b) => a.seq - b.seq);
    return (all.find((m) => !m.finished) ?? all.at(-1))?.seq ?? null;
  }

  /** Public lifecycle follows delayed playback, never the live result or its winner. */
  status(): { kind: "idle"; match: null } | { kind: "playing"; match: number } {
    const seq = this.currentSeq();
    const stream = seq === null ? undefined : this.streams.get(seq);
    return stream === undefined || stream.finished ? { kind: "idle", match: null } : { kind: "playing", match: stream.identity };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path === "/live/status") {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(this.status()));
      return;
    }
    if (path === "/live/replays") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      // Only successful uploads enter this map; without a store the list stays empty.
      // Retain small metadata after stream eviction; never list the bucket or overwrite an index.
      const body = Buffer.from(JSON.stringify({ replays: [...this.replays.values()].sort((a, b) => a.seq - b.seq) }));
      res.writeHead(200, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    const m = /^\/live\/(current|\d+)\/?$/.exec(path);
    const selected = /^\/watch\/live\/([^/]+)$/.exec(path);
    if ((m === null && selected === null) || req.method !== "GET") {
      res.writeHead(m === null && selected === null ? 404 : 405).end();
      return;
    }
    let stream: MatchStream | undefined;
    if (selected) {
      try { stream = this.byLobby(decodeURIComponent(selected[1]!)); }
      catch { res.writeHead(400).end(); return; }
    } else {
      const seq = m![1] === "current" ? this.currentSeq() : Number(m![1]);
      stream = seq === null ? undefined : this.streams.get(seq);
    }
    if (stream === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (stream.access) {
      const raw = req.headers["x-antwar-invite"];
      const admission = await admitMatchWatch(stream.access, typeof raw === "string" ? raw : undefined, this.currentInvite);
      if (res.destroyed) return;
      if (this.closed || this.streams.get(stream.seq) !== stream) {
        res.writeHead(404, { "cache-control": "no-store" }).end();
        return;
      }
      if (admission !== "allowed") {
        res.writeHead(admission === "unavailable" ? 503 : 404, { "cache-control": "no-store" }).end();
        return;
      }
    }
    // A relay the entry signed for this lobby is bounded per viewer source there; here it counts
    // only toward the overall cap. Any other signature is treated as none: never a refusal reason.
    const relayed = selected !== null && stream.access !== undefined && verifyRelay(this.relayKey, stream.access.lobbyId, req.headers[RELAY_HEADER]);
    const release = this.spectatorCap.take(relayed ? EXEMPT : clientSource(req.headers));
    if (release === null) {
      refuseBusy(res);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": stream.access?.visibility === "private" ? "private, no-store, no-transform" : "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-antwar-match": String(stream.seq),
    });
    res.flushHeaders();
    const s: Spectator = { res, stream, needsFull: true, timer: null, finalFlushTimer: null };
    // An intermediary may hold the headers until the first body byte, which the delay can postpone for minutes.
    this.write(s, HEARTBEAT);
    req.on("close", () => {
      release();
      this.detach(stream, s, false);
    });
    stream.attach(s);
  }

  close(): void {
    this.closed = true;
    for (const m of this.streams.values()) m.close();
    this.streams.clear();
  }

  /** @internal */
  frame(message: StreamMessage): string {
    return sseFrame(this.payload(message));
  }

  /** @internal Encoded public payload; recording never changes what the stream writes. */
  payload(message: StreamMessage): Uint8Array {
    return this.includeComparisonSetup ? this.encode(message) : encodePublicMessage(message, this.encode);
  }

  /** @internal Publish only successful public uploads; private references stay behind authorization. */
  savedReplay(seq: number, match: number, replayId: string, access?: MatchAccess): void {
    if (this.closed) return;
    if (access?.visibility !== "private") this.replays.set(seq, { seq, match, replayId });
    if (access) this.onReplaySaved?.(access, replayId);
  }

  /** @internal Called only when the actual delayed final frame has been released. */
  playbackFinished(access: MatchAccess): void { this.onPlaybackFinished?.(access); }

  catalogMatches(): readonly CatalogMatch[] {
    return [...this.streams.values()].flatMap(stream => stream.access === undefined ? [] : [{
      ...stream.access, startedAt: stream.startedAt, playbackFinished: stream.finished,
    }]);
  }

  watchStatus(lobbyId: string): MatchWatchStatus | null {
    const stream = this.byLobby(lobbyId);
    return stream?.access ? matchWatchStatus(stream.access, stream.finished ? "finished" : "started") : null;
  }

  hasLobby(lobbyId: string): boolean { return this.byLobby(lobbyId) !== undefined; }

  private byLobby(lobbyId: string): MatchStream | undefined {
    return [...this.streams.values()].find(stream => stream.access?.lobbyId === lobbyId);
  }

  /**
   * @internal Every write is one complete SSE message; each re-arms the
   * heartbeat. A spectator that has stopped reading is dropped once its unsent
   * data (Node's buffered bytes for the response, its socket included) passes
   * maxUnsentBytes: destroy, not end, so the queue is freed now rather than
   * written out first. Its client reconnects to a full snapshot.
   */
  write(s: Spectator, text: string, rearmHeartbeat = true): void {
    s.res.write(text);
    if (s.res.writableLength > this.config.maxUnsentBytes) {
      this.detach(s.stream, s, false);
      s.res.destroy();
      return;
    }
    if (rearmHeartbeat) this.arm(s);
  }

  /** @internal One bounded follow-up write: an immediate comment can share the
   * final data's network burst and remain stranded in a WebKit fetch reader.
   * The match then has nothing more to send, so the response ends after that
   * follow-up rather than idling on heartbeats until eviction. */
  flushFinal(s: Spectator): void {
    this.write(s, HEARTBEAT);
    if (!s.stream.spectators.has(s)) return;
    if (s.finalFlushTimer !== null) this.clock.clearTimeout(s.finalFlushTimer);
    s.finalFlushTimer = this.clock.setTimeout(() => {
      s.finalFlushTimer = null;
      if (!s.stream.spectators.has(s)) return;
      this.write(s, HEARTBEAT, false);
      // A slow reader dropped by that write has already been destroyed.
      if (s.stream.spectators.has(s)) this.detach(s.stream, s, true);
    }, FINAL_FLUSH_MS);
  }

  /** @internal */
  detach(stream: MatchStream, s: Spectator, end: boolean): void {
    if (s.timer !== null) this.clock.clearTimeout(s.timer);
    if (s.finalFlushTimer !== null) this.clock.clearTimeout(s.finalFlushTimer);
    s.timer = null;
    s.finalFlushTimer = null;
    stream.spectators.delete(s);
    if (end) s.res.end();
  }

  private arm(s: Spectator): void {
    if (s.timer !== null) this.clock.clearTimeout(s.timer);
    s.timer = this.clock.setTimeout(() => {
      s.timer = null;
      this.write(s, HEARTBEAT);
    }, this.config.heartbeatMs);
  }

  private stream(seq: number): MatchStream {
    const s = this.streams.get(seq);
    if (s === undefined) throw new Error(`match ${seq} is not streaming`);
    return s;
  }
}
