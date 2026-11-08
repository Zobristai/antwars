import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import { createWatchRegistry } from "../../src/live/watch-registry.js";
import { createRecordHandoff } from "../../src/records/handoff.js";
import { decodeInput } from "../../src/records/inputs.js";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { ManualClock } from "../live/helpers.js";
import { connect, logLines, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: SpectatedServer | undefined;
const agents: Agent[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("retains authenticated slot stop and recording, but slot start remains lobby-only", async () => {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 300 });
  const accounts = { identities, lobbies, ratings: createRatings(store, identities) };
  const dir = tempDir(); dirs.push(dir);
  const inputs = new Map<string, Uint8Array>();
  const saved: string[] = [];
  const handoff = createRecordHandoff({ codeVersion: "c".repeat(40), store: { create: async object => { inputs.set(object.name, object.body); } } });
  const token = "slot-test-only", auth = { authorization: `Bearer ${token}` };
  const clock = new ManualClock();
  server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, simConfig: playable(shortConfig(100, { queenFounding: PUBLIC_CONFIG.queenFounding })), mcpConfig: TEST_MCP_CONFIG,
    seed: 91, startPickWindowMs: 5, spectatorClock: clock, operatorToken: token, accounts, watchRegistry: createWatchRegistry(store), recordHandoff: handoff,
    replayStore: { create: async object => { saved.push(object.name); } },
    slot: { slot: "public-0", publicUrl: "http://slot.test", identities, lobbies, pollMs: 10 },
  });
  const s = server, origin = `http://127.0.0.1:${s.port}`;
  const control = (action: string, headers: HeadersInit = auth) => fetch(`${origin}/operator/${action}`, { method: "POST", headers });
  const refusedHeaders: HeadersInit[] = [{}, { authorization: "Bearer wrong" }];
  for (const headers of refusedHeaders) {
    expect((await control("start", headers)).status).toBe(401);
    expect((await control("stop", headers)).status).toBe(401);
  }
  expect((await control("stop", { ...auth, origin: "https://untrusted.invalid" })).status).toBe(403);
  expect((await fetch(`${origin}/operator/stop`, { headers: auth })).status).toBe(405);
  expect((await control("start")).status).toBe(409);
  expect((await control("stop")).status).toBe(409);
  const keys: string[] = [];
  for (const name of ["SlotAnn", "SlotBob"]) {
    const claimed = await identities.claimUsername(name);
    if (!claimed.ok) throw new Error(claimed.reason);
    keys.push(claimed.value.key);
  }
  const created = await lobbies.createLobby(keys[0]!, "public", 1);
  if (!created.ok) throw new Error(created.reason);
  for (const key of keys) {
    const seated = await lobbies.join(created.value.lobby.id, key);
    if (!seated.ok) throw new Error(seated.reason);
  }
  await waitFor(() => s.game.nextStart !== null);
  for (const key of keys) {
    const agent = await connect(s.port); agents.push(agent);
    const joined = await agent.call("join", { key });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data).not.toHaveProperty("reconnectToken");
  }
  await waitFor(() => (s.game.match?.state.tick ?? 0) >= 1);
  expect((await control("start")).status).toBe(409);
  const pending = agents[0]!.call("observe");
  expect((await control("stop")).status).toBe(200);
  expect((await pending).isError).toBe(false);
  expect((await agents[0]!.call("observe")).data.matchOver).toBe(true);
  expect(s.game.nextStart).toBeNull();
  const lines = logLines(matchLogs(dir).get(1)!);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ stop: true });
  // Unrated slot playback retains its real 60-second minimum; advance only the spectator clock.
  clock.advance(61_000);
  await waitFor(() => inputs.size === 1 && saved.length === 1);
  expect(decodeInput([...inputs.values()][0]!)).toMatchObject({ lobbyId: null, logLines: lines });
  expect((await control("stop")).status).toBe(409);
  await waitFor(() => s.game.match?.result !== null);
  const ended = await lobbies.readLobby(created.value.lobby.id);
  expect(ended.ok && ended.value.outcome).toBe("stopped");
}, 15_000);

it("settles calls already waiting for a terminal tick with the stopped result", async () => {
  const game = new Game({ simConfig: playable(shortConfig(100)), mcpConfig: TEST_MCP_CONFIG });
  const joined = await game.join({});
  game.startMatch(91); game.tick();
  const pending = game.call(joined.agentId!, { type: "observe", agentId: joined.agentId! });
  expect(game.pendingInputs).toBe(1);
  const terminal = game.tick(true)!;
  const result = await pending;
  expect(game.pendingInputs).toBe(0);
  expect(result.kind).toBe("view");
  if (result.kind !== "view") throw new Error("expected final view");
  expect(result.view.result).toEqual(terminal.state.result);
  expect(terminal.state.result).not.toBeNull();
});
