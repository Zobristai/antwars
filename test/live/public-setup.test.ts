import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { briefing } from "../../src/mcp/briefing.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import type { ReplayObject } from "../../src/replays/store.ts";
import { comparisonOptions } from "../../src/server.ts";
import { buildGrid, cloneState, createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { takeView } from "../../src/sim/view.ts";
import { startSpectatedServer } from "../../src/spectator.ts";
import { delivered, ManualClock, RecordedServer, served, SseClient } from "./helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it.each([false, true])("uses only explicit comparison opt-in (%s), keeping labels and MCP views through joins and reconnect", async (comparison) => {
  const options = comparisonOptions(comparison ? { ANTWAR_RULES: "redesign", ANTWAR_PLAYERS: "4" } : {}, DEFAULT_MCP_CONFIG);
  const objects: ReplayObject[] = [];
  const clock = new ManualClock();
  const hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 },
    includeComparisonSetup: options.includeComparisonSetup, replayStore: { create: async (object) => { objects.push(object); } } });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  cleanup.push(() => server.close(), () => hub.close());
  const initial = createMatch(6006, { ...options.simConfig!, matchTicks: 2 });
  hub.startMatch(1, initial);
  const early = await SseClient.connect(server.url("/live/1"));
  cleanup.push(() => early.close());
  const earlyResponse = await served(server, 1);
  // Scripted simulation inputs only: no MCP connections or live agent joins.
  const out = step(initial, [{ type: "join", agentId: "private-agent-uuid", modelLabel: "Grok 4.7" }]);
  const before = cloneState(out.state);
  const beforeBriefing = briefing(out.state.config);
  hub.pushTick(1, out);
  const late = await SseClient.connect(server.url("/live/1"));
  cleanup.push(() => late.close());
  const lateResponse = await served(server, 2);
  await delivered(early, earlyResponse);
  await delivered(late, lateResponse);
  expect(early.messages.flatMap((message) => message.events)).toContainEqual({ kind: "join", agent: 0, colony: 0, modelLabel: "Grok 4.7" });
  expect(late.messages[0]!.full!.agents[0]!.modelLabel).toBe("Grok 4.7");
  for (const message of [early.messages[0]!, late.messages[0]!]) {
    const setup = message.full!.setup;
    if (comparison) expect(setup).toMatchObject({ rules: "redesign", seed: 6006, players: 4 });
    else for (const field of ["rules", "seed", "players"]) expect(setup).not.toHaveProperty(field);
    expect(message.full!.queens!.map((queen) => queen.hp)).toEqual([40_000, 40_000]);
  }
  expect(JSON.stringify([...early.messages, ...late.messages])).not.toContain("private-agent-uuid");
  expect(out.state).toEqual(before);
  expect(briefing(out.state.config)).toBe(beforeBriefing);
  expect(beforeBriefing).toContain("Queens with HP");
  expect(takeView(out.state, buildGrid(out.state), out.state.agents[0]!))
    .toEqual(takeView(before, buildGrid(before), before.agents[0]!));
  expect(out.state.config.rules).toBe("redesign");
  hub.pushTick(1, step(out.state));
  await vi.waitFor(() => expect(objects).toHaveLength(1));
  await delivered(early, earlyResponse);
  const stored = unpackMessages(new Uint8Array(gunzipSync(objects[0]!.body))).map(decodeMessage);
  expect(stored).toEqual(early.messages);
});

it.each([undefined, "v4", "count-marks", "redesign"])("passes the environment-derived metadata policy through the server composition for %s", async (rules) => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Avoid comparison log output; this does not control spectator disclosure.
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const options = comparisonOptions(rules === undefined ? {} : { ANTWAR_RULES: rules, ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG);
  const dir = mkdtempSync(join(tmpdir(), "antwar-public-setup-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = await startSpectatedServer({ ...options, port: 0, host: "127.0.0.1", dataDir: dir,
    match: "held", simConfig: { ...options.simConfig!, matchTicks: 20 } }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  cleanup.push(() => server.close());
  server.startMatch();
  const client = await SseClient.connect(`http://127.0.0.1:${server.port}/live/1`);
  cleanup.push(() => client.close());
  await vi.waitFor(() => expect(client.messages.length).toBeGreaterThan(0));
  const setup = client.messages[0]!.full!.setup;
  if (rules === undefined) for (const field of ["rules", "seed", "players"]) expect(setup).not.toHaveProperty(field);
  else expect(setup).toMatchObject({ rules, seed: 6006, players: 2 });
  expect(server.game.match!.state.config.rules).toBe(rules ?? "redesign");
  write.mockRestore();
});
