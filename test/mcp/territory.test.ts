import { describe, expect, it } from "vitest";
import { deflateSync, inflateSync } from "node:zlib";
import { unpackEnemyTiles, packTerritory, unpackTerritory, type PackedTerritory } from "../../src/mcp/territory.js";

describe("lossless bounded MCP territory", () => {
  it("pins row-major, least-significant-first bytes independently of the decoder", () => {
    // Nine cells span a byte, not three separately padded rows: bits 0,4,8.
    const packed = packTerritory(["#..", ".#.", "..#"], 3, 3);
    expect(packed).toEqual({ encoding: "base64-bitset-lsb0", width: 3, height: 3, data: "EQE=" });
    expect(unpackTerritory(packed)).toEqual(["#..", ".#.", "..#"]);
  });

  it("packs sighted holdings under their colony numbers in the same unpadded tile order", () => {
    const packed = packTerritory([".#.", "...", "..."], 3, 3, { 0: [0, 8], 2: [3, 7] });
    expect(packed.data).toBe("AgA=");
    const gaps = (colony: number) => [...inflateSync(Buffer.from(packed.enemies![colony]!, "base64"))];
    expect(gaps(0)).toEqual([0, 0, 8, 0]);
    expect(gaps(2)).toEqual([3, 0, 4, 0]);
    expect(unpackEnemyTiles(packed, 0)).toEqual([0, 8]);
    expect(unpackEnemyTiles(packed, 2)).toEqual([3, 7]);
    expect(unpackEnemyTiles(packed, 3)).toEqual([]);
    expect(packTerritory(["."], 1, 1, {}).enemies).toEqual({});
  });

  it("roundtrips the largest tile index and fragmented holdings across the largest board", () => {
    const side = 256, count = side ** 2;
    const rows = Array(side).fill(".".repeat(side));
    const alternating = Array.from({ length: count / 2 }, (_, i) => i * 2);
    const packed = packTerritory(rows, side, side, { 1: [count - 1], 2: alternating });
    expect(unpackEnemyTiles(packed, 1)).toEqual([65535]);
    expect(unpackEnemyTiles(packed, 2)).toEqual(alternating);
  });

  it("refuses truncated deltas, duplicate tiles, out-of-board indices and oversized streams", () => {
    const packed = packTerritory([".."], 2, 1);
    for (const bytes of [[], [0], [1, 0, 0, 0], [2, 0], [0, 0, 1, 0, 1, 0]]) {
      const enemies = { 1: deflateSync(Buffer.from(bytes)).toString("base64") };
      expect(() => unpackEnemyTiles({ ...packed, enemies }, 1)).toThrow();
    }
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
