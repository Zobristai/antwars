import { createServer } from "node:http";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { historyBytes, type HistoryInput } from "../../src/replays/history.ts";
import { recordedMatchType } from "../../src/replays/recorded-match-type.ts";
import { MAX_LISTING_STORAGE_PAGES, UNSETTLED_LOBBY_MS, cachedLobbyLookup, historyRoutes, lobbySeatHandles, recordingMatchTime, recordingMatchType, recordingMatchTypes, recordingRated, type RecordingLobby,
  type TypedHistorySummary } from "../../src/replays/history-routes.ts";
import type { HistoryPage, HistorySource, HistorySummary } from "../../src/replays/history-source.ts";
import { createPublicVisibility, type PublicVisibility } from "../../src/identity/publicVisibility.ts";
import type { ReplayLobby } from "../../src/live/watch-registry.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { colonyModels } from "../../web/src/pages/model.ts";
import { playable } from "../playable.ts";

const HOUSE = "antwars/gpt-6-1-sol-xhigh", HOUSE_FAST = "antwars/gpt-6-1-sol-high-fast";
type SeatSpec = { colony: 0 | 1; handle?: string | null; thinkingLevel?: string | null };
function row(id: string, seats: SeatSpec[]): HistorySummary {
  return { id, startedAt: "2026-10-20T10:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0, reason: "time_up", decidedBy: "territory",
    seats: seats.map((seat, index) => ({ seat: index, colony: seat.colony, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: seat.thinkingLevel ?? null,
      serviceTier: null, handle: seat.handle ?? null })),
    status: "complete", unavailable: [] };
}
const page = (...matches: HistorySummary[]): HistoryPage => ({ matches, nextPageToken: null });
const seat = (id: string, displayName: string) => ({ id, displayName });
const handles = (summary: HistorySummary) => summary.seats.map(seat => seat.handle);

/** A lookup over fixed lobbies by replay id, counting store reads per id. */
function lobbies(byReplay: Record<string, RecordingLobby | null | "pending" | Error>) {
  const reads: string[] = [];
  return { reads, lookup: async (replayId: string) => {
    reads.push(replayId);
    const lobby = byReplay[replayId];
    if (lobby instanceof Error) throw lobby;
    return lobby ?? null;
  } };
}

describe("older Recordings take each colony's handle from its lobby", () => {
  const fourVsFour = "2026-10-31T07-20-50-000Z-1";
  it("fills all four seats of a colony whose four seats hold one identity (one stored seat id), and their badges", async () => {
    // A queue-made 4v4: one identity holds every seat of its colony.
    const { lookup } = lobbies({ [fourVsFour]: { kind: "public", size: 4, mode: "house-4v4", colonies: [
      [seat("house-a", HOUSE), seat("house-a", HOUSE), seat("house-a", HOUSE), seat("house-a", HOUSE)],
      [seat("house-b", HOUSE_FAST), seat("house-b", HOUSE_FAST), seat("house-b", HOUSE_FAST), seat("house-b", HOUSE_FAST)],
    ] } });
    const recorded = row(fourVsFour, [0, 1, 0, 1, 0, 1, 0, 1].map(colony => ({ colony: colony as 0 | 1 })));
    const filled = (await lobbySeatHandles(lookup)(page(recorded))).matches[0]!;
    expect(handles(filled)).toEqual([HOUSE, HOUSE_FAST, HOUSE, HOUSE_FAST, HOUSE, HOUSE_FAST, HOUSE, HOUSE_FAST]);
    // The badge rule, unchanged: each handle's fixed level and tier. A two-colony row, as the page's two-colony seats type reads it.
    expect(colonyModels(filled.seats as Parameters<typeof colonyModels>[0])?.map(colony => colony?.map(model => model.badges))).toEqual([
      [["xhigh"], ["xhigh"], ["xhigh"], ["xhigh"]], [["high", "Fast"], ["high", "Fast"], ["high", "Fast"], ["high", "Fast"]]]);
    expect(handles(recorded)).toEqual(Array(8).fill(null)); // The listed row itself is not rewritten.
  });

  it("leaves a colony blank when its seats carry different identities, filling only the single-identity colony", async () => {
    const id = "2026-10-31T07-41-12-000Z-1";
    const { lookup } = lobbies({ [id]: { kind: "public", size: 1, mode: null, colonies: [
      // Same display name, different ids: distinctness is by stored seat id, so this colony is mixed.
      [seat("alice", "alice/bot"), seat("bob", "alice/bot")],
      [seat("house-c", HOUSE), seat("house-c", HOUSE)],
    ] } });
    const filled = (await lobbySeatHandles(lookup)(page(row(id, [{ colony: 0 }, { colony: 1 }, { colony: 0 }, { colony: 1 }])))).matches[0]!;
    expect(handles(filled)).toEqual([null, HOUSE, null, HOUSE]);
  });

  it("keeps recorded handles and does no lookup for a fully recorded row; fills only missing seats otherwise", async () => {
    const full = "2026-10-31T08-00-00-000Z-1", partial = "2026-10-31T08-10-00-000Z-1";
    const { lookup, reads } = lobbies({
      [full]: { kind: "public", size: 1, mode: null, colonies: [[seat("x", "antwars/other")], [seat("y", "antwars/other")]] },
      [partial]: { kind: "public", size: 1, mode: null, colonies: [[seat("x", "antwars/lobby")], [seat("y", HOUSE)]] },
    });
    const result = await lobbySeatHandles(lookup)(page(
      row(full, [{ colony: 0, handle: HOUSE_FAST }, { colony: 1, handle: HOUSE }]),
      row(partial, [{ colony: 0, handle: HOUSE_FAST }, { colony: 1 }]),
    ));
    expect(result.matches.map(handles)).toEqual([[HOUSE_FAST, HOUSE], [HOUSE_FAST, HOUSE]]);
    expect(reads).toEqual([partial]);
  });

  it("leaves rows with no lobby, a private lobby or a failed lookup unfilled; caches results but not failures", async () => {
    const scheduled = "2026-10-31T09-00-00-000Z-1", hidden = "2026-10-31T09-10-00-000Z-1", broken = "2026-10-31T09-20-00-000Z-1", house = "2026-10-31T09-30-00-000Z-1";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = {
      [scheduled]: null,
      [hidden]: { kind: "private", size: 1, mode: null, colonies: [[seat("p", "alice/private")], [seat("q", "bob/private")]] },
      [broken]: new Error("store unavailable"),
      [house]: { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] },
    };
    const { lookup, reads } = lobbies(byReplay);
    const fill = lobbySeatHandles(lookup);
    const listing = page(...[scheduled, hidden, broken, house].map(id => row(id, [{ colony: 0 }, { colony: 1 }])));
    const first = await fill(listing);
    expect(first.matches.map(handles)).toEqual([[null, null], [null, null], [null, null], [HOUSE, HOUSE_FAST]]);
    expect(reads.sort()).toEqual([scheduled, hidden, broken, house].sort());
    // A repeated listing reads the store again only for the failed row, which now succeeds.
    byReplay[broken] = { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] };
    reads.length = 0;
    const second = await fill(listing);
    expect(reads).toEqual([broken]);
    expect(second.matches.map(handles)).toEqual([[null, null], [null, null], [HOUSE, HOUSE_FAST], [HOUSE, HOUSE_FAST]]);
    reads.length = 0;
    await fill(listing);
    expect(reads).toEqual([]);
  });

  it("looks a pending recording up again until its lobby link publishes, then caches it; a no-lobby answer is read once", async () => {
    // The replay link publishes after the recording is saved, so a record can be listed while its lobby match reads "pending".
    const id = "2026-10-20T10-00-00-000Z-9", scheduled = "2026-10-20T10-00-00-000Z-10";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = { [id]: "pending", [scheduled]: null };
    const { lookup, reads } = lobbies(byReplay);
    const fill = lobbySeatHandles(lookup);
    const listing = page(row(id, [{ colony: 0 }, { colony: 1 }]), row(scheduled, [{ colony: 0 }, { colony: 1 }]));
    expect((await fill(listing)).matches.map(handles)).toEqual([[null, null], [null, null]]);
    expect((await fill(listing)).matches.map(handles)).toEqual([[null, null], [null, null]]);
    // Pending is looked up on every listing; the scheduled match's no-lobby answer only once, however recent.
    expect(reads.filter(read => read === id)).toEqual([id, id]);
    expect(reads.filter(read => read === scheduled)).toEqual([scheduled]);
    byReplay[id] = { kind: "public", size: 1, mode: null, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] };
    expect((await fill(listing)).matches.map(handles)).toEqual([[HOUSE, HOUSE_FAST], [null, null]]);
    reads.length = 0;
    await fill(listing);
    expect(reads).toEqual([]); // Both answers are now cached.
  });
});

describe("Recordings carry each recording's match type", () => {
  const lobby = (fields: Partial<RecordingLobby>): RecordingLobby =>
    ({ kind: "public", size: 2, mode: null, colonies: [[seat("a", "alice/bot")], [seat("b", "bob/bot")]], ...fields });
  const typed = (rated: boolean | null, modelIndex: boolean, seats: SeatSpec[]) => ({ ...row("2026-10-20T10-00-00-000Z-1", seats), rated, modelIndex });
  const twoVsTwo: SeatSpec[] = [{ colony: 0 }, { colony: 1 }, { colony: 0 }, { colony: 1 }];

  it("types a row from its lobby: house mode Index, queue mode Ranked, house challenge, player-made Unranked", () => {
    // The record's own setup is ignored where a lobby was read: here it says unrated with no marker.
    const record = typed(false, false, twoVsTwo);
    expect(recordingMatchType(record, lobby({ mode: "house-2v2" }))).toEqual({ kind: "index", size: 2 });
    expect(recordingMatchType(record, lobby({ mode: "3v3", size: 3 }))).toEqual({ kind: "ranked", size: 3 });
    expect(recordingMatchType(record, lobby({ size: 1, challenge: { kind: "house" } }))).toEqual({ kind: "challenge", size: 1 });
    expect(recordingMatchType(record, lobby({ size: 4 }))).toEqual({ kind: "unranked", size: 4 });
  });

  it("falls back to the record's setup with no readable lobby: marker, unrated, and rated by seat handles", () => {
    for (const none of [null, undefined]) {
      expect(recordingMatchType(typed(true, true, twoVsTwo), none)).toEqual({ kind: "index", size: 2 });
      expect(recordingMatchType(typed(false, false, twoVsTwo), none)).toEqual({ kind: "unrated", size: 2 });
      expect(recordingMatchType(typed(true, false, [{ colony: 0, handle: HOUSE }, { colony: 1, handle: HOUSE_FAST }]), none))
        .toEqual({ kind: "index", size: 1 });
      expect(recordingMatchType(typed(true, false, [{ colony: 0, handle: HOUSE }, { colony: 1, handle: "alice/bot" }]), none))
        .toEqual({ kind: "ranked", size: 1 });
      // A non-house handle decides Ranked even beside a blank one.
      expect(recordingMatchType(typed(true, false, [{ colony: 0 }, { colony: 1, handle: "alice/bot" }]), none)).toEqual({ kind: "ranked", size: 1 });
    }
    // NvN is the larger colony's seat count; a record with no seats has none.
    expect(recordingMatchType(typed(false, false, [{ colony: 0 }, { colony: 1 }, { colony: 1 }]), null)).toEqual({ kind: "unrated", size: 2 });
    expect(recordingMatchType(typed(false, false, []), null)).toEqual({ kind: "unrated", size: null });
  });

  it("gives no type, never Ranked on the rated flag alone, to a rated lobby-less row with blank handles, or with no setup", () => {
    expect(recordingMatchType(typed(true, false, twoVsTwo), null)).toBeNull();
    expect(recordingMatchType(typed(true, false, [{ colony: 0, handle: HOUSE }, { colony: 1 }]), null)).toBeNull();
    expect(recordingMatchType(typed(true, false, []), null)).toBeNull();
    expect(recordingMatchType(typed(null, false, [{ colony: 0, handle: "alice/bot" }, { colony: 1 }]), null)).toBeNull();
    // A summary built without the setup fields reads as unknown, too.
    expect(recordingMatchType(row("2026-10-20T10-00-00-000Z-1", twoVsTwo), null)).toBeNull();
  });

  it("types a pending or failed lookup's row from its record for that listing, then from its lobby once it reads", async () => {
    const pending = "2026-10-31T11-00-00-000Z-1", broken = "2026-10-31T11-10-00-000Z-1", scheduled = "2026-10-31T11-20-00-000Z-1", found = "2026-10-31T11-30-00-000Z-1";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = {
      [pending]: "pending", [broken]: new Error("store unavailable"), [scheduled]: null, [found]: lobby({ mode: "2v2" }),
    };
    const { lookup, reads } = lobbies(byReplay);
    const logged: { message: string; detail: object }[] = [];
    const types = recordingMatchTypes(cachedLobbyLookup(lookup), (message, detail) => logged.push({ message, detail }));
    const listing = page(...[pending, broken, scheduled, found].map(id => ({ ...row(id, twoVsTwo), rated: false, modelIndex: false })));
    const kinds = async () => ((await types(listing)).matches as TypedHistorySummary[]).map(match => match.matchType?.kind ?? null);
    expect(await kinds()).toEqual(["unrated", "unrated", "unrated", "ranked"]);
    // Only the failed lookup is logged; a pending link is an expected wait.
    expect(logged).toEqual([{ message: "antwar recording lobby lookup failed", detail: { replayId: broken, error: "store unavailable" } }]);
    expect(reads.sort()).toEqual([pending, broken, scheduled, found].sort());
    byReplay[pending] = lobby({ size: 1, challenge: { kind: "house" } });
    byReplay[broken] = lobby({ mode: "house-2v2" });
    reads.length = 0;
    expect(await kinds()).toEqual(["challenge", "index", "unrated", "ranked"]);
    expect(logged).toHaveLength(1);
    // Only the pending and failed rows are read again; no lobby and a found lobby were cached.
    expect(reads.sort()).toEqual([pending, broken].sort());
    reads.length = 0;
    await kinds();
    expect(reads).toEqual([]);
  });

  it("types every row from its record when the server has no lobby lookup", async () => {
    const listed = await recordingMatchTypes(undefined)(page({ ...row("2026-10-31T12-00-00-000Z-1", twoVsTwo), rated: true, modelIndex: true }));
    expect(listed.matches.map(match => match.matchType)).toEqual([{ kind: "index", size: 2 }]);
  });
});

describe("Model Index Recordings carry their harness phase", () => {
  const indexLobby = (fields: Partial<RecordingLobby> = {}): RecordingLobby =>
    ({ kind: "public", size: 1, mode: "house-1v1", colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]], ...fields });
  const started = (id: string, startedAt: string, extra: Partial<HistorySummary> = {}) =>
    ({ ...row(id, [{ colony: 0, handle: HOUSE }, { colony: 1, handle: HOUSE_FAST }]), startedAt, rated: true, modelIndex: false, ...extra });

  it("decides the match time by the lobby's startsAt, else createdAt, and the recorded start without a lobby", () => {
    const record = started("2026-11-07T07-47-08-869Z-1", "2026-11-07T07:47:08.869Z");
    expect(recordingMatchTime(record, indexLobby({ startsAt: 5, createdAt: 4 }))).toBe(5);
    expect(recordingMatchTime(record, indexLobby({ startsAt: null, createdAt: 4 }))).toBe(4);
    expect(recordingMatchTime(record, null)).toBe(Date.parse("2026-11-07T07:47:08.869Z"));
    expect(recordingMatchTime(record, undefined)).toBe(Date.parse("2026-11-07T07:47:08.869Z"));
    expect(recordingMatchTime({ startedAt: "not a time" }, null)).toBeNull();
  });

  it("labels index rows only, by match time, leaving every other field as it was", async () => {
    const r8 = "2026-10-27T07-12-16-231Z-1", r26 = "2026-11-07T07-47-08-869Z-1", early = "2026-10-26T01-38-33-692Z-1";
    const ranked = "2026-11-08T10-00-00-000Z-1", byMarker = "2026-11-09T07-00-00-000Z-1", noTime = "2026-11-08T11-00-00-000Z-1";
    const { lookup } = lobbies({
      // The lobby's time decides where it was read: here a minute before the recorded start.
      [r8]: indexLobby({ startsAt: Date.parse("2026-10-27T07:11:16Z"), createdAt: 0 }),
      [r26]: indexLobby({ startsAt: null, createdAt: Date.parse("2026-11-07T07:40:00Z") }),
      [early]: indexLobby({ startsAt: Date.parse("2026-10-26T01:38:30Z") }),
      [ranked]: { ...indexLobby(), mode: "1v1" },
    });
    const rows = [started(r8, "2026-10-27T07:12:16.231Z"), started(r26, "2026-11-07T07:47:08.869Z"), started(early, "2026-10-26T01:38:33.692Z"),
      started(ranked, "2026-11-08T10:00:00.000Z"), started(byMarker, "2026-11-09T07:00:00.000Z", { modelIndex: true }),
      started(noTime, "not a time", { modelIndex: true })];
    const listed = await recordingMatchTypes(lookup)(page(...rows));
    expect(listed.matches.map(match => match.harnessPhase)).toEqual([
      { phase: "rounds 8-10", possibleEffortMismatch: false },
      { phase: "rounds 26-30", possibleEffortMismatch: false },
      { phase: "rounds 1-7", possibleEffortMismatch: true },
      undefined,
      // No lobby: the record's Model Index marker types it and its recorded start places it.
      { phase: "rounds 26-30", possibleEffortMismatch: false },
      { phase: "unknown", possibleEffortMismatch: null },
    ]);
    expect(listed.matches.map(match => "harnessPhase" in match)).toEqual([true, true, true, false, true, true]);
    listed.matches.forEach((match, index) => {
      const { harnessPhase: _, matchType: __, ...rest } = match;
      expect(rest).toEqual(rows[index]);
    });
  });

  it("labels a recording without the Model Index marker or a lobby by the shared rule: rated with every seat an antwars one", async () => {
    // The same rule (recordedMatchType) types a replay whose lobby cannot be read (web/src/source.ts).
    const legacy = "2026-10-26T01-38-33-692Z-1", unrated = "2026-10-26T02-00-00-000Z-1", noTime = "2026-10-26T03-00-00-000Z-1";
    const rows = [started(legacy, "2026-10-26T01:38:33.692Z"), started(unrated, "2026-10-26T02:00:00.000Z", { rated: false }),
      started(noTime, "not a time")];
    const listed = await recordingMatchTypes(undefined)(page(...rows));
    expect(listed.matches.map(match => [match.matchType?.kind, match.harnessPhase])).toEqual([
      ["index", { phase: "rounds 1-7", possibleEffortMismatch: true }],
      ["unrated", undefined],
      ["index", { phase: "unknown", possibleEffortMismatch: null }],
    ]);
    expect(recordedMatchType({ rated: true, seats: [{ colony: 0, handle: HOUSE }, { colony: 1, handle: HOUSE_FAST }] })).toEqual({ kind: "index", size: 1 });
  });

  it("serves the phase on GET /matches", async () => {
    const id = "2026-11-07T07-47-08-869Z-1";
    const source: HistorySource = { async list() { return page(started(id, "2026-11-07T07:47:08.869Z")); }, async open() { return null; } };
    const handler = historyRoutes(source, lobbies({ [id]: indexLobby({ startsAt: Date.parse("2026-11-07T07:47:00Z") }) }).lookup);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const listed = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`)).json()) as { matches: TypedHistorySummary[] };
      expect(listed.matches.map(match => [match.matchType, match.harnessPhase])).toEqual([[{ kind: "index", size: 1 },
        { phase: "rounds 26-30", possibleEffortMismatch: false }]]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe("Recordings list a match unrated where its lobby's outcome is one the rating table does not rate", () => {
  const indexLobby = (outcome: RecordingLobby["outcome"]): RecordingLobby =>
    ({ kind: "public", size: 1, mode: "house-1v1", colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]], outcome });
  const rated = (id: string, flag: boolean | null = true) =>
    ({ ...row(id, [{ colony: 0, handle: HOUSE }, { colony: 1, handle: HOUSE_FAST }]), rated: flag, modelIndex: true });
  const id = "2026-10-25T09-35-33-504Z-1";

  it("lists a stopped match's recording unrated, as an abandoned one, and keeps every natural result rated", () => {
    expect(recordingRated(rated(id), indexLobby("stopped"))).toBe(false);
    expect(recordingRated(rated(id), indexLobby("abandoned"))).toBe(false);
    expect(recordingRated(rated(id), indexLobby("not_played"))).toBe(false);
    for (const natural of ["colony_0_won", "colony_1_won", "draw"] as const) expect(recordingRated(rated(id), indexLobby(natural))).toBe(true);
    // A rated Free-for-all match won by colony 2 or 3 is a result too.
    for (const win of ["colony_2_won", "colony_3_won"] as const) expect(recordingRated(rated(id), indexLobby(win))).toBe(true);
  });

  it("lists a natural result unrated where its ended lobby was left unrated, as a refused Free-for-all rating leaves it", () => {
    for (const natural of ["colony_0_won", "colony_1_won", "colony_3_won", "draw"] as const) {
      expect(recordingRated(rated(id), { ...indexLobby(natural), rated: false })).toBe(false);
      expect(recordingRated(rated(id), { ...indexLobby(natural), rated: true })).toBe(true);
      expect(recordingRated(rated(id), { ...indexLobby(natural), rated: null })).toBe(true);
    }
    // Before its match ends, the lobby's flag decides nothing.
    expect(recordingRated(rated(id), { ...indexLobby(null), rated: false })).toBe(true);
  });

  it("keeps the record's flag with no lobby read, a lobby with no outcome yet, or a record that is not rated", () => {
    for (const none of [null, undefined]) expect(recordingRated(rated(id), none)).toBe(true);
    expect(recordingRated(rated(id), indexLobby(null))).toBe(true);
    expect(recordingRated(rated(id), indexLobby(undefined))).toBe(true);
    // It only ever clears the flag: an unrated record, or one with no setup, is left as it was.
    expect(recordingRated(rated(id, false), indexLobby("colony_1_won"))).toBe(false);
    expect(recordingRated(rated(id, null), indexLobby("stopped"))).toBeNull();
  });

  it("keeps a final lobby, but looks no lobby and a lobby with no outcome up again once they have been kept a while", async () => {
    const late = "2026-10-25T09-35-33-504Z-2", ending = "2026-10-25T09-35-33-504Z-3", ended = "2026-10-25T09-35-33-504Z-4";
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = { [late]: null, [ending]: indexLobby(null), [ended]: indexLobby("colony_0_won") };
    const { lookup, reads } = lobbies(byReplay);
    let clock = 1_000_000;
    const cached = cachedLobbyLookup(lookup, { now: () => clock });
    const readAll = async () => { for (const id of [late, ending, ended]) await cached(id); };
    await readAll(); await readAll();
    expect(reads).toEqual([late, ending, ended]);
    // The late registration and the outcome land; within the window the kept answers still serve.
    byReplay[late] = indexLobby("stopped"); byReplay[ending] = indexLobby("stopped");
    clock += UNSETTLED_LOBBY_MS - 1;
    reads.length = 0; await readAll();
    expect(reads).toEqual([]);
    clock += 1;
    reads.length = 0; await readAll();
    expect(reads).toEqual([late, ending]);
    expect(await cached(late)).toEqual(indexLobby("stopped"));
    // Both now have an outcome: final, kept for good.
    clock += 10 * UNSETTLED_LOBBY_MS;
    reads.length = 0; await readAll();
    expect(reads).toEqual([]);
  });

  it("lists a stopped recording unrated once its late lobby registration and outcome publish, on a later GET /matches", async () => {
    const id = "2026-10-25T09-35-33-504Z-5";
    const source: HistorySource = { async list() { return page(rated(id)); }, async open() { return null; } };
    const byReplay: Record<string, RecordingLobby | null | "pending" | Error> = { [id]: null };
    const { lookup } = lobbies(byReplay);
    const handler = historyRoutes(source, lookup, { unsettledLobbyMs: 0 });
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`;
      const listedRated = async () => ((await (await fetch(url)).json()) as { matches: TypedHistorySummary[] }).matches[0]!.rated;
      // Registration not yet published: no lobby, so the record's flag.
      expect(await listedRated()).toBe(true);
      // Registered, outcome not yet recorded: still the record's flag.
      byReplay[id] = indexLobby(null);
      expect(await listedRated()).toBe(true);
      byReplay[id] = indexLobby("stopped");
      expect(await listedRated()).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("serves a stopped Model Index match unrated on GET /matches, with its Index type and harness phase unchanged", async () => {
    const won = "2026-10-25T08-42-00-000Z-1", stopped = id, pending = "2026-10-25T10-11-00-000Z-1";
    const source: HistorySource = { async list() { return page(rated(won), rated(stopped), rated(pending)); }, async open() { return null; } };
    const { lookup } = lobbies({ [won]: indexLobby("colony_0_won"), [stopped]: indexLobby("stopped"), [pending]: "pending" });
    const handler = historyRoutes(source, lookup);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const listed = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`)).json()) as { matches: TypedHistorySummary[] };
      expect(listed.matches.map(match => [match.id, match.rated])).toEqual([[won, true], [stopped, false], [pending, true]]);
      // The same row typed beside a natural result: only its rated flag differs.
      const reference = (await recordingMatchTypes(async () => indexLobby("colony_0_won"))(page(rated(stopped)))).matches[0]!;
      const served = listed.matches[1]!;
      expect(served.matchType).toEqual({ kind: "index", size: 1 });
      expect(served.harnessPhase).toEqual(reference.harnessPhase);
      expect({ ...served, rated: true }).toEqual(reference);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe("GET /matches with a lobby lookup", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  it("serves lobby-filled handles and still serves the listing when the lookup fails", async () => {
    const ok = "2026-10-31T10-00-00-000Z-1", failing = "2026-10-31T10-10-00-000Z-1";
    const source: HistorySource = {
      async list() { return page(row(ok, [{ colony: 0 }, { colony: 1 }]), { ...row(failing, [{ colony: 0 }, { colony: 1 }]), rated: true }); },
      async open() { return null; },
    };
    const { lookup } = lobbies({ [ok]: { kind: "public", size: 1, mode: null, challenge: { kind: "house" }, colonies: [[seat("h", HOUSE)], [seat("k", HOUSE_FAST)]] },
      [failing]: new Error("store unavailable") });
    const handler = historyRoutes(source, lookup);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`);
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { matches: TypedHistorySummary[] };
    expect(listed.matches.map(handles)).toEqual([[HOUSE, HOUSE_FAST], [null, null]]);
    // Each row carries its match type: the lobby's where it read, the record's (here unknown: rated, blank handles) where it failed.
    expect(listed.matches.map(match => match.matchType)).toEqual([{ kind: "challenge", size: 1 }, null]);
  });

  it("reads each recording's lobby once for both the handle fill and the match type", async () => {
    const id = "2026-10-31T10-20-00-000Z-1";
    const source: HistorySource = {
      async list() { return page({ ...row(id, [{ colony: 0 }, { colony: 1 }]), rated: true, modelIndex: false }); },
      async open() { return null; },
    };
    const { lookup, reads } = lobbies({ [id]: { kind: "public", size: 1, mode: "1v1", colonies: [[seat("h", HOUSE)], [seat("a", "alice/bot")]] } });
    const handler = historyRoutes(source, lookup);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`;
    for (let listing = 0; listing < 2; listing++) {
      const listed = (await (await fetch(url)).json()) as { matches: TypedHistorySummary[] };
      expect(listed.matches.map(match => [handles(match), match.matchType])).toEqual([[[HOUSE, "alice/bot"], { kind: "ranked", size: 1 }]]);
    }
    expect(reads).toEqual([id]);
  });
});

describe("GET /matches lists every match, rated or unrated, that the hide list does not hide", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  /** The route over source; hidden ids are left out as the test-account owner exclusion leaves them out when switched on. */
  async function listen(source: HistorySource, lookup?: Parameters<typeof historyRoutes>[1], hidden?: ReadonlySet<string>) {
    const publicVisibility: PublicVisibility | undefined = hidden === undefined ? undefined : {
      async identitiesVisible() { return true; }, async lobbyVisible() { return true; }, async replayVisible(id) { return !hidden.has(id); },
    };
    const handler = historyRoutes(source, lookup, { publicVisibility });
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const rated = (id: string, flag: boolean | null, modelIndex = false): HistorySummary =>
    ({ ...row(id, [{ colony: 0, handle: "alice/bot" }, { colony: 1, handle: "bob/bot" }]), rated: flag, modelIndex });
  const lobbyOf = (fields: Partial<RecordingLobby>): RecordingLobby =>
    ({ kind: "public", size: 1, mode: null, colonies: [[seat("a", "alice/bot")], [seat("b", "bob/bot")]], ...fields });

  it("lists users' unrated matches alongside Model Index, challenge and rated ones", async () => {
    const id = (minute: number) => `2026-11-18T05-${String(minute).padStart(2, "0")}-00-000Z-1`;
    const ids = { index: id(10), stoppedIndex: id(9), challenge: id(8), ranked: id(7), stoppedRanked: id(6), unranked: id(5),
      quadrants: id(4), unratedRecord: id(3), indexRecord: id(2), untyped: id(1) };
    const rows = [rated(ids.index, true), rated(ids.stoppedIndex, true), rated(ids.challenge, false), rated(ids.ranked, true),
      rated(ids.stoppedRanked, true), rated(ids.unranked, false), rated(ids.quadrants, false), rated(ids.unratedRecord, false),
      rated(ids.indexRecord, true, true), { ...row(ids.untyped, [{ colony: 0 }, { colony: 1 }]), rated: true }];
    const { lookup } = lobbies({
      [ids.index]: lobbyOf({ mode: "house-1v1", outcome: "colony_0_won" }), [ids.stoppedIndex]: lobbyOf({ mode: "house-1v1", outcome: "stopped" }),
      [ids.challenge]: lobbyOf({ challenge: { kind: "house" }, outcome: "colony_1_won" }), [ids.ranked]: lobbyOf({ mode: "1v1", outcome: "draw" }),
      [ids.stoppedRanked]: lobbyOf({ mode: "1v1", outcome: "stopped" }), [ids.unranked]: lobbyOf({ outcome: "colony_0_won" }),
      [ids.quadrants]: lobbyOf({ mode: "quadrants", outcome: "colony_2_won", colonies: [[seat("a", "a")], [seat("b", "b")], [seat("c", "c")], [seat("d", "d")]] }),
    });
    const origin = await listen({ async list() { return page(...rows); }, async open() { return null; } }, lookup);
    const listed = (await (await fetch(`${origin}/matches`)).json()) as { matches: TypedHistorySummary[]; nextPageToken: string | null };
    expect(listed.matches.map(match => [match.id, match.matchType?.kind ?? null, match.rated])).toEqual([
      [ids.index, "index", true], [ids.stoppedIndex, "index", false], [ids.challenge, "challenge", false], [ids.ranked, "ranked", true],
      [ids.stoppedRanked, "ranked", false], [ids.unranked, "unranked", false], [ids.quadrants, "quadrants", false],
      [ids.unratedRecord, "unrated", false], [ids.indexRecord, "index", true], [ids.untyped, null, true]]);
    expect(listed.nextPageToken).toBeNull();
  });

  it("serves a rated Free-for-all won by colony 2 or 3 as rated, and one its refused rating left unrated as unrated", async () => {
    const id = (minute: number) => `2026-11-18T06-${String(minute).padStart(2, "0")}-00-000Z-1`;
    const four = [[seat("a", "a")], [seat("b", "b")], [seat("c", "c")], [seat("d", "d")]];
    const ids = { refusedWin: id(5), refusedDraw: id(4), refusedColony1: id(3), ratedColony2: id(2), ratedColony3: id(1) };
    const rows = Object.values(ids).map(rowId => rated(rowId, true));
    const { lookup } = lobbies({
      [ids.refusedWin]: lobbyOf({ mode: "quadrants", colonies: four, outcome: "colony_0_won", rated: false }),
      [ids.refusedDraw]: lobbyOf({ mode: "quadrants", colonies: four, outcome: "draw", rated: false }),
      [ids.refusedColony1]: lobbyOf({ mode: "quadrants", colonies: four, outcome: "colony_1_won", rated: false }),
      [ids.ratedColony2]: lobbyOf({ mode: "quadrants", colonies: four, outcome: "colony_2_won", rated: true }),
      [ids.ratedColony3]: lobbyOf({ mode: "quadrants", colonies: four, outcome: "colony_3_won", rated: true }),
    });
    const origin = await listen({ async list() { return page(...rows); }, async open() { return null; } }, lookup);
    const listed = (await (await fetch(`${origin}/matches`)).json()) as { matches: TypedHistorySummary[] };
    expect(listed.matches.map(match => [match.id, match.matchType?.kind ?? null, match.rated])).toEqual([
      [ids.refusedWin, "quadrants", false], [ids.refusedDraw, "quadrants", false], [ids.refusedColony1, "quadrants", false],
      [ids.ratedColony2, "quadrants", true], [ids.ratedColony3, "quadrants", true]]);
  });

  /** Stored rows newest first in storage pages of twenty, continued after an id, as the storage source pages them. */
  function storage(all: HistorySummary[]) {
    const reads: (string | undefined)[] = [];
    const source: HistorySource = {
      async list(token) {
        reads.push(token);
        const start = token === undefined ? 0 : all.findIndex(match => match.id === token.slice("after:".length)) + 1;
        const matches = all.slice(start, start + 20);
        return { matches, nextPageToken: start + 20 < all.length ? `after:${matches.at(-1)!.id}` : null };
      },
      continuationAfter: id => `after:${id}`,
      async open() { return null; },
    };
    return { source, reads };
  }
  const id = (n: number) => `2026-11-18T04-00-00-000Z-${1000 - n}`;
  /** Stored rows id(0)..id(length - 1), every one unrated (a user's match); those where hide(n) holds are hidden. */
  const stored = (length: number, hide: (n: number) => boolean) => {
    const all = Array.from({ length }, (_, n) => rated(id(n), false));
    const hidden = new Set(all.filter((_, n) => hide(n)).map(match => match.id));
    return { all, hidden, shownIds: all.filter(match => !hidden.has(match.id)).map(match => match.id), hiddenIds: [...hidden] };
  };
  type Listing = { matches: HistorySummary[]; nextPageToken: string | null };
  const list = async (origin: string, token: string | null = null) =>
    (await (await fetch(`${origin}/matches${token ? `?pageToken=${encodeURIComponent(token)}` : ""}`)).json()) as Listing;

  it("fills a page whose newest rows are mostly hidden from the next storage pages, continuing after its last served row", async () => {
    // Newest first: 18 hidden and 2 shown, then 20 shown, then 5 shown.
    const { all, hidden, shownIds, hiddenIds } = stored(45, n => n < 18);
    const { source, reads } = storage(all);
    const origin = await listen(source, undefined, hidden);
    const first = await list(origin);
    expect(first.matches.map(match => match.id)).toEqual(shownIds.slice(0, 20));
    expect(first.nextPageToken).toBe(`after:${shownIds[19]}`);
    const second = await list(origin, first.nextPageToken);
    expect(second.matches.map(match => match.id)).toEqual(shownIds.slice(20));
    expect(second.nextPageToken).toBeNull();
    expect(reads).toEqual([undefined, `after:${id(19)}`, `after:${shownIds[19]}`]);
    for (const page of [first, second]) for (const left of hiddenIds) expect(JSON.stringify(page)).not.toContain(left);
  });

  it("follows storage pages with every row hidden", async () => {
    // Newest first: 25 hidden, then 20 shown ending on a storage boundary, then 3 shown.
    const { all, hidden } = stored(48, n => n < 25);
    const origin = await listen(storage(all).source, undefined, hidden);
    const first = await list(origin);
    expect(first.matches.map(match => match.id)).toEqual(all.slice(25, 45).map(match => match.id));
    expect(first.nextPageToken).toBe(`after:${id(44)}`);
    const second = await list(origin, first.nextPageToken);
    expect(second.matches.map(match => match.id)).toEqual(all.slice(45).map(match => match.id));
    expect(second.nextPageToken).toBeNull();
  });

  it("keeps the storage continuation where a full page ends on a storage boundary, with no hide list", async () => {
    const { all } = stored(25, () => false);
    const { source, reads } = storage(all);
    const origin = await listen(source);
    const first = await list(origin);
    expect(first.matches.map(match => match.id)).toEqual(all.slice(0, 20).map(match => match.id));
    expect(first.nextPageToken).toBe(`after:${id(19)}`);
    expect((await list(origin, first.nextPageToken)).matches.map(match => match.id)).toEqual(all.slice(20).map(match => match.id));
    expect(reads).toEqual([undefined, `after:${id(19)}`]);
  });

  it("with the hide list on, leaves out a recording whose players cannot be established and pages on past it", async () => {
    const excluded = "00000000-0000-4000-8000-000000000001", player = "00000000-0000-4000-8000-000000000002";
    const { store, docs } = memoryWatchStore();
    docs.set(`identities/${player}`, { kind: "username" });
    docs.set("lobbies/played", { seats: JSON.stringify([{ id: player }]) });
    docs.set("lobbies/unresolved", { seats: JSON.stringify([{ id: player }, { id: "gone" }]) });
    // Newest first: id(3)'s lobby link is pending (never published, or a recording still in flight: hidden either way),
    // id(22)'s lobby names a seat identity that does not resolve; the rest list.
    const { all } = stored(25, () => false);
    const links = new Map<string, ReplayLobby>([[id(3), { state: "pending" }], [id(10), { state: "found", lobbyId: "played" }],
      [id(22), { state: "found", lobbyId: "unresolved" }]]);
    let failing = false;
    const registry = { async replayLobby(replayId: string): Promise<ReplayLobby> {
      if (failing) throw new Error("registry read failed");
      return links.get(replayId) ?? { state: "none" };
    } };
    const opened: string[] = [];
    const source: HistorySource = { ...storage(all).source, async open(openedId) { opened.push(openedId); return null; } };
    const handler = historyRoutes(source, undefined, { publicVisibility: createPublicVisibility(store, registry, [excluded])! });
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const shown = all.map(match => match.id).filter(shownId => shownId !== id(3) && shownId !== id(22));
    const first = await list(origin);
    expect(first.matches.map(match => match.id)).toEqual(shown.slice(0, 20));
    const second = await list(origin, first.nextPageToken);
    expect(second.matches.map(match => match.id)).toEqual(shown.slice(20));
    expect(second.nextPageToken).toBeNull();
    for (const page of [first, second]) for (const left of [id(3), id(22)]) expect(JSON.stringify(page)).not.toContain(left);
    // Its own record answers as not found, without opening it.
    for (const left of [id(3), id(22)]) expect((await fetch(`${origin}/matches/${left}`)).status).toBe(404);
    expect(opened).toEqual([]);
    // A failed read still fails the page.
    failing = true;
    const failed = await fetch(`${origin}/matches`);
    expect(failed.status).toBe(503);
    expect((await fetch(`${origin}/matches/${id(0)}`)).status).toBe(503);
  });

  it("serves a short page only where the history ends", async () => {
    const { all, hidden, shownIds } = stored(30, n => n % 3 !== 0);
    const only = await list(await listen(storage(all).source, undefined, hidden));
    expect(only.matches.map(match => match.id)).toEqual(shownIds);
    expect(only.nextPageToken).toBeNull();
  });

  it("stops at the storage page cap with a short page and a sealed continuation that resumes after the last row read", async () => {
    // Newest first: 2 shown, 118 hidden (past the cap's 100 rows), then 5 shown.
    const { all, hidden, shownIds, hiddenIds } = stored(125, n => n >= 2 && n < 120);
    const { source, reads } = storage(all);
    const lookups = lobbies({});
    const origin = await listen(source, lookups.lookup, hidden);
    const capped = MAX_LISTING_STORAGE_PAGES * 20;
    const first = await list(origin);
    expect(first.matches.map(match => match.id)).toEqual(shownIds.slice(0, 2));
    expect(reads).toHaveLength(MAX_LISTING_STORAGE_PAGES);
    expect(lookups.reads.length).toBeLessThanOrEqual(capped);
    expect(first.nextPageToken).toMatch(/^sealed-v1:[A-Za-z0-9_-]+$/);
    const second = await list(origin, first.nextPageToken);
    // It resumes after the last row the first request read, which was hidden.
    expect(reads[MAX_LISTING_STORAGE_PAGES]).toBe(`after:${id(capped - 1)}`);
    expect(second.matches.map(match => match.id)).toEqual(shownIds.slice(2));
    expect(second.nextPageToken).toBeNull();
    for (const listing of [first, second]) for (const left of hiddenIds) expect(JSON.stringify(listing)).not.toContain(left);
  });

  it("stops at the cap with an empty page where no row in reach is shown, and still reaches the rows past it", async () => {
    const { all, hidden } = stored(2 * MAX_LISTING_STORAGE_PAGES * 20 + 3, n => n < 2 * MAX_LISTING_STORAGE_PAGES * 20);
    const origin = await listen(storage(all).source, undefined, hidden);
    const pages: Listing[] = [await list(origin)];
    while (pages.at(-1)!.nextPageToken !== null) pages.push(await list(origin, pages.at(-1)!.nextPageToken));
    expect(pages.map(listing => listing.matches.length)).toEqual([0, 0, 3]);
    expect(pages.flatMap(listing => listing.matches.map(match => match.id))).toEqual(all.slice(-3).map(match => match.id));
    for (const listing of pages) for (const left of all.slice(0, -3)) expect(JSON.stringify(listing)).not.toContain(left.id);
  });

  it("refuses a sealed continuation it cannot open, as a forged one or one from before a restart", async () => {
    const { all, hidden } = stored(MAX_LISTING_STORAGE_PAGES * 20 + 1, n => n !== MAX_LISTING_STORAGE_PAGES * 20);
    const before = await listen(storage(all).source, undefined, hidden);
    const token = (await list(before)).nextPageToken!;
    expect(token).toMatch(/^sealed-v1:/);
    const { source, reads } = storage(all);
    const restarted = await listen(source, undefined, hidden);
    for (const refused of [token, "sealed-v1:AAAA", `sealed-v1:${"A".repeat(60)}`]) {
      const response = await fetch(`${restarted}/matches?pageToken=${encodeURIComponent(refused)}`);
      expect(response.status).toBe(400);
    }
    expect(reads).toEqual([]);
    expect((await (await fetch(`${before}/matches?pageToken=${encodeURIComponent(token)}`)).json() as Listing).matches.map(match => match.id))
      .toEqual([all.at(-1)!.id]);
  });

  it("stops waiting for outstanding lobby lookups and reads no further storage page once the request ends", async () => {
    // The first storage page has 15 shown rows, so the page is not full and another storage page would be read.
    const { all, hidden } = stored(45, n => n >= 15 && n < 20);
    const { source, reads } = storage(all);
    const started: string[] = [];
    let release!: () => void;
    const held = new Promise<null>(resolve => { release = () => resolve(null); });
    const visibility: PublicVisibility = { async identitiesVisible() { return true; }, async lobbyVisible() { return true; },
      async replayVisible(replayId) { return !hidden.has(replayId); } };
    const handler = historyRoutes(source, async replayId => { started.push(replayId); return held; }, { publicVisibility: visibility });
    let handled!: Promise<void>;
    const server = createServer((req, res) => { handled = Promise.resolve(handler(req, res, undefined as never)); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const abort = new AbortController();
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/matches`, { signal: abort.signal }).catch(() => undefined);
    while (started.length < 15) await new Promise(resolve => setTimeout(resolve, 5));
    abort.abort();
    await request;
    // The handler ends while every lookup it started is still outstanding.
    await handled;
    expect(reads).toEqual([undefined]);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toEqual([undefined]);
    expect(started).toHaveLength(15);
  });

  it("lists a user's unrated recording and serves its record by its id", async () => {
    const id = "2026-11-18T03-00-00-000Z-1";
    const origin = await listen({ async list() { return page(rated(id, false)); },
      async open(opened) { return opened === id ? Readable.from([Buffer.from("{}")]) : null; } });
    expect(((await (await fetch(`${origin}/matches`)).json()) as { matches: HistorySummary[] }).matches.map(match => [match.id, match.rated]))
      .toEqual([[id, false]]);
    const record = await fetch(`${origin}/matches/${id}`);
    expect(record.status).toBe(200);
    expect(await record.text()).toBe("{}");
  });
});

/** A short two-seat match's binary and log: the input the record service hands the real record writer. */
function matchInput(id: string): HistoryInput {
  const config = { ...playable(rulesConfig("redesign")), matchTicks: 4, commandFloorTicks: 100, startAnts: 16 };
  let state = createMatch(6006, config);
  const recorder = new SpectatorRecorder(state);
  const messages = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const lines = [headerLine(state.seed, config)];
  while (state.result === null) {
    const inputs: SimInput[] = state.tick === 0
      ? ["model-V1", "model-L1"].map((modelLabel, index) => ({ type: "join", agentId: `seat-private-${index}`, modelLabel })) : [];
    if (inputs.length) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    messages.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    state = out.state;
  }
  return { id, binary: gzipSync(packMessages(messages)), logLines: lines, endedAt: Date.parse("2026-10-20T02:00:00.404Z") };
}

describe("GET/HEAD /matches/<id> cache headers across an unavailable record's replacement", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  const id = "2026-10-20T02-00-00-000Z-18";

  /** Serves records as the record store holds them: one body per id, replaced in place, read in `chunk`-byte pieces. */
  async function serve(stored: Map<string, Uint8Array>, chunk = Infinity) {
    const pieces = (body: Uint8Array) => {
      const out: Buffer[] = [];
      for (let at = 0; at < body.length; at += Math.min(chunk, body.length)) out.push(Buffer.from(body.subarray(at, at + chunk)));
      return out;
    };
    const source: HistorySource = {
      async list() { return page(); },
      async open(match) { const body = stored.get(match); return body === undefined ? null : Readable.from(pieces(body)); },
    };
    const handler = historyRoutes(source);
    const server = createServer((req, res) => { void handler(req, res, undefined as never); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string, method = "GET") => {
      const response = await fetch(base + path, { method });
      return { status: response.status, cacheControl: response.headers.get("cache-control"), body: new Uint8Array(await response.arrayBuffer()) };
    };
  }

  const IMMUTABLE = "public, max-age=31536000, immutable", SHORT = "public, max-age=60";

  // The real record writer (history worker), so a change in its key order fails here instead of silently dropping caching:
  // an undecodable binary yields the unavailable record, a binary alone the partial one, a verified log the complete one.
  const status = (body: Uint8Array) => (JSON.parse(new TextDecoder().decode(body)) as { status: string }).status;

  it("serves an unavailable record briefly and the complete record that replaces it as immutable, both from the real writer", async () => {
    const unavailable = await historyBytes({ id, binary: new Uint8Array([1, 2, 3]) });
    const complete = await historyBytes(matchInput(id));
    expect([status(unavailable), status(complete)]).toEqual(["unavailable", "complete"]);
    const stored = new Map([[id, unavailable]]);
    const get = await serve(stored);
    for (const method of ["GET", "HEAD"]) {
      expect(await get(`/matches/${id}`, method)).toMatchObject({ status: 200, cacheControl: SHORT });
    }
    expect((await get(`/matches/${id}`)).body).toEqual(unavailable);
    stored.set(id, complete); // The record store replaces the unavailable record in place.
    for (const method of ["GET", "HEAD"]) {
      expect(await get(`/matches/${id}`, method)).toMatchObject({ status: 200, cacheControl: IMMUTABLE });
    }
    expect((await get(`/matches/${id}`)).body).toEqual(complete);
    expect(await get("/matches")).toMatchObject({ status: 200, cacheControl: "no-store" });
    expect(await get("/matches/2026-10-20T02-00-00-000Z-19")).toMatchObject({ status: 404, cacheControl: "no-store" });
  });

  it("serves a partial record briefly, and decides from the record's opening bytes however the body is chunked", async () => {
    const { logLines: _log, ...binaryOnly } = matchInput(id);
    const partial = await historyBytes(binaryOnly);
    const complete = await historyBytes(matchInput(id));
    expect(status(partial)).toBe("partial");
    for (const chunk of [1, 7, Infinity]) {
      const stored = new Map([[id, partial]]);
      const get = await serve(stored, chunk);
      expect(await get(`/matches/${id}`)).toEqual({ status: 200, cacheControl: SHORT, body: partial });
      expect(await get(`/matches/${id}`, "HEAD")).toMatchObject({ status: 200, cacheControl: SHORT });
      stored.set(id, complete);
      expect(await get(`/matches/${id}`)).toEqual({ status: 200, cacheControl: IMMUTABLE, body: complete });
    }
  });

  it("serves an unrecognised or shorter-than-prefix body unchanged with the short header", async () => {
    const complete = await historyBytes(matchInput(id));
    const otherId = new TextEncoder().encode(new TextDecoder().decode(complete).replace(id, "2026-10-20T02-00-00-000Z-17"));
    for (const body of [new TextEncoder().encode("{}"), new Uint8Array(0), otherId]) {
      const get = await serve(new Map([[id, body]]), 3);
      expect(await get(`/matches/${id}`)).toEqual({ status: 200, cacheControl: SHORT, body });
    }
  });
});

describe("GET /matches/<id> is bounded by no progress, not by total time", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
  const id = "2026-10-20T02-00-00-000Z-18";
  const IDLE_MS = 200;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /** Serves one record body from `open`, with the server's responses observable. */
  async function serve(open: () => Readable) {
    const responses: { finished: boolean; closed: Promise<void> }[] = [];
    const source: HistorySource = { async list() { return page(); }, async open() { return open(); } };
    const handler = historyRoutes(source, undefined, { recordIdleMs: IDLE_MS });
    const server = createServer((req, res) => {
      const seen = { finished: false, closed: once(res, "close").then(() => { seen.finished = res.writableFinished; }) };
      responses.push(seen);
      void handler(req, res, undefined as never);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { port: (server.address() as AddressInfo).port, responses };
  }

  it("delivers a large record streamed slowly in full, long past the idle bound in total", async () => {
    const chunk = 64 * 1024, chunks = 48; // 3 MiB
    const record = Buffer.alloc(chunk * chunks);
    for (let at = 0; at < record.length; at++) record[at] = (at * 31 + 7) & 0xff;
    const { port } = await serve(() => Readable.from((async function* () {
      for (let at = 0; at < record.length; at += chunk) { await sleep(IDLE_MS / 4); yield record.subarray(at, at + chunk); }
    })()));
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/matches/${id}`);
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    expect(body.equals(record)).toBe(true);
    expect(elapsed).toBeGreaterThan(IDLE_MS * 10);
  });

  it("ends the wait for a record's opening bytes at the idle bound and releases the upstream record", async () => {
    const upstream = new Readable({ read() {} }); // Opens, then never sends a byte.
    const { port } = await serve(() => upstream);
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/matches/${id}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Match history temporarily unavailable. Please try again." });
    expect(Date.now() - started).toBeLessThan(IDLE_MS * 25);
    expect(upstream.destroyed).toBe(true);
  });

  it("serves a record whose source yields string chunks, byte for byte", async () => {
    const { port } = await serve(() => Readable.from(["{\"id\":", "\"é\"}"]));
    const response = await fetch(`http://127.0.0.1:${port}/matches/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("{\"id\":\"é\"}"));
  });

  it("drops a client that stops reading and releases the upstream record", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20), total = 1024; // 64 MiB, far past any socket buffering
    let sent = 0;
    const upstream = Readable.from((function* () { for (; sent < total; sent++) yield chunk; })());
    const { port, responses } = await serve(() => upstream);
    const client = connect(port, "127.0.0.1");
    client.on("error", () => {});
    close.push(async () => { client.destroy(); });
    await once(client, "connect");
    client.write(`GET /matches/${id} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n`);
    const [first] = await once(client, "data") as [Buffer];
    expect(first.toString("latin1")).toMatch(/^HTTP\/1\.1 200 /);
    client.pause(); // Stalled: takes nothing more.
    const started = Date.now();
    await responses[0]!.closed;
    expect(Date.now() - started).toBeLessThan(IDLE_MS * 25);
    expect(responses[0]!.finished).toBe(false);
    expect(sent).toBeLessThan(total);
    expect(upstream.destroyed).toBe(true);
  });
});
