import type { Collection } from "../matches-page/data.ts";
import type { PublicUser } from "../users-page/data.ts";
import { h } from "../ui/dom.ts";
import { keep, recordingType, utcStamp } from "../ui/format.ts";
import { userName } from "../ui/user-link.ts";
import { badgeWords } from "../leaderboard-page/view.ts";
import { stateLine } from "./chrome.ts";
import { ratingNodes } from "./identity.ts";
import { recordedPlayer, whenParts } from "./model.ts";
import "./users.css";

const fields = ["User", "Agents", "Matches", "Record", "Ranked 1v1", "Model, self-reported", "Last played"] as const;
type Field = typeof fields[number];
const primary = (f: Field) => f === "User" || f === "Matches" || f === "Record";
const initial = (f: Field) => f === "User" || f === "Agents" || f === "Model, self-reported" ? 1 : -1;
function compare(a: PublicUser, b: PublicUser, by: Field) {
  switch (by) {
    case "User": return a.username.localeCompare(b.username);
    case "Agents": return a.agents.join(", ").localeCompare(b.agents.join(", "));
    case "Matches": return a.matches - b.matches;
    case "Record": return a.wins - b.wins || b.losses - a.losses;
    case "Ranked 1v1": return (a.ranked?.rating ?? -Infinity) - (b.ranked?.rating ?? -Infinity);
    case "Model, self-reported": return (a.model ?? "").localeCompare(b.model ?? "");
    case "Last played": return a.latest.startedAt.localeCompare(b.latest.startedAt);
  }
}
const titleId = "roster-title";
export function usersRoster(doc: Document, search: string, toggle: (name: string | null) => void) {
  let by: Field = "User", direction = 1;
  function choose(field: Field, order: number) { by = field; direction = order; }
  function value(user: PublicUser, field: Field, open: boolean): Node[] {
    switch (field) {
      case "User": {
        const link = userName(doc, user.username, user.username, "users-entry");
        link.dataset.key = `user|${user.username}`;
        link.setAttribute("aria-expanded", String(open));
        link.addEventListener("click", event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); toggle(open ? null : user.username);
        });
        return [link];
      }
      case "Matches": return [h(doc, "span", undefined, String(user.matches))];
      case "Record": return [h(doc, "span", undefined, `${user.wins}–${user.losses}`), ...(user.own ? [h(doc, "small", "users-own", `+${user.own} own`)] : [])];
      case "Agents": return user.agents.map((agent, i) => h(doc, "span", `users-agent${i ? " is-next" : ""}`, agent));
      case "Ranked 1v1": {
        if (!user.ranked) return [h(doc, "span", "users-muted", "Not ranked")];
        const nodes = ratingNodes(doc, user.ranked);
        if (user.ranked.via) nodes.push(h(doc, "small", "users-via", `via ${user.ranked.via}`));
        return nodes;
      }
      case "Model, self-reported": return [h(doc, "span", user.model ? undefined : "users-muted", user.model ?? "No model reported"), ...(user.moreModels ? [h(doc, "small", "users-more-models", `+${user.moreModels} more`)] : [])];
      case "Last played": {
        const date = whenParts(utcStamp(user.latest.startedAt) ?? "Start unknown").date;
        const link = h(doc, "a", "users-replay", date); link.href = keep(`/?replay=${encodeURIComponent(user.latest.id)}`, search);
        link.dataset.key = `users|replay|${user.username}`;
        link.setAttribute("aria-label", `${user.username}, replay from ${date}`); return [link];
      }
    }
  }
  return (data: Collection<PublicUser>, requested: string | null, redraw: () => void) => {
    const section = h(doc, "section", "d1p-card users-card"); section.setAttribute("aria-labelledby", titleId);
    const head = h(doc, "div", "d1p-card-head"); section.append(head);
    const present = data.rows.some(user => user.username.toLowerCase() === requested?.toLowerCase());
    if (requested && data.status === "ready" && !present) head.append(h(doc, "p", "users-message", `No user named ${requested} is listed. The name was released, or has not played a public match yet. All users are below.`));
    if (data.status !== "ready" || !data.rows.length) {
      if (data.status === "loading") {
        head.append(stateLine(doc, "ring", "Loading users"));
        for (let i = 0; i < 4; i++) {
          const line = h(doc, "div", "users-skeleton"); line.setAttribute("aria-hidden", "true");
          for (let j = 0; j < 3; j++) line.append(h(doc, "span", "d1p-skel"));
          section.append(line);
        }
      } else {
        const failed = data.status === "error";
        const full = failed ? "Users could not be loaded" : "No user has played yet";
        const line = stateLine(doc, failed ? "error" : "ring", full);
        line.classList.add("users-fit-state"); line.dataset.full = full;
        line.dataset.short = failed ? "Users unavailable" : "No users yet";
        head.append(line);
        section.append(h(doc, "p", "users-message", failed ? "Refresh to try again." : "A user is listed here after its first public match."));
      }
      return section;
    }
    const rows = [...data.rows].sort((a, b) => direction * compare(a, b, by) || a.username.localeCompare(b.username));
    const sort = by === "User" ? direction > 0 ? "A to Z" : "Z to A" : `${by === "Model, self-reported" ? "Model" : by} ${direction > 0 ? "↑" : "↓"}`;
    head.append(stateLine(doc, "dot", `All ${rows.length} ${rows.length === 1 ? "user" : "users"}, ${sort}`));
    const select = h(doc, "select", "users-sort"); select.dataset.key = "users-sort"; select.setAttribute("aria-label", "Sort users");
    for (const field of fields) for (const order of [initial(field), -initial(field)]) {
      const label = field === "Model, self-reported" ? "Model" : field;
      const option = h(doc, "option", undefined, `Sort: ${label}${order === initial(field) ? "" : " (reverse)"}`);
      option.value = `${fields.indexOf(field)}:${order}`; option.selected = field === by && order === direction; select.append(option);
    }
    select.addEventListener("change", () => { const [index, order] = select.value.split(":").map(Number); choose(fields[index]!, order); redraw(); });
    head.append(select);
    const table = h(doc, "table", "users-table"); table.setAttribute("aria-labelledby", titleId);
    const thead = h(doc, "thead"), heads = h(doc, "tr");
    fields.forEach((field, i) => {
      const th = h(doc, "th", `field-${i}`); th.scope = "col";
      const button = h(doc, "button", undefined, field); button.type = "button"; button.dataset.key = `users-head-${i}`;
      if (field === by) th.setAttribute("aria-sort", direction > 0 ? "ascending" : "descending");
      button.addEventListener("click", () => { choose(field, by === field ? -direction : initial(field)); redraw(); });
      th.append(button); heads.append(th);
    });
    thead.append(heads); table.append(thead);
    const tbody = h(doc, "tbody");
    for (const user of rows) {
      const open = user.username.toLowerCase() === requested?.toLowerCase();
      const tr = h(doc, "tr"); if (open) tr.className = "users-open";
      fields.forEach((field, i) => {
        const cell = field === "User" ? h(doc, "th") : h(doc, "td"); if (field === "User") cell.scope = "row";
        cell.className = `field-${i}${primary(field) ? " users-primary" : " users-detail"}`;
        if (field !== "User") { const label = h(doc, "span", "users-label", field === "Model, self-reported" ? "Model" : field); label.setAttribute("aria-hidden", "true"); cell.append(label); }
        const v = h(doc, "div", "users-value"); v.append(...value(user, field, open)); cell.append(v); tr.append(cell);
      }); tbody.append(tr);
      if (open) {
        const row = h(doc, "tr", "users-panel"), cell = h(doc, "td"); cell.colSpan = fields.length;
        cell.append(panel(doc, user, search, () => toggle(null))); row.append(cell); tbody.append(row);
      }
    }
    table.append(tbody); section.append(table);
    const notes = h(doc, "div", "users-notes");
    notes.append(h(doc, "p", undefined, "Public matches only. Ranked 1v1 is the user’s own rating or, where it has none, its highest-rated agent’s. Models are self-reported."));
    section.append(notes);
    return section;
  };
}

function panel(doc: Document, user: PublicUser, search: string, close: () => void) {
  const details = h(doc, "div", "users-details"), agents = h(doc, "section"), matches = h(doc, "section");
  agents.append(h(doc, "h3", "d1p-kicker", "Agents"));
  for (const agent of user.agentDetails) {
    const group = h(doc, "p"); group.append(h(doc, "strong", undefined, agent.handle), h(doc, "small", undefined,
      `${agent.matches} ${agent.matches === 1 ? "match" : "matches"} · ${agent.models.join(" · ") || "No model reported"}`)); agents.append(group);
  }
  matches.append(h(doc, "h3", "d1p-kicker", "Last 5 matches"));
  const heads = h(doc, "div", "users-match users-match-head"); heads.setAttribute("aria-hidden", "true");
  for (const title of ["Time", "Game type", "Agent", "Opponent", "Result"]) heads.append(h(doc, "span", "d1p-kicker", title));
  matches.append(heads);
  for (const r of user.recent) {
    const row = h(doc, "div", "users-match"), opposition = h(doc, "span", "users-opposition");
    const distinct = new Set<string>();
    for (const opponent of r.opponents) {
      const key = JSON.stringify(opponent); if (distinct.has(key)) continue; distinct.add(key);
      if (distinct.size > 1) opposition.append(", ");
      const p = recordedPlayer(opponent);
      if (p.user) opposition.append(userName(doc, p.user, p.user));
      else { opposition.append(p.model ?? "Unknown"); for (const badge of badgeWords(p.badges)) opposition.append(" ", h(doc, "span", "d1p-tag", badge)); }
    }
    if (!r.opponents.length) opposition.append("Unknown");
    const replay = h(doc, "a", "users-replay", "Replay"); replay.href = keep(`/?replay=${encodeURIComponent(r.id)}`, search);
    const stamp = utcStamp(r.startedAt) ?? "Start unknown";
    replay.setAttribute("aria-label", `Replay from ${stamp}`);
    const time = h(doc, "span", "users-time");
    for (const word of stamp.split(" · ")) time.append(h(doc, "span", undefined, word));
    row.append(time, h(doc, "span", "users-kind", recordingType(r.matchType, r.colonies)?.replace(" · ", " ") ?? "Unknown"),
      h(doc, "span", "users-as", r.agents.join(", ")), opposition, h(doc, "span", "users-result", r.result), replay);
    matches.append(row);
  }
  const foot = h(doc, "div", "users-detail-foot");
  if (user.own) foot.append(h(doc, "span", undefined, `${user.own} of these ${user.matches} matches ${user.own === 1 ? "was" : "were"} between this user’s own agents. It counts in Matches, not in Record.`));
  const button = h(doc, "button", "d2-pill", "Close"); button.type = "button"; button.addEventListener("click", close); foot.append(button);
  details.append(agents, matches, foot); return details;
}
