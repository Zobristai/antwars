// What an agent seated in a Quadrants match reads through the MCP tools, before and after the map draw: the rules
// tool, the slot join briefing and the rules read at the entry point state four colonies against each other, the
// elimination, last-queen and territory wins, the time-up order with its same-tick cases and the four-colony reply
// fields, with every figure from the match config and no two-colony sentence; and the public rules page's Battle
// balance shows the same territory win. Two-colony configs keep their text (test/mcp/redesign-briefing.test.ts and
// the other briefing tests).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { balanceRuleLines } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game, type LobbySeat } from "../../src/mcp/game.js";
import { createMcpHandler } from "../../src/mcp/http.js";
import { type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { gridScaleOf, newMatchConfig } from "../../src/sim/gridScale.js";
import { CELL_ENCODING, FOUR_COLONY_CELL_ENCODING } from "../../src/sim/view.js";
import { ruleSections } from "../../web/rules.js";
import { rules27Redesign } from "../rules27.ts";

/** Test-only quadrant geometry, not a production map (as in test/mcp/quadrants-lobby-match.test.ts). */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
/** The production rules; only the quadrants rotation is the test's. */
// The rules-27 redesign (test/rules27.ts), whose four-colony text these tests state; rules 28 is test/sim/four-colony-rules28.test.ts.
const LIVE = newMatchConfig(rules27Redesign());
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const SEATS: LobbySeat[] = [0, 1, 2, 3].map(colony => ({ identityId: `id-${colony}`, displayName: `Seat ${colony}`, colony }));
const MCP = { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1000 };

/** Two-colony sentences a Quadrants agent must not read: the criterion's own and every other this text once carried. */
const TWO_COLONY_PHRASES = ["the opponent", "times the opponent's territory", "the two colonies add to 100%", "two supercolonies",
  "Colony vs ", "both colonies idle", "both last queens", "the idle seat's colony loses", "colony loses when all", "either colony", "colony0/1", "even=colony0",
  "mirrored on the right", "mirrored rock pairs", "Non-lobby join", "never moved to the other colony", "enemy share]", "Enemy share:"];

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

/** A slot server holding a seated Quadrants lobby; its clock moves only when a test moves it. */
async function quadrantsSlot(seated = true) {
  const clock = { now: 1000 };
  let scheduled = false;
  const game: Game = new Game({
    simConfig: LIVE, quadrantMaps: [FIXTURE], startPickWindowMs: 50, now: () => clock.now, mcpConfig: MCP,
    slot: { identityOf: async key => (key.startsWith("key-") ? `id-${key.slice(4)}` : undefined), locate: async () => undefined },
    // A call waiting on a tick is answered on the next one.
    onInputQueued: () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => { scheduled = false; game.tick(); });
    },
  });
  const seatQuadrants = () => game.seatLobby("quad-lobby", SEATS, "quadrants");
  if (seated) seatQuadrants();
  const handler = createMcpHandler(game, { now: () => clock.now });
  const server: Server = createServer((req, res) => void handler.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(() => handler.close(), () => new Promise<void>(resolve => server.close(() => resolve())));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const connect = async () => {
    const client = new Client({ name: "quadrants-briefing-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    closers.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await client.callTool({ name, arguments: args });
      return { isError: reply.isError === true, data: reply.structuredContent as any };
    };
    // The tool descriptions this session is served (tools/list).
    return Object.assign(call, { listTools: async () => (await client.listTools()).tools });
  };
  return { game, clock, connect, seatQuadrants };
}

/** The match's territory-win figures in the agents' units: seconds and original-size tile areas. */
function territoryWin(config: SimConfig) {
  const early = config.earlyWin!;
  return { from: `from ${early.minTick / config.ticksPerSecond} s`, hold: `${early.holdTicks / config.ticksPerSecond} s`,
    floor: `at least ${early.minHeldTiles} original-size tile areas` };
}

/** Every rule the Quadrants rules and briefing cover, and none of the two-colony sentences. */
function expectQuadrantsText(text: string, config: SimConfig) {
  const win = territoryWin(config);
  for (const covered of [
    "four colonies", "each against the other three",
    "A colony that loses its last queen, or whose seat goes idle, is eliminated on that tick",
    "its territory turns neutral, and the match continues for the others",
    "the idle seat's colony is eliminated and the match continues for the others",
    "last colony with a living queen",
    "more than half of all owned territory", win.from, win.hold, win.floor,
    "surviving colonies rank by kills, then territory, ants alive and food delivered",
    // Kill credit (src/sim/combat.ts): queens count, the finishing hit's colony scores, and it is not the count-mark telemetry.
    "Kills: each enemy ant or queen killed is one kill for the colony whose hit takes it to zero HP (on one tick, ants' hits land before queens' bites); a kill is never shared",
    "This score is not the count-mark kills in marks/myMarks, which credit the biggest hit.",
    "Eliminated colonies rank below every survivor",
    "When every remaining colony loses its last queen or goes idle on the same tick, this order decides among them",
    "colonies eliminated on the same tick rank among themselves by it",
    "on scores as they stood just before that tick's removal of ants and territory",
    "no enemy territory tiles, totals or share are shown",
    "opponents, on every observe once the match has started: the other three colonies in colony order",
    "carries eliminated {tick,reason}",
    "winner (the winning colony's name, \"draw\" or \"abandoned\")",
    "the winner keeps that elimination tick in its eliminated and in the others' opponents, and is still the winner",
    FOUR_COLONY_CELL_ENCODING,
  ]) expect(text, covered).toContain(covered);
  for (const phrase of TWO_COLONY_PHRASES) expect(text, phrase).not.toContain(phrase);
  // Flyers are not in this mode.
  expect(text).not.toMatch(/\bfl(y|ier|yer)|\bwings?\b/i);
}

describe("a Quadrants seat's rules and briefing through the MCP tools", () => {
  it("states the four-colony rules in the rules tool and the slot join briefing, before and after the draw", async () => {
    const { game, clock, connect } = await quadrantsSlot();
    const seat = await connect();
    const listed = NAMES.map((name, colony) => `${name} (colony ${colony})`);
    const allFour = `${listed.slice(0, 3).join(", ")} and ${listed[3]}`;

    // Before the draw (no pick window yet): the seat is told its colony and the briefing, and reads the rules.
    const queued = await seat("join", { key: "key-2" });
    expect(queued.isError).toBe(false);
    expect(queued.data.colony).toBe(NAMES[2]);
    expect(game.mapDrawnFor(queued.data.agentId)).toBe(false);
    const undrawn = game.undrawnConfig;
    expectQuadrantsText(queued.data.briefing, undrawn);
    expect(queued.data.briefing).toContain(`This match's colonies (Quadrants: four colonies, each against the other three): ${allFour}.`);
    const rulesBefore = await seat("rules");
    expect(rulesBefore.isError).toBe(false);
    expectQuadrantsText(rulesBefore.data.rules, undrawn);
    expect(rulesBefore.data.rules).toContain(`Antwars Quadrants: four colonies, ${allFour}, each against the other three`);
    // The board a quadrant map plays on, not the two-colony rotation's size.
    const board = `${FIXTURE.quadrant!.referenceWidth * gridScaleOf(LIVE)}x${FIXTURE.quadrant!.referenceHeight * gridScaleOf(LIVE)}`;
    expect(queued.data.briefing).toContain(`; ${board} tiles,`);
    expect(rulesBefore.data.rules).toContain(`each against the other three; ${board},`);

    // The pick window draws the map; then the match plays on the drawn quadrant board, and a rejoin and the rules read
    // the same rules with the drawn match's figures.
    const closesAt = game.beginLobbyStart(4242);
    expect(game.mapDrawnFor(queued.data.agentId)).toBe(true);
    for (const colony of [0, 1, 3]) await game.joinSeated(`id-${colony}`);
    clock.now = closesAt;
    game.finishLobbyStart();
    game.tick();
    const drawn = game.match!.state.config;
    expect(game.match!.state.terrain!.mapId).toBe(FIXTURE.id);
    expect(`${drawn.mapWidth}x${drawn.mapHeight}`).toBe(board);
    const rejoined = await seat("join", { key: "key-2" });
    expect(rejoined.isError).toBe(false);
    expect(rejoined.data.colony).toBe(NAMES[2]);
    expectQuadrantsText(rejoined.data.briefing, drawn);
    expect(rejoined.data.briefing).toContain(`This match's colonies (Quadrants: four colonies, each against the other three): ${allFour}.`);
    expect(rejoined.data.view.cells.encoding).toBe(FOUR_COLONY_CELL_ENCODING);
    const rulesAfter = await seat("rules");
    expect(rulesAfter.isError).toBe(false);
    expectQuadrantsText(rulesAfter.data.rules, drawn);
    expect(rulesAfter.data.rules).toContain(`- Territory win: ${territoryWin(drawn).from}, a colony holding more than half of all owned territory`);
  });

  it.each([["seated before the connection opens", true], ["seated after the connection opens", false]] as const)(
    "advertises the four-colony observe contract in tools/list, and served cells decode by it: lobby %s", async (_when, seatedFirst) => {
    const { game, clock, connect, seatQuadrants } = await quadrantsSlot(seatedFirst);
    const seat = await connect();
    if (!seatedFirst) {
      // The session's tools are registered before the slot seats its Quadrants lobby.
      expect((await seat.listTools()).find(tool => tool.name === "observe")!.description).toContain(CELL_ENCODING);
      seatQuadrants();
    }
    expect((await seat("join", { key: "key-2" })).isError).toBe(false);
    const closesAt = game.beginLobbyStart(4242);
    for (const colony of [0, 1, 3]) await game.joinSeated(`id-${colony}`);
    clock.now = closesAt;
    game.finishLobbyStart();
    game.tick();
    const observeTool = (await seat.listTools()).find(tool => tool.name === "observe")!;
    const advertised = observeTool.description!;
    // The four-colony decoder and status, not the two-colony ones (hp=floor(k/6), even/odd colonies, both colonies idle).
    expect(advertised).toContain(FOUR_COLONY_CELL_ENCODING);
    expect(advertised).not.toContain(CELL_ENCODING);
    expect(advertised).toContain("the idle seat's colony is eliminated and the match continues for the others");
    for (const phrase of TWO_COLONY_PHRASES) expect(advertised, phrase).not.toContain(phrase);
    // The finding's case: a colony-2 worker at 4000 milli-HP is served as k=48006.
    const state = game.match!.state;
    const worker = state.ants.find(ant => ant.colony === 2)!;
    worker.hp = 4000; worker.caste = "worker";
    const observed = await seat("observe");
    expect(observed.isError).toBe(false);
    const cells = observed.data.view.cells;
    expect(advertised).toContain(cells.encoding);
    // Decode every served ant by the advertised rule: n=colonies; hp=floor(k/(3n)), r=k%(3n); colony=r%n; caste=floor(r/n).
    expect(advertised).toContain("n=colonies; hp=floor(k/(3n)), r=k%(3n); colony=r%n; caste=floor(r/n): 0=no caste, 1=worker, 2=soldier.");
    const n: number = cells.colonies;
    expect(n).toBe(4);
    const decoded = new Map<number, { k: number; hp: number; colony: number; caste: number }>();
    for (const row of (cells.data as string).split(";")) {
      const body = row.split("*")[0]!.split(":")[1];
      for (const record of body === undefined || body === "" ? [] : body.split("/")) {
        const [antId, k] = record.split(".").map(value => parseInt(value, 36)) as [number, number];
        const r = k % (3 * n);
        decoded.set(antId, { k, hp: Math.floor(k / (3 * n)), colony: r % n, caste: Math.floor(r / n) });
      }
    }
    expect(decoded.get(worker.id)).toEqual({ k: 48006, hp: 4000, colony: 2, caste: 1 });
    expect(decoded.size).toBeGreaterThan(1);
    for (const [antId, ant] of decoded) {
      const live = state.ants.find(other => other.id === antId)!;
      expect({ hp: ant.hp, colony: ant.colony, caste: ant.caste }, `ant ${antId}`)
        .toEqual({ hp: live.hp, colony: live.colony, caste: live.caste === undefined ? 0 : live.caste === "worker" ? 1 : 2 });
    }
  });

  it("states the same rules to a client that reads rules at the entry point without a seat", async () => {
    const { game, connect } = await quadrantsSlot();
    const reader = await connect();
    const read = await reader("rules");
    expect(read.isError).toBe(false);
    expectQuadrantsText(read.data.rules, game.undrawnConfig);
  });

  it("shows the four-colony territory win, not the two-colony early win, in the public rules page's Battle balance", async () => {
    const { game, clock } = await quadrantsSlot();
    const closesAt = game.beginLobbyStart(4242);
    for (const colony of [0, 1, 2, 3]) await game.joinSeated(`id-${colony}`);
    clock.now = closesAt;
    game.finishLobbyStart();
    game.tick();
    for (const config of [game.match!.state.config, game.undrawnConfig]) {
      const balance = ruleSections(config).find(section => section.title === "Battle balance")!.lines;
      expect(balance).toEqual(balanceRuleLines(config));
      const win = territoryWin(config);
      expect(balance).toContain(`Territory win: ${win.from}, a colony holding more than half of all owned territory (every colony's held territory added together) and ${win.floor} continuously for ${win.hold} wins immediately. Any interruption resets the clock. An eliminated colony's territory turns neutral and no longer counts. Eliminations are resolved first; otherwise time-up still applies.`);
      expect(balance.join("\n")).not.toMatch(/opponent|left-half|mirrored on the right|flanking/);
    }
  });
});
