/// <reference types="node" />
import type { ServerResponse } from "node:http";
import type { Game } from "../mcp/game.js";
import type { MatchResult, StepOutput } from "../sim/types.js";
import type { ServerOptions } from "../server.js";
import type { Route } from "./routes.js";
import { slotMode } from "./slotMode.js";

/** Gap between one match's end and the next start, and from boot to the first. */
export const MATCH_BREAK_MS = 60_000;

/** Default non-slot startup serves discovery and accounts, never a match. */
export function isEntryPoint(options: Pick<ServerOptions, "slot" | "match" | "breakMs">): boolean {
  return options.slot === undefined && options.match === undefined && options.breakMs === undefined;
}

/**
 * The common core of a server that every mode composes with: the live
 * match's lifecycle, its tick loop and logs, and the server's one close.
 */
export interface MatchCore {
  readonly game: Game;
  readonly options: ServerOptions;
  /** Starts the next match: a fresh one from seed, or, finalizedLobby, the open lobby start at its deadline. */
  runMatch(seed?: number, finalizedLobby?: boolean): void;
  /** Ticks match seq in real time until it ends; its first tick at once when immediate. */
  tickLoop(seq: number, immediate: boolean): void;
  /** Starts match seq's log file; returns its name. */
  openLog(seq: number): string;
  /** The current match's tick report starts over. */
  startTickReport(): void;
  /** Publishes one tick's output; a final one ends the match through the mode. */
  publish(out: StepOutput | null): void;
  /** Records one whole-tick time for the tick report. */
  reportTick(workMs: number): void;
  /** Sets the server's one match timer (a plain assignment: a pending one is not cleared first); clearTimer cancels it. */
  setTimer(run: () => void, ms: number): void;
  clearTimer(): void;
  /** Closes the server once, however often called. */
  close(): Promise<void>;
  /** True once close() has begun. */
  isClosing(): boolean;
  /** Undoes a listening server whose mode could not begin: no connection, no MCP handler. */
  abortStart(): Promise<void>;
}

/** What answered a request ahead of the routes, for the 500 log. */
export interface Routed {
  routeClass: string;
}

/**
 * One deployment mode's wiring around the core: what it serves, how its
 * matches start and end, and what it does on shutdown. Exactly one mode serves a server.
 */
export interface ServerMode {
  readonly kind: "entry" | "harness" | "comparison" | "slot";
  /** Whether this server plays matches: MCP gameplay tools and the operator route. */
  readonly hostsMatches: boolean;
  /** The operator controls' bearer token and start refusal; a mode without a token disables them. */
  readonly operator: { readonly token?: string; readonly startRefusal?: string };
  /** Routes only this mode serves, disjoint from the core's. */
  readonly routes: readonly Route[];
  /** Answers a request ahead of every route, returning true, or returns false to route it. */
  gate?(path: string, res: ServerResponse, routed: Routed): boolean;
  /** Once the reply to a join on /mcp has gone out. */
  replied?(): void;
  /** Once the server listens. A rejection fails startServer. */
  begin(): void | Promise<void>;
  /** A match runMatch started is now this server's to advance. */
  matchStarted?(seq: number): void;
  /** The current match has its result, published by its final tick. */
  matchEnded(result: MatchResult): void;
  /** runMatch could not start a match (a food-layout failure, or a lobby start's finish). */
  startFailed(): void;
  /** GameServer.startMatch. */
  startMatch(): void;
  /** GameServer.stopMatch. */
  stopMatch(): void;
  /** GameServer.shutdown's step before the server closes. */
  shutdown?(saveWithinMs: number): Promise<void>;
  /** The mode's own part of the server's one close, first. */
  close?(): void;
}

/** Refuses a combination of modes, before anything is created. */
export function checkModeOptions(options: ServerOptions): void {
  if (options.slot !== undefined && (options.match !== undefined || options.breakMs !== undefined || options.expectedPlayers !== undefined)) {
    throw new Error("a slot server starts matches only from lobbies");
  }
}

/** The one mode a server's options select. */
export function selectMode(options: ServerOptions, core: MatchCore): ServerMode {
  if (options.slot !== undefined) return slotMode(options.slot, core);
  if (isEntryPoint(options)) return entryMode();
  if (options.expectedPlayers !== undefined) return comparisonMode(core, options.expectedPlayers);
  return harnessMode(core);
}

const NO_ON_DEMAND_MATCH = "no on-demand match running";

/** The default deployment: discovery and accounts, never a match. */
export function entryMode(): ServerMode {
  return {
    kind: "entry",
    hostsMatches: false,
    operator: {},
    routes: [],
    begin() {},
    matchEnded() {},
    startFailed() {},
    startMatch() {
      throw new Error("The entry point does not host matches; use a lobby slot");
    },
    stopMatch() {
      throw new Error(NO_ON_DEMAND_MATCH);
    },
  };
}

/**
 * A private harness: match "immediate" starts one at once, "held" starts one on request, and
 * breakMs alone schedules every match breakMs after the last (or boot). A start that fails is
 * held, unless scheduled.
 */
export function harnessMode(core: MatchCore): ServerMode {
  return harness(core, "harness");
}

/**
 * The comparison run: a held harness whose match starts once expectedPlayers accepted
 * joins are queued, after the reply to the join that completed the count has gone out.
 */
export function comparisonMode(core: MatchCore, expectedPlayers: number): ServerMode {
  return harness(core, "comparison", expectedPlayers);
}

function harness(core: MatchCore, kind: "harness" | "comparison", expectedPlayers?: number): ServerMode {
  const { game, options } = core;
  const breakMs = options.breakMs ?? MATCH_BREAK_MS;
  const scheduled = options.match === undefined && options.breakMs !== undefined;
  let held = options.match === "held";

  function schedule(): void {
    game.setNextStart({ kind: "scheduled", at: new Date(Date.now() + breakMs) });
    core.setTimer(() => core.runMatch(), breakMs);
  }

  return {
    kind,
    hostsMatches: true,
    // Only a slot server reads the operator token.
    operator: {},
    routes: [],
    begin() {
      if (options.match === "immediate") core.runMatch();
      else if (held) game.setNextStart({ kind: "held" });
      else if (scheduled) schedule();
    },
    matchEnded() {
      if (scheduled) schedule();
    },
    startFailed() {
      if (scheduled) {
        schedule();
        return;
      }
      held = true;
      game.setNextStart({ kind: "held" });
    },
    startMatch() {
      if (game.match !== null && game.match.result === null) throw new Error("a match is already running");
      if (!held) throw new Error("no held match to start");
      held = false;
      core.runMatch();
    },
    stopMatch() {
      throw new Error(NO_ON_DEMAND_MATCH);
    },
    ...(expectedPlayers === undefined ? {} : {
      replied() {
        // Deferred so the completing join's reply (its token and briefing) leaves before tick 0.
        setImmediate(() => {
          if (!held || game.queuedAgents < expectedPlayers) return;
          held = false;
          core.runMatch();
        });
      },
    }),
  };
}
