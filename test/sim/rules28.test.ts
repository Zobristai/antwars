import { describe, expect, it } from "vitest";
import { foundQueen } from "../../src/sim/agents.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { firstHatchTicks, hatchIntervalOf, rulesVersionOf, type QueenBiteRules, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { activeQueens, buildGrid, createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { encodeMessage } from "../../src/live/format.js";
import { hatchOf, SpectatorRecorder, storesOf } from "../../src/live/model.js";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { renderRules } from "../../web/rules.js";
import { addAnt, emptyMatch, setOwner } from "./fixtures.js";
import { playable } from "../playable.ts";
import { rules27Redesign } from "../rules27.ts";

/** Rules-28 mechanisms on the rules-27 redesign config, so they are proven before, and independently of, any served config using them. */
function rules28(): SimConfig {
  const { hatchTiming: _timing, ...rest } = rules27Redesign();
  return { ...rest, rules28: true, hatchRate: { foodPerSecond: 2 }, hatchCost: 2,
    queenHp: { hp: 100_000, damagePerSecond: 10_000, regenHp: 1_000, regenIntervalTicks: 100, regenClearTiles: 3, shieldTicks: 3000 } };
}

/** Colony 1's queen at tile (21, 24), striking from tick 100, with no terrain or food in the way. */
function strikeScene(config: SimConfig = rules28()) {
  const scene: SimConfig = { ...config, terrain: undefined, foodLayout: undefined, foodPatches: [], startAnts: 0, combatGraceTicks: 0,
    queenHp: { ...config.queenHp!, shieldTicks: 0 } };
  const state = emptyMatch(100, scene);
  state.colonies[1].queens = [{ ...activeQueens(state.colonies[1])[0]!, queenX: tileCentre(21), queenY: tileCentre(24) }];
  const fight = (ticks: number) => { for (let t = 0; t < ticks; t += 1) { resolveCombat(state, buildGrid(state), state.tick, []); state.tick += 1; } };
  return { state, fight, queen: () => state.colonies[1].queens![0]! };
}

describe("rules-28 mechanisms, before any served config uses them", () => {
  it("hatch interval: one food rate per queen gives each caste its cost's time; rules 27 keeps its interval and multiplier", () => {
    expect([hatchIntervalOf(rules28(), "worker"), hatchIntervalOf(rules28(), "soldier")]).toEqual([10, 30]);
    const three = { ...rules28(), hatchRate: { foodPerSecond: 3 } };
    expect([hatchIntervalOf(three, "worker"), hatchIntervalOf(three, "soldier")]).toEqual([7, 20]);
    const rules27 = rules27Redesign();
    expect([hatchIntervalOf(rules27, "worker"), hatchIntervalOf(rules27, "soldier")]).toEqual([10, 20]);
  });

  it("a rules-28 queen strikes 1000 milli-HP every tick at the lowest-HP enemy in reach, lowest id on ties, and keeps no bite clock", () => {
    const { state, fight, queen } = strikeScene();
    expect(queen()).not.toHaveProperty("lastBiteTick");
    // Carriers do not strike back. Equal HP: the lower id is struck, every tick, the other untouched.
    const a = addAnt(state, 0, 20, 24, { hp: 5_000, carrying: true }), b = addAnt(state, 0, 22, 24, { hp: 5_000, carrying: true });
    fight(3);
    expect([a.hp, b.hp]).toEqual([2_000, 5_000]);
    expect(queen()).not.toHaveProperty("lastBiteTick");
    // Lower HP beats lower id: b is now struck while a, at more HP, waits.
    b.hp = 1_500;
    fight(1);
    expect([a.hp, b.hp]).toEqual([2_000, 500]);
  });

  it("a rules-28 queen reaches diagonals within the bite reach and nothing beyond it", () => {
    const { state, fight } = strikeScene();
    const reach = state.config.gridScale!;
    const diagonal = addAnt(state, 0, 21 + reach, 24 + reach, { hp: 5_000, carrying: true });
    const beyond = addAnt(state, 0, 21 + reach + 1, 24, { hp: 1_000, carrying: true });
    fight(2);
    expect([diagonal.hp, beyond.hp]).toEqual([3_000, 1_000]);
  });

  it("a rules-28 queen's strike has no own-ground bonus: her colony's tiles change nothing, while an ant there gets x1.25", () => {
    const { state, fight } = strikeScene();
    for (let x = 0; x < state.config.mapWidth; x += 1) for (let y = 0; y < state.config.mapHeight; y += 1) setOwner(state, x, y, 1);
    const struck = addAnt(state, 0, 20, 24, { hp: 9_000, carrying: true });
    fight(2);
    expect(struck.hp).toBe(7_000);
    // Control: an ant of her colony on its own ground deals x1.25 per tick.
    const enemy = addAnt(state, 0, 60, 60, { hp: 9_000, carrying: true }), biter = addAnt(state, 1, 61, 60, { hp: 9_000 });
    fight(1);
    expect(9_000 - enemy.hp).toBe(Math.trunc((Math.trunc(state.config.damagePerSecond / state.config.ticksPerSecond) * state.config.defenderBonusPermille) / 1000));
    expect(biter.hp).toBe(9_000);
  });

  it("a rules-27 queen still bites on her clock: 4 HP once every 2 s", () => {
    const { state, fight, queen } = strikeScene(rules27Redesign());
    const a = addAnt(state, 0, 20, 24, { hp: 20_000, carrying: true });
    fight(21);
    expect(a.hp).toBe(12_000);
    expect(queen().lastBiteTick).toBe(120);
  });

  it("a queen founded under rules 28 carries no bite fields; one founded under rules 27 does", () => {
    for (const [config, bite] of [[rules28(), false], [rules27Redesign(), true]] as const) {
      const state = emptyMatch(4_000, { ...config, terrain: undefined, foodLayout: undefined });
      state.colonies[0].foodStore = 1_000;
      setOwner(state, 64, 20, 0);
      expect(foundQueen(state, 0, 64, 20, state.tick, [])).toBeNull();
      const founded = state.colonies[0].queens![1]!;
      expect([founded.foundedTick, founded.lastHatchTick, founded.hp]).toEqual([4_000, 4_000, config.queenHp!.hp]);
      expect("lastBiteTick" in founded).toBe(bite);
      expect("lastBiteTick" in createMatch(7, newMatchConfig(config)).colonies[0].queens![0]!).toBe(bite);
    }
  });

  it("log headers carry 28 only with the rules28 marker; the replayer accepts 27 without it and 28 with it, and refuses every other pair", () => {
    const r28 = newMatchConfig(rules28()), r27 = newMatchConfig(rules27Redesign());
    expect([rulesVersionOf(r28), rulesVersionOf(r27)]).toEqual([28, 27]);
    expect(JSON.parse(headerLine(1, r28)).rulesVersion).toBe(28);
    expect(JSON.parse(headerLine(1, r27)).rulesVersion).toBe(27);
    expect(() => parseLog([headerLine(1, r28)])).not.toThrow();
    expect(() => parseLog([headerLine(1, r27)])).not.toThrow();
    const swap = (line: string, version: number) => JSON.stringify({ ...JSON.parse(line), rulesVersion: version });
    for (const version of [26, 27, 29]) expect(() => parseLog([swap(headerLine(1, r28), version)])).toThrow("is not 28");
    for (const version of [26, 28, 29]) expect(() => parseLog([swap(headerLine(1, r27), version)])).toThrow("is not 27");
  });

  it("the replayer refuses a present marker other than true, at either version", () => {
    const r27 = newMatchConfig(rules27Redesign());
    for (const marker of [false, null, 0, 1, "true", {}]) for (const version of [27, 28]) {
      const header = { ...JSON.parse(headerLine(1, r27)), rulesVersion: version, config: { ...r27, rules28: marker } };
      expect(() => parseLog([JSON.stringify(header)])).toThrow("match log header: rules28 must be true or absent");
    }
  });

  it("a config plays one rules generation whole: a mixed config is refused before it plays or replays", () => {
    const r27 = rules27Redesign(), r28 = rules28();
    const { hatchRate: _rate, ...noRate } = r28, { castes: _castes, ...noCastes } = r28;
    const mixed: readonly [string, SimConfig][] = [
      ["the marker on the rules-27 config", { ...r27, rules28: true }],
      ["the marker without a hatch rate", noRate],
      ["the marker with a biting queen", { ...r28, queenHp: r27.queenHp }],
      ["the marker with a striking queen that keeps the bite interval", { ...r28, queenHp: { ...r28.queenHp!, biteIntervalTicks: 20 } as SimConfig["queenHp"] }],
      ["the marker with a striking queen that keeps the bite damage", { ...r28, queenHp: { ...r28.queenHp!, biteDamage: 4_000 } as SimConfig["queenHp"] }],
      ["the marker with no queen HP", { ...r28, queenHp: undefined }],
      ["the marker without castes", noCastes],
      ["a hatch rate without the marker", { ...r27, hatchRate: { foodPerSecond: 2 } }],
      ["a striking queen without the marker", { ...r27, queenHp: r28.queenHp }],
      ["a biting queen that also strikes, without the marker", { ...r27, queenHp: { ...r27.queenHp!, damagePerSecond: 10_000 } as SimConfig["queenHp"] }],
      ["a queen with only the bite interval, without the marker", { ...r27, queenHp: (({ biteDamage: _damage, ...rest }) => rest)(r27.queenHp as QueenBiteRules) as SimConfig["queenHp"] }],
    ];
    const MIXED = /a rules-28 config needs|without the rules-28 marker plays rules 27/;
    const header = (config: SimConfig) => JSON.stringify({ ...JSON.parse(headerLine(1, newMatchConfig(r27))), config: newMatchConfig(config) });
    for (const [name, config] of mixed) {
      expect(() => createMatch(1, newMatchConfig(config)), name).toThrow(MIXED);
      expect(() => parseLog([header(config)]), name).toThrow(MIXED);
    }
    expect(() => createMatch(1, newMatchConfig(r28))).not.toThrow();
    expect(() => createMatch(1, newMatchConfig(r27))).not.toThrow();
  });

  it("a match played under the marker records version 28 and replays to identical state hashes", () => {
    const config = newMatchConfig(rules28());
    const inputs = (tick: number): SimInput[] => tick === 0 ? [{ type: "join", agentId: "a", modelLabel: "model-a" }, { type: "join", agentId: "b", modelLabel: "model-b" }] : [];
    const lines = [headerLine(5, config)];
    const hashes = new Map<number, string>();
    let state: SimState = createMatch(5, config), hatched = 0;
    while (state.tick < 400) {
      const now = inputs(state.tick);
      if (now.length > 0) lines.push(tickLine(state.tick, now));
      const out = step(state, now);
      hatched += out.events.filter(e => e.type === "hatch").length;
      state = out.state;
      if (state.tick % 50 === 0) hashes.set(state.tick, stateHash(state));
    }
    expect(JSON.parse(lines[0]!).rulesVersion).toBe(28);
    expect(hatched).toBeGreaterThan(0);
    const replayed = new Map<number, string>();
    const end = replay(lines, 400, s => { if (s.tick % 50 === 0) replayed.set(s.tick, stateHash(s)); });
    expect(replayed).toEqual(hashes);
    expect(stateHash(end)).toBe(stateHash(state));
  }, 30_000);

  it("the spawn rate alone sets the hatch clock: the old interval and soldier multiplier change neither the first hatches nor the streamed forecast", () => {
    const firstHatches = (config: SimConfig) => {
      let state = createMatch(7, newMatchConfig({ ...config, startAnts: 0 }));
      for (const colony of state.colonies) colony.foodStore = 200;
      const hatches: [number, number, string | undefined][] = [];
      while (state.tick < 60) {
        const out = step(state, []);
        for (const e of out.events as SimEvent[]) if (e.type === "hatch") hatches.push([e.tick, e.colony, e.caste]);
        state = out.state;
      }
      return hatches;
    };
    const baseline = firstHatches(rules28());
    expect(baseline[0]).toEqual([0, 0, expect.any(String)]);
    for (const old of [{ hatchIntervalTicks: 1 }, { hatchIntervalTicks: 100_000 }, { hatchTiming: { soldierIntervalMultiplier: 1 } }, { hatchTiming: { soldierIntervalMultiplier: 5 } }]) {
      const config = { ...rules28(), ...old };
      const state = createMatch(7, newMatchConfig(config));
      const queen = activeQueens(state.colonies[0])[0]!;
      expect([state.colonies[0].lastHatchTick, queen.lastHatchTick]).toEqual([-10, -10]);
      expect(hatchOf(state).intervalTicks).toBe(10);
      expect(storesOf(state).map(s => s.nextHatchTick)).toEqual([0, 0]);
      expect(firstHatchTicks(config)).toEqual({ worker: 0, soldier: 20 });
      expect(firstHatches(config)).toEqual(baseline);
      const rec = new SpectatorRecorder(state);
      expect(() => encodeMessage({ ...rec.initial(), full: rec.initialFull() })).not.toThrow();
    }
  });

  it("where a soldier's interval is shorter than a worker's, the starting queen's first soldier is due at tick 0, stated and streamed as tick 0", () => {
    // 8-food workers and 6-food soldiers at 2 food per second: a worker every 40 ticks, a soldier every 30.
    const config = { ...rules28(), hatchCost: 8, startAnts: 0 };
    expect([hatchIntervalOf(config, "worker"), hatchIntervalOf(config, "soldier")]).toEqual([40, 30]);
    expect(firstHatchTicks(config)).toEqual({ worker: 0, soldier: 0 });
    let state = createMatch(7, newMatchConfig(config));
    state = step(state, [{ type: "join", agentId: "a", colony: 0 }]).state;
    activeQueens(state.colonies[0])[0]!.brood = "soldiers";
    state.colonies[0].foodStore = 200;
    expect(storesOf(state)[0]).toMatchObject({ nextHatchTick: 0, nextCost: 6 });
    const rec = new SpectatorRecorder(state);
    expect(() => encodeMessage({ ...rec.initial(), full: rec.initialFull() })).not.toThrow();
    // She hatches her first soldier on the first step she can.
    const out = step(state, []);
    expect(out.events.filter(e => e.type === "hatch" && e.colony === 0).length).toBe(1);
    expect(briefing(playable(config))).toContain("her first soldier at tick 0");
  });

  it("the starting queen's first hatches come one worker interval early: worker at tick 0, soldier at tick 20 (rules 28)", () => {
    expect(firstHatchTicks(rules28())).toEqual({ worker: 0, soldier: 20 });
    expect(firstHatchTicks({ ...rules28(), hatchRate: { foodPerSecond: 3 } })).toEqual({ worker: 0, soldier: 13 });
    // An all-soldier brood: the first soldier hatches at tick 20, the next after one full soldier interval.
    let state = createMatch(7, newMatchConfig({ ...rules28(), startAnts: 0 }));
    state = step(state, [{ type: "join", agentId: "a", colony: 0 }]).state;
    activeQueens(state.colonies[0])[0]!.brood = "soldiers";
    state.colonies[0].foodStore = 200;
    // The streamed forecast says the same: her first soldier at tick 20 for 6 food.
    expect(storesOf(state)[0]).toMatchObject({ nextHatchTick: 20, nextCost: 6 });
    const soldiers: number[] = [];
    while (state.tick < 60) {
      const out = step(state, []);
      for (const e of out.events as SimEvent[]) if (e.type === "hatch" && e.colony === 0) soldiers.push(e.tick);
      state = out.state;
      if (state.tick === 21) expect(storesOf(state)[0]).toMatchObject({ nextHatchTick: 50, nextCost: 6 });
    }
    expect(soldiers).toEqual([20, 50]);
  });

  it("briefing and rules page state the one hatch rate and first hatches only under rules 28; rules-27 wording is unchanged", () => {
    const text = briefing(playable(rules28()));
    expect(text).toContain("each queen hatches at 2 food per second: a worker every 1 s (10 ticks), a soldier every 3 s (30 ticks); "
      + "the starting queen's first worker can hatch at tick 0 and her first soldier at tick 20");
    expect(text).not.toContain("hatch interval");
    const page = renderRules(newMatchConfig(rules28()));
    expect(page).toContain("Each queen hatches at 2 food per second: a worker every 1 second and a soldier every 3 seconds when food is available");
    expect(page).toContain("The starting queen&#39;s first worker can hatch at once (tick 0) and her first soldier after 2 seconds (tick 20)."); // the page escapes the apostrophe
    expect(page).not.toContain("hatch interval");
    // A leftover soldier multiplier is not stated under a hatch rate.
    expect(renderRules(newMatchConfig({ ...rules28(), hatchTiming: { soldierIntervalMultiplier: 5 } }))).toBe(page);
    expect(briefing(playable({ ...rules28(), hatchTiming: { soldierIntervalMultiplier: 5 } }))).toBe(text);
    const old = playable(rules27Redesign());
    expect(briefing(old)).toContain("a worker takes one hatch interval (1 s), a soldier takes 2 hatch intervals (2 s)");
    expect(briefing(old)).not.toContain("first worker can hatch");
    const oldPage = renderRules(newMatchConfig(rules27Redesign()));
    expect(oldPage).toContain("hatch a worker every 1 second when food is available");
    expect(oldPage).toContain("Each soldier takes 2 hatch intervals (2 seconds) at its own queen; workers take one interval.");
    expect(oldPage).not.toContain("first worker can hatch");
  });

  it("agent texts and the rules page say a rules-28 queen strikes, sentence by sentence, and never that she bites; rules-27 wording is unchanged", () => {
    // Sentences that say a queen bites. Ants still bite, including enemy queens; those sentences are allowed by name.
    const ANT_BITES = ["Ants carrying food do not bite enemy ants or queens", "Carriers never bite ants or queens",
      "bites an adjacent enemy queen at normal damage", "bites an adjacent enemy queen at its normal damage", "bite in reach; within", "bite adjacent enemies; one within",
      "Ant bite and queen strike reach is"];
    // Only the page is HTML: agent texts contain "<=" and "->", which are not tags.
    const queenBites = (text: string) => (text.startsWith("<!doctype") ? text.split(/<[^>]+>/) : [text]).flatMap(part => part.split(/\n|(?<=\.)\s+/)).map(s => s.trim())
      .filter(s => /queen/i.test(s) && /\bbit(e|es|ing)\b/i.test(s) && !ANT_BITES.some(allowed => s.includes(allowed)));
    const texts = (config: SimConfig) => {
      const compact = playable(config), full = playable({ ...config, countMarks: { ...config.countMarks!, combatTotals: undefined } });
      const contact = playable({ ...config, pointArrival: undefined });
      return { compact: briefing(compact), full: briefing(full), contact: briefing(contact), join: joinBriefing(compact), page: renderRules(newMatchConfig(config)) };
    };
    const now = texts(rules28());
    expect(now.compact).toContain("- Queens with HP: 100 HP; strike one adjacent enemy for 10 HP/s from 60 s.");
    expect(now.full).toContain("- Queens with HP: each queen has 100 HP and strikes one adjacent enemy for 10 HP per second (from 60 s).");
    for (const text of [now.compact, now.full]) expect(text).toContain("Ant bite and queen strike reach is 2 tiles, including diagonals: one original-size tile's distance.");
    expect(now.contact).toContain("incl. diagonals; combat/queen-strike reach unchanged.");
    expect(now.join).toContain("Kills = enemy ant deaths, including queen strikes.");
    expect(now.page).toContain("A queen strikes one adjacent enemy for 10 HP per second, starting at 60 seconds.");
    expect(now.page).toContain("Kills count enemy ants killed by the colony, including queen strikes.");
    expect(now.page).toContain("Ant bite and queen strike reach is 2 tiles, including diagonals: one original-size tile&#39;s distance."); // the page escapes the apostrophe
    for (const [name, text] of Object.entries(now)) expect(queenBites(text), name).toEqual([]);
    const old = texts(rules27Redesign());
    expect(old.compact).toContain("- Queens with HP: 40 HP; bite one adjacent enemy for 4 HP/2 s from 60 s.");
    expect(old.full).toContain("- Queens with HP: each queen has 40 HP and bites one adjacent enemy for 4 HP every 2 s (from 60 s).");
    expect(old.contact).toContain("incl. diagonals; combat/queen-bite reach unchanged.");
    expect(old.join).toContain("Kills = enemy ant deaths, including queen bites.");
    expect(old.page).toContain("A queen bites one adjacent enemy for 4 HP every 2 seconds, starting at 60 seconds.");
    expect(old.page).toContain("Kills count enemy ants killed by the colony, including queen bites.");
    for (const text of [old.compact, old.full, old.page]) expect(text).toContain("Ant and queen bite reach is 2 tiles");
    for (const [name, text] of Object.entries(old)) expect(queenBites(text).length, name).toBeGreaterThan(0);
  });
});
