// The Archive (ported): the pure rules its pages render from. Not rendering or
// visual evidence: captures of the served build are that.
import { describe, expect, it } from "vitest";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG } from "../../../src/sim/config.ts";
import { playable } from "../../playable.ts";
import { ruleSections } from "../../../web/rules.ts";
import { C } from "../../../web/src/leaderboard-page/copy.ts";
import { benchmarkLabel } from "../../../web/src/leaderboard-page/view.ts";
import { RETRY } from "../../../web/src/ui/format.ts";
import type { LiveMatch, Recording } from "../../../web/src/matches-page/data.ts";
import type { RankingView } from "../../../web/src/leaderboard-page/view.ts";
import {
  BOARD_GROUPS, OPENING_MODE, RECORDINGS_LIST, colonyModels, colonySeats, seatModelName, eloText, formMarks, rdText, leaderboardLists, liveKind,
  liveLine, loadedText, loadsSettled, matchesLists, modelName, nameParts, provisional, ranks, recordOf, recordedIdentity, recordingsLine,
  ruleAnchor, ruleGroups, recordedPlayer, seatGroups, stampWord, tableCount, tableState, tableTitle, thinkingText, whenParts, winnerOf, type ListLoad, type LoadsSeen, type PlayerParts,
} from "../../../web/src/pages/model.ts";

const row = (rating: number, ratedMatches = 1) => ({ displayName: `Player ${rating}`, rating, ratedMatches, thinkingLevel: null });

const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG);

describe("Leaderboard", () => {
  it("offers the Antwars Model Index first, opens on its 1v1, and keeps the internal mode ids", () => {
    expect(BOARD_GROUPS.map(group => group.label)).toEqual(["Antwars Model Index", "Ranked"]);
    expect(BOARD_GROUPS[0]!.modes).toEqual(["house-1v1", "house-2v2", "house-3v3", "house-4v4"]);
    expect(BOARD_GROUPS[1]!.modes).toEqual(["1v1", "2v2", "3v3", "4v4"]);
    expect(OPENING_MODE).toBe("house-1v1");
  });
  it("titles each table by its id, never with the old house or benchmark wording", () => {
    expect(tableTitle({ id: "aw-house-mode-ranking", title: "House mode · 1v1" }, "house-1v1")).toBe("Antwars Model Index · 1v1");
    expect(tableTitle({ id: "aw-house-ranking", title: "House models · 2v2" }, "2v2")).toBe("Ranked · 2v2 · house models");
    expect(tableTitle({ id: "aw-everyone-ranking", title: "Everyone · 3v3" }, "3v3")).toBe("Ranked · 3v3");
    expect(tableTitle({ id: "other", title: "Kept" }, "4v4")).toBe("Kept");
    for (const id of ["aw-house-mode-ranking", "aw-house-ranking", "aw-everyone-ranking"]) {
      // "house models" is the set house-only table name; no other house or benchmark wording.
      expect(tableTitle({ id, title: "House" }, "house-4v4").replace(" · house models", "")).not.toMatch(/house|benchmark/i);
    }
  });
  it("ranks by position, highest first, with equal ratings sharing a rank", () => {
    expect(ranks([row(1520), row(1518), row(1518), row(1500), row(1499.6)])).toEqual([1, 2, 2, 4, 5]);
    expect(ranks([])).toEqual([]);
  });
  it("shows a rating and ± its RD in whole points, and marks a rating provisional below 10 rated matches", () => {
    expect(eloText(1519.6)).toBe("1520"); expect(eloText(1500.4)).toBe("1500");
    expect(rdText({ rd: 86.5 })).toBe("± 87"); expect(rdText({ rd: 350 })).toBe("± 350");
    expect(rdText({ rd: null })).toBe(""); expect(rdText({})).toBe("");
    expect(provisional(row(1500, 9))).toBe(true); expect(provisional(row(1500, 10))).toBe(false);
    expect(thinkingText({ thinkingLevel: null })).toBe("(not recorded)"); expect(thinkingText({ thinkingLevel: "high" })).toBe("(high)");
  });
  it("says a table's state only for loading, failure or empty, and its count beside its title", () => {
    const rows = [row(1520), row(1518)];
    expect(tableState({ status: "loading", rows: [] })).toEqual({ glyph: "ring", text: C.tableLoading });
    expect(tableState({ status: "loading", rows })).toEqual({ glyph: "half", text: C.tableLoading });
    expect(tableState({ status: "ready", rows: [] })).toEqual({ glyph: "ring", text: C.tableEmpty });
    expect(tableState({ status: "error", rows: [] })).toEqual({ glyph: "error", text: C.tableFailed });
    expect(tableState({ status: "error", rows })).toEqual({ glyph: "error", text: C.tableFailed });
    // A ready table with rows says nothing editorial: no state line at all, only its count.
    expect(tableState({ status: "ready", rows })).toBeNull();
    expect(tableCount({ rows })).toBe("2 shown"); expect(tableCount({ rows: [] })).toBeNull();
    expect(C).not.toHaveProperty("tablePartial"); expect(C).not.toHaveProperty("tableComplete");
  });
  it("names an antwars-owned row as main does, with its badges, and any other row by its own name and thinking level", () => {
    for (const owned of [
      { displayName: "antwars/claude-opus-5-5", thinkingLevel: "high", serviceTier: null, benchmark: true },
      { displayName: "antwars/gpt-6-1-sol", thinkingLevel: "max", serviceTier: "fast", benchmark: true },
      { displayName: "antwars/not-listed", thinkingLevel: null, serviceTier: null, benchmark: true },
    ]) {
      const label = benchmarkLabel(owned);
      expect(nameParts(owned)).toEqual({ name: label.name, badges: label.badges, quiet: null });
    }
    expect(nameParts({ displayName: "antwars/gpt-6-1-sol", thinkingLevel: "max", serviceTier: "fast", benchmark: true }).badges).toEqual(["max", C.fastBadge]);
    expect(nameParts({ displayName: "Player 1", thinkingLevel: null, serviceTier: "fast", benchmark: false }))
      .toEqual({ name: "Player 1", badges: [], quiet: "(not recorded)" });
    expect(nameParts({ displayName: "Player 2", thinkingLevel: "high" })).toEqual({ name: "Player 2", badges: [], quiet: "(high)" });
  });
  it("shows a record as wins–losses, draws only for a player with any, and nothing without a reconciled record", () => {
    expect(recordOf({ tally: { wins: 8, losses: 4, draws: 0 } })).toBe("8–4");
    expect(recordOf({ tally: { wins: 8, losses: 3, draws: 1 } })).toBe("8–3–1");
    expect(recordOf({ tally: null })).toBe("");
    expect(recordOf({})).toBe("");
  });
  it("keeps Last 5 newest first, each a link to its replay only where one is stored, keeping the page's other parameters", () => {
    const form = [
      { result: "W", replayId: "2026-10-26T10-00-00-000Z-1" }, { result: "L", replayId: null }, { result: "D", replayId: "2026-10-25T09-00-00-000Z-2" },
    ] as const;
    expect(formMarks({ form }, "?page=leaderboard&board=2d")).toEqual([
      { result: "W", label: `${C.resultWords.W}, ${C.watchReplay}`, href: "/?replay=2026-10-26T10-00-00-000Z-1&board=2d" },
      { result: "L", label: C.resultWords.L, href: null },
      { result: "D", label: `${C.resultWords.D}, ${C.watchReplay}`, href: "/?replay=2026-10-25T09-00-00-000Z-2&board=2d" },
    ]);
    expect(formMarks({}, "?board=2d")).toEqual([]);
  });
});

describe("freshness", () => {
  it("formats the load time in UTC", () => {
    expect(loadedText(Date.UTC(2026, 9, 26, 21, 31, 59))).toBe("Loaded 21:31 UTC");
    expect(loadedText(Date.UTC(2026, 9, 26, 3, 4))).toBe("Loaded 03:04 UTC");
  });
  /** Feeds successive views through the freshness rule as a page's update does: `more` is the page's Load more for one
   * list, and each step says whether that view moved the line. */
  const freshness = () => {
    let seen: LoadsSeen = new Map(), continuing: ReadonlySet<string> = new Set();
    return {
      more(id: string) { continuing = new Set([...continuing, id]); },
      step(lists: readonly ListLoad[]) {
        const settled = loadsSettled(seen, lists, continuing);
        seen = settled.seen; continuing = settled.continuing;
        return settled.moved;
      },
      continuing: () => [...continuing],
    };
  };
  it("moves on a table's first load and every successful Refresh, the same rows included, and never on Load more", () => {
    const table: RankingView = { id: "aw-house-mode-ranking", title: "", status: "ready", rows: [row(1520)], next: "c1" };
    const mounted: RankingView = { ...table, status: "loading", rows: [], next: undefined }; // a table as it is mounted
    const page = freshness(), step = (...tables: RankingView[]) => page.step(leaderboardLists(tables));
    // The first load, as leaderboard-page/page.ts mounts its tables: none yet, then loading, then rows.
    expect(step()).toBe(false);
    expect(step(mounted)).toBe(false);
    expect(step(table)).toBe(true);
    expect(step({ ...table, next: "c9" })).toBe(false); // a new cursor alone, with no load
    // Refresh mounts the tables again, and the same rows coming back move the line: that is when the top was read.
    expect(step()).toBe(false);
    expect(step(mounted)).toBe(false);
    expect(step(table)).toBe(true);
    // Load more reads an older page and never the top: the time stays, whether it adds rows or none.
    page.more(table.id);
    expect(step({ ...table, status: "loading" })).toBe(false);
    const longer: RankingView = { ...table, rows: [row(1520), row(1518)], next: "c2" };
    expect(step(longer)).toBe(false); // Load more added a row, and the time stays
    page.more(table.id);
    expect(step({ ...longer, status: "loading" })).toBe(false);
    expect(step({ ...longer, next: "c3" })).toBe(false); // an empty older page: only the cursor changes
    expect(page.continuing()).toEqual([]);
    // A Load more that never starts loading drops out unmoved, so the next Refresh still moves the line.
    page.more(table.id);
    expect(step(longer)).toBe(false);
    expect(page.continuing()).toEqual([]);
    expect(step()).toBe(false);
    expect(step(mounted)).toBe(false);
    expect(step(table)).toBe(true);
    // A failed Load more keeps the rows shown and moves nothing; nor does a failed Refresh.
    page.more(table.id);
    expect(step({ ...table, status: "loading" })).toBe(false);
    expect(step({ ...table, status: "error", next: undefined })).toBe(false);
    expect(page.continuing()).toEqual([]);
    expect(step()).toBe(false);
    expect(step(mounted)).toBe(false);
    expect(step({ ...mounted, status: "error" })).toBe(false);
    // Another board mounts its own tables, and each one's first load moves the line.
    const ranked: RankingView = { ...mounted, id: "aw-house-ranking" }, everyone: RankingView = { ...mounted, id: "aw-everyone-ranking" };
    expect(step()).toBe(false);
    expect(step(ranked, everyone)).toBe(false);
    expect(step({ ...ranked, status: "ready" }, everyone)).toBe(true);
    expect(step({ ...ranked, status: "ready" }, { ...everyone, status: "ready" })).toBe(true);
  });
  it("reads Matches' two lists by their loads, never by Load more or the continuation token", () => {
    const recording: Recording = {
      id: "r1", startedAt: "2026-10-25T11:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0, reason: "queens_killed",
      decidedBy: null, seats: [], status: "complete", unavailable: [],
    };
    type Status = "ready" | "loading" | "error";
    const page = freshness();
    // In matches-page/data.ts order: a Refresh starts Live now, then Recordings; Load more loads Recordings alone.
    const step = (live: Status, recordings: Status, rows: Recording[], next: string | null) =>
      page.step(matchesLists({ waiting: { status: "ready", rows: [] }, live: { status: live, rows: [] }, recordings: { status: recordings, rows }, next }));
    expect(step("loading", "loading", [], null)).toBe(false);
    expect(step("ready", "loading", [], null)).toBe(true); // Live now's first load
    expect(step("ready", "ready", [], "t1")).toBe(true); // the first Recordings page: empty, more to come
    page.more(RECORDINGS_LIST);
    expect(step("ready", "loading", [], "t1")).toBe(false);
    expect(step("ready", "ready", [recording], "t2")).toBe(false); // Load more added a recording, and the time stays
    page.more(RECORDINGS_LIST);
    expect(step("ready", "loading", [recording], "t2")).toBe(false);
    expect(step("ready", "ready", [recording], "t3")).toBe(false); // an empty older page: only a new token
    // A Refresh that brings back the same recordings moves the line, even with Live now failing.
    expect(step("loading", "ready", [recording], "t3")).toBe(false);
    expect(step("loading", "loading", [recording], "t3")).toBe(false);
    expect(step("error", "loading", [recording], "t3")).toBe(false);
    expect(step("error", "ready", [recording], "t3")).toBe(true);
    // A failed Refresh keeps the rows shown and moves nothing.
    expect(step("loading", "loading", [recording], "t3")).toBe(false);
    expect(step("error", "error", [recording], "t3")).toBe(false);
  });
});

describe("Matches", () => {
  it("names a live match's kind for its Watch link", () => {
    expect(liveKind({ rated: true })).toBe("Rated match");
    expect(liveKind({ rated: false })).toBe("Unrated match");
  });
  it("says each list's state in its own card, a failure with how it recovers", () => {
    expect(liveLine({ live: { status: "ready", rows: [] } })).toEqual({ glyph: "ring", text: "No public match in the catalog right now" });
    expect(liveLine({ live: { status: "error", rows: [] } })).toEqual({ glyph: "error", text: `Live list unavailable. ${RETRY}` });
    const stale: LiveMatch = { lobbyId: "a", startedAt: 0, rated: true, delaySeconds: 60, colonies: [[], []] };
    expect(liveLine({ live: { status: "error", rows: [stale] } }).text).toBe(`Live list unavailable · showing the last list loaded. ${RETRY}`);
    expect(recordingsLine({ recordings: { status: "ready", rows: [] }, next: "token" }, 0)).toEqual({ glyph: "half", text: "None in the pages loaded so far · more remain" });
    expect(recordingsLine({ recordings: { status: "ready", rows: [] }, next: null }, 3)).toEqual({ glyph: "dot", text: "All 3 recordings, newest first" });
    expect(recordingsLine({ recordings: { status: "loading", rows: [] }, next: null }, 3).glyph).toBe("half");
    expect(recordingsLine({ recordings: { status: "loading", rows: [] }, next: null }, 0).glyph).toBe("ring");
    expect(recordingsLine({ recordings: { status: "error", rows: [] }, next: "t" }, 3).text).toBe(`Recordings unavailable · 3 recordings loaded before the error. ${RETRY}`);
  });
  it("sets a start on two lines and keeps an unknown start whole", () => {
    expect(whenParts("25 Oct 2026 · 11:00 UTC")).toEqual({ date: "25 Oct 2026", time: "11:00 UTC" });
    expect(whenParts("Start unknown")).toEqual({ date: "Start unknown", time: null });
  });
  it("puts each colony's recorded models in its own column, in seat order, unknown never invented", () => {
    const seat = (seat: number, colony: 0 | 1, modelLabel: string | null) => ({ seat, colony, modelLabel, thinkingLevel: null, serviceTier: null, handle: null });
    const names = (list: ReturnType<typeof colonyModels>) => list?.map(colony => colony?.map(model => model.name) ?? null) ?? null;
    expect(names(colonyModels([seat(1, 1, "b"), seat(2, 0, "c"), seat(0, 0, "a")]))).toEqual([["a", "c"], ["b"]]);
    expect(names(colonyModels([seat(0, 0, null)]))).toEqual([["model unknown"], null]);
    expect(colonyModels([])).toBeNull();
  });
  it("names a builder seat that reported no model by its handle, and keeps unlabelled players with different handles apart", () => {
    const seat = (seat: number, modelLabel: string | null, handle: string | null) => ({ seat, colony: 0 as const, modelLabel, thinkingLevel: null, serviceTier: null, handle });
    expect(recordedIdentity(seat(0, null, "omp-dolphin"))).toEqual({ name: "omp-dolphin", badges: [], quiet: null });
    // A reported model wins over the handle; a house handle keeps its own row's name.
    expect(recordedIdentity(seat(0, "openai/gpt-6.1-terra", "kestrel-harness")).name).toBe("GPT-6.1 Terra");
    expect(recordedIdentity(seat(0, "coffee-ant/local", "coffee-ant")).name).toBe("local");
    // Recordings names a label whose provider part is the seat's own handle by that handle; the HUD keeps the model's words.
    expect(recordedIdentity(seat(0, "coffee-ant/local", "coffee-ant"), { listed: true }).name).toBe("coffee-ant");
    // The Matches lists draw a builder's username, then the model it named; the model is left out where the label only
    // repeats the username, and a house handle has no username.
    const shown = (parts: PlayerParts) => [parts.user, parts.model].filter(word => word !== null).join(" ");
    expect(colonySeats([seat(0, "coffee-ant/local", "coffee-ant"), seat(1, "coffee-ant/local", "kite")])!.map(c => c?.map(e => shown(e.parts)) ?? null))
      .toEqual([["coffee-ant", "kite local"], null]);
    expect(recordedPlayer(seat(0, "openai/gpt-6.1-sol", "antwars/gpt-6-1-sol"))).toMatchObject({ user: null, model: "GPT-6.1 Sol" });
    expect(recordedPlayer(seat(0, null, "omp-dolphin"))).toEqual({ user: "omp-dolphin", model: null, badges: [] });
    expect(recordedPlayer({ ...seat(0, "openai/gpt-6.1-terra", "kain"), thinkingLevel: "high", serviceTier: "fast" }))
      .toEqual({ user: "kain", model: "GPT-6.1 Terra", badges: ["high", "Fast"] });
    // A builder that named no model shows no level or Fast, whatever it recorded.
    expect(recordedPlayer({ ...seat(0, null, "kain"), thinkingLevel: "high" }).badges).toEqual([]);
    expect(recordedPlayer(seat(0, null, null))).toEqual({ user: null, model: "model unknown", badges: [] });
    // Only an exact provider part before the first "/" counts; every other label keeps modelName's words.
    expect(seatModelName("coffee-ant/local", "coffee-ant")).toBe("coffee-ant");
    expect(seatModelName("coffee-ant/local", "Coffee-Ant")).toBe("local");
    expect(seatModelName("coffee-ant/local", "coffee")).toBe("local");
    expect(seatModelName("coffee-ant/local", null)).toBe("local");
    expect(seatModelName("coffee-ant", "coffee-ant")).toBe("coffee-ant");
    expect(seatModelName("local", "coffee-ant")).toBe("local");
    expect(seatModelName("openai/gpt-6.1-terra", "openai")).toBe("openai");
    expect(seatModelName("openai/gpt-6.1-terra", "kestrel-harness")).toBe("GPT-6.1 Terra");
    expect(recordedIdentity(seat(0, "openai/gpt-6.1-sol", "antwars/gpt-6-1-sol")).name).toBe("GPT-6.1 Sol");
    const groups = colonySeats([seat(0, null, "omp-dolphin"), seat(1, null, "coffeebot-ant"), seat(2, null, "omp-dolphin")])![0]!;
    expect(seatGroups(groups)).toEqual([{ parts: { user: "omp-dolphin", model: null, badges: [] }, seats: 2 }, { parts: { user: "coffeebot-ant", model: null, badges: [] }, seats: 1 }]);
    // Seats group only where they show alike and are one player: one username and one label.
    const named = (list: Recording["seats"]) => seatGroups(colonySeats(list)![0]!).map(group => [shown(group.parts), group.seats]);
    expect(named([seat(0, "coffee-ant/local", "kite"), seat(1, "coffee-ant/local", "coffee-ant")])).toEqual([["kite local", 1], ["coffee-ant", 1]]);
    expect(named([seat(0, "coffee-ant/local", "kite"), seat(1, "coffee-ant/local", "wren")])).toEqual([["kite local", 1], ["wren local", 1]]);
    expect(named([seat(0, "coffee-ant/local", "kite"), seat(1, "coffee-ant/local", "kite")])).toEqual([["kite local", 2]]);
    expect(named([seat(0, "coffee-ant/local", "coffee-ant"), seat(1, "coffee-ant/local", "coffee-ant")])).toEqual([["coffee-ant", 2]]);
    // A handle never joins a model label that reads the same, however the label is spelled.
    expect(seatGroups(colonySeats([seat(0, null, "local"), seat(1, "local", "kite")])![0]!)).toHaveLength(2);
    for (const label of ["@omp-dolphin", "handle:omp-dolphin", "model:omp-dolphin"]) {
      expect(seatGroups(colonySeats([seat(0, null, "omp-dolphin"), seat(1, label, "kite")])![0]!).map(group => group.seats)).toEqual([1, 1]);
    }
    // A recording carries each seat's start rating where its record stores one; seats that differ in it keep their own lines.
    const start = { rating: 1540, rd: 80, ratedMatches: 12 };
    const rated = seatGroups(colonySeats([{ ...seat(0, null, "kite"), startRating: start }, { ...seat(1, null, "kite"), startRating: start },
      { ...seat(2, null, "kite"), startRating: { ...start, rating: 1541 } }, seat(3, null, "kite")])![0]!);
    expect(rated.map(group => [group.seats, group.rating?.rating ?? null])).toEqual([[2, 1540], [1, 1541], [1, null]]);
  });
  it("lists a colony's alike seats once with how many they are, in first-seat order, and keeps every seat that differs", () => {
    const opus = { name: "Claude Opus 5.5", badges: ["high"], quiet: null }, sol = { name: "GPT-6.1 Sol", badges: ["max", "Fast"], quiet: null };
    const OPUS = "anthropic/claude-opus-5-5", SOL = "openai/gpt-6.1-sol";
    const seat = (who: string | null, parts: typeof opus) => ({ who, parts });
    expect(seatGroups([seat(OPUS, opus), seat(OPUS, opus), seat(OPUS, opus), seat(OPUS, opus)])).toEqual([{ parts: opus, seats: 4 }]);
    // The same model with other badges, or none, is another seat; the order is each one's first seat.
    const solHigh = { ...sol, badges: ["high", "Fast"] }, bare = { ...sol, badges: [] };
    expect(seatGroups([seat(SOL, sol), seat(SOL, solHigh), seat(SOL, sol), seat(SOL, bare), seat(OPUS, opus)]))
      .toEqual([{ parts: sol, seats: 2 }, { parts: solHigh, seats: 1 }, { parts: bare, seats: 1 }, { parts: opus, seats: 1 }]);
    // Badge order counts as the badges read.
    expect(seatGroups([seat(SOL, { ...sol, badges: ["Fast", "max"] }), seat(SOL, sol)])).toHaveLength(2);
    // Two recorded labels shown by one name stay apart: the records tell them apart. Seats that recorded no model are alike.
    expect(seatGroups([seat(SOL, sol), seat("openrouter/gpt-6.1-sol", sol), seat(SOL, sol)])).toEqual([{ parts: sol, seats: 2 }, { parts: sol, seats: 1 }]);
    const unknown = { name: "model unknown", badges: [], quiet: null };
    expect(seatGroups([seat(null, unknown), seat(null, unknown)])).toEqual([{ parts: unknown, seats: 2 }]);
    // Several seats show as their group's form, a seat alone as itself: a live identity keeps its seat number alone.
    const kay = { name: "kite", badges: [], quiet: null }, numbered = (n: number) => ({ who: "kite", parts: { ...kay, name: `kite #${n}` }, alike: kay });
    expect(seatGroups([numbered(1), numbered(3)])).toEqual([{ parts: kay, seats: 2 }]);
    expect(seatGroups([numbered(2)])).toEqual([{ parts: { ...kay, name: "kite #2" }, seats: 1 }]);
    expect(seatGroups([])).toEqual([]);
  });
  it("names each recorded model as the Leaderboard does, from house.ts's table", () => {
    expect(modelName("anthropic/claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("moonshot/k3.1-pro-highspeed")).toBe("K3.1 Pro Highspeed");
    expect(modelName("openai/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelName("google/gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelName("zai/glm-5.3")).toBe("GLM-5.3");
    // A Muse row names muse only for a label from muse; the same model from any other provider is named without one.
    expect(modelName("muse/muse-spark-1.3")).toBe("Muse Spark 1.3 · muse");
    expect(modelName("muse/muse-wonder-full-1.0")).toBe("Muse Wonder Full 1.0 · muse");
    expect(modelName("other-provider/muse-spark-1.3")).toBe("Muse Spark 1.3");
    expect(modelName("other-provider/muse-wonder-1.0")).toBe("Muse Wonder 1.0");
    expect(modelName("muse-wonder-full-1.0")).toBe("Muse Wonder Full 1.0");
    expect(modelName("provider/some-model.2")).toBe("some-model.2");
    expect(modelName("provider/constructor")).toBe("constructor");
    expect(modelName("bare-model")).toBe("bare-model");
    expect(modelName("local/")).toBe("local/");
    expect(modelName("local/ ")).toBe("local/ ");
    expect(modelName("local/\u3000")).toBe("local/\u3000");
    const seat = (seat: number, colony: 0 | 1, modelLabel: string | null) => ({ seat, colony, modelLabel, thinkingLevel: null, serviceTier: null, handle: null });
    expect(colonyModels([seat(0, 0, "anthropic/claude-opus-5-5"), seat(1, 0, null), seat(0, 1, "moonshot/k3.1-pro-highspeed")])?.map(colony => colony?.map(model => model.name)))
      .toEqual([["Claude Opus 5.5", "model unknown"], ["K3.1 Pro Highspeed"]]);
  });
  it("badges each seat with the thinking level it recorded and Fast only for a recorded fast tier, nothing from the model", () => {
    const identity = (modelLabel: string | null, thinkingLevel: string | null = null, serviceTier: string | null = null) =>
      recordedIdentity({ modelLabel, thinkingLevel, serviceTier, handle: null });
    // The house table lists GPT-6.1 Sol as max/fast; the seat recorded xhigh and no tier.
    expect(identity("openai/gpt-6.1-sol", "xhigh")).toEqual({ name: "GPT-6.1 Sol", badges: ["xhigh"], quiet: null });
    expect(identity("openai/gpt-6.1-sol", "high", "fast")).toEqual({ name: "GPT-6.1 Sol", badges: ["high", "Fast"], quiet: null });
    expect(identity("openai/gpt-6.1-sol", null, "FAST")).toEqual({ name: "GPT-6.1 Sol", badges: ["Fast"], quiet: null });
    expect(identity("openai/gpt-6.1-sol", "max", "default")).toEqual({ name: "GPT-6.1 Sol", badges: ["max"], quiet: null });
    // A seat that recorded neither, as every recording before 2026-10-25T23:22Z did, has no badges.
    expect(identity("openai/gpt-6.1-sol")).toEqual({ name: "GPT-6.1 Sol", badges: [], quiet: null });
    expect(identity("anthropic/claude-opus-5-5", "xhigh")).toEqual({ name: "Claude Opus 5.5", badges: ["xhigh"], quiet: null });
    expect(identity("provider/some-model.2", "low")).toEqual({ name: "some-model.2", badges: ["low"], quiet: null });
    expect(identity(null)).toEqual({ name: "model unknown", badges: [], quiet: null });
    expect(identity(null, "medium")).toEqual({ name: "model unknown", badges: ["medium"], quiet: null });
    // colonyModels reads each seat's own record: two seats of one model keep their own badges.
    expect(colonyModels([
      { seat: 0, colony: 0, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: "xhigh", serviceTier: null, handle: null },
      { seat: 1, colony: 0, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: "high", serviceTier: "fast", handle: null },
      { seat: 0, colony: 1, modelLabel: "openai/gpt-6.1-sol", thinkingLevel: null, serviceTier: null, handle: null },
    ])?.map(colony => colony?.map(model => model.badges))).toEqual([[["xhigh"], ["high", "Fast"]], [[]]]);
  });
  it("takes a missing level and the tier from a listed house handle, the recorded level winning, never from the model", () => {
    const identity = (handle: string | null, thinkingLevel: string | null = null, serviceTier: string | null = null, modelLabel: string | null = "openai/gpt-6.1-sol") =>
      recordedIdentity({ modelLabel, thinkingLevel, serviceTier, handle });
    // antwars/gpt-6-1-sol-xhigh is fixed xhigh/standard: its seat recorded no level, so it shows xhigh, and no Fast.
    expect(identity("antwars/gpt-6-1-sol-xhigh")).toEqual({ name: "GPT-6.1 Sol", badges: ["xhigh"], quiet: null });
    // The recorded level wins over the handle's fixed level; the handle's fixed tier wins over the recorded tier.
    expect(identity("antwars/gpt-6-1-sol-xhigh", "high", "fast")).toEqual({ name: "GPT-6.1 Sol", badges: ["high"], quiet: null });
    expect(identity("antwars/gpt-6-1-sol-high-fast", null, "standard")).toEqual({ name: "GPT-6.1 Sol", badges: ["high", "Fast"], quiet: null });
    expect(identity("ANTWARS/GPT-6-1-SOL-HIGH-FAST", "xhigh")).toEqual({ name: "GPT-6.1 Sol", badges: ["xhigh", "Fast"], quiet: null });
    // A listed handle with no fixed level or tier takes its badges from the record, and its name from its own row.
    expect(identity("antwars/glm-5-3-highspeed", "low", "fast", "zai/glm-5.3")).toEqual({ name: "GLM-5.3 Highspeed", badges: ["low", "Fast"], quiet: null });
    // An unlisted house handle shows "Unlisted model" with no badges, whatever its model label.
    expect(identity("antwars/not-listed", null, "fast")).toEqual({ name: "Unlisted model", badges: [], quiet: null });
    // Another owner's handle is named by its model label.
    expect(identity("alice/gpt-6-1-sol-high-fast")).toEqual({ name: "GPT-6.1 Sol", badges: [], quiet: null });
    // A house handle is named by its own row, so a handle whose model id differs from it still shows its name.
    expect(identity("antwars/abliterated-large-v2", null, null, "abliteration/abliterated-model-large-v2")).toEqual({ name: "Abliterated GLM-5.3", badges: ["max"], quiet: null });
    expect(identity("antwars/gpt-6-1-terra-max-fast", null, null, "openai/gpt-6.1-terra")).toEqual({ name: "GPT-6.1 Terra", badges: ["max", "Fast"], quiet: null });
  });
  it("names a seat recorded as openai/gpt-6.1-terra \"GPT-6.1 Terra\", with only its recorded badges", () => {
    expect(modelName("openai/gpt-6.1-terra")).toBe("GPT-6.1 Terra");
    expect(recordedIdentity({ modelLabel: "openai/gpt-6.1-terra", thinkingLevel: null, serviceTier: null, handle: null })).toEqual({ name: "GPT-6.1 Terra", badges: [], quiet: null });
    expect(recordedIdentity({ modelLabel: "openai/gpt-6.1-terra", thinkingLevel: "high", serviceTier: null, handle: null })).toEqual({ name: "GPT-6.1 Terra", badges: ["high"], quiet: null });
  });
  it("words the record stamp as the record's and colours a winner only where the record names one", () => {
    expect((["complete", "partial", "unavailable"] as const).map(stampWord)).toEqual(["complete", "partial", "unavailable"]);
    const result = (winner: Recording["winner"], reason: string | null) => winnerOf({ winner, reason });
    expect(result(0, "queens_killed")).toBe(0); expect(result(1, "abandoned")).toBeNull(); expect(result(null, "time_up")).toBeNull();
  });
});

describe("links and Rules", () => {
  it("groups every section exactly once, in the helpers' order, under Start here and Reference", () => {
    const sections = ruleSections(PUBLIC_CONFIG);
    const { start, reference } = ruleGroups(sections);
    expect(start.map(section => section.title)).toEqual(["How to win", "Overview", "Winning"].filter(title => sections.some(section => section.title === title)));
    expect([...start, ...reference].map(section => section.title).sort()).toEqual(sections.map(section => section.title).sort());
    expect(reference.map(section => section.title)).toEqual(sections.map(section => section.title).filter(title => !start.some(section => section.title === title)));
    for (const group of [start, reference]) for (const section of group) expect(section.lines).toBe(sections.find(entry => entry.title === section.title)!.lines);
    const anchors = sections.map(section => ruleAnchor(section.title));
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(ruleAnchor("Food and hatching")).toBe("d1-food-and-hatching");
  });
});
