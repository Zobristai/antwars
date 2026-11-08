import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { PUBLIC_CONFIG, RULES_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { threeMapRotation } from "../sim/three-map-rotation.js";
import { sevenMapRotation } from "../sim/seven-map-rotation.js";
import { ruleSections } from "../../web/rules.js";
import { HISTORICAL_DEFAULT_CONFIG, PRE_FRONTLINE_CONFIGS } from "../sim/fixtures.js";
import { BOARD_CASES, CAP_ONLY_MAP, LANES_BOARD, LENGTH_ONLY_MAP, OWN_VALUES_WIDE, WIDE_BOARD, boardRotation } from "../sim/map-board-fixtures.js";
import { TEST_CONFIG, TEST_MCP_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";
import { MAX_RULES_REPLY_BYTES, MAX_RULES_TEXT_CHARS } from "../../src/mcp/replies.js";
import { playable } from "../playable.ts";

const texts = (config: SimConfig, undrawn: boolean) => [
  ...[false, true].map(house => briefing(config, DEFAULT_MCP_CONFIG, { house, undrawn })),
  ...[false, true].flatMap(house => [false, true].map(nestWindow => joinBriefing(config, DEFAULT_MCP_CONFIG, nestWindow, { house, undrawn }))),
  JSON.stringify(ruleSections(config, { undrawn })),
];
const mapsLines = (config: SimConfig) => ruleSections(config).find(section => section.title === "Maps")!.lines;


describe("pre-draw board size in replies", () => {
  const configs: (readonly [string, SimConfig])[] = [
    ["PUBLIC_CONFIG", PUBLIC_CONFIG], ["TEST_CONFIG", TEST_CONFIG], ["HISTORICAL_DEFAULT_CONFIG", HISTORICAL_DEFAULT_CONFIG],
    ...[undefined, ...RULES_NAMES].flatMap(name => [[`rules ${name}`, rulesConfig(name)], [`new match ${name}, three-map rotation`, threeMapRotation(newMatchConfig(rulesConfig(name)))]] as const),
    ...Object.entries(PRE_FRONTLINE_CONFIGS),
  ].map(([name, config]) => [name as string, playable(config as SimConfig)] as const);

  it.each(configs)("%s: rotations without boards give today's briefing, join briefing and rules page", (_name, config) => {
    expect(texts(config, true)).toEqual(texts(config, false));
  });

  it("a one-candidate board rotation states that board's size before the draw", () => {
    const config = newMatchConfig(boardRotation(2, [LANES_BOARD], { only: true }));
    expect(config.mapWidth).toBe(128);
    expect(config.mapHeight).toBe(96);
    const [rules, , join] = texts(config, true);
    expect(rules).toContain("128x128");
    expect(join).toContain("128x128 tiles, x 0-127, y 0-127");
    expect(texts(config, true).join("\n")).not.toContain("128x96");
    expect(ruleSections(config, { undrawn: true }).flatMap(s => s.lines)).toContain("The playable board is 128 tiles wide and 128 tiles high.");
  });

  it("a mixed rotation states no single size before the draw", () => {
    const config = newMatchConfig(boardRotation(2, [LANES_BOARD]));
    const all = texts(config, true);
    for (const text of all) expect(text).toContain("128x96 or 128x128");
    for (const text of all) expect(text).not.toMatch(/128x96(?! or)|x 0-127|tiles wide and 96/);
    const lines = mapsLines({ ...config }).concat(ruleSections(config, { undrawn: true }).find(s => s.title === "Maps")!.lines);
    expect(lines).toContain("The map the seed selects sets the playable board: 128x96 or 128x128 tiles, width by height.");
    expect(lines.some(line => line.startsWith("Fixture Lanes: ") && line.includes("Its board is 128 tiles wide and 128 tiles high."))).toBe(true);
  });

  it("during a 64x64 board match at scale 2, maps without a board are described as on the base 128x96 config", () => {
    const rotation = newMatchConfig(boardRotation(2, [LANES_BOARD]));
    const drawn = createMatch(7001, { ...rotation, terrain: { ...rotation.terrain!, mapId: LANES_BOARD.id } }).config;
    expect([drawn.mapWidth, drawn.mapHeight]).toEqual([128, 128]);
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    const today = sevenMapRotation(newMatchConfig(rulesConfig("redesign")));
    expect([today.mapWidth, today.mapHeight]).toEqual([128, 96]);
    for (const name of ["Open Field", "Three Crossings", "Central Lake"]) {
      const line = (config: SimConfig) => mapsLines(config).find(l => l.startsWith(`${name}: `));
      expect(line(drawn)).toBeDefined();
      expect(line(drawn)).toBe(line(today));
    }
    // The drawn match states its own size.
    expect(mapsLines(drawn)).toContain("The playable board is 128 tiles wide and 128 tiles high.");
  });
});

const seats = (size: number) => Array.from({ length: size * 2 }, (_, i) => ({
  identityId: `board-${i}`, displayName: `${i}${"名".repeat(31)}`, colony: (i % 2) as 0 | 1,
}));
async function lobby(config: SimConfig, size: number, mode: "1v1" | "4v4") {
  const roster = seats(size);
  const h = await startHarness({ simConfig: config, start: false, slot: {
    identityOf: async key => roster.find(seat => `key-${seat.identityId}` === key)?.identityId,
    locate: async () => undefined,
  } });
  h.game.seatLobby("board-lobby", roster, mode);
  return { h, roster };
}
async function reply(agent: TestAgent, name: string, args: Record<string, unknown> = {}) {
  const result = await agent.client.callTool({ name, arguments: args }) as CallToolResult;
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
  expect(result.isError, text).not.toBe(true);
  return { data: result.structuredContent as Record<string, any>, chars: text.length, bytes: Buffer.byteLength(JSON.stringify(result)) };
}

describe("a game's replies follow the draw", () => {
  it("a queued agent hears no single size before the start window, then the drawn match's size", async () => {
    const config = newMatchConfig(boardRotation(2, [LANES_BOARD, WIDE_BOARD]));
    const { h, roster } = await lobby(config, 1, "1v1");
    try {
      const agent = await h.connect();
      const joined = await reply(agent, "join", { key: `key-${roster[0]!.identityId}` });
      const rules = await reply(agent, "rules");
      for (const text of [joined.data.briefing as string, rules.data.rules as string]) {
        expect(text).toContain("128x96 or 128x128 or 256x92");
        expect(text).not.toMatch(/128x96(?! or)|x 0-127/);
      }
      // The mixed-rotation replies stay inside the existing caps.
      console.log(`Mixed rotation pre-draw sizes: join ${JSON.stringify([joined.chars, joined.bytes])} rules ${JSON.stringify([rules.chars, rules.bytes])}`);
      expect(joined.chars).toBeLessThanOrEqual(20_000);
      expect(joined.bytes).toBeLessThanOrEqual(40_960);
      expect(rules.chars).toBeLessThanOrEqual(MAX_RULES_TEXT_CHARS);
      expect(rules.bytes).toBeLessThanOrEqual(MAX_RULES_REPLY_BYTES);

      const seed = 7001;
      const drawn = createMatch(seed, config).config;
      const size = `${drawn.mapWidth}x${drawn.mapHeight}`;
      const closesAt = h.game.beginLobbyStart(seed);
      const windowRules = (await reply(agent, "rules")).data.rules as string;
      expect(windowRules).toContain(`${size}, x 0-${drawn.mapWidth - 1} left-right`);
      expect(windowRules).not.toContain(" or 128x128");
      h.clock.now = closesAt;
      h.game.finishLobbyStart();
      expect(`${h.game.match!.state.config.mapWidth}x${h.game.match!.state.config.mapHeight}`).toBe(size);
      const matchRules = (await reply(agent, "rules")).data.rules as string;
      expect(matchRules).toContain(`${size}, x 0-${drawn.mapWidth - 1} left-right`);
      const rejoined = await reply(await h.connect(), "join", { key: `key-${roster[0]!.identityId}` });
      expect(rejoined.data.briefing).toContain(`${size} tiles, x 0-${drawn.mapWidth - 1}, y 0-${drawn.mapHeight - 1}`);
    } finally { await h.close(); }
  }, 30_000);

  it.each([LANES_BOARD, WIDE_BOARD])("$name at scale 2: an eight-seat nest window's join, observe and rules fit their caps", async map => {
    const config = newMatchConfig(boardRotation(2, [map], { mapId: map.id }));
    const { h, roster } = await lobby(config, 4, "4v4");
    try {
      h.game.beginLobbyStart(7001);
      for (const [index, seat] of roster.entries()) {
        const agent = await h.connect();
        const joined = await reply(agent, "join", { key: `key-${seat.identityId}` });
        expect(joined.data.nestSelection.box.height).toBe(map.board!.referenceHeight * 2);
        for (const [name, measured] of [["join", joined], ["observe", await reply(agent, "observe")], ["rules", await reply(agent, "rules")]] as const) {
          if (index === 0) console.log(`${map.id} nest window ${name}: ${JSON.stringify([measured.chars, measured.bytes])}`);
          expect(measured.chars).toBeLessThanOrEqual(name === "rules" ? MAX_RULES_TEXT_CHARS : 33_000);
          expect(measured.bytes).toBeLessThanOrEqual(name === "rules" ? MAX_RULES_REPLY_BYTES : 68_950);
        }
      }
    } finally { await h.close(); }
  }, 60_000);
});

describe.each(BOARD_CASES)("$map.name at grid scale $scale: agent view", ({ map, scale }) => {
  it("observe's cells and territory span the map's board", async () => {
    const config = boardRotation(scale, [map], { mapId: map.id });
    const width = map.board!.referenceWidth * scale, height = map.board!.referenceHeight * scale;
    const h: Harness = await startHarness({ simConfig: config, mcpConfig: TEST_MCP_CONFIG, seed: 7001 });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join", {});
      expect(joined.isError, joined.text).toBe(false);
      expect(joined.data.briefing).toContain(`${width}x${height} tiles, x 0-${width - 1}, y 0-${height - 1}`);
      const observed = await agent.call("observe", { map: true });
      expect(observed.isError, observed.text).toBe(false);
      expect([observed.data.view.territory.width, observed.data.view.territory.height]).toEqual([width, height]);
      expect([observed.data.view.cells.width, observed.data.view.cells.height]).toEqual([width, height]);
    } finally { await h.close(); }
  }, 30_000);
});

describe("a map's own ant cap and match length in replies", () => {
  const count = (text: string, phrase: string) => text.split(phrase).length - 1;

  it("once drawn, the join briefing, rules reply and rules page state that map's board, numeric cap and length", () => {
    const drawn = createMatch(7001, newMatchConfig(boardRotation(2, [OWN_VALUES_WIDE], { mapId: OWN_VALUES_WIDE.id }))).config;
    const [rules, houseRules, ...rest] = texts(drawn, false);
    const joins = rest.slice(0, 4), page = rest[4]!;
    for (const text of [rules!, houseRules!]) {
      expect(count(text, " Ant cap 33/colony.")).toBe(1);
      expect(text).toContain("256x92, x 0-255 left-right, y 0-91 top-bottom. 4 s (0.06666666666666667 minutes); 10 ticks/s. Ant cap 33/colony.");
    }
    for (const join of joins) {
      expect(count(join, " Ant cap 33/colony.")).toBe(1);
      expect(join).toContain("256x92 tiles, x 0-255, y 0-91; 10 ticks/s, match 4 s. Ant cap 33/colony.");
    }
    expect(page).toContain("up to 33 living ants per colony");
    expect(page).toContain("A match lasts 0.06666666666666667 minutes.");
    expect(page).toContain("The playable board is 256 tiles wide and 92 tiles high.");
    expect(page).not.toContain("512");
  });

  it("before the draw, a one-candidate rotation states its single cap and length", () => {
    const config = newMatchConfig(boardRotation(2, [OWN_VALUES_WIDE], { only: true }));
    const [rules, houseRules, ...rest] = texts(config, true);
    for (const text of [rules!, houseRules!]) {
      expect(count(text, " Ant cap 33/colony.")).toBe(1);
      expect(text).toContain("4 s (0.06666666666666667 minutes); 10 ticks/s. Ant cap 33/colony.");
    }
    for (const join of rest.slice(0, 4)) expect(join).toContain("match 4 s. Ant cap 33/colony.");
    expect(rest[4]).toContain("up to 33 living ants per colony");
    expect(rest[4]).toContain("A match lasts 0.06666666666666667 minutes.");
  });

  it("before the draw, a mixed rotation states every cap and length the seed can select, never one as if it applied to all", () => {
    const config = newMatchConfig(boardRotation(2, [OWN_VALUES_WIDE, LENGTH_ONLY_MAP, CAP_ONLY_MAP]));
    const [rules, houseRules, ...rest] = texts(config, true);
    const joins = rest.slice(0, 4), page = rest[4]!;
    for (const text of [rules!, houseRules!]) {
      expect(text).toContain("128x96 or 256x92, set by the seed's map");
      expect(text).toContain("1800 s (30 minutes) or 4 s (0.06666666666666667 minutes) or 7200 s (120 minutes), set by the seed's map; 10 ticks/s. Ant cap 512 or 33/colony, set by the seed's map.");
      expect(text).not.toMatch(/Ant cap \d+\/colony\./);
    }
    for (const join of joins) {
      expect(join).toContain("match 1800 or 4 or 7200 s, set by the seed's map. Ant cap 512 or 33/colony, set by the seed's map.");
      expect(join).not.toMatch(/match \d+ s\.|Ant cap \d+\/colony\./);
    }
    expect(page).toContain("up to 512 living ants or 33 living ants (set by the seed's map) per colony");
    expect(page).toContain("A match lasts 30 minutes or 0.06666666666666667 minutes or 120 minutes (set by the seed's map).");
    expect(page).not.toMatch(/A match lasts \d+ minutes\./);
  });

  it("a map's own length leaves the early win, overrun grace and combat grace text unchanged on every surface", () => {
    const plain = { id: LENGTH_ONLY_MAP.id, name: LENGTH_ONLY_MAP.name, water: [] };
    const today = createMatch(7001, newMatchConfig(boardRotation(2, [plain], { mapId: plain.id }))).config;
    const long = createMatch(7001, newMatchConfig(boardRotation(2, [LENGTH_ONLY_MAP], { mapId: LENGTH_ONLY_MAP.id }))).config;
    expect([long.matchTicks, today.matchTicks]).toEqual([72_000, 18_000]);
    const asToday = (text: string) => text.replaceAll("7200 s (120 minutes)", "1800 s (30 minutes)").replaceAll("match 7200 s.", "match 1800 s.").replaceAll("120 minutes", "30 minutes");
    expect(texts(long, false).map(asToday)).toEqual(texts(today, false));
    expect(texts(long, false).join("\n")).toContain("7200 s (120 minutes)");
  });
});
