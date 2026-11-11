// Match tick report: when a match ends the server logs one report with its tick
// count and the exact median and p90 whole-tick time over all its ticks, plus its map and
// per-side ant cap; the per-tick timing observer receives the same samples as before.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { startServer, type GameServer, type MatchFeed, type ServerOptions, type TickTiming } from "../../src/server.js";
import { PUBLIC_CONFIG, TERRAIN_RULES, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { median, percentile } from "../../src/tickStats.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { playable } from "../playable.js";
import { comparison, connect, shortConfig, startComparisonMatch, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";

/** A pinned map whose own ant cap (40) differs from the config's (150), so the report's cap is the map's. */
const REPORT_MAP: MapDefinition = { id: "tick-report", name: "Tick Report", water: [], colonyCap: 40 };
const MATCH_TICKS = 24;
const config = (matchTicks: number, overrides: Partial<SimConfig> = {}): SimConfig =>
  ({ ...playable(shortConfig(matchTicks, overrides)), terrain: { ...TERRAIN_RULES, maps: [REPORT_MAP], mapId: REPORT_MAP.id } });

/** Each tick's known whole-tick time: (37 t mod 101) / 4 ms, distinct and exact in binary for t = 1..100. */
const knownMs = (tick: number): number => ((37 * tick) % 101) / 4;

/**
 * The server's clock stands still except inside each tick, where the feed (called from the
 * tick's publish) advances it by that tick's known time, so every measured whole tick is exact.
 */
function drivenTimings() {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const applied: number[] = [];
  const feed: MatchFeed = {
    matchStarted: () => {},
    ticked: (_seq, out) => {
      const ms = knownMs(out.state.tick);
      clock += ms;
      applied.push(ms);
    },
  };
  return { feed, applied };
}

/** Console and report lines in the order they were written. */
function capturedLines() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return { lines, tickReport: { log: (line: string) => lines.push(line) } };
}

const REPORT = /^antwar match (\d+) tick report: (.*)$/;
function reports(lines: readonly string[]): { seq: number; figures: Record<string, unknown> }[] {
  return lines.flatMap((line) => {
    const m = REPORT.exec(line);
    return m === null ? [] : [{ seq: Number(m[1]), figures: JSON.parse(m[2]!) as Record<string, unknown> }];
  });
}

/** Exact figures computed here independently: the middle value or the mean of the two middle values, and nearest-rank p90. */
function exact(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length, half = Math.floor(n / 2);
  return { median: n % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2, p90: sorted[Math.ceil(n * 0.9) - 1]! };
}

const OPERATOR_TOKEN = "tick-report-test-only";

/** The slot operator's stop, which ends the running match synchronously before it answers. */
async function stopByOperator(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/operator/stop`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
  expect(res.status).toBe(200);
}

let server: GameServer | null = null;
const dirs: string[] = [], agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await server?.close(); server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function playToEnd(extra: Partial<ServerOptions>, feed: MatchFeed): Promise<GameServer> {
  const dataDir = tempDir(); dirs.push(dataDir);
  server = await startServer({ port: 0, host: "127.0.0.1", dataDir, ...comparison(0), simConfig: config(MATCH_TICKS), mcpConfig: TEST_MCP_CONFIG, feed, ...extra });
  const s = server;
  await startComparisonMatch(s, 0);
  await waitFor(() => s.game.match?.result != null);
  return s;
}

describe("tick statistics", () => {
  it("median is the middle value or the mean of the two middle values", () => {
    expect(median([7])).toBe(7);
    expect(median([1, 2, 9])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it("percentile is the nearest rank", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 91)).toBe(10);
    expect(percentile(ten, 100)).toBe(10);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7], 90)).toBe(7);
  });
});

describe("the match tick report", () => {
  it("logs one report after the match's end line, with the exact median and p90 of known per-tick timings", async () => {
    const { feed, applied } = drivenTimings();
    const { lines, tickReport } = capturedLines();
    const s = await playToEnd({ tickReport }, feed);
    expect(s.game.match!.state.tick).toBe(MATCH_TICKS);
    expect(applied).toEqual(Array.from({ length: MATCH_TICKS }, (_, i) => knownMs(i + 1)));
    // Ticks 1..24 take, sorted, 3 6 10 13 20 23 30 33 37 40 43 47 | 50 57 60 67 70 74 77 80 84 87 94 97 quarter-ms:
    // median (47 + 50) / 8 = 12.125 ms; nearest-rank p90 is the 22nd, 87 / 4 = 21.75 ms.
    const found = reports(lines);
    expect(found).toEqual([{ seq: 1, figures: { ticks: MATCH_TICKS, medianMs: 12.125, p90Ms: 21.75, map: REPORT_MAP.id, colonyCap: 40 } }]);
    expect(exact(applied)).toEqual({ median: 12.125, p90: 21.75 });
    const ended = lines.findIndex((line) => line.startsWith("antwar match 1 ended after"));
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((line) => REPORT.test(line))).toBeGreaterThan(ended);
  });

  it("is not logged when the server is started without tickReport", async () => {
    const { feed } = drivenTimings();
    const { lines } = capturedLines();
    await playToEnd({}, feed);
    expect(lines.some((line) => line.startsWith("antwar match 1 ended after"))).toBe(true);
    expect(lines.filter((line) => line.includes("tick report"))).toEqual([]);
  });

  it.each([false, true])("with tickReport=%s, the per-tick observer receives the same samples as before", async (withReport) => {
    const { feed } = drivenTimings();
    const { tickReport } = capturedLines();
    const samples: TickTiming[] = [];
    await playToEnd({ onTickTiming: (sample) => samples.push(sample), ...(withReport ? { tickReport } : {}) }, feed);
    expect(samples.map(({ seq, tick, workMs }) => ({ seq, tick, workMs })))
      .toEqual(Array.from({ length: MATCH_TICKS }, (_, i) => ({ seq: 1, tick: i + 1, workMs: knownMs(i + 1) })));
    for (const sample of samples) {
      expect(Object.keys(sample).sort()).toEqual(["lateMs", "seq", "tick", "workMs"]);
      expect(sample.lateMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("an operator stop's terminal tick is counted in the report but never reaches the observer", async () => {
    const { feed, applied } = drivenTimings();
    const { lines, tickReport } = capturedLines();
    const samples: TickTiming[] = [];
    const { store } = memoryWatchStore();
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { countdownMs: 5 });
    const keys: string[] = [];
    for (const name of ["ReportAnn", "ReportBob"]) {
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
    const dataDir = tempDir(); dirs.push(dataDir);
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: config(6000, { queenFounding: PUBLIC_CONFIG.queenFounding }), mcpConfig: TEST_MCP_CONFIG, seed: 91, startPickWindowMs: 5,
      slot: { slot: "public-0", publicUrl: "http://slot.test", identities, lobbies, pollMs: 10 }, operatorToken: OPERATOR_TOKEN,
      feed, tickReport, onTickTiming: (sample) => samples.push(sample) });
    const s = server;
    await waitFor(() => s.game.nextStart !== null);
    for (const key of keys) {
      const agent = await connect(s.port); agents.push(agent);
      const joined = await agent.call("join", { key });
      expect(joined.isError, joined.text).toBe(false);
    }
    await waitFor(() => samples.length >= 5);
    await stopByOperator(s.port);
    const ticks = s.game.match!.state.tick;
    expect(s.game.match!.result).not.toBeNull();
    expect(samples.map((sample) => sample.tick)).toEqual(Array.from({ length: ticks - 1 }, (_, i) => i + 1));
    expect(applied).toHaveLength(ticks);
    const { median: medianMs, p90: p90Ms } = exact(applied);
    expect(reports(lines)).toEqual([{ seq: 1, figures: { ticks, medianMs, p90Ms, map: REPORT_MAP.id, colonyCap: 40 } }]);
  }, 15_000);
});
