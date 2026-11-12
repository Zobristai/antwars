/// <reference types="node" />
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeMessage, encodeMessage, encodePublicMessage, type StreamMessage, type StreamResult } from "../live/format.js";
import { packMessages } from "../live/snapshot.js";
import type { MatchRecord } from "./history.js";
import { RATINGS_UNAVAILABLE } from "../records/service.js";

/**
 * Turns a stored public recording of a rated match into the shape a house-mode abandoned recording carries — end
 * result winner null, reason "abandoned", decidedBy "draw", the same tick, no rating changes, and setup rated false —
 * keeping every tick and event of the replay. Used to serve the corrected never-joined match (correctedRecordings.ts),
 * which also uses rewriteMessages, parseRecord and serializeRecord; no stored recording is rewritten.
 */

/** The result an abandoned match records (src/live/hub.ts, src/replays/history.ts): no winner, decided by draw. */
export function abandonedResult<T extends Omit<StreamResult, "nextStartMs">>(result: T): T {
  const { ratingChanges: _ratings, ...rest } = result;
  return { ...rest, winner: null, reason: "abandoned", decidedBy: "draw" } as T;
}

export const isAbandonedResult = (result: Omit<StreamResult, "nextStartMs"> | null): boolean =>
  result !== null && result.winner === null && result.reason === "abandoned" && result.decidedBy === "draw" && result.ratingChanges === undefined;

/** Public messages carry flag bit 1 (setup redaction); they re-encode through encodePublicMessage. */
const SETUP_REDACTED = 2;

function frames(binary: Uint8Array): Uint8Array[] {
  const raw = binary[0] === 0x1f && binary[1] === 0x8b ? gunzipSync(binary) : binary;
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("truncated replay length prefix");
    const length = view.getUint32(offset, true); offset += 4;
    if (length === 0 || offset + length > bytes.length) throw new Error("truncated replay message");
    out.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  return out;
}

const encodeAs = (original: Uint8Array, message: StreamMessage): Uint8Array =>
  (original[3]! & SETUP_REDACTED) !== 0 ? encodePublicMessage(message) : encodeMessage(message);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

function abandonMessage(message: StreamMessage): { message: StreamMessage; changed: boolean } {
  let changed = false;
  const full = message.full === null ? null : { ...message.full };
  if (full !== null) {
    if (full.setup.rated === true) { full.setup = { ...full.setup, rated: false }; changed = true; }
    if (full.result != null && !isAbandonedResult(full.result)) { full.result = abandonedResult(full.result); changed = true; }
  }
  const events = message.events.map(event => {
    if (event.kind !== "end" || isAbandonedResult(event.result)) return event;
    changed = true;
    return { ...event, result: abandonedResult(event.result) };
  });
  return { message: { ...message, full, events }, changed };
}

export interface AbandonedBinary {
  /** The rewritten gzip body; null when the binary already carries the abandoned shape. */
  readonly body: Uint8Array | null;
  readonly messages: number;
  readonly rewritten: number;
}

/**
 * The binary with each message `change` returns re-encoded in its place (null keeps that message's stored bytes),
 * gzipped. Refuses (throws) unless every message, before any change, re-encodes to exactly its stored bytes, so an
 * untouched message keeps its bytes and the replay keeps its ticks and events. body is null when nothing changed.
 */
export function rewriteMessages(binary: Uint8Array, change: (message: StreamMessage) => StreamMessage | null): AbandonedBinary {
  const originals = frames(binary);
  let rewritten = 0;
  const out = originals.map((original, index) => {
    const decoded = decodeMessage(original);
    if (!sameBytes(encodeAs(original, decoded), original)) throw new Error(`replay message ${index} does not re-encode to its stored bytes`);
    const message = change(decoded);
    if (message === null) return original;
    rewritten++;
    return encodeAs(original, message);
  });
  if (rewritten === 0) return { body: null, messages: originals.length, rewritten };
  return { body: new Uint8Array(gzipSync(packMessages(out))), messages: originals.length, rewritten };
}

/**
 * The binary with its end result abandoned and every setup unrated (rewriteMessages). A binary without a terminal
 * result is refused.
 */
export function abandonBinary(binary: Uint8Array): AbandonedBinary {
  let ended = false;
  const out = rewriteMessages(binary, decoded => {
    if (decoded.events.some(event => event.kind === "end")) ended = true;
    const { message, changed } = abandonMessage(decoded);
    return changed ? message : null;
  });
  if (!ended) throw new Error("replay has no terminal result");
  return out;
}

/** The record with the abandoned result (top level and its end event), setup rated false and no ratings-unavailable note. */
export function abandonRecord(record: MatchRecord): MatchRecord {
  if (record.result === null || record.setup === null) throw new Error("record has no result or setup");
  return {
    ...record,
    setup: { ...record.setup, rated: false },
    result: abandonedResult(record.result),
    unavailable: record.unavailable.filter(reason => reason !== RATINGS_UNAVAILABLE),
    events: record.events.map(entry => entry.event.kind === "end"
      ? { ...entry, event: { ...entry.event, result: abandonedResult(entry.event.result) } } : entry),
  };
}

export const isAbandonedRecord = (record: MatchRecord): boolean =>
  isAbandonedResult(record.result) && record.setup?.rated === false && !record.unavailable.includes(RATINGS_UNAVAILABLE) &&
  record.events.every(entry => entry.event.kind !== "end" || isAbandonedResult(entry.event.result));

export function parseRecord(id: string, body: Uint8Array): MatchRecord {
  const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as MatchRecord;
  if (typeof value !== "object" || value === null || value.format !== "antwar.match" || value.version !== 1 || value.id !== id) {
    throw new Error("stored match record has the wrong identity");
  }
  if (!Array.isArray(value.seats) || !Array.isArray(value.events) || !Array.isArray(value.unavailable)) throw new Error("stored match record is malformed");
  return value;
}

/** Serialized as the record service stores a record: JSON then a newline. */
export const serializeRecord = (record: MatchRecord): Uint8Array => new TextEncoder().encode(JSON.stringify(record) + "\n");
