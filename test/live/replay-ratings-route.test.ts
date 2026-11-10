import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { Lobby, MatchOutcome } from "../../src/lobby/lobbies.ts";
import type { LiveHub } from "../../src/live/hub.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import type { StreamMessage } from "../../src/live/format.ts";
import { restateRatings, storedReplayFacts, storedReplayRatings } from "../../web/src/replay-ratings.ts";
import { holdMatch, memoryWatchStore } from "./watch-fixtures.ts";

const lobbyId = "11111111-2222-4333-8444-555555555555";
const startedAt = Date.parse("2026-01-02T03:04:05.000Z");
const replayId = "2026-01-02T03-04-05-000Z-281474976710";
/** The fixture lobby's match time, in rounds 26-30, and the harness phase it gives a Model Index match. */
const matchAt = Date.parse("2026-11-07T07:47:00.000Z");
const round26Phase = { phase: "rounds 26-30", possibleEffortMismatch: false };
/** The Glicko record the recompute stored; the recording carries the Elo figures 1383.3 → 1399.5 and 1386.6 → 1370.4. */
const glicko = [
  { identityId: "glm", before: 1412.25, after: 1461.75, rdBefore: 120, rdAfter: 110 },
  { identityId: "deepseek", before: 1430.5, after: 1388, rdBefore: 130, rdAfter: 118 },
];
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });

async function fixture(options: { kind?: "public" | "private"; rated?: boolean; outcome?: MatchOutcome; changes?: unknown[] | null;
  colonies?: Lobby["colonies"]; finished?: boolean; mode?: Lobby["mode"]; startsAt?: number | null } = {}) {
  const { docs, store } = memoryWatchStore();
  const registry = createWatchRegistry(store);
  const kind = options.kind ?? "public";
  const lobby: Lobby = { id: lobbyId, kind, size: 1, state: "ended", rated: options.rated ?? true, slot: `${kind}-0`, creatorId: "glm",
    createdAt: 0, expiresAt: 0, startsAt: options.startsAt === undefined ? matchAt : options.startsAt, outcome: options.outcome ?? "colony_0_won",
    mode: options.mode === undefined ? "house-1v1" : options.mode,
    colonies: options.colonies ?? [[{ id: "glm", displayName: "glm" }], [{ id: "deepseek", displayName: "deepseek" }]] };
  let invite = "current";
  const accounts = {
    lobbies: {
      readLobby: async (id: string) => id === lobbyId ? { ok: true, value: lobby } : { ok: false, reason: "no_such_lobby" },
      isInviteCurrent: async (id: string, token: string) => id === lobbyId && token === invite,
    },
    ratings: createRatings(store),
  } as unknown as AccountStores;
  await registry.register({ lobbyId, visibility: kind, rated: lobby.rated === true, mode: "house-1v1", startedAt, origin: "http://127.0.0.1:9", slot: `${kind}-0`, runId: "run" });
  holdMatch(docs, lobbyId, "run");
  if (options.finished !== false) await registry.playbackFinished(lobbyId, "run");
  await registry.replaySaved(lobbyId, "run", replayId);
  if (options.changes !== null) docs.set(`ratedMatches/${lobbyId}`, { changes: JSON.stringify(options.changes ?? glicko) });
  const handler = watchRoutes({ accounts, registry, hub: {} as LiveHub });
  const server: Server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (id = replayId, token?: string) => fetch(`${origin}/watch/ratings/${encodeURIComponent(id)}`, { headers: token ? { "x-antwar-invite": token } : {} });
  /** The page's own read (web/src/replay-ratings.ts) against this server. */
  const request = ((url: string, init?: RequestInit) => fetch(`${origin}${url}`, { headers: init?.headers, signal: init?.signal })) as typeof fetch;
  return { docs, get, request, revoke: () => { invite = "fresh"; } };
}

/** One seat as a recording carries it, in join order: colony, stream display name, recorded before → after. */
type Seat = readonly [colony: 0 | 1, displayName: string, before: number, after: number];

/** A rated recording's opening snapshot with its final result, enough for the restatement to read. */
function recording(seats: readonly Seat[]): StreamMessage {
  return { tick: 0, ants: {}, events: [], full: {
    agents: seats.map(([colony, displayName, before]) => ({ colony, identity: { displayName, elo: before } })),
    result: { winner: 0, reason: "overrun", decidedBy: "overrun", tick: 0, nextStartMs: null,
      ratingChanges: seats.map(([, , before, after], agent) => ({ agent, before, after })) },
  } } as unknown as StreamMessage;
}

/**
 * What a replay page shows for each seat, read end to end as web/src/source.ts wires it: this server's
 * /watch/ratings/ answer, the page's read of it, then the restatement, or the recording's own figures when none.
 * Asserts the read wrote nothing.
 */
async function shown(f: Awaited<ReturnType<typeof fixture>>, seats: readonly Seat[]) {
  const before = JSON.stringify([...f.docs]);
  const stored = await storedReplayRatings(replayId, null, new AbortController().signal, f.request);
  const m = stored ? restateRatings(stored)(recording(seats)) : recording(seats);
  expect(JSON.stringify([...f.docs])).toBe(before);
  return m.full!.agents.map((agent, index) => ({ name: agent.identity!.displayName, rating: agent.identity!.elo,
    before: m.full!.result!.ratingChanges![index]!.before, after: m.full!.result!.ratingChanges![index]!.after }));
}

describe("a replay's stored rating figures", () => {
  it("serves a pre-switch match's stored Glicko record by replay id alone, by seat colony and display name, writing nothing", async () => {
    const f = await fixture();
    const before = JSON.stringify([...f.docs]);
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ratings: [
      { colony: 0, displayName: "glm", before: 1412.25, after: 1461.75 },
      { colony: 1, displayName: "deepseek", before: 1430.5, after: 1388 },
    ], harnessPhase: round26Phase });
    expect(JSON.stringify([...f.docs])).toBe(before);
  });

  it("serves a private match's figures only to a watcher admitted with its current invite", async () => {
    const f = await fixture({ kind: "private" });
    expect((await f.get()).status).toBe(404);
    expect((await f.get(replayId, "stale")).status).toBe(404);
    const admitted = await f.get(replayId, "current");
    expect(admitted.status).toBe(200);
    expect((await admitted.json()).ratings).toHaveLength(2);
    f.revoke();
    expect((await f.get(replayId, "current")).status).toBe(404);
  });

  it("names an identity holding several seats as the stream does: '<name> #<seat>'", async () => {
    const f = await fixture({ colonies: [[{ id: "glm", displayName: "glm" }, { id: "glm", displayName: "glm" }],
      [{ id: "deepseek", displayName: "deepseek" }, { id: "kimi", displayName: "kimi" }]],
    changes: [...glicko, { identityId: "kimi", before: 1400, after: 1390 }] });
    expect((await (await f.get()).json()).ratings.map((row: { displayName: string }) => row.displayName)).toEqual(["glm #1", "glm #2", "deepseek", "kimi"]);
  });

  it.each([
    ["an unrated match", { rated: false }],
    ["a stopped match", { outcome: "stopped" as const }],
    ["a match with no stored record", { changes: null }],
    ["a record missing a seat", { changes: [glicko[0]] }],
  ])("returns no figures for %s, so the recording's own stay", async (_, options) => {
    const f = await fixture(options);
    expect(await (await f.get()).json()).toEqual({ ratings: [], harnessPhase: round26Phase });
  });

  it("refuses an unknown recording and one whose playback has not finished", async () => {
    expect((await (await fixture()).get("2026-01-02T03-04-05-000Z-1")).status).toBe(404);
    expect((await (await fixture()).get("not-a-replay")).status).toBe(404);
    expect((await (await fixture({ finished: false })).get()).status).toBe(404);
  });
});

describe("a replay's harness phase", () => {
  it("serves a Model Index match's phase by its lobby's startsAt, else createdAt, beside its figures, writing nothing", async () => {
    const f = await fixture({ startsAt: Date.parse("2026-10-26T01:38:30Z") });
    const before = JSON.stringify([...f.docs]);
    const body = await (await f.get()).json();
    expect(body.harnessPhase).toEqual({ phase: "rounds 1-7", possibleEffortMismatch: true });
    expect(body.ratings).toHaveLength(2);
    // createdAt is 0 in the fixture: before every boundary.
    await expect((await (await fixture({ startsAt: null })).get()).json()).resolves.toMatchObject({ harnessPhase: { phase: "rounds 1-7" } });
    expect(JSON.stringify([...f.docs])).toBe(before);
  });

  it("serves an unrated Model Index match's phase with no figures", async () => {
    expect(await (await (await fixture({ rated: false, startsAt: Date.parse("2026-11-10T02:00:00Z") })).get()).json())
      .toEqual({ ratings: [], harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false } });
  });

  it("sends no phase for a match in any other mode", async () => {
    for (const mode of ["1v1", "4v4", null] as const) {
      const body = await (await (await fixture({ mode })).get()).json();
      expect("harnessPhase" in body).toBe(false);
      expect(body.ratings).toHaveLength(2);
    }
  });

  it("is read by the replay page with its figures in one request", async () => {
    const f = await fixture();
    let requests = 0;
    const counted = ((url: string, init?: RequestInit) => { requests++; return f.request(url, init); }) as typeof fetch;
    const facts = await storedReplayFacts(replayId, null, new AbortController().signal, counted);
    expect(facts.harnessPhase).toEqual(round26Phase);
    expect(facts.ratings?.ratings.size).toBe(2);
    expect(requests).toBe(1);
    const other = await fixture({ mode: "1v1" });
    expect((await storedReplayFacts(replayId, null, new AbortController().signal, other.request)).harnessPhase).toBeNull();
  });
});

/** These reads show the same figures before and after restatement is keyed by colony and display name. */
describe("a replay page reads stored figures as it always has", () => {
  it("restates an ordinary record's seats with their stored figures", async () => {
    expect(await shown(await fixture(), [[0, "glm", 1383.3, 1399.5], [1, "deepseek", 1386.6, 1370.4]])).toEqual([
      { name: "glm", rating: 1412.25, before: 1412.25, after: 1461.75 },
      { name: "deepseek", rating: 1430.5, before: 1430.5, after: 1388 },
    ]);
  });

  it("restates each seat of one identity holding several, whatever the join order", async () => {
    const f = await fixture({ colonies: [[{ id: "glm", displayName: "glm" }, { id: "glm", displayName: "glm" }],
      [{ id: "deepseek", displayName: "deepseek" }, { id: "kimi", displayName: "kimi" }]],
    changes: [...glicko, { identityId: "kimi", before: 1400, after: 1390 }] });
    expect(await shown(f, [[1, "kimi", 1410, 1401], [0, "glm #2", 1383.3, 1399.5], [1, "deepseek", 1386.6, 1370.4], [0, "glm #1", 1383.3, 1399.5]])).toEqual([
      { name: "kimi", rating: 1400, before: 1400, after: 1390 },
      { name: "glm #2", rating: 1412.25, before: 1412.25, after: 1461.75 },
      { name: "deepseek", rating: 1430.5, before: 1430.5, after: 1388 },
      { name: "glm #1", rating: 1412.25, before: 1412.25, after: 1461.75 },
    ]);
  });

  it("restates an older rated match whose stored rows carry no colony or deviation", async () => {
    const f = await fixture({ changes: [{ identityId: "glm", before: 1500, after: 1516 }, { identityId: "deepseek", before: 1500, after: 1484 }] });
    expect(await shown(f, [[1, "deepseek", 1386.6, 1370.4], [0, "glm", 1383.3, 1399.5]])).toEqual([
      { name: "deepseek", rating: 1500, before: 1500, after: 1484 },
      { name: "glm", rating: 1500, before: 1500, after: 1516 },
    ]);
  });

  it("keeps the recording's own figures for a seatless lobby", async () => {
    expect(await shown(await fixture({ colonies: [[], []] }), [[0, "glm", 1383.3, 1399.5], [1, "deepseek", 1386.6, 1370.4]])).toEqual([
      { name: "glm", rating: 1383.3, before: 1383.3, after: 1399.5 },
      { name: "deepseek", rating: 1386.6, before: 1386.6, after: 1370.4 },
    ]);
  });
});

describe("two identities sharing a display name", () => {
  const sharing = { colonies: [[{ id: "glm", displayName: "glm" }], [{ id: "glm-air", displayName: "glm" }]] as Lobby["colonies"],
    changes: [{ identityId: "glm", before: 1412.25, after: 1461.75 }, { identityId: "glm-air", before: 1430.5, after: 1388 }] };

  it("restates each seat with its own stored figures when they sit on opposite colonies", async () => {
    expect(await shown(await fixture(sharing), [[1, "glm", 1386.6, 1370.4], [0, "glm", 1383.3, 1399.5]])).toEqual([
      { name: "glm", rating: 1430.5, before: 1430.5, after: 1388 },
      { name: "glm", rating: 1412.25, before: 1412.25, after: 1461.75 },
    ]);
  });

  it("keeps the recording's figures when they share a colony, which nothing the recording carries can tell apart", async () => {
    const f = await fixture({ colonies: [[...sharing.colonies[0], ...sharing.colonies[1]], [{ id: "deepseek", displayName: "deepseek" }]],
      changes: [...sharing.changes, glicko[1]] });
    expect(await shown(f, [[0, "glm", 1383.3, 1399.5], [0, "glm", 1490, 1500], [1, "deepseek", 1386.6, 1370.4]])).toEqual([
      { name: "glm", rating: 1383.3, before: 1383.3, after: 1399.5 },
      { name: "glm", rating: 1490, before: 1490, after: 1500 },
      { name: "deepseek", rating: 1386.6, before: 1386.6, after: 1370.4 },
    ]);
  });
});
