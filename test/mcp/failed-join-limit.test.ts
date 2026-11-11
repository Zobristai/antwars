import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Game, type LobbySeat } from "../../src/mcp/game.js";
import { KEY_RECHECK_MS, registerTools } from "../../src/mcp/tools.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { keyVerifier } from "../../src/identity/identities.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

// A slot session whose joins keep being refused because its key holds no usable seat here stops reaching
// the identity store: past the limit its joins are refused before the key is looked up. A new session,
// or a successful join, starts a fresh count.

const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});

const LIMIT = DEFAULT_MCP_CONFIG.maxFailedJoinsPerSession;

/** Ann holds both of her colony's seats; Bob holds one. */
const SEATS: LobbySeat[] = [
  { identityId: "ann", displayName: "Ann", colony: 0, seat: 1 },
  { identityId: "ann", displayName: "Ann", colony: 0, seat: 2 },
  { identityId: "bob", displayName: "Bob", colony: 1 },
];

function setup(mcpConfig = TEST_MCP_CONFIG) {
  const clock = { now: 0 };
  const keys = new Map<string, string>([["ann-key", "ann"], ["bob-key", "bob"], ["cat-key", "cat"]]);
  const assigned = new Map<string, string>();
  /** Every identity-store read: key lookups and key re-checks. */
  const store = { lookups: 0, rechecks: 0 };
  const keyReads = { held: false, waiting: [] as (() => void)[], release() { this.held = false; for (const done of this.waiting.splice(0)) done(); } };
  const game = new Game({ simConfig: playable(PUBLIC_CONFIG), mcpConfig, now: () => clock.now,
    slot: {
      async identityOf(key) {
        store.lookups += 1;
        const identityId = keys.get(key);
        if (keyReads.held) await new Promise<void>(resolve => keyReads.waiting.push(resolve));
        return identityId;
      },
      async holderOfVerifier(verifier) {
        store.rechecks += 1;
        return [...keys].find(([key]) => keyVerifier(key) === verifier)?.[1];
      },
      assignedLobby: async identityId => assigned.get(identityId),
      locate: async () => undefined,
      recordJoin: () => Promise.resolve(),
    } });
  game.seatLobby("limit-lobby", SEATS);
  const rotate = (from: string, to: string) => {
    const identityId = keys.get(from)!;
    keys.delete(from);
    keys.set(to, identityId);
  };
  return { game, clock, store, keyReads, assigned, rotate };
}

async function connect(game: Game) {
  const server = new McpServer({ name: "failed-join-limit", version: "1" }); servers.push(server);
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "failed-join-limit", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, data: result.structuredContent as any };
  };
}

type Call = Awaited<ReturnType<typeof connect>>;

async function failJoins(call: Call, count: number, args: Record<string, unknown>, code: string): Promise<void> {
  for (let i = 0; i < count; i++) expect((await call("join", args)).data.error.code).toBe(code);
}

describe("a slot session's failed joins are bounded", () => {
  it("defaults to 8, enough for a 4-seat team agent to mistype each seat once", () => {
    expect(LIMIT).toBe(8);
  });

  it.each([
    { refusal: "not_seated", args: { key: "no-such-key" } },
    { refusal: "not_seated", args: { key: "cat-key" } },
    { refusal: "seat_required", args: { key: "ann-key" } },
    { refusal: "no_such_seat", args: { key: "ann-key", seat: 3 } },
    { refusal: "no_such_seat", args: { key: "bob-key", seat: 2 } },
  ])("refuses joins without a store read after $refusal $args.key", async ({ refusal, args }) => {
    const { game, store } = setup();
    const session = await connect(game);
    await failJoins(session, LIMIT, args, refusal);
    expect(store.lookups).toBe(LIMIT);

    // Past the limit, even a seated key is refused here, and the store is not read.
    const refused = await session("join", { key: "bob-key" });
    expect(refused.data.error.code).toBe("too_many_failed_joins");
    expect(refused.data.error.howToFix).toContain("key and seat");
    expect(refused.data.error.howToFix).toContain("new MCP session");
    expect(store.lookups).toBe(LIMIT);
    expect(store.rechecks).toBe(0);

    // A new session starts a fresh count, and the seated key joins from it.
    const fresh = await connect(game);
    expect((await fresh("join", { key: "bob-key" })).error).toBe(false);
  });

  it("starts the count again after a successful join", async () => {
    const { game, store } = setup();
    const session = await connect(game);
    await failJoins(session, LIMIT - 1, { key: "no-such-key" }, "not_seated");
    expect((await session("join", { key: "bob-key" })).error).toBe(false);
    await failJoins(session, LIMIT, { key: "no-such-key" }, "not_seated");
    const lookups = store.lookups;
    expect((await session("join", { key: "bob-key" })).data.error.code).toBe("too_many_failed_joins");
    expect(store.lookups).toBe(lookups);
  });

  it("does not count refusals that never reach the store, or a lobby still loading", async () => {
    const { game, store, assigned } = setup();
    const session = await connect(game);
    for (let i = 0; i < LIMIT; i++) {
      expect((await session("join", {})).data.error.code).toBe("key_required");
      expect((await session("join", { key: "bob-key", reconnectToken: "t" })).data.error.code).toBe("bad_arguments");
      expect((await session("join", { key: "bob-key", modelLabel: "" })).data.error.code).toBe("bad_model_label");
    }
    expect(store.lookups).toBe(0);
    assigned.set("cat", "next-lobby");
    await failJoins(session, LIMIT, { key: "cat-key" }, "lobby_loading");
    expect((await session("join", { key: "bob-key" })).error).toBe(false);
  });

  it("counts joins in flight, so concurrent joins cannot pass the limit together", async () => {
    const { game, store, keyReads } = setup();
    const session = await connect(game);
    keyReads.held = true;
    const pending = Array.from({ length: LIMIT }, () => session("join", { key: "no-such-key" }));
    while (keyReads.waiting.length < LIMIT) await new Promise(resolve => setImmediate(resolve));
    expect((await session("join", { key: "bob-key" })).data.error.code).toBe("too_many_failed_joins");
    expect(store.lookups).toBe(LIMIT);
    keyReads.release();
    for (const reply of await Promise.all(pending)) expect(reply.data.error.code).toBe("not_seated");
    expect((await session("join", { key: "bob-key" })).data.error.code).toBe("too_many_failed_joins");
    expect(store.lookups).toBe(LIMIT);
  });

  it("counts a join refused key_revoked, and still joins by the current key after it", async () => {
    const { game, clock, store, keyReads, rotate } = setup();
    const session = await connect(game);
    await failJoins(session, LIMIT - 2, { key: "no-such-key" }, "not_seated");

    // The join's key is read, then replaced before the join completes.
    keyReads.held = true;
    const pending = session("join", { key: "bob-key" });
    while (keyReads.waiting.length === 0) await new Promise(resolve => setImmediate(resolve));
    rotate("bob-key", "bob-new-key");
    clock.now += KEY_RECHECK_MS;
    keyReads.release();
    expect((await pending).data.error.code).toBe("key_revoked");

    // One place is left: the current key joins with it and starts the count again.
    expect((await session("join", { key: "bob-new-key" })).error).toBe(false);
    await failJoins(session, LIMIT, { key: "no-such-key" }, "not_seated");
    const lookups = store.lookups;
    expect((await session("join", { key: "bob-new-key" })).data.error.code).toBe("too_many_failed_joins");
    expect(store.lookups).toBe(lookups);
  });

  it("refuses at the limit after the key_revoked join that reaches it", async () => {
    const { game, clock, keyReads, rotate } = setup();
    const session = await connect(game);
    await failJoins(session, LIMIT - 1, { key: "no-such-key" }, "not_seated");
    keyReads.held = true;
    const pending = session("join", { key: "bob-key" });
    while (keyReads.waiting.length === 0) await new Promise(resolve => setImmediate(resolve));
    rotate("bob-key", "bob-new-key");
    clock.now += KEY_RECHECK_MS;
    keyReads.release();
    expect((await pending).data.error.code).toBe("key_revoked");
    expect((await session("join", { key: "bob-new-key" })).data.error.code).toBe("too_many_failed_joins");
    expect((await (await connect(game))("join", { key: "bob-new-key" })).error).toBe(false);
  });

  it("refuses a joined session's join at the limit without re-checking its key, past KEY_RECHECK_MS", async () => {
    const { game, clock, store } = setup();
    const session = await connect(game);
    expect((await session("join", { key: "bob-key" })).error).toBe(false);
    await failJoins(session, LIMIT, { key: "no-such-key" }, "not_seated");
    // The joining key is now due its re-check, which a join at the limit must not make.
    clock.now += KEY_RECHECK_MS;
    const { lookups, rechecks } = store;
    for (let i = 0; i < 3; i++) expect((await session("join", { key: "bob-key" })).data.error.code).toBe("too_many_failed_joins");
    expect(store.lookups).toBe(lookups);
    expect(store.rechecks).toBe(rechecks);
    // Other calls still re-check the key as before.
    expect((await session("observe")).error).toBe(false);
    expect(store.rechecks).toBe(rechecks + 1);
  });

  it("answers a joined session's joins at the limit too_many_failed_joins under the default rate limit, never call_rate", async () => {
    const { game, clock, store } = setup({ ...DEFAULT_MCP_CONFIG, houseIdleSeconds: 86_400 });
    const session = await connect(game);
    expect((await session("join", { key: "bob-key" })).error).toBe(false);
    for (let i = 0; i < LIMIT; i++) {
      // One second apart, so each failed join's own reply stays under the rate limit.
      clock.now += 1000;
      expect((await session("join", { key: "no-such-key" })).data.error.code).toBe("not_seated");
    }
    clock.now += 1000;
    const lookups = store.lookups;
    for (let i = 0; i < 2 * DEFAULT_MCP_CONFIG.callsPerSecond + 1; i++) {
      const refused = await session("join", { key: "bob-key" });
      expect(refused.data.error.code).toBe("too_many_failed_joins");
      expect(refused.data.retryAfterMs).toBeUndefined();
    }
    expect(store.lookups).toBe(lookups);
    // The rate limit is live for this seat: a burst of observes is refused call_rate.
    const codes: unknown[] = [];
    for (let i = 0; i <= DEFAULT_MCP_CONFIG.callsPerSecond; i++) codes.push((await session("observe")).data.error?.code);
    expect(codes).toContain("call_rate");
  });
});
