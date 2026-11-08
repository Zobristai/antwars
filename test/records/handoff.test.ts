import { describe, expect, it, vi } from "vitest";
import { createRecordHandoff, recordHandoffFromEnv, RETRY_DELAYS_MS, type MatchInputs } from "../../src/records/handoff.ts";
import { decodeInput } from "../../src/records/inputs.ts";
import { ReplayCreateError, type ReplayObject, type ReplayStore } from "../../src/replays/store.ts";
import { createActivity, slotActivity, type Activity } from "../../src/slots/activity.ts";

const ID = "2026-10-21T10-00-00-000Z-244";
const CODE = "b".repeat(40);
const inputs: MatchInputs = { id: ID, endedAt: Date.parse("2026-10-21T10:01:00.250Z"), lobbyId: null, logLines: ["{\"header\":1}", "{\"tick\":0}"], binary: new Uint8Array([9, 8, 7]) };

/** Create-only store; each queued fault is thrown by one create attempt, in order. */
function store(faults: unknown[] = []) {
  const objects = new Map<string, ReplayObject>();
  let attempts = 0;
  const s: ReplayStore = {
    async create(object) {
      attempts += 1;
      const fault = faults.shift();
      if (fault !== undefined) throw fault;
      if (objects.has(object.name)) throw new ReplayCreateError(412);
      objects.set(object.name, object);
    },
  };
  return { store: s, objects, attempts: () => attempts };
}

describe("record handoff", () => {
  it("writes the match's id, binary, log, code version and observed end create-only as <id>.input", async () => {
    const s = store(), logs: string[] = [];
    createRecordHandoff({ store: s.store, codeVersion: CODE, log: line => logs.push(line) }).submit(inputs);
    await vi.waitFor(() => expect(s.objects.size).toBe(1));
    const object = s.objects.get(`${ID}.input`)!;
    expect(object).toMatchObject({ contentType: "application/octet-stream", ifGenerationMatch: 0 });
    expect(decodeInput(object.body)).toEqual({ ...inputs, codeVersion: CODE });
    expect(logs).toEqual([]);
  });

  it("returns before the write finishes, logs each actual error with the match and retries until stored", async () => {
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const s = store([new ReplayCreateError(503), new Error("socket hang up")]);
    const gated: ReplayStore = { create: async object => { await slow; return s.store.create(object); } };
    const logs: string[] = [];
    createRecordHandoff({ store: gated, codeVersion: CODE, log: line => logs.push(line), delays: [1, 2] }).submit(inputs);
    // Play continues: submit has returned while the first write is still in flight.
    expect(s.attempts()).toBe(0);
    release();
    await vi.waitFor(() => expect(s.objects.has(`${ID}.input`)).toBe(true));
    expect(s.attempts()).toBe(3);
    expect(logs).toEqual([
      `antwar record ${ID} input store failed (attempt 1), retrying in 1 ms: replay create failed: HTTP 503`,
      `antwar record ${ID} input store failed (attempt 2), retrying in 2 ms: socket hang up`,
    ]);
    expect(decodeInput(s.objects.get(`${ID}.input`)!.body)).toEqual({ ...inputs, codeVersion: CODE });
  });

  it("treats an input already present after an ambiguous failure as stored, without overwriting it", async () => {
    const s = store();
    s.objects.set(`${ID}.input`, { name: `${ID}.input`, body: new Uint8Array([1]), contentType: "application/octet-stream", ifGenerationMatch: 0 });
    const logs: string[] = [];
    createRecordHandoff({ store: s.store, codeVersion: CODE, log: line => logs.push(line), delays: [1] }).submit(inputs);
    await vi.waitFor(() => expect(s.attempts()).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.attempts()).toBe(1);
    expect(s.objects.get(`${ID}.input`)!.body).toEqual(new Uint8Array([1]));
    expect(logs).toEqual([]);
  });

  it("logs an input it cannot encode and writes nothing", () => {
    const s = store(), logs: string[] = [];
    createRecordHandoff({ store: s.store, codeVersion: CODE, log: line => logs.push(line) }).submit({ ...inputs, id: "not-a-replay-id" });
    expect(s.attempts()).toBe(0);
    expect(logs).toEqual(["antwar record not-a-replay-id input not handed off: invalid replay id"]);
  });

  it("backs off to a repeating one-minute retry", () => {
    expect(RETRY_DELAYS_MS.at(-1)).toBe(60_000);
  });
});

/** Settles once the activity is idle; `settled()` reads it without waiting. */
function idleWatch(activity: Activity) {
  let done = false;
  void activity.whenIdle().then(() => { done = true; });
  return { settled: async () => { await new Promise(resolve => setTimeout(resolve, 0)); return done; } };
}

describe("record handoff keeps the match server from idling", () => {
  it("holds the activity from submit while the write is in flight and after failures, until storage accepts it", async () => {
    // Each gate holds one attempt open: the first write, then the third, after two failures.
    const gates: (() => void)[] = [];
    const s = store([new ReplayCreateError(503), new Error("socket hang up")]);
    const gated: ReplayStore = {
      create: async object => {
        if (s.attempts() !== 1) await new Promise<void>(resolve => gates.push(resolve));
        return s.store.create(object);
      },
    };
    const activity = createActivity();
    createRecordHandoff({ store: gated, codeVersion: CODE, log: () => {}, delays: [1, 2], activity }).submit(inputs);
    // Pending from the moment submit returns, before the first write settles.
    expect(activity.idle).toBe(false);
    const idle = idleWatch(activity);
    expect(await idle.settled()).toBe(false);
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // Two failed attempts: the bytes wait in memory for the third and the server is still busy.
    expect(s.attempts()).toBe(2);
    expect(activity.idle).toBe(false);
    expect(await idle.settled()).toBe(false);
    gates.shift()!();
    await vi.waitFor(() => expect(s.objects.has(`${ID}.input`)).toBe(true));
    expect(await idle.settled()).toBe(true);
    expect(activity.idle).toBe(true);
    expect(s.attempts()).toBe(3);
  });

  it("stays held across a failed attempt until storage reports the input already present", async () => {
    const s = store([new ReplayCreateError(503)]);
    s.objects.set(`${ID}.input`, { name: `${ID}.input`, body: new Uint8Array([1]), contentType: "application/octet-stream", ifGenerationMatch: 0 });
    let retry!: () => void;
    const retried = new Promise<void>(resolve => { retry = resolve; });
    const gated: ReplayStore = { create: async object => { if (s.attempts() === 1) await retried; return s.store.create(object); } };
    const activity = createActivity();
    createRecordHandoff({ store: gated, codeVersion: CODE, log: () => {}, delays: [1], activity }).submit(inputs);
    await vi.waitFor(() => expect(s.attempts()).toBe(1));
    const idle = idleWatch(activity);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(activity.idle).toBe(false);
    expect(await idle.settled()).toBe(false);
    retry();
    await vi.waitFor(() => expect(s.attempts()).toBe(2));
    expect(await idle.settled()).toBe(true);
    expect(activity.idle).toBe(true);
    expect(s.objects.get(`${ID}.input`)!.body).toEqual(new Uint8Array([1]));
  });

  it("holds once per submission, so the server is idle only when every match's inputs are stored", async () => {
    const gates = new Map<string, () => void>();
    const s = store();
    const gated: ReplayStore = { create: async object => { await new Promise<void>(resolve => gates.set(object.name, resolve)); return s.store.create(object); } };
    const activity = createActivity();
    const handoff = createRecordHandoff({ store: gated, codeVersion: CODE, log: () => {}, activity });
    const second = "2026-10-21T10-05-00-000Z-245";
    handoff.submit(inputs);
    handoff.submit({ ...inputs, id: second });
    await vi.waitFor(() => expect(gates.size).toBe(2));
    gates.get(`${ID}.input`)!();
    await vi.waitFor(() => expect(s.objects.has(`${ID}.input`)).toBe(true));
    expect(activity.idle).toBe(false);
    gates.get(`${second}.input`)!();
    await vi.waitFor(() => expect(activity.idle).toBe(true));
    expect(s.objects.size).toBe(2);
  });

  it("takes no hold for an input it cannot encode, since nothing is pending", async () => {
    const s = store(), activity = createActivity();
    createRecordHandoff({ store: s.store, codeVersion: CODE, log: () => {}, activity }).submit({ ...inputs, id: "not-a-replay-id" });
    expect(activity.idle).toBe(true);
    expect(await idleWatch(activity).settled()).toBe(true);
    expect(s.attempts()).toBe(0);
  });

  it("from configuration, holds the slot's activity until GCS accepts the input or answers 412, and holds nothing unconfigured", async () => {
    const activity = slotActivity("public-1");
    expect(recordHandoffFromEnv({}, async () => { throw new Error("no request"); }, activity)).toBeUndefined();
    expect(activity.idle).toBe(true);
    for (const status of [200, 412]) {
      let answer!: () => void;
      const answered = new Promise<void>(resolve => { answer = resolve; });
      const request: typeof fetch = async url => {
        if (String(url).startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "fake-input-token" });
        await answered;
        return new Response(null, { status });
      };
      recordHandoffFromEnv({ ANTWAR_RECORD_INPUT_BUCKET: "inputs", ANTWAR_CODE_VERSION: CODE }, request, activity)!.submit(inputs);
      expect(activity.idle).toBe(false);
      const idle = idleWatch(activity);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await idle.settled()).toBe(false);
      answer();
      await vi.waitFor(() => expect(activity.idle).toBe(true));
      expect(await idle.settled()).toBe(true);
    }
  });
});

describe("handoff configuration", () => {
  const request: typeof fetch = async () => { throw new Error("no request at start-up"); };
  it("is off without an input bucket and needs the full deployed commit with one", () => {
    expect(recordHandoffFromEnv({}, request)).toBeUndefined();
    expect(recordHandoffFromEnv({ ANTWAR_CODE_VERSION: CODE }, request)).toBeUndefined();
    for (const version of [undefined, "", "abc1234", "B".repeat(40)]) {
      expect(() => recordHandoffFromEnv({ ANTWAR_RECORD_INPUT_BUCKET: "inputs", ANTWAR_CODE_VERSION: version }, request))
        .toThrow("ANTWAR_RECORD_INPUT_BUCKET needs ANTWAR_CODE_VERSION, the full 40-character commit");
    }
    expect(recordHandoffFromEnv({ ANTWAR_RECORD_INPUT_BUCKET: "inputs", ANTWAR_CODE_VERSION: CODE }, request)).toBeDefined();
  });
});

describe("record handoff retry timing under a failing upload (characterization)", () => {
  it("attempts at once, then after 1, 5, 15, 30 s and every 60 s, logging each failure, and never reports a loss", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const at: number[] = [], logs: string[] = [];
      const failing: ReplayStore = { create: async () => { at.push(Date.now()); throw new ReplayCreateError(503); } };
      createRecordHandoff({ store: failing, codeVersion: CODE, log: line => logs.push(line) }).submit(inputs);
      await vi.advanceTimersByTimeAsync(171_000);
      expect(at).toEqual([0, 1_000, 6_000, 21_000, 51_000, 111_000, 171_000]);
      expect(logs).toEqual([1_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000].map((delay, i) =>
        `antwar record ${ID} input store failed (attempt ${i + 1}), retrying in ${delay} ms: replay create failed: HTTP 503`));
      // Still pending, so it keeps retrying on the one-minute repeat.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(at).toHaveLength(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("record handoff drain on the shutdown signal", () => {
  const notStored = (attempts: number, error: string) =>
    `antwar record ${ID} input not stored before shutdown after ${attempts} attempt(s), so its replay and public record will not appear: ${error}`;

  it("retries a waiting input at once, then every second, and resolves once it is stored, logging no loss", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const s = store([1, 2, 3, 4].map(() => new ReplayCreateError(503))), at: number[] = [], logs: string[] = [];
      const timed: ReplayStore = { create: async object => { at.push(Date.now()); return s.store.create(object); } };
      const handoff = createRecordHandoff({ store: timed, codeVersion: CODE, log: line => logs.push(line) });
      handoff.submit(inputs);
      // Three failures by 10 s; the next retry would wait until 21 s.
      await vi.advanceTimersByTimeAsync(10_000);
      let drained = false;
      void handoff.drain!(9_000).then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(at).toEqual([0, 1_000, 6_000, 10_000, 11_000]);
      expect(s.objects.has(`${ID}.input`)).toBe(true);
      expect(drained).toBe(true);
      expect(logs.at(-1)).toBe(`antwar record ${ID} input store failed (attempt 4), retrying in 1000 ms: replay create failed: HTTP 503`);
      expect(logs.some(line => line.includes("not stored before shutdown"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("at the end of its time logs each input still unstored by match id, with its attempts and last error", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const at: number[] = [], logs: string[] = [];
      const failing: ReplayStore = { create: async () => { at.push(Date.now()); throw new ReplayCreateError(503); } };
      const handoff = createRecordHandoff({ store: failing, codeVersion: CODE, log: line => logs.push(line) });
      handoff.submit(inputs);
      await vi.advanceTimersByTimeAsync(10_000);
      let drained = false;
      void handoff.drain!(2_500).then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(2_499);
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(true);
      expect(at).toEqual([0, 1_000, 6_000, 10_000, 11_000, 12_000]);
      expect(logs.at(-1)).toBe(notStored(6, "replay create failed: HTTP 503"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs an input whose first write never finished", async () => {
    const logs: string[] = [];
    const hanging: ReplayStore = { create: () => new Promise(() => {}) };
    const handoff = createRecordHandoff({ store: hanging, codeVersion: CODE, log: line => logs.push(line) });
    handoff.submit(inputs);
    await handoff.drain!(20);
    expect(logs).toEqual([notStored(1, "its first write had not finished")]);
  });

  it("resolves at once with nothing pending", async () => {
    const s = store(), logs: string[] = [];
    const handoff = createRecordHandoff({ store: s.store, codeVersion: CODE, log: line => logs.push(line) });
    handoff.submit(inputs);
    await vi.waitFor(() => expect(s.objects.size).toBe(1));
    const started = Date.now();
    await handoff.drain!(5_000);
    expect(Date.now() - started).toBeLessThan(100);
    expect(logs).toEqual([]);
  });
});
