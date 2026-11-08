import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, type GameServer, type ServerOptions } from "../../src/server.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { tempDir } from "./helpers.js";
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

describe("food-placement failures cannot escape the server's match-start boundary", () => {
  it.each(["held", "immediate"] as const)("keeps %s starts idle and serving, reports the cause and permits explicit retry", async mode => {
    const dataDir = tempDir(), config = impossibleConfig();
    const matchStarted = vi.fn();
    const options: ServerOptions = { port: 0, host: "127.0.0.1", dataDir, simConfig: config,
      seed: 504997660, feed: { matchStarted, ticked: vi.fn() },
      match: mode };
    server = await startServer(options);
    if (mode !== "immediate") expect(() => server!.startMatch()).not.toThrow();
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
    expect(() => server!.startMatch()).not.toThrow();
    expect(server.game.match?.seq).toBe(1);
    expect(server.game.match?.state.agents).toEqual([]);
    expect(matchStarted).toHaveBeenCalledTimes(1);
    expect(readdirSync(dataDir)).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(server.game.match?.result).not.toBeNull();
  });

  it("retries private scheduled starts only after the existing break and can recover without a process restart", async () => {
    const config = impossibleConfig(), dataDir = tempDir(), matchStarted = vi.fn();
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: config,
      seed: 504997660, breakMs: 200, feed: { matchStarted, ticked: vi.fn() } });
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(server.game.match).toBeNull();
    expect(server.game.nextStart?.kind).toBe("scheduled");
    expect(vi.getTimerCount()).toBe(1);
    expect(matchStarted).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).toEqual([]);
    await assertServing();
    vi.advanceTimersByTime(199);
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
    Object.assign(config.foodLayout!, PLAYABLE_PUBLIC.foodLayout);
    vi.advanceTimersByTime(1);
    expect(server.game.match?.seq).toBe(1);
    expect(server.game.match?.state.agents).toEqual([]);
    expect(matchStarted).toHaveBeenCalledTimes(1);
  });

  it("retains the completed match when the next food layout is impossible", async () => {
    const config = playable({ ...PUBLIC_CONFIG, matchTicks: 1, foodLayout: { ...PUBLIC_CONFIG.foodLayout! } });
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: config, seed: 0, breakMs: 200 });
    vi.advanceTimersByTime(300);
    const previous = server.game.match!;
    expect(previous.result).not.toBeNull();
    Object.assign(config.foodLayout!, { placementAttempts: 1, layoutAttempts: 1, minStartingFood: 1, maxStartingFood: 1 });
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(server.game.match?.seq).toBe(previous.seq);
    expect(server.game.match?.state).toBe(previous.state);
    expect(server.game.nextStart?.kind).toBe("scheduled");
    expect(vi.getTimerCount()).toBe(1);
    await assertServing();
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
