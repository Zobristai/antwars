/**
 * The 2D board in a four-colony match: every colony's ants, queens, nests and start areas, each in its own colour, and
 * the opening view over every nest; a two-colony board is drawn as before. Each colony's colour here is a distinct
 * stand-in (the palette's own colours are the palette's tests), so a slot that took another colony's colour would show.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Texture, type Container, type Graphics, type Particle, type Renderer } from "pixi.js";
import type { StreamQueen, StreamSetup, StreamStartBox } from "../../src/live/format.ts";

const TINT = [0x112233, 0x445566, 0x778899, 0xaabbcc] as const;
vi.mock("../../web/src/colony-palette.ts", async (original) => ({
  ...(await original<typeof import("../../web/src/colony-palette.ts")>()),
  colonyTint: (colony: number) => TINT[colony]!,
}));
const { Ants, SOLDIER_HEAD } = await import("../../web/src/ants.ts");
const { Frame } = await import("../../web/src/buffer.ts");
const { QueenHomes } = await import("../../web/src/effects.ts");
const { StartBoxes2D } = await import("../../web/src/start-boxes2d.ts");
const { visibleStartBoxes } = await import("../../web/src/start-boxes.ts");
const { openingBounds, openingPhase } = await import("../../web/src/start-framing.ts");
const { Camera, fightLane, foundingEnvelope, queensBox } = await import("../../web/src/camera.ts");

const CELL_W = 64, CELL_H = 48;
type Ins = { action: string; data: { style: Record<string, unknown>; path?: { shapePath: { shapePrimitives: { shape: Record<string, unknown> }[] } } } };
const instructionsOf = (g: Graphics) => g.context.instructions as unknown as Ins[];

/** The atlas's baked drawing: the texture frame and the Graphics it is baked from. */
function atlas(colonies?: number) {
  let holder: Container | null = null, frame: { width: number; height: number } | null = null;
  const renderer = { resolution: 1, generateTexture: (o: { target: Container; frame: { width: number; height: number } }) =>
    ((holder = o.target), (frame = o.frame), Texture.WHITE) } as unknown as Renderer;
  const ants = new Ants(renderer, 20, 10, colonies);
  return { ants, frame: frame!, children: holder!.children as Graphics[] };
}

/** The colour the ellipse at (x, y) with half-width rx is filled with in g. */
function fillAt(g: Graphics, x: number, y: number, rx: number): unknown {
  return instructionsOf(g).find((i) => i.action === "fill" && (i.data.path?.shapePath.shapePrimitives ?? [])
    .some(({ shape: s }) => s.type === "ellipse" && s.x === x && s.y === y && s.halfWidth === rx))?.data.style.color;
}

describe("ant atlas", () => {
  it("bakes every colony's workers, corpses, carriers, soldiers and biting workers in that colony's colour", () => {
    const { frame, children } = atlas(4);
    const [workers, soldiers, carriers, biters] = children as [Graphics, Graphics, Graphics, Graphics];
    // Four worker rows, four carrying rows, then four soldier rows at twice the size.
    expect(frame.height).toBe(8 * CELL_H + 4 * 2 * CELL_H);
    expect(soldiers.y).toBe(8 * CELL_H);
    const cy = (row: number) => row * CELL_H + CELL_H / 2;
    for (let colony = 0; colony < 4; colony++) {
      // The abdomen carries the colony colour: walk frames and the curled corpse.
      for (let f = 0; f < 3; f++) expect(fillAt(workers, f * CELL_W + 17, cy(colony), 13)).toBe(TINT[colony]);
      expect(fillAt(workers, 3 * CELL_W + 17, cy(colony), 10)).toBe(TINT[colony]);
      for (let f = 0; f < 3; f++) expect(fillAt(carriers, f * CELL_W + 17, cy(4 + colony), 13)).toBe(TINT[colony]);
      for (let f = 0; f < 5; f++) expect(fillAt(soldiers, f * CELL_W + SOLDIER_HEAD.x, cy(colony), SOLDIER_HEAD.rx)).toBe(TINT[colony]);
      for (const carrying of [0, 1]) for (const jaw of [0, 1]) {
        expect(fillAt(biters, (4 + jaw) * CELL_W + 17, cy(colony + 4 * carrying), 13)).toBe(TINT[colony]);
      }
    }
  });

  it("lays out and draws a two-colony atlas exactly as before four colonies", () => {
    const { frame, children } = atlas();
    expect(frame.height).toBe(4 * CELL_H + 2 * 2 * CELL_H);
    const drawing = { frame, children: children.map((c) => ({ x: c.x, y: c.y, sx: c.scale.x, sy: c.scale.y,
      ins: JSON.stringify(instructionsOf(c).map((i) => ({ a: i.action,
        style: (({ color, alpha, width, cap, join }) => ({ color, alpha, width, cap, join }))(i.data.style),
        s: i.data.path?.shapePath.shapePrimitives.map((p) => p.shape) }))) })) };
    // Hash of this drawing with the code before four colonies, under the same stand-in colours.
    expect(createHash("sha256").update(JSON.stringify(drawing)).digest("hex")).toBe("9abcbb03fd70abb13340971974c7d06a6ea4d249e0502cba70efb8936dd595d4");
    expect(atlas(2).frame).toEqual(frame);
  });
});

describe("ants on the board", () => {
  /** One worker, one carrying worker and one soldier of each colony, and a corpse of each. */
  function frame(colonies: number) {
    const f = new Frame();
    const n = colonies * 3;
    f.ensure(n);
    f.count = n;
    for (let i = 0; i < n; i++) {
      const colony = Math.floor(i / 3), kind = i % 3;
      f.id[i] = i + 1; f.colony[i] = colony; f.caste[i] = kind === 2 ? 1 : 0; f.carrying[i] = kind === 1 ? 1 : 0;
      f.x[i] = 10 + i; f.y[i] = 10; f.alpha[i] = 1; f.agent[i] = -1; f.walk[i] = 1;
    }
    f.corpses = Array.from({ length: colonies }, (_, colony) => ({ antId: 100 + colony, x: 5, y: 5 + colony, colony, heading: 0, ageMs: 0 }));
    return f;
  }

  for (const colonies of [2, 4]) it(`draws each ant and corpse of a ${colonies}-colony match from its own colony's frames`, () => {
    const { ants } = atlas(colonies);
    ants.update(frame(colonies));
    const drawn = ants.antLayer.particleChildren as Particle[];
    const corpses = ants.corpseLayer.particleChildren as Particle[];
    const soldierY = 2 * colonies * CELL_H;
    for (let colony = 0; colony < colonies; colony++) {
      const [worker, carrier, soldier] = [0, 1, 2].map((k) => drawn[colony * 3 + k]!.texture.frame);
      expect([worker!.x, worker!.y]).toEqual([CELL_W, colony * CELL_H]);
      expect([carrier!.x, carrier!.y]).toEqual([CELL_W, (colonies + colony) * CELL_H]);
      expect([soldier!.x, soldier!.y]).toEqual([2 * CELL_W, soldierY + colony * 2 * CELL_H]);
      expect([corpses[colony]!.texture.frame.x, corpses[colony]!.texture.frame.y]).toEqual([3 * CELL_W, colony * CELL_H]);
    }
  });
});

/** A four-colony setup on a square test board: one nest and one start box near each corner. */
function fourColonies() {
  const scale = 2, mapW = 64 * scale, mapH = 64 * scale;
  const at = (tx: number, ty: number) => [(tx + 0.5) * 256, (ty + 0.5) * 256] as [number, number];
  const nests = [at(16, 16), at(111, 16), at(16, 111), at(111, 111)];
  const boxes: StreamStartBox[] = [{ x: 4, y: 4, width: 24, height: 24 }, { x: 100, y: 4, width: 24, height: 24 },
    { x: 4, y: 100, width: 24, height: 24 }, { x: 100, y: 100, width: 24, height: 24 }];
  const setup: StreamSetup = { mapW, mapH, gridScale: scale, ticksPerSecond: 10, matchTicks: 1000, idleTicks: 100, overrunRadiusTiles: 2 * scale,
    colonies: 4, queens: nests, startBoxes: boxes, startingQueenIds: [[0], [0], [0], [0]] };
  const queens: StreamQueen[] = nests.map(([x, y], colony) => ({ id: 0, colony, x, y, foundedTick: 0, lostTick: null, overrun: 0 }));
  return { setup, boxes, queens, result: null };
}

describe("start areas", () => {
  it("lists and draws every colony's start box in its colony's colour", () => {
    const { setup } = fourColonies();
    const boxes = visibleStartBoxes(setup);
    expect(boxes.map((b) => b.colony)).toEqual([0, 1, 2, 3]);
    expect(boxes.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(setup.startBoxes);
    const overlay = new StartBoxes2D(10);
    try {
      overlay.update({ board: { setup } });
      expect(overlay.boxes).toEqual(boxes);
      const ins = instructionsOf(overlay.layer);
      // Per box: its fill and coloured edge in its colony's colour, between them the dark edge.
      expect(ins.map((i) => i.action)).toEqual(TINT.flatMap(() => ["fill", "stroke", "stroke"]));
      expect(ins.map((i) => i.data.style.color)).toEqual(TINT.flatMap((c) => [c, 0x080706, c]));
    } finally { overlay.layer.destroy(); }
  });

  it("drops only a malformed box, keeping every other colony's", () => {
    const { setup, boxes } = fourColonies();
    boxes[2]!.width = 0;
    expect(visibleStartBoxes(setup).map((b) => b.colony)).toEqual([0, 1, 3]);
  });
});

describe("queens and nests", () => {
  it("brackets every colony's queen zone and rings its emblem in its colony's colour", () => {
    const board = fourColonies();
    const homes = new QueenHomes(10);
    homes.update({ board: board as never, targetMs: 0, hits: [], lossShown: new Map() }, true);
    expect(homes.zones.map((z) => z.colony)).toEqual([0, 1, 2, 3]);
    const strokes = (g: Graphics) => instructionsOf(g).filter((i) => i.action === "stroke").map((i) => i.data.style.color);
    // Each zone: the dark under-stroke, then its colony's brackets.
    expect(strokes(homes.layer)).toEqual(TINT.flatMap((c) => [0x000000, c]));
    // Each emblem: its disc's ring, in its colony's colour.
    expect(strokes(homes.emblems)).toEqual([...TINT]);
  });
});

describe("opening view", () => {
  const screens = [
    { w: 1280, h: 800, area: { x0: 20, y0: 90, x1: 940, y1: 780 } },
    { w: 390, h: 844, area: { x0: 8, y0: 180, x1: 382, y1: 650 } },
  ];

  it("frames every colony's start box and starting nest at tick zero", () => {
    const board = fourColonies();
    expect(openingPhase(0, board)).toBe(true);
    const bounds = openingBounds(board)!;
    // The four boxes and each nest's ground (max(3 x scale, overrun radius) = 6 fine tiles around its tile).
    expect(bounds).toEqual({ x0: 4, y0: 4, x1: 124, y1: 124 });
    const { setup } = board;
    const inside = (x: number, y: number, a: { x0: number; y0: number; x1: number; y1: number }) =>
      x >= a.x0 - 1e-6 && x <= a.x1 + 1e-6 && y >= a.y0 - 1e-6 && y <= a.y1 + 1e-6;
    for (const screen of screens) {
      const camera = new Camera(setup.mapW, setup.mapH, screen.w, screen.h, screen.area, fightLane(setup), queensBox(setup), 2);
      camera.setFoundingEnvelope(foundingEnvelope(setup));
      camera.setOpeningBounds(bounds);
      for (const q of board.queens) {
        const tx = Math.floor(q.x / 256), ty = Math.floor(q.y / 256), r = 6;
        expect(inside(...camera.toScreen(tx - r, ty - r), screen.area)).toBe(true);
        expect(inside(...camera.toScreen(tx + 1 + r, ty + 1 + r), screen.area)).toBe(true);
      }
      for (const b of board.boxes) {
        expect(inside(...camera.toScreen(b.x, b.y), screen.area)).toBe(true);
        expect(inside(...camera.toScreen(b.x + b.width, b.y + b.height), screen.area)).toBe(true);
      }
    }
  });

  it("is not an opening, and frames nothing, while any colony's box or starting queen is missing", () => {
    const noBox = fourColonies();
    noBox.boxes[3]!.x = -1;
    expect(openingPhase(0, noBox)).toBe(false);
    expect(openingBounds(noBox)).toBeNull();
    const noQueen = fourColonies();
    noQueen.queens.pop();
    expect(openingBounds(noQueen)).toBeNull();
  });
});
