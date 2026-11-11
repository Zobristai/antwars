// GET /watch/queue: public, unauthenticated, and only each waiting agent's display name, mode and seconds
// waited. The store row handed to the route here deliberately carries extra identifying fields, which must not leak.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { identityDisplay } from "../../src/identity/retention.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { publicQueue } from "../../src/live/queue-catalog.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import type { WatchRegistry } from "../../src/live/watch-registry.ts";

const close: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });

const IDENTIFYING = ["ownerId", "key", "token", "identityId", "entryId", "lobbyId", "id"];

/** Every identity's rating in every mode, as the stub rating store answers it; the reads it was asked for. */
const RATING = { rating: 1612.4, rd: 61.5, ratedMatches: 12 };
let reads: [string, string][] = [];
async function serve(rows: unknown[], unstarted: unknown[] = [], readRating = async (_id: string, _mode: string) => RATING) {
  reads = [];
  const ratings = { readRating: async (id: string, mode: string) => { reads.push([id, mode]); return readRating(id, mode); } };
  const accounts = { lobbies: { listWaiting: async () => rows, listUnstarted: async () => unstarted }, ratings } as unknown as AccountStores;
  const hub = new LiveHub(); close.push(() => hub.close());
  const routes = watchRoutes({ accounts, registry: {} as WatchRegistry, hub });
  const server = createServer((req, res) => { void routes(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /watch/queue", () => {
  it("answers without credentials with exactly displayName, mode and waitingSeconds per waiting agent", async () => {
    const now = Date.now();
    const origin = await serve([
      { displayName: "sam/first", mode: "1v1", joinedAt: now - 90_000, identityId: "00000000-0000-4000-8000-00000000000a", ownerId: "owner-a", key: "secret-key", lobbyId: "lobby-x", entryId: "entry-1" },
      { displayName: "antwars/agent0", mode: "house-2v2", joinedAt: now - 5_000, identityId: "00000000-0000-4000-8000-00000000000b", token: "secret-token" },
    ]);
    const response = await fetch(`${origin}/watch/queue`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { waiting: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["waiting", "lobbies"]);
    const keys = ["displayName", "mode", "waitingSeconds", "since", "rating"];
    expect(body.waiting.map(row => Object.keys(row))).toEqual([keys, keys]);
    expect(body.waiting.map(row => [row.displayName, row.mode, row.since, row.rating])).toEqual([["sam/first", "1v1", now - 90_000, RATING], ["antwars/agent0", "house-2v2", now - 5_000, RATING]]);
    // Each agent's rating is read in its own queue's mode.
    expect(reads).toEqual([["00000000-0000-4000-8000-00000000000a", "1v1"], ["00000000-0000-4000-8000-00000000000b", "house-2v2"]]);
    expect(body.waiting[0]!.waitingSeconds).toBeGreaterThanOrEqual(90);
    expect(body.waiting[0]!.waitingSeconds).toBeLessThan(120);
    const text = JSON.stringify(body);
    for (const leak of ["owner-a", "secret-key", "secret-token", "lobby-x", "entry-1", "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"]) expect(text).not.toContain(leak);
    for (const field of IDENTIFYING) expect(text).not.toContain(`"${field}"`);
  });

  it("answers an empty list when nobody is waiting, and refuses anything but GET", async () => {
    const origin = await serve([]);
    expect(await (await fetch(`${origin}/watch/queue`)).json()).toEqual({ waiting: [], lobbies: [] });
    expect((await fetch(`${origin}/watch/queue`, { method: "POST" })).status).toBe(405);
  });

  it("counts whole seconds waited and never a negative wait", () => {
    const agent = { identityId: "a-id", displayName: "a", mode: "4v4", joinedAt: 10_000 } as const;
    expect(publicQueue([agent], 71_999)).toEqual({ waiting: [{ displayName: "a", mode: "4v4", waitingSeconds: 61, since: 10_000, rating: null }], lobbies: [] });
    expect(publicQueue([agent], 9_000).waiting[0]!.waitingSeconds).toBe(0);
  });
});

describe("GET /watch/queue for a released owner's identities", () => {
  it("never sends the owner id that a released name's placeholder carries", async () => {
    const ownerId = "00000000-0000-4000-8000-0000000000aa", handleId = "00000000-0000-4000-8000-0000000000bb";
    const owner = { kind: "username", displayName: "sam", nameState: "released" };
    // The names identities.findById returns once the owner's username is released.
    const ownName = identityDisplay(ownerId, owner, ownerId, owner);
    const handleName = identityDisplay(handleId, { kind: "handle", displayName: "sam/first", ownerId }, ownerId, owner);
    expect(ownName).toContain(ownerId); expect(handleName).toContain(ownerId);
    const now = Date.now();
    const origin = await serve([
      { displayName: ownName, mode: "1v1", joinedAt: now },
      { displayName: handleName, mode: "house-1v1", joinedAt: now },
      { displayName: "bea", mode: "2v2", joinedAt: now },
    ]);
    const body = await (await fetch(`${origin}/watch/queue`)).json() as { waiting: { displayName: string }[] };
    expect(body.waiting.map(row => row.displayName)).toEqual(["released account", "released account/first", "bea"]);
    expect(JSON.stringify(body)).not.toContain(ownerId);
    expect(JSON.stringify(body)).not.toContain("account:");
  });
});

describe("GET /watch/queue lobbies", () => {
  const LOBBY = "11111111-2222-4333-8444-555555555555";
  const seat = (id: string, displayName: string) => ({ id, displayName, ownerId: `owner-${id}`, key: `key-${id}` });

  it("sends each unstarted lobby's mode, size, seats taken, seated names by colony and seconds waited, and nothing identifying", async () => {
    const now = Date.now();
    const origin = await serve([], [
      { id: LOBBY, kind: "public", mode: null, size: 2, seated: 3, createdAt: now - 250_000, creatorId: "creator-x", inviteVerifier: "verifier-x",
        colonies: [[seat("ann-id", "ann"), seat("cat-id", "cat")], [seat("bob-id", "bob")]] },
      { id: "lobby-y", kind: "public", mode: "house-2v2", size: 2, seated: 4, createdAt: now, matchRunId: "run-y", slot: "public-0",
        colonies: [[seat("h0-id", "antwars/agent0")], [seat("h1-id", "antwars/agent1")]] },
    ]);
    const body = await (await fetch(`${origin}/watch/queue`)).json() as { lobbies: Record<string, unknown>[] };
    const keys = ["mode", "size", "seated", "colonies", "ratings", "waitingSeconds", "since"];
    expect(body.lobbies.map(row => Object.keys(row))).toEqual([keys, keys]);
    expect(body.lobbies.map(row => [row.mode, row.size, row.seated, row.colonies, row.ratings, row.since])).toEqual([
      [null, 2, 3, [["ann", "cat"], ["bob"]], [[RATING, RATING], [RATING]], now - 250_000],
      ["house-2v2", 2, 4, [["antwars/agent0"], ["antwars/agent1"]], [[RATING], [RATING]], now],
    ]);
    // A player-made lobby's seats are read in public 1v1, a queue pairing's in its mode.
    expect(reads).toEqual([["ann-id", "1v1"], ["cat-id", "1v1"], ["bob-id", "1v1"], ["h0-id", "house-2v2"], ["h1-id", "house-2v2"]]);
    expect(body.lobbies[0]!.waitingSeconds).toBeGreaterThanOrEqual(250);
    expect(body.lobbies[0]!.waitingSeconds).toBeLessThan(280);
    const text = JSON.stringify(body);
    for (const leak of [LOBBY, "lobby-y", "creator-x", "verifier-x", "run-y", "public-0", "ann-id", "owner-ann-id", "key-ann-id", "private"]) expect(text).not.toContain(leak);
    for (const field of IDENTIFYING) expect(text).not.toContain(`"${field}"`);
  });

  it("shows a house challenge's held seat its Index 1v1 rating, none before the Index rated it, and the builder its public 1v1 rating", async () => {
    const now = Date.now();
    const challenge = (held: string) => ({ id: LOBBY, kind: "public", mode: null, size: 1, seated: 2, createdAt: now, challenge: "house",
      colonies: [[seat(held, "antwars/red")], [seat("kite-id", "kite")]] });
    const unrated = { rating: 1500, rd: 350, ratedMatches: 0 };
    const origin = await serve([], [challenge("red-id"), { ...challenge("blue-id"), id: "lobby-z" }],
      async (id, mode) => id === "blue-id" && mode === "house-1v1" ? unrated : RATING);
    const body = await (await fetch(`${origin}/watch/queue`)).json() as { lobbies: { ratings: unknown }[] };
    expect(body.lobbies.map(row => row.ratings)).toEqual([[[RATING], [RATING]], [[null], [RATING]]]);
    expect(reads).toEqual([["red-id", "house-1v1"], ["kite-id", "1v1"], ["blue-id", "house-1v1"]]);
  });

  it("shows a released owner's seated name as the released placeholder, never its owner id", () => {
    const ownerId = "00000000-0000-4000-8000-0000000000aa";
    const owner = { kind: "username", displayName: "sam", nameState: "released" };
    const handleName = identityDisplay("00000000-0000-4000-8000-0000000000bb", { kind: "handle", displayName: "sam/first", ownerId }, ownerId, owner);
    const queue = publicQueue([], 61_000, [{ mode: "1v1", size: 1, seated: 2, createdAt: 0, colonies: [[{ id: "a", displayName: handleName }], [{ id: "b", displayName: "bea" }]] }]);
    expect(queue.lobbies).toEqual([{ mode: "1v1", size: 1, seated: 2, colonies: [["released account/first"], ["bea"]], ratings: [[null], [null]], waitingSeconds: 61, since: 0 }]);
    expect(JSON.stringify(queue)).not.toContain(ownerId);
  });
});
