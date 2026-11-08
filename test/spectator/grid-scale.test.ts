import { describe, expect, it } from "vitest";
import { gridScale, physicalTilePx } from "../../web/src/grid-scale.ts";
import { antLengthPx } from "../../web/src/ants.ts";
import { crumbRadiusPx } from "../../web/src/food.ts";
import { Camera, fightLane, queensBox, type Box } from "../../web/src/camera.ts";
import { antTiles, project, viewPose } from "../../web/src/board3d/view.ts";
import { recordingMessages } from "../../web/src/recording.ts";
import { encodeMessage, SUB_TILE } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Ground } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";

/** Every recording plays at grid scale 2: two fine tiles per physical tile edge. */
const SCALE = 2 as const;

describe("recording-owned physical scale", () => {
  // The 64x48 reference board with its queens' physical tiles, and today's grid-scale-2 setup of it.
  const reference = { mapW: 64, mapH: 48, queens: [[8.5 * SUB_TILE, 24.5 * SUB_TILE], [55.5 * SUB_TILE, 24.5 * SUB_TILE]] as [[number, number], [number, number]] };
  const fine = {
    mapW: 64 * SCALE, mapH: 48 * SCALE, gridScale: SCALE,
    queens: reference.queens.map(([x, y]) => [x * SCALE, y * SCALE]) as [[number, number], [number, number]],
  };
  // Physical tiles 8 and 55 across, 24 down; padded by LANE_PAD (10) and QUEENS_PAD (3) physical tiles, within the board.
  const referenceLane: Box = { x0: 0, y0: 14, x1: 64, y1: 35 };
  const referenceQueens: Box = { x0: 5, y0: 21, x1: 59, y1: 28 };
  const fineBox = (box: Box): Box => ({ x0: box.x0 * SCALE, y0: box.y0 * SCALE, x1: box.x1 * SCALE, y1: box.y1 * SCALE });

  it("frames the fight lane and queens on whole physical tiles at grid scale 2", () => {
    expect(fightLane(fine)).toEqual(fineBox(referenceLane));
    expect(queensBox(fine)).toEqual(fineBox(referenceQueens));
  });

  it("keeps the 2D home and whole-board framing of the reference board at grid scale 2", () => {
    const area = { x0: 0, y0: 80, x1: 1200, y1: 700 };
    const before = new Camera(reference.mapW, reference.mapH, 1200, 800, area, referenceLane, referenceQueens);
    const after = new Camera(fine.mapW, fine.mapH, 1200, 800, area, fightLane(fine), queensBox(fine), SCALE);
    for (const view of ["view", "fit"] as const) {
      expect(after[view].ox).toBeCloseTo(before[view].ox);
      expect(after[view].oy).toBeCloseTo(before[view].oy);
      expect(after[view].tilePx * SCALE).toBeCloseTo(before[view].tilePx);
    }
  });

  it("keeps the reference board's 3D default projections and ant size at grid scale 2", () => {
    for (const [w, h] of [[1200, 800], [393, 852]]) {
      const area = { x0: 0, y0: 80, x1: w!, y1: h! - 100 };
      const camera = new Camera(reference.mapW, reference.mapH, w!, h!, area, referenceLane, referenceQueens);
      const fit = { ...camera.view, tilePx: camera.view.tilePx / SCALE };
      for (const name of ["tilted", "top"] as const) {
        const before = viewPose(name, reference.mapW, reference.mapH, w!, h!, camera.view, area, referenceLane, referenceQueens);
        const after = viewPose(name, fine.mapW, fine.mapH, w!, h!, fit, area, fightLane(fine), queensBox(fine), SCALE);
        expect(after.radius).toBeCloseTo(before.radius * SCALE);
        const p = project(before, w!, h!, [17, 0.5, 21])!;
        const q = project(after, w!, h!, [17 * SCALE, 0.5 * SCALE, 21 * SCALE])!;
        expect(q[0]).toBeCloseTo(p[0]); expect(q[1]).toBeCloseTo(p[1]);
      }
      expect(antTiles(camera.view.tilePx / SCALE, SCALE)).toBeCloseTo(antTiles(camera.view.tilePx) * SCALE);
    }
  });

  it("keeps relief and nest geometry in physical units without multiplying mesh density", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const old = new Ground(scene, 64, 48), scaled = new Ground(scene, fine.mapW, fine.mapH, SCALE);
      expect(scaled.mesh.getTotalVertices()).toBe(old.mesh.getTotalVertices());
      for (const [x, y] of [[0, 0], [8.5, 24.5], [31.2, 22.8], [-2, 47]]) {
        expect(scaled.heightAt(x! * SCALE, y! * SCALE)).toBeCloseTo(old.heightAt(x!, y!) * SCALE);
      }
      const tint = [[1, 0.7, 0], [0, 0.7, 1]];
      new Nests(scene, old, reference, 2, tint);
      const oldMound = scene.getMeshByName("mound0")!;
      const oldSize = oldMound.getBoundingInfo().boundingBox.extendSize.clone();
      new Nests(scene, scaled, fine, 2 * SCALE, tint);
      const fineMound = scene.meshes.filter(mesh => mesh.name === "mound0").at(-1)!;
      const fineSize = fineMound.getBoundingInfo().boundingBox.extendSize;
      expect(fineSize.x).toBeCloseTo(oldSize.x * SCALE);
      expect(fineSize.y).toBeCloseTo(oldSize.y * SCALE);
      expect(fineSize.z).toBeCloseTo(oldSize.z * SCALE);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("reads every board at grid scale 2 without mutating recording metadata, whatever its size", () => {
    for (const [mapW, mapH] of [[128, 96], [256, 192]]) {
      const setup = Object.freeze({ mapW: mapW!, mapH: mapH!, gridScale: SCALE });
      expect(gridScale(setup)).toBe(2);
      expect(physicalTilePx(12.5 / SCALE, setup)).toBe(12.5);
      expect(setup.gridScale).toBe(2);
    }
  });

  it("keeps glyph pixel floors and ceilings of the reference tile size at grid scale 2", () => {
    for (const oldTilePx of [0.5, 3, 7, 12.5, 24, 80]) {
      const fineTilePx = oldTilePx / SCALE;
      const physical = physicalTilePx(fineTilePx, { gridScale: SCALE });
      expect(antLengthPx(physical)).toBe(antLengthPx(oldTilePx));
      expect(crumbRadiusPx(physical)).toBe(crumbRadiusPx(oldTilePx));
      // Glyph sizes change interpretation, not the fine-tile position transform.
      const oldPosition = 17.25;
      expect((oldPosition * SCALE) * fineTilePx).toBeCloseTo(oldPosition * oldTilePx);
    }
  });
});

describe("the spectator refuses a recording at any other grid scale", () => {
  const packed = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length, true);
    out.set(bytes, 4);
    return new ReadableStream({ start(controller) { controller.enqueue(out); controller.close(); } });
  };
  const read = async (bytes: Uint8Array) => {
    const messages = [];
    for await (const { message } of recordingMessages(packed(bytes))) messages.push(message);
    return messages;
  };
  const snapshot = (): Uint8Array => {
    const recorder = new SpectatorRecorder(createMatch(42, withGridScale(DEFAULT_CONFIG)));
    const bytes = encodeMessage({ ...recorder.initial(), full: recorder.initialFull() });
    // No events: the final byte is their zero count and the grid-scale byte immediately precedes it.
    expect(bytes.at(-2)).toBe(2);
    return bytes;
  };

  it("plays a grid-scale-2 recording", async () => {
    const [message] = await read(snapshot());
    expect(message!.full!.setup.gridScale).toBe(2);
  });

  it.each([1, 4])("refuses a recording whose setup carries grid scale %i", async (scale) => {
    const bytes = snapshot();
    bytes[bytes.length - 2] = scale;
    await expect(read(bytes)).rejects.toThrow(`grid scale ${scale} no longer plays: every match plays at grid scale 2`);
  });

  it("refuses a recording whose setup carries no grid scale, never reading it as grid scale 1", async () => {
    const bytes = snapshot();
    bytes[bytes.length - 2] = 0;
    await expect(read(bytes)).rejects.toThrow("grid scale missing: every match plays at grid scale 2");
  });
});
