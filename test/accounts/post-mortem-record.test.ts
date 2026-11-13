/// <reference types="node" />
// The post-mortem's one streaming pass over a stored match record (src/accounts/postMortemRecord.ts): what it keeps
// equals what a full parse gives, whatever the chunking, and a record it cannot read whole fails without buffering it.
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ELEMENT_CAP_BYTES, OTHER_CAP_BYTES, RecordReadError, recordScanner, scanRecord, type RecordScan } from "../../src/accounts/postMortemRecord.ts";
import { entryCode } from "../../src/replays/recording.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

/** A small public record in the stored shape (src/replays/history.ts MatchRecord), with every reply-line kind. */
function record(extra: Record<string, unknown> = {}) {
  return {
    format: "antwar.match", version: 1, id: "2026-10-20T02-00-00-000Z-18", source: "match-log", status: "complete", unavailable: [],
    startedAt: "2026-10-20T02:00:00.000Z", endedAt: "2026-10-20T02:00:00.404Z", simulationEndedAt: null,
    rules: { version: 27, holdBehaviour: "x", config: { ticksPerSecond: 10, "quoted \"key\"": "a\\b" } },
    setup: { rated: false, note: "commas, braces } and ] in a string" },
    result: { winner: 0, reason: "stopped" },
    seats: [
      { seat: 0, colony: 0, modelLabel: "m \"0\"", thinkingLevel: null, serviceTier: null, handle: "alice", joinedTick: 0,
        commands: [{ tick: 0, type: "join", accepted: true, request: { type: "join" }, error: null },
          { tick: 2, type: "order", accepted: false, request: { type: "order", note: "]}" }, error: { code: "command_floor", message: "wait" } }] },
      { seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: null, joinedTick: 0,
        commands: [{ tick: 0, type: "join", accepted: true, request: { type: "join" }, error: null }] },
    ],
    events: [{ tick: 0, event: { kind: "call", agent: 1 } }, { tick: 0, event: { kind: "call", agent: 0 } },
      { tick: 1, event: { kind: "other", text: "é中 \"x\"" } }, { tick: 2, event: { kind: "call", agent: 0 } }],
    rerun: { seed: 6006, stops: [4], abandonments: [], idle: [], houseActive: [[0, 1], [3, 4]] },
    codeVersion: "c".repeat(40),
    replies: [
      { type: "text", digest: "d".repeat(64), kind: "rules", text: "rules text" },
      { type: "reply", seat: 0, tick: 3, tool: "order", receivedAt: 1760925600300, answeredAt: 1760925600301, reply: { error: { code: "command_floor" } }, isError: true },
      { type: "reply", seat: 0, tick: 1, tool: "observe", receivedAt: 1760925600100, answeredAt: 1760925600101, reply: { ok: true } },
      { type: "stub", seat: 1, tick: null, tool: "join", receivedAt: 1760925599000, answeredAt: 1760925599001, code: "call_rate" },
      { type: "stub", seat: 1, tick: null, tool: "nonsense", receivedAt: 1760925599100, answeredAt: 1760925599101, code: "sdk_error", omitted: 3 },
      { type: "stub", seat: 0, tick: 2, tool: "observe", receivedAt: 1760925600200, answeredAt: 1760925600201, code: null },
      { type: "stub", seat: null, agent: "agent-1", tick: 2, tool: "order", receivedAt: 1760925600200, answeredAt: 1760925600201, code: "no_seat" },
    ],
    ...extra,
  };
}

/** What the scan must keep, computed from a full parse by the record service's rule (stub.code, else entryCode). */
function expected(value: ReturnType<typeof record>): Pick<RecordScan, "refusals"> & { reduced: Partial<RecordScan["reduced"]> } {
  const replies = value.replies as Record<string, unknown>[] | null;
  return {
    refusals: replies === null ? null : replies.filter(l => l.type !== "text")
      .map(l => ({ l, code: l.type === "stub" ? l.code as string | null : entryCode(l) })).filter(x => x.code !== null)
      .map(({ l, code }) => ({ seat: (l.seat as number | null) ?? null, tick: (l.tick as number | null) ?? null, tool: l.tool as string, receivedAt: l.receivedAt as number, code: code! })),
    reduced: {
      calls: value.events.filter(e => e.event.kind === "call").map(e => [e.tick, e.event.agent as number] as [number, number]),
      seats: value.seats.map(s => ({ seat: s.seat, colony: s.colony as 0 | 1, handle: s.handle, commands: s.commands.map(c =>
        ({ tick: c.tick, type: c.type, accepted: c.accepted, request: c.request, errorCode: c.error?.code ?? null })) })),
      rerun: value.rerun as unknown as RecordScan["reduced"]["rerun"], codeVersion: value.codeVersion, config: value.rules.config, result: { winner: 0, reason: "stopped" },
    },
  };
}

async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe("match record scan", () => {
  it("keeps exactly what a full parse gives, split at every byte boundary", async () => {
    const value = record();
    const bytes = Buffer.from(JSON.stringify(value, null, 1) + "\n");
    const want = expected(value);
    for (let size = 1; size <= 64; size++) {
      const scan = await scanRecord(chunks(bytes, size));
      expect(scan.refusals).toEqual(want.refusals);
      expect(scan.reduced).toMatchObject(want.reduced);
      expect(scan.ticksPerSecond).toBe(10);
      expect([...scan.omitted]).toEqual([[1, 3]]);
    }
  });

  it("reads gzip the same, and treats replies null as no retained calls", async () => {
    const value = record();
    const gz = await scanRecord(chunks(gzipSync(JSON.stringify(value)), 7));
    expect(gz.refusals).toEqual(expected(value).refusals);
    const none = await scanRecord(chunks(Buffer.from(JSON.stringify(record({ replies: null }))), 5));
    expect(none.refusals).toBeNull();
  });

  it("names a sealed private record's callers by its agentSeats", async () => {
    const value = record({ agentSeats: { "agent-a": 0, "agent-b": null },
      replies: [{ type: "stub", agentId: "agent-a", tick: null, tool: "join", receivedAt: 1, answeredAt: 2, code: "call_rate", omitted: 2 },
        { type: "reply", agentId: "agent-b", tick: 1, tool: "order", receivedAt: 3, answeredAt: 4, isError: true, reply: { error: "bad_arguments" } }] });
    const scan = await scanRecord(chunks(Buffer.from(JSON.stringify(value)), 9));
    expect(scan.refusals).toEqual([{ seat: 0, tick: null, tool: "join", receivedAt: 1, code: "call_rate" },
      { seat: null, tick: 1, tool: "order", receivedAt: 3, code: "bad_arguments" }]);
    expect([...scan.omitted]).toEqual([[0, 2]]);
  });

  it("skips a text line over the element cap without keeping it", async () => {
    const value = record();
    (value.replies as unknown[]).unshift({ type: "text", digest: "e".repeat(64), kind: "briefing", text: "x".repeat(ELEMENT_CAP_BYTES * 2) });
    const scan = await scanRecord(chunks(Buffer.from(JSON.stringify(value)), 4096));
    expect(scan.refusals).toEqual(expected(value).refusals);
  });

  it.each([
    ["an oversized reply that is not text", () => { const v = record(); (v.replies as unknown[]).push({ type: "reply", seat: 0, tick: 1, tool: "x", receivedAt: 1, answeredAt: 1, reply: "x".repeat(ELEMENT_CAP_BYTES) }); return JSON.stringify(v); }],
    ["an oversized command", () => { const v = record(); v.seats[0]!.commands.push({ tick: 3, type: "order", accepted: true, request: { type: "order", note: "x".repeat(ELEMENT_CAP_BYTES) } as never, error: null }); return JSON.stringify(v); }],
    ["other members over their total cap", () => JSON.stringify(record({ setup: { big: "x".repeat(OTHER_CAP_BYTES) } }))],
    ["truncation", () => JSON.stringify(record()).slice(0, -20)],
    ["trailing bytes", () => JSON.stringify(record()) + "{}"],
    ["a broken element", () => JSON.stringify(record()).replace('"kind":"call","agent":1', '"kind":"call","agent":')],
    ["an unterminated string inverting every later quote", () => JSON.stringify(record()).replace('"note":"]}"', '"note":"]}')],
  ])("fails %s as a read error", async (_name, text) => {
    await expect(scanRecord(chunks(Buffer.from(text()), 1000))).rejects.toBeInstanceOf(RecordReadError);
  });

  it("refuses a value that is not an object, and a push after the end", () => {
    expect(() => { const s = recordScanner(); s.push(Buffer.from("[]")); s.end(); }).toThrow(RecordReadError);
    expect(() => { const s = recordScanner(); s.push(Buffer.from("{}")); s.push(Buffer.from("{}")); }).toThrow(RecordReadError);
  });

  // Credible regression: a scan that buffers a whole member or the whole record runs out of a small heap.
  it("scans a generated record of over 300 MiB, and an inverted-quote one, under a 32 MiB heap", () => {
    const script = `
      import { scanRecord } from ${JSON.stringify(new URL("../../src/accounts/postMortemRecord.ts", import.meta.url).href)};
      const invert = process.argv[1] === "invert";
      const event = Buffer.from(JSON.stringify({ tick: 5, event: { kind: "move", text: "y".repeat(400) } }) + ",");
      async function* source() {
        // Inverted: the first element's string never closes, so every later byte reads as inside it.
        yield Buffer.from('{"id":"x","rules":{"config":{"ticksPerSecond":10}},"seats":[],"events":[{"tick":0,"event":{"kind":"call","agent":0' + (invert ? ',"x":"' : '') + '}},');
        const block = Buffer.concat(Array.from({ length: 2000 }, () => event));
        for (let i = 0; i < 400; i++) yield block;
        yield Buffer.from('{"tick":6,"event":{"kind":"call","agent":0}}],"replies":[]}');
      }
      try { const scan = await scanRecord(source()); console.log(JSON.stringify({ ok: true, calls: scan.reduced.calls.length })); }
      catch (error) { console.log(JSON.stringify({ ok: false, error: error.constructor.name })); }
    `;
    for (const mode of ["plain", "invert"]) {
      const run = spawnSync(process.execPath, ["--max-old-space-size=32", "--import", `${ROOT}src/ts-resolve.mjs`, "--input-type=module", "-e", script, mode],
        { encoding: "utf8", timeout: 120_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toEqual(mode === "plain" ? { ok: true, calls: 2 } : { ok: false, error: "RecordReadError" });
    }
  }, 180_000);
});
