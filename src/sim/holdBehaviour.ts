import type { SimConfig } from "./config.js";

/**
 * The assignment and food-hold behaviour every match plays. Log headers, game saves and match
 * records still name it, so a file of any other behaviour is refused (older behaviours were removed).
 */
export type HoldBehaviour = "ant115";

export const HOLD_BEHAVIOUR: HoldBehaviour = "ant115";

/** The behaviour a config plays: always HOLD_BEHAVIOUR (web/capture records it in canonical log copies). */
export function holdBehaviour(_config: SimConfig): HoldBehaviour {
  return HOLD_BEHAVIOUR;
}

export function parseHoldBehaviour(value: unknown): HoldBehaviour {
  if (value !== HOLD_BEHAVIOUR) throw new Error(`holdBehaviour must be ${HOLD_BEHAVIOUR}`);
  return value;
}
