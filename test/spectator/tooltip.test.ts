/**
 * The page's tooltip (web/src/tip.ts): the hover or tap details of a mark or a
 * squad drawn as an HTML plate in the page's own type, beside what was pointed at, inside the screen, rows that do
 * not fit giving way to one "+N more" line, on a fake DOM whose rows measure as the test says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIP_PAD, TIP_ROW_GAP, Tooltip } from "../../web/src/tip.ts";
import { tipHeight } from "../../web/src/compose.ts";

/** The element operations the tooltip uses; a row is ROW px tall while shown, the more line MORE, the plate their sum with its gaps and padding. */
const ROW = 37;
const MORE = 17;
class Element {
  className = "";
  hidden = false;
  textContent = "";
  style: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  private parent: Element | null = null;
  append(...nodes: Element[]) {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }
  insertBefore(node: Element, before: Element) {
    node.parent = this;
    this.children.splice(this.children.indexOf(before), 0, node);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  get offsetHeight(): number {
    if (this.hidden) return 0;
    if (this.className === "aw-tip-row") return ROW;
    if (this.className === "aw-tip-more") return MORE;
    return tipHeight(this.children.filter((c) => !c.hidden).map((c) => c.offsetHeight), TIP_ROW_GAP, TIP_PAD);
  }
  get offsetWidth(): number {
    return this.hidden ? 0 : 200;
  }
  all(cls: string): Element[] {
    return this.children.flatMap((node) => [...(node.className === cls ? [node] : []), ...node.all(cls)]);
  }
}

beforeEach(() => vi.stubGlobal("document", { createElement: () => new Element() }));
afterEach(() => vi.unstubAllGlobals());

const row = (i: number) => ({ head: `MARK ${i}`, body: `gloss ${i}`, meta: `by Diamond, ${i}s ago` });

describe("the page's tooltip", () => {
  it("shows its rows in the page's type beside the target, inside the screen, in the owner's colour, and goes when hidden", () => {
    const parent = new Element();
    const tip = new Tooltip(parent as unknown as HTMLElement);
    const el = parent.children[0]!;
    expect(el.className).toBe("aw-tip");
    expect(el.hidden).toBe(true);
    expect(el.attributes.get("role")).toBe("tooltip");
    tip.show({ target: { x0: 190, y0: 400, x1: 210, y1: 420 }, colour: 0xffb000, rows: [row(1), { head: "Diamond", body: "", meta: "" }] }, { w: 390, h: 844 });
    expect(el.hidden).toBe(false);
    expect(el.style.color).toBe("#ffb000");
    const rows = el.all("aw-tip-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.children.map((c) => [c.className, c.textContent, c.hidden])).toEqual([["aw-tip-head", "MARK 1", false], ["aw-tip-body", "gloss 1", false], ["aw-tip-meta", "by Diamond, 1s ago", false]]);
    // A line with nothing to say takes no row of its own.
    expect(rows[1]!.children.map((c) => c.hidden)).toEqual([false, true, true]);
    expect(el.all("aw-tip-more")[0]!.hidden).toBe(true);
    // Centred above the target (compose.ts tipRect), the whole plate on the screen.
    const h = tipHeight([ROW, ROW], TIP_ROW_GAP, TIP_PAD);
    expect(tip.rect).toEqual({ x0: 100, y0: 400 - 6 - h, x1: 300, y1: 400 - 6 });
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe(`${400 - 6 - h}px`);
    tip.hide();
    expect(el.hidden).toBe(true);
    expect(tip.rect).toBeNull();
  });

  it("keeps twelve marks' rows to the taller free space beside the target with a '+N more' line, and moves the same content without rewriting it", () => {
    const parent = new Element();
    const tip = new Tooltip(parent as unknown as HTMLElement);
    const el = parent.children[0]!;
    const content = { target: { x0: 410, y0: 180, x1: 430, y1: 200 }, colour: 0x00c2ff, rows: Array.from({ length: 12 }, (_, i) => row(i + 1)) };
    const screen = { w: 844, h: 390 };
    tip.show(content, screen);
    // Rows of 37 px with 5 px gaps and 14 px padding: three rows and the more line (157 px) fit the 172 px free above the
    // target (the taller space, 8 px kept from the screen's edge); a fourth (199 px) would not.
    const rows = el.all("aw-tip-row");
    expect(rows.filter((r) => !r.hidden)).toHaveLength(3);
    const more = el.all("aw-tip-more")[0]!;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe("+9 more");
    const h = tipHeight([ROW, ROW, ROW], TIP_ROW_GAP, TIP_PAD, MORE);
    expect(h).toBe(157);
    expect(tip.rect!.y1 - tip.rect!.y0).toBe(h);
    expect(tip.rect!.y0).toBeGreaterThanOrEqual(0);
    expect(tip.rect!.y1).toBeLessThanOrEqual(180);
    expect(tip.rect!.x0).toBeGreaterThanOrEqual(0);
    expect(tip.rect!.x1).toBeLessThanOrEqual(screen.w);
    // The same content at a moved target: only the plate moves; its rows are the same elements.
    tip.show({ ...content, target: { x0: 600, y0: 300, x1: 620, y1: 320 } }, screen);
    expect(el.all("aw-tip-row")).toEqual(rows);
    expect(tip.rect!.x0).toBe(510);
    // Content with an age moved on: the rows are re-texted in place.
    tip.show({ ...content, rows: content.rows.map((r) => ({ ...r, meta: r.meta.replace("s ago", "0s ago") })) }, screen);
    expect(el.all("aw-tip-row")).toEqual(rows);
    expect(rows[0]!.children[2]!.textContent).toBe("by Diamond, 10s ago");
    // Nearer the bottom edge, with 352 px of room above: seven rows and the more line (325 px) fit, an eighth (367 px) not.
    tip.show({ ...content, target: { x0: 410, y0: 360, x1: 430, y1: 380 } }, screen);
    expect(el.all("aw-tip-row").filter((r) => !r.hidden)).toHaveLength(7);
    expect(more.textContent).toBe("+5 more");
    // On a desktop's height every row fits and the more line goes.
    tip.show({ ...content, target: { x0: 410, y0: 700, x1: 430, y1: 720 } }, { w: 1920, h: 1080 });
    expect(el.all("aw-tip-row").filter((r) => !r.hidden)).toHaveLength(12);
    expect(more.hidden).toBe(true);
  });
});
