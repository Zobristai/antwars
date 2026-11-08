/** Stream-owned bite reach, with the existing visual clock and geometry. */
import { describe, expect, it } from "vitest";
import { Texture, type Particle, type Renderer } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { decodeMessage, encodeMessage, SUB_TILE, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { adjacentWithSlack, Bites, EngagementTracker, renderedBiteContacts } from "../../web/src/bite.ts";
import { gridScale } from "../../web/src/grid-scale.ts";
import { Ants } from "../../web/src/ants.ts";
import { Battles } from "../../web/src/effects.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { Battles3D } from "../../web/src/board3d/effects3d.ts";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const initial = decodeMessage(scale2Packets(1)[0]!).full!;
// Every match plays at grid scale 2: scale 1, 4 and unmarked streams no longer play.
type Scale = 2;
const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;

function message(tick: number, scale: Scale, distance: number, options: { diagonal?: boolean; drift?: number; fight?: boolean; full?: boolean } = {}): StreamMessage {
  const full = tick === 0 || options.full ? structuredClone(initial) : null;
  if (full) {
    full.setup.gridScale = scale;
  }
  const x = 10.5 + (options.drift ?? 0), y = 10.5;
  return decodeMessage(encodeMessage({ tick, full,
    ants: { count: 2, id: Uint32Array.of(1, 2),
      x: Uint16Array.of(Math.round(x * SUB_TILE), Math.round((x + distance) * SUB_TILE)),
      y: Uint16Array.of(y * SUB_TILE, Math.round((y + (options.diagonal ? distance : 0)) * SUB_TILE)),
      heading: Uint8Array.of(128, 0), colony: Uint8Array.of(0, 1),
      agent: Int16Array.of(-1, -1), caste: Uint8Array.of(1, 1), carrying: Uint8Array.of(0, 0) },
    events: options.fight ? [
      { kind: "fight", antId: 1, targetId: 2, colony: 0, tileX: 10, tileY: 10 },
      { kind: "fight", antId: 2, targetId: 1, colony: 1, tileX: 10, tileY: 10 },
    ] : [],
  }));
}

function playback(scale: Scale, distance: number | ((tick: number) => number), options: { diagonal?: boolean; moving?: boolean; fight?: boolean } = {}): Playback {
  const pb = new Playback();
  for (let tick = 0; tick <= 12; tick++) pb.push(message(tick, scale, typeof distance === "number" ? distance : distance(tick), {
    diagonal: options.diagonal, drift: options.moving ? tick * 0.02 : 0,
    fight: tick === 1 && options.fight !== false,
  }), tick * TICK_MS);
  return pb;
}
const sample = (pb: Playback, ms: number) => {
  const frame = new Frame(); expect(pb.sample(ms + RENDER_DELAY_MS, frame)).toBe(true); return frame;
};
const pairs = [{ a: 1, b: 2, tick: 1 }, { a: 2, b: 1, tick: 1 }];

describe("match-owned Chebyshev bite eligibility", () => {
  it.each([2] as const)("keeps one raw rounding unit at scale %i, not a whole extra tile", (scale) => {
    const a = 10.5 * SUB_TILE;
    expect(adjacentWithSlack(a, a, a + scale * SUB_TILE, a + scale * SUB_TILE, scale)).toBe(true);
    expect(adjacentWithSlack(a, a, a + (scale + 1) * SUB_TILE, a, scale)).toBe(false);
    // At a tile boundary either rounded coordinate may belong to its neighbour.
    const edge = 10 * SUB_TILE;
    expect(adjacentWithSlack(edge, edge, edge + (scale + 1) * SUB_TILE, edge, scale)).toBe(true);
    expect(adjacentWithSlack(edge, edge, edge + (scale + 1) * SUB_TILE + 2, edge, scale)).toBe(false);
  });

  it.each([2] as const)("retains only confirmed pairs within scale %i and forgets them on separation/gaps", (scale) => {
    const tracker = new EngagementTracker();
    tracker.observe(message(0, scale, scale), scale);
    expect(tracker.observe(message(1, scale, scale, { fight: true }), scale)).toEqual(pairs);
    expect(tracker.observe(message(2, scale, scale), scale)).toEqual(pairs);
    expect(tracker.observe(message(3, scale, scale + 1), scale)).toEqual([]);
    expect(tracker.observe(message(4, scale, scale), scale)).toEqual([]);
    expect(tracker.observe(message(5, scale, scale, { fight: true }), scale)).toHaveLength(2);
    expect(tracker.observe(message(7, scale, scale), scale)).toEqual([]);
    expect(tracker.observe(message(8, scale, scale, { fight: true }), scale)).toHaveLength(2);
    expect(tracker.observe(message(9, scale, scale, { full: true }), scale)).toEqual([]);
  });

  it.each([
    [2, 1], [2, 2],
  ] as const)("wires encoded setup scale %s through playback, pivots and both bite models at %i fine tiles", (scale, distance) => {
    const pb = playback(scale, distance);
    const f = sample(pb, 550);
    expect(gridScale(f.board!.setup)).toBe(scale);
    expect(f.engagements).toEqual(pairs);
    // The target is right of an initially left-facing ant: combat, not travel, owns facing.
    expect(f.rotation[0]).toBeCloseTo(Math.PI);
    expect(f.drawRotation![0]).toBeCloseTo(0, 6);
    for (const model of ["2d", "3d"] as const) {
      const b = new Bites(); b.update(f);
      const pose = b.pose(0, scale, model)!;
      expect(pose).not.toBeNull(); expect(pose.jawOpen).toBe(1);
      expect(pose.rotation).toBeCloseTo(0, 6);
    }
  });

  it.each([2] as const)("rejects out-of-range fights and never infers a target without an event at scale %s", (scale) => {
    const reach = scale;
    for (const pb of [playback(scale, reach + 1), playback(scale, reach, { fight: false })]) {
      const f = sample(pb, 550), b = new Bites(); b.update(f);
      expect(f.engagements).toEqual([]); expect(b.pose(0, reach)).toBeNull();
      expect(f.drawRotation![0]).toBeCloseTo(Math.PI);
    }
    // The renderer independently rejects a stale or externally supplied out-of-reach pair.
    const f = sample(playback(scale, reach + 1), 550); f.engagements = pairs;
    const b = new Bites(); b.update(f);
    expect(b.pose(0, reach, "2d")).toBeNull(); expect(b.pose(0, reach, "3d")).toBeNull();
  });

  it.each([2] as const)("includes diagonals at scale %i without changing canonical positions", (scale) => {
    const f = sample(playback(scale, scale, { diagonal: true }), 550);
    expect(f.engagements).toEqual(pairs);
    const before = [Array.from(f.x), Array.from(f.y), Array.from(f.rotation)];
    for (const model of ["2d", "3d"] as const) {
      const b = new Bites(); b.update(f); expect(b.pose(0, scale, model)).not.toBeNull();
    }
    expect([Array.from(f.x), Array.from(f.y), Array.from(f.rotation)]).toEqual(before);
  });

  it("keeps moving in-range combat canonically anchored through the constant-cell pivot path", () => {
    const pb = playback(2, 2, { moving: true });
    for (const ms of [533, 550, 583]) {
      const f = sample(pb, ms);
      expect(f.engagements).toEqual(pairs);
      expect(f.drawX![0]).toBeCloseTo(f.x[0]!, 5);
      expect(f.drawY![0]).toBeCloseTo(f.y[0]!, 5);
      expect(f.drawRotation![0]).toBeCloseTo(0, 6);
    }
  });

  it("stops interpolated biting at the real boundary and resumes travel facing", () => {
    const pb = playback(2, tick => tick <= 5 ? 2 : 3);
    const inside = sample(pb, 533), outside = sample(pb, 583);
    // Both sample tick 5's confirmed pair; only the interpolated distance changes.
    expect(inside.engagements).toEqual(pairs); expect(outside.engagements).toEqual(pairs);
    const b = new Bites(); b.update(inside); expect(b.pose(0, 1)).not.toBeNull();
    b.update(outside); expect(b.pose(0, 1)).toBeNull();
    expect(inside.drawRotation![0]).toBeCloseTo(0, 6);
    expect(outside.drawRotation![0]).toBeGreaterThan(0.2);
    expect(sample(pb, 650).engagements).toEqual([]);
  });
});

describe("unchanged jaws and physical contact sparks", () => {
  it.each([[2, 1], [2, 2]] as const)("renders both boards at scale %i, distance %i, on the existing open/contact phases", (scale, distance) => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const ground = new Ground(scene, initial.setup.mapW, initial.setup.mapH, scale);
    const ants2d = new Ants(renderer, 6.5 * scale, 10), battles2d = new Battles(renderer, 10);
    const ants3d = new Ants3D(scene, ground, 0.5 * scale, COLONY_RGB), battles3d = new Battles3D(scene, ground);
    const pb = playback(scale, distance);
    try {
      const open = sample(pb, 550);
      ants2d.update(open); battles2d.update(open);
      expect((ants2d.antLayer.particleChildren[open.count]! as Particle).alpha).toBe(1);
      expect(battles2d.layer.particleChildren).toHaveLength(0);
      ants3d.update(open); battles3d.update(open);
      const soldiers = scene.getMeshByName("soldiers0") as Mesh;
      expect(soldiers.getVertexBuffer("aBite")!.getFloatData(soldiers.thinInstanceCount, true)![0]).toBe(1);
      expect((scene.getMeshByName("fight-sparks") as Mesh).thinInstanceCount).toBe(0);

      const contact = sample(pb, 650);
      ants2d.update(contact); battles2d.update(contact);
      expect(battles2d.layer.particleChildren).toHaveLength(1);
      expect(renderedBiteContacts(contact)).toEqual([{ x: 10.5 + distance / 2, y: 10.5 }]);
      expect(battles2d.layer.blendMode).toBe("normal");
      ants3d.update(contact); battles3d.update(contact);
      expect(soldiers.getVertexBuffer("aBite")!.getFloatData(soldiers.thinInstanceCount, true)![0]).toBe(0);
      expect((scene.getMeshByName("fight-sparks") as Mesh).thinInstanceCount).toBe(1);
      expect(renderedBiteContacts(contact)).toEqual([{ x: 10.5 + distance / 2, y: 10.5 }]);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
