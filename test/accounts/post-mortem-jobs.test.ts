/// <reference types="node" />
// The post-mortem's bounded work (src/accounts/postMortemJobs.ts): the whole-container memory meter, re-run admission
// and the watchdog, the scan pool and the re-run queue. Figures are test figures, not production measurements.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admits, CHILD_FLAGS, createJobs, JobsBusy, limitOf, MEMORY_POLICY, meminfoMeter, overLimit, RERUN_QUEUE, SAMPLE_MS, SCAN_CONCURRENCY, SCAN_QUEUE,
  type RerunOutcome,
} from "../../src/accounts/postMortemJobs.ts";
import type { ReducedRecord } from "../../src/accounts/postMortemRecord.ts";

const RECORD: ReducedRecord = { config: null, result: null, rerun: null, codeVersion: null, seats: [], calls: [] };
const TMPFS_MAGIC = 0x01021994;
const children: ChildProcess[] = [];
afterEach(() => { vi.useRealTimers(); for (const child of children.splice(0)) child.kill("SIGKILL"); });

/** A stand-in child process: records what it is sent and killed with; the test answers or exits for it. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    killed: [] as string[], sent: [] as unknown[],
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
          { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        children.push(child);
        return child;
      } });
    const outcome = run.rerun("match-a", RECORD).outcome!;
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
    expect(await jobs.rerun("m", RECORD).outcome).toEqual({ kind: "stopped", cause: "admission" });
    expect(forkChild).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("551 MiB of 2048 MiB");
  });

  it("samples every 50 ms and stops the child on the first sample above the limit", async () => {
    vi.useFakeTimers();
    let used = 500;
    const child = fakeChild();
    const jobs = createJobs({ meter: () => reading(used), forkChild: () => child as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("m", RECORD).outcome!;
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
    const outcome = jobs.rerun("m", RECORD).outcome!;
    readable = false;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(await outcome).toEqual({ kind: "stopped", cause: "meter" });
    expect(await jobs.rerun("n", RECORD).outcome).toEqual({ kind: "stopped", cause: "meter" });
  });

  it("stops a child that reports no progress, and reports a crash and a heap-limit abort", async () => {
    vi.useFakeTimers();
    const stalled = fakeChild();
    const jobs = createJobs({ meter: () => reading(100), forkChild: () => stalled as unknown as ChildProcess, log: () => {}, stallMs: 1000 });
    const outcome = jobs.rerun("m", RECORD).outcome!;
    await vi.advanceTimersByTimeAsync(900);
    stalled.emit("message", { kind: "progress", tick: 100 });
    await vi.advanceTimersByTimeAsync(900);
    expect(stalled.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toEqual({ kind: "stopped", cause: "stalled" });
    for (const [signal, cause] of [[null, "crashed"], ["SIGABRT", "memory"]] as const) {
      const child = fakeChild();
      const crashing = createJobs({ meter: () => reading(100), forkChild: () => child as unknown as ChildProcess, log: () => {} });
      const result = crashing.rerun("m", RECORD).outcome!;
      child.emit("exit", signal === null ? 1 : null, signal);
      expect(await result).toEqual({ kind: "stopped", cause });
    }
  });

  it("takes an engine error as the answer only when a fresh child repeats it exactly", async () => {
    for (const [second, expected] of [["boom", { kind: "engine_error" }], ["other", { kind: "stopped", cause: "crashed" }]] as const) {
      const messages = ["boom", second];
      const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => {
        const child = fakeChild();
        const message = messages.shift()!;
        queueMicrotask(() => { child.emit("message", { kind: "threw", message }); child.emit("exit", 0, null); });
        return child as unknown as ChildProcess;
      } });
      expect(await jobs.rerun("m", RECORD).outcome).toEqual(expected);
    }
  });

  it("maps a reproduced re-run to its findings and a mismatch to not reproduced", async () => {
    for (const [answer, expected] of [
      [{ kind: "done", tested: 3, findings: [{ seat: 0, index: 2, tick: 2, type: "set_brood" }] }, { kind: "findings", tested: 3, findings: [{ seat: 0, index: 2, tick: 2, type: "set_brood" }] }],
      [{ kind: "mismatch", tick: 7 }, { kind: "not_reproduced" }],
    ] as const) {
      const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => {
        const child = fakeChild();
        queueMicrotask(() => { child.emit("message", answer); child.emit("exit", 0, null); });
        return child as unknown as ChildProcess;
      } });
      expect(await jobs.rerun("m", RECORD).outcome).toEqual(expected as RerunOutcome);
    }
  });

  it("runs one child at a time, queues 8 matches, joins a repeat and answers busy past the queue", async () => {
    const live: ReturnType<typeof fakeChild>[] = [];
    const jobs = createJobs({ meter: () => reading(100), log: () => {}, forkChild: () => { const child = fakeChild(); live.push(child); return child as unknown as ChildProcess; } });
    expect(jobs.rerun("m0", RECORD).state).toBe("running");
    for (let i = 1; i <= RERUN_QUEUE; i++) expect(jobs.rerun(`m${i}`, RECORD).state).toBe("queued");
    expect(jobs.rerun("m3", RECORD).state).toBe("queued");
    expect(jobs.rerun("m0", RECORD).state).toBe("running");
    expect(jobs.rerun("extra", RECORD)).toEqual({ state: "busy" });
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
