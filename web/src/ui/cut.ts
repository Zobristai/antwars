/**
 * Marks a name box that shortens with an ellipsis while its text is cut. A cut box carries the class aw-cut, for as long
 * as its text is drawn wider than its box, and its stylesheet then draws each held space with the letter after it as one
 * unit (ui/dom.ts heldSpaces), so the box's ellipsis always stands against the last letter shown, never after a space.
 * A whole name carries no class and draws as plain text. Only the text drawn inside the box changes; its size and place
 * on its line do not. Self-contained (no imports), one observer per window, so a page can load it as it is.
 */
const watched = new WeakMap<Window, { observer: ResizeObserver; boxes: Set<HTMLElement> }>();

/** Whether `box`'s text is drawn wider than its content box, by any amount, so the box shows its ellipsis. Text set out
 * of the line (a screen-reader-only part, positioned) is not part of what is drawn, so it is left out. */
function isCut(box: HTMLElement): boolean {
  const view = box.ownerDocument.defaultView!;
  let left = Infinity, right = -Infinity;
  for (const node of box.childNodes) {
    let rect: DOMRect;
    if (node.nodeType === 1) {
      const position = view.getComputedStyle(node as Element).position;
      if (position === "absolute" || position === "fixed") continue;
      rect = (node as Element).getBoundingClientRect();
    } else if (node.nodeType === 3) {
      const range = box.ownerDocument.createRange();
      range.selectNodeContents(node);
      rect = range.getBoundingClientRect();
    } else continue;
    if (rect.width === 0) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  const style = view.getComputedStyle(box);
  const room = box.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
  // A browser lays the box out in fractions of a px (1/64 in Chrome and Safari), so its padding can stand up to one such
  // fraction from the value its style gives; a name that only meets its box is whole.
  return right - left > room + 1 / 64;
}

function mark(box: HTMLElement): void {
  const cut = box.isConnected && isCut(box);
  if (box.classList.contains("aw-cut") !== cut) box.classList.toggle("aw-cut", cut);
}

/** Watches `box`, a name on `doc`'s page, from now on: marked whenever its size changes or a font finishes loading, and
 * let go once it leaves the page. Without a ResizeObserver (the unit-test DOM) it does nothing. */
export function watchCut(doc: Document, box: HTMLElement): void {
  const win = doc.defaultView;
  if (!win || typeof win.ResizeObserver !== "function") return;
  let state = watched.get(win);
  if (!state) {
    const boxes = new Set<HTMLElement>();
    const seen = new WeakSet<HTMLElement>();
    const observer = new win.ResizeObserver(entries => {
      for (const { target } of entries) {
        const node = target as HTMLElement;
        if (node.isConnected) { seen.add(node); mark(node); }
        else if (seen.has(node)) { observer.unobserve(node); boxes.delete(node); }
      }
    });
    state = { observer, boxes };
    watched.set(win, state);
    // A font that loads late redraws a name at the same box size, so its box is marked again then.
    doc.fonts?.addEventListener("loadingdone", () => { for (const node of boxes) mark(node); });
  }
  state.boxes.add(box);
  state.observer.observe(box);
}
