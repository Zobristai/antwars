#!/usr/bin/env node
/**
 * One-off correction: records a rated ranked lobby whose colony never joined the match as abandoned and
 * unrated, removes its rating effect, and rewrites its public recording as an abandoned, unrated match.
 * src/rating/unrateNeverJoined.ts holds the checks and writes.
 *
 *   node --import ./src/ts-resolve.mjs scripts/unrate-never-joined.ts \
 *     --lobby <lobbyId> --replay <replayId> --project <gcp project> --namespace <store namespace> \
 *     --replay-bucket <bucket> [--apply]
 *
 * Every argument but --apply is required; there are no defaults. --replay is the recording the lobby's watch entry must
 * name; the project is the operator's to choose at run time (nothing here names one). Without --apply it only reads: it prints every check
 * and the writes it would make, and exits 0 when every check passed, 1 otherwise. With --apply it writes only when every
 * check passed in the same run: Firestore first (one transaction, only while every verified document and both recording
 * generations are unchanged, which also creates the marker ratingCorrections/<lobby>), then
 * each recording object still rated. A run stopped by an unknown outcome is completed by running it again: each run
 * reads which state Firestore and each recording object are in and writes only what is still missing. Google access is the Cloud Run service identity (metadata server), as for the server
 * itself, so a real run happens in Cloud Run. FIRESTORE_EMULATOR_HOST selects the Firestore emulator (loopback only,
 * refused on Cloud Run), exactly as for the server.
 */
import { parseArgs } from "node:util";
import { firestoreFromEnv } from "../src/store/firestore.ts";
import { gcsRecordingObjects } from "../src/replays/abandonRecording.ts";
import { correct, type Correction } from "../src/rating/unrateNeverJoined.ts";

export interface Arguments {
  readonly lobby: string;
  readonly replay: string;
  readonly project: string;
  readonly namespace: string;
  readonly replayBucket: string;
  readonly apply: boolean;
}

const REQUIRED = ["lobby", "replay", "project", "namespace", "replay-bucket"] as const;

/** The command line, or an error naming every missing or unknown argument. */
export function parseArguments(argv: readonly string[]): Arguments {
  const { values } = parseArgs({
    args: [...argv], strict: true, allowPositionals: false,
    options: {
      lobby: { type: "string" }, replay: { type: "string" }, project: { type: "string" }, namespace: { type: "string" },
      "replay-bucket": { type: "string" }, apply: { type: "boolean" },
    },
  });
  const missing = REQUIRED.filter(name => (values[name] ?? "").trim() === "");
  if (missing.length > 0) throw new Error(`missing required argument(s): ${missing.map(name => `--${name}`).join(", ")}`);
  const value = (name: (typeof REQUIRED)[number]) => values[name]!;
  return { lobby: value("lobby"), replay: value("replay"), project: value("project"), namespace: value("namespace"), replayBucket: value("replay-bucket"),
    apply: values.apply === true };
}

export function report(args: Arguments, result: Correction): string {
  const v = result.verification;
  const lines = [
    `project ${args.project}, namespace ${args.namespace}, lobby ${args.lobby}, replay ${args.replay}, mode ${args.apply ? "APPLY" : "read-only"}`,
    ...v.checks.map(check => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`),
    v.ok ? `never joined: ${v.neverJoined.join(", ")}; Firestore ${v.stage === "corrected" ? "already corrected" : "still rated"}` : "verification FAILED: nothing written",
    ...(v.ok ? result.writes.length === 0 ? ["nothing left to write"]
      : [result.applied ? "written:" : "would write:", ...result.writes.map(write => `  ${write}`)] : []),
  ];
  return lines.join("\n");
}

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const args = parseArguments(argv);
  const store = firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: args.namespace, GCLOUD_PROJECT: args.project,
    FIRESTORE_EMULATOR_HOST: env.FIRESTORE_EMULATOR_HOST, K_SERVICE: env.K_SERVICE });
  if (store === undefined) throw new Error("no store");
  const result = await correct({ store, recordings: gcsRecordingObjects(args.replayBucket) }, args.lobby, { apply: args.apply, replayId: args.replay });
  console.log(report(args, result));
  return result.verification.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), process.env).then(code => { process.exitCode = code; }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
