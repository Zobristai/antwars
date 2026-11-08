/**
 * The fixtures file for test/spectator/economy-slots.test.ts and test/spectator/dock-statistics.test.ts:
 * presentation-only public-wire recordings of paired economy values, with no agent joins and no simulation run.
 * Each has one opening snapshot and continuous deltas, small values then large ones, which those tests drive
 * through the public decoder and playback.
 */
import type { StreamAnts, StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";

export const ECONOMY_PAIRS = ["workers-ready", "soldiers-waiting", "workers-shortage"] as const;
export type EconomyPair = typeof ECONOMY_PAIRS[number];
const CHANGE_TICK = 30;
const LAST_TICK = 60;

/** Bounded display fixtures, not a simulated match or evidence about simulation correctness. */
export function economyFixture(pair: EconomyPair): StreamMessage[] {
  const full = new SpectatorRecorder(createMatch(112, withGridScale(rulesConfig("redesign")))).initialFull();
  full.match = 112;
  full.agents = [];
  full.marks = [];
  full.hatched = [1, 1];
  full.deaths = [1, 1];
  full.hatch = { cost: 3, intervalTicks: 18, cap: 3000 };
  const stores = (tick: number, large: boolean) => ([0, 1] as const).map((colony) => ({
    kind: "store" as const, colony,
    food: pair === "workers-shortage" ? (large ? 99998 : 1) : (large ? 99999 : 7),
    nextCost: pair === "workers-shortage" ? (large ? 99999 : 9) : 3,
    nextHatchTick: pair === "soldiers-waiting" ? tick + (large ? 999 : 9) * 10 : tick,
  }));
  full.stores = stores(0, false).map(({ food, nextCost, nextHatchTick }) => ({ food, nextCost, nextHatchTick })) as NonNullable<typeof full.stores>;
  return Array.from({ length: LAST_TICK + 1 }, (_, tick): StreamMessage => {
    const large = tick >= CHANGE_TICK;
    const n = large ? 999 : 1;
    const perColony = n + 1;
    const count = perColony * 2;
    const ants: StreamAnts = { count, id: new Uint32Array(count), x: new Uint16Array(count), y: new Uint16Array(count), heading: new Uint8Array(count), colony: new Uint8Array(count), agent: new Int16Array(count).fill(-1), caste: new Uint8Array(count), carrying: new Uint8Array(count) };
    const events: StreamMessage["events"] = [];
    for (const colony of [0, 1] as const) {
      const home = full.setup.queens[colony];
      for (let j = 0; j < perColony; j++) {
        const i = colony * perColony + j;
        const id = colony * 10000 + j + 1;
        ants.id[i] = id;
        ants.colony[i] = colony;
        ants.caste![i] = pair === "soldiers-waiting" ? (j < n ? 1 : 0) : (j < n ? 0 : 1);
        ants.carrying![i] = j < n ? 1 : 0;
        const fighting = pair === "soldiers-waiting" && j < n;
        const near = !fighting && j < n;
        ants.x[i] = fighting ? (30 + colony) * 256 + 128 : near ? home[0] : 30 * 256 + 128;
        ants.y[i] = fighting ? 24 * 256 + 128 : near ? home[1] : 24 * 256 + 128;
        if (fighting) events.push({ kind: "fight", antId: id, targetId: (1 - colony) * 10000 + j + 1, colony, tileX: 30 + colony, tileY: 24 });
        if (tick === CHANGE_TICK && j >= 2) {
          events.push({ kind: "birth", antId: id });
          // Counter-only historical losses: deliberately absent from live ants, so no corpses alter this scene.
          events.push({ kind: "death", antId: 100000 + id, colony, x: home[0], y: home[1] });
        }
      }
    }
    if (tick === CHANGE_TICK) events.push(...stores(tick, true));
    return { tick, ants, full: tick === 0 ? full : null, events };
  });
}

/** The economy fixture with the shortage cost bounded to two digits. */
export function dockStatisticsFixture(pair: EconomyPair): StreamMessage[] {
  return economyFixture(pair).map(message => ({ ...message, events: message.events.map(event =>
    pair === "workers-shortage" && event.kind === "store" ? { ...event, food: 98, nextCost: 99 } : event) }));
}
