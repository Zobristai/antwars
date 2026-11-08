/// <reference types="node" />
import type { Readable } from "node:stream";
import { metadataAccessToken } from "../auth/metadata-token.js";
import { gcsBucket, type ReplayGet } from "../store/gcs.js";

export type { ReplayGet } from "../store/gcs.js";

export interface ReplayRead {
  readonly body: Readable;
  readonly contentLength?: string;
}

export interface ReplaySource {
  /** null means the object is missing. The caller owns and must consume/destroy the body. */
  open(id: string, signal: AbortSignal): Promise<ReplayRead | null>;
}

/** Only ids emitted by replayId: an exact UTC millisecond timestamp and positive safe sequence. */
export function isReplayId(id: string): boolean {
  if (id.length > 41) return false;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([1-9]\d*)$/.exec(id);
  if (m === null || !Number.isSafeInteger(Number(m[6]))) return false;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso;
}

/**
 * Authenticated raw media read; never decompresses or buffers the object.
 * Accept-Encoding: gzip prevents GCS's decompressive transcoding. Object metadata
 * can mislabel legacy raw bytes as gzip; the route sniffs bytes, not that label. Header and
 * idle deadlines are bounded; a slow, progressing download has no total-size
 * buffer or total-time deadline. The caller's abort closes the upstream too.
 */
export function createGcsReplaySource(bucket: string, tokenFetch: typeof fetch = fetch, get?: ReplayGet): ReplaySource {
  return {
    async open(id, signal) {
      if (!isReplayId(id)) throw new Error("invalid replay id");
      return createGcsObjectReader(bucket, tokenFetch, get)(`${id}.bin`, signal);
    },
  };
}

const LABELS = { failed: "replay bucket read failed", headers: "replay read headers timed out", idle: "replay read idle timeout" };

/** Internal object transport; public routes MUST retain their own identifier validation. */
export function createGcsObjectReader(bucket: string, tokenFetch: typeof fetch = fetch, get?: ReplayGet): (name: string, signal: AbortSignal) => Promise<ReplayRead | null> {
  const objects = gcsBucket(bucket, tokenFetch, get);
  return async (name, signal) => {
    const response = await objects.open(name, await metadataAccessToken(tokenFetch, signal), signal, LABELS);
    if (response === null) return null;
    const length = response.headers["content-length"];
    return { body: response, ...(typeof length === "string" && /^\d+$/.test(length) ? { contentLength: length } : {}) };
  };
}

/** Unset bucket is inert: no read route, metadata token, or object request. */
export function replaySourceFromEnv(env: Readonly<Record<string, string | undefined>>, tokenFetch: typeof fetch = fetch, get?: ReplayGet): ReplaySource | undefined {
  return env.ANTWAR_REPLAY_BUCKET ? createGcsReplaySource(env.ANTWAR_REPLAY_BUCKET, tokenFetch, get) : undefined;
}
