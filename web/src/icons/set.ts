// The watch view's icons: the "Field Stencil" set (ported).
// Each semantic key has two white-on-transparent masks, area-averaged at twice its largest 1x draw size:
// fill/ is the whole footprint, drawn in the icon's runtime colour, and second/ is its darker part, painted solid at
// 70% of that colour above the fill. Both are recoloured at runtime; board draws add the dark outline.
import { agentGlyph } from "../compose.ts";
export const iconKeys = ["close", "zoom-out", "zoom-in", "whole", "chevron", "info", "idle", "flag", "worker", "soldier",
  "order-attack", "order-forage", "order-hold", "order-follow_trail", "order-go_to", "order-guard", "crown",
  "mark-DEFEND", "mark-FORAGE", "mark-ATTACK", "mark-GATHER", "mark-LINE",
  "glyph-diamond", "glyph-triangle", "glyph-square", "glyph-circle", "glyph-star", "glyph-hexagon", "glyph-chevron", "glyph-cross"] as const;
export type IconKey = typeof iconKeys[number];
/** White-on-transparent raster masks, resolved by Vite (new URL(..., import.meta.url)).
 * The optional second mask overlays the fill in a solid 70% shade of its runtime colour. */
export interface IconMask { readonly src: string; readonly second?: { readonly src: string } }
/** A missing or failed mask falls back, per icon, to the vector drawn until it arrives. */
export type IconSet = Readonly<Partial<Record<IconKey, IconMask>>>;
export function glyphIconKey(agent: number): IconKey { return `glyph-${agentGlyph(agent)}`; }

const mask = (fill: URL, second: URL): IconMask => ({ src: fill.href, second: { src: second.href } });

export const iconSet: IconSet = {
  close: mask(new URL("./fill/close.png", import.meta.url), new URL("./second/close.png", import.meta.url)),
  "zoom-out": mask(new URL("./fill/zoom-out.png", import.meta.url), new URL("./second/zoom-out.png", import.meta.url)),
  "zoom-in": mask(new URL("./fill/zoom-in.png", import.meta.url), new URL("./second/zoom-in.png", import.meta.url)),
  whole: mask(new URL("./fill/whole.png", import.meta.url), new URL("./second/whole.png", import.meta.url)),
  chevron: mask(new URL("./fill/chevron.png", import.meta.url), new URL("./second/chevron.png", import.meta.url)),
  info: mask(new URL("./fill/info.png", import.meta.url), new URL("./second/info.png", import.meta.url)),
  idle: mask(new URL("./fill/idle.png", import.meta.url), new URL("./second/idle.png", import.meta.url)),
  flag: mask(new URL("./fill/flag.png", import.meta.url), new URL("./second/flag.png", import.meta.url)),
  worker: mask(new URL("./fill/worker.png", import.meta.url), new URL("./second/worker.png", import.meta.url)),
  soldier: mask(new URL("./fill/soldier.png", import.meta.url), new URL("./second/soldier.png", import.meta.url)),
  "order-attack": mask(new URL("./fill/order-attack.png", import.meta.url), new URL("./second/order-attack.png", import.meta.url)),
  "order-forage": mask(new URL("./fill/order-forage.png", import.meta.url), new URL("./second/order-forage.png", import.meta.url)),
  "order-hold": mask(new URL("./fill/order-hold.png", import.meta.url), new URL("./second/order-hold.png", import.meta.url)),
  "order-follow_trail": mask(new URL("./fill/order-follow_trail.png", import.meta.url), new URL("./second/order-follow_trail.png", import.meta.url)),
  "order-go_to": mask(new URL("./fill/order-go_to.png", import.meta.url), new URL("./second/order-go_to.png", import.meta.url)),
  "order-guard": mask(new URL("./fill/order-guard.png", import.meta.url), new URL("./second/order-guard.png", import.meta.url)),
  crown: mask(new URL("./fill/crown.png", import.meta.url), new URL("./second/crown.png", import.meta.url)),
  "mark-DEFEND": mask(new URL("./fill/mark-DEFEND.png", import.meta.url), new URL("./second/mark-DEFEND.png", import.meta.url)),
  "mark-FORAGE": mask(new URL("./fill/mark-FORAGE.png", import.meta.url), new URL("./second/mark-FORAGE.png", import.meta.url)),
  "mark-ATTACK": mask(new URL("./fill/mark-ATTACK.png", import.meta.url), new URL("./second/mark-ATTACK.png", import.meta.url)),
  "mark-GATHER": mask(new URL("./fill/mark-GATHER.png", import.meta.url), new URL("./second/mark-GATHER.png", import.meta.url)),
  "mark-LINE": mask(new URL("./fill/mark-LINE.png", import.meta.url), new URL("./second/mark-LINE.png", import.meta.url)),
  "glyph-diamond": mask(new URL("./fill/glyph-diamond.png", import.meta.url), new URL("./second/glyph-diamond.png", import.meta.url)),
  "glyph-triangle": mask(new URL("./fill/glyph-triangle.png", import.meta.url), new URL("./second/glyph-triangle.png", import.meta.url)),
  "glyph-square": mask(new URL("./fill/glyph-square.png", import.meta.url), new URL("./second/glyph-square.png", import.meta.url)),
  "glyph-circle": mask(new URL("./fill/glyph-circle.png", import.meta.url), new URL("./second/glyph-circle.png", import.meta.url)),
  "glyph-star": mask(new URL("./fill/glyph-star.png", import.meta.url), new URL("./second/glyph-star.png", import.meta.url)),
  "glyph-hexagon": mask(new URL("./fill/glyph-hexagon.png", import.meta.url), new URL("./second/glyph-hexagon.png", import.meta.url)),
  "glyph-chevron": mask(new URL("./fill/glyph-chevron.png", import.meta.url), new URL("./second/glyph-chevron.png", import.meta.url)),
  "glyph-cross": mask(new URL("./fill/glyph-cross.png", import.meta.url), new URL("./second/glyph-cross.png", import.meta.url)),
};
