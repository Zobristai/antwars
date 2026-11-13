/// <reference types="node" />
// The post-mortem's bounded work (src/accounts/postMortemJobs.ts): the whole-container memory meter, re-run admission
// and the watchdog, the scan pool and the re-run queue. Figures are test figures, not production measurements.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, openSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admits, CHILD_ENV, CHILD_FLAGS, createJobs, forkRerunChild, JobsBusy, limitOf, MEMORY_POLICY, meminfoMeter, overLimit, RERUN_QUEUE, SAMPLE_MS,
  SCAN_CONCURRENCY, SCAN_QUEUE, STALL_MS, type RerunOutcome,
} from "../../src/accounts/postMortemJobs.ts";
import { scanRecord } from "../../src/accounts/postMortemRecord.ts";

const VERSION = "c".repeat(40);
/** Each attempt's record: a fresh small stream. */
const OPEN = async () => Readable.from([Buffer.from("{}")]);
const TMPFS_MAGIC = 0x01021994;
const children: ChildProcess[] = [];
afterEach(() => { vi.useRealTimers(); for (const child of children.splice(0)) child.kill("SIGKILL"); });

/** A stand-in child process: records what it is sent and killed with; the test answers or exits for it. */
function fakeChild() {
  const stdin = new PassThrough();
  stdin.resume();
  const child = Object.assign(new EventEmitter(), {
    stdin, killed: [] as string[], sent: [] as unknown[],
    kill(signal: string) { child.killed.push(signal); queueMicrotask(() => child.emit("exit", null, signal)); return true; },
    send(message: unknown, done?: (error: Error | null) => void) { child.sent.push(message); done?.(null); return true; },
  });
  return child;
}

describe("memory policy", () => {
  it("admits a re-run at 550 MiB in use and refuses at 551, stops it above 1,850 and not at 1,850, under the 2 GiB limit", () => {
    const at = (usedMiB: number, totalMiB = 4096) => ({ usedMiB, totalMiB });
    expect(admits(at(550))).toBe(true);
    expect(admits(at(551))).toBe(false);
    expect(overLimit(at(1850))).toBe(false);
    expect(overLimit(at(1851))).toBe(true);
  });

  it("takes the smaller of 2 GiB and the memory the kernel reports", () => {
    expect(limitOf({ usedMiB: 0, totalMiB: 65536 })).toBe(2048);
    expect(limitOf({ usedMiB: 0, totalMiB: 1500 })).toBe(1500);
    expect(admits({ usedMiB: 3, totalMiB: 1500 })).toBe(false);
  });

  it("reads MemTotal less MemAvailable from meminfo, and nothing from an unreadable or malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "antwar-meminfo-"));
    try {
      writeFileSync(join(dir, "meminfo"), "MemTotal:        2097152 kB\nMemFree:          100 kB\nMemAvailable:    1572864 kB\nShmem:  10 kB\n");
      expect(meminfoMeter(join(dir, "meminfo"))()).toEqual({ usedMiB: 512, totalMiB: 2048 });
      writeFileSync(join(dir, "meminfo"), "MemTotal:        2097152 kB\n");
      expect(meminfoMeter(join(dir, "meminfo"))()).toBeNull();
      expect(meminfoMeter(join(dir, "missing"))()).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the real meter counts the whole container", () => {
  const meter = meminfoMeter();
  const used = () => { const reading = meter(); expect(reading).not.toBeNull(); return reading!.usedMiB; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));

  // Credible regression: a meter summing only this server's and the child's memory misses another process.
  it("rises with a separate 300 MiB process and falls when it exits", async () => {
    const rises: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = used();
      const ballast = spawn(process.execPath, ["-e", "const b = Buffer.alloc(300 * 2 ** 20, 1); process.stdout.write('ready'); setInterval(() => b[0]++, 1000);"],
        { stdio: ["ignore", "pipe", "ignore"] });
      children.push(ballast);
      await new Promise(resolve => ballast.stdout!.once("data", resolve));
      await settle();
      rises.push(used() - before);
      ballast.kill("SIGKILL");
      await new Promise(resolve => ballast.once("exit", resolve));
      await settle();
    }
    expect(rises.sort((a, b) => a - b)[1]).toBeGreaterThanOrEqual(250);
  }, 60_000);

  // Credible regression: a meter of process memory misses a file held in memory.
  it("rises with a 200 MiB file in an in-memory filesystem and falls when it is deleted", async () => {
    const dir = ["/dev/shm", tmpdir()].find(candidate => {
      try {
        if (statfsSync(candidate).type !== TMPFS_MAGIC) return false;
        writeFileSync(join(candidate, `antwar-meter-probe-${process.pid}`), "");
        rmSync(join(candidate, `antwar-meter-probe-${process.pid}`));
        return true;
      } catch { return false; }
    });
    expect(dir, "a writable tmpfs directory").toBeDefined();
    const file = join(dir!, `antwar-meter-${process.pid}`);
    try {
      const before = used();
      writeFileSync(file, Buffer.alloc(200 * 2 ** 20, 7));
      await settle();
      expect(used() - before).toBeGreaterThanOrEqual(180);
      rmSync(file);
      await settle();
      expect(used() - before).toBeLessThan(100);
    } finally { rmSync(file, { force: true }); }
  }, 60_000);

  it("stops a running child when another process pushes the container past the limit", async () => {
    const baseline = used();
    // Injected limits: room for nothing but this baseline and 200 MiB more.
    const policy = { limitMiB: Math.ceil(baseline) + 200, childReserveMiB: 0, scanReserveMiB: 0, headroomMiB: 0 };
    const run = createJobs({ policy, log: () => {}, meter, forkChild: () => {
        const child = spawn(process.execPath, ["-e", "process.on('message', () => {}); setInterval(() => process.send({ kind: 'progress', tick: 0 }), 100);"],
          { stdio: ["pipe", "ignore", "ignore", "ipc"] });
        children.push(child);
        return child;
      } });
    const outcome = run.rerun("match-a", VERSION, OPEN).outcome!;
    await new Promise(resolve => setTimeout(resolve, 300));
    const ballast = spawn(process.execPath, ["-e", "const b = Buffer.alloc(400 * 2 ** 20, 1); setInterval(() => b[0]++, 1000);"], { stdio: "ignore" });
    children.push(ballast);
    expect(await outcome).toEqual({ kind: "stopped", cause: "memory" });
  }, 60_000);
});

describe("re-run supervision", () => {
  const reading = (usedMiB: number) => ({ usedMiB, totalMiB: 4096 });

  it("refuses at once, starting no child, when memory leaves no room", async () => {
    const forkChild = vi.fn();
    const lines: string[] = [];
    const jobs = createJobs({ meter: () => reading(551), forkChild, log: line => lines.push(line) });
    expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "admission" });
    expect(forkChild).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("551 MiB of 2048 MiB");
  });

  it("samples every 50 ms and stops the child on the first sample above the limit", async () => {
    vi.useFakeTimers();
    let used = 500;
    const child = fakeChild();
    const jobs = createJobs({ meter: () => reading(used), forkChild: () => child as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    used = 1850;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 4);
    expect(child.killed).toEqual([]);
    used = 1851;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS - 1);
    expect(child.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toEqual(["SIGKILL"]);
    expect(await outcome).toEqual({ kind: "stopped", cause: "memory" });
  });

  it("stops the child when the meter becomes unreadable, and refuses to start without one", async () => {
    vi.useFakeTimers();
    let readable = true;
    const child = fakeChild();
    const jobs = createJobs({ meter: () => readable ? reading(100) : null, forkChild: () => child as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    readable = false;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(await outcome).toEqual({ kind: "stopped", cause: "meter" });
    expect(await jobs.rerun("n", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "meter" });
  });

  it("stops a child that reports no progress, and reports a crash and a heap-limit abort", async () => {
    vi.useFakeTimers();
    const stalled = fakeChild();
    const jobs = createJobs({ meter: () => reading(100), forkChild: () => stalled as unknown as ChildProcess, log: () => {}, stallMs: 1000 });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    await vi.advanceTimersByTimeAsync(900);
    stalled.emit("message", { kind: "progress", tick: 100 });
    await vi.advanceTimersByTimeAsync(900);
    expect(stalled.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toEqual({ kind: "stopped", cause: "stalled" });
    for (const [signal, cause] of [[null, "crashed"], ["SIGABRT", "memory"]] as const) {
      const child = fakeChild();
      const crashing = createJobs({ meter: () => reading(100), forkChild: () => child as unknown as ChildProcess, log: () => {} });
      const result = crashing.rerun("m", VERSION, OPEN).outcome!;
      child.emit("exit", signal === null ? 1 : null, signal);
      expect(await result).toEqual({ kind: "stopped", cause });
    }
  });

  // Credible regression: a retry reusing the first attempt's consumed stream, or a job holding the record itself.
  it("takes an engine error as the answer only when a fresh child repeats it, each attempt opening the record afresh", async () => {
    for (const [second, expected] of [["boom", { kind: "engine_error" }], ["other", { kind: "stopped", cause: "crashed" }]] as const) {
      const messages = ["boom", second];
      const opened: Readable[] = [];
      const open = vi.fn(async () => { const stream = Readable.from([Buffer.from("record")]); opened.push(stream); return stream; });
      const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => {
        const child = fakeChild();
        const message = messages.shift()!;
        setTimeout(() => { child.emit("message", { kind: "threw", message }); child.emit("exit", 0, null); }, 20);
        return child as unknown as ChildProcess;
      } });
      const queued = jobs.rerun("m", VERSION, open);
      expect(await queued.outcome).toEqual(expected);
      expect(open).toHaveBeenCalledTimes(2);
      expect(new Set(opened).size).toBe(2);
    }
  });

  it("opens no record for a job until it starts", async () => {
    const live: ReturnType<typeof fakeChild>[] = [];
    const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => { const child = fakeChild(); live.push(child); return child as unknown as ChildProcess; } });
    const first = vi.fn(OPEN), second = vi.fn(OPEN);
    jobs.rerun("a", VERSION, first);
    jobs.rerun("b", VERSION, second);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).not.toHaveBeenCalled();
    expect(live[0]!.sent).toEqual([{ version: VERSION }]);
    live[0]!.emit("message", { kind: "mismatch", tick: 1 });
    live[0]!.emit("exit", 0, null);
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  });

  // Credible regression: streaming with .pipe, whose EPIPE when the child exits mid-stream is unhandled and ends this server.
  it("survives a child that exits mid-stream: the attempt fails as try later and the record stream is destroyed", async () => {
    let source: Readable | null = null;
    const open = async () => {
      // 256 MiB, produced lazily: far more than the pipe holds.
      let left = 4096;
      source = new Readable({ read() { this.push(left-- > 0 ? Buffer.alloc(64 * 1024, 120) : null); } });
      return source;
    };
    const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => {
      // Reads one chunk, then exits without answering.
      const child = spawn(process.execPath, ["-e", "process.on('message', () => {}); process.stdin.once('data', () => process.exit(3));"],
        { stdio: ["pipe", "ignore", "ignore", "ipc"] });
      children.push(child);
      return child;
    } });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await jobs.rerun(`m${attempt}`, VERSION, open).outcome).toEqual({ kind: "stopped", cause: "crashed" });
      await vi.waitFor(() => expect(source!.destroyed).toBe(true));
    }
  }, 60_000);

  it("maps a reproduced re-run to its findings and a mismatch to not reproduced", async () => {
    for (const [answer, expected] of [
      [{ kind: "done", tested: 3, findings: [{ seat: 0, index: 2, tick: 2, type: "set_brood" }], undecided: [[0, 1]] },
        { kind: "findings", tested: 3, findings: [{ seat: 0, index: 2, tick: 2, type: "set_brood" }], undecided: [[0, 1]] }],
      [{ kind: "mismatch", tick: 7 }, { kind: "not_reproduced" }],
      [{ kind: "no_idle_data" }, { kind: "no_idle_data" }],
      [{ kind: "changed" }, { kind: "stopped", cause: "crashed" }],
    ] as const) {
      const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => {
        const child = fakeChild();
        queueMicrotask(() => { child.emit("message", answer); child.emit("exit", 0, null); });
        return child as unknown as ChildProcess;
      } });
      expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual(expected as RerunOutcome);
    }
  });

  it("runs one child at a time, queues 8 matches, joins a repeat and answers busy past the queue", async () => {
    const live: ReturnType<typeof fakeChild>[] = [];
    const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => { const child = fakeChild(); live.push(child); return child as unknown as ChildProcess; } });
    expect(jobs.rerun("m0", VERSION, OPEN).state).toBe("running");
    for (let i = 1; i <= RERUN_QUEUE; i++) expect(jobs.rerun(`m${i}`, VERSION, OPEN).state).toBe("queued");
    expect(jobs.rerun("m3", VERSION, OPEN).state).toBe("queued");
    expect(jobs.rerun("m0", VERSION, OPEN).state).toBe("running");
    expect(jobs.rerun("extra", VERSION, OPEN)).toEqual({ state: "busy" });
    expect(live).toHaveLength(1);
    live[0]!.emit("message", { kind: "mismatch", tick: 1 });
    live[0]!.emit("exit", 0, null);
    await vi.waitFor(() => expect(live).toHaveLength(2));
    expect(jobs.pending("m0")).toBeUndefined();
    expect(jobs.pending("m1")).toBeDefined();
  });

  it("runs two scans at a time, queues 16 and refuses the next at once", async () => {
    const jobs = createJobs({ meter: () => reading(100), log: () => {} });
    const gates: (() => void)[] = [];
    let running = 0, peak = 0;
    const work = () => jobs.scan(() => new Promise<void>(resolve => { running++; peak = Math.max(peak, running); gates.push(() => { running--; resolve(); }); }));
    const all = Array.from({ length: SCAN_CONCURRENCY + SCAN_QUEUE }, work);
    await expect(work()).rejects.toBeInstanceOf(JobsBusy);
    for (let released = 0; released < all.length; released++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
    }
    await Promise.all(all);
    expect(peak).toBe(SCAN_CONCURRENCY);
  });
});

// Credible regression: handing the child this server's environment (its keys and configuration) with the record.
it("forks the re-run child with an environment of its own flag alone", async () => {
  process.env.ANTWAR_POST_MORTEM_SENTINEL = "must-not-reach-the-child";
  try {
    const child = forkRerunChild();
    children.push(child);
    const environ = readFileSync(`/proc/${child.pid}/environ`, "utf8").split("\0").filter(Boolean);
    expect(environ.join("\n")).not.toContain("must-not-reach-the-child");
    // Node adds its own IPC channel wiring; nothing else is there.
    expect(environ.filter(entry => !entry.startsWith("NODE_CHANNEL_"))).toEqual(Object.entries(CHILD_ENV).map(([k, v]) => `${k}=${v}`));
  } finally { delete process.env.ANTWAR_POST_MORTEM_SENTINEL; }
});

/**
 * The worst-case record (tests: 367 MiB): 8 seats x 7,200 commands at the element cap's tail, 57,600 call events,
 * 1,250 events at the element cap, 115,200 refused replies and stubs, 8 MiB of other members. Written by its own
 * process to stdout, so a reader never holds it; the generator's memory is counted, not subtracted.
 */
const WORST_GENERATOR = `
const SEATS = 8, CALLS = 7200, ENTRY = 512, EVENTS = 1250;
const pad = n => "p".repeat(Math.max(0, n));
const out = process.stdout;
const w = s => new Promise(r => out.write(s) ? r() : out.once("drain", r));
(async () => {
  const proto = { tick: 0, type: "order", accepted: false, request: { type: "order", order: { kind: "go_to", tileX: 199, tileY: 59 }, intent: pad(80) }, error: { code: "rate_limited", message: "" } };
  const msgLen = ENTRY - JSON.stringify(proto).length - 6;
  await w('{"id":"x","pad":"' + pad(8 * 1024 * 1024 - 512 * 1024) + '","rules":{"config":{"ticksPerSecond":10}},"result":{"winner":1,"reason":"time_up","tick":35999},"seats":[');
  for (let s = 0; s < SEATS; s++) {
    await w((s ? "," : "") + '{"seat":' + s + ',"colony":' + (s % 2) + ',"handle":"h' + s + '","joinedTick":0,"commands":[');
    let parts = [];
    for (let i = 0; i < CALLS; i++) {
      parts.push(JSON.stringify({ tick: i * 5, type: "order", accepted: i % 2 === 0, request: { type: "order", order: { kind: "go_to", tileX: i % 200, tileY: i % 60 }, intent: pad(80) }, error: i % 2 ? { code: "rate_limited", message: pad(msgLen) } : null }));
      if (parts.length === 200) { await w((i >= 200 ? "," : "") + parts.join(",")); parts = []; }
    }
    if (parts.length) await w("," + parts.join(","));
    await w("]}");
  }
  await w('],"events":[');
  let buf = [];
  for (let i = 0; i < CALLS * SEATS; i++) { buf.push(JSON.stringify({ tick: Math.floor(i / SEATS) * 5, event: { kind: "call", agent: i % SEATS, call: "order", accepted: true, houseActivityTick: Math.floor(i / SEATS) * 5 } })); if (buf.length === 2000) { await w((i >= 2000 ? "," : "") + buf.join(",")); buf = []; } }
  if (buf.length) await w("," + buf.join(","));
  for (let i = 0; i < EVENTS; i++) await w("," + JSON.stringify({ tick: i * 28, event: { kind: "fight", z: { b: 1, a: [i, i + 1] }, text: "y".repeat(256 * 1024 - 200) } }));
  await w('],"rerun":{"seed":1,"stops":[],"abandonments":[],"idle":[],"houseActive":[]},"codeVersion":"' + "c".repeat(40) + '","replies":[');
  buf = [];
  for (let i = 0; i < 2 * CALLS * SEATS; i++) {
    const seat = i % SEATS;
    buf.push(JSON.stringify(i % 2 ? { type: "stub", seat, tick: i >> 4, tool: "observe", receivedAt: 1e12 + i, answeredAt: 1e12 + i + 1, code: "call_rate" }
      : { type: "reply", seat, tick: i >> 4, tool: "order", receivedAt: 1e12 + i, answeredAt: 1e12 + i + 1, isError: true, arguments: { since: i }, reply: { error: { code: "rate_limited", message: "One command per 10 s." } } }));
    if (buf.length === 2000) { await w((i >= 2000 ? "," : "") + buf.join(",")); buf = []; }
  }
  if (buf.length) await w("," + buf.join(","));
  await w("]}");
})();`;

// Credible regression: a scan or child that buffers the record, or reserves that no longer cover what admission assumes.
it("two worst-case refused-call scans and the re-run child scanning a third stay within the scan and child reserves, whole container", async () => {
  const meter = meminfoMeter();
  const used = () => meter()!.usedMiB;
  const generate = () => {
    const gen = spawn(process.execPath, ["-e", WORST_GENERATOR], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(gen);
    return gen.stdout!;
  };
  await new Promise(resolve => setTimeout(resolve, 500));
  const base = used();
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, used() - base); }, SAMPLE_MS);
  try {
    // Admission is not under test here (post-mortem-jobs memory policy tests are): this machine's baseline may exceed 550 MiB.
    const jobs = createJobs({ log: () => {}, meter, stallMs: 600_000, policy: { ...MEMORY_POLICY, limitMiB: 1_000_000 } });
    const rerun = jobs.rerun("worst", VERSION, async () => generate()).outcome!;
    const scans = await Promise.all([0, 1].map(() => jobs.scan(() => scanRecord(generate()))));
    for (const scan of scans) expect(scan.refusals).toHaveLength(2 * 7200 * 8);
    // The child scans every event into its blocks, then finds no idle clock to re-run under.
    expect(await rerun).toEqual({ kind: "no_idle_data" });
  } finally { clearInterval(sampler); }
  if (process.env.ANTWAR_REPORT_PEAK) console.log(`whole-container peak rise ${Math.round(peak)} MiB`);
  expect(peak).toBeLessThanOrEqual(MEMORY_POLICY.scanReserveMiB + MEMORY_POLICY.childReserveMiB);
}, 300_000);

// Credible regression: removing or raising the child's heap flag breaks the reserve admission assumes.
it("a heap flood under the child's flags dies at the V8 limit within the child reserve", async () => {
  const flood = spawn(process.execPath, [...CHILD_FLAGS, "-e", "const keep = []; for (;;) keep.push(new Array(1e5).fill({ x: Math.random() }));"],
    { stdio: "ignore" });
  children.push(flood);
  let peak = 0;
  const sampler = setInterval(() => {
    try {
      const kb = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${flood.pid}/status`, "utf8"));
      if (kb) peak = Math.max(peak, Number(kb[1]) / 1024);
    } catch { /* exited */ }
  }, 2);
  const [code, signal] = await new Promise<[number | null, string | null]>(resolve => flood.once("exit", (c, s) => resolve([c, s])));
  clearInterval(sampler);
  expect({ code, signal }).toEqual({ code: null, signal: "SIGABRT" });
  expect(peak).toBeGreaterThan(500);
  expect(peak).toBeLessThanOrEqual(MEMORY_POLICY.childReserveMiB);
}, 120_000);

// Credible regression: a scan that buffers the record, or a scan reserve below what two concurrent scans use. Only the
// scans are charged: the fixture is written by its own process, which exits first (the storage it leaves is logged
// apart), and the base is read inside the scanning process after its imports have loaded, under the entry server's
// flag, so neither node's start nor the fixture counts against the reserve.
it("two concurrent worst-case refused-call scans stay within the scan reserve, whole container", async () => {
  const meter = meminfoMeter();
  const used = () => meter()!.usedMiB;
  const dir = mkdtempSync(join(tmpdir(), "antwar-pm-scans-"));
  const fixture = join(dir, "worst.json");
  try {
    const before = used();
    await new Promise<void>((resolve, reject) => {
      const gen = spawn(process.execPath, ["-e", WORST_GENERATOR], { stdio: ["ignore", openSync(fixture, "w"), "inherit"] });
      children.push(gen);
      gen.once("exit", code => code === 0 ? resolve() : reject(new Error(`generator exited ${code}`)));
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const fixtureMiB = used() - before;
    const root = new URL("../..", import.meta.url);
    const script = `
      const { createReadStream } = await import("node:fs");
      const { scanRecord } = await import(${JSON.stringify(new URL("src/accounts/postMortemRecord.ts", root).href)});
      const { meminfoMeter, SAMPLE_MS } = await import(${JSON.stringify(new URL("src/accounts/postMortemJobs.ts", root).href)});
      const meter = meminfoMeter(), used = () => meter().usedMiB;
      await new Promise(resolve => setTimeout(resolve, 1000));
      const base = used();
      let peak = 0;
      const sampler = setInterval(() => { peak = Math.max(peak, used() - base); }, SAMPLE_MS);
      const scans = await Promise.all([0, 1].map(() => scanRecord(createReadStream(${JSON.stringify(fixture)}, { highWaterMark: 64 * 1024 }))));
      clearInterval(sampler);
      peak = Math.max(peak, used() - base);
      process.stdout.write(JSON.stringify({ peak, refusals: scans.map(scan => scan.refusals.length) }));`;
    const scanner = spawn(process.execPath, ["--max-semi-space-size=8", "--import", new URL("src/ts-resolve.mjs", root).href, "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "inherit"] });
    children.push(scanner);
    let out = "";
    scanner.stdout!.on("data", chunk => { out += chunk; });
    const code = await new Promise(resolve => scanner.once("exit", resolve));
    expect(code).toBe(0);
    const { peak, refusals } = JSON.parse(out) as { peak: number; refusals: number[] };
    if (process.env.ANTWAR_REPORT_PEAK) console.log(`two scans: peak rise ${Math.round(peak)} MiB over the scanning process's own base; fixture storage ${Math.round(fixtureMiB)} MiB, not charged`);
    expect(refusals).toEqual([2 * 7200 * 8, 2 * 7200 * 8]);
    expect(peak).toBeLessThanOrEqual(MEMORY_POLICY.scanReserveMiB);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

describe("stall detection at the default limit", () => {
  const reading = (usedMiB: number) => ({ usedMiB, totalMiB: 4096 });
  // Credible regression: a child reading a long record killed as stalled because it reports progress only once re-running.
  it("keeps a child that reports scan progress past STALL_MS, and stops one silent for longer than STALL_MS", async () => {
    vi.useFakeTimers();
    const scanning = fakeChild();
    const jobs = createJobs({ meter: () => reading(100), forkChild: () => scanning as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("slow", VERSION, OPEN).outcome!;
    for (let elapsed = 0; elapsed < 5 * STALL_MS; elapsed += STALL_MS / 2) {
      await vi.advanceTimersByTimeAsync(STALL_MS / 2);
      scanning.emit("message", { kind: "progress", tick: null });
    }
    expect(scanning.killed).toEqual([]);
    scanning.emit("message", { kind: "done", tested: 0, findings: [], undecided: [] });
    scanning.emit("exit", 0, null);
    expect(await outcome).toEqual({ kind: "findings", tested: 0, findings: [], undecided: [] });
    const silent = fakeChild();
    const stuck = createJobs({ meter: () => reading(100), forkChild: () => silent as unknown as ChildProcess, log: () => {} });
    const stopped = stuck.rerun("stuck", VERSION, OPEN).outcome!;
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(silent.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);
    expect(await stopped).toEqual({ kind: "stopped", cause: "stalled" });
  });
});
