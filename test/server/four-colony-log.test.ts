// A four-colony match as the live server writes it: Game starts it from seed and config alone (no injected
// state), four open joins take the four colonies, seats call through Game.call, and the server's idle rule
// removes a silent seat's colony while play continues. Replaying the written log reaches every tick's hash.
import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game, observeInfo, type Outcome } from "../../src/mcp/game.js";
import { pagedView } from "../../src/mcp/replies.js";
import { rulesConfig, SUB, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { parseLog, replay, stateHash } from "../../src/sim/log.js";
import { activeQueens } from "../../src/sim/map.js";
import { expandCells, type AgentView, type DenseCells } from "../../src/sim/view.js";

/** Test-only replay fixture: top nests 5 reference tiles apart across the vertical axis, far from the bottom ones,
 * each start area in its quadrant's far corner so a nest is not ringed by its own start ants. */
const CLOSE: MapDefinition = {
  id: "close-quadrants", name: "Close Quadrants", water: [],
  quadrant: { referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
    startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }] },
};
const LIVE = newMatchConfig(rulesConfig("redesign"));
const CONFIG: SimConfig = { ...LIVE, combatGraceTicks: 0, matchTicks: 1500, queenHp: { ...LIVE.queenHp!, shieldTicks: 0 }, terrain: { ...LIVE.terrain!, maps: [CLOSE] } };
const SEED = 404;
const IDLE_SECONDS = 30;
const tile = (v: number) => Math.floor(v / SUB);

interface Played {
  readonly game: Game;
  readonly logs: string[];
  readonly hashes: string[];
  readonly marks: { tick: number; outcome: Outcome }[];
  /** A view of colony 0 while it sees colony 1's queen, with the config it played. */
  readonly sighting: AgentView | null;
}

/** Seats 0 to 2 observe every 10 ticks; seat 3 never calls. With attack, seat 0 sends an ATTACK count mark on
 * colony 1's queen tile every 20 ticks (refused while out of sight). */
async function play(attack: boolean): Promise<Played> {
  const logs: string[] = [];
  const game = new Game({ mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: IDLE_SECONDS }, simConfig: CONFIG, onLogLine: line => logs.push(line) });
  const joins = await Promise.all([0, 1, 2, 3].map(i => game.join({ displayName: `seat ${i}` })));
  expect(joins.map(j => j.outcome.kind)).toEqual(["queued", "queued", "queued", "queued"]);
  game.startMatch(SEED, { config: CONFIG });
  const hashes = [stateHash(game.tick()!.state)];
  const agents = game.match!.state.agents;
  expect(agents.map(a => a.colony)).toEqual([0, 1, 2, 3]);
  const seat = (colony: number) => agents.find(a => a.colony === colony)!.id;
  const calls: Promise<unknown>[] = [], marks: { tick: number; outcome: Outcome }[] = [];
  let sighting: AgentView | null = null;
  while (game.match!.state.result === null) {
    const state = game.match!.state, tick = state.tick;
    if (tick % 10 === 0) for (const colony of [0, 1, 2]) {
      calls.push(game.call(seat(colony), { type: "observe", agentId: seat(colony) }).then(outcome => {
        if (colony === 0 && sighting === null && outcome.kind === "view" && outcome.view.cells.some(c => c.queen === 1)) sighting = outcome.view;
      }));
    }
    const queen = activeQueens(state.colonies[1]!)[0];
    if (attack && tick % 20 === 0 && queen !== undefined) {
      calls.push(game.call(seat(0), { type: "count_mark", agentId: seat(0), tileX: tile(queen.queenX), tileY: tile(queen.queenY), verb: "ATTACK", count: 200 })
        .then(outcome => { marks.push({ tick, outcome }); }));
    }
    const out = game.tick();
    if (out === null) break;
    hashes.push(stateHash(out.state));
  }
  await Promise.all(calls);
  return { game, logs, hashes, marks, sighting };
}

describe("a four-colony match written by the live server", () => {
  it("replays from its log to every tick's hash, through a logged attack, a queen loss and an idle end", async () => {
    const run = await play(true);
    const lines = run.logs.slice(1).map(line => JSON.parse(line) as { tick: number; inputs: { type: string; agentId: string }[]; idle?: number[]; eliminated?: { colony: number; reason: string }[] });
    const accepted = run.marks.find(m => m.outcome.kind === "view");
    expect(accepted).toBeDefined();
    // The accepted mark is in the log, on its tick.
    expect(lines.find(l => l.tick === accepted!.tick)!.inputs.some(i => i.type === "count_mark")).toBe(true);
    const logged = lines.filter(l => l.eliminated !== undefined);
    const queenLoss = logged.find(l => l.eliminated!.some(e => e.reason === "queens_killed"));
    const idleEnd = logged.find(l => l.eliminated!.some(e => e.reason === "idle"));
    expect(idleEnd).toMatchObject({ idle: [3], eliminated: [{ colony: 3, reason: "idle" }] });
    expect(queenLoss).toBeDefined();
    // Event order, not exact ticks: the attack is accepted before the queen falls; play continues past both eliminations.
    expect(accepted!.tick).toBeLessThan(queenLoss!.tick);
    const state = run.game.match!.state;
    expect(state.result).not.toBeNull();
    expect(state.result!.tick).toBeGreaterThan(Math.max(queenLoss!.tick, idleEnd!.tick));
    // The idle colony is ended once, not again on every later tick.
    expect(lines.filter(l => l.idle !== undefined)).toHaveLength(1);

    const replayed: string[] = [];
    const end = replay(run.logs, Infinity, s => replayed.push(stateHash(s)));
    expect(replayed).toEqual(run.hashes);
    expect(end.result).toEqual(state.result);
    expect(end.colonies.flatMap(c => c.eliminated === undefined ? [] : [{ tick: c.eliminated.tick, colony: c.id, reason: c.eliminated.reason }]).toSorted((a, b) => a.tick - b.tick))
      .toEqual(logged.flatMap(l => l.eliminated!.map(e => ({ tick: l.tick, ...e }))));
    expect(parseLog(run.logs).idle.get(idleEnd!.tick)).toEqual([3]);

    // Without the attack, no queen falls by that tick.
    const control = await play(false);
    const controlLoss = control.logs.slice(1).map(line => JSON.parse(line)).find(l => l.eliminated?.some((e: { reason: string }) => e.reason === "queens_killed"));
    expect(controlLoss === undefined || controlLoss.tick > queenLoss!.tick).toBe(true);
  }, 120_000);

  it("names each enemy queen's colony in the reply, encodes four colonies, and gives no enemy territory share", async () => {
    const run = await play(true);
    expect(run.sighting).not.toBeNull();
    const view = run.sighting!;
    const reply = pagedView(run.game, run.game.match!.state.config, structuredClone(view), false);
    const replied = (reply.structuredContent as { view: { cells: DenseCells; enemyQueens?: { colony?: number }[] } }).view;
    expect(replied.cells.colonies).toBe(4);
    expect(expandCells(replied.cells).some(cell => cell.queen === 1)).toBe(true);
    expect(replied.enemyQueens!.length).toBeGreaterThan(0);
    for (const queen of replied.enemyQueens!) expect([1, 2, 3]).toContain(queen.colony);
    expect(observeInfo(run.game.match!.state, view.agentId, run.game.match!.state.config).status).toHaveLength(2);
  }, 120_000);
});
