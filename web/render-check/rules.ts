/**
 * The in-page rules the render check judges every surface by. judgePage runs inside the page (page.evaluate),
 * so it must use nothing outside its own body. Every finding names its rule, the element (class path and text)
 * and the measure that broke the rule, with the element's box in page pixels for the marked render.
 *
 * Fails:
 * - wrap: a one-line item (a block holding only inline content, or a row of flex items, outside prose and headings;
 *   every label, button, table heading and designated one-line title, wherever it stands and however long) laid out on 2+ rendered lines,
 *   explicit breaks included. A part positioned out of the line (a tooltip) is not a line; a heading cell built of
 *   stacked blocks (a date over its time) is judged block by block. A row of icon-only items (a colony's seat badges:
 *   no text, two or more images or controls holding one) is a one-line item too, even as controls allowed to wrap
 * - clipped / cut / offscreen: text cut by an overflow box (its own or an ancestor's), an ellipsis, or the viewport's
 *   sides; an image, board or control cut by an overflow box or the viewport. Each axis is judged on its own: a box
 *   that scrolls on an axis cuts nothing on it (the reader scrolls), and past it the content counts where scrolling
 *   brings it
 * - sideways / page-wider: a scroller with sideways overflow (of text, an image or anything else), or a page wider
 *   than the viewport
 * - row-uneven / grid-uneven: tiles of one kind (2+ in a grid, one column or several) of unequal height, in a row or
 *   across the grid, in one column as in several, whatever the tiles hold (a heading and a paragraph included)
 * - tile-empty: an empty band inside such a tile taller than 1.5 lines of its text (stacked player centering below)
 * - part-uneven: a tile part shown on some tiles of the grid but not others
 * - page-empty: an empty horizontal band on the page taller than the text-scaled band limit
 * - column-start: in a table whose head and row cells carry their column's key (data-col, inside [data-col-table]), a
 *   row cell whose first text starts more than RULE_LIMITS.columnSlackPx from its column head's text. With the head
 *   hidden (a phone's stacked rows), a key's cells must start at one x, except a cell that continues a line another keyed
 *   cell of its row starts. Such a table's rows are table rows, not tiles: they may differ in height and in which parts
 *   they show, so the tile rules do not judge them; every other rule does
 * Lists, without failing:
 * - tight: a one-line item with under RULE_LIMITS.tightSpare of its width to spare
 *
 * Every finding carries its extent (how far it breaks the rule: lines, or px, or tiles missing a part), so a held
 * finding that gets worse is new. judgePage also leaves each finding's element in window.__renderCheckAnchors, so the
 * marked renders can be taken by scrolling the judged layout rather than by laying it out again.
 */

export const RULE_IDS = ["wrap", "clipped", "cut", "offscreen", "sideways", "page-wider", "row-uneven", "grid-uneven",
  "tile-empty", "part-uneven", "page-empty", "column-start", "tight"] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const RULE_LIMITS = {
  /** The largest designed gap on main is 45 px; the band the Top matches review rejected measured 60 px. */
  pageBandPx: 48,
  /** An empty band inside a tile may be at most this many lines of the tile's text. */
  tileBandLines: 1.5,
  /** Two tiles count as the same height within this many px. */
  heightSlackPx: 1,
  /** A one-line item with less than this share of its width spare is listed as a tight fit. */
  tightSpare: 0.08,
  /** A column's cells may start this many px from its head's text (subpixel layout). */
  columnSlackPx: 0.5,
} as const;

export interface Box { x: number; y: number; w: number; h: number }
/** Where a finding's box sits against its element (window.__renderCheckAnchors[index]), in px. */
export interface Anchor { index: number; dx: number; dy: number }
export interface Finding {
  rule: RuleId; element: string; text: string; measure: string;
  /** How far the rule is broken: lines for wrap, tiles missing the part for part-uneven, otherwise px. */
  extent: number;
  box: Box | null; anchor?: Anchor; spare?: number;
}
export interface PageJudgement { failures: Finding[]; tight: Finding[]; counted: { items: number; grids: number; tiles: number } }

export function judgePage(limits: typeof RULE_LIMITS & { resultDialog?: boolean; markList?: boolean }): PageJudgement {
  const vw = document.documentElement.clientWidth;
  const failures: Finding[] = [];
  const tight: Finding[] = [];
  const box = (r: DOMRect): Box => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const anchors: Element[] = [];
  (window as unknown as { __renderCheckAnchors: Element[] }).__renderCheckAnchors = anchors;
  /** Record a failure, anchored to the element it is about so its box can be found again after scrolling. */
  const fail = (f: Omit<Finding, "anchor">, at: Element | null) => {
    let anchor: Anchor | undefined;
    if (at && f.box) {
      const r = at.getBoundingClientRect();
      anchor = { index: anchors.push(at) - 1, dx: f.box.x - Math.round(r.left + scrollX), dy: f.box.y - Math.round(r.top + scrollY) };
    }
    failures.push(anchor ? { ...f, anchor } : f);
  };
  const style = (e: Element) => getComputedStyle(e);
  const ancestors = function* (el: Element) { for (let a = el.parentElement; a; a = a.parentElement) yield a; };
  const keepClass = (c: string) => !/^(is-|has-|c\d+$|d1p-c\d)/.test(c);
  const name = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      const cls = [...e.classList].filter(keepClass).slice(0, 2).join(".");
      parts.unshift(e.tagName.toLowerCase() + (cls ? "." + cls : ""));
    }
    return parts.join(" > ");
  };
  const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const skipped = (el: Element) => el.closest("canvas, svg, [data-render-check='skip']") !== null;
  /** Shown to a sighted reader: not hidden, not transparent, and not a visually-hidden screen-reader box. */
  const shown = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = style(e);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) return false;
      if (cs.clip !== "auto" && cs.clip !== "" && cs.position === "absolute") return false;
      if (/inset\(50%|circle\(0/.test(cs.clipPath)) return false;
      if (e !== document.body && e !== document.documentElement && cs.overflow !== "visible") {
        const r = e.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) return false;
      }
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const textRects = (root: Element) => {
    const found: { r: DOMRect; el: Element }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n as Text).data.trim()) continue;
      const p = n.parentElement;
      if (!p || skipped(p) || !shown(p)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0.5 && r.height > 0.5) found.push({ r, el: p });
    }
    return found;
  };
  const lineCount = (rects: DOMRect[]) => {
    const bands: { top: number; bottom: number }[] = [];
    for (const r of [...rects].sort((a, b) => a.top - b.top)) {
      const mid = (r.top + r.bottom) / 2;
      const band = bands.find(b => mid > b.top && mid < b.bottom);
      if (band) { band.top = Math.min(band.top, r.top); band.bottom = Math.max(band.bottom, r.bottom); }
      else bands.push({ top: r.top, bottom: r.bottom });
    }
    return bands.length;
  };
  /** Taken out of the line by position (a tooltip, a badge pinned to a corner): not part of its item's line. */
  const outOfFlow = (e: Element) => /absolute|fixed/.test(style(e).position);
  const inline = (d: string) => d === "inline" || d === "inline-block" || d === "inline-flex" || d === "contents";
  // A row of flex items is laid out as one line whether or not it may wrap: wrapping it is the defect judged.
  const rowFlex = (cs: CSSStyleDeclaration) => cs.display.includes("flex") && cs.flexDirection.startsWith("row");
  /** Laid out as one line by design: only inline content, or a no-wrap row of such content. */
  const lineable = (el: Element, top: boolean): boolean => {
    const cs = style(el);
    if (cs.display === "none") return true;
    // A table heading is one line of text in its cell; other table parts hold rows and cells, not a line.
    const heading = top && el.matches("th");
    if (cs.display.includes("grid") || cs.display.startsWith("table") && !heading || cs.display === "list-item" && !top) return false;
    if (cs.display.includes("flex") && !rowFlex(cs)) return false;
    // A group of links or buttons allowed to wrap is a set of controls, not a line of text.
    if (cs.flexWrap !== "nowrap" && !el.matches(".d1-result-dialog .rd-player") && [...el.children].some(c => c.matches("a, button"))) return false;
    if (!top && !inline(cs.display) && !(el.parentElement && rowFlex(style(el.parentElement)))) return false;
    // A heading cell built of two or more stacked blocks (a date over its time) is that many lines by design: each block
    // is then judged as a one-line item of its own.
    if (heading && [...el.children].filter(c => style(c).display === "block" && !outOfFlow(c) && c.textContent?.trim()).length >= 2) return false;
    for (const c of el.children) {
      if (!c.textContent?.trim() && !c.querySelector("img, svg")) continue;
      const d = style(c).display;
      if (d === "none" || outOfFlow(c)) continue;
      // A block inside a heading cell (a sort button, a wrapper) is still the heading's one line.
      if (!rowFlex(cs) && !inline(d) && !(heading && d === "block")) return false;
      if (!lineable(c, heading && d === "block")) return false;
    }
    return true;
  };
  // Running text, which may wrap. Labels, buttons and table headings are not here: they are one-line items.
  const PROSE = "h1, h2, h3, h4, h5, h6, p, blockquote, figcaption, dd, pre, summary";
  // For the finished replay the open native modal, not the inert HUD behind it, is the surface.
  const scope = limits.resultDialog ? document.querySelector<HTMLDialogElement>(".d1-result-dialog:modal")
    : limits.markList ? document.querySelector<HTMLElement>(".aw-mark-list:not([hidden])") : document.body;
  if (!scope) throw new Error("The expected replay surface did not open");
  const all = [...(scope !== document.body ? [scope] : []), ...scope.querySelectorAll("*")].filter(el => !skipped(el));

  // One-line items: the outermost line-able blocks with text, and every label, button, table heading and badge wherever
  // it stands (inside a paragraph too) and however long its text: those are one line by what they are, not by where they
  // are or how much they say. The cards' state line (p.d1p-state: web/src/pages/chrome.ts stateLine) is a paragraph
  // but a one-line item, not running text.
  // Section titles on Rules and the Watch title (docs/design-system.md, Layout rules) stay on one line even if
  // a badge or a block inside the heading moves to a second line. Other headings may be running text.
  const ONE_LINE_TITLE = 'h3.d1p-rule-title, [data-page="watch"] h1.d1p-title';
  const ONE_LINE = `label, th, button, [role=button], p.d1p-state, ${ONE_LINE_TITLE}`;
  const painted = (c: string) => c !== "" && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c);
  /**
   * A badge (a tag, chip or pill): an inline box drawn as a unit of its own, with its own background or border. It is
   * known by that, not by its class or by what contains it, so a badge in running text is judged like any other.
   */
  const badge = (el: Element): boolean => {
    const cs = style(el);
    if (!cs.display.startsWith("inline")) return false;
    const border = ["top", "right", "bottom", "left"].some(side => parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0
      && cs.getPropertyValue(`border-${side}-style`) !== "none" && painted(cs.getPropertyValue(`border-${side}-color`)));
    return painted(cs.backgroundColor) || cs.backgroundImage !== "none" || border;
  };
  /**
   * A row of icon-only items (a colony's seat badges): no text of its own, laid out as a row (a row of flex items, or
   * a box whose children are all inline), and two or more shown in-flow children, each an image or holding one and no
   * text. It is one line by what it is, like a label, however its items are built inside and whether or not they are
   * controls allowed to wrap: its icons are judged as its line. Icons stacked as blocks on purpose are not a row.
   */
  const iconRow = (el: Element): boolean => {
    if (el.textContent?.trim()) return false;
    const cs = style(el);
    if (!(inline(cs.display) || cs.display === "block" || rowFlex(cs)) || cs.display === "contents") return false;
    const row = rowFlex(cs);
    const parts = [...el.children].filter(c => !outOfFlow(c) && shown(c));
    return parts.length >= 2 && parts.every(c => (row || inline(style(c).display)) && (c.matches("img, svg") || c.querySelector("img, svg") !== null));
  };
  const oneLineItem = (el: Element) => el.matches(ONE_LINE) || badge(el) || iconRow(el);
  const items: Element[] = [];
  const isItem = new Set<Element>();
  const withinLine = (el: Element) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (e !== el && isItem.has(e)) return true;
      if (outOfFlow(e)) return false;
    }
    return false;
  };
  for (const el of all) {
    const cs = style(el);
    const oneLine = oneLineItem(el);
    const icons = iconRow(el);
    if ((cs.display === "inline" && !oneLine) || cs.display === "contents" || (!el.textContent?.trim() && !icons) || !shown(el)) continue;
    if (!icons && !el.matches(ONE_LINE_TITLE) && !lineable(el, true)) continue;
    // Inside an item it is part of that item's line, unless positioned out of it (a panel laid over a line).
    if (!oneLine && withinLine(el)) continue;
    isItem.add(el);
    items.push(el);
  }
  const narrowStandings = matchMedia("(320px <= width < 20em)").matches;
  for (const el of items) {
    // Only what stands in the item's line: a part positioned out of it (a tooltip shown above a badge) is not a line.
    const inLine = (n: Element) => { for (let e: Element | null = n; e && e !== el; e = e.parentElement) if (outOfFlow(e)) return false; return true; };
    const rects = textRects(el).filter(t => inLine(t.el)).map(t => t.r);
    for (const m of el.querySelectorAll("img, svg")) { const r = m.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && inLine(m)) rects.push(r); }
    // Rendered lines, an explicit <br> included: a one-line item broken by hand is still broken.
    const lines = lineCount(rects);
    const words = text(el);
    const prose = !oneLineItem(el) && (el.matches(PROSE + ", li, .d1-result-dialog .d1-moment-what") || el.closest(PROSE) !== null || words.length >= 80);
    // Only the group of whole badges may move down. A wrapped name, split badge group,
    // or an item cut by its row is still a failure.
    const group = el.matches(".d1-result-dialog .rd-player") ? el.querySelector(":scope > .rd-badges") : null;
    const player = el.querySelector(":scope > .d1-rating-name");
    const stacked = narrowStandings && lines === 2 && group && player
      && group.getBoundingClientRect().top >= player.getBoundingClientRect().bottom - 0.5
      && [player, group].every(part => lineCount(textRects(part).map(t => t.r)) === 1);
    if (lines > 1 && !prose && !stacked) {
      fail({ rule: "wrap", element: name(el), text: words, measure: `${lines} lines`, extent: lines, box: box(el.getBoundingClientRect()) }, el);
    } else if (lines === 1 && !prose && rects.length > 0) {
      const cs = style(el);
      const r = el.getBoundingClientRect();
      const avail = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      const used = Math.max(...rects.map(x => x.right)) - Math.min(...rects.map(x => x.left));
      // Only items whose width is set by their container: a shrink-wrapped box always fits exactly.
      const sized = cs.display === "block" || cs.display === "flex" || cs.display === "list-item" || cs.width.endsWith("px") && cs.flexGrow !== "0";
      if (sized && avail > 0 && (avail - used) / avail < limits.tightSpare) {
        tight.push({ rule: "tight", element: name(el), text: words, measure: `${Math.round(used)} of ${Math.round(avail)} px (${Math.round((1 - used / avail) * 100)}% spare)`, extent: 0, box: box(r), spare: (avail - used) / avail });
      }
    }
  }

  const rootPx = parseFloat(style(document.documentElement).fontSize);
  // At enlarged text both player names can shorten; at default text only narrow Top matches tiles can.
  // A title alone, or overflow:hidden alone, does not make a cut intentional.
  const designedEnds = new Set<Element>();
  if (rootPx > 16 || vw < 360) {
    for (const run of document.querySelectorAll<HTMLElement>(
      ".d1p-rec-player > .d1p-rec-who > .d1p-rec-name.aw-cut, .aw-tile .aw-player > .aw-who > .aw-name.aw-cut")) {
      if (rootPx <= 16 && run.matches(".d1p-rec-name")) continue;
      const cs = style(run);
      const parts = [...run.children].filter(p => !p.matches(".d1p-sr"));
      const words = parts.map(p => p.textContent).join("").trim();
      const tile = run.closest(".aw-tile");
      if (tile) {
        // The stretched replay link speaks the plain names and models. A linked builder's name
        // is spoken by its own control instead. A title on their common container is not enough.
        const replay = tile.querySelector("a.aw-tile-replay[href]");
        if (!replay || replay.closest('[aria-hidden="true"]')) continue;
        const label = replay.getAttribute("aria-label") ?? "";
        const builder = run.querySelector("b"), link = builder?.querySelector("a[href]");
        if (link) {
          const spoken = link.getAttribute("aria-label") ?? link.textContent;
          if (link.closest('[aria-hidden="true"]') || !spoken || spoken !== builder!.textContent
            || !label.includes(parts.filter(p => p !== builder).map(p => p.textContent).join("").trim())) continue;
        } else if (!label.includes(words)) continue;
      }
      if (cs.textOverflow !== "ellipsis" || cs.overflowX !== "hidden" || !["pre", "nowrap"].includes(cs.whiteSpace)
        || !["block", "inline-block"].includes(cs.display) || parts.some(p => style(p).display !== "inline")
        || !words || !(run.title === words || run.title.startsWith(`${words} (`)) || run.closest('[aria-hidden="true"]')) continue;
      // A box too narrow even for a letter and its ellipsis can show a plain clip instead.
      if (run.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) >= 1.5 * parseFloat(cs.fontSize) - 0.5) designedEnds.add(run);
    }
  }

  // In the enlarged phone deck the name alone moves to a full-width line below
  // event and time. Judge these units even though the button then uses a grid.
  for (const row of scope.querySelectorAll<HTMLButtonElement>(".aw-mark-list > button.aw-mark-row")) {
    if (!shown(row)) continue;
    const label = row.querySelector(".aw-mark-kind"), when = row.querySelector("b"), colony = row.querySelector<HTMLElement>(".aw-mark-colony");
    const fixed = [label, when].flatMap(el => el ? textRects(el).map(t => t.r) : []);
    const names = colony ? textRects(colony).map(t => t.r) : [];
    const below = narrowStandings && row.closest(".d1") && colony;
    if (!label || !when || !shown(label) || !shown(when) || lineCount(fixed) !== 1 || (colony && lineCount(names) !== 1)
      || (below ? Math.min(...names.map(r => r.top)) < Math.max(...fixed.map(r => r.bottom)) - .5 : lineCount([...fixed, ...names]) !== 1)) {
      fail({ rule: "wrap", element: name(row), text: text(row), measure: "event, time or colony not on its expected line",
        extent: Math.max(1, lineCount([...fixed, ...names])), box: box(row.getBoundingClientRect()) }, row);
    }
    if (!colony || !label || !when) continue;
    const parts = [label.textContent.replace(/ · $/, ""), colony.textContent, when.textContent];
    const cs = style(colony), rs = style(row);
    const fullLine = row.clientWidth - parseFloat(rs.paddingLeft) - parseFloat(rs.paddingRight);
    if (!colony.children.length && row.title === parts.join(" · ") && row.getAttribute("aria-label") === parts.join(", ")
      && !row.hasAttribute("aria-labelledby") && !row.closest('[aria-hidden="true"], [inert]')
      && cs.whiteSpace === "nowrap" && cs.textOverflow === "ellipsis" && cs.overflowX === "hidden"
      && (!below || colony.clientWidth >= fullLine - 1) && colony.clientWidth >= 1.5 * parseFloat(cs.fontSize)) designedEnds.add(colony);
  }

  for (const run of scope.querySelectorAll<HTMLElement>(".d1-result-dialog .rd-player > .d1-rating-name")) {
    const words = run.textContent, cs = style(run);
    if (!words || run.children.length || run.title !== words || run.getAttribute("aria-label") !== words
      || !run.matches('a[href], span[role="group"]') || run.closest('[aria-hidden="true"], [inert]') || run.hasAttribute("aria-labelledby")) continue;
    if (cs.whiteSpace === "nowrap" && cs.textOverflow === "ellipsis" && cs.overflowX === "hidden" && cs.display === "block"
      && (!narrowStandings || run.scrollWidth <= run.clientWidth || run.clientWidth >= run.parentElement!.clientWidth - 1)
      && run.clientWidth >= 1.5 * parseFloat(cs.fontSize)) designedEnds.add(run);
  }

  // On a phone at enlarged text the pinned colony name has the whole first row. Only
  // its trailing ellipsis is intentional; ancestor, vertical and viewport cuts still count.
  if (rootPx > 16 && matchMedia("(min-width: 320px) and (max-width: 19.99em)").matches) {
    for (const run of document.querySelectorAll<HTMLElement>(".score-band .d1-team > .sb-sticky-bar > .d1-team-head > h2.d1-name")) {
      const cs = style(run), words = run.textContent?.trim();
      const bar = run.parentElement!.parentElement!;
      const notePrefix = `${words} · `;
      if (!words || run.children.length || !(run.title === words || (run.title.startsWith(notePrefix) && run.title.slice(notePrefix.length).trim()))
        || run.getAttribute("aria-label") !== run.title || run.hasAttribute("aria-labelledby") || run.closest('[aria-hidden="true"], [inert]')
        || cs.display !== "block" || cs.whiteSpace !== "nowrap" || cs.textOverflow !== "ellipsis" || cs.overflowX !== "hidden") continue;
      const barWidth = bar.clientWidth - parseFloat(style(bar).paddingLeft) - parseFloat(style(bar).paddingRight);
      const content = run.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (run.offsetWidth >= barWidth - 0.5 && content >= 1.5 * parseFloat(cs.fontSize)) designedEnds.add(run);
    }
  }

  // Text cut by an overflow box (its own or an ancestor's), an ellipsis, or the viewport.
  interface Edges { left: number; top: number; right: number; bottom: number }
  /**
   * Walk the boxes that clip `start`'s content, from the inside out, with `r` where the reader can see it. A box that
   * scrolls on an axis cuts nothing on it: the reader scrolls the content into its box, so past that box the content
   * is judged where scrolling brings it (moved into the box on that axis). A box that clips without scrolling cuts
   * whatever reaches past it by more than `cuts` allows. Returns the first such box, its edges and the content's box
   * there, or the content's box as seen from the page when nothing cuts it.
   */
  const clipWalk = (start: Element, r: Edges, cuts: (r: Edges, e: Edges, x: boolean, y: boolean) => number, textRun = false) => {
    let at = { ...r };
    for (const a of [start, ...ancestors(start)]) {
      if (a === document.body || a === document.documentElement) break;
      const cs = style(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      const left = b.left + parseFloat(cs.borderLeftWidth), top = b.top + parseFloat(cs.borderTopWidth);
      const e = { left, top, right: left + a.clientWidth, bottom: top + a.clientHeight };
      const scrollX = /auto|scroll/.test(cs.overflowX), scrollY = /auto|scroll/.test(cs.overflowY);
      if (textRun && designedEnds.has(a)) {
        // The ellipsis replaces only text past the run's end. Keep its visible portion for the
        // vertical, enclosing-box and viewport checks; never ignore a cut at the start of a line.
        at.right = Math.min(at.right, e.right);
        at.left = Math.min(at.left, e.right);
      }
      const past = cuts(at, e, !scrollX && cs.overflowX !== "visible", !scrollY && cs.overflowY !== "visible");
      if (past > 0) return { by: a, edges: e, at, past };
      const into = (lo: number, hi: number, min: number, max: number): [number, number] => {
        const size = Math.min(hi - lo, max - min);
        if (lo < min) return [min, min + size];
        if (hi > max) return [max - size, max];
        return [lo, hi];
      };
      if (scrollX) [at.left, at.right] = into(at.left, at.right, e.left, e.right);
      if (scrollY) [at.top, at.bottom] = into(at.top, at.bottom, e.top, e.bottom);
    }
    return { by: null, edges: null, at, past: 0 };
  };
  const edgesOf = (r: DOMRect): Edges => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const textCuts = new Map<Element, { rule: "clipped" | "offscreen"; by: Element | null; past: number; r: DOMRect }>();
  for (const { r, el } of textRects(scope)) {
    const had = textCuts.get(el);
    // A glyph box is taller than a tight line box; only text reaching further than that is cut.
    const slackY = Math.max(1, r.height * 0.2);
    const walk = clipWalk(el, edgesOf(r), (at, e, x, y) => {
      const pastX = x ? Math.max(at.right - e.right, e.left - at.left, 0) : 0;
      const pastY = y ? Math.max(at.bottom - e.bottom, e.top - at.top, 0) : 0;
      return Math.max(pastX > 0.5 ? pastX : 0, pastY > slackY ? pastY : 0);
    }, true);
    if (walk.by) {
      if (had?.rule !== "offscreen" && (!had || walk.past > had.past)) textCuts.set(el, { rule: "clipped", by: walk.by, past: walk.past, r });
      continue;
    }
    const off = Math.max(walk.at.right - vw, -walk.at.left, 0);
    if (off > 0.5 && (!had || had.rule !== "offscreen" || off > had.past)) textCuts.set(el, { rule: "offscreen", by: null, past: off, r });
  }
  const reported = new Set<Element>(textCuts.keys());
  for (const [el, c] of textCuts) {
    const past = Math.round(c.past);
    if (c.rule === "offscreen") {
      fail({ rule: "offscreen", element: name(el), text: text(el), measure: `${past} px of text past the viewport's side (0-${vw} px)`, extent: past, box: box(c.r) }, el);
    } else {
      fail({ rule: "clipped", element: name(el), text: text(el), measure: `${past} px cut by ${c.by === el ? "its own box" : name(c.by!)}`, extent: past, box: box(c.r) }, el);
    }
  }
  // An image, board or control cut by an overflow box or the viewport. (An image cropped by design, object-fit: cover,
  // keeps its box inside its frame and crops within it, so it is not cut here.)
  for (const el of scope.querySelectorAll("img, svg, canvas, video, iframe, button, input, select, textarea, .d1-result-dialog .rd-player .d1-tag")) {
    if (el.closest("[data-render-check='skip']") || el.parentElement?.closest("svg, button") || !shown(el)) continue;
    if ([el, ...el.querySelectorAll("*")].some(c => reported.has(c))) continue;
    const cut = (at: Edges, e: Edges, x: boolean, y: boolean) => {
      const pastX = x ? Math.max(at.right - e.right, e.left - at.left, 0) : 0;
      const pastY = y ? Math.max(at.bottom - e.bottom, e.top - at.top, 0) : 0;
      const past = Math.round(Math.max(pastX, pastY));
      return past >= 1 ? past : 0;
    };
    const walk = clipWalk(el.parentElement ?? el, edgesOf(el.getBoundingClientRect()), cut);
    const past = walk.by ? walk.past : cut(walk.at, { left: 0, top: -Infinity, right: vw, bottom: Infinity }, true, false);
    if (!past) continue;
    reported.add(el);
    fail({ rule: walk.by ? "clipped" : "offscreen", element: name(el), text: text(el), measure: `${el.tagName.toLowerCase()} ${past} px cut by ${walk.by ? name(walk.by) : "the viewport"}`,
      extent: past, box: box(el.getBoundingClientRect()) }, el);
  }
  for (const el of all) {
    const cs = style(el);
    if (cs.textOverflow !== "ellipsis" || el.scrollWidth <= el.clientWidth + 0.5 || reported.has(el) || designedEnds.has(el) || !shown(el)) continue;
    if ([...el.querySelectorAll("*")].some(c => reported.has(c))) continue;
    fail({ rule: "cut", element: name(el), text: text(el), measure: `${el.scrollWidth} px of text in ${el.clientWidth} px`, extent: el.scrollWidth - el.clientWidth, box: box(el.getBoundingClientRect()) }, el);
  }
  for (const el of all) {
    const cs = style(el);
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && shown(el)) {
      fail({ rule: "sideways", element: name(el), text: text(el), measure: `${el.scrollWidth} px wide in ${el.clientWidth} px`, extent: el.scrollWidth - el.clientWidth, box: box(el.getBoundingClientRect()) }, el);
    }
  }
  const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (pageWidth > vw + 0.5) fail({ rule: "page-wider", element: "html", text: "", measure: `${pageWidth} px wide, viewport ${vw} px`, extent: Math.round(pageWidth - vw), box: null }, null);

  // Grids of like tiles: 2+ children of one kind, in one column or several.
  const boxed = (el: Element) => {
    const cs = style(el);
    return parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0 || cs.boxShadow !== "none" ||
      (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent");
  };
  const tileOf = (el: Element): Element | null => {
    if (boxed(el)) return el;
    const kids = [...el.children].filter(shown);
    return kids.length === 1 && boxed(kids[0]!) ? kids[0]! : null;
  };
  const kind = (k: Element) => k.tagName + "." + [...k.classList].filter(keepClass).sort().join(".");
  // Under 18em, Top matches stacks its players in eight slots instead of four. Only the two
  // gaps touching this block get a centering budget: half the unused lines, plus half a line
  // for the row insets and glyph boxes (the ordinary 1v1 uses one spare line + this half).
  // Count the players, not the block's measured height: extra height must still fail.
  const stacked = rootPx > 16 && matchMedia("(max-width: 17.999em)").matches;
  const bandLimit = (ordinary: number, above: Element | null, below: Element | null) => {
    if (!stacked || !above || !below) return ordinary;
    const lines = above.closest(".aw-lines") ?? below.closest(".aw-lines");
    if (!lines?.matches(".aw-grid > li > .aw-tile > .aw-lines")) return ordinary;
    if (!(lines.previousElementSibling?.matches(".aw-meta") && lines.previousElementSibling.contains(above) && lines.contains(below))
      && !(lines.contains(above) && lines.nextElementSibling?.matches(".aw-how, .aw-date") && lines.nextElementSibling.contains(below))) return ordinary;
    const count = lines.querySelectorAll(".aw-player").length;
    const playerLine = 1.25 * rootPx;
    return count >= 2 && count <= 8 ? Math.max(ordinary, (8 - count + 1) / 2 * playerLine) : ordinary;
  };
  let grids = 0, tiles = 0;
  for (const el of all) {
    const cs = style(el);
    if (!(cs.display.includes("grid") || (cs.display.includes("flex") && cs.flexWrap === "wrap"))) continue;
    // A column-keyed table's rows are judged by column-start below, not as tiles.
    // A standings list is a list of players, not a tile grid: profile links and badges depend on the player.
    if (el.closest("[data-col-table]") || el.matches(".d1-result-dialog .rd-standings > .d1-ratings")) continue;
    const kids = [...el.children].filter(shown);
    if (kids.length < 2 || new Set(kids.map(kind)).size !== 1) continue;
    const cards = kids.map(tileOf);
    if (cards.some(c => c === null)) continue;
    const rects = (cards as Element[]).map(c => c.getBoundingClientRect());
    const rows = new Map<number, number[]>();
    rects.forEach((r, i) => { const top = Math.round(r.top); rows.set(top, [...(rows.get(top) ?? []), i]); });
    grids++;
    tiles += cards.length;
    const where = name(el);
    for (const row of rows.values()) {
      const h = row.map(i => rects[i]!.height);
      if (row.length >= 2 && Math.max(...h) - Math.min(...h) > limits.heightSlackPx) {
        fail({ rule: "row-uneven", element: where, text: text(cards[row[0]!]!), measure: `row heights ${h.map(Math.round).join(", ")} px`, extent: Math.round(Math.max(...h) - Math.min(...h)), box: box(el.getBoundingClientRect()) }, el);
      }
    }
    const heights = rects.map(r => r.height);
    if (Math.max(...heights) - Math.min(...heights) > limits.heightSlackPx) {
      fail({ rule: "grid-uneven", element: where, text: "", measure: `tile heights ${Math.round(Math.min(...heights))}-${Math.round(Math.max(...heights))} px over ${cards.length} tiles`,
        extent: Math.round(Math.max(...heights) - Math.min(...heights)), box: box(el.getBoundingClientRect()) }, el);
    }
    // Empty bands inside each tile.
    for (const c of cards as Element[]) {
      const cr = c.getBoundingClientRect(), ccs = style(c);
      const top = cr.top + parseFloat(ccs.borderTopWidth) + parseFloat(ccs.paddingTop);
      const bottom = cr.bottom - parseFloat(ccs.borderBottomWidth) - parseFloat(ccs.paddingBottom);
      const spans: [number, number, Element][] = textRects(c).map(t => [t.r.top, t.r.bottom, t.el]);
      for (const m of c.querySelectorAll("img, svg, canvas, video, input, button, select")) {
        const r = m.getBoundingClientRect();
        if (r.height > 0 && shown(m)) spans.push([r.top, r.bottom, m]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const line = parseFloat(ccs.lineHeight) || parseFloat(ccs.fontSize) * 1.35;
      const ordinary = limits.tileBandLines * line;
      let at = top, above: Element | null = null, gap = 0, gapAt = top, limit = ordinary;
      // Keep the largest *failing* band, not just the largest: an approved band cannot mask another gap.
      for (const [t, b, el] of [...spans, [bottom, bottom, c] as const]) {
        if (t - at > Math.max(ordinary, gap)) {
          const allowed = bandLimit(ordinary, above, el);
          if (t - at > allowed) { gap = t - at; gapAt = at; limit = allowed; }
        }
        if (b > at) { at = b; above = el; }
      }
      if (gap > 0) {
        fail({ rule: "tile-empty", element: name(c), text: text(c), measure: `${Math.round(gap)} px empty (limit ${Math.round(limit)} px)`, extent: Math.round(gap),
          box: { x: Math.round(cr.left + scrollX), y: Math.round(gapAt + scrollY), w: Math.round(cr.width), h: Math.round(gap) } }, c);
      }
    }
    // A part (a classed element with text) shown on some tiles but not others.
    const partsOf = (c: Element) => {
      const found = new Set<string>();
      for (const p of c.querySelectorAll("[class]")) {
        if (!p.textContent?.trim() || skipped(p) || !shown(p)) continue;
        // A shortened name and the spaces it holds are the same part as an unshortened name.
        const cls = [...p.classList].filter(c => keepClass(c) && c !== "aw-cut" && c !== "aw-held").sort().join(".");
        if (cls) found.add(p.tagName.toLowerCase() + "." + cls);
      }
      return found;
    };
    const each = (cards as Element[]).map(partsOf);
    const union = new Set(each.flatMap(s => [...s]));
    for (const part of union) {
      const on = each.filter(s => s.has(part)).length;
      if (on < cards.length) {
        fail({ rule: "part-uneven", element: `${where} > ${part}`, text: "", measure: `shown on ${on} of ${cards.length} tiles`, extent: cards.length - on, box: box(el.getBoundingClientRect()) }, el);
      }
    }
  }

  // Column start: every keyed row cell's first text on its column head's x (or, with the head hidden, on its key's x).
  for (const table of scope.querySelectorAll("[data-col-table]")) {
    if (skipped(table) || !shown(table)) continue;
    const head = table.querySelector("[data-col-head]");
    const headShown = head !== null && shown(head);
    const first = (el: Element) => textRects(el)[0]?.r ?? null;
    const heads = new Map<string, DOMRect>();
    if (head && headShown) for (const c of head.querySelectorAll("[data-col]")) {
      const r = first(c);
      if (r) heads.set((c as HTMLElement).dataset.col!, r);
    }
    const byKey = new Map<string, { cell: Element; r: DOMRect }[]>();
    for (const cell of table.querySelectorAll("[data-col]")) {
      // A cell drawn as display: contents (a phone's start line) has no box of its own: its shown text is what is judged.
      if (head?.contains(cell) || (style(cell).display !== "contents" && !shown(cell))) continue;
      const r = first(cell);
      if (!r) continue;
      const key = (cell as HTMLElement).dataset.col!;
      byKey.set(key, [...(byKey.get(key) ?? []), { cell, r }]);
    }
    /** A cell continuing a line that an earlier keyed cell of its row starts (a phone's start line: date, then type). */
    const continues = (cell: Element, r: DOMRect) => {
      const row = cell.parentElement?.closest("li, tr, [role=row]");
      if (!row) return false;
      const mid = (r.top + r.bottom) / 2;
      for (const other of row.querySelectorAll("[data-col]")) {
        if (other === cell || !(other.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (textRects(other).some(t => t.r.right <= r.left + 0.5 && mid > t.r.top && mid < t.r.bottom)) return true;
      }
      return false;
    };
    for (const [key, cells] of byKey) {
      const headAt = heads.get(key);
      const judged = headShown ? cells : cells.filter(c => !continues(c.cell, c.r));
      if (headShown && !headAt) continue;
      const x = headAt ? headAt.left : judged[0]?.r.left;
      if (x === undefined) continue;
      for (const { cell, r } of judged) {
        const off = Math.round(Math.abs(r.left - x) * 10) / 10;
        if (off <= limits.columnSlackPx) continue;
        fail({ rule: "column-start", element: name(cell), text: text(cell),
          measure: `starts ${off} px from ${headAt ? "its column head" : "the other cells of its column"} (column ${key})`, extent: off, box: box(r) }, cell);
      }
    }
  }

  // Empty horizontal bands down the page: no text, media, control or panel edge.
  const spans: [number, number, Element][] = textRects(scope).map(t => [t.r.top, t.r.bottom, t.el]);
  // An image or board drawn behind a later opaque panel that covers it whole (a board under a page) shows nothing.
  const opaque = all.filter(e => /^rgba?\(\d+, \d+, \d+\)$/.test(style(e).backgroundColor) && shown(e));
  const hiddenBehind = (el: Element, left: number, top: number, right: number, bottom: number) => opaque.some(e => {
    if (e.contains(el) || el.contains(e) || !(el.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const b = e.getBoundingClientRect();
    return b.left <= left + 0.5 && b.top <= top + 0.5 && b.right >= right - 0.5 && b.bottom >= bottom - 0.5;
  });
  // Every element counts here, a board's canvas and drawings included (only their insides are skipped elsewhere).
  for (const el of scope.querySelectorAll("*")) {
    if (el.closest("[data-render-check='skip']") || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    const media = ["IMG", "CANVAS", "VIDEO", "INPUT", "SELECT", "TEXTAREA", "BUTTON", "IFRAME"].includes(el.tagName) || el.tagName.toLowerCase() === "svg";
    if (media) {
      // Only the part of an image or board its clipping boxes let show (a hero image cropped by its frame). A box that
      // scrolls hides nothing for good: the reader scrolls to it, and the page's bands are judged with it unrolled,
      // as its text is. So only the clipping boxes inside the nearest box that scrolls crop it; a box that clips
      // around that scroller does not hide what the reader scrolls into view.
      let top = r.top, bottom = r.bottom;
      for (const a of ancestors(el)) {
        if (a === document.body || a === document.documentElement) break;
        const oy = style(a).overflowY;
        if (/auto|scroll/.test(oy)) break;
        if (!/hidden|clip/.test(oy)) continue;
        const b = a.getBoundingClientRect();
        top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom);
      }
      if (bottom > top && !hiddenBehind(el, r.left, top, r.right, bottom)) spans.push([top, bottom, el]);
    }
    // A panel's edges are drawn; the space inside it is empty unless something is drawn there.
    else if (boxed(el)) spans.push([r.top, r.top + 1, el], [r.bottom - 1, r.bottom, el]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let at = scope === document.body ? -scrollY : scope.getBoundingClientRect().top;
  let above: Element | null = null;
  const bands: { top: number; bottom: number; above: Element | null; below: Element }[] = [];
  for (const [t, b, el] of spans) {
    if (t - at > 0) bands.push({ top: at + scrollY, bottom: t + scrollY, above, below: el });
    if (b > at) { at = b; above = el; }
  }
  // Space after the last content is not a gap between parts of the page, so it is not judged.
  for (const band of bands) {
    const tall = band.bottom - band.top;
    if (tall <= limits.pageBandPx) continue;
    // The landing page's gutters between sections are fixed px, not text-scaled spacing.
    const section = band.below.closest(".fg-inner > *");
    const fixed = section && band.above?.closest(".fg-inner > *")?.nextElementSibling === section
      && /^\d+(?:\.\d+)?px$/.test(style(section).getPropertyValue("--fg-gap").trim());
    const limit = bandLimit(limits.pageBandPx * (fixed ? 1 : rootPx / 16), band.above, band.below);
    if (tall <= limit) continue;
    const where = `band below ${band.above ? name(band.above) : "page top"}`;
    fail({ rule: "page-empty", element: where, text: band.below ? `above: ${text(band.below)}` : "",
      measure: `${Math.round(tall)} px empty (limit ${Math.round(limit)} px)`, extent: Math.round(tall), box: { x: 0, y: Math.round(band.top), w: vw, h: Math.round(tall) } }, band.below);
  }
  return { failures, tight, counted: { items: items.length, grids, tiles } };
}
