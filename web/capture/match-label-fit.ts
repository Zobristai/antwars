/** Local match-page label diagnostic. No service requests leave the browser.
 * Required arguments: --dist DIR --recording FILE --tick N --font FAMILY --out DIR --browser FILE --label NAME
 * Optional: --replay, --width 390|1280, --board 2d|3d. Output paths are supplied only by --out.
 * Run separately under a fontconfig configuration resolving system-ui to the requested face.
 * The manifest retains actual CDP fonts, raw geometry and conservative box-based tight fits.
 * Shrink-to-fit items have zero measured spare; this is not a claim that their parent cannot grow.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { decodeMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { RENDER_DELAY_MS } from "../src/buffer.ts";
import { CHROMIUM_FLAGS, checkRenderer, servePage } from "./browser.ts";

export const FIT_TARGETS = ".d1-glabel, .d1-back, .d1-name, .d1-crow-name, .d1-cap-what, .d1-cap-who, .d2-name-text, .d2-qname, .d2-slabel, .d2-back-text, .d2-toast-what, .d2-toast-who";
export interface TextFit { text: string; target: boolean; lines: number; clipped: boolean; outside: boolean }
/** Replay controls seek from the recording's opening tick, including a mid-match excerpt. */
export function recordingPositionMs(tick: number, firstTick: number, ticksPerSecond: number): number {
  assert(ticksPerSecond > 0 && Number.isFinite(ticksPerSecond));
  assert(tick >= firstTick, "target precedes recording");
  return (tick - firstTick) * 1000 / ticksPerSecond;
}
export function fitProblems(items: readonly TextFit[]): string[] {
  return items.filter(i => i.target && (i.lines > 1 || i.clipped || i.outside)).map(i => `${i.text}: ${i.lines} lines; clipped=${i.clipped}; outside=${i.outside}`);
}

export function nameTapPoints(box: { x: number; y: number; width: number; height: number }) {
  assert(box.width > 2 && box.height > 0, "name must have a visible interior");
  return [
    { edge: "left", x: box.x + 1, y: box.y + box.height / 2 },
    { edge: "right", x: box.x + box.width - 1, y: box.y + box.height / 2 },
  ];
}

/** Use physical coordinates, not a click on the underlying half: names can cross its boundary. */
async function checkNameDrawers(page: Page, touch: boolean) {
  const checks = [];
  const reset = async () => {
    await page.locator(".d2-half.c0").focus();
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    for (const colony of [0, 1]) assert.equal(await page.locator(`.d2-half.c${colony}`).getAttribute("aria-expanded"), "false", "drawer reset failed");
  };
  for (const colony of [0, 1]) {
    const name = page.locator(`.d2-name.c${colony} .d2-name-text`);
    const chevron = page.locator(`.d2-name.c${colony} .d2-chevron`);
    const box = await name.boundingBox(), arrow = await chevron.boundingBox();
    assert(box && arrow, "name and chevron must be visible");
    const points = [...nameTapPoints(box), { edge: "chevron", x: arrow.x + arrow.width / 2, y: arrow.y + arrow.height / 2 }];
    for (const point of points) {
      await reset();
      if (touch) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      const expanded = await Promise.all([0, 1].map(c => page.locator(`.d2-half.c${c}`).getAttribute("aria-expanded")));
      const visible = await Promise.all([0, 1].map(c => page.locator(`#d2-drawer-${c}`).isVisible()));
      checks.push({ colony, text: await name.innerText(), ...point, input: touch ? "touch" : "mouse", expanded, visible,
        passed: expanded[colony] === "true" && expanded[1 - colony] === "false" && visible[colony] && !visible[1 - colony] });
    }
  }
  await reset();
  return checks;
}

/** Evaluated in the page, so keep every dependency inside this function. */
export function measureLabels(targets: string) {
  const elements = [...document.querySelectorAll<HTMLElement>("body *")].filter(e => {
    if (e.matches("script, style, option") || e.closest(".d1-sr, .d2-sr, [hidden]")) return false;
    const box = e.getBoundingClientRect();
    for (let a = e.parentElement; a; a = a.parentElement) {
      // Measure the whole outer HUD, but not rows scrolled out of a nested history/list viewport.
      if (a.matches(".aw-hud, body, html")) continue;
      const clip = a.getBoundingClientRect();
      if (getComputedStyle(a).overflowY !== "visible" && (box.bottom <= clip.top || box.top >= clip.bottom)) return false;
    }
    return e.checkVisibility({ visibilityProperty: true }) && box.width > 0 &&
      [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
  });
  const measured = elements.map((e, index) => {
    e.setAttribute("data-label-fit", String(index));
    const cs = getComputedStyle(e), box = e.getBoundingClientRect();
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), rects: DOMRect[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim() || n.parentElement?.closest(".d1-sr, .d2-sr, [hidden]") || !n.parentElement?.checkVisibility({ visibilityProperty: true })) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      rects.push(...[...range.getClientRects()].filter(r => r.width > 0 && r.height > 0));
    }
    const lineBoxes: { top: number; bottom: number }[] = [];
    for (const r of rects) {
      const line = lineBoxes.find(l => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.bottom - l.top, r.height) / 2);
      if (line) { line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom); }
      else lineBoxes.push({ top: r.top, bottom: r.bottom });
    }
    const lines = lineBoxes.length;
    const clone = e.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id"); clone.removeAttribute("data-label-fit");
    Object.assign(clone.style, { position: "absolute", visibility: "hidden", width: "max-content", maxWidth: "none", minWidth: "0", whiteSpace: "nowrap", flex: "none", padding: "0", border: "0" });
    e.parentElement!.append(clone); const needed = clone.getBoundingClientRect().width; clone.remove();
    const available = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    let clipped = e.scrollWidth > e.clientWidth + 1 && cs.overflowX !== "visible";
    for (let a = e.parentElement; a; a = a.parentElement) {
      const r = a.getBoundingClientRect();
      if (getComputedStyle(a).overflowX !== "visible" && rects.some(t => t.left < r.left - 1 || t.right > r.right + 1)) clipped = true;
    }
    const target = e.matches(targets) || e.closest(targets) !== null;
    const inventory = target || e.matches("button, th, [role=columnheader], [role=button], label, dt") ||
      /nowrap/.test(cs.whiteSpace) || /tag|badge|pill|chip|state|mode|status|clock|label|heading|kicker|d1-ml/.test(e.className);
    return { index, text: e.textContent?.trim() ?? "", cls: e.className, cssFamily: cs.fontFamily, target, inventory, lines, needed, available,
      spare: available > 0 ? 100 * (1 - needed / available) : null, clipped,
      outside: rects.some(r => r.left < -1 || r.right > innerWidth + 1),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      rects: rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) };
  });
  return measured.map((item, i) => ({ ...item, overlaps: measured.flatMap((other, j) => {
    if (j === i || elements[i]!.contains(elements[j]!) || elements[j]!.contains(elements[i]!)) return [];
    const hit = item.rects.some(a => other.rects.some(b => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2));
    return hit ? [other.index] : [];
  }) }));
}

async function capture(): Promise<void> {
  const { values: a } = parseArgs({ options: {
    dist: { type: "string" }, recording: { type: "string" }, tick: { type: "string" }, font: { type: "string" },
    out: { type: "string" }, browser: { type: "string" }, label: { type: "string" }, replay: { type: "boolean" },
    width: { type: "string" }, board: { type: "string" }, "expect-fit": { type: "boolean" },
  } });
  for (const key of ["dist", "recording", "tick", "font", "out", "browser", "label"] as const) assert(a[key], `--${key} required`);
  assert(/^[a-z0-9-]+$/.test(a.label!), "label must be a filename-safe name");
  assert(!a.width || ["390", "1280"].includes(a.width));
  assert(!a.board || ["2d", "3d"].includes(a.board));
  const tick = Number(a.tick); assert(Number.isInteger(tick) && tick >= 0);
  const bytes = await readFile(a.recording!), packets = unpackMessages(bytes);
  const first = decodeMessage(packets[0]!), last = decodeMessage(packets.at(-1)!);
  assert(tick >= first.tick && tick <= last.tick, "requested tick outside recording");
  const targetMs = recordingPositionMs(tick, first.tick, first.full!.setup.ticksPerSecond);
  const stored = { id: "2026-11-15T17-00-00-000Z-1", bytes, lastTick: last.tick };
  const out = resolve(a.out!); await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: a.browser!, args: CHROMIUM_FLAGS });
  const runs: unknown[] = [];
  try {
    for (const board of (a.board ? [a.board] : ["2d", "3d"]) as ("2d" | "3d")[]) for (const width of a.width ? [Number(a.width)] : [390, 1280]) {
      const height = width === 390 ? 844 : 800;
      const { page, errors, url } = await servePage(browser, { recording: "fixture", replay: a.replay, stored, width, height, tilt: true, webDir: resolve(a.dist!), board, phone: width === 390 });
      try {
        const context = page.context(), blocked: string[] = [];
        await context.route("**/*", async (route) => {
          const u = new URL(route.request().url());
          if (u.origin !== "http://localhost:4718") { blocked.push(u.origin); return route.abort(); }
          if (u.pathname === "/recordings/fixture.bin") return route.fulfill({ contentType: "application/octet-stream", body: bytes });
          if (u.pathname.startsWith("/watch/ratings/")) return route.fulfill({ status: 404, body: "local fixture has no rating metadata" });
          return route.fallback();
        });
        await page.goto(url);
        await page.waitForFunction(() => !!window.__antwar?.ready);
        const info = await page.evaluate(() => window.__antwar.ready);
        assert.equal(checkRenderer(info.rendererString), null);
        if (a.replay) {
          for (let i = 0; i < 120; i++) {
            await page.clock.runFor(100); await page.evaluate(() => window.__antwar.frame(false));
            if (await page.evaluate(target => Number(document.querySelector<HTMLInputElement>(".aw-replay-controls input")?.max ?? 0) >= target, targetMs)) break;
            await new Promise(r => setTimeout(r, 25));
          }
          assert(await page.evaluate(target => Number(document.querySelector<HTMLInputElement>(".aw-replay-controls input")?.max ?? 0) >= target, targetMs), "replay index did not reach requested tick");
          await page.evaluate(to => {
            const input = document.querySelector<HTMLInputElement>(".aw-replay-controls input")!;
            input.value = String(Math.max(0, to - 2000)); input.dispatchEvent(new Event("input")); input.dispatchEvent(new Event("change"));
          }, targetMs);
          // Seeking replays the bounded decoder queue from the start; long fixtures need more than one batch.
          for (let i = 0; i < 900; i++) {
            await page.clock.runFor(100);
            const f = await page.evaluate(() => window.__antwar.frame(false));
            if ((f.playbackTick ?? -1) >= tick) break;
            // Let the recording worker deliver its decoded frames; not a service-status poll.
            await new Promise(r => setTimeout(r, 25));
          }
        } else {
          let now = 0; const end = RENDER_DELAY_MS + targetMs;
          while (now < end) { const step = Math.min(1000, end - now); await page.clock.runFor(step); await page.evaluate(() => window.__antwar.frame(false)); now += step; }
        }
        const frame = await page.evaluate(() => window.__antwar.frame(true));
        assert(Math.abs((frame.playbackTick ?? -100) - tick) <= 1, `wrong tick: ${frame.playbackTick}, expected ${tick}`);
        await page.evaluate(() => document.fonts.ready);
        const items = await page.evaluate(measureLabels, FIT_TARGETS);
        const cdp = await context.newCDPSession(page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const fonts = [];
        for (const item of items) {
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-label-fit="${item.index}"]` });
          const report = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
          fonts.push({ index: item.index, ...report });
        }
        const wrongFonts = fonts.filter(f => !items[f.index]!.cssFamily.includes("Mono") && f.fonts.some(font => !font.familyName.startsWith(a.font!)));
        assert.equal(wrongFonts.length, 0, `unexpected proportional font: ${JSON.stringify(wrongFonts)}`);
        assert(fonts.some(f => f.fonts.some(font => font.familyName.startsWith(a.font!))), "requested font not reported");
        const name = `${a.label}-${board}-${width}`;
        const shot = `${name}.png`; await page.screenshot({ path: join(out, shot) });
        const shots = [shot];
        if (width === 390 && board === "3d") {
          await page.evaluate(() => { const hud = document.querySelector(".aw-hud")!; hud.scrollTop = hud.scrollHeight; });
          const lower = `${name}-lower.png`; await page.screenshot({ path: join(out, lower) }); shots.push(lower);
        }
        const problems = [...fitProblems(items), ...items.filter(i => i.target && i.overlaps.length).map(i => `${i.text}: overlapping item indices ${i.overlaps.join(",")}`)];
        const drawerChecks = board === "2d" && await page.locator('.d2-half.c0').isVisible() ? await checkNameDrawers(page, width === 390) : [];
        for (const check of drawerChecks) if (!check.passed) problems.push(`${check.text} ${check.edge}: wrong drawer after ${check.input}`);
        runs.push({ name, board, width, height, tick: frame.playbackTick, requestedFont: a.font, browser: browser.version(), renderer: info.rendererString,
          drawerChecked: drawerChecks.length > 0, drawerChecks, items, fonts, tightFits: items.filter(i => i.inventory && (i.spare === null || i.spare < 8)), problems, errors, blocked,
          shots: await Promise.all(shots.map(async file => ({ file, sha256: createHash("sha256").update(await readFile(join(out, file))).digest("hex") }))) });
        console.log(`${name}: ${problems.length} target fit problems`);
      } finally { await page.context().close(); }
    }
  } finally {
    await browser.close();
    await writeFile(join(out, `${a.label}.json`), JSON.stringify({ recordingSha256: createHash("sha256").update(bytes).digest("hex"), font: a.font, runs }, null, 2));
  }
  if (a["expect-fit"]) assert(runs.every(run => (run as { problems: string[] }).problems.length === 0), "target label fit failed; see manifest");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await capture();
