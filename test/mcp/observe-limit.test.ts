import { expect, it } from "vitest";
import { MAX_OBSERVE_TEXT_CHARS, OBSERVE_REPLY_LIMITS, pagedView } from "../../src/mcp/replies.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { buildGrid, newAnt } from "../../src/sim/map.js";
import { isPassable } from "../../src/sim/terrain.js";
import { expandCells, takeView, type DenseCells } from "../../src/sim/view.js";
import { prepareLargestView } from "./response-size-fixture.js";
import { startHarness } from "./harness.js";

/** The observe/join budget before it was raised. */
const PREVIOUS_OBSERVE_LIMITS = { textChars: 33_000, bytes: 68_950 } as const;

// A squad view whose mandatory cells exceed the previous 33,000-character
// budget but fit 49,000 was refused with observe_reply_too_large; it now succeeds.
it("an observe refused at 33,000 characters for its mandatory squad cells succeeds at the raised limit", async () => {
  const config = { ...withGridScale(rulesConfig("redesign")), antSpeedTilesPerSecond: 0, combatGraceTicks: 1_000_000 };
  const h = await startHarness({ simConfig: config });
  try {
    const agent = await h.connect(), join = await agent.call("join", { colony: COLONY_NAMES[0] });
    expect(join.isError, join.text).toBe(false);
    const agentId = join.data.agentId as string;
    prepareLargestView(h);
    const state = h.game.match!.state;
    const own = () => state.agents.find(a => a.id === agentId)!;
    const squad = takeView(state, buildGrid(state), own()).squad;
    expect(squad.length).toBeGreaterThan(0);
    // Crowd every passable tile within sight of the squad with extra ants of both colonies.
    const near: [number, number][] = [];
    for (let y = 0; y < config.mapHeight; y++) for (let x = 0; x < config.mapWidth; x++) {
      if (isPassable(state, x, y) && squad.some(ant => (ant.tileX - x) ** 2 + (ant.tileY - y) ** 2 <= config.sightTiles ** 2)) near.push([x, y]);
    }
    expect(near.length).toBeGreaterThan(0);
    for (let i = 0; i < 2_600; i++) {
      const [x, y] = near[i % near.length]!;
      const ant = newAnt(config, state.nextAntId++, (i % 2) as 0 | 1, tileCentre(x), tileCentre(y));
      state.ants.push(ant);
    }

    const view = takeView(state, buildGrid(state), own());
    const refused = pagedView(h.game, config, structuredClone(view), false, {}, undefined, PREVIOUS_OBSERVE_LIMITS);
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string; message: string } }).error)
      .toMatchObject({ code: "observe_reply_too_large", message: "Mandatory squad cells and metadata exceed the reply limits." });

    const accepted = pagedView(h.game, config, structuredClone(view), false, {}, undefined, OBSERVE_REPLY_LIMITS);
    expect(accepted.isError).toBeUndefined();
    const text = (accepted.content[0] as { text: string }).text;
    expect(text.length).toBeGreaterThan(PREVIOUS_OBSERVE_LIMITS.textChars);
    expect(text.length).toBeLessThanOrEqual(MAX_OBSERVE_TEXT_CHARS);
    const first = new Set(expandCells((accepted.structuredContent as { view: { cells: DenseCells } }).view.cells).map(cell => `${cell.tileX},${cell.tileY}`));
    for (const cell of view.cells) if (view.squad.some(ant => (ant.tileX - cell.tileX) ** 2 + (ant.tileY - cell.tileY) ** 2 <= config.sightTiles ** 2)) {
      expect(first.has(`${cell.tileX},${cell.tileY}`)).toBe(true);
    }
  } finally { await h.close(); }
});
