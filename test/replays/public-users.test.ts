import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { historyRoutes, type RecordingLobbyLookup } from "../../src/replays/history-routes.ts";
import type { HistorySource, HistorySummary } from "../../src/replays/history-source.ts";
import type { LeaderboardEntry } from "../../src/rating/ratings.ts";
import { createTestRecordings } from "../../src/replays/test-recordings.ts";
import { neverJoined } from "../../web/src/ui/format.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0)) await fn(); });
const listen = async (...args: Parameters<typeof historyRoutes>) => {
  const handler = historyRoutes(...args);
  const server = createServer((req, res) => { void handler(req, res, undefined as never); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  clean.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const match = (i: number, handles: (string | null)[], changes: Partial<HistorySummary> = {}): HistorySummary => ({
  id: `2026-11-01T01-00-00-000Z-${i + 1}`, startedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
  endedAt: null, simulationEndedAt: null, reason: "time_up", decidedBy: "territory", winner: 0, status: "complete", unavailable: [],
  seats: handles.map((handle, j) => ({ seat: j, colony: j % 2, handle, modelLabel: null, thinkingLevel: null, serviceTier: null })), ...changes,
});
const score = (displayName: string): LeaderboardEntry => ({ displayName, identityId: "not-public", benchmark: false, rating: 1600.4, rd: 82, ratedMatches: 9,
  thinkingLevel: null, serviceTier: null, form: [], wins: null, draws: null, losses: null });

it("agrees with the entire visible Matches list, including ownership, markers, lobby types and unplayed records", async () => {
  const { store, docs } = memoryWatchStore(), excluded = randomUUID(), owner = randomUUID(), lobbyId = randomUUID();
  const all = Array.from({ length: 22 }, (_, i) => match(i, ["antwars", "antwars/home"]));
  const add = (handles: (string | null)[], changes?: Partial<HistorySummary>) => { const row = match(all.length, handles, changes); all.push(row); return row; };
  const marked = add(["marked", "fern"]), typed = add(["typed", "fern"]), hidden = add(["excluded", "fern"]);
  add(["unplayed"]); add(["fern", "fern/spar"]); const team = add(["fern", "river", "fern/spar"]); team.seats[0]!.modelLabel = "older";
  const recent = add(["fern", "river"], { decidedBy: "draw", winner: null }); recent.seats[0]!.modelLabel = "latest";
  add(["river", null], { reason: "abandoned" }); add(["single"], { status: "partial", winner: null });
  for (const { id } of all) docs.set(`replayOwnership/${id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([id === hidden.id ? excluded : owner]) });
  const registry = { replayLobby: async () => ({ state: "none" as const }) };
  const visibility = createPublicVisibility(store, registry, [excluded]);
  const markers = createTestRecordings(store); await markers.mark(marked.id);
  const source: HistorySource = {
    async list(token) { const i = Number(token ?? 0); return { matches: all.slice(i, i + 20), nextPageToken: i + 20 < all.length ? String(i + 20) : null }; },
    continuationAfter: id => String(1 + all.findIndex(row => row.id === id)), async open() { throw Error("unexpected download"); },
    async *scan() { yield all.slice(0, 20); yield [...all.slice(20), team]; },
  };
  const lookup: RecordingLobbyLookup = async id => id === typed.id ? { kind: "public", test: true, mode: null, size: 1, colonies: [[], []] } : null;
  const leaderboard = vi.fn(async (opts?: {cursor?: string}) => ({ ok: true as const, value: opts?.cursor ? { entries: [score("fern")] } : { entries: [score("excluded")], next: "more" } }));
  let now = 0;
  const url = await listen(source, lookup, { usersNow: () => now, ratings: { leaderboard }, publicVisibility: visibility, testRecordings: markers });
  const counts = new Map<string,number>(); let token: string | null = null;
  do {
    const res = await fetch(url + "/matches" + (token ? `?pageToken=${encodeURIComponent(token)}` : ""));
    const page = await res.json() as { matches: HistorySummary[]; nextPageToken: string | null }; token = page.nextPageToken;
    for (const row of page.matches.filter(r => !neverJoined(r))) {
      const names = new Set(row.seats.map(s => s.handle?.split("/")[0]).filter((n): n is string => !!n && n !== "antwars"));
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  } while (token);
  const res = await fetch(url + "/matches/users"); expect(res.status).toBe(200);
  const { users } = await res.json() as { users: { username: string; matches: number }[] };
  expect(new Map(users.map(u => [u.username, u.matches]))).toEqual(counts);
  expect(users.map(u => u.username).sort()).toEqual(["fern", "river", "single"]);
  expect(users.find(u => u.username === "fern")).toMatchObject({ agents: ["fern", "fern/spar"], matches: 3, wins: 1, losses: 0, own: 1, model: "latest", moreModels: 1, latest: { id: recent.id }, ranked: { rating: 1600.4, ratedMatches: 9 } });
  expect(users.find(u => u.username === "river")).toMatchObject({ matches: 3, losses: 1, wins: 0, own: 0, ranked: null });
  expect(JSON.stringify(users)).not.toContain("not-public");
  expect(leaderboard).toHaveBeenCalledWith(expect.objectContaining({ cursor: "more", mode: "1v1", scope: "everyone", limit: 50 }));
  now += 60_000;
  docs.set(`replayOwnership/${team.id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([excluded]) });
  expect((await (await fetch(url + "/matches/users")).json()).users).toContainEqual(expect.objectContaining({ username: "fern", matches: 2, wins: 0 }));
});

it("coalesces concurrent scans and fails both callers without returning partial rows on deadline", async () => {
  const scan = vi.fn(async function* (signal: AbortSignal) {
    yield [match(0, ["fern", "river"])];
    await once(signal, "abort");
  });
  const url = await listen({ scan, async list() { throw Error(); }, async open() { throw Error(); } }, undefined, { usersDeadlineMs: 100 });
  const responses = await Promise.all([1, 2].map(() => fetch(url + "/matches/users")));
  expect(scan).toHaveBeenCalledTimes(1);
  for (const response of responses) { expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty("users"); }
});

const oneMatch = () => match(0, ["fern", "river"]);
const sourceWith = (scan: NonNullable<HistorySource["scan"]>): HistorySource => ({ scan, async list() { throw Error(); }, async open() { throw Error(); } });

it("shares one completed listing across GET and HEAD until its one-minute expiry", async () => {
  let now = 1000;
  const scan = vi.fn(async function* () { yield [oneMatch()]; });
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
  const leaderboard = vi.fn(async () => { entered.resolve(); await proceed.promise; return { ok: true as const, value: { entries: [] } }; });
  const origin = await listen(sourceWith(scan), undefined, { usersNow: () => now, ratings: { leaderboard } });
  const read = (i: number) => fetch(origin + "/matches/users", { method: i % 2 ? "HEAD" : "GET" });
  const concurrent = Promise.all(Array.from({ length: 12 }, (_, i) => read(i)));
  await entered.promise; proceed.resolve();
  for (const r of await concurrent) expect(r.status).toBe(200);
  now += 59_999;
  for (let i = 0; i < 8; ++i) expect((await read(i)).status).toBe(200);
  expect(scan).toHaveBeenCalledTimes(1); expect(leaderboard).toHaveBeenCalledTimes(1);
  ++now;
  expect((await read(0)).status).toBe(200); expect(scan).toHaveBeenCalledTimes(2);
});

it("keeps an unfinished ranking read in its build slot after disconnect and deadline", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const scan = vi.fn(async function* () { yield [oneMatch()]; });
  const leaderboard = vi.fn(async () => { entered.resolve(); await finish.promise; return { ok: true as const, value: { entries: [] } }; });
  const origin = await listen(sourceWith(scan), undefined, { usersDeadlineMs: 250, ratings: { leaderboard } });
  const controller = new AbortController();
  const first = fetch(origin + "/matches/users", { signal: controller.signal }).catch(() => null);
  try {
    await entered.promise; controller.abort(); expect(await first).toBeNull();
    expect((await fetch(origin + "/matches/users")).status).toBe(503);
    expect((await fetch(origin + "/matches/users")).status).toBe(503);
    expect(scan).toHaveBeenCalledTimes(1); expect(leaderboard).toHaveBeenCalledTimes(1);
  } finally { finish.resolve(); }
});

it("rechecks contributing recordings after ranking and before publishing the listing", async () => {
  const earlier = oneMatch(), later = match(1, ["fern", "spruce"]);
  earlier.seats[0]!.modelLabel = "earlier"; later.seats[0]!.modelLabel = "later";
  const { store, docs } = memoryWatchStore(), lobbyId = randomUUID(), owner = randomUUID(), excluded = randomUUID();
  const ownership = (id: string, who: string) => docs.set(`replayOwnership/${id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([who]) });
  ownership(earlier.id, owner); ownership(later.id, owner);
  const visibility = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [excluded]);
  const source = sourceWith(async function* () { yield [earlier]; yield [later]; });
  const leaderboard = async () => { ownership(later.id, excluded); return { ok: true as const, value: { entries: [score("spruce")] } }; };
  const origin = await listen(source, undefined, { publicVisibility: visibility, ratings: { leaderboard } });
  const { users } = await (await fetch(origin + "/matches/users")).json();
  expect(users.map((u: { username: string }) => u.username).sort()).toEqual(["fern", "river"]);
  expect(users[0]).toMatchObject({ username: "fern", matches: 1, wins: 1, latest: { id: earlier.id }, model: "earlier", moreModels: 0 });
});

it("refuses an over-budget history without serving partial rows or immediately rescanning", async () => {
  const scan = vi.fn(async function* () { yield Array.from({ length: 4097 }, oneMatch); });
  const origin = await listen(sourceWith(scan));
  for (let i = 0; i < 2; i++) {
    const r = await fetch(origin + "/matches/users"); expect(r.status).toBe(503); expect(await r.json()).not.toHaveProperty("users");
  }
  expect(scan).toHaveBeenCalledTimes(1);
});
