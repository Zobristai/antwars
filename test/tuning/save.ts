/**
 * Write a mid-battle checkpoint of a seated match (the tuning loop's reload point).
 * Run from the repository root; frontAgent needs type transforms:
 *   node --experimental-transform-types --no-warnings --import ./src/ts-resolve.mjs test/tuning/save.ts \
 *     [--map wide-plain] [--ants 768] [--seed 7] [--after 0] [--tape 200] [--out <file>]
 * Defaults: Wide Plain at 768 per side, seed 7, saved at the first death (as the rated
 * harness measures), with the seats' inputs for the next 200 ticks. Prints one JSON line.
 */
import { writeFileSync } from "node:fs";
import { recordCheckpoint } from "./checkpoint.js";
import { DEFAULT_START, playToBattle, startSeated } from "./seated.js";

const option = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const count = (name: string, fallback: number): number => {
  const value = Number(option(name) ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number`);
  return value;
};

const map = option("map") ?? DEFAULT_START.map, perSide = count("ants", DEFAULT_START.perSide), seed = count("seed", 7);
const after = count("after", 0), tape = count("tape", 200);
const out = option("out") ?? `tuning-checkpoint-${map}-${perSide}-${seed}.json`;

const match = startSeated({ map, perSide, seed });
playToBattle(match, after);
const tick = match.state.tick, ants = match.state.ants.length;
const text = recordCheckpoint(match, tape);
writeFileSync(out, text);
console.log(JSON.stringify({ out, map, perSide, seed, tick, ants, tapeTicks: (JSON.parse(text) as { inputs: unknown[] }).inputs.length, bytes: Buffer.byteLength(text) }));
