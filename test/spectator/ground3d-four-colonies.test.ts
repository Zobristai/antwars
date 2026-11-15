/**
 * The 3D ground's territory in a four-colony match: each colony's tiles in its own level and colour, a front wherever two
 * colonies' tiles meet, an eliminated colony's former tiles neutral; a two-colony match's ground code exactly as before.
 * NullEngine compiles no GLSL: the browser stills are the pixel proof.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Frame, TRAIL_RES, type Board } from "../../web/src/buffer.ts";
import { Ground } from "../../web/src/board3d/ground.ts";
import { COLONY_LEVEL, NEUTRAL_LEVEL, laterColonies } from "../../web/src/board3d/owner-levels.ts";
import { setBoardLook } from "../../web/src/board-look.ts";
import { colonyRgb, colonyWash } from "../../web/src/colony-palette.ts";
import { STEPPE_LOOK } from "../../web/src/ui/steppe-look.ts";

const W = 6;
const H = 3;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const vec3 = (c: readonly number[]) => `vec3(${c.map(v => v.toFixed(4)).join(", ")})`;

let engine: NullEngine;
let scene: Scene;
let ground: Ground;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  ground = new Ground(scene, W, H);
});
afterEach(() => {
  vi.restoreAllMocks();
  setBoardLook(null);
  scene.dispose();
  engine.dispose();
});

/** A frame of a match with `colonies` colonies: the ground reads only the setup's queens from its board. */
function frame(colonies: number, owners: readonly number[]): Frame {
  const f = new Frame();
  f.board = { setup: { queens: Array.from({ length: colonies }, () => [0, 0]) } } as unknown as Board;
  f.territoryA = Uint8Array.from(owners);
  f.territoryB = Uint8Array.from(owners);
  f.trails = new Float32Array(W * H * TRAIL_RES * TRAIL_RES * 2);
  return f;
}

/** The territory bytes the ground uploads for this frame. */
function upload(f: Frame): Uint8Array {
  const spy = vi.spyOn(ground.plugin.textures.a as RawTexture, "update");
  ground.update(f, 0);
  const bytes = spy.mock.calls.at(-1)![0] as Uint8Array;
  spy.mockRestore();
  return bytes;
}

const NEUTRAL: readonly number[] = Array.from({ length: W * H }, () => 0);
// Owners (0 neutral, colony + 1), rows top to bottom.
const FOUR = [
  1, 1, 2, 2, 0, 3,
  3, 3, 4, 4, 0, 3,
  0, 4, 4, 1, 2, 0,
];

describe("four colonies' 3D territory data", () => {
  it("gives every colony's tiles that colony's own level and owned coverage, and neutral tiles neither", () => {
    const bytes = upload(frame(4, FOUR));
    for (let i = 0; i < W * H; i++) {
      const owner = FOUR[i]!;
      expect(bytes[i * 4]).toBe(owner === 0 ? NEUTRAL_LEVEL : COLONY_LEVEL[owner - 1]);
      expect(bytes[i * 4 + 2]).toBe(owner === 0 ? 0 : 255);
      expect(bytes[i * 4 + 3]).toBe(255);
    }
    expect(new Set(COLONY_LEVEL).size).toBe(4);
  });

  it("flags a front on every edge where two different colonies' tiles meet, and none against neutral ground", () => {
    const bytes = upload(frame(4, FOUR));
    const edges = (x: number, y: number) => bytes[(y * W + x) * 4 + 1];
    // Left 1, right 2, up 4, down 8.
    expect(edges(0, 0)).toBe(8); // colony 0 above colony 2
    expect(edges(1, 0)).toBe(2 | 8); // colony 0 beside colony 1, above colony 2
    expect(edges(2, 0)).toBe(1 | 8); // colony 1 beside colony 0, above colony 3
    expect(edges(3, 0)).toBe(8); // colony 1 above colony 3; neutral to its right
    expect(edges(5, 0)).toBe(0); // colony 2 next to neutral and itself
    expect(edges(1, 1)).toBe(2 | 4 | 8); // colony 2 beside colony 3, under colony 0, above colony 3
    expect(edges(2, 1)).toBe(1 | 4); // colony 3 beside colony 2, under colony 1, above itself
    expect(edges(3, 1)).toBe(4 | 8); // colony 3 under colony 1, above colony 0
    expect(edges(3, 2)).toBe(1 | 2 | 4); // colony 0 between colonies 3 and 1, under colony 3
    expect(edges(4, 2)).toBe(1); // colony 1 beside colony 0; neutral above and right
    expect(edges(4, 1)).toBe(0); // neutral ground is never a front
  });

  it("shows an eliminated colony's former tiles as neutral, with no front against them", () => {
    upload(frame(4, FOUR));
    // Colony 2 is eliminated: its tiles arrive as 0.
    const after = FOUR.map(o => (o === 3 ? 0 : o));
    const bytes = upload(frame(4, after));
    for (let i = 0; i < W * H; i++) {
      if (FOUR[i] === 3) expect([...bytes.subarray(i * 4, i * 4 + 4)]).toEqual([NEUTRAL_LEVEL, 0, 0, 255]);
    }
    const edges = (x: number, y: number) => bytes[(y * W + x) * 4 + 1];
    expect(edges(0, 0)).toBe(0); // colony 0 above colony 2's former tile
    expect(edges(1, 0)).toBe(2); // still beside colony 1
    expect(edges(2, 1)).toBe(4); // colony 3 under colony 1; its former colony 2 neighbour is neutral
  });

  it("reads every colony's level back as that colony under the ground's GLSL choice", () => {
    // The generated statements' own constants: colonies 2 and 3 by level, the rest by step(0.75, r) as two colonies.
    const picks = [...laterColonies("two", "three").matchAll(/abs\(awLevel - ([\d.]+)\) < ([\d.]+)\) return (\w+);/g)]
      .map(m => ({ level: Number(m[1]), within: Number(m[2]), colony: m[3] === "two" ? 2 : 3 }));
    expect(picks.map(p => p.colony)).toEqual([2, 3]);
    const read = (level: number) => picks.find(p => Math.abs(level - p.level) < p.within)?.colony ?? (level / 255 >= 0.75 ? 0 : 1);
    expect(COLONY_LEVEL.map(read)).toEqual([0, 1, 2, 3]);
  });
});

describe("four colonies' 3D ground shader", () => {
  it("builds the four-colony ground once a four-colony setup arrives, and the two-colony ground again after it", () => {
    const material = ground.mesh.material!;
    const dirty = vi.spyOn(material, "markAsDirty");
    const defines: Record<string, unknown> = {};
    ground.update(frame(2, NEUTRAL), 0);
    ground.plugin.prepareDefines(defines as never);
    expect(defines.AW_COLONIES).toBe(2);
    expect(dirty).not.toHaveBeenCalled();
    ground.update(frame(4, FOUR), 0);
    ground.update(frame(4, FOUR), 16);
    expect(dirty).toHaveBeenCalledTimes(1);
    ground.plugin.prepareDefines(defines as never);
    expect(defines.AW_COLONIES).toBe(4);
    ground.update(frame(2, NEUTRAL), 32);
    expect(dirty).toHaveBeenCalledTimes(2);
    ground.plugin.prepareDefines(defines as never);
    expect(defines.AW_COLONIES).toBe(2);
  });

  it("colours colonies 2 and 3 from their own colours, ahead of colony 0's and 1's", () => {
    ground.update(frame(4, FOUR), 0);
    const defs = ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_DEFINITIONS!;
    expect(defs).toContain(`vec3 awColony(vec4 s) {\n${laterColonies("uC2", "uC3")}  return mix(uC1, uC0 * 0.85, step(0.75, s.r));\n}`);
    // The front is drawn in its own tile's colony colour, on either side of the edge.
    expect(defs).toContain("return mix(awColony(s), vec3(1.0), 0.18) * 0.65;");
    expect(ground.plugin.getUniforms().ubo).toEqual(expect.arrayContaining([{ name: "uC2", size: 3, type: "vec3" }, { name: "uC3", size: 3, type: "vec3" }]));
    const ubo = new UniformBuffer(engine);
    vi.spyOn(ubo, "updateFloat2").mockImplementation(() => {});
    vi.spyOn(ubo, "updateFloat").mockImplementation(() => {});
    vi.spyOn(ubo, "setTexture").mockImplementation(() => {});
    const colours = vi.spyOn(ubo, "updateFloat3").mockImplementation(() => {});
    ground.plugin.bindForSubMesh(ubo, scene, engine, ground.mesh.subMeshes![0]!);
    for (const c of [0, 1, 2, 3]) expect(colours).toHaveBeenCalledWith(`uC${c}`, ...colonyRgb(c), "");
    ubo.dispose();
  });

  it("washes colonies 2 and 3 in their own washes on the steppe look", () => {
    setBoardLook(STEPPE_LOOK);
    ground.update(frame(4, FOUR), 0);
    const defs = ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_DEFINITIONS!;
    const hue = (c: number) => vec3(colonyWash(c).hue);
    expect(defs).toContain(`vec3 d1Hue(vec4 s) {\n${laterColonies(hue(2), hue(3))}  return mix(${hue(1)}, ${hue(0)}, step(0.75, s.r));\n}`);
  });

  it("keeps a two-colony match's ground code byte for byte, plain and on the steppe look", () => {
    // Measured on the program branch before four colonies (f631c26d498dd0716b416193abb79ac93e2f6884), rated names.
    const before = {
      plain: ["aefb0a4950297f153843c6b6182218dd11e05433666ba2d109cba617374c2ca9", "4d897cbde08aa47a83c970e04806c7284e6227870c42b8abde75864b84598c59", "e80a81b992442165f94907f97506a65c182e880e2ff80ec157d4a777a886389a"],
      steppe: ["044ccc760e01c9be8fd9a4c2b4749c704212d6e20954cf818f45977b764d9c57", "9bc75b0131eebb2b5c2a1bb49bf8af4955b531b7a3f9bbac3e675e51170e61f6", "e80a81b992442165f94907f97506a65c182e880e2ff80ec157d4a777a886389a"],
    };
    const hashes = () => {
      const code = ground.plugin.getCustomCode("fragment")!;
      return [code.CUSTOM_FRAGMENT_DEFINITIONS!, code.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!, code.CUSTOM_FRAGMENT_BEFORE_FOG!].map(sha);
    };
    expect(hashes()).toEqual(before.plain);
    ground.update(frame(2, [1, 2, 0, 1, 2, 0, ...NEUTRAL.slice(6)]), 0);
    expect(hashes()).toEqual(before.plain);
    setBoardLook(STEPPE_LOOK);
    expect(hashes()).toEqual(before.steppe);
    expect(STEPPE_LOOK.board3d.ground("definitions", "", 2)).toBe(STEPPE_LOOK.board3d.ground("definitions", ""));
  });
});
