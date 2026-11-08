/**
 * Each team's game history, derived on the page from the stream it receives (client-only; the wire is
 * unchanged). Every call event becomes one command with the order or mark its agent set in the same message; a live
 * viewer's commands start where they arrived (their first full snapshot) and a replay, fed from the start, has them all.
 */
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type StreamAgent, type StreamEvent, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { history } from "../../web/src/ui/deck/model.ts";

const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
const seat = (colony: 0 | 1, modelLabel: string): StreamAgent =>
  ({ colony, modelLabel, joinTick: 0, lastCallTick: 0, prevCallTick: 0, order: "forage", orderX: 0, orderY: 0, intent: "" });
/** Two against one: colony 0 holds agents 0 and 1, colony 1 agent 2. */
const full = (tick: number): StreamMessage => ({
  tick, ants, events: [],
  full: { setup: { mapW: 8, mapH: 8, gridScale: 2, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] },
    territory: new Uint8Array(64), marks: [], agents: [seat(0, "alpha"), seat(0, "beta"), seat(1, "gamma")], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], hatched: [0, 0], result: null },
});
const at = (tick: number, events: StreamEvent[]): StreamMessage => ({ tick, ants, full: null, events });
const mark = { id: 4, agent: 1, colony: 0 as const, tileX: 3, tileY: 3, words: [1, 2], laidTick: 20, answered: 0 };
const match: StreamMessage[] = [
  full(0),
  at(10, [{ kind: "call", agent: 0, call: "order", accepted: true }, { kind: "order", agent: 0, order: "go_to", tileX: 5, tileY: 5, intent: "scout east" }]),
  at(20, [{ kind: "call", agent: 1, call: "mark", accepted: true }, { kind: "mark", mark }, { kind: "call", agent: 2, call: "observe", accepted: true }]),
  at(30, [{ kind: "call", agent: 2, call: "order", accepted: false }]),
  at(40, [{ kind: "call", agent: 1, call: "order", accepted: true }, { kind: "order", agent: 1, order: "hold", tileX: 2, tileY: 2, intent: "" },
    { kind: "call", agent: 0, call: "order", accepted: true }, { kind: "order", agent: 0, order: "forage", tileX: 0, tileY: 0, intent: "" }]),
];

/** The page as a browser has it: each message through the wire format, then sampled at its delayed time. */
function watch(messages: readonly StreamMessage[]): Frame {
  const p = new Playback(), f = new Frame();
  for (const m of messages) {
    p.push(decodeMessage(encodeMessage(m)), m.tick * TICK_MS);
    p.sample(m.tick * TICK_MS + RENDER_DELAY_MS, f);
  }
  return f;
}

describe("the commands a page derives for its game history", () => {
  it("joins each call with the order or mark its agent set in the same message, two calls in one message each their own", () => {
    const f = watch(match);
    expect(f.commands.map(c => [c.tick, c.agent, c.colony, c.call, c.accepted, c.order?.kind ?? c.mark?.id ?? null])).toEqual([
      [10, 0, 0, "order", true, "go_to"],
      [20, 1, 0, "mark", true, 4],
      [20, 2, 1, "observe", true, null],
      [30, 2, 1, "order", false, null],
      [40, 1, 0, "order", true, "hold"],
      [40, 0, 0, "order", true, "forage"],
    ]);
    expect(f.commands[0]!.order!.intent).toBe("scout east");
  });

  it("a replay from the start has every command; a live viewer's begins where they arrived", () => {
    expect(watch(match).commands).toHaveLength(6);
    // A live joiner gets one full snapshot at the delayed position and no earlier events (src/live/hub.ts).
    const joined = watch([full(25), ...match.slice(3)]);
    expect(joined.commands.map(c => c.tick)).toEqual([30, 40, 40]);
  });

  it("shows only what playback has reached, and keeps the same array while nothing is added", () => {
    const p = new Playback(), f = new Frame();
    for (const m of match) p.push(decodeMessage(encodeMessage(m)), m.tick * TICK_MS);
    p.sample(20 * TICK_MS + RENDER_DELAY_MS, f);
    expect(f.commands.map(c => c.tick)).toEqual([10, 20, 20]);
    const shown = f.commands;
    p.sample(25 * TICK_MS + RENDER_DELAY_MS, f);
    expect(f.commands).toBe(shown);
    p.sample(40 * TICK_MS + RENDER_DELAY_MS, f);
    expect(f.commands).toHaveLength(6);
  });

  it("ties each team's history rows to the member who acted, without the observe, the refused order marked", () => {
    const f = watch(match);
    expect(history(f, 0).map(r => [r.when, r.member?.name, r.what, r.intent])).toEqual([
      ["0:04", "alpha", "forage", ""],
      ["0:04", "beta", "hold", ""],
      // A word mark reads as the agent's own words, quoted (words.ts markReading).
      ["0:02", "beta", expect.stringMatching(/^“\S.*”$/), ""],
      ["0:01", "alpha", "go to", "“scout east”"],
    ]);
    expect(history(f, 1).map(r => [r.when, r.member?.name, r.what, r.refused])).toEqual([["0:03", "gamma", "order", true]]);
  });
});
