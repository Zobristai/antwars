import { deflateSync, inflateSync } from "node:zlib";
import { MAX_BOARD_SIDE_TILES } from "../sim/mapBoard.js";

/** MCP-only projection. Simulation and replay consumers retain territoryRows. */
export interface PackedTerritory {
  readonly encoding: "base64-bitset-lsb0";
  readonly width: number;
  readonly height: number;
  readonly data: string;
  /** Per colony: base64 of zlib-compressed little-endian uint16 tile-index deltas, starting from zero. */
  readonly enemies?: Readonly<Record<number, string>>;
}

export const TERRITORY_TEXT = "map:true territory.data=own base64-bitset-lsb0 (i=y*width+x). enemies[n]=sighted tiles of colony n (ant/queen number): base64, inflate zlib, sum uint16LE deltas from 0.";

function tileCount(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_BOARD_SIDE_TILES || height > MAX_BOARD_SIDE_TILES) {
    throw new Error(`Invalid territory dimensions: expected integers in 1..${MAX_BOARD_SIDE_TILES}`);
  }
  return width * height;
}

/** The own bitset has fixed size. Each enemy stream contains only its sighted indices. */
export function packTerritory(rows: readonly string[], width: number, height: number, sightedEnemies?: Readonly<Record<number, readonly number[]>>): PackedTerritory {
  const count = tileCount(width, height);
  if (rows.length !== height || rows.some(row => row.length !== width || /[^#.]/.test(row))) {
    throw new Error("Invalid territory rows");
  }
  const bytes = Buffer.alloc(Math.ceil(count / 8));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rows[y]![x] === "#") {
      const index = y * width + x;
      bytes[index >> 3]! |= 1 << (index & 7);
    }
  }
  const territory = { encoding: "base64-bitset-lsb0" as const, width, height, data: bytes.toString("base64") };
  if (sightedEnemies === undefined) return territory;
  const enemies: Record<number, string> = {};
  for (const [colony, indices] of Object.entries(sightedEnemies)) {
    // takeView collects in tile order. Encode only those tiles; repeated gaps also compress on dense maps.
    if (!indices.length) continue;
    const gaps = Buffer.alloc(indices.length * 2);
    let previous = 0;
    for (const [k, i] of indices.entries()) {
      if (!Number.isInteger(i) || i < 0 || i >= count || (k > 0 && i <= previous)) throw new RangeError("Invalid enemy tile index");
      gaps.writeUInt16LE(i - previous, k * 2);
      previous = i;
    }
    enemies[Number(colony)] = deflateSync(gaps).toString("base64");
  }
  return { ...territory, enemies };
}

/** Reference decoder for scripted clients and exact-ownership checks. */
export function unpackTerritory(territory: PackedTerritory): string[] {
  const { encoding, width, height, data } = territory;
  const count = tileCount(width, height);
  if (encoding !== "base64-bitset-lsb0" || typeof data !== "string" || data.length !== 4 * Math.ceil(Math.ceil(count / 8) / 3)) {
    throw new Error("Invalid territory encoding or length");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length !== Math.ceil(count / 8) || bytes.toString("base64") !== data ||
    (count % 8 !== 0 && (bytes.at(-1)! >> (count % 8)) !== 0)) {
    throw new Error("Invalid territory data or padding");
  }
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const index = y * width + x;
    return (bytes[index >> 3]! & (1 << (index & 7))) === 0 ? "." : "#";
  }).join(""));
}

/** Expand one enemy's sighted tile indices. At most one uint16 per board tile may be inflated. */
export function unpackEnemyTiles(territory: PackedTerritory, colony: number): number[] {
  const count = tileCount(territory.width, territory.height);
  const data = territory.enemies?.[colony];
  if (data === undefined) return [];
  const gaps = inflateSync(Buffer.from(data, "base64"), { maxOutputLength: count * 2 });
  if (!gaps.length || gaps.length % 2) throw new Error("Invalid enemy territory length");
  const tiles: number[] = [];
  let index = 0;
  for (let k = 0; k < gaps.length; k += 2) {
    const gap = gaps.readUInt16LE(k);
    index += gap;
    if ((k > 0 && gap === 0) || index >= count) throw new Error("Invalid enemy territory index");
    tiles.push(index);
  }
  return tiles;
}
