/**
 * One of test plan check 10's whole matches, in its own process, so check10-house-matches.test.ts can play them
 * side by side:
 *   node --import ./src/ts-resolve.mjs test/sim/check10-match.ts <28|27> <map id> <seed>
 * plays a house-only match (no agent seats) on the served new-match config of those rules, with the map pinned, to
 * its result, and prints one MatchSummary as JSON on stdout. An engine error exits non-zero with its stack on stderr.
 */
import { rulesConfig, rulesVersionOf } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { territoryCounts } from "../../src/sim/territory.js";
import type { MatchResult, SimState } from "../../src/sim/types.js";
import { rules27Redesign } from "../rules27.ts";

export interface MatchSummary {
  readonly rules: 28 | 27;
  /** The rules version the played config carries. */
  readonly rulesVersion: number;
  readonly mapId: string;
  readonly seed: number;
  /** The map's match length limit in ticks. */
  readonly matchTicks: number;
  /** Ticks played: the result's tick plus one. */
  readonly ticks: number;
  readonly result: MatchResult;
  /** match_end events the run emitted. */
  readonly matchEnds: number;
  /** The quantity the deciding rule compared, per colony, and the winner's lead in it (0 for a draw). */
  readonly quantity: string;
  readonly values: readonly [number, number];
  readonly margin: number;
  /** Both colonies at the end: held territory (original-tile areas) and ants alive. */
  readonly territory: readonly [number, number];
  readonly antsAlive: readonly [number, number];
}

function antsAlive(state: SimState): [number, number] {
  const counts: [number, number] = [0, 0];
  for (const ant of state.ants) counts[ant.colony] += 1;
  return counts;
}

/** The quantity the result's deciding rule compared, per colony, as the end rules read it. */
function deciding(state: SimState, result: MatchResult): { quantity: string; values: [number, number] } {
  const queensLost = (colony: 0 | 1) => (state.colonies[colony].queens ?? []).filter(q => q.lostTick !== null).length;
  switch (result.decidedBy) {
    case "kills": return { quantity: "kills", values: [state.stats.deaths[1], state.stats.deaths[0]] };
    case "territory": return { quantity: "territory tiles", values: territoryCounts(state) };
    case "ants_alive": return { quantity: "ants alive", values: antsAlive(state) };
    case "food_delivered": return { quantity: "food delivered", values: [state.stats.delivered[0], state.stats.delivered[1]] };
    case "queens_killed":
    case "overrun": return { quantity: "queens killed", values: [queensLost(1), queensLost(0)] };
    case "draw":
    case "idle": return { quantity: result.decidedBy, values: [0, 0] };
  }
}

const [rulesArg, mapId, seedArg] = process.argv.slice(2);
if ((rulesArg !== "28" && rulesArg !== "27") || mapId === undefined || !/^\d+$/.test(seedArg ?? "")) {
  throw new Error("usage: check10-match.ts <28|27> <map id> <seed>");
}
const rules = rulesArg === "28" ? 28 : 27, seed = Number(seedArg);
const served = newMatchConfig(rules === 28 ? rulesConfig("redesign") : rules27Redesign());
let state = createMatch(seed, newMatchConfig({ ...served, terrain: { ...served.terrain!, mapId } }));
if (state.terrain?.mapId !== mapId) throw new Error(`played ${state.terrain?.mapId ?? "no map"}, not ${mapId}`);
let matchEnds = 0;
while (state.result === null) {
  const out = step(state);
  state = out.state;
  for (const event of out.events) if (event.type === "match_end") matchEnds += 1;
}
const result = state.result;
const { quantity, values } = deciding(state, result);
const summary: MatchSummary = { rules, rulesVersion: rulesVersionOf(state.config), mapId, seed, matchTicks: state.config.matchTicks,
  ticks: state.tick, result, matchEnds, quantity, values,
  margin: result.winner === null ? 0 : values[result.winner] - values[result.winner === 0 ? 1 : 0],
  territory: territoryCounts(state), antsAlive: antsAlive(state) };
process.stdout.write(`${JSON.stringify(summary)}\n`);
