// The Instrument deck top bar's brand: the approved antwars emblem, then the text wordmark with the credit stacked
// under it (the credit moved under the wordmark by deck.css). The emblem is the v2 logo's two-ant cut, bundled locally and decorative: the live text wordmark
// already names the game.
import { h } from "../dom.ts";
import { PAGE_COPY } from "../../story.ts";

/** The approved emblem (antwars-emblem-v2.png, 143 × 112), bundled by Vite like the provider logos. */
export const EMBLEM_SRC = new URL("../../../assets/brand/antwars-emblem.png", import.meta.url).href;

export function deckBrand(doc: Document): HTMLParagraphElement {
  const brand = h(doc, "p", "d1-brand");
  const emblem = h(doc, "img", "d1-emblem");
  emblem.src = EMBLEM_SRC;
  emblem.alt = "";
  emblem.setAttribute("aria-hidden", "true");
  emblem.width = 36;
  emblem.height = 28;
  brand.append(emblem, h(doc, "span", "d2-wordmark", PAGE_COPY.name), h(doc, "span", "d2-credit d1-top-credit", PAGE_COPY.credit));
  return brand;
}
