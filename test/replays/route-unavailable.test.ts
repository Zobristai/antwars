import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { comparisonOptions } from "../../src/server.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";

/** A /replays/<id> 503 logs its method, route class and cause; the sanitized reply is unchanged. */
const dirs: string[] = [];
let server: SpectatedServer | null = null;
afterEach(async () => {
  await server?.close(); server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function options() {
  const dataDir = mkdtempSync(join(tmpdir(), "antwar-replay-route-")); dirs.push(dataDir);
  const publicOptions = comparisonOptions({}, DEFAULT_MCP_CONFIG);
  return { ...publicOptions, port: 0, host: "127.0.0.1", dataDir, breakMs: 20,
    simConfig: { ...publicOptions.simConfig!, matchTicks: 2, terrain: { ...publicOptions.simConfig!.terrain!, mapId: "open-field" } } };
}
const live = { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 };
const replayId = "2026-10-18T09-50-00-123Z-1";
const body = JSON.stringify({ error: "Replay temporarily unavailable. Please try again." });

it.each([
  ["opening the object", async () => { throw new Error("bucket down"); }],
  ["reading its first bytes", async () => ({ body: Readable.from((async function* () { throw new Error("bucket down"); })()) })],
])("logs one line naming method, route and cause when %s fails, and still answers the same 503", async (_name, open) => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  server = await startSpectatedServer({ ...options(), match: "held", replaySource: { open } }, live);
  const response = await fetch(`http://127.0.0.1:${server.port}/replays/${replayId}`);
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  expect(await response.text()).toBe(body);
  const lines = warn.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("antwar 503"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^antwar 503 GET \/replays\/:id: Error: bucket down/);
  expect(lines[0]).not.toContain(replayId);
  expect(errors).not.toHaveBeenCalled();
});
