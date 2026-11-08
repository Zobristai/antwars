import { describe, expect, it } from "vitest";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, SUB } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { decodeMessage, encodeMessage, encodePublicMessage, GRID_SCALE_STREAM_VERSION, SUB_TILE, type StreamMessage } from "../../src/live/format.js";
import { PRE_FRONTLINE_PUBLIC_CONFIG } from "../sim/fixtures.js";

import { playable } from "../playable.ts";
/** A 128x96 grid-scale-2 board with water, a rock, an ant in the far corner and owned corner tiles. */
function fixture(): { recorder: SpectatorRecorder; message: StreamMessage } {
  const width = 128, height = 96;
  const config = { ...DEFAULT_CONFIG, mapWidth: width, mapHeight: height, foodPatches: [], gridScale: 2 as const,
    terrain: { referenceWidth: width, referenceHeight: height,
      maps: [{ id: "fine-fixture", name: "Fine fixture", water: [{ x: width / 2, y: 2, width: 1, height: 3 }] }] } };
  const made = createMatch(7001, config);
  const state = { ...made, terrain: { ...made.terrain!, rocks: [
    { x: 2, y: 3, width: 6, height: 2, appearance: 47 },
  ] } };
  state.ants[0]!.x = width * SUB - 4;
  state.ants[0]!.y = height * SUB - 4;
  state.owner[0] = 0;
  state.owner[width * height - 1] = 1;
  const recorder = new SpectatorRecorder(state);
  return { recorder, message: { ...recorder.initial(), full: recorder.initialFull() } };
}

describe("grid-scale stream metadata (every match plays at grid scale 2)", () => {
  const seats = Array.from({ length: 4 }, (_, n) => [
    { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
  ]).flat();

  it("combines finalized fine-grid starts, identity and ratings with grid scale 2 without scaling finalized coordinates twice", () => {
    const lobby = new LobbyStart(7001, withGridScale(PUBLIC_CONFIG), seats, 0);
    const state = step(lobby.finish(lobby.closesAt), [{ type: "join", agentId: "scale-test", colony: 0 }]).state;
    const recorder = new SpectatorRecorder(state, { rated: true,
      identity: () => ({ displayName: "owner/scale", elo: 1200.5 }) });
    const source = { ...recorder.initial(), full: recorder.initialFull() };
    // Protocol fixture, including a result payload, not a recorded match claim.
    source.full.result = { winner: 0, reason: "time_up", decidedBy: "territory", tick: 10,
      nextStartMs: null, ratingChanges: [{ agent: 0, before: 1200.5, after: 1216.5 }] };
    const bytes = encodeMessage(source);
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    const decoded = decodeMessage(bytes), full = decoded.full!;
    expect(full.setup.gridScale).toBe(2);
    expect(full.setup.rated).toBe(true);
    expect(full.result).toEqual(source.full.result);
    expect(full.setup.startBoxes).toEqual(source.full.setup.startBoxes);
    expect(full.setup.startingQueenIds).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(full.queens).toHaveLength(8);
    for (const queen of full.queens!) {
      const pick = state.config.initialQueens![queen.colony][queen.id]!;
      expect([queen.x, queen.y]).toEqual([(pick.tileX + 0.5) * SUB_TILE, (pick.tileY + 0.5) * SUB_TILE]);
    }
    expect(encodeMessage(decoded)).toEqual(bytes);
    const reconnect = decodeMessage(encodePublicMessage(new SpectatorState(full, decoded.tick, decoded.ants).message()));
    expect(reconnect.full!.setup.gridScale).toBe(2);
    expect(reconnect.full!.setup.startBoxes).toEqual(full.setup.startBoxes);
    expect(reconnect.full!.setup.startingQueenIds).toEqual(full.setup.startingQueenIds);
    expect(reconnect.full!.queens).toEqual(full.queens);
    expect(reconnect.full!.setup.rated).toBe(true);
    expect(reconnect.full!.agents[0]!.identity).toEqual({ displayName: "owner/scale", elo: 1200.5 });
  });

  it("round-trips grid scale 2, exact dimensions, geometry, wire positions and territory", () => {
    const { message } = fixture();
    for (const encode of [encodeMessage, encodePublicMessage]) {
      const bytes = encode(message);
      expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
      const decoded = decodeMessage(bytes);
      expect(decoded.full!.setup.gridScale).toBe(2);
      expect(decoded.full!.setup.mapW).toBe(128);
      expect(decoded.full!.setup.mapH).toBe(96);
      expect(decoded.full!.setup.terrain).toEqual(message.full!.setup.terrain);
      expect(decoded.ants).toEqual(message.ants);
      expect(decoded.ants.x[0]).toBe(128 * SUB_TILE - 1);
      expect(decoded.ants.y[0]).toBe(96 * SUB_TILE - 1);
      expect(decoded.full!.territory).toEqual(message.full!.territory);
    }
  });

  it("retains grid scale 2 through deltas and a reconnect snapshot", () => {
    const { message } = fixture();
    const first = decodeMessage(encodePublicMessage(message));
    const playback = new SpectatorState(first.full!, first.tick, first.ants);
    playback.apply(decodeMessage(encodeMessage({ ...message, full: null, tick: 1,
      events: [{ kind: "food", tiles: [128 * 96 - 1], amounts: [7] }] })));
    const reconnect = decodeMessage(encodePublicMessage(playback.message()));
    expect(reconnect.tick).toBe(1);
    expect(reconnect.full!.setup.gridScale).toBe(2);
    expect(reconnect.full!.setup.terrain).toEqual(first.full!.setup.terrain);
    expect(reconnect.full!.food![128 * 96 - 1]).toBe(7);
  });

  it("an ordinary match's first snapshot carries grid scale 2; its deltas keep their own versions", () => {
    const state = createMatch(42, playable(DEFAULT_CONFIG));
    const recorder = new SpectatorRecorder(state);
    const first = { ...recorder.initial(), full: recorder.initialFull() };
    expect(first.full.setup.gridScale).toBe(2);
    expect(encodeMessage(first)[2]).toBe(GRID_SCALE_STREAM_VERSION);
    const output = step(state, []);
    const delta = encodeMessage({ ...recorder.record(output), full: null });
    expect(delta[2]).toBeLessThan(GRID_SCALE_STREAM_VERSION);
    expect(decodeMessage(delta).tick).toBe(1);
  });

  it("refuses a full setup written without grid scale, at whatever earlier version it was written", () => {
    // Writers before the finer grid chose the version from the setup's features: a starting layout (16), identity
    // and ratings (17), rocks (12), or nothing beyond queens (5).
    const lobby = new LobbyStart(7001, playable(PRE_FRONTLINE_PUBLIC_CONFIG), seats, 0);
    const started = new SpectatorRecorder(lobby.finish(lobby.closesAt));
    const rated = new SpectatorRecorder(step(lobby.finish(lobby.closesAt), [{ type: "join", agentId: "scale-test", colony: 0 }]).state,
      { rated: true, identity: () => ({ displayName: "owner/scale", elo: 1200.5 }) });
    const ordinary = new SpectatorRecorder(createMatch(42, playable(DEFAULT_CONFIG)));
    const cases: [number, StreamMessage][] = [
      [16, { ...started.initial(), full: started.initialFull() }],
      [17, { ...rated.initial(), full: rated.initialFull() }],
      [12, structuredClone(fixture().message)],
      [5, { ...ordinary.initial(), full: ordinary.initialFull() }],
    ];
    for (const [version, message] of cases) {
      delete message.full!.setup.gridScale;
      const bytes = encodeMessage(message);
      expect(bytes[2]).toBe(version);
      expect(() => decodeMessage(bytes)).toThrow(`stream setup version ${version} carries no grid scale: every match plays at grid scale 2`);
    }
  });

  it("rejects any other grid scale from either source objects or the wire", () => {
    const { message } = fixture();
    for (const scale of [1, 3, 4]) {
      const malformed = structuredClone(message);
      (malformed.full!.setup as { gridScale: unknown }).gridScale = scale;
      expect(() => encodeMessage(malformed)).toThrow(`grid scale ${scale}`);
      const bytes = encodeMessage(message);
      // No events: final byte is their zero count; the scale byte immediately precedes it.
      expect(bytes.at(-2)).toBe(2);
      bytes[bytes.length - 2] = scale;
      expect(() => decodeMessage(bytes)).toThrow(`grid scale ${scale}`);
    }
    const unmarked = encodeMessage(message);
    unmarked[unmarked.length - 2] = 0;
    expect(() => decodeMessage(unmarked)).toThrow("grid scale missing");
  });
});
