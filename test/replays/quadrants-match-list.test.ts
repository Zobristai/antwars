// A Quadrants (four-colony) match's row in the recorded match list, GET /matches: its four colony names, the quadrants
// mode and its result, typed from its lobby where one is read and else from its record; two-colony rows as before. The
// records are hand-written four-colony MatchRecord JSON of the agreed shape (src/replays/history.ts), read from storage.
import { createServer, get as httpGet } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { historyRoutes, type RecordingLobby, type RecordingLobbyLookup, type TypedHistorySummary } from "../../src/replays/history-routes.ts";
import { createGcsHistorySource } from "../../src/replays/history-source.ts";
import { parseSummary } from "../../src/replays/history-summary-worker.ts";
import { lobbyMatchType, recordedMatchType } from "../../src/replays/recorded-match-type.ts";

const QUADRANT_NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const QUADRANTS = "2026-11-14T09-00-00-000Z-1", RATED = "2026-11-14T08-00-00-000Z-1", UNRATED = "2026-11-14T07-00-00-000Z-1";
const box = (x: number, y: number) => ({ x, y, width: 6, height: 6 });
const setupOf = (colonies: 2 | 4, extra: Record<string, unknown>) => ({ gridScale: 2, mapW: 64, mapH: 64, ticksPerSecond: 10, matchTicks: 6000,
  idleTicks: 600, overrunRadiusTiles: 3, queens: [[1280, 1280], [15104, 15104], [15104, 1280], [1280, 15104]].slice(0, colonies),
  startBoxes: [box(2, 2), box(56, 56), box(56, 2), box(2, 56)].slice(0, colonies), startingQueenIds: [[1], [2], [3], [4]].slice(0, colonies), ...extra });
const seatOf = (seat: number, colony: number, handle: string | null) => ({ seat, colony, modelLabel: `model-${seat}`, thinkingLevel: "high",
  serviceTier: null, handle, joinedTick: 0, commands: [{ tick: 3, request: "record-only" }] });

/** A four-colony record: one seat per colony; colony 2 wins once colonies 0, 3 and 1 are eliminated. */
function quadrantsRecord(handles: readonly (string | null)[] = ["ada", "bea", "cyd", "dee"]) {
  return { format: "antwar.match", version: 1, id: QUADRANTS, source: "match-log", status: "complete", unavailable: [],
    startedAt: "2026-11-14T09:00:00.000Z", endedAt: "2026-11-14T09:08:00.000Z", simulationEndedAt: "2026-11-14T09:07:12.100Z",
    rules: { version: 27, holdBehaviour: "hold", config: {} },
    setup: setupOf(4, { colonies: 4, rated: false, colonyNames: QUADRANT_NAMES }),
    result: { winner: 2, reason: "queens_killed", decidedBy: "queens_killed", tick: 4321 },
    seats: handles.map((handle, colony) => seatOf(colony, colony, handle)),
    events: [{ tick: 1200, event: { kind: "eliminated", colony: 0, tick: 1200 } }, { tick: 2500, event: { kind: "eliminated", colony: 3, tick: 2500 } },
      { tick: 4321, event: { kind: "eliminated", colony: 1, tick: 4321 } }],
    eliminations: [{ colony: 0, tick: 1200 }, { colony: 3, tick: 2500 }, { colony: 1, tick: 4321 }] };
}
/** Two-colony records as they are stored today: a rated match, and an unrated one under its drawn names. */
const ratedRecord = () => ({ ...quadrantsRecord(), id: RATED, startedAt: "2026-11-14T08:00:00.000Z", endedAt: "2026-11-14T08:30:00.000Z",
  simulationEndedAt: null, setup: setupOf(2, { rated: true }), result: { winner: 1, reason: "time_up", decidedBy: "territory", tick: 5999 },
  seats: [seatOf(0, 0, "ada"), seatOf(1, 1, "bea")], events: [] as unknown[], eliminations: undefined });
const unratedRecord = () => ({ ...ratedRecord(), id: UNRATED, startedAt: "2026-11-14T07:00:00.000Z",
  setup: setupOf(2, { rated: false, colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"] }), result: { winner: null, reason: "time_up", decidedBy: "draw", tick: 5999 } });

/** The served row's seat as listed: the record's seat without its join tick and commands. */
const listedSeat = (seat: number, colony: number, handle: string | null) =>
  ({ seat, colony, modelLabel: `model-${seat}`, thinkingLevel: "high", serviceTier: null, handle, startRating: null });
const QUADRANTS_ROW = { id: QUADRANTS, startedAt: "2026-11-14T09:00:00.000Z", endedAt: "2026-11-14T09:08:00.000Z",
  simulationEndedAt: "2026-11-14T09:07:12.100Z", winner: 2, reason: "queens_killed", decidedBy: "queens_killed",
  seats: [listedSeat(0, 0, "ada"), listedSeat(1, 1, "bea"), listedSeat(2, 2, "cyd"), listedSeat(3, 3, "dee")],
  status: "complete", unavailable: [], rated: false, modelIndex: false, colonyNames: QUADRANT_NAMES, matchType: { kind: "quadrants", size: 1 } };
// The two-colony rows exactly as GET /matches served them before four-colony records existed.
const RATED_ROW = { id: RATED, startedAt: "2026-11-14T08:00:00.000Z", endedAt: "2026-11-14T08:30:00.000Z", simulationEndedAt: null,
  winner: 1, reason: "time_up", decidedBy: "territory", seats: [listedSeat(0, 0, "ada"), listedSeat(1, 1, "bea")],
  status: "complete", unavailable: [], rated: true, modelIndex: false, matchType: { kind: "ranked", size: 1 } };
const UNRATED_ROW = { ...RATED_ROW, id: UNRATED, startedAt: "2026-11-14T07:00:00.000Z", winner: null, decidedBy: "draw", rated: false,
  colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"], matchType: { kind: "unrated", size: 1 } };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** GET /matches over stored records, read and summarised as in production, with an optional lobby lookup. */
async function listMatches(records: readonly { readonly id: string }[], lobbies?: RecordingLobbyLookup) {
  const stored = new Map(records.map(record => [`${record.id}.json`, JSON.stringify(record)]));
  const provider = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url!, "http://provider").pathname.split("/").at(-1)!);
    const body = stored.get(name);
    if (body === undefined) res.writeHead(404).end(); else res.writeHead(200).end(body);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  cleanup.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const source = createGcsHistorySource("quadrants-fixture", async input => String(input).startsWith("http://metadata")
    ? Response.json({ access_token: "fixture-token" }) : Response.json({ items: [...stored.keys()].map(name => ({ name, generation: "1" })) }),
  (url, options, response) => httpGet(`http://127.0.0.1:${(provider.address() as AddressInfo).port}${url.pathname}${url.search}`, options, response));
  const handler = historyRoutes(source, lobbies);
  const server = createServer((req, res) => { void handler(req, res, undefined as never); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { matches: TypedHistorySummary[] }).matches;
}

const lobbySeat = (id: string, displayName: string) => ({ id, displayName });
const quadrantsLobby: RecordingLobby = { kind: "public", size: 1, mode: "quadrants", outcome: "colony_2_won",
  colonies: [[lobbySeat("a", "ada")], [lobbySeat("b", "bea")], [lobbySeat("c", "cyd")], [lobbySeat("d", "dee")]] };

describe("a Quadrants match's row in the recorded match list", () => {
  it("lists it with its four colony names, the quadrants mode and its result, typed from its record where no lobby is read", async () => {
    const records = [quadrantsRecord(), ratedRecord(), unratedRecord()];
    expect(await listMatches(records)).toEqual([QUADRANTS_ROW, RATED_ROW, UNRATED_ROW]);
    // A lookup that finds no lobby, or fails, types the row from its record the same way.
    expect(await listMatches(records, async () => null)).toEqual([QUADRANTS_ROW, RATED_ROW, UNRATED_ROW]);
    expect(await listMatches([quadrantsRecord()], async () => { throw new Error("lobby read failed"); })).toEqual([QUADRANTS_ROW]);
  });

  it("types it from its readable quadrants lobby, and takes each colony's missing handle from that lobby", async () => {
    const lookup = async (replayId: string) => replayId === QUADRANTS ? quadrantsLobby : null;
    expect(await listMatches([quadrantsRecord()], lookup)).toEqual([QUADRANTS_ROW]);
    // A record without seat handles takes all four colonies' handles from its lobby.
    expect(await listMatches([quadrantsRecord([null, "bea", null, null])], lookup)).toEqual([QUADRANTS_ROW]);
    expect(lobbyMatchType(quadrantsLobby)).toEqual({ kind: "quadrants", size: 1 });
  });

  it("carries a draw, and refuses a colony, winner or name count that its colony count does not allow", () => {
    const encode = (record: unknown) => new TextEncoder().encode(JSON.stringify(record));
    const parse = (change: (record: any) => void) => { const record: any = quadrantsRecord(); change(record); return parseSummary(QUADRANTS, encode(record)); };
    expect(parse(record => { record.result = { winner: null, reason: "time_up", decidedBy: "draw", tick: 6000 }; }))
      .toMatchObject({ winner: null, reason: "time_up", decidedBy: "draw", colonyNames: QUADRANT_NAMES });
    for (const winner of [0, 1, 3]) expect(parse(record => { record.result.winner = winner; }).winner).toBe(winner);
    const refused: [string, (record: any) => void][] = [
      ["winner 4", record => { record.result.winner = 4; }],
      ["colony 4", record => { record.seats[0].colony = 4; }],
      ["three names", record => { record.setup.colonyNames = QUADRANT_NAMES.slice(0, 3); }],
      ["no names", record => { delete record.setup.colonyNames; }],
      ["an empty name", record => { record.setup.colonyNames = [...QUADRANT_NAMES.slice(0, 3), ""]; }],
      ["colonies 3", record => { record.setup.colonies = 3; }],
      // Without colonies 4 a record has two colonies, as before: its seats in colonies 2 and 3 are refused.
      ["colony 2 on a two-colony record", record => { delete record.setup.colonies; record.setup.colonyNames = QUADRANT_NAMES.slice(0, 2); }],
    ];
    for (const [label, change] of refused) expect(() => parse(change), label).toThrow("Invalid match record.");
    // A two-colony record's winner keeps today's bounds.
    expect(() => parseSummary(RATED, encode({ ...ratedRecord(), result: { ...ratedRecord().result, winner: 2 } }))).toThrow("Invalid match record.");
  });

  it("types a record of four colonies as Quadrants by its own facts, one agent per colony", () => {
    const summary = parseSummary(QUADRANTS, new TextEncoder().encode(JSON.stringify(quadrantsRecord())));
    expect(recordedMatchType(summary)).toEqual({ kind: "quadrants", size: 1 });
    // A record whose rated flag is unknown has no type, as for any record.
    expect(recordedMatchType({ ...summary, rated: null })).toBeNull();
  });
});
