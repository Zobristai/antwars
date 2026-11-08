import { createMatchesData } from "./data.ts";
import { mountMatches } from "../pages/matches.ts";

/** The Matches page (the Archive): live matches and saved recordings. No account, board or match
 * stream is needed to read it. */
export function mountMatchesPage(doc: Document, win: Window): () => void {
  const host = doc.createElement("div"); host.className = "aw-page-host"; doc.body.append(host);
  const waiting = doc.getElementById("aw-waiting"), wasHidden = waiting?.hidden;
  if (waiting) waiting.hidden = true;
  const oldTitle = doc.title; doc.title = "Matches — Antwars";
  const data = createMatchesData(win.fetch.bind(win), view => page.update(view), { waiting: true });
  const page = mountMatches(doc, host, { refresh: () => data.refresh(), more: () => data.more() });
  page.update(data.view);
  data.refresh();
  const destroy = () => {
    data.destroy(); page.destroy(); host.remove(); doc.title = oldTitle;
    if (waiting && wasHidden !== undefined) waiting.hidden = wasHidden;
    win.removeEventListener("pagehide", destroy);
  };
  win.addEventListener("pagehide", destroy, { once: true });
  return destroy;
}
