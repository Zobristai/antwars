// The Instrument deck top bar's brand: the approved antwars emblem, then the text wordmark with the credit stacked
// under it (the credit moved under the wordmark by deck.css). The emblem and the wordmark are one link to the home page;
// the credit stays plain text beside it. The emblem is the v2 logo's two-ant cut, bundled locally and decorative: the
// link's name says where it goes.
import { h } from "../dom.ts";
import { PAGE_COPY } from "../../story.ts";

/** The approved emblem (antwars-emblem-v2.png, 143 × 112), bundled by Vite like the provider logos. */
export const EMBLEM_SRC = new URL("../../../assets/brand/antwars-emblem.png", import.meta.url).href;

/** The home page: the landing page at / with no query (leaderboard-page/route.ts isLandingPage), never the match screen. */
export const HOME_HREF = "/";

/** A link to the home page named for it; the caller puts the emblem and the wordmark in it. */
export function homeLink(doc: Document, cls: string): HTMLAnchorElement {
  const link = h(doc, "a", cls);
  link.href = HOME_HREF;
  link.setAttribute("aria-label", PAGE_COPY.home);
  return link;
}

export function deckBrand(doc: Document): HTMLParagraphElement {
  const brand = h(doc, "p", "d1-brand");
  const emblem = h(doc, "img", "d1-emblem");
  emblem.src = EMBLEM_SRC;
  emblem.alt = "";
  emblem.setAttribute("aria-hidden", "true");
  emblem.width = 36;
  emblem.height = 28;
  const home = homeLink(doc, "d1-home");
  home.append(emblem, h(doc, "span", "d2-wordmark", PAGE_COPY.name));
  brand.append(home, h(doc, "span", "d2-credit d1-top-credit", PAGE_COPY.credit));
  return brand;
}
