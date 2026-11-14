/**
 * A four-colony match through the shared live and replay playback: each colony's held tiles, an elimination read
 * from the colony's queens that the match plays on past, and a same-tick end whose winner's queens retire with the
 * losers' and are never told as lost. Messages are built decoded, as the stream format reads them back.
 */
import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamFull, StreamMessage, StreamQueen, StreamResult } from "../../src/live/format.ts";
import { SUB_TILE, TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, TickPreparation, fallWindow, fallenColonies, fallenNests, fallenQueen, fallenQueenBox, type Board } from "../../web/src/buffer.ts";
import { queensUnderAttack, storyText } from "../../web/src/overlays.ts";
import { decisive } from "../../web/src/story.ts";

const W = 16, H = 16, HP = 5000;
/** One queen per colony, in the four corners. */
const NESTS = [[2, 2], [13, 2], [2, 13], [13, 13]] as const;
const at = (tile: number) => tile * SUB_TILE + SUB_TILE / 2;
const queen = (colony: number, lostTick: number | null = null, hp = HP): StreamQueen =>
  ({ id: 0, colony, x: at(NESTS[colony]![0]), y: at(NESTS[colony]![1]), foundedTick: 0, lostTick, overrun: 0, hp }) as StreamQueen;

/** Ants by colony, two each beside their nest: ids 1-8, colony c holding ids 2c+1 and 2c+2. */
function ants(colonies: readonly number[]): StreamMessage["ants"] {
  const list = colonies.flatMap((c) => [0, 1].map((k) => ({ id: 2 * c + k + 1, colony: c, x: at(NESTS[c]![0] + k), y: at(NESTS[c]![1]) })));
  return {
    count: list.length,
    id: Uint32Array.from(list.map((a) => a.id)),
    x: Uint16Array.from(list.map((a) => a.x)),
    y: Uint16Array.from(list.map((a) => a.y)),
    heading: new Uint8Array(list.length),
    colony: Uint8Array.from(list.map((a) => a.colony)),
    agent: new Int16Array(list.length).fill(-1),
  };
}

/** Tiles 0-9 held: colony 0 four, colony 1 three, colony 2 two, colony 3 one. */
function opening(): StreamMessage {
  const territory = new Uint8Array(W * H);
  territory.set([1, 1, 1, 1, 2, 2, 2, 3, 3, 4]);
  const store = { food: 0, nextHatchTick: 0, nextCost: 10 };
  // Four entries per colony field, as a four-colony full snapshot decodes; the two-entry types widen with the stream.
  const full = {
    match: 7,
    setup: { mapW: W, mapH: H, ticksPerSecond: 10, matchTicks: 600, idleTicks: 300, overrunRadiusTiles: 2, queens: NESTS.map(([x, y]) => [at(x), at(y)]) },
    queens: [0, 1, 2, 3].map((c) => queen(c)),
    hatched: [0, 0, 0, 0],
    territory,
    marks: [], agents: [], overrun: [0, 0, 0, 0], overrunRequired: 100, deaths: [0, 0, 0, 0], result: null,
    stores: [0, 1, 2, 3].map(() => ({ ...store })),
  } as unknown as StreamFull;
  return { tick: 0, ants: ants([0, 1, 2, 3]), full, events: [] };
}

const delta = (tick: number, colonies: readonly number[], events: StreamEvent[] = []): StreamMessage => ({ tick, ants: ants(colonies), full: null, events });
const territory = (tiles: number[], owner: number): StreamEvent => ({ kind: "territory", tiles, owners: tiles.map(() => owner) });
const lost = (colony: number, tick: number): StreamEvent => ({ kind: "queenLost", queen: queen(colony, tick, 0) });
const bite = (colony: number, hp: number) => ({ kind: "queenHp", colony, queenId: 0, hp }) as StreamEvent;
/** A same-tick all-idle end: every colony left on tick 5, colony 2 ranked first. */
const RESULT = { winner: 2, reason: "idle", decidedBy: "kills", tick: 5, nextStartMs: null } as unknown as StreamResult;

/**
 * The match: colony 3 takes the territory lead (tick 1), colony 1 is eliminated by its queen's death (tick 2), the
 * other three play on (ticks 3-4, colony 2's queen bitten at 4), and on tick 5 all three leave idle at once, colony 2
 * the winner.
 */
function match(): StreamMessage[] {
  return [
    opening(),
    delta(1, [0, 1, 2, 3], [territory([10, 11, 12, 13, 14, 15], 4), bite(1, 2000)]),
    // Removed, not killed: colony 1's ants leave the list with no death event, its tiles turn neutral.
    delta(2, [0, 2, 3], [bite(1, 0), lost(1, 2), territory([4, 5, 6], 0)]),
    delta(3, [0, 2, 3], [territory([16, 17], 1)]),
    delta(4, [0, 2, 3], [bite(2, 3000)]),
    delta(5, [], [lost(0, 5), lost(2, 5), lost(3, 5), territory([0, 1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], 0), { kind: "end", result: RESULT }]),
  ];
}

/** A recording's playback, sampled once each message is in, with the frame it drew. */
function recorded(messages: readonly StreamMessage[]) {
  const playback = new Playback();
  const frames: { tick: number; board: Board; frame: Frame }[] = [];
  for (const m of messages) {
    playback.push(m, m.tick * TICK_MS);
    const frame = new Frame();
    expect(playback.sample(1e9, frame)).toBe(true);
    frames.push({ tick: m.tick, board: frame.board!, frame });
  }
  return frames;
}

/** What playback holds of a board that the views read for colonies, territory, eliminations and the result. */
const reading = (b: Board) => ({ colonies: b.setup.queens.length, held: b.held, fallen: fallenColonies(b), queens: b.queens?.map((q) => [q.colony, q.lostTick]), result: b.result });

describe("four-colony playback", () => {
  it("holds each colony's tiles, one count per colony, and none once every tile is neutral", () => {
    expect(recorded(match()).map(({ board }) => board.held)).toEqual([
      [4, 3, 2, 1],
      [4, 3, 2, 7],
      [4, 0, 2, 7],
      [6, 0, 2, 7],
      [6, 0, 2, 7],
      [0, 0, 0, 0],
    ]);
  });

  it("knows an eliminated colony from its queens and plays on for the others", () => {
    // Up to the tick before the end: entries settle in place, so a later end would settle the attack still under way.
    const frames = recorded(match().slice(0, 5));
    const [, , eliminated, , later] = frames;
    expect(fallenColonies(eliminated!.board)).toEqual([false, true, false, false]);
    // No fall: the window, the framed nests and the fallen queen are the two-colony match's ending, not an elimination's.
    for (const { frame, board } of frames.slice(2, 5)) {
      expect(fallWindow(frame)).toEqual([false, false, false, false]);
      expect(fallenQueen(board)).toBeNull();
      expect(fallenNests(board)).toBeNull();
      expect(fallenQueenBox(board)).toBeNull();
      expect(board.result).toBeNull();
    }
    expect(later!.frame.tick).toBe(4);
    expect(later!.frame.count).toBe(6);
    // The colony's ants were removed, not killed: no corpse marks them.
    expect(frames.flatMap(({ frame }) => frame.corpses)).toEqual([]);
    const story = later!.frame.story.map((e) => [e.kind, e.colony, e.tick, e.outcome]);
    expect(story).toEqual([
      ["queen_attack", 1, 1, "took"],
      ["lead", 3, 1, undefined],
      ["queen_lost", 1, 3, undefined],
      ["queen_attack", 2, 4, undefined],
    ]);
  });

  it("never tells the winner of a same-tick end as lost or eliminated", () => {
    // One more message lets playback reach the tick after the end, where the losses on it are told.
    const end = recorded([...match(), delta(6, [])]).at(-1)!;
    expect(end.board.result).toEqual(RESULT);
    expect(fallenColonies(end.board)).toEqual([true, true, false, true]);
    expect(fallWindow(end.frame)).toEqual([false, false, false, false]);
    const story = end.frame.story;
    expect(story.filter((e) => e.kind === "queen_lost").map((e) => e.colony)).toEqual([1, 0, 3]);
    // The attack on the winner's queen was under way at the end: unfinished, not a queen taken.
    expect(story.find((e) => e.kind === "queen_attack" && e.colony === 2)).toMatchObject({ endTick: 5, outcome: "unfinished" });
    expect(decisive(story, RESULT.reason, RESULT.winner).map((e) => e.colony)).toEqual([1]);
  });

  it("plays a recording through the same boards as the live page's prepared ticks", () => {
    const messages = match();
    const replay = new Playback();
    const live = new Playback({ live: true });
    const preparation = new TickPreparation();
    for (const m of messages) {
      replay.push(m, m.tick * TICK_MS);
      live.pushPrepared(preparation.prepare(m)!, m.tick * TICK_MS);
      expect(reading(live.latestBoard!)).toEqual(reading(replay.latestBoard!));
    }
    expect(reading(live.latestBoard!)).toMatchObject({ colonies: 4, held: [0, 0, 0, 0], fallen: [true, true, false, true], result: RESULT });
  });

  it("names an overrun attempt's target colony where it is not simply the other colony", () => {
    const names = ["North", "East", "South", "West"] as unknown as Parameters<typeof storyText>[5];
    const attempt = { id: 1, kind: "overrun" as const, tick: 3, colony: 3, target: 1, agent: -1, x: 13, y: 2, queenId: 0 };
    expect(storyText(attempt, [], 3, [], false, names).what).toBe("Overrun attempt on the East queen — under way");
    expect([...queensUnderAttack([attempt], 3)]).toEqual(["1:0"]);
  });
});

describe("two-colony fall unchanged", () => {
  it("reads both colonies fallen when both last queens die on one tick, winner or not", () => {
    const queens = [queen(0, 9), queen(1, 9)];
    const result = { winner: 0, reason: "queens_killed", decidedBy: "kills", tick: 9, nextStartMs: null } as StreamResult;
    expect(fallenColonies({ queens, result })).toEqual([true, true]);
    expect(fallenColonies({ queens: [queen(0)] })).toEqual([false, false]);
  });
});
