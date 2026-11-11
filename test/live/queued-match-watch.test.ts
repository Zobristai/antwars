import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { tempDir } from "../server/helpers.ts";
import { playable } from "../playable.ts";
import { ManualClock } from "./helpers.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { RATED_DELAY_SECONDS } from "../../src/live/match-access.ts";
import type { Game } from "../../src/mcp/game.ts";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulatorHost)("a queue-made match on a real slot server", () => {
  it("is listed by /watch/catalog as a public rated match once it starts, and its watch routes admit a viewer without an invite", async () => {
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace: `queued-watch-${process.pid}-${Date.now().toString(36)}`, emulatorHost });
    const identities = createIdentities(store);
    const accounts = { identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, dataDir = tempDir(), clock = new ManualClock(), abort = new AbortController();
    let server: SpectatedServer | undefined;
    try {
      server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, simConfig: playable({ ...rulesConfig("redesign"), matchTicks: 2 }),
        accounts, watchRegistry: accounts.watch, spectatorClock: clock, startPickWindowMs: 100,
        slot: { slot: "public-0", publicUrl: origin, lobbies: accounts.lobbies, identities, pollMs: 25 } });
      // The match lasts 2 ticks, so on a loaded runner it could end and be rated before the catalog was read, which then
      // showed each player's figures after that match. Its ticks are held until the catalog check has passed, and the
      // catalog is first read later than the whole match lasts, so the check passes only because of that hold.
      const game = server.game as unknown as Game;
      let catalogChecked = false;
      const tick = game.tick.bind(game);
      vi.spyOn(game, "tick").mockImplementation((stopNow) => catalogChecked ? tick(stopNow) : null);
      const [alice, bob] = await Promise.all(["alice", "bob"].map(async name => {
        const claimed = await identities.claimUsername(name);
        if (!claimed.ok) throw new Error(claimed.reason);
        return { id: claimed.value.identity.id, displayName: claimed.value.identity.displayName };
      }));
      // The pairing's transaction, on the store createLobbies was given; no agent joins the match.
      const lobby = await store.transaction<Lobby>(async read => {
        const made = await accounts.lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[alice!], [bob!]] }, Date.now());
        return { result: made.lobby, writes: made.writes };
      });
      expect(lobby).toMatchObject({ kind: "public", state: "holding", slot: "public-0", rated: true, mode: "1v1" });
      await vi.waitFor(() => expect(server!.hub.hasLobby(lobby.id)).toBe(true), { timeout: 20_000 });

      await new Promise(resolve => setTimeout(resolve, 1_500));
      const get = (path: string) => fetch(origin + path, { signal: abort.signal });
      await vi.waitFor(async () => {
        const catalog = await (await get("/watch/catalog")).json();
        // Both players by name with their first-match figures in the 1v1 mode, and no model label: no agent has joined.
        const fresh = (displayName: string) => [{ displayName, modelLabel: null, thinkingLevel: null, serviceTier: null, rating: 1500, rd: 350, ratedMatches: 0 }];
        expect(catalog.matches).toEqual([{ lobbyId: lobby.id, startedAt: expect.any(Number), rated: true, delaySeconds: RATED_DELAY_SECONDS,
          colonies: [fresh(alice!.displayName), fresh(bob!.displayName)], matchType: { kind: "ranked", size: 1 } }]);
        // A queue-made lobby is never offered as a lobby to join.
        expect(catalog.lobbies).toEqual([]);
      }, { timeout: 10_000 });
      catalogChecked = true;

      // No invite header on any request.
      const status = await get(`/watch/status/${lobby.id}`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ lobbyId: lobby.id, started: true, delaySeconds: RATED_DELAY_SECONDS });
      expect((await get(`/watch/recording/${lobby.id}`)).status).toBe(200);
      const live = await get(`/watch/live/${lobby.id}`);
      expect(live.status).toBe(200);
      expect(live.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const reader = live.body!.getReader();
      const firstData = (async () => {
        let text = "";
        while (!text.includes("data:")) { const chunk = await reader.read(); if (chunk.done) throw new Error("early stream end"); text += new TextDecoder().decode(chunk.value); }
        return text;
      })();
      // The match plays on real time while the spectator clock is manual. Its end must be
      // pushed before the clock passes the rated delay: an end pushed after the advance
      // schedules the first record from the advanced clock, which never moves again.
      await vi.waitFor(() => expect(server!.game.match?.result ?? null).not.toBeNull(), { timeout: 10_000 });
      clock.advance((RATED_DELAY_SECONDS + 1) * 1000);
      expect(await firstData).toContain("data:");
      await reader.cancel();
    } finally {
      abort.abort();
      await server?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
