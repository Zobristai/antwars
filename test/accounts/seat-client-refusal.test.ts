import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKENDS, closeAll, host, OTHER_CLIENT, SEAT_CLIENT_1_0_0, SEAT_CLIENT_LATER, serve, session, value, world,
} from "./seat-client-world.ts";

/**
 * The entry server's MCP endpoint called directly: a session whose initialize reported
 * clientInfo antwars-seat 1.0.0 is refused update_seat_client on queue_status,
 * read_lobby, locate_match, join_queue, join_lobby and create_lobby, and nothing is
 * queued, paired, seated or created; a later seat client and other MCP clients are
 * answered as before.
 */
const HOW_TO_FIX = "Copy the seat client again from origin/main into ./.antwars-seat as packages/antwars-seat/README.md describes, then run your command again.";
const MESSAGE = `This server no longer accepts seat client 1.0.0, which cannot wait out a server handover. ${HOW_TO_FIX}`;
const ACCOUNT_REFUSAL = { error: "update_seat_client", message: MESSAGE };
const LOCATOR_REFUSAL = { error: { code: "update_seat_client", message: MESSAGE, howToFix: HOW_TO_FIX }, tick: null };

afterEach(closeAll);

for (const backend of BACKENDS) {
  describe.skipIf(backend === "Firestore emulator" && !host)(`seat client 1.0.0 at the entry server using ${backend}`, { timeout: 60_000 }, () => {
    it("refuses each of the six entry calls with update_seat_client and queues, pairs, seats or creates nothing", async () => {
      const w = world(backend);
      const url = `http://127.0.0.1:${(await serve(w.accounts)).port}/mcp`;
      const later = await session(url, SEAT_CLIENT_LATER);
      const ann = value(await w.accounts.identities.claimUsername("Ann"));
      const bob = value(await w.accounts.identities.claimUsername("Bob"));
      const cy = value(await w.accounts.identities.claimUsername("Cy"));
      // Cy waits in the 1v1 queue, so a join_queue from Ann would pair; Bob's open lobby has free seats.
      expect((await later("join_queue", { key: cy.key, mode: "1v1" })).body).toMatchObject({ queue: { state: "waiting" } });
      const lobbyId = (await later("create_lobby", { key: bob.key, size: 1, kind: "public" })).body.lobby.id as string;
      const before = {
        cyQueue: (await later("queue_status", { key: cy.key })).body,
        lobby: (await later("read_lobby", { lobbyId, key: bob.key })).body,
        listed: (await later("list_lobbies")).body,
        writes: w.writes(),
      };
      expect(before.lobby).toMatchObject({ lobby: { id: lobbyId, state: "open" } });

      const old = await session(url, SEAT_CLIENT_1_0_0);
      const calls: [string, Record<string, unknown>][] = [
        ["queue_status", { key: ann.key }],
        ["read_lobby", { lobbyId, key: bob.key }],
        ["locate_match", { lobbyId }],
        ["join_queue", { key: ann.key, mode: "1v1" }],
        ["join_lobby", { key: ann.key, lobbyId }],
        ["create_lobby", { key: ann.key, size: 1, kind: "public" }],
      ];
      for (const [name, args] of calls) {
        const reply = await old(name, args);
        expect(reply.isError, name).toBe(true);
        expect(reply.body, name).toEqual(name === "locate_match" ? LOCATOR_REFUSAL : ACCOUNT_REFUSAL);
      }
      expect(w.writes()).toBe(before.writes);

      // Read back from a later client: no queue entry, no pairing, no seat, no lobby.
      expect((await later("queue_status", { key: ann.key })).body).toEqual({ queue: { state: "none" } });
      expect((await later("queue_status", { key: cy.key })).body).toEqual(before.cyQueue);
      expect((await later("read_lobby", { lobbyId, key: bob.key })).body).toEqual(before.lobby);
      expect((await later("list_lobbies")).body).toEqual(before.listed);
      // The session's other entry tools are unchanged.
      expect(await old("list_lobbies")).toMatchObject({ isError: false, body: before.listed });
    });

    for (const [label, clientInfo] of [["a later seat client", SEAT_CLIENT_LATER], ["another MCP client", OTHER_CLIENT]] as const) {
      it(`answers the same calls from ${label} as today`, async () => {
        const w = world(backend);
        const url = `http://127.0.0.1:${(await serve(w.accounts)).port}/mcp`;
        const call = await session(url, clientInfo);
        const ann = value(await w.accounts.identities.claimUsername("Ann"));
        const bob = value(await w.accounts.identities.claimUsername("Bob"));
        const cy = value(await w.accounts.identities.claimUsername("Cy"));

        expect(await call("queue_status", { key: ann.key })).toMatchObject({ isError: false, body: { queue: { state: "none" } } });
        expect(await call("queue_status", { key: "not-a-key" })).toMatchObject({ isError: true, body: { error: "invalid_key", message: "That key is not valid." } });
        const waiting = await call("join_queue", { key: ann.key, mode: "1v1" });
        expect(waiting).toMatchObject({ isError: false, body: { queue: { state: "waiting", mode: "1v1" } } });
        expect(waiting.body.queue.expiresAt - waiting.body.queue.joinedAt).toBe(12 * 60 * 60 * 1000);
        const matched = await call("join_queue", { key: bob.key, mode: "1v1" });
        expect(matched).toMatchObject({ isError: false, body: { queue: { state: "matched", mode: "1v1" } } });
        const lobbyId = matched.body.queue.lobbyId as string;
        expect((await call("queue_status", { key: ann.key })).body).toMatchObject({ queue: { state: "matched", lobbyId } });
        expect(await call("read_lobby", { lobbyId, key: ann.key })).toMatchObject({ isError: false, body: { lobby: { id: lobbyId, state: "holding", slot: "public-0" } } });
        // Holding without a registered instance: the slot and the lobby's antwars.ai page; no mcpUrl until registration.
        expect(await call("locate_match", { lobbyId })).toMatchObject({ isError: false, body: { slot: "public-0", mcpUrl: null, spectatorUrl: `https://antwars.ai/?lobby=${lobbyId}` } });
        expect(await call("locate_match", { lobbyId: randomUUID() })).toMatchObject({ isError: true, body: {
          error: { code: "no_such_lobby", message: "No lobby has that id.", howToFix: "Use the lobbyId that create_lobby, list_lobbies or read_lobby returned." }, tick: null,
        } });

        const created = await call("create_lobby", { key: cy.key, size: 1, kind: "public" });
        expect(created).toMatchObject({ isError: false, body: { lobby: { state: "open" } } });
        const openId = created.body.lobby.id as string;
        expect(await call("join_lobby", { key: cy.key, lobbyId: openId })).toMatchObject({ isError: false, body: { lobby: { id: openId, state: "open" } } });
        expect(await call("join_lobby", { key: cy.key, lobbyId: openId })).toMatchObject({ isError: true, body: { error: "already_seated", message: "You already have a seat in this lobby." } });
      });
    }

    it("leaves a slot server's tools answering a 1.0.0 session as before", async () => {
      const w = world(backend);
      const slot = await serve(w.accounts, { slot: { slot: "private-0", publicUrl: "http://slot.test", identities: w.accounts.identities, lobbies: w.accounts.lobbies, pollMs: 60_000 } });
      const ann = value(await w.accounts.identities.claimUsername("Ann"));
      const lobbyId = value(await w.accounts.lobbies.createLobby(ann.key, "public", 1)).lobby.id;
      const old = await session(`http://127.0.0.1:${slot.port}/mcp`, SEAT_CLIENT_1_0_0);
      expect(await old("queue_status", { key: ann.key })).toMatchObject({ isError: false, body: { queue: { state: "none" } } });
      expect(await old("locate_match", { lobbyId })).toMatchObject({ isError: false, body: { slot: null, mcpUrl: null, spectatorUrl: null } });
    });
  });
}
