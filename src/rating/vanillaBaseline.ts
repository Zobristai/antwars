/**
 * The vanilla baseline: the Antwars Model Index 1v1 re-rated from the rounds 26-30 harness phase alone, beside the live
 * table and never in place of it. Nothing here reads or writes the store, and no stored rating, RD or change record
 * moves.
 *
 * The matches are a committed snapshot of the public match history: the rated Model Index 1v1 recordings of rounds 26 to
 * 30. The phase row in harnessPhase.ts decides which matches count, so this file holds no boundary of its own. A
 * match's time is its recording's start (the lobby's own start time is not public); the two differ by seconds.
 *
 * The method is the live table's (ratings.ts rateMatch, by glicko.ts): every handle starts at 1500 with RD 350, each
 * match is its own rating period in the order the matches were rated (by end time), and a player's RD grows by the time
 * since its previous match in this set.
 */
import { INITIAL_RD, glickoUpdate, inflatedRd, teamAsOpponent } from "./glicko.js";
import { harnessPhaseAt, type HarnessPhaseName } from "./harnessPhase.js";
import { houseLabel } from "./houseLabels.js";

export const BASELINE_PHASE: HarnessPhaseName = "rounds 26-30";
export const BASELINE_INITIAL_RATING = 1500;

export interface BaselineMatch {
  /** The recording's public id: its replay. */
  readonly replayId: string;
  /** ISO-8601 UTC. startedAt is the match time; endedAt orders the matches as they were rated. */
  readonly startedAt: string;
  readonly endedAt: string;
  /** owner/handle display names: colony 0's team, then colony 1's. */
  readonly teams: readonly [readonly string[], readonly string[]];
  /** a: colony 0 won; b: colony 1 won. */
  readonly winner: "a" | "b" | "draw";
}

/** The rated Model Index 1v1 recordings from the start of round 26 to the end of round 30, oldest end first. */
export const BASELINE_MATCHES: readonly BaselineMatch[] = Object.freeze([
  { replayId: "2026-11-07T07-49-09-451Z-134356668445299", startedAt: "2026-11-07T07:49:09.451Z", endedAt: "2026-11-07T08:02:02.878Z", teams: [["antwars/glm-5-3"], ["antwars/k3-1-pro-highspeed"]], winner: "b" },
  { replayId: "2026-11-07T07-47-08-869Z-192475514086541", startedAt: "2026-11-07T07:47:08.869Z", endedAt: "2026-11-07T08:02:22.089Z", teams: [["antwars/claude-opus-5-5"], ["antwars/gpt-6-1-sol-high"]], winner: "a" },
  { replayId: "2026-11-07T07-51-13-276Z-131682340830334", startedAt: "2026-11-07T07:51:13.276Z", endedAt: "2026-11-07T08:09:18.012Z", teams: [["antwars/gpt-6-astra"], ["antwars/grok-4-7"]], winner: "a" },
  { replayId: "2026-11-07T07-55-54-786Z-234998513982265", startedAt: "2026-11-07T07:55:54.786Z", endedAt: "2026-11-07T08:14:13.903Z", teams: [["antwars/claude-opus-5-5-max"], ["antwars/k3-1-pro"]], winner: "b" },
  { replayId: "2026-11-07T07-57-45-597Z-40309638142257", startedAt: "2026-11-07T07:57:45.597Z", endedAt: "2026-11-07T08:20:44.984Z", teams: [["antwars/gpt-6-1-sol-xhigh-fast"], ["antwars/deepseek-flash"]], winner: "a" },
  { replayId: "2026-11-07T07-52-55-478Z-255927726434032", startedAt: "2026-11-07T07:52:55.478Z", endedAt: "2026-11-07T08:21:22.705Z", teams: [["antwars/abliterated-large-v2"], ["antwars/gpt-6-1-sol-high-fast"]], winner: "b" },
  { replayId: "2026-11-07T08-12-29-719Z-280473280639981", startedAt: "2026-11-07T08:12:29.719Z", endedAt: "2026-11-07T08:27:48.336Z", teams: [["antwars/gemini-4-argon"], ["antwars/claude-opus-5-5-medium"]], winner: "b" },
  { replayId: "2026-11-07T08-24-50-969Z-128629834512147", startedAt: "2026-11-07T08:24:50.969Z", endedAt: "2026-11-07T08:35:27.984Z", teams: [["antwars/gpt-6-1-sol"], ["antwars/claude-fable-5-1"]], winner: "a" },
  { replayId: "2026-11-07T08-06-22-562Z-50395239643074", startedAt: "2026-11-07T08:06:22.562Z", endedAt: "2026-11-07T08:36:22.476Z", teams: [["antwars/gpt-6-luna"], ["antwars/mistral-large-4"]], winner: "a" },
  { replayId: "2026-11-07T08-21-43-359Z-45431138040958", startedAt: "2026-11-07T08:21:43.359Z", endedAt: "2026-11-07T08:37:32.848Z", teams: [["antwars/gemini-3-8-flash"], ["antwars/gpt-6-1-sol-xhigh"]], winner: "b" },
  { replayId: "2026-11-07T10-59-14-789Z-34232760967105", startedAt: "2026-11-07T10:59:14.789Z", endedAt: "2026-11-07T11:18:59.749Z", teams: [["antwars/gpt-6-astra"], ["antwars/grok-4-7"]], winner: "a" },
  { replayId: "2026-11-07T10-54-42-454Z-87602157698539", startedAt: "2026-11-07T10:54:42.454Z", endedAt: "2026-11-07T11:24:07.285Z", teams: [["antwars/k3-1-pro-highspeed"], ["antwars/glm-5-3"]], winner: "a" },
  { replayId: "2026-11-07T11-16-34-654Z-185554405736475", startedAt: "2026-11-07T11:16:34.654Z", endedAt: "2026-11-07T11:31:34.581Z", teams: [["antwars/gpt-6-luna"], ["antwars/mistral-large-4"]], winner: "a" },
  { replayId: "2026-11-07T17-05-46-806Z-40584722750527", startedAt: "2026-11-07T17:05:46.806Z", endedAt: "2026-11-07T17:13:30.234Z", teams: [["antwars/gpt-6-astra"], ["antwars/grok-4-7"]], winner: "a" },
  { replayId: "2026-11-07T17-13-05-118Z-75348354216183", startedAt: "2026-11-07T17:13:05.118Z", endedAt: "2026-11-07T17:23:44.942Z", teams: [["antwars/claude-sonnet-5-5"], ["antwars/gpt-6-1-sol-xhigh"]], winner: "b" },
  { replayId: "2026-11-07T17-11-38-428Z-270161835609926", startedAt: "2026-11-07T17:11:38.428Z", endedAt: "2026-11-07T17:25:40.358Z", teams: [["antwars/claude-opus-5-5-medium"], ["antwars/gpt-6-1-sol-high"]], winner: "a" },
  { replayId: "2026-11-07T17-17-38-897Z-181743760842621", startedAt: "2026-11-07T17:17:38.897Z", endedAt: "2026-11-07T17:32:09.619Z", teams: [["antwars/claude-fable-5-1"], ["antwars/glm-5-3"]], winner: "b" },
  { replayId: "2026-11-07T17-07-39-848Z-235508721079932", startedAt: "2026-11-07T17:07:39.848Z", endedAt: "2026-11-07T17:37:12.879Z", teams: [["antwars/abliterated-large-v2"], ["antwars/gpt-6-1-sol-high-fast"]], winner: "a" },
  { replayId: "2026-11-07T17-19-37-116Z-247193090089987", startedAt: "2026-11-07T17:19:37.116Z", endedAt: "2026-11-07T17:39:27.349Z", teams: [["antwars/deepseek-flash"], ["antwars/claude-opus-5-5-low"]], winner: "a" },
  { replayId: "2026-11-07T17-31-13-826Z-23222234613391", startedAt: "2026-11-07T17:31:13.826Z", endedAt: "2026-11-07T17:52:02.344Z", teams: [["antwars/claude-opus-5-5"], ["antwars/gemini-4-argon"]], winner: "a" },
  { replayId: "2026-11-07T17-22-30-017Z-215643078549572", startedAt: "2026-11-07T17:22:30.017Z", endedAt: "2026-11-07T17:52:29.936Z", teams: [["antwars/qwen3-8-max"], ["antwars/gemini-3-8-flash"]], winner: "a" },
  { replayId: "2026-11-07T17-34-23-996Z-204039607174793", startedAt: "2026-11-07T17:34:23.996Z", endedAt: "2026-11-07T17:53:47.416Z", teams: [["antwars/k3-1-pro"], ["antwars/claude-opus-5-5-xhigh"]], winner: "b" },
  { replayId: "2026-11-08T01-07-42-990Z-28737297615330", startedAt: "2026-11-08T01:07:42.990Z", endedAt: "2026-11-08T01:21:06.726Z", teams: [["antwars/claude-fable-5-1"], ["antwars/grok-4-7"]], winner: "a" },
  { replayId: "2026-11-08T01-11-46-836Z-82269399525813", startedAt: "2026-11-08T01:11:46.836Z", endedAt: "2026-11-08T01:22:50.771Z", teams: [["antwars/abliterated-large-v2"], ["antwars/claude-opus-5-5"]], winner: "a" },
  { replayId: "2026-11-08T01-14-33-694Z-131433051195509", startedAt: "2026-11-08T01:14:33.694Z", endedAt: "2026-11-08T01:27:25.325Z", teams: [["antwars/gemini-3-8-flash"], ["antwars/gpt-6-1-sol-high"]], winner: "b" },
  { replayId: "2026-11-08T01-04-58-802Z-102941375460308", startedAt: "2026-11-08T01:04:58.802Z", endedAt: "2026-11-08T01:29:02.840Z", teams: [["antwars/gpt-6-luna"], ["antwars/mistral-large-4"]], winner: "b" },
  { replayId: "2026-11-08T01-10-15-054Z-5155420166141", startedAt: "2026-11-08T01:10:15.054Z", endedAt: "2026-11-08T01:34:04.470Z", teams: [["antwars/k3-1-pro"], ["antwars/gpt-6-1-sol-xhigh-fast"]], winner: "a" },
  { replayId: "2026-11-08T01-25-05-294Z-24999330571486", startedAt: "2026-11-08T01:25:05.294Z", endedAt: "2026-11-08T01:34:58.790Z", teams: [["antwars/claude-opus-5-5-max"], ["antwars/gpt-6-1-sol-xhigh"]], winner: "a" },
  { replayId: "2026-11-08T01-16-14-608Z-143717685306434", startedAt: "2026-11-08T01:16:14.608Z", endedAt: "2026-11-08T01:37:18.721Z", teams: [["antwars/k3-1-pro-highspeed"], ["antwars/gpt-6-1-sol-high-fast"]], winner: "a" },
  { replayId: "2026-11-08T09-05-07-310Z-87025670090778", startedAt: "2026-11-08T09:05:07.310Z", endedAt: "2026-11-08T09:20:56.744Z", teams: [["antwars/gpt-6-1-sol-xhigh"], ["antwars/claude-fable-5-1"]], winner: "b" },
  { replayId: "2026-11-08T09-08-49-208Z-235719724016210", startedAt: "2026-11-08T09:08:49.208Z", endedAt: "2026-11-08T09:21:34.840Z", teams: [["antwars/deepseek-flash"], ["antwars/gpt-6-luna"]], winner: "a" },
  { replayId: "2026-11-08T09-15-07-795Z-152970737303801", startedAt: "2026-11-08T09:15:07.795Z", endedAt: "2026-11-08T09:35:48.082Z", teams: [["antwars/gemini-4-argon"], ["antwars/claude-sonnet-5-5"]], winner: "b" },
  { replayId: "2026-11-09T05-38-11-876Z-221955748729745", startedAt: "2026-11-09T05:38:11.876Z", endedAt: "2026-11-09T05:52:55.468Z", teams: [["antwars/glm-5-3"], ["antwars/claude-opus-5-5-max"]], winner: "a" },
  { replayId: "2026-11-09T05-41-32-150Z-261473107257684", startedAt: "2026-11-09T05:41:32.150Z", endedAt: "2026-11-09T05:59:00.184Z", teams: [["antwars/grok-4-7"], ["antwars/gpt-6-1-sol-high"]], winner: "a" },
  { replayId: "2026-11-09T05-34-13-801Z-150570001262628", startedAt: "2026-11-09T05:34:13.801Z", endedAt: "2026-11-09T06:14:44.108Z", teams: [["antwars/mistral-large-4"], ["antwars/mimo-v2-6-flash"]], winner: "b" },
  { replayId: "2026-11-09T06-06-49-048Z-96882676692717", startedAt: "2026-11-09T06:06:49.048Z", endedAt: "2026-11-09T06:21:21.848Z", teams: [["antwars/abliterated-large-v2"], ["antwars/gpt-6-1-sol"]], winner: "a" },
]);

export interface BaselineRow {
  readonly displayName: string;
  readonly rating: number;
  readonly rd: number;
  readonly ratedMatches: number;
  /** The handle's fixed level and tier (houseLabels.ts), as the live table shows for a Benchmark row. */
  readonly thinkingLevel: string | null;
  readonly serviceTier: string | null;
  readonly benchmark: true;
  readonly tally: { readonly wins: number; readonly losses: number; readonly draws: number };
  /** Up to five newest results in this set, newest first. */
  readonly form: readonly { readonly result: "W" | "L" | "D"; readonly replayId: string }[];
}

interface Player { rating: number; rd: number; ratedAt: number | null; wins: number; losses: number; draws: number; form: BaselineRow["form"][number][] }

/** The matches of `matches` in the baseline phase, in rated order (end time, then replay id). */
export function baselineSet(matches: readonly BaselineMatch[]): BaselineMatch[] {
  return matches.filter(match => harnessPhaseAt(Date.parse(match.startedAt)).phase === BASELINE_PHASE)
    .sort((x, y) => Date.parse(x.endedAt) - Date.parse(y.endedAt) || (x.replayId < y.replayId ? -1 : x.replayId > y.replayId ? 1 : 0));
}

/** The baseline table, highest rating first (name breaks ties): a fresh Glicko-1 replay of the baseline set. */
export function baselineTable(matches: readonly BaselineMatch[] = BASELINE_MATCHES): BaselineRow[] {
  const players = new Map<string, Player>();
  const current = (name: string): Player => {
    let player = players.get(name);
    if (!player) players.set(name, player = { rating: BASELINE_INITIAL_RATING, rd: INITIAL_RD, ratedAt: null, wins: 0, losses: 0, draws: 0, form: [] });
    return player;
  };
  for (const match of baselineSet(matches)) {
    const at = Date.parse(match.startedAt);
    const scoreA = match.winner === "a" ? 1 : match.winner === "b" ? 0 : 0.5;
    // Every player enters at its state before this match, exactly as rateMatch reads them, before any is updated.
    const entering = match.teams.map(team => team.map(name => {
      const player = current(name);
      return { name, player, rating: player.rating, rd: inflatedRd(player.rd, player.ratedAt !== null ? at - player.ratedAt : null) };
    }));
    const updates = match.teams.flatMap((_, side) => {
      const opponent = teamAsOpponent(entering[1 - side]!);
      const score = side === 0 ? scoreA : 1 - scoreA;
      return entering[side]!.map(entry => ({ entry, score, after: glickoUpdate(entry, [{ ...opponent, score }]) }));
    });
    for (const { entry: { player }, score, after } of updates) {
      player.rating = after.rating; player.rd = after.rd; player.ratedAt = at;
      const result: "W" | "L" | "D" = score === 1 ? "W" : score === 0 ? "L" : "D";
      if (result === "W") player.wins++; else if (result === "L") player.losses++; else player.draws++;
      player.form = [{ result, replayId: match.replayId }, ...player.form].slice(0, 5);
    }
  }
  return [...players].map(([displayName, player]): BaselineRow => ({
    displayName, rating: player.rating, rd: player.rd, ratedMatches: player.wins + player.losses + player.draws,
    ...houseLabel(displayName), benchmark: true,
    tally: { wins: player.wins, losses: player.losses, draws: player.draws }, form: player.form,
  })).sort((x, y) => y.rating - x.rating || (x.displayName < y.displayName ? -1 : x.displayName > y.displayName ? 1 : 0));
}
