import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gcsRecordingObjects } from "../../src/replays/abandonRecording.ts";
import { ReplayCreateError, type ReplayGet } from "../../src/store/gcs.ts";

// The bucket client the correction uses for its recording reads and generation-conditioned uploads, against a fake
// metadata server, a fake JSON/upload API (fetch) and a fake raw media transport (get). No network is used.

interface JsonCall { readonly url: URL; readonly method: string; readonly headers: Record<string, string>; readonly body?: Uint8Array }
interface MediaCall { readonly url: URL; readonly headers: Record<string, string> }
type JsonReply = (call: JsonCall) => Response;
interface MediaReply { readonly status: number; readonly body?: Uint8Array }

class FakeRequest extends EventEmitter {
  setTimeout() { return this; }
  destroy(error?: Error) { if (error) this.emit("error", error); this.emit("close"); return this; }
}

function fakeBucket(json: JsonReply, media: (call: MediaCall) => MediaReply = () => ({ status: 500 })) {
  const jsonCalls: JsonCall[] = [], mediaCalls: MediaCall[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake-token", expires_in: 3600 });
    const body = init?.body === undefined || init.body === null ? undefined : new Uint8Array(init.body as Buffer);
    const call: JsonCall = { url, method: init?.method ?? "GET", headers: { ...init?.headers as Record<string, string> }, ...body ? { body } : {} };
    jsonCalls.push(call);
    return json(call);
  }) as typeof fetch;
  const get: ReplayGet = (url, options, response) => {
    const call: MediaCall = { url, headers: { ...options.headers as Record<string, string> } };
    mediaCalls.push(call);
    const reply = media(call);
    const res = Readable.from(reply.body === undefined ? [] : [Buffer.from(reply.body)]) as unknown as IncomingMessage;
    res.statusCode = reply.status;
    setImmediate(() => response(res));
    return new FakeRequest() as unknown as ClientRequest;
  };
  return { objects: gcsRecordingObjects("replay-bucket", request, get), jsonCalls, mediaCalls };
}

const OBJECT = "2026-11-09T13-26-59-840Z-160375822867893.json";
const metadataReply = (value: object): JsonReply => () => Response.json(value);

describe("recording object reads", () => {
  it("reads the stored bytes at exactly the generation its metadata reported, without transcoding", async () => {
    const stored = gzipSync(Buffer.from("{\"format\":\"antwar.match\"}\n"));
    const { objects, jsonCalls, mediaCalls } = fakeBucket(
      metadataReply({ generation: "1762695000000001", contentType: "application/json", contentEncoding: "gzip" }),
      () => ({ status: 200, body: stored }));
    const read = await objects.read(OBJECT);
    expect(read).toEqual({ generation: "1762695000000001", contentType: "application/json", contentEncoding: "gzip", body: new Uint8Array(stored) });
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]!.url.pathname).toBe(`/storage/v1/b/replay-bucket/o/${encodeURIComponent(OBJECT)}`);
    expect(jsonCalls[0]!.url.searchParams.get("fields")).toBe("generation,contentType,contentEncoding");
    expect(jsonCalls[0]!.headers.authorization).toBe("Bearer fake-token");
    expect(mediaCalls).toHaveLength(1);
    expect(mediaCalls[0]!.url.searchParams.get("alt")).toBe("media");
    expect(mediaCalls[0]!.url.searchParams.get("generation")).toBe("1762695000000001");
    expect(mediaCalls[0]!.headers["accept-encoding"]).toBe("gzip");
    expect(mediaCalls[0]!.headers.authorization).toBe("Bearer fake-token");
  });

  it("reads an object stored without a content encoding", async () => {
    const { objects } = fakeBucket(metadataReply({ generation: "7", contentType: "application/octet-stream" }),
      () => ({ status: 200, body: new Uint8Array([1, 2, 3]) }));
    expect(await objects.read(OBJECT)).toEqual({ generation: "7", contentType: "application/octet-stream", body: new Uint8Array([1, 2, 3]) });
  });

  it("reports an absent object as null and makes no media read", async () => {
    const { objects, mediaCalls } = fakeBucket(() => new Response(null, { status: 404 }));
    expect(await objects.read(OBJECT)).toBeNull();
    expect(mediaCalls).toHaveLength(0);
  });

  it("refuses when the verified generation is gone by the time its bytes are read", async () => {
    const { objects } = fakeBucket(metadataReply({ generation: "7", contentType: "application/json" }), () => ({ status: 404 }));
    await expect(objects.read(OBJECT)).rejects.toThrow(`object ${OBJECT} vanished during read`);
  });

  it("refuses a failed media read", async () => {
    const { objects } = fakeBucket(metadataReply({ generation: "7", contentType: "application/json" }), () => ({ status: 403 }));
    await expect(objects.read(OBJECT)).rejects.toThrow("recording read failed");
  });

  it("refuses a failed metadata read", async () => {
    const { objects, mediaCalls } = fakeBucket(() => new Response("denied", { status: 500 }));
    await expect(objects.read(OBJECT)).rejects.toThrow("object metadata read failed: HTTP 500");
    expect(mediaCalls).toHaveLength(0);
  });

  it.each([
    ["a missing generation", { contentType: "application/json" }],
    ["a numeric generation", { generation: 7, contentType: "application/json" }],
    ["generation 0", { generation: "0", contentType: "application/json" }],
    ["a non-decimal generation", { generation: "7a", contentType: "application/json" }],
    ["a missing content type", { generation: "7" }],
  ])("refuses metadata with %s", async (_label, value) => {
    const { objects, mediaCalls } = fakeBucket(metadataReply(value));
    await expect(objects.read(OBJECT)).rejects.toThrow("object metadata is invalid");
    expect(mediaCalls).toHaveLength(0);
  });

  it("refuses a content encoding other than gzip", async () => {
    const { objects } = fakeBucket(metadataReply({ generation: "7", contentType: "application/json", contentEncoding: "br" }));
    await expect(objects.read(OBJECT)).rejects.toThrow("unsupported content encoding br");
  });
});

describe("recording object generations", () => {
  it("returns the current generation from metadata alone", async () => {
    const { objects, mediaCalls } = fakeBucket(metadataReply({ generation: "42", contentType: "application/json" }));
    expect(await objects.generation(OBJECT)).toBe("42");
    expect(mediaCalls).toHaveLength(0);
  });

  it("returns null for an absent object", async () => {
    const { objects } = fakeBucket(() => new Response(null, { status: 404 }));
    expect(await objects.generation(OBJECT)).toBeNull();
  });

  it("refuses a failed or invalid metadata read", async () => {
    await expect(fakeBucket(() => new Response(null, { status: 503 })).objects.generation(OBJECT)).rejects.toThrow("HTTP 503");
    await expect(fakeBucket(metadataReply({ generation: "0", contentType: "x" })).objects.generation(OBJECT)).rejects.toThrow("object metadata is invalid");
  });
});

describe("generation-conditioned recording replacement", () => {
  const replacement = { contentType: "application/json", contentEncoding: "gzip" as const, body: gzipSync(Buffer.from("{}\n")) };

  it("uploads only on the verified generation, keeps the encoding as object metadata, and returns the new generation", async () => {
    const { objects, jsonCalls } = fakeBucket(() => Response.json({ generation: "1762695000000002" }));
    expect(await objects.replace(OBJECT, replacement, "1762695000000001")).toBe("1762695000000002");
    expect(jsonCalls).toHaveLength(1);
    const call = jsonCalls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/upload/storage/v1/b/replay-bucket/o");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      uploadType: "media", name: OBJECT, ifGenerationMatch: "1762695000000001", contentEncoding: "gzip" });
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["content-encoding"]).toBeUndefined();
    expect(call.headers.authorization).toBe("Bearer fake-token");
    expect(call.body).toEqual(new Uint8Array(replacement.body));
  });

  it("sends no content encoding for an object stored without one", async () => {
    const { objects, jsonCalls } = fakeBucket(() => Response.json({ generation: "8" }));
    await objects.replace(OBJECT, { contentType: "application/octet-stream", body: new Uint8Array([1]) }, "7");
    expect(jsonCalls[0]!.url.searchParams.has("contentEncoding")).toBe(false);
    expect(jsonCalls[0]!.url.searchParams.get("ifGenerationMatch")).toBe("7");
  });

  it("refuses when the object changed since it was verified (precondition failed)", async () => {
    const { objects } = fakeBucket(() => new Response("conditionNotMet", { status: 412 }));
    await expect(objects.replace(OBJECT, replacement, "7")).rejects.toThrow(`object ${OBJECT} changed since it was verified; nothing replaced`);
  });

  it("reports any other refused upload with its status", async () => {
    const { objects } = fakeBucket(() => new Response(null, { status: 503 }));
    const failure = await objects.replace(OBJECT, replacement, "7").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReplayCreateError);
    expect((failure as ReplayCreateError).status).toBe(503);
  });

  it.each(["0", "", "7a", "-1", "1.5"])("refuses generation %j before any request", async generation => {
    const { objects, jsonCalls } = fakeBucket(() => Response.json({ generation: "8" }));
    await expect(objects.replace(OBJECT, replacement, generation)).rejects.toThrow("invalid generation");
    expect(jsonCalls).toHaveLength(0);
  });

  it.each([
    ["no generation", {}],
    ["a numeric generation", { generation: 8 }],
    ["an invalid generation", { generation: "0" }],
  ])("reports an accepted upload whose reply carries %s as replaced with an unknown generation", async (_label, value) => {
    const { objects } = fakeBucket(() => Response.json(value));
    await expect(objects.replace(OBJECT, replacement, "7")).rejects.toThrow(`object ${OBJECT} replaced but its new generation is unknown`);
  });
});
