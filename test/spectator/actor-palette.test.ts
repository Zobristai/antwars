import { describe, expect, it } from "vitest";
import { actorPaletteFixture, PALETTE_BACKGROUNDS, PALETTE_POOL, contrast, inQuad, rgb } from "./actor-palette-fixture.ts";
import { agentShade } from "../../web/src/squads.ts";
import { asTwoColony } from "../../src/sim/types.ts";
import { COLONY_TINT } from "../../web/src/ants.ts";
import { COLONY_RGB } from "../../web/src/territory.ts";
import { COLONY_RGB as COLONY_3D } from "../../web/src/board3d/ground.ts";

// These are fixture/palette consistency gates, not replacements for the browser
// harness's rendered pixels, retained stills or a final-tip browser matrix.
describe("actor palette background coverage", () => {
  for (const background of PALETTE_BACKGROUNDS) it(`covers all label hues and the applicable land actors on ${background}`, () => {
    const state = actorPaletteFixture(background);
    expect(state.agents).toHaveLength(8);
    expect(state.marks).toHaveLength(8);
    expect(state.ants).toHaveLength(background === "water" ? 0 : 10);
    expect(state.ants.filter(a => a.squad === null).map(a => a.colony)).toEqual(background === "water" ? [] : [0, 1]);
    expect(new Set(state.agents.map((a, i) => agentShade(a.colony, i, state.agents.map((agent) => ({ colony: asTwoColony(agent.colony) }))))).size).toBe(8);
    expect(new Set(state.owner)).toEqual(new Set([background === "colony-0" ? 0 : background === "colony-1" ? 1 : -1]));
    if (background === "water") {
      const p = PALETTE_POOL;
      const wet = (x: number, y: number) => x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height;
      expect(state.terrain?.water).toEqual([p]);
      expect(state.marks.every(m => wet(m.tileX, m.tileY))).toBe(true);
      expect(state.agents.every(a => a.squad.length === 0)).toBe(true);
    } else expect(state.terrain).toBeUndefined();
  });
  it("keeps both normalized ground tints coherent with the free-ant colours", () => {
    for (const c of [0, 1] as const) {
      expect(COLONY_RGB[c].map(n => Math.round(n * 255))).toEqual(rgb(COLONY_TINT[c]));
      expect(COLONY_3D[c].map(n => Math.round(n * 255))).toEqual(rgb(COLONY_TINT[c]));
    }
  });
  it("rejects a label corner outside the projected water, regardless of winding", () => {
    const quad = [[0, 0], [20, 2], [18, 20], [2, 18]];
    for (const q of [quad, [...quad].reverse()]) {
      expect(inQuad([10, 10], q)).toBe(true);
      expect(inQuad([-1, 10], q)).toBe(false);
      expect(inQuad([19, 19], q)).toBe(false);
    }
  });
  it("contrast catches missing ink, accepts black/white and ignores alpha bytes", () => {
    expect(contrast([30, 40, 50], [30, 40, 50])).toBe(1);
    expect(contrast([255, 255, 255, 255], [0, 0, 0, 255])).toBe(21);
  });
});
