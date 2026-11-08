import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COUNT_MARK_STREAM_VERSION, GRID_SCALE_STREAM_VERSION, LINE_MARK_STREAM_VERSION, STREAM_COUNT_VERBS, decodeMessage, encodeMessage,
  Reader, Writer, type StreamMark, type StreamMessage,
} from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { recordLog } from "../../src/live/record.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { applyInput, defaultAllocator } from "../../src/sim/agents.ts";
import { COUNT_MARK_MAX_COUNT, PUBLIC_CONFIG, rulesConfig, SUB } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { claimCountMarks, expireMarks } from "../../src/sim/marks.ts";
import { step } from "../../src/sim/step.ts";
import { COUNT_VERBS, type Agent, type SimEvent, type SimInput } from "../../src/sim/types.ts";
import { addAnt, emptyMatch } from "../sim/fixtures.ts";

import { playable } from "../playable.ts";

const word: StreamMark = { id: 1, agent: 0, colony: 0, tileX: 20, tileY: 20, words: [0, 4], laidTick: 3, answered: 4 };
const counted: StreamMark = { ...word, id: 2, words: [], verb: "DEFEND", count: 8, claimed: 0, revision: 0 };
const opening = (recorder: SpectatorRecorder): StreamMessage => ({ ...recorder.initial(), full: recorder.initialFull() });
const roundTrip = (message: StreamMessage) => decodeMessage(encodeMessage(message));

function delta(mark: StreamMark): StreamMessage {
  return { tick: 1, ants: new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG))).initial().ants, full: null,
    events: [{ kind: "mark", mark }] };
}

describe("count-mark wire fields", () => {
  it("uses the sim's verb ordering", () => {
    expect(STREAM_COUNT_VERBS.slice(0, 4)).toEqual(COUNT_VERBS);
    expect(STREAM_COUNT_VERBS[4]).toBe("PATROL");
  });

  it.each(STREAM_COUNT_VERBS)("round-trips %s in a full snapshot and a mark event beside a word mark", (verb) => {
    const message = opening(new SpectatorRecorder(createMatch(42, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: undefined }))));
    message.full!.marks = [word, { ...counted, verb }];
    message.events = [{ kind: "mark", mark: word }, { kind: "mark", mark: { ...counted, verb, claimed: 8, revision: 300 } }];
    const bytes = encodeMessage(message);
    // Every full snapshot carries grid scale 2, so it is written at the grid-scale version.
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    const decoded = decodeMessage(bytes);
    expect(decoded.full!.marks).toEqual(message.full!.marks);
    expect(decoded.events).toEqual(message.events);
    expect(decoded.full!.setup).toEqual(message.full!.setup);
    expect(decoded.full!.queens).toEqual(message.full!.queens);
  });

  it.each([
    { verb: "FORAGE" as const }, { count: 0 }, { claimed: 0 }, { revision: 0 },
    { count: 300, claimed: 128, revision: 16_384 },
  ])("preserves independently optional and zero fields: %j", (fields) => {
    const message = delta({ ...word, ...fields });
    expect(encodeMessage(message)[2]).toBe(7);
    expect(roundTrip(message).events).toEqual(message.events);
  });

  it("rejects malformed version-7 metadata, rather than silently losing a field", () => {
    const bytes = encodeMessage(delta({ ...word, verb: "DEFEND" }));
    const badVerb = bytes.slice(); badVerb[badVerb.length - 1] = 255;
    expect(() => decodeMessage(badVerb)).toThrow("unknown count-mark verb");
    const badFlags = bytes.slice(); badFlags[badFlags.length - 2] = 16;
    expect(() => decodeMessage(badFlags)).toThrow("unknown count-mark flags");
    expect(() => decodeMessage(bytes.slice(0, -1))).toThrow("truncated stream message");
  });
});

describe("unchanged streams and recordings", () => {
  // Full snapshots below the grid-scale version no longer decode; delta bytes keep their versions.
  it("keeps version 4 delta bytes without count metadata", () => {
    const message = delta(word);
    message.events.push({ kind: "answered", markId: word.id, count: 3 });
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(4);
    expect(decodeMessage(bytes).events[0]).toEqual({ kind: "mark", mark: word });
  });

  it("writes a no-count recording's delta messages below the count-mark version", () => {
    const config = { ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: undefined, matchTicks: 20 };
    const [opening, ...deltas] = recordLog([headerLine(42, playable(config))], 20);
    expect(opening![2]).toBe(GRID_SCALE_STREAM_VERSION);
    for (const bytes of deltas) {
      expect(bytes[2]).not.toBe(7);
    }
  });

  it("refuses the immutable historical version-4 recording at its setup, while its delta messages still decode without count metadata", () => {
    const bytes = readFileSync(new URL("fixtures/historical-v4.bin", import.meta.url));
    const [first, ...rest] = unpackMessages(bytes);
    expect(() => decodeMessage(first!)).toThrow("stream setup version 4 carries no grid scale");
    expect(decodeMessage(rest.at(-1)!).tick).toBe(1510);
    for (const packed of rest) {
      const decoded = decodeMessage(packed);
      for (const event of decoded.events) if (event.kind === "mark") expect(event.mark.verb === undefined && event.mark.claimed === undefined).toBe(true);
    }
  });
});

it("records real claim, re-lay, release, death and expiry changes separately from squad answers", () => {
  const config = { ...rulesConfig("count-marks"), squadSize: 1, commandFloorTicks: 1 };
  const state = emptyMatch(700, config);
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: null, idle: false, pendingEvents: [] };
  const squadAnt = addAnt(state, 0, 40, 40, { squad: agent.id }); agent.squad.push(squadAnt.id); state.agents.push(agent);
  // The doubled reference geometry: grid scale 2 doubles every tile distance.
  // Enough distant colony ants for the share cap, but only three local recruits.
  for (let i = 0; i < 12; i++) addAnt(state, 0, 14, 48, { role: "forager" });
  for (let i = 0; i < 3; i++) addAnt(state, 0, 42 + 2 * i, 40, { role: "forager" });
  const recorder = new SpectatorRecorder(state), first = roundTrip(opening(recorder));
  const board = new SpectatorState(first.full!, first.tick, first.ants);
  const lay = (count: number): SimEvent[] => {
    const events: SimEvent[] = [];
    expect(applyInput(state, { type: "count_mark", agentId: "a", verb: "DEFEND", count, tileX: 40, tileY: 40 }, state.tick, defaultAllocator, events).error).toBeNull();
    return events;
  };
  const publish = (events: SimEvent[] = []) => {
    claimCountMarks(state, state.tick);
    state.tick++;
    const message = roundTrip({ ...recorder.record({ state, events, results: [] }), full: null });
    board.apply(message);
    // A reconnect and a fresh recorder both carry the same authoritative marks.
    expect(roundTrip(board.message()).full!.marks).toEqual(roundTrip(opening(new SpectatorRecorder(state))).full!.marks);
    return message;
  };
  publish(lay(3));
  const mark = state.marks[0]!;
  expect(board.full.marks[0]).toMatchObject({ verb: "DEFEND", count: 3, claimed: 3, revision: 0, answered: 0 });
  mark.steering = 4; // An independent squad-following count, not the claimed count.
  expect(publish().events).toContainEqual({ kind: "answered", markId: mark.id, count: 4 });
  expect(publish().events.filter((event) => event.kind === "mark" || event.kind === "answered")).toEqual([]);
  const relaid = lay(1);
  expect(relaid).toEqual([]); // The sim emits no mark_laid for an in-place re-lay.
  expect(publish(relaid).events).toContainEqual({ kind: "mark", mark: expect.objectContaining({ id: mark.id, count: 1, claimed: 1, revision: 1, answered: 4 }) });
  publish(lay(1));
  expect(board.full.marks[0]).toMatchObject({ count: 1, revision: 2, claimed: 1 });
  // All local recruits die/leave the living list: claims fall to zero, not to answered.
  state.ants = state.ants.filter((ant) => ant.squad !== null || ant.x < 30 * SUB);
  publish();
  expect(board.full.marks[0]).toMatchObject({ count: 1, claimed: 0, revision: 2, answered: 4 });
  state.tick = mark.laidTick + config.markLifetimeTicks;
  expireMarks(state, state.tick);
  expect(publish().events).toContainEqual({ kind: "markGone", markId: mark.id });
  expect(board.full.marks).toEqual([]);
});

it("carries live step outputs through binary recording replay, in-place revision and reconnect", () => {
  const config = { ...rulesConfig("count-marks"), matchTicks: 12, commandFloorTicks: 1, squadSize: 1,
    guardCount: 0, guardSharePermille: 0, fighterShareStartPermille: 0, fighterShareEndPermille: 0 };
  let state = createMatch(42, playable(config));
  const recorder = new SpectatorRecorder(state), first = roundTrip(opening(recorder));
  const board = new SpectatorState(first.full!, first.tick, first.ants);
  const lines = [headerLine(42, playable(config))], live: Uint8Array[] = [encodeMessage(opening(recorder))];
  let markTile: { tileX: number; tileY: number } | undefined;
  let maximumClaimed = 0;
  for (let tick = 0; tick < config.matchTicks; tick++) {
    let inputs: SimInput[] = [];
    if (tick === 0) inputs = [{ type: "join", agentId: "a" }];
    if (tick === 1) inputs = [{ type: "order", agentId: "a", order: { kind: "hold" } }];
    if (tick === 2) {
      const ant = state.ants.find((ant) => ant.squad === "a")!;
      markTile = { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
      inputs = [{ type: "count_mark", agentId: "a", verb: "DEFEND", count: 8, ...markTile }];
    }
    if (tick === 4) inputs = [{ type: "count_mark", agentId: "a", verb: "DEFEND", count: 2, ...markTile! }];
    lines.push(tickLine(tick, inputs));
    const out = step(state, inputs); state = out.state;
    expect(out.results.every((result) => result.ok)).toBe(true);
    const packed = encodeMessage({ ...recorder.record(out), full: null }); live.push(packed);
    board.apply(decodeMessage(packed));
    const truth = state.marks.map((mark) => ({ id: mark.id, verb: mark.verb, count: mark.count, revision: mark.revision,
      claimed: state.ants.filter((ant) => ant.claim === mark.id).length }));
    expect(board.full.marks.map(({ id, verb, count, revision, claimed }) => ({ id, verb, count, revision, claimed }))).toEqual(truth);
    maximumClaimed = Math.max(maximumClaimed, ...truth.map((mark) => mark.claimed));
  }
  expect(maximumClaimed).toBeGreaterThan(0);
  expect(board.full.marks[0]).toMatchObject({ verb: "DEFEND", count: 2, revision: 1 });
  expect(recordLog(lines)).toEqual(live);
  const replayed = recordLog(lines).map(decodeMessage), start = replayed[0]!;
  const replayBoard = new SpectatorState(start.full!, start.tick, start.ants);
  for (const message of replayed.slice(1)) replayBoard.apply(message);
  expect(replayBoard.full.marks).toEqual(board.full.marks);
  expect(roundTrip(board.message()).full!.marks).toEqual(roundTrip(opening(new SpectatorRecorder(state))).full!.marks);
});

it.each(["any", "worker", "soldier"] as const)("round-trips %s caste in full/delta messages, retaining optional terrain fields and reconnect state", caste => {
  const mark = { ...counted, caste };
  const message = opening(new SpectatorRecorder(createMatch(42, playable(PUBLIC_CONFIG))));
  message.full!.marks = [word, mark];
  for (const terrain of [undefined, { mapId: "water-only", mapName: "Water only", water: [] },
    { mapId: "rocks", mapName: "Rocks", water: [], rocks: [] }]) {
    message.full!.setup.terrain = terrain;
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(roundTrip(message).full!.marks).toEqual([word, mark]);
    expect(roundTrip(message).full!.setup.terrain).toEqual(terrain);
    const decoded = roundTrip(message);
    const spectator = new SpectatorState(decoded.full!, decoded.tick, decoded.ants);
    const changed = { ...mark, caste: "worker" as const, revision: 1 };
    spectator.apply(roundTrip(delta(changed)));
    expect(roundTrip(spectator.message()).full!.marks.find(m => m.id === mark.id)).toEqual(changed);
  }
  const bytes = encodeMessage(delta(mark));
  expect(bytes[2]).toBe(13);
  expect(roundTrip(delta(mark)).events).toEqual(delta(mark).events);
  const invalid = bytes.slice(); invalid[invalid.length - 1] = 255;
  expect(() => decodeMessage(invalid)).toThrow("unknown count-mark caste");
});

it("the recorder emits a mark update when only caste changes and keeps legacy absence distinct from any", () => {
  const s = emptyMatch(0, rulesConfig("redesign"));
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  s.agents.push(agent);
  s.marks.push({ id: 1, agentId: "a", colony: 0, tileX: 8, tileY: 24, words: [], laidTick: 0,
    steering: 0, verb: "GATHER", count: 2 });
  const recorder = new SpectatorRecorder(s);
  expect(recorder.initialFull().marks[0]!.caste).toBe("any");
  const next = { ...s, tick: 1, marks: [{ ...s.marks[0]!, caste: "soldier" as const }] };
  const message = recorder.record({ state: next, events: [], results: [] });
  expect(message.events).toContainEqual({ kind: "mark", mark: expect.objectContaining({ caste: "soldier" }) });
  const { casteSelection: _selection, ...oldRules } = s.config.countMarks!;
  const old = new SpectatorRecorder({ ...s, config: { ...s.config, countMarks: oldRules } });
  expect(old.initialFull().marks[0]).not.toHaveProperty("caste");
});

describe("rules 26 LINE mark wire fields", () => {
  const line: StreamMark = { ...counted, id: 3, verb: "LINE", count: 5, toTileX: 24, toTileY: 58 };

  it("carries the second endpoint in a full snapshot and a mark event, only at version 22", () => {
    const message = opening(new SpectatorRecorder(createMatch(42, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: undefined }))));
    message.full!.marks = [word, counted, line];
    message.events = [{ kind: "mark", mark: { ...line, claimed: 5, revision: 2 } }];
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(LINE_MARK_STREAM_VERSION);
    const decoded = decodeMessage(bytes);
    expect(decoded.full!.marks).toEqual(message.full!.marks);
    expect(decoded.events).toEqual(message.events);
    expect(decoded.full!.marks[1]).not.toHaveProperty("toTileX");
  });

  it("keeps a message without a second endpoint at its earlier version and bytes", () => {
    const message = delta(counted);
    expect(encodeMessage(message)[2]).toBe(COUNT_MARK_STREAM_VERSION);
    expect(roundTrip(message).events).toEqual(message.events);
  });

  it("refuses the endpoint flag below version 22", () => {
    const bytes = encodeMessage(delta(line));
    expect(bytes[2]).toBe(LINE_MARK_STREAM_VERSION);
    const older = Uint8Array.from(bytes); older[2] = LINE_MARK_STREAM_VERSION - 1;
    expect(() => decodeMessage(older)).toThrow("unknown count-mark flags");
  });

  it("records a sim LINE mark's second endpoint", () => {
    const state = createMatch(42, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: undefined }));
    state.marks.push({ id: 9, agentId: "a", colony: 0, tileX: 24, tileY: 40, toTileX: 24, toTileY: 58, words: [], laidTick: 0, steering: 0, verb: "LINE", count: 5, revision: 0 });
    const full = new SpectatorRecorder(state).initialFull();
    expect(full.marks.find(mark => mark.id === 9)).toMatchObject({ verb: "LINE", tileX: 24, tileY: 40, toTileX: 24, toTileY: 58 });
  });
});

describe("stream varints", () => {
  it("writes every safe count across the buffer's end and reads it back", () => {
    for (const n of [0, 0x7f, 0x80, COUNT_MARK_MAX_COUNT, 2 ** 31, 2 ** 49, Number.MAX_SAFE_INTEGER]) {
      const writer = new Writer();
      const end = writer.buf.length;
      writer.o = end - 1;
      writer.u8(0xab);
      writer.v(n);
      writer.u8(0xcd);
      const bytes = writer.done();
      expect(bytes.length).toBeGreaterThan(end);
      const reader = new Reader(bytes);
      reader.o = end - 1;
      expect([reader.u8(), reader.v(), reader.u8()]).toEqual([0xab, n, 0xcd]);
      expect(reader.o).toBe(bytes.length);
    }
  });

  it("refuses a number it could not read back instead of writing past its buffer", () => {
    for (const n of [2 ** 60, Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN, Infinity]) {
      const writer = new Writer();
      writer.o = writer.buf.length - 1;
      expect(() => writer.v(n)).toThrow(RangeError);
      expect(writer.o).toBe(writer.buf.length - 1);
    }
  });

  it("round-trips a mark at the count maximum", () => {
    const mark = { ...counted, count: COUNT_MARK_MAX_COUNT, claimed: COUNT_MARK_MAX_COUNT };
    expect(roundTrip(delta(mark)).events).toEqual(delta(mark).events);
  });
});
