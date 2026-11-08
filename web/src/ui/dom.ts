// Small DOM helpers for the spectator HUD's agent panel.

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
