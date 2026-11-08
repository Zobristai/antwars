/**
 * The board look the spectator HUD sets while it is mounted (ui/steppe-look.ts). With no look set, both boards draw their plain code path: soil.ts, territory.ts, main.ts and
 * board3d/{ground,rocks,main3d}.ts. A look only colours the ground; water and rocks stay on their exact streamed tiles.
 */

/** An sRGB colour, each channel 0..1. */
export type Rgb = readonly [number, number, number];

export interface BoardLook2d {
  /**
   * The soil bake's fragment (soil.ts bakeSoil). Unlike Current's screen-space soil it is baked in map space:
   * vUV runs over the playable map, uSize is the bake's size in CSS px and uMap the map's size in physical tiles.
   */
  readonly soil: string;
  /** The ground pass's fragment (territory.ts), given the pass's shared prelude; it samples uSoil at vUV. */
  readonly fill: (prelude: string) => string;
  /** The front line's fragment (territory.ts), given the same prelude. */
  readonly front: (prelude: string) => string;
}

export interface BoardLook3d {
  /** The soil's colour at physical tile (x, y), written as board3d/noise.ts soilAt writes it. */
  readonly soil: (x: number, y: number, out: number[]) => void;
  /** The ground plugin's code at each injection point, given Current's code there (board3d/ground.ts). */
  readonly ground: (point: "definitions" | "diffuse" | "beforeFog", current: string) => string;
  /** The boulders' colour; under a look they also cast shadows. */
  readonly rock: Rgb;
  /** The key and fill lights, the shadows' darkness and the image pass's contrast and vignette (board3d/main3d.ts). */
  readonly light: {
    readonly key: Rgb;
    readonly keyIntensity: number;
    readonly fill: Rgb;
    readonly fillGround: Rgb;
    readonly fillIntensity: number;
    readonly shadowDarkness: number;
    readonly contrast: number;
    readonly vignetteWeight: number;
  };
}

export interface BoardLook {
  /** Distinct per look and never 0, which is Current's: the 3D ground shader's define. */
  readonly id: number;
  readonly board2d: BoardLook2d;
  readonly board3d: BoardLook3d;
}

let current: BoardLook | null = null;

/** Set by the HUD when it mounts and cleared (null) when it unmounts; each board applies it on its next frame. */
export function setBoardLook(look: BoardLook | null): void {
  current = look;
}

export function boardLook(): BoardLook | null {
  return current;
}
