import type { TypedHistorySummary } from "./history-routes.js";
import { neverJoined } from "./listed-colonies.js";
import { isHouseHandle } from "./recorded-match-type.js";
import type { Ratings } from "../rating/ratings.js";

interface Recent {
  id: string; startedAt: string; matchType: TypedHistorySummary["matchType"];
  agents: string[]; opponents: { handle: string | null; modelLabel: string | null; thinkingLevel: string | null; serviceTier: string | null }[];
  result: "Own match" | "Won" | "Lost" | "Draw" | "Abandoned" | "No result";
}
interface User {
  username: string; agents: Map<string, { matches: number; models: Set<string> }>; recent: Recent[]; matches: number; wins: number; losses: number; own: number;
  latest: { startedAt: string; id: string }; models: Map<string, string>;
}

/** The scanner yields unique public recordings. Retain only displayed users, their distinct handles and model labels. */
export async function publicUsers(batches: AsyncIterable<readonly TypedHistorySummary[]>, ratings: Pick<Ratings, "leaderboard"> | undefined, signal: AbortSignal) {
  const users = new Map<string, User>();
  for await (const batch of batches) for (const match of batch) {
    signal.throwIfAborted();
    if (!neverJoined(match)) tally(users, match);
  }
  const ranked = new Map<string, { rating: number; rd: number; ratedMatches: number }>();
  if (users.size) {
    if (!ratings) throw new Error("Rankings unavailable");
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const result = await ratings.leaderboard({ mode: "1v1", scope: "everyone", limit: 50, cursor, signal });
      signal.throwIfAborted();
      if (!result.ok) throw new Error("Rankings unavailable");
      for (const { displayName, rating, rd, ratedMatches } of result.value.entries) {
        const user = users.get(displayName.split("/", 1)[0]!);
        if (user && (displayName === user.username || user.agents.has(displayName))) ranked.set(displayName, { rating, rd, ratedMatches });
      }
      if (result.value.next !== undefined && cursor === result.value.next) throw new Error("Repeated ranking continuation");
      cursor = result.value.next;
    } while (cursor !== undefined);
  }
  signal.throwIfAborted();
  return [...users.values()].map(({ username, agents, recent, latest, matches, wins, losses, own, models }) => {
    const labels = [...models].sort(([a, at], [b, bt]) => bt.localeCompare(at) || a.localeCompare(b));
    const played = [...agents.keys()].sort();
    let rating = ranked.get(username), via: string | undefined;
    if (!rating) for (const handle of played) {
      const agent = ranked.get(handle);
      if (agent && (!rating || agent.rating > rating.rating)) { rating = agent; via = handle; }
    }
    return { username, agents: played, agentDetails: played.map(handle => ({ handle, matches: agents.get(handle)!.matches, models: [...agents.get(handle)!.models].sort() })), recent, matches, wins, losses, own, latest, model: labels[0]?.[0] ?? null,
      moreModels: Math.max(0, labels.length - 1), ranked: rating ? { ...rating, ...(via ? { via } : {}) } : null };
  });
}

function tally(users: Map<string, User>, match: TypedHistorySummary) {
  const played = new Set<string>();
  const colonies = new Map<User, Set<number>>();
  for (const { handle, colony, modelLabel } of match.seats) {
    if (!handle || isHouseHandle(handle)) continue;
    const username = handle.split("/", 1)[0]!;
    if (!username) continue;
    const latest = { startedAt: match.startedAt, id: match.id };
    let user = users.get(username);
    if (!user) {
      user = { username, agents: new Map(), recent: [], matches: 0, wins: 0, losses: 0, own: 0, latest, models: new Map() };
      users.set(username, user);
    }
    if (latest.startedAt > user.latest.startedAt || (latest.startedAt === user.latest.startedAt && latest.id > user.latest.id)) user.latest = latest;
    if (modelLabel && (!user.models.has(modelLabel) || match.startedAt > user.models.get(modelLabel)!)) user.models.set(modelLabel, match.startedAt);
    let agent = user.agents.get(handle);
    if (!agent) { agent = { matches: 0, models: new Set() }; user.agents.set(handle, agent); }
    if (modelLabel) agent.models.add(modelLabel);
    if (!played.has(handle)) { agent.matches++; played.add(handle); }
    const sides = colonies.get(user) ?? new Set<number>(); sides.add(colony); colonies.set(user, sides);
  }
  for (const [user, sides] of colonies) {
    user.matches++;
    const result = sides.size > 1 ? "Own match" : match.reason === "abandoned" ? "Abandoned" : match.decidedBy === "draw" ? "Draw"
      : match.winner === null ? "No result" : sides.has(match.winner) ? "Won" : "Lost";
    if (result === "Own match") user.own++;
    else if (result === "Won") user.wins++;
    else if (result === "Lost") user.losses++;
    const agents = [...played].filter(handle => handle.split("/", 1)[0] === user.username);
    const opponents = match.seats.filter(seat => !sides.has(seat.colony) || sides.size > 1).map(({ handle, modelLabel, thinkingLevel, serviceTier }) => ({ handle, modelLabel, thinkingLevel, serviceTier }));
    user.recent.push({ id: match.id, startedAt: match.startedAt, matchType: match.matchType, agents, opponents, result });
    user.recent.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    if (user.recent.length > 5) user.recent.pop();
  }
}
