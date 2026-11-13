import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, unlinkSync } from "node:fs";
import { Texture, type Renderer, type Particle } from "pixi.js";
import { Ants } from "../../web/src/ants.ts";
import { Battles } from "../../web/src/effects.ts";
import { BITE_CONTACT_MS, BITE_CONTACT_END_MS, BITE_MS, BITE_OPEN_MS, Bites, EngagementTracker, adjacentWithSlack, headFront } from "../../web/src/bite.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { biteCadence, selectEncounter, contactSheetFrames, clipWindow, expectedPlaybackTick, parseLeadMs, visualPhases, type EngagementSample } from "../../web/capture/bites.ts";
import { recordMatch, type Recorded } from "../../web/capture/capture.ts";
import { frameClockMs } from "../../web/capture/browser.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { scriptedInputs, playScripted } from "../../src/live/record.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { DEFAULT_CONFIG, SUB, speedPerTick } from "../../src/sim/config.ts";
import { HISTORICAL_DEFAULT_CONFIG } from "../sim/fixtures.ts";
import { createMatch, cloneState, buildGrid } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { resolveCombat } from "../../src/sim/combat.ts";
import { applyInput, defaultAllocator, fillSquads, lapseSquads, squadDirections } from "../../src/sim/agents.ts";
import { rebalanceRoles, houseDirection } from "../../src/sim/houseBot.ts";
import { foodTiles } from "../../src/sim/forage.ts";
import { velocity, ZERO } from "../../src/sim/geometry.ts";
import { playable } from "../playable.ts";
import { gridScale } from "../../web/src/grid-scale.ts";

function fightFrame(ageMs = BITE_CONTACT_MS): Frame {
  const f = new Frame(); f.ensure(3); f.count = 3;
  f.tick = 10 + Math.floor(ageMs / TICK_MS); f.renderMs = 10 * TICK_MS + ageMs;
  f.id.set([81, 17, 250]); f.x.set([2, 2, 6]); f.y.set([2, 3, 2]);
  f.alpha.fill(1); f.agent.fill(-1); f.colony.set([0, 1, 1]);
  f.engagements = [{ a: 81, b: 17, tick: 10 }, { a: 17, b: 81, tick: 10 }];
  return f;
}
const draw = (f: Frame, i = 0, length = 1) => { const b = new Bites(); b.update(f); return b.pose(i, length); };
const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;

 describe("event-confirmed target-directed chomps", () => {
  it("keeps the simulation frame unchanged and makes reciprocal head boundaries meet", () => {
    const f = fightFrame(); f.rotation[0] = -Math.PI / 2;
    const original = structuredClone(f), a = draw(f)!, b = draw(f, 1)!;
    expect(Math.sin(a.rotation)).toBeCloseTo(1); expect(Math.sin(b.rotation)).toBeCloseTo(-1);
    for (const p of [a, b]) {
      expect(p.jawOpen).toBe(0); expect(p.contacting).toBe(true);
      expect(p.x + Math.cos(p.rotation) * (headFront("3d", 0) + p.headOffset)).toBeCloseTo(2);
      expect(p.y + Math.sin(p.rotation) * (headFront("3d", 0) + p.headOffset)).toBeCloseTo(2.5);
    }
    expect(draw(f, 2)).toBeNull(); expect(f).toEqual(original);
  });
  it("opens, closes at contact, withdraws and repeats at 4 Hz, independently of held ticks", () => {
    const f = fightFrame(0), rest = draw(f)!;
    const at = (age: number) => { f.tick = 10 + Math.floor(age / TICK_MS); f.renderMs = 10 * TICK_MS + age; return draw(f)!; };
    expect(rest.headOffset).toBe(0);
    const open = at(BITE_OPEN_MS); expect(open.jawOpen).toBe(1);
    const contact = at(BITE_CONTACT_MS);
    expect(contact.jawOpen).toBe(0); expect(contact.headOffset).toBeGreaterThan(open.headOffset);
    const recovered = (BITE_MS - 1 - BITE_CONTACT_END_MS) / (BITE_MS - BITE_CONTACT_END_MS);
    expect(at(BITE_MS - 1).headOffset).toBeCloseTo(contact.headOffset * (1 - recovered * recovered * (3 - 2 * recovered)), 8);
    expect(at(BITE_MS)).toEqual(rest);
    for (let k = 1; k <= 10; k++) expect(at(k * BITE_MS + BITE_CONTACT_MS)).toEqual(contact);
    f.engagements = []; expect(draw(f)).toBeNull();
  });
  it("handles mixed sizes, same-position real hits, seeks and target loss", () => {
    const f = fightFrame(); f.caste[1] = 1;
    const a = draw(f)!, b = draw(f, 1, 2)!;
    expect(a.y + a.headOffset + headFront("3d", 0)).toBeCloseTo(b.y - b.headOffset - 2 * headFront("3d", 1));
    f.y[1] = 2; expect(draw(f)).not.toBeNull();
    const bites = new Bites(); bites.update(f); const pose = bites.pose(0, 1);
    bites.update(new Frame()); expect(bites.pose(0, 1)).toBeNull(); bites.update(f); expect(bites.pose(0, 1)).toEqual(pose);
    f.id[1] = 18; expect(draw(f)).toBeNull();
  });
  it("applies one rounding unit, not one whole extra tile, and stops on frame separation", () => {
    expect(adjacentWithSlack(31 * 256, 0, 33 * 256, 0)).toBe(true);
    expect(adjacentWithSlack(31 * 256, 0, 33 * 256 + 2, 0)).toBe(false);
    // Every board plays at grid scale 2, so the spectator bite reach is 2 tiles: two raw units past it separates.
    const f = fightFrame(); f.y[1] = 2 + (2 + 1) + 2 / 256; expect(draw(f)).toBeNull();
  });
  it("shows an identifiable dying attack only for the terminal tick", () => {
    const f = fightFrame(); f.count = 1; f.corpses = [{ antId: 17, x: 2, y: 3, colony: 1, heading: 0, ageMs: 30 }];
    f.engagements = [{ a: 81, b: 17, tick: 10, terminalTick: f.tick }, { a: 17, b: 81, tick: 10, terminalTick: f.tick }];
    const b = new Bites(); b.update(f); expect(b.pose(0, 1)).not.toBeNull(); expect(b.corpsePose(17, 1)).not.toBeNull();
    f.tick++; f.renderMs += TICK_MS; f.corpses[0]!.ageMs += TICK_MS; b.update(f);
    expect(b.pose(0, 1)).toBeNull(); expect(b.corpsePose(17, 1)).toBeNull();
  });
});

 describe("actual 2D particles and bounded contact cues", () => {
  it.each([0, 1])("moves caste %s's head independently in the existing ant layer; resumes walk and resets", (caste) => {
    const ants = new Ants(renderer, 20, 10), f = fightFrame(); f.caste[0] = caste; f.agent[0] = 7; f.carrying[0] = 1;
    ants.update(f, 7, [0, 0, 0, 0, 0, 0, 0, 0xabcdef]);
    const body = ants.antLayer.particleChildren[0]! as Particle, head = ants.antLayer.particleChildren[f.count]! as Particle;
    const b = new Bites(); b.update(f); const pose = b.pose(0, caste ? 4 : 2, "2d")!;
    expect(body.x).toBeCloseTo(pose.x); expect(head.y).toBeCloseTo(pose.y + Math.sin(pose.rotation) * pose.headOffset);
    expect(body.texture.orig.width).toBe(caste ? 128 : 64);
    expect(body.texture.trim?.width).toBe(caste ? 84 : 44);
    expect(head.texture.trim?.x).toBe(caste ? 84 : 44);
    expect(head.alpha).toBe(1); expect(head.tint).toBe(0xabcdef); expect(ants.tinted).toEqual([81]);
    f.engagements = []; f.walk[0] = 2; ants.update(f);
    expect(body.texture.orig.width).toBe(caste ? 128 : 64); expect(head.alpha).toBe(0); expect(body.y).toBeCloseTo(pose.y);
    for (let k = 0; k < 2; k++) { f.renderMs += 100; f.tick = Math.floor(f.renderMs / TICK_MS); ants.update(f); }
    expect(body.y).toBe(2);
    ants.setFit(10, 10); ants.update(fightFrame()); expect((ants.antLayer.particleChildren[3]! as Particle).alpha).toBe(1);
    ants.update(new Frame()); expect(ants.antLayer.particleChildren).toHaveLength(0);
  });
  it("uses the ant renderer's contact point for one small normally blended spark per reciprocal pair", () => {
    const ants = new Ants(renderer, 10, 10), battles = new Battles(renderer, 10), f = fightFrame();
    ants.update(f); battles.update(f);
    const p = battles.layer.particleChildren[0]!;
    expect(battles.layer.particleChildren).toHaveLength(1); expect([p.x, p.y]).toEqual([2, 2.5]);
    expect(p.scaleX * 14 * 10).toBeCloseTo(1.5); expect(battles.layer.blendMode).toBe("normal");
    f.renderMs = 10 * TICK_MS + BITE_CONTACT_END_MS; ants.update(f); battles.update(f); expect(battles.layer.particleChildren).toHaveLength(0);
    f.renderMs = 10 * TICK_MS + BITE_MS + BITE_CONTACT_MS; f.tick = Math.floor(f.renderMs / TICK_MS);
    ants.update(f); battles.update(f); expect(battles.layer.particleChildren).toHaveLength(1);
  });
});

 describe("encoded playback and simulation hit fidelity", () => {
  const messages: StreamMessage[] = [], samples: EngagementSample[] = [], truth = new Map<number, Map<number, number>>();
  beforeAll(() => {
    const o = { seed: 6006, config: playable(HISTORICAL_DEFAULT_CONFIG), agents: 10, ticks: 1800, attack: true };
    let state = createMatch(o.seed, o.config); const rec = new SpectatorRecorder(state);
    messages.push(decodeMessage(encodeMessage({ ...rec.initial(), full: rec.initialFull() })));
    while (state.tick < o.ticks && !state.result) {
      const tick = state.tick, inputs = scriptedInputs(state, o), pre = cloneState(state), events: Parameters<typeof applyInput>[4] = [];
      // Reconstruct the real precombat seam using the same exported phases. No
      // modified HP, target selection, sim files or production oracle dependency.
      rebalanceRoles(pre); const grid = buildGrid(pre), food = foodTiles(pre), house = new Map();
      for (const a of pre.ants) if (a.squad === null) house.set(a.id, houseDirection(pre, grid, food, a));
      for (const input of inputs) applyInput(pre, input, tick, defaultAllocator, events);
      lapseSquads(pre, tick, events); fillSquads(pre, defaultAllocator, tick, events);
      const dirs = new Map(); for (const a of pre.agents) for (const [id, d] of squadDirections(pre, grid, food, a, tick).dirs) dirs.set(id, d);
      for (const a of pre.ants) {
        const v = velocity(a.squad !== null ? dirs.get(a.id) ?? ZERO : house.get(a.id) ?? ZERO, speedPerTick(pre.config));
        a.vx = v.x; a.vy = v.y; a.x = Math.max(0, Math.min(pre.config.mapWidth * SUB - 1, a.x + v.x)); a.y = Math.max(0, Math.min(pre.config.mapHeight * SUB - 1, a.y + v.y));
      }
      const actors = pre.ants.slice(), combat: typeof events = []; resolveCombat(pre, buildGrid(pre), tick, combat);
      const out = step(state, inputs);
      expect(combat).toEqual(out.events.filter((e) => e.type === "fight" || e.type === "death"));
      const survivors = new Map(out.state.ants.map((a) => [a.id, a]));
      for (const a of pre.ants) { expect(survivors.get(a.id)?.hp).toBe(a.hp); expect(survivors.get(a.id)?.lastTargetId).toBe(a.lastTargetId); }
      truth.set(out.state.tick, new Map(actors.filter((a) => a.lastTargetId >= 0).map((a) => [a.id, a.lastTargetId])));
      for (const a of out.state.ants) if (a.lastTargetId >= 0) samples.push({ tick: out.state.tick, attacker: a.id, target: a.lastTargetId });
      messages.push(decodeMessage(encodeMessage({ ...rec.record(out), full: null }))); state = out.state;
    }
  }, 120_000);

  it("measures final tracker eligibility: 957 terminal shown, 112 unknown omitted; zero unsupported", () => {
    // The spectator playback tracks at the recording's grid scale (web/src/buffer.ts); every match plays at 2.
    const reach = gridScale(messages[0]!.full!.setup);
    const tracker = new EngagementTracker(); let hits = 0, continuing = 0, terminal = 0, terminalShown = 0, missed = 0, unsupported = 0;
    for (const m of messages) {
      const actual = new Map(tracker.observe(m, reach).map((p) => [p.a, p.b])), real = truth.get(m.tick) ?? new Map<number, number>();
      const dead = new Set(m.events.filter((e) => e.kind === "death").map((e) => e.antId));
      for (const [a, b] of real) {
        hits++; const last = dead.has(a) || dead.has(b);
        if (last) { terminal++; if (actual.get(a) === b) terminalShown++; } else continuing++;
        if (actual.get(a) !== b) missed++;
      }
      for (const [a, b] of actual) if (real.get(a) !== b) unsupported++;
    }
    const counts = { hits, continuing, terminal, terminalShown, terminalMissed: terminal - terminalShown, missed, unsupported };
    console.log("seed-6006 ticks-0-1800 tracker fidelity", counts);
    // Seed 6006 at grid scale 2 under the one current rules generation, tracked at the match reach as the spectator playback does;
    // re-pinned when opening food within the start ants' sight moved to their fine row, and again when the stored config's
    // periodic store payout left the simulation (previously hits 7831, continuing 5039, terminal 2792, shown 2622, missed 170).
    expect(counts).toEqual({ hits: 4804, continuing: 3735, terminal: 1069, terminalShown: 957, terminalMissed: 112, missed: 112, unsupported: 0 });
    expect(missed / hits).toBeLessThanOrEqual(0.05);
    const playback = new Playback(), frame = new Frame(), bites = new Bites();
    let poseMissed = 0, terminalPoses = 0, poseUnsupported = 0;
    playback.push(messages[0]!, 0);
    for (let i = 1; i < messages.length; i++) {
      const m = messages[i]!;
      playback.push(m, m.tick * TICK_MS);
      const next = messages[i + 1]; if (next) playback.push(next, next.tick * TICK_MS);
      playback.sample(m.tick * TICK_MS + RENDER_DELAY_MS + 30, frame); bites.update(frame);
      const rendered = new Map<number, number>();
      const index = new Map(Array.from(frame.id.subarray(0, frame.count), (id, i) => [id, i]));
      for (const p of frame.engagements) {
        const at = index.get(p.a);
        const pose = at === undefined ? bites.corpsePose(p.a, 1) : bites.pose(at, frame.caste[at] === 1 ? 2 : 1);
        if (pose) { rendered.set(p.a, p.b); if (p.terminalTick !== undefined) terminalPoses++; }
      }
      for (const [a, b] of truth.get(m.tick) ?? []) if (rendered.get(a) !== b) poseMissed++;
      for (const [a, b] of rendered) if (truth.get(m.tick)?.get(a) !== b) poseUnsupported++;
    }
    console.log("actual delayed contact poses", { terminalPoses, terminalMissed: terminal - terminalPoses, poseMissed, poseUnsupported, hits });
    expect(terminalPoses).toBe(957); expect(poseUnsupported).toBe(0); expect(poseMissed / hits).toBeLessThanOrEqual(0.05);
    // The grid-scale-2 board samples four times the cells per message: the harness limit, not an assertion, is raised.
  }, 30_000);
  it("repeats on held ticks with stable seek results and no invented target across reconnects/gaps", () => {
    const scene = selectEncounter(messages), pb = new Playback(), frame = new Frame(), bites = new Bites();
    for (const m of messages.filter((m) => m.tick <= scene.tick + 5)) pb.push(m, m.tick * TICK_MS);
    const sample = (age: number) => {
      pb.sample(scene.tick * TICK_MS + RENDER_DELAY_MS + age, frame); bites.update(frame);
      return bites.pose(frame.id.subarray(0, frame.count).indexOf(scene.attacker), 1);
    };
    const phases = visualPhases(scene), contactAge = phases[1]!.age;
    const contact = sample(contactAge)!; expect(contact).not.toBeNull(); expect(contact.jawOpen).toBe(0);
    expect(Math.hypot(contact.headOffset, contact.headSideOffset)).toBeLessThanOrEqual(0.15 + 1e-9);
    // A real confirmed attack can now stop short: it must not invent contact
    // when its resting-head-to-boundary gap exceeds the approved 0.45 tile.
    if (contact.gap > 0.45) expect(contact.contacting).toBe(false);
    expect(sample(phases[0]!.age)?.jawOpen).toBe(1);
    // Both contacts must remain inside the selector's five-tick survival window.
    const otherContact = contactAge >= BITE_MS ? contactAge - BITE_MS : contactAge + BITE_MS;
    expect(sample(otherContact)?.jawOpen).toBe(0); expect(sample(contactAge)).toEqual(contact);
    const tracker = new EngagementTracker(), at = messages.find((m) => m.tick === scene.tick)!, reach = gridScale(messages[0]!.full!.setup);
    expect(tracker.observe(at, reach).some((p) => p.a === scene.attacker)).toBe(true);
    expect(tracker.observe({ ...at, tick: at.tick + 2, events: [] }, reach)).toEqual([]);
    expect(tracker.observe({ ...at, full: messages[0]!.full, events: [] }, reach)).toEqual([]);
    const cadence = biteCadence(samples, messages, new Set([0, ...truth.keys()]));
    expect(cadence.coverageComplete).toBe(true); expect(cadence.explicitDeadAttackerTerminalEligible).toBe(16);
    expect(cadence.missed).toBe(0); expect(cadence.unsupported).toBe(0); expect(cadence.hitsPerSecond).toBe(10); expect(cadence.chompsPerSecond).toBe(4);
    expect(contactSheetFrames).toHaveLength(8); expect(new Set(contactSheetFrames).size).toBe(8);
    expect(contactSheetFrames.some((k) => Math.round(k * 1000 / 30) % BITE_MS >= 125 && Math.round(k * 1000 / 30) % BITE_MS < BITE_CONTACT_END_MS)).toBe(true);
    expect(() => selectEncounter([])).toThrow("no real fight");
    expect(() => selectEncounter(messages.map((m) => ({ ...m, events: [] })))).toThrow("no real fight");
    const withLead = selectEncounter(messages, 1000);
    const clip = clipWindow(withLead.tick, messages[0]!.tick, messages.at(-1)!.tick, 1000)!;
    expect(withLead.tick + 40).toBeLessThanOrEqual(1800);
    expect(expectedPlaybackTick(clip.startClock, 0)).toBe(withLead.tick - 10);
  });
  it("reports missing truth as unmeasured, not unsupported; a measured empty tick remains a real zero", () => {
    const fight = messages.find((m) => m.events.some((e) => e.kind === "fight"))!;
    const zero = biteCadence([], [fight], new Set([fight.tick]));
    expect(zero.coverageComplete).toBe(true); expect(zero.hits).toBe(0); expect(zero.unsupported).toBeGreaterThan(0);
    const unknown = biteCadence([], [fight], new Set());
    expect(unknown.coverageComplete).toBe(false); expect(unknown.unsupported).toBe(0);
    expect(unknown.unmeasuredMessageTicks).toBe(1); expect(unknown.unmeasuredEligibleBites).toBeGreaterThan(0);
    expect(() => biteCadence([{ tick: fight.tick, attacker: 1, target: 2 }], [fight], new Set())).toThrow("unmeasured tick");
  });
});

describe("bounded recording and lead-in clocks", () => {
  it("passes the actual scripted stop tick to replay while preserving legacy whole-match callers", () => {
    const run = playScripted({ seed: 6006, config: playable({ ...DEFAULT_CONFIG, matchTicks: 4 }), agents: 2, ticks: 2, attack: true });
    const receipts: Recorded[] = [];
    try {
      const bounded = recordMatch(`bite-stop-${process.pid}`, run.lines, run.state.tick); receipts.push(bounded);
      const m = unpackMessages(readFileSync(bounded.path)).map(decodeMessage);
      expect(m.map((p) => p.tick)).toEqual([0, 1, 2]); expect(bounded.messages).toBe(3);
      const whole = recordMatch(`bite-whole-${process.pid}`, run.lines); receipts.push(whole);
      expect(unpackMessages(readFileSync(whole.path)).map(decodeMessage).at(-1)!.tick).toBe(4);
      for (const bad of [-1, 1.5, NaN]) expect(() => recordMatch("invalid-stop", run.lines, bad)).toThrow("stopTick");
    } finally {
      for (const r of receipts) { unlinkSync(r.path); unlinkSync(r.log); }
    }
  });
  it("keeps default clips unchanged and preserves pre-fight drift checks for a one-second lead", () => {
    const zero = clipWindow(100, 50, 140)!;
    expect(zero.frameCount).toBe(120); expect(zero.startClock).toBe(zero.eventClock); expect(zero.sheetFrames).toEqual(contactSheetFrames);
    const lead = clipWindow(100, 50, 140, 1000)!;
    expect(lead.eventClock - lead.startClock).toBe(1000); expect(lead.frameCount).toBe(150);
    expect(expectedPlaybackTick(frameClockMs(0, 30, lead.startClock), 50)).toBe(90);
    expect(expectedPlaybackTick(frameClockMs(30, 30, lead.startClock), 50)).toBe(100);
    expect(expectedPlaybackTick(frameClockMs(149, 30, lead.startClock), 50)).toBe(139);
    expect(lead.sheetFrames).toEqual(contactSheetFrames.map((k) => k + 30));
    const fractional = clipWindow(100, 50, 140, 1001)!;
    expect(expectedPlaybackTick(fractional.startClock, 50)).toBe(89);
    expect(frameClockMs(fractional.sheetFrames[0]!, 30, fractional.startClock)).toBeGreaterThanOrEqual(fractional.eventClock);
    expect(clipWindow(100, 90, 140, 1001)).toBeNull(); // unavailable pre-roll
    expect(clipWindow(100, 50, 139)).toBeNull(); // unavailable bracketing state at end
    expect(parseLeadMs()).toBe(0); expect(parseLeadMs("1000")).toBe(1000);
    for (const value of ["-1", "1.5", "NaN", "Infinity", ""]) expect(() => parseLeadMs(value)).toThrow("lead-ms");
  });
});
