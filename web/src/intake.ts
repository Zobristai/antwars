/** The live tick-preparation boundary. The main thread admits raw SSE strings; the worker owns
 * decoding and model/grid preparation. Playback still owns event/story derivation and interpolation.
 */
import { TickPreparation, type PreparedTick } from "./buffer.ts";
import { decodeData } from "./stream.ts";
import { measurementNow } from "./timing.ts";
import type { StreamMessage } from "../../src/live/format.ts";

export type IntakeRequest = { kind: "reset"; generation: number } | { kind: "decode"; generation: number; id: number; data: string };
export type IntakeReply = { generation: number; id: number } & (
  | { kind: "tick"; m: StreamMessage; prepared: PreparedTick | null; workerMs: number }
  | { kind: "error"; message: string }
);
export type IntakeTick = Extract<IntakeReply, { kind: "tick" }> & { deliveryMs?: number };

/** Shared worker handler, with explicit decode/time dependencies so cancellation is exercised without browser mocks. */
export class IntakeProcessor {
  private generation = 0;
  private preparation = new TickPreparation();
  private chain: Promise<void> = Promise.resolve();

  private readonly decode: typeof decodeData;
  private readonly now: () => number;

  constructor(decode = decodeData, now = measurementNow) {
    this.decode = decode;
    this.now = now;
  }

  handle(request: IntakeRequest): Promise<IntakeReply | null> {
    if (request.kind === "reset") {
      this.generation = request.generation;
      this.preparation = new TickPreparation();
      this.chain = Promise.resolve();
      return Promise.resolve(null);
    }
    const work = this.chain.then(async (): Promise<IntakeReply | null> => {
      if (request.generation !== this.generation) return null;
      const started = this.now();
      try {
        const m = await this.decode(request.data);
        // An abandoned inflate must not mutate the next connection's model.
        if (request.generation !== this.generation) return null;
        const prepared = this.preparation.prepare(m);
        return { kind: "tick", generation: request.generation, id: request.id, m, prepared, workerMs: this.now() - started };
      } catch (error: unknown) {
        if (request.generation !== this.generation) return null;
        return { kind: "error", generation: request.generation, id: request.id, message: error instanceof Error ? error.message : String(error) };
      }
    });
    this.chain = work.then(() => undefined);
    return work;
  }
}

/** Only tick-owned ant/trail buffers transfer. Retained model/board grids must never be detached. */
export function intakeTransfers(reply: IntakeReply): ArrayBuffer[] {
  if (reply.kind !== "tick") return [];
  const arrays = Object.values(reply.m.ants).filter((v): v is ArrayBufferView => ArrayBuffer.isView(v));
  if (reply.prepared) arrays.push(reply.prepared.trails);
  return [...new Set(arrays.map((a) => a.buffer as ArrayBuffer))];
}

export interface IntakeWorker {
  postMessage(message: IntakeRequest): void;
  terminate(): void;
  onmessage: ((message: MessageEvent<IntakeReply>) => void) | null;
  onerror: ((error: ErrorEvent) => void) | null;
}
export interface Intake {
  decode(data: string): Promise<IntakeTick>;
  reset(): void;
  close(): void;
}

/** At most one live request: openLive also bounds raw strings before they reach this decoder. */
export class WorkerIntake implements Intake {
  private worker: IntakeWorker | null = null;
  private generation = 0;
  private nextId = 0;
  /** A valid reply proves this worker loaded; reconnects do not undo that proof. */
  private ready = false;
  private pending: { id: number; resolve: (tick: IntakeTick) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;

  private readonly create: () => IntakeWorker;
  private readonly onFailure: (error: Error, startup: boolean) => void;
  private readonly measure: () => number;

  constructor(create: () => IntakeWorker, onFailure: (error: Error, startup: boolean) => void = () => {}, measure = measurementNow) {
    this.create = create;
    this.onFailure = onFailure;
    this.measure = measure;
  }

  private fail(error: Error): void {
    const startup = !this.ready;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(error);
      this.pending = null;
    }
    this.close();
    this.onFailure(error, startup);
  }

  private start(): IntakeWorker {
    if (this.worker) return this.worker;
    const worker = this.create();
    worker.onmessage = (event) => {
      const started = this.measure();
      const data = event.data;
      if (worker !== this.worker || data.generation !== this.generation || data.id !== this.pending?.id) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);
      this.ready = true;
      if (data.kind === "error") pending.reject(new Error(data.message));
      else pending.resolve({ ...data, deliveryMs: this.measure() - started });
    };
    worker.onerror = (error) => {
      if (worker !== this.worker) return;
      this.fail(new Error(`intake worker: ${error.message || "load or execution failed"}`));
    };
    this.worker = worker;
    worker.postMessage({ kind: "reset", generation: this.generation });
    return worker;
  }

  decode(data: string): Promise<IntakeTick> {
    if (this.pending) return Promise.reject(new Error("intake: concurrent request refused"));
    let worker: IntakeWorker;
    try { worker = this.start(); }
    catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.fail(error);
      return Promise.reject(error);
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error(this.ready ? "intake worker: decode timed out" : "intake worker: startup timed out")), this.ready ? 15_000 : 3000);
      this.pending = { id, resolve, reject, timeout };
      try { worker.postMessage({ kind: "decode", generation: this.generation, id, data }); }
      catch (error: unknown) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  reset(): void {
    this.generation++;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error("intake: connection superseded"));
      this.pending = null;
    }
    try { this.worker?.postMessage({ kind: "reset", generation: this.generation }); }
    catch { this.close(); } // A broken port cannot retain state; the next decode starts a fresh worker.
  }

  close(): void {
    this.generation++;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error("intake: connection superseded"));
      this.pending = null;
    }
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }
}
