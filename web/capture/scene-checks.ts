/**
 * What a still's measurements say is wrong: the checks web/capture/stills.ts runs on every scene's
 * record, pure, so each rule is pinned by a test. A desktop's status line on a second line fails the run, as do an
 * empty corner of the board's area, a clipped tooltip, and at the fall moment a fallen colony's nest not whole in the
 * board's area (the fallen queen whole in frame at every viewport).
 */
import type { Rect } from "../src/words.ts";

export interface SceneRecord {
  file: string;
  /** Texts that keep one line but took more (stills.ts statusWraps): a desktop's status line, each "kind: text (N lines)". */
  wraps?: string[];
  /**
   * Whether the board fills its area (no large empty bands): the board area's corners, each
   * STAGE_INSET px in, that lie off the board's projected outline, named; empty when the board fills it.
   */
  emptyCorners: string[];
  /** The board's share of the screen's height: the board area's height over the viewport's, reported with every scene (a portrait phone's board to reach 40% of the height). */
  boardShare: number;
  /** The tooltip shown, when one is: its box, which must lie whole on the screen (never clipped). */
  tooltip?: { x0: number; y0: number; x1: number; y1: number; onScreen: boolean };
  /**
   * The fall scene: the colony the board shows fallen (every queen the stream lists for it lost; null with none), the
   * board's area, and each of that colony's queens, her box on the screen through the board's camera (stills.ts: her
   * tile and her emblem, FALL_EMBLEM_PX around its centre; her zone may
   * and ground margin may give way at the area's top and bottom), which must lie whole in the board's area: the fallen queen
   * whole in frame at every viewport.
   */
  fall?: { colony: number | null; stage: Rect; nests: { id: number; rect: Rect }[] };
}

/** A box as "x0,y0–x1,y1", whole px. */
const box = (r: Rect) => `${Math.round(r.x0)},${Math.round(r.y0)}–${Math.round(r.x1)},${Math.round(r.y1)}`;

/** Whether r lies whole within s, to half a px. */
const within = (r: Rect, s: Rect) => r.x0 >= s.x0 - 0.5 && r.y0 >= s.y0 - 0.5 && r.x1 <= s.x1 + 0.5 && r.y1 <= s.y1 + 0.5;

/** A desktop's status line is one line in every state ("· 4 agents" was left alone on a second line). */
export function wrapProblems(s: Pick<SceneRecord, "file" | "wraps">): string[] {
  return (s.wraps ?? []).map((text) => `${s.file}: ${text}; it keeps one line`);
}

/** Each problem a scene's record shows, prefixed with its still's file. */
export function sceneProblems(s: SceneRecord): string[] {
  const out: string[] = [];
  const problem = (text: string) => out.push(`${s.file}: ${text}`);
  out.push(...wrapProblems(s));
  // The board fills its area: no corner of the area lies off the board.
  if (s.emptyCorners.length > 0) problem(`the board leaves the stage's ${s.emptyCorners.join(" and ")} corner(s) empty; the board must fill its area`);
  // A tooltip lies whole on the screen (never clipped).
  if (s.tooltip && !s.tooltip.onScreen) problem(`the tooltip at ${s.tooltip.x0},${s.tooltip.y0}–${s.tooltip.x1},${s.tooltip.y1} is not whole on the screen`);
  // The fall scene shows the fallen queen whole in frame: a colony has fallen, and each of its queens
  // lies whole in the board's area, on every viewport.
  if (s.fall) {
    if (s.fall.colony === null) problem("no colony has fallen at the fall moment; the fall scene must show the fallen queen");
    for (const n of s.fall.nests) if (!within(n.rect, s.fall.stage)) problem(`colony ${s.fall.colony}'s queen ${n.id} at ${box(n.rect)} is not whole in the stage at ${box(s.fall.stage)}; the fallen queen must be whole in frame at every viewport`);
  }
  return out;
}
