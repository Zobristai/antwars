import { inflateRawSync } from "node:zlib";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { decodeMessage, type StreamMessage } from "../../src/live/format.js";
import { decodeMessage as oldDecode } from "../live/fixtures/pre-queen-ranking-format.ts";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions } from "../../src/server.js";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.js";
import { connect, tempDir, waitFor, type Agent } from "./helpers.js";

let server: SpectatedServer | null = null;
const agents: Agent[] = [];
const readers: AbortController[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) r.abort();
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
  vi.restoreAllMocks();
});

// README's "Run it locally": ANTWAR_RULES=redesign ANTWAR_PLAYERS=2 npm start, two agents, the spectator view at /.
it("README's local route marks its page a local match and streams the running match at /watch/live/local", async () => {
  // The comparison match copies its log to stdout; keep the test output readable.
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(),
    ...comparisonOptions({ ANTWAR_RULES: "redesign", ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG) });
  const origin = `http://127.0.0.1:${server.port}`;
  for (let i = 0; i < 2; i++) {
    const agent = await connect(server.port);
    agents.push(agent);
    expect((await agent.call("join", {})).isError).toBe(false);
  }
  await waitFor(() => (server!.game.match?.state.tick ?? 0) >= 1);

  const page = await (await fetch(`${origin}/`)).text();
  expect(page).toContain('<meta name="antwar-local-match" content="true">');
  // The store-backed catalog is absent here; the page does not ask it.
  expect((await fetch(`${origin}/watch/catalog`)).status).toBe(404);

  const abort = new AbortController();
  readers.push(abort);
  const stream = await fetch(`${origin}/watch/live/local`, { signal: abort.signal });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  expect(Number(stream.headers.get("x-antwar-match"))).toBe(server.game.match!.seq);
  expect(await (await fetch(`${origin}/live/status`)).json()).toMatchObject({ kind: "playing" });
}, 30_000);

const quadrantMap: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants", water: [],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};

/** Read real local-route frames without dropping data received in the same HTTP chunk. */
async function* localMessages(response: Response, decode: (bytes: Uint8Array) => StreamMessage) {
  let pending = "";
  const text = new TextDecoder();
  for await (const chunk of response.body!) {
    pending += text.decode(chunk, { stream: true });
    for (let end; (end = pending.indexOf("\n\n")) >= 0;) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      if (frame.startsWith("data: ")) yield decode(inflateRawSync(Buffer.from(frame.slice(6), "base64")));
    }
  }
}

it.each(["?kills=1&queenKills=1&queenBites=1", "?kills=1&queenKills=1", "?kills=1&queenBites=1", "?queenBites=1", "?queenKills=1", "?queenKills=1&queenBites=1", "?kills=1", "", "?kills=0"])("keeps local four-colony telemetry negotiated through the route rewrite (%s)", async query => {
  server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(),
    ...comparisonOptions({ ANTWAR_RULES: "redesign", ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG) },
    { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  const config = newMatchConfig(rulesConfig("redesign"));
  // A labelled four-colony input fixture feeds the real local server's spectator hub.
  // The existing MCP route test above covers starting the local game itself.
  const state = createMatch(404, { ...config, terrain: { ...config.terrain!, maps: [quadrantMap] } });
  expect(state.colonies).toHaveLength(4);
  state.colonies.forEach((colony, i) => { colony.kills = i * 7; });
  server.hub.startMatch(1, state);
  const abort = new AbortController(); readers.push(abort);
  const response = await fetch(`http://127.0.0.1:${server.port}/watch/live/local${query}`, { signal: abort.signal });
  expect(response.status).toBe(200);
  const optedIn = query.startsWith("?kills=1"), queenKills = query.includes("queenKills=1"), queenBites = query.includes("queenBites=1");
  const messages = localMessages(response, optedIn || queenKills || queenBites ? decodeMessage : oldDecode);
  try {
    const opening = (await messages.next()).value!;
    expect(opening.full!.setup.colonies).toBe(4);
    expect(opening.full!.kills).toEqual(optedIn ? [0, 7, 14, 21] : undefined);
    expect(opening.full!.queenKills).toEqual(queenKills ? [0, 0, 0, 0] : undefined);
    state.colonies[0]!.kills = 3;
    state.colonies[2]!.queenKills = 1;
    const out = step(state, []);
    // A labelled queen-bites record on this step: an ant of colony 1 biting colony 0's queen.
    const biter = out.state.ants.find(ant => ant.colony === 1)!;
    out.events.push({ type: "queen_bites", tick: out.state.tick - 1, colony: 0, queenId: 0, tileX: 0, tileY: 0, biters: [biter.id], targetId: null });
    server.hub.pushTick(1, out);
    const delta = (await messages.next()).value!;
    expect(delta.tick).toBe(out.state.tick);
    expect(delta.full).toBeNull();
    expect(delta.events.filter(event => event.kind === "kills")).toEqual(optedIn
      ? [{ kind: "kills", totals: out.state.colonies.map(colony => colony.kills ?? 0) }] : []);
    expect(delta.events.filter(event => event.kind === "queenKills")).toEqual(queenKills ? [{ kind: "queenKills", totals: [0, 0, 1, 0] }] : []);
    expect(delta.events.filter(event => event.kind === "queenBites")).toEqual(queenBites
      ? [{ kind: "queenBites", colony: 0, queenId: 0, biters: [biter.id], targetId: null }] : []);
  } finally { await messages.return(); }
}, 30_000);
