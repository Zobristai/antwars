import { describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { colonyStats } from "../../web/src/overlays.ts";
import { ECONOMY_PAIRS, dockStatisticsFixture, economyFixture } from "../../web/capture/economy-slots.ts";

describe("current dock statistics coverage", () => {
  it.each(ECONOMY_PAIRS)("checks both colonies through decoded small/wide %s values without joins", pair => {
    const messages = dockStatisticsFixture(pair).map(message => decodeMessage(encodePublicMessage(message)));
    expect(messages).toHaveLength(61);
    expect(messages[0]!.full!.agents).toEqual([]);
    expect(messages.flatMap(message => message.events).some(event => event.kind === "join")).toBe(false);
    expect(messages.slice(1).every((message, i) => message.full === null && message.tick === i + 1)).toBe(true);
    const playback = new Playback(), frame = new Frame();
    for (const message of messages) {
      playback.push(message, message.tick * TICK_MS);
      if (message.tick !== 10 && message.tick !== 40) continue;
      expect(playback.sample(message.tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
      const large = message.tick === 40, n = large ? 999 : 1;
      for (const stats of colonyStats(frame)) {
        expect(stats.workers).toBe(pair === "soldiers-waiting" ? 1 : n);
        expect(stats.soldiers).toBe(pair === "soldiers-waiting" ? n : 1);
        expect(stats.lost).toBe(n);
      }
      for (const store of frame.board!.stores) {
        expect(store.food).toBe(pair === "workers-shortage" ? (large ? 98 : 1) : (large ? 99999 : 7));
        expect(store.nextCost).toBe(pair === "workers-shortage" ? (large ? 99 : 9) : 3);
      }
    }
  });
  it("retains the original economy fixture and only bounds the new card shortage cost to its two-digit slot contract", () => {
    const original = economyFixture("workers-shortage");
    const current = dockStatisticsFixture("workers-shortage");
    expect(original[30]!.events.filter(event => event.kind === "store")).toEqual([
      { kind: "store", colony: 0, food: 99998, nextCost: 99999, nextHatchTick: 30 },
      { kind: "store", colony: 1, food: 99998, nextCost: 99999, nextHatchTick: 30 },
    ]);
    expect(current[30]!.events.filter(event => event.kind === "store").every(event => event.kind === "store" && event.food === 98 && event.nextCost === 99)).toBe(true);
    expect(current[30]!.ants).toEqual(original[30]!.ants);
    expect(current[0]!.full).toEqual(original[0]!.full);
  });
});
