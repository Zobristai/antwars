/**
 * A colony's point of view on the board: what that colony's agents see, rebuilt on the client from the
 * stream's own ants, exactly as the sim builds an agent's view (src/sim/view.ts createVisibility). Sight is
 * the union of discs of SIGHT_TILES around every living colony ant's tile, smell the same at SMELL_TILES, both times the
 * recorded grid scale (one when a recording carries none). The stream rounds positions to SUB_TILE, so an ant within
 * a hair of a tile boundary can land on its neighbour: the masks match the sim's to that rounding, not beyond it.
 *
 * Only the board is filtered: the HUD and its panels read the unfiltered frame. Full view passes the frame through.
 */
import { SUB_TILE, streamQueens, type StreamAnts, type StreamMark } from "../../src/live/format.ts";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import { Frame, type Board, type Colony } from "./buffer.ts";
import { gridScale } from "./grid-scale.ts";

/** The sim's agent sight and smell radii in original tiles (DEFAULT_CONFIG, unchanged since the first simulator). */
export const SIGHT_TILES = 6;
export const SMELL_TILES = 8;

export type TeamChoice = "full" | Colony;

/** Unseen ground lies under the page background (#121719) at this opacity, on both boards. */
export const FOG_RGB = [0x12, 0x17, 0x19] as const;
export const FOG_ALPHA = 0.62;

/** Tiles within radius of any ant of the colony: createVisibility's range, from stream ants. */
export function rangeMask(ants: Pick<StreamAnts, "count" | "x" | "y" | "colony">, mapW: number, mapH: number, colony: Colony, radius: number): Uint8Array {
  const seen = new Uint8Array(mapW * mapH);
  const origins = new Set<number>();
  for (let i = 0; i < ants.count; i++) {
    if (ants.colony[i] !== colony) continue;
    const tx = Math.floor(ants.x[i]! / SUB_TILE), ty = Math.floor(ants.y[i]! / SUB_TILE);
    if (tx >= 0 && ty >= 0 && tx < mapW && ty < mapH) origins.add(ty * mapW + tx);
  }
  for (const origin of origins) {
    const ax = origin % mapW, ay = Math.floor(origin / mapW);
    for (let y = Math.max(0, ay - radius); y <= Math.min(mapH - 1, ay + radius); y++) {
      const dx = Math.floor(Math.sqrt(radius * radius - (y - ay) ** 2));
      seen.fill(1, y * mapW + Math.max(0, ax - dx), y * mapW + Math.min(mapW - 1, ax + dx) + 1);
    }
  }
  return seen;
}

/** Sight and smell of one colony at one tick. */
export interface TeamMasks {
  readonly sight: Uint8Array;
  readonly smell: Uint8Array;
}

export function teamMasks(ants: StreamAnts, board: Pick<Board, "setup">, colony: Colony): TeamMasks {
  const { mapW, mapH } = board.setup, scale = gridScale(board.setup);
  return { sight: rangeMask(ants, mapW, mapH, colony, SIGHT_TILES * scale), smell: rangeMask(ants, mapW, mapH, colony, SMELL_TILES * scale) };
}

const tileOf = (mask: Uint8Array, mapW: number, mapH: number, x: number, y: number): number => {
  const tx = Math.min(mapW - 1, Math.max(0, Math.floor(x))), ty = Math.min(mapH - 1, Math.max(0, Math.floor(y)));
  return mask[ty * mapW + tx]!;
};

/** The board as one colony knows it: own territory, own marks within smell, food in sight, queens it can see. */
export function teamBoard(board: Board, colony: Colony, masks: TeamMasks): Board {
  const { mapW, mapH } = board.setup;
  const food = board.food.slice();
  for (let i = 0; i < food.length; i++) if (masks.sight[i] === 0) food[i] = 0;
  const ownMark = (m: StreamMark) => m.colony === colony && masks.smell[m.tileY * mapW + m.tileX] === 1;
  return {
    ...board,
    territory: ownTerritory(board.territory, colony),
    food,
    marks: board.marks.filter(ownMark),
    queens: streamQueens(board).filter(q => q.colony === colony || tileOf(masks.sight, mapW, mapH, q.x / SUB_TILE, q.y / SUB_TILE) === 1),
  };
}

/** Owner grid with only this colony's tiles (0 neutral, 1 colony 0, 2 colony 1). */
export function ownTerritory(owners: Uint8Array, colony: Colony): Uint8Array {
  const out = new Uint8Array(owners.length), own = colony + 1;
  for (let i = 0; i < owners.length; i++) if (owners[i] === own) out[i] = own;
  return out;
}

/** Traffic trails (two channels per cell, colony 0 then 1) with only this colony's. */
export function ownTrails(trails: Float32Array, colony: Colony): Float32Array {
  const out = new Float32Array(trails.length);
  for (let i = colony; i < trails.length; i += 2) out[i] = trails[i]!;
  return out;
}

/**
 * The spectator's point-of-view choice and the board frame it gives. The choice lives here, outside Playback, so it
 * holds while playback continues, seeks or restarts. Derived arrays are cached by their source so the renderers,
 * which re-upload only when an array's identity changes, do no extra work between ticks.
 */
export class TeamView {
  private current: TeamChoice = "full";
  private readonly out = new Frame();
  private masksFor: { ants: StreamAnts; colony: Colony; masks: TeamMasks } | null = null;
  private boardFor: { source: Board; masks: TeamMasks; board: Board } | null = null;
  private territories = new WeakMap<Uint8Array, Uint8Array>();
  private trails = new WeakMap<Float32Array, Float32Array>();

  get choice(): TeamChoice {
    return this.current;
  }

  set choice(choice: TeamChoice) {
    if (choice === this.current) return;
    this.current = choice;
    this.masksFor = this.boardFor = null;
    this.territories = new WeakMap();
    this.trails = new WeakMap();
  }

  /** The frame the board draws: the playback frame itself in Full view, else one colony's view of it. */
  apply(frame: Frame): Frame {
    const colony = this.current;
    if (colony === "full" || frame.board === null || frame.ants === null) {
      frame.fog = null;
      return frame;
    }
    const board = frame.board, ants = frame.ants;
    if (this.masksFor?.ants !== ants || this.masksFor.colony !== colony) this.masksFor = { ants, colony, masks: teamMasks(ants, board, colony) };
    const masks = this.masksFor.masks;
    if (this.boardFor?.source !== board || this.boardFor.masks !== masks) this.boardFor = { source: board, masks, board: teamBoard(board, colony, masks) };
    const { mapW, mapH } = board.setup;
    const seen = (x: number, y: number) => tileOf(masks.sight, mapW, mapH, x, y) === 1;
    const out = this.out;
    out.renderMs = frame.renderMs;
    out.targetMs = frame.targetMs;
    out.tick = frame.tick;
    out.blend = frame.blend;
    out.mapW = frame.mapW;
    out.mapH = frame.mapH;
    out.territoryA = this.territory(frame.territoryA, colony);
    out.territoryB = this.territory(frame.territoryB, colony);
    let trails = this.trails.get(frame.trails);
    if (trails === undefined) this.trails.set(frame.trails, trails = ownTrails(frame.trails, colony));
    out.trails = trails;
    out.board = this.boardFor.board;
    out.ants = ants;
    out.fog = masks.sight;
    out.engagements = frame.engagements;
    out.lossShown = frame.lossShown;
    out.endShown = frame.endShown;
    out.match = frame.match;
    out.hits = frame.hits;
    out.chat = frame.chat;

    // Own ants always (each stands in its own sight); enemy ants only on a tile in sight at this tick.
    out.ensure(frame.count);
    const rotations = frame.drawRotation, xs = frame.drawX, ys = frame.drawY;
    if (rotations && (!out.drawRotation || out.drawRotation.length < out.id.length)) out.drawRotation = new Float64Array(out.id.length);
    if (xs && (!out.drawX || out.drawX.length < out.id.length)) out.drawX = new Float64Array(out.id.length);
    if (ys && (!out.drawY || out.drawY.length < out.id.length)) out.drawY = new Float64Array(out.id.length);
    let n = 0;
    for (let i = 0; i < frame.count; i++) {
      if (ants.colony[i] !== colony && masks.sight[Math.floor(ants.y[i]! / SUB_TILE) * mapW + Math.floor(ants.x[i]! / SUB_TILE)] !== 1) continue;
      out.id[n] = frame.id[i]!;
      out.x[n] = frame.x[i]!;
      out.y[n] = frame.y[i]!;
      out.rotation[n] = frame.rotation[i]!;
      out.alpha[n] = frame.alpha[i]!;
      out.colony[n] = frame.colony[i]!;
      out.agent[n] = frame.agent[i]!;
      out.walk[n] = frame.walk[i]!;
      out.caste[n] = frame.caste[i]!;
      out.carrying[n] = frame.carrying[i]!;
      if (rotations) out.drawRotation![n] = rotations[i]!;
      if (xs) out.drawX![n] = xs[i]!;
      if (ys) out.drawY![n] = ys[i]!;
      n++;
    }
    out.count = n;
    if (!rotations) out.drawRotation = null;
    if (!xs) out.drawX = null;
    if (!ys) out.drawY = null;

    // Effects only where the colony sees; its own queens' foundings and losses wherever they are.
    out.corpses = frame.corpses.filter(c => c.colony === colony || seen(c.x, c.y));
    out.fights = frame.fights.filter(f => seen(f.x, f.y));
    out.marks = frame.marks.filter(m => m.mark.colony === colony && masks.smell[m.mark.tileY * mapW + m.mark.tileX] === 1);
    const ownQueenEvent = (kind: string, c: Colony) => c === colony && (kind === "queen_founded" || kind === "queen_lost");
    out.story = frame.story.filter(e => ownQueenEvent(e.kind, e.colony) || seen(e.x, e.y));
    return out;
  }

  private territory(owners: Uint8Array, colony: Colony): Uint8Array {
    let own = this.territories.get(owners);
    if (own === undefined) this.territories.set(owners, own = ownTerritory(owners, colony));
    return own;
  }
}

/** Spectator copy for each choice: the whole board, or one colony's point of view. */
export const TEAM_VIEW_COPY = {
  label: "Point of view",
  full: "Full view",
  colony: (colony: Colony) => `${COLONY_NAMES[colony]}'s view`,
} as const;

/**
 * The one control: Full view (the default), then each colony's view. The HUDs borrow it into their board controls by
 * its class, as they borrow the replay transport.
 */
export function teamViewControl(doc: Document, view: TeamView): HTMLSelectElement {
  const select = doc.createElement("select");
  select.className = "aw-team-view";
  select.setAttribute("aria-label", TEAM_VIEW_COPY.label);
  select.title = TEAM_VIEW_COPY.label;
  const option = (value: string, text: string) => {
    const o = doc.createElement("option");
    o.value = value;
    o.textContent = text;
    select.append(o);
  };
  option("full", TEAM_VIEW_COPY.full);
  option("0", TEAM_VIEW_COPY.colony(0));
  option("1", TEAM_VIEW_COPY.colony(1));
  select.value = view.choice === "full" ? "full" : String(view.choice);
  select.addEventListener("change", () => {
    view.choice = select.value === "full" ? "full" : (Number(select.value) as Colony);
  });
  // A select keeps matching :focus-visible after a click or tap, where the round board controls beside it do not; the
  // HUDs drop its focus ring while it is marked as pointer-focused. A key or leaving it brings the ring back.
  select.addEventListener("pointerdown", () => select.setAttribute("data-pointer", ""));
  const keyboard = () => select.removeAttribute("data-pointer");
  select.addEventListener("keydown", keyboard);
  select.addEventListener("blur", keyboard);
  return select;
}
