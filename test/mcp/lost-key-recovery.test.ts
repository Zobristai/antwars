/// <reference types="node" />
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAccountTools } from "../../src/accounts/mcpTools.js";
import { createIdentities, type Identities } from "../../src/identity/identities.js";
import { INACTIVE_USERNAME_MS } from "../../src/identity/retention.js";
import type { Fields, Store, Write } from "../../src/store/firestore.js";
import type { AccountStores } from "../../src/accounts/service.js";
import { Game } from "../../src/mcp/game.js";
import { createMcpHandler } from "../../src/mcp/http.js";
import { TEST_MCP_CONFIG } from "./harness.js";

// A key-issuing call whose client drops while its commit is in flight saves a key it never delivers.
// recover_key, in the same session and presenting the same key the call presented, re-issues a fresh key
// to the identity that call proved, replacing the undelivered one. Keys are compared, never printed.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An in-memory store that records commits and can run a hook while a commit is in flight. */
function memoryStore() {
  const docs = new Map<string, Fields>();
  const seen = {
    transactions: 0,
    commits: [] as (readonly Write[])[],
    onCommit: undefined as (() => Promise<void>) | undefined,
  };
  const store: Store = {
    namespace: "lost-key-recovery-test",
    async get(path) {
      seen.transactions += 1;
      return docs.get(path) ?? null;
    },
    async transaction(step) {
      seen.transactions += 1;
      const next = await step(async (paths) => new Map(paths.map((path) => [path, docs.get(path) ?? null])));
      if (next.writes.length > 0) {
        const hook = seen.onCommit;
        seen.onCommit = undefined;
        await hook?.();
      }
      for (const write of next.writes) {
        if (write.op === "delete") docs.delete(write.path);
        else docs.set(write.path, { ...docs.get(write.path), ...write.fields });
      }
      if (next.writes.length > 0) seen.commits.push(next.writes);
      return next.result;
    },
    async query() {
      throw new Error("not used");
    },
  };
  return { store, seen, docs };
}

async function start() {
  const { store, seen, docs } = memoryStore();
  /** How far the identity store's clock runs ahead of real time, so a test can let a username be released. */
  const clock = { offsetMs: 0 };
  const identities = createIdentities(store, { now: () => Date.now() + clock.offsetMs });
  /** Every key a key-issuing operation returned, in order, so a test can check an undelivered key. */
  const issued: string[] = [];
  const keep = <T>(outcome: T): T => {
    const value = (outcome as { ok: boolean; value?: { key?: unknown } }).value;
    if ((outcome as { ok: boolean }).ok && typeof value?.key === "string") issued.push(value.key);
    return outcome;
  };
  const watched: Identities = {
    ...identities,
    claimUsername: async (...args) => keep(await identities.claimUsername(...args)),
    rotateKey: async (...args) => keep(await identities.rotateKey(...args)),
    createHandle: async (...args) => keep(await identities.createHandle(...args)),
    reissueHandleKey: async (...args) => keep(await identities.reissueHandleKey(...args)),
    reissueLostKey: async (...args) => keep(await identities.reissueLostKey(...args)),
  };
  const stores = { identities: watched } as unknown as AccountStores;
  const handler = createMcpHandler(new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 8, maxProtectedSessions: 4 } }), {
    gameplay: false,
    extraTools: (server, session) => registerAccountTools(server, stores, { seatClientAdmission: false, session }),
  });
  /** POST responses that closed before they finished writing, and POSTs still being handled (the client's GET stream stays open). */
  const http = { cut: 0, inFlight: 0 };
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") return void handler.handle(req, res);
    http.inFlight += 1;
    res.once("close", () => {
      if (!res.writableFinished) http.cut += 1;
    });
    void handler.handle(req, res).finally(() => {
      http.inFlight -= 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(async () => {
    await handler.close();
    // Idle keep-alive connections would otherwise hold the close open until the client times them out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  return { url, seen, docs, identities, issued, http, clock };
}

type World = Awaited<ReturnType<typeof start>>;

async function session(world: World): Promise<{ client: Client; sessionId: string }> {
  const client = new Client({ name: "lost-key-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(world.url);
  await client.connect(transport);
  cleanups.push(() => client.close().catch(() => {}));
  return { client, sessionId: transport.sessionId! };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: (result.structuredContent ?? {}) as Record<string, unknown> };
};

/**
 * Call a tool on the session with a raw request whose client disconnects while the call's commit is in flight:
 * the commit lands, and its reply is never delivered. Resolves once the server has finished handling it.
 */
async function dropDuringCommit(world: World, sessionId: string, name: string, args: Record<string, unknown>): Promise<void> {
  const abort = new AbortController();
  const commits = world.seen.commits.length;
  const cut = world.http.cut;
  world.seen.onCommit = async () => {
    abort.abort();
    await vi.waitFor(() => expect(world.http.cut).toBe(cut + 1));
  };
  const outcome = await fetch(world.url, {
    method: "POST",
    signal: abort.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 900, method: "tools/call", params: { name, arguments: args } }),
  }).then((res) => res.text()).then(() => "delivered", () => "dropped");
  expect(outcome).toBe("dropped");
  await vi.waitFor(() => expect(world.http.inFlight).toBe(0));
  expect(world.seen.commits.length).toBe(commits + 1);
}

/** A raw tools/call on the session that the test can abort; settles "delivered" or "dropped". */
function rawCall(world: World, sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return fetch(world.url, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 901, method: "tools/call", params: { name, arguments: args } }),
  }).then((res) => res.text()).then(() => "delivered", () => "dropped");
}

/** Let the server run whatever the requests just sent can run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** An owner username with one handle, from a session whose replies arrive. */
async function owner(client: Client): Promise<{ ownerKey: string; handleKey: string }> {
  const claimed = await call(client, "claim_username", { name: "owner" });
  expect(claimed.isError).toBe(false);
  const created = await call(client, "create_handle", { key: claimed.body.key, handle: "scout" });
  expect(created.isError).toBe(false);
  return { ownerKey: claimed.body.key as string, handleKey: created.body.key as string };
}

const works = async (world: World, key: string) => (await world.identities.resolveKey(key)).ok;

/** Each key-issuing call: its arguments, the key recover_key presents for it, and the identity it issues a key to. */
const CASES = [
  { tool: "claim_username", args: () => ({ name: "newcomer" }), proof: () => ({}), identity: "newcomer" },
  { tool: "rotate_key", args: (k: Keys) => ({ key: k.ownerKey }), proof: (k: Keys) => ({ key: k.ownerKey }), identity: "owner" },
  { tool: "create_handle", args: (k: Keys) => ({ key: k.ownerKey, handle: "second" }), proof: (k: Keys) => ({ key: k.ownerKey }), identity: "owner/second" },
  { tool: "reissue_handle_key", args: (k: Keys) => ({ key: k.ownerKey, handle: "scout" }), proof: (k: Keys) => ({ key: k.ownerKey }), identity: "owner/scout" },
] as const;
type Keys = { ownerKey: string; handleKey: string };

describe("recovering a key whose reply was lost when the client dropped mid-commit", () => {
  for (const { tool, args, proof, identity } of CASES) {
    it(`${tool}: recover_key in the same session issues a fresh key to the proven identity, and the undelivered key stops working`, async () => {
      const world = await start();
      const { client, sessionId } = await session(world);
      const keys = await owner(client);

      await dropDuringCommit(world, sessionId, tool, args(keys));
      const undelivered = world.issued.at(-1)!;
      const target = await world.identities.findByDisplayName(identity);
      expect(target).toBeDefined();
      // The commit landed: the undelivered key holds the identity, though its holder never saw it.
      expect(await world.identities.resolveKey(undelivered)).toMatchObject({ ok: true, value: { id: target!.id } });

      const recovered = await call(client, "recover_key", proof(keys));
      expect(recovered.isError, JSON.stringify(recovered.body.error)).toBe(false);
      const fresh = recovered.body.key as string;
      expect(typeof fresh).toBe("string");
      expect(Object.keys(recovered.body).sort()).toEqual(["key", "warning"]);
      // Nothing replayed: a new key, held by the same identity; the undelivered one no longer works.
      // Compared as a boolean, so a failure never prints a key.
      expect(fresh === undelivered).toBe(false);
      expect(await world.identities.resolveKey(fresh)).toMatchObject({ ok: true, value: { id: target!.id } });
      expect(await works(world, undelivered)).toBe(false);
      // The recovery commit replaced the key and spent no claim or rotation budget.
      const recovery = world.seen.commits.at(-1)!;
      expect(recovery.some((write) => write.path.startsWith("identityClaimLimits/"))).toBe(false);

      // One-shot: a second recover_key is refused, and the fresh key keeps working.
      const again = await call(client, "recover_key", proof(keys));
      expect(again.isError).toBe(true);
      expect(again.body.error).toBe("nothing_to_recover");
      expect(await works(world, fresh)).toBe(true);
    });
  }

  it("is refused in a session with nothing pending, without reading the store or saying whether an identity exists", async () => {
    const world = await start();
    const setup = await session(world);
    const keys = await owner(setup.client);
    const { client } = await session(world);
    const transactions = world.seen.transactions;
    const replies = [
      await call(client, "recover_key", {}),
      await call(client, "recover_key", { key: keys.ownerKey }),
      await call(client, "recover_key", { key: "not-a-key" }),
    ];
    for (const reply of replies) {
      expect(reply.isError).toBe(true);
      expect(reply.body).toEqual(replies[0]!.body);
    }
    expect(replies[0]!.body.error).toBe("nothing_to_recover");
    expect(world.seen.transactions).toBe(transactions);
  });

  it("is available only to the session that made the call, presenting the key that call presented", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    await dropDuringCommit(world, sessionId, "rotate_key", { key: keys.ownerKey });
    const commits = world.seen.commits.length;

    // Another session holding the old key, and this session presenting another key or none, are refused.
    const other = await session(world);
    expect((await call(other.client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
    expect((await call(client, "recover_key", { key: keys.handleKey })).body.error).toBe("nothing_to_recover");
    expect((await call(client, "recover_key", {})).body.error).toBe("nothing_to_recover");
    expect(world.seen.commits.length).toBe(commits);

    // The call's own session and key still recover it.
    const recovered = await call(client, "recover_key", { key: keys.ownerKey });
    expect(recovered.isError).toBe(false);
    expect(await works(world, recovered.body.key as string)).toBe(true);
  });

  it("leaves a delivered key unrecoverable", async () => {
    const world = await start();
    const { client } = await session(world);
    const keys = await owner(client);
    const commits = world.seen.commits.length;
    expect((await call(client, "recover_key", {})).body.error).toBe("nothing_to_recover");
    expect((await call(client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
    expect(world.seen.commits.length).toBe(commits);
    expect(await works(world, keys.ownerKey)).toBe(true);
    expect(await works(world, keys.handleKey)).toBe(true);
  });

  it("clears a pending recovery once a later key-issuing reply in the session is delivered", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    await dropDuringCommit(world, sessionId, "reissue_handle_key", { key: keys.ownerKey, handle: "scout" });
    expect((await call(client, "create_handle", { key: keys.ownerKey, handle: "third" })).isError).toBe(false);
    expect((await call(client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
  });

  it("refuses, and clears, a recovery whose undelivered key was replaced since", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    await dropDuringCommit(world, sessionId, "reissue_handle_key", { key: keys.ownerKey, handle: "scout" });
    // The owner replaces the handle key again from another session; that delivered reply is not this session's.
    const other = await session(world);
    const replaced = await call(other.client, "reissue_handle_key", { key: keys.ownerKey, handle: "scout" });
    expect(replaced.isError).toBe(false);
    const commits = world.seen.commits.length;
    expect((await call(client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
    expect((await call(client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
    expect(world.seen.commits.length).toBe(commits);
    expect(await works(world, replaced.body.key as string)).toBe(true);
  });

  it("recovers again when recover_key's own reply is lost", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    await dropDuringCommit(world, sessionId, "claim_username", { name: "newcomer" });
    const first = world.issued.at(-1)!;
    await dropDuringCommit(world, sessionId, "recover_key", {});
    const second = world.issued.at(-1)!;
    expect(await works(world, first)).toBe(false);
    const recovered = await call(client, "recover_key", {});
    expect(recovered.isError).toBe(false);
    const fresh = recovered.body.key as string;
    expect(await works(world, second)).toBe(false);
    expect(await works(world, fresh)).toBe(true);
    expect(await world.identities.resolveKey(fresh)).toMatchObject({ ok: true, value: { displayName: "newcomer" } });
  });

  it("lets a delivered reply that overlaps recover_key clear the pending recovery before recover_key reads it", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    await dropDuringCommit(world, sessionId, "claim_username", { name: "newcomer" });
    const commits = world.seen.commits.length;

    // create_handle reaches its commit and pauses there; recover_key arrives meanwhile.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    world.seen.onCommit = () => gate;
    const created = call(client, "create_handle", { key: keys.ownerKey, handle: "third" });
    await vi.waitFor(() => expect(world.seen.onCommit).toBeUndefined());
    const recovered = call(client, "recover_key", {});
    await settle();
    // recover_key waits for the session's key-issuing turn: nothing else has committed.
    expect(world.seen.commits.length).toBe(commits);
    open();
    expect((await created).isError).toBe(false);
    expect((await recovered).body.error).toBe("nothing_to_recover");
    expect(world.seen.commits.length).toBe(commits + 1);
  });

  it("decides a dropped call's key before a later overlapping call commits, so a delivered reply always wins", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    const commits = world.seen.commits.length;

    // rotate_key pauses in its commit; create_handle is sent meanwhile; then rotate_key's client drops.
    const abort = new AbortController();
    const cut = world.http.cut;
    let created: Promise<{ isError: boolean }> | undefined;
    world.seen.onCommit = async () => {
      created = call(client, "create_handle", { key: keys.ownerKey, handle: "third" });
      await settle();
      // The later call waits for the session's key-issuing turn instead of committing alongside.
      expect(world.seen.commits.length).toBe(commits);
      abort.abort();
      await vi.waitFor(() => expect(world.http.cut).toBe(cut + 1));
    };
    expect(await rawCall(world, sessionId, "rotate_key", { key: keys.handleKey }, abort.signal)).toBe("dropped");
    await vi.waitFor(() => expect(created).toBeDefined());
    expect((await created!).isError).toBe(false);
    expect(world.seen.commits.length).toBe(commits + 2);
    // The rotation's key was lost first, then the later reply was delivered: nothing is left to recover.
    expect((await call(client, "recover_key", { key: keys.handleKey })).body.error).toBe("nothing_to_recover");
  });

  it("keeps a call whose commit completes late from recording its key as lost after a later reply was delivered", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    const commits = world.seen.commits.length;

    // rotate_key's client drops while its commit is paused; create_handle is sent only after that response closed.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const abort = new AbortController();
    const cut = world.http.cut;
    let dropped = false;
    world.seen.onCommit = async () => {
      abort.abort();
      await vi.waitFor(() => expect(world.http.cut).toBe(cut + 1));
      dropped = true;
      await gate;
    };
    const rotated = rawCall(world, sessionId, "rotate_key", { key: keys.handleKey }, abort.signal);
    await vi.waitFor(() => expect(dropped).toBe(true));
    let delivered = false;
    const created = call(client, "create_handle", { key: keys.ownerKey, handle: "third" }).then((reply) => {
      delivered = true;
      return reply;
    });
    await settle();
    // The later call cannot commit or be delivered while the dropped call's commit is still in flight.
    expect(delivered).toBe(false);
    expect(world.seen.commits.length).toBe(commits);

    // The rotation's commit completes late; only then does create_handle run, and its delivered reply wins.
    open();
    expect(await rotated).toBe("dropped");
    expect((await created).isError).toBe(false);
    expect(world.seen.commits.length).toBe(commits + 2);
    expect((await call(client, "recover_key", { key: keys.handleKey })).body.error).toBe("nothing_to_recover");
  });

  it("clears a pending recovery when its session ends", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    await dropDuringCommit(world, sessionId, "rotate_key", { key: keys.ownerKey });
    const commits = world.seen.commits.length;

    const ended = await fetch(world.url, { method: "DELETE", headers: { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" } });
    expect(ended.ok).toBe(true);
    // The ended session takes no further calls, and a new session presenting the same key has nothing to recover.
    const stale = await fetch(world.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 902, method: "tools/call", params: { name: "recover_key", arguments: { key: keys.ownerKey } } }),
    });
    expect(stale.status).toBe(404);
    await stale.text();
    const next = await session(world);
    expect((await call(next.client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
    expect(world.seen.commits.length).toBe(commits);
  });

  it("records nothing when a dropped claim for a released account keeps its existing, already delivered key", async () => {
    const world = await start();
    const { client, sessionId } = await session(world);
    const keys = await owner(client);
    const ownerId = (await world.identities.findByDisplayName("owner"))!.id;
    await world.identities.recordMatchJoin(ownerId, Date.now());
    world.clock.offsetMs = INACTIVE_USERNAME_MS + 1;
    expect(await world.identities.findByDisplayName("owner")).toBeUndefined();
    // Record the key's use now, so the only commit the dropped claim makes is the claim itself.
    expect((await world.identities.resolveKey(keys.ownerKey)).ok).toBe(true);

    await dropDuringCommit(world, sessionId, "claim_username", { name: "renamed", key: keys.ownerKey });
    // The claim kept the account's key; it was not issued by this call, so it is not recoverable and stays working.
    expect(world.issued.at(-1) === keys.ownerKey).toBe(true);
    expect((await call(client, "recover_key", { key: keys.ownerKey })).body.error).toBe("nothing_to_recover");
    expect((await call(client, "recover_key", {})).body.error).toBe("nothing_to_recover");
    expect(await world.identities.resolveKey(keys.ownerKey)).toMatchObject({ ok: true, value: { id: ownerId, displayName: "renamed" } });
  });
});
