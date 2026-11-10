import { createServer, get as httpGet } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { startSpectatedServer } from "../../src/spectator.ts";
import { createGcsHistorySource, type HistoryPage, type HistorySource } from "../../src/replays/history-source.ts";
import { createMatchesData } from "../../web/src/matches-page/data.ts";
import { recordingRows } from "../../web/src/ui/format.ts";
import { vi } from "vitest";

const id = "2026-10-20T02-00-00-000Z-18";
const summary = { id, startedAt: "2026-10-20T02:00:00.000Z", endedAt: null, simulationEndedAt: "2026-10-20T02:30:00.000Z",
  winner: 0 as const, reason: "time_up", decidedBy: "territory", seats: Array.from({ length: 8 }, (_, seat) => ({ seat, colony: (seat % 2) as 0 | 1, modelLabel: "claude-sonnet-5-5", thinkingLevel: null, serviceTier: null, handle: null })),
  status: "partial" as const, unavailable: ["Historical refusal reasons unavailable."] };
const full = { format: "antwar.match", version: 1, ...summary, setup: { mapW: 64, rated: true, modelIndex: true },
  result: { winner: 0, reason: "time_up", decidedBy: "territory", tick: 17999 },
  seats: summary.seats.map(seat => ({ ...seat, commands: [{ tick: 121, type: "order", accepted: false, request: null, error: null }] })), events: [{ kind: "order" }] };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function server(source?: HistorySource) {
  const dir = await mkdtemp(join(tmpdir(), "match-history-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const app = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, match: "held", historySource: source });
  cleanup.push(() => app.close());
  return { app, url: `http://127.0.0.1:${app.port}` };
}
function fixture() {
  const calls: string[] = [];
  const source: HistorySource = {
    async list(token) { calls.push(`list:${token ?? "start"}`); return token === undefined ? { matches: [], nextPageToken: "second" }
      : { matches: [summary], nextPageToken: null }; },
    async open(matchId) { calls.push(`open:${matchId}`); return matchId === id ? Readable.from([Buffer.from(JSON.stringify(full))]) : null; },
  };
  return { source, calls };
}

it("serves bucket history anonymously across pages and restarts, independent of this instance's replay list", async () => {
  const f = fixture();
  for (let run = 0; run < 2; run++) {
    const s = await server(f.source);
    expect(await (await fetch(`${s.url}/matches`)).json()).toEqual({ matches: [], nextPageToken: "second" });
    const page = await (await fetch(`${s.url}/matches?pageToken=second`)).json() as HistoryPage;
    // A summary without the record's setup fields lists with no match type.
    expect(page).toEqual({ matches: [{ ...summary, matchType: null }], nextPageToken: null });
    expect(JSON.stringify(page)).not.toContain("commands");
    expect(JSON.stringify(page)).not.toContain("events");
    expect(await (await fetch(`${s.url}/live/replays`)).json()).toEqual({ replays: [] });
    const record = await fetch(`${s.url}/matches/${id}`);
    expect(record.status).toBe(200);
    expect(record.headers.get("content-type")).toBe("application/json");
    expect(await record.json()).toEqual(full);
    await s.app.close();
  }
});

it("supports HEAD, rejects mutations/invalid ids/cursors before any bucket call, and preserves replay paths", async () => {
  const f = fixture(), s = await server(f.source);
  for (const [path, method, status] of [["/matches", "POST", 405], [`/matches/${id}`, "DELETE", 405], ["/matches/bad", "GET", 404],
    [`/matches/${id}%2Fother`, "GET", 404], ["/matches/2026-02-30T00-00-00-000Z-1", "GET", 404],
    ["/matches?pageToken=", "GET", 400], ["/matches?pageToken=%0A", "GET", 400], ["/matches?pageToken=a&pageToken=b", "GET", 400],
    ["/matches?object=secret", "GET", 400], [`/matches/${id}?pageToken=a`, "GET", 400]] as const) {
    expect((await fetch(s.url + path, { method })).status).toBe(status);
  }
  expect(f.calls).toEqual([]);
  const head = await fetch(`${s.url}/matches`, { method: "HEAD" });
  expect(head.status).toBe(200); expect(await head.text()).toBe("");
  const recordHead = await fetch(`${s.url}/matches/${id}`, { method: "HEAD" });
  expect(recordHead.status).toBe(200); expect(await recordHead.text()).toBe("");
  expect((await fetch(`${s.url}/replays/${id}`)).status).toBe(404);
});

it("distinguishes missing objects and provider failures without leaking response data", async () => {
  const s = await server({ list: async () => { throw new Error("Bearer private-provider-secret"); },
    open: async matchId => { if (matchId === id) throw new Error("private-provider-secret"); return null; } });
  for (const path of ["/matches", `/matches/${id}`]) {
    const response = await fetch(s.url + path);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private-provider-secret");
  }
  expect((await fetch(`${s.url}/matches/2026-10-20T01-00-00-000Z-17`)).status).toBe(404);
});

it("does not mount history when no source is configured", async () => {
  const s = await server();
  expect((await fetch(`${s.url}/matches`)).status).toBe(404);
  expect((await fetch(`${s.url}/matches/${id}`)).status).toBe(404);
});

it("keeps both anonymous routes correct across warm summaries, HEAD, changed generations and provider errors", async () => {
  let reads = 0, generation = "1", fail = false;
  const provider = createServer((req, res) => {
    reads++;
    expect(req.headers.authorization).toBe("Bearer scripted-history-token");
    expect(req.headers["accept-encoding"]).toBe("gzip");
    if (fail) { res.writeHead(403).end("private-provider-secret"); return; }
    res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(JSON.stringify(full)));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const source = createGcsHistorySource("scripted-only", async input => String(input).startsWith("http://metadata")
    ? Response.json({ access_token: "scripted-history-token" }) : Response.json({ items: [{ name: `${id}.json`, generation }] }),
  (url, options, response) => httpGet(`http://127.0.0.1:${(provider.address() as AddressInfo).port}${url.pathname}${url.search}`, options, response));
  const s = await server(source);
  const individual = await fetch(`${s.url}/matches/${id}`);
  expect(individual.headers.get("content-encoding")).toBeNull();
  expect(await individual.json()).toEqual(full);
  // The record's setup gives its rated flag, Model Index marker and so its match type; no other setup field.
  // A Model Index row also carries its harness phase by its recorded start (no lobby here).
  const expected = { matches: [{ ...summary, rated: true, modelIndex: true, matchType: { kind: "index", size: 4 },
    harnessPhase: { phase: "rounds 1-7", possibleEffortMismatch: true } }], nextPageToken: null };
  expect(await (await fetch(`${s.url}/matches`)).json()).toEqual(expected);
  const head = await fetch(`${s.url}/matches`, { method: "HEAD" });
  expect(head.status).toBe(200); expect(await head.text()).toBe("");
  const warm = await fetch(`${s.url}/matches`);
  expect(warm.headers.get("cache-control")).toBe("no-store");
  expect(await warm.json()).toEqual(expected);
  expect(reads).toBe(2); // Individual record plus one summary read, not a cached page.
  generation = "2"; fail = true;
  const failed = await fetch(`${s.url}/matches`);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private-provider-secret");
  fail = false;
  expect(await (await fetch(`${s.url}/matches`)).json()).toEqual(expected);
  expect(reads).toBe(4);
  expect(await (await fetch(`${s.url}/matches/${id}`)).json()).toEqual(full);
  expect(reads).toBe(5); // Full records never use the summary cache.
});

it("cancels a pending list when the anonymous client disconnects", async () => {
  let entered!: () => void, stopped!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const canceled = new Promise<void>(resolve => { stopped = resolve; });
  const s = await server({ open: async () => null, list: (_token, signal) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener("abort", () => { stopped(); reject(new Error("canceled")); }, { once: true });
  }) });
  const request = httpGet(`${s.url}/matches`);
  request.on("error", () => {});
  await ready; request.destroy(); await canceled;
});

it("applies backpressure and cancels a full record when its reader closes", async () => {
  let produced = 0, notify!: () => void;
  const closed = new Promise<void>(resolve => { notify = resolve; });
  const body = Readable.from((async function* () {
    const chunk = Buffer.alloc(64 * 1024, 32);
    for (let index = 0; index < 5000; index++) { produced++; yield chunk; }
  })(), { objectMode: false });
  body.once("close", notify);
  const s = await server({ list: async () => ({ matches: [], nextPageToken: null }), open: async () => body });
  await new Promise<void>((resolve, reject) => {
    const request = httpGet(`${s.url}/matches/${id}`, response => {
      response.once("data", () => { response.destroy(); resolve(); });
    }); request.once("error", reject);
  });
  await closed;
  expect(body.destroyed).toBe(true);
  expect(produced).toBeLessThan(5000);
});

it("wires npm-start's main entrypoint to the bucket-backed routes without a game join", async () => {
  const dir = await mkdtemp(join(tmpdir(), "main-history-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", DATA_DIR: dir, ANTWAR_REPLAY_BUCKET: "scripted-main-history" };
  delete env.ANTWAR_RULES; delete env.ANTWAR_PLAYERS;
  const shim = `globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('http://metadata.google.internal/')) return Response.json({access_token:'scripted-main-token'});
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/scripted-main-history/o?')) return Response.json({items:[]});
    throw new Error('Unexpected test network request');
  };`;
  const child = spawn(process.execPath, ["--import", "./src/ts-resolve.mjs", "--import", `data:text/javascript,${encodeURIComponent(shim)}`, "src/main.ts"], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(async () => { if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; } });
  let output = "";
  child.stderr.on("data", chunk => { output += String(chunk); });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`entrypoint did not start: ${output.slice(-2000)}`)), 15_000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const match = /antwar listening on port (\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`entrypoint exited ${code}: ${output.slice(-2000)}`)); });
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/matches`)).json()).toEqual({ matches: [], nextPageToken: null });
  expect((await fetch(`http://127.0.0.1:${port}/live/replays`)).status).toBe(404);
});

it("wires newest bucket pages to first-load results/models and keeps manual load more older", async () => {
  const ids = Array.from({ length: 25 }, (_, minute) => `2026-10-25T00-${String(minute).padStart(2, "0")}-00-000Z-1`);
  const provider = createServer((req, res) => {
    const matchId = decodeURIComponent(new URL(req.url!, "http://fixture").pathname.split("/").at(-1)!).slice(0, -5);
    const minute = matchId.slice(14, 16);
    res.end(JSON.stringify({ ...full, id: matchId, startedAt: `2026-10-25T00:${minute}:00.000Z` }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const source = createGcsHistorySource("newest-fixture", async (input, init) => {
    expect(init!.method ?? "GET").toBe("GET");
    if (String(input).startsWith("http://metadata")) return Response.json({ access_token: "fake-newest-token" });
    const url = new URL(String(input)), end = url.searchParams.get("endOffset"), offset = Number(url.searchParams.get("pageToken") ?? 0);
    expect(url.searchParams.get("matchGlob")).toBe("*.json");
    // Storage applies the glob: saved records only, never .bin replays.
    const names = ids.flatMap(id => [`${id}.bin`, `${id}.json`]).filter(name => name.endsWith(".json") && (end === null || name < end)).sort();
    return Response.json({ items: names.slice(offset, offset + 7).map(name => ({ name, generation: "1" })),
      ...(offset + 7 < names.length ? { nextPageToken: String(offset + 7) } : {}) });
  }, (url, options, response) => httpGet(`http://127.0.0.1:${(provider.address() as AddressInfo).port}${url.pathname}${url.search}`, options, response));
  const s = await server(source);
  const first = await (await fetch(`${s.url}/matches`)).json() as HistoryPage;
  expect(first.matches.map(row => row.id)).toEqual([...ids].reverse().slice(0, 20));
  const historyPaths: string[] = [];
  const data = createMatchesData(async (input, init) => {
    const path = String(input);
    if (path === "/live/replays") return Response.json({ replays: [{ seq: 1, match: 1, replayId: ids[24] }] });
    historyPaths.push(path);
    return fetch(s.url + path, init);
  }, () => {});
  cleanup.push(async () => { data.destroy(); });
  data.refresh();
  await vi.waitFor(() => expect(data.view.recordings.status).toBe("ready"), { timeout: 20_000 });
  expect(data.view.recordings.rows).toHaveLength(20);
  expect(recordingRows(data.view, "")[0]).toMatchObject({ id: ids[24], result: "Very Large Colony won",
    models: expect.stringContaining("claude-sonnet-5-5"), record: "Record partial" });
  expect(historyPaths.filter(path => path.startsWith("/matches"))).toEqual(["/matches"]);
  data.more();
  await vi.waitFor(() => expect(data.view.next).toBeNull(), { timeout: 20_000 });
  expect(recordingRows(data.view, "").map(row => row.id)).toEqual([...ids].reverse());
}, 30_000);
