/**
 * What a lobby watch link shows when there is no live frame to draw, in one browser at desktop and phone width:
 * - a lobby whose match has started but whose delayed stream has released nothing yet, and a lobby that exists but has
 *   not started: the waiting panel, saying the live match is starting;
 * - a dead lobby link (its status and live stream answer 404): the Leaderboard.
 * None may request a stored recording or stored history. Every request is intercepted and answered here from
 * web/dist and fixed fakes; nothing leaves the page, so no deployed service, live or seated match, or queue is touched.
 *
 * After build:web: node --import ./src/ts-resolve.mjs web/capture/lobby-link-screens.ts --out out/lobby-link-screens
 * Writes <scene>-<width>x<height>.png per scene and viewport, and lobby-link-screens.json with every check.
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { WEB_DIR, launchBrowser } from "./browser.ts";
import { fakeLeaderboardPage, fakeReadOf } from "./leaderboard-stills.ts";

const ORIGIN = "http://localhost:4719";
/** waiting.ts STARTING_COPY; that module's class syntax does not load under Node's type stripping. */
const STARTING_COPY = "Live match starting";
const STARTED = "7d3c2a10-5b6e-4f8a-9c1d-2e3f4a5b6c7d", PENDING = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", DEAD = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
/** The lobbies that wait in the panel: the status each one answers. */
const WAITING: Record<string, boolean> = { [STARTED]: true, [PENDING]: false };
const VIEWPORTS = [[1440, 900], [375, 812]] as const;
const SCENES = [["delay-panel", STARTED], ["not-started-panel", PENDING], ["dead-lobby", DEAD]] as const;
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };

const { values } = parseArgs({ options: { out: { type: "string" } } });
const output = resolve(values.out ?? "out/lobby-link-screens"); await mkdir(output, { recursive: true });
const directory = await realpath(WEB_DIR);
const browser = await launchBrowser();
const results: unknown[] = [];
let failed = false;
try {
  for (const [width, height] of VIEWPORTS) for (const [scene, lobby] of SCENES) {
    const phone = width < 900;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, serviceWorkers: "block" });
    const page = await context.newPage();
    const requests: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}`);
      if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
      const [, kind, id] = /^\/watch\/(status|live)\/([^/]+)$/.exec(url.pathname) ?? [];
      const started = id === undefined ? undefined : WAITING[id];
      if (kind === "status" && started !== undefined) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ lobbyId: id, started, playbackFinished: false, delaySeconds: 60 }) });
      // Before the start and through the spectator delay: the stream is open but sends only its keep-alive comment.
      if (kind === "live" && started !== undefined) return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "retry": "60000" }, body: ": keep-alive\n\n" });
      if (url.pathname.startsWith("/watch/") || url.pathname.startsWith("/matches") || url.pathname.startsWith("/replays/")) return route.fulfill({ status: 404 });
      if (url.pathname === "/api/leaderboard") {
        const payload = request.postDataJSON() as { mode: string; scope?: string; cursor?: string };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fakeLeaderboardPage(fakeReadOf(payload), payload.cursor)) });
      }
      if (request.method() !== "GET") return route.fulfill({ status: 404 });
      try {
        const real = await realpath(join(directory, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
        if (!real.startsWith(directory + sep) || !types[extname(real)]) return route.fulfill({ status: 404 });
        let bytes: Buffer | string = await readFile(real);
        if (url.pathname === "/") bytes = bytes.toString("utf8").replace("<head>", `<head><meta name="antwar-public-matches" content="true"><meta name="antwar-lobbies" content="false">`);
        return route.fulfill({ status: 200, contentType: types[extname(real)], body: bytes });
      } catch { return route.fulfill({ status: 404 }); }
    });
    const file = `${scene}-${width}x${height}.png`;
    const problems: string[] = [];
    try {
      await page.goto(`${ORIGIN}/?lobby=${lobby}`);
      if (scene !== "dead-lobby") await page.waitForFunction(text => document.querySelector(".aw-wait-state")?.textContent === text, STARTING_COPY, { timeout: 15_000 });
      else await page.waitForFunction(() => {
        const tables = document.querySelectorAll("#aw-leaderboard-page section");
        return tables.length > 0 && Array.from(tables).every(table => table.getAttribute("aria-busy") === "false");
      }, undefined, { timeout: 15_000 });
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => {
        const waiting = document.getElementById("aw-waiting");
        const box = waiting?.getBoundingClientRect();
        return {
          waitingShown: !!waiting && !waiting.hidden, waitingText: waiting?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          waitingWhole: !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          leaderboard: !!document.getElementById("aw-leaderboard-page"), title: document.title,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      if (requests.some(r => / \/(replays\/|matches)/.test(r))) problems.push("requested a stored recording or stored history");
      if (scene !== "dead-lobby") {
        if (!state.waitingShown || !state.waitingWhole) problems.push("the waiting panel is not whole on screen");
        if (!state.waitingText?.includes(STARTING_COPY)) problems.push(`the waiting panel reads "${state.waitingText}"`);
        if (state.leaderboard) problems.push("the Leaderboard is shown during the delay");
      } else {
        if (!state.leaderboard) problems.push("no Leaderboard");
        if (state.waitingShown) problems.push("the waiting panel is still shown over the Leaderboard");
      }
      if (state.horizontalOverflow) problems.push("the page scrolls sideways");
      if (errors.length) problems.push(...errors.map(error => `page error: ${error}`));
      await page.screenshot({ path: join(output, file) });
      results.push({ scene, width, height, file, state, problems, requests });
    } catch (error) {
      problems.push(String(error));
      await page.screenshot({ path: join(output, file) }).catch(() => undefined);
      results.push({ scene, width, height, file, problems, requests });
    }
    failed ||= problems.length > 0;
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(join(output, "lobby-link-screens.json"), JSON.stringify({ origin: ORIGIN, results, passed: !failed }, null, 2));
console.log(JSON.stringify(results.map(r => { const { requests: _requests, ...rest } = r as { requests: unknown }; return rest; }), null, 2));
if (failed) process.exitCode = 1;
