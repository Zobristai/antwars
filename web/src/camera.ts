/**
 * The viewer's camera (viewer zoom and pan, and no
 * automatic camera). The camera moves only when the viewer moves it: wheel or
 * pinch to zoom about the pointer, drag to pan, double-click to return to the
 * whole board, choose a mark in the log to bring it to the middle of the board
 * area, and the page's zoom, Whole board and Show on board buttons.
 * One exception: in the fall window, from a
 * colony's last queen's death until the result card, the page turns onto the
 * fallen colony's nests (fallView); the next match opens on the fight again.
 *
 * The board lives in an area of the screen (between the page's panels). Zoomed
 * in, it is kept covering that area, so every part of it can be panned into
 * view there; zoomed out, it is the whole board fitted in the area. The initial
 * view frames the fight lane between the nests (fightLane): a first-time viewer lands on the fight,
 * with the ants big enough to read, and zooms out to the whole board.
 */
import { SUB_TILE, type StreamSetup } from "../../src/live/format.ts";
import { gridScale, type GridScaleSetup } from "./grid-scale.ts";
import { fitOpeningView } from "./start-framing.ts";
import { FALL_EMBLEM_PX, QUEEN_FRAME_TILES } from "./buffer.ts";

export interface View {
  /** Screen position (CSS px) of tile (0, 0). */
  ox: number;
  oy: number;
  /** CSS px per tile. */
  tilePx: number;
}

/** How far in the viewer may zoom, as a multiple of the whole-board scale. */
export const MAX_ZOOM = 8;
/** Roundoff allowance for reconstructing a complete opening view, not a user-motion threshold. */
const OPENING_VIEW_RELATIVE_TOLERANCE = 16 * Number.EPSILON;
/** Show on board's zoom: a place on the board shown at three times the whole-board scale. */
export const LOCATE_ZOOM = 3;
/** One press of the page's zoom buttons. */
export const ZOOM_STEP = 1.5;
/**
 * The fall window's zoom: at least this many times the
 * initial view's, a step in, never the nests' box fitted to the area...
 */
export const FALL_ZOOM = 1.4;
/**
 * ...and near enough that the fallen colony's nests (fallenNests: their zones and FALL_FRAME_PAD around) span this
 * share of the area on their larger side, so the fall is the match's dramatic moment with the fallen queen whole in
 * frame at every viewport, the ground around her still in view...
 */
export const FALL_FILL = 0.5;
/** ...reached by a short camera move of this length on the playback clock, eased (easeInOut); a cut for a viewer who prefers reduced motion. */
export const FALL_MOVE_MS = 900;

/** Smoothstep easing of t in 0..1: the camera's move into the fall starts and ends at rest. */
export function easeInOut(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

/** The view part way (t, 0..1) from a to b. */
export function lerpView(a: View, b: View, t: number): View {
  return { ox: a.ox + (b.ox - a.ox) * t, oy: a.oy + (b.oy - a.oy) * t, tilePx: a.tilePx + (b.tilePx - a.tilePx) * t };
}

/** Whether the viewer prefers reduced motion: the board's own moves cut instead of easing. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A box on the board, in tiles: [x0, x1) by [y0, y1). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type Area = Box;

/** The fight lane reaches this far beyond the queens' tiles, in tiles, within the map. */
export const LANE_PAD = 10;
/**
 * The initial view shows at least this many CSS px per tile: an ant then spans 16 px
 * (web/src/ants.ts antLengthPx), big enough to read at a glance.
 */
export const HOME_TILE_PX = 12.5;

/**
 * The fight lane: the ground between the two nests, where the squads march and the colonies
 * meet, LANE_PAD tiles beyond the queens' tiles each way, within the map. Read from the stream's
 * setup alone, so every viewer lands on the same view.
 */
export function fightLane(setup: Pick<StreamSetup, "mapW" | "mapH" | "queens"> & GridScaleSetup): Box {
  return paddedQueens(setup, LANE_PAD);
}

/** Frame original physical cells, not the arbitrary finer cell containing a queen. */
function paddedQueens(setup: Pick<StreamSetup, "mapW" | "mapH" | "queens"> & GridScaleSetup, padding: number): Box {
  const scale = gridScale(setup);
  const xs = setup.queens.map(([x]) => Math.floor(x / SUB_TILE / scale) * scale);
  const ys = setup.queens.map(([, y]) => Math.floor(y / SUB_TILE / scale) * scale);
  return {
    x0: Math.max(0, Math.min(...xs) - padding * scale),
    y0: Math.max(0, Math.min(...ys) - padding * scale),
    x1: Math.min(setup.mapW, Math.max(...xs) + (1 + padding) * scale),
    y1: Math.min(setup.mapH, Math.max(...ys) + (1 + padding) * scale),
  };
}

/** The queens' box reaches this far beyond their tiles, in tiles: the nest's emblem and its zone's brackets. */
export const QUEENS_PAD = 3;

/** The 2D default covers every legal founding tile, not the current queen list.
 * nests() includes QUEEN_FRAME_TILES beyond the edge tile; the extra quarter tile
 * is a containment margin, reported separately from that required border. */
export function foundingEnvelope(setup: Pick<StreamSetup, "mapW" | "mapH">): Box {
  const border = QUEEN_FRAME_TILES + 0.25;
  return { x0: -border, y0: -border, x1: setup.mapW + border, y1: setup.mapH + border };
}

/** No percentage padding: the envelope already contains the measured nest border and margin.
 * The stage's agreed aspect input removes unused space on the other axis. */
export function fitFoundingView(box: Box, area: Box): View {
  const tilePx = Math.min((area.x1 - area.x0) / (box.x1 - box.x0), (area.y1 - area.y0) / (box.y1 - box.y0));
  return { tilePx, ox: (area.x0 + area.x1 - (box.x0 + box.x1) * tilePx) / 2,
    oy: (area.y0 + area.y1 - (box.y0 + box.y1) * tilePx) / 2 };
}

/**
 * Both queens' nests, QUEENS_PAD tiles around their tiles, within the map: what the initial view keeps in frame at
 * every viewport (the default view shows both queens), ahead of the
 * ant-size floor and the cover.
 */
export function queensBox(setup: Pick<StreamSetup, "mapW" | "mapH" | "queens"> & GridScaleSetup): Box {
  return paddedQueens(setup, QUEENS_PAD);
}

/**
 * A pinch on the board is the board's zoom, never the browser's page zoom, in either orientation: the canvas's touch-action none (index.html) asks the browser for that, and a
 * browser that pinches the page regardless (Safari, through its gesture events) is refused here: a two-finger touch
 * move and a gesture start on the board are not the page's. Both boards' canvases call this.
 */
export function keepPinch(el: HTMLElement): void {
  // Trackpad pinch arrives as ctrl+wheel; cancel the page default, not the board's zoom handlers.
  el.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
  el.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
  el.addEventListener("gesturestart", (e) => e.preventDefault());
}

/**
 * The nearest zoom (CSS px per tile) at which every fallen queen's tile and emblem fit a height of h px: queens is
 * buffer.ts fallenQueenBox (their tiles and QUEEN_FRAME_TILES around), each emblem FALL_EMBLEM_PX from her tile's centre.
 */
export function fallRows(queens: Box, h: number): number {
  const rows = queens.y1 - queens.y0 - 2 * QUEEN_FRAME_TILES;
  return Math.min(h / rows, rows > 1 ? (h - 2 * FALL_EMBLEM_PX) / (rows - 1) : Infinity);
}

/** The whole of box centred in area, with a small margin. */
function fitView(box: Box, a: Area): View {
  const aw = a.x1 - a.x0;
  const ah = a.y1 - a.y0;
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const tilePx = Math.min(aw / bw, ah / bh) * 0.98;
  return { tilePx, ox: a.x0 + (aw - bw * tilePx) / 2 - box.x0 * tilePx, oy: a.y0 + (ah - bh * tilePx) / 2 - box.y0 * tilePx };
}

export class Camera {
  readonly mapW: number;
  readonly mapH: number;
  screenW: number;
  screenH: number;
  /** The whole-board view. */
  fit: View;
  /** The screen rectangle the board is shown in: the whole board fits into it (between the page's panels). */
  area: Area;
  view: View;
  /** The box the initial view frames (fightLane), or null for the whole board. */
  private readonly home: Box | null;
  /** The box the initial view never lets leave the area (queensBox), or null. */
  private readonly keep: Box | null;
  private listeners: ((v: View) => void)[] = [];
  private opening: Box | null = null;
  private stableHome: Box | null = null;

  /** Opt-in 2D normal home. Set from immutable map dimensions, never on founding.
   * Existing callers (including 3D) retain the original camera behavior. */
  setFoundingEnvelope(bounds: Box | null): void {
    if (this.stableHome === bounds || (this.stableHome && bounds &&
      this.stableHome.x0 === bounds.x0 && this.stableHome.y0 === bounds.y0 &&
      this.stableHome.x1 === bounds.x1 && this.stableHome.y1 === bounds.y1)) return;
    const home = this.atHome();
    this.stableHome = bounds;
    if (home) this.set(this.homeView());
  }

  /** Replace or clear the opening constraint before live/fall calculations. A moved view stays moved. */
  setOpeningBounds(bounds: Box | null): void {
    if (this.opening === bounds || (this.opening && bounds &&
      this.opening.x0 === bounds.x0 && this.opening.y0 === bounds.y0 &&
      this.opening.x1 === bounds.x1 && this.opening.y1 === bounds.y1)) return;
    const home = this.atHome();
    this.opening = bounds;
    if (home) this.set(this.homeView());
  }

  /**
   * area: the screen rectangle the whole board fits into by default (between the overlay panels).
   * home: the box the initial view frames; without one, the whole board.
   * keep: the box the initial view keeps in frame however near it comes (both queens' nests).
   */
  constructor(mapW: number, mapH: number, screenW: number, screenH: number, area?: Area, home?: Box, keep?: Box, private readonly physicalScale = 1) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.screenW = screenW;
    this.screenH = screenH;
    this.area = area ?? { x0: 0, y0: 0, x1: screenW, y1: screenH };
    this.fit = fitView({ x0: 0, y0: 0, x1: mapW, y1: mapH }, this.area);
    this.home = home ?? null;
    this.keep = keep ?? null;
    this.view = this.clamped(this.homeView());
  }

  /**
   * The initial view: the whole board, or the home box fitted in the area, at HOME_TILE_PX per
   * tile at least (the box's middle, then, as the viewer's zoom is clamped), never further out
   * than the whole board, and never so far out that the board leaves a band of the area empty
   * beside it: at least the zoom at which the board spans the area
   * both ways, the board then kept over the area (set).
   */
  homeView(): View {
    if (this.opening) return fitOpeningView(this.opening, this.area);
    if (this.stableHome) return fitFoundingView(this.stableHome, this.area);
    if (this.home === null) return { ...this.fit };
    const h = this.home;
    const a = this.area;
    const cover = Math.max((a.x1 - a.x0) / this.mapW, (a.y1 - a.y0) / this.mapH);
    // Never so near that the box to keep (both queens' nests) leaves the area: that outranks the ant-size floor and the cover.
    const keep = this.keep === null ? Infinity : fitView(this.keep, this.area).tilePx;
    const tilePx = Math.min(this.fit.tilePx * MAX_ZOOM, keep, Math.max(fitView(h, this.area).tilePx, HOME_TILE_PX / this.physicalScale, this.fit.tilePx, cover));
    return { tilePx, ox: (a.x0 + a.x1) / 2 - ((h.x0 + h.x1) / 2) * tilePx, oy: (a.y0 + a.y1) / 2 - ((h.y0 + h.y1) / 2) * tilePx };
  }

  /**
   * The fall window's view: the fallen colony's
   * nests (b, in tiles) brought to the middle of the area, near enough that they span FALL_FILL of it and at least
   * FALL_ZOOM times the initial view's zoom — a decisive step in, never the box fitted — the board stopping at the
   * area's edge near its own (clamped), within the viewer's zoom limits. Never nearer than the box fitted, though
   *: where the step in would cut the nests — a colony of several, far apart — the floor gives way
   * and the box is fitted, so every fallen queen stays whole in the area with her zone and FALL_FRAME_PAD tiles of
   * ground around her (buffer.ts fallenNests) as the margin; out to the whole board where the box is larger.
   */
  fallView(b: Box, queens?: Box): View {
    const a = this.area;
    const fitted = fitView(b, a).tilePx;
    const step = Math.max(this.fit.tilePx, this.homeView().tilePx * FALL_ZOOM, (fitted * FALL_FILL) / 0.98);
    // Never out past the zoom at which the board covers the area,
    // unless a fallen queen herself (queens: buffer.ts fallenQueenBox) would leave it. Only the zones and FALL_FRAME_PAD
    // are trimmed, and only at the area's top and bottom: the nests' box still fits across. Herself, down the area, is
    // her tile and her emblem (the stage filled): her ground margin
    // (QUEEN_FRAME_TILES) gives way there too, which a column of nests down the board's height needs (fallRows).
    const aw = a.x1 - a.x0, ah = a.y1 - a.y0;
    const floor = queens ? Math.min(Math.max(aw / this.mapW, ah / this.mapH), aw / (b.x1 - b.x0), fallRows(queens, ah)) : 0;
    const tilePx = Math.min(this.fit.tilePx * MAX_ZOOM, Math.max(Math.min(fitted, step), floor));
    return this.clamped({ tilePx, ox: (a.x0 + a.x1) / 2 - ((b.x0 + b.x1) / 2) * tilePx, oy: (a.y0 + a.y1) / 2 - ((b.y0 + b.y1) / 2) * tilePx });
  }

  /** The screen changed size (rotation or window resize): fit the board to the new area and show the initial view again. */
  resize(screenW: number, screenH: number, area?: Area): void {
    this.screenW = screenW;
    this.screenH = screenH;
    this.area = area ?? { x0: 0, y0: 0, x1: screenW, y1: screenH };
    this.fit = fitView({ x0: 0, y0: 0, x1: this.mapW, y1: this.mapH }, this.area);
    this.set(this.homeView());
  }

  /**
   * The board's area changed while the screen did not (a panel opened or closed beside the board): the whole-board
   * fit follows the new area, and the view is kept over it. The initial view is fitted again (the page fits the board
   * as its panels change); the whole board stays whole; a view the viewer moved stays
   * where it is (a kept area would leave the board beneath a newly opened rail).
   */
  setArea(area: Area): void {
    const home = this.atHome();
    const whole = this.view.tilePx <= this.minimumView().tilePx + 1e-9;
    this.area = area;
    this.fit = fitView({ x0: 0, y0: 0, x1: this.mapW, y1: this.mapH }, area);
    this.set(home ? this.homeView() : whole ? { ...this.minimumView() } : this.view);
  }

  /** Whether the view is still the initial one, nothing the viewer did having moved it: the page then fits the board again as its panels change. */
  atHome(): boolean {
    const h = this.clamped(this.homeView());
    const v = this.view;
    return Math.abs(v.tilePx - h.tilePx) < 0.01 && Math.abs(v.ox - h.ox) < 0.5 && Math.abs(v.oy - h.oy) < 0.5;
  }

  onChange(fn: (v: View) => void): void {
    this.listeners.push(fn);
  }

  get zoom(): number {
    return this.view.tilePx / this.fit.tilePx;
  }

  toScreen = (tx: number, ty: number): [number, number] => [this.view.ox + tx * this.view.tilePx, this.view.oy + ty * this.view.tilePx];

  toTile = (sx: number, sy: number): [number, number] => [(sx - this.view.ox) / this.view.tilePx, (sy - this.view.oy) / this.view.tilePx];

  /** The opening view and the opt-in founding envelope may fit farther out than the legacy map-fit floor. */
  private minimumView(): View {
    if (this.opening) {
      const opening = fitOpeningView(this.opening, this.area);
      return opening.tilePx < this.fit.tilePx ? opening : this.fit;
    }
    if (this.stableHome) {
      const founding = fitFoundingView(this.stableHome, this.area);
      if (founding.tilePx < this.fit.tilePx) return founding;
    }
    return this.fit;
  }

  /** Zoom by factor about screen point (sx, sy), from the applicable minimum to MAX_ZOOM. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const minimum = this.minimumView();
    const z = Math.min(MAX_ZOOM, Math.max(minimum.tilePx / this.fit.tilePx, this.zoom * factor));
    const [tx, ty] = this.toTile(sx, sy);
    const tilePx = Math.max(minimum.tilePx, this.fit.tilePx * z);
    // Zoomed fully out during opening is the complete opening view, as it is otherwise the whole board.
    if (this.opening && minimum !== this.fit && tilePx <= minimum.tilePx) return this.set({ ...minimum });
    this.set({ tilePx, ox: sx - tx * tilePx, oy: sy - ty * tilePx });
  }

  panBy(dx: number, dy: number): void {
    this.set({ ...this.view, ox: this.view.ox + dx, oy: this.view.oy + dy });
  }

  /**
   * Centre a board point (in tiles) in the board's area, so no panel covers it: a mark chosen in
   * the log, at the current zoom, or Show on board, at zoom, a multiple of the whole
   * board. Near the board's edge the board stops at the area's edge (set), so the point
   * stays in the area, off-centre. At the whole-board view with no zoom given, every point is
   * already in the area and the view stays the fit.
   */
  centreOn(tx: number, ty: number, zoom?: number): void {
    const a = this.area;
    const tilePx = zoom === undefined ? this.view.tilePx : this.fit.tilePx * Math.min(MAX_ZOOM, Math.max(1, zoom));
    this.set({ tilePx, ox: (a.x0 + a.x1) / 2 - tx * tilePx, oy: (a.y0 + a.y1) / 2 - ty * tilePx });
  }

  /** Return to the default view: the opted-in 2D home (founding envelope, or the opening view while shown), else the map fit. */
  reset(): void {
    this.set(this.stableHome ? this.homeView() : { ...this.fit });
  }

  /** The page's zoom buttons: zoom by factor about the centre of the board's area. */
  zoomBy(factor: number): void {
    const a = this.area;
    this.zoomAt(factor, (a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2);
  }

  /**
   * Apply a view. Zoomed in, the board is kept covering its area where it is
   * larger than the area, and inside it where it is smaller, so it can never
   * leave its area and a point near any edge of the board can be brought into
   * the area, clear of the page's panels; zoomed out it is the whole
   * board.
   */
  set(v: View): void {
    this.view = this.clamped(v);
    for (const fn of this.listeners) fn(this.view);
  }

  private clamped(v: View): View {
    // Canonical opening/default views keep their designed edge border.
    // Other views use the normal map-edge clamp and the applicable zoom floor.
    if (this.opening || this.stableHome) {
      const opening = this.opening ? fitOpeningView(this.opening, this.area) : fitFoundingView(this.stableHome!, this.area);
      // Public zoom/pan can reconstruct Home a few floating-point steps away.
      // Canonicalize only that complete view; otherwise rounding can trigger an
      // edge clamp and move the designed opening by visible pixels.
      const same = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) &&
        Math.abs(a - b) <= OPENING_VIEW_RELATIVE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
      if (same(v.tilePx, opening.tilePx) && same(v.ox, opening.ox) && same(v.oy, opening.oy)) return opening;
    }
    const w = this.mapW * v.tilePx;
    const h = this.mapH * v.tilePx;
    const a = this.area;
    const clamp = (o: number, size: number, lo: number, hi: number) => (size <= hi - lo ? Math.min(Math.max(o, lo), hi - size) : Math.min(Math.max(o, hi - size), lo));
    const minimum = this.minimumView();
    // A drag at the founding floor must keep its scale and use the edge clamp,
    // not jump inward to fit. Non-opted-in callers retain their old fit snap.
    const zoomedOut = v.tilePx < minimum.tilePx || (minimum === this.fit && v.tilePx <= this.fit.tilePx + 1e-9);
    return zoomedOut ? { ...minimum } : { tilePx: v.tilePx, ox: clamp(v.ox, w, a.x0, a.x1), oy: clamp(v.oy, h, a.y0, a.y1) };
  }

  /**
   * Wire wheel, drag, two-finger pinch and double-click on the element; returns whether the last pointer press
   * moved (a drag or a pinch, not a click). A pinch zooms about the
   * fingers' midpoint by the change in their distance and pans by the midpoint's move; the zoom buttons stay.
   */
  attach(el: HTMLElement): { dragged(): boolean } {
    keepPinch(el);
    let drag: { x: number; y: number; moved: number } | null = null;
    /** The pointers down on the element, by id: where they are in the element's own coordinates, and on the screen. */
    const pointers = new Map<number, { x: number; y: number; cx: number; cy: number }>();
    let pinch: { dist: number; mx: number; my: number } | null = null;
    let lastMoved = 0;
    const pinchNow = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(b!.x - a!.x, b!.y - a!.y), mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
    };
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    el.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, cx: e.clientX, cy: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        pinch = pinchNow();
        // A second finger makes it a pinch, never a click.
        if (drag) drag.moved += 4;
      } else if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    el.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (p) {
        p.x = e.offsetX;
        p.y = e.offsetY;
        p.cx = e.clientX;
        p.cy = e.clientY;
      }
      if (pinch && pointers.size >= 2) {
        // Zoom about where the midpoint was, which keeps the ground under it, then carry that ground to where the midpoint is.
        const now = pinchNow();
        if (pinch.dist > 0) this.zoomAt(now.dist / pinch.dist, pinch.mx, pinch.my);
        this.panBy(now.mx - pinch.mx, now.my - pinch.my);
        pinch = now;
        if (drag) drag.moved += 4;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.moved > 3) this.panBy(dx, dy);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size > 0) {
        // The finger still down drags on from where it is, without a jump.
        const [rest] = pointers.values() as Iterable<{ cx: number; cy: number }>;
        if (drag && rest) {
          drag.x = rest.cx;
          drag.y = rest.cy;
        }
        return;
      }
      lastMoved = drag?.moved ?? 0;
      drag = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", () => this.reset());
    return { dragged: () => lastMoved > 3 };
  }
}
