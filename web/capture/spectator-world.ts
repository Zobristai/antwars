/** Two loopback origins, real shared stores/routes, and offline fixture simulation. Never joins a deployed match. */
import { createServer, type Server, type ServerResponse } from "node:http";
import { inflateRawSync } from "node:zlib";
import { decodeMessage } from "../../src/live/format.js";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createFirestore } from "../../src/store/firestore.js";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import { createAccountApi } from "../../src/accounts/httpApi.js";
import { Game } from "../../src/mcp/game.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions } from "../../src/server.js";
import { servePage } from "../../src/spectator.js";
import { LiveHub } from "../../src/live/hub.js";
import { createWatchRegistry } from "../../src/live/watch-registry.js";
import { createWatchController, type WatchController } from "../../src/live/watch-controller.js";
import { watchRoutes } from "../../src/live/watch-routes.js";
import { createPrivateArchive } from "../../src/replays/private-archive.js";
import type { ReplayObject } from "../../src/replays/store.js";
import { ManualClock } from "../../test/live/helpers.ts";

export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Spectator fixture condition timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export interface FinalResultWrite {
  readonly lobbyId: string;
  readonly origin: string;
  readonly requestId: number;
  /** Wall time immediately before the actual response write, not the simulated playback clock. */
  readonly writtenAt: number;
  readonly clockAt: number;
  readonly tick: number;
  readonly full: boolean;
}

export async function createSpectatorWorld() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulatorHost)) throw new Error("This fixture requires an owned loopback Firestore emulator");
  const namespace = `spectator-${randomUUID()}`;
  const client = () => {
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
    const identities = createIdentities(store);
    return { store, identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), registry: createWatchRegistry(store) };
  };
  const accounts = client();
  const owner = await accounts.identities.claimUsername("spectator-owner"), bob = await accounts.identities.claimUsername("spectator-bob");
  if (!owner.ok || !bob.ok) throw new Error("Could not create fixture identities");
  const handle = await accounts.identities.createHandle(owner.value.key, "agent");
  if (!handle.ok) throw new Error("Could not create fixture handle");
  const members = [handle.value, bob.value] as const;
  const blobs = new Map<string, Uint8Array>();
  const replayStore = { create: async (object: ReplayObject) => { if (blobs.has(object.name)) throw new Error("Duplicate fixture object"); blobs.set(object.name, object.body); } };
  const replaySource = { open: async (id: string) => blobs.has(`${id}.bin`) ? { body: Readable.from([blobs.get(`${id}.bin`)!]) } : null };
  const archive = createPrivateArchive(replayStore, async name => blobs.has(name) ? { body: Readable.from([blobs.get(name)!]) } : null, randomBytes(32));
  const nodes: { server: Server; origin: string; slot: string; runId: string; clock: ManualClock; hub: LiveHub; controller: WatchController; seq: number }[] = [];
  let playbackTimer: ReturnType<typeof setInterval> | undefined;
  const finalWrites: FinalResultWrite[] = [];
  let requestId = 0;
  async function node(slot: string) {
    const stores = client(), clock = new ManualClock(), runId = randomUUID();
    let route: ReturnType<typeof watchRoutes> | undefined, hub: LiveHub | undefined;
    const api = createAccountApi(stores);
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const lobbyId = /^\/watch\/live\/([^/]+)$/.exec(path)?.[1];
      if (lobbyId) {
        const streamId = ++requestId, write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
        let pending = "";
        // Observe both owner and proxy writes without changing chunks, callbacks or backpressure.
        res.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          const writtenAt = Date.now(), clockAt = clock.now();
          const accepted = write(chunk, ...rest);
          pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          for (let end; (end = pending.indexOf("\n\n")) >= 0;) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!data) continue;
            const message = decodeMessage(inflateRawSync(Buffer.from(data, "base64")));
            if (message.full?.result || message.events.some(event => event.kind === "end")) {
              finalWrites.push({ lobbyId, origin, requestId: streamId, writtenAt, clockAt, tick: message.tick, full: message.full !== null });
            }
          }
          return accepted;
        }) as ServerResponse["write"];
      }
      const handling = path.startsWith("/watch/") ? route?.(req, res)
        : path.startsWith("/live/") ? hub?.handle(req, res)
        : path.startsWith("/api/") ? api(req, res) : servePage(req, res, { lobbies: true, publicMatches: true });
      Promise.resolve(handling).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = createWatchController({ accounts: stores, registry: stores.registry, slot, origin, archive });
    hub = new LiveHub({ clock, replayStore, captureMatchLogs: true, ...controller.hubOptions });
    route = watchRoutes({ accounts: stores, registry: stores.registry, hub, origin, archive, replays: replaySource });
    const value = { server, origin, slot, runId, clock, hub, controller, seq: 0 }; nodes.push(value);
    await stores.lobbies.registerInstance(slot, { runId, mcpUrl: `${origin}/mcp`, spectatorUrl: origin + "/" });
    return value;
  }
  try {
    const publicNode = await node("public-0"), privateNode = await node("private-0");
    return {
      origins: [publicNode.origin, privateNode.origin] as const,
      displayNames: members.map(member => member.identity.displayName),
      finalWrites: finalWrites as readonly FinalResultWrite[],
      /** Exercise the real API on a specified origin without seating or starting the lobby. */
      async openLobby(kind: "public" | "private", originIndex: 0 | 1 = 0) {
        const response = await fetch(`${nodes[originIndex]!.origin}/api/create_lobby`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: members[0].key, kind, size: 1 }),
        });
        if (!response.ok) throw new Error("Open-lobby fixture creation failed");
        const value = await response.json() as { lobby?: { id?: string; state?: string; kind?: string } };
        if (!value.lobby?.id || value.lobby.state !== "open" || value.lobby.kind !== kind) throw new Error("Open-lobby fixture has unexpected state");
        // Never expose the key or private invite to capture logs or reports.
        return { lobbyId: value.lobby.id, origin: nodes[originIndex]!.origin };
      },
      async start(kind: "public" | "private", rated: boolean, seed = 42) {
        const target = kind === "public" ? publicNode : privateNode;
        const created = await accounts.lobbies.createLobby(members[0].key, kind, rated ? 1 : 2);
        if (!created.ok) throw new Error("Fixture lobby creation failed");
        const { lobby, inviteToken } = created.value;
        for (const member of members) {
          const seated = await accounts.lobbies.join(lobby.id, member.key, inviteToken);
          if (!seated.ok) throw new Error("Fixture lobby seating failed");
        }
        if (!rated && !(await accounts.lobbies.startEarly(lobby.id, members[0].key)).ok) throw new Error("Fixture early start failed");
        // Player-created lobbies are unrated; a rated fixture match stands in for a queue-made one.
        if (rated) await accounts.store.transaction(async () => ({
          result: undefined, writes: [{ op: "update", path: `lobbies/${lobby.id}`, fields: { rated: "true" } }],
        }));
        const held = await accounts.lobbies.readLobby(lobby.id);
        if (!held.ok) throw new Error("Fixture lobby missing");
        const seats = held.value.colonies.flatMap((team, colony) => team.map(seat => ({ identityId: seat.id, displayName: seat.displayName, colony: colony as 0 | 1 })));
        await target.controller.prepare(lobby.id, seats);
        if (!(await accounts.lobbies.beginMatch(lobby.id, target.slot, target.runId)).ok) throw new Error("Fixture begin failed");
        const base = comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!;
        const logs: string[] = [];
        // Game is an offline state machine here: no MCP listener, agent connection or wall-clock tick loop exists.
        const game = new Game({ simConfig: { ...base, matchTicks: 30 }, now: () => target.clock.now(), onLogLine: line => logs.push(line),
          slot: { identityOf: async () => undefined, locate: async () => undefined } });
        game.seatLobby(lobby.id, seats);
        for (const member of members) await game.joinSeated(member.identity.id, "Fixture model (self-reported)");
        game.startMatch(seed);
        const seq = ++target.seq;
        const startedAt = target.clock.now();
        const tickMs = 1000 / game.match!.state.config.ticksPerSecond;
        target.controller.started(seq, game.match!.state, game, target.hub);
        let logIndex = logs.length;
        while (game.match!.result === null) {
          // Preserve production tick timestamps even though the simulation is computed offline.
          // Timers remain deferred until the capture explicitly releases playback.
          target.clock.stall(tickMs);
          const out = game.tick();
          if (!out) throw new Error("Fixture tick missing");
          for (; logIndex < logs.length; logIndex++) target.hub.appendLog(seq, logs[logIndex]!);
          target.hub.pushTick(seq, out);
        }
        const result = game.match!.result!;
        const outcome = result.winner === null ? "draw" : result.winner === 0 ? "colony_0_won" : "colony_1_won";
        if (!(await accounts.lobbies.endMatch(lobby.id, target.runId, outcome)).ok) throw new Error("Fixture end failed");
        await until(async () => (await accounts.registry.read(lobby.id)) !== null);
        const releaseAt = startedAt + (rated ? 300_000 : 60_000);
        const finalReleaseAt = releaseAt + game.match!.state.tick * tickMs;
        return { lobbyId: lobby.id, inviteToken, rated, origin: target.origin, finalTick: game.match!.state.tick,
          mapName: game.match!.state.terrain?.mapName ?? "legacy map", mapId: game.match!.state.terrain?.mapId ?? "legacy", seed,
          /** Remaining time to this match's first release, including time spent preparing a successor. */
          untilReleaseMs: () => Math.max(0, releaseAt - target.clock.now()),
          /** Pace playback like a live producer, without jumping the multi-minute privacy delay.
           * Keep the fixture clock running during browser observation: normal idle heartbeats
           * and rating retries must still run after the final tick. In particular, WebKit may
           * buffer a fetch chunk's tail until the next write. Only world.close() stops this clock.
           */
          async play() {
            if (target.clock.now() < releaseAt - 1) throw new Error("Advance to just before this match's release before playing");
            playbackTimer ??= setInterval(() => {
              for (const node of nodes) node.clock.advance(tickMs);
            }, tickMs);
            await until(() => target.clock.now() >= finalReleaseAt + 1000);
          },
        };
      },
      advance(ms: number) { for (const node of nodes) node.clock.advance(ms); },
      async recording(lobbyId: string) {
        await until(async () => !!(await accounts.registry.read(lobbyId))?.replayId);
        return (await accounts.registry.read(lobbyId))!.replayId!;
      },
      async revoke(lobbyId: string) { if (!(await accounts.lobbies.revokeInvite(lobbyId, members[0].key)).ok) throw new Error("Fixture revoke failed"); },
      async renew(lobbyId: string) {
        const result = await accounts.lobbies.issueInvite(lobbyId, members[0].key);
        if (!result.ok) throw new Error("Fixture renewal failed"); return result.value.inviteToken;
      },
      async close() {
        clearInterval(playbackTimer); playbackTimer = undefined;
        for (const node of nodes) { node.controller.close(); node.hub.close(); node.server.closeAllConnections(); await new Promise<void>(resolve => node.server.close(() => resolve())); }
      },
    };
  } catch (error) {
    for (const node of nodes) { node.controller.close(); node.hub.close(); node.server.closeAllConnections(); await new Promise<void>(resolve => node.server.close(() => resolve())); }
    throw error;
  }
}
