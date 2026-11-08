import { afterEach, describe, expect, it } from "vitest";
import { applyInput, defaultAllocator, EMPTY_SQUAD_COUNT_MARK, foundQueen } from "../../src/sim/agents.js";
import { COLONY_NAMES, rulesConfig, SUB } from "../../src/sim/config.js";
import type { Agent, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { cloneState, createMatch, nestTile } from "../../src/sim/map.js";
import { addAnt, emptyMatch, ownerAt, setOwner } from "../sim/fixtures.js";
import { claimCountMarks } from "../../src/sim/marks.js";
import { stateHash } from "../../src/sim/log.js";
import { step } from "../../src/sim/step.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

const liveRules = { ...playable(rulesConfig("redesign")), commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
// These original scenarios protect recorded capped-header behavior separately from live rules.
const rules = { ...liveRules, wordMarksDisabled: undefined, marksPerAgent: 3, countMarks: { ...liveRules.countMarks!, defendHolds: undefined } };
function fixture(): SimState {
  const s = emptyMatch(0, rules);
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  const ant = addAnt(s, 0, 8, 24, { squad: "a" }); agent.squad.push(ant.id); s.agents.push(agent);
  return s;
}
function count(s: SimState, tileX?: number, tileY?: number) {
  return applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX, tileY }, s.tick++, defaultAllocator, []);
}

describe("separate count and word placement rules", () => {
  it("refuses visible water for count, word and order-carried marks without consuming the command or changing an order", () => {
    const s = { ...fixture(), terrain: { mapId: "water-mark", mapName: "Water mark", water: [{ x: 40, y: 20, width: 1, height: 1 }] } };
    addAnt(s, 0, 39, 20);
    const inputs = [
      { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX: 40, tileY: 20 },
      { type: "mark", agentId: "a", words: ["HELP"], tileX: 40, tileY: 20 },
      { type: "order", agentId: "a", order: { kind: "forage" }, mark: { words: ["HELP"], tileX: 40, tileY: 20 } },
    ] satisfies import("../../src/sim/types.js").SimInput[];
    for (const input of inputs) {
      expect(applyInput(s, input, s.tick++, defaultAllocator, []).error?.code).toBe("water_tile");
      expect(s.marks).toHaveLength(0);
      expect(s.agents[0]!.lastCommandTick).toBeNull();
      expect(s.agents[0]!.order).toEqual({ kind: "hold" });
    }
    expect(count(s, 39, 20).error).toBeNull();
  });
  it("allows a target at the sight boundary of a free colony ant or teammate squad, outside the caller's own sight", () => {
    const s = fixture(), sight = rules.sightTiles; addAnt(s, 0, 40, 20); addAnt(s, 0, 20, 30, { squad: "teammate" });
    expect(count(s, 40 + sight, 20).error).toBeNull();
    expect(count(s, 20, 30 - sight).error).toBeNull();
    expect(count(s, 40 + sight, 21).error?.code).toBe("count_mark_not_visible");
    expect(count(s, 41 + sight, 20).error?.code).toBe("count_mark_not_visible");
  });
  it("uses only current living own ants; remembered food, enemy sight and dead ants do not qualify", () => {
    const s = fixture(); s.colonies[0].seenFood = [20 * rules.mapWidth + 40];
    addAnt(s, 1, 40, 20); addAnt(s, 0, 40, 20, { hp: 0 });
    expect(count(s, 40, 20).error?.code).toBe("count_mark_not_visible");
    expect(s.marks).toHaveLength(0);
    expect(s.agents[0]!.lastCommandTick).toBeNull();
  });
  it("keeps word and order-carried word marks on the caller's squad tile; keeps tile-less count placement", () => {
    const s = fixture(); addAnt(s, 0, 40, 20);
    expect(count(s, 40, 20).error).toBeNull();
    expect(applyInput(s, { type: "mark", agentId: "a", tileX: 40, tileY: 20, words: ["HELP"] }, s.tick++, defaultAllocator, []).error?.code).toBe("no_own_ant_on_tile");
    expect(applyInput(s, { type: "order", agentId: "a", order: { kind: "forage" }, mark: { tileX: 40, tileY: 20, words: ["HELP"] } }, s.tick++, defaultAllocator, []).error?.code).toBe("no_own_ant_on_tile");
    expect(s.agents[0]!.order.kind).toBe("hold");
    expect(count(s).error).toBeNull();
    expect(s.marks.at(-1)).toMatchObject({ tileX: 8, tileY: 24 });
  });
  it.each([[-1, 24], [64, 24], [8.5, 24], [8, 48], [NaN, 24], [8, Infinity]])("refuses invalid tile (%s,%s) without consuming a command", (x, y) => {
    const s = fixture(); expect(count(s, x, y).error?.code).toBe("count_mark_not_visible");
    expect(s.agents[0]!.lastCommandTick).toBeNull(); expect(s.marks).toHaveLength(0);
  });
  it("preserves historical count placement when the new config field is absent", () => {
    const s = fixture(); const historical = { ...s, config: { ...rules, countMarks: { ...rules.countMarks!, placement: undefined } } };
    addAnt(historical, 0, 40, 20);
    expect(count(historical, 40, 20).error?.code).toBe("no_own_ant_on_tile");
  });
});

function pendingMarkFixture(): SimState {
  const s = emptyMatch(0, { ...rules, squadSize: 0 });
  for (const id of ["a", "b"]) s.agents.push({ id, colony: 0, joinSeq: s.agents.length, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
  for (let i = 0; i < 6; i++) addAnt(s, 0, 40, 20);
  s.nextMarkId = 21;
  s.marks.push({ id: 20, agentId: "b", colony: 0, tileX: 40, tileY: 20, words: [], laidTick: 0, steering: 0, verb: "GATHER", count: 20 });
  return s;
}

describe("persistent empty marks with acceptance explanations", () => {
  it("reports free ants after an accepted count mark wakes an idle seat, without treating its former house guards as unavailable", () => {
    const config = { ...rules, commandIdleTicks: 1, squadSize: 0, guardCount: 0, guardSharePermille: 1000,
      queenFounding: { ...rules.queenFounding!, totalGuardSharePermille: 1000 } };
    const s = emptyMatch(10, config);
    s.agents.push({ id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" },
      lastCallTick: 0, lastCommandTick: null, joinedTick: 0, idle: true, pendingEvents: [] });
    Array.from({ length: 12 }, () => addAnt(s, 0, 8, 24, { role: "guard" }));
    const out = step(s, [{ type: "count_mark", agentId: "a", verb: "GATHER", count: 2, tileX: 8, tileY: 24 }]);
    expect(out.results[0]!.ok).toBe(true);
    const notice = out.results[0]!.view!.events.find((e) => e.type === "count_mark_accepted");
    expect(notice).toMatchObject({ availability: { claimedAnts: 0, freeAntsNow: 12 } });
    expect(out.state.agents[0]!.idle).toBe(false);
  });
  it("binds availability to the accepted command, not to an earlier concurrent observe from the same agent", () => {
    const out = step(pendingMarkFixture(), [{ type: "observe", agentId: "a" },
      { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX: 41, tileY: 20 }]);
    expect(out.results[0]!.view!.events.some((e) => e.type === "count_mark_accepted")).toBe(false);
    expect(out.results[1]!.view!.events).toContainEqual(expect.objectContaining({ type: "count_mark_accepted", markId: 21,
      availability: { claimedAnts: 0, freeAntsNow: 6 } }));
    expect(out.state.agents[0]!.pendingEvents).toEqual([]);
  });
});

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

it("keeps accepting a zero-free mark, reports the exact message, and recruits when an ant frees up", async () => {
  const config = { ...rules, squadSupplyPermille: 1000, squadSize: 6 }, s = emptyMatch(0, config);
  for (let i = 0; i < 6; i++) addAnt(s, 0, 8, 24);
  h = await startHarness({ simConfig: config, state: s });
  const agent = await h.connect();
  await agent.call("join", { colony: COLONY_NAMES[0] });
  const accepted = await agent.call("count_mark", { verb: "GATHER", count: 2, tileX: 8, tileY: 24 });
  expect(accepted.isError, accepted.text).toBe(false);
  expect(accepted.data.countMark).toMatchObject({ claimedAnts: 0, freeAntsNow: 0,
    message: "0 free ants now; this mark recruits as ants hatch or free up" });
  expect(h.game.match!.state.marks).toHaveLength(1);
  const markId = h.game.match!.state.marks[0]!.id;
  expect(h.game.match!.state.ants.some((a) => a.claim === markId)).toBe(false);
  addAnt(h.game.match!.state, 0, 8, 24);
  h.advance(1);
  expect(h.game.match!.state.marks[0]!.id).toBe(markId);
  expect(h.game.match!.state.ants.some((a) => a.claim === markId)).toBe(true);
});


it("gives mark-kind-specific MCP recovery guidance rather than falsely requiring a count target under the caller's squad", async () => {
  const s = emptyMatch(0, rules);
  for (let i = 0; i < 24; i++) addAnt(s, 0, 8, 24);
  addAnt(s, 0, 40, 20);
  h = await startHarness({ simConfig: rules, state: s });
  const agent = await h.connect();
  expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
  const valid = await agent.call("count_mark", { verb: "ATTACK", count: 2, tileX: 40, tileY: 20 });
  expect(valid.isError, valid.text).toBe(false);
  const unseen = await agent.call("count_mark", { verb: "ATTACK", count: 2, tileX: 63, tileY: 0 });
  expect(unseen.data.error.code).toBe("count_mark_not_visible");
  expect(unseen.data.error.howToFix).toContain("any living ant of your colony");
  const word = await agent.call("mark", { tileX: 40, tileY: 20, words: ["HELP"] });
  expect(word.data.error.code).toBe("no_own_ant_on_tile");
  expect(word.data.error.howToFix).toContain("own squad ant");
  const remote = h.game.match!.state.ants.find((ant) => Math.floor(ant.x / SUB) === 40)!;
  expect(remote.squad).toBeNull();
});

it("live MCP accepts lowering the same DEFEND mark to one ant at the former 18-of-30 claim cap", async () => {
  const config = { ...liveRules, hatchIntervalTicks: Number.MAX_SAFE_INTEGER };
  const initial = emptyMatch(0, config);
  for (let i = 0; i < 30; i++) addAnt(initial, 0, 8, 24);
  h = await startHarness({ simConfig: config, state: initial });
  const agent = await h.connect();
  const joined = await agent.call("join", { colony: COLONY_NAMES[0] });
  expect(joined.isError, joined.text).toBe(false);
  expect(h.game.match!.state.agents[0]!.squad).toHaveLength(6);
  const site = { tileX: 8, tileY: 24 };
  const first = await agent.call("count_mark", { verb: "DEFEND", count: 18, ...site });
  expect(first.isError, first.text).toBe(false);
  const before = h.game.match!.state;
  const markId = before.marks[0]!.id;
  expect(before.ants.filter(ant => ant.colony === 0 && ant.hp > 0)).toHaveLength(30);
  expect(before.ants.filter(ant => ant.colony === 0 && ant.hp > 0 && ant.claim === markId)).toHaveLength(18);
  expect(Math.floor(30 * 600 / 1000)).toBe(18); // The removed colony-share ceiling is full.
  expect(before.marks[0]).toMatchObject({ id: markId, verb: "DEFEND", count: 18, ...site });
  h.advance(Math.max(0, first.data.nextCommandTick - before.tick));
  const lowered = await agent.call("count_mark", { verb: "DEFEND", count: 1, ...site });
  expect(lowered.isError, lowered.text).toBe(false);
  expect(lowered.data.accepted).toBe(true);
  expect(lowered.text).not.toContain("claim_cap_reached");
  expect(lowered.data.countMark).toMatchObject({ markId, claimed: 1 });
  const after = h.game.match!.state;
  expect(after.marks).toHaveLength(1);
  expect(after.marks[0]).toMatchObject({ id: markId, verb: "DEFEND", count: 1, ...site });
  expect(after.ants.filter(ant => ant.colony === 0 && ant.hp > 0)).toHaveLength(30);
  expect(after.ants.filter(ant => ant.colony === 0 && ant.hp > 0 && ant.claim === markId)).toHaveLength(1);
});

it("live count_mark accepts a large request with no free ants, reports zero and retains it to recruit", async () => {
  const h = await startHarness({ simConfig: liveRules });
  try {
    const a = await h.connect(); const joined = await a.call("join", { colony: COLONY_NAMES[0] });
    const s = h.game.match!.state;
    s.ants = s.ants.filter(ant => ant.colony !== 0 || ant.squad === joined.data.agentId);
    const accepted = await a.call("count_mark", { verb: "GATHER", count: 512 });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(accepted.data.countMark).toMatchObject({ claimedAnts: 0, freeAntsNow: 0 });
    expect(accepted.data.countMark.message).toBe("0 free ants now; this mark recruits as ants hatch or free up");
    expect(JSON.stringify(accepted.data)).not.toMatch(/claimableAnts|claimCap|claim cap reached/);
    const mark = h.game.match!.state.marks[0]!;
    expect(mark.count).toBe(512);
    const free = addAnt(h.game.match!.state, 0, mark.tileX, mark.tileY);
    claimCountMarks(h.game.match!.state, h.game.match!.state.tick);
    expect(free.claim).toBe(mark.id);
  } finally { await h.close(); }
});

it.each(["worker", "soldier", "any", undefined])("advertises caste and returns the effective %s through command replies and history", async caste => {
  const s = emptyMatch(0, liveRules);
  for (let i = 0; i < 16; i++) addAnt(s, 0, 8, 24, { caste: i % 2 ? "soldier" : "worker" });
  h = await startHarness({ simConfig: liveRules, state: s });
  const agent = await h.connect();
  await agent.call("join", { colony: COLONY_NAMES[0] });
  const tool = (await agent.client.listTools()).tools.find(tool => tool.name === "count_mark")!;
  expect(tool.inputSchema.properties!.caste).toMatchObject({ enum: ["any", "worker", "soldier"] });
  expect(tool.inputSchema.required).not.toContain("caste");
  const reply = await agent.call("count_mark", { verb: "GATHER", count: 2, tileX: 8, tileY: 24,
    ...(caste === undefined ? {} : { caste }) });
  expect(reply.isError, reply.text).toBe(false);
  const effective = caste ?? "any";
  expect(reply.data.mark).toMatchObject({ claimed: 2 });
  expect(reply.data.countMark).toMatchObject({ claimed: 2 });
  if (effective === "any") {
    expect(reply.data.mark).not.toHaveProperty("caste");
    expect(reply.data.countMark).not.toHaveProperty("caste");
  } else {
    expect(reply.data.mark.caste).toBe(effective);
    expect(reply.data.countMark.caste).toBe(effective);
  }
  const own = h.game.match!.state.marks[0]!;
  const recruited = h.game.match!.state.ants.filter(ant => ant.claim === own.id);
  if (effective !== "any") expect(recruited.every(ant => ant.caste === effective)).toBe(true);
  const current = await agent.call("observe");
  expect(current.data.view.events.some((event: SimEvent) => event.type === "mark_laid" || event.type === "count_mark_accepted")).toBe(true);
  const history = await agent.call("observe", { since: 0 });
  const notices = history.data.view.events.filter((event: SimEvent) => event.type === "mark_laid" || event.type === "count_mark_accepted");
  expect(notices.length).toBeGreaterThan(0);
  for (const entry of [history.data.view.marks[0], history.data.view.myMarks[0], ...notices]) {
    if (effective === "any") expect(entry).not.toHaveProperty("caste");
    else expect(entry.caste).toBe(effective);
  }
  for (const event of current.data.view.events.filter((event: SimEvent) => event.type === "mark_laid" || event.type === "count_mark_accepted")) {
    if (effective === "any") expect(event).not.toHaveProperty("caste");
    else expect(event.caste).toBe(effective);
  }
  // Formatting must never alter the retained simulation events used by replay and the identity proof.
  const retained = h.game.eventHistory(own.agentId);
  expect(retained.filter(event => event.type === "mark_laid" || event.type === "count_mark_accepted"))
    .toEqual(expect.arrayContaining([expect.objectContaining({ caste: effective })]));
  for (const response of [reply, history, current]) {
    expect(JSON.parse(response.text)).toEqual(response.data);
  }
  const relaid = await agent.call("count_mark", { verb: "GATHER", count: 2, tileX: 8, tileY: 24, caste: "worker" });
  expect(relaid.isError, relaid.text).toBe(false);
  expect(relaid.data.countMark.caste).toBe("worker");
});

it.each(["queen", "Worker", "", null, 2])("MCP refuses invalid caste %j without applying a command", async caste => {
  h = await startHarness({ simConfig: liveRules });
  const agent = await h.connect();
  await agent.call("join");
  const before = JSON.stringify(h.game.match!.state.marks);
  const reply = await agent.call("count_mark", { verb: "GATHER", count: 2, caste });
  expect(reply.isError).toBe(true);
  expect(reply.data.error.message).toContain("any, worker, soldier");
  expect(JSON.stringify(h.game.match!.state.marks)).toBe(before);
});

describe("an out-of-sight count mark refusal names the nearest tile it would be accepted on", () => {
  const refuse = (s: SimState, tileX?: number, tileY?: number) =>
    applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX, tileY }, s.tick, defaultAllocator, []);
  // The offered tile comes from within sightTiles - 2 of a living own ant, not the sight edge. At tile size 2
  // sight is rules.sightTiles; the 2-tile margin is the unchanged SIGHT_MARGIN_TILES, in sim tiles.
  const r = rules.sightTiles, inner = r - 2;
  it("names the nearest tile inside the sight margin, changes no state, and re-laying there is accepted", () => {
    const s = fixture(); addAnt(s, 0, 40, 20);
    const before = stateHash(s);
    const refused = refuse(s, 40 + r + 4, 20);
    expect(refused.error).toMatchObject({ code: "count_mark_not_visible", nearestTile: { tileX: 40 + inner, tileY: 20 } });
    expect(stateHash(s)).toBe(before);
    expect(count(s, 40 + inner, 20).error).toBeNull();
    expect(s.marks.at(-1)).toMatchObject({ tileX: 40 + inner, tileY: 20, verb: "ATTACK" });
  });
  it("keeps the offered tile accepted after its ant moves one tile in any direction; the old edge tile is not", () => {
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const) {
      const s = fixture(); const ant = addAnt(s, 0, 40, 20);
      const named = refuse(s, 40 + r + 4, 20).error?.nearestTile;
      expect(named).toEqual({ tileX: 40 + inner, tileY: 20 });
      ant.x += dx * SUB; ant.y += dy * SUB;
      expect(count(s, named!.tileX, named!.tileY).error, `${dx},${dy}`).toBeNull();
    }
    const edge = fixture(); const ant = addAnt(edge, 0, 40, 20);
    ant.x -= SUB;
    expect(count(edge, 40 + r, 20).error?.code).toBe("count_mark_not_visible");
  });
  it("falls back to the full sight circle only when no tile inside the margin qualifies", () => {
    const s = { ...fixture(), terrain: { mapId: "inner-water", mapName: "Inner water",
      water: [{ x: 40 - inner, y: 20 - inner, width: 2 * inner + 1, height: 2 * inner + 1 }], rocks: [] } };
    s.ants[0]!.hp = 0; for (let i = 0; i < 4; i++) addAnt(s, 0, 40, 20); // Enough live ants for a nonzero claim cap.
    const named = refuse(s, 40 + r + 4, 20).error?.nearestTile;
    expect(named).toEqual({ tileX: 40 + r, tileY: 20 });
    expect(count(s, 40 + r, 20).error).toBeNull();
  });
  it("breaks equal distances to the lower tileY, then the lower tileX", () => {
    const open = { mapId: "open", mapName: "Open", water: [], rocks: [] };
    // Each ant stands sight + 4 tiles from the target, so the target is 4 tiles outside both sights.
    const away = r + 4;
    const s = { ...fixture(), terrain: open }; addAnt(s, 0, 40 - away, 20); addAnt(s, 0, 40 + away, 20);
    expect(refuse(s, 40, 20).error?.nearestTile).toEqual({ tileX: 40 - away + inner, tileY: 20 });
    const t = { ...fixture(), terrain: open }; addAnt(t, 0, 40, 20 - away); addAnt(t, 0, 40, 20 + away);
    expect(refuse(t, 40, 20).error?.nearestTile).toEqual({ tileX: 40, tileY: 20 - away + inner });
  });
  it("skips water and rock tiles the same count mark would be refused on", () => {
    const s = { ...fixture(), terrain: { mapId: "blocked", mapName: "Blocked", water: [{ x: 40 + inner, y: 20, width: 1, height: 1 }],
      rocks: [{ x: 40 + inner - 1, y: 20, width: 1, height: 1, appearance: 0 }] } };
    addAnt(s, 0, 40, 20);
    const named = refuse(s, 40 + r + 4, 20).error?.nearestTile;
    expect(named).toEqual({ tileX: 40 + inner - 1, tileY: 19 });
    expect(count(s, named!.tileX, named!.tileY).error).toBeNull();
  });
  it("says no tile qualifies when the colony has no living ant; non-finite refusals carry no tile", () => {
    const s = fixture(); for (const ant of s.ants) ant.hp = 0;
    const refused = refuse(s, 40, 20);
    expect(refused.error?.code).toBe("count_mark_not_visible");
    expect(refused.error?.nearestTile).toBeNull();
    expect(refuse(fixture(), NaN, 20).error).not.toHaveProperty("nearestTile");
  });
  it("an omitted tile with an empty squad says the squad is empty and names a tile at a living own ant", () => {
    const empty = fixture(); empty.agents[0]!.squad = []; empty.ants[0]!.squad = null;
    for (let i = 0; i < 3; i++) addAnt(empty, 0, 8, 24); // Enough live ants for a nonzero claim cap.
    expect(refuse(empty).error).toEqual({ code: "count_mark_not_visible", message: EMPTY_SQUAD_COUNT_MARK, nearestTile: { tileX: 8, tileY: 24 } });
    expect(count(empty, 8, 24).error).toBeNull();
    const none = fixture(); none.agents[0]!.squad = []; none.ants[0]!.squad = null; none.ants[0]!.hp = 0;
    expect(refuse(none).error).toEqual({ code: "count_mark_not_visible", message: EMPTY_SQUAD_COUNT_MARK, nearestTile: null });
  });
  it("the empty-squad offered tile is still accepted after every own ant moves one tile in any direction", () => {
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const) {
      const s = fixture(); s.agents[0]!.squad = []; s.ants[0]!.squad = null;
      for (let i = 0; i < 3; i++) addAnt(s, 0, 8, 24);
      const named = refuse(s).error?.nearestTile;
      expect(named).toEqual({ tileX: 8, tileY: 24 });
      for (const ant of s.ants) { ant.x += dx * SUB; ant.y += dy * SUB; }
      expect(count(s, named!.tileX, named!.tileY).error, `${dx},${dy}`).toBeNull();
    }
  });
});

it("MCP out-of-sight count_mark refusal carries nearestTile and a re-lay there is accepted", async () => {
  const s = emptyMatch(0, rules);
  for (let i = 0; i < 24; i++) addAnt(s, 0, 8, 24);
  addAnt(s, 0, 40, 20);
  h = await startHarness({ simConfig: rules, state: s });
  const agent = await h.connect();
  expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
  const edge = 40 + rules.sightTiles;
  const unseen = await agent.call("count_mark", { verb: "ATTACK", count: 2, tileX: edge + 4, tileY: 20 });
  expect(unseen.data.error.code).toBe("count_mark_not_visible");
  // Rules 27 (these rules) states reach as sight from living ants now; rules 26 keeps the earlier text.
  expect(unseen.data.error.message).toBe("That count-mark tile is out of reach of your colony's living ants now.");
  const offered = 40 + rules.sightTiles - 2; // Margin at tile size 2: sightTiles - 2 sim tiles.
  expect(unseen.data.nearestTile).toEqual({ tileX: offered, tileY: 20 });
  expect(unseen.data.error.howToFix).toContain(`inside a circle of radius ${rules.sightTiles} tiles around any living ant of your colony (dx²+dy² ≤ ${rules.sightTiles ** 2}, from the ant's tile)`);
  expect(unseen.data.error.howToFix).toContain(`Nearest tile this count mark would be accepted on now: (${offered},20) (nearestTile).`);
  const relaid = await agent.call("count_mark", { verb: "ATTACK", count: 2, ...unseen.data.nearestTile });
  expect(relaid.isError, relaid.text).toBe(false);
  expect(relaid.data.mark).toMatchObject({ tileX: offered, tileY: 20 });
});

it("MCP empty-squad tile-less count_mark names the empty squad, not range, and offers a tile that is accepted", async () => {
  const s = emptyMatch(0, rules);
  for (let i = 0; i < 4; i++) addAnt(s, 0, 40, 20);
  h = await startHarness({ simConfig: rules, state: s });
  const agent = await h.connect();
  expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
  for (const a of h.game.match!.state.agents) a.squad = [];
  for (const ant of h.game.match!.state.ants) ant.squad = null;
  const refused = await agent.call("count_mark", { verb: "ATTACK", count: 2 });
  expect(refused.data.error.code).toBe("count_mark_not_visible");
  expect(refused.data.error.message).toBe(EMPTY_SQUAD_COUNT_MARK);
  expect(refused.data.error.howToFix).toContain("Give tileX and tileY");
  expect(refused.data.error.howToFix).toContain(`inside a circle of radius ${rules.sightTiles} tiles around any living ant of your colony`);
  expect(refused.data.error.howToFix).toContain("refill your squad");
  expect(refused.data.error.howToFix).not.toMatch(/omit|within range/i);
  expect(refused.data.nearestTile).toEqual({ tileX: 40, tileY: 20 });
  const relaid = await agent.call("count_mark", { verb: "ATTACK", count: 2, ...refused.data.nearestTile });
  expect(relaid.isError, relaid.text).toBe(false);
});

describe("water and rock refusals name the nearest tile the same command's tile rules accept", () => {
  const blocked = { mapId: "blocked", mapName: "Blocked", water: [{ x: 40, y: 20, width: 1, height: 1 }],
    rocks: [{ x: 41, y: 20, width: 1, height: 1, appearance: 0 }] };
  it.each([[40, "water_tile"], [41, "rock_tile"]] as const)("count marks at x=%i: %s with an in-sight clear tile, re-laid there", (tileX, code) => {
    const s = { ...fixture(), terrain: blocked }; addAnt(s, 0, 39, 20);
    const before = stateHash(s);
    const refused = applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX, tileY: 20 }, s.tick, defaultAllocator, []);
    expect(refused.error?.code).toBe(code);
    expect(stateHash(s)).toBe(before);
    const named = refused.error?.nearestTile;
    expect(named).toEqual(tileX === 40 ? { tileX: 40, tileY: 19 } : { tileX: 41, tileY: 19 });
    expect(count(s, named!.tileX, named!.tileY).error).toBeNull();
  });
  it.each([[40, "water_tile"], [41, "rock_tile"]] as const)("count marks at x=%i: the %s offered tile is accepted after the seeing ant moves one tile", (tileX, code) => {
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const) {
      const s = { ...fixture(), terrain: blocked }; const ant = addAnt(s, 0, 39, 20);
      const refused = applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX, tileY: 20 }, s.tick++, defaultAllocator, []).error;
      expect(refused?.code).toBe(code);
      const named = refused?.nearestTile;
      expect(named).not.toBeNull();
      ant.x += dx * SUB; ant.y += dy * SUB;
      expect(count(s, named!.tileX, named!.tileY).error, `${dx},${dy}`).toBeNull();
    }
  });
  it.each([[40, "water_tile"], [41, "rock_tile"]] as const)("word and order-carried marks at x=%i: %s name a clear squad-ant tile", (tileX, code) => {
    const s = { ...fixture(), terrain: blocked };
    for (const input of [{ type: "mark", agentId: "a", words: ["HELP"], tileX, tileY: 20 },
      { type: "order", agentId: "a", order: { kind: "forage" }, mark: { words: ["HELP"], tileX, tileY: 20 } }] satisfies SimInput[]) {
      expect(applyInput(s, input, s.tick++, defaultAllocator, []).error).toMatchObject({ code, nearestTile: { tileX: 8, tileY: 24 } });
    }
    expect(applyInput(s, { type: "mark", agentId: "a", words: ["HELP"], tileX: 8, tileY: 24 }, s.tick++, defaultAllocator, []).error).toBeNull();
    const empty = { ...fixture(), terrain: blocked }; empty.agents[0]!.squad = []; empty.ants[0]!.squad = null;
    expect(applyInput(empty, { type: "mark", agentId: "a", words: ["HELP"], tileX, tileY: 20 }, 0, defaultAllocator, []).error)
      .toMatchObject({ code, nearestTile: null });
  });
  it("a count mark says none exists when no living own ant sees clear land", () => {
    const s = { ...fixture(), terrain: blocked }; for (const ant of s.ants) ant.hp = 0;
    expect(count(s, 40, 20).error).toMatchObject({ code: "water_tile", nearestTile: null });
  });
  it("a LINE second end on water or rock names a tile the same LINE then accepts", () => {
    const s = { ...emptyMatch(0, liveRules), terrain: { ...blocked, water: [{ x: 12, y: 24, width: 1, height: 1 }], rocks: [{ x: 13, y: 24, width: 1, height: 1, appearance: 0 }] } };
    const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
    agent.squad.push(addAnt(s, 0, 8, 24, { squad: "a" }).id); s.agents.push(agent);
    const line = (toTileX: number, toTileY: number) => applyInput(s, { type: "count_mark", agentId: "a", verb: "LINE", count: 2,
      tileX: 8, tileY: 24, toTileX, toTileY }, s.tick++, defaultAllocator, []);
    for (const [x, code] of [[12, "water_tile"], [13, "rock_tile"]] as const) {
      const refused = line(x, 24);
      expect(refused.error?.code).toBe(code);
      expect(refused.error?.nearestTile).not.toBeNull();
      agent.lastCommandTick = null;
      expect(line(refused.error!.nearestTile!.tileX, refused.error!.nearestTile!.tileY).error).toBeNull();
      agent.lastCommandTick = null;
    }
  });
  it("founding on water or rock names the nearest held clear tile with nest spacing, or null when none is held", () => {
    const base = createMatch(1, liveRules);
    const rules = base.config.queenFounding!;
    const nest = nestTile(base.config, 0);
    // At grid scale 2 a nest centre lies on a fine-tile corner; use the fine tile containing it (as test/sim/terrain.test.ts).
    const spot = { x: Math.floor(nest.tx) + rules.minDistanceTiles + 1, y: Math.floor(nest.ty) };
    for (const code of ["water_tile", "rock_tile"] as const) {
      const state = { ...cloneState(base), terrain: code === "water_tile" ? { mapId: "w", mapName: "W", water: [{ x: spot.x, y: spot.y, width: 1, height: 1 }], rocks: [] }
        : { mapId: "r", mapName: "R", water: [], rocks: [{ x: spot.x, y: spot.y, width: 1, height: 1, appearance: 0 }] } };
      for (let y = 0; y < state.config.mapHeight; y++) for (let x = 0; x < state.config.mapWidth; x++) setOwner(state, x, y, -1);
      for (let y = spot.y - 2; y <= spot.y + 2; y++) for (let x = spot.x - 2; x <= spot.x + 2; x++) setOwner(state, x, y, 0);
      const before = stateHash(state);
      const refused = foundQueen(state, 0, spot.x, spot.y, 0, []);
      expect(refused?.code).toBe(code);
      expect(stateHash(state)).toBe(before);
      const named = refused!.nearestTile!;
      expect(named).not.toBeNull();
      expect(ownerAt(state, named.tileX, named.tileY)).toBe(0);
      expect((named.tileX - spot.x) ** 2 + (named.tileY - spot.y) ** 2).toBe(1);
      const retry = foundQueen(cloneState(state), 0, named.tileX, named.tileY, 0, []);
      expect(["water_tile", "rock_tile", "queen_tile_not_held", "queen_too_close"]).not.toContain(retry?.code);
      for (let y = 0; y < state.config.mapHeight; y++) for (let x = 0; x < state.config.mapWidth; x++) setOwner(state, x, y, -1);
      expect(foundQueen(state, 0, spot.x, spot.y, 0, [])).toMatchObject({ code, nearestTile: null });
    }
  });
  it("MCP water and rock refusals name the tile or say none exists", async () => {
    const s = { ...emptyMatch(0, rules), terrain: blocked };
    addAnt(s, 0, 39, 20);
    h = await startHarness({ simConfig: rules, state: s });
    const agent = await h.connect();
    expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
    const water = await agent.call("count_mark", { verb: "ATTACK", count: 2, tileX: 40, tileY: 20 });
    expect(water.data.error.code).toBe("water_tile");
    expect(water.data.nearestTile).toEqual({ tileX: 40, tileY: 19 });
    expect(water.data.error.howToFix).toContain("Nearest tile this command's tile rules accept now: (40,19) (nearestTile).");
    for (const ant of h.game.match!.state.ants) ant.hp = 0;
    const rock = await agent.call("count_mark", { verb: "ATTACK", count: 2, tileX: 41, tileY: 20 });
    expect(rock.data.error.code).toBe("rock_tile");
    expect(rock.data.nearestTile).toBeNull();
    expect(rock.data.error.howToFix).toContain("No tile passes this command's tile rules now (nearestTile null).");
  });
});

it("refuses bad rules-26 LINE ends through MCP with a fix naming the rule, and accepts a valid line", async () => {
  const s = emptyMatch(0, liveRules);
  for (let i = 0; i < 12; i++) addAnt(s, 0, 8, 24);
  h = await startHarness({ simConfig: liveRules, state: s });
  const agent = await h.connect();
  expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
  const same = await agent.call("count_mark", { verb: "LINE", count: 3, tileX: 8, tileY: 24, toTileX: 8, toTileY: 24 });
  expect(same.isError).toBe(true);
  expect(same.data.error.code).toBe("bad_count_mark");
  expect(same.data.error.howToFix).toContain("LINE needs whole-number tileX, tileY, toTileX and toTileY inside the map, two different end tiles");
  const other = await agent.call("count_mark", { verb: "GATHER", count: 3, tileX: 8, tileY: 24, toTileX: 10, toTileY: 24 });
  expect(other.isError).toBe(true);
  expect(other.data.error.howToFix).toContain("Only LINE takes toTileX/toTileY");
  expect(h.game.match!.state.marks).toHaveLength(0);
  const accepted = await agent.call("count_mark", { verb: "LINE", count: 3, tileX: 8, tileY: 24, toTileX: 12, toTileY: 24 });
  expect(accepted.isError, accepted.text).toBe(false);
  expect(h.game.match!.state.marks[0]).toMatchObject({ verb: "LINE", tileX: 8, tileY: 24, toTileX: 12, toTileY: 24, count: 3 });
});
