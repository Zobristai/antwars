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

/** Only confirmed seats link from a directly addressed match; never infer membership from display text. */
export function rosterHandle(handles: ReadonlySet<string> | undefined, label: string | null | undefined): string | null {
  const handle = label?.replace(/ #\d+$/, "");
  return handle && handles?.has(handle) ? handle : null;
}

export async function readRosterHandles(share: string, request: typeof fetch, signal: AbortSignal): Promise<ReadonlySet<string>> {
  const query = new URL(share).searchParams;
  const kind = query.has("replay") ? "replay" : "lobby", key = query.get(kind);
  if (!key) return new Set();
  const response = await request(`/matches/users/links/${kind}/${encodeURIComponent(key)}`, { signal, credentials: "omit", redirect: "error", cache: "no-store" });
  if (!response.ok) return new Set();
  const data: unknown = await response.json();
  return new Set(data && typeof data === "object" && "handles" in data && Array.isArray(data.handles)
    && data.handles.every((name): name is string => typeof name === "string") ? data.handles : []);
}
