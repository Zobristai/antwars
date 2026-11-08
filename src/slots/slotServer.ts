/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { InstanceClaim, Lobbies, MatchOutcome, SlotHolder } from "../lobby/lobbies.js";
import type { LobbySeat } from "../mcp/game.js";
import type { ModelLabels, ServiceTiers, ThinkingLevels } from "../rating/ratings.js";
import { slotActivity } from "./activity.js";

/**
 * The slot runner of one deployed slot server: the instance configured
 * with a slot plays the match of whichever lobby holds that slot, one at a time.
 *
 * At boot it registers itself as the slot's instance; the last to boot owns the
 * slot, with one exception. Cloud Run can briefly start a second instance
 * of a service capped at one, so the owner proves it is alive: beginning its match
 * stamps a heartbeat on the slot's instance record, refreshed every 5 s while that
 * match is current here. An instance of the same revision that starts while the
 * heartbeat is younger than 30 s and the slot's lobby holds the match its owner
 * began does not register: it retries each poll, and its server answers no request
 * (startup probe and every route 503, src/server.ts) until it registers, once the
 * owner releases the match or its heartbeat goes stale. A stale heartbeat means the
 * owner is gone, and the successor takes over its match as below. An instance of another
 * revision (a deploy), or of an unknown one, registers at once as before.
 *
 * An owner players can no longer reach is gone too. Cloud Run may stop
 * routing to the owner while the waiting instance holds the service's one place, and
 * the owner's process alone cannot tell. So each heartbeat also records when a request
 * last arrived at the owner (counted on arrival, never by a stream or keep-alive opened
 * earlier; src/server.ts), and each beat sends one GET /wake to the owner's own public
 * URL, so an owner that is reachable hears a request every beat however quiet its
 * players are. The waiting instance registers once the owner has heard no request for
 * SLOT_UNHEARD_MS (20 s): within about 22 s of an unreachable owner's last request,
 * under the 30 s staleness window, the successor takes the slot and takes over the begun
 * match, as for a gone owner. An owner that is still reached keeps its match as above.
 *
 * One poll then drives every slot write in order: noticing it has been
 * superseded, releasing an ended match (retried until the release commits), taking
 * over a match an earlier run began, seating the holder during its countdown, and
 * beginning its match when the countdown ends. A superseded runner never acts again;
 * its successor records the outcome.
 * Its server then answers no request
 * (every route, its startup probe included, 503) and shuts itself down, and the
 * production process exits: Cloud Run retires the instance, so every player
 * request reaches the slot's registered instance, and a lobby left with no live owner
 * is played by the next instance a request starts.
 *
 * Handover: a superseded runner whose begun match is current here hands it
 * over (host.handOver: the server stops the match at a tick, saves it, then retires);
 * any other superseded runner abandons its local match, nothing saved. A successor
 * that finds a match another run began waits up to HANDOVER_SAVE_WAIT_MS from its
 * registration for a valid save: one of that lobby, by the run the lobby names as its
 * match's owner (the last that advanced it), of this runner's own revision. It restores
 * the save without advancing it, adopts the match in one transaction (the lobby's match
 * owner becomes this run), and only then resumes it, so its natural result releases and
 * rates as this run's own. Adoption changes the owner, so each save is resumed once; a
 * successor superseded before adopting records nothing and leaves the save to the next
 * owner. A save of another revision (a deploy), a failed restore, no valid save in time,
 * or a runner or host without the handover's means ends the match not played, as before.
 *
 * A server woken after its slot was assigned plays the lobby already
 * holding the slot. If that lobby's countdown ended before this run registered, its
 * seated agents first get a fresh join window, the lobbies' countdown measured from
 * registration;
 * otherwise the match begins when the countdown ends, as before.
 *
 * While its slot holds a lobby the runner holds the slot's Activity, so the
 * server is not idle and its keep-alive keeps it running: from the poll that finds a
 * holder until a poll after the release commits finds the slot free. A slot handed
 * straight to the next waiting lobby keeps the one hold. Superseded or closed, the
 * runner holds nothing.
 */

/**
 * What the runner judges a handover save by: the identity fields of MatchSave
 * (src/handover/saveStore.ts). The runner passes the whole save to host.resume.
 */
export interface SaveIdentity {
  readonly lobbyId: string;
  /** K_REVISION of the saving server. */
  readonly revision: string;
  /** The run that advanced the match last. */
  readonly savedByRunId: string;
}

/** The read side of the handover save store (MatchSaves): the latest complete save of a lobby, or null. */
export interface SaveReader<S extends SaveIdentity> {
  read(lobbyId: string): Promise<S | null>;
}

/**
 * What the runner asks of the server it drives. The three handover hooks are optional
 * only so that a server without them keeps today's behaviour: superseded, it abandons;
 * succeeding, it ends an earlier run's match not played.
 */
export interface SlotHost<S extends SaveIdentity = SaveIdentity> {
  /** Seat the lobby whose countdown is running; only its identities may join. */
  seat(lobbyId: string, seats: readonly LobbySeat[], startsAt: number, mode: SlotHolder["mode"]): void | Promise<void>;
  /** Start the seated lobby's match; false when it did not start. */
  start(): boolean;
  /** Supersession of a begun match current here: stop, save, then retire. True when the save committed. Called once; the runner then never acts again. */
  handOver?(): Promise<boolean>;
  /** Restore without advancing or seating through feed.lobbySeated. False when the restore failed. */
  resume?(save: S): Promise<boolean>;
  /** Adoption committed: restart the tick loop at the saved tick. Called once per resume. */
  startResumed?(): void;
  /** Supersession before a begun match, or a superseded newcomer dropping a restored match: end the local match as not played, nothing saved; the server then answers nothing and shuts down. */
  abandon(): void;
  /** A lobby's match was not played; its seated identities are told so when they join or call. */
  notPlayed(lobbyId: string, identityIds: readonly string[]): void;
}

export interface SlotRunnerOptions<S extends SaveIdentity = SaveIdentity> {
  readonly slot: string;
  readonly lobbies: Lobbies;
  readonly host: SlotHost<S>;
  /** The handover save store; without it, or without a revision, a successor never resumes. */
  readonly saves?: SaveReader<S>;
  readonly mcpUrl: string;
  readonly spectatorUrl: string;
  /** Interval of the one poll; 1 s by default. */
  readonly pollMs?: number;
  /** This instance's Cloud Run revision (K_REVISION); unknown when absent, and then it never defers. */
  readonly revision?: string;
  /** How often the owner refreshes its heartbeat while its begun match is current; SLOT_HEARTBEAT_MS by default. */
  readonly heartbeatMs?: number;
  /** A heartbeat at least this old is stale; SLOT_STALE_MS by default. */
  readonly staleMs?: number;
  /** When a request last arrived at this server; reported with each heartbeat. */
  readonly heardAt?: () => number;
  /** Sends one request to this server's own public URL; called on each heartbeat. */
  readonly probe?: () => void;
  /** An owner that heard no request for this long is unreachable to a waiting instance; SLOT_UNHEARD_MS by default. */
  readonly unheardMs?: number;
  readonly now?: () => number;
}

export interface SlotRunner {
  readonly runId: string;
  /** True once a later boot took the slot. */
  readonly superseded: boolean;
  /** The local match ended: its natural result, or the operator stop. Recorded by the next poll. */
  ended(outcome: MatchOutcome, thinkingLevels?: ThinkingLevels, serviceTiers?: ServiceTiers, modelLabels?: ModelLabels): void;
  /** Stops polling; publishes no outcome (a restart's successor records it). */
  close(): void;
}

export const SLOT_POLL_MS = 1000;
/** The owner's heartbeat interval while its begun match is current. */
export const SLOT_HEARTBEAT_MS = 5000;
/** A heartbeat this old means its owner is gone: six missed beats. */
export const SLOT_STALE_MS = 30_000;
/** An owner that heard no request for this long is unreachable: four beats, so a reached owner's report is never this old. */
export const SLOT_UNHEARD_MS = 20_000;
/** How long from its registration a successor waits for a valid save of an earlier run's match before ending it not played. */
export const HANDOVER_SAVE_WAIT_MS = 20_000;

/** Every seat of the holder, each numbered 1.. among the seats its identity holds, in stored order. */
const seatsOf = (holder: SlotHolder): LobbySeat[] => {
  const held = new Map<string, number>();
  return holder.colonies.flatMap((seats, colony) => seats.map((seat) => {
    const ordinal = (held.get(seat.id) ?? 0) + 1;
    held.set(seat.id, ordinal);
    return { identityId: seat.id, displayName: seat.displayName, colony: colony as 0 | 1, seat: ordinal };
  }));
};

export async function startSlotRunner<S extends SaveIdentity = SaveIdentity>(options: SlotRunnerOptions<S>): Promise<SlotRunner> {
  const { slot, lobbies, host } = options;
  const pollMs = options.pollMs ?? SLOT_POLL_MS;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? SLOT_HEARTBEAT_MS;
  const runId = randomUUID();
  /** The lobby seated or playing here. */
  let current: string | null = null;
  /** The lobby whose match this run has started, or resumed once adopted; set before host.start, so it is started once. */
  let started: string | null = null;
  /** An ending not yet recorded; kept until its release commits. */
  let pending: { readonly lobbyId: string; readonly outcome: MatchOutcome;
    readonly thinkingLevels?: ThinkingLevels; readonly serviceTiers?: ServiceTiers; readonly modelLabels?: ModelLabels;
    readonly identityIds?: readonly string[] } | null = null;
  /** A save this run restored and has not yet adopted: its lobby, the run it takes the match over from, and the lobby's seated identities. */
  let restored: { readonly lobbyId: string; readonly fromRunId: string; readonly identityIds: readonly string[] } | null = null;
  /** The earlier run whose save this run is waiting for, so the wait is logged once. */
  let awaiting: string | null = null;
  let superseded = false;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const activity = slotActivity(slot);
  /** Releases this run's hold while the slot holds a lobby; null while it holds none. */
  let releaseHold: (() => void) | null = null;

  /** Holds the slot's Activity while held is true; never once superseded or closed. */
  function holding(held: boolean): void {
    if (held && releaseHold === null && !superseded && !closed) {
      releaseHold = activity.hold(`slot ${slot} holds a lobby`);
    } else if (!held && releaseHold !== null) {
      releaseHold();
      releaseHold = null;
    }
  }

  const claim: InstanceClaim | undefined = options.revision
    ? { revision: options.revision, staleMs: options.staleMs ?? SLOT_STALE_MS, unheardMs: options.unheardMs ?? SLOT_UNHEARD_MS }
    : undefined;
  for (let waiting = false; ;) {
    const registration = await lobbies.registerInstance(slot, { runId, mcpUrl: options.mcpUrl, spectatorUrl: options.spectatorUrl }, claim);
    if (registration.registered) break;
    if (!waiting) {
      waiting = true;
      console.log(`antwar slot ${slot}: instance ${registration.ownerRunId} of this revision is playing its match; waiting, serving nothing, until it releases the match, its heartbeat goes stale or it hears no request`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const registeredAt = now();
  /** When this run last proved alive: its registration, its begin, or its last heartbeat. */
  let beatAt = registeredAt;
  /** When the holder's match begins here: its countdown's end, or a fresh countdown from registration if that ended first. */
  const beginsAt = (holder: SlotHolder): number => holder.startsAt <= registeredAt ? registeredAt + lobbies.countdownMs : holder.startsAt;

  function supersede(): void {
    if (superseded) return;
    superseded = true;
    holding(false);
    if (host.handOver !== undefined && started !== null && started === current && pending === null) {
      // Its begun match is current here and has not ended: the server stops it, saves it, then retires.
      console.log(`antwar slot ${slot}: another instance took the slot; handing this run's match over`);
      host.handOver().then(
        (saved) => console.log(`antwar slot ${slot}: handover save of lobby ${started} ${saved ? "committed" : "failed; the successor ends the match not played"}`),
        (err: unknown) => console.error(`antwar slot ${slot}: handover of lobby ${started} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
      );
      return;
    }
    console.log(`antwar slot ${slot}: another instance took the slot; ending this run's match as not played`);
    host.abandon();
  }

  /**
   * Restores a valid save of the holder's match, which fromRunId advanced last: true while
   * still waiting for one or once restored (then `restored` is set), false when the match
   * is not played: no means to resume, no valid save in time, another revision's save, or a failed restore.
   */
  async function restore(holder: SlotHolder, fromRunId: string): Promise<boolean> {
    if (options.saves === undefined || !options.revision || host.resume === undefined || host.startResumed === undefined) return false;
    const expired = (): false => {
      console.log(`antwar slot ${slot}: no valid save of lobby ${holder.lobbyId} from run ${fromRunId} within ${HANDOVER_SAVE_WAIT_MS} ms of taking the slot; ending its match as not played`);
      return false;
    };
    const left = registeredAt + HANDOVER_SAVE_WAIT_MS - now();
    if (left <= 0) return expired();
    if (awaiting !== fromRunId) {
      awaiting = fromRunId;
      console.log(`antwar slot ${slot}: lobby ${holder.lobbyId} holds the match run ${fromRunId} began; waiting for its save`);
    }
    // The read is bounded by the time left, and a save it returns after the wait is over is not resumed.
    let bound: NodeJS.Timeout | undefined;
    const save = await Promise.race([
      options.saves.read(holder.lobbyId),
      new Promise<null>((resolve) => { bound = setTimeout(resolve, left, null); }),
    ]).finally(() => clearTimeout(bound));
    if (closed || superseded) return true;
    if (now() - registeredAt >= HANDOVER_SAVE_WAIT_MS) return expired();
    // Only the latest save by the run that advanced the match last is resumable.
    if (save === null || save.lobbyId !== holder.lobbyId || save.savedByRunId !== fromRunId) return true;
    if (save.revision !== options.revision) {
      console.log(`antwar slot ${slot}: lobby ${holder.lobbyId} was saved by revision ${save.revision}, not this ${options.revision}; ending its match as not played`);
      return false;
    }
    const resumed = await host.resume(save);
    // Closed or superseded while restoring: record nothing, leaving the save to the next owner.
    if (closed || superseded) return true;
    if (!resumed) {
      console.log(`antwar slot ${slot}: restoring lobby ${holder.lobbyId} failed; ending its match as not played`);
      return false;
    }
    restored = { lobbyId: holder.lobbyId, fromRunId, identityIds: seatsOf(holder).map((seat) => seat.identityId) };
    return true;
  }

  /** Adopts the restored match, retried each poll until refused or committed; only then is it resumed. */
  async function adopt(save: NonNullable<typeof restored>): Promise<void> {
    const adopted = await lobbies.adoptMatch(save.lobbyId, slot, runId, save.fromRunId);
    if (closed || superseded) return;
    restored = null;
    if (!adopted.ok) {
      // Superseded before adopting: host.abandon drops the restored match, nothing is recorded, and the save stays the next owner's.
      if (adopted.reason === "superseded") return supersede();
      // stale_save: the lobby no longer holds this slot with that run's match.
      pending = { lobbyId: save.lobbyId, outcome: "not_played", identityIds: save.identityIds };
      return;
    }
    current = save.lobbyId;
    started = save.lobbyId;
    beatAt = now();
    console.log(`antwar slot ${slot}: adopted lobby ${save.lobbyId}'s match from run ${save.fromRunId}; resuming it`);
    host.startResumed?.();
  }

  async function poll(): Promise<void> {
    if ((await lobbies.resolveSlot(slot))?.runId !== runId) return supersede();
    if (pending !== null) {
      const released = await lobbies.endMatch(pending.lobbyId, runId, pending.outcome, pending.thinkingLevels, pending.serviceTiers, pending.modelLabels);
      if (!released.ok && released.reason === "superseded") return supersede();
      // Released, or already released by an earlier attempt whose reply was lost.
      if (pending.identityIds !== undefined) host.notPlayed(pending.lobbyId, pending.identityIds);
      pending = null;
      current = null;
    }
    // A restored match whose adoption failed or whose reply was lost: adoption is idempotent for this run.
    if (restored !== null) return adopt(restored);
    const holder = await lobbies.slotHolder(slot);
    if (closed || superseded) return;
    holding(holder !== null);
    if (holder === null) return;
    if (holder.matchRunId !== null && holder.matchRunId !== runId) {
      // An earlier run of this slot began it: take it over from its save, or it was not played.
      if (await restore(holder, holder.matchRunId)) return restored === null || closed || superseded ? undefined : adopt(restored);
      pending = { lobbyId: holder.lobbyId, outcome: "not_played", identityIds: seatsOf(holder).map((seat) => seat.identityId) };
      return poll();
    }
    if (started === holder.lobbyId) {
      // Its begun match is current here: keep proving this run alive, and
      // report when a request last reached it, probing its own public URL.
      if (now() - beatAt < heartbeatMs) return;
      options.probe?.();
      if (!(await lobbies.heartbeat(slot, runId, options.heardAt?.()))) return supersede();
      beatAt = now();
      return;
    }
    if (current !== holder.lobbyId) {
      await host.seat(holder.lobbyId, seatsOf(holder), beginsAt(holder), holder.mode);
      if (closed || superseded) return;
      current = holder.lobbyId;
    }
    if (holder.matchRunId === null) {
      if (now() < beginsAt(holder)) return;
      const begun = await lobbies.beginMatch(holder.lobbyId, slot, runId);
      if (!begun.ok) {
        if (begun.reason === "superseded") supersede();
        return;
      }
      beatAt = now();
    }
    // Begun now, or by this run's earlier begin whose reply was lost: the stamp alone
    // never means the match started here, so it starts exactly once.
    started = holder.lobbyId;
    if (!host.start()) {
      const identityIds = seatsOf(holder).map((seat) => seat.identityId);
      host.notPlayed(holder.lobbyId, identityIds);
      pending = { lobbyId: holder.lobbyId, outcome: "not_played" };
    }
  }

  function schedule(): void {
    if (closed || superseded) return;
    timer = setTimeout(() => {
      timer = null;
      poll().catch((err: unknown) => {
        // A failed store call is retried by the next poll; a pending ending is kept.
        console.error(`antwar slot ${slot} poll failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }).finally(schedule);
    }, pollMs);
  }
  schedule();

  return {
    runId,
    get superseded() {
      return superseded;
    },
    ended(outcome, thinkingLevels, serviceTiers, modelLabels) {
      if (superseded || current === null) return;
      // Snapshot metadata with the outcome: retries must not read a later match's agents.
      pending = { lobbyId: current, outcome, thinkingLevels: thinkingLevels && { ...thinkingLevels }, serviceTiers: serviceTiers && { ...serviceTiers },
        modelLabels: modelLabels && { ...modelLabels } };
    },
    close() {
      closed = true;
      holding(false);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
