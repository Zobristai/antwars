import { describe, expect, it, vi } from "vitest";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { startServer } from "../../src/server.js";
import { rulesConfig } from "../../src/sim/config.js";
import type { SlotAccess } from "../../src/mcp/game.js";
import { retentionWorld, value } from "../identity/retentionStore.js";
import { startHarness } from "./harness.js";
import { connect, tempDir, TEST_MCP_CONFIG } from "../server/helpers.js";
import { playable } from "../playable.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function world(record?: SlotAccess["recordJoin"]) {
  const w = retentionWorld();
  const owner = value(await w.ids.claimUsername("player"));
  const handle = value(await w.ids.createHandle(owner.key, "worker"));
  const slot: SlotAccess = {
    async identityOf(key) { const found = await w.ids.resolveKey(key); return found.ok ? found.value.id : undefined; },
    async locate() { return undefined; },
    recordJoin: record ?? ((id, at) => w.ids.recordMatchJoin(id, at)),
  };
  const h = await startHarness({ start: false, slot }); h.clock.now = w.now();
  h.game.seatLobby("lobby", [{ identityId: owner.identity.id, displayName: "player", colony: 0 },
    { identityId: handle.identity.id, displayName: "player/worker", colony: 1 }]);
  return { w, h, owner, handle };
}

describe("successful match-join activity", () => {
  it("does not count lobby seats or queued joins; records a queued handle only once its match admits it", async () => {
    const recorded = deferred();
    let w!: Awaited<ReturnType<typeof world>>["w"];
    const setup = await world(async (id, at) => { await w.ids.recordMatchJoin(id, at); recorded.resolve(); });
    w = setup.w;
    const { h, owner, handle } = setup;
    try {
      const agent = await h.connect();
      expect(w.docs.get(`identities/${owner.identity.id}`)?.hasJoinedMatch).toBeUndefined();
      const queued = await agent.call("join", { key: handle.key });
      expect(queued.isError).toBe(false); expect(queued.data.matchStarts).toBeDefined();
      expect(w.docs.get(`identities/${owner.identity.id}`)?.hasJoinedMatch).toBeUndefined();
      h.game.startMatch(71); h.advance(1); await recorded.promise;
      expect(w.docs.get(`identities/${owner.identity.id}`)?.hasJoinedMatch).toBe("true");
      w.advance(7 * 86_400_000);
      expect((await w.ids.findByDisplayName("player"))?.id).toBe(owner.identity.id);
    } finally { h.game.closeJoinActivity(); await h.close(); }
  });

  it("never records queued joins whose match never starts or invalid-key refusals", async () => {
    const calls: string[] = [];
    const { h, handle } = await world(async id => { calls.push(id); });
    try {
      const agent = await h.connect();
      expect((await agent.call("join", { key: "wrong" })).isError).toBe(true);
      expect((await agent.call("join", { key: handle.key })).isError).toBe(false);
      h.game.endNotPlayed();
      expect((await agent.call("join", { key: handle.key })).isError).toBe(true);
      expect(calls).toEqual([]);
    } finally { h.game.closeJoinActivity(); await h.close(); }
  });

  it("waits for durable activity before acknowledging a live join, and records successful key rejoins", async () => {
    const entered = deferred(), allow = deferred(); let count = 0;
    const { h, handle } = await world(async () => { ++count; entered.resolve(); await allow.promise; });
    try {
      h.game.startMatch(72);
      const agent = await h.connect(); let acknowledged = false;
      const joined = agent.call("join", { key: handle.key }).then(result => { acknowledged = true; return result; });
      await entered.promise;
      expect(acknowledged).toBe(false);
      allow.resolve(); expect((await joined).isError).toBe(false);
      expect((await agent.call("join", { key: handle.key })).isError).toBe(false);
      expect(count).toBe(2);
    } finally { allow.resolve(); h.game.closeJoinActivity(); await h.close(); }
  });

  it("retains a failed durable admission update for retry rather than falsely acknowledging it", async () => {
    const entered = deferred(), retried = deferred(); let attempts = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { h, handle } = await world(async () => {
      if (++attempts === 1) { entered.resolve(); throw new Error("transient store failure"); }
      retried.resolve();
    });
    try {
      h.game.startMatch(73);
      const agent = await h.connect(); let acknowledged = false;
      const joined = agent.call("join", { key: handle.key }).then(result => { acknowledged = true; return result; });
      await entered.promise; expect(acknowledged).toBe(false);
      await retried.promise; expect((await joined).isError).toBe(false);
      expect(attempts).toBe(2);
    } finally { h.game.closeJoinActivity(); await h.close(); warn.mockRestore(); }
  });

  it("production slot wiring records the successful join, not all started-lobby seats", async () => {
    const w = retentionWorld(Date.now());
    const owner = value(await w.ids.claimUsername("player")), other = value(await w.ids.claimUsername("other"));
    const lobbies = createLobbies(w.store, w.ids, { countdownMs: 0 });
    const created = value(await lobbies.createLobby(owner.key, "public", 1));
    value(await lobbies.join(created.lobby.id, owner.key)); value(await lobbies.join(created.lobby.id, other.key));
    const started = deferred();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: playable(rulesConfig("redesign")),
      mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 1,
      slot: { slot: "public-0", publicUrl: "http://slot.test", lobbies, identities: w.ids, pollMs: 5 },
      feed: { matchStarted() { started.resolve(); }, ticked() {} },
    });
    const agent = await connect(server.port);
    try {
      await started.promise;
      expect((await agent.call("join", { key: owner.key })).isError).toBe(false);
      expect(w.docs.get(`identities/${owner.identity.id}`)?.hasJoinedMatch).toBe("true");
      expect(w.docs.get(`identities/${other.identity.id}`)?.hasJoinedMatch).toBeUndefined();
    } finally { await agent.close(); await server.close(); }
  });
});
