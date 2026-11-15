import type { StreamFlyer } from "../../src/live/format.ts";
import type { Frame } from "./buffer.ts";

/**
 * Frame ant i's flyer state, or null for a non-flyer. frame.ants is the sampled message's ants, ids ascending: frame ant i is
 * message ant i in Full view, but a one-colony view filters the frame's arrays and keeps frame.ants whole, so match by id.
 */
export function flyerOf(frame: Frame, i: number): StreamFlyer | null {
  const ants = frame.ants, flyers = ants?.flyers;
  if (!ants || !flyers) return null;
  const id = frame.id[i]!;
  if (ants.id[i] === id) return flyers[i] ?? null;
  let lo = 0, hi = ants.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, v = ants.id[mid]!;
    if (v === id) return flyers[mid] ?? null;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** Flying or hovering. */
export function isAirborne(flyer: StreamFlyer | null): boolean {
  return flyer !== null && (flyer.state === "flying" || flyer.state === "hovering");
}
