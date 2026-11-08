/** Delayed start-layout metadata only: no map lookup or pre-match request. */
import type { StreamQueen, StreamSetup } from "../../src/live/format.ts";

export type StartBox = NonNullable<StreamSetup["startBoxes"]>[number];

/** Canonical decoded layout; old recordings deliberately omit these fields. */
export type StartLayout = Pick<StreamSetup, "startBoxes" | "startingQueenIds"> & { readonly gridScale?: 2 };

export type StartBoxSetup = Pick<StreamSetup, "mapW" | "mapH"> & StartLayout;
export interface VisibleStartBox extends StartBox { readonly colony: 0 | 1 }

/** Keep authoritative tile edges; invalid rectangles are not clamped into invented geometry. */
export function visibleStartBoxes(setup: StartBoxSetup | undefined): VisibleStartBox[] {
  if (!setup?.startBoxes) return [];
  const result: VisibleStartBox[] = [];
  for (const colony of [0, 1] as const) {
    const box = setup.startBoxes[colony];
    if (![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) ||
        box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 ||
        box.x + box.width > setup.mapW || box.y + box.height > setup.mapH) continue;
    result.push({ ...box, colony });
  }
  return result;
}

/** Founding on tick zero is still founding. Historical streams used id zero as their sole start. */
export function isStartingQueen(setup: Pick<StreamSetup, "mapW"> & StartLayout, queen: Pick<StreamQueen, "colony" | "id">): boolean {
  return setup.startingQueenIds === undefined ? queen.id === 0 : setup.startingQueenIds[queen.colony].includes(queen.id);
}
