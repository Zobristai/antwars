/** Paired ground evidence; manual capture helper, not a Vitest test.
 * Existing terrain.ts captures default/whole/top and judges changed margins, not a matte material.
 * node --import ./src/ts-resolve.mjs test/spectator/ground-matte-stills.ts --phase before --dist out/ground-matte-baseline
 * Repeat with --phase after --dist web/dist; never builds, mutates Git or contacts the public site.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { encodeMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { terrainFixture, assertTerrainScene } from "../../web/capture/terrain.ts";
import { BlankPrimaryBoardError, boundedCapture, settle3DBoard } from "../../web/capture/colony-scale.ts";
import { launchBrowser, openClient, RECORDING_DIR, type ClientPage } from "../../web/capture/browser.ts";
import type { Antwar3dApi } from "../../web/src/board3d/main3d.ts";
import { median, PASS_MS } from "../../web/src/board3d/quality.ts";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tick = 3100;
const out = "playtest-results/ground-matte-stills";
const sourcePaths = ["web/src/board3d/ground.ts", "web/src/board3d/noise.ts", "web/src/board3d/main3d.ts", "web/src/board3d/quality.ts"];
const { values } = parseArgs({ options: { phase: { type: "string" }, dist: { type: "string" }, "timing-map": { type: "string" } } });
if (!values.dist || (!values["timing-map"] && !["before", "after"].includes(values.phase ?? ""))) throw new Error("--dist and --phase before|after or --timing-map required");
const phase = values.phase ?? "interleaved", dist = resolve(values.dist);

/** The real timing source includes GPU readback; the stepped quality clock is NOT a cost measurement. */
async function phoneTiming(client: ClientPage) {
  for (let i = 0; i < 10; i++) await client.frame();
  const rawMs: number[] = [];
  for (let i = 0; i < 60; i++) {
    const frame = await client.frame();
    if (frame.playbackTick !== tick || frame.ingestMs === undefined || frame.updateMs === undefined || frame.renderMs === undefined) throw new Error("invalid phone timing sample");
    rawMs.push(frame.ingestMs + frame.updateMs + frame.renderMs);
  }
  const finalPaint = await settle3DBoard(client, tick, "phone timing final");
  return { method: "60 frozen-tick real ingest + update + readPixels-finished render samples after 10 warmups; SwiftShader touch emulation, not a phone GPU or real frame cadence", rawMs, medianMs: median(rawMs), budgetMs: PASS_MS, withinSoftwareBudget: median(rawMs) <= PASS_MS, finalPaint };
}
mkdirSync(out, { recursive: true }); mkdirSync(RECORDING_DIR, { recursive: true });
const sources = Object.fromEntries(sourcePaths.map((path) => [path, sha(readFileSync(path))]));
const build = Object.fromEntries(readdirSync(dist, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
  const path = join(entry.parentPath, entry.name);
  return [path.slice(dist.length + 1), sha(readFileSync(path))];
}));
const shots: unknown[] = [], timings: unknown[] = [];
let executionError: string | null = null;
const browser = await launchBrowser();
try {
  const rules = rulesConfig("redesign");
  if (!rules.terrain) throw new Error("terrain rules unavailable");
  const maps = rules.terrain.maps.filter((map) => !values["timing-map"] || map.id === values["timing-map"]);
  if (!maps.length) throw new Error("unknown --timing-map");
  for (const map of maps) {
    const config = { ...rules, terrain: { ...rules.terrain, mapId: map.id } };
    const fixture = terrainFixture(config, tick), packed = packMessages([encodeMessage(fixture)]);
    const recording = `ground-matte-${map.id}`;
    writeFileSync(join(RECORDING_DIR, `${recording}.bin`), packed);
    if (values["timing-map"]) {
      // Alternate paired order too, so one build is not always measured first: AB, BA, AB.
      for (const [index, side] of ["before", "after", "after", "before", "before", "after"].entries()) {
        const startedAt = new Date().toISOString();
        const webDir = side === "before" ? resolve("out/ground-matte-baseline") : dist;
        const client = await boundedCapture(openClient(browser, { recording, width: 390, height: 844, phone: true, tilt: false, board: "3d", webDir, rules: config }), `${map.id} ${side} ready`, 30_000);
        try {
          await client.advance(2000);
          await settle3DBoard(client, tick, `${map.id} ${side} interleaved`);
          const scene = await client.page.evaluate(() => {
            const api = window.__antwar as Antwar3dApi;
            return { camera: api.camera(), qualityTier: api.quality().tier, tick: api.frame(false).playbackTick };
          });
          const timing = await phoneTiming(client);
          if (client.errors.length) throw new Error(client.errors.join("\n"));
          timings.push({ map: map.id, pair: Math.floor(index / 2) + 1, side, startedAt, endedAt: new Date().toISOString(), fixtureSha256: sha(packed), renderer: client.info.rendererString, viewport: [390, 844], scene, ...timing });
          console.log(`${map.id} pair ${Math.floor(index / 2) + 1} ${side}: ${timing.medianMs.toFixed(2)} ms`);
        } finally { await client.close(); }
      }
      continue;
    }
    for (const [width, height] of [[1920, 1080], [390, 844]] as const) {
      const client = await boundedCapture(openClient(browser, { recording, width, height, phone: width === 390, tilt: false, board: "3d", webDir: dist, rules: config }), `${map.id} ready`, 30_000);
      try {
        await client.advance(2000);
        for (const view of ["default", "tilted", "boundary"] as const) {
          await client.page.evaluate(({ view, mapW, mapH }) => {
            const api = window.__antwar as Antwar3dApi;
            api.setView(view === "boundary" ? "top" : "tilted");
            if (view === "tilted") api.focusAt(mapW / 2, mapH / 2, api.camera().radius * 0.72);
            if (view === "boundary") api.zoomAt(0.5, innerWidth / 2, innerHeight / 2);
          }, { view, mapW: client.info.mapW, mapH: client.info.mapH });
          let paint: Awaited<ReturnType<typeof settle3DBoard>> | null = null;
          const blankAttempts: unknown[] = [];
          for (let attempt = 1; attempt <= 2; attempt++) {
            try { paint = await settle3DBoard(client, tick, `${phase} ${map.id} ${width} ${view}`); break; }
            catch (error) {
              if (!(error instanceof BlankPrimaryBoardError)) throw error;
              blankAttempts.push({ attempt, first: error.first, last: error.last, draws: error.attempts });
            }
          }
          const scene = await client.page.evaluate(() => {
            const api = window.__antwar as Antwar3dApi;
            const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
            const waiting = document.getElementById("aw-waiting");
            return { playbackTick: api.frame(false).playbackTick, board: api.board(), liveQueens: api.nests().filter((queen) => !queen.lost).length,
              waitingVisible: waiting !== null && !waiting.hidden && visible(waiting), camera: api.camera(), quality: api.quality() };
          });
          assertTerrainScene(scene, tick);
          const file = `${map.id}-${width}x${height}-${view}-${phase}.png`;
          const png = await client.page.screenshot({ path: join(out, file) });
          shots.push({ map: map.id, viewport: [width, height], view, file, sha256: sha(png), status: paint ? "rendered" : "unrendered", paint, blankAttempts, scene,
            fixture: { tick, seed: 7001, agents: 0, ants: fixture.ants.count, sha256: sha(packed) }, renderer: client.info.rendererString });
          console.log(`${phase} ${map.id} ${width} ${view}: ${paint ? "rendered" : "unrendered"}`);
          if (width === 390 && view === "default" && paint) {
            timings.push({ map: map.id, viewport: [width, height], ...await phoneTiming(client) });
          }
        }
        if (client.errors.length) throw new Error(client.errors.join("\n"));
      } finally { await client.close(); }
    }
  }
} catch (error) { executionError = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await browser.close();
  const reportName = values["timing-map"] ? `interleaved-${values["timing-map"]}` : phase;
  writeFileSync(join(out, `${reportName}.json`), JSON.stringify({ phase, baselineHead: "240b49f94aaef617479680e69bce2a483885ab4a", sourceState: "capture taken before commit; source/build digests pin actual bytes", sources, build, tick, shots, timings, executionError }, null, 2) + "\n");
}
