// Public-address probes for the hosted server. Plain Node, no Google
// credential and no Authorization header: run it from anywhere.
//
//   node deploy/cloud-run/probe.mjs entrypoint <base-url>
//     An MCP SDK client initializes and lists tools without joining or playing.
//   node deploy/cloud-run/probe.mjs stream <base-url> [seconds=720] [pingSeconds=60]
//     Opens one MCP session, opens its GET stream at /mcp, and holds it for
//     <seconds>, logging every byte the stream delivers and when and how it ends.
//     A ping POST every <pingSeconds> on its own request keeps the
//     session inside the server's idle expiry; its answer arrives on that POST,
//     never on the GET stream, whose byte count is reported.
//
// Exit status: 0 only when the mode's check passed. Stream mode
// passes only when the GET stream is held to the deadline and every ping
// answers 2xx; a failed ping or an early, clean or errored close exits 1.
// Domain mode with no shared public lobby reports SKIPPED and exits 0: the
// page, redirect, handshake and catalog checks before it still exit 1.
//
// Every line starts with a complete UTC timestamp.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
// The game's reconnect token lets its holder act as the agent: never print it.
const brief = (value) => {
  const text = JSON.stringify(value, (key, v) => (key === "reconnectToken" ? "[redacted]" : v));
  return text.length > 400 ? `${text.slice(0, 400)}… (${text.length} chars)` : text;
};

export async function entrypointProbe(base, emit = log) {
  await sdkHandshake(base, emit);
  emit("RESULT entrypoint probe: initialize/listTools succeeded without joining or playing");
}

export async function streamProbe(base, seconds, pingSeconds, emit = log) {
  const url = new URL("/mcp", base);
  const post = (body, sessionId) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION }),
      },
      body: JSON.stringify(body),
    });

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "antwar-stream-probe", version: "0.0.0" } },
  });
  const sessionId = init.headers.get("mcp-session-id");
  await init.text();
  if (!init.ok || sessionId === null) throw new Error(`initialize failed: HTTP ${init.status}`);
  const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  await initialized.text();
  emit("session established; initialized", initialized.status);

  const abort = new AbortController();
  const get = await fetch(url, {
    method: "GET",
    headers: { accept: "text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION },
    signal: abort.signal,
  });
  const openedAt = Date.now();
  emit("GET stream opened: HTTP", get.status, "content-type", get.headers.get("content-type"));
  if (!get.ok || get.body === null) throw new Error(`GET stream refused: HTTP ${get.status}`);

  let getBytes = 0;
  let ended = null;
  let held = false;
  let pingFailures = 0;
  let id = 1;
  const pings = [];
  const pinger = setInterval(() => {
    const pingId = (id += 1);
    pings.push((async () => {
      try {
        const res = await post({ jsonrpc: "2.0", id: pingId, method: "ping" }, sessionId);
        const text = await res.text();
        if (!res.ok) pingFailures += 1;
        emit(`ping ${pingId}: HTTP ${res.status}, ${Buffer.byteLength(text)} bytes on the POST response; GET stream bytes so far ${getBytes}`);
      } catch (err) {
        pingFailures += 1;
        emit(`ping ${pingId} failed:`, String(err));
      }
    })());
  }, pingSeconds * 1000);
  const deadline = setTimeout(() => {
    if (ended === null) { held = true; ended = "held for the full duration; closed by the probe"; }
    abort.abort();
  }, seconds * 1000);

  const reader = get.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended ??= "closed by the far end (stream ended cleanly)";
        break;
      }
      getBytes += value.byteLength;
      emit(`GET stream delivered ${value.byteLength} bytes: ${brief(Buffer.from(value).toString("utf8"))}`);
    }
  } catch (err) {
    ended ??= `closed by an error: ${String(err)}`;
  }
  clearInterval(pinger);
  clearTimeout(deadline);
  await Promise.all(pings);
  const heldSeconds = ((Date.now() - openedAt) / 1000).toFixed(1);
  const del = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION } }).catch((err) => err);
  emit("session delete:", del instanceof Error ? String(del) : `HTTP ${del.status}`);
  const pass = held && pingFailures === 0;
  emit(`RESULT stream probe ${pass ? "PASS" : "FAIL"}: open ${heldSeconds} s of ${seconds} s; ${ended}; failed pings ${pingFailures}; GET stream bytes ${getBytes}`);
  return { pass, ended, pingFailures, heldSeconds: Number(heldSeconds), getBytes };
}

// Adds `domain <base-url> <control-url> [seconds=720]`. No join,
// reconnect, match-start or application mutation is ever issued in that mode.
// All samples have UTC and monotonic arrival times. No session/token is logged.
export const TIMING_TOLERANCE_MS = 1000; // Measurement tolerance, not a user requirement.
const HEARTBEAT_MS = 15_000; // src/live/config.ts and SDK 1.32.1 sseKeepAlive.js.
const REQUEST_MS = 20_000;
const FRAME_LIMIT = 100_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const timedFetch = (url, init = {}) => fetch(url, { redirect: "error", ...init,
  signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS) });

/** Chunk-safe SSE parser, including comment keepalives, CRLF and split UTF-8. */
export function sseParser(onFrame) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new Error("oversized SSE frame/chunk");
      let end;
      while ((end = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const lines = frame.split(/\r?\n/);
        const data = lines.filter((x) => x.startsWith("data:")).map((x) => x.slice(5).replace(/^ /, "")).join("\n");
        onFrame({ kind: data.length ? "event" : "keepalive", data,
          signature: hash(data.length ? data : frame), bytes: Buffer.byteLength(frame) });
      }
    },
    finish() {
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error("truncated SSE frame");
    },
  };
}

// The spectator stream versions src/live/format.ts defines, STREAM_VERSION through its
// latest *_STREAM_VERSION; every one shares the header read below. Plain Node cannot
// import format.ts, so probe.test.ts binds this range to those constants.
export const SPECTATOR_STREAM_VERSIONS = Object.freeze({ min: 4, max: 25 });

/** Read just the public binary header: magic, version, flags, varint tick. */
export function spectatorTick(data) {
  const bytes = inflateRawSync(Buffer.from(data, "base64"), { maxOutputLength: MAX_FRAME_BYTES });
  if (bytes.length < 5 || bytes.readUInt16LE(0) !== 0x5741 ||
    bytes[2] < SPECTATOR_STREAM_VERSIONS.min || bytes[2] > SPECTATOR_STREAM_VERSIONS.max) throw new Error("unknown spectator framing");
  let tick = 0;
  for (let i = 4, shift = 0; i < bytes.length && shift < 35; i++, shift += 7) {
    tick += (bytes[i] & 127) * 2 ** shift;
    if (!(bytes[i] & 128)) return tick;
  }
  throw new Error("invalid spectator tick");
}

export async function holdStream(label, url, { headers = {}, seconds, signal, emit = log, spectator = false, match = null } = {}) {
  const local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const requested = performance.now();
  let opened = null;
  let timer;
  let reader;
  let deadline = false;
  const samples = [];
  const result = { label, samples, requestedAt: requested, openedAt: null, heldMs: 0, complete: false, error: null, match: null };
  try {
    // Header deadline is independent of the 720-second body deadline.
    const headerTimer = setTimeout(() => local.abort(), REQUEST_MS);
    let res;
    try { res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, redirect: "error", signal: combined }); }
    finally { clearTimeout(headerTimer); }
    if (!res.ok || !res.headers.get("content-type")?.startsWith("text/event-stream") || res.body === null) {
      await res.body?.cancel();
      throw new Error(`stream refused: HTTP ${res.status}`);
    }
    opened = performance.now();
    result.openedAt = opened;
    // Public watch proxies do not forward slot-local sequence headers. Their
    // immutable lobby identity comes from the catalog and the exact watch URL.
    result.match = match ?? res.headers.get("x-antwar-match");
    emit("OPEN", JSON.stringify({ label, at: new Date().toISOString(), monotonicMs: opened, headerDelayMs: opened - requested, match: result.match }));
    timer = setTimeout(() => { deadline = true; local.abort(); }, seconds * 1000);
    const parser = sseParser((frame) => {
      if (samples.length >= FRAME_LIMIT) throw new Error("too many SSE frames");
      const mono = performance.now();
      const { data, ...metadata } = frame;
      const sample = { ...metadata, at: new Date().toISOString(), monotonicMs: mono, elapsedMs: mono - opened,
        ...(spectator && frame.kind === "event" ? { tick: spectatorTick(data) } : {}) };
      samples.push(sample);
      emit("ARRIVAL", JSON.stringify({ label, ...sample }));
    });
    reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { parser.finish(); throw new Error("stream closed early"); }
      parser.push(value);
    }
  } catch (error) {
    result.complete = deadline && !(signal?.aborted);
    if (!result.complete) result.error = error instanceof Error ? error.message : "stream execution failed";
  } finally {
    clearTimeout(timer);
    local.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    result.heldMs = opened === null ? 0 : performance.now() - opened;
    emit("CLOSED", JSON.stringify({ ...result, samples: samples.length }));
  }
  return result;
}

/** No retries or reconnects: an early close or buffered burst is a failed run. */
export function compareStreams(domain, mcp, control, seconds, toleranceMs = TIMING_TOLERANCE_MS) {
  const failures = [];
  const metrics = [];
  for (const stream of [domain, mcp, control]) {
    if (!stream.complete || stream.heldMs + 5 < seconds * 1000) failures.push(`${stream.label}: not held for full duration`);
    if (stream.samples.length < 2) failures.push(`${stream.label}: insufficient arrivals`);
    const gaps = [stream.samples[0]?.elapsedMs ?? stream.heldMs];
    for (let i = 1; i < stream.samples.length; i++) gaps.push(stream.samples[i].elapsedMs - stream.samples[i - 1].elapsedMs);
    gaps.push(stream.heldMs - (stream.samples.at(-1)?.elapsedMs ?? 0));
    const maxSilenceMs = Math.max(...gaps);
    if (maxSilenceMs > HEARTBEAT_MS + toleranceMs) failures.push(`${stream.label}: silence exceeds server heartbeat cadence`);
    const keepalives = stream.samples.filter((s) => s.kind === "keepalive");
    if (stream === mcp && keepalives.length < Math.max(2, Math.floor(seconds * 1000 / HEARTBEAT_MS) - 1)) failures.push(`${stream.label}: missing MCP keepalives`);
    metrics.push({ label: stream.label, arrivals: stream.samples.length, keepalives: keepalives.length, maxSilenceMs });
  }
  if (domain.match === null || domain.match !== control.match) failures.push("spectator streams are not the same match");
  // Identical public payload fingerprints remove client/server clock skew. Only
  // compare frames emitted after both opens and before either deadline boundary.
  const controlEvents = new Map(control.samples.filter((s) => s.kind === "event").map((s) => [s.signature, s]));
  const lags = domain.samples.filter((s) => s.kind === "event" && controlEvents.has(s.signature))
    .map((s) => s.monotonicMs - controlEvents.get(s.signature).monotonicMs);
  const commonStart = Math.max(domain.openedAt ?? 0, control.openedAt ?? 0) + toleranceMs;
  const commonEnd = Math.min((domain.openedAt ?? 0) + domain.heldMs, (control.openedAt ?? 0) + control.heldMs) - toleranceMs;
  const domainEvents = new Set(domain.samples.filter((s) => s.kind === "event").map((s) => s.signature));
  const missing = control.samples.filter((s) => s.kind === "event" && s.monotonicMs > commonStart && s.monotonicMs < commonEnd && !domainEvents.has(s.signature)).length;
  if (missing) failures.push(`domain spectator: ${missing} control events missing`);
  if (lags.some((lag) => lag > toleranceMs)) failures.push("domain spectator: delayed compared with run.app");
  // A stalled event stream that later catches up is also detected between ticks.
  for (const stream of [domain, control]) {
    const events = stream.samples.filter((s) => s.tick !== undefined);
    let maxCadenceExcessMs = 0;
    for (let i = 1; i < events.length; i++) {
      const ticks = events[i].tick - events[i - 1].tick;
      if (ticks > 0) maxCadenceExcessMs = Math.max(maxCadenceExcessMs, events[i].elapsedMs - events[i - 1].elapsedMs - ticks * 100);
    }
    metrics.find((m) => m.label === stream.label).maxCadenceExcessMs = maxCadenceExcessMs;
    if (maxCadenceExcessMs > toleranceMs) failures.push(`${stream.label}: tick cadence delayed`);
  }
  return { pass: failures.length === 0, failures, metrics, matchedEvents: lags.length, missingEvents: missing,
    maxDomainLagMs: lags.length ? Math.max(...lags) : null, toleranceMs,
    cadence: { spectatorTickMs: 100, spectatorHeartbeatMs: HEARTBEAT_MS, mcpHeartbeatMs: HEARTBEAT_MS },
    limitation: "MCP keepalives carry no server timestamp; their arrival cadence, not absolute one-way latency, is measured." };
}

export async function sdkHandshake(base, emit = log) {
  const client = new Client({ name: "antwar-domain-probe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), { fetch: timedFetch });
  try {
    await client.connect(transport);
    const tools = await client.listTools({}, { timeout: REQUEST_MS });
    if (!tools.tools.length) throw new Error("no tools listed");
    emit("SDK initialize/listTools succeeded without join", JSON.stringify({ tools: tools.tools.map((t) => t.name) }));
  } finally {
    try { await transport.terminateSession(); } finally { await client.close(); }
  }
}

// Strip only a literal scheme-default port, not other URL syntax: parsing and
// reserializing would also normalize hosts, dot segments and other exact fields.
export function assertRedirect(status, location, expected) {
  const withoutDefaultPort = location
    ?.replace(/^(https:\/\/[^/?#]+):443(?=[/?#]|$)/, "$1")
    .replace(/^(http:\/\/[^/?#]+):80(?=[/?#]|$)/, "$1");
  if (status !== 301 || withoutDefaultPort !== expected) {
    throw new Error(`redirect failed: HTTP ${status}; Location: ${JSON.stringify(location)}`);
  }
}

async function publicPages(base, control, emit) {
  for (const url of [new URL("/", base), new URL("/rules", base), new URL("/", control)]) {
    const response = await timedFetch(url);
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`page check HTTP ${response.status}`);
    emit("PAGE 200", url.href);
  }
  const target = new URL("/rules?antwar_probe=redirect", base);
  const http = new URL(target); http.protocol = "http:";
  const www = new URL(target); www.hostname = `www.${target.hostname}`;
  for (const source of [http, www]) {
    const response = await timedFetch(source, { redirect: "manual" });
    await response.body?.cancel();
    assertRedirect(response.status, response.headers.get("location"), target.href);
    emit("REDIRECT 301 path/query preserved", source.href);
  }
}

/** Existing public catalog in both the current deployment and the retired-root build. */
export async function publicMatches(base) {
  const response = await timedFetch(new URL("/watch/catalog", base), { cache: "no-store" });
  if (!response.ok) throw new Error(`public catalog HTTP ${response.status}`);
  const value = await response.json();
  if (!value || !Array.isArray(value.matches) || !value.matches.every(match =>
    match && typeof match.lobbyId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(match.lobbyId)
    && Number.isFinite(match.startedAt))) throw new Error("invalid public match catalog");
  return value.matches;
}

export async function domainProbe(base, control, seconds = 720, emit = log) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 720) throw new Error("duration must be in (0,720] seconds");
  const baseUrl = new URL(base), controlUrl = new URL(control);
  if (baseUrl.protocol !== "https:" || controlUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || controlUrl.username || controlUrl.password || baseUrl.origin === controlUrl.origin) throw new Error("two distinct credential-free HTTPS origins required");
  await publicPages(base, control, emit); // Native TLS verification; never -k.
  await sdkHandshake(base, emit);
  const [domainMatches, controlMatches] = await Promise.all([publicMatches(base), publicMatches(control)]);
  if (!domainMatches.length || !controlMatches.length) {
    const skipped = { status: "skipped", pass: null, reason: "no public lobby available in both catalogs; stream comparison not performed" };
    emit("RESULT domain comparison SKIPPED", JSON.stringify(skipped));
    return skipped;
  }
  const shared = domainMatches.find(match => controlMatches.some(other => other.lobbyId === match.lobbyId && other.startedAt === match.startedAt));
  if (!shared) throw new Error("public catalogs have no shared match; stream comparison cannot establish identity");
  const watchPath = `/watch/live/${shared.lobbyId}`;
  const url = new URL("/mcp", base);
  let sessionId;
  let id = 1;
  const post = async (body) => {
    const response = await timedFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION } : {}) }, body: JSON.stringify(body) });
    const sid = response.headers.get("mcp-session-id");
    await response.text();
    if (!response.ok) throw new Error(`MCP POST HTTP ${response.status}`);
    return sid;
  };
  let pinger;
  let pingInFlight = Promise.resolve();
  const stop = new AbortController();
  try {
    sessionId = await post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "antwar-domain-stream", version: "1.0.0" } } });
    if (!sessionId) throw new Error("initialize did not establish a session");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    pinger = setInterval(() => {
      pingInFlight = pingInFlight.then(async () => { await post({ jsonrpc: "2.0", id: ++id, method: "ping" }); })
        .catch(() => { emit("MCP ping failed"); stop.abort(); });
    }, 60_000);
    const common = { seconds, signal: stop.signal, emit };
    const results = await Promise.all([
      holdStream("domain-spectator", new URL(watchPath, base), { ...common, spectator: true, match: shared.lobbyId }),
      holdStream("domain-mcp", url, { ...common, headers: { "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION } }),
      holdStream("run.app-spectator", new URL(watchPath, control), { ...common, spectator: true, match: shared.lobbyId }),
    ]);
    const comparison = { ...compareStreams(...results, seconds), status: "compared", lobbyId: shared.lobbyId };
    emit("RESULT domain comparison", JSON.stringify(comparison));
    if (!comparison.pass) throw new Error("domain stream comparison failed; stop without workaround");
    return comparison;
  } finally {
    clearInterval(pinger);
    stop.abort();
    await pingInFlight;
    if (sessionId) {
      const response = await timedFetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION } });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`session cleanup HTTP ${response.status}`);
    }
  }
}

/** Runs one CLI mode and returns its process exit code (see the header). */
export async function runProbe([mode, base, a, b], emit = log) {
  try {
    if (base === undefined || !["entrypoint", "stream", "domain"].includes(mode)) throw new Error("usage: probe.mjs entrypoint <base> | stream <base> [seconds=720] [pingSeconds=60] | domain <base> <control> [seconds=720]");
    emit("probe", mode, base);
    if (mode === "entrypoint") await entrypointProbe(base, emit);
    else if (mode === "stream") return (await streamProbe(base, Number(a ?? 720), Number(b ?? 60), emit)).pass ? 0 : 1;
    else await domainProbe(base, a, Number(b ?? 720), emit);
    return 0;
  } catch (error) {
    // Do not echo server response bodies or session-bearing errors.
    emit("RESULT probe failed", error instanceof Error ? error.message : "execution failed");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runProbe(process.argv.slice(2));
}
