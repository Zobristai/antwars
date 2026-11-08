import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { colonyStats, nextAntCells, nextAntState } from "../../web/src/overlays.ts";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { ECONOMY_PAIRS, economyFixture } from "../../web/capture/economy-slots.ts";

const hatch = { cost: 3, intervalTicks: 18, cap: 2000 };

describe("fixed economy slots", () => {
  it("loads the fixtures and the capture build helpers in native Node, without a bundler's asset transforms", () => {
    const script = new URL("../../web/capture/economy-slots.ts", import.meta.url).href;
    const buildHelpers = new URL("../../web/capture/capture.ts", import.meta.url).href;
    const loader = fileURLToPath(new URL("../../src/ts-resolve.mjs", import.meta.url));
    const output = execFileSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", `const capture = await import(${JSON.stringify(script)}); const helpers = await import(${JSON.stringify(buildHelpers)}); if (typeof helpers.prepare !== 'function') throw new Error('missing build helper'); console.log(capture.economyFixture('workers-ready').length);`], { encoding: "utf8", timeout: 4000 });
    expect(output.trim()).toBe("61");
  });
  it.each(ECONOMY_PAIRS)("drives paired %s through the actual public decoder and delayed playback, without joins or repeated full snapshots", (pair) => {
    const messages = economyFixture(pair).map((message) => decodeMessage(encodePublicMessage(message)));
    expect(messages[0]!.full!.agents).toEqual([]);
    expect(messages.slice(1).every((message, i) => message.full === null && message.tick === i + 1)).toBe(true);
    expect(messages.flatMap((message) => message.events).some((event) => event.kind === "join")).toBe(false);
    const playback = new Playback(), frame = new Frame();
    for (const message of messages) {
      playback.push(message, message.tick * TICK_MS);
      if (message.tick !== 10 && message.tick !== 40) continue;
      expect(playback.sample(message.tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
      const n = message.tick === 10 ? 1 : 999;
      for (const stats of colonyStats(frame)) {
        expect(stats).toEqual({ hatched: n, lost: n, workers: pair === "soldiers-waiting" ? 1 : n, soldiers: pair === "soldiers-waiting" ? n : 1 });
      }
      expect(frame.board!.stores[0].food).toBe(pair === "workers-shortage" ? (n === 1 ? 1 : 99998) : (n === 1 ? 7 : 99999));
    }
  });

  it.each([0, 1, 9, 10, 99, 100, 999, 9999, 10000, 99999, 100000])("keeps the complete formatted food/cost at %s", (n) => {
    const store = { food: n, nextCost: n + 1, nextHatchTick: 100 };
    const state = nextAntState(store, hatch, 10, 100, 10);
    expect(state).toEqual({ kind: "food", value: n + 1 });
    expect(nextAntCells(store, hatch, 10, 100, 10)).toEqual([`${n.toLocaleString("en")}/${(n + 1).toLocaleString("en")}`, "· Next ant"]);
  });

  it.each([1, 9, 10, 99, 100, 999])("preserves the delayed countdown %s without a second rule decision", (seconds) => {
    const store = { food: 99999, nextCost: 3, nextHatchTick: 100 + seconds * 10 };
    const state = nextAntState(store, hatch, 1, 100, 10);
    expect(state).toEqual({ kind: "waiting", value: seconds });
    expect(nextAntCells(store, hatch, 1, 100, 10)).toEqual(["99,999", `· Next ant ${seconds} s`]);
  });

  it("keeps missing hatch, cap, food-needed and ready precedence", () => {
    const store = { food: 0, nextCost: 6, nextHatchTick: 200 };
    expect(nextAntState(store, null, 3000, 100, 10)).toEqual({ kind: "unknown" });
    expect(nextAntState(store, hatch, 2000, 100, 10)).toEqual({ kind: "full" });
    expect(nextAntState(store, hatch, 1, 100, 10)).toEqual({ kind: "food", value: 6 });
    expect(nextAntState({ ...store, food: 6 }, hatch, 1, 200, 10)).toEqual({ kind: "ready" });
  });
});
