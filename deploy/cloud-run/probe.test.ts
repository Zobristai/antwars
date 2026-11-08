import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { createMcpHandler } from "../../src/mcp/http.js";
import { Game } from "../../src/mcp/game.js";
import * as streamFormat from "../../src/live/format.js";
import { SpectatorRecorder } from "../../src/live/model.js";
import { DEFAULT_CONFIG } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { playable } from "../../test/playable.ts";
// This is the actual standalone Node entry point, not a test-only copy.
import { assertRedirect, compareStreams, domainProbe, entrypointProbe, holdStream, publicMatches, runProbe, SPECTATOR_STREAM_VERSIONS, spectatorTick, sseParser, streamProbe, TIMING_TOLERANCE_MS } from "./probe.mjs";

const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const close of closes.splice(0)) await close(); });
const quiet = () => {};
const data = (tick: number) => deflateRawSync(Buffer.from([0x41, 0x57, 4, 0, tick])).toString("base64");

async function http(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closes.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function sample(elapsedMs: number, kind = "keepalive", signature = String(elapsedMs), tick?: number) {
  return { at: "2026-10-19T22:49:00.000Z", elapsedMs, monotonicMs: elapsedMs + 100, kind, signature, ...(tick === undefined ? {} : { tick }) };
}
function healthy(label: string) {
  return { label, openedAt: 100, heldMs: 720_000, match: "1", complete: true,
    samples: Array.from({ length: 47 }, (_, i) => sample((i + 1) * 15_000)) };
}

describe("SSE arrival evidence", () => {
  it("parses split CRLF/UTF-8, all comments and multiple frames without losing frames", () => {
    const frames: { kind: string; data: string }[] = [];
    const parser = sseParser((f: { kind: string; data: string }) => frames.push(f));
    const bytes = Buffer.from(": keepalive\r\n\r\ndata: café\r\ndata: two\r\n\r\n: keep-alive\n\n");
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    parser.finish();
    expect(frames.map((f) => [f.kind, f.data])).toEqual([["keepalive", ""], ["event", "café\ntwo"], ["keepalive", ""]]);
  });
  it("rejects truncated, oversized and unknown binary framing", () => {
    const parser = sseParser(quiet); parser.push(Buffer.from("data: incomplete")); expect(() => parser.finish()).toThrow("truncated");
    expect(() => sseParser(quiet).push(Buffer.alloc(1024 * 1024 + 1))).toThrow("oversized");
    expect(spectatorTick(data(12))).toBe(12);
    expect(() => spectatorTick(deflateRawSync(Buffer.from("bad")).toString("base64"))).toThrow();
  });
  // probe.mjs runs under plain Node and cannot import src/live/format.ts, so its accepted
  // range is bound here to every *_STREAM_VERSION constant the format defines.
  const formatVersions = Object.entries(streamFormat)
    .filter(([name, value]) => name.endsWith("_STREAM_VERSION") && typeof value === "number")
    .map(([, value]) => value as number);
  const framed = (version: number, tick: number) => deflateRawSync(Buffer.from([0x41, 0x57, version, 0, tick])).toString("base64");
  it("accepts every spectator version src/live/format.ts defines", () => {
    expect(formatVersions.length).toBeGreaterThan(1);
    for (const version of formatVersions) expect(() => spectatorTick(framed(version, 7)), `version ${version}`).not.toThrow();
    for (const version of formatVersions) expect(spectatorTick(framed(version, 7))).toBe(7);
  });
  it("bounds the accepted range to the format's first and latest versions; anything outside still fails closed", () => {
    expect(SPECTATOR_STREAM_VERSIONS).toEqual({ min: streamFormat.STREAM_VERSION, max: Math.max(...formatVersions) });
    expect(() => spectatorTick(framed(SPECTATOR_STREAM_VERSIONS.min - 1, 7))).toThrow("unknown spectator framing");
    expect(() => spectatorTick(framed(SPECTATOR_STREAM_VERSIONS.max + 1, 7))).toThrow("unknown spectator framing");
  });
  it("reads the tick of a live match's first frame as the hub sends it", () => {
    const recorder = new SpectatorRecorder(createMatch(42, playable(DEFAULT_CONFIG)));
    const first = { ...recorder.initial(), full: recorder.initialFull() };
    const bytes = streamFormat.encodePublicMessage(first);
    expect(bytes[2]).toBeGreaterThanOrEqual(streamFormat.GRID_SCALE_STREAM_VERSION);
    expect(spectatorTick(deflateRawSync(bytes).toString("base64"))).toBe(first.tick);
  });
  it("holds the original connection to its deadline, timestamps every frame and closes the socket", async () => {
    const url = await http((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      res.write(": one\n\n: two\n\n");
      const timer = setInterval(() => res.write(": pulse\n\n"), 5);
      res.once("close", () => clearInterval(timer));
    });
    const result = await holdStream("test", url, { seconds: 0.04, emit: quiet });
    expect(result.complete).toBe(true); expect(result.heldMs).toBeGreaterThanOrEqual(35);
    expect(result.samples.length).toBeGreaterThanOrEqual(2);
    for (const s of result.samples) { expect(s.at).toMatch(/Z$/); expect(s.monotonicMs).toBeTypeOf("number"); }
  });
  it("refuses non-SSE, early clean EOF and execution failures; cancellation is not a pass", async () => {
    const url = await http((_req, res) => res.writeHead(200, { "content-type": "text/event-stream" }).end(": first\n\n"));
    const result = await holdStream("early", url, { seconds: 1, emit: quiet });
    expect(result.complete).toBe(false); expect(result.error).toContain("early");
    const cancelled = new AbortController(); cancelled.abort();
    expect((await holdStream("cancelled", url, { seconds: 1, signal: cancelled.signal, emit: quiet })).complete).toBe(false);
    const plain = await http((_req, res) => res.writeHead(404).end());
    expect((await holdStream("refused", plain, { seconds: 1, emit: quiet })).complete).toBe(false);
  });
});

describe("comparison fails closed", () => {
  it("accepts independently arriving 15-second keepalives for the full 12 minutes", () => {
    const result = compareStreams(healthy("domain"), healthy("mcp"), healthy("control"), 720);
    expect(result.pass).toBe(true); expect(result.cadence.mcpHeartbeatMs).toBe(15_000);
    expect(result.maxDomainLagMs).toBeNull(); expect(result.limitation).toContain("no server timestamp");
  });
  // Probe.mjs repeats the spectator stream's heartbeat (src/live/config.ts) as HEARTBEAT_MS. The MCP
  // keepalive cadence is the SDK's own default, not set from src, so it is not pinned here.
  it("holds a spectator stream to the src/live/config.ts heartbeat: one tolerance over passes, a millisecond more fails", () => {
    const heartbeatMs = DEFAULT_LIVE_CONFIG.heartbeatMs;
    const stream = (label: string, firstGapMs: number) => {
      const samples = [];
      for (let t = firstGapMs; t < 720_000; t += heartbeatMs) samples.push(sample(t));
      return { label, openedAt: 100, heldMs: 720_000, match: "1", complete: true, samples };
    };
    const compare = (domainGapMs: number) => compareStreams(stream("domain", domainGapMs), stream("mcp", heartbeatMs), stream("control", heartbeatMs), 720);
    const within = compare(heartbeatMs + TIMING_TOLERANCE_MS);
    expect(within.failures).toEqual([]);
    expect(within.cadence.spectatorHeartbeatMs).toBe(heartbeatMs);
    expect(compare(heartbeatMs + TIMING_TOLERANCE_MS + 1).failures).toEqual(["domain: silence exceeds server heartbeat cadence"]);
  });
  it("rejects a delayed event, missing event, buffered MCP burst or early close", () => {
    const domain = healthy("domain"), mcp = healthy("mcp"), control = healthy("control");
    domain.samples.push(sample(21_500, "event", "same", 10));
    control.samples.push(sample(20_000, "event", "same", 10));
    domain.samples.sort((a, b) => a.elapsedMs - b.elapsedMs); control.samples.sort((a, b) => a.elapsedMs - b.elapsedMs);
    expect(compareStreams(domain, mcp, control, 720).failures).toContain("domain spectator: delayed compared with run.app");
    domain.samples = domain.samples.filter((s) => s.kind !== "event");
    expect(compareStreams(domain, mcp, control, 720).missingEvents).toBe(1);
    mcp.samples = mcp.samples.map((s) => ({ ...s, elapsedMs: 30_000 }));
    expect(compareStreams(healthy("domain"), mcp, healthy("control"), 720).pass).toBe(false);
    const closed = { ...healthy("domain"), complete: false };
    expect(compareStreams(closed, healthy("mcp"), healthy("control"), 720).pass).toBe(false);
  });
  it("refuses comparing different matches or missing evidence", () => {
    expect(compareStreams({ ...healthy("domain"), match: "2" }, healthy("mcp"), healthy("control"), 720).pass).toBe(false);
    expect(compareStreams({ ...healthy("domain"), samples: [] }, healthy("mcp"), healthy("control"), 720).pass).toBe(false);
  });
});

describe("redirect validation", () => {
  it("accepts only the matching scheme's explicit default port or no port", () => {
    for (const [expected, location] of [
      ["https://domain.invalid/rules?antwar_probe=redirect", "https://domain.invalid/rules?antwar_probe=redirect"],
      ["https://domain.invalid/rules?antwar_probe=redirect", "https://domain.invalid:443/rules?antwar_probe=redirect"],
      ["http://domain.invalid/rules?antwar_probe=redirect", "http://domain.invalid:80/rules?antwar_probe=redirect"],
    ]) expect(() => assertRedirect(301, location, expected)).not.toThrow();
  });
  it("keeps status, scheme, host, path and query exact and reports the received Location", () => {
    const expected = "https://domain.invalid/rules?antwar_probe=redirect";
    for (const location of [
      "https://wrong.invalid:443/rules?antwar_probe=redirect",
      "https://domain.invalid:443/wrong?antwar_probe=redirect",
      "https://domain.invalid:444/rules?antwar_probe=redirect",
      "https://domain.invalid:80/rules?antwar_probe=redirect",
      "http://domain.invalid:80/rules?antwar_probe=redirect",
      "https://domain.invalid:443/rules?antwar_probe=wrong",
      "https://domain.invalid:443/rules?antwar_probe=redirect#fragment",
      "https://DOMAIN.invalid:443/rules?antwar_probe=redirect",
      "https://domain.invalid:443/other/../rules?antwar_probe=redirect",
      "https://domain.invalid:443/%72ules?antwar_probe=redirect",
      "https://domain.invalid:443:443/rules?antwar_probe=redirect",
      null,
    ]) expect(() => assertRedirect(301, location, expected)).toThrow(`Location: ${JSON.stringify(location)}`);
    for (const status of [200, 302, 307, 308]) {
      expect(() => assertRedirect(status, expected, expected)).toThrow(`HTTP ${status}; Location: ${JSON.stringify(expected)}`);
    }
    const http = "http://domain.invalid/rules?antwar_probe=redirect";
    expect(() => assertRedirect(301, http.replace(".invalid/", ".invalid:443/"), http)).toThrow("Location:");
  });
  it("stops the actual domain probe before MCP or streams and exposes a mismatched Location", async () => {
    const location = "https://wrong.invalid:443/rules?antwar_probe=redirect";
    const requests: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      const source = new URL(String(input)); requests.push(source.pathname);
      return Promise.resolve(source.protocol === "http:"
        ? new Response(null, { status: 301, headers: { location } })
        : new Response("page", { status: 200 }));
    });
    await expect(domainProbe("https://domain.invalid", "https://control.invalid", 0.06, quiet))
      .rejects.toThrow(`HTTP 301; Location: ${JSON.stringify(location)}`);
    expect(requests).not.toContain("/mcp"); expect(requests).not.toContain("/live/current");
  });
});

describe("real SDK and runner wiring", () => {
  async function mcpServer(gameplay = true) {
    const handler = createMcpHandler(new Game(), { gameplay }); closes.push(() => handler.close());
    const url = await http((req, res) => { void handler.handle(req, res); });
    return { handler, url };
  }
  it.each([true, false])("checks the entry point with gameplay=%s without tools/call and deletes the session", async gameplay => {
    const { handler, url } = await mcpServer(gameplay);
    const methods: string[] = []; const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      if (init?.body) methods.push(JSON.parse(String(init.body)).method);
      return realFetch(input, init);
    });
    await entrypointProbe(url, quiet);
    expect(methods).toContain("initialize"); expect(methods).toContain("tools/list"); expect(methods).not.toContain("tools/call");
    expect(handler.sessionCount).toBe(0);
  });
  it.each([true, false])("exercises public-lobby streams and cleanup with gameplay=%s using a local protocol server", async gameplay => {
    const { handler, url } = await mcpServer(gameplay);
    const methods: string[] = [], gets: number[] = []; const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
      const source = new URL(String(input));
      if (init.body) methods.push(JSON.parse(String(init.body)).method);
      if (source.protocol === "http:" || source.hostname.startsWith("www.")) {
        return Promise.resolve(new Response(null, { status: 301, headers: { location: "https://domain.invalid:443/rules?antwar_probe=redirect" } }));
      }
      if (source.pathname === "/mcp" && init.method !== undefined && init.method !== "GET") return realFetch(new URL("/mcp", url), init);
      if (source.pathname === "/watch/catalog") return Promise.resolve(Response.json({ matches: [{ lobbyId: "11111111-1111-4111-8111-111111111111", startedAt: 123 }], lobbies: [] }));
      if (source.pathname === "/watch/live/11111111-1111-4111-8111-111111111111" || source.pathname === "/mcp") {
        gets.push(performance.now());
        let timer: ReturnType<typeof setInterval>;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(": first\n\n: second\n\n"));
            timer = setInterval(() => controller.enqueue(Buffer.from(": keepalive\n\n")), 5);
            init.signal?.addEventListener("abort", () => { clearInterval(timer); controller.error(new DOMException("aborted", "AbortError")); }, { once: true });
          },
          cancel() { clearInterval(timer); },
        });
        // Real watch proxies do not forward the slot-local sequence header.
        return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      }
      return Promise.resolve(new Response("page", { status: 200 }));
    });
    const result = await domainProbe("https://domain.invalid", "https://control.invalid", 0.06, quiet);
    expect(result).toMatchObject({ status: "compared", pass: true, lobbyId: "11111111-1111-4111-8111-111111111111" });
    expect(methods.filter((m) => m === "initialize")).toHaveLength(2);
    expect(methods).toContain("tools/list"); expect(methods).not.toContain("tools/call");
    expect(Math.max(...gets.slice(-3)) - Math.min(...gets.slice(-3))).toBeLessThan(30);
    expect(handler.sessionCount).toBe(0);
  });
  it.each([true, false])("reports empty-catalog comparison as skipped with gameplay=%s, never as a pass", async gameplay => {
    const { handler, url } = await mcpServer(gameplay);
    const realFetch = globalThis.fetch;
    const paths: string[] = [];
    const messages: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
      const source = new URL(String(input)); paths.push(source.pathname);
      if (source.protocol === "http:" || source.hostname.startsWith("www.")) return Promise.resolve(new Response(null, {
        status: 301, headers: { location: "https://domain.invalid/rules?antwar_probe=redirect" },
      }));
      if (source.pathname === "/mcp") return realFetch(new URL("/mcp", url), init);
      if (source.pathname === "/watch/catalog") return Promise.resolve(Response.json({ matches: [], lobbies: [] }));
      return Promise.resolve(new Response("page"));
    });
    const result = await domainProbe("https://domain.invalid", "https://control.invalid", 0.06, (...parts: string[]) => messages.push(parts.join(" ")));
    expect(result).toMatchObject({ status: "skipped", pass: null });
    expect(messages.some(message => message.includes("SKIPPED"))).toBe(true);
    expect(paths).toContain("/watch/catalog");
    expect(paths.some(path => path.startsWith("/watch/live/") || path.startsWith("/live/") || path.startsWith("/operator/"))).toBe(false);
    expect(handler.sessionCount).toBe(0);
  });
  // deploy.sh all reports the comparison skipped only on this line, as the real default logger prints it.
  it("prints the skip line deploy.sh recognises, through the real default logger, and exits 0", async () => {
    const { url } = await mcpServer(false);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
      const source = new URL(String(input));
      if (source.protocol === "http:" || source.hostname.startsWith("www.")) return Promise.resolve(new Response(null, {
        status: 301, headers: { location: "https://domain.invalid/rules?antwar_probe=redirect" },
      }));
      if (source.pathname === "/mcp") return realFetch(new URL("/mcp", url), init);
      if (source.pathname === "/watch/catalog") return Promise.resolve(Response.json({ matches: [], lobbies: [] }));
      return Promise.resolve(new Response("page"));
    });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { lines.push(format(...parts)); });
    let code: number;
    try { code = await runProbe(["domain", "https://domain.invalid", "https://control.invalid", "0.06"]); } finally { spy.mockRestore(); }
    expect(code).toBe(0);
    const skip = lines.filter((line) => line.includes("SKIPPED"));
    expect(skip).toHaveLength(1);
    // The fake probe in deploy.test.ts prints this shape.
    expect(skip[0]).toMatch(/^\S+ RESULT domain comparison SKIPPED \{/);
    // deploy.sh's own pattern, run as deploy.sh runs it, accepts the real line; no other line passes for a skip.
    const pattern = /grep -Eq '(\^\[\^ \]\+ RESULT domain comparison SKIPPED )' "\$PROBE_LOG"/.exec(readFileSync("deploy/cloud-run/deploy.sh", "utf8"))?.[1];
    expect(pattern).toBeDefined();
    expect(spawnSync("grep", ["-Eq", pattern!], { input: `${skip[0]}\n` }).status).toBe(0);
    expect(spawnSync("grep", ["-Eq", pattern!], { input: `${lines.filter((line) => !line.includes("SKIPPED")).join("\n")}\n` }).status).toBe(1);
  });
  it("fails rather than skipping a disagreement between nonempty catalogs", async () => {
    const { handler, url } = await mcpServer(false);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
      const source = new URL(String(input));
      if (source.protocol === "http:" || source.hostname.startsWith("www.")) return Promise.resolve(new Response(null, {
        status: 301, headers: { location: "https://domain.invalid/rules?antwar_probe=redirect" },
      }));
      if (source.pathname === "/mcp") return realFetch(new URL("/mcp", url), init);
      if (source.pathname === "/watch/catalog") return Promise.resolve(Response.json({ matches: [{
        lobbyId: source.hostname === "domain.invalid" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", startedAt: 123,
      }] }));
      return Promise.resolve(new Response("page"));
    });
    await expect(domainProbe("https://domain.invalid", "https://control.invalid", 0.06, quiet)).rejects.toThrow("no shared match");
    expect(handler.sessionCount).toBe(0);
  });
  it("does not treat malformed or unavailable catalogs as empty", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ matches: [{ lobbyId: "../../elsewhere", startedAt: 123 }] })));
    await expect(publicMatches("https://domain.invalid")).rejects.toThrow("invalid public match catalog");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 503 })));
    await expect(publicMatches("https://domain.invalid")).rejects.toThrow("HTTP 503");
  });
  it("runs only the read-only https://antwars.ai checks, never the domain comparison or a live push check", () => {
    const workflow = readFileSync(".github/workflows/antwar-public-probe.yml", "utf8");
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
    // Every live check targets the public address only.
    expect(workflow).toContain("  ANTWAR_URL: https://antwars.ai\n");
    expect(workflow).toContain('probe.mjs entrypoint "$ANTWAR_URL"');
    expect(workflow).toContain('probe.mjs stream "$ANTWAR_URL" 720 60');
    expect([...workflow.matchAll(/probe\.mjs (\w+)/g)].map((m) => m[1])).toEqual(["entrypoint", "stream"]);
    // The domain comparison moved to deploy.sh all: no domain mode, no service host, no control address.
    for (const gone of ["probe.mjs domain", "probe.mjs join", "run.app", "ANTWAR_CONTROL", "inputs.", "MODE", "domain-probe.log"]) expect(workflow).not.toContain(gone);
    expect(workflow).not.toContain("id-token: write"); expect(workflow).not.toContain("secrets.");
  });
  it("schedules the entry-point probe with no inputs, alerting only by failing the run", () => {
    const workflow = readFileSync(".github/workflows/antwar-public-probe.yml", "utf8");
    expect(workflow).toMatch(/\n {2}schedule:\n {4}- cron: '[^']+'\n/);
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'");
    expect(workflow).toMatch(/\n {2}workflow_dispatch:\n(?! {4})/);
    // No alert channel beyond the failed run itself.
    for (const channel of ["secrets.", "webhook", "hooks.slack", "curl ", "continue-on-error"]) expect(workflow).not.toContain(channel);
  });
});

// A scheduled run alerts only by failing, so the exit code is the contract.
describe("probe exit status", () => {
  type StreamFault = "none" | "early-close" | "errored-close" | "refused" | "ping-500" | "ping-dropped";
  /** Minimal streamable-HTTP MCP endpoint whose GET stream and pings can degrade. */
  async function faultyMcp(fault: StreamFault) {
    return http((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "DELETE") { res.writeHead(200).end(); return; }
        if (req.method === "GET") {
          if (fault === "refused") { res.writeHead(404).end(); return; }
          res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
          res.write(": open\n\n");
          if (fault === "early-close") setTimeout(() => res.end(), 30);
          if (fault === "errored-close") setTimeout(() => res.socket?.destroy(), 30);
          return;
        }
        const message = JSON.parse(body) as { method: string; id?: number };
        if (message.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "probe-test-session" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })); return;
        }
        if (message.method === "ping" && fault === "ping-dropped") { res.socket?.destroy(); return; }
        if (message.method === "ping" && fault === "ping-500") { res.writeHead(500).end(); return; }
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
    });
  }
  const STREAM = ["0.3", "0.05"] as const; // hold seconds, ping seconds

  it("stream mode exits 0 only when the stream is held to the deadline and every ping answers", async () => {
    const result = await streamProbe(await faultyMcp("none"), Number(STREAM[0]), Number(STREAM[1]), quiet);
    expect(result).toMatchObject({ pass: true, pingFailures: 0 });
    expect(await runProbe(["stream", await faultyMcp("none"), ...STREAM], quiet)).toBe(0);
  });
  it("stream mode also passes against the real MCP handler", async () => {
    const handler = createMcpHandler(new Game(), { gameplay: false }); closes.push(() => handler.close());
    const url = await http((req, res) => { void handler.handle(req, res); });
    expect(await runProbe(["stream", url, ...STREAM], quiet)).toBe(0);
  });
  it.each<[StreamFault, string]>([
    ["early-close", "closed by the far end"],
    ["errored-close", "closed by an error"],
    ["ping-500", "failed pings"],
    ["ping-dropped", "failed pings"],
  ])("stream mode with %s exits 1", async (fault, why) => {
    const lines: string[] = [];
    const code = await runProbe(["stream", await faultyMcp(fault), ...STREAM], (...parts: unknown[]) => lines.push(parts.join(" ")));
    expect(code).toBe(1);
    const result = lines.find((line) => line.startsWith("RESULT stream probe"));
    expect(result).toContain("FAIL"); expect(result).toContain(why);
    if (fault.startsWith("ping")) expect(result).not.toContain("failed pings 0");
  });
  it("a refused GET stream, a failed entry point or bad usage exits 1", async () => {
    expect(await runProbe(["stream", await faultyMcp("refused"), ...STREAM], quiet)).toBe(1);
    expect(await runProbe(["entrypoint", await http((_req, res) => res.writeHead(503).end())], quiet)).toBe(1);
    expect(await runProbe(["bogus", "https://domain.invalid"], quiet)).toBe(1);
  });
  it("domain mode: an empty-catalog skip exits 0, a failed comparison exits 1", async () => {
    const handler = createMcpHandler(new Game(), { gameplay: false }); closes.push(() => handler.close());
    const url = await http((req, res) => { void handler.handle(req, res); });
    const realFetch = globalThis.fetch;
    let catalog = (_host: string) => ({ matches: [] as { lobbyId: string; startedAt: number }[] });
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
      const source = new URL(String(input));
      if (source.protocol === "http:" || source.hostname.startsWith("www.")) return Promise.resolve(new Response(null, {
        status: 301, headers: { location: "https://domain.invalid/rules?antwar_probe=redirect" },
      }));
      if (source.pathname === "/mcp") return realFetch(new URL("/mcp", url), init);
      if (source.pathname === "/watch/catalog") return Promise.resolve(Response.json(catalog(source.hostname)));
      return Promise.resolve(new Response("page"));
    });
    const args = ["domain", "https://domain.invalid", "https://control.invalid", "0.06"];
    expect(await runProbe(args, quiet)).toBe(0);
    catalog = (host) => ({ matches: [{ lobbyId: host === "domain.invalid" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", startedAt: 123 }] });
    expect(await runProbe(args, quiet)).toBe(1);
  });
  it.each<[StreamFault, number]>([["none", 0], ["early-close", 1]])("the real CLI process with %s exits %i", async (fault, expected) => {
    const url = await faultyMcp(fault);
    const code = await new Promise<number | null>((resolve) => {
      execFile(process.execPath, ["deploy/cloud-run/probe.mjs", "stream", url, ...STREAM], (error) => resolve(error ? (error.code as number) : 0));
    });
    expect(code).toBe(expected);
  });
});
