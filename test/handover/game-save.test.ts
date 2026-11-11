// Save format and store, at Game level until resume and rejoin are
// in place: a Wide Plain match at 1,024 ants a side, captured at a tick,
// written to and read back from the handover store and restored into a fresh Game, continues exactly as
// the same match run uninterrupted (every tick's state hash, events and results, every call's answer and
// the result), including the hold behaviour the save records.
import { describe, expect, it } from "vitest";
import { createMatchSaves } from "../../src/handover/saveStore.js";
import { decodeGameSave, encodeGameSave, GAME_SAVE_FORMAT, type GameSave, type MatchGameSave } from "../../src/handover/matchSave.js";
import { Game, type Outcome } from "../../src/mcp/game.js";
import { stateHash } from "../../src/sim/log.js";
import type { SimInput, StepOutput } from "../../src/sim/types.js";
import { compareTicks } from "../tuning/equality.js";
import { memoryObjects, testFirestore, WIDE_SEATS, wideMatch, widePlainConfig } from "./helpers.js";

/**
 * The continuation test's Wide Plain match, cut to 300 ticks so it reaches its natural time_up result here,
 * and its fourth seat joins after the start yet within the idle limit, as a ranked seat must.
 */
const MATCH_TICKS = 300;

/** The same agent calls, by tick, for both games: one call every 10 ticks, rotating seats and kinds. */
function callAt(tick: number, agents: readonly string[]): SimInput | null {
  if (tick % 10 !== 0) return null;
  const turn = tick / 10;
  const agentId = agents[turn % agents.length]!;
  switch (turn % 5) {
    case 0: return { type: "observe", agentId };
    case 1: return { type: "order", agentId, order: { kind: "hold" } };
    case 2: return { type: "order", agentId, order: { kind: "attack", tileX: 128, tileY: 46 } };
    case 3: return { type: "order", agentId, order: { kind: "go_to", tileX: 100 + (turn % 50), tileY: 20 + (turn % 40) } };
    default: return { type: "order", agentId, order: { kind: "forage" } };
  }
}

/** One tick of a game with that tick's call, and the call's answer once the tick has settled it. */
async function play(game: Game, agents: readonly string[]): Promise<{ out: StepOutput | null; answer: Outcome | null }> {
  const input = callAt(game.match!.state.tick, agents);
  const answer = input === null ? null : game.call(input.agentId, input);
  const out = game.tick();
  return { out, answer: answer === null ? null : await answer };
}

/** A save of a running match; these tests save none in its nest-pick window (nest-pick-handover.test.ts does). */
function matchSave(save: GameSave): MatchGameSave {
  if (save.phase !== "match") throw new Error(`expected a match save, not a ${save.phase} save`);
  return save;
}

/** Each agent of the game's match with what it gave at join: what a resume must keep of its seats. */
function seats(game: Game) {
  return game.match!.state.agents.map(agent => ({ agentId: agent.id, ...game.agentInfo(agent.id) }));
}

function freshGame(clock: { now: number }, matchTicks?: number): Game {
  return new Game({ simConfig: widePlainConfig(matchTicks), now: () => clock.now, slot: { identityOf: async () => undefined, locate: async () => undefined } });
}

describe("handover game save at Game level (continuation)", () => {
  it("a Wide Plain match at 1,024 ants a side resumed from the store continues as the uninterrupted match to its result", async () => {
    const { game: original, agents: joined, clock } = await wideMatch({ seed: 11, matchTicks: MATCH_TICKS });
    const start = original.match!.state;
    expect([0, 1].map(colony => start.ants.filter(ant => ant.colony === colony).length)).toEqual([1024, 1024]);
    const agents = [...joined];
    for (let i = 0; i < 50; i++) {
      clock.now += 100;
      if (i === 20) {
        // The fourth seat joins the live match, so the save holds a seat admitted after the start too.
        const late = original.joinSeated(WIDE_SEATS[3]!.identityId, "test-model");
        expect((await play(original, agents)).out).not.toBeNull();
        agents.push((await late)!.agentId!);
        continue;
      }
      expect((await play(original, agents)).out).not.toBeNull();
    }
    expect(original.match!.state.agents).toHaveLength(4);

    const beforeHash = stateHash(original.match!.state), beforeAgents = seats(original);
    const game = matchSave(original.saveMatch());
    // Capturing changes nothing in the running match.
    expect(stateHash(original.match!.state)).toBe(beforeHash);
    expect(seats(original)).toEqual(beforeAgents);
    expect(game.tick).toBe(MATCH_TICKS - 250);
    expect(game.records.map(rec => rec.agentId)).toEqual(agents);

    const { store } = testFirestore();
    const saves = createMatchSaves(store, memoryObjects());
    await saves.write({ format: 1, lobbyId: "lobby-wide", revision: "rev-1", savedByRunId: "run-old", tick: game.tick, savedAt: clock.now, game, spectator: null });
    const read = await saves.read("lobby-wide");
    expect(read).not.toBeNull();
    expect(read!.game).toStrictEqual(game);
    expect(stateHash(matchSave(read!.game).state)).toBe(beforeHash);

    const resumed = freshGame(clock, MATCH_TICKS);
    resumed.resumeMatch(read!.game);
    expect(resumed.match!.state.tick).toBe(game.tick);
    expect(matchSave(read!.game).holdBehaviour).toBe("ant115");
    expect(seats(resumed)).toEqual(seats(original));

    let ticks = 0;
    for (;;) {
      clock.now += 100;
      const want = await play(original, agents), got = await play(resumed, agents);
      if (want.out === null) { expect(got.out).toBeNull(); break; }
      ticks += 1;
      expect(compareTicks(want.out, got.out!)).toBeNull();
      expect(stateHash(got.out!.state)).toBe(stateHash(want.out.state));
      expect(JSON.stringify(got.answer)).toBe(JSON.stringify(want.answer));
    }
    expect(ticks).toBe(250);
    expect(original.match!.result).toMatchObject({ reason: "time_up", tick: MATCH_TICKS - 1 });
    expect(resumed.match!.result).toEqual(original.match!.result);
  }, 300_000);


  it("a save before the first tick carries the seats queued for it", async () => {
    const { game: original, agents, clock } = await wideMatch({ seed: 12 });
    const game = matchSave(decodeGameSave(encodeGameSave(original.saveMatch())));
    expect(game.tick).toBe(0);
    expect(game.startJoins.map(input => input.agentId)).toEqual(agents);
    expect(game.records.map(rec => rec.agentId)).toEqual(agents);
    const resumed = freshGame(clock);
    resumed.resumeMatch(game);
    for (let i = 0; i < 3; i++) {
      clock.now += 100;
      const want = original.tick()!, got = resumed.tick()!;
      expect(compareTicks(want, got)).toBeNull();
    }
    expect(resumed.match!.state.agents.map(agent => agent.id)).toEqual(agents);
  }, 120_000);

  it("leaves out a seat whose join was not yet applied, so its next join on the resumed game seats it afresh", async () => {
    const { game: original, clock } = await wideMatch({ seed: 12 });
    clock.now += 100;
    original.tick();
    // The fourth seat's live join is waiting for the next tick when the match is saved.
    const late = original.joinSeated(WIDE_SEATS[3]!.identityId, "test-model");
    const game = matchSave(original.saveMatch());
    expect(game.startJoins).toEqual([]);
    expect(game.records.map(rec => rec.seatKey)).toEqual(WIDE_SEATS.slice(0, 3).map(seat => `lobby-wide/${seat.identityId}`));
    clock.now += 100;
    original.tick();
    const lateAgent = (await late)!.agentId!;

    const resumed = freshGame(clock);
    resumed.resumeMatch(game);
    const rejoin = resumed.joinSeated(WIDE_SEATS[3]!.identityId, "test-model");
    clock.now += 100;
    resumed.tick();
    const joined = (await rejoin)!;
    expect(joined.outcome.kind).toBe("view");
    expect(joined.agentId).not.toBe(lateAgent);
    expect(resumed.match!.state.agents).toHaveLength(4);
    // The saved pick-window result gives that seat the same starting queen its join got on the original.
    const queenOf = (game: Game, agentId: string) => game.match!.state.colonies[1].queens!.find(queen => queen.owner === agentId)?.id;
    expect(queenOf(original, lateAgent)).toBeDefined();
    expect(queenOf(resumed, joined.agentId!)).toBe(queenOf(original, lateAgent));
  }, 120_000);

  it("a save written before saves stopped carrying sawResult and one written after both resume the same match", async () => {
    const { game: original, agents, clock } = await wideMatch({ seed: 13 });
    for (let i = 0; i < 12; i++) {
      clock.now += 100;
      await play(original, agents);
    }
    const save = matchSave(original.saveMatch());
    expect(save.format).toBe(GAME_SAVE_FORMAT);
    expect(GAME_SAVE_FORMAT).toBe("antwar.game-save/1");
    expect(save.records.every(rec => !("sawResult" in rec))).toBe(true);
    // The earlier writer's records each carried sawResult; nothing reads it back.
    const earlier = { ...save, records: save.records.map(rec => ({ ...rec, sawResult: true })) };
    const games = [save, earlier].map(written => {
      const game = freshGame(clock);
      game.resumeMatch(decodeGameSave(encodeGameSave(written)));
      return game;
    });
    const [after, before] = games as [Game, Game];
    expect(stateHash(before.match!.state)).toBe(stateHash(after.match!.state));
    expect(seats(before)).toEqual(seats(after));
    expect(seats(after)).toEqual(seats(original));
    for (let i = 0; i < 12; i++) {
      clock.now += 100;
      const want = await play(after, agents), got = await play(before, agents);
      expect(compareTicks(want.out!, got.out!)).toBeNull();
      expect(JSON.stringify(got.answer)).toBe(JSON.stringify(want.answer));
    }
    // Saved again, the two write the same bytes: no sawResult carried forward.
    expect(encodeGameSave(before.saveMatch())).toEqual(encodeGameSave(after.saveMatch()));
  }, 120_000);
});
