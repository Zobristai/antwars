/**
 * One streaming pass over a stored match record (src/replays/history.ts MatchRecord) for the post-mortem, with no
 * record-size cap. Large arrays are parsed one element at a time and never held whole. Every other byte counts against
 * one total cap, so a corrupted record (an inverted quote, say) fails instead of buffering without bound. A record that
 * cannot be read whole fails as RecordReadError, with no detail of its content.
 *
 * Two modes. "refused" (the entry server, public and private records): a first pass (surveyRecord) keeps no entry, only
 * the record's re-run data, game version, seat elements with their command and refused-command counts, and its replies'
 * refused calls counted by seat; refused calls come from the record's replies where it holds a replies array, else from
 * its seats' refused commands, by which the record holds, whatever it declares. A page (readRecordPage) then reads one
 * owner's entries of one list from a checkpoint, hashing and counting the bytes before it without parsing them. Kept
 * whole (scanRecord), refused mode keeps every refused call and command, a full-parse reference for tests. "rerun" (the
 * re-run child, public records only): what a re-run needs and no more: every command, each call event's facts in
 * record order (the re-run's call order, as test/replays/history.test.ts rebuild), one digest per 100-tick block of the
 * stored events, and each reply line's seat, tick, tool, code and argument flags in columns.
 */
import { createHash, type Hash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, type Gunzip } from "node:zlib";
import { entryCode } from "../replays/recording.js";

/** One element of events, replies or a seat's commands longer than this fails the read, except a replies text line. */
export const ELEMENT_CAP_BYTES = 256 * 1024;
/** All bytes outside those elements (every other member, kept or not) together. */
export const OTHER_CAP_BYTES = 8 * 1024 * 1024;
const KEY_CAP_BYTES = 1024;
/** Stored events are compared with the re-run's in blocks of this many ticks. */
export const BLOCK_TICKS = 100;

export type ScanMode = "refused" | "rerun";

/** A page holds at most this many entries, and at most PAGE_BYTES of them as replies show them. */
export const PAGE_ENTRIES = 2000;
export const PAGE_BYTES = 256 * 1024;

export interface RefusedEntry { readonly seat: number; readonly tick: number | null; readonly at: number | null; readonly tool: string; readonly code: string }
export interface NoEffectEntry { readonly seat: number; readonly index: number; readonly tick: number; readonly type: string }

/** What one pass learnt of who holds which seat: by seat element position, and the record's agent map. */
export interface SeatMap { readonly positions: readonly ({ seat: number; colony: 0 | 1 } | null)[]; readonly agentSeats: Readonly<Record<string, unknown>> }

/** A reproduced re-run's findings: [seat, its recorded commands] and one bit per command (postMortemChild.ts packFindings). */
export interface Findings { readonly counts: readonly (readonly [number, number])[]; readonly bits: Uint8Array }

/** A record's command bits as a re-run answers them: each seat element's commands padded to whole bytes, summed. */
export const paddedBits = (counts: readonly number[]) => counts.reduce((sum, n) => sum + 8 * Math.ceil(n / 8), 0);

/** Decoded record bytes one page scans past its starting point, at most, before it ends at the next element. */
export const PAGE_SCAN_BYTES = 128 * 1024 * 1024;

type FrameState = "firstKey" | "key" | "colon" | "value" | "next" | "first";
/** A frame as a checkpoint keeps it: a seat element's position, commands so far and the members it has read. */
export interface SavedFrame {
  readonly kind: "obj" | "arr";
  readonly role: Role;
  readonly state: FrameState;
  readonly key: string | null;
  readonly seat?: { readonly position: number; readonly count: number; readonly fields: Readonly<Record<string, unknown>> };
}
/** Where a page stopped: the decoded offset of an element's first byte and the scanner's state just before it. */
export interface Checkpoint { readonly offset: number; readonly frames: readonly SavedFrame[]; readonly other: number; readonly positions: number }

/** One page of one owner's list, read from a checkpoint (or the record's start) with what the record's first pass settled. */
export interface PageSpec {
  readonly list: "refused" | "noEffect";
  /** The first pass's refused-call source: the replies array where the record holds one, else seats' refused commands. */
  readonly source: "calls" | "commands";
  /** The owner's seat elements by position, as their seat numbers; its seat numbers; and its reply agent ids' seats. */
  readonly ownedPositions: ReadonlyMap<number, number>;
  readonly ownedSeats: ReadonlySet<number>;
  readonly ownedAgents: ReadonlyMap<string, number>;
  readonly findings: Findings | null;
  readonly measure: (entry: RefusedEntry | NoEffectEntry) => number;
  readonly resume: Checkpoint | null;
  /** Entries counted but not kept before the page starts keeping (a far offset read from the start). */
  readonly skip: number;
  /** The owner's entries of this list before the page's starting point, and in all (the first pass's count). */
  readonly ordinal: number;
  readonly total: number;
  readonly scanBytes: number;
}
export interface PageResult<T> {
  readonly entries: readonly T[];
  /** Where the next page starts; null when the list is complete. */
  readonly next: Checkpoint | null;
}

/** What a first pass learnt of the record's seats and refused calls, before any page is read. */
export interface SeatElement { readonly seat: number; readonly colony: 0 | 1; readonly commands: number; readonly refused: number }
export interface Survey {
  readonly source: "calls" | "commands";
  /** Seat elements in record order, each with its commands and refused commands. */
  readonly elements: readonly SeatElement[];
  /** The record's agent map, valid entries only. */
  readonly agentSeats: Readonly<Record<string, number>>;
  /** Refused calls of its replies array, by the seat each names. */
  readonly replyRefused: ReadonlyMap<number, number>;
}

/** Counts every entry; keeps those past `skip` while a page has room. The first entry kept always fits. */
class Collector<T> {
  seen = 0;
  readonly entries: T[] = [];
  private bytes = 0;
  private readonly skip: number;
  private readonly measure: (entry: T) => number;
  constructor(skip: number, measure: (entry: T) => number) { this.skip = skip; this.measure = measure; }
  add(entry: T): "kept" | "skipped" | "full" {
    if (this.seen < this.skip) { this.seen++; return "skipped"; }
    const n = this.measure(entry) + 1;
    if (this.entries.length > 0 && (this.entries.length >= PAGE_ENTRIES || this.bytes + n > PAGE_BYTES)) return "full";
    this.entries.push(entry);
    this.bytes += n;
    this.seen++;
    return "kept";
  }
}

export class RecordReadError extends Error {
  constructor() { super("match record could not be read"); }
}

/** A refused call: a stub's code, or a reply's error code by entryCode (the record service's rule, src/records/service.ts). */
export interface Refusal {
  /** The record's seat, or null for an agent of no seat. */
  readonly seat: number | null;
  readonly tick: number | null;
  readonly tool: string;
  /** When the server received the call, epoch milliseconds; null where the record kept no call times. */
  readonly receivedAt: number | null;
  readonly code: string;
}

export interface ReducedCommand {
  readonly tick: number;
  readonly type: string;
  readonly accepted: boolean;
  readonly request: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
}

export interface ReducedSeat {
  readonly seat: number;
  readonly colony: 0 | 1;
  readonly handle: string | null;
  /** Rerun mode only; null otherwise or where the record has none. */
  readonly joinedTick: number | null;
  readonly commands: ReducedCommand[];
}

/** A call event as the record stores it (src/live/format.ts call event). */
export interface CallFact {
  readonly tick: number;
  readonly seat: number;
  readonly call: string;
  readonly accepted: boolean;
  /** The server's house-idle activity tick after this call's tick; null where the event carries none. */
  readonly activity: number | null;
}

/** One block of stored events: [block index, event count, SHA-256 of their comparable form]. */
export type EventBlock = readonly [number, number, string];

/** A column of numbers, on the heap: its memory counts toward the child's V8 heap cap, which bounds it. */
class Column {
  readonly data: number[] = [];
  get length(): number { return this.data.length; }
  push(value: number): void { this.data.push(value); }
  at(i: number): number { return this.data[i]!; }
}

export const LINE_ARGS_KNOWN = 1, LINE_SINCE = 2, LINE_CELLS_CURSOR = 4, LINE_STUB = 8;

/** Every reply and stub line of the record, compactly: strings are interned, ticks of -1 are null. */
export class ReplyLines {
  readonly strings: string[] = [""];
  private readonly ids = new Map<string, number>([["", 0]]);
  /** Seat, or -1 - (interned agent id) until end() resolves it. */
  readonly seat = new Column();
  readonly tick = new Column();
  readonly tool = new Column();
  /** Interned code; 0 is a call that succeeded. */
  readonly code = new Column();
  readonly flags = new Column();
  readonly omitted = new Column();
  get length(): number { return this.seat.length; }
  intern(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) { id = this.strings.length; this.strings.push(value); this.ids.set(value, id); }
    return id;
  }
  string(id: number): string { return this.strings[id]!; }
}

export interface RerunData {
  readonly seed: number;
  readonly stops: number[];
  readonly abandonments: number[];
  readonly idle: { tick: number; colonies: number[] }[];
  readonly houseActive: [number, number][];
}

/** What the post-mortem needs from the record, and no more. */
export interface ReducedRecord {
  readonly config: unknown;
  /** The stored result less its ratingChanges, which the simulation never produces. */
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly rerun: RerunData | null;
  readonly codeVersion: string | null;
  readonly seats: ReducedSeat[];
  /** Rerun mode: each call event, in record order; empty in refused mode. */
  readonly calls: CallFact[];
  /** Rerun mode: the stored events' blocks, ascending; empty in refused mode. */
  readonly blocks: EventBlock[];
  /** setup.houseIdleTicks, or null where the record carries none. */
  readonly houseIdleTicks: number | null;
  readonly modelIndex: boolean;
  /** Rerun mode: every reply and stub line, with seats resolved; null when the record retained no replies. */
  readonly lines: ReplyLines | null;
}

export interface RecordScan {
  readonly id: string | null;
  readonly status: string | null;
  readonly ticksPerSecond: number | null;
  readonly reduced: ReducedRecord;
  /** Kept refused calls, from replies; null when the record retained no replies, or when the scan kept none. */
  readonly refusals: Refusal[] | null;
  /** Where refused calls are read from: "calls" where the record holds a replies array, else "commands". */
  readonly refusedFrom: "calls" | "commands";
  /** Calls a seat-budget stub left out, by seat. */
  readonly omitted: ReadonlyMap<number, number>;
  /** Refused mode: the seats and refused-call counts a page needs. */
  readonly survey: Survey;
}

type Role = "root" | "seats" | "seat" | "commands" | "events" | "replies";
interface Frame {
  readonly kind: "obj" | "arr";
  readonly role: Role;
  /** obj: expecting a key, a colon, a value or a comma/close. arr: a value or a comma/close. */
  state: FrameState;
  key: string | null;
  seat?: Record<string, unknown> & { commands: ReducedCommand[]; position: number; count: number; refused: number };
}
type Sink = "events" | "replies" | "commands" | "member";
interface Capture {
  readonly sink: Sink;
  readonly key: string | null;
  readonly owner: Frame;
  readonly mode: "container" | "string" | "bare";
  /** The decoded offset of the value's first byte. */
  readonly start: number;
  parts: Buffer[] | null;
  length: number;
  depth: number;
  opened: boolean;
  inString: boolean;
  escaped: boolean;
}

const ROOT_KEPT = new Set(["id", "status", "rules", "result", "rerun", "codeVersion", "agentSeats", "setup"]);
const SEAT_KEPT = new Set(["seat", "colony", "handle", "joinedTick"]);
/** Arrays read one element at a time: the separators between their elements are not charged to OTHER_CAP_BYTES. */
const STREAMED = new Set<Role>(["events", "replies", "commands"]);
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const TEXT_PREFIX = Buffer.from('{"type":"text"');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (): never => { throw new RecordReadError(); };

/** Key-sorted plain JSON, undefined members left out. */
const canon = (value: unknown): unknown => Array.isArray(value) ? value.map(canon)
  : isRecord(value) ? Object.fromEntries(Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => [k, canon(value[k])])) : value;

/** Key-sorted JSON of a plain value, undefined members left out. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canon(value));

/** An event as the re-run can produce it: fields only the server sets (a join's identity, a call's house activity) and a result's ratingChanges and nextStartMs left out. */
export function comparableEvent(tick: number, event: Readonly<Record<string, unknown>>): string {
  let e: Record<string, unknown> = { ...event };
  if (e.kind === "join") delete e.identity;
  if (e.kind === "call") delete e.houseActivityTick;
  if (e.kind === "end" && isRecord(e.result)) { const { ratingChanges: _r, nextStartMs: _n, ...result } = e.result; e = { ...e, result }; }
  return canonicalJson({ tick, event: e });
}

/** A seat command's refusal code, or null where it was accepted: the one rule a first pass and a page both count by. */
function commandRefusal(v: Record<string, unknown>): string | null {
  if (v.accepted === true) return null;
  return isRecord(v.error) && typeof v.error.code === "string" ? v.error.code : "refused";
}
/** A reply or stub line's refusal code, or null where it refused nothing (a text line, a success). */
function lineRefusal(line: Record<string, unknown>): string | null {
  if (line.type === "text") return null;
  if (line.type !== "reply" && line.type !== "stub") fail();
  return line.type === "stub" ? (typeof line.code === "string" ? line.code : null) : entryCode(line);
}

export interface ScannerOptions {
  /** Refused mode without a page: keep every refused call and command, a full-parse reference. A first pass keeps none. */
  readonly keep?: boolean;
  readonly page?: PageSpec;
}

/** The streaming scanner: push decoded JSON bytes, then end(), or pageResult() for a page. */
export function recordScanner(mode: ScanMode = "refused", options: ScannerOptions = {}) {
  const page = options.page;
  const keep = options.keep ?? true;
  const stack: Frame[] = [];
  let started = false, finished = false, other = 0;
  let capture: Capture | null = null;
  let keyBytes: number[] | null = null, keyEscaped = false, keyEscape = false;
  const root: Record<string, unknown> = {};
  const seats: ReducedSeat[] = [];
  const calls: CallFact[] = [];
  const blocks = new Map<number, { count: number; hash: Hash }>();
  const lines = new ReplyLines();
  const refusals: (Refusal & { agentId?: string })[] = [];
  const omitted = new Map<number | string, number>();
  const replyRefused = new Map<number | string, number>();
  const elements: SeatElement[] = [];
  let repliesSeen = false;
  let positions = 0;
  // A page: where its bytes start, what it keeps, and why it stopped (null while it reads on).
  const resumeAt = page?.resume?.offset ?? 0;
  let consumed = resumeAt;
  const collector = page && new Collector<RefusedEntry | NoEffectEntry>(page.skip, page.measure);
  let stopped: { next: Checkpoint | null } | null = null;
  const findingOffsets = new Map<number, { offset: number; count: number }>();
  if (page?.findings) {
    let offset = 0;
    for (const [seat, count] of page.findings.counts) { findingOffsets.set(seat, { offset, count }); offset += Math.ceil(count / 8); }
  }
  if (page?.resume) {
    // The scanner as it stood just before the checkpoint's element, the commands frame sharing its seat element's state.
    const r = page.resume;
    started = true; other = r.other; positions = r.positions;
    let seat: Frame["seat"];
    for (const f of r.frames) {
      const frame: Frame = { kind: f.kind, role: f.role, state: f.state, key: f.key };
      if (f.role === "seat" && f.seat) { seat = { ...f.seat.fields, commands: [], position: f.seat.position, count: f.seat.count, refused: 0 }; frame.seat = seat; }
      else if (f.role === "commands") frame.seat = seat;
      stack.push(frame);
    }
  }

  /** The scanner's state just before the element at `offset`; adjust takes back the open seat's last command. */
  function snapshot(offset: number, adjust = 0): Checkpoint {
    return { offset, other, positions, frames: stack.map(f => ({ kind: f.kind, role: f.role, state: f.state, key: f.key,
      ...(f.role === "seat" && f.seat ? { seat: { position: f.seat.position, count: f.seat.count + adjust,
        fields: Object.fromEntries(Object.entries(f.seat).filter(([k]) => SEAT_KEPT.has(k))) } } : {}) })) };
  }

  /** A page keeps one owner entry, stopping before it when the page is full, or after it when it was the list's last. */
  function offer(entry: RefusedEntry | NoEffectEntry, start: number, command: boolean): void {
    const outcome = collector!.add(entry);
    if (outcome === "full") { stopped = { next: snapshot(start, command ? -1 : 0) }; return; }
    if (page!.ordinal + collector!.seen >= page!.total) stopped = { next: null };
  }

  /** A page: one command of an owned seat element. */
  function pageCommand(s: NonNullable<Frame["seat"]>, v: Record<string, unknown>, start: number): void {
    const index = s.count++;
    const seat = page!.ownedPositions.get(s.position)!;
    if (page!.list === "refused") {
      const code = commandRefusal(v);
      if (code !== null) offer({ seat, tick: v.tick as number, at: null, tool: v.type as string, code }, start, true);
      return;
    }
    const bits = page!.findings?.bits, at = findingOffsets.get(seat);
    if (v.accepted === true && bits && at && index < at.count && (bits[at.offset + (index >> 3)]! & (1 << (index & 7))) !== 0) {
      offer({ seat, index, tick: v.tick as number, type: v.type as string }, start, true);
    }
  }

  /** A page: one reply or stub line, kept when it refused a call of an owned seat. */
  function pageReply(line: Record<string, unknown>, start: number): void {
    const code = lineRefusal(line);
    if (code === null) return;
    const seat = typeof line.agentId === "string" ? page!.ownedAgents.get(line.agentId)
      : Number.isSafeInteger(line.seat) && page!.ownedSeats.has(line.seat as number) ? line.seat as number : undefined;
    if (seat === undefined) return;
    offer({ seat, tick: Number.isSafeInteger(line.tick) ? line.tick as number : null, tool: typeof line.tool === "string" ? line.tool : "",
      at: typeof line.receivedAt === "number" ? line.receivedAt : null, code }, start, false);
  }

  const countOther = (n: number) => { other += n; if (other > OTHER_CAP_BYTES) fail(); };

  function element(c: Capture, bytes: Buffer): void {
    const { sink, owner, key } = c;
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(); }
    if (sink === "events") {
      if (!isRecord(value) || !isRecord(value.event)) fail();
      const { tick, event } = value as { tick: unknown; event: Record<string, unknown> };
      if (!Number.isSafeInteger(tick) || (tick as number) < 0) fail();
      if (event.kind === "call" && !Number.isSafeInteger(event.agent)) fail();
      if (mode === "refused") return;
      const index = Math.floor((tick as number) / BLOCK_TICKS);
      let block = blocks.get(index);
      if (block === undefined) { block = { count: 0, hash: createHash("sha256") }; blocks.set(index, block); }
      block.count++;
      block.hash.update(comparableEvent(tick as number, event) + "\n");
      if (event.kind === "call") {
        calls.push({ tick: tick as number, seat: event.agent as number, call: typeof event.call === "string" ? event.call : "",
          accepted: event.accepted === true, activity: Number.isSafeInteger(event.houseActivityTick) ? event.houseActivityTick as number : null });
      }
    } else if (sink === "replies") {
      if (!isRecord(value)) fail();
      if (page) pageReply(value as Record<string, unknown>, c.start);
      else if (mode === "refused") reply(value as Record<string, unknown>); else line(value);
    } else if (sink === "commands") {
      if (!isRecord(value) || !Number.isSafeInteger(value.tick) || typeof value.type !== "string" || typeof value.accepted !== "boolean") fail();
      const v = value as Record<string, unknown>;
      const s = owner.seat!;
      if (page) { pageCommand(s, v, c.start); return; }
      s.count++;
      const code = commandRefusal(v);
      if (code !== null) s.refused++;
      if (mode === "refused" && (code === null || !keep)) return;
      s.commands.push({ tick: v.tick as number, type: v.type as string, accepted: v.accepted as boolean,
        request: mode === "rerun" && isRecord(v.request) ? v.request : null, errorCode: isRecord(v.error) && typeof v.error.code === "string" ? v.error.code : null });
    } else if (owner.role === "root") {
      if (key !== null && ROOT_KEPT.has(key)) root[key] = value;
      if (key === "replies" && value === null) repliesSeen = false;
    } else if (owner.role === "seat" && key !== null && SEAT_KEPT.has(key)) owner.seat![key] = value;
  }

  /** Refused mode, no page: one reply or stub line, counted by the seat or agent it names, and kept for a reference. */
  function reply(line: Record<string, unknown>): void {
    const code = lineRefusal(line);
    const agentId = typeof line.agentId === "string" ? line.agentId : null;
    const seat = agentId === null && Number.isSafeInteger(line.seat) ? line.seat as number : null;
    const callerKey = agentId ?? seat;
    if (line.type === "stub" && Number.isSafeInteger(line.omitted) && (line.omitted as number) > 0 && callerKey !== null) {
      omitted.set(callerKey, (omitted.get(callerKey) ?? 0) + (line.omitted as number));
    }
    if (code === null) return;
    if (callerKey !== null) replyRefused.set(callerKey, (replyRefused.get(callerKey) ?? 0) + 1);
    if (!keep) return;
    refusals.push({ seat, ...(agentId === null ? {} : { agentId }),
      tick: Number.isSafeInteger(line.tick) ? line.tick as number : null, tool: typeof line.tool === "string" ? line.tool : "",
      receivedAt: typeof line.receivedAt === "number" ? line.receivedAt : null, code });
  }

  /** Rerun mode: one reply or stub line, kept as its seat, tick, tool, code and argument flags. */
  function line(value: unknown): void {
    if (!isRecord(value)) fail();
    const l = value as Record<string, unknown>;
    if (l.type === "text") return;
    if (l.type !== "reply" && l.type !== "stub") fail();
    const seat = typeof l.agentId === "string" ? -1 - lines.intern(l.agentId) : Number.isSafeInteger(l.seat) && (l.seat as number) >= 0 ? l.seat as number : -1 - lines.intern("");
    const code = l.type === "stub" ? (typeof l.code === "string" ? l.code : null) : entryCode(l);
    let flags = l.type === "stub" ? LINE_STUB : 0;
    if (l.type === "reply") {
      // Arguments are known unless the record dropped, trimmed or redacted any of them, or could not name all it did.
      const touched = (names: unknown, more: unknown) => (Number.isSafeInteger(more) && (more as number) > 0)
        || (Array.isArray(names) && names.some(name => typeof name !== "string" || name === "arguments" || name.startsWith("arguments.")));
      const args = l.arguments;
      if (!touched(l.trimmed, l.trimmedMore) && !touched(l.redacted, l.redactedMore) && (args === undefined || isRecord(args))) {
        flags |= LINE_ARGS_KNOWN;
        if (isRecord(args) && args.since !== undefined && args.since !== null) flags |= LINE_SINCE;
        if (isRecord(args) && args.cellsCursor !== undefined && args.cellsCursor !== null) flags |= LINE_CELLS_CURSOR;
      }
    }
    lines.seat.push(seat);
    lines.tick.push(Number.isSafeInteger(l.tick) && (l.tick as number) >= 0 ? l.tick as number : -1);
    lines.tool.push(lines.intern(typeof l.tool === "string" ? l.tool : ""));
    lines.code.push(code === null ? 0 : lines.intern(code));
    lines.flags.push(flags);
    lines.omitted.push(l.type === "stub" && Number.isSafeInteger(l.omitted) && (l.omitted as number) > 0 ? l.omitted as number : 0);
  }

  /** The sink a value at the top frame's position goes to, or a frame role to descend into. */
  function route(frame: Frame, byte: number): { descend: Role; kind: "obj" | "arr" } | { sink: Sink } {
    if (frame.role === "root") {
      const key = frame.key;
      if (byte === 0x5b && (key === "events" || key === "replies" || key === "seats")) {
        // A replies array is where refused calls are read from, whatever the commands gave.
        if (key === "replies") repliesSeen = true;
        return { descend: key, kind: "arr" };
      }
      return { sink: "member" };
    }
    if (frame.role === "seats") return byte === 0x7b ? { descend: "seat", kind: "obj" } : fail();
    if (frame.role === "seat") return frame.key === "commands" && byte === 0x5b ? { descend: "commands", kind: "arr" } : { sink: "member" };
    return { sink: frame.role as Sink };
  }

  /** A page parses only the elements its list is read from: the owner's commands, or the replies array. */
  function pageParses(sink: Sink, frame: Frame): boolean {
    if (sink === "replies") return page!.list === "refused" && page!.source === "calls";
    if (sink === "commands") return (page!.list === "noEffect" || page!.source === "commands") && page!.ownedPositions.has(frame.seat!.position);
    return false;
  }

  function beginValue(frame: Frame, byte: number, position: number): void {
    const target = route(frame, byte);
    if ("descend" in target) {
      countOther(1);
      const child: Frame = { kind: target.kind, role: target.descend, state: target.kind === "obj" ? "firstKey" : "first", key: null };
      if (target.descend === "seat") child.seat = { commands: [], position: positions++, count: 0, refused: 0 };
      if (target.descend === "commands") child.seat = frame.seat;
      stack.push(child);
      return;
    }
    // A page that has scanned its budget ends at the next streamed element, which the next page starts with.
    if (page && STREAMED.has(frame.role) && position > resumeAt && position - resumeAt >= page.scanBytes) { stopped = { next: snapshot(position) }; return; }
    const mode = byte === 0x7b || byte === 0x5b ? "container" : byte === 0x22 ? "string" : "bare";
    capture = { sink: target.sink, key: frame.key, owner: frame, mode, start: position, parts: page && !pageParses(target.sink, frame) ? null : [],
      length: 0, depth: 0, opened: false, inString: false, escaped: false };
  }

  function closeFrame(): void {
    const frame = stack.pop()!;
    countOther(1);
    if (frame.role === "seat" && !page) {
      const s = frame.seat!;
      if (!Number.isSafeInteger(s.seat) || (s.colony !== 0 && s.colony !== 1)) fail();
      elements[s.position] = { seat: s.seat as number, colony: s.colony as 0 | 1, commands: s.count, refused: s.refused };
      seats.push({ seat: s.seat as number, colony: s.colony as 0 | 1, handle: typeof s.handle === "string" ? s.handle : null,
        joinedTick: mode === "rerun" && Number.isSafeInteger(s.joinedTick) ? s.joinedTick as number : null, commands: s.commands });
    }
    if (stack.length === 0) finished = true;
    else afterValue(stack.at(-1)!);
  }

  function afterValue(frame: Frame): void { frame.state = "next"; }

  /** Feeds bytes from `from` into the active capture; returns the index just after the value's end, or -1 when it continues. */
  function feedCapture(chunk: Buffer, from: number): number {
    const c = capture!;
    let i = from, done = false;
    for (; i < chunk.length; i++) {
      const byte = chunk[i]!;
      if (c.mode === "bare") {
        // A number, true, false or null ends at a delimiter, which is not part of it.
        if (byte === 0x2c || byte === 0x7d || byte === 0x5d || WHITESPACE.has(byte)) { done = true; break; }
        continue;
      }
      if (!c.opened) { c.opened = true; if (c.mode === "string") c.inString = true; else c.depth = 1; continue; }
      if (c.inString) {
        if (c.escaped) c.escaped = false;
        else if (byte === 0x5c) c.escaped = true;
        else if (byte === 0x22) { c.inString = false; if (c.mode === "string") { i++; done = true; break; } }
        continue;
      }
      if (byte === 0x22) c.inString = true;
      else if (byte === 0x7b || byte === 0x5b) c.depth++;
      else if (byte === 0x7d || byte === 0x5d) { c.depth--; if (c.depth === 0) { i++; done = true; break; } }
    }
    append(c, chunk, from, i);
    return done ? finish(c, i) : -1;
  }

  function append(c: Capture, chunk: Buffer, from: number, to: number): void {
    const n = to - from;
    if (n <= 0) return;
    c.length += n;
    if (c.sink === "member") countOther(n);
    if (c.parts !== null) c.parts.push(Buffer.from(chunk.subarray(from, to)));
    if (c.sink !== "member" && c.length > ELEMENT_CAP_BYTES && c.parts !== null) {
      const head = Buffer.concat(c.parts).subarray(0, TEXT_PREFIX.length);
      if (c.sink === "replies" && head.equals(TEXT_PREFIX)) c.parts = null; // a text line is skipped, never buffered
      else fail();
    }
  }

  function finish(c: Capture, next: number): number {
    capture = null;
    if (c.parts !== null) element(c, Buffer.concat(c.parts));
    afterValue(c.owner);
    return next;
  }

  const separatorOf = (frame: Frame | undefined) => frame !== undefined && frame.kind === "arr" && STREAMED.has(frame.role);

  function push(input: Uint8Array): void {
    if (stopped !== null) return;
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const base = consumed;
    consumed += chunk.length;
    let i = 0;
    while (i < chunk.length) {
      if (stopped !== null) return;
      if (capture !== null) {
        const next = feedCapture(chunk, i);
        if (next < 0) return;
        i = next;
        continue;
      }
      const byte = chunk[i]!;
      if (keyBytes !== null) {
        // A key string inside an object we navigate.
        i++;
        countOther(1);
        if (keyEscape) { keyEscape = false; keyBytes.push(byte); continue; }
        if (byte === 0x5c) { keyEscape = true; keyEscaped = true; keyBytes.push(byte); continue; }
        if (byte === 0x22) {
          const raw = Buffer.from(keyBytes).toString("utf8");
          let key: string;
          try { key = keyEscaped ? JSON.parse(`"${raw}"`) as string : raw; } catch { fail(); }
          stack.at(-1)!.key = key!;
          stack.at(-1)!.state = "colon";
          keyBytes = null; keyEscaped = false;
          continue;
        }
        keyBytes.push(byte);
        if (keyBytes.length > KEY_CAP_BYTES) fail();
        continue;
      }
      i++;
      // Whitespace between a streamed array's elements belongs to no capped member.
      if (WHITESPACE.has(byte)) { if (!separatorOf(stack.at(-1))) countOther(1); continue; }
      if (finished) fail();
      if (!started) {
        if (byte !== 0x7b) fail();
        started = true;
        countOther(1);
        stack.push({ kind: "obj", role: "root", state: "firstKey", key: null });
        continue;
      }
      const frame = stack.at(-1)!;
      if (frame.kind === "obj") {
        if (frame.state === "key" || frame.state === "firstKey") {
          if (byte === 0x22) { keyBytes = []; countOther(1); continue; }
          if (byte === 0x7d && frame.state === "firstKey") { closeFrame(); continue; }
          fail();
        } else if (frame.state === "colon") {
          if (byte !== 0x3a) fail();
          countOther(1);
          frame.state = "value";
        } else if (frame.state === "value") {
          beginValue(frame, byte, base + i - 1);
          i--; // the capture (or the child frame's opening byte) starts with this byte
          if (capture === null) i++; // a descended container: its opening byte is consumed
        } else {
          if (byte === 0x2c) { countOther(1); frame.state = "key"; frame.key = null; keyBytes = null; continue; }
          if (byte === 0x7d) { closeFrame(); continue; }
          fail();
        }
      } else {
        if (frame.state === "first" && byte === 0x5d) { closeFrame(); continue; }
        if (frame.state === "first" || frame.state === "value") {
          beginValue(frame, byte, base + i - 1);
          i--;
          if (capture === null) i++;
          continue;
        }
        if (byte === 0x2c) { if (!separatorOf(frame)) countOther(1); frame.state = "value"; continue; }
        if (byte === 0x5d) { closeFrame(); continue; }
        fail();
      }
    }
  }

  /** A page's entries and where the next starts; a page that read on to the record's end has no next. */
  function pageResult(): PageResult<RefusedEntry | NoEffectEntry> {
    if (stopped !== null) return { entries: collector!.entries, next: stopped.next };
    if (capture !== null || keyBytes !== null || !finished) fail();
    return { entries: collector!.entries, next: null };
  }

  function end(agentSeats?: Readonly<Record<string, number | null>>): RecordScan {
    if (page || capture !== null || keyBytes !== null || !finished) fail();
    const seatsByAgent = isRecord(root.agentSeats) ? root.agentSeats as Record<string, unknown> : agentSeats ?? {};
    const seatOf = (agentId: string): number | null => {
      const seat = Object.hasOwn(seatsByAgent, agentId) ? seatsByAgent[agentId] : null;
      return Number.isSafeInteger(seat) ? seat as number : null;
    };
    const rules = isRecord(root.rules) ? root.rules : null;
    const config = rules?.config ?? null;
    const setup = isRecord(root.setup) ? root.setup : null;
    // The match's tick rate: its rules' config, else its setup; never a default.
    const rate = (o: Record<string, unknown> | null) => o !== null && typeof o.ticksPerSecond === "number" && Number.isFinite(o.ticksPerSecond) && o.ticksPerSecond > 0 ? o.ticksPerSecond : null;
    const tps = rate(isRecord(config) ? config : null) ?? rate(setup);
    const result = isRecord(root.result) ? (({ ratingChanges: _r, ...rest }) => rest)(root.result) : null;
    const houseIdleTicks = setup !== null && typeof setup.houseIdleTicks === "number" && Number.isFinite(setup.houseIdleTicks) && setup.houseIdleTicks > 0
      ? setup.houseIdleTicks : null;
    if (mode === "rerun") {
      for (let i = 0; i < lines.length; i++) {
        const seat = lines.seat.at(i);
        if (seat < 0) { const agent = lines.string(-1 - seat); lines.seat.data[i] = agent === "" ? -1 : seatOf(agent) ?? -1; }
      }
    }
    const bySeat = (counts: Map<number | string, number>) => {
      const out = new Map<number, number>();
      for (const [caller, n] of counts) {
        const seat = typeof caller === "string" ? seatOf(caller) : caller;
        if (seat !== null) out.set(seat, (out.get(seat) ?? 0) + n);
      }
      return out;
    };
    const agents: Record<string, number> = {};
    for (const agentId of Object.keys(seatsByAgent)) { const seat = seatOf(agentId); if (seat !== null) agents[agentId] = seat; }
    return {
      id: typeof root.id === "string" ? root.id : null,
      status: typeof root.status === "string" ? root.status : null,
      ticksPerSecond: tps,
      reduced: { config, result, rerun: rerunData(root.rerun), codeVersion: typeof root.codeVersion === "string" ? root.codeVersion : null,
        seats: [...seats].sort((a, b) => a.seat - b.seat), calls, blocks: [...blocks].sort(([a], [b]) => a - b).map(([index, { count, hash }]) => [index, count, hash.digest("hex")] as const),
        houseIdleTicks, modelIndex: setup?.modelIndex === true, lines: mode === "rerun" && repliesSeen ? lines : null },
      refusals: mode === "refused" && repliesSeen && keep ? refusals.map(({ agentId, ...r }) => agentId === undefined ? r : { ...r, seat: seatOf(agentId) }) : null,
      omitted: bySeat(omitted),
      refusedFrom: repliesSeen ? "calls" : "commands",
      survey: { source: repliesSeen ? "calls" : "commands", elements: [...elements].filter(e => e !== undefined), agentSeats: agents, replyRefused: bySeat(replyRefused) },
    };
  }

  return { push, end, pageResult, stopped: () => stopped };
}

function rerunData(value: unknown): RerunData | null {
  if (!isRecord(value)) return null;
  const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every(Number.isSafeInteger);
  const { seed, stops, abandonments, idle, houseActive } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(seed) || !ints(stops) || !ints(abandonments) || !Array.isArray(idle) || !Array.isArray(houseActive)) return null;
  if (!idle.every(e => isRecord(e) && Number.isSafeInteger(e.tick) && ints(e.colonies))) return null;
  if (!houseActive.every(r => ints(r) && r.length === 2)) return null;
  return { seed: seed as number, stops, abandonments, idle: idle as RerunData["idle"], houseActive: houseActive as [number, number][] };
}

/** Decoded record bytes between two progress calls. */
export const PROGRESS_BYTES = 1024 * 1024;

/** A record's bytes decoded: gzip by its first two bytes, else as they are. */
async function* decoded(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  const bytes = (value: Uint8Array) => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let gunzip: Gunzip | undefined;
  try {
    let head = Buffer.alloc(0), ended = false;
    while (head.length < 2) {
      const next = await iterator.next();
      if (next.done === true) { ended = true; break; }
      head = Buffer.concat([head, bytes(next.value)]);
    }
    async function* all(): AsyncGenerator<Buffer> {
      yield head;
      while (!ended) {
        const next = await iterator.next();
        if (next.done === true) return;
        yield bytes(next.value);
      }
    }
    if (head[0] === 0x1f && head[1] === 0x8b) {
      gunzip = createGunzip();
      void pipeline(Readable.from(all(), { objectMode: false }), gunzip).catch(() => {});
      for await (const chunk of gunzip) yield chunk as Buffer;
    } else yield* all();
  } finally {
    gunzip?.destroy();
    await iterator.return?.().catch(() => {});
  }
}

/** The record is not the one a continuation was made from: its bytes before the continuation's offset differ. */
export class RecordChanged extends Error {
  constructor() { super("match record changed"); }
}

/** A failure of a read: its abort reason, a record that cannot be read or has changed, else unreadable. */
function readFailure(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason;
  return error instanceof RecordReadError || error instanceof RecordChanged ? error : new RecordReadError();
}

/**
 * Scans a record's bytes, gzip or plain JSON; throws RecordReadError when it cannot be read whole. `progress` is called
 * each time about PROGRESS_BYTES more decoded bytes have been scanned.
 */
export async function scanRecord(source: AsyncIterable<Uint8Array>, signal?: AbortSignal, mode: ScanMode = "refused", progress?: () => void, options: { keep?: boolean } = {}): Promise<RecordScan> {
  const scanner = recordScanner(mode, options);
  try {
    let sinceProgress = 0;
    for await (const chunk of decoded(source)) {
      signal?.throwIfAborted();
      scanner.push(chunk);
      sinceProgress += chunk.length;
      if (progress !== undefined && sinceProgress >= PROGRESS_BYTES) { sinceProgress = 0; progress(); }
    }
    return scanner.end();
  } catch (error) { throw readFailure(error, signal); }
}

/** A record's first pass: its survey, keeping no entry, with its decoded length and SHA-256. */
export async function surveyRecord(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ scan: RecordScan; length: number; digest: string }> {
  const scanner = recordScanner("refused", { keep: false });
  const hash = createHash("sha256");
  let length = 0;
  try {
    for await (const chunk of decoded(source)) {
      signal?.throwIfAborted();
      hash.update(chunk);
      length += chunk.length;
      scanner.push(chunk);
    }
    return { scan: scanner.end(), length, digest: hash.digest("hex") };
  } catch (error) { throw readFailure(error, signal); }
}

/** SHA-256 of no bytes: the prefix before a list's first page. */
export const EMPTY_PREFIX = createHash("sha256").digest("hex");

export interface PageRead<T> {
  readonly page: PageResult<T>;
  /** SHA-256 of the decoded bytes before the next page's offset; null when there is no next page. */
  readonly nextPrefix: string | null;
  /** With drain: the whole record's decoded length and SHA-256. */
  readonly length: number | null;
  readonly digest: string | null;
}

/**
 * One page of a record read from its start: the bytes before the page's offset are hashed and counted, not parsed, and
 * must hash to `prefix`, else RecordChanged; the page then parses from its checkpoint. Without drain the read stops once
 * the page has ended; with drain it reads to the end (a private record's authentication needs every byte).
 */
export async function readRecordPage(source: AsyncIterable<Uint8Array>, signal: AbortSignal | undefined, spec: PageSpec, prefix: string, drain: boolean): Promise<PageRead<RefusedEntry | NoEffectEntry>> {
  const scanner = recordScanner("refused", { page: spec });
  const running = createHash("sha256"), whole = drain ? createHash("sha256") : null;
  const at = spec.resume?.offset ?? 0;
  // Past the offset, bytes are hashed a capped element behind: a page that stops before an element it could not keep
  // may stop where that element began, in an earlier chunk.
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  const lag = (buf: Buffer) => {
    pending.push(buf);
    pendingBytes += buf.length;
    while (pending.length > 0 && pendingBytes - pending[0]!.length > ELEMENT_CAP_BYTES) { const first = pending.shift()!; running.update(first); pendingBytes -= first.length; }
  };
  let position = 0, length = 0, checked = false, ended: PageResult<RefusedEntry | NoEffectEntry> | null = null, nextPrefix: string | null = null;
  try {
    for await (const chunk of decoded(source)) {
      signal?.throwIfAborted();
      whole?.update(chunk);
      length += chunk.length;
      if (ended === null) {
        let from = 0;
        if (position < at) { from = Math.min(chunk.length, at - position); running.update(chunk.subarray(0, from)); }
        if (!checked && position + from === at) {
          checked = true;
          if (running.copy().digest("hex") !== prefix) throw new RecordChanged();
        }
        if (checked && from < chunk.length) {
          const rest = chunk.subarray(from);
          scanner.push(rest);
          const stop = scanner.stopped();
          if (stop === null) lag(rest);
          else {
            pending.push(rest);
            pendingBytes += rest.length;
            ended = scanner.pageResult();
            if (stop.next !== null) {
              // Hash the held bytes up to the next page's offset: they end at this chunk's end.
              let remaining = pendingBytes - (position + chunk.length - stop.next.offset);
              if (remaining < 0 || remaining > pendingBytes) throw new RecordReadError();
              for (const buf of pending) {
                if (remaining <= 0) break;
                const take = Math.min(buf.length, remaining);
                running.update(buf.subarray(0, take));
                remaining -= take;
              }
              nextPrefix = running.digest("hex");
            }
          }
        }
      }
      position += chunk.length;
      if (ended !== null && !drain) break;
    }
    if (!checked) throw new RecordChanged();
    ended ??= scanner.pageResult();
    return { page: ended, nextPrefix, length: drain ? length : null, digest: whole === null ? null : whole.digest("hex") };
  } catch (error) { throw readFailure(error, signal); }
}
