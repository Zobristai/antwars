import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../../src/live/snapshot.ts";
import { boardReadiness, GROUPED_SEATS_REPLAY, longClockExcerpt, viewport, WIDTHS } from "../../../web/render-check/check.ts";
import { applyTextSize, drawnFonts, fontconfigFor, fontProblem, rootFontSize, TEXT_SIZES, TYPEFACES } from "../../../web/render-check/fonts.ts";
import { ORIGIN, readFixtures, readSnapshot, serveSite } from "../../../web/render-check/serve.ts";

const path = `/replays/${GROUPED_SEATS_REPLAY}`;
const output = "out/replay-seek-gap";
const range = 'input[aria-label="Replay position"]';
const step = (page: Page) => page.evaluate(() => window.__antwar.frame().playbackTick);
const fullBatch = (page: Page) => page.waitForFunction(() => window.__antwar.recording()?.stats.bufferedMessages === 20);
const visible = (page: Page, selector: string) => page.locator(selector).evaluate(el => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));

// Keep the same ten-minute recording for both boards. For the single-mark case only, the last
// message reports one lost nest instead of three; the real scanner and controls produce the button.
function oneNest(replay: Buffer): Buffer {
  const packets = unpackMessages(replay);
  const last = decodeMessage(packets.pop()!);
  const nest = last.events.find(e => e.kind === "queenLost")!;
  return Buffer.from(packMessages([...packets, encodeMessage({ ...last, events: [nest, ...last.events.filter(e => e.kind !== "queenLost")] })]));
}

it.each(TYPEFACES)("holds the replay through a mark and a superseding slider seek in %s", async typeface => {
  const snapshot = await readSnapshot();
  const fixtures = await readFixtures(["web/render-check/fixtures.json", "web/render-check/result-standings-fixture.json"]);
  const replay = longClockExcerpt(fixtures[path]!.bytes!);
  const single = oneNest(replay);
  const fonts = await mkdtemp(join(tmpdir(), "replay-fonts-"));
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome",
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    env: { ...process.env, FONTCONFIG_FILE: await fontconfigFor(typeface, fonts) } });
  try {
    for (const board of ["3d", "2d"]) for (const width of WIDTHS) for (const size of TEXT_SIZES) {
      const cell = `${board}-${width}-${size}-${typeface.replaceAll(" ", "-")}`;
      const view = viewport(width);
      if (width === 320) view.viewport.height = 568;
      const context = await browser.newContext({ ...view, reducedMotion: "reduce" });
      try {
        const grouped = board === "3d";
        const served = await serveSite(context, { fixtures: { ...fixtures, [path]: { ...fixtures[path]!, bytes: grouped ? replay : single } },
          snapshot, dist: "web/dist", rulesPage: () => "" });
        const page = await context.newPage();
        await page.clock.install();
        await applyTextSize(page, size);
        // Stepping the animation clock does not speed up the label's two-second DOM timer.
        await page.addInitScript(() => { Object.defineProperty(performance, "now", { value: () => 0, configurable: true }); });
        let unblock!: () => void;
        let hold = new Promise<void>(resolve => { unblock = resolve; });
        await page.route(`**${path}`, async route => { await hold; await route.fallback(); });
        await page.goto(`${ORIGIN}/?replay=${GROUPED_SEATS_REPLAY}&capture=1&board=${board}`);
        expect(await visible(page, "#aw-waiting")).toBe(true);
        unblock();
        expect(await boardReadiness(page)).toEqual({ state: "ready" });
        const renderer = await page.evaluate(async () => (await window.__antwar.ready).rendererName);
        expect(renderer.toLowerCase().includes("babylon")).toBe(grouped);
        await fullBatch(page);
        const start = await step(page);
        // Establish a visible position different from both the opening snapshot and either target.
        await page.evaluate(() => { for (const t of [250, 500, 750]) {
          Object.defineProperty(performance, "now", { value: () => t }); window.__antwar.frame(false);
        } });
        const held = await step(page);
        expect(held).toBeGreaterThan(start);
        const mark = page.locator(grouped ? ".aw-mark.group" : ".aw-mark:not(.group)").first();
        await page.waitForFunction(() => { window.__antwar.frame(false); return !!document.querySelector(".aw-mark"); });
        hold = new Promise<void>(resolve => { unblock = resolve; });
        // Freeze DOM timers for the real tap: a slow software draw must not consume the label lifetime.
        await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 10_000)));
        const activate = async (selector: typeof mark) => width < 600 ? selector.tap({ force: true }) : selector.click({ force: true });
        await activate(mark);
        if (grouped) await activate(page.locator(".aw-mark-row").first());
        expect(await step(page)).toBe(held);
        expect(await visible(page, "#aw-waiting")).toBe(false);
        for (const selector of [".aw-replay-time", range, '[aria-label="Replay speed"]', ".aw-mark-label", ".aw-replay-state"]) expect(await visible(page, selector), selector).toBe(true);
        expect(await page.locator(".aw-replay-state").innerText()).toBe("Seeking…");
        expect(await page.locator(range).inputValue()).toBe("601000");
        expect(await page.locator(".aw-replay-time").innerText()).toBe("10:01 / 10:01");
        await page.screenshot({ path: `${output}/${cell}.png` });
        await page.clock.runFor(1999);
        expect(await visible(page, ".aw-mark-label"), "label before its timeout").toBe(true);
        await page.clock.runFor(1);
        expect(await visible(page, ".aw-mark-label"), "label after its timeout").toBe(false);
        await page.clock.resume();
        expect(await rootFontSize(page)).toBe(size);
        const faces = await drawnFonts(page);
        expect(Object.keys(faces).some(f => f.startsWith(typeface))).toBe(true);
        expect(fontProblem(typeface, faces)).toBeNull();
        unblock();
        await fullBatch(page);
        // The first batch can draw a board, but not the chosen position. Do not expose it.
        expect(await step(page)).toBe(held);
        expect(await page.locator(range).inputValue()).toBe("601000");
        expect(await page.locator(".aw-replay-state").innerText()).toBe("Seeking…");
        hold = new Promise<void>(resolve => { unblock = resolve; });
        await page.locator(range).evaluate(el => { const input = el as HTMLInputElement; input.value = "3400"; input.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(await step(page)).toBe(held);
        expect(await page.locator(range).inputValue()).toBe("3400");
        expect(await visible(page, "#aw-waiting")).toBe(false);
        unblock();
        await fullBatch(page);
        expect(await step(page)).toBe(held);
        await fullBatch(page);
        expect(await step(page)).toBe(start + 34);
        expect(await page.locator(".aw-replay-state").textContent()).toBe("");
        expect(await visible(page, "#aw-waiting")).toBe(false);
        expect(served.unanswered).toEqual([]);
      } catch (cause) { throw new Error(cell, { cause }); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); await rm(fonts, { recursive: true, force: true }); }
}, 180_000);
