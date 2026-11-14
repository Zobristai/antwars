import type { InitialQueen, SimConfig } from "../sim/config.js";
import { HOLD_BEHAVIOUR, type HoldBehaviour } from "../sim/holdBehaviour.js";
import { createMatch } from "../sim/map.js";
import { isQuadrantRotation } from "../sim/mapBoard.js";
import { quadrantStartBoxes } from "../sim/quadrantMatch.js";
import { isRockTile, isWaterTile } from "../sim/terrain.js";
import { StartPlacement, type StartSeat, type StartPickResult } from "../sim/startPlacement.js";
import type { SimState } from "../sim/types.js";

/**
 * An open pick window as a handover save carries it: everything reopening it on another
 * server needs, as plain data. The board is drawn again from the seed and the pre-draw config.
 */
export interface SavedStart {
  /** The pre-draw config the window drew its board from. */
  readonly config: SimConfig;
  /** The hold behaviour every match plays, recorded in the save. */
  readonly holdBehaviour: HoldBehaviour;
  readonly seats: readonly StartSeat[];
  readonly requireAllPicks: boolean;
  /** Every seat's pick so far: seat key, tileX, tileY. */
  readonly picks: readonly (readonly [string, number, number])[];
  /** When the window was due to close on the saving server. */
  readonly closesAt: number;
  /** How long the window still had to run when it was saved. */
  readonly remainingMs: number;
}

/** A finished pick window as its begun match uses it: each seat key's starting queenId. */
export interface FinishedStart {
  queenIdOf(seatKey: string): number | undefined;
  /** Every seat key's starting queenId, for a handover save; empty before finish. */
  startingQueens(): ReadonlyMap<string, number>;
}

/** A finished start restored from a handover save: the queens alone, with no board or picks. */
export function finishedStart(queens: ReadonlyMap<string, number>): FinishedStart {
  const copy = new Map(queens);
  return { queenIdOf: seatKey => copy.get(seatKey), startingQueens: () => new Map(copy) };
}

/**
 * Private pre-tick state for a seated lobby. Slot/Game own the clock and invoke
 * finish at the deadline; neither ticks nor feed/log publication happen here.
 * Local playtests never construct this controller.
 */
export class LobbyStart implements FinishedStart {
  readonly closesAt: number;
  private readonly placement: StartPlacement;
  readonly config: SimConfig;
  private readonly seed: number;
  /** The pre-draw config, roster and pick rule this window opened with, for a handover save. */
  private readonly undrawn: SimConfig;
  private readonly seats: readonly StartSeat[];
  private readonly requireAllPicks: boolean;
  /** How many colonies pick: four on a quadrant rotation, two otherwise. */
  private readonly colonies: number;
  /** Each seat key's starting queenId as finish assigned it; empty until finish. */
  private readonly queens = new Map<string, number>();

  constructor(seed: number, config: SimConfig, seats: readonly StartSeat[], openedAt: number, windowMs?: number, requireAllPicks = false) {
    if (config.queenFounding === undefined) throw new Error("Lobby starts require queen founding rules");
    this.seed = seed;
    this.undrawn = config;
    this.seats = seats.map(seat => ({ ...seat }));
    this.requireAllPicks = requireAllPicks;
    // A reused slot must not carry the previous lobby's finalized nests forward.
    const { initialQueens: _previous, ...unpicked } = config;
    const board = createMatch(seed, unpicked);
    this.config = { ...board.config, queenFounding: { ...board.config.queenFounding!, costBasis: "founded-live" } };
    // A quadrant board's own start areas are the pick boxes; other boards keep the boxes their config gives.
    const boxes = isQuadrantRotation(unpicked) ? quadrantStartBoxes(seed, unpicked) : undefined;
    this.colonies = boxes?.length ?? 2;
    this.placement = new StartPlacement(this.config, seats, openedAt, (x, y) =>
      isWaterTile(board.terrain, x, y) ? "water" : isRockTile(board.terrain, x, y) ? "rock"
        : board.food[y * this.config.mapWidth + x] > 0 ? "food" : null, windowMs, requireAllPicks, boxes);
    this.closesAt = this.placement.closesAt;
  }

  /** A seat's pick, by its seat key (src/mcp/game.ts seatKeyOf: the identity id for a single-seat identity). */
  pick(seatKey: string, tileX: number, tileY: number, now: number): StartPickResult {
    return this.placement.pick(seatKey, tileX, tileY, now);
  }

  /** The only projection suitable for an authenticated agent's reply, for the calling seat's key. */
  teamView(seatKey: string, includeTerrain = false): ReturnType<StartPlacement["teamView"]> {
    return this.placement.teamView(seatKey, includeTerrain);
  }

  /**
   * Rules 27: the queenId of the starting queen finish gave this seat key, numbered
   * within its colony as createMatch numbers initialQueens; undefined before finish.
   */
  queenIdOf(seatKey: string): number | undefined {
    return this.queens.get(seatKey);
  }

  startingQueens(): ReadonlyMap<string, number> {
    return new Map(this.queens);
  }

  /** Handover save: this open window at `now`, as plain data; nothing here changes the window. */
  save(now: number): SavedStart {
    // A seat's team view lists its colony's picks; one seat of each colony covers them all.
    const picks = Array.from({ length: this.colonies }, (_, colony) => colony).flatMap(colony => {
      const seat = this.seats.find(s => s.colony === colony);
      return seat === undefined ? [] : this.placement.teamView(seat.identityId)!.picks.map(pick => [pick.identityId, pick.tileX, pick.tileY] as const);
    });
    return { config: this.undrawn, holdBehaviour: HOLD_BEHAVIOUR, seats: this.seats.map(seat => ({ ...seat })),
      requireAllPicks: this.requireAllPicks, picks, closesAt: this.closesAt, remainingMs: Math.max(0, this.closesAt - now) };
  }

  /**
   * Handover resume: a saved window opened again at `now` with its picks, running on for the
   * time it had left when saved, so the handover's pause takes none of the seats' pick time.
   */
  static reopen(seed: number, saved: SavedStart, now: number): LobbyStart {
    const window = new LobbyStart(seed, saved.config, saved.seats, now,
      Math.max(1, Math.ceil(saved.remainingMs)), saved.requireAllPicks);
    for (const [seatKey, tileX, tileY] of saved.picks) {
      const picked = window.pick(seatKey, tileX, tileY, now);
      if (!picked.ok) throw new Error(`the saved pick of seat ${seatKey} is refused: ${picked.reason}`);
    }
    return window;
  }

  /** A reproducible tick-zero state, suitable for both live setup and offline fixtures. */
  finish(now: number): SimState {
    const nests = this.placement.finish(now);
    for (const nest of nests) this.queens.set(nest.identityId, nest.queenId);
    const team = (colony: number): InitialQueen[] => nests.filter(nest => nest.colony === colony)
      .map(({ tileX, tileY }) => ({ tileX, tileY }));
    return createMatch(this.seed, { ...this.config, initialQueens: Array.from({ length: this.colonies }, (_, colony) => team(colony)),
      queenFounding: { ...this.config.queenFounding!, costBasis: "founded-live" } });
  }
}
