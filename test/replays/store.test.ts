import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createGcsReplayStore, replayStoreFromEnv, type ReplayObject } from "../../src/replays/store.ts";

const object: ReplayObject = {
  name: "2026-10-18T09-50-00-000Z-1.bin", body: new Uint8Array(gzipSync("a fake packed replay body")),
  contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0,
};

function fake(status = 200, token: unknown = { access_token: "fake-token-never-a-credential" }) {
  const calls: { url: string; init: RequestInit | undefined; bytes?: Uint8Array; chunks?: Uint8Array[] }[] = [];
  const stored = new Map<string, { bytes: Uint8Array; contentEncoding: string | null }>();
  const request: typeof fetch = async (input, init) => {
    const call = { url: String(input), init, bytes: undefined as Uint8Array | undefined, chunks: undefined as Uint8Array[] | undefined };
    calls.push(call);
    if (calls.length % 2 === 1) return Response.json(token);
    const stream = init!.body as ReadableStream<Uint8Array>;
    call.chunks = [];
    for await (const chunk of stream) call.chunks.push(chunk);
    call.bytes = new Uint8Array(Buffer.concat(call.chunks));
    if (status === 200) {
      // Model GCS's upload behaviour: transport encoding is decoded on receipt,
      // independently of the contentEncoding metadata on the stored object.
      const url = new URL(call.url);
      stored.set(url.searchParams.get("name")!, {
        bytes: new Headers(init?.headers).get("content-encoding") === "gzip" ? gunzipSync(call.bytes) : call.bytes,
        contentEncoding: url.searchParams.get("contentEncoding"),
      });
    }
    return new Response("{}", { status });
  };
  return { calls, request, read: (name: string) => stored.get(name) };
}

describe("create-only replay store", () => {
  it("does nothing with no bucket, including no token request", () => {
    const { calls, request } = fake();
    expect(replayStoreFromEnv({}, request)).toBeUndefined();
    expect(replayStoreFromEnv({ ANTWAR_REPLAY_BUCKET: "" }, request)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("uses a Cloud Run metadata token and GCS generation-zero media upload with gzip metadata", async () => {
    const { calls, request } = fake();
    const store = replayStoreFromEnv({ ANTWAR_REPLAY_BUCKET: "fake-replay-bucket" }, request)!;
    expect(calls).toEqual([]);
    await store.create(object);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(calls[0]!.init?.headers).toEqual({ "Metadata-Flavor": "Google" });
    const upload = calls[1]!, url = new URL(upload.url);
    expect(url.origin + url.pathname).toBe("https://storage.googleapis.com/upload/storage/v1/b/fake-replay-bucket/o");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      uploadType: "media", name: object.name, ifGenerationMatch: "0", contentEncoding: "gzip",
    });
    expect(upload.init?.method).toBe("POST");
    expect(upload.init?.body).toBeInstanceOf(ReadableStream);
    expect(upload.init).toMatchObject({ duplex: "half" });
    expect(upload.bytes).toEqual(object.body);
    expect(upload.init?.headers).toEqual({
      authorization: "Bearer fake-token-never-a-credential", "content-type": "application/octet-stream",
      "content-length": String(object.body.byteLength),
    });
    expect(calls.every((c) => c.init?.signal instanceof AbortSignal && c.init.redirect === "error")).toBe(true);
  });

  it("stores genuine gzip against a bucket that decodes transport encoding before storing", async () => {
    const f = fake();
    // Prove the fake reproduces the old defect, not merely a byte echo.
    await f.request("http://metadata.google.internal/");
    await f.request(`https://storage.googleapis.com/upload?name=legacy.bin&contentEncoding=gzip`, {
      headers: { "content-encoding": "gzip" },
      body: new ReadableStream({ start(controller) { controller.enqueue(object.body); controller.close(); } }),
    });
    const legacy = f.read("legacy.bin")!;
    expect(legacy.contentEncoding).toBe("gzip");
    expect(Buffer.from(legacy.bytes)).toEqual(gunzipSync(object.body));
    await createGcsReplayStore("fake-bucket", f.request).create(object);
    const saved = f.read(object.name)!;
    expect(saved.contentEncoding).toBe("gzip");
    expect(Array.from(saved.bytes.subarray(0, 2))).toEqual([0x1f, 0x8b]);
    expect(Buffer.from(saved.bytes)).toEqual(Buffer.from(object.body));
    expect(gunzipSync(saved.bytes)).toEqual(gunzipSync(object.body));
  });

  it("streams bounded views without a whole-body copy and preserves bytes through native fetch backpressure", async () => {
    const body = Uint8Array.from({ length: 3 * 64 * 1024 + 17 }, (_, i) => i % 251);
    const { calls, request } = fake();
    await createGcsReplayStore("fake-bucket", request).create({ ...object, body });
    const upload = calls[1]!;
    expect(Buffer.compare(Buffer.from(upload.bytes!), Buffer.from(body))).toBe(0);
    expect(upload.chunks!.map((chunk) => chunk.length)).toEqual([65536, 65536, 65536, 17]);
    expect(upload.chunks!.every((chunk) => chunk.buffer === body.buffer)).toBe(true);

    // Native fetch must accept the streamed BodyInit/duplex pair and send the
    // declared length, not buffer or serialize the ReadableStream as an object.
    const received: Buffer[] = [];
    let contentLength: string | undefined, contentEncoding: string | undefined;
    const server = createServer(async (req, res) => {
      contentLength = req.headers["content-length"];
      contentEncoding = req.headers["content-encoding"];
      for await (const chunk of req) {
        received.push(chunk as Buffer);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const localRequest: typeof fetch = async (url, init) => String(url).startsWith("http://metadata.google.internal/")
        ? Response.json({ access_token: "scripted-test-token" })
        : fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`, init);
      await createGcsReplayStore("fake-bucket", localRequest).create({ ...object, body });
      expect(contentLength).toBe(String(body.length));
      expect(contentEncoding).toBeUndefined();
      expect(Buffer.compare(Buffer.concat(received), Buffer.from(body))).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not retry a collision or overwrite the old object", async () => {
    const { calls, request } = fake(412);
    await expect(createGcsReplayStore("fake-bucket", request).create(object)).rejects.toThrow("HTTP 412");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("ifGenerationMatch")).toBe("0");
  });

  it.each([{}, null, { access_token: 123 }, { access_token: "" }])("rejects a malformed identity response without uploading: %j", async (token) => {
    const { calls, request } = fake(200, token);
    await expect(createGcsReplayStore("fake-bucket", request).create(object)).rejects.toThrow("no access token");
    expect(calls).toHaveLength(1);
  });

  it("reuses one metadata token across creates within its lifetime", async () => {
    let tokenRequests = 0;
    const request: typeof fetch = async (input) => {
      if (String(input).startsWith("http://metadata.google.internal/")) {
        tokenRequests++;
        return Response.json({ access_token: "fake-token-never-a-credential", expires_in: 3599 });
      }
      return new Response("{}");
    };
    const store = createGcsReplayStore("fake-bucket", request);
    for (const name of ["a.bin", "b.bin", "c.bin"]) await store.create({ ...object, name });
    expect(tokenRequests).toBe(1);
  });

  it("does not upload after a metadata error or leak provider response bodies", async () => {
    let count = 0;
    const request: typeof fetch = async () => { count++; return new Response("do-not-log-this", { status: 403 }); };
    await expect(createGcsReplayStore("fake-bucket", request).create(object)).rejects.toThrow("replay identity request failed: HTTP 403");
    expect(count).toBe(1);
    const f = fake(500);
    await expect(createGcsReplayStore("fake-bucket", f.request).create(object)).rejects.toThrow("replay create failed: HTTP 500");
    expect(f.calls).toHaveLength(2);
  });
});

it("uploads JSON as plain UTF-8, without gzip metadata or transport encoding", async () => {
  const f = fake();
  const body = new TextEncoder().encode('{"format":"antwar.match","version":1}\n');
  await createGcsReplayStore("fake-bucket", f.request).create({ name: "fixture.json", body, contentType: "application/json", ifGenerationMatch: 0 });
  const upload = f.calls[1]!;
  expect(new URL(upload.url).searchParams.has("contentEncoding")).toBe(false);
  expect(new Headers(upload.init!.headers).get("content-type")).toBe("application/json");
  expect(new Headers(upload.init!.headers).has("content-encoding")).toBe(false);
  expect(f.read("fixture.json")!.bytes).toEqual(body);
});
