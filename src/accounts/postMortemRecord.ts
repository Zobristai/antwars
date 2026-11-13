/**
 * One streaming pass over a stored match record (src/replays/history.ts MatchRecord) for the post-mortem: the refused
 * calls of every seat and the reduced record a re-run needs, with no record-size cap. Large arrays are parsed one element
 * at a time and never held whole: events keep only each call's [tick, seat] (the re-run's call order, as
 * test/replays/history.test.ts rebuild), replies keep only their refusals, and each seat's commands are kept element by
 * element. Every other byte counts against one total cap, so a corrupted record (an inverted quote, say) fails instead
 * of buffering without bound. A record that cannot be read whole fails as RecordReadError, with no detail of its content.
 */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, type Gunzip } from "node:zlib";
import { entryCode } from "../replays/recording.js";

/** One element of events, replies or a seat's commands longer than this fails the read, except a replies text line. */
export const ELEMENT_CAP_BYTES = 256 * 1024;
/** All bytes outside those elements (every other member, kept or not) together. */
export const OTHER_CAP_BYTES = 8 * 1024 * 1024;
const KEY_CAP_BYTES = 1024;

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
  readonly commands: ReducedCommand[];
}

export interface RerunData {
  readonly seed: number;
  readonly stops: number[];
  readonly abandonments: number[];
  readonly idle: { tick: number; colonies: number[] }[];
  readonly houseActive: [number, number][];
}

/** What a re-run needs from the record, and no more. */
export interface ReducedRecord {
  readonly config: unknown;
  readonly result: { readonly winner: unknown; readonly reason: unknown } | null;
  readonly rerun: RerunData | null;
  readonly codeVersion: string | null;
  readonly seats: ReducedSeat[];
  /** Each call event's [tick, seat], in record order. */
  readonly calls: [number, number][];
}

export interface RecordScan {
  readonly id: string | null;
  readonly status: string | null;
  readonly ticksPerSecond: number | null;
  readonly reduced: ReducedRecord;
  /** The calls refused, from replies; null when the record retained no replies. */
  readonly refusals: Refusal[] | null;
  /** Calls a seat-budget stub left out, by seat. */
  readonly omitted: ReadonlyMap<number, number>;
}

type Role = "root" | "seats" | "seat" | "commands" | "events" | "replies";
interface Frame {
  readonly kind: "obj" | "arr";
  readonly role: Role;
  /** obj: expecting a key, a colon, a value or a comma/close. arr: a value or a comma/close. */
  state: "firstKey" | "key" | "colon" | "value" | "next" | "first";
  key: string | null;
  seat?: Record<string, unknown> & { commands: ReducedCommand[] };
}
type Sink = "events" | "replies" | "commands" | "member";
interface Capture {
  readonly sink: Sink;
  readonly key: string | null;
  readonly owner: Frame;
  readonly mode: "container" | "string" | "bare";
  parts: Buffer[] | null;
  length: number;
  depth: number;
  opened: boolean;
  inString: boolean;
  escaped: boolean;
}

const ROOT_KEPT = new Set(["id", "status", "rules", "result", "rerun", "codeVersion", "agentSeats"]);
const SEAT_KEPT = new Set(["seat", "colony", "handle"]);
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const TEXT_PREFIX = Buffer.from('{"type":"text"');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (): never => { throw new RecordReadError(); };

/** The streaming scanner: push decoded JSON bytes, then end(). */
export function recordScanner() {
  const stack: Frame[] = [];
  let started = false, finished = false, other = 0;
  let capture: Capture | null = null;
  let keyBytes: number[] | null = null, keyEscaped = false, keyEscape = false;
  const root: Record<string, unknown> = {};
  const seats: ReducedSeat[] = [];
  const calls: [number, number][] = [];
  const refusals: (Refusal & { agentId?: string })[] = [];
  const omitted = new Map<number | string, number>();
  let repliesSeen = false;

  const countOther = (n: number) => { other += n; if (other > OTHER_CAP_BYTES) fail(); };

  function element(sink: Sink, bytes: Buffer, owner: Frame, key: string | null): void {
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(); }
    if (sink === "events") {
      if (!isRecord(value) || !isRecord(value.event)) fail();
      const { tick, event } = value as { tick: unknown; event: Record<string, unknown> };
      if (event.kind === "call") {
        if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(event.agent)) fail();
        calls.push([tick as number, event.agent as number]);
      }
    } else if (sink === "replies") reply(value);
    else if (sink === "commands") {
      if (!isRecord(value) || !Number.isSafeInteger(value.tick) || typeof value.type !== "string" || typeof value.accepted !== "boolean") fail();
      const v = value as Record<string, unknown>;
      const error = isRecord(v.error) && typeof v.error.code === "string" ? v.error.code : null;
      owner.seat!.commands.push({ tick: v.tick as number, type: v.type as string, accepted: v.accepted as boolean,
        request: isRecord(v.request) ? v.request : null, errorCode: error });
    } else if (owner.role === "root") {
      if (key !== null && ROOT_KEPT.has(key)) root[key] = value;
      if (key === "replies" && value === null) repliesSeen = false;
    } else if (owner.role === "seat" && key !== null && SEAT_KEPT.has(key)) owner.seat![key] = value;
  }

  function reply(value: unknown): void {
    if (!isRecord(value)) fail();
    const line = value as Record<string, unknown>;
    if (line.type === "text") return;
    if (line.type !== "reply" && line.type !== "stub") fail();
    const agentId = typeof line.agentId === "string" ? line.agentId : null;
    const seat = agentId === null && Number.isSafeInteger(line.seat) ? line.seat as number : null;
    const callerKey = agentId ?? seat;
    if (line.type === "stub" && Number.isSafeInteger(line.omitted) && (line.omitted as number) > 0 && callerKey !== null) {
      omitted.set(callerKey, (omitted.get(callerKey) ?? 0) + (line.omitted as number));
    }
    const code = line.type === "stub" ? (typeof line.code === "string" ? line.code : null) : entryCode(line);
    if (code === null) return;
    refusals.push({ seat, ...(agentId === null ? {} : { agentId }),
      tick: Number.isSafeInteger(line.tick) ? line.tick as number : null, tool: typeof line.tool === "string" ? line.tool : "",
      receivedAt: typeof line.receivedAt === "number" ? line.receivedAt : null, code });
  }

  /** The sink a value at the top frame's position goes to, or a frame role to descend into. */
  function route(frame: Frame, byte: number): { descend: Role; kind: "obj" | "arr" } | { sink: Sink } {
    if (frame.role === "root") {
      const key = frame.key;
      if (byte === 0x5b && (key === "events" || key === "replies" || key === "seats")) {
        if (key === "replies") repliesSeen = true;
        return { descend: key, kind: "arr" };
      }
      return { sink: "member" };
    }
    if (frame.role === "seats") return byte === 0x7b ? { descend: "seat", kind: "obj" } : fail();
    if (frame.role === "seat") return frame.key === "commands" && byte === 0x5b ? { descend: "commands", kind: "arr" } : { sink: "member" };
    return { sink: frame.role as Sink };
  }

  function beginValue(frame: Frame, byte: number): void {
    const target = route(frame, byte);
    if ("descend" in target) {
      countOther(1);
      const child: Frame = { kind: target.kind, role: target.descend, state: target.kind === "obj" ? "firstKey" : "first", key: null };
      if (target.descend === "seat") child.seat = { commands: [] };
      if (target.descend === "commands") child.seat = frame.seat;
      stack.push(child);
      return;
    }
    const mode = byte === 0x7b || byte === 0x5b ? "container" : byte === 0x22 ? "string" : "bare";
    capture = { sink: target.sink, key: frame.key, owner: frame, mode, parts: [], length: 0, depth: 0, opened: false, inString: false, escaped: false };
  }

  function closeFrame(): void {
    const frame = stack.pop()!;
    countOther(1);
    if (frame.role === "seat") {
      const s = frame.seat!;
      if (!Number.isSafeInteger(s.seat) || (s.colony !== 0 && s.colony !== 1)) fail();
      seats.push({ seat: s.seat as number, colony: s.colony as 0 | 1, handle: typeof s.handle === "string" ? s.handle : null, commands: s.commands });
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
    if (c.parts !== null) element(c.sink, Buffer.concat(c.parts), c.owner, c.key);
    afterValue(c.owner);
    return next;
  }

  function push(input: Uint8Array): void {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let i = 0;
    while (i < chunk.length) {
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
      if (WHITESPACE.has(byte)) { countOther(1); continue; }
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
          beginValue(frame, byte);
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
          beginValue(frame, byte);
          i--;
          if (capture === null) i++;
          continue;
        }
        if (byte === 0x2c) { countOther(1); frame.state = "value"; continue; }
        if (byte === 0x5d) { closeFrame(); continue; }
        fail();
      }
    }
  }

  function end(agentSeats?: Readonly<Record<string, number | null>>): RecordScan {
    if (capture !== null || keyBytes !== null || !finished) fail();
    const seatsByAgent = isRecord(root.agentSeats) ? root.agentSeats as Record<string, unknown> : agentSeats ?? {};
    const seatOf = (agentId: string): number | null => {
      const seat = Object.hasOwn(seatsByAgent, agentId) ? seatsByAgent[agentId] : null;
      return Number.isSafeInteger(seat) ? seat as number : null;
    };
    const rules = isRecord(root.rules) ? root.rules : null;
    const config = rules?.config ?? null;
    const tps = isRecord(config) && typeof config.ticksPerSecond === "number" && config.ticksPerSecond > 0 ? config.ticksPerSecond : null;
    const result = isRecord(root.result) ? { winner: root.result.winner, reason: root.result.reason } : null;
    const omittedBySeat = new Map<number, number>();
    for (const [caller, n] of omitted) {
      const seat = typeof caller === "string" ? seatOf(caller) : caller;
      if (seat !== null) omittedBySeat.set(seat, (omittedBySeat.get(seat) ?? 0) + n);
    }
    return {
      id: typeof root.id === "string" ? root.id : null,
      status: typeof root.status === "string" ? root.status : null,
      ticksPerSecond: tps,
      reduced: { config, result, rerun: rerunData(root.rerun), codeVersion: typeof root.codeVersion === "string" ? root.codeVersion : null,
        seats: [...seats].sort((a, b) => a.seat - b.seat), calls },
      refusals: repliesSeen ? refusals.map(({ agentId, ...r }) => agentId === undefined ? r : { ...r, seat: seatOf(agentId) }) : null,
      omitted: omittedBySeat,
    };
  }

  return { push, end };
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

/** Scans a record's bytes, gzip or plain JSON; throws RecordReadError when it cannot be read whole. */
export async function scanRecord(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<RecordScan> {
  const scanner = recordScanner();
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
    let body: AsyncIterable<Uint8Array> = all();
    if (head[0] === 0x1f && head[1] === 0x8b) {
      gunzip = createGunzip();
      void pipeline(Readable.from(all(), { objectMode: false }), gunzip).catch(() => {});
      body = gunzip;
    }
    for await (const chunk of body) {
      signal?.throwIfAborted();
      scanner.push(chunk);
    }
    return scanner.end();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof RecordReadError) throw error;
    throw new RecordReadError();
  } finally {
    gunzip?.destroy();
    await iterator.return?.().catch(() => {});
  }
}
