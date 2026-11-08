import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";
import { StartBoxes3D } from "../../web/src/board3d/start-boxes.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { decodeMessage, streamQueens } from "../../src/live/format.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { visibleStartBoxes } from "../../web/src/start-boxes.ts";
import { gridScale } from "../../web/src/grid-scale.ts";
import { StartBoxes2D } from "../../web/src/start-boxes2d.ts";
import { startBoxFixture } from "../../web/capture/start-box-fixtures.ts";
import { START_MAPS } from "../../web/capture/start-boxes.ts";

describe.each(START_MAPS)("finalized %s recording", map => {
  it("roundtrips actual picks/defaults and a normal founding through the codec into delayed playback", () => {
    const fixture = startBoxFixture(map), messages = unpackMessages(fixture.bytes).map(decodeMessage);
    expect(fixture.provenance.picks).toHaveLength(2);
    expect(fixture.provenance.defaultedIdentities).toHaveLength(6);
    expect(fixture.provenance.joins).toBe(0);
    expect(fixture.provenance.pickWindowMs).toBe(120000);
    const first = messages[0]!, full = first.full!;
    expect(full.setup.startingQueenIds).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(streamQueens(full)).toHaveLength(8);
    const playback = new Playback(), frame = new Frame(), boxes = new StartBoxes2D(10);
    const engine = new NullEngine(), scene = new Scene(engine);
    const ground = new Ground(scene, full.setup.mapW, full.setup.mapH, gridScale(full.setup));
    const boxes3d = new StartBoxes3D(scene, ground, COLONY_RGB);
    const nests = new Nests(scene, ground, full.setup, 0.4, COLONY_RGB);
    try {
      playback.push(first, 0); playback.push(messages[1]!, 100);
      playback.sample(250, frame); boxes.update(frame);
      expect(frame.tick).toBe(0);
      expect(boxes.boxes).toEqual(visibleStartBoxes(full.setup));
      expect(streamQueens(frame.board!)).toEqual(streamQueens(full));
      boxes3d.update(frame); nests.update(streamQueens(frame.board!));
      expect(boxes3d.boxes).toEqual(boxes.boxes);
      expect(nests.casters).toHaveLength(8);
      for (const q of streamQueens(full)) {
        const suffix = q.id === 0 ? String(q.colony) : `${q.colony}-${q.id}`;
        const mound = scene.getMeshByName(`mound${suffix}`)!;
        expect(mound.position.x).toBe(q.x / 256);
        expect(mound.position.z).toBe(full.setup.mapH - q.y / 256);
      }
      expect(frame.story.filter(e => e.kind === "queen_founded")).toEqual([]);
      playback.sample(350, frame);
      expect(frame.story.filter(e => e.kind === "queen_founded")).toMatchObject([{ colony: 0, queenId: 4 }]);
      expect(streamQueens(frame.board!)).toHaveLength(9);
      expect(frame.board!.setup.startingQueenIds).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    } finally { boxes.layer.destroy(); scene.dispose(); engine.dispose(); }
  });
});
