// The harness decoders are generated from the server's; the server's own encoders and decoders are the reference.
import { describe, expect, it } from "vitest";
import { denseCells, expandCells as serverExpandCells } from "../../../src/sim/view.ts";
import { packTerritory } from "../../../src/mcp/territory.ts";
import { packMarks } from "../../../src/mcp/markTable.ts";
import { MAX_OBSERVE_TEXT_CHARS } from "../../../src/mcp/replies.ts";
import { terrainView } from "../../../src/sim/terrain.ts";
import { WIDE_PLAIN } from "../../../src/sim/scale2Maps.ts";
import { expandCells, renderView, unpackMarks, unpackTerritory } from "../lib/board.mjs";

const W = 128, H = 96; // New-match grid (gridScale 2).

/** Deterministic pseudo-random numbers, so measured sizes are stable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const KINDS = [[0, undefined], [1, undefined], [0, "worker"], [1, "worker"], [0, "soldier"], [1, "soldier"]];

function coverageCells() {
  const cells = [];
  // Food-only runs: equal food (merged into one repeat), then a change of food.
  for (let x = 2; x < 9; x++) cells.push({ tileX: x, tileY: 3, food: 4, ants: [] });
  for (let x = 9; x < 12; x++) cells.push({ tileX: x, tileY: 3, food: 1, ants: [] });
  cells.push({ tileX: 127, tileY: 3, food: 4, ants: [] });
  cells.push({ tileX: 0, tileY: 4, food: 4, ants: [] }); // Run continues across a row boundary by index.
  // Queens with and without hp, both colonies, with and without ants and food.
  cells.push({ tileX: 10, tileY: 20, food: 0, ants: [], queen: 0, queenHp: 30000 });
  cells.push({ tileX: 117, tileY: 20, food: 2, ants: [{ antId: 9, colony: 0, hp: 1 }], queen: 1 });
  cells.push({ tileX: 118, tileY: 20, food: 0, ants: [], queen: 1, queenHp: 0 });
  // Every caste kind for both colonies, mixed on one tile and alone.
  cells.push({ tileX: 40, tileY: 50, food: 0, ants: KINDS.map(([colony, caste], i) => ({ antId: 100 + i, colony, hp: 4000 - i * 333, ...(caste ? { caste } : {}) })) });
  KINDS.forEach(([colony, caste], i) => cells.push({ tileX: 41 + i, tileY: 50, food: i, ants: [{ antId: 2000 + i, colony, hp: 1234 + i, ...(caste ? { caste } : {}) }] }));
  return cells.sort((a, b) => a.tileY * W + a.tileX - (b.tileY * W + b.tileX));
}

/** Flyers of both colonies in each state, beside a worker and under a queen. */
function flyerCells() {
  return [
    { tileX: 30, tileY: 48, food: 0, ants: [{ antId: 300, colony: 0, hp: 2000, caste: "worker", flyer: "grounded" },
      { antId: 301, colony: 1, hp: 2000, caste: "worker", flyer: "grounded" }, { antId: 302, colony: 0, hp: 4000, caste: "worker" }] },
    { tileX: 31, tileY: 48, food: 2, ants: [{ antId: 303, colony: 0, hp: 1500, caste: "worker", flyer: "flying" }, { antId: 304, colony: 1, hp: 2000, caste: "worker", flyer: "flying" }] },
    { tileX: 33, tileY: 48, food: 0, ants: [{ antId: 305, colony: 0, hp: 2000, caste: "worker", flyer: "hovering" }, { antId: 306, colony: 1, hp: 1, caste: "worker", flyer: "hovering" }], queen: 1, queenHp: 21500 },
  ];
}

describe("generated decoders match the server", () => {
  it("generated expandCells returns exactly what the server's expandCells returns for denseCells output", () => {
    const cells = coverageCells();
    const table = denseCells(cells, W, H);
    expect(table.data).toContain("*"); // A food-only repeat is exercised.
    expect(expandCells(table)).toEqual(serverExpandCells(table));
    expect(expandCells(table)).toEqual(cells);
    const random = scene(rng(7), { own: 300, enemy: 200, food: 400 }).cells;
    const big = denseCells(random, W, H);
    expect(expandCells(big)).toEqual(serverExpandCells(big));
    expect(expandCells({ ...table, data: "" })).toEqual([]);
  });

  it("generated expandCells refuses what the server refuses", () => {
    const table = denseCells(coverageCells(), W, H);
    for (const data of ["zz!", "1,0*2", "0*0", `${(W * H * table.foodRadix).toString(36)}`]) {
      expect(() => serverExpandCells({ ...table, data })).toThrow();
      expect(() => expandCells({ ...table, data })).toThrow();
    }
  });

  it("generated expandCells decodes a flyer table as the server does and refuses what the server refuses", () => {
    const table = denseCells(flyerCells(), W, H, 2, true);
    expect(table.data).toMatch(/\.[gfh](\/|;|$)/);
    expect(expandCells(table)).toEqual(serverExpandCells(table));
    expect(expandCells(table)).toEqual(flyerCells());
    for (const data of ["0:1.8.l", "0:1.8.h.3", "0:1.8.", "0:1.8.constructor"]) {
      expect(() => serverExpandCells({ ...table, foodRadix: 1, data }), data).toThrow();
      expect(() => expandCells({ ...table, foodRadix: 1, data }), data).toThrow();
    }
  });

  it("territory unpack returns the rows packTerritory packed", () => {
    const next = rng(3);
    for (const [w, h] of [[W, H], [64, 48], [5, 3], [1, 1]]) {
      const rows = Array.from({ length: h }, () => Array.from({ length: w }, () => (next() < 0.4 ? "#" : ".")).join(""));
      expect(unpackTerritory(packTerritory(rows, w, h))).toEqual(rows);
    }
    const packed = packTerritory(["#.#.#"], 5, 1);
    expect(() => unpackTerritory({ ...packed, data: "////" })).toThrow();
  });

  it("marks unpack returns the marks packMarks packed", () => {
    const marks = [{ markId: 1, words: ["food"], tileX: 3, tileY: 4, ticksLeft: 90, mine: true },
      { markId: 2, words: [], tileX: 5, tileY: 6, ticksLeft: 10, mine: false, verb: "attack", count: 4, claimed: 2, caste: "soldier" }];
    expect(unpackMarks(packMarks(marks))).toEqual(marks);
    expect(unpackMarks(marks)).toEqual(marks);
  });
});

/** A view of `own` own ants, `enemy` enemy ants and `food` food tiles around two nests. */
function scene(next, { own, enemy, food, damaged = 0.3, idBase = 0 }) {
  const tiles = new Map();
  const tile = (x, y) => {
    const key = y * W + x;
    if (!tiles.has(key)) tiles.set(key, { tileX: x, tileY: y, food: 0, ants: [] });
    return tiles.get(key);
  };
  const around = (cx, cy, r) => [Math.max(0, Math.min(W - 1, Math.round(cx + (next() - 0.5) * 2 * r))), Math.max(0, Math.min(H - 1, Math.round(cy + (next() - 0.5) * 2 * r)))];
  for (let i = 0; i < food; i++) {
    const [x, y] = around(i % 2 ? 40 : 88, 48, 10);
    tile(x, y).food = 1 + (i % 3 === 0 ? 2 : 0);
  }
  let id = idBase;
  const ants = (count, colony, cx) => {
    for (let i = 0; i < count; i++) {
      const [x, y] = around(cx, 48, 30);
      const caste = next() < 0.7 ? "worker" : "soldier";
      tile(x, y).ants.push({ antId: id++, colony, hp: next() < damaged ? 1 + Math.floor(next() * 3999) : 4000, caste });
    }
  };
  ants(own, 0, 30);
  ants(enemy, 1, 98);
  Object.assign(tile(16, 48), { queen: 0, queenHp: 30000 });
  if (enemy) Object.assign(tile(112, 48), { queen: 1, queenHp: 21500 });
  return { cells: [...tiles.values()].sort((a, b) => a.tileY * W + a.tileX - (b.tileY * W + b.tileX)) };
}

function blobTerritory(share) {
  return Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (Math.hypot(x - 16, y - 48) < Math.sqrt((share * W * H) / Math.PI) ? "#" : ".")).join(""));
}

function reply(cells, territoryRows, { more = false } = {}) {
  return { view: {
    tick: 4200, agentId: "agent-1", colony: 0, colonyName: "red", idle: false, ticksLeft: 13800, secondsLeft: 1380,
    squad: Array.from({ length: 6 }, (_, i) => ({ antId: i + 1, x: 30500 + i * 1000, y: 48500, tileX: 30 + i, tileY: 48, hp: 4000, carrying: i % 2 === 0, caste: "worker" })),
    brood: "worker", myBrood: "worker",
    queens: [{ queenId: 1, tileX: 16, tileY: 48, foundedTick: 0, lostTick: null, overrunTicks: 0, hp: 30000, maxHp: 30000 }],
    order: { kind: "forage", tileX: 40, tileY: 48 }, orderStatus: "6 ants foraging", nextCommandTick: 4210,
    marks: packMarks(Array.from({ length: 5 }, (_, i) => ({ markId: i + 1, words: ["food"], tileX: 40 + i, tileY: 48, ticksLeft: 300, mine: i < 2 }))),
    myMarks: [{ markId: 1, steering: 3 }, { markId: 2, steering: 0 }],
    territoryTiles: 0, territorySharePermille: 250, result: null,
    ...(territoryRows ? { territory: packTerritory(territoryRows, W, H) } : {}),
    cells: denseCells(cells, W, H), cellsTick: 4200, cellsMore: more, cellsCursor: more ? "snap-1:300" : null,
    events: [], eventsMode: "current", eventCursor: 12, eventsMore: false, priorityEventsMore: false,
  } };
}

/** Largest prefix of cells whose raw reply text fits the server's observe page (49,000 chars). */
function fullPage(cells, territoryRows) {
  let low = 1, high = cells.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(reply(cells.slice(0, mid), territoryRows, { more: true })).length <= MAX_OBSERVE_TEXT_CHARS) low = mid;
    else high = mid - 1;
  }
  return reply(cells.slice(0, low), territoryRows, { more: low < cells.length });
}

function measure(data) {
  return { raw: JSON.stringify(data).length, printed: renderView(data).length };
}

const SIZES = {};

describe("readable view", () => {
  it("prints every decoded cell, own territory, squad, queens and marks", () => {
    const cells = coverageCells();
    const data = reply(cells, ["#".repeat(W), ...Array.from({ length: H - 1 }, (_, y) => (y === 47 ? `${".".repeat(10)}###.#${".".repeat(W - 15)}` : ".".repeat(W)))]);
    const text = renderView(data);
    expect(text).toContain(`cells tick 4200: ${cells.length} tiles (complete)`);
    expect(text).toContain("y3: 2-8f4 9-11f1 127f4");
    expect(text).toContain("y4: 0f4");
    expect(text).toContain("y20: 10Qown30 117f2Qenemy:9a0.001 118Qenemy0");
    expect(text).toContain("y50: 40:100a4,101A3.667,102w3.334,103W3.001,104s2.668,105S2.335 41:2000a1.234 42f1:2001A1.235 43f2:2002w1.236 44f3:2003W1.237 45f4:2004s1.238 46f5:2005S1.239");
    expect(text).toContain("y0: 0-127\ny48: 10-12 14");
    expect(text).toContain('{"antId":6,"x":35500,"y":48500,"tileX":35,"tileY":48,"hp":4000,"carrying":false,"caste":"worker"}');
    expect(text).toContain("marks (5):\n");
    expect(text).toContain('{"markId":5,"words":["food"],"tileX":44,"tileY":48,"ticksLeft":300,"mine":false}');
    expect(text).toContain('myMarks (2):\n{"markId":1,"steering":3}');
  });

  it("prints sighted enemy ranges under the colony number, separately from own territory", () => {
    const view = { colony: 2, territory: packTerritory([".#.", "..."], 3, 2, { 0: [0, 4, 5], 3: [2] }) };
    expect(renderView({ view })).toContain("y0: 1\nterritory enemy colony 0 (in sight):\ny0: 0\ny1: 1-2\nterritory enemy colony 3 (in sight):\ny0: 2");
    expect(renderView({ view: { territory: packTerritory(["."], 1, 1, {}) } })).toContain("territory enemy (in sight): none");
    expect(renderView({ view: { territory: packTerritory(["."], 1, 1) } })).not.toContain("territory enemy");
  });

  it("prints each flyer, own or enemy, as a flyer with its state", () => {
    const data = reply([], null);
    data.view.cells = denseCells(flyerCells(), W, H, 2, true);
    const text = renderView(data);
    expect(text).toContain("caste w=worker s=soldier f=flyer a=none");
    expect(text).toContain("y48: 30:300f2(grounded),301F2(grounded),302w4 31f2:303f1.5(flying),304F2(flying) 33Qenemy21.5:305f2(hovering),306F0.001(hovering)");
  });

  it("says when more cells follow", () => {
    const data = reply(coverageCells(), null, { more: true });
    const text = renderView(data);
    expect(text).toContain("MORE CELLS FOLLOW, not shown: observe --cellsCursor snap-1:300");
    expect(text).toContain("territory: not in this reply");
  });

  it("measures printed size against the raw reply", () => {
    const typical = reply(scene(rng(11), { own: 120, enemy: 25, food: 300, idBase: 200 }).cells, blobTerritory(0.25));
    const late = reply(scene(rng(12), { own: 500, enemy: 450, food: 400, idBase: 1500 }).cells, blobTerritory(0.45));
    // Worst case: a full server page of 4-digit-id ants, every one damaged to a 3-decimal hp,
    // plus an aligned 2x2 checkerboard territory (the most ranges a gridScale-2 board can hold).
    const crowd = scene(rng(13), { own: 3000, enemy: 3000, food: 0, damaged: 1, idBase: 1000 }).cells;
    const checker = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => ((x >> 1) + (y >> 1)) % 2 ? "#" : ".").join(""));
    const worst = fullPage(crowd, checker);
    const worstCells = fullPage(crowd, blobTerritory(0.45));
    Object.assign(SIZES, { typical: measure(typical), late: measure(late), worstCells: measure(worstCells), worst: measure(worst) });
    console.log("observe printed size (chars) vs raw reply:", JSON.stringify(SIZES));
    // Guards on the measured figures (reported): the readable view is smaller than the
    // raw reply typically, close to it late in a match, and bounded by one server page at worst.
    expect(SIZES.typical.printed).toBeLessThan(SIZES.typical.raw);
    expect(SIZES.late.printed).toBeLessThan(SIZES.late.raw * 1.1);
    expect(SIZES.worstCells.printed).toBeLessThan(SIZES.worstCells.raw * 1.5);
    expect(SIZES.worst.printed).toBeLessThan(SIZES.worst.raw * 1.8);
    expect(worst.view.cellsMore).toBe(true);
  });

  it("prints every water and rock rectangle of a real map, in the view and the nest selection", () => {
    // Wide Plain at gridScale 2, plus more rocks than the 12-item cut other fields get.
    const water = WIDE_PLAIN.water.map((r) => ({ x: r.x * 2, y: r.y * 2, width: r.width * 2, height: r.height * 2 }));
    const rocks = Array.from({ length: 14 }, (_, i) => ({ x: 4 + i * 8, y: 90, width: 2, height: 2 }));
    const terrain = terrainView({ mapId: WIDE_PLAIN.id, mapName: WIDE_PLAIN.name, water, rocks });
    expect(terrain.water.length).toBeGreaterThan(12);
    const data = reply(coverageCells(), null);
    data.view.terrain = terrain;
    data.nestSelection = { required: false, terrain, picks: [] };
    const header = JSON.parse(renderView(data).split("\n")[0]);
    expect(header.view.terrain).toEqual(terrain);
    expect(header.nestSelection.terrain).toEqual(terrain);
  });

  it("cuts long lists to 12 items and counts every item not shown", () => {
    const data = reply(coverageCells(), null);
    const items = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
    data.view.events = items(20);
    data.view.cutAtThirteen = items(13);
    data.view.shortList = items(12);
    data.recent = items(20);
    const header = JSON.parse(renderView(data).split("\n")[0]);
    expect(header.view.events).toEqual([...items(12), "…8 more"]);
    expect(header.view.cutAtThirteen).toEqual([...items(12), "…1 more"]);
    expect(header.view.shortList).toEqual(items(12));
    expect(header.recent).toEqual([...items(12), "…8 more"]);
  });
});

/** A small reply as seen by `colony`, its cell table built by the server's encoder for `colonies` colonies. */
function seatReply(cells, colony, colonies, top = {}) {
  return { ...top, view: { tick: 10, agentId: "agent-1", colony, colonyName: "red", idle: false,
    squad: [{ antId: 1, tileX: 10, tileY: 20, hp: 4000, caste: "worker" }],
    queens: [{ queenId: 1, tileX: 10, tileY: 20, lostTick: null, hp: 30000 }],
    cells: denseCells(cells, W, H, colonies), cellsTick: 10, cellsMore: false, cellsCursor: null } };
}

const FOOD_RUN = [5, 6, 7].map((tileX) => ({ tileX, tileY: 2, food: 3, ants: [] }));

describe("readable view: enemy colonies", () => {
  it("prints a two-colony reply exactly as before, key line included", () => {
    const cells = [...FOOD_RUN,
      { tileX: 10, tileY: 20, food: 0, ants: [{ antId: 1, colony: 0, hp: 4000, caste: "worker" }], queen: 0, queenHp: 30000 },
      { tileX: 117, tileY: 20, food: 2, ants: [{ antId: 9, colony: 1, hp: 3500, caste: "soldier" }, { antId: 10, colony: 0, hp: 1 }], queen: 1, queenHp: 21500 },
      { tileX: 118, tileY: 20, food: 0, ants: [], queen: 1 }];
    const data = seatReply(cells, 0, 2, { matchOver: true, winner: "red", result: { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: 10 } });
    expect(data.view.cells.colonies).toBeUndefined();
    expect(renderView(data)).toBe([
      '{"matchOver":true,"winner":"red","result":{"winner":0,"reason":"queens_killed","decidedBy":"queens_killed","tick":10},"view":{"tick":10,"agentId":"agent-1","colony":0,"colonyName":"red","idle":false}}',
      "squad (1):",
      '{"antId":1,"tileX":10,"tileY":20,"hp":4000,"caste":"worker"}',
      "queens (1):",
      '{"queenId":1,"tileX":10,"tileY":20,"lostTick":null,"hp":30000}',
      "cells tick 10: 6 tiles (complete)",
      "key: per row y<row>: tiles by x; x-x2 = run of equal food-only tiles; f<n> food; Q<own|enemy><hp> queen; :ants, comma-separated id+caste+hp, caste w=worker s=soldier f=flyer a=none, lowercase own UPPERCASE enemy; hp in HP; a flyer adds its state (grounded), (flying) or (hovering)",
      "y2: 5-7f3",
      "y20: 10Qown30:1w4 117f2Qenemy21.5:9S3.5,10a0.001 118Qenemy",
      "territory: not in this reply (observe with map:true)",
    ].join("\n"));
  });

  // Every colony's ants and queens, with and without caste and queen hp.
  const fourColonyCells = [...FOOD_RUN,
    { tileX: 10, tileY: 20, food: 0, ants: [{ antId: 1, colony: 0, hp: 4000, caste: "worker" }], queen: 0, queenHp: 30000 },
    { tileX: 117, tileY: 20, food: 2, ants: [{ antId: 9, colony: 1, hp: 3500, caste: "soldier" }, { antId: 10, colony: 0, hp: 1 }], queen: 1, queenHp: 21500 },
    { tileX: 118, tileY: 20, food: 0, ants: [], queen: 2 },
    { tileX: 10, tileY: 80, food: 0, ants: [{ antId: 20, colony: 3, hp: 4000, caste: "worker" }, { antId: 21, colony: 2, hp: 2000 }], queen: 3, queenHp: 0 },
    { tileX: 11, tileY: 80, food: 1, ants: [{ antId: 22, colony: 1, hp: 1234, caste: "worker" }, { antId: 23, colony: 2, hp: 4000, caste: "soldier" }, { antId: 24, colony: 3, hp: 3000, caste: "soldier" }] }];
  const keyLine = (own) => "key: per row y<row>: tiles by x; x-x2 = run of equal food-only tiles; f<n> food; Q<own|enemy><hp> queen; :ants, comma-separated id+caste+hp, caste w=worker s=soldier f=flyer a=none, lowercase own UPPERCASE enemy; hp in HP; a flyer adds its state (grounded), (flying) or (hovering)"
    + `; @<n> ends each enemy ant and enemy queen: the colony it belongs to, 0-3 (yours is ${own})`;
  const cellPart = (text) => text.split("\n").slice(text.split("\n").findIndex((line) => line.startsWith("cells ")), -1);

  it("labels enemy ants and queens of colonies 1-3 by colony from colony 0's view", () => {
    const data = seatReply(fourColonyCells, 0, 4);
    expect(data.view.cells.colonies).toBe(4);
    expect(cellPart(renderView(data))).toEqual([
      "cells tick 10: 8 tiles (complete)",
      keyLine(0),
      "y2: 5-7f3",
      "y20: 10Qown30:1w4 117f2Qenemy21.5@1:9S3.5@1,10a0.001 118Qenemy@2",
      "y80: 10Qenemy0@3:20W4@3,21A2@2 11f1:22W1.234@1,23S4@2,24S3@3",
    ]);
  });

  it("labels enemy ants and queens of colonies 0-2 by colony from colony 3's view", () => {
    expect(cellPart(renderView(seatReply(fourColonyCells, 3, 4)))).toEqual([
      "cells tick 10: 8 tiles (complete)",
      keyLine(3),
      "y2: 5-7f3",
      "y20: 10Qenemy30@0:1W4@0 117f2Qenemy21.5@1:9S3.5@1,10A0.001@0 118Qenemy@2",
      "y80: 10Qown0:20w4,21A2@2 11f1:22W1.234@1,23S4@2,24s3",
    ]);
  });

  it("marks each flyer with its state, then its colony, in a four-colony table with flyers", () => {
    const cells = [{ tileX: 10, tileY: 20, food: 0, queen: 0, queenHp: 30000, ants: [{ antId: 1, colony: 0, hp: 4000, caste: "worker", flyer: "grounded" }] },
      { tileX: 12, tileY: 20, food: 0, ants: [{ antId: 30, colony: 3, hp: 2000, caste: "worker", flyer: "flying" }, { antId: 31, colony: 2, hp: 1500, caste: "worker", flyer: "hovering" }, { antId: 32, colony: 1, hp: 4000, caste: "soldier" }] }];
    const data = seatReply(cells, 0, 4);
    data.view.cells = denseCells(cells, W, H, 4, true);
    expect(expandCells(data.view.cells)).toEqual(cells);
    expect(cellPart(renderView(data))).toEqual([
      "cells tick 10: 2 tiles (complete)",
      keyLine(0),
      "y20: 10Qown30:1f4(grounded) 12:30F2(flying)@3,31F1.5(hovering)@2,32S4@1",
    ]);
  });

  it("keeps the opponents list, the seat's elimination and the final result whole", () => {
    const opponents = [{ colony: 0, name: "Amber" }, { colony: 1, name: "Birch", eliminated: { tick: 2500, reason: "queens_killed" } }, { colony: 3, name: "Dune", eliminated: { tick: 2900, reason: "idle" } }];
    const eliminated = { tick: 3000, reason: "idle" };
    const playing = renderView(seatReply(fourColonyCells, 2, 4, { opponents, eliminated }));
    const header = JSON.parse(playing.split("\n")[0]);
    expect(header.opponents).toEqual(opponents);
    expect(header.eliminated).toEqual(eliminated);
    expect(playing).toContain("y80: 10Qenemy0@3:20W4@3,21a2 11f1:22W1.234@1,23s4,24S3@3");
    const result = { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: 4000 };
    const over = JSON.parse(renderView(seatReply(fourColonyCells, 2, 4, { opponents, eliminated, matchOver: true, winner: "Amber", result })).split("\n")[0]);
    expect({ opponents: over.opponents, eliminated: over.eliminated, matchOver: over.matchOver, winner: over.winner, result: over.result })
      .toEqual({ opponents, eliminated, matchOver: true, winner: "Amber", result });
  });
});
