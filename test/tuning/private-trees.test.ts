// The tuning harness runs candidate trees from a private copy extracted from git objects. Store contents are data:
// a tree placed in the store is never run, and a patch is applied only when its SHA-256 matches the digest given.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materialise, removeTree } from "../../scripts/tuning/trees.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HEAD = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let store: string, marker: string;
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "tuning-store-test-"));
  marker = join(store, "ran");
  // A one-scenario workload, so each harness run plays two ticks of one match on one path.
  mkdirSync(join(store, "workloads"));
  writeFileSync(join(store, "workloads", `${HEAD}.json`), JSON.stringify({ commit: HEAD, source: "test", seedsPerMap: 1, paths: ["advance"], horizon: "test",
    scenarios: [{ id: "open-field-0", map: "open-field", seed: 0, weight: 1, loaded: { matchTicks: 18000 } }], checkpoints: { "open-field-0": [] } }));
});
afterEach(() => rmSync(store, { recursive: true, force: true }));

function exact(extra: string[] = []) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", "tuning", "harness.ts"), "exact", "--store", store, "--reference", HEAD, "--candidate", HEAD,
    "--ticks", "2", "--paths", "advance", ...extra], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TUNE_MARKER: marker } });
}

/** A patch that appends to the tree's module loader a line recording that it ran. */
function markerPatch(): string {
  const loader = execFileSync("git", ["-C", ROOT, "show", `${HEAD}:src/ts-resolve.mjs`], { encoding: "utf8" });
  const lines = loader.endsWith("\n") ? loader.slice(0, -1).split("\n") : loader.split("\n");
  const context = lines.slice(-3), from = lines.length - context.length + 1;
  return ["--- a/src/ts-resolve.mjs", "+++ b/src/ts-resolve.mjs", `@@ -${from},${context.length} +${from},${context.length + 1} @@`,
    ...context.map(l => ` ${l}`), '+import { writeFileSync as markRan } from "node:fs"; markRan(process.env.TUNE_MARKER, "ran");', ""].join("\n");
}

describe("candidate trees", () => {
  it("are private copies outside the store, removed on request", () => {
    const tree = materialise(ROOT, HEAD);
    expect(tree.dir.startsWith(store)).toBe(false);
    expect(statSync(tree.dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(tree.dir, "src", "ts-resolve.mjs"))).toBe(true);
    removeTree(tree);
    expect(existsSync(tree.dir)).toBe(false);
  });

  it("never run a tree placed in the store", () => {
    for (const key of [HEAD, `${HEAD}-0000000000000000`]) {
      mkdirSync(join(store, "trees", key, "src"), { recursive: true });
      writeFileSync(join(store, "trees", key, "tree.json"), JSON.stringify({ commit: HEAD, patchDigest: null }));
      writeFileSync(join(store, "trees", key, "package.json"), "{}");
      writeFileSync(join(store, "trees", key, "src", "ts-resolve.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TUNE_MARKER, "ran");\n');
    }
    const run = exact();
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 120_000);

  it("apply a patch only when its SHA-256 matches the digest given", () => {
    const patch = join(store, "candidate.diff"), text = markerPatch();
    writeFileSync(patch, text);
    // Control: with its own digest the patch is applied and its code runs.
    const applied = exact(["--patch", patch, "--patch-sha256", sha256(text)]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // The same file against a different expected digest is refused before anything runs.
    const refused = exact(["--patch", patch, "--patch-sha256", sha256("an earlier patch\n")]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("was not applied");
    expect(existsSync(marker)).toBe(false);
    // A patch without a digest is refused too.
    expect(exact(["--patch", patch]).status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 120_000);
});
