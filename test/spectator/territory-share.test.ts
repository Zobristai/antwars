/**
 * Playback must not award unclaimed ground to either colony: the held tiles both HUDs' territory rows read, as the
 * stream claims them and as a new match clears them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StreamFull, StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";

/** The streamed board's held tiles as playback reaches each message: what both HUDs' territory rows read (Board.held). */
function spectator() {
  const playback = new Playback();
  const frame = new Frame();
  return {
    show(message: StreamMessage) {
      playback.push(message, message.tick * TICK_MS);
      expect(playback.sample(1e9, frame)).toBe(true);
      return frame.board!.held;
    },
  };
}

function full(held: [number, number], match = 1): StreamMessage {
  const territory = new Uint8Array(64);
  territory.fill(1, 0, held[0]);
  territory.fill(2, held[0], held[0] + held[1]);
  const board: StreamFull = {
    match,
    setup: { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] },
    territory,
    agents: [], marks: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null,
  };
  return {
    tick: 0,
    ants: { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) },
    full: board,
    events: [],
  };
}

describe("territory held with no held tiles", () => {
  it("holds none for either colony when the streamed board has no held tiles", () => {
    expect(spectator().show(full([0, 0]))).toEqual([0, 0]);
  });

  it.each([1, 2])("counts the first tile colony owner %i claims", (owner) => {
    const view = spectator();
    const opening = full([0, 0]);
    view.show(opening);
    expect(view.show({ ...opening, tick: 1, full: null, events: [{ kind: "territory", tiles: [0], owners: [owner] }] })).toEqual(owner === 1 ? [1, 0] : [0, 1]);
  });

  it.each([[6, 2], [2, 6], [1, 2], [2, 1], [1, 15], [15, 1], [1, 1]])("reads %i and %i held tiles", (a, b) => {
    expect(spectator().show(full([a, b]))).toEqual([a, b]);
  });

  it("clears the previous match's held tiles on an empty new match, then resumes", () => {
    const view = spectator();
    expect(view.show(full([6, 2]))).toEqual([6, 2]);
    expect(view.show(full([0, 0], 2))).toEqual([0, 0]);
    const next = full([0, 0], 2);
    expect(view.show({ ...next, tick: 1, full: null })).toEqual([0, 0]);
    expect(view.show({ ...next, tick: 2, full: null, events: [{ kind: "territory", tiles: [0, 1, 2, 3], owners: [1, 1, 1, 2] }] })).toEqual([3, 1]);
  });
});

describe("empty-track styling and renderer wiring", () => {
  it("keeps the colony colour tokens the fills use", () => {
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    const token = (name: string) => html.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
    expect(token("aw-c1")).toBe("#00c2ff");
    expect(token("aw-c0")).toBe("#ffb000");
  });

  it.each(["../../web/src/main.ts", "../../web/src/board3d/main3d.ts"])("updates the shared HTML overlay in %s", (entry) => {
    const source = readFileSync(new URL(entry, import.meta.url), "utf8");
    expect(source).toMatch(/import \{ Overlays \} from "\.{1,2}\/overlays\.ts"/);
    expect(source).toMatch(/const overlays = new Overlays\(/);
    expect(source).toMatch(/overlays\.update\(frame\)/);
  });
});
