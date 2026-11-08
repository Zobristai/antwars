/** Populated-chat real pointer checks on the HUD's zoom controls, with no server or agent joins.
 * npm run build:web && node --import ./src/ts-resolve.mjs web/capture/chat-clearance.ts --board 2d
 * Select --engine webkit and --board 3d for the other engine and board. Missing engines/renderers are gaps, never passes.
 * This is a synthetic acceptance fixture. No production layout is changed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, webkit, type Page } from "playwright-core";
import { encodePublicMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { CHROMIUM_FLAGS, RECORDING_DIR, servePage } from "./browser.ts";

export const CHAT_VIEWPORTS = [[1920, 1080], [1366, 768], [390, 844], [360, 780], [844, 390]] as const;
export type ZoomState = "visible and clear" | "hidden" | "covered";
export function zoomState(visible: boolean, clearHits: boolean, overlaps: boolean): ZoomState {
  return !visible ? "hidden" : !clearHits || overlaps ? "covered" : "visible and clear";
}
/** Presentation-only wire messages; no simulated agent joins or inference. */
export function chatFixture(): StreamMessage[] {
  const opening = new SpectatorRecorder(createMatch(281, withGridScale(rulesConfig("redesign")))).initial();
  const full = new SpectatorRecorder(createMatch(281, withGridScale(rulesConfig("redesign")))).initialFull();
  full.agents = ([0, 1] as const).map(colony => ({ colony, modelLabel: "local fixture", joinTick: 0,
    lastCallTick: 100, prevCallTick: -1, order: "hold", orderX: 10, orderY: 10, intent: "Keep the path clear" }));
  return Array.from({ length: 81 }, (_, i) => ({ ...opening, tick: 100 + i, full: i === 0 ? full : null,
    events: i > 0 && i <= 12 ? [{ kind: "order" as const, agent: i % 2, order: "hold" as const,
      tileX: 10, tileY: 10, intent: `Keep the path clear ${i}` }] : [] }));
}

/** The HUD's zoom controls, Zoom out then Zoom in: their boxes, and whether each is shown and takes its own clicks. */
export async function measureZoom(page: Page) {
  return page.evaluate(() => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const visible = (node: Element) => {
      const r = rect(node), s = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const controls = ["Zoom out", "Zoom in"].flatMap(label => [...document.querySelectorAll(`.aw-hud button[aria-label="${label}"]`)]).map(node => {
      const box = rect(node), shown = visible(node);
      const withinViewport = box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth && box.y + box.height <= innerHeight;
      // Pill corners are outside the rounded hit shape. Probe its centre and four inset cardinal points.
      const hits = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8]].map(([x, y]) => {
        const hit = document.elementFromPoint(box.x + box.width * x, box.y + box.height * y);
        return { own: hit !== null && (hit === node || node.contains(hit)), hit: hit?.className ?? null };
      });
      return { label: node.getAttribute("aria-label"), box, visible: shown, clearHits: withinViewport && hits.every(h => h.own), hits };
    });
    return { controls };
  });
}

async function main() {
  const { values } = parseArgs({ options: { engine: { type: "string", default: "chromium" }, board: { type: "string", default: "2d" },
    out: { type: "string", default: "out/chat-clearance" }, dist: { type: "string" } } });
  assert.ok(["chromium", "webkit"].includes(values.engine));
  assert.ok(["2d", "3d"].includes(values.board));
  const board = values.board as "2d" | "3d", out = resolve(values.out);
  await mkdir(out, { recursive: true }); await mkdir(RECORDING_DIR, { recursive: true });
  const bytes = packMessages(chatFixture().map(message => encodePublicMessage(message)));
  await writeFile(join(RECORDING_DIR, "chat-clearance.bin"), bytes);
  const report = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim(),
    fixture: { kind: "synthetic populated-chat acceptance probe", sha256: createHash("sha256").update(bytes).digest("hex") },
    engine: values.engine, board, records: [] as Record<string, unknown>[], failures: 0 };
  const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  let browser;
  try {
    browser = values.engine === "webkit" ? await webkit.launch() : await chromium.launch({
      executablePath: process.env.HEADLESS_SHELL ?? "/opt/chrome-for-testing/chrome-linux64/chrome",
      args: [...CHROMIUM_FLAGS, "--disable-dev-shm-usage"],
    });
  } catch (error) {
    report.failures++; report.records.push({ result: "unavailable", error: String(error) }); await save(); throw error;
  }
  try {
    for (const [width, height] of CHAT_VIEWPORTS) {
      const record: Record<string, unknown> = { width, height, states: [] }; report.records.push(record);
      const { page, errors, url } = await servePage(browser, { recording: "chat-clearance", width, height, phone: width <= 700 || height <= 500,
        tilt: false, board, webDir: values.dist ? resolve(values.dist) : undefined });
      try {
        await page.goto(url); await page.waitForFunction(() => !!window.__antwar);
        const info = await page.evaluate(() => window.__antwar.ready); record.renderer = info;
        assert.equal(info.rendererName.startsWith("babylon"), board === "3d", "requested renderer must actually start");
        if (board === "2d") await page.locator(".d2-btn-board").waitFor({ state: "attached" });
        await page.evaluate(() => document.fonts.ready); await page.clock.runFor(2500);
        const frame = await page.evaluate(() => window.__antwar.frame(false));
        assert.ok(frame.chat > 0, "fixture must populate real chat playback"); record.chatLines = frame.chat;
        const measured = await measureZoom(page);
        const controls = measured.controls.map(c => ({ ...c, state: zoomState(c.visible, c.clearHits, false) }));
        (record.states as unknown[]).push({ phase: "standing", controls });
        assert.equal(controls.length, 2);
        // The default board zoom and its counter-operation must respond to real pointer input.
        for (const i of [1, 0]) {
          const c = controls[i]!; if (c.state !== "visible and clear") continue;
          const before = await page.evaluate(() => window.__antwar.view().tilePx);
          await page.mouse.click(c.box.x + c.box.width / 2, c.box.y + c.box.height / 2);
          await page.evaluate(() => window.__antwar.frame(false));
          const after = await page.evaluate(() => window.__antwar.view().tilePx);
          assert.ok(i === 1 ? after > before : after < before, "zoom pointer must change the camera");
        }
        assert.deepEqual(errors, []); record.result = "passed";
      } catch (error) { report.failures++; record.result = "failed"; record.error = String(error); }
      finally { record.errors = errors; await page.context().close(); await save(); }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ report: join(out, "report.json"), failures: report.failures }));
  process.exitCode = report.failures ? 1 : 0;
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
