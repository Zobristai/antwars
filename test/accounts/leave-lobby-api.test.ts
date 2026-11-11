/// <reference types="node" />
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_OPERATIONS, type AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { LEAVE_LOBBY_LINE, ruleSections } from "../../web/rules.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

/** leave_lobby over MCP and POST /api/leave_lobby: its description, replies and refusals, and the Rules page line. */

// The store tests run inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; they are skipped only when it is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

type Body = any;
interface Reply { readonly ok: boolean; readonly status: number; readonly body: Body }
type Call = (op: string, args?: Record<string, unknown>) => Promise<Reply>;

const servers: GameServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

async function mcp(port: number): Promise<Call> {
  const client = new Client({ name: "leave-lobby-api-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return async (op, args = {}) => {
    const result = await client.callTool({ name: op, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    return { ok: result.isError !== true, status: 0, body: result.structuredContent ?? JSON.parse(text) };
  };
}

function http(port: number): Call {
  return async (op, args = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
    });
    return { ok: res.status === 200, status: res.status, body: await res.json() };
  };
}

const TRANSPORTS: readonly [string, (port: number) => Promise<Call>][] = [
  ["MCP", mcp],
  ["HTTP", async (port) => http(port)],
];

let counter = 0;
function stores(): AccountStores {
  const namespace = `lvapi${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  return { identities, lobbies: createLobbies(store, identities, { publicSlots: 1, privateSlots: 1 }), ratings: createRatings(store) };
}

async function serve(accounts: AccountStores): Promise<number> {
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts,
  });
  servers.push(server);
  return server.port;
}

async function ok(call: Call, op: string, args: Record<string, unknown>): Promise<Body> {
  const reply = await call(op, args);
  expect(reply.ok, `${op}: ${JSON.stringify(reply.body)}`).toBe(true);
  return reply.body;
}

const description = (name: string) => ACCOUNT_OPERATIONS.find((op) => op.name === name)!.description;

describe("leave_lobby text", () => {
  it("describes leaving before start, no rating change or charge, the last leaver closing the lobby and the refusal after start", () => {
    const text = description("leave_lobby");
    expect(text).toMatch(/leave a lobby you are seated in, with your key and the lobbyId, at any time before its match starts: no rating change and no charge/i);
    expect(text).toMatch(/when the last seated identity leaves, the lobby closes/i);
    expect(text).toMatch(/after that a leave is refused started and changes nothing/i);
    expect(description("join_lobby")).toMatch(/leave before the match starts with leave_lobby/i);
  });

  it("the Rules page has a Lobbies section, before the last, saying how to leave a lobby", () => {
    const sections = ruleSections(newMatchConfig(PUBLIC_CONFIG));
    const lobbies = sections.findIndex((section) => section.title === "Lobbies");
    expect(lobbies).toBe(sections.length - 2);
    expect(sections.at(-1)!.title).toBe("Model Index matches");
    expect(sections[lobbies]!.lines).toEqual([LEAVE_LOBBY_LINE]);
    expect(LEAVE_LOBBY_LINE).toMatch(/can leave it with leave_lobby \(its key and the lobby's id\) at any time before the match starts/);
    expect(LEAVE_LOBBY_LINE).toMatch(/when the last seated agent leaves, the lobby closes/i);
    expect(LEAVE_LOBBY_LINE).toMatch(/after that, leaving is refused/i);
  });
});

describe.skipIf(!host)("leave_lobby against the Firestore emulator", { timeout: 60_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (transport, open) => {
    it("leaves before start, closes the lobby with the last seat, and refuses after start, elsewhere and for a bad key", async () => {
      const call = await open(await serve(stores()));
      const claim = async (name: string) => (await ok(call, "claim_username", { name })).key as string;
      const [ann, bea, cat] = [await claim("Ann"), await claim("Bea"), await claim("Cat")];
      const lobbyId = (await ok(call, "create_lobby", { key: ann, kind: "public", size: 1 })).lobby.id;
      await ok(call, "join_lobby", { key: ann, lobbyId });

      const notSeated = await call("leave_lobby", { key: bea, lobbyId });
      expect([notSeated.ok, notSeated.body]).toEqual([false, { error: "not_seated", message: "This key holds no seat in that lobby; nothing changed." }]);
      if (transport === "HTTP") expect(notSeated.status).toBe(404);
      // A missing and a malformed lobby read the same as a lobby without this key's seat.
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-lobby"]) {
        expect((await call("leave_lobby", { key: bea, lobbyId: id })).body).toEqual(notSeated.body);
      }
      for (const id of [lobbyId, "not-a-lobby"]) {
        const badKey = await call("leave_lobby", { key: "x".repeat(43), lobbyId: id });
        expect([badKey.ok, badKey.body.error]).toEqual([false, "invalid_key"]);
      }

      const left = await ok(call, "leave_lobby", { key: ann, lobbyId });
      expect(left).toMatchObject({ left: true, lobby: { id: lobbyId, state: "ended", outcome: "not_played", startsAt: null, colonies: [[], []] } });
      expect((await call("leave_lobby", { key: ann, lobbyId })).body.error).toBe("not_seated");

      const started = (await ok(call, "create_lobby", { key: bea, kind: "public", size: 1 })).lobby.id;
      await ok(call, "join_lobby", { key: bea, lobbyId: started });
      await ok(call, "join_lobby", { key: cat, lobbyId: started });
      const refused = await call("leave_lobby", { key: bea, lobbyId: started });
      expect([refused.ok, refused.body]).toEqual([false, { error: "started", message: "This lobby has already started." }]);
      if (transport === "HTTP") expect(refused.status).toBe(409);
      expect((await ok(call, "read_lobby", { key: bea, lobbyId: started })).lobby.colonies.flat()).toHaveLength(2);
    });
  });
});
