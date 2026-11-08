import { createHash } from "node:crypto";
import type { Browser } from "playwright-core";
import { captureFinerGridCase, captureMatchedZoom, zoomDifference } from "../../web/capture/finer-grid.ts";
import type { ScaleImage } from "../../web/capture/finer-grid-measurements.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateManifest, inspectRecording, detourAnts, assertVisibleDetour, prepareFinerGridFrame, restoreFinerGridHome, assertReturnedHome, returnedHomeEvidence, scaleContext, edgesVisible, type CaptureManifest } from "../../web/capture/finer-grid.ts";
import type { ClientPage } from "../../web/capture/browser.ts";
import { BlankPrimaryBoardError } from "../../web/capture/colony-scale.ts";
import { terrainFixture } from "../../web/capture/terrain.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { encodeMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";

const pin = { path: "recording.bin", sha256: "a".repeat(64) };
function manifest(): CaptureManifest {
  return { head: "a".repeat(40), baselineHead: "b".repeat(40), dist: "candidate", baselineDist: "baseline", cases: [
    ...["open-field", "three-crossings", "central-lake"].map(mapId => ({ name: mapId, mapId, kind: "map" as const, recording: pin, baseline: pin, ticks: [0] })),
    { name: "detour", kind: "lake-detour", mapId: "central-lake", recording: pin, ticks: [0, 10, 20] },
    { name: "old", kind: "legacy", recording: pin, ticks: [1500, 1600] },
  ] };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function clientFixture() {
  const background: [number, number, number, number] = [11, 8, 5, 255];
  const painted = { background, samples: Array.from({ length: 64 }, (_, i) => [70 + i % 32, 45 + i % 17, 20, 255]) };
  const blank = { background, samples: Array.from({ length: 64 }, () => background) };
  const evaluate = vi.fn().mockResolvedValue(painted);
  const frame = vi.fn().mockResolvedValue({ playbackTick: 0 });
  const advance = vi.fn();
  const client = { page: { evaluate }, frame, advance, info: { rendererName: "babylon webgl2", mapW: 128, mapH: 96 } } as unknown as ClientPage;
  return { client, evaluate, frame, advance, painted, blank };
}

describe("finer-grid same-tick paint readiness", () => {
  it("waits for primary scene pixels, never advancing time or drawing after the last successful read", async () => {
    const c = clientFixture();
    c.evaluate.mockResolvedValueOnce(c.blank).mockResolvedValue(c.painted);
    const result = await prepareFinerGridFrame(c.client, "3d", 0, "default");
    expect(c.frame).toHaveBeenCalledExactlyOnceWith(false);
    expect(c.evaluate).toHaveBeenCalledTimes(2);
    expect(c.advance).not.toHaveBeenCalled();
    expect(result.primaryBoard).toMatchObject({ attempts: 2, playbackTick: 0, manualClockAdvanceMs: 0, first: { nonblank: false }, last: { nonblank: true } });
  });
  it("waits for 2D primary paint without advancing the paused page clock", async () => {
    const c = clientFixture();
    c.evaluate.mockResolvedValueOnce(c.blank).mockResolvedValue(c.painted);
    expect((await prepareFinerGridFrame(c.client, "2d", 0, "default")).primaryBoard).toMatchObject({ attempts: 2, manualClockAdvanceMs: 0, playbackTick: 0 });
    expect(c.frame).toHaveBeenCalledExactlyOnceWith(true);
    expect(c.advance).not.toHaveBeenCalled();
    await expect(prepareFinerGridFrame(c.client, "2d", 1, "default")).rejects.toThrow("requested tick");
  });
  it("rejects exhausted 2D blank frames and never retries renderer errors", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const c = clientFixture(); c.evaluate.mockResolvedValue(c.blank);
    const pending = prepareFinerGridFrame(c.client, "2d", 0, "default");
    const rejected = expect(pending).rejects.toThrow("blank primary 2D board");
    await vi.advanceTimersByTimeAsync(20_001); await rejected;
    expect(c.advance).not.toHaveBeenCalled();
    c.evaluate.mockReset().mockRejectedValue(new Error("context lost"));
    await expect(prepareFinerGridFrame(c.client, "2d", 0, "default")).rejects.toThrow("context lost");
    expect(c.evaluate).toHaveBeenCalledTimes(1);
  });
  it("fails persistently blank views instead of accepting crowns or changing the camera", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const c = clientFixture(); c.evaluate.mockResolvedValue(c.blank);
    const pending = prepareFinerGridFrame(c.client, "3d", 0, "default");
    const rejected = expect(pending).rejects.toBeInstanceOf(BlankPrimaryBoardError);
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    expect(c.advance).not.toHaveBeenCalled();
    expect(c.frame).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("returned-home evidence", () => {
  it("retains exact values and signed differences without relaxing the strict tolerance", () => {
    const initial = { view: { ox: 0, oy: 10, tilePx: 8 }, camera: null };
    const home = { view: { ox: 0.01, oy: 9, tilePx: 7 }, camera: null };
    expect(returnedHomeEvidence(initial, home)).toMatchObject({ initial, returned: home, delta: { ox: 0.01, oy: -1, tilePx: -1 }, tolerance: 0.01, failure: expect.stringContaining("ox") });
    expect(returnedHomeEvidence(initial, initial).failure).toBeNull();
  });
  it("restores saved 2D scale before position using the viewer's API", async () => {
    const initial = { view: { ox: 40, oy: 80, tilePx: 8 }, camera: null };
    let current = { ox: -20, oy: 16, tilePx: 12 };
    const calls: string[] = [];
    vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("window", { __antwar: {
      view: () => ({ ...current }),
      zoomAt: (factor: number, x: number, y: number) => {
        calls.push("zoom"); current = { tilePx: current.tilePx * factor, ox: x + (current.ox - x) * factor, oy: y + (current.oy - y) * factor };
      },
      panBy: (dx: number, dy: number) => { calls.push("pan"); current.ox += dx; current.oy += dy; },
    } });
    const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as unknown as Parameters<typeof restoreFinerGridHome>[0];
    await restoreFinerGridHome(page, initial);
    expect(calls).toEqual(["zoom", "pan"]);
    expect(() => assertReturnedHome(initial, { view: current, camera: null })).not.toThrow();
    expect(() => assertReturnedHome(initial, { view: { ...current, ox: 44 }, camera: null })).toThrow("ox");
  });
  it("uses the 3D home preset and rejects a shifted target even with the same projected scale", async () => {
    const camera = { view: "tilted" as const, alpha: -1.5, beta: 0.2, radius: 150, target: [64, 0, 48] };
    const initial = { view: { ox: 40, oy: 80, tilePx: 8 }, camera };
    const setView = vi.fn();
    vi.stubGlobal("window", { __antwar: { setView } });
    const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as unknown as Parameters<typeof restoreFinerGridHome>[0];
    await restoreFinerGridHome(page, initial);
    expect(setView).toHaveBeenCalledExactlyOnceWith("tilted");
    expect(() => assertReturnedHome(initial, initial)).not.toThrow();
    expect(() => assertReturnedHome(initial, { ...initial, camera: { ...camera, target: [65, 0, 48] } })).toThrow("target");
  });
});

describe("matched physical zoom", () => {
  it("matches both physical-tile axes through public scalar zoom without changing ticks or camera state directly", async () => {
    let size = { x: 4, y: 4 };
    const zoom = vi.fn(async (factor: number) => { size = { x: size.x * factor, y: size.y * factor }; });
    const result = await captureMatchedZoom({ x: 10, y: 10 }, async attempt => ({ image: `real-shot-${attempt}`, scale: { pixelsPerPhysicalTile: [{ ...size }] } }), zoom);
    expect(zoom.mock.calls).toEqual([[1], [2.5]]);
    expect(result.difference.equal).toBe(true);
    expect(result.best.image).toBe("real-shot-1");
    expect(result.attempts).toHaveLength(2);
  });
  it("retains the closest captured pair and both actual axes when a public zoom clamp blocks equality", async () => {
    let x = 5;
    const result = await captureMatchedZoom({ x: 10, y: 10 }, async attempt => ({ file: `attempt-${attempt}`, scale: { pixelsPerPhysicalTile: [{ x, y: x }] } }), async factor => { x = Math.min(8, x * factor); });
    expect(result.best.file).toBe("attempt-1");
    expect(result.difference).toMatchObject({ x: -2, y: -2, equal: false });
    expect(result.attempts).toHaveLength(3);
  });
  it("does not disguise incompatible 3D projection axes as equal zoom", async () => {
    let x = 4;
    const result = await captureMatchedZoom({ x: 8, y: 8 }, async () => ({ scale: { pixelsPerPhysicalTile: [{ x, y: x / 2 }] } }), async factor => { x *= factor; });
    expect(result.difference.equal).toBe(false);
    expect(result.best.scale.pixelsPerPhysicalTile[0]!.x).toBeGreaterThan(8);
    expect(result.best.scale.pixelsPerPhysicalTile[0]!.y).toBeLessThan(8);
    expect(() => zoomDifference({ x: 0, y: 1 }, { x: 1, y: 1 })).toThrow("Invalid");
  });
});

describe("camera and screenshot evidence retention", () => {
  it("runs the real 2D readback callback, retains failed home values and screenshot pins", async () => {
    const background = [0, 0, 0, 255], canvasBox = { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 };
    const area = { ...canvasBox, top: 100, bottom: 500 };
    let view = { ox: 40, oy: 150, tilePx: 2 };
    let zoomLimit = Infinity;
    const gl = { drawingBufferWidth: 400, drawingBufferHeight: 600, RGBA: 1, UNSIGNED_BYTE: 2,
      readPixels: (_x: number, _y: number, _w: number, _h: number, _format: number, _type: number, buffer: Uint8Array) => {
        for (let i = 0; i < buffer.length; i += 4) buffer.set([70 + i % 31, 45 + i % 17, 20, 255], i);
        buffer.set(background, (600 - 1) * 400 * 4);
      } };
    vi.stubGlobal("innerWidth", 400); vi.stubGlobal("innerHeight", 600); vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("document", { querySelector: (selector: string) => selector === "canvas" ? { getContext: () => gl, getBoundingClientRect: () => canvasBox } : { getBoundingClientRect: () => area } });
    const api = {
      ready: Promise.resolve({ webgl2: true, rendererName: "pixi", mapW: 128, mapH: 96 }),
      frame: () => ({ playbackTick: 0 }), board: () => ({ tick: 0 }), nests: () => [{ colony: 0, id: 0 }],
      boardArea: () => ({ x0: area.left, y0: area.top, x1: area.right, y1: area.bottom }),
      view: () => ({ ...view }), tileToScreen: (x: number, y: number) => [view.ox + x * view.tilePx, view.oy + y * view.tilePx],
      zoomAt: (factor: number) => { view.tilePx = Math.min(zoomLimit, view.tilePx * factor); },
      // Model an unchanged public-camera clamp that does not restore the requested offset.
      panBy: (dx: number, dy: number) => { view.ox += dx + 1; view.oy += dy; },
    };
    vi.stubGlobal("window", { __antwar: api });
    const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write("IHDR", 12); bytes.writeUInt32BE(400, 16); bytes.writeUInt32BE(600, 20);
    const clock = { install: vi.fn(), pauseAt: vi.fn(), runFor: vi.fn() };
    const page = { clock, on: vi.fn(), goto: vi.fn(), waitForFunction: vi.fn(),
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      screenshot: vi.fn().mockResolvedValue(bytes),
      getByRole: () => ({ count: async () => 1, click: async () => { view = { ox: 60, oy: 130, tilePx: 2 }; } }),
    };
    const context = { newPage: async () => page, route: vi.fn(), close: vi.fn(), addInitScript: async (script: () => void) => script() };
    const browser = { newContext: vi.fn().mockResolvedValue(context), version: () => "test-engine" };
    const c = manifest().cases[0]!;
    const recording = { firstTick: 0, lastTick: 0, messages: 1, setup: terrainFixture(rulesConfig("redesign")).full!.setup };
    const images: ScaleImage[] = [];
    const references = new Map();
    const result = await captureFinerGridCase(browser as unknown as Browser, "webkit", "/unused-dist", new Uint8Array(), recording, c, "2d", "baseline", "/unused-output", "desktop", images, false, references);
    expect(browser.newContext).toHaveBeenCalledWith({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    expect(result.observations).toHaveLength(4);
    expect(result.observations[2]).toMatchObject({ label: "returned-home", homeCheck: { initial: { view: { ox: 40 } }, returned: { view: { ox: 41 } }, delta: { ox: 1 }, tolerance: 0.01, failure: expect.stringContaining("ox") } });
    expect(result.failures[0]).toContain('"ox":1');
    expect(images.map(image => image.context.label)).toEqual(["default", "returned-home", "matched-zoom"]);
    expect(result.observations[3]).toMatchObject({ label: "matched-zoom", matchedZoom: { difference: { equal: true } } });
    expect(images[0]!.scale).toMatchObject({ area: { y0: 100, y1: 500 }, pixelsPerPhysicalTile: expect.any(Array) });
    expect(context.close).toHaveBeenCalledTimes(1);
    // Only the pre-existing requested playback advance occurs, never a readiness clock advance.
    expect(clock.runFor).toHaveBeenCalledTimes(1);
    const scale = await scaleContext(page as unknown as Parameters<typeof scaleContext>[0], 128, 96, 2);
    expect(scale.pixelsPerPhysicalTile[0]).toMatchObject({ x: 4, y: 4 });
    view = { ox: 40, oy: 150, tilePx: 1 };
    const candidate = await captureFinerGridCase(browser as unknown as Browser, "webkit", "/unused-dist", new Uint8Array(), recording, c, "2d", "candidate", "/unused-output", "desktop", images, false, references);
    expect(candidate.observations[3]).toMatchObject({ label: "matched-zoom", matchedZoom: { reference: { file: images[2]!.image.file, sha256: images[2]!.image.sha256 }, difference: { equal: true } } });
    expect(images).toHaveLength(6);
    expect(images[5]!.normalization).toMatchObject({ baseline: { file: images[2]!.image.file, sha256: images[2]!.image.sha256 } });
    // An unreachable zoom target is now a numeric input to object normalization,
    // not a product-size failure; unrelated exact-home failures remain failures.
    view = { ox: 40, oy: 150, tilePx: 1 }; zoomLimit = 1.8;
    const clamped = await captureFinerGridCase(browser as unknown as Browser, "webkit", "/unused-dist", new Uint8Array(), recording, c, "2d", "candidate", "/unused-output", "desktop", [], false, references);
    expect(clamped.observations[3]).toMatchObject({ label: "matched-zoom", matchedZoom: { difference: { equal: false } } });
    expect(clamped.failures.some(f => f.includes("matched zoom unreachable"))).toBe(false);
    expect(clamped.failures.some(f => f.includes("returned home differs"))).toBe(true);
  });
  it("requires every corner inside the actual board area with a visible margin", () => {
    const area = { x0: 0, y0: 100, x1: 400, y1: 500 };
    expect(edgesVisible([[10, 110], [390, 110], [390, 490], [10, 490]], area)).toBe(true);
    expect(edgesVisible([[10, 90], [390, 110], [390, 490], [10, 490]], area)).toBe(false);
    expect(edgesVisible([[10, 110], [390, 110], [390, NaN], [10, 490]], area)).toBe(false);
  });
});

describe("detour evidence", () => {
  it("rejects dock-edge, offscreen and wrong-ant evidence", () => {
    const area = { x0: 0, y0: 200, x1: 393, y1: 500 };
    expect(() => assertVisibleDetour([190, 350], area, 1, 1)).not.toThrow();
    for (const point of [[190, 499], [190, 510], [1, 350], [NaN, 350]]) {
      expect(() => assertVisibleDetour(point, area, 1, 1)).toThrow();
    }
    expect(() => assertVisibleDetour([190, 350], area, null, 1)).toThrow("not present");
    expect(() => assertVisibleDetour([190, 350], area, 2, 1)).toThrow("not present");
  });
  it("reads actual sub-tile positions and rejects changing identities or ambiguous footage", () => {
    const first = terrainFixture(rulesConfig("redesign"));
    const ants = { count: 1, id: new Uint32Array([1]), x: new Uint16Array([10368]), y: new Uint16Array([12416]), heading: new Uint8Array([0]), colony: new Uint8Array([0]), agent: new Int16Array([-1]) };
    const opening = { ...first, tick: 0, ants };
    const next = { tick: 1, full: null, events: [], ants: { ...ants, x: new Uint16Array([12524]) } };
    const bytes = packMessages([encodeMessage(opening), encodeMessage(next)]);
    expect(detourAnts(bytes, [0, 1]).get(0)).toEqual({ id: 1, x: 40.5, y: 48.5 });
    expect(detourAnts(bytes, [1]).get(1)?.x).toBe(12524 / 256);
    expect(() => detourAnts(bytes, [2])).toThrow("same single ant");
    const changed = packMessages([encodeMessage(opening), encodeMessage({ ...next, ants: { ...ants, id: new Uint32Array([2]) } })]);
    expect(() => detourAnts(changed, [1])).toThrow("same single ant");
  });
});

describe("finer-grid capture evidence inputs", () => {
  it("requires both commit pins and all requested map/motion/legacy scenes", () => {
    expect(() => validateManifest(manifest())).not.toThrow();
    for (const index of [0, 1, 2, 3, 4]) {
      const m = manifest(); m.cases.splice(index, 1);
      expect(() => validateManifest(m)).toThrow();
    }
    const m = manifest(); m.head = "main";
    expect(() => validateManifest(m)).toThrow("commit pins");
  });

  it("requires matched baselines and multiple actual lake ticks", () => {
    const m = manifest(); delete m.cases[0]!.baseline;
    expect(() => validateManifest(m)).toThrow("baseline");
    const n = manifest(); n.cases[3]!.ticks = [0];
    expect(() => validateManifest(n)).toThrow("approach");
    const invalid = manifest(); invalid.cases[0]!.ticks = [10, 0];
    expect(() => validateManifest(invalid)).toThrow("increase");
  });

  it("rejects changed bytes, wrong maps and tick requests outside actual footage", () => {
    const rules = rulesConfig("redesign");
    const bytes = packMessages([encodeMessage(terrainFixture(rules))]);
    const actual = { path: "real.bin", sha256: createHash("sha256").update(bytes).digest("hex") };
    const c = { name: "recording", kind: "legacy" as const, recording: actual, ticks: [0] };
    expect(inspectRecording(bytes, actual, c).messages).toBe(1);
    expect(() => inspectRecording(bytes, pin, c)).toThrow("digest mismatch");
    expect(() => inspectRecording(bytes, actual, { ...c, mapId: "not-the-recorded-map" })).toThrow("Recording is not");
    expect(() => inspectRecording(bytes, actual, { ...c, ticks: [1000] })).toThrow("outside recording");
  });
});
