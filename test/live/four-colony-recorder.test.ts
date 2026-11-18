// The spectator recorder on a four-colony match: its messages, and the running match picture a spectator builds
// from them, carry all four colonies' names, ants, queens and tile ownership, each elimination with its tick, and
// the result. Messages are read as objects, before any encoding. The quadrant maps here are test-only fixtures.
import { describe, expect, it } from "vitest";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { rulesConfig, SUB, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { SUPERCOLONY_NAMES } from "../../src/sim/colonyNames.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { advance, type ServerTerminal } from "../../src/sim/step.js";
import type { SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import type { StreamEvent, StreamFull } from "../../src/live/format.js";
import { queensForStream, SpectatorRecorder, SpectatorState, storesOf, streamResult, type TickRecord } from "../../src/live/model.js";
import { playScripted } from "../../src/live/record.js";
import { addAnt } from "../sim/fixtures.js";

/** Test-only quadrant geometry (as in test/sim/four-colony.test.ts). */
const QUADRANTS: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 },
    foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
    centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
  },
};
const LIVE = newMatchConfig(rulesConfig("redesign"));
/** Combat and queen bites from the first tick, so a short match fights. */
const CONFIG: SimConfig = { ...LIVE, combatGraceTicks: 0, queenHp: { ...LIVE.queenHp!, shieldTicks: 0 }, terrain: { ...LIVE.terrain!, maps: [QUADRANTS] } };
const SEED = 404;
const JOINS: SimInput[] = [0, 1, 2, 3].map(c => ({ type: "join", agentId: `a${c}`, modelLabel: `model ${c}` }));
const NAMES = SUPERCOLONY_NAMES.map(n => n.label);
const tile = (v: number) => Math.floor(v / SUB);

/** A recorder and a spectator following its messages, stepping the match in place. */
function watched(state: SimState) {
  const recorder = new SpectatorRecorder(state, { colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"] });
  const opening = recorder.initial();
  const full = recorder.initialFull();
  const spectator = new SpectatorState(recorder.initialFull(), opening.tick, opening.ants);
  const records: TickRecord[] = [];
  const play = (inputs: readonly SimInput[] = [], terminal: ServerTerminal = false): { out: StepOutput; rec: TickRecord } => {
    const out = advance(state, inputs, undefined, undefined, undefined, terminal, true);
    const rec = recorder.record(out);
    records.push(rec);
    spectator.apply(rec);
    return { out, rec };
  };
  return { recorder, opening, full, spectator, records, play };
}

/** The board a fresh recorder reads from the state now, beside the spectator's running picture of it. */
function picture(full: StreamFull) {
  return { queens: full.queens, territory: full.territory, deaths: full.deaths, kills: full.kills, hatched: full.hatched, stores: full.stores,
    overrun: full.overrun, eliminations: full.eliminations };
}
function truth(state: SimState) {
  return picture(new SpectatorRecorder(state).initialFull());
}

const kinds = (events: readonly StreamEvent[]) => events.map(e => e.kind);

describe("the spectator recorder on a four-colony match", () => {
  it("opens with four colonies: their names, queens, ants, stores and an empty elimination list", () => {
    const state = createMatch(SEED, CONFIG);
    const { full, opening } = watched(state);
    expect(state.colonies).toHaveLength(4);
    // The four names by colony number, whatever two-colony names the lobby option gave.
    expect(full.setup.colonyNames).toEqual(NAMES);
    expect(NAMES).toEqual(["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"]);
    expect(full.setup.colonies).toBe(4);
    expect(full.setup.queens).toHaveLength(4);
    expect(full.queens!.map(q => q.colony)).toEqual([0, 1, 2, 3]);
    expect(full.setup.queens).toEqual(full.queens!.map(q => [q.x, q.y]));
    for (const field of [full.overrun, full.deaths, full.hatched!, full.stores!]) expect(field).toHaveLength(4);
    expect(full.stores).toEqual(storesOf(state));
    expect(full.eliminations).toEqual([]);
    expect(full.result).toBeNull();
    expect(full.kills).toEqual(state.colonies.map(c => c.kills ?? 0));
    // Every colony's ants, by colony id.
    expect(new Set(opening.ants.colony)).toEqual(new Set([0, 1, 2, 3]));
    expect([0, 1, 2, 3].map(c => opening.ants.colony.filter(v => v === c).length)).toEqual([30, 30, 30, 30]);
  });

  it("follows four colonies' joins, ants, territory, hatches and stores, and the spectator's picture keeps step", () => {
    const state = createMatch(SEED, CONFIG);
    const { spectator, records, play } = watched(state);
    for (let t = 0; t < 200; t++) play(t === 0 ? JOINS : []);
    const joins = records[0]!.events.filter(e => e.kind === "join");
    expect(joins.map(e => e.kind === "join" && [e.colony, e.modelLabel])).toEqual([0, 1, 2, 3].map(c => [c, `model ${c}`]));
    expect(spectator.full.agents.map(a => a.colony)).toEqual([0, 1, 2, 3]);
    // Tile owners 1 to 4 for colonies 0 to 3, as the state holds them.
    expect(new Set(spectator.full.territory)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(records.some(r => r.events.some(e => e.kind === "store" && e.colony === 3))).toBe(true);
    expect(records.some(r => r.events.some(e => e.kind === "territory" && e.owners.includes(4)))).toBe(true);
    expect(picture(spectator.full)).toEqual(truth(state));
    expect(spectator.tick).toBe(state.tick);
    expect([...spectator.ants.colony]).toEqual(state.ants.toSorted((a, b) => a.id - b.id).map(a => a.colony));
  });

  it("sends a queens-killed elimination with its tick, the engine's own queen loss once, and removes the colony", () => {
    const state = createMatch(SEED, CONFIG);
    const { spectator, play } = watched(state);
    for (let t = 0; t < 100; t++) play(t === 0 ? JOINS : []);
    // Colony 1's only queen, one bite from death, with her guards gone and colony 0's ants on her tile.
    const queen = state.colonies[1]!.queens![0]!;
    const [qx, qy] = [tile(queen.queenX), tile(queen.queenY)];
    queen.hp = 1;
    state.ants = state.ants.filter(a => a.colony !== 1 || Math.abs(tile(a.x) - qx) > 8 || Math.abs(tile(a.y) - qy) > 8);
    expect(state.ants.some(a => a.colony === 1)).toBe(true);
    for (let i = 0; i < 4; i++) addAnt(state, 0, qx, qy, { hp: 100_000 });
    const tick = state.tick;
    const killsBefore = state.colonies.map(c => c.kills ?? 0);
    const { out, rec } = play();
    expect(out.events.filter(e => e.type === "queen_lost").map(e => e.type === "queen_lost" && e.colony)).toEqual([1]);
    expect(state.colonies[1]!.eliminated).toMatchObject({ tick, reason: "queens_killed" });
    expect(state.result).toBeNull();
    expect(state.colonies[0]!.kills).toBeGreaterThan(killsBefore[0]!);
    expect(spectator.full.kills).toEqual(state.colonies.map(c => c.kills ?? 0));
    expect(rec.events.some(e => e.kind === "kills")).toBe(true);
    // The engine's queen loss is sent once, and the elimination after it.
    expect(rec.events.filter(e => e.kind === "queenLost")).toEqual([{ kind: "queenLost", queen: expect.objectContaining({ colony: 1, id: 0, lostTick: tick }) }]);
    expect(rec.events.filter(e => e.kind === "eliminated")).toEqual([{ kind: "eliminated", colony: 1, tick }]);
    expect(kinds(rec.events).indexOf("queenLost")).toBeLessThan(kinds(rec.events).indexOf("eliminated"));
    // The colony's ants leave the message without deaths; its tiles turn neutral through territory events.
    expect(rec.ants.colony.includes(1)).toBe(false);
    expect(rec.events.some(e => e.kind === "death" && e.colony === 1)).toBe(false);
    expect(spectator.full.territory.includes(2)).toBe(false);
    expect(spectator.full.eliminations).toEqual([{ colony: 1, tick }]);
    expect(picture(spectator.full)).toEqual(truth(state));
    // Sent once: later messages carry no second elimination.
    for (let t = 0; t < 20; t++) expect(play().rec.events.some(e => e.kind === "eliminated")).toBe(false);
    expect(spectator.full.eliminations).toEqual([{ colony: 1, tick }]);
  });

  it("sends an idle elimination with a queen loss for each queen it retires, then a same-tick all-idle end", () => {
    const state = createMatch(SEED, CONFIG);
    const { spectator, records, play } = watched(state);
    for (let t = 0; t < 100; t++) play(t === 0 ? JOINS : []);

    // The server ends colony 2 idle: its queen retires with no engine event of her own.
    const idleTick = state.tick;
    const idle = play([], { idle: [2] });
    expect(state.colonies[2]!.eliminated).toMatchObject({ tick: idleTick, reason: "idle" });
    expect(idle.out.events.some(e => e.type === "queen_lost")).toBe(false);
    expect(idle.rec.events.filter(e => e.kind === "queenLost" || e.kind === "eliminated")).toEqual([
      { kind: "queenLost", queen: expect.objectContaining({ colony: 2, id: 0, lostTick: idleTick }) },
      { kind: "eliminated", colony: 2, tick: idleTick },
    ]);
    expect(idle.rec.ants.colony.includes(2)).toBe(false);
    expect(spectator.full.queens!.filter(q => q.colony === 2).map(q => q.lostTick)).toEqual([idleTick]);
    expect(picture(spectator.full)).toEqual(truth(state));

    // Colony 1's last queen falls (set as the engine tests set it), then colonies 0 and 3 go idle on one tick.
    state.colonies[1]!.queens![0]!.lostTick = state.tick;
    const lossTick = state.tick;
    play();
    expect(spectator.full.eliminations).toEqual([{ colony: 2, tick: idleTick }, { colony: 1, tick: lossTick }]);
    for (let t = 0; t < 10; t++) play();
    const endTick = state.tick;
    const end = play([], { idle: [0, 3] });
    const result = state.result!;
    expect(result).toMatchObject({ reason: "idle", tick: endTick });
    expect([0, 3]).toContain(result.winner);
    // Both leave, the winner too, as the engine records them; the result still names the winner.
    expect(kinds(end.rec.events).filter(k => k === "queenLost" || k === "eliminated" || k === "end"))
      .toEqual(["queenLost", "queenLost", "eliminated", "eliminated", "end"]);
    expect(end.rec.events.filter(e => e.kind === "eliminated")).toEqual([{ kind: "eliminated", colony: 0, tick: endTick }, { kind: "eliminated", colony: 3, tick: endTick }]);
    expect(end.rec.events.find(e => e.kind === "end")).toEqual({ kind: "end", result: streamResult(result, null) });
    expect(spectator.full.result).toEqual(streamResult(result, null));
    expect(spectator.full.eliminations).toEqual([
      { colony: 2, tick: idleTick }, { colony: 1, tick: lossTick }, { colony: 0, tick: endTick }, { colony: 3, tick: endTick }]);
    // Every queen of every colony shows its elimination tick.
    const lost = new Map(spectator.full.eliminations!.map(e => [e.colony, e.tick]));
    for (const queen of spectator.full.queens!) expect(queen.lostTick).toBe(lost.get(queen.colony));
    expect(spectator.full.queens).toEqual(queensForStream(state));
    expect(picture(spectator.full)).toEqual(truth(state));
    expect(records.flatMap(r => r.events.filter(e => e.kind === "eliminated"))).toHaveLength(4);
  });

  it("gives a picked four-colony start its four start boxes and starting queens", () => {
    const seats = [0, 1, 2, 3].map(colony => ({ identityId: `seat-${colony}`, colony }));
    const lobby = new LobbyStart(SEED, CONFIG, seats, 0);
    const state = lobby.finish(lobby.closesAt);
    const setup = new SpectatorRecorder(state).setup;
    expect(setup.startBoxes).toHaveLength(4);
    expect(setup.startingQueenIds).toEqual(state.config.initialQueens!.map(queens => queens.map((_, id) => id)));
    // Each box holds its own colony's picked queens, in colony order.
    state.colonies.forEach((colony, id) => {
      const box = setup.startBoxes![id]!;
      for (const queen of colony.queens!) {
        const [x, y] = [tile(queen.queenX), tile(queen.queenY)];
        expect(x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height).toBe(true);
      }
    });
  });

  it("plays scripted four-colony matches, each agent attacking another colony still in the match", () => {
    const orders: { colony: number; tileX: number }[] = [];
    let queens: [number, number][] = [];
    const { state } = playScripted({ seed: SEED, config: CONFIG, agents: 4, ticks: 120 }, (out, inputs) => {
      if (queens.length === 0) queens = out.state.colonies.map(c => [tile(c.queenX), tile(c.queenY)]);
      for (const input of inputs) {
        if (input.type !== "order") continue;
        const agent = out.state.agents.find(a => a.id === input.agentId)!;
        orders.push({ colony: agent.colony, tileX: "tileX" in input.order ? input.order.tileX : -1 });
      }
    });
    expect(state.agents.map(a => a.colony).toSorted()).toEqual([0, 1, 2, 3]);
    expect(new Set(orders.map(o => o.colony))).toEqual(new Set([0, 1, 2, 3]));
    // No colony has left, so each attacks the next colony's queen.
    for (const order of orders) expect(order.tileX).toBe(queens[(order.colony + 1) % 4]![0]);
  });
});

describe("the spectator recorder on a two-colony match", () => {
  it("keeps the lobby's two names and carries no colony count or elimination list", () => {
    const state = createMatch(SEED, newMatchConfig(rulesConfig("redesign")));
    expect(state.colonies).toHaveLength(2);
    const recorder = new SpectatorRecorder(state, { colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"] });
    const full = recorder.initialFull();
    expect(full.setup.colonyNames).toEqual(["Sweetwater Colony", "Lake Skinner Colony"]);
    expect("colonies" in full.setup).toBe(false);
    expect("eliminations" in full).toBe(false);
    expect(full.setup.queens).toHaveLength(2);
    for (const field of [full.overrun, full.deaths, full.hatched!, full.stores!]) expect(field).toHaveLength(2);
    expect("colonyNames" in new SpectatorRecorder(state).setup).toBe(false);
  });
});


describe("authoritative kill totals across recorder resume", () => {
  it("establishes a complete baseline after an old handover without fabricating deaths", () => {
    const state = createMatch(SEED, CONFIG);
    const original = new SpectatorRecorder(state);
    const first = original.initial(), oldFull = original.initialFull();
    delete oldFull.kills;
    state.colonies.forEach((c, i) => { c.kills = i * 7; });
    const recorder = new SpectatorRecorder(state, {}, { setup: original.setup, agents: original.agentIndexes(),
      initialFull: () => structuredClone(oldFull), ants: first.ants });
    const spectator = new SpectatorState(oldFull, first.tick, first.ants);
    const out = advance(state, [], undefined, undefined, undefined, { idle: [0, 1, 2, 3] }, true);
    const recorded = recorder.record(out);
    spectator.apply(recorded);
    expect(spectator.full.kills).toEqual([0, 7, 14, 21]);
    expect(spectator.full.result).not.toBeNull();
    expect(recorded.events.filter(e => e.kind === "kills")).toEqual([{ kind: "kills", totals: [0, 7, 14, 21] }]);
    expect(state.colonies.map(c => c.kills)).toEqual([0, 7, 14, 21]);
  });
});
