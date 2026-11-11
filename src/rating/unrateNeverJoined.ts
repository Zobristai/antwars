import { isDeepStrictEqual } from "node:util";
import type { Fields, Store, Write } from "../store/firestore.js";
import {
  decodeRating, isRankedMode, isValidId, letterFor, lobbySeats, NATURAL_OUTCOMES, RANKED_MODES, ratingCollection, storedRecord, storedState,
  type RankedMode,
} from "./ratings.js";
import {
  abandonBinary, abandonRecord, assertConsistent, binaryName, isAbandonedRecord, parseRecord, recordName, serializeRecord,
  unjoinedColonies, type RecordingObjects, type StoredObject,
} from "../replays/abandonRecording.js";
import type { MatchRecord } from "../replays/history.js";
import { isReplayId } from "../replays/access.js";

/**
 * One-off correction: a rated ranked lobby in which colony 0 never joined the match is
 * recorded abandoned and unrated, its rating effect removed, and its public recording shown abandoned and unrated.
 *
 * verify reads everything and writes nothing. correct runs verify and writes only when every check passed in that same
 * run and apply is set. Firestore is corrected first, in one transaction that re-reads every document verify read and
 * the generation of both recording objects, and writes only while each is unchanged: a refused or failed check therefore
 * leaves Firestore and the recording untouched. The same transaction creates a correction marker
 * (ratingCorrections/<lobbyId>) recording what was verified. Only once Firestore is corrected is the recording rewritten,
 * each object independently and only at the generation verify read. Every run reads the authoritative state afresh: a
 * lobby counts as already corrected only when this tool's marker names it, its replay and run, and its players, and
 * then only while neither player has any rating row in any ranked mode; it then checks each recording object on its own
 * and rewrites only one still rated.
 *
 * Remaining window: Cloud Storage cannot join the Firestore transaction. A recording object replaced after the
 * transaction re-read its generation and before the commit lands is not detected until its upload is refused, by
 * which time Firestore is corrected. The correction is limited to the case where nothing later depends on the match: each player's only
 * rated result in any ranked mode is this one, so deleting their rating rows returns them to unrated
 * (src/rating/ratings.ts: an unrated identity has no row).
 */

export interface Check { readonly name: string; readonly ok: boolean; readonly detail: string }

export interface CorrectionDeps {
  readonly store: Store;
  /** The replay bucket: <replayId>.bin and <replayId>.json. */
  readonly recordings: RecordingObjects;
}

export interface Verification {
  readonly ok: boolean;
  readonly lobbyId: string;
  readonly checks: readonly Check[];
  /** Every Firestore document read, as read; the transaction writes only while each is unchanged. */
  readonly snapshot: ReadonlyMap<string, Fields | null>;
  readonly replayId: string | null;
  readonly identities: readonly string[];
  readonly neverJoined: readonly string[];
  readonly mode: RankedMode | null;
  /**
   * Firestore as read: "rated" (the correction not yet committed) or "corrected" (lobby abandoned and unrated, watch entry
   * unrated, rating change record gone: an earlier run committed it).
   */
  readonly stage: "rated" | "corrected" | null;
  /** Each recording object as read with its rewrite: null when that object already carries the abandoned shape. */
  readonly recording: {
    readonly binary: StoredObject; readonly record: StoredObject; readonly parsed: MatchRecord;
    readonly newBinary: Uint8Array | null; readonly newRecord: Uint8Array | null;
  } | null;
}

export interface Correction {
  readonly verification: Verification;
  readonly applied: boolean;
  /** Each planned write, as performed (apply) or as it would be (read-only). */
  readonly writes: readonly string[];
}

const lobbyPath = (id: string) => `lobbies/${id}`;
const markerPath = (id: string) => `ratedMatches/${id}`;
const watchPath = (id: string) => `watchMatches/${id}`;
const correctionPath = (id: string) => `ratingCorrections/${id}`;
export const CORRECTION_KIND = "unrate-never-joined";

interface StoredChange { identityId: string; after: number; rdAfter?: number }

function parseChanges(fields: Fields | null): StoredChange[] | null {
  if (!fields?.changes) return null;
  let value: unknown;
  try { value = JSON.parse(fields.changes); } catch { return null; }
  if (!Array.isArray(value)) return null;
  const changes: StoredChange[] = [];
  for (const row of value as Record<string, unknown>[]) {
    if (typeof row !== "object" || row === null || !isValidId(row.identityId) || typeof row.after !== "number") return null;
    changes.push({ identityId: row.identityId, after: row.after, ...(typeof row.rdAfter === "number" ? { rdAfter: row.rdAfter } : {}) });
  }
  return changes;
}

async function readSnapshot(store: Store, paths: readonly string[]): Promise<ReadonlyMap<string, Fields | null>> {
  // A transaction with no writes is rolled back: one consistent read of every path.
  return store.transaction(async read => ({ result: await read(paths), writes: [] }));
}

/**
 * Read-only. ok only when every check passed; nothing is ever written. expectedReplayId pins the recording: the lobby's
 * watch entry must name it and belong to the run that played the lobby's match.
 */
export async function verify(deps: CorrectionDeps, lobbyId: string, expectedReplayId: string): Promise<Verification> {
  if (!isValidId(lobbyId)) throw new Error("invalid lobby id");
  if (!isReplayId(expectedReplayId)) throw new Error("invalid replay id");
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };
  const first = await readSnapshot(deps.store, [lobbyPath(lobbyId), markerPath(lobbyId), watchPath(lobbyId), correctionPath(lobbyId)]);
  const lobby = first.get(lobbyPath(lobbyId)) ?? null;
  const seats = lobbySeats(lobby?.seats);
  const mode = (lobby?.mode || "1v1") as RankedMode;
  const winner = NATURAL_OUTCOMES[lobby?.outcome ?? ""];
  const identities = seats === null ? [] : [...new Set(seats.map(seat => seat.id))];
  const stage = lobby?.rated === "true" && winner !== undefined ? "rated"
    : lobby?.rated === "false" && lobby.outcome === "abandoned" ? "corrected" : null;
  const done: Omit<Verification, "ok" | "checks" | "snapshot"> = {
    lobbyId, replayId: null, identities, neverJoined: [], mode: isRankedMode(mode) ? mode : null, stage, recording: null,
  };
  const fail = (snapshot: ReadonlyMap<string, Fields | null>, extra: Partial<Verification> = {}): Verification =>
    ({ ...done, ...extra, ok: false, checks, snapshot });

  // (1) The lobby: ended, ranked, readable seats of two colonies; rated with a natural (rated) outcome, or already
  // corrected (abandoned and unrated).
  if (!check("lobby", lobby !== null && lobby.state === "ended" && stage !== null && isRankedMode(mode)
    && seats !== null && seats.some(seat => seat.colony === 0) && seats.some(seat => seat.colony === 1),
  lobby === null ? "lobby document missing"
    : `state ${lobby.state}, rated ${lobby.rated}, mode ${mode}, outcome ${lobby.outcome}, seats ${seats === null ? "unreadable" : JSON.stringify(seats.map(({ id, colony }) => ({ id, colony })))}${stage === "corrected" ? " (Firestore correction already committed)" : ""}`)) {
    return fail(first);
  }

  const marker = first.get(correctionPath(lobbyId)) ?? null;
  const rowPaths = identities.flatMap(id => RANKED_MODES.map(each => `${ratingCollection(each)}/${id}`));
  const rows = await readSnapshot(deps.store, rowPaths);
  const snapshot: ReadonlyMap<string, Fields | null> = new Map([...first, ...rows]);
  if (stage === "rated") {
    check("correction marker", marker === null, marker === null ? "none (not yet corrected)" : "present although the lobby is still rated");
    // (2) The rating change record names exactly the lobby's identities.
    const changes = parseChanges(first.get(markerPath(lobbyId)) ?? null);
    check("rating change record", changes !== null && changes.length === identities.length
      && isDeepStrictEqual(new Set(changes.map(change => change.identityId)), new Set(identities)),
    changes === null ? "ratedMatches record missing or unreadable" : `identities ${changes.map(change => change.identityId).join(", ")}`);

    // (4) Each player's only rated result, in any ranked mode, is this lobby's, and its row is as the match left it.
    for (const id of identities) {
      const side = seats!.find(seat => seat.id === id)!.colony;
      const row = rows.get(`${ratingCollection(mode)}/${id}`) ?? null;
      const others = RANKED_MODES.filter(each => each !== mode && rows.get(`${ratingCollection(each)}/${id}`));
      let detail = "no rating row";
      let ok = false;
      if (row) {
        try {
          const state = storedState(id, row);
          const record = storedRecord(id, row);
          const change = changes?.find(each => each.identityId === id);
          const form = record?.form.map(({ result, matchId }) => `${result}:${matchId}`).join(" ") ?? "(no record)";
          detail = `ratedMatches ${state.ratedMatches}, form ${form}, rating ${state.rating}, rd ${state.rd}`;
          ok = state.ratedMatches === 1 && record !== null && record.form.length === 1 && record.form[0]!.matchId === lobbyId
            && record.form[0]!.result === letterFor(winner!, side)
            && change !== undefined && decodeRating(row.rating!) === change.after && (change.rdAfter === undefined || state.rd === change.rdAfter);
        } catch (error) { detail = `unreadable row: ${error instanceof Error ? error.message : String(error)}`; }
      }
      if (others.length > 0) { ok = false; detail += `; also rated in ${others.join(", ")}`; }
      check(`only rated match: ${id}`, ok, detail);
    }
  } else {
    // Corrected by this tool only when its marker names this lobby's replay, run, mode and players.
    let named: unknown = null;
    try { named = JSON.parse(marker?.identities ?? "null"); } catch { named = null; }
    check("correction marker", marker !== null && marker.kind === CORRECTION_KIND && marker.replayId === expectedReplayId
      && !!lobby!.matchRunId && marker.runId === lobby!.matchRunId && marker.mode === mode
      && Array.isArray(named) && isDeepStrictEqual(new Set(named), new Set(identities)) && named.length === identities.length,
    marker === null ? "none: this lobby was not corrected by this tool"
      : `kind ${marker.kind}, replayId ${marker.replayId}, runId ${marker.runId}, mode ${marker.mode}, identities ${marker.identities}, at ${marker.at}`);
    check("rating change record", first.get(markerPath(lobbyId)) === null, first.get(markerPath(lobbyId)) === null
      ? "removed by the committed correction" : "ratedMatches record still present although the lobby is unrated");
    // (4) Still no other rated match: the committed correction deleted this match's rows, so any row is a later match.
    for (const id of identities) {
      const rated = RANKED_MODES.filter(each => rows.get(`${ratingCollection(each)}/${id}`));
      check(`only rated match: ${id}`, rated.length === 0, rated.length === 0 ? "no rating row in any ranked mode"
        : `rated in ${rated.join(", ")} since the correction`);
    }
  }

  // (3) The recording linked to the lobby (the expected one, saved by the run that played the lobby's match), and that
  // colony 0 never joined it.
  const watch = first.get(watchPath(lobbyId)) ?? null;
  const replayId = watch?.replayId ?? null;
  const watchRated = stage === "rated" ? "true" : "false";
  if (!check("watch entry", watch !== null && replayId === expectedReplayId && watch.rated === watchRated
    && !!lobby!.matchRunId && watch.runId === lobby!.matchRunId,
  watch === null ? "watchMatches entry missing"
    : `replayId ${replayId ?? "none"} (expected ${expectedReplayId}), rated ${watch.rated} (expected ${watchRated}), runId ${watch.runId ?? "none"} (lobby matchRunId ${lobby!.matchRunId || "none"})`)) {
    return fail(snapshot);
  }
  const [binary, stored] = await Promise.all([deps.recordings.read(binaryName(replayId!)), deps.recordings.read(recordName(replayId!))]);
  let parsed: MatchRecord | null = null;
  try { parsed = stored === null ? null : parseRecord(replayId!, stored.body); } catch { parsed = null; }
  if (!check("match record", binary !== null && parsed !== null && parsed.status !== "unavailable",
    `${binaryName(replayId!)} ${binary === null ? "missing" : "present"}, ${recordName(replayId!)} ${stored === null ? "missing" : parsed === null ? "unreadable" : `status ${parsed.status}`}`)) {
    return fail(snapshot, { replayId });
  }
  const absent = unjoinedColonies(parsed!, [0, 1]);
  const neverJoined = [...new Set(seats!.filter(seat => absent.includes(seat.colony)).map(seat => seat.id))];
  // Colony 0 itself never joined, and colony 1 did.
  check("never joined", absent.length === 1 && absent[0] === 0,
    `colonies with no seat and no join: ${absent.length === 0 ? "none" : absent.join(", ")}${neverJoined.length ? ` (${neverJoined.join(", ")})` : ""}`);

  // Each recording object on its own: the binary is decoded and checked whatever the record says, and the reverse.
  let newBinary: Uint8Array | null = null;
  let newRecord: Uint8Array | null = null;
  try {
    const planned = abandonBinary(binary!.body);
    newBinary = planned.body;
    const target = abandonRecord(parsed!);
    newRecord = isAbandonedRecord(parsed!) ? null : serializeRecord(target);
    assertConsistent(replayId!, newBinary ?? binary!.body, target);
    check("recording rewrite", true, [
      newBinary === null ? `${binaryName(replayId!)} already abandoned and unrated`
        : `${binaryName(replayId!)}: ${planned.rewritten} of ${planned.messages} replay messages to rewrite; every message re-encodes to its stored bytes`,
      newRecord === null ? `${recordName(replayId!)} already abandoned and unrated` : `${recordName(replayId!)} to rewrite`,
    ].join("; "));
  } catch (error) {
    check("recording rewrite", false, error instanceof Error ? error.message : String(error));
    return fail(snapshot, { replayId, neverJoined });
  }
  return { ...done, ok: checks.every(each => each.ok), checks, snapshot, replayId, neverJoined,
    recording: { binary: binary!, record: stored!, parsed: parsed!, newBinary, newRecord } };
}

export function firestoreWrites(v: Verification, at: Date): Write[] {
  const lobby = v.snapshot.get(lobbyPath(v.lobbyId))!;
  return [
    { op: "create", path: correctionPath(v.lobbyId), fields: { kind: CORRECTION_KIND, lobbyId: v.lobbyId, replayId: v.replayId!,
      runId: lobby.matchRunId!, mode: v.mode!, identities: JSON.stringify(v.identities), neverJoined: JSON.stringify(v.neverJoined),
      binaryGeneration: v.recording!.binary.generation, recordGeneration: v.recording!.record.generation, at: at.toISOString() } },
    { op: "update", path: lobbyPath(v.lobbyId), fields: { outcome: "abandoned", rated: "false" } },
    { op: "update", path: watchPath(v.lobbyId), fields: { rated: "false" } },
    ...v.identities.map((id): Write => ({ op: "delete", path: `${ratingCollection(v.mode!)}/${id}` })),
    { op: "delete", path: markerPath(v.lobbyId) },
  ];
}

export const describe = (write: Write) => write.op === "delete" ? `delete ${write.path}` : `${write.op} ${write.path} ${JSON.stringify(write.fields)}`;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * verify, then (apply only, and only if verify passed in this run) the writes; read-only unless apply is true.
 * Firestore first: one transaction writes only while every verified document is unchanged. A refused transaction
 * writes nothing anywhere. A transaction that throws may or may not have committed: the recording is left untouched and
 * the run stops, and the next run reads which it was. Then each recording object still rated is replaced at the
 * generation verify read; an upload whose outcome is unknown stops the run, and the next run re-reads both objects and
 * rewrites only what is still rated. applied is true when this run wrote anything.
 */
export async function correct(deps: CorrectionDeps, lobbyId: string, options: { readonly apply: boolean; readonly replayId: string }): Promise<Correction> {
  const verification = await verify(deps, lobbyId, options.replayId);
  if (!verification.ok) return { verification, applied: false, writes: [] };
  const recording = verification.recording!;
  const replayId = verification.replayId!;
  const writes = verification.stage === "rated" ? firestoreWrites(verification, new Date()) : [];
  const objects = [
    ...(recording.newBinary === null ? [] : [{ name: binaryName(replayId), from: recording.binary,
      object: { body: recording.newBinary, contentType: recording.binary.contentType,
        ...(recording.binary.contentEncoding ? { contentEncoding: recording.binary.contentEncoding } : {}) } }]),
    ...(recording.newRecord === null ? [] : [{ name: recordName(replayId), from: recording.record,
      // Written as the record service stores a record: plain JSON (serializeRecord), so no content encoding.
      object: { body: recording.newRecord, contentType: recording.record.contentType } }]),
  ];
  const planned = [...writes.map(describe), ...objects.map(({ name, from }) => `replace ${name} at generation ${from.generation}`)];
  if (!options.apply || planned.length === 0) return { verification, applied: false, writes: planned };

  if (writes.length > 0) {
    let outcome: "committed" | "documents" | "recording";
    try {
      outcome = await deps.store.transaction(async read => {
        const paths = [...verification.snapshot.keys()];
        const now = await read(paths);
        if (!paths.every(path => isDeepStrictEqual(now.get(path) ?? null, verification.snapshot.get(path) ?? null))) {
          return { result: "documents" as const, writes: [] };
        }
        // The recording as verified, read again just before the commit (Cloud Storage cannot join the transaction).
        const [binary, record] = await Promise.all([deps.recordings.generation(binaryName(replayId)), deps.recordings.generation(recordName(replayId))]);
        if (binary !== recording.binary.generation || record !== recording.record.generation) return { result: "recording" as const, writes: [] };
        return { result: "committed" as const, writes };
      });
    } catch (error) {
      throw new Error(`Firestore commit outcome unknown (${message(error)}); the recording was not touched. ` +
        "Rerun read-only: it reads whether the correction committed, and --apply then completes whichever state it finds.");
    }
    if (outcome === "documents") throw new Error("Firestore documents changed since verification; nothing written to Firestore or the recording");
    if (outcome === "recording") throw new Error("recording changed since verification; nothing written to Firestore or the recording");
  }
  const done = [...writes.map(describe)];
  for (const { name, from, object } of objects) {
    try {
      await deps.recordings.replace(name, object, from.generation);
    } catch (error) {
      throw new Error(`${done.length ? `written: ${done.join("; ")}. ` : ""}${name} not confirmed replaced (${message(error)}). ` +
        "Rerun with --apply: it re-reads both recording objects and rewrites only one still rated.");
    }
    done.push(`replace ${name} at generation ${from.generation}`);
  }
  return { verification, applied: true, writes: planned };
}
