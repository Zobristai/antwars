/** Physical sizes belong to the recording, never to its map dimensions.
 * Every playable stream carries grid scale 2; the decoder refuses any other setup. */
export interface GridScaleSetup {
  gridScale?: 2;
}

/** Number of simulation tiles along one original physical tile: always 2. */
export function gridScale<T extends object>(_setup: T & GridScaleSetup): 2 {
  return 2;
}

/** Pixels per original physical tile. Use for glyph sizing before pixel clamps.
 * Positions and terrain lookups must continue using the unscaled tilePx. */
export function physicalTilePx<T extends object>(tilePx: number, setup: T & GridScaleSetup): number {
  return tilePx * gridScale(setup);
}
