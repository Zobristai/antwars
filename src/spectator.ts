/// <reference types="node" />
/**
 * The spectator on the game server's one port:
 * Live stream hub, fed from the server's tick loop through its match
 * feed, mounted at /live, and the built page (web/dist,
 * produced by `npm run build:web`) mounted at /.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "./live/config.js";
import type { StreamIdentity } from "./live/format.js";
import { SPECTATOR_SAVE_META_BYTES } from "./live/handover.js";
import { LiveHub, type LiveClock } from "./live/hub.js";
import type { MatchAccess } from "./live/match-access.js";
import type { SpectatorPlayerOptions } from "./live/model.js";
import { isEntryPoint, startServer, type GameServer, type LiveGame, type MatchFeed, type ServerOptions } from "./server.js";
import { PUBLIC_CONFIG } from "./sim/config.js";
import type { SimState } from "./sim/types.js";
import { newMatchConfig } from "./sim/gridScale.js";
import { renderRules, rulesAssets, type RulesAssets } from "../web/rules.js";
import type { ReplayStore } from "./replays/store.js";
import type { ReplaySource } from "./replays/access.js";
import type { HistorySource } from "./replays/history-source.js";
import { historyRoutes } from "./replays/history-routes.js";
import { replayRoutes } from "./replays/replay-routes.js";
import type { PrivateArchive } from "./replays/private-archive.js";
import type { RecordHandoff } from "./records/handoff.js";
import type { WatchRegistry } from "./live/watch-registry.js";
import { createWatchController, type WatchController } from "./live/watch-controller.js";
import { watchRoutes } from "./live/watch-routes.js";

/** The built spectator page. */
export const WEB_DIST = resolve(import.meta.dirname, "..", "web", "dist");

/** The built Rules enhancement, read from the build manifest; a server without a build serves the script-free page. */
export function readRulesAssets(dist = WEB_DIST): RulesAssets | undefined {
  let source: string;
  try { source = readFileSync(join(dist, ".vite/manifest.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return rulesAssets(JSON.parse(source));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export interface SpectatedServer extends GameServer {
  readonly hub: LiveHub;
}

export interface SpectatedServerOptions extends ServerOptions {
  readonly replayStore?: ReplayStore;
  readonly replaySource?: ReplaySource;
  readonly historySource?: HistorySource;
  readonly privateArchive?: PrivateArchive;
  /** Hands recorded matches to the record service, which builds their readable records. */
  readonly recordHandoff?: RecordHandoff;
  readonly watchRegistry?: WatchRegistry;
  /** Explicit clock seam for local delayed-playback verification; production uses the wall clock. */
  readonly spectatorClock?: LiveClock;
  /**
   * Signs this server's live relays and verifies the relays it receives (relay-signature.ts): the HKDF
   * subkey of ANTWAR_PRIVATE_REPLAY_KEY. Omitted means relays carry no signature and every
   * spectator meets the per-source bound. Never logged.
   */
  readonly relayKey?: Uint8Array;
}

/** A game server with the spectator stream and page mounted; closing it closes the stream too. */
export async function startSpectatedServer(options: SpectatedServerOptions, live: LiveConfig = DEFAULT_LIVE_CONFIG): Promise<SpectatedServer> {
  // Held/immediate runs and the private comparison harness are never public recordings.
  const entryPoint = isEntryPoint(options);
  const replayStore = !entryPoint && options.match === undefined && options.matchLogStdout !== true ? options.replayStore : undefined;
  if (options.slot && (!options.accounts || !options.watchRegistry)) throw new Error("Slot spectators require account stores and a watch registry");
  const controller = options.slot && options.accounts && options.watchRegistry ? createWatchController({ accounts: options.accounts,
    registry: options.watchRegistry, slot: options.slot.slot, origin: options.slot.publicUrl, archive: options.privateArchive }) : undefined;
  const hub = new LiveHub({ config: live, clock: options.spectatorClock, replayStore, includeComparisonSetup: options.includeComparisonSetup,
    captureMatchLogs: !entryPoint && (replayStore !== undefined || options.privateArchive !== undefined),
    recordHandoff: entryPoint ? undefined : options.recordHandoff, relayKey: options.relayKey, ...controller?.hubOptions });
  // A slot server's lobby by the match that streams it, for that match's handover save.
  const lobbies = new Map<number, string>();
  let seated: string | undefined;
  const feed: MatchFeed = {
    logLine: (seq, line) => hub.appendLog(seq, line),
    lobbySeated: controller && (async (lobbyId, seats) => {
      await controller.prepare(lobbyId, seats);
      seated = lobbyId;
    }),
    matchStarted: (seq, state, game) => {
      if (!controller) return hub.startMatch(seq, state, undefined, undefined, game.spectatorHouseIdle?.(seq));
      controller.started(seq, state, game, hub);
      lobbies.set(seq, seated!);
    },
    ticked: (seq, out, game) => {
      if (out.state.result !== null) hub.setNextStart(seq, game.nextStart?.kind === "scheduled" ? game.nextStart.at : null);
      hub.pushTick(seq, out);
      controller?.ticked(lobbies.get(seq), out, game);
    },
    // Handover save and restore: LiveHub.saveMatch/resumeMatch and WatchController.save/resume.
    ...(controller && spectatorHandover(hub, controller as WatchController & HandoverWatch, lobbies)),
  };
  const server = await startServer({ ...options, feed: entryPoint ? undefined : feed });
  if (!entryPoint) server.mount("/live", (req, res) => hub.handle(req, res));
  if (options.accounts && options.watchRegistry) server.mount("/watch", watchRoutes({ accounts: options.accounts, registry: options.watchRegistry,
    hub, origin: options.slot?.publicUrl, archive: options.privateArchive, replays: options.replaySource, relayKey: options.relayKey }));
  if (options.replaySource !== undefined) server.mount("/replays", replayRoutes(options.replaySource));
  if (options.historySource !== undefined) {
    // Older recordings carry no seat handle: each one's lobby supplies its colonies' handles.
    const lobbies = options.accounts?.lobbies, registry = options.watchRegistry;
    const lookup = lobbies && registry ? async (replayId: string) => {
      const found = await registry.replayLobby(replayId);
      if (found.state !== "found") return found.state === "pending" ? "pending" as const : null;
      const read = await lobbies.readLobby(found.lobbyId);
      return read.ok ? read.value : null;
    } : undefined;
    server.mount("/matches", historyRoutes(options.historySource, lookup));
  }
  server.mount("/rules", (req, res, game) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/rules" && path !== "/rules/") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    // A running match, else an open start window's drawn map, else the retained ended match.
    // Before any of these the seed has not drawn a map: state no value the match may not have.
    // A seated house lobby not yet started outranks the retained match: its draw leaves out paused maps.
    const running = game.match !== null && game.match.result === null ? game.match.state.config : undefined;
    const seatedHouse = game.seatedHouseUndrawnConfig ?? undefined;
    const drawn = running ?? game.startWindowConfig ?? (seatedHouse === undefined ? game.match?.state.config : undefined);
    const body = Buffer.from(renderRules(drawn ?? seatedHouse ?? game.undrawnConfig ?? options.simConfig ?? newMatchConfig(PUBLIC_CONFIG), { undrawn: drawn === undefined, assets: readRulesAssets() }));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  // Inert page metadata is known before any UI mounts. Configuration is not a store health check.
  server.mount("/", (req, res) => servePage(req, res, {
    lobbies: options.accounts !== undefined,
    publicMatches: options.accounts !== undefined && options.watchRegistry !== undefined,
  }));
  return {
    ...server,
    hub,
    async close() {
      controller?.close();
      await server.close();
      hub.close();
    },
  };
}

/** A live hub's stream and recording state of one match: JSON-safe meta and its bulky parts. */
interface HubSave {
  readonly meta: object;
  readonly parts: ReadonlyMap<string, Uint8Array>;
}

/** A live hub's side of a handover. saveMatch freezes the match's stream and rejects when its stream or recording state cannot be saved. */
export interface HandoverHub {
  saveMatch(seq: number): Promise<HubSave>;
  resumeMatch(seq: number, state: SimState, save: { readonly meta: object; readonly parts: Map<string, Uint8Array> },
    identity?: SpectatorPlayerOptions["identity"], houseIdle?: SpectatorPlayerOptions["houseIdle"]): void | Promise<void>;
}

/** A watch controller's side of a handover: a lobby's spectator metadata, restored on the resuming server. */
export interface HandoverWatch {
  save(lobbyId: string): object;
  resume(meta: unknown, live: LiveGame): Promise<{ readonly access: MatchAccess; readonly identity: (agentId: string) => StreamIdentity | undefined }>;
  /** This server's run adopted the resumed lobby's match: list it under that run. */
  adopted(lobbyId: string, runId: string): void;
}

/**
 * A slot server's spectator side of the one handover save: the match's stream,
 * recording and watch metadata are saved together, and restored together on the server that
 * resumes it. Any of them failing rejects, which fails the whole save; the match then ends not
 * played, as for any failed save. `lobbies` maps each streamed match to its lobby; a resumed
 * match is added, so it can be handed over again. A resumed match is listed under this server's
 * run only once that run has adopted it (matchAdopted).
 */
export function spectatorHandover(hub: HandoverHub, controller: HandoverWatch, lobbies: Map<number, string>): Required<Pick<MatchFeed, "saveSpectator" | "matchResumed" | "matchAdopted">> {
  return {
    async saveSpectator(seq) {
      const lobbyId = lobbies.get(seq);
      if (lobbyId === undefined) throw new Error(`match ${seq} streams no lobby`);
      const stream = await hub.saveMatch(seq);
      const meta = JSON.stringify({ stream: stream.meta, watch: controller.save(lobbyId) });
      // The meta is the save's only Firestore part, sized at this bound.
      const bytes = Buffer.byteLength(meta);
      if (bytes > SPECTATOR_SAVE_META_BYTES) throw new Error(`spectator save meta of match ${seq} is ${bytes} bytes, over ${SPECTATOR_SAVE_META_BYTES}`);
      return { meta, parts: stream.parts };
    },
    async matchResumed(seq, state, live, save) {
      const { stream, watch } = JSON.parse(save.meta) as { stream?: unknown; watch?: unknown };
      if (typeof stream !== "object" || stream === null) throw new Error("spectator save has no stream state");
      const { access, identity } = await controller.resume(watch, live);
      await hub.resumeMatch(seq, state, { meta: stream, parts: new Map(save.parts) }, identity, live.spectatorHouseIdle?.(seq));
      lobbies.set(seq, access.lobbyId);
    },
    matchAdopted(seq, runId) {
      const lobbyId = lobbies.get(seq);
      if (lobbyId !== undefined) controller.adopted(lobbyId, runId);
    },
  };
}

/** GET a file of the built page; / is index.html. */
export async function servePage(req: IncomingMessage, res: ServerResponse, capabilities: { lobbies: boolean; publicMatches: boolean } = { lobbies: false, publicMatches: false }): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const file = resolve(join(WEB_DIST, path === "/" ? "index.html" : path));
  if (!file.startsWith(WEB_DIST + sep)) {
    res.writeHead(404).end();
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (file === join(WEB_DIST, "index.html")) {
    // Booleans only: never reflect request values, credentials or store errors into markup.
    const metadata = `<meta name="antwar-lobbies" content="${capabilities.lobbies}"><meta name="antwar-public-matches" content="${capabilities.publicMatches}">`;
    body = Buffer.from(body.toString("utf8").replace("<head>", `<head>${metadata}`));
    res.setHeader("cache-control", "no-store");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}
