// The Agents panel's order crown in a four-colony match: an order aimed at a queen draws a crown in that queen's colony's
// ink, for each of the four colonies, guard included. Mounted on the test port; reads the markup written, not pixels.
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUB_TILE } from "../../../src/live/format.ts";
import { SUPERCOLONY_NAMES } from "../../../src/sim/colonyNames.ts";
import { mountAgents } from "../../../web/src/ui/agents.ts";
import type { HudActions } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const TICK = 4000;
/** Each colony's queen tile on the four-colony board. */
const QUEEN_TILES = [[8, 8], [56, 8], [8, 56], [56, 56]] as const;

/** A four-colony frame whose four colony-0 agents each aim an order at one colony's queen: its own (a guard), then 1 to 3. */
function frameOf(): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100; f.match = 1;
  const agent = (target: number) => ({ colony: 0, modelLabel: `m-${target}`, joinTick: 0, lastCallTick: TICK - 5, prevCallTick: TICK - 10,
    order: target === 0 ? "go_to" : "attack", orderX: QUEEN_TILES[target]![0], orderY: QUEEN_TILES[target]![1], intent: "" });
  f.board = {
    setup: { mapW: 64, mapH: 64, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3, rated: false, rules: "redesign",
      queens: QUEEN_TILES.map(([x, y]) => [x * SUB_TILE, y * SUB_TILE]), colonyNames: SUPERCOLONY_NAMES.map(n => n.label), colonies: 4 },
    queens: QUEEN_TILES.map(([x, y], colony) => ({ id: 0, colony, x: x * SUB_TILE, y: y * SUB_TILE, foundedTick: 0, lostTick: null, overrun: 0, hp: 40000 })),
    territory: new Uint8Array(0), held: [0, 0, 0, 0], marks: [], agents: [0, 1, 2, 3].map(agent),
    overrun: [0, 0, 0, 0], overrunRequired: 100, deaths: [0, 0, 0, 0], result: null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [0, 1, 2, 3].map(() => ({ food: 5, nextHatchTick: TICK + 10, nextCost: 3 })),
  } as unknown as Board;
  return f;
}

const actions = { hover() {}, select() {}, selectAgent() {}, focusMark() {} } as unknown as HudActions;

describe("the Agents panel's order crowns with four colonies", () => {
  it("draws each targeted queen's crown in its own colony's ink, colonies 2 and 3 included", () => {
    const port = dom({ search: "" });
    const panel = mountAgents(port.doc as unknown as Document, actions, { search: () => "", lightOrder() {} });
    panel.update(frameOf(), null, -1);
    const orders = (panel.root as unknown as ElementPort).byClass("d2-order");
    expect(orders.map(order => order.getAttribute("title"))).toEqual(
      ["guard", "attack", "attack", "attack"].map((verb, colony) => `${verb} ${SUPERCOLONY_NAMES[colony]!.label}'s Queen 1`));
    expect(orders.map(order => /<svg[^>]*stroke="([^"]*)"[^>]*><path d="M4 18h16/.exec(order.html)?.[1])).toEqual(
      ["var(--aw-k0, var(--aw-c0))", "var(--aw-k1, var(--aw-c1))", "var(--aw-k2)", "var(--aw-k3)"]);
  });
});
