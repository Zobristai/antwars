/** Live-only playout. Recordings keep Playback's deterministic 250 ms mapping.
 * A cursor, not an arrival-time offset: a burst never advances playback by itself.
 * The 8% rate bound and 500 ms response are implementation choices, not product requirements.
 */
export const LIVE_BUFFER_MS = 1500;
export const LIVE_RATE_LIMIT = 0.08;
const RESPONSE_MS = 500;
const ERROR_SCALE_MS = 5000;

export class Playout {
  private firstMs = 0;
  private arrivedAt = 0;
  private cursor: number | null = null;
  private lastNow = 0;
  private speed = 1;

  reset(firstMs: number, arrivedAt: number): void {
    this.firstMs = firstMs;
    this.arrivedAt = arrivedAt;
    this.cursor = null;
    this.lastNow = arrivedAt;
    this.speed = 1;
  }

  /** A reconnect to an already-ended match resumes beyond its result beat, not another startup buffer. */
  resumeEnded(targetMs: number, nowMs: number): void {
    this.cursor = targetMs;
    this.lastNow = nowMs;
    this.speed = 1;
  }

  get ready(): boolean { return this.cursor !== null; }
  get rate(): number { return this.speed; }

  /** Idempotent at the same now; the caller supplies match and client milliseconds explicitly. */
  at(now: number, newestMs: number, ended: boolean): number | null {
    if (this.cursor === null) {
      // Start once the buffer holds LIVE_BUFFER_MS of ticks, or once that long has passed since the
      // full snapshot arrived, then play what exists. At the stream's pace both happen together. The
      // wait bounds a terminal stream that cannot fill a buffer, and a running stream that a slow
      // page takes slower than it arrives, which would otherwise overflow and resync before it ever
      // filled. A running stream still needs footage newer than its snapshot: elapsed time
      // alone is not newer footage.
      const waited = now - this.arrivedAt >= LIVE_BUFFER_MS && (ended || newestMs > this.firstMs);
      if (newestMs - this.firstMs < LIVE_BUFFER_MS && !waited) return null;
      this.cursor = this.firstMs;
      this.lastNow = now;
      return this.cursor;
    }
    // This advances one cursor, not a simulation loop. Consume actual elapsed
    // time even on slow frames: capping each step permanently loses wall time
    // and delays the ending. Live data stays clamped below; feed intake bounds
    // and resynchronizes a resumed tab's backlog separately.
    const elapsed = Math.max(0, now - this.lastNow);
    this.lastNow = Math.max(this.lastNow, now);
    const error = newestMs - this.cursor - LIVE_BUFFER_MS;
    const wanted = ended ? 1 : 1 + Math.max(-LIVE_RATE_LIMIT, Math.min(LIVE_RATE_LIMIT, error / ERROR_SCALE_MS));
    this.speed += (wanted - this.speed) * (1 - Math.exp(-elapsed / RESPONSE_MS));
    const next = this.cursor + elapsed * this.speed;
    // Never extrapolate live data. A terminal clock may continue so collapse/result animations finish.
    this.cursor = ended ? next : Math.max(this.cursor, Math.min(next, newestMs));
    return this.cursor;
  }
}
