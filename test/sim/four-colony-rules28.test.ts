/**
 * A four-colony match on the served rules: rules 28 with flyers, as a two-colony match plays them. Its queens hatch
 * flyers that take off; its stream carries four colonies, flyers and optional kill totals together; its log replays
 * to every tick's hash; and its seats are told rules 28 and the flyer rules.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { FLYER_STREAM_VERSION, KILLS_STREAM_VERSION, QUEEN_KILLS_STREAM_VERSION, RULES28_STREAM_VERSION, decodeMessage, encodeMessage, withoutKillTotals, withoutQueenKills, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { briefing, flyerRulesLines } from "../../src/mcp/briefing.ts";
import { rulesConfig, rulesVersionOf, RULES28_VERSION, SUB, type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { eliminationsAt, headerLine, replay, stateHash, tickLine } from "../../src/sim/log.ts";
import { buildGrid, createMatch } from "../../src/sim/map.ts";
import { advance } from "../../src/sim/step.ts";
import { isBlockedTile } from "../../src/sim/terrain.ts";
import type { ColonyId, SimEvent, SimInput, SimState } from "../../src/sim/types.ts";
import { FOUR_COLONY_CELL_ENCODING, FOUR_COLONY_FLYER_CELL_ENCODING, createVisibility, denseCells, expandCells, type ViewCell } from "../../src/sim/view.ts";
import { ruleSections } from "../../web/rules.ts";

/** Test-only quadrant geometry (as in four-colony.test.ts): nest, water, start area and food off both mirror axes. */
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

const SERVED = newMatchConfig(rulesConfig("redesign"));
const CONFIG: SimConfig = { ...SERVED, terrain: { ...SERVED.terrain!, maps: [QUADRANTS] } };
const SEED = 404;
const ENDS_AT = 900;
const tile = (v: number) => Math.floor(v / SUB);

/** The land tile nearest a point 8 tiles from the colony's queen toward the board centre, in the queen's sight. */
function towardCentre(state: SimState, colony: number): { tileX: number; tileY: number } {
  const queen = state.colonies[colony]!, qx = tile(queen.queenX), qy = tile(queen.queenY);
  const dx = Math.sign(state.config.mapWidth / 2 - qx), dy = Math.sign(state.config.mapHeight / 2 - qy);
  for (let step = 8; step > 0; step--) {
    const tileX = qx + dx * step, tileY = qy + dy * step;
    if (!isBlockedTile(state.terrain, tileX, tileY)) return { tileX, tileY };
  }
  return { tileX: qx, tileY: qy };
}

/** Four seats set their queens' brood to flyers; from 1:10 each lays a GATHER flyer mark toward the centre. */
function play() {
  let state = createMatch(SEED, CONFIG);
  const recorder = new SpectatorRecorder(state);
  const messages: StreamMessage[] = [{ ...recorder.initial(), full: recorder.initialFull() }];
  const lines = [headerLine(SEED, state.config)], hashes: string[] = [], events: SimEvent[] = [];
  const marks: boolean[] = [];
  while (state.tick < ENDS_AT && state.result === null) {
    const tick = state.tick, inputs: SimInput[] = [];
    if (tick === 0) for (const c of [0, 1, 2, 3]) inputs.push({ type: "join", agentId: `a${c}` });
    if (tick === 1) for (const c of [0, 1, 2, 3]) inputs.push({ type: "set_brood", agentId: `a${c}`, brood: "flyers" });
    if (tick >= 700 && tick % 50 === 0) for (const c of [0, 1, 2, 3]) {
      inputs.push({ type: "count_mark", agentId: `a${c}`, verb: "GATHER", caste: "flyer", count: 2, ...towardCentre(state, c) });
    }
    const out = advance(state, inputs, undefined, undefined, undefined, false, true);
    out.results.forEach((r, i) => { if (inputs[i]!.type === "count_mark") marks.push(r.ok); });
    events.push(...out.events);
    messages.push({ ...recorder.record(out), full: null });
    lines.push(tickLine(tick, inputs, false, true, eliminationsAt(out.state, tick)));
    state = out.state;
    hashes.push(stateHash(state));
  }
  return { state, messages, lines, hashes, events, marks };
}

describe("a four-colony match on the served rules", () => {
  let run: ReturnType<typeof play>;
  beforeAll(() => { run = play(); }, 120_000);

  it("plays rules 28 with flyers, its queens striking", () => {
    const start = createMatch(SEED, CONFIG);
    expect(start.colonies).toHaveLength(4);
    expect(start.config.rules28).toBe(true);
    expect(start.config.flyers).toEqual(SERVED.flyers);
    expect(rulesVersionOf(start.config)).toBe(RULES28_VERSION);
    for (const colony of start.colonies) {
      expect(colony.queens!.map(q => q.hp)).toEqual([CONFIG.queenHp!.hp]);
      expect(colony.queens![0]).not.toHaveProperty("lastBiteTick");
    }
  });

  it("hatches flyers in every colony, and they take off", () => {
    expect(run.marks.some(Boolean)).toBe(true);
    for (const colony of [0, 1, 2, 3]) {
      expect(run.events.some(e => e.type === "hatch" && e.colony === colony && run.state.ants.some(a => a.flyer === true && a.colony === colony)), `colony ${colony}`).toBe(true);
      expect(run.events.some(e => e.type === "flyer_takeoff" && e.colony === colony), `colony ${colony}`).toBe(true);
    }
  });

  it("streams four colonies and flyers with optional kill totals, and decodes them together", () => {
    const [first, ...rest] = run.messages.map(m => encodeMessage(m));
    // Rules 28 credit queen kills, recorded at version 33 beside the kill totals; without them the totals keep 30.
    expect(first![2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expect(decodeMessage(first!).full!.kills).toEqual(run.messages[0]!.full!.kills);
    expect(decodeMessage(first!).full!.queenKills).toEqual([0, 0, 0, 0]);
    expect(encodeMessage(withoutQueenKills(run.messages[0]!))[2]).toBe(KILLS_STREAM_VERSION);
    expect(encodeMessage(withoutKillTotals(withoutQueenKills(run.messages[0]!)))[2]).toBe(RULES28_STREAM_VERSION);
    const setup = decodeMessage(first!).full!.setup;
    expect([setup.colonies, setup.queens.length, setup.rules28]).toEqual([4, 4, true]);
    let both = 0;
    rest.forEach((bytes, i) => {
      const message = run.messages[i + 1]!, decoded = decodeMessage(bytes);
      expect(encodeMessage(decoded)).toEqual(bytes);
      const flyers = message.ants.flyers?.some(f => f !== null) === true;
      const kills = message.events.some(event => event.kind === "kills");
      if (message.events.some(event => event.kind === "queenKills")) expect(bytes[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
      else if (kills) expect(bytes[2]).toBe(KILLS_STREAM_VERSION);
      else if (flyers) expect(bytes[2]).toBe(FLYER_STREAM_VERSION);
      expect(decoded.events.filter(event => event.kind === "kills")).toEqual(message.events.filter(event => event.kind === "kills"));
      if (flyers) expect(encodeMessage(withoutKillTotals(withoutQueenKills(message)))[2]).toBe(FLYER_STREAM_VERSION);
      expect(Array.from(decoded.ants.colony)).toEqual(Array.from(message.ants.colony.subarray(0, message.ants.count)));
      expect(decoded.ants.flyers ?? null).toEqual(flyers ? message.ants.flyers : null);
      if (flyers && message.ants.flyers!.some((f, k) => f !== null && message.ants.colony[k]! > 1)) both++;
    });
    expect(both).toBeGreaterThan(0);
  });

  it("sends a four-colony snapshot with kill totals, preserving its colony count, rules marker and flyers", () => {
    const recorder = new SpectatorRecorder(run.state);
    const snapshot: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
    const flyers = snapshot.ants.flyers!;
    expect(flyers.some((f, k) => f !== null && snapshot.ants.colony[k]! > 1)).toBe(true);
    const bytes = encodeMessage(snapshot), decoded = decodeMessage(bytes);
    expect(bytes[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expect(decoded.full!.kills).toEqual(snapshot.full!.kills);
    expect(decoded.full!.queenKills).toEqual(snapshot.full!.queenKills);
    expect(encodeMessage(withoutQueenKills(snapshot))[2]).toBe(KILLS_STREAM_VERSION);
    const legacy = encodeMessage(withoutKillTotals(withoutQueenKills(snapshot)));
    expect(legacy[2]).toBe(FLYER_STREAM_VERSION);
    expect(decodeMessage(legacy).full!.kills).toBeUndefined();
    expect(decodeMessage(legacy).ants.flyers).toEqual(flyers);
    expect([decoded.full!.setup.colonies, decoded.full!.setup.queens.length, decoded.full!.setup.rules28]).toEqual([4, 4, true]);
    expect(decoded.full!.setup.rules28Figures).toEqual(snapshot.full!.setup.rules28Figures);
    expect(decoded.full!.eliminations).toEqual(snapshot.full!.eliminations ?? []);
    expect(Array.from(decoded.ants.colony)).toEqual(Array.from(snapshot.ants.colony.subarray(0, snapshot.ants.count)));
    expect(decoded.ants.flyers).toEqual(flyers);
    expect(encodeMessage(decoded)).toEqual(bytes);
  });

  it("shows its seats the flyers in sight with their states, in the four-colony cell grammar, and decodes them back", () => {
    const visibility = createVisibility(run.state), grid = buildGrid(run.state);
    for (const colony of [0, 1, 2, 3] as ColonyId[]) {
      const cells = visibility.cells(colony, grid);
      const table = denseCells(cells, run.state.config.mapWidth, run.state.config.mapHeight, 4, true);
      expect([table.encoding, table.colonies]).toEqual([FOUR_COLONY_FLYER_CELL_ENCODING, 4]);
      expect(table.encoding.startsWith(FOUR_COLONY_CELL_ENCODING)).toBe(true);
      expect(expandCells(table)).toEqual(cells);
      expect(cells.flatMap(cell => cell.ants).filter(ant => ant.flyer !== undefined).length, `colony ${colony}`).toBeGreaterThan(0);
    }
    // k = hp*3n + colony + n*caste with n = 4, then the flyer's state letter.
    const one: ViewCell[] = [{ tileX: 3, tileY: 1, food: 0, ants: [{ antId: 7, colony: 3, hp: 2000, caste: "worker", flyer: "hovering" }, { antId: 9, colony: 2, hp: 2000, caste: "soldier" }] }];
    const table = denseCells(one, 64, 48, 4, true);
    expect(table.data).toBe(`${(3 + 64).toString(36)}:7.${(2000 * 12 + 3 + 4).toString(36)}.h/9.${(2000 * 12 + 2 + 8).toString(36)}`);
    expect(expandCells(table)).toEqual(one);
  });

  it("replays from its log to every tick's hash", () => {
    const replayed: string[] = [];
    replay(run.lines, ENDS_AT, s => replayed.push(stateHash(s)));
    expect(replayed).toEqual(run.hashes);
  }, 120_000);

  it("tells its seats rules 28 and the flyer rules", () => {
    const text = briefing(CONFIG);
    expect(text).toContain("ants' hits land before queens' strikes");
    expect(text).not.toContain("queens' bites");
    for (const line of flyerRulesLines(CONFIG)) expect(text).toContain(line);
    expect(ruleSections(CONFIG).flatMap(s => s.lines).join("\n")).toMatch(/flyer/i);
  });
});
