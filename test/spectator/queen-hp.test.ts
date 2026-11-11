/**
 * A queen under attack and a colony's fall, on both boards. Bites read from the
 * stream's HP drops flash her emblem and HP bar; a lost queen's home collapses and is gone; the
 * timeline carries the attack from the first bite to the fall; the result card follows the fall by
 * a beat. All of it on the playback clock, from a scripted redesign match (redesign-recording.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { Graphics } from "pixi.js";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { decodeMessage, encodePublicMessage, streamQueens, type StreamEvent, type StreamQueen } from "../../src/live/format.ts";
import { COLONY_NAMES, QUEEN_HP_RULES, SOLDIER_HATCH_TIMING, TERRAIN_RULES } from "../../src/sim/config.ts";
import { ATTACK_LULL_S, FALL_FRAME_PAD, Frame, HIT_FLASH_MS, Playback, QUEEN_COLLAPSE_MS, QUEEN_FRAME_TILES, RENDER_DELAY_MS, RESULT_BEAT_MS, fallWindow, fallenColonies, fallenNests, fallenQueen, fallenQueenBox, queenLossAge, resultShownAt } from "../../web/src/buffer.ts";
import { COLONY_TINT } from "../../web/src/ants.ts";
import { EMBLEM_BAR, LOST_EMBLEM, QUEEN_EMBLEM, QueenHomes, emblemState } from "../../web/src/effects.ts";
import { markerParticles } from "../../web/src/board3d/markers3d.ts";
import { hpText, storyText } from "../../web/src/overlays.ts";
import { OPEN_COPY, decisive, significant, underWay } from "../../web/src/story.ts";
import { boardCountMarks } from "../../web/src/variant.ts";
import { markByline, markReading } from "../../web/src/words.ts";
import { playRedesign } from "./redesign-recording.ts";

vi.setConfig({ testTimeout: 60_000 });

// A queen-hit/fall scene with pursuit DEFEND, on rules 27: seed 6024 has two attacks on the lost queen, the last fatal
// (seed 6016, three attacks, no longer reaches a fall since opening food moved to the start ants' fine row).
const messages = playRedesign({ seed: 6024, agents: 9, ticks: 4000,
  sceneSettings: { terrain: TERRAIN_RULES, hatchTiming: SOLDIER_HATCH_TIMING } });
const lostAt = messages.find((m) => m.events.some((e) => e.kind === "queenLost"))!;
const lost = (lostAt.events.find((e) => e.kind === "queenLost") as Extract<StreamEvent, { queen: StreamQueen }>).queen;
const endAt = messages.find((m) => m.events.some((e) => e.kind === "end"))!;
/** Each bite: the message tick and the HP it left, for the lost queen. */
const bites = messages.flatMap((m) => m.events.flatMap((e) => (e.kind === "queenHp" && e.colony === lost.colony && e.queenId === lost.id ? [{ tick: m.tick, hp: e.hp }] : [])));

/** Playback of the whole recording, sampled at a playback target (ms of match time). */
function frameAt(targetMs: number): Frame {
  const p = new Playback();
  for (const m of messages) p.push(m, m.tick * TICK_MS);
  const f = new Frame();
  expect(p.sample(targetMs + RENDER_DELAY_MS, f)).toBe(true);
  return f;
}

type Shape = { type: string; x?: number; y?: number; radius?: number; width?: number; height?: number };
type Ins = { action: string; data: { style: { color: number; alpha: number }; path?: { shapePath: { shapePrimitives: { shape: Shape }[] } } } };
/** What the 2D homes drew: each shape with its instruction's colour and alpha. */
const drawn2d = (homes: QueenHomes) => [homes.layer, homes.emblems].flatMap((layer) => (layer.context.instructions as unknown as Ins[]).flatMap((i) => (i.data.path?.shapePath.shapePrimitives ?? []).map((p) => ({ action: i.action, ...p.shape, color: i.data.style.color, alpha: i.data.style.alpha }))));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("the scripted redesign match", () => {
  it("reaches bites on a queen, her fall and the queens-killed result, with count marks laid that carry verb, count and claimed", () => {
    expect(messages[0]!.full!.setup.rules).toBe("redesign");
    expect(bites.length).toBeGreaterThan(5);
    expect(lost.lostTick).toBe(lostAt.tick - 1);
    expect(endAt.tick).toBe(lostAt.tick);
    const counted = messages.flatMap((m) => m.events.flatMap((e) => (e.kind === "mark" && e.mark.words.length === 0 ? [e.mark] : [])));
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.every((m) => m.verb !== undefined && m.count !== undefined && m.claimed !== undefined)).toBe(true);
    expect(counted.some((m) => m.claimed! > 0)).toBe(true);
    // The log line and tooltip read them in the set feed form: "DEFEND · 12 requested · 7 answered", "by Diamond, 3s ago".
    const f = frameAt(bites[0]!.tick * TICK_MS);
    const live = f.marks.find((v) => v.mark.verb !== undefined)!.mark;
    expect(f.chat.some((l) => l.kind === "mark" && l.markId === live.id)).toBe(true);
    expect(markReading(live)).toMatch(/^(DEFEND|FORAGE|ATTACK|GATHER) · \d+ requested · \d+ answered$/);
    expect(markReading(live)).toBe(`${live.verb} · ${live.count} requested · ${live.claimed} answered`);
    expect(boardCountMarks(f.board!)).toBeDefined();
    expect(markByline(live, f.tick, 10)).toMatch(/^by \w+( \d+)?, (\d+m )?\d+s ago$/);
  });
});

it("keeps HP emblems and ends an attack on full regeneration in a redacted public replay", () => {
  const first = decodeMessage(encodePublicMessage(messages[0]!));
  expect(first.full!.setup).not.toHaveProperty("rules");
  const q = first.full!.queens![0]!;
  const p = new Playback(), f = new Frame();
  p.push(first, 0);
  p.push({ tick: 1, ants: first.ants, full: null, events: [{ kind: "queenHp", colony: q.colony, queenId: q.id, hp: 20_000 }] }, 100);
  p.sample(100 + RENDER_DELAY_MS, f);
  expect(emblemState(f.board!.queens![0]!, f)!.bar).toBe(0.5);
  p.push({ tick: 2, ants: first.ants, full: null, events: [{ kind: "queenHp", colony: q.colony, queenId: q.id, hp: QUEEN_HP_RULES.hp }] }, 200);
  p.sample(200 + RENDER_DELAY_MS, f);
  expect(emblemState(f.board!.queens![0]!, f)!.bar).toBe(1);
  expect(f.story.find((entry) => entry.kind === "queen_attack")).toMatchObject({ endTick: 2, outcome: "repelled" });
});

describe("bites on a queen (the hit flash)", () => {
  // Regression caught: a flash from regeneration, or from a full snapshot restating HP; a flash lasting past HIT_FLASH_MS.
  it("appear in the frame as the delayed playback reaches each HP drop, at the queen's tile, and fade out over HIT_FLASH_MS", () => {
    const first = bites[0]!;
    const before = frameAt(first.tick * TICK_MS - 1);
    expect(before.hits).toEqual([]);
    const at = frameAt(first.tick * TICK_MS + 50);
    expect(at.hits).toHaveLength(1);
    expect(at.hits[0]).toMatchObject({ colony: lost.colony, queenId: lost.id, x: lost.x / 256, y: lost.y / 256, ageMs: 50 });
    const gone = frameAt(first.tick * TICK_MS + HIT_FLASH_MS);
    expect(gone.hits.some((h) => h.ageMs >= HIT_FLASH_MS)).toBe(false);
    // A full snapshot restating a lower HP is no bite; regeneration raises HP and is none either; a drop after it is.
    const p = new Playback();
    const f = new Frame();
    const first0 = messages[0]!;
    const q = first0.full!.queens![0]!;
    const hp = (tick: number, hp: number) => ({ tick, ants: first0.ants, full: null, events: [{ kind: "queenHp" as const, colony: q.colony, queenId: q.id, hp }] });
    p.push({ ...first0, full: { ...first0.full!, queens: first0.full!.queens!.map((x) => ({ ...x, hp: 20_000 })) } }, 0);
    p.push(hp(1, 21_000), 100);
    p.push(hp(2, 18_000), 200);
    p.push({ tick: 20, ants: first0.ants, full: null, events: [] }, 2000);
    p.sample(RENDER_DELAY_MS + 50, f);
    expect(f.hits).toEqual([]);
    p.sample(RENDER_DELAY_MS + 150, f);
    expect(f.hits).toEqual([]);
    p.sample(RENDER_DELAY_MS + 250, f);
    expect(f.hits).toEqual([{ colony: q.colony, queenId: q.id, x: q.x / 256, y: q.y / 256, ageMs: 50 }]);
    // One bite's flash: full as it lands, gone after HIT_FLASH_MS.
    expect(emblemState(f.board!.queens![0]!, f)!.flash).toBeCloseTo(1 - 50 / HIT_FLASH_MS, 6);
    p.sample(RENDER_DELAY_MS + 200 + HIT_FLASH_MS, f);
    expect(emblemState(f.board!.queens![0]!, f)!.flash).toBe(0);
  });

  it("flash the emblem and its HP bar white on both boards, the bar filled to HP over the configured maximum", () => {
    const bite = bites.find((b) => b.hp > 0 && b.hp < QUEEN_HP_RULES.hp / 2)!;
    const f = frameAt(bite.tick * TICK_MS + 100);
    const queen = f.board!.queens!.find((q) => q.colony === lost.colony && q.id === lost.id)!;
    const state = emblemState(queen, f)!;
    expect(state).toMatchObject({ scale: 1, alpha: 1, bar: queen.hp! / QUEEN_HP_RULES.hp });
    // Bitten every tick, she stays lit: the flash is the newest bite's.
    expect(state.flash).toBeCloseTo(Math.max(...f.hits.filter((h) => h.colony === queen.colony).map((h) => 1 - h.ageMs / HIT_FLASH_MS)), 6);
    expect(state.flash).toBeGreaterThan(0.8);
    // 2D: the bar's track and fill, the fill lit toward white; a white ring spreading from the disc.
    const homes = new QueenHomes(10);
    homes.update(f);
    const qx = queen.x / 256, qy = queen.y / 256;
    const bars = drawn2d(homes).filter((s) => s.type === "rectangle" && near(s.x!, qx - EMBLEM_BAR.w / 2 / 10) && near(s.y!, qy + (QUEEN_EMBLEM.r + EMBLEM_BAR.gap) / 10));
    expect(bars).toHaveLength(2);
    expect(bars[1]!.width! / bars[0]!.width!).toBeCloseTo(state.bar!, 6);
    expect(bars[1]!.color).not.toBe(COLONY_TINT[lost.colony]);
    expect(bars[1]!.color).toBeGreaterThan(COLONY_TINT[lost.colony]);
    const ring = drawn2d(homes).find((s) => s.type === "circle" && near(s.x!, qx) && near(s.y!, qy) && s.color === 0xffffff);
    expect(ring).toBeDefined();
    expect(ring!.alpha).toBeCloseTo(0.9 * state.flash, 6);
    // 3D: the same fill as a line's length, the same white ring.
    const out = markerParticles(f, (x, y) => [x * 10, y * 10]).particles;
    // Her bar's lines: the track centred on her, and the fill ending at the track's right edge.
    const lines = out.filter((p) => p.kind === "line" && near(p.y, qy * 10 + QUEEN_EMBLEM.r + EMBLEM_BAR.gap + 1) && Math.abs(p.x - qx * 10) <= EMBLEM_BAR.w / 2);
    expect(lines).toHaveLength(2);
    expect((lines[1]!.scaleX * 112) / EMBLEM_BAR.w).toBeCloseTo(state.bar!, 6);
    const flash = out.find((p) => p.kind === "ring" && p.tint === 0xffffff && near(p.x, qx * 10) && near(p.y, qy * 10));
    expect(flash).toMatchObject({ tint: 0xffffff });
    expect(flash!.alpha).toBeCloseTo(0.9 * state.flash, 6);
    // Under reduced motion the spreading ring is left out on both boards; the disc stays lit.
    const still = new QueenHomes(10);
    still.update(f, true);
    expect(drawn2d(still).find((s) => s.type === "circle" && near(s.x!, qx) && near(s.y!, qy) && s.color === 0xffffff)).toBeUndefined();
    // A coloured timeline marker may share her position; reduced motion removes only the white hit ring.
    const stillParticles = markerParticles(f, (x, y) => [x * 10, y * 10], true).particles;
    expect(stillParticles.find((p) => p.kind === "ring" && p.tint === 0xffffff && near(p.x, qx * 10) && near(p.y, qy * 10))).toBeUndefined();
    // At tile size 2 her queen-attack story marker has expired by this half-HP bite, so the coloured-marker check runs
    // at her first bite, where the marker and the white hit ring share her position.
    const first = frameAt(bites[0]!.tick * TICK_MS + 100);
    const firstQueen = first.board!.queens!.find((q) => q.colony === lost.colony && q.id === lost.id)!;
    const fx = firstQueen.x / 256, fy = firstQueen.y / 256;
    const whiteAt = (ps: ReturnType<typeof markerParticles>["particles"]) => ps.find((p) => p.kind === "ring" && p.tint === 0xffffff && near(p.x, fx * 10) && near(p.y, fy * 10));
    expect(whiteAt(markerParticles(first, (x, y) => [x * 10, y * 10]).particles)).toBeDefined();
    const firstStill = markerParticles(first, (x, y) => [x * 10, y * 10], true).particles;
    expect(whiteAt(firstStill)).toBeUndefined();
    expect(firstStill.some((p) => p.kind === "ring" && p.tint === COLONY_TINT[lost.colony] && near(p.x, fx * 10) && near(p.y, fy * 10))).toBe(true);
    expect(emblemState(queen, f, true)!.flash).toBe(state.flash);
    // The other queen, unbitten this moment: no flash, her bar full.
    const other = f.board!.queens!.find((q) => q.colony !== lost.colony)!;
    expect(emblemState(other, f)).toMatchObject({ flash: 0, bar: 1 });
  });

  // Regression caught: the old overrun bar, in the enemy's colour, drawn under the queens of a
  // recording without queen HP, so the page showed two bar designs. One design only: without queen HP there is no bar.
  it("on a recording without queen HP draws no bar under the queen on either board, her emblem and brackets as before", () => {
    const q: StreamQueen = { id: 0, colony: 0, x: 256, y: 256, foundedTick: 0, lostTick: null, overrun: 30 };
    const f = new Frame();
    f.board = { setup: { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 600, overrunRadiusTiles: 2, queens: [[256, 256], [1792, 1792]] }, queens: [q, { ...q, id: 0, colony: 1, x: 1792, y: 1792 }], overrunRequired: 100 } as unknown as Frame["board"];
    expect(emblemState(q, f)).toEqual({ scale: 1, alpha: 1, zone: 1, bar: null, flash: 0 });
    const homes = new QueenHomes(10);
    homes.update(f);
    const shapes = drawn2d(homes);
    expect(shapes.some((s) => s.type === "rectangle")).toBe(false);
    expect(shapes.some((s) => s.type === "circle" && near(s.x!, 1) && near(s.y!, 1))).toBe(true);
    expect(homes.zones).toHaveLength(2);
    const particles = markerParticles(f, (x, y) => [x * 10, y * 10]).particles;
    expect(particles.some((p) => p.kind === "line" && near(p.y, 10 + QUEEN_EMBLEM.r + EMBLEM_BAR.gap + 1))).toBe(false);
    expect(particles.filter((p) => p.kind === "queen0" || p.kind === "queen1")).toHaveLength(2);
  });
});

describe("a colony's fall (the collapse)", () => {
  // Regression caught: a lost queen vanishing at once, or lingering past the collapse; the collapse frozen because the stream
  // ended with the fall; then her home vanishing instead of staying as a landmark.
  it("collapses the lost queen's home over QUEEN_COLLAPSE_MS on the playback target, down to the dimmed landmark that stays of her, on both boards", () => {
    const fallMs = lostAt.tick * TICK_MS;
    const during = frameAt(fallMs + QUEEN_COLLAPSE_MS / 3);
    // The recording ends with the fall: playback holds its last tick while the target moves on.
    expect(during.renderMs).toBe(fallMs);
    expect(during.targetMs).toBe(fallMs + QUEEN_COLLAPSE_MS / 3);
    const fallen = streamQueens(during.board!).find((q) => q.colony === lost.colony && q.id === lost.id)!;
    expect(queenLossAge(fallen, during.targetMs)).toBeCloseTo(QUEEN_COLLAPSE_MS / 3, 6);
    const s = emblemState(fallen, during)!;
    expect(s.scale).toBeCloseTo(1 - (1 / 9) * (1 - LOST_EMBLEM.scale), 6);
    expect(s.alpha).toBeCloseTo(1 - (1 / 3) * (1 - LOST_EMBLEM.alpha), 6);
    expect(s.zone).toBeCloseTo(2 / 3, 6);
    expect(s.bar).toBe(0);
    // Under reduced motion the collapse is a cut to the landmark, on both boards.
    expect(emblemState(fallen, during, true)).toMatchObject({ scale: LOST_EMBLEM.scale, alpha: LOST_EMBLEM.alpha, zone: 0 });
    expect(markerParticles(during, (x, y) => [x * 10, y * 10], true).particles.find((p) => p.kind === (fallen.colony === 0 ? "queen0" : "queen1"))).toMatchObject({ scaleX: LOST_EMBLEM.scale, alpha: LOST_EMBLEM.alpha });
    const qx = fallen.x / 256, qy = fallen.y / 256;
    const homes = new QueenHomes(10);
    homes.update(during);
    const disc = drawn2d(homes).find((sh) => sh.type === "circle" && near(sh.x!, qx) && near(sh.y!, qy) && sh.action === "fill");
    expect(disc!.radius).toBeCloseTo((QUEEN_EMBLEM.r * s.scale) / 10, 6);
    expect(disc!.alpha).toBeCloseTo(0.85 * s.alpha, 6);
    // Her bar's track fades with the zone's brackets, not with the emblem.
    const barY = qy + (QUEEN_EMBLEM.r + EMBLEM_BAR.gap) / 10;
    const track = drawn2d(homes).find((sh) => sh.type === "rectangle" && near(sh.y!, barY) && near(sh.x!, qx - EMBLEM_BAR.w / 2 / 10));
    expect(track!.alpha).toBeCloseTo(0.9 * s.zone, 6);
    // Only the standing queen's zone is bracketed as a home.
    expect(homes.zones.map((z) => z.colony)).toEqual([(1 - lost.colony) as 0 | 1]);
    const emblem = markerParticles(during, (x, y) => [x * 10, y * 10]).particles.find((p) => p.kind === `queen${lost.colony}`);
    expect(emblem).toMatchObject({ x: qx * 10, y: qy * 10 });
    expect(emblem!.scaleX).toBeCloseTo(s.scale, 6);
    expect(emblem!.alpha).toBeCloseTo(s.alpha, 6);
    // Over: her emblem stays, dimmed and a little smaller, with no brackets and no bar; the other colony's queen stands whole.
    const after = frameAt(fallMs + QUEEN_COLLAPSE_MS);
    expect(emblemState(fallen, after)).toMatchObject({ scale: LOST_EMBLEM.scale, alpha: LOST_EMBLEM.alpha, zone: 0 });
    expect(LOST_EMBLEM.alpha).toBeGreaterThan(0.2);
    expect(LOST_EMBLEM.alpha).toBeLessThan(0.5);
    homes.update(after);
    const landmark = drawn2d(homes).find((sh) => sh.type === "circle" && near(sh.x!, qx) && near(sh.y!, qy) && sh.action === "fill");
    expect(landmark!.radius).toBeCloseTo((QUEEN_EMBLEM.r * LOST_EMBLEM.scale) / 10, 6);
    expect(landmark!.alpha).toBeCloseTo(0.85 * LOST_EMBLEM.alpha, 6);
    expect(drawn2d(homes).some((sh) => sh.type === "rectangle" && near(sh.y!, barY) && near(sh.x!, qx - EMBLEM_BAR.w / 2 / 10))).toBe(false);
    const particles = markerParticles(after, (x, y) => [x * 10, y * 10]).particles;
    const hers = particles.find((p) => p.kind === `queen${lost.colony}`);
    expect(hers).toMatchObject({ x: qx * 10, y: qy * 10, scaleX: LOST_EMBLEM.scale, alpha: LOST_EMBLEM.alpha });
    expect(particles.some((p) => p.kind === "line" && near(p.y, qy * 10 + QUEEN_EMBLEM.r + EMBLEM_BAR.gap + 1) && Math.abs(p.x - qx * 10) <= EMBLEM_BAR.w / 2)).toBe(false);
    const other = particles.find((p) => p.kind === `queen${1 - lost.colony}`);
    expect(other).toMatchObject({ scaleX: 1, alpha: 1 });
  });

  it("shows the result one beat after the end, so the fall is seen first", () => {
    const r = endAt.full === null ? messages.at(-1)!.events.find((e) => e.kind === "end")! : null;
    const result = r && r.kind === "end" ? r.result : null;
    expect(result).not.toBeNull();
    expect(resultShownAt(result!)).toBe(endAt.tick * TICK_MS + RESULT_BEAT_MS);
    // The beat: the card 2.5 s after the end.
    expect(RESULT_BEAT_MS).toBe(2500);
  });

  // Moved from the retired dock.test.ts (its fall group): the board's fall framing and dimming read these, on both boards.
  // Catches: the fall framing the wrong colony or queen, or the board's dim of the fallen colony outliving the card.
  it("frames and dims the fallen colony through the beat, and lets the dim go once the result shows", () => {
    const end = messages.flatMap((m) => m.events).find((e) => e.kind === "end")!;
    const result = (end as Extract<StreamEvent, { kind: "end" }>).result;
    const fallen = [0, 1].map((c) => c !== result.winner);
    const during = frameAt(endAt.tick * TICK_MS + QUEEN_COLLAPSE_MS / 3);
    const board = during.board!;
    expect(fallenColonies(board)).toEqual(fallen);
    // The fall window frames the fallen colony's nests: her tile, the zone's radius and the pad around it.
    const felled = fallenQueen(board)!;
    expect(felled.colony).toBe(1 - result.winner!);
    const own = streamQueens(board).filter((q) => q.colony === felled.colony);
    const xs = own.map((q) => Math.floor(q.x / 256)), ys = own.map((q) => Math.floor(q.y / 256));
    const pad = board.setup.overrunRadiusTiles + FALL_FRAME_PAD;
    expect(fallenNests(board)).toEqual({ x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + 1 + pad, y1: Math.max(...ys) + 1 + pad });
    // The fallen queens themselves, kept whole in frame through the fall: their tiles and QUEEN_FRAME_TILES around.
    const q = QUEEN_FRAME_TILES;
    expect(fallenQueenBox(board)).toEqual({ x0: Math.min(...xs) - q, y0: Math.min(...ys) - q, x1: Math.max(...xs) + 1 + q, y1: Math.max(...ys) + 1 + q });
    const standing = { ...board, queens: board.queens!.map((x) => ({ ...x, lostTick: null })) };
    expect(fallenNests(standing)).toBeNull();
    expect(fallenQueenBox(standing)).toBeNull();
    // The board dims the fallen colony's ants through the beat only: on now, off once the card is up.
    expect(fallWindow(during)).toEqual(fallen);
    const atCard = frameAt(resultShownAt(result, during.endShown ?? undefined));
    expect(fallWindow(atCard)).toEqual([false, false]);
    expect(fallenColonies(atCard.board!)).toEqual(fallen);
  });

  // Regression caught: a loss a stream carried long after its stamped tick (a recording caught from the public stream)
  // collapsing before playback showed it, the result card already over the board at the fall.
  it("runs the collapse, the lingering row and the result's beat from the message that showed a late-stamped loss and end", () => {
    const p = new Playback();
    const f = new Frame();
    const first0 = messages[0]!;
    const q = first0.full!.queens![0]!;
    const key = `${q.colony}:${q.id}`;
    const late: StreamQueen = { ...q, lostTick: 5, hp: 0 };
    const result = { winner: (1 - q.colony) as 0 | 1, reason: "queens_killed" as const, decidedBy: "queens_killed" as const, tick: 5, nextStartMs: null };
    p.push(first0, 0);
    p.push({ tick: 1, ants: first0.ants, full: null, events: [] }, 100);
    p.push({ tick: 80, ants: first0.ants, full: null, events: [{ kind: "queenLost", queen: late }, { kind: "end", result }] }, 8000);
    p.sample(RENDER_DELAY_MS + 8000 + 50, f);
    expect(f.lossShown.get(key)).toBe(80);
    expect(f.endShown).toBe(80);
    const shown = streamQueens(f.board!).find((x) => x.colony === q.colony && x.id === q.id)!;
    expect(shown.lostTick).toBe(5);
    expect(queenLossAge(shown, f.targetMs, f.lossShown.get(key))).toBe(50);
    expect(emblemState(shown, f)!.alpha).toBeCloseTo(1 - (50 / QUEEN_COLLAPSE_MS) * (1 - LOST_EMBLEM.alpha), 6);
    expect(resultShownAt(result, f.endShown!)).toBe(80 * TICK_MS + RESULT_BEAT_MS);
    expect(f.story.find((e) => e.kind === "queen_lost")!.tick).toBe(80);
    // Another match's snapshot starts a new match (the page opens it on the fight); a later same-match snapshot does not.
    expect(p.matches).toBe(1);
    p.push({ ...first0, tick: 90 }, 9000);
    expect(p.matches).toBe(1);
    p.push({ ...first0 }, 9100);
    expect(p.matches).toBe(2);
    // A loss a first snapshot restates ran from its own tick: nothing of it plays at the join; her landmark stands settled.
    const p2 = new Playback();
    p2.push({ ...first0, tick: 80, full: { ...first0.full!, queens: first0.full!.queens!.map((x) => (x.id === q.id && x.colony === q.colony ? late : x)) } }, 0);
    p2.push({ tick: 81, ants: first0.ants, full: null, events: [] }, 100);
    p2.sample(RENDER_DELAY_MS + 100, f);
    expect(f.lossShown.get(key)).toBe(6);
    expect(emblemState(late, f)).toMatchObject({ scale: LOST_EMBLEM.scale, alpha: LOST_EMBLEM.alpha, zone: 0 });
  });
});

describe("the attack in the timeline", () => {
  // Regression caught: a queen bitten with nothing in the timeline or the lower third until she is lost.
  it("opens at each attack's first bite, leads with her HP now, closes on lulls, and ends the fatal attack at the fall", () => {
    const first = bites[0]!;
    const f = frameAt(first.tick * TICK_MS + 50);
    const attack = f.story.find((e) => e.kind === "queen_attack")!;
    expect(attack).toMatchObject({ tick: first.tick, colony: lost.colony, queenId: lost.id, agent: -1, x: lost.x / 256, y: lost.y / 256 });
    // Its ending, settled as messages arrive, is told only once playback reaches it.
    expect(underWay(attack, f.tick)).toBe(true);
    expect(significant(f.story, f.tick)).toBe(attack);
    const queens = f.board!.queens!;
    const hp = queens.find((q) => q.colony === lost.colony && q.id === lost.id)!.hp!;
    const phrase = OPEN_COPY.underAttack ? ` ${OPEN_COPY.underAttack}` : "";
    expect(storyText(attack, [], f.tick, queens)).toEqual({ what: `Queen ${lost.id + 1}${phrase} — ${hpText(hp)}`, who: COLONY_NAMES[lost.colony] });
    expect(hpText(39_100)).toBe("40 HP");
    expect(hpText(100)).toBe("1 HP");
    const end = frameAt(lostAt.tick * TICK_MS);
    const attacks = end.story.filter((e) => e.kind === "queen_attack");
    // The current hatch rule changes the fight's cadence: regeneration is not a bite, and a
    // lull ends one attack before the next starts. Derive those episodes from the recorded HP.
    const drops = bites.filter((b, i) => b.hp < (i === 0 ? QUEEN_HP_RULES.hp : bites[i - 1]!.hp));
    const lull = ATTACK_LULL_S * messages[0]!.full!.setup.ticksPerSecond;
    const starts = drops.filter((b, i) => i === 0 || b.tick - drops[i - 1]!.tick >= lull);
    expect(attacks.map((e) => e.tick)).toEqual(starts.map((b) => b.tick));
    expect(attacks.length).toBeGreaterThan(1);
    for (const [i, episode] of attacks.entries()) {
      const episodeDrops = drops.filter((b) => b.tick >= episode.tick && b.tick < (starts[i + 1]?.tick ?? Infinity));
      const fatal = i === attacks.length - 1;
      expect(episode).toMatchObject({
        colony: lost.colony, queenId: lost.id,
        lowHp: Math.min(...episodeDrops.map((b) => b.hp)),
        endTick: fatal ? lostAt.tick : episodeDrops.at(-1)!.tick + lull,
        outcome: fatal ? "took" : "repelled",
      });
    }
    // At the fall: the fatal attack ended, took, the lowest HP zero; the result's deciding moment.
    const ended = attacks.at(-1)!;
    expect(ended).toMatchObject({ endTick: lostAt.tick, outcome: "took", lowHp: 0 });
    // Her fall reads as main's "Queen N lost".
    expect(storyText(ended, [], end.tick, end.board!.queens)).toEqual({ what: `Queen ${lost.id + 1} lost`, who: COLONY_NAMES[lost.colony] });
    expect(decisive(end.story, end.board!.result!.reason, end.board!.result!.winner)).toEqual([ended]);
    // Playback that has not reached the first attack's end still reads that attack as under way.
    expect(storyText(attacks[0]!, [], first.tick + 1, queens).what).toContain(hpText(hp));
  });

  it("ends repelled when no bite has landed for ATTACK_LULL_S, and unfinished at a time-up under attack", () => {
    const p = new Playback();
    const f = new Frame();
    const first = messages[0]!;
    const q = first.full!.queens![0]!;
    const bite = (tick: number, hp: number) => ({ tick, ants: first.ants, full: null, events: [{ kind: "queenHp" as const, colony: q.colony, queenId: q.id, hp }] });
    p.push(first, 0);
    p.push(bite(10, 30_000), 1000);
    p.push(bite(20, 25_000), 2000);
    const lull = ATTACK_LULL_S * first.full!.setup.ticksPerSecond;
    p.push({ tick: 20 + lull, ants: first.ants, full: null, events: [] }, (20 + lull) * TICK_MS);
    p.sample((20 + lull) * TICK_MS + RENDER_DELAY_MS, f);
    const attack = f.story.find((e) => e.kind === "queen_attack")!;
    expect(attack).toMatchObject({ tick: 10, lowHp: 25_000, endTick: 20 + lull, outcome: "repelled" });
    expect(storyText(attack, [], f.tick).what).toContain("repelled at 25 HP");
    // A new bite opens a new attack; the match ending under it leaves it unfinished.
    p.push(bite(400, 20_000), 40_000);
    p.push({ tick: 401, ants: first.ants, full: null, events: [{ kind: "end", result: { winner: null, reason: "time_up", decidedBy: "draw", tick: 400, nextStartMs: null } }] }, 40_100);
    p.sample(40_100 + RENDER_DELAY_MS, f);
    const attacks = f.story.filter((e) => e.kind === "queen_attack");
    expect(attacks).toHaveLength(2);
    expect(attacks[1]).toMatchObject({ tick: 400, outcome: "unfinished", endTick: 401 });
    expect(storyText(attacks[1]!, [], f.tick).what).toContain("20 HP at time-up");
  });
});
