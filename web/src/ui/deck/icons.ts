// The Instrument deck: the few marks the deck draws itself, as inline SVG in the current ink.
// The badge, mark, order and crown icons are today's (ui/icons.ts); these add the board's whole-board corners, the two
// castes and the rings, drawn as Current's HUD draws them (ui/hud.ts ICONS, not exported there).

const svg = (body: string, size: number, box = 24, width = 2) =>
  `<svg viewBox="0 0 ${box} ${box}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/**
 * The two castes' line icons as SVG path data in a 24-unit box, stroked with round caps and joins (ui/hud.ts
 * ICONS.worker and ICONS.soldier): drawn here as markup for the next spawn's ring, and in Pixi by the board's
 * count-mark labels (words.ts), so both read the same icon.
 */
export const CASTE_ICON_PATH = {
  worker: "M5 21 16 8M6 5c6-4 11-1 14 5L13 7 6 5Z",
  soldier: "m3 3 8 5-3 3-5-8Zm18 0-8 5 3 3 5-8ZM8 11l11 11M16 11 5 22M15 17l6 1M9 17l-6 1",
} as const;

export const D1_ICON = {
  /** The whole board: a frame's four corners (ui/hud.ts ICONS.whole). */
  get whole() { return domIcon("whole", svg('<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>', 16, 20, 1.8)); },
  get close() { return domIcon("close", svg('<path d="M6 6l12 12M18 6 6 18"/>', 16)); },
  /** The next ant's caste (ui/hud.ts ICONS.worker and ICONS.soldier), small enough to sit inside the next spawn's ring. */
  get worker() { return domIcon("worker", svg(`<path d="${CASTE_ICON_PATH.worker}"/>`, 11, 24, 2.6)); },
  get soldier() { return domIcon("soldier", svg(`<path d="${CASTE_ICON_PATH.soldier}"/>`, 11, 24, 2.6)); },
} as const;

/** A ring that fills clockwise from twelve o'clock with its colony's colour; the fill is set on its second circle. */
export const RING =
  '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false"><circle class="d1-ring-track" cx="9" cy="9" r="7"/><circle class="d1-ring-fill" cx="9" cy="9" r="7" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 9 9)"/></svg>';

import { domIcon } from "../../icons/dom.ts";
