// What a regen or exact job still has to produce for one scenario and tick path. Pure, unit-tested.

export interface Pending {
  /** The exactness reference is missing and must be written. */
  readonly reference: boolean;
  /** Saved-state ticks still missing; they are written whether or not the reference already exists. */
  readonly states: readonly number[];
}

export function pendingWork(referenceExists: boolean, wantedStates: readonly number[], stateExists: (tick: number) => boolean): Pending {
  return { reference: !referenceExists, states: wantedStates.filter(tick => tick > 0 && !stateExists(tick)) };
}
