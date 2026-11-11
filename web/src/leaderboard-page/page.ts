import { loadLeaderboard, type LeaderboardMode, type LeaderboardQuery, type LeaderboardRow } from "../leaderboard.ts";
import { storeFeatureEnabled } from "../store-capabilities.ts";
import { mountLeaderboard, type LeaderboardView } from "../pages/leaderboard.ts";
import { CHALLENGE, CHALLENGE_RANKING, OPENING_MODE, challengeRows, type BoardChoice } from "../pages/model.ts";
import { loadChallengeOpponents } from "./challenge.ts";
import { C } from "./copy.ts";
import { loadRanking, type RankingView } from "./view.ts";

const SIZES = ["1v1", "2v2", "3v3", "4v4"] as const;
type Size = typeof SIZES[number];
/** The ranked modes, then the Antwars Model Index mode at each size (internal ids house-*). */
const CHOICES: readonly { readonly mode: LeaderboardMode; readonly size: Size; readonly house: boolean }[] = [
  ...SIZES.map(size => ({ mode: size, size, house: false })),
  ...SIZES.map(size => ({ mode: `house-${size}` as const, size, house: true })),
];

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
  // The mode a link names (/?page=leaderboard&mode=house-1v1, or mode=challenge), when it is one of the choices; otherwise
  // the opening mode.
  const asked = new URLSearchParams(win.location.search).get("mode");
  const known = (next: string | null): next is BoardChoice => next === CHALLENGE || CHOICES.some(entry => entry.mode === next);
  const opening: BoardChoice = known(asked) ? asked : OPENING_MODE;
  let view: LeaderboardView = { mode: opening, enabled, tables: [] };
  let mode: BoardChoice = opening, mounted: ReturnType<typeof loadRanking>[] = [], closed = false;
  // The Challenge list's read in flight, aborted when the board changes, refreshes or closes.
  let challenge: AbortController | null = null;
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
  function show(next: BoardChoice) {
    if (closed) return;
    for (const table of mounted) table.destroy();
    challenge?.abort(); challenge = null; mounted = [];
    if (next === CHALLENGE) { showChallenge(); return; }
    mode = next; view = { mode, enabled, tables: [] };
    const chosen = CHOICES.find(entry => entry.mode === next)!;
    mounted = chosen.house
      ? [loadRanking({ title: `${C.houseModeTitle} · ${chosen.size}`, id: "aw-house-mode-ranking", load: read({ mode: next }) }, publish)]
      : [
        loadRanking({ title: `${C.houseTitle} · ${chosen.size} · ${C.houseModels}`, id: "aw-house-ranking", load: read({ mode: next, scope: "house" }) }, publish),
        loadRanking({ title: `${C.everyoneTitle} · ${chosen.size}`, id: "aw-everyone-ranking", load: read({ mode: next }) }, publish),
      ];
    page.update(view);
  }
  /** Every row of the Antwars Model Index 1v1, page after page, through the read its board uses. */
  async function readChallengeRanking(signal: AbortSignal): Promise<LeaderboardRow[]> {
    const rows: LeaderboardRow[] = [];
    let cursor: string | undefined;
    do {
      const next = await loadLeaderboard(cursor, signal, request, { mode: CHALLENGE_RANKING });
      rows.push(...next.entries); cursor = next.next;
    } while (cursor !== undefined && !signal.aborted);
    return rows;
  }
  /** Challenge reads the house handles and the Antwars Model Index 1v1 together, so its rows follow that ranking with its
   * ratings. Either read failing keeps nothing and says so once; Refresh reads both again. */
  function showChallenge() {
    const controller = new AbortController();
    challenge = controller;
    mode = CHALLENGE; view = { mode, enabled, tables: [], challenge: { status: "loading", rows: [] } };
    page.update(view);
    Promise.all([loadChallengeOpponents(controller.signal, request), readChallengeRanking(controller.signal)]).then(
      ([opponents, ranking]) => {
        if (!controller.signal.aborted && !closed) { view = { ...view, challenge: { status: "ready", rows: challengeRows(opponents, ranking) } }; page.update(view); }
      },
      () => { if (!controller.signal.aborted && !closed) { view = { ...view, challenge: { status: "error", rows: [] } }; page.update(view); } },
    );
  }
  function destroy() {
    if (closed) return;
    closed = true; for (const table of mounted) table.destroy(); mounted = []; challenge?.abort(); challenge = null;
    page.destroy(); host.remove();
    doc.title = previousTitle; if (waiting && waitingHidden !== undefined) waiting.hidden = waitingHidden;
    win.removeEventListener("pagehide", destroy);
  }
  win.addEventListener("pagehide", destroy, { once: true });
  if (enabled) show(opening);
  else page.update(view);
  return destroy;
}
