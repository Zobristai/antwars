import { afterEach, describe, expect, it } from "vitest";
import { briefing, joinBriefing, SEAT_NOTICE_BRIEF, SEAT_NOTICE_TEXT } from "../../src/mcp/briefing.js";
import type { ObserveEvent, SeatNotice } from "../../src/mcp/game.js";
import { MAX_EVENT_PAGE, MAX_REPLY_BYTES, MAX_TEXT_CHARS } from "../../src/mcp/replies.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { startHarness, type CallResult, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

const config = { ...rulesConfig("redesign"), terrain: undefined, foodLayout: undefined,
  antSpeedTilesPerSecond: 0, commandFloorTicks: 1, commandIdleTicks: 100_000,
  hatchIntervalTicks: 100_000, earlyWin: undefined };
let h: Harness;
afterEach(async () => { await h?.close(); });

const isNotice = (event: ObserveEvent): event is SeatNotice => event.type === "squad_replaced";
const notices = (id: string): SeatNotice[] => h.game.eventHistory(id).filter(isNotice);

async function seat(colony = 0): Promise<{ client: TestAgent; id: string; token: string }> {
  const client = await h.connect();
  const joined = await client.call("join", { colony: COLONY_NAMES[colony] });
  expect(joined.isError, joined.text).toBe(false);
  return { client, id: joined.data.agentId as string, token: joined.data.reconnectToken as string };
}

async function start(simConfig = config): Promise<void> {
  const state = emptyMatch(0, simConfig);
  for (const colony of [0, 1] as const) {
    state.colonies[colony].foodStore = 0;
    for (let i = 0; i < 48; i++) addAnt(state, colony, colony ? 54 : 8, 24);
  }
  h = await startHarness({ simConfig, state });
}

function wipe(id: string, keepFree = true): void {
  const state = h.game.match!.state;
  const agent = state.agents.find(agent => agent.id === id)!;
  state.ants = state.ants.filter(ant => ant.squad !== id && (keepFree || ant.colony !== agent.colony || ant.squad !== null));
  agent.squad = [];
}

function refill(colony = 0): void {
  for (let i = 0; i < 12; i++) addAnt(h.game.match!.state, colony as 0 | 1, colony ? 54 : 8, 24);
}

function bounded(reply: CallResult): void {
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: reply.text }], structuredContent: reply.data })))
    .toBeLessThanOrEqual(MAX_REPLY_BYTES);
  expect(reply.data.view.events.length).toBeLessThanOrEqual(MAX_EVENT_PAGE);
}

async function hold(client: TestAgent): Promise<void> {
  const reply = await client.call("order", { kind: "hold" });
  expect(reply.isError, reply.text).toBe(false);
}

describe("seat-private squad replacement transitions", () => {
  it("does not announce initial assignment, unchanged squads or partial replacements", async () => {
    await start();
    const { client, id } = await seat();
    const first = await client.call("observe");
    expect(first.data.view.squad.length).toBeGreaterThan(1);
    expect(notices(id)).toEqual([]);
    await client.call("observe");
    expect(notices(id)).toEqual([]);
    const state = h.game.match!.state;
    const own = state.agents.find(agent => agent.id === id)!;
    const removed = own.squad[0]!;
    state.ants = state.ants.filter(ant => ant.id !== removed);
    own.squad = own.squad.filter(ant => ant !== removed);
    const partial = await client.call("observe");
    expect(partial.data.view.squad.some((ant: { antId: number }) => ant.antId === first.data.view.squad[1].antId)).toBe(true);
    expect(notices(id)).toEqual([]);
  });

  it.each([false, true])("announces a wipe and refill only to its seat (empty intervening view: %s)", async empty => {
    await start();
    const own = await seat();
    const teammate = await seat();
    const enemy = await seat(1);
    await own.client.call("observe");
    wipe(own.id, !empty);
    if (empty) {
      expect((await own.client.call("observe")).data.view.squad).toEqual([]);
      expect(notices(own.id)).toEqual([]);
      refill();
    }
    const reply = await own.client.call("observe");
    bounded(reply);
    expect(reply.data.view.squad.length).toBeGreaterThan(0);
    const event = { type: "squad_replaced", tick: reply.data.view.tick, agentId: own.id, colony: 0 };
    expect(reply.data.view.events).toContainEqual(event);
    expect(notices(own.id)).toEqual([event]);
    await own.client.call("observe");
    expect(notices(own.id)).toEqual([event]);
    for (const other of [teammate, enemy]) {
      const history = await other.client.call("observe", { since: 0 });
      expect(history.data.view.events).not.toContainEqual(event);
      expect(notices(other.id)).toEqual([]);
    }
  });

  it("announces replacement after a combat wipe even though the dead squad saw no death events", async () => {
    await start();
    const { client, id } = await seat();
    const state = h.game.match!.state;
    state.tick = config.combatGraceTicks;
    const squad = state.ants.filter(ant => ant.squad === id);
    for (const [i, ant] of squad.entries()) {
      const tileX = 22 + i * 3; // Isolate targets: combat picks the lowest-HP adjacent enemy.
      ant.x = tileX * 1000 + 500; ant.y = 24_500; ant.hp = 1;
      addAnt(state, 1, tileX, 24);
    }
    const dead = await client.call("observe");
    expect(dead.data.view.squad).toEqual([]);
    expect(dead.data.view.events.filter((event: { type: string }) => event.type === "death")).toEqual([]);
    const replaced = await client.call("observe");
    expect(replaced.data.view.squad.length).toBeGreaterThan(0);
    expect(notices(id)).toEqual([{ type: "squad_replaced", tick: replaced.data.view.tick, agentId: id, colony: 0 }]);
  });
});


it("keeps the priority through a full page, age, explicit history, reconnect and match end", async () => {
  await start();
  const own = await seat();
  const agent = h.game.match!.state.agents.find(agent => agent.id === own.id)!;
  agent.pendingEvents = Array.from({ length: MAX_EVENT_PAGE }, (_, i) => ({ type: "queen_founded" as const,
    tick: -100 + i, colony: 0, queenId: 10000 + i, tileX: 8, tileY: 24 }));
  wipe(own.id);
  await hold(own.client); // Collect the notice behind a whole page of older priorities.
  const expected = [...notices(own.id)];
  expect(expected.map(event => event.type)).toEqual(["squad_replaced"]);
  const history = await own.client.call("observe", { since: 0 });
  bounded(history);
  expect(history.data.view.eventsMore).toBe(true);
  const first = await own.client.call("observe");
  bounded(first);
  expect(first.data.view.events).toHaveLength(MAX_EVENT_PAGE);
  expect(first.data.view.priorityEventsMore).toBe(true);
  const cursor = first.data.view.eventCursor;
  h.advance(config.commandFloorTicks + 2);
  await own.client.end();
  const reconnected = await h.connect();
  const joined = await reconnected.call("join", { reconnectToken: own.token });
  bounded(joined);
  expect(joined.data.view.eventCursor).toBe(cursor);
  expect(joined.data.view.events).toEqual(expected);
  expect(notices(own.id)).toEqual(expected);
  h.game.tick(true);
  const finalHash = stateHash(h.game.match!.state);
  const all: ObserveEvent[] = [];
  let since = 0;
  for (let page = 0; page < 10; page++) {
    const reply = await reconnected.call("observe", { since });
    bounded(reply);
    expect(reply.data.matchOver).toBe(true);
    all.push(...reply.data.view.events);
    if (!reply.data.view.eventsMore) break;
    expect(reply.data.view.eventCursor).toBeGreaterThan(since);
    since = reply.data.view.eventCursor;
  }
  expect(all).toEqual(h.game.eventHistory(own.id));
  expect(all.filter(isNotice)).toEqual(expected);
  expect(stateHash(h.game.match!.state)).toBe(finalHash);
});

it("documents the event meaning in current rules, join briefing and the real observe description only", async () => {
  const current = playable(rulesConfig("redesign"));
  h = await startHarness({ simConfig: current });
  const client = await h.connect();
  const joined = await client.call("join");
  const tool = (await client.client.listTools()).tools.find(tool => tool.name === "observe")!;
  for (const text of [briefing(current), tool.description]) {
    expect(text).toContain(SEAT_NOTICE_TEXT);
    expect(text).toContain("initial assignment and partial changes do not count");
    expect(text).not.toContain("brood_vote_lost");
  }
  for (const text of [joinBriefing(current), joined.data.briefing]) expect(text).toContain(SEAT_NOTICE_BRIEF);
});

it("keeps adapter notices out of the log", async () => {
  h = await startHarness({ simConfig: { ...config, matchTicks: 80 } });
  const own = await seat();
  await own.client.call("observe");
  wipe(own.id);
  await own.client.call("observe");
  expect(notices(own.id).some(event => event.type === "squad_replaced")).toBe(true);
  h.advance(80);
  await own.client.call("observe", { since: 0 });
  const truth = h.game.match!.state;
  expect(truth.result).not.toBeNull();
  expect(h.log.join("\n")).not.toMatch(/squad_replaced/);
});
