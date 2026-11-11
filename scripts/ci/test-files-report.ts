// "checks" publishes which test files the essential suite ran, with each file's passed, failed and
// skipped test counts, as notice annotations on its own check run: reviewers can read them through
// GitHub's check-run annotations API, where the job log cannot be read. Reads the JSON report that
// vitest.essential.config.ts writes when ANTWAR_TEST_FILES names its path.
// Run after the suite: ANTWAR_TEST_FILES=<report.json> node scripts/ci/test-files-report.ts
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = join(import.meta.dirname, "..", "..");
// The runner cuts any annotation message past 4,096 characters and keeps at most 10 notices a
// step; staying under both means no part of the list is ever cut.
const MAX_MESSAGE = 4000;
const MAX_NOTICES = 10;

type Report = {
  testResults: { name: string; status: string; assertionResults: { status: string }[] }[];
};

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

const escapeData = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) => escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

const path = process.env.ANTWAR_TEST_FILES;
if (!path) fail("ANTWAR_TEST_FILES is unset: no test report to publish");
const reportPath = resolve(root, path);
if (!existsSync(reportPath)) fail(`no test report at ${path}: the essential suite did not finish, so no test file list was published`);
let report: Report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  fail(`test report ${path} is not readable JSON (${(error as Error).message})`);
}

const totals = { passed: 0, failed: 0, skipped: 0, files: { passed: 0, failed: 0, skipped: 0 } };
const rows = report.testResults
  .map((file) => {
    const count = (status: string) => file.assertionResults.filter((test) => test.status === status).length;
    const passed = count("passed");
    const failed = count("failed");
    const skipped = file.assertionResults.length - passed - failed; // skipped, todo and pending
    totals.passed += passed;
    totals.failed += failed;
    totals.skipped += skipped;
    const fileFailed = file.status === "failed" || failed > 0;
    const state = fileFailed ? "failed" : passed === 0 ? "skipped" : "passed";
    totals.files[state] += 1;
    const note = fileFailed && failed === 0 ? " FILE ERROR" : state === "skipped" ? " SKIPPED" : failed > 0 ? " FAILED" : "";
    return { file: relative(root, file.name), counts: `${passed}/${failed}/${skipped}${note}` };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

const header =
  `${rows.length} test files: ${totals.files.passed} passed, ${totals.files.failed} failed, ${totals.files.skipped} skipped ` +
  `(tests: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped).\n` +
  "Each line: passed/failed/skipped tests, a FAILED, FILE ERROR or SKIPPED mark where one applies, then the file, under its directory.";

// Lines grouped under their directory; a part that starts inside a directory repeats its heading.
const parts: string[][] = [[header]];
let size = header.length;
let lastDir = "";
for (const row of rows) {
  const dir = `${dirname(row.file)}/`;
  const line = `  ${row.counts} ${basename(row.file)}`;
  const heading = dir !== lastDir ? [dir] : [];
  const needed = [...heading, line].reduce((sum, text) => sum + text.length + 1, 0);
  if (size + needed > MAX_MESSAGE) {
    parts.push(heading.length ? [] : [dir]);
    size = parts.at(-1)!.reduce((sum, text) => sum + text.length + 1, 0);
  }
  parts.at(-1)!.push(...heading, line);
  size += needed;
  lastDir = dir;
}

if (parts.length > MAX_NOTICES) {
  fail(`the list of ${rows.length} test files needs ${parts.length} annotations, more than the ${MAX_NOTICES} a step may publish; split it across steps`);
}
parts.forEach((lines, index) => {
  const title = escapeProperty(`Test files run (${index + 1}/${parts.length})`);
  console.log(`::notice title=${title}::${escapeData(lines.join("\n"))}`);
});
