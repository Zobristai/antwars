// Colony-coloured names and figures retain their original ink without text-sized backing boxes.
// Exercise real mounted HUD, result, replay and Matches markup at rest, hover and focus in Chromium.
// Ordinary result badges retain the same raised fill as other badges; no contrast threshold applies here.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { SUPERCOLONY_NAMES, type ColonyNamePair } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { setMatchColonies } from "../../../web/src/colony-palette.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import { mountResultModal } from "../../../web/src/ui/deck/result-modal.ts";
import { mountReplayControls } from "../../../web/src/replay-controls.ts";
import type { Recording } from "../../../web/src/recording.ts";
import type { ReplayEvent } from "../../../web/src/replay-events.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import type { LiveMatch, Recording as MatchRecording, WaitingAgent, WaitingLobby } from "../../../web/src/matches-page/data.ts";
import { dom, ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** The page's tokens (web/index.html's :root) and the stylesheets the match view bundles. */
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
const STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "replay-marks.css"].map(path => read(`../../../web/src/${path}`))].join("\n");
/** The Matches page's stylesheets, as its pages bundle them (pages/chrome.ts, pages/top-bar.ts, colony-palette.ts). */
const PAGE_STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "pages/top-bar.css", "design-system/tokens.css", "design-system/page-edge.css", "pages/archive.css"].map(path => read(`../../../web/src/${path}`))].join("\n");
const COLOURS = SUPERCOLONY_NAMES.map(n => n.colour);
/** Each colour as colony 0 and as colony 1, and as the winner, in pairs a match can draw. */
const PAIRS: ColonyNamePair[] = [
  ["Sweetwater Colony", "Lake Skinner Colony"], ["Lake Skinner Colony", "Sweetwater Colony"],
  ["Lake Hodges Colony", "Very Large Colony"], ["Lake Hodges Colony", "Sweetwater Colony"], ["Very Large Colony", "Lake Skinner Colony"],
];
const TICK = 4000;
const queen = (colony: 0 | 1, tile: number, lost: boolean): StreamQueen => ({ id: 0, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick: lost ? TICK - 30 : null, overrun: 0, hp: lost ? 0 : 40000 });
const agent = (colony: 0 | 1, name: string): StreamAgent => ({ identity: { displayName: name, elo: 1500 }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" });

/** A match named `names` (undefined: rated): an overrun on colony 1's queen under way, colony 1 fallen, or `winner` won. */
function frameOf(names: ColonyNamePair | undefined, moment: "event" | "fall" | { winner: 0 | 1 }): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100 + 60_000; f.match = 1;
  f.ensure(0); f.count = 0;
  const won = typeof moment === "object" ? moment.winner : null;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: names === undefined, rules: "redesign", ...(names ? { colonyNames: names } : {}) },
    queens: [queen(0, 8, won === 1), queen(1, 50, moment === "fall" || won === 0)],
    territory: new Uint8Array(0), held: [520, 480], marks: [], agents: [agent(0, "fennec"), agent(1, "tidewater")],
    overrun: [0, 0], overrunRequired: 100, deaths: [3, 5],
    result: won === null ? null : { winner: won, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK, nextStartMs: null },
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 5, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 5, nextHatchTick: TICK + 10, nextCost: 3 }],
  };
  f.board = b;
  f.story = [{ id: 1, kind: "overrun", queenId: 0, tick: TICK - 20, colony: won ?? 0, agent: -1, x: 50, y: 20 }];
  return f;
}

/** Marks for each colony alone, and a group naming both. */
const EVENTS: ReplayEvent[] = [
  { kind: "fight", tick: 1338, ms: 133_800, colony: null },
  { kind: "food", tick: 2050, ms: 205_000, colony: 0 },
  { kind: "food", tick: 4000, ms: 400_000, colony: 1 },
  { kind: "nest", tick: 7204, ms: 720_400, colony: 1 },
  { kind: "nest", tick: 7275, ms: 727_500, colony: 0 },
];

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
type Surface = "2d" | "3d" | "result" | "replay";

/** One surface mounted on the test port for one match and moment; the page root as the palette sets it, and the markup. */
function mounted(names: ColonyNamePair | undefined, surface: Surface, moment: "event" | "fall" | "label0" | "label1" | "list" | { winner: 0 | 1 }) {
  const port = dom({ search: "" });
  setMatchColonies(names ?? COLONY_NAMES, port.doc);
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  if (surface === "result") {
    const modal = mountResultModal(port.doc);
    host.append(modal.dialog as unknown as ElementPort);
    modal.update(frameOf(names, moment as { winner: 0 | 1 }));
  } else if (surface === "replay") {
    // The port has no layout: the controls read their sizes' fallbacks.
    Object.assign(port.win, { getComputedStyle: () => ({ getPropertyValue: () => "" }) });
    Object.assign(port.doc, { createTextNode: (text: string) => Object.assign(new ElementPort("#text"), { textContent: text }) });
    const recording = { rate: 1, duration: 784_100, position: 0, error: null, durationError: null, seeking: false, events: null as ReplayEvent[] | null, setRate() {}, seek() {} };
    const controls = mountReplayControls(port.doc, recording as unknown as Recording, names ?? COLONY_NAMES);
    const el = controls.el as unknown as ElementPort & Record<string, unknown>;
    // The row's layout as the 3D deck's desktop row measures it.
    Object.assign(el.children[1]!, { offsetLeft: 111.4, offsetTop: 4, offsetWidth: 230.4, offsetHeight: 28 });
    Object.assign(el, { clientWidth: 419.7, offsetWidth: 419.7 });
    // The marks are read once the row has its size, so they are laid out on it.
    recording.events = EVENTS;
    controls.update();
    const marks = el.byClass("aw-mark") as (ElementPort & { onfocus?: () => void; onclick?: (e: { detail: number }) => void })[];
    if (moment === "list") marks.find(b => b.classes().includes("group"))!.onclick!({ detail: 0 });
    else marks.find(b => b.classes().includes(moment === "label0" ? "c0" : "c1") && !b.classes().includes("group"))!.onfocus!();
    const row = port.doc.createElement("div") as unknown as ElementPort;
    row.className = "d2";
    row.style.setProperty("inset", "auto 24px 24px 24px");
    row.style.setProperty("height", "36px");
    row.append(el);
    host.append(row);
  } else {
    const hud = (surface === "3d" ? mountDeckHud : mountHud)({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
    hud.update({ frame: frameOf(names, moment as "event" | "fall"), connection: "live", board: surface, selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
  }
  const html = port.html as ElementPort;
  const style = [...(html.style as unknown as { properties: Map<string, [string, string]> }).properties].map(([k, [v]]) => `${k}: ${v}`).join("; ");
  const attrs = Object.entries(html.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return { ground: html.attrs["data-aw-ground"] ?? null, page: `<!doctype html><html${attrs} style="${style}"><head><style>${STYLES}</style></head><body><div class="aw-hud">${markup(host)}</div></body></html>` };
}

/** In the page: every visible text drawn in one of the colony colours, tagged, with its line boxes cut to what shows. */
function findTexts(colours: string[]) {
  const out: { i: number; text: string; rgb: string; opacity: number; interactive: boolean; background: string; shadow: string; badge: boolean; head: boolean; rects: { x: number; y: number; w: number; h: number }[] }[] = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let i = 0;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent?.trim()) continue;
    const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(getComputedStyle(el).color);
    if (!m || !colours.includes(`${m[1]},${m[2]},${m[3]}`)) continue;
    // A rating badge is in the site's cyan, which is Lake Hodges' colour but no colony's text (deck.css .d1-elo).
    if (el.closest(".d1-elo")) continue;
    // Screen-reader-only text (a 1px clipped box) is not shown.
    const own = el.getBoundingClientRect(), ownStyle = getComputedStyle(el);
    if (own.width <= 1 || own.height <= 1 || ownStyle.clip === "rect(0px, 0px, 0px, 0px)" || ownStyle.clipPath === "inset(50%)") continue;
    let opacity = m[4] === undefined ? 1 : Number(m[4]), shown = true;
    let cl = 0, ct = 0, cr = innerWidth, cb = innerHeight;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      opacity *= Number(s.opacity);
      if (s.display === "none" || s.visibility === "hidden") shown = false;
      if ((s.overflowX !== "visible" || s.overflowY !== "visible")) { const b = e.getBoundingClientRect(); cl = Math.max(cl, b.left); ct = Math.max(ct, b.top); cr = Math.min(cr, b.right); cb = Math.min(cb, b.bottom); }
    }
    if (!shown || opacity === 0) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].map(q => ({ l: Math.max(q.left, cl), t: Math.max(q.top, ct), r: Math.min(q.right, cr), b: Math.min(q.bottom, cb) }))
      .map(q => ({ x: Math.ceil(q.l), y: Math.ceil(q.t), w: Math.floor(q.r) - Math.ceil(q.l), h: Math.floor(q.b) - Math.ceil(q.t) })).filter(q => q.w > 0 && q.h > 0);
    if (rects.length === 0) continue;
    const interactive = el.closest("button,a[href],[role=button],.aw-mark-row");
    interactive?.setAttribute("data-ct", String(i));
    out.push({ i, text: n.textContent.trim(), rgb: `${m[1]},${m[2]},${m[3]}`, opacity, interactive: !!interactive, background: ownStyle.backgroundColor, shadow: ownStyle.boxShadow, badge: el.matches(".d1p-result-tag"), head: !!el.closest(".d1p-rec-head"), rects });
    i++;
  }
  return out;
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

/** The same labels and figures at rest and in each containing control's hover/focus state. */
async function measured(page: string, width: number, height = 800) {
  const tab = await browser.newPage({ viewport: { width, height } });
  const colours = COLOURS.map(c => [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(","));
  try {
    await tab.setContent(page);
    const texts = await tab.evaluate(findTexts, colours);
    const rows = texts.map(t => ({ ...t, state: "rest" }));
    const cdp = await tab.context().newCDPSession(tab);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    for (const t of texts.filter(t => t.interactive)) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-ct="${t.i}"]` });
      for (const [state, forced] of [["hover", ["hover"]], ["focus-visible", ["focus", "focus-visible"]]] as const) {
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...forced] });
        rows.push(...(await tab.evaluate(findTexts, colours)).map(row => ({ ...row, state })));
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      }
    }
    return rows;
  } finally { await tab.close(); }
}

function expectNoBacking(rows: Awaited<ReturnType<typeof measured>>) {
  expect(rows.length, "coloured text is shown").toBeGreaterThan(0);
  for (const row of rows) {
    const where = `${row.text} (${row.rgb}, ${row.state})`;
    expect(row.background, where).toBe(row.badge ? "rgb(41, 51, 55)" : "rgba(0, 0, 0, 0)");
    expect(row.shadow, where).toBe("none");
  }
}

/** The result uses a colony-coloured banner, not colony-coloured heading text. */
async function expectVictoryBanner(page: string, width: number, winnerName: string) {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await tab.setContent(page);
    const banner = await tab.locator(".d1-result-top").evaluate(el => {
      const head = el.querySelector<HTMLElement>(".d1-result-head")!;
      const name = head.querySelector<HTMLElement>(".rd-winner-name")!;
      const outcome = head.querySelector<HTMLElement>(".rd-outcome")!;
      return {
        background: getComputedStyle(el).backgroundColor,
        name: name.textContent, outcome: outcome.textContent, label: head.getAttribute("aria-label"),
        textStyles: [head, name, outcome].map(text => {
          const style = getComputedStyle(text), rect = text.getBoundingClientRect();
          return { colour: style.color, background: style.backgroundColor, shadow: style.boxShadow,
            visible: rect.width > 0 && rect.height > 0 && style.visibility === "visible" };
        }),
      };
    });
    const colour = SUPERCOLONY_NAMES.find(colony => colony.label === winnerName)!.colour;
    expect(banner.background).toBe(`rgb(${(colour >> 16) & 255}, ${(colour >> 8) & 255}, ${colour & 255})`);
    expect(banner.name).toBe(winnerName.replace(/ Colony$/, ""));
    expect(banner.outcome).toBe("wins");
    expect(banner.label).toBe(`${winnerName} wins`);
    for (const text of banner.textStyles) {
      expect(text.visible).toBe(true);
      expect(text.colour).toBe("rgb(16, 33, 38)");
      expect(text.background).toBe("rgba(0, 0, 0, 0)");
      expect(text.shadow).toBe("none");
    }
  } finally { await tab.close(); }
}

const MOMENTS = [
  ["2d", "event"], ["2d", "fall"], ["3d", "event"], ["3d", "fall"], ["result", { winner: 0 }], ["result", { winner: 1 }],
  ["replay", "label0"], ["replay", "label1"], ["replay", "list"],
] as const;
const name = (m: unknown) => typeof m === "object" ? `winner ${(m as { winner: number }).winner}` : String(m);

describe("text in a colony's colour has no backing", () => {
  for (const pair of [...PAIRS, undefined]) {
    for (const [surface, moment] of MOMENTS) {
      for (const width of surface === "2d" || surface === "3d" ? [1280] : [1280, 390]) {
        it(`${pair ? pair.join(" against ") : "rated"}: ${surface} ${name(moment)} at ${width}px`, async () => {
          const { ground, page } = mounted(pair, surface, moment);
          if (surface === "result") {
            await expectVictoryBanner(page, width, (pair ?? COLONY_NAMES)[moment.winner]);
          } else {
            const rows = await measured(page, width);
            expect(rows.length, "coloured text is shown").toBeGreaterThan(0);
            expectNoBacking(rows);
          }
          expect(ground, "no match draws a text backing").toBeNull();
        });
      }
    }
  }

  // A four-colony match's result: each colony as the winner, its name in the heading and in the moment.
  const FOUR = SUPERCOLONY_NAMES.map(n => n.label);
  const fourColonyResult = (winner: number) => {
    const port = dom({ search: "" });
    setMatchColonies(FOUR, port.doc);
    const host = port.doc.createElement("div") as unknown as ElementPort;
    port.body.append(host);
    const f = frameOf(undefined, { winner: 0 });
    const b = f.board!;
    b.setup = { ...b.setup, rated: false, colonyNames: FOUR, queens: [[8, 8], [56, 8], [8, 40], [56, 40]].map(([x, y]) => [x! * SUB_TILE, y! * SUB_TILE]) } as unknown as Board["setup"];
    b.result = { winner, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK, nextStartMs: null } as unknown as Board["result"];
    f.story = [{ id: 1, kind: "overrun", queenId: 0, tick: TICK - 20, colony: winner, agent: -1, x: 50, y: 20 }];
    const modal = mountResultModal(port.doc);
    host.append(modal.dialog as unknown as ElementPort);
    modal.update(f);
    const html = port.html as ElementPort;
    const style = [...(html.style as unknown as { properties: Map<string, [string, string]> }).properties].map(([k, [v]]) => `${k}: ${v}`).join("; ");
    const attrs = Object.entries(html.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    return { ground: html.attrs["data-aw-ground"] ?? null, page: `<!doctype html><html${attrs} style="${style}"><head><style>${STYLES}</style></head><body><div class="aw-hud">${markup(host)}</div></body></html>` };
  };
  for (const winner of [0, 1, 2, 3]) {
    for (const width of [1280, 390]) {
      it(`a four-colony match: result, ${FOUR[winner]} wins, at ${width}px`, async () => {
        const { ground, page } = fourColonyResult(winner);
        await expectVictoryBanner(page, width, FOUR[winner]!);
        expect(ground).toBeNull();
      });
    }
  }

  it("never adds a backing for any drawn pair or the rated colours", () => {
    const grounds = PAIRS.map(pair => mounted(pair, "result", { winner: 0 }).ground);
    expect(grounds).toEqual(PAIRS.map(() => null));
    expect(mounted(undefined, "result", { winner: 0 }).ground).toBeNull();
  });
});

/** The Matches page with one row of each list naming `names` (undefined: rated rows), the recordings won by each colony. */
function matchesPage(names: ColonyNamePair | undefined) {
  const port = dom({ search: "" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const own = names ? { colonyNames: [names[0], names[1]] as [string, string] } : {};
  const seats = [{ seat: 0, colony: 0 as const, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "alice" }, { seat: 1, colony: 1 as const, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "bob" }];
  const recording = (id: string, winner: 0 | 1): MatchRecording => ({ id, startedAt: "2026-10-27T09:00:00.000Z", endedAt: null, simulationEndedAt: null, winner,
    reason: "queens_killed", decidedBy: null, seats, status: "complete", unavailable: [], ...own });
  const live: LiveMatch = { lobbyId: "lobby-u", startedAt: Date.parse("2026-10-27T10:00:00Z"), rated: !names, delaySeconds: 60,
    colonies: [[{ displayName: "fennec", rating: 1500, rd: 90, ratedMatches: 3 }], [{ displayName: "tidewater", rating: 1482, rd: 70, ratedMatches: 20 }]], ...own };
  const waiting: WaitingLobby = { mode: null, size: 1, seated: 1, colonies: [["sugar-ant"], []], waitingSeconds: 30, since: Date.parse("2026-11-11T05:02:00Z"), ...own };
  const mounted = mountMatches(port.doc as unknown as Document, host as unknown as HTMLElement, { refresh() {}, more() {} });
  mounted.update({ waiting: { status: "ready", rows: [waiting] }, live: { status: "ready", rows: [live] },
    recordings: { status: "ready", rows: [recording("2026-10-27T09-00-00-000Z-1", 0), recording("2026-10-27T09-00-00-000Z-2", 1)] }, next: null });
  const body = markup(host);
  mounted.destroy();
  return { body, page: `<!doctype html><html><head><style>${PAGE_STYLES}</style></head><body>${body}</body></html>` };
}

/** The Matches page with a live four-colony (Quadrants) row and one recording won by each of its four colonies. */
/** The widest player line in the stored public recordings, as the snapshot stores its seat (a builder on its model at max,
 * one seat, its start rating): the Matches page's tightest line. */
const WIDEST_STORED_SEAT = { modelLabel: "muse/muse-wonder-1.0", thinkingLevel: "max", serviceTier: null, handle: "kain",
  startRating: { rating: 1662.2120026057648, rd: 290.2305060910912, ratedMatches: 1 } } as const;

function quadrantsPage(thinkingLevel: string | null = null, longName?: string, perColony?: number, stored?: typeof WIDEST_STORED_SEAT) {
  const port = dom({ search: "" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const names = SUPERCOLONY_NAMES.map(n => n.label) as [string, string, string, string];
  const handles = longName ? Array<string>(4).fill(longName) : ["alice", "bob", "cat", "dan"];
  const seats = stored ? ([0, 1, 2, 3] as const).map(colony => ({ seat: colony, colony, ...stored }))
    : handles.flatMap((handle, colony) => Array.from({ length: perColony ?? (thinkingLevel === null ? 1 : 2) }, (_, index) => ({
    seat: colony * 2 + index, colony: colony as 0 | 1 | 2 | 3, modelLabel: thinkingLevel === null ? null : "openai/gpt-6.1-terra",
    thinkingLevel, serviceTier: thinkingLevel === null ? null : "fast", handle,
    ...(thinkingLevel === null ? {} : { startRating: { rating: 1500, rd: 80, ratedMatches: 12 } }),
  })));
  const recording = (winner: 0 | 1 | 2 | 3): MatchRecording => ({ id: `2026-11-14T09-00-00-000Z-${winner}`, startedAt: "2026-11-14T09:00:00.000Z", endedAt: null,
    simulationEndedAt: null, winner, reason: "queens_killed", decidedBy: null, seats, status: "complete", unavailable: [], matchType: { kind: "quadrants", size: 1 }, colonyNames: names });
  const live: LiveMatch = { lobbyId: "lobby-q", startedAt: Date.parse("2026-11-14T10:00:00Z"), rated: false, delaySeconds: 60, matchType: { kind: "quadrants", size: 1 },
    colonies: [[{ displayName: "fennec", rating: null, rd: null, ratedMatches: null }], [{ displayName: "tidewater", rating: null, rd: null, ratedMatches: null }],
      [{ displayName: "sugar-ant", rating: null, rd: null, ratedMatches: null }], [{ displayName: "kite", rating: null, rd: null, ratedMatches: null }]], colonyNames: names };
  const mounted = mountMatches(port.doc as unknown as Document, host as unknown as HTMLElement, { refresh() {}, more() {} });
  mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [live] },
    recordings: { status: "ready", rows: ([0, 1, 2, 3] as const).map(recording) }, next: null });
  const body = markup(host);
  mounted.destroy();
  return { body, page: `<!doctype html><html><head><style>${PAGE_STYLES}</style></head><body>${body}</body></html>` };
}

describe("Recordings keep other stored colony names outside canonical columns", () => {
  for (const width of [1280, 390]) {
    for (const names of [["Historical Colony", "Very Large Colony"], ["H".repeat(64), "Other Historical Colony"]] as const) {
      it(`keeps supplemental names and players clear of the canonical slots and metadata at ${width}px: ${names[0]}`, async () => {
        const tab = await browser.newPage({ viewport: { width, height: 2400 } });
        try {
          await tab.setContent(matchesPage(names).page);
          await tab.addStyleTag({ content: 'html, body { margin: 0; }' });
          const rows = await tab.locator(".d1p-rec-rows > li").evaluateAll(nodes => nodes.map(row => {
            const extra = row.querySelector(".d1p-rec-extra")!;
            const rect = (node: Element) => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
            const bounds = rect(extra);
            // On a wide card the shared head row's headings; on a narrow one, where it hides, each slot's own label.
            const heading = row.closest(".d1p-rec4")!.querySelector(".d1p-rec-head .d1p-rec-colony")!;
            const shown = getComputedStyle(row.closest(".d1p-rec4")!.querySelector(".d1p-rec-head")!).display !== "none";
            const style = shown ? getComputedStyle(heading) : getComputedStyle(row.querySelector(".d1p-rec-slot[data-colony]")!, "::before");
            return { bounds, canonical: [...row.querySelectorAll(":scope > .d1p-rec-slot")].map(slot => ({ ...rect(slot), empty: slot.classList.contains("is-none") })),
              meta: rect(row.querySelector(".d1p-rec-meta")!), replay: rect(row.querySelector(".d1p-rec-replay")!),
              labels: [...extra.querySelectorAll(".d1p-rec-colony")].map(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const s = getComputedStyle(node);
                return { text: node.textContent, title: node.getAttribute("title"), box: rect(node),
                  accessibleName: node.parentElement!.querySelector(".d1p-sr")!.textContent,
                  lines: new Set([...range.getClientRects()].map(b => b.top)).size,
                  clipped: node.scrollWidth > node.clientWidth, whiteSpace: s.whiteSpace, overflow: s.overflowX, textOverflow: s.textOverflow,
                  size: s.fontSize, weight: s.fontWeight, expectedSize: style.fontSize, expectedWeight: style.fontWeight, background: s.backgroundColor };
              }),
              players: [...extra.querySelectorAll(".d1p-rec-player")].map(node => rect(node)),
              labelInk: [...extra.querySelectorAll(".d1p-rec-colony")].map(node => getComputedStyle(node).color),
              quiet: getComputedStyle(row.querySelector(".d1p-rec-time")!).color,
            };
          }));
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(row.canonical).toHaveLength(4);
            expect(row.canonical.filter(slot => !slot.empty)).toHaveLength(names[1] === "Very Large Colony" ? 1 : 0);
            expect(row.labels).toHaveLength(names[1] === "Very Large Colony" ? 1 : 2);
            for (const label of row.labels) {
              expect(names).toContain(label.title);
              // A supplemental colony's label takes the colony labels' size and weight, in the neutral quiet ink.
              expect(label.size).toBe(label.expectedSize);
              expect(label.weight).toBe(label.expectedWeight);
              expect(label.background).toBe("rgba(0, 0, 0, 0)");
              // Never cut: a stored name too long for its line breaks rather than ends in an ellipsis or widens the page.
              expect(label.lines).toBe(label.title === "H".repeat(64) ? label.lines : 1);
              expect(label.overflow).toBe("visible");
              expect(label.textOverflow).not.toBe("ellipsis");
              expect(label.clipped).toBe(false);
              expect(label.accessibleName).toBe(`${label.title}: `);
              expect(label.text).toBe(label.title!.replace(/ Colony$/, ""));
              expect(label.box.left).toBeGreaterThanOrEqual(row.bounds.left);
              expect(label.box.right).toBeLessThanOrEqual(row.bounds.right);
            }
            for (const player of row.players) {
              expect(player.left).toBeGreaterThanOrEqual(row.bounds.left);
              expect(player.right).toBeLessThanOrEqual(row.bounds.right);
            }
            for (const ink of row.labelInk) expect(ink).toBe(row.quiet);
            expect(row.bounds.top).toBeGreaterThanOrEqual(Math.max(...row.canonical.map(slot => slot.bottom)));
            if (width === 390) {
              expect(row.meta.top).toBeGreaterThanOrEqual(row.bounds.bottom);
              expect(row.replay.top).toBeGreaterThanOrEqual(row.bounds.bottom);
            }
          }
          expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        } finally { await tab.close(); }
      });
    }
  }
});

describe("Recordings contain a self-reported thinking level", () => {
  const longLevel = "m".repeat(32);
  for (const width of [1280, 390]) {
    it(`bounds a 32-character level with seats and rating at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(quadrantsPage(longLevel).page);
        await tab.addStyleTag({ content: "html, body { margin: 0; }" });
        const rows = await tab.locator(".d1p-rec-player > .d1p-tags").evaluateAll(nodes => nodes.map(node => {
          const slot = node.closest(".d1p-rec-slot")!.getBoundingClientRect();
          const style = getComputedStyle(node);
          const line = node.closest(".d1p-rec-player")!;
          return { text: [...node.children].map(tag => tag.textContent).join(" "), title: node.getAttribute("title"), clipped: node.scrollWidth > node.clientWidth,
            overflow: style.overflowX,
            count: line.querySelector(".d1p-count")?.textContent, rating: line.querySelector(".d1p-elo-badge")?.textContent,
            children: [...line.children].map(child => { const box = child.getBoundingClientRect();
              return { text: child.textContent, leftInset: box.left - slot.left, rightInset: slot.right - box.right }; }) };
        }));
        expect(rows).toHaveLength(16);
        for (const row of rows) {
          // One badge: the level with Fast as its bolt, read in full.
          expect(row.text).toBe(`${longLevel} Fast`);
          expect(row.title).toBe(`${longLevel} Fast`);
          // Past what any real level needs, the chip stops at 12em, clipped, its whole text its title; the count and the
          // rating stay whole inside the cell.
          expect(row.clipped).toBe(true);
          expect(row.overflow).toBe("hidden");
          expect(row.count).toContain("×2");
          expect(row.rating).toContain("1500");
          for (const child of row.children) {
            expect(child.leftInset, child.text!).toBeGreaterThanOrEqual(0);
            expect(child.rightInset, child.text!).toBeGreaterThanOrEqual(0);
          }
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      } finally { await tab.close(); }
    });
  }
});

/** Each Matches player line (Recordings, Waiting, Live now) as drawn: how many lines its visible text and badges take,
 * whether its name ends in its ellipsis, and whether it stands inside its slot or cell. */
const PLAYER_LINES = () => [...document.querySelectorAll(".d1p-rec-player, .d1p-model")].filter(node => node.checkVisibility()).map(node => {
  const boxes: DOMRect[] = [];
  const walk = (parent: Node) => { for (const child of parent.childNodes) {
    if (child.nodeType === 3) { if (!child.textContent!.trim()) continue; const range = document.createRange(); range.selectNodeContents(child); boxes.push(...[...range.getClientRects()].filter(box => box.width > 0.5)); }
    else if (child instanceof Element) { if (child.matches(".d1p-sr, .d1p-elo-rd") || !child.checkVisibility()) continue; if (child.matches(".d1p-tag, .d1-tag, .d1p-bolt")) boxes.push(child.getBoundingClientRect()); walk(child); }
  } };
  walk(node);
  const centres = boxes.map(box => (box.top + box.bottom) / 2).sort((a, b) => a - b);
  let lines = 0, last = -Infinity;
  for (const centre of centres) { if (centre - last > 6) lines++; last = centre; }
  const name = node.querySelector(":scope > .d1p-rec-name, :scope > :first-child")!;
  const holder = (node.closest(".d1p-rec-slot") ?? node.parentElement!).getBoundingClientRect(), own = node.getBoundingClientRect();
  return { text: `${node.textContent!.replace(/\s+/g, " ").trim()} (name ${name.scrollWidth}/${name.clientWidth}, line ${Math.round(node.getBoundingClientRect().width)})`, lines, nameCut: name.scrollWidth > name.clientWidth + 1,
    inside: own.left >= holder.left - 0.5 && own.right <= holder.right + 0.5,
    title: name.getAttribute("title"), nameStyle: [getComputedStyle(name).whiteSpace, getComputedStyle(name).overflowX, getComputedStyle(name).textOverflow] };
});

/** Every colony cell's padding and its player lines' spacing: a Recordings slot, a table's colony cell, or a stacked row's
 * colonies (whose edges are its row's). Painted content is text runs and badge boxes, screen-reader text left out. */
const CELL_SPACING = () => {
  const shown = (node: Element) => node.checkVisibility() && !node.closest(".d1p-sr, .d1p-elo-rd, .d1p-colony-tail");
  const boxesOf = (root: Element) => { const out: { left: number; right: number }[] = [];
    const walk = (parent: Node) => { for (const child of parent.childNodes) {
      if (child.nodeType === 3) { if (!child.textContent!.trim() || !shown(child.parentElement!)) continue; const range = document.createRange(); range.selectNodeContents(child); out.push(...[...range.getClientRects()].filter(box => box.width > 0.5)); }
      else if (child.nodeType === 1 && shown(child as Element)) { if ((child as Element).matches(".d1p-tag, .d1-tag, .d1p-elo-badge")) out.push((child as Element).getBoundingClientRect()); walk(child); } } };
    walk(root); return out; };
  const gap = parseFloat(getComputedStyle(document.querySelector(".d1p-card")!).getPropertyValue("--d1p-cell-gap"));
  const cells = [...document.querySelectorAll(".d1p-rec-slot, td.c-model, .d1p-match-rows .d1p-colonies")].filter(node => node.checkVisibility()).flatMap(node => {
    const edge = node.matches(".d1p-colonies") ? node.closest("li")! : node, box = edge.getBoundingClientRect(), style = getComputedStyle(edge);
    const content = boxesOf(node); if (content.length === 0) return [];
    return [{ text: node.textContent!.replace(/\s+/g, " ").trim(), padLeft: parseFloat(style.paddingLeft), padRight: parseFloat(style.paddingRight),
      left: Math.min(...content.map(b => b.left)) - box.left, right: box.right - Math.max(...content.map(b => b.right)) }];
  });
  const lines = [...document.querySelectorAll(".d1p-rec-player, .d1p-model")].filter(shown).map(line => {
    const parts = [...line.querySelectorAll(".d1p-rec-name, .d1p-name, .d1p-tag, .d1p-count, .d1p-elo-badge")].filter(part => shown(part) && !part.parentElement!.closest(".d1p-tag, .d1p-elo-badge"))
      .map(part => { const boxes = part.matches(".d1p-rec-name, .d1p-name, .d1p-count") ? boxesOf(part) : [part.getBoundingClientRect()];
        return { left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)) }; })
      .filter(part => Number.isFinite(part.left)).sort((a, b) => a.left - b.left);
    // A Recordings line spaces its parts by the design system's inline gap; Live now and Waiting by their cell gap.
    const between = line.matches(".d1p-rec-player") ? parseFloat(getComputedStyle(line).columnGap) : gap;
    return { text: line.textContent!.replace(/\s+/g, " ").trim(), between, gaps: parts.slice(1).map((part, i) => part.left - parts[i]!.right) };
  });
  // On a wide card, the last slot (a winner's band, or its text) and the Replay link stand at least 16 px apart.
  const wide = (row: Element) => getComputedStyle(row.closest(".d1p-rec-table")!.querySelector(".d1p-rec-head")!).display !== "none";
  const replay = [...document.querySelectorAll(".d1p-rec-rows > li")].filter(row => row.checkVisibility() && wide(row)).map(row => {
    const slot = [...row.querySelectorAll(":scope > .d1p-rec-slot")].at(-1)!, link = row.querySelector(".d1p-rec-replay")!;
    const right = slot.matches(".is-won") ? slot.getBoundingClientRect().right : Math.max(...boxesOf(slot).map(b => b.right));
    const range = document.createRange(); range.selectNodeContents(link);
    return range.getBoundingClientRect().left - right;
  });
  return { gap, cells, lines, replay };
};

describe("every Matches colony cell keeps one padding on both sides", () => {
  for (const width of [1280, 390]) {
    it(`pads each cell alike on its left and right, and spaces every part of a line by one gap, at ${width}px`, async () => {
      for (const page of [quadrantsPage(null, undefined, 1, WIDEST_STORED_SEAT).page, matchesPage(undefined).page]) {
        const tab = await browser.newPage({ viewport: { width, height: 2400 } });
        try {
          await tab.setContent(page);
          await tab.addStyleTag({ content: 'html, body { margin: 0; } * { font-family: "Liberation Sans", sans-serif !important; }' });
          await tab.evaluate(() => document.fonts.ready);
          const { gap, cells, lines, replay } = await tab.evaluate(CELL_SPACING);
          expect(gap).toBeGreaterThan(4);
          expect(cells.length).toBeGreaterThan(0);
          for (const cell of cells) {
            expect(cell.padLeft, cell.text).toBe(cell.padRight);
            expect(cell.left, cell.text).toBeGreaterThanOrEqual(cell.padLeft - 0.5);
            expect(cell.right, cell.text).toBeGreaterThanOrEqual(cell.padRight - 0.5);
          }
          expect(lines.length).toBeGreaterThan(0);
          for (const line of lines) for (const between of line.gaps) expect(between, line.text).toBeCloseTo(line.between, 0);
          for (const clear of replay) expect(clear).toBeGreaterThanOrEqual(15.5);
        } finally { await tab.close(); }
      }
    });
  }
});

describe("every Matches player is one line", () => {
  for (const width of [1280, 390]) {
    it(`keeps the widest stored player's username, model, level and rating on one line, uncut, at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        // The widest real player on the public list, as stored, in every colony of a four-colony match (the narrowest
        // columns, Lake Skinner listed); in the face that sets it widest.
        await tab.setContent(quadrantsPage(null, undefined, 1, WIDEST_STORED_SEAT).page);
        await tab.addStyleTag({ content: 'html, body { margin: 0; } * { font-family: "Liberation Sans", sans-serif !important; }' });
        await tab.evaluate(() => document.fonts.ready);
        const lines = await tab.evaluate(PLAYER_LINES);
        // Four recordings, the stored seat in each colony.
        expect(lines.filter(line => line.text.startsWith("kain Muse Wonder 1.0"))).toHaveLength(16);
        for (const line of lines) {
          expect(line.lines, line.text).toBe(1);
          expect(line.nameCut, line.text).toBe(false);
          expect(line.inside, line.text).toBe(true);
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      } finally { await tab.close(); }
    });

    it(`gives way only in the name, past any real length, on one line, keeping its text whole for hover and screen readers, at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(quadrantsPage("m".repeat(32), "long-builder-" + "x".repeat(64)).page);
        await tab.addStyleTag({ content: "html, body { margin: 0; }" });
        const lines = (await tab.evaluate(PLAYER_LINES)).filter(line => line.text.startsWith("long-builder-"));
        expect(lines).toHaveLength(16);
        for (const line of lines) {
          expect(line.lines, line.text).toBe(1);
          expect(line.nameCut).toBe(true);
          expect(line.nameStyle).toEqual(["nowrap", "hidden", "ellipsis"]);
          expect(line.title).toContain("long-builder-" + "x".repeat(64));
          expect(line.inside).toBe(true);
        }
        for (const name of await tab.locator(".d1p-rec-name").all()) expect(await name.ariaSnapshot()).toContain("long-builder-" + "x".repeat(64));
        expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      } finally { await tab.close(); }
    });
  }
});

describe("the Fast bolt shows in forced colours", () => {
  for (const width of [1280, 390]) {
    it(`fills every shown bolt in its badge's text colour, not its background, at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(quadrantsPage("max", "CedarGrove", 1).page);
        await tab.emulateMedia({ forcedColors: "active" });
        const bolts = await tab.evaluate(() => [...document.querySelectorAll<HTMLElement>(".d1p-bolt")].filter(bolt => bolt.checkVisibility()).map(bolt => {
          const badge = getComputedStyle(bolt.closest(".d1p-tag")!), rect = bolt.getBoundingClientRect();
          return { fill: getComputedStyle(bolt).backgroundColor, ink: badge.color, ground: badge.backgroundColor, size: rect.width * rect.height };
        }));
        expect(bolts.length, "bolts are shown").toBeGreaterThan(0);
        for (const bolt of bolts) {
          expect(bolt.size).toBeGreaterThan(0);
          expect(bolt.fill).toBe(bolt.ink);
          expect(bolt.fill).not.toBe(bolt.ground);
        }
      } finally { await tab.close(); }
    });
  }
});

describe("Recordings colony headings stay inside their columns", () => {
  for (const width of [1280]) {
    it(`keeps complete one-line headings within each slot at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 }, deviceScaleFactor: 3 });
      try {
        await tab.setContent(quadrantsPage().page);
        // Match index.html's margin reset; otherwise the browser's body margin narrows every slot.
        // Use the wider desktop stand-in face; both target fonts are also checked in the capture matrix.
        await tab.addStyleTag({ content: 'html, body { margin: 0; } .d1p-rec-colony { font-family: "Liberation Sans", sans-serif; }' });
        await tab.evaluate(() => document.fonts.ready);
        const rows = await tab.locator(".d1p-rec-colony").evaluateAll(nodes => nodes.map(node => {
          const slot = node.getBoundingClientRect();
          const index = [...node.parentElement!.querySelectorAll(".d1p-rec-colony")].indexOf(node);
          const columns = [...node.closest(".d1p-rec4")!.querySelectorAll(".d1p-rec-rows > li")].map(row => {
            const box = row.querySelectorAll(".d1p-rec-slot")[index]!.getBoundingClientRect();
            return { left: box.left, right: box.right };
          });
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { text: node.textContent, width: slot.width, left: slot.left, right: slot.right, columns,
            leftInset: text.left - slot.left, rightInset: slot.right - text.right,
            lines: new Set([...range.getClientRects()].map(rect => rect.top)).size,
            size: style.fontSize, spacing: style.letterSpacing, transform: style.textTransform,
            whiteSpace: style.whiteSpace, overflow: style.overflowX, textOverflow: style.textOverflow };
        }));
        expect(rows).toHaveLength(4);
        expect(await tab.locator(".d1p-rec-rows .d1p-rec-colony").count()).toBe(0);
        expect(rows.map(row => row.text)).toEqual(SUPERCOLONY_NAMES.map(name => name.label.replace(/ Colony$/, "")));
        for (const row of rows) {
          expect(row.lines, row.text!).toBe(1);
          for (const column of row.columns) {
            expect(column.left, row.text!).toBeCloseTo(row.left, 2);
            expect(column.right, row.text!).toBeCloseTo(row.right, 2);
          }
          expect(row.leftInset, row.text!).toBeGreaterThanOrEqual(0);
          expect(row.rightInset / row.width, row.text!).toBeGreaterThanOrEqual(0.08);
          expect(row.transform).toBe("uppercase");
          expect(row.whiteSpace).toBe("nowrap");
          expect(row.overflow).toBe("visible");
          expect(row.textOverflow).not.toBe("ellipsis");
          expect(row.size).toBe("10px");
          expect(parseFloat(row.spacing)).toBeCloseTo(0.8, 2);
        }
      } finally { await tab.close(); }
    });
  }

  it("on a phone hides the shared head and gives each colony its own line, beside its column's name, whole, in the neutral ink", async () => {
    const tab = await browser.newPage({ viewport: { width: 390, height: 2400 }, deviceScaleFactor: 3 });
    try {
      await tab.setContent(quadrantsPage().page);
      await tab.addStyleTag({ content: 'html, body { margin: 0; } .d1p-rec-slot::before { font-family: "Liberation Sans", sans-serif; }' });
      await tab.evaluate(() => document.fonts.ready);
      const view = await tab.evaluate(() => ({
        head: getComputedStyle(document.querySelector(".d1p-rec-head")!).display,
        quiet: getComputedStyle(document.querySelector(".d1p-rec-time")!).color,
        rows: [...document.querySelectorAll(".d1p-rec-rows > li")].map(row => [...row.querySelectorAll(":scope > .d1p-rec-slot")].map(slot => {
          const before = getComputedStyle(slot, "::before"), box = slot.getBoundingClientRect();
          const player = slot.querySelector(".d1p-rec-player")?.getBoundingClientRect();
          // The label's column ends before the name's starts: the name stands at the slot's second track.
          const inner = box.left + parseFloat(getComputedStyle(slot).paddingLeft);
          return { label: before.content, colour: before.color, whiteSpace: before.whiteSpace, transform: before.textTransform,
            labelWidth: parseFloat(before.width), column: player ? player.left - inner : Infinity,
            overflowing: slot.scrollWidth > slot.clientWidth, left: Math.round(box.left), top: Math.round(box.top), bottom: Math.round(box.bottom),
            playerTop: player ? Math.round(player.top) : null };
        })),
      }));
      expect(view.head).toBe("none");
      expect(view.rows.length).toBeGreaterThan(0);
      for (const slots of view.rows) {
        expect(slots.map(slot => slot.label)).toEqual(SUPERCOLONY_NAMES.map(name => `"${name.label.replace(/ Colony$/, "")}"`));
        // One colony a line, in the columns' order, each line under the last.
        expect(new Set(slots.map(slot => slot.left)).size).toBe(1);
        for (let index = 1; index < slots.length; index++) expect(slots[index]!.top).toBeGreaterThanOrEqual(slots[index - 1]!.bottom);
        for (const slot of slots) {
          expect(slot.colour).toBe(view.quiet);
          expect(slot.whiteSpace).toBe("nowrap");
          expect(slot.transform).toBe("uppercase");
          expect(slot.labelWidth).toBeLessThanOrEqual(slot.column);
          expect(slot.overflowing).toBe(false);
        }
      }
      expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    } finally { await tab.close(); }
  });
});

describe("the Matches page takes the design system's narrow page edge", () => {
  // From 12em to 24.25em of viewport width the page edge is 8 px, so a 376 px phone's card is 360 px, at least 22rem: each
  // colony's label stands beside its first line, as at 390, where the edge stays 16 px.
  for (const [width, edge] of [[376, 8], [390, 16]] as const) {
    it(`sets the page edge to ${edge} px and keeps each colony label beside its first line at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(quadrantsPage().page);
        await tab.addStyleTag({ content: "html, body { margin: 0; }" });
        const view = await tab.evaluate(() => ({
          edge: document.querySelector(".d1p-main")!.getBoundingClientRect().left + parseFloat(getComputedStyle(document.querySelector(".d1p-main")!).paddingLeft),
          card: document.querySelector(".d1p-rec4")!.getBoundingClientRect(),
          slots: [...document.querySelectorAll(".d1p-rec-rows > li > .d1p-rec-slot")].map(slot => {
            const box = slot.getBoundingClientRect(), player = slot.querySelector(".d1p-rec-player")!.getBoundingClientRect();
            return { beside: player.left - box.left > parseFloat(getComputedStyle(slot, "::before").width) };
          }),
        }));
        expect(view.edge).toBe(edge);
        expect(view.card.left).toBe(edge);
        expect(view.card.width).toBe(width - 2 * edge);
        expect(view.slots.length).toBeGreaterThan(0);
        for (const slot of view.slots) expect(slot.beside).toBe(true);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      } finally { await tab.close(); }
    });
  }
});

describe("a Recordings row's date, time and type share one line on the narrowest phone", () => {
  // Every type the page can word, two and three colonies, after the widest date, in the face that sets them widest.
  const TYPES = ["Index 4v4", "Ranked 4v4", "Unranked 4v4", "Challenge 1v1", "Challenge 4v4", "Free-for-all",
    "Index 1v1v1", "Ranked 1v1v1", "Unranked 1v1v1", "Challenge 1v1v1", "Challenge 4v4v4"];
  for (const width of [320, 390]) {
    it(`keeps the widest date, its time and each type on one line at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(matchesPage(undefined).page);
        await tab.addStyleTag({ content: 'html, body { margin: 0; } * { font-family: "Liberation Sans", sans-serif !important; }' });
        await tab.evaluate(() => document.fonts.ready);
        const lines = await tab.evaluate(types => {
          const row = document.querySelector(".d1p-rec-rows > li")!;
          row.querySelector(".d1p-rec-date")!.textContent = "28 May 2026";
          row.querySelector(".d1p-rec-time")!.textContent = "00:00 UTC";
          const mode = row.querySelector(".d1p-rec-mode")
            ?? row.querySelector(".d1p-rec-type")!.appendChild(Object.assign(document.createElement("span"), { className: "d1p-rec-mode" }));
          return types.map(words => {
            mode.replaceChildren(...words.split(" ").flatMap(word => [" ", Object.assign(document.createElement("span"), { textContent: word })]));
            const parts = [...row.querySelectorAll(".d1p-rec-when > span, .d1p-rec-mode > span")];
            return { words, lines: new Set(parts.map(part => Math.round(part.getBoundingClientRect().top))).size };
          });
        }, TYPES);
        for (const line of lines) expect(line.lines, line.words).toBe(1);
      } finally { await tab.close(); }
    });
  }
});

/** The Matches page's Recordings with the widest footers the site can draw: the widest date, a three-colony Challenge
 * won by its second colony, an abandoned three-colony Unranked whose record is unavailable (both outcome words), and a
 * Challenge 1v1 draw. */
function footerPage() {
  const port = dom({ search: "" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const three = SUPERCOLONY_NAMES.slice(0, 3).map(n => n.label) as [string, string, string];
  const seat = (index: number, handle: string) => ({ seat: index, colony: index as 0 | 1 | 2, modelLabel: "muse/muse-wonder-1.0", thinkingLevel: "max",
    serviceTier: null, handle, startRating: { rating: 1662, rd: 90, ratedMatches: 12 } });
  const base = { startedAt: "2026-05-28T23:59:00.000Z", endedAt: null, simulationEndedAt: null, unavailable: [] };
  const rows: MatchRecording[] = [
    { ...base, id: "2026-05-28T23-59-00-000Z-1", winner: 1, reason: "queens_killed", decidedBy: "queens_killed", status: "complete",
      seats: [seat(0, "kain"), seat(1, "ann"), seat(2, "bob")], colonyNames: three, matchType: { kind: "challenge", size: 1 } },
    { ...base, id: "2026-05-28T23-59-00-000Z-2", winner: null, reason: "abandoned", decidedBy: null, status: "unavailable",
      seats: [seat(0, "kain"), seat(1, "ann"), seat(2, "bob")], colonyNames: three, matchType: { kind: "unranked", size: 1 } },
    { ...base, id: "2026-05-28T23-59-00-000Z-3", winner: null, reason: "time_up", decidedBy: "draw", status: "complete",
      seats: [seat(0, "kain"), seat(1, "ann")], matchType: { kind: "challenge", size: 1 } },
  ];
  const mounted = mountMatches(port.doc as unknown as Document, host as unknown as HTMLElement, { refresh() {}, more() {} });
  mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows }, next: null });
  const body = markup(host);
  mounted.destroy();
  return `<!doctype html><html><head><style>${PAGE_STYLES}</style></head><body>${body}</body></html>`;
}

/** Each Recordings row's footer and Replay, measured in the page. */
const FOOTERS = () => [...document.querySelectorAll(".d1p-rec-rows > li")].map(row => {
  const box = (el: Element) => el.getBoundingClientRect();
  const meta = row.querySelector(".d1p-rec-meta")!;
  const start = [...row.querySelectorAll(".d1p-rec-date, .d1p-rec-time, .d1p-rec-mode")].map(box);
  const notes = row.querySelector(".d1p-rec-notes");
  const noteBoxes = notes ? [...notes.querySelectorAll(".d1p-rec-note")].map(box) : [];
  const slots = [...row.querySelectorAll(":scope > .d1p-rec-slot")].filter(slot => slot.checkVisibility());
  const first = slots[0]!;
  const replay = box(row.querySelector(".d1p-rec-replay")!);
  const texts = slots.flatMap(slot => [...slot.querySelectorAll(".d1p-rec-player")].map(box));
  const won = row.querySelector(".d1p-rec-slot.is-won");
  const band = won ? (() => { const after = getComputedStyle(won, "::after"); const b = box(won);
    return after.content === "none" ? b : { top: b.top + parseFloat(after.top), bottom: b.bottom }; })() : null;
  const label = won ? { top: box(won).top + parseFloat(getComputedStyle(won).paddingTop), height: parseFloat(getComputedStyle(won, "::before").lineHeight) } : null;
  const link = row.querySelector(".d1p-rec-replay")!;
  const inner = box(first).right - parseFloat(getComputedStyle(first).paddingRight);
  return {
    startLines: new Set(start.map(b => Math.round(b.top))).size, startTop: start[0]!.top, startLeft: start[0]!.left,
    metaRight: box(meta).right - parseFloat(getComputedStyle(meta).paddingRight), startRight: Math.max(...start.map(b => b.right)),
    notes: noteBoxes.length ? { lines: new Set(noteBoxes.map(b => Math.round(b.top))).size, top: noteBoxes[0]!.top, left: noteBoxes[0]!.left } : null,
    replay: { top: replay.top, bottom: replay.bottom, right: replay.right, pinned: getComputedStyle(link).position === "absolute" }, inner,
    labelLineTop: box(first).top + parseFloat(getComputedStyle(first).paddingTop), metaBottom: box(meta).bottom,
    overlapsLine: texts.some(t => t.right > replay.left && t.left < replay.right && t.bottom > replay.top && t.top < replay.bottom),
    band, label,
  };
});

describe("a Recordings row's footer on a phone", () => {
  for (const width of [320, 360, 390]) {
    it(`keeps date, time and type on one line, puts the outcome words on their own line under it, and places Replay at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(footerPage());
        await tab.addStyleTag({ content: 'html, body { margin: 0; } * { font-family: "Liberation Sans", sans-serif !important; }' });
        await tab.evaluate(() => document.fonts.ready);
        const rows = await tab.evaluate(FOOTERS);
        expect(rows).toHaveLength(3);
        expect(rows.filter(row => row.notes !== null)).toHaveLength(2);
        for (const row of rows) {
          expect(row.startLines).toBe(1);
          expect(row.startRight).toBeLessThanOrEqual(row.metaRight);
          if (row.notes) {
            // A line of its own, 20 px under the start line (its 16 px line and 4 px), at the start line's x.
            expect(row.notes.lines).toBe(1);
            expect(Math.round(row.notes.top - row.startTop)).toBe(20);
            expect(Math.round(row.notes.left - row.startLeft)).toBe(0);
          }
          expect(row.overlapsLine).toBe(false);
          expect(Math.abs(row.replay.right - row.inner)).toBeLessThan(1);
          // Under 22rem (the 320 and 360 px phones' cards): Replay on the first colony's label line, and the winner's band
          // below its label.
          expect(row.replay.pinned).toBe(width < 390);
          if (row.replay.pinned) {
            expect(Math.abs(row.replay.top - row.labelLineTop)).toBeLessThan(1);
            if (row.band && row.label) expect(row.band.top).toBeGreaterThanOrEqual(row.label.top + row.label.height - 0.5);
          } else {
            // From 22rem: Replay at the end of the start line, whatever follows it.
            expect(Math.abs(row.replay.top - row.startTop)).toBeLessThan(2);
          }
        }
      } finally { await tab.close(); }
    });
  }

  it("makes Replay the row's last line when doubled text leaves the card under 15rem", async () => {
    const tab = await browser.newPage({ viewport: { width: 390, height: 4000 } });
    try {
      await tab.setContent(footerPage());
      await tab.addStyleTag({ content: 'html { font-size: 32px; } html, body { margin: 0; } * { font-family: "Liberation Sans", sans-serif !important; }' });
      await tab.evaluate(() => document.fonts.ready);
      for (const row of await tab.evaluate(FOOTERS)) {
        expect(row.replay.top).toBeGreaterThanOrEqual(row.metaBottom);
        expect(row.overlapsLine).toBe(false);
      }
    } finally { await tab.close(); }
  });
});

describe("Recordings on a phone list only the colonies that played", () => {
  for (const width of [1280, 390]) {
    it(`keeps four fixed columns, a dash for a colony not in the match, on a wide card, and only the played colonies' lines on a phone, at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        // A 1v1 (two colonies) and a four-colony match.
        await tab.setContent(matchesPage(undefined).page);
        await tab.addStyleTag({ content: "html, body { margin: 0; }" });
        const shown = () => [...document.querySelectorAll(".d1p-rec-rows > li")].map(row => [...row.querySelectorAll(":scope > .d1p-rec-slot")]
          .filter(slot => slot.checkVisibility()).map(slot => ({ colony: slot.getAttribute("data-colony"), dash: !!slot.querySelector(".d1p-rec-dash") })));
        const pair = await tab.evaluate(shown);
        expect(pair).toHaveLength(2);
        for (const row of pair) {
          if (width === 1280) expect(row.map(slot => slot.dash)).toEqual([false, false, true, true]);
          else expect(row).toEqual([{ colony: "Very Large", dash: false }, { colony: "Lake Hodges", dash: false }]);
        }
        await tab.setContent(quadrantsPage().page);
        await tab.addStyleTag({ content: "html, body { margin: 0; }" });
        for (const row of await tab.evaluate(shown)) expect(row.map(slot => slot.dash)).toEqual([false, false, false, false]);
      } finally { await tab.close(); }
    });
  }
});

/** The Matches page with a one-colony Waiting row (a queued agent with no opponent yet) and a partial four-colony recording
 * whose last colony nobody joined. */
function absentColoniesPage() {
  const port = dom({ search: "" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const names = SUPERCOLONY_NAMES.map(n => n.label) as [string, string, string, string];
  const seats = ["alice", "bob", "cat"].map((handle, colony) => ({ seat: colony, colony: colony as 0 | 1 | 2, modelLabel: null, thinkingLevel: null, serviceTier: null, handle }));
  const partial: MatchRecording = { id: "2026-11-14T07-00-00-000Z-1", startedAt: "2026-11-14T07:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: null,
    reason: null, decidedBy: null, seats, status: "partial", unavailable: [], matchType: { kind: "quadrants", size: 1 }, colonyNames: names };
  const queued: WaitingAgent = { displayName: "coffee-ant", mode: "1v1", waitingSeconds: 90, since: Date.parse("2026-11-11T05:01:00Z"), rating: null };
  const mounted = mountMatches(port.doc as unknown as Document, host as unknown as HTMLElement, { refresh() {}, more() {} });
  mounted.update({ waiting: { status: "ready", rows: [queued] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows: [partial] }, next: null });
  const body = markup(host);
  mounted.destroy();
  return `<!doctype html><html><head><style>${PAGE_STYLES}</style></head><body>${body}</body></html>`;
}

describe("a phone lists no line for a colony nobody joined", () => {
  for (const width of [1280, 390]) {
    it(`keeps the partial recording's and the Waiting row's empty colony in its wide column, and gives it no line on a phone, at ${width}px`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 2400 } });
      try {
        await tab.setContent(absentColoniesPage());
        await tab.addStyleTag({ content: "html, body { margin: 0; }" });
        const seen = await tab.evaluate(() => {
          const visible = (node: Element) => node.checkVisibility();
          const slots = [...document.querySelectorAll(".d1p-rec-rows > li > .d1p-rec-slot")].filter(visible).map(slot => slot.textContent ?? "");
          const card = document.querySelectorAll(".d1p-card")[0]!;
          const waiting = [...card.querySelectorAll(".d1p-model")].filter(visible).map(line => line.textContent ?? "");
          return { slots, waiting };
        });
        if (width === 1280) {
          expect(seen.slots.map(text => text.includes("did not join"))).toEqual([false, false, false, true]);
          expect(seen.waiting).toEqual(["coffee-ant", "no opponent yet"]);
        } else {
          expect(seen.slots).toHaveLength(3);
          expect(seen.slots.join(" ")).not.toContain("did not join");
          expect(seen.waiting).toEqual(["coffee-ant"]);
        }
      } finally { await tab.close(); }
    });
  }
});

describe("the Matches page's text in a colony's colour has no backing", () => {
  for (const width of [1280, 390]) {
    it(`a four-colony (Quadrants) match: Matches at ${width}px`, async () => {
      const { page } = quadrantsPage();
      const rows = await measured(page, width, 2400);
      expect(rows.length, "coloured text is shown").toBeGreaterThan(0);
      expectNoBacking(rows);
      const rgb = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(",");
      // Live names each colony ("Very Large", then its " Colony") in its original colony ink; Recordings' shared head shows
      // the short name in the head ink, as colour there marks only the winner.
      for (const { label, colour } of SUPERCOLONY_NAMES) {
        const short = rows.filter(r => r.text === label.replace(/ Colony$/, "") && r.state === "rest");
        expect(short.filter(r => !r.head).map(r => r.rgb)).toEqual([rgb(colour)]);
        expect(short.filter(r => r.head)).toEqual([]);
      }
      expect(rows.filter(r => r.text === "Winner" && r.state === "rest")).toEqual([]);
    });
  }


  for (const pair of [...PAIRS, undefined]) {
    for (const width of [1280, 390]) {
      it(`${pair ? pair.join(" against ") : "rated"}: Matches at ${width}px`, async () => {
        // Tall enough that every list's rows are on screen.
        const { body, page } = matchesPage(pair);
        const rows = await measured(page, width, 2400);
        expect(rows.length, "coloured text is shown").toBeGreaterThan(0);
        expectNoBacking(rows);
        // The shared header names all four colonies in the head ink, never a colony's colour.
        expect(rows.filter(r => r.head)).toEqual([]);
        expect(rows.filter(r => r.text === "Winner" && r.state === "rest")).toEqual([]);
        expect(body, "no row draws a text backing").not.toContain("data-aw-ground");
      });
    }
  }
});
