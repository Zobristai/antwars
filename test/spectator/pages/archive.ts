// Reading the Archive pages back from the test DOM port: what each Leaderboard card says and holds.
import { C } from "../../../web/src/leaderboard-page/copy.ts";
import type { ElementPort } from "./dom.ts";

/** A table's own state, read from its state line where it has one: loading, complete (empty) or failed. A ready table
 * with rows has no state line; leaderboardCards reads it as partial or complete from its Load more. */
export function settledOf(state: string): "loading" | "complete" | "failed" | undefined {
  if (state.includes(C.tableLoading)) return "loading";
  if (state.includes(C.tableEmpty)) return "complete";
  if (state.includes(C.tableFailed)) return "failed";
  return undefined;
}

/** A name cell as a reader sees it: the name, each badge as [badge], then a quiet thinking level after a space. */
export function nameText(cell: ElementPort): string {
  return cell.children.map(part => part.classes().includes("d1p-tags") ? part.children.map(tag => `[${tag.textContent}]`).join(" ") : part.textContent).join(" ");
}

/** Every ranking card the page shows, read from its wide table (the stacked rows carry the same rows). */
export function leaderboardCards(root: ElementPort) {
  return root.byClass("d1p-card").filter(card => !card.classes().includes("d1p-notice")).map(section => {
    const table = section.querySelector("table");
    const lines = table?.querySelector("tbody")?.children.filter(() => table.getAttribute("aria-hidden") !== "true") ?? [];
    const state = section.querySelector(".d1p-state")?.textContent ?? "";
    const heading = section.querySelector(".d1p-card-title")!;
    // The count stands beside the title, inside its heading: the title is the heading's text before it.
    const count = heading.querySelector(".d1p-count")?.textContent ?? null;
    const more = section.all().find(node => node.tag === "button" && node.dataset.key?.startsWith("more-")) ?? null;
    return {
      section, table,
      title: count === null ? heading.textContent : heading.textContent.slice(0, -(count.length + 1)),
      count,
      names: lines.map(line => line.children[1]!.children[0]!.textContent),
      named: lines.map(line => nameText(line.children[1]!)),
      cells: lines.map(line => line.children.map(cell => cell.textContent)),
      state, settled: state === "" ? (more ? "partial" as const : "complete" as const) : settledOf(state),
      busy: section.getAttribute("aria-busy"),
      more,
    };
  });
}
