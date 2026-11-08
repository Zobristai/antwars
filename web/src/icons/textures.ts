// The icon masks as Pixi textures, one load shared by both boards and the HUD's DOM icons.
import { Assets, type Texture } from "pixi.js";
import { iconSet, type IconKey } from "./set.ts";
import { IconMasks } from "./masks.ts";
let masks: IconMasks<Texture> | undefined;
export function iconMasks(): IconMasks<Texture> {
  return masks ??= new IconMasks(iconSet, async src => {
    const texture = await Assets.load<Texture>(src);
    texture.source.scaleMode = "linear";
    texture.source.autoGenerateMipmaps = false;
    return texture;
  });
}
export function loadIcons(): Promise<void> { return iconMasks().start(); }
export function iconTexture(key: IconKey) { return iconMasks().get(key)?.texture; }
