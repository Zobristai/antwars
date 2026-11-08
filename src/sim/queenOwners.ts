import { nextUint32 } from "./rng.js";
import type { ColonyId, SimState } from "./types.js";

/**
 * Rules 27: the seeded value that picks a queen's owner, derived from the
 * match seed, the colony and the queenId alone, so it never reads or advances
 * state.rngState and a replayed log draws the same owner.
 */
function ownerDraw(seed: number, colony: ColonyId, queenId: number): number {
  const seeded = nextUint32(seed >>> 0).value;
  const coloured = nextUint32((seeded ^ colony) >>> 0).value;
  return nextUint32((coloured ^ queenId) >>> 0).value;
}

/**
 * Rules 27: each live queen with no owner, in a colony with at least one
 * agent, gets an owner drawn from that colony's agents in join order, idle ones
 * included. An owner, once set, is never changed here. A colony with no agent is left untouched.
 */
export function assignQueenOwners(state: SimState): void {
  for (const colony of state.colonies) {
    if (colony.queens === undefined) continue;
    // state.agents is in join order: joinSeq is the array index at join.
    const agents = state.agents.filter((agent) => agent.colony === colony.id);
    if (agents.length === 0) continue;
    for (const queen of colony.queens) {
      if (queen.lostTick !== null || queen.owner !== undefined) continue;
      queen.owner = agents[ownerDraw(state.seed, colony.id, queen.id) % agents.length]!.id;
    }
  }
}
