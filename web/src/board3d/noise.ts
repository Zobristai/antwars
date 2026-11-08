/**
 * CPU value noise matching web/src/soil.ts's NOISE_GLSL (hash12, vnoise, fbm), for the 3D board's
 * baked soil and relief. Soil stays even so colony ownership, not decorative noise, reads as regions.
 */
const fract = (x: number) => x - Math.floor(x);

export function hash12(px: number, py: number): number {
  let x = fract(px * 0.1031);
  let y = fract(py * 0.1031);
  let z = fract(px * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d;
  y += d;
  z += d;
  return fract((x + y) * z);
}

export function vnoise(px: number, py: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy);
  const b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1);
  const d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

export function fbm(px: number, py: number, octaves = 5): number {
  let v = 0;
  let a = 0.5;
  for (let i = 0; i < octaves; i++) {
    v += a * vnoise(px, py);
    px = px * 2.03 + 17.1;
    py = py * 2.03 + 9.7;
    a *= 0.5;
  }
  return v;
}

/** Relief height in tiles at tile coordinates (x, y): broad undulation, a few ridges, fine bumps. */
export function heightAt(x: number, y: number): number {
  const broad = fbm(x * 0.045 + 3.1, y * 0.045 + 7.7, 4) - 0.5;
  const ridge = 1 - Math.abs(fbm(x * 0.09 + 11.3, y * 0.09 + 2.9, 3) * 2 - 1);
  const fine = vnoise(x * 0.55, y * 0.55) - 0.5;
  return broad * 3.2 + ridge * ridge * 0.9 + fine * 0.18;
}

/**
 * One light grey-green earth albedo with only sub-tile grain. Relief still catches the scene's light,
 * but height, broad noise and pebbles no longer paint patches that could be mistaken for territory.
 */
export function soilAt(x: number, y: number, out: number[]): void {
  // +/-0.012 survives the existing 8-bit bake (six steps), but remains fine,
  // low-contrast grain: no broad noise, height tint or larger coloured patches.
  const grain = (hash12(Math.floor(x * 7), Math.floor(y * 7)) - 0.5) * 0.024;
  out[0] = 0.44 + grain;
  out[1] = 0.46 + grain;
  out[2] = 0.37 + grain;
}
