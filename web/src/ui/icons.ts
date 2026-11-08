// The HUD's icons, drawn here as SVG: no image generation, no symbol font. Outline
// strokes on one 24-unit grid. An agent's badge and a mark's symbol stay filled, exactly as the
// board draws them (squads.ts badge plate, mark-symbols.ts), so a reader matches the panel to the board at a glance;
// an order reuses its verb's shape in outline, so a filled shape is a mark on the board and an outline is an order.
import { domIcon } from "../icons/dom.ts";
import { glyphIconKey } from "../icons/set.ts";
import type { OrderKind } from "../../../src/live/format.ts";
import { glyphPolygon } from "../compose.ts";
import { markSymbol, markSymbolPolygon } from "../mark-symbols.ts";
import { BADGE_CORNER } from "../squads.ts";
import type { CountVerb } from "../../../src/sim/types.ts";

const svg = (body: string, size: number, fill = "none") =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const points = (pts: readonly number[], scale: number, cx = 12, cy = 12) => {
  const out: string[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(`${(pts[i]! * scale + cx).toFixed(2)},${(pts[i + 1]! * scale + cy).toFixed(2)}`);
  return out.join(" ");
};

/** Fixed controls and states. */
export const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>', 18),
  minus: svg('<path d="M5 12h14"/>', 18),
  /** The whole board: a frame's corners round its centre. */
  get overview() { return domIcon("whole", svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="2.5"/>', 18)); },
  get close() { return domIcon("close", svg('<path d="M6 6l12 12M18 6 6 18"/>', 16)); },
  get chevron() { return domIcon("chevron", svg('<path d="m6 9 6 6 6-6"/>', 12)); },
  get info() { return domIcon("info", svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.4"/>', 16)); },
  /** An agent that has gone quiet: two small z's. */
  get idle() { return domIcon("idle", svg('<path d="M4 10h6l-6 8h6M13 4h7l-7 8h7"/>', 14)); },
} as const;

/** The board's squad badge: the agent's glyph on a dark square plate edged in its shade (squads.ts updateBadges). */
export function badge(agent: number, shade: string, size = 16): string {
  return domIcon(glyphIconKey(agent), `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false"><rect x="1" y="1" width="18" height="18" rx="${BADGE_CORNER}" fill="#0b0907" fill-opacity="0.9" stroke="${shade}" stroke-width="2"/><polygon points="${points(glyphPolygon(agent, 5.6), 1, 10, 10)}" fill="${shade}"/></svg>`, shade, { x: 4.4, y: 4.4, w: 11.2, h: 11.2, keep: 1 });
}

/** A count mark's verb symbol, filled in the laying agent's shade as on the board; a word mark (no verb) is its ring. */
export function markIcon(verb: string | undefined, shade: string, size = 14): string {
  const kind = markSymbol(verb);
  if (kind === null) return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7.5" fill="none" stroke="${shade}" stroke-width="3"/></svg>`;
  return domIcon(`mark-${kind}`, `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><polygon points="${points(markSymbolPolygon(kind, 1), 9.5)}" fill="${shade}"/></svg>`, shade);
}

const outlined = (verb: CountVerb, size: number) => svg(`<polygon points="${points(markSymbolPolygon(verb, 1), 8.5)}"/>`, size);

/** An agent's standing order, as an outline: its verb's shape where a mark shares it, else its own. */
export function orderIcon(order: OrderKind, guard: boolean, size = 14): string {
  if (guard) return domIcon("order-guard", svg('<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3Z"/>', size), "currentColor");
  switch (order) {
    case "attack": return domIcon(`order-${order}`, outlined("ATTACK", size), "currentColor");
    case "forage": return domIcon(`order-${order}`, outlined("FORAGE", size), "currentColor");
    case "hold": return domIcon(`order-${order}`, outlined("DEFEND", size), "currentColor");
    case "follow_trail": return domIcon(`order-${order}`, svg('<path d="M4 19c4 0 5-4 7-7s3-6 7-6" stroke-dasharray="2.5 3"/><path d="m16 3 4 3-4 3"/>', size), "currentColor");
    case "go_to": return domIcon(`order-${order}`, svg('<path d="M4 12h15M13 6l6 6-6 6"/>', size), "currentColor");
  }
}

/** A queen, the target an order names, in its colony's colour. */
export function crownIcon(colour: string, size = 14): string {
  return domIcon("crown", `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 18h16l1.5-11-5.5 4.5L12 5l-4 6.5L2.5 7 4 18Z"/></svg>`, colour);
}
