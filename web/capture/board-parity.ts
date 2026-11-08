/** Short early look: four tilted/top tick-3585 views plus a real food/carrying-worker/
 * soldier close view. Run on a host with Chromium.
 * node --import ./src/ts-resolve.mjs web/capture/board-parity.ts --recording NAME --out DIR [--dist DIR] [--tick 3585]
 * The close view is chosen from the actual recorded state; missing actors fail rather than fabricate evidence. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SUB_TILE, decodeMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { RENDER_DELAY_MS } from "../src/buffer.ts";
import type { Antwar3dApi } from "../src/board3d/main3d.ts";
import { RECORDING_DIR, launchBrowser, openClient } from "./browser.ts";
import { prepare } from "./capture.ts";
import { settle3DBoard } from "./colony-scale.ts";

export interface PatchAnt { id: number; x: number; y: number; carrying: boolean; soldier: boolean }
export interface PatchTarget { x: number; y: number; radius: number; foodTile: number; carryingAnt: number; soldier: number; span: number }

/** Choose the food tile whose nearest carrier and soldier make the tightest real composition. */
export function patchTarget(food: ArrayLike<number>, width: number, ants: readonly PatchAnt[]): PatchTarget | null {
  const carriers = ants.filter((a) => a.carrying && !a.soldier);
  const soldiers = ants.filter((a) => a.soldier);
  if (!carriers.length || !soldiers.length) return null;
  let best: PatchTarget | null = null;
  const nearest = (group: readonly PatchAnt[], x: number, y: number) => group.reduce((a, b) => {
    const da = Math.hypot(a.x - x, a.y - y), db = Math.hypot(b.x - x, b.y - y);
    return db < da || (db === da && b.id < a.id) ? b : a;
  });
  for (let tile = 0; tile < food.length; tile++) {
    if (food[tile]! <= 0) continue;
    const x = tile % width + 0.5, y = Math.floor(tile / width) + 0.5;
    const c = nearest(carriers, x, y), s = nearest(soldiers, x, y);
    const x0 = Math.min(x, c.x, s.x), x1 = Math.max(x, c.x, s.x);
    const y0 = Math.min(y, c.y, s.y), y1 = Math.max(y, c.y, s.y);
    const span = Math.max(x1 - x0, y1 - y0);
    if (best && span >= best.span) continue;
    best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, radius: Math.max(10, (span + 3) * 2.5), span, foodTile: tile, carryingAnt: c.id, soldier: s.id };
  }
  // A whole-board shot cannot honestly stand in as a close view.
  return best && best.span <= 12 ? best : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { recording: { type: "string" }, out: { type: "string" }, dist: { type: "string" }, tick: { type: "string", default: "3585" } } });
  if (!values.recording || !values.out) throw new Error("board-parity needs --recording and --out");
  const tick = Number(values.tick);
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("--tick must be a non-negative integer");
  const messages = unpackMessages(readFileSync(join(RECORDING_DIR, `${values.recording}.bin`))).map(decodeMessage);
  const first = messages[0];
  if (!first?.full) throw new Error("recording has no initial full snapshot");
  const state = new SpectatorState(structuredClone(first.full), first.tick, first.ants);
  let at = first;
  for (const m of messages.slice(1)) {
    if (m.tick > tick) break;
    state.apply(m);
    at = m;
  }
  if (at.tick !== tick) throw new Error(`recording has no exact tick ${tick}`);
  const ants: PatchAnt[] = Array.from({ length: at.ants.count }, (_, i) => ({ id: at.ants.id[i]!, x: at.ants.x[i]! / SUB_TILE, y: at.ants.y[i]! / SUB_TILE, carrying: !!at.ants.carrying?.[i], soldier: at.ants.caste?.[i] === 1 }));
  const target = patchTarget(state.full.food ?? [], state.full.setup.mapW, ants);
  if (!target) throw new Error(`tick ${tick}: no real food patch with a carrying worker and soldier close enough; choose another --tick, never manufacture actors`);
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const webDir = values.dist ? resolve(values.dist) : undefined;
  if (!webDir) await prepare();
  const browser = await launchBrowser();
  const shots: unknown[] = [];
  const errors: string[] = [];
  try {
    for (const [label, width, height] of [["1080p", 1920, 1080], ["phone", 390, 844]] as const) {
      const c = await openClient(browser, { recording: values.recording, width, height, tilt: false, board: "3d", webDir });
      try {
        if (!/babylon/i.test(c.info.rendererName)) throw new Error("3D capture fell back to 2D");
        let now = 0;
        const clockAt = RENDER_DELAY_MS + (tick - first.tick) * TICK_MS;
        while (now < clockAt) {
          const step = Math.min(1000, clockAt - now);
          await c.advance(step); now += step;
          await c.frame(false);
        }
        const shoot = async (name: string) => {
          const primaryBoard = await settle3DBoard(c, tick, name);
          const frame = await c.frame();
          if (frame.playbackTick !== tick) throw new Error(`expected tick ${tick}, drew ${frame.playbackTick}`);
          const camera = await c.page.evaluate(() => (window.__antwar as Antwar3dApi).camera());
          const file = `${name}.jpg`;
          writeFileSync(join(out, file), await c.page.screenshot({ type: "jpeg", quality: 90 }));
          shots.push({ file, viewport: [width, height], frame, camera, primaryBoard, renderer: c.info.rendererString });
          console.log(`${file}: tick ${frame.playbackTick}, ${camera.view}, ${frame.corpses} corpses, ${frame.placeMarks} story places`);
        };
        await shoot(`3d-${label}-tilted-tick${tick}`);
        await c.page.evaluate(() => (window.__antwar as Antwar3dApi).setView("top"));
        await shoot(`3d-${label}-top-tick${tick}`);
        if (label === "1080p") {
          await c.page.evaluate((t) => {
            const api = window.__antwar as Antwar3dApi;
            api.setView("tilted");
            api.focusAt(t.x, t.y, t.radius);
          }, target);
          await shoot(`3d-${label}-food-carrying-soldier-close-tick${tick}`);
        }
        errors.push(...c.errors);
      } finally { await c.close(); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(out, "parity.json"), `${JSON.stringify({ task: "board-parity", recording: values.recording, tick, target, shots, errors }, null, 2)}\n`);
  if (errors.length) throw new Error(errors.join("\n"));
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exitCode = 1; });
