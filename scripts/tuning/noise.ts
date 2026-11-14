// Noise-check coordination between participants that meet in the store. Every file is published whole: written under
// a temporary name in <session>/tmp and then renamed (or hard-linked, for first-writer-wins files) into place, so a
// reader never sees a partial file.
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function staged(dir: string, text: string): string {
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, randomUUID());
  writeFileSync(file, text);
  return file;
}

/** Publish a file whole, replacing any earlier version. `dir` is the session directory that owns its tmp folder. */
export function publish(dir: string, file: string, text: string): void {
  renameSync(staged(dir, text), file);
}

/** Publish a file whole unless it already exists; true when this call created it. */
export function publishOnce(dir: string, file: string, text: string): boolean {
  const tmp = staged(dir, text);
  try { linkSync(tmp, file); return true; } catch (e: any) { if (e.code === "EEXIST") return false; throw e; } finally { unlinkSync(tmp); }
}

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
  /** The session directory in the store. */
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

const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/**
 * Admission, then a readiness barrier, then the measurement. A participant that finishes keeps the same load running
 * until every admitted participant has published its result, so each measurement runs under the whole concurrent load.
 */
export async function participate(p: Participation): Promise<Outcome> {
  const poll = p.pollMs ?? 500;
  for (const sub of ["arrivals", "ready", "results"]) mkdirSync(join(p.dir, sub), { recursive: true });
  const admittedFile = join(p.dir, "admitted.json");
  if (existsSync(admittedFile)) throw new Error(`noise session ${p.dir} has already closed admission`);
  const t0 = Date.now();
  publishOnce(p.dir, join(p.dir, "arrivals", p.me), new Date().toISOString());
  while (!existsSync(admittedFile)) {
    const arrived = names(join(p.dir, "arrivals"));
    if (arrived.length >= p.expect || Date.now() - t0 >= p.waitMs) publishOnce(p.dir, admittedFile, JSON.stringify({ admitted: arrived, closedAt: new Date().toISOString() }));
    else await sleep(poll);
  }
  const { admitted } = JSON.parse(readFileSync(admittedFile, "utf8")) as { admitted: string[] };
  const waitedMs = Date.now() - t0;
  if (!admitted.includes(p.me)) return { refused: "arrived after admission closed", admitted };

  const all = async (sub: string, what: string) => {
    const t = Date.now();
    while (!admitted.every(a => existsSync(join(p.dir, sub, `${a}.json`)))) {
      if (Date.now() - t > p.finishMs) throw new Error(`noise session ${p.dir}: not every admitted participant was ${what} within ${p.finishMs / 1000} s`);
      await sleep(poll);
    }
  };
  await p.prepare(admitted);
  publish(p.dir, join(p.dir, "ready", `${p.me}.json`), JSON.stringify({ at: new Date().toISOString() }));
  await all("ready", "ready");

  const result = await p.measure();
  publish(p.dir, join(p.dir, "results", `${p.me}.json`), JSON.stringify(result));
  const t1 = Date.now(), stop = new AbortController();
  const held = (async () => {
    while (!stop.signal.aborted) {
      try { await p.load(stop.signal); } catch (e) { if (!stop.signal.aborted) throw e; }
    }
  })();
  try { await all("results", "finished"); } finally { stop.abort(); }
  await held;
  const results = admitted.map(a => JSON.parse(readFileSync(join(p.dir, "results", `${a}.json`), "utf8")) as unknown);
  return { admitted, waitedMs, results, heldLoadMs: Date.now() - t1 };
}
