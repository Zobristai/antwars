import { describe, expect, it } from "vitest";
import { Texture, type Particle, type Renderer } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { decodeMessage, SUB_TILE, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { BODY_TURN_SPEED_DEGREES_PER_SECOND } from "../../web/src/pivot.ts";
import { Bites, BITE_BODY_REACH, BITE_HEAD_REACH, BITE_BODY_SPEED, headFront } from "../../web/src/bite.ts";
import { Ants } from "../../web/src/ants.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const full = scale2Packets(1).map(decodeMessage)[0]!.full!;
const radians = (degrees: number) => degrees * Math.PI / 180;
const delta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Synthetic event-confirmed victims, not a sliced or reconstructed match18 recording.
 * Every terminal victim has a distinct id and real preceding coordinates. Live
 * victims remain alive, then move out of range for the recovery tail. Moving
 * attackers exercise Pivots' per-ms combat path; stationary ones use Playback.
 */
function messages(bearings: readonly number[], moving = false, live = new Set<number>()): StreamMessage[] {
  const origin = (tick: number) => Math.round((10 + (moving ? tick * 0.015 : 0)) * SUB_TILE);
  const point = (tick: number, bearing: number) => ({
    x: origin(tick + 1) + Math.round(Math.cos(radians(bearing)) * 0.7 * SUB_TILE),
    y: 10 * SUB_TILE + Math.round(Math.sin(radians(bearing)) * 0.7 * SUB_TILE),
  });
  return Array.from({ length: bearings.length + 5 }, (_, tick): StreamMessage => {
    const targets = bearings.flatMap((bearing, i) => {
      const deathTick = i + 1;
      if (deathTick <= tick && !live.has(deathTick)) return [];
      const p = tick > bearings.length ? { x: 50 * SUB_TILE, y: 40 * SUB_TILE } : point(tick, bearing);
      // Face the victim toward its attacker. This puts the 2D head boundary
      // within the existing head cap during contact; a sideways victim need
      // not be reachable merely because the canonical pair is eligible.
      const heading = Math.round((((bearing + 180) % 360 + 360) % 360) / 360 * 256) % 256;
      return [{ id: 100 + deathTick, heading, ...p }];
    });
    const events: StreamMessage["events"] = [];
    if (tick > 0 && tick <= bearings.length) {
      events.push({ kind: "fight", antId: 1, targetId: 100 + tick, colony: 0, tileX: 10, tileY: 10 });
      if (!live.has(tick)) events.push({ kind: "death", antId: 100 + tick, colony: 1, ...point(tick - 1, bearings[tick - 1]!) });
    }
    return { tick, full: tick === 0 ? structuredClone(full) : null, events,
      ants: { count: targets.length + 1, id: Uint32Array.from([1, ...targets.map(p => p.id)]),
        x: Uint16Array.from([origin(tick), ...targets.map(p => p.x)]),
        y: Uint16Array.from([10 * SUB_TILE, ...targets.map(p => p.y)]),
        heading: Uint8Array.from([0, ...targets.map(p => p.heading)]),
        colony: Uint8Array.from([0, ...targets.map(() => 1)]),
        agent: new Int16Array(targets.length + 1).fill(-1), caste: new Uint8Array(targets.length + 1), carrying: new Uint8Array(targets.length + 1) } };
  });
}
function playback(rows: readonly StreamMessage[]): Playback {
  const pb = new Playback();
  for (const m of rows) pb.push(m, m.tick * TICK_MS);
  return pb;
}
function sample(pb: Playback, time: number, frame = new Frame()): Frame {
  expect(pb.sample(time + RENDER_DELAY_MS, frame)).toBe(true);
  return frame;
}

for (const fps of [30, 60]) for (const moving of [false, true]) describe(`${fps}fps ${moving ? "moving pivot" : "stationary"} terminal retargets`, () => {
  it("removes alternating body shaking without hiding final bites in real particles/matrices", () => {
    const rows = messages(Array.from({ length: 40 }, (_, i) => i % 2 ? -20 : 20), moving);
    const original = structuredClone(rows), pb = new Playback(), f = new Frame();
    const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const ants = new Ants(renderer, 10, 10), engine = new NullEngine(), scene = new Scene(engine);
    const ants3d = new Ants3D(scene, new Ground(scene, full.setup.mapW, full.setup.mapH), 0.5, COLONY_RGB);
    const bites = [new Bites(), new Bites()], models = ["2d", "3d"] as const;
    const previous: ({ at: number; rotation: number; x: number; y: number } | undefined)[] = [];
    let next = 0, terminalFrames = 0, contactFrames = 0, maximumSteadyDegrees = 0, maximumRate = 0;
    try {
      for (let k = 0; k <= (rows.length - 1) * TICK_MS * fps / 1000; k++) {
        const at = k * 1000 / fps;
        while (next < rows.length && rows[next]!.tick * TICK_MS <= at + RENDER_DELAY_MS + 1e-7) {
          const m = rows[next++]!; pb.push(m, m.tick * TICK_MS);
        }
        sample(pb, at, f); ants.update(f); ants3d.update(f);
        for (const b of bites) b.update(f);
        const particle = ants.antLayer.particleChildren[0]! as Particle;
        const matrix = (scene.getMeshByName("ants0") as Mesh)._thinInstanceDataStorage.matrixData!;
        const headings = [particle.rotation, -Math.atan2(matrix[2]!, matrix[0]!)];
        const expected = rows[f.tick]!;
        expect(f.x[0]).toBeCloseTo(expected.ants.x[0]! / SUB_TILE + (moving ?
          ((rows[f.tick + 1]?.ants.x[0] ?? expected.ants.x[0]!) - expected.ants.x[0]!) / SUB_TILE * (f.renderMs / TICK_MS - f.tick) : 0), 5);
        expect(f.rotation[0]).toBe(0);
        if (f.tick > 0 && f.tick <= 40) {
          expect(f.engagements.find(p => p.a === 1)).toEqual({ a: 1, b: 100 + f.tick, tick: f.tick, terminalTick: f.tick, caste: 0 });
          terminalFrames++;
        } else expect(f.engagements.some(p => p.a === 1)).toBe(false);
        for (let mi = 0; mi < models.length; mi++) {
          const model = models[mi]!, length = mi === 0 ? 1 : 0.5, b = bites[mi]!;
          const pose = b.pose(0, length, model), position = b.bodyPosition(0, length, model);
          expect(delta(headings[mi]!, f.drawRotation![0]!)).toBeCloseTo(0, 5);
          if (f.tick > 0 && f.tick <= 40) expect(pose).not.toBeNull(); else expect(pose).toBeNull();
          const x = (position?.x ?? f.x[0]!) - f.x[0]!, y = (position?.y ?? f.y[0]!) - f.y[0]!;
          expect(Math.hypot(x, y)).toBeLessThanOrEqual(BITE_BODY_REACH + 1e-8);
          if (pose) {
            expect(Math.hypot(pose.headOffset, pose.headSideOffset)).toBeLessThanOrEqual(BITE_HEAD_REACH + 1e-8);
            if (pose.contacting) {
              contactFrames++;
              const tip = headFront(model, 0) * length + pose.headOffset;
              expect(pose.x + Math.cos(pose.rotation) * tip - Math.sin(pose.rotation) * pose.headSideOffset).toBeCloseTo(pose.contact.x, 5);
              expect(pose.y + Math.sin(pose.rotation) * tip + Math.cos(pose.rotation) * pose.headSideOffset).toBeCloseTo(pose.contact.y, 5);
            }
          }
          const prev = previous[mi];
          if (prev && f.renderMs > prev.at) {
            const dt = f.renderMs - prev.at;
            const rate = Math.abs(delta(prev.rotation, headings[mi]!)) * 180 / Math.PI / dt * 1000;
            maximumRate = Math.max(maximumRate, rate);
            expect(rate).toBeLessThanOrEqual(BODY_TURN_SPEED_DEGREES_PER_SECOND + 0.02);
            expect(Math.hypot(x - prev.x, y - prev.y)).toBeLessThanOrEqual(BITE_BODY_SPEED * dt + 1e-8);
          }
          if (f.renderMs >= 400 && f.renderMs < 4000) {
            maximumSteadyDegrees = Math.max(maximumSteadyDegrees, Math.abs(delta(0, headings[mi]!)) * 180 / Math.PI);
            expect(Math.abs(delta(0, headings[mi]!))).toBeLessThan(0.002);
          }
          previous[mi] = { at: f.renderMs, rotation: headings[mi]!, x, y };
        }
      }
      expect(terminalFrames).toBeGreaterThan(100); expect(contactFrames).toBeGreaterThan(0);
      expect(rows).toEqual(original);
      console.log("synthetic actual renderer terminal chain", { fps, moving, terminalFrames, contactFrames, maximumSteadyDegrees, maximumRate });
    } finally { scene.dispose(); engine.dispose(); }
  });
});

it.each([false, true])("keeps raw two-sample history, unfiltered live turns and continuous recovery (moving=%s)", moving => {
  const rows = messages([0, 40, 40, 0, 0, -40, -40], moving, new Set([4, 5]));
  const pb = playback(rows), f = new Frame();
  // Not a recursively filtered 30-degree aim on the second 40-degree victim.
  sample(pb, 390, f); expect(f.drawRotation![0]).toBeCloseTo(radians(40), 2);
  for (const boundary of [400, 600, 800]) {
    sample(pb, boundary - 0.001, f); const before = f.drawRotation![0]!;
    sample(pb, boundary, f); expect(Math.abs(delta(before, f.drawRotation![0]!))).toBeLessThan(0.0001);
    sample(pb, boundary + 90, f);
    // Apply the selected rate to the same live/terminal targets and recovery.
    const turnDegrees = BODY_TURN_SPEED_DEGREES_PER_SECOND * 90 / 1000;
    const remaining = Math.max(0, 40 - turnDegrees);
    const expected = boundary === 400 ? remaining : boundary === 600 ? -Math.min(40, turnDegrees) : -remaining;
    expect(delta(f.drawRotation![0]!, radians(expected))).toBeCloseTo(0, 2);
    if (boundary === 400) expect(f.engagements.find(p => p.a === 1)?.terminalTick).toBeUndefined();
    if (boundary === 800) expect(f.engagements.some(p => p.a === 1)).toBe(false);
  }
});

it("takes the short mean across angle wrapping and follows current bearing for opposed victims", () => {
  // Keep the wrapped target long enough for the requested slower acquisition;
  // the stable mean is still exactly pi, not a recursively averaged angle.
  const wrapped = playback(messages(Array.from({ length: 20 }, (_, i) => i % 2 ? -170 : 170)));
  expect(Math.abs(delta(sample(wrapped, 1390).drawRotation![0]!, Math.PI))).toBeLessThan(0.002);
  const opposed = playback(messages([0, 180, 0]));
  expect(Math.abs(sample(opposed, 350).drawRotation![0]!)).toBeCloseTo(radians(BODY_TURN_SPEED_DEGREES_PER_SECOND * 50 / 1000));
});

it("forgets terminal history on gaps/reconnects, repeats seeks and holds the newest state", () => {
  // Small bearings isolate target-history reset from the slower rate cap.
  const rows = messages([0, 4, 6, 6]);
  const gap = playback(rows.filter(m => m.tick !== 2));
  expect(delta(sample(gap, 390).drawRotation![0]!, radians(6))).toBeCloseTo(0, 2);
  const pb = playback(rows.slice(0, 3));
  const reconnect = structuredClone(rows[3]!); reconnect.full = structuredClone(full); reconnect.events = [];
  pb.push(reconnect, 300); pb.push(rows[4]!, 400); pb.push(rows[5]!, 500);
  const f = sample(pb, 490); expect(delta(f.drawRotation![0]!, radians(6))).toBeCloseTo(0, 2);
  const seek = playback(messages([0, 40, -40, 40]));
  const first = sample(seek, 235).drawRotation![0]; sample(seek, 270); expect(sample(seek, 235).drawRotation![0]).toBe(first);
  const held = sample(pb, 500).drawRotation![0]; expect(sample(pb, 1500).drawRotation![0]).toBe(held);
});
