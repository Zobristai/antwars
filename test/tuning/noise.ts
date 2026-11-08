// Tuning loop: the once-only four-agent noise check. Start it on four agents at the same time:
//   node --experimental-transform-types --no-warnings --import ./src/ts-resolve.mjs test/tuning/noise.ts --store <dir> --agent <id> [--max-noise 0.15] [--ticks 50] [--wait 600]
// Prints the stored verdict (runs, spread, limit, pass) as JSON; exits 0 when it passed, 1 when it failed or was refused.
import { parseArgs } from "node:util";
import { openStore } from "./store.js";
import { DEFAULT_MAX_NOISE, LoopRefusal, runNoiseCheck, TRY_TICKS } from "./timing.js";

const { values } = parseArgs({ options: {
  store: { type: "string" }, agent: { type: "string" },
  "max-noise": { type: "string", default: String(DEFAULT_MAX_NOISE) }, ticks: { type: "string", default: String(TRY_TICKS) }, wait: { type: "string", default: "600" },
} });
if (values.store === undefined || values.agent === undefined) throw new Error("--store and --agent are required");
try {
  const report = await runNoiseCheck({ store: openStore(values.store), agentId: values.agent, cwd: process.cwd(),
    limit: Number(values["max-noise"]), ticks: Number(values.ticks), waitMs: Number(values.wait) * 1000 });
  console.log(JSON.stringify({ agentId: values.agent, timed: report.timed, ...report.verdict, message: report.message }));
  process.exitCode = report.verdict.pass ? 0 : 1;
} catch (error) {
  if (!(error instanceof LoopRefusal)) throw error;
  console.log(JSON.stringify({ agentId: values.agent, refused: error.message }));
  process.exitCode = 1;
}
