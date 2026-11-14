/**
 * Squads on the board ('Look'):
 * - every agent shows its colony's one colour (agentShade), used for its squad's ants, marks, badge, order target and
 *   roster swatch; agents within a colony are told apart by their glyph and their name;
 * - each squad carries one small badge: the agent's glyph (compose.ts) in its
 *   colony's colour, the same glyph its roster swatch shows, on a dark square plate (unlike the round mark pings) just beside
 *   the squad ant nearest the squad's mean position. The marks' layout places the
 *   badges (words.ts placeBadges) after the markers, clear of them where a spot
 *   is free. A badge is never dropped;
 * - the agent's handle and model label show as a tooltip beside the badge only while the
 *   pointer is on the badge or the squad's ants, after the badge or one of its
 *   ants is tapped, or while its roster row is hovered: never as a permanent
 *   plate, and never for the selected agent, whose card names it. A tooltip sits above everything with no leader,
 *   in the page's own type (tipContent; web/src/tip.ts draws it). Intents are not drawn on the board: they are lines in the
 *   chat;
 * - squad ants and free ants alike carry the colony colour; the selected squad (hovered in the roster, else pointed at or tapped on the board) has each of
 *   its ants ringed in an outline, and every other ant dimmed.
 */
import { IconSprites } from "./icons/sprites.ts";
import { iconMasks } from "./icons/textures.ts";
import { glyphIconKey } from "./icons/set.ts";
import { Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, type Renderer } from "pixi.js";
import type { StreamAgent } from "../../src/live/format.ts";
import type { Frame } from "./buffer.ts";
import type { Rect, TipContent } from "./words.ts";
import { modelLine, playerLabel, badgeAnchors, badgeRadiusPx, glyphPolygon } from "./compose.ts";
import { colonyTint } from "./colony-palette.ts";

/**
 * An agent's colour: its colony's one colour (colony-palette.ts, from the colony's name in src/sim/colonyNames.ts), the
 * same for every agent of the colony in every match. Agents within a colony are told apart by their glyph and name.
 */
export function agentShade(colony: number, _agent: number, _agents: readonly Pick<StreamAgent, "colony">[]): number {
  return colonyTint(colony);
}

/** Every agent's colour by agent index: what the boards tint squad ants with. */
export function agentHues(agents: readonly Pick<StreamAgent, "colony">[]): number[] {
  return agents.map((a, i) => agentShade(a.colony, i, agents));
}

export function cssColour(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

/** Order in which badges claim their spots: larger squads, then lower agent index. */
export function rankKey(a: number, an: number, b: number, bn: number): number {
  return bn - an || a - b;
}

/**
 * What a squad's badge tooltip says: the agent's handle, then the model label
 * the agent reported, when it gave one. No intent.
 */
export function squadTipText(agent: number, a: Pick<StreamAgent, "modelLabel" | "thinkingLevel" | "serviceTier" | "identity">): string {
  const name = playerLabel(agent, a);
  const model = modelLine(a, MODEL_LABEL);
  return model ? `${name}\n${model}` : name;
}

/** How an agent's model is labelled wherever it shows: the card, the roster, the feed, this tooltip. The model itself, with no
 * "self-reported" editorial; the deck marks self-reported models once, on its header. */
export const MODEL_LABEL = "Model";

/** A badge plate's corner radius in CSS px: small, so it reads square, never round, at 390 px. */
export const BADGE_CORNER = 2.5;

/** Highlight shade for a hovered squad's ants. */
export const HOVER_TINT = 0xffffff;

/** Centroid of each squad's ants in tiles, by agent index. */
export function squadCentres(frame: Pick<Frame, "count" | "x" | "y" | "agent">): Map<number, { x: number; y: number; n: number }> {
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let i = 0; i < frame.count; i++) {
    const agent = frame.agent[i]!;
    if (agent < 0) continue;
    const s = sums.get(agent) ?? { x: 0, y: 0, n: 0 };
    s.x += frame.x[i]!;
    s.y += frame.y[i]!;
    s.n++;
    sums.set(agent, s);
  }
  for (const s of sums.values()) {
    s.x /= s.n;
    s.y /= s.n;
  }
  return sums;
}

/** A rect drawn now, with the bounds shape the page's checks read. */
interface Drawn {
  getBounds(): { minX: number; minY: number; maxX: number; maxY: number };
}

export class Squads {
  /** Badges in screen space, above the words' layer. */
  readonly layer = new Container();
  private readonly badgeG = new Graphics();
  private readonly icons = new IconSprites();
  private iconVersion = -1;
  /** The badges last drawn: redrawn when the layout gives others, not every frame. */
  private laidOut: ReadonlyMap<number, Rect> | null = null;
  /** Rings under the hovered squad's ants, in world (tile) space. */
  readonly rings: ParticleContainer;
  private ringPool: Particle[] = [];
  private ringTexture: Texture;
  /** Badge radius in CSS px, for the marks' layout to place the badges. */
  badgeR = 0;
  /** Agent whose squad is highlighted from the roster, or -1. */
  hovered = -1;
  /** Agent whose tooltip shows because the pointer is on its badge or ants, or its badge or one of its ants was tapped; -1 for none. */
  focused = -1;
  /**
   * The selected squad: the one hovered in the roster, else the one pointed at
   * or tapped on the board; -1 for none. Its ants are tinted and ringed, the others dimmed.
   */
  get selected(): number {
    return this.hovered >= 0 ? this.hovered : this.focused;
  }
  /** Each badge drawn at the last layout, by agent. */
  private badges = new Map<number, Rect>();
  /** Badges drawn last frame, and squads on the board. */
  shown = { full: 0, squads: 0 };

  constructor(renderer: Renderer, screenW: number) {
    this.setSizes(screenW);
    this.layer.addChild(this.badgeG, this.icons.layer);
    const g = new Graphics().circle(32, 32, 26).stroke({ width: 7, color: 0xffffff });
    const holder = new Container();
    holder.addChild(g);
    this.ringTexture = renderer.generateTexture({ target: holder, frame: new Rectangle(0, 0, 64, 64), antialias: true });
    this.rings = new ParticleContainer({ dynamicProperties: { position: true, color: true, rotation: false, uvs: false, vertex: true }, texture: this.ringTexture });
  }

  private setSizes(screenW: number): void {
    this.badgeR = badgeRadiusPx(screenW);
  }

  /** The screen changed size (resize or rotation): badges are rebuilt at sizes for the new screen. */
  resize(screenW: number): void {
    this.setSizes(screenW);
    this.laidOut = null;
  }

  /** Rings round the selected squad's ants; size in tiles. */
  updateRings(frame: Frame, ringTiles: number): number {
    const n0 = this.ringPool.length;
    let n = 0;
    const selected = this.selected;
    if (selected >= 0) {
      const agents = frame.board?.agents ?? [];
      const tint = agentShade(agents[selected]?.colony ?? 0, selected, agents);
      for (let i = 0; i < frame.count; i++) {
        if (frame.agent[i] !== selected) continue;
        let p = this.ringPool[n];
        if (!p) {
          p = new Particle({ texture: this.ringTexture, anchorX: 0.5, anchorY: 0.5 });
          this.ringPool.push(p);
        }
        p.x = frame.x[i]!;
        p.y = frame.y[i]!;
        p.scaleX = p.scaleY = ringTiles / 64;
        p.tint = tint;
        p.alpha = 0.95 * frame.alpha[i]!;
        n++;
      }
    }
    if (n !== this.rings.particleChildren.length || n0 !== this.ringPool.length) {
      this.rings.particleChildren.length = 0;
      for (let i = 0; i < n; i++) this.rings.particleChildren.push(this.ringPool[i]!);
    }
    this.rings.update();
    return n;
  }

  /** Each agent's badge anchor on screen [agent, x, y], in rank order (larger squads, then agent index). */
  anchors(frame: Frame, toScreen: (tx: number, ty: number) => [number, number]): [number, number, number][] {
    const anchors = badgeAnchors(frame, squadCentres(frame));
    return [...anchors]
      .sort((a, b) => rankKey(a[0], a[1].n, b[0], b[1].n))
      .map(([agent, a]) => {
        const [sx, sy] = toScreen(a.x, a.y);
        return [agent, sx, sy];
      });
  }

  /** Draw each squad's badge at the spot the marks' layout gave it (badges, by agent). */
  updateBadges(frame: Frame, toScreen: (tx: number, ty: number) => [number, number], badges: ReadonlyMap<number, Rect>): void {
    const version = iconMasks().version;
    if (this.laidOut === badges && this.iconVersion === version) return;
    this.iconVersion = version;
    this.laidOut = badges;
    this.badges = new Map(badges);
    this.badgeG.clear();
    this.icons.reset();
    const agents = frame.board?.agents ?? [];
    const order = this.anchors(frame, toScreen).map(([agent]) => agent);
    this.shown = { full: 0, squads: order.length };
    const r = this.badgeR;
    const glyphR = r * 0.62;
    for (const agent of order) {
      const spot = this.badges.get(agent);
      if (!spot) continue;
      const shade = agentShade(agents[agent]?.colony ?? 0, agent, agents);
      const cx = (spot.x0 + spot.x1) / 2;
      const cy = (spot.y0 + spot.y1) / 2;
      // A square plate, unlike the marks' round pings, in the same 2r footprint.
      this.badgeG.roundRect(cx - r, cy - r, 2 * r, 2 * r, BADGE_CORNER).fill({ color: 0x0b0907, alpha: 0.9 }).stroke({ width: 2, color: shade, alpha: 1 });
      const pts = glyphPolygon(agent, glyphR);
      if (!this.icons.draw(glyphIconKey(agent), cx - glyphR, cy - glyphR, 2 * glyphR, 2 * glyphR, shade)) this.badgeG.poly(pts.map((v, i) => v + (i % 2 === 0 ? cx : cy))).fill({ color: shade });
      this.shown.full++;
    }
  }

  /**
   * The squad tooltip (its handle and model label, squadTipText), beside the badge of the squad focused on the
   * board, else of the one hovered in the roster: on demand only, never a permanent plate,
   * and never for the selected agent (`chosen`, -1 for none): its card names it. Null with none; web/src/tip.ts draws it.
   */
  tipContent(frame: Frame, chosen = -1): TipContent | null {
    const agents = frame.board?.agents ?? [];
    for (const agent of [this.focused, this.hovered]) {
      const a = agents[agent];
      const badge = this.badges.get(agent);
      if (agent < 0 || agent === chosen || !a || !badge) continue;
      const [head = "", body = ""] = squadTipText(agent, a).split("\n");
      return { target: badge, colour: agentShade(a.colony, agent, agents), rows: [{ head, body, meta: "" }] };
    }
    return null;
  }

  /** The agent whose badge lies under a screen point (within 4 px), or -1. */
  badgeAt(x: number, y: number): number {
    for (const [agent, b] of this.badges) if (x >= b.x0 - 4 && x <= b.x1 + 4 && y >= b.y0 - 4 && y <= b.y1 + 4) return agent;
    return -1;
  }

  /** Every badge drawn now, for checks of what is on screen. */
  visibleBlocks(): Drawn[] {
    return [...this.badges.values()].map((b) => ({ getBounds: () => ({ minX: b.x0, minY: b.y0, maxX: b.x1, maxY: b.y1 }) }));
  }

  /** Each agent with ants has a badge drawn now. */
  badgeAgents(): number[] {
    return [...this.badges.keys()];
  }
}
