/**
 * Local rendered palette regression: four backgrounds × two boards × two sizes.
 * Run after build:web: node --import ./src/ts-resolve.mjs test/spectator/actor-palette-browser.ts
 * ACTOR_BROWSER=webkit requires that engine; it never falls back to Chromium.
 * Pixel gates detect missing ink/backing, not perceptual hue equivalence or the
 * palette choice. Retained stills need visual inspection. No real joins.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";
import { encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { CHROMIUM_FLAGS, HEADLESS_SHELL, openClient, RECORDING_DIR } from "../../web/capture/browser.ts";
import { actorPaletteFixture, PALETTE_BACKGROUNDS, PALETTE_POOL, contrast, inQuad, rgb, rgbDistance } from "./actor-palette-fixture.ts";

// Read the current literals rather than importing the DOM renderer graph into
// Node. The paired unit test checks these mappings using the actual exports.
const source = (name: string) => readFileSync(new URL(`../../web/src/${name}`, import.meta.url), "utf8");
const paletteBlock = /const AGENT_HUES = \[([\s\S]*?)\] as const/.exec(source("squads.ts"));
const colonyBlock = /COLONY_TINT = \[([^\]]+)\]/.exec(source("ants.ts"));
assert(paletteBlock && colonyBlock, "palette literals must retain their declared shape");
const colours = (text: string) => [...text.matchAll(/0x[0-9a-f]+/gi)].map(m => rgb(Number(m[0])));
const hues = colours(paletteBlock[1]!), colonyHues = colours(colonyBlock[1]!);
assert.equal(hues.length, 8); assert.equal(colonyHues.length, 2);
const engine = process.env.ACTOR_BROWSER ?? "chromium";
assert(engine === "chromium" || engine === "webkit");
const out = process.env.ACTOR_OUTPUT ?? "out/actor-palette";
mkdirSync(out, { recursive: true });
mkdirSync(RECORDING_DIR, { recursive: true });
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({
  executablePath: HEADLESS_SHELL, args: [...CHROMIUM_FLAGS, "--disable-dev-shm-usage"],
});
const results: { board: string; width: number; background: string; ground: number[]; [key: string]: unknown }[] = [];
try {
  for (const background of PALETTE_BACKGROUNDS) {
    const state = actorPaletteFixture(background);
    const recorder = new SpectatorRecorder(state);
    const recording = `actor-palette-${background}`;
    writeFileSync(join(RECORDING_DIR, `${recording}.bin`), packMessages([
      encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() }),
    ]));
    for (const board of ["2d", "3d"] as const) for (const [width, height] of [[1920, 1080], [390, 844]] as const) {
      const client = await openClient(browser, { recording, width, height, board, tilt: false });
      try {
        assert.equal(client.info.rendererName.toLowerCase().includes("babylon"), board === "3d", "actual selected renderer");
        await client.setOptions({ markLabels: true });
        await client.advance(RENDER_DELAY_MS + 600);
        // A ready 3D client may still be compiling its first materials. Exercise
        // six drawn frames and guard actual ground pixels, not overlay presence.
        let frame = await client.frame(true);
        for (let i = 0; i < 5; i++) { await client.advance(16); frame = await client.frame(true); }
        const measured = await client.page.evaluate(({ pool, free }) => {
          const api = window.__antwar;
          const [x, y] = api.tileToScreen(32, 24);
          return { labels: api.markLabels(), markers: api.markers(),
            actors: Array.from({ length: 8 }, (_, i) => api.squadAnts(i)),
            colonies: free.map(p => api.tileToScreen(p[0]!, p[1]!)),
            ground: api.samplePixel(Math.round(x), Math.round(y)),
            pool: [[pool.x, pool.y], [pool.x + pool.width, pool.y],
              [pool.x + pool.width, pool.y + pool.height], [pool.x, pool.y + pool.height]].map(p => api.tileToScreen(p[0]!, p[1]!)) };
        }, { pool: PALETTE_POOL, free: [[10, 24], [54, 24]] });
        assert(measured.ground.slice(0, 3).some(c => c > 40), `ground not drawn: ${measured.ground}`);
        const actorPoints = background === "water" ? [] : [...measured.actors.map(a => a[0]!), ...measured.colonies];
        assert.equal(measured.actors.filter(a => a.length === 1).length, background === "water" ? 0 : 8, "actors present on land only");
        for (const p of actorPoints) {
          assert(p[0] >= 8 && p[0] < width - 8 && p[1] >= 8 && p[1] < height - 8, "whole actor sample inside viewport");
        }
        assert.equal(measured.markers.length, 8);
        if (measured.labels.length !== 8) await client.page.screenshot({ path: join(out, `${engine}-${board}-${width}-${background}-missing-labels.png`) });
        assert.equal(measured.labels.length, 8, `all eight count labels visible; found ${measured.labels.map(l => l.id)}`);
        for (const label of measured.labels) {
          // The board draws the count; caste "any" has no icon, so the figure stands alone.
          assert.equal(label.text, "0/12", "whole count-label text");
          const r = label.rect;
          assert(r.x0 >= 0 && r.x1 <= width && r.y0 >= 0 && r.y1 <= height, "whole label inside viewport");
          if (background === "water") for (const p of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]) {
            assert(inQuad(p, measured.pool), `label ${label.id} must actually sit entirely over water: ${JSON.stringify({ point: p, pool: measured.pool })}`);
          }
        }
        const stem = `${engine}-${board}-${width}-${background}`;
        const screenshot = join(out, `${stem}.png`);
        const foreground = await client.page.screenshot({ path: screenshot });
        // Same camera, same paused time, actual underlying rendered surface.
        // Only the actor/word layers are hidden; territory/water remain untouched.
        await client.setOptions({ ants: false, words: false });
        await client.frame(true);
        const backdrop = await client.page.screenshot({ path: join(out, `${stem}-background.png`) });
        const samples = await client.page.evaluate(async ({ foreground, backdrop, labels, actors }) => {
          const decode = async (base64: string) => {
            const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
            const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
            return { ctx, width: image.width, height: image.height };
          };
          const fg = await decode(foreground), bg = await decode(backdrop);
          const regions = [...labels.map(l => ({ kind: "label", id: l.id, rect: l.rect })),
            ...actors.map((p, i) => ({ kind: "actor", id: i, rect: { x0: p[0]! - 8, y0: p[1]! - 8, x1: p[0]! + 8, y1: p[1]! + 8 } }))];
          return regions.map(({ kind, id, rect }) => {
            const x = Math.max(0, Math.ceil(rect.x0)), y = Math.max(0, Math.ceil(rect.y0));
            const w = Math.min(fg.width - x, Math.floor(rect.x1) - x), h = Math.min(fg.height - y, Math.floor(rect.y1) - y);
            const ink = fg.ctx.getImageData(x, y, w, h).data, under = bg.ctx.getImageData(x, y, w, h).data;
            return { kind, id, width: w, height: h, ink: Array.from(ink), under: Array.from(under) };
          });
        }, { foreground: foreground.toString("base64"), backdrop: backdrop.toString("base64"), labels: measured.labels,
          actors: actorPoints });
        const diagnostics = samples.map(s => {
          const expected = s.kind === "label" ? hues[s.id - 1]! : s.id < 8 ? hues[s.id]! : colonyHues[s.id - 8]!;
          let nearest = Infinity, changed = 0;
          let backing = [255, 255, 255], ink = [0, 0, 0], underlying = [0, 0, 0];
          for (let i = 0; i < s.ink.length; i += 4) {
            const p = s.ink.slice(i, i + 3), b = s.under.slice(i, i + 3);
            if (rgbDistance(p, b) > 18) changed++;
            // The fixture's labels carry no icon (caste "any"), so every
            // label pixel can certify that the count itself was drawn.
            if (rgbDistance(p, expected) < nearest) {
              nearest = rgbDistance(p, expected); ink = p; underlying = b;
            }
            if (p[0]! + p[1]! + p[2]! < backing[0]! + backing[1]! + backing[2]!) backing = p;
          }
          assert(changed >= 3, `${stem} ${s.kind} ${s.id}: missing rendered object`);
          // Broad rendered-ink smoke tolerance permits shading/antialiasing;
          // this is deliberately not a colour-difference accessibility claim.
          assert(nearest < 100, `${stem} ${s.kind} ${s.id}: hue ink absent (distance ${nearest})`);
          if (s.kind === "label") assert(contrast(ink, backing) >= 4.5,
            `${stem} label ${s.id}: rendered ink does not clear 4.5:1 against its actual backing (ink ${ink}, backing ${backing}, nearest ${nearest})`);
          return { kind: s.kind, id: s.id, expected, ink, backing, underlying, nearest, changed,
            backingContrast: contrast(ink, backing), bareSurfaceContrast: contrast(ink, underlying) };
        });
        assert.deepEqual(client.errors, [], "page/console errors");
        const result = { engine, board, width, height, background, renderer: client.info.rendererName,
          ground: measured.ground, frame, labels: measured.labels, diagnostics, screenshot };
        results.push(result);
        console.log(`${stem}: PASS (${diagnostics.length} rendered regions)`);
      } finally { await client.close(); }
    }
  }
  assert.equal(results.length, 16, "complete local background matrix");
  for (const result of results.filter(r => r.background !== "neutral")) {
    const neutral = results.find(r => r.board === result.board && r.width === result.width && r.background === "neutral")!;
    assert(rgbDistance(result.ground, neutral.ground) > 1, `${result.background} must actually change the rendered surface`);
  }
} finally {
  // On failure this file is partial evidence, not a successful matrix result.
  writeFileSync(join(out, "measurements.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
