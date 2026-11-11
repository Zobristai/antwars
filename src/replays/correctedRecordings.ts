/// <reference types="node" />
import { Readable } from "node:stream";
import type { StreamIdentity, StreamMessage } from "../live/format.js";
import { CORRECTION_MARKER, NEVER_JOINED, SOL_MOVES } from "../rating/correctionPlan.js";
import { CORRECTION_KIND } from "../rating/unrateNeverJoined.js";
import type { Store } from "../store/firestore.js";
import { abandonBinary, abandonRecord, isAbandonedRecord, parseRecord, rewriteMessages, serializeRecord } from "./abandonRecording.js";
import type { ReplayRead, ReplaySource } from "./access.js";
import type { HistorySource, HistorySummary } from "./history-source.js";
import { seatHandle } from "./recorded-match-type.js";

/**
 * The public view of the matches the one-off rating corrections changed, without rewriting any stored recording.
 * Each match is shown corrected only once its own correction reads applied:
 *
 * - the never-joined match (NEVER_JOINED), once its correction record ratingCorrections/<lobby id> names it: its replay,
 *   record and listing row read abandoned and unrated (abandonRecording.ts);
 * - each house-1v1 match moved to a -fast handle (SOL_MOVES), once CORRECTION_MARKER exists. The Sol apply creates that
 *   marker in the same transaction as its writes; nothing writes it yet. Its replay, record and listing row then name
 *   the -fast handle wherever they named the moved one.
 *
 * Until then the stored bytes are served unchanged. Once a correction reads applied, a recording that cannot be
 * corrected (undecodable, a message that does not re-encode to its stored bytes, too large) and a failed correction
 * read answer CorrectedRecordingUnavailable, served as a 503: never the stored bytes, never the old handle or result.
 * The recorded rating figures are kept as recorded. Every other recording passes straight through, with no store read.
 */

type Correction = { readonly kind: "never-joined" } | { readonly kind: "sol"; readonly from: string; readonly to: string };
const CORRECTIONS: ReadonlyMap<string, Correction> = new Map<string, Correction>([
  [NEVER_JOINED.replayId, { kind: "never-joined" }],
  ...SOL_MOVES.map(move => [move.replayId, { kind: "sol", from: move.from, to: move.to }] as const),
]);
/** The recordings this view may change: served with a short cache, so a copy cannot outlive a correction. */
export const CORRECTED_REPLAY_IDS: ReadonlySet<string> = new Set(CORRECTIONS.keys());

export class CorrectedRecordingUnavailable extends Error {
  constructor(reason: string) { super(`corrected recording unavailable: ${reason}`); this.name = "CorrectedRecordingUnavailable"; }
}

/** The most bytes of one recording object this view buffers to correct it. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Whether a correction reads applied. Read for each request until it does; an applied correction is never undone (both
 * records are written once), so that answer is kept. A failed read is CorrectedRecordingUnavailable.
 */
function appliedReader(store: Pick<Store, "get">): (correction: Correction) => Promise<boolean> {
  const applied = new Set<Correction["kind"]>();
  return async correction => {
    if (applied.has(correction.kind)) return true;
    let yes: boolean;
    try {
      if (correction.kind === "sol") yes = await store.get(CORRECTION_MARKER) !== null;
      else {
        const record = await store.get(`ratingCorrections/${NEVER_JOINED.lobbyId}`);
        yes = record?.kind === CORRECTION_KIND && record.lobbyId === NEVER_JOINED.lobbyId && record.replayId === NEVER_JOINED.replayId;
      }
    } catch { throw new CorrectedRecordingUnavailable("correction state unreadable"); }
    if (yes) applied.add(correction.kind);
    return yes;
  };
}

/** A seat named `from`, alone or as "from #n", renamed to `to` with its seat suffix kept. */
function moveIdentity(identity: StreamIdentity | undefined, from: string, to: string): StreamIdentity | undefined {
  return identity !== undefined && seatHandle(identity) === from ? { ...identity, displayName: `${to}${identity.displayName.slice(from.length)}` } : identity;
}
function moveMessage(message: StreamMessage, from: string, to: string): StreamMessage | null {
  let changed = false;
  const move = (identity: StreamIdentity | undefined) => {
    const next = moveIdentity(identity, from, to);
    if (next !== identity) changed = true;
    return next;
  };
  const full = message.full === null ? null : { ...message.full, agents: message.full.agents.map(agent => {
    const identity = move(agent.identity);
    return identity === agent.identity ? agent : { ...agent, identity };
  }) };
  const events = message.events.map(event => {
    if (event.kind !== "join") return event;
    const identity = move(event.identity);
    return identity === event.identity ? event : { ...event, identity };
  });
  return changed ? { ...message, full, events } : null;
}

/** The moved handle wherever it stands whole: not where it merely begins a longer handle (the -fast one does). */
const handlePattern = (from: string) => new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");

function correctBinary(correction: Correction, binary: Uint8Array): Uint8Array {
  try {
    const out = correction.kind === "never-joined" ? abandonBinary(binary)
      : rewriteMessages(binary, message => moveMessage(message, correction.from, correction.to));
    return out.body ?? binary;
  } catch { throw new CorrectedRecordingUnavailable("replay not correctable"); }
}

function correctRecord(id: string, correction: Correction, body: Uint8Array): Uint8Array {
  try {
    const record = parseRecord(id, body);
    if (correction.kind === "never-joined") return isAbandonedRecord(record) ? body : serializeRecord(abandonRecord(record));
    // The handle has no quote or escape, so it is replaced in the JSON text wherever it stands whole.
    const text = new TextDecoder().decode(serializeRecord(record)).replace(handlePattern(correction.from), correction.to);
    const moved = parseRecord(id, new TextEncoder().encode(text));
    if (handlePattern(correction.from).test(JSON.stringify(moved))) throw new Error("moved handle still present");
    return serializeRecord(moved);
  } catch { throw new CorrectedRecordingUnavailable("record not correctable"); }
}

function correctSummary(correction: Correction, row: HistorySummary): HistorySummary {
  if (correction.kind === "never-joined") return { ...row, winner: null, reason: "abandoned", decidedBy: "draw", rated: false };
  return { ...row, seats: row.seats.map(seat => seat.handle === correction.from ? { ...seat, handle: correction.to } : seat) };
}

async function readAll(body: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > MAX_BYTES) throw new CorrectedRecordingUnavailable("recording too large to correct");
      chunks.push(bytes);
    }
  } finally { body.destroy(); }
  return new Uint8Array(Buffer.concat(chunks));
}

const served = (bytes: Uint8Array): ReplayRead => ({ body: Readable.from([Buffer.from(bytes)]), contentLength: String(bytes.length) });

/** /replays/<id> and /watch/replays: each corrected recording's binary, corrected once its correction reads applied. */
export function correctedReplaySource(source: ReplaySource, store: Pick<Store, "get">): ReplaySource {
  const applied = appliedReader(store);
  return {
    async open(id, signal) {
      const correction = CORRECTIONS.get(id);
      if (correction === undefined || !await applied(correction)) return source.open(id, signal);
      const object = await source.open(id, signal);
      if (object === null) return null;
      return served(correctBinary(correction, await readAll(object.body)));
    },
  };
}

/** /matches and /matches/<id>: each corrected recording's listing row and record, once its correction reads applied. */
export function correctedHistorySource(source: HistorySource, store: Pick<Store, "get">): HistorySource {
  const applied = appliedReader(store);
  return {
    async list(pageToken, signal) {
      const page = await source.list(pageToken, signal);
      const matches = await Promise.all(page.matches.map(async row => {
        const correction = CORRECTIONS.get(row.id);
        return correction !== undefined && await applied(correction) ? correctSummary(correction, row) : row;
      }));
      return { ...page, matches };
    },
    async open(id, signal) {
      const correction = CORRECTIONS.get(id);
      if (correction === undefined || !await applied(correction)) return source.open(id, signal);
      const body = await source.open(id, signal);
      if (body === null) return null;
      return Readable.from([Buffer.from(correctRecord(id, correction, await readAll(body)))]);
    },
  };
}
