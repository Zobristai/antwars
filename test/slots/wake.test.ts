/// <reference types="node" />
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type GameServer } from "../../src/server.ts";
import { noteSlotTaken, slotWakerFromEnv, WAKE_RETRY_DELAYS_MS, wakingStore } from "../../src/slots/wake.ts";
import type { Fields, Store, TransactionRead, Write } from "../../src/store/firestore.ts";
import { tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

/**
 * A store with the shared store's transaction contract: an attempt whose step
 * returns no writes is rolled back; otherwise its writes commit, or, scripted here,
 * the commit is aborted (the whole step reruns) or fails.
 */
function fakeStore(script: { readonly abortCommits?: number; readonly failCommit?: boolean } = {}) {
  const docs = new Map<string, Fields>();
  let aborts = script.abortCommits ?? 0;
  let attempts = 0;
  const store: Store = {
    namespace: "fake",
    async get(path) {
      return docs.get(path) ?? null;
    },
    async query() {
      return { rows: [...docs].map(([path, fields]) => ({ path, fields })), readTime: "2026-10-23T00:00:00Z" };
    },
    async transaction(step) {
      for (;;) {
        attempts++;
        const read: TransactionRead = async (paths) => new Map(paths.map((path) => [path, docs.get(path) ?? null]));
        const outcome = await step(read);
        if (outcome.writes.length === 0) return outcome.result;
        if (aborts > 0) {
          aborts--;
          continue;
        }
        if (script.failCommit) throw new Error("commit failed");
        for (const write of outcome.writes) {
          if (write.op === "delete") docs.delete(write.path);
          else docs.set(write.path, { ...docs.get(write.path), ...write.fields });
        }
        return outcome.result;
      }
    },
  };
  return { store, docs, attempts: () => attempts };
}

const take = (slot: string): Write => ({ op: "create", path: `slots/${slot}`, fields: { lobbyId: "l" } });

/** Records each wake with whether its slot's write had already committed when it was called. */
function recorder(docs: ReadonlyMap<string, Fields>) {
  const woken: { slot: string; committed: boolean }[] = [];
  return { woken, wake: (slot: string) => void woken.push({ slot, committed: docs.has(`slots/${slot}`) }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waking store", () => {
  it("wakes each slot noted in a committed transaction once, after the commit", async () => {
    const fake = fakeStore();
    const r = recorder(fake.docs);
    const store = wakingStore(fake.store, r.wake);
    const result = await store.transaction(async (read) => {
      await read(["slots/public-3"]);
      noteSlotTaken(read, "public-3");
      noteSlotTaken(read, "private-1");
      noteSlotTaken(read, "public-3");
      expect(r.woken).toEqual([]);
      return { result: "done", writes: [take("public-3"), take("private-1")] };
    });
    expect(result).toBe("done");
    expect(r.woken).toEqual([{ slot: "public-3", committed: true }, { slot: "private-1", committed: true }]);
  });

  it("wakes nothing for a rolled-back, refused or failed transaction", async () => {
    const rolledBack = fakeStore();
    const r1 = recorder(rolledBack.docs);
    // A refusal returns no writes: nothing commits.
    expect(await wakingStore(rolledBack.store, r1.wake).transaction(async (read) => {
      noteSlotTaken(read, "public-0");
      return { result: "refused", writes: [] };
    })).toBe("refused");
    expect(r1.woken).toEqual([]);

    const thrown = fakeStore();
    const r2 = recorder(thrown.docs);
    await expect(wakingStore(thrown.store, r2.wake).transaction(async (read) => {
      noteSlotTaken(read, "public-0");
      throw new Error("step failed");
    })).rejects.toThrow("step failed");
    expect(r2.woken).toEqual([]);

    const failed = fakeStore({ failCommit: true });
    const r3 = recorder(failed.docs);
    await expect(wakingStore(failed.store, r3.wake).transaction(async (read) => {
      noteSlotTaken(read, "public-0");
      return { result: null, writes: [take("public-0")] };
    })).rejects.toThrow("commit failed");
    expect(r3.woken).toEqual([]);
  });

  it("wakes only what the committing attempt noted when earlier attempts were aborted", async () => {
    const fake = fakeStore({ abortCommits: 2 });
    const r = recorder(fake.docs);
    let attempt = 0;
    await wakingStore(fake.store, r.wake).transaction(async (read) => {
      attempt++;
      const slot = attempt < 3 ? "public-0" : "public-1";
      noteSlotTaken(read, slot);
      return { result: null, writes: [take(slot)] };
    });
    expect(fake.attempts()).toBe(3);
    expect(r.woken).toEqual([{ slot: "public-1", committed: true }]);
  });

  it("keeps the transaction's result when a wake throws, and still wakes the other slots", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeStore();
    const woken: string[] = [];
    const store = wakingStore(fake.store, (slot) => {
      woken.push(slot);
      if (slot === "public-0") throw new Error("waker down");
    });
    expect(await store.transaction(async (read) => {
      noteSlotTaken(read, "public-0");
      noteSlotTaken(read, "public-1");
      return { result: 7, writes: [take("public-0"), take("public-1")] };
    })).toBe(7);
    expect(woken).toEqual(["public-0", "public-1"]);
    expect(fake.docs.get("slots/public-0")).toEqual({ lobbyId: "l" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("waker down"));
  });

  it("passes reads through unchanged, and noting on another store's read does nothing", async () => {
    const fake = fakeStore();
    fake.docs.set("slots/public-0", { lobbyId: "x" });
    const woken: string[] = [];
    const store = wakingStore(fake.store, (slot) => void woken.push(slot));
    expect(store.namespace).toBe("fake");
    expect(await store.get("slots/public-0")).toEqual({ lobbyId: "x" });
    expect((await store.query("slots", { orderBy: "lobbyId", direction: "ASCENDING", limit: 1 })).rows).toEqual([{ path: "slots/public-0", fields: { lobbyId: "x" } }]);
    await fake.store.transaction(async (read) => {
      noteSlotTaken(read, "public-1");
      return { result: null, writes: [take("public-1")] };
    });
    expect(woken).toEqual([]);
  });
});

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("slot waker from ANTWAR_SLOT_URL_TEMPLATE", () => {
  it("is absent when the template is unset or empty, and refuses a malformed template", () => {
    expect(slotWakerFromEnv({})).toBeUndefined();
    expect(slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: "" })).toBeUndefined();
    for (const template of [
      "https://antwar.example.run.app",
      "http://antwar-{slot}.example.run.app",
      "antwar-{slot}",
      "https://antwar-{slot}.example.run.app/?x=1",
      "https://user:pass@antwar-{slot}.example.run.app",
    ]) {
      expect(() => slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: template }), template).toThrow(/ANTWAR_SLOT_URL_TEMPLATE/);
    }
  });

  it("sends a GET to the slot's /wake without waiting for it, and logs a failure without throwing (no retries configured)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: { url: string; method: string | undefined }[] = [];
    const answers: (() => Promise<Response>)[] = [
      async () => new Response(null, { status: 204 }),
      async () => new Response("unavailable", { status: 503 }),
      async () => { throw new Error("connection refused"); },
    ];
    const request: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), method: init?.method });
      return answers.shift()!();
    };
    const wake = slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: "https://antwar-{slot}-123.europe-west1.run.app" }, request, [])!;
    expect(wake("public-3")).toBeUndefined();
    expect(wake("private-7")).toBeUndefined();
    expect(wake("public-0")).toBeUndefined();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(4));
    expect(sent).toEqual([
      { url: "https://antwar-public-3-123.europe-west1.run.app/wake", method: "GET" },
      { url: "https://antwar-private-7-123.europe-west1.run.app/wake", method: "GET" },
      { url: "https://antwar-public-0-123.europe-west1.run.app/wake", method: "GET" },
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/private-7.*503/));
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/public-0.*connection refused/));
    expect(error).toHaveBeenCalledWith("antwar wake for slot private-7 gave up after 1 attempt");

    const pathed = slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: "https://slots.example.test/{slot}/" }, async (input) => {
      sent.push({ url: String(input), method: "GET" });
      return new Response(null, { status: 204 });
    })!;
    pathed("private-1");
    await vi.waitFor(() => expect(sent.at(-1)?.url).toBe("https://slots.example.test/private-1/wake"));
  });

  it("sends the wake-up when no server listens at the slot's address, logging the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await closedPort();
    const sent: string[] = [];
    const wake = slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: `https://127.0.0.1:${port}/{slot}` }, (input, init) => {
      sent.push(String(input));
      return fetch(input, init);
    }, [])!;
    wake("public-2");
    expect(sent).toEqual([`https://127.0.0.1:${port}/public-2/wake`]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("antwar wake for slot public-2 failed")));
    expect(sent).toHaveLength(1);
  });

  it("retries a failed wake after each configured delay, then stops at the first success", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: (() => Promise<Response>)[] = [
      async () => { throw new Error("connection reset"); },
      async () => new Response("unavailable", { status: 503 }),
      async () => new Response(null, { status: 204 }),
    ];
    const sent: string[] = [];
    const wake = slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: "https://antwar-{slot}.example.test" }, async (input) => {
      sent.push(String(input));
      return answers.shift()!();
    }, [1, 1, 1])!;
    expect(wake("public-0")).toBeUndefined();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual(Array(3).fill("https://antwar-public-0.example.test/wake"));
    expect(error.mock.calls.map(([line]) => line)).toEqual([
      "antwar wake for slot public-0 failed: connection reset",
      "antwar wake for slot public-0 answered HTTP 503",
    ]);
  });

  it("gives up after the bounded attempts, logging each failure and the give-up, never throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let sent = 0;
    const wake = slotWakerFromEnv({ ANTWAR_SLOT_URL_TEMPLATE: "https://antwar-{slot}.example.test" }, async () => {
      sent++;
      throw new Error("connection refused");
    }, [1, 1])!;
    expect(() => wake("private-0")).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("antwar wake for slot private-0 gave up after 3 attempts"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toBe(3);
    expect(error).toHaveBeenCalledTimes(4);
  });

  it("retries twice by default, after 2 s and then 4 s", () => {
    expect(WAKE_RETRY_DELAYS_MS).toEqual([2_000, 4_000]);
  });
});

describe("GET /wake", () => {
  let server: GameServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("is answered 204 with no body by every server; another method is refused", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "held", mcpConfig: TEST_MCP_CONFIG });
    server.mount("/", (_req, res) => void res.end("page"));
    const woken = await fetch(`http://127.0.0.1:${server.port}/wake`);
    expect(woken.status).toBe(204);
    expect(await woken.text()).toBe("");
    const posted = await fetch(`http://127.0.0.1:${server.port}/wake`, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });
});
