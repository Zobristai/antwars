// In a four-colony match the page palette lists on the page root every colony whose colour needs a dark ground under its
// coloured text (colony-palette.ts), and colony-ground.css draws that ground under colony 2's and colony 3's text as it
// does under colony 0's and colony 1's. Every text the stylesheet grounds is written out for each of the four colonies,
// on the page root exactly as the palette sets it, and laid out in headless Chromium with the page's tokens
// (web/index.html) and the client's stylesheets: the two colonies whose colours need a ground (Sweetwater, Lake Skinner)
// get it, the two whose colours need none (Very Large, Lake Hodges) get none. The Matches page grounds a row's own
// colonies from the row, so a row carrying all four is written out the same way. Not visual evidence.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import { SUPERCOLONY_NAMES, colonyColours, colourCss } from "../../../src/sim/colonyNames.ts";
import { TEXT_GROUND, needsTextGround, setMatchColonies } from "../../../web/src/colony-palette.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS = /:root \{[^}]*\}/.exec(read("../../../web/index.html"))![0];
const STYLES = [TOKENS, ...["ui/ui.css", "ui/deck/deck.css", "replay-marks.css", "pages/archive.css", "colony-ground.css"]
  .map(path => read(`../../../web/src/${path}`))].join("\n");
/** A four-colony match's names by colony id: the four, in the shared table's order. */
const FOUR = SUPERCOLONY_NAMES.map(n => n.label);
const GROUND = colourCss(TEXT_GROUND);

/** Every text colony-ground.css grounds, as colony c's; data-t marks the element whose box carries the ground. */
const texts = (c: number) => [
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

/** The page as the palette sets its root for `names`, with every grounded text of each colony and a Matches row naming all four. */
function page(names: readonly string[]) {
  const props = new Map<string, string>(), attrs = new Map<string, string>();
  const documentElement = {
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
  };
  setMatchColonies(names, { documentElement } as unknown as Document);
  setMatchColonies(COLONY_NAMES);
  const colours = colonyColours(names);
  const rowGround = colours.flatMap((rgb, c) => needsTextGround(rgb) ? [c] : []).join(" ");
  const rowStyle = [...colours.map((rgb, c) => `--aw-k${c}: ${colourCss(rgb)}`), `--aw-ink-ground: ${GROUND}`].join("; ");
  const style = [...props].map(([k, v]) => `${k}: ${v}`).join("; ");
  const root = [...attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
  const colonies = names.map((_, c) => `<section data-colony-id="${c}">${texts(c).join("")}</section>`).join("");
  const row = `<div class="d1p"><div data-aw-ground="${rowGround}" style="${rowStyle}">${names.map((_, c) =>
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
  it("has the dark ground under colony 2's and colony 3's text, where their colours need it, and none under colony 0's and 1's", async () => {
    const { ground, html } = page(FOUR);
    expect(ground, "the colonies the page root grounds").toBe("2 3");
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await tab.setContent(html);
      const found = await tab.evaluate(grounds);
      expect(found).toHaveLength(4 * (texts(0).length + 1));
      const rgb = [(TEXT_GROUND >> 16) & 255, (TEXT_GROUND >> 8) & 255, TEXT_GROUND & 255].join(", ");
      for (const t of found) {
        const where = `colony ${t.colony} ${t.text}`;
        if (t.colony >= 2) {
          expect(t.background, where).toBe(`rgb(${rgb})`);
          expect(t.shadow, where).toContain(`rgb(${rgb})`);
        } else {
          expect(t.background, where).toBe("rgba(0, 0, 0, 0)");
          expect(t.shadow, where).toBe("none");
        }
      }
    } finally { await tab.close(); }
  });
});
