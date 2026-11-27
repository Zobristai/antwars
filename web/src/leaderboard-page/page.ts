import { loadLeaderboard, type LeaderboardMode, type LeaderboardQuery } from "../leaderboard.ts";
import { storeFeatureEnabled } from "../store-capabilities.ts";
import { mountLeaderboard, type LeaderboardView } from "../pages/leaderboard.ts";
import { BOARD_GROUPS, OPENING_MODE, sizeOf } from "../pages/model.ts";
import { C } from "./copy.ts";
import { loadRanking, type RankingView } from "./view.ts";

/**
 * The Leaderboard page (the Archive): this module owns the mode and each mode's rankings, the page
 * (pages/leaderboard.ts) draws them. No account, board, match stream, identity key or recording is needed to read it.
 */
export function mountLeaderboardPage(doc: Document, win: Window, options: { request?: typeof fetch } = {}): () => void {
  const request = options.request ?? win.fetch.bind(win);
  const host = doc.createElement("div"); host.className = "aw-page-host"; host.id = "aw-leaderboard-page";
  doc.body.append(host);
  const waiting = doc.getElementById("aw-waiting"); const waitingHidden = waiting?.hidden;
  if (waiting) waiting.hidden = true;
  const previousTitle = doc.title; doc.title = "Leaderboard — Antwars";
  const enabled = storeFeatureEnabled(doc, "public-matches");
  // The mode a link names (/?page=leaderboard&mode=house-1v1), when it is one of the choices; otherwise the opening mode.
  const asked = new URLSearchParams(win.location.search).get("mode");
  const known = (next: string | null): next is LeaderboardMode => BOARD_GROUPS.some(group => group.modes.some(mode => mode === next));
  const opening: LeaderboardMode = known(asked) ? asked : OPENING_MODE;
  let view: LeaderboardView = { mode: opening, enabled, tables: [] };
  let mode: LeaderboardMode = opening, mounted: ReturnType<typeof loadRanking>[] = [], closed = false;
  const page = mountLeaderboard(doc, host, {
    chooseMode(next) { if (enabled && known(next)) show(next); },
    refresh() { if (enabled) show(mode); },
    more(id) { mounted.find(table => table.id === id)?.more(); },
  });
  const publish = (table: RankingView) => {
    if (closed) return;
    view = { ...view, tables: view.tables.some(entry => entry.id === table.id) ? view.tables.map(entry => entry.id === table.id ? table : entry) : [...view.tables, table] };
    page.update(view);
  };
  const read = (query: LeaderboardQuery) =>
    (cursor: string | undefined, signal: AbortSignal) => loadLeaderboard(cursor, signal, request, query);
  /** Replaces every shown table; each old one aborts and ignores any response still arriving for it. */
  function show(next: LeaderboardMode) {
    if (closed) return;
    for (const table of mounted) table.destroy();
    mode = next; view = { mode, enabled, tables: [] };
    if (next === "quadrants") {
      mounted = [loadRanking({ title: C.freeForAll, id: "aw-ffa-ranking", load: read({ mode: next }) }, publish)];
    } else {
      const size = sizeOf(next);
      mounted = next.startsWith("house-")
        ? [loadRanking({ title: `${C.houseModeTitle} · ${size}`, id: "aw-house-mode-ranking", load: read({ mode: next }) }, publish)]
        : [
          loadRanking({ title: `${C.houseTitle} · ${size} · ${C.houseModels}`, id: "aw-house-ranking", load: read({ mode: next, scope: "house" }) }, publish),
          loadRanking({ title: `${C.everyoneTitle} · ${size}`, id: "aw-everyone-ranking", load: read({ mode: next }) }, publish),
        ];
    }
    page.update(view);
  }
  function destroy() {
    if (closed) return;
    closed = true; for (const table of mounted) table.destroy(); mounted = [];
    page.destroy(); host.remove();
    doc.title = previousTitle; if (waiting && waitingHidden !== undefined) waiting.hidden = waitingHidden;
    win.removeEventListener("pagehide", destroy);
  }
  win.addEventListener("pagehide", destroy, { once: true });
  if (enabled) show(opening);
  else page.update(view);
  return destroy;
}
