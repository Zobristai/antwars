/// <reference types="node" />
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeMessage, encodeMessage, encodePublicMessage, type StreamMessage, type StreamResult } from "../live/format.js";
import { packMessages } from "../live/snapshot.js";
import { metadataAccessToken } from "../auth/metadata-token.js";
import { collect, gcsBucket, ReplayCreateError, type ReplayGet } from "../store/gcs.js";
import { binaryRecord, type MatchRecord } from "./history.js";
import { isReplayId } from "./access.js";
import { RATINGS_UNAVAILABLE } from "../records/service.js";

/**
 * One-off correction support (ANT-016): turn a stored public recording of a rated match into the shape a house-mode
 * abandoned recording carries — end result winner null, reason "abandoned", decidedBy "draw", the same tick, no rating
 * changes, and setup rated false — keeping every tick and event of the replay. Used only by
 * scripts/unrate-never-joined.ts through src/rating/unrateNeverJoined.ts.
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
 * The binary with its end result abandoned and every setup unrated, re-encoded with the stream codec. Refuses (throws)
 * unless every message, before any change, re-encodes to exactly its stored bytes, so an untouched message keeps its
 * bytes and the replay keeps its ticks and events. A binary without a terminal result is refused.
 */
export function abandonBinary(binary: Uint8Array): AbandonedBinary {
  const originals = frames(binary);
  let ended = false;
  let rewritten = 0;
  const out = originals.map((original, index) => {
    const decoded = decodeMessage(original);
    if (!sameBytes(encodeAs(original, decoded), original)) throw new Error(`replay message ${index} does not re-encode to its stored bytes`);
    if (decoded.events.some(event => event.kind === "end")) ended = true;
    const { message, changed } = abandonMessage(decoded);
    if (!changed) return original;
    rewritten++;
    return encodeAs(original, message);
  });
  if (!ended) throw new Error("replay has no terminal result");
  if (rewritten === 0) return { body: null, messages: originals.length, rewritten };
  return { body: new Uint8Array(gzipSync(packMessages(out))), messages: originals.length, rewritten };
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

/** Colonies with no seat and no join event in the record. */
export function unjoinedColonies(record: MatchRecord, colonies: readonly (0 | 1)[]): (0 | 1)[] {
  return colonies.filter(colony => !record.seats.some(seat => seat.colony === colony) &&
    !record.events.some(entry => entry.event.kind === "join" && entry.event.colony === colony));
}

/**
 * Checks a rewritten binary and record against each other with the existing decoder: the binary decodes to the
 * record's result and an unrated setup, with the same seats.
 */
export function assertConsistent(id: string, binary: Uint8Array, record: MatchRecord): void {
  const decoded = binaryRecord({ id, binary });
  if (JSON.stringify(decoded.result) !== JSON.stringify(record.result)) throw new Error("rewritten binary and record disagree on the result");
  if (decoded.setup?.rated !== false || record.setup?.rated !== false) throw new Error("rewritten recording is not unrated");
  const seats = (list: MatchRecord["seats"]) => JSON.stringify(list.map(({ seat, colony, joinedTick }) => ({ seat, colony, joinedTick })));
  if (seats(decoded.seats) !== seats(record.seats)) throw new Error("rewritten binary and record disagree on seats");
}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly generation: string;
  readonly contentType: string;
  readonly contentEncoding?: "gzip";
}

/** The object operations the correction needs from one bucket. */
export interface RecordingObjects {
  /** The stored bytes as stored (never transcoded) with their generation; null when absent. */
  read(name: string): Promise<StoredObject | null>;
  /** Replaces exactly `generation` and returns the new generation; a changed object fails (GCS 412) and nothing is written. */
  replace(name: string, object: Omit<StoredObject, "generation">, generation: string): Promise<string>;
}

const GENERATION = /^[1-9]\d*$/;

/** A bucket through the Cloud Run service identity (as every other bucket client here); never a key file. */
export function gcsRecordingObjects(bucket: string, request: typeof fetch = fetch, get?: ReplayGet): RecordingObjects {
  const objects = gcsBucket(bucket, request, get);
  async function metadata(name: string, token: string): Promise<{ generation: string; contentType: string; contentEncoding?: "gzip" } | null> {
    const response = await objects.call(objects.url(name, { fields: "generation,contentType,contentEncoding" }), { token });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`object metadata read failed: HTTP ${response.status}`); }
    const value = await response.json() as { generation?: unknown; contentType?: unknown; contentEncoding?: unknown };
    if (typeof value.generation !== "string" || !GENERATION.test(value.generation) || typeof value.contentType !== "string") {
      throw new Error("object metadata is invalid");
    }
    if (value.contentEncoding !== undefined && value.contentEncoding !== "gzip") throw new Error(`unsupported content encoding ${String(value.contentEncoding)}`);
    return { generation: value.generation, contentType: value.contentType, ...(value.contentEncoding === "gzip" ? { contentEncoding: "gzip" as const } : {}) };
  }
  return {
    async read(name) {
      const token = await metadataAccessToken(request);
      const meta = await metadata(name, token);
      if (meta === null) return null;
      const body = await collect(await objects.open(name, token, AbortSignal.timeout(120_000),
        { failed: "recording read failed", headers: "recording read headers timed out", idle: "recording read idle" }, meta.generation)
        .then(res => res === null ? null : { body: res }));
      if (body === null) throw new Error(`object ${name} vanished during read`);
      return { ...meta, body };
    },
    async replace(name, object, generation) {
      if (!GENERATION.test(generation)) throw new Error("invalid generation");
      // As gcsBucket's media upload (encoding is object metadata, not a request header), reading the new generation back.
      const target = objects.url(undefined, { uploadType: "media", name, ifGenerationMatch: generation, contentEncoding: object.contentEncoding }, true);
      const response = await objects.call(target, { method: "POST", token: await metadataAccessToken(request),
        headers: { "content-type": object.contentType }, body: Buffer.from(object.body) });
      if (response.status === 412) { await response.body?.cancel(); throw new Error(`object ${name} changed since it was verified; nothing replaced`); }
      if (!response.ok) { await response.body?.cancel(); throw new ReplayCreateError(response.status); }
      const value = await response.json() as { generation?: unknown };
      if (typeof value.generation !== "string" || !GENERATION.test(value.generation)) throw new Error(`object ${name} replaced but its new generation is unknown`);
      return value.generation;
    },
  };
}

export const recordName = (replayId: string): string => { if (!isReplayId(replayId)) throw new Error("invalid replay id"); return `${replayId}.json`; };
export const binaryName = (replayId: string): string => { if (!isReplayId(replayId)) throw new Error("invalid replay id"); return `${replayId}.bin`; };

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
