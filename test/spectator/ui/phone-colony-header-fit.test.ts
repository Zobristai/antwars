import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { applyTextSize, fontconfigFor, TYPEFACES } from "../../../web/render-check/fonts.ts";
import { mountTeams } from "../../../web/src/ui/deck/pane.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";
import { scoreFrame } from "./score-band-frame.ts";

/** Exercise the narrow pane's real grouped-seat buttons and its opened History header. */
function openColony() {
  const { doc } = dom(), frame = scoreFrame(2, 8);
  frame.board!.deaths = [60, 60]; // With no living ants the displayed cumulative Hatched total is 60.
  frame.board!.agents.forEach((a, i) => {
    a.modelLabel = "zai/glm-5.3"; a.thinkingLevel = "max";
    a.identity = { displayName: `antwars/glm-5-3 #${1 + Math.floor(i / 2)}`, elo: 1500 };
  });
  const actions = { select() {}, selectAgent() {}, hover() {}, pointOrder() {}, focusMark() {} };
  const pane = mountTeams(doc, actions, { search: () => "", economy: [doc.createElement("div"), doc.createElement("div")] });
  pane.setWide(false);
  pane.update({ frame, selected: null, selectedAgent: -1, connection: "", board: "2d", mode: null, stalled: false }, false);
  const team = pane.teams[0]!;
  team.querySelector<HTMLButtonElement>(".sb-history")!.click();
  return markup(team as unknown as ElementPort);
}

it.each(TYPEFACES)("fits four whole seats, player badges and the opened Hatched total in %s", async font => {
  const css = ["design-system/tokens.css", "ui/deck/deck.css"].map(path => readFileSync(new URL(`../../../web/src/${path}`, import.meta.url), "utf8")).join("\n");
  const team = openColony();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"],
    env: { ...process.env, FONTCONFIG_FILE: await fontconfigFor(font) } });
  try {
    const page = await browser.newPage();
    for (const width of [320, 390]) for (const size of [16, 32, 40, 64] as const) {
      await page.setViewportSize({ width, height: 844 }); await applyTextSize(page, size);
      await page.setContent(`<style>body{margin:0}${css}</style><main class="d1 score-band"><div class="d1-below"><div class="d1-deck">${team}</div></div></main>`);
      const result = await page.locator(".d1-team").evaluate(team => {
        const box = team.getBoundingClientRect();
        const inside = (r: DOMRect) => r.width > 0 && r.left >= box.left && r.right <= box.right;
        const text = (selector: string) => { const r = new Range(); r.selectNodeContents(team.querySelector(selector)!); return r.getBoundingClientRect(); };
        const seats = [...team.querySelectorAll("button.d1-member")].map(b => {
          const button = b.getBoundingClientRect(), badge = b.querySelector(".sb-seat-badge")!.getBoundingClientRect(), idle = b.querySelector(".sb-idle")!.getBoundingClientRect();
          return { top: button.top, badge: badge.width, idle: idle.width, whole: inside(badge) && inside(idle) && badge.left >= button.left && idle.right <= button.right && idle.left >= badge.right && idle.top < badge.bottom && idle.bottom > badge.top };
        });
        const heading = text(".sb-history-kicker"), label = text(".sb-detail-stat dt"), count = text(".sb-detail-stat dd");
        const tagNodes = [...team.querySelectorAll(".d1-team-player > .d1-tags > .d1-tag")];
        const tags = tagNodes.map(n => {
          const r = new Range(); r.selectNodeContents(n);
          const badge = n.getBoundingClientRect(), run = r.getBoundingClientRect();
          return { word: n.textContent, rect: badge, font: parseFloat(getComputedStyle(n).fontSize),
            whole: inside(badge) && r.getClientRects().length === 1 && run.left >= badge.left && run.right <= badge.right };
        });
        // Inline when there is room; otherwise wrap between units without using the panel gutters.
        const placement = (a: DOMRect, b: DOMRect, gap: number) => a.width + gap + b.width <= box.width
          ? b.left >= a.right && b.top < a.bottom && a.top < b.bottom : b.top >= a.bottom;
        const [first, second] = tags;
        const panel = team.closest(".d1-below")!;
        return { seats, panelFits: panel.scrollWidth === panel.clientWidth, headingFits: [heading, label, count].every(inside),
          count: team.querySelector(".sb-detail-stat dd")!.textContent, totalFits: placement(label, count, 6),
          headerFits: placement(heading, team.querySelector(".sb-detail-stat")!.getBoundingClientRect(), 8),
          tags: tags.map(({ word, whole, font }) => ({ word, whole, font })),
          tagsFit: !!first && !!second && placement(first.rect, second.rect, 3) };
      });
      const at = `${width}px, ${size}px text, ${font}`;
      expect(result.seats, at).toHaveLength(4);
      for (const seat of result.seats) {
        expect(seat.whole, at).toBe(true); expect(seat.badge, at).toBeCloseTo(size, 1); expect(seat.idle, at).toBeCloseTo(size * 14 / 16, 1);
      }
      expect(result, at).toMatchObject({ panelFits: true, headingFits: true, count: "60", totalFits: true, headerFits: true, tagsFit: true });
      expect(result.tags, at).toEqual(["max", "retired"].map(word => ({ word, whole: true, font: size * 10 / 16 })));
      if (size === 64 || size <= 32) {
        expect(new Set(result.seats.map(s => s.top)).size > 1, at).toBe(size === 64);
      }
    }
  } finally { await browser.close(); }
});
