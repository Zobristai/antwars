/// <reference types="node" />
/**
 * The feed path a server takes: call reply lines reach a match's recording through LiveHub.appendLog beside
 * its tick lines, are handed off in its one record input (a private lobby's under its lobby, as the rest of it), and the
 * record service still builds and verifies the readable record from the input lines alone, carrying the reply lines in it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { LiveHub } from "../../src/live/hub.ts";
import type { MatchAccess } from "../../src/live/match-access.ts";
import type { MatchInputs, RecordHandoff } from "../../src/records/handoff.ts";
import type { InputStore } from "../../src/records/input-store.ts";
import { encodeInput } from "../../src/records/inputs.ts";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { createRecordService } from "../../src/records/service.ts";
import { replyLine } from "../../src/replays/recording.ts";
import type { ReplayObject } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { playable } from "../playable.ts";
import { createOnlyRecords } from "../records/create-only-records.js";
import { ManualClock } from "./helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const AGENT = "private-test-id";
const reply = (tick: number) => replyLine(AGENT, tick, { tool: "order", arguments: { kind: "hold" }, reply: { tick, accepted: true } });

/** A short match whose every tick carries one order and its reply line, as a server's tick and tool call would. */
function play(hub: LiveHub, clock: ManualClock, seq: number, access?: MatchAccess): number {
  let state = createMatch(6006, playable({ ...rulesConfig("redesign"), matchTicks: 4 }));
  hub.startMatch(seq, state, access);
  let replies = 0;
  while (state.result === null) {
    const inputs = state.tick === 0 ? [{ type: "join" as const, agentId: AGENT, modelLabel: "fixture-agent" }]
      : [{ type: "order" as const, agentId: AGENT, order: { kind: "hold" as const } }];
    hub.appendLog(seq, tickLine(state.tick, inputs));
    const out = step(state, inputs);
    clock.advance(100);
    hub.pushTick(seq, out);
    hub.appendLog(seq, reply(state.tick));
    replies += 1;
    state = out.state;
  }
  return replies;
}

it("hands reply lines off in the match's record input, public or private, and the readable record still verifies", async () => {
  const submitted: MatchInputs[] = [], clock = new ManualClock();
  const handoff: RecordHandoff = { submit: inputs => { submitted.push(inputs); } };
  const hub = new LiveHub({ clock, captureMatchLogs: true, recordHandoff: handoff, replayStore: { create: async () => {} },
    privateReplayStore: () => ({ create: async () => {} }) });
  cleanup.push(() => hub.close());
  const publicReplies = play(hub, clock, 1);
  await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 5_000 });
  play(hub, clock, 2, { lobbyId: "secret", visibility: "private", rated: false });
  await vi.waitFor(() => expect(submitted).toHaveLength(2), { timeout: 5_000 });

  for (const input of submitted) {
    expect(input.replyLines).toEqual(Array.from({ length: publicReplies }, (_, tick) => reply(tick)));
    expect(input.logLines.some(line => line.includes("\"type\":\"reply\""))).toBe(false);
  }
  expect(submitted.map(input => input.lobbyId)).toEqual([null, "secret"]);

  // The record service reads the same input and builds a complete record from its log lines.
  const CODE = "c".repeat(40), stored = new Map([[`${submitted[0]!.id}.input`, encodeInput({ ...submitted[0]!, codeVersion: CODE })]]);
  const saved: ReplayObject[] = [], logs: string[] = [];
  const inputs: InputStore = { list: async () => [...stored.keys()], get: async name => stored.get(name) ?? null,
    createMarker: async () => true, markerReason: async () => null, delete: async name => { stored.delete(name); } };
  await createRecordService({ inputs, replays: createRecordReplayStore({ publicStore: { create: async () => {} }, readPublic: async () => submitted[0]!.binary }),
    now: () => submitted[0]!.publishAfter ?? 0, records: createOnlyRecords({ create: async object => { saved.push(object); } }),
    codeVersion: CODE, log: line => logs.push(line) }).sweep();
  expect(logs).toEqual([]);
  const record = JSON.parse(new TextDecoder().decode(saved[0]!.body)) as { replies?: unknown[] };
  expect(record).toMatchObject({ source: "match-log", status: "complete" });
  // The record built by the real verifier carries every call's reply, so deleting the input loses none; this public
  // record names the agent by its seat, never its private id.
  expect(record.replies).toEqual(submitted[0]!.replyLines!.map(line => {
    const { type, agentId: _id, ...rest } = JSON.parse(line) as Record<string, unknown>;
    return { type, seat: 0, ...rest };
  }));
  expect(new TextDecoder().decode(saved[0]!.body)).not.toContain(AGENT);
  expect(stored.size).toBe(0);
});
