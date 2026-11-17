/** Bounded real-browser spectator check. External recordings stay outside source control.
 * --recording URL --from TICK --to TICK selects <=301 messages, reconstructing its opening full.
 * Without a URL, use the existing two-colony fixture. --mode live|recording; --slow-ms 2500
 * blocks drawn 3D frames only. --dist selects a separately built baseline. Results go to stdout.
 */
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync } from "node:zlib";
import { chromium } from "playwright-core";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { recordingMessages } from "../src/recording.ts";
import { scale2Packets } from "./scale2-recording.ts";
import type { AntwarApi } from "../src/main.ts";

const { values } = parseArgs({ options: {
  recording: { type: "string" }, from: { type: "string", default: "0" }, to: { type: "string", default: "200" },
  mode: { type: "string", default: "live" }, "slow-ms": { type: "string", default: "0" },
  duration: { type: "string", default: "45" }, dist: { type: "string", default: "web/dist" },
  chrome: { type: "string" }, automatic: { type: "boolean", default: false },
  "finish-on-fallback": { type: "boolean", default: false },
} });
const from = Number(values.from), to = Number(values.to), slowMs = Number(values["slow-ms"]), duration = Number(values.duration);
if (![from, to, slowMs, duration].every(Number.isFinite) || from < 0 || to < from || to - from > 300 || slowMs < 0 || slowMs > 5000 || duration < 1 || duration > 120 || !["live", "recording"].includes(values.mode!)) throw new Error("Invalid bounded scenario");
const packets: StreamMessage[] = [];
if (values.recording) {
  const signal = AbortSignal.timeout(120_000);
  const response = await fetch(values.recording, { signal });
  if (!response.ok || !response.body) throw new Error(`Recording HTTP ${response.status}`);
  let state: SpectatorState | null = null;
  for await (const { message } of recordingMessages(response.body, signal)) {
    if (message.full) state = new SpectatorState(message.full, message.tick, message.ants);
    else state?.apply(message);
    if (!state) throw new Error("Recording lacks opening snapshot");
    if (message.tick >= from && message.tick <= to) packets.push(packets.length ? message : structuredClone(state.message()));
    if (message.tick >= to) break;
  }
} else {
  packets.push(...scale2Packets(200).map(decodeMessage));
}
if (!packets.length || !packets[0]!.full) throw new Error("No selected recording messages");
const packed = packMessages(packets.map(encodeMessage));
if (packed.byteLength > 10 * 1024 * 1024) throw new Error("Selected fixture exceeds 10 MiB");
const raw = packets.map(m => deflateRawSync(encodeMessage(m)).toString("base64"));
const clients = new Set<ServerResponse>();
let index = 0, timer: ReturnType<typeof setInterval> | undefined;
const state = new SpectatorState(structuredClone(packets[0]!.full!), packets[0]!.tick, packets[0]!.ants);
const connections: number[] = [];
const dist = resolve(values.dist!);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://localhost");
    const path = url.pathname;
    if (values["finish-on-fallback"] && path === "/" && url.searchParams.get("board") === "2d") {
      clearInterval(timer);
      while (index + 1 < packets.length) state.apply(packets[++index]!);
      if (!state.full.result) throw new Error("Finish race requires a terminal recording window");
    }
    if (path === "/watch/catalog") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ matches: state.full.result ? [] : [{ lobbyId: "fixture", startedAt: 1, rated: false, delaySeconds: 0 }], lobbies: [] })); return;
    }
    if (path.startsWith("/watch/status/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ lobbyId: "fixture", delaySeconds: 0, playbackFinished: false })); return;
    }
    if (path.startsWith("/watch/live/")) {
      connections.push(packets[index]!.tick);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(`data: ${deflateRawSync(encodeMessage(state.message())).toString("base64")}\n\n`);
      clients.add(res); res.on("close", () => clients.delete(res));
      timer ??= setInterval(() => {
        if (index + 1 >= packets.length) return;
        state.apply(packets[++index]!);
        for (const client of clients) client.write(`data: ${raw[index]}\n\n`);
        if (state.full.result) for (const client of clients) client.end();
      }, 100);
      if (state.full.result) res.end();
      return;
    }
    if (path === "/recordings/fixture.bin") { res.end(packed); return; }
    const file = resolve(dist, path === "/" ? "index.html" : path.slice(1));
    if (!file.startsWith(dist + sep)) { res.writeHead(404).end(); return; }
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
    res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No listener");
const errors: string[] = [], warnings: string[] = [];
const samples: unknown[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: values.chrome ?? process.env.HEADLESS_SHELL, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "warning") warnings.push(m.text()); });
  await page.addInitScript((delay: number) => {
    const raf = window.requestAnimationFrame.bind(window);
    let previous = -1;
    window.requestAnimationFrame = callback => raf(t => {
      if (delay && t !== previous && !new URLSearchParams(location.search).has("board") && window.__antwar) {
        previous = t;
        const end = performance.now() + delay;
        while (performance.now() < end) { /* Deliberately emulate a blocking 3D draw. */ }
      }
      callback(t);
    });
  }, slowMs);
  const route = values.mode === "live" ? values.automatic ? "watch=1" : "lobby=fixture" : "recording=fixture";
  await page.goto(`http://127.0.0.1:${address.port}/?${route}&frametime=1`, { waitUntil: "domcontentloaded" });
  const started = Date.now();
  while (Date.now() - started < duration * 1000) {
    try {
      samples.push(await page.evaluate(() => {
        const api: AntwarApi | undefined = window.__antwar;
        const safe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
        return { at: performance.now(), mode: new URLSearchParams(location.search).get("board") ?? "3d",
          clock: document.querySelector(".d1-clock, .d2-clock")?.textContent ?? null,
          board: api ? safe(() => api.board()) : null,
          playback: api ? safe(() => api.playback()) : null,
          timings: api ? safe(() => api.frameTimes()) : null,
          resultVisible: !!document.querySelector("dialog[open] .d1-result-head"),
        };
      }));
    } catch (error) { if (!String(error).includes("Execution context was destroyed")) throw error; }
    await new Promise(done => setTimeout(done, 1000));
  }
} finally {
  await browser?.close(); clearInterval(timer);
  for (const client of clients) client.end();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  console.log(JSON.stringify({ mode: values.mode, automatic: values.automatic, finishOnFallback: values["finish-on-fallback"], slowMs, from: packets[0]!.tick, to: packets.at(-1)!.tick,
    terminal: state.full.result, connections, errors, warnings, samples }, null, 2));
}
