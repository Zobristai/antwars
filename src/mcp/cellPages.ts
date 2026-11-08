import { randomUUID } from "node:crypto";
import { withinTiles } from "../sim/geometry.js";
import type { SimConfig } from "../sim/config.js";
import type { AgentView, ViewCell } from "../sim/view.js";

/** One already-fogged capture, not explored ground or a simulation-state cache. */
export interface CellSnapshot {
  readonly id: string;
  readonly tick: number;
  readonly cells: readonly ViewCell[];
  readonly squadCells: number;
  /** Only offsets actually issued by the pager may be replayed. Bounded by cells.length. */
  readonly offsets: Set<number>;
}

export function captureCells(view: AgentView, config: SimConfig): CellSnapshot {
  const own: ViewCell[] = [], rest: ViewCell[] = [];
  for (const cell of view.cells) {
    const squadSight = view.squad.some(ant => ant.hp > 0 && withinTiles(ant.tileX, ant.tileY, cell.tileX, cell.tileY, config.sightTiles));
    (squadSight ? own : rest).push(cell);
  }
  return { id: randomUUID(), tick: view.tick, cells: structuredClone([...own, ...rest]), squadCells: own.length, offsets: new Set() };
}

export function cellOffset(snapshot: CellSnapshot, cursor: string): number | null {
  const [id, offset, extra] = cursor.split(":");
  if (id !== snapshot.id || extra !== undefined || offset === undefined || !/^(0|[1-9][0-9]*)$/.test(offset)) return null;
  const value = Number(offset);
  return Number.isSafeInteger(value) && value < snapshot.cells.length && snapshot.offsets.has(value) ? value : null;
}

export function cellContinuation(snapshot: CellSnapshot, offset: number) {
  const more = offset < snapshot.cells.length;
  return { cellsTick: snapshot.tick, cellsMore: more, cellsCursor: more ? `${snapshot.id}:${offset}` : null };
}
