/** Run under firebase emulators:exec, after build:web, on the exact committed head.
 * node --import ./src/ts-resolve.mjs web/capture/spectator-access.ts --browser chromium --expected-head <sha> --out out/spectator-chromium
 * Repeat --browser webkit for the iPhone 15 profile. No deployed service or live-match join is used.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { devices, webkit, type Browser, type Page } from "playwright-core";
import { launchBrowser } from "./browser.ts";
import { captureConsole } from "./spectator-console.ts";
import { createSpectatorWorld, until, type FinalResultWrite } from "./spectator-world.ts";
import { assertNoRetiredChrome } from "./spectator-navigation.ts";
import { DESIGNED_RESULT_DELAY_MS, RESULT_DEADLINE_SLACK_MS, checkResultReconnect, observeResultReconnect, type ReconnectCheck } from "./spectator-result-checks.ts";

const { values } = parseArgs({ options: { browser: { type: "string" }, "expected-head": { type: "string" }, out: { type: "string" }, seed: { type: "string" } } });
const target = values.browser;
if (target !== "chromium" && target !== "webkit") throw new Error("Choose --browser chromium or webkit");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(values["expected-head"] ?? "") || values["expected-head"] !== head) throw new Error("--expected-head must equal this checkout's exact HEAD");
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Browser acceptance requires a clean committed checkout");
const seed = Number(values.seed ?? 42);
if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid fixture seed");
const output = resolve(values.out ?? `out/spectator-${target}`); mkdirSync(output, { recursive: true });
const secrets = new Set<string>();
const redact = (value: unknown) => { let text = String(value); for (const secret of secrets) text = text.split(secret).join("[redacted]"); return text; };
const report: { head: string; browser: string; startedAt: string; fixture: string; cases: unknown[]; passed?: boolean; error?: string; finishedAt?: string } = {
  head, browser: target, startedAt: new Date().toISOString(),
  fixture: "Two loopback HTTP origins; real Firestore emulator/account/ratings/watch routes; offline Game state machine; explicit server clock advances test the 300/60-second release floors. No MCP client or deployed match.", cases: [],
};
let browser: Browser | undefined;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitText(page: Page, selector: string, text: string) {
  await until(async () => (await page.locator(selector).count()) > 0 && (await page.locator(selector).first().textContent())?.includes(text) === true, 45_000);
}
/** The HUD's parts these checks read: the 2D board's, or the deck's. */
const ROSTER = ".d2-agent-list, .d1-agents", AGENT = ".d2-agent-item, .d1-agent-item", RATINGS = ".d1-ratings", STATUS = ".d2-status, .d1-legend";
/** A part of the HUD shown with some text: an agent's rating or model label. */
async function waitShown(page: Page, selector: string) {
  await until(async () => (await page.locator(selector).count()) > 0 && ((await page.locator(selector).first().textContent()) ?? "").trim() !== "", 45_000);
}
async function shot(page: Page, name: string) {
  const path = join(output, `${name}.png`); await page.screenshot({ path, fullPage: true }); return path;
}

type ResultTiming = { label: string; observationStartedAt: string; finalWrite?: FinalResultWrite; writerTimestamp?: string; designedTimestamp?: string; visibleTimestamp?: string; latencyMs?: number; latenessMs?: number };
async function withResultTiming(page: Page, world: Awaited<ReturnType<typeof createSpectatorWorld>>,
  match: { lobbyId: string; origin: string }, label: string, timings: ResultTiming[], action: () => Promise<unknown>) {
  const cursor = world.finalWrites.length;
  const timing: ResultTiming = { label, observationStartedAt: new Date().toISOString() }; timings.push(timing);
  let canceled = false;
  // Start observation BEFORE playback/navigation. Use the owner write, not a later proxy
  // write or play() completion, so forwarding/buffering time remains inside the deadline.
  const observation = until(async () => {
    if (canceled) return true;
    const write = world.finalWrites.slice(cursor).find(value => value.lobbyId === match.lobbyId && value.origin === match.origin);
    if (!write) return false;
    timing.finalWrite = write; timing.writerTimestamp = new Date(write.writtenAt).toISOString();
    const designedAt = write.writtenAt + DESIGNED_RESULT_DELAY_MS;
    timing.designedTimestamp = new Date(designedAt).toISOString();
    const visible = await page.locator(RATINGS).first().isVisible();
    const observedAt = Date.now();
    if (visible) {
      timing.visibleTimestamp = new Date(observedAt).toISOString(); timing.latencyMs = observedAt - write.writtenAt;
      timing.latenessMs = observedAt - designedAt;
      assert(timing.latencyMs >= 0 && timing.latenessMs <= RESULT_DEADLINE_SLACK_MS, `${label}: result visible ${timing.latencyMs} ms after final write, ${timing.latenessMs} ms after designed time; maximum lateness ${RESULT_DEADLINE_SLACK_MS} ms`);
      return true;
    }
    assert(observedAt - designedAt <= RESULT_DEADLINE_SLACK_MS, `${label}: result not visible within ${RESULT_DEADLINE_SLACK_MS} ms of designed time`);
    return false;
  }, 45_000);
  // Retain timing evidence even on failure, and settle the action before fixture cleanup.
  const results = await Promise.allSettled([observation, action().catch(error => { canceled = true; throw error; })]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

try {
  browser = target === "chromium" ? await launchBrowser() : await webkit.launch();
  for (const mode of ["2d", "3d", "boardless"] as const) {
    const world = await createSpectatorWorld();
    const context = await browser.newContext(target === "webkit" ? { ...devices["iPhone 15"] } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(45_000);
    const consoleOutput = captureConsole(page, redact);
    await observeResultReconnect(page);
    const errors: string[] = [], requests: { path: string; inviteHeader: boolean }[] = [];
    page.on("pageerror", error => errors.push(redact(error.message)));
    page.on("request", request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/watch/")) return;
      if (url.searchParams.has("invite") || url.searchParams.has("key")) errors.push("A secret appeared in a watch request URL");
      requests.push({ path: url.pathname, inviteHeader: request.headers()["x-antwar-invite"] !== undefined });
    });
    if (mode === "boardless") await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null;
        return (original as (...args: unknown[]) => RenderingContext | null).apply(this, [kind, ...args]);
      } as typeof original;
    });
    const queryMode = mode === "3d" ? "3d" : "2d";
    const images: string[] = [], resultTimings: ResultTiming[] = [], reconnectChecks: ReconnectCheck[] = [];
    try {
      let navigations = 0; page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
      const selected = await world.start("public", true, seed);
      // The public matches panel is retired: a match is opened by its lobby link.
      const selectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/watch/live/${selected.lobbyId}` && response.status() === 200);
      await page.goto(`${world.origins[1]}/?board=${queryMode}&watch=1&lobby=${selected.lobbyId}`, { waitUntil: "domcontentloaded" });
      await selectedResponse;
      await assertNoRetiredChrome(page);
      const chosenNavigations = navigations;
      const successor = await world.start("public", false, seed + 1); // Its slot is reused before the selected delayed end.
      world.advance(selected.untilReleaseMs() - 1);
      await page.waitForTimeout(200);
      assert((await page.locator(AGENT).count()) === 0, "Rated board/player state appeared before its 300-second floor");
      await withResultTiming(page, world, selected, "public-rated-attached", resultTimings, () => selected.play());
      await waitText(page, ROSTER, world.displayNames[0]!);
      await waitShown(page, ".d2-agent-elo, .d1-elo");
      await waitShown(page, ".d2-agent-sub, .d1-model");
      await page.locator(AGENT).first().waitFor({ state: "visible" });
      images.push(await shot(page, `${mode}-players`));
      let renderer = "boardless";
      if (mode !== "boardless") {
        const info = await page.evaluate(() => window.__antwar.ready); renderer = info.rendererName;
        assert(mode !== "3d" || renderer.startsWith("babylon"), "Requested 3D fell back to another renderer");
      } else await waitText(page, "body", "The game view needs WebGL");
      await page.locator(RATINGS).waitFor({ state: "visible" });
      await waitText(page, RATINGS, "→");
      for (const name of world.displayNames) await waitText(page, RATINGS, name);
      assert(navigations === chosenNavigations, "Selected playback reloaded while its slot was reused");
      images.push(await shot(page, `${mode}-rated-result`));
      if (mode !== "boardless") await checkResultReconnect(page, "automatic-30s", reconnectChecks, world.finalWrites, selected);
      await checkResultReconnect(page, "connection-recovery", reconnectChecks, world.finalWrites, selected);
      images.push(await shot(page, `${mode}-reconnected-result`));

      await withResultTiming(page, world, successor, "public-unrated-late", resultTimings, async () => {
        await page.goto(`${world.origins[1]}/?board=${queryMode}&watch=1&lobby=${successor.lobbyId}`, { waitUntil: "domcontentloaded" });
        await assertNoRetiredChrome(page);
      });
      await waitText(page, STATUS, "unrated match");
      await waitText(page, STATUS, "60 s behind the match");
      await page.locator(RATINGS).waitFor({ state: "visible" });
      await waitText(page, RATINGS, "no rating change");
      images.push(await shot(page, `${mode}-unrated-result`));

      const privateMatch = await world.start("private", true, seed + 2);
      assert(privateMatch.inviteToken, "Private fixture has no invite"); secrets.add(privateMatch.inviteToken);
      const privateResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/watch/live/${privateMatch.lobbyId}` && response.status() === 200);
      await page.goto(`${world.origins[0]}/?board=${queryMode}&watch=1&lobby=${privateMatch.lobbyId}#invite=${encodeURIComponent(privateMatch.inviteToken)}`, { waitUntil: "domcontentloaded" });
      await privateResponse;
      await assertNoRetiredChrome(page);
      // Live auto-selection reads the public catalog; a private match never appears in it.
      const publicCatalog = await context.request.get(`${world.origins[0]}/watch/catalog`);
      assert(publicCatalog.ok() && !(await publicCatalog.text()).includes(privateMatch.lobbyId), "Private match appeared in public discovery");
      await world.revoke(privateMatch.lobbyId);
      const refusedLive = await context.request.get(`${world.origins[0]}/watch/live/${privateMatch.lobbyId}`, { headers: { "x-antwar-invite": privateMatch.inviteToken } });
      assert(refusedLive.status() === 404, "Revoked invite admitted a new live request");
      world.advance(privateMatch.untilReleaseMs() - 1);
      await withResultTiming(page, world, privateMatch, "private-attached-revoked", resultTimings, () => privateMatch.play());
      await waitText(page, ROSTER, world.displayNames[0]!); // The already-attached stream survived revocation.
      await page.locator(RATINGS).waitFor({ state: "visible" });
      images.push(await shot(page, `${mode}-private-attached-after-revoke`));
      const replayId = await world.recording(privateMatch.lobbyId);
      const recordingRoute = `${world.origins[0]}/watch/replays/${privateMatch.lobbyId}/${replayId}`;
      assert((await context.request.get(recordingRoute)).status() === 404, "Private recording opened without an invite");
      assert((await context.request.get(recordingRoute, { headers: { "x-antwar-invite": privateMatch.inviteToken } })).status() === 404, "Revoked invite opened a recording");
      const fresh = await world.renew(privateMatch.lobbyId); secrets.add(fresh);
      const bytes = await context.request.get(recordingRoute, { headers: { "x-antwar-invite": fresh } });
      assert(bytes.status() === 200 && bytes.headers()["cache-control"] === "no-store", "Fresh invite did not open a noncached recording");
      await page.goto(`${world.origins[0]}/?board=${queryMode}&watch=1&lobby=${privateMatch.lobbyId}&replay=${replayId}#invite=${encodeURIComponent(fresh)}`, { waitUntil: "domcontentloaded" });
      await assertNoRetiredChrome(page);
      await waitText(page, ROSTER, world.displayNames[0]!);
      await waitText(page, STATUS, "RECORDING");
      images.push(await shot(page, `${mode}-private-recording`));
      const renewedLive = page.waitForResponse(response => new URL(response.url()).pathname === `/watch/live/${privateMatch.lobbyId}` && response.status() === 200);
      await withResultTiming(page, world, privateMatch, "private-renewed-late", resultTimings, async () => {
        await page.goto(`${world.origins[0]}/?board=${queryMode}&watch=1&lobby=${privateMatch.lobbyId}#invite=${encodeURIComponent(fresh)}`, { waitUntil: "domcontentloaded" });
      });
      await renewedLive;
      await assertNoRetiredChrome(page);
      await waitText(page, ROSTER, world.displayNames[0]!);
      await assertNoRetiredChrome(page);
      assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
      report.cases.push({ mode, renderer, seed, mapId: selected.mapId, mapName: selected.mapName,
        chosenMatchRetainedThroughSlotReuse: true, ratedFloorSeconds: 300, unratedPlayback: true, namesAndElo: world.displayNames,
        currentInviteAndExistingStreamRevocation: true, freshPrivateLiveAndReplay: true, resultTimings, reconnectChecks, requests, images, errors });
    } catch (error) {
      images.push(await shot(page, `${mode}-failure`).catch(() => "screenshot unavailable"));
      report.cases.push({ mode, passed: false, error: redact(error), resultTimings, reconnectChecks, images, requests, errors, consoleOutput }); throw error;
    } finally { await context.close(); await world.close(); }
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = redact(error); process.exitCode = 1;
} finally {
  await browser?.close(); report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ head, browser: target, passed: report.passed, report: join(output, "report.json") }));
}
