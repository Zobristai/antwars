import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/sim/config.js";
import { addAnt, antById, emptyMatch, run, setOwner } from "./fixtures.js";

describe("attrition combat", () => {
  it("does no damage in the first 60 s, then 1 HP per second", () => {
    const state = emptyMatch(0);
    const a = addAnt(state, 0, 30, 10);
    const b = addAnt(state, 1, 31, 10);
    const quiet = run(state, 600).state;
    expect(quiet.tick).toBe(600);
    expect(antById(quiet, a.id)?.hp).toBe(4000);
    expect(antById(quiet, b.id)?.hp).toBe(4000);
    const fighting = run(quiet, 10).state;
    expect(antById(fighting, a.id)?.hp).toBe(3000);
    expect(antById(fighting, b.id)?.hp).toBe(3000);
  });

  it("hits the adjacent enemy with the lowest HP and never splits damage", () => {
    const state = emptyMatch(600);
    const attacker = addAnt(state, 0, 30, 10, { hp: 50000 });
    const strong = addAnt(state, 1, 31, 10, { hp: 4000 });
    const weak = addAnt(state, 1, 31, 11, { hp: 2000 });
    const after = run(state, 1).state;
    expect(antById(after, weak.id)?.hp).toBe(1900);
    expect(antById(after, strong.id)?.hp).toBe(4000);
    expect(antById(after, attacker.id)?.hp).toBe(50000 - 200);
  });

  it("hits the lowest id among equally weak enemies", () => {
    const state = emptyMatch(600);
    addAnt(state, 0, 30, 10, { hp: 50000 });
    const first = addAnt(state, 1, 31, 11, { hp: 3000 });
    const second = addAnt(state, 1, 31, 10, { hp: 3000 });
    const after = run(state, 1).state;
    expect(antById(after, first.id)?.hp).toBe(2900);
    expect(antById(after, second.id)?.hp).toBe(3000);
  });

  it("deals 1.25 times damage on its own colony's territory", () => {
    const state = emptyMatch(600);
    const defender = addAnt(state, 0, 30, 10);
    const attacker = addAnt(state, 1, 31, 10);
    setOwner(state, 30, 10, 0);
    const after = run(state, 4).state;
    expect(antById(after, attacker.id)?.hp).toBe(4000 - 4 * 125);
    expect(antById(after, defender.id)?.hp).toBe(4000 - 4 * 100);
  });

  it("lands all damage in a tick together, so two ants can kill each other", () => {
    const state = emptyMatch(600);
    const a = addAnt(state, 0, 30, 10, { hp: 100 });
    const b = addAnt(state, 1, 31, 10, { hp: 100 });
    const { state: after, events } = run(state, 1);
    expect(after.ants).toHaveLength(0);
    const deaths = events.filter((e) => e.type === "death").map((e) => (e.type === "death" ? e.antId : 0));
    expect(deaths.sort()).toEqual([a.id, b.id].sort());
  });

  it("lets a group twice the size win on neutral ground with survivors, and no hit uses the bonus", () => {
    // Isolate non-carrier attrition: food would send rules-25 carriers home mid-fight.
    const state = emptyMatch(600, { ...DEFAULT_CONFIG, foodPatches: [], foodLayout: undefined, corpseFood: 0 });
    const big: number[] = [];
    const small: number[] = [];
    for (let y = 20; y < 26; y += 1) {
      small.push(addAnt(state, 1, 31, y).id);
      big.push(addAnt(state, 0, 30, y).id);
      big.push(addAnt(state, 0, 32, y).id);
    }
    const { state: after } = run(state, 400);
    const alive = (ids: number[]): number => ids.filter((id) => antById(after, id) !== undefined).length;
    expect(alive(small)).toBe(0);
    expect(alive(big)).toBeGreaterThan(0);
    expect(after.stats.bonusHits).toEqual([0, 0]);
  });
});
