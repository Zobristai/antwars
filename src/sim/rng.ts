/** A deterministic pseudo-random source: the same seed always yields the same sequence. */
export interface Rng {
  /** Next value in [0, 1). */
  next(): number;
}

/**
 * One mulberry32 step on an explicit state, so the PRNG state can live inside
 * sim state. Returns the next unsigned 32-bit value and the new state.
 */
export function nextUint32(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: (t ^ (t >>> 14)) >>> 0, state: next };
}

/** Seeded PRNG (mulberry32). Pure: no clock, I/O or global randomness. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      const step = nextUint32(state);
      state = step.state;
      return step.value / 4294967296;
    },
  };
}
