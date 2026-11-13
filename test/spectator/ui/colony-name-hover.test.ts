// A match's drawn colony names carry their source notes as tooltips in the board's caption (the 2D board's toast and the
// 3D deck's caption) and in the result box; hovering each name must reach it, so the note shows. The HUDs are mounted on
// the test port, written out as markup and laid out in headless Chromium with the client's own stylesheets (ui.css and
// deck.css, which the client bundles together); the pointer is then moved over each name. Not visual evidence.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { colonyNameNote } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import { mountResultModal } from "../../../web/src/ui/deck/result-modal.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";

const STYLES = ["../../../web/src/ui/ui.css", "../../../web/src/ui/deck/deck.css"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const DRAWN = ["Sweetwater Colony", "Lake Skinner Colony"] as const;
const TICK = 4000;
const queen = (colony: 0 | 1, tile: number): StreamQueen => ({ id: 0, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick: null, overrun: 0, hp: 40000 });
const agent = (colony: 0 | 1, name: string): StreamAgent => ({ identity: { displayName: name, elo: 1500 }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" });

/** An unrated match with the drawn pair: colony 0's overrun on colony 1's queen under way, or, ended, colony 0's win. */
function frameOf(ended: boolean): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100 + 60_000; f.match = 1;
  f.ensure(0); f.count = 0;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: false, rules: "redesign", colonyNames: DRAWN },
    queens: [queen(0, 8), queen(1, 50)],
    territory: new Uint8Array(0), held: [500, 500], marks: [], agents: [agent(0, "fennec"), agent(1, "tidewater")],
    overrun: [0, 0], overrunRequired: 100, deaths: [0, 0],
    result: ended ? { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK, nextStartMs: null } : null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 5, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 5, nextHatchTick: TICK + 10, nextCost: 3 }],
  };
  f.board = b;
  f.story = [{ id: 1, kind: "overrun", queenId: 0, tick: TICK - 20, colony: 0, agent: -1, x: 50, y: 20 }];
  return f;
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

/** The caption's HUD (2D board or 3D deck), or the result box alone, mounted on the test port. */
function mounted(what: "2d" | "3d" | "result"): ElementPort {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  if (what === "result") {
    const modal = mountResultModal(port.doc);
    host.append(modal.dialog as unknown as ElementPort);
    modal.update(frameOf(true));
    return host;
  }
  const hud = (what === "3d" ? mountDeckHud : mountHud)({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  hud.update({ frame: frameOf(false), connection: "live", board: what, selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  return host;
}


let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

/** Each drawn name's note and what hovering the name shows: the tooltip of the element under the pointer, and whether the name is hovered. */
async function hovered(what: "2d" | "3d" | "result", width: number) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(`<!doctype html><style>${STYLES}</style><div class="aw-hud">${markup(mounted(what))}</div>`);
    // Every element whose tooltip is a drawn name's note: the names in the text, and the result's headline.
    const scope = { "2d": ".d2-toast", "3d": ".d1-caption", result: "dialog" }[what];
    const names = page.locator(DRAWN.map(name => `${scope} [title="${colonyNameNote(name)}"]`).join(", "));
    const shown: { name: string; note: string | null; tooltip: string | null; hovered: boolean }[] = [];
    for (let i = 0; i < await names.count(); i++) {
      const name = names.nth(i);
      // A point inside the name's first line box, near its start: a name wrapping onto two lines leaves a gap at its
      // overall box's centre.
      const at = await name.evaluate(node => { const r = node.getClientRects()[0]!; return { x: r.left + Math.min(6, r.width / 2), y: r.top + r.height / 2 }; });
      await page.mouse.move(at.x, at.y);
      shown.push(await name.evaluate((node, at) => ({
        name: node.textContent!.replace(/ wins$/, ""), note: node.getAttribute("title"), hovered: node.matches(":hover"),
        tooltip: document.elementFromPoint(at.x, at.y)?.closest("[title]")?.getAttribute("title") ?? null,
      }), at));
    }
    return shown;
  } finally { await page.close(); }
}

describe("hovering a drawn colony name shows its source note", () => {
  // On a phone the 3D deck's controls row covers its caption, on main as here, so no name shows there to hover.
  const cases = [["2d", "the 2D board's caption", [1280, 390]], ["3d", "the 3D deck's caption", [1280]], ["result", "the result box", [1280, 390]]] as const;
  for (const [what, label, widths] of cases) {
    for (const width of widths) {
      it(`in ${label} at ${width}px`, async () => {
        const shown = await hovered(what, width);
        expect(shown.length, "drawn names are shown").toBeGreaterThan(0);
        // The caption names both colonies; the result box at least its winner, in its headline.
        expect(shown.map(s => s.name)).toEqual(expect.arrayContaining(what === "result" ? [DRAWN[0]] : [...DRAWN]));
        for (const s of shown) {
          expect(s.note).toBe(colonyNameNote(s.name));
          expect(s, `${s.name}: the pointer over it reaches it and its note`).toMatchObject({ hovered: true, tooltip: s.note });
        }
      });
    }
  }
});
