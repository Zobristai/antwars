/// <reference types="node" />
// The post-mortem's one streaming pass over a stored match record (src/accounts/postMortemRecord.ts): what it keeps
// equals what a full parse gives, whatever the chunking, and a record it cannot read whole fails without buffering it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BLOCK_TICKS, comparableEvent, ELEMENT_CAP_BYTES, EMPTY_PREFIX, LINE_ARGS_KNOWN, LINE_CELLS_CURSOR, LINE_SINCE, LINE_STUB, OTHER_CAP_BYTES, PAGE_ENTRIES,
  PAGE_SCAN_BYTES, paddedBits, PROGRESS_BYTES, readRecordPage, RecordChanged, RecordReadError, recordScanner, scanRecord, surveyRecord,
  type Checkpoint, type Findings, type NoEffectEntry, type PageSpec, type RecordScan, type RefusedEntry, type ReplyLines,
} from "../../src/accounts/postMortemRecord.ts";
import { packFindings } from "../../src/accounts/postMortemChild.ts";
import { entryCode } from "../../src/replays/recording.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

/** A small public record in the stored shape (src/replays/history.ts MatchRecord), with every reply-line kind. */
function record(extra: Record<string, unknown> = {}) {
  return {
    format: "antwar.match", version: 1, id: "2026-10-20T02-00-00-000Z-18", source: "match-log", status: "complete", unavailable: [],
    startedAt: "2026-10-20T02:00:00.000Z", endedAt: "2026-10-20T02:00:00.404Z", simulationEndedAt: null,
    rules: { version: 27, holdBehaviour: "x", config: { ticksPerSecond: 10, "quoted \"key\"": "a\\b" } },
    setup: { rated: false, note: "commas, braces } and ] in a string", houseIdleTicks: 3000 },
    result: { winner: 0, reason: "stopped", ratingChanges: [{ seat: 0, delta: 1 }] },
    seats: [
      { seat: 0, colony: 0, modelLabel: "m \"0\"", thinkingLevel: null, serviceTier: null, handle: "alice", joinedTick: 0,
        commands: [{ tick: 0, type: "join", accepted: true, request: { type: "join" }, error: null },
          { tick: 2, type: "order", accepted: false, request: { type: "order", note: "]}" }, error: { code: "command_floor", message: "wait" } }] },
      { seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: null, joinedTick: 0,
        commands: [{ tick: 0, type: "join", accepted: true, request: { type: "join" }, error: null }] },
    ],
    events: [{ tick: 0, event: { kind: "call", agent: 1, call: "join", accepted: true, houseActivityTick: 0 } },
      { tick: 0, event: { kind: "call", agent: 0, call: "join", accepted: true, houseActivityTick: 0 } },
      { tick: 1, event: { kind: "other", text: "é中 \"x\"" } }, { tick: 2, event: { kind: "call", agent: 0, call: "order", accepted: false } },
      { tick: 101, event: { kind: "join", agent: 1, identity: { displayName: "server only" } } }],
    rerun: { seed: 6006, stops: [4], abandonments: [], idle: [], houseActive: [[0, 1], [3, 4]] },
    codeVersion: "c".repeat(40),
    replies: [
      { type: "text", digest: "d".repeat(64), kind: "rules", text: "rules text" },
      { type: "reply", seat: 0, tick: 3, tool: "order", receivedAt: 1760925600300, answeredAt: 1760925600301, reply: { error: { code: "command_floor" } }, isError: true },
      { type: "reply", seat: 0, tick: 1, tool: "observe", receivedAt: 1760925600100, answeredAt: 1760925600101, reply: { ok: true } },
      { type: "reply", seat: 0, tick: 1, tool: "observe", receivedAt: 1760925600102, answeredAt: 1760925600103, arguments: { since: 4, cellsCursor: "a:1" }, reply: { ok: true } },
      { type: "reply", seat: 0, tick: 1, tool: "observe", receivedAt: 1760925600104, answeredAt: 1760925600105, arguments: { since: 4 }, trimmed: ["arguments"], reply: { ok: true } },
      { type: "stub", seat: 1, tick: null, tool: "join", receivedAt: 1760925599000, answeredAt: 1760925599001, code: "call_rate" },
      { type: "stub", seat: 1, tick: null, tool: "nonsense", receivedAt: 1760925599100, answeredAt: 1760925599101, code: "sdk_error", omitted: 3 },
      { type: "stub", seat: 0, tick: 2, tool: "observe", receivedAt: 1760925600200, answeredAt: 1760925600201, code: null },
      { type: "stub", seat: null, agent: "agent-1", tick: 2, tool: "order", receivedAt: 1760925600200, answeredAt: 1760925600201, code: "no_seat" },
    ],
    ...extra,
  };
}

/** What a refused-mode scan must keep, computed from a full parse by the record service's rule (stub.code, else entryCode). */
function expected(value: ReturnType<typeof record>): Pick<RecordScan, "refusals"> & { reduced: Partial<RecordScan["reduced"]> } {
  const replies = value.replies as Record<string, unknown>[] | null;
  return {
    refusals: replies === null ? null : replies.filter(l => l.type !== "text")
      .map(l => ({ l, code: l.type === "stub" ? l.code as string | null : entryCode(l) })).filter(x => x.code !== null)
      .map(({ l, code }) => ({ seat: (l.seat as number | null) ?? null, tick: (l.tick as number | null) ?? null, tool: l.tool as string, receivedAt: l.receivedAt as number, code: code! })),
    reduced: {
      calls: [], blocks: [], lines: null, houseIdleTicks: 3000, modelIndex: false,
      // Refused mode keeps no accepted command and no request.
      seats: value.seats.map(s => ({ seat: s.seat, colony: s.colony as 0 | 1, handle: s.handle, joinedTick: null, commands: s.commands.filter(c => !c.accepted).map(c =>
        ({ tick: c.tick, type: c.type, accepted: c.accepted, request: null, errorCode: c.error?.code ?? null })) })),
      rerun: value.rerun as unknown as RecordScan["reduced"]["rerun"], codeVersion: value.codeVersion, config: value.rules.config, result: { winner: 0, reason: "stopped" },
    },
  };
}

async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

/** What a rerun-mode scan must keep, from a full parse: every command, call facts, event blocks and reply lines. */
function expectedRerun(value: ReturnType<typeof record>) {
  const blocks = new Map<number, string[]>();
  for (const e of value.events) {
    const b = Math.floor(e.tick / BLOCK_TICKS);
    blocks.set(b, [...(blocks.get(b) ?? []), comparableEvent(e.tick, e.event)]);
  }
  const hash = (lines: string[]) => createHash("sha256").update(lines.map(l => l + "\n").join("")).digest("hex");
  return {
    calls: value.events.filter(e => e.event.kind === "call").map(e => ({ tick: e.tick, seat: e.event.agent as number, call: e.event.call as string,
      accepted: e.event.accepted as boolean, activity: (e.event.houseActivityTick as number | undefined) ?? null })),
    blocks: [...blocks].sort(([a], [b]) => a - b).map(([b, lines]) => [b, lines.length, hash(lines)]),
    seats: value.seats.map(s => ({ seat: s.seat, colony: s.colony, handle: s.handle, joinedTick: s.joinedTick, commands: s.commands.map(c =>
      ({ tick: c.tick, type: c.type, accepted: c.accepted, request: c.request, errorCode: c.error?.code ?? null })) })),
    lines: (value.replies as Record<string, any>[]).filter(l => l.type !== "text").map(l => {
      const known = l.type === "reply" && !(l.trimmed ?? []).includes("arguments");
      return { seat: typeof l.seat === "number" ? l.seat : -1, tick: l.tick ?? -1, tool: l.tool, code: l.type === "stub" ? l.code : entryCode(l),
        flags: (l.type === "stub" ? LINE_STUB : 0) | (known ? LINE_ARGS_KNOWN : 0) | (known && l.arguments?.since != null ? LINE_SINCE : 0)
          | (known && l.arguments?.cellsCursor != null ? LINE_CELLS_CURSOR : 0), omitted: l.omitted ?? 0 };
    }),
  };
}
const linesOf = (lines: ReplyLines | null) => lines === null ? null : Array.from({ length: lines.length }, (_, i) => ({
  seat: lines.seat.at(i), tick: lines.tick.at(i), tool: lines.string(lines.tool.at(i)),
  code: lines.code.at(i) === 0 ? null : lines.string(lines.code.at(i)), flags: lines.flags.at(i), omitted: lines.omitted.at(i) }));

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

  // Credible regression: the child's reduced record diverging from the stored record it re-runs (a dropped command,
  // a call fact or reply flag read wrongly, or events hashed in another form than the re-run's).
  it("keeps, in rerun mode, exactly the commands, call facts, event blocks and reply lines a full parse gives, at every boundary", async () => {
    const value = record();
    const bytes = Buffer.from(JSON.stringify(value, null, 1));
    const want = expectedRerun(value);
    for (let size = 1; size <= 48; size += 3) {
      const scan = await scanRecord(chunks(bytes, size), undefined, "rerun");
      expect(scan.refusals).toBeNull();
      expect(scan.reduced.calls).toEqual(want.calls);
      expect(scan.reduced.blocks).toEqual(want.blocks);
      expect(scan.reduced.seats).toEqual(want.seats);
      expect(linesOf(scan.reduced.lines)).toEqual(want.lines);
      expect(scan.reduced.houseIdleTicks).toBe(3000);
      expect(scan.reduced.result).toEqual({ winner: 0, reason: "stopped" });
    }
    // The server-only join identity is not part of the comparison.
    expect(comparableEvent(101, { kind: "join", agent: 1, identity: { displayName: "x" } })).toBe(comparableEvent(101, { kind: "join", agent: 1 }));
    expect((await scanRecord(chunks(Buffer.from(JSON.stringify(record({ replies: null }))), 50), undefined, "rerun")).reduced.lines).toBeNull();
  });

  // Credible regression: a defaulted tick rate, or one taken from the setup over the rules.
  it("takes the tick rate from the rules' config, else the match setup, and never assumes one", async () => {
    const rateOf = async (value: unknown) => (await scanRecord(chunks(Buffer.from(JSON.stringify(value)), 9))).ticksPerSecond;
    const base = record();
    expect(await rateOf({ ...base, setup: { ...base.setup, ticksPerSecond: 4 } })).toBe(10);
    expect(await rateOf({ ...base, rules: { ...base.rules, config: {} }, setup: { ...base.setup, ticksPerSecond: 4 } })).toBe(4);
    expect(await rateOf({ ...base, rules: { ...base.rules, config: {} } })).toBeNull();
    expect(await rateOf({ ...base, rules: null, setup: { ...base.setup, ticksPerSecond: 0 } })).toBeNull();
  });

  // Credible regression: a scan that reports no progress until it ends, so a slow record read looks stalled.
  it("reports progress about every MiB of decoded bytes while it scans", async () => {
    const value = record({ replies: [...record().replies as unknown[], ...Array.from({ length: 50 }, () => ({ type: "text", text: "t".repeat(100 * 1024) }))] });
    const bytes = Buffer.from(JSON.stringify(value));
    let calls = 0;
    await scanRecord(chunks(bytes, 64 * 1024), undefined, "refused", () => calls++);
    expect(calls).toBe(Math.floor(bytes.length / PROGRESS_BYTES));
    let gzCalls = 0;
    await scanRecord(chunks(gzipSync(bytes), 64 * 1024), undefined, "rerun", () => gzCalls++);
    expect(gzCalls).toBeGreaterThanOrEqual(Math.floor(bytes.length / PROGRESS_BYTES) - 1);
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
      try { const scan = await scanRecord(source(), undefined, "rerun"); console.log(JSON.stringify({ ok: true, calls: scan.reduced.calls.length })); }
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

/** A record with its members in another order: `first` leads, `last` ends, the rest keep their stored order. */
function reorder(value: Record<string, unknown>, first: readonly string[], last: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of first) if (k in value) out[k] = value[k];
  for (const k of Object.keys(value)) if (!first.includes(k) && !last.includes(k)) out[k] = value[k];
  for (const k of last) if (k in value) out[k] = value[k];
  return out;
}

/** A record of four seats, two per colony, with refused calls and refused and accepted commands for each. */
function windowRecord(options: { agents?: boolean; replies?: "array" | "null" | "absent"; declaresNone?: boolean } = {}) {
  const seat = (n: number) => ({ seat: n, colony: n % 2, handle: null, joinedTick: 0, commands: Array.from({ length: 6 }, (_, i) => ({
    tick: i, type: i % 3 === 2 ? "order" : "set_brood", accepted: i % 3 !== 2, request: { type: "set_brood" }, error: i % 3 === 2 ? { code: `floor_${n}_${i}` } : null })) });
  const lines = Array.from({ length: 12 }, (_, i) => {
    const n = i % 4;
    return { type: i % 2 ? "stub" : "reply", ...(options.agents ? { agentId: `agent-${n}` } : { seat: n }), tick: i, tool: "order",
      receivedAt: 1000 + i, answeredAt: 1001 + i, ...(i % 2 ? { code: `rate_${i}` } : { isError: true, reply: { error: { code: `bad_${i}` } } }) };
  });
  return {
    format: "antwar.match", version: 1, id: "w", status: "complete", unavailable: options.declaresNone ? ["Call replies were not retained."] : [],
    rules: { config: { ticksPerSecond: 10 } }, seats: [0, 1, 2, 3].map(seat), events: [],
    rerun: { seed: 1, stops: [], abandonments: [], idle: [], houseActive: [] }, codeVersion: "c".repeat(40),
    ...(options.agents ? { agentSeats: { "agent-0": 0, "agent-1": 1, "agent-2": 2, "agent-3": 3 } } : {}),
    ...(options.replies === "absent" ? {} : { replies: options.replies === "null" ? null : lines }),
  };
}

/** The full lists a full parse gives: refused calls from a replies array where there is one, else refused commands. */
function windowReference(value: ReturnType<typeof windowRecord>, colonies: ReadonlySet<number>, findings: Findings | null) {
  const colonyOf = new Map(value.seats.map(s => [s.seat, s.colony]));
  const agentSeats = (value as { agentSeats?: Record<string, number> }).agentSeats ?? {};
  const owned = (seat: number | null | undefined) => seat !== null && seat !== undefined && colonies.has(colonyOf.get(seat) ?? -1);
  let refused: RefusedEntry[];
  if (Array.isArray(value.replies)) {
    refused = (value.replies as Record<string, any>[]).flatMap(l => {
      const seat = l.agentId !== undefined ? agentSeats[l.agentId] : l.seat;
      const code = l.type === "stub" ? l.code : entryCode(l);
      return owned(seat) && code !== null ? [{ seat, tick: l.tick, at: l.receivedAt, tool: l.tool, code }] : [];
    });
  } else {
    refused = value.seats.flatMap(s => owned(s.seat) ? s.commands.filter(c => !c.accepted).map(c => ({ seat: s.seat, tick: c.tick, at: null, tool: c.type, code: c.error!.code })) : []);
  }
  const noEffect: NoEffectEntry[] = [];
  if (findings) {
    let offset = 0;
    for (const [seat, count] of findings.counts) {
      for (let i = 0; i < count; i++) {
        const command = value.seats.find(s => s.seat === seat)!.commands[i]!;
        if (owned(seat) && command.accepted && (findings.bits[offset + (i >> 3)]! & (1 << (i & 7))) !== 0) noEffect.push({ seat, index: i, tick: command.tick, type: command.type });
      }
      offset += Math.ceil(count / 8);
    }
  }
  return { refused, noEffect };
}

/** What the post-mortem derives from a first pass for one owner: its seats, agents, and each list's total. */
function ownerOf(scan: RecordScan, colonies: ReadonlySet<number>, findings: Findings | null) {
  const ownedPositions = new Map<number, number>();
  scan.survey.elements.forEach((e, position) => { if (colonies.has(e.colony)) ownedPositions.set(position, e.seat); });
  const ownedSeats = new Set(ownedPositions.values());
  const ownedAgents = new Map(Object.entries(scan.survey.agentSeats).filter(([, seat]) => ownedSeats.has(seat)));
  const refusedTotal = scan.survey.source === "commands"
    ? scan.survey.elements.filter(e => colonies.has(e.colony)).reduce((sum, e) => sum + e.refused, 0)
    : [...scan.survey.replyRefused].filter(([seat]) => ownedSeats.has(seat)).reduce((sum, [, n]) => sum + n, 0);
  let noEffectTotal = 0;
  if (findings) {
    let offset = 0;
    for (const [seat, count] of findings.counts) {
      if (ownedSeats.has(seat)) for (let i = 0; i < count; i++) if ((findings.bits[offset + (i >> 3)]! & (1 << (i & 7))) !== 0) noEffectTotal++;
      offset += Math.ceil(count / 8);
    }
  }
  return { ownedPositions, ownedSeats, ownedAgents, refusedTotal, noEffectTotal };
}

/** Every page of one list, each read from the record's start and resumed from the previous page's checkpoint. */
async function pageAll(text: string | Buffer, size: number, list: "refused" | "noEffect", colonies: ReadonlySet<number>, findings: Findings | null,
  scanBytes: number, measure: (entry: unknown) => number = () => 10) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const { scan } = await surveyRecord(chunks(bytes, size));
  const owner = ownerOf(scan, colonies, findings);
  const total = list === "refused" ? owner.refusedTotal : owner.noEffectTotal;
  const entries: (RefusedEntry | NoEffectEntry)[] = [];
  let resume: Checkpoint | null = null, prefix = EMPTY_PREFIX, pages = 0;
  while (entries.length < total) {
    const spec: PageSpec = { list, source: scan.survey.source, ownedPositions: owner.ownedPositions, ownedSeats: owner.ownedSeats, ownedAgents: owner.ownedAgents,
      findings, measure, resume, skip: 0, ordinal: entries.length, total, scanBytes };
    const read = await readRecordPage(chunks(bytes, size), undefined, spec, prefix, false);
    entries.push(...read.page.entries);
    pages++;
    if (read.page.next === null) break;
    if (resume !== null) expect(read.page.next.offset).toBeGreaterThan(resume.offset);
    resume = read.page.next;
    prefix = read.nextPrefix!;
    if (pages > 100_000) throw new Error("pages did not progress");
  }
  return { entries, total, pages, source: scan.survey.source };
}

describe("one owner's pages of a record", () => {
  // Seat 0 and seat 2 (colony 0): commands 0, 1 and 3 had no effect; seats 1 and 3 none.
  const findingsFor = (value: ReturnType<typeof windowRecord>) => packFindings(value.seats, [0, 2].flatMap(seat => [0, 1, 3].map(index => ({ seat, index, tick: index, type: "set_brood" }))));
  const BUDGETS = [1, 7, 4096, 64 * 1024, 1024 * 1024, PAGE_SCAN_BYTES];

  // Credible regression: refused calls emitted from seats' refused commands before a later replies array supersedes
  // them, placed by what was read so far (replies before seats, agent lines before the agent map), a source chosen by
  // the record's statement instead of what it holds, or a page resumed one byte off, at a chunk boundary or mid-element.
  for (const [name, options, first, last] of [
    ["stored order: refused commands before the superseding replies", {}, [], []],
    ["replies before seats", {}, ["replies"], []],
    ["seats after replies", {}, [], ["seats"]],
    ["agent lines, stored order", { agents: true }, [], []],
    ["agent lines before the agent map", { agents: true }, [], ["agentSeats"]],
    ["replies null", { replies: "null" }, [], []],
    ["replies absent", { replies: "absent" }, [], []],
    ["a replies array the record declares not retained", { declaresNone: true }, [], []],
  ] as const) {
    it(`pages every entry exactly once, as a full parse lists them, at every budget and chunking: ${name}`, async () => {
      const value = windowRecord(options);
      const text = JSON.stringify(reorder(value, first, last), null, 1);
      const findings = findingsFor(value);
      const colonies = new Set([0]);
      const want = windowReference(value, colonies, findings);
      for (const budget of BUDGETS) for (const size of [1, 2, 3, 5, 7, 13, 64, text.length]) {
        const refused = await pageAll(text, size, "refused", colonies, null, budget);
        expect(refused.entries, `refused, budget ${budget} size ${size}`).toEqual(want.refused);
        expect(refused.source).toBe(Array.isArray(value.replies) ? "calls" : "commands");
        const noEffect = await pageAll(text, size, "noEffect", colonies, findings, budget);
        expect(noEffect.entries, `no effect, budget ${budget} size ${size}`).toEqual(want.noEffect);
        if (budget === PAGE_SCAN_BYTES) expect(refused.pages).toBe(1);
      }
    });
  }

  it("gives a page at most one page of entries, whatever the owner's total, and the rest in later pages", async () => {
    const value = windowRecord();
    const replies = value.replies as Record<string, unknown>[];
    for (let i = 0; i < 5000; i++) replies.push({ type: "stub", seat: 0, tick: i, tool: "observe", receivedAt: i, answeredAt: i, code: "call_rate" });
    const all = await pageAll(JSON.stringify(value), 65536, "refused", new Set([0]), null, PAGE_SCAN_BYTES);
    expect(all.total).toBe(5006);
    expect(all.entries).toHaveLength(5006);
    expect(all.pages).toBe(3);
    // A byte cap that stops each page short of PAGE_ENTRIES.
    const bytes = await pageAll(JSON.stringify(value), 65536, "refused", new Set([0]), null, PAGE_SCAN_BYTES, () => 1023);
    expect(bytes.pages).toBe(Math.ceil(5006 / 256));
  });

  // Credible regression: a page that reads its prefix from the start and parses it, or resumes past its budget.
  it("parses no more than its budget plus one element past its checkpoint", async () => {
    const value = windowRecord();
    const replies = value.replies as Record<string, unknown>[];
    for (let i = 0; i < 2000; i++) replies.push({ type: "stub", seat: 0, tick: i, tool: "observe", receivedAt: i, answeredAt: i, code: "call_rate" });
    const bytes = Buffer.from(JSON.stringify(value));
    const { scan } = await surveyRecord(chunks(bytes, 4096));
    const owner = ownerOf(scan, new Set([0]), null);
    let resume: Checkpoint | null = null, prefix = EMPTY_PREFIX, ordinal = 0;
    const element = Buffer.byteLength(JSON.stringify(replies.at(-1))) + 1;
    for (const budget of [4096, 4096, 4096]) {
      const spec: PageSpec = { list: "refused", source: "calls", ...owner, findings: null, measure: () => 10, resume, skip: 0, ordinal, total: owner.refusedTotal, scanBytes: budget };
      const read = await readRecordPage(chunks(bytes, 4096), undefined, spec, prefix, false);
      const from = resume?.offset ?? 0;
      expect(read.page.next!.offset - from).toBeLessThanOrEqual(budget + element);
      ordinal += read.page.entries.length;
      resume = read.page.next; prefix = read.nextPrefix!;
    }
    // A checkpoint far into the record still reads only its budget's worth: its prefix is hashed, not parsed.
    expect(resume!.offset).toBeGreaterThan(3 * 4096 - 1);
  });

  // Credible regression: a continuation applied to other bytes than those it was made from.
  it("refuses a page whose bytes before its checkpoint differ from those it was made from", async () => {
    const value = windowRecord();
    const text = JSON.stringify(value);
    const { scan } = await surveyRecord(chunks(Buffer.from(text), 64));
    const owner = ownerOf(scan, new Set([0]), null);
    const spec: PageSpec = { list: "refused", source: "calls", ...owner, findings: null, measure: () => 10, resume: null, skip: 0, ordinal: 0, total: owner.refusedTotal, scanBytes: 1 };
    const first = await readRecordPage(chunks(Buffer.from(text), 64), undefined, spec, EMPTY_PREFIX, false);
    const changed = text.replace('"id":"w"', '"id":"v"');
    await expect(readRecordPage(chunks(Buffer.from(changed), 64), undefined, { ...spec, resume: first.page.next, ordinal: first.page.entries.length }, first.nextPrefix!, false))
      .rejects.toBeInstanceOf(RecordChanged);
    await expect(readRecordPage(chunks(Buffer.from(text), 64), undefined, spec, "0".repeat(64), false)).rejects.toBeInstanceOf(RecordChanged);
  });

  // Credible regression: whitespace or commas between a streamed array's elements charged to the cap on other members.
  it.each(["commands", "events", "replies"] as const)("reads a record with 27 MiB of whitespace inside its %s array", async role => {
    const value = windowRecord();
    const pad = " ".repeat(9 * 1024 * 1024);
    let text = JSON.stringify(value);
    const anchor = role === "commands" ? '"commands":[' : role === "events" ? '"events":[' : '"replies":[';
    if (role === "events") text = text.replace('"events":[]', '"events":[{"tick":0,"event":{"kind":"other"}},{"tick":1,"event":{"kind":"other"}}]');
    // Whitespace before the first element, and around the separator after it: inside the array, outside any element.
    const at = text.indexOf(anchor) + anchor.length;
    const gap = text.indexOf("},{", at) + 1;
    text = text.slice(0, at) + pad + text.slice(at, gap) + pad + "," + pad + text.slice(gap + 1);
    const { scan } = await surveyRecord(chunks(Buffer.from(text), 1024 * 1024));
    expect(scan.survey.elements).toHaveLength(4);
    const refused = await pageAll(text, 1024 * 1024, "refused", new Set([0]), null, PAGE_SCAN_BYTES);
    expect(refused.entries).toEqual(windowReference(value, new Set([0]), null).refused);
  });

  // Credible regression: a scan that keeps every refused call, which a large record's refusals overflow.
  it("counts a million refused calls under a 64 MiB heap, keeping one page", () => {
    const script = `
      import { readRecordPage, surveyRecord, EMPTY_PREFIX } from ${JSON.stringify(new URL("../../src/accounts/postMortemRecord.ts", import.meta.url).href)};
      async function* source() {
        yield Buffer.from('{"id":"x","seats":[{"seat":0,"colony":0,"commands":[]}],"replies":[');
        for (let block = 0; block < 1000; block++) {
          const lines = [];
          for (let i = 0; i < 1000; i++) {
            const n = block * 1000 + i;
            lines.push((n ? "," : "") + JSON.stringify({ type: "stub", seat: 0, tick: n, tool: "observe", receivedAt: 1e12 + n, answeredAt: 1e12 + n, code: "call_rate" }));
          }
          yield Buffer.from(lines.join(""));
        }
        yield Buffer.from("]}");
      }
      const { scan } = await surveyRecord(source());
      const read = await readRecordPage(source(), undefined, { list: "refused", source: scan.survey.source, ownedPositions: new Map([[0, 0]]), ownedSeats: new Set([0]),
        ownedAgents: new Map(), findings: null, measure: () => 100, resume: null, skip: 0, ordinal: 0, total: scan.survey.replyRefused.get(0), scanBytes: 1 << 30 }, EMPTY_PREFIX, false);
      console.log(JSON.stringify({ total: scan.survey.replyRefused.get(0), kept: read.page.entries.length }));
    `;
    const run = spawnSync(process.execPath, ["--max-old-space-size=64", "--import", `${ROOT}src/ts-resolve.mjs`, "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 240_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toEqual({ total: 1_000_000, kept: PAGE_ENTRIES });
  }, 300_000);

  // Credible regression: the separators of a seat's 16,777,217 commands charged to the other-members cap, so a record
  // past the re-run's bit limit cannot show its refused commands.
  it("reads a seat of 16,777,217 commands, counting them all, and pages its last refused commands from far into it", async () => {
    const N = 16_777_217, FROM = 16_776_000;
    const command = (i: number) => `{"tick":${i},"type":"order","accepted":false}`;
    async function* source() {
      yield Buffer.from('{"id":"x","status":"complete","seats":[{"seat":0,"colony":0,"commands":[');
      const BLOCK = 65_536;
      for (let start = 0; start < N; start += BLOCK) {
        const parts: string[] = [];
        for (let i = start; i < Math.min(N, start + BLOCK); i++) parts.push(command(i));
        yield Buffer.from((start === 0 ? "" : ",") + parts.join(","));
      }
      yield Buffer.from("]}]}");
    }
    const { scan } = await surveyRecord(source());
    expect(scan.survey.elements).toEqual([{ seat: 0, colony: 0, commands: N, refused: N }]);
    expect(paddedBits(scan.survey.elements.map(e => e.commands))).toBeGreaterThan(2 ** 24);
    const read = await readRecordPage(source(), undefined, { list: "refused", source: "commands", ownedPositions: new Map([[0, 0]]), ownedSeats: new Set([0]),
      ownedAgents: new Map(), findings: null, measure: () => 10, resume: null, skip: FROM, ordinal: 0, total: N, scanBytes: PAGE_SCAN_BYTES * 8 }, EMPTY_PREFIX, false);
    expect(read.page.entries).toHaveLength(N - FROM);
    expect(read.page.entries.at(-1)).toMatchObject({ seat: 0, tick: N - 1, code: "refused" });
    expect(read.page.next).toBeNull();
  }, 300_000);
});
