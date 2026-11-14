// Statistics shared by the tuning harness commands. Pure functions, unit-tested in test/tuning/harness.test.ts.

/** The median of a non-empty list (mean of the middle two for an even count). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("median of an empty list");
  const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The value at quantile p (0..1) by the nearest-rank method. */
export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new RangeError("quantile of an empty list");
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

/** Median, p99 and max of per-tick times, rounded to 0.1 µs. */
export function tickSummary(ms: readonly number[]): { readonly n: number; readonly median: number; readonly p99: number; readonly max: number; readonly mean: number } {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return { n: ms.length, median: r(median(ms)), p99: r(quantile(ms, 0.99)), max: r(Math.max(...ms)), mean: r(ms.reduce((a, b) => a + b, 0) / ms.length) };
}

/** One timed segment of a paired round: its workload weight and each side's mean tick time. */
export interface PairedSegment { readonly weight: number; readonly referenceMeanMs: number; readonly candidateMeanMs: number }

/**
 * A round's paired gain: 1 − (weighted candidate tick time / weighted reference tick time) over the round's
 * segments, each weighted by its share of the workload. Positive means the candidate is faster.
 */
export function roundGain(segments: readonly PairedSegment[]): number {
  if (segments.length === 0) throw new RangeError("a round needs at least one segment");
  let ref = 0, cand = 0;
  for (const s of segments) { ref += s.weight * s.referenceMeanMs; cand += s.weight * s.candidateMeanMs; }
  if (!(ref > 0)) throw new RangeError("reference time must be positive");
  return 1 - cand / ref;
}

/**
 * The noise check's verdict over every base-against-itself median paired gain: their range and the noise bar,
 * the largest absolute median. A candidate's median paired gain must exceed the bar to count as a gain.
 */
export function noiseBar(medians: readonly number[]): { readonly medians: readonly number[]; readonly min: number; readonly max: number; readonly range: number; readonly bar: number } {
  if (medians.length === 0) throw new RangeError("no noise medians");
  const min = Math.min(...medians), max = Math.max(...medians);
  return { medians, min, max, range: max - min, bar: Math.max(Math.abs(min), Math.abs(max)) };
}

/** Repetitions each admitted participant runs so that at least `minimum` medians exist. */
export function repetitionsFor(admitted: number, minimum = 3): number {
  if (admitted < 1) throw new RangeError("no participants admitted");
  return Math.ceil(minimum / admitted);
}

/** Order of the two sides in round r: alternating, so neither side always runs first. */
export function sideOrder(round: number): readonly ["reference", "candidate"] | readonly ["candidate", "reference"] {
  return round % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"];
}
