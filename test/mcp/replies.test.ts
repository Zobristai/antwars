import { TERRITORY_TEXT, unpackTerritory } from "../../src/mcp/territory.js";
import { MARK_TABLE_TEXT } from "../../src/mcp/markTable.js";
import { COMPACT_VIEW_TEXT } from "../../src/mcp/briefing.js";
import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES } from "../../src/sim/config.js";
import { observeWaitMs } from "../../src/mcp/tools.js";
import { TEST_CONFIG, startHarness, type CallResult, type Harness, type TestAgent } from "./harness.js";
import { physicalTileArea } from "../../src/sim/gridScale.js";

/** Short order and mark replies, the territory map on request, observe may wait. */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const [VLC] = COLONY_NAMES;

async function joinAs(harness: Harness, args: Record<string, unknown> = {}): Promise<{ agent: TestAgent; data: any }> {
  const agent = await harness.connect();
  const r = await agent.call("join", args);
  expect(r.isError, r.text).toBe(false);
  return { agent, data: r.data };
}

/** Every tool result's text copy is one JSON document. */
function textData(r: CallResult): unknown {
  return JSON.parse(r.text);
}

/** A short command reply in both copies: no view, and the four fields it names. */
function expectShortReply(r: CallResult): void {
  expect(textData(r)).toEqual(r.data);
  expect(r.data).not.toHaveProperty("view");
  for (const field of ["squad", "cells", "territory", "marks"]) expect(r.text).not.toContain(`"${field}"`);
  expect(r.data).toHaveProperty("tick");
  expect(r.data).toHaveProperty("nextCommandTick");
  expect(r.data).not.toHaveProperty("events");
}

describe("order and mark reply without the view", () => {
  it("an accepted order or mark replies with the tick, accepted, nextCommandTick and events only", async () => {
    h = await startHarness();
    const a = await joinAs(h, { colony: VLC });
    const own = a.data.squad[0];
    const ordered = await a.agent.call("order", { kind: "hold" });
    expect(ordered.isError, ordered.text).toBe(false);
    expectShortReply(ordered);
    expect(Object.keys(ordered.data).sort()).toEqual(["accepted", "nextCommandTick", "order", "tick"]);
    expect(ordered.data.accepted).toBe(true);
    expect(ordered.data.tick).toBe(h.game.match!.state.tick);
    expect(ordered.data.nextCommandTick).toBe(ordered.data.tick - 1 + TEST_CONFIG.commandFloorTicks);

    h.advance(TEST_CONFIG.commandFloorTicks);
    const marked = await a.agent.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD"] });
    expect(marked.isError, marked.text).toBe(false);
    expectShortReply(marked);
    expect(marked.data.accepted).toBe(true);
    // The events since the agent's last call: its own mark, laid in sight.
    expect(marked.data.mark).toMatchObject({ words: ["FOOD"], tileX: own.tileX, tileY: own.tileY });
    expect((await a.agent.call("observe")).data.view.events).toContainEqual(expect.objectContaining({ type: "mark_laid", words: ["FOOD"] }));
  });

  it("a refused order or mark, from the sim or the adapter, carries the fix as today plus nextCommandTick and no view", async () => {
    h = await startHarness();
    const a = await joinAs(h, { colony: VLC });
    const own = a.data.squad[0];
    const first = await a.agent.call("order", { kind: "hold" });
    const next = first.data.nextCommandTick;
    const refusals = [
      await a.agent.call("order", { kind: "forage" }),
      await a.agent.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD"] }),
      await a.agent.call("order", { kind: "go_to" }),
      await a.agent.call("mark", { tileX: own.tileX, words: ["FOOD"] }),
    ];
    expect(refusals.map((r) => r.data.error.code)).toEqual(["rate_limited", "rate_limited", "bad_arguments", "bad_arguments"]);
    for (const r of refusals) {
      expect(r.isError).toBe(true);
      expectShortReply(r);
      expect(r.data.error.howToFix).toMatch(/\S/);
      expect(JSON.parse(r.text)).toEqual(r.data);
      expect(r.data.nextCommandTick).toBe(next);
    }

    const stranger = await h.connect();
    const notJoined = await stranger.call("order", { kind: "hold" });
    expect(notJoined.data.error.code).toBe("not_joined");
    expect(notJoined.data.nextCommandTick).toBeNull();
  });
});

describe("observe sends the territory map only on request", () => {
  it("leaves out territory by default and keeps the counts; map: true returns the map as today", async () => {
    h = await startHarness();
    const a = await joinAs(h, { colony: VLC });
    for (const args of [{}, { map: false }]) {
      const r = await a.agent.call("observe", args);
      expect(r.isError, r.text).toBe(false);
      expect(textData(r)).toEqual(r.data);
      expect(r.data.view).not.toHaveProperty("territory");
      expect(r.text).not.toContain('"territory":');
      expect(r.data.view).not.toHaveProperty("territoryRows");
      expect(r.data.view.territoryTiles).toEqual(expect.any(Number));
      expect(r.data.view.territorySharePermille).toEqual(expect.any(Number));
      expect(r.data.view.nextCommandTick).toEqual(expect.any(Number));
    }
    const mapped = await a.agent.call("observe", { map: true });
    expect(textData(mapped)).toEqual(mapped.data);
    const rows = unpackTerritory(mapped.data.view.territory);
    expect(rows).toHaveLength(h.game.match!.state.config.mapHeight);
    for (const row of rows) expect(row).toMatch(new RegExp(`^[#.]{${h.game.match!.state.config.mapWidth}}$`));
    // territoryTiles counts original-size tile area: one fine tile is 1/physicalTileArea of it.
    expect(mapped.data.view.territoryTiles).toBe((rows.join("").split("#").length - 1) / physicalTileArea(h.game.match!.state.config));
  });

  it("join returns a compact full view without the optional territory map", async () => {
    h = await startHarness();
    const { data } = await joinAs(h);
    expect(data.view).not.toHaveProperty("territory");
    expect(data.view.cells.encoding).toContain("base36");
  });

  it("refuses wrong-typed observe arguments with the usual fix-it error", async () => {
    h = await startHarness();
    const a = await joinAs(h);
    const r = await a.agent.call("observe", { map: "yes", waitSeconds: "soon" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("bad_arguments");
    expect(r.data.error.message).toContain("map must be a boolean");
    expect(r.data.error.message).toContain("waitSeconds must be a number");
  });
});

describe("observe may wait up to 10 s", () => {
  it("holds the reply for waitSeconds, then returns the view as it stands at that moment", async () => {
    h = await startHarness();
    const a = await joinAs(h);
    const before = h.game.match!.state.tick;
    const started = Date.now();
    const pending = a.agent.call("observe", { waitSeconds: 0.4 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The match moves on during the hold; the reply shows where it stands after.
    h.advance(7);
    const r = await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.view.tick).toBeGreaterThanOrEqual(before + 7);
    expect(r.data.view).not.toHaveProperty("territory");
  });

  it("clamps the hold to 0..10 s and holds nothing without the argument", () => {
    expect(observeWaitMs(undefined)).toBe(0);
    expect(observeWaitMs(0)).toBe(0);
    expect(observeWaitMs(-3)).toBe(0);
    expect(observeWaitMs(Number.NaN)).toBe(0);
    expect(observeWaitMs(0.25)).toBe(250);
    expect(observeWaitMs(4)).toBe(4000);
    expect(observeWaitMs(10)).toBe(10_000);
    expect(observeWaitMs(60)).toBe(10_000);
  });
});

describe("the join briefing tells agents how to play economically", () => {
  it("states the command floor, observe's wait, the map on request, the short replies and keeping notes", async () => {
    h = await startHarness();
    const joined = await joinAs(h);
    const text: string = joined.data.briefing;
    expect(text).toContain("One command per 10 s");
    // A grid-scale-2 match carries the current (version 17) compact join briefing, which words these rules this way.
    expect(text).toContain("observe waitSeconds (max 10): wait, then get the current view.");
    expect(text).toContain(TERRITORY_TEXT);
    expect(text).toContain(MARK_TABLE_TEXT);
    expect(text).toContain("Commands: outcome, nextCommandTick, changes only.");
    expect(text).toContain("Keep a few lines of notes");
    const rules = (await joined.agent.call("rules")).data.rules as string;
    const observe = (await joined.agent.client.listTools()).tools.find(tool => tool.name === "observe")!;
    // The version-17 rules reply points to observe for the same decoding.
    expect(rules).toContain(COMPACT_VIEW_TEXT.replace("Decode via observe tool.", "See observe."));
    expect(observe.description).toContain(TERRITORY_TEXT);
    expect(observe.description).toContain(MARK_TABLE_TEXT);
    // The version-17 compact join briefing states the event contract in its short form; the rules
    // reply and the observe description keep every full-form phrase below.
    for (const phrase of ["priorityEventsMore", "Sampling keeps eventCursor", "since:0 then since:view.eventCursor while eventsMore",
      "may repeat samples", "since:notice.detailsSince: full count-mark details"]) expect(text).toContain(phrase);
    for (const copy of [text, rules, observe.description!]) {
      expect(copy).toContain("base64-bitset-lsb0");
      expect(copy).toContain("columnar-v1");
      expect(copy).not.toContain("territoryRows");
    }
    for (const copy of [rules, observe.description!]) {
      expect(copy).toContain("eventsMode:current");
      expect(copy).toContain("priorityEventsMore");
      expect(copy).toContain("never advances eventCursor");
      expect(copy).toContain("since:0");
      expect(copy).toContain("eventsMode:history");
      expect(copy).toMatch(/repeat sampled events/);
      expect(copy).toContain("Current count-mark acceptance notices omit message and availability");
    }
  });
});

describe("reply size", () => {
  it("a typical observe and order reply, in characters of the text copy", async () => {
    // The same scenario measured at main 678e3957 before this change: observe 5708, order 5484.
    h = await startHarness({ seed: 1 });
    const agent = await h.connect();
    expect((await agent.call("join")).isError).toBe(false);
    h.advance(50);
    const observed = await agent.call("observe");
    const ordered = await agent.call("order", { kind: "forage" });
    expect(ordered.isError, ordered.text).toBe(false);
    console.log(`reply size: observe ${observed.text.length} characters, order ${ordered.text.length} characters`);
    expect(observed.text.length).toBeLessThan(5708 - TEST_CONFIG.mapWidth * TEST_CONFIG.mapHeight);
    expect(ordered.text.length).toBeLessThan(500);
  });
});
