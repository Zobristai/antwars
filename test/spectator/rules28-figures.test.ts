// The deck and the 2D HUD read a rules-28 board's unit figures from its own match's stream: a rules-28 match streams
// them with its setup marker, read from its config. A board without the marker keeps rules 27's frozen figures. Every
// board here is decoded from a real match's public stream; no served config is replaced.
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../web/src/buffer.ts";
import { SUB_TILE, decodeMessage, encodePublicMessage, type StreamQueen } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import type { SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { dials, winConditions } from "../../web/src/ui/deck/model.ts";
import { nextHatchCaste } from "../../web/src/overlays.ts";
import { boardQueenHp, redesignFigures } from "../../web/src/variant.ts";
import { mountHud } from "../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../web/src/ui/types.ts";
import { dom, type ElementPort } from "./pages/dom.ts";
import { rules27Redesign } from "../rules27.ts";

/** A rules-28 match of its own: 2 food per second, 2-food workers, 6-food soldiers (30 ticks), 100 HP queens. */
const RULES28: SimConfig = (() => {
  const { hatchTiming: _timing, ...rest } = rules27Redesign();
  return { ...rest, rules28: true, hatchRate: { foodPerSecond: 2 }, hatchCost: 2,
    queenHp: { hp: 100_000, damagePerSecond: 10_000, regenHp: 1_000, regenIntervalTicks: 100, regenClearTiles: 3, shieldTicks: 3000 } };
})();

/** The setup and hatch a spectator receives for a match of this config: its first public full snapshot, decoded. */
function streamed(config: SimConfig) {
  const recorder = new SpectatorRecorder(createMatch(7, newMatchConfig(config)));
  const full = decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull(), events: [] })).full!;
  return { setup: full.setup, hatch: full.hatch! };
}
const MARKED = streamed(RULES28), UNMARKED = streamed(rules27Redesign());

const TICK = 4000;
const queen = (colony: 0 | 1, tile: number, hp: number): StreamQueen => ({ id: 0, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick: null, overrun: 0, hp });

/** A board as its stream gives it, marked as rules 28 or not, with each colony's next hatch 15 ticks away. */
function frameOf(marked: boolean, queenHp: number, nextCost: readonly [number, number]): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100; f.match = 1;
  f.ensure(0); f.count = 0;
  const { setup, hatch } = marked ? MARKED : UNMARKED;
  const b: Board = {
    setup, queens: [queen(0, 8, queenHp), queen(1, 50, queenHp)],
    territory: new Uint8Array(0), held: [500, 500], marks: [], agents: [],
    overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null,
    food: new Uint32Array(0), hatch,
    stores: [{ food: 50, nextHatchTick: TICK + 15, nextCost: nextCost[0] }, { food: 50, nextHatchTick: TICK + 15, nextCost: nextCost[1] }],
  };
  f.board = b;
  f.story = [];
  return f;
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

/** The 2D HUD's queen cells after one frame: each cell's fill width and its spoken reading. */
function hudQueenCells(frame: Frame) {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = mountHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  hud.update({ frame, connection: "live", board: "2d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  return host.byClass("d2-cell").map(cell => ({ width: (cell.byClass("d2-cell-fill")[0]!.style as unknown as { width: string }).width, label: cell.getAttribute("aria-label") }));
}

describe("a board's unit figures follow its rules generation", () => {
  it("a marked board reads its match's streamed rules-28 figures; an unmarked one keeps rules 27's", () => {
    expect(MARKED.setup.rules28).toBe(true);
    expect([MARKED.hatch.cost, MARKED.hatch.intervalTicks, UNMARKED.hatch.cost, UNMARKED.hatch.intervalTicks]).toEqual([2, 10, 3, 10]);
    expect(redesignFigures(frameOf(true, 1, [2, 2]).board!)).toEqual({ workerCost: 2, soldierCost: 6, queenHp: 100_000 });
    expect(redesignFigures(frameOf(false, 1, [3, 3]).board!)).toEqual({ workerCost: 3, soldierCost: 6, queenHp: 40_000 });
    expect(boardQueenHp(frameOf(true, 1, [2, 2]).board!)?.hp).toBe(100_000);
    expect(boardQueenHp(frameOf(false, 1, [3, 3]).board!)?.hp).toBe(40_000);
  });

  it("the deck's queen lamps fill against the generation's full HP", () => {
    const lamp = (frame: Frame) => winConditions(frame).lamps[0][0]!;
    expect(lamp(frameOf(true, 50_000, [2, 2]))).toMatchObject({ hp: "50", fill: 0.5 });
    expect(lamp(frameOf(false, 20_000, [3, 3]))).toMatchObject({ hp: "20", fill: 0.5 });
  });

  it("the deck's next-spawn ring knows each caste by the generation's prices and fills a soldier's wait by its interval", () => {
    // 15 ticks to go: a rules-28 soldier waits 30 ticks (half done), a rules-27 soldier 20 (a quarter done).
    const [r28Soldier, r28Worker] = dials(frameOf(true, 100_000, [6, 2]));
    expect(r28Soldier.next).toEqual({ kind: "waiting", caste: "soldier", fill: 0.5 });
    expect(r28Worker.next).toMatchObject({ kind: "waiting", caste: "worker" });
    const [r27Soldier, r27Worker] = dials(frameOf(false, 40_000, [6, 3]));
    expect(r27Soldier.next).toEqual({ kind: "waiting", caste: "soldier", fill: 0.25 });
    expect(r27Worker.next).toMatchObject({ kind: "waiting", caste: "worker" });
  });

  it("the HUD names the next caste by the generation's prices: a rules-27 worker price is no rules-28 caste, and the reverse", () => {
    expect(nextHatchCaste(frameOf(true, 100_000, [2, 2]).board!, 2)).toBe("worker");
    expect(nextHatchCaste(frameOf(true, 100_000, [2, 2]).board!, 6)).toBe("soldier");
    expect(nextHatchCaste(frameOf(true, 100_000, [2, 2]).board!, 3)).toBeNull();
    expect(nextHatchCaste(frameOf(false, 40_000, [3, 3]).board!, 3)).toBe("worker");
    expect(nextHatchCaste(frameOf(false, 40_000, [3, 3]).board!, 2)).toBeNull();
  });

  it("the 2D HUD's queen cells fill against the generation's full HP", () => {
    expect(hudQueenCells(frameOf(true, 50_000, [2, 2])).map(c => c.width)).toEqual(["50.0%", "50.0%"]);
    expect(hudQueenCells(frameOf(false, 20_000, [3, 3])).map(c => c.width)).toEqual(["50.0%", "50.0%"]);
    expect(hudQueenCells(frameOf(true, 50_000, [2, 2]))[0]!.label).toContain("queen 1: 50 HP");
  });
});
