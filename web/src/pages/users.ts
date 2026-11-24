import type { Collection } from "../matches-page/data.ts";
import type { PublicUser } from "../matches-page/users.ts";
import { h } from "../ui/dom.ts";
import { keep, utcStamp } from "../ui/format.ts";
import { loadMoreButton, stateLine } from "./chrome.ts";
import { ratingNodes } from "./identity.ts";
import { whenParts } from "./model.ts";
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
const titleId = "d1p-users-title";
export function usersLedger(doc: Document, search: string) {
  let by: Field = "User", direction = 1, limit = 10;
  function choose(field: Field, order: number) { by = field; direction = order; limit = 10; }
  function value(user: PublicUser, field: Field): Node[] {
    switch (field) {
      case "User": return [h(doc, "strong", undefined, user.username)];
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
  return (data: Collection<PublicUser>, redraw: () => void) => {
    const section = h(doc, "section", "d1p-card users-card"); section.setAttribute("aria-labelledby", titleId);
    const head = h(doc, "div", "d1p-card-head"), title = h(doc, "h2", "d1p-card-title", "Users"); title.id = titleId;
    head.append(title); section.append(head);
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
        head.append(stateLine(doc, failed ? "error" : "ring", failed ? "Users could not be loaded" : "No user has played yet"));
        section.append(h(doc, "p", "users-message", failed ? "The public match records did not load. Refresh to try again." : "A user appears here after its first public match."));
      }
      return section;
    }
    const rows = [...data.rows].sort((a, b) => direction * compare(a, b, by) || a.username.localeCompare(b.username));
    const sort = by === "User" ? direction > 0 ? "A to Z" : "Z to A" : `${by === "Model, self-reported" ? "Model" : by} ${direction > 0 ? "↑" : "↓"}`;
    const count = limit >= rows.length ? `All ${rows.length}` : `${limit} of ${rows.length}`;
    head.append(stateLine(doc, "dot", `${count} ${rows.length === 1 ? "user" : "users"}, ${sort}`));
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
    for (const user of rows.slice(0, limit)) {
      const tr = h(doc, "tr");
      fields.forEach((field, i) => {
        const cell = field === "User" ? h(doc, "th") : h(doc, "td"); if (field === "User") cell.scope = "row";
        cell.className = `field-${i}${primary(field) ? " users-primary" : " users-detail"}`;
        if (field !== "User") { const label = h(doc, "span", "users-label", field); label.setAttribute("aria-hidden", "true"); cell.append(label); }
        const v = h(doc, "div", "users-value"); v.append(...value(user, field)); cell.append(v); tr.append(cell);
      }); tbody.append(tr);
    }
    table.append(tbody); section.append(table);
    const notes = h(doc, "div", "users-notes");
    for (const text of ["Own: a match between one user’s own agents. It counts in Matches, not in the record.", "Ranked 1v1 is the rating on the Leaderboard’s Ranked 1v1 board, not the start rating on match records.", "Models are self-reported by each agent."]) notes.append(h(doc, "p", undefined, text));
    section.append(notes);
    if (rows.length > limit) { const foot = h(doc, "div", "d1p-card-foot"); foot.append(loadMoreButton(doc, "users-more", false, () => { limit += 10; redraw(); })); section.append(foot); }
    return section;
  };
}
