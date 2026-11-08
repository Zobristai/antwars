/// <reference types="node" />
/**
 * A match recording keeps its seats' call reply lines apart from its input log lines, hands them off in the
 * match's one record input (so a private lobby's are sealed with the rest of it), and carries them through a handover
 * save so the resumed match's input holds every reply, none twice.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MatchInputs, RecordHandoff } from "../../src/records/handoff.ts";
import { servedText } from "../../src/mcp/replies.ts";
import { CLOSING_STUB_RESERVE_BYTES, RECORDING_PARTS, ReplayRecording, replyLine, SEAT_RECORD_BUDGET_BYTES, stubLine, textLine,
  type RecordingSaveMeta } from "../../src/replays/recording.ts";
import type { ReplayStore } from "../../src/replays/store.ts";

function handoffSpy() {
  const submitted: MatchInputs[] = [];
  return { submitted, handoff: { submit: (inputs: MatchInputs) => { submitted.push(inputs); } } satisfies RecordHandoff };
}
const store: ReplayStore = { create: async () => {} };

/** An incompressible delta frame (byte 3's low bit clear, so it is held as it is). */
function frame(): Uint8Array {
  const bytes = randomBytes(64);
  bytes[3] = bytes[3]! & 0xfe;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const reply = (n: number) => replyLine("seat-a", n, { tool: "observe", arguments: { since: n }, reply: { tick: n } });

function play(recording: ReplayRecording, from: number, to: number): void {
  for (let tick = from; tick < to; tick += 1) {
    recording.appendLog(JSON.stringify({ tick, inputs: [] }));
    recording.appendLog(reply(tick));
    const payload = frame();
    recording.capture(payload);
    recording.append(payload);
  }
}

describe("call reply lines in a match recording", () => {
  it("are handed off apart from the input lines, including a reply answered after the final tick's push", async () => {
    const { submitted, handoff } = handoffSpy();
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff, logHeader: "{\"header\":1}", lobbyId: "secret" });
    play(recording, 0, 3);
    recording.ended(300, { publishAfter: 300, rated: false });
    // The final tick's calls are answered after its output is pushed.
    recording.appendLog(reply(3));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    const [input] = submitted;
    expect(input!.logLines).toEqual(["{\"header\":1}", ...[0, 1, 2].map(tick => JSON.stringify({ tick, inputs: [] }))]);
    expect(input!.replyLines).toEqual([0, 1, 2, 3].map(reply));
    // A private lobby's replies travel in its one record input, under its lobby, as its log lines do.
    expect(input!.lobbyId).toBe("secret");
    // After the handoff, a later call is not recorded and nothing is submitted again.
    recording.appendLog(reply(4));
    expect(await recording.finish()).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.replyLines).toHaveLength(4);
  });

  it("are carried through a handover save: the resumed match's input holds every reply in order, none twice", async () => {
    const saving = handoffSpy(), resuming = handoffSpy();
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff: saving.handoff, logHeader: "{\"header\":1}" });
    play(recording, 0, 5);
    const saved = await recording.save();
    expect(saved.meta.replies).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(saved.parts.get(RECORDING_PARTS.replies)!))).toEqual([0, 1, 2, 3, 4].map(reply));
    // Inert after its save: nothing more is recorded on the saving server.
    recording.appendLog(reply(99));
    const resumed = new ReplayRecording(0, 2, store, undefined, { handoff: resuming.handoff,
      resume: { meta: JSON.parse(JSON.stringify(saved.meta)) as RecordingSaveMeta, parts: saved.parts } });
    play(resumed, 5, 8);
    resumed.ended(800, { publishAfter: 800, rated: false });
    await vi.waitFor(() => expect(resuming.submitted).toHaveLength(1));
    expect(resuming.submitted[0]!.replyLines).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(reply));
    expect(resuming.submitted[0]!.logLines).toHaveLength(9);
    expect(saving.submitted).toEqual([]);
  });

  it("carries each served text once per match, uncapped, through a handover, before the entries naming it", async () => {
    const saving = handoffSpy(), resuming = handoffSpy();
    const rules = textLine(servedText("rules", "r".repeat(20_000))), tools = textLine(servedText("tools", "[]"));
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff: saving.handoff, logHeader: "{\"header\":1}" });
    recording.appendLog(rules);
    play(recording, 0, 2);
    recording.appendLog(rules);
    const saved = await recording.save();
    const resumed = new ReplayRecording(0, 2, store, undefined, { handoff: resuming.handoff,
      resume: { meta: JSON.parse(JSON.stringify(saved.meta)) as RecordingSaveMeta, parts: saved.parts } });
    // A server that resumes sends the texts again; the recording keeps the copy it already holds.
    resumed.appendLog(rules);
    resumed.appendLog(tools);
    play(resumed, 2, 3);
    resumed.ended(300, { publishAfter: 300, rated: false });
    await vi.waitFor(() => expect(resuming.submitted).toHaveLength(1));
    const [input] = resuming.submitted;
    expect(input!.replyLines).toEqual([rules, reply(0), reply(1), tools, reply(2)]);
    expect(input!.logLines.some(line => line.includes("\"type\":\"text\""))).toBe(false);
  });

  it("keeps at most 2 stubs per second per seat, each counting exactly the calls left out before it, and closes with the rest at handoff", async () => {
    const { submitted, handoff } = handoffSpy();
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff, logHeader: "{\"header\":1}" });
    const stub = (agentId: string, at: number) => stubLine(agentId, 4, { tool: "order", receivedAt: at, answeredAt: at, code: "call_rate" });
    // A flood: 10 calls from seat a in one millisecond, 3 from seat b, then a's 11th a second later and 4 more.
    for (let i = 0; i < 10; i += 1) recording.appendLog(stub("a", 1_000));
    for (let i = 0; i < 3; i += 1) recording.appendLog(stub("b", 1_000));
    recording.appendLog(stub("a", 2_000));
    for (let i = 0; i < 4; i += 1) recording.appendLog(stub("a", 2_500));
    play(recording, 0, 1);
    recording.ended(100, { publishAfter: 100, rated: false });
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    const kept = submitted[0]!.replyLines!.filter(line => line.includes("\"type\":\"stub\"")).map(line => JSON.parse(line) as { agentId: string; answeredAt: number; omitted: number });
    expect(kept.map(({ agentId, answeredAt, omitted }) => [agentId, answeredAt, omitted])).toEqual([
      ["a", 1_000, 0], ["a", 1_000, 0], ["b", 1_000, 0], ["b", 1_000, 0],
      ["a", 2_000, 8], ["a", 2_500, 0],
      // Closing stubs at handoff: each seat's last left-out call, counting the ones before it.
      ["a", 2_500, 2], ["b", 1_000, 0]]);
    // Every call is accounted for exactly: kept stubs plus their omitted counts.
    const calls = (agentId: string) => kept.filter(s => s.agentId === agentId).reduce((n, s) => n + 1 + s.omitted, 0);
    expect([calls("a"), calls("b")]).toEqual([15, 3]);
  });

  it("carries a seat's left-out calls through a handover save, so the next stub's count is exact", async () => {
    const saving = handoffSpy(), resuming = handoffSpy();
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff: saving.handoff, logHeader: "{\"header\":1}" });
    const stub = (at: number) => stubLine("a", 1, { tool: "observe", receivedAt: at, answeredAt: at, code: "call_rate" });
    for (let i = 0; i < 5; i += 1) recording.appendLog(stub(1_000));
    const saved = await recording.save();
    expect(saved.meta.pendingStubs).toEqual([{ agentId: "a", omitted: 3, last: expect.any(String) }]);
    const resumed = new ReplayRecording(0, 2, store, undefined, { handoff: resuming.handoff,
      resume: { meta: JSON.parse(JSON.stringify(saved.meta)) as RecordingSaveMeta, parts: saved.parts } });
    resumed.appendLog(stub(9_000));
    play(resumed, 1, 2);
    resumed.ended(200, { publishAfter: 200, rated: false });
    await vi.waitFor(() => expect(resuming.submitted).toHaveLength(1));
    const kept = resuming.submitted[0]!.replyLines!.map(line => JSON.parse(line) as { type: string; omitted?: number }).filter(line => line.type === "stub");
    expect(kept.map(line => line.omitted)).toEqual([0, 0, 3]);
  });

  it("resumes a save from before reply lines with none so far, and records from there", async () => {
    const saving = handoffSpy(), resuming = handoffSpy();
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff: saving.handoff, logHeader: "{\"header\":1}" });
    play(recording, 0, 2);
    const saved = await recording.save();
    const { replies: _replies, ...older } = saved.meta;
    const parts = new Map([...saved.parts].filter(([name]) => name !== RECORDING_PARTS.replies));
    const resumed = new ReplayRecording(0, 2, store, undefined, { handoff: resuming.handoff, resume: { meta: older, parts } });
    play(resumed, 2, 3);
    resumed.ended(300, { publishAfter: 300, rated: false });
    await vi.waitFor(() => expect(resuming.submitted).toHaveLength(1));
    expect(resuming.submitted[0]!.replyLines).toEqual([reply(2)]);
  });

  it("hands off a match with no recorded call without reply lines, as before replies were recorded", async () => {
    const { submitted, handoff } = handoffSpy();
    const recording = new ReplayRecording(0, 1, store, undefined, { handoff, logHeader: "{\"header\":1}" });
    recording.appendLog(JSON.stringify({ tick: 0, inputs: [] }));
    recording.capture(frame());
    recording.ended(100, { publishAfter: 100, rated: false });
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).not.toHaveProperty("replyLines");
  });
});

describe("a seat's record budget", () => {
  it("stores nothing past a seat's 36 MB but one final stub with exact counts, through a handover, other seats unaffected", async () => {
    expect(SEAT_RECORD_BUDGET_BYTES).toBe(36_000_000);
    const saving = handoffSpy(), resuming = handoffSpy();
    let recording = new ReplayRecording(0, 1, store, undefined, { handoff: saving.handoff, logHeader: "{\"header\":1}" });
    // A tick of output, with no call of its own.
    const output = (tick: number) => {
      recording.appendLog(JSON.stringify({ tick, inputs: [] }));
      const payload = frame();
      recording.capture(payload);
      recording.append(payload);
    };
    output(0);
    // A live phase longer than a deployed match: each second, 2 entries of about 8.9 KB and 3 rate-limited calls.
    const pad = "x".repeat(8_800);
    let calls = 0;
    const second = (s: number) => {
      for (let i = 0; i < 2; i += 1) recording.appendLog(replyLine("seat-a", s, { tool: "observe", receivedAt: s * 1000 + i, answeredAt: s * 1000 + i, reply: { pad } }));
      for (let i = 2; i < 5; i += 1) recording.appendLog(stubLine("seat-a", s, { tool: "order", receivedAt: s * 1000 + i, answeredAt: s * 1000 + i, code: "call_rate" }));
      calls += 5;
      if (s % 100 === 0) recording.appendLog(replyLine("seat-b", s, { tool: "order", receivedAt: s * 1000, answeredAt: s * 1000, reply: { accepted: true } }));
    };
    for (let s = 1; s <= 1_500; s += 1) second(s);
    const saved = await recording.save();
    recording = new ReplayRecording(0, 2, store, undefined, { handoff: resuming.handoff,
      resume: { meta: JSON.parse(JSON.stringify(saved.meta)) as RecordingSaveMeta, parts: saved.parts } });
    for (let s = 1_501; s <= 2_400; s += 1) second(s);
    output(1);
    recording.ended(2_500_000, { publishAfter: 2_500_000, rated: false });
    await vi.waitFor(() => expect(resuming.submitted).toHaveLength(1));
    const lines = resuming.submitted[0]!.replyLines!;
    const own = lines.filter(line => JSON.parse(line).agentId === "seat-a");
    const bytes = own.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
    // Reached and held: within the budget, its last entry about one entry short of it.
    expect(bytes).toBeLessThanOrEqual(SEAT_RECORD_BUDGET_BYTES);
    expect(bytes).toBeGreaterThan(SEAT_RECORD_BUDGET_BYTES - CLOSING_STUB_RESERVE_BYTES - 10_000);
    const parsed = own.map(line => JSON.parse(line));
    // One final stub, the seat's last call, after which nothing; before it, nothing later than where the budget ran out.
    const final = parsed.at(-1);
    expect(final).toMatchObject({ type: "stub", tool: "order", answeredAt: 2_400_004, code: "call_rate" });
    expect(Buffer.byteLength(own.at(-1)!)).toBeLessThan(CLOSING_STUB_RESERVE_BYTES);
    expect(parsed.at(-2).answeredAt).toBeLessThan(2_100_000);
    // Every call counted exactly: the entries stored, and each stub with the calls it counts.
    const counted = parsed.reduce((n, line) => n + (line.type === "stub" ? 1 + line.omitted : 1), 0);
    expect(counted).toBe(calls);
    // The other seat's calls are all stored, those after seat-a's budget ran out included.
    expect(lines.map(line => JSON.parse(line)).filter(line => line.agentId === "seat-b")).toHaveLength(24);
  }, 60_000);
});
