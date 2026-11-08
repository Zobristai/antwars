import { afterEach, expect, it, vi } from "vitest";
import { randomMatch, watchMatchStatus, type MatchStatus } from "../../web/src/match-status.ts";

const match = (lobbyId: string) => ({ lobbyId, startedAt: 1, rated: false, delaySeconds: 60 as const });
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach(close => close()); vi.useRealTimers(); });

it("polls only public matches, accepts empty catalogs and cancels on close", async () => {
  vi.useFakeTimers();
  const statuses: MatchStatus[] = [];
  const values = [[], [match("one")], [match("one"), match("two")], []];
  const request = vi.fn<typeof fetch>(async (path, options) => {
    expect(path).toBe("/watch/catalog");
    expect(options!.cache).toBe("no-store");
    return Response.json({ matches: values.shift(), lobbies: [] });
  });
  const close = watchMatchStatus(value => statuses.push(value), request); closers.push(close);
  await vi.advanceTimersByTimeAsync(4500);
  expect(statuses).toEqual([[], [match("one")], [match("one"), match("two")], []]);
  close();
  expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(request).toHaveBeenCalledTimes(4);
});

it("keeps confirmed state through malformed/failed responses and never overlaps requests", async () => {
  vi.useFakeTimers();
  const statuses: MatchStatus[] = [];
  let settle!: (response: Response) => void;
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ matches: [match("one")], lobbies: [] }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ matches: [{ lobbyId: "invalid" }], lobbies: [] }))
    .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const close = watchMatchStatus(value => statuses.push(value), request); closers.push(close);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(statuses).toEqual([[match("one")]]);
  expect(request).toHaveBeenCalledTimes(4);
  close(); settle(Response.json({ matches: [], lobbies: [] }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(statuses).toEqual([[match("one")]]);
  expect(request).toHaveBeenCalledTimes(4);
});

it("selects uniformly across the catalog and never invents a match from an empty list", () => {
  const matches = [match("one"), match("two"), match("three")];
  expect([0, 0.34, 0.99].map(random => randomMatch(matches, () => random)?.lobbyId)).toEqual(["one", "two", "three"]);
  expect(randomMatch([], () => { throw new Error("Empty selection used randomness"); })).toBeNull();
});
