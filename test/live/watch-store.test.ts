import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { createPrivateArchive } from "../../src/replays/private-archive.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { tempDir } from "../server/helpers.ts";
import { playable } from "../playable.ts";
import { ManualClock } from "./helpers.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { admitMatchWatch } from "../../src/live/match-access.ts";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulatorHost)("spectator shared Firestore store", () => {
  it("keeps original origins/deltas across independent clients, slot reuse and invite revocation", async () => {
    const namespace = `watch-${process.pid}-${Date.now().toString(36)}`;
    const client = () => {
      const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
      const identities = createIdentities(store);
      return { store, identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    };
    const one = client(), two = client();
    async function key(name: string) {
      const result = await one.identities.claimUsername(name);
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    }
    const alice = await key("alice"), bob = await key("bob");
    async function filled(kind: "public" | "private") {
      const created = await one.lobbies.createLobby(alice.key, kind, 1);
      if (!created.ok) throw new Error(created.reason);
      const { lobby, inviteToken } = created.value;
      for (const seat of [alice, bob]) {
        const joined = await one.lobbies.join(lobby.id, seat.key, inviteToken);
        if (!joined.ok) throw new Error(joined.reason);
      }
      return { id: lobby.id, inviteToken };
    }
    const publicLobby = await filled("public");
    // Player-created lobbies are unrated; mark this one rated, standing in for a queue-made match.
    await one.store.transaction(async () => ({
      result: undefined, writes: [{ op: "update", path: `lobbies/${publicLobby.id}`, fields: { rated: "true" } }],
    }));
    const instance ={ runId: "run-one", mcpUrl: "http://127.0.0.1:9001/mcp", spectatorUrl: "http://127.0.0.1:9001/" };
    await one.lobbies.registerInstance("public-0", instance);
    expect((await one.lobbies.beginMatch(publicLobby.id, "public-0", instance.runId)).ok).toBe(true);
    await one.watch.register({ lobbyId: publicLobby.id, visibility: "public", rated: true, startedAt: 1000,
      origin: "http://127.0.0.1:9001", slot: "public-0", runId: instance.runId });
    expect((await two.watch.publicMatches()).map(match => match.lobbyId)).toEqual([publicLobby.id]);
    expect((await one.lobbies.endMatch(publicLobby.id, instance.runId, "colony_0_won")).ok).toBe(true);
    const changes = await two.ratings.readMatchChanges(publicLobby.id);
    expect(changes).toHaveLength(2);
    expect(changes?.map(change => change.after - change.before).sort((a, b) => a - b)).toEqual([FIRST_LOSS.rating - 1500, FIRST_WIN.rating - 1500]);
    expect((await two.lobbies.locate(publicLobby.id))).toMatchObject({ ok: true, value: { slot: null } });
    // The completed sim no longer owns its slot, but its delayed feed remains discoverable.
    expect((await two.watch.read(publicLobby.id))?.origin).toBe("http://127.0.0.1:9001");
    const successor = await filled("public");
    await two.watch.register({ lobbyId: successor.id, visibility: "public", rated: true, startedAt: 2000,
      origin: "http://127.0.0.1:9001", slot: "public-0", runId: instance.runId });
    expect((await one.watch.publicMatches()).map(match => match.lobbyId)).toEqual([publicLobby.id, successor.id]);
    expect(await one.watch.playbackFinished(publicLobby.id, instance.runId)).toBe(true);
    expect(await one.watch.replaySaved(publicLobby.id, instance.runId, "2026-10-20T10-00-00-000Z-1")).toBe(true);
    expect((await two.watch.publicMatches()).map(match => match.lobbyId)).toEqual([successor.id]);
    expect(await two.ratings.readMatchChanges(publicLobby.id)).toEqual(changes);

    const privateLobby = await filled("private");
    const access = { lobbyId: privateLobby.id, visibility: "private" as const, rated: true };
    await one.watch.register({ ...access, startedAt: 3000, origin: "http://127.0.0.1:9002", slot: "private-0", runId: "run-private" });
    expect((await two.watch.publicMatches()).map(match => match.lobbyId)).not.toContain(privateLobby.id);
    const check = (token: string | undefined) => admitMatchWatch(access, token, two.lobbies.isInviteCurrent);
    expect(await check(privateLobby.inviteToken)).toBe("allowed");
    expect((await one.lobbies.revokeInvite(privateLobby.id, alice.key)).ok).toBe(true);
    expect(await check(privateLobby.inviteToken)).toBe("refused");
    const renewed = await one.lobbies.issueInvite(privateLobby.id, alice.key);
    if (!renewed.ok) throw new Error(renewed.reason);
    expect(await check(renewed.value.inviteToken)).toBe("allowed");
  }, 90_000);

  it("wires two real slot HTTP servers to the shared store and private archive without live agent joins", async () => {
    const namespace = `watch-http-${process.pid}-${Date.now().toString(36)}`;
    const client = () => {
      const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
      const identities = createIdentities(store);
      return { identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    };
    const a = client(), b = client();
    const blobs = new Map<string, Uint8Array>();
    const replayStore = { create: async (object: import("../../src/replays/store.ts").ReplayObject) => { blobs.set(object.name, object.body); } };
    const replaySource = { open: async (id: string) => blobs.has(`${id}.bin`) ? { body: Readable.from([blobs.get(`${id}.bin`)!]) } : null };
    const archive = createPrivateArchive(replayStore, async name => blobs.has(name) ? { body: Readable.from([blobs.get(name)!]) } : null, new Uint8Array(32).fill(9));
    const servers: SpectatedServer[] = [], directories: string[] = [], abort = new AbortController();
    const publicClock = new ManualClock(), privateClock = new ManualClock();
    async function listen(accounts: ReturnType<typeof client>, slot: string, clock: ManualClock) {
      const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`, dataDir = tempDir(); directories.push(dataDir);
      const server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, simConfig: playable({ ...rulesConfig("redesign"), matchTicks: 2 }),
        accounts, watchRegistry: accounts.watch, privateArchive: archive, replayStore, replaySource, spectatorClock: clock, startPickWindowMs: 100,
        slot: { slot, publicUrl: origin, lobbies: accounts.lobbies, identities: accounts.identities, pollMs: 25 } });
      servers.push(server); return { server, origin };
    }
    try {
      const first = await listen(a, "public-0", publicClock), second = await listen(b, "private-0", privateClock);
      const alice = await a.identities.claimUsername("alice"), bob = await a.identities.claimUsername("bob");
      if (!alice.ok || !bob.ok) throw new Error("identity fixture failed");
      async function fill(kind: "public" | "private") {
        if (!alice.ok || !bob.ok) throw new Error("identity fixture failed");
        const created = await a.lobbies.createLobby(alice.value.key, kind, 1);
        if (!created.ok) throw new Error(created.reason);
        for (const seat of [alice.value, bob.value]) {
          const joined = await a.lobbies.join(created.value.lobby.id, seat.key, created.value.inviteToken);
          if (!joined.ok) throw new Error(joined.reason);
        }
        return created.value;
      }
      const pub = await fill("public"), priv = await fill("private");
      // Both real slot servers finalize the explicitly shortened test window before publishing.
      // The transport checks still start only after finalization.
      await vi.waitFor(() => {
        expect(first.server.hub.hasLobby(pub.lobby.id)).toBe(true);
        expect(second.server.hub.hasLobby(priv.lobby.id)).toBe(true);
      }, { timeout: 20_000 });
      const get = (origin: string, path: string, token?: string) => fetch(origin + path, { signal: abort.signal, headers: token ? { "x-antwar-invite": token } : {} });
      await vi.waitFor(async () => {
        const catalog = await (await get(second.origin, "/watch/catalog")).json();
        expect(catalog.matches.map((row: { lobbyId: string }) => row.lobbyId)).toEqual([pub.lobby.id]);
      }, { timeout: 10_000 });
      expect((await get(first.origin, `/watch/live/${priv.lobby.id}`)).status).toBe(404);
      const privateLive = await get(first.origin, `/watch/live/${priv.lobby.id}`, priv.inviteToken);
      expect(privateLive.status).toBe(200);
      const reader = privateLive.body!.getReader();
      const firstData = (async () => {
        let text = "";
        while (!text.includes("data:")) { const chunk = await reader.read(); if (chunk.done) throw new Error("early stream end"); text += new TextDecoder().decode(chunk.value); }
        return text;
      })();
      await vi.waitFor(async () => expect((await a.lobbies.readLobby(priv.lobby.id))).toMatchObject({ ok: true, value: { state: "ended" } }), { timeout: 20_000 });
      expect(second.server.hub.watchStatus(priv.lobby.id)?.playbackFinished).toBe(false);
      publicClock.advance(301000); privateClock.advance(301000);
      expect(await firstData).toContain("data:");
      await reader.cancel();
      await vi.waitFor(async () => expect((await a.watch.read(priv.lobby.id))?.replayId).toBeTruthy(), { timeout: 20_000 });
      const replayId = (await a.watch.read(priv.lobby.id))!.replayId!;
      const recordingPath = `/watch/replays/${priv.lobby.id}/${replayId}`;
      expect((await get(first.origin, recordingPath)).status).toBe(404);
      const recording = await get(first.origin, recordingPath, priv.inviteToken);
      expect(recording.status).toBe(200); expect(recording.headers.get("cache-control")).toBe("no-store");
      expect((await recording.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await get(first.origin, `/replays/${replayId}`)).status).toBe(404);
      expect(blobs.has(`${replayId}.bin`)).toBe(false); expect(blobs.has(`${replayId}.json`)).toBe(false);
      await a.lobbies.revokeInvite(priv.lobby.id, alice.value.key);
      expect((await get(first.origin, recordingPath, priv.inviteToken)).status).toBe(404);
    } finally {
      abort.abort();
      for (const server of servers.reverse()) await server.close();
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

});
