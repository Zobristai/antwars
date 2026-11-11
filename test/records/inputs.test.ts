import { describe, expect, it } from "vitest";
import { STORED_ENTRY_BYTES, storedCall } from "../../src/mcp/replies.js";
import { decodeInput, encodeInput, inputName, type RecordInput } from "../../src/records/inputs.js";
import { withReplies } from "../../src/records/service.js";
import { replyLine } from "../../src/replays/recording.js";

const input: RecordInput = {
  id: "2026-10-21T10-00-00-000Z-233", codeVersion: "3365be3b50ca18c20fedb6e12d4b38116dde2791",
  endedAt: Date.parse("2026-10-21T10:30:00.000Z"), lobbyId: null,
  logLines: ['{"type":"header","rulesVersion":17}', '{"type":"order"}'], binary: new Uint8Array([0, 1, 2, 255, 7]),
};

/** Re-frame a hand-edited header around the original binary. */
function withHeader(edit: (header: Record<string, unknown>) => void): Uint8Array {
  const bytes = encodeInput(input);
  const length = new DataView(bytes.buffer).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Record<string, unknown>;
  edit(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.byteLength + input.binary.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength);
  out.set(json, 4); out.set(input.binary, 4 + json.byteLength);
  return out;
}

describe("record input codec", () => {
  it("round-trips every field, public and private, with the binary byte-exact", () => {
    expect(decodeInput(encodeInput(input))).toEqual(input);
    const privateInput = { ...input, lobbyId: "private-lobby" };
    expect(decodeInput(encodeInput(privateInput))).toEqual(privateInput);
    const offset = new Uint8Array(3 + encodeInput(input).byteLength);
    offset.set(encodeInput(input), 3);
    expect(decodeInput(offset.subarray(3))).toEqual(input);
  });

  it("names the stored object <id>.input and refuses an invalid id", () => {
    expect(inputName(input.id)).toBe("2026-10-21T10-00-00-000Z-233.input");
    expect(() => inputName("../x")).toThrow("invalid replay id");
    expect(() => encodeInput({ ...input, id: "bad" })).toThrow("id invalid");
  });

  it("requires lobbyId and never reads a missing or invalid one as public", () => {
    expect(() => decodeInput(withHeader(h => { delete h.lobbyId; }))).toThrow("missing fields: lobbyId");
    expect(() => decodeInput(withHeader(h => { h.lobbyId = ""; }))).toThrow("lobbyId");
    expect(() => decodeInput(withHeader(h => { h.lobbyId = 7; }))).toThrow("lobbyId");
  });

  it("is strict: no rulesVersion or other unknown field, every field required and typed", () => {
    expect(() => decodeInput(withHeader(h => { h.rulesVersion = 17; }))).toThrow("unknown fields: rulesVersion");
    expect(() => decodeInput(withHeader(h => { delete h.codeVersion; }))).toThrow("missing fields: codeVersion");
    expect(() => decodeInput(withHeader(h => { h.codeVersion = "3365be3"; }))).toThrow("full commit SHA");
    expect(() => decodeInput(withHeader(h => { h.endedAt = "2026"; }))).toThrow("endedAt");
    expect(() => decodeInput(withHeader(h => { h.endedAt = 1.5; }))).toThrow("endedAt");
    expect(() => decodeInput(withHeader(h => { h.logLines = [1]; }))).toThrow("logLines");
    expect(() => decodeInput(withHeader(h => { h.version = 3; }))).toThrow("unsupported");
    expect(() => decodeInput(withHeader(h => { h.id = "nope"; }))).toThrow("id invalid");
  });

  it("refuses truncated or unreadable bytes with the reason", () => {
    expect(() => decodeInput(new Uint8Array(2))).toThrow("truncated");
    const bytes = encodeInput(input);
    const length = new DataView(bytes.buffer).getUint32(0);
    expect(() => decodeInput(bytes.subarray(0, 4 + length - 1))).toThrow("header truncated");
    const garbage = new Uint8Array([0, 0, 0, 2, 0x7b, 0xff]);
    expect(() => decodeInput(garbage)).toThrow("header unreadable");
    expect(() => decodeInput(new Uint8Array([0, 0, 0, 2, 0x5b, 0x5d]))).toThrow("not an object");
  });
});

 it("round-trips v2 publication policy and refuses unsafe or incomplete deadlines", () => {
   const early = { ...input, publishAfter: input.endedAt + 300_000, rated: true };
   expect(decodeInput(encodeInput(early))).toEqual(early);
   for (const deadline of [input.endedAt - 1, -1, NaN, Infinity, 1.5]) {
     expect(() => encodeInput({ ...early, publishAfter: deadline })).toThrow("publishAfter");
   }
   expect(() => encodeInput({ ...input, publishAfter: input.endedAt })).toThrow("rated");
   expect(() => encodeInput({ ...input, rated: true })).toThrow("unknown fields");
 });

describe("start ratings in a record input", () => {
  const startRatings = { "alice": { rating: 1512.5, rd: 61.2, ratedMatches: 14 }, "bob #2": { rating: 1500, rd: 350, ratedMatches: 0 } };

  it("round-trip in either version and stay absent from an input that has none", () => {
    for (const base of [input, { ...input, publishAfter: input.endedAt + 60_000, rated: true }]) {
      expect(decodeInput(encodeInput({ ...base, startRatings }))).toEqual({ ...base, startRatings });
      expect(decodeInput(encodeInput(base))).not.toHaveProperty("startRatings");
    }
  });

  it("are refused unless each is exactly a finite rating, a non-negative RD and a whole rated-match count", () => {
    const bad: unknown[] = [[], null, "x", { "": startRatings.alice }, { a: { rating: 1500, rd: 50 } },
      { a: { ...startRatings.alice, extra: 1 } }, { a: { ...startRatings.alice, rd: -1 } }, { a: { ...startRatings.alice, ratedMatches: 1.5 } },
      { a: { ...startRatings.alice, rating: "1500" } }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, startRatings.alice]))];
    for (const value of bad) expect(() => decodeInput(withHeader(header => { header.startRatings = value; }))).toThrow("startRatings invalid");
  });
});

describe("call reply lines in a record input", () => {
  const base = { id: "2026-11-06T00-00-00-000Z-1", codeVersion: "b".repeat(40), endedAt: 5, lobbyId: "secret", logLines: ["{}"], binary: new Uint8Array([7]) };

  it("round-trip in either version and stay absent when none were recorded", () => {
    const replyLines = ["{\"type\":\"reply\",\"agentId\":\"a\",\"tick\":0,\"tool\":\"observe\",\"reply\":{}}"];
    expect(decodeInput(encodeInput({ ...base, replyLines }))).toEqual({ ...base, replyLines });
    expect(decodeInput(encodeInput({ ...base, replyLines, publishAfter: 9, rated: true }))).toEqual({ ...base, replyLines, publishAfter: 9, rated: true });
    expect(decodeInput(encodeInput(base))).toEqual(base);
  });

  it("stores each reply line as its JSON object, refusing anything else on either side", () => {
    const header = (replyLines: unknown[]) => {
      const json = new TextEncoder().encode(JSON.stringify({ format: "antwar.input", version: 1, id: base.id, codeVersion: base.codeVersion,
        endedAt: 5, lobbyId: null, logLines: [], replyLines }));
      const bytes = new Uint8Array(4 + json.byteLength);
      new DataView(bytes.buffer).setUint32(0, json.byteLength);
      bytes.set(json, 4);
      return bytes;
    };
    for (const line of ["{}", [], null, 1]) expect(() => decodeInput(header([line]))).toThrow("record input replyLines must be JSON objects");
    expect(decodeInput(header([{ type: "stub" }])).replyLines).toEqual(['{"type":"stub"}']);
    for (const line of ["[]", "{", "{}{}", "1"]) expect(() => encodeInput({ ...base, replyLines: [line] })).toThrow("replyLines must each be one JSON object");
  });

  it("keeps a backslash-heavy entry within 8,192 bytes as finally stored, in the input and in the record built from it", () => {
    // A reply of quotes and backslashes: every one is escaped once in the entry, and was escaped again when lines were strings.
    const reply = { content: [], structuredContent: { text: '\\"'.repeat(1_900) } };
    const { call } = storedCall("say", { text: '"\\'.repeat(100) }, reply);
    const line = replyLine("seat-a", 3, { tool: "say", receivedAt: 1, answeredAt: 2, ...call });
    const capped = (entry: { arguments?: unknown; reply: unknown }) => Buffer.byteLength(JSON.stringify({ arguments: entry.arguments, reply: entry.reply }));
    // Nothing was dropped to fit: the entry is close to its cap.
    expect(call.trimmed).toBeUndefined();
    expect(capped(call)).toBeGreaterThan(STORED_ENTRY_BYTES - 200);
    expect(capped(call)).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
    // Serialized a second time, as a string, the same entry would be far past its cap.
    expect(Buffer.byteLength(JSON.stringify(line))).toBeGreaterThan(STORED_ENTRY_BYTES * 1.5);

    const bytes = encodeInput({ ...base, replyLines: [line] });
    const headerText = new TextDecoder().decode(bytes.subarray(4, 4 + new DataView(bytes.buffer).getUint32(0)));
    // Stored once, verbatim: the entry's stored bytes are the line's own, its arguments and reply within the cap.
    expect(headerText.split(line)).toHaveLength(2);
    const stored = (JSON.parse(headerText) as { replyLines: { arguments?: unknown; reply: unknown }[] }).replyLines[0]!;
    expect(Buffer.byteLength(JSON.stringify(stored))).toBe(Buffer.byteLength(line));
    expect(capped(stored)).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
    expect(decodeInput(bytes).replyLines).toEqual([line]);

    // The record built from that input carries the line the same way.
    const code = "c".repeat(40);
    const record = new TextDecoder().decode(withReplies(new TextEncoder().encode('{"format":"antwar.match","unavailable":[]}\n'), decodeInput(bytes).replyLines, code));
    expect(record).toBe(`{"format":"antwar.match","unavailable":[],"codeVersion":"${code}","replies":[${line}]}\n`);
    expect(capped((JSON.parse(record) as { replies: { arguments?: unknown; reply: unknown }[] }).replies[0]!)).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
  });
});
