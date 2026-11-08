import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SUB, rulesConfig } from "../../src/sim/config.js";
import { tileCentre, withinTiles } from "../../src/sim/geometry.js";
import { buildGrid, createMatch, tileIndex } from "../../src/sim/map.js";
import type { SimState, VisibleEvent } from "../../src/sim/types.js";
import { denseCells, expandCells, recordSightings, takeView, type AgentView, type ViewCell } from "../../src/sim/view.js";
import { addAnt, emptyMatch, run, send, setOwner, squadOf } from "./fixtures.js";

function observe(state: SimState, ...agentIds: string[]): { state: SimState; views: AgentView[] } {
  const out = send(state, agentIds.map((agentId) => ({ type: "observe" as const, agentId })));
  return { state: out.state, views: out.results.map((r) => r.view!) };
}

describe("the agent's view", () => {
  it("is one view stamped with its tick, holding current colony sight plus its colony's facts", () => {
    let s = send(createMatch(5), [{ type: "join", agentId: "a" }]).state;
    s = run(s, 200).state;
    const { state, views } = observe(s, "a");
    const view = views[0]!;
    expect(view.tick).toBe(state.tick);
    expect(view.squad).toHaveLength(6);
    for (const member of view.squad) {
      expect(member.tileX).toBe(Math.floor(member.x / SUB));
      expect(member.tileY).toBe(Math.floor(member.y / SUB));
    }
    expect(view.order).toEqual({ kind: "forage" });
    expect(view.orderStatus).toContain("foraging");
    expect(view.cells.length).toBeGreaterThan(0);
    for (const cell of view.cells) {
      expect(state.ants.some((ant) => ant.colony === view.colony && ant.hp > 0 && withinTiles(
        Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), cell.tileX, cell.tileY, 2 * DEFAULT_CONFIG.sightTiles))).toBe(true);
    }
    // Grid scale 2: the rows are fine cells (lengths double); held area counts reference tiles,
    // four fine cells each.
    expect(view.territoryRows).toHaveLength(48 * 2);
    for (const row of view.territoryRows) expect(row).toMatch(/^[#.]{128}$/);
    const own = state.owner.filter((o) => o === 0).length;
    expect(view.territoryTiles).toBe(own / 4);
    expect(view.territoryRows.join("").split("#").length - 1).toBe(own);
    expect(view.territorySharePermille).toBe(Math.trunc((own / 4 * 1000) / (64 * 48)));
    expect(view.ticksLeft).toBe(DEFAULT_CONFIG.matchTicks - state.tick);
    expect(view.secondsLeft).toBe(Math.ceil(view.ticksLeft / 10));
    expect(view.myMarks).toEqual([]);
  });

  it("gives separated teammates the same colony-sight cells, marks and events, never the enemy's view", () => {
    // Grid scale 2: reference tile t is placed at fine tile 2t + 1 and the template's sight 2 and
    // smell 3 play as 4 and 6, so every distance and boundary below doubles exactly.
    const f = (t: number) => 2 * t + 1;
    const s = send(emptyMatch(0, { ...DEFAULT_CONFIG, sightTiles: 2, smellTiles: 3 }), [
      { type: "join", agentId: "a", placement: 0 },
      { type: "join", agentId: "mate", placement: 0 },
      { type: "join", agentId: "enemy", placement: 1 },
    ]).state;
    s.food.fill(0);
    addAnt(s, 0, f(10), f(10), { squad: "a" });
    addAnt(s, 0, f(30), f(10), { squad: "mate" });
    addAnt(s, 0, f(45), f(30)); // Free ants contribute too.
    addAnt(s, 0, f(5), f(40), { hp: 0 }); // Dead ants grant no sight or smell.
    addAnt(s, 1, f(50), f(40), { squad: "enemy" });
    const seenEnemy = addAnt(s, 1, f(32), f(10)); // Exact sight boundary.
    const hiddenEnemy = addAnt(s, 1, f(33), f(10));
    s.colonies[1] = { ...s.colonies[1], queenX: tileCentre(f(45)), queenY: tileCentre(f(32)) };
    for (const [x, y] of [[f(12),f(10)], [f(13),f(10)], [f(30),f(12)], [f(32),f(11)], [f(45),f(32)], [f(5),f(41)], [f(50),f(42)]]) {
      s.food[tileIndex(s.config, x!, y!)] = 7;
    }
    s.marks = [
      { id: 1, agentId: "a", colony: 0, tileX: f(33), tileY: f(10), words: ["FOOD"], laidTick: 0, steering: 0 },
      { id: 2, agentId: "a", colony: 0, tileX: f(34), tileY: f(10), words: ["HELP"], laidTick: 0, steering: 0 },
      { id: 3, agentId: "a", colony: 0, tileX: f(45), tileY: f(33), words: ["QUEEN"], laidTick: 0, steering: 0 },
      { id: 4, agentId: "a", colony: 0, tileX: f(5), tileY: f(41), words: ["HELP"], laidTick: 0, steering: 0 },
      { id: 5, agentId: "enemy", colony: 1, tileX: f(30), tileY: f(10), words: ["ATTACK"], laidTick: 0, steering: 0 },
    ];
    const event = (tileX: number, tileY: number): VisibleEvent => ({ type: "hatch", tick: s.tick, antId: 1000 + tileX, colony: 1, tileX, tileY });
    const sighted = [event(f(12),f(10)), event(f(30),f(12)), event(f(45),f(32))];
    const ownQueen: VisibleEvent = { type: "queen_lost", tick: s.tick, queenId: 9, colony: 0, tileX: 0, tileY: 0 };
    const ownMark: VisibleEvent = { type: "mark_laid", tick: s.tick, markId: 6, agentId: "a", colony: 0, tileX: f(30), tileY: f(10), words: ["HELP"] };
    recordSightings(s, [...sighted, event(f(13),f(10)), event(f(32),f(11)), event(f(5),f(41)), event(f(50),f(42)), ownQueen, ownMark,
      { ...ownMark, colony: 1, agentId: "enemy", markId: 7 }]);
    const [a, mate, enemy] = s.agents.map(agent => takeView(s, buildGrid(s), agent));
    expect(a!.cells).toEqual(mate!.cells);
    expect(a!.marks).toEqual(mate!.marks.map(mark => ({ ...mark, mine: true })));
    expect(a!.marks.map(mark => mark.markId)).toEqual([1, 3]);
    expect(a!.events).toEqual([...sighted, ownQueen, ownMark]);
    expect(mate!.events).toEqual(a!.events); // Taking a's view did not drain mate's queue.
    expect(takeView(s, buildGrid(s), s.agents[0]!).events).toEqual([]);
    expect(a!.cells.flatMap(cell => cell.ants).map(ant => ant.antId)).toContain(seenEnemy.id);
    expect(a!.cells.flatMap(cell => cell.ants).map(ant => ant.antId)).not.toContain(hiddenEnemy.id);
    expect(a!.cells).toContainEqual(expect.objectContaining({ tileX: f(45), tileY: f(32), queen: 1, food: 7 }));
    expect(a!.squad.map(ant => ant.antId)).not.toEqual(mate!.squad.map(ant => ant.antId));
    for (const view of [a!, enemy!]) {
      const expected: [number, number][] = [];
      for (let y = 0; y < s.config.mapHeight; y++) for (let x = 0; x < s.config.mapWidth; x++) {
        const seen = s.ants.some(ant => ant.colony === view.colony && ant.hp > 0 && withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), x, y, 4));
        const occupied = s.food[tileIndex(s.config, x, y)]! > 0 || s.ants.some(ant => Math.floor(ant.x / SUB) === x && Math.floor(ant.y / SUB) === y)
          || s.colonies.some(colony => Math.floor(colony.queenX / SUB) === x && Math.floor(colony.queenY / SUB) === y);
        if (seen && occupied) expected.push([x, y]);
      }
      expect(view.cells.map(cell => [cell.tileX, cell.tileY])).toEqual(expected);
    }
    expect(enemy!.events).toEqual([event(f(32),f(11)), event(f(50),f(42)), { ...ownMark, colony: 1, agentId: "enemy", markId: 7 }]);
    expect(enemy!.marks.map(mark => mark.markId)).toEqual([5]);
  });

  it("does not retain ground or marks after the last living colony ant leaves, but keeps already sighted events", () => {
    const s = send(emptyMatch(), [{ type: "join", agentId: "a", colony: 0 }]).state;
    s.food.fill(0);
    const scout = addAnt(s, 0, 20, 20); // No squad is needed for vision.
    const enemy = addAnt(s, 1, 21, 20);
    s.food[tileIndex(s.config, 20, 21)] = 5;
    s.marks = [{ id: 1, agentId: "a", colony: 0, tileX: 20, tileY: 20, words: ["HELP"], laidTick: 0, steering: 0 }];
    expect(takeView(s, buildGrid(s), s.agents[0]!).cells).toContainEqual(expect.objectContaining({ tileX: 20, tileY: 21, food: 5 }));
    const fight: VisibleEvent = { type: "fight", tick: s.tick, antId: scout.id, targetId: enemy.id, colony: 0, tileX: 21, tileY: 20 };
    recordSightings(s, [fight]);
    scout.x = tileCentre(50);
    scout.y = tileCentre(40);
    recordSightings(s, [{ type: "death", tick: s.tick + 1, antId: enemy.id, colony: 1, tileX: 21, tileY: 20 }]);
    const view = takeView(s, buildGrid(s), s.agents[0]!);
    expect(view.events).toEqual([fight]);
    expect(view.marks).toEqual([]);
    expect(view.cells.some(cell => cell.tileX === 20 && cell.tileY === 21)).toBe(false);
    expect(view.cells.flatMap(cell => cell.ants).some(ant => ant.antId === enemy.id)).toBe(false);
    scout.hp = 0;
    expect(takeView(s, buildGrid(s), s.agents[0]!).cells).toEqual([]);
  });

  it("resumes from the last call across a rejoin with the token", () => {
    let s = send(createMatch(5), [
      { type: "join", agentId: "a" },
      { type: "order", agentId: "a", order: { kind: "hold" } },
    ]).state;
    const callTick = s.tick;
    s = observe(s, "a").state;
    s = run(s, 1000).state;
    expect(s.agents[0]?.idle).toBe(true);
    const lapseTick = callTick + DEFAULT_CONFIG.squadTimerTicks;
    const out = send(s, [{ type: "rejoin", agentId: "a" }]);
    const events = out.results[0]!.view!.events;
    expect(events.length).toBeGreaterThan(0);
    expect(Math.min(...events.map((e) => e.tick))).toBeGreaterThan(callTick);
    // Losing an idle seat's squad does not blind it to its living colony.
    expect(Math.max(...events.map((e) => e.tick))).toBeGreaterThan(lapseTick);
    expect(Math.max(...events.map((e) => e.tick))).toBeLessThan(out.state.tick);
  });

  it("reports an event on the same tick as a call exactly once", () => {
    let s = send(createMatch(5), [
      { type: "join", agentId: "a" },
      { type: "order", agentId: "a", order: { kind: "hold" } },
    ]).state;
    s = observe(s, "a").state;
    s.colonies[0].foodStore = 3;
    s.colonies[0].lastHatchTick = -1000;
    const first = observe(s, "a");
    const hatch = first.views[0]!.events.filter((e) => e.type === "hatch" && e.tick === s.tick);
    expect(hatch).toHaveLength(1);
    const second = observe(first.state, "a").views[0]!;
    expect(second.events.filter((e) => e.type === "hatch" && e.tick === s.tick)).toHaveLength(0);
  });

  it("still gives an agent with no ants its colony's territory tiles and share", () => {
    const s = emptyMatch(0);
    // Grid scale 2: each held reference tile is a 2x2 block of fine cells.
    for (const tx of [1, 2, 3, 4, 5]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) setOwner(s, 2 * tx + dx!, 2 + dy!, 0);
    addAnt(s, 1, 121, 81);
    const out = send(s, [{ type: "join", agentId: "a", colony: 0 }]);
    const view = out.results[0]!.view!;
    expect(squadOf(out.state, "a")).toHaveLength(0);
    expect(view.squad).toEqual([]);
    expect(view.cells).toEqual([]);
    expect(view.territoryTiles).toBe(5);
    expect(view.territoryRows[2]).toBe(`..${"#".repeat(10)}${".".repeat(116)}`);
    expect(view.territoryRows[3]).toBe(view.territoryRows[2]);
    expect(view.territorySharePermille).toBe(Math.trunc(5000 / (64 * 48)));
  });
});

// MCP encoding is a projection only: all raw view facts roundtrip unchanged.
describe("lossless dense MCP cells", () => {
  it("names queen ownership in the single delta grammar without changing the decoder API", () => {
    const cells: ViewCell[] = [
      { tileX: 19, tileY: 11, food: 0, ants: [], queen: 0 },
      { tileX: 19, tileY: 37, food: 0, ants: [], queen: 1, queenHp: 100000 },
    ];
    const dense = denseCells(cells, 64, 48);
    expect(dense.encoding).toContain("p[,queenColony[,queenHp]][:ants]");
    expect(dense.encoding).toContain("queenColony=colony0/1 (own=view.colony), not queenId");
    // Delta positions change; second/third fields still encode colony and milli-HP.
    expect(dense.data).toBe("k3,0;1a8,1,255s");
    expect(expandCells(dense)).toEqual(cells);
  });

  it.each(["v4", "count-marks", "redesign"] as const)("distinguishes own and enemy queens in %s by colony, not queen id, from either colony", rules => {
    for (const colony of [0, 1] as const) {
      const state = send(emptyMatch(0, rulesConfig(rules)), [{ type: "join", agentId: "a", colony }]).state;
      const own = state.colonies[colony], enemy = state.colonies[colony === 0 ? 1 : 0];
      for (const [i, y] of [11, 37].entries()) {
        own.queens!.push({ ...own.queens![0]!, id: i + 1, queenX: tileCentre(19), queenY: tileCentre(y) });
        addAnt(state, colony, 19, y, { squad: "a" });
      }
      addAnt(state, colony, Math.floor(enemy.queenX / SUB), Math.floor(enemy.queenY / SUB), { squad: "a" });
      const view = takeView(state, buildGrid(state), state.agents[0]!);
      const decoded = expandCells(denseCells(view.cells, state.config.mapWidth, state.config.mapHeight));
      const ownCells = decoded.filter(cell => cell.queen === view.colony);
      expect(ownCells).toHaveLength(2);
      for (const cell of ownCells) {
        const queen = view.queens!.find(q => q.tileX === cell.tileX && q.tileY === cell.tileY)!;
        expect(queen).toBeDefined();
        expect(queen.queenId).not.toBe(0);
        expect(cell.queen).toBe(colony);
        if (rules === "redesign") expect(cell.queenHp).toBe(queen.hp);
        else expect(cell).not.toHaveProperty("queenHp");
      }
      const enemyCells = decoded.filter(cell => cell.queen !== undefined && cell.queen !== view.colony);
      expect(enemyCells).toHaveLength(1);
      expect(enemyCells[0]).toMatchObject({ queen: enemy.id, tileX: Math.floor(enemy.queenX / SUB), tileY: Math.floor(enemy.queenY / SUB) });
    }
  });

  it("roundtrips empty cells, food, fogged queens, optional HP and every colony/caste, preserving ant order", () => {
    const cells: ViewCell[] = [];
    for (const colony of [0, 1] as const) for (const caste of [undefined, "worker", "soldier"] as const) {
      cells.push({ tileX: 63, tileY: cells.length, food: cells.length % 2 ? 7 : 0,
        ants: [{ antId: 16731 + cells.length, colony, hp: 1 + cells.length * 1337, ...(caste ? {caste} : {}) }],
        ...(caste ? {queen: colony, queenHp: caste === "worker" ? 0 : 100000} : {}) });
    }
    cells.push({tileX: 0, tileY: 47, food: 5, ants: [], queen: 0});
    cells.push({tileX: 17, tileY: 14, food: 0, ants: []});
    const before = structuredClone(cells);
    const dense = denseCells(cells, 64, 48);
    expect(expandCells(dense)).toEqual(cells);
    expect(cells).toEqual(before);
    expect(expandCells(denseCells([], 64, 48))).toEqual([]);
  });

  it("roundtrips a real raw simulation view without changing it or its replay hash", () => {
    const s = send(createMatch(5), [{ type: "join", agentId: "a" }]).state;
    const raw = observe(s, "a").views[0]!;
    const before = structuredClone(raw);
    expect(expandCells(denseCells(raw.cells, 64 * 2, 48 * 2))).toEqual(raw.cells);
    expect(raw).toEqual(before);
  });
});
