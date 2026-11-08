#!/usr/bin/env node
/**
 * The site favicon, derived from the approved two-ant emblem (web/assets/brand/antwars-emblem.png)
 * without redrawing it: the emblem is centred on a transparent square, then area-averaged down to
 * the standard tab sizes and packed, as PNG entries, into one web/public/favicon.ico. Vite copies web/public into
 * web/dist, where the server serves it. Run `node scripts/favicon.ts` to regenerate; test/spectator/favicon.test.ts
 * checks the committed file is exactly what this produces.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync, crc32 } from "node:zlib";

export const EMBLEM_SHA256 = "c46495af967f926d10a2d21c3e213d453da70c00e1cc26b8b4344f079d66b075";
export const FAVICON_SIZES = [16, 32, 48] as const;
export const EMBLEM_PATH = new URL("../web/assets/brand/antwars-emblem.png", import.meta.url);
export const FAVICON_PATH = new URL("../web/public/favicon.ico", import.meta.url);

/** Straight (non-premultiplied) 8-bit RGBA pixels, row-major. */
export interface Rgba { readonly width: number; readonly height: number; readonly data: Uint8Array }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit, non-interlaced RGBA PNG (the emblem's format); anything else is refused, never guessed. */
export function decodePng(png: Buffer): Rgba {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0, height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("only 8-bit non-interlaced RGBA PNGs are supported");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4] : 0, b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 :
        filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : NaN;
      if (Number.isNaN(predictor)) throw new Error(`bad PNG filter ${filter}`);
      data[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

/** Encodes RGBA as a PNG (filter 0, maximum deflate): deterministic bytes for deterministic pixels. */
export function encodePng({ width, height, data }: Rgba): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Centres the image on a transparent square; its own pixels are copied unchanged. */
export function padToSquare(image: Rgba): Rgba {
  const side = Math.max(image.width, image.height), data = new Uint8Array(side * side * 4);
  const left = Math.floor((side - image.width) / 2), top = Math.floor((side - image.height) / 2);
  for (let y = 0; y < image.height; y++) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((top + y) * side + left) * 4);
  return { width: side, height: side, data };
}

/** Area-averages a square image down to `size` px, weighting colour by alpha so transparent padding leaves no dark fringe. */
export function downscale(image: Rgba, size: number): Rgba {
  const scale = image.width / size, data = new Uint8Array(size * size * 4);
  // Each output pixel covers [i*scale, (i+1)*scale) of the source on each axis; edge source pixels count fractionally.
  const spans = Array.from({ length: size }, (_, i) => {
    const from = i * scale, to = (i + 1) * scale, weights: [number, number][] = [];
    for (let s = Math.floor(from); s < Math.ceil(to); s++) weights.push([s, Math.min(to, s + 1) - Math.max(from, s)]);
    return weights;
  });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [sy, wy] of spans[y]) for (const [sx, wx] of spans[x]) {
      const at = (sy * image.width + sx) * 4, w = wx * wy * image.data[at + 3];
      r += image.data[at] * w; g += image.data[at + 1] * w; b += image.data[at + 2] * w; a += w;
    }
    const out = (y * size + x) * 4;
    if (a > 0) { data[out] = Math.round(r / a); data[out + 1] = Math.round(g / a); data[out + 2] = Math.round(b / a); }
    data[out + 3] = Math.round(a / (scale * scale));
  }
  return { width: size, height: size, data };
}

/** Packs PNG images into an ICO container (PNG entries, as every current browser reads them). */
export function packIco(entries: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header[at] = size % 256; header[at + 1] = size % 256;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(({ png }) => png)]);
}

/** The favicon for the approved emblem's exact bytes; any other source is refused. */
export function buildFavicon(emblem: Buffer): Buffer {
  const digest = createHash("sha256").update(emblem).digest("hex");
  if (digest !== EMBLEM_SHA256) throw new Error(`emblem sha256 ${digest} is not the approved ${EMBLEM_SHA256}`);
  const square = padToSquare(decodePng(emblem));
  return packIco(FAVICON_SIZES.map(size => ({ size, png: encodePng(downscale(square, size)) })));
}

if (import.meta.main) {
  await writeFile(FAVICON_PATH, buildFavicon(await readFile(EMBLEM_PATH)));
  console.log(`wrote ${FAVICON_PATH.pathname}`);
}
