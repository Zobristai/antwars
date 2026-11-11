/** Lobby-only starting placement. No ticks, timers, transport or public projections. */
import { gridScaleOf, type GridScale } from "./gridScale.js";

/** The nest-pick window of every lobby except index matches. */
export const START_PICK_WINDOW_MS = 120_000;
/** The nest-pick window of an index match (house-* mode). */
export const HOUSE_START_PICK_WINDOW_MS = 240_000;

/** The nest-pick window length for a lobby: 240 s in index matches, 120 s in every other lobby. */
export function startPickWindowMsFor(houseMatch: boolean): number {
  return houseMatch ? HOUSE_START_PICK_WINDOW_MS : START_PICK_WINDOW_MS;
}

type Colony = 0 | 1;
export interface StartBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface StartTile { readonly tileX: number; readonly tileY: number }
/**
 * One roster entry. identityId is the seat's unique key: the identity id for a
 * single-seat identity, and a distinct key per seat when one identity holds several
 * seats of its colony (src/mcp/game.ts seatKeyOf), so picks are per seat.
 */
export interface StartSeat { readonly identityId: string; readonly colony: Colony }
export interface StartingNest extends StartTile, StartSeat { readonly queenId: number }
export interface StartGrid {
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly nestTileX: number;
  readonly nestTileY: number;
  readonly gridScale?: GridScale;
  readonly startArea?: "back-quarter";
}
export type StartTileObstacle = "water" | "rock" | "food" | null;
/** Row strings cover only the caller's box, in increasing global x/y order. */
export interface StartTerrain {
  readonly rows: readonly string[];
  readonly legend: string;
}
export type StartPickError = "not_seated" | "window_closed" | "invalid_tile" | "outside_box" | "water" | "rock" | "food" | "occupied";
export type StartPickResult = { readonly ok: true } | { readonly ok: false; readonly reason: StartPickError };

/** Required picks are missing: abort before assigning defaults or publishing a match. */
export class MissingStartPicksError extends Error {
  constructor() {
    super("Every seat must pick a starting nest before the window closes");
    this.name = "MissingStartPicksError";
  }
}

/** Half-open shipped-tile rectangles; mirror the whole box, not its centre rounding. */
export function startBoxes(grid: StartGrid): [StartBox, StartBox] {
  const scale = gridScaleOf(grid);
  const strip = grid.startArea === "back-quarter";
  const width = strip ? grid.mapWidth / 4 : 12 * scale, height = strip ? grid.mapHeight : 24 * scale;
  // Historical boxes transform at tile boundaries; retain their even-width bias.
  // The stored marker alone opts into strips, including during replay validation.
  const centreOffset = (scale - 1) / 2;
  const left = strip ? { x: 0, y: 0, width, height }
    : { x: grid.nestTileX - centreOffset - width / 2, y: grid.nestTileY - centreOffset - height / 2, width, height };
  const right = { ...left, x: grid.mapWidth - left.x - width };
  for (const box of [left, right]) {
    if (![box.x, box.y, box.width, box.height, grid.mapWidth, grid.mapHeight].every(Number.isSafeInteger)
      || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > grid.mapWidth || box.y + box.height > grid.mapHeight) {
      throw new Error("Starting box does not fit the map");
    }
  }
  if (left.x + width > right.x) throw new Error("Starting boxes overlap");
  return [left, right];
}

function inside(box: StartBox, tile: StartTile): boolean {
  return tile.tileX >= box.x && tile.tileX < box.x + box.width && tile.tileY >= box.y && tile.tileY < box.y + box.height;
}
const key = (tile: StartTile): string => `${tile.tileX},${tile.tileY}`;

/**
 * The slot supplies the full immutable roster, one entry per seat, including seats that never connect.
 * A window owns its generated board: terrain and food do not change before ticking.
 * Only teamView is suitable for an agent reply; finish is server-only initialization.
 */
export class StartPlacement {
  readonly closesAt: number;
  private readonly boxes: [StartBox, StartBox];
  private readonly seats: readonly StartSeat[];
  private readonly picks = new Map<string, StartTile>();
  private readonly obstacles: Map<string, Exclude<StartTileObstacle, null>>;
  private readonly candidates: [StartTile[], StartTile[]];
  private finalized: StartingNest[] | null = null;
  private readonly requireAllPicks: boolean;

  constructor(grid: StartGrid, seats: readonly StartSeat[], openedAt: number,
    obstacle: (tileX: number, tileY: number) => StartTileObstacle, windowMs = START_PICK_WINDOW_MS,
    requireAllPicks = false) {
    this.requireAllPicks = requireAllPicks;
    if (!Number.isFinite(openedAt)) throw new Error("Invalid pick window time");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("Invalid pick window duration");
    if (seats.length === 0 || new Set(seats.map(s => s.identityId)).size !== seats.length
      || seats.some(s => !s.identityId || (s.colony !== 0 && s.colony !== 1))) {
      throw new Error("Invalid starting roster");
    }
    this.boxes = startBoxes(grid);
    this.seats = seats.map(s => ({ ...s }));
    this.closesAt = openedAt + windowMs;
    this.obstacles = new Map();
    this.candidates = [[], []];
    for (const colony of [0, 1] as const) {
      const box = this.boxes[colony];
      for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
        const tile = { tileX: x, tileY: y }, blocked = obstacle(x, y);
        if (blocked !== null) this.obstacles.set(key(tile), blocked);
        else this.candidates[colony].push(tile);
      }
      const relativeX = (tile: StartTile) => colony === 0 ? tile.tileX : grid.mapWidth - 1 - tile.tileX;
      const distance = (tile: StartTile) => (relativeX(tile) - grid.nestTileX) ** 2 + (tile.tileY - grid.nestTileY) ** 2;
      this.candidates[colony].sort((a, b) => distance(a) - distance(b) || a.tileY - b.tileY || relativeX(a) - relativeX(b));
      if (this.candidates[colony].length < seats.filter(s => s.colony === colony).length) {
        throw new Error(`Starting box ${colony} has too few legal nest tiles`);
      }
    }
  }

  pick(identityId: string, tileX: number, tileY: number, now: number): StartPickResult {
    const seat = this.seats.find(s => s.identityId === identityId);
    if (seat === undefined) return { ok: false, reason: "not_seated" };
    if (!Number.isFinite(now) || now >= this.closesAt || this.finalized !== null) return { ok: false, reason: "window_closed" };
    if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY)) return { ok: false, reason: "invalid_tile" };
    const tile = { tileX, tileY };
    if (!inside(this.boxes[seat.colony], tile)) return { ok: false, reason: "outside_box" };
    const blocked = this.obstacles.get(key(tile));
    if (blocked !== undefined) return { ok: false, reason: blocked };
    if (this.seats.some(s => s.colony === seat.colony && s.identityId !== identityId
      && key(this.picks.get(s.identityId) ?? { tileX: -1, tileY: -1 }) === key(tile))) {
      return { ok: false, reason: "occupied" };
    }
    this.picks.set(identityId, tile);
    return { ok: true };
  }

  /** No opponent coordinates, roster, defaults or provisional public layout. */
  teamView(identityId: string, includeTerrain = false): { box: StartBox; closesAt: number; picks: (StartTile & { identityId: string })[]; terrain?: StartTerrain } | null {
    const seat = this.seats.find(s => s.identityId === identityId);
    if (seat === undefined) return null;
    const box = this.boxes[seat.colony];
    const terrain: StartTerrain | undefined = includeTerrain ? {
      rows: Array.from({ length: box.height }, (_, row) => Array.from({ length: box.width }, (_, column) => {
        const blocked = this.obstacles.get(key({ tileX: box.x + column, tileY: box.y + row }));
        return blocked === undefined ? "." : blocked === "water" ? "w" : blocked === "rock" ? "r" : "f";
      }).join("")),
      legend: "rows[tileY-box.y][tileX-box.x]: .=free,w=water,r=rock,f=food; also exclude teammates' picks.",
    } : undefined;
    return {
      box: { ...box }, closesAt: this.closesAt,
      ...(terrain === undefined ? {} : { terrain }),
      picks: this.seats.filter(s => s.colony === seat.colony).flatMap(s => {
        const pick = this.picks.get(s.identityId);
        return pick === undefined ? [] : [{ identityId: s.identityId, ...pick }];
      }),
    };
  }

  /** Finalize once. Required picks are checked atomically, before assigning any defaults. */
  finish(now: number): StartingNest[] {
    if (!Number.isFinite(now) || now < this.closesAt) throw new Error("Pick window is still open");
    if (this.finalized === null) {
      if (this.requireAllPicks && this.seats.some(seat => !this.picks.has(seat.identityId))) throw new MissingStartPicksError();
      const taken = new Set([...this.picks.values()].map(key));
      const queenIds = [0, 0];
      this.finalized = this.seats.map(seat => {
        const tile = this.picks.get(seat.identityId) ?? this.candidates[seat.colony].find(t => !taken.has(key(t)));
        // Constructor checked capacity, and no pick can reduce the number of free spots needed.
        if (tile === undefined) throw new Error("Starting box has no free nest tile");
        taken.add(key(tile));
        return { ...seat, queenId: queenIds[seat.colony]++, ...tile };
      });
    }
    return this.finalized.map(nest => ({ ...nest }));
  }
}
