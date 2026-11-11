/// <reference types="node" />
import { setTimeout as sleep } from "node:timers/promises";
import { metadataAccessToken } from "../auth/metadata-token.js";

/**
 * Minimal Firestore Native REST client for the shared store. It follows
 * the contract captured: beginTransaction, batchGet, commit and
 * rollback, with the whole transaction retried on ABORTED, and runQuery for ordered
 * reads. Every document path is
 * relative to namespaces/{namespace}/ and every namespace uses the same collection
 * IDs, so preview and live data share one database and its indexes but never
 * documents. Only string fields are stored.
 */

export type Fields = Readonly<Record<string, string>>;

/** A path relative to the namespace, such as "usernames/alice". */
export type DocPath = string;

export type Write =
  | { readonly op: "create"; readonly path: DocPath; readonly fields: Fields }
  | { readonly op: "update"; readonly path: DocPath; readonly fields: Fields }
  | { readonly op: "delete"; readonly path: DocPath };

/** Reads made inside the transaction; a missing document is null. */
export type TransactionRead = (paths: readonly DocPath[]) => Promise<ReadonlyMap<DocPath, Fields | null>>;

/** No writes commits nothing: the transaction is rolled back and the result returned. */
export interface TransactionStep<T> {
  readonly result: T;
  readonly writes: readonly Write[];
  /**
   * The commit must end by this instant (epoch ms, the store's clock). Checked as the commit RPC is
   * launched: once passed, nothing is committed, the transaction is rolled back and late returned;
   * otherwise the commit RPC is abandoned at the deadline if that comes before its usual timeout.
   */
  readonly commitBy?: { readonly at: number; readonly late: T };
}

/**
 * An ordered read of one collection directly under the namespace: by one string
 * field, then by document name in the same direction.
 */
export interface QueryOptions {
  readonly orderBy: string;
  readonly direction: "ASCENDING" | "DESCENDING";
  readonly limit: number;
  /** Start just after this position: the ordered field's value and the document's path. */
  readonly startAfter?: { readonly value: string; readonly path: DocPath };
  /** Read the database as of this Firestore timestamp, passed through verbatim; absent, a strong read. */
  readonly readTime?: string;
}

export interface QueryResult {
  readonly rows: readonly { readonly path: DocPath; readonly fields: Fields }[];
  /** The time the query read at, verbatim as Firestore returned it. */
  readonly readTime: string;
}

export interface Store {
  readonly namespace: string;
  /** Strongly consistent single-document read outside any transaction. */
  get(path: DocPath): Promise<Fields | null>;
  /** Runs step against fresh transactional reads; on ABORTED the whole step runs again. */
  transaction<T>(step: (read: TransactionRead) => Promise<TransactionStep<T>>): Promise<T>;
  /** One page of an ordered query; nothing is retried. */
  query(collectionId: string, options: QueryOptions): Promise<QueryResult>;
  /**
   * Read-only, outside any transaction: each document's Firestore createTime, verbatim, or null where it is missing.
   * A later write to the document leaves its createTime unchanged. Any number of paths, read in batches.
   */
  createTimes?(paths: readonly DocPath[]): Promise<ReadonlyMap<DocPath, string | null>>;
}

/** Documents per batchGet in createTimes. */
export const CREATE_TIME_BATCH = 100;

export interface StoreConfig {
  readonly projectId: string;
  readonly namespace: string;
  /**
   * host:port of the Firestore emulator; when set, no Google credential is used. Passing it
   * is an explicit dev/test choice; from the environment, firestoreFromEnv guards it.
   */
  readonly emulatorHost?: string;
  readonly request?: typeof fetch;
  /** The clock commit deadlines are read on; Date.now unless a test supplies one. */
  readonly now?: () => number;
}

/** A Firestore error, classified by the response body's error.status, never by HTTP code alone. */
export class FirestoreError extends Error {
  // Explicit fields, not constructor parameter properties: `npm start` runs this
  // source through Node's type stripping, which refuses parameter properties.
  readonly operation: string;
  readonly httpStatus: number;
  readonly status: string | undefined;
  constructor(operation: string, httpStatus: number, status: string | undefined) {
    super(`firestore ${operation} failed: HTTP ${httpStatus} ${status ?? "unknown status"}`);
    this.operation = operation;
    this.httpStatus = httpStatus;
    this.status = status;
  }
}

const NAMESPACE = /^[a-z0-9-]{1,63}$/;
export const MAX_TRANSACTION_ATTEMPTS = 10;
/**
 * Every Firestore RPC, the commit included, is abandoned after this long. A transaction's attempts
 * each rerun its step, so a check made as the step's last action precedes each attempt's commit RPC
 * by no more than this bound.
 */
export const FIRESTORE_RPC_TIMEOUT_MS = 30_000;

/** A commit deadline that had already passed when its RPC was to be launched; nothing was sent. */
class CommitDeadlinePassed extends Error {}

export function createFirestore(config: StoreConfig): Store {
  if (!NAMESPACE.test(config.namespace)) throw new Error("invalid store namespace: use 1-63 of a-z, 0-9 and -");
  const request = config.request ?? fetch;
  const now = config.now ?? Date.now;
  const database = `projects/${config.projectId}/databases/(default)`;
  const prefix = `${database}/documents/namespaces/${config.namespace}/`;
  const origin = config.emulatorHost ? `http://${config.emulatorHost}` : "https://firestore.googleapis.com";
  const token = () => config.emulatorHost ? Promise.resolve("owner") : metadataAccessToken(request);

  async function call(operation: string, url: string, init: { method: string; body?: unknown }, bearer: string, deadline?: number): Promise<unknown> {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    // Read at launch, with nothing awaited before the request is sent: a deadline passed by then sends nothing.
    const timeout = deadline === undefined ? FIRESTORE_RPC_TIMEOUT_MS : Math.min(FIRESTORE_RPC_TIMEOUT_MS, deadline - now());
    if (!(timeout > 0)) throw new CommitDeadlinePassed();
    const response = await request(url, {
      method: init.method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return body;
    throw new FirestoreError(operation, response.status, errorStatus(body));
  }
  const rpc = (method: string, body: unknown, bearer: string, deadline?: number) =>
    call(method, `${origin}/v1/${database}/documents:${method}`, { method: "POST", body }, bearer, deadline);

  return {
    namespace: config.namespace,

    async get(path) {
      const url = `${origin}/v1/${prefix}${path.split("/").map(encodeURIComponent).join("/")}`;
      try {
        return decodeFields(await call("get", url, { method: "GET" }, await token()));
      } catch (error) {
        if (error instanceof FirestoreError && error.status === "NOT_FOUND") return null;
        throw error;
      }
    },

    async transaction<T>(step: (read: TransactionRead) => Promise<TransactionStep<T>>): Promise<T> {
      const bearer = await token();
      // Rollback only releases locks: its own failure is ignored, so it can neither
      // trigger a retry nor replace the error that ended the attempt.
      const rollback = (transaction: string) => rpc("rollback", { transaction }, bearer).then(() => undefined, () => undefined);
      const attempt = async (): Promise<T> => {
        const begun = await rpc("beginTransaction", { options: { readWrite: {} } }, bearer);
        const transaction = (begun as { transaction?: unknown }).transaction;
        if (typeof transaction !== "string") throw new Error("firestore beginTransaction returned no transaction");
        const read: TransactionRead = async (paths) => {
          const results = await rpc("batchGet", { documents: paths.map((path) => prefix + path), transaction }, bearer);
          return decodeBatch(results, prefix, paths);
        };
        let outcome: TransactionStep<T>;
        try {
          outcome = await step(read);
        } catch (error) {
          await rollback(transaction);
          throw error;
        }
        if (outcome.writes.length === 0) {
          await rollback(transaction);
          return outcome.result;
        }
        const commit = { transaction, writes: outcome.writes.map((write) => encodeWrite(write, prefix)) };
        try {
          await rpc("commit", commit, bearer, outcome.commitBy?.at);
        } catch (error) {
          if (!(error instanceof CommitDeadlinePassed)) throw error;
          await rollback(transaction);
          return outcome.commitBy!.late;
        }
        return outcome.result;
      };
      // ABORTED from beginTransaction, a transactional read or the commit reruns the
      // whole transaction against fresh reads; nothing else is retried.
      for (let attempts = 1; ; attempts++) {
        try {
          return await attempt();
        } catch (error) {
          if (!(error instanceof FirestoreError) || error.status !== "ABORTED" || attempts >= MAX_TRANSACTION_ATTEMPTS) throw error;
          // The emulator reports a lock conflict after about 2 s; jitter keeps two
          // retrying contenders from colliding again in step.
          await sleep(Math.random() * 100 * 2 ** Math.min(attempts, 4));
        }
      }
    },

    async createTimes(paths) {
      const bearer = await token();
      const out = new Map<DocPath, string | null>();
      for (let i = 0; i < paths.length; i += CREATE_TIME_BATCH) {
        const batch = paths.slice(i, i + CREATE_TIME_BATCH);
        const results = await rpc("batchGet", { documents: batch.map((path) => prefix + path), mask: { fieldPaths: [] } }, bearer);
        for (const result of Array.isArray(results) ? results : []) {
          const found = (result as { found?: { name?: unknown; createTime?: unknown } }).found;
          const missing = (result as { missing?: unknown }).missing;
          if (found && typeof found.name === "string" && found.name.startsWith(prefix)) {
            if (typeof found.createTime !== "string") throw new Error(`firestore batchGet returned no createTime for ${found.name.slice(prefix.length)}`);
            out.set(found.name.slice(prefix.length), found.createTime);
          } else if (typeof missing === "string" && missing.startsWith(prefix)) out.set(missing.slice(prefix.length), null);
        }
        for (const path of batch) if (!out.has(path)) throw new Error(`firestore batchGet returned no result for ${path}`);
      }
      return out;
    },

    async query(collectionId, options) {
      const structuredQuery: Record<string, unknown> = {
        from: [{ collectionId }],
        orderBy: [
          { field: { fieldPath: options.orderBy }, direction: options.direction },
          { field: { fieldPath: "__name__" }, direction: options.direction },
        ],
        limit: options.limit,
      };
      if (options.startAfter) {
        structuredQuery.startAt = {
          values: [{ stringValue: options.startAfter.value }, { referenceValue: prefix + options.startAfter.path }],
          before: false,
        };
      }
      const body: Record<string, unknown> = { structuredQuery };
      if (options.readTime !== undefined) body.readTime = options.readTime;
      const url = `${origin}/v1/${prefix.slice(0, -1)}:runQuery`;
      const results = await call("runQuery", url, { method: "POST", body }, await token());
      // An element without a document is progress or an empty result, never a row.
      // readTime may increase along the stream, and only the last one is a time at
      // which every streamed document still held its returned value, so it is the
      // one kept (progress-only elements included).
      let readTime: string | undefined;
      const rows: { path: DocPath; fields: Fields }[] = [];
      for (const result of Array.isArray(results) ? results : []) {
        const element = result as { readTime?: unknown; document?: { name?: unknown } };
        if (typeof element.readTime === "string") readTime = element.readTime;
        const name = element.document?.name;
        if (typeof name === "string" && name.startsWith(prefix)) rows.push({ path: name.slice(prefix.length), fields: decodeFields(element.document) });
      }
      if (readTime === undefined) throw new Error("firestore runQuery returned no readTime");
      return { rows, readTime };
    },
  };
}

const LOOPBACK_HOST_PORT = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

/**
 * No namespace means no store, never a shared default. A namespace with no GCLOUD_PROJECT is refused:
 * there is no fallback Google project. FIRESTORE_EMULATOR_HOST selects the
 * unauthenticated plain-HTTP emulator only for local dev and test runs: it is
 * refused on Cloud Run (K_SERVICE is set) and for any host that is not a loopback host:port.
 * Callers that pass emulatorHost to createFirestore choose the emulator explicitly.
 */
export function firestoreFromEnv(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch): Store | undefined {
  const namespace = env.ANTWAR_STORE_NAMESPACE;
  if (!namespace) return undefined;
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST || undefined;
  if (emulatorHost !== undefined) {
    if (env.K_SERVICE) throw new Error(`FIRESTORE_EMULATOR_HOST=${emulatorHost} refused: the emulator is for local dev and test runs, and K_SERVICE=${env.K_SERVICE} means this is Cloud Run`);
    if (!LOOPBACK_HOST_PORT.test(emulatorHost)) throw new Error(`FIRESTORE_EMULATOR_HOST=${emulatorHost} refused: the emulator must be a loopback host:port (127.0.0.1, localhost or [::1])`);
  }
  const projectId = env.GCLOUD_PROJECT;
  if (!projectId) throw new Error(`ANTWAR_STORE_NAMESPACE=${namespace} refused: missing GCLOUD_PROJECT, the Google Cloud project of the shared store`);
  return createFirestore({
    projectId,
    namespace,
    emulatorHost,
    request,
  });
}

function errorStatus(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = body.error;
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "string" ? error.status : undefined;
}

function encodeWrite(write: Write, prefix: string): unknown {
  const name = prefix + write.path;
  switch (write.op) {
    case "create":
      return { update: { name, fields: encodeFields(write.fields) }, currentDocument: { exists: false } };
    case "update":
      return { update: { name, fields: encodeFields(write.fields) }, updateMask: { fieldPaths: Object.keys(write.fields) }, currentDocument: { exists: true } };
    case "delete":
      return { delete: name, currentDocument: { exists: true } };
  }
}

function encodeFields(fields: Fields): Record<string, { stringValue: string }> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { stringValue: value }]));
}

function decodeFields(document: unknown): Fields {
  const fields = (document as { fields?: Record<string, { stringValue?: unknown }> } | undefined)?.fields ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value.stringValue !== "string") throw new Error(`firestore field ${key} is not a string`);
    out[key] = value.stringValue;
  }
  return out;
}

/** batchGet results are matched by document name, never by request order. */
function decodeBatch(results: unknown, prefix: string, paths: readonly DocPath[]): Map<DocPath, Fields | null> {
  const out = new Map<DocPath, Fields | null>();
  for (const result of Array.isArray(results) ? results : []) {
    const found = (result as { found?: { name?: unknown } }).found;
    const missing = (result as { missing?: unknown }).missing;
    if (found && typeof found.name === "string" && found.name.startsWith(prefix)) out.set(found.name.slice(prefix.length), decodeFields(found));
    else if (typeof missing === "string" && missing.startsWith(prefix)) out.set(missing.slice(prefix.length), null);
  }
  for (const path of paths) if (!out.has(path)) throw new Error(`firestore batchGet returned no result for ${path}`);
  return out;
}
