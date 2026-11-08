import { expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import type { ObserveEvent } from "../../src/mcp/game.js";
import { MAX_EVENT_PAGE, MAX_OBSERVE_REPLY_BYTES as MAX_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS as MAX_TEXT_CHARS, payload } from "../../src/mcp/replies.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import type { VisibleEvent } from "../../src/sim/types.js";
import { prepareLargestView } from "./response-size-fixture.js";
import { startHarness, type CallResult, type Harness, type TestAgent } from "./harness.js";

function bounded(reply: CallResult): number {
  expect(reply.isError, reply.text).toBe(false);
  expect(JSON.parse(reply.text)).toEqual(reply.data);
  expect(reply.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  // Assert complete SDK-result bytes at call sites too (this helper checks both copies).
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: reply.text }], structuredContent: reply.data })))
    .toBeLessThanOrEqual(MAX_REPLY_BYTES);
  expect(reply.data.view.events.length).toBeLessThanOrEqual(MAX_EVENT_PAGE);
  return Buffer.byteLength(JSON.stringify(payload(reply.data)));
}

async function eightSeats(h: Harness): Promise<{ agent: TestAgent; id: string; token: string }[]> {
  const seats = [];
  for (let i = 0; i < 8; i++) {
    const agent = await h.connect();
    const joined = await agent.call("join", { colony: COLONY_NAMES[i % 2] });
    expect(joined.isError).toBe(false);
    seats.push({ agent, id: joined.data.agentId as string, token: joined.data.reconnectToken as string });
  }
  return seats;
}

function fight(tick: number, id: number): VisibleEvent {
  return { type: "fight", tick, antId: id, targetId: id + 1, colony: 0, tileX: 8, tileY: 24 };
}

function expectedNotice(event: VisibleEvent, history: readonly ObserveEvent[]) {
  if (event.type !== "count_mark_accepted") return event;
  const { message: _message, availability: _availability, ...notice } = event;
  const detailsSince = history.findIndex(candidate => candidate.type === "count_mark_accepted"
    && candidate.markId === event.markId && candidate.agentId === event.agentId && candidate.tick === event.tick);
  expect(detailsSince).toBeGreaterThanOrEqual(0);
  return { ...notice, detailsSince };
}

function priorities(id: string, tick: number, base: number): VisibleEvent[] {
  return [
    { type: "queen_founded", tick, colony: 0, queenId: base, tileX: 8, tileY: 24 },
    { type: "queen_lost", tick, colony: 0, queenId: base, tileX: 8, tileY: 24 },
    { type: "mark_laid", tick, colony: 0, agentId: id, markId: base, tileX: 8, tileY: 24, words: ["HELP"] },
    { type: "count_mark_accepted", tick, colony: 0, agentId: id, markId: base, tileX: 8, tileY: 24, verb: "GATHER", count: 20,
      availability: { claimedAnts: 400, freeAntsNow: 0 }, message: "0 free ants now; this mark recruits as ants hatch or free up" },
  ];
}

it("keeps default events within one 10 s cycle at 128 sighted fights/seat/cycle (12.8/s), with the unchanged 2 calls/s limit", async () => {
  const h = await startHarness({ simConfig: rulesConfig("redesign"), mcpConfig: DEFAULT_MCP_CONFIG });
  try {
    const seats = await eightSeats(h);
    prepareLargestView(h, true);
    for (const seat of h.game.match!.state.agents) seat.pendingEvents = seat.pendingEvents.filter(event => event.type === "hatch");
    // Script already fog-filtered fight traffic at the adapter boundary. The
    // largest fixture keeps 512 ants/colony and all eight seats; no LLM joins.
    const cycleTicks = h.game.match!.state.config.commandFloorTicks;
    let maxLag = 0;
    let maxReplyBytes = 0;
    let maxPriorityOnlyBytes = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      h.clock.now += 10_000;
      h.game.match!.state.tick += cycleTicks;
      for (const [seat, { agent, id }] of seats.entries()) {
        const state = h.game.match!.state;
        const own = state.agents.find(a => a.id === id)!;
        const critical = cycle % 2 === 0 ? priorities(id, state.tick, 100000 + cycle * 8 + seat)
          .map(event => ({ ...event, colony: own.colony } as VisibleEvent)) : [];
        const flood = Array.from({ length: 128 }, (_, i) => fight(state.tick - cycleTicks + 1 + Math.floor(i * cycleTicks / 128), 200000 + i));
        own.pendingEvents.push(...flood.slice(0, 64), ...critical, ...flood.slice(64));
        const archiveCursor = h.game.eventCursor(id);
        const reply = await agent.call("observe", { map: true });
        maxReplyBytes = Math.max(maxReplyBytes, bounded(reply));
        const view = reply.data.view;
        // Longer legend is present: this regression must not silently
        // pass against the old 285-character legend that left more event bytes.
        expect(view.cells.encoding).toContain("queenColony=colony0/1 (own=view.colony), not queenId");
        expect(view.eventsMode).toBe("current");
        expect(view.eventsMore).toBe(true);
        expect(view.eventCursor).toBe(archiveCursor);
        expect(view.priorityEventsMore).toBe(false);
        for (const event of critical) {
          expect(view.events).toContainEqual(expectedNotice(event, h.game.eventHistory(id)));
          // Projection never mutates the retained original, including details.
          expect(h.game.eventHistory(id)).toContainEqual(event);
        }
        if (critical.length) maxPriorityOnlyBytes = Math.max(maxPriorityOnlyBytes,
          Buffer.byteLength(JSON.stringify(payload({ ...reply.data, view: { ...view, events: critical.map(event => expectedNotice(event, h.game.eventHistory(id))) } }))));
        // Some largest views fit only the four priorities. Alternate priority
        // bursts with ordinary flood cycles to measure both within the byte cap.
        expect(view.events.length).toBeGreaterThanOrEqual(Math.max(1, critical.length));
        expect(h.game.eventHistory(id).filter(event => event.type === "fight" && event.antId >= 200000).length)
          .toBeGreaterThanOrEqual(128 * (cycle + 1));
        for (const event of view.events as VisibleEvent[]) {
          const lag = view.tick - event.tick;
          expect(lag).toBeGreaterThanOrEqual(0);
          expect(lag).toBeLessThanOrEqual(cycleTicks);
          maxLag = Math.max(maxLag, lag);
        }
      }
    }
    console.log(`observe freshness: 128 scripted fight events/seat/10 s (12.8/s), one observe/10 s at 2 calls/s; maximum observed lag ${maxLag} ticks (${maxLag / 10} s), 8 seats, 512 ants/colony; max complete reply ${maxReplyBytes} bytes (${MAX_REPLY_BYTES - maxReplyBytes} headroom), four-priority-only ${maxPriorityOnlyBytes} bytes (${MAX_REPLY_BYTES - maxPriorityOnlyBytes} headroom)`);
  } finally { await h.close(); }
}, 30_000);

it.each(["v4", "count-marks", "redesign"] as const)("retains >one page of priorities through history reads and reconnects within largest %s reply caps", async rules => {
  const h = await startHarness({ simConfig: rulesConfig(rules) });
  try {
    const seats = await eightSeats(h);
    prepareLargestView(h, true);
    const { agent, id, token } = seats[0]!;
    const own = h.game.match!.state.agents.find(a => a.id === id)!;
    const burst = Array.from({ length: 24 }, (_, i) => priorities(id, -2000 + i, 900000 + i))
      .flat().filter(event => rules !== "v4" || event.type !== "count_mark_accepted");
    // Set aside the fixture priorities so this burst has an exact expected order.
    own.pendingEvents = [
      ...Array.from({ length: 80 }, (_, i) => fight(-5000 + i, 700000 + i)), ...burst,
      ...Array.from({ length: 80 }, (_, i) => fight(-4000 + i, 800000 + i)),
    ];
    await agent.call("rules"); // Collect history, but consume no current priority.
    const historyPage = await agent.call("observe", { since: 0, map: true });
    bounded(historyPage);
    const historyCursor = historyPage.data.view.eventCursor;
    const seen: VisibleEvent[] = [];
    let current = await agent.call("observe", { map: true });
    bounded(current);
    expect(current.data.view.priorityEventsMore).toBe(true);
    expect(current.data.view.eventCursor).toBe(historyCursor);
    seen.push(...current.data.view.events.filter((event: VisibleEvent) => event.tick < 0));
    await agent.end();
    const reconnected = await h.connect();
    current = await reconnected.call("join", { token });
    bounded(current);
    expect(current.data.agentId).toBe(id);
    seen.push(...current.data.view.events.filter((event: VisibleEvent) => event.tick < 0));
    for (let i = 0; i < 20 && current.data.view.priorityEventsMore; i++) {
      current = await reconnected.call("observe", { map: true });
      bounded(current);
      expect(current.data.view.eventCursor).toBe(historyCursor);
      seen.push(...current.data.view.events.filter((event: VisibleEvent) => event.tick < 0));
    }
    expect(current.data.view.priorityEventsMore).toBe(false);
    expect(seen).toEqual(burst.map(event => expectedNotice(event, h.game.eventHistory(id))));
    // Another seat must never receive our private count-mark acceptance history.
    const foreign = await seats[1]!.agent.call("observe", { since: 0 });
    expect(foreign.text).not.toContain("900000");
    // End scripted time to freeze the archive before exhaustive replay.
    h.game.match!.state.tick = h.game.match!.state.config.matchTicks - 1;
    h.advance(1);
    const all: VisibleEvent[] = [];
    let cursor = 0;
    for (let i = 0; i < 200; i++) {
      const page = await reconnected.call("observe", { since: cursor, map: true });
      bounded(page);
      expect(page.data.view.eventsMode).toBe("history");
      all.push(...page.data.view.events);
      if (!page.data.view.eventsMore) break;
      expect(page.data.view.eventCursor).toBeGreaterThan(cursor);
      cursor = page.data.view.eventCursor;
    }
    expect(all).toEqual(h.game.eventHistory(id));
    expect(all.filter(event => event.tick < 0)).toEqual([
      ...Array.from({ length: 80 }, (_, i) => fight(-5000 + i, 700000 + i)), ...burst,
      ...Array.from({ length: 80 }, (_, i) => fight(-4000 + i, 800000 + i)),
    ]);
  } finally { await h.close(); }
}, 30_000);

it("detailsSince retrieves the complete count-mark event without making current notices advance history", async () => {
  const h = await startHarness({ simConfig: rulesConfig("redesign") });
  try {
    const client = await h.connect();
    const joined = await client.call("join", { colony: COLONY_NAMES[0] });
    const id = joined.data.agentId as string;
    const state = h.game.match!.state;
    const event = priorities(id, state.tick, 123456).find(event => event.type === "count_mark_accepted")!;
    state.agents.find(agent => agent.id === id)!.pendingEvents.push(event);
    const cursor = h.game.eventCursor(id);
    const current = await client.call("observe");
    bounded(current);
    const notice = current.data.view.events.find((item: { type: string }) => item.type === "count_mark_accepted");
    expect(notice).toEqual(expectedNotice(event, h.game.eventHistory(id)));
    expect(notice).not.toHaveProperty("message");
    expect(notice).not.toHaveProperty("availability");
    expect(current.data.view.eventCursor).toBe(cursor);
    const full = await client.call("observe", { since: notice.detailsSince });
    bounded(full);
    expect(full.data.view.eventsMode).toBe("history");
    expect(full.data.view.events[0]).toEqual(event);
    expect(full.data.view.events[0]).toHaveProperty("message");
    expect(full.data.view.events[0]).toHaveProperty("availability");
    expect(full.data.view.events[0]).not.toHaveProperty("detailsSince");
  } finally { await h.close(); }
});
