// A drawn score name's source note must be on the actual pointer target: its own name on phone rows, or its half
// on desktop. Render the mounted plate's markup with the real stylesheet so media rules and ancestor selectors
// participate in hit testing. This checks tooltip reachability, not the browser chrome's native tooltip rendering.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { colonyNameNote } from "../../../src/sim/colonyNames.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

import { markup } from "./port-markup.ts";

const CSS = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8");
const DRAWN = ["Sweetwater Colony", "Lake Skinner Colony"] as const;
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

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

describe("the score plate's drawn colony names", () => {
  for (const width of [390, 1280]) {
    it(`exposes each source note on its own ${width === 390 ? "phone name" : "desktop half-control"} at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        // The surrounding shell selects the same two layout modes as the HUD. The plate itself is produced by
        // mountHud above; no pointer, tooltip or name-position rules are supplied by the fixture.
        await page.setContent(`<!doctype html><style>${CSS}</style><div class="aw-hud"><div class="d2 d2-hud" data-layout="${width === 390 ? "narrow" : "wide"}" data-plate="${width === 390 ? "stacked" : "inline"}"><header class="d2-score"><div class="d2-plate-wrap">${markup(plate(DRAWN))}</div></header></div></div>`);
        expect(await page.locator(".d2-rows").evaluate(node => getComputedStyle(node).pointerEvents)).toBe("none");
        for (const colony of [0, 1]) {
          const name = page.locator(`.d2-name.c${colony}`);
          expect(await name.evaluate(node => getComputedStyle(node).pointerEvents)).toBe(width === 390 ? "auto" : "none");
          const words = await name.locator(".d2-name-text").boundingBox();
          const chevron = await name.locator(".d2-chevron").boundingBox();
          expect(words).not.toBeNull(); expect(chevron).not.toBeNull();
          const points = [
            { x: words!.x + 1, y: words!.y + words!.height / 2 },
            { x: words!.x + words!.width - 1, y: words!.y + words!.height / 2 },
            { x: chevron!.x + chevron!.width / 2, y: chevron!.y + chevron!.height / 2 },
          ];
          for (const point of points) {
            await page.mouse.move(point.x, point.y);
            const hit = await page.evaluate(({ x, y }) => {
              const node = document.elementFromPoint(x, y);
              return { target: node?.closest(".d2-name, .d2-half")?.className ?? null,
                tooltip: node?.closest("[title]")?.getAttribute("title") ?? null };
            }, point);
            expect(hit).toEqual({ target: `d2-${width === 390 ? "name" : "half"} c${colony}`, tooltip: colonyNameNote(DRAWN[colony]!) });
          }
        }
      } finally { await page.close(); }
    });
  }

  it("shows no note on a rated match's plate", () => {
    const root = plate(null);
    expect(root.all().filter(node => node.getAttribute("title") || node.title)).toEqual([]);
  });
});
