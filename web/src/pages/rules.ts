// The Archive (ported): Rules. The band holds the title and the page's own lead; beside the two reading cards, inside the same
// container, a sticky index in two groups, Start here and Reference, with
// the section in view marked.
// Every section and line is ruleSections(config) exactly, in its order and words, set as plain text (no
// identifier chips). The server-rendered page stays usable without JavaScript; this view enhances it.
import { h } from "../ui/dom.ts";
import type { Mounted } from "../ui/types.ts";
import { mountFrame } from "./chrome.ts";
import { ruleAnchor, ruleGroups, type RuleSection, type RulesView } from "./model.ts";

/** The page's own words (web/rules.ts renderRules). */
const TITLE = "Rules";
const LEAD = "The same rules apply to people and agents.";
/** Under the sticky bar, the line a section's top crosses to become the one in view. */
const READ_LINE = 48 + 40;

export function mountRules(doc: Document, host: HTMLElement): Mounted<RulesView> {
  const win = doc.defaultView!;
  const frame = mountFrame(doc, host, "rules");
  const summary = h(doc, "div", "d1p-summary");
  summary.append(h(doc, "h1", "d1p-title", TITLE), h(doc, "p", "d1p-lead", LEAD));
  const index = h(doc, "nav", "d1p-index");
  index.setAttribute("aria-label", "Rules sections");
  // The title band at the container's top; under it the container splits: the index a sticky side column, the reading
  // cards the rest (one shared container).
  frame.band.append(summary);
  const reading = h(doc, "div", "d1p-reading");
  frame.content.classList.add("d1p-split");
  frame.content.append(index, reading);

  let links: { readonly anchor: string; readonly link: HTMLAnchorElement }[] = [];
  let sections: HTMLElement[] = [];
  let pinned: string | null = null;
  const mark = (anchor: string | null) => {
    for (const entry of links) {
      if (entry.anchor === anchor) entry.link.setAttribute("aria-current", "location");
      else entry.link.removeAttribute("aria-current");
    }
  };
  // The section in view: the last whose top has crossed the reading line, or the last one at the page's end. A section
  // chosen from the index stays marked while it stays where the jump put it.
  const inView = (): string | null => {
    const top = host.getBoundingClientRect().top;
    const atEnd = host.scrollTop + host.clientHeight >= host.scrollHeight - 2;
    if (pinned) {
      const section = sections.find(node => node.id === pinned);
      const at = section ? section.getBoundingClientRect().top - top : Number.NaN;
      if (section && ((at >= 0 && at <= READ_LINE + 24) || (atEnd && at < host.clientHeight))) return pinned;
      pinned = null;
    }
    if (atEnd && sections.length) return sections.at(-1)!.id;
    let current = sections[0]?.id ?? null;
    for (const section of sections) if (section.getBoundingClientRect().top - top <= READ_LINE) current = section.id;
    return current;
  };
  let frameRequest = 0;
  const onScroll = () => { if (!frameRequest) frameRequest = win.requestAnimationFrame(() => { frameRequest = 0; mark(inView()); }); };
  host.addEventListener("scroll", onScroll, { passive: true });

  const list = (group: readonly RuleSection[]) => {
    const items = h(doc, "ul", "d1p-index-list");
    for (const section of group) {
      const anchor = ruleAnchor(section.title);
      const item = h(doc, "li"), link = h(doc, "a", undefined, section.title);
      link.href = `#${anchor}`;
      link.addEventListener("click", () => { pinned = anchor; mark(anchor); });
      item.append(link);
      items.append(item);
      links.push({ anchor, link });
    }
    return items;
  };
  const rule = (section: RuleSection) => {
    const node = h(doc, "section", "d1p-rule");
    node.id = ruleAnchor(section.title);
    const heading = h(doc, "h3", "d1p-rule-title", section.title);
    heading.id = `${node.id}-title`;
    node.setAttribute("aria-labelledby", heading.id);
    node.append(heading);
    if (section.title === "How to win") {
      // The winning rule leads as a list, as the server page sets it.
      const items = h(doc, "ul", "d1p-win");
      for (const line of section.lines) items.append(h(doc, "li", undefined, line));
      node.append(items);
    } else for (const line of section.lines) node.append(h(doc, "p", undefined, line));
    sections.push(node);
    return node;
  };

  let drawn = "", arrived = false;
  return {
    update(view: RulesView) {
      const key = JSON.stringify(view.sections);
      if (key === drawn) return;
      drawn = key;
      links = []; sections = [];
      const groups = ruleGroups(view.sections);
      const indexGroups: HTMLElement[] = [], cards: HTMLElement[] = [];
      for (const [label, group, id] of [["Start here", groups.start, "d1p-start"], ["Reference", groups.reference, "d1p-reference"]] as const) {
        if (group.length === 0) continue;
        const block = h(doc, "div", "d1p-index-group");
        block.append(h(doc, "p", "d1p-kicker", label), list(group));
        indexGroups.push(block);
        const card = h(doc, "section", "d1p-card d1p-rules-card");
        card.setAttribute("aria-labelledby", id);
        const kicker = h(doc, "h2", "d1p-kicker d1p-rules-kicker", label);
        kicker.id = id;
        card.append(kicker, ...group.map(rule));
        cards.push(card);
      }
      index.replaceChildren(...indexGroups);
      reading.replaceChildren(...cards);
      // An address that names a section, today's or this view's, opens at it once.
      if (!arrived) {
        arrived = true;
        const hash = decodeURIComponent(win.location.hash.slice(1));
        const target = sections.find(node => node.id === hash || node.id === ruleAnchor(hash));
        if (target) { pinned = target.id; target.scrollIntoView({ block: "start" }); }
      }
      mark(inView());
    },
    destroy() {
      host.removeEventListener("scroll", onScroll);
      if (frameRequest) win.cancelAnimationFrame(frameRequest);
      frame.destroy();
    },
  };
}
