/** Where each live server tick's time goes. Local diagnostic, not a timing gate.
 *
 *   node --import ./src/ts-resolve.mjs test/benchmark/live-tick.ts --ants 4096 [--ticks 300] [--warmup 20]
 *     [--seed 6006] [--spectators 1] [--bare]
 *
 * Runs the production live tick path in one process, as src/spectator.ts wires it: Game.tick (simulation and
 * the built-in planner, no agents) with its log lines fed to the hub, then LiveHub.pushTick with replay
 * recording on (an in-memory replay store and record handoff, so push-time capture and release-time append
 * both run) and real loopback SSE spectators read by a child process. The board is the probe
 * (69c56b2e0e6eaf239c966bde35adf2ac4ead4dda web/capture/probe.ts, not on main), rebuilt here with --ants per side.
 * The match is public, unrated house-1v1, so it streams with no spectator delay, as the probe served it.
 * Ticks run back to back on a virtual 10 Hz hub clock (as gc-pauses.ts), each followed by one event-loop turn
 * so socket I/O runs between ticks as in the real 100 ms loop.
 *
 * Each named part is EXCLUSIVE self-time: harness-only wrappers (prototype methods and zlib.deflateRawSync)
 * time a call and subtract the wrapped calls nested inside it, so the parts of one tick sum to the instrumented
 * time and the remainder (whole tick minus parts) is only unwrapped loop glue. GC is observed separately and
 * overlaps the parts; it is not added. --bare runs the same loop with no wrappers to size their overhead.
 * No product code is modified; the wrappers exist only in this process.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, cpus, platform, release } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn, setTimeout as sleep } from "node:timers/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { LiveHub, type LiveClock } from "../../src/live/hub.js";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { Game } from "../../src/mcp/game.js";
import { ReplayRecording } from "../../src/replays/recording.js";
import { MAPS, TERRAIN_RULES, rulesConfig, type FoodPatch, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { createMatch, mirrorX, newAnt } from "../../src/sim/map.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { SimState } from "../../src/sim/types.js";

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
const ants = argument("--ants", 4096);
const ticks = argument("--ticks", 300);
const warmup = argument("--warmup", 20);
const seed = argument("--seed", 6006);
const spectatorCount = argument("--spectators", 1);
const bare = process.argv.includes("--bare");
if (ants < 1 || ticks < 1) throw new Error("--ants and --ticks must be positive");

// ---- The probe board, rebuilt (probe.ts at 69c56b2e0e6eaf239c966bde35adf2ac4ead4dda) ----

/** The live food templates placed proportionally, as left-half reference tiles. */
const PROBE_FOOD: readonly FoodPatch[] = [
  { tileX: 20, tileY: 27, radius: 5, perTile: 2 },
  { tileX: 36, tileY: 24, radius: 2, perTile: 6 },
  { tileX: 36, tileY: 104, radius: 2, perTile: 6 },
  { tileX: 60, tileY: 64, radius: 1, perTile: 1 },
  { tileX: 56, tileY: 27, radius: 1, perTile: 1 },
  { tileX: 56, tileY: 101, radius: 1, perTile: 1 },
];

/** Open 128x128 reference board at grid scale 2 on the redesign rules, colony cap = ants per side. */
function probeConfig(perSide: number): SimConfig {
  const live = rulesConfig("redesign");
  const reference: SimConfig = {
    ...live,
    mapWidth: 128,
    mapHeight: 128,
    nestTileX: 16,
    nestTileY: 64,
    colonyCap: perSide,
    startAnts: 0,
    foodPatches: PROBE_FOOD,
    foodLayout: { ...live.foodLayout!, patches: PROBE_FOOD },
    terrain: { ...TERRAIN_RULES, maps: MAPS.filter((map) => map.id === "open-field"), referenceWidth: 128, referenceHeight: 128 },
  };
  const fine = withGridScale(reference);
  return { ...fine, startArea: "back-quarter", terrain: { ...fine.terrain!, referenceWidth: fine.mapWidth, referenceHeight: fine.mapHeight } };
}

/** perSide ants per colony, alternating workers and soldiers, spread over land in colony 0's 40% band and mirrored. */
function probeMatch(matchSeed: number, config: SimConfig, perSide: number): SimState {
  const state = createMatch(matchSeed, config);
  const band = Math.floor(config.mapWidth * 0.4);
  const cols = Math.round(Math.sqrt((perSide * band) / config.mapHeight));
  const rows = Math.ceil(perSide / cols);
  const taken = new Set<number>();
  for (let i = 0; i < perSide; i++) {
    const want = { x: Math.floor(((i % cols) + 0.5) * band / cols), y: Math.floor((Math.floor(i / cols) + 0.5) * config.mapHeight / rows) };
    const tile = nearestLand(state, band, want.x, want.y, taken);
    taken.add(tile.y * config.mapWidth + tile.x);
    const x = tileCentre(tile.x), y = tileCentre(tile.y);
    const caste = i % 2 === 0 ? "worker" : "soldier";
    state.ants.push(newAnt(config, state.nextAntId++, 0, x, y, caste));
    state.ants.push(newAnt(config, state.nextAntId++, 1, mirrorX(config, x), y, caste));
  }
  return state;
}

function nearestLand(state: SimState, band: number, x: number, y: number, taken: ReadonlySet<number>): { x: number; y: number } {
  const { mapWidth, mapHeight } = state.config;
  for (let r = 0; r < mapHeight; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || tx >= band || ty < 0 || ty >= mapHeight || taken.has(ty * mapWidth + tx)) continue;
        if (isBlockedTile(state.terrain, tx, ty) || isBlockedTile(state.terrain, mapWidth - 1 - tx, ty)) continue;
        return { x: tx, y: ty };
      }
    }
  }
  throw new Error("no land left in the start band");
}

// ---- Exclusive self-time accounting ----

/** Part name -> group, in report order. */
const PARTS = {
  "simulation + planner (Game.tick)": "simulation",
  "match log line (Game -> hub.appendLog)": "simulation",
  "spectator record (SpectatorRecorder.record)": "stream",
  "encode stream message (LiveHub.payload)": "stream",
  "deflate (zlib.deflateRawSync)": "stream",
  "frame + pace (base64, drain self)": "stream",
  "spectator board apply (SpectatorState.apply)": "stream",
  "release self (MatchStream.release)": "stream",
  "spectator socket write (LiveHub.write)": "stream",
  "push self (MatchStream.push)": "stream",
  "hub timers (heartbeats, paced drains)": "stream",
  "encode full snapshot (LiveHub.payload)": "stream",
  "encode for replay capture (LiveHub.payload)": "replay recording",
  "replay capture (ReplayRecording.capture)": "replay recording",
  "replay append (ReplayRecording.append)": "replay recording",
  "event loop between ticks (socket I/O)": "event loop",
} as const;
type Part = keyof typeof PARTS;

let tickSelf = new Map<Part, number>();
const stack: { child: number }[] = [];
const frames: string[] = [];

function timed<T>(part: Part, fn: () => T): T {
  const start = performance.now();
  stack.push({ child: 0 });
  frames.push(part);
  try {
    return fn();
  } finally {
    const total = performance.now() - start;
    const frame = stack.pop()!;
    frames.pop();
    tickSelf.set(part, (tickSelf.get(part) ?? 0) + total - frame.child);
    if (stack.length > 0) stack[stack.length - 1]!.child += total;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap(target: any, key: string, part: Part | ((caller: string | undefined) => Part)): void {
  const original = target[key] as (...args: unknown[]) => unknown;
  if (typeof original !== "function") throw new Error(`cannot wrap ${key}`);
  target[key] = function (this: unknown, ...args: unknown[]) {
    const name = typeof part === "function" ? part(frames.at(-1)) : part;
    return timed(name, () => original.apply(this, args));
  };
}

// ---- Run ----

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "test/benchmark", "package.json", "package-lock.json"], { encoding: "utf8" }).trim();
const config = probeConfig(ants);

const gc: { startMs: number; durationMs: number }[] = [];
const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) gc.push({ startMs: e.startTime, durationMs: e.duration }); });
observer.observe({ entryTypes: ["gc"] });

let now = 0;
let nextTimer = 0;
const timers = new Map<number, { due: number; fn: () => void }>();
const clock: LiveClock = {
  now: () => now,
  setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { due: now + ms, fn }); return id; },
  clearTimeout(id) { timers.delete(id as number); },
};
function fireDueTimers(): void {
  while (true) {
    const due = [...timers.entries()].find(([, timer]) => timer.due <= now);
    if (!due) return;
    timers.delete(due[0]);
    due[1].fn();
  }
}

let capturedMessages = 0;
const hub = new LiveHub({
  config: DEFAULT_LIVE_CONFIG, clock,
  replayStore: { async create() {} },
  captureMatchLogs: true,
  recordHandoff: { submit() {} },
});
const game = new Game({ simConfig: config, now: () => now, onLogLine: (line) => {
  // As src/server.ts writeLogLine: the start header precedes the stream and is not fed to it.
  if (line.startsWith('{"type":"header"')) return;
  if (bare) hub.appendLog(game.match!.seq, line);
  else timed("match log line (Game -> hub.appendLog)", () => hub.appendLog(game.match!.seq, line));
} });

const lobbyId = `bench-${ants}`;
const initial = probeMatch(seed, config, ants);
game.startMatch(seed, { state: initial });
const seq = game.match!.seq;
hub.startMatch(seq, game.match!.state, { lobbyId, visibility: "public", rated: false, mode: "house-1v1" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stream = (hub as any).streams.get(seq) as { spectators: Set<unknown>; queue: unknown[] };

// Spectators: real loopback SSE connections served by the hub, read and discarded by one child process.
const server = createServer((req, res) => void hub.handle(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live/${seq}`;
let streamBytes = 0;
const reader = spectatorCount === 0 ? null : spawn(process.execPath, ["-e", `
  const http = require("node:http"); let bytes = 0;
  for (let i = 0; i < ${spectatorCount}; i++) http.get(process.argv[1], res => res.on("data", c => { bytes += c.length; }));
  process.on("SIGTERM", () => { process.stdout.write(String(bytes)); process.exit(0); });`, url], { stdio: ["ignore", "pipe", "inherit"] });
let readerOut = "";
reader?.stdout!.on("data", (chunk: Buffer) => { readerOut += chunk.toString(); });
for (let waited = 0; stream.spectators.size < spectatorCount; waited += 10) {
  if (waited > 10_000) throw new Error("spectators did not attach");
  await sleep(10);
}

if (!bare) {
  // Wrap only after start, so match setup is not attributed to any tick.
  wrap(Game.prototype, "tick", "simulation + planner (Game.tick)");
  wrap(SpectatorRecorder.prototype, "record", "spectator record (SpectatorRecorder.record)");
  wrap(SpectatorState.prototype, "apply", "spectator board apply (SpectatorState.apply)");
  wrap(ReplayRecording.prototype, "capture", "replay capture (ReplayRecording.capture)");
  wrap(ReplayRecording.prototype, "append", "replay append (ReplayRecording.append)");
  wrap(LiveHub.prototype, "write", "spectator socket write (LiveHub.write)");
  wrap(LiveHub.prototype, "payload", (caller) =>
    caller === "push self (MatchStream.push)" ? "encode for replay capture (LiveHub.payload)"
    : caller === "release self (MatchStream.release)" ? "encode full snapshot (LiveHub.payload)"
    : "encode stream message (LiveHub.payload)");
  const streamProto = Object.getPrototypeOf(stream) as object;
  wrap(streamProto, "push", "push self (MatchStream.push)");
  wrap(streamProto, "drain", "frame + pace (base64, drain self)");
  wrap(streamProto, "release", "release self (MatchStream.release)");
  // hub.ts imports deflateRawSync by name from the builtin; syncBuiltinESMExports updates that live binding.
  const zlib = createRequire(import.meta.url)("node:zlib") as { deflateRawSync: unknown };
  wrap(zlib, "deflateRawSync", "deflate (zlib.deflateRawSync)");
  syncBuiltinESMExports();
}

interface TickSample { wholeMs: number; parts: Map<Part, number>; startMs: number; endMs: number }
const samples: TickSample[] = [];
const antsAt = (state: SimState): [number, number] => [state.ants.filter((a) => a.colony === 0).length, state.ants.filter((a) => a.colony === 1).length];
let antsAtStart: [number, number] = [0, 0];
let frameBytes = 0;
let frames0 = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const countFrames = (hub as any).write.bind(hub) as (s: unknown, text: string, rearm?: boolean) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(hub as any).write = (s: unknown, text: string, rearm?: boolean) => { if (text.startsWith("data:")) { frameBytes += text.length; frames0 += 1; } countFrames(s, text, rearm); };

const tickMs = 1000 / config.ticksPerSecond;
for (let i = 0; i < warmup + ticks; i++) {
  if (i === warmup) { antsAtStart = antsAt(game.match!.state); frameBytes = 0; frames0 = 0; }
  tickSelf = new Map();
  const start = performance.now();
  now += tickMs;
  if (bare) fireDueTimers(); else timed("hub timers (heartbeats, paced drains)", fireDueTimers);
  const out = game.tick();
  if (!out) throw new Error(`match ended after ${i} ticks`);
  hub.pushTick(seq, out);
  if (bare) await yieldTurn(); else {
    const turn = performance.now();
    await yieldTurn();
    tickSelf.set("event loop between ticks (socket I/O)", performance.now() - turn);
  }
  const end = performance.now();
  if (i >= warmup) samples.push({ wholeMs: end - start, parts: tickSelf, startMs: start, endMs: end });
}
await yieldTurn();
const gcEntries = [...gc, ...observer.takeRecords().map((e) => ({ startMs: e.startTime, durationMs: e.duration }))];
observer.disconnect();
const antsAtEnd = antsAt(game.match!.state);
const backlog = stream.queue.length;
reader?.kill("SIGTERM");
await new Promise<void>((resolve) => { if (reader === null) resolve(); else reader.on("exit", () => resolve()); });
streamBytes = Number(readerOut) || 0;
hub.close();
server.closeAllConnections();
server.close();

// ---- Report ----

const quantile = (xs: readonly number[], q: number): number => {
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
};
const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const stats = (xs: readonly number[]) => ({ median: quantile(xs, 0.5), p90: quantile(xs, 0.9), mean: mean(xs) });
const fmt = (ms: number): string => ms.toFixed(2);

const whole = samples.map((s) => s.wholeMs);
const gcPerTick = samples.map((s) => gcEntries.filter((g) => g.startMs >= s.startMs && g.startMs < s.endMs).reduce((sum, g) => sum + g.durationMs, 0));
const partRows = (Object.keys(PARTS) as Part[]).map((part) => ({ part, group: PARTS[part], ...stats(samples.map((s) => s.parts.get(part) ?? 0)) }));
const groups = [...new Set(Object.values(PARTS))].map((group) => ({ group, ...stats(samples.map((s) =>
  [...s.parts].filter(([part]) => PARTS[part] === group).reduce((sum, [, ms]) => sum + ms, 0))) }));
const remainder = samples.map((s) => s.wholeMs - [...s.parts.values()].reduce((sum, ms) => sum + ms, 0));
const withoutReplay = samples.map((s) => s.wholeMs - [...s.parts].filter(([part]) => PARTS[part] === "replay recording").reduce((sum, [, ms]) => sum + ms, 0));
const cpuinfo = (() => { try { return readFileSync("/proc/cpuinfo", "utf8"); } catch { return ""; } })();
const cpu = [cpus()[0]?.model, /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]].find((m) => m && m !== "unknown") ?? "CPU model not reported";
const machine = `${cpu}, ${cpus().length} CPUs visible, ${platform()} ${release()} ${arch()}`;

const lines = [
  `## ${ants.toLocaleString("en")} ants per side${bare ? " (bare: no wrappers)" : ""}`,
  "",
  `Machine: ${machine}. Node ${process.version}. Commit ${head}${dirty ? " (UNCOMMITTED CHANGES under src, test/benchmark or package files)" : ""}.`,
  `Seed ${seed}; ${warmup} warm-up then ${samples.length} measured ticks; ${spectatorCount} loopback spectator(s); ants per colony ${antsAtStart.join(" / ")} at first measured tick, ${antsAtEnd.join(" / ")} at last.`,
  `Stream frames written in the measured ticks: ${frames0}, mean ${fmt(frameBytes / Math.max(1, frames0) / 1024)} KiB; records still queued behind pacing at the end: ${backlog}; spectator bytes read: ${streamBytes}.`,
  "",
  "| Part (exclusive self-time) | Group | Median ms | p90 ms | Mean ms |",
  "|---|---|---:|---:|---:|",
  ...(bare ? [] : partRows.map((r) => `| ${r.part} | ${r.group} | ${fmt(r.median)} | ${fmt(r.p90)} | ${fmt(r.mean)} |`)),
  ...(bare ? [] : [`| Remainder (whole minus parts) | — | ${fmt(quantile(remainder, 0.5))} | ${fmt(quantile(remainder, 0.9))} | ${fmt(mean(remainder))} |`]),
  `| **Whole tick** | — | **${fmt(quantile(whole, 0.5))}** | **${fmt(quantile(whole, 0.9))}** | **${fmt(mean(whole))}** |`,
  ...(bare ? [] : [`| Whole tick without replay recording | — | ${fmt(quantile(withoutReplay, 0.5))} | ${fmt(quantile(withoutReplay, 0.9))} | ${fmt(mean(withoutReplay))} |`]),
  `| GC pause time in tick (overlaps parts) | — | ${fmt(quantile(gcPerTick, 0.5))} | ${fmt(quantile(gcPerTick, 0.9))} | ${fmt(mean(gcPerTick))} |`,
  "",
  ...(bare ? [] : ["| Group | Median ms | p90 ms | Mean ms |", "|---|---:|---:|---:|", ...groups.map((g) => `| ${g.group} | ${fmt(g.median)} | ${fmt(g.p90)} | ${fmt(g.mean)} |`), ""]),
  ...(bare ? [] : [`Mean check: parts ${fmt(mean(samples.map((s) => [...s.parts.values()].reduce((a, b) => a + b, 0))))} ms + remainder ${fmt(mean(remainder))} ms = whole ${fmt(mean(whole))} ms.`]),
  `GC total ${fmt(gcPerTick.reduce((a, b) => a + b, 0))} ms over ${samples.length} ticks.`,
];
console.log(lines.join("\n"));
console.log(JSON.stringify({ head, dirty: dirty !== "", machine, node: process.version, execArgv: process.execArgv, ants, seed, warmup,
  ticks: samples.length, spectators: spectatorCount, bare, antsAtStart, antsAtEnd, backlog, frames: frames0, frameBytes, streamBytes,
  whole: stats(whole), remainder: stats(remainder), withoutReplay: stats(withoutReplay), gc: stats(gcPerTick), parts: partRows, groups }));
