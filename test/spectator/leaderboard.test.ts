import { describe, expect, it, vi } from "vitest";
import { loadLeaderboard, readLeaderboard } from "../../web/src/leaderboard.ts";

const row = { displayName: "owner/agent", rating: 1516, ratedMatches: 1, identityId: "not-rendered" };

describe("spectator leaderboard", () => {
  it("projects rated identities, never empty-match or malformed entries", () => {
    expect(readLeaderboard({ entries: [row], next: "cursor" })).toEqual({ entries: [{ displayName: "owner/agent", rating: 1516, rd: null, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, tally: null, form: [] }], next: "cursor" });
    // The rating deviation, when the server sends one; a historical page without it reads as null.
    expect(readLeaderboard({ entries: [{ ...row, rd: 87.5 }] })?.entries[0]?.rd).toBe(87.5);
    for (const rd of [0, -1, NaN, "87"]) expect(readLeaderboard({ entries: [{ ...row, rd }] })).toBeNull();
    expect(readLeaderboard({ entries: [{ ...row, ratedMatches: 0 }] })).toBeNull();
    expect(readLeaderboard({ entries: [{ ...row, rating: NaN }] })).toBeNull();
    expect(readLeaderboard({ entries: [row], next: 123 })).toBeNull();
    expect(readLeaderboard({ entries: [{ ...row, rating: -2 }] })?.entries[0]?.rating).toBe(-2);
  });
  it("reads the existing anonymous API with snapshot pagination, not identity credentials", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ entries: [row] }))) as unknown as typeof fetch;
    await loadLeaderboard("cursor", undefined, request);
    expect(request).toHaveBeenCalledWith("/api/leaderboard", expect.objectContaining({ method: "POST", body: '{"limit":50,"cursor":"cursor"}',
      headers: { "content-type": "application/json" }, cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" }));
    await expect(loadLeaderboard(undefined, undefined, async () => new Response("denied", { status: 503 }))).rejects.toThrow("unavailable");
  });
  it("sends today's request when called without a mode, and the mode and scope only when asked", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ entries: [row] }))) as unknown as typeof fetch;
    const sent = () => (request as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url, init]) => [url, init.body]);
    await loadLeaderboard(undefined, undefined, request);
    await loadLeaderboard("c1", undefined, request);
    await loadLeaderboard(undefined, undefined, request, undefined);
    await loadLeaderboard(undefined, undefined, request, { mode: "2v2" });
    await loadLeaderboard("c2", undefined, request, { mode: "3v3", scope: "house" });
    await loadLeaderboard(undefined, undefined, request, { mode: "house-4v4" });
    expect(sent()).toEqual([
      ["/api/leaderboard", '{"limit":50}'],
      ["/api/leaderboard", '{"limit":50,"cursor":"c1"}'],
      ["/api/leaderboard", '{"limit":50}'],
      ["/api/leaderboard", '{"limit":50,"mode":"2v2"}'],
      ["/api/leaderboard", '{"limit":50,"mode":"3v3","scope":"house","cursor":"c2"}'],
      ["/api/leaderboard", '{"limit":50,"mode":"house-4v4"}'],
    ]);
    const options = (request as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, { body: _body, signal: _signal, ...rest }]) => rest);
    for (const option of options) expect(option).toEqual({ method: "POST", headers: { "content-type": "application/json" },
      cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
  });

});

describe("leaderboard record and form", () => {
  const rated = { ...row, ratedMatches: 4, wins: 2, losses: 1, draws: 1, form: [{ result: "W", replayId: "2026-10-26T08-00-00-000Z-1" }, { result: "D", replayId: null }, { result: "L" }] };
  it("reads a tally adding up to rated matches and up to five letters, an older replay-less letter unlinked", () => {
    expect(readLeaderboard({ entries: [rated] })?.entries[0]).toMatchObject({
      tally: { wins: 2, losses: 1, draws: 1 },
      form: [{ result: "W", replayId: "2026-10-26T08-00-00-000Z-1" }, { result: "D", replayId: null }, { result: "L", replayId: null }],
    });
    // A row the server has not reconciled: no tally and no letters.
    expect(readLeaderboard({ entries: [{ ...row, wins: null, losses: null, draws: null, form: [] }] })?.entries[0]).toMatchObject({ tally: null, form: [] });
  });
  it.each([
    ["counts that do not add up", { wins: 3 }],
    ["a partial tally", { draws: null }],
    ["a negative count", { wins: -1, losses: 4 }],
    ["more than five letters", { form: Array.from({ length: 6 }, () => ({ result: "W", replayId: null })) }],
    ["letters without a tally", { wins: null, losses: null, draws: null }],
    ["a tally without letters", { form: [] }],
    ["an unknown letter", { form: [{ result: "X", replayId: null }] }],
    ["a replay id that is not one", { form: [{ result: "W", replayId: "javascript:alert(1)" }] }],
  ])("rejects %s", (_, change) => {
    expect(readLeaderboard({ entries: [{ ...rated, ...change }] })).toBeNull();
  });
});
