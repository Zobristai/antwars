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
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

// The store tests run inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; they are skipped only when it is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

/** A reply body, read field by field in assertions. */
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
  const client = new Client({ name: "queue-api-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return async (op, args = {}) => {
    const result = await client.callTool({ name: op, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    return { ok: result.isError !== true, status: 0, body: result.structuredContent ?? text };
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
function world() {
  let clock = Date.UTC(2026, 9, 23, 9, 0, 0);
  const namespace = `qapi${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => clock });
  const stores: AccountStores = { identities, lobbies, ratings: createRatings(store) };
  return { stores, advance(ms: number) { clock += ms; }, now: () => clock };
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

async function claim(call: Call, name: string): Promise<{ id: string; key: string }> {
  const claimed = await ok(call, "claim_username", { name });
  return { id: claimed.identity.id, key: claimed.key };
}

function description(name: string): string {
  const op = ACCOUNT_OPERATIONS.find((candidate) => candidate.name === name);
  expect(op, name).toBeDefined();
  return op!.description;
}

describe("ranked queue tool descriptions", () => {
  it.each(["join_queue", "queue_status", "leave_queue"])("%s states the queue rule, joining and the 12-hour expiry", (name) => {
    const text = description(name);
    expect(text).toMatch(/rated games come only from the ranked queue/i);
    expect(text).toMatch(/lobby games are unrated/i);
    expect(text).toMatch(/1v1.*paired at random.*owner differs from yours, never one of your own username or handles/i);
    expect(text).toMatch(/expires 12 hours after joining; nothing renews it/i);
    expect(text).toMatch(/unpaired index-match entry expires 15 minutes after joining/i);
    expect(text.replace(/An unpaired index-match entry expires 15 minutes after joining\./, "")).not.toMatch(/15 minutes|join again to requeue/i);
  });

  it("join_queue describes joining, queue_status every status and leave_queue leaving", () => {
    expect(description("join_queue")).toMatch(/join the ranked matchmaking queue in one mode with your existing username or handle key/i);
    expect(description("queue_status")).toMatch(/none, waiting \(mode, joinedAt, expiresAt\), matched \(mode, lobbyId, matchedAt\) or expired \(mode, expiresAt\)/);
    expect(description("leave_queue")).toMatch(/leave the ranked queue with your key while your entry is waiting/i);
  });

  it("join_queue and queue_status say how a matched agent reaches its match", () => {
    for (const name of ["join_queue", "queue_status"]) {
      expect(description(name)).toMatch(/pairing starts a rated public match: follow read_lobby, then locate_match, and join the match server with your key/i);
    }
    expect(description("join_queue")).toMatch(/one entry per identity.*refused/i);
  });
});

describe.skipIf(!host)("ranked queue tools against the Firestore emulator", { timeout: 60_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (transport, open) => {
    it("joins the 1v1 queue with a key, shows it waiting with its expiry, refuses a second join and removes it on leave", async () => {
      const w = world();
      const call = await open(await serve(w.stores));
      const ann = await claim(call, "Ann");
      const joinedAt = w.now();
      const waiting = { state: "waiting", mode: "1v1", joinedAt, expiresAt: joinedAt + TWELVE_HOURS };

      expect(await ok(call, "queue_status", { key: ann.key })).toEqual({ queue: { state: "none" } });
      const joined = await ok(call, "join_queue", { key: ann.key, mode: "1v1" });
      expect(joined).toEqual({ queue: waiting, waitToken: expect.any(String), waitUrl: expect.any(String) });
      // While the entry waits, queue_status returns the same wait link the join did.
      const link = { waitToken: joined.waitToken, waitUrl: joined.waitUrl };
      w.advance(30_000);
      expect(await ok(call, "queue_status", { key: ann.key })).toEqual({ queue: waiting, ...link });

      const again = await call("join_queue", { key: ann.key, mode: "1v1" });
      expect([again.ok, again.body.error]).toEqual([false, "already_queued"]);
      expect(again.body.message).toMatch(/queue_status.*leave_queue/);
      if (transport === "HTTP") expect(again.status).toBe(409);
      expect(await ok(call, "queue_status", { key: ann.key })).toEqual({ queue: waiting, ...link });

      expect(await ok(call, "leave_queue", { key: ann.key })).toEqual({ queue: { state: "none" } });
      expect(await ok(call, "queue_status", { key: ann.key })).toEqual({ queue: { state: "none" } });
      expect(await ok(call, "join_queue", { key: ann.key, mode: "1v1" })).toEqual({ queue: { ...waiting, joinedAt: w.now(), expiresAt: w.now() + TWELVE_HOURS }, waitToken: expect.any(String), waitUrl: expect.any(String) });
    });

    it("refuses an unknown mode and an invalid key with their reasons", async () => {
      const w = world();
      const call = await open(await serve(w.stores));
      const ann = await claim(call, "Ann");
      const badMode = await call("join_queue", { key: ann.key, mode: "5v5" });
      expect([badMode.ok, badMode.body]).toEqual([false, { error: "invalid_mode", message: "The ranked queue's modes are 1v1, 2v2, 3v3, 4v4, house-1v1, house-2v2, house-3v3 and house-4v4." }]);
      if (transport === "HTTP") expect(badMode.status).toBe(400);
      for (const [op, args] of [["join_queue", { key: "x".repeat(43), mode: "1v1" }], ["queue_status", { key: "x".repeat(43) }], ["leave_queue", { key: "x".repeat(43) }]] as const) {
        const refused = await call(op, args);
        expect([refused.ok, refused.body.error], op).toEqual([false, "invalid_key"]);
        if (transport === "HTTP") expect(refused.status).toBe(401);
      }
      expect(await ok(call, "queue_status", { key: ann.key })).toEqual({ queue: { state: "none" } });
    });

    it("pairs a different-owner join into a started public 1v1 lobby that both statuses name and both seats can read", async () => {
      const w = world();
      const call = await open(await serve(w.stores));
      const [ann, bob] = [await claim(call, "Ann"), await claim(call, "Bob")];
      const annJoin = await ok(call, "join_queue", { key: ann.key, mode: "1v1" });
      w.advance(1_000);
      const bobJoin = await ok(call, "join_queue", { key: bob.key, mode: "1v1" });
      const { queue } = bobJoin;
      expect(queue).toEqual({ state: "matched", mode: "1v1", lobbyId: expect.any(String), matchedAt: w.now() });
      // Each identity's status and lobby read carry its own wait link, the one its join returned.
      const links = new Map([[ann.key, annJoin.waitToken], [bob.key, bobJoin.waitToken]]);
      expect(annJoin.waitToken).not.toBe(bobJoin.waitToken);
      for (const key of [ann.key, bob.key]) expect(await ok(call, "queue_status", { key })).toEqual({ queue, waitToken: links.get(key), waitUrl: `https://antwars.ai/wait/${links.get(key)}` });
      for (const key of [ann.key, bob.key]) {
        const { lobby, waitToken } = await ok(call, "read_lobby", { lobbyId: queue.lobbyId, key });
        expect(waitToken).toBe(links.get(key));
        expect(lobby).toMatchObject({ kind: "public", size: 1, state: "holding", rated: true, slot: "public-0" });
        expect(lobby.colonies).toEqual([[{ id: ann.id, displayName: "Ann" }], [{ id: bob.id, displayName: "Bob" }]]);
      }
      // A queue-made lobby is not offered for joining in list_lobbies.
      expect((await ok(call, "list_lobbies", {})).lobbies).toEqual([]);
    });
  });
});
