import { SUB } from "./config.js";
import { distance, tileCentre, type Vec } from "./geometry.js";
import { pointRestTopology } from "./pointSlots.js";
import type { Ant, Mark, SimState } from "./types.js";

/** A LINE mark's two endpoint centres, in sub-tile units. */
function endpoints(mark: Mark): readonly [Vec, Vec] {
  return [{ x: tileCentre(mark.tileX), y: tileCentre(mark.tileY) },
    { x: tileCentre(mark.toTileX ?? mark.tileX), y: tileCentre(mark.toTileY ?? mark.tileY) }];
}

/** Distance from an ant to the nearest point of a LINE mark's segment (claim order and release). */
export function lineDistance(ant: Ant, mark: Mark): number {
  const [a, b] = endpoints(mark);
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(length, (ant.x - a.x) * dx + (ant.y - a.y) * dy));
  return distance(ant.x, ant.y, a.x + Math.round((dx * t) / Math.max(1, length)), a.y + Math.round((dy * t) / Math.max(1, length)));
}

/**
 * The spot of each of n ants spread evenly from end to end, endpoints
 * included; a lone ant stands at the midpoint. A spot on water or rock moves
 * to the nearest land tile centre in the area of the endpoint it is nearer.
 */
export function lineSpots(state: SimState, mark: Mark, n: number): Vec[] {
  const [a, b] = endpoints(mark);
  const { land, component } = pointRestTopology(state);
  const width = state.config.mapWidth, height = state.config.mapHeight;
  const tileOf = (p: Vec) => Math.floor(p.y / SUB) * width + Math.floor(p.x / SUB);
  const spots: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const spot = n === 1 ? { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
      : { x: a.x + Math.round(((b.x - a.x) * i) / (n - 1)), y: a.y + Math.round(((b.y - a.y) * i) / (n - 1)) };
    if (land[tileOf(spot)]) { spots.push(spot); continue; }
    const near = (spot.x - a.x) ** 2 + (spot.y - a.y) ** 2 <= (spot.x - b.x) ** 2 + (spot.y - b.y) ** 2 ? a : b;
    const area = component[tileOf(near)]!;
    const cx = Math.floor(spot.x / SUB), cy = Math.floor(spot.y / SUB);
    let best: Vec = near, bestD = (spot.x - near.x) ** 2 + (spot.y - near.y) ** 2, found = false;
    // Square rings outward; one ring past the first hit covers every nearer Euclidean candidate.
    for (let r = 1, stop = Infinity; r <= Math.max(width, height) && r <= stop; r++) {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || x < 0 || y < 0 || x >= width || y >= height) continue;
        const tile = y * width + x;
        if (!land[tile] || component[tile] !== area) continue;
        const centre = { x: tileCentre(x), y: tileCentre(y) }, d = (spot.x - centre.x) ** 2 + (spot.y - centre.y) ** 2;
        if (!found || d < bestD) { best = centre; bestD = d; found = true; }
      }
      if (found && stop === Infinity) stop = r + 1;
    }
    spots.push(best);
  }
  return spots;
}

const assigned = new WeakMap<SimState, { readonly tick: number; readonly marks: Map<number, ReadonlyMap<number, Vec>> }>();

/**
 * Where this claimed ant stands on its LINE mark: the mark's claimed ants are
 * ordered along the line (then by id) and take the spots in that order, so they
 * never cross. Settled once per state from the positions before any of the
 * mark's ants moves, and recomputed every tick, so joins and deaths re-spread.
 */
export function lineSpotOf(state: SimState, mark: Mark, ant: Ant): Vec {
  let cache = assigned.get(state);
  if (cache === undefined || cache.tick !== state.tick) { cache = { tick: state.tick, marks: new Map() }; assigned.set(state, cache); }
  const marks = cache.marks;
  let spots = marks.get(mark.id);
  if (spots === undefined || !spots.has(ant.id)) {
    const [a, b] = endpoints(mark), dx = b.x - a.x, dy = b.y - a.y;
    const along = (other: Ant) => (other.x - a.x) * dx + (other.y - a.y) * dy;
    const members = state.ants.filter(other => other.claim === mark.id && other.squad === null)
      .sort((p, q) => along(p) - along(q) || p.id - q.id);
    const at = lineSpots(state, mark, members.length);
    spots = new Map(members.map((member, i) => [member.id, at[i]!]));
    marks.set(mark.id, spots);
  }
  return spots.get(ant.id) ?? { x: tileCentre(mark.tileX), y: tileCentre(mark.tileY) };
}
