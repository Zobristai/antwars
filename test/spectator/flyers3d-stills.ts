/**
 * Local WebGL stills of the 3D board's flyers beside workers and soldiers, for visual inspection:
 * HEADLESS_SHELL=/path/to/chrome node --import ./src/ts-resolve.mjs test/spectator/flyers3d-stills.ts
 * Builds a private page that draws one hand-built frame with the production Ground and Ants3D (no stream, no client
 * shell), in SwiftShader WebGL, close up and at board scale. Each colony's row, left to right: worker, soldier,
 * grounded flyer, locked-out flyer, flying flyer, hovering flyer. Gates: the page renders without errors and the flyer
 * herds are ready; whether a viewer can tell the states apart is judged from the stills.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import { launchBrowser, REPO_ROOT } from "../../web/capture/browser.ts";

const { values } = parseArgs({ options: { out: { type: "string", default: "out/flyers3d" } } });
const out = resolve(values.out), src = join(out, "src"), dist = join(out, "web");
mkdirSync(src, { recursive: true });
const repo = (path: string) => JSON.stringify(join(REPO_ROOT, path));
writeFileSync(join(src, "index.html"), `<!doctype html><html><body style="margin:0;background:#0b0805"><canvas id="c" style="width:100vw;height:100vh;display:block"></canvas><script type="module" src="./main.ts"></script></body></html>`);
writeFileSync(join(src, "main.ts"), `
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Frame } from ${repo("web/src/buffer.ts")};
import { Ants3D } from ${repo("web/src/board3d/ants3d.ts")};
import { COLONY_RGB, Ground } from ${repo("web/src/board3d/ground.ts")};

const W = 24, H = 16;
const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.043, 0.031, 0.02, 1);
const fill = new HemisphericLight("fill", new Vector3(-0.2, 1, 0.3), scene);
fill.intensity = 0.85; fill.diffuse = new Color3(0.6, 0.68, 0.9); fill.groundColor = new Color3(0.2, 0.13, 0.08); fill.specular = new Color3(0, 0, 0);
const key = new DirectionalLight("key", new Vector3(0.84, -0.4, -0.37).normalize(), scene);
key.diffuse = new Color3(1, 0.76, 0.5); key.intensity = 2.3;
const ground = new Ground(scene, W, H);
const params = new URLSearchParams(location.search);
const length = Number(params.get("length"));
const ants = new Ants3D(scene, ground, length, COLONY_RGB);
const states = [null, null, "grounded", "lockedOut", "flying", "hovering"] as const;
const frame = new Frame();
frame.ensure(12); frame.count = 12;
const flyers = [];
for (let i = 0; i < 12; i++) {
  const colony = i < 6 ? 0 : 1, k = i % 6;
  frame.id[i] = i + 1; frame.x[i] = 6 + k * 2.4; frame.y[i] = 6.5 + colony * 3;
  frame.rotation[i] = colony ? -Math.PI / 2 + 0.4 : 0.4; frame.alpha[i] = 1; frame.colony[i] = colony;
  frame.agent[i] = -1; frame.caste[i] = k === 1 ? 1 : 0;
  flyers.push(states[k] === null ? null : { state: states[k] });
}
frame.ants = { count: 12, id: frame.id.slice(0, 12), x: new Uint16Array(12), y: new Uint16Array(12), heading: new Uint8Array(12),
  colony: frame.colony.slice(0, 12), agent: frame.agent.slice(0, 12), flyers };
const cam = new ArcRotateCamera("view", -Math.PI / 2, Number(params.get("beta")), Number(params.get("radius")), new Vector3(12, 0.3, H - 8), scene);
cam.fov = 0.6; cam.minZ = 0.1;
ants.update(frame);
scene.executeWhenReady(() => {
  for (let i = 0; i < 4; i++) { ants.update(frame); scene.render(); }
  const names = ["flyers-landed0", "flyers-flying0", "flyers-hovering0", "flyers-landed1", "flyers-flying1", "flyers-hovering1", "flyer-shadows"];
  (window as unknown as { __flyers: unknown }).__flyers = names.map((n) => {
    const m = scene.getMeshByName(n)!;
    return { name: n, count: (m as unknown as { thinInstanceCount: number }).thinInstanceCount, ready: m.isReady(true) };
  });
});
`);
await build({ root: src, base: "./", logLevel: "warn", build: { outDir: dist, emptyOutDir: true } });

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const browser = await launchBrowser();
const results: unknown[] = [];
try {
  const shots = [
    { name: "close", length: 1.2, beta: 0.95, radius: 13 },
    { name: "board", length: 0.5, beta: 0.75, radius: 24 },
  ];
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.route("http://flyers.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = join(dist, path === "/" ? "index.html" : path);
      await route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
    });
    await page.goto(`http://flyers.test/?length=${shot.length}&beta=${shot.beta}&radius=${shot.radius}`);
    await page.waitForFunction(() => !!(window as unknown as { __flyers?: unknown }).__flyers, undefined, { timeout: 60_000 });
    const herds = await page.evaluate(() => (window as unknown as { __flyers: { name: string; count: number; ready: boolean }[] }).__flyers);
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2")!;
      return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info")!.UNMASKED_RENDERER_WEBGL) as string;
    });
    assert.match(renderer, /SwiftShader/);
    assert.deepEqual(errors, []);
    for (const h of herds) {
      assert(h.ready, `${h.name} not ready`);
      assert.equal(h.count, h.name === "flyer-shadows" ? 4 : h.name.startsWith("flyers-landed") ? 2 : 1, h.name);
    }
    const path = join(out, `flyers3d-${shot.name}.png`);
    await page.screenshot({ path });
    results.push({ shot, herds, path });
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "flyers3d.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
