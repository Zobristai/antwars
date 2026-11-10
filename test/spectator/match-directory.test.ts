import { afterEach, describe, expect, it, vi } from "vitest";
import { readPublicMatchCatalog, watchMatchDirectory } from "../../web/src/match-directory.ts";
import { publicMatchCatalog } from "../../src/live/match-catalog.ts";
import { streamPath } from "../../web/src/stream.ts";

const catalog = {
  matches: [{ lobbyId: "old", startedAt: 1000, rated: true, delaySeconds: 300 }],
  lobbies: [{ id: "open", size: 1, state: "open", colonies: [["player"], []] }],
};
const mixedCatalog = publicMatchCatalog([
  { lobbyId: "ranked", startedAt: 1, visibility: "public", rated: true, mode: "1v1", playbackFinished: false },
  { lobbyId: "unrated", startedAt: 2, visibility: "public", rated: false, playbackFinished: false },
  ...(["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const).map((mode, index) => ({
    lobbyId: mode, startedAt: 3 + index, visibility: "public" as const, rated: true, mode, playbackFinished: false,
  })),
], [
  { id: "open", kind: "public", size: 1, state: "open", colonies: [[{ displayName: "player" }], []] },
  { id: "waiting", kind: "public", size: 2, state: "waiting", colonies: [[], []] },
]);
afterEach(() => vi.useRealTimers());

describe("public match catalog without playback replacement", () => {
  it("pins a lobby stream independently of a recycled numeric slot sequence", () => {
    expect(streamPath(new URLSearchParams("lobby=old-lobby&match=2"))).toBe("/watch/live/old-lobby");
    expect(streamPath(new URLSearchParams("match=2"))).toBeNull();
    expect(streamPath(new URLSearchParams())).toBeNull();
  });
  it("accepts the public projection while dropping extra fields", () => {
    expect(readPublicMatchCatalog({ ...catalog, invite: "not-copied" })).toEqual(catalog);
    expect(readPublicMatchCatalog({ ...catalog, matches: [{ ...catalog.matches[0], delaySeconds: 60 }] })).toBeNull();
    expect(readPublicMatchCatalog({ matches: [], lobbies: [{ ...catalog.lobbies[0], state: "private" }] })).toBeNull();
    expect(readPublicMatchCatalog({ matches: null, lobbies: [] })).toBeNull();
  });

  it("preserves every server catalog entry with zero-delay house matches and still rejects invalid delays", () => {
    // The HUD reads each entry's four fields; the players and a Model Index match's harness phase are the Matches page's,
    // extra fields it drops.
    expect(readPublicMatchCatalog(mixedCatalog)).toEqual({ ...mixedCatalog,
      matches: mixedCatalog.matches.map(({ colonies: _players, harnessPhase: _phase, ...entry }) => entry) });
    expect(mixedCatalog.matches.map(match => match.delaySeconds)).toEqual([300, 60, 0, 0, 0, 0]);
    for (const delaySeconds of [-1, 1, 299, "0", null]) {
      expect(readPublicMatchCatalog({ ...catalog, matches: [{ ...catalog.matches[0], delaySeconds }] })).toBeNull();
    }
    expect(readPublicMatchCatalog({ ...catalog, matches: [{ ...catalog.matches[0], rated: false, delaySeconds: 300 }] })).toBeNull();
  });

  it("publishes newly started matches without selecting them or resetting playback", async () => {
    vi.useFakeTimers();
    let body = catalog;
    const request = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
    const update = vi.fn(), unavailable = vi.fn();
    const close = watchMatchDirectory(update, unavailable, request, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenLastCalledWith(catalog);
    body = { ...catalog, matches: [...catalog.matches, { lobbyId: "new", startedAt: 2000, rated: false, delaySeconds: 60 }] };
    await vi.advanceTimersByTimeAsync(100);
    expect(update).toHaveBeenLastCalledWith(body);
    expect(unavailable).not.toHaveBeenCalled();
    close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports a failing store as unavailable, not as no live matches", async () => {
    vi.useFakeTimers();
    const update = vi.fn(), unavailable = vi.fn();
    const close = watchMatchDirectory(update, unavailable, async () => new Response("", { status: 503 }), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
    close();
  });

  it("does not issue overlapping polls and suppresses replies after disposal", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
    const update = vi.fn(), unavailable = vi.fn();
    const close = watchMatchDirectory(update, unavailable, request, 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledOnce();
    close(); finish(Response.json(catalog));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });
});
