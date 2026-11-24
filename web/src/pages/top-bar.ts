// The three pages' top bar and its Bring your agent dialog: main's HUD deck bar, used as main has it — its
// brand (emblem, wordmark, credit), the navigation and the cyan Bring your agent pill with its dialog (ui/deck brand.ts,
// dialog.ts and deck.css's bar rules). Sticky on these
// pages, with "Built with Zobrist" kept under the wordmark at every width (top-bar.css).
import "../ui/deck/deck.css";
import "./top-bar.css";
import { deckBrand } from "../ui/deck/brand.ts";
import { mountAgentDialog } from "../ui/deck/dialog.ts";
import { h } from "../ui/dom.ts";
import { navigation } from "../ui/nav.ts";

export type PageName = "watch" | "leaderboard" | "matches" | "users" | "rules";

export interface TopBar {
  readonly bar: HTMLElement;
  /** The bar's end, where the frame puts the Bring your agent button when there is room. */
  readonly end: HTMLElement;
  readonly agentButton: HTMLButtonElement;
  destroy(): void;
}

/** The bar: the brand, the pages, and its end. The dialog lives in `root`. */
export function mountTopBar(doc: Document, root: HTMLElement, page: PageName): TopBar {
  const search = doc.defaultView!.location.search;
  const bar = h(doc, "header", "d1-top");
  // Rules is not a tab, so on /rules no tab is current; the footer marks it instead.
  const nav = navigation(doc, page === "rules" ? "watch" : page, search);
  if (page === "rules") for (const link of nav.querySelectorAll("a")) link.removeAttribute("aria-current");
  const end = h(doc, "div", "d1-top-end");
  const group = h(doc, "div", "site-pages");
  const toggle = h(doc, "button", "site-pages-toggle", "Site pages");
  toggle.type = "button";
  nav.id = "public-site-pages";
  toggle.setAttribute("aria-controls", nav.id);
  const setOpen = (open: boolean) => toggle.setAttribute("aria-expanded", String(open));
  setOpen(false);
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  group.addEventListener("keydown", e => {
    if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") { setOpen(false); toggle.focus(); }
  });
  const outside = (e: Event) => { if (!group.contains(e.target as Node)) setOpen(false); };
  doc.addEventListener("pointerdown", outside);
  group.append(toggle, nav);
  bar.append(deckBrand(doc), group, end);
  const agent = mountAgentDialog(doc, root);
  return { bar, end, agentButton: agent.button, destroy() { doc.removeEventListener("pointerdown", outside); agent.destroy(); } };
}
