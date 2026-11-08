// Isolated real Pixi pixels for the board icons, not served-build visual evidence.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
const source = stripTypeScriptTypes(readFileSync("web/src/icons/sprites.ts", "utf8"), { mode: "strip" })
  .replace('import { CanvasSource, Container, DOMAdapter, Sprite, Texture } from "pixi.js";', 'const { CanvasSource, Container, DOMAdapter, Sprite, Texture } = window.PIXI;')
  .replace('import { iconMasks } from "./textures.ts";', 'const iconMasks = () => window.iconState;')
  .replace("export class IconSprites", "class IconSprites") + "\nwindow.IconSprites = IconSprites;";
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
});
afterAll(async () => { await browser?.close(); });
it("composes two masks before the lost-queen fade of 0.35, with the same alpha across fill and shade", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: readFileSync("node_modules/pixi.js/dist/pixi.min.js", "utf8") });
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(async () => {
      const w = window as any, P = w.PIXI;
      const mask = (half: boolean) => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white";
        ctx.fillRect(half ? 16 : 0, 0, half ? 16 : 32, 32);
        return P.Texture.from(canvas);
      };
      const fill = mask(false), second = mask(true);
      let selected: any = { texture: fill, second: { texture: second } };
      w.iconState = { get: () => selected };
      const app = new P.Application();
      await app.init({ width: 32, height: 32, resolution: 1, preference: "webgl", antialias: false, autoStart: false });
      const icons = new w.IconSprites();
      const background = new P.Graphics().rect(0, 0, 32, 32).fill(0);
      app.stage.addChild(background, icons.layer);
      const sample = (target: any) => {
        const { pixels, width } = app.renderer.extract.pixels({ target });
        return [8, 24].map(x => Array.from(pixels.slice((16 * width + x) * 4, (16 * width + x) * 4 + 4)) as number[]);
      };
      try {
        icons.draw("crown", 0, 0, 32, 32, 0xffb000, 0.35);
        const transparent = sample(icons.layer);
        const firstComposite = icons.layer.children[0].texture;
        const scenes = [];
        for (const colour of [0xffb000, 0x00c2ff]) {
          for (const ground of [0x204060, 0xffffff]) {
            background.clear().rect(0, 0, 32, 32).fill(ground);
            icons.reset(); icons.draw("crown", 0, 0, 32, 32, colour, 0.35);
            scenes.push({ colour, ground, pixels: sample(app.stage) });
          }
        }
        const reused = icons.layer.children[0].texture === firstComposite;
        // The no-second path uses the original texture and exactly the direct sprite's pixels.
        selected = { texture: fill }; icons.reset(); icons.draw("crown", 0, 0, 32, 32, 0xffb000, 0.35);
        const direct = new P.Sprite({ texture: fill, tint: 0xffb000, alpha: 0.35 });
        const oneMask = sample(icons.layer), original = sample(direct);
        const originalTexture = icons.layer.children[0].texture === fill;
        direct.destroy();
        selected = { texture: fill, second: { texture: second } };
        icons.reset(); icons.draw("crown", 0, 0, 32, 32, 0xffb000, 1);
        const combined = icons.layer.children[0].texture, combinedSource = combined.source;
        second.destroy(true);
        return { transparent, scenes, reused, oneMask, original, originalTexture,
          retired: combined.destroyed && combinedSource.destroyed };
      } finally { app.destroy(true, { children: true }); fill.destroy(true); }
    });
    // The previous two-sprite implementation produced alpha 147 (0.5775) in the overlap.
    for (const rgba of result.transparent) expect(Math.abs(rgba[3]! - 255 * 0.35)).toBeLessThanOrEqual(1);
    for (const scene of result.scenes) {
      const channels = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
      for (const [region, rgba] of scene.pixels.entries()) {
        const expected = channels(scene.colour).map((channel, i) => channel * (region === 1 ? 0.7 : 1) * 0.35 + channels(scene.ground)[i]! * 0.65);
        for (const [i, channel] of expected.entries()) expect(Math.abs(rgba[i]! - channel)).toBeLessThanOrEqual(2);
        expect(rgba[3]).toBe(255);
      }
    }
    expect(result.reused).toBe(true); expect(result.originalTexture).toBe(true);
    expect(result.oneMask).toEqual(result.original); expect(result.retired).toBe(true);
  } finally { await page.close(); }
}, 30_000);
