/// <reference types="node" />
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Identities } from "../identity/identities.js";
import type { ColonyId } from "../sim/types.js";
import { isValidId, matchTime, ratingWrites, type ModelLabels, type RankedMode, type ServiceTiers, type ThinkingLevels, type Winner } from "../rating/ratings.js";
import { noteSlotTaken } from "../slots/wake.js";
import type { Fields, Store, TransactionRead, Write } from "../store/firestore.js";
import { HOUSE_USERNAME } from "../identity/houseOwnership.js";
import { CHALLENGE_SCAN_PAGE_SIZE, createChallengeSteps, HELD_COLONY, type ChallengeOutcome, type ChallengeState, type ChallengeStatus, type LaunchOutcome, type OpponentList, type OpponentListForUsername } from "./challenges.js";
import { joinQueueStep, leaveQueueStep, queueEntryPath, queueStatusStep, queueWait, waitingEntries, type QueueStatus } from "./queue.js";
import { isWaitToken, lobbyWait, waitPath, waitWrite, type WaitState } from "./waits.js";
import { lobbyPageUrl } from "./site.js";

/**
 * Public and private lobbies with keyed seats, invite links, match slots and a
 * 12-hour expiry (15 minutes for a house challenge lobby), in the shared store.
 *
 * Lifecycle: open -> (last seat fills, or the creator starts early) -> holding a
 * slot of its kind, or waiting for one -> ended when its slot is released. An open
 * or waiting lobby is expired from 12 hours after creation (a house challenge lobby,
 * challengeId set, from 15 minutes); expiry is derived
 * from the clock, never written, and is checked by every transition, so an expired
 * lobby can never take a slot.
 *
 * A queue-made lobby is created already seated and started by
 * queuedMatchWrites in its caller's transaction: public, rated, with its ranked
 * mode, and absent from listings/public. It never expires, so a paired match
 * waiting for a public slot keeps its place until the slot frees.
 *
 * Documents, under the store's namespace (string fields only):
 *   lobbies/{uuid}      { kind, size, creatorId, createdAt, state, rated, slot,
 *                         seats (JSON [{id, displayName, colony}]), inviteVerifier,
 *                         startsAt, matchRunId, outcome, mode }
 *                       mode is the ranked mode of a queue-made lobby, "" (or absent,
 *                       in lobbies stored before modes) for a player-created one
 *   slots/{kind}-{n}    { lobbyId }  present only while the slot is held
 *   queues/{kind}       { lobbies }  waiting lobby ids, earliest first
 *   listings/public     { lobbies }  public lobby ids, pruned of ended/expired ones
 *   instances/{slot}    { runId, mcpUrl, spectatorUrl, revision, heartbeatAt, heardAt }  the
 *                       slot's serving instance; revision is its Cloud Run revision ("" unknown),
 *                       heartbeatAt the last time it proved alive, heardAt the last
 *                       time a request arrived at it, as of its last heartbeat
 *   queueEntries/{id}, queueWaiting/{mode}  the ranked queue (src/lobby/queue.ts)
 *   challenge*                             house challenges (src/lobby/challenges.ts)
 *   waits/{token}                          waiting tokens (src/lobby/waits.ts)
 *   withheld/{kind}-{n} { }  present while the slot is withheld from new matches;
 *                       any fields are ignored. Written and removed outside the app, by
 *                       deploy/cloud-run/deploy.sh over Firestore REST (PATCH to set,
 *                       DELETE to clear), never by this module.
 *
 * A house challenge lobby is a public 1v1 player lobby created by request_challenge with rated "false",
 * its builder already seated in colony 1 and colony 0 held for one House-table handle, plus the lobby fields
 * challengeId (its request), heldFor (the canonical handle) and challenge ("house"), plus heldAbsent ("true"), written
 * only when its match ended abandoned because the held colony never joined it. Only the antwars username's handle
 * of that name may take the held seat, the builder included when it is that handle (a mirror game); every other rule
 * is an ordinary player lobby's. A failed house launch ends it, still open, with outcome not_played.
 *
 * Withholding: settleSlots, the one allocator behind every lobby start,
 * queue pairing and release, never hands a withheld slot to a lobby. A match already
 * on it plays to the end and is released and rated as usual; the released slot is
 * deleted rather than handed on, and waiters take another free slot or keep waiting.
 * Because no transaction runs when a mark is removed, readLobby and locate settle the
 * slots of a waiting lobby's kind, so a waiter takes the restored slot when it is
 * next looked at, writing nothing when no slot pairs.
 *
 * Stale holds: a slot's server is started only by its wake, so a wake lost
 * even after retries would leave a lobby holding its slot with no server. With
 * staleHoldGraceMs set (the deployed server's STALE_HOLD_GRACE_MS), a holding lobby
 * whose match never began, once the grace has passed since its countdown's end and
 * since its slot instance's last heartbeat, is stale: settleSlots releases it, not
 * played and unrated, whenever a lobby needs a slot no free one gives, and readLobby
 * and locate release it when it is itself read. Its slot is handed on, waking its
 * server, or deleted, exactly as a released slot is.
 *
 * Match slots: taking a slot sets startsAt, the countdown's end. The
 * instance registered for the slot (the last to boot) begins the match, stamping
 * its runId as matchRunId, and releases it with its outcome. A starting instance
 * defers to a live owner of its own revision: while the registered
 * instance's heartbeat is fresh and the slot's lobby holds the match it began,
 * registering writes nothing; a deploy (another revision) or a stale heartbeat
 * still takes the slot, and so does a starter whose claim bounds how long the owner
 * may have heard no request, once it has heard none for that long. Begin and release
 * check the registration inside their transaction, so a superseded instance can
 * neither begin nor end a match; its successor releases a match another run began
 * as not_played,
 * unless it resumes that run's save and adopts the match first: adoption
 * makes the successor the match's owner, so its natural result is rated as usual.
 * Seats and the creator are stable identity ids; no key or key verifier is stored
 * here. An invite token is returned once; only its SHA-256 verifier is stored, and
 * "" means revoked.
 */

export type LobbyKind = "public" | "private";
/** Agents per colony; a match has two colonies. */
export type LobbySize = 1 | 2 | 3 | 4;
export type LobbyState = "open" | "waiting" | "holding" | "ended" | "expired";
export type Colony = 0 | 1;

export interface Seat {
  readonly id: string;
  readonly displayName: string;
}

export interface Lobby {
  readonly id: string;
  readonly kind: LobbyKind;
  readonly size: LobbySize;
  readonly state: LobbyState;
  /** null until start; then false for every player-created lobby: only queue-made matches are rated. */
  readonly rated: boolean | null;
  /** The slot held, such as "public-0", or null. */
  readonly slot: string | null;
  readonly creatorId: string;
  readonly createdAt: number;
  /** When an open or waiting player-created lobby expires; irrelevant once it holds a slot, and for a queue-made lobby. */
  readonly expiresAt: number;
  /** The ranked mode of a queue-made lobby, which never expires; null for a player-created lobby. */
  readonly mode: RankedMode | null;
  /** Seated identities by colony, in seating order. */
  readonly colonies: readonly [readonly Seat[], readonly Seat[]];
  /** When its match starts: the countdown's end, set when the lobby takes a slot. */
  readonly startsAt: number | null;
  /** How its match ended, once its slot is released. */
  readonly outcome: MatchOutcome | null;
  /** Present only on a house challenge lobby: an unrated house challenge whose heldColony seat is held for heldFor. */
  readonly challenge?: LobbyChallenge;
}

/** A house challenge lobby's label: always unrated, its held seat for one antwars/<handle>. */
export interface LobbyChallenge {
  readonly kind: "house";
  readonly heldFor: string;
  readonly heldColony: Colony;
}

/**
 * A natural result (a colony won, or a draw), the operator stop, or not played:
 * the match was replaced by a restarted instance or failed to start. Only a natural
 * result of a rated lobby is rated.
 */
export type MatchOutcome = "colony_0_won" | "colony_1_won" | "draw" | "stopped" | "not_played" | "abandoned";
const OUTCOMES: readonly MatchOutcome[] = ["colony_0_won", "colony_1_won", "draw", "stopped", "not_played", "abandoned"];

/** The instance serving a slot. */
export interface SlotInstance {
  readonly runId: string;
  readonly mcpUrl: string;
  readonly spectatorUrl: string;
}

/** How a starting instance defers to a live owner of its own revision. */
export interface InstanceClaim {
  /** This instance's revision (Cloud Run K_REVISION); never empty. */
  readonly revision: string;
  /** An owner's heartbeat at least this old is stale: the owner is taken to be gone. */
  readonly staleMs: number;
  /**
   * An owner that has heard no request for at least this long is unreachable and taken
   * to be gone: measured from its heardAt, else its heartbeatAt. Absent, only
   * the heartbeat counts.
   */
  readonly unheardMs?: number;
}

/** Registered, or deferred to the live owner named. */
export type Registration = { readonly registered: true } | { readonly registered: false; readonly ownerRunId: string };

/** Where a lobby's match is played: its slot and that slot's addresses, null until it holds one. */
export interface MatchLocation {
  readonly slot: string | null;
  readonly mcpUrl: string | null;
  readonly spectatorUrl: string | null;
}

/** The lobby holding a slot, as its instance needs it. */
export interface SlotHolder {
  readonly lobbyId: string;
  /** The queue's ranked mode; null for an unrated player-created lobby. */
  readonly mode: RankedMode | null;
  readonly startsAt: number;
  /** The run that began its match; null during the countdown. */
  readonly matchRunId: string | null;
  readonly colonies: readonly [readonly Seat[], readonly Seat[]];
}

export type LobbyRefusal =
  | "unknown_key" | "invalid_kind" | "invalid_size" | "no_such_lobby" | "invalid_invite"
  | "already_seated" | "full" | "started" | "expired" | "not_creator" | "colony_empty"
  | "not_private" | "not_holding" | "superseded" | "invalid_mode" | "already_queued" | "colony_full"
  /** A house mode was joined by an identity other than a handle of the antwars username. */
  | "not_house"
  /** Adopting a saved match the lobby no longer holds this slot with. */
  | "stale_save"
  /** A house challenge's held seat, taken by an identity other than its handle. */
  | "seat_held";
export type LobbyOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: LobbyRefusal };

export interface CreatedLobby {
  readonly lobby: Lobby;
  /** Private lobbies only: the invite token, returned only here. */
  readonly inviteToken?: string;
}

export interface Lobbies {
  /** The countdown from taking a slot to the match's start (COUNTDOWN_MS unless configured). */
  readonly countdownMs: number;
  createLobby(key: string, kind: LobbyKind, size: LobbySize): Promise<LobbyOutcome<CreatedLobby>>;
  /**
   * inviteToken is required for a private lobby and ignored for a public one. With
   * colony, the joiner takes a seat in that colony or is refused colony_full and stays
   * unseated; without it, the colony with fewer seats, colony 0 on a tie.
   * With waitToken, a successful join also records it as a lobby wait (src/lobby/waits.ts) in the same transaction.
   */
  join(lobbyId: string, key: string, inviteToken?: string, colony?: Colony, waitToken?: string): Promise<LobbyOutcome<Lobby>>;
  /** Creator only; a revoked token is never current again. */
  revokeInvite(lobbyId: string, creatorKey: string): Promise<LobbyOutcome<null>>;
  /** Creator only; replaces any current token. */
  issueInvite(lobbyId: string, creatorKey: string): Promise<LobbyOutcome<{ readonly inviteToken: string }>>;
  /** Whether token is a private lobby's current invite token. */
  isInviteCurrent(lobbyId: string, token: string): Promise<boolean>;
  /** Creator only, once each colony has a seated identity. */
  startEarly(lobbyId: string, creatorKey: string): Promise<LobbyOutcome<Lobby>>;
  /**
   * Ends a lobby's hold on its slot when its match ends and hands the slot to the
   * earliest-waiting live lobby of that kind, whose id is returned (null if none).
   * Refused with no change unless the lobby currently holds its slot, so a repeated
   * release never evicts a successor.
   */
  releaseSlot(lobbyId: string): Promise<LobbyOutcome<{ readonly next: string | null }>>;
  /**
   * releaseSlot by the slot's instance, recording the match's outcome. Refused as
   * superseded unless runId is the slot's registered instance; a natural or stopped
   * outcome also needs runId to have begun the match. A natural result of a rated
   * lobby is rated in the same transaction, in the lobby's mode ("1v1" when it has
   * none), teams by colony with each identity once; nothing else is rated. An abandoned
   * house challenge whose absentColonies (the colonies whose seat never joined) include its
   * held colony records heldAbsent; no other lobby records absentColonies.
   */
  endMatch(lobbyId: string, runId: string, outcome: MatchOutcome, thinkingLevels?: ThinkingLevels, serviceTiers?: ServiceTiers,
    modelLabels?: ModelLabels, absentColonies?: readonly ColonyId[]): Promise<LobbyOutcome<{ readonly next: string | null }>>;
  /**
   * Registers runId as the slot's instance, replacing any earlier one: the last to
   * boot wins. With claim, nothing is written and the owner is returned while the
   * registered instance is of claim's revision, its heartbeat is younger than
   * claim.staleMs, and the slot's lobby holds the match that instance began,
   * and, with claim.unheardMs, it heard a request less than that long ago.
   */
  registerInstance(slot: string, instance: SlotInstance, claim?: InstanceClaim): Promise<Registration>;
  /**
   * Refreshes runId's heartbeat, and with heardAt when a request last arrived at it;
   * false, with nothing written, unless runId is the slot's registered instance.
   */
  heartbeat(slot: string, runId: string, heardAt?: number): Promise<boolean>;
  /** The slot's registered instance, or null. */
  resolveSlot(slot: string): Promise<SlotInstance | null>;
  /** The lobby's slot and the owning instance's addresses; nothing else about the lobby. A waiting lobby is settled first. */
  locate(lobbyId: string): Promise<LobbyOutcome<MatchLocation>>;
  /** The lobby holding the slot, or null. */
  slotHolder(slot: string): Promise<SlotHolder | null>;
  /** Begins the holder's match as runId, refreshing its heartbeat; refused as superseded unless runId is registered, or started if already begun. */
  beginMatch(lobbyId: string, slot: string, runId: string): Promise<LobbyOutcome<null>>;
  /**
   * A successor takes over the begun match fromRunId advanced last, once it has restored
   * that run's save: sets the lobby's matchRunId to runId and refreshes its
   * heartbeat, so its natural result releases and rates as runId's own. Refused as
   * superseded unless runId is the slot's registered instance, and stale_save unless the
   * lobby holds the slot with fromRunId's match; repeated by runId after it committed, it
   * succeeds again, so a lost reply is retried safely.
   */
  adoptMatch(lobbyId: string, slot: string, runId: string, fromRunId: string): Promise<LobbyOutcome<null>>;
  /** The lobby; a waiting one is settled first, taking a free unwithheld slot if one exists. */
  readLobby(lobbyId: string): Promise<LobbyOutcome<Lobby>>;
  /** Public lobbies that are open, waiting or holding a slot, oldest first. */
  listPublic(): Promise<readonly Lobby[]>;
  /**
   * A queue pairing's match, inside the caller's transaction on this store: creates
   * a public, rated lobby of that mode with the seats as given (size is the colony
   * length; the creator is the first colony-0 seat) and starts it through
   * settleSlots, holding a free public slot or waiting for one. It is not listed in
   * listings/public.
   */
  queuedMatchWrites(
    read: TransactionRead,
    match: { readonly mode: RankedMode; readonly colonies: readonly [readonly Seat[], readonly Seat[]] },
    at: number,
  ): Promise<{ readonly writes: readonly Write[]; readonly lobby: Lobby }>;
  /**
   * Joins the ranked queue in a mode: waits, or pairs at once with a waiting entry. With waitToken, a successful
   * join also records it as a queue wait for this join (src/lobby/waits.ts) in the same transaction.
   */
  joinQueue(key: string, mode: string, waitToken?: string): Promise<LobbyOutcome<QueueStatus>>;
  queueStatus(key: string): Promise<LobbyOutcome<QueueStatus>>;
  /** Removes the identity's waiting entry; any other status is returned unchanged. */
  leaveQueue(key: string): Promise<LobbyOutcome<QueueStatus>>;
  /**
   * Every live waiting queue entry across all modes, oldest first, by the identity's current public display name.
   * Read-only; an entry whose identity no longer resolves is left out.
   */
  listWaiting(): Promise<readonly WaitingAgent[]>;
  /**
   * Every public lobby with a seated agent whose match has not begun, oldest first: a player-created lobby
   * that is open, waiting for a slot or holding one in its countdown, and a queue pairing's match waiting for or holding
   * a slot. Read from listings/public, queues/public and the public slots only, so a private lobby is never read.
   * Read-only, from one consistent snapshot of those indexes: unlike readLobby, a waiting lobby is not settled. Seats
   * are named by their identities' current display names.
   */
  listUnstarted(): Promise<readonly UnstartedLobby[]>;
  /** House challenges (src/lobby/challenges.ts). */
  /** With waitToken, an admitted request also records it as a lobby wait on the challenge's lobby, in the same transaction. */
  requestChallenge(key: string, opponent: string, waitToken?: string): Promise<ChallengeOutcome<{ readonly requestId: string; readonly lobbyId: string; readonly seat: number }>>;
  listChallengeOpponents(): Promise<OpponentList>;
  listChallengeOpponentsFor(key: string): Promise<ChallengeOutcome<OpponentListForUsername>>;
  setChallengeAvailability(key: string, handle: string, available: boolean): Promise<ChallengeOutcome<{ readonly handle: string; readonly available: boolean }>>;
  reportChallengeLaunch(key: string, requestId: string, outcome: LaunchOutcome, reason?: string): Promise<ChallengeOutcome<{ readonly requestId: string; readonly launchReport: LaunchOutcome; readonly state: ChallengeState }>>;
  challengeStatus(key: string, requestId?: string): Promise<ChallengeOutcome<ChallengeStatus>>;
  /**
   * The current state of the wait a waiting token names, or null for no such token. A lobby wait is read as readLobby
   * reads it, so a waiting lobby is settled first; a queue wait reads the entry only. Nothing else is read or returned.
   */
  waitStatus(token: string): Promise<WaitState | null>;
}

/** A live waiting queue entry by its identity's current display name; nothing else about the identity. */
export interface WaitingAgent { readonly displayName: string; readonly mode: RankedMode; readonly joinedAt: number }

/** A public lobby not yet begun (listUnstarted): each colony's distinct seated identities by current name, in seating order. */
export interface UnstartedLobby {
  /** The queue pairing's ranked mode; null for a player-created lobby. */
  readonly mode: RankedMode | null;
  readonly size: LobbySize;
  readonly createdAt: number;
  /** Seats taken, of 2 × size. A queue pairing's identity holds every seat of its colony, so it is always full. */
  readonly seated: number;
  readonly colonies: readonly [readonly Seat[], readonly Seat[]];
  /** Present only on a house challenge lobby, which the Waiting card labels. */
  readonly challenge?: "house";
}

export interface LobbySettings {
  /** Match slots per kind; the launch cap is one of each. */
  readonly publicSlots?: number;
  readonly privateSlots?: number;
  /** Countdown from taking a slot to the match's start. */
  readonly countdownMs?: number;
  /**
   * How long past its countdown's end, or past its slot instance's last heartbeat if later, a holding
   * lobby whose match never began keeps its slot; unset, holds are never released as stale.
   * The deployed server passes STALE_HOLD_GRACE_MS (src/main.ts).
   */
  readonly staleHoldGraceMs?: number;
  readonly now?: () => number;
  /** The queue's uniform random pick, in [0, 1); Math.random unless a test injects one. */
  readonly random?: () => number;
  /** Recent lobbies per page of the challenge seated-elsewhere scan (CHALLENGE_SCAN_PAGE_SIZE unless a test pages it). */
  readonly challengeScanPageSize?: number;
}

/** A player-created lobby's lifetime, open or waiting: 12 hours, renewed by nothing. */
export const LOBBY_TTL_MS = 12 * 60 * 60 * 1000;
/** A house challenge lobby (challengeId set) keeps 15 minutes, so an unjoined house seat never holds daily places for long. */
export const CHALLENGE_LOBBY_TTL_MS = 15 * 60 * 1000;
/** The visible countdown before a lobby's match starts. */
export const COUNTDOWN_MS = 10_000;
/**
 * The deployed stale-hold grace: above a fully retried lost wake (three 60 s attempts
 * and their 6 s of backoff, src/slots/wake.ts), a cold start, and a late server's fresh countdown.
 */
export const STALE_HOLD_GRACE_MS = 5 * 60_000;
export const SLOT = /^(public|private)-(\d+)$/;
const LOBBY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LISTING = "listings/public";

interface StoredSeat { readonly id: string; readonly displayName: string; readonly colony: Colony }

const refuse = (reason: LobbyRefusal) => ({ ok: false, reason }) as const;
const ok = <T>(value: T) => ({ ok: true, value }) as const;
const verifierOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const lobbyPath = (id: string) => `lobbies/${id}`;
const ids = (list: string | undefined) => (list ?? "").split(" ").filter(Boolean);
const KINDS: readonly LobbyKind[] = ["public", "private"];
const SIZES: readonly LobbySize[] = [1, 2, 3, 4];
/** The states a lobby document stores; expired is derived on read. */
const STORED_STATES: readonly LobbyState[] = ["open", "waiting", "holding", "ended"];

/** A lobby's stored seats, or null when they do not parse as [{id, displayName, colony: 0 | 1}] with valid ids (as lobbySeats, ratings.ts). */
function storedSeats(stored: string): StoredSeat[] | null {
  let seats: unknown;
  try { seats = JSON.parse(stored); } catch { return null; }
  const isSeat = (seat: unknown): seat is StoredSeat => typeof seat === "object" && seat !== null
    && isValidId((seat as { id?: unknown }).id) && typeof (seat as { displayName?: unknown }).displayName === "string"
    && ((seat as { colony?: unknown }).colony === 0 || (seat as { colony?: unknown }).colony === 1);
  return Array.isArray(seats) && seats.every(isSeat) ? seats : null;
}

/**
 * The checked kind, size, state and seats of the lobby document lobbies/{id}: operators and deploy scripts
 * write these documents directly, so a malformed one throws an error naming its path and field, never a cast value.
 */
function lobbyDocument(id: string, fields: Fields): { kind: LobbyKind; size: LobbySize; state: LobbyState; seats: StoredSeat[] } {
  const malformed = (field: string) => new Error(`malformed lobby document ${lobbyPath(id)}: ${field} ${JSON.stringify(fields[field] ?? null)}`);
  const seats = storedSeats(fields.seats ?? "[]");
  if (seats === null) throw malformed("seats");
  const kind = KINDS.find((known) => known === fields.kind);
  if (kind === undefined) throw malformed("kind");
  const state = STORED_STATES.find((known) => known === fields.state);
  if (state === undefined) throw malformed("state");
  const size = SIZES.find((known) => known === Number(fields.size));
  if (size === undefined) throw malformed("size");
  return { kind, size, state, seats };
}

const seatsOf = (id: string, fields: Fields): StoredSeat[] => lobbyDocument(id, fields).seats;
const capacity = (id: string, fields: Fields) => 2 * lobbyDocument(id, fields).size;

/** A lobby's lifetime from creation: CHALLENGE_LOBBY_TTL_MS for a house challenge lobby, LOBBY_TTL_MS otherwise. */
const lobbyTtl = (fields: Fields) => fields.challengeId ? CHALLENGE_LOBBY_TTL_MS : LOBBY_TTL_MS;

/** The one expiry rule: a player-created lobby, open or waiting, at or after its lifetime from creation; a queue-made lobby never expires. */
export function isExpired(fields: Fields, now: number): boolean {
  return !fields.mode && (fields.state === "open" || fields.state === "waiting") && now >= Number(fields.createdAt) + lobbyTtl(fields);
}

/** Ended and expired are both irreversible. */
const isTerminal = (fields: Fields, now: number) => fields.state === "ended" || isExpired(fields, now);

function toLobby(id: string, fields: Fields, now: number): Lobby {
  const { kind, size, state, seats } = lobbyDocument(id, fields);
  const createdAt = Number(fields.createdAt);
  const colonies: [Seat[], Seat[]] = [[], []];
  for (const seat of seats) colonies[seat.colony].push({ id: seat.id, displayName: seat.displayName });
  return {
    id,
    kind,
    size,
    state: isExpired(fields, now) ? "expired" : state,
    rated: fields.rated === "" ? null : fields.rated === "true",
    slot: fields.slot || null,
    creatorId: fields.creatorId!,
    createdAt,
    expiresAt: createdAt + lobbyTtl(fields),
    colonies,
    startsAt: fields.startsAt ? Number(fields.startsAt) : null,
    outcome: OUTCOMES.includes(fields.outcome as MatchOutcome) ? fields.outcome as MatchOutcome : null,
    mode: fields.mode ? fields.mode as RankedMode : null,
    ...(fields.challengeId ? { challenge: { kind: "house", heldFor: `${HOUSE_USERNAME}/${fields.heldFor}`, heldColony: HELD_COLONY } } : {}),
  };
}

const instancePath = (slot: string) => `instances/${slot}`;
/** The withholding mark of the slot at slots/{slot}. */
const withheldPathOf = (slotPath: string) => `withheld/${slotPath.slice("slots/".length)}`;

function toInstance(fields: Fields | null): SlotInstance | null {
  return fields && fields.runId ? { runId: fields.runId, mcpUrl: fields.mcpUrl ?? "", spectatorUrl: fields.spectatorUrl ?? "" } : null;
}

/** Winner "a" is colony 0; stopped, abandoned and not played have no result to rate. */
function ratedWinner(outcome: MatchOutcome): Winner | null {
  return outcome === "colony_0_won" ? "a" : outcome === "colony_1_won" ? "b" : outcome === "draw" ? "draw" : null;
}

function slotCount(value: number | undefined, name: string): number {
  const count = value ?? 1;
  if (!Number.isInteger(count) || count < 1) throw new Error(`${name} must be a positive integer`);
  return count;
}

export function createLobbies(store: Store, identities: Identities, settings: LobbySettings = {}): Lobbies {
  const slots: Record<LobbyKind, number> = {
    public: slotCount(settings.publicSlots, "publicSlots"),
    private: slotCount(settings.privateSlots, "privateSlots"),
  };
  const now = settings.now ?? Date.now;
  const random = settings.random ?? Math.random;
  const countdownMs = settings.countdownMs ?? COUNTDOWN_MS;
  const staleHoldGraceMs = settings.staleHoldGraceMs;

  /** Whether a holding lobby's unbegun match is past its countdown and the grace, ignoring its instance. */
  const holdLapsed = (fields: Fields, at: number) => staleHoldGraceMs !== undefined && fields.state === "holding"
    && !fields.matchRunId && at >= Number(fields.startsAt || 0) + staleHoldGraceMs;

  /**
   * The occupied slots among slotPaths whose holder is stale: its match never began, and the
   * grace has passed since its countdown's end and since its slot instance's last heartbeat. A
   * registration stamps that heartbeat, so a server that registered late keeps the hold for the grace.
   */
  async function staleHolds(read: TransactionRead, slotPaths: readonly string[], docs: ReadonlyMap<string, Fields | null>, at: number) {
    const held = slotPaths.flatMap((path) => {
      const lobbyId = docs.get(path)?.lobbyId;
      return lobbyId ? [{ path, slot: path.slice("slots/".length), lobbyId }] : [];
    });
    if (held.length === 0) return [];
    const found = await read(held.flatMap(({ slot, lobbyId }) => [lobbyPath(lobbyId), instancePath(slot)]));
    return held.filter(({ slot, lobbyId }) => {
      const lobby = found.get(lobbyPath(lobbyId));
      const heartbeatAt = Number(found.get(instancePath(slot))?.heartbeatAt || 0);
      return !!lobby && lobby.slot === slot && holdLapsed(lobby, at) && at >= heartbeatAt + staleHoldGraceMs!;
    });
  }

  async function identityOf(key: string) {
    const resolved = await identities.resolveKey(key);
    return resolved.ok ? resolved.value : undefined;
  }

  /**
   * Hands free slots of a kind to waiting lobbies in queue order, inside the
   * caller's transaction. starting is a lobby that has just started (it queues
   * last, with its other field updates merged into its write); freed is a slot
   * being released by its holder. Waiters that have ended, expired or vanished are
   * skipped and pruned from the queue. A withheld slot is never handed
   * out; a withheld freed slot is deleted, so it is free once its mark is removed.
   * With staleHoldGraceMs, when a lobby needs a slot no free one gives, or with
   * reclaim, a stale holder's slot is freed too: the holder ends not
   * played, unrated, and its slot is handed on or deleted like a released one.
   */
  async function settleSlots(
    read: TransactionRead, kind: LobbyKind, at: number,
    starting?: { readonly id: string; readonly update: Record<string, string> },
    freed?: string,
    reclaim = false,
  ): Promise<{ writes: Write[]; startingSlot: string | null; handedTo: string[]; released: string[] }> {
    const slotPaths = Array.from({ length: slots[kind] }, (_, n) => `slots/${kind}-${n}`);
    const queuePath = `queues/${kind}`;
    // The marks are read in this transaction, so a mark written before it commits
    // conflicts with it rather than being missed.
    const docs = await read([...slotPaths, ...slotPaths.map(withheldPathOf), queuePath]);
    // A reclaimed slot is held now but handed on or deleted here: the freed one, and any stale hold's.
    const reclaimed = new Set(freed ? [freed] : []);
    const free = () => slotPaths.filter((path) => (reclaimed.has(path) || docs.get(path) === null) && docs.get(withheldPathOf(path)) === null);
    const queueDoc = docs.get(queuePath) ?? null;
    const queued = ids(queueDoc?.lobbies);
    const queuedDocs = queued.length > 0 ? await read(queued.map(lobbyPath)) : new Map<string, Fields | null>();
    const waiters = queued.filter((id) => {
      const fields = queuedDocs.get(lobbyPath(id));
      return fields?.state === "waiting" && !isExpired(fields, at);
    });
    const order = starting ? [...waiters, starting.id] : waiters;
    const stale = staleHoldGraceMs !== undefined && (reclaim || order.length > free().length)
      ? await staleHolds(read, slotPaths.filter((path) => !reclaimed.has(path)), docs, at)
      : [];
    for (const hold of stale) reclaimed.add(hold.path);
    const pairs = free().slice(0, order.length).map((path, i) => ({ path, lobbyId: order[i]! }));

    const writes: Write[] = [];
    let startingSlot: string | null = null;
    // Every way a lobby takes a slot starts its countdown here.
    const startsAt = String(at + countdownMs);
    for (const { path, lobbyId } of pairs) {
      const slot = path.slice("slots/".length);
      // Its server is woken once this transaction commits.
      noteSlotTaken(read, slot);
      writes.push(reclaimed.has(path)
        ? { op: "update", path, fields: { lobbyId } }
        : { op: "create", path, fields: { lobbyId } });
      if (lobbyId === starting?.id) {
        startingSlot = slot;
        writes.push({ op: "update", path: lobbyPath(lobbyId), fields: { ...starting.update, state: "holding", slot, startsAt } });
      } else {
        writes.push({ op: "update", path: lobbyPath(lobbyId), fields: { state: "holding", slot, startsAt } });
      }
    }
    for (const path of reclaimed) if (!pairs.some((pair) => pair.path === path)) writes.push({ op: "delete", path });
    // A stale holder's match was never played, so it ends unrated with nothing to rate.
    for (const { lobbyId } of stale) writes.push({ op: "update", path: lobbyPath(lobbyId), fields: { state: "ended", slot: "", outcome: "not_played" } });
    if (starting && startingSlot === null) {
      writes.push({ op: "update", path: lobbyPath(starting.id), fields: { ...starting.update, state: "waiting" } });
    }
    const remaining = order.slice(pairs.length).join(" ");
    if (queueDoc === null) {
      if (remaining) writes.push({ op: "create", path: queuePath, fields: { lobbies: remaining } });
    } else if (remaining !== queueDoc.lobbies) {
      writes.push({ op: "update", path: queuePath, fields: { lobbies: remaining } });
    }
    return {
      writes,
      startingSlot,
      handedTo: pairs.map((pair) => pair.lobbyId).filter((id) => id !== starting?.id),
      released: stale.map((hold) => hold.lobbyId),
    };
  }

  /**
   * A lobby's fields after settling its kind's slots when it is waiting: a
   * slot whose mark was removed outside the app, or a stale holder's, is
   * handed to waiters in queue order. A holding lobby past its countdown and the stale
   * grace is settled too, so a stale hold is released when its own lobby is read.
   * Commits only when a waiter takes a slot or a stale hold is released; otherwise
   * nothing is written, not even queue pruning, and the fields read are returned unchanged.
   */
  async function settledIfWaiting(lobbyId: string, fields: Fields): Promise<Fields> {
    const unsettled = (lobby: Fields, at: number) => (lobby.state === "waiting" && !isExpired(lobby, at)) || holdLapsed(lobby, at);
    if (!unsettled(fields, now())) return fields;
    return store.transaction<Fields>(async (read) => {
      const at = now();
      const current = (await read([lobbyPath(lobbyId)])).get(lobbyPath(lobbyId));
      if (!current || !unsettled(current, at)) return { result: current ?? fields, writes: [] };
      const settled = await settleSlots(read, current.kind as LobbyKind, at, undefined, undefined, current.state === "holding");
      if (settled.handedTo.length === 0 && settled.released.length === 0) return { result: current, writes: [] };
      const own = settled.writes.find((write) => write.path === lobbyPath(lobbyId));
      return { result: own?.op === "update" ? { ...current, ...own.fields } : current, writes: settled.writes };
    });
  }

  /** Starts an open player-created lobby in the caller's transaction, always unrated. */
  async function start(read: TransactionRead, id: string, fields: Fields, seats: StoredSeat[], at: number) {
    const update = { seats: JSON.stringify(seats), rated: "false" };
    const settled = await settleSlots(read, fields.kind as LobbyKind, at, { id, update });
    const next: Fields = {
      ...fields, ...update, state: settled.startingSlot ? "holding" : "waiting", slot: settled.startingSlot ?? "",
      ...(settled.startingSlot ? { startsAt: String(at + countdownMs) } : {}),
    };
    return { writes: settled.writes, lobby: toLobby(id, next, at) };
  }

  /**
   * Ends a lobby's hold on its slot and hands the slot on, inside the caller's
   * transaction. With an ending, only the slot's registered instance may release,
   * a natural or stopped ending only for the match its own run began, and a rated
   * lobby's natural result is rated in the same commit.
   */
  async function release(read: TransactionRead, lobbyId: string, ending?: {
    readonly runId: string; readonly outcome: MatchOutcome; readonly thinkingLevels?: ThinkingLevels; readonly serviceTiers?: ServiceTiers;
    readonly modelLabels?: ModelLabels; readonly absentColonies?: readonly ColonyId[];
  }) {
    type Released = LobbyOutcome<{ readonly next: string | null }>;
    const at = now();
    const fields = (await read([lobbyPath(lobbyId)])).get(lobbyPath(lobbyId));
    if (!fields || fields.state !== "holding" || !fields.slot) return { result: refuse("not_holding") as Released, writes: [] };
    const slotPath = `slots/${fields.slot}`;
    const docs = await read([slotPath, instancePath(fields.slot)]);
    if (docs.get(slotPath)?.lobbyId !== lobbyId) return { result: refuse("not_holding") as Released, writes: [] };
    const writes: Write[] = [];
    let outcome = "";
    let heldAbsent = false;
    if (ending) {
      if (docs.get(instancePath(fields.slot))?.runId !== ending.runId) return { result: refuse("superseded") as Released, writes: [] };
      if (ending.outcome !== "not_played" && fields.matchRunId !== ending.runId) return { result: refuse("superseded") as Released, writes: [] };
      outcome = ending.outcome;
      heldAbsent = outcome === "abandoned" && !!fields.challengeId && (ending.absentColonies ?? []).includes(HELD_COLONY);
      const winner = ratedWinner(ending.outcome);
      if (winner !== null && fields.rated === "true") {
        // In a ranked team mode one identity holds every seat of its colony, so each
        // colony is rated as its distinct identities, in the lobby's mode.
        const seats = seatsOf(lobbyId, fields);
        const teams = [0, 1].map((colony) => [...new Set(seats.filter((seat) => seat.colony === colony).map((seat) => seat.id))]) as [string[], string[]];
        const mode = (fields.mode || "1v1") as RankedMode;
        // The match time Glicko measures inactivity by.
        const matchAt = matchTime(fields);
        writes.push(...(await ratingWrites(read, { matchId: lobbyId, mode, teams, winner, ...(matchAt === null ? {} : { at: matchAt }),
          thinkingLevels: ending.thinkingLevels, serviceTiers: ending.serviceTiers, modelLabels: ending.modelLabels })).writes);
      }
    }
    const settled = await settleSlots(read, fields.kind as LobbyKind, at, undefined, slotPath);
    return {
      result: ok({ next: settled.handedTo[0] ?? null }) as Released,
      writes: [{ op: "update", path: lobbyPath(lobbyId), fields: { state: "ended", slot: "", outcome, ...(outcome === "abandoned" ? { rated: "false" } : {}), ...(heldAbsent ? { heldAbsent: "true" } : {}) } }, ...settled.writes, ...writes] as Write[],
    };
  }

  async function queuedMatchWrites(
    read: TransactionRead,
    { mode, colonies }: { readonly mode: RankedMode; readonly colonies: readonly [readonly Seat[], readonly Seat[]] },
    at: number,
  ): Promise<{ readonly writes: readonly Write[]; readonly lobby: Lobby }> {
    const size = colonies[0].length;
    if (![1, 2, 3, 4].includes(size) || colonies[1].length !== size) throw new Error("a queue-made match needs two colonies of 1-4 seats each");
    const id = randomUUID();
    const seats: StoredSeat[] = colonies.flatMap((colony, index) =>
      colony.map((seat) => ({ id: seat.id, displayName: seat.displayName, colony: index as Colony })));
    const fields: Fields = {
      kind: "public", size: String(size), creatorId: colonies[0][0]!.id, createdAt: String(at), state: "open",
      rated: "true", slot: "", seats: JSON.stringify(seats), inviteVerifier: "", startsAt: "", matchRunId: "", outcome: "", mode,
    };
    // settleSlots writes the starting lobby once, as an update holding or waiting (and
    // notes a taken slot for its wake); the lobby is new, so that write becomes its
    // create, carrying every field.
    const path = lobbyPath(id);
    const settled = await settleSlots(read, "public", at, { id, update: fields });
    const own = settled.writes.find((write) => write.path === path);
    if (own?.op !== "update") throw new Error("queue-made lobby was not started");
    const writes = settled.writes.map((write): Write => write === own ? { op: "create", path, fields: own.fields } : write);
    return { writes, lobby: toLobby(id, own.fields, at) };
  }

  async function queueIdentity(key: string) {
    const identity = await identityOf(key);
    return identity ? { id: identity.id, displayName: identity.displayName } : undefined;
  }

  /** Reads a lobby and checks its creator inside a transaction. */
  async function creatorLobby(read: TransactionRead, lobbyId: string, creatorId: string) {
    const fields = (await read([lobbyPath(lobbyId)])).get(lobbyPath(lobbyId));
    if (!fields) return refuse("no_such_lobby");
    if (fields.creatorId !== creatorId) return refuse("not_creator");
    return ok(fields);
  }

  /** The lobby; a waiting one is settled first (Lobbies.readLobby). */
  async function readLobby(lobbyId: string): Promise<LobbyOutcome<Lobby>> {
    const fields = await store.get(lobbyPath(lobbyId));
    return fields ? ok(toLobby(lobbyId, await settledIfWaiting(lobbyId, fields), now())) : refuse("no_such_lobby");
  }

  /** Whether identityId is the antwars username's handle named handle, by stored owner, in the caller's transaction. */
  async function holdsHeldSeat(read: TransactionRead, identityId: string, handle: string): Promise<boolean> {
    const docs = await read([`identities/${identityId}`, `usernames/${HOUSE_USERNAME}`]);
    const identity = docs.get(`identities/${identityId}`);
    const houseId = docs.get(`usernames/${HOUSE_USERNAME}`)?.identityId;
    return !!identity && !!houseId && identity.kind === "handle" && identity.ownerId === houseId && identity.canonical === handle;
  }

  const challenges = createChallengeSteps(store, identities, {
    countdownMs,
    lobbyTtlMs: CHALLENGE_LOBBY_TTL_MS,
    now,
    scanPageSize: settings.challengeScanPageSize ?? CHALLENGE_SCAN_PAGE_SIZE,
    isExpired,
    slotPaths: (["public", "private"] as const).flatMap((kind) => Array.from({ length: slots[kind] }, (_, n) => `slots/${kind}-${n}`)),
    async challengeLobbyWrites(read, { id, requestId, handle, builder, at }) {
      const seats: StoredSeat[] = [{ id: builder.id, displayName: builder.displayName, colony: 1 }]; // the colony not held
      const fields: Fields = {
        kind: "public", size: "1", creatorId: builder.id, createdAt: String(at), state: "open",
        rated: "false", slot: "", seats: JSON.stringify(seats), inviteVerifier: "", startsAt: "", matchRunId: "", outcome: "", mode: "",
        challengeId: requestId, heldFor: handle, challenge: "house",
      };
      const listing = (await read([LISTING])).get(LISTING) ?? null;
      const lobbies = [...ids(listing?.lobbies), id].join(" ");
      return [
        listing ? { op: "update", path: LISTING, fields: { lobbies } } : { op: "create", path: LISTING, fields: { lobbies } },
        { op: "create", path: lobbyPath(id), fields },
      ];
    },
    closeWrite: (lobbyId) => ({ op: "update", path: lobbyPath(lobbyId), fields: { state: "ended", outcome: "not_played" } }),
  });

  return {
    countdownMs,

    requestChallenge: challenges.requestChallenge,
    listChallengeOpponents: challenges.listOpponents,
    listChallengeOpponentsFor: challenges.listOpponentsFor,
    setChallengeAvailability: challenges.setAvailability,
    reportChallengeLaunch: challenges.reportLaunch,
    challengeStatus: challenges.status,

    async createLobby(key, kind, size) {
      if (kind !== "public" && kind !== "private") return refuse("invalid_kind");
      if (![1, 2, 3, 4].includes(size)) return refuse("invalid_size");
      const creator = await identityOf(key);
      if (!creator) return refuse("unknown_key");
      const id = randomUUID();
      const createdAt = now();
      const inviteToken = kind === "private" ? newToken() : undefined;
      const fields: Fields = {
        kind, size: String(size), creatorId: creator.id, createdAt: String(createdAt), state: "open",
        rated: "", slot: "", seats: "[]", inviteVerifier: inviteToken ? verifierOf(inviteToken) : "",
        startsAt: "", matchRunId: "", outcome: "", mode: "",
      };
      const created = { op: "create", path: lobbyPath(id), fields } as const;
      if (kind === "private") {
        await store.transaction(async () => ({ result: null, writes: [created] }));
        return ok({ lobby: toLobby(id, fields, createdAt), inviteToken });
      }
      // Liveness is read outside the transaction, so creating never locks other
      // lobbies; only ids already observed terminal are pruned, and terminal is final.
      const listed = ids((await store.get(LISTING))?.lobbies);
      const observed = await Promise.all(listed.map(async (listedId) => ({ listedId, fields: await store.get(lobbyPath(listedId)) })));
      const dead = new Set(observed.filter(({ fields }) => !fields || isTerminal(fields, createdAt)).map(({ listedId }) => listedId));
      await store.transaction(async (read) => {
        const listing = (await read([LISTING])).get(LISTING) ?? null;
        const lobbies = [...ids(listing?.lobbies).filter((listedId) => !dead.has(listedId)), id].join(" ");
        return {
          result: null,
          writes: [
            listing ? { op: "update", path: LISTING, fields: { lobbies } } : { op: "create", path: LISTING, fields: { lobbies } },
            created,
          ],
        };
      });
      return ok({ lobby: toLobby(id, fields, createdAt) });
    },

    async join(lobbyId, key, inviteToken, chosen, waitToken) {
      const joiner = await identityOf(key);
      if (!joiner) return refuse("unknown_key");
      return store.transaction<LobbyOutcome<Lobby>>(async (read) => {
        const at = now();
        const fields = (await read([lobbyPath(lobbyId)])).get(lobbyPath(lobbyId));
        if (!fields) return { result: refuse("no_such_lobby"), writes: [] };
        if (fields.kind === "private" && !(inviteToken && fields.inviteVerifier && verifierOf(inviteToken) === fields.inviteVerifier)) {
          return { result: refuse("invalid_invite"), writes: [] };
        }
        if (isExpired(fields, at)) return { result: refuse("expired"), writes: [] };
        const seats = seatsOf(lobbyId, fields);
        const seated = (colony: Colony) => seats.filter((seat) => seat.colony === colony).length;
        // A house challenge's held seat is its handle's alone; that handle may hold it beside its own
        // builder seat in a mirror game.
        const holder = fields.heldFor ? await holdsHeldSeat(read, joiner.id, fields.heldFor) : false;
        const mirror = holder && seated(HELD_COLONY) === 0;
        if (seats.some((seat) => seat.id === joiner.id) && !mirror) return { result: refuse("already_seated"), writes: [] };
        if (seats.length >= capacity(lobbyId, fields)) return { result: refuse("full"), writes: [] };
        if (fields.state !== "open") return { result: refuse("started"), writes: [] };
        if (chosen !== undefined && seated(chosen) >= Number(fields.size)) return { result: refuse("colony_full"), writes: [] };
        // Unchosen: the colony with fewer seats, colony 0 on a tie; it has a free
        // seat whenever the lobby is not full.
        const colony: Colony = chosen ?? (seated(0) <= seated(1) ? 0 : 1);
        if (fields.heldFor && colony === HELD_COLONY && !holder) return { result: refuse("seat_held"), writes: [] };
        const next = [...seats, { id: joiner.id, displayName: joiner.displayName, colony }];
        const wait: Write[] = waitToken === undefined ? [] : [waitWrite(waitToken, { kind: "lobby", lobbyId })];
        if (next.length === capacity(lobbyId, fields)) {
          const started = await start(read, lobbyId, fields, next, at);
          return { result: ok(started.lobby), writes: [...started.writes, ...wait] };
        }
        const update = { seats: JSON.stringify(next) };
        return { result: ok(toLobby(lobbyId, { ...fields, ...update }, at)), writes: [{ op: "update", path: lobbyPath(lobbyId), fields: update }, ...wait] };
      });
    },

    async revokeInvite(lobbyId, creatorKey) {
      const creator = await identityOf(creatorKey);
      if (!creator) return refuse("unknown_key");
      return store.transaction<LobbyOutcome<null>>(async (read) => {
        const found = await creatorLobby(read, lobbyId, creator.id);
        if (!found.ok) return { result: found, writes: [] };
        if (found.value.kind !== "private") return { result: refuse("not_private"), writes: [] };
        if (found.value.inviteVerifier === "") return { result: ok(null), writes: [] };
        return { result: ok(null), writes: [{ op: "update", path: lobbyPath(lobbyId), fields: { inviteVerifier: "" } }] };
      });
    },

    async issueInvite(lobbyId, creatorKey) {
      const creator = await identityOf(creatorKey);
      if (!creator) return refuse("unknown_key");
      return store.transaction<LobbyOutcome<{ readonly inviteToken: string }>>(async (read) => {
        const found = await creatorLobby(read, lobbyId, creator.id);
        if (!found.ok) return { result: found, writes: [] };
        if (found.value.kind !== "private") return { result: refuse("not_private"), writes: [] };
        const inviteToken = newToken();
        return { result: ok({ inviteToken }), writes: [{ op: "update", path: lobbyPath(lobbyId), fields: { inviteVerifier: verifierOf(inviteToken) } }] };
      });
    },

    async isInviteCurrent(lobbyId, token) {
      const fields = await store.get(lobbyPath(lobbyId));
      return !!fields && fields.kind === "private" && !!fields.inviteVerifier && verifierOf(token) === fields.inviteVerifier;
    },

    async startEarly(lobbyId, creatorKey) {
      const creator = await identityOf(creatorKey);
      if (!creator) return refuse("unknown_key");
      return store.transaction<LobbyOutcome<Lobby>>(async (read) => {
        const at = now();
        const found = await creatorLobby(read, lobbyId, creator.id);
        if (!found.ok) return { result: found, writes: [] };
        const fields = found.value;
        if (isExpired(fields, at)) return { result: refuse("expired"), writes: [] };
        if (fields.state !== "open") return { result: refuse("started"), writes: [] };
        const seats = seatsOf(lobbyId, fields);
        if (!seats.some((seat) => seat.colony === 0) || !seats.some((seat) => seat.colony === 1)) {
          return { result: refuse("colony_empty"), writes: [] };
        }
        const started = await start(read, lobbyId, fields, seats, at);
        return { result: ok(started.lobby), writes: started.writes };
      });
    },

    async releaseSlot(lobbyId) {
      return store.transaction((read) => release(read, lobbyId));
    },

    async endMatch(lobbyId, runId, outcome, thinkingLevels, serviceTiers, modelLabels, absentColonies) {
      if (!OUTCOMES.includes(outcome)) throw new Error(`invalid match outcome ${outcome}`);
      return store.transaction((read) => release(read, lobbyId, { runId, outcome, thinkingLevels, serviceTiers, modelLabels, absentColonies }));
    },

    async registerInstance(slot, instance, claim) {
      if (!SLOT.test(slot)) throw new Error(`invalid slot ${slot}`);
      return store.transaction<Registration>(async (read) => {
        const at = now();
        const docs = await read([instancePath(slot), `slots/${slot}`]);
        const existing = docs.get(instancePath(slot));
        const heardAt = Number(existing?.heardAt || existing?.heartbeatAt);
        if (claim !== undefined && existing?.runId && existing.revision === claim.revision && at - Number(existing.heartbeatAt) < claim.staleMs
          && (claim.unheardMs === undefined || at - heardAt < claim.unheardMs)) {
          const lobbyId = docs.get(`slots/${slot}`)?.lobbyId;
          const lobby = lobbyId ? (await read([lobbyPath(lobbyId)])).get(lobbyPath(lobbyId)) : null;
          if (lobby && lobby.state === "holding" && lobby.slot === slot && lobby.matchRunId === existing.runId) {
            return { result: { registered: false, ownerRunId: existing.runId }, writes: [] };
          }
        }
        const fields = { runId: instance.runId, mcpUrl: instance.mcpUrl, spectatorUrl: instance.spectatorUrl, revision: claim?.revision ?? "", heartbeatAt: String(at), heardAt: String(at) };
        return { result: { registered: true }, writes: [{ op: existing ? "update" : "create", path: instancePath(slot), fields }] };
      });
    },

    async heartbeat(slot, runId, heardAt) {
      if (!SLOT.test(slot)) return false;
      return store.transaction<boolean>(async (read) => {
        if ((await read([instancePath(slot)])).get(instancePath(slot))?.runId !== runId) return { result: false, writes: [] };
        const fields = { heartbeatAt: String(now()), ...(heardAt === undefined ? {} : { heardAt: String(heardAt) }) };
        return { result: true, writes: [{ op: "update", path: instancePath(slot), fields }] };
      });
    },

    async resolveSlot(slot) {
      return SLOT.test(slot) ? toInstance(await store.get(instancePath(slot))) : null;
    },

    async locate(lobbyId) {
      // Any caller may ask: only a lobby id is ever read, never another path.
      if (!LOBBY_ID.test(lobbyId)) return refuse("no_such_lobby");
      const read = await store.get(lobbyPath(lobbyId));
      if (!read) return refuse("no_such_lobby");
      const fields = await settledIfWaiting(lobbyId, read);
      const slot = fields.state === "holding" && fields.slot ? fields.slot : null;
      const instance = slot === null ? null : toInstance(await store.get(instancePath(slot)));
      // The match page is the lobby's own page on the site, never the slot's address, from the
      // moment the lobby holds a slot; only mcpUrl waits for the slot's server to register.
      return ok({ slot, mcpUrl: instance?.mcpUrl ?? null, spectatorUrl: slot === null ? null : lobbyPageUrl(lobbyId) });
    },

    async slotHolder(slot) {
      if (!SLOT.test(slot)) return null;
      const lobbyId = (await store.get(`slots/${slot}`))?.lobbyId;
      const fields = lobbyId ? await store.get(lobbyPath(lobbyId)) : null;
      if (!lobbyId || !fields || fields.state !== "holding" || fields.slot !== slot) return null;
      const lobby = toLobby(lobbyId, fields, now());
      return { lobbyId, mode: lobby.mode, startsAt: lobby.startsAt ?? 0, matchRunId: fields.matchRunId || null, colonies: lobby.colonies };
    },

    async beginMatch(lobbyId, slot, runId) {
      return store.transaction<LobbyOutcome<null>>(async (read) => {
        const docs = await read([instancePath(slot), `slots/${slot}`, lobbyPath(lobbyId)]);
        if (docs.get(instancePath(slot))?.runId !== runId) return { result: refuse("superseded"), writes: [] };
        const fields = docs.get(lobbyPath(lobbyId));
        if (docs.get(`slots/${slot}`)?.lobbyId !== lobbyId || !fields || fields.state !== "holding" || fields.slot !== slot) {
          return { result: refuse("not_holding"), writes: [] };
        }
        if (fields.matchRunId) return { result: refuse("started"), writes: [] };
        const writes: Write[] = [
          { op: "update", path: lobbyPath(lobbyId), fields: { matchRunId: runId } },
          // The begun match's owner is alive and reached now.
          { op: "update", path: instancePath(slot), fields: { heartbeatAt: String(now()), heardAt: String(now()) } },
        ];
        return { result: ok(null), writes };
      });
    },

    async adoptMatch(lobbyId, slot, runId, fromRunId) {
      return store.transaction<LobbyOutcome<null>>(async (read) => {
        const docs = await read([instancePath(slot), `slots/${slot}`, lobbyPath(lobbyId)]);
        if (docs.get(instancePath(slot))?.runId !== runId) return { result: refuse("superseded"), writes: [] };
        const fields = docs.get(lobbyPath(lobbyId));
        if (docs.get(`slots/${slot}`)?.lobbyId !== lobbyId || !fields || fields.state !== "holding" || fields.slot !== slot
          || !fields.matchRunId || (fields.matchRunId !== fromRunId && fields.matchRunId !== runId)) {
          return { result: refuse("stale_save"), writes: [] };
        }
        const at = String(now());
        const writes: Write[] = [
          { op: "update", path: lobbyPath(lobbyId), fields: { matchRunId: runId } },
          // The adopted match's owner is alive and reached now, as at a begin.
          { op: "update", path: instancePath(slot), fields: { heartbeatAt: at, heardAt: at } },
        ];
        return { result: ok(null), writes };
      });
    },

    readLobby,

    queuedMatchWrites,

    async joinQueue(key, mode, waitToken) {
      const joiner = await queueIdentity(key);
      if (!joiner) return refuse("unknown_key");
      return store.transaction(async (read) => {
        const at = now();
        const step = await joinQueueStep(read, joiner, mode, at, random, queuedMatchWrites);
        if (waitToken === undefined || !step.result.ok) return step;
        return { result: step.result, writes: [...step.writes, waitWrite(waitToken, { kind: "queue", identityId: joiner.id, joinedAt: String(at) })] };
      });
    },

    async waitStatus(token) {
      if (!isWaitToken(token)) return null;
      const wait = await store.get(waitPath(token));
      if (wait?.kind === "queue" && wait.identityId && wait.joinedAt) {
        return queueWait(await store.get(queueEntryPath(wait.identityId)), wait.joinedAt, now());
      }
      if (wait?.kind === "lobby" && wait.lobbyId) {
        const lobby = await readLobby(wait.lobbyId);
        return lobby.ok ? lobbyWait(lobby.value) : { state: "expired", reason: "ended" };
      }
      return null;
    },

    async queueStatus(key) {
      const identity = await queueIdentity(key);
      if (!identity) return refuse("unknown_key");
      return store.transaction((read) => queueStatusStep(read, identity.id, now()));
    },

    async leaveQueue(key) {
      const identity = await queueIdentity(key);
      if (!identity) return refuse("unknown_key");
      return store.transaction((read) => leaveQueueStep(read, identity.id, now()));
    },

    async listWaiting() {
      const entries = await waitingEntries((path) => store.get(path), now());
      const named = await Promise.all(entries.map(async ({ identityId, mode, joinedAt }) => {
        const identity = await identities.findById(identityId);
        return identity ? { displayName: identity.displayName, mode, joinedAt } : null;
      }));
      return named.filter((row): row is WaitingAgent => row !== null);
    },

    async listUnstarted() {
      const at = now();
      const slotPaths = Array.from({ length: slots.public }, (_, n) => `slots/public-${n}`);
      // One snapshot of the indexes and lobbies (writing nothing), so a slot handoff between separate reads can never drop a
      // queue pairing from both queues/public and the slots: queue-made lobbies are in no other index.
      const found = await store.transaction<{ id: string; fields: Fields | null }[]>(async (read) => {
        const indexes = await read([LISTING, "queues/public", ...slotPaths]);
        const candidates = [...new Set([
          ...ids(indexes.get(LISTING)?.lobbies), ...ids(indexes.get("queues/public")?.lobbies),
          ...slotPaths.map((path) => indexes.get(path)?.lobbyId ?? "").filter(Boolean),
        ])];
        const docs = candidates.length > 0 ? await read(candidates.map(lobbyPath)) : new Map<string, Fields | null>();
        return { result: candidates.map((id) => ({ id, fields: docs.get(lobbyPath(id)) ?? null })), writes: [] };
      });
      const unstarted: UnstartedLobby[] = [];
      for (const { id, fields } of found) {
        if (!fields || fields.kind !== "public" || isTerminal(fields, at)) continue;
        // A holding lobby's match begins when its slot's instance stamps matchRunId (beginMatch); Live now lists it then.
        if (!(fields.state === "open" || fields.state === "waiting" || (fields.state === "holding" && !fields.matchRunId))) continue;
        const lobby = toLobby(id, fields, at);
        const seated = lobby.colonies[0].length + lobby.colonies[1].length;
        if (seated === 0) continue;
        const distinct = (colony: readonly Seat[]) => colony.filter((seat, index) => colony.findIndex((other) => other.id === seat.id) === index);
        unstarted.push({ mode: lobby.mode, size: lobby.size, createdAt: lobby.createdAt, seated, colonies: [distinct(lobby.colonies[0]), distinct(lobby.colonies[1])],
          ...(lobby.challenge ? { challenge: "house" as const } : {}) });
      }
      // A seat stores the name at seating; each is shown by its identity's current display name, as listWaiting names
      // queue entries, and a seat whose identity no longer resolves is left unnamed.
      const seatIds = [...new Set(unstarted.flatMap((lobby) => [...lobby.colonies[0], ...lobby.colonies[1]].map((seat) => seat.id)))];
      const current = new Map(await Promise.all(seatIds.map(async (seatId) => [seatId, (await identities.findById(seatId))?.displayName] as const)));
      const named = (colony: readonly Seat[]) => colony.flatMap((seat) => {
        const displayName = current.get(seat.id);
        return displayName === undefined ? [] : [{ id: seat.id, displayName }];
      });
      return unstarted.map((lobby) => ({ ...lobby, colonies: [named(lobby.colonies[0]), named(lobby.colonies[1])] as const }))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async listPublic() {
      const at = now();
      const listed = ids((await store.get(LISTING))?.lobbies);
      const lobbies = await Promise.all(listed.map(async (id) => ({ id, fields: await store.get(lobbyPath(id)) })));
      return lobbies
        .filter((entry): entry is { id: string; fields: Fields } => !!entry.fields && !isTerminal(entry.fields, at))
        .map(({ id, fields }) => toLobby(id, fields, at));
    },
  };
}
