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
it("README's local route marks its page a local match and streams the running match at /live/current", async () => {
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
  const stream = await fetch(`${origin}/live/current`, { signal: abort.signal });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  expect(Number(stream.headers.get("x-antwar-match"))).toBe(server.game.match!.seq);
  expect(await (await fetch(`${origin}/live/status`)).json()).toMatchObject({ kind: "playing" });
}, 30_000);
