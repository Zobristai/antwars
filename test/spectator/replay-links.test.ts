import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { encodeReplayMessage } from "../../src/live/format.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { modeCopy, replayDate, replayPath } from "../../web/src/replay.ts";
import { openSource } from "../../web/src/source.ts";
import { isReplayId } from "../../src/replays/access.ts";
import { captureQuery } from "../../web/capture/browser.ts";
import { QualityController, WINDOW } from "../../web/src/board3d/quality.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const id = "2026-10-18T13-58-00-000Z-12";
afterEach(() => vi.unstubAllGlobals());

// The bundled recording is deleted: a plain ?replay has no path of its own; it resolves stored history first.
it("gives plain replay no bundled path and uses only same-origin stored paths for ids", () => {
  expect(() => replayPath(new URLSearchParams("replay"))).toThrow("This replay link has no match id.");
  expect(replayPath(new URLSearchParams(`replay=${id}`))).toBe(`/replays/${id}`);
  expect(captureQuery({ replay: true, recording: "unused", tilt: false }).get("replay")).toBe("");
  for (const invalid of ["1", "../agents.bin", "https://storage.googleapis.com/file", "2026-02-30T13-58-00-000Z-12", "2026-10-18T25-58-00-000Z-12", "2026-10-18T13-58-00-000Z-0", "2026-10-18T13-58-00-000Z-9007199254740992"]) {
    expect(() => replayPath(new URLSearchParams({ replay: invalid }))).toThrow(/invalid/);
    expect(replayDate(invalid) !== null).toBe(isReplayId(invalid));
  }
  expect(replayDate(id)).toBe("2026-10-18T13:58:00.000Z");
});

it("validates Gregorian dates exactly like the server without reading a wall clock", () => {
  for (const year of [0, 1, 1900, 2000, 2024, 2026, 2100, 9999]) {
    for (const month of [0, 1, 2, 4, 12, 13]) {
      for (const day of [0, 1, 28, 29, 30, 31, 32]) {
        const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23-59-59-999Z-1`;
        expect(replayDate(candidate) !== null, candidate).toBe(isReplayId(candidate));
      }
    }
  }
});

it("labels a full stored recording with its own date and end, never the bundled excerpt's", () => {
  expect(modeCopy("replay", 8, false, "/", id)).toMatchObject({ label: "RECORDING · not live · 8 agents", detail: "18 Oct 2026" });
  expect(modeCopy("replay", 8, true, "/", id).detail).toBe("· recording ended");
});

it("plays an unlisted stored id through the real shared source and playback without consulting discovery", async () => {
  const packets = unpackMessages(packMessages(scale2Packets(8)));
  const bytes = packMessages(packets.map((p) => encodeReplayMessage(decodeMessage(p))));
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    if (path === "/live/replays") return Response.json({ replays: [] });
    // The stored match's rating record; this one has none, so the recording's figures stay.
    if (path === `/watch/ratings/${id}`) return Response.json({ ratings: [] });
    expect(path).toBe(`/replays/${id}`);
    return new Response(new Uint8Array(bytes));
  });
  const doc = { title: "", getElementById: () => null, defaultView: { addEventListener() {} } } as unknown as Document;
  const reject = vi.fn();
  const source = (await openSource(new URLSearchParams({ replay: id }), { now: () => 0 }, doc, reject))!;
  const playback = new Playback();
  const frame = new Frame();
  for (let now = 0; now <= 2000; now += 100) {
    for (const { m, at } of source.take(now)) playback.push(m, at);
    playback.sample(source.now(now), frame);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(paths).toEqual([`/watch/ratings/${id}`, `/replays/${id}`]);
  expect(reject).not.toHaveBeenCalled();
  expect(frame.tick).toBe(decodeMessage(packets.at(-1)!).tick);
  expect(source.lastTick).toBe(frame.tick);
  expect(source.head.full!.setup).not.toHaveProperty("seed");
  expect(source.head.full!.setup).not.toHaveProperty("rules");
  source.close();
});

it("accelerated capture never counts skipped simulated frames as actual frame-cadence evidence", () => {
  const harness = readFileSync(new URL("../../web/capture/replay-phone.ts", import.meta.url), "utf8");
  expect(harness).toContain("window.__antwar.frame(false)");
  expect(harness).not.toContain("frame(i === 99)");
  expect(harness).toContain("nativePage.goto(`${origin}/?replay=${id}`)");
  // Reproduce the original failure: one draw per 100 accelerated ticks falsely looks like 0.1 FPS.
  const original = new QualityController(1);
  for (let i = 0; i < WINDOW; i++) expect(original.frame(i * 10_000)).toBe("hold");
  expect(original.frame(WINDOW * 10_000)).toBe("fallback");
  // The offline correctness capture draws only its checkpoints; cadence is checked on a normal-clock page.
  const checkpoints = new QualityController(1);
  for (const time of [0, 900_000, 1_800_000]) expect(checkpoints.frame(time)).toBe("hold");
});

it("all renderer branches use the shared loading and paced ingestion seam", () => {
  for (const path of ["../../web/src/main.ts", "../../web/src/board3d/main3d.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toMatch(/await openSource\(/);
    expect(source).toMatch(/input\.take\(realMs\)/);
    expect(source).toMatch(/input\.now\(realMs\)/);
    expect(source).not.toMatch(/loadRecording\(|REPLAY_PATH/);
  }
});
