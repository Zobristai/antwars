import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GRID_SCALE_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage, type StreamMessage, type StreamResult } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { PRE_FRONTLINE_CONFIGS } from "../sim/fixtures.ts";
import { step } from "../../src/sim/step.ts";

import { playable } from "../playable.ts";
const identity = { displayName: "owner/agent", elo: 1234.5, seatKey: "private-seat-key", accountId: "private-account-id" };
function fixture(rated?: boolean, config: SimConfig = rulesConfig("redesign")) {
  const state = step(createMatch(42, playable(config)), [{ type: "join", agentId: "internal-id", modelLabel: "self-reported model" }]).state;
  const recorder = new SpectatorRecorder(state, { rated, identity: id => id === "internal-id" ? identity : undefined });
  const message: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
  return { state, recorder, message };
}
const result: StreamResult = { winner: 0, reason: "time_up", decidedBy: "territory", tick: 10, nextStartMs: null };
const roundtrip = (message: StreamMessage) => decodeMessage(encodeMessage(message));

describe("spectator identity and rated outcome wire projection", () => {
  it.each([true, false, undefined])("roundtrips player display and Elo, keeping rated=%s distinct from historical absence", rated => {
    const { message } = fixture(rated);
    const bytes = encodePublicMessage(message), restored = decodeMessage(bytes);
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(restored.full!.setup.rated).toBe(rated);
    expect(restored.full!.agents[0]!.identity).toEqual({ displayName: "owner/agent", elo: 1234.5 });
    expect(restored.full!.agents[0]!.modelLabel).toBe("self-reported model");
    expect(restored.full!.setup).not.toHaveProperty("seed");
    expect(restored.full!.setup).not.toHaveProperty("rules");
    for (const privateValue of [identity.seatKey, identity.accountId, "internal-id"]) expect(Buffer.from(bytes).includes(Buffer.from(privateValue))).toBe(false);
  });

  // Pre-grid-scale-2 version-16/17 byte baselines no longer decode; the composition is kept at grid scale 2.
  it("composes starting layout with spectator metadata in a grid-scale-2 snapshot", () => {
    const { state } = fixture(undefined, PRE_FRONTLINE_CONFIGS.redesign);
    const recorder = new SpectatorRecorder(state);
    const historical = { ...recorder.initial(), full: recorder.initialFull() };
    const boxes = [{ x: 2, y: 12, width: 12, height: 24 }, { x: 50, y: 12, width: 12, height: 24 }] as [
      { x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number },
    ];
    historical.full.setup.startBoxes = boxes;
    historical.full.setup.startingQueenIds = [[0], [0]];
    const bytes = encodeMessage(historical);
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    const old = decodeMessage(bytes);
    expect(old.full!.setup.startBoxes).toEqual(boxes);
    expect(old.full!.setup.startingQueenIds).toEqual([[0], [0]]);
    expect(old.full!.setup).not.toHaveProperty("rated");
    expect(old.full!.agents[0]).not.toHaveProperty("identity");

    const combined = structuredClone(historical);
    combined.full.setup.rated = true;
    combined.full.agents[0]!.identity = { displayName: "owner/agent", elo: 1234.5 };
    combined.full.result = { ...result, ratingChanges: [{ agent: 0, before: 1234.5, after: 1250.5 }] };
    const composed = encodeMessage(combined);
    expect(composed[2]).toBe(GRID_SCALE_STREAM_VERSION);
    const restored = decodeMessage(composed);
    expect(restored.full!.setup.startBoxes).toEqual(boxes);
    expect(restored.full!.setup.startingQueenIds).toEqual([[0], [0]]);
    expect(restored.full!.setup.rated).toBe(true);
    expect(restored.full!.agents[0]!.identity).toEqual(combined.full.agents[0]!.identity);
    expect(restored.full!.result).toEqual(combined.full.result);
  });

  it("captures opening ratings before a later account update, not when delayed playback opens", () => {
    const { state } = fixture();
    const current = { displayName: "owner/agent", elo: 1000 };
    const recorder = new SpectatorRecorder(state, { rated: true, identity: () => current });
    current.elo = 1016;
    current.displayName = "renamed";
    expect(recorder.initialFull().agents[0]!.identity).toEqual({ displayName: "owner/agent", elo: 1000 });
  });

  it("projects identity on incremental joins and retains it in reconnect snapshots", () => {
    let state = createMatch(42, playable(rulesConfig("redesign")));
    const recorder = new SpectatorRecorder(state, { rated: false, identity: () => identity });
    const opening = roundtrip({ ...recorder.initial(), full: recorder.initialFull() });
    const viewer = new SpectatorState(opening.full!, opening.tick, opening.ants);
    const out = step(state, [{ type: "join", agentId: "internal-id", modelLabel: "self-reported model" }]);
    const delta = roundtrip({ ...recorder.record(out), full: null });
    expect(delta.events.find(event => event.kind === "join")).toMatchObject({ identity: { displayName: "owner/agent", elo: 1234.5 } });
    viewer.apply(delta);
    // The existing call clock needs the accepted join call, as the real MCP feed emits it.
    viewer.apply({ tick: 2, ants: delta.ants, events: [{ kind: "call", agent: 0, call: "join", accepted: true }] });
    expect(roundtrip(viewer.message()).full!.agents[0]!.identity).toEqual({ displayName: "owner/agent", elo: 1234.5 });
  });

  it("reveals rating changes only when the final-result record is applied and retains them on reconnect", () => {
    const opening = roundtrip(fixture(true).message);
    const viewer = new SpectatorState(opening.full!, opening.tick, opening.ants);
    expect(viewer.full.result).toBeNull();
    const final = { ...result, ratingChanges: [{ agent: 0, before: 1234.5, after: 1250.25 }] };
    const delta = roundtrip({ tick: 11, ants: opening.ants, full: null, events: [{ kind: "end", result: final }] });
    expect(viewer.full.result).toBeNull();
    viewer.apply(delta);
    expect(viewer.full.result).toEqual(final);
    expect(roundtrip(viewer.message()).full!.result).toEqual(final);
    expect(roundtrip({ ...opening, full: null, events: [{ kind: "end", result }] }).events).toEqual([{ kind: "end", result }]);
  });

  it("keeps metadata-free messages free of spectator metadata and byte-identical", () => {
    const initial = createMatch(42, playable(rulesConfig("redesign")));
    const ordinary = new SpectatorRecorder(initial);
    const explicitAbsent = new SpectatorRecorder(initial, { rated: undefined, identity: () => undefined });
    const bytes = encodeMessage({ ...ordinary.initial(), full: ordinary.initialFull() });
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(encodeMessage({ ...explicitAbsent.initial(), full: explicitAbsent.initialFull() })).toEqual(bytes);
    const restored = decodeMessage(bytes);
    expect(restored.full!.setup).not.toHaveProperty("rated");
  });

  it("bounds display names at UTF-8 boundaries without adding secret fields", () => {
    const { state } = fixture();
    const recorder = new SpectatorRecorder(state, { identity: () => ({ displayName: "界".repeat(200), elo: 1000 }) });
    const display = roundtrip({ ...recorder.initial(), full: recorder.initialFull() }).full!.agents[0]!.identity!;
    expect(Buffer.byteLength(display.displayName)).toBe(255);
    expect(display.displayName).not.toContain("�");
  });

  it("preserves finite negative Elo values supported by the authoritative rating store", () => {
    const { message } = fixture(true);
    message.full!.agents[0]!.identity = { displayName: "owner/agent", elo: -2.5 };
    expect(roundtrip(message).full!.agents[0]!.identity?.elo).toBe(-2.5);
  });

  it("rejects corrupt ratings and duplicate result entries instead of displaying invented numbers", () => {
    const { message } = fixture(true);
    for (const elo of [NaN, Infinity, -Infinity]) {
      const bad = structuredClone(message); bad.full!.agents[0]!.identity = { displayName: "owner/agent", elo };
      expect(() => encodeMessage(bad)).toThrow("rating");
    }
    const change = { agent: 0, before: 1200, after: 1216 };
    expect(() => encodeMessage({ ...message, full: null, events: [{ kind: "end", result: { ...result, ratingChanges: [change, change] } }] })).toThrow("rating agent");
  });

  // Written by the writer at main 6e6b73b9 (builder handle since replaced, same length), before a seat could carry no rating: an opening snapshot with
  // a rated house seat, a rated builder's join, twelve ticks and a reconnect snapshot carrying both.
  const PRE_CHANGE = new Uint8Array(readFileSync(new URL("./fixtures/rated-identity-6e6b73b9.bin", import.meta.url)));
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const house = { displayName: "antwars/red", elo: 1687.25 }, builder = { displayName: "kite", elo: 1234.5 };

  it("decodes and replays a recording written before a seat could carry no rating, with every seat's name and rating", () => {
    expect([PRE_CHANGE.length, sha256(PRE_CHANGE)]).toEqual([33815, "22de4266da2000850dd93eeec6ded85c5f408b110b5dcc094aba67b0f36e8368"]);
    const messages = unpackMessages(PRE_CHANGE).map(bytes => decodeMessage(bytes));
    expect(messages).toHaveLength(14);
    const [opening, ...rest] = messages;
    expect(opening!.full!.agents.map(a => a.identity)).toEqual([house]);
    expect(rest[0]!.events.find(event => event.kind === "join")).toMatchObject({ identity: builder });
    const viewer = new SpectatorState(opening!.full!, opening!.tick, opening!.ants);
    for (const message of rest.slice(0, -1)) viewer.apply(message);
    expect(viewer.full.agents.map(a => a.identity)).toEqual([house, builder]);
    expect(rest.at(-1)!.full!.agents.map(a => a.identity)).toEqual([house, builder]);
  });

  it("encodes a seat with a rating byte-for-byte as before; only a seat without one is written differently", () => {
    const messages = unpackMessages(PRE_CHANGE).map(bytes => decodeMessage(bytes));
    const again = packMessages(messages.map(message => encodePublicMessage(message)));
    expect([again.length, sha256(again)]).toEqual([PRE_CHANGE.length, sha256(PRE_CHANGE)]);

    // The same opening with the house seat unrated: presence 2 and the name, no rating, so exactly 8 bytes fewer.
    const opening = messages[0]!, rated = encodePublicMessage(opening);
    const unrated = structuredClone(opening);
    unrated.full!.agents[0]!.identity = { displayName: house.displayName };
    const bytes = encodePublicMessage(unrated);
    expect(bytes.length).toBe(rated.length - 8);
    const restored = decodeMessage(bytes).full!.agents[0]!.identity!;
    expect(restored).toEqual({ displayName: house.displayName });
    expect(restored).not.toHaveProperty("elo");
    expect(encodePublicMessage(decodeMessage(bytes))).toEqual(bytes);
  });

  it("carries a seat without a rating through the recorder, incremental joins and reconnect snapshots", () => {
    let state = createMatch(42, playable(rulesConfig("redesign")));
    const recorder = new SpectatorRecorder(state, { rated: false, identity: () => ({ displayName: "antwars/red" }) });
    const opening = roundtrip({ ...recorder.initial(), full: recorder.initialFull() });
    const viewer = new SpectatorState(opening.full!, opening.tick, opening.ants);
    const out = step(state, [{ type: "join", agentId: "internal-id", modelLabel: "house model" }]);
    state = out.state;
    const delta = roundtrip({ ...recorder.record(out), full: null });
    const joined = delta.events.find(event => event.kind === "join")!;
    expect(joined).toMatchObject({ identity: { displayName: "antwars/red" } });
    expect((joined as { identity?: object }).identity).not.toHaveProperty("elo");
    viewer.apply(delta);
    expect(roundtrip(viewer.message()).full!.agents[0]!.identity).toEqual({ displayName: "antwars/red" });
  });
});
