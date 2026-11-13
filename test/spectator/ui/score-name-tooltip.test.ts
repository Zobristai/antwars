// The score plate's colony names on the 2D board: a drawn name's source note must sit on an element a pointer over the
// name can reach. The plate's rows take no pointer (ui.css), so a note on the name itself never shows. Reachability is
// read from ui.css's pointer-events rules along the element's ancestry, nearest first; this is not visual evidence.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { colonyNameNote } from "../../../src/sim/colonyNames.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const CSS = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Each ui.css rule setting pointer-events whose selector ends in a compound of classes only: its classes and value. */
const POINTER_RULES = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, selectors, body]) => {
  const value = /pointer-events:\s*(none|auto)/.exec(body!)?.[1];
  if (!value) return [];
  return selectors!.split(",").flatMap(selector => {
    const last = selector.trim().split(/[\s>+~]+/).at(-1)!;
    return /^(\.[\w-]+)+$/.test(last) ? [{ classes: last.slice(1).split("."), value }] : [];
  });
});

/** Whether a pointer can hit `node`: the nearest element on its ancestry that a rule gives pointer-events decides. */
function reachable(node: ElementPort): boolean {
  for (let at: ElementPort | null = node; at; at = at.parent) {
    const matched = POINTER_RULES.filter(rule => rule.classes.every(cls => at!.classes().includes(cls)));
    if (matched.length > 0) return matched.at(-1)!.value !== "none";
  }
  return true;
}

function frameOf(drawn: readonly [string, string] | null): Frame {
  const f = new Frame();
  f.tick = 400; f.targetMs = 40_000; f.match = 1;
  f.ensure(0); f.count = 0;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8, 20], [50, 20]], rated: drawn === null, rules: "redesign", ...(drawn ? { colonyNames: drawn } : {}) },
    queens: [], territory: new Uint8Array(0), held: [500, 500], marks: [], agents: [],
    overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 5, nextHatchTick: 410, nextCost: 3 }, { food: 5, nextHatchTick: 410, nextCost: 3 }],
  };
  f.board = b;
  return f;
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

function plate(drawn: readonly [string, string] | null): ElementPort {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = mountHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  hud.update({ frame: frameOf(drawn), connection: "live", board: "2d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  return host.byClass("d2-plate")[0]!;
}

const titled = (root: ElementPort, note: string) => root.all().filter(node => node.getAttribute("title") === note || node.title === note);

describe("the score plate's drawn colony names", () => {
  it("puts each drawn name's source note where a pointer over the name reaches it, in that colony's half", () => {
    const root = plate(["Sweetwater Colony", "Lake Skinner Colony"]);
    for (const [colony, name] of [[0, "Sweetwater Colony"], [1, "Lake Skinner Colony"]] as const) {
      const holders = titled(root, colonyNameNote(name)!);
      expect(holders.length, `${name}'s note is shown somewhere on the plate`).toBeGreaterThan(0);
      for (const holder of holders) {
        expect(reachable(holder), `${name}'s note sits on .${holder.classes().join(".")}, which a pointer cannot reach`).toBe(true);
        expect(holder.classes()).toContain(`c${colony}`);
      }
    }
  });

  it("the rule it checks against holds: the rows under the names take no pointer", () => {
    const row = plate(["Sweetwater Colony", "Lake Skinner Colony"]).byClass("d2-name-text")[0]!;
    expect(reachable(row)).toBe(false);
  });

  it("shows no note on a rated match's plate", () => {
    const root = plate(null);
    expect(root.all().filter(node => node.getAttribute("title") || node.title)).toEqual([]);
  });
});
