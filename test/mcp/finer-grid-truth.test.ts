import { describe, expect, it } from "vitest";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS } from "../../src/mcp/replies.js";
import { COLONY_NAMES } from "../../src/sim/config.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions } from "../../src/server.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { buildGrid } from "../../src/sim/map.js";
import { takeView } from "../../src/sim/view.js";
import { startHarness } from "./harness.js";
import { prepareLargestView } from "./response-size-fixture.js";

/** Decode the public geometry independently of the production serializer. */
function rectangleTiles(rectangles: readonly (readonly number[])[], width: number, height: number): boolean[] {
  const tiles = Array<boolean>(width * height).fill(false);
  for (const rectangle of rectangles) {
    expect(rectangle).toHaveLength(4);
    const [x, y, w, h] = rectangle as readonly [number, number, number, number];
    expect([x, y, w, h].every(Number.isInteger)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(x + w).toBeLessThanOrEqual(width);
    expect(y + h).toBeLessThanOrEqual(height);
    for (let row = y; row < y + h; row++) {
      for (let column = x; column < x + w; column++) tiles[row * width + column] = true;
    }
  }
  return tiles;
}

/** Independent decoder for the agreed public bit order; never calls its encoder. */
function territoryTiles(view: { territory: { encoding: string; width: number; height: number; data: string } }, width: number, height: number): boolean[] {
  const map = view.territory;
  expect(map.encoding).toBe("base64-bitset-lsb0");
  expect(map.width).toBe(width);
  expect(map.height).toBe(height);
  const bytes = Buffer.from(map.data, "base64");
  expect(bytes.toString("base64")).toBe(map.data);
  expect(bytes.length).toBe(Math.ceil(width * height / 8));
  const used = width * height % 8;
  if (used) expect(bytes.at(-1)! >> used).toBe(0);
  return Array.from({ length: width * height }, (_, i) => (bytes[Math.floor(i / 8)]! & (1 << (i % 8))) !== 0);
}

/** Null is an absent optional field in the public pressure-only mark table. */
function publicMarks(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value;
  const table = value as { encoding: string; fields: string[]; rows: unknown[][] };
  expect(table.encoding).toBe("columnar-v1");
  expect(new Set(table.fields).size).toBe(table.fields.length);
  return table.rows.map(row => {
    expect(row.length).toBe(table.fields.length);
    return Object.fromEntries(table.fields.flatMap((field, i) => row[i] === null ? [] : [[field, row[i]]]));
  });
}

function visibleCaste(mark: object): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mark)) as Record<string, unknown>;
  if (result.caste !== "worker" && result.caste !== "soldier") delete result.caste;
  return result;
}

// Follow the production new-match boundary, not rulesConfig's historical reference grid.
const shipped = comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!;

describe("the shipped maps' agent terrain and ownership are exact", () => {
  it.each(shipped.terrain!.maps)("$name: eight maximum-colony views fit without requesting territory", async map => {
    const config = { ...shipped, terrain: { ...shipped.terrain!, mapId: map.id } };
    const h = await startHarness({ simConfig: config });
    try {
      const agents = [];
      for (let seat = 0; seat < 8; seat++) {
        const agent = await h.connect();
        expect((await agent.call("join", { colony: COLONY_NAMES[seat % 2] })).isError).toBe(false);
        agents.push(agent);
      }
      for (const agent of agents) {
        prepareLargestView(h, true);
        expect(h.game.match!.state.ants.filter(ant => ant.colony === 0)).toHaveLength(512);
        expect(h.game.match!.state.ants.filter(ant => ant.colony === 1)).toHaveLength(512);
        const reply = await agent.client.callTool({ name: "observe", arguments: {} });
        const text = (reply.content as { type: string; text: string }[]).filter(block => block.type === "text").map(block => block.text).join("");
        expect(reply.isError).not.toBe(true);
        // Independent ceilings: changing production constants must not bless an overflow.
        expect(text.length).toBeLessThanOrEqual(MAX_OBSERVE_TEXT_CHARS);
        expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(MAX_OBSERVE_REPLY_BYTES);
        expect(JSON.parse(text)).toEqual(reply.structuredContent);
        const data = reply.structuredContent as { view: { agentId: string; tick: number; territory?: unknown; territoryRows?: unknown; terrain: unknown; cells: unknown; squad: unknown; marks: unknown; myMarks: unknown } };
        expect(data.view).not.toHaveProperty("territory");
        expect(data.view).not.toHaveProperty("territoryRows");
        for (const field of ["terrain", "cells", "squad", "marks", "myMarks"]) expect(data.view).toHaveProperty(field);
        // Compare decoded transport against the underlying view at the same tick,
        // without consuming events from the actual running fixture.
        const snapshot = structuredClone(h.game.match!.state);
        expect(snapshot.tick).toBe(data.view.tick);
        const owner = snapshot.agents.find(candidate => candidate.id === data.view.agentId)!;
        const expected = takeView(snapshot, buildGrid(snapshot), owner);
        expect(publicMarks(data.view.marks)).toEqual(expected.marks.map(visibleCaste));
        expect(publicMarks(data.view.myMarks)).toEqual(expected.myMarks.map(visibleCaste));
      }
    } finally { await h.close(); }
  }, 30_000);

  it.each(shipped.terrain!.maps)("$name: public water and rocks match blocked tiles, including rectangle edges", async map => {
    const config = { ...shipped, terrain: { ...shipped.terrain!, mapId: map.id } };
    const h = await startHarness({ simConfig: config, seed: 23 });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join");
      expect(joined.isError).toBe(false);
      const observed = await agent.call("observe");
      expect(observed.isError).toBe(false);
      const state = h.game.match!.state;
      const { mapWidth: width, mapHeight: height } = state.config;
      for (const view of [joined.data.view, observed.data.view]) {
        expect(view.terrain.mapId).toBe(map.id);
        const water = rectangleTiles(view.terrain.water, width, height);
        const rocks = rectangleTiles(view.terrain.rocks, width, height);
        const expectedWater = Array.from({ length: width * height }, (_, i) => isWaterTile(state.terrain, i % width, Math.floor(i / width)));
        const expectedRocks = Array.from({ length: width * height }, (_, i) => isRockTile(state.terrain, i % width, Math.floor(i / width)));
        expect(water).toEqual(expectedWater);
        expect(rocks).toEqual(expectedRocks);
        expect(water.some((wet, i) => wet && rocks[i])).toBe(false);
      }
    } finally { await h.close(); }
  });

  it.each(shipped.terrain!.maps)("$name: each colony's map is its own tiles, including fragmented ownership", async map => {
    const config = { ...shipped, terrain: { ...shipped.terrain!, mapId: map.id } };
    const h = await startHarness({ simConfig: config });
    try {
      const agents = await Promise.all([h.connect(), h.connect()]);
      for (const [colony, agent] of agents.entries()) {
        expect((await agent.call("join", { colony: COLONY_NAMES[colony] })).isError).toBe(false);
      }
      const state = h.game.match!.state;
      // Non-run-friendly pattern includes both colonies and neutral cells. A real
      // observe may tick; compare against the authoritative state at that reply.
      // The drawn match's size: a board map plays at its own.
      const { mapWidth: width, mapHeight: height } = state.config;
      for (let i = 0; i < state.owner.length; i++) {
        const x = i % width, y = Math.floor(i / width);
        state.owner[i] = isWaterTile(state.terrain, x, y) || isRockTile(state.terrain, x, y) ? -1 : (i % 3 === 0 ? -1 : i % 3 === 1 ? 0 : 1);
        state.lastVisit[i] = state.tick;
      }
      for (const [colony, agent] of agents.entries()) {
        const reply = await agent.call("observe", { map: true });
        expect(reply.isError).toBe(false);
        const own = territoryTiles(reply.data.view, width, height);
        expect(reply.data.view).not.toHaveProperty("territoryRows");
        expect(reply.data.view.tick).toBe(h.game.match!.state.tick);
        expect(own).toEqual(h.game.match!.state.owner.map(owner => owner === colony));
        const withoutMap = await agent.call("observe");
        expect(withoutMap.isError).toBe(false);
        expect(withoutMap.data.view).not.toHaveProperty("territoryRows");
        expect(withoutMap.data.view).not.toHaveProperty("territory");
      }
    } finally { await h.close(); }
  });
});
