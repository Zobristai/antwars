import { Frame, type Board } from "../../../web/src/buffer.ts";
import type { StreamAgent } from "../../../src/live/format.ts";

/** Explicit unit fixture, not a real match or visual evidence. */
export function scoreFrame(colonies = 2, seats = colonies): Frame {
  const f = new Frame();
  f.tick = 6000; f.targetMs = 600000; f.match = 1; f.count = 0;
  f.board = {
    setup: { mapW: 64, mapH: 64, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: Array.from({ length: colonies }, (_, c) => [c * 256, 256]), rules: "redesign", rated: false,
      ...(colonies === 4 ? { colonies: 4 } : {}) },
    queens: Array.from({ length: colonies }, (_, c) => ({ id: 0, colony: c, x: c * 256, y: 256, foundedTick: 0, lostTick: null, hp: 40000, overrun: 0 })),
    agents: Array.from({ length: seats }, (_, i): StreamAgent => ({ colony: i % colonies, modelLabel: "example/model", identity: { displayName: `player-${i}`, elo: 1500 },
      joinTick: 0, lastCallTick: 5950, prevCallTick: 5900, lastCommandTick: 5920, order: "forage", orderX: 0, orderY: 0, intent: "" })),
    held: Array.from({ length: colonies }, () => 100), deaths: Array.from({ length: colonies }, (_, c) => c + 3),
    stores: Array.from({ length: colonies }, () => ({ food: 2, nextCost: 3, nextHatchTick: 6010 })),
    hatch: { cost: 3, intervalTicks: 20, cap: 512 }, result: null, territory: new Uint8Array(0), food: new Uint32Array(0), marks: [],
    overrun: Array.from({ length: colonies }, () => 0), overrunRequired: 100,
  } as Board;
  return f;
}
