import { addAbortListener, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { AccountStores } from "../accounts/service.js";
import { isReplayId, type ReplayRead, type ReplaySource } from "../replays/access.js";
import type { PrivateArchive } from "../replays/private-archive.js";
import type { LiveHub } from "./hub.js";
import { admitMatchWatch, type MatchAccess } from "./match-access.js";
import { listedMatches, matchWatchStatus, publicMatchCatalog, type PublicColonies, type PublicSeat } from "./match-catalog.js";
import { publicQueue, type QueueRatings } from "./queue-catalog.js";
import { HELD_COLONY } from "../lobby/challenges.js";
import { seatRating } from "./seat-rating.js";
import { lobbyMatchType, type RecordingMatchType } from "../replays/recorded-match-type.js";
import type { RankedMode, Rating } from "../rating/ratings.js";
import { logUnlistedHouse } from "../rating/unlistedHouse.js";
import { harnessPhaseAt, isIndexMode } from "../rating/harnessPhase.js";
import type { WatchMatch, WatchRegistry } from "./watch-registry.js";
import type { Lobby, UnstartedLobby, WaitingAgent } from "../lobby/lobbies.js";
import { lobbySeats, seatDisplayNames } from "./watch-controller.js";
import { createAdmissionCap, type CapLimits } from "../net/admission.js";
import { isGzip, logUnavailable, peek, relayed } from "../net/relay.js";
import { clientSource } from "../server/clientSource.js";
import { RELAY_HEADER, signRelay } from "./relay-signature.js";

function reply(res: ServerResponse, status: number, value?: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer", vary: "x-antwar-invite" });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

/**
 * Longest a relayed /watch/live stream stays open. Behind Cloud Run's HTTP/1 frontend the game service
 * may never see a viewer leave: an aborted viewer's relay was observed writing 26.7 MB for the whole 3,600 s request
 * timeout with no close, write error or backpressure. At this bound the relay cancels its slot fetch and ends the
 * response cleanly; a viewer still watching reconnects to the same lobby (EventSource itself, or openLive for invite
 * streams) and receives a full snapshot at the delayed playback position.
 */
export const RELAY_MAX_MS = 300_000;
/** After the bound, a response whose end cannot be flushed (the frontend stopped reading) is destroyed this much later. */
export const RELAY_END_GRACE_MS = 1_000;
/**
 * Live relays this server holds open at once, and per viewer source. Every viewer of every
 * slot watches through these relays, so 512 is twice one slot's spectator cap. The slot sees every
 * relayed viewer from this server's address, so the per-source bound is applied here, where the
 * viewer's own address is known; the slot counts a relay this server signed only toward its overall cap.
 */
export const RELAY_LIMITS: CapLimits = { max: 512, perSource: 16 };

/** Same-origin browser routes: forwarding never redirects a browser or transfers cookies/account keys. */
export function watchRoutes(options: {
  accounts: AccountStores; registry: WatchRegistry; hub: LiveHub; origin?: string;
  archive?: PrivateArchive; replays?: ReplaySource; request?: typeof fetch;
  /** Defaults to RELAY_MAX_MS; tests pass a short bound. */
  relayMaxMs?: number;
  /** Defaults to RELAY_LIMITS; tests pass small caps. */
  relayLimits?: CapLimits;
  /** Signs each live relay for the slot (relay-signature.ts); omitted sends none. Never logged. */
  relayKey?: Uint8Array;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const request = options.request ?? fetch;
  const relayMaxMs = options.relayMaxMs ?? RELAY_MAX_MS;
  const relays = createAdmissionCap("watch relays", options.relayLimits ?? RELAY_LIMITS);
  return async (req, res) => {
    if (req.method !== "GET") { res.setHeader("allow", "GET"); reply(res, 405); return; }
    const abort = new AbortController();
    const cancel = () => abort.abort(); res.once("close", cancel);
    let routeClass = "/watch";
    const unavailable = (cause: unknown) => { logUnavailable(req.method, routeClass, cause); reply(res, 503); };
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/watch/catalog") {
        routeClass = pathname;
        const [matches, lobbies] = await Promise.all([options.registry.publicMatches(), options.accounts.lobbies.listPublic()]);
        const slots = new Map(await Promise.all([...new Set(matches.map(match => match.slot))].map(async slot => [slot, await options.accounts.lobbies.resolveSlot(slot)] as const)));
        // A restarted slot has no retained in-memory playback from its previous process.
        const live = matches.filter(match => slots.get(match.slot)?.runId === match.runId);
        const read = await Promise.all(listedMatches(live).map(async match => [match.lobbyId, await matchPlayers(options.accounts, match)] as const));
        const players = new Map(read.map(([id, found]) => [id, found.colonies] as const));
        const types = new Map(read.flatMap(([id, found]) => found.matchType === null ? [] : [[id, found.matchType] as const]));
        const catalog = publicMatchCatalog(live, lobbies, players, types);
        // Live now and Waiting show an unlisted house handle as "Unlisted model"; the server logs it.
        logUnlistedHouse("watch catalog", [...catalog.matches.flatMap(match => match.colonies.flat().map(seat => seat.displayName)), ...catalog.lobbies.flatMap(lobby => lobby.colonies.flat())]);
        reply(res, 200, catalog); return;
      }
      // The agents waiting in the ranked queues: display name, mode, when the wait began and rating only; and the public
      // lobbies and queue pairings not yet begun: mode, size, seats, seated names and their ratings only.
      if (pathname === "/watch/queue") {
        routeClass = pathname;
        const [agents, lobbies] = await Promise.all([options.accounts.lobbies.listWaiting(), options.accounts.lobbies.listUnstarted()]);
        const queue = publicQueue(agents, Date.now(), lobbies, await queueRatings(options.accounts, agents, lobbies));
        logUnlistedHouse("watch queue", [...queue.waiting.map(agent => agent.displayName), ...queue.lobbies.flatMap(lobby => lobby.colonies.flat())]);
        reply(res, 200, queue); return;
      }
      // A recording's stored rating figures are addressed by replay id alone; its lobby is looked up.
      const ratings = /^\/watch\/ratings\/([^/]+)$/.exec(pathname);
      let route: readonly (string | undefined)[] | null;
      if (ratings) {
        routeClass = "/watch/ratings/:replay";
        const replayId = decodeURIComponent(ratings[1]!);
        const found = isReplayId(replayId) ? await options.registry.findByReplay(replayId) : null;
        if (found === null) { reply(res, 404); return; }
        route = [pathname, "ratings", found, replayId];
      } else route = /^\/watch\/(live|status|recording|replays|records)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
      if (!route) { reply(res, 404); return; }
      const kind = route[1]!, lobbyId = ratings ? route[2]! : decodeURIComponent(route[2]!);
      if (!ratings) routeClass = `/watch/${kind}/:lobby${route[3] === undefined ? "" : "/:replay"}`;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(lobbyId)) { reply(res, 404); return; }
      if ((kind === "live" || kind === "status" || kind === "recording") && route[3] !== undefined) { reply(res, 404); return; }
      const lobby = await options.accounts.lobbies.readLobby(lobbyId);
      if (!lobby.ok) { reply(res, 404); return; }
      const access: MatchAccess = { lobbyId, visibility: lobby.value.kind, rated: lobby.value.rated === true, mode: lobby.value.mode };
      const header = req.headers["x-antwar-invite"];
      const invite = typeof header === "string" ? header : undefined;
      const admitted = await admitMatchWatch(access, invite, (id, token) => options.accounts.lobbies.isInviteCurrent(id, token));
      if (admitted === "unavailable") { unavailable("invite check unavailable"); return; }
      if (admitted !== "allowed") { reply(res, 404); return; }
      if (abort.signal.aborted) return;
      const retained = await options.registry.read(lobbyId);
      if (kind === "ratings") {
        if (!retained || retained.replayId !== route[3] || !retained.playbackFinished) { reply(res, 404); return; }
        const ratingsBody = { ratings: await storedRatings(options.accounts, lobby.value) };
        // A Model Index match also gets its harness phase by its lobby's match time (src/rating/harnessPhase.ts).
        reply(res, 200, isIndexMode(lobby.value.mode)
          ? { ...ratingsBody, harnessPhase: harnessPhaseAt(lobby.value.startsAt ?? lobby.value.createdAt) } : ratingsBody); return;
      }
      if (kind === "recording") {
        reply(res, 200, { replayId: retained?.playbackFinished ? retained.replayId ?? null : null }); return;
      }
      if (kind === "status") {
        const local = options.hub.watchStatus(lobbyId);
        if (local) { reply(res, 200, local); return; }
        // An ended or expired lobby with no stream will never start: finished, so its link shows the Leaderboard.
        if (!retained) { reply(res, 200, matchWatchStatus(access, lobby.value.state === "ended" || lobby.value.state === "expired" ? "finished" : "waiting")); return; }
        if (retained.playbackFinished) { reply(res, 200, matchWatchStatus(access, "finished")); return; }
      }
      if (kind === "live" && options.hub.hasLobby(lobbyId)) { await options.hub.handle(req, res); return; }
      if (kind === "live" || kind === "status") {
        if (!retained || retained.origin === options.origin || req.headers["x-antwar-watch-proxy"] !== undefined) { reply(res, 404); return; }
        // Registry origins are captured from operator configuration, never a request URL.
        const target = new URL(`/watch/${kind}/${encodeURIComponent(lobbyId)}`, retained.origin);
        // A live relay holds a place for as long as it streams; past the cap, the viewer's page retries.
        if (kind === "live" && !relays.admit(res, clientSource(req.headers))) return;
        const headers: Record<string, string> = { "x-antwar-watch-proxy": "1", accept: kind === "live" ? "text/event-stream" : "application/json" };
        if (invite !== undefined) headers["x-antwar-invite"] = invite;
        if (kind === "live" && options.relayKey !== undefined) headers[RELAY_HEADER] = signRelay(options.relayKey, lobbyId);
        const headerTimer = setTimeout(cancel, 10_000);
        let upstream: Response;
        try { upstream = await request(target, { headers, redirect: "error", cache: "no-store", credentials: "omit", signal: abort.signal }); }
        finally { clearTimeout(headerTimer); }
        if (abort.signal.aborted) { await upstream.body?.cancel(); return; }
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          if (upstream.status === 404) reply(res, 404); else unavailable(`upstream ${upstream.status}${upstream.body ? "" : " without a body"}`);
          return;
        }
        const type = kind === "live" ? "text/event-stream" : "application/json";
        const upstreamType = upstream.headers.get("content-type");
        if (!upstreamType?.startsWith(type)) { await upstream.body.cancel(); unavailable(`upstream content-type ${upstreamType}`); return; }
        // Fetch may decode an upstream body: never copy Content-Length or Content-Encoding.
        res.writeHead(200, { "content-type": type, "cache-control": "no-store", "referrer-policy": "no-referrer", vary: "x-antwar-invite", "x-accel-buffering": "no" });
        res.flushHeaders();
        // A viewer's close aborts the fetch through its signal, failing the read; the live bound cancels the read, ending
        // it, and interrupts any wait for the viewer's side to drain.
        const reader = upstream.body.getReader();
        const expired = new AbortController();
        const life = kind === "live" ? setTimeout(() => { expired.abort(); reader.cancel().catch(() => {}); }, relayMaxMs) : undefined;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!res.write(chunk.value)) await once(res, "drain", { signal: AbortSignal.any([abort.signal, expired.signal]) });
          }
        } catch (error) {
          if (!expired.signal.aborted || abort.signal.aborted) throw error;
        } finally { clearTimeout(life); }
        abort.signal.throwIfAborted();
        res.end();
        // A frontend that has stopped reading cannot take the end: release its connection instead of holding it.
        if (expired.signal.aborted) setTimeout(() => { if (!res.writableFinished) res.destroy(); }, RELAY_END_GRACE_MS).unref();
        return;
      }
      const replayId = route[3] && decodeURIComponent(route[3]);
      if (!replayId || !isReplayId(replayId) || retained?.replayId !== replayId || !retained.playbackFinished) { reply(res, 404); return; }
      let object: ReplayRead | null;
      if (access.visibility === "private") {
        if (!options.archive) { unavailable("no private archive configured"); return; }
        const opened = await options.archive.open({ lobbyId, replayId, kind: kind === "records" ? "match-record" : "recording" }, abort.signal);
        // Cloud Run refuses a fixed-length HTTP/1 response above 32 MiB, so private media
        // declares no spooled length and is streamed chunked at any size.
        object = opened && { body: opened.body };
      } else {
        if (kind === "records" || !options.replays) { reply(res, 404); return; }
        object = await options.replays.open(replayId, abort.signal);
      }
      if (object === null) { reply(res, 404); return; }
      await media(res, object, abort.signal, kind === "records" ? "application/json" : "application/octet-stream");
    } catch (error) {
      if (!res.destroyed) { if (res.headersSent) res.destroy(); else unavailable(error); }
    } finally { res.off("close", cancel); }
  };
}

/**
 * Every rating the Waiting view shows, read once per identity and rule (seatRating): a queued agent's in its queue's mode,
 * a lobby seat's in the lobby's mode, a house challenge's held seat by the held-seat rule.
 */
async function queueRatings(accounts: AccountStores, agents: readonly WaitingAgent[], lobbies: readonly UnstartedLobby[]): Promise<QueueRatings> {
  const keyOf = (identityId: string, mode: RankedMode | null, held: boolean) => JSON.stringify([identityId, mode, held]);
  const reads = new Map<string, Promise<Rating | null>>();
  const read = (identityId: string, mode: RankedMode | null, held: boolean) => {
    const key = keyOf(identityId, mode, held);
    if (!reads.has(key)) reads.set(key, seatRating((id, ranked) => accounts.ratings.readRating(id, ranked), identityId, mode, held));
  };
  const held = (lobby: UnstartedLobby, colony: 0 | 1) => lobby.challenge === "house" && colony === HELD_COLONY;
  for (const agent of agents) read(agent.identityId, agent.mode, false);
  for (const lobby of lobbies) for (const colony of [0, 1] as const) for (const seat of lobby.colonies[colony]) read(seat.id, lobby.mode, held(lobby, colony));
  const done = new Map(await Promise.all([...reads].map(async ([key, rating]) => [key, await rating] as const)));
  return {
    agent: agent => done.get(keyOf(agent.identityId, agent.mode, false)) ?? null,
    seat: (lobby, colony, seat) => done.get(keyOf(seat.id, lobby.mode, held(lobby, colony))) ?? null,
  };
}

/**
 * A listed match's players and type from its lobby. Each seat carries its stream display name (watch-controller
 * seatDisplayNames) and the model label, thinking level and service tier its slot published for it once spectators saw it
 * join (each null otherwise). Each seat's rating is read fresh, by the rule the match stream shows it by (seatRating), so an
 * unrated match's seats show theirs too; a seat that shows none in the stream shows none here.
 */
async function matchPlayers(accounts: AccountStores, match: MatchAccess & Pick<WatchMatch, "modelLabels" | "thinkingLevels" | "serviceTiers">):
  Promise<{ colonies: PublicColonies; matchType: RecordingMatchType | null }> {
  const lobby = await accounts.lobbies.readLobby(match.lobbyId);
  if (!lobby.ok) return { colonies: [[], []], matchType: null };
  const seats = lobbySeats(lobby.value.colonies), names = seatDisplayNames(seats);
  const { challenge } = lobby.value;
  const held = (colony: 0 | 1) => challenge !== undefined && colony === challenge.heldColony;
  // One read per identity and rule: an identity holding seats in both colonies of a house challenge is read for each.
  const reads = new Map<string, Promise<Rating | null>>();
  const ratingOf = (identityId: string, colony: 0 | 1) => {
    const key = JSON.stringify([identityId, held(colony)]);
    if (!reads.has(key)) reads.set(key, seatRating((id, mode) => accounts.ratings.readRating(id, mode), identityId, match.mode ?? null, held(colony)));
    return reads.get(key)!;
  };
  const ratings = await Promise.all(seats.map(seat => ratingOf(seat.identityId, seat.colony)));
  const colonies: [PublicSeat[], PublicSeat[]] = [[], []];
  seats.forEach((seat, index) => {
    const rating = ratings[index]!, displayName = names[index]!;
    const own = (map: Readonly<Record<string, string>> | undefined) => map !== undefined && Object.hasOwn(map, displayName) ? map[displayName]! : null;
    const named = { displayName, modelLabel: own(match.modelLabels), thinkingLevel: own(match.thinkingLevels), serviceTier: own(match.serviceTiers) };
    colonies[seat.colony].push(rating === null
      ? { ...named, rating: null, rd: null, ratedMatches: null }
      : { ...named, rating: rating.rating, rd: rating.rd, ratedMatches: rating.ratedMatches });
  });
  return { colonies, matchType: lobbyMatchType(lobby.value) };
}

/**
 * The match's stored rating change record (readMatchChanges, rewritten to Glicko by the recompute)
 * by each seat's colony and stream display name, the pair the recording carries for every agent. Colony
 * comes from the stored lobby seats as read. Every seat resolves or none is returned, so a replay never mixes stored
 * and recorded figures. Read-only.
 */
async function storedRatings(accounts: AccountStores, lobby: Lobby): Promise<{ colony: 0 | 1; displayName: string; before: number; after: number }[]> {
  if (lobby.rated !== true || lobby.state !== "ended" || lobby.outcome === "stopped" || lobby.outcome === "not_played") return [];
  const changes = await accounts.ratings.readMatchChanges(lobby.id);
  if (changes === null) return [];
  const seats = lobbySeats(lobby.colonies), names = seatDisplayNames(seats);
  const rows = seats.map((seat, index) => {
    const change = changes.find(row => row.identityId === seat.identityId);
    return change && { colony: seat.colony, displayName: names[index]!, before: change.before, after: change.after };
  });
  return rows.every(row => row !== undefined) ? rows : [];
}

/** Private bytes retain no public caching headers. Sniff gzip without buffering the recording. */
async function media(res: ServerResponse, object: ReplayRead, signal: AbortSignal, contentType: string): Promise<void> {
  const cancel = addAbortListener(signal, () => object.body.destroy());
  try {
    const start = await peek(object.body, 2);
    signal.throwIfAborted();
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "referrer-policy": "no-referrer", vary: "x-antwar-invite",
      ...(isGzip(start.head) ? { "content-encoding": "gzip" } : {}), ...(object.contentLength === undefined ? {} : { "content-length": object.contentLength }) });
    await pipeline(relayed(start), res, { signal });
  } finally { cancel[Symbol.dispose](); object.body.destroy(); }
}
