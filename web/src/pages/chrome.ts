// The Archive (ported): the frame its three pages share. The top bar and the Bring your
// agent dialog come from top-bar.ts; on these scrolling pages the bar stays sticky. Under it, the
// battle hero and the amber wash; then the page: one container, the same
// width and edges on all three pages, its title and controls in a band at the top and the record cards under it
// (one shared container); then the HUD's footer, Rules and "Inspired by" only. Every change is a cut.
import "../ui/ui.css";
import "./archive.css";
import { INSPIRED_BY_URL } from "../story.ts";
import { h } from "../ui/dom.ts";
import { mountTopBar, type PageName } from "./top-bar.ts";

export type { PageName } from "./top-bar.ts";

/** hero-battle.png, re-encoded as WebP; decorative, no text on it. */
const HERO = new URL("./hero-battle.webp", import.meta.url).href;
/** The HUD's rule: one Bring your agent button, in the bar from 520 px wide; narrower, at the page's end. */
const BUTTON_IN_BAR = "(min-width: 520px)";

export interface Frame {
  readonly root: HTMLElement;
  /** The band at the container's top: the page's title, its Refresh and freshness, and its choices. */
  readonly band: HTMLElement;
  /** The record cards. */
  readonly content: HTMLElement;
  destroy(): void;
}

export function mountFrame(doc: Document, host: HTMLElement, page: PageName): Frame {
  const win = doc.defaultView!;
  const cleanups: (() => void)[] = [];
  const root = h(doc, "div", "d1p");
  root.dataset.page = page;
  const top = mountTopBar(doc, root, page);
  cleanups.push(top.destroy);

  // ---------------------------------------------------------------- the hero and the page under it
  const hero = h(doc, "div", "d1p-hero");
  hero.setAttribute("aria-hidden", "true");
  const image = h(doc, "img");
  image.src = HERO; image.alt = ""; image.decoding = "async";
  hero.append(image);
  const body = h(doc, "div", "d1p-page");
  const main = h(doc, "main", "d1p-main");
  const band = h(doc, "div", "d1p-band");
  const content = h(doc, "div", "d1p-content");
  main.append(band, content);

  // ---------------------------------------------------------------- the HUD's footer; the board's Key and offer stay off
  const end = h(doc, "div", "d1p-end");
  const foot = h(doc, "footer", "d1p-foot");
  let rules: HTMLElement;
  if (page === "rules") {
    // The page shown is marked, not a link to itself (ui/nav.ts).
    rules = h(doc, "span", "d2-link d1p-foot-current", "Rules");
    rules.setAttribute("aria-current", "page");
  } else {
    const link = h(doc, "a", "d2-link", "Rules");
    link.href = "/rules"; link.target = "_blank"; link.rel = "noopener";
    rules = link;
  }
  const inspired = h(doc, "a", "d2-link", "Inspired by @LambethEthan");
  inspired.href = INSPIRED_BY_URL; inspired.target = "_blank"; inspired.rel = "noopener noreferrer";
  foot.append(rules, inspired);
  body.append(main, end, foot);
  // The dialog went into root first; the bar still leads the page and its reading order.
  root.prepend(top.bar);
  top.bar.after(hero, body);
  host.append(root);

  const wide = typeof win.matchMedia === "function" ? win.matchMedia(BUTTON_IN_BAR) : null;
  const placeButton = () => {
    const slot = wide === null || wide.matches ? top.end : end;
    if (top.agentButton.parentElement !== slot) slot.append(top.agentButton);
    end.hidden = slot !== end;
  };
  placeButton();
  if (wide) { wide.addEventListener("change", placeButton); cleanups.push(() => wide.removeEventListener("change", placeButton)); }

  return {
    root, band, content,
    destroy() { for (const cleanup of cleanups.splice(0)) cleanup(); root.remove(); },
  };
}

/** A card's one-line state: a decorative glyph, then the words that carry it, read politely. */
export function stateLine(doc: Document, glyph: string, text: string): HTMLParagraphElement {
  const line = h(doc, "p", "d1p-state");
  line.setAttribute("role", "status");
  const mark = h(doc, "span", "d1p-glyph");
  mark.dataset.glyph = glyph;
  mark.setAttribute("aria-hidden", "true");
  line.append(mark, h(doc, "span", undefined, text));
  return line;
}

/** Rebuild a region from data while keeping keyboard focus on the same control, found again by its data-key. */
export function rebuild(doc: Document, region: HTMLElement, build: () => Node[]): void {
  const active = doc.activeElement;
  const key = active instanceof HTMLElement && region.contains(active) ? active.dataset.key : undefined;
  region.replaceChildren(...build());
  if (key) region.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}
