// A match's drawn colony names in the board's caption, on the 2D board (its toast) and the 3D deck: each name in its
// colony's colour with its source note, and the rated names as they always were. The HUDs are mounted on the test port
// and driven with frames; this is not visual evidence.
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { colonyNameNote } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const TICK = 4000;
const queen = (colony: 0 | 1, tile: number): StreamQueen => ({ id: 0, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick: null, overrun: 0, hp: 40000 });
const agent = (colony: 0 | 1, name: string): StreamAgent => ({ identity: { displayName: name, elo: 1500 }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" });

/** An unrated match carrying `drawn`, or a rated one with none, with colony 0's overrun on colony 1's queen under way. */
function frameOf(drawn: readonly [string, string] | null): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100; f.match = 1;
  f.ensure(0); f.count = 0;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: drawn === null, rules: "redesign", ...(drawn ? { colonyNames: drawn } : {}) },
    queens: [queen(0, 8), queen(1, 50)],
    territory: new Uint8Array(0), held: [500, 500], marks: [], agents: [agent(0, "fennec"), agent(1, "tidewater")],
    overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 5, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 5, nextHatchTick: TICK + 10, nextCost: 3 }],
  };
  f.board = b;
  f.story = [{ id: 1, kind: "overrun", queenId: 0, tick: TICK - 20, colony: 0, agent: -1, x: 50, y: 20 }];
  return f;
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

function caption(deck: boolean, frame: Frame) {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = (deck ? mountDeckHud : mountHud)({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  hud.update({ frame, connection: "live", board: deck ? "3d" : "2d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  const cls = deck ? ["d1-cap-what", "d1-cap-who"] : ["d2-toast-what", "d2-toast-who"];
  return { what: host.byClass(cls[0]!)[0]!, who: host.byClass(cls[1]!)[0]! };
}
const named = (node: ElementPort) => node.children.filter(c => c.tag === "span").map(c => ({
  name: c.textContent, colour: (c.style as unknown as { color: string }).color, note: c.getAttribute("title"),
}));

describe("a match's drawn colony names in the board's caption", () => {
  for (const deck of [false, true]) {
    it(`on the ${deck ? "3D deck" : "2D board"}, shows each drawn name in its colony's colour with its note, and the rated names as they were`, () => {
      const drawn = caption(deck, frameOf(["Sweetwater Colony", "Lake Skinner Colony"]));
      expect(drawn.what.textContent).toBe("Overrun attempt on the Lake Skinner Colony queen — under way");
      expect(named(drawn.what)).toEqual([{ name: "Lake Skinner Colony", colour: "var(--aw-k1, var(--aw-c1))", note: colonyNameNote("Lake Skinner Colony") }]);
      expect(named(drawn.who)).toEqual([{ name: "Sweetwater Colony", colour: "var(--aw-k0, var(--aw-c0))", note: colonyNameNote("Sweetwater Colony") }]);

      const rated = caption(deck, frameOf(null));
      expect(rated.what.textContent).toBe("Overrun attempt on the Lake Hodges Colony queen — under way");
      expect(rated.what.children).toHaveLength(0);
      expect(rated.who.textContent).toMatch(/^Very Large Colony/);
      expect(rated.who.children).toHaveLength(0);
    });
  }
});
