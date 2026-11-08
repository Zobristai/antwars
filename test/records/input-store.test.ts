import { createServer, get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGcsInputStore, markerName, parseInputObjectName, parseRunningBuildName, runningBuildName } from "../../src/records/input-store.js";
import type { ReplayGet } from "../../src/replays/access.js";

const ID = "2026-10-21T10-00-00-000Z-233";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

/** A create-only, paged, in-memory bucket behind the real GCS request shapes. */
async function fakeBucket(objects: Map<string, Uint8Array>, pageSize = 1000, pageTokens?: (i: number) => string | undefined) {
  const server: Server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url!, "http://x").pathname.split("/o/")[1]!);
    const body = objects.get(name);
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-length", String(body.byteLength)); res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const get: ReplayGet = (url, options, response) => {
    expect(url.searchParams.get("alt")).toBe("media");
    return httpGet(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options, response);
  };
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake-token" });
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer fake-token");
    calls.push(`${init!.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/upload/")) {
      const name = url.searchParams.get("name")!;
      expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      const bytes = new Uint8Array(await new Response(init!.body).arrayBuffer());
      if (objects.has(name)) return new Response(null, { status: 412 });
      objects.set(name, bytes);
      return new Response(null, { status: 200 });
    }
    const name = url.pathname.split("/o/")[1];
    if (init!.method === "DELETE") return new Response(null, { status: objects.delete(decodeURIComponent(name!)) ? 204 : 404 });
    const page = Number(url.searchParams.get("pageToken") ?? "0");
    const names = [...objects.keys()].reverse();
    const next = (page + 1) * pageSize < names.length ? (pageTokens?.(page + 1) ?? String(page + 1)) : undefined;
    return Response.json({ items: names.slice(page * pageSize, (page + 1) * pageSize).map(n => ({ name: n })), ...(next ? { nextPageToken: next } : {}) });
  };
  return { store: createGcsInputStore("example-record-inputs", request, get), calls };
}

describe("input object names", () => {
  it("recognises only service inputs and markers, never public or private records", () => {
    expect(parseInputObjectName(`${ID}.input`)).toEqual({ kind: "input", id: ID });
    const version = "a".repeat(40);
    // An unversioned marker is not one this service writes: it is left alone.
    for (const other of [`${ID}.bin`, `${ID}.json`, `${ID}.failed-3`, `${ID}.failed-0`, `${ID}.failed-01`, `${ID}.inputs`, "bad.input", `${ID}.input.tmp`]) {
      expect(parseInputObjectName(other)).toBeNull();
    }
    expect(markerName(ID, 2, version)).toBe(`${ID}.failed-${version}-2`);
    expect(parseInputObjectName(markerName(ID, 2, version))).toEqual({ kind: "marker", id: ID, n: 2, codeVersion: version });
    expect(parseInputObjectName(`${ID}.failed-${version}-01`)).toBeNull();
    expect(() => markerName(ID, 1, "bad")).toThrow("invalid service code version");
    expect(() => markerName(ID, 0, version)).toThrow("invalid failure number");
    expect(() => markerName("../x", 1, version)).toThrow("invalid replay id");
  });

  it("names a declared running build apart from inputs and markers", () => {
    const version = "c".repeat(40);
    expect(runningBuildName(version)).toBe(`running/${version}`);
    expect(parseRunningBuildName(runningBuildName(version))).toBe(version);
    expect(parseInputObjectName(runningBuildName(version))).toBeNull();
    for (const other of [`running/${"c".repeat(39)}`, `running/${version}/x`, `x/running/${version}`, `${ID}.input`, `running/${"C".repeat(40)}`]) {
      expect(parseRunningBuildName(other)).toBeNull();
    }
    expect(() => runningBuildName("abc")).toThrow("invalid build code version");
  });
});

describe("GCS input store", () => {
  it("lists every page, sorted, and refuses a repeated page token", async () => {
    const objects = new Map(Array.from({ length: 5 }, (_, i) => [`2026-10-21T10-00-0${i}-000Z-1.input`, new Uint8Array()]));
    const { store, calls } = await fakeBucket(objects, 2);
    expect(await store.list()).toEqual([...objects.keys()].sort());
    expect(calls.filter(c => c.startsWith("GET"))).toHaveLength(3);
    const looping = await fakeBucket(objects, 2, () => "1");
    await expect(looping.store.list()).rejects.toThrow("repeated a page token");
  });

  it("reads exact bytes and returns null for a missing object", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 31, 139]);
    const { store } = await fakeBucket(new Map([[`${ID}.input`, bytes]]));
    expect(await store.get(`${ID}.input`)).toEqual(bytes);
    expect(await store.get(`${ID}.failed-1`)).toBeNull();
  });

  it("creates markers create-only with their reason and never overwrites one", async () => {
    const objects = new Map<string, Uint8Array>();
    const { store } = await fakeBucket(objects);
    const version = "a".repeat(40);
    expect(await store.createMarker(ID, 1, "history build timed out", version)).toBe(true);
    expect(await store.createMarker(ID, 1, "a later reason", version)).toBe(false);
    expect(await store.markerReason(ID, 1, version)).toBe("history build timed out");
    expect(await store.markerReason(ID, 2, version)).toBeNull();
  });

  it("keeps separate failure budgets and reasons for each service version", async () => {
    const { store } = await fakeBucket(new Map());
    const old = "a".repeat(40), current = "b".repeat(40);
    expect(await store.createMarker(ID, 1, "old", old)).toBe(true);
    expect(await store.createMarker(ID, 1, "current", current)).toBe(true);
    expect(await store.createMarker(ID, 1, "collision", current)).toBe(false);
    expect(await store.markerReason(ID, 1, old)).toBe("old");
    expect(await store.markerReason(ID, 1, current)).toBe("current");
  });

  it("deletes objects and treats an already-missing object as deleted", async () => {
    const objects = new Map([[`${ID}.input`, new Uint8Array([1])]]);
    const { store } = await fakeBucket(objects);
    await store.delete(`${ID}.input`);
    expect(objects.has(`${ID}.input`)).toBe(false);
    await expect(store.delete(`${ID}.input`)).resolves.toBeUndefined();
  });
});
