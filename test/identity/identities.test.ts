import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createFirestore } from "../../src/store/firestore.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT. Skipped only when the variable is
// unset; when it is set, an unreachable emulator fails every test.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const RACE_TIMEOUT = 60_000; // the emulator reports a lock conflict after about 2 s

let counter = 0;
const freshNamespace = () => `t${process.pid}-${Date.now().toString(36)}-${counter++}`;
const storeFor = (namespace: string, request?: typeof fetch) => createFirestore({ projectId, namespace, emulatorHost: host, request });
const identitiesFor = (namespace: string, request?: typeof fetch) => createIdentities(storeFor(namespace, request));

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** Every stored document under a namespace, read raw from the emulator. */
async function rawDocuments(namespace: string): Promise<{ name: string; fields: Record<string, unknown> }[]> {
  const parent = `projects/${projectId}/databases/(default)/documents/namespaces/${namespace}`;
  const documents: { name: string; fields: Record<string, unknown> }[] = [];
  for (const collectionId of ["usernames", "handles", "identities", "keys"]) {
    const response = await fetch(`http://${host}/v1/${parent}:runQuery`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId, allDescendants: true }] } }),
    });
    expect(response.ok).toBe(true);
    for (const row of await response.json() as { document?: { name: string; fields: Record<string, unknown> } }[]) {
      if (row.document) documents.push({ name: row.document.name, fields: row.document.fields });
    }
  }
  return documents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Forces two operations to overlap: each contender's first write request (a
 * commit, or any document PATCH/DELETE) is held until both have reached one, so
 * both have read before either writes. Retries pass through unheld.
 */
function overlap() {
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  return (): typeof fetch => {
    let held = false;
    return async (input, init) => {
      const method = init?.method ?? "GET";
      const write = (method === "POST" && String(input).endsWith(":commit")) || method === "PATCH" || method === "DELETE";
      if (write && !held) {
        held = true;
        if (++arrived === 2) release();
        await Promise.race([both, sleep(15_000, undefined, { ref: false }).then(() => {
          throw new Error("barrier: both contenders did not reach a write within 15 s");
        })]);
      }
      return fetch(input, init);
    };
  };
}

describe.skipIf(!host)("identities against the Firestore emulator", () => {
  it("claims a free username, returns its key once and stores only a verifier", async () => {
    const namespace = freshNamespace();
    const ids = identitiesFor(namespace);
    const { identity, key } = value(await ids.claimUsername("Kite"));
    expect(identity).toEqual({ id: expect.any(String), kind: "username", displayName: "Kite" });
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const resolved = value(await ids.resolveKey(key));
    expect(resolved).toEqual(identity);
    expect(JSON.stringify(resolved)).not.toContain(key);

    const stored = JSON.stringify(await rawDocuments(namespace));
    const bytes = Buffer.from(key, "base64url");
    for (const form of [key, bytes.toString("hex"), bytes.toString("base64")]) expect(stored).not.toContain(form);
    const verifier = createHash("sha256").update(key).digest("hex");
    const identityDoc = (await rawDocuments(namespace)).find((doc) => doc.name.endsWith(`/identities/${identity.id}`))!;
    expect(identityDoc.fields).toEqual({
      kind: { stringValue: "username" }, displayName: { stringValue: "Kite" },
      canonical: { stringValue: "kite" }, verifier: { stringValue: verifier },
      claimedAt: { stringValue: expect.stringMatching(/^\d+$/) },
      lastKeyUseAt: { stringValue: expect.stringMatching(/^\d+$/) },
    });
  });

  it("treats names equal after NFKC and case-folding as one name, and refuses \"/\"", async () => {
    const ids = identitiesFor(freshNamespace());
    value(await ids.claimUsername("Kite"));
    expect(await ids.claimUsername("kite")).toEqual({ ok: false, reason: "taken" });
    expect(await ids.claimUsername("ＫＩＴＥ")).toEqual({ ok: false, reason: "taken" });
    expect(await ids.claimUsername("Kite")).toEqual({ ok: false, reason: "taken" });
    expect(await ids.claimUsername("kite/scout")).toEqual({ ok: false, reason: "invalid_name" });
    expect(await ids.claimUsername("fire/")).toEqual({ ok: false, reason: "invalid_name" });
  });

  it("lets exactly one of two simultaneous claims of a free name succeed", { timeout: RACE_TIMEOUT }, async () => {
    for (let round = 0; round < 3; round++) {
      const namespace = freshNamespace();
      const wrap = overlap();
      const results = await Promise.all([
        identitiesFor(namespace, wrap()).claimUsername("Kite"),
        identitiesFor(namespace, wrap()).claimUsername("kite"),
      ]);
      const winners = results.filter((result) => result.ok);
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "taken" }]);
      const winner = value(winners[0]!);
      expect(value(await identitiesFor(namespace).resolveKey(winner.key))).toEqual(winner.identity);
      expect((await rawDocuments(namespace)).filter((doc) => doc.name.includes("/identities/"))).toHaveLength(1);
    }
  });

  it("creates owner/handle identities with their own keys, unique per owner", async () => {
    const ids = identitiesFor(freshNamespace());
    const kay = value(await ids.claimUsername("Kite"));
    const bob = value(await ids.claimUsername("bob"));

    const scout = value(await ids.createHandle(kay.key, "Scout"));
    expect(scout.identity).toEqual({ id: expect.any(String), kind: "handle", displayName: "Kite/Scout" });
    expect(scout.identity.id).not.toBe(kay.identity.id);
    expect(scout.key).not.toBe(kay.key);
    expect(value(await ids.resolveKey(scout.key))).toEqual(scout.identity);
    expect(value(await ids.resolveKey(kay.key))).toEqual(kay.identity);

    expect(await ids.createHandle(kay.key, "scout")).toEqual({ ok: false, reason: "taken" });
    expect(await ids.createHandle(kay.key, "ＳＣＯＵＴ")).toEqual({ ok: false, reason: "taken" });
    expect(await ids.createHandle(kay.key, "a/b")).toEqual({ ok: false, reason: "invalid_name" });
    const bobScout = value(await ids.createHandle(bob.key, "scout"));
    expect(bobScout.identity.displayName).toBe("bob/scout");
    expect(bobScout.identity.id).not.toBe(scout.identity.id);

    expect(await ids.createHandle(scout.key, "minion")).toEqual({ ok: false, reason: "not_owner_key" });
    expect(await ids.createHandle("not-a-key", "minion")).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("resolves a key to exactly its identity and refuses unknown keys", async () => {
    const ids = identitiesFor(freshNamespace());
    const kay = value(await ids.claimUsername("Kite"));
    const scout = value(await ids.createHandle(kay.key, "scout"));
    expect(await ids.resolveKey(kay.key)).toEqual({ ok: true, value: { id: kay.identity.id, kind: "username", displayName: "Kite" } });
    expect(await ids.resolveKey(scout.key)).toEqual({ ok: true, value: { id: scout.identity.id, kind: "handle", displayName: "Kite/scout" } });
    expect(await ids.resolveKey("")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await ids.resolveKey(kay.key.slice(1))).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rotates a key: a new key once, and the old key stops working at once", async () => {
    const ids = identitiesFor(freshNamespace());
    const kay = value(await ids.claimUsername("Kite"));
    const scout = value(await ids.createHandle(kay.key, "scout"));

    const { key: kayNext } = value(await ids.rotateKey(kay.key));
    expect(kayNext).not.toBe(kay.key);
    expect(await ids.resolveKey(kay.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await ids.rotateKey(kay.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await ids.createHandle(kay.key, "other")).toEqual({ ok: false, reason: "unknown_key" });
    expect(value(await ids.resolveKey(kayNext))).toEqual(kay.identity);

    const { key: scoutNext } = value(await ids.rotateKey(scout.key));
    expect(await ids.resolveKey(scout.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(value(await ids.resolveKey(scoutNext))).toEqual(scout.identity);
  });

  it("reissues a handle key with the owner key; a username key is replaced only by rotateKey or reissueLostKey", async () => {
    const namespace = freshNamespace();
    const ids = identitiesFor(namespace);
    const kay = value(await ids.claimUsername("Kite"));
    const scout = value(await ids.createHandle(kay.key, "Scout"));

    const { key: reissued } = value(await ids.reissueHandleKey(kay.key, "SCOUT"));
    expect(reissued).not.toBe(scout.key);
    expect(await ids.resolveKey(scout.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(value(await ids.resolveKey(reissued))).toEqual(scout.identity);
    expect(value(await ids.resolveKey(kay.key))).toEqual(kay.identity);

    expect(await ids.reissueHandleKey(reissued, "scout")).toEqual({ ok: false, reason: "not_owner_key" });
    expect(await ids.reissueHandleKey(kay.key, "nobody")).toEqual({ ok: false, reason: "no_such_handle" });
    expect(await ids.reissueHandleKey(scout.key, "scout")).toEqual({ ok: false, reason: "unknown_key" });

    // Public identity operations, retention initialization and successful-join recording.
    expect(Object.keys(ids).sort()).toEqual(["claimUsername", "createHandle", "findByDisplayName", "findById", "recordMatchJoin", "reissueHandleKey", "reissueLostKey", "resolveKey", "rotateKey"]);
  });

  it("lets exactly one of two simultaneous rotations of the same key succeed", { timeout: RACE_TIMEOUT }, async () => {
    for (let round = 0; round < 3; round++) {
      const namespace = freshNamespace();
      const kay = value(await identitiesFor(namespace).claimUsername("Kite"));
      const wrap = overlap();
      const results = await Promise.all([
        identitiesFor(namespace, wrap()).rotateKey(kay.key),
        identitiesFor(namespace, wrap()).rotateKey(kay.key),
      ]);
      const ids = identitiesFor(namespace);
      const winners = results.filter((result) => result.ok);
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "unknown_key" }]);
      expect(await ids.resolveKey(kay.key)).toEqual({ ok: false, reason: "unknown_key" });
      expect(value(await ids.resolveKey(value(winners[0]!).key))).toEqual(kay.identity);
    }
  });

  it("serialises a handle's rotation against its owner's reissue: one handle key stays live", { timeout: RACE_TIMEOUT }, async () => {
    for (let round = 0; round < 3; round++) {
      const namespace = freshNamespace();
      const setup = identitiesFor(namespace);
      const kay = value(await setup.claimUsername("Kite"));
      const scout = value(await setup.createHandle(kay.key, "scout"));
      const wrap = overlap();
      const [rotated, reissued] = await Promise.all([
        identitiesFor(namespace, wrap()).rotateKey(scout.key),
        identitiesFor(namespace, wrap()).reissueHandleKey(kay.key, "scout"),
      ]);
      const ids = identitiesFor(namespace);
      expect(value(await ids.resolveKey(kay.key))).toEqual(kay.identity);
      expect(await ids.resolveKey(scout.key)).toEqual({ ok: false, reason: "unknown_key" });
      const returned = [rotated, reissued].flatMap((result) => (result.ok ? [result.value.key] : []));
      expect(reissued.ok).toBe(true); // the owner's key stays valid, so the reissue always lands
      const live: string[] = [];
      for (const key of returned) {
        const resolved = await ids.resolveKey(key);
        if (resolved.ok) {
          expect(resolved.value).toEqual(scout.identity);
          live.push(key);
        }
      }
      expect(live).toHaveLength(1);
    }
  });

  it("keeps namespaces apart: no reads or changes across them", async () => {
    const a = freshNamespace(), b = freshNamespace();
    const inA = identitiesFor(a), inB = identitiesFor(b);
    const kayA = value(await inA.claimUsername("Kite"));
    const scoutA = value(await inA.createHandle(kayA.key, "scout"));
    const before = await rawDocuments(a);

    const kayB = value(await inB.claimUsername("Kite"));
    expect(kayB.identity.id).not.toBe(kayA.identity.id);
    expect(await inB.resolveKey(kayA.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await inB.rotateKey(kayA.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await inB.createHandle(kayA.key, "spy")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await inB.reissueHandleKey(kayA.key, "scout")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await inB.rotateKey(scoutA.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await inA.resolveKey(kayB.key)).toEqual({ ok: false, reason: "unknown_key" });

    expect(await rawDocuments(a)).toEqual(before);
    expect(value(await inA.resolveKey(kayA.key))).toEqual(kayA.identity);
    expect(value(await inA.resolveKey(scoutA.key))).toEqual(scoutA.identity);
  });
});

describe("Firestore client without the emulator", () => {
  it("imports under Node's own TypeScript stripping, as npm start runs it", async () => {
    const script = 'await import("./src/store/firestore.ts"); await import("./src/identity/identities.ts");';
    await promisify(execFile)(process.execPath, ["--import", "./src/ts-resolve.mjs", "--input-type=module", "-e", script]);
  });

  /** Scripted Firestore replies, in order; records each request as "method transaction". */
  function scripted(replies: { status?: number; body: unknown }[]) {
    const calls: string[] = [];
    const request: typeof fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { transaction?: string } : {};
      calls.push(`${String(input).split(":").pop()} ${body.transaction ?? "-"}`);
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected request ${String(input)}`);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    };
    return { calls, store: createFirestore({ projectId: "demo-antwar", namespace: "scripted", emulatorHost: "scripted:1", request }) };
  }
  const prefix = "projects/demo-antwar/databases/(default)/documents/namespaces/scripted/";
  const failed = (status: string, code: number) => ({ status: code, body: { error: { code, status } } });

  it("reruns the whole transaction when a transactional read is ABORTED, even if its rollback fails", async () => {
    const { calls, store } = scripted([
      { body: { transaction: "t1" } }, failed("ABORTED", 409), failed("INVALID_ARGUMENT", 400),
      { body: { transaction: "t2" } },
      { body: [{ found: { name: `${prefix}usernames/kite`, fields: { identity: { stringValue: "i1" } } } }] },
      failed("INTERNAL", 500),
    ]);
    const result = await store.transaction(async (read) => {
      const taken = (await read(["usernames/kite"])).get("usernames/kite") !== null;
      return { result: taken ? "taken" : "claimed", writes: [] };
    });
    expect(result).toBe("taken");
    expect(calls).toEqual(["beginTransaction -", "batchGet t1", "rollback t1", "beginTransaction -", "batchGet t2", "rollback t2"]);
  });

  it("does not retry a transactional read failing with anything but ABORTED, whatever its rollback returns", async () => {
    const { calls, store } = scripted([{ body: { transaction: "t1" } }, failed("UNAVAILABLE", 503), failed("ABORTED", 409)]);
    await expect(store.transaction(async (read) => ({ result: await read(["usernames/kite"]), writes: [] }))).rejects.toThrow(/UNAVAILABLE/);
    expect(calls).toEqual(["beginTransaction -", "batchGet t1", "rollback t1"]);
  });
});
