import type { Page } from "playwright-core";

/** The HUD's status line: the 2D board's, or the deck's legend. */
const STATUS_LINE = ".d2-status, .d1-legend";

export interface PlacementRect { x: number; y: number; width: number; height: number }
export interface PlacementBox { name: string; rect: PlacementRect }
export interface PlacementSnapshot {
  viewport: { width: number; height: number };
  board: PlacementBox;
  statusLine: PlacementBox;
  controls: PlacementBox[];
}

/** No rounding or tolerance can turn a positive intersection into a pass. */
export function placementIntersection(a: PlacementRect, b: PlacementRect): { width: number; height: number; area: number } | null {
  for (const rect of [a, b]) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error("Invalid placement rectangle");
    }
  }
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height, area: width * height } : null;
}

/** Every target must be visible in the ordinary viewport; no scrolling or offscreen workaround. */
export function assertSpectatorPlacement(snapshot: PlacementSnapshot): void {
  const problems: string[] = [];
  const { width, height } = snapshot.viewport;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Invalid viewport");
  const targets = [snapshot.statusLine];
  for (const box of [...targets, snapshot.board]) {
    placementIntersection(box.rect, box.rect); // Validate, including positive area.
    const r = box.rect;
    const requireInView = targets.includes(box);
    if (requireInView && (r.x < 0 || r.y < 0 || r.x + r.width > width || r.y + r.height > height)) problems.push(`${box.name} is outside the viewport`);
  }
  const check = (a: PlacementBox, b: PlacementBox) => {
    const overlap = placementIntersection(a.rect, b.rect);
    if (overlap) problems.push(`${a.name} intersects ${b.name}: ${overlap.width} × ${overlap.height} px`);
  };
  for (const target of targets) {
    check(target, snapshot.board);
    for (const control of snapshot.controls) check(target, control);
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

/** Read-only DOM measurements in ordinary playback; no CSS injection, capture mode or hiding. */
export async function measureSpectatorPlacement(page: Pick<Page, "evaluate">): Promise<PlacementSnapshot> {
  return page.evaluate((selector) => {
    const visible = (element: Element): element is HTMLElement => {
      // Closed <details> descendants can retain rectangles despite not being painted.
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
          const summary = Array.from(ancestor.children).find(child => child.tagName === "SUMMARY");
          if (!summary?.contains(element)) return false;
        }
      }
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const style = getComputedStyle(element);
      const r = element.getBoundingClientRect();
      return element.getClientRects().length > 0 && r.width > 0 && r.height > 0
        && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const unique = (selector: string): HTMLElement => {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (nodes.length !== 1) throw new Error(`Expected one visible ${selector}, found ${nodes.length}`);
      return nodes[0]!;
    };
    const box = (name: string, element: Element) => ({ name, rect: rect(element) });
    const status = unique(selector);
    // The board's area: the host's (window.__antwar.boardArea()).
    const area = window.__antwar.boardArea();
    // Semantic UI controls only: a full-window drawing canvas is not a 44 px button.
    const controls = Array.from(document.querySelectorAll("button, [role='button'], summary, a[href], input, select"))
      .filter(visible).filter(element => !(status === element || status.contains(element)))
      .filter(element => element.getBoundingClientRect().height >= 44)
      .map((element, index) => box(`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className} ${element.textContent?.trim().slice(0, 80) ?? ""} [${index}]`, element));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      board: { name: "board area", rect: { x: area.x0, y: area.y0, width: area.x1 - area.x0, height: area.y1 - area.y0 } },
      statusLine: box("live status", status), controls,
    };
  }, STATUS_LINE);
}
