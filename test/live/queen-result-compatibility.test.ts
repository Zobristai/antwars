import { describe, expect, it } from "vitest";
import { DECIDED_BY, decodeMessage, encodeMessage, encodePublicMessage, type StreamMessage, type StreamResult } from "../../src/live/format.ts";
import { decodeMessage as oldDecode, encodeMessage as oldEncode } from "./fixtures/pre-queen-ranking-format.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";
import { resultHow } from "../../web/src/story.ts";

const opening = decodeMessage(scale2Packets(1)[0]!);
function message(decidedBy: StreamResult["decidedBy"], full: boolean, rated: boolean): StreamMessage {
  const result: StreamResult = { winner: 1, reason: decidedBy === "idle" ? "idle" : "time_up", decidedBy, tick: 9, nextStartMs: 123456,
    ...(rated ? { ratingChanges: [{ agent: 0, before: 1500, after: 1490 }] } : {}) };
  return { tick: 10, ants: opening.ants, full: full ? { ...opening.full!, result, setup: { ...opening.full!.setup, rated } } : null,
    events: [{ kind: "end", result }] };
}

describe("result compatibility with an already-loaded decoder", () => {
  for (const full of [false, true]) for (const rated of [false, true]) {
    it(`reads every result reason (${full ? "snapshot" : "delta"}, rated=${rated})`, () => {
      // Any future reason must also work in the frozen decoder, not just round-trip in the new one.
      for (const decidedBy of DECIDED_BY) for (const encode of [encodeMessage, encodePublicMessage]) {
        const original = message(decidedBy, full, rated);
        const bytes = encode(original);
        const current = decodeMessage(bytes), legacy = oldDecode(bytes);
        const currentEnd = current.events[0]!;
        const legacyEnd = legacy.events[0]!;
        if (currentEnd.kind !== "end" || legacyEnd.kind !== "end") throw new Error("missing end event");
        expect(currentEnd.result).toEqual(original.events[0]!.kind === "end" ? original.events[0]!.result : null);
        expect(legacyEnd.result).toEqual({ ...currentEnd.result, decidedBy: decidedBy === "queen_kills" ? "kills" : decidedBy });
        if (full) {
          expect(current.full!.result).toEqual(currentEnd.result);
          expect(legacy.full!.result).toEqual(legacyEnd.result);
        }
        if (decidedBy === "queen_kills") {
          expect(resultHow(currentEnd.result, true)).toBe("Time-up · decided on queen kills");
          expect(resultHow(legacyEnd.result, true)).toBe("Time-up · decided on kills");
        } else {
          // Unmarked historical results retain their exact wire bytes.
          expect(encodeMessage(original)).toEqual(oldEncode(original as Parameters<typeof oldEncode>[0]));
        }
      }
    });
  }

  it("keeps snapshot and end-event markers independent", () => {
    for (const snapshotQueen of [false, true]) {
      const m = message(snapshotQueen ? "queen_kills" : "kills", true, false);
      const end = m.events[0]!;
      if (end.kind !== "end") throw new Error("missing end");
      end.result = { ...end.result, decidedBy: snapshotQueen ? "kills" : "queen_kills" };
      expect(decodeMessage(encodeMessage(m))).toEqual(m);
    }
  });

  it("rejects ambiguous end reasons rather than relabeling another result", () => {
    const m = message("queen_kills", false, false);
    m.events.push({ kind: "end", result: { winner: 1, reason: "time_up", decidedBy: "kills", tick: 9, nextStartMs: null } });
    expect(() => encodeMessage(m)).toThrow("mixed end-event result reasons");
  });

  it("rejects misplaced markers and markers on non-kill results", () => {
    const withoutEnd = { ...opening, events: [] };
    for (const flag of [4, 8]) {
      const bytes = encodeMessage(withoutEnd); bytes[3] = bytes[3]! | flag;
      expect(() => decodeMessage(bytes)).toThrow(/queen-kill/);
    }
    for (const flag of [4, 8]) {
      const bytes = encodeMessage(message("territory", true, false)); bytes[3] = bytes[3]! | flag;
      expect(() => decodeMessage(bytes)).toThrow("invalid queen-kill result marker");
    }
  });
});
