import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import type { Game } from "../../src/mcp/game.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer, type ServerOptions } from "../../src/server.ts";
import { createFirestore, type Fields, type Store } from "../../src/store/firestore.ts";
import { tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const servers: GameServer[] = [];
const clients: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
afterEach(async () => {
  for (const { client, transport } of clients.splice(0)) {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
  for (const server of servers.splice(0)) await server.close();
});

/** Sequential unit boundary only; emulator cases below prove the same flow against Firestore. */
function memoryStore(): Store {
  const docs = new Map<string, Fields>();
  return {
    namespace: "locator-test",
    async get(path) { return docs.get(path) ?? null; },
    async transaction(step) {
      const next = await step(async paths => new Map(paths.map(path => [path, docs.get(path) ?? null])));
      for (const write of next.writes) {
        if (write.op === "delete") docs.delete(write.path);
        else {
          if ((write.op === "create") === docs.has(write.path)) throw new Error(`unexpected ${write.op}: ${write.path}`);
          docs.set(write.path, { ...docs.get(write.path), ...write.fields });
        }
      }
      return next.result;
    },
    async query() { throw new Error("locator flow must not query collections"); },
  };
}

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

function world(store: Store): AccountStores {
  const identities = createIdentities(store);
  return {
    identities,
    lobbies: createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, countdownMs: 60_000 }),
    ratings: createRatings(store),
  };
}

async function serve(options: Pick<ServerOptions, "accounts" | "slot"> = {}) {
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, ...options });
  servers.push(server);
  return server;
}

async function connect(server: GameServer) {
  const client = new Client({ name: "locator-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
  clients.push({ client, transport });
  await client.connect(transport);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(result.structuredContent);
      return result;
    },
  };
}

type Connection = Awaited<ReturnType<typeof connect>>;
async function locate(agent: Connection, lobbyId: string) {
  const reply = await agent.call("locate_match", { lobbyId });
  expect(reply.isError).not.toBe(true);
  return reply.structuredContent;
}

const emptyLocation = { slot: null, mcpUrl: null, spectatorUrl: null };
const address = { slot: "public-0", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" };
/** The located answer: the slot instance's mcpUrl, and the lobby's own antwars.ai page, whichever host the slot has. */
const located = (lobbyId: string) => ({ slot: address.slot, mcpUrl: address.mcpUrl, spectatorUrl: `https://antwars.ai/?lobby=${lobbyId}` });

for (const backend of ["memory", "Firestore emulator"] as const) {
  describe.skipIf(backend === "Firestore emulator" && !host)(`match discovery using ${backend}`, { timeout: 60_000 }, () => {
    function stores() {
      return world(backend === "memory" ? memoryStore() : createFirestore({
        projectId, namespace: `locator-${randomUUID()}`, emulatorHost: host,
      }));
    }

    it("follows the agent's root /mcp → join_lobby → locate_match flow without slot wiring", async () => {
      const accounts = stores();
      const root = await connect(await serve({ accounts }));
      const tools = (await root.client.listTools()).tools;
      expect(tools.filter(tool => tool.name === "locate_match")).toHaveLength(1);
      expect(tools.map(tool => tool.name)).not.toContain("join");

      const ann = value(await accounts.identities.claimUsername("Ann"));
      const bob = value(await accounts.identities.claimUsername("Bob"));
      const create = async () => {
        const reply = await root.call("create_lobby", { key: ann.key, kind: "public", size: 1 });
        expect(reply.isError).not.toBe(true);
        return (reply.structuredContent as { lobby: { id: string } }).lobby.id;
      };
      const seat = async (lobbyId: string, key: string) => {
        const reply = await root.call("join_lobby", { lobbyId, key });
        expect(reply.isError).not.toBe(true);
        return reply.structuredContent;
      };
      const first = await create();
      expect(await locate(root, first)).toEqual(emptyLocation);
      expect(await seat(first, ann.key)).toMatchObject({ lobby: { state: "open" } });
      expect(await locate(root, first)).toEqual(emptyLocation);
      expect(await seat(first, bob.key)).toMatchObject({ lobby: { state: "holding" } });
      // Holding before its slot's server registers: the slot and the lobby's antwars.ai page, no mcpUrl yet.
      const heldUnregistered = { ...located(first), mcpUrl: null };
      expect(await locate(root, first)).toEqual(heldUnregistered);
      // Another slot's server answers GET /lobbies/<id>/match the same in this state.
      const otherSlot = await serve({ slot: { slot: "private-0", publicUrl: "http://other.test", identities: accounts.identities, lobbies: accounts.lobbies, pollMs: 60_000 } });
      expect(await (await fetch(`http://127.0.0.1:${otherSlot.port}/lobbies/${first}/match`)).json()).toEqual(heldUnregistered);
      await accounts.lobbies.registerInstance("public-0", { runId: "test-run", ...address });
      expect(await locate(root, first)).toEqual(located(first));

      const second = await create();
      await seat(second, ann.key);
      expect(await seat(second, bob.key)).toMatchObject({ lobby: { state: "waiting" } });
      expect(await locate(root, second)).toEqual(emptyLocation);
      value(await accounts.lobbies.releaseSlot(first));
      expect(await locate(root, first)).toEqual(emptyLocation);
      expect(await locate(root, second)).toEqual(located(second));

      // Root cannot play; only the located slot offers a keyed join.
      const joined = await root.client.callTool({ name: "join", arguments: {} });
      expect(joined.isError).toBe(true);
    });

    it("keeps root, slot-only and accounts-plus-slot locator schemas, replies and refusals identical", async () => {
      const accounts = stores();
      const owner = value(await accounts.identities.claimUsername("Owner"));
      const lobbyId = value(await accounts.lobbies.createLobby(owner.key, "public", 1)).lobby.id;
      const root = await connect(await serve({ accounts }));
      const agents = [root];
      const slotPorts: number[] = [];
      for (const withAccounts of [false, true]) {
        const slotServer = await serve({
          ...(withAccounts ? { accounts } : {}),
          slot: { slot: withAccounts ? "private-0" : "public-0", publicUrl: "http://slot.test", identities: accounts.identities, lobbies: accounts.lobbies, pollMs: 60_000 },
        });
        slotPorts.push(slotServer.port);
        agents.push(await connect(slotServer));
      }
      value(await accounts.lobbies.join(lobbyId, owner.key));
      const opponent = value(await accounts.identities.claimUsername("Opponent"));
      value(await accounts.lobbies.join(lobbyId, opponent.key));
      // Each slot's GET /lobbies/<id>/match gives the same antwars.ai page, never its own address.
      for (const port of slotPorts) {
        expect(await (await fetch(`http://127.0.0.1:${port}/lobbies/${lobbyId}/match`)).json()).toEqual(located(lobbyId));
      }
      const rootTool = (await root.client.listTools()).tools.find(tool => tool.name === "locate_match")!;
      for (const [index, agent] of agents.entries()) {
        const tools = (await agent.client.listTools()).tools;
        expect(tools.filter(tool => tool.name === "locate_match")).toEqual([rootTool]);
        expect(await locate(agent, lobbyId)).toEqual(located(lobbyId));
        for (const unknown of [randomUUID(), "../usernames/owner"]) {
          const reply = await agent.call("locate_match", { lobbyId: unknown });
          expect(reply.isError).toBe(true);
          expect(reply.structuredContent).toEqual({ error: { code: "no_such_lobby", message: "No lobby has that id.", howToFix: "Use the lobbyId that create_lobby, list_lobbies or read_lobby returned." }, tick: null });
        }
        for (const args of [{}, { lobbyId: 42 }, { lobbyId: null }]) {
          const reply = await agent.call("locate_match", args);
          expect(reply.isError).toBe(true);
          expect(reply.structuredContent).toEqual({ error: { code: "bad_arguments", message: "lobbyId must be a string.", howToFix: "Resend locate_match with your lobby's id." }, tick: null });
        }
        if (index > 0) {
          const join = tools.find(tool => tool.name === "join")!;
          expect(join.inputSchema.properties).toHaveProperty("key");
          expect(join.inputSchema.properties).not.toHaveProperty("reconnectToken");
          expect((await agent.call("join")).structuredContent).toMatchObject({ error: { code: "key_required" } });
          expect((await agent.call("join", { key: owner.key, token: "not-accepted" })).structuredContent).toMatchObject({ error: { code: "bad_arguments" } });
        }
      }
    });

    it("asks a seated key to retry while its lobby holds this slot but is not seated here, then seats it", async () => {
      const accounts = stores();
      // The runner's first poll is a minute away, so it never seats the lobby during this test.
      const server = await serve({ slot: { slot: "public-0", publicUrl: "http://slot.test", identities: accounts.identities, lobbies: accounts.lobbies, pollMs: 60_000 } });
      const ann = value(await accounts.identities.claimUsername("Ann"));
      const bob = value(await accounts.identities.claimUsername("Bob"));
      const outsider = value(await accounts.identities.claimUsername("Outsider"));
      const lobbyId = value(await accounts.lobbies.createLobby(ann.key, "public", 1)).lobby.id;
      value(await accounts.lobbies.join(lobbyId, ann.key));
      expect(value(await accounts.lobbies.join(lobbyId, bob.key))).toMatchObject({ state: "holding", slot: "public-0" });
      const agent = await connect(server);
      const early = await agent.call("join", { key: ann.key });
      expect(early.isError).toBe(true);
      expect(early.structuredContent).toMatchObject({ error: { code: "lobby_loading" }, retryAfterMs: 1000 });
      expect((await agent.call("join", { key: outsider.key })).structuredContent).toMatchObject({ error: { code: "not_seated" } });
      // Stands in for the runner's next poll, which seats the holder.
      (server.game as Game).seatLobby(lobbyId, [
        { identityId: ann.identity.id, displayName: "Ann", colony: 0 },
        { identityId: bob.identity.id, displayName: "Bob", colony: 1 },
      ]);
      const joined = await agent.call("join", { key: ann.key });
      expect(joined.isError, JSON.stringify(joined.structuredContent)).not.toBe(true);
      expect(joined.structuredContent).toHaveProperty("matchStarts");
    });
  });
}

it("does not advertise locate_match without either account stores or slot wiring", async () => {
  const agent = await connect(await serve());
  expect((await agent.client.listTools()).tools.map(tool => tool.name)).not.toContain("locate_match");
});
