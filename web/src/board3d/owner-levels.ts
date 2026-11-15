/**
 * How the 3D ground's territory textures (ground.ts) tell owners apart, shared with a board look's ground code
 * (board-look.ts) and free of Babylon, so the 2D HUD's look can read it too.
 */

/**
 * Each colony's level in the territory textures' red channel, index = colony id. Colonies 0 and 1 keep the levels the 2D
 * encoding gives them (territory.ts); colonies 2 and 3, only in a four-colony match, sit halfway between those and a
 * neutral tile's NEUTRAL_LEVEL. The ground samples tile centres, so a level is never blended with another.
 */
export const COLONY_LEVEL = [255, 0, 64, 192] as const;
export const NEUTRAL_LEVEL = 128;

/**
 * GLSL statements for a function of a territory sample `s`: return `c2` or `c3` on a tile of colony 2 or 3 (its level
 * within half a level step). A four-colony ground runs them ahead of its two-colony choice of colony 0 or 1.
 */
export function laterColonies(c2: string, c3: string): string {
  return `  float awLevel = s.r * 255.0;
  if (abs(awLevel - ${COLONY_LEVEL[2].toFixed(1)}) < 32.0) return ${c2};
  if (abs(awLevel - ${COLONY_LEVEL[3].toFixed(1)}) < 32.0) return ${c3};
`;
}
