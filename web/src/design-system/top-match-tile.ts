// The design system's Top matches tile (docs/design-system.md): one whole-tile link to a match's replay, text only, so nothing
// plays until it is opened. Every tile has the same rows in the same order: the game type; the winner's side on a band
// of its colony colour, the only colony colour on the tile; the other side (each other side, in a free-for-all); how it
// ended; the date with the length. A side
// is one player line, or, where its seats differ, one line per seat group as Matches groups them. No rating and no retired
// mark is drawn; the retired mark is in the tile's accessible name and tooltip. A builder is shown by its name exactly as
// stored, from the one player-line source Matches draws (pages/model.ts recordedPlayer). A side fielding more than one seat
// says so in the type row and with one mark per seat: two edge rules for two seats, and for three or four, small marks two
// across and two down in the same space.
import "./tokens.css";
import "./top-match-tile.css";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { colonyColours, colourCss } from "../../../src/sim/colonyNames.ts";
import { badgeWords, hasBadges, type BadgeKinds } from "../leaderboard-page/view.ts";
import type { Recording } from "../matches-page/data.ts";
import { colonySeats, seatGroups, whenParts, type PlayerParts, type SeatGroup } from "../pages/model.ts";
import { DECIDED_ON, LAST_COLONY_STANDING } from "../story.ts";
import { MATCH_TYPE_WORDS, recordingResult, recordingRow } from "../ui/format.ts";
import { h } from "../ui/dom.ts";

/** A colony no seat was recorded for, as Matches words it. */
const NOT_JOINED = "did not join";

/** A match's length in whole minutes, from its start to the end of its simulation (else its end). */
export function lengthText(r: Pick<Recording, "startedAt" | "endedAt" | "simulationEndedAt">): string | null {
  const ms = Date.parse(r.simulationEndedAt ?? r.endedAt ?? "") - Date.parse(r.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 60_000)} min` : null;
}

/** The type row's words, as its kind and its size: "Index" and "1v1"; a team match says its seats in words, "2 per side". */
export function tileType(type: Recording["matchType"]): { kind: string; size: string | null } | null {
  if (type == null) return null;
  const kind = MATCH_TYPE_WORDS[type.kind];
  if (type.size === null || type.kind === "quadrants") return { kind, size: null };
  return { kind, size: type.size > 1 ? `${type.size} per side` : "1v1" };
}

/** One side as the tile shows it: its seats as Matches groups them (alike seats once), and how many seats it fields. */
export interface TileSide { readonly groups: readonly SeatGroup[]; readonly seats: number }

/** Each colony's side, index = colony; null for a colony with no recorded seat. Ratings play no part: the tile shows none. */
export function tileSides(r: Pick<Recording, "seats">, colonies: number): (TileSide | null)[] {
  const seats = colonySeats(r.seats, colonies);
  return Array.from({ length: colonies }, (_, colony) => {
    const entries = seats?.[colony] ?? null;
    if (entries === null) return null;
    return { groups: seatGroups(entries.map(entry => ({ ...entry, rating: null }))), seats: entries.length };
  });
}

/** Fast, drawn as a bolt inside the effort badge; read in the tile's accessible name. */
function bolt(doc: Document): HTMLElement {
  const mark = h(doc, "span", "aw-bolt");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** The effort badge, Fast drawn as a bolt inside it; Fast with no level is a badge of its bolt alone. The retired mark is not drawn. */
function badges(doc: Document, kinds: BadgeKinds): HTMLElement | null {
  if (kinds.level === null && !kinds.fast) return null;
  const tags = h(doc, "span", "aw-tags");
  const badge = h(doc, "span", "aw-badge");
  if (kinds.level !== null) badge.append(kinds.level);
  if (kinds.fast) badge.append(bolt(doc));
  tags.append(badge);
  return tags;
}

/** One player: the builder's name (bold) and the model, then the effort badge. */
function player(doc: Document, parts: PlayerParts): HTMLElement[] {
  const name = h(doc, "span", "aw-name");
  if (parts.user !== null) name.append(h(doc, "b", undefined, parts.user));
  if (parts.user !== null && parts.model !== null) name.append(" ");
  if (parts.model !== null) name.append(parts.model);
  const tags = badges(doc, parts.badges);
  return tags ? [name, tags] : [name];
}

/** The seat-mark class of a line standing for `seats` seats: two edge rules for two seats; for three or four, one 2 x 7 px
 * mark per seat, two across and two down in the same 6 px. One seat has no mark of its own. */
function seatMarks(seats: number): string {
  return seats <= 1 ? "" : ` is-seats-${Math.min(seats, 4)}`;
}

/** A side: its player line, or, where its seats differ, one block of player lines, one per seat group in first-seat order,
 * each with one mark per seat it stands for. No line is merged or shortened and no name is left out. */
function playerLine(doc: Document, side: TileSide | null, winner: boolean): HTMLElement {
  if (side !== null && side.groups.length > 1) {
    const block = h(doc, "span", `aw-side${winner ? " is-winner" : ""}`);
    for (const group of side.groups) {
      const line = h(doc, "span", `aw-row aw-player${seatMarks(group.seats)}`);
      line.append(...player(doc, group.parts));
      block.append(line);
    }
    return block;
  }
  const line = h(doc, "span", `aw-row aw-player${winner ? " is-winner" : ""}${side !== null && side.seats > 1 ? ` is-team${side.seats > 2 ? seatMarks(side.seats) : ""}` : ""}`);
  if (side === null) { line.append(h(doc, "span", "aw-name", NOT_JOINED)); return line; }
  line.append(...player(doc, side.groups[0]!.parts));
  return line;
}

/** One player in words: name and model, then its badges with "retired model". */
function playerWords({ user, model, badges: kinds }: PlayerParts): string {
  const shown = badgeWords({ ...kinds, retired: false });
  const extra = [...shown, ...(kinds.retired ? ["retired model"] : [])];
  return [user, model].filter(word => word !== null).join(" ") + (hasBadges(kinds) && extra.length ? ` (${extra.join(", ")})` : "");
}

/** A side in words, for the tile's accessible name: its player and its seats; where its seats differ, each seat group
 * joined by "and", a group of more than one seat with its count, as Matches reads a group. */
function sideWords(side: TileSide | null): string {
  if (side === null) return NOT_JOINED;
  if (side.groups.length === 1) return playerWords(side.groups[0]!.parts) + (side.seats > 1 ? `, ${side.seats} seats` : "");
  return side.groups.map(group => playerWords(group.parts) + (group.seats > 1 ? `, ${group.seats} seats` : "")).join(" and ");
}

/** Words in a list: "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** How it ended, as row 4 shows it: the site's own words without the tie-break step it was decided on
 * (" · decided on kills"), and on a free-for-all also without the leading "Last colony standing" (the winner's line
 * already says who was left), so the row keeps one line; the accessible name keeps the full words. */
export function tileEnding(ended: string, colonies: number): string {
  const step = ended.indexOf(` · ${DECIDED_ON} `);
  const shown = step === -1 ? ended : ended.slice(0, step);
  const lead = `${LAST_COLONY_STANDING} · `;
  if (colonies <= 2 || !shown.startsWith(lead)) return shown;
  const rest = shown.slice(lead.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** One grid cell: the tile linking to the match's replay. */
export function topMatchTile(doc: Document, r: Recording, search: string): HTMLLIElement {
  const listed = recordingRow(r, search);
  const colonies = Math.max(2, r.colonyNames?.length ?? 0, ...r.seats.map(seat => seat.colony + 1));
  const names = r.colonyNames ?? COLONY_NAMES;
  const sides = tileSides(r, colonies);
  const winner = r.winner !== null && r.winner < colonies ? r.winner : null;
  const order = winner === null ? sides.map((_, colony) => colony) : [winner, ...sides.map((_, colony) => colony).filter(colony => colony !== winner)];
  const type = tileType(r.matchType);
  const { result, how } = recordingResult(r);
  const ended = how ?? result;
  const date = whenParts(listed.when).date;
  const length = lengthText(r);

  const item = h(doc, "li");
  const link = h(doc, "a", "aw-tile");
  link.href = listed.href;
  link.dataset.key = `top|${r.id}`;
  if (winner !== null) link.style.setProperty("--tile-accent", colourCss(colonyColours(names)[winner]!));

  const meta = h(doc, "span", "aw-row aw-meta");
  const typeName = h(doc, "span", "aw-type aw-name");
  if (type !== null) {
    typeName.append(type.kind);
    if (type.size !== null) typeName.append(" · ", h(doc, "span", "aw-keep", type.size));
  }
  meta.append(typeName);
  link.append(meta);
  // The winner first, then each other side in colony order: two sides on most tiles, every side of a free-for-all.
  link.append(...order.map((colony, i) => playerLine(doc, sides[colony] ?? null, i === 0 && winner !== null)));
  const howRow = h(doc, "span", "aw-row aw-how");
  howRow.append(h(doc, "span", "aw-name", tileEnding(ended, colonies)));
  const dateRow = h(doc, "span", "aw-row aw-date");
  dateRow.append(h(doc, "span", "aw-name", date), h(doc, "span", "aw-len", length ?? ""));
  link.append(howRow, dateRow);

  const typeWords = type === null ? null : type.size === null ? type.kind : `${type.kind} · ${type.size}`;
  const sidesWords = winner === null ? order.map(colony => sideWords(sides[colony] ?? null)).join(" v ")
    : `${sideWords(sides[winner] ?? null)} beat ${listWords(order.slice(1).map(colony => sideWords(sides[colony] ?? null)))}`;
  const label = [sidesWords, typeWords, ended, length === null ? null : length.replace(" min", " minutes"), date].filter(word => word !== null && word !== "").join(", ");
  link.setAttribute("aria-label", label);
  link.title = label;
  item.append(link);
  return item;
}
