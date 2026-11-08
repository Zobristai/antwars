/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer, type ServerOptions } from "../../src/server.ts";
import { createFirestore, type Fields, type Store } from "../../src/store/firestore.ts";
import { tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

/**
 * Shared setup for the seat client 1.0.0 refusal tests: an entry server
 * over the in-memory store or the Firestore emulator, and MCP sessions that report a
 * chosen clientInfo in initialize. The emulator runs inside
 * `firebase emulators:exec --only firestore`, which sets FIRESTORE_EMULATOR_HOST.
 */
export const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
export const BACKENDS = ["memory", "Firestore emulator"] as const;
export type Backend = (typeof BACKENDS)[number];

/** What each seat-client copy at 902d2dd4 sends in initialize, a later copy, and another MCP client. */
export const SEAT_CLIENT_1_0_0 = { name: "antwars-seat", version: "1.0.0" } as const;
export const SEAT_CLIENT_LATER = { name: "antwars-seat", version: "1.1.0" } as const;
export const OTHER_CLIENT = { name: "some-agent", version: "1.0.0" } as const;

/** Sequential transactions only, as the locator's memory backend. */
function memoryStore(): Store {
  const docs = new Map<string, Fields>();
  return {
    namespace: "seat-client-test",
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
    async query() { throw new Error("seat-client tests do not query collections"); },
  };
}

/** The store with a running count of committed document writes. */
function counted(store: Store): { store: Store; writes: () => number } {
  let writes = 0;
  return {
    writes: () => writes,
    store: {
      namespace: store.namespace,
      get: path => store.get(path),
      query: (collection, options) => store.query(collection, options),
      transaction: step => store.transaction(async read => {
        const next = await step(read);
        writes += next.writes.length;
        return next;
      }),
    },
  };
}

export interface World {
  readonly accounts: AccountStores;
  /** Document writes committed so far through these stores. */
  writes(): number;
}

export function world(backend: Backend): World {
  const base = backend === "memory" ? memoryStore() : createFirestore({ projectId, namespace: `seatclient-${randomUUID()}`, emulatorHost: host });
  const { store, writes } = counted(base);
  const identities = createIdentities(store);
  return {
    accounts: { identities, lobbies: createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, countdownMs: 60_000 }), ratings: createRatings(store) },
    writes,
  };
}

const servers: GameServer[] = [];
const clients: Client[] = [];

/** Close every session and server the test opened. */
export async function closeAll(): Promise<void> {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
}

/** The entry server (accounts, no slot), or a slot server with accounts. */
export async function serve(accounts: AccountStores, options: Pick<ServerOptions, "slot"> = {}): Promise<GameServer> {
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, accounts, ...options });
  servers.push(server);
  return server;
}

export interface Reply { readonly isError: boolean; readonly body: any; readonly result: CallToolResult }
export type Call = (name: string, args?: Record<string, unknown>) => Promise<Reply>;

/** One MCP session whose initialize reports clientInfo. */
export async function session(url: string, clientInfo: { name: string; version: string }): Promise<Call> {
  const client = new Client(clientInfo);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    if (JSON.stringify(result.structuredContent) !== text) throw new Error(`${name}: text content differs from structuredContent`);
    return { isError: result.isError === true, body: result.structuredContent, result };
  };
}

export function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}
