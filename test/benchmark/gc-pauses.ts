/** Local paired diagnostic, not a timing gate or a balance sweep.
 * Run each arm in a fresh process on the SAME two CPUs, without other sweeps:
 * taskset -c 0,1 node [shipped young-generation flag] --import ./src/ts-resolve.mjs \
 *   test/benchmark/gc-pauses.ts --head FULL_SHA --seed 7001
 * Omit the flag for the baseline; obtain the capped flag verbatim from package.json.
 * Live rules and 3,000 accelerated house-only ticks; no network or production writes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, loadavg } from "node:os";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { LiveHub, type LiveClock } from "../../src/live/hub.js";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { Game } from "../../src/mcp/game.js";
import { rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (argument("--head") !== head) throw new Error("--head must match full HEAD");
const seedText = argument("--seed");
if (!/^\d+$/.test(seedText ?? "")) throw new Error("--seed must be a positive integer");
const seed = Number(seedText);
if (!Number.isSafeInteger(seed) || seed <= 0) throw new Error("--seed must be a positive safe integer");
if (availableParallelism() !== 2) throw new Error("pin the process to exactly two CPUs with taskset");
execFileSync("git", ["diff", "--quiet", "HEAD", "--", "src", "package.json", "package-lock.json", "test/benchmark/gc-pauses.ts"]);
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { start: string } };
const shippedFlag = pkg.scripts.start.split(" ").find(arg => arg.startsWith("--max-semi-space-size="));
if (!shippedFlag) throw new Error("game-server start command must ship a young-generation flag");
const flags = process.execArgv.filter(arg => arg.startsWith("--max-semi-space-size"));
if (flags.length > 0 && (flags.length !== 1 || flags[0] !== shippedFlag)) throw new Error("capped arm must use the exact shipped flag");
if (process.env.NODE_OPTIONS) throw new Error("unset NODE_OPTIONS for paired measurements");

const gc: { startMs: number; durationMs: number; kind: number }[] = [];
function collect(entries: readonly PerformanceEntry[]): void {
  for (const entry of entries) {
    const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
    gc.push({ startMs: entry.startTime, durationMs: entry.duration, kind: detail.kind });
  }
}
const observer = new PerformanceObserver(list => collect(list.getEntries()));
observer.observe({ entryTypes: ["gc"] });

// Advance spectator time at the production tick rate while executing without sleeps.
// Timers retain real hub pacing/delay behavior, rather than accumulating a whole match.
let now = 0;
let nextTimer = 0;
const timers = new Map<number, { due: number; fn: () => void }>();
const clock: LiveClock = {
  now: () => now,
  setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { due: now + ms, fn }); return id; },
  clearTimeout(id) { timers.delete(id as number); },
};
function advanceClock(at: number): void {
  now = at;
  while (true) {
    const due = [...timers.entries()].find(([, timer]) => timer.due <= now);
    if (!due) return;
    timers.delete(due[0]);
    due[1].fn();
  }
}
const config = newMatchConfig(rulesConfig("redesign"));
const hub = new LiveHub({ config: DEFAULT_LIVE_CONFIG, clock, replayStore: { async create() {} } });
const game = new Game({ simConfig: config, now: () => now });
const tickMs: number[] = [];
let peakAnts = 0;
const measuredAt = new Date().toISOString();
const started = performance.now();
try {
  game.startMatch(seed);
  hub.startMatch(game.match!.seq, game.match!.state);
  for (let tick = 0; tick < 3_000; tick++) {
    const start = performance.now();
    advanceClock((tick + 1) * 1000 / config.ticksPerSecond);
    const out = game.tick();
    if (!out) throw new Error(`match ended before 3,000 ticks at ${tick}`);
    hub.pushTick(game.match!.seq, out);
    tickMs.push(performance.now() - start);
    peakAnts = Math.max(peakAnts, out.state.ants.length);
    // Deliver GC observer entries between ticks, as the real 100 ms loop does.
    await yieldTurn();
  }
  await yieldTurn();
  await yieldTurn();
  collect(observer.takeRecords());
} finally {
  observer.disconnect();
  hub.close();
}
const sorted = tickMs.slice().sort((a, b) => a - b);
const stateDigest = createHash("sha256").update(JSON.stringify(game.match!.state)).digest("hex");
console.log(JSON.stringify({ head, measuredAt, seed, arm: flags.length === 0 ? "uncapped" : "capped", shippedFlag,
  execArgv: process.execArgv, node: process.version, cpuModel: cpus()[0]?.model,
  cpuAffinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
  availableParallelism: availableParallelism(), loadAverage: loadavg(),
  harnessSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
  config, liveConfig: DEFAULT_LIVE_CONFIG, ticks: tickMs.length, peakAnts, stateDigest,
  elapsedMs: performance.now() - started,
  meanTickMs: tickMs.reduce((sum, ms) => sum + ms, 0) / tickMs.length,
  p99TickMs: sorted[Math.ceil(sorted.length * 0.99) - 1], maxTickMs: sorted.at(-1),
  largestGcPauseMs: Math.max(0, ...gc.map(entry => entry.durationMs)),
  pausesAtLeast20Ms: gc.filter(entry => entry.durationMs >= 20).length, gc,
  method: "Cold Game + LiveHub + ReplayRecording, 3,000 accelerated live-config house-only ticks; default 60-second spectator delay, virtual 10 Hz clock, fake replay store, no spectators, disk logging, network or forced GC. GC includes match start and ticks, all observed kinds; tick costs exclude startup, yields and final digest."
}));
