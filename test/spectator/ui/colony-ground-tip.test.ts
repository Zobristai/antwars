// The 3D deck's floating tip (a member's details, a rating's "± RD", the asterisk's note) is one element kept in colony 0's
// team (ui/deck/pane.ts), fixed to the viewport and placed beside whatever it describes, colony 1's included. Where the
// teams sit beside the score, a team whose colony has a dark ground gets 2px more room at each side for the ground's ring
// (colony-ground.css); that room must not clip the tip, so a tip over colony 1 shows in full when colony 0 has a ground,
// and the ring around colony 0's name still fits inside its team. The deck is mounted on the test port with each drawn
// pair and the rated names, written out as markup and laid out at 1280px in headless Chromium with the page's tokens
// (web/index.html) and the client's stylesheets; the tip is shown over colony 1's name as the deck places it (showTip),
// and every point across it must hit the tip itself. Not visual evidence.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import type { ColonyNamePair } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { setMatchColonies } from "../../../web/src/colony-palette.ts";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
const STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "replay-marks.css", "colony-ground.css"].map(path => read(`../../../web/src/${path}`))].join("\n");
const TICK = 4000;
const queen = (colony: 0 | 1, tile: number): StreamQueen => ({ id: 0, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick: null, overrun: 0, hp: 40000 });
const agent = (colony: 0 | 1, name: string): StreamAgent => ({ identity: { displayName: name, elo: 1500 }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" });

function frameOf(names: ColonyNamePair | undefined): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100 + 60_000; f.match = 1;
  f.ensure(0); f.count = 0;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: names === undefined, rules: "redesign", ...(names ? { colonyNames: names } : {}) },
    queens: [queen(0, 8), queen(1, 50)],
    territory: new Uint8Array(0), held: [500, 500], marks: [], agents: [agent(0, "fennec"), agent(1, "tidewater")],
    overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 5, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 5, nextHatchTick: TICK + 10, nextCost: 3 }],
  };
  f.board = b;
  f.story = [];
  return f;
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

/** The 3D deck for a match named `names` (undefined: rated), as a page: the page root as the palette sets it. */
function deckPage(names: ColonyNamePair | undefined) {
  const port = dom({ search: "" });
  setMatchColonies(names ?? COLONY_NAMES, port.doc);
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = mountDeckHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  hud.update({ frame: frameOf(names), connection: "live", board: "3d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  const html = port.html as ElementPort;
  const style = [...(html.style as unknown as { properties: Map<string, [string, string]> }).properties].map(([k, [v]]) => `${k}: ${v}`).join("; ");
  const attrs = Object.entries(html.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return { ground: html.attrs["data-aw-ground"] ?? null, page: `<!doctype html><html${attrs} style="${style}"><head><style>${STYLES}</style></head><body><div class="aw-hud">${markup(host)}</div></body></html>` };
}

/** In the page: the tip shown under colony 1's name as showTip places it; how many of nine points across it hit it. */
function tipOverColony1() {
  const tip = document.getElementById("d1-ast-tip")!;
  const target = document.querySelector(".d1-team.c1 .d1-name")!;
  tip.textContent = "± 90";
  tip.hidden = false;
  const r = target.getBoundingClientRect(), w = tip.offsetWidth, ht = tip.offsetHeight;
  const x = Math.max(8, Math.min(r.left - 12, innerWidth - w - 8)), below = r.bottom + 6;
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(below + ht <= innerHeight - 8 ? below : Math.max(8, r.top - 6 - ht))}px`;
  const b = tip.getBoundingClientRect(), t1 = document.querySelector(".d1-team.c1")!.getBoundingClientRect();
  let hits = 0;
  for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.2, 0.5, 0.8]) {
    const at = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
    if (at && tip.contains(at)) hits++;
  }
  return { inColony0: !!tip.closest(".d1-team.c0"), overColony1: b.left + b.width / 2 > t1.left && b.left + b.width / 2 < t1.right, hits };
}

/** In the page: the room colony 0's name's ground and ring have inside its team's clip at either side, or null without a ground. */
function ringRoom() {
  const name = document.querySelector<HTMLElement>(".d1-team.c0 .d1-name")!, team = name.closest<HTMLElement>(".d1-team")!;
  if (getComputedStyle(name).backgroundColor === "rgba(0, 0, 0, 0)") return null;
  const n = name.getBoundingClientRect(), t = team.getBoundingClientRect();
  // The team clips at its padding box (overflow), and no clip-path narrows that.
  const left = t.left + team.clientLeft, right = left + team.clientWidth;
  return { left: n.left - 2 - left, right: right - (n.right + 2), clipPath: getComputedStyle(team).clipPath };
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

const PAIRS: [ColonyNamePair | undefined, string | null][] = [
  [["Sweetwater Colony", "Lake Skinner Colony"], "0 1"], [["Lake Skinner Colony", "Very Large Colony"], "0"],
  [["Sweetwater Colony", "Lake Hodges Colony"], "0"], [["Lake Hodges Colony", "Sweetwater Colony"], "1"], [undefined, null],
];

describe("the 3D deck's floating tip over colony 1 shows in full whatever ground colony 0 has", () => {
  for (const [names, ground] of PAIRS) {
    it(`${names ? names.join(" against ") : "rated"} at 1280px`, async () => {
      const deck = deckPage(names);
      expect(deck.ground, "the colonies grounded").toBe(ground);
      const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await tab.setContent(deck.page);
        const tip = await tab.evaluate(tipOverColony1);
        expect(tip.inColony0, "the tip is kept in colony 0's team").toBe(true);
        expect(tip.overColony1, "the tip sits over colony 1's team").toBe(true);
        expect(tip.hits, "points across the tip that hit it").toBe(9);
        const ring = await tab.evaluate(ringRoom);
        if (ground?.split(" ").includes("0")) {
          expect(ring, "colony 0's name has a ground").not.toBeNull();
          expect(ring!.clipPath, "no clip-path on the team").toBe("none");
          expect(ring!.left, "room for the ring at the team's left").toBeGreaterThanOrEqual(0);
        } else expect(ring, "colony 0's name has no ground").toBeNull();
      } finally { await tab.close(); }
    });
  }
});
