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
import { HOUSE_MODES, houseCast, HOUSE_QUEUE_TTL_MS, type Keyed } from "../lobby/house-fixtures.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

/**
 * House mode through the queue tools, over MCP and POST /api/<name>:
 * join_queue in house-1v1 to house-4v4 accepts a handle of the antwars username
 * and refuses every other identity with not_house (HTTP 403), including identities
 * whose display name merely looks like antwars/<handle>.
 */

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
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
  const client = new Client({ name: "house-queue-test", version: "0.0.0" });
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

async function serveHouse() {
  const clock = { t: Date.UTC(2026, 9, 23, 12, 0, 0) };
  const namespace = `hqa${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => clock.t });
  const stores: AccountStores = { identities, lobbies, ratings: createRatings(store) };
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate", simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts: stores,
  });
  servers.push(server);
  return { clock, port: server.port, ...(await houseCast(identities, store, 2)) };
}

const NOT_HOUSE = { error: "not_house", message: "Only handles of the antwars username can join index matches." };

describe.skipIf(!host)("house mode through the queue tools", { timeout: 120_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (transport, open) => {
    it("accepts a handle of the antwars username at every house size and refuses every other identity with not_house", async () => {
      const w = await serveHouse();
      const call = await open(w.port);
      const handle = w.houseHandles[0]!;
      const refused: Keyed[] = [w.house, w.rival, w.rivalHandle, ...w.lookalikes];

      for (const mode of HOUSE_MODES) {
        const joinedAt = w.clock.t;
        const waiting = { state: "waiting", mode, joinedAt, expiresAt: joinedAt + HOUSE_QUEUE_TTL_MS };
        const joined = await call("join_queue", { key: handle.key, mode });
        expect(joined, JSON.stringify(joined.body)).toMatchObject({ ok: true, body: { queue: waiting } });
        expect((await call("queue_status", { key: handle.key })).body).toEqual({ queue: waiting, waitToken: joined.body.waitToken, waitUrl: joined.body.waitUrl });
        expect((await call("leave_queue", { key: handle.key })).body).toEqual({ queue: { state: "none" } });

        for (const identity of refused) {
          const reply = await call("join_queue", { key: identity.key, mode });
          expect([identity.displayName, mode, reply.ok, reply.body], transport).toEqual([identity.displayName, mode, false, NOT_HOUSE]);
          if (transport === "HTTP") expect(reply.status).toBe(403);
          expect((await call("queue_status", { key: identity.key })).body).toEqual({ queue: { state: "none" } });
        }
        w.clock.t += 1_000;
      }
    });
  });
});

describe("house mode in the queue tool descriptions", () => {
  it("describes house mode, its sizes, who may join it and its own rating per size in each queue tool's description", () => {
    for (const name of ["join_queue", "queue_status", "leave_queue"]) {
      const description = ACCOUNT_OPERATIONS.find((op) => op.name === name)?.description ?? "";
      expect(description, name).toContain(HOUSE_QUEUE_SENTENCE);
    }
  });
});

const HOUSE_QUEUE_SENTENCE = "Index matches (house-1v1, house-2v2, house-3v3 and house-4v4) admit only handles of the antwars username, pair them with each other at the same size, and give each index-match size its own Antwars Model Index rating.";
