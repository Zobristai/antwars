// The 3D view's deck in a four-colony match: each colony named in its colour with its source note, its share of the held
// ground (adding to 100), one line while no tile is held, and Eliminated once its queens are all lost, the result's winner
// included, while the result still names it the winner; the two-colony rows that compare one colony with its one opponent
// give way. A recorded match is also played through the live and replay playback into the deck, a same-tick end's winner
// marked Eliminated as its queens record. The deck is mounted on the test port, then written out as markup and laid out
// in headless Chromium with the page's tokens and the client's stylesheets, where each name is checked for its colour,
// its ground, its tooltip and its one line. Not visual evidence.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { Frame, Playback, RESULT_BEAT_MS, TickPreparation, type Board } from "../../../web/src/buffer.ts";
import { SUPERCOLONY_NAMES, colonyNameNote, colourCss } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamEvent, type StreamFull, type StreamMessage, type StreamQueen, type StreamResult } from "../../../src/live/format.ts";
import { TICK_MS } from "../../../src/live/snapshot.ts";
import { TEXT_GROUND, TEXT_PANEL_MAX, contrastRatio, needsTextGround } from "../../../web/src/colony-palette.ts";
import { SCORE_COPY } from "../../../web/src/story.ts";
import { D1_COPY, colonyRows, resultView } from "../../../web/src/ui/deck/model.ts";
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
    expect(colonyRows(quadFrame({ lost: [1, 2, 3], winner: 0 }))!.rows.map(r => r.eliminated)).toEqual([false, true, true, true]);
  });

  it("mark the result's winner eliminated where its queens are all lost at the tick it wins, and the result still names it the winner", () => {
    const frame = quadFrame({ lost: [0, 1], winner: 0 });
    expect(colonyRows(frame)!.rows.map(r => r.eliminated)).toEqual([true, true, false, false]);
    const shown = resultView(frame)!;
    expect(shown.winner).toBe(0);
    expect(shown.headline).toBe(`${NAMES[0]} wins`);
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

  it("marks every eliminated colony Eliminated, the result's winner included", () => {
    const { host, hud } = mounted();
    hud.update(view(quadFrame({ lost: [0, 1], winner: 0 })));
    expect(host.byClass("d1-crow-out").map(out => shownIn(out))).toEqual([true, true, false, false]);
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

// A recorded four-colony match, built decoded as the stream format reads it back: colony 1's queen is killed on tick 2
// and the match plays on; on tick 5 the other three leave idle at once, colony 2 ranked the winner.
const W = 16, H = 16, HP = 5000;
const NESTS = [[2, 2], [13, 2], [2, 13], [13, 13]] as const;
const at = (tile: number) => tile * SUB_TILE + SUB_TILE / 2;
const streamQueen = (colony: number, lostTick: number | null = null, hp = HP): StreamQueen =>
  ({ id: 0, colony, x: at(NESTS[colony]![0]), y: at(NESTS[colony]![1]), foundedTick: 0, lostTick, overrun: 0, hp });
const ants = (colonies: readonly number[]): StreamMessage["ants"] => {
  const list = colonies.map(c => ({ id: c + 1, colony: c, x: at(NESTS[c]![0] + 1), y: at(NESTS[c]![1]) }));
  return { count: list.length, id: Uint32Array.from(list.map(a => a.id)), x: Uint16Array.from(list.map(a => a.x)), y: Uint16Array.from(list.map(a => a.y)),
    heading: new Uint8Array(list.length), colony: Uint8Array.from(list.map(a => a.colony)), agent: new Int16Array(list.length).fill(-1) };
};
const END: StreamResult = { winner: 2, reason: "idle", decidedBy: "kills", tick: 5, nextStartMs: null };
const lost = (colony: number, tick: number, hp: number): StreamEvent => ({ kind: "queenLost", queen: streamQueen(colony, tick, hp) });
const delta = (tick: number, colonies: readonly number[], events: StreamEvent[] = []): StreamMessage => ({ tick, ants: ants(colonies), full: null, events });
function recording(): StreamMessage[] {
  const territory = new Uint8Array(W * H);
  territory.set([1, 1, 1, 2, 2, 3, 3, 4]);
  const full: StreamFull = {
    match: 7,
    setup: { mapW: W, mapH: H, ticksPerSecond: 10, matchTicks: 600, idleTicks: 300, overrunRadiusTiles: 2,
      queens: NESTS.map(([x, y]): [number, number] => [at(x), at(y)]), colonies: 4, colonyNames: NAMES, rated: false },
    queens: [0, 1, 2, 3].map(c => streamQueen(c)), hatched: [0, 0, 0, 0], territory,
    marks: [], agents: [], overrun: [0, 0, 0, 0], overrunRequired: 100, deaths: [0, 0, 0, 0], result: null,
    stores: [0, 1, 2, 3].map(() => ({ food: 0, nextHatchTick: 0, nextCost: 10 })), eliminations: [],
  };
  return [
    { tick: 0, ants: ants([0, 1, 2, 3]), full, events: [] },
    delta(2, [0, 2, 3], [{ kind: "queenHp", colony: 1, queenId: 0, hp: 0 }, lost(1, 2, 0), { kind: "eliminated", colony: 1, tick: 2 }]),
    delta(5, [], [lost(0, 5, HP), lost(2, 5, HP), lost(3, 5, HP), { kind: "eliminated", colony: 0, tick: 5 },
      { kind: "eliminated", colony: 2, tick: 5 }, { kind: "eliminated", colony: 3, tick: 5 }, { kind: "end", result: END }]),
    // Playback reaches the result's beat, where the deck shows it.
    delta(END.tick + 1 + Math.ceil(RESULT_BEAT_MS / TICK_MS), []),
  ];
}

/**
 * The recording through the replay's playback or the live page's prepared ticks, every message in, drawn as the page
 * draws it, one frame per tick of client time from its first message until well past the result's beat.
 */
function played(live: boolean): Frame[] {
  const playback = new Playback(live ? { live: true } : undefined);
  const preparation = new TickPreparation();
  const messages = recording();
  for (const m of messages) {
    if (live) playback.pushPrepared(preparation.prepare(m)!, m.tick * TICK_MS);
    else playback.push(m, m.tick * TICK_MS);
  }
  const frames: Frame[] = [];
  for (let now = 0; now <= messages.at(-1)!.tick * TICK_MS + 10_000; now += TICK_MS) {
    const frame = new Frame();
    if (playback.sample(now, frame)) frames.push(frame);
  }
  return frames;
}

describe("a recorded four-colony match in the deck, through playback", () => {
  for (const live of [false, true]) {
    it(`marks each colony Eliminated as its queens are lost, a same-tick end's winner included, and still names it the winner (${live ? "live" : "replay"})`, () => {
      const frames = played(live);
      // Each state the deck's rows pass through as the match plays, in order.
      const states = frames.map(f => JSON.stringify(colonyRows(f)!.rows.map(r => r.eliminated))).filter((s, i, all) => s !== all[i - 1]);
      expect(states.map(s => JSON.parse(s))).toEqual([
        [false, false, false, false],
        [false, true, false, false],
        [true, true, true, true],
      ]);
      const end = frames.at(-1)!;
      expect(end.board!.result).toEqual(END);
      expect(resultView(end)).toMatchObject({ winner: 2, headline: `${NAMES[2]} wins` });
      const { host, hud } = mounted();
      hud.update(view(end));
      expect(host.byClass("d1-crow-out").map(out => shownIn(out))).toEqual([true, true, true, true]);
    });
  }
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

    it(`mark Eliminated on every eliminated colony's row, the result's winner included, each row on one line, at ${width}px`, async () => {
      const { host, hud } = mounted(width >= 760);
      hud.update(view(quadFrame({ lost: [0, 1], winner: 0 })));
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.setContent(`<!doctype html>${root()}<head><style>${STYLES}</style></head><body><div class="aw-hud">${markup(host)}</div></body></html>`);
        const rows = await page.evaluate(() => [...document.querySelectorAll(".d1-crow")].map(row => {
          const out = row.querySelector(".d1-crow-out")!;
          return { out: getComputedStyle(out).display !== "none" ? out.textContent : null, height: row.getBoundingClientRect().height };
        }));
        expect(rows.map(r => r.out)).toEqual([D1_COPY.eliminated, D1_COPY.eliminated, null, null]);
        for (const row of rows) expect(row.height).toBeLessThanOrEqual(26);
      } finally { await page.close(); }
    });
  }
});

describe("a four-colony recording's legend", () => {
  /** A stored replay's mode line, as the page computes it, with its way back to live; `last` the detail's last clause. */
  const recording = (frame: Frame, last: string): HudView => ({ ...view(frame), mode: { label: "RECORDING · not live", detail: `4 agents · ${last}`,
    link: { text: "Back to live", href: "/?watch=1" } } } as HudView);
  /** The legend's text; the agent count is the frame's. */
  const TEXT = (last: string, agents = 4) => `RECORDING\u00a0· not live · ${agents} agents · ${last}Back to live`;

  it("keeps its text, each clause its own span, and a two-colony legend's text stays one plain run", () => {
    const four = mounted(false);
    four.hud.update(recording(quadFrame(), "15 Nov 2026"));
    expect(one(four.host, "d1-legend").textContent).toBe(TEXT("15 Nov 2026"));
    expect(four.host.byClass("d1-clause").map(c => c.textContent)).toEqual(["· not live", "· 4 agents", "· 15 Nov 2026"]);
    const pair = mounted(false);
    pair.hud.update(recording(pairFrame(), "15 Nov 2026"));
    expect(one(pair.host, "d1-legend").textContent).toBe(TEXT("15 Nov 2026", 2));
    expect(one(pair.host, "d1-legend").classes()).toEqual(["d1-legend"]);
    expect(one(pair.host, "d1-legend-rest").children).toEqual([]);
    // A page that moves from one to the other writes the legend that match's way.
    four.hud.update(recording(pairFrame(), "15 Nov 2026"));
    expect(one(four.host, "d1-legend-rest").children).toEqual([]);
    expect(one(four.host, "d1-legend").classes()).toEqual(["d1-legend"]);
    expect(one(four.host, "d1-legend").textContent).toBe(TEXT("15 Nov 2026", 2));
  });

  for (const width of [390, 320]) {
    for (const last of ["15 Nov 2026", "Recording ended"]) {
      it(`breaks only between clauses on a phone, never inside a clause or the link, at ${width}px (${last})`, async () => {
        const { host, hud } = mounted(false);
        hud.update(recording(quadFrame(), last));
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        try {
          await page.setContent(`<!doctype html>${root()}<head><style>${STYLES}</style></head><body><div class="aw-hud">${markup(host)}</div></body></html>`);
          const legend = await page.evaluate(() => {
            const el = document.querySelector(".d1-legend")!;
            const box = el.getBoundingClientRect();
            return { text: el.textContent, height: box.height, right: box.right,
              pieces: [...el.querySelectorAll(".d1-mode, .d1-clause, .d1-back")].map(n => ({ text: n.textContent, lines: n.getClientRects().length, right: n.getBoundingClientRect().right })) };
          });
          expect(legend.text).toBe(TEXT(last));
          expect(legend.pieces.map(p => p.text)).toEqual(["RECORDING", "· not live", "· 4 agents", `· ${last}`, "Back to live"]);
          for (const piece of legend.pieces) {
            expect(piece.lines, piece.text!).toBe(1);
            expect(piece.right, piece.text!).toBeLessThanOrEqual(legend.right);
          }
          // At these widths the legend takes more than one line, so the breaks are tested.
          expect(legend.height).toBeGreaterThan(16);
        } finally { await page.close(); }
      });
    }
  }
});
