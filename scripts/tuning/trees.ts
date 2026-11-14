// Source trees the harness runs: a commit, optionally with a patch applied, extracted once into the store.
// The tree key is the full commit SHA, plus the first 16 hex of the patch's SHA-256 when there is a patch.
// Extraction uses git objects only (git archive), so the checkout's own branch, index and working files are never read.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Tree { readonly dir: string; readonly key: string; readonly commit: string; readonly patch: string | null; readonly patchDigest: string | null }

/** The full SHA of a commit-ish in the checkout. */
export function resolveCommit(checkout: string, ref: string): string {
  return execFileSync("git", ["-C", checkout, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Materialise commit (+ patch) under <store>/trees/<key>, reusing it when already there. */
export function materialise(store: string, checkout: string, ref: string, patch?: string): Tree {
  const commit = resolveCommit(checkout, ref);
  const patchPath = patch === undefined ? null : resolve(patch);
  const patchDigest = patchPath === null ? null : sha256File(patchPath);
  const key = patchDigest === null ? commit : `${commit}-${patchDigest.slice(0, 16)}`;
  const dir = join(store, "trees", key);
  const tree = { dir, key, commit, patch: patchPath, patchDigest };
  if (existsSync(join(dir, "tree.json"))) return tree;
  // Build beside the destination and rename into place, so concurrent callers never see a half-built tree.
  const scratch = join(store, "trees", `.build-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const archive = execFileSync("git", ["-C", checkout, "archive", "--format=tar", commit], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", scratch], { input: archive });
    // GIT_CEILING_DIRECTORIES keeps git apply from finding any repository around the store.
    if (patchPath !== null) execFileSync("git", ["apply", "--whitespace=nowarn", patchPath], { cwd: scratch, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(scratch) } });
    symlinkSync(resolve(checkout, "node_modules"), join(scratch, "node_modules"), "dir");
    writeFileSync(join(scratch, "tree.json"), JSON.stringify({ commit, patchDigest }));
    try { renameSync(scratch, dir); } catch (error) {
      if (!existsSync(join(dir, "tree.json"))) throw error;
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return tree;
}
