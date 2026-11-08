import { describe, expect, it } from "vitest";
import { Texture, type Particle, type Renderer } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { decodeMessage, SUB_TILE, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { RECORD_CONFIG, playScripted, recordLog } from "../../src/live/record.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { BODY_TURN_SPEED_DEGREES_PER_SECOND } from "../../web/src/pivot.ts";
import { Bites, BITE_MS, BITE_CONTACT_MS, BITE_BODY_REACH, BITE_HEAD_REACH, BITE_BODY_SPEED, headFront, type BiteModel, type BitePose } from "../../web/src/bite.ts";
import { Ants } from "../../web/src/ants.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";

// The bundled recording is deleted: the eventful scripted grid-scale-2 battle the bite capture plays
// (web/capture/bites.ts), recorded in process.
const recording = recordLog(playScripted({ seed: 6006, config: RECORD_CONFIG, agents: 10, ticks: 1800, attack: true }).lines, 1800).map(decodeMessage);
const delta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const headPoint = (p: BitePose, model: BiteModel, caste = 0, length = 1) => ({
  x: p.x + Math.cos(p.rotation) * (headFront(model, caste) * length + p.headOffset) - Math.sin(p.rotation) * p.headSideOffset,
  y: p.y + Math.sin(p.rotation) * (headFront(model, caste) * length + p.headOffset) + Math.cos(p.rotation) * p.headSideOffset,
});
interface DrawSample { rotation: number; biting: boolean; target: number | undefined; offsetX: number; offsetY: number; at: number }
const drawnFacing = (bites: Bites, frame: Frame, i: number, model: BiteModel) =>
  bites.pose(i, frame.caste[i] ? 2 : 1, model)?.rotation ?? frame.drawRotation?.[i] ?? frame.rotation[i]!;

function message(tick: number, options: { fight?: number; far?: boolean; heading?: number; full?: boolean; rate?: number } = {}): StreamMessage {
  const full = options.full ? structuredClone(recording[0]!.full!) : null;
  if (full) full.setup.ticksPerSecond = options.rate ?? 10;
  return { tick, full, ants: { count: 3, id: Uint32Array.of(1, 2, 3),
    x: Uint16Array.from([2, options.far ? 8 : 3, options.far ? 8 : 2].map((x) => x * SUB_TILE)),
    y: Uint16Array.from([2, options.far ? 8 : 2, options.far ? 9 : 3].map((y) => y * SUB_TILE)),
    heading: new Uint8Array(3).fill(options.heading ?? 128), colony: Uint8Array.of(0, 1, 1), agent: new Int16Array(3).fill(-1),
    caste: new Uint8Array(3), carrying: new Uint8Array(3) },
    events: options.fight ? [{ kind: "fight", antId: 1, targetId: options.fight, colony: 0, tileX: 2, tileY: 2 }] : [] };
}
function shortPlayback(attackerHeading = 128): Playback {
  const pb = new Playback();
  for (let tick = 0; tick <= 15; tick++) {
    const m = message(tick, { full: tick === 0, fight: tick === 2 ? 2 : tick === 6 ? 3 : undefined, far: tick >= 8 });
    m.ants.heading[0] = attackerHeading;
    pb.push(m, tick * TICK_MS);
  }
  return pb;
}
function at(pb: Playback, ms: number, frame = new Frame()): Frame {
  expect(pb.sample(ms + RENDER_DELAY_MS, frame)).toBe(true); return frame;
}

describe.each([30, 60])("scripted battle replay at %s fps", (fps) => {
  it("bounds actual 2D/3D drawn facing across bite entry, retargeting and exit", () => {
    const pb = new Playback(), frame = new Frame();
    const models = ["2d", "3d"] as const;
    const bites = models.map(() => new Bites());
    const previous = models.map(() => new Map<number, DrawSample>());
    const stats = models.map(() => ({ starts: 0, ends: 0, retargets: 0, maximumDegrees: 0 }));
    let next = 0;
    for (let k = 0; k <= (recording.length - 1) * TICK_MS * fps / 1000; k++) {
      const now = Math.round(k * 1000 / fps);
      while (next < recording.length && next * TICK_MS <= now) {
        pb.push(recording[next]!, next * TICK_MS); next++;
      }
      pb.sample(now, frame);
      const targets = new Map(frame.engagements.map((p) => [p.a, p.b]));
      for (let m = 0; m < models.length; m++) {
        const model = models[m]!, b = bites[m]!, last = previous[m]!, stat = stats[m]!;
        b.update(frame);
        const current = new Map<number, DrawSample>();
        for (let i = 0; i < frame.count; i++) {
          const id = frame.id[i]!, pose = b.pose(i, frame.caste[i] ? 2 : 1, model);
          const position = b.bodyPosition(i, frame.caste[i] ? 2 : 1, model);
          const offsetX = (position?.x ?? frame.x[i]!) - frame.x[i]!, offsetY = (position?.y ?? frame.y[i]!) - frame.y[i]!;
          const sample = { rotation: drawnFacing(b, frame, i, model), biting: pose !== null, target: targets.get(id), offsetX, offsetY, at: frame.renderMs };
          const prev = last.get(id);
          if (position) {
            expect(Math.hypot(offsetX, offsetY)).toBeLessThanOrEqual(BITE_BODY_REACH + 1e-8);
            if (prev) expect(Math.hypot(offsetX - prev.offsetX, offsetY - prev.offsetY)).toBeLessThanOrEqual(BITE_BODY_SPEED * (sample.at - prev.at) + 1e-8);
          }
          if (pose) expect(Math.hypot(pose.headOffset, pose.headSideOffset)).toBeLessThanOrEqual(BITE_HEAD_REACH + 1e-8);
          if (prev && prev.biting !== sample.biting) {
            if (sample.biting) stat.starts++; else stat.ends++;
          }
          if (prev && (prev.biting || sample.biting)) {
            const degrees = Math.abs(delta(prev.rotation, sample.rotation)) * 180 / Math.PI;
            stat.maximumDegrees = Math.max(stat.maximumDegrees, degrees);
            expect(degrees, `${model} ant ${id}, playback ${frame.renderMs} ms`).toBeLessThanOrEqual(
              BODY_TURN_SPEED_DEGREES_PER_SECOND * (sample.at - prev.at) / 1000 + 0.0001);
          }
          if (prev?.biting && sample.biting && prev.target !== sample.target) stat.retargets++;
          current.set(id, sample);
        }
        previous[m] = current;
      }
    }
    for (const stat of stats) { expect(stat.starts).toBeGreaterThan(100); expect(stat.ends).toBeGreaterThan(100); }
    expect(stats[0]).toEqual(stats[1]);
    console.log(`scripted battle ${fps} fps facing`, stats[0]);
  }, 60_000);
});

describe("combat-only delayed facing", () => {
  it("keeps canonical heading interpolation unchanged while stationary drawn facing is capped too", () => {
    for (const headings of [[128, 0], [250, 6]]) {
      const pb = new Playback();
      pb.push(message(0, { full: true, heading: headings[0] }), 0);
      pb.push(message(1, { heading: headings[1] }), 100);
      for (const ms of [0, 17, 33, 50, 67, 100]) {
        const f = at(pb, ms), expected = headings[0]! / 256 * 2 * Math.PI + delta(headings[0]! / 256 * 2 * Math.PI, headings[1]! / 256 * 2 * Math.PI) * ms / 100;
        expect(delta(expected, f.rotation[0]!)).toBeCloseTo(0, 6);
        // A stationary body's desired heading changes at the recorded tick;
        // canonical interpolation is not an escape from the drawn-body cap.
        expect(f.drawRotation![0]).toBeCloseTo(headings[0]! / 256 * 2 * Math.PI, 6);
      }
    }
  });
  it("turns on the shortest arc, follows retargets, and ends recovery when travel facing is reached", () => {
    const pb = shortPlayback(), f = new Frame(); let prev: number | undefined;
    for (let ms = 100; ms <= 1400; ms += 10) {
      at(pb, ms, f);
      if (prev !== undefined) expect(Math.abs(delta(prev, f.drawRotation![0]!))).toBeLessThanOrEqual(
        BODY_TURN_SPEED_DEGREES_PER_SECOND * Math.PI / 180 * 0.01 + 1e-6);
      if (ms === 200) expect(f.drawRotation![0]).toBeCloseTo(Math.PI);
      if (ms === 300) expect(f.drawRotation![0]).toBeCloseTo(7 * Math.PI / 10);
      if (ms === 400) expect(f.drawRotation![0]).toBeCloseTo(2 * Math.PI / 5);
      if (ms >= 1200) expect(delta(f.drawRotation![0]!, f.rotation[0]!)).toBeCloseTo(0, 6);
      prev = f.drawRotation![0];
    }
  });
  it("takes the short combat arc across zero rather than turning the long way around", () => {
    const pb = new Playback();
    pb.push(message(0, { full: true, heading: 255 }), 0);
    pb.push(message(1, { fight: 2, heading: 255 }), 100);
    pb.push(message(2, { heading: 255 }), 200);
    const start = at(pb, 100).drawRotation![0]!, end = at(pb, 120).drawRotation![0]!;
    expect(delta(start, end)).toBeCloseTo(2 * Math.PI / 256);
    expect(delta(end, 0)).toBeCloseTo(0);
  });
  it("samples deterministically, holds on underrun, and clears old facing and biting on reconnect/gaps", () => {
    const pb = shortPlayback(), f = at(pb, 235), first = f.drawRotation![0];
    at(pb, 270, f); at(pb, 235, f); expect(f.drawRotation![0]).toBe(first);
    const bits = new Bites(); bits.update(f); const pose = bits.pose(0, 1);
    at(pb, 235, f); bits.update(f); expect(bits.pose(0, 1)).toEqual(pose);
    at(pb, 1500, f); const held = f.drawRotation![0]; at(pb, 2500, f); expect(f.drawRotation![0]).toBe(held); expect(f.renderMs).toBe(1500);
    pb.push(message(16, { full: true, heading: 32 }), 1600);
    at(pb, 1600, f);
    // Drawn facing retains Float64 precision; canonical heading stays Float32.
    expect(f.drawRotation![0]).toBe(Math.PI / 4); expect(f.rotation[0]).toBe(Math.fround(Math.PI / 4));
    expect(f.engagements).toEqual([]);
    pb.push(message(17, { fight: 2, heading: 32 }), 1700);
    pb.push(message(19, { heading: 128 }), 1900);
    at(pb, 1900, f); expect(f.drawRotation![0]).toBeCloseTo(Math.PI / 4); expect(f.engagements).toEqual([]);
  });
  it.each(["2d", "3d"] as const)("keeps %s head contact exact while facing is still turning", (model) => {
    // Start 99.84375 degrees off target: at the selected 540 degrees/s,
    // 175 ms leaves 5.34375 degrees while the head remains reachable.
    const pb = shortPlayback(71), f = at(pb, BITE_MS + BITE_CONTACT_MS - 25), b = new Bites(); b.update(f);
    const pose = b.pose(0, 1, model)!;
    expect(pose.rotation).toBeCloseTo(19 * Math.PI / 640, 6);
    expect(pose.contacting).toBe(true); expect(pose.rotation).toBe(f.drawRotation![0]);
    expect(headPoint(pose, model).x).toBeCloseTo(pose.contact.x);
    expect(headPoint(pose, model).y).toBeCloseTo(pose.contact.y);
  });
});

describe.each(["2d", "3d"] as const)("%s visual chomp clock", (model) => {
  it.each([5, 10, 20])("draws four cycles per second at a %s Hz setup, with two fully-open 30 fps frames per cycle", (rate) => {
    const pb = new Playback();
    for (let tick = 0; tick <= 20; tick++) pb.push(message(tick, { full: tick === 0, fight: tick === 1 ? 2 : undefined, rate }), tick * TICK_MS);
    const f = new Frame(), b = new Bites(), runs = new Map<number, number>(); let cycles = 0, previousOpen = false, consecutive = 0;
    for (let k = 0; k < 30; k++) {
      const ms = BITE_MS + Math.round(k * 1000 / 30); at(pb, ms, f); b.update(f);
      const pose = b.pose(0, 1, model)!; expect(pose).not.toBeNull();
      const open = pose.jawOpen === 1, cycle = Math.floor(ms / BITE_MS);
      if (open && !previousOpen) cycles++;
      consecutive = open ? consecutive + 1 : 0;
      if (open) runs.set(cycle, Math.max(runs.get(cycle) ?? 0, consecutive));
      previousOpen = open;
    }
    expect(cycles).toBe(4); expect([...runs.values()]).toHaveLength(4);
    for (const frames of runs.values()) expect(frames).toBeGreaterThanOrEqual(2);
  });
  it("keeps reciprocal heads in phase even when their confirmed engagements started on different ticks", () => {
    const f = at(shortPlayback(0), 400), b = new Bites();
    f.engagements = [{ a: 1, b: 2, tick: 2 }, { a: 2, b: 1, tick: 3 }];
    b.update(f);
    const poses = [b.pose(0, 1, model)!, b.pose(1, 1, model)!];
    for (const pose of poses) {
      expect(pose.contacting).toBe(true);
      expect(headPoint(pose, model).x).toBeCloseTo(pose.contact.x);
      expect(headPoint(pose, model).y).toBeCloseTo(pose.contact.y);
    }
    expect(poses[0]!.contact).toEqual(poses[1]!.contact);
  });
  it("preserves the chomp phase on retarget and stops immediately when the confirmed pair ends", () => {
    const pb = shortPlayback(), f = at(pb, 600), b = new Bites(); b.update(f);
    expect(f.engagements[0]?.b).toBe(3);
    expect(b.pose(0, 1, model)!.jawOpen).toBe(1); // Shared clock at 100 ms: still open, not a restarted cycle.
    at(pb, 625, f); b.update(f); expect(b.pose(0, 1, model)!.jawOpen).toBe(0);
    at(pb, 800, f); b.update(f); expect(b.pose(0, 1, model)).toBeNull();
  });
});

describe.each(["2d", "3d"] as const)("%s capped bite geometry", (model) => {
  // Approved definition: the gap runs from the resting DRAWN HEAD to the
  // solved target boundary, accounting for model size. The head's 0.15 tile
  // is measured from the LEANED body, not added to an uncapped body anchor.
  function fixture(gap: number): Frame {
    const f = new Frame(); f.ensure(2); f.count = 2; f.tick = 1; f.renderMs = BITE_CONTACT_MS;
    f.id.set([1, 2]); f.x.set([2, 2 + gap]); f.y.set([2, 2]); f.alpha.fill(1); f.colony.set([0, 1]);
    f.engagements = [{ a: 1, b: 2, tick: 0 }]; return f;
  }
  it.each([0, 0.1, 0.3, 0.449, 0.45, 0.7, 1.5])("closes a reachable %s tile gap exactly, otherwise stops at both caps", (gap) => {
    const f = fixture(gap), b = new Bites(); b.update(f); const p = b.pose(0, 1, model)!;
    const lean = Math.hypot(p.x - f.x[0]!, p.y - f.y[0]!), extension = Math.hypot(p.headOffset, p.headSideOffset);
    expect(p.gap).toBeCloseTo(gap, 6); expect(lean).toBeLessThanOrEqual(0.3 + 1e-9); expect(extension).toBeLessThanOrEqual(0.15 + 1e-9);
    const head = headPoint(p, model), shortfall = Math.hypot(head.x - p.contact.x, head.y - p.contact.y);
    if (gap <= 0.45) { expect(shortfall).toBeLessThan(1e-6); expect(p.contacting).toBe(true); }
    else { expect(lean).toBeCloseTo(0.3); expect(extension).toBeCloseTo(0.15); expect(shortfall).toBeCloseTo(p.gap - 0.45); expect(p.contacting).toBe(false); }
  });
  it("eases entry, retargeting and walking recovery without inventing bites; holds and seeks reset safely", () => {
    const pb = shortPlayback(), b = new Bites(), f = new Frame(); let lastX = 0, lastY = 0;
    for (let ms = 190; ms <= 1100; ms += 10) {
      at(pb, ms, f); b.update(f);
      const pose = b.pose(0, 1, model), body = b.bodyPosition(0, 1, model);
      const x = (body?.x ?? f.x[0]!) - f.x[0]!, y = (body?.y ?? f.y[0]!) - f.y[0]!;
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(Math.hypot(x - lastX, y - lastY)).toBeLessThanOrEqual(BITE_BODY_SPEED * 10 + 1e-9);
      if (ms === 200) expect(Math.hypot(x, y)).toBe(0);
      if (ms >= 800) expect(pose).toBeNull();
      if (ms >= 1000) expect(Math.hypot(x, y)).toBe(0);
      const held = structuredClone(body ?? { x: f.x[0]!, y: f.y[0]! }); b.update(f);
      expect(b.bodyPosition(0, 1, model) ?? { x: f.x[0]!, y: f.y[0]! }).toEqual(held);
      lastX = x; lastY = y;
    }
    at(pb, 1050, f); b.update(f); expect(b.bodyPosition(0, 1, model)).toBeNull();
    b.update(new Frame()); expect(b.bodyPosition(0, 1, model)).toBeNull();
  });
});

it("wires the shared facing and held-open jaws into real 2D particles and 3D instance buffers", () => {
  const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;
  const ants = new Ants(renderer, 10, 10), engine = new NullEngine(), scene = new Scene(engine);
  try {
    const ants3d = new Ants3D(scene, new Ground(scene, 64, 48), 0.5, COLONY_RGB), pb = shortPlayback();
    for (const ms of [300, 333, 400, 800, 833, 1000]) {
      const f = at(pb, ms); ants.update(f); ants3d.update(f);
      const facing = f.drawRotation![0]!, body = ants.antLayer.particleChildren[0]! as Particle;
      expect(body.rotation).toBeCloseTo(facing);
      expect(Math.hypot(body.x - f.x[0]!, body.y - f.y[0]!)).toBeLessThanOrEqual(0.3 + 1e-6);
      const mesh = scene.getMeshByName("ants0") as Mesh;
      const m = mesh._thinInstanceDataStorage.matrixData!;
      expect(delta(-Math.atan2(m[2]!, m[0]!), facing)).toBeCloseTo(0);
      expect(Math.hypot(m[12]! - f.x[0]!, 48 - m[14]! - f.y[0]!)).toBeLessThanOrEqual(0.3 + 1e-6);
      const head = mesh.getVertexBuffer("aHead")!.getFloatData(mesh.thinInstanceCount * 2, true)!;
      expect(Math.hypot(head[0]!, head[1]!) * 0.5).toBeLessThanOrEqual(0.15 + 1e-6);
      const b = new Bites(); b.update(f); const pose = b.pose(0, 0.5)!;
      const jaws = mesh.getVertexBuffer("aBite")!.getFloatData(mesh.thinInstanceCount, true)!;
      expect(jaws[0]).toBeCloseTo(pose?.jawOpen ?? 0);
      if (ms === 300 || ms === 333) expect(jaws[0]).toBe(1);
    }
  } finally { scene.dispose(); engine.dispose(); }
});
