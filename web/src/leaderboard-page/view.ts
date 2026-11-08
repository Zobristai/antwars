import type { LeaderboardPage, LeaderboardRow, LeaderboardTally } from "../leaderboard.ts";
import { houseDisplayName } from "../../../src/rating/houseLabels.ts";
import { C } from "./copy.ts";

/**
 * A Benchmark model's shown name and badges, derived, never a rename: the handle's display name from
 * the fixed per-handle table (or "Unlisted model" when unlisted, never the handle), a badge for its fixed level
 * when it has one, and a Fast badge when its fixed tier is fast. A Benchmark row's level and tier are its handle's
 * fixed values; other tiers add no badge.
 */
export function benchmarkLabel(row: Pick<LeaderboardRow, "displayName" | "thinkingLevel" | "serviceTier">): { readonly name: string; readonly badges: readonly string[] } {
  const badges: string[] = [];
  if (row.thinkingLevel != null) badges.push(row.thinkingLevel);
  if (row.serviceTier?.toLowerCase() === "fast") badges.push(C.fastBadge);
  return { name: houseDisplayName(row.displayName), badges };
}

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
