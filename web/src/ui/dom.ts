// Small DOM helpers for the spectator HUD's agent panel.
import { colonyNameNote, type ColonyNamePair } from "../../../src/sim/colonyNames.ts";

export function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Write only what changed, so an update at rest touches nothing (updates arrive every frame on the HUD). */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

const markup = new WeakMap<Element, string>();
/** Trusted inline SVG from the HUD's own glyph and icon helpers, written only when its source string changes. */
export function setMarkup(node: Element, html: string): void {
  if (markup.get(node) === html) return;
  markup.set(node, html);
  node.innerHTML = html;
}

/** Each colony's ink: its name's colour, set for the page from the match (web/src/colony-palette.ts), else the classic colour. */
export const COLONY_INK = ["var(--aw-k0, var(--aw-c0))", "var(--aw-k1, var(--aw-c1))"] as const;

/**
 * Writes text into node. Where the match drew its colony names (unrated), each of those names in the text is shown in
 * its colony's colour with its one-line source as its tooltip; for any other match the text is written as it always was.
 * Each such name is a span of class aw-colony-name, which takes the pointer even where its line takes none (ui.css), so
 * hovering it shows its tooltip.
 */
export function setColonyText(doc: Document, node: HTMLElement, text: string, drawn: ColonyNamePair | undefined): void {
  if (!drawn) {
    // A name shown earlier in its colour (another match on this page) gives way to plain text.
    if (node.children.length > 0) node.textContent = text;
    else setText(node, text);
    return;
  }
  const parts: (Node | string)[] = [];
  let rest = text;
  for (;;) {
    let at = -1, colony = 0;
    drawn.forEach((name, c) => { const i = rest.indexOf(name); if (i >= 0 && (at < 0 || i < at)) { at = i; colony = c; } });
    if (at < 0) break;
    if (at > 0) parts.push(rest.slice(0, at));
    const name = h(doc, "span", "aw-colony-name", drawn[colony]);
    name.style.color = COLONY_INK[colony]!;
    const note = colonyNameNote(drawn[colony]!);
    if (note) name.setAttribute("title", note);
    parts.push(name);
    rest = rest.slice(at + drawn[colony]!.length);
  }
  if (rest) parts.push(rest);
  node.replaceChildren(...parts);
}
