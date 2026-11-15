/**
 * A landed flyer's lockout, on both boards: the time after a landing in which it may not take off,
 * drawn as a white dial around the flyer that drains against the playback clock and is gone from
 * the first tick it may take off again. It is read from the sampled message's flyer states alone
 * (Frame.ants), so it is right from the first frame after a seek or a join. Each board draws it
 * through its own ground projection, over its ants, on its screen-space layer.
 */
import { Graphics } from "pixi.js";
import { TICK_MS } from "../../src/live/snapshot.ts";
import type { StreamFlyer } from "../../src/live/format.ts";
import type { Frame } from "./buffer.ts";
import { flyerOf } from "./flyer-state.ts";

/**
 * The span the dial drains over: the rules' 30-tick lockout. A longer lockout shows the dial
 * full until this much of it is left.
 */
export const LOCKOUT_DIAL_MS = 30 * TICK_MS;

/** One locked-out flyer as a frame shows it. */
export interface Lockout {
  /** Its index in the frame's ant arrays. */
  index: number;
  antId: number;
  /** Position in tiles where its body is drawn: the frame's drawX and drawY, else x and y. */
  x: number;
  y: number;
  /** Playback time until it may take off again, above 0. */
  remainingMs: number;
  /** The dial's remaining share, above 0 and at most 1. */
  share: number;
}

/**
 * Each ant the frame draws that is locked out at the frame's playback time, in frame order, its
 * flyer state found by id (flyerOf), so a colony's view puts dials on the right ants. out is reused.
 */
export function lockouts(frame: Frame, out: Lockout[] = []): Lockout[] {
  out.length = 0;
  if (!frame.ants?.flyers) return out;
  for (let i = 0; i < frame.count; i++) {
    const remainingMs = lockoutRemainingMs(flyerOf(frame, i), frame.renderMs);
    if (remainingMs > 0) out.push({ index: i, antId: frame.id[i]!, x: frame.drawX?.[i] ?? frame.x[i]!, y: frame.drawY?.[i] ?? frame.y[i]!, remainingMs, share: Math.min(1, remainingMs / LOCKOUT_DIAL_MS) });
  }
  return out;
}

/**
 * Playback time until a flyer may take off again, 0 when it is not locked out. Its take-off tick
 * is the first simulation tick it may take off on, which begins once the message of that tick has
 * been reached (a message's tick is the state after the tick before it).
 */
export function lockoutRemainingMs(flyer: StreamFlyer | null, renderMs: number): number {
  if (flyer?.state !== "lockedOut" || flyer.takeOffTick === undefined) return 0;
  return Math.max(0, flyer.takeOffTick * TICK_MS - renderMs);
}

/** The dial's radius in screen px around a flyer whose body is antPx long on screen. */
export function dialRadiusPx(antPx: number): number {
  return Math.max(7, 0.6 * antPx + 3);
}

/** One dial as drawn, in screen px. */
export interface Dial {
  antId: number;
  x: number;
  y: number;
  r: number;
  share: number;
}

/** The dials of one board, on one screen-space layer. */
export class LockoutDials {
  readonly layer = new Graphics();
  /** The dials drawn this frame. */
  readonly dials: Dial[] = [];
  private readonly found: Lockout[] = [];

  /**
   * project maps a tile point to the screen as the board draws its ground there; antPx gives the
   * on-screen length of an ant standing at a tile point.
   */
  update(frame: Frame, project: (tx: number, ty: number) => [number, number], antPx: (tx: number, ty: number) => number): void {
    const g = this.layer;
    g.clear();
    this.dials.length = 0;
    for (const l of lockouts(frame, this.found)) {
      const [x, y] = project(l.x, l.y);
      const r = dialRadiusPx(antPx(l.x, l.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) continue;
      this.dials.push({ antId: l.antId, x, y, r, share: l.share });
      // A dark backing and a faint full track, so the dial reads on any ground, then what is left of the lockout,
      // clockwise from the top.
      g.circle(x, y, r).stroke({ width: 4.5, color: 0x000000, alpha: 0.5 });
      g.circle(x, y, r).stroke({ width: 1.5, color: 0xffffff, alpha: 0.3 });
      const start = -Math.PI / 2, end = start + l.share * 2 * Math.PI;
      g.moveTo(x + r * Math.cos(start), y + r * Math.sin(start)).arc(x, y, r, start, end).stroke({ width: 2.5, color: 0xffffff, alpha: 0.95, cap: "round" });
    }
  }
}
