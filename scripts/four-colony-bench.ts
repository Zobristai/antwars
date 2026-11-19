// Four-colony simulation tick benchmark. Not part of the test suite; simulation only.
//
//   taskset -c 0 node --import ./src/ts-resolve.mjs scripts/four-colony-bench.ts
//     [--maps strait,crossroads,four-coves] [--seed 12345] [--ticks 18000] [--window 1000] [--hash-every 0] [--two-colony]
//
// Plays an idle headless match on each map (no seats and no commands, so every colony grows towards its ant
// cap) with advance(), timing each tick on one thread. Prints, per window of ticks, the mean and worst tick
// and the ants per colony; at the end the whole match's mean and worst tick against the 100 ms budget of
// 10 ticks/s, the worst tick after the first 1,000 (start-up compilation), the most the match would fall behind
// a fixed 10 ticks/s schedule that catches up after a late tick (as the server's tick loop does), the result and
// the final stateHash. --hash-every N also prints stateHash every N ticks, so two
// builds can be compared tick for tick. --two-colony plays the default two-colony match instead.
// It measures the simulation alone: seat calls, views and spectator streams are not included.
// Pin it to one CPU (taskset) for numbers comparable with a one-vCPU match slot.
import { rulesConfig } from "../src/sim/config.js";
import { newMatchConfig } from "../src/sim/gridScale.js";
import { stateHash } from "../src/sim/log.js";
import { createMatch } from "../src/sim/map.js";
import { QUADRANT_MAPS, quadrantMapConfig } from "../src/sim/quadrantMaps.js";
import { advance } from "../src/sim/step.js";

const BUDGET_MS = 100;
const WARM_UP_TICKS = 1000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
}

const seed = Number(arg("seed", "12345"));
const maxTicks = Number(arg("ticks", "18000"));
const window = Number(arg("window", "1000"));
const hashEvery = Number(arg("hash-every", "0"));
const twoColony = process.argv.includes("--two-colony");
const maps = twoColony ? ["two-colony"] : arg("maps", QUADRANT_MAPS.map((m) => m.id).join(",")).split(",");

for (const id of maps) {
  const config = twoColony ? newMatchConfig(rulesConfig("redesign")) : quadrantMapConfig(id);
  let state = createMatch(seed, config);
  let ticks = 0, total = 0, worst = 0, worstWarm = 0, overBudget = 0, lag = 0, maxLag = 0;
  let windowTotal = 0, windowWorst = 0, windowTicks = 0;
  while (state.result === null && ticks < maxTicks) {
    const started = performance.now();
    state = advance(state).state;
    const ms = performance.now() - started;
    ticks += 1;
    total += ms;
    windowTotal += ms;
    windowTicks += 1;
    if (ms > worst) worst = ms;
    if (ms > windowWorst) windowWorst = ms;
    if (ms > BUDGET_MS) overBudget += 1;
    if (ticks > WARM_UP_TICKS && ms > worstWarm) worstWarm = ms;
    // Behind schedule after this tick: the previous lag plus this tick's work beyond its 100 ms slot, never negative.
    lag = Math.max(0, lag + ms - BUDGET_MS);
    if (lag > maxLag) maxLag = lag;
    if (hashEvery > 0 && state.tick % hashEvery === 0) console.log(`hash ${id} ${state.tick} ${stateHash(state)}`);
    if (windowTicks === window || state.result !== null || ticks === maxTicks) {
      const ants = state.colonies.map((c) => state.ants.filter((a) => a.colony === c.id).length).join("/");
      console.log(`${id} tick ${state.tick}: mean ${(windowTotal / windowTicks).toFixed(2)} ms, worst ${windowWorst.toFixed(1)} ms, ants ${ants}`);
      windowTotal = 0;
      windowWorst = 0;
      windowTicks = 0;
    }
  }
  const mean = total / ticks;
  console.log(`SUMMARY ${id}: ${ticks} ticks, mean ${mean.toFixed(2)} ms, worst ${worst.toFixed(1)} ms, ` +
    `worst after tick ${WARM_UP_TICKS} ${worstWarm.toFixed(1)} ms, ticks over ${BUDGET_MS} ms ${overBudget}, most behind schedule ${maxLag.toFixed(1)} ms, ` +
    `headroom ${(BUDGET_MS / mean).toFixed(1)}x at mean; ` +
    `result ${JSON.stringify(state.result)}; hash ${stateHash(state)}`);
}
