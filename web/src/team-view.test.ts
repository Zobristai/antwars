/**
 * A colony's point of view on the board. The client's sight and smell masks are checked against the sim's own
 * (src/sim/view.ts createVisibility) on a scripted match, through the stream's rounded positions, at grid scale 2; a config
 * without a recorded grid scale is refused (every match plays at grid scale 2); the frame filter is checked rule
 * by rule at grid scale 2; and the live worker-prepared route is checked to reach the same filtered frame as the
 * recording route.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { createVisibility } from "../../src/sim/view.ts";
import { playScripted } from "../../src/live/record.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { SUB_TILE, decodeMessage, encodeMessage, type StreamAnts, type StreamMessage, type StreamSetup } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, TickPreparation, type Board } from "./buffer.ts";
import { SIGHT_TILES, SMELL_TILES, TeamView, teamMasks, teamViewControl } from "./team-view.ts";

/** The packet's measured edge error is 0.009% of visible tile-ticks; one in a thousand bounds the stream's rounding. */
const ROUNDING_LIMIT = 0.001;

function parity(config: SimConfig, ticks: number) {
  const seed = 42;
  const recorder = new SpectatorRecorder(createMatch(seed, config));
  // The setup as a spectator decodes it, so an absent grid scale stays absent.
  const setup = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() })).full!.setup;
  const totals = { sight: { differ: 0, seen: 0 }, smell: { differ: 0, seen: 0 }, ticks: 0 };
  playScripted({ seed, config, agents: 4, ticks }, out => {
    const ants = recorder.record(out).ants;
    const sim = createVisibility(out.state);
    for (const colony of [0, 1] as const) {
      const client = teamMasks(ants, { setup }, colony);
      for (const [name, mask, radius] of [["sight", client.sight, out.state.config.sightTiles], ["smell", client.smell, out.state.config.smellTiles]] as const) {
        const expected = sim.range(colony, radius);
        for (let i = 0; i < expected.length; i++) {
          if (expected[i] === 1 || mask[i] === 1) totals[name].seen++;
          if (expected[i] !== mask[i]) totals[name].differ++;
        }
      }
    }
    totals.ticks++;
  });
  return { setup, totals };
}

describe("team view sight matches the sim's agent view", () => {
  it("uses the sim's own radii", () => {
    expect(SIGHT_TILES).toBe(DEFAULT_CONFIG.sightTiles);
    expect(SMELL_TILES).toBe(DEFAULT_CONFIG.smellTiles);
  });

  it("refuses a config with no recorded grid scale (older recordings are not played)", () => {
    expect(DEFAULT_CONFIG.gridScale).toBeUndefined();
    expect(() => parity(DEFAULT_CONFIG, 1500)).toThrow("grid scale missing");
  });

  it("scales sight and smell with the recorded grid scale", () => {
    const { setup, totals } = parity(withGridScale(DEFAULT_CONFIG), 600);
    expect(setup.gridScale).toBe(2);
    expect(totals.sight.seen).toBeGreaterThan(0);
    expect(totals.sight.differ / totals.sight.seen).toBeLessThanOrEqual(ROUNDING_LIMIT);
    expect(totals.smell.differ / totals.smell.seen).toBeLessThanOrEqual(ROUNDING_LIMIT);
  });
});

/** Every stream plays at grid scale 2: the scene is laid out in original tiles and placed at t(tile) fine tiles. */
const G = 2;
const t = (tile: number) => tile * G;
const W = t(40), H = t(20);
const sub = (tile: number) => tile * SUB_TILE + SUB_TILE / 2;

/** Colony 0 at (5,5); colony 1 at (9,5) inside its sight and at (30,5) far outside it (original tiles). */
function fixture(): Frame {
  const ants: StreamAnts = {
    count: 3,
    id: Uint32Array.from([1, 2, 3]),
    x: Uint16Array.from([sub(t(5)), sub(t(9)), sub(t(30))]),
    y: Uint16Array.from([sub(t(5)), sub(t(5)), sub(t(5))]),
    heading: new Uint8Array(3),
    colony: Uint8Array.from([0, 1, 1]),
    agent: Int16Array.from([0, 1, 1]),
  };
  const territory = new Uint8Array(W * H);
  territory[0] = 1;
  territory[1] = 2;
  const food = new Uint32Array(W * H);
  food[t(5) * W + t(7)] = 3;
  food[t(5) * W + t(25)] = 4;
  const mark = (id: number, colony: 0 | 1, tileX: number) => ({ id, agent: colony, colony, tileX: t(tileX), tileY: t(5), words: [0], laidTick: 0, answered: 0 });
  const setup = { mapW: W, mapH: H, gridScale: G, queens: [[sub(t(2)), sub(t(5))], [sub(t(35)), sub(t(5))]] } as unknown as StreamSetup;
  const board = {
    setup, territory, food, held: [1, 1], agents: [], overrun: [0, 0], overrunRequired: 1, deaths: [0, 0], result: null, hatch: null,
    marks: [mark(1, 0, 12), mark(2, 0, 20), mark(3, 1, 8)],
    queens: [
      { id: 0, colony: 0, x: sub(t(2)), y: sub(t(5)), foundedTick: 0, lostTick: null, overrun: 0 },
      { id: 1, colony: 0, x: sub(t(38)), y: sub(t(18)), foundedTick: 0, lostTick: null, overrun: 0 },
      { id: 0, colony: 1, x: sub(t(35)), y: sub(t(5)), foundedTick: 0, lostTick: null, overrun: 0 },
      { id: 1, colony: 1, x: sub(t(8)), y: sub(t(8)), foundedTick: 0, lostTick: null, overrun: 0 },
    ],
  } as unknown as Board;
  const frame = new Frame();
  frame.ensure(3);
  frame.count = 3;
  for (let i = 0; i < 3; i++) {
    frame.id[i] = ants.id[i]!;
    frame.x[i] = ants.x[i]! / SUB_TILE;
    frame.y[i] = ants.y[i]! / SUB_TILE;
    frame.colony[i] = ants.colony[i]!;
    frame.agent[i] = ants.agent[i]!;
    frame.alpha[i] = 1;
  }
  frame.ants = ants;
  frame.board = board;
  frame.mapW = W;
  frame.mapH = H;
  frame.territoryA = frame.territoryB = territory;
  frame.trails = Float32Array.from({ length: W * H * 2 }, () => 0.5);
  frame.marks = board.marks.map(m => ({ mark: m, ageMs: 0 }));
  frame.corpses = [{ antId: 9, x: t(6), y: t(6), colony: 1, heading: 0, ageMs: 0 }, { antId: 10, x: t(31), y: t(5), colony: 1, heading: 0, ageMs: 0 }];
  frame.fights = [{ a: 1, b: 2, x: t(7), y: t(5), tick: 0, ageMs: 0 }, { a: 3, b: 4, x: t(30), y: t(6), tick: 0, ageMs: 0 }];
  frame.story = [
    { id: 1, kind: "contact", tick: 0, colony: 1, agent: 1, x: t(30), y: t(5) },
    { id: 2, kind: "queen_founded", queenId: 1, tick: 0, colony: 0, agent: -1, x: t(38), y: t(18) },
    { id: 3, kind: "contact", tick: 0, colony: 1, agent: 1, x: t(8), y: t(6) },
  ];
  return frame;
}

describe("a colony's view of the board", () => {
  it("Full view is the playback frame itself, with no fog", () => {
    const frame = fixture();
    const view = new TeamView();
    expect(view.choice).toBe("full");
    expect(view.apply(frame)).toBe(frame);
    expect(frame.fog).toBeNull();
  });

  it("shows own ants and enemies in sight, fogs and hides the rest", () => {
    const frame = fixture();
    const view = new TeamView();
    view.choice = 0;
    const shown = view.apply(frame);
    expect([...shown.id.subarray(0, shown.count)]).toEqual([1, 2]);
    expect(shown.fog![t(5) * W + t(5) + t(SIGHT_TILES)]).toBe(1);
    expect(shown.fog![t(5) * W + t(5) + t(SIGHT_TILES) + 1]).toBe(0);
    expect(shown.board!.food[t(5) * W + t(7)]).toBe(3);
    expect(shown.board!.food[t(5) * W + t(25)]).toBe(0);
    expect(shown.corpses.map(c => c.antId)).toEqual([9]);
    expect(shown.fights.map(f => f.a)).toEqual([1]);
    // Own queens always; the enemy's only where seen.
    expect(shown.board!.queens!.map(q => `${q.colony}:${q.id}`)).toEqual(["0:0", "0:1", "1:1"]);
    // Board places: in sight, or the colony's own queen events anywhere.
    expect(shown.story.map(e => e.id)).toEqual([2, 3]);
    // The HUD's frame is untouched.
    expect(frame.count).toBe(3);
    expect(frame.board!.food[t(5) * W + t(25)]).toBe(4);
  });

  it("keeps only the colony's own marks within smell and its own territory and trails", () => {
    const frame = fixture();
    const view = new TeamView();
    view.choice = 0;
    const shown = view.apply(frame);
    // Mark 1 is 7 original tiles from the colony's ant (within smell 8), mark 2 is 15 away, mark 3 is the enemy's.
    expect(shown.marks.map(m => m.mark.id)).toEqual([1]);
    expect(shown.board!.marks.map(m => m.id)).toEqual([1]);
    expect(shown.territoryA[0]).toBe(1);
    expect(shown.territoryA[1]).toBe(0);
    expect(shown.board!.territory[1]).toBe(0);
    expect(shown.trails[0]).toBe(0.5);
    expect(shown.trails[1]).toBe(0);
    // Derived arrays keep their identity between frames of one tick, so the boards upload nothing extra.
    const again = view.apply(frame);
    expect(again.territoryA).toBe(shown.territoryA);
    expect(again.fog).toBe(shown.fog);
    expect(again.board).toBe(shown.board);
  });

  it("the other colony sees from its own ants, and the choice can return to Full view", () => {
    const frame = fixture();
    const view = new TeamView();
    view.choice = 1;
    const shown = view.apply(frame);
    expect([...shown.id.subarray(0, shown.count)]).toEqual([1, 2, 3]);
    expect(shown.marks.map(m => m.mark.id)).toEqual([3]);
    expect(shown.territoryA[1]).toBe(2);
    expect(shown.territoryA[0]).toBe(0);
    view.choice = "full";
    expect(view.apply(frame)).toBe(frame);
  });
});

describe("live and recorded playback reach the same colony view", () => {
  it("worker-prepared ticks (the live route) filter exactly as recorded ticks", () => {
    const seed = 7, config = withGridScale(DEFAULT_CONFIG);
    const recorder = new SpectatorRecorder(createMatch(seed, config));
    const messages: StreamMessage[] = [decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }))];
    playScripted({ seed, config, agents: 4, ticks: 200 }, out => {
      const rec = recorder.record(out);
      messages.push(decodeMessage(encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events })));
    });
    const recorded = new Playback(), live = new Playback(), worker = new TickPreparation();
    for (const m of messages) {
      recorded.push(m, m.tick * TICK_MS);
      // The worker's output crosses a structured clone to the page (intake.worker.ts).
      const prepared = worker.prepare(m);
      if (prepared) live.pushPrepared(structuredClone(prepared), m.tick * TICK_MS);
    }
    const a = new Frame(), b = new Frame();
    for (const colony of [0, 1] as const) {
      const viewA = new TeamView(), viewB = new TeamView();
      viewA.choice = viewB.choice = colony;
      for (const at of [50, 120, 190]) {
        recorded.sample(at * TICK_MS + 1000, a);
        live.sample(at * TICK_MS + 1000, b);
        const shownA = viewA.apply(a), shownB = viewB.apply(b);
        expect(shownA.tick).toBe(shownB.tick);
        expect(shownA.count).toBeGreaterThan(0);
        expect(shownA.count).toBeLessThanOrEqual(a.count);
        expect([...shownB.id.subarray(0, shownB.count)]).toEqual([...shownA.id.subarray(0, shownA.count)]);
        expect([...shownB.fog!]).toEqual([...shownA.fog!]);
        expect([...shownB.board!.food]).toEqual([...shownA.board!.food]);
        expect(shownB.marks.map(m => m.mark.id)).toEqual(shownA.marks.map(m => m.mark.id));
      }
    }
  });
});

describe("the point-of-view selector's focus ring", () => {
  /** Just enough of a document for teamViewControl: a select that records its attributes, options and listeners. */
  const stubDocument = () => {
    const attrs = new Map<string, string>();
    const listeners = new Map<string, Array<() => void>>();
    const select = {
      className: "", title: "", value: "", options: [] as unknown[],
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
      removeAttribute: (name: string) => void attrs.delete(name),
      hasAttribute: (name: string) => attrs.has(name),
      append: (o: unknown) => void select.options.push(o),
      addEventListener: (type: string, fn: () => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      fire: (type: string) => listeners.get(type)?.forEach(fn => fn()),
    };
    const doc = { createElement: (tag: string) => (tag === "select" ? select : { value: "", textContent: "" }) } as unknown as Document;
    return { doc, select };
  };

  it("is marked pointer-focused on pointerdown, and a key or leaving it clears the mark", () => {
    const { doc, select } = stubDocument();
    const view = new TeamView();
    teamViewControl(doc, view);
    expect(select.hasAttribute("data-pointer")).toBe(false);
    select.fire("pointerdown");
    expect(select.hasAttribute("data-pointer")).toBe(true);
    select.fire("keydown");
    expect(select.hasAttribute("data-pointer")).toBe(false);
    select.fire("pointerdown");
    select.fire("blur");
    expect(select.hasAttribute("data-pointer")).toBe(false);
  });

  it("still offers Full view and each colony, and a change still sets the view", () => {
    const { doc, select } = stubDocument();
    const view = new TeamView();
    teamViewControl(doc, view);
    expect(select.options).toHaveLength(3);
    select.value = "1";
    select.fire("change");
    expect(view.choice).toBe(1);
  });

  it("both HUDs drop the ring only on the pointer-marked selector and keep the shared keyboard ring", () => {
    for (const [file, root] of [["./ui/deck/deck.css", ".d1"], ["./ui/ui.css", ".d2"]] as const) {
      const css = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(css).toContain(`${root} .aw-team-view[data-pointer]:focus-visible { outline: none; }`);
      expect(css).toContain(`${root} :focus-visible { outline: 2px solid var(--aw-ink-bright); outline-offset: 2px; }`);
      expect(css.match(/aw-team-view[^{]*:focus-visible/g)).toEqual(["aw-team-view[data-pointer]:focus-visible"]);
    }
  });
});
