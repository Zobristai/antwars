/// <reference types="node" />
import type { ServerResponse } from "node:http";

/**
 * Per-server caps on concurrent long-held anonymous requests. A cap counts requests
 * while they are open: a place is taken when a request is admitted and given back when its
 * response closes. Past the cap a request is refused with a retryable 503 (Retry-After: 1).
 *
 * A cap may also bound how many places one source holds, keyed by clientSource; requests with no
 * client hop (null) share one key. A request the caller has verified as exempt from the
 * per-source bound passes no source and counts only toward the overall cap.
 *
 * Refusals are logged as a count per cap, at most once a minute, never with an address, so the
 * values can be tuned from evidence.
 */

export interface CapLimits {
  /** Most places open at once on this server. */
  readonly max: number;
  /** Most places one source holds at once; omitted means no per-source bound. */
  readonly perSource?: number;
}

/** How often a cap logs its refusals, at most. */
export const REFUSAL_LOG_MS = 60_000;

/** Passed as a source when the per-source bound does not apply to this request. */
export const EXEMPT: unique symbol = Symbol("exempt from the per-source bound");

export interface AdmissionCap {
  /** Names the cap in refusal logs. */
  readonly name: string;
  readonly limits: CapLimits;
  /** Places open now. */
  readonly open: number;
  /** Places one source holds now (null: requests with no client hop). */
  openFor(source: string | null): number;
  /**
   * Takes one place for a request from `source`, or returns null (and counts a refusal) when the
   * cap or the source's bound is reached. The returned release is idempotent.
   */
  take(source: string | null | typeof EXEMPT): (() => void) | null;
  /**
   * take, with the place given back when `res` closes; on refusal answers `res` with the
   * retryable 503 and returns false. A response already closed takes nothing and returns false.
   */
  admit(res: ServerResponse, source: string | null | typeof EXEMPT, refuse?: (res: ServerResponse) => void): boolean;
}

/** The retryable refusal past a cap: 503 with Retry-After: 1 and no body. */
export function refuseBusy(res: ServerResponse): void {
  res.writeHead(503, { "cache-control": "no-store", "retry-after": "1" }).end();
}

export function createAdmissionCap(name: string, limits: CapLimits, log: (line: string) => void = (line) => console.warn(line)): AdmissionCap {
  if (!(Number.isInteger(limits.max) && limits.max > 0)) throw new Error(`${name}: max must be a positive integer`);
  if (limits.perSource !== undefined && !(Number.isInteger(limits.perSource) && limits.perSource > 0)) throw new Error(`${name}: perSource must be a positive integer`);
  let open = 0;
  const bySource = new Map<string | null, number>();
  let refused = 0;
  let logTimer: NodeJS.Timeout | null = null;

  function flush(): void {
    const count = refused;
    refused = 0;
    log(`antwar admission ${name}: refused ${count} request${count === 1 ? "" : "s"} past the cap (max ${limits.max}${limits.perSource === undefined ? "" : `, ${limits.perSource} per source`}, ${open} open)`);
  }

  /** The first refusal after a quiet minute is logged at once; later ones are summed into one line a minute. */
  function countRefusal(): void {
    refused += 1;
    if (logTimer !== null) return;
    flush();
    const tick = (): void => {
      if (refused === 0) {
        logTimer = null;
        return;
      }
      flush();
      logTimer = setTimeout(tick, REFUSAL_LOG_MS);
      logTimer.unref();
    };
    logTimer = setTimeout(tick, REFUSAL_LOG_MS);
    logTimer.unref();
  }

  function take(source: string | null | typeof EXEMPT): (() => void) | null {
    const keyed = source !== EXEMPT && limits.perSource !== undefined;
    const held = keyed ? (bySource.get(source) ?? 0) : 0;
    if (open >= limits.max || (keyed && held >= limits.perSource!)) {
      countRefusal();
      return null;
    }
    open += 1;
    if (keyed) bySource.set(source, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open -= 1;
      if (!keyed) return;
      const left = (bySource.get(source) ?? 1) - 1;
      if (left === 0) bySource.delete(source);
      else bySource.set(source, left);
    };
  }

  return {
    name,
    limits,
    get open() {
      return open;
    },
    openFor: (source) => bySource.get(source) ?? 0,
    take,
    admit(res, source, refuse = refuseBusy) {
      // A response already closed would never give its place back.
      if (res.destroyed) return false;
      const release = take(source);
      if (release === null) {
        refuse(res);
        return false;
      }
      res.once("close", release);
      return true;
    },
  };
}
