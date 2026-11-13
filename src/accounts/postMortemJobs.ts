/**
 * The post-mortem's work, bounded: refused-call record scans in this process (two at a time, a queue of 16), and re-runs
 * in one forked child at a time (a queue of 8 matches, each held as its match id and proven game version only). A reply
 * never waits for a re-run. Each child attempt opens the record afresh and streams its bytes to the child's stdin
 * through stream/promises pipeline, so a child that exits or is killed mid-stream fails that attempt, never this server.
 *
 * Memory. The entry server's container has 2 GiB (deploy/cloud-run/deploy.sh MEMORY). The meter is the whole
 * container's memory in use as the kernel reports it, MemTotal minus MemAvailable from /proc/meminfo, so it counts
 * every process (npm, its shell, this server, the child), concurrent scans and in-memory files; it is read the same way
 * under either Cloud Run execution environment. The limit is the smaller of 2 GiB and MemTotal. A re-run starts only
 * while use leaves room for the child's reserve (its V8 heap cap's measured peak), two scans and the headroom, and a
 * watchdog reading the meter every 50 ms kills the child once use passes the limit less the headroom. A meter that
 * cannot be read admits nothing and kills a running child. These figures were measured in tests, not in production.
 */
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ChildMessage, ChildRequest, NoEffect } from "./postMortemChild.js";

export const CONTAINER_LIMIT_MIB = 2048;
/** The child's peak under CHILD_FLAGS: a heap flood dies at the V8 limit with peaks of 1,065-1,076 MiB (tests). */
export const CHILD_RESERVE_MIB = 1100;
/** Two concurrent worst-case refused-call scans, whole container, over a base read in the scanning process (tests: post-mortem-jobs.test.ts). */
export const SCAN_RESERVE_MIB = 200;
/** Above a real re-run's growth between two samples (tests: 114 MiB per 50 ms). */
export const HEADROOM_MIB = 198;
export const SAMPLE_MS = 50;
export const STALL_MS = 60_000;
export const CHILD_FLAGS = ["--max-old-space-size=900", "--max-semi-space-size=8"] as const;
export const SCAN_CONCURRENCY = 2;
export const SCAN_QUEUE = 16;
export const RERUN_QUEUE = 8;

export interface MemoryReading { readonly usedMiB: number; readonly totalMiB: number }
export type Meter = () => MemoryReading | null;

/** Whole-container memory in use, MiB, from /proc/meminfo; null when it cannot be read. */
export function meminfoMeter(path = "/proc/meminfo"): Meter {
  return () => {
    try {
      const text = readFileSync(path, "utf8");
      const field = (name: string) => { const m = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text); return m ? Number(m[1]) / 1024 : NaN; };
      const total = field("MemTotal"), available = field("MemAvailable");
      if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) return null;
      return { usedMiB: total - available, totalMiB: total };
    } catch { return null; }
  };
}

export interface MemoryPolicy { readonly limitMiB: number; readonly childReserveMiB: number; readonly scanReserveMiB: number; readonly headroomMiB: number }
export const MEMORY_POLICY: MemoryPolicy = { limitMiB: CONTAINER_LIMIT_MIB, childReserveMiB: CHILD_RESERVE_MIB, scanReserveMiB: SCAN_RESERVE_MIB, headroomMiB: HEADROOM_MIB };
export const limitOf = (reading: MemoryReading, policy = MEMORY_POLICY) => Math.min(policy.limitMiB, reading.totalMiB);
/** A re-run may start: room for the child, two scans and the headroom (550 MiB in use at the 2 GiB limit). */
export const admits = (reading: MemoryReading, policy = MEMORY_POLICY) =>
  reading.usedMiB <= limitOf(reading, policy) - policy.childReserveMiB - policy.scanReserveMiB - policy.headroomMiB;
/** The running child must be stopped (above 1,850 MiB in use at the 2 GiB limit). */
export const overLimit = (reading: MemoryReading, policy = MEMORY_POLICY) => reading.usedMiB > limitOf(reading, policy) - policy.headroomMiB;

/** Why a re-run gave no answer now; never cached. */
export type StopCause = "memory" | "meter" | "stalled" | "crashed" | "admission";
export type RerunOutcome =
  | { readonly kind: "findings"; readonly tested: number; readonly findings: NoEffect[]; readonly undecided: [number, number][] }
  | { readonly kind: "not_reproduced" }
  | { readonly kind: "no_rerun_data" }
  | { readonly kind: "no_idle_data" }
  | { readonly kind: "engine_error" }
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
  /** Tests only: other limits than the 2 GiB container's. */
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

export function forkRerunChild(): ChildProcess {
  return fork(new URL("./postMortemChild.ts", import.meta.url), [], {
    execArgv: ["--import", new URL("../ts-resolve.mjs", import.meta.url).href, ...CHILD_FLAGS],
    env: { ...CHILD_ENV },
    serialization: "advanced",
    stdio: ["pipe", "ignore", "inherit", "ipc"],
  });
}

export function createJobs(options: JobsOptions = {}): PostMortemJobs {
  const meter = options.meter ?? meminfoMeter();
  const forkChild = options.forkChild ?? forkRerunChild;
  const log = options.log ?? (line => console.log(line));
  const now = options.now ?? Date.now;
  const sampleMs = options.sampleMs ?? SAMPLE_MS, stallMs = options.stallMs ?? STALL_MS;
  const policy = options.policy ?? MEMORY_POLICY;

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

  /** One child run on a freshly opened record: its answer, or why it stopped. */
  function runChild(job: Job): Promise<ChildMessage | { kind: "stopped"; cause: StopCause }> {
    return new Promise(resolve => {
      let child: ChildProcess;
      try { child = forkChild(); } catch { resolve({ kind: "stopped", cause: "crashed" }); return; }
      const abort = new AbortController();
      let answer: ChildMessage | null = null, cause: StopCause | null = null, lastProgress = now();
      const stop = (why: StopCause) => { if (cause === null && answer === null) { cause = why; child.kill("SIGKILL"); } };
      const watchdog = setInterval(() => {
        const reading = meter();
        if (reading === null) stop("meter");
        else if (overLimit(reading, policy)) stop("memory");
        else if (now() - lastProgress > stallMs) stop("stalled");
      }, sampleMs);
      child.on("message", (message: ChildMessage) => {
        if (message.kind === "progress") { lastProgress = now(); return; }
        answer ??= message;
      });
      child.once("error", () => stop("crashed"));
      child.once("exit", (_code, signal) => {
        clearInterval(watchdog);
        abort.abort();
        if (answer !== null) resolve(answer);
        // A V8 heap-limit abort is the child's memory cap doing its work.
        else resolve({ kind: "stopped", cause: cause ?? (signal === "SIGABRT" ? "memory" : "crashed") });
      });
      child.send({ version: job.version } satisfies ChildRequest, error => { if (error) stop("crashed"); });
      // Never .pipe: a child gone mid-stream would raise an unhandled EPIPE in this server. pipeline rejects instead,
      // and destroys the record stream.
      void (async () => {
        const source = await job.open(abort.signal);
        if (source === null) { stop("crashed"); return; }
        if (abort.signal.aborted) { source.destroy(); return; }
        if (child.stdin === null) { source.destroy(); stop("crashed"); return; }
        await pipeline(source, child.stdin, { signal: abort.signal });
      })().catch(() => stop("crashed"));
    });
  }

  async function execute(job: Job): Promise<RerunOutcome> {
    const reading = meter();
    if (reading === null || !admits(reading, policy)) {
      refusalLog(`antwar post-mortem: re-run not started; memory in use ${reading === null ? "unreadable" : `${Math.round(reading.usedMiB)} MiB of ${Math.round(limitOf(reading, policy))} MiB`}`);
      return { kind: "stopped", cause: reading === null ? "meter" : "admission" };
    }
    const first = await runChild(job);
    if (first.kind === "threw") {
      // An engine error is an answer only when a fresh child, reading the record afresh, repeats it exactly.
      const again = await runChild(job);
      if (again.kind === "threw" && again.message === first.message) return { kind: "engine_error" };
      return again.kind === "stopped" ? again : { kind: "stopped", cause: "crashed" };
    }
    if (first.kind === "stopped") {
      refusalLog(`antwar post-mortem: re-run stopped (${first.cause})`);
      return first;
    }
    if (first.kind === "mismatch") return { kind: "not_reproduced" };
    if (first.kind === "no_rerun_data" || first.kind === "no_idle_data") return { kind: first.kind };
    if (first.kind === "done") return { kind: "findings", tested: first.tested, findings: first.findings, undecided: first.undecided };
    // "changed", "unreadable": nothing is settled about this match now.
    return { kind: "stopped", cause: "crashed" };
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
