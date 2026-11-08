/** Starting identities survive delayed full/reconnect frames; founding time is not a discriminator. */
import { expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";
import { QueenHomes } from "../../web/src/effects.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { NEW_MATCH_GRID_SCALE } from "../../src/sim/gridScale.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { decodeMessage, encodeMessage, streamQueens, type StreamQueen } from "../../src/live/format.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { isStartingQueen, type StartLayout } from "../../web/src/start-boxes.ts";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: the reference layout below is in fine tiles.
const S = NEW_MATCH_GRID_SCALE;

function fixture() {
  const recorder = new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG)));
  const decoded = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
  const full = decoded.full!, ants = decoded.ants;
  // Non-sequential synthetic identities exercise membership beyond contiguous generated defaults.
  // Roundtrip the complete fixture below through the landed start-layout codec.
  const ids: StartLayout = { startingQueenIds: [[0, 3, 8], [0, 4, 8]],
    startBoxes: [{ x: 2 * S, y: 12 * S, width: 12 * S, height: 24 * S }, { x: 50 * S, y: 12 * S, width: 12 * S, height: 24 * S }] };
  full.setup = { ...full.setup, ...ids };
  full.queens = ([0, 1] as const).flatMap(colony => ids.startingQueenIds![colony].map((id, i): StreamQueen => ({
    id, colony, x: ((3 + 3 * i + 48 * colony) * S + 0.5) * 256, y: ((12 + i) * S + 0.5) * 256,
    foundedTick: 0, lostTick: null, overrun: 0,
  })));
  const message = decodeMessage(encodeMessage({ tick: 0, full, ants, events: [] }));
  return { full: message.full!, ants: message.ants };
}

it("uses colony-scoped immutable membership, with id-zero fallback only for legacy streams", () => {
  const setup = { mapW: 64, startingQueenIds: [[3], [4]] as [number[], number[]] };
  expect(isStartingQueen(setup, { colony: 0, id: 3 })).toBe(true);
  expect(isStartingQueen(setup, { colony: 1, id: 3 })).toBe(false);
  expect(isStartingQueen(setup, { colony: 0, id: 0 })).toBe(false);
  expect(isStartingQueen({ mapW: 64 }, { colony: 0, id: 0 })).toBe(true);
  expect(isStartingQueen({ mapW: 64 }, { colony: 0, id: 3 })).toBe(false);
});

it("shows every starting nest from the first shown frame with no founding entries", () => {
  const { full, ants } = fixture(), playback = new Playback(), frame = new Frame();
  playback.push({ tick: 0, full, ants, events: [] }, 0);
  expect(playback.sample(250, frame)).toBe(true);
  expect(streamQueens(frame.board!)).toEqual(full.queens);
  expect(frame.story.filter(e => e.kind === "queen_founded")).toEqual([]);
});

it("delays a real founding on tick zero, without confusing it with six starting queens", () => {
  const { full, ants } = fixture(), playback = new Playback(), frame = new Frame();
  const founded: StreamQueen = { ...full.queens![0]!, id: 9, x: 20.5 * 256, foundedTick: 0 };
  playback.push({ tick: 0, full, ants, events: [] }, 0);
  playback.push({ tick: 1, full: null, ants, events: [{ kind: "queenFounded", queen: founded }] }, 100);
  playback.sample(250, frame);
  expect(streamQueens(frame.board!)).toHaveLength(6);
  expect(frame.story.filter(e => e.kind === "queen_founded")).toEqual([]);
  playback.sample(350, frame);
  expect(streamQueens(frame.board!)).toHaveLength(7);
  expect(frame.story.filter(e => e.kind === "queen_founded")).toMatchObject([{ colony: 0, queenId: 9, tick: 1 }]);
});

it("reconnects with lost starting queens without inventing founding, while retaining real history", () => {
  const { full, ants } = fixture(), playback = new Playback(), frame = new Frame();
  full.queens![1] = { ...full.queens![1]!, lostTick: 2 };
  full.queens!.push({ ...full.queens![0]!, id: 9, foundedTick: 1 });
  playback.push({ tick: 4, full, ants, events: [] }, 0);
  playback.sample(250, frame);
  expect(frame.story.filter(e => e.kind === "queen_founded")).toMatchObject([{ colony: 0, queenId: 9 }]);
  expect(frame.story.filter(e => e.kind === "queen_lost")).toMatchObject([{ colony: 0, queenId: 3 }]);
  playback.push({ tick: 5, full: structuredClone(full), ants, events: [] }, 100);
  playback.sample(350, frame);
  expect(frame.story.filter(e => e.kind === "queen_founded")).toHaveLength(1);
});

it("places every nest at its finalized coordinates before drawing, moving keyed legacy anchors without rescaling offsets", () => {
  const { full, ants } = fixture(), engine = new NullEngine(), scene = new Scene(engine);
  try {
    const ground = new Ground(scene, full.setup.mapW, full.setup.mapH);
    const nests = new Nests(scene, ground, full.setup, 0.4, COLONY_RGB);
    const originalQueen = scene.getMeshByName("queen0")!, originalMound = scene.getMeshByName("mound0")!;
    const queenOffset = originalQueen.position.subtract(originalMound.position);
    nests.update(full.queens!);
    expect(scene.getMeshByName("queen0")).toBe(originalQueen);
    expect(nests.casters).toHaveLength(6);
    for (const q of full.queens!) {
      const suffix = q.id === 0 ? String(q.colony) : `${q.colony}-${q.id}`;
      const mound = scene.getMeshByName(`mound${suffix}`)!;
      expect(mound.position.x).toBe(q.x / 256);
      expect(mound.position.z).toBe(full.setup.mapH - q.y / 256);
      expect(mound.position.y).toBeCloseTo(ground.heightAt(q.x / 256, q.y / 256) - 0.05);
      expect(mound.computeWorldMatrix(true).getTranslation().x).toBeCloseTo(q.x / 256);
    }
    originalQueen.position.subtract(originalMound.position).asArray().forEach((value, axis) => expect(value).toBeCloseTo(queenOffset.asArray()[axis]!, 10));
    const previousPosition = originalQueen.position.clone();
    nests.update(full.queens!);
    expect(originalQueen.position.asArray()).toEqual(previousPosition.asArray());
    const shifted = full.queens!.map(q => q.id === 0 && q.colony === 0 ? { ...q, x: q.x + 256, y: q.y + 256 } : q);
    nests.update(shifted);
    expect(originalQueen.position.x).toBe(previousPosition.x + 1);
    expect(originalQueen.position.z).toBe(previousPosition.z - 1);
    originalQueen.position.subtract(originalMound.position).asArray().forEach((value, axis) => expect(value).toBeCloseTo(queenOffset.asArray()[axis]!, 10));
    const playback = new Playback(), frame = new Frame(), homes = new QueenHomes(10);
    playback.push({ tick: 0, full, ants, events: [] }, 0); playback.sample(250, frame); homes.update(frame);
    expect(homes.zones).toHaveLength(6);
    for (const [index, q] of full.queens!.entries()) {
      const zone = homes.zones[index]!;
      expect((zone.x0 + zone.x1) / 2).toBe(q.x / 256);
      expect((zone.y0 + zone.y1) / 2).toBe(q.y / 256);
    }
    homes.layer.destroy(); homes.emblems.destroy();
  } finally { scene.dispose(); engine.dispose(); }
});

it("preserves old streams' id-zero starting queen and nonzero founding at tick zero", () => {
  const recorder = new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG)));
  const full = recorder.initialFull(), playback = new Playback(), frame = new Frame();
  full.queens = [...streamQueens(full), { ...streamQueens(full)[0]!, id: 1, foundedTick: 0 }];
  playback.push({ tick: 1, full, ants: recorder.initial().ants, events: [] }, 0);
  playback.sample(250, frame);
  expect(frame.story.filter(e => e.kind === "queen_founded")).toMatchObject([{ colony: 0, queenId: 1 }]);
});
