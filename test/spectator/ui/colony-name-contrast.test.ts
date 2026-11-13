// Every piece of text the match view shows in a colony's colour keeps 4.5:1 against what it actually sits on, for all
// four colony colours: the 2D board's score plate and caption (an event and the fall), the 3D deck's plates, figures and
// caption, the result box, and the replay marks' label and list. The HUDs are mounted on the test port with each drawn
// pair, written out as markup and laid out in headless Chromium with the page's tokens (web/index.html) and the client's
// stylesheets. Each coloured text is found by its rendered colour; then every text on the page is made transparent and
// the page shot, so the pixels under the text's line boxes are its real background, and each pixel's contrast with the
// text's colour counts. Rows and buttons are measured again with :hover and :focus-visible forced. A rated match (no
// drawn names) is held to the same floor and must draw no ground at all, so its text is drawn as before. The HUDs are
// written out as the desktop lays them out, so they are measured at 1280px; the result box and the replay row, whose
// markup is the same on a phone, at 1280px and 390px. The served page's phone layouts are measured by the captures.
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
import { dom, ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** The page's tokens (web/index.html's :root) and the stylesheets the match view bundles. */
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
const STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "replay-marks.css", "colony-ground.css"].map(path => read(`../../../web/src/${path}`))].join("\n");
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
  const out: { i: number; text: string; rgb: string; opacity: number; interactive: boolean; rects: { x: number; y: number; w: number; h: number }[] }[] = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let i = 0;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent?.trim()) continue;
    const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(getComputedStyle(el).color);
    if (!m || !colours.includes(`${m[1]},${m[2]},${m[3]}`)) continue;
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
    out.push({ i, text: n.textContent.trim(), rgb: `${m[1]},${m[2]},${m[3]}`, opacity, interactive: !!interactive, rects });
    i++;
  }
  return out;
}

/** In the page, over a shot with every text transparent: the worst pixel's contrast under each text's line boxes. */
async function worst([png, items]: readonly [string, readonly { rgb: string; opacity: number; rects: { x: number; y: number; w: number; h: number }[] }[]]) {
  const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
  const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d")!; x.drawImage(img, 0, 0);
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return items.map(it => {
    const [tr, tg, tb] = it.rgb.split(",").map(Number) as [number, number, number], a = it.opacity;
    let min = Infinity;
    for (const r of it.rects) {
      const d = x.getImageData(r.x, r.y, r.w, r.h).data;
      for (let i = 0; i < d.length; i += 4) {
        const [br, bg, bb] = [d[i]!, d[i + 1]!, d[i + 2]!];
        const l1 = lum(tr * a + br * (1 - a), tg * a + bg * (1 - a), tb * a + bb * (1 - a)), l2 = lum(br, bg, bb);
        min = Math.min(min, (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
      }
    }
    return min;
  });
}

const HIDE = "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }";
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

/** Each coloured text's worst contrast at rest, and its row's or button's with :hover and with :focus-visible forced. */
async function measured(page: string, width: number) {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await tab.setContent(page);
    const texts = await tab.evaluate(findTexts, COLOURS.map(c => [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(",")));
    await tab.addStyleTag({ content: HIDE });
    const shot = async () => (await tab.screenshot()).toString("base64");
    const rows = (await tab.evaluate(worst, [await shot(), texts] as const)).map((min, k) => ({ ...texts[k]!, state: "rest", min }));
    const cdp = await tab.context().newCDPSession(tab);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    for (const t of texts.filter(t => t.interactive)) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-ct="${t.i}"]` });
      for (const [state, forced] of [["hover", ["hover"]], ["focus-visible", ["focus", "focus-visible"]]] as const) {
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...forced] });
        rows.push({ ...t, state, min: (await tab.evaluate(worst, [await shot(), [t]] as const))[0]! });
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      }
    }
    return rows;
  } finally { await tab.close(); }
}

const MOMENTS = [
  ["2d", "event"], ["2d", "fall"], ["3d", "event"], ["3d", "fall"], ["result", { winner: 0 }], ["result", { winner: 1 }],
  ["replay", "label0"], ["replay", "label1"], ["replay", "list"],
] as const;
const name = (m: unknown) => typeof m === "object" ? `winner ${(m as { winner: number }).winner}` : String(m);

describe("text in a colony's colour keeps 4.5:1 on what it sits on", () => {
  for (const pair of [...PAIRS, undefined]) {
    for (const [surface, moment] of MOMENTS) {
      for (const width of surface === "2d" || surface === "3d" ? [1280] : [1280, 390]) {
        it(`${pair ? pair.join(" against ") : "rated"}: ${surface} ${name(moment)} at ${width}px`, async () => {
          const { ground, page } = mounted(pair, surface, moment);
          const rows = await measured(page, width);
          expect(rows.length, "coloured text is shown").toBeGreaterThan(0);
          // A fallen colony's words step back by opacity during the fall, rated as unrated (ui.css .is-fallen); the
          // floor is for text at full strength.
          for (const r of rows.filter(r => r.opacity === 1)) expect(r.min, `"${r.text}" (${r.rgb}, ${r.state})`).toBeGreaterThanOrEqual(4.5);
          if (!pair) expect(ground, "a rated match draws no ground").toBeNull();
        });
      }
    }
  }

  it("grounds exactly the two colours that fall short on a raised row, and never the rated colours", () => {
    const grounds = PAIRS.map(pair => mounted(pair, "result", { winner: 0 }).ground);
    expect(grounds).toEqual(["0 1", "0 1", null, "1", "1"]);
    expect(mounted(undefined, "result", { winner: 0 }).ground).toBeNull();
  });
});
