// A seated Quadrants match on a slot server's Game, under the production redesign rules, followed only through the MCP
// tools: once a seat's own colony is eliminated (for going idle, or on its last queen's death) every call it makes says
// so, with the tick and the reason, while the others play on and its observe keeps reporting the match; once the match
// ends every seated agent's calls give the winner by name, or a draw, and the result with its reason, also after the
// seats' records are retired to their final-result receipts; and in a same-tick all-idle end the winner is told its win
// and its own elimination together. That holds for every reply the seat gets: refusals of every kind, including the
// SDK's own (an unknown tool) and a call-rate refusal answered after the slot has seated a differently named lobby.
// A two-colony match's replies carry no elimination and are as before. Across slot reuse in either direction (a Quadrants
// match then a two-colony lobby, or a two-colony match then a Quadrants lobby), the observe cell decoder each session's
// tools/list advertises is the one its observe cells are served in.
import { afterEach, describe, expect, it } from "vitest";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import type { SimState } from "../../src/sim/types.js";
import { CELL_ENCODING, FLYER_CELL_ENCODING, FOUR_COLONY_CELL_ENCODING, FOUR_COLONY_FLYER_CELL_ENCODING } from "../../src/sim/view.js";
import { startHarness, TEST_MCP_CONFIG, type Harness, type TestAgent } from "./harness.js";

/** Test-only quadrant geometry, not a production map. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
const LIVE = newMatchConfig(rulesConfig("redesign"));
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const IDLE_SECONDS = 3;
const SEED = 4242;
/** A per-seat call limit the tests can reach on purpose; play() moves the clock a second each round. */
const CALLS_PER_SECOND = 20;
const MCP = { ...TEST_MCP_CONFIG, callsPerSecond: CALLS_PER_SECOND, houseIdleSeconds: IDLE_SECONDS };
const SEATS = [0, 1, 2, 3].map(colony => ({ identityId: `id-${colony}`, displayName: `Seat ${colony}`, colony }));
const keyOf = (colony: number) => `key-id-${colony}`;

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** A slot Game seating the four-seat Quadrants lobby, every seat joined from its own MCP session, at the match's first tick. */
async function started() {
  const h = await startHarness({ simConfig: LIVE, start: false, quadrantMaps: [FIXTURE], mcpConfig: MCP,
    slot: { identityOf: async key => SEATS.find(seat => keyOf(seat.colony) === key)?.identityId, locate: async () => undefined } });
  harnesses.push(h);
  h.game.seatLobby("quad-lobby", SEATS, "quadrants");
  const closesAt = h.game.beginLobbyStart(SEED);
  const seats: TestAgent[] = [];
  const agentIds: string[] = [];
  for (const seat of SEATS) {
    const agent = await h.connect();
    const joined = await agent.call("join", { key: keyOf(seat.colony) });
    expect([joined.isError, joined.data.colony], joined.text).toEqual([false, NAMES[seat.colony]]);
    seats.push(agent);
    agentIds.push(joined.data.agentId);
  }
  h.clock.now = closesAt;
  h.game.finishLobbyStart();
  h.advance(1);
  const state = (): SimState => h.game.match!.state;
  expect(state().colonies).toHaveLength(4);
  return { h, seats, agentIds, state };
}

/** Ticks until `until` holds: the `calling` colonies observe once every 5 ticks (a second apart), so their seats stay active. */
async function play(h: Harness, seats: readonly TestAgent[], calling: () => readonly number[], until: () => boolean) {
  for (let rounds = 0; !until(); rounds += 1) {
    if (rounds > 400) throw new Error("the match never reached the expected state");
    h.clock.now += 1000;
    await Promise.all(calling().map(colony => seats[colony]!.call("observe")));
    h.advance(4);
  }
}

interface Reply {
  readonly isError: boolean;
  readonly text: string;
  /** The reply's structuredContent; {} for a reply the SDK formed with text only. */
  readonly data: any;
  readonly structured: boolean;
}

/** One tool call, read as an agent reads it; a structured reply's text must be the same JSON document. */
async function call(seat: TestAgent, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const r = await seat.client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
  if (r.structuredContent !== undefined) expect(JSON.parse(text), name).toEqual(r.structuredContent);
  return { isError: r.isError === true, text, data: r.structuredContent ?? {}, structured: r.structuredContent !== undefined };
}

/** Test fixture, as the engine's own four-colony tests do it: every live queen of the colony is lost now, so the next tick eliminates it. */
function loseQueens(state: SimState, colony: number): void {
  for (const queen of state.colonies[colony]!.queens!) if (queen.lostTick === null) queen.lostTick = state.tick;
}

/**
 * One of each call a seat makes: observe, a command, an adapter refusal, an engine refusal, rules, a rejoin, a refused
 * join, a refused nest pick, and a call to a tool these rules do not offer, which the SDK refuses itself.
 */
async function everyCall(seat: TestAgent, colony: number): Promise<[string, Reply][]> {
  const calls: [string, string, Record<string, unknown>][] = [
    ["observe", "observe", {}],
    ["command", "order", { kind: "hold" }],
    ["adapter refusal", "order", { kind: "go_to" }],
    ["engine refusal", "count_mark", { verb: "GATHER", count: 0 }],
    ["rules", "rules", {}],
    ["rejoin", "join", { key: keyOf(colony) }],
    ["join refusal", "join", { key: keyOf(colony), modelLabel: "" }],
    ["nest refusal", "pick_nest", { tileX: 0, tileY: 0 }],
    ["unknown tool", "mark", { words: ["FOOD"] }],
  ];
  const replies: [string, Reply][] = [];
  for (const [label, name, args] of calls) replies.push([label, await call(seat, name, args)]);
  return replies;
}

/**
 * The observe cell decoder this session's tools/list advertises is the one its observe serves: the description carries
 * exactly one decoder, the encoding the served cells declare, and every served ant decodes by it to that ant in `match`
 * (hp, colony, caste). Returns how many ants were decoded.
 */
async function advertisedDecoderFits(seat: TestAgent, match: SimState, why: string): Promise<number> {
  const advertised = (await seat.client.listTools()).tools.find(tool => tool.name === "observe")!.description!;
  const four = advertised.includes(FOUR_COLONY_CELL_ENCODING);
  expect([four, advertised.includes(CELL_ENCODING)], `${why}: one advertised decoder`).toEqual([four, !four]);
  const observed = await call(seat, "observe");
  const cells = observed.data.view?.cells;
  expect(cells, `${why}: ${observed.text}`).toBeDefined();
  // Where the match has flyers, the served grammar adds the flyer clause to the advertised decoder, and the description
  // points to cells.encoding for it.
  const flyerGrammar = cells.encoding === FLYER_CELL_ENCODING || cells.encoding === FOUR_COLONY_FLYER_CELL_ENCODING;
  const decoder = cells.encoding === FLYER_CELL_ENCODING ? CELL_ENCODING : cells.encoding === FOUR_COLONY_FLYER_CELL_ENCODING ? FOUR_COLONY_CELL_ENCODING : cells.encoding;
  expect(advertised, `${why}: advertised decoder vs served encoding`).toContain(decoder);
  if (flyerGrammar) expect(advertised, `${why}: flyer states per cells.encoding`).toContain("In cells, each flyer in sight, yours or the enemy's, adds its state, grounded, flying or hovering, per cells.encoding.");
  // Two colonies: hp=floor(k/6), kind=k%6, even/odd colony, kind 0/1, 2/3, 4/5 = no caste, worker, soldier.
  // Four colonies: n=colonies; hp=floor(k/(3n)), r=k%(3n); colony=r%n; caste=floor(r/n).
  const n: number = four ? cells.colonies : 2;
  let decoded = 0;
  for (const row of (cells.data as string).split(";")) {
    const body = row.split("*")[0]!.split(":")[1];
    for (const record of body === undefined || body === "" ? [] : body.split("/")) {
      const [antId, k] = record.split(".").map(value => parseInt(value, 36)) as [number, number];
      const r = k % (3 * n);
      const ant = four ? { hp: Math.floor(k / (3 * n)), colony: r % n, caste: Math.floor(r / n) }
        : { hp: Math.floor(k / 6), colony: (k % 6) % 2, caste: Math.floor((k % 6) / 2) };
      const live = match.ants.find(other => other.id === antId);
      expect(ant, `${why}: ant ${antId}`).toEqual({ hp: live?.hp, colony: live?.colony,
        caste: live?.caste === undefined ? 0 : live.caste === "worker" ? 1 : 2 });
      decoded += 1;
    }
  }
  return decoded;
}

/** The engine's record of a colony's elimination, as a reply states it: tick and reason, never scores. */
function engineElimination(state: SimState, colony: number) {
  const eliminated = state.colonies[colony]!.eliminated!;
  return { tick: eliminated.tick, reason: eliminated.reason };
}

describe("a Quadrants seat's calls after its colony is eliminated", () => {
  it("say so with the tick and reason on every call while the others play on, and observe keeps reporting the match", async () => {
    const { h, seats, state } = await started();
    // Colony 1 loses its last queen; colony 0 never calls again and goes idle; colonies 2 and 3 keep playing.
    loseQueens(state(), 1);
    h.advance(1);
    expect(engineElimination(state(), 1)).toMatchObject({ reason: "queens_killed" });
    await play(h, seats, () => [2, 3], () => state().colonies[0]!.eliminated !== undefined);
    const told = { 0: engineElimination(state(), 0), 1: engineElimination(state(), 1) };
    expect(told[0]).toMatchObject({ reason: "idle" });
    expect(state().result).toBeNull();

    for (const colony of [0, 1] as const) {
      for (const [label, reply] of await everyCall(seats[colony]!, colony)) {
        expect(reply.data.eliminated, `${label} of colony ${colony}: ${reply.text}`).toEqual(told[colony]);
        expect(reply.data, label).not.toHaveProperty("matchOver");
        // The SDK's own refusal keeps its message.
        if (label === "unknown tool") expect([reply.isError, reply.data.error]).toEqual([true, { code: "sdk_error", message: expect.stringContaining("mark") }]);
      }
      // Observe answers with the current tick, and no idle countdown implies the colony still plays.
      const observed = await seats[colony]!.call("observe");
      expect([observed.data.view.tick, observed.data.status[0]]).toEqual([state().tick, null]);
      expect(observed.data.view.colonyName).toBe(NAMES[colony]);
    }
    // The colonies still playing are told nothing of the kind.
    for (const colony of [2, 3]) {
      for (const [label, reply] of await everyCall(seats[colony]!, colony)) {
        expect(reply.data, `${label}: ${reply.text}`).not.toHaveProperty("eliminated");
        // Nothing to add: the SDK's own refusal is left exactly as the SDK formed it.
        if (label === "unknown tool") expect([reply.isError, reply.structured]).toEqual([true, false]);
      }
      expect(typeof (await seats[colony]!.call("observe")).data.status[0]).toBe("number");
    }
    // The match plays on, and the eliminated seats keep following it.
    await play(h, seats, () => [2, 3], () => state().tick >= told[0].tick + 40);
    expect(state().result).toBeNull();
    const later = await seats[0]!.call("observe");
    expect([later.data.view.tick, later.data.eliminated]).toEqual([state().tick, told[0]]);
  });
});

describe("a Quadrants match's end, for every seated agent", () => {
  it("names a colony 3 winner with the reason on every call of all four seats, also once their records are retired", async () => {
    const { h, seats, agentIds, state } = await started();
    loseQueens(state(), 1);
    h.advance(1);
    // Colony 0 goes idle first, then colony 2 stops calling: colony 3 is the last colony standing.
    await play(h, seats, () => [2, 3], () => state().colonies[0]!.eliminated !== undefined);
    await play(h, seats, () => [3], () => state().result !== null);
    const result = state().result!;
    expect(result).toMatchObject({ winner: 3, reason: "idle", decidedBy: "idle" });
    const told = [0, 1, 2].map(colony => engineElimination(state(), colony));
    expect(state().colonies[3]!.eliminated).toBeUndefined();

    const reported = (colony: number, label: string, reply: Reply) => {
      const why = `${label} of colony ${colony}: ${reply.text}`;
      expect([reply.data.matchOver, reply.data.winner, reply.data.result], why).toEqual([true, NAMES[3], result]);
      if (colony < 3) expect(reply.data.eliminated, why).toEqual(told[colony]);
      else expect(reply.data, why).not.toHaveProperty("eliminated");
    };
    const ended = async () => {
      h.clock.now += 1000;
      for (const [colony, seat] of seats.entries()) {
        for (const [label, reply] of await everyCall(seat, colony)) reported(colony, label, reply);
      }
    };
    await ended();
    for (const agentId of agentIds) expect(h.game.finalResultReceipt(agentId)?.result).toEqual(result);
    const quadrants = state();

    // Two later matches on this slot (a lobby whose one seat never joins, so each ends abandoned) retire these seats'
    // records; each session keeps only its final-result receipt.
    for (const [index, seed] of [7, 8].entries()) {
      h.game.seatLobby(`later-${index}`, [{ identityId: `later-${index}`, displayName: "Later", colony: 0 }]);
      if (index === 1) h.game.startMatch(seed);
      if (index === 0) {
        // The slot now plays a two-colony lobby, named its own way, while these seats' records remain: each session is
        // still told the four-colony decoder its observe cells use (before and after the slot's next match starts), and a
        // call over the seat's rate limit still names its own match's winner.
        h.clock.now += 1000;
        let decoded = 0;
        for (const [colony, seat] of seats.entries()) decoded += await advertisedDecoderFits(seat, quadrants, `colony ${colony}, next lobby seated`);
        expect(decoded).toBeGreaterThan(0);
        h.game.startMatch(seed);
        h.clock.now += 1000;
        for (const [colony, seat] of seats.entries()) await advertisedDecoderFits(seat, quadrants, `colony ${colony}, next match started`);
        expect(h.game.colonyNames()).toHaveLength(2);
        expect(h.game.colonyNames()[1]).not.toBe(NAMES[3]);
        for (const [colony, seat] of seats.entries()) {
          h.clock.now += 1000;
          for (let calls = 0; calls < CALLS_PER_SECOND; calls += 1) await call(seat, "observe");
          for (const name of ["observe", "rules", "order"]) {
            const refused = await call(seat, name, name === "order" ? { kind: "hold" } : {});
            expect(refused.data.error?.code, refused.text).toBe("call_rate");
            reported(colony, `rate-limited ${name}`, refused);
          }
        }
        h.advance(IDLE_SECONDS * LIVE.ticksPerSecond + 1);
        expect(state().result).toMatchObject({ reason: "abandoned" });
      }
    }
    for (const agentId of agentIds) expect(h.game.finalResultReceipt(agentId)).toBeUndefined();
    await ended();
  });

  it("gives a draw and its reason to all four seats", async () => {
    const { h, seats, state } = await started();
    // Test fixture: no ants, held tiles or deliveries anywhere, so the time-up order ties; then every queen is lost.
    const s = state();
    s.ants = [];
    for (const agent of s.agents) agent.squad = [];
    for (let i = 0; i < s.owner.length; i++) s.owner[i] = -1;
    for (const colony of [0, 1, 2, 3]) loseQueens(s, colony);
    h.advance(1);
    const result = state().result!;
    expect(result).toMatchObject({ winner: null, reason: "queens_killed", decidedBy: "draw" });
    for (const [colony, seat] of seats.entries()) {
      for (const [label, reply] of await everyCall(seat, colony)) {
        const why = `${label} of colony ${colony}: ${reply.text}`;
        expect([reply.data.matchOver, reply.data.winner, reply.data.result], why).toEqual([true, "draw", result]);
        expect(reply.data.eliminated, why).toEqual({ tick: result.tick, reason: "queens_killed" });
      }
    }
  });

  it("tells the winner of a same-tick all-idle end its win and its own elimination together, never as a loss", async () => {
    const { h, seats, state } = await started();
    // Every seat stays silent, so all four go idle on one tick and the time-up order picks the winner.
    await play(h, seats, () => [], () => state().result !== null);
    const result = state().result!;
    expect(result).toMatchObject({ reason: "idle" });
    expect(result.winner).not.toBeNull();
    const winner = result.winner!;
    expect(state().colonies.map(colony => colony.eliminated?.tick)).toEqual([0, 1, 2, 3].map(() => result.tick));
    for (const [label, reply] of await everyCall(seats[winner]!, winner)) {
      const why = `${label}: ${reply.text}`;
      expect([reply.data.matchOver, reply.data.winner, reply.data.result.winner], why).toEqual([true, NAMES[winner], winner]);
      expect(reply.data.eliminated, why).toEqual({ tick: result.tick, reason: "idle" });
      // No field says the colony lost; only the static guidance text (rules, briefing, howToFix) describes the idle rule.
      const { rules: _rules, briefing: _briefing, view: _view, error, ...fields } = reply.data;
      expect(JSON.stringify([fields, error?.code, error?.message]), why).not.toMatch(/\blos(e|er|es|t)\b/i);
    }
  });
});

describe("a two-colony match", () => {
  it("tells no seat of an elimination, live or after its idle end", async () => {
    const h = await startHarness({ simConfig: LIVE, start: false, mcpConfig: MCP,
      slot: { identityOf: async key => SEATS.find(seat => keyOf(seat.colony) === key)?.identityId, locate: async () => undefined } });
    harnesses.push(h);
    h.game.seatLobby("pair-lobby", SEATS.slice(0, 2));
    const seats: TestAgent[] = [];
    for (const colony of [0, 1]) {
      seats.push(await h.connect());
      expect((await seats[colony]!.call("join", { key: keyOf(colony) })).isError).toBe(false);
    }
    h.game.startMatch(SEED);
    h.advance(1);
    for (const [colony, seat] of seats.entries()) {
      for (const [label, reply] of await everyCall(seat, colony)) expect(reply.data, `${label}: ${reply.text}`).not.toHaveProperty("eliminated");
    }
    await play(h, seats, () => [0], () => h.game.match!.state.result !== null);
    expect(h.game.match!.state.result).toMatchObject({ winner: 0, reason: "idle" });
    for (const [colony, seat] of seats.entries()) {
      for (const [label, reply] of await everyCall(seat, colony)) {
        expect(reply.data, `${label}: ${reply.text}`).not.toHaveProperty("eliminated");
        // As before: a refused join or nest pick after the end carries no result in a two-colony match, and the SDK's
        // own refusal of an unknown tool keeps its SDK form.
        const unchanged = label === "join refusal" || label === "nest refusal" || label === "unknown tool";
        expect(reply.data.matchOver, `${label}: ${reply.text}`).toBe(unchanged ? undefined : true);
        if (label === "unknown tool") expect(reply.structured).toBe(false);
      }
    }
  });

  it("keeps advertising the two-colony decoder its cells use once the slot seats a Quadrants lobby and starts its match", async () => {
    const h = await startHarness({ simConfig: LIVE, start: false, quadrantMaps: [FIXTURE], mcpConfig: MCP,
      slot: { identityOf: async key => (key.startsWith("key-") ? key.slice(4) : undefined), locate: async () => undefined } });
    harnesses.push(h);
    const pair = [0, 1].map(colony => ({ identityId: `pair-${colony}`, displayName: `Pair ${colony}`, colony }));
    h.game.seatLobby("pair-lobby", pair);
    const seats: TestAgent[] = [];
    for (const seat of pair) {
      seats.push(await h.connect());
      expect((await seats[seat.colony]!.call("join", { key: `key-${seat.identityId}` })).isError).toBe(false);
    }
    h.game.startMatch(SEED);
    h.advance(1);
    expect(h.game.match!.state.colonies).toHaveLength(2);
    for (const [colony, seat] of seats.entries()) await advertisedDecoderFits(seat, h.game.match!.state, `colony ${colony}, live`);
    await play(h, seats, () => [0], () => h.game.match!.state.result !== null);
    const twoColony = h.game.match!.state;

    // The slot seats a Quadrants lobby: these sessions keep their two-colony match's decoder, before and after its
    // match starts, while the Quadrants seats are told the four-colony one.
    h.game.seatLobby("quad-lobby", SEATS, "quadrants");
    h.clock.now += 1000;
    let decoded = 0;
    for (const [colony, seat] of seats.entries()) decoded += await advertisedDecoderFits(seat, twoColony, `colony ${colony}, Quadrants lobby seated`);
    expect(decoded).toBeGreaterThan(0);
    const closesAt = h.game.beginLobbyStart(SEED);
    const quadrantSeats: TestAgent[] = [];
    for (const seat of SEATS) {
      quadrantSeats.push(await h.connect());
      expect((await quadrantSeats[seat.colony]!.call("join", { key: keyOf(seat.colony) })).isError).toBe(false);
    }
    h.clock.now = closesAt;
    h.game.finishLobbyStart();
    h.advance(1);
    const quadrants = h.game.match!.state;
    expect(quadrants.colonies).toHaveLength(4);
    h.clock.now += 1000;
    for (const [colony, seat] of seats.entries()) await advertisedDecoderFits(seat, twoColony, `colony ${colony}, Quadrants match started`);
    decoded = 0;
    for (const [colony, seat] of quadrantSeats.entries()) decoded += await advertisedDecoderFits(seat, quadrants, `Quadrants colony ${colony}`);
    expect(decoded).toBeGreaterThan(0);
  });
});
