/// <reference types="node" />
import type { ServerResponse } from "node:http";
import type { Game } from "../mcp/game.js";
import type { OperatorControls } from "../operator.js";
import type { MatchResult, StepOutput } from "../sim/types.js";
import type { ServerOptions } from "../server.js";
import type { Route } from "./routes.js";
import { slotMode } from "./slotMode.js";

/** Default non-slot startup serves discovery and accounts, never a match. */
export function isEntryPoint(options: Pick<ServerOptions, "slot" | "match">): boolean {
  return options.slot === undefined && options.match === undefined;
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
  readonly kind: "entry" | "comparison" | "slot";
  /** Whether this server plays matches: MCP gameplay tools and the operator route. */
  readonly hostsMatches: boolean;
  /** The slot operator's controls; a mode without them, or without a token, disables them. */
  readonly operator?: OperatorControls;
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
  /** GameServer.shutdown's step before the server closes. */
  shutdown?(saveWithinMs: number): Promise<void>;
  /** The mode's own part of the server's one close, first. */
  close?(): void;
}

/** The one mode a server's options select. */
export function selectMode(options: ServerOptions, core: MatchCore): ServerMode {
  if (options.slot !== undefined) return slotMode(options.slot, core);
  if (isEntryPoint(options)) return entryMode();
  if (options.expectedPlayers === undefined) throw new Error("a held match starts only at its expectedPlayers join barrier");
  return comparisonMode(core, options.expectedPlayers);
}

/** The default deployment: discovery and accounts, never a match. */
export function entryMode(): ServerMode {
  return {
    kind: "entry",
    hostsMatches: false,
    routes: [],
    begin() {},
    matchEnded() {},
    startFailed() {},
  };
}

/**
 * The comparison run: one held match that starts once expectedPlayers accepted joins are
 * queued, after the reply to the join that completed the count has gone out. A start that
 * fails is held again.
 */
export function comparisonMode(core: MatchCore, expectedPlayers: number): ServerMode {
  const { game } = core;
  let held = true;
  return {
    kind: "comparison",
    hostsMatches: true,
    routes: [],
    begin() {
      game.setNextStart({ kind: "held" });
    },
    matchEnded() {},
    startFailed() {
      held = true;
      game.setNextStart({ kind: "held" });
    },
    replied() {
      // Deferred so the completing join's reply (its token and briefing) leaves before tick 0.
      setImmediate(() => {
        if (!held || game.queuedAgents < expectedPlayers) return;
        held = false;
        core.runMatch();
      });
    },
  };
}
