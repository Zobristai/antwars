import { SUB, type SimConfig } from "./config.js";
import { notePoint } from "./localArrival.js";
import { direction, tileCentre, ZERO, type Vec } from "./geometry.js";
import { passableMask, segmentOnLand } from "./terrain.js";
import type { Ant, SimState, Terrain } from "./types.js";

interface Traversal {
  readonly offsets: Uint32Array;
  readonly neighbours: Int32Array;
  readonly queue: Int32Array;
}
interface Navigation {
  readonly land: readonly boolean[];
  readonly fields: Map<number, Int32Array>;
  traversal?: Traversal;
}
const navigation = new WeakMap<Terrain, Map<string, Navigation>>();

let lastTerrain: Terrain | undefined, lastWidth = -1, lastHeight = -1, lastGraph: Navigation | undefined;

function topology(config: SimConfig, terrain: Terrain): Navigation {
  // The same terrain and dimensions as the previous call: the same graph, without the key lookups.
  if (terrain === lastTerrain && config.mapWidth === lastWidth && config.mapHeight === lastHeight) return lastGraph!;
  lastGraph = cachedTopology(config, terrain);
  lastTerrain = terrain; lastWidth = config.mapWidth; lastHeight = config.mapHeight;
  return lastGraph;
}

function cachedTopology(config: SimConfig, terrain: Terrain): Navigation {
  const key = `${config.mapWidth}x${config.mapHeight}`;
  let dimensions = navigation.get(terrain);
  if (dimensions === undefined) { dimensions = new Map(); navigation.set(terrain, dimensions); }
  let graph = dimensions.get(key);
  if (graph === undefined) {
    graph = { land: passableMask(config, terrain), fields: new Map() };
    dimensions.set(key, graph);
  }
  return graph;
}

/** Compile the same dy/dx edges once, including the historical corner rules. */
function traversal(config: SimConfig, graph: Navigation): Traversal {
  if (graph.traversal !== undefined) return graph.traversal;
  const width = config.mapWidth, height = config.mapHeight, size = width * height;
  const offsets = new Uint32Array(size + 1), neighbours = new Int32Array(size * 8);
  const land = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && graph.land[y * width + x] === true;
  let count = 0;
  for (let at = 0; at < size; at++) {
    offsets[at] = count;
    if (!graph.land[at]) continue;
    const x = at % width, y = Math.floor(at / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (!land(nx, ny) || (dx !== 0 && dy !== 0 && (!land(nx, y) || !land(x, ny)))) continue;
      neighbours[count++] = ny * width + nx;
    }
  }
  offsets[size] = count;
  // BFS is synchronous and does not re-enter. Fields own their result arrays,
  // never this scratch queue, so later goals cannot overwrite earlier fields.
  return graph.traversal = { offsets, neighbours: neighbours.subarray(0, count), queue: new Int32Array(size) };
}

/** Static shortest-step flow field. Ant positions never affect it. */
function distances(config: SimConfig, graph: Navigation, goal: number): Int32Array {
  const cached = graph.fields.get(goal);
  if (cached !== undefined) return cached;
  const width = config.mapWidth, height = config.mapHeight;
  const result = new Int32Array(width * height).fill(-1);
  // Breadth-first distances are unique, so any edge order yields the same field: older configurations
  // share the compiled edges for a land goal (the only goal routeToward passes).
  if (config.pointArrival !== undefined || graph.land[goal] === true) {
    const { offsets, neighbours, queue } = traversal(config, graph);
    let first = 0, last = 1;
    queue[0] = goal; result[goal] = 0;
    while (first < last) {
      const at = queue[first++]!, distance = result[at]! + 1;
      const edge = offsets[at]!, end = offsets[at + 1]!;
      if (end - edge === 8) {
        // Eight compiled edges prove this is an unobstructed interior cell.
        // Their exact dy/dx order follows arithmetically, without table reads.
        let next = at - width - 1;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next++;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next++;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next = at - 1;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next = at + 1;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next = at + width - 1;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next++;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
        next++;
        if (result[next] === -1) { result[next] = distance; queue[last++] = next; }
      } else for (let index = edge; index < end; index++) {
        const next = neighbours[index]!;
        if (result[next] !== -1) continue;
        result[next] = distance; queue[last++] = next;
      }
    }
  } else {
    // Stored configurations retain the original traversal and allocation path.
    const queue = new Int32Array(result.length);
    const land = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && graph.land[y * width + x] === true;
    let first = 0, last = 1;
    queue[0] = goal; result[goal] = 0;
    while (first < last) {
      const at = queue[first++]!, x = at % width, y = Math.floor(at / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (!land(nx, ny) || result[next] !== -1 ||
            (dx !== 0 && dy !== 0 && (!land(nx, y) || !land(x, ny)))) continue;
        result[next] = result[at]! + 1; queue[last++] = next;
      }
    }
  }
  // Resting ants can have 4,096 simultaneous stable destinations. Keeping only
  // 256 fields repeatedly rebuilt every route behind water each tick. The larger
  // bounded cache is performance-only; old configurations retain their budget.
  const fieldLimit = config.pointArrival !== undefined ? 4096 : 256;
  if (graph.fields.size >= fieldLimit) graph.fields.delete(graph.fields.keys().next().value!);
  graph.fields.set(goal, result);
  return result;
}

/** Shared point-goal routing for house, forage, orders and count marks. */
export function routeToward(state: SimState, ant: Ant, x: number, y: number, arrivalOverride?: number): Vec {
  const { config, terrain } = state;
  notePoint(state, ant, x, y);
  if (config.softSeparation !== undefined && (x - ant.x) ** 2 + (y - ant.y) ** 2 <= (arrivalOverride ?? config.softSeparation.arrivalSubunits) ** 2) return ZERO;
  if (terrain === undefined || (terrain.water.length === 0 && (terrain.rocks?.length ?? 0) === 0)) return direction(x - ant.x, y - ant.y);
  const width = config.mapWidth, height = config.mapHeight, graph = topology(config, terrain);
  x = Math.max(0, Math.min(width * SUB - 1, x));
  y = Math.max(0, Math.min(height * SUB - 1, y));
  let gx = Math.floor(x / SUB), gy = Math.floor(y / SUB);
  if (!graph.land[gy * width + gx]) {
    let goal = -1, best = Infinity;
    for (let i = 0; i < graph.land.length; i++) {
      const d = (i % width - gx) ** 2 + (Math.floor(i / width) - gy) ** 2;
      const rank = (tile: number) => Math.floor(tile / width) * width +
        (ant.colony === 0 ? tile % width : width - 1 - tile % width);
      if (graph.land[i] && (d < best || (d === best && (goal < 0 || rank(i) < rank(goal))))) { best = d; goal = i; }
    }
    if (goal < 0) return ZERO;
    gx = goal % width; gy = Math.floor(goal / width); x = tileCentre(gx); y = tileCentre(gy);
    notePoint(state, ant, x, y, true);
    if (config.softSeparation !== undefined && (x - ant.x) ** 2 + (y - ant.y) ** 2 <= config.softSeparation.arrivalSubunits ** 2) return ZERO;
  }
  if (segmentOnLand(config, terrain, ant.x, ant.y, x, y)) return direction(x - ant.x, y - ant.y);
  const field = distances(config, graph, gy * width + gx);
  const tx = Math.floor(ant.x / SUB), ty = Math.floor(ant.y / SUB), origin = field[ty * width + tx]!;
  if (origin < 0) return ZERO;
  let bestDistance = origin, score = Infinity, bestTile = -1;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const nx = tx + dx, ny = ty + dy, tile = ny * width + nx;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height || !graph.land[tile]) continue;
    const d = field[tile]!, cx = tileCentre(nx), cy = tileCentre(ny);
    const tie = (cx - x) ** 2 + (cy - y) ** 2;
    const preferred = bestTile < 0 || (ant.colony === 0 ? tile < bestTile : tile > bestTile);
    if (d < 0 || d >= origin || d > bestDistance ||
        (d === bestDistance && (tie > score || (tie === score && !preferred))) ||
        !segmentOnLand(config, terrain, ant.x, ant.y, cx, cy)) continue;
    bestDistance = d; score = tie; bestTile = tile;
  }
  return bestTile < 0 ? ZERO : direction(tileCentre(bestTile % width) - ant.x, tileCentre(Math.floor(bestTile / width)) - ant.y);
}

/** Point-rest walking chooses a terrain-safe integer step inside the speed disk.
 * Rounding an already terrain-tested step afterwards can move it across a rock
 * corner and leave an ant stuck forever. Legacy routing is deliberately untouched.
 */
export function moveToPointRest(state: SimState, ant: Ant, rest: Vec, speed: number): void {
  const direct = segmentOnLand(state.config, state.terrain, ant.x, ant.y, rest.x, rest.y);
  const heading = direct ? { x: rest.x - ant.x, y: rest.y - ant.y } : routeToward(state, ant, rest.x, rest.y, 0);
  const choose = (dx: number, dy: number): Vec | undefined => {
    const length = Math.hypot(dx, dy), scale = length > speed ? speed / length : 1;
    const x = dx * scale, y = dy * scale;
    let bestX = 0, bestY = 0, bestErrorX = 0, bestErrorY = 0, found = false;
    // At most four integer neighbours. Preserve the old comparator's exact
    // left-associative arithmetic: sum subtraction changes floating-point ties.
    // Set used to normalize -0 to +0, so keep that observable detail too.
    for (let vx = Math.floor(x) || 0; vx <= Math.ceil(x); vx++) {
      for (let vy = Math.floor(y) || 0; vy <= Math.ceil(y); vy++) {
        const errorX = (vx - x) ** 2, errorY = (vy - y) ** 2;
        if (found && (errorX + errorY - bestErrorX - bestErrorY || vy - bestY || vx - bestX) >= 0) continue;
        if (vx ** 2 + vy ** 2 > speed ** 2 ||
            ant.x + vx < 0 || ant.x + vx >= state.config.mapWidth * SUB ||
            ant.y + vy < 0 || ant.y + vy >= state.config.mapHeight * SUB ||
            !segmentOnLand(state.config, state.terrain, ant.x, ant.y, ant.x + vx, ant.y + vy)) continue;
        bestX = vx; bestY = vy; bestErrorX = errorX; bestErrorY = errorY; found = true;
      }
    }
    return found ? { x: bestX, y: bestY } : undefined;
  };
  let delta = choose(heading.x, heading.y);
  // At a sub-cell corner the lower flow-field neighbour can be hidden from the
  // current point. Return to this passable cell's centre before taking that edge.
  if (delta === undefined || (delta.x === 0 && delta.y === 0 && (ant.x !== rest.x || ant.y !== rest.y))) {
    delta = choose(tileCentre(Math.floor(ant.x / SUB)) - ant.x, tileCentre(Math.floor(ant.y / SUB)) - ant.y);
  }
  ant.vx = delta?.x ?? 0; ant.vy = delta?.y ?? 0;
  ant.x += ant.vx; ant.y += ant.vy;
}
