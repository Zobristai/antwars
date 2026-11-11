// "checks" and "full" run inside Playwright's container image (.github/workflows/antwar-ci.yml),
// whose browsers belong to one Playwright release. Fail with a clear message, before any test,
// when that image (its tag in the workflow, or the version read inside the running image) and the
// playwright-core pinned in package.json are out of step; then point
// CHROME_BIN at the image's Chromium for the Chromium tests (the image has no Google Chrome).
// Run from anywhere inside the image: node scripts/ci/playwright-image.ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const root = join(import.meta.dirname, "..", "..");
const WORKFLOW = ".github/workflows/antwar-ci.yml";

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const pinned: string = readJson("package.json").devDependencies["playwright-core"];
const installed: string = readJson("node_modules/playwright-core/package.json").version;
if (installed !== pinned) {
  fail(`package.json pins playwright-core ${pinned} but node_modules has ${installed}; run npm ci after updating package-lock.json`);
}

const images = [...readFileSync(join(root, WORKFLOW), "utf8").matchAll(/mcr\.microsoft\.com\/playwright:([^\s"'@]+)(@sha256:[0-9a-f]{64})?/g)];
if (images.length === 0) fail(`${WORKFLOW} names no mcr.microsoft.com/playwright image`);
for (const [ref, tag, digest] of images) {
  const version = tag.replace(/^v/, "").replace(/-noble$/, "");
  if (tag !== `v${version}-noble` || version !== pinned) {
    fail(`${WORKFLOW} runs the Playwright image ${tag} but package.json pins playwright-core ${pinned}; update the image tag and digest in ${WORKFLOW} to v${pinned}-noble`);
  }
  if (!digest) fail(`${WORKFLOW} names ${ref} without a digest; pin it as ${ref}@sha256:<digest>`);
}

// The tag is only a label: the digest picks the image. Read the version the running image was built
// for from the metadata Playwright's images carry ($PLAYWRIGHT_BROWSERS_PATH/.docker-info), so an
// image whose digest belongs to another release fails here even when its browsers' paths match.
const named = [...new Set(images.map(([, tag]) => `mcr.microsoft.com/playwright:${tag}`))];
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const infoPath = browsersPath ? join(browsersPath, ".docker-info") : "$PLAYWRIGHT_BROWSERS_PATH/.docker-info";
let parsed: unknown;
try {
  if (!browsersPath) throw new Error("PLAYWRIGHT_BROWSERS_PATH is unset");
  parsed = JSON.parse(readFileSync(infoPath, "utf8"));
} catch (error) {
  fail(`cannot read this container's Playwright version from ${infoPath} (${(error as Error).message}); image version unknown, package.json pins playwright-core ${pinned}`);
}
// JSON.parse accepts null, numbers, strings and arrays too: check the shape before reading fields.
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  fail(`${infoPath} is not a JSON object; image version unknown, package.json pins playwright-core ${pinned}`);
}
const info = parsed as { driverVersion?: unknown; dockerImageName?: unknown };
if (typeof info.driverVersion !== "string") {
  fail(`${infoPath} has no driverVersion; image version unknown, package.json pins playwright-core ${pinned}`);
}
if (info.driverVersion !== pinned) {
  fail(`this container's image is Playwright ${info.driverVersion} (${infoPath}) but package.json pins playwright-core ${pinned}; update the image tag and digest in ${WORKFLOW} to v${pinned}-noble`);
}
if (named.length !== 1 || info.dockerImageName !== named[0]) {
  fail(`this container's image is ${String(info.dockerImageName)} (Playwright ${info.driverVersion}) but ${WORKFLOW} names ${named.join(", ")} for playwright-core ${pinned}; the digest does not belong to that tag`);
}

for (const [name, browser] of [["WebKit", webkit], ["Chromium", chromium]] as const) {
  if (!existsSync(browser.executablePath())) {
    fail(`this container has no ${name} build for playwright-core ${pinned} (expected ${browser.executablePath()}); update the image in ${WORKFLOW} to v${pinned}-noble`);
  }
}

if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `CHROME_BIN=${chromium.executablePath()}\n`);
console.log(`Playwright image ${info.dockerImageName} (Playwright ${info.driverVersion}) matches playwright-core ${pinned}; CHROME_BIN=${chromium.executablePath()}`);
