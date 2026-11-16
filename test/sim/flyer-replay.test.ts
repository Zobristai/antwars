import { describe, expect, it } from "vitest";
import { recordLog } from "../../src/live/record.js";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimInput, SimState } from "../../src/sim/types.js";

/**
 * Matches with flyers play and record under rules version 28 and replay exactly; configurations
 * that keep rules 27 have no flyers. The committed rules-27 recordings' replays are pinned where they are recorded
 * (test/replays/recordings-across-change.test.ts, recording-goldens.test.ts, pre-compression-replays.test.ts).
 */

/** Open Field, which breeds flyers quickly on its own economy. */
const SEED = 8;
const TICKS = 600;

/** Both colonies seated at match start and breeding flyers; colony 1 switches back to mixed halfway. */
const SCRIPT = new Map<number, readonly SimInput[]>([
  [0, [
    { type: "join", agentId: "a", placement: 0, queenId: 0 }, { type: "join", agentId: "b", placement: 1, queenId: 0 },
    { type: "set_brood", agentId: "a", brood: "flyers" }, { type: "set_brood", agentId: "b", brood: "flyers" },
  ]],
  [150, [{ type: "observe", agentId: "a" }, { type: "count_mark", agentId: "b", verb: "DEFEND", count: 3 }]],
  [300, [{ type: "set_brood", agentId: "b", brood: "mixed" }]],
]);

/** Play the script as the server does, writing the match log, and keep the state hash after every tick. */
function played(config: SimConfig): { lines: string[]; hashes: string[]; state: SimState } {
  let state = createMatch(SEED, config);
  const lines = [headerLine(SEED, config)];
  const hashes: string[] = [];
  while (state.tick < TICKS) {
    const inputs = SCRIPT.get(state.tick) ?? [];
    if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
    state = step(state, inputs).state;
    hashes.push(stateHash(state));
  }
  return { lines, hashes, state };
}

describe("a match with flyers", () => {
  const config = newMatchConfig(rulesConfig("redesign"));
  const match = played(config);

  it("plays under rules version 28, breeding flyers in both colonies", () => {
    expect(JSON.parse(match.lines[0]!)).toMatchObject({ type: "header", rulesVersion: 28, config });
    expect(parseLog(match.lines).header.config.flyers).toEqual(config.flyers);
    const flyers = (colony: 0 | 1) => match.state.ants.filter((ant) => ant.colony === colony && ant.flyer === true).length;
    expect(flyers(0)).toBeGreaterThanOrEqual(5);
    expect(flyers(1)).toBeGreaterThanOrEqual(3);
  });

  it("replays from its match log to identical state hashes after every tick", () => {
    const replayed: string[] = [];
    replay(match.lines, TICKS, (state) => { replayed.push(stateHash(state)); });
    expect(replayed).toHaveLength(TICKS);
    expect(replayed).toEqual(match.hashes);
  }, 60_000);

  it("records to the spectator stream from its match log, one message per tick", () => {
    expect(recordLog(match.lines, TICKS)).toHaveLength(TICKS + 1);
  }, 60_000);
});

describe("configurations that keep rules 27", () => {
  it("have no flyers and record rules version 27", () => {
    const kept: Record<string, SimConfig> = {
      "code default": DEFAULT_CONFIG, "rules unset in code": rulesConfig(undefined), v4: rulesConfig("v4"), "count-marks": rulesConfig("count-marks"),
    };
    expect(kept["rules unset in code"]).toBe(PUBLIC_CONFIG);
    for (const [name, config] of Object.entries(kept)) {
      expect(config.flyers, name).toBeUndefined();
      expect(JSON.parse(headerLine(SEED, config)).rulesVersion, name).toBe(27);
    }
  });
});
