/**
 * The board-look hook (board-look.ts, set by the spectator HUD): with no look set both boards keep their plain code,
 * a set look replaces it, and clearing the look gives the plain code back. NullEngine and Pixi's program objects compile
 * no GLSL: the served build's captures are the pixel proof.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { boardLook, setBoardLook, type BoardLook } from "../../../web/src/board-look.ts";
import { Ground } from "../../../web/src/board3d/ground.ts";

const LOOK: BoardLook = {
  id: 7,
  board2d: { soil: "/* look soil */", fill: prelude => `${prelude}/* look fill */`, front: prelude => `${prelude}/* look front */` },
  board3d: {
    soil: (_x, _y, out) => { out[0] = 1; out[1] = 0; out[2] = 0; },
    ground: (point, current) => `${current}/* look ${point} */`,
    rock: [1, 1, 1],
    light: { key: [1, 1, 1], keyIntensity: 1, fill: [1, 1, 1], fillGround: [0, 0, 0], fillIntensity: 1, shadowDarkness: 0.5, contrast: 1, vignetteWeight: 1 },
  },
};

afterEach(() => setBoardLook(null));

describe("board look", () => {
  it("is unset until the HUD sets it, and unset again when it clears", () => {
    expect(boardLook()).toBeNull();
    setBoardLook(LOOK);
    expect(boardLook()).toBe(LOOK);
    setBoardLook(null);
    expect(boardLook()).toBeNull();
  });

  it("leaves the 3D ground's shader code Current's without a look, and gives it back when the look clears", () => {
    const ground = new Ground(new Scene(new NullEngine()), 32, 24);
    const current = ground.plugin.getCustomCode("fragment")!;
    setBoardLook(LOOK);
    expect(ground.plugin.getCustomCode("fragment")).toEqual({
      CUSTOM_FRAGMENT_DEFINITIONS: `${current.CUSTOM_FRAGMENT_DEFINITIONS}/* look definitions */`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `${current.CUSTOM_FRAGMENT_UPDATE_DIFFUSE}/* look diffuse */`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `${current.CUSTOM_FRAGMENT_BEFORE_FOG}/* look beforeFog */`,
    });
    setBoardLook(null);
    expect(ground.plugin.getCustomCode("fragment")).toEqual(current);
  });

  it("changes the 3D ground's shader define with the look, so a switch builds a new shader", () => {
    const ground = new Ground(new Scene(new NullEngine()), 32, 24);
    const defines: Record<string, unknown> = {};
    ground.plugin.prepareDefines(defines as never);
    expect(defines).toMatchObject({ AW_GROUND: true, AW_LOOK: 0 });
    setBoardLook(LOOK);
    ground.plugin.prepareDefines(defines as never);
    expect(defines.AW_LOOK).toBe(7);
    ground.relook();
    setBoardLook(null);
    ground.relook();
    ground.plugin.prepareDefines(defines as never);
    expect(defines.AW_LOOK).toBe(0);
  });

  it("gives the 2D ground passes the look's code and Current's back when it clears", async () => {
    const saved = (globalThis as { document?: unknown }).document;
    // Pixi reaches for a canvas when it makes a texture; no drawing happens here.
    (globalThis as { document?: unknown }).document ??= { createElement: () => ({ getContext: () => null, style: {}, addEventListener() {} }), baseURI: "http://localhost/" };
    try {
      const { RenderTexture } = await import("pixi.js");
      const { Territory } = await import("../../../web/src/territory.ts");
      const make = () => new Territory(16, 12, RenderTexture.create({ width: 8, height: 6 }), { w: 80, h: 60, ox: 0, oy: 0, tilePx: 5 });
      const source = (t: InstanceType<typeof Territory>) => [t.fill, t.front].map(m => (m.shader as unknown as { glProgram: { fragment: string } }).glProgram.fragment);
      const territory = make();
      const [fill, front] = source(territory);
      expect(fill).not.toContain("look fill");
      setBoardLook(LOOK);
      territory.relook();
      expect(source(territory)[0]).toContain("/* look fill */");
      expect(source(territory)[1]).toContain("/* look front */");
      setBoardLook(null);
      territory.relook();
      expect(source(territory)).toEqual([fill, front]);
      expect(source(make())).toEqual([fill, front]);
    } finally {
      if (saved === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = saved;
    }
  });
});
