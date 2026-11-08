/**
 * Empty Babylon thin-instance meshes fall back to drawing their source geometry. Keep them
 * disabled until populated, including after a highlight or fight disappears. NullEngine proves
 * lifecycle and layer state here; the capture host's WebGL stills prove shader compilation and pixels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Frame } from "../../web/src/buffer.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { BITE_CONTACT_MS, BITE_CONTACT_END_MS, BITE_MS, BITE_OPEN_MS, Bites } from "../../web/src/bite.ts";
import { Battles3D } from "../../web/src/board3d/effects3d.ts";
import { Food3D } from "../../web/src/board3d/food3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";

let engine: NullEngine;
let scene: Scene;
let ground: Ground;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  ground = new Ground(scene, 8, 8);
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

function mesh(name: string): Mesh {
  const found = scene.getMeshByName(name);
  expect(found).toBeInstanceOf(Mesh);
  return found as Mesh;
}

function expectCount(name: string, count: number): void {
  const m = mesh(name);
  expect(m.thinInstanceCount, `${name} count`).toBe(count);
  expect(m.isEnabled(), `${name} enabled`).toBe(count > 0);
  expect(m.hasThinInstances, `${name} instancing`).toBe(count > 0);
}

function antsFrame(count: number, colony = 0): Frame {
  const frame = new Frame();
  frame.ensure(count);
  frame.count = count;
  for (let i = 0; i < count; i++) {
    frame.id[i] = i + 1;
    frame.x[i] = 2;
    frame.y[i] = 3;
    frame.alpha[i] = 1;
    frame.colony[i] = colony;
    frame.agent[i] = 7;
  }
  return frame;
}

function fightFrame(count: number, ageMs = BITE_CONTACT_MS): Frame {
  const frame = antsFrame(count * 2); frame.renderMs = BITE_MS + ageMs; frame.tick = Math.floor(frame.renderMs / 100);
  for (let i = 0; i < count; i++) {
    frame.id[i * 2] = i * 2 + 1; frame.id[i * 2 + 1] = i * 2 + 2;
    frame.y[i * 2 + 1] = 4; frame.colony[i * 2 + 1] = 1;
  }
  frame.engagements = Array.from({ length: count * 2 }, (_, i) => ({ a: i + 1, b: i % 2 ? i : i + 2, tick: 1 }));
  const bites = new Bites(); bites.update(frame); bites.publishContacts(0.5, "3d");
  return frame;
}

describe("3D ant herds and squad rings", () => {
  it("does not upload empty batches, but uploads them when populated again", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const battles = new Battles3D(scene, ground);
    const food = new Food3D(scene, ground);
    const names = ["ants0", "ants1", "soldiers0", "soldiers1", "corpses0", "corpses1", "rings", "carried-food", "flash", "ring", "fight-sparks", "food-piles"];
    // Observe Babylon's upload boundary, without replacing any application behavior.
    const uploads = names.map((name) => vi.spyOn(mesh(name), "thinInstanceBufferUpdated"));
    ants.update(new Frame()); battles.update(new Frame()); food.update(new Frame(), 10);
    for (const upload of uploads) expect(upload).not.toHaveBeenCalled();
    ants.update(antsFrame(1), 7); battles.update(fightFrame(1));
    expect(uploads[0]).toHaveBeenCalled(); expect(uploads[6]).toHaveBeenCalled(); expect(uploads[10]).toHaveBeenCalled();
    uploads.forEach((upload) => upload.mockClear());
    ants.update(new Frame()); battles.update(new Frame()); food.update(new Frame(), 20);
    for (const upload of uploads) expect(upload).not.toHaveBeenCalled();
    ants.update(antsFrame(1), 7); battles.update(fightFrame(1));
    expectCount("ants0", 1); expectCount("fight-sparks", 1);
  });
  it("starts every source mesh disabled, even when its layer is switched on", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    ants.setVisible(true);
    for (const name of ["ants0", "ants1", "soldiers0", "soldiers1", "corpses0", "corpses1", "rings", "carried-food"]) expectCount(name, 0);
  });

  it("enables only populated colonies and highlighted rings, then disables and re-enables them", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const frame = antsFrame(2);
    ants.update(frame);
    expectCount("ants0", 2);
    expectCount("ants1", 0);
    expectCount("rings", 0);

    ants.update(frame, 7);
    expectCount("rings", 2);
    ants.update(frame, 8);
    expectCount("rings", 0);
    ants.update(frame, 7);
    expectCount("rings", 2);

    ants.update(new Frame(), 7);
    expectCount("ants0", 0);
    expectCount("rings", 0);
    ants.update(antsFrame(1, 1), 7);
    expectCount("ants0", 0);
    expectCount("ants1", 1);
    expectCount("rings", 1);
  });

  it("disables corpses when empty and enables them again after another death", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const frame = new Frame();
    frame.corpses = [{ antId: 1, x: 2, y: 3, colony: 1, heading: 0, ageMs: 10 }];
    ants.update(frame);
    expectCount("corpses0", 0);
    expectCount("corpses1", 1);
    ants.update(new Frame());
    expectCount("corpses1", 0);
    ants.update(frame);
    expectCount("corpses1", 1);
  });

  it("keeps counts and populated buffers correct after capacity growth and reuse", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    ants.update(antsFrame(257), 7, [0.2, 0.4, 0.6]);
    expectCount("ants0", 257);
    expectCount("rings", 257);
    const matrices = mesh("rings").thinInstanceGetWorldMatrices();
    expect(matrices).toHaveLength(257);
    expect(matrices[256]!.getTranslation().asArray()).toEqual([2, expect.any(Number), 5]);
    ants.update(new Frame());
    expectCount("ants0", 0);
    expectCount("rings", 0);
    ants.update(antsFrame(1), 7);
    expectCount("ants0", 1);
    expectCount("rings", 1);
  });

  it("updates cannot undo a hidden layer, and showing an empty layer cannot enable a source mesh", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    ants.setVisible(false);
    ants.update(antsFrame(1), 7);
    for (const name of ["ants0", "ants1", "soldiers0", "soldiers1", "corpses0", "corpses1", "rings", "carried-food"]) expect(mesh(name).isVisible).toBe(false);
    ants.update(new Frame());
    ants.setVisible(true);
    for (const name of ["ants0", "ants1", "soldiers0", "soldiers1", "corpses0", "corpses1", "rings", "carried-food"]) {
      expect(mesh(name).isVisible).toBe(true);
      expectCount(name, 0);
    }
    ants.update(antsFrame(1), 7);
    expectCount("ants0", 1);
    expectCount("rings", 1);
    expect(mesh("rings").isVisible).toBe(true);
  });
});

describe("3D bounded head-contact cues", () => {
  it("uploads one non-additive tiny contact spark, disables it outside contact, and keeps source meshes off", () => {
    const battles = new Battles3D(scene, ground);
    battles.update(fightFrame(1));
    expectCount("flash", 0); expectCount("ring", 0); expectCount("fight-sparks", 1);
    const m = mesh("fight-sparks")._thinInstanceDataStorage.matrixData!;
    expect(m[12]).toBe(2); expect(m[14]).toBe(4.5); expect(m[0]).toBeCloseTo(0.035);
    const mat = mesh("fight-sparks").material as import("@babylonjs/core/Materials/standardMaterial.js").StandardMaterial;
    expect(mat.alphaMode).toBe(2); // Babylon ALPHA_COMBINE, not ALPHA_ADD
    battles.update(fightFrame(1, BITE_CONTACT_END_MS)); expectCount("fight-sparks", 0);
    battles.update(fightFrame(1)); expectCount("fight-sparks", 1);
    battles.update(new Frame()); expectCount("fight-sparks", 0);
  });
  it("grows the spark buffers and preserves hidden layers across empty/refilled frames", () => {
    const battles = new Battles3D(scene, ground); battles.setVisible(false); battles.update(fightFrame(65));
    expectCount("fight-sparks", 65); expect(mesh("fight-sparks").isVisible).toBe(false);
    expect(mesh("fight-sparks").thinInstanceGetWorldMatrices()).toHaveLength(65);
    battles.update(new Frame()); battles.setVisible(true);
    expectCount("flash", 0); expectCount("ring", 0); expectCount("fight-sparks", 0);
    battles.update(fightFrame(1)); expectCount("fight-sparks", 1);
  });
});

/** NullEngine proves instance/attribute wiring, not compiled GLSL or pixels. */
describe("3D head jabs and mandibles", () => {
  const buffer = (name: string, attr: string) => mesh(name).getVertexBuffer(attr)!.getFloatData(mesh(name).thinInstanceCount * (attr === "aHead" ? 2 : 1), true)!;
  const matrix = (name: string, i = 0) => Array.from(mesh(name)._thinInstanceDataStorage.matrixData!.subarray(i * 16, i * 16 + 16));
  it.each([0, 1])("moves caste %s's head independently, closes jaws at contact, and resumes the original gait", (caste) => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB), f = fightFrame(1, BITE_OPEN_MS);
    f.caste[0] = caste; f.carrying[0] = 1;
    const original = structuredClone(f), name = caste ? "soldiers0" : "ants0";
    ants.update(f, 7);
    expect(buffer(name, "aBite")[0]).toBe(1);
    const tags = mesh(name).getVerticesData("aLeg")!;
    for (const tag of [3, 4, 5]) expect(tags.some((v, i) => i % 2 === 0 && v === tag)).toBe(true);
    expect(f).toEqual(original);
    f.renderMs = BITE_MS + BITE_CONTACT_MS; f.tick = Math.floor(f.renderMs / 100); ants.update(f, 7);
    const bites = new Bites(); bites.update(f); const pose = bites.pose(0, caste ? 1 : 0.5)!;
    const m = matrix(name), size = caste ? 1 : 0.5;
    expect(m[12]).toBeCloseTo(pose.x); expect(m[14]).toBeCloseTo(8 - pose.y);
    expect(buffer(name, "aHead")[0]).toBeCloseTo(pose.headOffset / size); expect(buffer(name, "aBite")[0]).toBe(0);
    if (!caste) expect(matrix("carried-food")[14]).toBeCloseTo(8 - pose.y - Math.sin(pose.rotation) * pose.headOffset);
    f.engagements = []; ants.update(f);
    expect(buffer(name, "aHead")[0]).toBe(0); expect(matrix(name)[14]).toBeCloseTo(m[14]!);
    for (let k = 0; k < 2; k++) { f.renderMs += 100; f.tick = Math.floor(f.renderMs / 100); ants.update(f); }
    expect(matrix(name)[14]).toBe(5);
    ants.update(new Frame()); expectCount(name, 0);
  });
  it("grows both attributes with the herd and clears old slots on target loss", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB), f = antsFrame(300);
    f.renderMs = BITE_MS + BITE_OPEN_MS; f.tick = Math.floor(f.renderMs / 100); f.y[299] = 4; f.colony[299] = 1;
    f.engagements = [{ a: 1, b: 300, tick: 1 }];
    ants.update(f); expectCount("ants0", 299); expect(buffer("ants0", "aBite")[0]).toBe(1);
    expect(buffer("ants0", "aHead")[0]).not.toBe(0);
    f.count = 1; ants.update(f); expect(buffer("ants0", "aBite")[0]).toBe(0); expect(buffer("ants0", "aHead")[0]).toBe(0);
  });
  it("animates an explicitly identified final corpse bite, then returns to the fading corpse", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB), f = antsFrame(1);
    f.tick = 1; f.renderMs = 130;
    f.corpses = [{ antId: 2, x: 2, y: 4, colony: 1, heading: 0, ageMs: 30 }];
    f.engagements = [{ a: 2, b: 1, tick: 1, terminalTick: 1 }]; ants.update(f);
    expectCount("corpses1", 1); expect(buffer("corpses1", "aHead")[0]).not.toBe(0); expect(matrix("corpses1")[5]).toBeGreaterThan(0);
    f.tick++; f.renderMs += 100; f.corpses[0]!.ageMs += 100; f.engagements = []; ants.update(f);
    expect(buffer("corpses1", "aHead")[0]).toBe(0); expect(matrix("corpses1")[5]).toBeLessThan(0);
  });
});
