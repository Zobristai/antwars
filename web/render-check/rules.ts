/**
 * The in-page rules the render check judges every surface by. judgePage runs inside the page (page.evaluate),
 * so it must use nothing outside its own body. Every finding names its rule, the element (class path and text)
 * and the measure that broke the rule, with the element's box in page pixels for the marked render.
 *
 * Fails:
 * - wrap: a one-line item (a block holding only inline content, or a row of flex items, outside prose and headings;
 *   every label and table heading, wherever it stands) laid out on 2+ rendered lines, explicit breaks included
 * - clipped / cut / offscreen: text cut by an overflow box (its own or an ancestor's), an ellipsis, or the viewport's
 *   sides; an image, board or control cut by an overflow box or the viewport. Each axis is judged on its own: a box
 *   that scrolls on an axis cuts nothing on it (the reader scrolls), and past it the content counts where scrolling
 *   brings it
 * - sideways / page-wider: a scroller with sideways overflow, or a page wider than the viewport
 * - row-uneven / grid-uneven: tiles of one kind (2+ in a grid, one column or several) of unequal height, in a row or
 *   across the grid. In one column, children that each hold a heading and running text are reading sections, not tiles.
 * - tile-empty: an empty band inside such a tile taller than 1.5 lines of its text
 * - part-uneven: a tile part shown on some tiles of the grid but not others
 * - page-empty: an empty horizontal band on the page taller than RULE_LIMITS.pageBandPx
 * Lists, without failing:
 * - tight: a one-line item with under RULE_LIMITS.tightSpare of its width to spare
 *
 * Every finding carries its extent (how far it breaks the rule: lines, or px, or tiles missing a part), so a held
 * finding that gets worse is new. judgePage also leaves each finding's element in window.__renderCheckAnchors, so the
 * marked renders can be taken by scrolling the judged layout rather than by laying it out again.
 */

export const RULE_IDS = ["wrap", "clipped", "cut", "offscreen", "sideways", "page-wider", "row-uneven", "grid-uneven",
  "tile-empty", "part-uneven", "page-empty", "tight"] as const;
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

export function judgePage(limits: typeof RULE_LIMITS): PageJudgement {
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
    if (cs.flexWrap !== "nowrap" && [...el.children].some(c => c.matches("a, button"))) return false;
    if (!top && !inline(cs.display) && !(el.parentElement && rowFlex(style(el.parentElement)))) return false;
    for (const c of el.children) {
      if (!c.textContent?.trim() && !c.querySelector("img, svg")) continue;
      const d = style(c).display;
      if (d === "none") continue;
      // A block inside a heading cell (a sort button, a wrapper) is still the heading's one line.
      if (!rowFlex(cs) && !inline(d) && !(heading && d === "block")) return false;
      if (!lineable(c, heading && d === "block")) return false;
    }
    return true;
  };
  // Running text, which may wrap. Labels and table headings are not here: they are one-line items.
  const PROSE = "h1, h2, h3, h4, h5, h6, p, blockquote, figcaption, dd, pre, summary";
  const all = [...document.body.querySelectorAll("*")].filter(el => !skipped(el));

  // One-line items: the outermost line-able blocks with text, and every label and table heading wherever it stands
  // (inside a paragraph too): those are one line by what they are, not by where they are.
  const ONE_LINE = "label, th";
  const items: Element[] = [];
  const isItem = new Set<Element>();
  for (const el of all) {
    const cs = style(el);
    const oneLine = el.matches(ONE_LINE);
    if ((cs.display === "inline" && !oneLine) || cs.display === "contents" || !el.textContent?.trim() || !shown(el)) continue;
    if (!lineable(el, true)) continue;
    if (!oneLine && [...ancestors(el)].some(a => isItem.has(a))) continue;
    isItem.add(el);
    items.push(el);
  }
  for (const el of items) {
    const rects = textRects(el).map(t => t.r);
    for (const m of el.querySelectorAll("img, svg")) { const r = m.getBoundingClientRect(); if (r.width > 0 && r.height > 0) rects.push(r); }
    // Rendered lines, an explicit <br> included: a one-line item broken by hand is still broken.
    const lines = lineCount(rects);
    const words = text(el);
    const prose = el.matches(ONE_LINE) ? words.length >= 80 : el.matches(PROSE + ", li") || el.closest(PROSE) !== null || words.length >= 80;
    if (lines > 1 && !prose) {
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

  // Text cut by an overflow box (its own or an ancestor's), an ellipsis, or the viewport.
  interface Edges { left: number; top: number; right: number; bottom: number }
  /**
   * Walk the boxes that clip `start`'s content, from the inside out, with `r` where the reader can see it. A box that
   * scrolls on an axis cuts nothing on it: the reader scrolls the content into its box, so past that box the content
   * is judged where scrolling brings it (moved into the box on that axis). A box that clips without scrolling cuts
   * whatever reaches past it by more than `cuts` allows. Returns the first such box, its edges and the content's box
   * there, or the content's box as seen from the page when nothing cuts it.
   */
  const clipWalk = (start: Element, r: Edges, cuts: (r: Edges, e: Edges, x: boolean, y: boolean) => number) => {
    let at = { ...r };
    for (const a of [start, ...ancestors(start)]) {
      if (a === document.body || a === document.documentElement) break;
      const cs = style(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      const left = b.left + parseFloat(cs.borderLeftWidth), top = b.top + parseFloat(cs.borderTopWidth);
      const e = { left, top, right: left + a.clientWidth, bottom: top + a.clientHeight };
      const scrollX = /auto|scroll/.test(cs.overflowX), scrollY = /auto|scroll/.test(cs.overflowY);
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
  for (const { r, el } of textRects(document.body)) {
    const had = textCuts.get(el);
    // A glyph box is taller than a tight line box; only text reaching further than that is cut.
    const slackY = Math.max(1, r.height * 0.2);
    const walk = clipWalk(el, edgesOf(r), (at, e, x, y) => {
      const pastX = x ? Math.max(at.right - e.right, e.left - at.left, 0) : 0;
      const pastY = y ? Math.max(at.bottom - e.bottom, e.top - at.top, 0) : 0;
      return Math.max(pastX > 0.5 ? pastX : 0, pastY > slackY ? pastY : 0);
    });
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
  for (const el of document.body.querySelectorAll("img, svg, canvas, video, iframe, button, input, select, textarea")) {
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
    if (cs.textOverflow !== "ellipsis" || el.scrollWidth <= el.clientWidth + 0.5 || reported.has(el) || !shown(el)) continue;
    if ([...el.querySelectorAll("*")].some(c => reported.has(c))) continue;
    fail({ rule: "cut", element: name(el), text: text(el), measure: `${el.scrollWidth} px of text in ${el.clientWidth} px`, extent: el.scrollWidth - el.clientWidth, box: box(el.getBoundingClientRect()) }, el);
  }
  for (const el of all) {
    const cs = style(el);
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && el.textContent?.trim() && shown(el)) {
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
  let grids = 0, tiles = 0;
  for (const el of all) {
    const cs = style(el);
    if (!(cs.display.includes("grid") || (cs.display.includes("flex") && cs.flexWrap === "wrap"))) continue;
    const kids = [...el.children].filter(shown);
    if (kids.length < 2 || new Set(kids.map(kind)).size !== 1) continue;
    const cards = kids.map(tileOf);
    if (cards.some(c => c === null)) continue;
    const rects = (cards as Element[]).map(c => c.getBoundingClientRect());
    const rows = new Map<number, number[]>();
    rects.forEach((r, i) => { const top = Math.round(r.top); rows.set(top, [...(rows.get(top) ?? []), i]); });
    // In one column, children that each hold a heading and running text are a page's reading sections, not tiles.
    const section = (c: Element) => c.querySelector("h1, h2, h3, h4, h5, h6") !== null && c.querySelector("p") !== null;
    if (![...rows.values()].some(row => row.length >= 2) && (cards as Element[]).every(section)) continue;
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
      const spans: [number, number][] = textRects(c).map(t => [t.r.top, t.r.bottom]);
      for (const m of c.querySelectorAll("img, svg, canvas, video, input, button, select")) {
        const r = m.getBoundingClientRect();
        if (r.height > 0 && shown(m)) spans.push([r.top, r.bottom]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let at = top, gap = 0, gapAt = top;
      for (const [t, b] of spans) { if (t - at > gap) { gap = t - at; gapAt = at; } at = Math.max(at, b); }
      if (bottom - at > gap) { gap = bottom - at; gapAt = at; }
      const line = parseFloat(ccs.lineHeight) || parseFloat(ccs.fontSize) * 1.35;
      if (gap > limits.tileBandLines * line) {
        fail({ rule: "tile-empty", element: name(c), text: text(c), measure: `${Math.round(gap)} px empty (limit ${Math.round(limits.tileBandLines * line)} px)`, extent: Math.round(gap),
          box: { x: Math.round(cr.left + scrollX), y: Math.round(gapAt + scrollY), w: Math.round(cr.width), h: Math.round(gap) } }, c);
      }
    }
    // A part (a classed element with text) shown on some tiles but not others.
    const partsOf = (c: Element) => {
      const found = new Set<string>();
      for (const p of c.querySelectorAll("[class]")) {
        if (!p.textContent?.trim() || skipped(p) || !shown(p)) continue;
        const cls = [...p.classList].filter(keepClass).sort().join(".");
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

  // Empty horizontal bands down the page: no text, media, control or panel edge.
  const spans: [number, number, Element][] = textRects(document.body).map(t => [t.r.top, t.r.bottom, t.el]);
  // An image or board drawn behind a later opaque panel that covers it whole (a board under a page) shows nothing.
  const opaque = all.filter(e => /^rgba?\(\d+, \d+, \d+\)$/.test(style(e).backgroundColor) && shown(e));
  const hiddenBehind = (el: Element, left: number, top: number, right: number, bottom: number) => opaque.some(e => {
    if (e.contains(el) || el.contains(e) || !(el.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const b = e.getBoundingClientRect();
    return b.left <= left + 0.5 && b.top <= top + 0.5 && b.right >= right - 0.5 && b.bottom >= bottom - 0.5;
  });
  // Every element counts here, a board's canvas and drawings included (only their insides are skipped elsewhere).
  for (const el of document.body.querySelectorAll("*")) {
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
  let at = -scrollY;
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
    const where = `band below ${band.above ? name(band.above) : "page top"}`;
    fail({ rule: "page-empty", element: where, text: band.below ? `above: ${text(band.below)}` : "",
      measure: `${Math.round(tall)} px empty (limit ${limits.pageBandPx} px)`, extent: Math.round(tall), box: { x: 0, y: Math.round(band.top), w: vw, h: Math.round(tall) } }, band.below);
  }
  return { failures, tight, counted: { items: items.length, grids, tiles } };
}
