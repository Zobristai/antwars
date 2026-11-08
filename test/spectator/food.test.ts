/**
 * The board shows the economy. Food piles come from the
 * board at the frame's tick, so the food a corpse leaves appears on its tile in
 * the frame its corpse does; each ant's carrying flag follows it by id; a
 * reconnect's full snapshot restores food and stores; piles grow with food.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { HISTORICAL_CONFIG as DEFAULT_CONFIG } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";
import { createMatch } from "../../src/sim/map.ts";
import { playScripted, recordLog, type ScriptOptions } from "../../src/live/record.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { crumbRadiusPx, foodPiles, MAX_CRUMBS, pileCrumbs, pileGrowth } from "../../web/src/food.ts";
import { nextAntCells } from "../../web/src/overlays.ts";

const SCRIPT: ScriptOptions = { seed: 6006, config: playable(DEFAULT_CONFIG), agents: 10, ticks: 900, attack: true };

let messages: StreamMessage[];
/** Each dead ant's tile as the sim recorded it, the message tick that carried its death, and the sim's food there before and after that step. */
const deaths = new Map<number, { tile: number; tick: number; before: number; after: number }>();

beforeAll(() => {
  const W = SCRIPT.config.mapWidth;
  let food = createMatch(SCRIPT.seed, SCRIPT.config).food.slice();
  const { lines } = playScripted(SCRIPT, (out) => {
    for (const e of out.events) {
      if (e.type !== "death") continue;
      const tile = e.tileY * W + e.tileX;
      deaths.set(e.antId, { tile, tick: out.state.tick, before: food[tile]!, after: out.state.food[tile]! });
    }
    food = out.state.food.slice();
  });
  messages = recordLog(lines).map(decodeMessage);
}, 120_000);

/** Plays messages arriving on time and returns the frame drawn at each tick, keeping what the tests read. */
function framesByTick(msgs: readonly StreamMessage[]) {
  const pb = new Playback();
  const frame = new Frame();
  const out = new Map<number, { food: Uint32Array; corpses: number[]; carrying: Map<number, number>; stores: string }>();
  for (const m of msgs) {
    pb.push(m, m.tick * TICK_MS);
    pb.sample(m.tick * TICK_MS + RENDER_DELAY_MS, frame);
    const carrying = new Map<number, number>();
    for (let i = 0; i < frame.count; i++) carrying.set(frame.id[i]!, frame.carrying[i]!);
    out.set(frame.tick, { food: frame.board!.food, corpses: frame.corpses.map((c) => c.antId), carrying, stores: JSON.stringify(frame.board!.stores) });
  }
  return out;
}

describe("food on the board", () => {
  it("keeps each ant's carrying flag and the confirmed bites on the frame", () => {
    const pb = new Playback();
    const frame = new Frame();
    let bites = 0;
    for (const m of messages) {
      pb.push(m, m.tick * TICK_MS);
      pb.sample(m.tick * TICK_MS + RENDER_DELAY_MS, frame);
      expect(frame.carrying.length).toBeGreaterThanOrEqual(frame.count);
      bites = Math.max(bites, frame.engagements.length);
    }
    expect(bites).toBeGreaterThan(0);
  });

  it("shows the food a corpse leaves on its tile in the frame its corpse first appears, and not before", () => {
    const frames = framesByTick(messages);
    expect(deaths.size).toBeGreaterThan(10);
    const wrong: string[] = [];
    let rose = 0;
    for (const [antId, d] of deaths) {
      const at = frames.get(d.tick)!;
      const before = frames.get(d.tick - 1)!;
      if (!at.corpses.includes(antId)) wrong.push(`ant ${antId}: no corpse at tick ${d.tick}`);
      if (before.corpses.includes(antId)) wrong.push(`ant ${antId}: corpse before tick ${d.tick}`);
      // The tile shows the sim's food after the death in the corpse's frame, and before it one frame earlier.
      // (When a forager takes food from the tile in the same step, the sim's own count need not rise.)
      if (at.food[d.tile] !== d.after || before.food[d.tile] !== d.before) {
        wrong.push(`ant ${antId}: tile ${d.tile} shows ${before.food[d.tile]} -> ${at.food[d.tile]}, sim ${d.before} -> ${d.after} at tick ${d.tick}`);
      }
      if (d.after > d.before) rose++;
    }
    expect(wrong).toEqual([]);
    // Most deaths raise their tile's food in that frame: the corpse's food is visible, not taken at once.
    expect(rose).toBeGreaterThan(deaths.size * 0.8);
  });

  it("marks each ant carrying food by id, as the stream says at the frame's tick, and some ants carry", () => {
    const frames = framesByTick(messages);
    let carried = 0;
    const wrong: string[] = [];
    for (const m of messages) {
      const f = frames.get(m.tick)!;
      for (let i = 0; i < m.ants.count; i++) {
        if (f.carrying.get(m.ants.id[i]!) !== m.ants.carrying![i]) wrong.push(`ant ${m.ants.id[i]} at tick ${m.tick}`);
        carried += m.ants.carrying![i]!;
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(carried).toBeGreaterThan(0);
  });

  it("restores food and stores from a reconnect's full snapshot after messages were missed", () => {
    const cut = 400;
    const resume = 520;
    const truth = new SpectatorState(structuredClone(messages[0]!.full!), messages[0]!.tick, messages[0]!.ants);
    for (const m of messages.slice(1, resume + 1)) truth.apply(m);
    // The reconnect's full snapshot, as the hub would send it at the resume tick, through the wire format.
    const full = decodeMessage(encodeMessage(truth.message()));
    const frames = framesByTick([...messages.slice(0, cut + 1), full, ...messages.slice(resume + 1, resume + 50)]);
    const at = frames.get(resume)!;
    expect(Array.from(at.food)).toEqual(Array.from(truth.full.food!));
    expect(at.stores).toBe(JSON.stringify(truth.full.stores));
    // And playback carries on from it: the board after 49 more messages matches the stream's own board.
    for (const m of messages.slice(resume + 1, resume + 50)) truth.apply(m);
    expect(Array.from(frames.get(resume + 49)!.food)).toEqual(Array.from(truth.full.food!));
    // The economy changed in the gap, so this is a restore, not a coincidence.
    expect(Array.from(frames.get(cut)!.food)).not.toEqual(Array.from(at.food));
  });

  it("sizes piles by food: one crumb per food up to the most crumbs, then a larger pile, and none for an empty tile", () => {
    expect([0, 1, 2, 3, 7, 8, 40].map(pileCrumbs)).toEqual([0, 1, 2, 3, MAX_CRUMBS, MAX_CRUMBS, MAX_CRUMBS]);
    expect(pileGrowth(1)).toBe(1);
    expect(pileGrowth(MAX_CRUMBS)).toBe(1);
    expect(pileGrowth(14)).toBeGreaterThan(pileGrowth(10));
    expect(pileGrowth(1000)).toBe(1.5);
    const piles = foodPiles(Uint32Array.of(0, 2, 0, 9), 2);
    expect(piles.map((p) => [p.tile, p.crumbs])).toEqual([
      [1, 2],
      [3, MAX_CRUMBS],
    ]);
    // Each pile stays on its own tile.
    for (const p of piles) expect([Math.floor(p.x), Math.floor(p.y)]).toEqual([p.tile % 2, Math.floor(p.tile / 2)]);
    // Crumbs keep a readable size on a phone's whole board and do not swell at 1080p.
    expect(crumbRadiusPx(6)).toBe(1.6);
    expect(crumbRadiusPx(100)).toBe(4);
  });
});

// The food line's two cells, as the HUDs show them (nextAntCells): the stock (with the cost while short of it) and the next ant.
describe("the panel's economy line", () => {
  const hatch = { cost: 3, intervalTicks: 18, cap: 150 };
  const tps = 10;

  it("shows the real store and countdown once funded, never a full or overfull fraction", () => {
    expect(nextAntCells({ food: 7, nextHatchTick: 114, nextCost: 3 }, hatch, 40, 100, tps)).toEqual(["7", "· Next ant 2 s"]);
    expect(nextAntCells({ food: 61, nextHatchTick: 140, nextCost: 3 }, hatch, 40, 100, tps)).toEqual(["61", "· Next ant 4 s"]);
    // Due now (or overdue between messages): never a negative wait.
    expect(nextAntCells({ food: 3, nextHatchTick: 90, nextCost: 3 }, hatch, 40, 100, tps)).toEqual(["3", "· Next ant ready"]);
    // Config/stream timing, not a hard-coded hatch interval or tick rate.
    expect(nextAntCells({ food: 6, nextHatchTick: 140, nextCost: 6 }, { ...hatch, intervalTicks: 40 }, 40, 100, 20)).toEqual(["6", "· Next ant 2 s"]);
  });

  it("waits for food below the next hatch's cost as labelled figures (formerly a sentence): a worker's 3, or a soldier's 6 when the sim hatches a soldier next", () => {
    expect(nextAntCells({ food: 1, nextHatchTick: 50, nextCost: 3 }, hatch, 40, 100, tps)).toEqual(["1/3", "· Next ant"]);
    expect(nextAntCells({ food: 4, nextHatchTick: 50, nextCost: 6 }, hatch, 40, 100, tps)).toEqual(["4/6", "· Next ant"]);
    // The cost is the stream's nextCost, not the hatch rule's worker cost: 4 food covers a worker but not a soldier.
    expect(nextAntCells({ food: 6, nextHatchTick: 105, nextCost: 6 }, hatch, 40, 100, tps)).toEqual(["6", "· Next ant 1 s"]);
  });

  it("shows the colony cap as the binding gate even when food is short or the timer has not expired", () => {
    expect(nextAntCells({ food: 9, nextHatchTick: 150, nextCost: 3 }, hatch, 150, 100, tps)).toEqual(["9", "· Cap reached"]);
    expect(nextAntCells({ food: 9, nextHatchTick: 50, nextCost: 3 }, { ...hatch, cap: 40 }, 40, 100, tps)).toEqual(["9", "· Cap reached"]);
    expect(nextAntCells({ food: 1, nextHatchTick: 50, nextCost: 6 }, hatch, 151, 100, tps)).toEqual(["1", "· Cap reached"]);
    expect(nextAntCells({ food: 4, nextHatchTick: 150, nextCost: 6 }, hatch, 150, 100, tps)).toEqual(["4", "· Cap reached"]);
    expect(nextAntCells({ food: 0, nextHatchTick: 150, nextCost: 6 }, hatch, 150, 100, tps)).toEqual(["0", "· Cap reached"]);
    expect(nextAntCells({ food: 4, nextHatchTick: 150, nextCost: 6 }, hatch, 149, 100, tps)).toEqual(["4/6", "· Next ant"]);
  });

  it("is empty when the sender gave no hatch rule", () => {
    expect(nextAntCells({ food: 0, nextHatchTick: 0, nextCost: 0 }, null, 0, 0, tps)).toBeNull();
  });
});
