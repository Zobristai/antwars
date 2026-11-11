import { rmSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { startServer, type GameServer, type TickTiming } from "../../src/server.js";
import { PUBLIC_CONFIG, rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { WIDE_PLAIN } from "../../src/sim/scale2Maps.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { playable } from "../playable.ts";
import { comparison, connect, shortConfig, startComparisonMatch, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";

// A full collection on demand for this file only. The flag is process-wide, so it is set only long enough for one new
// context to carry gc(), then cleared: no other context in this process gains gc().
setFlagsFromString("--expose-gc");
const fullGc = runInNewContext("gc") as () => void;
setFlagsFromString("--no-expose-gc");
const LIVE_OBJECTS = 1_000_000;
// Measured (10 runs of this file): each forced stretch 84.98–100.62 ms, the collection-free stretch 0 ms.
// The floor sits 8.5× below the least forced stretch; the baseline may reach a quarter of either forced stretch.
const FORCED_GC_FLOOR_MS = 10;
const BASELINE_SHARE = 0.25;

let server: GameServer | undefined;
const agents: Agent[] = [], dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) await agent.close();
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StretchLine { k: number; fromTick: number; toTick: number; p99Ms: number; heapUsedBytes: number; heapTotalBytes: number; gcMs: number }

/** Match seq's stretch lines, in the order they were logged. */
function stretches(lines: readonly string[], seq: number): StretchLine[] {
  return lines.flatMap((line) => {
    const m = /^antwar match (\d+) tick stretch (\d+): (\{.*\})$/.exec(line);
    return m === null || Number(m[1]) !== seq ? [] : [{ k: Number(m[2]), ...JSON.parse(m[3]!) }];
  });
}

/** The exact p99 by definition: the least value that at least 99% of the values do not exceed. */
function exactP99(values: readonly number[]): number {
  return Math.min(...values.filter((v) => values.filter((w) => w <= v).length * 100 >= values.length * 99));
}

/** Consecutive stretches numbered from 1 that cover ticks 1..ticks with no gap or overlap. */
function expectCoverage(found: readonly StretchLine[], ticks: number): void {
  expect(found.map((s) => s.k)).toEqual(found.map((_, i) => i + 1));
  expect(found[0]!.fromTick).toBe(1);
  for (let i = 1; i < found.length; i++) expect(found[i]!.fromTick).toBe(found[i - 1]!.toTick + 1);
  expect(found.at(-1)!.toTick).toBe(ticks);
  for (const s of found) {
    expect(Number.isInteger(s.heapUsedBytes) && s.heapUsedBytes > 0).toBe(true);
    expect(Number.isInteger(s.heapTotalBytes) && s.heapTotalBytes >= s.heapUsedBytes).toBe(true);
    expect(Number.isFinite(s.gcMs) && s.gcMs >= 0).toBe(true);
  }
}

it("covers a full 60-minute Wide Plain at the deployed tick rate in 60-second stretches, each with the exact p99 of its tick times", async () => {
  const deployed = newMatchConfig(rulesConfig("redesign"));
  const matchTicks = WIDE_PLAIN.matchTicks!;
  expect(matchTicks / deployed.ticksPerSecond).toBe(60 * 60);
  // Known whole-tick times: the clock the server reads advances only inside each tick's feed call.
  const planned = Array.from({ length: matchTicks + 1 }, (_, i) => 1 + ((i * 7919 + (i >> 3) * 104_729) % 251));
  let clock = 0, ticked = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const lines: string[] = [], samples: TickTiming[] = [];
  const dir = tempDir(); dirs.push(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, ...comparison(0), seed: 7,
    simConfig: playable(shortConfig(matchTicks, { ticksPerSecond: deployed.ticksPerSecond, startAnts: 2, colonyCap: 4 })),
    feed: { matchStarted: () => {}, ticked: () => { clock += planned[ticked++]!; } },
    onTickTiming: (sample) => samples.push(sample),
    tickReport: { log: (line) => lines.push(line) } });
  const s = server;
  await startComparisonMatch(s, 0);
  vi.advanceTimersByTime((matchTicks + 1) * (1000 / deployed.ticksPerSecond));
  expect(s.game.match!.result).not.toBeNull();
  expect(ticked).toBe(matchTicks);
  expect(s.game.match!.state.tick).toBe(matchTicks);
  // The observer's samples are the same known times the report was fed.
  expect(samples.map((t) => t.workMs)).toEqual(planned.slice(0, matchTicks));
  const found = stretches(lines, 1);
  expect(found).toHaveLength(60);
  expectCoverage(found, matchTicks);
  for (const stretch of found) {
    expect(stretch.toTick - stretch.fromTick + 1).toBe(600);
    expect(stretch.p99Ms).toBe(exactP99(planned.slice(stretch.fromTick - 1, stretch.toTick)));
  }
}, 120_000);

it("closes a final partial stretch with its exact p99, and counts GC forced in a stretch's closing tick, and in the terminal tick, in that stretch and no other", async () => {
  const planned = Array.from({ length: 400 }, (_, i) => 1 + ((i * 37) % 331));
  let clock = 0, ticked = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const lines: string[] = [];
  const dir = tempDir(); dirs.push(dir);
  // Start from a collected heap, so no marking begun before the match finishes inside it.
  fullGc();
  const forced: number[] = [];
  server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, ...comparison(0), seed: 7,
    simConfig: playable(shortConfig(330, { ticksPerSecond: 200, startAnts: 2, colonyCap: 4 })),
    feed: { matchStarted: () => {}, ticked: () => {
      const tick = ++ticked;
      clock += planned[tick - 1]!;
      if (tick !== 150 && tick !== 330) return;
      // Two full collections inside this one tick: one marks a large live set, the next reclaims it once released,
      // so nothing they leave behind is collected in a later tick.
      let live: object[] | null = [];
      for (let n = 0; n < LIVE_OBJECTS; n++) live.push({ n });
      fullGc();
      forced.push(live.length);
      live = null;
      fullGc();
    } },
    tickReport: { log: (line) => lines.push(line), stretchTicks: 150 } });
  const s = server;
  await startComparisonMatch(s, 0);
  await waitFor(() => s.game.match?.result != null, 20_000);
  expect(forced).toEqual([LIVE_OBJECTS, LIVE_OBJECTS]);
  expect(ticked).toBe(330);
  const found = stretches(lines, 1);
  expect(found.map((x) => [x.fromTick, x.toTick])).toEqual([[1, 150], [151, 300], [301, 330]]);
  expectCoverage(found, 330);
  for (const stretch of found) expect(stretch.p99Ms).toBe(exactP99(planned.slice(stretch.fromTick - 1, stretch.toTick)));
  // Nearest rank over 150 ticks is the second-highest time, not the maximum.
  expect(found[0]!.p99Ms).toBeLessThan(Math.max(...planned.slice(0, 150)));
  // The server's own figures only. The two forced collections must land in their own closing tick's stretch: a lost
  // or zeroed collection fails the floor, and one counted in the next stretch, or after the last close, fails the
  // floor of its own stretch and the baseline of the collection-free stretch between them.
  const [first, between, last] = found.map((x) => x.gcMs) as [number, number, number];
  expect(first).toBeGreaterThanOrEqual(FORCED_GC_FLOOR_MS);
  expect(last).toBeGreaterThanOrEqual(FORCED_GC_FLOOR_MS);
  expect(between).toBeLessThanOrEqual(Math.min(first, last) * BASELINE_SHARE);
  // The final, partial stretch closes before the match's own report line, which comes last.
  expect(lines).toHaveLength(4);
  expect(lines.slice(0, 3).every((line) => line.includes(" tick stretch "))).toBe(true);
  expect(lines[3]).toMatch(/^antwar match 1 tick report: /);
}, 30_000);

it("an operator stop's terminal tick closes the last stretch, so the stretches still cover the match to its last tick", async () => {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 5 });
  const lines: string[] = [];
  let ticked = 0, observed = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  const dir = tempDir(); dirs.push(dir);
  server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, seed: 91, startPickWindowMs: 5,
    simConfig: playable(shortConfig(1000, { ticksPerSecond: 100, queenFounding: PUBLIC_CONFIG.queenFounding })), mcpConfig: TEST_MCP_CONFIG,
    slot: { slot: "public-0", publicUrl: "http://slot.test", identities, lobbies, pollMs: 10 }, operatorToken: "stretch-report-test-only",
    feed: { matchStarted: () => {}, ticked: () => { ticked++; } },
    onTickTiming: () => { observed++; },
    tickReport: { log: (line) => lines.push(line), stretchTicks: 4 } });
  const s = server;
  const keys: string[] = [];
  for (const name of ["StretchAnn", "StretchBob"]) {
    const claimed = await identities.claimUsername(name);
    if (!claimed.ok) throw new Error(claimed.reason);
    keys.push(claimed.value.key);
  }
  const created = await lobbies.createLobby(keys[0]!, "public", 1);
  if (!created.ok) throw new Error(created.reason);
  for (const key of keys) {
    const seated = await lobbies.join(created.value.lobby.id, key);
    if (!seated.ok) throw new Error(seated.reason);
  }
  await waitFor(() => s.game.nextStart !== null);
  for (const key of keys) {
    const agent = await connect(s.port); agents.push(agent);
    expect((await agent.call("join", { key })).isError).toBe(false);
  }
  await waitFor(() => (s.game.match?.state.tick ?? 0) >= 10);
  // The slot operator's stop ends the match synchronously before it answers.
  const stopped = await fetch(`http://127.0.0.1:${s.port}/operator/stop`, { method: "POST", headers: { authorization: "Bearer stretch-report-test-only" } });
  expect(stopped.status).toBe(200);
  expect(s.game.match!.result).not.toBeNull();
  const ticks = s.game.match!.state.tick;
  expect(ticked).toBe(ticks);
  // The observer still never sees the terminal tick; the report does.
  expect(observed).toBe(ticks - 1);
  const found = stretches(lines, s.game.match!.seq);
  expect(found).toHaveLength(Math.ceil(ticks / 4));
  expectCoverage(found, ticks);
  for (const stretch of found) expect(Number.isFinite(stretch.p99Ms) && stretch.p99Ms >= 0).toBe(true);
}, 15_000);
