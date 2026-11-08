/// <reference types="node" />
import { gcsBucket } from "../store/gcs.js";

export { ReplayCreateError } from "../store/gcs.js";

/** Immutable public recordings and readable sidecars; never raw/private JSONL logs. */
export type ReplayObject = {
  readonly name: string;
  readonly body: Uint8Array;
  readonly ifGenerationMatch: 0;
} & (
  | { readonly contentType: "application/octet-stream"; readonly contentEncoding?: "gzip" }
  | { readonly contentType: "application/json"; readonly contentEncoding?: never }
);

export interface ReplayStore {
  create(object: ReplayObject): Promise<void>;
}

/**
 * Cloud Run service identity, not a key file. Nothing is requested until create.
 * GCS objects.insert: media upload, contentEncoding metadata and generation-zero
 * precondition. A collision is a failure, never an overwrite or a retry.
 */
export function createGcsReplayStore(bucket: string, request: typeof fetch = fetch): ReplayStore {
  const objects = gcsBucket(bucket, request);
  return { create: object => objects.upload({ ...object, stream: true }) };
}

/** No bucket means no store, token request, upload, or new log output. */
export function replayStoreFromEnv(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch): ReplayStore | undefined {
  const bucket = env.ANTWAR_REPLAY_BUCKET;
  return bucket ? createGcsReplayStore(bucket, request) : undefined;
}
