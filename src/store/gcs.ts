/// <reference types="node" />
import type { ClientRequest, IncomingMessage } from "node:http";
import { get as httpsGet, type RequestOptions } from "node:https";
import type { Readable } from "node:stream";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { metadataAccessToken } from "../auth/metadata-token.js";

/** A raw HTTP transport: unlike a decoding client, it preserves Content-Encoding bytes. */
export type ReplayGet = (url: URL, options: RequestOptions, response: (res: IncomingMessage) => void) => ClientRequest;
const rawGet: ReplayGet = (url, options, response) => httpsGet(url, options, response);

/** The exact messages one media reader reports: they reach operator logs. */
export interface MediaLabels { readonly failed: string; readonly headers: string; readonly idle: string }

/** objects.insert precondition: 0 creates only; a generation replaces exactly that generation (record-store only). */
export interface Upload {
  readonly name: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly contentEncoding?: "gzip";
  readonly ifGenerationMatch: 0 | string;
  /** Pull 64 KiB at a time with an explicit length, bounding memory for large replays; otherwise one buffer. */
  readonly stream: boolean;
}

export class ReplayCreateError extends Error {
  readonly status: number;
  constructor(status: number) { super(`replay create failed: HTTP ${status}`); this.name = "ReplayCreateError"; this.status = status; }
}

/**
 * One bucket through the Cloud Run service identity (src/auth/metadata-token.ts); never a key file.
 * JSON API calls use fetch with a 30 s total bound and no redirects. Media reads use raw node:https (Accept-Encoding gzip,
 * so GCS never transcodes) with 10 s to headers, 30 s idle and no total bound. Provider bodies are never retained or logged.
 * A token is requested per call unless the caller passes the one its operation shares.
 */
export function gcsBucket(bucket: string, request: typeof fetch = fetch, get: ReplayGet = rawGet) {
  const path = `/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  /** The object collection (no name) or one object, with query parameters in the given order; undefined ones are left out. */
  function url(name?: string, query: Record<string, string | undefined> = {}, upload = false): URL {
    const url = new URL(`https://storage.googleapis.com${upload ? "/upload" : ""}${path}${name === undefined ? "" : `/${encodeURIComponent(name)}`}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return url;
  }
  async function call(target: URL, init: RequestInit & { token?: string; duplex?: "half" } = {}): Promise<Response> {
    const { token, signal, headers, ...rest } = init;
    const bearer = token ?? await metadataAccessToken(request);
    const timeout = AbortSignal.timeout(30_000);
    return request(target, { ...rest, headers: { authorization: `Bearer ${bearer}`, ...headers as Record<string, string> },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
  }
  return {
    url, call,
    /** Media upload; a failed status (412: the precondition failed) is a ReplayCreateError. */
    async upload(object: Upload): Promise<void> {
      const target = url(undefined, { uploadType: "media", name: object.name, ifGenerationMatch: String(object.ifGenerationMatch),
        contentEncoding: object.contentEncoding }, true);
      const token = await metadataAccessToken(request);
      // Encoding belongs to the stored object metadata, not the HTTP request: GCS decodes a Content-Encoding request header.
      const response = await call(target, { method: "POST", token, ...object.stream
        ? { headers: { "content-type": object.contentType, "content-length": String(object.body.byteLength) }, body: chunked(object.body), duplex: "half" }
        : { headers: { "content-type": object.contentType }, body: Buffer.from(object.body) } });
      await response.body?.cancel();
      if (!response.ok) throw new ReplayCreateError(response.status);
    },
    /** Raw media; null when missing. Observes early errors, so the caller may attach its pipeline later. */
    open(name: string, token: string, signal: AbortSignal, labels: MediaLabels, generation?: string): Promise<IncomingMessage | null> {
      signal.throwIfAborted();
      const target = url(name, { alt: "media", generation });
      return new Promise((resolve, reject) => {
        let headersTimer: NodeJS.Timeout | undefined;
        const req = get(target, { headers: { authorization: `Bearer ${token}`, "accept-encoding": "gzip" }, signal }, response => {
          clearTimeout(headersTimer);
          if (response.statusCode === 404) { response.destroy(); resolve(null); }
          else if (response.statusCode !== 200) { response.destroy(); reject(new Error(labels.failed)); }
          else { response.on("error", () => {}); resolve(response); }
        });
        headersTimer = setTimeout(() => req.destroy(new Error(labels.headers)), 10_000);
        headersTimer.unref();
        req.setTimeout(30_000, () => req.destroy(new Error(labels.idle)));
        req.once("error", error => { clearTimeout(headersTimer); reject(error); });
        req.once("close", () => clearTimeout(headersTimer));
      });
    },
  };
}

/** A byte-array BodyInit is copied wholesale by fetch; a stream keeps our work and fetch's buffering bounded. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0, canceled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await yieldTurn();
      if (canceled) return;
      if (offset === bytes.byteLength) { controller.close(); return; }
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      offset += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { canceled = true; },
  });
}

/** A whole read object's bytes, or null when it is missing; the body is always released. */
export async function collect(object: { readonly body: Readable } | null): Promise<Uint8Array | null> {
  if (object === null) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
    return new Uint8Array(Buffer.concat(chunks));
  } finally { object.body.destroy(); }
}
