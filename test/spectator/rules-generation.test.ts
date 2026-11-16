import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { COLONY_NAMES_STREAM_VERSION, RULES28_STREAM_VERSION, Writer, decodeMessage, encodeMessage, encodePublicMessage, encodeReplayMessage, type StreamMessage, type StreamRules28Figures } from "../../src/live/format.ts";
import { SpectatorRecorder, setupOf } from "../../src/live/model.ts";
import { step } from "../../src/sim/step.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { RULES27_REDESIGN_FIGURES, RULES27_SOLDIER_INTERVAL_MULTIPLIER, boardQueenHp, redesignFigures, redesignSoldierIntervalTicks } from "../../web/src/variant.ts";
import { rules27Redesign } from "../rules27.ts";

/** A rules-28 redesign config as the flip will define it: 2 food per second, worker 2 food, queen 100 HP. */
const RULES28: SimConfig = (() => {
  const { hatchTiming: _timing, ...rest } = rules27Redesign();
  return { ...rest, rules28: true, hatchRate: { foodPerSecond: 2 }, hatchCost: 2,
    queenHp: { hp: 100_000, damagePerSecond: 10_000, regenHp: 1_000, regenIntervalTicks: 100, regenClearTiles: 3, shieldTicks: 3000 } };
})();

function firstFull(config: SimConfig) {
  const rec = new SpectatorRecorder(createMatch(7, newMatchConfig(config))), init = rec.initial();
  return { tick: init.tick, ants: init.ants, full: rec.initialFull(), events: [] };
}

/** RULES28's own figures: 100 HP queens, 2-food workers, 6-food soldiers hatching every 30 ticks at 2 food per second. */
const RULES28_FIGURES: StreamRules28Figures = { queenHp: 100_000, workerCost: 2, soldierCost: 6, soldierIntervalTicks: 30 };

/** The bytes the figures take after the marker: four varints. */
function figureBytes(f: StreamRules28Figures): number[] {
  const w = new Writer();
  w.v(f.queenHp); w.v(f.workerCost); w.v(f.soldierCost); w.v(f.soldierIntervalTicks);
  return [...w.buf.subarray(0, w.o)];
}

it("a rules-28 match marks its setup with its own figures; both survive encoding, public redaction and decoding", () => {
  const setup = setupOf(createMatch(7, newMatchConfig(RULES28)));
  expect(setup.rules28).toBe(true);
  expect(setup.rules28Figures).toEqual(RULES28_FIGURES);
  const message = firstFull(RULES28);
  for (const bytes of [encodeMessage(message), encodePublicMessage(message)]) {
    expect(bytes[2]).toBe(RULES28_STREAM_VERSION);
    const decoded = decodeMessage(bytes).full!.setup;
    expect(decoded.rules28).toBe(true);
    expect(decoded.rules28Figures).toEqual(RULES28_FIGURES);
  }
});

it("refuses to encode a rules-28 setup without its figures", () => {
  const message = firstFull(RULES28);
  const { rules28Figures: _figures, ...setup } = message.full.setup;
  expect(() => encodeMessage({ ...message, full: { ...message.full, setup } })).toThrow("a rules-28 setup carries its figures");
});

it("a rules-27 match carries no marker and keeps an earlier stream version", () => {
  const setup = setupOf(createMatch(7, newMatchConfig(rules27Redesign())));
  expect([setup.rules28, setup.rules28Figures]).toEqual([undefined, undefined]);
  const bytes = encodeMessage(firstFull(rules27Redesign()));
  expect(bytes[2]).toBeLessThan(RULES28_STREAM_VERSION);
  const decoded = decodeMessage(bytes).full!.setup;
  expect([decoded.rules28, decoded.rules28Figures]).toEqual([undefined, undefined]);
});

it("refuses a marker byte other than 0 or 1", () => {
  const bytes = encodeMessage(firstFull(RULES28));
  // The marker, then its figures, precede the event count (0 events).
  const figures = figureBytes(RULES28_FIGURES), at = bytes.length - 2 - figures.length;
  expect(bytes[bytes.length - 1]).toBe(0);
  expect(Array.from(bytes.slice(at, bytes.length - 1))).toEqual([1, ...figures]);
  const bad = bytes.slice(); bad[at] = 2;
  expect(() => decodeMessage(bad)).toThrow("invalid rules-28 marker");
});

/** Every optional setup and snapshot section a live rules-28 match can stream, at once: water and rocks,
 * command idle, an early-win lead, a count mark, colony names, a rated seat's public identity and the match identity. */
function composedRules28(): StreamMessage {
  const config: SimConfig = { ...RULES28, commandIdleTicks: 600,
    earlyWin: { minTick: 10, holdTicks: 4, territoryRatioPermille: 3000, minHeldTiles: 30 } };
  const state = step(createMatch(7001, newMatchConfig(config)), [{ type: "join", agentId: "internal-id", modelLabel: "self-reported model" }]).state;
  const recorder = new SpectatorRecorder(state, { rated: true, identity: id => id === "internal-id" ? { displayName: "owner/agent", elo: 1234.5, rd: 61 } : undefined });
  const full = recorder.initialFull();
  return { ...recorder.initial(), full: { ...full, match: 913, setup: { ...full.setup, colonyNames: ["Ember", "Moss"] },
    territoryWin: { colony: 0, startTick: 6000, winTick: 8999 },
    marks: [{ id: 3, agent: 0, colony: 0, tileX: 4, tileY: 5, words: [], laidTick: 0, answered: 0, verb: "ATTACK", count: 6, claimed: 0 }] } };
}

it("a composed rules-28 snapshot round-trips every section; the marker and its figures are its only layout difference", () => {
  const marked = composedRules28(), setup = marked.full!.setup;
  expect(setup.rules28).toBe(true);
  expect(setup.terrain!.water.length).toBeGreaterThan(0);
  expect(setup.terrain!.rocks!.length).toBeGreaterThan(0);
  expect(setup.commandIdleTicks).toBe(600);
  expect(setup.rated).toBe(true);
  expect(marked.full!.agents[0]!.identity).toEqual({ displayName: "owner/agent", elo: 1234.5, rd: 61 });
  expect(setup.rules28Figures).toEqual(RULES28_FIGURES);
  const { rules28: _marker, rules28Figures: _figures, ...unmarkedSetup } = setup;
  const unmarked: StreamMessage = { ...marked, full: { ...marked.full!, setup: unmarkedSetup } };
  for (const encode of [encodeMessage, encodePublicMessage, encodeReplayMessage]) {
    const bytes = encode(marked), plain = encode(unmarked), decoded = decodeMessage(bytes);
    expect(bytes[2]).toBe(RULES28_STREAM_VERSION);
    const { rules28, rules28Figures, ...rest } = decoded.full!.setup;
    expect(rules28).toBe(true);
    expect(rules28Figures).toEqual(RULES28_FIGURES);
    expect({ ...decoded, full: { ...decoded.full!, setup: rest } }).toEqual(decodeMessage(plain));
    expect(decoded.full!.marks).toEqual(marked.full!.marks);
    expect(decoded.full!.territoryWin).toEqual({ colony: 0, startTick: 6000, winTick: 8999 });
    expect(decoded.full!.agents[0]!.identity).toEqual({ displayName: "owner/agent", elo: 1234.5, rd: 61 });
    // The unmarked twin is the highest earlier two-colony version (colony names). Only the version byte, the colony
    // count every setup states from the four-colony version on (2, before the queen positions), the marker and its
    // figures differ.
    expect(plain[2]).toBe(COLONY_NAMES_STREAM_VERSION);
    const figures = figureBytes(RULES28_FIGURES);
    expect(bytes.length).toBe(plain.length + 1 + 1 + figures.length);
    let count = 3; while (bytes[count] === plain[count]) count++;
    expect(bytes[count]).toBe(2);
    const uncounted = [...bytes.slice(0, count), ...bytes.slice(count + 1)];
    let at = count; while (uncounted[at] === plain[at]) at++;
    expect(uncounted.slice(at, at + 1 + figures.length)).toEqual([1, ...figures]);
    expect([...uncounted.slice(0, 2), ...uncounted.slice(3, at), ...uncounted.slice(at + 1 + figures.length)]).toEqual([...plain.slice(0, 2), ...plain.slice(3)]);
  }
});

/** Committed recordings made before rules 28. Each carries queen HP; none carries a soldier hatch or a queen attack. */
const RECORDINGS: readonly [string, boolean][] = [
  ["replays/fixtures/pre-compression-replay.bin", true],
  ["live/fixtures/rated-identity-6e6b73b9.bin", false],
  ["live/fixtures/calls-rules26-06c6e13f.bin", false],
  ["live/fixtures/calls-rules27-06c6e13f.bin", false],
];

it.each(RECORDINGS)("recording %s carries no marker and reads rules-27 figures against rules-28 ones", (path, gzipped) => {
  const raw = readFileSync(new URL(`../${path}`, import.meta.url));
  const full = unpackMessages(gzipped ? gunzipSync(raw) : raw).map(b => decodeMessage(b)).find(m => m.full !== null)!.full!;
  expect([full.setup.rules28, full.setup.rules28Figures]).toEqual([undefined, undefined]);
  expect(redesignFigures(full)).toBe(RULES27_REDESIGN_FIGURES);
  expect(redesignSoldierIntervalTicks(full, 10)).toBe(20);
  expect(boardQueenHp(full)?.hp).toBe(40_000);
});

it("a marked board reads its own match's streamed figures, not any served config's; the frozen figures are rules 27's", () => {
  // The renderer's route: a real rules-28 match's public stream, decoded, with no served config substituted.
  const board = decodeMessage(encodePublicMessage(firstFull(RULES28))).full!;
  expect(board.setup.rules).toBeUndefined();
  expect(redesignFigures(board)).toEqual({ workerCost: 2, soldierCost: 6, queenHp: 100_000 });
  expect(redesignSoldierIntervalTicks(board, 10)).toBe(30);
  expect(boardQueenHp(board)?.hp).toBe(100_000);
  // Another rules-28 match's figures travel with it: a 120 HP queen and 9-food soldiers at 3 food per second.
  const other = decodeMessage(encodePublicMessage(firstFull({ ...RULES28, hatchRate: { foodPerSecond: 3 },
    castes: { ...RULES28.castes!, soldierCost: 9 }, queenHp: { ...RULES28.queenHp!, hp: 120_000 } }))).full!;
  expect(redesignFigures(other)).toEqual({ workerCost: 2, soldierCost: 9, queenHp: 120_000 });
  expect(redesignSoldierIntervalTicks(other, 7)).toBe(30);
  // An unmarked board keeps rules 27's frozen figures, which are the served rules-27 config's.
  const r27 = rules27Redesign();
  expect(redesignFigures(decodeMessage(encodePublicMessage(firstFull(r27))).full!)).toBe(RULES27_REDESIGN_FIGURES);
  expect(RULES27_REDESIGN_FIGURES).toEqual({ workerCost: r27.hatchCost, soldierCost: r27.castes!.soldierCost, queenHp: r27.queenHp!.hp });
  expect(RULES27_SOLDIER_INTERVAL_MULTIPLIER).toBe(r27.hatchTiming!.soldierIntervalMultiplier);
});

// Rendering on a build whose redesign rules are rules 28: a recording without the marker draws rules 27.
import { storesOf } from "../../src/live/model.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { SUB } from "../../src/sim/config.ts";
import { advance } from "../../src/sim/step.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { nextHatchCaste } from "../../web/src/overlays.ts";
import { dials, winConditions } from "../../web/src/ui/deck/model.ts";
import { addAnt, emptyMatch } from "../sim/fixtures.ts";

function soldierPending(config: SimConfig) {
  const state = createMatch(7, newMatchConfig(config));
  while (!storesOf(state).some(s => s.nextCost === 6 && s.nextHatchTick > state.tick + 3 && s.food >= 6)) advance(state);
  const rec = new SpectatorRecorder(state), init = rec.initial();
  return [encodeReplayMessage({ tick: init.tick, ants: init.ants, full: rec.initialFull(), events: [] })];
}
function queenAttack(config: SimConfig) {
  const state = emptyMatch(100, { ...config, terrain: undefined, foodLayout: undefined, foodPatches: [], startAnts: 0, combatGraceTicks: 0,
    hatchCost: 1_000_000, matchTicks: 600, earlyWin: undefined, queenHp: { ...config.queenHp!, shieldTicks: 0 } });
  const q = state.colonies[0].queens![0]!;
  addAnt(state, 1, Math.floor(q.queenX / SUB) + 1, Math.floor(q.queenY / SUB));
  const rec = new SpectatorRecorder(state);
  const out = [encodeReplayMessage({ ...rec.initial(), full: rec.initialFull() })];
  for (let i = 0; i < 300; i++) out.push(encodeReplayMessage({ ...rec.record(advance(state)), full: null }));
  return out;
}
function frames(bytes: readonly Uint8Array[]) {
  const p = new Playback(), f = new Frame(), seen: { caste: unknown[]; ring: unknown[]; lamps: unknown[]; attacks: unknown[]; marked: unknown }[] = [];
  for (const m of bytes.map(b => decodeMessage(b))) {
    p.push(m, m.tick * TICK_MS);
    if (!p.sample(m.tick * TICK_MS + RENDER_DELAY_MS, f) || !f.board) continue;
    const b = f.board;
    seen.push({ marked: b.setup.rules28 ?? false, caste: b.stores.map(s => nextHatchCaste(b, s.nextCost)), ring: dials(f).map(d => d.next),
      lamps: winConditions(f).lamps.flat().map(l => [l.hp, l.fill]),
      attacks: (f.story ?? []).filter((e: any) => e.kind === "queen_attack").map((e: any) => [e.tick, e.endTick ?? null, e.outcome ?? null]) });
  }
  return seen;
}

it("an unmarked rules-27 recording keeps its soldier glyph, soldier ring and queen bar on a rules-28 build", () => {
  const [frame] = frames(soldierPending(rules27Redesign()));
  expect(frame!.marked).toBe(false);
  expect(frame!.caste).toContain("soldier");
  // 13 ticks left of the rules-27 soldier interval (20 ticks) draws a quarter; the rules-28 interval (30) would draw a half.
  expect(frame!.ring).toContainEqual({ kind: "waiting", caste: "soldier", fill: 0.25 });
  expect(frame!.lamps).toEqual([["40", 1], ["40", 1]]);
}, 60_000);

it("an unmarked rules-27 queen attack is repelled when the queen's rules-27 HP recovers", () => {
  const seen = frames(queenAttack(rules27Redesign()));
  expect(seen.at(-1)!.attacks).toEqual([[101, 201, "repelled"]]);
});

it("a rules-28 recording is marked and draws rules-28 figures", () => {
  const [frame] = frames(soldierPending(rulesConfig("redesign")));
  expect(frame!.marked).toBe(true);
  expect(frame!.caste).toContain("soldier");
  expect(frame!.lamps).toEqual([["100", 1], ["100", 1]]);
}, 60_000);

// The 2D HUD's next-hatch chip draws the same caste glyph and soldier ring as the deck, from its own copy of the interval.
import { hatchIntervalOf } from "../../src/sim/config.ts";
import { spawnFill } from "../../web/src/ui/format.ts";
import { mountHud } from "../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../web/src/ui/types.ts";
import { dom, type ElementPort } from "./pages/dom.ts";

const SOLDIER_PATH = "M8 11l11 11";
const hudActions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
function firstFrame(bytes: readonly Uint8Array[]): Frame {
  const p = new Playback(), f = new Frame();
  for (const m of bytes.map(b => decodeMessage(b))) {
    p.push(m, m.tick * TICK_MS);
    if (p.sample(m.tick * TICK_MS + RENDER_DELAY_MS, f) && f.board) return f;
  }
  throw new Error("no frame");
}
/** The HUD's next-hatch chips; the test DOM keeps icon markup as text, so the ring's circle is added where the markup has one. */
function hudChips(f: Frame) {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  // Full motion: the HUD draws the exact fill, where reduced motion would round it to quarters.
  Object.assign(port.win, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const create = port.doc.createElement;
  port.doc.createElement = (tag: string) => {
    const node = create(tag);
    Object.defineProperty(node, "innerHTML", { set(markup: string) {
      (node as unknown as ElementPort).html = markup;
      if (markup.includes('class="d2-pie"')) { const pie = create("circle"); pie.className = "d2-pie"; node.append(pie); }
    } });
    return node;
  };
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = mountHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions: hudActions } as unknown as HudHost);
  hud.update({ frame: f, connection: "live", board: "2d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  for (const half of host.byClass("d2-half")) half.click(); // pin both drawers, where the chip is drawn
  return host.byClass("d2-next").map(chip => ({ glyph: chip.byClass("d2-chip-icon")[0]!.html, offset: chip.byClass("d2-pie")[0]!.style.strokeDashoffset }));
}
/** Each colony waiting on a soldier it has food for: its ring as the board's rules generation fixes it: the soldier interval of `config`. */
function soldierRings(f: Frame, config: SimConfig) {
  const b = f.board!, interval = hatchIntervalOf(newMatchConfig(config), "soldier");
  return b.stores.map(s => s.nextCost === 6 && s.food >= s.nextCost ? spawnFill({ kind: "waiting" }, s.nextHatchTick, interval, f.tick) : null);
}

const GENERATIONS = [["unmarked rules-27", rules27Redesign, false], ["marked rules-28", () => rulesConfig("redesign"), true]] as const;
it.each(GENERATIONS)(
  "an %s board draws the soldier glyph and its generation's soldier ring on the deck and the HUD", (_name, config, marked) => {
    const f = firstFrame(soldierPending(config()));
    expect(f.board!.setup.rules28 ?? false).toBe(marked);
    const rings = soldierRings(f, config()), deck = dials(f).map(d => d.next), hud = hudChips(f);
    const other = soldierRings(f, GENERATIONS.find(g => g[2] !== marked)![1]());
    expect(rings.some(r => r !== null && r > 0 && r < 1)).toBe(true);
    rings.forEach((ring, c) => {
      if (ring === null) return;
      expect(nextHatchCaste(f.board!, f.board!.stores[c]!.nextCost)).toBe("soldier");
      expect(deck[c]).toEqual({ kind: "waiting", caste: "soldier", fill: Math.floor(ring * 4 + 1e-9) / 4 });
      expect(hud[c]!.glyph).toContain(SOLDIER_PATH);
      expect(hud[c]!.offset).toBe((100 - 100 * ring).toFixed(1));
      expect(hud[c]!.offset).not.toBe((100 - 100 * other[c]!).toFixed(1)); // the other generation's interval would differ
    });
  }, 60_000);
