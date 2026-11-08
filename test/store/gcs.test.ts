import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gcsBucket, type ReplayGet } from "../../src/store/gcs.ts";

const LABELS = { failed: "read failed", headers: "read headers timed out", idle: "read idle timeout" };

/** A request that never answers: it records the idle bound it was given and reports its destruction like node:http. */
class SilentRequest extends EventEmitter {
  idleMs?: number;
  idle?: () => void;
  setTimeout(ms: number, onIdle: () => void) { this.idleMs = ms; this.idle = onIdle; return this; }
  destroy(error?: Error) { if (error) this.emit("error", error); this.emit("close"); return this; }
}

function silentBucket() {
  const requests: SilentRequest[] = [];
  const get: ReplayGet = () => { const request = new SilentRequest(); requests.push(request); return request as unknown as ClientRequest; };
  return { objects: gcsBucket("bucket", (async () => { throw new Error("no fetch"); }) as typeof fetch, get), requests };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// No other test lets these bounds fire: without them a stalled GCS read or call holds its route or job indefinitely.
describe("GCS bucket client bounds", () => {
  it("ends a media read with no response headers after 10 s, with the reader's own message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { objects } = silentBucket();
    const read = objects.open("object.bin", "token", new AbortController().signal, LABELS);
    let ended = false;
    const settled = expect(read.finally(() => { ended = true; })).rejects.toThrow(LABELS.headers);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("ends a media read idle for 30 s, with the reader's own message", async () => {
    const { objects, requests } = silentBucket();
    const read = objects.open("object.bin", "token", new AbortController().signal, LABELS);
    expect(requests[0]!.idleMs).toBe(30_000);
    requests[0]!.idle!();
    await expect(read).rejects.toThrow(LABELS.idle);
  });

  it("bounds a JSON API call at 30 s in total, alongside the caller's signal", async () => {
    const bound = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(bound.signal);
    let signal: AbortSignal | undefined;
    const request = (async (_input: unknown, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Response(null); }) as typeof fetch;
    const objects = gcsBucket("bucket", request);
    await objects.call(objects.url("object.json"), { token: "token", signal: new AbortController().signal });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(signal!.aborted).toBe(false);
    bound.abort();
    expect(signal!.aborted).toBe(true);
  });
});
