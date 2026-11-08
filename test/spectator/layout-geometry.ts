/**
 * Layout geometry of the visible spectator dock and the landing page, as relations between measured boxes,
 * not CSS source text: a harmless CSS rewrite keeps these relations, a real regression breaks one.
 * The visible dock is the d2 HUD (web/src/ui/hud.ts, ui.css); the .aw-overlays grid that dock.test.ts pins is the
 * overlay root the HUD is built on, not drawn itself once the HUD mounts (web/src/overlays.ts mountHud).
 */
import type { Page } from "playwright-core";

export type Box = { x: number; y: number; width: number; height: number };
export type LayoutSnapshot = {
  viewport: { width: number; height: number };
  /** The first rendered match of each named selector, or null when none renders. */
  boxes: Record<string, Box | null>;
  /** The document's scroll width: more than the viewport means the page scrolls sideways. */
  scrollWidth: number;
};

export const DOCK = { score: ".d2-score", stage: ".d2-stage", foot: ".d2-foot", pane: ".d2-pane" } as const;
export const LANDING = { mast: ".fg-mast", hero: ".fg-hero", records: ".fg-records", agent: ".fg-agent" } as const;
/** Below this width the dock stacks its pane under the board; at or above it the pane stands beside the board. */
export const STACKED_BELOW_PX = 700;

/** Sub-pixel rounding allowance for every edge comparison. */
const EPS = 0.5;
const bottom = (b: Box) => b.y + b.height;
const right = (b: Box) => b.x + b.width;

/** Every named box is present, real, and inside the viewport's width; the page does not scroll sideways. */
function containmentProblems(s: LayoutSnapshot, names: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of names) {
    const b = s.boxes[name];
    if (!b) { problems.push(`${name}: missing`); continue; }
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) { problems.push(`${name}: empty or invalid box`); continue; }
    if (b.x < -EPS || right(b) > s.viewport.width + EPS) problems.push(`${name}: outside viewport width`);
  }
  if (s.scrollWidth > s.viewport.width + EPS) problems.push("page: horizontal overflow");
  return problems;
}

/** Each box ends at or above where the next one starts. */
function orderProblems(s: LayoutSnapshot, names: readonly string[]): string[] {
  const problems: string[] = [];
  for (let i = 1; i < names.length; i++) {
    const above = s.boxes[names[i - 1]!], below = s.boxes[names[i]!];
    if (above && below && bottom(above) > below.y + EPS) problems.push(`${names[i - 1]} overlaps or follows ${names[i]}`);
  }
  return problems;
}

export function dockLayoutProblems(s: LayoutSnapshot): string[] {
  const problems = containmentProblems(s, Object.keys(DOCK));
  if (problems.some(p => p.endsWith("missing") || p.includes("invalid"))) return problems;
  const { score, stage, foot, pane } = s.boxes as Record<keyof typeof DOCK, Box>;
  problems.push(...orderProblems(s, ["score", "stage", "foot"]));
  // The whole column of score, board and footer fits the screen without scrolling.
  for (const [name, b] of [["score", score], ["stage", stage], ["foot", foot]] as const) {
    if (b.y < -EPS || bottom(b) > s.viewport.height + EPS) problems.push(`${name}: outside viewport height`);
  }
  // The board keeps a real share of the screen.
  if (stage.width < s.viewport.width * 0.5) problems.push("stage: narrower than half the viewport");
  if (stage.width * stage.height < s.viewport.width * s.viewport.height * 0.2) problems.push("stage: under a fifth of the viewport");
  if (s.viewport.width < STACKED_BELOW_PX) {
    if (pane.y < bottom(foot) - EPS) problems.push("pane: not below the footer");
  } else {
    if (pane.x < right(stage) - EPS || pane.x < right(score) - EPS || pane.x < right(foot) - EPS) problems.push("pane: overlaps the board column");
    if (pane.y < -EPS || bottom(pane) > s.viewport.height + EPS) problems.push("pane: outside viewport height");
  }
  if (pane.y >= s.viewport.height) problems.push("pane: starts below the screen");
  return problems;
}

export function landingLayoutProblems(s: LayoutSnapshot): string[] {
  const problems = containmentProblems(s, Object.keys(LANDING));
  if (problems.some(p => p.endsWith("missing") || p.includes("invalid"))) return problems;
  problems.push(...orderProblems(s, ["mast", "hero", "records", "agent"]));
  const { mast, hero } = s.boxes as Record<keyof typeof LANDING, Box>;
  if (mast.y > EPS) problems.push("mast: not at the top");
  if (hero.y >= s.viewport.height) problems.push("hero: below the first screen");
  return problems;
}

/** Measures the named selectors on the page as it is laid out now. */
export function measureLayout(page: Page, selectors: Record<string, string>): Promise<LayoutSnapshot> {
  return page.evaluate((selectors) => {
    const boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const node = [...document.querySelectorAll(selector)].find(n => n.getClientRects().length > 0);
      if (!node) { boxes[name] = null; continue; }
      const { x, y, width, height } = node.getBoundingClientRect();
      boxes[name] = { x, y, width, height };
    }
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, boxes, scrollWidth: document.documentElement.scrollWidth };
  }, selectors);
}
