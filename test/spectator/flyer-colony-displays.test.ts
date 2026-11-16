// A flyer is worker caste on the stream, but the spectator page's two colony displays, the 2D HUD's colony drawer and the
// deck's economy, count flyers apart from workers, and their Ants figures and cap keep counting every living ant. A
// coming flyer's next-spawn ring, on the HUD and on the deck, fills over the flyer's own hatch interval and is said to
// be a flyer's. Every board is decoded from a real served rules-28 match's stream, in recorded playback and in
// the buffered live playback of a viewer joining mid-match. A rules-27 recording draws no flyers row or cell.
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeReplayMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { hatchIntervalOf, rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { step } from "../../src/sim/step.ts";
import type { ColonyId, SimInput, SimState } from "../../src/sim/types.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { colonyStats, nextHatchCaste, scoreHatchStatus } from "../../web/src/overlays.ts";
import { dials } from "../../web/src/ui/deck/model.ts";
import { mountDeckHud } from "../../web/src/ui/deck/hud.ts";
import { spawnFill, stepped } from "../../web/src/ui/format.ts";
import { mountHud } from "../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../web/src/ui/types.ts";
import { emptyMatch } from "../sim/fixtures.ts";
import { rules27Redesign } from "../rules27.ts";
import { dom, type ElementPort } from "./pages/dom.ts";

/** The configuration every served match plays, on an open board with no food, so only the queens' broods act. */
const SERVED: SimConfig = { ...newMatchConfig(rulesConfig("redesign")), terrain: undefined, foodLayout: undefined, foodPatches: [] };
const FLYER_INTERVAL = hatchIntervalOf(SERVED, "flyer");
const WORKER_INTERVAL = hatchIntervalOf(SERVED, "worker");

const join = (agentId: string, colony: ColonyId): SimInput => ({ type: "join", agentId, placement: colony, queenId: 0 });
const brood = (agentId: string, kind: string): SimInput => ({ type: "set_brood", agentId, brood: kind });

/** Each colony's living ants by kind, as the engine holds them: a flyer is worker caste with the flyer mark. */
interface Truth { readonly workers: number; readonly soldiers: number; readonly flyers: number; readonly living: number }
function truth(state: SimState): [Truth, Truth] {
  return ([0, 1] as const).map((colony) => {
    const ants = state.ants.filter((a) => a.colony === colony);
    const flyers = ants.filter((a) => a.flyer === true).length, soldiers = ants.filter((a) => a.flyer !== true && a.caste === "soldier").length;
    return { workers: ants.length - flyers - soldiers, soldiers, flyers, living: ants.length };
  }) as [Truth, Truth];
}

/**
 * A served match: colony 0's seat breeds workers, then flyers from tick 35; colony 1 keeps its mixed brood. Stores are
 * kept far above any cost, so every hatch follows its queen's clock. Returns each tick's public message as a recording
 * holds it, each colony's living ants at that tick, and the state it ends in.
 */
function match(untilTick: number, config: SimConfig = SERVED, inputs = new Map<number, SimInput[]>([[0, [join("a", 0), brood("a", "workers")]], [35, [brood("a", "flyers")]]])) {
  let state = emptyMatch(0, config);
  const recorder = new SpectatorRecorder(state);
  const messages: Uint8Array[] = [encodeReplayMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const truths = new Map<number, [Truth, Truth]>([[state.tick, truth(state)]]);
  while (state.tick < untilTick) {
    for (const colony of state.colonies) colony.foodStore = 10_000;
    const out = step(state, inputs.get(state.tick) ?? []);
    state = out.state;
    messages.push(encodeReplayMessage({ ...recorder.record(out), full: null }));
    truths.set(state.tick, truth(state));
  }
  return { messages, truths, state };
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

function page(deck: boolean, frame: Frame) {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  // Full motion: the HUD draws the exact fill, where reduced motion would round it to quarters.
  Object.assign(port.win, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  // The test DOM keeps markup as text, so the ring's circle is added where the markup has one.
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
  const hud = (deck ? mountDeckHud : mountHud)({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  hud.update({ frame, connection: "live", board: deck ? "3d" : "2d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  return host;
}

/** The 2D HUD's colony drawers, both pinned open: each shown pair's label and figure, and the next-hatch chip. */
function hudDrawers(frame: Frame) {
  const host = page(false, frame);
  for (const half of host.byClass("d2-half")) half.click();
  return ([0, 1] as const).map((c) => {
    const drawer = host.byClass(`d2-drawer`).find((d) => d.classes().includes(`c${c}`))!;
    const pairs = Object.fromEntries(drawer.byClass("d2-pair").filter((p) => !p.hidden && !p.classes().includes("d2-spawn"))
      .map((p) => [p.children[0]!.textContent, p.children[1]!.textContent]));
    const chip = drawer.byClass("d2-next")[0]!;
    return { pairs, label: chip.getAttribute("aria-label"), offset: chip.byClass("d2-pie")[0]!.style.strokeDashoffset };
  });
}

/** The deck's economies: each shown cell's label and figure, and the next spawn's spoken words. */
function deckEconomies(frame: Frame) {
  const host = page(true, frame);
  return ([0, 1] as const).map((c) => {
    const econ = host.byClass("d1-econ").find((e) => e.classes().includes(`c${c}`))!;
    const cells = Object.fromEntries(econ.byClass("d1-cell").filter((cell) => !cell.hidden && !cell.byClass("d1-next")[0])
      .map((cell) => [cell.byClass("d1-ml")[0]!.textContent, cell.byClass("d1-mv")[0]!.children[1]!.textContent]));
    const said = econ.byClass("d1-next")[0]!.byClass("d1-sr").at(-1)!.textContent;
    return { cells, said };
  });
}

/** The figures each display must show at this frame's tick, read from the engine's own ants. */
function expectCounts(frame: Frame, truths: ReadonlyMap<number, [Truth, Truth]>) {
  const t = truths.get(frame.tick)!;
  const cap = frame.board!.hatch!.cap;
  expect(colonyStats(frame).map((s) => [s.workers, s.soldiers, s.flyers])).toEqual(t.map((c) => [c.workers, c.soldiers, c.flyers]));
  expect(dials(frame).map((d) => [d.workers, d.soldiers, d.flyers, d.ants])).toEqual(t.map((c) => [String(c.workers), String(c.soldiers), String(c.flyers), `${c.living}/${cap}`]));
  hudDrawers(frame).forEach((drawer, c) => {
    expect(drawer.pairs).toMatchObject({ Workers: String(t[c]!.workers), Soldiers: String(t[c]!.soldiers), Flyers: String(t[c]!.flyers), Cap: cap.toLocaleString("en") });
  });
  deckEconomies(frame).forEach((econ, c) => {
    expect(econ.cells).toMatchObject({ Workers: String(t[c]!.workers), Soldiers: String(t[c]!.soldiers), Flyers: String(t[c]!.flyers), Ants: `${t[c]!.living}/${cap}` });
  });
}

/** Colony 0's coming flyer: its caste and its ring over the flyer's interval, on the deck and on the HUD. */
function expectFlyerRing(frame: Frame) {
  const b = frame.board!, store = b.stores[0]!;
  expect(store.nextCost).toBe(SERVED.flyers!.cost);
  const wait = store.nextHatchTick - frame.tick;
  expect(wait).toBeGreaterThan(WORKER_INTERVAL);
  expect(wait).toBeLessThan(FLYER_INTERVAL);
  const ring = spawnFill({ kind: "waiting" }, store.nextHatchTick, FLYER_INTERVAL, frame.tick);
  expect(ring).toBeCloseTo(1 - wait / FLYER_INTERVAL, 9);
  expect(nextHatchCaste(b, store.nextCost)).toBe("flyer");
  expect(scoreHatchStatus(b, 0, livingOf(frame, 0), frame.tick).description).toContain("Next flyer hatch");
  expect(dials(frame)[0].next).toEqual({ kind: "waiting", caste: "flyer", fill: stepped(ring) });
  expect(dials(frame)[0].nextText).toContain("Next flyer hatch");
  const hud = hudDrawers(frame)[0]!;
  expect(hud.offset).toBe((100 - 100 * ring).toFixed(1));
  expect(hud.label).toContain("Next flyer hatch");
  expect(deckEconomies(frame)[0]!.said).toContain("Next flyer hatch");
}
const livingOf = (frame: Frame, colony: 0 | 1) => { const s = colonyStats(frame)[colony]; return s.workers + s.soldiers + s.flyers; };

describe("flyers on the spectator page's colony displays", () => {
  const UNTIL = 200;
  const { messages, truths } = match(UNTIL);

  it("the scripted match has living flyers, workers and soldiers, and colony 0's next hatch is a flyer due later than a worker's interval", () => {
    const last = truths.get(UNTIL)!;
    expect(last[0].flyers).toBeGreaterThanOrEqual(2);
    expect(last[0].workers).toBeGreaterThanOrEqual(1);
    expect(last[1].soldiers).toBeGreaterThanOrEqual(1);
    expect(FLYER_INTERVAL).toBe(6 * SERVED.ticksPerSecond);
  });

  it("recorded: both displays count flyers apart from workers, with the Ants figures and cap counting every living ant", () => {
    const playback = new Playback(), frame = new Frame();
    for (const m of messages.map((bytes) => decodeMessage(bytes))) playback.push(m, m.tick * TICK_MS);
    let flyersSeen = 0;
    for (const tick of [20, 60, 95, 120, 155, 180, UNTIL]) {
      expect(playback.sample(tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
      expect(frame.tick).toBe(tick);
      expectCounts(frame, truths);
      flyersSeen += truths.get(tick)![0].flyers;
    }
    expect(flyersSeen).toBeGreaterThan(0);
  }, 60_000);

  it("recorded: a coming flyer's ring fills over the flyer's interval on the deck and the HUD, said to be a flyer's", () => {
    const playback = new Playback(), frame = new Frame();
    for (const m of messages.map((bytes) => decodeMessage(bytes))) playback.push(m, m.tick * TICK_MS);
    let checked = 0;
    for (let tick = 100; tick <= UNTIL; tick++) {
      playback.sample(tick * TICK_MS + RENDER_DELAY_MS, frame);
      const store = frame.board!.stores[0]!;
      if (store.nextCost !== SERVED.flyers!.cost) continue;
      const wait = store.nextHatchTick - frame.tick;
      if (wait <= WORKER_INTERVAL || wait >= FLYER_INTERVAL) continue;
      expectFlyerRing(frame);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  }, 60_000);

  it("live: a viewer joining mid-match sees the same counts and the flyer's ring on the buffered live clock", () => {
    const joinTick = 120;
    const { messages: later, truths: laterTruths, state: joined } = match(joinTick);
    expect(joined.tick).toBe(joinTick);
    const recorder = new SpectatorRecorder(joined);
    const live: StreamMessage[] = [decodeMessage(encodeReplayMessage({ ...recorder.initial(), full: recorder.initialFull() }))];
    let state = joined;
    const allTruths = new Map(laterTruths);
    while (state.tick < UNTIL) {
      for (const colony of state.colonies) colony.foodStore = 10_000;
      const out = step(state, []);
      state = out.state;
      live.push(decodeMessage(encodeReplayMessage({ ...recorder.record(out), full: null })));
      allTruths.set(state.tick, truth(state));
    }
    expect(later.length).toBe(joinTick + 1);
    const playback = new Playback({ live: true }), frame = new Frame();
    let pushed = 0, drawn = 0, rings = 0;
    for (let now = 0; now <= (UNTIL - joinTick) * TICK_MS + 3000; now += 50) {
      while (pushed < live.length && (live[pushed]!.tick - joinTick) * TICK_MS <= now) { playback.push(live[pushed]!, (live[pushed]!.tick - joinTick) * TICK_MS); pushed++; }
      if (!playback.sample(now, frame) || !frame.board || now % 500 !== 0) continue;
      drawn++;
      expectCounts(frame, allTruths);
      const store = frame.board.stores[0]!, wait = store.nextHatchTick - frame.tick;
      if (store.nextCost === SERVED.flyers!.cost && wait > WORKER_INTERVAL && wait < FLYER_INTERVAL) { expectFlyerRing(frame); rings++; }
    }
    expect(drawn).toBeGreaterThan(5);
    expect(rings).toBeGreaterThan(0);
  }, 60_000);

  it("a rules-27 recording draws no Flyers row or cell, and its displays read as before", () => {
    const r27 = { ...newMatchConfig(rules27Redesign()), terrain: undefined, foodLayout: undefined, foodPatches: [] };
    const { messages: old, truths: oldTruths } = match(60, r27, new Map([[0, [join("a", 0), brood("a", "workers")]]]));
    const playback = new Playback(), frame = new Frame();
    for (const m of old.map((bytes) => decodeMessage(bytes))) playback.push(m, m.tick * TICK_MS);
    expect(playback.sample(60 * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
    expect(frame.board!.setup.rules28).toBeUndefined();
    const t = oldTruths.get(frame.tick)!;
    expect(dials(frame).map((d) => [d.workers, d.soldiers, d.flyers])).toEqual(t.map((c) => [String(c.workers), String(c.soldiers), null]));
    hudDrawers(frame).forEach((drawer) => expect(Object.keys(drawer.pairs)).not.toContain("Flyers"));
    deckEconomies(frame).forEach((econ) => expect(Object.keys(econ.cells)).toEqual(["Workers", "Soldiers", "Food", "Ants"]));
  }, 60_000);
});
