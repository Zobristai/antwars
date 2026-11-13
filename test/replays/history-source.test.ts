import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { constants as zlibConstants, createGzip, gunzipSync, gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createGcsHistorySource, createHistorySummaryCache, historySourceFromEnv, type HistorySummary } from "../../src/replays/history-source.ts";
import type { ReplayGet } from "../../src/replays/access.ts";
import { parseSummary } from "../../src/replays/history-summary-worker.ts";

const id = "2026-10-20T02-00-00-000Z-18", emptyId = "2026-10-20T01-00-00-000Z-17";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const record = (matchId = id) => ({ format: "antwar.match", version: 1, id: matchId, startedAt: "2026-10-20T02:00:00.000Z", endedAt: null,
  simulationEndedAt: "2026-10-20T02:30:00.000Z", result: { winner: 0, reason: "time_up", decidedBy: "territory", tick: 17999 },
  seats: Array.from({ length: matchId === emptyId ? 0 : 8 }, (_, seat) => ({ seat, colony: seat % 2, modelLabel: "claude-sonnet-5-5", commands: [{ tick: 121 + seat, request: "large-private-to-list" }] })),
  status: "partial", unavailable: ["Historical refusal reasons unavailable."], events: [{ kind: "large-full-record-only" }] });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void,
  page: (token: string | null, url: URL) => unknown = () => ({ items: [{ name: `${id}.json` }] })) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const calls: { url: string; init?: RequestInit }[] = [], objects: string[] = [], received: Buffer[][] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "fake-history-token" });
    expect(init!.method ?? "GET").toBe("GET");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer fake-history-token");
    expect(new URL(url).searchParams.get("maxResults")).toBe("1000");
    expect(new URL(url).searchParams.get("matchGlob")).toBe("*.json");
    return Response.json(page(new URL(url).searchParams.get("pageToken"), new URL(url)));
  };
  const get: ReplayGet = (url, options, response) => {
    objects.push(url.href);
    return httpGet(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url.pathname}${url.search}`, options, res => {
      // Record each body chunk as the HTTP parser hands it to the response, before any decoding, without consuming it.
      const chunks: Buffer[] = [], push = res.push.bind(res);
      received.push(chunks);
      res.push = (chunk, encoding) => { if (chunk !== null) chunks.push(Buffer.from(chunk)); return push(chunk, encoding); };
      response(res);
    });
  };
  return { source: createGcsHistorySource("fake-history", request, get), request, get, calls, objects, received };
}
async function collect(body: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

it.each(["gzip", "raw", "raw-mislabeled-gzip"])("reads %s JSON by exact id with the server identity and decoded bytes", async mode => {
  const json = Buffer.from(JSON.stringify(record())), stored = mode === "gzip" ? gzipSync(json) : json;
  const f = await fixture((req, res) => {
    expect(req.headers.authorization).toBe("Bearer fake-history-token");
    expect(req.headers["accept-encoding"]).toBe("gzip");
    res.writeHead(200, mode === "raw" ? {} : { "content-encoding": "gzip" });
    res.write(stored.subarray(0, 1)); setImmediate(() => res.end(stored.subarray(1)));
  });
  const body = await f.source.open(id, new AbortController().signal);
  expect(await collect(body!)).toEqual(json);
  expect(f.objects).toEqual([`https://storage.googleapis.com/storage/v1/b/fake-history/o/${id}.json?alt=media`]);
  expect(f.calls).toHaveLength(1);
});

it("follows empty metadata continuations before selecting newest records and returns only summary fields", async () => {
  const f = await fixture((req, res) => {
    const name = decodeURIComponent(new URL(req.url!, "http://localhost").pathname.split("/").at(-1)!);
    res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(JSON.stringify(record(name.slice(0, -5)))));
  }, token => token === null ? { items: [{ name: `${id}.bin` }], nextPageToken: "second" }
    : { items: [{ name: `${id}.json` }, { name: `${emptyId}.json` }, { name: "ignore-me.json" }] });
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.nextPageToken).toBeNull();
  expect(page.matches).toHaveLength(2);
  expect(page.matches[0]).toMatchObject({ id, winner: 0, reason: "time_up", decidedBy: "territory", endedAt: null, status: "partial" });
  expect(page.matches[0]!.seats).toHaveLength(8);
  expect(page.matches[1]!.seats).toEqual([]);
  expect(JSON.stringify(page)).not.toContain("large-private-to-list");
  expect(JSON.stringify(page)).not.toContain("large-full-record-only");
  expect(f.calls.filter(call => call.url.startsWith("http://metadata"))).toHaveLength(1);
  expect(f.calls.filter(call => !call.url.startsWith("http://metadata"))).toHaveLength(2);
});

it("lists self-reported thinking levels beside models, normalizing old missing fields to null", async () => {
  const value = record();
  const seats = value.seats.map((seat, index) => ({ ...seat,
    ...(index === 0 ? { thinkingLevel: "high" } : index === 1 ? { thinkingLevel: "🧠".repeat(32) } : index === 2 ? { thinkingLevel: null } : {}),
  }));
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...value, seats })));
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches[0]!.seats.map(seat => seat.thinkingLevel)).toEqual(["high", "🧠".repeat(32), null, null, null, null, null, null]);
  expect(page.matches[0]!.seats[0]!.modelLabel).toBe("claude-sonnet-5-5");
});

it("lists self-reported service tiers beside levels, normalizing old missing fields to null", async () => {
  const value = record();
  const seats = value.seats.map((seat, index) => ({ ...seat,
    ...(index === 0 ? { serviceTier: "fast" } : index === 1 ? { serviceTier: "⚡".repeat(40) } : index === 2 ? { serviceTier: null } : {}),
  }));
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...value, seats })));
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches[0]!.seats.map(seat => seat.serviceTier)).toEqual(["fast", "⚡".repeat(32), null, null, null, null, null, null]);
});

it("lists each seat's recorded handle, normalizing old missing fields to null", async () => {
  const value = record();
  const seats = value.seats.map((seat, index) => ({ ...seat,
    ...(index === 0 ? { handle: "antwars/gpt-6-1-sol-xhigh" } : index === 1 ? { handle: null } : {}),
  }));
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...value, seats })));
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches[0]!.seats.map(seat => seat.handle)).toEqual(["antwars/gpt-6-1-sol-xhigh", null, null, null, null, null, null, null]);
});

it("lists each seat's stored start rating, reading an older record's absent or malformed one as null", async () => {
  const value = record();
  const start = { rating: 1612.4, rd: 48.5, ratedMatches: 31 };
  const seats = value.seats.map((seat, index) => ({ ...seat,
    ...(index === 0 ? { startRating: start } : index === 1 ? { startRating: { rating: 1500, rd: -1, ratedMatches: 0 } }
      : index === 2 ? { startRating: "1500" } : index === 3 ? { startRating: null } : {}),
  }));
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...value, seats })));
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches[0]!.seats.map(seat => seat.startRating)).toEqual([start, null, null, null, null, null, null, null]);
});

it.each([
  ["a rated Model Index setup", { mapW: 64, rated: true, modelIndex: true }, { rated: true, modelIndex: true }],
  ["a rated setup without the marker", { mapW: 64, rated: true }, { rated: true, modelIndex: false }],
  ["a setup that omits rated (an unrated match)", { mapW: 64 }, { rated: false, modelIndex: false }],
  ["a null setup (an unavailable record)", null, { rated: null, modelIndex: false }],
  ["no setup key at all", undefined, { rated: null, modelIndex: false }],
])("lists the record's rated flag and Model Index marker from %s, and no other setup field", async (_name, setup, expected) => {
  // Records place setup before events (src/replays/history.ts unavailableRecord key order).
  const { events, ...head } = record();
  const value = { ...head, ...(setup === undefined ? {} : { setup }), events };
  const f = await fixture((_req, res) => res.end(JSON.stringify(value)));
  const listed = (await f.source.list(undefined, new AbortController().signal)).matches[0]!;
  expect({ rated: listed.rated, modelIndex: listed.modelIndex }).toEqual(expected);
  expect(listed).not.toHaveProperty("setup");
  expect(JSON.stringify(listed)).not.toContain("mapW");
});

it("leaves a record with a non-string service tier off the page without exposing its contents", async () => {
  const value = record();
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...value, seats: [{ ...value.seats[0], serviceTier: 7 }] })));
  expect(await f.source.list(undefined, new AbortController().signal)).toEqual({ matches: [], nextPageToken: null });
});

it("leaves a record with a non-string thinking level off the page without exposing its contents", async () => {
  const value = record();
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...value, seats: [{ ...value.seats[0], thinkingLevel: 7 }] })));
  expect(await f.source.list(undefined, new AbortController().signal)).toEqual({ matches: [], nextPageToken: null });
});

it("validates ids/cursors before contacting identity or storage and stays inert without a bucket", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error("unexpected network"); };
  expect(historySourceFromEnv({}, request)).toBeUndefined();
  const source = createGcsHistorySource("fake", request);
  await expect(source.open("../secret", new AbortController().signal)).rejects.toThrow("invalid match id");
  await expect(source.list("\n", new AbortController().signal)).rejects.toThrow("invalid match page token");
  expect(calls).toBe(0);
});

it("distinguishes missing records and sanitized provider failure", async () => {
  for (const status of [404, 403]) {
    const f = await fixture((_req, res) => res.writeHead(status).end("do-not-echo-secret"));
    if (status === 404) expect(await f.source.open(id, new AbortController().signal)).toBeNull();
    else await expect(f.source.open(id, new AbortController().signal)).rejects.toThrow("match record read failed");
  }
});

it("leaves a malformed record off the page without copying its data", async () => {
  const f = await fixture((_req, res) => res.writeHead(200).end("invalid-secret-record"));
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page).toEqual({ matches: [], nextPageToken: null });
  expect(JSON.stringify(page)).not.toContain("invalid-secret-record");
});

it("checks the summary boundary in the parser entry: code-point limits, old missing fields, setup flags and rejected shapes", () => {
  const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  const parse = (change: (value: any) => void) => { const value: any = record(); change(value); return parseSummary(id, encode(value)); };
  const accepted: [string, (value: any) => void][] = [
    ["64 astral code points", value => { value.startedAt = "😀".repeat(64); }],
    ["64 lone surrogates", value => { value.result.reason = "\ud800".repeat(64); }],
    ["the largest safe seat", value => { value.seats[0].seat = 2 ** 53 - 1; }],
    ["64 seats and 32 reasons", value => { value.seats = Array.from({ length: 64 }, (_, seat) => ({ seat, colony: 0, modelLabel: null })); value.unavailable = Array(32).fill("u"); }],
    ["a null result and setup", value => { value.result = null; value.setup = null; }],
    ["unset setup flags", value => { value.setup = {}; }],
  ];
  for (const [label, change] of accepted) expect(() => parse(change), label).not.toThrow();
  const old = parse(value => { value.seats = [{ seat: 3, colony: 1, modelLabel: "😀".repeat(70) }]; delete value.setup; });
  expect(old.seats).toEqual([{ seat: 3, colony: 1, modelLabel: "😀".repeat(64), thinkingLevel: null, serviceTier: null, handle: null, startRating: null }]);
  expect(old).toMatchObject({ winner: 0, reason: "time_up", decidedBy: "territory", rated: null, modelIndex: false });
  expect(parse(value => { value.setup = { modelIndex: true }; })).toMatchObject({ rated: false, modelIndex: true });
  expect(parse(value => { value.setup = { rated: true }; })).toMatchObject({ rated: true, modelIndex: false });
  expect(Object.keys(parse(() => {}).seats[0]!)).not.toContain("commands");
  // An unrated match's drawn colony names; a record without them, or with anything but two names, lists the rated names.
  expect(parse(value => { value.setup = { rated: false, colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"] }; }).colonyNames).toEqual(["Sweetwater Colony", "Lake Skinner Colony"]);
  for (const colonyNames of [undefined, null, [], ["Sweetwater Colony"], ["Sweetwater Colony", ""], [1, 2]]) {
    expect(parse(value => { value.setup = { rated: false, colonyNames }; }), JSON.stringify(colonyNames)).not.toHaveProperty("colonyNames");
  }
  const rejected: [string, (value: any) => void][] = [
    ["65 code points", value => { value.startedAt = "😀".repeat(65); }],
    ["a wrong format", value => { value.format = "other"; }],
    ["a wrong version", value => { value.version = 2; }],
    ["a missing endedAt", value => { delete value.endedAt; }],
    ["a missing result", value => { delete value.result; }],
    ["winner 2", value => { value.result.winner = 2; }],
    ["a fractional seat", value => { value.seats[0].seat = 1.5; }],
    ["an unsafe seat", value => { value.seats[0].seat = 2 ** 53; }],
    ["a negative seat", value => { value.seats[0].seat = -1; }],
    ["colony 2", value => { value.seats[0].colony = 2; }],
    ["a missing modelLabel", value => { delete value.seats[0].modelLabel; }],
    ["65 seats", value => { value.seats = Array.from({ length: 65 }, (_, seat) => ({ seat, colony: 0, modelLabel: null })); }],
    ["33 reasons", value => { value.unavailable = Array(33).fill("u"); }],
    ["a non-string reason", value => { value.unavailable = [1]; }],
    ["an unknown status", value => { value.status = "done"; }],
    ["a non-boolean flag", value => { value.setup = { rated: "yes" }; }],
    ["an array setup", value => { value.setup = []; }],
  ];
  for (const [label, change] of rejected) expect(() => parse(change), label).toThrow();
  for (const raw of ["[]", "null", "\"record\"", "{"]) expect(() => parseSummary(id, encode(raw)), raw).toThrow();
  expect(() => parseSummary(emptyId, encode(record()))).toThrow("record identity mismatch");
});

it("client cancellation closes a progressing compressed upstream", async () => {
  let notify!: () => void;
  const closed = new Promise<void>(resolve => { notify = resolve; });
  const f = await fixture((_req, res) => {
    res.once("close", notify); res.writeHead(200); res.write(gzipSync('{"partial":'));
  });
  const abort = new AbortController();
  const body = (await f.source.open(id, abort.signal))!;
  const first = await body[Symbol.asyncIterator]().next();
  expect(first.done).toBe(false);
  abort.abort();
  await closed;
  expect(body.destroyed).toBe(true);
});

const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

it("reuses versioned summaries, isolates returned objects, and never reuses full-record streams", async () => {
  const f = await fixture((_req, res) => res.end(JSON.stringify(record())), () => ({ items: [{ name: `${id}.json`, generation: "1234567890123456789" }] }));
  const first = await f.source.list(undefined, signal());
  first.matches[0]!.seats[0]!.modelLabel = "changed by caller";
  first.matches[0]!.unavailable.push("changed by caller");
  const second = await f.source.list(undefined, signal());
  expect(second.matches[0]!.seats[0]!.modelLabel).toBe("claude-sonnet-5-5");
  expect(second.matches[0]!.unavailable).not.toContain("changed by caller");
  expect(f.objects).toHaveLength(1);
  expect(new URL(f.objects[0]!).searchParams.get("generation")).toBe("1234567890123456789");
  expect(f.calls.filter(call => !call.url.startsWith("http://metadata"))).toHaveLength(2);
  expect(new URL(f.calls.at(-1)!.url).searchParams.get("fields")).toBe("items(name,generation),nextPageToken");
  for (let index = 0; index < 2; index++) expect(JSON.parse((await collect((await f.source.open(id, signal()))!)).toString())).toEqual(record());
  expect(f.objects).toHaveLength(3);
  expect(new URL(f.objects[1]!).searchParams.has("generation")).toBe(false);
});

it("discovers new objects and changed generations without caching pages, including overlapping versions", async () => {
  let generation = "1", includeNew = false;
  const oldEntered = deferred<ServerResponse>();
  const f = await fixture((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.searchParams.get("generation") === "1") { oldEntered.resolve(res); return; }
    const matchId = decodeURIComponent(url.pathname.split("/").at(-1)!).slice(0, -5);
    res.end(JSON.stringify({ ...record(matchId), status: "complete" }));
  }, () => ({ items: [{ name: `${id}.json`, generation }, ...(includeNew ? [{ name: `${emptyId}.json`, generation: "2" }] : [])] }));
  const old = f.source.list(undefined, signal());
  const oldResponse = await oldEntered.promise;
  generation = "2"; includeNew = true;
  const newer = await f.source.list(undefined, signal());
  expect(newer.matches.map(match => match.id)).toEqual([id, emptyId]);
  expect(newer.matches[0]!.status).toBe("complete");
  oldResponse.end(JSON.stringify(record()));
  expect((await old).matches[0]!.status).toBe("partial");
  expect(await f.source.list(undefined, signal())).toEqual(newer);
  expect(f.objects).toHaveLength(3);
});

it("does not assume unversioned provider objects are immutable or share their reads", async () => {
  let status = "partial";
  const f = await fixture((_req, res) => res.end(JSON.stringify({ ...record(), status })));
  expect((await f.source.list(undefined, signal())).matches[0]!.status).toBe("partial");
  status = "complete";
  const pages = await Promise.all([f.source.list(undefined, signal()), f.source.list(undefined, signal())]);
  expect(pages.every(page => page.matches[0]!.status === "complete")).toBe(true);
  expect(f.objects).toHaveLength(3);
});

it("shares the cold read while one waiter cancels without aborting another", async () => {
  const entered = deferred<ServerResponse>(), bothListed = deferred<void>();
  let lists = 0;
  const f = await fixture((_req, res) => { res.writeHead(200); res.flushHeaders(); entered.resolve(res); }, () => {
    if (++lists === 2) bothListed.resolve();
    return { items: [{ name: `${id}.json`, generation: "1" }] };
  });
  const firstAbort = new AbortController();
  const first = f.source.list(undefined, firstAbort.signal);
  const failed = expect(first).rejects.toThrow("first waiter left");
  const response = await entered.promise;
  const second = f.source.list(undefined, signal());
  await bothListed.promise; await nextTurn();
  firstAbort.abort(new Error("first waiter left"));
  await failed;
  expect(response.destroyed).toBe(false);
  response.end(JSON.stringify(record()));
  const page = await second;
  expect(page.matches[0]!.id).toBe(id);
  expect(await f.source.list(undefined, signal())).toEqual(page);
  expect(f.objects).toHaveLength(1);
});

it("aborts the final waiter's read and permits immediate replacement without poisoning its cache", async () => {
  const entered = deferred<ServerResponse>(), closed = deferred<void>(), bothListed = deferred<void>(), replacement = deferred<ServerResponse>();
  let lists = 0, reads = 0;
  const f = await fixture((_req, res) => {
    res.writeHead(200); res.flushHeaders();
    if (++reads === 1) { res.once("close", () => closed.resolve()); entered.resolve(res); }
    else replacement.resolve(res);
  }, () => {
    if (++lists === 2) bothListed.resolve();
    return { items: [{ name: `${id}.json`, generation: "1" }] };
  });
  const one = new AbortController(), two = new AbortController();
  const first = f.source.list(undefined, one.signal), firstFailure = expect(first).rejects.toThrow();
  await entered.promise;
  const second = f.source.list(undefined, two.signal), secondFailure = expect(second).rejects.toThrow();
  await bothListed.promise; await nextTurn();
  one.abort(); two.abort();
  const fresh = f.source.list(undefined, signal()); // Before old stream/promise cleanup finishes.
  await Promise.all([firstFailure, secondFailure, closed.promise]);
  (await replacement.promise).end(JSON.stringify(record()));
  const page = await fresh;
  expect(await f.source.list(undefined, signal())).toEqual(page);
  expect(f.objects).toHaveLength(2);
});

/** Observe the native boundary without substituting the parser or its work. */
function nextParserWorker(): Promise<Worker> {
  const started = deferred<Worker>();
  const nativeOnce = Worker.prototype.once;
  const spy = vi.spyOn(Worker.prototype, "once").mockImplementation(function (this: Worker, ...args: Parameters<Worker["once"]>) {
    const result = nativeOnce.apply(this, args);
    if (args[0] === "exit") started.resolve(this);
    return result;
  });
  cleanup.push(async () => { spy.mockRestore(); });
  return started.promise;
}

it("keeps a shared parser running for another waiter after the first cancels", async () => {
  const started = nextParserWorker();
  const f = await fixture((_req, res) => res.end(JSON.stringify(record())), () => ({ items: [{ name: `${id}.json`, generation: "1" }] }));
  const abort = new AbortController();
  const first = f.source.list(undefined, abort.signal), failed = expect(first).rejects.toThrow();
  const second = f.source.list(undefined, signal());
  const worker = await started;
  abort.abort(); await failed;
  expect(worker.threadId).not.toBe(-1);
  expect((await second).matches[0]!.id).toBe(id);
  expect(f.objects).toHaveLength(1);
});

it("terminates an abandoned parser and never caches its late outcome over a replacement", async () => {
  const started = nextParserWorker();
  const f = await fixture((_req, res) => res.end(JSON.stringify(record())), () => ({ items: [{ name: `${id}.json`, generation: "1" }] }));
  const abort = new AbortController();
  const first = f.source.list(undefined, abort.signal), failed = expect(first).rejects.toThrow();
  const worker = await started, exited = once(worker, "exit");
  abort.abort();
  const fresh = f.source.list(undefined, signal());
  await Promise.all([failed, exited]);
  expect(worker.threadId).toBe(-1);
  const page = await fresh;
  expect(await f.source.list(undefined, signal())).toEqual(page);
  expect(f.objects).toHaveLength(2);
});

it("releases a crashed shared parser so a later client can retry", async () => {
  const started = nextParserWorker();
  const f = await fixture((_req, res) => res.end(JSON.stringify(record())), () => ({ items: [{ name: `${id}.json`, generation: "1" }] }));
  const results = Promise.allSettled([f.source.list(undefined, signal()), f.source.list(undefined, signal())]);
  await (await started).terminate();
  expect((await results).every(result => result.status === "rejected")).toBe(true);
  expect(f.objects).toHaveLength(1);
  expect((await f.source.list(undefined, signal())).matches[0]!.id).toBe(id);
  expect(f.objects).toHaveLength(2);
});

it("rejects an already canceled consumer even on a warm hit", async () => {
  const f = await fixture((_req, res) => res.end(JSON.stringify(record())), () => ({ items: [{ name: `${id}.json`, generation: "1" }] }));
  await f.source.list(undefined, signal());
  const canceled = AbortSignal.abort(new Error("already canceled")), calls = f.calls.length;
  await expect(f.source.list(undefined, canceled)).rejects.toThrow("already canceled");
  expect(f.calls).toHaveLength(calls);
  expect(f.objects).toHaveLength(1);
});

it.each(["missing", "provider", "malformed", "wrong identity", "stream"])("does not retain a failed %s read, and shares successful retry", async failure => {
  let fail = true;
  const f = await fixture((_req, res) => {
    if (!fail) { res.end(JSON.stringify(record())); return; }
    if (failure === "missing") res.writeHead(404).end();
    else if (failure === "provider") res.writeHead(403).end("provider-secret");
    else if (failure === "malformed") res.end("invalid-record-secret");
    else if (failure === "wrong identity") res.end(JSON.stringify(record(emptyId)));
    else { res.writeHead(200, { "content-length": "20000" }); res.flushHeaders(); res.write("{"); setImmediate(() => res.destroy()); }
  }, () => ({ items: [{ name: `${id}.json`, generation: "1" }] }));
  const failures = await Promise.allSettled([f.source.list(undefined, signal()), f.source.list(undefined, signal())]);
  // A record that cannot be summarised is left off its page; a provider or stream failure still fails the page.
  const recordLevel = ["missing", "malformed", "wrong identity"].includes(failure);
  expect(failures.every(result => recordLevel
    ? result.status === "fulfilled" && result.value.matches.length === 0 : result.status === "rejected")).toBe(true);
  expect(f.objects).toHaveLength(1);
  fail = false;
  const results = await Promise.all([f.source.list(undefined, signal()), f.source.list(undefined, signal())]);
  expect(results[0]).toEqual(results[1]);
  expect(f.objects).toHaveLength(2);
  expect(await f.source.list(undefined, signal())).toEqual(results[0]);
});

function validatedSummary(matchId = id): HistorySummary {
  return { id: matchId, startedAt: "2026-10-20T02:00:00.000Z", endedAt: null, simulationEndedAt: null,
    winner: null, reason: null, decidedBy: null, seats: [], status: "partial", unavailable: [] };
}

it("reuses complete warmed history beyond both former total-cache limits without expensive parser starts", async () => {
  let reads = 0;
  const value = { ...validatedSummary(), unavailable: Array.from({ length: 32 }, () => "😀".repeat(256)) };
  // Exercise the exact reuse boundary with an injected already-validated read.
  // Real I/O/parser wiring is covered separately; 320 workers would hide the
  // cardinality invariant behind a minute of unnecessary test startup CPU.
  const cache = createHistorySummaryCache(async matchId => { reads++; return { ...value, id: matchId }; });
  const ids = Array.from({ length: 320 }, (_, index) => `2026-10-20T00-00-00-000Z-${index + 1}`);
  expect(Buffer.byteLength(JSON.stringify(value)) * ids.length).toBeGreaterThan(4 * 1024 * 1024);
  for (let traversal = 0; traversal < 3; traversal++) {
    for (let offset = 0; offset < ids.length; offset += 20) {
      const page = cache.beginPage();
      for (const matchId of ids.slice(offset, offset + 20)) {
        const summary = await page(matchId, "1", "fixture-token", signal());
        expect(summary.id).toBe(matchId);
        expect(summary.unavailable).toEqual(value.unavailable);
      }
    }
    expect(reads).toBe(ids.length); // Not 640/960 on the repeated full traversals.
  }
});

it("retains only the observed current generation and never repopulates obsolete completed summaries", async () => {
  const old = deferred<HistorySummary>();
  const reads: (string | undefined)[] = [];
  const cache = createHistorySummaryCache(async (_id, _token, _signal, generation) => {
    reads.push(generation);
    return generation === "9" ? old.promise : { ...validatedSummary(), status: "complete" };
  });
  const olderPage = cache.beginPage();
  const pendingOld = olderPage(id, "9", "fixture-token", signal());
  const fresh = await cache.beginPage()(id, "2", "fixture-token", signal()); // Generations are opaque, not ordered numerically.
  old.resolve(validatedSummary());
  expect((await pendingOld).status).toBe("partial");
  expect(await cache.beginPage()(id, "2", "fixture-token", signal())).toEqual(fresh);
  expect(reads).toEqual(["9", "2"]);
  // Asking for the obsolete version again must load it, not find a second
  // retained generation hidden behind the current one.
  expect((await cache.beginPage()(id, "9", "fixture-token", signal())).status).toBe("partial");
  expect(reads).toEqual(["9", "2", "9"]);
});

it("does not let a late older discovery page roll back a newer observation", async () => {
  const reads: (string | undefined)[] = [];
  const cache = createHistorySummaryCache(async (_id, _token, _signal, generation) => {
    reads.push(generation);
    return { ...validatedSummary(), status: generation === "new" ? "complete" : "partial" };
  });
  const latePage = cache.beginPage();
  const current = await cache.beginPage()(id, "new", "fixture-token", signal());
  expect((await latePage(id, "old", "fixture-token", signal())).status).toBe("partial");
  expect(await cache.beginPage()(id, "new", "fixture-token", signal())).toEqual(current);
  expect(reads).toEqual(["new", "old"]);
});

/** Same fixture and real parser workers before/after; all transport stays on loopback. */
it("reports fixture-only cold, warm and concurrent history CPU/read counts", async () => {
  const bytes = new Map<string, Buffer>();
  const names: { name: string; generation: string }[] = [];
  for (let index = 0; index < 26; index++) {
    const matchId = `2026-10-20T00-00-00-000Z-${index + 1}`;
    const size = index === 24 ? 4_337_882 : index === 25 ? 1_541_999 : index === 0 ? 327 : 336;
    const value = { format: "antwar.match", version: 1, id: matchId, startedAt: "2026-10-20T00:00:00.000Z",
      endedAt: null, simulationEndedAt: null, result: null, seats: [], status: "unavailable", unavailable: [],
      events: Array.from({ length: index === 24 ? 46_777 : index === 25 ? 16_687 : 0 }, () => ({ kind: "fixture" })), padding: "" };
    const json = JSON.stringify(value);
    value.padding = " ".repeat(size - Buffer.byteLength(json));
    const buffer = Buffer.from(JSON.stringify(value));
    expect(buffer.length).toBe(size);
    bytes.set(`${matchId}.json`, buffer);
    names.push({ name: `${matchId}.bin`, generation: "1" }, { name: `${matchId}.json`, generation: "1" });
  }
  names.push(...["extra.bin", "other.bin", "archive/first", "archive/second"].map(name => ({ name, generation: "1" })));
  const makeFixture = () => fixture((req, res) => {
    const name = decodeURIComponent(new URL(req.url!, "http://localhost").pathname.split("/").at(-1)!);
    res.writeHead(200).end(bytes.get(name));
  }, token => {
    const offset = Number(token ?? 0);
    return { items: names.slice(offset, offset + 20), ...(offset + 20 < names.length ? { nextPageToken: String(offset + 20) } : {}) };
  });
  const sequential = await makeFixture();
  const concurrent = await makeFixture();
  const measure = async (label: string, f: Awaited<ReturnType<typeof fixture>>, viewers: number) => {
    const reads = f.objects.length, calls = f.calls.filter(call => !call.url.startsWith("http://metadata")).length;
    const delay = monitorEventLoopDelay({ resolution: 5 }); delay.enable();
    const cpu = process.cpuUsage(), start = performance.now();
    await Promise.all(Array.from({ length: viewers }, async () => {
      let token: string | undefined, found = 0;
      do {
        const page = await f.source.list(token, new AbortController().signal);
        found += page.matches.length;
        token = page.nextPageToken ?? undefined;
      } while (token !== undefined);
      expect(found).toBe(26);
    }));
    await new Promise(resolve => setTimeout(resolve, 25)); // Include parser teardown in aggregate CPU.
    const elapsed = process.cpuUsage(cpu);
    delay.disable();
    const media = f.objects.slice(reads);
    console.log("history-benchmark", JSON.stringify({ label, node: process.version, viewers,
      fixtureBytes: [...bytes.values()].reduce((sum, value) => sum + value.length, 0),
      mediaReads: media.length, listCalls: f.calls.filter(call => !call.url.startsWith("http://metadata")).length - calls,
      mediaBytes: media.reduce((sum, url) => sum + bytes.get(decodeURIComponent(new URL(url).pathname.split("/").at(-1)!))!.length, 0),
      wallSeconds: (performance.now() - start) / 1000, processCpuSeconds: (elapsed.user + elapsed.system) / 1e6,
      maxEventLoopDelayMs: delay.max / 1e6 }));
  };
  await measure("cold", sequential, 1);
  await measure("warm", sequential, 1);
  await measure("concurrent-cold", concurrent, 3);
}, 90_000);

it("refuses a non-progressing provider continuation instead of looping", async () => {
  const f = await fixture((_req, res) => res.end(), () => ({ nextPageToken: "same" }));
  await expect(f.source.list(undefined, new AbortController().signal)).rejects.toThrow("invalid match page continuation");
});

it.each(["time_up", "double_overrun", "queens_killed"])("preserves the kills criterion for %s in directory summaries", async reason => {
  const data = record();
  data.result = { ...data.result, reason, decidedBy: "kills" };
  const f = await fixture((_req, res) => res.writeHead(200).end(JSON.stringify(data)));
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches[0]).toMatchObject({ winner: 0, reason, decidedBy: "kills" });
});

it("pages newest first over all ascending metadata pages, with no skips or repeats after newer arrivals or a restart", async () => {
  // 41 records give public pages of 20/20/1. The minute-19 tie sorts -2, -10, -1, so it crosses the first page boundary.
  const ids = Array.from({ length: 39 }, (_, minute) => `2026-10-25T00-${String(minute).padStart(2, "0")}-00-000Z-1`);
  ids.push("2026-10-25T00-19-00-000Z-2", "2026-10-25T00-19-00-000Z-10");
  const original = [...ids].sort().reverse();
  expect(original.slice(19, 21)).toEqual(["2026-10-25T00-19-00-000Z-2", "2026-10-25T00-19-00-000Z-10"]);
  const names = () => [...ids.flatMap(id => [`${id}.bin`, `${id}.json`]), "ignore.json", "archive/other.json",
    `private/v1/${"a".repeat(64)}.sealed`, "2026-02-30T00-00-00-000Z-1.json"].sort();
  const f = await fixture((req, res) => {
    const matchId = decodeURIComponent(new URL(req.url!, "http://localhost").pathname.split("/").at(-1)!).slice(0, -5);
    res.end(JSON.stringify(record(matchId)));
  }, (token, url) => {
    // Storage applies matchGlob "*.json": "*" matches no "/", so only top-level saved records are listed.
    const end = url.searchParams.get("endOffset");
    const eligible = names().filter(name => !name.includes("/") && name.endsWith(".json") && (end === null || name < end));
    // An empty provider page is not the end. Deliberately return far fewer than maxResults.
    if (token === null) return { nextPageToken: "0" };
    const offset = Number(token);
    return { items: eligible.slice(offset, offset + 7).map(name => ({ name, generation: "1" })),
      ...(offset + 7 < eligible.length ? { nextPageToken: String(offset + 7) } : {}) };
  });
  const first = await f.source.list(undefined, signal());
  expect(first.matches.map(row => row.id)).toEqual(original.slice(0, 20));
  expect(f.objects).toHaveLength(20); // Metadata scan did not read older record bodies.
  expect(first.nextPageToken).toBe(`newest-v1:${original[19]}`);
  ids.push("2026-10-26T00-00-00-000Z-1");
  const afterRestart = createGcsHistorySource("fake-history", f.request, f.get);
  // The restarted process continues the old cursor while a new viewer refreshes; both legs run at once.
  const [[second, third], refreshed] = await Promise.all([
    (async () => {
      const second = await afterRestart.list(first.nextPageToken!, signal());
      return [second, await afterRestart.list(second.nextPageToken!, signal())] as const;
    })(),
    afterRestart.list(undefined, signal()),
  ]);
  expect(second.matches.map(row => row.id)).toEqual(original.slice(20, 40));
  expect(third.matches.map(row => row.id)).toEqual(original.slice(40));
  expect(third.nextPageToken).toBeNull();
  const all = [...first.matches, ...second.matches, ...third.matches].map(row => row.id);
  expect(all).toEqual(original);
  expect(new Set(all).size).toBe(original.length);
  expect(refreshed.matches.map(row => row.id)).toEqual([ids.at(-1), ...original.slice(0, 19)]);
  expect(f.objects).toHaveLength(61);
  const boundedCalls = f.calls.filter(call => new URL(call.url).searchParams.has("endOffset"));
  expect(boundedCalls.length).toBeGreaterThan(0);
  expect(boundedCalls.every(call => !new URL(call.url).searchParams.get("pageToken")?.startsWith("newest-v1:"))).toBe(true);
}, 30_000); // Real parser workers across three pages plus a cold post-restart refresh.

it.each(["old-provider-token", "newest-v1:../secret", "newest-v1:2026-02-30T00-00-00-000Z-1", "newest-v2:2026-10-25T00-00-00-000Z-1"])("rejects invalid or obsolete public cursor %s before any network", async cursor => {
  const request = vi.fn<typeof fetch>();
  await expect(createGcsHistorySource("fake", request).list(cursor, signal())).rejects.toThrow("invalid match page token");
  expect(request).not.toHaveBeenCalled();
});

it("rejects cycling provider continuations even across empty metadata pages", async () => {
  const f = await fixture((_req, res) => res.end(), token => ({ nextPageToken: token === "first" ? "second" : "first" }));
  await expect(f.source.list(undefined, signal())).rejects.toThrow("invalid match page continuation");
  expect(f.objects).toHaveLength(0);
});

it("cancels metadata traversal before starting a record read", async () => {
  const entered = deferred<void>();
  const abort = new AbortController();
  const request: typeof fetch = async (input, init) => {
    if (String(input).startsWith("http://metadata")) return Response.json({ access_token: "fake" });
    if (!new URL(String(input)).searchParams.has("pageToken")) return Response.json({ nextPageToken: "second" });
    entered.resolve();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  };
  const source = createGcsHistorySource("fake", request, () => { throw new Error("must not read records"); });
  const pending = source.list(undefined, abort.signal);
  const rejected = expect(pending).rejects.toThrow("reader left");
  await entered.promise;
  abort.abort(new Error("reader left"));
  await rejected;
});

const MiB = 1024 * 1024;
/** Streams a record past 64 MiB: its summary head, then about 70 MiB of events, then replies. Returns bytes produced. */
function serveOversized(res: ServerResponse, matchId: string, gzip: boolean): () => number {
  const { events: _events, ...head } = record(matchId);
  const entry = JSON.stringify({ tick: 1, event: { kind: "large-full-record-only", pad: "x".repeat(MiB) } });
  let produced = 0;
  async function* body() {
    yield `${JSON.stringify(head).slice(0, -1)},"events":[`;
    for (let i = 0; produced < 70 * MiB; i++) { const next = (i === 0 ? "" : ",") + entry; produced += next.length; yield next; }
    yield `],"replies":[{"seat":0,"reply":"large-full-record-only"}]}`;
  }
  res.on("error", () => {});
  if (gzip) res.writeHead(200, { "content-encoding": "gzip" });
  void (gzip ? pipeline(Readable.from(body()), createGzip(), res) : pipeline(Readable.from(body()), res)).catch(() => {});
  return () => produced;
}
const pathId = (req: IncomingMessage) => decodeURIComponent(new URL(req.url!, "http://localhost").pathname.split("/").at(-1)!).slice(0, -5);
const twoRecords = () => ({ items: [{ name: `${id}.json` }, { name: `${emptyId}.json` }] });

it.each([false, true])("lists a record over 64 MiB from its head alone beside a normal record (gzip %s)", async gzip => {
  let produced = () => 0;
  const f = await fixture((req, res) => {
    if (pathId(req) === id) produced = serveOversized(res, id, gzip);
    else res.end(JSON.stringify(record(emptyId)));
  }, twoRecords);
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches.map(match => match.id)).toEqual([id, emptyId]);
  expect(page.matches[0]).toMatchObject({ winner: 0, reason: "time_up", decidedBy: "territory", status: "partial",
    unavailable: ["Historical refusal reasons unavailable."] });
  expect(page.matches[0]!.seats).toHaveLength(8);
  expect(JSON.stringify(page)).not.toContain("large-full-record-only");
  // The read stops at events: the uncompressed record is never streamed to its end.
  if (!gzip) expect(produced()).toBeLessThan(64 * MiB);
}, 60_000);

it("leaves a record with no events key past 64 MiB off its page while the rest list", async () => {
  const f = await fixture((req, res) => {
    if (pathId(req) !== id) { res.end(JSON.stringify(record(emptyId))); return; }
    res.on("error", () => {});
    const { events: _events, ...head } = record(id);
    async function* body() {
      yield `${JSON.stringify(head).slice(0, -1)},"padding":"`;
      for (let i = 0; i < 65; i++) yield "x".repeat(MiB);
      yield `"}`;
    }
    void pipeline(Readable.from(body()), res).catch(() => {});
  }, twoRecords);
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches.map(match => match.id)).toEqual([emptyId]);
}, 60_000);

it("leaves an unsummarisable record off its page while every other record lists", async () => {
  // The newer listed name answers with the older record's identity, so it cannot be summarised.
  const f = await fixture((_req, res) => res.end(JSON.stringify(record(emptyId))), twoRecords);
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches.map(match => match.id)).toEqual([emptyId]);
});

it("cuts only at the top-level events key, never at a nested key, a string value or an escaped quote", async () => {
  const { events, ...head } = record();
  const value = { ...head, unavailable: ["events", '","events":[', "\\\"events"],
    seats: head.seats.map((seat, index) => index === 0 ? { ...seat, modelLabel: "events", events: [{ kind: "nested" }] } : seat),
    setup: { events: [1], rated: true, modelIndex: true }, events };
  const f = await fixture((_req, res) => res.end(JSON.stringify(value)));
  const listed = (await f.source.list(undefined, new AbortController().signal)).matches[0]!;
  expect(listed.unavailable).toEqual(value.unavailable);
  expect(listed.seats[0]!.modelLabel).toBe("events");
  expect({ rated: listed.rated, modelIndex: listed.modelIndex }).toEqual({ rated: true, modelIndex: true });
  expect(listed.seats).toHaveLength(8);
});

/** The decoded offsets at which the received body chunks end: each received prefix decoded alone (gzip to its last flush). */
function decodedBoundaries(chunks: Buffer[], gzip: boolean): number[] {
  return chunks.map((_, index) => {
    const prefix = Buffer.concat(chunks.slice(0, index + 1));
    return gzip ? gunzipSync(prefix, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).length : prefix.length;
  });
}

const splitPoints = [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap(split => [{ split, gzip: false }, { split, gzip: true }]);
it.each(splitPoints)("lists a record whose top-level events key is split across two stream chunks (split $split, gzip $gzip)", async ({ split, gzip }) => {
  const { events: _events, ...head } = record();
  const before = `${JSON.stringify(head).slice(0, -1)},`, key = `"events"`;
  // After the key the record is invalid: a read that missed the split key would parse it whole and leave it off.
  const after = `:[{"kind":"large-full-record-only"}],"replies":[`;
  const f = await fixture((_req, res) => {
    res.on("error", () => {});
    if (!gzip) { res.write(before + key.slice(0, split)); setTimeout(() => res.end(key.slice(split) + after), 20); return; }
    // Flush the first part so the decoded stream yields it as its own chunk before the rest arrives.
    res.writeHead(200, { "content-encoding": "gzip" });
    const zip = createGzip();
    zip.pipe(res);
    zip.write(before + key.slice(0, split));
    zip.flush(() => setTimeout(() => zip.end(key.slice(split) + after), 20));
  });
  const page = await f.source.list(undefined, new AbortController().signal);
  // The stream did split where the test says: a received chunk ends exactly split bytes into the key, so for splits 1-7
  // the boundary lies inside "events". A delivery of the key in one chunk leaves no boundary there and fails this.
  expect(f.received).toHaveLength(1);
  expect(decodedBoundaries(f.received[0]!, gzip)).toContain(before.length + split);
  expect(page.matches.map(match => match.id)).toEqual([id]);
  expect(page.matches[0]).toMatchObject({ winner: 0, reason: "time_up", decidedBy: "territory", status: "partial",
    unavailable: ["Historical refusal reasons unavailable."] });
  expect(page.matches[0]!.seats).toHaveLength(8);
});

it("logs one info line per record left off a page, naming its id and reason and never its bytes", async () => {
  const marker = "record-bytes-marker";
  const logged = (["info", "log", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
  cleanup.push(async () => { for (const spy of logged) spy.mockRestore(); });
  const f = await fixture((req, res) => {
    if (pathId(req) === id) res.end(`{"format":"antwar.match","version":1,"id":"${id}","seats":[{"modelLabel":"${marker}"`);
    else res.end(JSON.stringify(record(emptyId)));
  }, twoRecords);
  const page = await f.source.list(undefined, new AbortController().signal);
  expect(page.matches.map(match => match.id)).toEqual([emptyId]);
  expect(logged[0]!.mock.calls).toEqual([[`antwar history record ${id} left off listing page: Invalid match record.`]]);
  for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
});
