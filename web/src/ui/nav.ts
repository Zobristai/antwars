// The broadcast HUD: the three pages' one navigation, text tabs; the page shown is marked, not a link to itself.
import { PAGES, keep, type PageName } from "./format.ts";

export function navigation(doc: Document, page: PageName, search: string): HTMLElement {
  const nav = doc.createElement("nav");
  nav.className = "d2-nav";
  nav.setAttribute("aria-label", "Antwars");
  for (const [name, label, href] of PAGES) {
    const link = doc.createElement("a");
    link.className = "d2-nav-link";
    link.textContent = label;
    link.href = keep(href, search);
    if (name === page) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
}
