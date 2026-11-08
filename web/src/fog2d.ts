/**
 * The 2D board's fog: in a colony's point of view, every tile outside that colony's sight is darkened. One
 * texel per tile, drawn with nearest filtering so the fogged area is exactly the tiles outside the sight discs. It sits
 * over the ground and territory and under the food, ants and queens, which the team view has already filtered.
 */
import { BufferImageSource, Sprite, Texture } from "pixi.js";
import type { Frame } from "./buffer.ts";
import { FOG_ALPHA, FOG_RGB } from "./team-view.ts";

export class Fog2D {
  readonly layer: Sprite;
  private readonly data: Uint8Array;
  private readonly texture: Texture<BufferImageSource>;
  private shown: Uint8Array | null = null;

  constructor(mapW: number, mapH: number) {
    this.data = new Uint8Array(mapW * mapH * 4);
    for (let i = 0; i < mapW * mapH; i++) {
      this.data[i * 4] = FOG_RGB[0];
      this.data[i * 4 + 1] = FOG_RGB[1];
      this.data[i * 4 + 2] = FOG_RGB[2];
    }
    const source = new BufferImageSource({ resource: this.data, width: mapW, height: mapH, scaleMode: "nearest", alphaMode: "no-premultiply-alpha" });
    this.texture = new Texture({ source });
    this.layer = new Sprite(this.texture);
    // World units are tiles: the sprite covers the map one texel per tile.
    this.layer.width = mapW;
    this.layer.height = mapH;
    this.layer.visible = false;
  }

  update(frame: Pick<Frame, "fog">): void {
    const fog = frame.fog;
    this.layer.visible = fog !== null;
    if (fog === null || fog === this.shown || fog.length * 4 !== this.data.length) return;
    const alpha = Math.round(FOG_ALPHA * 255);
    for (let i = 0; i < fog.length; i++) this.data[i * 4 + 3] = fog[i] === 1 ? 0 : alpha;
    this.texture.source.update();
    this.shown = fog;
  }
}
