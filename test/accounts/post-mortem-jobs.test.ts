/// <reference types="node" />
// The post-mortem's bounded work (src/accounts/postMortemJobs.ts): the control-group memory meter, re-run admission
// and the watchdog, the child's lifecycle, the scan pool and the re-run queue. Figures are test figures, not production
// measurements; the meter's fake control-group trees stand for shapes, not for any production host.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admits, cgroupMeter, CHILD_ENV, CHILD_FLAGS, createJobs, forkRerunChild, JobsBusy, MEMORY_POLICY, overLimit, ownCgroup, parseCgroupBytes,
  parseMemoryQuantity, RERUN_QUEUE, SAMPLE_MS, SCAN_CONCURRENCY, SCAN_QUEUE, STALL_MS, STDERR_TAIL_BYTES, type Meter, type RerunOutcome,
} from "../../src/accounts/postMortemJobs.ts";
import { packFindings } from "../../src/accounts/postMortemChild.ts";
import { scanRecord } from "../../src/accounts/postMortemRecord.ts";

const VERSION = "c".repeat(40);
const MIB = 2 ** 20;
/** Each attempt's record: a fresh small stream. */
const OPEN = async () => Readable.from([Buffer.from("{}")]);
const children: ChildProcess[] = [];
afterEach(() => { vi.useRealTimers(); for (const child of children.splice(0)) child.kill("SIGKILL"); });

/** A stand-in child process: records what it is sent and killed with; the test answers or exits for it. */
function fakeChild(options: { pid?: number | undefined; exitOnKill?: boolean } = {}) {
  const stdin = new PassThrough();
  stdin.resume();
  const child = Object.assign(new EventEmitter(), {
    stdin, stderr: new PassThrough(), killed: [] as string[], sent: [] as unknown[], pid: "pid" in options ? options.pid : 4242,
    kill(signal: string) { child.killed.push(signal); if (options.exitOnKill !== false) queueMicrotask(() => child.emit("exit", null, signal)); return true; },
    send(message: unknown, done?: (error: Error | null) => void) { child.sent.push(message); done?.(null); return true; },
  });
  // A real child's stderr ends once it has exited.
  child.on("exit", () => child.stderr.end());
  return child;
}
/** A meter reading of this much headroom. */
const reading = (headroomMiB: number) => ({ headroomMiB, source: "numeric" as const });
const ROOMY: Meter = () => reading(4096);
const quiet = { log: () => {} };

/** VmRSS of each live pid, summed, in MiB: the memory of the processes a test starts and owns. */
function rssMiB(pids: Iterable<number>): number {
  let kb = 0;
  for (const pid of pids) {
    try { const m = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8")); if (m) kb += Number(m[1]); } catch { /* exited */ }
  }
  return kb / 1024;
}

describe("memory policy", () => {
  it("admits a re-run at 1,498 MiB of headroom and refuses at 1,497, stops it below 198 MiB and not at 198", () => {
    expect(admits(reading(1498))).toBe(true);
    expect(admits(reading(1497))).toBe(false);
    expect(overLimit(reading(198))).toBe(false);
    expect(overLimit(reading(197))).toBe(true);
  });

  it("parses a memory quantity of whole Mi or Gi to safe bytes, and nothing else", () => {
    expect(parseMemoryQuantity("2Gi")).toBe(2048 * MIB);
    expect(parseMemoryQuantity("2048Mi")).toBe(2048 * MIB);
    for (const bad of [undefined, "", "2GB", "2G", "0Gi", "02Gi", "2.5Gi", " 2Gi", "2Gi\n", "-2Gi", "99999999Gi", "9999999Gi"]) {
      expect(parseMemoryQuantity(bad), String(bad)).toBeNull();
    }
    expect(parseCgroupBytes("1048576\n")).toBe(MIB);
    for (const bad of [null, "", "max\n", "1.5\n", "-1\n", "99999999999999999999\n", "12 34\n"]) expect(parseCgroupBytes(bad), String(bad)).toBeNull();
  });
});

/**
 * A fake cgroup2 tree: `levels` from the mount down to this process's own group, each with its memory.max (undefined:
 * no file) and memory.current (undefined: no file). The mount's root is levels[0].
 */
function cgroupTree(levels: { max?: string; current?: number }[], options: { mountRoot?: string; cgroupLine?: string; mountinfo?: (mount: string) => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antwar-cgroup-"));
  const mount = join(dir, "sys fs cgroup");
  let path = mount;
  const names: string[] = [];
  levels.forEach((level, i) => {
    if (i > 0) { names.push(`level${i}`); path = join(path, `level${i}`); }
    mkdirSync(path, { recursive: true });
    if (level.max !== undefined) writeFileSync(join(path, "memory.max"), level.max);
    if (level.current !== undefined) writeFileSync(join(path, "memory.current"), `${level.current * MIB}\n`);
  });
  const own = `/${names.join("/")}`;
  const escaped = mount.replace(/ /g, "\\040");
  writeFileSync(join(dir, "cgroup"), options.cgroupLine ?? `0::${own === "/" ? "/" : own}\n`);
  writeFileSync(join(dir, "mountinfo"), options.mountinfo?.(escaped)
    ?? `24 30 0:22 / /proc rw,nosuid shared:13 - proc proc rw\n36 25 0:30 ${options.mountRoot ?? "/"} ${escaped} rw,nosuid,nodev shared:10 master:2 - cgroup2 cgroup2 rw,nsdelegate\n`);
  return {
    meter: (configured?: string) => cgroupMeter({ cgroupFile: join(dir, "cgroup"), mountinfoFile: join(dir, "mountinfo"), configured }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("the control-group meter", () => {
  const read = (levels: Parameters<typeof cgroupTree>[0], configured?: string, options?: Parameters<typeof cgroupTree>[1]) => {
    const tree = cgroupTree(levels, options);
    try { return tree.meter(configured)(); } finally { tree.remove(); }
  };

  // Credible regression: taking the smallest limit, which ignores a nearly full parent.
  it("takes the smallest headroom across numeric levels, each less its own usage: 148 MiB refuses", () => {
    const r = read([{}, { max: `${4096 * MIB}\n`, current: 3948 }, { max: `${2048 * MIB}\n`, current: 500 }]);
    expect(r).toEqual({ headroomMiB: 148, source: "numeric" });
    expect(admits(r!)).toBe(false);
  });

  // Credible regression: the configured limit ignored once a numeric limit exists.
  it("caps a larger numeric limit with the configured one, less the own group's usage: 548 MiB refuses", () => {
    const r = read([{}, { max: `${4096 * MIB}\n`, current: 1500 }], "2Gi");
    expect(r).toEqual({ headroomMiB: 548, source: "both" });
    expect(admits(r!)).toBe(false);
  });

  it("admits under the configured limit alone where no level is numeric", () => {
    const r = read([{ current: 900 }, { max: "max\n", current: 100 }, { max: "max\n", current: 100 }], "2Gi");
    expect(r).toEqual({ headroomMiB: 1948, source: "configured" });
    expect(admits(r!)).toBe(true);
  });

  // Credible regression: the fallback reading the mount root's usage instead of this process's own group.
  it("reads the fallback's usage from the own group, not the mount root, both ways", () => {
    expect(read([{ current: 1900 }, { max: "max\n", current: 100 }], "2Gi")).toEqual({ headroomMiB: 1948, source: "configured" });
    expect(read([{ current: 100 }, { max: "max\n", current: 1900 }], "2Gi")).toEqual({ headroomMiB: 148, source: "configured" });
  });

  it("admits a private namespace whose own group is the mount root, with a numeric limit and low use", () => {
    const r = read([{ max: `${2048 * MIB}\n`, current: 200 }], undefined, { cgroupLine: "0::/\n" });
    expect(r).toEqual({ headroomMiB: 1848, source: "numeric" });
    expect(admits(r!)).toBe(true);
  });

  it("follows a mount whose root is the own group's ancestor", () => {
    expect(read([{ max: `${2048 * MIB}\n`, current: 200 }], undefined, { cgroupLine: "0::/outer\n", mountRoot: "/outer" })).toEqual({ headroomMiB: 1848, source: "numeric" });
  });

  // Credible regression: assuming a limit when none can be read.
  it("fails closed with no numeric level and no configured limit", () => {
    expect(read([{ current: 100 }, { max: "max\n", current: 100 }])).toBeNull();
  });

  it("fails closed on a garbled, zero or unsafe configured limit, even beside a numeric one", () => {
    for (const bad of ["2GB", "0Mi", "", "9999999Gi"]) expect(read([{}, { max: `${2048 * MIB}\n`, current: 100 }], bad), bad).toBeNull();
  });

  it("fails closed on a garbled or zero memory.max, one missing below the mount root, and unreadable or garbled usage", () => {
    expect(read([{}, { max: "lots\n", current: 100 }], "2Gi")).toBeNull();
    expect(read([{}, { max: "0\n", current: 100 }], "2Gi")).toBeNull();
    expect(read([{}, { current: 100 }, { max: "max\n", current: 100 }], "2Gi")).toBeNull();
    expect(read([{}, { max: `${2048 * MIB}\n` }])).toBeNull();
    expect(read([{}, { max: "max\n" }], "2Gi")).toBeNull();
    const tree = cgroupTree([{}, { max: `${2048 * MIB}\n`, current: 100 }]);
    try {
      expect(tree.meter()()).not.toBeNull();
    } finally { tree.remove(); }
  });

  // Credible regression: a group path that climbs out of the mount, read as if it were inside it.
  it("fails closed on a path escaping the mount, a path outside the mount's root, several cgroup2 mounts, or no cgroup2 line", () => {
    const numeric = [{}, { max: `${2048 * MIB}\n`, current: 100 }];
    expect(read(numeric, "2Gi", { cgroupLine: "0::/level1/../..\n" })).toBeNull();
    expect(read(numeric, "2Gi", { cgroupLine: "0::/level1/./x\n" })).toBeNull();
    expect(read(numeric, "2Gi", { cgroupLine: "0::/level1\n", mountRoot: "/elsewhere" })).toBeNull();
    expect(read(numeric, "2Gi", { cgroupLine: "4:memory:/level1\n" })).toBeNull();
    expect(read(numeric, "2Gi", { mountinfo: m => `36 25 0:30 / ${m} rw - cgroup2 cgroup2 rw\n37 25 0:31 / ${m}2 rw - cgroup2 cgroup2 rw\n` })).toBeNull();
  });

  it("finds the filesystem type after any number of optional mountinfo fields", () => {
    for (const optional of ["", " shared:1", " shared:1 master:2 propagate_from:3"]) {
      expect(ownCgroup("0::/a\n", `36 25 0:30 / /cg rw${optional} - cgroup2 cgroup2 rw\n`), optional).toEqual({ dir: "/cg/a", mount: "/cg" });
    }
    expect(ownCgroup("0::/a\n", "36 25 0:30 / /cg rw - cgroup cgroup rw,memory\n")).toBeNull();
  });
});

describe("the startup line", () => {
  it("names the limit's source and whether a re-run could start, or that no usable limit can be read", () => {
    const lines: string[] = [];
    createJobs({ meter: () => null, log: line => lines.push(line) });
    createJobs({ meter: () => ({ headroomMiB: 1600, source: "configured" }), log: line => lines.push(line) });
    createJobs({ meter: () => ({ headroomMiB: 300, source: "both" }), log: line => lines.push(line) });
    expect(lines).toEqual([
      "antwar post-mortem: no usable memory limit can be read; no-effect re-runs cannot start on this instance",
      "antwar post-mortem: memory limit from the configured limit; no-effect re-runs can start now",
      "antwar post-mortem: memory limit from the control group and the configured limit; no-effect re-runs cannot start now",
    ]);
  });
});

// Credible regression: a watchdog that stops sampling, or ignores memory another process takes.
it("stops a running child when another owned process pushes past the limit, measured over the test's own processes", async () => {
  const pids = new Set([process.pid]);
  const limit = Math.ceil(rssMiB(pids)) + 300;
  const meter: Meter = () => ({ headroomMiB: limit - rssMiB(pids), source: "numeric" });
  const run = createJobs({ ...quiet, policy: { childReserveMiB: 0, scanReserveMiB: 0, marginMiB: 0 }, meter, forkChild: () => {
      const child = spawn(process.execPath, ["-e", "process.on('message', () => {}); setInterval(() => process.send({ kind: 'progress', tick: 0 }), 100);"],
        { stdio: ["pipe", "ignore", "pipe", "ipc"] });
      children.push(child);
      pids.add(child.pid!);
      return child;
    } });
  const outcome = run.rerun("match-a", VERSION, OPEN).outcome!;
  await new Promise(resolve => setTimeout(resolve, 300));
  const ballast = spawn(process.execPath, ["-e", "const b = Buffer.alloc(500 * 2 ** 20, 1); setInterval(() => b[0]++, 1000);"], { stdio: "ignore" });
  children.push(ballast);
  pids.add(ballast.pid!);
  expect(await outcome).toEqual({ kind: "stopped", cause: "memory" });
}, 60_000);

describe("re-run supervision", () => {
  it("refuses at once, starting no child, when memory leaves no room", async () => {
    const forkChild = vi.fn();
    const lines: string[] = [];
    const jobs = createJobs({ meter: () => reading(1497), forkChild, log: line => lines.push(line) });
    expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "admission" });
    expect(forkChild).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("1497 MiB of headroom");
  });

  it("samples every 50 ms and stops the child on the first sample above the limit", async () => {
    vi.useFakeTimers();
    let headroom = 1548;
    const child = fakeChild();
    const jobs = createJobs({ meter: () => reading(headroom), forkChild: () => child as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    headroom = 198;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 4);
    expect(child.killed).toEqual([]);
    headroom = 197;
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
    const jobs = createJobs({ meter: () => readable ? reading(2000) : null, forkChild: () => child as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    readable = false;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(await outcome).toEqual({ kind: "stopped", cause: "meter" });
    expect(await jobs.rerun("n", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "meter" });
  });

  it("stops a child that reports no progress, and reports a crash and a bare abort as a failure", async () => {
    vi.useFakeTimers();
    const stalled = fakeChild();
    const jobs = createJobs({ meter: ROOMY, forkChild: () => stalled as unknown as ChildProcess, log: () => {}, stallMs: 1000 });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    await vi.advanceTimersByTimeAsync(900);
    stalled.emit("message", { kind: "progress", tick: 100 });
    await vi.advanceTimersByTimeAsync(900);
    expect(stalled.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toEqual({ kind: "stopped", cause: "stalled" });
    for (const [signal, cause] of [[null, "crashed"], ["SIGABRT", "crashed"]] as const) {
      const child = fakeChild();
      const crashing = createJobs({ meter: ROOMY, forkChild: () => child as unknown as ChildProcess, log: () => {} });
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
      const jobs = createJobs({ meter: ROOMY, log: () => {}, forkChild: () => {
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
    const jobs = createJobs({ meter: ROOMY, log: () => {}, forkChild: () => { const child = fakeChild(); live.push(child); return child as unknown as ChildProcess; } });
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
    const jobs = createJobs({ meter: ROOMY, log: () => {}, forkChild: () => {
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
      [{ kind: "done", tested: 3, counts: [[0, 3]], bits: new Uint8Array([4]), undecided: [[0, 1]] },
        { kind: "findings", tested: 3, counts: [[0, 3]], bits: new Uint8Array([4]), undecided: [[0, 1]] }],
      // A bitset not as long as its counts make it: nothing is settled now.
      [{ kind: "done", tested: 3, counts: [[0, 9]], bits: new Uint8Array([4]), undecided: [] }, { kind: "stopped", cause: "crashed" }],
      [{ kind: "allocation_failed" }, { kind: "stopped", cause: "memory" }],
      [{ kind: "mismatch", tick: 7 }, { kind: "not_reproduced" }],
      [{ kind: "no_idle_data" }, { kind: "no_idle_data" }],
      [{ kind: "changed" }, { kind: "stopped", cause: "crashed" }],
    ] as const) {
      const jobs = createJobs({ meter: ROOMY, log: () => {}, forkChild: () => {
        const child = fakeChild();
        queueMicrotask(() => { child.emit("message", answer); child.emit("exit", 0, null); });
        return child as unknown as ChildProcess;
      } });
      expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual(expected as RerunOutcome);
    }
  });

  it("runs one child at a time, queues 8 matches, joins a repeat and answers busy past the queue", async () => {
    const live: ReturnType<typeof fakeChild>[] = [];
    const jobs = createJobs({ meter: ROOMY, log: () => {}, forkChild: () => { const child = fakeChild(); live.push(child); return child as unknown as ChildProcess; } });
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
    const jobs = createJobs({ meter: ROOMY, log: () => {} });
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

// Credible regression: a scan or child that buffers the record. This proves the reserves cover two worst-case scans and
// the child's scan of a third, measured as the RSS of the processes this test starts and owns; the child ends at
// no_idle_data, so it does not prove a whole re-run's memory.
it("two worst-case refused-call scans and the re-run child scanning a third stay within the scan and child reserves", async () => {
  const pids = new Set([process.pid]);
  const generate = () => {
    const gen = spawn(process.execPath, ["-e", WORST_GENERATOR], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(gen);
    pids.add(gen.pid!);
    return gen.stdout!;
  };
  await new Promise(resolve => setTimeout(resolve, 500));
  const base = rssMiB(pids);
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, rssMiB(pids) - base); }, SAMPLE_MS);
  try {
    // Admission is not under test here (the memory policy and meter tests are).
    const jobs = createJobs({ ...quiet, meter: ROOMY, stallMs: 600_000, forkChild: () => { const child = forkRerunChild(); children.push(child); pids.add(child.pid!); return child; } });
    const rerun = jobs.rerun("worst", VERSION, async () => generate()).outcome!;
    const scans = await Promise.all([0, 1].map(() => jobs.scan(() => scanRecord(generate()))));
    for (const scan of scans) expect(scan.refusals).toHaveLength(2 * 7200 * 8);
    // The child scans every event into its blocks, then finds no idle clock to re-run under.
    expect(await rerun).toEqual({ kind: "no_idle_data" });
  } finally { clearInterval(sampler); }
  if (process.env.ANTWAR_REPORT_PEAK) console.log(`owned processes' peak rise ${Math.round(peak)} MiB`);
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
// scans are charged: the fixture is written by its own process, which exits first, and the base is the scanning
// process's own RSS after its imports have loaded, under the entry server's flag.
it("two concurrent worst-case refused-call scans stay within the scan reserve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antwar-pm-scans-"));
  const fixture = join(dir, "worst.json");
  try {
    await new Promise<void>((resolve, reject) => {
      const gen = spawn(process.execPath, ["-e", WORST_GENERATOR], { stdio: ["ignore", openSync(fixture, "w"), "inherit"] });
      children.push(gen);
      gen.once("exit", code => code === 0 ? resolve() : reject(new Error(`generator exited ${code}`)));
    });
    const root = new URL("../..", import.meta.url);
    const script = `
      const { createReadStream, readFileSync } = await import("node:fs");
      const { scanRecord } = await import(${JSON.stringify(new URL("src/accounts/postMortemRecord.ts", root).href)});
      const { SAMPLE_MS } = await import(${JSON.stringify(new URL("src/accounts/postMortemJobs.ts", root).href)});
      const used = () => Number(/^VmRSS:\\s+(\\d+) kB$/m.exec(readFileSync("/proc/self/status", "utf8"))[1]) / 1024;
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
    if (process.env.ANTWAR_REPORT_PEAK) console.log(`two scans: peak rise ${Math.round(peak)} MiB over the scanning process's own base`);
    expect(refusals).toEqual([2 * 7200 * 8, 2 * 7200 * 8]);
    expect(peak).toBeLessThanOrEqual(MEMORY_POLICY.scanReserveMiB);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

describe("the child's lifecycle", () => {
  // Credible regression: waiting for an exit that a child never spawned cannot give.
  it("settles once when the child could not be started: an error and no exit", async () => {
    const child = fakeChild({ pid: undefined, exitOnKill: false });
    const jobs = createJobs({ ...quiet, meter: ROOMY, forkChild: () => { queueMicrotask(() => child.emit("error", new Error("spawn failed"))); return child as unknown as ChildProcess; } });
    expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "crashed" });
    expect(child.killed).toEqual([]);
  });

  // Credible regression: settling only on exit, which a child may never emit before close.
  it("settles once on close with no exit", async () => {
    const child = fakeChild({ exitOnKill: false });
    const jobs = createJobs({ ...quiet, meter: ROOMY, forkChild: () => { queueMicrotask(() => child.emit("close", 1, null)); return child as unknown as ChildProcess; } });
    expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "crashed" });
  });

  it("kills a running child on an error and settles once on its exit", async () => {
    const child = fakeChild({ exitOnKill: false });
    const settled = vi.fn();
    const jobs = createJobs({ ...quiet, meter: ROOMY, forkChild: () => child as unknown as ChildProcess });
    void jobs.rerun("m", VERSION, OPEN).outcome!.then(settled);
    await new Promise(resolve => setTimeout(resolve, 10));
    child.emit("error", new Error("ipc"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(child.killed).toEqual(["SIGKILL"]);
    expect(settled).not.toHaveBeenCalled();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(settled).toHaveBeenCalledWith({ kind: "stopped", cause: "crashed" });
  });

  it("keeps only the last 4 KiB of the child's stderr", async () => {
    const child = fakeChild();
    const jobs = createJobs({ ...quiet, meter: ROOMY, forkChild: () => {
      queueMicrotask(() => {
        // The heap-limit line, then 4 KiB more: the line is no longer kept, so the abort is a bare one.
        child.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
        child.stderr.write("x".repeat(STDERR_TAIL_BYTES));
        setTimeout(() => child.emit("exit", null, "SIGABRT"), 10);
      });
      return child as unknown as ChildProcess;
    } });
    expect(await jobs.rerun("m", VERSION, OPEN).outcome).toEqual({ kind: "stopped", cause: "crashed" });
  });
});

/** A child that aborts at its V8 heap limit as the real one does, or one that ends another way. */
function abortingChild(kind: "heap" | "bare" | "crash") {
  const child = fakeChild();
  setTimeout(() => {
    if (kind === "heap") child.stderr.write("<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
    setTimeout(() => child.emit("exit", kind === "crash" ? 1 : null, kind === "crash" ? null : "SIGABRT"), 10);
  }, 10);
  return child as unknown as ChildProcess;
}

describe("too large to re-run", () => {
  // Credible regression: a single heap abort, or any abort, taken as the record's size.
  it("is the answer only when two attempts each abort at the heap limit with room left", async () => {
    for (const [first, second, expected] of [
      ["heap", "heap", { kind: "too_large" }],
      ["heap", "crash", { kind: "stopped", cause: "crashed" }],
      ["heap", "bare", { kind: "stopped", cause: "crashed" }],
      ["bare", "heap", { kind: "stopped", cause: "crashed" }],
    ] as const) {
      const kinds: ("heap" | "bare" | "crash")[] = [first, second];
      const forkChild = vi.fn(() => abortingChild(kinds.shift()!));
      const jobs = createJobs({ ...quiet, meter: ROOMY, forkChild });
      expect(await jobs.rerun("m", VERSION, OPEN).outcome, `${first} then ${second}`).toEqual(expected);
      expect(forkChild).toHaveBeenCalledTimes(first === "heap" ? 2 : 1);
    }
  });

  it("is not the answer when the parent stopped the child, though it aborted at the heap limit", async () => {
    vi.useFakeTimers();
    let headroom = 2000;
    const child = fakeChild({ exitOnKill: false });
    const jobs = createJobs({ ...quiet, meter: () => reading(headroom), forkChild: () => child as unknown as ChildProcess });
    const outcome = jobs.rerun("m", VERSION, OPEN).outcome!;
    headroom = 100;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(child.killed).toEqual(["SIGKILL"]);
    child.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
    child.emit("exit", null, "SIGABRT");
    expect(await outcome).toEqual({ kind: "stopped", cause: "memory" });
  });

  // Credible regression: a heap abort the real child gives not recognised, so an oversized record is never settled.
  it("settles a generated oversized record as too large through the real child under a small heap", async () => {
    const SEATS = 4, COMMANDS = 120_000;
    const generator = `
      const out = process.stdout;
      const w = s => new Promise(r => out.write(s) ? r() : out.once("drain", r));
      (async () => {
        await w('{"codeVersion":"${VERSION}","seats":[');
        for (let s = 0; s < ${SEATS}; s++) {
          await w((s ? "," : "") + '{"seat":' + s + ',"colony":' + (s % 2) + ',"commands":[');
          let parts = [];
          for (let i = 0; i < ${COMMANDS}; i++) {
            parts.push(JSON.stringify({ tick: i, type: "order", accepted: true, request: { type: "order", order: { kind: "go_to", tileX: i % 200, tileY: i % 60 } } }));
            if (parts.length === 1000) { await w((i >= 1000 ? "," : "") + parts.join(",")); parts = []; }
          }
          await w("]}");
        }
        await w("]}");
      })();`;
    const forkChild = vi.fn(() => { const child = forkRerunChild(["--max-old-space-size=48", "--max-semi-space-size=1"]); children.push(child); return child; });
    const jobs = createJobs({ ...quiet, meter: ROOMY, stallMs: 600_000, forkChild });
    const open = async () => { const gen = spawn(process.execPath, ["-e", generator], { stdio: ["ignore", "pipe", "ignore"] }); children.push(gen); return gen.stdout!; };
    expect(await jobs.rerun("big", VERSION, open).outcome).toEqual({ kind: "too_large" });
    expect(forkChild).toHaveBeenCalledTimes(2);
  }, 300_000);
});

// Credible regression: a bitset larger than IPC and the cache are built for. The child's heap cap bounds the commands it
// can hold; each costs at least the floor measured here through the real scanner, with the smallest command a record can
// hold, so its bitset is at most 900 MiB / floor / 8 bytes.
it("bounds the findings bitset: the child's heap cap holds few enough commands for at most 4 MiB of bits", async () => {
  const root = new URL("../..", import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "antwar-pm-floor-"));
  const N = 200_000;
  try {
    const parts = ['{"seats":[{"seat":0,"colony":0,"commands":['];
    for (let i = 0; i < N; i++) parts.push(`${i ? "," : ""}{"tick":${i},"type":"o","accepted":true}`);
    parts.push("]}]}");
    writeFileSync(join(dir, "record.json"), parts.join(""));
    const script = `
      const { createReadStream } = await import("node:fs");
      const { scanRecord } = await import(${JSON.stringify(new URL("src/accounts/postMortemRecord.ts", root).href)});
      for (let i = 0; i < 4; i++) globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      const scan = await scanRecord(createReadStream(${JSON.stringify(join(dir, "record.json"))}, { highWaterMark: 65536 }), undefined, "rerun");
      for (let i = 0; i < 4; i++) globalThis.gc();
      const after = process.memoryUsage().heapUsed;
      process.stdout.write(JSON.stringify({ held: scan.reduced.seats[0].commands.length, perCommand: (after - before) / ${N} }));`;
    const run = spawn(process.execPath, ["--expose-gc", "--import", new URL("src/ts-resolve.mjs", root).href, "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(run);
    let out = "";
    run.stdout!.on("data", chunk => { out += chunk; });
    expect(await new Promise(resolve => run.once("exit", resolve))).toBe(0);
    const { held, perCommand } = JSON.parse(out) as { held: number; perCommand: number };
    expect(held).toBe(N);
    expect(perCommand).toBeGreaterThan(8);
    if (process.env.ANTWAR_REPORT_PEAK) console.log(`held command floor ${perCommand.toFixed(1)} B`);
    const heap = Number(/--max-old-space-size=(\d+)/.exec(CHILD_FLAGS.join(" "))![1]) * MIB;
    // packFindings reads only each seat's command count.
    const { bits } = packFindings([{ seat: 0, commands: { length: Math.ceil(heap / perCommand) } as unknown as readonly unknown[] }], []);
    expect(bits.byteLength).toBeLessThanOrEqual(4 * MIB);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

describe("stall detection at the default limit", () => {
  // Credible regression: a child reading a long record killed as stalled because it reports progress only once re-running.
  it("keeps a child that reports scan progress past STALL_MS, and stops one silent for longer than STALL_MS", async () => {
    vi.useFakeTimers();
    const scanning = fakeChild();
    const jobs = createJobs({ meter: ROOMY, forkChild: () => scanning as unknown as ChildProcess, log: () => {} });
    const outcome = jobs.rerun("slow", VERSION, OPEN).outcome!;
    for (let elapsed = 0; elapsed < 5 * STALL_MS; elapsed += STALL_MS / 2) {
      await vi.advanceTimersByTimeAsync(STALL_MS / 2);
      scanning.emit("message", { kind: "progress", tick: null });
    }
    expect(scanning.killed).toEqual([]);
    scanning.emit("message", { kind: "done", tested: 0, counts: [], bits: new Uint8Array(0), undecided: [] });
    scanning.emit("exit", 0, null);
    expect(await outcome).toEqual({ kind: "findings", tested: 0, counts: [], bits: new Uint8Array(0), undecided: [] });
    const silent = fakeChild();
    const stuck = createJobs({ meter: ROOMY, forkChild: () => silent as unknown as ChildProcess, log: () => {} });
    const stopped = stuck.rerun("stuck", VERSION, OPEN).outcome!;
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(silent.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);
    expect(await stopped).toEqual({ kind: "stopped", cause: "stalled" });
  });
});
