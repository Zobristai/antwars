/** Dynamic queen nests, from the same delayed queen records as crowns and score rows. */
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { SUB_TILE, type StreamQueen, type StreamSetup } from "../../../src/live/format.ts";
import { buildAntGeometry } from "./ants3d.ts";
import type { Ground } from "./ground.ts";

const MOUND_R = 1.7, MOUND_H = 0.55, QUEEN_LENGTHS = 2.4;

export function queenTiles(setup: Pick<StreamSetup, "queens">): [[number, number], [number, number]] {
  const t = ([x, y]: readonly [number, number]): [number, number] => [x / SUB_TILE, y / SUB_TILE];
  return [t(setup.queens[0]), t(setup.queens[1])];
}
export function tileToWorld(tx: number, ty: number, mapH: number, groundY: number): [number, number, number] {
  return [tx, groundY, mapH - ty];
}

export class Nests {
  readonly casters: Mesh[] = [];
  /** Each queen's meshes: the mound, its rim, the entrance and the queen herself, with the rim's material while she lives. */
  private meshes = new Map<string, { meshes: Mesh[]; rim: StandardMaterial; x: number; y: number }>();
  private soil: StandardMaterial;
  private hole: StandardMaterial;
  /** A lost nest's rim, per colony: the colony's colour dimmed and unlit, so the nest reads as a landmark of a queen that was. */
  private lostRims = new Map<number, StandardMaterial>();

  constructor(private scene: Scene, private ground: Ground, setup: Pick<StreamSetup, "queens">,
    private antLengthTiles: number, private colonyRgb: readonly (readonly number[])[]) {
    this.soil = new StandardMaterial("mound", scene);
    this.soil.diffuseColor = new Color3(0.2, 0.14, 0.09);
    this.soil.specularColor = new Color3(0.03, 0.03, 0.03);
    this.hole = new StandardMaterial("entrance", scene);
    this.hole.diffuseColor = new Color3(0, 0, 0);
    this.hole.specularColor = new Color3(0, 0, 0);
    this.update(([0, 1] as const).map((colony) => ({ id: 0, colony, x: setup.queens[colony][0], y: setup.queens[colony][1], foundedTick: 0, lostTick: null, overrun: 0 })));
  }

  /** Follow the ants' current length after layout/refits, including queens founded later. */
  get lengthTiles(): number { return this.antLengthTiles; }
  set lengthTiles(length: number) {
    if (length === this.antLengthTiles) return;
    this.antLengthTiles = length;
    for (const queen of this.casters) {
      queen.unfreezeWorldMatrix();
      queen.scaling.setAll(length * QUEEN_LENGTHS);
      queen.freezeWorldMatrix();
    }
  }

  /**
   * The nests of the queens listed: a lost queen's nest stays drawn as a landmark, its rim dimmed, the queen
   * herself gone (the fallen queen or nest stays visible instead of
   * vanishing); a nest the list no longer carries (another match's queens) is hidden.
   */
  update(queens: readonly StreamQueen[]): void {
    const listed = new Set<string>();
    for (const q of queens) {
      const key = `${q.colony}:${q.id}`;
      listed.add(key);
      let n = this.meshes.get(key);
      if (!n) {
        n = this.build(q, queens);
        this.meshes.set(key, n);
      }
      const [mound, rim, entrance, queen] = n.meshes as [Mesh, Mesh, Mesh, Mesh];
      // The setup pair can be legacy camera anchors rather than the final picked id-zero positions.
      // Move the existing meshes before the first draw (also on reconnect), preserving their physical offsets.
      if (n.x !== q.x || n.y !== q.y) {
        const tx = q.x / SUB_TILE, ty = q.y / SUB_TILE;
        const oldX = n.x / SUB_TILE, oldY = n.y / SUB_TILE;
        const rise = this.ground.heightAt(tx, ty) - this.ground.heightAt(oldX, oldY);
        for (const mesh of n.meshes) {
          mesh.unfreezeWorldMatrix();
          mesh.position.addInPlaceFromFloats(tx - oldX, rise, oldY - ty);
          mesh.freezeWorldMatrix();
        }
        n.x = q.x; n.y = q.y;
      }
      const enemy = queens.find(other => other.colony !== q.colony && other.lostTick === null);
      if (enemy) {
        const facing = Math.atan2(enemy.y - q.y, enemy.x - q.x);
        if (queen.rotation.y !== facing) {
          queen.unfreezeWorldMatrix(); queen.rotation.y = facing; queen.freezeWorldMatrix();
        }
      }
      const lost = q.lostTick !== null;
      for (const mesh of [mound, rim, entrance]) mesh.setEnabled(true);
      queen.setEnabled(!lost);
      rim.material = lost ? this.lostRim(q.colony) : n.rim;
    }
    for (const [key, n] of this.meshes) if (!listed.has(key)) for (const mesh of n.meshes) mesh.setEnabled(false);
  }

  private lostRim(colony: number): StandardMaterial {
    let m = this.lostRims.get(colony);
    if (!m) {
      const rgb = this.colonyRgb[colony]!;
      m = new StandardMaterial(`rimLost${colony}`, this.scene);
      m.diffuseColor = new Color3(rgb[0]! * 0.3, rgb[1]! * 0.3, rgb[2]! * 0.3);
      m.specularColor = new Color3(0, 0, 0);
      this.lostRims.set(colony, m);
    }
    return m;
  }

  private build(q: StreamQueen, queens: readonly StreamQueen[]): { meshes: Mesh[]; rim: StandardMaterial; x: number; y: number } {
    const { scene, ground } = this;
    const scale = ground.physicalScale;
    const tx = q.x / SUB_TILE, ty = q.y / SUB_TILE, colony = q.colony;
    const suffix = q.id === 0 ? `${colony}` : `${colony}-${q.id}`;
    const [x, y, z] = tileToWorld(tx, ty, ground.mapH, ground.heightAt(tx, ty));
    const rgb = this.colonyRgb[colony]!;
    const mound = CreateSphere(`mound${suffix}`, { diameterX: MOUND_R * 2 * scale, diameterY: MOUND_H * 2 * scale, diameterZ: MOUND_R * 2 * scale, segments: 16, slice: 0.5 }, scene);
    mound.position.set(x, y - 0.05 * scale, z); mound.material = this.soil; mound.receiveShadows = true;
    const rim = CreateTorus(`rim${suffix}`, { diameter: MOUND_R * 2 * scale, thickness: 0.14 * scale, tessellation: 40 }, scene);
    rim.position.set(x, y + 0.02 * scale, z);
    const rimMat = new StandardMaterial(`rim${suffix}`, scene);
    rimMat.diffuseColor = new Color3(rgb[0]!, rgb[1]!, rgb[2]!);
    rimMat.emissiveColor = new Color3(rgb[0]! * 0.35, rgb[1]! * 0.35, rgb[2]! * 0.35); rim.material = rimMat;
    const entrance = CreateDisc(`entrance${suffix}`, { radius: 0.32 * scale, tessellation: 18 }, scene);
    entrance.rotation.x = Math.PI / 2; entrance.position.set(x - 0.6 * scale, y + MOUND_H * 0.72 * scale, z + 0.25 * scale); entrance.material = this.hole;
    const queen = new Mesh(`queen${suffix}`, scene);
    buildAntGeometry(scene, rgb, false, 12).applyToMesh(queen, false);
    const mat = new StandardMaterial(`queen${suffix}`, scene);
    mat.diffuseColor = new Color3(1, 1, 1); mat.specularColor = new Color3(0.7, 0.65, 0.58); mat.specularPower = 80; queen.material = mat;
    queen.scaling.setAll(this.antLengthTiles * QUEEN_LENGTHS);
    queen.position.set(x + 0.35 * scale, y + (MOUND_H - 0.06) * scale, z - 0.2 * scale);
    const enemy = queens.find((other) => other.colony !== colony && other.lostTick === null);
    if (enemy) queen.rotation.y = Math.atan2(-(ty - enemy.y / SUB_TILE), enemy.x / SUB_TILE - tx);
    const meshes = [mound, rim, entrance, queen];
    for (const mesh of meshes) { mesh.isPickable = false; mesh.freezeWorldMatrix(); }
    this.casters.push(queen);
    return { meshes, rim: rimMat, x: q.x, y: q.y };
  }
}
