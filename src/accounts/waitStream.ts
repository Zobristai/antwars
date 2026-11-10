/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Lobbies } from "../lobby/lobbies.js";
import { isFinal, isWaitToken, type WaitState } from "../lobby/waits.js";
import { createAdmissionCap, refuseBusy, type CapLimits } from "../net/admission.js";
import { logUnavailable } from "../net/relay.js";
import { clientSource } from "../server/clientSource.js";

/**
 * GET /wait/<token>: the public server-sent events stream for one waiting token (src/lobby/waits.ts), so an agent
 * can wait for its queue pairing, lobby slot or challenge match without polling. The store has no listener, so the
 * server re-reads the wait itself: once on every connect, then every pollMs.
 *
 * Wire: each connect first sends the wait's current state. While it is waiting that is one unnamed message (data: the
 * waiting state as JSON); then, once the wait ends, or at once when it already has, one final event named paired,
 * slot_ready or expired with its state as JSON data, and the stream closes. No other event names are sent. paired
 * carries lobbyWait: true: the same token is now a wait on the paired lobby, so the next connect sends that lobby's
 * current state, then slot_ready or expired, each carrying lobbyId, so a paired event lost to a cut is recovered. A comment
 * keeps an idle stream alive. Every connect re-reads, so a reconnect after a cut or a missed event still learns the
 * outcome, across a wait of any length.
 *
 * Bounds: behind an HTTP/1 frontend a departed client may never be seen leaving (see RELAY_MAX_MS,
 * src/live/watch-routes.ts), so each stream ends after maxMs without a final event, telling the client to reconnect
 * after RETRY_MS; and open streams are capped, overall and per client source, past which a request gets the retryable
 * 503. A failed first read is the retryable 503; a failed re-read ends the stream without a final event. An unknown or malformed token is 404.
 */

/** How often an open stream re-reads its wait. */
export const WAIT_POLL_MS = 5_000;
/** A comment is written when nothing else has been written for this long, as the match stream does. */
export const WAIT_HEARTBEAT_MS = 15_000;
/** Longest one stream stays open; the client reconnects and is sent the current state again. */
export const WAIT_STREAM_MAX_MS = 300_000;
/** The reconnection delay each stream asks of its client. */
export const RETRY_MS = 1_000;
/** After the bound, a response whose end cannot be flushed is destroyed this much later. */
export const WAIT_END_GRACE_MS = 1_000;
/** Open wait streams on this server at once, and per client source. */
export const WAIT_STREAM_LIMITS: CapLimits = { max: 256, perSource: 16 };

const HEARTBEAT = ": keep-alive\n\n";
const ROUTE_CLASS = "/wait/:token";

export interface WaitStreamOptions {
  /** Defaults to WAIT_POLL_MS; tests pass a short interval. */
  readonly pollMs?: number;
  /** Defaults to WAIT_HEARTBEAT_MS. */
  readonly heartbeatMs?: number;
  /** Defaults to WAIT_STREAM_MAX_MS; tests pass a short bound. */
  readonly maxMs?: number;
  /** Defaults to WAIT_STREAM_LIMITS; tests pass small caps. */
  readonly limits?: CapLimits;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "no_such_wait", message: "No wait has that token." }));
}

/** One SSE message for a state: a final state as its named event, a waiting state unnamed. */
function frame(wait: WaitState): string {
  return `${isFinal(wait) ? `event: ${wait.state}\n` : ""}data: ${JSON.stringify(wait)}\n\n`;
}

export function waitStreamRoutes(lobbies: Pick<Lobbies, "waitStatus">, options: WaitStreamOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const pollMs = options.pollMs ?? WAIT_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? WAIT_HEARTBEAT_MS;
  const maxMs = options.maxMs ?? WAIT_STREAM_MAX_MS;
  const streams = createAdmissionCap("wait streams", options.limits ?? WAIT_STREAM_LIMITS);
  return async (req, res) => {
    const match = /^\/wait\/([^/]+)$/.exec(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!match || !isWaitToken(match[1]!)) { notFound(res); return; }
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
      return;
    }
    const token = match[1]!;
    // The place is held from before the first read until the response closes.
    if (!streams.admit(res, clientSource(req.headers))) return;
    let first: WaitState | null;
    try {
      first = await lobbies.waitStatus(token);
    } catch (cause) {
      logUnavailable(req.method, ROUTE_CLASS, cause);
      if (!res.destroyed) refuseBusy(res);
      return;
    }
    if (res.destroyed) return;
    if (first === null) { notFound(res); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders();
    let lastWrite = Date.now();
    const write = (text: string) => { res.write(text); lastWrite = Date.now(); };
    write(`retry: ${RETRY_MS}\n${frame(first)}`);
    if (isFinal(first)) { res.end(); return; }

    let poll: NodeJS.Timeout | undefined;
    let done = false;
    const stop = () => { done = true; clearTimeout(poll); clearTimeout(life); };
    const life = setTimeout(() => {
      stop();
      res.end();
      // A frontend that has stopped reading cannot take the end: release its connection instead of holding it.
      setTimeout(() => { if (!res.writableFinished) res.destroy(); }, WAIT_END_GRACE_MS).unref();
    }, maxMs);
    res.once("close", stop);
    const tick = async () => {
      let wait: WaitState | null;
      try {
        wait = await lobbies.waitStatus(token);
      } catch (cause) {
        if (done) return;
        logUnavailable(req.method, ROUTE_CLASS, cause);
        stop();
        res.end();
        return;
      }
      if (done) return;
      // A token never stops resolving once issued; were its document gone, the wait has ended.
      const current: WaitState = wait ?? { state: "expired", reason: "ended" };
      if (isFinal(current)) {
        stop();
        write(frame(current));
        res.end();
        return;
      }
      if (Date.now() - lastWrite >= heartbeatMs) write(HEARTBEAT);
      poll = setTimeout(() => void tick(), pollMs);
    };
    poll = setTimeout(() => void tick(), pollMs);
  };
}
