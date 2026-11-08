/** The two colonies' stats come from the same delayed stream tick.
 * Optional hatch fixtures exercise the field contract without owning its codec.
 */
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type StreamAnts, type StreamFull, type StreamMessage } from "../../src/live/format.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { RECORD_CONFIG, playScripted, recordLog } from "../../src/live/record.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { colonyCardLines, colonyLedger, colonyStats } from "../../web/src/overlays.ts";
import { playable } from "../playable.ts";

function ants(colonies: number[], castes?: number[]): StreamAnts {
  const count = colonies.length;
  return { count, id: Uint32Array.from(colonies, (_, i) => i + 1), x: new Uint16Array(count), y: new Uint16Array(count), heading: new Uint8Array(count), colony: Uint8Array.from(colonies), agent: new Int16Array(count).fill(-1), ...(castes ? { caste: Uint8Array.from(castes) } : {}) };
}
function full(match = 1, hatched?: [number, number]): StreamFull {
  return {
    match, setup: { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] },
    territory: new Uint8Array(64), agents: [], marks: [], overrun: [0, 0], overrunRequired: 100, deaths: [7, 12], result: null,
    ...(hatched ? { hatched } : {}),
  };
}
function sample(playback: Playback, now = 1e9): Frame {
  const frame = new Frame();
  expect(playback.sample(now, frame)).toBe(true);
  return frame;
}

describe("per-colony score stats", () => {
  it("reads independent cumulative hatch/death pairs and splits living ants by caste", () => {
    const playback = new Playback();
    const snapshot = full(1, [101, 202]);
    playback.push({ tick: 100, full: snapshot, ants: ants([0, 1, 0, 1, 1], [0, 1, 1, 0, 0]), events: [] }, 10_000);
    const frame = sample(playback);
    expect(colonyStats(frame)).toEqual([
      { hatched: 101, lost: 7, workers: 1, soldiers: 1 },
      { hatched: 202, lost: 12, workers: 2, soldiers: 1 },
    ]);
    // Later sender mutation cannot alter an already held/displayed tick.
    snapshot.hatched![0] = 999;
    expect(colonyStats(frame)[0].hatched).toBe(101);
    frame.corpses.push({ antId: 999, colony: 0, x: 0, y: 0, heading: 0, ageMs: 10 });
    expect(colonyStats(frame)[0].workers).toBe(1);
  });

  it("defaults missing caste to worker and unknown hatch history to unknown, not living plus dead", () => {
    const playback = new Playback();
    playback.push({ tick: 100, full: full(), ants: ants([0, 0, 1]), events: [] }, 10_000);
    expect(colonyStats(sample(playback))).toEqual([
      { hatched: null, lost: 7, workers: 2, soldiers: 0 },
      { hatched: null, lost: 12, workers: 1, soldiers: 0 },
    ]);
  });

  // Moved from the retired sheet-close.test.ts: the 2D HUD's colony drawer reads these figures (ui/hud.ts colonyCardLines).
  // Catches: hatched shown as the legacy total rather than alive plus lost, or the figures not following a later snapshot.
  it("gives each colony's figures from its snapshot and caste arrays, and follows a later snapshot", () => {
    const playback = new Playback();
    playback.push({ tick: 10, full: { ...full(1, [15, 24]), deaths: [3, 4] }, ants: ants([0, 1, 1], [1, 0, 1]), events: [] }, 1000);
    const figures = (frame: Frame) => colonyStats(frame).map((stats) => {
      const lines = colonyCardLines(colonyLedger(stats, stats.workers + stats.soldiers, frame.board!.hatch), stats, "");
      return [[lines.hatched, lines.lost, lines.alive, lines.cap], lines.castes];
    });
    expect(figures(sample(playback))).toEqual([[["4", "\u22123", "1", "—"], "0 workers · 1 soldier"], [["6", "\u22124", "2", "—"], "1 worker · 1 soldier"]]);
    playback.push({ tick: 20, full: { ...full(1, [15, 24]), deaths: [5, 4] }, ants: ants([1, 1], [0, 0]), events: [] }, 2000);
    expect(figures(sample(playback))).toEqual([[["5", "\u22125", "0", "—"], "0 workers · 0 soldiers"], [["6", "\u22124", "2", "—"], "2 workers · 0 soldiers"]]);
  });

  it("updates deaths and the living split only when delayed playback reaches their message", () => {
    const playback = new Playback();
    const first: StreamMessage = { tick: 100, full: full(), ants: ants([0, 1], [0, 1]), events: [] };
    const next: StreamMessage = { tick: 101, full: null, ants: ants([1, 1], [1, 0]), events: [{ kind: "death", antId: 1, colony: 0, x: 0, y: 0 }, { kind: "birth", antId: 2 }] };
    playback.push(first, 100 * TICK_MS);
    playback.push(next, 101 * TICK_MS);
    const before = sample(playback, 100 * TICK_MS + RENDER_DELAY_MS);
    expect(colonyStats(before).map((s) => [s.lost, s.workers, s.soldiers])).toEqual([[7, 1, 0], [12, 0, 1]]);
    const after = sample(playback, 101 * TICK_MS + RENDER_DELAY_MS);
    expect(colonyStats(after).map((s) => [s.lost, s.workers, s.soldiers])).toEqual([[8, 0, 0], [12, 1, 1]]);
    expect(colonyStats(after).map((s) => s.hatched)).toEqual([null, null]);
  });

  it("restores reported cumulative hatch totals on reconnect and resets them on a different or historical match", () => {
    const playback = new Playback();
    playback.push({ tick: 100, full: full(1, [101, 202]), ants: ants([0, 1]), events: [] }, 10_000);
    playback.push({ tick: 150, full: full(1, [120, 210]), ants: ants([1]), events: [] }, 15_000);
    expect(colonyStats(sample(playback)).map((s) => s.hatched)).toEqual([120, 210]);
    playback.push({ tick: 0, full: full(2, [0, 0]), ants: ants([]), events: [] }, 16_000);
    expect(colonyStats(sample(playback)).map((s) => s.hatched)).toEqual([0, 0]);
    playback.push({ tick: 0, full: full(3), ants: ants([0]), events: [] }, 17_000);
    expect(colonyStats(sample(playback)).map((s) => s.hatched)).toEqual([null, null]);
  });

  it.each([PUBLIC_CONFIG, HISTORICAL_CONFIG])("updates real v5 hatch totals only at the delayed tick and restores them on reconnect (%#)", (base) => {
    const state = createMatch(42, playable({ ...base, startAnts: 0 }));
    state.colonies[0].foodStore = state.config.hatchCost;
    state.colonies[1].foodStore = state.config.hatchCost;
    const recorder = new SpectatorRecorder(state);
    const first = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const playback = new Playback();
    playback.push(first, 0);
    const before = sample(playback, RENDER_DELAY_MS);
    const earlierBoard = before.board!;
    const out = step(state);
    playback.push(decodeMessage(encodeMessage({ ...recorder.record(out), full: null })), TICK_MS);
    expect(colonyStats(sample(playback, RENDER_DELAY_MS)).map((s) => s.hatched)).toEqual([0, 0]);
    expect(colonyStats(sample(playback, TICK_MS + RENDER_DELAY_MS)).map((s) => s.hatched)).toEqual([1, 1]);
    expect(earlierBoard.hatched).toEqual([0, 0]);
    const reconnect = decodeMessage(encodeMessage({ ...new SpectatorRecorder(out.state).initial(), full: new SpectatorRecorder(out.state).initialFull() }));
    playback.push(reconnect, 5_000);
    expect(colonyStats(sample(playback, 5_000 + RENDER_DELAY_MS)).map((s) => s.hatched)).toEqual(out.state.stats.hatched);
  });

  it("keeps historical queen progress delayed and earlier v5 boards immutable", () => {
    const recorder = new SpectatorRecorder(createMatch(42, playable(HISTORICAL_CONFIG)));
    const first = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const playback = new Playback();
    playback.push(first, 0);
    const earlier = sample(playback, RENDER_DELAY_MS).board!;
    playback.push(decodeMessage(encodeMessage({ tick: 1, full: null, ants: first.ants, events: [{ kind: "overrun", colony: 0, progress: 453, required: 600 }] })), TICK_MS);
    expect(sample(playback, RENDER_DELAY_MS).board!.queens![0]!.overrun).toBe(0);
    expect(sample(playback, TICK_MS + RENDER_DELAY_MS).board!.queens![0]!.overrun).toBe(453);
    expect(earlier.queens![0]!.overrun).toBe(0);
  });

  it("shows known hatch totals throughout a whole scripted recording", () => {
    // The bundled recording is deleted: a scripted grid-scale-2 match recorded in process, its totals the sim's own.
    const { lines, state } = playScripted({ seed: 6006, config: RECORD_CONFIG, agents: 10, ticks: 300, attack: true });
    const messages = recordLog(lines, 300).map(decodeMessage);
    const playback = new Playback();
    for (const message of messages) playback.push(message, message.tick * TICK_MS);
    expect(state.stats.hatched.every((n) => n > 0)).toBe(true);
    expect(colonyStats(sample(playback)).map((s) => s.hatched)).toEqual(state.stats.hatched);
  });
});
