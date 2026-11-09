import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { packMessages } from "../../src/live/snapshot.ts";
import { binaryRecord } from "../../src/replays/history.ts";
import { abandonBinary, abandonRecord, assertConsistent, isAbandonedRecord, unjoinedColonies } from "../../src/replays/abandonRecording.ts";
import { RATINGS_UNAVAILABLE } from "../../src/records/service.ts";
import { ratedRecording, REPLAY_ID } from "./never-joined-fixture.ts";

function frames(binary: Uint8Array): Uint8Array[] {
  const bytes = new Uint8Array(gunzipSync(binary));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = view.getUint32(offset, true);
    out.push(bytes.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return out;
}

describe("abandoning a rated recording", () => {
  it("rewrites the binary to the house-mode abandoned shape and keeps every other message's bytes", () => {
    const { binary } = ratedRecording();
    const before = binaryRecord({ id: REPLAY_ID, binary });
    expect(before.setup!.rated).toBe(true);
    expect(before.result!.ratingChanges).toBeDefined();
    const { body, rewritten, messages } = abandonBinary(binary);
    expect(body).not.toBeNull();
    // The opening snapshot (rated setup) and the final message (end result) only.
    expect(rewritten).toBe(2);
    const after = binaryRecord({ id: REPLAY_ID, binary: body! });
    expect(after.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick: before.result!.tick });
    expect(after.setup!.rated).toBe(false);
    expect({ ...after.setup, rated: true }).toEqual(before.setup);
    expect(after.seats).toEqual(before.seats);
    // Ticks and events are kept; only the end event's result changes.
    const strip = (record: typeof before) => record.events.filter(entry => entry.event.kind !== "end");
    expect(strip(after)).toEqual(strip(before));
    expect(after.events.map(entry => entry.tick)).toEqual(before.events.map(entry => entry.tick));
    const old = frames(binary), now = frames(body!);
    expect(now).toHaveLength(messages);
    for (let i = 1; i < old.length - 1; i++) expect(now[i]).toEqual(old[i]);
    expect(abandonBinary(body!).body).toBeNull();
  });

  it("rewrites the record to the same result and an unrated setup, consistent with the rewritten binary", () => {
    const { binary, record } = ratedRecording();
    const withNote = { ...record, unavailable: [...record.unavailable, RATINGS_UNAVAILABLE] };
    const abandoned = abandonRecord(withNote);
    expect(abandoned.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick: record.result!.tick });
    expect(abandoned.setup!.rated).toBe(false);
    expect(abandoned.unavailable).not.toContain(RATINGS_UNAVAILABLE);
    expect(abandoned.seats).toEqual(record.seats);
    const end = abandoned.events.find(entry => entry.event.kind === "end")!.event;
    expect(end).toMatchObject({ result: { winner: null, reason: "abandoned", decidedBy: "draw" } });
    expect(end.kind === "end" && end.result.ratingChanges).toBe(undefined);
    expect(isAbandonedRecord(record)).toBe(false);
    expect(isAbandonedRecord(abandoned)).toBe(true);
    expect(() => assertConsistent(REPLAY_ID, abandonBinary(binary).body!, abandoned)).not.toThrow();
    expect(() => assertConsistent(REPLAY_ID, binary, abandoned)).toThrow(/disagree on the result/);
  });

  it("finds the colony with no seat and no join", () => {
    expect(unjoinedColonies(ratedRecording([1]).record, [0, 1])).toEqual([0]);
    expect(unjoinedColonies(ratedRecording([0, 1]).record, [0, 1])).toEqual([]);
  });

  it("refuses a binary whose messages do not re-encode to their stored bytes", () => {
    const old = frames(ratedRecording().binary);
    // A delta message carrying the setup-redaction flag decodes, but the codec never writes it that way.
    const tampered = old.map((frame, i) => i === 1 ? frame.map((byte, at) => at === 3 ? byte | 2 : byte) : frame);
    expect(() => abandonBinary(new Uint8Array(gzipSync(packMessages(tampered))))).toThrow(/does not re-encode/);
  });

  it("refuses a binary with no terminal result", () => {
    const old = frames(ratedRecording().binary);
    expect(() => abandonBinary(new Uint8Array(gzipSync(packMessages(old.slice(0, -1)))))).toThrow(/no terminal result/);
  });
});
