import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG, type Agent } from "../server/helpers.ts";
import { playable } from "../playable.ts";

// A colony chosen in join_lobby is the colony played on the slot server.
// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const LONG = playable(shortConfig(60_000, { queenFounding: PUBLIC_CONFIG.queenFounding }));

const servers: GameServer[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

async function until<T>(check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

describe.skipIf(!host)("colony choice on the slot server against the Firestore emulator", { timeout: 90_000 }, () => {
  it("plays each handle in the colony it chose in join_lobby, over MCP and HTTP, including against the balancing rule", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = createFirestore({ projectId, namespace: `colony-${process.pid}-${Date.now().toString(36)}`, emulatorHost: host });
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { countdownMs: 300 });
    const accounts: AccountStores = { identities, lobbies, ratings: createRatings(store) };
    const root = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), mcpConfig: TEST_MCP_CONFIG, accounts });
    servers.push(root);
    const slotServer = await startServer({
      port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: LONG, startPickWindowMs: 100,
      slot: { slot: "public-0", publicUrl: "http://colony.test", lobbies, identities, pollMs: 50 },
    });
    servers.push(slotServer);

    const claim = async (name: string) => {
      const claimed = await identities.claimUsername(name);
      if (!claimed.ok) throw new Error(claimed.reason);
      return claimed.value;
    };
    const kay = await claim("Kite");
    const scout = await identities.createHandle(kay.key, "scout");
    const guard = await identities.createHandle(kay.key, "guard");
    if (!scout.ok || !guard.ok) throw new Error("handle creation failed");
    const [bob, cat] = [await claim("Bob"), await claim("Cat")];

    const viaMcp = await connect(root.port);
    agents.push(viaMcp);
    const joinLobby = async (transport: "MCP" | "HTTP", args: Record<string, unknown>): Promise<Lobby> => {
      if (transport === "MCP") {
        const reply = await viaMcp.call("join_lobby", args);
        expect(reply.isError, reply.text).toBe(false);
        return (reply.data as { lobby: Lobby }).lobby;
      }
      const res = await fetch(`http://127.0.0.1:${root.port}/api/join_lobby`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
      });
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body.lobby as Lobby;
    };

    const created = await lobbies.createLobby(kay.key, "public", 2);
    if (!created.ok) throw new Error(created.reason);
    const lobbyId = created.value.lobby.id;
    // Without a choice the first two joins would sit in colony 0 then colony 1, and the
    // third in colony 0; each chosen colony differs from that.
    const seated = [
      { key: scout.value.key, id: scout.value.identity.id, colony: 1, transport: "MCP" },
      { key: bob.key, id: bob.identity.id, colony: 1, transport: "HTTP" },
      { key: guard.value.key, id: guard.value.identity.id, colony: 0, transport: "HTTP" },
      { key: cat.key, id: cat.identity.id, colony: 0, transport: "MCP" },
    ] as const;
    let lobby: Lobby | undefined;
    for (const seat of seated) lobby = await joinLobby(seat.transport, { key: seat.key, lobbyId, colony: seat.colony });
    expect(lobby).toMatchObject({ state: "holding", slot: "public-0" });
    expect(lobby!.colonies.map((colony) => colony.map((seat) => seat.id))).toEqual([
      [guard.value.identity.id, cat.identity.id],
      [scout.value.identity.id, bob.identity.id],
    ]);

    await until(() => slotServer.game.match !== null && slotServer.game.match.result === null);
    for (const seat of seated) {
      const agent = await connect(slotServer.port);
      agents.push(agent);
      const joined = await agent.call("join", { key: seat.key });
      expect(joined.isError, joined.text).toBe(false);
      const data = joined.data as { agentId: string; colony: string };
      // A player-created lobby is unrated: its match plays under the names it draws from the lobby id.
      expect(data.colony).toBe(drawColonyNames(lobbyId)[seat.colony]);
      expect(slotServer.game.match!.state.agents.find((played) => played.id === data.agentId)?.colony).toBe(seat.colony);
    }
  });
});
