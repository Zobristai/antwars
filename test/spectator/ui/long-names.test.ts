// Long player lines, laid out in Chromium with the client's own stylesheets, at default text and with the browser's default
// size doubled (32 px). On Recordings a line too wide for its column never wraps: the builder's name and model shorten as
// one run ending in a single ellipsis, the model giving way first, then the builder's name; a level of more than 8
// characters shows its first 8 and an ellipsis; Fast's bolt keeps its 6 px and the rating stays whole; the full words stay
// in the title and are read in full. On a Top matches tile a short builder's name beside a long model stays whole while the
// model gives way.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import { topMatchTile } from "../../../web/src/design-system/top-match-tile.ts";
import type { Recording } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";
import { fontconfigFor } from "../../../web/render-check/fonts.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
/** The Matches page's stylesheets, as its pages bundle them (pages/chrome.ts, pages/top-bar.ts, colony-palette.ts). */
const PAGE_STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "pages/top-bar.css", "design-system/tokens.css", "design-system/page-edge.css", "pages/archive.css"]
  .map(path => read(`../../../web/src/${path}`))].join("\n");
/** The Top matches tile's stylesheets (design-system/top-match-tile.ts). */
const TILE_STYLES = [TOKENS, ...["design-system/tokens.css", "design-system/top-match-tile.css"].map(path => read(`../../../web/src/${path}`))].join("\n");

type Seat = Recording["seats"][number];
const rated = { rating: 1612.4, rd: 80, ratedMatches: 12 };
const seat = (index: number, colony: Seat["colony"], handle: string, o: Partial<Seat> = {}): Seat =>
  ({ seat: index, colony, modelLabel: null, thinkingLevel: null, serviceTier: null, handle, startRating: rated, ...o });
const recording = (id: string, seats: Seat[]): Recording => ({ id, startedAt: "2026-11-11T10:34:00.000Z", endedAt: null,
  simulationEndedAt: "2026-11-11T11:19:30.000Z", winner: 0, reason: "queens_killed", decidedBy: "queens_killed", status: "complete",
  unavailable: [], matchType: { kind: "index", size: 1 }, seats });

const LONG_MODEL = "sample/" + "long-model-name-".repeat(5);
const OTHER = seat(0, 1, "kite", { modelLabel: "zai/glm-5.3" });
/** Each sample line, one recording each, in this order. */
const SAMPLES = {
  shortBuilder: recording("2026-11-11T10-34-00-000Z-1", [seat(0, 0, "ivy", { modelLabel: LONG_MODEL, thinkingLevel: "high", serviceTier: "fast" }), OTHER]),
  longBuilder: recording("2026-11-11T10-34-00-000Z-2", [seat(0, 0, "w".repeat(24), { modelLabel: LONG_MODEL, thinkingLevel: "high" }), OTHER]),
  longLevel: recording("2026-11-11T10-34-00-000Z-3", [seat(0, 0, "ivy", { modelLabel: "sample/short", thinkingLevel: "extra-high-reasoning", serviceTier: "fast" }), OTHER]),
  widest: recording("2026-11-11T10-34-00-000Z-4", [seat(0, 0, "W".repeat(24), { modelLabel: "W".repeat(64), thinkingLevel: "W".repeat(32), serviceTier: "fast" }), OTHER]),
};

function recordingsPage(): string {
  const port = dom({ search: "" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const mounted = mountMatches(port.doc as unknown as Document, host as unknown as HTMLElement, { refresh() {}, more() {} });
  mounted.update({ waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] },
    recordings: { status: "ready", rows: Object.values(SAMPLES) }, next: null });
  const body = markup(host);
  mounted.destroy();
  return `<!doctype html><html><head><style>${PAGE_STYLES}</style><style>html, body { margin: 0; }</style></head><body>${body}</body></html>`;
}

/** A four-colony free-for-all, its first colony a short builder's name on a long model: its lines stand in the tile's two columns. */
const FREE_FOR_ALL: Recording = { ...recording("2026-11-11T10-34-00-000Z-5", [
  seat(0, 0, "ivy", { modelLabel: LONG_MODEL, thinkingLevel: "high" }), seat(1, 1, "kite", { modelLabel: "zai/glm-5.3" }),
  seat(2, 2, "fennec", { modelLabel: "zai/glm-5.3" }), seat(3, 3, "tidewater", { modelLabel: "zai/glm-5.3" })]), matchType: { kind: "quadrants", size: 1 } };

/** A 1v1 and a two-a-side team match, the winning side an over-long builder's name on a long model, Fast: its line stands
 * across the whole tile. */
const LONG_SEAT = { modelLabel: LONG_MODEL, thinkingLevel: "high", serviceTier: "fast" } as const;
const ONE_ON_ONE = recording("2026-11-11T10-34-00-000Z-6", [seat(0, 0, "w".repeat(24), LONG_SEAT), seat(1, 1, "kite", { modelLabel: "zai/glm-5.3" })]);
const TEAMS: Recording = { ...recording("2026-11-11T10-34-00-000Z-7", [
  seat(0, 0, "w".repeat(24), LONG_SEAT), seat(1, 1, "kite", { modelLabel: "zai/glm-5.3" }),
  seat(2, 0, "w".repeat(24), LONG_SEAT), seat(3, 1, "kite", { modelLabel: "zai/glm-5.3" })]), matchType: { kind: "index", size: 2 } };

function tilePage(width: string, match: Recording = FREE_FOR_ALL): string {
  const port = dom({ search: "" });
  const tile = topMatchTile(port.doc as unknown as Document, match, "", "shown") as unknown as ElementPort;
  return `<!doctype html><html><head><style>${TILE_STYLES}</style><style>html, body { margin: 0; }</style></head>`
    + `<body><div class="d1p"><ol class="aw-grid" style="--cols: 1; width: ${width}">${markup(tile)}</ol></div></body></html>`;
}

// Drawn in Liberation Sans, one of the two typefaces the design is judged in, bound as the render check binds it, so the
// lines need the room they need on the boards (a fallback monospace draws a W far narrower).
let browser: Browser, fontRoot: string;
beforeAll(async () => {
  fontRoot = await mkdtemp(join(tmpdir(), "long-names-fonts-"));
  const fonts = await fontconfigFor("Liberation Sans", fontRoot);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"],
    env: { ...process.env, FONTCONFIG_FILE: fonts } });
});
afterAll(async () => { await browser?.close(); if (fontRoot) await rm(fontRoot, { recursive: true, force: true }); });

/** A page at `width`, its browser default text size `text` px, holding `html`. */
async function open(width: number, text: 16 | 32, html: string): Promise<Page> {
  const tab = await browser.newPage({ viewport: { width, height: 1600 } });
  const cdp = await tab.context().newCDPSession(tab);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: text } });
  await tab.setContent(html);
  return tab;
}

/** Each sample's Recordings player line, by its sample: what it shows and how its parts fit. */
async function recordingLines(tab: Page) {
  const lines = await tab.locator(".d1p-rec-rows > li").evaluateAll(rows => rows.map(row => {
    // Where the name's text stops showing: its right edge, less its one ellipsis's width when its text is drawn wider than it.
    const visibleEdge = (box: Element) => {
      const range = document.createRange(); range.selectNodeContents(box);
      const right = box.getBoundingClientRect().right;
      if (range.getBoundingClientRect().width <= box.getBoundingClientRect().width + 0.01) return right;
      const probe = document.createElement("span"); probe.textContent = "…"; probe.style.font = getComputedStyle(box).font;
      probe.style.position = "absolute"; document.body.append(probe);
      const width = probe.getBoundingClientRect().width; probe.remove();
      return right - width;
    };
    const line = row.querySelector(".d1p-rec-slot .d1p-rec-player")!;
    const cut = (node: Element | null) => node !== null && node.scrollWidth > node.clientWidth;
    // Shortened by any amount, however small: its text drawn wider than its box, so it ends in an ellipsis.
    const shortened = (node: Element | null) => {
      if (node === null) return false;
      const range = document.createRange(); range.selectNodeContents(node);
      return range.getBoundingClientRect().width > node.getBoundingClientRect().width + 0.01;
    };
    const name = line.querySelector(".d1p-rec-name")!;
    const user = line.querySelector(".d1p-user"), model = line.querySelector(".d1p-mname"), level = line.querySelector(".d1p-lvl");
    const bolt = line.querySelector(".d1p-bolt"), rating = line.querySelector(".d1p-elo-badge");
    const slot = line.closest(".d1p-rec-slot")!.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(name).fontSize);
    // The run's text shows up to its one ellipsis; a part reaching past that point is shortened, and one starting past it is gone.
    const edge = visibleEdge(name);
    const past = (node: Element | null) => node !== null && node.getBoundingClientRect().right > edge + 0.5;
    const ellipses = [name, ...name.querySelectorAll("*")]
      .filter(node => getComputedStyle(node).textOverflow === "ellipsis" && getComputedStyle(node).overflowX !== "visible");
    return {
      // One line: no taller than one of the name's lines, and ending inside its column.
      oneLine: line.getBoundingClientRect().height <= parseFloat(getComputedStyle(name).lineHeight) + 0.5 && line.getBoundingClientRect().right <= slot.right + 0.5,
      nameCut: shortened(name), userCut: past(user), modelCut: past(model), levelCut: shortened(level),
      modelGone: model !== null && model.getBoundingClientRect().left >= edge - 0.5,
      nameEms: name.getBoundingClientRect().width / em,
      // The one ellipsis is the run's own: neither the builder's name nor the model draws one.
      ellipses: ellipses.map(node => node === name ? "name" : node.className),
      level: level?.textContent ?? null, levelHidden: level?.getAttribute("aria-hidden") ?? null,
      title: name.getAttribute("title"), read: name.textContent,
      // Whole: its full 6 px, never shrunk to make room for the level.
      boltShown: bolt !== null && bolt.getBoundingClientRect().width >= 5.99 && bolt.getBoundingClientRect().right <= slot.right + 0.5,
      ratingCut: cut(rating), ratingInside: rating === null || rating.getBoundingClientRect().right <= slot.right + 0.5,
    };
  }));
  const of = (start: string) => lines.find(line => line.title?.startsWith(start))!;
  return { shortBuilder: of("ivy long-"), longBuilder: of(`${"w".repeat(24)} `), longLevel: of("ivy short"), widest: of(`${"W".repeat(24)} `) };
}

describe("a Recordings player line too wide for its column", () => {
  for (const width of [320, 360, 390, 1280]) for (const text of [16, 32] as const) {
    it(`never wraps or widens the page, the model giving way before the builder, at ${width} px with ${text} px text`, async () => {
      const tab = await open(width, text, recordingsPage());
      try {
        const { shortBuilder, longBuilder, longLevel, widest } = await recordingLines(tab);
        expect(await tab.locator(".d1p-rec-table").evaluate(table => table.getBoundingClientRect().right <= innerWidth && table.scrollWidth <= table.clientWidth)).toBe(true);
        for (const line of [shortBuilder, longBuilder, longLevel, widest]) {
          expect(line.oneLine).toBe(true);
          // One ellipsis is drawn, the run's own, so the name is read in full and its title holds both parts.
          expect(line.ellipses).toEqual(["name"]);
          expect(line.read).toBe(line.title);
          expect(line.ratingCut).toBe(false);
          expect(line.ratingInside).toBe(true);
        }
        // The run keeps room for its ellipsis; the model gives way first, and a builder's name gives way only once its model
        // is gone, so the line ends in the one ellipsis with no mark of the model's own.
        for (const line of [shortBuilder, longBuilder, longLevel, widest]) {
          expect(line.nameEms).toBeGreaterThanOrEqual(1.49);
          if (line.modelCut) expect(line.nameCut).toBe(true);
          if (line.userCut) expect(line.modelGone).toBe(true);
          // The level gives way only once the name is at its least.
          if (line.levelCut) expect(line.nameEms).toBeLessThan(1.51);
        }
        expect([widest.nameCut, widest.modelCut]).toEqual([true, true]);
        // A level of more than 8 characters shows its first 8 and an ellipsis, hidden from screen readers, which read the whole level.
        expect([longLevel.level, longLevel.levelHidden]).toEqual(["extra-hi…", "true"]);
        expect(widest.level).toBe(`${"W".repeat(8)}…`);
        for (const line of [shortBuilder, longLevel, widest]) expect(line.boltShown).toBe(true);
      } finally { await tab.close(); }
    });
  }

  it("shows the short builder whole beside its shortened model at 1280 px", async () => {
    const tab = await open(1280, 16, recordingsPage());
    try {
      const { shortBuilder } = await recordingLines(tab);
      expect([shortBuilder.modelCut, shortBuilder.userCut]).toEqual([true, false]);
    } finally { await tab.close(); }
  });

  it("ends a level too wide for a 320 px phone with doubled text in an ellipsis earlier, Fast and the rating whole", async () => {
    const tab = await open(320, 32, recordingsPage());
    try {
      const { widest } = await recordingLines(tab);
      expect([widest.levelCut, widest.boltShown, widest.ratingCut, widest.ratingInside, widest.oneLine]).toEqual([true, true, false, true, true]);
    } finally { await tab.close(); }
  });
});

/** The tile's first player line, the winner's: what its name shows and how its parts fit. */
async function tileLine(tab: Page) {
  return tab.locator(".aw-player").first().evaluate(player => {
    // Where the name's text stops showing: its right edge, less its one ellipsis's width when its text is drawn wider than it.
    const visibleEdge = (box: Element) => {
      const range = document.createRange(); range.selectNodeContents(box);
      const right = box.getBoundingClientRect().right;
      if (range.getBoundingClientRect().width <= box.getBoundingClientRect().width + 0.01) return right;
      const probe = document.createElement("span"); probe.textContent = "…"; probe.style.font = getComputedStyle(box).font;
      probe.style.position = "absolute"; document.body.append(probe);
      const width = probe.getBoundingClientRect().width; probe.remove();
      return right - width;
    };
    const name = player.querySelector(".aw-name")!, builder = name.querySelector("b")!, model = name.querySelector(".aw-model")!;
    const bolt = player.querySelector(".aw-bolt");
    const edge = visibleEdge(name);
    const ellipses = [name, ...name.querySelectorAll("*")]
      .filter(node => getComputedStyle(node).textOverflow === "ellipsis" && getComputedStyle(node).overflowX !== "visible");
    return { builder: builder.textContent, builderCut: builder.getBoundingClientRect().right > edge + 0.5,
      modelCut: model.getBoundingClientRect().right > edge + 0.5, modelGone: model.getBoundingClientRect().left >= edge - 0.5,
      ellipses: ellipses.map(node => node === name ? "name" : node.className),
      bolt: bolt === null ? null : bolt.getBoundingClientRect().width,
      oneLine: player.getBoundingClientRect().height <= parseFloat(getComputedStyle(player).lineHeight) + 0.5
        && player.getBoundingClientRect().right <= player.closest(".aw-tile")!.getBoundingClientRect().right + 0.5,
      title: name.getAttribute("title"), read: name.textContent };
  });
}

describe("a Top matches tile line", () => {
  // Two columns, or a line across the tile, from 18em of viewport width; stacked lines on a 320 or 390 phone with doubled text.
  for (const [width, text, tile] of [[1280, 16, "360px"], [1280, 32, "720px"], [390, 32, "390px"], [320, 32, "320px"]] as const) {
    it(`keeps a short builder's name whole while its long model gives way, at ${width} px with ${text} px text`, async () => {
      const tab = await open(width, text, tilePage(tile));
      try {
        const { builder, builderCut, modelCut, ellipses, oneLine } = await tileLine(tab);
        expect({ builder, builderCut, modelCut, ellipses, oneLine }).toEqual({ builder: "ivy", builderCut: false, modelCut: true, ellipses: ["name"], oneLine: true });
      } finally { await tab.close(); }
    });

    for (const [kind, match] of [["1v1", ONE_ON_ONE], ["team side", TEAMS]] as const) {
      it(`keeps an over-long ${kind} line on one line ending in a single ellipsis, Fast's bolt whole, at ${width} px with ${text} px text`, async () => {
        const tab = await open(width, text, tilePage(tile, match));
        try {
          const line = await tileLine(tab);
          expect([line.oneLine, line.ellipses, line.modelCut, line.bolt! >= 5.99]).toEqual([true, ["name"], true, true]);
          // The model gives way first: the builder's name shortens only once the model is gone.
          if (line.builderCut) expect(line.modelGone).toBe(true);
          expect(line.read).toBe(line.title);
        } finally { await tab.close(); }
      });
    }
  }
});
