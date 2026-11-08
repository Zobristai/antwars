import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { createGcsRecordStore } from "../../src/records/record-store.ts";
import { createGcsRecordReplayStore } from "../../src/records/replay-store.ts";
import { unavailableRecord } from "../../src/replays/history.ts";
import { privateMediaName } from "../../src/replays/private-media.ts";
import type { ReplayGet } from "../../src/replays/access.ts";
import type { ReplayObject } from "../../src/replays/store.ts";

/**
 * The record service's two replay-bucket handles share one bucket client with the input store, which may delete.
 * Through that shared client they still never delete, and never overwrite a binary: only record-store writes at a
 * non-zero generation, and only the generation its own metadata read returned, for a record.
 */
const ID = "2026-10-21T10-00-00-000Z-243", LOBBY = "lobby-7", KEY = new Uint8Array(32).fill(7);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const unavailable = () => json(unavailableRecord(ID, "old verifier failed"));
const partial = () => json({ ...unavailableRecord(ID, ""), status: "partial", source: "binary", unavailable: [] });
const complete = () => json({ ...unavailableRecord(ID, ""), status: "complete", source: "match-log", unavailable: [] });
const checkpoint = new Uint8Array(gzipSync(new Uint8Array([1, 2, 3])));

// @ts-expect-error A replay object is create-only: its generation precondition can only be zero.
const _replace: ReplayObject = { name: `${ID}.bin`, body: checkpoint, contentType: "application/octet-stream", ifGenerationMatch: 1 };

/** One replay bucket with GCS generation preconditions; every provider call is logged in order. */
function replayBucket() {
  let next = 0;
  const objects = new Map<string, { body: Uint8Array; generation: string }>();
  const calls: { method: string; name: string; generation: string | null; precondition: string | null; returned?: string }[] = [];
  const nameOf = (url: URL) => url.pathname.startsWith("/upload/") ? url.searchParams.get("name")! : decodeURIComponent(url.pathname.split("/o/")[1]!);
  let beforeUpload: (() => void) | undefined;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake" });
    const name = nameOf(url), object = objects.get(name);
    const call: (typeof calls)[number] = { method, name, generation: url.searchParams.get("generation"), precondition: url.searchParams.get("ifGenerationMatch") };
    calls.push(call);
    if (method === "POST") {
      beforeUpload?.(); beforeUpload = undefined;
      const body = new Uint8Array(await new Response(init!.body).arrayBuffer());
      if (call.precondition !== (objects.get(name)?.generation ?? "0")) return new Response(null, { status: 412 });
      objects.set(name, { body, generation: String(++next) });
      return new Response(null, { status: 200 });
    }
    if (method !== "GET") return new Response(null, { status: 405 });
    if (object === undefined || (call.generation !== null && call.generation !== object.generation)) return new Response(null, { status: 404 });
    if (url.searchParams.get("alt") === "media") return new Response(Buffer.from(object.body));
    call.returned = object.generation;
    return Response.json({ generation: object.generation });
  };
  const get: ReplayGet = (url, _options, respond) => {
    const name = nameOf(url), object = objects.get(name);
    calls.push({ method: "GET", name, generation: url.searchParams.get("generation"), precondition: null });
    const req = Object.assign(new EventEmitter(), { setTimeout: () => req, destroy: () => req }) as unknown as ClientRequest;
    setImmediate(() => {
      const body = Object.assign(Readable.from(object === undefined ? [] : [Buffer.from(object.body)]), { statusCode: object === undefined ? 404 : 200, headers: {} });
      respond(body as never);
    });
    return req;
  };
  const write = (name: string, body: Uint8Array) => objects.set(name, { body, generation: String(++next) });
  return { objects, calls, request, get, write, raceNextUpload: (fn: () => void) => { beforeUpload = fn; } };
}

it("never deletes and never writes a binary at a non-zero generation through the record service's replay handles", async () => {
  const gcs = replayBucket();
  const records = createGcsRecordStore("replays", KEY, gcs.request);
  const replays = createGcsRecordReplayStore("replays", KEY, gcs.request, gcs.get);
  const sealedRecord = privateMediaName({ lobbyId: LOBBY, replayId: ID, kind: "match-record" });
  const sealedBinary = privateMediaName({ lobbyId: LOBBY, replayId: ID, kind: "recording" });

  // Records: create, replace an unavailable record, preserve a partial one, re-read a race winner.
  expect(await records.forMatch(ID, null)!.save(unavailable())).toEqual({ complete: false, outcome: "record created" });
  expect(await records.forMatch(ID, null)!.save(complete())).toEqual({ complete: true, outcome: "unavailable record replaced" });
  gcs.write(`${ID}.json`, partial());
  expect(await records.forMatch(ID, null)!.save(unavailable())).toEqual({ complete: false, outcome: "existing record preserved" });
  gcs.write(`${ID}.json`, unavailable());
  gcs.raceNextUpload(() => gcs.write(`${ID}.json`, complete()));
  expect((await records.forMatch(ID, null)!.save(complete())).complete).toBe(true);
  expect(await records.forMatch(ID, LOBBY)!.save(unavailable())).toEqual({ complete: false, outcome: "record created" });
  expect(await records.forMatch(ID, LOBBY)!.save(complete())).toEqual({ complete: true, outcome: "unavailable record replaced" });

  // Replays: no create before fallback, a create-only checkpoint, an existing binary left alone, a collision re-read.
  expect(await replays.forMatch(ID, null)!.resolve(checkpoint, false)).toBeNull();
  expect(await replays.forMatch(ID, null)!.resolve(checkpoint, true)).toEqual(checkpoint);
  expect(await replays.forMatch(ID, null)!.resolve(new Uint8Array(gzipSync(new Uint8Array([4]))), true)).toEqual(checkpoint);
  const other = "2026-10-21T10-00-00-000Z-244";
  gcs.raceNextUpload(() => gcs.write(`${other}.bin`, new Uint8Array([9])));
  expect(await replays.forMatch(other, null)!.resolve(checkpoint, true)).toEqual(new Uint8Array([9]));
  expect(await replays.forMatch(ID, LOBBY)!.resolve(checkpoint, true)).toEqual(checkpoint);

  expect(gcs.calls.filter(call => call.method !== "GET" && call.method !== "POST")).toEqual([]);
  const posts = gcs.calls.filter(call => call.method === "POST");
  expect(posts.length).toBeGreaterThan(0);
  for (const [index, post] of gcs.calls.entries()) {
    if (post.method !== "POST" || post.precondition === "0") continue;
    // A replacement names a record, at a generation an earlier metadata read of that record returned.
    expect([`${ID}.json`, sealedRecord]).toContain(post.name);
    expect(gcs.calls.slice(0, index).some(call => call.name === post.name && call.returned === post.precondition)).toBe(true);
  }
  expect(posts.filter(post => [`${ID}.bin`, `${other}.bin`, sealedBinary].includes(post.name)).map(post => post.precondition)).toEqual(["0", "0", "0"]);
});
