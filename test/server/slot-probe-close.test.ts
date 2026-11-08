/// <reference types="node" />
import { createServer, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identities } from "../../src/identity/identities.ts";
import type { Lobbies, SlotHolder } from "../../src/lobby/lobbies.ts";
import { startServer } from "../../src/server.ts";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { playable } from "../playable.ts";
import { tempDir } from "./helpers.ts";

// Every match plays at grid scale 2: main's templates are built through the one constructor.
const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG);

afterEach(() => { vi.restoreAllMocks(); });

// A self-probe still in flight when the slot server closes fails because this server is
// shutting down, not because players cannot reach it, so it logs nothing.
describe("slot server closed with a self-probe in flight", () => {
  it("logs no self-probe failure", { timeout: 20_000 }, async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The server's public origin: accepts connections and never answers, so a probe stays in flight.
    const sockets: Socket[] = [];
    let wakes = 0;
    const silent = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (chunk) => { if (chunk.toString().startsWith("GET /wake ")) wakes++; });
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
    let runId = "";
    let begun = false;
    const holder = (): SlotHolder => ({ lobbyId: "lobby-1", mode: null, startsAt: 0, matchRunId: begun ? runId : null, colonies: [[{ id: "ann", displayName: "Ann" }], [{ id: "bob", displayName: "Bob" }]] } as SlotHolder);
    const lobbies = {
      countdownMs: 0,
      async registerInstance(_slot: string, instance: { runId: string }) { runId = instance.runId; return { registered: true }; },
      async resolveSlot() { return { runId }; },
      async slotHolder() { return holder(); },
      async beginMatch() { begun = true; return { ok: true }; },
      async heartbeat() { return true; },
    } as unknown as Lobbies;
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), seed: 1, simConfig: PUBLIC_CONFIG,
      slot: { slot: "probe-close-test", publicUrl: origin, lobbies, identities: {} as Identities, pollMs: 5, heartbeatMs: 10 } });
    try {
      const by = Date.now() + 10_000;
      while (wakes === 0) {
        if (Date.now() > by) throw new Error(`No self-probe reached the public origin: ${JSON.stringify(errors.mock.calls.slice(0, 2))}`);
        await sleep(5);
      }
      expect(errors).not.toHaveBeenCalled();
      await server.close();
      // The probe in flight now fails.
      for (const socket of sockets) socket.destroy();
      await sleep(100);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await server.close().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
