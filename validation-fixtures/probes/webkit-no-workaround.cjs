#!/usr/bin/env node
// WebKit end-to-end probe for the validation/org-packages-node fixture.
//
// Run from the repository root:
//   PLAYWRIGHT_BROWSERS_PATH="$PWD/.validation/browser-cache" \
//     node validation-fixtures/probes/webkit-no-workaround.cjs
//
// Launches the WebKit build pinned by this branch's Playwright package,
// headless, with the inherited environment only: it sets no library path,
// preload, GStreamer plugin path or other workaround. It opens a local HTML
// page, asserts a DOM operation, and plays an embedded H.264 clip so the
// media decoder is exercised. It saves a trace, a screenshot and a JSON
// result under .validation/webkit/<run>/, records the libraries mapped by the
// browser's processes, closes the browser in `finally` and checks that every
// process it started has exited. Exit 0 only when every check passed.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// 64x48, 1 s, 10 fps H.264 Constrained Baseline MP4 (no audio). Generated with
// a static ffmpeg build (libx264) from its `testsrc` pattern.
const MEDIA_SHA256 = "4a00b557517d307b5874a42bd5a7976e91b6f955fe2f92d4964532237479382e";
const MEDIA_BASE64 = [
  "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",
  "qTH8Lk1VV/0022/w",
].join("");

const ENV_NAMES = [
  "PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "GST_PLUGIN_PATH",
  "GST_PLUGIN_PATH_1_0",
  "GST_PLUGIN_SYSTEM_PATH",
  "GST_PLUGIN_SYSTEM_PATH_1_0",
  "GST_PLUGIN_SCANNER",
  "GST_REGISTRY",
  "PLAYWRIGHT_BROWSERS_PATH",
];
const LIBRARY_PATTERN = /gst|gstreamer|libav|GLES|EGL|webkit|wpe|javascriptcore/i;
const MEDIA_TIMEOUT_MS = 20000;

function nowIso() {
  return new Date().toISOString();
}

// Every live process whose parent chain reaches `rootPid`.
function descendantsOf(rootPid) {
  const parents = new Map();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), { ppid: Number(fields[1]), state: fields[0] });
    } catch {
      // Process exited while listing.
    }
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [pid, info] of parents) {
      if (info.ppid === parent) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

function processState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return null;
  }
}

function describeProcess(pid) {
  const record = { pid, cmdline: null, libraries: [] };
  try {
    record.cmdline = fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
  } catch (error) {
    record.cmdlineError = error.code || String(error);
  }
  try {
    const libraries = new Set();
    for (const line of fs.readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
      const file = line.split(/\s+/).slice(5).join(" ");
      if (file.startsWith("/") && LIBRARY_PATTERN.test(file)) libraries.add(file);
    }
    record.libraries = [...libraries].sort();
  } catch (error) {
    record.mapsError = error.code || String(error);
  }
  return record;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runName = `${nowIso().replace(/[:.]/g, "-")}-${process.pid}`;
  const outDir = path.resolve(".validation", "webkit", runName);
  fs.mkdirSync(outDir, { recursive: true });

  const result = {
    probe: "webkit-no-workaround",
    startedAt: nowIso(),
    finishedAt: null,
    outDir,
    node: process.version,
    uid: process.getuid(),
    gid: process.getgid(),
    environment: Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name] ?? null])),
    playwright: null,
    webkit: null,
    checks: [],
    pageErrors: [],
    consoleErrors: [],
    processes: [],
    processesAfterClose: [],
    error: null,
    passed: false,
  };
  const check = (name, passed, detail) => {
    result.checks.push({ name, passed: Boolean(passed), detail });
  };

  const media = Buffer.from(MEDIA_BASE64, "base64");
  const mediaSha256 = crypto.createHash("sha256").update(media).digest("hex");
  check("embedded media digest", mediaSha256 === MEDIA_SHA256, { expected: MEDIA_SHA256, actual: mediaSha256 });
  const mediaPath = path.join(outDir, "fixture.mp4");
  fs.writeFileSync(mediaPath, media);
  const htmlPath = path.join(outDir, "index.html");
  fs.writeFileSync(
    htmlPath,
    [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"><title>webkit probe</title></head>',
      "<body>",
      '<p id="status">initial</p>',
      '<video id="clip" src="fixture.mp4" muted playsinline preload="auto" width="64" height="48"></video>',
      "</body></html>",
      "",
    ].join("\n"),
  );

  const playwrightPackage = require.resolve("playwright/package.json");
  const playwrightRequire = require("node:module").createRequire(playwrightPackage);
  const corePackage = playwrightRequire.resolve("playwright-core/package.json");
  const browsers = JSON.parse(fs.readFileSync(path.join(path.dirname(corePackage), "browsers.json"), "utf8"));
  result.playwright = {
    playwright: require(playwrightPackage).version,
    playwrightCore: require(corePackage).version,
  };
  result.webkit = { manifest: browsers.browsers.find((entry) => entry.name === "webkit") ?? null };

  const { webkit } = require("playwright");
  result.webkit.executablePath = webkit.executablePath();
  result.webkit.executablePresent = fs.existsSync(result.webkit.executablePath);

  let browser = null;
  let context = null;
  let tracing = false;
  let browserPids = [];
  try {
    browser = await webkit.launch({ headless: true });
    result.webkit.version = browser.version();
    context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing = true;
    const page = await context.newPage();
    page.on("pageerror", (error) => result.pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") result.consoleErrors.push(message.text());
    });
    page.on("crash", () => result.pageErrors.push("page crashed"));

    await page.goto(pathToFileURL(htmlPath).href);

    const domText = await page.evaluate(() => {
      const status = document.getElementById("status");
      status.textContent = "dom-ok";
      return status.textContent;
    });
    const locatorText = await page.locator("#status").textContent();
    check("DOM operation", domText === "dom-ok" && locatorText === "dom-ok", { domText, locatorText });

    const canPlay = await page.evaluate(() =>
      document.getElementById("clip").canPlayType('video/mp4; codecs="avc1.42E01E"'),
    );
    check("canPlayType H.264 baseline", canPlay === "probably" || canPlay === "maybe", { canPlay });

    // While the clip is loading and playing, the media processes are alive:
    // record what they have mapped.
    const playback = await page.evaluate(
      (timeoutMs) =>
        new Promise((resolve) => {
          const video = document.getElementById("clip");
          const state = () => ({
            readyState: video.readyState,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            currentTime: video.currentTime,
            ended: video.ended,
            error: video.error ? { code: video.error.code, message: video.error.message } : null,
          });
          const timer = setTimeout(() => resolve({ outcome: "timeout", ...state() }), timeoutMs);
          const finish = (outcome) => {
            clearTimeout(timer);
            resolve({ outcome, ...state() });
          };
          video.addEventListener("error", () => finish("error"));
          video.addEventListener("ended", () => finish("ended"));
          video.addEventListener("timeupdate", () => {
            if (video.currentTime >= 0.5) finish("progressed");
          });
          video.play().catch((error) => finish(`play rejected: ${error}`));
        }),
      MEDIA_TIMEOUT_MS,
    );
    browserPids = descendantsOf(process.pid);
    result.processes = browserPids.map(describeProcess);
    check(
      "H.264 clip decoded and played",
      (playback.outcome === "progressed" || playback.outcome === "ended") &&
        playback.videoWidth === 64 &&
        playback.videoHeight === 48 &&
        playback.readyState >= 2 &&
        playback.error === null,
      playback,
    );

    await page.screenshot({ path: path.join(outDir, "page.png") });
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
  } finally {
    if (browserPids.length === 0) browserPids = descendantsOf(process.pid);
    if (tracing) {
      try {
        await context.tracing.stop({ path: path.join(outDir, "trace.zip") });
      } catch (error) {
        result.error = result.error ?? `tracing.stop: ${error}`;
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        result.error = result.error ?? `browser.close: ${error}`;
      }
    }
    // A zombie ("Z") has exited and only awaits reaping.
    let remaining = browserPids;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      remaining = browserPids.filter((pid) => {
        const state = processState(pid);
        return state !== null && state !== "Z";
      });
      if (remaining.length === 0) break;
      await sleep(100);
    }
    result.processesAfterClose = remaining.map((pid) => ({ pid, state: processState(pid) }));
    check("browser processes stopped", remaining.length === 0, {
      started: browserPids,
      remaining: result.processesAfterClose,
    });
  }

  check("no page errors", result.pageErrors.length === 0, result.pageErrors);
  result.passed = result.error === null && result.checks.every((entry) => entry.passed);
  result.finishedAt = nowIso();
  fs.writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);
