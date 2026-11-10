import { randomUUID } from "node:crypto";
import { isLaunchable } from "./houseLaunchable.js";
import type { Identities } from "../identity/identities.js";
import { HOUSE_LABELS, HOUSE_USERNAME } from "../rating/house.js";
import type { Fields, Store, TransactionRead, Write } from "../store/firestore.js";
import { queueStatusStep } from "./queue.js";
import { waitWrite } from "./waits.js";

/**
 * House challenges: a builder's agent asks for an unrated public 1v1 game against one handle of the House
 * table (HOUSE_LABELS). Admission creates the lobby with the builder
 * seated in colony 1 and colony 0 held for that handle; lobbies.ts owns the lobby document, the held-seat join and the
 * failed-launch close, and commits these steps on its store.
 *
 * Daily limits (20 shared; 5 per owner) count games on the UTC day of
 * their match time: the lobby's startsAt, else its createdAt.
 * A request holds a place on every UTC day its match could still fall on (heldDays), derived from its lobby, never
 * stored: both the creation day and the day of createdAt + the lobby expiry + the countdown while it can still take a
 * slot, its startsAt day once it has, its creation day when it expired full awaiting one, and none when its held seat
 * was never filled, a failed or unavailable report closed it, its builder left it before start (leave_lobby, which ends
 * it with no startsAt and marks the request builderLeft; challenge_status then reads expired, reason builder_left, even
 * once the lobby document is gone), or its match
 * ended abandoned because the held colony never joined (the lobby's heldAbsent): a house no-show is never charged to
 * the builder.
 * Places only shrink after admission, and admission needs room on every day it adds, so no day ever holds more than 20
 * places, or 5 for one owner. A game is charged when the house owner reports it launched and its held seat is filled,
 * unless the held colony then never joins its match; a charged game's match day always keeps its place, so charged
 * games per day never exceed the places held. The allowance left today is 20 minus today's places; a username's allowance
 * left today, listed only for a caller's key, is 5 minus the places it holds today across its handles. Both count
 * today only, while admission also counts the next day near UTC midnight, so either can read 1 or more while a
 * request is refused.
 *
 * Launch reports: launched is the charge event. failed and unavailable each need a reason and, before the held seat
 * joins, close the open lobby and end the request house_unavailable uncharged. failed also lists the handle unavailable
 * with its reason (challengeAvailability lastLaunch); unavailable says challenges are unavailable right now, a
 * service-wide state: the builder's reason reads CHALLENGES_UNAVAILABLE followed by the owner's reason, and it
 * writes no challengeAvailability document and changes no handle's listing or admission.
 *
 * Documents, under the store's namespace:
 *   challengeRequests/{requestId}   { challengerId, ownerId, handle, lobbyId, createdAt, launchReport ("" | launched |
 *                                     failed | unavailable), reportReason, reportedAt, closedByFailure ("" | "true"),
 *                                     set when a failed or unavailable report closed the lobby, builderLeft ("true"),
 *                                     set when its builder left the lobby before start and so emptied and ended it }
 *   challengeAllowance/{YYYY-MM-DD} { requests }  ids of requests admitted with a place that day, pruned of released ones
 *   challengeOwners/{ownerId}       { requestId }  the owner's latest request: one active challenge per owner
 *   challengeChallengers/{id}       { requestId }  the identity's latest request, for challenge_status without an id
 *   challengeAvailability/{handle}  { marked ("" | "unavailable"), lastLaunch ("" | launched | failed), failureReason },
 *                                     written only by launched and failed reports and set_challenge_availability
 */

export const CHALLENGE_SHARED_DAILY_LIMIT = 20;
/** What a builder reads, ahead of the owner's reason, on a challenge an unavailable report ended. */
export const CHALLENGES_UNAVAILABLE = "challenges are unavailable right now";
export const CHALLENGE_OWNER_DAILY_LIMIT = 5;
/** The colony whose seat a challenge lobby holds for its handle; the builder sits in the other. */
export const HELD_COLONY = 0;
/** HOUSE_LABELS entries that name recordings, not seats, so the opponent list leaves them out:
 * antwars/gpt-6-1-terra is a recorded model key added for Matches recording names. */
const NOT_SEATS: ReadonlySet<string> = new Set(["gpt-6-1-terra"]);
/** Recent lobbies per page of the seated-elsewhere scan. */
export const CHALLENGE_SCAN_PAGE_SIZE = 100;

export type ChallengeState = "waiting_for_house" | "waiting_for_slot" | "playing" | "finished" | "expired" | "house_unavailable";
export type LaunchOutcome = "launched" | "failed" | "unavailable";

export type ChallengeRefusal =
  | "unknown_key" | "opponent_unavailable" | "already_queued" | "seated_elsewhere" | "active_challenge"
  | "owner_daily_limit" | "shared_daily_limit" | "not_house_owner" | "no_such_challenge" | "no_such_opponent"
  | "already_reported" | "house_seated" | "reason_required";
export type ChallengeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ChallengeRefusal; readonly detail?: string };

export interface Opponent {
  /** antwars/<handle>. */
  readonly handle: string;
  readonly displayName: string;
  readonly level: string | null;
  readonly tier: string | null;
  readonly available: boolean;
  /** Why it is unavailable; null when available. */
  readonly reason: string | null;
}

export interface OpponentList {
  readonly opponents: readonly Opponent[];
  readonly allowanceLeft: number;
  /** The next UTC midnight, when the allowances reset. */
  readonly resetsAt: number;
}

/** The opponent list read with a caller's key: also its username's challenges left today, across its handles. */
export interface OpponentListForUsername extends OpponentList {
  readonly usernameAllowanceLeft: number;
}

export interface ChallengeStatus {
  readonly requestId: string;
  readonly lobbyId: string;
  readonly handle: string;
  readonly state: ChallengeState;
  readonly reason?: string;
  /** The house owner's view only. */
  readonly launchReport?: LaunchOutcome | null;
  /** The house owner's view only: the reason sent with the launch report when it is in the accepted format, otherwise null. */
  readonly launchReportReason?: string | null;
}

/** What lobbies.ts supplies: its lobby rules and the lobby writes a challenge needs. */
export interface ChallengeLobbyRules {
  readonly countdownMs: number;
  readonly lobbyTtlMs: number;
  readonly now: () => number;
  readonly scanPageSize: number;
  /** lobbies.ts isExpired: an open or waiting player-created lobby at or after its expiry. */
  isExpired(fields: Fields, at: number): boolean;
  /** The slot documents of both kinds, as slots/{kind}-{n}. */
  readonly slotPaths: readonly string[];
  /** Creates the public challenge lobby (builder seated in the other colony, HELD_COLONY held) and lists it. */
  challengeLobbyWrites(read: TransactionRead, lobby: {
    readonly id: string; readonly requestId: string; readonly handle: string;
    readonly builder: { readonly id: string; readonly displayName: string }; readonly at: number;
  }): Promise<readonly Write[]>;
  /** Ends an open challenge lobby whose house launch failed. */
  closeWrite(lobbyId: string): Write;
}

const requestPath = (id: string) => `challengeRequests/${id}`;
const allowancePath = (day: string) => `challengeAllowance/${day}`;
const ownerPath = (ownerId: string) => `challengeOwners/${ownerId}`;
const challengerPath = (identityId: string) => `challengeChallengers/${identityId}`;
const availabilityPath = (handle: string) => `challengeAvailability/${handle}`;
const lobbyPath = (id: string) => `lobbies/${id}`;
const HOUSE_CLAIM = `usernames/${HOUSE_USERNAME}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The only launch-report reason the owner's status view returns; any other stored reason reads null. */
const LAUNCH_REPORT_REASON = /^pinned harness matched @ [0-9a-f]{40}$/;
const ids = (list: string | undefined) => (list ?? "").split(" ").filter(Boolean);
const seatsOf = (fields: Fields): { id: string; colony: number }[] => JSON.parse(fields.seats ?? "[]") as { id: string; colony: number }[];

const refuse = (reason: ChallengeRefusal, detail?: string) => ({ ok: false, reason, ...(detail === undefined ? {} : { detail }) }) as const;
const ok = <T>(value: T) => ({ ok: true, value }) as const;

/** The UTC day of an instant, YYYY-MM-DD. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

/** A House-table handle from antwars/<handle> or <handle>, case-insensitively; undefined for any other name. */
export function houseHandle(name: string): string | undefined {
  const lower = name.trim().toLowerCase();
  const handle = lower.startsWith(`${HOUSE_USERNAME}/`) ? lower.slice(HOUSE_USERNAME.length + 1) : lower;
  return Object.hasOwn(HOUSE_LABELS, handle) ? handle : undefined;
}

const heldSeatFilled = (lobby: Fields) => seatsOf(lobby).some((seat) => seat.colony === HELD_COLONY);
/** The match ended abandoned because the held (house) colony never joined it. */
const heldColonyAbsent = (lobby: Fields) => lobby.state === "ended" && lobby.outcome === "abandoned" && lobby.heldAbsent === "true";
const isLive = (lobby: Fields, at: number, rules: ChallengeLobbyRules) =>
  (lobby.state === "open" || lobby.state === "waiting" || lobby.state === "holding") && !rules.isExpired(lobby, at);

/** The UTC days a request's match could still fall on, from its lobby at `at` (see the module comment). */
export function heldDays(lobby: Fields | null | undefined, at: number, rules: ChallengeLobbyRules): string[] {
  if (!lobby) return [];
  if (lobby.startsAt) return heldColonyAbsent(lobby) ? [] : [utcDay(Number(lobby.startsAt))];
  const createdAt = Number(lobby.createdAt);
  const expired = rules.isExpired(lobby, at);
  if (lobby.state === "open") return expired ? [] : [...new Set([utcDay(createdAt), utcDay(createdAt + rules.lobbyTtlMs + rules.countdownMs)])];
  if (lobby.state === "waiting") return expired ? [utcDay(createdAt)] : [...new Set([utcDay(createdAt), utcDay(createdAt + rules.lobbyTtlMs + rules.countdownMs)])];
  return [];
}

/** A request's state and reason, derived from it and its lobby at `at`. */
export function stateOf(request: Fields, lobby: Fields | null | undefined, at: number, rules: Pick<ChallengeLobbyRules, "isExpired">): { state: ChallengeState; reason?: string } {
  if (request.closedByFailure === "true") {
    const reason = request.reportReason ?? "";
    return { state: "house_unavailable", reason: request.launchReport === "unavailable" ? `${CHALLENGES_UNAVAILABLE}: ${reason}` : reason };
  }
  // Its builder left before the match started, emptying and ending the lobby: never a finished game. Read from the
  // request, so the reason holds whatever becomes of the lobby document.
  if (request.builderLeft === "true") return { state: "expired", reason: "builder_left" };
  // A challenge lobby is never deleted; a missing one is read as ended without a game.
  if (!lobby) return { state: "expired" };
  if (rules.isExpired(lobby, at)) return { state: "expired", reason: lobby.state === "open" ? "house_did_not_join" : "no_match_slot" };
  if (lobby.state === "open") return { state: "waiting_for_house" };
  if (lobby.state === "waiting" || (lobby.state === "holding" && !lobby.matchRunId)) return { state: "waiting_for_slot" };
  if (lobby.state === "holding") return { state: "playing" };
  return { state: "finished" };
}

/**
 * A handle is challengeable only once it is on the house launch table: off the table it is closed whatever
 * its availability record says. A launch-table handle is open unless marked unavailable or its last launch failed.
 */
function availabilityOf(handle: string, fields: Fields | null | undefined): { available: boolean; reason: string | null } {
  if (!isLaunchable(handle)) return { available: false, reason: "not on the house launch table" };
  if (fields?.marked === "unavailable") return { available: false, reason: "marked unavailable by the house owner" };
  if (fields?.lastLaunch === "failed") return { available: false, reason: fields.failureReason || "last launch failed" };
  return { available: true, reason: null };
}

/** The request ids of a day doc still holding a place on that day, read with their lobbies in the caller's transaction. */
async function placesOn(read: TransactionRead, day: string, at: number, rules: ChallengeLobbyRules) {
  const doc = (await read([allowancePath(day)])).get(allowancePath(day)) ?? null;
  const listed = ids(doc?.requests);
  const requests = listed.length > 0 ? await read(listed.map(requestPath)) : new Map<string, Fields | null>();
  const lobbyIds = listed.map((id) => requests.get(requestPath(id))?.lobbyId).filter((id): id is string => !!id);
  const lobbies = lobbyIds.length > 0 ? await read(lobbyIds.map(lobbyPath)) : new Map<string, Fields | null>();
  const held = listed.filter((id) => {
    const request = requests.get(requestPath(id));
    return !!request && heldDays(lobbies.get(lobbyPath(request.lobbyId!)), at, rules).includes(day);
  });
  return { doc, held, ownerOf: (id: string) => requests.get(requestPath(id))?.ownerId };
}

/** Marks a challenge request whose builder left its lobby before start, emptying it (see stateOf); written by lobbies.ts leave. */
export function builderLeftWrite(requestId: string): Write {
  return { op: "update", path: requestPath(requestId), fields: { builderLeft: "true" } };
}

export function createChallengeSteps(store: Store, identities: Identities, rules: ChallengeLobbyRules) {
  async function caller(key: string) {
    const resolved = await identities.resolveKey(key);
    return resolved.ok ? resolved.value : undefined;
  }

  /** The house owner only: the antwars username's own identity, never one of its handles. */
  async function isHouseOwner(read: TransactionRead, identityId: string): Promise<boolean> {
    return (await read([HOUSE_CLAIM])).get(HOUSE_CLAIM)?.identityId === identityId;
  }

  /**
   * Whether identityId holds a seat in a live lobby.
   * Rerun on every transaction attempt: the slot and public queue indexes and their lobbies are read in the transaction,
   * then the lobbies created since the cutoff are queried newest first, every page at the first page's read time.
   */
  async function seatedElsewhere(read: TransactionRead, identityId: string, at: number): Promise<boolean> {
    const seated = (fields: Fields | null | undefined) => !!fields && isLive(fields, at, rules) && seatsOf(fields).some((seat) => seat.id === identityId);
    // Locked to commit: a live lobby older than the cutoff is a slot holder or a queued queue pairing, named here.
    const indexes = await read(["queues/public", ...rules.slotPaths]);
    const named = [...new Set([
      ...ids(indexes.get("queues/public")?.lobbies),
      ...rules.slotPaths.map((path) => indexes.get(path)?.lobbyId ?? "").filter(Boolean),
    ])];
    const lobbies = named.length > 0 ? await read(named.map(lobbyPath)) : new Map<string, Fields | null>();
    if (named.some((id) => seated(lobbies.get(lobbyPath(id))))) return true;
    // Every other live lobby was created after the cutoff: an older open or waiting player lobby has expired.
    const cutoff = at - rules.lobbyTtlMs;
    let readTime: string | undefined;
    let startAfter: { value: string; path: string } | undefined;
    for (;;) {
      const page = await store.query("lobbies", { orderBy: "createdAt", direction: "DESCENDING", limit: rules.scanPageSize, startAfter, readTime });
      readTime ??= page.readTime;
      if (page.rows.some((row) => seated(row.fields))) return true;
      const last = page.rows.at(-1);
      if (!last || page.rows.length < rules.scanPageSize || Number(last.fields.createdAt) < cutoff) return false;
      startAfter = { value: last.fields.createdAt!, path: last.path };
    }
  }

  async function requestChallenge(key: string, opponent: string, waitToken?: string): Promise<ChallengeOutcome<{ requestId: string; lobbyId: string; seat: number }>> {
    const builder = await caller(key);
    if (!builder) return refuse("unknown_key");
    const handle = houseHandle(opponent);
    if (handle === undefined) return refuse("opponent_unavailable", "not a handle in the House table");
    type Result = ChallengeOutcome<{ requestId: string; lobbyId: string; seat: number }>;
    return store.transaction<Result>(async (read) => {
      const at = rules.now();
      const no = (reason: ChallengeRefusal, detail?: string) => ({ result: refuse(reason, detail), writes: [] });
      const docs = await read([`identities/${builder.id}`, HOUSE_CLAIM, availabilityPath(handle)]);
      const availability = availabilityOf(handle, docs.get(availabilityPath(handle)));
      if (!availability.available) return no("opponent_unavailable", availability.reason!);
      const identity = docs.get(`identities/${builder.id}`);
      const ownerId = identity?.ownerId || builder.id;
      const queue = (await queueStatusStep(read, builder.id, at)).result;
      if (queue.ok && queue.value.state === "waiting") return no("already_queued");
      if (await seatedElsewhere(read, builder.id, at)) return no("seated_elsewhere");
      const pointers = await read([ownerPath(ownerId), challengerPath(builder.id)]);
      const ownerDoc = pointers.get(ownerPath(ownerId)) ?? null;
      if (ownerDoc?.requestId) {
        const previous = (await read([requestPath(ownerDoc.requestId)])).get(requestPath(ownerDoc.requestId));
        const previousLobby = previous?.lobbyId ? (await read([lobbyPath(previous.lobbyId)])).get(lobbyPath(previous.lobbyId)) : null;
        if (previousLobby && isLive(previousLobby, at, rules)) return no("active_challenge");
      }
      const days = [...new Set([utcDay(at), utcDay(at + rules.lobbyTtlMs + rules.countdownMs)])];
      const places = await Promise.all(days.map((day) => placesOn(read, day, at, rules)));
      if (places.some(({ held }) => held.length >= CHALLENGE_SHARED_DAILY_LIMIT)) return no("shared_daily_limit");
      if (places.some(({ held, ownerOf }) => held.filter((id) => ownerOf(id) === ownerId).length >= CHALLENGE_OWNER_DAILY_LIMIT)) return no("owner_daily_limit");

      const requestId = randomUUID();
      const lobbyId = randomUUID();
      const writes: Write[] = [
        { op: "create", path: requestPath(requestId), fields: {
          challengerId: builder.id, ownerId, handle, lobbyId, createdAt: String(at),
          launchReport: "", reportReason: "", reportedAt: "", closedByFailure: "",
        } },
        { op: ownerDoc ? "update" : "create", path: ownerPath(ownerId), fields: { requestId } },
        { op: pointers.get(challengerPath(builder.id)) ? "update" : "create", path: challengerPath(builder.id), fields: { requestId } },
        ...days.map((day, i): Write => {
          const requests = [...places[i]!.held, requestId].join(" ");
          return places[i]!.doc ? { op: "update", path: allowancePath(day), fields: { requests } } : { op: "create", path: allowancePath(day), fields: { requests } };
        }),
        ...(await rules.challengeLobbyWrites(read, { id: lobbyId, requestId, handle, builder: { id: builder.id, displayName: builder.displayName }, at })),
        // The challenger's waiting token is a lobby wait on this challenge's lobby (src/lobby/waits.ts).
        ...(waitToken === undefined ? [] : [waitWrite(waitToken, { kind: "lobby", lobbyId, identityId: builder.id }, at + rules.lobbyTtlMs)]),
      ];
      // A mirror challenge (the held handle challenging itself) plays colony 1 as match seat 2; seat 1 is the house seat.
      const docsHouseId = docs.get(HOUSE_CLAIM)?.identityId;
      const mirror = !!identity && !!docsHouseId && identity.ownerId === docsHouseId && identity.canonical === handle;
      return { result: ok({ requestId, lobbyId, seat: mirror ? 2 : 1 }), writes };
    });
  }

  /** The opponent list and today's places, read in the caller's transaction. */
  async function opponentsIn(read: TransactionRead) {
    const handles = Object.keys(HOUSE_LABELS).filter(handle => !NOT_SEATS.has(handle));
    const at = rules.now();
    const docs = await read(handles.map(availabilityPath));
    const today = await placesOn(read, utcDay(at), at, rules);
    const opponents = handles.map((handle): Opponent => {
      const label = HOUSE_LABELS[handle]!;
      return { handle: `${HOUSE_USERNAME}/${handle}`, displayName: label.displayName, level: label.thinkingLevel, tier: label.serviceTier,
        ...availabilityOf(handle, docs.get(availabilityPath(handle))) };
    });
    const list: OpponentList = { opponents, allowanceLeft: Math.max(0, CHALLENGE_SHARED_DAILY_LIMIT - today.held.length), resetsAt: nextUtcMidnight(at) };
    return { list, today };
  }

  async function listOpponents(): Promise<OpponentList> {
    return store.transaction(async (read) => ({ result: (await opponentsIn(read)).list, writes: [] }));
  }

  /** listOpponents plus the key's username's challenges left today: 5 minus the places its owner holds today. */
  async function listOpponentsFor(key: string): Promise<ChallengeOutcome<OpponentListForUsername>> {
    const reader = await caller(key);
    if (!reader) return refuse("unknown_key");
    return store.transaction<ChallengeOutcome<OpponentListForUsername>>(async (read) => {
      const ownerId = (await read([`identities/${reader.id}`])).get(`identities/${reader.id}`)?.ownerId || reader.id;
      const { list, today } = await opponentsIn(read);
      const held = today.held.filter((id) => today.ownerOf(id) === ownerId).length;
      return { result: ok({ ...list, usernameAllowanceLeft: Math.max(0, CHALLENGE_OWNER_DAILY_LIMIT - held) }), writes: [] };
    });
  }

  async function setAvailability(key: string, name: string, available: boolean): Promise<ChallengeOutcome<{ handle: string; available: boolean }>> {
    const operator = await caller(key);
    if (!operator) return refuse("unknown_key");
    return store.transaction<ChallengeOutcome<{ handle: string; available: boolean }>>(async (read) => {
      if (!(await isHouseOwner(read, operator.id))) return { result: refuse("not_house_owner"), writes: [] };
      const handle = houseHandle(name);
      if (handle === undefined) return { result: refuse("no_such_opponent"), writes: [] };
      const existing = (await read([availabilityPath(handle)])).get(availabilityPath(handle)) ?? null;
      // Marking a handle available clears a failed last launch.
      const fields: Fields = available ? { marked: "", lastLaunch: existing?.lastLaunch === "failed" ? "" : existing?.lastLaunch ?? "", failureReason: "" } : { marked: "unavailable" };
      return {
        result: ok({ handle: `${HOUSE_USERNAME}/${handle}`, available }),
        writes: [existing ? { op: "update", path: availabilityPath(handle), fields } : { op: "create", path: availabilityPath(handle), fields: { marked: "", lastLaunch: "", failureReason: "", ...fields } }],
      };
    });
  }

  async function reportLaunch(key: string, requestId: string, outcome: LaunchOutcome, reason: string | undefined): Promise<ChallengeOutcome<{ requestId: string; launchReport: LaunchOutcome; state: ChallengeState }>> {
    const reporter = await caller(key);
    if (!reporter) return refuse("unknown_key");
    return store.transaction<ChallengeOutcome<{ requestId: string; launchReport: LaunchOutcome; state: ChallengeState }>>(async (read) => {
      const at = rules.now();
      const no = (code: ChallengeRefusal) => ({ result: refuse(code), writes: [] });
      if (!(await isHouseOwner(read, reporter.id))) return no("not_house_owner");
      if (!UUID.test(requestId)) return no("no_such_challenge");
      const request = (await read([requestPath(requestId)])).get(requestPath(requestId));
      if (!request) return no("no_such_challenge");
      // After the UUID and existence checks, so an id that is not a challenge is refused no_such_challenge with or
      // without a reason: that answer is how a caller learns this build accepts every outcome.
      if (outcome !== "launched" && !reason?.trim()) return no("reason_required");
      const lobbyId = request.lobbyId!;
      const docs = await read([lobbyPath(lobbyId), availabilityPath(request.handle!)]);
      const lobby = docs.get(lobbyPath(lobbyId)) ?? null;
      const availability = docs.get(availabilityPath(request.handle!)) ?? null;
      const availabilityWrite = (fields: Fields): Write => availability
        ? { op: "update", path: availabilityPath(request.handle!), fields }
        : { op: "create", path: availabilityPath(request.handle!), fields: { marked: "", lastLaunch: "", failureReason: "", ...fields } };
      const writes: Write[] = [];
      let next: Fields;
      if (outcome === "launched") {
        // One launched report, in any state; it is the charge event.
        if (request.launchReport) return no("already_reported");
        next = { ...request, launchReport: "launched", reportReason: reason ?? "", reportedAt: String(at) };
        writes.push(availabilityWrite({ lastLaunch: "launched", failureReason: "" }));
      } else if (outcome === "unavailable") {
        // One report, and only before the held seat joins. It closes the lobby as failed does, but challenges
        // being unavailable is no fault of this handle: no availability write, so its listing and admission are unchanged.
        if (request.launchReport) return no("already_reported");
        if (lobby && heldSeatFilled(lobby)) return no("house_seated");
        const closes = !!lobby && lobby.state === "open" && !rules.isExpired(lobby, at);
        next = { ...request, launchReport: "unavailable", reportReason: reason!.trim(), reportedAt: String(at), closedByFailure: closes ? "true" : "" };
        if (closes) writes.push(rules.closeWrite(lobbyId));
      } else {
        // Failed is accepted while the held seat is unfilled, even after an early launched report; after the seat
        // joined it is refused house_seated and the game plays on.
        if (request.launchReport === "failed" || request.launchReport === "unavailable") return no("already_reported");
        if (lobby && heldSeatFilled(lobby)) return no("house_seated");
        const closes = !!lobby && lobby.state === "open" && !rules.isExpired(lobby, at);
        next = { ...request, launchReport: "failed", reportReason: reason!.trim(), reportedAt: String(at), closedByFailure: closes ? "true" : "" };
        if (closes) writes.push(rules.closeWrite(lobbyId));
        writes.push(availabilityWrite({ lastLaunch: "failed", failureReason: reason!.trim() }));
      }
      writes.push({ op: "update", path: requestPath(requestId), fields: {
        launchReport: next.launchReport!, reportReason: next.reportReason!, reportedAt: next.reportedAt!, closedByFailure: next.closedByFailure ?? "",
      } });
      const lobbyAfter = next.closedByFailure === "true" ? { ...lobby!, state: "ended", outcome: "not_played" } : lobby;
      return { result: ok({ requestId, launchReport: outcome, state: stateOf(next, lobbyAfter, at, rules).state }), writes };
    });
  }

  async function status(key: string, requestId: string | undefined): Promise<ChallengeOutcome<ChallengeStatus>> {
    const reader = await caller(key);
    if (!reader) return refuse("unknown_key");
    return store.transaction<ChallengeOutcome<ChallengeStatus>>(async (read) => {
      const at = rules.now();
      const none = { result: refuse("no_such_challenge"), writes: [] };
      const owner = await isHouseOwner(read, reader.id);
      let id = requestId;
      if (id === undefined) id = (await read([challengerPath(reader.id)])).get(challengerPath(reader.id))?.requestId;
      if (!id || !UUID.test(id)) return none;
      const request = (await read([requestPath(id)])).get(requestPath(id));
      // Only the house owner reads another identity's request; every other caller sees only its own.
      if (!request || (request.challengerId !== reader.id && !owner)) return none;
      const lobby = (await read([lobbyPath(request.lobbyId!)])).get(lobbyPath(request.lobbyId!));
      const { state, reason } = stateOf(request, lobby, at, rules);
      const view: ChallengeStatus = {
        requestId: id, lobbyId: request.lobbyId!, handle: `${HOUSE_USERNAME}/${request.handle}`, state,
        ...(reason ? { reason } : {}),
        ...(owner ? { launchReport: (request.launchReport || null) as LaunchOutcome | null, launchReportReason: LAUNCH_REPORT_REASON.test(request.reportReason ?? "") ? request.reportReason! : null } : {}),
      };
      return { result: ok(view), writes: [] };
    });
  }

  return { requestChallenge, listOpponents, listOpponentsFor, setAvailability, reportLaunch, status };
}

export type ChallengeSteps = ReturnType<typeof createChallengeSteps>;
