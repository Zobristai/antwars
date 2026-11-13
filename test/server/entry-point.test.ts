import { readdirSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import { ACCOUNT_OPERATIONS } from "../../src/accounts/service.js";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import { createWatchRegistry } from "../../src/live/watch-registry.js";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { memorySlot, tempDir } from "./helpers.js";
import { POST_MORTEM_TOOL } from "../../src/accounts/postMortem.js";

const servers: SpectatedServer[] = [];
const clients: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const { client, transport } of clients.splice(0)) {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect(server: SpectatedServer) {
  const client = new Client({ name: "entry-point-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
  clients.push({ client, transport });
  await client.connect(transport);
  return client;
}

it("has no playable match, game tools, live routes, operator controls, logs or recording writes even with old configuration", async () => {
  const dir = tempDir(); dirs.push(dir);
  const create = vi.fn(), submit = vi.fn(), forLobby = vi.fn();
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir,
    operatorToken: "retired-test-token", replayStore: { create }, recordHandoff: { submit },
    privateArchive: { forLobby, open: async () => null },
  });
  servers.push(server);
  const client = await connect(server);
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["rules"]);
  for (const name of ["join", "observe", "order", "mark", "count_mark", "found_queen", "pick_nest"]) {
    const result = await client.callTool({ name, arguments: {} });
    expect(result.isError, name).toBe(true);
  }
  const origin = `http://127.0.0.1:${server.port}`;
  for (const path of ["/live/current", "/live/status", "/live/replays", "/live/1"]) {
    expect((await fetch(`${origin}${path}`)).status, path).toBe(404);
  }
  for (const action of ["start", "stop"]) {
    for (const method of ["GET", "POST"]) {
      expect((await fetch(`${origin}/operator/${action}`, { method, headers: { authorization: "Bearer retired-test-token" } })).status).toBe(404);
    }
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(server.game.match).toBeNull();
  expect(server.game.nextStart).toBeNull();
  expect(server.game.queuedAgents).toBe(0);
  expect(readdirSync(dir)).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(forLobby).not.toHaveBeenCalled();
  const rules = await client.callTool({ name: "rules", arguments: {} });
  expect(rules.isError).not.toBe(true);
});

it("retains real account, queue, lobby, leaderboard, locator and watch/history/replay/page wiring without hosting a match", async () => {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const accounts = { identities, lobbies: createLobbies(store, identities), ratings: createRatings(store, identities) };
  const dir = tempDir(); dirs.push(dir);
  const replayId = "2026-10-25T00-00-00-000Z-1";
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, accounts,
    watchRegistry: createWatchRegistry(store),
    historySource: { list: async () => ({ matches: [], nextPageToken: null }), open: async () => Readable.from(['{"stored":true}']) },
    replaySource: { open: async () => ({ body: Readable.from([Buffer.from([1, 2, 3])]) }) },
  });
  servers.push(server);
  const client = await connect(server);
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["rules", "locate_match", POST_MORTEM_TOOL, "recover_key", ...ACCOUNT_OPERATIONS.map(op => op.name)].sort());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };
  const claimed = await call("claim_username", { name: "EntryPlayer" });
  const key = claimed.key;
  expect(typeof key).toBe("string");
  expect(await call("join_queue", { key, mode: "1v1" })).toMatchObject({ queue: { state: "waiting" } });
  expect(await call("queue_status", { key })).toMatchObject({ queue: { state: "waiting" } });
  expect(await call("leave_queue", { key })).toMatchObject({ queue: { state: "none" } });
  const made = await call("create_lobby", { key, kind: "private", size: 1 });
  const lobbyId = (made.lobby as { id: string }).id;
  expect(made.inviteLink).toEqual(expect.stringContaining(`#invite=${made.inviteToken}`));
  await call("join_lobby", { key, lobbyId, inviteToken: made.inviteToken });
  expect(await call("locate_match", { lobbyId })).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });
  // The post-mortem tool answers within a seat client's 30 s: an unplayed lobby of the caller's, and a lobby that is not.
  const postMortem = async (args: Record<string, unknown>) => {
    const started = performance.now();
    const result = await client.callTool({ name: POST_MORTEM_TOOL, arguments: args });
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(result.isError).toBe(true);
    return (result.structuredContent as { error: string }).error;
  };
  expect(await postMortem({ key, lobbyId })).toBe("not_ended");
  expect(await postMortem({ key, lobbyId: "00000000-0000-4000-8000-000000000000" })).toBe("not_found");
  await call("rating", { displayName: "EntryPlayer" });
  await call("leaderboard", {});
  const origin = `http://127.0.0.1:${server.port}`;
  const claimedHttp = await fetch(`${origin}/api/claim_username`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "HttpPlayer" }) });
  expect(claimedHttp.status).toBe(200);
  expect(await claimedHttp.json()).toHaveProperty("key");
  expect((await fetch(`${origin}/api/leaderboard`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  const catalog = await fetch(`${origin}/watch/catalog`);
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toHaveProperty("matches");
  const status = await fetch(`${origin}/watch/status/${lobbyId}`, { headers: { "x-antwar-invite": String(made.inviteToken) } });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ lobbyId, started: false });
  expect(await (await fetch(`${origin}/matches`)).json()).toEqual({ matches: [], nextPageToken: null });
  expect(await (await fetch(`${origin}/matches/${replayId}`)).json()).toEqual({ stored: true });
  expect(new Uint8Array(await (await fetch(`${origin}/replays/${replayId}`)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  for (const path of ["/", "/rules"]) expect((await fetch(`${origin}${path}`)).status, path).toBe(200);
  // The bundled legacy recording and its route are deleted.
  expect((await fetch(`${origin}/replays/agents.bin`)).status).toBe(404);
  expect(server.game.match).toBeNull();
  expect(server.game.nextStart).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
});

it("serves match_post_mortem on the entry server only, never on a match slot", async () => {
  const slot = memorySlot();
  const dir = tempDir(); dirs.push(dir);
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, slot: slot.slot, accounts: slot.accounts, watchRegistry: slot.watchRegistry,
    historySource: { list: async () => ({ matches: [], nextPageToken: null }), open: async () => null } });
  servers.push(server);
  const client = await connect(server);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toContain("locate_match");
  expect(names).not.toContain(POST_MORTEM_TOOL);
});
