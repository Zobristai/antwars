/** Exact summary figures for the server's tick reports. median and percentile take values already sorted ascending. */

/** Median of ascending-sorted values: the middle value, or the mean of the two middle values. n >= 1. */
export function median(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile of ascending-sorted values: sorted[ceil(n * p / 100) - 1]. n >= 1, 0 < p <= 100. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  return sorted[Math.ceil((sorted.length * p) / 100) - 1]!;
}

/** One closed stretch of a match: its ticks fromTick..toTick (counted from 1, inclusive) and their nearest-rank p99 time. */
export interface TickStretch {
  /** k, from 1. */
  readonly index: number;
  readonly fromTick: number;
  readonly toTick: number;
  readonly p99Ms: number;
}

/**
 * Cuts one match's whole-tick times, in tick order, into consecutive stretches of
 * `length` ticks (a whole number >= 1) from its first tick; the last may be shorter.
 */
export class TickStretches {
  private readonly length: number;
  private times: number[] = [];
  private ticks = 0;
  private closed = 0;

  constructor(length: number) {
    this.length = length;
  }

  /** Adds the next tick's time; returns the stretch that tick completes, or null. */
  add(ms: number): TickStretch | null {
    this.times.push(ms);
    this.ticks += 1;
    return this.times.length === this.length ? this.close() : null;
  }

  /** At match end: closes the final, partial stretch, or returns null when the last tick completed a stretch. */
  finish(): TickStretch | null {
    return this.times.length === 0 ? null : this.close();
  }

  private close(): TickStretch {
    const stretch = {
      index: ++this.closed,
      fromTick: this.ticks - this.times.length + 1,
      toTick: this.ticks,
      p99Ms: percentile(Float64Array.from(this.times).sort(), 99),
    };
    this.times = [];
    return stretch;
  }
}
