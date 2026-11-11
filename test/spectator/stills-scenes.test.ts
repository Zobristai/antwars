/**
 * The stills' scenes follow the recording's own moments (web/capture/moments.ts), so the
 * box renders a mark with its owner, the colonies in action, a queen under attack, a colony's fall
 * and the result from whatever match it is given, and reports a moment the recording never reaches.
 */
import { describe, expect, it, vi } from "vitest";
import { EARLY_WIN_STREAM_VERSION, decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { resultHow } from "../../web/src/story.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { Frame, HIT_FLASH_MS, MARK_LIFE_MS, Playback, QUEEN_COLLAPSE_MS, RENDER_DELAY_MS, RESULT_BEAT_MS } from "../../web/src/buffer.ts";
import { clockAt, matchEnd, sceneMoments, squadTapCandidates, squadTapMoment } from "../../web/capture/moments.ts";
import { playRedesign } from "./redesign-recording.ts";
import type { StreamAnts, StreamMark, StreamMessage } from "../../src/live/format.ts";
import { SUB_TILE, TICK_MS } from "../../src/live/snapshot.ts";
import { playable } from "../playable.ts";

vi.setConfig({ testTimeout: 60_000 });

describe("the stills' moments", () => {
  it("are read from a redesign recording: marks laid, the busiest bites, the lowest bite on a living queen, the first fall and the end", () => {
    const messages = playRedesign({ seed: 6014, agents: 9, ticks: 4000 });
    const m = sceneMoments(messages);
    const markTicks = messages.flatMap((x) => x.events.filter((e) => e.kind === "mark").map(() => x.tick));
    expect(m.mark).toBe(markTicks[5]! + 15);
    const fights = messages.map((x) => x.events.filter((e) => e.kind === "fight").length);
    expect(m.action).toBe(messages[fights.indexOf(Math.max(...fights))]!.tick);
    const fall = messages.find((x) => x.events.some((e) => e.kind === "queenLost"))!.tick;
    // The queen about to fall, bitten (her HP dropping, still alive) at least 2 s before her colony falls, one tick on,
    // so the flash is bright and her HP is seen falling with the fall still to come.
    const lost = (messages.flatMap((x) => x.events).find((e) => e.kind === "queenLost") as { queen: { colony: number; id: number } }).queen;
    const seen = new Map<string, number>();
    const drops: number[] = [];
    for (const x of messages) {
      for (const e of x.events) {
        if (e.kind !== "queenHp") continue;
        const key = `${e.colony}:${e.queenId}`;
        const before = seen.get(key);
        if (before !== undefined && e.hp < before && e.hp > 0 && e.colony === lost.colony && e.queenId === lost.id && x.tick < fall) drops.push(x.tick);
        seen.set(key, e.hp);
      }
    }
    expect(drops.length).toBeGreaterThan(0);
    expect(m.attack).toBe((drops.filter((t) => t <= fall - 20).at(-1) ?? drops.at(-1))! + 1);
    expect(m.fall).toBe(fall + Math.max(1, Math.round(QUEEN_COLLAPSE_MS / 100 / 2)));
    const end = messages.find((x) => x.events.some((e) => e.kind === "end"))!.tick;
    expect(m.result).toBe(end + (RESULT_BEAT_MS + HIT_FLASH_MS) / 100);
    // The moments before the fall lie within the match; the fall and result run on past its last message, as the client does.
    for (const t of [m.mark, m.action, m.attack]) expect(t).toBeLessThanOrEqual(messages.at(-1)!.tick);
    expect(m.fall).toBeGreaterThan(messages.at(-1)!.tick);
    expect(m.mark).toBeLessThan(m.attack!);
    expect(m.attack).toBeLessThan(m.fall!);
    expect(clockAt(m.fall!, RENDER_DELAY_MS)).toBe(RENDER_DELAY_MS + m.fall! * 100);
    // The squad tap: at its tick the agent's squad is the largest of any, and one of its ants
    // stands on the tile of a mark it laid, or a tile adjacent to it.
    const tap = squadTapMoment(messages, m.action!)!;
    expect(tap).not.toBeNull();
    const at = messages.find((x) => x.tick === tap.tick)!;
    const sizes = new Map<number, number>();
    for (let i = 0; i < at.ants.count; i++) if (at.ants.agent[i]! >= 0) sizes.set(at.ants.agent[i]!, (sizes.get(at.ants.agent[i]!) ?? 0) + 1);
    expect(sizes.get(tap.agent)).toBe(tap.squad);
    expect(Math.max(...sizes.values())).toBe(tap.squad);
    const laid = messages.filter((x) => x.tick <= tap.tick).flatMap((x) => x.events.flatMap((e) => (e.kind === "mark" && e.mark.agent === tap.agent ? [[e.mark.tileX, e.mark.tileY]] : [])));
    const tiles = Array.from({ length: at.ants.count }, (_, i) => i).filter((i) => at.ants.agent[i] === tap.agent).map((i) => [Math.floor(at.ants.x[i]! / SUB_TILE), Math.floor(at.ants.y[i]! / SUB_TILE)]);
    expect(tiles.some(([tx, ty]) => laid.some(([mx, my]) => Math.abs(mx! - tx!) <= 1 && Math.abs(my! - ty!) <= 1))).toBe(true);
  });

  // Regression caught by design: the tap drifting to the first agent, to a smaller squad, to a tick where its ant
  // stands on another agent's mark, two tiles from its own, or on a mark gone or faded from the board, or away from
  // the action.
  it("choose the squad tap: the tick nearest the action at which the agent with the largest squad has an ant on or beside the tile of a mark of its own still on the board", () => {
    const ants = (list: [agent: number, tileX: number, tileY: number][]): StreamAnts => ({
      count: list.length,
      id: Uint32Array.from(list, (_, i) => i + 1),
      x: Uint16Array.from(list, ([, tx]) => tx * SUB_TILE + 100),
      y: Uint16Array.from(list, ([, , ty]) => ty * SUB_TILE + 200),
      heading: new Uint8Array(list.length),
      colony: new Uint8Array(list.length),
      agent: Int16Array.from(list, ([a]) => a),
    });
    const markOf = (id: number, agent: number, tileX: number, tileY: number, laidTick: number): StreamMark => ({ id, agent, colony: 0, tileX, tileY, words: [], laidTick, answered: 0 });
    const squad = (agent: number, n: number, first: [number, number], rest: [number, number] = [50, 40]): [number, number, number][] => Array.from({ length: n }, (_, i): [number, number, number] => (i === 0 ? [agent, ...first] : [agent, ...rest]));
    const full = { setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 300, overrunRadiusTiles: 2, queens: [[2176, 6272], [14208, 6272]] as [[number, number], [number, number]], rules: "redesign" as const }, queens: [], territory: new Uint8Array(0), marks: [markOf(1, 0, 10, 10, 0)], agents: [], overrun: [0, 0] as [number, number], overrunRequired: 100, deaths: [0, 0] as [number, number], result: null };
    const at = (tick: number, a: StreamAnts, events: StreamMessage["events"] = []): StreamMessage => ({ tick, ants: a, full: null, events });
    const messages: StreamMessage[] = [
      { tick: 0, ants: ants([]), full, events: [] },
      // Agent 1's squad is the largest, but no ant of its stands on a mark of its own; agent 0's ant on its mark is not the largest squad.
      at(10, ants([...squad(0, 3, [10, 10]), ...squad(1, 5, [20, 20])])),
      // Agent 1 lays a mark; its ant stands on agent 0's mark: not its own.
      at(20, ants(squad(1, 5, [10, 10])), [{ kind: "mark", mark: markOf(2, 1, 20, 20, 20) }]),
      // The first qualifying tick: agent 1, 4 ants, one on its own mark.
      at(30, ants(squad(1, 4, [20, 20]))),
      // Its mark gone: 6 ants on the tile count for nothing.
      at(40, ants(squad(1, 6, [20, 20])), [{ kind: "markGone", markId: 2 }]),
      // Agent 0, 6 ants, one on a tile diagonally beside its mark from the first snapshot: adjacent counts.
      at(50, ants(squad(0, 6, [11, 11]))),
      at(60, ants(squad(0, 6, [10, 10]))),
      // Two agents tied for the largest squad: the lowest index does not qualify (its ant two tiles from its mark), the next does.
      at(70, ants([...squad(0, 7, [12, 10]), ...squad(1, 7, [30, 30])]), [{ kind: "mark", mark: markOf(3, 1, 30, 30, 70) }]),
      // Agent 0's mark from the first snapshot has faded (MARK_LIFE_MS): 8 ants on its tile count for nothing.
      at(MARK_LIFE_MS / 100, ants(squad(0, 8, [10, 10]))),
    ];
    // The qualifying ticks are 30, 50, 60 and 70: the nearest to the action is taken, the earlier of two as near.
    expect(squadTapMoment(messages, 45)).toEqual({ tick: 50, agent: 0, squad: 6 });
    expect(squadTapMoment(messages, 40)).toEqual({ tick: 30, agent: 1, squad: 4 });
    expect(squadTapMoment(messages, 65)).toEqual({ tick: 60, agent: 0, squad: 6 });
    expect(squadTapMoment(messages, 70)).toEqual({ tick: 70, agent: 1, squad: 7 });
    expect(squadTapMoment(messages, 10)).toEqual({ tick: 30, agent: 1, squad: 4 });
    expect(squadTapMoment(messages, MARK_LIFE_MS / 100)).toEqual({ tick: 70, agent: 1, squad: 7 });
    expect(squadTapMoment(messages.slice(0, 3), 20)).toBeNull();
    expect(squadTapMoment([], 0)).toBeNull();
    // Every qualifying tick, nearest the action first (the earlier of two as near), capped: the stills try them in
    // turn on each viewport, where the ant must also stand on the uncovered board.
    expect(squadTapCandidates(messages, 45).map((c) => c.tick)).toEqual([50, 30, 60, 70]);
    expect(squadTapCandidates(messages, 45, 2)).toEqual([
      { tick: 50, agent: 0, squad: 6 },
      { tick: 30, agent: 1, squad: 4 },
    ]);
    expect(squadTapCandidates(messages.slice(0, 3), 20)).toEqual([]);
  });

  // Regression caught in the db23bd5 stills: the fall recording, captured mid-match, was stepped from tick 0, so its
  // attack, fall and result scenes all landed on its last message, byte-identical, with no queen under attack.
  it("step a recording captured mid-match to its own ticks: the clock counts from its first message's tick, as the client plays it", () => {
    // The scripted match ends at tick 975 (seed 6014 since opening food moved to the start ants' fine row, where seed 6013 no longer reaches a fall; seed 6006 had both queens bitten at once and the match over by 640): captured from tick 600 on, as the capture host's fall recording was captured mid-match.
    const messages = playRedesign({ seed: 6014, agents: 9, ticks: 4000, startAt: 600 });
    expect(messages[0]!.tick).toBe(600);
    expect(messages[0]!.full).not.toBeNull();
    expect(messages.at(-1)!.tick).toBeGreaterThan(900);
    // As web/src/main.ts feeds a recording: message i arrives at i × TICK_MS.
    const playback = new Playback();
    messages.forEach((m, i) => playback.push(m, i * TICK_MS));
    const frame = new Frame();
    for (const t of [600, 700, 900]) {
      playback.sample(clockAt(t, RENDER_DELAY_MS, 600), frame);
      expect(frame.renderMs).toBe(t * TICK_MS);
      expect(playback.underrun(clockAt(t, RENDER_DELAY_MS, 600))).toBe(false);
    }
    // A zero-origin clock shifts every scene by the capture's first tick. Rocks may lengthen the match,
    // so demonstrate the final scene's overshoot without assuming it ends before shifted scene 700.
    playback.sample(clockAt(700, RENDER_DELAY_MS), frame);
    expect(frame.renderMs).toBe(Math.min(700 + messages[0]!.tick, messages.at(-1)!.tick) * TICK_MS);
    playback.sample(clockAt(messages.at(-1)!.tick, RENDER_DELAY_MS), frame);
    expect(frame.renderMs).toBe(messages.at(-1)!.tick * TICK_MS);
    expect(clockAt(13712, RENDER_DELAY_MS, 11780)).toBe(RENDER_DELAY_MS + (13712 - 11780) * TICK_MS);
    expect(clockAt(835, RENDER_DELAY_MS)).toBe(RENDER_DELAY_MS + 835 * TICK_MS);
  });

  // Regression caught: the fall scene landing on a founded queen's death while her colony still stands.
  it("take the fall from the loss that leaves a colony with no standing queen, not an earlier queen's", () => {
    const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
    const queen = (colony: 0 | 1, id: number, lostTick: number | null = null) => ({ id, colony, x: 2176, y: 6272, foundedTick: 0, lostTick, overrun: 0, hp: 40_000 });
    const full = { setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 300, overrunRadiusTiles: 2, queens: [[2176, 6272], [14208, 6272]] as [[number, number], [number, number]], rules: "redesign" as const }, queens: [queen(0, 0), queen(1, 0)], territory: new Uint8Array(0), marks: [], agents: [], overrun: [0, 0] as [number, number], overrunRequired: 100, deaths: [0, 0] as [number, number], result: null };
    const messages: StreamMessage[] = [
      { tick: 0, ants, full, events: [] },
      { tick: 100, ants, full: null, events: [{ kind: "queenFounded", queen: queen(1, 1) }] },
      { tick: 200, ants, full: null, events: [{ kind: "queenLost", queen: queen(1, 1, 199) }] },
      { tick: 300, ants, full: null, events: [{ kind: "queenLost", queen: queen(1, 0, 299) }, { kind: "end", result: { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: 299, nextStartMs: null } }] },
    ];
    const m = sceneMoments(messages);
    expect(m.fall).toBe(300 + Math.max(1, Math.round(QUEEN_COLLAPSE_MS / 100 / 2)));
    expect(m.result).toBe(300 + (RESULT_BEAT_MS + HIT_FLASH_MS) / 100);
    // The end itself, for the early-end scene: the message tick and the stream's own reason.
    expect(matchEnd(messages)).toEqual({ tick: 300, reason: "queens_killed", decidedBy: "queens_killed", winner: 0 });
    expect(matchEnd(messages.slice(0, 3))).toBeNull();
  });

  // The early end: the capture host's early-cdf2877-s7003 is a version-9 recording (main 069957e), which the
  // client and the stills decode through the shared format; its scene reads the stream's reason in the page's words.
  it("read an early end from a version-9 recording: the stream's reason, no fall, and main's words for it on the result card", () => {
    const played = playRedesign({ seed: 6014, agents: 9, ticks: 4000 });
    const before = played.slice(0, played.findIndex((x) => x.events.some((e) => e.kind === "queenLost")));
    const last = before.at(-1)!;
    const result = { winner: 1 as const, reason: "sustained_territory" as const, decidedBy: "territory" as const, tick: last.tick, nextStartMs: null };
    const bytes = encodeMessage({ tick: last.tick + 1, ants: last.ants, full: null, events: [{ kind: "end", result }] });
    expect(bytes[2]).toBe(EARLY_WIN_STREAM_VERSION);
    const messages = [...before, decodeMessage(bytes)];
    const m = sceneMoments(messages);
    expect(m.fall).toBeNull();
    expect(m.result).not.toBeNull();
    const end = matchEnd(messages);
    expect(end).toEqual({ tick: last.tick + 1, reason: "sustained_territory", decidedBy: "territory", winner: 1 });
    expect(resultHow(end!, true)).toBe("Sustained territory lead");
  });

  it("report the moments a recording never reaches: no bite, fall or end in a short match on the overrun rules", () => {
    const messages = recordLog(playScripted({ seed: 6007, config: playable(DEFAULT_CONFIG), agents: 6, ticks: 300, attack: true }).lines, 300).map((b) => decodeMessage(b));
    const m = sceneMoments(messages);
    expect(m.mark).not.toBeNull();
    // No bite between ants yet (the combat grace): the colonies at work around their newest mark.
    const marks = messages.flatMap((x) => x.events.filter((e) => e.kind === "mark").map(() => x.tick));
    expect(m.action).toBe(Math.min(300, marks.at(-1)! + 15));
    expect(m.attack).toBeNull();
    expect(m.fall).toBeNull();
    expect(m.result).toBeNull();
    expect(sceneMoments([])).toEqual({ mark: null, action: null, attack: null, fall: null, result: null });
  });
});
