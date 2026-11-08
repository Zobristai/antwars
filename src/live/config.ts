/**
 * The live stream's own settings (protocol,
 * heartbeat). Game rules live in
 * src/sim/config.ts; these govern only what spectators receive and when.
 */
export interface LiveConfig {
  /** How far the stream runs behind the match, in seconds of match time. 0 is allowed for local development. */
  readonly delaySeconds: number;
  /** When nothing else has been written for this long, the stream writes an SSE comment line. */
  readonly heartbeatMs: number;
  /**
   * A spectator whose unsent stream data passes this many bytes is disconnected
   * and recovers by reconnecting to a full snapshot (at most
   * 1 MiB, about 4 s of stream at the 256 KB/s ceiling).
   */
  readonly maxUnsentBytes: number;
  /**
   * The most tick-message bytes a match releases in any one second (the budget is
   * 256 KB per spectator per second). Below 256,000 by the headroom for one full
   * snapshot (25 KB at most), which a joining spectator gets on top. On-time
   * streams sit far below it; it paces the catch-up after a stall.
   */
  readonly paceBytesPerSecond: number;
  /**
   * Most live spectator streams this server serves at once, /live/* and /watch/live together.
   * Past it a viewer gets a retryable 503 and its page reconnects. 256 bounds the
   * unsent stream data at 256 × maxUnsentBytes, 256 MiB on a 2 GiB slot.
   */
  readonly maxSpectators: number;
  /**
   * Most of those streams one source holds at once (clientSource), so one machine cannot take
   * every place. A relay the entry service signed skips only this bound: the entry bounds its
   * relays per viewer source, as every relayed viewer reaches a slot from the entry's address.
   */
  readonly maxSpectatorsPerSource: number;
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  delaySeconds: 60,
  heartbeatMs: 15_000,
  maxUnsentBytes: 1024 * 1024,
  paceBytesPerSecond: 230_000,
  maxSpectators: 256,
  maxSpectatorsPerSource: 16,
};
