/** Team-coloured start-box edges on the same fine-tile plane as the 2D board. */
import { Graphics } from "pixi.js";
import { COLONY_TINT } from "./ants.ts";
import { visibleStartBoxes, type StartBoxSetup, type VisibleStartBox } from "./start-boxes.ts";

export class StartBoxes2D {
  readonly layer = new Graphics();
  boxes: readonly VisibleStartBox[] = [];
  constructor(private tilePx: number) {}

  setTilePx(tilePx: number): void { this.tilePx = tilePx; }

  update(frame: { board: { setup: StartBoxSetup } | null }): void {
    const g = this.layer;
    g.clear();
    this.boxes = visibleStartBoxes(frame.board?.setup);
    for (const box of this.boxes) {
      const { x, y, width, height, colony } = box;
      g.rect(x, y, width, height).fill({ color: COLONY_TINT[colony], alpha: 0.035 });
      // An inside stroke keeps the visible edge within the exact streamed rectangle.
      g.rect(x, y, width, height).stroke({ color: 0x080706, alpha: 0.75, width: 4 / this.tilePx, alignment: 1 });
      g.rect(x, y, width, height).stroke({ color: COLONY_TINT[colony], alpha: 0.85, width: 2 / this.tilePx, alignment: 1 });
    }
  }
}
