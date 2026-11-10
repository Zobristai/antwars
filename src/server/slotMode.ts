/// <reference types="node" />
import { randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MatchSave } from "../handover/saveStore.js";
import type { MatchOutcome } from "../lobby/lobbies.js";
import type { LobbySeat, SlotAccess } from "../mcp/game.js";
import { slotActivity } from "../slots/activity.js";
import { createAdmissionCap } from "../net/admission.js";
import { KEEP_ALIVE_HOLD_MS, KEEP_ALIVE_MAX, KEEP_ALIVE_PATH, serveKeepAlive, startKeepAlive, type KeepAlive } from "../slots/keepAlive.js";
import { startSlotRunner, type SlotRunner } from "../slots/slotServer.js";
import type { ColonyId } from "../sim/types.js";
import type { SlotWiring } from "../server.js";
import type { MatchCore, ServerMode } from "./modes.js";

/**
 * A slot server's Cloud Run startup probe: 503 until this instance is the
 * slot's registered instance, then 200. Cloud Run routes no request to an instance
 * before its startup probe passes; until then every other route answers 503 too.
 * Once superseded this route and every other answer 503 again while the
 * server closes itself and its process exits.
 */
export const SLOT_READY_PATH = "/ready";

/** Longest a slot owner's self-probe of its public URL waits for an answer. */
const SLOT_PROBE_TIMEOUT_MS = 4000;

/** GET /lobbies/<id>/match: any slot server resolves a lobby's slot to its instance's addresses. */
const MATCH_ROUTE = /^\/lobbies\/([^/]+)\/match$/;

/** An error as one log field: its stack when it has one. */
function cause(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * A deployed slot server: it plays the matches of the lobbies that take its slot,
 * and no match starts here any other way. It serves nothing but its startup probe until its
 * runner has registered, keeps itself running while its slot is active,
 * and, superseded or signalled to shut down, saves its begun match for the
 * instance that takes the slot over.
 */
export function slotMode(wiring: SlotWiring, core: MatchCore): ServerMode {
  const { game, options } = core;
  let runner: SlotRunner | null = null;
  /** A slot server serves nothing but its startup probe until its runner has registered. */
  let slotReady = false;
  /** A slot server's self-request that keeps it running while its slot's Activity is not idle. */
  let keepAlive: KeepAlive | null = null;
  /** Keep-alive requests held at once on this server: anyone can send one. */
  const keepAliveCap = createAdmissionCap("keep-alive", { max: KEEP_ALIVE_MAX });
  /**
   * When a request last arrived at this server: counted on arrival, so a stream
   * or the keep-alive opened earlier never makes it look reachable; the startup probe and
   * the keep-alive are not counted at all.
   */
  let heardAt = Date.now();
  /** True from a failed self-probe until one succeeds, so a failing streak logs once. */
  let probeFailing = false;
  /**
   * True once another instance took this server's slot, or once it saves its
   * begun match for a handover: it answers every request 503, closes itself and
   * signals retirement, so only the slot's registered instance serves its players.
   */
  let retired = false;
  /** The save of this server's begun match, once supersession or the shutdown signal started it; it runs once. */
  let saving: Promise<boolean> | null = null;
  /**
   * The match this server's tick loop advances: only such a match is saved, so a
   * server that has restored a save but not yet restarted its loop never replaces that save.
   */
  let advancing: number | null = null;
  /**
   * The lobby whose nest-pick window this server runs: opened here, or resumed once
   * adopted. Only such a start is saved, as only an advanced match is.
   */
  let picking: string | null = null;
  /** True while the operator stop's terminal tick runs, so its result is recorded as stopped, never as natural. */
  let stopping = false;

  /** Finishes the open nest-pick window at closesAt, then runs its match. */
  function finishStartAt(seed: number, closesAt: number): void {
    const finishWhenClosed = (): void => {
      const remaining = closesAt - Date.now();
      // Node timers can fire before the wall-clock deadline. Keep the
      // same window and picks, and leave the retry cancellable too.
      if (remaining > 0) core.setTimer(finishWhenClosed, remaining);
      else core.runMatch(seed, true);
    };
    core.setTimer(finishWhenClosed, Math.max(0, closesAt - Date.now()));
  }

  /**
   * Handover resume of a begun match saved in its nest-pick window: no match stream
   * exists yet, so the feed is told of its lobby's seats, as host.seat tells it, in place of a
   * resumed match. A rejection fails the resume: the restored start is dropped and ends not played.
   */
  async function resumeStart(lobbyId: string, seats: readonly LobbySeat[]): Promise<boolean> {
    try {
      await options.feed?.lobbySeated?.(lobbyId, seats);
    } catch (err: unknown) {
      console.error(`antwar slot ${wiring.slot}: seating restored lobby ${lobbyId} with the spectator feed failed: ${cause(err)}`);
      game.dropResumed();
      return false;
    }
    console.log(`antwar slot ${wiring.slot}: lobby ${lobbyId} restored in its nest-pick window; waiting to adopt it`);
    return true;
  }

  /** A superseded server closes itself, then signals retirement once. */
  function retire(): void {
    core.close().then(() => wiring.onRetired?.(), (err: unknown) => {
      console.error(`antwar slot ${wiring.slot}: closing the superseded server failed: ${cause(err)}`);
      wiring.onRetired?.();
    });
  }

  /**
   * The one save step of a slot server's begun match, shared by its two triggers:
   * supersession (host.handOver) and Cloud Run's shutdown signal (shutdown). From its first
   * call the server answers every request 503, as a superseded server does. The
   * tick loop stops at a tick boundary and the match never advances here again; every call
   * still waiting for a tick is answered not_applied with a retry hint. Then the match and
   * its spectator side are captured and written as one save, naming this run as the last to
   * advance it. Resolves true once the save has committed; false when no begun match runs
   * here or the save failed, which leaves the match to end not played. Runs once: a later
   * trigger shares the first one's save.
   */
  function saveBegunMatch(trigger: "superseded" | "shutdown signal"): Promise<boolean> {
    saving ??= (async () => {
      retired = true;
      core.clearTimer();
      const slot = wiring.slot;
      // A begun match still in its nest-pick window is saved at tick 0, before any match stream exists.
      const start = game.openStart?.lobbyId === picking ? game.openStart : null;
      // A server configured without a save store or revision makes no save no server could resume:
      // its open start ends here not played, as before such starts were saved.
      if (start !== null && (wiring.revision === undefined || wiring.saves === undefined)) {
        console.log(`antwar slot ${slot}: ${trigger}; lobby ${start.lobbyId}'s nest-pick start is not saved: this server has no save store or revision`);
        return false;
      }
      const seq = game.match?.seq;
      const lobbyId = start !== null ? start.lobbyId : seq === advancing ? game.matchLobbyId : null;
      const tick = start !== null ? 0 : lobbyId === null ? null : game.stopForSave();
      const runId = runner?.runId;
      if (lobbyId === null || tick === null || (start === null && seq === undefined) || runId === undefined) {
        console.log(`antwar slot ${slot}: ${trigger}; no begun match runs here, so nothing is saved`);
        return false;
      }
      const startedAt = Date.now();
      try {
        const revision = wiring.revision, saves = wiring.saves;
        if (revision === undefined) throw new Error("this server's revision is unknown, so no server could resume its save");
        if (saves === undefined) throw new Error("no save store is configured");
        const gameSave = game.saveMatch();
        const spectator = start !== null || options.feed?.saveSpectator === undefined ? null : await options.feed.saveSpectator(seq!);
        await saves.write({ format: 1, lobbyId, revision, savedByRunId: runId, tick, savedAt: Date.now(), game: gameSave, spectator });
        console.log(`antwar slot ${slot}: ${trigger}; saved lobby ${lobbyId}'s match at tick ${tick}${start === null ? "" : " in its nest-pick window"} in ${Date.now() - startedAt} ms`);
        return true;
      } catch (err) {
        console.error(`antwar slot ${slot}: ${trigger}; saving lobby ${lobbyId}'s match at tick ${tick} failed after ${Date.now() - startedAt} ms, so it is not played: ${cause(err)}`);
        return false;
      }
    })();
    return saving;
  }

  async function begin(): Promise<void> {
    try {
      runner = await startSlotRunner<MatchSave>({
        slot: wiring.slot,
        lobbies: wiring.lobbies,
        mcpUrl: `${wiring.publicUrl}/mcp`,
        spectatorUrl: `${wiring.publicUrl}/`,
        ...(wiring.pollMs === undefined ? {} : { pollMs: wiring.pollMs }),
        ...(wiring.revision === undefined ? {} : { revision: wiring.revision }),
        ...(wiring.saves === undefined ? {} : { saves: wiring.saves }),
        ...(wiring.heartbeatMs === undefined ? {} : { heartbeatMs: wiring.heartbeatMs }),
        ...(wiring.staleMs === undefined ? {} : { staleMs: wiring.staleMs }),
        ...(wiring.unheardMs === undefined ? {} : { unheardMs: wiring.unheardMs }),
        heardAt: () => heardAt,
        probe() {
          // Through the platform's front end, as a player's request travels: arriving, it refreshes heardAt.
          const url = `${wiring.publicUrl}/wake`;
          fetch(url, { cache: "no-store", signal: AbortSignal.timeout(SLOT_PROBE_TIMEOUT_MS) })
            .then(async (res) => {
              await res.body?.cancel();
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              probeFailing = false;
            })
            .catch((err: unknown) => {
              if (core.isClosing()) return;
              if (!probeFailing) console.error(`antwar slot ${wiring.slot}: self-probe ${url} failed (players may not reach this instance; retried each heartbeat): ${cause(err)}`);
              probeFailing = true;
            });
        },
        host: {
          async seat(lobbyId, seats, startsAt, mode) {
            await options.feed?.lobbySeated?.(lobbyId, seats);
            game.seatLobby(lobbyId, seats, mode);
            game.setNextStart({ kind: "scheduled", at: new Date(startsAt) });
            console.log(`antwar slot ${wiring.slot}: lobby ${lobbyId} seated; its match starts at ${new Date(startsAt).toISOString()}`);
          },
          start() {
            const seed = options.seed ?? randomInt(2 ** 31);
            try {
              const closesAt = game.beginLobbyStart(seed);
              picking = game.openStart?.lobbyId ?? null;
              finishStartAt(seed, closesAt);
              return true; // Accepted preparation; no state or feed exists until the deadline.
            } catch (err: unknown) {
              console.error(`antwar slot ${wiring.slot} preparation failed: ${cause(err)}`);
              return false;
            }
          },
          async handOver() {
            console.log(`antwar slot ${wiring.slot}: superseded while playing its begun match; answering every request 503, saving the match, then shutting down`);
            const saved = await saveBegunMatch("superseded");
            // Nothing saved (the save failed, or the match has not advanced here yet, as in its nest-pick
            // start): the match ends here not played, as an abandoned one does.
            if (!saved) {
              game.endNotPlayed();
              game.setNextStart(null);
            }
            // Only once its save has finished or failed does the server close and signal retirement.
            retire();
            return saved;
          },
          async resume(save) {
            // Restored as this server's next match without advancing; its seats' key joins
            // answer lobby_loading until startResumed, once this run has adopted the match.
            try {
              game.resumeMatch(save.game);
            } catch (err: unknown) {
              console.error(`antwar slot ${wiring.slot}: restoring lobby ${save.lobbyId} at tick ${save.tick} failed: ${cause(err)}`);
              return false;
            }
            game.setResuming(true);
            if (save.game.phase === "start") return resumeStart(save.lobbyId, save.game.lobby.seats);
            const match = game.match!;
            try {
              const feed = options.feed;
              // Fail closed: a match whose spectators cannot continue is not resumed.
              if (feed !== undefined) {
                if (feed.matchResumed === undefined) throw new Error("this server's spectator feed cannot resume a match");
                if (save.spectator === null) throw new Error("the save carries no spectator side");
                await feed.matchResumed(match.seq, match.state, game, save.spectator);
              }
            } catch (err: unknown) {
              console.error(`antwar slot ${wiring.slot}: resuming lobby ${save.lobbyId}'s spectator side failed: ${cause(err)}`);
              game.dropResumed();
              return false;
            }
            console.log(`antwar slot ${wiring.slot}: lobby ${save.lobbyId} restored as match ${match.seq} at tick ${save.tick}; waiting to adopt it`);
            return true;
          },
          startResumed() {
            game.setResuming(false);
            const start = game.activateResumedStart();
            if (start !== null) {
              // Adopted in its nest-pick window: the window, open again from now, closes once the time it had left runs out, then the match runs as after start().
              picking = start.lobbyId;
              console.log(`antwar slot ${wiring.slot}: lobby ${start.lobbyId} resumed in its nest-pick window; its match starts at ${new Date(start.closesAt).toISOString()}`);
              finishStartAt(start.seed, start.closesAt);
              return;
            }
            const seq = game.match!.seq;
            // Saved again on supersession or shutdown: this run advances the resumed match.
            advancing = seq;
            const logName = core.openLog(seq);
            core.startTickReport();
            console.log(`antwar match ${seq} resumed at tick ${game.match!.state.tick}, log ${logName}`);
            core.tickLoop(seq, true);
            // Its spectators' listing moves to this run only now that it holds the match.
            if (runner !== null) options.feed?.matchAdopted?.(seq, runner.runId);
          },
          abandon() {
            // Answer nothing from here on: the slot's players belong to its registered instance.
            retired = true;
            core.clearTimer();
            game.dropResumed();
            game.endNotPlayed();
            game.setNextStart(null);
            console.log(`antwar slot ${wiring.slot}: superseded; answering every request 503 and shutting down`);
            // A save already under way (the shutdown signal's) finishes or fails before the server closes.
            if (saving === null) retire();
            else void saving.then(retire);
          },
          notPlayed(lobbyId, identityIds) {
            // A restored match this run could not adopt is dropped, so the slot's next match can start.
            game.dropResumed();
            game.endNotPlayed({ id: lobbyId, identityIds });
            game.setNextStart(null);
          },
        },
      });
    } catch (err) {
      await core.abortStart();
      throw err;
    }
    slotReady = true;
    keepAlive = startKeepAlive({ activity: slotActivity(wiring.slot), url: `${wiring.publicUrl}${KEEP_ALIVE_PATH}` });
  }

  return {
    kind: "slot",
    hostsMatches: true,
    operator: { token: options.operatorToken, startRefusal: "Matches on this slot server start only from lobbies" },
    routes: [
      { routeClass: KEEP_ALIVE_PATH, path: KEEP_ALIVE_PATH, handle: (req, res) => serveKeepAlive(req, res, slotActivity(wiring.slot), KEEP_ALIVE_HOLD_MS, keepAliveCap) },
      { routeClass: "/lobbies/:id/match", match: (path) => {
        const located = MATCH_ROUTE.exec(path);
        return located === null ? null : (req, res) => serveLocation(req, res, wiring, located[1]!);
      } },
    ],
    gate(path, res, routed) {
      if (retired) {
        // Superseded: another instance holds the slot and this one is shutting down.
        routed.routeClass = "(slot superseded)";
        res.writeHead(503, { "cache-control": "no-store", "retry-after": "1" }).end();
        return true;
      }
      if (path === SLOT_READY_PATH) {
        routed.routeClass = SLOT_READY_PATH;
        res.writeHead(slotReady ? 200 : 503, { "cache-control": "no-store" }).end();
        return true;
      }
      if (!slotReady) {
        // Not this slot's instance yet: a live owner of this revision still plays its match.
        routed.routeClass = "(slot not ready)";
        res.writeHead(503, { "cache-control": "no-store", "retry-after": "1" }).end();
        return true;
      }
      if (path !== KEEP_ALIVE_PATH) heardAt = Date.now();
      return false;
    },
    begin,
    matchStarted(seq) {
      advancing = seq;
    },
    matchEnded(result) {
      game.setNextStart(null);
      runner?.ended(result.reason === "abandoned" ? "abandoned" : stopping ? "stopped" : naturalOutcome(result.winner), game.matchThinkingLevels(), game.matchServiceTiers(), game.matchModelLabels(),
        game.matchAbsentColonies());
    },
    startFailed() {
      // The runner sees no running match and records it not played.
      game.endNotPlayed();
      game.setNextStart(null);
      runner?.ended("not_played");
    },
    startMatch() {
      if (game.match !== null && game.match.result === null) throw new Error("a match is already running");
      throw new Error("no held match to start");
    },
    stopMatch() {
      if (game.match === null || game.match.result !== null) throw new Error("no on-demand match running");
      core.clearTimer();
      stopping = true;
      // The terminal tick is a whole tick for the report only; the per-tick observer never saw it.
      const measuredAt = options.tickReport === undefined ? 0 : performance.now();
      try {
        core.publish(game.tick(true));
      } finally {
        stopping = false;
      }
      if (options.tickReport !== undefined) core.reportTick(performance.now() - measuredAt);
    },
    async shutdown(saveWithinMs) {
      // A slot server not already retired runs the handover's save step, which saves only a begun
      // match it advances; one already saving keeps that save.
      if (saving === null && retired) return;
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([saveBegunMatch("shutdown signal"), new Promise<void>((resolve) => { deadline = setTimeout(resolve, saveWithinMs); })]);
      clearTimeout(deadline);
    },
    close() {
      // Publishes no outcome: a restarted instance records the match as not played.
      runner?.close();
      keepAlive?.close();
    },
  };
}

/** The slot's view of the shared store that the Game reads its lobbies' seats through. */
export function slotAccess(wiring: SlotWiring): SlotAccess {
  return {
    recordJoin: (identityId, at) => wiring.identities.recordMatchJoin(identityId, at),
    async identityOf(key) {
      const resolved = await wiring.identities.resolveKey(key);
      return resolved.ok ? resolved.value.id : undefined;
    },
    holderOfVerifier: (verifier) => wiring.identities.holderOfVerifier(verifier),
    async locate(lobbyId) {
      const located = await wiring.lobbies.locate(lobbyId);
      return located.ok ? located.value : undefined;
    },
    async assignedLobby(identityId) {
      const holder = await wiring.lobbies.slotHolder(wiring.slot);
      return holder?.colonies.some(seats => seats.some(seat => seat.id === identityId)) ? holder.lobbyId : undefined;
    },
  };
}

/** Only the slot and the two addresses; the lobby's state, countdown and outcome stay on its keyed read. */
async function serveLocation(req: IncomingMessage, res: ServerResponse, wiring: SlotWiring, lobbyId: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    return reply(405, { error: "Use GET" });
  }
  let id: string;
  try {
    id = decodeURIComponent(lobbyId);
  } catch {
    return reply(404, { error: "no_such_lobby" });
  }
  const located = await wiring.lobbies.locate(id);
  if (!located.ok) return reply(404, { error: "no_such_lobby" });
  reply(200, { slot: located.value.slot, mcpUrl: located.value.mcpUrl, spectatorUrl: located.value.spectatorUrl });
}

/** A natural result as the lobby records it. */
function naturalOutcome(winner: ColonyId | null): MatchOutcome {
  return winner === null ? "draw" : winner === 0 ? "colony_0_won" : "colony_1_won";
}
