/**
 * The live client's inbox: decoded stream messages wait here, with their
 * arrival times, until the frame loop hands them to the playback buffer.
 *
 * Bounded: while a tab is hidden the
 * browser draws no frames but the stream keeps delivering. Once more than
 * INBOX_CAP messages wait, the backlog is dropped, later tick messages are
 * ignored until a full snapshot arrives, and the frame loop is asked once
 * (takeResync) to reopen the stream, whose first message is a full snapshot
 * at the delayed live position. Memory and catch-up work stay bounded by the
 * cap however long the tab was away; the skipped stretch is not replayed, so
 * the timeline has no entries for it. onOverflow lets the owner stop the
 * stream at once (web/src/stream.ts suspend), so nothing more is decoded until
 * the reopen; the stream calls overflow() itself when too many messages wait
 * to be decoded.
 */
import type { StreamMessage } from "../../src/live/format.ts";

/** About 3 s of stream at 10 messages a second; a visible tab drains every frame and never comes close. */
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

  /** Drop the backlog, wait for a full snapshot, and tell the owner (each overflow asks for one reopen). */
  overflow(): void {
    this.dropped += this.items.length;
    this.items = [];
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
