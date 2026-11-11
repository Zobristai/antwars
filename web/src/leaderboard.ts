export interface LeaderboardRow {
  readonly displayName: string;
  readonly rating: number;
  /** Rating deviation, shown as rating ± RD; null for historical pages without one. */
  readonly rd?: number | null;
  readonly ratedMatches: number;
  /** Optional for historical pages; the API reader normalizes missing data to null. */
  readonly thinkingLevel?: string | null;
  /** Self-reported service tier of the latest rated match; null when not recorded. */
  readonly serviceTier?: string | null;
  /** Server-decided antwars ownership (never read from the name); false for historical pages. */
  readonly benchmark?: boolean;
  /** A builder's self-reported model label from its latest rated match in this mode; absent for a house row, none recorded, or an older server. */
  readonly model?: string | null;
  /** Rated results in this mode, adding up to ratedMatches; null when the server has no reconciled record, or for historical pages. */
  readonly tally?: LeaderboardTally | null;
  /** Up to five newest rated results, newest first; empty when there is no tally. */
  readonly form?: readonly FormLetter[];
}
export interface LeaderboardTally { readonly wins: number; readonly losses: number; readonly draws: number }
export interface FormLetter {
  readonly result: "W" | "L" | "D";
  /** The match's replay, or null when none is stored: the letter shows unlinked. */
  readonly replayId: string | null;
}
export interface LeaderboardPage {
  readonly entries: readonly LeaderboardRow[];
  readonly next?: string;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
/** Null, or self-reported seat metadata of 1 to 32 characters. */
const shortText = (value: unknown): value is string | null => value === null || (typeof value === "string" && [...value].length >= 1 && [...value].length <= 32);
/** Null, or a self-reported model label of 1 to 256 characters (seats may report up to 64). */
const modelText = (value: unknown): value is string | null => value === null || (typeof value === "string" && [...value].length >= 1 && [...value].length <= 256);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A server replay id (UTC start stamp and sequence, at most 41 characters); anything else is never linked. */
const REPLAY_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[1-9]\d*$/;
const RESULTS: readonly unknown[] = ["W", "L", "D"];

/** All three counts adding up to ratedMatches, or all three null/absent (no tally); undefined means invalid. */
function readTally(row: Record<string, unknown>, ratedMatches: number): LeaderboardTally | null | undefined {
  const { wins = null, losses = null, draws = null } = row;
  if (wins === null && losses === null && draws === null) return null;
  return count(wins) && count(losses) && count(draws) && wins + losses + draws === ratedMatches ? { wins, losses, draws } : undefined;
}
/** One to five letters with a tally, none without; undefined means invalid. */
function readForm(value: unknown, tally: LeaderboardTally | null): FormLetter[] | undefined {
  const form = value ?? [];
  if (!Array.isArray(form) || form.length > 5 || (tally === null) !== (form.length === 0)) return undefined;
  const letters: FormLetter[] = [];
  for (const entry of form) {
    if (!record(entry) || !RESULTS.includes(entry.result)) return undefined;
    const replayId = entry.replayId ?? null;
    if (replayId !== null && (typeof replayId !== "string" || replayId.length > 41 || !REPLAY_ID.test(replayId))) return undefined;
    letters.push({ result: entry.result as FormLetter["result"], replayId });
  }
  return letters;
}

/** Keep internal ids and any unexpected provider fields out of the displayed projection. */
export function readLeaderboard(value: unknown): LeaderboardPage | null {
  if (!record(value) || !Array.isArray(value.entries) || value.entries.length > 100 ||
    (value.next !== undefined && (typeof value.next !== "string" || value.next.length === 0 || value.next.length > 1000))) return null;
  const entries: LeaderboardRow[] = [];
  for (const row of value.entries) {
    if (!record(row) || typeof row.displayName !== "string" || !row.displayName ||
      typeof row.rating !== "number" || !Number.isFinite(row.rating) ||
      typeof row.ratedMatches !== "number" || !Number.isSafeInteger(row.ratedMatches) || row.ratedMatches < 1) return null;
    const thinkingLevel = row.thinkingLevel ?? null;
    const serviceTier = row.serviceTier ?? null;
    const benchmark = row.benchmark ?? false;
    const model = row.model ?? null;
    const rd = row.rd ?? null;
    if (rd !== null && (typeof rd !== "number" || !Number.isFinite(rd) || rd <= 0)) return null;
    if (!shortText(thinkingLevel) || !shortText(serviceTier) || typeof benchmark !== "boolean" || !modelText(model)) return null;
    const tally = readTally(row, row.ratedMatches);
    const form = tally === undefined ? undefined : readForm(row.form, tally);
    if (tally === undefined || form === undefined) return null;
    entries.push({ displayName: row.displayName, rating: row.rating, rd, ratedMatches: row.ratedMatches, thinkingLevel, serviceTier, benchmark, ...(model === null ? {} : { model }), tally, form });
  }
  return { entries, ...(value.next === undefined ? {} : { next: value.next as string }) };
}

export type LeaderboardMode = "1v1" | "2v2" | "3v3" | "4v4" | "house-1v1" | "house-2v2" | "house-3v3" | "house-4v4";
/** One ranking read: a mode, and for a public mode optionally only its house-owned identities. */
export interface LeaderboardQuery { readonly mode: LeaderboardMode; readonly scope?: "house" }

/** Without a query the request is the original 1v1 read; a cursor is only ever resent with the query that issued it. */
export async function loadLeaderboard(cursor?: string, signal?: AbortSignal, request: typeof fetch = fetch, query?: LeaderboardQuery): Promise<LeaderboardPage> {
  const response = await request("/api/leaderboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      limit: 50,
      ...(query === undefined ? {} : { mode: query.mode, ...(query.scope === undefined ? {} : { scope: query.scope }) }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Leaderboard unavailable. Try refreshing the list.");
  const page = readLeaderboard(await response.json());
  if (!page) throw new Error("Leaderboard unavailable. Try refreshing the list.");
  return page;
}
