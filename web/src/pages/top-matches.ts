// The Watch page with no live match to show: the hand-picked top matches (src/replays/top-matches.ts) as a grid of the design
// system's Top matches tiles (design-system/top-match-tile.ts), in the site's page frame. The title and the reason no live
// match shows stand in the page band; the grid sits on the page under it, with no card around it; All recordings is a text
// link under the grid. Four columns from tablet width up, two on a phone, one on the narrowest phones. Each tile is one link
// to its match's replay and plays nothing itself.
import { topMatchTile } from "../design-system/top-match-tile.ts";
import { topMatchesList } from "../matches-page/data.ts";
import type { Fallback } from "../replay.ts";
import { keep } from "../ui/format.ts";
import { h } from "../ui/dom.ts";
import { mountFrame, stateLine } from "./chrome.ts";

export { lengthText } from "../design-system/top-match-tile.ts";

export const TOP_WORDS = {
  title: "Top matches",
  loading: "Loading top matches",
  failed: "Top matches unavailable. Trying again shortly.",
  empty: "No top matches yet.",
  all: "All recordings",
} as const;
/** Why the page is not showing a live match, as the band's state line says it. */
export const TOP_STATE: Record<Fallback, string> = {
  idle: "No live match right now",
  starting: "Live match starting",
  failed: "Live matches unavailable",
};
export const ALL_RECORDINGS_HREF = "/?page=matches";
/** The waits before each read again after a failed one, the last repeated: the page keeps reading until the list arrives. */
export const TOP_RETRY_MS = [10_000, 20_000, 40_000, 60_000] as const;

export interface TopMatchesOptions {
  /** Why no live match is shown: the band's state line. */
  readonly state: Fallback;
  readonly request?: typeof fetch;
}

export interface TopMatchesPage {
  /** Says a new reason in the state line, as the live list changes under the page. */
  setState(state: Fallback): void;
  destroy(): void;
}

/** Mounts the top-matches page into its own host, reads GET /matches/top and draws it. */
export function mountTopMatchesPage(doc: Document, win: Window, options: TopMatchesOptions): TopMatchesPage {
  const request = options.request ?? win.fetch.bind(win);
  const search = win.location.search;
  const host = h(doc, "div", "aw-page-host");
  host.id = "aw-top-matches-page";
  doc.body.append(host);
  const waiting = doc.getElementById("aw-waiting"), wasHidden = waiting?.hidden;
  if (waiting) waiting.hidden = true;
  const oldTitle = doc.title; doc.title = "Antwars — top matches";
  const frame = mountFrame(doc, host, "watch");
  const abort = new AbortController();

  const title = h(doc, "h1", "d1p-title", TOP_WORDS.title);
  title.id = "aw-top-title";
  let state = stateLine(doc, "ring", TOP_STATE[options.state]), shown = options.state;
  frame.band.append(title, state);
  const grid = h(doc, "ol", "aw-grid");
  grid.setAttribute("aria-labelledby", "aw-top-title");
  grid.setAttribute("aria-busy", "true");
  const status = h(doc, "p", "aw-status", TOP_WORDS.loading);
  const after = h(doc, "p", "aw-after");
  const all = h(doc, "a", "aw-link", TOP_WORDS.all);
  all.href = keep(ALL_RECORDINGS_HREF, search);
  after.append(all);
  frame.content.append(status, grid, after);

  let retry: ReturnType<typeof setTimeout> | undefined;
  const load = async (attempt: number): Promise<void> => {
    try {
      const response = await request("/matches/top", { cache: "no-store", credentials: "same-origin", redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
      if (!response.ok) throw new Error("Top matches unavailable");
      const { matches } = topMatchesList.parse(await response.json());
      if (abort.signal.aborted) return;
      grid.replaceChildren(...matches.map(r => topMatchTile(doc, r, search)));
      status.textContent = matches.length === 0 ? TOP_WORDS.empty : "";
      status.hidden = matches.length > 0;
      status.removeAttribute("role");
      grid.removeAttribute("aria-busy");
    } catch {
      if (abort.signal.aborted) return;
      status.textContent = TOP_WORDS.failed;
      status.hidden = false;
      status.setAttribute("role", "status");
      retry = setTimeout(() => void load(attempt + 1), TOP_RETRY_MS[Math.min(attempt, TOP_RETRY_MS.length - 1)]);
    }
  };
  void load(0);

  const destroy = () => {
    abort.abort(); clearTimeout(retry); frame.destroy(); host.remove(); doc.title = oldTitle;
    if (waiting && wasHidden !== undefined) waiting.hidden = wasHidden;
    win.removeEventListener("pagehide", destroy);
  };
  win.addEventListener("pagehide", destroy, { once: true });
  return {
    setState(next) {
      if (next === shown) return;
      shown = next;
      state = stateLine(doc, "ring", TOP_STATE[next]);
      frame.band.replaceChildren(title, state);
    },
    destroy,
  };
}
