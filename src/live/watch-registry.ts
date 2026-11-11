import type { Fields, Store, Write } from "../store/firestore.js";
import type { RankedMode } from "../rating/ratings.js";
import type { CatalogMatch } from "./match-catalog.js";
import { captureMatchAccess, type MatchAccess } from "./match-access.js";
import { isReplayId } from "../replays/access.js";

/** Original serving process stays attached to this match even when its slot is reused. */
export interface WatchMatch extends CatalogMatch {
  readonly origin: string;
  readonly slot: string;
  readonly runId: string;
  readonly replayId?: string;
  /**
   * Each seat's self-reported model label by its stream display name, as its slot published it once the seat joined;
   * absent where none was published (an older server or row, or no seat has joined yet).
   */
  readonly modelLabels?: Readonly<Record<string, string>>;
  /** Each seat's self-reported thinking level and service tier, by the same names and published with its model label;
   * absent where none was published. A seat that reported none is left out. */
  readonly thinkingLevels?: Readonly<Record<string, string>>;
  readonly serviceTiers?: Readonly<Record<string, string>>;
}
/** A seat's self-reported level and tier by its stream display name, as seatLabels publishes them beside its model label. */
export interface SeatDetails {
  readonly thinkingLevels: Readonly<Record<string, string>>;
  readonly serviceTiers: Readonly<Record<string, string>>;
}
export interface WatchRegistry {
  register(match: Omit<WatchMatch, "playbackFinished" | "replayId">): Promise<void>;
  /**
   * A handed-over match now served by another process: the same match, so its visibility, rated, mode,
   * startedAt and slot must equal the entry's; only its runId and origin move, in the public listing too. A match
   * whose registration never committed is registered as given. Only the run holding the match's adopted ownership
   * (its lobby's matchRunId, set by adoptMatch) may do so, checked inside this write's own transaction:
   * false, with nothing written, when the lobby's match is not match.runId's, so a run superseded before or after
   * adopting can never move the entry away from its successor.
   */
  resumed(match: Omit<WatchMatch, "playbackFinished" | "replayId">): Promise<boolean>;
  read(lobbyId: string): Promise<WatchMatch | null>;
  /**
   * The public listing's unfinished matches, oldest first, reading at most 10 pages of 100 listing rows per call. Each
   * page's stale listings are swept as it is read, before the read limit can throw, so a backlog clears over
   * calls. A listing is stale when its slot's registered instance is another run and its lobby no longer holds that
   * slot: no handover can resume it, and the catalog, which lists only the slot's current run, never shows it again.
   * Only the listing row is deleted; the match's own row stays readable.
   */
  publicMatches(): Promise<readonly WatchMatch[]>;
  /**
   * The match's delayed playback ended on run runId: it leaves the public listing. Like resumed, only while runId holds
   * the lobby's match, checked in this write's own transaction: false, with nothing written, otherwise.
   */
  playbackFinished(lobbyId: string, runId: string): Promise<boolean>;
  /**
   * Each seated player's self-reported model label, and its thinking level and service tier where details are given, by its
   * stream display name, on the match and its public listing; fenced as playbackFinished is. A seat that reported none is left out.
   */
  seatLabels(lobbyId: string, runId: string, labels: Readonly<Record<string, string>>, details?: SeatDetails): Promise<boolean>;
  /** Run runId saved the match's recording as replayId; fenced as playbackFinished is. */
  replaySaved(lobbyId: string, runId: string, replayId: string): Promise<boolean>;
  /** The lobby whose saved recording has this replay id; null when no registered match has it. */
  findByReplay(replayId: string): Promise<string | null>;
  /**
   * findByReplay with the miss classified: "pending" when a match registered in the recording's start millisecond has
   * no replay id yet (its replaySaved has not published), "none" when no registered match there can be its lobby.
   */
  replayLobby(replayId: string): Promise<ReplayLobby>;
}
export type ReplayLobby = { readonly state: "found"; readonly lobbyId: string } | { readonly state: "pending" } | { readonly state: "none" };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const path = (id: string) => `watchMatches/${id}`;
const listing = (id: string) => `watchPublic/${id}`;
/** The lobby's own document (src/lobby/lobbies.ts): its matchRunId names the run that began or adopted its match. */
const lobby = (id: string) => `lobbies/${id}`;
/** The slot's registered instance (src/lobby/lobbies.ts): its runId names the run serving the slot now; never deleted. */
const instance = (slot: string) => `instances/${slot}`;
function origin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid spectator origin");
  return url.origin;
}
function decode(lobbyId: string, row: Fields): WatchMatch {
  if (!ID.test(lobbyId) || !["public", "private"].includes(row.visibility!) || !["true", "false"].includes(row.rated!) ||
    !["true", "false"].includes(row.playbackFinished!) || !/^(public|private)-\d+$/.test(row.slot ?? "") || !row.runId) throw new Error("Invalid stored spectator match");
  const startedAt = Number(row.startedAt);
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || (row.replayId !== undefined && !isReplayId(row.replayId))) throw new Error("Invalid stored spectator match");
  const access = captureMatchAccess({ lobbyId, visibility: row.visibility as MatchAccess["visibility"], rated: row.rated === "true",
    mode: row.mode === undefined || row.mode === "" ? undefined : row.mode as RankedMode });
  return { ...access, startedAt,
    playbackFinished: row.playbackFinished === "true", origin: origin(row.origin!), slot: row.slot!, runId: row.runId,
    ...(row.replayId === undefined ? {} : { replayId: row.replayId }),
    ...seatMap("modelLabels", row.modelLabels), ...seatMap("thinkingLevels", row.thinkingLevels), ...seatMap("serviceTiers", row.serviceTiers) };
}

/** A stored per-seat field (modelLabels, thinkingLevels, serviceTiers) read back: a JSON object of non-empty strings.
 * Absent or malformed reads as none, so a label never fails the catalog. */
function seatMap<K extends "modelLabels" | "thinkingLevels" | "serviceTiers">(key: K, value: string | undefined):
  { [P in K]: Readonly<Record<string, string>> } | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const labels = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "");
  return { [key]: Object.fromEntries(labels) } as { [P in K]: Readonly<Record<string, string>> };
}

/** A listing no run can finish or resume, which the catalog never shows again: see WatchRegistry.publicMatches. */
function isStale(match: WatchMatch, listed: Fields | null | undefined, held: Fields | null | undefined, serving: Fields | null | undefined): boolean {
  return listed?.runId === match.runId && !!serving?.runId && serving.runId !== match.runId &&
    !(held?.state === "holding" && held.slot === match.slot);
}

export function createWatchRegistry(store: Store): WatchRegistry {
  /** Deletes the candidates' listings that are still stale, rechecked in this write's own transaction; returns their lobby ids. */
  async function sweep(candidates: readonly WatchMatch[]): Promise<ReadonlySet<string>> {
    if (candidates.length === 0) return new Set();
    return store.transaction<ReadonlySet<string>>(async read => {
      const docs = await read([...new Set(candidates.flatMap(match => [listing(match.lobbyId), lobby(match.lobbyId), instance(match.slot)]))]);
      const stale = candidates.filter(match =>
        isStale(match, docs.get(listing(match.lobbyId)), docs.get(lobby(match.lobbyId)), docs.get(instance(match.slot))));
      const writes: Write[] = stale.map(match => ({ op: "delete", path: listing(match.lobbyId) }));
      return { result: new Set(stale.map(match => match.lobbyId)), writes };
    });
  }
  async function update(lobbyId: string, runId: string, fields: Fields, listed: "keep" | "remove" | "update" = "keep"): Promise<boolean> {
    if (!ID.test(lobbyId)) throw new Error("Invalid spectator lobby id");
    return store.transaction<boolean>(async read => {
      const docs = await read([path(lobbyId), listing(lobbyId), lobby(lobbyId)]);
      // The resumed fence (put): a run that does not hold the lobby's match writes nothing.
      if (docs.get(lobby(lobbyId))?.matchRunId !== runId) return { result: false, writes: [] };
      const before = docs.get(path(lobbyId));
      if (!before) throw new Error("Spectator match not registered");
      if (fields.replayId !== undefined && before.replayId !== undefined && fields.replayId !== before.replayId) throw new Error("Spectator recording identity changed");
      const writes: Write[] = [{ op: "update", path: path(lobbyId), fields }];
      if (listed !== "keep" && docs.get(listing(lobbyId))) writes.push(listed === "remove" ? { op: "delete", path: listing(lobbyId) } : { op: "update", path: listing(lobbyId), fields });
      return { result: true, writes };
    });
  }
  async function replayLobby(replayId: string): Promise<ReplayLobby> {
    if (!isReplayId(replayId)) return { state: "none" };
    // A lobby recording's id is "<its stream's startedAt>-<n>" (hub.ts MatchStream), and register
    // stores that same startedAt: read only the matches that began in that millisecond.
    const iso = `${replayId.slice(0, 13)}:${replayId.slice(14, 16)}:${replayId.slice(17, 19)}.${replayId.slice(20, 24)}`;
    const startedAt = Date.parse(iso);
    const value = String(startedAt).padStart(16, "0");
    // Just after every match that began in an earlier millisecond: "~" orders after every lobby id.
    const startAfter = startedAt > 0 ? { value: String(startedAt - 1).padStart(16, "0"), path: path("~") } : undefined;
    // Distinct lobbies starting in one millisecond are few; a page this size covers them.
    const { rows } = await store.query("watchMatches", { orderBy: "startedAt", direction: "ASCENDING", limit: 25, startAfter });
    const sameStart = rows.filter(row => row.fields.startedAt === value);
    const row = sameStart.find(row => row.fields.replayId === replayId);
    if (row) return { state: "found", lobbyId: row.path.slice("watchMatches/".length) };
    return sameStart.some(row => row.fields.replayId === undefined) ? { state: "pending" } : { state: "none" };
  }
  /**
   * A resumed match keeps its identity but may name a new serving process: its runId and origin, written only while
   * that run holds the lobby's match. False when it does not: nothing is written.
   */
  async function put(match: Omit<WatchMatch, "playbackFinished" | "replayId">, resumed: boolean): Promise<boolean> {
    if (!ID.test(match.lobbyId) || !Number.isSafeInteger(match.startedAt) || match.startedAt < 0 ||
      !/^(public|private)-\d+$/.test(match.slot) || !match.runId) throw new Error("Invalid spectator match");
    const access = captureMatchAccess(match);
    const fields = { visibility: access.visibility, rated: String(access.rated), mode: access.mode ?? "", startedAt: String(match.startedAt).padStart(16, "0"),
      origin: origin(match.origin), slot: match.slot, runId: match.runId, playbackFinished: "false" };
    return store.transaction<boolean>(async read => {
      const docs = await read([path(match.lobbyId), listing(match.lobbyId), ...(resumed ? [lobby(match.lobbyId)] : [])]);
      // Read inside this write's transaction, which the store serializes with adoptMatch's: no adoption commits between the check and the write.
      if (resumed && docs.get(lobby(match.lobbyId))?.matchRunId !== match.runId) return { result: false, writes: [] };
      const before = docs.get(path(match.lobbyId));
      if (before) {
        // A missing legacy mode and an empty new mode mean the same policy.
        if ((before.mode ?? "") !== fields.mode) throw new Error("Spectator match identity changed");
        const server = ["origin", "runId"] as const;
        for (const key of ["visibility", "rated", "startedAt", "slot", ...(resumed ? [] : server)] as const) {
          if (before[key] !== fields[key]) throw new Error("Spectator match identity changed");
        }
        if (server.every(key => before[key] === fields[key])) return { result: true, writes: [] };
        const moved = { origin: fields.origin, runId: fields.runId };
        const writes: Write[] = [{ op: "update", path: path(match.lobbyId), fields: moved }];
        if (docs.get(listing(match.lobbyId))) writes.push({ op: "update", path: listing(match.lobbyId), fields: moved });
        return { result: true, writes };
      }
      const writes: Write[] = [{ op: "create", path: path(match.lobbyId), fields }];
      if (access.visibility === "public") writes.push({ op: "create", path: listing(match.lobbyId), fields });
      return { result: true, writes };
    });
  }
  return {
    async register(match) { await put(match, false); },
    resumed: match => put(match, true),
    async read(lobbyId) {
      if (!ID.test(lobbyId)) return null;
      const row = await store.get(path(lobbyId));
      return row === null ? null : decode(lobbyId, row);
    },
    async publicMatches() {
      const matches: WatchMatch[] = [];
      // Each slot's serving run, read once per call to pick sweep candidates; the sweep rechecks it in its transaction.
      const serving = new Map<string, Promise<string | undefined>>();
      const servingRun = (slot: string) => {
        let run = serving.get(slot);
        if (!run) serving.set(slot, run = store.get(instance(slot)).then(fields => fields?.runId || undefined));
        return run;
      };
      let startAfter: { value: string; path: string } | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await store.query("watchPublic", { orderBy: "startedAt", direction: "ASCENDING", limit: 100, startAfter });
        const rows = result.rows.map(row => {
          const match = decode(row.path.slice("watchPublic/".length), row.fields);
          if (match.visibility !== "public") throw new Error("Private match in public spectator index");
          return match;
        });
        const runs = await Promise.all(rows.map(match => servingRun(match.slot)));
        const swept = await sweep(rows.filter((match, index) => runs[index] !== undefined && runs[index] !== match.runId));
        for (const match of rows) if (!match.playbackFinished && !swept.has(match.lobbyId)) matches.push(match);
        if (result.rows.length < 100) return matches;
        const last = result.rows.at(-1)!;
        startAfter = { value: last.fields.startedAt!, path: last.path };
      }
      throw new Error("Spectator catalog exceeds its read limit");
    },
    playbackFinished: (lobbyId, runId) => update(lobbyId, runId, { playbackFinished: "true" }, "remove"),
    seatLabels: (lobbyId, runId, labels, details) => update(lobbyId, runId, { modelLabels: JSON.stringify(labels),
      ...(details === undefined ? {} : { thinkingLevels: JSON.stringify(details.thinkingLevels), serviceTiers: JSON.stringify(details.serviceTiers) }) }, "update"),
    replaySaved(lobbyId, runId, replayId) {
      if (!isReplayId(replayId)) throw new Error("Invalid spectator replay id");
      return update(lobbyId, runId, { replayId });
    },
    async findByReplay(replayId) {
      const found = await replayLobby(replayId);
      return found.state === "found" ? found.lobbyId : null;
    },
    replayLobby,
  };
}
