import type { EndType, MatchRecord } from "./match.js";
import { asTwoColony } from "../../src/sim/types.js";

export interface Check {
  readonly label: string;
  readonly pass: boolean;
}

export interface SuiteReport {
  readonly name: string;
  readonly lines: readonly string[];
  readonly checks: readonly Check[];
}

export function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n * 100) / of).toFixed(0)}%`;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const END_TYPES: readonly EndType[] = ["overrun", "territory", "tiebreak", "draw"];

/** Count of each way of ending, plus double overruns separately. */
export function endTypeLines(records: readonly MatchRecord[]): { lines: string[]; maxShare: number } {
  const n = records.length;
  let maxShare = 0;
  const parts = END_TYPES.map((type) => {
    const count = records.filter((r) => r.endType === type).length;
    maxShare = Math.max(maxShare, n === 0 ? 0 : count / n);
    return `${type} ${count} (${pct(count, n)})`;
  });
  const doubles = records.filter((r) => r.doubleOverrun).length;
  return { lines: [`  ended by: ${parts.join(", ")}; double overruns ${doubles}`], maxShare };
}

/** Margin (tiles) from the given colony's side at the end. */
function marginFor(record: MatchRecord, colony: 0 | 1): number {
  return record.tiles[colony] - record.tiles[colony === 0 ? 1 : 0];
}

/** Territory margin, queen overruns and squad deaths per minute, from the agent colony's side. */
export function agentSideLines(records: readonly MatchRecord[]): string[] {
  const margins = records.map((r) => marginFor(r, asTwoColony(r.agentColony ?? 0)));
  const overrunByAgents = records.filter((r) => r.endType === "overrun" && r.result.winner === r.agentColony).length;
  const overrunByHouse = records.filter((r) => r.endType === "overrun" && r.result.winner !== r.agentColony).length;
  const deathsPerMin = records.map((r) => {
    const colony = r.agentColony ?? 0;
    return r.squadDeaths[colony] / r.minutes;
  });
  const rejected = records.reduce((n, r) => n + r.rejectedCommands, 0);
  const accepted = records.reduce((n, r) => n + r.acceptedCommands, 0);
  const lapses = records.reduce((n, r) => n + r.squadLapses, 0);
  return [
    `  territory margin (agent colony minus house colony, tiles): mean ${fmt(mean(margins))}, min ${Math.min(...margins)}, max ${Math.max(...margins)}`,
    `  queen overruns: ${overrunByAgents} won by the agent colony, ${overrunByHouse} won by the house colony`,
    `  squad deaths per minute (agent squads): mean ${fmt(mean(deathsPerMin), 2)}`,
    `  agent commands: ${accepted} accepted, ${rejected} rejected; squad lapses ${lapses}`,
  ];
}

/** Wins for the agent colony out of the records. */
export function agentWins(records: readonly MatchRecord[]): number {
  return records.filter((r) => r.agentColony !== null && r.result.winner === r.agentColony).length;
}

export function houseMirrorLines(records: readonly MatchRecord[]): { lines: string[]; wins: [number, number] } {
  const n = records.length;
  const wins: [number, number] = [0, 0];
  let draws = 0;
  for (const r of records) {
    if (r.result.winner === null) draws += 1;
    else wins[r.result.winner] += 1;
  }
  const overruns = records.filter((r) => r.endType === "overrun").length;
  const winnerMargins = records.filter((r) => r.result.winner !== null).map((r) => marginFor(r, asTwoColony(r.result.winner!)));
  const absMargins = records.map((r) => Math.abs(r.tiles[0] - r.tiles[1]));
  const lasting = records.map((r) => r.lastingLeadTick).filter((t): t is number => t !== null);
  const lastingNone = records.length - lasting.length;
  const med = median(lasting);
  return {
    wins,
    lines: [
      `  wins: colony 0 ${wins[0]} (${pct(wins[0], n)}), colony 1 ${wins[1]} (${pct(wins[1], n)}), draws ${draws}`,
      `  queen-overrun rate: ${overruns}/${n} (${pct(overruns, n)})`,
      `  territory margin at end (winner minus loser, tiles): mean ${fmt(mean(winnerMargins))}, min ${winnerMargins.length ? Math.min(...winnerMargins) : "n/a"}, max ${winnerMargins.length ? Math.max(...winnerMargins) : "n/a"}; |colony 0 - colony 1| mean ${fmt(mean(absMargins))}`,
      `  lead became lasting at tick: median ${med === null ? "n/a" : med}, min ${lasting.length ? Math.min(...lasting) : "n/a"}, max ${lasting.length ? Math.max(...lasting) : "n/a"}; none (winner never led on territory to the end, or draw) ${lastingNone}`,
    ],
  };
}
