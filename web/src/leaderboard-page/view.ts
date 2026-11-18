import type { LeaderboardPage, LeaderboardRow, LeaderboardTally } from "../leaderboard.ts";
import { houseDisplayName, isRetiredHouse } from "../../../src/rating/houseLabels.ts";
import { C } from "./copy.ts";

/**
 * A Benchmark model's shown name and badges, derived, never a rename: the handle's display name from
 * the fixed per-handle table (or "Unlisted model" when unlisted, never the handle), a badge for its fixed level
 * when it has one, and a Fast badge when its fixed tier is fast. A Benchmark row's level and tier are its handle's
 * fixed values; other tiers add no badge. A retired handle (isRetiredHouse) adds a retired badge last; it never changes
 * the name, the row or its place.
 */
export function benchmarkLabel(row: Pick<LeaderboardRow, "displayName" | "thinkingLevel" | "serviceTier">): { readonly name: string; readonly badges: readonly string[] } {
  return { name: houseDisplayName(row.displayName), badges: badgeWords(benchmarkBadges(row)) };
}

/** A row's badges by kind, as benchmarkLabel words them: the level it reports, whether its speed tier is fast, and whether
 * its handle is retired. Fast comes only from the tier, so a level that reads "fast" stays a level. */
export interface BadgeKinds { readonly level: string | null; readonly fast: boolean; readonly retired: boolean }
export const NO_BADGES: BadgeKinds = Object.freeze({ level: null, fast: false, retired: false });
export function benchmarkBadges(row: Pick<LeaderboardRow, "displayName" | "thinkingLevel" | "serviceTier">): BadgeKinds {
  return { level: row.thinkingLevel ?? null, fast: row.serviceTier?.toLowerCase() === "fast", retired: isRetiredHouse(row.displayName) };
}
/** Badges as words, in benchmarkLabel's order: the level, Fast, retired. */
export const badgeWords = (kinds: BadgeKinds): string[] =>
  [...(kinds.level !== null ? [kinds.level] : []), ...(kinds.fast ? [C.fastBadge] : []), ...(kinds.retired ? [C.retiredBadge] : [])];
export const hasBadges = (kinds: BadgeKinds): boolean => kinds.level !== null || kinds.fast || kinds.retired;

/** Wins–losses, with draws only for a player who has any; empty without a reconciled tally, never a partial one. */
export function recordText(tally: LeaderboardTally | null): string {
  if (tally === null) return "";
  return tally.draws > 0 ? `${tally.wins}–${tally.losses}–${tally.draws}` : `${tally.wins}–${tally.losses}`;
}

export type PageLoader = (cursor: string | undefined, signal: AbortSignal) => Promise<LeaderboardPage>;

/** One ranking as the page shows it: its rows so far, its continuation, and whether a read is in flight or failed. */
export interface RankingView {
  readonly id: string;
  readonly title: string;
  readonly status: "loading" | "ready" | "error";
  readonly rows: readonly LeaderboardRow[];
  readonly next: string | undefined;
}

/**
 * One ranking with its own cursor, Load more and abort, so it never waits on another table and another table's
 * failure never reaches it. It publishes each change; the page draws it. Retry is the page's Refresh, which starts a new
 * ranking.
 */
export function loadRanking(spec: { title: string; id: string; load: PageLoader }, publish: (view: RankingView) => void): {
  readonly id: string; more(): void; destroy(): void;
} {
  const controller = new AbortController();
  let busy = false, next: string | undefined, rows: readonly LeaderboardRow[] = [];
  const emit = (status: RankingView["status"]) => publish({ id: spec.id, title: spec.title, status, rows, next });
  async function load(cursor: string | undefined) {
    if (busy || controller.signal.aborted) return;
    busy = true; emit("loading");
    try {
      const page = await spec.load(cursor, controller.signal);
      if (controller.signal.aborted) return;
      rows = [...rows, ...page.entries]; next = page.next;
      emit("ready");
    } catch {
      // A failed page keeps the rows already shown and stops this ranking only; it is never complete.
      if (!controller.signal.aborted) { next = undefined; emit("error"); }
    } finally {
      busy = false;
    }
  }
  void load(undefined);
  return {
    id: spec.id,
    more() { if (next !== undefined) void load(next); },
    destroy() { controller.abort(); },
  };
}
