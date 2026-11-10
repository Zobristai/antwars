import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { KEY_RECHECK_MS, registerTools } from "../../src/mcp/tools.js";
import { keyVerifier } from "../../src/identity/identities.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

// A slot session joined by key plays its seat only while that key is current: rotating or
// reissuing the key ends the sessions it admitted, with or without the owner rejoining.

const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});

const SEATS = [
  { identityId: "ann", displayName: "Ann", colony: 0 as const },
  { identityId: "bob", displayName: "Bob", colony: 1 as const },
];
/** A legal colony-0 nest tile on seed 7001's board (as the nest tool tests use). */
const ANN_TILE = { tileX: 8, tileY: 24 };

/** The store's view of keys: each current key and the identity it holds; rotate replaces one. */
function setup() {
  const clock = { now: 0 };
  const keys = new Map<string, string>([["ann-first", "ann"], ["bob-first", "bob"]]);
  const store = { failing: false, reads: 0 };
  const game = new Game({ simConfig: playable(PUBLIC_CONFIG), mcpConfig: TEST_MCP_CONFIG, now: () => clock.now,
    slot: {
      identityOf: async key => keys.get(key),
      async holderOfVerifier(verifier) {
        store.reads += 1;
        if (store.failing) throw new Error("store unavailable");
        return [...keys].find(([key]) => keyVerifier(key) === verifier)?.[1];
      },
      locate: async () => undefined,
    } });
  game.seatLobby("rotation-lobby", SEATS);
  game.beginLobbyStart(7001);
  const rotate = (from: string, to: string) => {
    const identityId = keys.get(from)!;
    keys.delete(from);
    keys.set(to, identityId);
  };
  return { game, clock, store, rotate };
}

async function connect(game: Game) {
  const server = new McpServer({ name: "key-rotation", version: "1" }); servers.push(server);
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "key-rotation", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  /** A call, ticking the match whenever it waits on one, until it answers. */
  return async (name: string, args: Record<string, unknown> = {}) => {
    let answered = false;
    const reply = client.callTool({ name, arguments: args }).finally(() => { answered = true; });
    while (!answered) {
      if (game.match !== null && game.pendingInputs > 0) game.tick();
      await new Promise(resolve => setImmediate(resolve));
    }
    const result = await reply;
    return { error: result.isError === true, data: result.structuredContent as any };
  };
}

type Call = Awaited<ReturnType<typeof connect>>;

/** The seat action of each phase: a nest pick while the window is open, an order once the match runs. */
const ACTIONS = {
  pick_nest: (call: Call) => call("pick_nest", ANN_TILE),
  order: (call: Call) => call("order", { kind: "hold" }),
} as const;

/** Close the 120-second nest window on the wall clock, then run the match's first tick. */
async function startMatch(game: Game, clock: { now: number }) {
  clock.now = Math.max(clock.now, 120_000);
  game.finishLobbyStart();
  game.tick();
}

describe("rotating a key ends the sessions that key admitted", () => {
  it.each([
    { action: "pick_nest" as const, rejoin: false },
    { action: "pick_nest" as const, rejoin: true },
    { action: "order" as const, rejoin: false },
    { action: "order" as const, rejoin: true },
  ])("refuses $action from the old key's session after rotation (owner rejoin: $rejoin)", async ({ action, rejoin }) => {
    const { game, clock, rotate } = setup();
    const old = await connect(game);
    expect((await old("join", { key: "ann-first" })).error).toBe(false);
    if (action === "order") await startMatch(game, clock);
    expect((await ACTIONS[action](old)).error).toBe(false);

    rotate("ann-first", "ann-second");
    const owner = rejoin ? await connect(game) : undefined;
    if (owner !== undefined) expect((await owner("join", { key: "ann-second" })).error).toBe(false);
    // The old session plays on only until its key is next checked, at most KEY_RECHECK_MS later; in the nest
    // window no tick runs, so this is wall-clock time alone.
    clock.now += KEY_RECHECK_MS;
    const refused = await ACTIONS[action](old);
    expect(refused.error).toBe(true);
    expect(refused.data.error.code).toBe("key_revoked");
    expect(refused.data.error.howToFix).toContain("current key");
    // The session no longer plays the seat, and the old key cannot join it again.
    expect((await old("observe")).data.error.code).toBe("not_joined");
    expect((await ACTIONS[action](old)).error).toBe(true);
    expect((await old("join", { key: "ann-first" })).data.error.code).toBe("not_seated");

    // The current key plays the seat: from the owner's new session, or by rejoining in this one.
    const current = owner ?? old;
    if (owner === undefined) expect((await old("join", { key: "ann-second" })).error).toBe(false);
    clock.now += KEY_RECHECK_MS;
    expect((await current("observe")).error).toBe(false);
    if (action === "pick_nest") expect((await ACTIONS[action](current)).data.accepted).toBe(true);
  });

  it("ends the old key's session on a rotation during the nest pick, with no tick run", async () => {
    const { game, clock, rotate } = setup();
    const old = await connect(game);
    await old("join", { key: "ann-first" });
    expect((await old("pick_nest", ANN_TILE)).data.accepted).toBe(true);
    rotate("ann-first", "ann-second");
    clock.now += KEY_RECHECK_MS - 1;
    // Within the bound, the last check still stands.
    expect((await old("pick_nest", ANN_TILE)).data.accepted).toBe(true);
    clock.now += 1;
    expect(game.match).toBeNull();
    expect((await old("pick_nest", ANN_TILE)).data.error.code).toBe("key_revoked");
  });

  it("leaves a session joined by the current key playing, reading its key at most once per interval", async () => {
    const { game, clock, store } = setup();
    const ann = await connect(game), bob = await connect(game);
    await ann("join", { key: "ann-first" });
    await bob("join", { key: "bob-first" });
    for (let i = 0; i < 3; i++) {
      expect((await ann("pick_nest", ANN_TILE)).data.accepted).toBe(true);
      expect((await ann("observe")).error).toBe(false);
      clock.now += KEY_RECHECK_MS;
    }
    // Ann's key is read once per interval however many calls she makes; idle Bob's only when he next calls.
    expect(store.reads).toBe(2);
    await startMatch(game, clock);
    expect((await ann("order", { kind: "hold" })).error).toBe(false);
    expect((await bob("order", { kind: "hold" })).error).toBe(false);
    expect(store.reads).toBe(4);
  });

  it("keeps the seat when the key cannot be read, and checks again on the next call", async () => {
    const { game, clock, store, rotate } = setup();
    const ann = await connect(game);
    await ann("join", { key: "ann-first" });
    clock.now += KEY_RECHECK_MS;
    store.failing = true;
    expect((await ann("pick_nest", ANN_TILE)).data.accepted).toBe(true);
    store.failing = false;
    rotate("ann-first", "ann-second");
    expect((await ann("pick_nest", ANN_TILE)).data.error.code).toBe("key_revoked");
    expect(store.reads).toBe(2);
  });
});
