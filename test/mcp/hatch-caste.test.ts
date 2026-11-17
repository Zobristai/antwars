import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SpectatorRecorder } from "../../src/live/model.js";
import { hatch } from "../../src/sim/forage.js";
import { hatchIntervalOf, rulesConfig, rulesVersionOf, SUB, type MapDefinition } from "../../src/sim/config.js";
import type { SimEvent } from "../../src/sim/types.js";
import { expandFlyers } from "../../src/sim/view.js";
import { addAnt, emptyMatch, HISTORICAL_DEFAULT_CONFIG } from "../sim/fixtures.js";
import { startHarness } from "./harness.js";

const QUADRANT: MapDefinition = {
  id: "hatch-fixture", name: "Hatch Fixture", water: [],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6,
    nestTileX: 7, nestTileY: 11, startArea: { x: 2, y: 4, width: 12, height: 15 },
    foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};

/** Run the installed and frozen released clients unchanged, against the real reply. */
function renderedEvents(reply: unknown, client: string): unknown {
  const script = `import { renderView } from ${JSON.stringify(new URL(client, import.meta.url).href)};
    let input = ''; for await (const part of process.stdin) input += part;
    const header = JSON.parse(renderView(JSON.parse(input)).split('\\n')[0]);
    process.stdout.write(JSON.stringify(header.view.events));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify(reply), encoding: "utf8", timeout: 10_000,
  });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout);
}

const CASES = [
  { brood: "workers", caste: "worker", diesBeforeObserve: false },
  { brood: "soldiers", caste: "soldier", diesBeforeObserve: false },
  { brood: "flyers", caste: "flyer", diesBeforeObserve: false },
  { brood: "flyers", caste: "flyer", diesBeforeObserve: true },
] as const;

describe.each([2, 4] as const)("hatch caste through observe with %i colonies", colonies => {
  it.each(CASES)("reports $caste, including retained history (dies before observe: $diesBeforeObserve)", async ({ brood, caste, diesBeforeObserve }) => {
    const seats = Array.from({ length: colonies }, (_, colony) => ({ identityId: `seat-${colony}`, displayName: `Seat ${colony}`, colony }));
    // No combat grace in this fixture: the death case must resolve a lethal fight on the next tick.
    const h = await startHarness({ start: false, simConfig: { ...rulesConfig("redesign"), combatGraceTicks: 0 }, quadrantMaps: [QUADRANT],
      slot: { identityOf: async key => seats.find(seat => key === seat.identityId)?.identityId, locate: async () => undefined } });
    try {
      h.game.seatLobby("hatch-lobby", seats, colonies === 4 ? "quadrants" : "1v1");
      const closesAt = h.game.beginLobbyStart(17);
      const agents = [];
      for (const seat of seats) {
        const agent = await h.connect();
        const joined = await agent.call("join", { key: seat.identityId });
        expect(joined.isError, joined.text).toBe(false);
        agents.push(agent);
      }
      h.clock.now = closesAt;
      h.game.finishLobbyStart();
      h.advance(1);
      // Exercise the third colony too: the event must not assume a two-colony id range.
      const colony = colonies === 4 ? 2 : 0;
      const agent = agents[colony]!;
      const changed = await agent.call("set_brood", { brood });
      expect(changed.isError, changed.text).toBe(false);
      const state = h.game.match!.state;
      expect(state.colonies).toHaveLength(colonies);
      expect(rulesVersionOf(state.config)).toBe(28);
      for (const own of state.colonies) own.foodStore = 0;
      const own = state.colonies[colony];
      own.foodStore = caste === "flyer" ? state.config.flyers!.cost : caste === "soldier" ? state.config.castes!.soldierCost : state.config.hatchCost;
      own.queens![0]!.lastHatchTick = state.tick - hatchIntervalOf(state.config, caste);
      const antId = state.nextAntId, tick = state.tick;
      const recorder = new SpectatorRecorder(state);
      const out = h.game.tick()!;
      const born = out.state.ants.find(ant => ant.id === antId)!;
      expect(born).toBeDefined();
      expect(born.caste).toBe(caste === "flyer" ? "worker" : caste);
      expect(born.flyer === true).toBe(caste === "flyer");
      const expected = { type: "hatch", tick, antId, colony, caste };
      expect(out.events).toContainEqual(expect.objectContaining(expected));
      // The recording's birth event intentionally has no caste: its format does not change.
      expect(recorder.record(out).events.filter(event => event.kind === "birth")).toContainEqual({ kind: "birth", antId });
      if (diesBeforeObserve) {
        born.hp = 1;
        const attacker = addAnt(out.state, colony === 0 ? 1 : 3, Math.floor(born.x / SUB), Math.floor(born.y / SUB),
          { x: born.x, y: born.y, caste: "soldier", hp: 100_000 });
        const death = h.game.tick()!;
        expect(death.events).toContainEqual(expect.objectContaining({ type: "death", antId }));
        expect(death.state.ants.some(ant => ant.id === antId)).toBe(false);
        // End the scripted fight so unrelated combat cannot fill the current event sample.
        const home = death.state.colonies[attacker.colony].queens![0]!;
        attacker.x = home.queenX;
        attacker.y = home.queenY;
      }
      const current = await agent.call("observe");
      expect(current.isError, current.text).toBe(false);
      expect(current.data.view.eventsMode).toBe("current");
      expect(current.data.view.events).toContainEqual(expect.objectContaining(expected));
      expect(JSON.parse(current.text)).toEqual(current.data);
      if (caste === "flyer" && !diesBeforeObserve) {
        expect(expandFlyers(current.data.view.flyers)).toContainEqual(expect.objectContaining({ antId }));
      }
      for (const client of ["../../packages/antwars-seat/lib/board.mjs", "../fixtures/seat-1.0.0/lib/board.mjs"]) {
        expect(renderedEvents(current.data, client)).toContainEqual(expect.objectContaining(expected));
      }
      const history = await agent.call("observe", { since: 0 });
      expect(history.isError, history.text).toBe(false);
      expect(history.data.view.eventsMode).toBe("history");
      expect(history.data.view.events).toContainEqual(expect.objectContaining(expected));
      expect(JSON.parse(history.text)).toEqual(history.data);
    } finally { await h.close(); }
  });
});

it("keeps hatch caste absent for historical configurations without castes", () => {
  const state = emptyMatch(5, HISTORICAL_DEFAULT_CONFIG);
  expect(state.config.castes).toBeUndefined();
  state.colonies[0].foodStore = state.config.hatchCost;
  state.colonies[0].lastHatchTick = -state.config.hatchIntervalTicks;
  const events: SimEvent[] = [];
  hatch(state, state.tick, events);
  const births = events.filter(event => event.type === "hatch");
  expect(births).toHaveLength(1);
  expect(births[0]).not.toHaveProperty("caste");
});
