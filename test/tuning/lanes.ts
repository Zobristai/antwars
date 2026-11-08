// The tuning loop's five lanes.
// Each tuning agent is given exactly one lane at launch and works only on it. A lane's
// hot spots are the code its lane names; the freeform lane names none, so a freeform
// agent receives no hot-spot direction.

export type LaneId = "seated-local-steering" | "neighbour-scan" | "adjacent-enemy" | "soft-separation" | "freeform";

export interface Lane {
  readonly id: LaneId;
  readonly name: string;
  /** Where this lane's agents look first; empty for freeform. */
  readonly hotSpots: readonly string[];
}

export const LANES: readonly Lane[] = Object.freeze([
  Object.freeze({
    id: "seated-local-steering",
    name: "Seated local steering",
    hotSpots: Object.freeze([
      "src/sim/houseBot.ts localDirection",
      "src/sim/houseBot.ts fighterDirection",
      "src/sim/houseBot.ts houseDirection",
      "src/sim/houseBot.ts sightScan and nearer",
      "src/sim/marks.ts localRulesSide dispatch",
    ]),
  }),
  Object.freeze({
    id: "neighbour-scan",
    name: "Neighbour scan",
    hotSpots: Object.freeze([
      "src/sim/map.ts Grid and buildGrid (dense buckets)",
      "src/sim/map.ts TrackedGrid and GridTracker sync",
      "src/sim/map.ts forEachNear",
    ]),
  }),
  Object.freeze({
    id: "adjacent-enemy",
    name: "Adjacent-enemy check",
    hotSpots: Object.freeze([
      "src/sim/map.ts hasAdjacentEnemy",
      "src/sim/houseBot.ts houseDirection and localDirection (its call sites)",
    ]),
  }),
  Object.freeze({
    id: "soft-separation",
    name: "Soft separation",
    hotSpots: Object.freeze([
      "src/sim/softSeparation.ts applySoftSeparation",
      "src/sim/step.ts advanceSoftAnts",
    ]),
  }),
  // No hot-spot direction.
  Object.freeze({ id: "freeform", name: "Freeform", hotSpots: Object.freeze([]) }),
]);

/** The lane with this id; throws for anything that is not one of the five lane ids. */
export function laneById(id: string): Lane {
  const lane = LANES.find((candidate) => candidate.id === id);
  if (lane === undefined) throw new Error(`unknown lane "${id}"; lanes are ${LANES.map((l) => l.id).join(", ")}`);
  return lane;
}
