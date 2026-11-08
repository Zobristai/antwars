/** The server's game starts a tuning-map match at a chosen per-side count with its queued agents seated. */
import { expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import { replay, stateHash } from "../../src/sim/log.js";
import { TUNING_MAP_ID, tuningMapConfig } from "../../src/sim/tuningMap.js";

it("starts a tuning-map match at the chosen count with one queued agent seated per colony on its first tick, under the logged server policy", async () => {
  const perSide = 1_024;
  const log: string[] = [];
  const game = new Game({ simConfig: tuningMapConfig(perSide), mcpConfig: DEFAULT_MCP_CONFIG, onLogLine: line => log.push(line) });
  const joins = [game.join({ colony: 0 }), game.join({ colony: 1 })];
  expect(game.queuedAgents).toBe(2);
  game.startMatch(6006);
  game.tick();
  const joined = await Promise.all(joins);
  expect(joined.map(j => j.outcome.kind)).toEqual(["queued", "queued"]);

  const state = game.match!.state;
  expect(state.terrain?.mapId).toBe(TUNING_MAP_ID);
  expect([state.config.startAnts, state.config.colonyCap]).toEqual([perSide, perSide]);
  expect(state.agents.map(agent => [agent.id, agent.colony, agent.joinedTick])).toEqual(joined.map((j, colony) => [j.agentId, colony, 0]));
  expect(state.ants.filter(ant => ant.colony === 0)).toHaveLength(perSide);
  expect(state.ants.filter(ant => ant.colony === 1)).toHaveLength(perSide);

  // The match log records the tuning config and the server's houseActive policy for the seating tick, and replays to this state.
  const [header, tick] = log.map(line => JSON.parse(line));
  expect(header).toMatchObject({ type: "header", seed: 6006, config: { startAnts: perSide, startAntLayout: "fill-start-area" } });
  expect(tick).toMatchObject({ tick: 0, houseActive: true, inputs: joined.map(j => expect.objectContaining({ type: "join", agentId: j.agentId })) });
  expect(stateHash(replay(log, 1))).toBe(stateHash(state));
});
