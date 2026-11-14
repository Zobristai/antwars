// Source trees the harness runs: a commit, optionally with a patch applied.
// Each process extracts its own private copy from git objects (git archive) into a new owner-only temporary
// directory, runs from it and removes it on exit. The store only ever holds data: trees are never kept there.
// The checkout's own branch, index and working files are never read.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Tree { readonly dir: string; readonly key: string; readonly commit: string; readonly patch: string | null; readonly patchDigest: string | null }
/** A patch file and the SHA-256 it must have before it is applied. */
export interface PatchInput { readonly path: string; readonly sha256: string }

/** The full SHA of a commit-ish in the checkout. */
export function resolveCommit(checkout: string, ref: string): string {
  return execFileSync("git", ["-C", checkout, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const made = new Set<string>();
function removeAll(): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.clear();
}
let hooked = false;
function hookCleanup(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", removeAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { removeAll(); process.exit(128 + (signal === "SIGINT" ? 2 : 15)); });
}

/** Remove a tree now rather than at exit. */
export function removeTree(tree: Tree): void {
  rmSync(tree.dir, { recursive: true, force: true });
  made.delete(tree.dir);
}

/**
 * Extract commit (+ patch) into a new private temporary directory owned by this process.
 * The patch is read once; it is applied only when its SHA-256 equals the expected digest, from the bytes that were checked.
 * The key (full SHA, plus the first 16 hex of the patch's SHA-256) names the tree's results in the store.
 */
export function materialise(checkout: string, ref: string, patch?: PatchInput): Tree {
  const commit = resolveCommit(checkout, ref);
  let patchPath: string | null = null, patchDigest: string | null = null, patchBytes: Buffer | null = null;
  if (patch !== undefined) {
    const expected = patch.sha256.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("a patch's expected SHA-256 must be 64 hex characters");
    patchPath = resolve(patch.path);
    patchBytes = readFileSync(patchPath);
    patchDigest = sha256(patchBytes);
    if (patchDigest !== expected) throw new Error(`patch ${patchPath} has SHA-256 ${patchDigest}, not the expected ${expected}; it was not applied`);
  }
  const key = patchDigest === null ? commit : `${commit}-${patchDigest.slice(0, 16)}`;
  hookCleanup();
  const dir = mkdtempSync(join(tmpdir(), "antwars-tree-"));
  made.add(dir);
  chmodSync(dir, 0o700);
  try {
    const archive = execFileSync("git", ["-C", checkout, "archive", "--format=tar", commit], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
    // GIT_CEILING_DIRECTORIES keeps git apply from finding any repository around the temporary directory.
    if (patchBytes !== null) execFileSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: dir, input: patchBytes, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
    symlinkSync(resolve(checkout, "node_modules"), join(dir, "node_modules"), "dir");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    made.delete(dir);
    throw error;
  }
  return { dir, key, commit, patch: patchPath, patchDigest };
}
