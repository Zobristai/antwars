/// <reference types="node" />
/**
 * Shared by the live stream tests: a manual test clock, the stream
 * served over real HTTP with every response write recorded at its test-clock
 * time and byte length, an SSE client that decodes each message, and the
 * budget checker (25 KB per message, 256 KB in any half-open second).
 */
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inflateRawSync } from "node:zlib";
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import type { LiveClock, LiveHub } from "../../src/live/hub.ts";

/** Budgets in bytes on the wire, with KB taken as 1,000 bytes (stricter than 1,024). */
export const MESSAGE_BUDGET = 25_000;
export const SECOND_BUDGET = 256_000;

/** A clock the test advances by hand; timers fire in due order as it passes them. */
export class ManualClock implements LiveClock {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; seq: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward by ms, running each timer due on the way at its own time. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; seq: number; fn: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at > end) continue;
        if (next === null || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].seq < next[1].seq)) next = entry;
      }
      if (next === null) break;
      this.timers.delete(next[0]);
      // A timer made overdue by stall() runs late, at the current time.
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
  }

  /**
   * An event-loop stall: time moves on by ms and no timer runs. Timers that came
   * due during it run late, at the stalled time, on the next advance.
   */
  stall(ms: number): void {
    this.t += ms;
  }
}

/** One response write: when it happened on the test clock and how many bytes went to the response. */
export interface WriteRecord {
  readonly t: number;
  readonly bytes: number;
  readonly text: string;
}

/** One HTTP response the hub served, with every write it made. */
export interface ServedResponse {
  readonly path: string;
  readonly writes: WriteRecord[];
  /** Set when the hub destroys the response: when, its unsent bytes then, and how many writes it had had. */
  destroyed: { t: number; unsent: number; writes: number } | null;
}

/** The hub served over real HTTP; every res.write is recorded before it goes out. */
export class RecordedServer {
  readonly responses: ServedResponse[] = [];
  private readonly server: Server;
  private portNumber = 0;

  /** keepText false records only times and sizes, for long runs. */
  constructor(hub: LiveHub, clock: LiveClock, options: { keepText?: boolean } = {}) {
    const keepText = options.keepText ?? true;
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const served: ServedResponse = { path: req.url ?? "", writes: [], destroyed: null };
      this.responses.push(served);
      const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
      res.write = ((chunk: unknown, ...rest: unknown[]) => {
        const text = !keepText ? "" : typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
        served.writes.push({ t: clock.now(), bytes: Buffer.byteLength(chunk as string | Uint8Array), text });
        return write(chunk, ...rest);
      }) as ServerResponse["write"];
      const destroy = res.destroy.bind(res);
      res.destroy = ((error?: Error) => {
        served.destroyed ??= { t: clock.now(), unsent: res.writableLength, writes: served.writes.length };
        return destroy(error);
      }) as ServerResponse["destroy"];
      hub.handle(req, res);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.portNumber = (this.server.address() as AddressInfo).port;
  }

  get port(): number {
    return this.portNumber;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.portNumber}${path}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A received SSE item: a decoded data message, or a comment line. */
export type Received = { kind: "message"; message: StreamMessage; bytes: number } | { kind: "comment"; text: string; bytes: number };

/** Decode one SSE data payload: base64, then raw inflate, then the format.ts message. */
export function decodeData(data: string): StreamMessage {
  return decodeMessage(new Uint8Array(inflateRawSync(Buffer.from(data, "base64"))));
}

/** A spectator reading /live/... over real HTTP. */
export class SseClient {
  readonly received: Received[] = [];
  /** Every decoded data message's tick, whether it was full, and whether it carried a result. */
  readonly log: { tick: number; full: boolean; result: boolean }[] = [];
  status = 0;
  headers: IncomingMessage["headers"] = {};
  receivedBytes = 0;
  private buffer = "";
  private req: ReturnType<typeof get> | null = null;

  /** Messages decoded, of every kind, whether kept or not. */
  messageCount = 0;
  private keep = true;
  private decode = true;

  /**
   * keep false keeps only full snapshots and comments (long runs); decode false
   * counts data lines without decoding them (payloads that are not messages).
   */
  static async connect(url: string, options: { keep?: boolean; decode?: boolean } = {}): Promise<SseClient> {
    const c = new SseClient();
    c.keep = options.keep ?? true;
    c.decode = options.decode ?? true;
    await new Promise<void>((resolve, reject) => {
      c.req = get(url, (res) => {
        c.status = res.statusCode ?? 0;
        c.headers = res.headers;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => c.feed(chunk));
        resolve();
      });
      c.req.on("error", reject);
    });
    return c;
  }

  get messages(): StreamMessage[] {
    return this.received.flatMap((r) => (r.kind === "message" ? [r.message] : []));
  }

  close(): void {
    this.req?.destroy();
  }

  private feed(chunk: string): void {
    this.receivedBytes += Buffer.byteLength(chunk);
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n\n"); i >= 0; i = this.buffer.indexOf("\n\n")) {
      const block = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      const bytes = Buffer.byteLength(block) + 2;
      if (block.startsWith(":")) this.received.push({ kind: "comment", text: block, bytes });
      else if (block.startsWith("data: ")) {
        this.messageCount++;
        if (!this.decode) continue;
        const message = decodeData(block.slice(6));
        const result = message.events.some((e) => e.kind === "end") || (message.full?.result ?? null) !== null;
        this.log.push({ tick: message.tick, full: message.full !== null, result });
        if (this.keep || message.full !== null) this.received.push({ kind: "message", message, bytes });
      }
      else throw new Error(`unexpected SSE block: ${block.slice(0, 40)}`);
    }
  }
}

/** Wait until the client has received every byte the server has written to its response. */
export async function delivered(client: SseClient, served: ServedResponse): Promise<void> {
  const want = (): number => served.writes.reduce((n, w) => n + w.bytes, 0);
  for (let i = 0; client.receivedBytes < want(); i++) {
    if (i > 20_000) throw new Error(`client stalled at ${client.receivedBytes} of ${want()} bytes`);
    await new Promise((r) => setImmediate(r));
  }
}

/** Wait until the server has seen n requests (a connect is asynchronous on the server side). */
export async function served(server: RecordedServer, n: number): Promise<ServedResponse> {
  for (let i = 0; server.responses.length < n; i++) {
    if (i > 20_000) throw new Error("server never saw the request");
    await new Promise((r) => setImmediate(r));
  }
  return server.responses[n - 1]!;
}

export interface BudgetReport {
  readonly writes: number;
  /** The largest single write, and the most written in any half-open window [t, t+1000). */
  readonly maxMessage: number;
  readonly maxSecond: number;
  readonly maxSecondAt: number;
  readonly overMessage: number;
  readonly overSecond: number;
}

/**
 * Check one spectator's writes (every response it was served, merged in time
 * order) against both budgets. Each window starts at a write time t and covers
 * [t, t+1000): at 10 Hz that holds 10 writes, not 11.
 */
export function checkBudget(writes: readonly WriteRecord[]): BudgetReport {
  const w = writes.slice().sort((a, b) => a.t - b.t);
  let maxMessage = 0;
  let overMessage = 0;
  for (const x of w) {
    maxMessage = Math.max(maxMessage, x.bytes);
    if (x.bytes > MESSAGE_BUDGET) overMessage++;
  }
  let maxSecond = 0;
  let maxSecondAt = 0;
  let overSecond = 0;
  let sum = 0;
  let j = 0;
  // sum covers writes [i, j): every write from w[i].t up to, not including, w[i].t + 1000.
  for (let i = 0; i < w.length; i++) {
    if (i > 0) sum -= w[i - 1]!.bytes;
    while (j < w.length && w[j]!.t < w[i]!.t + 1000) sum += w[j++]!.bytes;
    // Later writes at the same instant start the same window; only the first sees all of it.
    if (i > 0 && w[i]!.t === w[i - 1]!.t) continue;
    if (sum > maxSecond) {
      maxSecond = sum;
      maxSecondAt = w[i]!.t;
    }
    if (sum > SECOND_BUDGET) overSecond++;
  }
  return { writes: w.length, maxMessage, maxSecond, maxSecondAt, overMessage, overSecond };
}

/** All writes of these responses, as one spectator's record. */
export function writesOf(...responses: readonly ServedResponse[]): WriteRecord[] {
  return responses.flatMap((r) => r.writes);
}
