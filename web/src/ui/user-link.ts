import { h } from "./dom.ts";

/** Public projections already exclude test owners. Take only a username, never an account placeholder,
 * model label, house seat, invite, or the numbered suffix of a grouped seat. */
export function userHref(identity: string | null | undefined): string | null {
  if (!identity) return null;
  const owner = identity.replace(/ #\d+$/, "").split("/", 1)[0]!;
  if (!/^[a-z0-9][a-z0-9_-]{1,23}$/i.test(owner) || owner.toLowerCase() === "antwars") return null;
  return `/?page=users&user=${encodeURIComponent(owner)}`;
}

export function userName(doc: Document, identity: string | null | undefined, label: string, cls = ""): HTMLElement {
  const href = userHref(identity);
  if (!href) return h(doc, "span", cls, label);
  const a = h(doc, "a", `aw-user-link ${cls}`.trimEnd(), label);
  a.href = href; a.title = label;
  return a;
}
