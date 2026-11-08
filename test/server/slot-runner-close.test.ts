/// <reference types="node" />
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Lobbies, SlotHolder } from "../../src/lobby/lobbies.ts";
import { startSlotRunner } from "../../src/slots/slotServer.ts";

// A slot runner closed while its poll awaits the slot holder sends no self-probe and no
// heartbeat afterwards: the server it would probe is already closing.
describe("slot runner closed during a poll", () => {
  it("sends no probe and no heartbeat once closed during a held slotHolder read", async () => {
    let runId = "";
    let clock = 1_000;
    const calls = { probe: 0, heartbeat: 0 };
    const held: { resolve?: (holder: SlotHolder) => void } = {};
    let begun = false;
    let holdNext = false;
    const holder = (matchRunId: string | null): SlotHolder => ({
      lobbyId: "lobby-1", mode: null, startsAt: 0, matchRunId, colonies: [[], []],
    });
    const lobbies = {
      countdownMs: 0,
      async registerInstance(_slot: string, instance: { runId: string }) {
        runId = instance.runId;
        return { registered: true };
      },
      async resolveSlot() { return { runId }; },
      async slotHolder() {
        if (runId === "" || !holdNext) return holder(begun ? runId : null);
        holdNext = false;
        return new Promise<SlotHolder>((resolve) => { held.resolve = resolve; });
      },
      async beginMatch() { begun = true; return { ok: true }; },
      async heartbeat() { calls.heartbeat++; return true; },
    } as unknown as Lobbies;
    const runner = await startSlotRunner({
      slot: "runner-close-test", lobbies, mcpUrl: "http://runner.test/mcp", spectatorUrl: "http://runner.test/",
      pollMs: 5, heartbeatMs: 10, now: () => clock, probe: () => { calls.probe++; },
      host: { async seat() {}, start: () => true, handOver: async () => false, abandon() {}, notPlayed() {} },
    });
    try {
      const until = async (check: () => boolean): Promise<void> => {
        const by = Date.now() + 5_000;
        while (!check()) {
          if (Date.now() > by) throw new Error("timed out");
          await sleep(5);
        }
      };
      // Positive control: an open runner whose begun match is current probes and beats.
      await until(() => begun);
      clock += 10;
      await until(() => calls.heartbeat === 1);
      expect(calls).toEqual({ probe: 1, heartbeat: 1 });

      // Hold the next poll on its slotHolder read, past the next beat, then close the runner.
      holdNext = true;
      clock += 10;
      await until(() => held.resolve !== undefined);
      runner.close();
      held.resolve!(holder(runId));
      await sleep(50);
      expect(calls).toEqual({ probe: 1, heartbeat: 1 });
    } finally {
      runner.close();
    }
  });
});
