import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { arrivalSchedule, motionSummary, series, serveFixtureFile } from "../../web/capture/playback-pacing.ts";

describe("the paired built-client pacing measurement", () => {
  it("uses ordered arrivals with four ticks before a 1.1 second pause and later measured jitter", () => {
    const s = arrivalSchedule(122);
    expect(s.slice(0, 5)).toEqual([0, 100, 200, 300, 1400]);
    expect(s.slice(4, 15)).toEqual(Array(11).fill(1400));
    expect(s[50]).toBe(5133);
    expect(s[51]).toBe(5133);
    expect(s[90]).toBe(9050);
    expect(s.every((at, i) => i === 0 || at >= s[i - 1]!)).toBe(true);
  });

  it("does not count initial buffering as a freeze, and counts whole-tick catch-up separately", () => {
    const frame = (now: number, playback: number, waiting = false) => ({ now, playback, waiting });
    expect(motionSummary([frame(0, 0, true), frame(33, 0, true), frame(66, 0), frame(100, 34), frame(133, 67)]))
      .toEqual({ firstDrawMs: 66, postStartFreezeMs: 0, wholeTickCatchupFrames: 0 });
    expect(motionSummary([frame(0, 0), frame(33, 0), frame(66, 0), frame(100, 100), frame(133, 200)]))
      .toEqual({ firstDrawMs: 0, postStartFreezeMs: 66, wholeTickCatchupFrames: 2 });
  });

  it("returns a single 404 for missing fixtures and still serves valid assets after each miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "pacing-http-"));
    const content = "export const fixture = true;\n";
    await writeFile(join(root, "asset.js"), content);
    const server = createServer(async (req, res) => {
      const path = new URL(req.url!, "http://fixture.invalid").pathname;
      await serveFixtureFile(resolve(root, `.${path}`), res);
    });
    try {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ["/live/replays", "/missing.js"]) {
        const missing = await fetch(origin + path);
        expect(missing.status).toBe(404);
        expect(await missing.text()).toBe("");
        const valid = await fetch(origin + "/asset.js");
        expect(valid.status).toBe(200);
        expect(valid.headers.get("content-type")).toBe("text/javascript");
        expect(await valid.text()).toBe(content);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps empty timing evidence unavailable, not a zero-cost pass", () => {
    expect(series([])).toEqual({ count: 0, p50: null, p95: null, peak: null });
    expect(series([1, 10, 2, 3])).toEqual({ count: 4, p50: 2, p95: 10, peak: 10 });
  });
});
