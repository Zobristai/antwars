import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicVisibility } from "../../src/identity/publicVisibility.ts";
import { historyRoutes, TOP_PATH, type HistoryRouteOptions } from "../../src/replays/history-routes.ts";
import type { HistorySource, HistorySummary } from "../../src/replays/history-source.ts";
import type { RecordingMatchType } from "../../src/replays/recorded-match-type.ts";
import { sharedRead, shippedTopMatchList, TOP_MATCHES, topMatchIds } from "../../src/replays/top-matches.ts";

let next = 0;
/** A stored 1v1 record as list() summarises it: rated with house handles is the Index; unrated with player handles is a user's unrated match. */
function stored(o: { rated?: boolean; players?: [string, string] } = {}): HistorySummary {
  const id = `2026-11-10T00-00-00-000Z-${++next}`;
  const [a, b] = o.players ?? [`antwars/a${next}`, `antwars/b${next}`];
  return {
    id, startedAt: "2026-11-10T00:00:00.000Z", endedAt: null, simulationEndedAt: "2026-11-10T00:20:00.000Z",
    winner: 0, reason: "queens_killed", decidedBy: "queens_killed",
    seats: [{ seat: 0, colony: 0, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: a },
      { seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: b }],
    status: "complete", unavailable: [], rated: o.rated ?? true, modelIndex: o.rated ?? true,
  };
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `2026-11-10T00-00-00-000Z-${900 + i}`);

describe("the top matches list file", () => {
  it("keeps its ids in order and leaves off a malformed or repeated one", () => {
    const [a, b] = ids(2);
    expect(topMatchIds({ matches: [a, "../x", b, a] })).toEqual({ ids: [a, b], leftOff: ["../x", a] });
  });

  it("refuses a file of another shape or with more than 16 ids", () => {
    expect(() => topMatchIds({ matches: ids(TOP_MATCHES + 1) })).toThrow();
    expect(() => topMatchIds(["x"])).toThrow();
    expect(() => topMatchIds({ matches: [1] })).toThrow();
    expect(topMatchIds({ matches: ids(TOP_MATCHES) }).ids).toHaveLength(TOP_MATCHES);
  });

  it("ships a valid list of 16 distinct match ids", () => {
    const { ids: shipped, leftOff } = shippedTopMatchList();
    expect(leftOff).toEqual([]);
    expect(shipped).toHaveLength(TOP_MATCHES);
  });
});

describe("the shared read", () => {
  it("reads once for concurrent and later callers, and keeps no failed read", async () => {
    let reads = 0, fail = true;
    const read = sharedRead(async () => { reads++; if (fail) throw new Error("storage"); return ["listed"]; });
    await expect(Promise.all([read(), read()])).rejects.toThrow("storage");
    expect(reads).toBe(1);
    fail = false;
    const [one, two] = await Promise.all([read(), read()]);
    expect(one).toEqual(["listed"]);
    expect(two).toBe(one);
    expect(await read()).toBe(one);
    expect(reads).toBe(2);
  });
});

describe(`GET ${TOP_PATH}`, () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => { servers.splice(0).forEach(server => server.close()); vi.restoreAllMocks(); });
  async function listen(records: readonly HistorySummary[], list: unknown, options: HistoryRouteOptions = {},
    extra: Partial<HistorySource> = {}) {
    const source: HistorySource = {
      async list() { return { matches: [], nextPageToken: null }; },
      async open() { return null; },
      async summary(id) { return records.find(row => row.id === id) ?? null; },
      ...extra,
    };
    const handler = historyRoutes(source, undefined, { topMatches: topMatchIds(list), ...options });
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const read = async (origin: string) => {
    const response = await fetch(`${origin}${TOP_PATH}`);
    return { status: response.status, body: await response.json() as { matches: (HistorySummary & { matchType: RecordingMatchType | null })[] } };
  };

  it("serves the listed matches in list order, typed and corrected as GET /matches serves them, whatever their type, leaving off only missing or hidden ones", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const first = stored(), unrated = stored({ rated: false, players: ["kain", "someone"] }), hidden = stored(), last = stored();
    const missing = ids(1)[0]!;
    const visibility: PublicVisibility = { identitiesVisible: async () => true, lobbyVisible: async () => true,
      replayVisible: async id => id !== hidden.id };
    const origin = await listen([first, unrated, hidden, last], { matches: [last.id, unrated.id, "../x", missing, hidden.id, first.id] },
      { publicVisibility: visibility },
      { async listed(rows) { return rows.map(row => ({ ...row, decidedBy: `corrected ${row.decidedBy}` })); } });
    const { status, body } = await read(origin);
    expect(status).toBe(200);
    expect(body.matches.map(row => row.id)).toEqual([last.id, unrated.id, first.id]);
    expect(body.matches[0]!.matchType).toEqual({ kind: "index", size: 1 });
    expect(body.matches[1]!.rated).toBe(false);
    expect(body.matches[0]!.decidedBy).toBe("corrected queens_killed");
    expect(info).toHaveBeenCalledExactlyOnceWith(`antwar top matches left off: ../x, ${missing}, ${hidden.id}`);
    await read(origin);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("serves an empty list where the list is empty", async () => {
    const origin = await listen([stored()], { matches: [] });
    expect(await read(origin)).toEqual({ status: 200, body: { matches: [] } });
  });

  it("reads each record once, and drops a match hidden later without a restart", async () => {
    const a = stored(), b = stored();
    const hidden = new Set<string>();
    let reads = 0;
    const visibility: PublicVisibility = { identitiesVisible: async () => true, lobbyVisible: async () => true,
      replayVisible: async id => !hidden.has(id) };
    const origin = await listen([a, b], { matches: [a.id, b.id] }, { publicVisibility: visibility },
      { async summary(id) { reads++; return [a, b].find(row => row.id === id) ?? null; } });
    expect((await read(origin)).body.matches.map(row => row.id)).toEqual([a.id, b.id]);
    hidden.add(a.id);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect((await read(origin)).body.matches.map(row => row.id)).toEqual([b.id]);
    expect(reads).toBe(2);
  });

  it("answers unavailable when the records cannot be read, and reads them again on the next request", async () => {
    const a = stored();
    let fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const origin = await listen([a], { matches: [a.id] }, {},
      { async summary(id) { if (fail) throw new Error("storage"); return id === a.id ? a : null; } });
    expect((await read(origin)).status).toBe(503);
    fail = false;
    expect((await read(origin)).body.matches.map(row => row.id)).toEqual([a.id]);
  });

  it("refuses a query and any other path under it", async () => {
    const origin = await listen([], { matches: [] });
    expect((await fetch(`${origin}${TOP_PATH}?pageToken=1`)).status).toBe(400);
    expect((await fetch(`${origin}/matches/top-x`)).status).toBe(404);
  });
});
