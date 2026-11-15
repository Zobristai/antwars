// A seated Quadrants lobby on a slot server's Game, under the production redesign rules: four seats start one
// four-colony match on a quadrant rotation, and only on one (any other rotation's start is refused with its own
// reason); each seat's colony keeps its own name, before the start and in play; the idle rule removes a silent colony
// while play continues; seats that all go idle on one tick end it with the engine's own time-up order; a seat that never
// joins abandons it; and a saved and resumed match keeps its four names.
import { describe, expect, it } from "vitest";
import { joinBriefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game, QUADRANT_ROTATION_REQUIRED, type LobbySeat } from "../../src/mcp/game.js";
import { drawColonyNames } from "../../src/sim/colonyNames.js";
import { COLONY_NAMES, rulesConfig, type MapDefinition } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { rankColonies } from "../../src/sim/elimination.js";

/** Test-only quadrant geometry, not a production map. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
/** The production rules every Game here runs; only the quadrants rotation differs between cases. */
const LIVE = newMatchConfig(rulesConfig("redesign"));
const TWO_COLONY = LIVE.terrain!.maps[0]!;
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const IDLE_SECONDS = 3;
const SEED = 4242;
const SEATS: LobbySeat[] = [0, 1, 2, 3].map(colony => ({ identityId: `id-${colony}`, displayName: `Seat ${colony}`, colony }));

function seated(quadrantMaps: readonly MapDefinition[] = [FIXTURE]) {
  let now = 1000;
  const game = new Game({ simConfig: LIVE, quadrantMaps, startPickWindowMs: 50, now: () => now,
    mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1000, houseIdleSeconds: IDLE_SECONDS },
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  game.seatLobby("quad-lobby", SEATS, "quadrants");
  return { game, at: (time: number) => { now = time; } };
}

/** Seats `joining` colonies, opens and closes the pick window (missing picks take their defaults) and runs tick 0. */
async function started(joining: readonly number[] = [0, 1, 2, 3]) {
  const s = seated();
  const closesAt = s.game.beginLobbyStart(SEED);
  const agents = new Map<number, string>();
  for (const colony of joining) {
    const joined = (await s.game.joinSeated(`id-${colony}`))!;
    expect(joined.outcome.kind).toBe("queued");
    agents.set(colony, joined.agentId!);
  }
  s.at(closesAt);
  s.game.finishLobbyStart();
  s.game.tick();
  return { ...s, agents };
}

/** Ticks until the match ends or `until` holds; `calling` colonies observe every 10 ticks (their seats stay active). */
async function play(game: Game, agents: ReadonlyMap<number, string>, calling: (tick: number) => readonly number[], until: () => boolean = () => false) {
  while (game.match!.state.result === null && !until()) {
    const tick = game.match!.state.tick;
    const calls = tick % 10 === 0 ? calling(tick).map(colony => game.call(agents.get(colony)!, { type: "observe", agentId: agents.get(colony)! })) : [];
    game.tick();
    await Promise.all(calls);
  }
}

describe("a Quadrants lobby's match under the production redesign rules", () => {
  it("starts one four-colony match on a quadrant rotation, each seat on its own colony", async () => {
    const { game, agents } = await started();
    const state = game.match!.state;
    expect(state.terrain!.mapId).toBe(FIXTURE.id);
    expect(state.colonies.map(colony => colony.id)).toEqual([0, 1, 2, 3]);
    expect([...agents.values()].map(agentId => state.agents.find(agent => agent.id === agentId)!.colony)).toEqual([0, 1, 2, 3]);
  });

  it.each([
    ["an empty rotation", []],
    ["a two-colony rotation", [TWO_COLONY]],
    ["a rotation mixing quadrant and two-colony maps", [FIXTURE, TWO_COLONY]],
  ] as const)("refuses the start on %s with its own reason, opening no pick window and starting no match", (_label, maps) => {
    const { game } = seated(maps);
    expect(() => game.beginLobbyStart(SEED)).toThrow(QUADRANT_ROTATION_REQUIRED);
    expect(game.openStart).toBeNull();
    expect(game.match).toBeNull();
  });

  it("names each seat's colony by its colony number, before the start and in play", async () => {
    const s = seated();
    expect(s.game.colonyNames()).toEqual(NAMES);
    const closesAt = s.game.beginLobbyStart(SEED);
    const agents: string[] = [];
    for (const colony of [0, 1, 2, 3]) {
      const joined = (await s.game.joinSeated(`id-${colony}`))!;
      agents.push(joined.agentId!);
      expect(s.game.quadrantSeatColony(joined.agentId!)).toBe(NAMES[colony]);
      expect(s.game.colonyNames(joined.agentId!)).toEqual(NAMES);
    }
    s.at(closesAt);
    s.game.finishLobbyStart();
    s.game.tick();
    for (const [colony, agentId] of agents.entries()) {
      expect(s.game.quadrantSeatColony(agentId)).toBe(NAMES[colony]);
      // A rejoin in play is answered on the next tick.
      const rejoining = s.game.joinSeated(`id-${colony}`);
      s.game.tick();
      const rejoined = (await rejoining)!;
      expect(rejoined.outcome.kind).toBe("view");
      if (rejoined.outcome.kind !== "view") throw new Error("expected a view");
      expect(s.game.colonyNames(agentId)[rejoined.outcome.view.colony]).toBe(NAMES[colony]);
    }
  });

  it("adds no names line to a two-colony config's join briefing for a seat's four names, while a drawn pair is still stated", async () => {
    const s = seated();
    const joined = (await s.game.joinSeated("id-2"))!;
    const unnamed = joinBriefing(LIVE, DEFAULT_MCP_CONFIG, false, { house: false });
    // Four names on a two-colony config, the first two the rated pair's: no names line, neither the rated pair nor two
    // of the four. A four-colony config's briefing names all four (test/mcp/quadrants-briefing.test.ts).
    expect(joinBriefing(LIVE, DEFAULT_MCP_CONFIG, false, { house: false, colonyNames: s.game.colonyNames(joined.agentId!) })).toBe(unnamed);
    expect(joinBriefing(LIVE, DEFAULT_MCP_CONFIG, false, { house: false, colonyNames: COLONY_NAMES })).toBe(unnamed);
    const drawn = drawColonyNames("quad-lobby");
    expect(joinBriefing(LIVE, DEFAULT_MCP_CONFIG, false, { house: false, colonyNames: drawn }))
      .toContain(`This match's colonies: ${drawn[0]} (colony 0) and ${drawn[1]} (colony 1).`);
  });

  it("removes a silent colony for idling while the other three play on", async () => {
    const { game, agents } = await started();
    await play(game, agents, () => [0, 1, 2], () => game.match!.state.colonies[3]!.eliminated !== undefined);
    const state = game.match!.state;
    expect(state.colonies[3]!.eliminated).toMatchObject({ reason: "idle" });
    expect(state.colonies.slice(0, 3).map(colony => colony.eliminated)).toEqual([undefined, undefined, undefined]);
    expect(state.result).toBeNull();
    game.tick();
    expect(game.match!.state.result).toBeNull();
  });

  it("ends with the engine's time-up order when every colony goes idle on one tick, every colony eliminated", async () => {
    const { game, agents } = await started();
    // Every seat calls on the same ticks until tick 200, so all four go idle together.
    await play(game, agents, tick => tick <= 200 ? [0, 1, 2, 3] : []);
    const state = game.match!.state;
    const ticks = state.colonies.map(colony => colony.eliminated?.tick);
    expect(new Set(ticks).size).toBe(1);
    expect(ticks[0]).toBe(state.result!.tick);
    expect(state.colonies.map(colony => colony.eliminated?.reason)).toEqual(["idle", "idle", "idle", "idle"]);
    // The winner is the engine's own time-up order over the colonies as they stood before the removal.
    const order = rankColonies(state);
    expect(state.result).toMatchObject({ reason: "idle", winner: order[0]!.colony });
    expect(state.result!.winner).not.toBe(0);
  });

  it("abandons the match when a seat never joins", async () => {
    const { game, agents } = await started([0, 1, 2]);
    await play(game, agents, () => [0, 1, 2]);
    expect(game.match!.state.result).toMatchObject({ winner: null, reason: "abandoned" });
    expect(game.matchAbsentColonies()).toEqual([3]);
  });

  it("keeps its four names through a handover save and resume", async () => {
    const { game, agents } = await started();
    await play(game, agents, () => [0, 1, 2, 3], () => game.match!.state.tick >= 20);
    const save = game.saveMatch();
    expect(save.lobby).not.toHaveProperty("colonyNames");
    const next = new Game({ simConfig: LIVE, quadrantMaps: [FIXTURE], slot: { identityOf: async () => undefined, locate: async () => undefined } });
    next.resumeMatch(save);
    expect(next.colonyNames()).toEqual(NAMES);
    for (const [colony, agentId] of agents) {
      expect(next.colonyNames(agentId)).toEqual(NAMES);
      expect(next.quadrantSeatColony(agentId)).toBe(NAMES[colony]);
    }
  });
});
