import { describe, expect, it } from "vitest";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";

describe("recording container", () => {
  it("packs a recorded match as length-prefixed messages", () => {
    const a = Uint8Array.from([0x41, 0x57, 1, 2, 3]);
    const b = Uint8Array.from([9]);
    const empty = new Uint8Array(0);
    const packed = packMessages([a, empty, b]);
    expect(Array.from(packed)).toEqual([5, 0, 0, 0, 0x41, 0x57, 1, 2, 3, 0, 0, 0, 0, 1, 0, 0, 0, 9]);
    expect(unpackMessages(packed).map((m) => Array.from(m))).toEqual([Array.from(a), [], Array.from(b)]);
  });
});
