// The Rules page's browser entry (vite.config.ts): the server-rendered page stays readable without JavaScript;
// with it, the Archive Rules is drawn over it from the same sections, and its Bring your agent dialog works.
// No board or spectator bootstrap runs here.
/** web/rules.ts RULES_DATA_ID, the data the server page carries; that module is the server's, so its name is repeated here. */
const RULES_DATA_ID = "aw-rules-data";
import type { RulesView } from "./model.ts";
import { mountRules } from "./rules.ts";

export function mountRulesPage(doc: Document): void {
  const page = doc.querySelector("body > main");
  const data = doc.getElementById(RULES_DATA_ID);
  if (!(page instanceof HTMLElement) || !data?.textContent) return;
  const view = JSON.parse(data.textContent) as RulesView;
  // The server page's own styles outrank [hidden] on its main, so it is set aside the way a style rule would.
  page.style.setProperty("display", "none", "important");
  const host = doc.createElement("div"); host.className = "aw-page-host";
  doc.body.append(host);
  mountRules(doc, host).update(view);
}

if (typeof document !== "undefined") mountRulesPage(document);
