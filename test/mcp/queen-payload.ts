import { expandCells, type DenseCells } from "../../src/sim/view.js";
/** Controlled observe tool-result sizes against an installed, immutable baseline checkout.
 * node --import ./src/ts-resolve.mjs test/mcp/queen-payload.ts --head SHA --baseline-dir DIR --out out/queens/payload.json
 * No public traffic: both MCP servers bind ephemeral loopback ports and close in finally.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { COLONY_NAMES, PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { foundQueen } from "../../src/sim/agents.ts";
import { cloneState, createMatch, newAnt, queenFoundingCost } from "../../src/sim/map.ts";
import type { ColonyId, SimState } from "../../src/sim/types.ts";
import { observeBytes } from "../tools/colonyScale.ts";
import type { AgentView } from "../../src/sim/view.ts";
import { startHarness, TEST_MCP_CONFIG } from "./harness.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";

const BASELINE = "271809a567bf2896de04baa29bba55658e9af536";
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
export function jsonByteBreakdown(value: Record<string, unknown>) {
  const plain = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const fields = Object.fromEntries(Object.entries(plain).map(([key, item]) => [key, bytes(item)]));
  const totalBytes = bytes(plain);
  return { totalBytes, fields, framingBytes: totalBytes - Object.values(fields).reduce((sum, n) => sum + n, 0) };
}

/** Measurement-only counts; nothing here is added to the tool's response. */
export function observeBreakdown(result: Record<string, unknown>, state: SimState) {
  const data = result.structuredContent as { view: AgentView };
  if (!data?.view) throw new Error("observe has no structured view");
  const view = data.view;
  const cells = Array.isArray(view.cells) ? view.cells : expandCells(view.cells as unknown as DenseCells);
  const ants = cells.flatMap(cell => cell.ants);
  const content = result.content as { type: string; text?: string }[];
  return { tool: jsonByteBreakdown(result), structured: jsonByteBreakdown(data),
    view: jsonByteBreakdown(view as unknown as Record<string, unknown>),
    textUtf8Bytes: content.reduce((n, c) => n + Buffer.byteLength(c.text ?? ""), 0),
    visibleCells: cells.length, visibleAntEntries: ants.length,
    uniqueVisibleAnts: new Set(ants.map((a) => a.antId)).size,
    visibleAntValueBytes: ants.reduce((n, a) => n + bytes(a), 0), events: view.events.length,
    colonyAnts: state.colonies.map((c) => state.ants.filter((a) => a.colony === c.id).length),
    guardsByQueen: state.colonies.map((c) => ({ colony: c.id, queens: (c.queens ?? []).filter((q) => q.lostTick === null)
      .map((q) => ({ queenId: q.id, count: state.ants.filter((a) => a.colony === c.id && a.squad === null && a.role === "guard" && a.guardQueenId === q.id).length })) })) };
}
export interface ObserveMeasurement {
  sourceTick: number; observedTick: number; colony: number; map: boolean; bytes: number;
  breakdown: ReturnType<typeof observeBreakdown>;
}

/** Real SDK serialization on isolated clones; join/observe advance only those private clones. */
export async function measureQueenObserve(state: SimState, colonies: readonly ColonyId[] = [0, 1]): Promise<ObserveMeasurement[]> {
  const measurements: ObserveMeasurement[] = [];
  for (const colony of colonies) {
    // The in-memory control (observeBytes) runs the default MCP config; match its idle limit so replies compare byte for byte.
    const h = await startHarness({ simConfig: state.config, state: cloneState(state), mcpConfig: { ...TEST_MCP_CONFIG, houseIdleSeconds: DEFAULT_MCP_CONFIG.houseIdleSeconds } });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join", { colony: COLONY_NAMES[colony] });
      if (joined.isError) throw new Error(`private observer join failed: ${joined.text}`);
      for (const map of [false, true]) {
        const result = await agent.client.callTool({ name: "observe", arguments: { map } });
        if (result.isError) throw new Error(`private observe failed: ${JSON.stringify(result)}`);
        measurements.push({ sourceTick: state.tick, observedTick: h.game.match!.state.tick, colony, map, bytes: bytes(result),
          breakdown: observeBreakdown(result, h.game.match!.state) });
      }
    } finally { await h.close(); }
  }
  return measurements;
}

/** Same played snapshot and colony through both existing measurement adapters. */
export async function compareObserveMethods(state: SimState, colony: ColonyId) {
  const http = await measureQueenObserve(state, [colony]);
  const memory = await observeBytes(state, colony);
  return { sourceTick: state.tick, colony, http, memory,
    comparison: memory.results.map((m) => {
      const h = http.find((item) => item.map === m.map)!;
      return { map: m.map, sameObservedTick: h.observedTick === m.tick,
        toolByteDelta: h.bytes - m.toolResultUtf8Bytes, textByteDelta: h.breakdown.textUtf8Bytes - m.textUtf8Bytes };
    }), note: "Same snapshot control: HTTP/JSON-RPC transport is excluded from both tool-result sizes. Natural maxima at different populations are not a controlled queen-only comparison." };
}

async function main() {
  const { values } = parseArgs({ options: { head: { type: "string" }, "baseline-dir": { type: "string" }, out: { type: "string", default: "out/queens/payload.json" } } });
  if (!/^[a-f0-9]{40}$/.test(values.head ?? "") || !values["baseline-dir"]) throw new Error("Supply --head and --baseline-dir pinned to the documented baseline SHA.");
  const base = resolve(values["baseline-dir"]);
  const baseConfig = await import(pathToFileURL(join(base, "src/sim/config.ts")).href) as { PUBLIC_CONFIG: SimConfig };
  const baseMap = await import(pathToFileURL(join(base, "src/sim/map.ts")).href) as { createMatch: typeof createMatch; newAnt: typeof newAnt };
  const baseHarness = await import(pathToFileURL(join(base, "test/mcp/harness.ts")).href) as { startHarness: typeof startHarness };
  const samples = [];
  for (const population of [30, 512]) for (const queenCount of [1, 3]) {
    const results: { build: string; defaultBytes: number; mapBytes: number; defaultViewBytes: number; mapViewBytes: number;
      squad: { antId: number; tileX: number; tileY: number }[]; visibleCells: number; visibleAntEntries: number; uniqueVisibleAnts: number }[] = [];
    for (const candidate of [false, true]) {
      // Same food, territory, ant roster and tick; only candidate queen rules/model and nest count differ.
      const config: SimConfig = { ...baseConfig.PUBLIC_CONFIG, startAnts: 0, ...(candidate ? { queenFounding: PUBLIC_CONFIG.queenFounding } : {}) };
      const map = candidate ? { createMatch, newAnt } : baseMap;
      const state = map.createMatch(6006, config);
      for (const colony of [0, 1] as const) for (let i = 0; i < population; i++) {
        const x = colony === 0 ? 4 + i % 24 : config.mapWidth - 5 - i % 24;
        const y = 2 + Math.floor(i / 24) % (config.mapHeight - 4);
        state.ants.push(map.newAnt(config, state.nextAntId++, colony, (x + 0.5) * 1000, (y + 0.5) * 1000));
      }
      const sites = [[18, 10], [18, 38]] as const;
      for (let i = 0; i < queenCount - 1; i++) {
        const [x, y] = sites[i]!; state.owner[y * config.mapWidth + x] = 0; state.lastVisit[y * config.mapWidth + x] = 6000;
        if (candidate) {
          state.colonies[0].foodStore = queenFoundingCost(state.colonies[0], config.queenFounding!);
          const error = foundQueen(state, 0, x, y, (config.queenFounding!.firstFoundTick ?? 0) + i * config.queenFounding!.cooldownTicks, []);
          if (error) throw new Error(error.message);
        }
      }
      state.tick = 6000; // Same completed-tick input for baseline and candidate; after both legal foundings.
      const h = await (candidate ? startHarness : baseHarness.startHarness)({ simConfig: config, state });
      try {
        const agent = await h.connect(); await agent.call("join");
        const plain = await agent.client.callTool({ name: "observe", arguments: {} });
        const withMap = await agent.client.callTool({ name: "observe", arguments: { map: true } });
        if (plain.isError || withMap.isError) throw new Error("observe was refused");
        const p = plain.structuredContent as { view: AgentView }, m = withMap.structuredContent as { view: AgentView };
        const visibleCells: AgentView["cells"] = Array.isArray(p.view.cells) ? p.view.cells : expandCells(p.view.cells as unknown as DenseCells);
        const visibleIds = visibleCells.flatMap(cell => cell.ants.map(ant => ant.antId));
        results.push({ build: candidate ? values.head! : BASELINE, defaultBytes: bytes(plain), mapBytes: bytes(withMap), defaultViewBytes: bytes(p.view), mapViewBytes: bytes(m.view),
          squad: p.view.squad.map(({ antId, tileX, tileY }) => ({ antId, tileX, tileY })), visibleCells: visibleCells.length,
          visibleAntEntries: visibleIds.length, uniqueVisibleAnts: new Set(visibleIds).size });
      } finally { await h.close(); }
    }
    samples.push({ antsPerColony: population, candidateOwnQueens: queenCount, baselineOwnQueens: 1, baseline: results[0], candidate: results[1],
      defaultDeltaBytes: results[1]!.defaultBytes - results[0]!.defaultBytes, mapDeltaBytes: results[1]!.mapBytes - results[0]!.mapBytes });
  }
  const report = { exitCode: 0, head: values.head, baseline: BASELINE, private: true,
    method: "Synthetic controlled snapshots: same food, territory, ant roster and tick; baseline one nest, candidate one or three nests. Real loopback MCP SDK observe calls. Bytes are UTF-8 JSON of the complete tool result (text plus structured content), excluding JSON-RPC/HTTP envelopes. View-only bytes also shown. Not a natural match-population benchmark.", samples };
  mkdirSync(dirname(resolve(values.out)), { recursive: true }); writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`exit code 0\n${JSON.stringify(report, null, 2)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(`exit code 1\n${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1; });
}
