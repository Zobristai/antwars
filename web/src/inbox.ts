/** Bounded live messages waiting for playback. Overflow retains a valid accepted
 * prefix for the next frame, then requests a fresh snapshot across the skipped gap.
 * Deltas after the gap are refused; neither history nor memory grows while hidden.
 */
import type { StreamMessage } from "../../src/live/format.ts";

/** About 3 s of stream at 10 messages a second; slow drawing can reach this bound even in a visible tab. */
export const INBOX_CAP = 30;

export interface Arrival {
  m: StreamMessage;
  at: number;
}

export class Inbox {
  private items: Arrival[] = [];
  /** After an overflow: tick messages are dropped until a full snapshot arrives. */
  private awaitingFull = false;
  private resync = false;
  /** Messages dropped so far, for diagnostics. */
  dropped = 0;

  constructor(private readonly onOverflow: () => void = () => {}) {}

  get size(): number {
    return this.items.length;
  }

  push(m: StreamMessage, at: number): void {
    if (this.awaitingFull) {
      if (m.full === null) {
        this.dropped++;
        return;
      }
      // A replacement snapshot supersedes any prefix not yet taken.
      this.dropped += this.items.length;
      this.items = [];
      this.awaitingFull = false;
      this.resync = false;
    }
    if (this.items.length >= INBOX_CAP) {
      if (m.full === null) {
        this.dropped++;
        this.overflow();
        return;
      }
      // A full snapshot starts afresh by itself: keep it, drop what it replaces.
      this.dropped += this.items.length;
      this.items = [];
    }
    this.items.push({ m, at });
  }

  /** Keep accepted progress until drained, then resync once across the missing suffix. */
  overflow(): void {
    if (this.awaitingFull) return;
    this.awaitingFull = true;
    this.resync = true;
    this.onOverflow();
  }

  /** Every message waiting, oldest first; the inbox is empty afterwards. */
  drain(): Arrival[] {
    return this.items.splice(0);
  }

  /** True once after an overflow, until a full snapshot arrives: the caller should reopen the stream. */
  takeResync(): boolean {
    const r = this.resync;
    this.resync = false;
    return r;
  }
}
