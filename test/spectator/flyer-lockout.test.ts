// A landed flyer's lockout reads on both boards as a dial around it that drains until the first tick it may take off
// again, then is gone. It is read from the sampled message alone: the same in recorded and live playback, from the
// first frame after a seek or a join, and on the right ants in a colony's view. Messages without flyers draw none.
import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { decodeMessage, type StreamFlyer, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { LIVE_BUFFER_MS } from "../../web/src/playout.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { fitTilted, projector } from "../../web/src/board3d/view.ts";
import { LOCKOUT_DIAL_MS, LockoutDials, dialRadiusPx, lockoutRemainingMs, lockouts } from "../../web/src/flyer-lockout.ts";
import { flyerOf, isAirborne } from "../../web/src/flyer-state.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

// A recorded opening: 60 ants, alternating colonies 0 and 1, ids 1 to 60, the colonies' ants far apart.
const base = decodeMessage(scale2Packets(1)[0]!);
const W = base.full!.setup.mapW, H = base.full!.setup.mapH;

/**
 * Each flyer's state in the message of a tick, by ant id; every other ant is not a flyer.
 * Ant 1 flies, lands on tick 5 and may take off from tick 35 (the rules' 30 ticks later): the stream reads it locked out
 * while the processed tick (the message's tick - 1) is before 35. Ant 5 landed earlier and may take off from tick 25;
 * ant 2, of the other colony, from tick 20. Ant 3 hovers throughout, ant 7 stands grounded throughout.
 */
function flyersAt(tick: number): Map<number, StreamFlyer> {
  const locked = (takeOffTick: number): StreamFlyer => tick - 1 < takeOffTick ? { state: "lockedOut", takeOffTick } : { state: "grounded" };
  return new Map<number, StreamFlyer>([
    [1, tick <= 5 ? { state: "flying", destX: 4000, destY: 9000 } : locked(35)],
    [2, locked(20)],
    [3, { state: "hovering", destX: 5000, destY: 11008 }],
    [5, locked(25)],
    [7, { state: "grounded" }],
  ]);
}

/** The message of a tick: a full snapshot when full, the ants stepping one sub-tile a tick, carrying flyers unless plain. */
function message(tick: number, full: boolean, plain = false): StreamMessage {
  const states = flyersAt(tick);
  const flyers = Array.from(base.ants.id, (id) => states.get(id) ?? null);
  return {
    ...base, tick, events: [], full: full ? structuredClone(base.full) : null,
    ants: { ...base.ants, x: base.ants.x.map((x) => x + tick), ...(plain ? {} : { flyers }) },
  };
}

/** What the dials must be at a playback time: each locked-out flyer until its take-off tick is reached, with what is left. */
function expected(renderMs: number): [number, number][] {
  const tick = Math.floor(renderMs / TICK_MS);
  const out: [number, number][] = [];
  for (const [id, f] of flyersAt(tick)) {
    if (f.state === "lockedOut" && f.takeOffTick! * TICK_MS > renderMs) out.push([id, f.takeOffTick! * TICK_MS - renderMs]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const read = (frame: Frame): [number, number][] => lockouts(frame).map((l) => [l.antId, l.remainingMs]);

/** Every lockout sits where its ant's body is drawn in that frame, with the dial's share of what is left. */
function placed(frame: Frame): void {
  for (const l of lockouts(frame)) {
    expect(frame.id[l.index]).toBe(l.antId);
    expect(l.x).toBe(frame.drawX?.[l.index] ?? frame.x[l.index]);
    expect(l.y).toBe(frame.drawY?.[l.index] ?? frame.y[l.index]);
    expect(l.share).toBeCloseTo(Math.min(1, l.remainingMs / LOCKOUT_DIAL_MS), 9);
  }
}

describe("a landed flyer's lockout as playback shows it", () => {
  it("recorded: each locked-out flyer has a draining dial from its landing until it may take off, and no other ant has one", () => {
    const pb = new Playback(), frame = new Frame();
    for (let tick = 0; tick <= 45; tick++) pb.push(message(tick, tick === 0), tick * TICK_MS);
    let seen = 0;
    for (let ms = 0; ms <= 4500; ms += 25) {
      pb.sample(ms + RENDER_DELAY_MS, frame);
      expect(frame.renderMs).toBe(ms);
      expect(read(frame)).toEqual(expected(ms));
      placed(frame);
      seen += lockouts(frame).length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("recorded: the dial drains on the playback clock and goes as the take-off tick is reached, before the stream says grounded", () => {
    const pb = new Playback(), frame = new Frame();
    for (let tick = 0; tick <= 45; tick++) pb.push(message(tick, tick === 0), tick * TICK_MS);
    const at = (ms: number) => { pb.sample(ms + RENDER_DELAY_MS, frame); return lockouts(frame).find((l) => l.antId === 1); };
    expect(at(550)).toBeUndefined(); // still flying
    expect(at(600)).toMatchObject({ remainingMs: 2900, share: 2900 / 3000 });
    expect(at(2000)).toMatchObject({ remainingMs: 1500, share: 0.5 });
    expect(at(3450)).toMatchObject({ remainingMs: 50 });
    // The sampled message still reads it locked out, but it may take off now: the dial is gone.
    expect(at(3500)).toBeUndefined();
    expect(frame.ants!.flyers![0]).toEqual({ state: "lockedOut", takeOffTick: 35 });
    expect(at(3700)).toBeUndefined();
    expect(frame.ants!.flyers![0]).toEqual({ state: "grounded" });
  });

  it("live: the buffered live clock shows the same dials frame by frame", () => {
    const pb = new Playback({ live: true }), frame = new Frame();
    let pushed = 0, drawn = 0;
    for (let now = 0; now <= 7000; now += 33) {
      while (pushed <= 45 && pushed * TICK_MS <= now) { pb.push(message(pushed, pushed === 0), pushed * TICK_MS); pushed++; }
      if (!pb.sample(now, frame)) continue;
      drawn++;
      expect(read(frame)).toEqual(expected(frame.renderMs));
      placed(frame);
    }
    expect(drawn).toBeGreaterThan((7000 - LIVE_BUFFER_MS) / 33 - 2);
  });

  it("after a seek: playback restarted from a snapshot taken mid-lockout shows the dial from its first frame", () => {
    for (const seekTick of [10, 22, 34]) {
      const pb = new Playback(), frame = new Frame();
      for (let tick = seekTick; tick <= 45; tick++) pb.push(message(tick, tick === seekTick), tick * TICK_MS);
      pb.sample(seekTick * TICK_MS + RENDER_DELAY_MS, frame);
      expect(read(frame)).toEqual(expected(seekTick * TICK_MS));
      expect(read(frame).find(([id]) => id === 1)).toEqual([1, (35 - seekTick) * TICK_MS]);
    }
  });

  it("when joining while flyers are airborne: only the locked-out flyer has a dial, and a flyer that then lands gets one", () => {
    const pb = new Playback({ live: true }), frame = new Frame();
    const join = 3;
    let pushed = join, first: [number, number][] | null = null, landed = false;
    for (let now = 0; now <= 6000; now += 33) {
      while (pushed <= 45 && (pushed - join) * TICK_MS <= now) { pb.push(message(pushed, pushed === join), (pushed - join) * TICK_MS); pushed++; }
      if (!pb.sample(now, frame)) continue;
      first ??= read(frame);
      expect(read(frame)).toEqual(expected(frame.renderMs));
      if (frame.renderMs >= 600 && frame.renderMs < 3500) {
        landed = true;
        expect(lockouts(frame).some((l) => l.antId === 1)).toBe(true);
      }
    }
    // The first frame: ant 1 flying and ant 3 hovering have none; ants 2 and 5, landed before the join, have theirs.
    expect(first!.map(([id]) => id)).toEqual([2, 5]);
    expect(landed).toBe(true);
  });

  it("in a colony's view, dials sit on that colony's own flyers by id, and none on an enemy flyer out of its sight", () => {
    const pb = new Playback(), frame = new Frame(), view = new TeamView();
    for (let tick = 0; tick <= 12; tick++) pb.push(message(tick, tick === 0), tick * TICK_MS);
    pb.sample(1000 + RENDER_DELAY_MS, frame);
    view.choice = 0;
    const shown = view.apply(frame);
    // The view draws fewer ants than the message carries, so its ant arrays no longer line up with the message's.
    expect(shown.count).toBeLessThan(shown.ants!.count);
    expect(read(shown)).toEqual([[1, 2500], [5, 1500]]);
    placed(shown);
    for (const l of lockouts(shown)) {
      const i = frame.id.indexOf(l.antId);
      expect([l.x, l.y]).toEqual([frame.drawX?.[i] ?? frame.x[i], frame.drawY?.[i] ?? frame.y[i]]);
    }
    view.choice = 1;
    expect(read(view.apply(frame))).toEqual([[2, 1000]]);
    view.choice = "full";
    expect(read(view.apply(frame))).toEqual([[1, 2500], [2, 1000], [5, 1500]]);
  });

  it("reads each frame ant's flyer state by id, in Full view and in a colony's view", () => {
    const pb = new Playback(), frame = new Frame(), view = new TeamView();
    for (let tick = 0; tick <= 12; tick++) pb.push(message(tick, tick === 0), tick * TICK_MS);
    pb.sample(1000 + RENDER_DELAY_MS, frame);
    const states = flyersAt(10);
    const byId = (f: Frame) => Array.from({ length: f.count }, (_, i) => [f.id[i]!, flyerOf(f, i)] as const);
    for (const [id, flyer] of byId(frame)) expect(flyer).toEqual(states.get(id) ?? null);
    view.choice = 0;
    const shown = view.apply(frame);
    expect(shown.id[2]).toBe(5);
    expect(flyerOf(shown, 2)).toEqual({ state: "lockedOut", takeOffTick: 25 });
    for (const [id, flyer] of byId(shown)) expect(flyer).toEqual(states.get(id) ?? null);
    expect(byId(shown).filter(([, f]) => isAirborne(f)).map(([id]) => id)).toEqual([3]);
    expect(isAirborne(null)).toBe(false);
    expect(isAirborne({ state: "lockedOut", takeOffTick: 3 })).toBe(false);
    expect(isAirborne({ state: "flying", destX: 1, destY: 1 })).toBe(true);
  });

  it("a message without flyers draws no dial", () => {
    const pb = new Playback(), frame = new Frame();
    for (let tick = 0; tick <= 12; tick++) pb.push(message(tick, tick === 0, true), tick * TICK_MS);
    pb.sample(1000 + RENDER_DELAY_MS, frame);
    expect(frame.ants!.flyers).toBeUndefined();
    expect(flyerOf(frame, 0)).toBeNull();
    expect(lockouts(frame)).toEqual([]);
    const dials = new LockoutDials();
    dials.update(frame, (x, y) => [x, y], () => 12);
    expect(dials.dials).toEqual([]);
    expect(dials.layer.context.instructions).toHaveLength(0);
  });

  it("a flyer that is not locked out, or has no take-off tick, has no time left", () => {
    expect(lockoutRemainingMs(null, 0)).toBe(0);
    expect(lockoutRemainingMs({ state: "grounded" }, 0)).toBe(0);
    expect(lockoutRemainingMs({ state: "flying", destX: 1, destY: 1 }, 0)).toBe(0);
    expect(lockoutRemainingMs({ state: "hovering", destX: 1, destY: 1 }, 0)).toBe(0);
    expect(lockoutRemainingMs({ state: "lockedOut" }, 0)).toBe(0);
    expect(lockoutRemainingMs({ state: "lockedOut", takeOffTick: 30 }, 1000)).toBe(2000);
    expect(lockoutRemainingMs({ state: "lockedOut", takeOffTick: 30 }, 3000)).toBe(0);
    // A lockout longer than the rules' shows the dial full until its last 3 s.
    const pb = new Playback(), frame = new Frame();
    pb.push({ ...message(0, true), ants: { ...base.ants, flyers: Array.from(base.ants.id, (id) => id === 1 ? { state: "lockedOut", takeOffTick: 90 } : null) } }, 0);
    pb.sample(RENDER_DELAY_MS, frame);
    expect(lockouts(frame)).toMatchObject([{ antId: 1, remainingMs: 9000, share: 1 }]);
  });
});

type Shape = { type: string; x?: number; y?: number; radius?: number; points?: number[] };
type Instruction = { action: string; data: { path: { shapePath: { shapePrimitives: { shape: Shape }[] } }; style: { color: number } } };
const strokes = (g: Graphics, type: string): Shape[] =>
  (g.context.instructions as unknown as Instruction[]).filter((i) => i.action === "stroke")
    .flatMap((i) => i.data.path.shapePath.shapePrimitives.map((p) => p.shape).filter((s) => s.type === type));

describe("the lockout dial on both boards", () => {
  const flat2d = (w: number) => {
    const px = w / W;
    return (tx: number, ty: number): [number, number] => [tx * px, ty * px];
  };
  const relief = (tx: number, ty: number) => 0.4 * Math.sin(tx / 3) * Math.cos(ty / 4);
  const tilted3d = (w: number, h: number) => {
    const project = projector(fitTilted(W, H, w, h, { x0: 0, y0: 0, x1: w, y1: h }).pose, w, h);
    return (tx: number, ty: number): [number, number] => project([tx, relief(tx, ty), H - ty]) ?? [NaN, NaN];
  };
  const views = [
    { board: "2D", w: 1920, h: 1080, toScreen: flat2d(1920), antPx: () => 20 },
    { board: "2D", w: 390, h: 844, toScreen: flat2d(390), antPx: () => 10 },
    { board: "3D", w: 1920, h: 1080, toScreen: tilted3d(1920, 1080), antPx: (tx: number) => 14 + tx / 10 },
    { board: "3D", w: 390, h: 844, toScreen: tilted3d(390, 844), antPx: () => 9 },
  ];

  it.each(views)("draws one dial per locked-out flyer at its ground point on the $board board at $w x $h, draining clockwise from the top", ({ toScreen, antPx }) => {
    const pb = new Playback(), frame = new Frame(), dials = new LockoutDials();
    for (let tick = 0; tick <= 45; tick++) pb.push(message(tick, tick === 0), tick * TICK_MS);
    pb.sample(1000 + RENDER_DELAY_MS, frame);
    dials.update(frame, toScreen, antPx);
    const found = lockouts(frame);
    expect(dials.dials.map((d) => d.antId)).toEqual([1, 2, 5]);
    for (const [k, d] of dials.dials.entries()) {
      const l = found[k]!;
      const [x, y] = toScreen(l.x, l.y);
      expect([d.x, d.y]).toEqual([x, y]);
      expect(d.r).toBe(dialRadiusPx(antPx(l.x)));
      expect(d.share).toBe(l.share);
    }
    // Per dial: a dark backing and a faint track as full circles, then the arc of what is left.
    const circles = strokes(dials.layer, "circle"), arcs = strokes(dials.layer, "polygon");
    expect(circles).toHaveLength(2 * dials.dials.length);
    expect(arcs).toHaveLength(dials.dials.length);
    for (const [k, d] of dials.dials.entries()) {
      for (const c of circles.slice(2 * k, 2 * k + 2)) expect(c).toMatchObject({ x: d.x, y: d.y, radius: d.r });
      const p = arcs[k]!.points!;
      expect(p[0]).toBeCloseTo(d.x, 6); expect(p[1]).toBeCloseTo(d.y - d.r, 6);
      const end = -Math.PI / 2 + d.share * 2 * Math.PI;
      expect(p.at(-2)!).toBeCloseTo(d.x + d.r * Math.cos(end), 6);
      expect(p.at(-1)!).toBeCloseTo(d.y + d.r * Math.sin(end), 6);
    }
    // Once every lockout has run out the board draws none.
    pb.sample(4000 + RENDER_DELAY_MS, frame);
    dials.update(frame, toScreen, antPx);
    expect(dials.dials).toEqual([]);
    expect(dials.layer.context.instructions).toHaveLength(0);
    dials.layer.destroy();
  });

  it("keeps the dial clear of a small ant and sizes it with a large one", () => {
    expect(dialRadiusPx(4)).toBe(7);
    expect(dialRadiusPx(10)).toBe(9);
    expect(dialRadiusPx(28)).toBeCloseTo(19.8, 9);
    for (const px of [10, 14, 20, 28, 60]) expect(dialRadiusPx(px)).toBeGreaterThan(px / 2);
  });

  it("skips a flyer the projection cannot place on screen", () => {
    const pb = new Playback(), frame = new Frame(), dials = new LockoutDials();
    for (let tick = 0; tick <= 12; tick++) pb.push(message(tick, tick === 0), tick * TICK_MS);
    pb.sample(1000 + RENDER_DELAY_MS, frame);
    dials.update(frame, (x, y) => x < 50 ? [NaN, NaN] : [x, y], () => 12);
    expect(dials.dials.map((d) => d.antId)).toEqual([2]);
    dials.layer.destroy();
  });
});
