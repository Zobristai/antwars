import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG, type Agent } from "./helpers.ts";
import { playable } from "../playable.ts";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulatorHost)("private seated agents after invite revocation", () => {
  it("keeps existing and freshly authenticated seat-key commands playable while refusing new revoked-invite watches", async () => {
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar",
      namespace: `seat-revocation-${randomUUID()}`, emulatorHost });
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { countdownMs: 0 });
    const ratings = createRatings(store);
    const watchRegistry = createWatchRegistry(store);
    const keys = [];
    for (const name of ["Alice", "Bob"]) {
      const claimed = await identities.claimUsername(name);
      if (!claimed.ok) throw new Error(claimed.reason);
      keys.push(claimed.value.key);
    }
    const created = await lobbies.createLobby(keys[0]!, "private", 1);
    if (!created.ok) throw new Error(created.reason);
    const { lobby, inviteToken } = created.value;
    expect(inviteToken).toBeTruthy();
    for (const key of keys) {
      const seated = await lobbies.join(lobby.id, key, inviteToken);
      expect(seated.ok).toBe(true);
    }

    const dataDir = tempDir();
    let server: SpectatedServer | undefined;
    const agents: Agent[] = [];
    const abort = new AbortController();
    try {
      server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, seed: 7001,
        // Long enough not to end during the assertions; shorten only test pacing,
        // not invite admission or seat authentication. No simulation state is mocked.
        simConfig: playable(shortConfig(60_000, { queenFounding: PUBLIC_CONFIG.queenFounding, commandFloorTicks: 1 })),
        mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100,
        accounts: { identities, lobbies, ratings }, watchRegistry,
        slot: { slot: "private-0", publicUrl: "http://private-slot.test", lobbies, identities, pollMs: 25 } });
      const active = server;
      await vi.waitFor(() => {
        expect(active.game.match).not.toBeNull();
        expect(active.game.match!.result).toBeNull();
        expect(active.hub.hasLobby(lobby.id)).toBe(true);
      }, { timeout: 20_000 });
      const matchSeq = active.game.match!.seq;
      // Game.match is a snapshot getter; read it again after every command/tick.
      const match = () => active.game.match!;
      const openSeat = async (key: string) => {
        const agent = await connect(active.port);
        agents.push(agent);
        const joined = await agent.call("join", { key });
        expect(joined.isError).toBe(false);
        return agent;
      };
      const first = await openSeat(keys[0]!);
      const second = await openSeat(keys[1]!);
      for (const agent of [first, second]) {
        expect((await agent.call("order", { kind: "hold" })).isError).toBe(false);
      }
      expect(match().state.agents.map(agent => agent.colony).sort()).toEqual([0, 1]);
      const seatIds = match().state.agents.map(agent => agent.id).sort();
      expect(match().state.agents.map(agent => agent.order.kind)).toEqual(["hold", "hold"]);

      const watch = () => fetch(`http://127.0.0.1:${active.port}/watch/live/${lobby.id}`, {
        headers: { "x-antwar-invite": inviteToken! }, signal: abort.signal });
      const before = await watch();
      expect(before.status).toBe(200);
      await before.body!.cancel();
      expect(await lobbies.revokeInvite(lobby.id, keys[0]!)).toEqual({ ok: true, value: null });
      expect(await lobbies.isInviteCurrent(lobby.id, inviteToken!)).toBe(false);
      const refused = await watch();
      expect(refused.status).toBe(404);
      await refused.arrayBuffer();
      expect((await lobbies.readLobby(lobby.id))).toMatchObject({ ok: true, value: { state: "holding", slot: "private-0" } });
      const revokedAtTick = match().state.tick;
      // Commands apply at the current tick; let the simulation pass the revocation tick first.
      await vi.waitFor(() => expect(match().state.tick).toBeGreaterThan(revokedAtTick), { timeout: 5_000 });

      // Existing MCP sessions keep issuing actual simulation commands.
      for (const agent of [first, second]) {
        expect((await agent.call("order", { kind: "forage" })).isError).toBe(false);
      }
      expect(match().seq).toBe(matchSeq);
      expect(match().result).toBeNull();
      expect(match().state.tick).toBeGreaterThan(revokedAtTick);
      expect(match().state.agents.map(agent => agent.order.kind)).toEqual(["forage", "forage"]);
      for (const agent of match().state.agents) expect(agent.lastCommandTick).toBeGreaterThan(revokedAtTick);

      // Re-authentication proves the seat keys still work, not only cached sessions.
      for (const agent of agents.splice(0)) await agent.close();
      for (const key of keys) {
        const reconnected = await openSeat(key);
        expect((await reconnected.call("order", { kind: "hold" })).isError).toBe(false);
      }
      expect(match().seq).toBe(matchSeq);
      expect(match().result).toBeNull();
      expect(match().state.agents.map(agent => agent.id).sort()).toEqual(seatIds);
      expect(match().state.agents.map(agent => agent.order.kind)).toEqual(["hold", "hold"]);
    } finally {
      abort.abort();
      try {
        for (const agent of agents) await agent.close();
      } finally {
        try { await server?.close(); }
        finally { rmSync(dataDir, { recursive: true, force: true }); }
      }
    }
  }, 90_000);
});
