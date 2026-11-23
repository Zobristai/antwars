import type { TypedHistorySummary } from "./history-routes.js";
import { neverJoined } from "./listed-colonies.js";
import { isHouseHandle } from "./recorded-match-type.js";
import type { Ratings } from "../rating/ratings.js";

interface User {
  username: string; agents: Set<string>; matches: number; wins: number; losses: number; own: number;
  latest: { startedAt: string; id: string }; models: Map<string, string>;
}

/** Receives only served rows. Ranking data may decorate a listed user, never create one. */
export async function publicUsers(batches: AsyncIterable<readonly TypedHistorySummary[]>, ratings: Pick<Ratings, "leaderboard"> | undefined, signal: AbortSignal) {
  const seen = new Set<string>(), users = new Map<string, User>();
  for await (const batch of batches) for (const match of batch) {
    signal.throwIfAborted();
    if (neverJoined(match) || seen.has(match.id)) continue;
    seen.add(match.id);
    const colonies = new Map<User, Set<number>>();
    for (const { handle, colony, modelLabel } of match.seats) {
      if (!handle || isHouseHandle(handle)) continue;
      const username = handle.split("/", 1)[0]!;
      if (!username) continue;
      const latest = { startedAt: match.startedAt, id: match.id };
      let user = users.get(username);
      if (!user) {
        user = { username, agents: new Set(), matches: 0, wins: 0, losses: 0, own: 0, latest, models: new Map() };
        users.set(username, user);
      }
      if (latest.startedAt > user.latest.startedAt || (latest.startedAt === user.latest.startedAt && latest.id > user.latest.id)) user.latest = latest;
      if (modelLabel && (!user.models.has(modelLabel) || match.startedAt > user.models.get(modelLabel)!)) user.models.set(modelLabel, match.startedAt);
      user.agents.add(handle);
      const sides = colonies.get(user) ?? new Set<number>(); sides.add(colony); colonies.set(user, sides);
    }
    for (const [user, sides] of colonies) {
      user.matches++;
      if (sides.size > 1) user.own++;
      else if (match.winner !== null && match.reason !== "abandoned" && match.decidedBy !== "draw") {
        if (sides.has(match.winner)) user.wins++; else user.losses++;
      }
    }
  }
  const ranked = new Map<string, { rating: number; rd: number; ratedMatches: number }>();
  if (users.size) {
    if (!ratings) throw new Error("Rankings unavailable");
    const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const result = await ratings.leaderboard({ mode: "1v1", scope: "everyone", limit: 50, cursor });
      if (!result.ok) throw new Error("Rankings unavailable");
      for (const { displayName, rating, rd, ratedMatches } of result.value.entries) {
        if (users.has(displayName)) ranked.set(displayName, { rating, rd, ratedMatches });
      }
      cursor = result.value.next;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error("Repeated ranking continuation");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
  }
  return [...users.values()].map(({ username, agents, latest, matches, wins, losses, own, models }) => {
    const labels = [...models].sort(([a, at], [b, bt]) => bt.localeCompare(at) || a.localeCompare(b));
    return { username, agents: [...agents].sort(), matches, wins, losses, own, latest, model: labels[0]?.[0] ?? null,
      moreModels: Math.max(0, labels.length - 1), ranked: ranked.get(username) ?? null };
  });
}
