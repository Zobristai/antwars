/** Local live-feed capture. No production hooks, public server or deployment.
 * HEADLESS_SHELL=/path/to/chrome node --import ./src/ts-resolve.mjs test/spectator/queen-scale3d-stills.ts --head SHA
 * Add --tiny for the 120x180 -> 626x890 DPR3 regression, including founding after growth.
 * Builds a private bundle: forces only the initial quality tier and exposes read-only mesh/refit measurements.
 * The EventSource transport is substituted; real deflate decoding, intake worker and delayed live playback run.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync } from "node:zlib";
import { build } from "vite";
import { foundQueen } from "../../src/sim/agents.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import type { SimEvent } from "../../src/sim/types.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { launchBrowser, servePage, type ClientPage } from "../../web/capture/browser.ts";
import { settle3DBoard } from "../../web/capture/colony-scale.ts";

const { values } = parseArgs({ options: { head: { type: "string" }, out: { type: "string", default: "out/queen-scale3d/stills" }, tiny: { type: "boolean", default: false } } });
assert.match(values.head ?? "", /^[a-f0-9]{40}$/);
const out = resolve(values.out), dist = join(out, "web");
mkdirSync(out, { recursive: true });
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = ["web/src/board3d/nests.ts", "web/src/board3d/main3d.ts", "test/spectator/queen-scale3d.test.ts", "test/spectator/queen-scale3d-stills.ts", "package-lock.json"];
const sources = Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(path))]));
const instrumentation: { match: string; replacement: string }[] = [
  { match: "const quality = new QualityController(startTier({ coarsePointer: matchMedia(\"(pointer: coarse)\").matches, shortSide: Math.min(w, h) }));",
    replacement: "const quality = new QualityController(Number(params.get('auditTier')));" },
  { match: "  nests.update(streamQueens(head.full!));", replacement: "  nests.update(streamQueens(head.full!));\n  const auditInitialAntLength = ants.lengthTiles; let auditRefits = 0, auditAreaRefits = 0;" },
  { match: "    squads.resize(w);", replacement: "    squads.resize(w); auditRefits++;" },
  { match: "    areaStale = false;", replacement: "    areaStale = false; auditAreaRefits++;" },
  { match: "  window.__antwar = api;", replacement: `  window.__antwar = api;
  Object.assign(window, { __queenScaleAudit: () => ({
    initialAntLength: auditInitialAntLength, antLength: ants.lengthTiles, refits: auditRefits, areaRefits: auditAreaRefits,
    recorded: input.recorded, tick: frame.tick, antCount: frame.count, tier: quality.tier,
    queens: nests.casters.filter(q => q.isEnabled()).map(q => {
      const scale = new Vector3(); q.getWorldMatrix().decompose(scale);
      const projected = q.getBoundingInfo().boundingBox.vectorsWorld.map(v => Vector3.Project(v, Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport));
      return { name: q.name, scale: q.scaling.asArray(), worldScale: scale.asArray(), frozen: q.isWorldMatrixFrozen,
        bounds: { x0: Math.min(...projected.map(p => p.x)), y0: Math.min(...projected.map(p => p.y)),
          x1: Math.max(...projected.map(p => p.x)), y1: Math.max(...projected.map(p => p.y)) } };
    })
  }) });` },
];
await build({ configFile: resolve("web/vite.config.ts"), build: { outDir: dist, emptyOutDir: true }, plugins: [{
  name: "queen-scale-local-audit-only", enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/web/src/board3d/main3d.ts")) return;
    for (const { match, replacement } of instrumentation) {
      assert.equal(code.split(match).length, 2, `audit anchor must occur once: ${match}`);
      code = code.replace(match, replacement);
    }
    return code;
  },
}] });
const buildDigests = Object.fromEntries(readdirSync(dist, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const path = join(e.parentPath, e.name); return [path.slice(dist.length + 1), digest(readFileSync(path))];
}));
const state = createMatch(6006, PUBLIC_CONFIG), recorder = new SpectatorRecorder(state);
const initial = { ...recorder.initial(), full: recorder.initialFull() };
state.tick = 3000;
const middle: StreamMessage = { ...recorder.initial(), tick: state.tick, full: recorder.initialFull() };
state.colonies[0].foodStore = 10000;
const x = 18, y = 10;
state.owner[y * state.config.mapWidth + x] = 0;
const events: SimEvent[] = [];
assert.equal(foundQueen(state, 0, x, y, state.tick, events), null);
state.tick++;
const founded = { ...recorder.record({ state, events, results: [] }), full: null };
assert(founded.events.some(e => e.kind === "queenFounded"));
const wire = (message: StreamMessage) => deflateRawSync(encodeMessage(message)).toString("base64");
// Live playback requires 1.5 seconds of future ticks before its first shown frame.
const fixture = {
  opening: [initial, ...Array.from({ length: 16 }, (_, i) => ({ tick: i + 1, full: null, ants: initial.ants, events: [] }))].map(wire),
  founding: [middle, founded, ...Array.from({ length: 15 }, (_, i) => ({ tick: 3002 + i, full: null, ants: founded.ants, events: [] }))].map(wire),
};
writeFileSync(join(out, "fixture.json"), JSON.stringify(fixture));
interface Audit {
  initialAntLength: number; antLength: number; refits: number; areaRefits: number; recorded: boolean;
  tick: number; antCount: number; tier: number;
  queens: { name: string; scale: number[]; worldScale: number[]; frozen: boolean; bounds: { x0: number; y0: number; x1: number; y1: number } }[];
}
interface AuditWindow { __queenScaleAudit(): Audit; __emitQueenFixture(data: string): void }
const shots: unknown[] = [], transitions: unknown[] = [], problems: string[] = [];
const browser = await launchBrowser();
if (values.tiny) {
  // Test-only context setting; no renderer or production capture API change.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = options => newContext({ ...options, deviceScaleFactor: 3 });
}
const sizes: readonly (readonly [number, number])[] = values.tiny ? [[626, 890]] : [[393, 659], [1024, 1366]];
let failure: string | null = null;
try {
  for (const [width, height] of sizes) for (const tier of values.tiny ? [1] : [0, 1, 2, 3]) {
    const { page, errors, url } = await servePage(browser, { recording: "unused", width: values.tiny ? 120 : width, height: values.tiny ? 180 : height, phone: values.tiny || width === 393, tilt: true, board: "3d", webDir: dist });
    try {
      // Substitute transport only, so the production source/worker/codec/live playback still run.
      await page.context().addInitScript(({ opening }) => {
        class FixtureEventSource {
          onopen: ((event: Event) => unknown) | null = null;
          onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
          onerror: ((event: Event) => unknown) | null = null;
          readyState = 1;
          constructor() {
            (window as unknown as AuditWindow).__emitQueenFixture = data => this.onmessage?.(new MessageEvent("message", { data }));
            queueMicrotask(() => { this.onopen?.(new Event("open")); for (const data of opening) this.onmessage?.(new MessageEvent("message", { data })); });
          }
          close() { this.readyState = 2; }
        }
        Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
      }, { opening: fixture.opening });
      const target = new URL(url); target.searchParams.delete("recording"); target.searchParams.set("match", "396"); target.searchParams.set("auditTier", String(tier));
      await page.goto(target.href);
      // The entry asynchronously loads lobby controls before the spectator module.
      await page.waitForFunction(() => !!window.__antwar, undefined, { timeout: 15_000 });
      const info = await page.evaluate(() => window.__antwar.ready);
      assert.match(info.rendererName, /^babylon /); assert.match(info.rendererString, /SwiftShader/);
      await page.evaluate(() => document.fonts.ready);
      const sample = () => page.evaluate(() => (window as unknown as AuditWindow).__queenScaleAudit());
      const construction = await sample();
      if (values.tiny) {
        assert.deepEqual(info.cssSize, [120, 180]);
        assert.equal(await page.evaluate(() => devicePixelRatio), 3);
      }
      const step = async (ms = 16) => { await page.clock.runFor(ms); await page.evaluate(() => window.__antwar.frame()); };
      const check = (audit: Audit, queens: number) => {
        assert.equal(audit.recorded, false); assert.equal(audit.tier, tier); assert.equal(audit.queens.length, queens);
        assert(audit.antCount > 0); assert(audit.areaRefits > 0);
        for (const queen of audit.queens) {
          assert(queen.frozen);
          for (const scale of [...queen.scale, ...queen.worldScale]) {
            const correct = Math.abs(scale / audit.antLength - 2.4) < 0.00001;
            // Finish both tiny-start phases before failing, so later founding is tested on the baseline too.
            if (values.tiny) { if (!correct) problems.push(`tick ${audit.tick} ${queen.name}: ${scale / audit.antLength} ant lengths, expected 2.4`); }
            else assert(correct, `${queen.name}: scale is not 2.4 ant lengths`);
          }
        }
      };
      const receive = async (newestTick: number) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const newest = await page.evaluate(() => { window.__antwar.frame(false); return window.__antwar.playback().newestTick; });
          if (newest === newestTick) return;
          await page.clock.runFor(10);
        }
        throw new Error(`live fixture never delivered tick ${newestTick}`);
      };
      await receive(16);
      await page.evaluate(() => { window.__antwar.frame(); window.__antwar.frame(); });
      if (values.tiny) {
        await page.setViewportSize({ width, height }); await step(); await step(); await step();
      }
      const start = await sample(), initialCount = initial.full!.queens!.length;
      if (values.tiny) transitions.push({ viewport: [width, height], tier, construction, afterResize: start });
      check(start, initialCount); assert.equal(start.tick, 0);
      const client: ClientPage = { page, info, errors,
        frame: render => page.evaluate(render => window.__antwar.frame(render), render),
        advance: ms => page.clock.runFor(ms), setOptions: options => page.evaluate(options => window.__antwar.setOptions(options), options),
        close: () => page.context().close() };
      const shoot = async (phase: string, beforePaint: Audit) => {
        // Overlay crowns alone are not a board render. Await shader compilation and verify primary pixels.
        const paint = await settle3DBoard(client, beforePaint.tick, `${width}x${height} tier${tier} ${phase}`);
        const audit = await sample(); check(audit, beforePaint.queens.length);
        const file = `${width}x${height}-tier${tier}-${phase}.png`;
        const bytes = await page.screenshot({ path: join(out, file) });
        shots.push({ file, sha256: digest(bytes), viewport: [width, height], phase, audit, paint, renderer: info.rendererString });
        console.log(`${file}: tick ${audit.tick}, ${audit.queens.length} queens, ant length ${audit.antLength}`);
      };
      await shoot("live-start", start);
      if (!values.tiny) {
        // Cross the ant-size plateau so this transition actually changes the length, then restore.
        await page.setViewportSize(width === 393 ? { width: width + 120, height: height + 80 } : { width: 393, height: 659 }); await step(); await step();
        const resized = await sample(); check(resized, initialCount); assert(resized.refits > start.refits);
        assert.notEqual(resized.antLength, start.antLength, "resize must exercise a different ant length");
        await page.setViewportSize({ width, height }); await step(); await step();
        const restored = await sample(); check(restored, initialCount);
        transitions.push({ viewport: [width, height], tier, start, resized, restored });
      }
      await page.evaluate(messages => { for (const data of messages) (window as unknown as AuditWindow).__emitQueenFixture(data); }, fixture.founding);
      await receive(3016);
      await step(120); await step(); await step();
      const after = await sample(); check(after, initialCount + 1); assert.equal(after.tick, 3001);
      assert(after.queens.some(q => q.name === "queen0-1"));
      await shoot("mid-match-founded", after);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(JSON.stringify({ viewport: [width, height], tier, errors }));
      await page.screenshot({ path: join(out, "failed-page.png") }).catch(() => undefined);
      throw error;
    } finally { await page.context().close(); }
  }
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
finally {
  await browser.close();
  writeFileSync(join(out, "report.json"), JSON.stringify({ head: values.head, sourceState: "source digests pin actual tested bytes; capture-only instrumentation listed below", sources,
    instrumentation, buildDigests, fixtureSha256: digest(JSON.stringify(fixture)), environment: "Chromium SwiftShader emulation; not physical phone/tablet Safari evidence",
    tinyStartup: values.tiny, shots, transitions, problems, failure }, null, 2));
}
assert.equal(shots.length, values.tiny ? 2 : 16);
assert.deepEqual(problems, [], "tiny-start queens must stay at 2.4 ant lengths after growth and later founding");
