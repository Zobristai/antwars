/**
 * Bite cues at a queen fight (stream version 32), on both boards, from the scripted redesign match queen-hp.test.ts
 * reads without its records: the simulation names each queen's biters and the ant she bites; the stream carries them;
 * playback holds them per message (Frame.queenPulse); her disc is held lit and her bar shows the HP lost this second;
 * her biters take the bite pose aimed at her ring; brackets, a name tab and a count stack are placed clear of each other.
 */
import { describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { decodeMessage, encodeMessage, withoutQueenBites, type StreamEvent, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { colonyNamesOf } from "../../src/sim/colonyNames.ts";
import { SOLDIER_HATCH_TIMING, TERRAIN_RULES, damagePerTick, type SimConfig } from "../../src/sim/config.ts";
import type { SimEvent } from "../../src/sim/types.ts";
import { Frame, Playback, RENDER_DELAY_MS, type QueenPulse } from "../../web/src/buffer.ts";
import { Bites } from "../../web/src/bite.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { colonyTint } from "../../web/src/colony-palette.ts";
import { EMBLEM_BAR, QUEEN_CHIP, QUEEN_EMBLEM, QUEEN_LIT, QueenHomes, emblemState, mixColour } from "../../web/src/effects.ts";
import { markerParticles } from "../../web/src/board3d/markers3d.ts";
import { CUE_BRACKETS, bracketBox, cueName, emblemRect, layoutCues, stackSpots } from "../../web/src/queen-bites.ts";
import { overlaps } from "../../web/src/words.ts";
import { boardQueenHp } from "../../web/src/variant.ts";
import { playRedesign } from "./redesign-recording.ts";

vi.setConfig({ testTimeout: 60_000 });

type SimBites = Extract<SimEvent, { type: "queen_bites" }>;
const simBites = new Map<number, SimBites[]>();
const checks = { drops: 0, targets: 0, sighted: 0 };
let config: SimConfig | undefined;
const queenHp = new Map<string, number>();
const messages = playRedesign({ seed: 6065, agents: 9, ticks: 4000,
  sceneSettings: { terrain: TERRAIN_RULES, hatchTiming: SOLDIER_HATCH_TIMING },
  observe: (out, before) => {
    config ??= out.state.config;
    const c = out.state.config, worker = damagePerTick(c);
    const soldier = c.castes === undefined ? worker : Math.trunc((worker * c.castes.soldierDamagePermille) / 1000);
    const flyer = c.flyers === undefined ? worker : Math.trunc(c.flyers.damagePerSecond / c.ticksPerSecond);
    const hit = (id: number) => { const a = before.get(id)!; return a.flyer ? flyer : a.soldier ? soldier : worker; };
    const bites = out.events.filter((e): e is SimBites => e.type === "queen_bites");
    if (bites.length > 0) simBites.set(out.state.tick, bites);
    const dead = new Set(out.events.flatMap((e) => (e.type === "death" ? [e.antId] : [])));
    for (const e of out.events) {
      // Every HP drop is exactly the bites of the ants it names (no regeneration while an enemy is near).
      if (e.type === "queen_hp") {
        const key = `${e.colony}:${e.queenId}`, was = queenHp.get(key) ?? c.queenHp!.hp;
        queenHp.set(key, e.hp);
        if (e.hp >= was) continue;
        const record = bites.find((b) => b.colony === e.colony && b.queenId === e.queenId)!;
        expect(record.biters.length).toBeGreaterThan(0);
        expect(was - e.hp).toBe(Math.min(was, record.biters.reduce((sum, id) => sum + hit(id), 0)));
        checks.drops++;
      }
    }
    for (const b of bites) {
      expect([...b.biters]).toEqual([...b.biters].sort((x, y) => x - y));
      expect(new Set(b.biters).size).toBe(b.biters.length);
      expect(b.biters.length > 0 || b.targetId !== null).toBe(true);
      // The ant she bites lost at least her bite this tick, or died.
      if (b.targetId !== null) {
        const after = out.state.ants.find((a) => a.id === b.targetId);
        const perTick = "damagePerSecond" in c.queenHp! ? Math.trunc(c.queenHp!.damagePerSecond / c.ticksPerSecond) : c.queenHp!.biteDamage;
        expect(dead.has(b.targetId) || before.get(b.targetId)!.hp - after!.hp >= perTick).toBe(true);
        checks.targets++;
      }
    }
    // Never shown to agents.
    for (const a of out.state.agents) if (a.pendingEvents.some((e) => (e as { type: string }).type === "queen_bites")) checks.sighted++;
  } });
const recorded = new Map(messages.filter((m) => m.full === null).map((m) => [m.tick, m.events.filter((e): e is Extract<StreamEvent, { kind: "queenBites" }> => e.kind === "queenBites")]));
const biteTicks = [...simBites.keys()];

function frameAt(targetMs: number, source: readonly StreamMessage[] = messages): Frame {
  const p = new Playback();
  for (const m of source) p.push(m, m.tick * TICK_MS);
  const f = new Frame();
  expect(p.sample(targetMs + RENDER_DELAY_MS, f)).toBe(true);
  return f;
}

describe("the simulation's queen bites", () => {
  it("name each queen's biters and the ant she bites, matching her HP and the ant's, and are never shown to agents", () => {
    expect(biteTicks.length).toBeGreaterThan(5);
    expect(checks.drops).toBeGreaterThan(5);
    expect(checks.targets).toBeGreaterThan(5);
    expect(checks.sighted).toBe(0);
  });

  it("reach the stream unchanged, in the message of the tick they happened on", () => {
    for (const [tick, bites] of simBites) {
      expect(recorded.get(tick)).toEqual(bites.map((b) => ({ kind: "queenBites", colony: b.colony, queenId: b.queenId, biters: [...b.biters], targetId: b.targetId })));
      expect(encodeMessage(messages.find((m) => m.tick === tick)!)[2]).toBe(32);
    }
    for (const [tick, bites] of recorded) if (!simBites.has(tick)) expect(bites).toEqual([]);
  });
});

describe("queen bite cues in playback", () => {
  const tick = biteTicks.find((t) => simBites.get(t)!.some((b) => b.biters.length > 1 && b.targetId !== null))!;
  const record = simBites.get(tick)!.find((b) => b.biters.length > 1 && b.targetId !== null)!;
  const f = frameAt(tick * TICK_MS + 40);

  it("hold each message's biters alive in it and the ant she bites, with its colony", () => {
    expect(f.tick).toBe(tick);
    const pulse = f.queenPulse.find((p) => p.colony === record.colony && p.queenId === record.queenId)!;
    const alive = new Set(Array.from(f.id.subarray(0, f.count)));
    expect(pulse.biters).toEqual(record.biters.filter((id) => alive.has(id)));
    const counts = Array.from({ length: f.board!.setup.queens.length }, () => 0);
    for (const id of pulse.biters) counts[f.colony[Array.from(f.id.subarray(0, f.count)).indexOf(id)]!]++;
    expect(pulse.counts).toEqual(counts);
    expect(pulse.target?.id).toBe(record.targetId);
    expect(pulse.target?.colony).not.toBe(record.colony);
    // Each record lasts its message: the next message's frame holds the next record.
    const next = frameAt((tick + 1) * TICK_MS + 40);
    const later = simBites.get(tick + 1)?.find((b) => b.colony === record.colony && b.queenId === record.queenId);
    expect(next.queenPulse.find((p) => p.colony === record.colony && p.queenId === record.queenId)?.target?.id ?? null).toBe(later?.targetId ?? null);
  });

  it("hold her disc lit instead of flashing, and chip her bar by the HP lost since the last whole second, on both boards", () => {
    const queen = f.board!.queens!.find((q) => q.colony === record.colony && q.id === record.queenId)!;
    const state = emblemState(queen, f)!;
    expect(state.lit).toBe(true);
    expect(state.flash).toBe(0);
    const pulse = f.queenPulse.find((p) => p.colony === record.colony && p.queenId === record.queenId)!;
    expect(state.chip).toBeCloseTo(Math.min(1 - state.bar!, pulse.chip / boardQueenHp(f.board!)!.hp), 9);
    // 2D: the disc at the lit level, no white ring, the bar in her colour and the chip after it.
    const homes = new QueenHomes(10);
    homes.update(f);
    type Ins = { action: string; data: { style: { color: number; alpha: number }; path?: { shapePath: { shapePrimitives: { shape: { type: string; x?: number; y?: number; width?: number } }[] } } } };
    const shapes = (homes.emblems.context.instructions as unknown as Ins[]).flatMap((i) => (i.data.path?.shapePath.shapePrimitives ?? []).map((p) => ({ action: i.action, ...p.shape, color: i.data.style.color })));
    const qx = queen.x / 256, qy = queen.y / 256, colour = colonyTint(queen.colony);
    const disc = shapes.find((s) => s.type === "circle" && s.action === "fill" && Math.abs(s.x! - qx) < 1e-6 && Math.abs(s.y! - qy) < 1e-6)!;
    expect(disc.color).toBe(mixColour(0x0b0907, colour, QUEEN_LIT));
    expect(shapes.some((s) => s.type === "circle" && s.color === 0xffffff)).toBe(false);
    const bars = shapes.filter((s) => s.type === "rectangle" && Math.abs(s.y! - (qy + (QUEEN_EMBLEM.r + EMBLEM_BAR.gap) / 10)) < 1e-6);
    expect(bars[1]!.color).toBe(colour);
    if (state.chip > 0) expect(bars[2]).toMatchObject({ color: mixColour(colour, 0xffffff, QUEEN_CHIP) });
    // 3D: her lit emblem drawing, untinted, and no white ring.
    const particles = markerParticles(f, (x, y) => [x * 10, y * 10]).particles;
    expect(particles.find((p) => p.kind === `lit${queen.colony}`)).toMatchObject({ tint: 0xffffff });
    expect(particles.some((p) => p.kind === "ring" && p.tint === 0xffffff)).toBe(false);
  });

  it("cut the chip to nothing at each whole match second", () => {
    const tps = f.board!.setup.ticksPerSecond;
    const boundary = biteTicks.find((t) => t % tps === 0 && simBites.has(t - 1))!;
    const at = frameAt(boundary * TICK_MS + 40);
    const before = frameAt((boundary - 1) * TICK_MS + 40);
    const chip = (frame: Frame) => frame.queenPulse.map((p) => p.chip);
    expect(chip(before).some((c) => c > 0)).toBe(true);
    expect(chip(at).every((c) => c === 0)).toBe(true);
  });

  it("start the chip again from the first message after a gap, never counting HP lost in the missing message", () => {
    const tps = f.board!.setup.ticksPerSecond;
    const hpAt = (m: StreamMessage, colony: number, id: number) => m.events.find((e): e is Extract<StreamEvent, { kind: "queenHp" }> => e.kind === "queenHp" && e.colony === colony && e.queenId === id)?.hp;
    // A bitten tick whose next two ticks are in its second and also drop her HP.
    const gap = biteTicks.find((t) => t % tps !== 0 && (t + 2) % tps > (t % tps) && simBites.get(t)!.some((b) => b.biters.length > 0 &&
      [t, t + 1, t + 2].every((u) => hpAt(messages.find((m) => m.tick === u)!, b.colony, b.queenId) !== undefined)))!;
    const b = simBites.get(gap)!.find((r) => r.biters.length > 0)!;
    const without = messages.filter((m) => m.tick !== gap);
    const pulse = (at: number) => frameAt(at * TICK_MS + 40, without).queenPulse.find((p) => p.colony === b.colony && p.queenId === b.queenId)!;
    expect(pulse(gap + 1).chip).toBe(0);
    const before = hpAt(messages.find((m) => m.tick === gap + 1)!, b.colony, b.queenId)!, after = hpAt(messages.find((m) => m.tick === gap + 2)!, b.colony, b.queenId)!;
    expect(pulse(gap + 2).chip).toBe(before - after);
    // Received without the gap, the same message's chip counts every drop since the second's first message.
    expect(frameAt((gap + 1) * TICK_MS + 40).queenPulse.find((p) => p.colony === b.colony && p.queenId === b.queenId)!.chip).toBeGreaterThan(0);
  });

  it("leave a recording without the records as it plays today", () => {
    const old = frameAt(tick * TICK_MS + 40, messages.map(withoutQueenBites));
    expect(old.queenPulse).toEqual([]);
    expect(old.hits.length).toBeGreaterThan(0);
    expect(old.hits.every((h) => h.pulse === undefined)).toBe(true);
    const queen = old.board!.queens!.find((q) => q.colony === record.colony && q.id === record.queenId)!;
    expect(emblemState(queen, old)).toMatchObject({ lit: false, chip: 0 });
    expect(emblemState(queen, old)!.flash).toBeGreaterThan(0.8);
  });

  it("show a joiner the bites under way from its first message, its chip only from what it has seen", () => {
    // A tick whose bitten ant survives it: a joiner gets no death event, so it sees no corpse of one that did not.
    const join = biteTicks.find((t) => simBites.get(t)!.some((b) => b.biters.length > 0 && b.targetId !== null &&
      messages.find((m) => m.tick === t)!.ants.id.includes(b.targetId)))!;
    const joinRecord = simBites.get(join)!.find((b) => b.biters.length > 0 && b.targetId !== null)!;
    const decoded = messages.map((m) => decodeMessage(encodeMessage(m)));
    const model = new SpectatorState(decoded[0]!.full!, decoded[0]!.tick, decoded[0]!.ants);
    for (const m of decoded.slice(1)) { if (m.tick > join) break; model.apply(m); }
    const joined = decodeMessage(encodeMessage(model.message()));
    expect(joined.events.filter((e) => e.kind === "queenBites")).toEqual(recorded.get(join));
    const p = new Playback(), g = new Frame();
    p.push(joined, join * TICK_MS);
    p.sample(join * TICK_MS + RENDER_DELAY_MS, g);
    const pulse = g.queenPulse.find((q) => q.colony === joinRecord.colony && q.queenId === joinRecord.queenId)!;
    expect(pulse.target?.id).toBe(joinRecord.targetId);
    expect(pulse.biters.length).toBeGreaterThan(0);
    expect(pulse.chip).toBe(0);
  });
});

describe("the ants biting her", () => {
  const tick = biteTicks.find((t) => simBites.get(t)!.some((b) => b.biters.length > 0))!;
  const f = frameAt(tick * TICK_MS + 40);
  const pulse = f.queenPulse.find((p) => p.biters.length > 0)!;
  const index = (id: number) => Array.from(f.id.subarray(0, f.count)).indexOf(id);
  // Her ring as drawn at a zoom where the nearest biter's head reaches it: a biter farther than its lean and head can
  // reach keeps the pose without a contact, as an ant biting another ant does.
  const nearest = Math.min(...pulse.biters.map((id) => Math.hypot(f.x[index(id)]! - pulse.x, f.y[index(id)]! - pulse.y)));
  const ring = nearest - 0.25;

  it("take the bite pose aimed at her ring, the contact on it and drawn apart from ant-on-ant contacts", () => {
    const bites = new Bites();
    bites.queenRing = () => ring;
    bites.update(f, true);
    for (const id of pulse.biters) {
      const pose = bites.pose(index(id), 0.5, "2d")!;
      expect(pose).not.toBeNull();
      expect(Math.hypot(pose.contact.x - pulse.x, pose.contact.y - pulse.y)).toBeCloseTo(ring, 9);
      // Under reduced motion: held at contact, jaws closed.
      expect(pose.jawOpen).toBe(0);
    }
    const contacts = bites.queenContacts(0.5, "2d");
    expect(contacts.length).toBeGreaterThan(0);
    // Out of reach of a narrower ring: the pose stays, with no contact.
    const far = new Bites();
    far.queenRing = () => 0.1;
    far.update(f, true);
    for (const id of pulse.biters) if (Math.hypot(f.x[index(id)]! - pulse.x, f.y[index(id)]! - pulse.y) > 0.1 + 0.18 + 0.45 + 0.05) {
      expect(far.pose(index(id), 0.5, "2d")).not.toBeNull();
      expect(far.queenContacts(0.5, "2d")).not.toContainEqual(far.pose(index(id), 0.5, "2d")!.contact);
    }
    for (const c of contacts) expect(Math.hypot(c.x - pulse.x, c.y - pulse.y)).toBeCloseTo(ring, 9);
    const antContacts = bites.contacts(0.5, "2d");
    for (const c of antContacts) expect(contacts).not.toContainEqual(c);
  });

  it("draw the same turned, leaning body on the 3D board as the 2D pose, aimed at her ring", () => {
    // Ants3D draws each ant from the shared pose (bite.ts): heading, leaned body point and head offset.
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const L = 0.5, ground = new Ground(scene, f.board!.setup.mapW, f.board!.setup.mapH);
      const ants3d = new Ants3D(scene, ground, L, COLONY_RGB);
      ants3d.queenRing = () => ring;
      const bites = new Bites();
      bites.queenRing = () => ring;
      ants3d.update(f);
      bites.update(f);
      let checked = 0;
      for (const id of pulse.biters) {
        const i = index(id), soldier = f.caste[i] === 1, size = L * (soldier ? 2 : 1);
        const pose = bites.pose(i, size)!, body = bites.bodyPosition(i, size)!;
        const mesh = scene.getMeshByName(`${soldier ? "soldiers" : "ants"}${f.colony[i]}`) as Mesh;
        const m = mesh._thinInstanceDataStorage.matrixData!;
        let found = false;
        for (let o = 0; o < mesh.thinInstanceCount * 16; o += 16) {
          if (Math.abs(m[o + 12]! - body.x) > 1e-4 || Math.abs(m[o + 14]! - (ground.mapH - body.y)) > 1e-4) continue;
          const heading = -Math.atan2(m[o + 2]!, m[o]!);
          expect(Math.abs(((heading - pose.rotation + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)).toBeLessThan(1e-4);
          found = true;
        }
        expect(found).toBe(true);
        // Leaned toward her: its body is no farther from her than where it stands.
        expect(Math.hypot(body.x - pulse.x, body.y - pulse.y)).toBeLessThanOrEqual(Math.hypot(f.x[i]! - pulse.x, f.y[i]! - pulse.y) + 1e-9);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("face her once their bodies have turned", () => {
    const later = frameAt(tick * TICK_MS + 99);
    for (const id of pulse.biters) {
      const i = Array.from(later.id.subarray(0, later.count)).indexOf(id);
      if (i < 0 || later.drawRotation === null) continue;
      const bearing = Math.atan2(pulse.y - later.y[i]!, pulse.x - later.x[i]!);
      const off = Math.abs(((later.drawRotation[i]! - bearing + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      // The body turns at the shared capped rate; it has turned toward her, never away.
      const first = Math.abs(((f.drawRotation![index(id)]! - bearing + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(off).toBeLessThanOrEqual(first + 1e-9);
    }
  });
});

describe("the cues' layout", () => {
  const names = colonyNamesOf(messages[0]!.full!.setup).map(cueName);
  const tick = biteTicks.find((t) => simBites.get(t)!.some((b) => b.biters.length > 0 && b.targetId !== null))!;
  const f = frameAt(tick * TICK_MS + 40);
  const scale = 24;
  const board = { toScreen: (x: number, y: number): [number, number] => [x * scale, y * scale], bodyPx: (_x: number, _y: number, soldier: boolean) => (soldier ? 28 : 14) };
  const screen = { w: 4000, h: 4000 };

  it("names the biters' colonies and the bitten ant's, sized by its body, clear of the emblems and of each other", () => {
    const placed = layoutCues(f, board, screen, []);
    const pulse = f.queenPulse.find((p) => p.biters.length > 0 && p.target !== null)!;
    const stack = placed.stacks.find((s) => s.queen === pulse)!;
    expect(stack.rows.map((r) => r.text)).toEqual(pulse.counts.flatMap((n, c) => (n > 0 ? [`${n} ${names[c]}`] : [])));
    const tab = placed.tabs[0]!;
    expect(tab.text).toBe(names[pulse.target!.colony]);
    const bracket = placed.brackets.find((b) => b.queen === pulse)!;
    expect(bracket.side).toBe(bracketBox(pulse.target!.soldier ? 28 : 14));
    expect(bracket.side).toBeGreaterThanOrEqual(CUE_BRACKETS.min);
    const [qx, qy] = board.toScreen(pulse.x, pulse.y);
    expect(overlaps(stack.rect, emblemRect(qx, qy))).toBe(false);
    for (const r of placed.reserved) for (const o of placed.reserved) if (r !== o) expect(overlaps(r, o)).toBe(false);
    expect(placed.reserved).toHaveLength(placed.stacks.length + placed.tabs.length);
  });

  it("moves a stack to its next spot when a panel covers the first, and never drops it", () => {
    const pulse = f.queenPulse.find((p) => p.biters.length > 0)!;
    const [qx, qy] = board.toScreen(pulse.x, pulse.y);
    const first = layoutCues(f, board, screen, []).stacks.find((s) => s.queen.colony === pulse.colony && s.queen.queenId === pulse.queenId)!;
    const spots = stackSpots(qx, qy, first.rect.x1 - first.rect.x0, first.rect.y1 - first.rect.y0);
    expect(first.rect).toEqual(spots[0]);
    const moved = layoutCues(f, board, screen, [spots[0]!]).stacks.find((s) => s.queen.colony === pulse.colony && s.queen.queenId === pulse.queenId)!;
    expect(moved.rect).toEqual(spots[1]);
    const everywhere = layoutCues(f, board, screen, [{ x0: 0, y0: 0, x1: screen.w, y1: screen.h }]).stacks;
    expect(everywhere.length).toBe(layoutCues(f, board, screen, []).stacks.length);
  });

  it("keeps every cue of a queen on screen whole at a 320 px window's edge under a HUD panel, never cut", () => {
    const pulse = f.queenPulse.find((p) => p.biters.length > 0 && p.target !== null)!;
    const small = { w: 320, h: 844 }, hud = { x0: 0, y0: 0, x1: 320, y1: 300 };
    // Her emblem at the board's top-right corner, one pixel under the HUD: no spot of hers is both clear and whole.
    const edge = { ...board, toScreen: (x: number, y: number): [number, number] => [318 + (x - pulse.x) * scale, 301 + (y - pulse.y) * scale] };
    const placed = layoutCues(f, edge, small, [hud]);
    const whole = (r: { x0: number; y0: number; x1: number; y1: number }) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= small.w && r.y1 <= small.h && !overlaps(r, hud);
    const stack = placed.stacks.find((s) => s.queen === pulse)!;
    expect(whole(stack.rect)).toBe(true);
    const [tx, ty] = edge.toScreen(...((): [number, number] => { const i = Array.from(f.id.subarray(0, f.count)).indexOf(pulse.target!.id); return [f.drawX?.[i] ?? f.x[i]!, f.drawY?.[i] ?? f.y[i]!]; })());
    if (tx >= 0 && ty >= 0 && tx <= small.w && ty <= small.h) for (const t of placed.tabs) expect(whole(t.rect)).toBe(true);
  });

  it("places a tab clear of the count stack when both fall back at that edge, neither cut nor covered", () => {
    // Her emblem at (318, 301) one pixel under a HUD panel ending at y = 300, the ant she bites at (310, 310), two biters.
    const queen = { id: 0, colony: 0, x: 318 * 256, y: 301 * 256, foundedTick: 0, lostTick: null, overrun: 0, hp: 50_000 };
    const pulse: QueenPulse = { colony: 0, queenId: 0, x: 318, y: 301, biters: [1, 2], counts: [0, 2], target: { id: 9, colony: 1, soldier: false, dead: false }, chip: 0 };
    const frame = { board: { ...f.board!, queens: [queen] }, queenPulse: [pulse], count: 1, id: Uint32Array.of(9), x: Float32Array.of(310), y: Float32Array.of(310),
      drawX: null, drawY: null, corpses: [] } as unknown as Frame;
    const identity = { toScreen: (x: number, y: number): [number, number] => [x, y], bodyPx: () => 14 };
    const small = { w: 320, h: 844 }, hud = { x0: 0, y0: 0, x1: 320, y1: 300 };
    const placed = layoutCues(frame, identity, small, [hud]);
    expect(placed.stacks).toHaveLength(1);
    expect(placed.tabs).toHaveLength(1);
    const stack = placed.stacks[0]!.rect, tab = placed.tabs[0]!.rect;
    for (const r of [stack, tab]) {
      expect(r.x0 >= 0 && r.y0 >= 0 && r.x1 <= small.w && r.y1 <= small.h).toBe(true);
      expect(overlaps(r, hud)).toBe(false);
      expect(overlaps(r, emblemRect(318, 301))).toBe(false);
    }
    expect(overlaps(stack, tab)).toBe(false);
    expect(placed.stacks[0]!.rows[0]!.text).toBe(`2 ${names[1]}`);
  });

  it("draws nothing for a frame without records", () => {
    const empty: Pick<Frame, "queenPulse"> = { queenPulse: [] as QueenPulse[] };
    expect(layoutCues({ ...f, ...empty }, board, screen, [])).toEqual({ stacks: [], tabs: [], brackets: [], reserved: [] });
  });
});
