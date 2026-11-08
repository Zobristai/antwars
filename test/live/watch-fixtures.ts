import type { Fields, Store } from "../../src/store/firestore.ts";

/** Unit seam only; real cross-process Firestore coverage is separate. */
export function memoryWatchStore() {
  const docs = new Map<string, Fields>();
  const store: Store = {
    namespace: "watch-test",
    async get(path) { return docs.get(path) ?? null; },
    async transaction(step) {
      const next = await step(async paths => new Map(paths.map(path => [path, docs.get(path) ?? null])));
      for (const write of next.writes) {
        if (write.op === "delete") docs.delete(write.path);
        else {
          if (write.op === "create" && docs.has(write.path)) throw new Error("already exists");
          docs.set(write.path, { ...(write.op === "update" ? docs.get(write.path) : {}), ...write.fields });
        }
      }
      return next.result;
    },
    async query(collection, options) {
      // Firestore order: the field, then the document name, both by code unit; startAfter is a (value, name) position.
      const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
      const all = [...docs].filter(([path]) => path.startsWith(`${collection}/`) && docs.get(path)![options.orderBy] !== undefined)
        .map(([path, fields]) => ({ path, fields }))
        .sort((a, b) => compare(a.fields[options.orderBy]!, b.fields[options.orderBy]!) || compare(a.path, b.path));
      const after = options.startAfter;
      const rows = after ? all.filter(row => (compare(row.fields[options.orderBy]!, after.value) || compare(row.path, after.path)) > 0) : all;
      return { rows: rows.slice(0, options.limit), readTime: "2026-10-20T00:00:00Z" };
    },
  };
  return { docs, store };
}

/** The lobby's match as beginMatch/adoptMatch leave it, held by runId: the registry fences playback-end and replay-id writes on it. */
export function holdMatch(docs: Map<string, Fields>, lobbyId: string, runId: string) {
  docs.set(`lobbies/${lobbyId}`, { ...docs.get(`lobbies/${lobbyId}`), matchRunId: runId });
}
