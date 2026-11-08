import { describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, storesOf } from "../../src/live/model.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { colonyCardLines, colonyLedger, nextHatchCaste, scoreHatchStatus } from "../../web/src/overlays.ts";
import { playable } from "../playable.ts";

function board() {
  const recorder = new SpectatorRecorder(createMatch(228, playable(rulesConfig("redesign"))));
  const playback = new Playback(), frame = new Frame();
  playback.push(decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })), 0);
  expect(playback.sample(RENDER_DELAY_MS, frame)).toBe(true);
  return frame.board!;
}
describe("clean spectator score", () => {
  it("folds starting ants into Hatched without altering recorded event totals, including legacy recordings", () => {
    for (const hatched of [121, null]) {
      const stats = { hatched, lost: 100, workers: 51, soldiers: 0 };
      expect(colonyCardLines(colonyLedger(stats, 51, { cap: 150 }), stats, "").hatched).toBe("151");
      expect(stats.hatched).toBe(hatched);
    }
  });
  it.each(["v4", "count-marks", "redesign"] as const)("identifies %s next-caste costs from the actual server projection", name => {
    const state = createMatch(228, playable(rulesConfig(name)));
    const recorder = new SpectatorRecorder(state);
    const b = { ...board(), setup: recorder.initialFull().setup, hatch: recorder.initialFull().hatch! };
    for (const caste of ["worker", "soldier"] as const) {
      state.colonies[0].mixedNext = caste;
      const cost = storesOf(state)[0].nextCost;
      expect(nextHatchCaste(b, cost)).toBe(caste);
    }
  });
  it("uses streamed HP for redacted redesign, never guesses a legacy caste or unknown price", () => {
    const b = board();
    expect(b.setup.rules).toBeUndefined();
    expect(nextHatchCaste(b, 3)).toBe("worker");
    expect(nextHatchCaste(b, 6)).toBe("soldier");
    const legacy = { ...b, queens: b.queens!.map(({ hp: _hp, ...q }) => q) };
    expect(nextHatchCaste(legacy, 3)).toBeNull();
    expect(nextHatchCaste({ ...b, hatch: { ...b.hatch!, cost: 6 } }, 6)).toBeNull();
    expect(nextHatchCaste(b, 9)).toBeNull();
    expect(nextHatchCaste({ ...b, setup: { ...b.setup, rules: "future" as "v4" } }, 3)).toBeNull();
  });
  it("ages eligibility only with playback ticks and shows worker/soldier icons when known", () => {
    const original = board();
    const b = { ...original, stores: [{ food: 99, nextCost: 3, nextHatchTick: 101 }, original.stores[1]] as const };
    expect(scoreHatchStatus(b, 0, 1, 90).text).toBe("⛏ 2 s");
    expect(scoreHatchStatus(b, 0, 1, 100).text).toBe("⛏ 1 s");
    expect(scoreHatchStatus(b, 0, 1, 101).text).toBe("⛏ Eligible");
    const soldier = { ...b, stores: [{ ...b.stores[0], nextCost: 6 }, b.stores[1]] as const };
    expect(scoreHatchStatus(soldier, 0, 1, 100).text).toBe("⚔ 1 s");
    const legacy = { ...b, queens: b.queens!.map(({ hp: _hp, ...q }) => q) };
    expect(scoreHatchStatus(legacy, 0, 1, 100)).toMatchObject({ text: "1 s", description: expect.stringContaining("caste unknown") });
  });
  it("does not imply a hatch through food, capacity, unknown rules, extinction or match end", () => {
    const original = board();
    const b = { ...original, stores: [{ food: 0, nextCost: 6, nextHatchTick: 101 }, original.stores[1]] as const };
    expect(scoreHatchStatus(b, 0, 1, 100).text).toBe("⚔ Needs food");
    expect(scoreHatchStatus(b, 0, b.hatch!.cap, 100).text).toBe("Cap reached");
    expect(scoreHatchStatus({ ...b, hatch: null }, 0, 1, 100).text).toBe("Hatch unknown");
    expect(scoreHatchStatus({ ...b, hatch: { ...b.hatch!, cap: 0 } }, 0, 1, 100).text).toBe("Hatch unknown");
    expect(scoreHatchStatus({ ...b, queens: [] }, 0, 1, 100).text).toBe("No queens");
    expect(scoreHatchStatus({ ...b, queens: b.queens!.map(q => ({ ...q, lostTick: 90 })) }, 0, 1, 100).text).toBe("No queens");
    expect(scoreHatchStatus(b, 0, 1, b.setup.matchTicks).text).toBe("Ended");
    expect(scoreHatchStatus({ ...b, result: { winner: 0, reason: "time_up", decidedBy: "territory", tick: 99, nextStartMs: null } }, 0, 1, 100).text).toBe("Ended");
  });
});
