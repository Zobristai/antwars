// The tuning harness runs candidate trees from a private copy extracted from git objects. Store contents are data:
// a tree placed in the store is never run, and a patch is applied only when its SHA-256 matches the digest given.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materialise, removeTree } from "../../scripts/tuning/trees.ts";
import { exact, HEAD, makeStore, markerPatch, regen, ROOT, sha256, type Store } from "./fixtures.ts";

let store: Store;
beforeEach(() => { store = makeStore(); });
afterEach(() => store.remove());

describe("candidate trees", () => {
  it("are private copies outside the store, removed on request", () => {
    const tree = materialise(ROOT, HEAD);
    expect(tree.dir.startsWith(store.outside)).toBe(false);
    expect(statSync(tree.dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(tree.dir, "src", "ts-resolve.mjs"))).toBe(true);
    removeTree(tree);
    expect(existsSync(tree.dir)).toBe(false);
  });

  it("never run a tree placed in the store", () => {
    const { referenceSha256 } = regen(store);
    for (const key of [HEAD, `${HEAD}-0000000000000000`]) {
      mkdirSync(join(store.dir, "trees", key, "src"), { recursive: true });
      writeFileSync(join(store.dir, "trees", key, "tree.json"), JSON.stringify({ commit: HEAD, patchDigest: null }));
      writeFileSync(join(store.dir, "trees", key, "package.json"), "{}");
      writeFileSync(join(store.dir, "trees", key, "src", "ts-resolve.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TUNE_MARKER, "ran");\n');
    }
    const run = exact(store, referenceSha256);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(store.marker)).toBe(false);
  }, 120_000);

  it("apply a patch only when its SHA-256 matches the digest given", () => {
    const { referenceSha256 } = regen(store);
    const patch = join(store.outside, "candidate.diff"), text = markerPatch();
    writeFileSync(patch, text);
    // Control: with its own digest the patch is applied and its code runs.
    const applied = exact(store, referenceSha256, ["--patch", patch, "--patch-sha256", sha256(text)]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(store.marker)).toBe(true);
    rmSync(store.marker);
    // The same file against a different expected digest is refused before anything runs.
    const refused = exact(store, referenceSha256, ["--patch", patch, "--patch-sha256", sha256("an earlier patch\n")]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("was not applied");
    // A patch without a digest is refused too.
    expect(exact(store, referenceSha256, ["--patch", patch]).status).not.toBe(0);
    expect(existsSync(store.marker)).toBe(false);
  }, 120_000);
});
