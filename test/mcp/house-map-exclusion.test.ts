import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.js";
import { startHarness } from "./harness.js";
import { briefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import { PUBLIC_CONFIG, withoutHousePausedMaps, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { HOUSE_PAUSED_MAP_IDS, hasDistinctMapLayouts, houseMatchMaps, newMatchMaps } from "../../src/sim/mapShapes.js";
import { selectMap } from "../../src/sim/terrain.js";
import { RANKED_MODES, type RankedMode } from "../../src/rating/ratings.js";
import { ruleSections } from "../../web/rules.js";

// House modes stopped drawing Wide Plain.
// The exclusion is emptied, so house modes draw it again.
const SLOT_CONFIG = newMatchConfig(PUBLIC_CONFIG);
const HOUSE_MODES = RANKED_MODES.filter(mode => mode.startsWith("house-"));
const OTHER_MODES: (RankedMode | null)[] = [...RANKED_MODES.filter(mode => !mode.startsWith("house-")), null];
const sizeOf = (mode: RankedMode | null) => mode === null ? 1 : Number(mode.at(-3));
const ids = (config: SimConfig) => config.terrain!.maps.map(map => map.id);

/** Seeds whose slot-wide draw is Wide Plain, plus seeds that draw every other map. */
const WIDE_PLAIN_SEEDS = Array.from({ length: 4000 }, (_, n) => n + 1)
  .filter(seed => selectMap(seed, SLOT_CONFIG.terrain!).id === "wide-plain").slice(0, 12);
const OTHER_SEEDS = [1, 2, 3, 7001, 31337, 424242];

/** The map list the lobby's start window draws from, read where finishLobbyStart reads it. */
async function lobbyDraw(mode: RankedMode | null, seed: number): Promise<{ before: SimConfig; window: SimConfig }> {
  const game = new Game({ now: () => 1000, slot: { identityOf: async () => undefined, locate: async () => undefined } });
  const size = sizeOf(mode);
  const roster = ([0, 1] as const).flatMap(colony => Array.from({ length: size }, (_, n) => ({
    identityId: `team-${colony}-${n}`, displayName: `Team ${colony}`, colony, seat: n + 1,
  })));
  game.seatLobby("lobby", roster, mode);
  const joined = (await game.joinSeated(roster[0]!.identityId, undefined, roster[0]!.seat))!;
  const before = game.configForAgent(joined.agentId!);
  game.beginLobbyStart(seed);
  return { before, window: game.configForAgent(joined.agentId!) };
}

let server: SpectatedServer | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("house-mode map draws include Wide Plain again (emptying the exclusion)", () => {
  it("the exclusion list is empty, and the house rotation is the new-match rotation", () => {
    expect(HOUSE_PAUSED_MAP_IDS).toEqual([]);
    expect(houseMatchMaps()).toEqual(newMatchMaps());
    expect(ids(SLOT_CONFIG)).toEqual(["open-field", "three-crossings-v2", "central-lake-v2", "isthmus", "twin-shields", "four-lanes", "wide-plain"]);
    // With nothing paused, the config is returned as is.
    expect(withoutHousePausedMaps(SLOT_CONFIG)).toBe(SLOT_CONFIG);
  });

  it("finds seeds whose slot-wide draw is Wide Plain", () => {
    expect(WIDE_PLAIN_SEEDS).toHaveLength(12);
  });

  it.each(HOUSE_MODES)("%s draws from the ranked list, Wide Plain included, before and after the start window opens", async mode => {
    for (const seed of [...WIDE_PLAIN_SEEDS, ...OTHER_SEEDS]) {
      const { before, window } = await lobbyDraw(mode, seed);
      expect(ids(before)).toEqual(ids(SLOT_CONFIG));
      expect(ids(window)).toEqual(ids(SLOT_CONFIG));
      expect(selectMap(seed, window.terrain!).id).toBe(selectMap(seed, SLOT_CONFIG.terrain!).id);
    }
    for (const seed of WIDE_PLAIN_SEEDS.slice(0, 3)) {
      const { window } = await lobbyDraw(mode, seed);
      expect(selectMap(seed, window.terrain!).id).toBe("wide-plain");
      expect(createMatch(seed, window).terrain!.mapId).toBe("wide-plain");
    }
  });

  it.each(OTHER_MODES)("mode %s draws from the same list as before, Wide Plain included", async mode => {
    for (const seed of [...WIDE_PLAIN_SEEDS.slice(0, 3), ...OTHER_SEEDS]) {
      const { before, window } = await lobbyDraw(mode, seed);
      expect(ids(before)).toEqual(ids(SLOT_CONFIG));
      expect(ids(window)).toEqual(ids(SLOT_CONFIG));
      expect(selectMap(seed, window.terrain!).id).toBe(selectMap(seed, SLOT_CONFIG.terrain!).id);
    }
    expect(selectMap(WIDE_PLAIN_SEEDS[0]!, (await lobbyDraw(mode, WIDE_PLAIN_SEEDS[0]!)).window.terrain!).id).toBe("wide-plain");
  });

  it("house briefing and rules page describe all seven maps, Wide Plain included", () => {
    const house = withoutHousePausedMaps(SLOT_CONFIG);
    expect(hasDistinctMapLayouts(house.terrain!)).toBe(true);
    const maps = ruleSections(house).find(section => section.title === "Maps")!.lines.join("\n");
    for (const name of ["Open Field", "Three Crossings", "Central Lake", "Isthmus", "Twin Shields", "Four Lanes", "Wide Plain"]) expect(maps).toContain(name);
    const text = briefing(house, DEFAULT_MCP_CONFIG, { house: true, undrawn: true });
    expect(text).toContain("Seed selects map.");
    expect(text).toContain("Four Lanes: ");
    expect(text).toContain("Wide Plain: ");
  });

  it.each([["house-1v1", true], ["house-4v4", true], ["1v1", true], ["4v4", true]] as const)(
    "before anyone joins a seated %s lobby, the MCP rules tool describes Wide Plain: %s", async (mode, listed) => {
      const h = await startHarness({ simConfig: SLOT_CONFIG, start: false, slot: { identityOf: async () => undefined, locate: async () => undefined } });
      try {
        const roster = ([0, 1] as const).flatMap(colony => Array.from({ length: sizeOf(mode) }, (_, n) => ({
          identityId: `team-${colony}-${n}`, displayName: `Team ${colony}`, colony, seat: n + 1 })));
        h.game.seatLobby("lobby", roster, mode);
        const agent = await h.connect();
        const rules = (await agent.call("rules")).data.rules as string;
        expect(rules).toContain("Four Lanes: ");
        expect(rules.includes("Wide Plain")).toBe(listed);
      } finally {
        await h.close();
      }
    });

  it("the slot's /rules page follows the seated lobby's mode before any map is drawn", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "antwar-house-rules-"));
    server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: SLOT_CONFIG });
    const game = server.game as unknown as Game;
    Object.assign(game, { now: () => 0, onLogLine: () => {}, slot: { identityOf: async () => undefined, locate: async () => undefined } });
    const page = async () => (await fetch(`http://127.0.0.1:${server!.port}/rules`)).text();
    const roster = [{ identityId: "left", displayName: "Left", colony: 0 as const }, { identityId: "right", displayName: "Right", colony: 1 as const }];
    const undrawn = await page();
    expect(undrawn).toContain("Wide Plain");
    game.seatLobby("house", roster, "house-1v1");
    const house = await page();
    expect(house).toContain("Four Lanes");
    expect(house).toContain("Wide Plain");
    expect(house).toBe(undrawn);
    game.seatLobby("ranked", roster, "1v1");
    expect(await page()).toContain("Wide Plain");
  });

  it("on a reused slot, a house lobby seated after a ranked match ends shows its seven maps, not the retained match", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "antwar-house-rules-"));
    server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: SLOT_CONFIG });
    const game = server.game as unknown as Game;
    let clock = 0;
    Object.assign(game, { now: () => clock, onLogLine: () => {}, slot: { identityOf: async () => undefined, locate: async () => undefined } });
    const page = async () => (await fetch(`http://127.0.0.1:${server!.port}/rules`)).text();
    const roster = [{ identityId: "left", displayName: "Left", colony: 0 as const }, { identityId: "right", displayName: "Right", colony: 1 as const }];
    game.seatLobby("ranked", roster, "1v1");
    clock = game.beginLobbyStart(WIDE_PLAIN_SEEDS[0]!);
    game.finishLobbyStart();
    game.tick(true);
    expect(game.match!.result).not.toBeNull();
    const retained = await page();
    expect(retained).toContain("Wide Plain");
    // A ranked lobby seated next keeps the retained-match page until its window opens.
    game.seatLobby("ranked-2", roster, "1v1");
    expect(await page()).toBe(retained);
    game.seatLobby("house", roster, "house-1v1");
    const house = await page();
    expect(house).not.toBe(retained);
    for (const name of ["Four Lanes", "Wide Plain"]) expect(house).toContain(name);
  });

  it("a saved seven-map config still loads, draws and describes Wide Plain as before", () => {
    expect(hasDistinctMapLayouts(SLOT_CONFIG.terrain!)).toBe(true);
    const seed = WIDE_PLAIN_SEEDS[0]!;
    expect(createMatch(seed, SLOT_CONFIG).terrain!.mapId).toBe("wide-plain");
    const maps = ruleSections(SLOT_CONFIG).find(section => section.title === "Maps")!.lines.join("\n");
    expect(maps).toContain("Wide Plain: two ponds in front of each home leave three gaps onto an open central plain");
  });

  it("a saved six-map house config (the earlier rotation) is still recognised and keeps its per-map descriptions", () => {
    const saved = { ...SLOT_CONFIG, terrain: { ...SLOT_CONFIG.terrain!, maps: SLOT_CONFIG.terrain!.maps.filter(map => map.id !== "wide-plain") } };
    expect(ids(saved)).toEqual(["open-field", "three-crossings-v2", "central-lake-v2", "isthmus", "twin-shields", "four-lanes"]);
    expect(hasDistinctMapLayouts(saved.terrain!)).toBe(true);
    const maps = ruleSections(saved).find(section => section.title === "Maps")!.lines.join("\n");
    expect(maps).toContain("Four Lanes: three long east-west lakes split the middle into four separate lanes");
    expect(maps).not.toContain("Wide Plain");
    expect(briefing(saved, DEFAULT_MCP_CONFIG, { house: true, undrawn: true })).toContain("Four Lanes: three long east-west lakes split the middle into four separate lanes.");
  });
});
