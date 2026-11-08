/// <reference types="node" />
import { createServer } from "node:http";
import { privateMediaKey } from "../replays/private-media.js";
import { createGcsRecordReplayStore } from "./replay-store.js";
import { createGcsRecordStore } from "./record-store.js";
import { createGcsInputStore } from "./input-store.js";
import { createRecordService } from "./service.js";

/** Pause between the end of one sweep and the start of the next. */
export const SWEEP_INTERVAL_MS = 2_000;

/**
 * `npm run record-service`: the always-on record service. Every setting is required and the
 * service refuses to start without it, so a missing key never turns into public writes for private lobbies:
 * PORT (health listener, default 8080), ANTWAR_RECORD_INPUT_BUCKET (private inputs), ANTWAR_REPLAY_BUCKET
 * (public records and sealed private records), ANTWAR_PRIVATE_REPLAY_KEY and ANTWAR_CODE_VERSION (the full
 * commit this service was deployed from).
 *
 * Deploy overlap. While a deploy runs two record services side by side, one per build, it declares
 * each running builder with an empty object `running/<full commit>` in ANTWAR_RECORD_INPUT_BUCKET; each
 * service then leaves the other build's inputs to that build's own builder (createRecordService.sweep).
 *
 *   set:   printf '' | gcloud storage cp - gs://<input bucket>/running/<commit>
 *   clear: gcloud storage rm gs://<input bucket>/running/<commit>
 *
 * Clear a build's object once its builder has stopped; the remaining service then builds that build's
 * leftover inputs on its next sweep. An object left behind (for example by an interrupted deploy) keeps that
 * build's inputs waiting until it is removed with the clear command; the service logs when it starts and
 * stops deferring a build. Only services carrying this change read the object, so an overlap with an older
 * record service is not protected by it. No object, as outside a deploy, changes nothing.
 */
export async function startRecordService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const missing = ["ANTWAR_RECORD_INPUT_BUCKET", "ANTWAR_REPLAY_BUCKET", "ANTWAR_PRIVATE_REPLAY_KEY", "ANTWAR_CODE_VERSION"].filter(name => !env[name]);
  let key;
  try {
    if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
    if (!/^[0-9a-f]{40}$/.test(env.ANTWAR_CODE_VERSION!)) throw new Error("ANTWAR_CODE_VERSION must be a full 40-character commit");
    key = privateMediaKey(env.ANTWAR_PRIVATE_REPLAY_KEY);
  } catch (err) {
    console.error(`antwar record service refused to start: ${(err as Error).message}`);
    process.exit(1);
  }
  const service = createRecordService({
    inputs: createGcsInputStore(env.ANTWAR_RECORD_INPUT_BUCKET!),
    replays: createGcsRecordReplayStore(env.ANTWAR_REPLAY_BUCKET!, key),
    records: createGcsRecordStore(env.ANTWAR_REPLAY_BUCKET!, key),
    codeVersion: env.ANTWAR_CODE_VERSION!,
    log: line => console.log(line),
    timing: line => console.log(line),
  });

  const health = createServer((_req, res) => { res.statusCode = 200; res.end("ok\n"); });
  const port = Number(env.PORT ?? 8080);
  await new Promise<void>(resolve => health.listen(port, resolve));
  console.log(`antwar record service at ${env.ANTWAR_CODE_VERSION} listening on port ${port}`);

  let stopping = false;
  let wake: (() => void) | undefined;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => { stopping = true; wake?.(); health.close(() => process.exit(0)); });
  }
  // One sweep at a time; an interrupted build writes nothing and is retried by the next process.
  while (!stopping) {
    await service.sweep();
    await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, SWEEP_INTERVAL_MS).unref(); });
  }
}

if (import.meta.main) await startRecordService();
