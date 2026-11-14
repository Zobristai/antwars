// An unrated match's drawn colony names ride the spectator stream's setup as additive version 26, so the watch and
// replay screens name its colonies as its agents saw them. A match without them (every rated match, and every match
// before this) keeps its version and bytes.
import { createHash } from "node:crypto";
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

// The rated opening snapshot of this fixture as the encoder wrote it before colony names existed: its length, version
// byte and SHA-256. A rated match must still write exactly these bytes.
const RATED_OPENING_BEFORE = {
  length: 13568,
  version: 18,
  sha256: "da055baf1053b5c7e04545d242e6883c5e1bbb3410cb011e29f7be4030490e19",
};

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

  it("leaves a rated match's setup, version and bytes exactly as they were before colony names", () => {
    const rated = new SpectatorRecorder(initial(), { rated: true });
    const bytes = opening(rated);
    expect(rated.setup).not.toHaveProperty("colonyNames");
    expect(bytes[2]).toBeLessThan(COLONY_NAMES_STREAM_VERSION);
    expect(decodeMessage(bytes).full!.setup).not.toHaveProperty("colonyNames");
    expect({ length: bytes.length, version: bytes[2], sha256: createHash("sha256").update(bytes).digest("hex") })
      .toEqual(RATED_OPENING_BEFORE);
  });

  it("refuses an empty name rather than writing one", () => {
    const recorder = new SpectatorRecorder(initial(), { rated: false, colonyNames: ["", "Sweetwater Colony"] });
    expect(() => opening(recorder)).toThrow("invalid colony names");
  });
});
