import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { cloneState, createMatch } from "../../src/sim/map.js";
import { StartPlacement, type StartingNest } from "../../src/sim/startPlacement.js";
import { step } from "../../src/sim/step.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { ColonyId, QueenState, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { sevenMapRotation } from "./seven-map-rotation.js";

/**
 * In rules 27 a lobby seat's join carries the queenId
 * StartPlacement.finish gave that seat, and its agent owns that live starting queen.
 * Today's seat-to-queen path:
 * finish returns seat key, colony, queenId and tile, and the simulation join assigns no queen.
 * A seat that joins late claims her even when the draw held her for a teammate.
 * Owners the draw would give are set directly, so nothing here depends on the draw.
 */

const SEED = 6220;
/** Three seats on colony 0 and one on colony 1, so queenId 2 exists only on colony 0. */
const SEATS = [
  { identityId: "a0", colony: 0 as const }, { identityId: "a1", colony: 0 as const }, { identityId: "a2", colony: 0 as const },
  { identityId: "b0", colony: 1 as const },
];

/** A finalized lobby start, built as src/mcp/lobbyStart.ts builds it. */
function lobby(): { config: SimConfig; nests: StartingNest[] } {
  const base = rulesConfig("redesign");
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  const picked = sevenMapRotation(newMatchConfig({ ...base, terrain: { ...base.terrain!, mapId: "three-crossings" } }));
  const board = createMatch(SEED, picked);
  const window = new StartPlacement(picked, SEATS, 0, (x, y) => isWaterTile(board.terrain, x, y) ? "water"
    : isRockTile(board.terrain, x, y) ? "rock" : board.food[y * picked.mapWidth + x] > 0 ? "food" : null);
  const nests = window.finish(window.closesAt);
  const team = (colony: ColonyId) => nests.filter(n => n.colony === colony).map(({ tileX, tileY }) => ({ tileX, tileY }));
  const config: SimConfig = { ...picked, initialQueens: [team(0), team(1)],
    queenFounding: { ...picked.queenFounding!, costBasis: "founded-live" } };
  return { config, nests };
}

const agentOf = (nest: StartingNest): string => `agent-${nest.identityId}`;
const seatJoin = (nest: StartingNest, withQueen = true): SimInput =>
  ({ type: "join", agentId: agentOf(nest), placement: nest.colony, ...(withQueen ? { queenId: nest.queenId } : {}) });
const queen = (state: SimState, colony: ColonyId, id: number): QueenState => state.colonies[colony].queens!.find(q => q.id === id)!;
const nestOf = (nests: readonly StartingNest[], identityId: string): StartingNest => nests.find(n => n.identityId === identityId)!;

function run(state: SimState, ticks: number): SimState {
  for (let t = 0; t < ticks; t++) state = step(state, []).state;
  return state;
}

/** Apply one join alone, outside step, so no later pass in the tick can touch the queens. */
function joinAlone(state: SimState, input: SimInput): { state: SimState; ok: boolean } {
  const next = cloneState(state);
  const events: SimEvent[] = [];
  const outcome = applyInput(next, input, next.tick, defaultAllocator, events);
  return { state: next, ok: outcome.error === null };
}

describe("rules 27: a seat's join claims its starting queen", () => {
  it("every seat joining at the start owns the starting queen it picked", () => {
    const { config, nests } = lobby();
    const start = createMatch(SEED, config);
    for (const nest of nests) expect(queen(start, nest.colony, nest.queenId)).toMatchObject({ starting: true, lostTick: null });
    const out = step(start, nests.map(n => seatJoin(n)));
    expect(out.results.every(r => r.ok)).toBe(true);
    for (const nest of nests) expect(queen(out.state, nest.colony, nest.queenId).owner).toBe(agentOf(nest));
    // The claim is the whole change: the joined agents are as a join without queenId makes them.
    const plain = step(start, nests.map(n => seatJoin(n, false))).state;
    expect(out.state.agents).toEqual(plain.agents);
  });

  it("a seat joining late claims her from the teammate holding her, keeping her spawn point", () => {
    const { config, nests } = lobby();
    const a0 = nestOf(nests, "a0"), a1 = nestOf(nests, "a1");
    let state = step(createMatch(SEED, config), nests.filter(n => n !== a1).map(n => seatJoin(n))).state;
    state = run(state, 40);
    // Stand in for the draw holding a1's queen for its teammate, and that owner setting her spawn point.
    const held = queen(state, 0, a1.queenId);
    held.owner = agentOf(a0);
    held.spawnPoint = { tileX: a1.tileX, tileY: a1.tileY };
    const out = step(state, [seatJoin(a1)]);
    expect(out.results[0]!.ok).toBe(true);
    expect(queen(out.state, 0, a1.queenId)).toMatchObject({ owner: agentOf(a1), spawnPoint: { tileX: a1.tileX, tileY: a1.tileY } });
    expect(queen(out.state, 0, a0.queenId).owner).toBe(agentOf(a0));
  });

  it("a queenId that names no live starting queen of the joining agent's colony claims nothing", () => {
    const { config, nests } = lobby();
    const start = createMatch(SEED, config);
    const a1 = nestOf(nests, "a1"), b0 = nestOf(nests, "b0");
    const owners = (state: SimState) => state.colonies.flatMap(c => c.queens!.map(q => q.owner));

    // Colony 1 has only queen 0; queenId 2 is a colony-0 starting queen.
    expect(start.colonies[1].queens!.map(q => q.id)).toEqual([0]);
    const foreign = joinAlone(start, { ...seatJoin(b0), queenId: 2 } as SimInput);
    expect(foreign.ok).toBe(true);
    expect(owners(foreign.state)).toEqual(owners(start));

    const missing = joinAlone(start, { ...seatJoin(a1), queenId: 99 } as SimInput);
    expect(missing.ok).toBe(true);
    expect(owners(missing.state)).toEqual(owners(start));

    const lost = cloneState(start);
    queen(lost, 0, a1.queenId).lostTick = 0;
    const afterLoss = joinAlone(lost, seatJoin(a1));
    expect(afterLoss.ok).toBe(true);
    expect(queen(afterLoss.state, 0, a1.queenId).owner).toBeUndefined();

    // A founded queen is not a starting queen, so no seat claims her.
    const founded = cloneState(start);
    const { starting: _starting, ...nonStarting } = queen(founded, 0, 0);
    founded.colonies[0].queens!.push({ ...nonStarting, id: 3 });
    const foundedJoin = joinAlone(founded, { ...seatJoin(a1), queenId: 3 } as SimInput);
    expect(foundedJoin.ok).toBe(true);
    expect(queen(foundedJoin.state, 0, 3).owner).toBeUndefined();
  });

  it("replaying the match log reproduces the same owners", () => {
    const { config, nests } = lobby();
    const a1 = nestOf(nests, "a1");
    const first = nests.filter(n => n !== a1).map(n => seatJoin(n));
    const late = [seatJoin(a1)];
    const LATE_TICK = 25, END = 60;
    const lines = [headerLine(SEED, config), tickLine(0, first), tickLine(LATE_TICK, late)];
    let live = createMatch(SEED, config);
    while (live.tick < END) live = step(live, live.tick === 0 ? first : live.tick === LATE_TICK ? late : []).state;
    const replayed = replay(lines, END);
    expect(stateHash(replayed)).toBe(stateHash(live));
    const owners = (state: SimState) => state.colonies.map(c => c.queens!.map(q => [q.id, q.owner ?? null]));
    expect(owners(replayed)).toEqual(owners(live));
    for (const nest of nests) expect(queen(replayed, nest.colony, nest.queenId).owner).toBe(agentOf(nest));
  });

});
