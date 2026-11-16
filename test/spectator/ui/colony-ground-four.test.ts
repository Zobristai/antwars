// Every colony's label and figure has no text backing, in every slot. Agent colour stripes stay unchanged.
// These browser checks exercise the real stylesheet selectors, not the board rendering.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { SUPERCOLONY_NAMES, colonyColours, colourCss } from "../../../src/sim/colonyNames.ts";
import { setMatchColonies } from "../../../web/src/colony-palette.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
const STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "replay-marks.css", "pages/archive.css"]
  .map(path => read(`../../../web/src/${path}`))].join("\n");
/** A four-colony match's names by colony id: the four, in the shared table's order. */
const FOUR = SUPERCOLONY_NAMES.map(n => n.label);

/** Each label or figure previously backed, including the distinct four-colony selectors. */
const texts = (c: number) => [
  `<div class="d2-qrow c${c}"><span class="d2-qname" data-t="2d four-colony">Name</span></div>`,
  `<div class="d1-crow c${c}"><span class="d1-crow-name" data-t="3d four-colony">Name</span></div>`,
  `<span class="aw-colony-name c${c}" data-t="name">Name</span>`,
  `<span class="aw-mark-colony c${c}" data-t="mark">Name</span>`,
  `<div class="d2-name c${c}"><span class="d2-name-text" data-t="2d name">Name</span></div>`,
  `<span class="d1-name c${c}" data-t="3d name">Name</span>`,
  `<div class="d1-fig c${c}"><span data-t="figure">12</span></div>`,
  `<div class="d1-mv c${c}"><span data-t="move">3</span></div>`,
  `<div class="d1-hold-win c${c}"><span class="d1-hold-text" data-t="hold">Holds</span></div>`,
  `<div class="d1-outcome c${c}" data-t="outcome">Won</div>`,
  `<div class="d1-result-head c${c}" data-t="result head">Name won</div>`,
  `<div class="d1-moment-what c${c}" data-t="moment">Queen lost</div>`,
  `<div class="d2-toast" data-colony="${c}" data-kind="fall"><span class="d2-toast-what" data-t="2d fall">Queen 1 lost</span></div>`,
  `<div class="d1-caption" data-colony="${c}" data-kind="fall"><span class="d1-cap-what" data-t="3d fall">Queen 1 lost</span></div>`,
];

/** The page root's style and attributes exactly as the palette sets them for `names`. */
function rootFor(names: readonly string[]) {
  const props = new Map<string, string>(), attrs = new Map<string, string>();
  const documentElement = {
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
  };
  setMatchColonies(names, { documentElement } as unknown as Document);
  setMatchColonies(COLONY_NAMES);
  return { props, attrs };
}

/** The page as the palette sets its root for `names`, with every coloured text of each colony and a Matches row naming all four. */
function page(names: readonly string[]) {
  const { props, attrs } = rootFor(names);
  const colours = colonyColours(names);
  const rowStyle = colours.map((rgb, c) => `--aw-k${c}: ${colourCss(rgb)}`).join("; ");
  const style = [...props].map(([k, v]) => `${k}: ${v}`).join("; ");
  const root = [...attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
  const colonies = names.map((_, c) => `<section data-colony-id="${c}">${texts(c).join("")}</section>`).join("");
  const row = `<div class="d1p"><div style="${rowStyle}">${names.map((_, c) =>
    `<section data-colony-id="${c}"><span class="d1p-colony d1p-c${c}" data-t="row name">Name</span></section>`).join("")}</div></div>`;
  return { ground: attrs.get("data-aw-ground") ?? null, html: `<!doctype html><html${root} style="${style}"><head><style>${STYLES}</style></head><body>${colonies}${row}</body></html>` };
}

/** In the page: each marked text's colony, its name and the background and shadow its own box draws. */
function grounds() {
  return [...document.querySelectorAll<HTMLElement>("[data-t]")].map(el => ({
    colony: Number(el.closest<HTMLElement>("[data-colony-id]")!.dataset.colonyId), text: el.dataset.t!,
    background: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow,
  }));
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

describe("a four-colony match's coloured text", () => {
  for (const width of [1280, 390]) it(`has no backing under any colony name or figure at ${width}px`, async () => {
    const { ground, html } = page(FOUR);
    expect(ground, "no colony gets a backing").toBeNull();
    const tab = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await tab.setContent(html);
      const found = await tab.evaluate(grounds);
      expect(found).toHaveLength(4 * (texts(0).length + 1));
      for (const t of found) {
        const where = `colony ${t.colony} ${t.text}`;
        expect(t.background, where).toBe("rgba(0, 0, 0, 0)");
        expect(t.shadow, where).toBe("none");
      }
    } finally { await tab.close(); }
  });
});

/** `rgb` as a computed style writes it. */
const computed = (rgb: number) => `rgb(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255})`;

describe("a four-colony match's agent rows", () => {
  it("draw each row's colour stripe in its colony's table colour, on the 2D board's agent list and the 3D deck's, for all four colonies", async () => {
    const { props, attrs } = rootFor(FOUR);
    const style = [...props].map(([k, v]) => `${k}: ${v}`).join("; ");
    const root = [...attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
    const rows = FOUR.map((_, c) => `<ul class="d2-agent-list"><li class="d2-agent-item c${c}" data-c="${c}" data-t="2d"></li></ul>`
      + `<ul class="d1-agents"><li class="d1-agent-item c${c}"><button class="d1-agent" data-c="${c}" data-t="3d">Agent</button></li></ul>`).join("");
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await tab.setContent(`<!doctype html><html${root} style="${style}"><head><style>${STYLES}</style></head><body>${rows}</body></html>`);
      const found = await tab.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-t]")].map(el => ({
        colony: Number(el.dataset.c), where: el.dataset.t!, shadow: getComputedStyle(el).boxShadow,
      })));
      expect(found).toHaveLength(8);
      const colours = colonyColours(FOUR);
      for (const t of found) expect(t.shadow, `colony ${t.colony} ${t.where} agent row`).toBe(`${computed(colours[t.colony]!)} 3px 0px 0px 0px inset`);
    } finally { await tab.close(); }
  });
});
