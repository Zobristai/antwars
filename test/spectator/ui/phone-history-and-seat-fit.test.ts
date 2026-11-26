import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { applyTextSize, fontconfigFor, TYPEFACES } from "../../../web/render-check/fonts.ts";
import { mountTeams } from "../../../web/src/ui/deck/pane.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { markup } from "./port-markup.ts";
import { scoreFrame } from "./score-band-frame.ts";

function duel() {
  const { doc } = dom(), frame = scoreFrame();
  frame.board!.agents.forEach((a, i) => {
    a.modelLabel = "zai/glm-5.3"; a.thinkingLevel = "max";
    if (i) a.serviceTier = "fast";
    // The benchmark puts badges after its title; a player using the same model puts them inside its model box.
    a.identity = { displayName: i ? "sample-player" : "antwars/glm-5-3", elo: 1500 };
  });
  frame.commands.push({ id: 1, tick: 6000, agent: 0, colony: 0, call: "order", accepted: false,
    order: { kind: "attack", tileX: 4, tileY: 3, intent: "hold this tile" } });
  frame.chat.push({ kind: "intent", agent: 0, colony: 0, tick: 5900, text: "@".repeat(80),
    words: [], markId: -1, tileX: 0, tileY: 0, laidTick: -1 });
  for (const id of [1, 2]) {
    const mark = { id, agent: 0, colony: 0 as const, tileX: 4, tileY: 3, words: [], laidTick: 5900 + id, verb: "FORAGE" as const, count: 6, answered: 0 };
    frame.chat.push({ ...mark, kind: "mark", tick: mark.laidTick, markId: id, text: "" });
    if (id === 1) frame.marks.push({ mark, ageMs: 0 }); // Recent marks include both the button and the expired status.
  }
  let selectedAgent = -1;
  const actions = { select() {}, selectAgent(i: number) { selectedAgent = i; }, hover() {}, pointOrder() {}, focusMark() {} };
  const pane = mountTeams(doc, actions, { search: () => "", economy: [doc.createElement("div"), doc.createElement("div")] });
  const update = () => pane.update({ frame, selected: null, selectedAgent, connection: "", board: "2d", mode: null, stalled: false }, false);
  pane.setWide(false); update();
  const team = pane.teams[0]!;
  team.querySelector<HTMLButtonElement>(".sb-history")!.click();
  const history = pane.teams.map(t => markup(t as unknown as ElementPort)).join("");
  team.querySelector<HTMLButtonElement>(".d1-agent-pick")!.click(); update();
  return { history, selected: markup(team as unknown as ElementPort) };
}

/** Measure painted words rather than a flex item's box: the latter can fit while text is split or clipped inside it. */
function inspectRow(row: Element) {
  const team = row.closest(".d1-team")!.getBoundingClientRect(), rect = row.getBoundingClientRect();
  const boxes: DOMRect[] = [], words: string[] = [], problems: string[] = [];
  const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.parentElement!.checkVisibility()) continue;
    for (const m of n.textContent!.matchAll(/\S+/g)) {
      const r = new Range(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
      const fragments = [...r.getClientRects()];
      if (fragments.length !== 1 && !n.parentElement!.matches(".d1-said.is-thought")) problems.push(`split ${m[0]}`);
      const ink = r.getBoundingClientRect();
      if (ink.width <= 0 || ink.left < Math.max(team.left, rect.left) - 0.5 || ink.right > Math.min(team.right, rect.right) + 0.5) problems.push(`outside: ${m[0]} (${ink.width} px in ${rect.width})`);
      boxes.push(...fragments); words.push(m[0]);
    }
  }
  for (const icon of row.querySelectorAll("svg")) if (icon.checkVisibility()) {
    const ink = icon.getBoundingClientRect();
    if (!ink.width || ink.left < rect.left || ink.right > rect.right) problems.push("icon outside row");
    boxes.push(ink);
  }
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) problems.push("overlap");
  }
  return { words, problems };
}

it.each(TYPEFACES)("reflows individual badges, refused orders and selected-seat history in %s", async font => {
  const css = ["design-system/tokens.css", "ui/deck/deck.css"].map(path => readFileSync(new URL(`../../../web/src/${path}`, import.meta.url), "utf8")).join("\n");
  const states = duel();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"], env: { ...process.env, FONTCONFIG_FILE: await fontconfigFor(font) } });
  try {
    const page = await browser.newPage();
    for (const width of [320, 390]) for (const size of [40, 64] as const) {
      await page.setViewportSize({ width, height: 844 }); await applyTextSize(page, size);
      for (const [state, html] of Object.entries(states)) {
        const at = `${state}, ${width}px, ${size}px text, ${font}`;
        await page.setContent(`<style>body{margin:0}${css}</style><main class="d1 score-band"><div class="d1-below"><div class="d1-deck">${html}</div></div></main>`);
        const panel = page.locator(".d1-below");
        const overflow = await panel.evaluate(p => p.scrollWidth <= p.clientWidth ? [] : [...p.querySelectorAll<HTMLElement>(".d1-sel *")].flatMap(e => {
          const rect = e.getBoundingClientRect();
          return rect.width && rect.right > p.clientWidth ? [`${e.className}: ${e.textContent?.slice(0, 48)} (${rect.left}..${rect.right})`] : [];
        }));
        expect(await panel.evaluate(p => [p.clientWidth, p.scrollWidth]), `${at}: ${overflow.join("; ")}`).toEqual([width, width]);
        const placements = state === "history" ? [".d1-who > .d1-tags", ".d1-model-box > .d1-tags"] : [".d1-sel-title > .d1-tags"];
        for (const placement of placements) {
          const badges = page.locator(placement + ":visible");
          expect(await badges.count(), `${at} ${placement}`).toBe(1);
          expect(await badges.locator(".d1-tag").evaluateAll(nodes => nodes.map(n => parseFloat(getComputedStyle(n).fontSize))), at).toEqual([size * 10 / 16, size * 10 / 16]);
          expect(await badges.evaluate(inspectRow), `${at} ${placement}`).toEqual({ words: ["max", placement.startsWith(".d1-model-box") ? "Fast" : "retired"], problems: [] });
        }
        if (state === "history") {
          const row = page.locator(".d1-log.is-refused:visible");
          const fit = await row.evaluate(inspectRow);
          expect(fit.words, at).toEqual(expect.arrayContaining(["10:00", "attack", "refused"]));
          expect(await row.locator("svg").count(), at).toBe(2); expect(fit.problems, at).toEqual([]);
        } else {
          const recent = page.locator(".d1-history-line:visible");
          expect(await recent.count(), at).toBe(3);
          const thought = recent.locator(".d1-said.is-thought");
          expect(await thought.textContent()).toBe(`“${"@".repeat(80)}”`);
          expect(await thought.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), at).toBe(size * 12 / 16);
          expect(await recent.locator(".d1-chip").innerText()).toBe("Show on board");
          expect(await recent.locator(".d1-gone").innerText()).toBe("no longer on the board");
          for (const row of await recent.all()) expect((await row.evaluate(inspectRow)).problems, at).toEqual([]);
        }
      }
    }
  } finally { await browser.close(); }
});
