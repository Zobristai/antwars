// The 2D board's score plate in a four-colony match: each colony named in its colour with its source note, its share of
// the held ground, that no territory is held, and the mark of every eliminated colony, the result's winner included
// where the recorded facts eliminate it, with the result still naming it the winner. The HUD is mounted on the test
// port; colours and pointer reach are read from ui.css's rules. Not visual evidence.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUB_TILE, type StreamQueen, type StreamResult } from "../../../src/live/format.ts";
import { SUPERCOLONY_NAMES, colonyNameNote } from "../../../src/sim/colonyNames.ts";
import { D2_COPY, mountHud } from "../../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

// The plate reads playback's eliminations (buffer.ts fallenColonies): every colony whose queens are all lost, as
// recorded, whoever won. Fed exactly that here, so the plate is tested against it whatever the result names.
vi.mock("../../../web/src/buffer.ts", async original => {
  const real = await original<typeof import("../../../web/src/buffer.ts")>();
  return { ...real, fallenColonies: (b: Board) => real.fallenColonies({ queens: b.queens, result: null }) };
});

const CSS = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Each rule's selectors and body, comments removed. */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors!.split(",").map(s => s.trim()), body: body! }));
const declared = (selector: string, property: string) =>
  RULES.filter(rule => rule.selectors.includes(selector)).map(rule => new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(rule.body)?.[1]?.trim()).filter(Boolean).at(-1);

/** The four Quadrants names by colony number, as a four-colony setup carries them. */
const NAMES = SUPERCOLONY_NAMES.map(n => n.label);
const TICK = 4000;
const queen = (colony: number, lost: boolean): StreamQueen =>
  ({ id: 0, colony, x: (8 + 16 * colony) * SUB_TILE, y: 20 * SUB_TILE, foundedTick: 0, lostTick: lost ? TICK - 30 : null, overrun: 0, hp: lost ? 0 : 40000 }) as StreamQueen;

/** A result as a four-colony stream carries it: winner 0 to 3, or null for a draw. */
type Result = Partial<Omit<StreamResult, "winner">> & { winner?: number | null };
/** A four-colony frame: tiles held by each colony, the colonies whose queens are all lost, and the result if any. */
function frameOf(held: readonly number[], lost: readonly number[] = [], result: Result | null = null): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100; f.match = 1;
  // Two ants of each colony, so nothing the plate draws may count ants by a pair of colonies.
  f.ensure(8); f.count = 8;
  for (let i = 0; i < 8; i++) { f.id[i] = i + 1; f.colony[i] = i % 4; f.agent[i] = -1; f.x[i] = 10 + i; f.y[i] = 10; f.alpha[i] = 1; }
  f.board = {
    setup: { mapW: 64, mapH: 64, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3, rated: false, rules: "redesign",
      queens: [0, 1, 2, 3].map(c => [(8 + 16 * c) * SUB_TILE, 20 * SUB_TILE]), colonyNames: NAMES, colonies: 4 },
    queens: [0, 1, 2, 3].map(c => queen(c, lost.includes(c))),
    territory: new Uint8Array(0), held: [...held], marks: [], agents: [],
    overrun: [0, 0, 0, 0], overrunRequired: 100, deaths: [0, 0, 0, 0],
    result: result === null ? null : { winner: null, reason: "idle", decidedBy: "idle", tick: TICK, nextStartMs: null, ...result },
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [0, 1, 2, 3].map(() => ({ food: 5, nextHatchTick: TICK + 10, nextCost: 3 })),
  } as unknown as Board;
  return f;
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

function mount() {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = mountHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  const show = (frame: Frame | null) => hud.update({ frame, connection: "live", board: "2d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  const dialog = () => host.all().find(node => node.tag === "dialog" && node.classes().includes("d1-result-dialog"))!;
  const toast = () => host.byClass("d2-toast")[0]!;
  return { plate: host.byClass("d2-plate")[0]!, show, dialog, toast };
}

/** Whether a node and every ancestor is shown. */
const visible = (node: ElementPort) => { for (let at: ElementPort | null = node; at; at = at.parent) if (at.hidden) return false; return true; };
const rowsOf = (plate: ElementPort) => plate.byClass("d2-qrow").filter(visible);
const part = (row: ElementPort, cls: string) => row.byClass(cls)[0]!;
const figures = (plate: ElementPort) => rowsOf(plate).map(row => part(row, "d2-qfig").textContent);
const heading = (plate: ElementPort) => plate.byClass("d2-qheading")[0]!.textContent;
const marked = (plate: ElementPort) => rowsOf(plate).flatMap((row, c) => visible(part(row, "d2-qmark")) ? [c] : []);

describe("the 2D score plate with four colonies", () => {
  it("names each of the four colonies, in colony order, in its own colour, with its source note where a pointer reaches it", () => {
    const { plate, show } = mount();
    show(frameOf([300, 200, 400, 100]));
    const rows = rowsOf(plate);
    expect(rows.map(row => part(row, "d2-qname").textContent)).toEqual(NAMES);
    rows.forEach((row, c) => {
      expect(row.classes()).toContain(`c${c}`);
      expect(part(row, "d2-qname").getAttribute("title")).toBe(colonyNameNote(NAMES[c]!));
    });
    // Each row's colour is its colony's name colour (colony-palette.ts sets --aw-k0 to --aw-k3); the name and its fill draw it.
    expect([0, 1, 2, 3].map(c => declared(`.d2-qrow.c${c}`, "--d2-q"))).toEqual(["var(--aw-k0, var(--aw-c0))", "var(--aw-k1, var(--aw-c1))", "var(--aw-k2)", "var(--aw-k3)"]);
    expect(declared(".d2-qname", "color")).toBe("var(--d2-q)");
    expect(declared(".d2-qfill", "background")).toBe("var(--d2-q)");
    // The rows take no pointer; the name, which holds the note, does.
    expect(declared(".d2-rows", "pointer-events")).toBe("none");
    expect(declared(".d2-qname", "pointer-events")).toBe("auto");
  });

  it("shows each colony's whole-percent share of the held ground, adding to 100, and fills each track to it", () => {
    const { plate, show } = mount();
    show(frameOf([1, 1, 1, 0]));
    expect(heading(plate)).toBe("Territory");
    expect(figures(plate)).toEqual(["34%", "33%", "33%", "0%"]);
    expect(rowsOf(plate).map(row => (part(row, "d2-qfill").style as unknown as { width: string }).width)).toEqual(["34%", "33%", "33%", "0%"]);
    show(frameOf([5200, 3100, 1500, 200]));
    expect(figures(plate)).toEqual(["52%", "31%", "15%", "2%"]);
  });

  it("says no territory is held when every tile is neutral, invents no share, and keeps the result shown", () => {
    const { plate, show } = mount();
    show(frameOf([0, 0, 0, 0], [], { winner: 2, reason: "time_up", decidedBy: "kills" }));
    expect(heading(plate)).toBe(D2_COPY.noTerritory);
    expect(figures(plate)).toEqual(["", "", "", ""]);
    expect(rowsOf(plate).map(row => (part(row, "d2-qfill").style as unknown as { width: string }).width)).toEqual(["0%", "0%", "0%", "0%"]);
    // The plate goes on naming the colonies under the result.
    expect(rowsOf(plate).map(row => part(row, "d2-qname").textContent)).toEqual(NAMES);
  });

  it("marks an eliminated colony, in place of its track, and goes on showing the others' shares", () => {
    const { plate, show } = mount();
    show(frameOf([600, 0, 300, 100], [1]));
    expect(marked(plate)).toEqual([1]);
    const out = rowsOf(plate)[1]!;
    expect(part(out, "d2-qmark").textContent).toBe(D2_COPY.eliminated);
    expect(out.classes()).toContain("is-fallen");
    expect(visible(part(out, "d2-qtrack"))).toBe(false);
    expect(figures(plate)).toEqual(["60%", "0%", "30%", "10%"]);
  });

  it("marks the result's winner eliminated where a same-tick all-idle end loses its queens too, and the result still names it the winner", () => {
    const { plate, show, dialog, toast } = mount();
    const f = frameOf([500, 500, 0, 0], [0, 1, 2, 3], { winner: 0, reason: "idle", decidedBy: "idle" });
    // Past the result's beat, so its modal is up.
    f.targetMs = TICK * 100 + 10_000;
    show(f);
    expect(marked(plate)).toEqual([0, 1, 2, 3]);
    const won = rowsOf(plate)[0]!;
    expect(won.classes()).toContain("is-fallen");
    expect(part(won, "d2-qmark").textContent).toBe(D2_COPY.eliminated);
    expect(figures(plate)).toEqual(["50%", "50%", "0%", "0%"]);
    expect(dialog().open).toBe(true);
    const head = dialog().byClass("d1-result-head")[0]!;
    expect(head.textContent).toBe(`${NAMES[0]} wins`);
    expect(head.classes()).toContain("c0");
    // No queen's fall is told for it as the match's loss: a four-colony elimination is never the match's fall.
    expect(toast().dataset.state).toBe("hidden");
  });

  it("draws none of the two-colony rows or drawers, and the two-colony plate comes back for a two-colony match", () => {
    const { plate, show } = mount();
    show(frameOf([300, 200, 400, 100]));
    expect(plate.classes()).toContain("is-quad");
    for (const cls of ["d2-srow", "d2-half", "d2-name"]) expect(plate.byClass(cls).filter(visible), cls).toEqual([]);
    expect(visible(plate.byClass("d2-clock")[0]!)).toBe(true);
    show(null);
    expect(plate.classes()).not.toContain("is-quad");
    expect(rowsOf(plate)).toEqual([]);
    expect(plate.byClass("d2-srow").filter(visible)).toHaveLength(4);
    expect(plate.byClass("d2-half").filter(visible)).toHaveLength(2);
  });

  it("adds nothing to a two-colony match's plate", () => {
    const { plate, show } = mount();
    const f = frameOf([520, 480]);
    const b = f.board as unknown as { setup: { queens: unknown[]; colonyNames?: unknown; colonies?: unknown }; queens: StreamQueen[] };
    b.setup.queens = b.setup.queens.slice(0, 2);
    delete b.setup.colonyNames; delete b.setup.colonies;
    b.queens = b.queens.slice(0, 2);
    for (let i = 0; i < f.count; i++) f.colony[i] = i % 2;
    show(f);
    expect(plate.byClass("d2-qrow")).toEqual([]);
    expect(plate.byClass("d2-qheading")).toEqual([]);
    expect(plate.classes()).not.toContain("is-quad");
  });
});
