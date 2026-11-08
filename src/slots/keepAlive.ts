/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdmissionCap } from "../net/admission.js";
import type { Activity } from "./activity.js";

/**
 * Keeps a slot server running while its slot's Activity is not idle. The
 * server holds one request to its own public URL open, and the platform does not stop
 * an instance with a request in flight; with at most one instance per slot service the
 * request reaches this same instance. Its KEEP_ALIVE_PATH answers once the Activity is
 * idle, or after KEEP_ALIVE_HOLD_MS so it ends before the built-in fetch's 300-second
 * response-headers timeout, and the server then reopens it while still not idle. Idle, it holds
 * no request, so the platform may stop the instance. Signal handling is unchanged.
 */

export const KEEP_ALIVE_PATH = "/keep-alive";
/**
 * Longest one keep-alive request is held. The answer sends no headers until then, so this
 * stays under Node's built-in fetch response-headers timeout of 300 s (and so under the
 * slot service's 3600 s request timeout); a longer hold ends in `fetch failed` at 300 s.
 */
export const KEEP_ALIVE_HOLD_MS = 4 * 60_000;
/** How often a keep-alive holding no request checks whether the Activity is still idle. */
export const KEEP_ALIVE_CHECK_MS = 1000;

export interface KeepAliveOptions {
  readonly activity: Activity;
  /** This instance's own keep-alive address: its public origin and KEEP_ALIVE_PATH. */
  readonly url: string;
  readonly request?: typeof fetch;
  readonly checkMs?: number;
}

export interface KeepAlive {
  /** True while a keep-alive request is in flight. */
  readonly holding: boolean;
  /** Aborts the request in flight and opens no other. */
  close(): void;
}

export function startKeepAlive(options: KeepAliveOptions): KeepAlive {
  const { activity, url } = options;
  const request = options.request ?? fetch;
  const checkMs = options.checkMs ?? KEEP_ALIVE_CHECK_MS;
  let inFlight: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  /** True from a failed request until one succeeds, so a failing streak logs once. */
  let failing = false;

  function schedule(): void {
    if (closed) return;
    timer = setTimeout(check, checkMs);
    timer.unref();
  }

  function check(): void {
    timer = null;
    if (closed) return;
    if (activity.idle) return schedule();
    const controller = new AbortController();
    inFlight = controller;
    request(url, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        await res.body?.cancel();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        failing = false;
      })
      .catch((err: unknown) => {
        if (closed) return;
        if (!failing) console.error(`antwar keep-alive request to ${url} failed (retried while not idle): ${err instanceof Error ? err.message : String(err)}`);
        failing = true;
      })
      .finally(() => {
        inFlight = null;
        // Reopened after one check interval while still not idle, so an early answer never loops.
        schedule();
      });
  }

  check();

  return {
    get holding() {
      return inFlight !== null;
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      inFlight?.abort();
    },
  };
}

/**
 * Most keep-alive requests one server holds at once. Its own self-request is the only
 * real one; the rest is room for a request whose close has not arrived yet. Anyone can send one,
 * so past this a request is refused with a retryable 503.
 */
export const KEEP_ALIVE_MAX = 4;

/** Each Activity's keep-alive requests waiting for it to be idle, served by one whenIdle waiter. */
const idleListeners = new WeakMap<Activity, Set<() => void>>();

/**
 * Calls listener once the Activity is idle; the returned cancel removes it. All of an Activity's
 * keep-alive requests share one whenIdle waiter, so a request that ends first (closed or timed out)
 * leaves nothing behind in the Activity, and the Activity never holds more than that one waiter.
 */
function onIdle(activity: Activity, listener: () => void): () => void {
  let listeners = idleListeners.get(activity);
  if (listeners === undefined) {
    const waiting = new Set<() => void>();
    listeners = waiting;
    idleListeners.set(activity, waiting);
    void activity.whenIdle().then(() => {
      if (idleListeners.get(activity) === waiting) idleListeners.delete(activity);
      for (const call of waiting) call();
    });
  }
  const own = listeners;
  own.add(listener);
  return () => {
    own.delete(listener);
  };
}

/** How many keep-alive requests wait on this Activity now; for tests. */
export function keepAliveWaiters(activity: Activity): number {
  return idleListeners.get(activity)?.size ?? 0;
}

/**
 * KEEP_ALIVE_PATH: answers 204 once the Activity is idle, at once when it is, or after holdMs.
 * With a cap, a request past it is refused with a retryable 503 and never waits.
 */
export async function serveKeepAlive(req: IncomingMessage, res: ServerResponse, activity: Activity, holdMs = KEEP_ALIVE_HOLD_MS, cap?: AdmissionCap): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    res.writeHead(405).end();
    return;
  }
  if (cap !== undefined && !cap.admit(res, null)) return;
  if (!activity.idle) {
    await new Promise<void>((resolve) => {
      let waiting = true;
      const done = (): void => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timeout);
        cancel();
        res.off("close", done);
        resolve();
      };
      const timeout = setTimeout(done, holdMs);
      const cancel = onIdle(activity, done);
      // A caller that goes away ends the wait and leaves no listener behind.
      res.once("close", done);
    });
  }
  if (!res.destroyed && !res.writableEnded) res.writeHead(204, { "cache-control": "no-store" }).end();
}
