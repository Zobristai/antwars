/// <reference types="node" />
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_OPERATIONS, CHALLENGE_NOTICE_GUIDANCE, WAIT_STREAM_GUIDANCE, type AccountStores } from "../../src/accounts/service.ts";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import type { WatchRegistry } from "../../src/live/watch-registry.ts";
import { isLaunchable } from "../../src/lobby/houseLaunchable.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { HOUSE_LABELS } from "../../src/rating/house.ts";
import { createRatings, LEADERBOARD_SCOPES, RANKED_MODES, ratingCollection } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { houseCast, type Keyed } from "../lobby/house-fixtures.ts";
import { playable } from "../playable.ts";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG, type Agent } from "../server/helpers.ts";

/**
 * House challenges through the account operations, over MCP and POST /api/<name>: request_challenge,
 * list_challenge_opponents, set_challenge_availability, report_challenge_launch and challenge_status, the held seat
 * through join_lobby, the challenge label in read_lobby, list_lobbies and GET /watch/queue, and a finished challenge
 * game leaving every rating, Leaderboard table and Antwars Model Index value unchanged.
 */

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const MINUTE = 60_000;

type Body = any;
interface Reply { readonly ok: boolean; readonly status: number; readonly body: Body }
type Call = (op: string, args?: Record<string, unknown>) => Promise<Reply>;

const servers: GameServer[] = [];
const clients: Client[] = [];
const agents: Agent[] = [];
const closers: (() => Promise<void> | void)[] = [];
/** A 2 s match at 20 ticks a second that always reaches its natural time-up result. */
const SLOT_MATCH = playable(shortConfig(40, { ticksPerSecond: 20, queenFounding: PUBLIC_CONFIG.queenFounding }));

afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) await agent.close().catch(() => {});
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const close of closers.splice(0).reverse()) await close();
});

async function mcp(port: number): Promise<Call> {
  const client = new Client({ name: "challenge-api-test", version: "0.0.0" });
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

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

async function okBody(call: Call, op: string, args: Record<string, unknown> = {}) {
  const reply = await call(op, args);
  expect(reply.ok, `${op}: ${JSON.stringify(reply.body)}`).toBe(true);
  return reply.body;
}

/** A refusal's error code, with its HTTP status when the transport has one. */
async function refusal(call: Call, op: string, args: Record<string, unknown>) {
  const reply = await call(op, args);
  expect(reply.ok, `${op} should be refused`).toBe(false);
  return reply.status === 0 ? reply.body.error : `${reply.body.error} ${reply.status}`;
}

let counter = 0;

async function serve(transport: (port: number) => Promise<Call>) {
  const clock = { t: Date.UTC(2026, 10, 2, 12, 0, 0) };
  const namespace = `cha${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => clock.t });
  const ratings = createRatings(store);
  const stores: AccountStores = { identities, lobbies, ratings };
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate", simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts: stores,
  });
  servers.push(server);
  const cast = await houseCast(identities, store, 0);
  const handle = async (owner: Keyed, name: string): Promise<Keyed> => {
    const made = value(await identities.createHandle(owner.key, name));
    return { id: made.identity.id, key: made.key, displayName: made.identity.displayName };
  };
  const claim = async (name: string): Promise<Keyed> => {
    const made = value(await identities.claimUsername(name));
    return { id: made.identity.id, key: made.key, displayName: made.identity.displayName };
  };
  const glm = await handle(cast.house, "glm-5-3");
  const grok = await handle(cast.house, "grok-4-7");
  const call = await transport(server.port);
  return { clock, store, lobbies, ratings, stores, call, claim, handle, glm, grok, ...cast, raw: (path: string) => store.get(path) };
}
type Served = Awaited<ReturnType<typeof serve>>;

/** A public 1v1 player lobby between two fresh usernames, holding the one public slot. */
async function occupySlot(w: Served, name: string) {
  const a = await w.claim(`${name}a`), b = await w.claim(`${name}b`);
  const { lobby } = value(await w.lobbies.createLobby(a.key, "public", 1));
  value(await w.lobbies.join(lobby.id, a.key));
  expect(value(await w.lobbies.join(lobby.id, b.key)).state).toBe("holding");
  return { lobbyId: lobby.id, a, b };
}

const ORDINARY_LOBBY_KEYS = ["colonies", "createdAt", "creatorId", "expiresAt", "id", "kind", "mode", "outcome", "rated", "size", "slot", "startsAt", "state"];

describe.skipIf(!host)("house challenges through the account operations", { timeout: 180_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (_transport, open) => {
    it("creates a public unrated 1v1 lobby with the builder seated and the other seat held, labelled in read_lobby and list_lobbies", async () => {
      const w = await serve(open);
      const builder = await w.claim("builder");
      const ordinary = value(await w.lobbies.createLobby(w.rival.key, "public", 1)).lobby;
      const reply = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      expect(Object.keys(reply).sort()).toEqual(["lobbyId", "requestId", "seat", "waitToken", "waitUrl"]);
      expect(reply.seat).toBe(1);
      const { lobby } = await okBody(w.call, "read_lobby", { key: builder.key, lobbyId: reply.lobbyId });
      expect(lobby).toMatchObject({ id: reply.lobbyId, kind: "public", size: 1, state: "open", rated: false, creatorId: builder.id,
        challenge: { kind: "house", heldFor: "antwars/glm-5-3", heldColony: 0 } });
      expect(lobby.colonies).toEqual([[], [{ id: builder.id, displayName: builder.displayName }]]);
      const listed = (await okBody(w.call, "list_lobbies")).lobbies as Body[];
      expect(listed.find((row) => row.id === reply.lobbyId)).toEqual(lobby);
      const plain = listed.find((row) => row.id === ordinary.id);
      expect(Object.keys(plain).sort()).toEqual(ORDINARY_LOBBY_KEYS);
      expect(plain.rated).toBeNull();
    });

    it("refuses the held seat to every identity but its handle, whose own key joins it and starts an unrated match", async () => {
      const w = await serve(open);
      const builder = await w.claim("builder");
      const sameOwner = await w.handle(builder, "helper");
      const { lobbyId } = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      for (const other of [w.rival, w.rivalHandle, w.house, w.grok, sameOwner, ...w.lookalikes]) {
        expect(await refusal(w.call, "join_lobby", { key: other.key, lobbyId }), other.displayName).toMatch(/^seat_held( 409)?$/);
        expect(await refusal(w.call, "join_lobby", { key: other.key, lobbyId, colony: 0 }), other.displayName).toMatch(/^seat_held( 409)?$/);
        expect(await refusal(w.call, "join_lobby", { key: other.key, lobbyId, colony: 1 }), other.displayName).toMatch(/^colony_full( 409)?$/);
      }
      expect(await refusal(w.call, "join_lobby", { key: builder.key, lobbyId })).toMatch(/^already_seated( 409)?$/);
      const { lobby } = await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId });
      expect([lobby.state, lobby.rated, lobby.colonies[0]]).toEqual(["holding", false, [{ id: w.glm.id, displayName: w.glm.displayName }]]);

      // A House-table handle with no identity yet is held by name; once registered, its own key takes the seat.
      const later = await okBody(w.call, "request_challenge", { key: (await w.claim("later")).key, opponent: "antwars/claude-opus-5-5" });
      const registered = await w.handle(w.house, "claude-opus-5-5");
      const joined = (await okBody(w.call, "join_lobby", { key: registered.key, lobbyId: later.lobbyId })).lobby;
      expect([joined.state, joined.rated, joined.colonies[0]]).toEqual(["waiting", false, [{ id: registered.id, displayName: registered.displayName }]]);
    });

    it("refuses each named reason with no lobby, request, queue entry or count changed", async () => {
      const w = await serve(open);
      const builder = await w.claim("builder");
      const today = "challengeAllowance/2026-11-02";
      const snapshot = async (who: Keyed) => ({
        lobbies: (await w.store.query("lobbies", { orderBy: "createdAt", direction: "ASCENDING", limit: 100 })).rows,
        requests: (await w.store.query("challengeRequests", { orderBy: "createdAt", direction: "ASCENDING", limit: 100 })).rows,
        docs: await Promise.all(["listings/public", today, `queueEntries/${who.id}`, "queueWaiting/1v1", `challengeOwners/${who.id}`, `challengeChallengers/${who.id}`].map(w.raw)),
        allowanceLeft: (await w.lobbies.listChallengeOpponents()).allowanceLeft,
      });
      const refusedUnchanged = async (who: Keyed, args: Record<string, unknown>, code: string) => {
        const before = await snapshot(who);
        expect(await refusal(w.call, "request_challenge", args), code).toMatch(new RegExp(`^${code}( \\d{3})?$`));
        expect(await snapshot(who)).toEqual(before);
      };
      await refusedUnchanged(builder, { key: "not-a-key", opponent: "antwars/glm-5-3" }, "invalid_key");
      await refusedUnchanged(builder, { key: builder.key, opponent: "antwars/not-in-the-table" }, "opponent_unavailable");
      await refusedUnchanged(builder, { key: builder.key, opponent: "rival/scout" }, "opponent_unavailable");
      await okBody(w.call, "set_challenge_availability", { key: w.house.key, handle: "antwars/grok-4-7", available: false });
      await refusedUnchanged(builder, { key: builder.key, opponent: "antwars/grok-4-7" }, "opponent_unavailable");
      const unavailable = await w.call("request_challenge", { key: builder.key, opponent: "antwars/grok-4-7" });
      expect(unavailable.body.message).toContain("marked unavailable by the house owner");

      // A live waiting queue entry refuses; once expired (still stored "waiting"), the caller is admitted and the entry is untouched.
      // The entry joins 12 hours (the queue lifetime) before the rest of the test's clock, so 16 minutes on it has expired.
      const queued = await w.claim("queued");
      w.clock.t -= 12 * 60 * MINUTE;
      value(await w.lobbies.joinQueue(queued.key, "1v1"));
      await refusedUnchanged(queued, { key: queued.key, opponent: "antwars/glm-5-3" }, "already_queued");
      w.clock.t += 12 * 60 * MINUTE + 16 * MINUTE;
      const entryBefore = [await w.raw(`queueEntries/${queued.id}`), await w.raw("queueWaiting/1v1")];
      expect(entryBefore[0]?.state).toBe("waiting");
      await okBody(w.call, "request_challenge", { key: queued.key, opponent: "antwars/glm-5-3" });
      expect([await w.raw(`queueEntries/${queued.id}`), await w.raw("queueWaiting/1v1")]).toEqual(entryBefore);

      // Seated in another live lobby.
      const seated = await w.claim("seated");
      const { lobby } = value(await w.lobbies.createLobby(w.rival.key, "public", 2));
      value(await w.lobbies.join(lobby.id, seated.key));
      await refusedUnchanged(seated, { key: seated.key, opponent: "antwars/glm-5-3" }, "seated_elsewhere");

      // The owner's active challenge, from another of its identities.
      const handle = await w.handle(builder, "second");
      await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      await refusedUnchanged(handle, { key: handle.key, opponent: "antwars/glm-5-3" }, "active_challenge");
    });

    it("refuses join_queue and join_lobby live_challenge while the caller's challenge is live, with no wait token and nothing stored", async () => {
      const w = await serve(open);
      const builder = await w.claim("builder");
      await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      const { lobby } = value(await w.lobbies.createLobby(w.rival.key, "public", 1));
      const snapshot = async () => ({
        docs: await Promise.all([`queueEntries/${builder.id}`, "queueWaiting/1v1", `lobbies/${lobby.id}`].map(w.raw)),
        waits: (await w.store.query("waits", { orderBy: "expiresAt", direction: "ASCENDING", limit: 500 })).rows,
      });
      const before = await snapshot();
      for (const [op, args] of [["join_queue", { key: builder.key, mode: "1v1" }], ["join_lobby", { key: builder.key, lobbyId: lobby.id }]] as const) {
        const reply = await w.call(op, args);
        expect([reply.ok, reply.body.error, reply.body.waitToken], op).toEqual([false, "live_challenge", undefined]);
        if (reply.status !== 0) expect(reply.status, op).toBe(409);
        expect(reply.body.message, op).toContain("challenge_status");
      }
      expect(await snapshot()).toEqual(before);
    });

    it("refuses owner_daily_limit after an owner's 5 games and shared_daily_limit once 20 places are held today", async () => {
      const w = await serve(open);
      const owner = await w.claim("owner");
      for (let n = 0; n < 5; n++) {
        const { requestId, lobbyId } = await okBody(w.call, "request_challenge", { key: owner.key, opponent: "antwars/glm-5-3" });
        await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId });
        await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId, outcome: "launched" });
        value(await w.lobbies.releaseSlot(lobbyId));
      }
      expect(await refusal(w.call, "request_challenge", { key: owner.key, opponent: "antwars/glm-5-3" })).toMatch(/^owner_daily_limit( 429)?$/);
      for (let n = 0; n < 15; n++) await okBody(w.call, "request_challenge", { key: (await w.claim(`b${n}`)).key, opponent: "antwars/glm-5-3" });
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(0);
      expect(await refusal(w.call, "request_challenge", { key: (await w.claim("late")).key, opponent: "antwars/glm-5-3" })).toMatch(/^shared_daily_limit( 429)?$/);
    });

    it("lists every House-table seat handle without a key, with level, tier, availability and reason, the allowance left and the next reset", async () => {
      const w = await serve(open);
      const listed = await okBody(w.call, "list_challenge_opponents");
      // antwars/gpt-6-1-terra names recordings, not a seat, so it is not listed.
      expect(listed.opponents.map((entry: { handle: string }) => entry.handle)).not.toContain("antwars/gpt-6-1-terra");
      expect(listed.opponents).toEqual(Object.entries(HOUSE_LABELS).filter(([handle]) => handle !== "gpt-6-1-terra").map(([handle, label]) => ({
        handle: `antwars/${handle}`, displayName: label.displayName, level: label.thinkingLevel, tier: label.serviceTier,
        // With no records, a launch-table handle is open and any other seat is closed.
        ...(isLaunchable(handle) ? { available: true, reason: null } : { available: false, reason: "not on the house launch table" }),
      })));
      expect(listed.opponents.filter((entry: { available: boolean }) => entry.available)).toHaveLength(28);
      expect([listed.allowanceLeft, listed.resetsAt]).toEqual([20, Date.UTC(2026, 10, 3)]);
      await okBody(w.call, "request_challenge", { key: (await w.claim("builder")).key, opponent: "antwars/glm-5-3" });
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(19);
    });

    it("with a key also lists that username's challenges left today; without one the reply is unchanged; an unknown key is refused", async () => {
      const w = await serve(open);
      const owner = await w.claim("owner");
      const keyless = await okBody(w.call, "list_challenge_opponents");
      expect(Object.keys(keyless).sort()).toEqual(["allowanceLeft", "opponents", "resetsAt"]);
      expect(await okBody(w.call, "list_challenge_opponents", { key: owner.key })).toEqual({ ...keyless, usernameAllowanceLeft: 5 });
      await okBody(w.call, "request_challenge", { key: owner.key, opponent: "antwars/glm-5-3" });
      const keyed = await okBody(w.call, "list_challenge_opponents", { key: owner.key });
      expect([keyed.allowanceLeft, keyed.usernameAllowanceLeft]).toEqual([19, 4]);
      expect(Object.keys(await okBody(w.call, "list_challenge_opponents")).sort()).toEqual(["allowanceLeft", "opponents", "resetsAt"]);
      expect((await okBody(w.call, "list_challenge_opponents", { key: (await w.claim("other")).key })).usernameAllowanceLeft).toBe(5);
      expect(await refusal(w.call, "list_challenge_opponents", { key: "not-a-key" })).toMatch(/^invalid_key( \d+)?$/);
    });

    it("lets only the house owner set availability; unavailable is refused at once, a playing game continues, available restores it", async () => {
      const w = await serve(open);
      for (const other of [w.glm, w.rival, w.rivalHandle, ...w.lookalikes]) {
        expect(await refusal(w.call, "set_challenge_availability", { key: other.key, handle: "antwars/glm-5-3", available: false }), other.displayName).toMatch(/^not_house_owner( 403)?$/);
      }
      const builder = await w.claim("builder");
      const { requestId, lobbyId } = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId });
      await w.lobbies.registerInstance("public-0", { runId: "run-1", mcpUrl: "http://m", spectatorUrl: "http://s" });
      value(await w.lobbies.beginMatch(lobbyId, "public-0", "run-1"));
      expect((await okBody(w.call, "challenge_status", { key: builder.key })).state).toBe("playing");

      expect(await okBody(w.call, "set_challenge_availability", { key: w.house.key, handle: "antwars/glm-5-3", available: false })).toEqual({ handle: "antwars/glm-5-3", available: false });
      const row = (await okBody(w.call, "list_challenge_opponents")).opponents.find((o: Body) => o.handle === "antwars/glm-5-3");
      expect([row.available, row.reason]).toEqual([false, "marked unavailable by the house owner"]);
      expect(await refusal(w.call, "request_challenge", { key: (await w.claim("next")).key, opponent: "antwars/glm-5-3" })).toMatch(/^opponent_unavailable( 409)?$/);
      expect((await okBody(w.call, "challenge_status", { key: builder.key, requestId })).state).toBe("playing");
      expect(value(await w.lobbies.readLobby(lobbyId)).state).toBe("holding");

      await okBody(w.call, "set_challenge_availability", { key: w.house.key, handle: "glm-5-3", available: true });
      const other = await w.claim("other");
      const failed = await okBody(w.call, "request_challenge", { key: other.key, opponent: "antwars/grok-4-7" });
      await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: failed.requestId, outcome: "failed", reason: "no seat available" });
      expect(await refusal(w.call, "request_challenge", { key: (await w.claim("third")).key, opponent: "antwars/grok-4-7" })).toMatch(/^opponent_unavailable( 409)?$/);
      await okBody(w.call, "set_challenge_availability", { key: w.house.key, handle: "antwars/grok-4-7", available: true });
      const restored = (await okBody(w.call, "list_challenge_opponents")).opponents.find((o: Body) => o.handle === "antwars/grok-4-7");
      expect([restored.available, restored.reason]).toEqual([true, null]);
      await okBody(w.call, "request_challenge", { key: (await w.claim("fourth")).key, opponent: "antwars/grok-4-7" });
    });

    it("closes a House-table handle that is off the launch table, with no record and after an explicit open record", async () => {
      const w = await serve(open);
      const offTable = "antwars/mistral-large-latest";
      expect(isLaunchable(offTable)).toBe(false);
      const rowOf = async () => (await okBody(w.call, "list_challenge_opponents")).opponents.find((o: Body) => o.handle === offTable);
      // (a) No availability record: listed unavailable and refused.
      expect(await w.raw("challengeAvailability/mistral-large-latest")).toBeNull();
      expect([(await rowOf()).available, (await rowOf()).reason]).toEqual([false, "not on the house launch table"]);
      expect(await refusal(w.call, "request_challenge", { key: (await w.claim("first")).key, opponent: offTable })).toMatch(/^opponent_unavailable( 409)?$/);
      // (b) An explicit open record from set_challenge_availability true does not open it.
      expect(await okBody(w.call, "set_challenge_availability", { key: w.house.key, handle: offTable, available: true })).toEqual({ handle: offTable, available: true });
      expect((await w.raw("challengeAvailability/mistral-large-latest"))?.marked).toBe("");
      expect([(await rowOf()).available, (await rowOf()).reason]).toEqual([false, "not on the house launch table"]);
      expect(await refusal(w.call, "request_challenge", { key: (await w.claim("second")).key, opponent: offTable })).toMatch(/^opponent_unavailable( 409)?$/);
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(20);
    });

    it("accepts launch reports only from the house owner: launched once, failed closes the lobby uncharged with the handle unavailable", async () => {
      const w = await serve(open);
      const builder = await w.claim("builder");
      const launched = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      for (const other of [w.glm, builder, w.rival, ...w.lookalikes]) {
        expect(await refusal(w.call, "report_challenge_launch", { key: other.key, requestId: launched.requestId, outcome: "launched" }), other.displayName).toMatch(/^not_house_owner( 403)?$/);
      }
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: "00000000-0000-4000-8000-000000000000", outcome: "launched" })).toMatch(/^no_such_challenge( 404)?$/);
      await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId: launched.lobbyId });
      expect(await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: launched.requestId, outcome: "launched" }))
        .toEqual({ requestId: launched.requestId, launchReport: "launched", state: "waiting_for_slot" });
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: launched.requestId, outcome: "launched" })).toMatch(/^already_reported( 409)?$/);
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: launched.requestId, outcome: "failed", reason: "late" })).toMatch(/^house_seated( 409)?$/);
      expect((await okBody(w.call, "challenge_status", { key: w.house.key, requestId: launched.requestId })).launchReport).toBe("launched");
      value(await w.lobbies.releaseSlot(launched.lobbyId));
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(19);

      const other = await w.claim("other");
      const failing = await okBody(w.call, "request_challenge", { key: other.key, opponent: "antwars/grok-4-7" });
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(18);
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: failing.requestId, outcome: "failed" })).toMatch(/^reason_required( 400)?$/);
      expect(await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: failing.requestId, outcome: "failed", reason: "player launch refused" }))
        .toEqual({ requestId: failing.requestId, launchReport: "failed", state: "house_unavailable" });
      expect((await okBody(w.call, "read_lobby", { key: other.key, lobbyId: failing.lobbyId })).lobby).toMatchObject({ state: "ended", outcome: "not_played" });
      expect(await okBody(w.call, "challenge_status", { key: other.key })).toEqual({
        requestId: failing.requestId, lobbyId: failing.lobbyId, handle: "antwars/grok-4-7", state: "house_unavailable", reason: "player launch refused" });
      expect(await okBody(w.call, "challenge_status", { key: w.house.key, requestId: failing.requestId })).toMatchObject({ launchReport: "failed", launchReportReason: null });
      const row = (await okBody(w.call, "list_challenge_opponents")).opponents.find((o: Body) => o.handle === "antwars/grok-4-7");
      expect([row.available, row.reason]).toEqual([false, "player launch refused"]);
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(19);
      expect(await refusal(w.call, "join_lobby", { key: w.grok.key, lobbyId: failing.lobbyId })).toMatch(/^started( 409)?$/);
    });

    it("accepts unavailable only from the house owner: it ends the challenge house_unavailable uncharged with its reason and lists no handle unavailable", async () => {
      const w = await serve(open);
      const REASON = "maintenance";
      const rowOf = async () => (await okBody(w.call, "list_challenge_opponents")).opponents.find((o: Body) => o.handle === "antwars/glm-5-3");
      const rowBefore = await rowOf();
      expect([rowBefore.available, rowBefore.reason]).toEqual([true, null]);
      const availabilityBefore = await w.raw("challengeAvailability/glm-5-3");
      // The probe: a requestId that is no challenge id is refused no_such_challenge, with or without a reason.
      for (const probe of [{}, { reason: REASON }]) {
        expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: "halt-probe", outcome: "unavailable", ...probe })).toMatch(/^no_such_challenge( 404)?$/);
        expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: "00000000-0000-4000-8000-000000000000", outcome: "unavailable", ...probe })).toMatch(/^no_such_challenge( 404)?$/);
      }
      const builder = await w.claim("builder");
      const told = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      for (const other of [w.glm, builder, w.rival, ...w.lookalikes]) {
        expect(await refusal(w.call, "report_challenge_launch", { key: other.key, requestId: told.requestId, outcome: "unavailable", reason: REASON }), other.displayName).toMatch(/^not_house_owner( 403)?$/);
      }
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: told.requestId, outcome: "unavailable" })).toMatch(/^reason_required( 400)?$/);
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(19);
      expect(await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: told.requestId, outcome: "unavailable", reason: REASON }))
        .toEqual({ requestId: told.requestId, launchReport: "unavailable", state: "house_unavailable" });
      expect((await okBody(w.call, "read_lobby", { key: builder.key, lobbyId: told.lobbyId })).lobby).toMatchObject({ state: "ended", outcome: "not_played" });
      expect(await okBody(w.call, "challenge_status", { key: builder.key })).toEqual({
        requestId: told.requestId, lobbyId: told.lobbyId, handle: "antwars/glm-5-3", state: "house_unavailable", reason: "challenges are unavailable right now: maintenance" });
      expect((await okBody(w.call, "challenge_status", { key: w.house.key, requestId: told.requestId })).launchReport).toBe("unavailable");
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: told.requestId, outcome: "failed", reason: "late" })).toMatch(/^already_reported( 409)?$/);
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: told.requestId, outcome: "unavailable", reason: REASON })).toMatch(/^already_reported( 409)?$/);
      // No handle marked: the same row, no availability write, the allowance back, and the handle challengeable at once.
      expect(await rowOf()).toEqual(rowBefore);
      expect(await w.raw("challengeAvailability/glm-5-3")).toEqual(availabilityBefore);
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(20);
      const next = await okBody(w.call, "request_challenge", { key: (await w.claim("next")).key, opponent: "antwars/glm-5-3" });
      await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId: next.lobbyId });
      expect(await refusal(w.call, "report_challenge_launch", { key: w.house.key, requestId: next.requestId, outcome: "unavailable", reason: REASON })).toMatch(/^house_seated( 409)?$/);
    });

    it("ends a challenge whose held seat stays empty for 15 minutes expired and uncharged, including after a launched report", async () => {
      const w = await serve(open);
      const plainKey = (await w.claim("plain")).key;
      const plain = await okBody(w.call, "request_challenge", { key: plainKey, opponent: "antwars/glm-5-3" });
      // A house challenge lobby keeps 15 minutes, not a player lobby's 12 hours.
      const { lobby } = await okBody(w.call, "read_lobby", { key: plainKey, lobbyId: plain.lobbyId });
      expect(lobby.expiresAt - lobby.createdAt).toBe(15 * MINUTE);
      const early = await w.claim("early");
      const reported = await okBody(w.call, "request_challenge", { key: early.key, opponent: "antwars/grok-4-7" });
      await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: reported.requestId, outcome: "launched" });
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(18);
      w.clock.t += 15 * MINUTE;
      for (const { requestId } of [plain, reported]) {
        expect(await okBody(w.call, "challenge_status", { key: w.house.key, requestId })).toMatchObject({ state: "expired", reason: "house_did_not_join" });
      }
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(20);
      expect(await refusal(w.call, "join_lobby", { key: w.grok.key, lobbyId: reported.lobbyId })).toMatch(/^expired( 409)?$/);
      await okBody(w.call, "request_challenge", { key: early.key, opponent: "antwars/grok-4-7" });

      // A failed close after an early launched report returns its place too.
      const closing = await okBody(w.call, "request_challenge", { key: (await w.claim("closing")).key, opponent: "antwars/glm-5-3" });
      await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: closing.requestId, outcome: "launched" });
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(18);
      expect((await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId: closing.requestId, outcome: "failed", reason: "launch refused" })).state)
        .toBe("house_unavailable");
      expect((await okBody(w.call, "list_challenge_opponents")).allowanceLeft).toBe(19);
    });

    it("reports each state to its builder, any request to the house owner with launchReport and its reason, and nobody else's challenge to anyone else", async () => {
      const w = await serve(open);
      const blocker = await occupySlot(w, "blk");
      const builder = await w.claim("builder");
      const sibling = await w.handle(builder, "sibling");
      const { requestId, lobbyId } = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      const own = (state: string) => ({ requestId, lobbyId, handle: "antwars/glm-5-3", state });
      const MATCHED = `pinned harness matched @ ${"89abcdef".repeat(5)}`;
      expect(await okBody(w.call, "challenge_status", { key: builder.key })).toEqual(own("waiting_for_house"));
      expect(await okBody(w.call, "challenge_status", { key: w.house.key, requestId })).toEqual({ ...own("waiting_for_house"), launchReport: null, launchReportReason: null });
      for (const other of [sibling, w.glm, w.rival, ...w.lookalikes]) {
        expect(await refusal(w.call, "challenge_status", { key: other.key, requestId }), other.displayName).toMatch(/^no_such_challenge( 404)?$/);
        expect(await refusal(w.call, "challenge_status", { key: other.key }), other.displayName).toMatch(/^no_such_challenge( 404)?$/);
      }
      await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId });
      expect(await okBody(w.call, "challenge_status", { key: builder.key, requestId })).toEqual(own("waiting_for_slot"));
      value(await w.lobbies.releaseSlot(blocker.lobbyId));
      expect(value(await w.lobbies.readLobby(lobbyId)).state).toBe("holding");
      expect(await okBody(w.call, "challenge_status", { key: builder.key })).toEqual(own("waiting_for_slot"));
      await w.lobbies.registerInstance("public-0", { runId: "run-1", mcpUrl: "http://m", spectatorUrl: "http://s" });
      value(await w.lobbies.beginMatch(lobbyId, "public-0", "run-1"));
      expect(await okBody(w.call, "challenge_status", { key: builder.key })).toEqual(own("playing"));
      await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId, outcome: "launched", reason: MATCHED });
      value(await w.lobbies.endMatch(lobbyId, "run-1", "colony_1_won"));
      expect(await okBody(w.call, "challenge_status", { key: builder.key })).toEqual(own("finished"));
      expect(await okBody(w.call, "challenge_status", { key: w.house.key, requestId })).toEqual({ ...own("finished"), launchReport: "launched", launchReportReason: MATCHED });
    });

    it("leaves every rating, Leaderboard table and Antwars Model Index value unchanged after a challenge game's natural result", async () => {
      const w = await serve(open);
      const builder = await w.claim("builder");
      // A rated history first, so the tables are not empty.
      const rated = [await w.claim("ra"), await w.claim("rb")];
      value(await w.lobbies.joinQueue(rated[0]!.key, "1v1"));
      const pair = value(await w.lobbies.joinQueue(rated[1]!.key, "1v1"));
      await w.lobbies.registerInstance("public-0", { runId: "run-0", mcpUrl: "http://m", spectatorUrl: "http://s" });
      const pairLobby = pair.state === "matched" ? pair.lobbyId : "";
      value(await w.lobbies.beginMatch(pairLobby, "public-0", "run-0"));
      value(await w.lobbies.endMatch(pairLobby, "run-0", "colony_0_won"));
      const tables = async () => {
        const boards = [];
        for (const mode of RANKED_MODES) for (const scope of LEADERBOARD_SCOPES) boards.push(await okBody(w.call, "leaderboard", { mode, scope }));
        const people = [builder, w.glm, ...rated];
        const ratingsRead = [];
        for (const person of people) for (const mode of RANKED_MODES) ratingsRead.push(await okBody(w.call, "rating", { displayName: person.displayName, mode }));
        const docs = await Promise.all(people.flatMap((person) => RANKED_MODES.map((mode) => w.raw(`${ratingCollection(mode)}/${person.id}`))));
        return { boards, ratingsRead, docs };
      };
      const before = await tables();
      expect(before.docs.filter(Boolean)).toHaveLength(2);
      for (const winner of ["colony_0_won", "colony_1_won", "draw"] as const) {
        const { requestId, lobbyId } = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
        await okBody(w.call, "join_lobby", { key: w.glm.key, lobbyId });
        await okBody(w.call, "report_challenge_launch", { key: w.house.key, requestId, outcome: "launched" });
        await w.lobbies.registerInstance("public-0", { runId: `run-${winner}`, mcpUrl: "http://m", spectatorUrl: "http://s" });
        value(await w.lobbies.beginMatch(lobbyId, "public-0", `run-${winner}`));
        value(await w.lobbies.endMatch(lobbyId, `run-${winner}`, winner));
        expect((await okBody(w.call, "challenge_status", { key: builder.key })).state).toBe("finished");
      }
      expect(await tables()).toEqual(before);
    });
  });

  it("carries challenge \"house\" on the Waiting card's lobby rows through GET /watch/queue, and nothing new on ordinary rows", async () => {
    const w = await serve(async (port) => http(port));
    const ordinary = await w.claim("ordinary");
    const { lobby } = value(await w.lobbies.createLobby(ordinary.key, "public", 1));
    value(await w.lobbies.join(lobby.id, ordinary.key));
    w.clock.t += 1_000;
    const builder = await w.claim("builder");
    const { lobbyId } = await okBody(w.call, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
    const unstarted = await w.lobbies.listUnstarted();
    expect(unstarted.map((row) => Object.keys(row).sort())).toEqual([
      ["colonies", "createdAt", "mode", "seated", "size"], ["challenge", "colonies", "createdAt", "mode", "seated", "size"]]);
    const hub = new LiveHub(); closers.push(() => hub.close());
    const routes = watchRoutes({ accounts: w.stores, registry: {} as WatchRegistry, hub });
    const server = createServer((req, res) => { void routes(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/watch/queue`)).json() as { lobbies: Body[] };
    expect(body.lobbies.map((row) => Object.keys(row))).toEqual([
      ["mode", "size", "seated", "colonies", "waitingSeconds"],
      ["mode", "size", "seated", "colonies", "waitingSeconds", "challenge"],
    ]);
    expect(body.lobbies[1]).toMatchObject({ mode: null, size: 1, seated: 1, colonies: [[], [builder.displayName]], challenge: "house" });
    expect(JSON.stringify(body)).not.toContain(lobbyId);
  });

  it("plays mirror, owner-to-handle and handle-to-handle challenges on a slot server to a natural unrated result, moving no rating", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = createFirestore({ projectId, namespace: `chs${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, countdownMs: 300 });
    const ratings = createRatings(store);
    const root = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, accounts: { identities, lobbies, ratings } });
    servers.push(root);
    const slot = await startServer({
      port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: SLOT_MATCH, startPickWindowMs: 100,
      slot: { slot: "public-0", publicUrl: "http://challenge-slot.test", lobbies, identities, pollMs: 50 },
    });
    servers.push(slot);
    const cast = await houseCast(identities, store, 0);
    const handle = async (name: string): Promise<Keyed> => {
      const made = value(await identities.createHandle(cast.house.key, name));
      return { id: made.identity.id, key: made.key, displayName: made.identity.displayName };
    };
    const glm = await handle("glm-5-3"), grok = await handle("grok-4-7");
    // A rated history for both handles in every mode, so "unchanged" is measured against recorded ratings.
    for (const mode of RANKED_MODES) {
      expect((await ratings.applyResult({ matchId: `seed-${mode}`, teams: [[glm.id], [grok.id]], winner: "a", mode })).status).toBe("applied");
    }
    const call = await mcp(root.port);
    const viaHttp = http(root.port);
    const people = [cast.house, glm, grok];
    const before = await ratingTables(call, (path) => store.get(path), people);
    expect(before.docs.filter(Boolean)).toHaveLength(2 * RANKED_MODES.length);

    const games = [["mirror", glm, 2], ["owner to handle", cast.house, 1], ["handle to handle", grok, 1]] as const;
    for (const [name, builder, seat] of games) {
      const reply = await okBody(viaHttp, "request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
      expect(reply.seat, name).toBe(seat);
      const { lobby } = await okBody(call, "join_lobby", { key: glm.key, lobbyId: reply.lobbyId });
      expect([lobby.state, lobby.rated, lobby.slot], name).toEqual(["holding", false, "public-0"]);
      await okBody(viaHttp, "report_challenge_launch", { key: cast.house.key, requestId: reply.requestId, outcome: "launched" });
      // The held handle takes match seat 1 (colony 0); the builder takes the seat its reply named (colony 1).
      const joinSlot = async (key: string, matchSeat: number) => {
        const agent = await connect(slot.port);
        agents.push(agent);
        return until(async () => { const r = await agent.call("join", { key, seat: matchSeat }); return r.isError ? undefined : (r.data as { agentId: string }).agentId; });
      };
      const houseAgent = await joinSlot(glm.key, 1);
      const ownAgent = await joinSlot(builder.key, seat);
      expect(houseAgent, name).not.toBe(ownAgent);
      const colonies = await until(async () => {
        const played = slot.game.match?.state.agents;
        const [h, b] = [played?.find((agent) => agent.id === houseAgent), played?.find((agent) => agent.id === ownAgent)];
        return h && b ? [h.colony, b.colony] : undefined;
      });
      expect(colonies, name).toEqual([0, 1]);
      const ended = await until(async () => { const read = value(await lobbies.readLobby(reply.lobbyId)); return read.outcome ? read : undefined; }, 60_000);
      expect([ended.outcome, ended.rated], name).toEqual([expect.stringMatching(/^(colony_[01]_won|draw)$/), false]);
      expect((await okBody(call, "challenge_status", { key: builder.key, requestId: reply.requestId })).state, name).toBe("finished");
    }
    expect(await ratingTables(call, (path) => store.get(path), people)).toEqual(before);
  });
});

async function until<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

/** Every Leaderboard table (each mode and scope, so Ranked and the Model Index), each person's rating() and rating docs. */
async function ratingTables(call: Call, raw: (path: string) => Promise<unknown>, people: readonly Keyed[]) {
  const boards = [];
  for (const mode of RANKED_MODES) for (const scope of LEADERBOARD_SCOPES) boards.push(await okBody(call, "leaderboard", { mode, scope }));
  const ratingsRead = [];
  for (const person of people) for (const mode of RANKED_MODES) ratingsRead.push(await okBody(call, "rating", { displayName: person.displayName, mode }));
  const docs = await Promise.all(people.flatMap((person) => RANKED_MODES.map((mode) => raw(`${ratingCollection(mode)}/${person.id}`))));
  return { boards, ratingsRead, docs };
}

describe("list_challenge_opponents description", () => {
  it("names the optional key and usernameAllowanceLeft", () => {
    const description = ACCOUNT_OPERATIONS.find(op => op.name === "list_challenge_opponents")!.description;
    expect(description).toMatch(/key is optional/);
    expect(description).toMatch(/usernameAllowanceLeft is also your username's challenges left today of its 5, across its handles; it resets at resetsAt/);
  });
});

describe("noticing a challenge start", () => {
  it("request_challenge and challenge_status carry the same noticing sentence; the lobby and queue joins do not", () => {
    const description = (name: string) => ACCOUNT_OPERATIONS.find(op => op.name === name)!.description;
    expect(CHALLENGE_NOTICE_GUIDANCE).toMatch(/challenge_status once after requesting, then on a schedule \(once a minute recommended\) while it reads waiting_for_house or waiting_for_slot; join when it reads playing; stop on any other state;/);
    expect(CHALLENGE_NOTICE_GUIDANCE).toMatch(/a late join is allowed until the match server's idle limit, counted from match start, and the house bot plays your colony until you join; if you never join, the match ends abandoned, unrated; antwars-seat join-lobby <lobbyId> also works on the challenge's lobby: join_lobby answers already_seated, which it counts as seated, and it continues into the match\.$/);
    for (const name of ["request_challenge", "challenge_status"]) expect(description(name), name).toContain(CHALLENGE_NOTICE_GUIDANCE);
    for (const name of ["join_lobby", "join_queue"]) expect(description(name), name).not.toContain(CHALLENGE_NOTICE_GUIDANCE);
  });

  it("leads with the wait stream and keeps challenge_status polling for agents that cannot hold a stream", () => {
    const description = (name: string) => ACCOUNT_OPERATIONS.find(op => op.name === name)!.description;
    expect(CHALLENGE_NOTICE_GUIDANCE).toMatch(/^To notice that your challenge has started, wait on the stream at the waitUrl request_challenge returns \(described under Wait stream in request_challenge\): slot_ready means its match has, or had, a slot, so call locate_match until it assigns a match server, then join, unless challenge_status reads finished, when that match is already over; expired ends the challenge\. If you cannot hold a stream open, call challenge_status once after requesting/);
    expect(description("request_challenge")).toContain(WAIT_STREAM_GUIDANCE);
    expect(description("request_challenge")).toMatch(/the reply is requestId, lobbyId and seat, your match-server seat, plus waitToken and waitUrl\./);
    // The challenge lifetime is unchanged.
    expect(description("request_challenge")).toMatch(/does not join within the lobby's 15 minutes ends expired and uncharged/);
    for (const name of ["request_challenge", "challenge_status", "list_challenge_opponents"]) expect(description(name), name).not.toMatch(/house challenge/i);
  });
});
