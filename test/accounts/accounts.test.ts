/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_OPERATIONS, type AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, LOBBY_TTL_MS, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { comparison, connect, matchLogs, shortConfig, startComparisonMatch, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";
import { playable } from "../playable.ts";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";

// The store tests run inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; they are skipped only when it is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const COUNTDOWN_MS = 60_000;

/** A reply body, read field by field in assertions. */
type Body = any;
interface Reply { readonly ok: boolean; readonly status: number; readonly body: Body }
type Call = (op: string, args?: Record<string, unknown>) => Promise<Reply>;
type Headers = Record<string, string>;

const servers: GameServer[] = [];
const clients: Client[] = [];
/** Everything written to the console during a test. */
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" "));
    });
  }
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

async function mcp(port: number, headers: Headers = {}): Promise<Call> {
  const client = new Client({ name: "accounts-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return async (op, args = {}) => {
    const result = await client.callTool({ name: op, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    return { ok: result.isError !== true, status: 0, body: result.structuredContent ?? text };
  };
}

function http(port: number, headers: Headers = {}): Call {
  return async (op, args = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${op}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(args),
    });
    return { ok: res.status === 200, status: res.status, body: await res.json() };
  };
}

const TRANSPORTS: readonly [string, (port: number, headers?: Headers) => Promise<Call>][] = [
  ["MCP", mcp],
  ["HTTP", async (port, headers) => http(port, headers)],
];

/** An accounts-enabled server playing a long match, so its match log is written throughout. */
async function serve(accounts: AccountStores) {
  const dataDir = tempDir();
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir, ...comparison(0), simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts,
  });
  servers.push(server);
  await startComparisonMatch(server, 0);
  return { port: server.port, dataDir };
}

/** No issued key or invite token in the console or a match log. */
function expectNoSecrets(secrets: readonly string[], dataDir: string): void {
  const logs = [...matchLogs(dataDir).values()].map((path) => readFileSync(path, "utf8"));
  expect(logs.length).toBeGreaterThan(0);
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(20);
    for (const text of [...logged, ...logs]) expect(text).not.toContain(secret);
  }
}

let counter = 0;
function world() {
  let clock = Date.now();
  const namespace = `acc${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, countdownMs: COUNTDOWN_MS, now: () => clock });
  const stores: AccountStores = { identities, lobbies, ratings: createRatings(store) };
  const secrets: string[] = [];
  return {
    stores, secrets,
    advance(ms: number) { clock += ms; },
    now: () => clock,
    async lobby(id: string): Promise<Lobby> {
      const read = await lobbies.readLobby(id);
      if (!read.ok) throw new Error(read.reason);
      return read.value;
    },
  };
}

/** Claims a username through call and records its key as a secret. */
async function claim(call: Call, secrets: string[], name: string): Promise<{ id: string; key: string }> {
  const claimed = await call("claim_username", { name });
  expect(claimed.ok, JSON.stringify(claimed.body)).toBe(true);
  secrets.push(claimed.body.key);
  return { id: claimed.body.identity.id, key: claimed.body.key };
}

async function ok(call: Call, op: string, args: Record<string, unknown>): Promise<Body> {
  const reply = await call(op, args);
  expect(reply.ok, `${op}: ${JSON.stringify(reply.body)}`).toBe(true);
  return reply.body;
}

describe("account operations without a store", () => {
  /** A store whose every request fails, as an unreachable Firestore does. */
  const failing = (): AccountStores => {
    const store = createFirestore({ projectId, namespace: "unreachable", request: async () => { throw new TypeError("network down"); } });
    const identities = createIdentities(store);
    return { identities, lobbies: createLobbies(store, identities), ratings: createRatings(store) };
  };

  it("an accounts-enabled server keeps the match tools, and join and observe work as before", async () => {
    const { port } = await serve(failing());
    const client = new Client({ name: "accounts-list", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    clients.push(client);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const name of ["rules", "join", "observe", "order", "mark", ...ACCOUNT_OPERATIONS.map((op) => op.name)]) expect(names).toContain(name);
    // Check the real discovery path, without calling a key-issuing operation.
    for (const op of ACCOUNT_OPERATIONS) {
      expect(tools.find((tool) => tool.name === op.name)?.description).toBe(op.description);
    }
    const agent = await connect(port);
    try {
      const joined = await agent.call("join");
      expect(joined.isError, joined.text).toBe(false);
      expect((joined.data as Body).agentId).toEqual(expect.any(String));
      const observed = await agent.call("observe");
      expect(observed.isError, observed.text).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("a store failure is an error result over MCP and a 500 over HTTP, and logs no key", async () => {
    const { port, dataDir } = await serve(failing());
    const secret = "k".repeat(43);
    const viaMcp = await (await mcp(port))("rotate_key", { key: secret });
    expect(viaMcp.ok).toBe(false);
    expect(JSON.stringify(viaMcp.body)).not.toContain(secret);
    const res = await fetch(`http://127.0.0.1:${port}/api/rotate_key`, { method: "POST", body: JSON.stringify({ key: secret }) });
    expect(res.status).toBe(500);
    expect(logged.join("\n")).toContain("antwar 500 POST /api");
    expectNoSecrets([secret], dataDir);
  });

  it("refuses malformed, oversized, unknown and badly typed requests without logging the body", async () => {
    const { port } = await serve(failing());
    const base = `http://127.0.0.1:${port}/api`;
    const fragment = "secret-fragment-0123456789abcdef";
    const malformed = await fetch(`${base}/rotate_key`, { method: "POST", body: `{"key":"${fragment}` });
    expect([malformed.status, await malformed.json()]).toEqual([400, { error: "bad_json", message: "The body is not JSON." }]);
    const oversized = await fetch(`${base}/claim_username`, { method: "POST", body: `{"name":"${"a".repeat(1024 * 1024)}"}` });
    expect([oversized.status, await oversized.json()]).toEqual([413, { error: "body_too_large", message: "Request body too large." }]);
    const wrongMethod = await fetch(`${base}/list_lobbies`);
    expect([wrongMethod.status, wrongMethod.headers.get("allow")]).toEqual([405, "POST"]);
    expect((await fetch(`${base}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
    const badArgs = await fetch(`${base}/create_lobby`, { method: "POST", body: JSON.stringify({ key: fragment, size: 9, kind: "public" }) });
    expect([badArgs.status, await badArgs.json()]).toEqual([400, { error: "bad_arguments", message: "Invalid arguments: size." }]);
    expect(logged.join("\n")).not.toContain(fragment);
  });

  it("puts create_lobby's and issue_invite's invite links on antwars.ai whether the call arrived on antwars.ai or a run.app host", async () => {
    const lobbyId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const lobbies = {
      createLobby: async () => ({ ok: true, value: { lobby: { id: lobbyId }, inviteToken: "made-token" } }),
      issueInvite: async () => ({ ok: true, value: { inviteToken: "fresh-token" } }),
    } as unknown as AccountStores["lobbies"];
    const stores = { lobbies } as AccountStores;
    const run = (name: string, args: Record<string, unknown>, headers: Record<string, string>) =>
      ACCOUNT_OPERATIONS.find((op) => op.name === name)!.run(stores, args, headers);
    for (const headers of <Record<string, string>[]>[
      { host: "antwars.ai", "x-forwarded-proto": "https" },
      { host: "antwar-abc123defg-ts.a.run.app", "x-forwarded-proto": "https" },
      { host: "127.0.0.1:8080" },
    ]) {
      const created = await run("create_lobby", { key: "k", size: 1, kind: "private" }, headers);
      expect(created).toEqual({ ok: true, body: { lobby: { id: lobbyId }, inviteLink: `https://antwars.ai/?lobby=${lobbyId}#invite=made-token`, inviteToken: "made-token" } });
      const issued = await run("issue_invite", { key: "k", lobbyId }, headers);
      expect(issued).toEqual({ ok: true, body: { inviteLink: `https://antwars.ai/?lobby=${lobbyId}#invite=fresh-token`, inviteToken: "fresh-token" } });
    }
  });
});

describe("a lobby's colony names in its replies", () => {
  it("names an unrated lobby's colonies as its match will, and leaves a rated pairing's lobby as it was", async () => {
    const lobbyId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    for (const [mode, names] of [[null, drawColonyNames(lobbyId)], ["1v1", undefined]] as const) {
      const lobby = { id: lobbyId, mode };
      const lobbies = { createLobby: async () => ({ ok: true, value: { lobby } }) } as unknown as AccountStores["lobbies"];
      const created = await ACCOUNT_OPERATIONS.find((op) => op.name === "create_lobby")!.run({ lobbies } as AccountStores, { key: "k", size: 1, kind: "public" }, {});
      expect(created).toEqual({ ok: true, body: { lobby: names === undefined ? lobby : { ...lobby, colonyNames: names } } });
    }
  });
});

describe.skipIf(!host)("account operations against the Firestore emulator", { timeout: 60_000 }, () => {
  describe.each(TRANSPORTS)("over %s", (name, open) => {
    it("claims a free username, returning its key once with a warning, and refuses a taken one", async () => {
      const w = world();
      const { port, dataDir } = await serve(w.stores);
      const call = await open(port);
      const claimed = await ok(call, "claim_username", { name: "Ada" });
      w.secrets.push(claimed.key);
      expect(claimed.identity).toEqual({ id: expect.any(String), kind: "username", displayName: "Ada" });
      expect(claimed.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(claimed.warning).toContain("losing it loses the username");
      expect(await w.stores.identities.resolveKey(claimed.key)).toEqual({ ok: true, value: claimed.identity });
      const taken = await call("claim_username", { name: "ADA" });
      expect([taken.ok, taken.body]).toEqual([false, { error: "taken", message: "That name is taken." }]);
      expectNoSecrets(w.secrets, dataDir);
    });

    it("rotates a key, creates a handle with its own key, and reissues the handle's key", async () => {
      const w = world();
      const { port, dataDir } = await serve(w.stores);
      const call = await open(port);
      const owner = await claim(call, w.secrets, "Grace");
      const rotated = await ok(call, "rotate_key", { key: owner.key });
      w.secrets.push(rotated.key);
      expect((await w.stores.identities.resolveKey(owner.key)).ok).toBe(false);
      const handle = await ok(call, "create_handle", { key: rotated.key, handle: "scout" });
      w.secrets.push(handle.key);
      expect(handle.identity).toEqual({ id: expect.any(String), kind: "handle", displayName: "Grace/scout" });
      expect(await w.stores.identities.resolveKey(handle.key)).toEqual({ ok: true, value: handle.identity });
      const notOwner = await call("create_handle", { key: handle.key, handle: "other" });
      expect(notOwner.body.error).toBe("not_owner_key");
      const reissued = await ok(call, "reissue_handle_key", { key: rotated.key, handle: "Scout" });
      w.secrets.push(reissued.key);
      expect((await w.stores.identities.resolveKey(handle.key)).ok).toBe(false);
      expect(await w.stores.identities.resolveKey(reissued.key)).toEqual({ ok: true, value: handle.identity });
      expect((await call("reissue_handle_key", { key: rotated.key, handle: "ghost" })).body.error).toBe("no_such_handle");
      expectNoSecrets(w.secrets, dataDir);
    });

    it("lists public lobbies, creates public and private ones, and joins or refuses with the reason", async () => {
      const w = world();
      const { port, dataDir } = await serve(w.stores);
      const call = await open(port);
      const [a, b, c] = [await claim(call, w.secrets, "alpha"), await claim(call, w.secrets, "bravo"), await claim(call, w.secrets, "carol")];
      const pub = (await ok(call, "create_lobby", { key: a.key, size: 2, kind: "public" })).lobby as Lobby;
      expect(pub).toEqual(await w.lobby(pub.id));
      const joined = (await ok(call, "join_lobby", { key: a.key, lobbyId: pub.id })).lobby as Lobby;
      expect(joined.colonies[0].map((seat) => seat.displayName)).toEqual(["alpha"]);
      expect((await call("join_lobby", { key: a.key, lobbyId: pub.id })).body.error).toBe("already_seated");
      const listed = (await ok(call, "list_lobbies", {})).lobbies as Lobby[];
      expect(listed).toEqual(await w.stores.lobbies.listPublic());
      expect(listed.map((lobby) => [lobby.id, lobby.size, lobby.state, lobby.colonies.flat().length])).toEqual([[pub.id, 2, "open", 1]]);

      const created = await ok(call, "create_lobby", { key: b.key, size: 1, kind: "private" });
      const priv = created.lobby as Lobby;
      w.secrets.push(created.inviteToken);
      expect(created.inviteLink).toBe(`https://antwars.ai/?lobby=${priv.id}#invite=${created.inviteToken}`);
      expect((await ok(call, "list_lobbies", {})).lobbies.map((lobby: Lobby) => lobby.id)).toEqual([pub.id]);
      const missing = await call("join_lobby", { key: c.key, lobbyId: randomUUID(), inviteToken: created.inviteToken });
      expect(missing.body).toEqual({ error: "no_such_lobby", message: "No lobby with that id accepts this key or invite." });
      expect((await call("join_lobby", { key: c.key, lobbyId: priv.id, inviteToken: "wrong-token" })).body).toEqual(missing.body);
      expect((await call("join_lobby", { key: c.key, lobbyId: priv.id })).body).toEqual(missing.body);
      expect((await call("join_lobby", { key: c.key, lobbyId: "../usernames/x" })).body).toEqual(missing.body);
      const seated = (await ok(call, "join_lobby", { key: c.key, lobbyId: priv.id, inviteToken: created.inviteToken })).lobby as Lobby;
      expect(seated.colonies.flat().map((seat) => seat.id)).toEqual([c.id]);
      expect(seated).toEqual(await w.lobby(priv.id));
      expectNoSecrets(w.secrets, dataDir);
    });

    it("joins a handle into a chosen colony, refuses a chosen colony with no free seat with its reason and leaves the joiner unseated", async () => {
      const w = world();
      const { port, dataDir } = await serve(w.stores);
      const call = await open(port);
      const owner = await claim(call, w.secrets, "kite");
      const scout = await ok(call, "create_handle", { key: owner.key, handle: "scout" });
      w.secrets.push(scout.key);
      const [bravo, carol] = [await claim(call, w.secrets, "bravo"), await claim(call, w.secrets, "carol")];
      const id = ((await ok(call, "create_lobby", { key: owner.key, size: 1, kind: "public" })).lobby as Lobby).id;
      const seatIds = (lobby: Lobby) => lobby.colonies.map((colony) => colony.map((seat) => seat.id));

      // Colony 1 although colony 0 is emptier.
      const joined = (await ok(call, "join_lobby", { key: scout.key, lobbyId: id, colony: 1 })).lobby as Lobby;
      expect(seatIds(joined)).toEqual([[], [scout.identity.id]]);
      expect(joined).toEqual(await w.lobby(id));

      const refused = await call("join_lobby", { key: bravo.key, lobbyId: id, colony: 1 });
      expect([refused.ok, refused.body]).toEqual([false, {
        error: "colony_full", message: "That colony has no free seat in this lobby; you were not seated. Choose the other colony or join without a colony.",
      }]);
      if (name === "HTTP") expect(refused.status).toBe(409);
      expect(seatIds(await w.lobby(id))).toEqual([[], [scout.identity.id]]);

      // Only colony 0 or 1 is a colony.
      for (const colony of [2, -1, 0.5, "0"]) {
        const bad = await call("join_lobby", { key: carol.key, lobbyId: id, colony });
        expect(bad.ok).toBe(false);
        if (name === "HTTP") expect([bad.status, bad.body]).toEqual([400, { error: "bad_arguments", message: "Invalid arguments: colony." }]);
      }
      expect(seatIds(await w.lobby(id))).toEqual([[], [scout.identity.id]]);

      const full = (await ok(call, "join_lobby", { key: bravo.key, lobbyId: id, colony: 0 })).lobby as Lobby;
      expect(seatIds(full)).toEqual([[bravo.id], [scout.identity.id]]);
      expect(full).toMatchObject({ state: "holding", slot: "public-0" });
      expectNoSecrets(w.secrets, dataDir);
    });

    it("exposes player-created 1v1s as unrated, same-owner and different-owner alike, including antwars", async () => {
      const w = world();
      const { port, dataDir } = await serve(w.stores);
      const call = await open(port);
      const house = await claim(call, w.secrets, "antwars");
      const other = await claim(call, w.secrets, "Opponent");
      const scout = await ok(call, "create_handle", { key: house.key, handle: "scout" });
      const guard = await ok(call, "create_handle", { key: house.key, handle: "guard" });
      w.secrets.push(scout.key, guard.key);
      await w.stores.lobbies.registerInstance("public-0", { runId: "rating-rule", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });

      for (const pair of [[scout, guard], [house, scout]]) {
        const created = await ok(call, "create_lobby", { key: house.key, size: 1, kind: "public" });
        const id = (created.lobby as Lobby).id;
        await ok(call, "join_lobby", { key: pair[0]!.key, lobbyId: id });
        const full = (await ok(call, "join_lobby", { key: pair[1]!.key, lobbyId: id })).lobby as Lobby;
        expect(full).toMatchObject({ rated: false, state: "holding" });
        expect((await ok(call, "read_lobby", { key: house.key, lobbyId: id })).lobby).toEqual(full);
        expect(await w.stores.lobbies.beginMatch(id, "public-0", "rating-rule")).toEqual({ ok: true, value: null });
        expect(await w.stores.lobbies.endMatch(id, "rating-rule", "colony_0_won")).toEqual({ ok: true, value: { next: null } });
      }
      for (const displayName of ["antwars", "antwars/scout", "antwars/guard"]) {
        expect(await ok(call, "rating", { displayName })).toMatchObject({ rating: 1500, rd: 350, ratedMatches: 0 });
      }
      expect((await ok(call, "leaderboard", {})).entries).toEqual([]);

      const created = await ok(call, "create_lobby", { key: house.key, size: 1, kind: "public" });
      const id = (created.lobby as Lobby).id;
      await ok(call, "join_lobby", { key: scout.key, lobbyId: id });
      // A different-owner pair in a player-created lobby is unrated too.
      expect((await ok(call, "join_lobby", { key: other.key, lobbyId: id })).lobby).toMatchObject({ rated: false, state: "holding" });
      expect(await w.stores.lobbies.beginMatch(id, "public-0", "rating-rule")).toEqual({ ok: true, value: null });
      expect(await w.stores.lobbies.endMatch(id, "rating-rule", "colony_0_won")).toEqual({ ok: true, value: { next: null } });
      expect((await ok(call, "read_lobby", { key: house.key, lobbyId: id })).lobby).toMatchObject({ rated: false, outcome: "colony_0_won" });
      expect(await ok(call, "rating", { displayName: "antwars/scout" })).toMatchObject({ rating: 1500, rd: 350, ratedMatches: 0 });
      expect(await ok(call, "rating", { displayName: "Opponent" })).toMatchObject({ rating: 1500, rd: 350, ratedMatches: 0 });
      expect((await ok(call, "leaderboard", {})).entries).toEqual([]);
      expectNoSecrets(w.secrets, dataDir);
    });

    it("revokes and reissues invites and starts early, by the creator's key only", async () => {
      const w = world();
      const { port, dataDir } = await serve(w.stores);
      const call = await open(port);
      const [a, b, c, d] = [await claim(call, w.secrets, "ann"), await claim(call, w.secrets, "ben"), await claim(call, w.secrets, "cat"), await claim(call, w.secrets, "dan")];
      const created = await ok(call, "create_lobby", { key: a.key, size: 2, kind: "private" });
      const id = (created.lobby as Lobby).id;
      const first = created.inviteToken as string;
      w.secrets.push(first);
      await ok(call, "join_lobby", { key: b.key, lobbyId: id, inviteToken: first });
      expect((await call("revoke_invite", { key: b.key, lobbyId: id })).body.error).toBe("no_such_lobby");
      expect(await ok(call, "revoke_invite", { key: a.key, lobbyId: id })).toEqual({ revoked: true });
      expect((await call("join_lobby", { key: c.key, lobbyId: id, inviteToken: first })).body.error).toBe("no_such_lobby");
      const issued = await ok(call, "issue_invite", { key: a.key, lobbyId: id });
      w.secrets.push(issued.inviteToken);
      expect(issued.inviteLink).toBe(`https://antwars.ai/?lobby=${id}#invite=${issued.inviteToken}`);
      await ok(call, "join_lobby", { key: c.key, lobbyId: id, inviteToken: issued.inviteToken });
      expect((await call("join_lobby", { key: d.key, lobbyId: id, inviteToken: first })).body.error).toBe("no_such_lobby");
      expect((await call("start_lobby", { key: b.key, lobbyId: id })).body.error).toBe("no_such_lobby");
      const started = (await ok(call, "start_lobby", { key: a.key, lobbyId: id })).lobby as Lobby;
      expect(started).toMatchObject({ state: "holding", slot: "private-0", rated: false, startsAt: w.now() + COUNTDOWN_MS });
      expect(started).toEqual(await w.lobby(id));
      expect((await call("start_lobby", { key: a.key, lobbyId: id })).body.error).toBe("started");
      expectNoSecrets(w.secrets, dataDir);
    });
  });

  it("serves the full lobby state, as the store records it, to seat, creator and invite holders on both transports", async () => {
    const w = world();
    const { port, dataDir } = await serve(w.stores);
    const viaMcp = await mcp(port);
    const viaHttp = http(port);
    const holders = await Promise.all(["creator", "bee", "cee", "dee", "eee", "eff", "outsider"].map((name) => claim(viaHttp, w.secrets, name)));
    const [cr, bee, cee, dee, eee, eff, out] = holders;
    const keyOf = (holder: { key: string } | undefined) => holder!.key;

    /** The same read on both transports, equal to each other and to the store's record. */
    async function readBoth(args: Record<string, unknown>, id: string): Promise<Lobby> {
      const [m, h] = [await viaMcp("read_lobby", args), await viaHttp("read_lobby", args)];
      expect(m.ok, JSON.stringify(m.body)).toBe(true);
      expect(h.body).toEqual(m.body);
      const lobby = m.body.lobby as Lobby;
      expect(lobby).toEqual(await w.lobby(id));
      const text = JSON.stringify(m.body);
      for (const field of ["inviteVerifier", "matchRunId", "verifier", "key"]) expect(Object.keys(lobby)).not.toContain(field);
      for (const secret of w.secrets) expect(text).not.toContain(secret);
      return lobby;
    }

    // Holding: a full public lobby takes the one public slot and its countdown.
    const first = (await ok(viaHttp, "create_lobby", { key: keyOf(cr), size: 1, kind: "public" })).lobby as Lobby;
    await ok(viaHttp, "join_lobby", { key: keyOf(bee), lobbyId: first.id });
    await ok(viaHttp, "join_lobby", { key: keyOf(cee), lobbyId: first.id });
    const holding = await readBoth({ key: keyOf(cr), lobbyId: first.id }, first.id);
    expect(holding).toMatchObject({ state: "holding", slot: "public-0", rated: false, startsAt: w.now() + COUNTDOWN_MS, outcome: null });
    expect(await readBoth({ key: keyOf(bee), lobbyId: first.id }, first.id)).toEqual(holding);

    // Waiting: a second full public lobby finds no free slot.
    const second = (await ok(viaHttp, "create_lobby", { key: keyOf(dee), size: 1, kind: "public" })).lobby as Lobby;
    await ok(viaHttp, "join_lobby", { key: keyOf(dee), lobbyId: second.id });
    await ok(viaHttp, "join_lobby", { key: keyOf(eee), lobbyId: second.id });
    expect(await readBoth({ key: keyOf(eee), lobbyId: second.id }, second.id)).toMatchObject({ state: "waiting", slot: null, startsAt: null });

    // Open: a private lobby read by its current invite token alone.
    const created = await ok(viaHttp, "create_lobby", { key: keyOf(eff), size: 2, kind: "private" });
    w.secrets.push(created.inviteToken);
    const privateId = (created.lobby as Lobby).id;
    expect(await readBoth({ inviteToken: created.inviteToken, lobbyId: privateId }, privateId)).toMatchObject({ state: "open", slot: null });

    // Ended: the slot's instance begins and ends the first lobby's match, which hands the slot on.
    await w.stores.lobbies.registerInstance("public-0", { runId: "run-1", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });
    expect(await w.stores.lobbies.beginMatch(first.id, "public-0", "run-1")).toEqual({ ok: true, value: null });
    expect(await w.stores.lobbies.endMatch(first.id, "run-1", "colony_0_won")).toEqual({ ok: true, value: { next: second.id } });
    expect(await readBoth({ key: keyOf(cee), lobbyId: first.id }, first.id)).toMatchObject({ state: "ended", slot: null, outcome: "colony_0_won" });
    expect(await readBoth({ key: keyOf(dee), lobbyId: second.id }, second.id)).toMatchObject({ state: "holding", slot: "public-0", startsAt: expect.any(Number) });

    // Expired: the open private lobby, 12 hours after its creation.
    w.advance(LOBBY_TTL_MS);
    expect(await readBoth({ inviteToken: created.inviteToken, lobbyId: privateId }, privateId)).toMatchObject({ state: "expired" });

    // Anyone else is refused alike, whether or not the lobby exists.
    const refusals = async (args: Record<string, unknown>) => {
      const [m, h] = [await viaMcp("read_lobby", args), await viaHttp("read_lobby", args)];
      expect([m.ok, h.ok, h.body]).toEqual([false, false, m.body]);
      return { status: h.status, body: h.body };
    };
    const notFound = await refusals({ key: keyOf(out), lobbyId: randomUUID() });
    expect(notFound).toEqual({ status: 404, body: { error: "no_such_lobby", message: "No lobby with that id accepts this key or invite." } });
    expect(await refusals({ key: keyOf(out), lobbyId: first.id })).toEqual(notFound);
    expect(await refusals({ key: keyOf(out), lobbyId: "not-a-uuid" })).toEqual(notFound);
    expect(await refusals({ inviteToken: "wrong", lobbyId: privateId })).toEqual(notFound);
    expect(await refusals({ inviteToken: "wrong", lobbyId: randomUUID() })).toEqual(notFound);
    expectNoSecrets(w.secrets, dataDir);
  });

  it("refuses an invalid key identically whether or not the lobby exists, on both transports", async () => {
    const w = world();
    const { port, dataDir } = await serve(w.stores);
    const viaMcp = await mcp(port);
    const viaHttp = http(port);
    const owner = await claim(viaHttp, w.secrets, "owner");
    const created = await ok(viaHttp, "create_lobby", { key: owner.key, size: 1, kind: "private" });
    w.secrets.push(created.inviteToken);
    const existing = (created.lobby as Lobby).id;
    const invalid = "x".repeat(43);
    const expected = { error: "invalid_key", message: "That key is not valid." };
    for (const op of ["join_lobby", "revoke_invite", "issue_invite", "start_lobby", "read_lobby"]) {
      for (const lobbyId of [existing, randomUUID(), "bad id"]) {
        const args = { key: invalid, lobbyId, inviteToken: created.inviteToken };
        const [m, h] = [await viaMcp(op, args), await viaHttp(op, args)];
        expect([op, m.ok, m.body, h.status, h.body]).toEqual([op, false, expected, 401, expected]);
      }
    }
    for (const op of ["rotate_key", "create_handle", "reissue_handle_key"]) {
      // A valid handle name, so the refusal tested is the key, not the name rule.
      const args = { key: invalid, handle: "scout" };
      expect([(await viaMcp(op, args)).body, (await viaHttp(op, args)).body]).toEqual([expected, expected]);
    }
    expectNoSecrets(w.secrets, dataDir);
  });

  it("serves the leaderboard in pages of rated identities, and any identity's rating, alike on both transports", async () => {
    const w = world();
    const { port, dataDir } = await serve(w.stores);
    const viaMcp = await mcp(port);
    const viaHttp = http(port);
    const [winner, loser, unrated] = [await claim(viaHttp, w.secrets, "winner"), await claim(viaHttp, w.secrets, "loser"), await claim(viaHttp, w.secrets, "unrated")];
    const handle = await ok(viaHttp, "create_handle", { key: unrated.key, handle: "bot" });
    w.secrets.push(handle.key);
    expect(await w.stores.ratings.applyResult({ matchId: "m1", teams: [[winner.id], [loser.id]], winner: "a" })).toMatchObject({ status: "applied" });

    const both = async (op: string, args: Record<string, unknown>) => {
      const [m, h] = [await viaMcp(op, args), await viaHttp(op, args)];
      expect([m.ok, h.ok]).toEqual([true, true]);
      return { m: m.body, h: h.body };
    };
    const pageOne = await both("leaderboard", { limit: 1 });
    expect(pageOne.m.entries).toEqual([{ identityId: winner.id, displayName: "winner", ...FIRST_WIN, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, wins: 1, losses: 0, draws: 0, form: [{ result: "W", replayId: null }] }]);
    expect(pageOne.h.entries).toEqual(pageOne.m.entries);
    const pageTwo = await both("leaderboard", { limit: 1, cursor: pageOne.m.next });
    expect(pageTwo.m).toEqual({ entries: [{ identityId: loser.id, displayName: "loser", ...FIRST_LOSS, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, wins: 0, losses: 1, draws: 0, form: [{ result: "L", replayId: null }] }] });
    expect(pageTwo.h).toEqual(pageTwo.m);
    const whole = await both("leaderboard", {});
    expect(whole.m).toEqual({ entries: [...pageOne.m.entries, ...pageTwo.m.entries] });
    expect(whole.h).toEqual(whole.m);

    const rated = await both("rating", { displayName: "WINNER" });
    // Catch-up: Glicko-1 rating and RD from the independently derived fixture (test/rating/glicko-values.ts).
    expect(rated.m).toEqual({ identityId: winner.id, displayName: "winner", ...FIRST_WIN, ratedMatches: 1 });
    expect(rated.h).toEqual(rated.m);
    const ofHandle = await both("rating", { displayName: "unrated/bot" });
    // Catch-up: an unrated identity reads the Glicko-1 start, 1500 ± 350 (test/rating/glicko.test.ts).
    expect(ofHandle.m).toEqual({ identityId: handle.identity.id, displayName: "unrated/bot", rating: 1500, rd: 350, ratedMatches: 0 });
    expect(ofHandle.h).toEqual(ofHandle.m);

    const refused = async (op: string, args: Record<string, unknown>) => {
      const [m, h] = [await viaMcp(op, args), await viaHttp(op, args)];
      expect([m.ok, h.ok]).toEqual([false, false]);
      return { m: m.body, h: h.body, status: h.status };
    };
    const badCursor = await refused("leaderboard", { cursor: "not-a-cursor" });
    expect(badCursor).toEqual({ m: badCursor.h, h: { error: "invalid_cursor", message: "That cursor is not valid; start again from the first page." }, status: 400 });
    const unknown = await refused("rating", { displayName: "nobody" });
    expect(unknown).toEqual({ m: unknown.h, h: { error: "no_such_identity", message: "No identity has that display name." }, status: 404 });
    for (const limit of [0, 101, 1.5]) expect((await refused("leaderboard", { limit })).status).toBe(400);
    expectNoSecrets(w.secrets, dataDir);
  });

  it("serves a mode's everyone and house rankings, the 1v1 list without a mode, and refuses an unknown mode or scope, alike on both transports", async () => {
    const w = world();
    const { port, dataDir } = await serve(w.stores);
    const viaMcp = await mcp(port);
    const viaHttp = http(port);
    const house = await claim(viaHttp, w.secrets, "antwars");
    const scout = await ok(viaHttp, "create_handle", { key: house.key, handle: "scout" });
    w.secrets.push(scout.key);
    const rival = await claim(viaHttp, w.secrets, "rival");
    expect(await w.stores.ratings.applyResult({ matchId: "m1", teams: [[house.id], [rival.id]], winner: "a" })).toMatchObject({ status: "applied" });
    expect(await w.stores.ratings.applyResult({ matchId: "m2", teams: [[rival.id], [scout.identity.id]], winner: "a" })).toMatchObject({ status: "applied" });
    // Records after m1 and m2, newest first.
    const records: Record<string, object> = {
      [house.id]: { wins: 1, losses: 0, draws: 0, form: [{ result: "W", replayId: null }] },
      [scout.identity.id]: { wins: 0, losses: 1, draws: 0, form: [{ result: "L", replayId: null }] },
      [rival.id]: { wins: 1, losses: 1, draws: 0, form: [{ result: "W", replayId: null }, { result: "L", replayId: null }] },
    };
    const entry = async (identityId: string, displayName: string) => ({ identityId, displayName, ...(await w.stores.ratings.readRating(identityId)), thinkingLevel: null,
      serviceTier: null, benchmark: identityId !== rival.id, ...records[identityId] });
    const [antwarsEntry, scoutEntry, rivalEntry] = [await entry(house.id, "antwars"), await entry(scout.identity.id, "antwars/scout"), await entry(rival.id, "rival")];
    const byRating = (entries: { rating: number }[]) => [...entries].sort((a, b) => b.rating - a.rating);

    // Each call reads at its own time, so only a cursor's read time may differ between transports.
    const both = async (args: Record<string, unknown>) => {
      const [m, h] = [await viaMcp("leaderboard", args), await viaHttp("leaderboard", args)];
      expect([m.ok, h.ok]).toEqual([true, true]);
      expect(h.body.entries).toEqual(m.body.entries);
      expect("next" in h.body).toBe("next" in m.body);
      return m.body;
    };
    const everyone = byRating([antwarsEntry, scoutEntry, rivalEntry]);
    expect(await both({})).toEqual({ entries: everyone });
    expect(await both({ mode: "1v1" })).toEqual({ entries: everyone });
    expect(await both({ mode: "1v1", scope: "everyone" })).toEqual({ entries: everyone });
    expect(await both({ mode: "1v1", scope: "house" })).toEqual({ entries: byRating([antwarsEntry, scoutEntry]) });
    for (const mode of ["2v2", "3v3", "4v4"]) {
      expect(await both({ mode })).toEqual({ entries: [] });
      expect(await both({ mode, scope: "house" })).toEqual({ entries: [] });
    }
    const housePage = await both({ mode: "1v1", scope: "house", limit: 1 });
    expect(housePage.entries).toEqual(byRating([antwarsEntry, scoutEntry]).slice(0, 1));
    expect(await both({ mode: "1v1", scope: "house", limit: 1, cursor: housePage.next })).toEqual({ entries: byRating([antwarsEntry, scoutEntry]).slice(1) });

    const refused = async (args: Record<string, unknown>) => {
      const [m, h] = [await viaMcp("leaderboard", args), await viaHttp("leaderboard", args)];
      expect([m.ok, h.ok]).toEqual([false, false]);
      return h;
    };
    expect(await refused({ mode: "1v1", scope: "everyone", cursor: housePage.next })).toMatchObject({ status: 400, body: { error: "invalid_cursor" } });
    for (const args of [{ mode: "5v5" }, { mode: "house" }, { scope: "staff" }, { mode: "2v2", scope: "antwars" }]) {
      expect(await refused(args)).toMatchObject({ status: 400, body: { error: "bad_arguments" } });
    }
    expectNoSecrets(w.secrets, dataDir);
  });

  it("reads a rating per ranked mode, the 1v1 rating without a mode, and refuses an unknown mode, alike on both transports", async () => {
    const w = world();
    const { port, dataDir } = await serve(w.stores);
    const viaMcp = await mcp(port);
    const viaHttp = http(port);
    const [solo, team] = [await claim(viaHttp, w.secrets, "solo"), await claim(viaHttp, w.secrets, "team")];
    expect(await w.stores.ratings.applyResult({ matchId: "one", teams: [[solo.id], [team.id]], winner: "a" })).toMatchObject({ status: "applied" });
    expect(await w.stores.ratings.applyResult({ matchId: "three", mode: "3v3", teams: [[solo.id], [team.id]], winner: "b" })).toMatchObject({ status: "applied" });

    const both = async (args: Record<string, unknown>) => {
      const [m, h] = [await viaMcp("rating", args), await viaHttp("rating", args)];
      expect([m.ok, h.ok]).toEqual([true, true]);
      expect(h.body).toEqual(m.body);
      return m.body;
    };
    // Catch-up: Glicko-1 rating and RD from the independently derived fixture (test/rating/glicko-values.ts).
    const solo1v1 = { identityId: solo.id, displayName: "solo", ...FIRST_WIN, ratedMatches: 1 };
    // Without a mode: today's request and reply shape, holding the 1v1 rating.
    expect(await both({ displayName: "solo" })).toEqual(solo1v1);
    expect(await both({ displayName: "solo", mode: null })).toEqual(solo1v1);
    expect(await both({ displayName: "solo", mode: "1v1" })).toEqual(solo1v1);
    expect(await both({ displayName: "solo", mode: "3v3" })).toEqual({ ...solo1v1, ...FIRST_LOSS });
    expect(await both({ displayName: "team", mode: "3v3" })).toEqual({ identityId: team.id, displayName: "team", ...FIRST_WIN, ratedMatches: 1 });
    for (const mode of ["2v2", "4v4"]) {
      for (const name of ["solo", "team"]) expect(await both({ displayName: name, mode })).toMatchObject({ displayName: name, rating: 1500, ratedMatches: 0 });
    }

    for (const mode of ["5v5", "", "1V1", 1]) {
      const [m, h] = [await viaMcp("rating", { displayName: "solo", mode }), await viaHttp("rating", { displayName: "solo", mode })];
      expect([m.ok, h.ok]).toEqual([false, false]);
      expect(m.body).toMatch(/mode/);
      expect(h).toEqual({ ok: false, status: 400, body: { error: "bad_arguments", message: "Invalid arguments: mode." } });
    }
    expectNoSecrets(w.secrets, dataDir);
  });

  it("builds invite links on antwars.ai, not the address called, behind a proxy and directly, on both transports", async () => {
    const w = world();
    const { port, dataDir } = await serve(w.stores);
    const proxied = { "x-forwarded-proto": "https" };
    for (const call of [await mcp(port, proxied), http(port, proxied), await mcp(port), http(port)]) {
      const owner = await claim(call, w.secrets, `p${w.secrets.length}`);
      const created = await ok(call, "create_lobby", { key: owner.key, size: 1, kind: "private" });
      w.secrets.push(created.inviteToken);
      expect(created.inviteLink).toBe(`https://antwars.ai/?lobby=${created.lobby.id}#invite=${created.inviteToken}`);
    }
    expectNoSecrets(w.secrets, dataDir);
  });
});
