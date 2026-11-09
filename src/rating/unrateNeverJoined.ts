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
 * One-off correction (ANT-016, decision 938e3cc9): a rated ranked lobby in which a colony never joined the match is
 * recorded abandoned and unrated, its rating effect removed, and its public recording shown abandoned and unrated.
 *
 * verify reads everything and writes nothing. correct runs verify and, only when every check passed in that same run and
 * apply is set, writes: the recording first (each object replaced only at the generation verify read), then one
 * Firestore transaction that re-reads every document verify read and writes only if each is unchanged. It is limited to
 * the case where nothing later depends on the match: each player's only rated result in any ranked mode is this one, so
 * deleting their rating rows returns them to unrated (src/rating/ratings.ts: an unrated identity has no row).
 * A part already corrected is skipped, so a run interrupted after the recording can be run again.
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
  readonly recording: { readonly binary: StoredObject; readonly record: StoredObject; readonly parsed: MatchRecord } | null;
  readonly recordingCorrected: boolean;
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
  const first = await readSnapshot(deps.store, [lobbyPath(lobbyId), markerPath(lobbyId), watchPath(lobbyId)]);
  const lobby = first.get(lobbyPath(lobbyId)) ?? null;
  const seats = lobbySeats(lobby?.seats);
  const mode = (lobby?.mode || "1v1") as RankedMode;
  const winner = NATURAL_OUTCOMES[lobby?.outcome ?? ""];
  const identities = seats === null ? [] : [...new Set(seats.map(seat => seat.id))];
  const done: Omit<Verification, "ok" | "checks" | "snapshot"> = {
    lobbyId, replayId: null, identities, neverJoined: [], mode: isRankedMode(mode) ? mode : null, recording: null, recordingCorrected: false,
  };
  const fail = (snapshot: ReadonlyMap<string, Fields | null>, extra: Partial<Verification> = {}): Verification =>
    ({ ...done, ...extra, ok: false, checks, snapshot });

  // (1) The lobby: ended, rated, ranked, a natural (rated) outcome, readable seats of two colonies.
  if (!check("lobby", lobby !== null && lobby.state === "ended" && lobby.rated === "true" && isRankedMode(mode) && winner !== undefined
    && seats !== null && seats.some(seat => seat.colony === 0) && seats.some(seat => seat.colony === 1),
  lobby === null ? "lobby document missing"
    : `state ${lobby.state}, rated ${lobby.rated}, mode ${mode}, outcome ${lobby.outcome}, seats ${seats === null ? "unreadable" : JSON.stringify(seats.map(({ id, colony }) => ({ id, colony })))}`)) {
    return fail(first);
  }

  // (2) The rating change record names exactly the lobby's identities.
  const changes = parseChanges(first.get(markerPath(lobbyId)) ?? null);
  check("rating change record", changes !== null && changes.length === identities.length
    && isDeepStrictEqual(new Set(changes.map(change => change.identityId)), new Set(identities)),
  changes === null ? "ratedMatches record missing or unreadable" : `identities ${changes.map(change => change.identityId).join(", ")}`);

  // (4) Each player's only rated result, in any ranked mode, is this lobby's, and its row is as the match left it.
  const rowPaths = identities.flatMap(id => RANKED_MODES.map(each => `${ratingCollection(each)}/${id}`));
  const rows = await readSnapshot(deps.store, rowPaths);
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

  // (3) The recording linked to the lobby (the expected one, saved by the run that played the lobby's match), and that
  // colony 0 never joined it.
  const watch = first.get(watchPath(lobbyId)) ?? null;
  const replayId = watch?.replayId ?? null;
  const snapshot = new Map([...first, ...rows]);
  if (!check("watch entry", watch !== null && replayId === expectedReplayId && watch.rated === "true"
    && !!lobby!.matchRunId && watch.runId === lobby!.matchRunId,
  watch === null ? "watchMatches entry missing"
    : `replayId ${replayId ?? "none"} (expected ${expectedReplayId}), rated ${watch.rated}, runId ${watch.runId ?? "none"} (lobby matchRunId ${lobby!.matchRunId || "none"})`)) {
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
  // Colony 0 itself never joined, and colony 1 did (ANT-016 criterion 1).
  check("never joined", absent.length === 1 && absent[0] === 0,
    `colonies with no seat and no join: ${absent.length === 0 ? "none" : absent.join(", ")}${neverJoined.length ? ` (${neverJoined.join(", ")})` : ""}`);
  const recordingCorrected = isAbandonedRecord(parsed!);
  let rewrite = "already abandoned and unrated";
  if (!recordingCorrected) {
    try {
      const planned = abandonBinary(binary!.body);
      rewrite = `${planned.rewritten} of ${planned.messages} replay messages to rewrite; every message re-encodes to its stored bytes`;
      if (planned.body !== null) assertConsistent(replayId!, planned.body, abandonRecord(parsed!));
    } catch (error) {
      check("recording rewrite", false, error instanceof Error ? error.message : String(error));
      return fail(snapshot, { replayId, neverJoined });
    }
  }
  check("recording rewrite", true, rewrite);
  return { ...done, ok: checks.every(each => each.ok), checks, snapshot, replayId, neverJoined,
    recording: { binary: binary!, record: stored!, parsed: parsed! }, recordingCorrected };
}

function firestoreWrites(v: Verification): Write[] {
  const writes: Write[] = [
    { op: "update", path: lobbyPath(v.lobbyId), fields: { outcome: "abandoned", rated: "false" } },
    { op: "update", path: watchPath(v.lobbyId), fields: { rated: "false" } },
    ...v.identities.map((id): Write => ({ op: "delete", path: `${ratingCollection(v.mode!)}/${id}` })),
    { op: "delete", path: markerPath(v.lobbyId) },
  ];
  return writes;
}

const describe = (write: Write) => write.op === "delete" ? `delete ${write.path}` : `${write.op} ${write.path} ${JSON.stringify(write.fields)}`;

/**
 * verify, then (apply only, and only if verify passed in this run) the writes. Read-only unless apply is true.
 * The recording is replaced first, then the Firestore transaction writes only while every verified document is
 * unchanged. When that transaction refuses or fails, the recording objects this run replaced are put back (each only
 * at the generation this run wrote) and the run throws, so a failed check leaves the recording as it was.
 */
export async function correct(deps: CorrectionDeps, lobbyId: string, options: { readonly apply: boolean; readonly replayId: string }): Promise<Correction> {
  const verification = await verify(deps, lobbyId, options.replayId);
  if (!verification.ok) return { verification, applied: false, writes: [] };
  const recording = verification.recording!;
  const replayId = verification.replayId!;
  const planned: string[] = [];
  let newBinary: Uint8Array | null = null;
  let newRecord: Uint8Array | null = null;
  if (!verification.recordingCorrected) {
    newBinary = abandonBinary(recording.binary.body).body;
    newRecord = serializeRecord(abandonRecord(recording.parsed));
    if (newBinary !== null) planned.push(`replace ${binaryName(replayId)} at generation ${recording.binary.generation}`);
    planned.push(`replace ${recordName(replayId)} at generation ${recording.record.generation}`);
  }
  const writes = firestoreWrites(verification);
  planned.push(...writes.map(describe));
  if (!options.apply) return { verification, applied: false, writes: planned };

  // Each replaced object with its original content and the generation this run wrote, to put back on refusal.
  const replaced: { name: string; original: StoredObject; generation: string }[] = [];
  const restore = async (cause: unknown): Promise<never> => {
    const failures: string[] = [];
    for (const { name, original, generation } of replaced.reverse()) {
      try {
        await deps.recordings.replace(name, { body: original.body, contentType: original.contentType,
          ...(original.contentEncoding ? { contentEncoding: original.contentEncoding } : {}) }, generation);
      } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (failures.length > 0) {
      throw new Error(`${reason}; nothing written to Firestore; the recording could NOT be restored (${failures.join("; ")}). ` +
        "Rerun read-only: it reports the recording as already corrected and the lobby as still rated.");
    }
    throw new Error(`${reason}; nothing written to Firestore; the recording was restored${replaced.length ? "" : " (it was not changed)"}`);
  };
  try {
    if (newBinary !== null) {
      replaced.push({ name: binaryName(replayId), original: recording.binary, generation: await deps.recordings.replace(binaryName(replayId),
        { body: newBinary, contentType: recording.binary.contentType,
          ...(recording.binary.contentEncoding ? { contentEncoding: recording.binary.contentEncoding } : {}) }, recording.binary.generation) });
    }
    if (newRecord !== null) {
      replaced.push({ name: recordName(replayId), original: recording.record, generation: await deps.recordings.replace(recordName(replayId),
        { body: newRecord, contentType: recording.record.contentType }, recording.record.generation) });
    }
    const committed = await deps.store.transaction(async read => {
      const paths = [...verification.snapshot.keys()];
      const now = await read(paths);
      const unchanged = paths.every(path => isDeepStrictEqual(now.get(path) ?? null, verification.snapshot.get(path) ?? null));
      return unchanged ? { result: true, writes } : { result: false, writes: [] };
    });
    if (!committed) throw new Error("Firestore documents changed since verification");
  } catch (error) {
    return restore(error);
  }
  return { verification, applied: true, writes: planned };
}
