// Runs in the page. Every visible column heading, button, chip, badge and one-line item (white-space nowrap or pre, with
// text of its own) on the page is checked for:
// - wrapping: any one of its text runs laid out on more than one line (a composite control whose separate runs sit on
//   separate rows by design, such as a two-row list button, is not a wrap; each run must stay on one line);
// - clipping: its content wider than its box where its box hides overflow, or its box cut by an ancestor that clips;
// - overlap: its painted text intersecting another item's painted text by more than 2 px each way (items inside a fixed
//   or sticky bar that other content scrolls under are left out of this check);
// - spare width, measured, not modelled: an invisible spacer is added inside the item and widened until the item or what
//   follows it on its line changes line, wraps or is cut, or the page gains horizontal overflow. needed = the item's own
//   content on one line (excluding its padding); available = needed + the widest spacer that still fits;
//   spare = (available - needed) / available.
//   Searched up to 100% of needed; an item that still fits there is reported as ">= 50%".
export const itemsCheck = () => {
  const out = [], CAND = [];
  const r1 = x => Math.round(x * 10) / 10;
  const visible = el => { const b = el.getBoundingClientRect(); if (b.width <= 2 || b.height <= 2) return false; if (!el.checkVisibility({ visibilityProperty: true })) return false;
    for (let a = el; a; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.clipPath && cs.clipPath !== "none" && /inset\(50%/.test(cs.clipPath)) return false; if ([...a.classList].some(c => /(^|-)sr(-|$)|sr-only/.test(c))) return false; } return true; };
  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  const kindOf = el => {
    const cs = getComputedStyle(el), cls = [...el.classList].join(" ");
    if (el.matches("th, [role=columnheader]")) return "column heading";
    if (el.matches("button, [role=button], [role=tab], a[class*=button], a[class*=btn]")) return "button";
    if (/chip|pill/.test(cls)) return "chip";
    if (/badge|(^|[-_ ])tags?($|[-_ ])|(^|[-_ ])tier($|[-_ ])/.test(cls)) return "badge";
    if (/nowrap|^pre$/.test(cs.whiteSpace) && ownText(el)) return "one-line";
    return null;
  };
  const textNodes = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), out = []; for (let n; (n = w.nextNode());) if (n.textContent.trim() && n.parentElement.checkVisibility()) out.push(n); return out; };
  const runLines = n => { const r = document.createRange(); r.selectNodeContents(n); const rs = [...r.getClientRects()].filter(x => x.width > 0.5 && x.height > 0.5).sort((a, b) => a.top - b.top); const g = [];
    for (const q of rs) { const k = g.find(k => Math.min(k.bottom, q.bottom) - Math.max(k.top, q.top) > Math.min(k.bottom - k.top, q.height) * 0.5); if (k) { k.top = Math.min(k.top, q.top); k.bottom = Math.max(k.bottom, q.bottom); } else g.push({ top: q.top, bottom: q.bottom }); } return g.length; };
  const maxLines = el => Math.max(0, ...textNodes(el).map(runLines));
  const textRects = el => textNodes(el).flatMap(n => { const r = document.createRange(); r.selectNodeContents(n); return [...r.getClientRects()].filter(x => x.width > 0.5); });
  const ownOverflow = el => { const cs = getComputedStyle(el); return el.scrollWidth > el.clientWidth + 1 && (cs.overflowX !== "visible" || cs.textOverflow === "ellipsis"); };
  const clipped = el => { const b = el.getBoundingClientRect(); if (ownOverflow(el)) return "own overflow";
    for (let a = el.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible") { const r = a.getBoundingClientRect(); if (b.right > r.right + 1 || b.left < r.left - 1) return `cut by ${a.tagName.toLowerCase()}.${[...a.classList].join(".")}`; } } return null; };
  const inBar = el => { for (let a = el; a; a = a.parentElement) if (/fixed|sticky/.test(getComputedStyle(a).position)) return true; return false; };
  // What must not change while the item grows: its own lines and box top, its clipping, the tops of what follows it in
  // its parent and grandparent, its parent's height, and the page width.
  const state = el => { const p = el.parentElement, gp = p?.parentElement; const sib = x => x ? [...x.children].filter(c => c.getClientRects().length).map(c => Math.round(c.getBoundingClientRect().top)) : [];
    return JSON.stringify([maxLines(el), Math.round(el.getBoundingClientRect().top), ownOverflow(el), clipped(el), sib(p), sib(gp), Math.round(p?.getBoundingClientRect().height ?? 0), document.documentElement.scrollWidth]); };
  // The item's own content laid out on one line: a hidden max-content clone of it, beside it, less its padding and border.
  const natural = el => { const c = el.cloneNode(true); c.removeAttribute("id"); Object.assign(c.style, { position: "absolute", visibility: "hidden", whiteSpace: "nowrap", width: "max-content", minWidth: "0", maxWidth: "none", left: "0", top: "0", flex: "none", paddingLeft: "0", paddingRight: "0", borderLeftWidth: "0", borderRightWidth: "0" });
    c.querySelectorAll("*").forEach(x => { x.style.whiteSpace = "nowrap"; x.style.maxWidth = "none"; }); (el.parentElement ?? document.body).append(c); const w = c.getBoundingClientRect().width; c.remove(); return w; };
  const spareOf = (el, need) => {
    const s0 = state(el), sp = document.createElement("span"); Object.assign(sp.style, { display: "inline-block", height: "1px", verticalAlign: "top", margin: "0", padding: "0" }); sp.setAttribute("aria-hidden", "true");
    const host = textNodes(el).at(-1)?.parentElement ?? el; host.append(sp);
    const fits = w => { sp.style.width = `${w}px`; return state(el) === s0; };
    let lo = 0, hi = need; if (fits(hi)) { sp.remove(); return { avail: 2 * need, atLeast: true }; }
    while (hi - lo > 0.5) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
    sp.remove(); return { avail: need + lo, atLeast: false };
  };
  for (const el of document.querySelectorAll("body *")) {
    const kind = kindOf(el); if (!kind) continue;
    const text = el.innerText?.trim().replace(/\s+/g, " "); if (!text || text.length > 80 || !visible(el)) continue;
    const b = el.getBoundingClientRect(), lines = maxLines(el), clip = clipped(el), item = { kind, cls: [...el.classList].join(".") || el.tagName.toLowerCase(), text, lines, clipped: clip, wrapped: lines > 1, fontSize: getComputedStyle(el).fontSize, box: [r1(b.left), r1(b.top), r1(b.width), r1(b.height)] };
    const need = natural(el); item.need = r1(need);
    if (!item.wrapped && !clip) { const s = spareOf(el, need); Object.assign(item, { avail: r1(s.avail), spare: s.atLeast ? 50 : r1((1 - need / s.avail) * 100), spareAtLeast: s.atLeast }); }
    else { const cs = getComputedStyle(el); item.avail = r1(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); item.spare = r1((1 - need / item.avail) * 100); }
    out.push(item); CAND.push([el, item]);
  }
  const overlaps = [];
  const rects = CAND.map(([el]) => inBar(el) ? [] : textRects(el));
  for (let i = 0; i < CAND.length; i++) for (let j = i + 1; j < CAND.length; j++) {
    const [e1, a] = CAND[i], [e2, c] = CAND[j]; if (e1.contains(e2) || e2.contains(e1)) continue;
    let hit = null; for (const p of rects[i]) for (const q of rects[j]) { const w = Math.min(p.right, q.right) - Math.max(p.left, q.left), h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top); if (w > 2 && h > 2) hit = { w: r1(w), h: r1(h) }; }
    if (hit) overlaps.push({ a: `${a.kind} ${a.cls} "${a.text}"`, b: `${c.kind} ${c.cls} "${c.text}"`, ...hit });
  }
  return { items: out, overlaps };
};
