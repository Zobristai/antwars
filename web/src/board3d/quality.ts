/**
 * The 3D board's quality step-down and its slow fallback.
 *
 * Frame time is measured as the median of a full window of WINDOW intervals between drawn
 * frames, read from the client's one clock (web/src/clock.ts: performance.now, which
 * Playwright steps during capture). Windows do not overlap, and the window is emptied on every
 * tier change, so each decision rests on a full window drawn at the current tier.
 *
 * - The line is 33.3 ms (30 fps); a median of PASS_MS (34.3 ms) or less passes, which absorbs
 *   the jitter of a phone capped at 30 fps.
 * - Hysteresis: a tier steps down only after STEP_WINDOWS consecutive full windows above
 *   PASS_MS, and never steps back up during the page view, so a board sitting at the line does
 *   not keep stepping.
 * - At the last tier the board gives up, and the page falls back to the 2D board, after
 *   STEP_WINDOWS consecutive full windows above PASS_MS (still not smooth with nothing left to
 *   step down), or at once on one full window above FALLBACK_MS (about 55 ms, between display steps).
 * - At any tier, one full window above GIVE_UP_MS (100 ms, 10 fps) gives up at once: no step can
 *   recover that, and with windows counted in frames, stepping down to the last tier first would
 *   leave a slideshow up for minutes (about 160 s at 385 ms a frame from tier 0).
 */

export const WINDOW = 60;
export const PASS_MS = 34.3;
export const STEP_WINDOWS = 2;
export const FALLBACK_MS = 55;
export const GIVE_UP_MS = 100;

export interface Tier {
  /** MSAA samples (1 = off). */
  msaa: number;
  /** Shadow map size, and whether shadows are drawn at all. */
  shadowMap: number;
  shadows: boolean;
  bloom: boolean;
  /** Render resolution as a fraction of the page's internal resolution. */
  scale: number;
}

export const TIERS: readonly Tier[] = [
  { msaa: 4, shadowMap: 2048, shadows: true, bloom: true, scale: 1 },
  { msaa: 1, shadowMap: 1024, shadows: true, bloom: true, scale: 1 },
  { msaa: 1, shadowMap: 1024, shadows: false, bloom: false, scale: 0.75 },
  { msaa: 1, shadowMap: 1024, shadows: false, bloom: false, scale: 0.5 },
];

/** Phones (a coarse pointer, or a short side of 500 px or less) start one tier down. */
export function startTier(o: { coarsePointer: boolean; shortSide: number }): number {
  return o.coarsePointer || o.shortSide <= 500 ? 1 : 0;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type Decision = "hold" | "step" | "fallback";

export class QualityController {
  tier: number;
  /** The median of the last full window, or null before the first. */
  lastMedian: number | null = null;
  private window: number[] = [];
  private slow = 0;
  private last: number | null = null;

  constructor(tier: number) {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, tier));
  }

  /** Intervals collected toward the current window. */
  get filling(): number {
    return this.window.length;
  }

  /** A frame was drawn at clock time t (ms): what to do now. */
  frame(t: number): Decision {
    if (this.last !== null) this.window.push(t - this.last);
    this.last = t;
    if (this.window.length < WINDOW) return "hold";
    const m = median(this.window);
    this.lastMedian = m;
    this.window = [];
    this.slow = m > PASS_MS ? this.slow + 1 : 0;
    // Far too slow for any tier to recover: give up at once, wherever it stands.
    if (m > GIVE_UP_MS) return "fallback";
    // The last tier has nowhere to step: still not smooth after as many windows as a step needs, or far too slow at once, gives up.
    if (this.tier === TIERS.length - 1) return m > FALLBACK_MS || this.slow >= STEP_WINDOWS ? "fallback" : "hold";
    if (this.slow < STEP_WINDOWS) return "hold";
    this.tier++;
    this.slow = 0;
    // The first interval at the new tier starts at its first frame, not across the change.
    this.last = null;
    return "step";
  }
}
