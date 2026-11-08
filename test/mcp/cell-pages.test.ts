import { describe, expect, it } from "vitest";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS } from "../../src/mcp/replies.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { buildGrid, newAnt } from "../../src/sim/map.js";
import { isPassable } from "../../src/sim/terrain.js";
import { expandCells, takeView } from "../../src/sim/view.js";
import { prepareLargestView } from "./response-size-fixture.js";
import { startHarness, type CallResult, type TestAgent } from "./harness.js";

async function largeCapture() {
  const config = { ...withGridScale(rulesConfig("redesign")), antSpeedTilesPerSecond: 0, combatGraceTicks: 1_000_000 };
  const h = await startHarness({ simConfig: config });
  const seats: { agent: TestAgent; id: string; token: string }[] = [];
  for (let i = 0; i < 8; i++) {
    const agent = await h.connect(), join = await agent.call("join", { colony: COLONY_NAMES[i % 2] });
    expect(join.isError, join.text).toBe(false);
    seats.push({ agent, id: join.data.agentId as string, token: join.data.reconnectToken as string });
  }
  prepareLargestView(h, true);
  const state = h.game.match!.state, tiles: [number, number][] = [];
  for (let y = 0; y < config.mapHeight; y++) for (let x = 0; x < config.mapWidth; x++) if (isPassable(state, x, y)) tiles.push([x, y]);
  // Extra ants keep the colony's cells larger than one observe page at the raised limit; the
  // 128x96 board has a quarter of the former 256x192 board's tiles, so it needs more ants per tile.
  for (const colony of [0, 1] as const) for (let i = 0; i < 2_048; i++) state.ants.push(newAnt(config, state.nextAntId++, colony, 0, 0));
  for (const colony of [0, 1]) {
    const ants = state.ants.filter(ant => ant.colony === colony);
    for (const [i, ant] of ants.entries()) {
      const [x, y] = tiles[Math.floor(i * tiles.length / ants.length)]!;
      ant.x = tileCentre(x); ant.y = tileCentre(y);
    }
  }
  return { h, config, caller: seats[0]!, enemy: seats[1]! };
}

function bounded(reply: CallResult) {
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.text.length).toBeLessThanOrEqual(MAX_OBSERVE_TEXT_CHARS);
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: reply.text }], structuredContent: reply.data }))).toBeLessThanOrEqual(MAX_OBSERVE_REPLY_BYTES);
  expect(JSON.parse(reply.text)).toEqual(reply.data);
}

describe("independent bounded cell snapshots", () => {
  it("keeps every squad cell first and all frozen colony cells exactly once despite subsequent death/movement", async () => {
    const { h, config, caller } = await largeCapture();
    try {
      let reply = await caller.agent.call("observe", { map: true }); bounded(reply);
      expect(reply.data.view.cellsMore).toBe(true);
      const snapshot = structuredClone(h.game.match!.state);
      const raw = takeView(snapshot, buildGrid(snapshot), snapshot.agents.find(agent => agent.id === caller.id)!);
      const cells = expandCells(reply.data.view.cells), first = new Set(cells.map(cell => `${cell.tileX},${cell.tileY}`));
      for (const cell of raw.cells) if (raw.squad.some(ant => (ant.tileX - cell.tileX) ** 2 + (ant.tileY - cell.tileY) ** 2 <= config.sightTiles ** 2)) expect(first.has(`${cell.tileX},${cell.tileY}`)).toBe(true);
      const tick = reply.data.view.cellsTick;
      h.game.match!.state.ants = []; // Frozen continuation cannot gain or lose ground with the new world.
      let pages = 1;
      while (reply.data.view.cellsMore) {
        expect(pages++).toBeLessThan(20);
        reply = await caller.agent.call("observe", { cellsCursor: reply.data.view.cellsCursor, map: true }); bounded(reply);
        expect(reply.data.view.cellsTick).toBe(tick);
        cells.push(...expandCells(reply.data.view.cells));
      }
      expect(new Set(cells.map(cell => `${cell.tileX},${cell.tileY}`)).size).toBe(cells.length);
      expect(cells.toSorted((a, b) => a.tileY - b.tileY || a.tileX - b.tileX)).toEqual(raw.cells);
    } finally { await h.close(); }
  });

  it("replays issued pages across reconnect, rejects foreign/unissued/stale cursors and replaces rather than accumulating snapshots", async () => {
    const { h, caller, enemy } = await largeCapture();
    try {
      const first = await caller.agent.call("observe", { map: true }); bounded(first);
      const cursor = first.data.view.cellsCursor as string;
      expect(cursor).toBeTypeOf("string");
      const foreign = await enemy.agent.call("observe", { cellsCursor: cursor });
      expect(foreign.data.error.code).toBe("bad_cells_cursor");
      expect((await caller.agent.call("observe", { cellsCursor: cursor.split(":")[0] + ":1" })).data.error.code).toBe("bad_cells_cursor");
      const page = await caller.agent.call("observe", { cellsCursor: cursor }); bounded(page);
      const cells = expandCells(page.data.view.cells);
      await caller.agent.end();
      const reconnected = await h.connect();
      // Rejoin preserves the one retained capture; only a fresh observe replaces it.
      bounded(await reconnected.call("join", { token: caller.token }));
      const resumed = await reconnected.call("observe", { cellsCursor: cursor }); bounded(resumed);
      expect(expandCells(resumed.data.view.cells)).toEqual(cells);
      const fresh = await reconnected.call("observe", { map: true }); bounded(fresh);
      const next = await reconnected.call("observe", { cellsCursor: fresh.data.view.cellsCursor }); bounded(next);
      const replay = await reconnected.call("observe", { cellsCursor: fresh.data.view.cellsCursor }); bounded(replay);
      expect(expandCells(replay.data.view.cells)).toEqual(expandCells(next.data.view.cells));
      expect(cells.length).toBeGreaterThan(0);
      const replaced = await reconnected.call("observe"); bounded(replaced);
      expect((await reconnected.call("observe", { cellsCursor: fresh.data.view.cellsCursor })).data.error.code).toBe("bad_cells_cursor");
    } finally { await h.close(); }
  }, 30_000); // Execution timeout only; budgets and assertions unchanged.

  it("keeps event history cursors independent, resumes at match end and drops the snapshot on retirement", async () => {
    const { h, caller, config } = await largeCapture();
    try {
      const first = await caller.agent.call("observe", { map: true }); bounded(first);
      const cursor = first.data.view.cellsCursor as string, eventCursor = h.game.eventCursor(caller.id);
      const page = await caller.agent.call("observe", { cellsCursor: cursor }); bounded(page);
      expect(h.game.eventCursor(caller.id)).toBe(eventCursor);
      const history = await caller.agent.call("observe", { cellsCursor: cursor, since: 0 }); bounded(history);
      expect(history.data.view.eventsMode).toBe("history");
      expect(expandCells(history.data.view.cells)).toEqual(expandCells(page.data.view.cells));
      const state = h.game.match!.state;
      state.result = { winner: 0, reason: "time_up", tick: state.tick, decidedBy: "territory" };
      const ended = await caller.agent.call("observe", { cellsCursor: cursor }); bounded(ended);
      expect(ended.data.matchOver).toBe(true);
      expect(ended.data.view.cellsTick).toBe(first.data.view.cellsTick);
      const snapshot = structuredClone(state), raw = takeView(snapshot, buildGrid(snapshot), snapshot.agents.find(agent => agent.id === caller.id)!);
      h.game.startMatch(2); h.game.match!.state.result = state.result;
      h.game.startMatch(3);
      expect(h.game.cellsFor(raw, config, cursor)).toBeNull();
    } finally { await h.close(); }
  });

  it("keeps only the latest capture when fresh observes race", async () => {
    const { h, caller } = await largeCapture();
    try {
      const replies = await Promise.all([caller.agent.call("observe", { map: true }), caller.agent.call("observe", { map: true })]);
      for (const reply of replies) { bounded(reply); expect(reply.data.view.cellsMore).toBe(true); }
      const resumed = [];
      for (const reply of replies) resumed.push(await caller.agent.call("observe", { cellsCursor: reply.data.view.cellsCursor }));
      expect(resumed.filter(reply => reply.isError)).toHaveLength(1);
      expect(resumed.find(reply => reply.isError)!.data.error.code).toBe("bad_cells_cursor");
      bounded(resumed.find(reply => !reply.isError)!);
    } finally { await h.close(); }
  });

  it("handles empty colony sight without making a cursor or leaking enemy ground", async () => {
    const h = await startHarness({ simConfig: { ...rulesConfig("redesign"), startAnts: 0 } });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join", { colony: COLONY_NAMES[0] }); bounded(joined);
      expect(joined.data.view.cellsMore).toBe(false);
      expect(joined.data.view.cellsCursor).toBeNull();
      expect(expandCells(joined.data.view.cells)).toEqual([]);
      expect((await agent.call("observe", { cellsCursor: "not-a-cursor" })).data.error.code).toBe("bad_cells_cursor");
    } finally { await h.close(); }
  });
});
