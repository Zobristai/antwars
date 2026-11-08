// Pooled board icon sprites: a mask tinted in the caller's real shade, its darker part precomposed, with a fixed dark outline.
import { CanvasSource, Container, DOMAdapter, Sprite, Texture } from "pixi.js";
import { iconMasks } from "./textures.ts";
import type { IconKey } from "./set.ts";
// Asset textures are shared across both boards. Compose once per pair, never per icon/frame.
const composites = new WeakMap<Texture, WeakMap<Texture, Texture>>();
function compositeMask(fill: Texture, second: Texture): Texture {
  let pairs = composites.get(fill);
  if (!pairs) { pairs = new WeakMap(); composites.set(fill, pairs); }
  const cached = pairs.get(second);
  if (cached) return cached;
  const w = fill.frame.width, h = fill.frame.height;
  const paint = (texture: Texture, colour: string) => {
    const canvas = DOMAdapter.get().createCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    const f = texture.frame, r = texture.source.resolution;
    ctx.drawImage(texture.source.resource, f.x * r, f.y * r, f.width * r, f.height * r, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = colour; ctx.fillRect(0, 0, w, h);
    return canvas;
  };
  const canvas = paint(fill, "white");
  const ctx = canvas.getContext("2d")!;
  ctx.globalCompositeOperation = "source-over";
  // Opaque grey carries the darker colour, not a translucent wash over the fill.
  ctx.drawImage(paint(second, "rgb(70% 70% 70%)"), 0, 0);
  const combined = new Texture({ source: new CanvasSource({ resource: canvas, resolution: 1, scaleMode: "linear", autoGenerateMipmaps: false }) });
  pairs.set(second, combined);
  const retire = () => {
    pairs!.delete(second); combined.destroy(true);
    fill.off("destroy", retire); second.off("destroy", retire);
  };
  fill.once("destroy", retire); second.once("destroy", retire);
  return combined;
}
export class IconSprites {
  readonly layer = new Container();
  private pool: Sprite[] = [];
  private used = 0;
  reset() { this.used = 0; for (const sprite of this.pool) sprite.visible = false; }
  private put(texture: Texture, x: number, y: number, w: number, h: number, tint: number, alpha: number) {
    let sprite = this.pool[this.used++];
    if (!sprite) { sprite = new Sprite(); this.pool.push(sprite); this.layer.addChild(sprite); }
    sprite.texture = texture; sprite.position.set(x, y); sprite.width = w; sprite.height = h;
    sprite.tint = tint; sprite.alpha = alpha; sprite.visible = true;
  }
  /** False means the caller draws its original vector, without changing its geometry or draw order. */
  draw(key: IconKey, x: number, y: number, w: number, h: number, tint: number, alpha = 1, outline = 0): boolean {
    const mask = iconMasks().get(key);
    if (!mask) return false;
    const texture = mask.texture;
    if (outline > 0) for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      this.put(texture, x + Math.cos(angle) * outline, y + Math.sin(angle) * outline, w, h, 0x000000, alpha * 0.8);
    }
    if (mask.second) this.put(compositeMask(texture, mask.second.texture), x, y, w, h, tint, alpha);
    else this.put(texture, x, y, w, h, tint, alpha);
    return true;
  }
}
