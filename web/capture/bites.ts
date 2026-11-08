/** Real seed-6006 reciprocal pairs, intentional visual-cycle phase stills
 * and eight actual clip frames per contact sheet. Pixel readability
 * remains a visual judgment, not a cadence/NullEngine assertion. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SUB_TILE, decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { RECORD_CONFIG, playScripted } from "../../src/live/record.ts";
import { BITE_MS, BITE_OPEN_MS, BITE_CONTACT_MS, BITE_RECOVERED_MS, EngagementTracker } from "../src/bite.ts";
import { RENDER_DELAY_MS } from "../src/buffer.ts";
import { gridScale } from "../src/grid-scale.ts";
import type { Antwar3dApi } from "../src/board3d/main3d.ts";
import { RECORDING_DIR, frameClockMs, launchBrowser, openClient, type ClientPage } from "./browser.ts";
import { prepare, provenance, recordMatch } from "./capture.ts";
import { MAX_VIDEO_BYTES, Mp4Encoder, decodeVideo } from "./ffmpeg.ts";

export interface EngagementSample { tick: number; attacker: number; target: number }
export interface Encounter { tick: number; attacker: number; target: number; x: number; y: number }
/** Next complete visual cycle, relative to the encounter's event clock. */
export function visualPhases(encounter: Pick<Encounter, "tick">) {
  const age = (encounter.tick * TICK_MS) % BITE_MS;
  const start = age <= BITE_OPEN_MS ? -age : BITE_MS - age;
  return [{ age: start + BITE_OPEN_MS, name: "open" }, { age: start + BITE_CONTACT_MS, name: "contact" }, { age: start + BITE_RECOVERED_MS, name: "recovered" }];
}
const CLIP_FPS = 30;
const FIGHT_CLIP_MS = 4000;

export function parseLeadMs(value = "0"): number {
  const leadMs = Number(value);
  if (value.trim() === "" || !Number.isSafeInteger(leadMs) || leadMs < 0) throw new Error("lead-ms must be a nonnegative whole number of milliseconds");
  return leadMs;
}

/** Preserve four seconds after the fight, adding the requested lead-in. Both
 * ends must have real recorded state; do not clamp or manufacture pre-roll. */
export function clipWindow(encounterTick: number, firstTick: number, lastTick: number, leadMs = 0) {
  if (!Number.isSafeInteger(leadMs) || leadMs < 0) throw new Error("lead-ms must be a nonnegative whole number of milliseconds");
  const eventClock = RENDER_DELAY_MS + (encounterTick - firstTick) * TICK_MS;
  const startClock = eventClock - leadMs;
  if (startClock < RENDER_DELAY_MS || encounterTick + Math.ceil(FIGHT_CLIP_MS / TICK_MS) > lastTick) return null;
  return { eventClock, startClock, leadMs, frameCount: Math.ceil((leadMs + FIGHT_CLIP_MS) * CLIP_FPS / 1000),
    sheetFrames: contactSheetFrames.map((k) => k + Math.ceil(leadMs * CLIP_FPS / 1000)) };
}

/** Works before and after the fight, including fractional-tick lead-ins. */
export function expectedPlaybackTick(nowMs: number, firstTick: number): number {
  return firstTick + Math.floor((nowMs - RENDER_DELAY_MS) / TICK_MS);
}

/** The bite reach the spectator playback gives the tracker: the recording's grid scale (web/src/buffer.ts). */
function matchReach(messages: readonly StreamMessage[]): number {
  return gridScale(messages[0]?.full?.setup ?? {});
}

/** Least-crowded real reciprocal pair inside the recorded clip window. */
export function selectEncounter(messages: readonly StreamMessage[], leadMs = 0): Encounter {
  const byTick = new Map(messages.map((m) => [m.tick, m]));
  const tracker = new EngagementTracker(), reach = matchReach(messages);
  const confirmed = new Map(messages.map((m) => [m.tick, new Map(tracker.observe(m, reach).map((p) => [p.a, p.b]))]));
  const choices: (Encounter & { crowd: number; distance: number })[] = [];
  for (const m of messages) {
    const pairs = confirmed.get(m.tick)!;
    for (const e of m.events) {
      if (e.kind !== "fight" || pairs.get(e.targetId) !== e.antId || !byTick.has(m.tick + 40) ||
        !clipWindow(m.tick, messages[0]!.tick, messages.at(-1)!.tick, leadMs)) continue;
      const end = byTick.get(m.tick + 5);
      const i = m.ants.id.indexOf(e.antId), j = m.ants.id.indexOf(e.targetId);
      if (!end || i < 0 || j < 0 || !end.ants.id.includes(e.antId) || !end.ants.id.includes(e.targetId)) continue;
      if (Array.from({ length: 5 }, (_, k) => confirmed.get(m.tick + k + 1)).some((p) => p?.get(e.antId) !== e.targetId || p.get(e.targetId) !== e.antId)) continue;
      const x = (m.ants.x[i]! + m.ants.x[j]!) / (2 * SUB_TILE), y = (m.ants.y[i]! + m.ants.y[j]!) / (2 * SUB_TILE);
      const distance = Math.hypot(m.ants.x[i]! - m.ants.x[j]!, m.ants.y[i]! - m.ants.y[j]!) / SUB_TILE;
      if (distance < 0.25) continue;
      let crowd = 0;
      for (let k = 0; k < m.ants.count; k++) if (k !== i && k !== j && Math.hypot(m.ants.x[k]! / SUB_TILE - x, m.ants.y[k]! / SUB_TILE - y) < 2) crowd++;
      choices.push({ tick: m.tick, attacker: e.antId, target: e.targetId, x, y, crowd, distance });
    }
  }
  choices.sort((a, b) => a.crowd - b.crowd || b.distance - a.distance || a.tick - b.tick || a.attacker - b.attacker);
  const c = choices[0];
  if (!c) throw new Error("no real fight with a readable reciprocal pair surviving a complete bite in this recording");
  return { tick: c.tick, attacker: c.attacker, target: c.target, x: c.x, y: c.y };
}

/** Fixed-tick eligibility, not a pixel assertion; dead attackers need the test's
 * precombat oracle because post-step lastTargetId exists only for survivors. */
export function biteCadence(samples: readonly EngagementSample[], messages: readonly StreamMessage[], measuredTicks: ReadonlySet<number>) {
  const tracker = new EngagementTracker(), reach = matchReach(messages);
  let hits = 0, shown = 0, unsupported = 0, terminalEligible = 0, unmeasuredMessageTicks = 0, unmeasuredEligibleBites = 0;
  // A present, empty map means the measured tick had zero hits. An absent map
  // means no measurement: never turn missing evidence into a phantom bite.
  const truth = new Map<number, Map<number, number>>();
  for (const tick of measuredTicks) truth.set(tick, new Map());
  for (const p of samples) {
    const at = truth.get(p.tick);
    if (!at) throw new Error(`hit sample at unmeasured tick ${p.tick}`);
    at.set(p.attacker, p.target);
  }
  for (const m of messages) {
    const predicted = tracker.observe(m, reach), real = truth.get(m.tick);
    if (!real) { unmeasuredMessageTicks++; unmeasuredEligibleBites += predicted.length; continue; }
    hits += real.size;
    const dead = new Set(m.events.filter((e) => e.kind === "death").map((e) => e.antId));
    for (const p of predicted) {
      if (p.terminalTick !== undefined && dead.has(p.a)) { terminalEligible++; continue; }
      if (real.get(p.a) === p.b) shown++; else unsupported++;
    }
  }
  return { basis: "surviving attackers' actual lastTargetId per measured tick; dead attackers require separate precombat oracle; eligibility, not pixels",
    hits, shown, missed: hits - shown, unsupported, explicitDeadAttackerTerminalEligible: terminalEligible,
    coverageComplete: unmeasuredMessageTicks === 0, unmeasuredMessageTicks, unmeasuredEligibleBites,
    hitsPerSecond: 10, chompsPerSecond: 1000 / BITE_MS, visualCycleMs: BITE_MS, repeatsWithoutEvent: true };
}
export const contactSheetFrames = [0, 1, 2, 3, 4, 5, 7, 8] as const;

async function advanceTo(c: ClientPage, from: number, to: number): Promise<number> {
  while (from < to) {
    const step = Math.min(1000, to - from);
    await c.advance(step); from += step; await c.frame(false);
  }
  return from;
}
async function focus(c: ClientPage, board: "2d" | "3d", encounter: Encounter, width: number, height: number) {
  await c.page.evaluate(({ board, encounter, width, height }) => {
    if (board === "3d") (window.__antwar as Antwar3dApi).focusAt(encounter.x, encounter.y, 12);
    else {
      const api = window.__antwar, at = api.tileToScreen(encounter.x, encounter.y);
      api.zoomAt(4, at[0], at[1]);
      const moved = api.tileToScreen(encounter.x, encounter.y);
      api.panBy(width / 2 - moved[0], height * 0.48 - moved[1]);
    }
  }, { board, encounter, width, height });
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, "measure-only": { type: "boolean", default: false }, "lead-ms": { type: "string", default: "0" } } });
  if (!values.out) throw new Error("bites needs --out");
  const leadMs = parseLeadMs(values["lead-ms"]);
  const out = resolve(values.out); mkdirSync(out, { recursive: true });
  const samples: EngagementSample[] = [], measuredTicks = new Set<number>([0]);
  const { lines, state: finalState } = playScripted({ seed: 6006, config: RECORD_CONFIG, agents: 10, ticks: 1800, attack: true }, ({ state }) => {
    measuredTicks.add(state.tick);
    for (const ant of state.ants) if (ant.lastTargetId >= 0) samples.push({ tick: state.tick, attacker: ant.id, target: ant.lastTargetId });
  });
  const recording = recordMatch("bite-cadence", lines, finalState.tick);
  const messages = unpackMessages(readFileSync(join(RECORDING_DIR, `${recording.name}.bin`))).map(decodeMessage);
  if (messages.at(-1)!.tick !== finalState.tick) throw new Error("bite recording did not end at the measured final tick");
  const encounter = selectEncounter(messages, leadMs), cadence = biteCadence(samples, messages, measuredTicks);
  if (!cadence.coverageComplete) throw new Error("bite recording includes unmeasured ticks");
  writeFileSync(join(out, "cadence.json"), `${JSON.stringify(cadence, null, 2)}\n`);
  console.log(JSON.stringify({ encounter, cadence }));
  if (values["measure-only"]) return;
  await prepare();
  const browser = await launchBrowser();
  const shots: unknown[] = [], clips: unknown[] = [], errors: string[] = [];
  try {
    const prov = provenance(browser), firstTick = messages[0]!.tick;
    const clip = clipWindow(encounter.tick, firstTick, messages.at(-1)!.tick, leadMs);
    if (!clip) throw new Error("fight clip lies outside the measured recording window");
    const { eventClock, startClock, frameCount, sheetFrames } = clip;
    for (const board of ["2d", "3d"] as const) for (const [label, width, height] of [["desktop", 1920, 1080], ["phone", 390, 844]] as const) {
      const options = { recording: recording.name, width, height, tilt: false, board, phone: label === "phone" };
      const c = await openClient(browser, options);
      try {
        if (board === "3d" && !/babylon/i.test(c.info.rendererName)) throw new Error("requested 3D board fell back to 2D");
        let now = await advanceTo(c, 0, startClock);
        await focus(c, board, encounter, width, height);
        const video = `${board}-${label}-fight.mp4`, encoder = new Mp4Encoder(join(out, video), CLIP_FPS, 4_000_000);
        const frames: unknown[] = [], sheet: { frame: number; ageMs: number; jpeg: string }[] = [];
        const phases = visualPhases(encounter);
        let phaseAt = 0;
        try {
          for (let k = 0; k < frameCount; k++) {
            const nextClock = frameClockMs(k, CLIP_FPS, startClock);
            while (phaseAt < phases.length && eventClock + phases[phaseAt]!.age <= nextClock) {
              const phase = phases[phaseAt++]!;
              now = await advanceTo(c, now, eventClock + phase.age);
              const frame = await c.frame(), file = `${board}-${label}-${phase.name}.jpg`;
              writeFileSync(join(out, file), await c.page.screenshot({ type: "jpeg", quality: 90 }));
              shots.push({ file, board, viewport: [width, height], ageMs: phase.age, frame });
            }
            now = await advanceTo(c, now, nextClock);
            const frame = await c.frame();
            if (frame.playbackTick !== expectedPlaybackTick(now, firstTick)) throw new Error(`capture playback drift at frame ${k}: ${frame.playbackTick}`);
            const jpeg = await c.page.screenshot({ type: "jpeg", quality: 90 }); await encoder.write(jpeg);
            if (sheetFrames.includes(k)) sheet.push({ frame: k, ageMs: now - eventClock, jpeg: jpeg.toString("base64") });
            frames.push({ frame: k, ageMs: now - eventClock, playbackTick: frame.playbackTick });
          }
        } finally { await encoder.close(); }
        const decoded = await decodeVideo(join(out, video));
        if (decoded.frames !== frameCount || decoded.codec !== "h264" || decoded.width !== width || decoded.height !== height || statSync(join(out, video)).size > MAX_VIDEO_BYTES) throw new Error(`${video}: failed decode/size/frame check`);
        const page = await browser.newPage();
        try {
          const thumbW = label === "phone" ? 160 : 320, thumbH = Math.round(thumbW * height / width);
          await page.setViewportSize({ width: thumbW * 4, height: (thumbH + 28) * 2 });
          await page.setContent('<body style="margin:0"><canvas></canvas></body>');
          await page.evaluate(async ({ sheet, thumbW, thumbH, encounter }) => {
            const canvas = document.querySelector("canvas")!; canvas.width = thumbW * 4; canvas.height = (thumbH + 28) * 2;
            const ctx = canvas.getContext("2d")!;
            for (let i = 0; i < sheet.length; i++) {
              const s = sheet[i]!, image = new Image(); image.src = `data:image/jpeg;base64,${s.jpeg}`; await image.decode();
              const x = (i % 4) * thumbW, y = Math.floor(i / 4) * (thumbH + 28);
              ctx.drawImage(image, x, y, thumbW, thumbH); ctx.fillStyle = "#17130d"; ctx.fillRect(x, y + thumbH, thumbW, 28);
              ctx.fillStyle = "#eee4d4"; ctx.font = "12px monospace";
              ctx.fillText(`frame ${s.frame} ${s.ageMs >= 0 ? "+" : ""}${s.ageMs}ms`, x + 4, y + thumbH + 11);
              ctx.fillText(`ants ${encounter.attacker} ↔ ${encounter.target}`, x + 4, y + thumbH + 24);
            }
          }, { sheet, thumbW, thumbH, encounter });
          const file = `${board}-${label}-contact-sheet.png`;
          writeFileSync(join(out, file), await page.screenshot({ type: "png" }));
          shots.push({ file, board, sourceVideo: video, frames: sheet.map(({ frame, ageMs }) => ({ frame, ageMs })) });
        } finally { await page.close(); }
        clips.push({ file: video, board, viewport: [width, height], focus: encounter, renderer: c.info, decoded, leadMs, startClock, frames });
        errors.push(...c.errors);
      } finally { await c.close(); }
      const whole = await openClient(browser, options);
      try {
        await advanceTo(whole, 0, eventClock + visualPhases(encounter)[1]!.age);
        const frame = await whole.frame(), file = `${board}-${label}-whole-board-contact.jpg`;
        writeFileSync(join(out, file), await whole.page.screenshot({ type: "jpeg", quality: 90 }));
        shots.push({ file, board, viewport: [width, height], ageMs: visualPhases(encounter)[1]!.age, frame }); errors.push(...whole.errors);
      } finally { await whole.close(); }
    }
    writeFileSync(join(out, "bites.json"), `${JSON.stringify({ task: "bites", provenance: prov, recording, encounter, cadence, leadMs, measuredFinalTick: finalState.tick, phases: visualPhases(encounter), shots, clips, errors }, null, 2)}\n`);
    if (errors.length) throw new Error(errors.join("\n"));
  } finally { await browser.close(); }
}
if (import.meta.main) main().catch((e) => { console.error(e); process.exitCode = 1; });
