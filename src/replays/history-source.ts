import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { isReplayId, type ReplayGet } from "./access.js";
import { metadataAccessToken } from "../auth/metadata-token.js";
import { isGzip, peek, relayed } from "../net/relay.js";
import { gcsBucket } from "../store/gcs.js";

export interface HistorySummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  simulationEndedAt: string | null;
  winner: 0 | 1 | null;
  reason: string | null;
  decidedBy: string | null;
  /** startRating: the seat's rating, RD and rated-match count at match start where its record stored them, else null. parseSummary
   * always sets it; a summary built elsewhere without it has none. */
  seats: { seat: number; colony: 0 | 1; modelLabel: string | null; thinkingLevel: string | null; serviceTier: string | null; handle: string | null;
    startRating?: { rating: number; rd: number; ratedMatches: number } | null }[];
  status: "complete" | "partial" | "unavailable";
  unavailable: string[];
  /**
   * The record's setup.rated: false where its setup omits it (an unrated match), null where it has no setup. parseSummary
   * always sets it and modelIndex; a summary built elsewhere without them reads as an unknown rated flag.
   */
  rated?: boolean | null;
  /** The record's setup.modelIndex marker: an Antwars Model Index match. */
  modelIndex?: boolean;
  /** The record's setup.colonyNames: an unrated match's drawn names; absent where the match used the rated names. */
  colonyNames?: [string, string];
}
export interface HistoryPage { matches: HistorySummary[]; nextPageToken: string | null }
export interface HistorySource {
  list(pageToken: string | undefined, signal: AbortSignal): Promise<HistoryPage>;
  /**
   * Decoded JSON byte stream. null means missing (or, given a generation, that generation missing); consumer owns its
   * destruction. Its storedIdentity is the stored object's generation and length as the reply that carries it gives them.
   */
  open(id: string, signal: AbortSignal, generation?: string): Promise<Readable | null>;
  /**
   * The listing rows as served, where a source changes them: the /matches route applies it last, after it has typed
   * each row and filled its missing seat handles from the lobby, so it sees every value the page will serve.
   */
  listed?<Row extends HistorySummary>(rows: readonly Row[]): Promise<Row[]>;
}
export function validHistoryPageToken(token: string): boolean {
  return token.length > 0 && token.length <= 2048 && /^[\x21-\x7e]+$/.test(token);
}

/** A stored object's generation and stored length, from the one reply whose bytes a stream carries. */
export interface StoredIdentity { readonly generation: string; readonly storedLength: number }
const identities = new WeakMap<Readable, StoredIdentity>();
/** The identity of the reply an opened record's stream carries; undefined where its source gives none. */
export function storedIdentity(stream: Readable): StoredIdentity | undefined { return identities.get(stream); }
/** A reply's identity headers, both valid, else none. */
function identityOf(headers: Readonly<Record<string, string | string[] | undefined>>): StoredIdentity | undefined {
  const generation = headers["x-goog-generation"], length = headers["x-goog-stored-content-length"];
  if (typeof generation !== "string" || !/^[1-9]\d{0,19}$/.test(generation) || typeof length !== "string" || !/^\d{1,20}$/.test(length)) return undefined;
  const storedLength = Number(length);
  return Number.isSafeInteger(storedLength) ? { generation, storedLength } : undefined;
}

/** A record that cannot be summarised: list() leaves it off its page instead of failing the page. */
export class RecordSummaryError extends Error {}

const SUMMARY_READ_LIMIT = 64 * 1024 * 1024;
const EVENTS_KEY = new TextEncoder().encode("events");
/**
 * Finds the opening quote of the record's top-level "events" key across successive decoded chunks, returning its
 * absolute byte offset or -1. Every summary field is written before events (and replies after them), so the summary
 * needs only the bytes before it. JSON structure bytes are ASCII and never occur inside a UTF-8 multi-byte sequence,
 * so a byte scan is exact; strings, escapes and nesting are tracked so a nested key or a string value never matches.
 */
function topLevelEventsKey(): (chunk: Uint8Array) => number {
  let offset = 0, depth = 0, started = false, objectRoot = false, expectKey = false;
  let inString = false, escaped = false, key = false, keyStart = -1, keyLength = 0, keyMatches = false;
  return chunk => {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (byte === 0x5c) { escaped = true; keyMatches = false; continue; }
        if (byte === 0x22) {
          inString = false;
          if (key && keyMatches && keyLength === EVENTS_KEY.length) return keyStart;
          key = false; continue;
        }
        if (key) { keyMatches = keyMatches && keyLength < EVENTS_KEY.length && byte === EVENTS_KEY[keyLength]; keyLength++; }
        continue;
      }
      if (byte === 0x22) {
        inString = true;
        if (expectKey && depth === 1 && objectRoot) { key = true; keyStart = offset + i; keyLength = 0; keyMatches = true; }
        expectKey = false;
      } else if (byte === 0x7b || byte === 0x5b) {
        if (!started) { started = true; objectRoot = byte === 0x7b; }
        depth++; expectKey = depth === 1 && byte === 0x7b;
      } else if (byte === 0x7d || byte === 0x5d) { depth--; expectKey = false; }
      else if (byte === 0x2c) expectKey = depth === 1;
      else if (byte === 0x3a) expectKey = false;
    }
    offset += chunk.length;
    return -1;
  };
}
/** The record's bytes before its top-level events key, closed as an object: drop trailing whitespace and the comma. */
function closedHead(head: Buffer): Buffer {
  let end = head.length;
  while (end > 0 && [0x20, 0x09, 0x0a, 0x0d].includes(head[end - 1]!)) end--;
  if (end > 0 && head[end - 1] === 0x2c) end--;
  return Buffer.concat([head.subarray(0, end), Buffer.from("}")]);
}

// Parsing runs off the match timer, even for large full records, in a worker that loads
// only the summary checks (history-summary-worker.ts); never return command/event arrays.
function summarize(id: string, bytes: Uint8Array, signal: AbortSignal): Promise<HistorySummary> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./history-summary-worker.ts", import.meta.url), {
      workerData: { kind: "match-summary", id, bytes }, transferList: [bytes.buffer as ArrayBuffer],
      execArgv: ["--import", new URL("../ts-resolve.mjs", import.meta.url).href],
    });
    const stop = () => { void worker.terminate(); reject(new Error("match summary canceled")); };
    const timer = setTimeout(stop, 15_000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    worker.once("message", (message: { summary?: HistorySummary; error?: string }) => {
      cleanup();
      if (message.summary) resolve(message.summary); else reject(new RecordSummaryError("Invalid match record."));
    });
    worker.once("error", error => { cleanup(); reject(error); });
    worker.once("exit", code => { cleanup(); reject(new Error(`match summary exited ${code} before returning data`)); });
  });
}

async function* decodedJson(raw: Readable, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  try {
    const start = await peek(raw, 2);
    const packed = Readable.from(relayed(start), { objectMode: false });
    if (!isGzip(start.head)) { try { yield* packed; } finally { packed.destroy(); } return; }
    const gunzip = createGunzip();
    const pumping = pipeline(packed, gunzip, { signal });
    void pumping.catch(() => {});
    try { for await (const chunk of gunzip) yield chunk as Buffer; await pumping; }
    finally { packed.destroy(); gunzip.destroy(); await pumping.catch(() => {}); }
  } finally { raw.destroy(); }
}

interface PendingSummary {
  controller: AbortController;
  promise: Promise<HistorySummary>;
  waiters: number;
  settled: boolean;
}

type SummaryReader = (id: string, token: string, signal: AbortSignal, generation?: string) => Promise<HistorySummary>;

/** Internal reuse boundary. The injected reader returns validated summaries, never full records. */
export function createHistorySummaryCache(readRecord: SummaryReader) {
  // One bounded summary per observed record, not a fixed total-capacity LRU:
  // whole-history traversal must not evict its own warmed entries as it grows.
  const latest = new Map<string, { generation: string | undefined; observation: number; json?: string }>();
  const pending = new Map<string, PendingSummary>();
  let observation = 0;
  async function sharedSummary(id: string, generation: string | undefined, token: string, signal: AbortSignal): Promise<HistorySummary> {
    signal.throwIfAborted();
    // Without a provider version there is no safe cache identity. Preserve the
    // uncached read rather than treating an arbitrary id as immutable.
    if (generation === undefined) return readRecord(id, token, signal);
    const key = `${id}/${generation}`;
    const hit = latest.get(id);
    if (hit?.generation === generation && hit.json !== undefined) return JSON.parse(hit.json) as HistorySummary;
    let work = pending.get(key);
    if (!work) {
      const controller = new AbortController();
      const created: PendingSummary = { controller, waiters: 0, settled: false,
        promise: Promise.resolve().then(() => readRecord(id, token, controller.signal, generation)).then(summary => {
          // An abandoned read may finish after a replacement has started. It
          // must not cache success or remove that replacement's map entry.
          controller.signal.throwIfAborted();
          const current = latest.get(id);
          if (current?.generation === generation) current.json = JSON.stringify(summary);
          return summary;
        }).finally(() => {
          created.settled = true;
          if (pending.get(key) === created) pending.delete(key);
        }) };
      pending.set(key, created); work = created;
    }
    const current = work;
    current.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (deliver: () => void) => {
        if (done) return;
        done = true; signal.removeEventListener("abort", cancel);
        current.waiters--;
        if (current.waiters === 0 && !current.settled) {
          if (pending.get(key) === current) pending.delete(key);
          current.controller.abort();
        }
        deliver();
      };
      const cancel = () => finish(() => reject(signal.reason));
      signal.addEventListener("abort", cancel, { once: true });
      current.promise.then(summary => finish(() => resolve(structuredClone(summary))), error => finish(() => reject(error)));
      if (signal.aborted) cancel();
    });
  }
  return {
    beginPage() {
      // Order by discovery start, not response/worker completion or a numeric
      // ordering of opaque provider generations. Late old pages cannot roll
      // back a newer page's observation; old reads may still serve their waiters.
      const pageObservation = ++observation;
      return (id: string, generation: string | undefined, token: string, signal: AbortSignal): Promise<HistorySummary> => {
        signal.throwIfAborted();
        const previous = latest.get(id);
        if (!previous || pageObservation >= previous.observation) {
          if (previous && previous.generation === generation) previous.observation = pageObservation;
          else latest.set(id, { generation, observation: pageObservation });
        }
        return sharedSummary(id, generation, token, signal);
      };
    },
  };
}

const LABELS = { failed: "match record read failed", headers: "match record headers timed out", idle: "match record read idle timeout" };

/** Cloud Run identity only; JSON listings survive process restarts. No IAM or write APIs. */
export function createGcsHistorySource(bucket: string, request: typeof fetch = fetch, get?: ReplayGet): HistorySource {
  const objects = gcsBucket(bucket, request, get);
  // Each source's reuse boundary is scoped to this bucket and transport.
  const summaries = createHistorySummaryCache(readSummary);
  async function readSummary(id: string, token: string, signal: AbortSignal, generation?: string): Promise<HistorySummary> {
    const body = await openWithToken(id, token, signal, generation);
    if (body === null) throw new RecordSummaryError("listed match record disappeared");
    // Read only the record's head: everything before its top-level events key. A record without one is read
    // whole, still bounded by the summary read limit.
    const chunks: Uint8Array[] = [];
    const eventsAt = topLevelEventsKey();
    let size = 0, cut = false;
    try {
      for await (const chunk of body) {
        const bytes = chunk as Uint8Array, at = eventsAt(bytes);
        // at is an absolute offset and may fall in an earlier chunk when the key straddles a boundary; cut after concat.
        chunks.push(bytes);
        if (at >= 0) { size = at; cut = true; } else size += bytes.length;
        if (size > SUMMARY_READ_LIMIT) throw new RecordSummaryError("match record exceeds summary read limit");
        if (cut) break;
      }
    } finally { body.destroy(); }
    const head = cut ? Buffer.concat(chunks).subarray(0, size) : Buffer.concat(chunks);
    // Standalone buffer: never detach a pooled Buffer used by another read.
    return summarize(id, new Uint8Array(cut ? closedHead(head) : head), signal);
  }
  async function openWithToken(id: string, token: string, signal: AbortSignal, generation?: string): Promise<Readable | null> {
    const raw = await objects.open(`${id}.json`, token, signal, LABELS, generation);
    if (raw === null) return null;
    const body = Readable.from(decodedJson(raw, signal), { objectMode: false, signal });
    const identity = identityOf(raw.headers);
    if (identity !== undefined) identities.set(body, identity);
    // Guard the handoff, including client disconnect before pipeline attaches.
    body.on("error", () => {});
    body.once("close", () => raw.destroy());
    return body;
  }
  return {
    async open(id, signal, generation) {
      if (!isReplayId(id)) throw new Error("invalid match id");
      if (generation !== undefined && !/^[1-9]\d{0,19}$/.test(generation)) throw new Error("invalid generation");
      return openWithToken(id, await metadataAccessToken(request, signal), signal, generation);
    },
    async list(pageToken, signal) {
      // Our cursor is an exclusive name boundary, not GCS's ascending cursor.
      // Names begin with the exact UTC start timestamp; the suffix breaks ties.
      const cursorPrefix = "newest-v1:";
      const before = pageToken?.slice(cursorPrefix.length);
      if (pageToken !== undefined && (!pageToken.startsWith(cursorPrefix) || !isReplayId(before!))) throw new Error("invalid match page token");
      signal.throwIfAborted();
      const summaryForPage = summaries.beginPage();
      const token = await metadataAccessToken(request, signal);
      const limit = 20;
      const newest: { id: string; generation?: string }[] = [];
      const seen = new Set<string>();
      let providerToken: string | undefined;
      // GCS has no descending listing. Scan metadata only, retaining 21 names
      // (one lookahead), then read at most 20 records. Never parse all history.
      // Every request shares the caller's whole-page deadline and cancellation.
      do {
        signal.throwIfAborted();
        // Saved records only: "*" never matches "/", so private/v1/*.sealed and .bin replays stay in storage.
        const response = await objects.call(objects.url(undefined, { maxResults: "1000", matchGlob: "*.json",
          fields: "items(name,generation),nextPageToken", endOffset: before && `${before}.json`, pageToken: providerToken }), { token, signal });
        if (!response.ok) { await response.body?.cancel(); throw new Error("match history list failed"); }
        const page = z.object({ items: z.array(z.object({ name: z.string(), generation: z.string().regex(/^[1-9]\d{0,19}$/).optional() })).max(1000).optional(),
          nextPageToken: z.string().optional() }).parse(await response.json());
        signal.throwIfAborted();
        for (const object of page.items ?? []) {
          if (!object.name.endsWith(".json")) continue;
          const id = object.name.slice(0, -5);
          if (!isReplayId(id) || (before !== undefined && id >= before) || newest.some(item => item.id === id)) continue;
          newest.push({ id, generation: object.generation });
          newest.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
          if (newest.length > limit + 1) newest.pop();
        }
        providerToken = page.nextPageToken;
        if (providerToken !== undefined) {
          if (!validHistoryPageToken(providerToken) || seen.has(providerToken)) throw new Error("invalid match page continuation");
          seen.add(providerToken);
        }
      } while (providerToken !== undefined);
      const matches: HistorySummary[] = [];
      for (const object of newest.slice(0, limit)) {
        // A record that cannot be summarised is left off the page; transport, deadline and cancellation still fail it.
        try { matches.push(await summaryForPage(object.id, object.generation, token, signal)); }
        catch (error) {
          if (!(error instanceof RecordSummaryError) || signal.aborted) throw error;
          // Id and the fixed reason only: every RecordSummaryError message is a literal here, never record bytes.
          console.info(`antwar history record ${object.id} left off listing page: ${error.message}`);
        }
        signal.throwIfAborted();
      }
      return { matches, nextPageToken: newest.length > limit ? `${cursorPrefix}${newest[limit - 1]!.id}` : null };
    },
  };
}
export function historySourceFromEnv(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch, get?: ReplayGet): HistorySource | undefined {
  return env.ANTWAR_REPLAY_BUCKET ? createGcsHistorySource(env.ANTWAR_REPLAY_BUCKET, request, get) : undefined;
}
