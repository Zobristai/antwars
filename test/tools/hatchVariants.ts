import { SOLDIER_HATCH_TIMING, type SimConfig } from "../../src/sim/config.js";

/** Paired verification only: unchanged-main timing or the chosen live rule. */
export const HATCH_ARMS = ["main", "A"] as const;
export type HatchArm = (typeof HATCH_ARMS)[number];

export function parseHatchArm(value: string): HatchArm {
  if (value === "main" || value === "A") return value;
  throw new Error(`--hatch-arm must be main or A; got ${JSON.stringify(value)}`);
}

export function selectHatchArm(config: SimConfig, arm: HatchArm): SimConfig {
  if (arm === "A") return { ...config, hatchTiming: SOLDIER_HATCH_TIMING };
  const { hatchTiming: _timing, ...historical } = config;
  return historical;
}
