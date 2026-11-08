// The HUD's DOM icons: each keeps its vector markup and is overlaid by its masks once they load, then the vector hides.
import { iconMasks } from "./textures.ts";
import type { IconKey } from "./set.ts";
interface Region { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly keep?: number }
interface Definition { key: IconKey; markup: string; colour: string; region?: Region }
const definitions = new Map<string, Definition>();
let nextMaskId = 0;
const textControls = new WeakMap<HTMLElement, IconKey>();
/** Register an existing text control without changing its DOM or listeners. */
export function textIcon<T extends HTMLElement>(key: IconKey, control: T): T {
  textControls.set(control, key);
  return control;
}
/** Returns the vector markup byte-identical. The watch-view mount owns any DOM enhancement. */
export function domIcon(key: IconKey, markup: string, colour = "currentColor", region?: Region): string {
  if (!definitions.has(markup)) definitions.set(markup, { key, markup, colour, region });
  return markup;
}
/** Only the watch view mounts this; shared close markup on other pages stays untouched. */
export function mountIconDom(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win || !win.MutationObserver) return () => {};
  const state = iconMasks();
  const drawings: { def: Definition; svg: Element }[] = [];
  const parsed = new Set<string>();
  const enhanced = new Map<Element, { key: IconKey; src: string; second?: string; restore: () => void }>();
  const failed = new Set<string>();
  const ns = "http://www.w3.org/2000/svg";
  function maskLayer(node: Element, region: Region, kind: "svg" | "text", colour: string, urls: string[], hide: () => void) {
    const layer = doc.createElementNS(ns, "g"), defs = doc.createElementNS(ns, "defs");
    layer.dataset.iconLayer = ""; layer.style.visibility = "hidden"; layer.append(defs);
    function maskId() {
      let id: string;
      do { id = `aw-icon-mask-${++nextMaskId}`; } while (doc.getElementById(id));
      return id;
    }
    // Composite opaque colours first, then apply the live ink alpha once to the group.
    // SVG filter primitives work in WebKit, unlike CSS brightness(). A group alpha
    // mask does not: WebKit applies it to each child, letting the fill show through.
    const ink = doc.createElementNS(ns, "filter"), flood = doc.createElementNS(ns, "feFlood"), composite = doc.createElementNS(ns, "feComposite");
    ink.id = maskId(); ink.setAttribute("filterUnits", "userSpaceOnUse");
    ink.setAttribute("color-interpolation-filters", "sRGB");
    for (const [key, value] of Object.entries({ x: region.x, y: region.y, width: region.w, height: region.h })) ink.setAttribute(key, String(value));
    flood.setAttribute("flood-color", colour);
    composite.setAttribute("in", "SourceGraphic"); composite.setAttribute("operator", "in");
    ink.append(flood, composite); defs.append(ink); layer.setAttribute("filter", `url(#${ink.id})`);
    const opaque = `rgb(from ${colour} r g b / 1)`;
    let cancelled = false, broken = false, remaining = urls.length, frame = 0;
    const cleanups: (() => void)[] = [], starts: (() => void)[] = [];
    for (const [index, src] of urls.entries()) {
      const mask = doc.createElementNS(ns, "mask"), image = doc.createElementNS(ns, "image");
      const id = maskId();
      mask.id = id; mask.style.maskType = "alpha";
      mask.setAttribute("maskUnits", "userSpaceOnUse"); mask.setAttribute("maskContentUnits", "userSpaceOnUse");
      const rect = doc.createElementNS(ns, "rect");
      for (const [key, value] of Object.entries({ x: region.x, y: region.y, width: region.w, height: region.h })) {
        for (const element of [mask, image, rect]) element.setAttribute(key, String(value));
      }
      // As the former CSS masks did: text uses contain; SVG regions fill their box.
      image.setAttribute("preserveAspectRatio", kind === "text" ? "xMidYMid meet" : "none");
      rect.setAttribute("fill", index ? `color-mix(in srgb, ${opaque} 70%, black)` : opaque);
      rect.setAttribute("stroke", "none"); rect.setAttribute("mask", `url(#${id})`);
      const loaded = () => {
        if (cancelled || broken || --remaining !== 0) return;
        // These are the actual rendered mask images, not a separate cache probe.
        layer.style.removeProperty("visibility");
        frame = win!.requestAnimationFrame(() => {
          frame = win!.requestAnimationFrame(() => { if (!cancelled && node.isConnected) hide(); });
        });
      };
      const error = () => { broken = true; failed.add(src); };
      image.addEventListener("load", loaded, { once: true }); image.addEventListener("error", error, { once: true });
      cleanups.push(() => { image.removeEventListener("load", loaded); image.removeEventListener("error", error); });
      starts.push(() => { if (failed.has(src)) broken = true; else image.setAttribute("href", src); });
      mask.append(image); defs.append(mask); layer.append(rect);
    }
    return {
      layer,
      start: () => { for (const start of starts) start(); },
      restore: () => { cancelled = true; win!.cancelAnimationFrame(frame); for (const cleanup of cleanups) cleanup(); layer.remove(); },
    };
  }
  function index() {
    for (const [markup, def] of definitions) if (!parsed.has(markup)) {
      const template = doc.createElement("template"); template.innerHTML = markup;
      const svg = template.content.firstElementChild;
      if (svg) drawings.push({ def, svg });
      parsed.add(markup);
    }
  }
  function matches(node: Node, original: Node): boolean {
    if (node.nodeType !== original.nodeType || node.nodeName !== original.nodeName) return false;
    if (!(node instanceof win!.Element) || !(original instanceof win!.Element)) return node.nodeValue === original.nodeValue;
    // Added runtime attributes are allowed at every depth, including style="" left
    // by a restore. Registered geometry, colours, styles and child structure still match.
    return node.namespaceURI === original.namespaceURI
      && [...original.attributes].every(attr => node.getAttribute(attr.name) === attr.value)
      && node.childNodes.length === original.childNodes.length
      && [...original.childNodes].every((child, i) => matches(node.childNodes[i]!, child));
  }
  function enhance(svg: SVGSVGElement, def: Definition) {
    const mask = state.get(def.key);
    if (!mask || !state.isReady(def.key)) return;
    const box = svg.getAttribute("viewBox")?.split(/\s+/).map(Number) ?? [0, 0, 24, 24];
    const r = def.region ?? { x: box[0]!, y: box[1]!, w: box[2]!, h: box[3]! };
    const children = [...svg.children].slice(r.keep ?? 0) as SVGElement[];
    const styles = children.map(node => node.getAttribute("style"));
    const replacement = maskLayer(svg, r, "svg", def.colour, [mask.src, ...(mask.second ? [mask.second.src] : [])],
      () => { children.forEach(node => { node.style.display = "none"; }); });
    svg.append(replacement.layer); replacement.start();
    enhanced.set(svg, { key: def.key, src: mask.src, second: mask.second?.src, restore: () => {
      replacement.restore(); children.forEach((node, i) => {
        // Flush the CSSOM write before restoring: otherwise Chromium can materialize
        // an empty style attribute after removeAttribute, changing the original markup.
        node.getAttribute("style");
        const style = styles[i]; if (style === null) node.removeAttribute("style"); else node.setAttribute("style", style!);
      });
    } });
  }
  function enhanceText(control: HTMLElement, key: IconKey) {
    const mask = state.get(key);
    if (!mask || !state.isReady(key)) return;
    const original = [...control.childNodes];
    // Preserve the natural text box while overlaying a real SVG mask in the same cell.
    const host = doc.createElement("i"), current = doc.createElement("i"), svg = doc.createElementNS(ns, "svg");
    host.style.cssText = "display:inline-grid;vertical-align:middle;place-items:center;font-style:normal";
    current.style.cssText = "grid-area:1/1;font-style:normal"; current.append(...original);
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    svg.style.cssText = "display:block;width:1em;height:1em;grid-area:1/1";
    const replacement = maskLayer(control, { x: 0, y: 0, w: 24, h: 24 }, "text", "currentColor",
      [mask.src, ...(mask.second ? [mask.second.src] : [])], () => { current.style.visibility = "hidden"; });
    svg.append(replacement.layer); host.append(current, svg); control.replaceChildren(host); replacement.start();
    enhanced.set(control, { key, src: mask.src, second: mask.second?.src, restore: () => {
      replacement.restore(); control.replaceChildren(...original);
    } });
  }
  const observer = new win.MutationObserver(records => {
    if (!state.version) return;
    observer.disconnect(); index();
    for (const record of records) for (const node of record.addedNodes) if (node instanceof win.Element) scan(node);
    prune(); observe();
  });
  function scan(root: ParentNode) {
    const nodes = [...root.querySelectorAll<Element>("svg, button")];
    if (root instanceof win!.Element) nodes.unshift(root);
    for (const node of nodes) if (!enhanced.has(node)) {
      if (node instanceof win!.SVGSVGElement) {
        const entry = drawings.find(candidate => matches(node, candidate.svg));
        if (entry) enhance(node, entry.def);
      } else if (node instanceof win!.HTMLElement) {
        const key = textControls.get(node);
        if (key) enhanceText(node, key);
      }
    }
  }
  function prune() { for (const [svg, entry] of enhanced) if (!svg.isConnected) { entry.restore(); enhanced.delete(svg); } }
  function observe() { observer.observe(doc.body, { childList: true, subtree: true }); }
  const unsubscribe = state.subscribe(() => {
    observer.disconnect();
    // Notifications are global, but a key's loaded URLs are not. Unrelated arrivals
    // must not tear down already painted layers (or restart pending handoffs).
    for (const [node, entry] of enhanced) {
      const mask = state.get(entry.key);
      if (!state.isReady(entry.key) || mask?.src !== entry.src || mask.second?.src !== entry.second) {
        entry.restore(); enhanced.delete(node);
      }
    }
    prune(); index(); scan(doc.body); observe();
  });
  index(); scan(doc.body); observe();
  // A page kept in the back/forward cache returns without rerunning the entry, so only a final pagehide tears down.
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) destroy(); };
  const destroy = () => { observer.disconnect(); unsubscribe(); for (const entry of enhanced.values()) entry.restore(); enhanced.clear(); win.removeEventListener("pagehide", onPageHide); };
  win.addEventListener("pagehide", onPageHide);
  return destroy;
}
