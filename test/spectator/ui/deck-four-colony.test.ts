// The 3D view's deck in a four-colony match: each colony named in its colour with its source note, its share of the held
// ground (adding to 100), one line while no tile is held, and Eliminated once its queens are all lost, never on the
// result's winner; the two-colony rows that compare one colony with its one opponent give way. The deck is mounted on the
// test port, then written out as markup and laid out in headless Chromium with the page's tokens and the client's
// stylesheets, where each name is checked for its colour, its ground, its tooltip and its one line. Not visual evidence.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUPERCOLONY_NAMES, colonyNameNote, colourCss } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { TEXT_GROUND, TEXT_PANEL_MAX, contrastRatio, needsTextGround } from "../../../web/src/colony-palette.ts";
import { SCORE_COPY } from "../../../web/src/story.ts";
import { D1_COPY, colonyRows } from "../../../web/src/ui/deck/model.ts";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
const STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "colony-ground.css"].map(path => read(`../../../web/src/${path}`))].join("\n");
/** A four-colony setup's names: the shared table's, by colony number. */
const NAMES = SUPERCOLONY_NAMES.map(n => n.label);
const TICK = 4000;

const queen = (colony: number, id: number, lostTick: number | null): StreamQueen =>
  ({ id, colony, x: (8 + 16 * colony) * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick, overrun: 0, hp: lostTick === null ? 40000 : 0 }) as unknown as StreamQueen;
const agent = (colony: number, name: string): StreamAgent =>
  ({ identity: { displayName: name, elo: 1500 }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" }) as unknown as StreamAgent;

interface Quad { held?: number[]; lost?: number[]; winner?: number | null }
/** A four-colony match at TICK: each colony one queen, `lost` colonies' queens lost, `winner` its result. */
function quadFrame(o: Quad = {}): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100 + 60_000; f.match = 1;
  f.ensure(0); f.count = 0;
  const per = <T>(make: (c: number) => T) => [0, 1, 2, 3].map(make);
  const winner = o.winner === undefined ? null : o.winner;
  f.board = {
    setup: { mapW: 64, mapH: 64, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: per(c => [(8 + 16 * c) * SUB_TILE, 20 * SUB_TILE]), rated: false, rules: "redesign", colonyNames: NAMES, colonies: 4 },
    queens: per(c => queen(c, 0, o.lost?.includes(c) ? TICK - 30 : null)),
    territory: new Uint8Array(0), held: o.held ?? [300, 250, 250, 200], marks: [], agents: per(c => agent(c, `seat-${c}`)),
    overrun: per(() => 0), overrunRequired: 100, deaths: per(() => 0),
    result: o.winner === undefined ? null : { winner, reason: "idle", decidedBy: "idle", tick: TICK, nextStartMs: null },
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: per(() => ({ food: 5, nextHatchTick: TICK + 10, nextCost: 3 })),
  } as unknown as Board;
  return f;
}

/** The same match with two colonies, as every existing match is. */
function pairFrame(): Frame {
  const f = quadFrame();
  const b = f.board!;
  f.board = { ...b, setup: { ...b.setup, queens: b.setup.queens.slice(0, 2), colonyNames: [NAMES[1]!, NAMES[0]!], colonies: undefined },
    queens: b.queens!.slice(0, 2), held: [520, 480], agents: b.agents.slice(0, 2), overrun: [0, 0], deaths: [3, 5], stores: [b.stores[0], b.stores[1]] } as unknown as Board;
  return f;
}

describe("a four-colony match's colonies in the deck", () => {
  it("are none in a two-colony match, whose deck compares its two sides as before", () => {
    expect(colonyRows(pairFrame())).toBeNull();
    expect(colonyRows(null)).toBeNull();
  });

  it("name every colony in colony order with its source note and its share, the shares adding to 100", () => {
    const view = colonyRows(quadFrame({ held: [1, 1, 1, 0] }))!;
    expect(view.noneHeld).toBe(false);
    expect(view.rows.map(r => r.name)).toEqual(NAMES);
    expect(view.rows.map(r => r.note)).toEqual(NAMES.map(name => colonyNameNote(name)));
    expect(view.rows.map(r => r.share)).toEqual(["34%", "33%", "33%", "0%"]);
    expect(view.rows.map(r => r.eliminated)).toEqual([false, false, false, false]);
  });

  it("show no share while no tile is held, and say so once", () => {
    const view = colonyRows(quadFrame({ held: [0, 0, 0, 0] }))!;
    expect(view.noneHeld).toBe(true);
    expect(view.rows.map(r => r.share)).toEqual(["", "", "", ""]);
  });

  it("mark a colony eliminated once every one of its queens is lost", () => {
    expect(colonyRows(quadFrame({ lost: [1] }))!.rows.map(r => r.eliminated)).toEqual([false, true, false, false]);
  });

  it("never mark the result's winner eliminated, even where its queens are all lost at the tick it wins", () => {
    expect(colonyRows(quadFrame({ lost: [0, 1], winner: 0 }))!.rows.map(r => r.eliminated)).toEqual([false, true, false, false]);
  });
});

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
const view = (frame: Frame, selectedAgent = -1): HudView => ({ frame, connection: "live", board: "3d", selected: null, selectedAgent, mode: null, stalled: false } as HudView);

/** wide: the page's media queries as the desktop answers them; a phone's place the board before the deck. */
function mounted(wide = true) {
  const port = dom({ search: "", wide });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const hud = mountDeckHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  return { host, hud };
}
const one = (host: ElementPort, cls: string) => host.byClass(cls)[0]!;
const shownIn = (node: ElementPort | null): boolean => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };

describe("the deck's score in a four-colony match", () => {
  it("lists every colony by name, in its colour class, with its note as its tooltip and its share, in place of Balance and Win conditions", () => {
    const { host, hud } = mounted();
    hud.update(view(quadFrame()));
    expect(shownIn(one(host, "d1-colonies"))).toBe(true);
    const rows = host.byClass("d1-crow");
    expect(rows.map(r => r.classes())).toEqual([0, 1, 2, 3].map(c => ["d1-crow", `c${c}`]));
    expect(rows.map(r => r.byClass("d1-crow-name")[0]!.textContent)).toEqual(NAMES);
    expect(rows.map(r => r.byClass("d1-crow-name")[0]!.getAttribute("title"))).toEqual(NAMES.map(name => colonyNameNote(name)));
    expect(rows.map(r => r.byClass("d1-crow-share")[0]!.textContent)).toEqual(["30%", "25%", "25%", "20%"]);
    expect(rows.map(r => shownIn(r.byClass("d1-crow-out")[0]!))).toEqual([false, false, false, false]);
    expect(shownIn(one(host, "d1-crows-none"))).toBe(false);
    // Balance's rows, which compare one colony with its one opponent, and the two-sided Win conditions give way
    // (deck.css is-four; laid out below).
    expect(one(host, "d1-score").classes()).toContain("is-four");
    // The team containers are a two-colony match's two sides.
    for (const team of host.byClass("d1-team")) expect(shownIn(team)).toBe(false);
  });

  it("says no territory is held, once, with no share, while every tile is neutral", () => {
    const { host, hud } = mounted();
    hud.update(view(quadFrame({ held: [0, 0, 0, 0] })));
    expect(shownIn(one(host, "d1-crows-none"))).toBe(true);
    expect(one(host, "d1-crows-none").textContent).toBe(D1_COPY.noTerritory);
    for (const share of host.byClass("d1-crow-share")) expect(shownIn(share)).toBe(false);
    hud.update(view(quadFrame({ held: [10, 0, 0, 0] })));
    expect(shownIn(one(host, "d1-crows-none"))).toBe(false);
    expect(host.byClass("d1-crow-share").map(s => shownIn(s) ? s.textContent : null)).toEqual(["100%", "0%", "0%", "0%"]);
  });

  it("marks an eliminated colony Eliminated, and never the result's winner", () => {
    const { host, hud } = mounted();
    hud.update(view(quadFrame({ lost: [0, 1], winner: 0 })));
    expect(host.byClass("d1-crow-out").map(out => shownIn(out))).toEqual([false, true, false, false]);
    expect(one(host, "d1-crow-out").textContent).toBe(D1_COPY.eliminated);
  });

  it("opens no card for a pick on the board, and keeps working", () => {
    const { host, hud } = mounted();
    expect(() => hud.update(view(quadFrame(), 2))).not.toThrow();
    expect(host.byClass("d1-selected").filter(node => shownIn(node))).toEqual([]);
  });

  it("gives way to the two-colony deck, unchanged, when the page's match has two colonies", () => {
    const { host, hud } = mounted();
    hud.update(view(quadFrame()));
    hud.update(view(pairFrame()));
    expect(shownIn(one(host, "d1-colonies"))).toBe(false);
    expect(one(host, "d1-score").classes()).not.toContain("is-four");
    for (const node of [...host.byClass("d1-gauge"), ...host.byClass("d1-win"), ...host.byClass("d1-team")]) expect(shownIn(node)).toBe(true);
  });
});

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

/** The page root as the palette sets it for a four-colony match: each colony's colour, and a ground where one is needed. */
function root(): string {
  const colours = SUPERCOLONY_NAMES.map(n => n.colour);
  const grounded = colours.flatMap((c, i) => needsTextGround(c) ? [String(i)] : []);
  const vars = colours.map((c, i) => `--aw-k${i}: ${colourCss(c)}`).join("; ");
  return `<html${grounded.length ? ` data-aw-ground="${grounded.join(" ")}"` : ""} style="${vars}; --aw-ink-ground: ${colourCss(TEXT_GROUND)}">`;
}

describe("in a browser, a four-colony match's colony names", () => {
  for (const width of [1280, 390]) {
    it(`show in their colours on one line, keep 4.5:1 and show their notes under the pointer, at ${width}px`, async () => {
      const { host, hud } = mounted(width >= 760);
      hud.update(view(quadFrame({ lost: [1] })));
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.setContent(`<!doctype html>${root()}<head><style>${STYLES}</style></head><body><div class="aw-hud">${markup(host)}</div></body></html>`);
        // The score shows its clock, the colonies under their heading, and nothing of Balance or Win conditions.
        const shown = await page.evaluate(() => [...document.querySelectorAll(".d1-score > *, .d1-colonies > .d1-kicker")]
          .filter(node => getComputedStyle(node).display !== "none").map(node => node.className));
        expect(shown).toEqual(["d1-clock", "d1-colonies", "d1-kicker"]);
        expect(await page.locator(".d1-colonies > .d1-kicker").textContent()).toBe(SCORE_COPY.territory);
        const names = page.locator(".d1-crow-name");
        expect(await names.count()).toBe(4);
        for (let c = 0; c < 4; c++) {
          const name = names.nth(c);
          await name.scrollIntoViewIfNeeded();
          const box = (await name.boundingBox())!;
          await page.mouse.move(box.x + Math.min(6, box.width / 2), box.y + box.height / 2);
          const seen = await name.evaluate((node, at) => {
            const s = getComputedStyle(node);
            const row = node.closest(".d1-crow")!;
            return {
              colour: s.color, background: s.backgroundColor, hovered: node.matches(":hover"),
              tooltip: document.elementFromPoint(at.x, at.y)?.closest("[title]")?.getAttribute("title") ?? null,
              lines: node.getClientRects().length, clipped: node.scrollWidth > node.clientWidth, rowHeight: row.getBoundingClientRect().height,
              outShown: getComputedStyle(row.querySelector(".d1-crow-out")!).display !== "none",
            };
          }, { x: box.x + Math.min(6, box.width / 2), y: box.y + box.height / 2 });
          const colour = SUPERCOLONY_NAMES[c]!.colour;
          const rgb = (n: number) => `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
          expect(seen.colour, NAMES[c]).toBe(rgb(colour));
          expect(seen, NAMES[c]).toMatchObject({ hovered: true, tooltip: colonyNameNote(NAMES[c]!), lines: 1, clipped: false, outShown: c === 1 });
          expect(seen.rowHeight, NAMES[c]).toBeLessThanOrEqual(26);
          // On its ground where its colour needs one; any other is held to 4.5:1 on the lightest panel it can sit on.
          if (needsTextGround(colour)) expect(seen.background, NAMES[c]).toBe(rgb(TEXT_GROUND));
          const under = needsTextGround(colour) ? TEXT_GROUND : TEXT_PANEL_MAX;
          expect(contrastRatio(colour, under), NAMES[c]).toBeGreaterThanOrEqual(4.5);
        }
      } finally { await page.close(); }
    });
  }
});
