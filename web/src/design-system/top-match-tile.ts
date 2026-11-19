// The design system's Top matches tile (docs/design-system.md): one whole-tile link to a match's replay, text only, so nothing
// plays until it is opened. Every tile has the same five one-line rows in the same order: the game type; the winner's
// player line on a band of its colony colour, the only colony colour on the tile; the other side's player line; how it
// ended; the date with the length. No rating and no retired mark is drawn; the retired mark is in the tile's accessible name
// and tooltip. A builder is shown by its name exactly as stored, from the one player-line source Matches draws
// (pages/model.ts recordedPlayer). A side fielding more than one seat says so in the type row and with one edge rule per seat;
// a side whose seats differ names each of them, as Matches does.
import "./tokens.css";
import "./top-match-tile.css";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { colonyColours, colourCss } from "../../../src/sim/colonyNames.ts";
import { badgeWords, hasBadges, type BadgeKinds } from "../leaderboard-page/view.ts";
import type { Recording } from "../matches-page/data.ts";
import { colonySeats, seatGroups, whenParts, type PlayerParts, type SeatGroup } from "../pages/model.ts";
import { MATCH_TYPE_WORDS, recordingResult, recordingRow } from "../ui/format.ts";
import { h } from "../ui/dom.ts";

/** A colony no seat was recorded for, as Matches words it. */
const NOT_JOINED = "did not join";

/** A match's length in whole minutes, from its start to the end of its simulation (else its end). */
export function lengthText(r: Pick<Recording, "startedAt" | "endedAt" | "simulationEndedAt">): string | null {
  const ms = Date.parse(r.simulationEndedAt ?? r.endedAt ?? "") - Date.parse(r.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 60_000)} min` : null;
}

/** The type row's words, as its kind and its size: "Index" and "1v1"; a team match says its seats in words, "2 seats each". */
export function tileType(type: Recording["matchType"]): { kind: string; size: string | null } | null {
  if (type == null) return null;
  const kind = MATCH_TYPE_WORDS[type.kind];
  if (type.size === null || type.kind === "quadrants") return { kind, size: null };
  return { kind, size: type.size > 1 ? `${type.size} seats each` : "1v1" };
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

/** A side's player line: its player, or, where its seats differ, each of them in seat order, each kept whole when the line wraps. */
function playerLine(doc: Document, side: TileSide | null, winner: boolean): HTMLElement {
  const line = h(doc, "span", `aw-row aw-player${winner ? " is-winner" : ""}${side !== null && side.seats > 1 ? " is-team" : ""}`);
  if (side === null) { line.append(h(doc, "span", "aw-name", NOT_JOINED)); return line; }
  if (side.groups.length === 1) { line.append(...player(doc, side.groups[0]!.parts)); return line; }
  for (const group of side.groups) {
    const entry = h(doc, "span", "aw-entry");
    entry.append(...player(doc, group.parts));
    line.append(entry);
  }
  return line;
}

/** One player in words: name and model, then its badges with "retired model". */
function playerWords({ user, model, badges: kinds }: PlayerParts): string {
  const shown = badgeWords({ ...kinds, retired: false });
  const extra = [...shown, ...(kinds.retired ? ["retired model"] : [])];
  return [user, model].filter(word => word !== null).join(" ") + (hasBadges(kinds) && extra.length ? ` (${extra.join(", ")})` : "");
}

/** A side in words, for the tile's accessible name: each of its players, then its seats. */
function sideWords(side: TileSide | null): string {
  if (side === null) return NOT_JOINED;
  return side.groups.map(group => playerWords(group.parts)).join(" and ") + (side.seats > 1 ? `, ${side.seats} seats` : "");
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
  // The winner first, then the other side: two player lines on every tile.
  link.append(playerLine(doc, sides[order[0]!] ?? null, winner !== null), playerLine(doc, sides[order[1]!] ?? null, false));
  const howRow = h(doc, "span", "aw-row aw-how");
  howRow.append(h(doc, "span", "aw-name", ended));
  const dateRow = h(doc, "span", "aw-row aw-date");
  dateRow.append(h(doc, "span", "aw-name", date), h(doc, "span", "aw-len", length ?? ""));
  link.append(howRow, dateRow);

  const typeWords = type === null ? null : type.size === null ? type.kind : `${type.kind} · ${type.size}`;
  const sidesWords = winner === null ? order.map(colony => sideWords(sides[colony] ?? null)).join(" v ")
    : `${sideWords(sides[winner] ?? null)} beat ${order.slice(1).map(colony => sideWords(sides[colony] ?? null)).join(" and ")}`;
  const label = [sidesWords, typeWords, ended, length === null ? null : length.replace(" min", " minutes"), date].filter(word => word !== null && word !== "").join(", ");
  link.setAttribute("aria-label", label);
  link.title = label;
  item.append(link);
  return item;
}
