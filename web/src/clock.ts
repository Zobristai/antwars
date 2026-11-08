/**
 * The client's one animation clock.
 * Every motion and effect takes its time from here, and this reads only
 * performance.now(), which Playwright's page.clock replaces and steps during
 * capture. Server-deadline UI uses the wall-clock accessor below, never the
 * animation epoch. Nothing else in web/src reads time; effect randomness is seeded.
 * The one unseeded source, discoveryRandom(), only picks which live match Watch opens.
 */
import { createRng, type Rng } from "../../src/sim/rng.ts";

export interface Clock {
  /** Milliseconds since the client started. */
  now(): number;
}

export function createClock(): Clock {
  const t0 = performance.now();
  return { now: () => performance.now() - t0 };
}

/** Epoch milliseconds for server deadlines (lobby countdowns), not animation. Page.clock also controls this in capture. */
export function wallClockNow(): number { return Date.now(); }

/** Unseeded randomness for choosing a live match to watch; never for motion or effects. */
export function discoveryRandom(): number { return Math.random(); }

/** Deterministic randomness for an effect, keyed by stable numbers (tick, ids). */
export function effectRng(...keys: number[]): Rng {
  let h = 0x811c9dc5;
  for (const k of keys) {
    h = Math.imul(h ^ (k >>> 0), 0x01000193);
    h ^= h >>> 15;
  }
  return createRng(h >>> 0);
}
