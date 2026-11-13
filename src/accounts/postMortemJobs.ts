/**
 * The post-mortem's work, bounded: refused-call record scans in this process (two at a time, a queue of 16), and re-runs
 * in one forked child at a time (a queue of 8 matches, each held as its match id and proven game version only). A reply
 * never waits for a re-run. Each child attempt opens the record afresh and streams its bytes to the child's stdin
 * through stream/promises pipeline, so a child that exits or is killed mid-stream fails that attempt, never this server.
 *
 * Memory. The meter reads this process's own control group and every one above it up to the cgroup2 mount: each level
 * with a numeric memory.max leaves that limit less its own memory.current. A configured limit (ANTWAR_MEMORY_LIMIT, the
 * same quantity deploy/cloud-run/deploy.sh gives --memory) leaves that limit less this process's own control group's
 * memory.current. The headroom is the smallest of these; with no numeric level the configured limit is required. There
 * is no default: no usable limit, or any reading that cannot be read or parsed, admits nothing and stops a running child.
 * A re-run starts only while the headroom holds the child's reserve (its V8 heap cap's measured peak), two scans and the
 * margin, and a watchdog reading the meter every 50 ms kills the child once the headroom falls below the margin. These
 * figures were measured in tests, not in production.
 */
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ChildMessage, ChildRequest } from "./postMortemChild.js";

/** The child's peak under CHILD_FLAGS: a heap flood dies at the V8 limit with peaks of 1,065-1,076 MiB (tests). */
export const CHILD_RESERVE_MIB = 1100;
/** Two concurrent worst-case refused-call scans, over a base read in the scanning process (tests: post-mortem-jobs.test.ts). */
export const SCAN_RESERVE_MIB = 200;
/** Above a real re-run's growth between two samples (tests: 114 MiB per 50 ms). */
export const MARGIN_MIB = 198;
export const SAMPLE_MS = 50;
export const STALL_MS = 60_000;
export const CHILD_FLAGS = ["--max-old-space-size=900", "--max-semi-space-size=8"] as const;
export const SCAN_CONCURRENCY = 2;
export const SCAN_QUEUE = 16;
export const RERUN_QUEUE = 8;
/** The configured limit's environment variable. */
export const MEMORY_LIMIT_ENV = "ANTWAR_MEMORY_LIMIT";
/** The end of a child's stderr that is kept, to tell a V8 heap-limit abort from another. */
export const STDERR_TAIL_BYTES = 4096;
const HEAP_OOM = "JavaScript heap out of memory";
/** How long an exited child's stderr may take to reach its end. */
const EXIT_STDERR_WAIT_MS = 1000;
const MIB = 2 ** 20;

/** Bytes of a Cloud Run memory quantity of whole Mi or Gi; null for anything else, zero, or a value past safe integers. */
export function parseMemoryQuantity(value: string | undefined): number | null {
  const m = typeof value === "string" ? /^([1-9][0-9]{0,6})(Mi|Gi)$/.exec(value) : null;
  if (m === null) return null;
  const bytes = Number(m[1]) * (m[2] === "Gi" ? 2 ** 30 : MIB);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** A cgroup file's byte count (decimal digits, one trailing newline); null for anything else or past safe integers. */
export function parseCgroupBytes(text: string | null): number | null {
  const m = text === null ? null : /^([0-9]{1,20})\n?$/.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Decodes mountinfo's octal escapes (\040 for a space and the like). */
const unescapeMount = (field: string) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/**
 * The directory of this process's own control group under the one cgroup2 mount, and that mount's directory; null for
 * any mapping this cannot follow: no cgroup2 line or mount, several cgroup2 mounts, a path with an empty, "." or ".."
 * segment, a path outside the mount's root, or a directory that resolves outside the mount.
 */
export function ownCgroup(cgroupText: string, mountinfoText: string): { dir: string; mount: string } | null {
  const line = cgroupText.split("\n").find(l => l.startsWith("0::"));
  if (line === undefined) return null;
  const path = line.slice(3);
  if (!path.startsWith("/") || (path !== "/" && path.slice(1).split("/").some(s => s === "" || s === "." || s === ".."))) return null;
  const mounts: { root: string; point: string }[] = [];
  for (const entry of mountinfoText.split("\n")) {
    const fields = entry.split(" ");
    // Optional fields run from the seventh field to a lone "-"; the filesystem type follows it.
    const separator = fields.indexOf("-", 6);
    if (separator < 0) continue;
    if (fields[separator + 1] === "cgroup2") mounts.push({ root: unescapeMount(fields[3]!), point: unescapeMount(fields[4]!) });
  }
  if (mounts.length !== 1) return null;
  const { root, point } = mounts[0]!;
  if (!root.startsWith("/") || !point.startsWith("/")) return null;
  let relative: string;
  if (root === "/") relative = path;
  else if (path === root) relative = "/";
  else if (path.startsWith(`${root}/`)) relative = path.slice(root.length);
  else return null;
  const mount = resolve(point), dir = resolve(mount, `.${relative}`);
  const inside = dir === mount || dir.startsWith(mount === "/" ? "/" : `${mount}/`);
  return inside ? { dir, mount } : null;
}

export type LimitSource = "numeric" | "configured" | "both";
export interface MemoryReading { readonly headroomMiB: number; readonly source: LimitSource }
/** The headroom left, or null when no usable limit can be read: callers then admit nothing and stop a running child. */
export type Meter = () => MemoryReading | null;

export interface CgroupMeterOptions {
  readonly cgroupFile?: string;
  readonly mountinfoFile?: string;
  /** The configured limit's text; absent where it is not set. */
  readonly configured?: string;
}

export function cgroupMeter(options: CgroupMeterOptions = {}): Meter {
  const cgroupFile = options.cgroupFile ?? "/proc/self/cgroup", mountinfoFile = options.mountinfoFile ?? "/proc/self/mountinfo";
  const configured = "configured" in options ? options.configured : process.env[MEMORY_LIMIT_ENV];
  const read = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  return () => {
    let configuredBytes: number | null = null;
    if (configured !== undefined) {
      configuredBytes = parseMemoryQuantity(configured);
      if (configuredBytes === null) return null;
    }
    const cgroupText = read(cgroupFile), mountinfoText = read(mountinfoFile);
    if (cgroupText === null || mountinfoText === null) return null;
    const own = ownCgroup(cgroupText, mountinfoText);
    if (own === null) return null;
    const headrooms: number[] = [];
    let numeric = false;
    for (let dir = own.dir; ; dir = resolve(dir, "..")) {
      const maxText = read(`${dir}/memory.max`);
      if (maxText === null) {
        // Only the mount's root may have no memory.max.
        if (dir !== own.mount) return null;
      } else if (maxText !== "max\n" && maxText !== "max") {
        const limit = parseCgroupBytes(maxText);
        if (limit === null || limit <= 0) return null;
        const current = parseCgroupBytes(read(`${dir}/memory.current`));
        if (current === null) return null;
        numeric = true;
        headrooms.push(limit - current);
      }
      if (dir === own.mount) break;
    }
    if (configuredBytes !== null) {
      const current = parseCgroupBytes(read(`${own.dir}/memory.current`));
      if (current === null) return null;
      headrooms.push(configuredBytes - current);
    }
    if (headrooms.length === 0) return null;
    return { headroomMiB: Math.min(...headrooms) / MIB, source: numeric && configuredBytes !== null ? "both" : numeric ? "numeric" : "configured" };
  };
}

export interface MemoryPolicy { readonly childReserveMiB: number; readonly scanReserveMiB: number; readonly marginMiB: number }
export const MEMORY_POLICY: MemoryPolicy = { childReserveMiB: CHILD_RESERVE_MIB, scanReserveMiB: SCAN_RESERVE_MIB, marginMiB: MARGIN_MIB };
/** A re-run may start: the headroom holds the child, two scans and the margin (1,498 MiB). */
export const admits = (reading: MemoryReading, policy = MEMORY_POLICY) =>
  reading.headroomMiB >= policy.childReserveMiB + policy.scanReserveMiB + policy.marginMiB;
/** The running child must be stopped: the headroom is below the margin. */
export const overLimit = (reading: MemoryReading, policy = MEMORY_POLICY) => reading.headroomMiB < policy.marginMiB;

/** Why a re-run gave no answer now; never cached. */
export type StopCause = "memory" | "meter" | "stalled" | "crashed" | "admission";
export type RerunOutcome =
  /** counts: [seat, its recorded commands], ascending; bits: one bit per command, each seat's ceil(count / 8) bytes in turn. */
  | { readonly kind: "findings"; readonly tested: number; readonly counts: [number, number][]; readonly bits: Uint8Array; readonly undecided: [number, number][] }
  | { readonly kind: "not_reproduced" }
  | { readonly kind: "no_rerun_data" }
  | { readonly kind: "no_idle_data" }
  | { readonly kind: "engine_error" }
  /** Two attempts each ended at the child's V8 heap limit with room left: this record does not fit the re-run's limits. */
  | { readonly kind: "too_large" }
  | { readonly kind: "stopped"; readonly cause: StopCause };

export class JobsBusy extends Error { constructor() { super("busy"); } }

export interface JobsOptions {
  readonly meter?: Meter;
  /** Starts a re-run child; tests may give another entry point. */
  readonly forkChild?: () => ChildProcess;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly sampleMs?: number;
  readonly stallMs?: number;
  /** Tests only: other reserves than the entry server's. */
  readonly policy?: MemoryPolicy;
}

export interface PostMortemJobs {
  /** Runs a scan in the pool; rejects JobsBusy at once when the queue is full. */
  scan<T>(run: () => Promise<T>): Promise<T>;
  /**
   * Queues a re-run of match id, proven of game version, unless it is already queued or running; "busy" when the
   * queue is full. `open` opens the record's bytes afresh for each attempt (null: no such record).
   */
  rerun(id: string, version: string, open: RecordOpener): { readonly state: "queued" | "running" | "busy"; readonly outcome?: Promise<RerunOutcome> };
  /** The re-run of id now in flight or queued, if any. */
  pending(id: string): Promise<RerunOutcome> | undefined;
}

export type RecordOpener = (signal: AbortSignal) => Promise<Readable | null>;

/** The child's whole environment: nothing of this server's configuration or secrets reaches it. */
export const CHILD_ENV = { ANTWAR_POST_MORTEM_CHILD: "1" } as const;

export function forkRerunChild(flags: readonly string[] = CHILD_FLAGS): ChildProcess {
  return fork(new URL("./postMortemChild.ts", import.meta.url), [], {
    execArgv: ["--import", new URL("../ts-resolve.mjs", import.meta.url).href, ...flags],
    env: { ...CHILD_ENV },
    serialization: "advanced",
    stdio: ["pipe", "ignore", "pipe", "ipc"],
  });
}

/** A reproduced re-run's answer is used only when its bitset is exactly as long as its counts make it. */
export function validFindings(message: { counts?: unknown; bits?: unknown }): message is { counts: [number, number][]; bits: Uint8Array } {
  const { counts, bits } = message;
  if (!Array.isArray(counts) || !(bits instanceof Uint8Array)) return false;
  let bytes = 0;
  for (const pair of counts) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]) || pair[1] < 0) return false;
    bytes += Math.ceil(pair[1] / 8);
  }
  return bits.byteLength === bytes;
}

type Attempt = Exclude<ChildMessage, { kind: "progress" }> | { readonly kind: "stopped"; readonly cause: StopCause; readonly heapLimit?: true };

export function createJobs(options: JobsOptions = {}): PostMortemJobs {
  const meter = options.meter ?? cgroupMeter();
  const forkChild = options.forkChild ?? (() => forkRerunChild());
  const log = options.log ?? (line => console.log(line));
  const now = options.now ?? Date.now;
  const sampleMs = options.sampleMs ?? SAMPLE_MS, stallMs = options.stallMs ?? STALL_MS;
  const policy = options.policy ?? MEMORY_POLICY;

  // One line at start: which limit this instance reads, and whether a re-run could start now.
  const first = meter();
  log(first === null
    ? "antwar post-mortem: no usable memory limit can be read; no-effect re-runs cannot start on this instance"
    : `antwar post-mortem: memory limit from ${first.source === "both" ? "the control group and the configured limit" : first.source === "numeric" ? "the control group" : "the configured limit"}; no-effect re-runs ${admits(first, policy) ? "can" : "cannot"} start now`);

  let scanning = 0;
  const scanQueue: (() => void)[] = [];
  async function scan<T>(run: () => Promise<T>): Promise<T> {
    if (scanning >= SCAN_CONCURRENCY) {
      if (scanQueue.length >= SCAN_QUEUE) throw new JobsBusy();
      await new Promise<void>(resolve => scanQueue.push(resolve));
    }
    scanning++;
    try { return await run(); } finally {
      scanning--;
      scanQueue.shift()?.();
    }
  }

  interface Job { readonly id: string; readonly version: string; readonly open: RecordOpener; readonly outcome: Promise<RerunOutcome>; settle(outcome: RerunOutcome): void }
  const queue: Job[] = [];
  let running: Job | null = null;
  let lastRefusalLog = -Infinity;

  function refusalLog(line: string): void {
    if (now() - lastRefusalLog < 60_000) return;
    lastRefusalLog = now();
    log(line);
  }

  /** One child run on a freshly opened record: its answer, or why it stopped. Settles once, however the child ends. */
  function runChild(job: Job): Promise<Attempt> {
    return new Promise(resolveAttempt => {
      let child: ChildProcess;
      try { child = forkChild(); } catch { resolveAttempt({ kind: "stopped", cause: "crashed" }); return; }
      const abort = new AbortController();
      let answer: Attempt | null = null, cause: StopCause | null = null, lastProgress = now(), done = false;
      let stderr = Buffer.alloc(0);
      let streamTimer: NodeJS.Timeout | undefined;
      const finish = (signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        clearTimeout(streamTimer);
        abort.abort();
        if (answer !== null) { resolveAttempt(answer); return; }
        if (cause !== null) { resolveAttempt({ kind: "stopped", cause }); return; }
        // A V8 heap-limit abort with room left, the parent never having stopped it: the child's own cap did its work.
        if (signal === "SIGABRT" && stderr.toString("utf8").includes(HEAP_OOM)) { resolveAttempt({ kind: "stopped", cause: "memory", heapLimit: true }); return; }
        resolveAttempt({ kind: "stopped", cause: "crashed" });
      };
      const stop = (why: StopCause) => {
        if (cause !== null || answer !== null || done) return;
        cause = why;
        child.kill("SIGKILL");
      };
      const watchdog = setInterval(() => {
        const reading = meter();
        if (reading === null) stop("meter");
        else if (overLimit(reading, policy)) stop("memory");
        else if (now() - lastProgress > stallMs) stop("stalled");
      }, sampleMs);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
      });
      child.on("message", (message: ChildMessage) => {
        if (message.kind === "progress") { lastProgress = now(); return; }
        answer ??= message;
      });
      child.on("error", () => {
        // No process was started: nothing will exit. Otherwise stop it and settle on its exit.
        if (child.pid === undefined) { cause ??= "crashed"; finish(null); } else stop("crashed");
      });
      // The exit can come before the child's stderr is read to its end: settle once that end is read, or soon after.
      child.once("exit", (_code, signal) => {
        if (child.stderr === null || child.stderr.readableEnded) { finish(signal); return; }
        const timer = setTimeout(() => finish(signal), EXIT_STDERR_WAIT_MS);
        child.stderr.once("end", () => { clearTimeout(timer); finish(signal); });
      });
      child.once("close", (_code, signal) => finish(signal));
      child.send({ version: job.version } satisfies ChildRequest, error => { if (error) stop("crashed"); });
      // Never .pipe: a child gone mid-stream would raise an unhandled EPIPE in this server. pipeline rejects instead,
      // and destroys the record stream.
      void (async () => {
        const source = await job.open(abort.signal);
        if (source === null) { stop("crashed"); return; }
        if (abort.signal.aborted) { source.destroy(); return; }
        if (child.stdin === null) { source.destroy(); stop("crashed"); return; }
        try { await pipeline(source, child.stdin, { signal: abort.signal }); } catch {
          // A child that ends by itself mid-stream (its heap limit, say) breaks the pipe first: its own exit says why.
          // One that does not exit soon is stopped.
          if (!done) streamTimer ??= setTimeout(() => stop("crashed"), EXIT_STDERR_WAIT_MS);
        }
      })().catch(() => stop("crashed"));
    });
  }

  /** What one attempt settles; "retry" where only a second attempt can. */
  function outcomeOf(attempt: Attempt): RerunOutcome {
    switch (attempt.kind) {
      case "stopped": return { kind: "stopped", cause: attempt.cause };
      case "mismatch": return { kind: "not_reproduced" };
      case "no_rerun_data": case "no_idle_data": return { kind: attempt.kind };
      case "allocation_failed": return { kind: "stopped", cause: "memory" };
      case "done":
        if (!validFindings(attempt)) return { kind: "stopped", cause: "crashed" };
        return { kind: "findings", tested: attempt.tested, counts: attempt.counts, bits: attempt.bits, undecided: attempt.undecided };
      // "changed", "unreadable", a lone "threw": nothing is settled about this match now.
      default: return { kind: "stopped", cause: "crashed" };
    }
  }

  async function execute(job: Job): Promise<RerunOutcome> {
    const reading = meter();
    if (reading === null || !admits(reading, policy)) {
      refusalLog(`antwar post-mortem: re-run not started; ${reading === null ? "no usable memory limit" : `${Math.round(reading.headroomMiB)} MiB of headroom`}`);
      return { kind: "stopped", cause: reading === null ? "meter" : "admission" };
    }
    const first = await runChild(job);
    // An engine error is an answer only when a fresh child, reading the record afresh, repeats it exactly; a heap-limit
    // abort means the record is too large only when a fresh child aborts the same way.
    if (first.kind === "threw" || (first.kind === "stopped" && first.heapLimit === true)) {
      const again = await runChild(job);
      if (first.kind === "threw" && again.kind === "threw" && again.message === first.message) return { kind: "engine_error" };
      if (first.kind === "stopped" && again.kind === "stopped" && again.heapLimit === true) return { kind: "too_large" };
      if (again.kind === "threw") return { kind: "stopped", cause: "crashed" };
      const outcome = outcomeOf(again);
      if (outcome.kind === "stopped") refusalLog(`antwar post-mortem: re-run stopped (${outcome.cause})`);
      return outcome;
    }
    const outcome = outcomeOf(first);
    if (outcome.kind === "stopped") refusalLog(`antwar post-mortem: re-run stopped (${outcome.cause})`);
    return outcome;
  }

  function drain(): void {
    if (running !== null) return;
    const job = queue.shift();
    if (job === undefined) return;
    running = job;
    void execute(job).catch((): RerunOutcome => ({ kind: "stopped", cause: "crashed" })).then(outcome => {
      running = null;
      job.settle(outcome);
      drain();
    });
  }

  return {
    scan,
    rerun(id, version, open) {
      if (running?.id === id) return { state: "running", outcome: running.outcome };
      const waiting = queue.find(job => job.id === id);
      if (waiting) return { state: "queued", outcome: waiting.outcome };
      if (queue.length >= RERUN_QUEUE) return { state: "busy" };
      let settle!: (outcome: RerunOutcome) => void;
      const outcome = new Promise<RerunOutcome>(resolve => { settle = resolve; });
      const job: Job = { id, version, open, outcome, settle };
      queue.push(job);
      drain();
      return { state: running === job ? "running" : "queued", outcome };
    },
    pending(id) {
      if (running?.id === id) return running.outcome;
      return queue.find(job => job.id === id)?.outcome;
    },
  };
}
