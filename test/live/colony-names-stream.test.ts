// An unrated match's drawn colony names ride the spectator stream's setup as additive version 26, so the watch and
// replay screens name its colonies as its agents saw them. A match without them (every rated match, and every match
// before this) keeps its version and bytes.
import { describe, expect, it } from "vitest";
import {
  COLONY_NAMES_STREAM_VERSION, RATING_DEVIATION_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage,
} from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";
import { createMatch } from "../../src/sim/map.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";

const initial = () => createMatch(17, playable({ ...HISTORICAL_CONFIG, matchTicks: 4 }));
const opening = (recorder: SpectatorRecorder) => encodeMessage({ ...recorder.initial(), full: recorder.initialFull() });

describe("a match's colony names on the spectator stream", () => {
  it("is a new version above every earlier one", () => {
    expect(COLONY_NAMES_STREAM_VERSION).toBeGreaterThan(RATING_DEVIATION_STREAM_VERSION);
  });

  it("carries an unrated match's drawn names in its opening snapshot, public copy and reconnect snapshot", () => {
    const names = drawColonyNames("unrated-lobby");
    const recorder = new SpectatorRecorder(initial(), { rated: false, colonyNames: names });
    expect(recorder.setup.colonyNames).toEqual(names);
    const bytes = opening(recorder);
    expect(bytes[2]).toBe(COLONY_NAMES_STREAM_VERSION);
    const decoded = decodeMessage(bytes);
    expect(decoded.full!.setup.colonyNames).toEqual(names);
    expect(decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })).full!.setup.colonyNames).toEqual(names);
    const reconnect = encodeMessage(new SpectatorState(decoded.full!, decoded.tick, decoded.ants).message());
    expect(reconnect[2]).toBe(COLONY_NAMES_STREAM_VERSION);
    expect(decodeMessage(reconnect).full!.setup.colonyNames).toEqual(names);
  });

  it("leaves a rated match's setup, version and bytes as they were", () => {
    const rated = new SpectatorRecorder(initial(), { rated: true });
    const bytes = opening(rated);
    expect(rated.setup).not.toHaveProperty("colonyNames");
    expect(bytes[2]).toBeLessThan(COLONY_NAMES_STREAM_VERSION);
    expect(decodeMessage(bytes).full!.setup).not.toHaveProperty("colonyNames");
    expect(Buffer.from(opening(new SpectatorRecorder(initial(), { rated: true }))).equals(Buffer.from(bytes))).toBe(true);
  });

  it("refuses an empty name rather than writing one", () => {
    const recorder = new SpectatorRecorder(initial(), { rated: false, colonyNames: ["", "Kobe A Colony"] });
    expect(() => opening(recorder)).toThrow("invalid colony names");
  });
});
