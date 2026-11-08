import { describe, expect, it } from "vitest";
import { createFirestore, FIRESTORE_RPC_TIMEOUT_MS, type Write } from "../../src/store/firestore.ts";

/** A Google-hosted Store against a fake Firestore API whose first commit is ABORTED; every call is logged in order. */
function abortingOnce() {
  const log: string[] = [];
  let commits = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake", expires_in: 3599 });
    log.push(`${url.pathname.split(":").at(-1)}${init?.signal ? "" : " (no deadline)"}`);
    if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "t" });
    if (url.pathname.endsWith(":rollback")) return Response.json({});
    if (url.pathname.endsWith(":commit")) {
      commits += 1;
      return commits === 1 ? Response.json({ error: { status: "ABORTED" } }, { status: 409 }) : Response.json({});
    }
    return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
  };
  return { store: createFirestore({ projectId: "fake-project", namespace: "commit-check", request }), log };
}

const WRITE: Write = { op: "create", path: "keys/k", fields: { identity: "i" } };

describe("Firestore transaction retries rerun the step's last check before each commit", () => {
  it("the store's RPC bound is below the default MCP idle window", () => {
    expect(FIRESTORE_RPC_TIMEOUT_MS).toBeLessThan(5 * 60 * 1000);
  });

  it("an ABORTED commit reruns the step, so its check is asked again before the retried commit, each RPC with a deadline", async () => {
    const { store, log } = abortingOnce();
    await store.transaction(async () => {
      log.push("check");
      return { result: undefined, writes: [WRITE] };
    });
    expect(log).toEqual(["beginTransaction", "check", "commit", "beginTransaction", "check", "commit"]);
  });

  it("a pause between the step's check and the commit's launch that passes the commit deadline commits nothing: late is returned", async () => {
    const clock = { now: 1_000 };
    const log: string[] = [];
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake", expires_in: 3599 });
      log.push(url.pathname.split(":").at(-1)!);
      if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "t" });
      return Response.json({});
    };
    const store = createFirestore({ projectId: "fake-project", namespace: "commit-check", request, now: () => clock.now });
    const deadline = { at: 1_100, late: "server_busy" };
    const passed = await store.transaction(async () => {
      log.push("check");
      // The pause: by the time the commit would be launched, the deadline has passed.
      clock.now = 1_100;
      return { result: "issued", writes: [WRITE], commitBy: deadline };
    });
    expect(passed).toBe("server_busy");
    expect(log).toEqual(["beginTransaction", "check", "rollback"]);
    // Before the deadline, the same commit is launched and its result returned.
    log.length = 0;
    clock.now = 1_000;
    const inTime = await store.transaction(async () => {
      log.push("check");
      clock.now = 1_099;
      return { result: "issued", writes: [WRITE], commitBy: deadline };
    });
    expect(inTime).toBe("issued");
    expect(log).toEqual(["beginTransaction", "check", "commit"]);
  });

  it("a commit whose deadline comes before the RPC timeout is cut off at the deadline", async () => {
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake", expires_in: 3599 });
      if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "t" });
      if (url.pathname.endsWith(":rollback")) return Response.json({});
      // The commit never answers: only its own signal ends it.
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    };
    const store = createFirestore({ projectId: "fake-project", namespace: "commit-check", request });
    const started = Date.now();
    await expect(store.transaction(async () => ({ result: "issued", writes: [WRITE], commitBy: { at: Date.now() + 100, late: "server_busy" } }))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(FIRESTORE_RPC_TIMEOUT_MS / 10);
  });

  it("a retried attempt whose check refuses commits nothing", async () => {
    const { store, log } = abortingOnce();
    let attempts = 0;
    const result = await store.transaction(async () => {
      attempts += 1;
      log.push("check");
      return attempts === 1 ? { result: "issued", writes: [WRITE] } : { result: "server_busy", writes: [] };
    });
    expect(result).toBe("server_busy");
    expect(log).toEqual(["beginTransaction", "check", "commit", "beginTransaction", "check", "rollback"]);
  });
});
