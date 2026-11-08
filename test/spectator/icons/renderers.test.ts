// Board icon wiring against test-only mask sets; the shipped set's loading is in masks.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Container, DOMAdapter, Graphics, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";
import { iconKeys } from "../../../web/src/icons/set.ts";
vi.mock("pixi.js", async importOriginal => {
  const actual = await importOriginal<typeof import("pixi.js")>();
  return { ...actual, Assets: { load: vi.fn(async () => actual.Texture.WHITE) } };
});
// The renderers read the one shared IconMasks; each test swaps in a fresh one over a test-only set (null: no masks).
vi.mock("../../../web/src/icons/textures.ts", async () => {
  const { IconMasks } = await import("../../../web/src/icons/masks.ts");
  const { Assets } = await import("pixi.js");
  const sets: Record<string, import("../../../web/src/icons/set.ts").IconSet> = {
    "test-only": Object.fromEntries(["crown", "worker", "soldier", "mark-ATTACK", "glyph-diamond"].map(key => [key, { src: `${key}.png` }])),
    "two-tone": Object.fromEntries(["crown", "worker", "soldier", "mark-ATTACK", "glyph-diamond"].map(key => [key, { src: `${key}.png`, second: { src: `${key}-shade.png` } }])),
    "crown-only": { crown: { src: "crown.png", second: { src: "crown-shade.png" } } },
  };
  let current = new IconMasks<Texture>({}, src => Assets.load(src));
  return {
    iconMasks: () => current,
    iconTexture: (key: import("../../../web/src/icons/set.ts").IconKey) => current.get(key)?.texture,
    loadIcons: () => current.start(),
    useIcons: (id: string | null) => { current = new IconMasks<Texture>(id === null ? {} : sets[id]!, src => Assets.load(src)); return current.start(); },
  };
});
import * as textures from "../../../web/src/icons/textures.ts";
const { iconMasks } = textures;
const useIcons = (textures as unknown as { useIcons(id: string | null): Promise<void> }).useIcons;
import { IconSprites } from "../../../web/src/icons/sprites.ts";
import { BoardMarkers3D } from "../../../web/src/board3d/markers3d.ts";
import { QueenHomes } from "../../../web/src/effects.ts";
import { Words } from "../../../web/src/words.ts";
import { Frame } from "../../../web/src/buffer.ts";

// These structural tests do not rasterise. The separate browser pixel test uses real canvases/Pixi.
vi.spyOn(DOMAdapter.get(), "createCanvas").mockImplementation((width = 1, height = 1) => {
  const context = { drawImage: vi.fn(), fillRect: vi.fn() };
  return { width, height, getContext: () => context } as unknown as ReturnType<ReturnType<typeof DOMAdapter.get>["createCanvas"]>;
});
afterEach(async () => { await useIcons(null); });
describe("board masks", () => {
  it("falls back without sprites, then preserves box, tint, alpha, dark outline and pooling", async () => {
    const icons = new IconSprites();
    expect(icons.draw("crown", 1, 2, 14, 14, 0xffb000)).toBe(false);
    await useIcons("test-only");
    expect(icons.draw("crown", 1, 2, 14, 14, 0xffb000, 0.35, 1.25)).toBe(true);
    const sprites = icons.layer.children as Sprite[];
    expect(sprites).toHaveLength(9);
    for (const sprite of sprites.slice(0, -1)) { expect(sprite.tint).toBe(0); expect(sprite.width).toBe(14); expect(sprite.alpha).toBeCloseTo(0.28); }
    expect(sprites[8]!.tint).toBe(0xffb000); expect(sprites[8]!.x).toBe(1); expect(sprites[8]!.y).toBe(2);
    expect(sprites[8]!.alpha).toBe(0.35);
    icons.reset(); expect(sprites.every(s => !s.visible)).toBe(true);
    icons.draw("crown", 5, 6, 11, 11, 0x00c2ff); expect(icons.layer.children).toHaveLength(9);
    expect(sprites.filter(s => s.visible)).toHaveLength(1); expect(sprites[0]!.tint).toBe(0x00c2ff);
    expect(icons.draw("close", 0, 0, 16, 16, 0xffffff)).toBe(false);
  });
  it("rebuilds the queen atlas from the selected mask, one texture source for every particle frame", async () => {
    const holders: Container[] = [];
    const generateTexture = vi.fn(({ target }: { target: Container }) => {
      // Read before the temporary container is destroyed.
      const crownLayer = target.children[1] as Container;
      holders.push(new Container({ children: crownLayer.children.map(c => new Sprite({ texture: (c as Sprite).texture, tint: (c as Sprite).tint })) }));
      return RenderTexture.create({ width: 640, height: 128 });
    });
    const markers = new BoardMarkers3D({ generateTexture, resolution: 2 } as unknown as Renderer);
    expect(holders[0]!.children).toHaveLength(0);
    const version = iconMasks().version;
    await useIcons("test-only"); expect(iconMasks().version).toBeGreaterThan(version);
    const empty = { board: null, story: [], targetMs: 0, hits: [], lossShown: new Map() } as unknown as Frame;
    markers.update(empty, (_x, _y, out) => { out.x = 0; out.y = 0; });
    expect(holders[1]!.children).toHaveLength(2);
    expect(holders[1]!.children.map(s => (s as Sprite).tint)).toEqual([0xffb000, 0x00c2ff]);
    const textures = (markers as unknown as { textures: Record<string, Texture> }).textures;
    expect(new Set(Object.values(textures).map(t => t.source)).size).toBe(1);
    await useIcons(null); markers.update(empty, () => {});
    expect(holders[2]!.children).toHaveLength(0);
  });
  it("routes marks and board castes through the ready mask without removing ring geometry", async () => {
    await useIcons("test-only");
    const words = new Words({ w: 1920, h: 1080 });
    const mark = { id: 1, agent: 0, colony: 0, tileX: 10, tileY: 10, words: [], verb: "ATTACK", laidTick: 1, answered: 0 };
    const frame = { tick: 10, board: { marks: [mark] }, marks: [{ mark, ageMs: 5000 }] } as unknown as Frame;
    words.update(frame, (x, y) => [x * 20, y * 20], [], "test");
    const icons = words.layer.children[3] as Container;
    expect(icons.children.filter(s => s.visible)).toHaveLength(9);
    expect((words.layer.children[0] as Graphics).context.instructions).toHaveLength(2);
    (words as unknown as { casteIcon(c: string, x: number, y: number, shade: number, alpha: number): void }).casteIcon("worker", 1, 2, 0xffb000, 1);
    expect(icons.children.filter(s => s.visible)).toHaveLength(18);
    expect((icons.children.at(-1) as Sprite).width).toBe(14);
  });
  it("keeps the 2D emblem graphics independent of the crown sprite layer", () => {
    const homes = new QueenHomes(10);
    expect(homes.emblems).toBeInstanceOf(Graphics); expect(homes.emblems.children).toEqual([]);
    expect(homes.crownIcons).toBeInstanceOf(Container);
    expect(iconKeys).toContain("crown");
  });
  it("fades one precomposed two-mask sprite, preserving outlines, pooling and the original one-mask path", async () => {
    await useIcons("two-tone");
    const icons = new IconSprites();
    let combined: Texture | undefined;
    for (const colour of [0xffb000, 0x00c2ff, 0xffffff]) {
      icons.reset(); icons.draw("crown", 3, 5, 12, 14, colour, 0.35, 1.25);
      const sprites = icons.layer.children as Sprite[];
      expect(sprites).toHaveLength(9);
      expect(sprites.slice(0, 8).every(s => s.tint === 0 && Math.abs(s.alpha - 0.28) < 1e-6)).toBe(true);
      const fill = sprites[8]!;
      expect(fill.tint).toBe(colour); expect(fill.alpha).toBe(0.35);
      expect(fill.x).toBe(3); expect(fill.y).toBe(5); expect(fill.width).toBe(12); expect(fill.height).toBe(14);
      expect(fill.texture).not.toBe(iconMasks().get("crown")!.texture);
      combined ??= fill.texture; expect(fill.texture).toBe(combined);
    }
    await useIcons("test-only"); icons.reset(); icons.draw("crown", 1, 2, 12, 14, 0xffb000);
    expect(icons.layer.children.filter(s => s.visible)).toHaveLength(1);
    expect((icons.layer.children[0] as Sprite).texture).toBe(iconMasks().get("crown")!.texture);
    await useIcons(null); icons.reset(); expect(icons.draw("crown", 1, 2, 12, 14, 0xffb000)).toBe(false);
    expect(icons.layer.children.every(s => !s.visible)).toBe(true);
  });
  it("rebuilds the single-source 3D atlas when only the second crown mask becomes ready", async () => {
    let finishSecond!: (texture: Texture) => void;
    const load = vi.mocked(Assets.load as (src: string) => Promise<Texture>);
    // First crown fill is the same cached texture throughout the asynchronous shade load.
    load.mockImplementationOnce(async () => Texture.WHITE)
      .mockImplementationOnce(() => new Promise<Texture>(resolve => { finishSecond = resolve; }));
    const layers: number[][] = [], sources: Texture[] = [];
    const generateTexture = vi.fn(({ target }: { target: Container }) => {
      layers.push((target.children[1] as Container).children.map(c => (c as Sprite).tint));
      const texture = RenderTexture.create({ width: 640, height: 128 }); sources.push(texture); return texture;
    });
    const markers = new BoardMarkers3D({ generateTexture, resolution: 1 } as unknown as Renderer);
    const empty = { board: null, story: [], targetMs: 0, hits: [], lossShown: new Map() } as unknown as Frame;
    const pending = useIcons("crown-only"); await Promise.resolve(); await Promise.resolve();
    markers.update(empty, () => {});
    expect(layers.at(-1)).toEqual([0xffb000, 0x00c2ff]);
    finishSecond(Texture.EMPTY); await pending;
    markers.update(empty, () => {});
    expect(layers.at(-1)).toEqual([0xffb000, 0x00c2ff]);
    expect(sources[1]!.source.destroyed).toBe(true);
    const textures = (markers as unknown as { textures: Record<string, Texture> }).textures;
    expect(new Set(Object.values(textures).map(t => t.source)).size).toBe(1);
    markers.update(empty, () => {}); expect(generateTexture).toHaveBeenCalledTimes(3);
    await useIcons(null); markers.update(empty, () => {});
    expect(layers.at(-1)).toEqual([]);
  });

});
