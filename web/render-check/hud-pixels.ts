import { createRequire } from "node:module";

export type HudProbe = "hidden" | "unclipped";
export type HudOnScreen = "shown" | "not shown" | "insufficient HUD paint" | "clipped" | "screen not still";
export const HUD_SAMPLE_CYCLES = 3;

export interface HudTriplet { before?: Buffer; altered?: Buffer; after?: Buffer }
export interface HudMeasurement {
  width: number; height: number; pixelLimit: number; stableDifferences: number; variablePixels: number;
  alteredVariablePixels: number; variableTouchingBackground: number; verdict: HudOnScreen;
}

interface Image { width: number; height: number; data: Buffer }
const require = createRequire(import.meta.url);
function decode(png: Buffer): Image {
  // Internal Playwright bundle; load it only when judging a HUD. If the pinned browser tools change, fail
  // this render with a reason rather than silently skipping its comparison (or preventing all surfaces loading).
  try {
    const { PNG } = require("playwright-core/lib/utilsBundle") as { PNG: { sync: { read(bytes: Buffer): Image } } };
    const image = PNG.sync.read(png);
    if (image.width < 1 || image.height < 1 || image.data.length !== 4 * image.width * image.height) {
      throw new Error("incomplete RGBA image");
    }
    return image;
  } catch (cause) { throw new Error(`could not decode replay HUD screenshot with Playwright's PNG decoder: ${String(cause)}`, { cause }); }
}

/** Compare a position only if it is exactly constant in both states. Never count an excluded pixel as HUD paint. */
export function measureHudProbe(kind: HudProbe, samples: readonly HudTriplet[]): HudMeasurement {
  if (samples.length !== HUD_SAMPLE_CYCLES || samples.some(s => !s.before || !s.altered || !s.after)) {
    throw new Error(`replay HUD comparison needs ${HUD_SAMPLE_CYCLES} complete screenshot triplets`);
  }
  // Identical PNGs need decoding and scanning only once per state. Differently encoded PNGs are always
  // compared by their decoded pixels, never inferred to be different from their encoding.
  const distinct = (pngs: Buffer[]) => pngs.filter((b, i) => !pngs.slice(0, i).some(prior => b.equals(prior))).map(decode);
  const visible = distinct(samples.flatMap(s => [s.before!, s.after!]));
  const altered = distinct(samples.map(s => s.altered!));
  const { width, height } = visible[0]!;
  if ([...visible, ...altered].some(i => i.width !== width || i.height !== height)) throw new Error("replay HUD screenshot dimensions changed");
  let stableDifferences = 0, variablePixels = 0, alteredVariablePixels = 0, variableTouchingBackground = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    const v = visible[0]!.data.readUInt32LE(i), a = altered[0]!.data.readUInt32LE(i);
    let moves = false, touches = v === a;
    for (let j = 1; j < visible.length; j++) {
      const pixel = visible[j]!.data.readUInt32LE(i);
      if (pixel !== v) moves = true;
      if (pixel === a) touches = true;
    }
    const alteredMoves = altered.some(image => image.data.readUInt32LE(i) !== a);
    if (alteredMoves) alteredVariablePixels++;
    if (moves || alteredMoves) {
      variablePixels++;
      if (kind === "hidden" && moves && touches) variableTouchingBackground++;
    } else if (v !== a) stableDifferences++;
  }
  // Visible-only variation may occupy up to 1% of the screenshot, but never counts as painted HUD.
  // To establish visibility we require *more* than that area in stable, exactly differing device pixels.
  // Small HUD-only motion may be indistinguishable from repaint noise; clipping still fails on one pixel.
  const pixelLimit = Math.floor(width * height / 100);
  let verdict: HudOnScreen;
  if (variablePixels > pixelLimit) verdict = "screen not still";
  else if (kind === "unclipped") {
    // An excluded pixel might be the only pixel the clip removed. Uncertainty can never prove a HUD whole.
    verdict = stableDifferences ? "clipped" : variablePixels ? "screen not still" : "shown";
  } else if (alteredVariablePixels || variableTouchingBackground) verdict = "screen not still";
  else if (stableDifferences > pixelLimit) verdict = "shown";
  else verdict = stableDifferences || variablePixels ? "insufficient HUD paint" : "not shown";
  return { width, height, pixelLimit, stableDifferences, variablePixels, alteredVariablePixels, variableTouchingBackground, verdict };
}
