/// <reference types="node" />
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { decodeMessage, type StreamMessage } from "../../src/live/format.js";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.js";
import { comparison, connect, shortConfig, startComparisonMatch, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: SpectatedServer | null = null;
const agents: Agent[] = [];
const readers: AbortController[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) r.abort();
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
});

interface Received {
  readonly m: StreamMessage;
  readonly at: number;
}

/** Open a live stream and decode each SSE data message as it arrives. */
async function openStream(port: number, path: string): Promise<{ match: number; messages: Received[] }> {
  const abort = new AbortController();
  readers.push(abort);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: abort.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const messages: Received[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith("data: ")) continue;
          messages.push({ m: decodeMessage(inflateRawSync(Buffer.from(frame.slice(6), "base64"))), at: Date.now() });
        }
      }
    } catch {
      // Aborted at the end of the test.
    }
  })();
  return { match: Number(res.headers.get("x-antwar-match")), messages };
}

const hasResult = (m: StreamMessage): boolean => m.events.some((e) => e.kind === "end") || (m.full?.result ?? null) !== null;

describe("the spectator on the server's one port", () => {
  it("serves an MCP join at /mcp, the live stream of the running match at /live/current, and the page at /", async () => {
    server = await startSpectatedServer(
      { port: 0, host: "127.0.0.1", dataDir: tempDir(), ...comparison(0), simConfig: playable(shortConfig(600)), mcpConfig: TEST_MCP_CONFIG },
      { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 },
    );
    const s = server;
    await startComparisonMatch(s, 0);
    const agent = await connect(s.port);
    agents.push(agent);
    expect((await agent.call("join", {})).isError).toBe(false);

    const stream = await openStream(s.port, "/live/current");
    expect(stream.match).toBe(s.game.match!.seq);
    await waitFor(() => stream.messages.some((r) => r.m.full === null && r.m.tick > 0), 5_000);
    expect(stream.messages[0]!.m.full).not.toBeNull();
    // The agent that joined at /mcp is in the match the stream shows.
    expect(stream.messages[0]!.m.full!.agents).toHaveLength(1);

    const page = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toMatch(/<script/);
    expect((await fetch(`http://127.0.0.1:${s.port}/../package.json`)).status).toBe(404);
  }, 20_000);
});

describe("no early winner on the stream", () => {
  it("delivers ticks before the final one while the match runs, and the result with the server's next start only once delayed playback reaches the final tick", async () => {
    const delaySeconds = 1;
    server = await startSpectatedServer(
      { port: 0, host: "127.0.0.1", dataDir: tempDir(), ...comparison(0), simConfig: playable(shortConfig(40)), mcpConfig: TEST_MCP_CONFIG },
      { ...DEFAULT_LIVE_CONFIG, delaySeconds },
    );
    const s = server;
    await startComparisonMatch(s, 0);
    const stream = await openStream(s.port, "/live/current");
    expect(stream.match).toBe(1);

    const endedAt = await waitFor(() => s.game.match?.seq === 1 && s.game.match.result !== null, 10_000);
    const finalTick = s.game.match!.state.tick;
    // A held match has no next start; the end carries the server's none.
    expect(s.game.nextStart).toBeNull();
    await waitFor(() => stream.messages.some((r) => hasResult(r.m)), 10_000);

    const end = stream.messages.find((r) => hasResult(r.m))!;
    // No message before the final tick carries the result.
    expect(stream.messages.filter((r) => r.m.tick < finalTick && hasResult(r.m))).toEqual([]);
    expect(end.m.tick).toBe(finalTick);
    // Deltas for earlier ticks arrived before it, so the check above is not vacuous.
    expect(stream.messages.filter((r) => r.m.full === null && r.m.tick < finalTick && r.at < end.at).length).toBeGreaterThan(5);
    // The result arrived after the match ended, once the delay had played out.
    expect(end.at - endedAt).toBeGreaterThanOrEqual(delaySeconds * 1000 * 0.8);
    const result = end.m.events.find((e) => e.kind === "end");
    expect(result?.kind === "end" ? result.result.nextStartMs : undefined).toBeNull();
  }, 20_000);
});
