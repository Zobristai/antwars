import { MAX_BOARD_SIDE_TILES } from "../sim/mapBoard.js";

/** MCP-only projection. Simulation and replay consumers retain territoryRows. */
export interface PackedTerritory {
  readonly encoding: "base64-bitset-lsb0";
  readonly width: number;
  readonly height: number;
  readonly data: string;
  /** Same dimensions and bit order as data, keyed by enemy colony number. */
  readonly enemies?: Readonly<Record<number, string>>;
}

export const TERRITORY_TEXT = "map:true territory, base64-bitset-lsb0: i=y*width+x, bit i%8 of byte i>>3. data=own; enemies[n]=sighted tiles of colony n (ant/queen number); missing=none seen.";

function tileCount(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_BOARD_SIDE_TILES || height > MAX_BOARD_SIDE_TILES) {
    throw new Error(`Invalid territory dimensions: expected integers in 1..${MAX_BOARD_SIDE_TILES}`);
  }
  return width * height;
}

/** Fixed size for every ownership pattern, including a checkerboard. */
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
    const mask = Buffer.alloc(bytes.length);
    for (const i of indices) mask[i >> 3]! |= 1 << (i & 7);
    enemies[Number(colony)] = mask.toString("base64");
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
