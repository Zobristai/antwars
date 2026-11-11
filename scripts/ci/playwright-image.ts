// "checks" and "full" run inside Playwright's container image (.github/workflows/antwar-ci.yml),
// whose browsers belong to one Playwright release. Fail with a clear message, before any test,
// when that image and the playwright-core pinned in package.json are out of step; then point
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

for (const [name, browser] of [["WebKit", webkit], ["Chromium", chromium]] as const) {
  if (!existsSync(browser.executablePath())) {
    fail(`this container has no ${name} build for playwright-core ${pinned} (expected ${browser.executablePath()}); update the image in ${WORKFLOW} to v${pinned}-noble`);
  }
}

if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `CHROME_BIN=${chromium.executablePath()}\n`);
console.log(`Playwright image matches playwright-core ${pinned}; CHROME_BIN=${chromium.executablePath()}`);
