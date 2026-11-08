/// <reference types="node" />
import { createGcsReplayStore, ReplayCreateError, type ReplayStore } from "../replays/store.js";
import { encodeInput, inputName, type RecordInput } from "./inputs.js";
import type { Activity } from "../slots/activity.js";

/** A finished match's inputs as the game server holds them; the handoff adds the code version. */
export type MatchInputs = Omit<RecordInput, "codeVersion">;

/** Game-server side of the record service: hands each finished match's inputs to private storage. */
export interface RecordHandoff {
  /** Returns at once; the write and any retries run in the background and never throw. */
  submit(inputs: MatchInputs): void;
  /**
   * The shutdown signal's drain: every input still unstored is retried at once, then at the
   * shortest delay while withinMs lasts. Resolves once all are stored or the time is up, having logged each
   * input still unstored by its match id. Optional: a handoff that never holds inputs has nothing to drain.
   */
  drain?(withinMs: number): Promise<void>;
}

/** Waits between attempts; the last one repeats until the inputs are stored. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000];

export interface RecordHandoffDeps {
  /** Create-only writer for the private input bucket. */
  store: ReplayStore;
  /** Full commit this game server runs (ANTWAR_CODE_VERSION). */
  codeVersion: string;
  log?: (line: string) => void;
  delays?: readonly number[];
  /** This match server's outstanding work: one hold per submission until its inputs are stored. */
  activity?: Activity;
}

/**
 * Writes `<id>.input` create-only. Stored means GCS accepted it, or a retry found it already present (412):
 * from then the record service owns the match. Any other failure logs the actual error and retries from
 * the encoded bytes held here, so play is never blocked and nothing is rebuilt on the game server.
 * With an activity, each encoded submission holds it until stored, so the server is not idle meanwhile.
 */
export function createRecordHandoff(deps: RecordHandoffDeps): RecordHandoff {
  const log = deps.log ?? ((line: string) => console.error(line));
  const delays = deps.delays ?? RETRY_DELAYS_MS;
  /** Submissions not yet stored, each with its waiting retry, if any. */
  const pending = new Set<Pending>();
  let allStored: (() => void)[] = [];
  /** While a drain lasts, a failed write retries at the shortest delay. */
  let drainingUntil = 0;
  return {
    submit(inputs) {
      let name: string, body: Uint8Array;
      try {
        name = inputName(inputs.id);
        body = encodeInput({ ...inputs, codeVersion: deps.codeVersion });
      } catch (error) {
        log(`antwar record ${inputs.id} input not handed off: ${message(error)}`);
        return;
      }
      const release = deps.activity?.hold(`record input ${inputs.id}`) ?? (() => {});
      const stored = (): void => {
        release();
        pending.delete(entry);
        if (pending.size > 0) return;
        const waiting = allStored;
        allStored = [];
        for (const resolve of waiting) resolve();
      };
      const entry: Pending = {
        id: inputs.id, attempt: 0, error: null, retry: null,
        async write() {
          entry.attempt += 1;
          try {
            await deps.store.create({ name, body, contentType: "application/octet-stream", ifGenerationMatch: 0 });
            stored();
          } catch (error) {
            if (error instanceof ReplayCreateError && error.status === 412) return stored();
            entry.error = message(error);
            const scheduled = delays[Math.min(entry.attempt - 1, delays.length - 1)]!;
            const delay = Date.now() < drainingUntil ? Math.min(scheduled, delays[0]!) : scheduled;
            log(`antwar record ${inputs.id} input store failed (attempt ${entry.attempt}), retrying in ${delay} ms: ${entry.error}`);
            entry.retry = setTimeout(() => { entry.retry = null; void entry.write(); }, delay).unref();
          }
        },
      };
      pending.add(entry);
      void entry.write();
    },
    async drain(withinMs) {
      if (pending.size === 0) return;
      drainingUntil = Date.now() + withinMs;
      for (const entry of pending) {
        if (entry.retry === null) continue;
        clearTimeout(entry.retry);
        entry.retry = null;
        void entry.write();
      }
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([new Promise<void>((resolve) => allStored.push(resolve)), new Promise<void>((resolve) => { deadline = setTimeout(resolve, withinMs); })]);
      clearTimeout(deadline);
      for (const entry of pending) {
        log(`antwar record ${entry.id} input not stored before shutdown after ${entry.attempt} attempt(s), so its replay and public record will not appear: ${entry.error ?? "its first write had not finished"}`);
      }
    },
  };
}

/**
 * Optional: no ANTWAR_RECORD_INPUT_BUCKET means no handoff (local and preview servers). With the bucket set,
 * ANTWAR_CODE_VERSION must be the full commit this server was deployed from, checked once at start-up.
 * A slot server passes its slot's activity, which each pending handoff holds.
 */
export function recordHandoffFromEnv(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch, activity?: Activity): RecordHandoff | undefined {
  const bucket = env.ANTWAR_RECORD_INPUT_BUCKET;
  if (!bucket) return undefined;
  const codeVersion = env.ANTWAR_CODE_VERSION ?? "";
  if (!/^[0-9a-f]{40}$/.test(codeVersion)) throw new Error("ANTWAR_RECORD_INPUT_BUCKET needs ANTWAR_CODE_VERSION, the full 40-character commit");
  return createRecordHandoff({ store: createGcsReplayStore(bucket, request), codeVersion, activity });
}

/** One submission awaiting storage: its attempts so far, the last failure and the retry waiting, if any. */
interface Pending {
  readonly id: string;
  attempt: number;
  error: string | null;
  retry: NodeJS.Timeout | null;
  write(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
