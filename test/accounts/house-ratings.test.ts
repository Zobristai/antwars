/// <reference types="node" />
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_OPERATIONS, type AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings, encodeRating, INITIAL_RD, ratingCollection, type RankedMode } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when it is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

type Body = any;
interface Reply { readonly ok: boolean; readonly body: Body }
type Call = (op: string, args: Record<string, unknown>) => Promise<Reply>;

const servers: GameServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

async function mcp(port: number): Promise<Call> {
  const client = new Client({ name: "house-ratings-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return async (op, args) => {
    const result = await client.callTool({ name: op, arguments: args });
    return { ok: result.isError !== true, body: result.structuredContent ?? (result.content as { text?: string }[])[0]?.text };
  };
}

const http = (port: number): Call => async (op, args) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/${op}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
  });
  return { ok: res.status === 200, body: await res.json() };
};

let counter = 0;

it("names index-match ratings and the Model Index without changing mode or scope values", () => {
  for (const name of ["rating", "leaderboard"]) {
    const op = ACCOUNT_OPERATIONS.find(op => op.name === name)!;
    expect(op.description).toContain("Index matches");
    expect(op.description).not.toMatch(/Benchmark/);
    expect(op.description).toContain("Antwars Model Index");
    expect(op.description).not.toMatch(/house ratings|house agents|house modes/i);
    for (const mode of ["house-1v1", "house-2v2", "house-3v3", "house-4v4"]) {
      const args = name === "rating" ? { mode, displayName: "antwars/model" } : { mode, scope: "house" };
      expect(op.input.parse(args)).toMatchObject(args);
    }
  }
  const scope = ACCOUNT_OPERATIONS.find(op => op.name === "leaderboard")!.input.shape.scope;
  expect(scope.description).toContain("house: only identities owned by the antwars username");
  expect(scope.description).toContain("the ranked ladder's house-models table in ranked modes, the Antwars Model Index in index-match modes");
  expect(ACCOUNT_OPERATIONS.find(op => op.name === "leaderboard")!.description).toContain("the ranked ladder's house-models table in ranked modes");
});

describe.skipIf(!host)("house ratings by size through the rating and leaderboard tools", { timeout: 60_000 }, () => {
  it("rating and leaderboard accept each house size as a mode and return that size's house ratings only, alike on both transports", async () => {
    const store = createFirestore({ projectId, namespace: `hr${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
    const identities = createIdentities(store);
    const stores: AccountStores = {
      identities, ratings: createRatings(store),
      lobbies: createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, countdownMs: 60_000 }),
    };
    const server = await startServer({
      port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts: stores,
    });
    servers.push(server);
    const transports: readonly Call[] = [await mcp(server.port), http(server.port)];
    const both = async (op: string, args: Record<string, unknown>) => {
      const replies = await Promise.all(transports.map((call) => call(op, args)));
      for (const reply of replies) expect(reply.ok, `${op} ${JSON.stringify(args)}: ${JSON.stringify(reply.body)}`).toBe(true);
      expect(replies[1]!.body).toEqual(replies[0]!.body);
      return replies[0]!.body;
    };
    /** Two pages of one page each, each transport following its own cursor (a cursor carries its first page's read time). */
    const twoPages = async (mode: RankedMode) => Promise.all(transports.map(async (call) => {
      const first = await call("leaderboard", { mode, limit: 1 });
      expect(first.ok, JSON.stringify(first.body)).toBe(true);
      expect(typeof first.body.next).toBe("string");
      const second = await call("leaderboard", { mode, limit: 1, cursor: first.body.next });
      expect(second.ok, JSON.stringify(second.body)).toBe(true);
      return [first.body.entries, second.body];
    }));

    const house = await identities.claimUsername("antwars");
    if (!house.ok) throw new Error(house.reason);
    const handle = async (name: string) => {
      const created = await identities.createHandle(house.value.key, name);
      if (!created.ok) throw new Error(created.reason);
      return { identityId: created.value.identity.id, displayName: created.value.identity.displayName };
    };
    const [a, b, c] = [await handle("ha"), await handle("hb"), await handle("hc")];
    const claimedPub = await identities.claimUsername("pub");
    if (!claimedPub.ok) throw new Error(claimedPub.reason);
    const pub = { identityId: claimedPub.value.identity.id, displayName: "pub" };

    // Each house size rates a different pair with its own ratings; public 1v1 rates a and pub.
    // Rows seeded without rd, as the Elo rule wrote them, read back with RD 350.
    const rows = (entries: readonly [{ identityId: string; displayName: string }, number, number][]) =>
      entries.map(([who, rating, ratedMatches]) => ({ ...who, rating, rd: 350, ratedMatches }));
    const boards: Record<RankedMode, ReturnType<typeof rows>> = {
      "house-1v1": rows([[a, 1531.5, 2], [b, 1468.5, 2]]),
      "house-2v2": rows([[b, 1516, 1], [c, 1484, 1]]),
      "house-3v3": rows([[c, 1522.25, 3], [a, 1477.75, 3]]),
      "house-4v4": rows([[a, 1540, 4], [c, 1460, 4]]),
      "1v1": rows([[a, 1600, 9], [pub, 1400, 9]]),
      "2v2": [], "3v3": [], "4v4": [],
    };
    for (const [mode, board] of Object.entries(boards) as [RankedMode, ReturnType<typeof rows>][]) {
      for (const { identityId, displayName, rating, ratedMatches } of board) {
        await store.transaction(async () => ({
          result: undefined,
          writes: [{ op: "create", path: `${ratingCollection(mode)}/${identityId}`, fields: { rating: encodeRating(rating), rd: encodeRating(INITIAL_RD), ratedMatches: String(ratedMatches), displayName } }],
        }));
      }
    }

    for (const mode of ["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const) {
      expect(await both("leaderboard", { mode }), mode).toEqual({ entries: boards[mode].map(row => ({ ...row, thinkingLevel: null, serviceTier: null, benchmark: false, wins: null, losses: null, draws: null, form: [] })) });
      for (const paged of await twoPages(mode)) expect(paged, `${mode} paged`).toEqual([boards[mode].slice(0, 1).map(row => ({ ...row, thinkingLevel: null, serviceTier: null, benchmark: false, wins: null, losses: null, draws: null, form: [] })), { entries: boards[mode].slice(1).map(row => ({ ...row, thinkingLevel: null, serviceTier: null, benchmark: false, wins: null, losses: null, draws: null, form: [] })) }]);
      for (const who of [a, b, c, pub]) {
        const row = boards[mode].find((entry) => entry.identityId === who.identityId);
        expect(await both("rating", { displayName: who.displayName, mode }), `${mode} ${who.displayName}`)
          .toEqual(row ?? { ...who, rating: 1500, rd: 350, ratedMatches: 0 });
      }
    }
  });
});
