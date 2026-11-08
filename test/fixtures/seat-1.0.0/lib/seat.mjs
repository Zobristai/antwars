// `go`: take a seat from start to joined inside the open nest window. `join-lobby`
// enters an unrated lobby instead of the queue and shares go's locate/join tail.
//   baseline queue_status -> join_queue at most once (queuing seat only, never
//   while waiting or matched to a live lobby) -> wait for a real pairing ->
//   locate_match -> join with labels -> wait for the nest window, then stop and
//   report its closesAt and box. The harness never picks the nest: the seat's
//   agent chooses a tile and sends pick_nest itself.
// Round-7 lessons: matchedAt is a number (never Date.parse); there is no short
// fixed exit while waiting; a second join_queue is never sent.
import { errorCode } from "./mcp.mjs";
import { entryClient, joinSeat, matchClient } from "./match.mjs";
import { envNumber, progress, readSeat, statePath, updateSeat, writeJson } from "./state.mjs";

const ENDED = new Set(["ended", "expired"]);
export const DEFAULT_POLL_MS = 3000;
/** Longer than the server's 15-minute queue expiry: the server, not the harness, ends an unpaired wait. */
export const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000;
/** What the agent does after go or join-lobby stops in the nest window. */
export const NEST_NEXT = "choose a tile inside box and send it before closesAt: antwars-seat pick_nest --json '{\"tileX\":X,\"tileY\":Y}'";

async function tool(client, name, args) {
  const reply = await client.callTool(name, args);
  if (!reply.ok) {
    const error = new Error(`${name} refused: ${errorCode(reply.data)}${reply.data?.message ? ` (${reply.data.message})` : reply.data?.error?.message ? ` (${reply.data.error.message})` : ""}`);
    error.code = errorCode(reply.data);
    error.data = reply.data;
    throw error;
  }
  return reply.data;
}

/** The lobby state read_lobby returns, or null when it is unknown: a refusal or transport error is transient, never "gone". */
async function lobbyState(entry, key, lobbyId, env) {
  try {
    const reply = await entry.callTool("read_lobby", { lobbyId, key });
    if (reply.ok && typeof reply.data?.lobby?.state === "string") return reply.data.lobby.state;
    progress("lobby_read_failed", { lobbyId, error: reply.ok ? "no_state" : errorCode(reply.data) }, env);
  } catch (error) {
    progress("lobby_read_failed", { lobbyId, error: error instanceof Error ? error.message : String(error) }, env);
  }
  return null;
}

/** The handle already has another run's queue entry or live match: go stops and calls nothing else. */
function handleInUse(detail) {
  const error = new Error(`handle in use: ${detail}`);
  error.code = "handle_in_use";
  return error;
}

/**
 * Wait for this seat's pairing. Returns { lobbyId, matchedAt }.
 * Queuing seat: joins at most once. Non-queuing seat: never joins; waits for its handle's pairing.
 */
export async function awaitPairing({ entry, ctx, pollMs, maxWaitMs }) {
  const { key, config, clock, env } = ctx;
  const queuing = config.queuing === true;
  // Opt-in (setup --parallel): several runs of one handle may each hold a live match.
  const parallel = queuing && config.parallel === true;
  const seat = readSeat(env);
  const readyAt = Number(seat.readyAt);
  const ownJoinedAt = Number.isFinite(seat.ownJoinedAt) ? seat.ownJoinedAt : null;
  const ignored = new Set();
  let ownJoinAt = null;
  let joinedQueue = false;

  const accept = async (status) => {
    if (status?.state !== "matched" || ignored.has(status.lobbyId)) return null;
    const matchedAt = Number(status.matchedAt);
    if (!queuing && !(matchedAt >= readyAt)) {
      // A non-queuing seat takes only a pairing matched no earlier than its ready time.
      const state = await lobbyState(entry, key, status.lobbyId, env);
      if (state === null || !ENDED.has(state)) throw handleInUse(`lobby ${status.lobbyId} matched at ${status.matchedAt}, before this seat was ready (${readyAt}), is ${state ?? "not readable"}`);
      ignored.add(status.lobbyId);
      progress("stale_pairing_ignored", { lobbyId: status.lobbyId, matchedAt, lobbyState: state }, env);
      return null;
    }
    if (queuing && ownJoinAt !== null && Number.isFinite(matchedAt) && matchedAt < ownJoinAt) {
      ignored.add(status.lobbyId);
      progress("stale_pairing_ignored", { lobbyId: status.lobbyId, matchedAt, reason: "matched before own join" }, env);
      return null;
    }
    const state = await lobbyState(entry, key, status.lobbyId, env);
    if (state === null) return null; // Unknown: check this lobby again on the next poll.
    if (ENDED.has(state)) {
      ignored.add(status.lobbyId);
      progress("stale_pairing_ignored", { lobbyId: status.lobbyId, matchedAt, lobbyState: state }, env);
      return null;
    }
    return { lobbyId: status.lobbyId, matchedAt, lobbyState: state };
  };

  const baseline = (await tool(entry, "queue_status", { key })).queue;
  progress("baseline", { queue: baseline }, env);
  let pairing = null;
  if (!queuing) {
    pairing = await accept(baseline);
    if (pairing) return pairing;
  } else if (baseline?.state === "waiting") {
    // Only an entry this seat created itself (its own earlier join_queue) is adopted.
    if (ownJoinedAt === null || Number(baseline.joinedAt) !== ownJoinedAt) throw handleInUse(`queue entry waiting since ${baseline.joinedAt} was not created by this seat`);
    ownJoinAt = ownJoinedAt;
  } else if (baseline?.state === "matched") {
    if (ownJoinedAt !== null && Number(baseline.matchedAt) >= ownJoinedAt) {
      // This seat's own pairing: joined as before; an unreadable lobby is checked again.
      ownJoinAt = ownJoinedAt;
      pairing = await accept(baseline);
      if (pairing) return pairing;
    } else {
      const state = await lobbyState(entry, key, baseline.lobbyId, env);
      if (parallel && state !== null && !ENDED.has(state)) {
        // Opt-in: another run's live match is not this seat's; ignore it and queue fresh.
        ignored.add(baseline.lobbyId);
        progress("other_run_pairing_ignored", { lobbyId: baseline.lobbyId, matchedAt: Number(baseline.matchedAt), lobbyState: state }, env);
      } else {
        if (state === null || !ENDED.has(state)) throw handleInUse(`queue entry matched to lobby ${baseline.lobbyId}, which is ${state ?? "not readable"}, was not paired for this seat`);
        ignored.add(baseline.lobbyId);
        progress("stale_pairing_ignored", { lobbyId: baseline.lobbyId, matchedAt: Number(baseline.matchedAt), lobbyState: state }, env);
      }
    }
  }

  // This seat's own matched baseline whose lobby state is unknown is never re-queued over: the next poll checks it again.
  const unresolvedMatch = baseline?.state === "matched" && !ignored.has(baseline.lobbyId);
  if (queuing && baseline?.state !== "waiting" && !unresolvedMatch) {
    joinedQueue = true;
    const joined = await entry.callTool("join_queue", { key, mode: config.mode });
    if (!joined.ok && errorCode(joined.data) !== "already_queued") {
      throw new Error(`join_queue refused: ${errorCode(joined.data)}${joined.data?.message ? ` (${joined.data.message})` : ""}`);
    }
    const queue = joined.ok ? joined.data.queue : null;
    progress("joined_queue", { queue: queue ?? { refused: "already_queued" } }, env);
    if (queue?.state === "waiting") ownJoinAt = Number(queue.joinedAt);
    if (queue?.state === "matched") ownJoinAt = Number(queue.matchedAt);
    if (Number.isFinite(ownJoinAt)) updateSeat({ ownJoinedAt: ownJoinAt }, env);
    if (queue?.state === "matched") {
      pairing = await accept(queue);
      if (pairing) return pairing;
    }
  }

  const started = clock.now();
  for (;;) {
    if (clock.now() - started > maxWaitMs) throw new Error(`No pairing after ${Math.round(maxWaitMs / 1000)} s`);
    await clock.sleep(pollMs);
    const status = (await tool(entry, "queue_status", { key })).queue;
    pairing = await accept(status);
    if (pairing) return pairing;
    if (queuing && !joinedQueue && status?.state === "matched" && ignored.has(status.lobbyId)) {
      throw new Error(`Lobby ${status.lobbyId} is over and this seat has not queued; run go again to queue`);
    }
    if (queuing && (status?.state === "expired" || (status?.state === "none" && joinedQueue))) {
      throw new Error(`Queue entry ${status.state} without a pairing; run go again to queue again`);
    }
    progress("waiting", { queue: status?.state ?? null, waitedMs: clock.now() - started }, env);
  }
}

/**
 * `leave`: leave the queue only while this seat's entry is waiting.
 * Returns { left, queue }; a matched, expired or missing entry is returned with left false and nothing else is called.
 */
export async function leaveQueue(ctx) {
  const entry = entryClient(ctx);
  const before = (await tool(entry, "queue_status", { key: ctx.key })).queue ?? { state: "none" };
  if (before.state !== "waiting") {
    progress("leave_nothing", { queue: before.state }, ctx.env);
    return { left: false, queue: before, note: `nothing to leave: queue entry is ${before.state}` };
  }
  if (ctx.config.parallel === true && Number(before.joinedAt) !== readSeat(ctx.env).ownJoinedAt) {
    // Opt-in: a waiting entry this seat did not create is another run's; it is never left from here.
    progress("leave_nothing", { queue: before.state, reason: "not created by this seat" }, ctx.env);
    return { left: false, queue: before, note: "nothing to leave: the waiting entry was not created by this seat" };
  }
  const after = (await tool(entry, "leave_queue", { key: ctx.key })).queue ?? null;
  progress("left_queue", { queue: after?.state ?? null }, ctx.env);
  return { left: after?.state !== "waiting", queue: after };
}

function waits(env) {
  return { pollMs: envNumber(env, "ANTWARS_POLL_MS", DEFAULT_POLL_MS), maxWaitMs: envNumber(env, "ANTWARS_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS) };
}

/** The whole go flow. Returns the final status object. */
export async function go(ctx) {
  const { pollMs, maxWaitMs } = waits(ctx.env);
  const entry = entryClient(ctx);
  const pairing = await awaitPairing({ entry, ctx, pollMs, maxWaitMs });
  progress("paired", pairing, ctx.env);
  return enterMatch({ entry, ctx, pairing, pollMs, maxWaitMs });
}

/** `create-lobby`: one create_lobby, public, one agent per colony. Creating does not seat this seat. No queue call. */
export async function createLobby(ctx) {
  const { lobby } = await tool(entryClient(ctx), "create_lobby", { key: ctx.key, size: 1, kind: "public" });
  const lobbyId = lobby?.id ?? null;
  progress("lobby_created", { lobbyId, state: lobby?.state ?? null }, ctx.env);
  return { lobbyId, state: lobby?.state ?? null, next: `antwars-seat join-lobby ${lobbyId} --detach` };
}

/** `join-lobby <lobbyId>`: one join_lobby, then the same locate_match -> join -> nest window as go. No queue call. */
export async function joinLobby(ctx, lobbyId) {
  const { pollMs, maxWaitMs } = waits(ctx.env);
  const entry = entryClient(ctx);
  const { lobby } = await tool(entry, "join_lobby", { key: ctx.key, lobbyId });
  progress("joined_lobby", { lobbyId, state: lobby?.state ?? null }, ctx.env);
  return enterMatch({ entry, ctx, pairing: { lobbyId, matchedAt: null }, pollMs, maxWaitMs });
}

/**
 * From a lobby this seat is seated in to joined inside the open nest window:
 * locate_match -> join -> wait for nestSelection. Shared by go and join-lobby.
 * Never calls pick_nest: the final step "joined" carries closesAt and box for the agent's own pick.
 */
async function enterMatch({ entry, ctx, pairing, pollMs, maxWaitMs }) {
  const { env, clock } = ctx;
  let location;
  const locateStarted = clock.now();
  for (;;) {
    location = await tool(entry, "locate_match", { lobbyId: pairing.lobbyId });
    if (location.mcpUrl) break;
    if (clock.now() - locateStarted > maxWaitMs) throw new Error("Match server not assigned in time");
    const state = await lobbyState(entry, ctx.key, pairing.lobbyId, env);
    if (state !== null && ENDED.has(state)) throw new Error(`Lobby ${pairing.lobbyId} ${state} before a match server was assigned`);
    progress("locating", { lobbyId: pairing.lobbyId, lobbyState: state }, env);
    await clock.sleep(pollMs);
  }
  writeJson(statePath("match.json", env), { lobbyId: pairing.lobbyId, matchedAt: pairing.matchedAt, mcpUrl: location.mcpUrl, spectatorUrl: location.spectatorUrl ?? null });
  progress("located", { lobbyId: pairing.lobbyId, mcpUrl: location.mcpUrl, spectatorUrl: location.spectatorUrl ?? null }, env);

  const match = matchClient(ctx, location.mcpUrl);
  const joined = await joinSeat(match, ctx);
  if (!joined.ok) throw new Error(`join refused: ${errorCode(joined.data)}`);
  // closesAt/box are cleared here: only the final "joined" (window open, go finished) carries them.
  progress("joined", { agentId: joined.data.agentId ?? null, colony: joined.data.colony ?? null, closesAt: null, box: null }, env);

  let selection = joined.data.nestSelection;
  const windowStarted = clock.now();
  while (!selection) {
    if (clock.now() - windowStarted > maxWaitMs) throw new Error("Nest window never opened");
    await clock.sleep(pollMs);
    const seen = await match.callTool("observe", {});
    if (seen.ok && seen.data.nestSelection) selection = seen.data.nestSelection;
    else if (seen.ok && seen.data.view && seen.data.view.tick > 0) {
      progress("ready", { nest: null, note: "match started without an open nest window" }, env);
      return { step: "ready" };
    }
  }
  const open = { closesAt: selection.closesAt ?? null, box: selection.box ?? null, next: NEST_NEXT };
  progress("joined", open, env);
  return { step: "joined", ...open };
}
