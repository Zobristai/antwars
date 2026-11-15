import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG, rulesConfig } from "../src/sim/config.ts";
import { newMatchConfig, withGridScale } from "../src/sim/gridScale.ts";
import { headerLine, parseLog } from "../src/sim/log.ts";
import { recordedHousePlan } from "./house-plan.ts";
import { playable } from "./playable.ts";
import { rules27Redesign } from "./rules27.ts";

// The frozen rules-27 redesign config is checked against the configs committed rules-27 recordings carry, not against
// today's live config, so the check stays valid once the live redesign config plays a later rules version. Those
// recordings predate the no-bot-moves rule, so they carry the config without localAnts.everyColony.
const RECORDINGS = ["test/replays/fixtures/scripted-redesign.jsonl", "test/sim/fixtures/house-plan/both-seated.jsonl",
  "test/sim/fixtures/house-plan/never-joined.jsonl"];

it.each(RECORDINGS)("the frozen rules-27 redesign config, as a new match, is the config %s recorded", file => {
  const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { rulesVersion: number; config: unknown };
  expect(header.rulesVersion).toBe(27);
  expect(newMatchConfig(recordedHousePlan(rules27Redesign()))).toEqual(header.config);
});

// The operator comparison configs and the code-level defaults used when no rules are named (rulesConfig with no name,
// and DEFAULT_CONFIG, which createMatch plays when given no config), keep every key and value they had at rules 27,
// read from a snapshot taken then, never from another config. Keys added later are allowed at any depth.
// Configuration level only: whether a server can still be started on them is not part of this check.
type Kind = "rulesConfig" | "newMatchConfig";
const NAMES = { default: undefined, v4: "v4", "count-marks": "count-marks" } as const;
const BASE = JSON.parse(readFileSync(new URL("./rules27-comparison-base.json", import.meta.url), "utf8")) as
  Record<Kind, Record<keyof typeof NAMES, unknown>> & { codeDefault: Record<"DEFAULT_CONFIG" | "createMatch", unknown> };

/** Every base array is still an array of its length, element by element; every base object is still a non-array object
 * holding every base key, value by value; every other base value is the same value. */
function expectKeeps(actual: unknown, base: unknown, path: string): void {
  if (Array.isArray(base)) {
    expect(Array.isArray(actual), `${path} is an array`).toBe(true);
    expect((actual as unknown[]).length, `${path} length`).toBe(base.length);
    base.forEach((value, i) => expectKeeps((actual as unknown[])[i], value, `${path}[${i}]`));
  } else if (base !== null && typeof base === "object") {
    expect(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${path} is an object`).toBe(true);
    for (const [key, value] of Object.entries(base)) {
      expect(Object.hasOwn(actual as object, key), `${path}.${key} present`).toBe(true);
      expectKeeps((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  } else expect(actual, path).toBe(base);
}

it.each(Object.keys(NAMES) as (keyof typeof NAMES)[])(
  "%s keeps its rules-27 config and records rules 27", label => {
    const config = rulesConfig(NAMES[label]);
    const configs: Record<Kind, unknown> = { rulesConfig: config, newMatchConfig: newMatchConfig(config) };
    for (const kind of ["rulesConfig", "newMatchConfig"] as const) {
      expectKeeps(configs[kind], BASE[kind][label], `${kind}(${label})`);
      expect(parseLog([headerLine(1, playable(configs[kind] as typeof config))]).header.rulesVersion).toBe(27);
    }
  });

it("DEFAULT_CONFIG, as written and as the grid-scale-2 config createMatch plays when given none, keeps its rules-27 config and records rules 27", () => {
  const configs = { DEFAULT_CONFIG, createMatch: withGridScale(DEFAULT_CONFIG) };
  for (const label of ["DEFAULT_CONFIG", "createMatch"] as const) {
    expectKeeps(configs[label], BASE.codeDefault[label], label);
    expect(parseLog([headerLine(1, playable(configs[label]))]).header.rulesVersion).toBe(27);
  }
});
