// The Archive (ported to the live pages): the pure rules its three pages share. No DOM, no
// requests, no clock: callers pass the time. Every word shown is the app's own (leaderboard-page/copy.ts, ui/format.ts),
// fixed page copy, or proposed copy marked ‡.
import type { FormLetter, LeaderboardMode, LeaderboardRow } from "../leaderboard.ts";
import type { LiveMatch, MatchesView, Recording } from "../matches-page/data.ts";
import { HOUSE_USERNAME } from "../../../src/identity/houseOwnership.ts";
import { UNLISTED_MODEL, houseDisplayName, houseLabel, houseModelEntry } from "../../../src/rating/houseLabels.ts";
import { C } from "../leaderboard-page/copy.ts";
import { LEADERBOARD_HREF } from "../leaderboard-page/route.ts";
import { benchmarkLabel, recordText, type RankingView } from "../leaderboard-page/view.ts";
import { RECORD_LABEL, RETRY, keep, liveState, recordingsState, type SectionState } from "../ui/format.ts";

// ---------------------------------------------------------------- shared

/** A list's state, said once inside its own card: a glyph (decorative) and the words that carry it. */
export type Glyph = "dot" | "half" | "ring" | "error";
export interface CardState { readonly glyph: Glyph; readonly text: string }

/** The freshness line, from this browser's clock when the top of the lists was last read (proposed copy ‡). */
export function loadedText(at: number): string {
  const d = new Date(at);
  return `Loaded ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** A list as the freshness line reads it: which list and its load state; never its rows or its continuation cursor. */
export interface ListLoad { readonly id: string; readonly status: "loading" | "ready" | "error" }
/** What the freshness line keeps of each list on the page: whether a load is in flight. */
export type LoadsSeen = ReadonlyMap<string, boolean>;

/** The freshness line says when the top of the lists was last read. It moves
 * when a list's first load or a Refresh succeeds, the same rows included: a list that was loading, or is new to the page,
 * stands ready. `continuing` names the lists whose load is the page's Load more, which reads an older page and never
 * moves the line, whether or not it adds rows. Loading, a failure and a new cursor alone move nothing. Returns whether the
 * line moves, each present list's loading state, and the Load more lists still loading: one that settles, never starts
 * loading or leaves the page drops out. */
export function loadsSettled(seen: LoadsSeen, lists: readonly ListLoad[], continuing: ReadonlySet<string>): {
  readonly moved: boolean; readonly seen: LoadsSeen; readonly continuing: ReadonlySet<string>;
} {
  const loading = new Map<string, boolean>();
  const still = new Set<string>();
  let moved = false;
  for (const list of lists) {
    const before = seen.get(list.id);
    loading.set(list.id, list.status === "loading");
    if (list.status === "loading") { if (continuing.has(list.id)) still.add(list.id); continue; }
    if (list.status === "ready" && before !== false && !continuing.has(list.id)) moved = true;
  }
  return { moved, seen: loading, continuing: still };
}

// ---------------------------------------------------------------- leaderboard

export const SIZES = ["1v1", "2v2", "3v3", "4v4"] as const;
export type Size = typeof SIZES[number];

/** The board choice, the Antwars Model Index first; the internal house-* mode ids stay. */
export const BOARD_GROUPS: readonly { readonly label: string; readonly modes: readonly LeaderboardMode[] }[] = [
  { label: "Antwars Model Index", modes: SIZES.map(size => `house-${size}` as const) },
  { label: "Ranked", modes: SIZES },
];
/** The page opens here. */
export const OPENING_MODE: LeaderboardMode = "house-1v1";

export const sizeOf = (mode: LeaderboardMode): Size => mode.replace(/^house-/, "") as Size;

/** Where the challenge buttons go (the front page's and the Leaderboard's, and the empty Waiting card's): the Leaderboard's
 * Antwars Model Index 1v1 board. */
export const CHALLENGE_HREF = `${LEADERBOARD_HREF}&mode=house-1v1`;

/** Each table's title by its stable id, in the settled names: the ranked ladder is "Ranked" for every
 * entry, with the house-only table "Ranked · NvN · house models". */
export function tableTitle(table: Pick<RankingView, "id" | "title">, mode: LeaderboardMode): string {
  const size = sizeOf(mode);
  if (table.id === "aw-house-mode-ranking") return `Antwars Model Index · ${size}`;
  if (table.id === "aw-house-ranking") return `Ranked · ${size} · house models`;
  if (table.id === "aw-everyone-ranking") return `Ranked · ${size}`;
  return table.title;
}

/** Rank by position in the highest-first list, equal ratings sharing a rank (1, 2, 2, 4): derived, never stored. */
export function ranks(rows: readonly Pick<LeaderboardRow, "rating">[]): number[] {
  const out: number[] = [];
  rows.forEach((row, index) => out.push(index > 0 && row.rating === rows[index - 1]!.rating ? out[index - 1]! : index + 1));
  return out;
}

/** A rating in whole points. */
export const eloText = (rating: number): string => String(Math.round(rating));

/** The rating deviation after a rating, "± 87" in whole points (Glicko-1); empty for a historical row without one. */
export const rdText = (row: Pick<LeaderboardRow, "rd">): string => typeof row.rd === "number" ? `± ${Math.round(row.rd)}` : "";

/** Derived from rated matches only, not from RD (the word "provisional"). The word follows the rating, plain, with no
 * note (it replaced the "?" mark, which main never had). */
export const PROVISIONAL_BELOW = 10;
export const PROVISIONAL_WORD = "provisional";
export const provisional = (row: Pick<LeaderboardRow, "ratedMatches">): boolean => row.ratedMatches < PROVISIONAL_BELOW;

/** The thinking level after a name, as the earlier table wrote it. */
export const thinkingText = (row: Pick<LeaderboardRow, "thinkingLevel">): string => `(${row.thinkingLevel ?? C.thinkingNotRecorded})`;

/** A row's name, following main: an antwars-owned row shows its display name with a level badge and a Fast
 * badge where fast (leaderboard-page/view.ts benchmarkLabel); every other row its own name, thinking level quiet after. */
export interface NameParts { readonly name: string; readonly badges: readonly string[]; readonly quiet: string | null }
export function nameParts(row: Pick<LeaderboardRow, "displayName" | "thinkingLevel" | "serviceTier" | "benchmark">): NameParts {
  if (row.benchmark !== true) return { name: row.displayName, badges: [], quiet: thinkingText(row) };
  const label = benchmarkLabel(row);
  // An unlisted handle shows UNLISTED_MODEL with no level or tier badges, whatever the row reports.
  return { name: label.name, badges: label.name === UNLISTED_MODEL ? [] : label.badges, quiet: null };
}

/** Record, following main: wins–losses, draws only for a player with any; empty without a reconciled record. */
export const recordOf = (row: Pick<LeaderboardRow, "tally">): string => recordText(row.tally ?? null);

/** Last 5, following main: newest first; each a link to its replay when one is stored, plain otherwise. */
export interface FormMark { readonly result: FormLetter["result"]; readonly label: string; readonly href: string | null }
export function formMarks(row: Pick<LeaderboardRow, "form">, search: string): FormMark[] {
  return (row.form ?? []).map(({ result, replayId }) => replayId === null
    ? { result, label: C.resultWords[result], href: null }
    : { result, label: `${C.resultWords[result]}, ${C.watchReplay}`, href: keep(`/?replay=${encodeURIComponent(replayId)}`, search) });
}

/** One table's state, said once, only where it has one to say: loading, failed or empty, in the copy's words in full.
 * A ready table with rows has no state line; its count stands beside its title (tableCount; no editorial copy). */
export function tableState(table: Pick<RankingView, "status" | "rows">): CardState | null {
  const has = table.rows.length > 0;
  if (table.status === "loading") return { glyph: has ? "half" : "ring", text: C.tableLoading };
  if (table.status === "error") return { glyph: "error", text: C.tableFailed };
  return has ? null : { glyph: "ring", text: C.tableEmpty };
}

/** How many rows a table shows, said beside its title ("30 shown"); none for a table without rows. */
export const tableCount = (table: Pick<RankingView, "rows">): string | null =>
  table.rows.length > 0 ? `${table.rows.length} shown` : null;

/** Each table as the freshness line reads it, by its id: a table's Load more names that id. */
export const leaderboardLists = (tables: readonly RankingView[]): ListLoad[] =>
  tables.map(table => ({ id: table.id, status: table.status }));

// ---------------------------------------------------------------- matches

/** A card's state line from ui/format.ts's words; a failure says how it recovers, as the page line did. */
export function sectionLine(state: SectionState, rows: number): CardState {
  if (state.tone === "error") return { glyph: "error", text: `${state.text}. ${RETRY}` };
  if (state.tone === "complete") return { glyph: "dot", text: state.text };
  if (state.tone === "partial") return { glyph: "half", text: state.text };
  return { glyph: state.tone === "loading" && rows > 0 ? "half" : "ring", text: state.text };
}
export const liveLine = (view: Pick<MatchesView, "live">): CardState => sectionLine(liveState(view), view.live.rows.length);
export const recordingsLine = (view: Pick<MatchesView, "recordings" | "next">, shown: number): CardState => sectionLine(recordingsState(view, shown), shown);

/** A live match's kind, as its Watch link names it; Live now shows no delay or lobby. */
export const liveKind = (match: Pick<LiveMatch, "rated">): string => match.rated ? "Rated match" : "Unrated match";

/** A recorded start as its date and its time, from ui/format.ts utcStamp's "25 Oct 2026 · 11:00 UTC". */
export function whenParts(when: string): { date: string; time: string | null } {
  const at = when.lastIndexOf(" · ");
  return at < 0 ? { date: when, time: null } : { date: when.slice(0, at), time: when.slice(at + 3) };
}

/** A recorded "<provider>/<model id>" label as the Leaderboard names that model: its src/rating/houseLabels.ts
 * HOUSE_LABELS row by model label (houseModelEntry), else the label after its provider prefix. A builder's self-reported
 * model keeps its own words: UNLISTED_MODEL is for house seats only,
 * named by their antwars/ handle (recordedIdentity, houseDisplayName). */
export function modelName(label: string): string {
  return houseModelEntry(label)?.displayName ?? label.slice(label.indexOf("/") + 1);
}

/** A seat's reported label as Recordings and Live now name it: the seat's own handle where the label's part before its
 * first "/" is exactly that handle ("coffee-ant/local" on coffee-ant is "coffee-ant"), else modelName. */
export function seatModelName(label: string, handle: string | null): string {
  const slash = label.indexOf("/");
  return handle !== null && slash >= 0 && label.slice(0, slash) === handle ? handle : modelName(label);
}

const isHouseHandle = (handle: string): boolean => handle.toLowerCase().startsWith(`${HOUSE_USERNAME}/`);

/** A recorded seat as Recordings shows it, and the HUD's model line: a house handle's own HOUSE_LABELS
 * name (houseDisplayName), else its model's name as the Leaderboard names it (modelName), else, where the seat reported no
 * model, its handle ("model unknown" only for a seat that recorded neither); badges (benchmarkLabel) from the seat's own record and its recorded handle: the level it recorded, else a
 * listed house handle's fixed level; a listed house handle's fixed tier, else the tier it recorded; Fast only where that
 * tier is fast. A seat shown as UNLISTED_MODEL has no badges. No rating:
 * a recording carries none. Recordings (listed) names a label that starts with the seat's own handle by that handle
 * (seatModelName); the HUD keeps modelName. */
export function recordedIdentity(seat: Pick<Recording["seats"][number], "modelLabel" | "thinkingLevel" | "serviceTier" | "handle">,
  options: { readonly listed?: boolean } = {}): NameParts {
  const house = seat.handle !== null && isHouseHandle(seat.handle);
  const label = (text: string) => options.listed ? seatModelName(text, seat.handle) : modelName(text);
  const name = house ? houseDisplayName(seat.handle!) : seat.modelLabel !== null ? label(seat.modelLabel) : seat.handle ?? "model unknown";
  if (name === UNLISTED_MODEL) return { name, badges: [], quiet: null };
  const fixed = seat.handle === null ? { thinkingLevel: null, serviceTier: null } : houseLabel(seat.handle);
  const badges = benchmarkLabel({ displayName: "", thinkingLevel: seat.thinkingLevel ?? fixed.thinkingLevel, serviceTier: fixed.serviceTier ?? seat.serviceTier }).badges;
  return { name, badges, quiet: null };
}

/** Who holds a recorded seat, as seatGroups keys it: its model label, else its handle, each tagged with its kind so a label
 * never reads as a handle that spells the same; null where it recorded neither. */
const seatWho = (seat: Pick<Recording["seats"][number], "modelLabel" | "handle">): string | null =>
  seat.modelLabel !== null ? `model:${seat.modelLabel}` : seat.handle !== null ? `handle:${seat.handle}` : null;

/** Each colony's recorded seats, seat order, each with who holds it (seatWho, so two unlabelled players never group as one)
 * and how it shows (recordedIdentity); a
 * colony with no recorded seat null; null when no seat was recorded. */
export function colonySeats(seats: Recording["seats"]): readonly [readonly SeatEntry[] | null, readonly SeatEntry[] | null] | null {
  if (seats.length === 0) return null;
  const entries = (colony: 0 | 1) => {
    const list = seats.filter(seat => seat.colony === colony).sort((a, b) => a.seat - b.seat)
      .map((seat): SeatEntry => {
        // Shown by its own handle (seatModelName), a seat groups only with seats shown alike: its label alone no longer says how it
        // shows. That key is a JSON pair, which no "model:"/"handle:" key (seatWho) can spell.
        const parts = recordedIdentity(seat, { listed: true }), who = seatWho(seat);
        return { who: parts.name === recordedIdentity(seat).name ? who : JSON.stringify([who, parts.name]), parts };
      });
    return list.length ? list : null;
  };
  return [entries(0), entries(1)];
}

/** Each colony's recorded models, seat order; a colony with no recorded seat null; null when no seat was recorded. */
export function colonyModels(seats: Recording["seats"]): readonly [readonly NameParts[] | null, readonly NameParts[] | null] | null {
  const colonies = colonySeats(seats);
  return colonies && [colonies[0]?.map(seat => seat.parts) ?? null, colonies[1]?.map(seat => seat.parts) ?? null];
}

/** One seat as both Matches lists group it: who holds it (seatWho for a recorded seat, or a live
 * player's identity without its seat number), how it shows alone, and, where that differs, how its group shows. */
export interface SeatEntry { readonly who: string | null; readonly parts: NameParts; readonly alike?: NameParts }
/** Seats shown alike, and how many they are. */
export interface SeatGroup { readonly parts: NameParts; readonly seats: number }
/** A colony's seats as both Matches lists show them: the seats of one identity with the same badges once, with how
 * many they are, in the order each first sits. Seats that differ in identity or badges each keep their own entry, even where
 * two identities show one name (two providers' labels for one model), so no group joins seats their records tell apart. A
 * seat alone shows as itself. */
export function seatGroups(seats: readonly SeatEntry[]): SeatGroup[] {
  const groups = new Map<string, { first: SeatEntry; seats: number }>();
  for (const seat of seats) {
    const key = JSON.stringify([seat.who, seat.parts.badges, seat.parts.quiet]);
    const group = groups.get(key);
    if (group) group.seats++;
    else groups.set(key, { first: seat, seats: 1 });
  }
  return [...groups.values()].map(({ first, seats }) => ({ parts: seats > 1 ? first.alike ?? first.parts : first.parts, seats }));
}

/** The record stamp's word, the record's own (ui/format.ts RECORD_LABEL without "Record"). */
export const stampWord = (status: Recording["status"]): string => RECORD_LABEL[status].replace(/^Record /, "");

/** A winner shown in its colony's ink only where the record names one and the match was not abandoned. */
export const winnerOf = (r: Pick<Recording, "winner" | "reason">): 0 | 1 | null => r.reason === "abandoned" ? null : r.winner;

/** The list Matches' Load more continues. */
export const RECORDINGS_LIST = "recordings";
/** Live now and Recordings as the freshness line reads them. */
export const matchesLists = (view: MatchesView): ListLoad[] => [
  { id: "live", status: view.live.status },
  { id: RECORDINGS_LIST, status: view.recordings.status },
];

// ---------------------------------------------------------------- rules

/** "Start here" and "Reference"; the helpers' order and words stay. */
export const START_HERE = ["How to win", "Overview", "Winning"] as const;
export interface RuleSection { readonly title: string; readonly lines: readonly string[] }
/** The Rules page's data: exactly web/rules.ts ruleSections for the current match or the configured defaults. */
export interface RulesView { readonly sections: readonly RuleSection[] }
export function ruleGroups(sections: readonly RuleSection[]): { start: RuleSection[]; reference: RuleSection[] } {
  const start = (title: string) => (START_HERE as readonly string[]).includes(title);
  return { start: sections.filter(section => start(section.title)), reference: sections.filter(section => !start(section.title)) };
}

/** web/rules.ts sectionId, prefixed: the hidden server-rendered page keeps its own ids. */
export const sectionSlug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const ruleAnchor = (title: string): string => `d1-${sectionSlug(title)}`;
