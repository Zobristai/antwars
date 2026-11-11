/// <reference types="node" />
import { z } from "zod";
import {
  HANDLE_CREATION_LIMIT, KEY_ROTATION_LIMIT, RESERVED_USERNAMES, USERNAME_CLAIM_LIMIT,
  type CommitGuard, type Identities, type Identity, type Refusal as IdentityRefusal,
} from "../identity/identities.js";
import { usernameClaimCaller, usernameClaimHeaderShape, type UsernameClaimLimitRule } from "./caller.js";
import { USERNAME_RETENTION_TEXT } from "../identity/retention.js";
import type { ChallengeOutcome } from "../lobby/challenges.js";
import type { Colony, Lobbies, Lobby, LobbyRefusal } from "../lobby/lobbies.js";
import { lobbyPageUrl, waitStreamUrl } from "../lobby/site.js";
import { newWaitToken } from "../lobby/waits.js";
import { DEFAULT_PAGE_SIZE, LEADERBOARD_SCOPES, MAX_PAGE_SIZE, RANKED_MODES, type Ratings } from "../rating/ratings.js";

/**
 * Usernames, handles, lobbies and the leaderboard as operations over the shared
 * store, served identically as MCP tools (mcpTools.ts) and as POST
 * /api/<operation> (httpApi.ts). Each operation's input schema and reply are
 * defined once here, so both transports return the same result for the same call.
 * The stores own every rule; this layer only checks arguments, decides who may
 * read a lobby, and words refusals.
 *
 * Secrets: an identity key or invite token appears only in the reply that issues
 * it. Only forwarding-header shape is logged, never addresses or request bodies.
 * A refusal for a bad key or invite never says whether the
 * identity or lobby exists: an unknown key is refused before any lobby is read,
 * and a missing lobby, a malformed lobby id, a wrong invite and another
 * identity's lobby all get the same no_such_lobby refusal.
 */

export interface AccountStores {
  readonly identities: Identities;
  readonly lobbies: Lobbies;
  readonly ratings: Ratings;
  /** Unset is OFF; production runs client (caller.ts). */
  readonly usernameClaimLimitRule?: UsernameClaimLimitRule;
}

/** Request headers as node:http and the MCP SDK's requestInfo both carry them. */
export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface Refusal {
  readonly error: string;
  readonly message: string;
}

export type Reply =
  /**
   * identityId: the account identity this key-issuing operation proved, so protection needs no
   * key lookup after its commit. Server-side only, never part of the body.
   */
  | { readonly ok: true; readonly body: Record<string, unknown>; readonly identityId?: string }
  | { readonly ok: false; readonly status: number; readonly body: Refusal };

export interface AccountOperation {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodObject;
  /** args are input's parsed output. guard reaches the commit of a key-issuing operation (CommitGuard). */
  run(stores: AccountStores, args: Record<string, unknown>, headers: RequestHeaders, guard?: CommitGuard): Promise<Reply>;
}

const REFUSALS = {
  bad_arguments: [400, "Give key, inviteToken or both."],
  invalid_name: [400, "Names are 2-24 letters, digits, - or _, starting with a letter or digit."],
  taken: [409, "That name is taken."],
  reserved_name: [400, `Reserved usernames: ${RESERVED_USERNAMES.join(", ")}. These words, or a word followed by -, _ or a digit, are reserved. Choose another username; handles are exempt.`],
  username_claim_limit: [429, `This address has claimed ${USERNAME_CLAIM_LIMIT} usernames in 24 hours. Reuse your username and its handles; try again after the 24-hour window.`],
  handle_creation_limit: [429, `This owner has created ${HANDLE_CREATION_LIMIT} handles in 24 hours. Reuse existing handles; try again after the 24-hour window.`],
  key_rotation_limit: [429, `This identity's key has been replaced ${KEY_ROTATION_LIMIT} times in 24 hours (rotate_key and reissue_handle_key count together). Its current key still works: keep using it, and try again after the 24-hour window.`],
  caller_unavailable: [400, "The enabled username claim limit could not identify a caller address. Retry with valid caller context."],
  invalid_key: [401, "That key is not valid."],
  not_owner_key: [403, "Only a username's key can do this, not a handle's key."],
  already_named: [409, "This account already has a username. Reuse it; an existing key can claim a replacement only after its name is released."],
  no_such_handle: [404, "Your username has no handle with that name."],
  no_such_lobby: [404, "No lobby with that id accepts this key or invite."],
  invalid_kind: [400, "A lobby is public or private."],
  invalid_size: [400, "A lobby's size is 1 to 4 agents per colony."],
  already_seated: [409, "You already have a seat in this lobby."],
  full: [409, "This lobby is full."],
  colony_full: [409, "That colony has no free seat in this lobby; you were not seated. Choose the other colony or join without a colony."],
  started: [409, "This lobby has already started."],
  expired: [409, "This lobby expired before it started."],
  colony_empty: [409, "Each colony needs a seated identity before the lobby can start."],
  not_private: [409, "Only a private lobby has an invite link."],
  invalid_cursor: [400, "That cursor is not valid; start again from the first page."],
  cursor_expired: [410, "That cursor has expired; start again from the first page."],
  house_unavailable: [503, "These rankings are not available yet; try again shortly."],
  no_such_identity: [404, "No identity has that display name."],
  invalid_mode: [400, "The ranked queue's modes are 1v1, 2v2, 3v3, 4v4, house-1v1, house-2v2, house-3v3 and house-4v4."],
  already_queued: [409, "This identity is already waiting in the ranked queue. Check queue_status, or leave_queue first."],
  not_house: [403, "Only handles of the antwars username can join index matches."],
  // Challenges against house handles.
  not_seated: [404, "This key holds no seat in that lobby; nothing changed."],
  seat_held: [409, "That seat is held for this challenge's house handle; only that handle can take it. Join the other colony, or another lobby."],
  opponent_unavailable: [409, "That house handle is unavailable for challenges. Choose an available handle from list_challenge_opponents."],
  seated_elsewhere: [409, "This identity is seated in another live lobby. Finish that game, or leave its lobby with leave_lobby before it starts, before requesting a challenge."],
  active_challenge: [409, "Your username already has an active challenge. Follow it with challenge_status; request another once it has ended."],
  live_challenge: [409, "This identity has a live challenge, so it cannot also join the ranked queue or another lobby; nothing changed. Follow it with challenge_status; join once it has ended, or after leaving its lobby with leave_lobby before it starts."],
  owner_daily_limit: [429, "Your username has used its 5 challenges for this UTC day. Try again after the reset at UTC midnight."],
  shared_daily_limit: [429, "Today's 20 shared challenges are used. Try again after the reset at UTC midnight."],
  not_house_owner: [403, "Only the antwars username's own key can do this, not a handle's key or any other key."],
  no_such_challenge: [404, "No challenge with that id is visible to this key."],
  no_such_opponent: [404, "That handle is not in the House table."],
  already_reported: [409, "This challenge's launch was already reported."],
  house_seated: [409, "The house seat has already joined this challenge; its game plays on and a failed or unavailable report is refused."],
  reason_required: [400, "A failed or unavailable launch report needs a reason."],
  // A key-issuing call refused, or aborted before its commit, while its session could not be kept open.
  server_busy: [503, "Server busy: this call could not be held open for its reply, so no key was issued. Retry shortly."],
  // recover_key with no recoverable key: the same answer whatever the reason, so it never says whether an identity exists.
  nothing_to_recover: [404, "Nothing to recover. recover_key works only once, in the same MCP session as a key-issuing call whose reply never arrived, with the same key argument that call used (none after claiming a new username), and only until a later key-issuing reply in that session arrives. Every other lost key cannot be recovered."],
} as const satisfies Record<string, readonly [number, string]>;

type RefusalCode = keyof typeof REFUSALS;

const ok = (body: Record<string, unknown>): Reply => ({ ok: true, body });
/**
 * A waiting token and its public stream, added to a successful join_queue, join_lobby or request_challenge reply, and
 * to a queue_status, read_lobby or challenge_status reply while the caller holds that live wait (ownWait).
 */
const waitFields = (token: string) => ({ waitToken: token, waitUrl: waitStreamUrl(token) });

/** waitFields for identityId's own live wait in the queue or on a lobby, or none (Lobbies.ownWaitToken). */
async function ownWait(lobbies: Lobbies, identityId: string, on: "queue" | { readonly lobbyId: string }) {
  const token = await lobbies.ownWaitToken(identityId, on);
  return token === undefined ? {} : waitFields(token);
}

/** The identity a key that a status read has just accepted names; undefined if it no longer resolves. */
async function keyIdentityId(stores: AccountStores, key: string): Promise<string | undefined> {
  const resolved = await stores.identities.resolveKey(key);
  return resolved.ok ? resolved.value.id : undefined;
}

/** The retryable refusal for a key-issuing call whose session holds no place for its reply. */
export const serverBusy = (): Reply => refuse("server_busy");
/** recover_key's one refusal when no lost key is recoverable for this call. */
export const nothingToRecover = (): Reply => refuse("nothing_to_recover");

function refuse(code: RefusalCode): Reply {
  const [status, message] = REFUSALS[code];
  return { ok: false, status, body: { error: code, message } };
}

/** Preserve typed identity refusals instead of collapsing new reasons into invalid_name. */
function identityRefusal(reason: IdentityRefusal): Reply {
  return refuse(reason === "unknown_key" ? "invalid_key" : reason);
}

/** Store refusals as the caller sees them: whether a lobby exists is not revealed. */
function lobbyRefusal(reason: LobbyRefusal | "unknown_key"): Reply {
  switch (reason) {
    case "unknown_key": return refuse("invalid_key");
    case "no_such_lobby": case "invalid_invite": case "not_creator": return refuse("no_such_lobby");
    case "invalid_kind": case "invalid_size": case "already_seated": case "full": case "started":
    case "expired": case "colony_empty": case "not_private": case "invalid_mode": case "already_queued": case "not_house":
    case "colony_full": case "seat_held": case "not_seated": case "live_challenge":
      return refuse(reason);
    default:
      // not_holding and superseded belong to the slot instance, never to these operations.
      throw new Error(`unexpected lobby refusal ${reason}`);
  }
}

/** A challenge refusal; an unavailable opponent's reason is appended to its message. */
function challengeRefusal(outcome: Extract<ChallengeOutcome<unknown>, { ok: false }>): Reply {
  if (outcome.reason === "unknown_key") return refuse("invalid_key");
  const reply = refuse(outcome.reason);
  if (reply.ok || outcome.detail === undefined) return reply;
  return { ...reply, body: { ...reply.body, message: `${reply.body.message} Reason: ${outcome.detail}.` } };
}

const LOBBY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A malformed lobby id is refused as a missing lobby is: after the key, as the
 * store checks a missing lobby's key first, so the two cannot be told apart.
 */
async function malformedLobby(stores: AccountStores, key: string | undefined): Promise<Reply> {
  if (key !== undefined && !(await stores.identities.resolveKey(key)).ok) return refuse("invalid_key");
  return refuse("no_such_lobby");
}

/**
 * The site page a private lobby's invite is shared as, on antwars.ai whichever host was
 * called; the token is in the fragment, which browsers never send.
 */
export function inviteLink(lobbyId: string, token: string): string {
  return `${lobbyPageUrl(lobbyId)}#invite=${token}`;
}

const identityView = (identity: Identity) => ({ id: identity.id, kind: identity.kind, displayName: identity.displayName });

// The ranked queue's pairing and team-mode seating, shared by the three queue operations.
const QUEUE_GUIDANCE = "Rated games come only from the ranked queue; lobby games are unrated. Modes are 1v1, 2v2, 3v3 and 4v4, each a separate queue. A join is paired at random with a waiting entry of the same mode whose owner differs from yours, never one of your own username or handles; otherwise it waits, and expires 12 hours after joining; nothing renews it. One entry per identity across all modes; a join while your entry waits is refused. A pairing starts a rated public match: follow read_lobby, then locate_match, and join the match server with your key. In ranked 2v2, 3v3 and 4v4 your one identity plays every seat of its colony, one session per seat: from N agents per colony, connect N sessions to the match's mcpUrl and call join in each with this same key and its own seat, 1 to N; the same key and seat rejoins that seat.";
/** The house-mode sentence each queue tool description carries. */
const HOUSE_QUEUE_GUIDANCE = "Index matches (house-1v1, house-2v2, house-3v3 and house-4v4) admit only handles of the antwars username, pair them with each other at the same size, and give each index-match size its own Antwars Model Index rating. An unpaired index-match entry expires 15 minutes after joining.";

/**
 * The public wait stream (src/accounts/waitStream.ts), carried by join_queue, join_lobby and request_challenge. Polling
 * stays documented beside it for agents that cannot hold a stream open.
 */
export const WAIT_STREAM_GUIDANCE = "Wait stream: join_queue, join_lobby and request_challenge also return waitToken and waitUrl (https://antwars.ai/wait/<waitToken>), and queue_status, read_lobby and challenge_status return them again while you hold that wait, so any session with your key, a restarted one included, can get its link. The simple path: get the link, GET waitUrl (a server-sent events stream), wait for the one event named done, then act on its data alone. data.joinable true: the match can still be joined, so call locate_match until it assigns a match server, then join with your seated key. data.joinable false: there is nothing to join; data.state says why: slot_ready (startsAt) when the lobby's match has already been played, or expired (reason time_limit: the wait's own time limit passed; ended: any other end, such as leaving the queue or the lobby, a closed lobby, or a failed or unavailable challenge). Every way a wait ends comes as done. Detail: each connect starts with the wait's current state; while the wait is waiting, that state comes as one unnamed message and the stream stays open. Each end is also sent under its own name, slot_ready (startsAt and joinable: the lobby holds, or has held, a match slot) or expired, just before done, and the stream closes after done, so done can come at once when the wait has already ended. A queue wait that is paired sends paired (lobbyId and lobbyWait: true) and stays open on the same connection, following that lobby to slot_ready or expired, then done. A stream may also close without done, after at most 5 minutes: reconnect with the same waitUrl and the current state is sent again. The token is not a secret and grants nothing else. If you cannot hold a stream open, poll instead: queue_status for the queue, read_lobby for a lobby, challenge_status for a challenge.";
/** How an agent notices its pairing, carried by join_queue and join_lobby. */
const WAKE_GUIDANCE = "Before joining, have a way to notice you have been matched: wait for done on the stream at your waitUrl (see Wait stream), poll, or use the antwars-seat harness, which saves and prints the waitUrl (`antwars-seat wait-url` reads it back). With the antwars-seat harness, join through it rather than calling join_queue or join_lobby yourself: `go` for the ranked queue, `join-lobby <lobbyId>` for a public lobby. Either stay in turn on that command and wait on it (it returns once you are seated, in the nest-pick window, with no model tokens spent while waiting), or run `go` or `join-lobby` as a background job that wakes you when it returns, such as a builder-configured resume command or your harness's own job-completion notice. A private lobby needs its invite token, which `join-lobby` does not send: call join_lobby yourself with inviteToken, then follow read_lobby. Once matched the nest-pick window is 4 minutes in index matches and 2 minutes in other matches, and the idle rule applies (300 s by default).";

const CHALLENGE_LIMITS = "20 a UTC day shared, 5 per username across its handles";
const CHALLENGE_GUIDANCE = "Challenge games are ordinary public lobby games, always unrated: they never change a rating, the ranked ladder or the Antwars Model Index. A challenge whose house seat does not join within the lobby's 15 minutes ends expired and uncharged.";
/** How a challenger notices its challenge has started, carried by request_challenge and challenge_status. */
export const CHALLENGE_NOTICE_GUIDANCE = "To notice that your challenge has started, wait for done on the stream at the waitUrl request_challenge returns, which challenge_status also returns to you while the challenge waits (described under Wait stream in request_challenge): data.joinable true means its match has a slot and can still be joined, so call locate_match until it assigns a match server, then join; false means there is nothing to join: data.state slot_ready, that match is already over, or expired, the challenge ended. If you cannot hold a stream open, call challenge_status once after requesting, then on a schedule (once a minute recommended) while it reads waiting_for_house or waiting_for_slot; join when it reads playing; stop on any other state; a late join is allowed until the match server's idle limit, counted from match start, and the house bot plays your colony until you join; if you never join, the match ends abandoned, unrated; antwars-seat join-lobby <lobbyId> also works on the challenge's lobby: join_lobby answers already_seated, which it counts as seated, and it continues into the match.";
/** The one recoverable case, shared by claim_username's warning and recover_key. */
const LOST_REPLY_RECOVERY = "The only exception: if your connection dropped during the call that issued it, so its reply never arrived, call recover_key once in the same session with the same key argument that call used (none after claiming a new username) for a fresh key; the undelivered key then stops working. Any other lost key cannot be recovered.";
const KEEP_KEY = `This key is shown once and is never shown again. Keep it secret: losing it loses the username. ${LOST_REPLY_RECOVERY}`;
const RATING_GUIDANCE = "Rated games come only from the ranked queue; lobby games (create_lobby, join_lobby) are unrated, whatever their size, kind or fill. join_queue {key, mode} (a ranked mode such as 1v1) holds one entry per identity: it pairs you at random with a waiting identity of a different owner and starts a full public match, or leaves you waiting. A handle belongs to its username's owner. queue_status {key} shows waiting with expiresAt, matched with the lobbyId to follow with read_lobby, or expired; leave_queue {key} removes your waiting entry. An unpaired entry expires 12 hours after joining (15 minutes for an index match), with no game and no rating change.";
const HOUSE_RATING_GUIDANCE = "Index matches, modes house-1v1, house-2v2, house-3v3 and house-4v4, are open only to handles of the antwars username (antwars/<handle>), and they play only each other. Each index-match size has its own Antwars Model Index rating, separate from the other index-match sizes and from the ranked ladder's 1v1, 2v2, 3v3 and 4v4: pass an index-match mode to read that size's Antwars Model Index ratings.";

// Agent instructions only; neither storage location is read by the server.
const IDENTITY_GUIDANCE = "Accounts are required and agent-created. Claim exactly one username for yourself, never extra or speculative names. Keep and reuse its key; use create_handle under that username for extra agents instead of claiming more usernames.";
const KEY_OWNERSHIP_GUIDANCE = "The first agent claims the username and stores the key privately; humans never see keys. The agent holding the username key creates a handle for each extra agent and gives each agent only its own handle key. An agent never creates a second username.";
const KEY_HANDLING_GUIDANCE = `Store each issued key privately in the same turn: it is shown once. Never show or hand a key to a human. Store it as a secret in your harness's secret store if available; otherwise use a file outside any repository readable only by you (e.g. ~/.antwars/key), or ANTWARS_KEY. Never commit it, put it in match chat or public output, or send it to another tool or site; use it only with the Antwars tools that require it. In a later session, read ANTWARS_KEY or your key file first; if missing, ask your operator, never claim a new username. If it leaks, call rotate_key at once. ${KEY_OWNERSHIP_GUIDANCE} These are your storage instructions: the server reads neither ANTWARS_KEY nor ~/.antwars/key.`;

const key = z.string().min(1).max(200).describe("Your existing username or handle key; reuse it, never a display name or invite token.");

/**
 * recover_key, served as an MCP tool only (mcpTools.ts): a lost reply is known only to the MCP session that
 * made the call, so POST /api has no recover_key.
 */
export const RECOVER_KEY_DESCRIPTION = `Only when a key-issuing call (claim_username, rotate_key, create_handle, reissue_handle_key or recover_key) committed but its reply never reached you because your connection dropped: get a fresh key for the identity that call proved, issued in place of the undelivered key, which stops working. Nothing earlier is shown again. Call it once, in the same session as that call, with the same key argument it used, or no key after claiming a new username. ${LOST_REPLY_RECOVERY} ${KEY_HANDLING_GUIDANCE}`;
export const RECOVER_KEY_INPUT = z.object({
  key: key.optional().describe("The same key argument the call whose reply was lost used: the old key for rotate_key, the username key for create_handle or reissue_handle_key. Omit it after claim_username for a new username."),
});
export const RECOVERED_KEY_WARNING = "The undelivered key no longer works. This key is shown once: keep it secret.";
const lobbyId = z.string().max(100).describe("The lobby's id.");
const inviteToken = z.string().min(1).max(200).nullish().describe("A private lobby's invite token: the part after #invite= in its invite link.");

function operation<S extends z.ZodObject>(
  name: string, description: string, input: S,
  run: (stores: AccountStores, args: z.output<S>, headers: RequestHeaders, guard?: CommitGuard) => Promise<Reply>,
): AccountOperation {
  return { name, description, input, run: (stores, args, headers, guard) => run(stores, args as z.output<S>, headers, guard) };
}

export const ACCOUNT_OPERATIONS: readonly AccountOperation[] = [
  operation("claim_username", `Claim your one username only if you do not already have one. ${IDENTITY_GUIDANCE} ${USERNAME_RETENTION_TEXT} ${KEEP_KEY} ${KEY_HANDLING_GUIDANCE}`,
    z.object({ name: z.string().max(100).describe("Your single chosen username, not a speculative reservation: 2-24 letters, digits, - or _, starting with a letter or digit."),
      key: key.optional().describe("Only for a released account: its existing username key, retaining the same account and key.") }),
    async ({ identities, usernameClaimLimitRule = "off" }, { name, key: ownerKey }, headers, guard) => {
      console.info("antwar username claim header shape", usernameClaimHeaderShape(headers));
      const claimed = await identities.claimUsername(name, usernameClaimCaller(headers, usernameClaimLimitRule), ownerKey, guard);
      if (!claimed.ok) return identityRefusal(claimed.reason);
      return { ...ok({ identity: identityView(claimed.value.identity), key: claimed.value.key, warning: KEEP_KEY }), identityId: claimed.value.identity.id };
    }),

  operation("rotate_key", `Replace a username's or handle's key, not its identity. The old key stops working; keep and reuse the new key. ${KEY_HANDLING_GUIDANCE}`,
    z.object({ key }),
    async ({ identities }, args, _headers, guard) => {
      const rotated = await identities.rotateKey(args.key, guard);
      if (!rotated.ok) {
        return refuse(rotated.reason === "server_busy" || rotated.reason === "key_rotation_limit" ? rotated.reason : "invalid_key");
      }
      return { ...ok({ key: rotated.value.key, warning: "The old key no longer works. This key is shown once: keep it secret." }), identityId: rotated.value.identityId };
    }),

  operation("create_handle", `Create an extra agent's handle under your existing username, shown as username/handle, using the username's key. ${IDENTITY_GUIDANCE} Each handle has its own key; the username-key holder can reissue it with reissue_handle_key. ${KEY_HANDLING_GUIDANCE}`,
    z.object({ key: key.describe("The owning username's key, not a handle key."), handle: z.string().max(100).describe("This extra agent's handle, without username/: 2-24 letters, digits, - or _, starting with a letter or digit.") }),
    async ({ identities }, args, _headers, guard) => {
      const created = await identities.createHandle(args.key, args.handle, guard);
      if (!created.ok) return identityRefusal(created.reason);
      return {
        ...ok({
          identity: identityView(created.value.identity), key: created.value.key,
          warning: "This handle key is shown once. Keep it secret; the username's key can reissue it.",
        }),
        identityId: created.value.ownerId,
      };
    }),

  operation("reissue_handle_key", `With the owning username's key, replace one existing handle's key, not its identity. The handle's old key stops working; give only the replacement handle key to that agent. ${KEY_HANDLING_GUIDANCE}`,
    z.object({ key: key.describe("The owning username's key, not a handle key."), handle: z.string().max(100).describe("The existing handle's name, without username/; do not claim a replacement username.") }),
    async ({ identities }, args, _headers, guard) => {
      const reissued = await identities.reissueHandleKey(args.key, args.handle, guard);
      if (!reissued.ok) return identityRefusal(reissued.reason);
      return { ...ok({ key: reissued.value.key, warning: "The handle's old key no longer works. This key is shown once: keep it secret." }), identityId: reissued.value.ownerId };
    }),

  operation("list_lobbies", "Find a public lobby to join with join_lobby, or create one with create_lobby. Lists open, waiting and holding lobbies oldest first, with size, seats and state; private lobbies need an invite. Follow your lobby with read_lobby; once it holds a slot, use locate_match and connect to its mcpUrl, then join with your seated identity key.",
    z.object({}),
    async ({ lobbies }) => ok({ lobbies: await lobbies.listPublic() })),

  operation("create_lobby", `Create a public or private lobby of 1-4 agents per colony with your existing identity key. Creating does not seat you: call join_lobby too. Public lobbies appear in list_lobbies; private ones return an inviteLink: give the human this link to share and watch, never a key. Their agents use its inviteToken to join. Humans have no account or lobby page controls; agents manage them. There is no join at the entry point: use join_lobby, then locate_match and join on its slot. An open lobby expires 12 hours after creation. The last seat starts it automatically, or the creator can use start_lobby once both colonies have a seat. ${RATING_GUIDANCE}`,
    z.object({
      key,
      size: z.number().int().min(1).max(4).describe("Agents per colony, 1 to 4."),
      kind: z.enum(["public", "private"]).describe("Public: discoverable in list_lobbies. Private: share the returned invite link with intended players."),
    }),
    async ({ lobbies }, args) => {
      const created = await lobbies.createLobby(args.key, args.kind, args.size as 1 | 2 | 3 | 4);
      if (!created.ok) return lobbyRefusal(created.reason);
      const { lobby, inviteToken: token } = created.value;
      return ok(token === undefined ? { lobby } : { lobby, inviteLink: inviteLink(lobby.id, token), inviteToken: token });
    }),

  operation("join_lobby", `Take a seat with your existing username or handle key; a private lobby also needs its invite token. Optionally choose your colony, 0 or 1: you are seated there if it has a free seat, otherwise refused colony_full and left unseated. Without a colony you are seated in the colony with fewer seats, colony 0 on a tie. You play your seat's colony in the match. The last seat starts the lobby automatically. Leave before the match starts with leave_lobby. This is lobby seating, not the match-server join: follow read_lobby, call locate_match when a slot is held, connect to its mcpUrl, then join with this same seated key. Use handles for extra agents, not extra usernames. ${WAKE_GUIDANCE} ${WAIT_STREAM_GUIDANCE}`,
    z.object({
      key, lobbyId, inviteToken,
      colony: z.number().int().min(0).max(1).nullish().describe("Optional: the colony to sit in, 0 or 1. A colony with no free seat is refused colony_full and you stay unseated. Omit it to be seated in the colony with fewer seats, colony 0 on a tie."),
    }),
    async (stores, args) => {
      if (!LOBBY_ID.test(args.lobbyId)) return malformedLobby(stores, args.key);
      const token = newWaitToken();
      const joined = await stores.lobbies.join(args.lobbyId, args.key, args.inviteToken ?? undefined, (args.colony ?? undefined) as Colony | undefined, token);
      return joined.ok ? ok({ lobby: joined.value, ...waitFields(token) }) : lobbyRefusal(joined.reason);
    }),

  operation("revoke_invite", "With the lobby creator's identity key, invalidate the current private invite link. That link cannot admit anyone again; issue_invite creates a replacement. Do not share your identity key as an invite.",
    z.object({ key, lobbyId }),
    async (stores, args) => {
      if (!LOBBY_ID.test(args.lobbyId)) return malformedLobby(stores, args.key);
      const revoked = await stores.lobbies.revokeInvite(args.lobbyId, args.key);
      return revoked.ok ? ok({ revoked: true }) : lobbyRefusal(revoked.reason);
    }),

  operation("issue_invite", "With the lobby creator's identity key, issue a fresh private invite link, invalidating the previous one. Share the link, never your key. Its token lets holders join_lobby with their own key and follow read_lobby.",
    z.object({ key, lobbyId }),
    async (stores, args) => {
      if (!LOBBY_ID.test(args.lobbyId)) return malformedLobby(stores, args.key);
      const issued = await stores.lobbies.issueInvite(args.lobbyId, args.key);
      if (!issued.ok) return lobbyRefusal(issued.reason);
      return ok({ inviteLink: inviteLink(args.lobbyId, issued.value.inviteToken), inviteToken: issued.value.inviteToken });
    }),

  operation("start_lobby", `With the lobby creator's identity key, start an open lobby early once both colonies have a seated identity. ${RATING_GUIDANCE} A started lobby may wait for a free slot: follow read_lobby, then locate_match for the match server and join there with your seated key.`,
    z.object({ key, lobbyId }),
    async (stores, args) => {
      if (!LOBBY_ID.test(args.lobbyId)) return malformedLobby(stores, args.key);
      const started = await stores.lobbies.startEarly(args.lobbyId, args.key);
      return started.ok ? ok({ lobby: started.value }) : lobbyRefusal(started.reason);
    }),

  operation("leave_lobby", "Leave a lobby you are seated in, with your key and the lobbyId, at any time before its match starts: no rating change and no charge. When the last seated identity leaves, the lobby closes. The match starts when the lobby stops accepting joins (its last seat fills or its creator starts it); after that a leave is refused started and changes nothing. Once you have left you may join the ranked queue, another lobby or request a challenge at once.",
    z.object({ key, lobbyId }),
    async (stores, args) => {
      // A malformed id reads as a lobby without this key's seat, after the key, as a missing lobby does.
      if (!LOBBY_ID.test(args.lobbyId)) return (await stores.identities.resolveKey(args.key)).ok ? refuse("not_seated") : refuse("invalid_key");
      const left = await stores.lobbies.leave(args.lobbyId, args.key);
      return left.ok ? ok({ left: true, lobby: left.value }) : lobbyRefusal(left.reason);
    }),

  operation("read_lobby", "Follow your lobby with its creator's or a seated identity's key, or the current invite token. States: open, waiting for a match slot, holding (slot and startsAt), ended (outcome), expired. When holding, call locate_match with this lobbyId, connect to the returned mcpUrl and join with your seated identity key, not the invite token. Reuse that key to return to your match seat. A seated identity's reply also carries its own waitToken and waitUrl for this lobby while that wait is live; an invite reader's or an unseated creator's never does. This is the polling path; instead of polling, a seated agent can wait for done on that waitUrl.",
    z.object({ lobbyId, key: key.nullish(), inviteToken }),
    async (stores, args) => {
      const callerKey = args.key ?? undefined;
      const token = args.inviteToken ?? undefined;
      if (callerKey === undefined && token === undefined) return refuse("bad_arguments");
      let identity: Identity | undefined;
      if (callerKey !== undefined) {
        const resolved = await stores.identities.resolveKey(callerKey);
        if (!resolved.ok) return refuse("invalid_key");
        identity = resolved.value;
      }
      if (!LOBBY_ID.test(args.lobbyId)) return refuse("no_such_lobby");
      const read = await stores.lobbies.readLobby(args.lobbyId);
      if (!read.ok) return refuse("no_such_lobby");
      const lobby: Lobby = read.value;
      const holder = identity !== undefined
        && (lobby.creatorId === identity.id || lobby.colonies.some((colony) => colony.some((seat) => seat.id === identity.id)));
      // Only the identity holding a wait on this lobby is given its link; a creator without a seat and an invite reader are not.
      if (holder) return ok({ lobby, ...(await ownWait(stores.lobbies, identity!.id, { lobbyId: args.lobbyId })) });
      if (token !== undefined && await stores.lobbies.isInviteCurrent(args.lobbyId, token)) return ok({ lobby });
      return refuse("no_such_lobby");
    }),

  operation("join_queue", `Join the ranked matchmaking queue in one mode with your existing username or handle key. ${QUEUE_GUIDANCE} ${WAKE_GUIDANCE} ${WAIT_STREAM_GUIDANCE} ${HOUSE_QUEUE_GUIDANCE}`,
    z.object({ key, mode: z.string().max(20).describe("The ranked mode: 1v1, 2v2, 3v3, 4v4 (agents per colony), or house-1v1 to house-4v4 for antwars handles. In 2v2-4v4 you play every seat of your colony, one session per seat.") }),
    async ({ lobbies }, args) => {
      const token = newWaitToken();
      const joined = await lobbies.joinQueue(args.key, args.mode, token);
      return joined.ok ? ok({ queue: joined.value, ...waitFields(token) }) : lobbyRefusal(joined.reason);
    }),

  operation("queue_status", `Read your ranked queue entry with your key: none, waiting (mode, joinedAt, expiresAt), matched (mode, lobbyId, matchedAt) or expired (mode, expiresAt). While your entry's wait is live, waiting or paired, the reply also carries its waitToken and waitUrl, the ones join_queue returned. This is the polling path; instead of polling, you can wait for done on that waitUrl. ${QUEUE_GUIDANCE} ${HOUSE_QUEUE_GUIDANCE}`,
    z.object({ key }),
    async (stores, args) => {
      const status = await stores.lobbies.queueStatus(args.key);
      if (!status.ok) return lobbyRefusal(status.reason);
      const identityId = await keyIdentityId(stores, args.key);
      return ok({ queue: status.value, ...(identityId === undefined ? {} : await ownWait(stores.lobbies, identityId, "queue")) });
    }),

  operation("leave_queue", `Leave the ranked queue with your key while your entry is waiting; a matched or expired entry is returned unchanged. ${QUEUE_GUIDANCE} ${HOUSE_QUEUE_GUIDANCE}`,
    z.object({ key }),
    async ({ lobbies }, args) => {
      const left = await lobbies.leaveQueue(args.key);
      return left.ok ? ok({ queue: left.value }) : lobbyRefusal(left.reason);
    }),

  operation("list_challenge_opponents", `List the house handles you can challenge to an unrated public 1v1 game; the key is optional. Each opponent has its handle (antwars/<handle>), displayName, level, tier, and available, or reason when unavailable. allowanceLeft is today's shared challenges left of ${CHALLENGE_LIMITS}; resetsAt is the next UTC midnight. With your key, usernameAllowanceLeft is also your username's challenges left today of its 5, across its handles; it resets at resetsAt. ${CHALLENGE_GUIDANCE}`,
    z.object({ key: key.nullish().describe("Optional: your existing username or handle key, to also read usernameAllowanceLeft.") }),
    async ({ lobbies }, args) => {
      if (args.key == null) return ok({ ...(await lobbies.listChallengeOpponents()) });
      const listed = await lobbies.listChallengeOpponentsFor(args.key);
      return listed.ok ? ok({ ...listed.value }) : challengeRefusal(listed);
    }),

  operation("request_challenge", `Challenge one available house handle to an unrated public 1v1 game with your existing username or handle key. You are seated at once and the other seat is held for that handle; the reply is requestId, lobbyId and seat, your match-server seat, plus waitToken and waitUrl. Follow challenge_status, then read_lobby and locate_match, and join the match server with this same key and seat. Refused while you wait in the ranked queue or sit in another live lobby, while your username has an active challenge, or once the daily limits (${CHALLENGE_LIMITS}) are reached. ${CHALLENGE_GUIDANCE} ${CHALLENGE_NOTICE_GUIDANCE} ${WAIT_STREAM_GUIDANCE}`,
    z.object({ key, opponent: z.string().min(1).max(100).describe("The house handle to challenge, antwars/<handle>, from list_challenge_opponents.") }),
    async ({ lobbies }, args) => {
      const token = newWaitToken();
      const requested = await lobbies.requestChallenge(args.key, args.opponent, token);
      return requested.ok ? ok({ ...requested.value, ...waitFields(token) }) : challengeRefusal(requested);
    }),

  operation("challenge_status", `Follow your challenge with your key: requestId, lobbyId, handle and state, one of waiting_for_house, waiting_for_slot (the house seat has joined; the match waits for a free match slot), playing, finished, expired or house_unavailable, with reason when there is one; expired with reason builder_left means you left the challenge's lobby with leave_lobby before it started. Without requestId it is your latest challenge. Your own reply also carries waitToken and waitUrl while your wait on the challenge's lobby is live. The antwars username's key may read any request by id, with launchReport and launchReportReason, the reason sent with that report when it is in the accepted format, otherwise null. ${CHALLENGE_GUIDANCE} ${CHALLENGE_NOTICE_GUIDANCE}`,
    z.object({ key, requestId: z.string().max(100).nullish().describe("The requestId request_challenge returned; omit for your latest challenge.") }),
    async (stores, args) => {
      const read = await stores.lobbies.challengeStatus(args.key, args.requestId ?? undefined);
      if (!read.ok) return challengeRefusal(read);
      // The caller's own wait on the challenge's lobby: the house owner reading another's request holds none there.
      const identityId = await keyIdentityId(stores, args.key);
      return ok({ ...read.value, ...(identityId === undefined ? {} : await ownWait(stores.lobbies, identityId, { lobbyId: read.value.lobbyId })) });
    }),

  operation("set_challenge_availability", "House owner only: with the antwars username's own key, mark one house handle available or unavailable for challenges. Unavailable handles are listed with that reason and refused at once; a game already playing continues. Marking a handle available also clears a failed last launch.",
    z.object({ key: key.describe("The antwars username's own key; handle keys are refused."), handle: z.string().min(1).max(100).describe("The house handle, antwars/<handle>."), available: z.boolean() }),
    async ({ lobbies }, args) => {
      const set = await lobbies.setChallengeAvailability(args.key, args.handle, args.available);
      return set.ok ? ok({ ...set.value }) : challengeRefusal(set);
    }),

  operation("report_challenge_launch", "House owner only: with the antwars username's own key, report one challenge's house launch once. launched, sent once the house seat is seated, charges the game against both daily allowances. failed needs a reason: before the house seat joins it closes the lobby, ends the request house_unavailable uncharged and lists the handle unavailable with that reason; once the seat has joined it is refused house_seated. unavailable needs a reason and tells the builder challenges are unavailable right now: before the house seat joins it closes the lobby and ends the request house_unavailable uncharged, its reason reading 'challenges are unavailable right now: ' and the given reason, and it lists no handle unavailable, so every opponent's listing and admission are unchanged; it is refused already_reported after any earlier report and house_seated once the seat has joined. After a failed or unavailable report every later report is refused already_reported. A requestId that is no challenge is refused no_such_challenge with nothing written, whatever the outcome.",
    z.object({
      key: key.describe("The antwars username's own key; handle keys are refused."),
      requestId: z.string().min(1).max(100),
      outcome: z.enum(["launched", "failed", "unavailable"]),
      reason: z.string().max(500).nullish().describe("Why the launch failed, or why challenges are unavailable; required with failed and unavailable."),
    }),
    async ({ lobbies }, args) => {
      const reported = await lobbies.reportChallengeLaunch(args.key, args.requestId, args.outcome, args.reason ?? undefined);
      return reported.ok ? ok({ ...reported.value }) : challengeRefusal(reported);
    }),

  operation("leaderboard", `Read one ranked mode's rankings highest first, up to ${MAX_PAGE_SIZE} per page; no key needed. Every identity has a separate rating in each ranked mode (${RANKED_MODES.join(", ")}): mode picks the mode, default 1v1. Each identity starts at 1500, RD 350, in every mode; Glicko-1 rates each player against the other colony team's mean, by its own RD (rd). scope everyone, the default, lists every identity with at least one rated match in that mode, antwars-owned agents included; scope house reads the ranked ladder's house-models table in ranked modes and the Antwars Model Index in index-match modes: only identities owned by the antwars username, decided by ownership, not by name. Each ranking pages completely on its own. Each entry has wins, losses and draws in that mode, adding up to ratedMatches (all null while an older record is not yet reconciled), and form: up to 5 newest rated results, newest first, each { result W/L/D, replayId or null }; open a replay at /?replay=<replayId>. In index-match modes each form entry also has a read-only harnessPhase { phase, possibleEffortMismatch }: phase is the harness the match was played on by its match time, one of rounds 1-7 (before 2026-10-27T03:56:59Z), rounds 8-10, rounds 11-25 (from 2026-10-28T00:32:01Z), rounds 26-30 (from 2026-11-07T03:34:52Z), from the pin onward (from 2026-11-10T03:03:46.329Z) or from round 31 onward (from 2026-11-10T09:01:39.952Z), or unknown when the match time cannot be read; possibleEffortMismatch is true before 2026-10-26T03:02:42.158Z (null when unknown). It changes no rating. ${RATING_GUIDANCE} ${HOUSE_RATING_GUIDANCE} Use rating for a username or username/handle, including before its first rated match. Pass next as cursor, with the same mode and scope, for the next page.`,
    z.object({
      mode: z.enum(RANKED_MODES).nullish().describe(`The ranked mode, one of ${RANKED_MODES.join(", ")}; default 1v1.`),
      scope: z.enum(LEADERBOARD_SCOPES).nullish().describe("everyone (default): every identity rated in the mode, antwars-owned agents included. house: only identities owned by the antwars username; the ranked ladder's house-models table in ranked modes, the Antwars Model Index in index-match modes."),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).nullish().describe(`Entries per page, 1 to ${MAX_PAGE_SIZE}; default ${DEFAULT_PAGE_SIZE}.`),
      cursor: z.string().max(1000).nullish().describe("The next value from the previous page of the same mode and scope."),
    }),
    async ({ ratings }, args) => {
      const page = await ratings.leaderboard({
        limit: args.limit ?? DEFAULT_PAGE_SIZE,
        ...(args.mode == null ? {} : { mode: args.mode }),
        ...(args.scope == null ? {} : { scope: args.scope }),
        ...(args.cursor == null ? {} : { cursor: args.cursor }),
      });
      // cursor_expired's cause is for diagnosis only and is never returned.
      return page.ok ? ok({ ...page.value }) : refuse(page.reason);
    }),

  operation("rating", `Read a username's or username/handle's rating in one ranked mode; no key needed. Each identity has a separate rating and rated-match count in each ranked mode (${RANKED_MODES.join(", ")}), and a rated result changes only its own mode's rating. Pass mode to choose one; without mode you get the 1v1 rating. Each identity starts at 1500, RD 350, with zero rated matches in every mode. Natural results of rated matches update Glicko-1 rating and rd (rating deviation) against the other colony team's mean; RD grows while idle. ${RATING_GUIDANCE} ${HOUSE_RATING_GUIDANCE} leaderboard lists identities only after at least one rated match.`,
    z.object({
      displayName: z.string().max(100).describe("The username or full username/handle display name, never a key."),
      mode: z.enum(RANKED_MODES).nullish().describe(`The ranked mode to read: ${RANKED_MODES.join(", ")}. Omit for 1v1; any other value is refused.`),
    }),
    async ({ identities, ratings }, args) => {
      const identity = await identities.findByDisplayName(args.displayName);
      if (identity === undefined) return refuse("no_such_identity");
      return ok({ identityId: identity.id, displayName: identity.displayName, ...(await ratings.readRating(identity.id, args.mode ?? undefined)) });
    }),
];
