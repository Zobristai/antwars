// Queen bites on the spectator stream (version 32): the recorder sends each fighting queen's biters and her own target
// as event 25 on the tick they bite; only a message carrying one selects 32, so every other message keeps its version and
// bytes; a full message restates the bites under way; a live page that has not opted in gets the earlier form.
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import {
  FLYER_STREAM_VERSION, KILLS_STREAM_VERSION, LIVE_OPT_INS, QUEEN_BITES_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage,
  QUEEN_KILLS_STREAM_VERSION, withoutKillTotals, withoutQueenBites, withoutQueenKills, type StreamEvent, type StreamMessage,
} from "../../src/live/format.ts";
import { decodeMessage as oldDecode } from "./fixtures/pre-queen-bites-format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { RATED_DELAY_SECONDS } from "../../src/live/match-access.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState, StepOutput } from "../../src/sim/types.ts";
import { ManualClock, RecordedServer, SseClient, type ServedResponse } from "./helpers.ts";

const map: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants", water: [],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
const redesign = newMatchConfig(rulesConfig("redesign"));
const fourColony = { ...redesign, terrain: { ...redesign.terrain!, maps: [map] } };
type Bites = Extract<StreamEvent, { kind: "queenBites" }>;

/** A labelled queen-bites record on this step: the first two ants of colony 1 biting colony 0's queen, who bites the first of colony 2. */
function labelBites(out: StepOutput): Bites {
  const state = out.state;
  const biters = state.ants.filter((a) => a.colony === 1).slice(0, 2).map((a) => a.id).sort((a, b) => a - b);
  const target = state.ants.find((a) => a.colony === 2)!.id;
  out.events.push({ type: "queen_bites", tick: state.tick - 1, colony: 0, queenId: 0, tileX: 0, tileY: 0, biters, targetId: target });
  return { kind: "queenBites", colony: 0, queenId: 0, biters, targetId: target };
}

function opening(recorder: SpectatorRecorder): StreamMessage {
  return { ...recorder.initial(), full: recorder.initialFull() };
}

describe("queen bites on the wire", () => {
  const state = createMatch(404, fourColony);
  const recorder = new SpectatorRecorder(state);
  // Queen kills are later content (queen-kills-stream.test.ts covers both together): taken out, as in a version-32 stream.
  const first = withoutQueenKills(opening(recorder));
  const ants = first.ants;
  const bites: Bites = { kind: "queenBites", colony: 3, queenId: 2, biters: [ants.id[0]!, ants.id[3]!, ants.id[40]!], targetId: ants.id[7]! };

  it("round-trip in a delta and in a full message, only at version 32, with delta-coded ascending biters", () => {
    const delta: StreamMessage = { tick: 9, ants, full: null, events: [bites, { kind: "queenBites", colony: 0, queenId: 0, biters: [], targetId: 0 }] };
    const bytes = encodeMessage(delta);
    expect(bytes[2]).toBe(QUEEN_BITES_STREAM_VERSION);
    expect(decodeMessage(bytes).events).toEqual(delta.events);
    const target: StreamMessage = { ...delta, events: [{ kind: "queenBites", colony: 1, queenId: 0, biters: [5], targetId: null }] };
    expect(decodeMessage(encodeMessage(target)).events).toEqual(target.events);
    const full = decodeMessage(encodePublicMessage({ ...first, events: [bites] }));
    expect(full.events).toEqual([bites]);
    expect(full.full!.kills).toEqual(first.full!.kills);
  });

  it("decode beside four-colony kill totals in one message", () => {
    const message: StreamMessage = { tick: 9, ants, full: null, events: [{ kind: "kills", totals: [1, 2, 3, 4] }, bites] };
    expect(decodeMessage(encodeMessage(message)).events).toEqual(message.events);
    const full = decodeMessage(encodeMessage({ ...first, full: { ...first.full!, kills: [4, 3, 2, 1] }, events: [bites] }));
    expect(full.full!.kills).toEqual([4, 3, 2, 1]);
    expect(full.events).toEqual([bites]);
  });

  it("leave every message without one at its earlier version and bytes", () => {
    const old = encodeMessage(first);
    expect(old[2]).toBeLessThanOrEqual(KILLS_STREAM_VERSION);
    expect(encodeMessage(withoutQueenBites({ ...first, events: [bites] }))).toEqual(old);
    expect(oldDecode(old)).toEqual(decodeMessage(old));
  });

  it("are not readable by a page built before them, which therefore is sent the earlier form", () => {
    expect(() => oldDecode(encodeMessage({ tick: 9, ants, full: null, events: [bites] }))).toThrow("unsupported stream message version 32");
    expect(LIVE_OPT_INS).toContain("queenBites");
  });

  it.each([
    ["unordered biters", { ...bites, biters: [9, 3] }, "ascending"],
    ["a repeated biter", { ...bites, biters: [3, 3] }, "ascending"],
    ["neither a biter nor a target", { ...bites, biters: [], targetId: null }, "a biter or a target"],
    ["a colony outside four", { ...bites, colony: 4 as never }, "colony"],
  ])("refuse %s", (_name, event, message) => {
    expect(() => encodeMessage({ tick: 9, ants, full: null, events: [event] })).toThrow(message);
  });

  it("refuse a record under a version below 32", () => {
    const bytes = encodeMessage({ tick: 9, ants, full: null, events: [bites] });
    bytes[2] = KILLS_STREAM_VERSION;
    expect(() => decodeMessage(bytes)).toThrow("queen bites need version 32");
  });
});

describe("queen bites in the spectator model", () => {
  it("are restated by a full message only while under way, and survive a handover save", () => {
    let state: SimState = createMatch(404, fourColony);
    const recorder = new SpectatorRecorder(state);
    const first = opening(recorder);
    const model = new SpectatorState(first.full!, first.tick, first.ants);
    let out = step(state, []);
    const bites = labelBites(out);
    const rec = recorder.record(out);
    state = out.state;
    expect(rec.events).toContainEqual(bites);
    model.apply(rec);
    expect(model.message().events).toEqual([bites]);
    const saved = decodeMessage(encodeMessage(model.savedMessage()));
    const resumed = new SpectatorState(saved.full!, saved.tick, saved.ants, saved.events);
    expect(resumed.message().events).toEqual([bites]);
    // The next tick names no bite: none are under way, and the full message keeps its earlier version and bytes.
    out = step(state, []);
    model.apply(recorder.record(out));
    expect(model.message().events).toEqual([]);
    expect(encodeMessage(withoutQueenKills(model.message()))[2]).toBeLessThan(QUEEN_BITES_STREAM_VERSION);
  });
});

const lobbyId = "00000000-0000-4000-8000-000000000001";
const path = `/watch/live/${lobbyId}`;
const data = (response: ServedResponse) => response.writes.filter(w => w.text.startsWith("data: "));
const bytes = (text: string) => inflateRawSync(Buffer.from(text.slice(6).trim(), "base64"));
interface Form { kills: boolean; queenKills: boolean; queenBites: boolean }
const formOf = (query: string): Form => {
  const params = new URLSearchParams(query), on = (name: string) => params.get(name) === "1";
  return { kills: on("kills"), queenKills: on("queenKills"), queenBites: on("queenBites") };
};
const inForm = (m: StreamMessage, form: Form) => {
  const withKills = form.kills ? m : withoutKillTotals(m);
  const withQueenKills = form.queenKills ? withKills : withoutQueenKills(withKills);
  return form.queenBites ? withQueenKills : withoutQueenBites(withQueenKills);
};
/** The newest version a page built with exactly these opt-ins reads. */
const newestRead = (form: Form) => form.queenKills ? QUEEN_KILLS_STREAM_VERSION : form.queenBites ? QUEEN_BITES_STREAM_VERSION : form.kills ? KILLS_STREAM_VERSION : FLYER_STREAM_VERSION;

it("sends queen bites and queen kills each only to a live page that opted into them, in a version it reads, at one release clock", async () => {
  const clock = new ManualClock();
  const hub = new LiveHub({ clock });
  const server = new RecordedServer(hub, clock);
  const clients: SseClient[] = [];
  const queries = ["", "?kills=1", "?queenKills=1", "?queenBites=1", "?kills=1&queenKills=1", "?kills=1&queenBites=1",
    "?queenKills=1&queenBites=1", "?kills=1&queenKills=1&queenBites=1"];
  try {
    await server.listen();
    let state = createMatch(404, { ...fourColony, matchTicks: 4 });
    hub.startMatch(1, state, { lobbyId, visibility: "public", rated: true });
    for (const query of queries) clients.push(await SseClient.connect(server.url(path + query)));
    const named: Bites[] = [];
    for (let tick = 1; tick <= 4; tick++) {
      clock.advance(100);
      state.colonies[0]!.kills = tick;
      // Queen kills change on a bitten tick (2) and on a tick with no bites (3).
      if (tick === 2 || tick === 3) state.colonies[1]!.queenKills = tick - 1;
      const out = step(state, []);
      if (tick <= 2) named.push(labelBites(out));
      hub.pushTick(1, out); state = out.state;
    }
    clock.advance(RATED_DELAY_SECONDS * 1000 + 1000);
    const streams = server.responses.slice(0, queries.length).map((response, i) => {
      const form = formOf(queries[i]!);
      return data(response).map(w => (form.queenKills || form.queenBites ? decodeMessage : oldDecode)(bytes(w.text)) as StreamMessage);
    });
    const current = streams.at(-1)!;
    expect(current.flatMap(m => m.events.filter(e => e.kind === "queenBites"))).toEqual(named);
    expect(current.flatMap(m => m.events.filter(e => e.kind === "queenKills").map(e => [m.tick, e.totals]))).toEqual([[2, [0, 1, 0, 0]], [3, [0, 2, 0, 0]]]);
    expect(current.some(m => m.events.some(e => e.kind === "queenKills") && m.events.some(e => e.kind === "queenBites"))).toBe(true);
    for (const [i, query] of queries.entries()) {
      expect(streams[i]).toEqual(current.map(m => inForm(m, formOf(query))));
      expect(data(server.responses[i]!).map(w => w.t)).toEqual(data(server.responses[queries.length - 1]!).map(w => w.t));
      expect(Math.max(...data(server.responses[i]!).map(w => bytes(w.text)[2]!)), query).toBeLessThanOrEqual(newestRead(formOf(query)));
    }
  } finally {
    clients.forEach(c => c.close()); hub.close(); await server.close();
  }
});

it("restates the bites under way in the full message a joiner receives, in its form", async () => {
  const clock = new ManualClock();
  const hub = new LiveHub({ clock });
  const server = new RecordedServer(hub, clock);
  const clients: SseClient[] = [];
  try {
    await server.listen();
    let state = createMatch(404, { ...fourColony, matchTicks: 4 });
    hub.startMatch(1, state, { lobbyId, visibility: "public", rated: true });
    let bites: Bites | undefined;
    for (let tick = 1; tick <= 4; tick++) {
      clock.advance(100);
      const out = step(state, []);
      if (tick === 4) bites = labelBites(out);
      hub.pushTick(1, out); state = out.state;
    }
    // Release to the last tick, then join: the board's full message is at that tick, the bites it ended on under way.
    clock.advance(RATED_DELAY_SECONDS * 1000 + 10_000);
    for (const query of ["?kills=1&queenKills=1&queenBites=1", "?kills=1&queenBites=1", "?kills=1&queenKills=1", "?kills=1"]) clients.push(await SseClient.connect(server.url(path + query)));
    const [modern, bitesOnly, queenKillsOnly, legacy] = server.responses.map(r => decodeMessage(bytes(data(r)[0]!.text)));
    expect(modern!.tick).toBe(4);
    expect(modern!.events).toEqual([bites]);
    expect(modern!.full!.queenKills).toEqual([0, 0, 0, 0]);
    expect(bitesOnly).toEqual(withoutQueenKills(modern!));
    expect(queenKillsOnly).toEqual(withoutQueenBites(modern!));
    expect(legacy).toEqual(withoutQueenBites(withoutQueenKills(modern!)));
    expect(server.responses.map(r => bytes(data(r)[0]!.text)[2])).toEqual([QUEEN_KILLS_STREAM_VERSION, QUEEN_BITES_STREAM_VERSION, QUEEN_KILLS_STREAM_VERSION, KILLS_STREAM_VERSION]);
  } finally {
    clients.forEach(c => c.close()); hub.close(); await server.close();
  }
});
