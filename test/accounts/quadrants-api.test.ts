/// <reference types="node" />
// The quadrants mode through the account API, over MCP and HTTP, on an in-memory store and on the Firestore emulator:
// four agents of distinct owners join, get the usual wait token and stream, and land in one unrated four-colony lobby;
// the mode is refused with its reason while no quadrant map is in its rotation; and the public Waiting endpoint keeps to
// the ranked queue, which the Matches page parses as before.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { LiveHub } from "../../src/live/hub.ts";
import type { WatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer } from "../../src/server.ts";
import type { MapDefinition } from "../../src/sim/config.ts";
import { createFirestore, type Fields, type Store } from "../../src/store/firestore.ts";
import { createMatchesData } from "../../web/src/matches-page/data.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const NO_MAP = "No Quadrants map is available yet, so the quadrants mode cannot be joined.";

/** Test-only quadrant geometry, not a production map. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};

/** A reply body, read field by field in assertions. */
type Body = any;
interface Reply { readonly ok: boolean; readonly status: number; readonly body: Body }
type Call = (op: string, args?: Record<string, unknown>) => Promise<Reply>;

const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function mcp(port: number): Promise<Call> {
  const client = new Client({ name: "quadrants-api-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  closers.push(() => client.close().catch(() => {}));
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

const TRANSPORTS: readonly [string, (port: number) => Promise<Call>][] = [["MCP", mcp], ["HTTP", async (port) => http(port)]];

/** Sequential transactions; a create of an existing document fails, as Firestore's does. */
function memoryStore(): Store {
  const docs = new Map<string, Fields>();
  return {
    namespace: "quadrants-api-test",
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
    async query() { throw new Error("the memory store does not query collections"); },
  };
}

let counter = 0;

/** The account stores served by startServer, with the public Waiting route beside them. quadrantMaps "shipped": the default rotation. */
async function world(backend: string, quadrantMaps: readonly MapDefinition[] | "shipped" = [FIXTURE]) {
  const clock = { t: Date.UTC(2026, 10, 14, 9, 0, 0) };
  const store = backend === "memory" ? memoryStore()
    : createFirestore({ projectId, namespace: `quadapi${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, {
    publicSlots: 1, privateSlots: 1, now: () => clock.t, ...(quadrantMaps === "shipped" ? {} : { quadrantMaps }),
  });
  const accounts: AccountStores = { identities, lobbies, ratings: createRatings(store) };
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts,
  });
  closers.push(() => server.close());
  const hub = new LiveHub();
  closers.push(() => hub.close());
  const routes = watchRoutes({ accounts, registry: {} as WatchRegistry, hub });
  const watch = createServer((req, res) => { void routes(req, res); });
  await new Promise<void>(resolve => watch.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>(resolve => { watch.closeAllConnections(); watch.close(() => resolve()); }));
  const watchOrigin = `http://127.0.0.1:${(watch.address() as AddressInfo).port}`;
  return { clock, port: server.port, watchOrigin };
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

/** The first frames of the wait stream for token, read for at most forMs. */
async function streamFrames(port: number, token: string, forMs = 2_000): Promise<{ event: string | null; data: Body }[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), forMs);
  let text = "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/wait/${token}`, { signal: abort.signal });
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
  } catch { /* the test's own timer ended the read */ } finally { clearTimeout(timer); }
  return text.split("\n\n").flatMap((block) => {
    const lines = block.split("\n").filter((line) => line !== "" && !line.startsWith(":") && !line.startsWith("retry:"));
    if (lines.length === 0) return [];
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return [{ event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? null, data: data === undefined ? undefined : JSON.parse(data) }];
  });
}

/** GET /watch/queue, and the Matches page's own Waiting read of that same body. */
async function waitingView(origin: string): Promise<{ body: Body; page: { status: string; rows: number } }> {
  const body = await (await fetch(`${origin}/watch/queue`)).json();
  const request = async (path: RequestInfo | URL) => new Response(JSON.stringify(
    path === "/watch/queue" ? body : path === "/watch/catalog" ? { matches: [] } : { matches: [], nextPageToken: null }));
  const data = createMatchesData(request as typeof fetch, () => {}, { waiting: true });
  data.refresh();
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const poll = () => data.view.waiting.status !== "loading" ? resolve() : Date.now() - started > 5_000 ? reject(new Error("waiting read never settled")) : setTimeout(poll, 10);
    poll();
  });
  const page = { status: data.view.waiting.status, rows: data.view.waiting.rows.length };
  data.destroy();
  return { body, page };
}

const withoutSeconds = (body: Body) => ({ ...body, waiting: body.waiting.map(({ waitingSeconds: _, ...row }: Body) => row) });

for (const backend of ["memory", "Firestore emulator"]) {
  describe.skipIf(backend === "Firestore emulator" && !host)(`the quadrants mode through the account API (${backend})`, { timeout: 120_000 }, () => {
    describe.each(TRANSPORTS)("over %s", (transport, open) => {
      it("waits three joins with the usual token and stream, then makes one unrated lobby of four one-seat colonies on the fourth", async () => {
        const w = await world(backend);
        const call = await open(w.port);
        const players = [];
        for (const name of ["Ann", "Bob", "Cat", "Dan"]) players.push(await claim(call, name));
        const tokens: string[] = [];
        for (const player of players.slice(0, 3)) {
          const joinedAt = w.clock.t;
          const joined = await ok(call, "join_queue", { key: player.key, mode: "quadrants" });
          expect(joined).toEqual({ queue: { state: "waiting", mode: "quadrants", joinedAt, expiresAt: joinedAt + TWELVE_HOURS }, waitToken: expect.any(String), waitUrl: expect.any(String) });
          expect(joined.waitUrl).toBe(`https://antwars.ai/wait/${joined.waitToken}`);
          tokens.push(joined.waitToken);
        }
        expect((await streamFrames(w.port, tokens[0]!, 300))[0]).toEqual({ event: null, data: { state: "waiting", mode: "quadrants", expiresAt: w.clock.t + TWELVE_HOURS } });

        const last = await ok(call, "join_queue", { key: players[3]!.key, mode: "quadrants" });
        expect(last.queue.state).toBe("matched");
        const lobbyId = last.queue.lobbyId as string;
        for (const player of players) expect((await ok(call, "queue_status", { key: player.key })).queue).toMatchObject({ state: "matched", mode: "quadrants", lobbyId });
        // A waiting partner's stream reports the pairing to its lobby.
        expect((await streamFrames(w.port, tokens[1]!))[0]).toEqual({ event: "paired", data: { state: "paired", lobbyId, lobbyWait: true } });

        const { lobby } = await ok(call, "read_lobby", { lobbyId, key: players[0]!.key });
        expect(lobby).toMatchObject({ kind: "public", size: 1, rated: false, mode: "quadrants", colonyNames: NAMES });
        expect(lobby.colonies.map((colony: Body[]) => colony.length)).toEqual([1, 1, 1, 1]);
        expect(lobby.colonies[3].map((seat: Body) => seat.id)).toEqual([players[3]!.id]);
        expect(lobby.colonies.flat().map((seat: Body) => seat.id).sort()).toEqual(players.map(player => player.id).sort());
        expect(lobby).not.toHaveProperty("result");
      });

      it("refuses quadrants with its reason while the rotation is empty, writing no entry, and refuses a quadrants rating", async () => {
        const w = await world(backend, "shipped");
        const call = await open(w.port);
        const ann = await claim(call, "Ann");
        const refused = await call("join_queue", { key: ann.key, mode: "quadrants" });
        expect([refused.ok, refused.body.error, refused.body.message]).toEqual([false, "no_quadrant_map", NO_MAP]);
        if (transport === "HTTP") expect(refused.status).toBe(409);
        expect(await ok(call, "queue_status", { key: ann.key })).toEqual({ queue: { state: "none" } });
        const rating = await call("rating", { displayName: "Ann", mode: "quadrants" });
        expect(rating.ok).toBe(false);
        if (transport === "HTTP") expect(rating.status).toBe(400);
      });
    });

    it("keeps quadrants entries and lobbies out of GET /watch/queue, which the Matches page reads as before", async () => {
      const w = await world(backend);
      const call = http(w.port);
      const solo = await claim(call, "Solo");
      await ok(call, "join_queue", { key: solo.key, mode: "1v1" });
      const before = await waitingView(w.watchOrigin);
      expect(before.body.waiting.map((row: Body) => [row.displayName, row.mode])).toEqual([["Solo", "1v1"]]);
      expect(before.page).toEqual({ status: "ready", rows: 1 });

      // A matched quadrants lobby waiting to begin, and one more quadrants entry waiting.
      const players = [];
      for (const name of ["Ann", "Bob", "Cat", "Dan", "Eve"]) players.push(await claim(call, name));
      for (const player of players) await ok(call, "join_queue", { key: player.key, mode: "quadrants" });
      expect((await ok(call, "queue_status", { key: players[3]!.key })).queue.state).toBe("matched");
      expect((await ok(call, "queue_status", { key: players[4]!.key })).queue.state).toBe("waiting");

      const after = await waitingView(w.watchOrigin);
      expect(withoutSeconds(after.body)).toEqual(withoutSeconds(before.body));
      expect(after.page).toEqual({ status: "ready", rows: 1 });
    });
  });
}
