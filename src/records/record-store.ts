import { isReplayId } from "../replays/access.js";
import { openPrivateMedia, privateMediaName, sealPrivateMedia, type PrivateMediaIdentity } from "../replays/private-media.js";
import { metadataAccessToken } from "../auth/metadata-token.js";
import { ReplayCreateError } from "../replays/store.js";
import { gcsBucket } from "../store/gcs.js";

export type RecordSave = {
  /** Only this result permits deleting the private input. */
  complete: boolean;
  outcome: "record created" | "unavailable record replaced" | "existing record preserved";
} | {
  complete: true;
  outcome: "complete record already present";
  /** The complete record already stored, decrypted when private, so its caller can check what it carries. Never logged. */
  stored: Uint8Array;
};
export interface RecordTarget { save(body: Uint8Array): Promise<RecordSave> }
export interface RecordStore {
  /** Missing private encryption holds private inputs; it never substitutes a public target. */
  forMatch(id: string, lobbyId: string | null): RecordTarget | undefined;
}

/** Validate persistence identity/status before treating any stored bytes as a complete record. */
export function recordStatus(body: Uint8Array, id: string): "complete" | "partial" | "unavailable" {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (typeof value !== "object" || value === null) throw new Error("invalid match record");
  const record = value as Record<string, unknown>;
  if (record.format !== "antwar.match" || record.version !== 1 || record.id !== id ||
      !Array.isArray(record.unavailable) || !record.unavailable.every(reason => typeof reason === "string") ||
      !(record.status === "complete" && record.source === "match-log" ||
        record.status === "partial" && record.source === "binary" ||
        record.status === "unavailable" && record.source === "unavailable")) {
    throw new Error("invalid match record identity or status");
  }
  return record.status as "complete" | "partial" | "unavailable";
}

/**
 * Record-only GCS writer. Binaries and the replay store remain create-only. Replacement is a single
 * generation-conditioned upload, never a delete followed by create. Reads pin the same generation
 * as the subsequent precondition, including for authenticated private ciphertext.
 */
export function createGcsRecordStore(bucket: string, key: Uint8Array | undefined, request: typeof fetch = fetch): RecordStore {
  if (key !== undefined && key.byteLength !== 32) throw new Error("Private media encryption is not configured");
  const secret = key === undefined ? undefined : Buffer.from(key);
  const objects = gcsBucket(bucket, request);
  /** Buffered, by fetch, with one token for the metadata and the media read pinned to the generation it reports. */
  async function read(name: string): Promise<{ body: Uint8Array; generation: string } | null> {
    const token = await metadataAccessToken(request);
    const meta = await objects.call(objects.url(name, { fields: "generation" }), { token });
    if (meta.status === 404) { await meta.body?.cancel(); return null; }
    if (!meta.ok) { await meta.body?.cancel(); throw new Error(`record metadata read failed: HTTP ${meta.status}`); }
    const value: unknown = await meta.json();
    if (typeof value !== "object" || value === null || !("generation" in value) ||
        typeof value.generation !== "string" || !/^[1-9]\d*$/.test(value.generation)) {
      throw new Error("record metadata has no valid generation");
    }
    const response = await objects.call(objects.url(name, { alt: "media", generation: value.generation }), { token });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`record read failed: HTTP ${response.status}`); }
    return { body: new Uint8Array(await response.arrayBuffer()), generation: value.generation };
  }
  return {
    forMatch(id, lobbyId) {
      if (!isReplayId(id)) throw new Error("invalid replay id");
      if (lobbyId !== null && !lobbyId) throw new Error("Invalid private lobby");
      if (lobbyId !== null && secret === undefined) return undefined;
      const identity: PrivateMediaIdentity | undefined = lobbyId === null ? undefined : { lobbyId, replayId: id, kind: "match-record" };
      const name = identity === undefined ? `${id}.json` : privateMediaName(identity);
      return {
        async save(body) {
          const status = recordStatus(body, id);
          const sealed = identity === undefined ? body : sealPrivateMedia(identity, body, secret);
          let generation = "0";
          // A racing writer must be re-read. Bound churn; the caller retains input and retries later.
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              // The only upload at a non-zero generation: one this store read, never a binary (one buffer, as records are small).
              await objects.upload({ name, body: sealed, contentType: identity === undefined ? "application/json" : "application/octet-stream",
                ifGenerationMatch: generation, stream: false });
              return { complete: status === "complete", outcome: generation === "0" ? "record created" : "unavailable record replaced" };
            } catch (error) {
              if (!(error instanceof ReplayCreateError && error.status === 412)) throw error;
            }
            const existing = await read(name);
            if (existing === null) { generation = "0"; continue; }
            const plaintext = identity === undefined ? existing.body : openPrivateMedia(identity, existing.body, secret);
            const storedStatus = recordStatus(plaintext, id);
            if (storedStatus === "complete") return { complete: true, outcome: "complete record already present", stored: plaintext };
            if (storedStatus !== "unavailable" || status !== "complete") return { complete: false, outcome: "existing record preserved" };
            generation = existing.generation;
          }
          throw new Error("record changed during save; input retained");
        },
      };
    },
  };
}
