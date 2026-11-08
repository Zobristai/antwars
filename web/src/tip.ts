/**
 * A tooltip in the page's own type, above every panel, never clipped: the hover or tap details of a mark's marker (web/src/words.ts tipContent) or of a squad's
 * badge (web/src/squads.ts tipContent), as an HTML plate the page places beside what was pointed at
 * with no leader (compose.ts tipRect: centred above it, below it at the screen's top, clamped across
 * the screen), taking no space in the board's layout. Rows that do not fit the
 * taller of the free spaces above and below the target give way to one "+N more" line
 * (compose.ts tipFit), measured from the plate's own rows. It takes no pointer, so the board under
 * it keeps the hover; its edge is in the owner's shade (web/index.html .aw-tip).
 */
import { tipFit, tipRect } from "./compose.ts";
import { cssColour } from "./squads.ts";
import type { Rect, TipContent } from "./words.ts";

/** The space between the plate's rows, and its padding top and bottom together, as the CSS sets them. */
export const TIP_ROW_GAP = 5;
export const TIP_PAD = 14;
/** The plate keeps this clear of the screen's edge above and below its target. */
const EDGE = 8;

function el(cls: string): HTMLDivElement {
  const e = document.createElement("div");
  e.className = cls;
  return e;
}

export class Tooltip {
  readonly el: HTMLDivElement;
  private readonly more: HTMLDivElement;
  private rows: { row: HTMLDivElement; head: HTMLSpanElement; body: HTMLSpanElement; meta: HTMLSpanElement }[] = [];
  /** The text shown, so the same content is only moved; its rows' measured heights; how many show; the plate's size. */
  private key = "";
  private heights: number[] = [];
  private moreH = 0;
  private shown = -1;
  private size: [number, number] = [0, 0];
  /** The plate's box on screen while shown, for checks of what is on screen; null while hidden. */
  rect: Rect | null = null;

  constructor(parent: HTMLElement) {
    this.el = el("aw-tip");
    this.el.hidden = true;
    this.el.setAttribute("role", "tooltip");
    this.more = el("aw-tip-more");
    this.el.append(this.more);
    parent.append(this.el);
  }

  /** Show `content` beside its target on a screen of this size, or move the same content to its target. */
  show(content: TipContent, screen: { w: number; h: number }): void {
    const key = `${content.colour}|${content.rows.map((r) => `${r.head}\n${r.body}\n${r.meta}`).join("\u0000")}`;
    if (key !== this.key) {
      this.key = key;
      this.write(content);
    }
    // The rows that fit the taller free space beside the target, else the most that fit above one "+N more" line.
    const t = content.target;
    const shown = tipFit(this.heights, TIP_ROW_GAP, TIP_PAD, this.moreH, Math.max(t.y0, screen.h - t.y1) - EDGE);
    if (shown !== this.shown) {
      this.shown = shown;
      this.rows.forEach((r, i) => (r.row.hidden = i >= shown));
      const cut = shown < this.rows.length;
      this.more.hidden = !cut;
      if (cut) this.more.textContent = `+${this.rows.length - shown} more`;
      this.size = [this.el.offsetWidth, this.el.offsetHeight];
    }
    const r = tipRect(t, this.size[0], this.size[1], screen);
    if (this.rect === null || r.x0 !== this.rect.x0 || r.y0 !== this.rect.y0) {
      this.el.style.left = `${r.x0}px`;
      this.el.style.top = `${r.y0}px`;
    }
    this.rect = r;
  }

  hide(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.rect = null;
    this.key = "";
    this.shown = -1;
  }

  /** Write the content's rows, in its colour, and measure each row and the "+N more" line, every row shown. */
  private write(content: TipContent): void {
    while (this.rows.length > content.rows.length) this.rows.pop()!.row.remove();
    while (this.rows.length < content.rows.length) {
      const row = el("aw-tip-row");
      const [head, body, meta] = ["aw-tip-head", "aw-tip-body", "aw-tip-meta"].map((cls) => {
        const s = document.createElement("span");
        s.className = cls;
        return s;
      }) as [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];
      row.append(head, body, meta);
      this.el.insertBefore(row, this.more);
      this.rows.push({ row, head, body, meta });
    }
    content.rows.forEach((c, i) => {
      const r = this.rows[i]!;
      for (const [e, text] of [[r.head, c.head], [r.body, c.body], [r.meta, c.meta]] as const) {
        if (e.textContent !== text) e.textContent = text;
        e.hidden = text === "";
      }
      r.row.hidden = false;
    });
    this.el.style.color = cssColour(content.colour);
    this.el.hidden = false;
    this.more.hidden = false;
    this.more.textContent = `+${content.rows.length} more`;
    this.heights = this.rows.map((r) => r.row.offsetHeight);
    this.moreH = this.more.offsetHeight;
    this.shown = -1;
  }
}
