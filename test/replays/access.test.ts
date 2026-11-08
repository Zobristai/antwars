import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createGcsReplaySource, isReplayId, replaySourceFromEnv, type ReplayGet } from "../../src/replays/access.ts";

const id = "2026-10-18T09-50-00-123Z-42";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const urls: string[] = [];
  const get: ReplayGet = (url, options, response) => {
    urls.push(url.href);
    return httpGet(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options, response);
  };
  let tokenCalls = 0;
  const token: typeof fetch = async (url, options) => {
    tokenCalls++;
    expect(String(url)).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(options!.headers).toEqual({ "Metadata-Flavor": "Google" });
    return Response.json({ access_token: "fake-token" });
  };
  return { get, urls, token, tokenCalls: () => tokenCalls };
}

it.each([
  { shape: "genuine gzip", bytes: gzipSync("a fake packed replay body"), encoding: "gzip" },
  { shape: "legacy raw bytes labelled gzip", bytes: Buffer.from("a fake packed replay body"), encoding: "gzip" },
  { shape: "raw bytes without encoding metadata", bytes: Buffer.from("a fake packed replay body"), encoding: undefined },
])("reads stored $shape untranscoded with the exact validated object path", async ({ bytes, encoding }) => {
  const f = await fixture((req, res) => {
    expect(req.headers.authorization).toBe("Bearer fake-token");
    expect(req.headers["accept-encoding"]).toBe("gzip");
    // Model GCS read transcoding when Accept-Encoding is absent: the source
    // must explicitly request stored bytes before the route can sniff them.
    const served = encoding === "gzip" && req.headers["accept-encoding"] !== "gzip" ? gunzipSync(bytes) : bytes;
    res.writeHead(200, { "content-type": "application/octet-stream", ...(encoding ? { "content-encoding": encoding } : {}), "content-length": served.length });
    res.end(served);
  });
  const source = createGcsReplaySource("fake-bucket", f.token, f.get);
  expect(f.urls).toHaveLength(0);
  const object = await source.open(id, new AbortController().signal);
  expect(object!.contentLength).toBe(String(bytes.length));
  const parts: Buffer[] = [];
  for await (const part of object!.body) parts.push(Buffer.from(part));
  expect(Buffer.concat(parts)).toEqual(bytes);
  expect(f.urls).toEqual([`https://storage.googleapis.com/storage/v1/b/fake-bucket/o/${id}.bin?alt=media`]);
  expect(f.tokenCalls()).toBe(1);
});

it("hands the first chunk to the caller before the rest of the object exists", async () => {
  let finish: (() => void) | undefined;
  const first = gzipSync("first member"), last = gzipSync("last member");
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.write(first);
    finish = () => res.end(last);
  });
  const object = (await createGcsReplaySource("fake-bucket", f.token, f.get).open(id, new AbortController().signal))!;
  const iterator = object.body[Symbol.asyncIterator]();
  const start = await iterator.next();
  expect(Buffer.from(start.value as Uint8Array)).toEqual(first);
  finish!();
  const parts: Buffer[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) parts.push(Buffer.from(next.value as Uint8Array));
  expect(Buffer.concat(parts)).toEqual(last);
});

it("distinguishes missing objects and bucket errors without consuming their bodies", async () => {
  const missing = await fixture((_req, res) => res.writeHead(404).end("private provider body"));
  expect(await createGcsReplaySource("fake-bucket", missing.token, missing.get).open(id, new AbortController().signal)).toBeNull();
  const failed = await fixture((_req, res) => res.writeHead(403).end("do-not-echo-provider-secret"));
  await expect(createGcsReplaySource("fake-bucket", failed.token, failed.get).open(id, new AbortController().signal)).rejects.toThrow("replay bucket read failed");
});

it("aborting a download closes the upstream request and stream", async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const f = await fixture((_req, res) => {
    res.once("close", upstreamClosed);
    res.writeHead(200, { "content-encoding": "gzip" }); res.write(gzipSync("first"));
  });
  const abort = new AbortController();
  const object = (await createGcsReplaySource("fake-bucket", f.token, f.get).open(id, abort.signal))!;
  abort.abort();
  await closed;
  expect(object.body.destroyed).toBe(true);
});

const invalid = ["", "agents.bin", "../secret", `${id}/other`, `${id}.bin`, `${id}%2Fother`, `${id}%00`,
  "2026-10-18T09-50-00-123Z-0", "2026-10-18T09-50-00-123Z-01", "2026-10-18T09-50-00-123Z--1",
  "2026-02-30T09-50-00-123Z-1", "2026-10-18T24-00-00-000Z-1", "2026-10-18T09-50-60-000Z-1",
  "2026-10-18T09-50-00-123Z-9007199254740992", `${id}?object=other`];
it.each(invalid)("rejects an invalid id before identity or object access: %s", async (bad) => {
  let calls = 0;
  const token: typeof fetch = async () => { calls++; throw new Error("unexpected token request"); };
  expect(isReplayId(bad)).toBe(false);
  await expect(createGcsReplaySource("fake-bucket", token).open(bad, new AbortController().signal)).rejects.toThrow("invalid replay id");
  expect(calls).toBe(0);
});
it("allows exact leap dates and positive safe sequence numbers", () => {
  expect(isReplayId("2024-02-29T00-00-00-000Z-9007199254740991")).toBe(true);
  expect(isReplayId("2026-02-29T00-00-00-000Z-1")).toBe(false);
});
it("constructs no source or identity calls with the bucket unset", () => {
  let calls = 0;
  const token: typeof fetch = async () => { calls++; throw new Error("unexpected cloud call"); };
  expect(replaySourceFromEnv({}, token)).toBeUndefined();
  expect(replaySourceFromEnv({ ANTWAR_REPLAY_BUCKET: "" }, token)).toBeUndefined();
  expect(replaySourceFromEnv({ ANTWAR_REPLAY_BUCKET: "fake-bucket" }, token)).toBeDefined();
  expect(calls).toBe(0);
});
