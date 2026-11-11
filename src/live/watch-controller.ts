import type { AccountStores } from "../accounts/service.js";
import type { Rating } from "../rating/ratings.js";
import { seatKeyOf, type LobbySeat } from "../mcp/game.js";
import type { LiveGame } from "../server.js";
import type { SimState } from "../sim/types.js";
import type { PrivateArchive } from "../replays/private-archive.js";
import { slotActivity } from "../slots/activity.js";
import type { StreamAgent, StreamIdentity } from "./format.js";
import type { LiveHub, LiveHubOptions } from "./hub.js";
import { captureMatchAccess, type MatchAccess } from "./match-access.js";
import type { WatchRegistry } from "./watch-registry.js";
import { logUnlistedHouse } from "../rating/unlistedHouse.js";

type SeatIdentity = StreamIdentity & { readonly identityId: string };
interface Prepared {
  readonly access: MatchAccess;
  /** By seat key: an identity holding several seats has one entry per seat. */
  readonly bySeat: ReadonlyMap<string, SeatIdentity>;
  /** The stream's start, the match's registry key; set once the match has started here. */
  readonly startedAt?: number;
  /** Each seated identity's rating in the lobby's ranked mode as read before start, which the catalog shows (registry seatRatings). */
  readonly seatRatings?: Readonly<Record<string, Rating>>;
}
/** A started lobby's watch metadata as a handover save carries it: JSON-safe. */
export interface WatchSave {
  readonly access: MatchAccess;
  readonly startedAt: number;
  readonly seats: readonly (readonly [seatKey: string, identity: SeatIdentity])[];
}
export interface WatchController {
  readonly hubOptions: LiveHubOptions;
  prepare(lobbyId: string, seats: readonly LobbySeat[]): Promise<void>;
  started(seq: number, state: SimState, live: LiveGame, hub: LiveHub): void;
  /** The watch part of a handover save of a lobby whose match started or resumed here. */
  save(lobbyId: string): WatchSave;
  /**
   * Restore a saved lobby's watch metadata on this server, so its final ratings resolve here. Returns the match access
   * and seat identities its resumed stream uses. It lists nothing: a restored match may never be this server's.
   */
  resume(meta: unknown, live: LiveGame): Promise<{ access: MatchAccess; identity: (agentId: string) => StreamIdentity | undefined }>;
  /**
   * This server's run, runId, adopted the resumed lobby's match: list it under that run (registry resumed), which the
   * registry refuses once another run holds the match. Nothing for a lobby not resumed here.
   */
  adopted(lobbyId: string, runId: string): void;
  close(): void;
}

/**
 * Store work is outside the tick loop; a failed publication retries without dropping or reordering it.
 * Each job holds the slot's server busy from publish until it succeeds, across its retries.
 */
export function createWatchController(options: {
  accounts: AccountStores; registry: WatchRegistry; slot: string; origin: string; archive?: PrivateArchive;
}): WatchController {
  const { accounts, registry } = options;
  const prepared = new Map<string, Prepared>();
  /** The lobby seated here, with the slot's run it begins under. */
  let current: (Prepared & { readonly runId: string }) | undefined;
  /**
   * The run each started or adopted lobby's match is this server's under, kept until its replay is saved: the registry
   * takes its playback end and replay id only from the run holding the match.
   */
  const runs = new Map<string, string>();
  /**
   * Each lobby's seat model labels by stream display name, as its delayed playback shows them (hub onReleased): a seat's
   * label reaches the catalog no earlier than spectators see that seat join. A seat that reported none is left out.
   */
  const shown = new Map<string, Readonly<Record<string, string>>>();
  /** The labels last written for each lobby, so an unchanged set is not written again. */
  const published = new Map<string, string>();
  /** Write the lobby's shown labels once its match is this server's run's (started here, or a resumed match once adopted), so
   * a resumed match's labels are published under the run that holds it, whatever the server it came from published. */
  const publishLabels = (lobbyId: string) => {
    const labels = shown.get(lobbyId);
    if (!runs.has(lobbyId) || labels === undefined) return;
    const text = JSON.stringify(labels);
    if (published.get(lobbyId) === text) return;
    published.set(lobbyId, text);
    if (Object.keys(labels).length > 0) publishOwned(lobbyId, runId => registry.seatLabels(lobbyId, runId, labels), "seat labels");
  };
  /** Publish a fenced write under the lobby's run; a run that no longer holds the match leaves the entry its owner's. */
  const publishOwned = (lobbyId: string, write: (runId: string) => Promise<boolean>, what: string) => {
    const runId = runs.get(lobbyId);
    const refused = () => console.log(`antwar slot ${options.slot}: lobby ${lobbyId}'s match is not run ${runId ?? "(none)"}'s; its ${what} is left to its owner`);
    if (runId === undefined) { refused(); return; }
    publish(async () => { if (!await write(runId)) refused(); });
  };
  let closed = false;
  const jobs: { readonly run: () => Promise<void>; readonly release: () => void }[] = [];
  let busy = false, reportedFailure = false, timer: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      while (!closed && jobs.length) { await jobs[0]!.run(); jobs.shift()?.release(); reportedFailure = false; }
    } catch {
      if (!closed && !reportedFailure) { console.error("antwar spectator metadata publication failed; retrying"); reportedFailure = true; }
      if (!closed) timer = setTimeout(() => { timer = undefined; void drain(); }, 1000);
    } finally { busy = false; }
  };
  const publish = (job: () => Promise<void>) => {
    if (!closed) { jobs.push({ run: job, release: slotActivity(options.slot).hold("spectator metadata publication") }); if (timer === undefined) void drain(); }
  };
  return {
    hubOptions: {
      requireMatchAccess: true,
      activity: slotActivity(options.slot),
      currentInvite: (id, token) => accounts.lobbies.isInviteCurrent(id, token),
      privateReplayStore: id => options.archive?.forLobby(id),
      onPlaybackFinished(access) {
        publishOwned(access.lobbyId, runId => registry.playbackFinished(access.lobbyId, runId), "playback end");
        prepared.delete(access.lobbyId);
      },
      onReleased(access, agents) {
        shown.set(access.lobbyId, releasedLabels(agents));
        publishLabels(access.lobbyId);
      },
      onReplaySaved(access, id) {
        publishOwned(access.lobbyId, runId => registry.replaySaved(access.lobbyId, runId, id), "replay id");
        runs.delete(access.lobbyId);
        published.delete(access.lobbyId);
        shown.delete(access.lobbyId);
      },
      async resultRatings(access, agents) {
        const lobby = await accounts.lobbies.readLobby(access.lobbyId);
        if (!lobby.ok || lobby.value.state !== "ended") return null;
        if (lobby.value.outcome === "stopped" || lobby.value.outcome === "not_played") return [];
        const changes = await accounts.ratings.readMatchChanges(access.lobbyId);
        if (changes === null) return null;
        const metadata = prepared.get(access.lobbyId);
        if (!metadata) throw new Error("Missing spectator match metadata");
        const seated = [...metadata.bySeat.values()];
        return agents.flatMap((agent, index) => {
          // The stream carries no seat key; each seat's display name is unique within the match.
          const member = agent.identity && seated.find(seat => seat.displayName === agent.identity!.displayName);
          if (!member) throw new Error("Missing spectator seated identity");
          const change = changes.find(row => row.identityId === member.identityId);
          if (!change) throw new Error("Missing spectator rating outcome");
          return [{ agent: index, before: change.before, after: change.after }];
        });
      },
    },
    async prepare(lobbyId, seats) {
      const [lobby, instance] = await Promise.all([accounts.lobbies.readLobby(lobbyId), accounts.lobbies.resolveSlot(options.slot)]);
      if (!lobby.ok || lobby.value.state !== "holding" || lobby.value.slot !== options.slot || lobby.value.rated === null || !instance) throw new Error("Spectator lobby not ready");
      const { challenge, mode } = lobby.value;
      const [members, seatRatings] = await Promise.all([Promise.all(seats.map(async seat => {
        // A house challenge's held seat shows its handle's Model Index 1v1 rating, and none before the Index has rated
        // it; every other seat shows its rating in the lobby's mode (a challenge's builder, its public 1v1 rating).
        const house = challenge !== undefined && seat.colony === challenge.heldColony;
        const read = await accounts.ratings.readRating(seat.identityId, house ? "house-1v1" : mode ?? "1v1");
        return { ...seat, ...(house && read.ratedMatches === 0 ? {} : { elo: read.rating }) };
      })),
      // The catalog's figures: each identity's rating in the lobby's ranked mode, read once here, before the match can
      // have a result, so Live now never shows a rating the match itself moved.
      mode == null ? undefined : Promise.all([...new Set(seats.map(seat => seat.identityId))]
        .map(async identityId => [identityId, await accounts.ratings.readRating(identityId, mode)] as const)).then(Object.fromEntries)]);
      if (closed) throw new Error("Spectator server closed");
      current = { access: { lobbyId, visibility: lobby.value.kind, rated: lobby.value.rated, mode: lobby.value.mode }, runId: instance.runId,
        bySeat: seatIdentities(members), ...(seatRatings === undefined ? {} : { seatRatings }) };
      prepared.set(lobbyId, current);
    },
    started(seq, state, live, hub) {
      const metadata = current;
      if (!metadata) throw new Error("Spectator lobby metadata missing at match start");
      hub.startMatch(seq, state, metadata.access, seatIdentity(metadata, live), live.spectatorHouseIdle?.(seq));
      // The HUD, result, share text and replay name each seat from this stream; an unlisted house handle shows as
      // "Unlisted model", logged once at the match's start.
      logUnlistedHouse("match stream", [...metadata.bySeat.values()].map(seat => seat.displayName));
      const { startedAt } = hub.catalogMatches().find(row => row.lobbyId === metadata.access.lobbyId)!;
      prepared.set(metadata.access.lobbyId, { ...metadata, startedAt });
      runs.set(metadata.access.lobbyId, metadata.runId);
      publish(() => registry.register({ ...metadata.access, startedAt, origin: options.origin, slot: options.slot, runId: metadata.runId,
        ...(metadata.seatRatings === undefined ? {} : { seatRatings: metadata.seatRatings }) }));
    },
    save(lobbyId) {
      const metadata = prepared.get(lobbyId);
      if (metadata?.startedAt === undefined) throw new Error("Spectator match not started");
      return { access: metadata.access, startedAt: metadata.startedAt, seats: [...metadata.bySeat] };
    },
    async resume(meta, live) {
      const saved = watchSave(meta);
      if (closed) throw new Error("Spectator server closed");
      const metadata: Prepared = { access: saved.access, bySeat: new Map(saved.seats), startedAt: saved.startedAt };
      prepared.set(saved.access.lobbyId, metadata);
      return { access: metadata.access, identity: seatIdentity(metadata, live) };
    },
    adopted(lobbyId, runId) {
      const metadata = prepared.get(lobbyId);
      if (metadata?.startedAt === undefined) return;
      const match = { ...metadata.access, startedAt: metadata.startedAt, origin: options.origin, slot: options.slot, runId };
      runs.set(lobbyId, runId);
      publish(async () => {
        if (await registry.resumed(match)) return;
        console.log(`antwar slot ${options.slot}: lobby ${lobbyId}'s match is no longer run ${runId}'s; its watch entry stays its owner's`);
      });
      // What its delayed playback has shown so far, on this server or carried by the save.
      publishLabels(lobbyId);
    },
    close() { closed = true; clearTimeout(timer); for (const job of jobs.splice(0)) job.release(); prepared.clear(); runs.clear(); published.clear(); shown.clear(); },
  };
}

/** Each seat's self-reported model label by its stream display name, from the agents delayed playback shows. */
function releasedLabels(agents: readonly StreamAgent[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const agent of agents) {
    const name = agent.identity?.displayName;
    if (name !== undefined && agent.modelLabel !== "" && !Object.hasOwn(labels, name)) labels[name] = agent.modelLabel;
  }
  return labels;
}

/** Each stream agent's spectator identity, found by the seat it plays. */
function seatIdentity(metadata: Prepared, live: LiveGame): (agentId: string) => SeatIdentity | undefined {
  return agentId => {
    const seatKey = live.agentInfo(agentId)?.seatKey;
    return seatKey ? metadata.bySeat.get(seatKey) : undefined;
  };
}

/** A WatchSave read back from a handover save; anything else fails the resume. */
function watchSave(meta: unknown): WatchSave {
  const value = meta as Partial<WatchSave> | null;
  const seats = value?.seats;
  if (typeof value !== "object" || value === null || !Number.isSafeInteger(value.startedAt) || value.startedAt! < 0 || !Array.isArray(seats) ||
    !seats.every(entry => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1]?.identityId === "string" &&
      typeof entry[1].displayName === "string" && (entry[1].elo === undefined || typeof entry[1].elo === "number"))) throw new Error("Invalid spectator watch save");
  return { access: captureMatchAccess(value.access!), startedAt: value.startedAt!, seats };
}

/**
 * Each seat's spectator identity by its seat key. An identity holding several seats is
 * shown as "<name> #<seat>" on each, so no seat's entry replaces another's.
 */
function seatIdentities(members: readonly (LobbySeat & { readonly elo?: number })[]): ReadonlyMap<string, SeatIdentity> {
  const names = seatDisplayNames(members);
  return new Map(members.map((member, index) => [seatKeyOf(member), {
    identityId: member.identityId, displayName: names[index]!, ...(member.elo === undefined ? {} : { elo: member.elo }) }]));
}

/** Each seat's display name in the stream, in seat order: "<name> #<seat>" for an identity holding several seats. */
export function seatDisplayNames(seats: readonly Pick<LobbySeat, "identityId" | "displayName" | "seat">[]): string[] {
  const held = new Map<string, number>();
  for (const seat of seats) held.set(seat.identityId, (held.get(seat.identityId) ?? 0) + 1);
  return seats.map(seat => held.get(seat.identityId)! > 1 ? `${seat.displayName} #${seat.seat}` : seat.displayName);
}

/** A lobby's seats as the slot runner numbers them: 1.. among the seats each identity holds, in stored order. */
export function lobbySeats(colonies: readonly (readonly { readonly id: string; readonly displayName: string }[])[]): LobbySeat[] {
  const held = new Map<string, number>();
  return colonies.flatMap((seats, colony) => seats.map(seat => {
    const ordinal = (held.get(seat.id) ?? 0) + 1;
    held.set(seat.id, ordinal);
    return { identityId: seat.id, displayName: seat.displayName, colony: colony as 0 | 1, seat: ordinal };
  }));
}
