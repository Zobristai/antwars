/// <reference types="node" />
import { createGcsObjectReader, isReplayId, type ReplayGet } from "../replays/access.js";
import { createGcsReplayStore, ReplayCreateError } from "../replays/store.js";
import { collect, gcsBucket } from "../store/gcs.js";

/** Inputs, and failure markers scoped to the service's code version (the only markers the service writes). */
export type InputObjectName =
  | { readonly kind: "input"; readonly id: string }
  | { readonly kind: "marker"; readonly id: string; readonly n: number; readonly codeVersion: string };

export function markerName(id: string, n: number, codeVersion: string): string {
  if (!isReplayId(id)) throw new Error("invalid replay id");
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid failure number");
  if (!/^[0-9a-f]{40}$/.test(codeVersion)) throw new Error("invalid service code version");
  return `${id}.failed-${codeVersion}-${n}`;
}

/** null for anything the service did not and would not write; such objects are left alone. */
export function parseInputObjectName(name: string): InputObjectName | null {
  const m = /^(.+)\.(?:input|failed-([0-9a-f]{40})-([1-9]\d*))$/.exec(name);
  if (m === null || !isReplayId(m[1]!)) return null;
  if (m[3] === undefined) return { kind: "input", id: m[1]! };
  const n = Number(m[3]);
  return Number.isSafeInteger(n) ? { kind: "marker", id: m[1]!, n, codeVersion: m[2]! } : null;
}

/**
 * Deploy overlap signal: an object `running/<full commit>` in the input bucket declares that a records
 * builder of that build is running beside another. Written and removed by the deploy (deploy/cloud-run/deploy.sh),
 * never by the service, which only reads it from its listing; see createRecordService for the rule it drives.
 */
export function runningBuildName(codeVersion: string): string {
  if (!/^[0-9a-f]{40}$/.test(codeVersion)) throw new Error("invalid build code version");
  return `running/${codeVersion}`;
}

/** The declared build's full commit, or null for any other name. */
export function parseRunningBuildName(name: string): string | null {
  return /^running\/([0-9a-f]{40})$/.exec(name)?.[1] ?? null;
}

export interface InputStore {
  /** Every object name in the bucket across all list pages, sorted. */
  list(): Promise<string[]>;
  /** null means the object is missing. */
  get(name: string): Promise<Uint8Array | null>;
  /** Create-only; false means the marker already exists (another process counted it). */
  createMarker(id: string, n: number, reason: string, codeVersion: string): Promise<boolean>;
  /** Reads a marker's recorded reason; null if the marker is missing. */
  markerReason(id: string, n: number, codeVersion: string): Promise<string | null>;
  /** An object that is already gone counts as deleted. */
  delete(name: string): Promise<void>;
}

/** Cloud Run service identity; no key file. Provider bodies are never retained or logged. */
export function createGcsInputStore(bucket: string, request: typeof fetch = fetch, get?: ReplayGet): InputStore {
  const read = createGcsObjectReader(bucket, request, get);
  const markers = createGcsReplayStore(bucket, request);
  const objects = gcsBucket(bucket, request);
  const store: InputStore = {
    async list() {
      const names: string[] = [];
      const seen = new Set<string>();
      let token: string | undefined;
      do {
        const response = await objects.call(objects.url(undefined, { fields: "items(name),nextPageToken", maxResults: "1000", pageToken: token }), { method: "GET" });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`input bucket list failed: HTTP ${response.status}`); }
        const page = await response.json() as { items?: { name: string }[]; nextPageToken?: string };
        for (const item of page.items ?? []) names.push(item.name);
        token = page.nextPageToken || undefined;
        if (token !== undefined) {
          if (seen.has(token)) throw new Error("input bucket listing repeated a page token");
          seen.add(token);
        }
      } while (token !== undefined);
      return names.sort();
    },
    get: async name => collect(await read(name, AbortSignal.timeout(300_000))),
    async createMarker(id, n, reason, codeVersion) {
      const body = new TextEncoder().encode(JSON.stringify({ reason }));
      try {
        await markers.create({ name: markerName(id, n, codeVersion), body, contentType: "application/json", ifGenerationMatch: 0 });
        return true;
      } catch (error) {
        if (error instanceof ReplayCreateError && error.status === 412) return false;
        throw error;
      }
    },
    async markerReason(id, n, codeVersion) {
      const bytes = await store.get(markerName(id, n, codeVersion));
      if (bytes === null) return null;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof parsed !== "object" || parsed === null || !("reason" in parsed) || typeof parsed.reason !== "string") {
        throw new Error("failure marker has no reason");
      }
      return parsed.reason;
    },
    async delete(name) {
      const response = await objects.call(objects.url(name), { method: "DELETE" });
      await response.body?.cancel();
      if (response.status === 404 || response.ok) return;
      throw new Error(`input bucket delete failed: HTTP ${response.status}`);
    },
  };
  return store;
}
