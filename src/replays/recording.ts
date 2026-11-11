/// <reference types="node" />
import { decodeMessage, encodeReplayMessage } from "../live/format.js";
import { isReplayId } from "./access.js";
import { GzipFrames, joinGzip } from "./pack.js";
import { ReplayCreateError, type ReplayStore } from "./store.js";
import type { RecordHandoff } from "../records/handoff.js";
import type { StartRating } from "./history.js";

/** Public, restart-safe name; neither the simulation seed nor an agent id. */
export function replayId(startedAt: number, seq: number): string {
  return `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${seq}`;
}

/**
 * One seat's call as the match recording stores it: the tool, its stored arguments and its stored reply
 * (src/mcp/replies.ts storedArguments and storedReply), in that field order.
 */
export type ReplyEntry = { readonly tool: string } & Readonly<Record<string, unknown>>;

const REPLY_LINE_PREFIX = '{"type":"reply",';

/** A reply line: one JSON object, type "reply", the seat's agentId, the match tick it was answered at (null before the match began), then the entry. */
export function replyLine(agentId: string, tick: number | null, entry: ReplyEntry): string {
  return JSON.stringify({ type: "reply", agentId, tick, ...entry });
}

const TEXT_LINE_PREFIX = '{"type":"text","digest":"';
const DIGEST_CHARS = 64;

/**
 * A text line: text served to the match's agents (src/mcp/replies.ts ServedText: rules text, join briefing or tool
 * descriptions), whole and uncapped. The recording keeps the first line of each digest and drops the rest, so each
 * text is carried once per match; reply entries name it by digest, after it.
 */
export function textLine(text: { readonly kind: string; readonly digest: string; readonly text: string }): string {
  if (!/^[0-9a-f]{64}$/.test(text.digest)) throw new Error("served text digest must be SHA-256 hex");
  return JSON.stringify({ type: "text", digest: text.digest, kind: text.kind, text: text.text });
}

const textDigestOf = (line: string): string | undefined =>
  line.startsWith(TEXT_LINE_PREFIX) ? line.slice(TEXT_LINE_PREFIX.length, TEXT_LINE_PREFIX.length + DIGEST_CHARS) : undefined;

/** One call recorded as a stub rather than an entry: what it was, never what it carried. */
export interface StubCall {
  readonly tool: string;
  readonly receivedAt: number;
  readonly answeredAt: number;
  /** The reply's error code; sdk_error for an error the MCP SDK formed itself; null for a call that succeeded. */
  readonly code: string | null;
}

const STUB_LINE_PREFIX = '{"type":"stub",';
/** At most this many stubs a seat's recording keeps per rolling STUB_WINDOW_MS; the calls beyond only raise its omitted count. */
export const STUBS_PER_WINDOW = 2;
const STUB_WINDOW_MS = 1000;

/**
 * A stub line as the game hands it on: type "stub", the seat's agentId, the match tick (null before the match began),
 * then the call. The recording adds omitted, the exact count of that seat's calls it left out since its previous stub.
 * A stub held before its match began may already carry omitted: the calls the game left out while holding them
 * (Game.recordReply), which the recording adds to its own count.
 */
export function stubLine(agentId: string, tick: number | null, call: StubCall, omitted?: number): string {
  return JSON.stringify({ type: "stub", agentId, tick, tool: call.tool, receivedAt: call.receivedAt, answeredAt: call.answeredAt, code: call.code,
    ...(omitted === undefined ? {} : { omitted }) });
}

/**
 * The stub rule: a stub answered at `at` is kept while its seat has kept fewer than STUBS_PER_WINDOW in the
 * STUB_WINDOW_MS before it; a kept one's time is added to kept. The recording and the game's held calls apply this one rule.
 */
export function keepsStub(seat: { kept: number[] }, at: number): boolean {
  seat.kept = seat.kept.filter(t => at - t < STUB_WINDOW_MS);
  if (seat.kept.length >= STUBS_PER_WINDOW) return false;
  seat.kept.push(at);
  return true;
}

/**
 * The most a seat's record may hold: the UTF-8 bytes of every entry and stub
 * line recorded for it, closing stub included, each counted with the one separator byte it takes in the stored array.
 * Served text lines are the match's, once each, and are not a seat's.
 */
export const SEAT_RECORD_BUDGET_BYTES = 36_000_000;
/**
 * Kept free under the budget for the seat's one closing stub: more than any stub line takes (a tool name of at most
 * 101 characters, each escaped to at most 6 bytes, plus fixed fields of under 300 bytes).
 */
export const CLOSING_STUB_RESERVE_BYTES = 1024;

/**
 * A seat's record so far: the answer times of its stubs kept in the last window, the calls left out since its last
 * kept stub, and the bytes its lines take (SEAT_RECORD_BUDGET_BYTES). spent, once a line would not fit the budget:
 * from then on every call of the seat is only counted, and its last is the seat's one final stub.
 */
interface SeatStubs {
  kept: number[];
  omitted: number;
  /** The last call left out, as handed on: written as the closing stub when the record input is handed off. */
  last: Record<string, unknown> | null;
  bytes: number;
  spent: boolean;
}

/** The bytes a line takes in a seat's budget: its UTF-8 bytes and its separator in the stored array. */
const lineCost = (line: string): number => Buffer.byteLength(line) + 1;

/** The agentId of an entry or stub line (both name it second, as replyLine and stubLine write it); undefined for any other line. */
function lineAgentId(line: string): string | undefined {
  const prefix = line.startsWith(REPLY_LINE_PREFIX) ? REPLY_LINE_PREFIX : line.startsWith(STUB_LINE_PREFIX) ? STUB_LINE_PREFIX : undefined;
  if (prefix === undefined) return undefined;
  const start = prefix.length + '"agentId":'.length;
  const end = line.indexOf('"', start + 1) + 1;
  // An id holding an escaped quote is read from the whole line.
  const id: unknown = line.startsWith('"agentId":"', prefix.length) && line[end - 2] !== "\\"
    ? JSON.parse(line.slice(start, end)) : (JSON.parse(line) as { agentId?: unknown }).agentId;
  return typeof id === "string" ? id : undefined;
}

/**
 * An entry as the stub it is counted as past the seat's budget: what the call was, never what it carried. Its code
 * is read from the stored reply as the game reads it from the reply (src/mcp/tools.ts stubCode): the error, or the
 * error's code, of an error reply; null otherwise.
 */
function entryStub(entry: Record<string, unknown>): Record<string, unknown> {
  return { type: "stub", agentId: entry.agentId, tick: entry.tick, tool: entry.tool, receivedAt: entry.receivedAt, answeredAt: entry.answeredAt, code: entryCode(entry) };
}

/** An entry's error code as its stub carries it: the reply's error or error.code when the call failed, else null. */
export function entryCode(entry: Readonly<Record<string, unknown>>): string | null {
  const error = entry.isError === true && typeof entry.reply === "object" && entry.reply !== null ? (entry.reply as { error?: unknown }).error : undefined;
  const code = typeof error === "string" ? error
    : typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
  return code;
}

/**
 * The recording side of a handover save: small JSON facts; each held copy's bytes travel in
 * its parts (recordingPart), never in this meta.
 */
export interface RecordingSaveMeta {
  readonly id: string;
  readonly endedAt: number | null;
  readonly checkpointed: boolean;
  readonly captureFailed: boolean;
  /**
   * How many parts hold the released copy and the private checkpoint copy, 0 for a copy not held:
   * a copy's bytes are its parts recordingPart(copy, 0), recordingPart(copy, 1)… in order.
   */
  readonly released: number;
  readonly checkpoint: number;
  /** Whether the input log lines are held, in the part RECORDING_PARTS.log. */
  readonly log: boolean;
  /** Whether call reply lines are held, in the part RECORDING_PARTS.replies; absent in saves that predate them, which hold none. */
  readonly replies?: boolean;
  /** Per seat with calls left out since its last stub: how many, and the last of them; absent when none. */
  readonly pendingStubs?: readonly { readonly agentId: string; readonly omitted: number; readonly last: string; readonly spent?: true }[];
}

export interface RecordingSave {
  readonly meta: RecordingSaveMeta;
  readonly parts: Map<string, Uint8Array>;
}

/** The copies' gzip bodies so far (each one or more gzip members, split into parts named by recordingPart) and the input log lines as UTF-8 JSON. */
export const RECORDING_PARTS = { released: "recording-released", checkpoint: "recording-checkpoint", log: "recording-log", replies: "recording-replies" } as const;

/**
 * The name of part index of a held copy. A late match's copies run to hundreds of megabytes, so each
 * travels as the blocks the server already holds it in (GZIP_BLOCK_BYTES each, the last shorter), never copied whole.
 */
export function recordingPart(copy: "released" | "checkpoint", index: number): string {
  // RECORDING_PARTS.replies is a single part, like the log.
  return `${RECORDING_PARTS[copy]}-${index}`;
}

/**
 * Optional, one per match. Released payloads form the normal replay; a separate
 * match-end checkpoint captures unreleased frames privately for crash recovery.
 * Public full messages are re-encoded to remove comparison-only setup metadata;
 * explicit comparison recordings and deltas retain their bytes. Compression
 * runs in zlib's worker pool; the released and checkpoint copies are each held compressed as their frames arrive.
 * A match handed over to another server continues its one recording there: save() on the old
 * server, the resume option on the new one; each copy's earlier bytes are held as they were saved.
 */
export class ReplayRecording {
  readonly id: string;
  /** The released copy; null once handed to upload, failed or discarded. */
  private released: GzipFrames | null = null;
  /** The released copy's bytes recorded before the last handover, in order; released holds the frames since. */
  private releasedBefore: Uint8Array[] = [];
  /** The private checkpoint copy; only allocated with a log and private handoff, null once handed off, failed or discarded. */
  private checkpoint: GzipFrames | null = null;
  private checkpointBefore: Uint8Array[] = [];
  private checkpointed = false;
  private captureFailed = false;
  private done = false;
  private logLines: string[] | undefined;
  /**
   * The seats' call reply lines, in call order, held exactly when the input log lines are, and handed off with
   * them; undefined once handed off, so a later call is not recorded.
   */
  private replyLines: string[] | undefined;
  /** The digests of the text lines in replyLines: a text line already held is not held again. */
  private readonly textDigests = new Set<string>();
  /** Per seat, its stubs so far (stubLine): at most STUBS_PER_WINDOW kept per window, the rest counted. */
  private readonly stubs = new Map<string, SeatStubs>();
  private endedAt: number | undefined;
  private completion: Promise<boolean> | null = null;
  private readonly seq: number;
  private readonly store: ReplayStore;
  private readonly logError: (message: string) => void;
  private readonly includeComparisonSetup: boolean;
  private readonly onBinarySaved: ((id: string) => void) | undefined;
  private readonly handoff: RecordHandoff | undefined;
  private readonly lobbyId: string | null;

  constructor(startedAt: number, seq: number, store: ReplayStore,
    logError: (message: string) => void = (message) => console.error(message),
    options: {
      readonly includeComparisonSetup?: boolean; readonly logHeader?: string; readonly onBinarySaved?: (id: string) => void;
      /** Receives the finished match's inputs; the record service builds the readable record, never this process. */
      readonly handoff?: RecordHandoff;
      /** Private lobby whose sealed archive receives the record; null or omitted for a public match. */
      readonly lobbyId?: string | null;
      /** A recording another server saved: its replay id, copies and log lines continue here; logHeader is not used. */
      readonly resume?: { readonly meta: unknown; readonly parts: ReadonlyMap<string, Uint8Array> };
    } = {}) {
    this.seq = seq;
    this.store = store;
    this.logError = logError;
    this.includeComparisonSetup = options.includeComparisonSetup === true;
    this.onBinarySaved = options.onBinarySaved;
    this.handoff = options.handoff;
    this.lobbyId = options.lobbyId ?? null;
    const resume = options.resume;
    if (resume === undefined) {
      this.id = replayId(startedAt, seq);
      this.logLines = options.logHeader === undefined ? undefined : [options.logHeader];
      this.replyLines = this.logLines === undefined ? undefined : [];
    } else {
      const saved = savedMeta(resume.meta);
      const part = (name: string): Uint8Array => {
        const bytes = resume.parts.get(name);
        if (bytes === undefined) throw new Error(`recording save has no ${name} part`);
        return bytes;
      };
      this.id = saved.id;
      this.endedAt = saved.endedAt ?? undefined;
      this.checkpointed = saved.checkpointed;
      this.captureFailed = saved.captureFailed;
      this.releasedBefore = Array.from({ length: saved.released }, (_, i) => part(recordingPart("released", i)));
      this.checkpointBefore = Array.from({ length: saved.checkpoint }, (_, i) => part(recordingPart("checkpoint", i)));
      this.logLines = saved.log ? savedLog(part(RECORDING_PARTS.log)) : undefined;
      this.replyLines = saved.replies === true ? savedLog(part(RECORDING_PARTS.replies)) : this.logLines === undefined ? undefined : [];
      for (const line of this.replyLines ?? []) {
        const digest = textDigestOf(line);
        if (digest !== undefined) this.textDigests.add(digest);
      }
      // Each seat's budget already spent travels as its saved lines; its counted calls as its pending stub.
      for (const line of this.replyLines ?? []) {
        const agentId = lineAgentId(line);
        if (agentId !== undefined) this.seat(agentId).bytes += lineCost(line);
      }
      for (const pending of saved.pendingStubs ?? []) {
        const seat = this.seat(pending.agentId);
        seat.omitted = pending.omitted;
        seat.last = JSON.parse(pending.last) as Record<string, unknown>;
        seat.spent = pending.spent === true;
      }
      // A recording that had already failed or finished stays so: nothing more is recorded for it.
      this.done = saved.released === 0;
    }
    if (!this.done) this.released = new GzipFrames(error => {
      // Compression failing takes the encoding-failure path; once finish has begun, upload reports it.
      if (this.done) return;
      this.done = true;
      this.failed(error);
    });
    if (this.handoff !== undefined && this.logLines !== undefined && (resume === undefined || this.checkpointBefore.length > 0)) {
      this.checkpoint = new GzipFrames(error => this.checkpointFailed(error));
    }
  }

  append(payload: Uint8Array): void {
    if (this.done) return;
    try {
      this.released?.push(this.includeComparisonSetup || (payload[3]! & 1) === 0 ? payload : encodeReplayMessage(decodeMessage(payload)));
    } catch (error: unknown) {
      this.done = true;
      this.failed(error);
    }
  }

  /**
   * Inputs are retained only for public recordings, never sent on the spectator wire. A reply line (replyLine), text
   * line (textLine) or stub line (stubLine) is kept apart from the input lines, until the record input is handed off.
   */
  appendLog(line: string): void {
    if (this.done) return;
    if (line.startsWith(REPLY_LINE_PREFIX)) {
      if (this.replyLines !== undefined) this.appendEntry(line);
      return;
    }
    if (line.startsWith(STUB_LINE_PREFIX)) {
      if (this.replyLines !== undefined) this.appendStub(JSON.parse(line) as Record<string, unknown>);
      return;
    }
    const digest = textDigestOf(line);
    if (digest === undefined) {
      this.logLines?.push(line);
    } else if (this.replyLines !== undefined && !this.textDigests.has(digest)) {
      this.textDigests.add(digest);
      this.replyLines.push(line);
    }
  }

  get capturesInputs(): boolean { return this.handoff !== undefined && this.logLines !== undefined && !this.captureFailed; }

  /** Capture at push time, never a public write. Only allocated with a log and private handoff. */
  capture(payload: Uint8Array): void {
    if (this.handoff === undefined || this.logLines === undefined || this.checkpointed || this.captureFailed) return;
    try {
      this.checkpoint?.push(this.includeComparisonSetup || (payload[3]! & 1) === 0 ? payload : encodeReplayMessage(decodeMessage(payload)));
    } catch (error) {
      this.checkpointFailed(error);
    }
  }

  /** Encoding or compression failure drops the checkpoint copy; once ended() has handed it off, ended() reports it. */
  private checkpointFailed(error: unknown): void {
    if (this.captureFailed || this.checkpointed) return;
    this.captureFailed = true;
    this.checkpoint?.destroy();
    this.checkpoint = null;
    this.checkpointBefore = [];
    this.logError(`antwar match ${this.seq} private checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** publication's startRatings, when given, are handed off with the inputs (src/records/inputs.ts). */
  ended(at: number, publication?: { publishAfter: number; rated: boolean; startRatings?: Readonly<Record<string, StartRating>> }): void {
    this.endedAt = at;
    if (publication === undefined || this.handoff === undefined || this.logLines === undefined || this.captureFailed || this.checkpointed) return;
    this.checkpointed = true;
    const checkpoint = this.checkpoint!, before = this.checkpointBefore, logLines = this.logLines.slice();
    this.checkpoint = null;
    this.checkpointBefore = [];
    // Own the bytes before yielding: close/discard cannot cancel this finished match's handoff. Reply lines are taken
    // at submission, so the replies to the final tick's calls, answered after this push, are in it.
    void whole(before, checkpoint).then(binary => {
      const replyLines = this.takeReplyLines();
      this.handoff!.submit({ id: this.id, endedAt: at, lobbyId: this.lobbyId, logLines, binary, ...publication, ...replyLines });
    }).catch(error => {
      this.logError(`antwar match ${this.seq} private checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Normal publication follows the final public tick; durable inputs own recovery retries. */
  finish(): Promise<boolean> {
    if (this.completion !== null) return this.completion;
    if (this.done) return Promise.resolve(false);
    this.done = true;
    this.completion = this.upload();
    return this.completion;
  }

  /** Drop live buffers, never an already-started finished-match checkpoint. */
  discard(): void {
    this.done = true;
    this.released?.destroy();
    this.released = null;
    this.releasedBefore = [];
    this.checkpoint?.destroy();
    this.checkpoint = null;
    this.checkpointBefore = [];
    this.logLines = undefined;
    // A begun finished-match handoff takes its reply lines when it submits.
    if (!this.checkpointed) this.replyLines = undefined;
  }

  private seat(agentId: string): SeatStubs {
    let seat = this.stubs.get(agentId);
    if (seat === undefined) this.stubs.set(agentId, seat = { kept: [], omitted: 0, last: null, bytes: 0, spent: false });
    return seat;
  }

  /**
   * Whether line fits the seat's budget with the closing stub's reserve still free; it is then stored and counted.
   * A line that does not fit spends the seat: nothing more is stored for it but its closing stub.
   */
  private stores(seat: SeatStubs, line: string): boolean {
    if (!seat.spent && seat.bytes + lineCost(line) + CLOSING_STUB_RESERVE_BYTES <= SEAT_RECORD_BUDGET_BYTES) {
      this.replyLines!.push(line);
      seat.bytes += lineCost(line);
      return true;
    }
    seat.spent = true;
    return false;
  }

  /** A call left out, counted with the calls the game left out while holding it: the last of them is the closing stub. */
  private leaveOut(seat: SeatStubs, stub: Record<string, unknown>, carried: number): void {
    seat.omitted += 1 + carried;
    seat.last = stub;
  }

  /** An entry within the seat's budget; past it, counted as the stub it would be (entryStub). */
  private appendEntry(line: string): void {
    const agentId = lineAgentId(line);
    const seat = this.seat(agentId ?? "");
    if (!this.stores(seat, line)) this.leaveOut(seat, entryStub(JSON.parse(line) as Record<string, unknown>), 0);
  }

  /**
   * A stub kept under the stub rule (keepsStub) and the seat's budget, carrying omitted, the seat's calls left out since
   * its previous stub (those the game left out while holding it included); otherwise left out and counted.
   */
  private appendStub(stub: Record<string, unknown>): void {
    const seat = this.seat(String(stub.agentId));
    const at = typeof stub.answeredAt === "number" ? stub.answeredAt : 0;
    // Calls the game already left out while holding this stub before the match began.
    const carried = typeof stub.omitted === "number" ? stub.omitted : 0;
    if (seat.spent || !keepsStub(seat, at) || !this.stores(seat, JSON.stringify({ ...stub, omitted: seat.omitted + carried }))) {
      this.leaveOut(seat, stub, carried);
      return;
    }
    seat.omitted = 0;
    seat.last = null;
  }

  /**
   * The reply lines for the record input, after which none are taken; a match with no call recorded carries none, as
   * before replies were. Each seat with calls left out since its last stub closes with its last such call as a stub,
   * omitted counting the rest, so the counts are exact up to the handoff.
   */
  private takeReplyLines(): { replyLines?: readonly string[] } {
    const replyLines = this.replyLines;
    this.replyLines = undefined;
    for (const seat of this.stubs.values()) {
      if (seat.last !== null && replyLines !== undefined) replyLines.push(JSON.stringify({ ...seat.last, omitted: seat.omitted - 1 }));
    }
    this.stubs.clear();
    return replyLines === undefined || replyLines.length === 0 ? {} : { replyLines };
  }

  private pendingStubs(held: boolean): { pendingStubs?: RecordingSaveMeta["pendingStubs"] } {
    const pending = held ? [...this.stubs].filter(([, seat]) => seat.last !== null)
      .map(([agentId, seat]) => ({ agentId, omitted: seat.omitted, last: JSON.stringify(seat.last), ...(seat.spent ? { spent: true as const } : {}) })) : [];
    this.stubs.clear();
    return pending.length === 0 ? {} : { pendingStubs: pending };
  }

  /**
   * Handover save: the recording so far, after which it is inert here: nothing more is appended,
   * captured, uploaded or handed off by this server. A recording that already failed or began its upload is
   * saved holding nothing. Rejects when a held copy cannot be completed, which is a failed save.
   */
  async save(): Promise<RecordingSave> {
    const live = !this.done;
    const released = live ? this.released : null, checkpoint = live ? this.checkpoint : null, logLines = live ? this.logLines : undefined;
    const replyLines = live ? this.replyLines : undefined;
    const releasedBefore = this.releasedBefore, checkpointBefore = this.checkpointBefore;
    const meta: RecordingSaveMeta = { id: this.id, endedAt: this.endedAt ?? null, checkpointed: this.checkpointed, captureFailed: this.captureFailed,
      released: 0, checkpoint: 0, log: logLines !== undefined, replies: replyLines !== undefined,
      ...(this.pendingStubs(replyLines !== undefined)) };
    this.done = true;
    if (!live) this.discard();
    this.released = null; this.releasedBefore = [];
    this.checkpoint = null; this.checkpointBefore = [];
    this.logLines = undefined;
    this.replyLines = undefined;
    const parts = new Map<string, Uint8Array>();
    // Each copy's parts are the full blocks it is held in, then its output since joined into one: saving a late match
    // copies at most one block of each copy.
    const add = (copy: "released" | "checkpoint", blocks: readonly Uint8Array[]) => {
      blocks.forEach((block, i) => parts.set(recordingPart(copy, i), block));
      return blocks.length;
    };
    let releasedParts = 0, checkpointParts = 0;
    try {
      if (released !== null) releasedParts = add("released", await continued(releasedBefore, released));
      if (checkpoint !== null) checkpointParts = add("checkpoint", await continued(checkpointBefore, checkpoint));
    } catch (error) {
      released?.destroy();
      checkpoint?.destroy();
      throw error;
    }
    if (logLines !== undefined) parts.set(RECORDING_PARTS.log, new TextEncoder().encode(JSON.stringify(logLines)));
    if (replyLines !== undefined) parts.set(RECORDING_PARTS.replies, new TextEncoder().encode(JSON.stringify(replyLines)));
    return { meta: { ...meta, released: releasedParts, checkpoint: checkpointParts }, parts };
  }

  /** @internal Bytes each copy holds now; 0 for a copy that is not held (absent, handed off or discarded). */
  heldBytes(): { released: number; checkpoint: number } {
    return {
      released: (this.released?.heldBytes ?? 0) + byteLength(this.releasedBefore),
      checkpoint: (this.checkpoint?.heldBytes ?? 0) + byteLength(this.checkpointBefore),
    };
  }

  private async upload(): Promise<boolean> {
    try {
      const released = this.released!, before = this.releasedBefore;
      const logLines = this.logLines, endedAt = this.endedAt;
      this.released = null;
      this.releasedBefore = [];
      this.logLines = undefined;
      const body = await whole(before, released);
      try { await this.store.create({
        name: `${this.id}.bin`, body, contentType: "application/octet-stream",
        contentEncoding: "gzip", ifGenerationMatch: 0,
      }); } catch (error) {
        if (!(error instanceof ReplayCreateError && error.status === 412)) throw error;
      }
      this.onBinarySaved?.(this.id);
      // The record service builds and verifies the readable record from these inputs.
      if (!this.checkpointed && this.handoff !== undefined && logLines !== undefined) {
        if (endedAt === undefined) this.logError(`antwar match ${this.seq} record input not handed off: no observed end time`);
        else this.handoff.submit({ id: this.id, endedAt, lobbyId: this.lobbyId, logLines, binary: body, ...this.takeReplyLines() });
      }
      return true;
    } catch (error: unknown) {
      this.failed(error);
      return false;
    }
  }

  private failed(error: unknown): void {
    this.released?.destroy();
    this.released = null;
    this.releasedBefore = [];
    this.logLines = undefined;
    if (!this.checkpointed) this.replyLines = undefined;
    this.logError(`antwar match ${this.seq} replay upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A copy's saved parts: the bytes recorded before the last handover, then this server's gzip member, all as held. */
async function continued(before: readonly Uint8Array[], copy: GzipFrames): Promise<Uint8Array[]> {
  return [...before, ...await copy.finishBlocks()];
}

/** A copy's finished body as one gzip member, whatever handovers it crossed. */
async function whole(before: readonly Uint8Array[], copy: GzipFrames): Promise<Uint8Array> {
  return before.length === 0 ? copy.finish() : joinGzip(await continued(before, copy));
}

function byteLength(blocks: readonly Uint8Array[]): number {
  return blocks.reduce((sum, block) => sum + block.byteLength, 0);
}

function savedMeta(value: unknown): RecordingSaveMeta {
  const meta = value as Record<string, unknown> | null;
  if (typeof meta !== "object" || meta === null || typeof meta.id !== "string" || !isReplayId(meta.id)
    || !(meta.endedAt === null || Number.isSafeInteger(meta.endedAt))
    || !["checkpointed", "captureFailed", "log"].every(key => typeof meta[key] === "boolean")
    || !(meta.replies === undefined || typeof meta.replies === "boolean")
    || !(meta.pendingStubs === undefined || (Array.isArray(meta.pendingStubs) && meta.pendingStubs.every(pending =>
      typeof pending === "object" && pending !== null && typeof pending.agentId === "string" && typeof pending.last === "string"
      && Number.isSafeInteger(pending.omitted) && pending.omitted >= 1 && (pending.spent === undefined || pending.spent === true))))
    || !["released", "checkpoint"].every(key => Number.isSafeInteger(meta[key]) && (meta[key] as number) >= 0)) {
    throw new Error("invalid recording save");
  }
  return meta as unknown as RecordingSaveMeta;
}

function savedLog(bytes: Uint8Array): string[] {
  const lines: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(lines) || !lines.every(line => typeof line === "string")) throw new Error("invalid recording save log");
  return lines as string[];
}
