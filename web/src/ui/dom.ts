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

/** One letter as the reader sees it, where the browser has no Intl.Segmenter (Firefox before 125, Safari before 14.5): a
 * pair of regional indicators (a flag), a run of conjoining Hangul jamo, or a character with the marks, emoji modifiers
 * and tag characters after it, joined by zero-width joiners to the next such character, so no letter is split. */
const LETTER = /\p{RI}{2}|[\u1100-\u115f]+[\u1160-\u11a7]*[\u11a8-\u11ff]*|[^](?:[\p{M}\p{Emoji_Modifier}\u{e0020}-\u{e007f}])*(?:\u200d[^](?:[\p{M}\p{Emoji_Modifier}\u{e0020}-\u{e007f}])*)*/gu;
let splitLetters: ((text: string) => string[]) | undefined;
/** `text` split into letters: by the browser's Intl.Segmenter where it has one, made on first use, otherwise by LETTER. */
function letters(text: string): string[] {
  if (!splitLetters) {
    if (typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      splitLetters = value => Array.from(segmenter.segment(value), part => part.segment);
    } else splitLetters = value => value.match(LETTER) ?? [];
  }
  return splitLetters(text);
}
/**
 * Text for a box that shortens with an ellipsis: each space (or run of spaces) is held to the letter after it in one span
 * of class aw-held, which the box's stylesheet draws as one unit while the box is cut (ui/cut.ts), so the box is never cut
 * right after a space and its ellipsis stands against the last letter shown. Spaces at the end of the text have no letter
 * after them and are not drawn; the box's title keeps the text whole.
 */
export function heldSpaces(doc: Document, text: string): (HTMLElement | string)[] {
  const out: (HTMLElement | string)[] = [];
  const parts = letters(text);
  let plain = "";
  for (let i = 0; i < parts.length; i++) {
    if (!/^\s+$/.test(parts[i]!)) { plain += parts[i]; continue; }
    let gap = "";
    while (i < parts.length && /^\s+$/.test(parts[i]!)) gap += parts[i++];
    if (i === parts.length) break;
    if (plain) out.push(plain);
    plain = "";
    out.push(h(doc, "span", "aw-held", gap + parts[i]));
  }
  if (plain) out.push(plain);
  return out;
}

/**
 * The least a name run shortened with an ellipsis may show: its first letter (with any spaces held before it) and the
 * ellipsis, drawn as the run draws them. The run's box never shrinks below it (archive.css and top-match-tile.css draw it,
 * unseen, in the box's own place), so a run cut to its first letter always shows its whole ellipsis, in any font.
 */
export function leastShown(text: string): string {
  const parts = letters(text);
  let lead = "";
  for (const part of parts) {
    lead += part;
    if (!/^\s+$/.test(part)) break;
  }
  return `${lead}\u2026`;
}
