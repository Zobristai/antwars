import { describe, expect, it } from "vitest";
import { packTerritory, unpackTerritory, type PackedTerritory } from "../../src/mcp/territory.js";

describe("lossless bounded MCP territory", () => {
  it("pins row-major, least-significant-first bytes independently of the decoder", () => {
    // Nine cells span a byte, not three separately padded rows: bits 0,4,8.
    const packed = packTerritory(["#..", ".#.", "..#"], 3, 3);
    expect(packed).toEqual({ encoding: "base64-bitset-lsb0", width: 3, height: 3, data: "EQE=" });
    expect(unpackTerritory(packed)).toEqual(["#..", ".#.", "..#"]);
  });

  it.each([[1, 1], [7, 3], [64, 48], [128, 96], [256, 192], [256, 256]])("roundtrips every cell at %i×%i without mutating input", (width, height) => {
    let seed = 172;
    const randomBit = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 31; };
    for (const pattern of [() => 0, () => 1, (x: number, y: number) => (x + y) % 2, randomBit]) {
      const rows = Object.freeze(Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => pattern(x, y) ? "#" : ".").join("")));
      const packed = packTerritory(rows, width, height);
      expect(packed.data.length).toBe(4 * Math.ceil(Math.ceil(width * height / 8) / 3));
      expect(unpackTerritory(packed)).toEqual(rows);
      if (width === 256 && height === 192) expect(packed.data.length).toBe(8192);
    }
  });

  it("refuses invalid rows rather than silently losing ownership", () => {
    for (const rows of [[], ["#"], ["#x"], ["##", ".."]]) expect(() => packTerritory(rows, 2, 1)).toThrow();
    for (const width of [0, -1, 257, 1.5, NaN, Infinity]) expect(() => packTerritory(["#"], width, 1)).toThrow();
  });

  it("refuses ambiguous, truncated, overlong or noncanonical wire data", () => {
    const packed = packTerritory(["#"], 1, 1);
    for (const patch of [
      { encoding: "other" }, { width: 0 }, { height: 257 }, { data: "" },
      { data: "AQ==\n" }, { data: "AQAA" }, { data: "A!==" }, { data: "AR==" }, { data: "gQ==" },
    ]) expect(() => unpackTerritory({ ...packed, ...patch } as PackedTerritory)).toThrow();
  });
});
