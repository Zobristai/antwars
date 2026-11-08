import { unpackTerritory } from "../../src/mcp/territory.js";
import { expandCells } from "../../src/sim/view.js";
import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES, SUB, type SimConfig } from "../../src/sim/config.js";
import { withinTiles } from "../../src/sim/geometry.js";
import type { SimState, VisibleEvent } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { TEST_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";
import { physicalTileArea } from "../../src/sim/gridScale.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const [VLC, LHC] = COLONY_NAMES;

async function joinAs(harness: Harness, args: Record<string, unknown> = {}): Promise<{ agent: TestAgent; data: any }> {
  const agent = await harness.connect();
  const r = await agent.call("join", args);
  expect(r.isError, r.text).toBe(false);
  return { agent, data: r.data };
}

/** A block of ants for colony `colony` starting at a tile. */
function block(state: SimState, colony: 0 | 1, x0: number, y0: number, count: number, width = 4): void {
  for (let i = 0; i < count; i += 1) addAnt(state, colony, x0 + (i % width), y0 + Math.floor(i / width));
}

/** Two clusters in smell range of each other, no food, so ants stay put-ish. */
function contested(config: SimConfig = TEST_CONFIG): SimState {
  const state = emptyMatch(0, config);
  state.food.fill(0);
  block(state, 0, 10, 10, 24);
  block(state, 1, 15, 10, 24);
  return state;
}

describe("observe", () => {
  it("returns one tick-stamped, fogged view with squad, order status, time, territory, marks steering and nearby marks", async () => {
    const state = contested();
    // A far colony-1 ant no colony-0 agent can see.
    addAnt(state, 1, 60, 45, { id: 424242 });
    h = await startHarness({ state });
    const a = await joinAs(h, { colony: VLC });
    const own = a.data.squad[0];
    // A mark steers only a squad on follow_trail: order it with the mark, so the count is the squad.
    const ordered = await a.agent.call("order", { kind: "follow_trail", mark: { tileX: own.tileX, tileY: own.tileY, words: ["GATHER"] } });
    expect(ordered.isError).toBe(false);
    expect(ordered.data.accepted).toBe(true);
    h.advance(3);
    const r = await a.agent.call("observe", { map: true });
    expect(r.isError).toBe(false);
    const view = r.data.view;
    expect(view.tick).toBe(h.game.match!.state.tick);
    expect(view.squad.length).toBe(6);
    for (const ant of view.squad) expect(ant).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), tileX: expect.any(Number), tileY: expect.any(Number) }));
    expect(typeof view.orderStatus).toBe("string");
    expect(view.secondsLeft).toBe(Math.ceil((TEST_CONFIG.matchTicks - view.tick) / TEST_CONFIG.ticksPerSecond));
    const rows = unpackTerritory(view.territory);
    expect(rows).toHaveLength(h.game.match!.state.config.mapHeight);
    for (const row of rows) expect(row).toMatch(new RegExp(`^[#.]{${h.game.match!.state.config.mapWidth}}$`));
    // territoryTiles counts original-size tile area: one fine tile is 1/physicalTileArea of it.
    expect(view.territoryTiles).toBe((unpackTerritory(view.territory).join("").split("#").length - 1) / physicalTileArea(h.game.match!.state.config));
    expect(typeof view.territorySharePermille).toBe("number");
    expect(view.myMarks).toEqual([{ markId: expect.any(Number), steering: expect.any(Number) }]);
    expect(view.myMarks[0].steering).toBe(view.squad.length);
    expect(view.marks.map((m: { words: string[] }) => m.words)).toEqual([["GATHER"]]);
    // All living colony ants grant sight; never the far enemy.
    const livingColony = h.game.match!.state.ants.filter(ant => ant.colony === view.colony && ant.hp > 0);
    for (const cell of expandCells(view.cells)) {
      expect(livingColony.some(ant => withinTiles(Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), cell.tileX, cell.tileY, h!.game.match!.state.config.sightTiles))).toBe(true);
    }
    expect(r.text).not.toContain("424242");
  });

  it("includes a free colony scout's sight through the real observe tool without exposing far enemy cells", async () => {
    const config = { ...TEST_CONFIG, antSpeedTilesPerSecond: 0 };
    const state = emptyMatch(0, config);
    state.food.fill(0);
    block(state, 0, 10, 10, 12);
    // On the 128x96 board the scout stands farther from the nest than the block, so the squad takes the block.
    const scout = addAnt(state, 0, 80, 30);
    const seen = addAnt(state, 1, 82, 30);
    const hidden = addAnt(state, 1, 120, 90);
    h = await startHarness({ state });
    const a = await joinAs(h, { colony: VLC });
    const r = await a.agent.call("observe");
    expect(r.isError, r.text).toBe(false);
    expect(r.data.view.squad.map((ant: { antId: number }) => ant.antId)).not.toContain(scout.id);
    const ids = expandCells(r.data.view.cells).flatMap(cell => cell.ants.map(ant => ant.antId));
    expect(ids).toContain(seen.id);
    expect(ids).not.toContain(hidden.id);
  });

  it("commands and errors preserve events for observe and token reconnect", async () => {
    h = await startHarness({ state: contested({ ...TEST_CONFIG, combatGraceTicks: 0 }) });
    const a = await joinAs(h, { colony: VLC });
    const id: string = a.data.agentId;
    // Move the squad into the enemy so fights happen in sight.
    expect((await a.agent.call("order", { kind: "attack", tileX: 16, tileY: 11 })).isError).toBe(false);
    const pending = (): VisibleEvent[] => structuredClone(h!.game.match!.state.agents.find((x) => x.id === id)!.pendingEvents);

    h.advance(20);
    const before = pending();
    expect(before.some((e) => e.type === "fight")).toBe(true);
    const error = await a.agent.call("order", { kind: "forage" });
    expect(error.isError).toBe(true);
    // The attack order started the 10 s floor, so the sim answers with its floor error.
    expect(error.data.error.code).toBe("rate_limited");
    expect(error.data).not.toHaveProperty("events");

    h.advance(5);
    const typeErrorBefore = pending();
    const typed = await a.agent.call("order", { kind: 7 });
    expect(typed.data.error.code).toBe("bad_arguments");
    expect(typed.data).not.toHaveProperty("events");

    const observed = await a.agent.call("observe");
    const events: VisibleEvent[] = [...observed.data.view.events];
    let page = observed;
    while (page.data.view.eventsMore) {
      page = await a.agent.call("observe", { since: page.data.view.eventCursor });
      events.push(...page.data.view.events);
    }
    for (const e of [...before, ...typeErrorBefore]) expect(events).toContainEqual(e);

    // The session ends; events keep accruing; a token rejoin delivers them.
    await a.agent.end();
    h.advance(5);
    const rejoinBefore = pending();
    expect(rejoinBefore.length).toBeGreaterThan(0);
    const again = await joinAs(h, { token: a.data.reconnectToken });
    expect(again.data.agentId).toBe(id);
    const rejoinedEvents: VisibleEvent[] = [...again.data.view.events];
    let cursor = again.data.view.eventCursor;
    let more = again.data.view.eventsMore;
    while (more) {
      const page = await again.agent.call("observe", { since: cursor });
      rejoinedEvents.push(...page.data.view.events); cursor = page.data.view.eventCursor; more = page.data.view.eventsMore;
    }
    for (const e of rejoinBefore) expect(rejoinedEvents).toContainEqual(e);
  });

  it("reports the winner after the match ends", async () => {
    h = await startHarness({ simConfig: { ...TEST_CONFIG, matchTicks: 50 } });
    const a = await joinAs(h);
    h.advance(60);
    const r = await a.agent.call("observe");
    expect(r.isError).toBe(false);
    expect(r.data.matchOver).toBe(true);
    expect([...COLONY_NAMES, "draw"]).toContain(r.data.winner);
    expect(r.data.result.reason).toBe("time_up");
  });
});

describe("orders, intent lines and the command floor", () => {
  it("keeps following an order without calls; logs the intent line and never shows it to agents", async () => {
    h = await startHarness();
    const a = await joinAs(h, { colony: VLC });
    const b = await joinAs(h, { colony: LHC });
    const c = await joinAs(h, { colony: VLC });
    // Read where the ants stand now; other joins have ticked the match on.
    const start = (await a.agent.call("observe")).data.view.squad as { x: number; y: number; tileX: number; tileY: number }[];
    const own = start[0]!;
    const intent = "intent-line-9c1e flank north";
    const ordered = await a.agent.call("order", { kind: "go_to", tileX: 20, tileY: 10, mark: { tileX: own.tileX, tileY: own.tileY, words: ["FOOD", "N"] }, intent });
    expect(ordered.isError, ordered.text).toBe(false);
    const dist = (ants: { x: number; y: number }[]): number => ants.reduce((s, p) => s + Math.hypot(p.x - 20_500, p.y - 10_500), 0);
    h.advance(40);
    const later = await a.agent.call("observe");
    expect(dist(later.data.view.squad)).toBeLessThan(dist(start));
    expect(later.data.view.order).toEqual({ kind: "go_to", tileX: 20, tileY: 10 });
    expect(later.data.view.marks.map((m: { words: string[] }) => m.words)).toContainEqual(["FOOD", "N"]);
    expect(h.inputsOf(a.data.agentId).find((i) => i.type === "order")).toEqual(expect.objectContaining({ intent }));
    for (const agent of [a.agent, b.agent, c.agent]) expect((await agent.call("observe")).text).not.toContain("intent-line-9c1e");
  });

  it("rejects an order change or standalone mark within the floor, stating when the next is allowed; an order and its mark are one command", async () => {
    h = await startHarness();
    const a = await joinAs(h, { colony: VLC });
    const own = a.data.squad[0];
    const first = await a.agent.call("order", { kind: "hold", mark: { tileX: own.tileX, tileY: own.tileY, words: ["HOLD"] } });
    expect(first.isError).toBe(false);
    const commandTick = first.data.tick - 1;
    const next = commandTick + TEST_CONFIG.commandFloorTicks;
    expect(first.data.nextCommandTick).toBe(next);
    for (const r of [
      await a.agent.call("order", { kind: "forage" }),
      await a.agent.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD"] }),
    ]) {
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("rate_limited");
      expect(r.data.error.message).toContain(`allowed at tick ${next}`);
      expect(r.data.error.message).toMatch(/in \d+(\.\d)? s/);
      expect(r.data.nextCommandTick).toBe(next);
    }
    h.advance(next - h.game.match!.state.tick);
    const allowed = await a.agent.call("order", { kind: "forage" });
    expect(allowed.isError, allowed.text).toBe(false);
  });
});

describe("marks reach the colony only", () => {
  it("shows a mark, laid alone or on an order, to a same-colony agent in smell range and never to the other colony", async () => {
    h = await startHarness({ state: contested() });
    const a = await joinAs(h, { colony: VLC });
    const enemy = await joinAs(h, { colony: LHC });
    const b = await joinAs(h, { colony: VLC });
    const own = (await a.agent.call("observe")).data.view.squad[0];
    const alone = await a.agent.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["ENEMY", "MANY", "E"] });
    expect(alone.isError, alone.text).toBe(false);
    const seenFirst = (await b.agent.call("observe")).data.view.marks.map((m: { words: string[] }) => m.words);
    expect(seenFirst).toContainEqual(["ENEMY", "MANY", "E"]);
    expect((await enemy.agent.call("observe")).data.view.marks).toEqual([]);
    h.advance(TEST_CONFIG.commandFloorTicks);
    const second = (await a.agent.call("observe")).data.view.squad[1];
    const carried = await a.agent.call("order", { kind: "hold", mark: { tileX: second.tileX, tileY: second.tileY, words: ["HELP"] } });
    expect(carried.isError, carried.text).toBe(false);
    const seenByB = (await b.agent.call("observe")).data.view.marks.map((m: { words: string[] }) => m.words);
    expect(seenByB).toContainEqual(["HELP"]);
    const enemyView = (await enemy.agent.call("observe")).data.view;
    expect(enemyView.squad.length).toBeGreaterThan(0);
    expect(enemyView.marks).toEqual([]);
    expect(JSON.stringify(enemyView)).not.toContain("ENEMY");
  });

  it("rejects a mark with an unknown word or more than three words", async () => {
    h = await startHarness();
    const a = await joinAs(h, { colony: VLC });
    const own = a.data.squad[0];
    for (const words of [["FOOD", "BANANA"], ["FOOD", "N", "MANY", "GO"]]) {
      const r = await a.agent.call("mark", { tileX: own.tileX, tileY: own.tileY, words });
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("bad_mark_words");
      expect(r.data.error.howToFix).toContain("FOOD, ENEMY");
    }
  });
});
