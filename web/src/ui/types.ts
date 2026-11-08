// What the spectator HUD and the standalone pages are given, and what each returns.
import type { Frame } from "../buffer.ts";
import type { OverlayHandlers, AntInfo } from "../overlays.ts";
import type { ModeCopy } from "../replay.ts";
import type { Rect } from "../words.ts";

/** The live view the HUD draws, published by Overlays. */
export interface HudView {
  readonly frame: Frame | null;
  readonly connection: string;
  readonly board: "2d" | "3d" | "unavailable";
  readonly selected: AntInfo | null;
  readonly selectedAgent: number;
  /** The page's live/recorded line as the board computes it (replay.ts modeCopy); null until the board sets it. */
  readonly mode: ModeCopy | null;
  /** Playback has run out of data while the match still runs (Playback.underrun), as the board reports it. */
  readonly stalled: boolean;
  /** The public link the result's Share on X names (source.ts watchUrl); absent or null for a private match, or until set. */
  readonly share?: string | null;
}

export type HudActions = OverlayHandlers & {
  select(info: AntInfo | null): void;
  selectAgent(agent: number): void;
  /** Light an agent's order tile on the board while its row is pointed at (-1: none); the owner follows each frame. */
  pointOrder(agent: number): void;
};

export interface HudHost {
  readonly doc: Document;
  readonly host: HTMLElement;
  /** The board's mark and squad tooltips (tip.ts), shown over the HUD's view: the HUD takes them in at its root. */
  readonly tips: readonly HTMLElement[];
  /** An explicit replay's speed and position controls (replay-controls.ts), listeners and all; null elsewhere. */
  readonly replay: HTMLElement | null;
  /** The board's point-of-view choice (team-view.ts); null with no board. */
  readonly teamView: HTMLElement | null;
  /** The needs-WebGL message the page shows in the board's window when no board runs (main.ts startWithoutBoard); null with a board. */
  readonly waiting: HTMLElement | null;
  /** The board's stable frame ratio (Overlays.setBoardAspect), which sizes the 2D window; null for the setup's. */
  readonly boardAspect: number | null;
  readonly actions: HudActions;
}

export interface Mounted<View> {
  update(view: View): void;
  destroy(): void;
  /** HUD only: the board's window, in viewport CSS pixels. */
  boardArea?(): Rect;
}

/** A standalone page (Leaderboard, Matches): where it draws and the page's own requests. */
export interface PageHost {
  readonly doc: Document;
  readonly host: HTMLElement;
  readonly actions: { refresh(): void; more(): void };
}
