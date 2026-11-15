// A hovering flyer holds exactly over its destination, so its ground point and its destination are one point; its line
// to the destination still shows, from its body, lifted above that point as each board draws it, down to the ring at
// the destination. Flyers hover through the simulation's own flight pass over a GATHER tile, a lone PATROL mark and
// their LINE spots; the spectator recorder turns each step into its message, which reaches playback through the live
// stream's or a recording's bytes, from the opening snapshot or from a later one, as a seek or a mid-flight join does.
// The full view shows every hovering flyer's line; a colony's view only its own flyers'.
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, encodeReplayMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { FLYER_RULES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Mark, SimState } from "../../src/sim/types.js";
import { antLengthPx } from "../../web/src/ants.ts";
import { FOV, HERO_ALPHA, TOP_BETA, fitTilted, projector, type Pose } from "../../web/src/board3d/view.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { FLIGHT_LINE, FlightLines, flightLines, liftedBy } from "../../web/src/flight-lines.ts";
import { AIR_LIFT_2D_LENGTHS, AIR_LIFT_3D_TILES } from "../../web/src/flyer-lift.ts";
import { flyerOf } from "../../web/src/flyer-state.ts";
import { gridScale } from "../../web/src/grid-scale.ts";
import { TeamView } from "../../web/src/team-view.ts";
import type { Project } from "../../web/src/screen-path.ts";
import { addAnt, emptyMatch } from "../sim/fixtures.js";

// The flight rules on the grid-scale-2 match map, combat held off so only flight is in play.
const config: SimConfig = { ...rulesConfig("redesign"), flyers: FLYER_RULES, startAnts: 0, squadSize: 0,
  terrain: undefined, foodLayout: undefined, foodPatches: [], commandFloorTicks: 0, combatGraceTicks: 99_999, earlyWin: undefined };
const START = 100;
const TICKS = 60;
/** The message from which a later snapshot is taken, as a seek or a join starts from, the flyers long hovering by then. */
const LATER = START + 45;

function scene(): SimState {
  const state = emptyMatch(START, config);
  for (const colony of state.colonies) colony.foodStore = 0;
  for (const colony of [0, 1] as const) {
    const agent: Agent = { id: colony === 0 ? "a" : "b", colony, joinSeq: colony, modelLabel: null, parentAgentId: null,
      squad: [], order: { kind: "hold" }, lastCallTick: START, lastCommandTick: START, idle: false, pendingEvents: [] };
    state.agents.push(agent);
  }
  return state;
}
function mark(state: SimState, verb: NonNullable<Mark["verb"]>, tileX: number, tileY: number, options: Partial<Mark> = {}): void {
  state.marks.push({ id: state.nextMarkId++, agentId: "a", colony: 0, tileX, tileY, words: [], laidTick: START, steering: 0, verb, count: 1,
    revision: 0, caste: "flyer", ...options });
}

/** Each order a flyer hovers on: its scene, and the flyers that hover. */
const orders: { verb: string; build: (state: SimState) => number[] }[] = [
  { verb: "GATHER", build: (state) => {
    const id = addAnt(state, 0, 20, 40, { flyer: true }).id;
    addAnt(state, 1, 24, 40);
    addAnt(state, 0, 24, 41);
    mark(state, "GATHER", 24, 40);
    return [id];
  } },
  { verb: "lone PATROL", build: (state) => {
    const id = addAnt(state, 0, 20, 40, { flyer: true }).id;
    mark(state, "PATROL", 24, 40);
    return [id];
  } },
  { verb: "LINE", build: (state) => {
    addAnt(state, 0, 44, 36);
    for (const x of [40, 44, 48]) addAnt(state, 1, x, 40);
    const ids = [30, 32, 34].map((y) => addAnt(state, 0, 30, y, { flyer: true }).id);
    mark(state, "LINE", 40, 40, { toTileX: 48, toTileY: 40, count: 3 });
    return ids;
  } },
];

/** The match as recorded: the opening snapshot and every step's message, and the snapshot at LATER a joiner or a seek starts from. */
function streamed(build: (state: SimState) => number[]) {
  let state = scene();
  const hoverers = build(state);
  const recorder = new SpectatorRecorder(state);
  const opening: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
  const released = new SpectatorState(recorder.initialFull(), opening.tick, opening.ants);
  const messages: StreamMessage[] = [opening];
  let later: StreamMessage | undefined;
  for (let t = 0; t < TICKS; t++) {
    const out = step(state, []);
    expect(out.results.every((r) => r.ok)).toBe(true);
    state = out.state;
    const record = recorder.record(out);
    released.apply(record);
    messages.push({ ...record, full: null });
    if (record.tick === LATER) later = released.message();
  }
  const { setup } = opening.full!;
  const map = { w: setup.mapW, h: setup.mapH, scale: gridScale(setup) };
  return { hoverers, messages, rest: [later!, ...messages.filter((m) => m.tick > LATER)], map };
}

/** A Playback fed every message through its bytes on arrival at its own tick time, then its frame at `tick`. */
function frameAt(live: boolean, feed: readonly StreamMessage[], tick: number): Frame {
  const pb = new Playback({ live });
  for (const m of feed) pb.push(decodeMessage(live ? encodeMessage(m) : encodeReplayMessage(m)), (m.tick - feed[0]!.tick) * TICK_MS);
  const f = new Frame();
  for (let now = 0; now < 120_000; now += 10) {
    if (pb.sample(now + (live ? 0 : RENDER_DELAY_MS), f) && f.renderMs >= tick * TICK_MS) return f;
  }
  throw new Error(`no frame reached tick ${tick}`);
}

type Board = { board: string; w: number; h: number; toScreen: Project; aloft: Project };
type BoardMap = { w: number; h: number; scale: number };
/**
 * Each board as it projects the ground and an airborne body: the 2D board flat at its fit, the body lifted
 * AIR_LIFT_2D_LENGTHS of the ants' length up the screen (main.ts); the 3D board through its camera over relief, the body
 * AIR_LIFT_3D_TILES above the ground (main3d.ts), tilted at its fit, tilted close to the tile `focus`, and seen from
 * straight above the whole board.
 */
function boards({ w: mapW, h: mapH, scale }: BoardMap, focus: readonly [number, number]): Board[] {
  const relief = (tx: number, ty: number) => 0.4 * Math.sin(tx / 3) * Math.cos(ty / 4);
  const flat = (w: number, h: number): Board => {
    const tilePx = Math.min(w / mapW, h / mapH);
    const toScreen: Project = (tx, ty) => [tx * tilePx, ty * tilePx];
    return { board: "2D", w, h, toScreen, aloft: liftedBy(toScreen, AIR_LIFT_2D_LENGTHS * antLengthPx(tilePx * scale)) };
  };
  const camera = (name: string, pose: Pose, w: number, h: number): Board => {
    const project = projector(pose, w, h);
    const at = (lift: number): Project => (tx, ty) => project([tx, relief(tx, ty) + lift, mapH - ty]) ?? [NaN, NaN];
    return { board: `3D ${name}`, w, h, toScreen: at(0), aloft: at(AIR_LIFT_3D_TILES) };
  };
  const fit = (w: number, h: number) => fitTilted(mapW, mapH, w, h, { x0: 0, y0: 0, x1: w, y1: h }).pose;
  return [
    flat(1920, 1080), flat(390, 844),
    camera("tilted", fit(1920, 1080), 1920, 1080), camera("tilted", fit(390, 844), 390, 844),
    camera("close", { ...fit(1920, 1080), radius: 12, target: [focus[0], 0, mapH - focus[1]] }, 1920, 1080),
    camera("from above", { alpha: HERO_ALPHA, beta: TOP_BETA, radius: 1.2 * mapH / 2 / Math.tan(FOV / 2), target: [mapW / 2, 0, mapH / 2] }, 1920, 1080),
  ];
}

const length = (d: readonly (readonly [number, number])[]) => d.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - d[k]![0], p[1] - d[k]![1]), 0);
/** How much of the drawn line lies beyond the ring's outer edge around the destination, sampled every 0.05 px. */
function shownBeyondRing(dashes: readonly (readonly [number, number])[][], end: readonly [number, number]): number {
  const edge = FLIGHT_LINE.endR + FLIGHT_LINE.width / 2 + FLIGHT_LINE.edge;
  let shown = 0;
  for (const d of dashes) for (let k = 1; k < d.length; k++) {
    const a = d[k - 1]!, b = d[k]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05));
    for (let i = 0; i < n; i++) {
      const p = [a[0] + (b[0] - a[0]) * (i + 0.5) / n, a[1] + (b[1] - a[1]) * (i + 0.5) / n];
      if (Math.hypot(p[0]! - end[0], p[1]! - end[1]) > edge) shown += Math.hypot(b[0] - a[0], b[1] - a[1]) / n;
    }
  }
  return shown;
}

/**
 * Every hoverer's line on every board: from its body down to the ring at its destination, part of it beyond the ring;
 * with own, the colony whose view the frame is, and no other line drawn.
 */
function expectDrops(frame: Frame, hoverers: readonly number[], map: BoardMap, own: number | null = null) {
  const lines = flightLines(frame, own).filter((l) => hoverers.includes(l.antId));
  expect(lines.map((l) => l.antId)).toEqual(hoverers);
  for (const line of lines) {
    // The engine's hover: the flyer's ground point is its destination.
    expect(line.hovering).toBe(true);
    expect(line.from).toEqual(line.to);
    const i = Array.from(frame.id.subarray(0, frame.count)).indexOf(line.antId);
    expect(flyerOf(frame, i)!.state).toBe("hovering");
  }
  for (const line of lines) for (const { board, w, h, toScreen, aloft } of boards(map, line.to)) {
    const layer = new FlightLines();
    layer.update(frame, toScreen, own, { x0: 0, y0: 0, x1: w, y1: h }, aloft);
    {
      const where = `${board} ${w}x${h}, flyer ${line.antId}`;
      expect(layer.drawn().map((d) => d.antId), where).toEqual(hoverers);
      const drawn = layer.drawn().find((d) => d.antId === line.antId);
      expect(drawn, where).toBeDefined();
      const ground = toScreen(...line.from), body = aloft(...line.from);
      expect(drawn!.end, where).toEqual(ground);
      // The drop runs from the body toward the ground: from the body itself where its lift shows at least minDrop px,
      // else minDrop px up toward it (straight up the screen where the body is drawn over its ground point).
      const lift = [body[0] - ground[0], body[1] - ground[1]] as const, lifted = Math.hypot(...lift);
      const top = lifted >= FLIGHT_LINE.minDrop ? body
        : lifted > 1e-9 ? [ground[0] + lift[0] / lifted * FLIGHT_LINE.minDrop, ground[1] + lift[1] / lifted * FLIGHT_LINE.minDrop]
        : [ground[0], ground[1] - FLIGHT_LINE.minDrop];
      const span = Math.hypot(top[0]! - ground[0], top[1]! - ground[1]);
      const points = drawn!.dashes.flat();
      expect(points.length, where).toBeGreaterThan(0);
      for (const p of points) {
        // On the straight segment from the top of the drop to the ground point.
        const t = ((p[0] - ground[0]) * (top[0]! - ground[0]) + (p[1] - ground[1]) * (top[1]! - ground[1])) / span / span;
        expect(t, where).toBeGreaterThanOrEqual(-1e-9);
        expect(t, where).toBeLessThanOrEqual(1 + 1e-9);
        const off = Math.hypot(p[0] - ground[0] - t * (top[0]! - ground[0]), p[1] - ground[1] - t * (top[1]! - ground[1]));
        expect(off, where).toBeLessThan(1e-6);
      }
      // Leaving the start gap at the top and reaching the ring, with a visible stroke between the flyer and the ring.
      const first = drawn!.dashes[0]![0]!, last = drawn!.dashes.at(-1)!.at(-1)!;
      expect(Math.hypot(first[0] - top[0]!, first[1] - top[1]!), where).toBeCloseTo(Math.min(FLIGHT_LINE.startGap, span * FLIGHT_LINE.shortGapShare));
      const ringGap = Math.min(FLIGHT_LINE.endR, span * FLIGHT_LINE.shortGapShare);
      expect(Math.hypot(last[0] - ground[0], last[1] - ground[1]), where).toBeGreaterThan(ringGap - 1e-6);
      expect(Math.hypot(last[0] - ground[0], last[1] - ground[1]), where).toBeLessThan(ringGap + FLIGHT_LINE.gap + 1e-6);
      expect(drawn!.dashes.reduce((s, d) => s + length(d), 0), where).toBeGreaterThanOrEqual(FLIGHT_LINE.dash);
      expect(shownBeyondRing(drawn!.dashes, drawn!.end!), where).toBeGreaterThanOrEqual(4);
    }
  }
}

describe.each(orders)("a flyer hovering on its $verb order shows a line from its body to its destination", ({ build }) => {
  const match = streamed(build);
  const last = match.messages.at(-1)!.tick;
  for (const live of [false, true]) describe(live ? "live playback" : "recorded playback", () => {
    it("from the opening snapshot, once it hovers, on both boards", () => {
      expectDrops(frameAt(live, match.messages, last - 2), match.hoverers, match.map);
    });

    it("on the first frame from a later snapshot, as after a seek or on joining while it hovers, on both boards", () => {
      expectDrops(frameAt(live, match.rest, LATER), match.hoverers, match.map);
    });
  });
});

describe("hovering flyers of both colonies in the full view and in each colony's view", () => {
  // Colony 0's flyer hovers over its GATHER tile and colony 1's over its lone PATROL mark three tiles off, in sight of
  // each other: each colony's view shows both flyers, and only its own flyer's line to its destination.
  const match = streamed((state) => {
    const ids = orders[0]!.build(state);
    ids.push(addAnt(state, 1, 30, 40, { flyer: true }).id);
    mark(state, "PATROL", 27, 40, { agentId: "b", colony: 1 });
    return ids;
  });
  const [mine, theirs] = match.hoverers as [number, number];
  const last = match.messages.at(-1)!.tick;
  for (const live of [false, true]) for (const [from, feed, tick] of [["the opening snapshot", match.messages, last - 2], ["a later snapshot", match.rest, LATER]] as const) {
    it(`${live ? "live" : "recorded"} playback from ${from}, on both boards`, () => {
      const frame = frameAt(live, feed, tick);
      expectDrops(frame, [mine, theirs], match.map);
      const view = new TeamView();
      for (const [colony, own] of [[0, mine], [1, theirs]] as const) {
        // TeamView reuses its output frame, so each colony's view is checked before the next is applied.
        view.choice = colony;
        const shown = view.apply(frame);
        expect([...shown.id.subarray(0, shown.count)].filter((id) => id === mine || id === theirs)).toEqual([mine, theirs]);
        expectDrops(shown, [own], match.map, colony);
      }
    });
  }
});

describe("a flying flyer's line", () => {
  it("stays on the ground from its ground point, whatever the board's lift", () => {
    const match = streamed(orders[0]!.build);
    // The flyer is a tick into its flight, short of its GATHER tile.
    const frame = frameAt(false, match.messages, START + 2);
    const [line] = flightLines(frame);
    expect(line!.hovering).toBe(false);
    for (const { toScreen, aloft } of boards(match.map, line!.from)) {
      const ground = new FlightLines(), lifted = new FlightLines();
      ground.update(frame, toScreen);
      lifted.update(frame, toScreen, null, undefined, aloft);
      expect(lifted.drawn()).toEqual(ground.drawn());
    }
  });
});
