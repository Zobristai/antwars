// Small DOM helpers for the spectator HUD's agent panel.
import { colonyNameNote } from "../../../src/sim/colonyNames.ts";

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

/**
 * Each colony's ink: its name's colour, set for the page from the match (web/src/colony-palette.ts), else the classic
 * colour. Colonies 2 and 3 play only in a four-colony match, which always carries their names, so they have no classic one.
 */
export const COLONY_INK = ["var(--aw-k0, var(--aw-c0))", "var(--aw-k1, var(--aw-c1))", "var(--aw-k2)", "var(--aw-k3)"] as const;

/**
 * Writes text into node. Where the match drew its colony names (unrated), each of those names in the text is shown in
 * its colony's colour with its one-line source as its tooltip; for any other match the text is written as it always was.
 * Each such name is a span of class aw-colony-name and c0 or c1, which takes the pointer even where its line takes none
 * (ui.css), so hovering it shows its tooltip.
 */
export function setColonyText(doc: Document, node: HTMLElement, text: string, drawn: readonly string[] | undefined): void {
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
    const name = h(doc, "span", `aw-colony-name c${colony}`, drawn[colony]);
    name.style.color = COLONY_INK[colony]!;
    const note = colonyNameNote(drawn[colony]!);
    if (note) name.setAttribute("title", note);
    parts.push(name);
    rest = rest.slice(at + drawn[colony]!.length);
  }
  if (rest) parts.push(rest);
  node.replaceChildren(...parts);
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/**
 * Text for a box that shortens with an ellipsis: each space (or run of spaces) is held to the letter after it in one span
 * of class aw-held, which the box's stylesheet draws as one unit where the box shortens, so the box is never cut right
 * after a space and its ellipsis stands against the last letter shown. The text itself, read and copied, is unchanged.
 */
export function heldSpaces(doc: Document, text: string): (HTMLElement | string)[] {
  const out: (HTMLElement | string)[] = [];
  const letters = [...GRAPHEMES.segment(text)].map(part => part.segment);
  let plain = "";
  for (let i = 0; i < letters.length; i++) {
    if (!/^\s+$/.test(letters[i]!)) { plain += letters[i]; continue; }
    let gap = "";
    while (i < letters.length && /^\s+$/.test(letters[i]!)) gap += letters[i++];
    if (i === letters.length) { plain += gap; break; }
    if (plain) out.push(plain);
    plain = "";
    out.push(h(doc, "span", "aw-held", gap + letters[i]));
  }
  if (plain) out.push(plain);
  return out;
}
