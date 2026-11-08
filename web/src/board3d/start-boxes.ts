/** Terrain-following start-box borders. Coordinates remain in the streamed fine grid. */
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { visibleStartBoxes, type StartBoxSetup, type VisibleStartBox } from "../start-boxes.ts";
import type { Ground } from "./ground.ts";
import { gridScale } from "../grid-scale.ts";

/** Minimum coverage on the actual render buffer, not CSS/device pixels. */
export const OPENING_OUTLINE_PIXELS = 2;
export interface OutlineProjection {
  /** Changes with the view, viewport or render resolution; unchanged inputs reuse geometry. */
  key: string;
  project(tx: number, ty: number): readonly [number, number];
}

/** Match the existing portrait/landscape layout boundary, without changing those layouts. */
export function phoneOpeningOutline(w: number, h: number, opening: boolean): boolean {
  return opening && (w <= 700 || h <= 500);
}

/** An inward ribbon's thinnest perpendicular projected span along all four edges. */
export function projectedOutlineWidth(box: VisibleStartBox, width: number, project: OutlineProjection["project"]): number {
  let min = Infinity;
  const sample = (x: number, y: number, dx: number, dy: number, nx: number, ny: number) => {
    const a = project(x, y), tangent = project(x + dx, y + dy), inside = project(x + nx * width, y + ny * width);
    const tx = tangent[0] - a[0], ty = tangent[1] - a[1];
    const length = Math.hypot(tx, ty);
    const span = Math.abs(tx * (inside[1] - a[1]) - ty * (inside[0] - a[0])) / length;
    min = Math.min(min, Number.isFinite(span) ? span : 0);
  };
  for (let x = 0; x <= box.width; x++) {
    sample(box.x + x, box.y, 1, 0, 0, 1);
    sample(box.x + x, box.y + box.height, 1, 0, 0, -1);
  }
  for (let y = 0; y <= box.height; y++) {
    sample(box.x, box.y + y, 0, 1, 1, 0);
    sample(box.x + box.width, box.y + y, 0, 1, -1, 0);
  }
  return min;
}

/** Increase only inward stroke width. One box-wide value keeps its corners connected. */
export function openingOutlineWidth(box: VisibleStartBox, base: number, projection: OutlineProjection): number {
  const cap = Math.min(box.width, box.height) / 2;
  let width = base;
  for (let i = 0; i < 4; i++) {
    const pixels = projectedOutlineWidth(box, width, projection.project);
    if (pixels >= OPENING_OUTLINE_PIXELS || width >= cap) break;
    // A degenerate/edge-on user view cannot be repaired by widening the whole rectangle.
    if (pixels <= 1e-6) return base;
    width = Math.min(cap, width * OPENING_OUTLINE_PIXELS / pixels * 1.05);
  }
  return width;
}

export class StartBoxes3D {
  readonly meshes: readonly [Mesh, Mesh];
  boxes: readonly VisibleStartBox[] = [];
  private setup: StartBoxSetup | undefined;
  private projectionKey: string | undefined;

  constructor(scene: Scene, private readonly ground: Pick<Ground, "heightAt">,
    colonyRgb: readonly (readonly number[])[]) {
    this.meshes = [0, 1].map((colony) => {
      const mesh = new Mesh(`start-box-${colony}`, scene);
      const rgb = colonyRgb[colony]!;
      const material = new StandardMaterial(`start-box-${colony}`, scene);
      material.emissiveColor = new Color3(rgb[0]!, rgb[1]!, rgb[2]!);
      material.disableLighting = true;
      material.backFaceCulling = false;
      material.alpha = 0.85;
      mesh.material = material;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      return mesh;
    }) as [Mesh, Mesh];
  }

  update(frame: { board: { setup: StartBoxSetup } | null }, projection?: OutlineProjection): void {
    const setup = frame.board?.setup;
    if (setup === this.setup && projection?.key === this.projectionKey) return;
    this.setup = setup;
    this.projectionKey = projection?.key;
    this.boxes = visibleStartBoxes(setup);
    for (const mesh of this.meshes) mesh.setEnabled(false);
    if (!setup) return;
    const scale = gridScale(setup);
    for (const box of this.boxes) {
      const positions: number[] = [], indices: number[] = [];
      const rise = 0.035 * scale;
      const strip = (x: number, y: number, width: number, height: number): void => {
        const start = positions.length / 3;
        for (const [tx, ty] of [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]) {
          positions.push(tx!, this.ground.heightAt(tx!, ty!) + rise, setup.mapH - ty!);
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      };
      // Sample each fine-tile edge so a long flat quad never cuts through the ground.
      const baseWidth = Math.min(0.16 * scale, box.width / 2, box.height / 2);
      const width = projection ? openingOutlineWidth(box, baseWidth, projection) : baseWidth;
      for (let dx = 0; dx < box.width; dx++) {
        strip(box.x + dx, box.y, 1, width);
        strip(box.x + dx, box.y + box.height - width, 1, width);
      }
      for (let dy = 0; dy < box.height; dy++) {
        strip(box.x, box.y + dy, width, 1);
        strip(box.x + box.width - width, box.y + dy, width, 1);
      }
      const data = new VertexData();
      data.positions = positions;
      data.indices = indices;
      data.applyToMesh(this.meshes[box.colony], true);
      this.meshes[box.colony].setEnabled(true);
    }
  }
}
