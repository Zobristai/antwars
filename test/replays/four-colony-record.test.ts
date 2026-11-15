// A four-colony match's recording and finished-match record. A scripted match on a test-only quadrant map, recorded
// as the live hub records it (each step's public stream message, packed and gzipped) with the match log the game
// server writes, decodes to what its live messages carried; binaryRecord and matchRecord keep its four colonies,
// their names, the winner or draw, the reason and each elimination's tick.
import { gunzipSync, gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { binaryRecord, matchRecord, type HistoryInput } from "../../src/replays/history.ts";
import { rulesConfig, type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { eliminationsAt, headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { playable } from "../playable.ts";
import { step, type ServerTerminal } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";

/** Test-only quadrant fixture map, as in test/server/four-colony-log.test.ts; no shipped map. */
const MAP: MapDefinition = {
  id: "close-quadrants", name: "Close Quadrants", water: [],
  quadrant: { referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
    startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }] },
};
const LIVE = newMatchConfig(rulesConfig("redesign"));
const CONFIG: SimConfig = { ...LIVE, matchTicks: 200, terrain: { ...LIVE.terrain!, maps: [MAP] } };
const SEED = 404;
const ID = "2026-11-14T02-00-00-000Z-4";
const QUADRANTS_NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];

interface Played { readonly state: SimState; readonly live: StreamMessage[]; readonly input: HistoryInput }

/**
 * One seat per colony joins at tick 0; at each listed tick the server ends those colonies' seats idle. Each tick is
 * logged as the game server logs it, and each step's stream message is recorded as the live hub records it.
 */
function play(idle: Readonly<Record<number, readonly number[]>>, config = CONFIG, seats = 4): Played {
  let state = createMatch(SEED, config);
  const recorder = new SpectatorRecorder(state);
  const live: StreamMessage[] = [{ ...recorder.initial(), full: recorder.initialFull() }];
  const lines = [headerLine(SEED, config)];
  while (state.result === null) {
    const tick = state.tick;
    const inputs: SimInput[] = tick === 0 ? Array.from({ length: seats }, (_, seat) => ({ type: "join", agentId: `seat-private-${seat}`, modelLabel: `model-${seat}` })) : [];
    const terminal: ServerTerminal = idle[tick] === undefined ? false : { idle: idle[tick] };
    const out = step(state, inputs, undefined, undefined, undefined, terminal, true);
    lines.push(tickLine(tick, inputs, terminal, true, eliminationsAt(out.state, tick)));
    live.push({ ...recorder.record(out), full: null });
    state = out.state;
  }
  const binary = gzipSync(packMessages(live.map(message => encodePublicMessage(message))));
  return { state, live, input: { id: ID, binary, logLines: lines, endedAt: Date.parse("2026-11-14T02:00:30.000Z") } };
}

/** What the engine ended the match with: its result, and each colony that left with its tick, by tick then colony. */
function engine(state: SimState) {
  const eliminations = state.colonies.flatMap(colony => colony.eliminated === undefined ? [] : [{ colony: colony.id, tick: colony.eliminated.tick }])
    .sort((a, b) => a.tick - b.tick || a.colony - b.colony);
  return { result: state.result!, eliminations };
}

/** The colonies, eliminations and result a sequence of stream messages carries. */
function carried(messages: readonly StreamMessage[]) {
  const setup = messages[0]!.full!.setup;
  return {
    colonies: setup.colonies, queens: setup.queens, colonyNames: setup.colonyNames, opening: messages[0]!.full!.eliminations,
    antColonies: [...new Set(messages[0]!.ants.colony)].sort(),
    eliminations: messages.flatMap(message => message.events.flatMap(event => event.kind === "eliminated" ? [{ colony: event.colony, tick: event.tick }] : [])),
    result: messages.flatMap(message => message.events.flatMap(event => event.kind === "end" ? [event.result] : [])),
  };
}

const decoded = (input: HistoryInput) => unpackMessages(new Uint8Array(gunzipSync(input.binary))).map(bytes => decodeMessage(bytes));

const CASES = [
  { name: "the last colony standing", idle: { 5: [3], 8: [2], 12: [1] },
    result: { winner: 0, reason: "idle", decidedBy: "idle", tick: 12 }, eliminations: [{ colony: 3, tick: 5 }, { colony: 2, tick: 8 }, { colony: 1, tick: 12 }] },
  // A same-tick all-idle end: the time-up winner leaves with the others, is listed among the eliminations with that
  // tick, and the result still names it the winner, as the engine and the lobby store it.
  { name: "a same-tick all-idle end with a winner", idle: { 5: [3], 20: [0, 1, 2] },
    result: { winner: 2, reason: "idle", decidedBy: "territory", tick: 20 },
    eliminations: [{ colony: 3, tick: 5 }, { colony: 0, tick: 20 }, { colony: 1, tick: 20 }, { colony: 2, tick: 20 }] },
  { name: "a same-tick all-idle draw", idle: { 3: [0, 1, 2, 3] },
    result: { winner: null, reason: "idle", decidedBy: "draw", tick: 3 },
    eliminations: [{ colony: 0, tick: 3 }, { colony: 1, tick: 3 }, { colony: 2, tick: 3 }, { colony: 3, tick: 3 }] },
] as const;

describe.each(CASES)("a Quadrants match ending in $name", ({ idle, result, eliminations }) => {
  let played: Played;
  beforeAll(() => { played = play(idle); });

  it("is the engine's ending", () => {
    expect(engine(played.state)).toEqual({ result, eliminations });
  });

  it("decodes from its recording to the four colonies, eliminations and result its live messages carried", () => {
    const live = carried(played.live), recording = carried(decoded(played.input));
    expect(recording).toEqual(live);
    expect(live).toMatchObject({ colonies: 4, colonyNames: QUADRANTS_NAMES, opening: [], antColonies: [0, 1, 2, 3], eliminations,
      result: [{ ...result, nextStartMs: null }] });
    expect(live.queens).toHaveLength(4);
  });

  it.each([["binaryRecord", binaryRecord], ["matchRecord", matchRecord]] as const)("is stored by %s with its colonies, names, result and elimination ticks", (_name, build) => {
    const record = build(played.input);
    expect(record.setup).toMatchObject({ colonies: 4, colonyNames: QUADRANTS_NAMES });
    expect(record.setup!.queens).toHaveLength(4);
    expect(record.seats.map(seat => [seat.seat, seat.colony, seat.modelLabel])).toEqual([0, 1, 2, 3].map(seat => [seat, seat, `model-${seat}`]));
    expect(record.result).toEqual(result);
    expect(record.eliminations).toEqual(eliminations);
    expect(record.events.filter(({ event }) => event.kind === "eliminated").map(({ tick, event }) => ({ tick, event })))
      .toEqual(eliminations.map(({ colony, tick }) => ({ tick, event: { kind: "eliminated", colony, tick } })));
    // The record serializes its eliminations as stored.
    expect((JSON.parse(JSON.stringify(record)) as typeof record).eliminations).toEqual(eliminations);
  });

  it("is verified against its match log", () => {
    expect(matchRecord(played.input)).toMatchObject({ source: "match-log", status: "complete", rules: { config: { matchTicks: 200 } } });
  });
});

it("leaves a two-colony record as it was: no eliminations and no colony count", () => {
  const played = play({ 3: [1] }, { ...playable(rulesConfig("redesign")), matchTicks: 20, startAnts: 16 }, 2);
  expect(played.state.result).toMatchObject({ winner: 0, reason: "idle" });
  for (const record of [binaryRecord(played.input), matchRecord(played.input)]) {
    expect(record).not.toHaveProperty("eliminations");
    expect(record.setup).not.toHaveProperty("colonies");
    expect(record.seats.map(seat => seat.colony)).toEqual([0, 1]);
    expect(record.result).toEqual({ winner: 0, reason: "idle", decidedBy: "idle", tick: 3 });
  }
});
