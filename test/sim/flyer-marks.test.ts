import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator, fillSquads } from "../../src/sim/agents.js";
import { FLYER_RULES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { claimCountMarks, expireMarks } from "../../src/sim/marks.js";
import type { Agent, Ant, Mark, SimEvent, SimInput, SimState, Terrain } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Flyer count marks at engine level: who they order, where they may be laid or moved, their counts, and
// re-lays that change count and caste in place. Every match plays at grid scale 2 (128 x 96 tiles, sight 12,
// marks last 1800 ticks). Flyers here stand still: these checks script inputs and the claim pass only.
const config: SimConfig = { ...rulesConfig("redesign"), flyers: FLYER_RULES, startAnts: 0, squadSize: 0,
  terrain: undefined, foodLayout: undefined, foodPatches: [], commandFloorTicks: 0, combatGraceTicks: 99_999, earlyWin: undefined };

type CountMarkInput = Extract<SimInput, { type: "count_mark" }>;
type Spec = Partial<Omit<CountMarkInput, "type" | "agentId">>;

function seat(id: string): Agent {
  return { id, colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 100, lastCommandTick: null, idle: false, pendingEvents: [] };
}

/** Seats a and mate in colony 0, with one scout at (40, 40): tiles up to 12 away are in sight. */
function scene(extra: Partial<SimConfig> = {}): SimState {
  const state = emptyMatch(100, { ...config, ...extra });
  state.agents.push(seat("a"), seat("mate"));
  addAnt(state, 0, 40, 40, { caste: "worker" });
  return state;
}

const flyer = (state: SimState, tx: number, ty: number): Ant => addAnt(state, 0, tx, ty, { caste: "worker", flyer: true });
const worker = (state: SimState, tx: number, ty: number): Ant => addAnt(state, 0, tx, ty, { caste: "worker" });
const soldier = (state: SimState, tx: number, ty: number): Ant => addAnt(state, 0, tx, ty, { caste: "soldier" });

function send(state: SimState, spec: Spec, agentId = "a") {
  const events: SimEvent[] = [];
  const input = { type: "count_mark", agentId, verb: "GATHER", count: 1, ...spec } as CountMarkInput;
  const result = applyInput(state, input, state.tick, defaultAllocator, events);
  return { error: result.error, events, result };
}

/** Lay a flyer mark that must be accepted; returns it. */
function layFlyer(state: SimState, spec: Spec, agentId = "a"): Mark {
  const { error } = send(state, { caste: "flyer", ...spec }, agentId);
  expect(error).toBeNull();
  return state.marks.at(-1)!;
}

/** The input leaves state, events and the agent's command allowance untouched. */
function expectRefused(state: SimState, spec: Spec, code: string, agentId = "a") {
  const before = JSON.stringify(state);
  const { error, events } = send(state, spec, agentId);
  expect(error?.code).toBe(code);
  expect(events).toEqual([]);
  expect(JSON.stringify(state)).toBe(before);
}

const claimed = (state: SimState, mark: Mark): number[] => state.ants.filter((a) => a.claim === mark.id).map((a) => a.id);

describe("only flyer marks order flyers, and flyer marks claim only flyers", () => {
  it.each(["DEFEND", "ATTACK", "GATHER", "PATROL", "LINE"])("%s caste flyer claims only flyers; every other caste never claims a flyer", verb => {
    const line = verb === "LINE" ? { toTileX: 44, toTileY: 40 } : {};
    const state = scene();
    // Ground ants stand nearer every mark than the flyers do.
    const ground = [worker(state, 40, 41), soldier(state, 40, 41)];
    const flyers = [flyer(state, 40, 45), flyer(state, 40, 46)];
    const flyerMark = layFlyer(state, { verb, count: 10, tileX: 40, tileY: 40, ...line });
    claimCountMarks(state, state.tick);
    expect(claimed(state, flyerMark)).toEqual(flyers.map((a) => a.id));
    for (const ant of ground) expect(ant.claim).toBeUndefined();

    const fresh = scene();
    const freeFlyers = [flyer(fresh, 40, 41), flyer(fresh, 40, 42)];
    const marks: Mark[] = [];
    for (const [i, caste] of [undefined, "worker", "soldier"].entries()) {
      expect(send(fresh, { verb, count: 10, tileX: 36 + i, tileY: 40, ...(caste === undefined ? {} : { caste }),
        ...(verb === "LINE" ? { toTileX: 36 + i, toTileY: 44 } : {}) }).error).toBeNull();
      marks.push(fresh.marks.at(-1)!);
    }
    const foragers = send(fresh, { verb: "FORAGE", count: 10, tileX: 44, tileY: 40 });
    expect(foragers.error).toBeNull();
    claimCountMarks(fresh, fresh.tick);
    for (const ant of freeFlyers) expect(ant.claim).toBeUndefined();
  });

  it("never drafts a flyer into a squad", () => {
    // All on one tile, so squads draft by id, and the flyers have the lowest ids after the scout.
    const state = scene({ squadSize: 6 });
    const scout = state.ants[0]!;
    const flyers = [flyer(state, 40, 40), flyer(state, 40, 40), flyer(state, 40, 40)];
    const workers = Array.from({ length: 10 }, () => worker(state, 40, 40));
    // 14 living ants at 500 permille supply 7 squad places: 6 for a, 1 for mate.
    fillSquads(state, defaultAllocator, state.tick, []);
    expect(state.agents.map((agent) => agent.squad)).toEqual([[scout, ...workers.slice(0, 5)].map((a) => a.id), [workers[5]!.id]]);
    for (const ant of flyers) expect(ant.squad).toBeNull();
  });

  it("caste flyer is an unknown caste in rules without flyers, as before", () => {
    const state = scene({ flyers: undefined });
    const before = JSON.stringify(state);
    const { error, events } = send(state, { caste: "flyer", tileX: 40, tileY: 40 });
    expect(error).toMatchObject({ code: "bad_count_mark", message: "Choose a caste from any, worker, soldier; omitted means any." });
    expect(events).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("lists flyer among the castes in rules with flyers", () => {
    const state = scene();
    const { error } = send(state, { caste: "queen", tileX: 40, tileY: 40 });
    expect(error).toMatchObject({ code: "bad_count_mark", message: "Choose a caste from any, worker, soldier, flyer; omitted means any." });
  });

  it("refuses a flyer FORAGE mark, and a flyer mark without a tile", () => {
    const state = scene();
    expectRefused(state, { verb: "FORAGE", caste: "flyer", count: 5, tileX: 40, tileY: 40 }, "bad_count_mark");
    expectRefused(state, { verb: "GATHER", caste: "flyer", count: 5 }, "bad_count_mark");
    expect(send(state, { verb: "FORAGE", caste: "flyer", count: 5, tileX: 40, tileY: 40 }).error?.message)
      .toBe("Flyers never forage; FORAGE recruits workers only.");
  });
});

/** Water at (60..61, 40..41), rock at (56..57, 40..41), a scout at (60, 44) seeing all of them and the land beside. */
function terrainScene(): SimState {
  const terrain: Terrain = { mapId: "flyer-marks", mapName: "Flyer marks", water: [{ x: 60, y: 40, width: 2, height: 2 }],
    rocks: [{ x: 56, y: 40, width: 2, height: 2, appearance: 0 }] };
  const state = { ...scene(), terrain };
  addAnt(state, 0, 60, 44, { caste: "worker" });
  return state;
}

describe("a flyer mark's tile, laid or moved, is land in current colony sight (checks 5 and 6)", () => {
  const verbs = ["DEFEND", "ATTACK", "GATHER", "PATROL", "LINE"] as const;

  it.each(verbs)("%s: the last seen tile is accepted, the first unseen tile refused", verb => {
    // The scout at (40, 40) sees (52, 40) at distance 12; (53, 40) is the first tile beyond.
    const state = scene();
    const line = (x: number) => verb === "LINE" ? { tileX: 40, tileY: 40, toTileX: x, toTileY: 40 } : { tileX: x, tileY: 40 };
    expectRefused(state, { verb, caste: "flyer", count: 3, ...line(53) }, "count_mark_not_visible");
    if (verb === "LINE") expectRefused(state, { verb, caste: "flyer", count: 3, tileX: 53, tileY: 40, toTileX: 40, toTileY: 40 }, "count_mark_not_visible");
    const mark = layFlyer(state, { verb, count: 3, ...line(52) });
    expect(mark).toMatchObject({ verb, caste: "flyer", count: 3, ...line(52) });
  });

  it.each(verbs)("%s: water and rock are refused, the land tile beside each accepted", verb => {
    const at = (x: number) => verb === "LINE" ? { tileX: 60, tileY: 46, toTileX: x, toTileY: 40 } : { tileX: x, tileY: 40 };
    const state = terrainScene();
    expectRefused(state, { verb, caste: "flyer", count: 3, ...at(60) }, "water_tile");
    expectRefused(state, { verb, caste: "flyer", count: 3, ...at(56) }, "rock_tile");
    if (verb === "LINE") {
      expectRefused(state, { verb, caste: "flyer", count: 3, tileX: 61, tileY: 41, toTileX: 60, toTileY: 46 }, "water_tile");
      expectRefused(state, { verb, caste: "flyer", count: 3, tileX: 57, tileY: 41, toTileX: 60, toTileY: 46 }, "rock_tile");
    }
    expect(layFlyer(state, { verb, count: 3, ...at(62) })).toMatchObject(at(62));
    expect(layFlyer(state, { verb, count: 3, ...at(55) })).toMatchObject(at(55));
  });

  it.each(verbs)("%s: a moved flyer mark keeps id, owner, lifetime, claims and laid order; its tile and count change", verb => {
    const ends = (x: number) => verb === "LINE" ? { tileX: x, tileY: 40, toTileX: 40, toTileY: 42 } : { tileX: x, tileY: 40 };
    const state = scene();
    // Left of the scout, so they see nothing beyond its sight on the right.
    const flyers = [flyer(state, 34, 41), flyer(state, 34, 42)];
    const older = layFlyer(state, { verb, count: 1, ...ends(36) });
    state.tick += 5;
    const mark = layFlyer(state, { verb, count: 2, ...ends(40) });
    state.tick += 5;
    const newer = layFlyer(state, { verb, count: 1, ...ends(44) });
    claimCountMarks(state, state.tick);
    const members = claimed(state, mark);
    expect(members).toHaveLength(1);
    const before = { ...mark };
    const order = state.marks.map((m) => m.id);
    state.tick += 50;

    const { error, events } = send(state, { verb, markId: mark.id, count: 3, ...ends(50) });
    expect(error).toBeNull();
    expect(state.marks.map((m) => m.id)).toEqual(order);
    expect(state.marks[1]).toBe(mark);
    expect(mark).toEqual({ ...before, ...ends(50), count: 3, revision: 1 });
    expect(events.map((e) => e.type)).toEqual(["count_mark_accepted"]);
    expect(events[0]).toMatchObject({ markId: mark.id, ...ends(50), count: 3, caste: "flyer" });
    expect(state.agents[0]!.lastCommandTick).toBe(state.tick);
    claimCountMarks(state, state.tick);
    expect(claimed(state, mark).slice(0, members.length)).toEqual(members);
    expect([older, newer].map((m) => m.tileX)).toEqual([36, 44]);

    // Moved again: last seen tile accepted, first unseen refused; water and rock refused, the land beside accepted.
    const moveTo = (x: number) => ({ verb, markId: mark.id, count: 3, ...ends(x) });
    expectRefused(state, moveTo(53), "count_mark_not_visible");
    expect(send(state, moveTo(52)).error).toBeNull();
    expect(mark).toMatchObject({ ...ends(52), revision: 2, laidTick: before.laidTick });
    expect(flyers.map((a) => a.claim)).toContain(mark.id);
  });

  it("a moved mark's water, rock and land-beside cases", () => {
    const state = terrainScene();
    const mark = layFlyer(state, { verb: "GATHER", count: 2, tileX: 60, tileY: 46 });
    const lineMark = layFlyer(state, { verb: "LINE", count: 2, tileX: 60, tileY: 46, toTileX: 64, toTileY: 46 });
    expectRefused(state, { verb: "GATHER", markId: mark.id, count: 2, tileX: 60, tileY: 40 }, "water_tile");
    expectRefused(state, { verb: "GATHER", markId: mark.id, count: 2, tileX: 56, tileY: 40 }, "rock_tile");
    expectRefused(state, { verb: "LINE", markId: lineMark.id, count: 2, tileX: 60, tileY: 46, toTileX: 61, toTileY: 41 }, "water_tile");
    expectRefused(state, { verb: "LINE", markId: lineMark.id, count: 2, tileX: 57, tileY: 41, toTileX: 60, toTileY: 46 }, "rock_tile");
    expect(send(state, { verb: "GATHER", markId: mark.id, count: 2, tileX: 62, tileY: 40 }).error).toBeNull();
    expect(mark).toMatchObject({ tileX: 62, tileY: 40, revision: 1 });
    expect(send(state, { verb: "LINE", markId: lineMark.id, count: 2, tileX: 55, tileY: 40, toTileX: 62, toTileY: 41 }).error).toBeNull();
    expect(lineMark).toMatchObject({ tileX: 55, tileY: 40, toTileX: 62, toTileY: 41, revision: 1 });
  });

  it("refuses a move that does not name one of the agent's own flyer marks with its verb, caste flyer and a tile", () => {
    const state = scene();
    const mark = layFlyer(state, { verb: "PATROL", count: 2, tileX: 40, tileY: 40 });
    const mates = layFlyer(state, { verb: "PATROL", count: 2, tileX: 44, tileY: 40 }, "mate");
    expect(send(state, { verb: "PATROL", caste: "soldier", count: 2, tileX: 46, tileY: 40 }).error).toBeNull();
    const ground = state.marks.at(-1)!;
    expect(send(state, { verb: "LINE", caste: "flyer", count: 2, tileX: 40, tileY: 44, toTileX: 44, toTileY: 44 }).error).toBeNull();
    const line = state.marks.at(-1)!;
    const to = { tileX: 48, tileY: 40 };
    expectRefused(state, { verb: "PATROL", markId: mates.id, count: 2, ...to }, "bad_count_mark");
    expectRefused(state, { verb: "PATROL", markId: ground.id, count: 2, ...to }, "bad_count_mark");
    expectRefused(state, { verb: "PATROL", markId: 999, count: 2, ...to }, "bad_count_mark");
    expectRefused(state, { verb: "GATHER", markId: mark.id, count: 2, ...to }, "bad_count_mark");
    for (const caste of ["soldier", "worker", "any"]) expectRefused(state, { verb: "PATROL", markId: mark.id, caste, count: 2, ...to }, "bad_count_mark");
    expectRefused(state, { verb: "PATROL", markId: mark.id, count: 2 }, "bad_count_mark");
    expectRefused(state, { verb: "PATROL", markId: mark.id, count: 2, tileX: 48 }, "count_mark_not_visible");
    expectRefused(state, { verb: "PATROL", markId: mark.id, count: 2, ...to, toTileX: 50, toTileY: 40 }, "bad_count_mark");
    expectRefused(state, { verb: "LINE", markId: line.id, count: 2, ...to }, "bad_count_mark");
    expectRefused(state, { verb: "LINE", markId: line.id, count: 2, tileX: 40, tileY: 44, toTileX: 40, toTileY: 44 }, "bad_count_mark");
    expect(send(state, { verb: "PATROL", markId: mark.id, caste: "flyer", count: 2, ...to }).error).toBeNull();
    expect(mark).toMatchObject({ ...to, caste: "flyer", revision: 1 });
  });

  it("without flyers in the rules, markId on a mark verb is ignored as before", () => {
    const state = scene({ flyers: undefined });
    expect(send(state, { verb: "GATHER", caste: "worker", count: 2, tileX: 40, tileY: 40 }).error).toBeNull();
    const mark = state.marks[0]!;
    expect(send(state, { verb: "GATHER", markId: mark.id, caste: "worker", count: 2, tileX: 44, tileY: 40 }).error).toBeNull();
    expect(state.marks.map((m) => [m.tileX, m.tileY])).toEqual([[40, 40], [44, 40]]);
    expect(mark).toMatchObject({ tileX: 40, revision: 0 });
  });
});

describe("flyer mark counts (check 7)", () => {
  it("accepts 1 and 10,000 and refuses 0 and 10,001, laid or moved", () => {
    const state = scene();
    for (const count of [0, 10_001]) expectRefused(state, { verb: "DEFEND", caste: "flyer", count, tileX: 40, tileY: 40 }, "bad_count_mark");
    const one = layFlyer(state, { verb: "DEFEND", count: 1, tileX: 40, tileY: 40 });
    const most = layFlyer(state, { verb: "ATTACK", count: 10_000, tileX: 44, tileY: 40 });
    expect([one.count, most.count]).toEqual([1, 10_000]);
    for (const count of [0, 10_001]) expectRefused(state, { verb: "DEFEND", markId: one.id, count, tileX: 42, tileY: 40 }, "bad_count_mark");
    expect(send(state, { verb: "DEFEND", markId: one.id, count: 10_000, tileX: 42, tileY: 40 }).error).toBeNull();
    expect(send(state, { verb: "ATTACK", markId: most.id, count: 1, tileX: 46, tileY: 40 }).error).toBeNull();
    expect([one.count, most.count]).toEqual([10_000, 1]);
  });
});

describe("re-lays change count and caste in place (check 8: re-lay, caste and chains)", () => {
  it("a caste change releases every member it no longer fits before any excess", () => {
    const state = scene();
    const flyers = [flyer(state, 40, 41), flyer(state, 40, 42), flyer(state, 40, 43)];
    const soldiers = [soldier(state, 40, 46), soldier(state, 40, 47)];
    const mark = layFlyer(state, { verb: "DEFEND", count: 3, tileX: 40, tileY: 40 });
    claimCountMarks(state, state.tick);
    expect(claimed(state, mark)).toEqual(flyers.map((a) => a.id));
    // One soldier wanted: every flyer goes, not only the two beyond the new count.
    expect(send(state, { verb: "DEFEND", caste: "soldier", count: 1, tileX: 40, tileY: 40 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    for (const ant of flyers) expect(ant.claim).toBeUndefined();
    expect(claimed(state, mark)).toEqual([soldiers[0]!.id]);
    // The same count change without a caste change keeps the nearest member.
    expect(send(state, { verb: "DEFEND", caste: "flyer", count: 3, tileX: 40, tileY: 40 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    expect(claimed(state, mark)).toEqual(flyers.map((a) => a.id));
    expect(send(state, { verb: "DEFEND", caste: "flyer", count: 1, tileX: 40, tileY: 40 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    expect(claimed(state, mark)).toEqual([flyers[0]!.id]);
    expect(state.marks).toEqual([mark]);
  });

  it("LINE re-lays in place only with the same ends", () => {
    const state = scene();
    const flyers = [flyer(state, 40, 41), flyer(state, 40, 42)];
    const mark = layFlyer(state, { verb: "LINE", count: 2, tileX: 40, tileY: 40, toTileX: 44, toTileY: 40 });
    claimCountMarks(state, state.tick);
    expect(flyers.map((a) => a.claim)).toEqual([mark.id, mark.id]);
    const before = { ...mark };
    expect(send(state, { verb: "LINE", caste: "soldier", count: 2, tileX: 40, tileY: 40, toTileX: 44, toTileY: 40 }).error).toBeNull();
    expect(state.marks).toEqual([{ ...before, caste: "soldier", revision: 1 }]);
    claimCountMarks(state, state.tick);
    for (const ant of flyers) expect(ant.claim).toBeUndefined();
    expect(send(state, { verb: "LINE", caste: "flyer", count: 2, tileX: 40, tileY: 40, toTileX: 44, toTileY: 42 }).error).toBeNull();
    expect(state.marks).toHaveLength(2);
    expect(state.marks[0]).toMatchObject({ id: mark.id, caste: "soldier", toTileY: 40 });
  });

  it("scripted: a flyer PATROL chain of 3 and a ground PATROL mark, re-laid, re-cast, recounted and expired", () => {
    const state = scene();
    addAnt(state, 0, 56, 52, { caste: "worker" });
    const nearA = [flyer(state, 40, 42), flyer(state, 40, 43)];
    const nearB = [flyer(state, 48, 42), flyer(state, 48, 43)];
    const nearC = [flyer(state, 56, 42), flyer(state, 56, 43)];
    const spare = [flyer(state, 62, 60), flyer(state, 62, 61)];
    const freeSoldiers = [soldier(state, 48, 46), soldier(state, 48, 47)];
    const groundSoldiers = [soldier(state, 56, 60), soldier(state, 56, 61)];
    const a = layFlyer(state, { verb: "PATROL", count: 2, tileX: 40, tileY: 40 });
    state.tick += 1;
    const b = layFlyer(state, { verb: "PATROL", count: 2, tileX: 48, tileY: 40 });
    state.tick += 1;
    const c = layFlyer(state, { verb: "PATROL", count: 2, tileX: 56, tileY: 40 });
    state.tick += 1;
    expect(send(state, { verb: "PATROL", caste: "soldier", count: 2, tileX: 56, tileY: 58 }).error).toBeNull();
    const ground = state.marks.at(-1)!;
    claimCountMarks(state, state.tick);
    expect([a, b, c, ground].map((m) => claimed(state, m))).toEqual([nearA, nearB, nearC, groundSoldiers].map((g) => g.map((ant) => ant.id)));
    const identity = (m: Mark) => ({ id: m.id, agentId: m.agentId, laidTick: m.laidTick, verb: m.verb, tileX: m.tileX, tileY: m.tileY });
    const kept = [a, b, c, ground].map(identity);
    const order = state.marks.map((m) => m.id);
    const survives = () => {
      expect(state.marks.map((m) => m.id)).toEqual(order);
      expect([a, b, c, ground].map(identity)).toEqual(kept);
    };

    // Flyer to soldier: the middle mark releases both its flyers and recruits soldiers.
    state.tick = 400;
    expect(send(state, { verb: "PATROL", caste: "soldier", count: 2, tileX: 48, tileY: 40 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    survives();
    expect(b).toMatchObject({ caste: "soldier", count: 2, revision: 1 });
    for (const ant of nearB) expect(ant.claim).toBeUndefined();
    expect(claimed(state, b)).toEqual(freeSoldiers.map((s) => s.id));

    // Soldier back to flyer: its soldiers are released as on main (each holds its tile) and flyers recruited.
    state.tick = 700;
    expect(send(state, { verb: "PATROL", caste: "flyer", count: 2, tileX: 48, tileY: 40 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    survives();
    expect(b).toMatchObject({ caste: "flyer", revision: 2 });
    for (const s of freeSoldiers) expect(s).toMatchObject({ claim: undefined, holdPoint: { tileX: 48, tileY: s === freeSoldiers[0] ? 46 : 47 } });
    expect(claimed(state, b)).toEqual(nearB.map((f) => f.id));

    // Ground PATROL re-laid as caste flyer: its soldiers released, the spare flyers recruited.
    state.tick = 1000;
    expect(send(state, { verb: "PATROL", caste: "flyer", count: 2, tileX: 56, tileY: 58 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    survives();
    expect(ground).toMatchObject({ caste: "flyer", revision: 1 });
    for (const s of groundSoldiers) expect(s).toMatchObject({ claim: undefined, holdPoint: { tileX: 56, tileY: s.y === groundSoldiers[0]!.y ? 60 : 61 } });
    expect(claimed(state, ground)).toEqual(spare.map((f) => f.id));

    // A lowered count releases the farthest member first.
    state.tick = 1200;
    expect(send(state, { verb: "PATROL", caste: "flyer", count: 1, tileX: 56, tileY: 40 }).error).toBeNull();
    claimCountMarks(state, state.tick);
    survives();
    expect(c).toMatchObject({ count: 1, revision: 1 });
    expect(claimed(state, c)).toEqual([nearC[0]!.id]);
    expect(nearC[1]!.claim).toBeUndefined();

    // Lifetimes run from first laying, whatever the re-lays: the oldest flyer mark expires first, at its laid tick + 1800.
    const life = state.config.markLifetimeTicks;
    expect(life).toBe(1800);
    expireMarks(state, a.laidTick + life - 1);
    expect(state.marks).toHaveLength(4);
    expireMarks(state, a.laidTick + life);
    expect(state.marks.map((m) => m.id)).toEqual(order.slice(1));
    claimCountMarks(state, a.laidTick + life);
    for (const ant of nearA) expect(ant.claim).toBeUndefined();
    expect(claimed(state, b)).toEqual(nearB.map((f) => f.id));
    expireMarks(state, b.laidTick + life);
    expect(state.marks.map((m) => m.id)).toEqual(order.slice(2));
    expireMarks(state, ground.laidTick + life);
    expect(state.marks).toEqual([]);
  });
});
