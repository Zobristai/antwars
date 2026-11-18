import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { decodeMessage, encodeMessage, withoutKillTotals, type StreamMessage } from "../../src/live/format.ts";
import { decodeMessage as oldDecode } from "./fixtures/pre-queen-ranking-format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { RATED_DELAY_SECONDS } from "../../src/live/match-access.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock, RecordedServer, SseClient, type ServedResponse } from "./helpers.ts";

const map: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants", water: [],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
const config = newMatchConfig(rulesConfig("redesign"));
const lobbyId = "00000000-0000-4000-8000-000000000001";
const path = `/watch/live/${lobbyId}`;
const data = (response: ServedResponse) => response.writes.filter(w => w.text.startsWith("data: "));
const bytes = (text: string) => inflateRawSync(Buffer.from(text.slice(6).trim(), "base64"));

it("releases negotiated kill totals at exactly the same rated delay as the old readable stream, including reconnects and the result", async () => {
  const clock = new ManualClock();
  let encodes = 0;
  const hub = new LiveHub({ clock, encode: m => { encodes++; return encodeMessage(m); } });
  const server = new RecordedServer(hub, clock);
  const clients: SseClient[] = [];
  try {
    await server.listen();
    let state = createMatch(404, { ...config, matchTicks: 3, terrain: { ...config.terrain!, maps: [map] } });
    expect(state.colonies).toHaveLength(4);
    hub.startMatch(1, state, { lobbyId, visibility: "public", rated: true });
    for (const query of ["", "?kills=1", "?kills=1", "?kills=0"]) {
      clients.push(await SseClient.connect(server.url(path + query)));
    }
    const legacy = server.responses[0]!, modern = server.responses[1]!;
    // Labelled input fixture: attribution itself is checked against actual combat in the recorder tests.
    for (let tick = 1; tick <= 3; tick++) {
      clock.advance(100);
      state.colonies[0]!.kills = tick * 11;
      const out = step(state, []); hub.pushTick(1, out); state = out.state;
    }
    const delay = RATED_DELAY_SECONDS * 1000;
    clock.advance(delay - clock.now() - 1);
    for (const response of server.responses) expect(data(response)).toHaveLength(0);
    clock.advance(1);
    for (const response of server.responses) {
      expect(data(response).map(w => w.t)).toEqual([delay]);
      expect(decodeMessage(bytes(data(response)[0]!.text)).tick).toBe(0);
    }
    expect(decodeMessage(bytes(data(modern)[0]!.text)).full!.kills).toEqual([0, 0, 0, 0]);
    expect(oldDecode(bytes(data(legacy)[0]!.text)).full).not.toHaveProperty("kills");
    const before = encodes;
    clock.advance(100);
    // One modern delta and one legacy delta, not one encode per subscriber.
    expect(encodes - before).toBe(2);
    expect(decodeMessage(bytes(data(modern)[1]!.text)).events).toContainEqual({ kind: "kills", totals: [11, 0, 0, 0] });
    expect(data(modern).map(w => w.t)).toEqual(data(legacy).map(w => w.t));
    for (const query of ["", "?kills=1"]) clients.push(await SseClient.connect(server.url(path + query)));
    const lateLegacy = oldDecode(bytes(data(server.responses[4]!)[0]!.text));
    const lateModern = decodeMessage(bytes(data(server.responses[5]!)[0]!.text));
    expect(lateModern.tick).toBe(1); // The sim is already at tick 3; never leak its current totals.
    expect(lateModern.full!.kills).toEqual([11, 0, 0, 0]);
    expect(lateLegacy).toEqual(withoutKillTotals(lateModern));
    clock.advance(200);
    const oldMessages = data(legacy).map(w => oldDecode(bytes(w.text)));
    const newMessages = data(modern).map(w => decodeMessage(bytes(w.text)));
    expect(oldMessages).toEqual(newMessages.map(withoutKillTotals));
    expect(data(modern).map(w => w.t)).toEqual(data(legacy).map(w => w.t));
    expect(oldMessages.at(-1)!.events.some(e => e.kind === "end")).toBe(true);
    const first = newMessages[0]!;
    const spectator = new SpectatorState(first.full!, first.tick, first.ants);
    for (const message of newMessages.slice(1)) spectator.apply(message);
    expect(spectator.full.kills).toEqual(state.colonies.map(c => c.kills ?? 0));
    expect(spectator.full.result).not.toBeNull();
    clients.push(await SseClient.connect(server.url(path)));
    expect(oldDecode(bytes(data(server.responses[6]!)[0]!.text)).full!.result).not.toBeNull();
  } finally {
    clients.forEach(c => c.close()); hub.close(); await server.close();
  }
});

describe("kill telemetry down-conversion", () => {
  it("does not mutate recorded totals or other events", () => {
    const message = { tick: 7, ants: {}, full: { kills: [1, 2, 3, 4] }, events: [
      { kind: "kills", totals: [5, 6, 7, 8] }, { kind: "eliminated", colony: 1, tick: 6 },
    ] } as StreamMessage;
    const legacy = withoutKillTotals(message);
    expect(legacy.full).not.toHaveProperty("kills");
    expect(legacy.events).toEqual([{ kind: "eliminated", colony: 1, tick: 6 }]);
    expect(message.full!.kills).toEqual([1, 2, 3, 4]);
    expect(message.events).toHaveLength(2);
  });
});
