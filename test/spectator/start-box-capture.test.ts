/** Capture preconditions, not rendered acceptance. Fixtures here are deliberately synthetic. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { NEW_MATCH_GRID_SCALE } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import type { StreamMessage, StreamQueen } from "../../src/live/format.ts";
import type { StartLayout } from "../../web/src/start-boxes.ts";
import { assertOpeningContainment, FRAMING_MAPS, FRAMING_VIEWPORTS, inspectStartRecording, prepareStartFrame, START_MAPS } from "../../web/capture/start-boxes.ts";
import type { ClientPage } from "../../web/capture/browser.ts";
import { BlankPrimaryBoardError, boardPixelCheck } from "../../web/capture/colony-scale.ts";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: the layout below is the reference 64x48 layout in fine tiles.
const S = NEW_MATCH_GRID_SCALE;

function fixture(mapId: string): StreamMessage[] {
  const recorder = new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG)));
  const full = recorder.initialFull(), ants = recorder.initial().ants;
  const layout: StartLayout = { startBoxes: [{ x: 2 * S, y: 12 * S, width: 12 * S, height: 24 * S }, { x: 50 * S, y: 12 * S, width: 12 * S, height: 24 * S }], startingQueenIds: [[0, 1], [0, 1]] };
  full.setup = { ...full.setup, ...layout, terrain: { mapId, mapName: mapId, water: [] } };
  full.queens = ([0, 1] as const).flatMap(colony => [0, 1].map((id): StreamQueen => ({ id, colony,
    x: (colony ? 51.5 + id : 3.5 + id) * S * 256, y: 20.5 * S * 256, foundedTick: 0, lostTick: null, overrun: 0 })));
  return [{ tick: 0, full, ants, events: [] }, { tick: 1, full: null, ants, events: [{ kind: "queenFounded", queen: { ...full.queens[0]!, id: 2 } }] }];
}

afterEach(() => vi.useRealTimers());

it("keeps the full default matrix and declares the two-map, three-size framing matrix", () => {
  expect(START_MAPS).toEqual(["open-field", "three-crossings", "central-lake"]);
  expect(FRAMING_MAPS).toEqual(["open-field", "central-lake"]);
  expect(FRAMING_VIEWPORTS).toEqual({ desktop: { width: 1440, height: 1000 }, portrait: { width: 393, height: 852 }, landscape: { width: 852, height: 393 } });
});

it("rejects any cropped box corner or nest extent, rather than passing centre-point visibility", () => {
  const area = { x0: 10, y0: 100, x1: 380, y1: 600 };
  const box = { screen: [[20, 110], [100, 110], [100, 550], [20, 550]] };
  const nests = [{ rect: { x0: 30, y0: 120, x1: 90, y1: 170 } }];
  expect(() => assertOpeningContainment(area, [box, box], nests)).not.toThrow();
  for (const p of [[9, 110], [20, 99], [381, 110], [20, 601], [NaN, 110]]) {
    expect(() => assertOpeningContainment(area, [box, { screen: [p, ...box.screen.slice(1)] }], nests)).toThrow("box is cropped");
  }
  for (const rect of [{ ...nests[0]!.rect, x0: 9 }, { ...nests[0]!.rect, y1: 601 }]) {
    expect(() => assertOpeningContainment(area, [box, box], [{ rect }])).toThrow("nest is cropped");
  }
  expect(() => assertOpeningContainment(area, [box], nests)).toThrow("both boxes");
  expect(() => assertOpeningContainment(area, [box, box], [])).toThrow("no starting nests");
});

type Pixel = [number, number, number, number];
const background: Pixel = [11, 8, 5, 255];
// Five distinct dark colours fooled the old distinct-colour-count guard.
const blank = { samples: Array.from({ length: 64 }, (_, i): Pixel => [11 + i % 5, 8, 5, 255]), background };
const painted = { samples: Array.from({ length: 64 }, (_, i): Pixel => [70 + i % 32, 45 + i % 17, 20, 255]), background };
function captureClient(tick = 0) {
  const evaluate = vi.fn().mockResolvedValue(painted);
  const frame = vi.fn().mockResolvedValue({ playbackTick: tick });
  const advance = vi.fn(), setOptions = vi.fn();
  const client = { page: { evaluate }, info: { rendererName: "babylon webgl2", mapW: 128, mapH: 96 },
    frame, advance, setOptions } as unknown as ClientPage;
  return { client, evaluate, frame, advance, setOptions };
}

describe("same-tick first-frame paint readiness", () => {
  it("rejects a five-colour blank frame and sparse markers rather than a false Chromium pass", () => {
    expect(new Set(blank.samples.map(p => p.join(","))).size).toBe(5);
    expect(boardPixelCheck(blank.samples, background).nonblank).toBe(false);
    const sparse = blank.samples.map((p, i) => i < 4 ? painted.samples[i]! : p);
    expect(boardPixelCheck(sparse, background).nonblank).toBe(false);
    expect(boardPixelCheck(painted.samples, background).nonblank).toBe(true);
  });

  it.each([0, 1, 1500])("settles at tick %s, retaining paint evidence without redrawing or moving time", async tick => {
    const c = captureClient(tick);
    c.evaluate.mockResolvedValueOnce(blank).mockResolvedValue(painted);
    const result = await prepareStartFrame(c.client, "3d", tick, "opening");
    expect(c.evaluate).toHaveBeenCalledTimes(2);
    expect(c.frame).toHaveBeenCalledExactlyOnceWith(false);
    expect(c.advance).not.toHaveBeenCalled();
    expect(c.setOptions).not.toHaveBeenCalled();
    expect(result.frame.playbackTick).toBe(tick);
    expect(result.primaryBoard).toMatchObject({ attempts: 2, playbackTick: tick, manualClockAdvanceMs: 0,
      first: { nonblank: false }, last: { nonblank: true } });
  });

  it("leaves 2D drawing on its existing path", async () => {
    const c = captureClient();
    expect((await prepareStartFrame(c.client, "2d", 0, "opening")).primaryBoard).toBeNull();
    expect(c.frame).toHaveBeenCalledExactlyOnceWith(true);
    expect(c.evaluate).not.toHaveBeenCalled();
  });

  it("rejects tick substitution and readback errors rather than retrying another scene", async () => {
    const c = captureClient(1);
    await expect(prepareStartFrame(c.client, "3d", 0, "opening")).rejects.toThrow("requested playback tick");
    expect(c.evaluate).not.toHaveBeenCalled();
    c.frame.mockResolvedValue({ playbackTick: 0 });
    c.evaluate.mockRejectedValue(new Error("WebGL readback failed"));
    await expect(prepareStartFrame(c.client, "3d", 0, "opening")).rejects.toThrow("WebGL readback failed");
    expect(c.advance).not.toHaveBeenCalled();
  });

  it("retains exhausted blank-paint evidence and fails within the existing real-time budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const c = captureClient();
    c.evaluate.mockResolvedValue(blank);
    const result = prepareStartFrame(c.client, "3d", 0, "opening");
    const rejected = expect(result).rejects.toBeInstanceOf(BlankPrimaryBoardError);
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    await expect(result).rejects.toMatchObject({ first: { nonblank: false }, last: { nonblank: false } });
    expect(c.frame).toHaveBeenCalledExactlyOnceWith(false);
    expect(c.advance).not.toHaveBeenCalled();
  });
});

describe.each(START_MAPS)("capture on %s", map => {
  it("requires all starting identities, both exact boxes and a subsequent real founding", () => {
    const observed = inspectStartRecording(fixture(map), map);
    expect(observed.queens).toHaveLength(4);
    expect(observed.boxes).toHaveLength(2);
    expect(observed.founding).toEqual({ tick: 1, colony: 0, id: 2 });
  });
});

it("retains exact historical rectangle checks at grid scale 2", () => {
  const messages = fixture("open-field"), full = messages[0]!.full!;
  expect(full.setup.gridScale).toBe(2);
  expect(() => inspectStartRecording(messages, "open-field")).not.toThrow();
  full.setup.startBoxes![0].width += 1;
  expect(() => inspectStartRecording(messages, "open-field")).toThrow();
});

function stripFixture(): StreamMessage[] {
  const messages = fixture("open-field"), setup = messages[0]!.full!.setup;
  setup.startBoxes = [{ x: 0, y: 0, width: 16 * S, height: 48 * S }, { x: 48 * S, y: 0, width: 16 * S, height: 48 * S }];
  return messages;
}

it("accepts exact serialized quarter-width/full-height strips at grid scale 2", () => {
  const messages = stripFixture();
  expect(inspectStartRecording(messages, "open-field").boxes).toEqual([
    { colony: 0, x: 0, y: 0, width: 16 * S, height: 48 * S },
    { colony: 1, x: 48 * S, y: 0, width: 16 * S, height: 48 * S },
  ]);
});

it.each([0, 1] as const)("rejects a mixed layout with historical colony %i", colony => {
  const messages = stripFixture();
  messages[0]!.full!.setup.startBoxes![colony] = fixture("open-field")[0]!.full!.setup.startBoxes![colony];
  expect(() => inspectStartRecording(messages, "open-field")).toThrow();
});

// One fine tile off each exact grid-scale-2 bound, as the reference checks were one tile off.
it.each([{ x: 50 * S - 1 }, { y: 12 * S + 1 }])("keeps historical mirror checks %j", bounds => {
  const messages = fixture("open-field");
  Object.assign(messages[0]!.full!.setup.startBoxes![1], bounds);
  expect(() => inspectStartRecording(messages, "open-field")).toThrow();
});

it.each([{ width: 16 * S - 1 }, { height: 48 * S - 1 }, { x: 1 }, { y: 1 }])("rejects malformed strip bounds %j", bounds => {
  for (const colony of [0, 1] as const) {
    const messages = stripFixture();
    Object.assign(messages[0]!.full!.setup.startBoxes![colony], bounds);
    expect(() => inspectStartRecording(messages, "open-field")).toThrow();
  }
});

it("rejects an absent or late opening frame", () => {
  expect(() => inspectStartRecording([], "open-field")).toThrow("opening full");
  const messages = fixture("open-field"); messages[0]!.tick = 1;
  expect(() => inspectStartRecording(messages, "open-field")).toThrow("first tick");
});

it("rejects mislabeled maps, false founding, and missing founding evidence", () => {
  expect(() => inspectStartRecording(fixture("open-field"), "central-lake")).toThrow("map does not match");
  const messages = fixture("open-field");
  messages[1]!.events = [{ kind: "queenFounded", queen: messages[0]!.full!.queens![0]! }];
  expect(() => inspectStartRecording(messages, "open-field")).toThrow("founding for a starting");
  messages[1]!.events = [];
  expect(() => inspectStartRecording(messages, "open-field")).toThrow("true in-play founding");
});

it("rejects a missing starting nest and a nest outside its actual box", () => {
  const messages = fixture("open-field");
  messages[0]!.full!.queens![0]!.x = 0;
  expect(() => inspectStartRecording(messages, "open-field")).toThrow("outside box");
  messages[0]!.full!.queens!.shift();
  expect(() => inspectStartRecording(messages, "open-field")).toThrow();
});
