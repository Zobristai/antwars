import type { SimConfig } from "../src/sim/config.ts";

/**
 * A config as matches recorded before the no-bot-moves rule carry it: localAnts.everyColony absent, so a colony
 * with no active seat follows the house bot's plan and founding. Re-simulating those recordings still runs that
 * path, so tests of it pin this config; a new match never plays it.
 */
export function recordedHousePlan<T extends SimConfig>(config: T): T {
  if (config.localAnts?.everyColony !== true) return config;
  const { everyColony: _everyColony, ...localAnts } = config.localAnts;
  return { ...config, localAnts };
}
