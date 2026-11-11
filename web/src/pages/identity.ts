// One name/badge/rating style for every row that names a player or model:
// the Leaderboard, Matches' Live now and its Recordings all draw a name, its level/Fast
// badges and, where shown, its rating through here, each place keeping its own other fields. No page keeps its own copy.
import { h } from "../ui/dom.ts";
import { PROVISIONAL_WORD, eloText, provisional, rdText, type NameParts } from "./model.ts";

/** How a rating looks wherever one is shown: "number" is the Leaderboard's bold figure then "± RD"; "badge" is the in-match
 * cyan badge (deck.css `.d1-tag.d1-elo`) showing the figure alone, its "± RD" on hover, tap or focus.
 * The provisional word follows either. */
export type RatingLook = "number" | "badge";
/** The one switch for the rating look on every page: the cyan badge everywhere. */
export const RATING_LOOK: RatingLook = "badge";

/** A name as shown: its text, its badges, and a quiet thinking level where the place shows one. */
export type ShownName = Pick<NameParts, "name" | "badges"> & { readonly quiet?: string | null };
/** A rating as shown: whole points, its RD where recorded, and the rated matches that decide the provisional word. */
export interface ShownRating { readonly rating: number; readonly rd?: number | null; readonly ratedMatches: number }

/** The name (set as text, never markup), then its badges as one unit so a wrapping name never splits them (archive.css
 * .d1p-tags), then any quiet thinking level. */
export function nameNodes(doc: Document, parts: ShownName): Node[] {
  const nodes: Node[] = [h(doc, "span", undefined, parts.name)];
  if (parts.badges.length > 0) {
    const tags = h(doc, "span", "d1p-tags");
    tags.append(...parts.badges.map(badge => h(doc, "span", "d1p-tag", badge)));
    nodes.push(tags);
  }
  if (parts.quiet) nodes.push(h(doc, "span", "d1p-think", parts.quiet));
  return nodes;
}

/** The rating in whole points, then ± its RD, then below 10 rated matches the plain word "provisional". */
export function ratingNodes(doc: Document, row: ShownRating, look: RatingLook = RATING_LOOK): Node[] {
  const rd = rdText(row);
  const nodes: Node[] = look === "badge"
    ? [rd === "" ? h(doc, "span", "d1-tag d1-elo d1p-elo-badge", eloText(row.rating)) : rdBadge(doc, eloText(row.rating), rd)]
    : [h(doc, "span", "d1p-elo", eloText(row.rating)), ...(rd === "" ? [] : [h(doc, "span", "d1p-rd", ` ${rd}`)])];
  if (provisional(row)) nodes.push(h(doc, "span", "d1p-sr", ", "), h(doc, "span", "d1p-prov", PROVISIONAL_WORD));
  return nodes;
}

/** A Matches row's rating: the cyan badge, figure only, its "± RD" on hover, tap or focus, with no provisional word. A
 * badge with an RD is a button keyed by `key` (its data-key), so a redraw of the list keeps keyboard focus on it
 * (chrome.ts rebuild). */
export function rowRatingNode(doc: Document, row: ShownRating, key: string): HTMLElement {
  const rd = rdText(row);
  if (rd === "") return h(doc, "span", "d1-tag d1-elo d1p-elo-badge", eloText(row.rating));
  const badge = rdBadge(doc, eloText(row.rating), rd);
  badge.dataset.key = key;
  return badge;
}

/** The badge showing the figure alone, its "± RD" a tip above it, shown on hover. The tip's text stays inside the badge, so its accessible name is "1522 ± 87"; archive.css shows the tip on
 * keyboard focus, while open, and while a mouse or pen is over it. Hover is read from the pointer, not CSS :hover, because
 * a touch leaves WebKit's :hover stuck on a tapped badge while a mouse on a touch-first device still hovers. A tap opens or
 * closes it and focuses the badge, since WebKit does not focus a tapped button; the badge losing focus closes it. */
function rdBadge(doc: Document, figure: string, rd: string): HTMLButtonElement {
  const badge = h(doc, "button", "d1-tag d1-elo d1p-elo-badge");
  badge.type = "button";
  badge.append(figure, h(doc, "span", "d1p-elo-rd", ` ${rd}`));
  badge.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") badge.setAttribute("data-hover", ""); });
  badge.addEventListener("pointerleave", () => badge.removeAttribute("data-hover"));
  badge.addEventListener("click", () => {
    if (badge.hasAttribute("data-open")) badge.removeAttribute("data-open");
    else { badge.setAttribute("data-open", ""); badge.focus({ preventScroll: true }); }
  });
  badge.addEventListener("blur", () => badge.removeAttribute("data-open"));
  return badge;
}
