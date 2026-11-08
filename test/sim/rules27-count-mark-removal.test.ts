import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { cloneState, createMatch, newAnt } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { Agent, Ant, InputError, SimEvent, SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { addAnt } from "./fixtures.js";

// Rules-27 REMOVE, a count_mark verb carrying markId.

// Pinned to rules 26: rules 27 is now the new-match default.
const RULES27: SimConfig = rulesConfig("redesign");

function agent(id: string, tick: number): Agent {
  return { id, colony: 0, joinSeq: id === "a" ? 0 : 1, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: tick, lastCommandTick: null, idle: false, pendingEvents: [] };
}

/** Open field at the live grid scale; seats a and b on colony 0 (queen at tile 16,49). No squads, no hatching. */
function scene(config: SimConfig = RULES27, patch: Partial<SimConfig> = {}): SimState {
  const state = createMatch(4530, newMatchConfig({ ...config, startAnts: 0, squadSize: 0, hatchIntervalTicks: 1_000_000,
    terrain: { ...config.terrain!, mapId: "open-field" }, ...patch }));
  state.ants = [];
  state.tick = 1000; // past the opening combat delay
  state.agents.push(agent("a", state.tick), agent("b", state.tick));
  return state;
}

const lay = (agentId: string, tileX: number, tileY: number, verb: string, count: number, caste?: string): SimInput =>
  ({ type: "count_mark", agentId, tileX, tileY, verb, count, ...(caste === undefined ? {} : { caste }) });
const remove = (markId: unknown, agentId = "a"): SimInput => ({ type: "count_mark", agentId, verb: "REMOVE", count: 0, markId } as SimInput);
const errorOf = (out: StepOutput, i = 0): InputError | null => { const result = out.results[i]!; return result.ok ? null : result.error; };
const antOf = (state: SimState, id: number): Ant => state.ants.find(ant => ant.id === id)!;
const markAt = (state: SimState, tileX: number, tileY: number) => state.marks.find(mark => mark.tileX === tileX && mark.tileY === tileY)!;

function run(state: SimState, ticks: number, onTick?: (state: SimState) => void): SimState {
  for (let t = 0; t < ticks; t++) {
    state = step(state).state;
    onTick?.(state);
  }
  return state;
}

/**
 * The same state with one claimed ant replaced by a never-claimed one: a fresh
 * ant at its spot, keeping only its identity, caste, health, load, role and motion.
 */
function neverClaimed(state: SimState, claimed: Ant): SimState {
  const twin = cloneState(state);
  const i = twin.ants.findIndex(ant => ant.id === claimed.id);
  const { hp, carrying, role, vx, vy, lastTargetId, caste } = claimed;
  twin.ants[i] = { ...newAnt(twin.config, claimed.id, claimed.colony, claimed.x, claimed.y, caste), hp, carrying, role, vx, vy, lastTargetId };
  return twin;
}

/** One ant's position after each of the next ticks; the first tick takes these inputs. */
function path(state: SimState, id: number, ticks: number, first: readonly SimInput[] = []): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, t === 0 ? first : []).state;
    const ant = antOf(state, id);
    out.push({ x: ant.x, y: ant.y });
  }
  return out;
}

/** A worker and a soldier claimed by a's DEFEND mark at 20,32; a third worker claimed by a's GATHER mark at 28,46. */
function claimedScene() {
  let state = scene(RULES27, { commandFloorTicks: 1 });
  const worker = addAnt(state, 0, 20, 36, { caste: "worker" });
  const soldier = addAnt(state, 0, 21, 36, { caste: "soldier" });
  const other = addAnt(state, 0, 26, 44, { caste: "worker" });
  state = step(state, [lay("a", 20, 32, "DEFEND", 2)]).state;
  state = step(state, [lay("a", 28, 46, "GATHER", 1, "worker")]).state;
  const defend = markAt(state, 20, 32), gather = markAt(state, 28, 46);
  state = run(state, 120);
  expect([antOf(state, worker.id).claim, antOf(state, soldier.id).claim, antOf(state, other.id).claim]).toEqual([defend.id, defend.id, gather.id]);
  return { state, worker: worker.id, soldier: soldier.id, other: other.id, defend: defend.id, gather: gather.id };
}

describe("rules 27: an agent removes its own count mark", () => {
  it("deletes the mark and releases its ants in the same tick, leaving other marks' claims", () => {
    const { state, worker, soldier, other, defend, gather } = claimedScene();
    const out = step(state, [remove(defend)]);
    expect(errorOf(out)).toBeNull();
    expect(out.state.marks.map(mark => mark.id)).toEqual([gather]);
    expect(antOf(out.state, worker).claim).toBeUndefined();
    expect(antOf(out.state, soldier).claim).toBeUndefined();
    expect(antOf(out.state, other).claim).toBe(gather);
    // No mark and no mark event: only the call record.
    expect(out.events.filter(event => event.type === "mark_laid" || event.type === "count_mark_accepted")).toEqual([]);
    expect(out.events.filter(event => event.type === "agent_call")).toEqual([{ type: "agent_call", tick: state.tick, agentId: "a", call: "count_mark", accepted: true }]);
  });

  it.each(["worker", "soldier"] as const)("from the removal tick, a released %s moves exactly as a never-claimed one at the same spot", caste => {
    const { state, defend, ...ids } = claimedScene();
    const id = ids[caste];
    const ticks = 60;
    expect(path(state, id, ticks, [remove(defend)])).toEqual(path(neverClaimed(state, antOf(state, id)), id, ticks, [remove(defend)]));
  });

  it.each(["worker", "soldier"] as const)("a hatched %s claimed mid-walk does not resume its spawn walk after REMOVE: it moves as a free ant with no walk", caste => {
    // The release-time clear on REMOVE is the removal change's; clearing on claim is separate.
    let state = scene(RULES27, { commandFloorTicks: 1, hatchIntervalTicks: 10 });
    const queen = state.colonies[0]!.queens!.find(q => q.lostTick === null)!;
    queen.brood = caste === "worker" ? "workers" : "soldiers"; // Rules 27: her own brood.
    const home = { tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) };
    queen.spawnPoint = { tileX: home.tileX + 30, tileY: home.tileY - 12 };
    queen.lastHatchTick = -1_000_000;
    state.colonies[0]!.foodStore = state.config.castes!.soldierCost;
    let born: Ant | undefined;
    for (let i = 0; i < 400 && born === undefined; i++) {
      state = step(state).state;
      born = state.ants.find(ant => ant.colony === 0);
    }
    expect(born?.caste).toBe(caste);
    expect(born!.spawnWalk).toEqual({ queenId: queen.id, ...queen.spawnPoint });
    state.colonies[0]!.foodStore = 0;
    state = run(state, 5);
    const at = antOf(state, born!.id);
    state = step(state, [lay("a", Math.floor(at.x / SUB), Math.floor(at.y / SUB), "DEFEND", 1)]).state;
    const mark = markAt(state, Math.floor(at.x / SUB), Math.floor(at.y / SUB));
    state = run(state, 20);
    const claimed = antOf(state, born!.id);
    expect(claimed.claim).toBe(mark.id);
    // The walk survives the claim until clearing on claim lands; either way, removal must not resume it.
    const free = neverClaimed(state, claimed);
    expect(antOf(free, born!.id).spawnWalk).toBeUndefined();
    const ticks = 60;
    expect(path(state, born!.id, ticks, [remove(mark.id)])).toEqual(path(free, born!.id, ticks, [remove(mark.id)]));
  });

  it("a released worker leaves the DEFEND hold on the removal tick itself", () => {
    const { state, worker, defend } = claimedScene();
    const at = antOf(state, worker);
    const kept = path(state, worker, 60);
    const freed = path(state, worker, 60, [remove(defend)]);
    expect(freed[0]).not.toEqual({ x: at.x, y: at.y });
    expect(Math.hypot(freed.at(-1)!.x - kept.at(-1)!.x, freed.at(-1)!.y - kept.at(-1)!.y)).toBeGreaterThan(SUB);
  });

  it("uses the shared command allowance both ways", () => {
    let state = scene();
    addAnt(state, 0, 20, 36);
    state = step(state, [lay("a", 20, 32, "DEFEND", 1)]).state;
    const mark = state.marks[0]!.id;
    const floor = state.config.commandFloorTicks;
    state = run(state, floor - 2);
    // Too soon after the lay.
    let out = step(state, [remove(mark)]);
    expect(errorOf(out)).toMatchObject({ code: "rate_limited", nextAllowedTick: 1000 + floor });
    expect(out.state.marks.map(m => m.id)).toEqual([mark]);
    state = out.state;
    out = step(state, [remove(mark)]);
    expect(errorOf(out)).toBeNull();
    expect(out.state.agents[0]!.lastCommandTick).toBe(1000 + floor);
    // And the removal spends it for the next command.
    out = step(out.state, [lay("a", 20, 32, "DEFEND", 1)]);
    expect(errorOf(out)).toMatchObject({ code: "rate_limited", nextAllowedTick: 1000 + 2 * floor });
  });

  it("refuses anything but the agent's own live count mark, changing nothing and spending no allowance", () => {
    const state = scene();
    addAnt(state, 0, 20, 36);
    const events: SimEvent[] = [];
    for (const input of [lay("a", 20, 32, "DEFEND", 1), lay("b", 22, 32, "GATHER", 1)]) {
      expect(applyInput(state, input, state.tick, defaultAllocator, events).error).toBeNull();
    }
    const [own, teammate] = state.marks;
    // A word mark of a's own (an older-rules shape, injected) is not a count mark.
    state.marks.push({ id: 99, agentId: "a", colony: 0, tileX: 24, tileY: 32, words: ["HOLD"], laidTick: state.tick, steering: 0 });
    const tick = state.tick + state.config.commandFloorTicks;
    for (const a of state.agents) a.lastCallTick = tick;
    const before = JSON.stringify(state);
    for (const markId of [teammate!.id, 99, 12345, undefined, String(own!.id), own!.id + 0.5]) {
      const result = applyInput(state, remove(markId), tick, defaultAllocator, events);
      expect(result.error).toEqual({ code: "bad_mark_removal", message: "REMOVE needs markId: the id of one of your own count marks still on the map." });
      expect(JSON.stringify(state)).toBe(before);
    }
    // The allowance is untouched: the agent's own mark goes at once.
    expect(applyInput(state, remove(own!.id), tick, defaultAllocator, events).error).toBeNull();
    expect(state.marks.map(m => m.id)).toEqual([teammate!.id, 99]);
  });
});

/** A seated two-colony match, logged as the live adapter logs it: every tick, house-active. */
function recordedMatch(config: SimConfig, removalVerb = "REMOVE") {
  let state = createMatch(4530, newMatchConfig(config));
  const queen = state.colonies[0].queens![0]!;
  const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
  const tile = [[4, 0], [0, 4], [0, -4], [-4, 0]].map(([dx, dy]) => ({ x: qx + dx!, y: qy + dy! }))
    .find(t => !isBlockedTile(state.terrain, t.x, t.y))!;
  const lines = [headerLine(4530, state.config)];
  const results: StepOutput[] = [];
  let markId: number | undefined;
  while (state.tick < 300) {
    const inputs: SimInput[] = state.tick === 0 ? [{ type: "join", agentId: "a", colony: 0 }, { type: "join", agentId: "z", colony: 1 }]
      : state.tick === 1 ? [lay("a", tile.x, tile.y, "DEFEND", 3)]
        : state.tick === 150 ? [{ ...remove(markId), verb: removalVerb } as SimInput] : [];
    const out = step(state, inputs, undefined, undefined, undefined, false, true);
    lines.push(tickLine(state.tick, inputs, false, true));
    if (inputs.length > 0) results.push(out);
    if (state.tick === 1) markId = out.state.marks.find(mark => mark.agentId === "a")!.id;
    state = out.state;
  }
  return { state, lines, results, markId: markId! };
}

describe("replay", () => {
  it("a rules-27 match containing a removal records it as a match input and replays exactly", () => {
    const { state, lines, results, markId } = recordedMatch(RULES27);
    const removal = results.at(-1)!;
    expect(errorOf(results[1]!)).toBeNull();
    expect(errorOf(removal)).toBeNull();
    expect(removal.state.marks.some(mark => mark.id === markId)).toBe(false);
    expect(removal.state.ants.some(ant => ant.claim === markId)).toBe(false);
    expect(parseLog(lines).ticks.get(150)).toEqual([{ type: "count_mark", agentId: "a", verb: "REMOVE", count: 0, markId }]);
    expect(stateHash(replay(lines, state.tick))).toBe(stateHash(state));
  });
});
