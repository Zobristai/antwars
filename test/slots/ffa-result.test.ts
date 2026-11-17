import { expect, it, vi } from "vitest";
import { fourColonyResult } from "../../src/server/slotMode.ts";
import { startSlotRunner } from "../../src/slots/slotServer.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { quadrantMatchMaps } from "../../src/sim/mapShapes.ts";
import { createMatch } from "../../src/sim/map.ts";
import type { FfaFinish } from "../../src/sim/ffaFinish.ts";

it("forwards terminal finishing metadata through the slot adapter and snapshots it for delayed release", async () => {
  vi.useFakeTimers();
  const w = retentionWorld();
  const lobbies = createLobbies(w.store, w.ids, { now: w.now, countdownMs: 1, random: () => 0 });
  const people = [0, 1, 2, 3].map(i => w.played(`person${i}`));
  for (const p of people.slice(0, 3)) value(await lobbies.joinQueue(p.key, "quadrants"));
  const paired = value(await lobbies.joinQueue(people[3]!.key, "quadrants"));
  if (paired.state !== "matched") throw new Error("expected match");
  let starts = 0;
  const runner = await startSlotRunner({ slot: "public-0", lobbies, now: w.now, pollMs: 5,
    mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/",
    host: { seat() {}, start() { starts++; return true; }, abandon() {}, notPlayed() {} } });
  try {
    w.advance(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(starts).toBe(1);
    const base = newMatchConfig(rulesConfig("redesign"));
    const state = createMatch(404, { ...base, terrain: { ...base.terrain!, maps: quadrantMatchMaps() } });
    const order: [number, number, number, number] = [2, 0, 3, 1];
    const finish: FfaFinish = { version: 1, order, territoryWinnerFirst: false, rateable: true };
    const sim = { winner: 2, reason: "time_up" as const, decidedBy: "queen_kills" as const, tick: 100, ffa: finish };
    const result = fourColonyResult(state, sim)!;
    expect(result.ffa).toEqual(finish);
    runner.ended("colony_2_won", undefined, undefined, undefined, undefined, result);
    // The pending result must not retain caller-owned arrays across async retries.
    order[0] = 1;
    await vi.advanceTimersByTimeAsync(10);
    const stored = JSON.parse(w.docs.get(`lobbies/${paired.lobbyId}`)!.result!);
    expect(stored.ffa.order).toEqual([2, 0, 3, 1]);
    expect(w.docs.has(`ffaMatches/${paired.lobbyId}`)).toBe(false);
    expect(fourColonyResult(undefined, sim)).toBeUndefined();
    expect(fourColonyResult(createMatch(404, base), sim)).toBeUndefined();
  } finally { runner.close(); vi.useRealTimers(); }
});
