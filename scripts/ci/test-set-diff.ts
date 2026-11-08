// The essential suite is every test minus FULL_ONLY. List the files
// each config discovers (no test runs) and fail unless full minus essential is
// exactly FULL_ONLY: a stale entry (renamed or deleted file) or an exclusion
// nobody listed both fail. Run from anywhere: node scripts/ci/test-set-diff.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FULL_ONLY } from "../../vitest.essential.config.ts";

const root = join(import.meta.dirname, "..", "..");

function discovered(configFile: string): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), "antwar-test-set-"));
  try {
    const out = join(dir, "files.json");
    execFileSync("npx", ["vitest", "list", "--filesOnly", "--config", configFile, `--json=${out}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const rows = JSON.parse(readFileSync(out, "utf8")) as { file: string }[];
    return new Set(rows.map((row) => relative(root, row.file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const full = discovered("vitest.config.ts");
const essential = discovered("vitest.essential.config.ts");
const fullOnly = [...full].filter((file) => !essential.has(file)).sort();
const listed = new Set(FULL_ONLY);

const stale = FULL_ONLY.filter((file) => !full.has(file));
const unlisted = fullOnly.filter((file) => !listed.has(file));
const essentialOnly = [...essential].filter((file) => !full.has(file)).sort();

console.log(`full ${full.size} files, essential ${essential.size}, full-only ${fullOnly.length}:`);
for (const file of fullOnly) console.log(`  ${file}`);

const problems = [
  ...stale.map((file) => `FULL_ONLY entry matches no discovered test file: ${file}`),
  ...unlisted.map((file) => `excluded from essential but not in FULL_ONLY: ${file}`),
  ...essentialOnly.map((file) => `discovered by essential but not by full: ${file}`),
];
for (const problem of problems) console.error(problem);
process.exit(problems.length === 0 ? 0 : 1);
