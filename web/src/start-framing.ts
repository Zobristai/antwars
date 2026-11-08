/** Opening-only fits from the public, finalized delayed layout; never provisional picks. */
import { SUB_TILE, streamQueens, type StreamQueen, type StreamSetup } from "../../src/live/format.ts";
import type { Box, View } from "./camera.ts";
import { gridScale } from "./grid-scale.ts";
import { isStartingQueen, visibleStartBoxes } from "./start-boxes.ts";

type OpeningBoard = { setup: StreamSetup; queens?: readonly StreamQueen[]; result: unknown | null };

/** Finalized tick zero is the only published opening phase. Loss/result always ends it. */
export function openingPhase(tick: number, board: OpeningBoard | null | undefined): board is OpeningBoard {
  return tick === 0 && board != null && board.result === null &&
    board.setup.startingQueenIds !== undefined && visibleStartBoxes(board.setup).length === 2 &&
    streamQueens(board).every(q => q.lostTick === null);
}

/** Union of authoritative rectangles and every starting nest's visible ground extent.
 * Never clamp to the map: a nest marker can extend beyond its edge. Legacy metadata is not guessed.
 * extraRadius lets the 3D caller account for its existing queen mesh without resizing it.
 */
export function openingBounds(board: OpeningBoard, extraRadius = 0): Box | null {
  const boxes = visibleStartBoxes(board.setup);
  const ids = board.setup.startingQueenIds;
  if (boxes.length !== 2 || !ids || ids.some(group => group.length === 0)) return null;
  const queens = streamQueens(board).filter(q => isStartingQueen(board.setup, q));
  if (ids.some((group, colony) => group.some(id => !queens.some(q => q.colony === colony && q.id === id)))) return null;
  if (queens.some(q => !Number.isFinite(q.x) || !Number.isFinite(q.y))) return null;
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const include = (x0: number, y0: number, x1: number, y1: number) => {
    b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0);
    b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1);
  };
  for (const box of boxes) include(box.x, box.y, box.x + box.width, box.y + box.height);
  const r = Math.max(3 * gridScale(board.setup), board.setup.overrunRadiusTiles, extraRadius);
  for (const queen of queens) {
    const x = Math.floor(queen.x / SUB_TILE), y = Math.floor(queen.y / SUB_TILE);
    include(x - r, y - r, x + 1 + r, y + 1 + r);
  }
  return b;
}

/** CSS-pixel allowance for the fixed-size crown, HP bar and bracket stroke. */
export const OPENING_MARGIN = 24;

/** Containment outranks the live camera's cover and ant-size floor only during opening. */
export function fitOpeningView(box: Box, area: Box): View {
  const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
  const margin = Math.min(OPENING_MARGIN, aw / 4, ah / 4);
  const tilePx = Math.min((aw - 2 * margin) / (box.x1 - box.x0), (ah - 2 * margin) / (box.y1 - box.y0));
  return { tilePx, ox: (area.x0 + area.x1 - (box.x0 + box.x1) * tilePx) / 2,
    oy: (area.y0 + area.y1 - (box.y0 + box.y1) * tilePx) / 2 };
}
