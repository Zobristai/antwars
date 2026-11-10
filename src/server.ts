/// <reference types="node" />
import { randomInt } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { GCProfiler } from "node:v8";
import { createAccountApi } from "./accounts/httpApi.js";
import { waitStreamRoutes } from "./accounts/waitStream.js";
import { startWaitSweep } from "./lobby/waits.js";
import { registerAccountTools } from "./accounts/mcpTools.js";
import type { AccountStores } from "./accounts/service.js";
import type { MatchSaves } from "./handover/saveStore.js";
import type { Identities } from "./identity/identities.js";
import type { SpectatorSave } from "./live/handover.js";
import { COUNTDOWN_MS, SLOT, type Lobbies } from "./lobby/lobbies.js";
import type { McpConfig } from "./mcp/config.js";
import { failureSummary, Game, type LobbySeat, type MatchAgent, type QueuedPlacement } from "./mcp/game.js";
import { createMcpHandler } from "./mcp/http.js";
import { registerMatchLocator } from "./mcp/tools.js";
import { createOperatorHandler } from "./operator.js";
import type { RecordHandoff } from "./records/handoff.js";
import { rulesConfig, type SimConfig } from "./sim/config.js";
import { newMatchConfig } from "./sim/gridScale.js";
import { FoodLayoutError } from "./sim/foodLayout.js";
import type { SimState, StepOutput } from "./sim/types.js";
import { median, percentile, TickStretches, type TickStretch } from "./tickStats.js";
import { checkModeOptions, selectMode, type MatchCore } from "./server/modes.js";
import { routeTable } from "./server/routes.js";
import { slotAccess } from "./server/slotMode.js";
import { SLOT_POLL_MS } from "./slots/slotServer.js";

export { isEntryPoint, MATCH_BREAK_MS } from "./server/modes.js";
export { SLOT_READY_PATH } from "./server/slotMode.js";

/** Finished match logs kept in the data directory; the oldest go when a new match starts. */
export const MAX_MATCH_LOGS = 10;

/** What a mounted route may read: the live match (running or ended, with its result), an open start window's config, the next start and how many agents wait for it. */
export type LiveGame = Pick<Game, "match" | "nextStart" | "queuedAgents" | "agentInfo"> &
  Partial<Pick<Game, "spectatorHouseIdle" | "startWindowConfig" | "undrawnConfig" | "seatedHouseUndrawnConfig">>;

export type MountHandler = (req: IncomingMessage, res: ServerResponse, live: LiveGame) => void | Promise<void>;

/**
 * Receives each match's start and every tick's output, in order, as the server
 * runs them (the spectator stream is fed from the tick loop).
 */
export interface MatchFeed {
  matchStarted(seq: number, state: SimState, live: LiveGame): void;
  /** Prepare immutable spectator access/player metadata before a slot exposes its newly seated lobby. */
  lobbySeated?(lobbyId: string, seats: readonly LobbySeat[]): Promise<void>;
  /** Called after a final tick has set the next start, so the feed can deliver it with the result. */
  ticked(seq: number, out: StepOutput, live: LiveGame): void;
  /**
   * Optional recording-only capture: each tick's input line, called before that tick's output, and each seat's
   * call reply line (src/replays/recording.ts replyLine), as the call is answered.
   */
  logLine?(seq: number, line: string): void;
  /** Handover save step: the spectator side of match seq after its last pushed tick. A rejection is a failed save. */
  saveSpectator?(seq: number): Promise<SpectatorSave>;
  /** Instead of matchStarted, for a match resumed from a save at state.tick, before the first resumed tick. A rejection fails the resume. */
  matchResumed?(seq: number, state: SimState, live: LiveGame, save: SpectatorSave): Promise<void>;
  /** This server's run, runId, adopted match seq resumed by matchResumed: from now it is that run's match. */
  matchAdopted?(seq: number, runId: string): void;
}

export interface TickTiming {
  readonly seq: number;
  readonly tick: number;
  /** Full synchronous tick-loop work, including log writes and the public feed. */
  readonly workMs: number;
  readonly lateMs: number;
}

/** Where a deployed server's per-match tick reports go. */
export interface TickReportOptions {
  /** Receives each tick report line; the deployed bootstrap writes them to stdout (Cloud Run logs). */
  readonly log: (line: string) => void;
  /** Ticks per stretch; default 60 s of match time (60 × ticksPerSecond = 600). Tests set it small. */
  readonly stretchTicks?: number;
}

export interface ServerOptions {
  readonly port: number;
  readonly dataDir: string;
  /** Interface to listen on; all interfaces when omitted. */
  readonly host?: string;
  /**
   * Omitted: a non-playing entry point, unless this is a slot or explicit scheduled harness.
   * Private harnesses: "immediate" starts once, "held" starts once on request.
   */
  readonly match?: "immediate" | "held";
  /** Existing private scheduling harness only. Not read from the public deployment environment. */
  readonly breakMs?: number;
  /** Slot operator bearer credential; unset/blank disables HTTP controls. */
  readonly operatorToken?: string;
  /** Hands finished matches' inputs to the record service; shutdown drains it. */
  readonly recordHandoff?: RecordHandoff;
  readonly simConfig?: SimConfig;
  /** Explicit test configuration only. Production startup omits it and retains the 120-second window. */
  readonly startPickWindowMs?: number;
  readonly mcpConfig?: McpConfig;
  readonly maxMatchLogs?: number;
  /** Called with each reconnect token the game issues (playtest redaction). */
  readonly onTokenIssued?: (token: string) => void;
  readonly feed?: MatchFeed;
  /** Opt-in test/diagnostic observer. Omitted: no timing calls, samples, logging or extra timers. */
  readonly onTickTiming?: (sample: TickTiming) => void;
  /** Deployed bootstrap (src/main.ts): when set, every match's whole-tick times are measured and reported. Omitted: no report, as today. */
  readonly tickReport?: TickReportOptions;
  /** Comparison mode: every match uses this seed instead of a random one. */
  readonly seed?: number;
  /**
   * Join barrier: with match "held", the held match starts
   * once this many accepted joins are queued, after the reply to the join that
   * completed the count has gone out.
   */
  readonly expectedPlayers?: number;
  /**
   * Comparison mode: also print every match-log line to stdout as
   * "ANTWAR_MATCH_LOG <match>:<line index> <line>", so Cloud Logging keeps the recording.
   */
  readonly matchLogStdout?: boolean;
  /** Explicit comparison-only spectator metadata opt-in; never inferred from the simulation's rules. */
  readonly includeComparisonSetup?: boolean;
  /**
   * Deployed slot servers only: this instance plays the matches of the
   * lobbies that take this slot, and no match starts here any other way. Never
   * combined with match or comparison options.
   */
  readonly slot?: SlotWiring;
  /**
   * The shared store's identities, lobbies and ratings: when set, their
   * operations are served as MCP tools on /mcp and as POST /api/<operation>,
   * and waiting tokens' streams on GET /wait/<token>.
   */
  readonly accounts?: AccountStores;
}

export interface SlotWiring {
  /** Such as "public-0". */
  readonly slot: string;
  /** This instance's public origin, without a trailing slash; its MCP and spectator addresses derive from it. */
  readonly publicUrl: string;
  readonly lobbies: Lobbies;
  readonly identities: Identities;
  readonly pollMs?: number;
  /** This instance's Cloud Run revision (K_REVISION), so it defers to a live owner of the same one. */
  readonly revision?: string;
  readonly heartbeatMs?: number;
  readonly staleMs?: number;
  /** An owner that heard no request for this long is unreachable to a waiting instance; SLOT_UNHEARD_MS by default. */
  readonly unheardMs?: number;
  /**
   * Called once after this server, superseded by another instance of its slot, has
   * closed itself; the production bootstrap exits the process (src/main.ts).
   * A server superseded while running its begun match first saves it, so
   * this is called only after that save has finished or failed.
   */
  readonly onRetired?: () => void;
  /**
   * Where a handover save of this server's begun match is written, on supersession or on
   * the shutdown signal. Absent, or without a revision to resume it under, such
   * a save fails, and the match ends not played as before. With a revision, a successor reads it
   * to resume a same-revision save of the match it takes over.
   */
  readonly saves?: MatchSaves;
}

/** The stdout prefix of comparison-mode match-log lines. */
export const MATCH_LOG_PREFIX = "ANTWAR_MATCH_LOG";

export interface GameServer {
  readonly port: number;
  readonly game: LiveGame;
  /** Release a private held match; the entry point cannot start matches. */
  startMatch(): void;
  /** End a slot match synchronously, including pending calls and its normal final feed. */
  stopMatch(): void;
  /** Where each agent queued for the next match will be placed, with its seat key. */
  queuedLineup(): QueuedPlacement[];
  /** The current match's agents, each with whether an answer to it has carried the result. */
  matchAgents(): MatchAgent[];
  /** Serve requests under prefix ("/" or "/name", no trailing slash) on this port; /mcp always goes to MCP and the longest matching prefix wins. */
  mount(prefix: string, handler: MountHandler): void;
  close(): Promise<void>;
  /**
   * Cloud Run's shutdown signal: a slot server running its begun match, or already
   * saving it, saves it with the handover's save step, waiting at most saveWithinMs for the
   * save to finish or fail; meanwhile, within the same time, its record handoff drains any
   * finished match's inputs still awaiting storage. Then the server closes, as close() does.
   * Resolves once closed.
   */
  shutdown(saveWithinMs: number): Promise<void>;
}

/**
 * How long the shutdown signal's save may take: Cloud Run allows 10 s from
 * SIGTERM before it kills the instance, and closing and exiting take the rest.
 */
export const SHUTDOWN_SAVE_MS = 9000;

const LOG_NAME = /^match-.*\.jsonl$/;

/**
 * One bounded line for a contained tick or publish failure: the match, the tick, the phase and the error's
 * summary (failureSummary). Never the stack or any match state.
 */
function logTickFailure(seq: number, tick: number, phase: "tick" | "match end" | "feed", err: unknown): void {
  console.error(`antwar match ${seq} tick ${tick} failed in ${phase}: ${failureSummary(err)}`);
}

/** An error as one log field: its stack when it has one. */
function cause(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * The one module that wires sim, mcp and live together:
 * one HTTP port serving /mcp and mounted routes, matches ticked in real time,
 * and one append-only JSONL log per match in the data directory. The common
 * tick and route core lives here; each deployment mode's wiring (entry,
 * harness, comparison, slot) is one mode object composed with it.
 */
export async function startServer(options: ServerOptions): Promise<GameServer> {
  checkModeOptions(options);
  const { dataDir } = options;
  const maxLogs = options.maxMatchLogs ?? MAX_MATCH_LOGS;
  mkdirSync(dataDir, { recursive: true });

  let logPath: string | null = null;
  // Index of the next match-log line within the current match, for the stdout copy.
  let logIndex = 0;
  // Log lines of the current match that could not be written; the first is reported, the rest counted.
  let failedLines = 0;

  /**
   * A failed write is reported and play continues: it runs inside the tick timer,
   * where a throw would end the process and the live match.
   */
  function writeLogLine(line: string): void {
    // The start header precedes matchStarted; its state/config is supplied there.
    if (!line.startsWith('{"type":"header"')) options.feed?.logLine?.(game.match!.seq, line);
    if (options.matchLogStdout === true) process.stdout.write(`${MATCH_LOG_PREFIX} ${game.match?.seq ?? 0}:${logIndex++} ${line}\n`);
    try {
      appendFileSync(logPath!, `${line}\n`);
    } catch (err) {
      failedLines += 1;
      if (failedLines === 1) {
        console.error(`antwar match ${game.match?.seq} log write failed (later failures this match are counted): ${cause(err)}`);
      }
    }
  }

  /** The match whose reply recording last failed, reported once. */
  let replyFailedSeq: number | null = null;
  /**
   * A seat's call reply line goes to its match's recording only: never the match log file or its stdout copy.
   * It runs inside a tool call, so a failure is reported once per match and the call is answered as usual.
   */
  function recordReplyLine(seq: number, line: string): void {
    try {
      options.feed?.logLine?.(seq, line);
    } catch (err) {
      if (replyFailedSeq === seq) return;
      replyFailedSeq = seq;
      console.error(`antwar match ${seq} call reply not recorded (later failures this match are not reported): ${cause(err)}`);
    }
  }

  const game = new Game({
    ...(options.simConfig === undefined ? {} : { simConfig: options.simConfig }),
    ...(options.startPickWindowMs === undefined ? {} : { startPickWindowMs: options.startPickWindowMs }),
    // A seat's wait before its nest pick opens: the lobby countdown and one slot poll (its pre-match recording allowance).
    preStartMs: (options.slot?.lobbies.countdownMs ?? COUNTDOWN_MS) + (options.slot?.pollMs ?? SLOT_POLL_MS),
    ...(options.mcpConfig === undefined ? {} : { mcpConfig: options.mcpConfig }),
    onLogLine: writeLogLine,
    onReply: recordReplyLine,
    ...(options.onTokenIssued === undefined ? {} : { onTokenIssued: options.onTokenIssued }),
    ...(options.slot === undefined ? {} : { slot: slotAccess(options.slot) }),
  });
  /** The current match's pending tick, break or start-window timer. */
  let timer: NodeJS.Timeout | null = null;
  /** True once close() has begun: a self-probe failing then is this server shutting down, not unreachable. */
  let closing = false;
  /** The one close of this server, shared by close() and a superseded server's retirement. */
  let closed: Promise<void> | null = null;
  /** The current match's whole-tick times in tick order, kept only while tickReport is set. */
  let tickTimes: number[] = [];
  /**
   * The current match's stretches, while tickReport is set, with a GC record that
   * captures every collection as it runs, so one in a stretch's closing tick counts in that stretch.
   */
  let stretches: { readonly ticks: TickStretches; readonly gc: GCProfiler } | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const core: MatchCore = {
    game, options, runMatch, tickLoop, openLog, startTickReport, publish, reportTick, clearTimer, close,
    setTimer: (run, ms) => { timer = setTimeout(run, ms); },
    isClosing: () => closing,
    abortStart: async () => {
      server.closeAllConnections();
      server.close();
      await handler.close();
    },
  };
  const mode = selectMode(options, core);

  const accounts = options.accounts;
  // Only a match slot limits each client source's evictions at the session cap.
  // Only a server with neither accounts nor a slot, run outside Cloud Run (K_SERVICE unset), briefs without
  // account and lobby text: a newcomer's npm start. Every hosted service, antwar-preview included, keeps it.
  const handler = createMcpHandler(game, { gameplay: mode.hostsMatches, localBriefing: accounts === undefined && options.slot === undefined && !process.env.K_SERVICE, perSourceInitializeLimit: mode.kind === "slot", ...(accounts === undefined ? {} : { extraTools: (server, session) => {
    // Only the entry server (no slot) refuses seat client 1.0.0 its entry calls.
    registerAccountTools(server, accounts, { seatClientAdmission: mode.kind !== "slot", session });
    if (mode.kind !== "slot") registerMatchLocator(server, async (lobbyId) => {
      const located = await accounts.lobbies.locate(lobbyId);
      return located.ok ? located.value : undefined;
    }, { seatClientAdmission: true });
  } }) });
  const mounts: { prefix: string; handler: MountHandler }[] = [];
  // /api bodies: MCP's read deadline and body-read cap values, counted in a pool of their own.
  const { bodyReadMs, maxUnadmittedBodies, maxUnadmittedBodiesPerSource } = game.mcpConfig;
  if (accounts !== undefined) mounts.push({ prefix: "/api", handler: createAccountApi(accounts, { bodyReadMs, maxBodies: maxUnadmittedBodies, maxBodiesPerSource: maxUnadmittedBodiesPerSource }) });
  // The public wait stream for the waiting tokens join_queue, join_lobby and request_challenge return; the stores are read per request, never here.
  if (accounts !== undefined) mounts.push({ prefix: "/wait", handler: waitStreamRoutes({ waitStatus: (token) => accounts.lobbies.waitStatus(token) }) });
  // Expired wait records of every kind are swept on a timer, never at startup and never only on joins (src/lobby/waits.ts).
  const stopWaitSweep = accounts === undefined ? undefined : startWaitSweep(() => accounts.lobbies.sweepWaits());

  /**
   * Delete the oldest finished logs so at most maxLogs remain; runs before the new match's log exists.
   * A failure is reported and the match starts anyway.
   */
  function pruneLogs(): void {
    try {
      const names = readdirSync(dataDir).filter((n) => LOG_NAME.test(n)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - maxLogs))) rmSync(join(dataDir, name), { force: true });
    } catch (err) {
      console.error(`antwar match log prune failed: ${cause(err)}`);
    }
  }

  /**
   * Shared by natural completion and an operator's terminal tick. A failure here comes after the tick has
   * advanced and been logged, so it is contained and logged: the match keeps ticking and its result stands.
   */
  function publish(out: StepOutput | null): void {
    if (out === null) return;
    const match = game.match!;
    if (match.result !== null) {
      console.log(`antwar match ${match.seq} ended after ${match.state.tick} ticks: winner ${match.result.winner ?? "none (draw)"}, ${match.result.reason}, decided by ${match.result.decidedBy}; ${failedLines} log lines failed to write`);
      try {
        mode.matchEnded(match.result);
      } catch (err) {
        logTickFailure(match.seq, match.state.tick, "match end", err);
      }
    }
    try {
      options.feed?.ticked(match.seq, out, game);
    } catch (err) {
      logTickFailure(match.seq, match.state.tick, "feed", err);
    }
  }

  /** One stretch line, with the heap at its close and the GC time run during the stretch; the next stretch's GC record starts unless the match ended. */
  function logStretch(report: TickReportOptions, seq: number, stretch: TickStretch, ended: boolean): void {
    const heap = process.memoryUsage();
    // GCProfiler reports each collection's cost in microseconds.
    const gcMs = stretches!.gc.stop()!.statistics.reduce((sum, gc) => sum + gc.cost, 0) / 1000;
    if (!ended) stretches!.gc.start();
    const fields = { fromTick: stretch.fromTick, toTick: stretch.toTick, p99Ms: stretch.p99Ms, heapUsedBytes: heap.heapUsed, heapTotalBytes: heap.heapTotal, gcMs };
    report.log(`antwar match ${seq} tick stretch ${stretch.index}: ${JSON.stringify(fields)}`);
  }

  /**
   * Records one whole-tick time while tickReport is set, logging each stretch as its
   * last tick runs. After the match's final tick, natural, abandoned or stopped, it closes the
   * final, partial stretch and then logs the match report: the tick count, the exact median and
   * nearest-rank p90 over every tick, the map and the per-side ant cap.
   */
  function reportTick(workMs: number): void {
    const report = options.tickReport;
    if (report === undefined) return;
    tickTimes.push(workMs);
    const match = game.match!;
    const ended = match.result !== null;
    const full = stretches!.ticks.add(workMs);
    const last = ended ? stretches!.ticks.finish() : null;
    if (full !== null) logStretch(report, match.seq, full, ended && last === null);
    if (last !== null) logStretch(report, match.seq, last, true);
    if (!ended) return;
    stretches = null;
    const sorted = Float64Array.from(tickTimes).sort();
    tickTimes = [];
    const figures = { ticks: sorted.length, medianMs: median(sorted), p90Ms: percentile(sorted, 90), map: match.state.terrain?.mapId ?? null, colonyCap: match.state.config.colonyCap };
    report.log(`antwar match ${match.seq} tick report: ${JSON.stringify(figures)}`);
  }

  const running = () => game.match !== null && game.match.result === null;
  const operator = createOperatorHandler(mode.operator.token, {
    running,
    start: () => {
      mode.startMatch();
      // dispatch contains this error and answers 500, not a false "Match started".
      if (!running()) throw new Error("Food layout prevented match start");
    },
    stop: () => mode.stopMatch(),
    ...(mode.operator.startRefusal === undefined ? {} : { startRefusal: mode.operator.startRefusal }),
  });

  /** Starts match seq's log file, after pruning the oldest finished logs; returns its name. */
  function openLog(seq: number): string {
    pruneLogs();
    const logName = `match-${new Date().toISOString().replace(/[:.]/g, "-")}-${seq}.jsonl`;
    logPath = join(dataDir, logName);
    failedLines = 0;
    logIndex = 0;
    return logName;
  }

  /** The current match's tick report starts over; nothing while tickReport is unset. */
  function startTickReport(): void {
    tickTimes = [];
    if (options.tickReport !== undefined) {
      stretches = { ticks: new TickStretches(options.tickReport.stretchTicks ?? 60 * game.simConfig.ticksPerSecond), gc: new GCProfiler() };
      stretches.gc.start();
    }
  }

  function runMatch(seed = options.seed ?? randomInt(2 ** 31), finalizedLobby = false): void {
    timer = null;
    const seq = (game.match?.seq ?? 0) + 1;
    const logName = openLog(seq);
    try {
      // Game builds the state before publishing it or writing the header. A
      // layout failure therefore leaves the prior match and queued seats intact.
      if (finalizedLobby) game.finishLobbyStart();
      else game.startMatch(seed);
    } catch (err: unknown) {
      if (!(err instanceof FoodLayoutError) && !finalizedLobby) throw err;
      console.error(`antwar match ${seq} start failed: seed ${seed}: ${cause(err)}`);
      logPath = null;
      mode.startFailed();
      return;
    }
    mode.matchStarted?.(seq);
    startTickReport();
    options.feed?.matchStarted(seq, game.match!.state, game);
    console.log(`antwar match ${seq} started: seed ${seed}, log ${logName}`);
    tickLoop(seq, finalizedLobby);
  }

  /**
   * Ticks the current match in real time until it ends: its first tick at once when
   * immediate, otherwise one tick period from now.
   */
  function tickLoop(seq: number, immediate: boolean): void {
    const tickMs = 1000 / game.simConfig.ticksPerSecond;
    const startedAt = Date.now() - (immediate ? tickMs : 0);
    let ticks = 0;
    // True while ticks run late, so one stall gives one warning rather than one per catch-up tick.
    let lagging = false;
    // The observer and the tick report share one whole-tick measurement.
    const timed = options.onTickTiming !== undefined || options.tickReport !== undefined;
    // Each tick is due at startedAt + n * tickMs, so timer lateness never accumulates.
    const loop = (): void => {
      const measuredAt = timed ? performance.now() : 0;
      const lateMs = Date.now() - (startedAt + (ticks + 1) * tickMs);
      if (lateMs > tickMs) {
        if (!lagging) console.warn(`antwar match ${seq} tick ${ticks + 1} ran ${Math.round(lateMs)} ms late`);
        lagging = true;
      } else {
        lagging = false;
      }
      let out: StepOutput | null;
      try {
        out = game.tick();
      } catch (err) {
        // Last resort: game.tick ends a failed tick's match itself. Reaching here, that ending failed too, so this
        // match's timer stops; the process and every other match go on.
        logTickFailure(seq, ticks + 1, "tick", err);
        timer = null;
        return;
      }
      ticks += 1;
      const result = game.match!.result;
      timer = null;
      publish(out);
      if (result === null) timer = setTimeout(loop, Math.max(0, startedAt + (ticks + 1) * tickMs - Date.now()));
      if (timed) {
        const workMs = performance.now() - measuredAt;
        options.onTickTiming?.({ seq, tick: ticks, workMs, lateMs: Math.max(0, lateMs) });
        reportTick(workMs);
      }
    };
    if (immediate) loop();
    else timer = setTimeout(loop, tickMs);
  }

  /** A join's reply has gone out: the comparison mode's barrier may release its held match. */
  const replied = (): void => mode.replied?.();
  /** The fixed routes, the core's and the mode's; a request no route takes goes to the mounts. */
  const routes = routeTable([
    // A slot's server is woken by any request; this one has nothing else to do.
    { routeClass: "/wake", path: "/wake", handle: (req, res) => {
      if (req.method === "GET") res.writeHead(204, { "cache-control": "no-store" }).end();
      else res.writeHead(405, { allow: "GET" }).end();
    } },
    { routeClass: "/operator", path: "/operator", handle: serveOperator },
    { routeClass: "/operator", under: "/operator/", handle: serveOperator },
    { routeClass: "/mcp", path: "/mcp", handle: (req, res) => {
      res.once("finish", replied);
      return handler.handle(req, res);
    } },
    ...mode.routes,
  ]);

  /** The operator controls of a server that plays matches; a non-playing one has none. */
  function serveOperator(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (!mode.hostsMatches) res.writeHead(404).end();
    else operator(req, res, path);
  }

  /**
   * Request input is untrusted: a target that is not a valid URL gets 400, and any
   * error thrown or rejected while dispatching to /mcp or a mount gets 500. Neither
   * reaches the process. Malformed request lines and headers that node:http itself
   * rejects never reach here: it answers them 400 on its own.
   */
  async function dispatch(req: IncomingMessage, res: ServerResponse, routed: { routeClass: string }): Promise<void> {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (mode.gate?.(path, res, routed) === true) return;
    const route = routes.resolve(path);
    if (route !== null) {
      routed.routeClass = route.routeClass;
      await route.handle(req, res, path);
      return;
    }
    const mount = mounts.find((m) => m.prefix === "/" || path === m.prefix || path.startsWith(`${m.prefix}/`));
    if (mount === undefined) {
      res.writeHead(404).end();
      return;
    }
    routed.routeClass = mount.prefix;
    await mount.handler(req, res, game);
  }

  /**
   * A 500 is logged with the method, the route class and the cause. Never the URL:
   * its path and query string are the client's.
   */
  function route(req: IncomingMessage, res: ServerResponse): void {
    const routed = { routeClass: "(unrouted)" };
    dispatch(req, res, routed).catch((err: unknown) => {
      console.error(`antwar 500 ${req.method} ${routed.routeClass}: ${cause(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }

  const server = createServer(route);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  await mode.begin();

  /** Closes once however often it is called: by its owner, or by itself once superseded. */
  function close(): Promise<void> {
    closed ??= (async () => {
      closing = true;
      mode.close?.();
      game.closeJoinActivity();
      clearTimer();
      stopWaitSweep?.();
      // A match still running reports nothing more; its GC record is released.
      stretches?.gc.stop();
      stretches = null;
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return closed;
  }

  return {
    port: (server.address() as AddressInfo).port,
    game,
    startMatch: () => mode.startMatch(),
    stopMatch: () => mode.stopMatch(),
    queuedLineup: () => game.queuedLineup(),
    matchAgents: () => game.matchAgents(),
    mount(prefix, mountHandler) {
      mounts.push({ prefix, handler: mountHandler });
      mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    },
    close,
    async shutdown(saveWithinMs) {
      // Finished matches' record inputs still awaiting storage drain alongside the save, within the same time.
      const drained = options.recordHandoff?.drain?.(saveWithinMs);
      // The mode's shutdown step: a slot server not already retired saves its begun match, waiting at most saveWithinMs.
      await mode.shutdown?.(saveWithinMs);
      await drained;
      await close();
    },
  };
}

/**
 * The deployed slot server's settings, read once at start-up. ANTWAR_SLOT
 * unset or empty: not a slot server. Set, it names the slot ("public-0"), and needs
 * ANTWAR_PUBLIC_URL (this instance's public origin) and ANTWAR_STORE_NAMESPACE. It is
 * refused with comparison mode's ANTWAR_RULES or ANTWAR_PLAYERS, so local and
 * comparison matches never reach live lobby data. Cloud Run's K_REVISION, when set,
 * is the revision a starting instance compares with the slot owner's, so a
 * same-revision extra instance defers to a live owner. Any invalid
 * setting throws.
 */
export function slotOptions(env: Readonly<Record<string, string | undefined>>): { readonly slot: string; readonly publicUrl: string; readonly revision?: string } | undefined {
  const slot = env.ANTWAR_SLOT;
  if (slot === undefined || slot === "") return undefined;
  if (env.ANTWAR_RULES !== undefined || env.ANTWAR_PLAYERS !== undefined) {
    throw new Error("ANTWAR_SLOT cannot be combined with comparison mode (ANTWAR_RULES or ANTWAR_PLAYERS)");
  }
  if (!SLOT.test(slot)) throw new Error(`ANTWAR_SLOT must be public-<n> or private-<n>; got ${JSON.stringify(slot)}`);
  if (!env.ANTWAR_STORE_NAMESPACE) throw new Error("ANTWAR_SLOT needs ANTWAR_STORE_NAMESPACE");
  let url: URL;
  try {
    url = new URL(env.ANTWAR_PUBLIC_URL ?? "");
  } catch {
    throw new Error("ANTWAR_SLOT needs ANTWAR_PUBLIC_URL, this instance's public http(s) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ANTWAR_PUBLIC_URL must be an http(s) origin");
  return { slot, publicUrl: url.origin, ...(env.K_REVISION ? { revision: env.K_REVISION } : {}) };
}

/**
 * Match slots per lobby kind, read once at start-up from
 * ANTWAR_PUBLIC_SLOTS and ANTWAR_PRIVATE_SLOTS. Unset or empty is 1: the launch
 * cap of one public and one private slot, as every server had before. The slot
 * deploy sets both on every slot service so all agree on the slot set. Anything
 * other than a positive whole number throws.
 */
export function lobbySlotOptions(env: Readonly<Record<string, string | undefined>>): { readonly publicSlots: number; readonly privateSlots: number } {
  const count = (name: "ANTWAR_PUBLIC_SLOTS" | "ANTWAR_PRIVATE_SLOTS") => {
    const value = env[name];
    if (value === undefined || value === "") return 1;
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive whole number; got ${JSON.stringify(value)}`);
    return Number(value);
  };
  return { publicSlots: count("ANTWAR_PUBLIC_SLOTS"), privateSlots: count("ANTWAR_PRIVATE_SLOTS") };
}

/** The fixed seed of every comparison match: paired matches share it across rule sets. */
export const COMPARISON_SEED = 6006;

/**
 * Server options for a comparison run, read once at start-up from
 * ANTWAR_RULES and ANTWAR_PLAYERS. ANTWAR_RULES unset selects
 * redesign for ordinary scheduled public matches and never reads ANTWAR_PLAYERS.
 * It adds no barrier, seed override or seat override. Set (v4 included), it selects the rules, holds one match at a
 * join barrier of ANTWAR_PLAYERS (2 or 4) with that many seats, seed 6006, and
 * copies the match log to stdout. Any other value of either throws.
 */
export function comparisonOptions(env: Readonly<Record<string, string | undefined>>, mcp: McpConfig): Partial<ServerOptions> {
  const rules = env.ANTWAR_RULES;
  if (rules === undefined) return { simConfig: newMatchConfig(rulesConfig("redesign")) };
  const simConfig = newMatchConfig(rulesConfig(rules));
  const players = env.ANTWAR_PLAYERS === "2" ? 2 : env.ANTWAR_PLAYERS === "4" ? 4 : null;
  if (players === null) {
    throw new Error(`ANTWAR_PLAYERS must be 2 or 4 when ANTWAR_RULES is set; got ${JSON.stringify(env.ANTWAR_PLAYERS ?? null)}`);
  }
  return {
    simConfig: { ...simConfig, players },
    mcpConfig: { ...mcp, maxAgentsPerMatch: players },
    match: "held",
    expectedPlayers: players,
    seed: COMPARISON_SEED,
    matchLogStdout: true,
    includeComparisonSetup: true,
  };
}
