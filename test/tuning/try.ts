// Tuning loop: time one try of this checkout against the agent's lane baseline, which is not re-timed.
//   node --experimental-transform-types --no-warnings --import ./src/ts-resolve.mjs test/tuning/try.ts --store <dir> --agent <id> --lane <lane> [--ticks 50]
// Prints the TryResult as JSON (relative = try / baseline median tick time, gain = 1 − relative, noise = the
// stored spread; candidate and workload name the src tree, checkpoint, ticks and timing method timed, which keep.ts requires
// to be the candidate it judges and the noise check's workload); exits 1 with the reason when the noise check has not passed.
// The tick time is timing.ts timeWindows with DEFAULT_METHOD: discarded warm-up runs, then the median of the timed runs.
import { parseArgs } from "node:util";
import type { LaneId } from "./lanes.js";
import { openStore } from "./store.js";
import { LoopRefusal, timeAgainstBaseline, TRY_TICKS } from "./timing.js";

const { values } = parseArgs({ options: {
  store: { type: "string" }, agent: { type: "string" }, lane: { type: "string" }, ticks: { type: "string", default: String(TRY_TICKS) },
} });
if (values.store === undefined || values.agent === undefined || values.lane === undefined) throw new Error("--store, --agent and --lane are required");
try {
  console.log(JSON.stringify(timeAgainstBaseline(openStore(values.store), values.agent, values.lane as LaneId, Number(values.ticks))));
} catch (error) {
  if (!(error instanceof LoopRefusal)) throw error;
  console.log(JSON.stringify({ agentId: values.agent, refused: error.message }));
  process.exitCode = 1;
}
