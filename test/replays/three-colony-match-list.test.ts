// Three-colony summaries through the production storage reader, HTTP endpoint, client parser and Recordings card.
import { createServer, get as httpGet } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyRoutes, type RecordingLobbyLookup, type TypedHistorySummary } from "../../src/replays/history-routes.ts";
import { createGcsHistorySource } from "../../src/replays/history-source.ts";
import { createMatchesData } from "../../web/src/matches-page/data.ts";
import { recordingsCard } from "../../web/src/pages/matches.ts";
import { dom, type ElementPort } from "../spectator/pages/dom.ts";
import { parseSummary } from "../../src/replays/history-summary-worker.ts";
import { recordedMatchType } from "../../src/replays/recorded-match-type.ts";

const QUADRANT_NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const QUADRANTS = "2026-11-14T09-00-00-000Z-1";
const box = (x: number, y: number) => ({ x, y, width: 6, height: 6 });
const setupOf = (colonies: 2 | 3 | 4, extra: Record<string, unknown>) => ({ gridScale: 2, mapW: 64, mapH: 64, ticksPerSecond: 10, matchTicks: 6000,
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


const NAMES = ["Lake Skinner Colony", "Very Large Colony", "Sweetwater Colony"];
function threeRecord() {
  return { ...quadrantsRecord(), setup: setupOf(3, { colonies: 3, colonyNames: NAMES, rated: false }),
    seats: [seatOf(0, 0, "ada"), seatOf(1, 1, "bea"), seatOf(2, 2, "cyd")],
    result: { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: 4321 } };
}
const encode = (record: unknown) => new TextEncoder().encode(JSON.stringify(record));

describe("three-colony recordings", () => {
  it("survives storage summary, GET /matches, client parsing and fixed-column rendering", async () => {
    const served = await listMatches([threeRecord()]);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ colonyNames: NAMES, winner: 0, matchType: { kind: "unrated", size: 1 } });
    const data = createMatchesData(async input => Response.json(String(input) === "/matches"
      ? { matches: served, nextPageToken: null } : { matches: [] }), () => {});
    cleanup.push(async () => data.destroy());
    data.refresh();
    await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"));
    const { doc } = dom();
    const card = recordingsCard(doc, data.view, { search: "?board=2d" }) as unknown as ElementPort;
    const rows = card.byClass("d1p-rec-rows")[0]!.children;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.byClass("d1p-rec-slot").map(slot => slot.byClass("d1p-rec-colony")[0]?.textContent ?? slot.textContent))
      .toEqual(["Very Large", "—", "Sweetwater", "Lake Skinner"]);
    expect(rows[0]!.byClass("d1p-rec-player").map(line => line.byClass("d1p-user")[0]!.textContent)).toEqual(["bea", "cyd", "ada"]);
    expect(rows[0]!.byClass("is-won")[0]!.byClass("d1p-rec-colony")[0]!.textContent).toBe("Lake Skinner");
    expect(rows[0]!.byClass("is-lost")).toHaveLength(2);
    expect(rows[0]!.byClass("d1p-rec-type")[0]!.textContent).toBe("Unranked · 1v1v1");
    expect(rows[0]!.byClass("d1p-rec-replay")[0]!.href).toBe(`/?replay=${QUADRANTS}&board=2d`);
  });

  it("preserves draw and partial summaries and counts seats in the third colony", () => {
    const record = threeRecord();
    const summary = parseSummary(QUADRANTS, encode({ ...record, status: "partial", result: { ...record.result, winner: null, reason: "time_up", decidedBy: "draw" } }));
    expect(summary).toMatchObject({ status: "partial", winner: null, reason: "time_up", decidedBy: "draw", colonyNames: NAMES });
    expect(recordedMatchType({ ...summary, seats: [seatOf(0, 2, "ada"), seatOf(1, 2, "bea")] })).toEqual({ kind: "unrated", size: 2 });
    expect(recordedMatchType({ ...summary, seats: [] })).toEqual({ kind: "unrated", size: null });
  });

  it("rejects impossible winners, seats, counts and missing or mismatched multi-colony names", () => {
    const r = threeRecord();
    for (const record of [
      { ...r, result: { ...r.result, winner: 3 } },
      { ...r, seats: [seatOf(0, 3, "ada")] },
      ...[0, 1, 5, "3", null].map(colonies => ({ ...r, setup: { ...r.setup, colonies } })),
      ...[undefined, [], NAMES.slice(0, 2), QUADRANT_NAMES, ["", ...NAMES.slice(1)]].map(colonyNames => ({ ...r, setup: { ...r.setup, colonyNames } })),
    ]) expect(() => parseSummary(QUADRANTS, encode(record))).toThrow("Invalid match record.");
    for (const winner of [0, 1, 2, null]) expect(parseSummary(QUADRANTS, encode({ ...r, result: { ...r.result, winner } })).winner).toBe(winner);
  });
});
