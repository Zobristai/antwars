import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_EVENT_PAGE, MAX_REPLY_BYTES, MAX_TEXT_CHARS, MAX_OBSERVE_TEXT_CHARS, MAX_OBSERVE_REPLY_BYTES, MAX_RULES_REPLY_BYTES, MAX_RULES_TEXT_CHARS } from "../../src/mcp/replies.js";
import { COLONY_NAMES, MAPS, rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig, withGridScale } from "../../src/sim/gridScale.js";
import { expandCells, takeView } from "../../src/sim/view.js";
import { buildGrid } from "../../src/sim/map.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { isPassable } from "../../src/sim/terrain.js";
import type { VisibleEvent } from "../../src/sim/types.js";
import { NEW_MATCH_REPLY_MAP_IDS, matchCounterBound, measureReplies, prepareLargestView, worstMarkObserve, measureEventPage } from "./response-size-fixture.js";
import { startHarness } from "./harness.js";
import { unpackMarks, type MarkTable } from "../../src/mcp/markTable.js";

// Independent pin: production and tests may not silently raise the ceiling.
const EXPECTED_REPLY_CAP_BYTES = 40_960;
const EXPECTED_VIEW_CAP_BYTES = 102_380;
const EXPECTED_VIEW_TEXT_CHARS = 49_000;
// Rules replies share the join/observe budget, with no headroom.
const EXPECTED_RULES_CAP_BYTES = 102_380;
const EXPECTED_RULES_TEXT_CHARS = 49_000;
const EXPECTED_EVENT_PAGE = 20;

/** Claude Code 2.1.258,
 * a house match at main 069957e1b4560233471cfd2b738c0e8dadcd7b7e.
 * Largest inline text 49,952 chars; smallest stubbed text 50,011. The stub counts
 * text content, not both copies. Documented limit 50,000 characters is confirmed.
 * Command replies: <=20,000 text chars leaves >=60% margin; complete JSON (both copies) <=40,960 bytes.
 * Join/observe text (49,000 chars) and rules text (49,000 chars) must stay under the 50,000 inline limit.
 */
const CLAUDE_CODE_INLINE_TEXT_CHARS = 50_000;
describe("every MCP reply stays below the measured Claude Code inline limit", () => {
  it("pins the authorized join/observe ceiling independently of production", () => {
    expect(MAX_REPLY_BYTES).toBe(EXPECTED_REPLY_CAP_BYTES);
    expect(MAX_TEXT_CHARS).toBe(20_000);
    expect(MAX_OBSERVE_REPLY_BYTES).toBe(EXPECTED_VIEW_CAP_BYTES);
    expect(MAX_OBSERVE_TEXT_CHARS).toBe(EXPECTED_VIEW_TEXT_CHARS);
    expect(MAX_OBSERVE_TEXT_CHARS).toBeLessThan(CLAUDE_CODE_INLINE_TEXT_CHARS);
    expect(MAX_RULES_REPLY_BYTES).toBe(EXPECTED_RULES_CAP_BYTES);
    expect(MAX_RULES_TEXT_CHARS).toBe(EXPECTED_RULES_TEXT_CHARS);
    expect(MAX_RULES_TEXT_CHARS).toBeLessThan(CLAUDE_CODE_INLINE_TEXT_CHARS);
    expect(MAX_EVENT_PAGE).toBe(EXPECTED_EVENT_PAGE);
    // Whole-match births, not colonyCap * lifetime: 30 + 1,800 + 7,011.
    expect(matchCounterBound(rulesConfig("redesign"))).toBe(8_841);
  });

  it.each(MAPS.flatMap((map, i) => (["redesign", "v4", "count-marks"] as const).flatMap(rules => [
    { mapId: NEW_MATCH_REPLY_MAP_IDS[i]!, rules, grid: undefined as { width: number; height: number } | undefined, gridName: "shipped" },
    ...(rules === "redesign" ? [{ width: 128, height: 96 }, { width: 256, height: 192 }].map(grid => ({ mapId: map.id, rules, grid, gridName: `${grid.width}×${grid.height}` })) : []),
  ])))("all tools at eight seats, 512 ants per colony, $rules on $mapId ($gridName)", async ({ rules, mapId, grid }) => {
    for (const spread of [false, true]) {
      const result = await measureReplies(rules, spread, mapId, grid);
      if (grid === undefined) {
        expect(result.config).toEqual({ ...newMatchConfig(rulesConfig(rules)), terrain: { ...newMatchConfig(rulesConfig(rules)).terrain!, mapId } });
        expect(result.config).toMatchObject({ gridScale: 2, mapWidth: 128, mapHeight: 96 });
      }
      console.log(`MCP size ${rules} ${mapId} ${spread ? "spread/max-marks/nests" : "dense-front"}: ${JSON.stringify(result.maxima)}`);
      expect(result.samples).toHaveLength(Object.keys(result.maxima).length * 8);
      for (const sample of result.samples) {
        const fullView = sample.tool === "join" || sample.tool === "observe";
        const rules = sample.tool === "rules";
        expect(sample.completeBytes, JSON.stringify(sample)).toBeLessThanOrEqual(fullView ? EXPECTED_VIEW_CAP_BYTES : rules ? EXPECTED_RULES_CAP_BYTES : EXPECTED_REPLY_CAP_BYTES);
        expect(sample.textChars, JSON.stringify(sample)).toBeLessThanOrEqual(fullView ? EXPECTED_VIEW_TEXT_CHARS : rules ? EXPECTED_RULES_TEXT_CHARS : MAX_TEXT_CHARS);
        if (sample.tool === "join" || sample.tool === "observe") {
          // The bound must not be met by silently dropping all queued events.
          expect(sample.eventCount, JSON.stringify(sample)).toBeGreaterThan(0);
          expect(sample.eventCount).toBeLessThanOrEqual(MAX_EVENT_PAGE);
        }
      }
    }
  }, 30_000);

  it.each(MAPS.map(map => ({ mapId: map.id })))("keeps every colony-sight cell within existing caps with 512 late-match scouts on $mapId", async ({ mapId }) => {
    const base = withGridScale(rulesConfig("redesign"));
    const config = { ...base, terrain: { ...base.terrain!, mapId }, antSpeedTilesPerSecond: 0, combatGraceTicks: 1_000_000 };
    const h = await startHarness({ simConfig: config });
    try {
      const callers = [];
      for (let i = 0; i < 8; i++) {
        const agent = await h.connect();
        const joined = await agent.call("join", { colony: COLONY_NAMES[i % 2] });
        expect(joined.isError, joined.text).toBe(false);
        callers.push({ agent, id: joined.data.agentId as string });
      }
      prepareLargestView(h, true);
      const state = h.game.match!.state;
      const tiles: [number, number][] = [];
      for (let y = 0; y < config.mapHeight; y++) for (let x = 0; x < config.mapWidth; x++) {
        if (isPassable(state, x, y)) tiles.push([x, y]);
      }
      for (const colony of [0, 1] as const) {
        const ants = state.ants.filter(ant => ant.colony === colony);
        expect(ants).toHaveLength(512);
        for (const [i, ant] of ants.entries()) {
          const [x, y] = tiles[Math.floor(i * tiles.length / ants.length)]!;
          ant.x = tileCentre(x); ant.y = tileCentre(y);
        }
      }
      const caller = callers[0]!;
      const reply = await caller.agent.client.callTool({ name: "observe", arguments: { map: true } }) as CallToolResult;
      expect(reply.isError).not.toBe(true);
      const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("");
      type CellPage = { view: { cells: Parameters<typeof expandCells>[0]; events: unknown[]; cellsMore: boolean; cellsCursor: string | null; cellsTick: number } };
      const data = reply.structuredContent as CellPage;
      expect(JSON.parse(text)).toEqual(data);
      expect(text.length).toBeLessThanOrEqual(EXPECTED_VIEW_TEXT_CHARS);
      const bytes = Buffer.byteLength(JSON.stringify(reply));
      expect(bytes).toBeLessThanOrEqual(EXPECTED_VIEW_CAP_BYTES);
      const after = structuredClone(h.game.match!.state);
      const raw = takeView(after, buildGrid(after), after.agents.find(agent => agent.id === caller.id)!);
      expect(raw.cells.length).toBeGreaterThan(1500);
      const allCells = expandCells(data.view.cells);
      const firstCells = new Set(allCells.map(cell => `${cell.tileX},${cell.tileY}`));
      for (const cell of raw.cells) if (raw.squad.some(ant => (ant.tileX - cell.tileX) ** 2 + (ant.tileY - cell.tileY) ** 2 <= config.sightTiles ** 2)) {
        expect(firstCells.has(`${cell.tileX},${cell.tileY}`)).toBe(true);
      }
      expect(data.view.events.length).toBeGreaterThan(0);
      expect(data.view.events.length).toBeLessThanOrEqual(EXPECTED_EVENT_PAGE);
      let page = data, pages = 1, maxChars = text.length, maxBytes = bytes;
      while (page.view.cellsMore) {
        expect(pages).toBeLessThan(50);
        const next = await caller.agent.client.callTool({ name: "observe", arguments: { map: true, cellsCursor: page.view.cellsCursor } }) as CallToolResult;
        expect(next.isError).not.toBe(true);
        const nextText = next.content.filter(block => block.type === "text").map(block => block.text).join("");
        const nextBytes = Buffer.byteLength(JSON.stringify(next));
        expect(nextText.length).toBeLessThanOrEqual(EXPECTED_VIEW_TEXT_CHARS);
        expect(nextBytes).toBeLessThanOrEqual(EXPECTED_VIEW_CAP_BYTES);
        page = next.structuredContent as CellPage;
        expect(page.view.cellsTick).toBe(data.view.cellsTick);
        const decoded = expandCells(page.view.cells);
        expect(decoded.length).toBeGreaterThan(0);
        allCells.push(...decoded); pages++;
        maxChars = Math.max(maxChars, nextText.length); maxBytes = Math.max(maxBytes, nextBytes);
      }
      expect(new Set(allCells.map(cell => `${cell.tileX},${cell.tileY}`)).size).toBe(allCells.length);
      expect(allCells.toSorted((a, b) => a.tileY - b.tileY || a.tileX - b.tileX)).toEqual(raw.cells);
      console.log(`colony-sight observe: ${mapId} ${config.mapWidth}x${config.mapHeight}, 512 ants/colony, ${raw.cells.length} cells in ${pages} pages, max ${maxChars} text chars / ${maxBytes} complete bytes`);
    } finally { await h.close(); }
  });

  it("bounds queued, unjoined, malformed, accepted, refused, reconnect and ended results with both copies intact", async () => {
    const config = newMatchConfig(rulesConfig("redesign"));
    const h = await startHarness({ simConfig: config, start: false });
    const a = await h.connect();
    const check = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await a.client.callTool({ name, arguments: args });
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(EXPECTED_REPLY_CAP_BYTES);
      const text = (reply.content as {type: string; text: string}[])[0]!.text;
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      expect(JSON.parse(text)).toEqual(reply.structuredContent);
      expect(reply.structuredContent).toBeDefined();
      return reply.structuredContent as Record<string, any>;
    };
    try {
      for (const name of ["observe", "order", "count_mark", "found_queen"]) await check(name);
      await check("join", { displayName: "x".repeat(33) });
      await check("rules");
      const joined = await check("join");
      await check("join"); await check("observe"); await check("order", { kind: "hold" });
      h.game.startMatch(7);
      const initial = await check("observe");
      expect(expandCells(initial.view.cells).length).toBeGreaterThan(0);
      await check("rules");
      await check("order", { kind: "hold" });
      await check("order", { kind: "forage" });
      await check("order", { kind: 7 });
      await check("observe", { since: -1 });
      await check("observe", { since: Number.MAX_SAFE_INTEGER });
      h.game.match!.state.agents[0]!.lastCommandTick = null;
      await check("count_mark", { verb: "GATHER", count: 1 });
      h.game.match!.state.agents[0]!.lastCommandTick = null;
      await check("count_mark", { verb: "GATHER", count: 2 });
      await check("found_queen", { tileX: -1, tileY: -1 });
      h.clock.now += 1000;
      await check("join", { token: joined.reconnectToken });
      h.game.match!.state.tick = config.matchTicks - 1;
      h.advance(1);
      await check("observe", { map: true });
      for (const name of ["order", "count_mark", "found_queen", "rules"]) await check(name);
      await check("join", { token: joined.reconnectToken });
    } finally { await h.close(); }
  });
});

it("pages every sighted event without loss or consuming it in commands, errors or rules, and replays across reconnects", async () => {
  const h = await startHarness({ simConfig: rulesConfig("redesign") });
  try {
    const a = await h.connect();
    const joined = await a.call("join", { colony: COLONY_NAMES[0] });
    const enemy = await h.connect();
    await enemy.call("join", { colony: COLONY_NAMES[1] });
    const state = h.game.match!.state;
    const own = state.agents.find(agent => agent.id === joined.data.agentId)!;
    const events: VisibleEvent[] = Array.from({length: 173}, (_, i) => ({ type: "hatch", tick: -1000 + i,
      antId: 100000 + i, colony: 0, tileX: 8, tileY: 24, caste: "worker" }));
    own.pendingEvents.push(...events);
    const ordered = await a.call("order", { kind: "hold" });
    expect(ordered.data).not.toHaveProperty("events");
    expect(ordered.data.order).toEqual({kind: "hold"});
    const refused = await a.call("order", { kind: "forage" });
    expect(refused.isError).toBe(true); expect(refused.data).not.toHaveProperty("events");
    const malformed = await a.call("count_mark", { verb: "GATHER", count: "wrong" });
    expect(malformed.isError).toBe(true); expect(malformed.data).not.toHaveProperty("events");
    expect((await a.call("rules")).data.rules).toContain("Worked example");
    const foreign = await enemy.call("observe", { since: 0 });
    expect(JSON.stringify(foreign.data)).not.toContain("100000");

    const first = await a.call("observe", { since: 0 });
    expect(first.data.view.eventsMore).toBe(true);
    expect(first.data.view.events.length).toBeLessThanOrEqual(MAX_EVENT_PAGE);
    const replay = await a.call("observe", { since: 0 });
    expect(replay.data.view.events).toEqual(first.data.view.events);
    expect(replay.data.view.eventCursor).toBe(first.data.view.eventCursor);
    await a.end();
    const again = await h.connect();
    const rejoined = await again.call("join", { token: joined.data.reconnectToken });
    expect(rejoined.data.agentId).toBe(joined.data.agentId);
    // Rejoin is a current sample, not a continuation of chronological replay.
    expect(rejoined.data.view.eventsMode).toBe("current");
    expect(rejoined.data.view.eventCursor).toBe(first.data.view.eventCursor);
    const received = [...first.data.view.events] as VisibleEvent[];
    let cursor = first.data.view.eventCursor;
    for (let i = 0; i < 20 && received.filter(e => e.tick < 0).length < events.length; i++) {
      const page = await again.call("observe", { since: cursor });
      expect(page.data.view.eventCursor).toBeGreaterThan(cursor);
      expect(page.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      received.push(...page.data.view.events); cursor = page.data.view.eventCursor;
    }
    expect(received.filter(e => e.tick < 0)).toEqual(events);
    expect(new Set(received.filter(e => e.tick < 0).map(e => e.type === "hatch" ? e.antId : -1)).size).toBe(events.length);
    const invalid = await again.call("observe", { since: Number.MAX_SAFE_INTEGER });
    expect(invalid.data.error.code).toBe("bad_event_cursor");
    const all = await again.call("observe", { since: 0 });
    expect(all.data.view.events).toEqual(first.data.view.events);
  } finally { await h.close(); }
});

it.each([81, 200000])("names the 80-character intent limit and actual %s-code-point length without bloating logs", async length => {
  const h = await startHarness();
  try {
    const a = await h.connect(); await a.call("join");
    const reply = await a.call("order", {kind: "hold", intent: "😀".repeat(length)});
    expect(reply.isError).toBe(true);
    expect(reply.data.error.code).toBe("intent_too_long");
    expect(reply.data.error.message).toContain(String(length));
    expect(reply.data.error.message).toContain("80-character limit");
  } finally { await h.close(); }
});

type SizeView = {
  marks: { markId: number; words?: string[]; caste?: string; lost?: number; kills?: number }[];
  myMarks: SizeView["marks"];
  events: (VisibleEvent & { detailsSince?: number })[];
  priorityEventsMore?: boolean;
};

function checkSizedView(reply: CallToolResult, sample: Awaited<ReturnType<typeof worstMarkObserve>>, large = true): SizeView {
  const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("");
  expect(text.length).toBeLessThanOrEqual(EXPECTED_VIEW_TEXT_CHARS);
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(EXPECTED_VIEW_CAP_BYTES);
  expect(JSON.parse(text)).toEqual(reply.structuredContent);
  expect(reply.isError).not.toBe(true);
  const wire = (reply.structuredContent as { view: Omit<SizeView, "marks" | "myMarks"> & { marks: SizeView["marks"] | MarkTable; myMarks: SizeView["myMarks"] | MarkTable } }).view;
  const view = { ...wire, marks: unpackMarks(wire.marks), myMarks: unpackMarks(wire.myMarks) } as SizeView;
  expect(view.marks).toHaveLength(large ? 72 : 4);
  expect(view.myMarks).toHaveLength(large ? 18 : 1);
  // A full join briefing can leave no room for even one event. Its queued
  // priorities must still drain on the next observes, proven below.
  if (reply !== sample.reply || sample.tool === "observe") expect(view.events.length).toBeGreaterThan(0);
  expect(view.events.length).toBeLessThanOrEqual(EXPECTED_EVENT_PAGE);
  for (const mark of [...view.marks, ...view.myMarks]) {
    if (sample.kind === "count") {
      const expected = sample.expectedTotals.get(reply)!.get(mark.markId)!;
      expect(mark).toMatchObject({ caste: "soldier", ...expected });
      for (const value of [mark.lost, mark.kills]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(sample.counterBound);
      }
      expect(mark).not.toHaveProperty("antsLost");
      expect(mark).not.toHaveProperty("enemiesKilled");
    } else {
      if (view.marks.includes(mark)) expect(mark.words).toEqual(["GATHER", "ATTACK", "QUEEN"]);
      expect(mark).not.toHaveProperty("lost");
      expect(mark).not.toHaveProperty("kills");
    }
  }
  return view;
}

function fixtureMarkEvents(view: SizeView) {
  return view.events.filter((event): event is Extract<VisibleEvent, { type: "mark_laid" | "count_mark_accepted" }> & { detailsSince?: number } =>
    (event.type === "mark_laid" || event.type === "count_mark_accepted") && event.markId >= 1000 && event.markId < 1032);
}

function checkLosslessPages(sample: Awaited<ReturnType<typeof worstMarkObserve>>, large = true): void {
  const expectedIds = Array.from({ length: 32 }, (_, i) => 1000 + i);
  // Independent traversals: current sampling drains priorities, while explicit
  // history intentionally replays them with complete command detail.
  expect(sample.currentMarkIds).toEqual(expectedIds);
  expect(new Set(sample.currentMarkIds).size).toBe(32);
  expect(sample.replayedMarkIds).toEqual(expectedIds);
  expect(new Set(sample.replayedMarkIds).size).toBe(32);
  expect(sample.currentPages.length).toBeGreaterThan(1);
  const firstCount = fixtureMarkEvents((sample.reply.structuredContent as { view: SizeView }).view).length;
  const next = (sample.currentPages[1]!.structuredContent as { view: SizeView }).view;
  // A shorter live fight/death event may fit after the next mark notice did not.
  // Continuation is about the queued mark identities, not total sample length.
  expect(fixtureMarkEvents(next)[0]).toMatchObject({ markId: 1000 + firstCount });
  expect((sample.currentPages.at(-1)!.structuredContent as { view: SizeView }).view.priorityEventsMore).toBe(false);
  for (const reply of [...sample.currentPages, ...sample.historyReplies]) checkSizedView(reply, sample, large);
  for (let index = 0; index < sample.historyPages.length; index++) {
    const page = sample.historyPages[index]!;
    expect(page.from).toBe(index === 0 ? 0 : sample.historyPages[index - 1]!.cursor);
    expect(page.cursor).toBeGreaterThan(page.from);
    if (index < sample.historyPages.length - 1) expect(page.more).toBe(true);
  }
  if (sample.kind === "count") {
    const initial = checkSizedView(sample.reply, sample, large);
    const totals = [...initial.marks, ...initial.myMarks].flatMap(mark => [mark.lost!, mark.kills!]);
    if (sample.combatTotal === 0) {
      expect(totals).toContain(0); // Zero fields survive, rather than being omitted.
      expect(totals.every(value => value < 10)).toBe(true);
    } else {
      // Every field uses the maximum possible decimal width (four digits).
      expect(totals.every(value => String(value).length === String(sample.counterBound).length)).toBe(true);
    }
    for (const reply of sample.historyReplies) {
      const view = (reply.structuredContent as { view: SizeView }).view;
      for (const event of view.events) if (event.type === "count_mark_accepted" && event.markId >= 1000 && event.markId < 1032) {
        expect(event).toMatchObject({ availability: { claimedAnts: 0, freeAntsNow: 512 }, message: "512 free ants now; this mark recruits as ants hatch or free up" });
      }
    }
  }
}

// The compact-map rows move from the retired 64×48 board to the grid-scale-2 128×96 board;
// every paging, continuation and budget assertion is unchanged.
it.each(["word", "count"] as const)("delivers a budget-fitted current %s page at 4 seats × 18 full marks and 512 ants per colony, map shown", async kind => {
  const sample = await worstMarkObserve("open-field", kind, "observe", { grid: { width: 128, height: 96 } });
  const view = checkSizedView(sample.reply, sample);
  expect(view.events).toHaveLength(EXPECTED_EVENT_PAGE);
  console.log(`Compact-map ${kind} page: ${JSON.stringify({ ...sample.actual, events: view.events.length, maximumActual: sample.maximumActual })}`);
  const markEvents = fixtureMarkEvents(view);
  expect(markEvents.length).toBeGreaterThan(0);
  expect(markEvents.every(e => e.type === (kind === "word" ? "mark_laid" : "count_mark_accepted"))).toBe(true);
  expect(sample.fixture.colonySeats).toBe(4);
  expect(sample.fixture.antsPerColony).toEqual([512, 512]);
  expect(sample.fixture.marksPerSeat).toEqual([18, 18, 18, 18, 18, 18, 18, 18]);
  expect((sample.reply.structuredContent as Record<string, any>).view.territory).toBeDefined();
  const unpaged = (sample.unpagedReply.structuredContent as { view: SizeView }).view;
  expect(markEvents).toEqual(unpaged.events.slice(0, markEvents.length));
  const { events: _sampleEvents, ...sampleFields } = view;
  const { events: _backlogEvents, ...backlogFields } = unpaged;
  expect(sampleFields).toEqual({ ...backlogFields, marks: unpackMarks(backlogFields.marks), myMarks: unpackMarks(backlogFields.myMarks) });
  checkLosslessPages(sample);
});

it.each(NEW_MATCH_REPLY_MAP_IDS.flatMap(mapId => (["join", "reconnect"] as const).flatMap(tool => [
  { mapId, tool, kind: "word" as const, totals: "zero" as const },
  { mapId, tool, kind: "count" as const, totals: "zero" as const },
  { mapId, tool, kind: "count" as const, totals: "maximum" as const },
])))("bounds $tool with $kind marks and $totals totals on $mapId, retaining full marks and both copies", async ({ mapId, tool, kind, totals }) => {
  const sample = await worstMarkObserve(mapId, kind, tool, { totals });
  const data = sample.reply.structuredContent as Record<string, any>;
  const eventFree = measureEventPage(sample.reply, 0);
  console.log(`Join size diagnostic: ${JSON.stringify({ mapId, tool, kind, totals, events: data.view.events.length,
    textChars: sample.actual.textChars, completeBytes: sample.actual.completeBytes,
    eventFreeTextChars: eventFree.textChars, eventFreeCompleteBytes: eventFree.completeBytes,
    maximumActual: sample.maximumActual })}`);
  expect(eventFree.textChars).toBeLessThanOrEqual(EXPECTED_VIEW_TEXT_CHARS);
  expect(eventFree.completeBytes).toBeLessThanOrEqual(EXPECTED_VIEW_CAP_BYTES);
  expect(data.agentId).toBeDefined(); expect(data.reconnectToken).toBeDefined();
  expect(data.briefing).toContain("DEFEND walks to its mark, holds and never chases");
  checkLosslessPages(sample);
}, 30_000);

it.each(["zero", "maximum"] as const)("normal-size count-mark pages still return 20 events with %s totals", async totals => {
  const sample = await worstMarkObserve("open-field", "count", "observe", { totals, layout: "normal" });
  const view = checkSizedView(sample.reply, sample, false);
  expect(view.events).toHaveLength(EXPECTED_EVENT_PAGE);
  checkLosslessPages(sample, false);
});

it("bounds oversized unknown join names, reports omissions/truncations and never joins", async () => {
  const h = await startHarness({ start: false });
  try {
    const a = await h.connect();
    for (const args of [
      { ['"\\\u0000😀'.repeat(4000)]: true },
      Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`unknown-${i}`, null])),
    ]) {
      const reply = await a.client.callTool({ name: "join", arguments: args });
      expect(reply.isError).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(EXPECTED_REPLY_CAP_BYTES);
      const text = (reply.content as { type: string; text: string }[])[0]!.text;
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      expect(JSON.parse(text)).toEqual(reply.structuredContent);
      const data = reply.structuredContent as { error: { code: string; message: string; howToFix: string } };
      expect(data.error.code).toBe("bad_arguments");
      for (const field of [data.error.message, data.error.howToFix]) {
        expect(field).toContain(Object.keys(args).length === 1 ? "0 names omitted; 1 displayed names truncated" : "2992 names omitted; 0 displayed names truncated");
      }
      expect(h.game.queuedAgents).toBe(0);
      expect((await a.call("observe")).data.error.code).toBe("not_joined");
    }
  } finally { await h.close(); }
});

it.each(NEW_MATCH_REPLY_MAP_IDS.flatMap(mapId => (["zero", "maximum"] as const).map(totals => ({ mapId, totals }))))("fits and losslessly pages every all-soldier layout on $mapId with $totals totals", async ({ mapId, totals }) => {
  const sample = await worstMarkObserve(mapId, "count", "observe", { totals });
  const view = checkSizedView(sample.reply, sample);
  expect([...view.marks, ...view.myMarks, ...fixtureMarkEvents(view)].every(entry => "caste" in entry && entry.caste === "soldier")).toBe(true);
  expect(view.events.length).toBeLessThanOrEqual(EXPECTED_EVENT_PAGE);
  // Compaction may make all twenty events fit; only a budget-limited page must
  // prove that the next queued notice exceeds one of the unchanged ceilings.
  if (view.events.length < EXPECTED_EVENT_PAGE) {
    const tooMany = measureEventPage(sample.unpagedReply, fixtureMarkEvents(view).length + 1);
    expect(tooMany.textChars > EXPECTED_VIEW_TEXT_CHARS || tooMany.completeBytes > EXPECTED_VIEW_CAP_BYTES).toBe(true);
  }
  checkLosslessPages(sample);
}, 30_000);

// Isolate wire-size dependence on either candidate grid, before physical-rule
// selection. Non-map candidate fields stay unchanged deliberately; the
// no-override matrix above uses landed newMatchConfig, including physical scaling.
it.each(MAPS.flatMap(map => [
  { mapId: map.id, width: 128, height: 96 },
  { mapId: map.id, width: 256, height: 192 },
]))("bounds candidate-grid territory with full marks and lossless history on $mapId at $width×$height", async ({ mapId, width, height }) => {
  const sample = await worstMarkObserve(mapId, "count", "observe", { grid: { width, height } });
  console.log(`Candidate territory: ${JSON.stringify({ mapId, width, height, maximumActual: sample.maximumActual })}`);
  checkLosslessPages(sample);
});

// Before the draw, a rotation whose maps all differ states every cap and length; with the longest
// values the formats accept on all seven maps, a queued eight-seat lobby's join and rules replies still fit.
it("fits pre-draw join and rules replies when every rotation map has its own longest ant cap and match length", async () => {
  const base = newMatchConfig(rulesConfig("redesign"));
  const maps = base.terrain!.maps.map((map, i) => ({ ...map, colonyCap: Number.MAX_SAFE_INTEGER - i, matchTicks: 9_999_997 - i }));
  const config = { ...base, terrain: { ...base.terrain!, maps } };
  expect(maps).toHaveLength(7);
  const seats = Array.from({ length: 8 }, (_, i) => ({ identityId: `undrawn-${i}`, displayName: `${i}${"名".repeat(31)}`, colony: (i % 2) as 0 | 1 }));
  const h = await startHarness({ start: false, simConfig: config, slot: {
    identityOf: async key => seats.find(s => s.identityId === key)?.identityId,
    locate: async () => undefined,
  } });
  try {
    h.game.seatLobby("undrawn-lobby", seats, "4v4");
    for (const seat of seats) {
      const agent = await h.connect();
      for (const [tool, args] of [["join", { key: seat.identityId }], ["rules", {}]] as const) {
        const result = await agent.client.callTool({ name: tool, arguments: args }) as CallToolResult;
        const text = (result.content as { text: string }[])[0]!.text;
        expect(result.isError, text).not.toBe(true);
        const data = result.structuredContent as { briefing?: string; rules?: string };
        expect(tool === "join" ? data.briefing : data.rules).toContain(`Ant cap ${maps.map(map => map.colonyCap).join(" or ")}/colony, set by the seed's map.`);
        const size = { tool, textChars: text.length, completeBytes: Buffer.byteLength(JSON.stringify(result)) };
        expect(size.textChars, JSON.stringify(size)).toBeLessThanOrEqual(tool === "rules" ? MAX_RULES_TEXT_CHARS : 20_000);
        expect(size.completeBytes, JSON.stringify(size)).toBeLessThanOrEqual(tool === "rules" ? MAX_RULES_REPLY_BYTES : 40_960);
      }
    }
  } finally { await h.close(); }
}, 60_000);
