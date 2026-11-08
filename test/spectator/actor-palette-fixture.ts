/** Synthetic public recordings only: no simulator steps, joins or inference. */
import { rulesConfig } from "../../src/sim/config.ts";
import { playable } from "../playable.ts";
import { createMatch, newAnt } from "../../src/sim/map.ts";
import type { SimState } from "../../src/sim/types.ts";

export const PALETTE_BACKGROUNDS = ["neutral", "colony-0", "colony-1", "water"] as const;
export type PaletteBackground = typeof PALETTE_BACKGROUNDS[number];
export const PALETTE_POOL = { x: 2, y: 4, width: 60, height: 40 };

export function actorPaletteFixture(background: PaletteBackground): SimState {
  const config = playable({ ...rulesConfig("redesign"), startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] });
  const state: SimState = { ...createMatch(6006, config), ...(background === "water" ? {
    terrain: { mapId: "palette-pool", mapName: "Synthetic label pool", water: [PALETTE_POOL] },
  } : {}) };
  state.ants = []; state.agents = []; state.marks = []; state.tick = 100;
  state.owner.fill(background === "colony-0" ? 0 : background === "colony-1" ? 1 : -1);
  state.food.fill(0);
  for (const colony of [0, 1] as const) for (let seat = 0; seat < 4; seat++) {
    const index = colony * 4 + seat, id = `fixture-${index}`;
    const x = colony === 0 ? 17 : 47;
    const y = [10, 18, 30, 37][seat]!;
    const antId = index + 1;
    state.ants.push({ ...newAnt(config, antId, colony, x * 1000, y * 1000), caste: "soldier", squad: id });
    state.agents.push({ id, colony, joinSeq: index, modelLabel: `Hue ${index + 1}`, parentAgentId: null,
      squad: [antId], order: { kind: "hold" }, lastCallTick: 100, lastCommandTick: 100, idle: false, pendingEvents: [] });
    state.marks.push({ id: index + 1, agentId: id, colony,
      tileX: colony === 0 ? 22 : 42, tileY: y,
      words: [], verb: "GATHER", count: 12, laidTick: 95, steering: 0 });
  }
  for (const colony of [0, 1] as const) state.ants.push({ ...newAnt(config, 9 + colony, colony,
    (colony === 0 ? 10 : 54) * 1000, 24 * 1000), caste: "soldier" });
  // Ants cannot stand on water. The other three backgrounds cover all actors;
  // this open-water scene exercises every label hue wherever the real placer
  // puts it, without forcing a side or changing runtime layout. No sim runs.
  if (background === "water") {
    state.ants = [];
    for (const agent of state.agents) agent.squad = [];
  }
  return state;
}

export type Rgb = readonly number[];
export function contrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => rgb.slice(0, 3).reduce((n, v, i) => {
    const c = v / 255;
    return n + [0.2126, 0.7152, 0.0722][i]! * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(...a.slice(0, 3).map((v, i) => v - b[i]!));
}
export function rgb(colour: number): number[] {
  return [colour >> 16 & 255, colour >> 8 & 255, colour & 255];
}
/** Convex projected water quad; check actual label corners rather than its mark alone. */
export function inQuad(point: readonly number[], quad: readonly (readonly number[])[]): boolean {
  const signs = quad.map((a, i) => {
    const b = quad[(i + 1) % quad.length]!;
    return (b[0]! - a[0]!) * (point[1]! - a[1]!) - (b[1]! - a[1]!) * (point[0]! - a[0]!);
  });
  return signs.every(s => s >= 0) || signs.every(s => s <= 0);
}
