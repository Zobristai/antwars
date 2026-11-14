import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { cloneState, createMatch } from "../../src/sim/map.js";
import { assignQueenOwners } from "../../src/sim/queenOwners.js";
import { step } from "../../src/sim/step.js";
import type { ColonyId, QueenState, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, setOwner } from "./fixtures.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

/**
 * In rules 27 every
 * live queen without an owner, in a colony with agents, is drawn an owner from that colony's
 * agents using the match seed; an owner that goes idle or stops calling keeps its queens.
 * Today's paths: seats and starting queens (no owner field), founding (house founding needs every colony
 * agent idle) and idle being source-policy dependent (the lapse runs only when step's houseActive is
 * false). The live game path is in test/mcp/rules27-queen-owner-live.test.ts.
 */

function rules27(patch: Partial<SimConfig> = {}): SimConfig {
  const base = recordedHousePlan(rulesConfig("redesign"));
  return newMatchConfig({ ...base, startAnts: 0, squadSize: 0, commandFloorTicks: 1, hatchIntervalTicks: 1_000_000, ...patch });
}
const RULES_27 = rules27();
/** The same rules with a 6 s command-idle timeout, so the lapse cases run in a few hundred ticks. */
const QUICK_IDLE = rules27({ commandIdleTicks: 60 });

const join = (agentId: string, colony: ColonyId): SimInput => ({ type: "join", agentId, colony });
const queensOf = (state: SimState, colony: ColonyId): QueenState[] => state.colonies[colony].queens!;
const ownerOf = (state: SimState, colony: ColonyId = 0, id = 0): string | undefined => queensOf(state, colony).find((q) => q.id === id)!.owner;
/** step() on the offline path, where the command-idle lapse runs (houseActive false). */
const offline = (state: SimState, inputs: readonly SimInput[] = []): SimState => step(state, inputs).state;

describe("rules-27 ownership draw", () => {

  it("gives the default one-queen start an owner drawn from the colony's two agents, and leaves an agentless colony unowned", () => {
    const owners = new Set<string | undefined>();
    for (let seed = 1; seed <= 24; seed += 1) {
      const start = createMatch(seed, RULES_27);
      expect(queensOf(start, 0)).toHaveLength(1);
      expect(ownerOf(start)).toBeUndefined();
      const out = step(start, [join("a", 0), join("b", 0)]);
      const owner = ownerOf(out.state);
      expect(["a", "b"]).toContain(owner);
      owners.add(owner);
      // The same seed draws the same owner, whatever the PRNG state.
      const reseeded = { ...cloneState(start), rngState: (start.rngState ^ 0x5a5a5a5a) >>> 0 };
      expect(ownerOf(step(reseeded, [join("a", 0), join("b", 0)]).state)).toBe(owner);
      expect(ownerOf(out.state, 1)).toBeUndefined();
      expect(Object.keys(queensOf(out.state, 1)[0]!)).not.toContain("owner");
    }
    // Drawn from the seed, not always the first agent to join.
    expect(owners).toEqual(new Set(["a", "b"]));
  });

  it("draws without advancing the match PRNG and changes nothing but unowned live queens' owner", () => {
    const state = createMatch(7, RULES_27);
    state.agents = step(state, [join("a", 0), join("b", 0), join("c", 1)]).state.agents;
    const lost: QueenState = { ...queensOf(state, 0)[0]!, id: 1, lostTick: 5 };
    const owned: QueenState = { ...queensOf(state, 0)[0]!, id: 2, owner: "b" };
    state.colonies[0].queens = [...queensOf(state, 0), lost, owned];
    const before = cloneState(state);
    assignQueenOwners(state);
    expect(state.rngState).toBe(before.rngState);
    expect(["a", "b"]).toContain(ownerOf(state, 0, 0));
    expect(ownerOf(state, 1)).toBe("c");
    expect(ownerOf(state, 0, 1)).toBeUndefined(); // a lost queen is never drawn
    expect(ownerOf(state, 0, 2)).toBe("b"); // an owner is never redrawn
    const strip = (s: SimState) => JSON.stringify({ ...s, colonies: s.colonies.map((c) => ({ ...c, queens: c.queens!.map(({ owner: _owner, ...q }) => q) })) });
    expect(strip(state)).toBe(strip(before));
  });

  it("gives a queen the house founds for an all-idle seated colony an owner from that colony's idle agents", () => {
    let state = createMatch(11, RULES_27);
    state = offline(state, [join("a", 0), join("b", 0)]);
    const startOwner = ownerOf(state);
    const rules = state.config.queenFounding!;
    state.tick = rules.firstFoundTick! + 1;
    for (const agent of state.agents) agent.idle = true;
    state.colonies[0].foodStore = rules.cost * 100;
    // A held site far from both nests, with one colony-0 ant keeping it held.
    const queen = queensOf(state, 0)[0]!;
    const site = { tileX: Math.floor(queen.queenX / SUB) + 40, tileY: Math.floor(queen.queenY / SUB) };
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) setOwner(state, site.tileX + dx, site.tileY + dy, 0);
    addAnt(state, 0, site.tileX, site.tileY);
    const out = step(state);
    const founded = out.events.flatMap((e) => e.type === "queen_founded" && e.colony === 0 ? [e] : []);
    expect(founded).toHaveLength(1);
    const newQueen = queensOf(out.state, 0).find((q) => q.id === founded[0]!.queenId)!;
    expect(["a", "b"]).toContain(newQueen.owner);
    expect(ownerOf(out.state)).toBe(startOwner);
  });

  it("keeps an owner's queen through the offline command-idle lapse while its teammate keeps commanding", () => {
    let state = offline(createMatch(3, QUICK_IDLE), [join("a", 0), join("b", 0)]);
    const owner = ownerOf(state)!;
    const teammate = owner === "a" ? "b" : "a";
    const idleTicks = state.config.commandIdleTicks!;
    expect(idleTicks).toBe(60);
    // The owner keeps observing but sends no command; the teammate commands every 20 ticks.
    let lapsedAt: number | null = null;
    for (let t = 0; t < 3 * idleTicks; t += 1) {
      const inputs: SimInput[] = [{ type: "observe", agentId: owner }];
      if (t % 20 === 0) inputs.push({ type: "order", agentId: teammate, order: { kind: "hold" } });
      state = offline(state, inputs);
      const seat = state.agents.find((a) => a.id === owner)!;
      if (seat.idle && lapsedAt === null) lapsedAt = state.tick;
      expect(ownerOf(state)).toBe(owner);
    }
    expect(lapsedAt).not.toBeNull();
    expect(state.agents.find((a) => a.id === teammate)!.idle).toBe(false);
    expect(ownerOf(state)).toBe(owner);
  });

  it("keeps an owner's queen when the owner stops calling altogether, on the offline path", () => {
    let state = offline(createMatch(5, QUICK_IDLE), [join("a", 0), join("b", 0)]);
    const owner = ownerOf(state)!;
    const teammate = owner === "a" ? "b" : "a";
    for (let t = 0; t < 3 * state.config.commandIdleTicks!; t += 1) {
      state = offline(state, t % 20 === 0 ? [{ type: "order", agentId: teammate, order: { kind: "hold" } }] : []);
      expect(ownerOf(state)).toBe(owner);
    }
    expect(state.agents.find((a) => a.id === owner)!.idle).toBe(true);
    expect(ownerOf(state)).toBe(owner);
  });

  it("reproduces the same owners when the match log is replayed", () => {
    const seed = 19;
    const ticks = new Map<number, SimInput[]>([
      [0, [join("a", 0), join("c", 0), join("b", 1)]],
      [4, [join("d", 1)]],
      [9, [{ type: "observe", agentId: "c" }]],
    ]);
    const lines = [headerLine(seed, RULES_27)];
    let state = createMatch(seed, RULES_27);
    const owners: string[] = [];
    while (state.tick < 12) {
      const inputs = ticks.get(state.tick) ?? [];
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      state = offline(state, inputs);
      owners.push(`${ownerOf(state, 0)}/${ownerOf(state, 1)}`);
    }
    // Colony 0's queen was drawn from its two agents; colony 1's from its one, kept when a teammate joined.
    expect(["a", "c"]).toContain(ownerOf(state, 0));
    expect(ownerOf(state, 1)).toBe("b");
    const replayed: string[] = [];
    const end = replay(lines, 12, (s) => replayed.push(`${ownerOf(s, 0)}/${ownerOf(s, 1)}`));
    expect(replayed).toEqual(owners);
    expect(stateHash(end)).toBe(stateHash(state));
  });

});
