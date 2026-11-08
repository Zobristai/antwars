import { SUB } from "./config.js";

/** Integer square root (floor) for non-negative safe integers. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x -= 1;
  while ((x + 1) * (x + 1) <= n) x += 1;
  return x;
}

/** Integer division truncating toward zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Unit-vector scale: directions are integer vectors of length ~UNIT. */
export const UNIT = 1000;

export interface Vec {
  readonly x: number;
  readonly y: number;
}

export const ZERO: Vec = { x: 0, y: 0 };

/**
 * The one direction normaliser: (dx, dy) rescaled to length
 * `length`, keeping its heading, or zero for a zero vector or length. The
 * result is decided by exact integer comparison. The smaller component is the integer nearest to
 * length × minor / √(dx² + dy²), decided exactly from the squared length (BigInt,
 * so no product overflows), and the larger is the integer nearest to
 * √(length² − minor²). The result's length is always within half a unit of
 * `length`, and a short input such as (-2, -2) keeps its heading.
 */
export function scaleTo(dx: number, dy: number, length: number): Vec {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if ((ax === 0 && ay === 0) || length <= 0) return ZERO;
  const xMajor = ax >= ay;
  const minorIn = xMajor ? ay : ax;
  // A float first guess, then corrected exactly to the nearest m:
  // (2m - 1)² l2 <= target < (2m + 1)² l2.
  let m = Math.min(length, Math.round((length * minorIn) / Math.sqrt(ax * ax + ay * ay)));
  const l2n = ax * ax + ay * ay, span = 2 * length + 1;
  if (l2n * span * span < 2 ** 52) {
    // Every product below is an integer no larger than (2·length + 1)² l2 < 2^52, so Number arithmetic is exact.
    const target = 4 * length * length * minorIn * minorIn;
    while (m < length && (2 * m + 1) * (2 * m + 1) * l2n <= target) m += 1;
    while (m > 0 && (2 * m - 1) * (2 * m - 1) * l2n > target) m -= 1;
  } else {
    const l2 = BigInt(ax) * BigInt(ax) + BigInt(ay) * BigInt(ay);
    const target = 4n * BigInt(length) * BigInt(length) * BigInt(minorIn) * BigInt(minorIn);
    const odd = (k: number): bigint => BigInt(2 * k + 1) * BigInt(2 * k + 1) * l2;
    while (m < length && odd(m) <= target) m += 1;
    while (m > 0 && odd(m - 1) > target) m -= 1;
  }
  const rest = length * length - m * m;
  const root = isqrt(rest);
  const major = rest - root * root > root ? root + 1 : root;
  const vx = xMajor ? major : m;
  const vy = xMajor ? m : major;
  return { x: dx < 0 ? -vx : vx, y: dy < 0 ? -vy : vy };
}

/** Heading of (dx, dy) at length UNIT, or zero. */
export function direction(dx: number, dy: number): Vec {
  return scaleTo(dx, dy, UNIT);
}

/**
 * Per-tick velocity of `speed` sub-tile units along a nonzero `dir`, zero for a
 * zero `dir`. Every step lies within half a unit of `speed`, so two steps differ
 * by at most one unit, and the step keeps `dir`'s heading.
 */
export function velocity(dir: Vec, speed: number): Vec {
  return scaleTo(dir.x, dir.y, speed);
}

/** Tile coordinate containing a sub-tile coordinate. */
export function tileOf(p: number): number {
  return Math.floor(p / SUB);
}

/** Sub-tile coordinate of a tile's centre. */
export function tileCentre(t: number): number {
  return t * SUB + SUB / 2;
}

/** Chebyshev distance between two tiles. */
export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Whether tile b lies within r tiles (Euclidean) of tile a. */
export function withinTiles(ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= r * r;
}

/** Euclidean distance between two sub-tile points, floored. */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}
