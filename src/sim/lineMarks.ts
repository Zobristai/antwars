import { SUB } from "./config.js";
import { distance, tileCentre, withinTiles, type Vec } from "./geometry.js";
import { pointRestTopology } from "./pointSlots.js";
import type { Ant, ColonyId, Mark, SimState } from "./types.js";

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

/** The i-th of n spots spread evenly from end a to end b, both ends included; a lone spot is the midpoint. */
function evenSpot(a: Vec, b: Vec, i: number, n: number): Vec {
  return n === 1 ? { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
    : { x: a.x + Math.round(((b.x - a.x) * i) / (n - 1)), y: a.y + Math.round(((b.y - a.y) * i) / (n - 1)) };
}

/** A LINE mark's claimed ants outside squads, ordered along the line from its first end, then by id. */
function membersAlong(state: SimState, mark: Mark): Ant[] {
  const [a, b] = endpoints(mark), dx = b.x - a.x, dy = b.y - a.y;
  const along = (other: Ant) => (other.x - a.x) * dx + (other.y - a.y) * dy;
  return state.ants.filter(other => other.claim === mark.id && other.squad === null)
    .sort((p, q) => along(p) - along(q) || p.id - q.id);
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
    const spot = evenSpot(a, b, i, n);
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
    const members = membersAlong(state, mark);
    const at = lineSpots(state, mark, members.length);
    spots = new Map(members.map((member, i) => [member.id, at[i]!]));
    marks.set(mark.id, spots);
  }
  return spots.get(ant.id) ?? { x: tileCentre(mark.tileX), y: tileCentre(mark.tileY) };
}

/**
 * Tiles in the colony's current sight: within sightTiles of a living ant of
 * the colony, the test a count mark's tile passes when placed in colony sight.
 */
function colonySight(state: SimState, colony: ColonyId): Uint8Array {
  const { mapWidth: width, mapHeight: height, sightTiles: r } = state.config;
  const seen = new Uint8Array(width * height), stamped = new Uint8Array(width * height), reach = Math.ceil(r);
  for (const ant of state.ants) {
    if (ant.colony !== colony || ant.hp <= 0) continue;
    const ax = Math.floor(ant.x / SUB), ay = Math.floor(ant.y / SUB);
    if (ax >= 0 && ay >= 0 && ax < width && ay < height) {
      if (stamped[ay * width + ax] === 1) continue;
      stamped[ay * width + ax] = 1;
    }
    for (let y = Math.max(0, ay - reach); y <= Math.min(height - 1, ay + reach); y++) {
      for (let x = Math.max(0, ax - reach); x <= Math.min(width - 1, ax + reach); x++) {
        if (withinTiles(ax, ay, x, y, r)) seen[y * width + x] = 1;
      }
    }
  }
  return seen;
}

/**
 * The centre of the passing tile nearest the point by straight-line distance,
 * ties to the lower row, then the lower column; null when no tile passes.
 */
function nearestPassing(width: number, height: number, passes: (tile: number) => boolean, spot: Vec): Vec | null {
  const cx = Math.floor(spot.x / SUB), cy = Math.floor(spot.y / SUB);
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  // Square rings outward. Every tile centre in ring r is at least r - 1/2 tiles
  // from any point of the spot's own tile, so the search stops once that bound
  // passes the best distance found.
  for (let r = 0; r <= Math.max(width, height); r++) {
    if (best !== null && (r * SUB - SUB / 2) ** 2 > bestD) break;
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= height) continue;
      const edge = y === cy - r || y === cy + r;
      for (let x = cx - r; x <= cx + r; x += edge ? 1 : 2 * r) {
        if (x < 0 || x >= width || !passes(y * width + x)) continue;
        const d = (spot.x - tileCentre(x)) ** 2 + (spot.y - tileCentre(y)) ** 2;
        if (best === null || d < bestD || (d === bestD && (y < best.y || (y === best.y && x < best.x)))) {
          best = { x, y }; bestD = d;
        }
      }
    }
  }
  return best === null ? null : { x: tileCentre(best.x), y: tileCentre(best.y) };
}

/**
 * The spots of n flyers spread evenly from end to end, as lineSpots spaces
 * them. A spot passes when its tile is land and in the colony's current sight;
 * one that fails moves to the centre of the nearest tile that passes, across
 * water or rock if need be, since flyers have no walking area. Null where no
 * tile on the map passes.
 */
function flyerSpots(state: SimState, mark: Mark, n: number): (Vec | null)[] {
  if (n === 0) return [];
  const [a, b] = endpoints(mark), width = state.config.mapWidth, height = state.config.mapHeight;
  const { land } = pointRestTopology(state), seen = colonySight(state, mark.colony);
  const passes = (tile: number) => land[tile] === true && seen[tile] === 1;
  return Array.from({ length: n }, (_, i) => {
    const spot = evenSpot(a, b, i, n);
    return passes(Math.floor(spot.y / SUB) * width + Math.floor(spot.x / SUB)) ? spot : nearestPassing(width, height, passes, spot);
  });
}

const flyerAssigned = new WeakMap<SimState, { readonly tick: number; readonly marks: Map<number, ReadonlyMap<number, Vec | null>> }>();

/**
 * Where this claimed flyer hovers on its flyer LINE mark: the mark's claimed
 * flyers are ordered along the line (then by id), as lineSpotOf orders its
 * ants, and take the flyer spots in that order. Settled once per state tick
 * from that tick's sight and positions and recomputed every tick, so joins,
 * deaths, releases, count changes and lost sight re-spread on the next tick.
 * Null when no tile on the map passes, or for an ant the mark has not claimed.
 */
export function flyerLineSpotOf(state: SimState, mark: Mark, ant: Ant): Vec | null {
  let cache = flyerAssigned.get(state);
  if (cache === undefined || cache.tick !== state.tick) { cache = { tick: state.tick, marks: new Map() }; flyerAssigned.set(state, cache); }
  let spots = cache.marks.get(mark.id);
  if (spots === undefined || !spots.has(ant.id)) {
    const members = membersAlong(state, mark);
    const at = flyerSpots(state, mark, members.length);
    spots = new Map(members.map((member, i) => [member.id, at[i] ?? null]));
    cache.marks.set(mark.id, spots);
  }
  return spots.get(ant.id) ?? null;
}
