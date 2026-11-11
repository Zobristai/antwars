/// <reference types="node" />
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

/**
 * Team-mode queue pairing: the ranked queue tools accept 2v2,
 * 3v3 and 4v4 and pair within each mode by the 1v1 rules; a paired team-mode match
 * is a full public lobby in which each agent holds every seat of its own colony;
 * multiplayer lobbies still refuse a second seat for one identity.
 * Also the public 2v2-4v4 part: two antwars-owned handles are
 * never paired with each other.
 *
 * Runs inside `firebase emulators:exec --only firestore`, which sets
 * FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when it is unset, and a
 * skipped run is never a pass.
 */
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const COUNTDOWN_MS = 60_000;
const QUEUE_TTL_MS = 12 * 60 * 60 * 1000;
const TEAM_MODES = [["2v2", 2], ["3v3", 3], ["4v4", 4]] as const;

/** A reply body, read field by field in assertions. */
type Body = any;
interface Reply { readonly ok: boolean; readonly body: Body }
type Call = (op: string, args?: Record<string, unknown>) => Promise<Reply>;

const servers: GameServer[] = [];
const clients: Client[] = [];

beforeEach(() => {
  for (const method of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

async function mcp(port: number): Promise<Call> {
  const client = new Client({ name: "team-queue-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return async (op, args = {}) => {
    const result = await client.callTool({ name: op, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    return { ok: result.isError !== true, body: result.structuredContent ?? text };
  };
}

function http(port: number): Call {
  return async (op, args = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
    });
    return { ok: res.status === 200, body: await res.json() };
  };
}

const TRANSPORTS: readonly [string, (port: number) => Promise<Call>][] = [
  ["MCP", mcp],
  ["HTTP", async (port) => http(port)],
];

let counter = 0;
/** One namespace with a test clock and an injectable pick for the queue's random choice. */
function world() {
  let clock = Date.UTC(2026, 9, 23, 12, 0, 0);
  const picks: number[] = [];
  const namespace = `tq${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, {
    publicSlots: 1, privateSlots: 1, countdownMs: COUNTDOWN_MS, now: () => clock,
    random: () => picks.shift() ?? 0,
  });
  const stores: AccountStores = { identities, lobbies, ratings: createRatings(store) };
  return {
    stores, picks, store,
    advance(ms: number) { clock += ms; },
    now: () => clock,
  };
}

async function serve(stores: AccountStores): Promise<number> {
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts: stores,
  });
  servers.push(server);
  return server.port;
}

async function ok(call: Call, op: string, args: Record<string, unknown>): Promise<Body> {
  const reply = await call(op, args);
  expect(reply.ok, `${op}: ${JSON.stringify(reply.body)}`).toBe(true);
  return reply.body;
}

interface Agent { readonly id: string; readonly key: string; readonly displayName: string }

async function username(call: Call, name: string): Promise<Agent> {
  const body = await ok(call, "claim_username", { name });
  return { id: body.identity.id, key: body.key, displayName: body.identity.displayName };
}

async function handle(call: Call, owner: Agent, name: string): Promise<Agent> {
  const body = await ok(call, "create_handle", { key: owner.key, handle: name });
  return { id: body.identity.id, key: body.key, displayName: body.identity.displayName };
}

const join = async (call: Call, agent: Agent, mode: string) => (await ok(call, "join_queue", { key: agent.key, mode })).queue;
const status = async (call: Call, agent: Agent) => (await ok(call, "queue_status", { key: agent.key })).queue;

/** Each colony's seat identity ids, in seat order. */
const seatIds = (lobby: Lobby) => lobby.colonies.map((colony) => colony.map((seat) => seat.id));

/** The lobby holds 2n seats: one colony is n seats all held by a, the other n seats all held by b. */
function expectEveryColonySeat(lobby: Lobby, n: number, a: Agent, b: Agent): void {
  const [first, second] = seatIds(lobby);
  const byColony = first![0] === a.id ? [a, b] : [b, a];
  expect(seatIds(lobby)).toEqual([Array(n).fill(byColony[0]!.id), Array(n).fill(byColony[1]!.id)]);
  expect(lobby.colonies.flat().map((seat) => seat.displayName).sort())
    .toEqual([...Array(n).fill(a.displayName), ...Array(n).fill(b.displayName)].sort());
  expect(new Set(first)).not.toEqual(new Set(second));
}

describe.skipIf(!host)("ranked 2v2, 3v3 and 4v4 queues through the queue tools", { timeout: 120_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (_name, open) => {
    it.each(TEAM_MODES)("%s: join waits with its expiry, and a different-owner join pairs both into a full public lobby holding every seat of each colony", async (mode, n) => {
      const w = world();
      const call = await open(await serve(w.stores));
      const [a, b] = [await username(call, "alpha"), await username(call, "bravo")];

      const joinedAt = w.now();
      expect(await join(call, a, mode)).toEqual({ state: "waiting", mode, joinedAt, expiresAt: joinedAt + QUEUE_TTL_MS });
      expect(await status(call, a)).toEqual({ state: "waiting", mode, joinedAt, expiresAt: joinedAt + QUEUE_TTL_MS });

      w.advance(1_000);
      const matched = await join(call, b, mode);
      expect(matched).toMatchObject({ state: "matched", mode, lobbyId: expect.any(String), matchedAt: w.now() });
      expect(await status(call, a)).toEqual(matched);
      expect(await status(call, b)).toEqual(matched);

      // Read by each seated agent's key: the same full public lobby, started and rated in this mode.
      const lobby = (await ok(call, "read_lobby", { key: a.key, lobbyId: matched.lobbyId })).lobby as Lobby;
      expect((await ok(call, "read_lobby", { key: b.key, lobbyId: matched.lobbyId })).lobby).toEqual(lobby);
      expect(lobby).toMatchObject({ id: matched.lobbyId, kind: "public", size: n, state: "holding", rated: true, mode });
      expect(lobby.colonies.flat()).toHaveLength(2 * n);
      expectEveryColonySeat(lobby, n, a, b);

      // The stored seats are today's {id, displayName, colony} shape, n per colony.
      const stored = JSON.parse((await w.store.get(`lobbies/${matched.lobbyId}`))!.seats!) as { id: string; displayName: string; colony: number }[];
      expect(stored).toHaveLength(2 * n);
      for (const colony of [0, 1]) {
        const seats = stored.filter((seat) => seat.colony === colony);
        expect(seats).toHaveLength(n);
        expect(new Set(seats.map((seat) => seat.id)).size).toBe(1);
      }
      // A queue-made lobby is not a player lobby: it is not in list_lobbies.
      expect(((await ok(call, "list_lobbies", {})).lobbies as Lobby[]).map((listed) => listed.id)).not.toContain(matched.lobbyId);
    });
  });

  it.each(TEAM_MODES)("%s: same-owner entries never pair, and a different-owner join takes one waiting entry chosen at random", async (mode, n) => {
    // A fresh store per pick, so each pick chooses among the same three waiting entries.
    for (const pick of [0, 0.4, 0.8]) {
      const w = world();
      const call = await mcp(await serve(w.stores));
      const owner = await username(call, "owner");
      const pool = [owner, await handle(call, owner, "one"), await handle(call, owner, "two")];
      // A username and its own handle, and two handles of one username, never pair: all three wait.
      for (const agent of pool) {
        expect(await join(call, agent, mode)).toMatchObject({ state: "waiting", mode });
        w.advance(1_000);
      }
      for (const agent of pool) expect(await status(call, agent)).toMatchObject({ state: "waiting", mode });

      const joiner = await username(call, "bravo");
      w.picks.push(pick);
      const matched = await join(call, joiner, mode);
      expect(matched).toMatchObject({ state: "matched", mode });
      const lobby = (await ok(call, "read_lobby", { key: joiner.key, lobbyId: matched.lobbyId })).lobby as Lobby;
      const partner = pool.find((agent) => lobby.colonies.flat().some((seat) => seat.id === agent.id))!;
      // The random pick, not queue order, decides the opponent: it is the waiting entry at the picked index.
      expect(partner?.id).toBe(pool[Math.floor(pick * pool.length)]!.id);
      expectEveryColonySeat(lobby, n, joiner, partner);
      // The two entries not picked are still waiting.
      for (const agent of pool.filter((entry) => entry !== partner)) expect(await status(call, agent)).toMatchObject({ state: "waiting", mode });
    }
  });

  it.each(TEAM_MODES)("%s: an unpaired entry expires 12 hours after joining, makes no lobby, and its identity can join again", async (mode) => {
    const w = world();
    const call = await mcp(await serve(w.stores));
    const [a, b] = [await username(call, "alpha"), await username(call, "bravo")];
    const joinedAt = w.now();
    await join(call, a, mode);

    w.advance(QUEUE_TTL_MS - 1);
    expect(await status(call, a)).toMatchObject({ state: "waiting", mode, expiresAt: joinedAt + QUEUE_TTL_MS });
    w.advance(1);
    expect(await status(call, a)).toEqual({ state: "expired", mode, expiresAt: joinedAt + QUEUE_TTL_MS });

    // A different-owner joiner finds no live entry to pair with and waits.
    expect(await join(call, b, mode)).toMatchObject({ state: "waiting", mode });
    expect(await w.stores.lobbies.listPublic()).toEqual([]);
    // The expired identity joins again and pairs with the live entry.
    expect(await join(call, a, mode)).toMatchObject({ state: "matched", mode });
  });

  it.each(TEAM_MODES)("%s: two antwars-owned handles are never paired with each other; a different owner pairs with exactly one", async (mode, n) => {
    const w = world();
    const call = await mcp(await serve(w.stores));
    const antwars = await username(call, "antwars");
    const handles = [await handle(call, antwars, "alpha"), await handle(call, antwars, "beta"), await handle(call, antwars, "gamma")];
    for (const agent of handles) expect(await join(call, agent, mode)).toMatchObject({ state: "waiting", mode });
    for (const agent of handles) expect(await status(call, agent)).toMatchObject({ state: "waiting", mode });

    const outsider = await username(call, "kite");
    const matched = await join(call, outsider, mode);
    expect(matched).toMatchObject({ state: "matched", mode });
    const statuses = await Promise.all(handles.map((agent) => status(call, agent)));
    expect(statuses.filter((entry) => entry.state === "matched")).toEqual([matched]);
    expect(statuses.filter((entry) => entry.state === "waiting")).toHaveLength(2);
    const lobby = (await ok(call, "read_lobby", { key: outsider.key, lobbyId: matched.lobbyId })).lobby as Lobby;
    expectEveryColonySeat(lobby, n, outsider, handles[statuses.findIndex((entry) => entry.state === "matched")]!);
  });

  it("never pairs entries across modes, including 1v1 and every team mode", async () => {
    const w = world();
    const call = await mcp(await serve(w.stores));
    const modes = ["1v1", "2v2", "3v3", "4v4"] as const;
    const first: Agent[] = [];
    for (const [i, mode] of modes.entries()) {
      const agent = await username(call, `first${i}`);
      first.push(agent);
      // Every earlier entry is a different owner in another mode, so this one waits.
      expect(await join(call, agent, mode)).toMatchObject({ state: "waiting", mode });
    }
    // A second different-owner joiner in each mode pairs with that mode's entry only.
    for (const [i, mode] of modes.entries()) {
      const second = await username(call, `second${i}`);
      const matched = await join(call, second, mode);
      expect(matched).toMatchObject({ state: "matched", mode });
      const lobby = (await ok(call, "read_lobby", { key: second.key, lobbyId: matched.lobbyId })).lobby as Lobby;
      expect(new Set(lobby.colonies.flat().map((seat) => seat.id))).toEqual(new Set([first[i]!.id, second.id]));
      expect(lobby).toMatchObject({ size: i + 1, mode });
      expect(await status(call, first[i]!)).toEqual(matched);
      for (const later of first.slice(i + 1)) expect(await status(call, later)).toMatchObject({ state: "waiting" });
    }
  });
});

describe.skipIf(!host)("multiplayer lobbies keep one seat per identity", { timeout: 120_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (_name, open) => {
    it.each([2, 3, 4])("a %dv%d player lobby refuses a second seat for an identity, including one paired into a team-mode match", async (size) => {
      const w = world();
      const call = await open(await serve(w.stores));
      const [a, b, c] = [await username(call, "alpha"), await username(call, "bravo"), await username(call, "carol")];

      // a holds every seat of its colony in a paired team-mode match.
      await join(call, a, `${size}v${size}`);
      const matched = await join(call, b, `${size}v${size}`);
      expect(matched).toMatchObject({ state: "matched" });

      for (const kind of ["public", "private"] as const) {
        const created = await ok(call, "create_lobby", { key: c.key, size, kind });
        const lobbyId = created.lobby.id as string;
        const invite = created.inviteToken === undefined ? {} : { inviteToken: created.inviteToken };
        const seated = (await ok(call, "join_lobby", { key: a.key, lobbyId, ...invite })).lobby as Lobby;
        expect(seatIds(seated).flat()).toEqual([a.id]);
        const again = await call("join_lobby", { key: a.key, lobbyId, ...invite });
        expect(again.ok).toBe(false);
        expect(again.body.error).toBe("already_seated");
        const read = (await ok(call, "read_lobby", { key: a.key, lobbyId })).lobby as Lobby;
        expect(seatIds(read).flat()).toEqual([a.id]);
      }
    });
  });
});
