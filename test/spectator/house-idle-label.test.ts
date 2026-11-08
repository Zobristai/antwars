import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { packMessages, TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { agentEntries } from "../../web/src/ui/hud-model.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";

function opening(houseIdleTicks?: number): StreamMessage {
  const state = step(createMatch(436, playable({ ...HISTORICAL_CONFIG, commandIdleTicks: 3, startAnts: 0 })),
    [{ type: "join", agentId: "private-seat", modelLabel: "observing" }]).state;
  const recorder = new SpectatorRecorder(state, { rated: true,
    ...(houseIdleTicks === undefined ? {} : { houseIdle: { idleTicks: houseIdleTicks, activityTick: () => 0 } }) });
  return { ...recorder.initial(), full: recorder.initialFull() };
}

function page() {
  const playback = new Playback(), frame = new Frame();
  return { frame, show(message: StreamMessage) {
    playback.push(decodeMessage(encodeMessage(message)), message.tick * TICK_MS);
    expect(playback.sample(message.tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
    return agentEntries(frame)[0]!;
  } };
}

it("the displayed house seat follows authoritative activity, not the command or untrusted call clock", () => {
  const first = opening(20), p = page();
  expect(p.show(first).idle).toBe(false);
  expect(p.show({ tick: 20, ants: first.ants, full: null, events: [
    { kind: "call", agent: 0, call: "observe", accepted: true, houseActivityTick: 19 },
  ] }).idle).toBe(false);
  const b = p.frame.board!;
  expect(b.agents[0]).toMatchObject({ lastCallTick: 19, lastCommandTick: -1, lastHouseCallTick: 19 });
  expect(p.show({ tick: 39, ants: first.ants, full: null, events: [] }).idle).toBe(false);
  const expired = p.show({ tick: 40, ants: first.ants, full: null, events: [
    { kind: "call", agent: 0, call: "observe", accepted: true, houseActivityTick: 19 },
  ] }); // synthetic observe advances lastCallTick, but not the authoritative house clock
  expect(expired.idle).toBe(true);
  expect(expired.label).toContain("idle");
});

it("offline binary playback and reconnect retain the custom house limit and latest accepted-call tick", () => {
  const first = opening(7.5);
  const messages: StreamMessage[] = [first,
    { tick: 8, ants: first.ants, full: null, events: [{ kind: "call", agent: 0, call: "observe", accepted: true, houseActivityTick: 7 }] },
    { tick: 15, ants: first.ants, full: null, events: [] },
    { tick: 16, ants: first.ants, full: null, events: [] }];
  const replay = unpackMessages(packMessages(messages.map(encodeMessage))).map(decodeMessage);
  const p = page();
  const labels = replay.map(message => p.show(message).idle);
  expect(labels).toEqual([false, false, false, true]);
  const full = { ...first.full!, setup: p.frame.board!.setup, agents: [...p.frame.board!.agents] };
  const reconnected = page();
  expect(reconnected.show({ ...replay.at(-1)!, full }).idle).toBe(true);
  expect(reconnected.frame.board!.setup.houseIdleTicks).toBe(7.5);
  expect(reconnected.frame.board!.agents[0]!.lastHouseCallTick).toBe(7);
});

it("ranked, lobby and old recordings retain command-only labels without house metadata", () => {
  for (const rated of [true, false, undefined]) {
    const first = opening(); first.full!.setup.rated = rated;
    const p = page(); p.show(first);
    expect(p.show({ tick: 4, ants: first.ants, full: null, events: [
      { kind: "call", agent: 0, call: "observe", accepted: true },
    ] }).idle).toBe(true);
    expect(p.show({ tick: 5, ants: first.ants, full: null, events: [
      { kind: "call", agent: 0, call: "order", accepted: true },
    ] }).idle).toBe(false);
  }
});

it("the seat list passes the stream's house limit into the shared idle calculation", () => {
  // Explicit wiring protection complements the binary-to-Playback-to-agentEntries behavioral checks.
  const hud = readFileSync(new URL("../../web/src/ui/hud-model.ts", import.meta.url), "utf8");
  expect(hud).toContain("isIdle(a, frame.tick, b.setup.idleTicks, b.setup.houseIdleTicks)");
});
