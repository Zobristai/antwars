// A four-colony match's spectator stream, read directly: version 27 carries all four colonies' names, ants, queens and
// tile ownership, each elimination with its tick, and the result, in full snapshots and in deltas. Every two-colony
// message, rated or unrated, keeps the version and bytes it had before four colonies.
import { decodeMessage as oldDecode } from "./fixtures/pre-queen-ranking-format.ts";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COLONY_NAMES_STREAM_VERSION, FOUR_COLONY_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage,
  type StreamAnts, type StreamEvent, type StreamFull, type StreamMessage, type StreamQueen, type StreamResult,
} from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { playScripted } from "../../src/live/record.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { drawColonyNames, SUPERCOLONY_NAMES } from "../../src/sim/colonyNames.ts";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { playable } from "../playable.ts";
import { rules27Redesign } from "../rules27.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** The four Quadrants names by colony number: the shared name table's order. */
const QUADRANTS = SUPERCOLONY_NAMES.map(name => name.label);
const SIDE = 8;

function ants(rows: readonly (readonly [id: number, colony: number, agent: number, carrying: 0 | 1, soldier: 0 | 1])[]): StreamAnts {
  return {
    count: rows.length,
    id: Uint32Array.from(rows, r => r[0]),
    x: Uint16Array.from(rows, (_, i) => 256 * (i + 1) + 128),
    y: Uint16Array.from(rows, (_, i) => 256 * (SIDE - 1 - i) + 64),
    heading: Uint8Array.from(rows, (_, i) => 40 * i),
    colony: Uint8Array.from(rows, r => r[1]),
    agent: Int16Array.from(rows, r => r[2]),
    carrying: Uint8Array.from(rows, r => r[3]),
    // Present only when an ant is a soldier, as the decoder sets it.
    ...(rows.some(r => r[4] === 1) ? { caste: Uint8Array.from(rows, r => r[4]) } : {}),
  };
}

const queen = (id: number, colony: number, lostTick: number | null): StreamQueen =>
  ({ id, colony, x: 256 * (colony % 2 === 0 ? 1 : SIDE - 2) + 128, y: 256 * (colony < 2 ? 1 : SIDE - 2) + 128, foundedTick: 0, lostTick, overrun: colony });

/** A four-colony board mid-match: colony 1 was eliminated at tick 40, colony 3 holds a qualifying lead. */
function fourColonyFull(result: StreamResult | null = null, eliminations = [{ colony: 1, tick: 40 }]): StreamFull {
  return {
    setup: {
      gridScale: 2, colonies: 4, rated: false, colonyNames: QUADRANTS,
      startBoxes: [{ x: 0, y: 0, width: 3, height: 3 }, { x: 5, y: 0, width: 3, height: 3 }, { x: 0, y: 5, width: 3, height: 3 }, { x: 5, y: 5, width: 3, height: 3 }],
      startingQueenIds: [[0], [1], [2], [3]],
      mapW: SIDE, mapH: SIDE, ticksPerSecond: 10, matchTicks: 600, idleTicks: 300, overrunRadiusTiles: 2,
      queens: [[384, 384], [1664, 384], [384, 1664], [1664, 1664]],
    },
    // Every owner a four-colony board can hold: 0 neutral, then colony + 1.
    territory: Uint8Array.from({ length: SIDE * SIDE }, (_, tile) => tile % 5),
    marks: [2, 3].map(colony => ({ id: colony, agent: colony, colony, tileX: colony, tileY: colony + 1, words: [colony], laidTick: 10 + colony, answered: 1 })),
    agents: [0, 1, 2, 3].map(colony => ({ colony, modelLabel: `model ${colony}`, joinTick: 0, lastCallTick: 30 + colony, prevCallTick: 20 + colony,
      order: "forage" as const, orderX: colony, orderY: colony, intent: colony === 3 ? "hold the north-east" : "" })),
    overrun: [0, 0, 7, 0],
    overrunRequired: 600,
    deaths: [3, 12, 5, 1],
    result,
    food: Uint32Array.from({ length: SIDE * SIDE }, (_, tile) => (tile % 7 === 0 ? tile + 1 : 0)),
    hatch: { cost: 10, intervalTicks: 20, cap: 200 },
    stores: [0, 1, 2, 3].map(colony => ({ food: 10 * colony, nextHatchTick: 50 + colony, nextCost: 10 })),
    queens: [queen(0, 0, null), queen(1, 1, 40), queen(2, 2, null), queen(3, 3, null)],
    hatched: [4, 2, 6, 8],
    territoryWin: { colony: 3, startTick: 30, winTick: 329 },
    eliminations,
  };
}

const opening = (): StreamMessage => ({
  tick: 41,
  ants: ants([[1, 0, 0, 1, 0], [4, 2, 2, 0, 1], [7, 3, -1, 1, 1], [9, 3, 3, 0, 0], [12, 2, -1, 0, 0]]),
  full: fourColonyFull(),
  events: [],
});

const end: StreamResult = { winner: 3, reason: "queens_killed", decidedBy: "queens_killed", tick: 57, nextStartMs: null };

/** The step that ends the match: colony 2's last queen falls, so colony 2 is eliminated and colony 3 wins. */
const finalStep = (): StreamMessage => ({
  tick: 58,
  ants: ants([[7, 3, -1, 1, 1], [9, 3, 3, 0, 0]]),
  full: null,
  events: [
    { kind: "fight", antId: 9, targetId: 4, colony: 3, tileX: 2, tileY: 6 },
    { kind: "death", antId: 4, colony: 2, x: 600, y: 1700 },
    { kind: "queenLost", queen: queen(2, 2, 57) },
    { kind: "territory", tiles: [3, 18, 41], owners: [4, 0, 4] },
    { kind: "store", colony: 3, food: 40, nextHatchTick: 60, nextCost: 10 },
    { kind: "queenOverrun", colony: 2, queenId: 2, progress: 600, required: 600 },
    { kind: "eliminated", colony: 2, tick: 57 },
    { kind: "end", result: end },
  ],
});

describe("a four-colony match on the spectator stream", () => {
  it("is a new version above every earlier one", () => {
    expect(FOUR_COLONY_STREAM_VERSION).toBe(27);
    expect(FOUR_COLONY_STREAM_VERSION).toBeGreaterThan(COLONY_NAMES_STREAM_VERSION);
  });

  it("carries every colony's names, ants, queens and tiles, and each elimination with its tick, in a full snapshot", () => {
    const message = opening();
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(FOUR_COLONY_STREAM_VERSION);
    const decoded = decodeMessage(bytes);
    expect(decoded).toEqual(message);
    const full = decoded.full!;
    expect(full.setup.colonies).toBe(4);
    expect(full.setup.colonyNames).toEqual(["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"]);
    expect([...decoded.ants.colony]).toEqual([0, 2, 3, 3, 2]);
    expect([...decoded.ants.caste!]).toEqual([0, 1, 1, 0, 0]);
    expect([...decoded.ants.carrying!]).toEqual([1, 0, 1, 0, 0]);
    expect([...decoded.ants.agent]).toEqual([0, 2, -1, 3, -1]);
    expect(new Set(full.territory)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(full.queens!.map(q => [q.colony, q.lostTick])).toEqual([[0, null], [1, 40], [2, null], [3, null]]);
    expect(full.setup.queens).toHaveLength(4);
    expect(full.eliminations).toEqual([{ colony: 1, tick: 40 }]);
    expect(full.territoryWin).toEqual({ colony: 3, startTick: 30, winTick: 329 });
    expect([full.overrun, full.deaths, full.hatched, full.stores!.map(s => s.food)]).toEqual([[0, 0, 7, 0], [3, 12, 5, 1], [4, 2, 6, 8], [0, 10, 20, 30]]);
    expect(full.agents.map(a => a.colony)).toEqual([0, 1, 2, 3]);
    expect(full.marks.map(m => m.colony)).toEqual([2, 3]);
    // Decoding and encoding again writes the same bytes.
    expect(encodeMessage(decoded)).toEqual(bytes);
  });

  it("keeps the four names, colonies and eliminations in the public copy and an empty elimination list before the first", () => {
    const publicCopy = decodeMessage(encodePublicMessage(opening()));
    expect(publicCopy.full!.setup).toMatchObject({ colonies: 4, colonyNames: QUADRANTS });
    expect(publicCopy.full!.eliminations).toEqual([{ colony: 1, tick: 40 }]);
    const before = decodeMessage(encodeMessage({ ...opening(), full: { ...fourColonyFull(), eliminations: undefined } }));
    expect(before.full!.eliminations).toEqual([]);
  });

  it("carries a delta's four-colony events, the elimination before the end, and the result intact", () => {
    const message = finalStep();
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(FOUR_COLONY_STREAM_VERSION);
    const decoded = decodeMessage(bytes);
    expect(decoded).toEqual(message);
    expect(decoded.events.map(e => e.kind).slice(-2)).toEqual(["eliminated", "end"]);
    expect(decoded.events.find(e => e.kind === "eliminated")).toEqual({ kind: "eliminated", colony: 2, tick: 57 });
    expect(decoded.events.find(e => e.kind === "end")).toEqual({ kind: "end", result: end });
    expect(decoded.events.find(e => e.kind === "queenLost")).toMatchObject({ queen: { colony: 2, lostTick: 57 } });
  });

  it.each([
    ["a winner", { winner: 2, reason: "queens_killed", decidedBy: "queens_killed", tick: 57, nextStartMs: 1_800_000_000_000 }],
    ["a draw", { winner: null, reason: "time_up", decidedBy: "draw", tick: 599, nextStartMs: null }],
  ] as const)("carries the final snapshot's result with %s and every elimination by tick then colony", (_, result) => {
    const eliminations = [{ colony: 0, tick: 30 }, { colony: 1, tick: 40 }, { colony: 3, tick: 40 }];
    const message: StreamMessage = { ...opening(), tick: result.tick + 1, full: fourColonyFull({ ...result }, eliminations) };
    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded.full!.result).toEqual(result);
    expect(decoded.full!.eliminations).toEqual(eliminations);
  });

  it("selects version 27 for any four-colony datum in a delta, and leaves one carrying none at its earlier version", () => {
    const delta = (events: StreamEvent[], antColony = 0): StreamMessage => ({ tick: 5, ants: ants([[1, antColony, -1, 0, 0]]), full: null, events });
    for (const message of [
      delta([], 2),
      delta([], 3),
      delta([{ kind: "eliminated", colony: 0, tick: 4 }]),
      delta([{ kind: "territory", tiles: [5], owners: [3] }]),
      delta([{ kind: "territoryWin", progress: { colony: 2, startTick: 1, winTick: 300 } }]),
      delta([{ kind: "end", result: { ...end, winner: 2 } }]),
      delta([{ kind: "death", antId: 2, colony: 3, x: 0, y: 0 }]),
      delta([{ kind: "queenFounded", queen: queen(5, 2, null) }]),
    ]) {
      const bytes = encodeMessage(message);
      expect(bytes[2]).toBe(FOUR_COLONY_STREAM_VERSION);
      expect(decodeMessage(bytes)).toEqual(message);
    }
    // A four-colony match's step that touches only colonies 0 and 1 is written exactly as a two-colony step.
    const twoColonyOnly = delta([{ kind: "territory", tiles: [5, 6], owners: [1, 2] }, { kind: "death", antId: 2, colony: 1, x: 0, y: 0 }], 1);
    expect(encodeMessage(twoColonyOnly)[2]).toBeLessThan(COLONY_NAMES_STREAM_VERSION);
    expect(decodeMessage(encodeMessage(twoColonyOnly))).toEqual(twoColonyOnly);
  });

  it("refuses an elimination below version 27 and a malformed four-colony message rather than writing it", () => {
    const bytes = encodeMessage({ tick: 5, ants: ants([]), full: null, events: [{ kind: "eliminated", colony: 1, tick: 4 }] });
    bytes[2] = COLONY_NAMES_STREAM_VERSION;
    expect(() => decodeMessage(bytes)).toThrow("eliminated event needs version 27");
    const full = fourColonyFull();
    const write = (f: StreamFull) => () => encodeMessage({ ...opening(), full: f });
    expect(write({ ...full, setup: { ...full.setup, colonies: undefined } })).toThrow("a setup has two colonies, or four with colonies: 4");
    expect(write({ ...full, deaths: [1, 2] })).toThrow("deaths needs one entry per colony");
    expect(write({ ...full, setup: { ...full.setup, colonyNames: QUADRANTS.slice(0, 3) } })).toThrow("invalid colony names");
    expect(write({ ...full, eliminations: [{ colony: 3, tick: 40 }, { colony: 1, tick: 40 }] })).toThrow("invalid eliminations");
    expect(write({ ...full, eliminations: [{ colony: 4, tick: 40 }] })).toThrow("invalid eliminations");
    expect(() => encodeMessage({ tick: 5, ants: ants([[1, 4, -1, 0, 0]]), full: null, events: [] })).toThrow("invalid ant colony");
  });
});

// Two-colony matches recorded on the live and public paths, and their reconnect snapshot, as the encoder wrote them
// before version 27 existed: each message's version, and the SHA-256 of the messages packed as a recording.
const TWO_COLONY_BEFORE = {
  rated: {
    versions: [4, 18, 25],
    live: "fd92f53b5aa562e6ab46eef2fd364875db8874defbdf7fcea4fcca49ad050ee9",
    stored: "a6419afc5f98d0984099c917f72f2988054f6c796f70b93327462254e88b649e",
    reconnect: [25, "ae51d999e647f505e106d355f25ead93566554d532c7b4aad0e59ad728603c4c"],
  },
  unrated: {
    versions: [4, 26],
    live: "1fbaa912d23b5ffdfac38588fa538f6fec977f09c3cb665a79845c4dbc6da9e2",
    stored: "541dd037d70c688a6a97a3608e0b55bd851de5402ce8e7d06c542a7bf8869b14",
    reconnect: [26, "2eb7c020d9eb231ca82e6d9181c510b8257bb470f72d3506520e91432d8c6ae7"],
  },
  redesign: {
    versions: [4, 18],
    live: "16c077c79cdc290a0a73183d54c1e15d3c65f8bb59f34f34e274eeb4adfcc79f",
    stored: "49d2872996ad11c8830ba7084d7311435ff1f29f9f941ee8314b541a579f4659",
    reconnect: [18, "4bb5f7edbc7fcf6fb060aae703e36fb13bf674278278b911145951d0f27dd32a"],
  },
} as const;

describe("two-colony messages beside four colonies", () => {
  const publicConfig = playable({ ...PUBLIC_CONFIG, terrain: undefined, matchTicks: 300 });
  const cases: [keyof typeof TWO_COLONY_BEFORE, SimConfig, ConstructorParameters<typeof SpectatorRecorder>[1]][] = [
    ["rated", publicConfig, { rated: true, identity: (id: string) => ({ displayName: `Seat ${id}`, elo: 1500 + id.length, rd: 80 }) }],
    ["unrated", publicConfig, { rated: false, colonyNames: drawColonyNames("unrated-lobby") }],
    // The rules-27 redesign (test/rules27.ts), whose bytes these hashes recorded; rules-28 bytes are not older than four colonies.
    ["redesign", playable({ ...rules27Redesign(), terrain: undefined, matchTicks: 300 }), {}],
  ];

  it.each(cases)("keeps every %s message's version and bytes", (label, config, players) => {
    const recorder = new SpectatorRecorder(createMatch(17, config), players);
    const messages: StreamMessage[] = [{ ...recorder.initial(), full: recorder.initialFull() }];
    playScripted({ seed: 17, config, agents: 4, ticks: 300, attack: true }, out => { messages.push({ ...recorder.record(out), full: null }); });
    const live = messages.map(encodeMessage);
    const first = decodeMessage(live[0]!);
    const state = new SpectatorState(first.full!, first.tick, first.ants);
    for (const bytes of live.slice(1)) state.apply(decodeMessage(bytes));
    const reconnect = encodeMessage(state.message());
    expect({
      versions: [...new Set(live.map(bytes => bytes[2]!))].sort((a, b) => a - b),
      live: sha256(packMessages(live)),
      stored: sha256(packMessages(messages.map(m => encodePublicMessage(m)))),
      reconnect: [reconnect[2], sha256(reconnect)],
    }).toEqual(TWO_COLONY_BEFORE[label]);
    expect(first.full!.setup).not.toHaveProperty("colonies");
    expect(first.full!).not.toHaveProperty("eliminations");
  });
});

it("round-trips queen-kill results in full snapshots and end events for rated and unrated play", () => {
  for (const rated of [false, true]) {
    const result: StreamResult = { ...end, reason: "time_up", decidedBy: "queen_kills" };
    const message = opening();
    message.full = { ...fourColonyFull(result), setup: { ...fourColonyFull().setup, rated } };
    message.events = [{ kind: "end", result }];
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
    for (const full of [message.full, null]) for (const encode of [encodeMessage, encodePublicMessage]) {
      const legacy = oldDecode(encode({ ...message, full }));
      const e = legacy.events[0]!;
      if (e.kind !== "end") throw new Error("missing end event");
      expect(e.result).toEqual({ ...result, decidedBy: "kills" });
      if (full) expect(legacy.full!.result).toEqual(e.result);
    }
  }
});
