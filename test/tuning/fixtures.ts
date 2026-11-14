// Shared set-up for the tuning-harness end-to-end tests: a temporary store, short harness runs on one scenario,
// and a patch that records when the patched tree's code runs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const HEAD = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
/** Short runs: one scenario, the advance path, the first 8 ticks. */
export const SHORT = ["--scenarios", "open-field-0", "--paths", "advance", "--ticks", "8", "--jobs", "1"];

export interface Store { readonly dir: string; readonly marker: string; readonly outside: string; remove(): void }
export function makeStore(): Store {
  const base = mkdtempSync(join(tmpdir(), "tuning-test-"));
  return { dir: join(base, "store"), marker: join(base, "ran"), outside: base, remove: () => rmSync(base, { recursive: true, force: true }) };
}

export function harness(store: Store, args: readonly string[]) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "tuning", "harness.ts"), ...args, "--store", store.dir],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, TUNE_MARKER: store.marker } });
  return { ...r, json: (): any => JSON.parse(r.stdout) };
}

/** regen at HEAD on the short workload; returns its report (including referenceSha256). */
export function regen(store: Store, checkpoints = 0): any {
  const r = harness(store, ["regen", "--commit", HEAD, ...SHORT, "--checkpoints", String(checkpoints)]);
  if (r.status !== 0) throw new Error(`regen failed: ${r.stderr}`);
  return r.json();
}

export function exact(store: Store, referenceSha256: string, extra: readonly string[] = []) {
  return harness(store, ["exact", "--reference", HEAD, "--candidate", HEAD, "--reference-sha256", referenceSha256, "--paths", "advance", "--ticks", "8", ...extra]);
}

/** A patch that appends to the tree's module loader a line recording that it ran. */
export function markerPatch(): string {
  const loader = execFileSync("git", ["-C", ROOT, "show", `${HEAD}:src/ts-resolve.mjs`], { encoding: "utf8" });
  const lines = loader.endsWith("\n") ? loader.slice(0, -1).split("\n") : loader.split("\n");
  const context = lines.slice(-3), from = lines.length - context.length + 1;
  return ["--- a/src/ts-resolve.mjs", "+++ b/src/ts-resolve.mjs", `@@ -${from},${context.length} +${from},${context.length + 1} @@`,
    ...context.map(l => ` ${l}`), '+import { writeFileSync as markRan } from "node:fs"; markRan(process.env.TUNE_MARKER, "ran");', ""].join("\n");
}
