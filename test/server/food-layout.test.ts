import { readdirSync } from "node:fs";
import { get as httpGet } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { startServer, type GameServer } from "../../src/server.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { FoodLayoutError } from "../../src/sim/foodLayout.js";
import { comparison, settle, tempDir } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The grid-scale-2 build of the public rules: the layout a repaired fixture is restored to.
const PLAYABLE_PUBLIC = playable(PUBLIC_CONFIG);

function impossibleConfig() {
  return playable({ ...PUBLIC_CONFIG, matchTicks: 1,
    foodLayout: { ...PUBLIC_CONFIG.foodLayout!, placementAttempts: 1, layoutAttempts: 1,
      minStartingFood: 1, maxStartingFood: 1 } });
}

const errors = () => vi.mocked(console.error).mock.calls.map(args => args.join(" ")).join("\n");

async function assertServing(): Promise<void> {
  // Plain HTTP, not an MCP join or a player connection.
  expect((await fetch(`http://127.0.0.1:${server!.port}/mcp`)).status).toBe(400);
}

/** One plain request on /mcp with no pooled connection, so the client leaves no timer behind; resolves with its status. */
function requestMcp(): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet({ host: "127.0.0.1", port: server!.port, path: "/mcp", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    }).once("error", reject);
  });
}

describe("food-placement failures cannot escape the server's match-start boundary", () => {
  it("keeps a held comparison start idle and serving, reports the cause and retries at the next reply on /mcp", async () => {
    const dataDir = tempDir(), config = impossibleConfig();
    const matchStarted = vi.fn();
    // No players to wait for: each reply on /mcp, while the match is held, releases it.
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: config,
      seed: 504997660, feed: { matchStarted, ticked: vi.fn() }, ...comparison(0) });
    expect(await requestMcp()).toBe(400);
    await settle(() => errors().includes("start failed"));
    expect(server.game.match).toBeNull();
    expect(server.game.nextStart).toEqual({ kind: "held" });
    expect(server.game.queuedAgents).toBe(0);
    expect(matchStarted).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).toEqual([]);
    expect(errors()).toContain("match 1 start failed: seed 504997660");
    expect(errors()).toContain("Cannot place seeded food patches");
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await assertServing();

    // Repair the deliberately impossible fixture, without changing seed/mode.
    Object.assign(config.foodLayout!, PLAYABLE_PUBLIC.foodLayout);
    await assertServing();
    await settle(() => server!.game.match !== null);
    expect(server.game.match?.seq).toBe(1);
    expect(server.game.match?.state.agents).toEqual([]);
    expect(matchStarted).toHaveBeenCalledTimes(1);
    expect(readdirSync(dataDir)).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(server.game.match?.result).not.toBeNull();
  });

  it("retains the completed match when the next food layout is impossible", () => {
    const config = playable({ ...PUBLIC_CONFIG, matchTicks: 1, foodLayout: { ...PUBLIC_CONFIG.foodLayout! } });
    const game = new Game({ simConfig: config });
    game.startMatch(0);
    while (game.match!.result === null) game.tick();
    const previous = game.match!;
    Object.assign(config.foodLayout!, { placementAttempts: 1, layoutAttempts: 1, minStartingFood: 1, maxStartingFood: 1 });
    expect(() => game.startMatch(1)).toThrow(FoodLayoutError);
    expect(game.match?.seq).toBe(previous.seq);
    expect(game.match?.state).toBe(previous.state);
  });

  it("refuses retired entry-point operator start without attempting a food layout", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(),
      simConfig: impossibleConfig(), seed: 1, operatorToken: "test-only-food-operator" });
    const response = await fetch(`http://127.0.0.1:${server.port}/operator/start`, {
      method: "POST", headers: { authorization: "Bearer test-only-food-operator" },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Match started");
    expect(server.game.match).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await assertServing();
  });
});
