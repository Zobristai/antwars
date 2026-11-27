import { Frame, type Playback } from "./buffer.ts";

/** A seek replays every delta from the beginning. Sample those batches to trim the playback buffer,
 * but keep both the visible frame and its animation time until the requested position is ready. */
export class ReplayFrames {
  frame = new Frame();
  time = 0;
  landed = false;
  private generation = 0;
  private incoming: Frame | null = null;

  /** Checked on arrival: taking a batch can itself start a seek when resuming after a board change. */
  restart(generation: number): boolean {
    if (generation === this.generation) return false;
    this.generation = generation;
    this.incoming = new Frame();
    return true;
  }

  sample(playback: Playback, now: number, seeking: boolean): boolean {
    this.landed = false;
    if (seeking) {
      if (this.incoming) playback.sample(now, this.incoming);
      return this.frame.board !== null;
    }
    const drew = playback.sample(now, this.incoming ?? this.frame);
    if (drew && this.incoming) {
      this.frame = this.incoming;
      this.incoming = null;
      this.landed = true;
    }
    this.time = now;
    return drew;
  }
}
