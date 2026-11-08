import { SUB, type SimConfig } from "./config.js";
import { tileCentre, withinTiles } from "./geometry.js";
import { COUNT_VERBS, type Ant, type CountMarkVerb, type Mark, type SimState } from "./types.js";
import { gridScaleOf } from "./gridScale.js";

/** Keep the recorded four-verb vocabulary separate from new-match opt-ins. */
export function countMarkVerbs(config: SimConfig): readonly CountMarkVerb[] {
  const verbs: readonly CountMarkVerb[] = config.patrolLinkTiles === undefined ? COUNT_VERBS : [...COUNT_VERBS, "PATROL"];
  return lineMarksEnabled(config) ? [...verbs, "LINE"] : verbs;
}

/** LINE count marks (rules 26) come with every config that has count marks. */
export function lineMarksEnabled(config: SimConfig): boolean {
  return config.countMarks !== undefined;
}

export interface PatrolPosition {
  readonly chain: readonly Mark[];
  readonly position: number;
}
export type PatrolChains = ReadonlyMap<number, PatrolPosition>;

/** Derived once per movement phase (and once per view), never stored in replay state.
 * A component's marks are in laid order, independent of traversal/input order.
 */
export function patrolChains(state: SimState): PatrolChains {
  const result = new Map<number, PatrolPosition>();
  const range = state.config.patrolLinkTiles;
  if (range === undefined) return result;
  const ordered = state.marks.filter(mark => mark.verb === "PATROL" && mark.count !== undefined)
    .sort((a, b) => a.laidTick - b.laidTick || a.id - b.id);
  const unseen = new Set(ordered);
  for (const root of ordered) {
    if (!unseen.delete(root)) continue;
    const component = [root];
    for (let i = 0; i < component.length; i++) {
      const from = component[i]!;
      for (const other of unseen) {
        if (other.colony === root.colony && withinTiles(from.tileX, from.tileY, other.tileX, other.tileY, range)) {
          unseen.delete(other);
          component.push(other);
        }
      }
    }
    component.sort((a, b) => a.laidTick - b.laidTick || a.id - b.id);
    component.forEach((mark, position) => result.set(mark.id, { chain: component, position }));
  }
  return result;
}

/** Retain a valid waypoint; otherwise start at the nearest member of this claim's chain. */
export function patrolWaypoint(ant: Ant, own: PatrolPosition, chains: PatrolChains): Mark {
  const current = ant.patrolWaypoint === undefined ? undefined : chains.get(ant.patrolWaypoint);
  if (current?.chain === own.chain) return own.chain[current.position]!;
  let best = own.chain[0]!;
  const distance = (mark: Mark) => (ant.x - tileCentre(mark.tileX)) ** 2 + (ant.y - tileCentre(mark.tileY)) ** 2;
  for (const mark of own.chain) {
    const d = distance(mark), bestD = distance(best);
    if (d < bestD || (d === bestD && mark.id < best.id)) best = mark;
  }
  ant.patrolWaypoint = best.id;
  return best;
}

export function nextPatrolWaypoint(ant: Ant, chains: PatrolChains): void {
  const current = ant.patrolWaypoint === undefined ? undefined : chains.get(ant.patrolWaypoint);
  if (current !== undefined && current.chain.length > 1) {
    ant.patrolWaypoint = current.chain[(current.position + 1) % current.chain.length]!.id;
  }
}

/** Expiry/recruitment never changes the existing claim algorithm or its release timing. */
export function clearReleasedPatrolWaypoints(state: SimState): void {
  if (state.config.patrolLinkTiles === undefined) return;
  const live = new Set(state.marks.filter(mark => mark.verb === "PATROL").map(mark => mark.id));
  for (const ant of state.ants) {
    if (ant.patrolWaypoint !== undefined && (ant.squad !== null || ant.claim === undefined || !live.has(ant.claim))) ant.patrolWaypoint = undefined;
  }
}

/** Non-soft opt-in configurations use the existing native physical arrival radius. */
export function reachedPatrolWaypoint(state: SimState, ant: Ant, mark: Mark): boolean {
  const radius = state.config.softSeparation?.arrivalSubunits ?? 300 * gridScaleOf(state.config);
  return (ant.x - (mark.tileX + 0.5) * SUB) ** 2 + (ant.y - (mark.tileY + 0.5) * SUB) ** 2 <= radius ** 2;
}
