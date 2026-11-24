import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicVisibility, usersOwnerPolicy } from "../../src/identity/publicVisibility.ts";
import { historyRoutes, type RecordingLobby, type RecordingLobbyLookup } from "../../src/replays/history-routes.ts";
import type { HistorySource, HistorySummary } from "../../src/replays/history-source.ts";
import { createRatings, encodeRating, type LeaderboardEntry } from "../../src/rating/ratings.ts";
import { createTestRecordings } from "../../src/replays/test-recordings.ts";
import { neverJoined } from "../../web/src/ui/format.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { wakingStore } from "../../src/slots/wake.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { currentRosterSeats } from "../../src/replays/roster-ownership.ts";

// Tally and cancellation fixtures have their own lobby seats and a current claim for each synthetic owner.
function fixtureRoutes(source: HistorySource, lookup?: RecordingLobbyLookup, options: Parameters<typeof historyRoutes>[2] = {}) {
  if (options.currentRosterSeats || !source.scan) return historyRoutes(source, lookup, options);
  const { store, docs } = memoryWatchStore(), lobbies = new Map<string, RecordingLobby>();
  const ids = new Map<string, string>();
  function id(name: string) { if (!ids.has(name)) ids.set(name, randomUUID()); return ids.get(name)!; }
  const scan = source.scan.bind(source);
  return historyRoutes({ ...source, async *scan(signal) {
    for await (const rows of scan(signal)) {
      for (const row of rows) {
        const colonies: { id: string; displayName: string }[][] = [[], [], [], []];
        for (const { colony, handle } of row.seats) if (handle) {
          const user = handle.split("/", 1)[0]!, canonical = user.toLowerCase();
          docs.set(`identities/${id(user)}`, { kind: "username", displayName: user, canonical, claimedAt: "0" });
          docs.set(`usernames/${canonical}`, { identityId: id(user) });
          if (handle !== user) docs.set(`identities/${id(handle)}`, { kind: "handle", displayName: handle, ownerId: id(user) });
          colonies[colony]!.push({ id: id(handle), displayName: handle });
        }
        lobbies.set(row.id, { kind: "public", mode: null, size: 1, colonies: colonies.slice(0, Math.max(2, ...row.seats.map(s => s.colony + 1))) });
      }
      yield rows;
    }
  } }, async (key, signal) => await lookup?.(key, signal) ?? lobbies.get(key) ?? null,
  { ...options, currentRosterSeats: currentRosterSeats(store, () => 1) });
}
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0)) await fn(); });
const listen = async (...args: Parameters<typeof historyRoutes>) => {
  const handler = fixtureRoutes(...args);
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
    async *scan() { yield all.slice(0, 20); yield all.slice(20); },
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
  const listing = async () => (await (await fetch(url + "/matches/users")).json()).users;
  expect(await listing()).toContainEqual(expect.objectContaining({ username: "fern", matches: 2, wins: 0 }));
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

it("shares each admitted expiry check, lets late visitors recheck after cooldown, and releases finished and disconnected admissions", async () => {
  let now = 0, builds = 0, checks = 0;
  const checking = Promise.withResolvers<void>(), checked = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const scan = async function* () { if (++builds === 1) yield [oneMatch()]; else { await resume.promise; yield []; } };
  const handler = fixtureRoutes(sourceWith(scan), undefined, { usersNow: () => now,
    testRecordings: { async mark() {}, async marked() {
      if (now && ++checks === 1) { checking.resolve(); await checked.promise; }
      return new Set();
    } }, ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  expect(await visitor(handler).done).toBe(200); now += 60_000;
  const first = visitor(handler); await checking.promise;
  const others = Array.from({ length: 127 }, () => visitor(handler, "HEAD"));
  try {
    expect(await visitor(handler).done).toBe(503); // 128 unfinished responses.
    const departed = others.pop()!; departed.leave(); await departed.done;
    others.push(visitor(handler));
    checked.resolve(); expect(await Promise.all([first, ...others].map(v => v.done))).toEqual(Array(128).fill(200));
    // All late visitors arrive after the first check has settled. They share a new check
    // after the cooldown and receive its answer while the full scan remains blocked.
    const start = performance.now();
    const late = [visitor(handler).done, visitor(handler).done]; // 129th completed request doesn't wait for a new build.
    expect(checks).toBe(1);
    expect(new Set(await Promise.all(late))).toEqual(new Set([200]));
    expect(performance.now() - start).toBeGreaterThanOrEqual(950);
    expect(builds).toBe(2); expect(checks).toBe(2);
  } finally { checked.resolve(); resume.resolve(); }
});

it("checks old contributors on expiry and does not republish rows hidden on another instance during the refresh", async () => {
  const { store, docs } = memoryWatchStore(), owner = randomUUID(), hidden = randomUUID(), lobbyId = randomUUID();
  const rows = Array.from({ length: 8 }, (_, i) => match(i, ["sample-fern", "sample-river"]));
  const owners = (index: number, id: string) => docs.set(`replayOwnership/${rows[index]!.id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([id]) });
  rows.forEach((_, i) => owners(i, owner));
  const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [hidden]);
  let builds = 0, now = 0;
  const scanned = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const url = await listen(sourceWith(async function* () {
    ++builds; yield rows; yield [];
    // The first page's projection has drained before the generator is asked for its third page.
    if (builds === 2) { scanned.resolve(); await resume.promise; }
  }), undefined, { usersNow: () => now, publicVisibility: policy, testRecordings: createTestRecordings(store),
    ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const first = async () => (await (await fetch(url + "/matches/users")).json()).users[0];
  const before = await first(); expect(before.matches).toBe(8);
  expect(before.recent.map((r: {id: string}) => r.id)).not.toContain(rows[0]!.id);
  now += 60_000; docs.set(`testRecordings/${rows[0]!.id}`, { version: "1" });
  try {
    expect((await first()).matches).toBe(7); await scanned.promise;
    owners(1, hidden); owners(7, hidden);
    docs.set(`testRecordings/${rows[2]!.id}`, { version: "1" });
  } finally { resume.resolve(); }
  const updated = await first(); expect(updated.matches).toBe(4);
  expect(updated.recent.map((r: {id: string}) => r.id)).not.toContain(rows[7]!.id);
  expect(await first()).toEqual(updated); expect(builds).toBe(2);
});

it("expires a remote write missed during verification 60 seconds from the check's first read", async () => {
  const row = oneMatch(), { store, docs } = memoryWatchStore();
  let now = 0, scans = 0;
  const url = await listen(sourceWith(async function* () {
    ++scans; yield [row];
    if (scans === 1) now = 15_000; // Storage scan started at zero; final verification starts later.
  }), undefined, { usersNow: () => now, testRecordings: createTestRecordings(store), ratings: { async leaderboard() {
    // This independent write doesn't touch the local revision. The final marker read already finished.
    docs.set(`testRecordings/${row.id}`, { version: "1" }); now = 45_000;
    return { ok: true, value: { entries: [] } };
  } } });
  const read = async () => { const r = await fetch(url + "/matches/users"); expect(r.status).toBe(200); return (await r.json()).users; };
  expect(await read()).toHaveLength(2);
  now = 74_999; expect(await read()).toHaveLength(2); expect(scans).toBe(1);
  now = 75_000; expect(await read()).toEqual([]); // Neither 60 s from build start nor 60 s from publication.
});

it("does not publish a listing when its final visibility check fails", async () => {
  let now = 0, reads = 0;
  const url = await listen(sourceWith(async function* () { yield [oneMatch()]; }), undefined, {
    usersNow: () => now, testRecordings: { async mark() {}, async marked() {
      if (++reads === 2) throw new Error("final marker read unavailable");
      return new Set();
    } }, ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } },
  });
  const read = () => fetch(url + "/matches/users");
  const failed = await read(); expect(failed.status).toBe(503); expect(await failed.json()).not.toHaveProperty("users");
  expect((await read()).status).toBe(503); expect(reads).toBe(2);
  now += 10_000; const retry = await read(); expect(retry.status).toBe(200); expect((await retry.json()).users).toHaveLength(2);
});

it("joins all four final verification batches after one fails and never publishes a partial listing", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => match(i, ["fern", "river"]));
  const allStarted = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let started = 0, finished = 0;
  const url = await listen(sourceWith(async function* () { yield rows; }), undefined, {
    testRecordings: { async mark() {}, async marked(ids) {
      if (ids.length === 100) { // Scan reads at most 20; final verification checks 100 at a time.
        const first = ++started === 1;
        if (started === 4) allStarted.resolve();
        try {
          await allStarted.promise;
          if (first) throw new Error("marker read failed");
          await resume.promise;
        } finally { ++finished; }
      }
      return new Set();
    } },
  });
  let returned = false;
  const read = fetch(url + "/matches/users").then(r => { returned = true; return r; });
  try { await allStarted.promise; await nextTurn(); expect(returned).toBe(false); expect(finished).toBe(1); }
  finally { resume.resolve(); }
  const r = await read; expect(r.status).toBe(503); expect(await r.json()).not.toHaveProperty("users");
  expect(started).toBe(4); expect(finished).toBe(4);
});

it("waits for a cold result if the expired listing cannot be checked", async () => {
  let now = 0, failCheck = false, builds = 0;
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const url = await listen(sourceWith(async function* () {
    if (++builds === 1) yield [oneMatch()];
    else { entered.resolve(); await resume.promise; yield []; }
  }), undefined, { usersNow: () => now, testRecordings: { async mark() {}, async marked() {
    if (failCheck) throw new Error("marker read unavailable");
    return new Set();
  } }, ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const read = async () => (await (await fetch(url + "/matches/users")).json()).users;
  expect(await read()).toHaveLength(2); now += 60_000; failCheck = true;
  let returned = false;
  const next = read().then(rows => { returned = true; return rows; });
  try { await entered.promise; await nextTurn(); expect(returned).toBe(false); }
  finally { resume.resolve(); }
  expect(await next).toEqual([]);
});

it("invalidates a warm listing immediately when this process marks a recording", async () => {
  const { store } = memoryWatchStore(), markers = createTestRecordings(store), row = oneMatch();
  const url = await listen(sourceWith(async function* () { yield [row]; }), undefined, {
    testRecordings: markers, usersNow: () => 0,
    ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } },
  });
  const read = async () => (await (await fetch(url + "/matches/users")).json()).users;
  expect(await read()).toHaveLength(2); await markers.mark(row.id); expect(await read()).toEqual([]);
});

it("rechecks contributors without restarting the storage scan under steady match publication", async () => {
  const { store, docs } = memoryWatchStore(), owner = randomUUID(), lobbyId = randomUUID(), row = oneMatch();
  const registry = createWatchRegistry(store), markers = createTestRecordings(store);
  docs.set(`lobbies/${lobbyId}`, { seats: JSON.stringify([{ id: owner }]) });
  docs.set(`identities/${owner}`, { kind: "username" });
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let scans = 0;
  const source = sourceWith(async function* () { ++scans; yield [row]; });
  const url = await listen(source, undefined, { testRecordings: markers, usersDeadlineMs: 2500, ratings: { async leaderboard() {
    entered.resolve(); await resume.promise; return { ok: true, value: { entries: [] } };
  } } });
  const started = performance.now();
  const visitors = Promise.all([fetch(url + "/matches/users"), fetch(url + "/matches/users")]);
  try {
    await entered.promise;
    for (let n = 1; n <= 10; n++) await registry.recordOwners(lobbyId, match(n, []).id);
    await markers.mark(row.id); // A relevant write during the final check must affect the answer.
  } finally { resume.resolve(); }
  for (const res of await visitors) { expect(res.status).toBe(200); expect(await res.json()).toEqual({ users: [] }); }
  expect(performance.now() - started).toBeLessThan(2500); expect(scans).toBe(1);
  await registry.recordOwners(lobbyId, match(20, []).id);
  expect((await fetch(url + "/matches/users")).status).toBe(200); expect(scans).toBe(1);
});

it("drops stale success after a refresh failure and retries only after the backoff", async () => {
  let now = 0, builds = 0;
  const scan = async function* () { if (++builds === 2) throw new Error("refresh failed"); yield []; };
  const url = await listen(sourceWith(scan), undefined, { usersNow: () => now });
  const status = async () => (await fetch(url + "/matches/users")).status;
  expect(await status()).toBe(200); now += 60_000;
  expect(await status()).toBe(200); await expect.poll(status).toBe(503);
  now += 9_999; expect(await status()).toBe(503); expect(builds).toBe(2);
  ++now; expect(await status()).toBe(200); expect(builds).toBe(3);
});

it("discards an expired snapshot and drains its refresh if the policy changes", async () => {
  let now = 0, digest = "original", builds = 0;
  const cancelled = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const scan = async function* (signal: AbortSignal) {
    if (++builds === 1) yield [oneMatch()];
    else if (builds === 2) { await once(signal, "abort"); cancelled.resolve(); await resume.promise; yield [oneMatch()]; }
    else yield [];
  };
  const url = await listen(sourceWith(scan), undefined, { usersNow: () => now, usersPolicy: () => ({ digest }),
    ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const read = async () => (await (await fetch(url + "/matches/users")).json()).users;
  const first = await read(); expect(first).toHaveLength(2); now += 60_000;
  expect(await read()).toEqual(first); digest = "changed";
  const changed = read();
  try { await cancelled.promise; expect(builds).toBe(2); } finally { resume.resolve(); }
  expect(await changed).toEqual([]); expect(builds).toBe(3);
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

it("waits for the last reader's cancelled build to stop, then starts a fresh build without a retry delay", async () => {
  const entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const replacementArrived = Promise.withResolvers<void>();
  let abandoned = false, running = 0, peak = 0;
  const scan = vi.fn(async function* (signal: AbortSignal) {
    peak = Math.max(peak, ++running);
    try {
      if (!abandoned) {
        entered.resolve(); await once(signal, "abort");
        abandoned = true; cancelled.resolve(); await finish.promise;
        signal.throwIfAborted();
      }
      yield [oneMatch()];
    } finally { --running; }
  });
  const origin = await listen(sourceWith(scan), undefined, {
    usersPolicy: () => { if (abandoned) replacementArrived.resolve(); return { digest: "same" }; },
    ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } },
  });
  const controller = new AbortController();
  const first = fetch(origin + "/matches/users", { signal: controller.signal }).catch(() => null);
  try {
    await entered.promise; controller.abort(); await cancelled.promise; expect(await first).toBeNull();
    const next = fetch(origin + "/matches/users"); await replacementArrived.promise;
    expect(scan).toHaveBeenCalledTimes(1); finish.resolve();
    const response = await next; expect(response.status).toBe(200);
    expect((await response.json()).users).toHaveLength(2);
    expect(scan).toHaveBeenCalledTimes(2); expect(peak).toBe(1);
  } finally { finish.resolve(); }
});

it("applies the latest visibility once, after all pages arrive", async () => {
  const earlier = oneMatch(), later = match(1, ["fern", "spruce"]);
  earlier.seats[0]!.modelLabel = "earlier"; later.seats[0]!.modelLabel = "later";
  const { store, docs } = memoryWatchStore(), lobbyId = randomUUID(), owner = randomUUID(), excluded = randomUUID();
  const ownership = (id: string, who: string) => docs.set(`replayOwnership/${id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([who]) });
  ownership(earlier.id, owner); ownership(later.id, owner);
  const visibility = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [excluded])!;
  const checks = vi.spyOn(visibility, "replaysVisibleEach");
  const source = sourceWith(async function* () { yield [earlier]; ownership(later.id, excluded); yield [later]; });
  const leaderboard = async () => { return { ok: true as const, value: { entries: [score("spruce")] } }; };
  const origin = await listen(source, undefined, { publicVisibility: visibility, ratings: { leaderboard } });
  const { users } = await (await fetch(origin + "/matches/users")).json();
  expect(checks.mock.calls.map(([ids]) => ids)).toEqual([[earlier.id, later.id]]);
  expect(users.map((u: { username: string }) => u.username).sort()).toEqual(["fern", "river"]);
  expect(users[0]).toMatchObject({ username: "fern", matches: 1, wins: 1, latest: { id: earlier.id }, model: "earlier", moreModels: 0 });
});

it("verifies all 6,000 records before publication but does not retain oversized contributions for expiry", async () => {
  const page = Array.from({ length: 20 }, (_, i) => match(i, ["fern", "river"]));
  let now = 0, builds = 0, checked = 0;
  const resume = Promise.withResolvers<void>();
  const scan = async function* () {
    if (++builds > 1) { await resume.promise; yield []; return; }
    for (let i = 0; i < 300; i++) {
      for (let j = 0; j < page.length; j++) {
        const row = match(i * 20 + j, ["fern", "river"], { winner: i % 2 });
        // With the narrower tally encoding, include real display fields so this fixture still crosses 2 MiB.
        for (const seat of row.seats) seat.modelLabel = "Example model used for a historical match";
        Object.assign(page[j]!, row);
      }
      yield page;
    }
    for (const row of page) row.seats = [];
  };
  const url = await listen(sourceWith(scan), undefined, { usersNow: () => now,
    testRecordings: { async mark() {}, async marked(ids) { checked += ids.length; return new Set(); } },
    ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const read = async () => { const r = await fetch(url + "/matches/users"); expect(r.status).toBe(200); return (await r.json()).users; };
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const users = await read(); expect(users).toHaveLength(2);
  for (const user of users) expect(user).toMatchObject({ matches: 6000, wins: 3000, losses: 3000, latest: { id: page[19]!.id } });
  expect(checked).toBe(12_000); // Every id checked in the scan and again at publication.
  now += 60_000;
  const expired = read();
  try { await vi.waitFor(() => expect(builds).toBe(2)); expect(checked).toBe(12_000); } finally { resume.resolve(); }
  expect(await expired).toEqual([]);
  expect(warn.mock.calls).toEqual([["Users listing exceeds the contribution limit; expiry will wait for a full build"]]);
});

it("keeps a large warm listing across writes to unlisted ids but rebuilds when a contributor changes", async () => {
  const { store, docs } = memoryWatchStore(), markers = createTestRecordings(store);
  const rows = Array.from({ length: 200 }, (_, i) => match(i, ["fern", "river"]));
  for (const row of rows) row.seats[0]!.modelLabel = "M".repeat(12 * 1024); // Contributions alone exceed 2 MiB.
  const hidden = rows[0]!.id, listed = rows[1]!.id, anotherTime = listed.replace("T01-", "T02-");
  const owner = randomUUID(), excluded = randomUUID(), lobbyId = randomUUID();
  for (const { id } of rows) docs.set(`replayOwnership/${id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([id === hidden ? excluded : owner]) });
  const visibility = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [excluded]);
  const scan = vi.fn(async function* () { yield rows; });
  const url = await listen(sourceWith(scan), undefined, { usersNow: () => 0, publicVisibility: visibility, testRecordings: markers,
    ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const count = async () => { const r = await fetch(url + "/matches/users"); expect(r.status).toBe(200); return (await r.json()).users[0].matches; };
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await count()).toBe(199); expect(warn.mock.calls).toEqual([["Users listing exceeds the contribution limit; expiry will wait for a full build"]]);
  await markers.mark(hidden); await markers.mark(anotherTime); // Scanned but excluded; unknown with the same sequence as a contributor.
  expect(await count()).toBe(199); expect(scan).toHaveBeenCalledTimes(1);
  await markers.mark(listed); expect(await count()).toBe(198); expect(scan).toHaveBeenCalledTimes(2);
});

it("warns once and fails the build without publishing a partial listing at the 32 MiB limit", async () => {
  // Wide tally inputs reach the byte cap without creating a very large store fixture.
  const label = "M".repeat(16 * 1024), ratings = { leaderboard: vi.fn() };
  let scanned = 0;
  const url = await listen(sourceWith(async function* () {
    for (let i = 0; i < 3000; i += 20) {
      const rows = Array.from({ length: 20 }, (_, j) => match(i + j, ["fern", "river"]));
      for (const row of rows) row.seats[0]!.modelLabel = label;
      scanned += rows.length; yield rows;
    }
  }), undefined, { ratings, usersNow: () => 0 });
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = () => fetch(url + "/matches/users");
  const result = await read(); expect(result.status).toBe(503); expect(await result.json()).not.toHaveProperty("users");
  const stoppedAt = scanned; expect(stoppedAt).toBeLessThan(3000);
  expect((await read()).status).toBe(503); expect(scanned).toBe(stoppedAt); expect(ratings.leaderboard).not.toHaveBeenCalled();
  expect(warn.mock.calls.filter(([message]) => message === "Users listing exceeds the 32 MiB build limit")).toHaveLength(1);
});

it("invalidates a warm response when the configured owner set changes", async () => {
  const { store, docs } = memoryWatchStore(), owner = randomUUID(), lobbyId = randomUUID();
  let ids: string[] = [];
  const row = oneMatch(); docs.set(`replayOwnership/${row.id}`, { version: "1", lobbyId, ownerIds: JSON.stringify([owner]) });
  const usersPolicy = usersOwnerPolicy(() => ids, store, { replayLobby: async () => ({ state: "none" }) });
  const scan = vi.fn(async function* () { yield [row]; });
  const origin = await listen(sourceWith(scan), undefined, { usersPolicy, ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const read = async () => (await (await fetch(origin + "/matches/users")).json()).users;
  expect(await read()).toHaveLength(2); ids = [owner]; expect(await read()).toEqual([]); expect(await read()).toEqual([]);
  ids = []; expect(await read()).toHaveLength(2); expect(scan).toHaveBeenCalledTimes(3);
});

it.each([
  { name: "own name takes precedence", scores: [["fern", 1480], ["fern/scout", 1600]] as const, rating: 1480, via: undefined },
  { name: "one ranked agent", scores: [["fern/wing", 1520]] as const, rating: 1520, via: "fern/wing" },
  { name: "highest played agent", scores: [["fern/unplayed", 2000], ["fern/wing", 1590], ["fern/scout", 1550]] as const, rating: 1590, via: "fern/wing" },
  { name: "neither the user nor a played agent", scores: [["other", 1700]] as const, rating: null, via: undefined },
])("uses the public ranking for $name", async ({ scores, rating, via }) => {
  const source = sourceWith(async function* () { yield [match(0, ["fern/wing", "river", "fern/scout"])]; });
  const leaderboard = async () => ({ ok: true as const, value: { entries: scores.map(([name, r]) => ({ ...score(name), rating: r })) } });
  const origin = await listen(source, undefined, { ratings: { leaderboard } });
  const { users } = await (await fetch(origin + "/matches/users")).json();
  expect(users[0].agents).toEqual(["fern/scout", "fern/wing"]);
  expect(users[0].ranked).toEqual(rating === null ? null : { rating, rd: 82, ratedMatches: 9, ...(via ? { via } : {}) });
});

it("cancels the ranking transport when the last Users reader leaves, without affecting ordinary rankings", async () => {
  const entered = Promise.withResolvers<void>(), canceled = Promise.withResolvers<void>();
  let cancelNext = false;
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/usernames/antwars")) return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
    if (!String(url).endsWith(":runQuery")) throw Error("Unexpected read");
    if (cancelNext) {
      cancelNext = false; entered.resolve();
      await once(init!.signal!, "abort"); canceled.resolve(); throw init!.signal!.reason;
    }
    return Response.json([{ readTime: "2026-11-01T00:00:00Z" }]);
  };
  const ratings = createRatings(createFirestore({ projectId: "fixture", namespace: "ranking", emulatorHost: "localhost:8080", request }));
  await ratings.houseBackfill;
  const origin = await listen(sourceWith(async function* () { yield [oneMatch()]; }), undefined, { ratings });
  cancelNext = true;
  const controller = new AbortController();
  const r = fetch(origin + "/matches/users", { signal: controller.signal }).catch(() => null);
  await entered.promise; controller.abort(); await canceled.promise; expect(await r).toBeNull();
  expect(await ratings.leaderboard()).toEqual({ ok: true, value: { entries: [] } });
});

it.each(["upstream failure", "deadline"])("retries after 10 seconds and logs a data-free 503 after %s", async reason => {
  let now = 0, healthy = false;
  const scan = vi.fn(async function* (signal: AbortSignal) {
    if (!healthy) {
      if (reason === "deadline") { await once(signal, "abort"); signal.throwIfAborted(); }
      throw Error("fixture-specific private detail");
    }
    yield [oneMatch()];
  });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const origin = await listen(sourceWith(scan), undefined, { usersNow: () => now, usersDeadlineMs: 100,
      ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
    const read = () => fetch(origin + "/matches/users");
    expect((await read()).status).toBe(503); healthy = true; now = 9_999;
    expect((await read()).status).toBe(503); expect(scan).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["Users listing unavailable (503)"], ["Users listing unavailable (503)"]]);
    ++now; expect((await read()).status).toBe(200); expect(scan).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});

// Drive request lifetimes in-process: no listener, external service or timing-dependent client disconnect.
function visitor(handler: ReturnType<typeof historyRoutes>, method = "GET") {
  const req = new IncomingMessage(new Socket()); req.url = "/matches/users"; req.method = method;
  const res = new ServerResponse(req);
  // There is no connected socket to flush this synthetic response and signal finish for us.
  return { done: Promise.resolve(handler(req, res, undefined as never)).then(() => { if (res.writableEnded) res.emit("finish"); return res.statusCode; }),
    leave() { res.destroy(); res.emit("close"); } };
}

it("holds the build until every lobby read returns even when its marker read cancels first", async () => {
  const page = [oneMatch(), match(1, ["fern", "spruce"])];
  const gates = page.map(() => Promise.withResolvers<void>());
  const buildSignals: AbortSignal[] = [], lookupSignals: (AbortSignal | undefined)[] = [];
  let active = 0, peak = 0;
  const starts: number[] = [];
  const scan = async function* (signal: AbortSignal) { starts.push(active); buildSignals.push(signal); yield page; };
  const handler = fixtureRoutes(sourceWith(scan), async (id, signal) => {
    lookupSignals.push(signal); peak = Math.max(peak, ++active);
    try { await gates[page.findIndex(row => row.id === id)]!.promise; return null; } finally { --active; }
  }, { testRecordings: { async mark() {}, async marked(_ids, signal) {
    peak = Math.max(peak, ++active);
    try {
      if (starts.length === 1) { await once(signal!, "abort"); signal!.throwIfAborted(); }
      return new Set();
    } finally { --active; }
  } }, ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const first = visitor(handler); await nextTurn(); expect(active).toBe(3);
  expect(lookupSignals).toEqual([buildSignals[0], buildSignals[0]]);
  first.leave(); await first.done; await nextTurn(); expect(active).toBe(2);
  const second = visitor(handler); second.leave(); await second.done;
  const replacement = visitor(handler); gates[0]!.resolve(); await nextTurn();
  expect(starts).toEqual([0]); expect(active).toBe(1);
  gates[1]!.resolve(); expect(await replacement.done).toBe(200);
  expect(starts).toEqual([0, 0]); expect(active).toBe(0); expect(peak).toBe(3);
});

it("joins a ranking sibling's rollback before returning the failure or retrying", async () => {
  const rollback = Promise.withResolvers<void>(), ids = [randomUUID(), randomUUID()];
  let now = 0, opened = 0, active = 0, failing = true;
  const store = createFirestore({ projectId: "fixture", namespace: "ranking", emulatorHost: "localhost:8080", request: async (url, init) => {
    if (String(url).endsWith("/usernames/antwars")) return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
    if (String(url).endsWith(":runQuery")) return Response.json(ids.map(id => ({ readTime: "2026-11-01T00:00:00Z", document: {
      name: `projects/fixture/databases/(default)/documents/namespaces/ranking/ratings/${id}`,
      fields: { rating: { stringValue: encodeRating(1500) }, rd: { stringValue: encodeRating(80) }, ratedMatches: { stringValue: "1" } },
    } })));
    if (String(url).endsWith(":beginTransaction")) { ++active; return Response.json({ transaction: String(++opened) }); }
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith(":rollback")) {
      if (body.transaction === "2") await rollback.promise;
      --active; return Response.json({});
    }
    if (String(url).endsWith(":batchGet")) {
      if (failing && body.transaction === "1") throw Error("first lookup failed");
      return Response.json([{ missing: body.documents[0] }]);
    }
    throw Error("unexpected read");
  } });
  const ratings = createRatings(store); await ratings.houseBackfill;
  const starts: number[] = [];
  const scan = async function* () { starts.push(active); yield [oneMatch()]; };
  const handler = fixtureRoutes(sourceWith(scan), undefined, { usersNow: () => now, ratings });
  let returned = false;
  const first = visitor(handler).done.then(status => { returned = true; return status; });
  await nextTurn(); expect(active).toBe(1); expect(returned).toBe(false);
  const other = visitor(handler); expect(starts).toEqual([0]);
  rollback.resolve(); expect(await first).toBe(503); expect(await other.done).toBe(503);
  failing = false; now += 10_000;
  expect(await visitor(handler).done).toBe(200); expect(starts).toEqual([0, 0]); expect(active).toBe(0);
});

it.each(["get", "transaction"])("cancels the waking lobby store's %s read when the Users build loses its reader", async phase => {
  const entered = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const lobbyId = randomUUID(), wake = vi.fn();
  let rollbacks = 0;
  const store = createFirestore({ projectId: "fixture", namespace: "lobby", emulatorHost: "localhost:8080", request: async (url, init) => {
    if (String(url).endsWith(":rollback")) { ++rollbacks; return Response.json({}); }
    if (String(url).endsWith(":beginTransaction")) return Response.json({ transaction: "fixture" });
    if (phase === "transaction" && String(url).endsWith(`/lobbies/${lobbyId}`)) {
      return Response.json({ fields: { state: { stringValue: "waiting" }, createdAt: { stringValue: "0" } } });
    }
    const target = phase === "get" ? `/lobbies/${lobbyId}` : ":batchGet";
    if (!String(url).endsWith(target)) throw Error("unexpected read");
    entered.resolve(); await once(init!.signal!, "abort"); stopped.resolve(); throw init!.signal!.reason;
  } });
  const lobbies = createLobbies(wakingStore(store, wake), createIdentities(store), { now: () => 1 });
  let builds = 0;
  const source = sourceWith(async function* () { if (++builds === 1) yield [oneMatch()]; });
  const handler = historyRoutes(source, async (_id, signal) => {
    const lobby = await lobbies.readLobby(lobbyId, signal);
    return lobby.ok ? lobby.value : null;
  });
  const first = visitor(handler); await entered.promise; first.leave(); await stopped.promise; await first.done;
  expect(await visitor(handler).done).toBe(200); expect(builds).toBe(2);
  expect(rollbacks).toBe(phase === "transaction" ? 1 : 0); expect(wake).not.toHaveBeenCalled();
});

it("puts each own agent on its side, counts each agent only once, and never lists a released account identifier", async () => {
  const first = match(1, ["sample-wing/red", "sample-wing/blue", "sample-wing/red"]);
  first.seats[2]!.modelLabel = "Sample two"; first.seats[0]!.modelLabel = "Sample one";
  const placeholder = `account:${randomUUID()}/released`;
  const second = match(2, ["sample-wing/red", placeholder]);
  const origin = await listen(sourceWith(async function* () { yield [second, first]; }), undefined, { ratings: { async leaderboard() { return { ok: true, value: { entries: [] } }; } } });
  const { users } = await (await fetch(origin + "/matches/users")).json();
  expect(users).toHaveLength(1); expect(JSON.stringify(users)).not.toContain(placeholder);
  expect(users[0]).toMatchObject({ username: "sample-wing", own: 1, matches: 2, wins: 1, losses: 0,
    agentDetails: [{ handle: "sample-wing/blue", matches: 1, models: [] }, { handle: "sample-wing/red", matches: 2, models: ["Sample one", "Sample two"] }],
    recent: [{ id: second.id, agents: ["sample-wing/red"], result: "Won", opponents: [{ handle: null }] },
      { id: first.id, agents: ["sample-wing/red"], result: "Own match", opponents: [{ handle: "sample-wing/blue" }] }] });
});

it("joins recordings to the original seat identity, never to a later claimant with the same name", async () => {
  const { store, docs } = memoryWatchStore();
  const old = randomUUID(), later = randomUUID(), peer = randomUUID(), lobbyId = randomUUID();
  const name = "sample-orbit", other = "sample-ray";
  let now = 1;
  function claim(id: string, displayName: string) {
    docs.set(`identities/${id}`, { kind: "username", canonical: displayName, displayName, claimedAt: String(now) });
    docs.set(`usernames/${displayName}`, { identityId: id });
  }
  claim(old, name); claim(peer, other);
  const past = match(1, [name, other]), fresh = match(2, [name, other]);
  const rows = [past]; let test = false;
  const newcomer = randomUUID(); claim(newcomer, "sample-rush");
  const lobby = (id: string): RecordingLobby => ({ kind: "public", mode: null, size: 1, ...(test ? {test: true} : {}),
    colonies: [[{id, displayName: name}], [{id: peer, displayName: other}]] });
  const markers = createTestRecordings(store);
  const url = await listen({ ...sourceWith(async function* () { yield rows; }),
    async list() { return { matches: rows, nextPageToken: null }; }, async summary(id) { return rows.find(r => r.id === id) ?? null; },
  }, async key => lobby(key === past.id ? old : later), { topMatches: { ids: [past.id, fresh.id], leftOff: [] },
    usersNow: () => now, lobbyById: async () => { const live = lobby(later); return { ...live, colonies: [...live.colonies, [{id: newcomer, displayName: "sample-rush"}]] }; },
    testRecordings: markers, currentRosterSeats: currentRosterSeats(store, () => now),
    ratings: { async leaderboard() { return { ok: true, value: {entries: []} }; } },
  });
  const get = async (path: string) => { const r = await fetch(url + path); expect(r.status).toBe(200); return r.json(); };
  const listed = async () => (await get("/matches/users")).users;
  const links = (kind: string, key: string) => get(`/matches/users/links/${kind}/${key}`);
  expect(await listed()).toContainEqual(expect.objectContaining({ username: name, matches: 1 }));
  docs.set(`identities/${old}`, { ...docs.get(`identities/${old}`), nameState: "released" }); now += 60_001;
  await expect.poll(async () => (await listed()).map((u: {username: string}) => u.username)).toEqual([other]);
  expect(await links("replay", past.id)).toEqual({ handles: [[other, other]] });
  claim(later, name); rows.push(fresh); now += 60_001;
  await expect.poll(async () => (await listed()).find((u: {username: string}) => u.username === name)).toMatchObject({ matches: 1, recent: [{id: fresh.id}] });
  expect(await links("replay", past.id)).toEqual({ handles: [[other, other]] });
  expect(await links("replay", fresh.id)).toEqual({ handles: [[name, name], [other, other]] });
  // A current first-time public player links even before their first recording is complete.
  expect(await links("lobby", lobbyId)).toEqual({ handles: [[name, name], [other, other], ["sample-rush", "sample-rush"]] });
  for (const route of ["/matches", "/matches/top"]) {
    const archive = (await get(route)).matches;
    expect(archive.find((r: {id: string}) => r.id === past.id).seats[0]).toMatchObject({ handle: name, rosterUser: null });
    expect(archive.find((r: {id: string}) => r.id === fresh.id).seats[0]).toMatchObject({ handle: name, rosterUser: name });
  }
  const renamed = "sample-arc";
  claim(old, renamed); now += 60_001;
  await expect.poll(listed).toContainEqual(expect.objectContaining({ username: renamed }));
  const byOwner = await listed();
  expect(byOwner.find((u: {username: string}) => u.username === renamed)).toMatchObject({ matches: 1, agents: [renamed], recent: [{id: past.id}] });
  expect(byOwner.find((u: {username: string}) => u.username === name)).toMatchObject({ matches: 1, recent: [{id: fresh.id}] });
  for (const route of ["/matches", "/matches/top"]) {
    const archive = (await get(route)).matches;
    expect(archive.find((r: {id: string}) => r.id === past.id).seats[0]).toMatchObject({ handle: name, rosterUser: renamed });
  }
  expect(await links("replay", past.id)).toEqual({ handles: [[name, renamed], [other, other]] });
  test = true; expect(await links("lobby", lobbyId)).toEqual({ handles: [] });
  test = false; await markers.mark(fresh.id); expect(await links("replay", fresh.id)).toEqual({ handles: [] });
});
