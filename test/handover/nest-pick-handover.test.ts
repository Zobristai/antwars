// Save and resume, narrowed to a begun match whose nest-pick start is still open, before its
// first tick, at Game level: the open start saved by the handover's save step, written to
// and read back from the store, and resumed by a fresh Game, reopens its pick window with the picks made
// so far, the seats queued for the first tick and the time the window had left; from there, given the same
// inputs, it starts the same match, and every tick's state hash, events and answers and the result equal
// those of the same match run uninterrupted, including its hold behaviour, on Wide Plain at 1,024
// ants a side. The save step is the same for both triggers (supersession and the shutdown signal).
import { describe, expect, it } from "vitest";
import { createMatchSaves } from "../../src/handover/saveStore.js";
import { decodeGameSave, encodeGameSave, type StartGameSave } from "../../src/handover/matchSave.js";
import { Game, type Outcome } from "../../src/mcp/game.js";
import { holdBehaviour } from "../../src/sim/holdBehaviour.js";
import { stateHash } from "../../src/sim/log.js";
import type { SimInput, StepOutput } from "../../src/sim/types.js";
import { compareTicks } from "../tuning/equality.js";
import { fillToCap, memoryObjects, testFirestore, WIDE_SEATS, widePlainConfig } from "./helpers.js";

const WINDOW_MS = 120_000;
const MATCH_TICKS = 36_000;

function slotGame(clock: { now: number }): Game {
  return new Game({ simConfig: widePlainConfig(), startPickWindowMs: WINDOW_MS, now: () => clock.now,
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
}

/** The nth free tile of the agent's start box, not taken by a teammate's pick. */
function freeTile(game: Game, agentId: string, nth: number): { tileX: number; tileY: number } {
  const view = game.nestSelection(agentId, true)!;
  const taken = new Set(view.picks.filter(pick => !pick.mine).map(pick => `${pick.tileX},${pick.tileY}`));
  const free: { tileX: number; tileY: number }[] = [];
  view.terrain!.rows.forEach((row, dy) => [...row].forEach((cell, dx) => {
    const tile = { tileX: view.box.x + dx, tileY: view.box.y + dy };
    if (cell === "." && !taken.has(`${tile.tileX},${tile.tileY}`)) free.push(tile);
  }));
  return free[nth]!;
}

async function joinAndPick(game: Game, seat: number, nth: number): Promise<string> {
  const joined = (await game.joinSeated(WIDE_SEATS[seat]!.identityId, "test-model"))!;
  expect(joined.outcome.kind).toBe("queued");
  const tile = freeTile(game, joined.agentId!, nth);
  expect(game.pickNest(joined.agentId!, tile.tileX, tile.tileY)).toEqual({ ok: true });
  return joined.agentId!;
}

/** The same agent calls, by tick, for both games: one call every 10 ticks, rotating seats and kinds. */
function callAt(tick: number, agents: readonly string[]): SimInput | null {
  if (tick % 10 !== 0) return null;
  const turn = tick / 10;
  const agentId = agents[turn % agents.length]!;
  switch (turn % 4) {
    case 0: return { type: "observe", agentId };
    case 1: return { type: "order", agentId, order: { kind: "attack", tileX: 128, tileY: 46 } };
    case 2: return { type: "order", agentId, order: { kind: "go_to", tileX: 100 + (turn % 50), tileY: 20 + (turn % 40) } };
    default: return { type: "order", agentId, order: { kind: "forage" } };
  }
}

async function play(game: Game, agents: readonly string[]): Promise<{ out: StepOutput | null; answer: Outcome | null }> {
  const input = callAt(game.match!.state.tick, agents);
  const answer = input === null ? null : game.call(input.agentId, input);
  const out = game.tick();
  return { out, answer: answer === null ? null : await answer };
}

/**
 * The saving server's open start 30 s into its window: two seats joined and picked, a third joined but
 * has not picked, the fourth has not joined. (An agent id is drawn when a seat first joins, so only seats
 * that joined before the save can make the same calls on both servers.)
 */
async function openStart(seed: number): Promise<{ game: Game; clock: { now: number }; agents: string[] }> {
  const clock = { now: 1_000 };
  const game = slotGame(clock);
  game.seatLobby("lobby-wide", WIDE_SEATS, "2v2");
  game.beginLobbyStart(seed);
  clock.now += 10_000;
  const agents = [await joinAndPick(game, 0, 3), await joinAndPick(game, 2, 5)];
  const third = (await game.joinSeated(WIDE_SEATS[1]!.identityId, "test-model"))!;
  expect(third.outcome.kind).toBe("queued");
  agents.push(third.agentId!);
  clock.now += 20_000;
  return { game, clock, agents };
}

describe("handover save and resume during the nest-pick start (nest-pick window)", () => {
  it("an open start saved, stored and resumed reopens its window with its picks, queued seats and remaining time", async () => {
    const { game: original, clock, agents } = await openStart(21);
    const before = original.openStart!;
    expect(original.match).toBeNull();
    const save = original.saveMatch() as StartGameSave;
    // Capturing changes nothing in the open start.
    expect(original.openStart).toEqual(before);
    expect(save).toMatchObject({ phase: "start", tick: 0, seed: 21, lobby: { id: "lobby-wide", mode: "2v2" } });
    expect(save.start.remainingMs).toBe(WINDOW_MS - 30_000);
    expect(save.start.picks).toHaveLength(2);
    expect(save.start.picks.map(pick => pick[0]).sort()).toEqual(["east-a", "west-a"]);
    expect(save.records.map(rec => rec.agentId)).toEqual(agents);

    const { store } = testFirestore();
    const saves = createMatchSaves(store, memoryObjects());
    await saves.write({ format: 1, lobbyId: "lobby-wide", revision: "rev-1", savedByRunId: "run-old", tick: save.tick, savedAt: clock.now, game: save, spectator: null });
    const read = (await saves.read("lobby-wide"))!;
    expect(read.game).toStrictEqual(save);

    // The successor restores it after the handover's pause; the window runs on for the time it had left.
    const later = { now: clock.now + 25_000 };
    const resumed = slotGame(later);
    resumed.resumeMatch(read.game);
    expect(resumed.match).toBeNull();
    expect(resumed.openStart).toEqual({ lobbyId: "lobby-wide", seed: 21, closesAt: later.now + WINDOW_MS - 30_000 });
    expect(resumed.nextStart).toEqual({ kind: "scheduled", at: new Date(later.now + WINDOW_MS - 30_000) });
    // A seat that joined on the old server rejoins by its key as the same agent, still queued, with its pick.
    const rejoined = (await resumed.joinSeated(WIDE_SEATS[0]!.identityId, "test-model"))!;
    expect(rejoined).toMatchObject({ agentId: agents[0], outcome: { kind: "queued" } });
    expect(resumed.nestSelection(agents[0]!)!.picks).toEqual(original.nestSelection(agents[0]!)!.picks);
    expect(resumed.nestSelection(agents[0]!)!.closesAt).toBe(later.now + WINDOW_MS - 30_000);
    // The saved window refuses nothing it accepted: a save holds only accepted picks.
    expect(() => decodeGameSave(encodeGameSave(save))).not.toThrow();
  });

  it("resumed in its window, the match starts and plays on exactly as the uninterrupted match to its result", async () => {
    const { game: original, clock, agents } = await openStart(22);
    // The fourth seat joins in the window too: with the match moved past the idle limit below, a ranked
    // seat that has not joined would end it abandoned, unrated, at its first tick.
    const fourth = (await original.joinSeated(WIDE_SEATS[3]!.identityId, "test-model"))!;
    expect(fourth.outcome.kind).toBe("queued");
    agents.push(fourth.agentId!);
    const save = decodeGameSave(encodeGameSave(original.saveMatch())) as StartGameSave;
    const later = { now: clock.now + 25_000 };
    const resumed = slotGame(later);
    resumed.resumeMatch(save);

    // The same inputs on both servers for the rest of the window: the third seat picks, a pick moves.
    const finish = (game: Game, at: { now: number }): void => {
      at.now += 5_000;
      const picked = freeTile(game, agents[2]!, 7);
      expect(game.pickNest(agents[2]!, picked.tileX, picked.tileY)).toEqual({ ok: true });
      const moved = freeTile(game, agents[1]!, 9);
      expect(game.pickNest(agents[1]!, moved.tileX, moved.tileY)).toEqual({ ok: true });
      at.now = game.openStart!.closesAt;
      game.finishLobbyStart();
    };
    finish(original, clock);
    finish(resumed, later);

    // The same match starts: the same tick-zero state, starting queens and first-tick joins.
    expect(stateHash(resumed.match!.state)).toBe(stateHash(original.match!.state));
    expect(holdBehaviour(resumed.match!.state.config)).toBe("ant115");

    // From there on Wide Plain at 1,024 ants a side, moved near the end so it reaches its natural result
    // (as helpers.ts wideMatch does), the same for both before their first tick.
    for (const game of [original, resumed]) {
      fillToCap(game.match!.state);
      game.match!.state.tick = MATCH_TICKS - 300;
    }
    expect([0, 1].map(colony => resumed.match!.state.ants.filter(ant => ant.colony === colony).length)).toEqual([1024, 1024]);
    let ticks = 0;
    for (;;) {
      clock.now += 100; later.now += 100;
      const want = await play(original, agents), got = await play(resumed, agents);
      if (want.out === null) { expect(got.out).toBeNull(); break; }
      ticks += 1;
      expect(compareTicks(want.out, got.out!)).toBeNull();
      expect(stateHash(got.out!.state)).toBe(stateHash(want.out.state));
      expect(JSON.stringify(got.answer)).toBe(JSON.stringify(want.answer));
    }
    expect(ticks).toBe(300);
    // The seats queued in the window joined on the first tick, alike.
    expect(resumed.match!.state.agents.map(agent => agent.id)).toEqual(agents);
    expect(original.match!.result).toMatchObject({ reason: "time_up", tick: MATCH_TICKS - 1 });
    expect(resumed.match!.result).toEqual(original.match!.result);
  }, 300_000);

  it("a window saved after its time ran out reopens for the shortest window and finishes at once", async () => {
    const { game: original, clock } = await openStart(23);
    clock.now = original.openStart!.closesAt;
    const save = original.saveMatch() as StartGameSave;
    expect(save.start.remainingMs).toBe(0);
    const later = { now: clock.now + 25_000 };
    const resumed = slotGame(later);
    resumed.resumeMatch(save);
    later.now = resumed.openStart!.closesAt;
    expect(later.now - (clock.now + 25_000)).toBe(1);
    resumed.finishLobbyStart();
    clock.now += 0;
    original.finishLobbyStart();
    expect(stateHash(resumed.match!.state)).toBe(stateHash(original.match!.state));
  });

  it("only an open start of the seated lobby is saved as a start; with none, and no running match, nothing is saved", () => {
    const clock = { now: 1_000 };
    const game = slotGame(clock);
    expect(game.openStart).toBeNull();
    expect(() => game.saveMatch()).toThrow("No running match to save");
    game.seatLobby("lobby-wide", WIDE_SEATS, "2v2");
    expect(game.openStart).toBeNull();
    game.beginLobbyStart(24);
    expect(game.openStart).not.toBeNull();
    game.endNotPlayed();
    expect(game.openStart).toBeNull();
  });
});
