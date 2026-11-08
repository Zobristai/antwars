import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Frame } from "../../web/src/buffer.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";
import { TIERS } from "../../web/src/board3d/quality.ts";

let engine: NullEngine, scene: Scene;
beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); });
afterEach(() => { scene.dispose(); engine.dispose(); });

describe("3D shadow casters", () => {
  it("keeps live ants and nests in the shadow list, not ground or visible corpses, at every tier", () => {
    const ground = new Ground(scene, 8, 8);
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const nests = new Nests(scene, ground, { queens: [[256, 256], [1536, 1536]] }, 0.5, COLONY_RGB);
    const key = new DirectionalLight("key", new Vector3(1, -1, 0), scene);
    const shadows = new ShadowGenerator(2048, key);
    for (const m of [...ants.casters, ...nests.casters]) shadows.addShadowCaster(m, false);
    const frame = new Frame(); frame.ensure(4); frame.count = 4;
    for (let i = 0; i < 4; i++) {
      frame.id[i] = i + 1; frame.x[i] = 2; frame.y[i] = 3;
      frame.alpha[i] = 1; frame.agent[i] = -1;
      frame.colony[i] = i % 2; frame.caste[i] = i >> 1;
    }
    frame.corpses = [0, 1].map((colony) => ({ antId: colony + 5, colony: colony as 0 | 1, x: 3, y: 4, heading: 0, ageMs: 0 }));
    for (const tier of TIERS) {
      shadows.mapSize = tier.shadowMap; key.shadowEnabled = tier.shadows;
      ants.update(frame);
      const list = shadows.getShadowMap()!.renderList!;
      expect(ants.casters.map((m) => m.name)).toEqual(["ants0", "ants1", "soldiers0", "soldiers1"]);
      const expected = [...ants.casters, ...nests.casters];
      expect(list).toHaveLength(expected.length);
      expected.forEach((mesh, i) => expect(list[i]).toBe(mesh));
      expect(nests.casters.length).toBeGreaterThan(0);
      expect(list).not.toContain(ground.mesh);
      expect(ground.mesh.receiveShadows).toBe(true);
      const corpses = ants.meshes.filter((m) => m.name.startsWith("corpses"));
      expect(corpses).toHaveLength(2);
      for (const corpse of corpses) {
        expect(list).not.toContain(corpse);
        expect(corpse.isEnabled()).toBe(true);
        expect(corpse.isVisible).toBe(true);
        expect(corpse.thinInstanceCount).toBe(1);
      }
      ants.setVisible(false);
      for (const m of ants.meshes) expect(m.isVisible).toBe(false);
      ants.setVisible(true);
      for (const m of ants.meshes) expect(m.isVisible).toBe(true);
    }
  });

  it("wires only live ants and nests and leaves geometry independent of applyTier", () => {
    const source = readFileSync("web/src/board3d/main3d.ts", "utf8");
    expect(source).toContain("for (const m of [...ants.casters, ...nests.casters]) shadows.addShadowCaster(m, false)");
    expect(source).toContain("while (nestCasters < nests.casters.length) shadows.addShadowCaster(nests.casters[nestCasters++]!, false)");
    const applyTier = source.slice(source.indexOf("const applyTier ="), source.indexOf("  applyTier();"));
    expect(applyTier).not.toContain("ants.");
    expect(applyTier).toContain("pipeline.samples = t.msaa");
    expect(applyTier).toContain("pipeline.bloomEnabled = t.bloom");
    expect(applyTier).toContain("shadows.mapSize = t.shadowMap");
    expect(applyTier).toContain("key.shadowEnabled = t.shadows");
    expect(applyTier).toContain("scaleEngine()");
  });
});
