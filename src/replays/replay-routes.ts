import { addAbortListener } from "node:events";
import { pipeline } from "node:stream/promises";
import { isGzip, logUnavailable, peek, relayed } from "../net/relay.js";
import type { MountHandler } from "../server.js";
import { isReplayId, type ReplaySource } from "./access.js";
import { CORRECTED_REPLAY_IDS } from "./correctedRecordings.js";

/**
 * GET /replays/<id>: one stored recording's bytes, streamed unchanged with immutable caching; a recording a rating
 * correction may change (correctedRecordings.ts) is cached for a minute only.
 * A gzip object (by its magic bytes) is labelled content-encoding gzip; a failed read answers a sanitized, logged 503.
 */
export function replayRoutes(source: ReplaySource): MountHandler {
  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const id = path.slice("/replays/".length);
    if (!path.startsWith("/replays/") || !isReplayId(id)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end();
      return;
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    res.once("close", cancel);
    try {
      const object = await source.open(id, abort.signal);
      if (abort.signal.aborted) { object?.body.destroy(); return; }
      if (object === null) { res.writeHead(404, { "cache-control": "no-store" }).end(); return; }
      // Wait only for the magic bytes; cancellation must also cover this pre-header read.
      const cancellation = addAbortListener(abort.signal, () => { object.body.destroy(); });
      try {
        const start = await peek(object.body, 2);
        abort.signal.throwIfAborted();
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          ...(isGzip(start.head) ? { "content-encoding": "gzip" } : {}),
          "cache-control": CORRECTED_REPLAY_IDS.has(id) ? "public, max-age=60, no-transform" : "public, max-age=31536000, immutable, no-transform",
          ...(object.contentLength === undefined ? {} : { "content-length": object.contentLength }),
        });
        // Both ends apply backpressure, including after the small prefix lookahead.
        await pipeline(relayed(start), res, { signal: abort.signal });
      } finally {
        cancellation[Symbol.dispose]();
        object.body.destroy();
      }
    } catch (error) {
      if (res.destroyed) return;
      // A response already in flight cannot change status: truncate it safely.
      if (res.headersSent) { res.destroy(); return; }
      logUnavailable(req.method, "/replays/:id", error);
      // Do not echo credentials or a provider response body.
      const body = Buffer.from(JSON.stringify({ error: "Replay temporarily unavailable. Please try again." }));
      res.writeHead(503, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" }).end(body);
    } finally {
      res.off("close", cancel);
    }
  };
}
