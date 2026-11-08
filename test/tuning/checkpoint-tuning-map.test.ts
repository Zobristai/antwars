/**
 * Tuning-map save and reload: a seated match on the tuning map at a chosen per-side count is
 * saved and reloaded, and every tick after reload gives the same full simulation state, events and results, compared
 * with keys sorted, as the original match continuing from that tick. Wide Plain at 768 per side remains the loop's
 * default start.
 *
 * The counts here are 35 per side or fewer:
 * large-count tuning-map starts are proved by the "Tuning map start population" tests.
 */
import { describe, expect, it } from "vitest";
import { createMatch } from "../../src/sim/map.js";
import { TUNING_MAP_ID } from "../../src/sim/tuningMap.js";
import type { StepOutput } from "../../src/sim/types.js";
import { advanceCheckpoint, loadCheckpoint, recordCheckpoint } from "./checkpoint.js";
import { compareTicks, sortedJson } from "./equality.js";
import { DEFAULT_START, playToBattle, startConfig, startSeated, tickSeated } from "./seated.js";

const SEED = 7;
/** Ticks recorded after the save: more than one try of about 50 ticks. */
const TAPE_TICKS = 60;
/** The save is taken this many ticks after the first death, so the battle is under way. */
const AFTER_FIRST_DEATH = 20;

const perColony = (out: { state: StepOutput["state"] }, colony: 0 | 1): number => out.state.ants.filter(ant => ant.colony === colony).length;

describe("the loop's default start", () => {
  it("is still Wide Plain at 768 per side", () => {
    expect(DEFAULT_START).toEqual({ map: "wide-plain", perSide: 768 });
    const state = createMatch(SEED, startConfig(DEFAULT_START.map, DEFAULT_START.perSide));
    expect([state.terrain?.mapId, state.config.colonyCap]).toEqual(["wide-plain", 768]);
  });

  it("refuses an unknown map", () => {
    expect(() => startConfig("no-such-map", 24)).toThrow();
  });
});

describe("a seated tuning-map match", () => {
  it.each([1, 24, 35])("at %i per side starts at that count on the tuning map, with a seat joined on each colony at tick 0", perSide => {
    const match = startSeated({ map: TUNING_MAP_ID, perSide, seed: SEED });
    expect([match.state.tick, match.state.terrain?.mapId, match.state.config.colonyCap]).toEqual([0, TUNING_MAP_ID, perSide]);
    expect([perColony(match, 0), perColony(match, 1)]).toEqual([perSide, perSide]);
    const first = tickSeated(match);
    expect(first.inputs.filter(input => input.type === "join").map(input => input.agentId)).toEqual(["a0", "a1"]);
    expect(match.state.agents.map(agent => [agent.id, agent.colony])).toEqual([["a0", 0], ["a1", 1]]);
  });

  it("at 24 per side, saved mid-battle and reloaded, gives every tick the original continuing from the save gives", () => {
    const perSide = 24;
    const match = startSeated({ map: TUNING_MAP_ID, perSide, seed: SEED });
    playToBattle(match, AFTER_FIRST_DEATH);
    const savedTick = match.state.tick, saved = sortedJson(match.state);
    // The original continues with its live seats; each tick's output is copied before the next tick changes it.
    const original: StepOutput[] = [];
    const text = recordCheckpoint(match, TAPE_TICKS, out => {
      original.push(JSON.parse(JSON.stringify({ state: out.state, events: out.events, results: out.results })) as StepOutput);
    });
    expect(original).toHaveLength(TAPE_TICKS);
    // Mid-battle with the seats playing: ants die and the seats observe inside the tape.
    expect(original.some(out => out.events.some(event => event.type === "death"))).toBe(true);
    expect(original.some(out => out.results.length > 0)).toBe(true);

    const reloaded = loadCheckpoint(text);
    expect([reloaded.state.tick, sortedJson(reloaded.state) === saved]).toEqual([savedTick, true]);
    const mismatches = original.map((expected, i) => compareTicks(expected, advanceCheckpoint(reloaded, i))).filter(m => m !== null);
    expect(mismatches).toEqual([]);
    expect(reloaded.state.tick).toBe(savedTick + TAPE_TICKS);
  }, 60_000);
});
