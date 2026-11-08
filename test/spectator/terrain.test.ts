/** Stream -> Playback -> both real renderer upload boundaries. NullEngine is not pixel proof. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { DOMAdapter, RenderTexture } from "pixi.js";
import { decodeMessage, encodeMessage, SUB_TILE } from "../../src/live/format.ts";
import { MAPS, rulesConfig } from "../../src/sim/config.ts";
import { referenceTile } from "../../src/sim/gridScale.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { Camera, fightLane, queensBox } from "../../web/src/camera.ts";
import { boardBox, fitTilted, groundAt, project, viewPose } from "../../web/src/board3d/view.ts";
import { COLONY_RGB, Ground, EDGE_FADE_START_TILES, OFFBOARD_BRIGHTNESS } from "../../web/src/board3d/ground.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { heightAt } from "../../web/src/board3d/noise.ts";
import { foundingFrame, fitFoundingPose } from "../../web/src/board3d/queen-framing.ts";
import { Territory } from "../../web/src/territory.ts";
import { Words } from "../../web/src/words.ts";
import { BOUNDARY_TILES, WATER_GLSL, WaterMask, mirrorAxis, onBoard } from "../../web/src/terrain.ts";
import { CAPTURE_ATTEMPTS, alternateTerrainTick, assertStableDryPixels, assertTerrainScene, auditCaptureErrors, boardEdgeTiles, defaultMarginCoverage, dryControls, edgeStepCheck, judgeRenderedPair, marginPairProblems, offboardScreenProbes, retryBlankCapture, selectRenderedPair, spreadQueenFixture, terrainCaptureKey, terrainEvidenceStatus, terrainFixture, type CaptureResult } from "../../web/capture/terrain.ts";

import { BlankPrimaryBoardError, settle3DBoard } from "../../web/capture/colony-scale.ts";
import { captureQuery, type ClientPage } from "../../web/capture/browser.ts";
import { openSource } from "../../web/src/source.ts";
import { packMessages } from "../../src/live/snapshot.ts";

const rules = rulesConfig("redesign");
const fixture = (id: string) => terrainFixture({ ...rules, terrain: { ...rules.terrain!, rocks: undefined, mapId: id } });
function frameFor(id: string): Frame {
  const playback = new Playback(), frame = new Frame();
  playback.push(fixture(id), 0);
  expect(playback.sample(2000, frame)).toBe(true);
  return frame;
}
let engine: NullEngine, scene: Scene;
const browserAdapter = DOMAdapter.get();
beforeEach(() => {
  // Only Pixi's external precision probe is substituted: no browser/GPU is claimed here.
  DOMAdapter.set({ ...browserAdapter, createCanvas: () => ({ getContext: () => null }) as unknown as ReturnType<typeof browserAdapter.createCanvas> });
  engine = new NullEngine(); scene = new Scene(engine);
});
afterEach(() => { vi.restoreAllMocks(); DOMAdapter.set(browserAdapter); scene.dispose(); engine.dispose(); });

it("reflects continuous coordinates at all sides/corners, repeating without wrapping opposite shores", () => {
  for (const [value, mirrored] of [[-0.5, 0.5], [-2.5, 2.5], [63.5, 63.5], [64.5, 63.5], [66.5, 61.5], [128.5, 0.5], [-128.5, 0.5]]) {
    expect(mirrorAxis(value!, 64)).toBe(mirrored);
  }
  for (const [x, y] of [[-0.01, 0], [64, 20], [10, 48], [NaN, 1], [1, Infinity]]) expect(onBoard(x!, y!, 64, 48)).toBe(false);
  expect(onBoard(0, 0, 64, 48)).toBe(true);
});

it("builds live-layout fixtures from actual no-input simulation steps, never joining agents or inventing a late snapshot", () => {
  const initial = terrainFixture(rules), later = terrainFixture(rules, 2);
  expect(initial.tick).toBe(0);
  expect(later.tick).toBe(2);
  expect(later.full!.agents).toEqual([]);
  expect(later.full!.setup).toEqual(initial.full!.setup);
  expect(() => terrainFixture(rules, -1)).toThrow("outside the match");
  expect(() => terrainFixture(rules, rules.matchTicks + 1)).toThrow("outside the match");
});

it.each(MAPS)("loads the actual $name snapshot through the same recording source as board-parity, without changing live layout", async (map) => {
  const config = { ...rules, terrain: { ...rules.terrain!, mapId: map.id } };
  const snapshot = terrainFixture(config, 2);
  const packets = packMessages([encodeMessage(snapshot)]);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from(packets).buffer));
  const params = captureQuery({ recording: "terrain-snapshot", board: "3d", tilt: false });
  expect(params.get("recording")).toBe("terrain-snapshot");
  expect(params.has("replay")).toBe(false); // Both shipped renderers select live layout unless ?replay is present.
  const doc = { defaultView: { addEventListener() {} } } as unknown as Document;
  const source = await openSource(params, { now: () => 0 }, doc, (error) => { throw error; });
  expect(fetch).toHaveBeenCalledWith("recordings/terrain-snapshot.bin");
  expect(source).not.toBeNull();
  expect(source!.recorded).toBe(true);
  expect(source!.feed).toBeNull();
  expect(source!.head).toEqual(snapshot);
  const playback = new Playback({ live: !source!.recorded }), frame = new Frame();
  for (const { m, at } of source!.take(0)) playback.push(m, at);
  expect(playback.sample(2000, frame)).toBe(true);
  expect(frame.tick).toBe(2);
  expect(frame.board!.agents).toEqual([]);
  expect(frame.board!.queens!.filter((queen) => queen.lostTick === null).length).toBeGreaterThan(0);
  expect(frame.board!.setup.terrain).toEqual(snapshot.full!.setup.terrain);
  for (let i = 0; i < 10; i++) { expect(playback.sample(2000, frame)).toBe(true); expect(frame.tick).toBe(2); }
  source!.close();
  // The same snapshot over live SSE cannot start: elapsed time is not newer footage.
  const live = new Playback({ live: true }), empty = new Frame();
  live.push(snapshot, 0);
  expect(live.sample(100_000, empty)).toBe(false);
  expect(empty.board).toBeNull();
});

it("rejects empty or wrong-tick scenes before any paint can count as match evidence", () => {
  const scene = { playbackTick: 3100, board: { tick: 3100, held: [10, 20] as [number, number], overrun: [0, 0] as [number, number], deaths: [0, 0] as [number, number], winner: null, ended: false, intents: [] }, waitingVisible: false, liveQueens: 2 };
  expect(() => assertTerrainScene(scene, 3100)).not.toThrow();
  for (const delta of [{ waitingVisible: true }, { liveQueens: 0 }, { board: null }]) expect(() => assertTerrainScene({ ...scene, ...delta }, 3100)).toThrow("empty live page");
  expect(() => assertTerrainScene({ ...scene, playbackTick: 0 }, 3100)).toThrow("not the requested match tick");
  expect(() => assertTerrainScene({ ...scene, board: { ...scene.board, tick: 3099 } }, 3100)).toThrow("not the requested match tick");
});

it("distinguishes unstable or transparent 2D readback from a stable before/after product comparison", () => {
  const controls: [number, number, number, number][] = [[100, 80, 60, 255], [80, 60, 40, 255]];
  expect(() => assertStableDryPixels(controls, structuredClone(controls))).not.toThrow();
  expect(() => assertStableDryPixels(controls, [[0, 0, 0, 0], controls[1]!])).toThrow("unstable within the same build");
  expect(() => assertStableDryPixels([[0, 0, 0, 0]], [[0, 0, 0, 0]])).toThrow("no opaque visible controls");
});

describe("projected visible-stage margin", () => {
  const stage = { x0: 0, y0: 0, x1: 10, y1: 10 };
  it("reports no margin only when the projected board covers the visible stage", () => {
    expect(offboardScreenProbes([[-1, -1], [11, -1], [11, 11], [-1, 11]], stage)).toEqual({ status: "no-margin-in-frame", area: 0, points: [] });
  });
  it("detects thin strips without excluding two tiles, and distinguishes subpixel unsampled area", () => {
    const thin = offboardScreenProbes([[0.75, 0], [10, 0], [10, 10], [0.75, 10]], stage);
    expect(thin.status).toBe("margin-present");
    expect(thin.area).toBeCloseTo(7.5);
    expect(thin.points.length).toBe(10);
    expect(thin.points.every(([x]) => x === 0.5)).toBe(true);
    const subpixel = offboardScreenProbes([[0.25, 0], [10, 0], [10, 10], [0.25, 10]], stage);
    expect(subpixel).toEqual({ status: "margin-present-not-sampled", area: 2.5, points: [] });
  });
  it("finds corner wedges and excludes pixels outside the stage/backdrop aperture", () => {
    const corner = offboardScreenProbes([[0, 0], [8, 0], [10, 2], [10, 10], [0, 10]], stage);
    expect(corner.status).toBe("margin-present");
    expect(corner.area).toBeCloseTo(2);
    expect(corner.points.some(([x, y]) => x > y + 8)).toBe(true);
    const aperture = { x0: 2, y0: 2, x1: 8, y1: 8 };
    expect(offboardScreenProbes([[2, 2], [8, 2], [8, 8], [2, 8]], aperture).status).toBe("no-margin-in-frame");
    const outside = offboardScreenProbes([[3, 3], [7, 3], [7, 7], [3, 7]], aperture);
    expect(outside.points.every(([x, y]) => x >= 2 && x < 8 && y >= 2 && y < 8)).toBe(true);
  });
  it("fails invalid projection rather than declaring absent margin", () => {
    expect(() => offboardScreenProbes([], stage)).toThrow("invalid projected");
    expect(() => offboardScreenProbes([[NaN, 0], [10, 0], [10, 10]], stage)).toThrow("invalid projected");
  });
});

it.each(MAPS)("keeps the $name spread-queen scene explicit and gets a genuine unchanged default margin", (map) => {
  const original = fixture(map.id), copy = structuredClone(original);
  const spread = spreadQueenFixture(original);
  expect(original).toEqual(copy);
  expect(spread.tick).toBe(original.tick);
  expect(spread.ants).toEqual(original.ants);
  expect(spread.events).toEqual(original.events);
  expect(spread.full!.agents).toEqual([]);
  expect(spread.full!.setup.terrain).toEqual(original.full!.setup.terrain);
  const { mapW: W, mapH: H } = spread.full!.setup;
  expect(spread.full!.setup.queens).toEqual([[3.5 * SUB_TILE, 3.5 * SUB_TILE], [(W - 3.5) * SUB_TILE, (H - 3.5) * SUB_TILE]]);
  for (const colony of [0, 1] as const) {
    const queen = spread.full!.queens!.find((q) => q.id === 0 && q.colony === colony)!;
    expect([queen.x, queen.y]).toEqual(spread.full!.setup.queens[colony]);
  }
  const stage = { x0: 24, y0: 124, x1: 1596, y1: 926 };
  const pose = fitTilted(W, H, 1920, 1080, stage, fightLane(spread.full!.setup), queensBox(spread.full!.setup)).pose;
  const ground = new Ground(scene, W, H);
  const outline = boardEdgeTiles(W, H).map(([x, y]) => project(pose, 1920, 1080, [x, ground.heightAt(x, y), H - y])!);
  const margin = offboardScreenProbes(outline, stage);
  expect(margin.status).toBe("margin-present");
  expect(margin.area).toBeGreaterThan(1000);
  expect(margin.points.length).toBeGreaterThan(100);
  expect(new Set(boardEdgeTiles(W, H).map((p) => p.join(","))).size).toBe(2 * (W + H));
  expect(defaultMarginCoverage(map.id, 1)).toEqual([]);
  expect(defaultMarginCoverage(map.id, 0)).toEqual([`${map.id}: no verified default 3D margin frame`]);
});

it("keeps ordinary and spread recordings, images and comparison keys distinct in the real capture wiring", () => {
  const keys = new Set<string>();
  for (const scenario of ["ordinary", "spread-queens"] as const) for (const view of ["default", "whole-board", "boundary"]) keys.add(terrainCaptureKey(scenario, "3d", 1920, 1080, view));
  expect(keys.size).toBe(6);
  const source = readFileSync("web/capture/terrain.ts", "utf8");
  expect(source.match(/const key = terrainCaptureKey\(scenario, board, width, height, view\)/g)).toHaveLength(2);
  expect(source).toContain('const sceneStem = `${map.id}-${fixture.tick}-${sourceStage}-${scenario}`');
  expect(source.match(/const file = `\$\{sceneStem\}-/g)).toHaveLength(2);
  expect(source).toContain('await captureBuilds(spreadQueenFixture(ordinary), "initial", captures, "spread-queens")');
  expect(source).toContain('pair.status === "passed" && after?.status === "rendered" && after.value.outside.status === "margin-present"');
  expect(source).toContain('view === "default"');
  expect(source).toContain("boardEdgeTiles(client.info.mapW, client.info.mapH)");
  expect(source).not.toContain("groundAt(");
});

it("never calls an unsampled or void margin board-filled, and keeps pixel-change and step failures", () => {
  const edge = { clear: true, comparisons: 12, luminanceRatio: 0.5, darkerFraction: 1, pairs: [], controls: [] };
  const report = offboardScreenProbes([[0.75, 0], [10, 0], [10, 10], [0.75, 10]], { x0: 0, y0: 0, x1: 10, y1: 10 });
  const capture = (pixel: [number, number, number, number]) => ({ outside: { ...report, outline: [], pixels: report.points.map(() => pixel) }, boundary: edge });
  const before = capture([11, 8, 5, 255]), after = capture([40, 32, 25, 255]);
  expect(marginPairProblems(before, after)).toEqual([]);
  expect(marginPairProblems(after, after)).toContain("off-board pixels are unchanged; margin extension is not demonstrated");
  expect(marginPairProblems(before, before)).toContain("off-board ground has no visible painted pixels");
  expect(marginPairProblems(before, { ...after, boundary: { ...edge, clear: false } })).toContain("playable edge step is not clear across the projected boundary");
  const missing = { ...after, outside: { ...after.outside, status: "margin-present-not-sampled" as const, points: [], pixels: [] } };
  expect(marginPairProblems(before, missing)).toEqual(["margin is present but not sampled in both builds"]);
  const filled = { ...after, outside: { status: "no-margin-in-frame" as const, area: 0, points: [], pixels: [], outline: [] } };
  expect(marginPairProblems(filled, filled)).toEqual([]);
  const incomplete = { ...after, outside: { ...after.outside, pixels: [null] } };
  expect(marginPairProblems(before, incomplete)).toContain("off-board pixel readback is incomplete");
  const wide = offboardScreenProbes([[3, 3], [7, 3], [7, 7], [3, 7]], { x0: 0, y0: 0, x1: 10, y1: 10 });
  const farVoid = { ...after, outside: { ...wide, outline: [], pixels: wide.points.map(([, y]): [number, number, number, number] => y < 1 ? [8, 6, 4, 255] : [40, 32, 25, 255]) } };
  const baseline = { ...before, outside: { ...wide, outline: [], pixels: wide.points.map((): [number, number, number, number] => [11, 8, 5, 255]) } };
  expect(marginPairProblems(baseline, farVoid)).toContain("margin scanlines show void rather than painted ground");
});

describe("capture evidence, not a blank-frame pass", () => {
  const blankPixels = () => ({ samples: Array.from({ length: 192 }, () => [11, 8, 5, 255]), background: [11, 8, 5, 255] });
  const paintedPixels = () => ({ samples: Array.from({ length: 192 }, (_, i) => i % 2 ? [100, 80, 60, 255] : [60, 40, 20, 255]), background: [11, 8, 5, 255] });
  const captureClient = (evaluate: ReturnType<typeof vi.fn>, rendererName = "babylon") => ({
    info: { rendererName, mapW: 64, mapH: 48 }, page: { evaluate },
  }) as unknown as ClientPage;

  it("reuses colony-scale settling: a real extra draw after initial blank paint, with the same tick and no clock advance", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(blankPixels()).mockResolvedValueOnce(paintedPixels());
    const settled = await settle3DBoard(captureClient(evaluate), 3100, "default");
    expect(settled).toMatchObject({ attempts: 2, first: { nonblank: false }, last: { nonblank: true }, playbackTick: 3100, manualClockAdvanceMs: 0 });
    expect(evaluate).toHaveBeenCalledTimes(2);
    for (const call of evaluate.mock.calls) expect(call[1]).toEqual({ mapW: 64, mapH: 48, expectedTick: 3100 });
  });

  it("classifies only exhausted blank paint, not renderer, tick or GPU execution failures", async () => {
    const evaluate = vi.fn().mockResolvedValue(blankPixels());
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(20_000);
    const error = await settle3DBoard(captureClient(evaluate), 3100, "default").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BlankPrimaryBoardError);
    expect(error).toMatchObject({ attempts: 1, first: { nonblank: false }, last: { nonblank: false } });
    vi.restoreAllMocks();
    for (const message of ["3D draw moved playback", "3D primary canvas has no WebGL2 context", "page crashed"]) {
      const failure = new Error(message);
      await expect(settle3DBoard(captureClient(vi.fn().mockRejectedValue(failure)), 3100, "default")).rejects.toBe(failure);
      expect(failure).not.toBeInstanceOf(BlankPrimaryBoardError);
    }
    await expect(settle3DBoard(captureClient(evaluate, "pixi"), 3100, "default")).rejects.toThrow("requested 3D");
  });

  it("wires shared settling into terrain and redraws atomically for the 2D dry comparison", () => {
    const source = readFileSync("web/capture/terrain.ts", "utf8");
    expect(source).toContain('import { BlankPrimaryBoardError, settle3DBoard } from "./colony-scale.ts"');
    expect(source).toContain("await settle3DBoard(client, fixture.tick, captureName)");
    expect(source).toContain("await page.goto(url)");
    expect(source).toContain("packMessages([encodeMessage(fixture)])");
    expect(source).not.toContain("startFixtureStream");
    expect(source).not.toContain('searchParams.delete("recording")');
    expect(source).toContain("diagnosticOnly: true, renderedAlternativePair: selected.usedAlternative, usedForAcceptance: false");
    expect(source).not.toContain('captures.set(`before-${key}`, selected.before!');
    expect(source).not.toContain('captures.set(`after-${key}`, selected.after!');
    for (const path of ["web/src/main.ts", "web/src/board3d/main3d.ts"]) expect(readFileSync(path, "utf8")).toContain('const mode = replay ? "replay" : "live"');
    expect(source).toContain("const scene = await terrainScene(client, fixture.tick)");
    expect(source.indexOf("const scene = await terrainScene(client, fixture.tick)")).toBeLessThan(source.indexOf("await settle3DBoard(client, fixture.tick, captureName)"));
    expect(source).toContain("if (!(error instanceof BlankPrimaryBoardError)) throw error");
    expect(source).toContain('samplePixels(client, dryControls(fixture), "tile", true)');
    expect(source).not.toContain('samplePixels(client, dryControls(fixture), "tile", false)');
    expect(source).toContain("const frame = draw ? api.frame() : null");
    expect(source.indexOf("const frame = draw ? api.frame() : null")).toBeLessThan(source.indexOf("gl.readPixels"));
  });

  it("retries blank frames within a fixed bound, retaining the first actual render and its attempt", async () => {
    const attempts: number[] = [];
    const result = await retryBlankCapture("open-field 3d-1920x1080-default before", async (attempt) => {
      attempts.push(attempt);
      return attempt === 2 ? "painted frame" : null;
    });
    expect(attempts).toEqual([1, 2]);
    expect(result).toEqual({ name: "open-field 3d-1920x1080-default before", status: "rendered", attempts: 2, value: "painted frame" });
  });

  it("names an exhausted before view as unrendered and still attempts its after and the other views", async () => {
    const attempts: number[] = [];
    const name = "open-field 3d-390x844-default";
    const before = await retryBlankCapture(`${name} before`, async (attempt) => { attempts.push(attempt); return null; });
    const after = await retryBlankCapture(`${name} after`, async () => "painted after");
    let judged = false;
    const missing = judgeRenderedPair(name, before, after, () => { judged = true; return ["must not judge an unrendered pair"]; });
    expect(attempts).toEqual(Array.from({ length: CAPTURE_ATTEMPTS }, (_, i) => i + 1));
    expect(before).toEqual({ name: `${name} before`, status: "unrendered", attempts: CAPTURE_ATTEMPTS });
    expect(missing).toEqual({ name, status: "unrendered", missing: ["before"], problems: [] });
    expect(judged).toBe(false);
    const boundary = await retryBlankCapture("open-field 3d-390x844-boundary", async () => "painted boundary");
    const checked = judgeRenderedPair(boundary.name, boundary, boundary, () => []);
    expect(terrainEvidenceStatus([missing, checked])).toBe("incomplete");
    expect(terrainEvidenceStatus([checked])).toBe("passed");
    expect(terrainEvidenceStatus([])).toBe("incomplete");
  });

  it("never judges an unrendered after or an absent baseline, and does not turn execution errors into blank flakes", async () => {
    const name = "central-lake 3d-1920x1080-whole-board";
    const before = await retryBlankCapture(`${name} before`, async () => "painted before");
    const after = await retryBlankCapture(`${name} after`, async () => null);
    const forbidden = () => { throw new Error("unrendered evidence was judged"); };
    expect(judgeRenderedPair(name, before, after, forbidden).missing).toEqual(["after"]);
    expect(judgeRenderedPair(name, undefined, after, forbidden).missing).toEqual(["before", "after"]);
    let calls = 0;
    await expect(retryBlankCapture(name, async () => { calls++; throw new Error("page error: shader failed"); })).rejects.toThrow("page error: shader failed");
    expect(calls).toBe(1);
    expect(terrainEvidenceStatus([], "page error: shader failed")).toBe("failed");
  });

  it("keeps real rendered-pair failures even alongside unrendered views on any map or size", async () => {
    const reports = [];
    for (const map of MAPS) for (const size of ["1920x1080", "390x844"]) for (const view of ["default", "whole-board", "boundary"]) {
      const name = `${map.id} 3d-${size}-${view}`;
      const rendered = await retryBlankCapture(name, async () => "painted");
      reports.push(judgeRenderedPair(name, rendered, rendered, () => ["off-board pixels are unchanged"]));
    }
    expect(reports).toHaveLength(18);
    expect(reports.every((report) => report.status === "failed" && report.problems[0] === "off-board pixels are unchanged")).toBe(true);
    const blank = await retryBlankCapture("missing before", async () => null);
    reports.push(judgeRenderedPair("missing pair", blank, blank, () => []));
    expect(terrainEvidenceStatus(reports)).toBe("failed");
  });

  it("chooses one different bounded tick and generates the fallback as an actual no-agent snapshot", () => {
    expect(alternateTerrainTick(3100, rules.matchTicks)).toBe(3000);
    expect(alternateTerrainTick(0, 10)).toBe(10);
    expect(alternateTerrainTick(10, 10)).toBe(0);
    expect(alternateTerrainTick(0, 0)).toBeNull();
    expect(() => alternateTerrainTick(-1, 10)).toThrow("invalid fallback tick range");
    expect(() => alternateTerrainTick(11, 10)).toThrow("invalid fallback tick range");
    const earlier = alternateTerrainTick(2, rules.matchTicks)!;
    const original = terrainFixture(rules, 2), fallback = terrainFixture(rules, earlier);
    expect(fallback.tick).not.toBe(original.tick);
    expect(fallback.full!.agents).toEqual([]);
    expect(fallback.full!.setup).toEqual(original.full!.setup);
  });

  it("uses both alternative sides together, never mixes ticks or replaces an already rendered pair", () => {
    type Evidence = { tick: number };
    const render = (name: string, tick: number): CaptureResult<Evidence> => ({ name, status: "rendered", attempts: 1, value: { tick } });
    const blank: CaptureResult<Evidence> = { name: "open-field default before", status: "unrendered", attempts: CAPTURE_ATTEMPTS };
    const originalAfter = render("after", 3100), otherBefore = render("alternative before", 3000), otherAfter = render("alternative after", 3000);
    const partial = selectRenderedPair(blank, originalAfter, otherBefore, blank);
    expect(partial).toEqual({ before: blank, after: originalAfter, usedAlternative: false });
    expect(judgeRenderedPair("open-field default", partial.before, partial.after, () => []).status).toBe("unrendered");
    const recovered = selectRenderedPair(blank, originalAfter, otherBefore, otherAfter);
    expect(recovered).toEqual({ before: otherBefore, after: otherAfter, usedAlternative: true });
    expect(judgeRenderedPair("open-field default", recovered.before, recovered.after, (before, after) => before.tick === after.tick ? [] : ["mixed ticks"]).status).toBe("passed");
    const originalBefore = render("before", 3100);
    expect(selectRenderedPair(originalBefore, originalAfter, otherBefore, otherAfter)).toEqual({ before: originalBefore, after: originalAfter, usedAlternative: false });
  });

  it("keeps page errors and every resource error except the exact one-use replay-list 404 fatal", () => {
    const url = "http://fixture.invalid/live/replays";
    const allowed = { kind: "console" as const, message: "404", url };
    const page = { kind: "page" as const, message: "shader failed", url };
    const response = { method: "GET", path: "/live/replays", status: 404, url };
    const audit = auditCaptureErrors([allowed, allowed, page], [response]);
    expect(audit.excluded).toHaveLength(1);
    expect(audit.fatal).toEqual([allowed, page]);
    expect(auditCaptureErrors([allowed], [{ ...response, status: 500 }]).fatal).toEqual([allowed]);
    expect(auditCaptureErrors([allowed], [{ ...response, method: "POST" }]).fatal).toEqual([allowed]);
    expect(auditCaptureErrors([allowed], [{ ...response, path: "/other" }]).fatal).toEqual([allowed]);
    expect(auditCaptureErrors([allowed], [response, { ...response, status: 500 }]).fatal).toEqual([allowed]);
  });

  it("requires a visible boundary step, not flat colour, empty pixels or sparse controls", () => {
    const strong = Array.from({ length: 12 }, () => ({ inside: [100, 80, 60, 255] as [number, number, number, number], outside: [65, 52, 39, 255] as [number, number, number, number] }));
    expect(edgeStepCheck(strong).clear).toBe(true);
    expect(edgeStepCheck(strong).comparisons).toBe(12);
    expect(edgeStepCheck(strong.map(({ inside }) => ({ inside, outside: inside }))).clear).toBe(false);
    expect(edgeStepCheck(strong.slice(0, 7)).clear).toBe(false);
    expect(edgeStepCheck(strong.map(({ inside }) => ({ inside, outside: [0, 0, 0, 0] }))).clear).toBe(false);
    expect(edgeStepCheck([]).clear).toBe(false);
  });
});

it("encodes exact half-open cells, clips to bounds and clears water on legacy/new maps without reallocating", () => {
  const mask = new WaterMask(5, 4), bytes = mask.data;
  const wet = { mapId: "test", mapName: "Test", water: [[1, 1, 2, 2], [4, 3, 3, 3]] as const };
  expect(mask.update(wet)).toBe(true);
  expect(Array.from(bytes).filter((_, i) => i % 4 === 0)).toEqual([0,0,0,0,0, 0,255,255,0,0, 0,255,255,0,0, 0,0,0,0,255]);
  expect(mask.update(wet)).toBe(false);
  expect(mask.update(undefined)).toBe(true);
  expect(mask.data).toBe(bytes); expect(bytes.every((v) => v === 0)).toBe(true);
  expect(mask.update(undefined)).toBe(false);
});

it("keeps the default Open Field framing radius despite the flat rendered exterior", () => {
  const f = frameFor("open-field"), { mapW: W, mapH: H } = f.board!.setup;
  const ground = new Ground(scene, W, H);
  // Baseline desktop stage and orientation, measured alongside the paired captures.
  // The fitting routine's binary search varies below one millionth with its starting radius.
  const area = { x0: 24, y0: 163, x1: 1307.984375, y1: 1000 };
  const pose = fitFoundingPose({ alpha: -Math.PI / 2, beta: 0.3988552469480783, radius: 300, target: [32, 0, 24] },
    foundingFrame(W, H, (x, y) => ground.heightAt(x, y)), 1920, 1080, area);
  // The grid-scale-2 board: the fitted radius of the same founding frame on the 128x96 fine board.
  expect(pose.radius).toBeCloseTo(199.9279092103243, 6);
  // A zero-height query outside the map is NOT interchangeable with this legacy envelope.
  const flatQueries = fitFoundingPose(pose, foundingFrame(W, H, (x, y) => onBoard(x, y, W, H) ? ground.heightAt(x, y) : 0), 1920, 1080, area);
  expect(Math.abs(flatQueries.radius - pose.radius)).toBeGreaterThan(0.1);
});

describe.each(MAPS)("$name", (map) => {
  it("uses version-10 half-open water geometry in both renderer uploads, not a name/seed lookup", () => {
    const message = fixture(map.id);
    const roundTrip = decodeMessage(encodeMessage(message));
    expect(roundTrip.full!.setup.terrain).toEqual(message.full!.setup.terrain);
    expect(roundTrip.full!.agents).toEqual([]);
    const f = frameFor(map.id), { mapW: W, mapH: H } = f.board!.setup;
    const ground = new Ground(scene, W, H);
    const territory = new Territory(W, H, RenderTexture.create({ width: 10, height: 10 }), { w: 100, h: 100, ox: 0, oy: 0, tilePx: 1 });
    const upload3d = vi.spyOn(ground.plugin.textures.water as RawTexture, "update");
    const source2d = territory.fill.shader!.resources.uWater;
    const upload2d = vi.spyOn(source2d, "update");
    ground.update(f, 0); territory.update(f, 0);
    expect(upload3d).toHaveBeenCalledWith(ground.water.data);
    expect(upload2d).toHaveBeenCalledTimes(1);
    expect(territory.water.data).toEqual(ground.water.data);
    let mismatches = 0;
    // The catalog names water in reference tiles; each grid-scale-2 fine tile is water when its reference tile is.
    const setup = f.board!.setup;
    const expected = (fx: number, fy: number) => {
      const x = referenceTile(fx, setup), y = referenceTile(fy, setup);
      return map.water.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) ? 255 : 0;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (ground.water.data[(y * W + x) * 4] !== expected(x, y)) mismatches++;
    }
    expect(mismatches).toBe(0);
    const diffuse = ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    expect(diffuse).toContain("uMap - abs(mod(awTile, 2.0 * uMap) - uMap)");
    expect(diffuse).toContain("texture2D(uWater, (awWaterCell + 0.5) / uMap).r");
    expect(diffuse).toContain("mix(awCol, awWaterColour(awMirror), awWet)");
    const playable = diffuse.indexOf("if (awUV.x >= 0.0 && awUV.y >= 0.0 && awUV.x < 1.0 && awUV.y < 1.0) {");
    const end = diffuse.indexOf("\n}", playable);
    expect(playable).toBeGreaterThan(diffuse.indexOf("vec3 awCol = uOffboardSoil;"));
    expect(diffuse.slice(playable, end)).toContain("mix(awCol, awWaterColour(awMirror), awWet)");
    expect(diffuse.slice(end)).not.toContain("awWaterColour");
    expect(territory.fill.shader!.glProgram!.fragment).toContain(WATER_GLSL);
    expect(territory.fill.shader!.glProgram!.fragment).toContain("if (awWaterAt(vUV) > 0.5)");
    expect(territory.front.shader!.glProgram!.fragment).toContain("if (awWaterAt(vUV) > 0.5) discard");
    ground.update(f, 1); territory.update(f, 1);
    expect(upload3d).toHaveBeenCalledTimes(1); expect(upload2d).toHaveBeenCalledTimes(1);
    // A different streamed shape with the SAME id/name must replace both masks.
    f.board!.setup = { ...f.board!.setup, terrain: { ...f.board!.setup.terrain!, water: [[1, 1, 1, 1]] } };
    ground.update(f, 2); territory.update(f, 2);
    expect(ground.water.data.filter((v) => v === 255)).toHaveLength(1);
    expect(territory.water.data).toEqual(ground.water.data);
    f.board!.setup = { ...f.board!.setup, terrain: undefined };
    ground.update(f, 3); territory.update(f, 3);
    expect(ground.water.data.every((v) => v === 0)).toBe(true);
    expect(territory.water.data.every((v) => v === 0)).toBe(true);
    territory.fill.destroy(); territory.frontLayer.destroy({ children: true });
  });

  it("flattens the exterior, keeps its step/fade, draws no ring actors/marks/labels and is not pickable", () => {
    const f = frameFor(map.id), { mapW: W, mapH: H } = f.board!.setup;
    const ground = new Ground(scene, W, H); ground.update(f, 0);
    // The whole ring adds precisely one non-pickable terrain mesh, never actor/label layers.
    expect(scene.meshes).toEqual([ground.mesh]); expect(ground.mesh.isPickable).toBe(false);
    for (const [x, y] of [[-2, 12], [W + 2, 12], [20, -2], [20, H + 2], [-2, -2], [W + 2, H + 2]]) {
      const hit = new Ray(new Vector3(x!, 10, H - y!), new Vector3(0, -1, 0)).intersectsMesh(ground.mesh);
      expect(hit.hit).toBe(true);
      expect(hit.pickedPoint!.y).toBeCloseTo(0, 10);
      expect(onBoard(hit.pickedPoint!.x, H - hit.pickedPoint!.z, W, H)).toBe(false);
    }
    expect(ground.heightAt(12, 12)).toBeCloseTo(heightAt(12, 12), 6);
    expect(scene.pickWithRay(new Ray(new Vector3(32, 10, H + 2), new Vector3(0, -1, 0)))!.hit).toBe(false);
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB); ants.update(f);
    let actors = 0;
    for (const mesh of ants.meshes) {
      for (const matrix of mesh.thinInstanceGetWorldMatrices()) {
        if (!mesh.isEnabled()) continue;
        expect(onBoard(matrix.m[12]!, H - matrix.m[14]!, W, H)).toBe(true); actors++;
      }
    }
    expect(actors).toBe(f.count);
    const words = new Words({ w: 1920, h: 1080 });
    words.update(f, (x, y) => [x * 10, y * 10], [], map.id);
    expect(words.markers()).toEqual([]); expect(words.drawnLabels()).toEqual([]);
    words.layer.destroy({ children: true });
    const shader = ground.plugin.getCustomCode("fragment")!;
    expect(shader.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain(`awCol *= ${OFFBOARD_BRIGHTNESS.toFixed(2)}`);
    expect(shader.CUSTOM_FRAGMENT_BEFORE_FOG).toContain(`smoothstep(${EDGE_FADE_START_TILES.toFixed(2)}, uMargin, max(awEdge.x, awEdge.y))`);
    const farRing = -ground.margin * 0.6;
    const farHit = new Ray(new Vector3(farRing, 10, H - farRing), new Vector3(0, -1, 0)).intersectsMesh(ground.mesh);
    expect(farHit.hit).toBe(true);
    expect(onBoard(farHit.pickedPoint!.x, H - farHit.pickedPoint!.z, W, H)).toBe(false);
    const main = readFileSync("web/src/board3d/main3d.ts", "utf8");
    expect(main).toContain('import "@babylonjs/core/Culling/ray.js"');
    expect(main).toContain("scene.createPickingRay(x, y, null, cam).intersectsMesh(ground.mesh)");
    expect(main).toContain("if (!playableAt(x, y))");
    expect(main).toContain("if (!playableAt(e.offsetX, e.offsetY))");
  });

  it("covers the full viewport outside unchanged default and whole-board camera fits, before the backdrop's far fade ends", () => {
    const setup = fixture(map.id).full!.setup, W = setup.mapW, H = setup.mapH;
    const ground = new Ground(scene, W, H);
    const lane = fightLane(setup), keep = queensBox(setup);
    for (const [w, h, area] of [[1920,1080,{x0:24,y0:124,x1:1596,y1:926}], [390,844,{x0:0,y0:177,x1:390,y1:399}], [844,390,{x0:0,y0:0,x1:504,y1:390}]] as const) {
      const camera = new Camera(W, H, w, h, area, lane, keep);
      // The shipped default/Whole board reset uses the lane. Also protect the wider whole-map fit.
      for (const frame of [lane, undefined]) for (const view of ["tilted", "top"] as const) {
        const pose = viewPose(view, W, H, w, h, frame ? camera.view : camera.fit, area, frame, frame ? keep : undefined);
        for (const [sx, sy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
          const point = groundAt(pose, w, h, sx!, sy!);
          expect(point).not.toBeNull();
          const [x, z] = point!, y = H - z;
          const distance = Math.max(0, -x, x - W, -y, y - H);
          // Safety space for relief; the mesh is still lit terrain here, not its clear-colour endpoint.
          expect(distance).toBeLessThan(ground.margin * 0.8);
        }
      }
    }
  });

  it("keeps both nests in the unchanged default 3D and 2D frame at desktop and phone sizes", () => {
    const setup = fixture(map.id).full!.setup;
    const lane = fightLane(setup), keep = queensBox(setup);
    for (const [w, h, area] of [[1920,1080,{x0:24,y0:124,x1:1596,y1:926}], [390,844,{x0:0,y0:177,x1:390,y1:399}]] as const) {
      const pose = fitTilted(setup.mapW, setup.mapH, w, h, area, lane, keep).pose;
      const bounds = boardBox(pose, setup.mapW, setup.mapH, w, h, keep)!;
      expect(bounds.x0).toBeGreaterThanOrEqual(area.x0 - 0.5); expect(bounds.x1).toBeLessThanOrEqual(area.x1 + 0.5);
      expect(bounds.y0).toBeGreaterThanOrEqual(area.y0 - 0.5); expect(bounds.y1).toBeLessThanOrEqual(area.y1 + 0.5);
      const camera = new Camera(setup.mapW, setup.mapH, w, h, area, lane, keep);
      for (const [x, y] of setup.queens) {
        const [sx, sy] = camera.toScreen(x / 256, y / 256);
        expect(sx).toBeGreaterThanOrEqual(area.x0); expect(sx).toBeLessThanOrEqual(area.x1);
        expect(sy).toBeGreaterThanOrEqual(area.y0); expect(sy).toBeLessThanOrEqual(area.y1);
      }
    }
    expect(dryControls(fixture(map.id)).length).toBeGreaterThan(0);
  });
});

it("preserves legacy camera defaults and bounds legacy 2D dry shading to the boundary band", () => {
  // Source hashes cannot describe compatibility once new recordings carry a scale.
  // Old recordings must follow the original scale-one path; camera/view suites pin its behavior.
  const setup = fixture("open-field").full!.setup;
  const area = { x0: 0, y0: 80, x1: 1200, y1: 700 };
  const lane = fightLane(setup), keep = queensBox(setup);
  const legacy = new Camera(setup.mapW, setup.mapH, 1200, 800, area, lane, keep);
  const explicit = new Camera(setup.mapW, setup.mapH, 1200, 800, area, lane, keep, 1);
  expect(explicit.view).toEqual(legacy.view);
  expect(explicit.fit).toEqual(legacy.fit);
  for (const name of ["tilted", "top"] as const) {
    expect(viewPose(name, setup.mapW, setup.mapH, 1200, 800, legacy.view, area, lane, keep, 1))
      .toEqual(viewPose(name, setup.mapW, setup.mapH, 1200, 800, legacy.view, area, lane, keep));
  }
  const source = readFileSync("web/src/territory.ts", "utf8");
  expect(BOUNDARY_TILES).toBe(1.25);
  expect(source).toContain("return smoothstep(0.0, ${BOUNDARY_TILES.toFixed(2)}, min(edge.x, edge.y));");
  expect(source).toContain("colour, awBoundaryWeight(uv)");
  expect(source).toContain("return texture(uWater, (cell + 0.5) / uMap).r");
});
