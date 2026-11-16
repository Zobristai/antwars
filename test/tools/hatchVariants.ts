import { SOLDIER_HATCH_TIMING, type SimConfig } from "../../src/sim/config.js";
import { rules27Redesign } from "../rules27.ts";

/**
 * Paired verification only: unchanged-main soldier timing (one hatch interval) or the rules-27 rule (two intervals).
 * Both arms are rules-27 timings. Under the rules-28 spawn rate a soldier's hatch time follows from her cost, so
 * neither arm would change play there; the arms therefore run on the frozen rules-27 redesign config.
 */
export const HATCH_ARMS = ["main", "A"] as const;
export type HatchArm = (typeof HATCH_ARMS)[number];

export function parseHatchArm(value: string): HatchArm {
  if (value === "main" || value === "A") return value;
  throw new Error(`--hatch-arm must be main or A; got ${JSON.stringify(value)}`);
}

export function selectHatchArm(config: SimConfig, arm: HatchArm): SimConfig {
  if (config.hatchRate !== undefined) throw new Error("hatch arms are rules-27 soldier timings; this config hatches at the rules-28 spawn rate, where neither arm changes play");
  if (arm === "A") return { ...config, hatchTiming: SOLDIER_HATCH_TIMING };
  const { hatchTiming: _timing, ...historical } = config;
  return historical;
}

/** What a sweep plays: the committed redesign with no arm named; with an arm, that arm on the frozen rules-27 redesign. */
export function hatchArmConfig(committed: SimConfig, arm: HatchArm | null): SimConfig {
  return arm === null ? committed : selectHatchArm(rules27Redesign(), arm);
}

/** The run's label for reports. */
export function hatchArmLabel(arm: HatchArm | null): string {
  return arm === null ? "none (committed rules)" : `${arm} (rules-27 redesign)`;
}
