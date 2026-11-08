import { describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage, type StreamMessage, type StreamTerritoryWin } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { headline, territoryWinText } from "../../web/src/overlays.ts";
import { playable } from "../playable.ts";

const lead: StreamTerritoryWin = { colony: 0, startTick: 6000, winTick: 8999 };
function opening(tick = 6001, progress: StreamTerritoryWin | undefined = lead): StreamMessage {
  const recorder = new SpectatorRecorder(createMatch(99, playable(rulesConfig("redesign"))));
  const full = recorder.initialFull();
  if (progress !== undefined) full.territoryWin = { ...progress };
  return decodeMessage(encodePublicMessage({ ...recorder.initial(), tick, full }));
}
const show = (playback: Playback, frame: Frame, tick: number) => expect(playback.sample(tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);

it("can join mid-lead with no rules name or client-tracked history", () => {
  const message = opening(6601);
  expect(message.full!.setup.rules).toBeUndefined();
  const playback = new Playback(), frame = new Frame();
  playback.push(message, message.tick * TICK_MS); show(playback, frame, message.tick);
  expect(frame.board!.territoryWin).toEqual(lead);
  expect(territoryWinText(frame.board!, frame.tick)).toBe("Very Large Colony · win in 4:00");
});

it("uses streamed tick rate and win tick, with ceiling-to-second formatting at both boundaries", () => {
  const board = opening().full!;
  expect(territoryWinText(board, 6000)).toBeNull();
  expect(territoryWinText(board, 6001)).toBe("Very Large Colony · win in 5:00");
  expect(territoryWinText(board, 6010)).toBe("Very Large Colony · win in 4:59");
  expect(territoryWinText(board, 8999)).toBe("Very Large Colony · win in 0:01");
  expect(territoryWinText({ ...board, setup: { ...board.setup, ticksPerSecond: 20 }, territoryWin: { colony: 1, startTick: 0, winTick: 1239 } }, 1))
    .toBe("Lake Hodges Colony · win in 1:02");
});

// The sim's last step is matchTicks - 1, which decides a sustained lead
// before time-up (src/sim/step.ts); a win due after it never comes, because time-up ends the match first.
it("counts down to time-up instead, in the clock's figures, when the lead's win tick falls after the match's last step", () => {
  const board = opening().full!;
  const { matchTicks, ticksPerSecond: tps } = board.setup;
  // On the last step: still a win, as the server counts it.
  expect(territoryWinText({ ...board, territoryWin: { colony: 0, startTick: 6000, winTick: matchTicks - 1 } }, matchTicks - 10 * tps))
    .toBe("Very Large Colony · win in 0:10");
  // After it: time-up first, the time left as the clock rounds it (whole seconds, up).
  const late = { ...board, territoryWin: { colony: 1 as const, startTick: 6000, winTick: matchTicks } };
  expect(territoryWinText(late, matchTicks - 10 * tps)).toBe("Lake Hodges Colony · match ends in 0:10");
  expect(territoryWinText(late, matchTicks - 10 * tps + 1)).toBe("Lake Hodges Colony · match ends in 0:10");
  expect(territoryWinText(late, matchTicks - 1)).toBe("Lake Hodges Colony · match ends in 0:01");
  expect(territoryWinText(late, matchTicks)).toBe("Lake Hodges Colony · match ends in 0:00");
});

it("supplies truthful headline labels for ordinary, equal-boundary and later-than-match leads", () => {
  const board = opening().full!;
  const ordinary = { ...board, held: [900, 100] as [number, number], setup: { ...board.setup, matchTicks: 18000 } };
  expect(headline(ordinary, 6601)).toEqual({ leader: 0, label: "win in", figure: "4:00" });
  for (const winTick of [18000, 19000]) {
    const late = { ...ordinary, territoryWin: { colony: 1 as const, startTick: 6000, winTick } };
    expect(headline(late, 17900)).toEqual({ leader: 1, label: "match ends in", figure: "0:10" });
    expect(territoryWinText(late, 17900)).toBe("Lake Hodges Colony · match ends in 0:10");
    expect(headline({ ...late, setup: { ...late.setup, ticksPerSecond: 20 } }, 17900))
      .toEqual({ leader: 1, label: "match ends in", figure: "0:05" });
  }
});

it("shows no countdown for a legacy/absent field or a finished match", () => {
  const board = opening().full!;
  delete board.territoryWin;
  expect(territoryWinText(board, 6601)).toBeNull();
  expect(territoryWinText({ ...board, territoryWin: lead, result: { winner: 0, reason: "sustained_territory", decidedBy: "territory", tick: 8999, nextStartMs: null } }, 9000)).toBeNull();
});

it("applies lead changes/resets only on delayed playback and preserves earlier immutable boards", () => {
  const message = opening(), playback = new Playback(), frame = new Frame();
  playback.push(message, message.tick * TICK_MS); show(playback, frame, 6001);
  const earlier = frame.board!;
  const changed: StreamTerritoryWin = { colony: 1, startTick: 6001, winTick: 6450 };
  const delta = (tick: number, progress: StreamTerritoryWin | null): StreamMessage => decodeMessage(encodePublicMessage({ tick, ants: message.ants, full: null, events: [{ kind: "territoryWin", progress }] }));
  playback.push(delta(6002, changed), 6002 * TICK_MS);
  playback.push(delta(6003, null), 6003 * TICK_MS);
  show(playback, frame, 6001); expect(frame.board!.territoryWin).toEqual(lead);
  show(playback, frame, 6002); expect(frame.board!.territoryWin).toEqual(changed);
  const changedBoard = frame.board!;
  show(playback, frame, 6003); expect(frame.board!.territoryWin).toBeUndefined();
  expect(earlier.territoryWin).toEqual(lead); expect(changedBoard.territoryWin).toEqual(changed);
  // A full reconnect carries the exact new lead; one without the extension clears it.
  playback.push(opening(7000, { colony: 1, startTick: 6900, winTick: 7800 }), 7000 * TICK_MS);
  show(playback, frame, 7000); expect(frame.board!.territoryWin?.startTick).toBe(6900);
  const absent = opening(7001); delete absent.full!.territoryWin;
  playback.push(absent, 7001 * TICK_MS); show(playback, frame, 7001);
  expect(frame.board!.territoryWin).toBeUndefined();
});

describe("countdown source", () => {
  it("needs no territory share or rules value to decide qualification", () => {
    const board = opening().full!;
    // This is deliberately inconsistent ground: the client must not run another qualifying-lead evaluator.
    board.territory.fill(2);
    expect(territoryWinText(board, 6001)).toBe("Very Large Colony · win in 5:00");
  });
});
