/**
 * Mid-battle checkpoints: a seated match's full SimState at one tick, plus the
 * inputs its seats sent over the following tape ticks while the original match
 * continued. A reload replays that tape under server policy, as server logs
 * replay, so the scripted seats' memory never needs saving.
 */
import { holdBehaviour, parseHoldBehaviour } from "../../src/sim/holdBehaviour.js";
import { advance } from "../../src/sim/step.js";
import type { SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { namedColonyAllocator } from "../benchmark/match.js";
import { tickSeated, type SeatedMatch } from "./seated.js";

const FORMAT = "antwar-tuning-checkpoint/1";

/**
 * Save the match's state now, then continue it tapeTicks ticks (fewer if it ends),
 * recording its seats' inputs; onTick sees each continuing tick. Returns the checkpoint text.
 */
export function recordCheckpoint(match: SeatedMatch, tapeTicks: number, onTick?: (out: StepOutput) => void): string {
  if (match.state.result !== null) throw new Error("match has ended");
  // The hold behaviour is saved beside the state.
  const head = `{"format":${JSON.stringify(FORMAT)},"holdBehaviour":${JSON.stringify(holdBehaviour(match.state.config))},"state":${JSON.stringify(match.state)}`;
  const tape: (readonly SimInput[])[] = [];
  while (tape.length < tapeTicks && match.state.result === null) {
    const out = tickSeated(match);
    tape.push(out.inputs);
    onTick?.(out);
  }
  return `${head},"inputs":${JSON.stringify(tape)}}`;
}

export interface Checkpoint { readonly state: SimState; readonly inputs: readonly (readonly SimInput[])[] }

/** A fresh SimState from checkpoint text, whose hold behaviour must be the one every match plays. */
export function loadCheckpoint(text: string): Checkpoint {
  const saved = JSON.parse(text) as { format?: unknown; holdBehaviour?: unknown; state: SimState; inputs: SimInput[][] };
  if (saved.format !== FORMAT) throw new Error(`not a ${FORMAT} checkpoint`);
  parseHoldBehaviour(saved.holdBehaviour);
  return { state: saved.state, inputs: saved.inputs };
}

/** Advance the checkpoint's state in place by one server-policy tick with tape entry index. */
export function advanceCheckpoint(cp: Checkpoint, index: number): StepOutput {
  const inputs = cp.inputs[index];
  if (inputs === undefined) throw new RangeError(`tape index ${index} outside 0..${cp.inputs.length - 1}`);
  return advance(cp.state, inputs, namedColonyAllocator, undefined, undefined, false, true);
}
