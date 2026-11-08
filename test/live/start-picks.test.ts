import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { MAPS, PUBLIC_CONFIG, SUB, TERRAIN_RULES } from "../../src/sim/config.js";
import { foundQueen } from "../../src/sim/agents.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { SimEvent } from "../../src/sim/types.js";
import { GRID_SCALE_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage } from "../../src/live/format.js";
import { setupOf, SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { unpackMessages } from "../../src/live/snapshot.js";
import { LiveHub } from "../../src/live/hub.js";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { step } from "../../src/sim/step.js";
import { delivered, ManualClock, RecordedServer, served, SseClient } from "./helpers.js";

import { playable } from "../playable.ts";
import { sevenMapRotation } from "../sim/seven-map-rotation.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function finalized(mapId: string) {
  const config = { ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, mapId } };
  const seats = Array.from({ length: 4 }, (_, n) => [
    { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
  ]).flat();
  const lobby = new LobbyStart(7001, playable(config), seats, 0);
  expect(lobby.pick("left-3", 8, 24, 1)).toEqual({ ok: true });
  return lobby.finish(lobby.closesAt);
}

describe("finalized starting layout stream extension", () => {
  it.each(MAPS)("$name carries both exact boxes and every final picked/default nest", map => {
    const state = finalized(map.id), recorder = new SpectatorRecorder(state);
    const message = { ...recorder.initial(), full: recorder.initialFull() };
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    const decoded = decodeMessage(bytes), full = decoded.full!;
    // The reference boxes (2,12,12x24) and (50,12,12x24), doubled at grid scale 2.
    expect(full.setup.startBoxes).toEqual([{ x: 4, y: 24, width: 24, height: 48 }, { x: 100, y: 24, width: 24, height: 48 }]);
    expect(full.setup.startingQueenIds).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(full.queens).toHaveLength(8);
    expect(full.queens!.find(q => q.colony === 0 && q.id === 3)).toMatchObject({ x: 8.5 * 256, y: 24.5 * 256 });
    expect(full.setup.queens[0]).toEqual([full.queens![0].x, full.queens![0].y]);
    const reconnect = decodeMessage(encodeMessage(new SpectatorState(full, decoded.tick, decoded.ants).message()));
    expect(reconnect.full!.setup.startBoxes).toEqual(full.setup.startBoxes);
    expect(reconnect.full!.setup.startingQueenIds).toEqual(full.setup.startingQueenIds);
    const publicFull = decodeMessage(encodePublicMessage(message)).full!;
    expect(publicFull.setup.startBoxes).toEqual(full.setup.startBoxes);
    expect(publicFull.setup.startingQueenIds).toEqual(full.setup.startingQueenIds);
    expect(publicFull.setup.seed).toBeUndefined();
  });

  it.each(MAPS)("$name keeps original starting identities after a real founding and in a late reconnect", map => {
    const state = finalized(map.id), recorder = new SpectatorRecorder(state);
    const initial = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const observer = new SpectatorState(initial.full!, initial.tick, initial.ants);
    state.tick = state.config.queenFounding!.firstFoundTick!;
    state.colonies[0].foodStore = 10000;
    const spacing = state.config.queenFounding!.minDistanceTiles;
    let selected: { x: number; y: number } | undefined;
    for (let y = 0; y < state.config.mapHeight && !selected; y++) for (let x = 0; x < state.config.mapWidth && !selected; x++) {
      if (isBlockedTile(state.terrain, x, y) || state.colonies.some(c => c.queens!.some(q =>
        (x - Math.floor(q.queenX / SUB)) ** 2 + (y - Math.floor(q.queenY / SUB)) ** 2 < spacing ** 2))) continue;
      selected = { x, y };
    }
    expect(selected).toBeDefined();
    state.owner[selected!.y * state.config.mapWidth + selected!.x] = 0;
    const events: SimEvent[] = [];
    expect(foundQueen(state, 0, selected!.x, selected!.y, state.tick, events)).toBeNull();
    const delta = decodeMessage(encodeMessage({ ...recorder.record({ state, events, results: [] }), full: null }));
    expect(delta.events).toContainEqual(expect.objectContaining({ kind: "queenFounded", queen: expect.objectContaining({ id: 4 }) }));
    observer.apply(delta);
    const late = decodeMessage(encodeMessage(observer.message())).full!;
    expect(late.setup.startingQueenIds![0]).toEqual([0, 1, 2, 3]);
    expect(late.queens!.find(q => q.colony === 0 && q.id === 4)).toBeDefined();
    expect(setupOf(state).startingQueenIds).toEqual(late.setup.startingQueenIds);
  });

  it.each([60, 300])("withholds every finalized position and box until the %i-second live delay", async delaySeconds => {
    const clock = new ManualClock(), hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds } });
    const server = new RecordedServer(hub, clock);
    await server.listen();
    cleanup.push(() => server.close(), () => hub.close());
    const state = finalized("open-field");
    hub.startMatch(1, state);
    const client = await SseClient.connect(server.url("/live/1"));
    cleanup.push(() => client.close());
    const response = await served(server, 1);
    expect(response.writes.every(write => !write.text.includes("data:"))).toBe(true);
    expect(await (await fetch(server.url("/live/status"))).json()).not.toHaveProperty("startBoxes");
    // A real terminal tick allows the manual hub clock to play out this short match.
    clock.advance(1000 / state.config.ticksPerSecond);
    hub.pushTick(1, step(state, [], undefined, undefined, undefined, true));
    clock.advance(delaySeconds * 1000 - clock.now() - 1);
    expect(response.writes.every(write => !write.text.includes("data:"))).toBe(true);
    expect(client.messages).toEqual([]);
    clock.advance(1);
    await delivered(client, response);
    expect(client.messages[0]!.tick).toBe(0);
    expect(client.messages[0]!.full!.setup.startBoxes).toEqual(setupOf(state).startBoxes);
    expect(client.messages[0]!.full!.setup.startingQueenIds).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(client.messages[0]!.full!.queens).toHaveLength(8);
  });

  it("rejects partial, out-of-bounds or duplicate starting metadata", () => {
    const recorder = new SpectatorRecorder(finalized("open-field"));
    const make = () => ({ ...recorder.initial(), full: structuredClone(recorder.initialFull()) });
    const partial = make(); delete partial.full.setup.startingQueenIds;
    expect(() => encodeMessage(partial)).toThrow("supplied together");
    const badBox = make(); badBox.full.setup.startBoxes![0].width = 10000;
    expect(() => encodeMessage(badBox)).toThrow("starting box");
    const duplicates = make(); duplicates.full.setup.startingQueenIds![0] = [0, 0];
    expect(() => encodeMessage(duplicates)).toThrow("identities");
  });

  // A pre-program full setup no longer decodes; its delta frames still re-encode byte-identically.
  it("re-encodes pre-program recording deltas byte-identically, without inventing a starting layout", () => {
    const [setup, ...frames] = unpackMessages(readFileSync(new URL("./fixtures/historical-v4.bin", import.meta.url)));
    expect(() => decodeMessage(setup!)).toThrow("carries no grid scale");
    for (const frame of frames) {
      const message = decodeMessage(frame);
      expect(message.full).toBeNull();
      expect(Buffer.from(encodeMessage(message))).toEqual(Buffer.from(frame));
    }
  });
});

it.each(MAPS)("$name streams the new full-height strips and preserves them on public encoding/reconnect", map => {
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  const config = sevenMapRotation(newMatchConfig({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, mapId: map.id } }));
  const lobby = new LobbyStart(7001, playable(config), [{ identityId: "left", colony: 0 }, { identityId: "right", colony: 1 }], 0);
  const state = lobby.finish(lobby.closesAt), recorder = new SpectatorRecorder(state);
  const message = { ...recorder.initial(), full: recorder.initialFull() };
  const decoded = decodeMessage(encodeMessage(message));
  expect(decoded.full!.setup.startBoxes).toEqual([{ x: 0, y: 0, width: 32, height: 96 },
    { x: 96, y: 0, width: 32, height: 96 }]);
  expect(state.config.startArea).toBe("back-quarter");
  const reconnect = decodeMessage(encodeMessage(new SpectatorState(decoded.full!, decoded.tick, decoded.ants).message()));
  expect(reconnect.full!.setup.startBoxes).toEqual(decoded.full!.setup.startBoxes);
  expect(decodeMessage(encodePublicMessage(message)).full!.setup.startBoxes).toEqual(decoded.full!.setup.startBoxes);
});
