// The Leaderboard, Matches and Rules pages' shared words and pill. The pages themselves are the Archive
// (web/src/pages/).
import "./ui.css";

/** New words these pages add; every other string is the pages' own. */
export const PAGE_WORDS = {
  matchesTitle: "Matches",
  live: "Live now",
  recordings: "Recordings",
  replay: "Replay",
  refresh: "Refresh",
  more: "Load more",
} as const;

export function pill(doc: Document, text: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "d2-pill";
  b.textContent = text;
  return b;
}
