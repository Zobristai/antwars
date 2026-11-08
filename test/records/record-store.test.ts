import { describe, expect, it } from "vitest";
import { createGcsRecordStore } from "../../src/records/record-store.ts";
import { unavailableRecord } from "../../src/replays/history.ts";
import { openPrivateMedia, privateMediaName, sealPrivateMedia } from "../../src/replays/private-media.ts";

const ID = "2026-10-21T10-00-00-000Z-243";
const KEY = new Uint8Array(32).fill(7);
const identity = { replayId: ID, lobbyId: "lobby-7", kind: "match-record" as const };
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const unavailable = () => json(unavailableRecord(ID, "old verifier failed"));
const complete = () => json({ ...unavailableRecord(ID, ""), status: "complete", source: "match-log", unavailable: [] });

/** Each upload and generation-pinned read uses the real GCS shape, with deterministic racing writers. */
function bucket() {
  let next = 0;
  const objects = new Map<string, { body: Uint8Array; generation: string }>();
  const calls: { method: string; url: URL }[] = [];
  const put = (name: string, body: Uint8Array) => objects.set(name, { body, generation: String(++next) });
  let hook: ((url: URL, method: string) => Response | undefined) | undefined;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake" });
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer fake");
    expect(init!.redirect).toBe("error");
    calls.push({ url, method });
    const intercepted = hook?.(url, method);
    if (intercepted !== undefined) return intercepted;
    const name = url.pathname.startsWith("/upload/") ? url.searchParams.get("name")! : decodeURIComponent(url.pathname.split("/o/")[1]!);
    const object = objects.get(name);
    if (method === "POST") {
      expect(url.searchParams.get("uploadType")).toBe("media");
      const body = new Uint8Array(await new Response(init!.body).arrayBuffer());
      if (url.searchParams.get("ifGenerationMatch") !== (objects.get(name)?.generation ?? "0")) return new Response(null, { status: 412 });
      put(name, body);
      return new Response(null, { status: 200 });
    }
    expect(method).toBe("GET"); // No delete call is part of replacement.
    if (object === undefined) return new Response(null, { status: 404 });
    if (url.searchParams.get("alt") === "media") {
      if (url.searchParams.get("generation") !== object.generation) return new Response(null, { status: 404 });
      return new Response(Buffer.from(object.body));
    }
    expect(url.searchParams.get("fields")).toBe("generation");
    return Response.json({ generation: object.generation });
  };
  return { objects, calls, put, store: createGcsRecordStore("fake-records", KEY, request), request,
    intercept: (fn: typeof hook) => { hook = fn; } };
}

describe("record-only conditional storage", () => {
  it("creates a record at generation zero and replaces only an unavailable generation", async () => {
    const gcs = bucket(), target = gcs.store.forMatch(ID, null)!;
    expect(await target.save(unavailable())).toEqual({ complete: false, outcome: "record created" });
    const generation = gcs.objects.get(`${ID}.json`)!.generation;
    expect(await target.save(complete())).toEqual({ complete: true, outcome: "unavailable record replaced" });
    expect(gcs.calls.filter(c => c.method === "POST").map(c => c.url.searchParams.get("ifGenerationMatch"))).toEqual(["0", "0", generation]);
    expect(gcs.objects.get(`${ID}.json`)!.body).toEqual(complete());
  });

  it("never replaces a complete record with another complete record or an unavailable stub", async () => {
    const gcs = bucket(), original = complete();
    gcs.put(`${ID}.json`, original);
    const target = gcs.store.forMatch(ID, null)!;
    expect(await target.save(complete())).toEqual({ complete: true, outcome: "complete record already present", stored: original });
    expect(await target.save(unavailable())).toEqual({ complete: true, outcome: "complete record already present", stored: original });
    expect(gcs.objects.get(`${ID}.json`)!.body).toBe(original);
    expect(gcs.calls.filter(c => c.method === "POST").every(c => c.url.searchParams.get("ifGenerationMatch") === "0")).toBe(true);
  });

  it("returns a sealed private complete record already present decrypted, never replacing it", async () => {
    const gcs = bucket(), original = complete(), sealed = sealPrivateMedia(identity, original, Buffer.from(KEY));
    gcs.put(privateMediaName(identity), sealed);
    const result = await gcs.store.forMatch(ID, "lobby-7")!.save(complete());
    expect(result).toMatchObject({ complete: true, outcome: "complete record already present" });
    expect(result.outcome === "complete record already present" && Buffer.from(result.stored).equals(Buffer.from(original))).toBe(true);
    expect(gcs.objects.get(privateMediaName(identity))!.body).toBe(sealed);
  });

  it("preserves an existing unavailable reason and partial record without claiming completeness", async () => {
    const gcs = bucket(), original = unavailable(), target = gcs.store.forMatch(ID, null)!;
    gcs.put(`${ID}.json`, original);
    expect((await target.save(unavailable())).complete).toBe(false);
    expect(gcs.objects.get(`${ID}.json`)!.body).toBe(original);
    const partial = json({ ...unavailableRecord(ID, "binary only"), status: "partial", source: "binary" });
    gcs.put(`${ID}.json`, partial);
    expect(await target.save(complete())).toEqual({ complete: false, outcome: "existing record preserved" });
    expect(gcs.objects.get(`${ID}.json`)!.body).toBe(partial);
  });

  it("re-reads a race winner instead of overwriting its complete record", async () => {
    const gcs = bucket(), winner = complete();
    gcs.put(`${ID}.json`, unavailable());
    gcs.intercept((url, method) => {
      if (method === "POST" && url.searchParams.get("ifGenerationMatch") !== "0") {
        gcs.intercept(undefined); gcs.put(`${ID}.json`, winner);
      }
      return undefined;
    });
    expect((await gcs.store.forMatch(ID, null)!.save(complete())).complete).toBe(true);
    expect(gcs.objects.get(`${ID}.json`)!.body).toBe(winner);
  });

  it("concurrent complete and unavailable writers converge on a complete record", async () => {
    const gcs = bucket();
    gcs.put(`${ID}.json`, unavailable());
    const a = gcs.store.forMatch(ID, null)!, b = createGcsRecordStore("fake-records", KEY, gcs.request).forMatch(ID, null)!;
    await Promise.all([a.save(complete()), b.save(unavailable()), b.save(complete())]);
    expect(gcs.objects.get(`${ID}.json`)!.body).toEqual(complete());
  });

  it("bounds generation churn and fails without authorizing input deletion", async () => {
    const gcs = bucket();
    gcs.put(`${ID}.json`, unavailable());
    gcs.intercept((url, method) => {
      if (method === "POST" && url.searchParams.get("ifGenerationMatch") !== "0") gcs.put(`${ID}.json`, unavailable());
      return undefined;
    });
    await expect(gcs.store.forMatch(ID, null)!.save(complete())).rejects.toThrow("record changed during save");
    expect(gcs.calls.filter(c => c.method === "POST")).toHaveLength(3);
  });

  it("fails closed on missing generation, corrupt records, mismatched identity and read errors", async () => {
    for (const body of [json({ status: "complete" }), json({ ...unavailableRecord(ID, ""), id: "other" }), json("invalid")]) {
      const gcs = bucket(); gcs.put(`${ID}.json`, body);
      await expect(gcs.store.forMatch(ID, null)!.save(complete())).rejects.toThrow("invalid match record");
      expect(gcs.objects.get(`${ID}.json`)!.body).toBe(body);
    }
    for (const response of [Response.json({ generation: "0" }), new Response(null, { status: 403 })]) {
      const gcs = bucket(); gcs.put(`${ID}.json`, unavailable());
      gcs.intercept((_url, method) => method === "GET" ? response : undefined);
      await expect(gcs.store.forMatch(ID, null)!.save(complete())).rejects.toThrow();
    }
  });

  it("pins content reads to the checked generation; a disappearing generation fails safely", async () => {
    const gcs = bucket(); gcs.put(`${ID}.json`, unavailable());
    gcs.intercept((url) => {
      if (url.searchParams.get("alt") === "media") gcs.put(`${ID}.json`, complete());
      return undefined;
    });
    await expect(gcs.store.forMatch(ID, null)!.save(complete())).rejects.toThrow("record read failed: HTTP 404");
  });

  it("replaces private unavailable records only as authenticated ciphertext, with no public alias", async () => {
    const gcs = bucket(), name = privateMediaName(identity), target = gcs.store.forMatch(ID, identity.lobbyId)!;
    expect((await target.save(unavailable())).complete).toBe(false);
    expect((await target.save(complete())).complete).toBe(true);
    expect([...gcs.objects.keys()]).toEqual([name]);
    const sealed = gcs.objects.get(name)!.body;
    expect(new TextDecoder().decode(sealed)).not.toContain("antwar.match");
    expect(openPrivateMedia(identity, sealed, KEY)).toEqual(Buffer.from(complete()));
    const bad = sealPrivateMedia({ ...identity, lobbyId: "wrong" }, unavailable(), KEY);
    gcs.put(name, bad);
    await expect(target.save(complete())).rejects.toThrow("Invalid private media");
    expect(gcs.objects.get(name)!.body).toBe(bad);
  });

  it("holds private matches without a key and rejects invalid persistence identities", () => {
    const gcs = bucket(), store = createGcsRecordStore("fake", undefined, gcs.request);
    expect(store.forMatch(ID, "private")).toBeUndefined();
    expect(() => store.forMatch("invalid", null)).toThrow("invalid replay id");
    expect(() => createGcsRecordStore("fake", new Uint8Array(1), gcs.request)).toThrow();
    expect(gcs.calls).toEqual([]);
  });
});
