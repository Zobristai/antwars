// Noise-check coordination between participants that meet in the store. They share one sticky session directory
// (see store.ts). Every file is published whole through the store's write path (a fresh temporary file renamed, or
// hard-linked for first-writer-wins files, into place), so a reader never sees a partial file, and every read refuses
// links and files owned by another user.
import { join } from "node:path";
import { storeHas, storeList, storeReadText, storeSharedDir, storeWrite, storeWriteOnce } from "./store.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The arguments a local-mode participant is started with: every parsed option except the coordinator's own, plus its role. */
export function participantArgs(values: Record<string, string | boolean | undefined>, command: string, role: { session: string; participant: string; expect: number; store: string }): string[] {
  const own = new Set(["local", "session", "participant", "expect", "store"]);
  const args = [command];
  for (const [name, value] of Object.entries(values)) {
    if (own.has(name) || value === undefined || value === false) continue;
    args.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  return [...args, `--session=${role.session}`, `--participant=${role.participant}`, `--expect=${role.expect}`, `--store=${role.store}`];
}

export interface Participation {
  /** The store root, and the session directory inside it. */
  readonly root: string;
  readonly dir: string;
  readonly me: string;
  readonly expect: number;
  /** How long admission stays open, and how long to wait for every admitted participant to be ready and to finish. */
  readonly waitMs: number;
  readonly finishMs: number;
  /** Called once admitted, before readiness: build what the measurement needs. */
  readonly prepare: (admitted: readonly string[]) => Promise<void> | void;
  /** This participant's measurement; its result is published for the others. */
  readonly measure: () => Promise<unknown>;
  /** The same load as the measurement, run after it until every participant has finished, then aborted. */
  readonly load: (signal: AbortSignal) => Promise<void>;
  readonly pollMs?: number;
}
export type Outcome =
  | { readonly refused: string; readonly admitted: readonly string[] }
  | { readonly admitted: readonly string[]; readonly waitedMs: number; readonly results: readonly unknown[]; readonly heldLoadMs: number };

/**
 * Admission, then a readiness barrier, then the measurement. A participant that finishes keeps the same load running
 * until every admitted participant has published its result, so each measurement runs under the whole concurrent load.
 */
export async function participate(p: Participation): Promise<Outcome> {
  const poll = p.pollMs ?? 500, shared = { shared: true };
  if (!/^[A-Za-z0-9_-]+$/.test(p.me)) throw new Error(`participant name ${p.me} must be letters, digits, - or _`);
  storeSharedDir(p.root, p.dir);
  const file = (kind: string, who: string) => join(p.dir, `${kind}-${who}.json`);
  const has = (path: string) => storeHas(p.root, path, shared);
  const read = (path: string) => JSON.parse(storeReadText(p.root, path, shared)) as unknown;
  const admittedFile = join(p.dir, "admitted.json");
  if (has(admittedFile)) throw new Error(`noise session ${p.dir} has already closed admission`);
  const t0 = Date.now();
  storeWriteOnce(p.root, file("arrival", p.me), JSON.stringify({ at: new Date().toISOString() }), shared);
  while (!has(admittedFile)) {
    const arrived = storeList(p.root, p.dir, shared).filter(n => /^arrival-.*\.json$/.test(n)).map(n => n.slice("arrival-".length, -".json".length));
    if (arrived.length >= p.expect || Date.now() - t0 >= p.waitMs) storeWriteOnce(p.root, admittedFile, JSON.stringify({ admitted: arrived, closedAt: new Date().toISOString() }), shared);
    else await sleep(poll);
  }
  const { admitted } = read(admittedFile) as { admitted: string[] };
  const waitedMs = Date.now() - t0;
  if (!admitted.includes(p.me)) return { refused: "arrived after admission closed", admitted };

  const all = async (kind: string, what: string) => {
    const t = Date.now();
    while (!admitted.every(a => has(file(kind, a)))) {
      if (Date.now() - t > p.finishMs) throw new Error(`noise session ${p.dir}: not every admitted participant was ${what} within ${p.finishMs / 1000} s`);
      await sleep(poll);
    }
  };
  await p.prepare(admitted);
  storeWrite(p.root, file("ready", p.me), JSON.stringify({ at: new Date().toISOString() }), shared);
  await all("ready", "ready");

  const result = await p.measure();
  storeWrite(p.root, file("result", p.me), JSON.stringify(result), shared);
  const t1 = Date.now(), stop = new AbortController();
  const held = (async () => {
    while (!stop.signal.aborted) {
      try { await p.load(stop.signal); } catch (e) { if (!stop.signal.aborted) throw e; }
    }
  })();
  try { await all("result", "finished"); } finally { stop.abort(); }
  await held;
  const results = admitted.map(a => read(file("result", a)));
  return { admitted, waitedMs, results, heldLoadMs: Date.now() - t1 };
}
