import type { TypedHistorySummary } from "./history-routes.js";
import { neverJoined } from "./listed-colonies.js";
import { isHouseHandle } from "./recorded-match-type.js";
import type { Ratings } from "../rating/ratings.js";

interface User {
  username: string; agents: Set<string>; matches: number; wins: number; losses: number; own: number;
  latest: { startedAt: string; id: string }; models: Map<string, string>;
}

type Recheck = (rows: TypedHistorySummary[], signal: AbortSignal) => Promise<TypedHistorySummary[]>;

/** Defer the tally until all reads of the ranking have finished and contributing recordings have passed a second check. */
export async function publicUsers(batches: AsyncIterable<readonly TypedHistorySummary[]>, ratings: Pick<Ratings, "leaderboard"> | undefined, signal: AbortSignal, recheck: Recheck) {
  const ids = new Set<string>(), names = new Set<string>(), candidates: TypedHistorySummary[] = [];
  let bytes = 0;
  for await (const batch of batches) for (const match of batch) {
    signal.throwIfAborted();
    if (ids.has(match.id) || neverJoined(match)) continue;
    const handles = match.seats.flatMap(s => s.handle && !isHouseHandle(s.handle) ? [s.handle] : []);
    if (!handles.length) continue;
    bytes += Buffer.byteLength(JSON.stringify(match));
    if (bytes > 8 * 1024 * 1024) throw new Error("Listing size limit reached");
    ids.add(match.id); candidates.push(match);
    for (const handle of handles) names.add(handle.split("/", 1)[0]!);
  }
  const ranked = new Map<string, { rating: number; rd: number; ratedMatches: number }>();
  if (candidates.length) {
    if (!ratings) throw new Error("Rankings unavailable");
    const cursors = new Set<string>(); let cursor: string | undefined;
    let storagePages = 0;
    const beforeStoragePage = () => {
      signal.throwIfAborted();
      if (++storagePages > 64) throw new Error("Ranking scan limit reached");
    };
    do {
      signal.throwIfAborted();
      const result = await ratings.leaderboard({ mode: "1v1", scope: "everyone", limit: 50, cursor, beforeStoragePage });
      signal.throwIfAborted();
      if (!result.ok) throw new Error("Rankings unavailable");
      for (const { displayName, rating, rd, ratedMatches } of result.value.entries) {
        if (names.has(displayName)) ranked.set(displayName, { rating, rd, ratedMatches });
      }
      cursor = result.value.next;
      if (cursor !== undefined) {
        if (cursors.size >= 63 || cursors.has(cursor)) throw new Error("Repeated ranking continuation");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
  }

  const users = new Map<string, User>();
  for (let start = 0; start < candidates.length; start += 20) {
    signal.throwIfAborted();
    const visible = await recheck(candidates.slice(start, start + 20), signal);
    for (const match of visible) tally(users, match);
  }
  signal.throwIfAborted();
  return [...users.values()].map(({ username, agents, latest, matches, wins, losses, own, models }) => {
    const labels = [...models].sort(([a, at], [b, bt]) => bt.localeCompare(at) || a.localeCompare(b));
    return { username, agents: [...agents].sort(), matches, wins, losses, own, latest, model: labels[0]?.[0] ?? null,
      moreModels: Math.max(0, labels.length - 1), ranked: ranked.get(username) ?? null };
  });
}

function tally(users: Map<string, User>, match: TypedHistorySummary) {
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
