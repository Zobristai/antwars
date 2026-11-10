import { describe, expect, it } from "vitest";
import { rateMatch, UNRATED, type PlayerState } from "../../src/rating/ratings.ts";
import { HARNESS_PHASES, harnessPhaseAt } from "../../src/rating/harnessPhase.ts";
import { houseLabel } from "../../src/rating/houseLabels.ts";
import { BASELINE_MATCHES, BASELINE_PHASE, baselineSet, baselineTable, type BaselineMatch } from "../../src/rating/vanillaBaseline.ts";

/** The live table's own update (ratings.ts rateMatch, by glicko.ts) over `matches` in order, from 1500 ± 350. */
function liveReplay(matches: readonly BaselineMatch[]) {
  const states = new Map<string, PlayerState>();
  const records = new Map<string, { wins: number; losses: number; draws: number; form: { result: string; replayId: string }[] }>();
  for (const match of matches) {
    const { next } = rateMatch(match.teams, match.winner, Date.parse(match.startedAt), id => states.get(id) ?? UNRATED);
    for (const [id, state] of next) states.set(id, state);
    match.teams.forEach((team, side) => {
      const result = match.winner === "draw" ? "D" : (match.winner === "a") === (side === 0) ? "W" : "L";
      for (const id of team) {
        const record = records.get(id) ?? { wins: 0, losses: 0, draws: 0, form: [] };
        if (result === "W") record.wins++; else if (result === "L") record.losses++; else record.draws++;
        record.form = [{ result, replayId: match.replayId }, ...record.form].slice(0, 5);
        records.set(id, record);
      }
    });
  }
  return { states, records };
}

const phaseRow = HARNESS_PHASES.findIndex(row => row.phase === BASELINE_PHASE);
const phaseStart = HARNESS_PHASES[phaseRow]!.startsAt!;
const phaseEnd = HARNESS_PHASES[phaseRow + 1]!.startsAt!;

describe("the vanilla baseline: rounds 26-30", () => {
  it("is the phase table's rounds 26-30 row: 36 rated 1v1 matches, each inside it, unique, in rated (end) order", () => {
    expect(BASELINE_MATCHES).toHaveLength(36);
    expect(new Set(BASELINE_MATCHES.map(match => match.replayId)).size).toBe(36);
    for (const match of BASELINE_MATCHES) {
      const at = Date.parse(match.startedAt);
      expect(harnessPhaseAt(at).phase).toBe("rounds 26-30");
      expect(at >= phaseStart && at < phaseEnd).toBe(true);
      expect(Date.parse(match.endedAt)).toBeGreaterThan(at);
      expect(match.teams.map(team => team.length)).toEqual([1, 1]);
      expect(match.teams[0][0]).not.toBe(match.teams[1][0]);
    }
    expect(baselineSet(BASELINE_MATCHES)).toEqual(BASELINE_MATCHES);
    // The last round-30 match closed by 2026-11-09T06:26Z; none is later.
    expect(BASELINE_MATCHES.every(match => match.endedAt < "2026-11-09T06:26:00Z")).toBe(true);
  });

  it("equals a fresh replay of exactly that set through the live table's Glicko update", () => {
    const table = baselineTable();
    const { states, records } = liveReplay(BASELINE_MATCHES);
    expect(table.map(row => row.displayName).sort()).toEqual([...states.keys()].sort());
    for (const row of table) {
      const state = states.get(row.displayName)!, record = records.get(row.displayName)!;
      expect(row.rating).toBe(state.rating);
      expect(row.rd).toBe(state.rd);
      expect(row.ratedMatches).toBe(state.ratedMatches);
      expect(row.tally).toEqual({ wins: record.wins, losses: record.losses, draws: record.draws });
      expect(row.form).toEqual(record.form);
      expect(row.benchmark).toBe(true);
      expect({ thinkingLevel: row.thinkingLevel, serviceTier: row.serviceTier }).toEqual(houseLabel(row.displayName));
    }
    expect(table.map(row => row.rating)).toEqual(table.map(row => row.rating).sort((x, y) => y - x));
    expect(table.reduce((total, row) => total + row.ratedMatches, 0)).toBe(72);
  });

  it("counts only matches in the rounds 26-30 phase, and applies them by end time whatever order they are given in", () => {
    const before: BaselineMatch = { replayId: "2026-11-06T10-00-00-000Z-1", startedAt: new Date(phaseStart - 60_000).toISOString(),
      endedAt: new Date(phaseStart - 1).toISOString(), teams: [["antwars/grok-4-7"], ["antwars/glm-5-3"]], winner: "a" };
    const after: BaselineMatch = { ...before, replayId: "2026-11-10T10-00-00-000Z-1", startedAt: new Date(phaseEnd).toISOString(),
      endedAt: new Date(phaseEnd + 60_000).toISOString() };
    const shuffled = [after, ...[...BASELINE_MATCHES].reverse(), before];
    expect(baselineSet(shuffled)).toEqual(BASELINE_MATCHES);
    expect(baselineTable(shuffled)).toEqual(baselineTable());
  });

  it("starts every handle at 1500 ± 350 and grows RD by the time since its previous match in the set", () => {
    const first: BaselineMatch = { replayId: "r-1", startedAt: new Date(phaseStart).toISOString(), endedAt: new Date(phaseStart + 1).toISOString(),
      teams: [["antwars/a"], ["antwars/b"]], winner: "a" };
    const later: BaselineMatch = { ...first, replayId: "r-2", startedAt: new Date(phaseStart + 86_400_000).toISOString(),
      endedAt: new Date(phaseStart + 86_400_001).toISOString(), winner: "b" };
    const { states } = liveReplay([first, later]);
    const rows = new Map(baselineTable([first, later]).map(row => [row.displayName, row]));
    for (const name of ["antwars/a", "antwars/b"]) {
      expect(rows.get(name)!.rating).toBe(states.get(name)!.rating);
      expect(rows.get(name)!.rd).toBe(states.get(name)!.rd);
    }
    expect(rateMatch(first.teams, "a", Date.parse(first.startedAt), () => UNRATED).changes.map(change => [change.before, change.rdBefore]))
      .toEqual([[1500, 350], [1500, 350]]);
  });
});
