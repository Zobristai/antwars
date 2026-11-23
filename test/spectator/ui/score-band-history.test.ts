import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import { mountTeams } from "../../../web/src/ui/deck/pane.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const TOKENS = readFileSync(new URL("../../../web/src/design-system/tokens.css", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
const ROOT_TOKENS = HTML.slice(HTML.indexOf(":root {"), HTML.indexOf("html, body")).trim();
const ROBOTO_400 = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/400Regular/Roboto_400Regular.ttf", import.meta.url)).toString("base64");
const ROBOTO_400_I = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/400Regular_Italic/Roboto_400Regular_Italic.ttf", import.meta.url)).toString("base64");
const ROBOTO_600 = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/600SemiBold/Roboto_600SemiBold.ttf", import.meta.url)).toString("base64");
const ROBOTO_700 = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/700Bold/Roboto_700Bold.ttf", import.meta.url)).toString("base64");
const ROBOTO_FACES = `
@font-face{font-family:Roboto;font-style:normal;font-weight:400;src:url(data:font/ttf;base64,${ROBOTO_400})}
@font-face{font-family:Roboto;font-style:italic;font-weight:400;src:url(data:font/ttf;base64,${ROBOTO_400_I})}
@font-face{font-family:Roboto;font-style:normal;font-weight:600;src:url(data:font/ttf;base64,${ROBOTO_600})}
@font-face{font-family:Roboto;font-style:normal;font-weight:700;src:url(data:font/ttf;base64,${ROBOTO_700})}
`;
const CHROME = process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome";

const COLONIES = [
  { name: "Very Large Colony", ink: "#ffb000", hatched: "1,378" },
  { name: "Lake Hodges Colony", ink: "#00c2ff", hatched: "1,396" },
  { name: "Sweetwater Colony", ink: "#ff1e1e", hatched: "1,417" },
  { name: "Lake Skinner Colony", ink: "#009078", hatched: "9,999" },
] as const;

const BADGE_SVG = `<svg width="14" height="14" viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="2.5" fill="#0b0907" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="10" r="4" fill="currentColor"/></svg>`;
const ORDER_SVG = `<svg width="13" height="13" viewBox="0 0 24 24"><path d="M13 3L5 14h6l-2 7 10-11h-6z" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

function desktopPageHtml(
  font: string,
  openCount: number,
  extraRows = 0,
  opts: { visibleColonies?: number; agentsPerColony?: number; longAgents?: boolean } = {},
): string {
  const visibleColonies = opts.visibleColonies ?? COLONIES.length;
  const agentsPerColony = opts.agentsPerColony ?? 1;
  const longAgents = opts.longAgents ?? false;
  const teams = COLONIES.map((col, i) => {
    const seats = Array.from({ length: agentsPerColony }, () =>
      `<button class="d1-member" type="button"><span class="sb-seat-badge">${BADGE_SVG}</span><span class="sb-idle"></span></button>`
    ).join("");
    const agentRows = Array.from({ length: agentsPerColony }, (_, a) => {
      const title = longAgents ? `CompetitiveAgentHandleName_${i}_${a}__` : `Agent ${i + 1}`;
      const model = longAgents ? `provider-org/very-long-model-identifier-version-2026-preview-0${a}` : `Model ${i + 1}`;
      return `<li class="d1-agent-item c${i}"><button class="d1-agent" type="button"><span class="d1-who"><span class="d1-title-box"><span class="d1-title">${title}</span></span><span class="d1-model-box"><span class="d1-model">${model}</span></span></span></button></li>`;
    }).join("");
    return `
    <section class="d1-team c${i}" style="--sb-ink:${col.ink}" ${i >= visibleColonies ? "hidden" : ""}>
      <div class="sb-identity">
        <header class="d1-team-head"><h2 class="d1-name c${i}">${col.name}</h2><span class="d1-team-members">${seats}</span></header>
        <ol class="d1-agents">${agentRows}</ol>
      </div>
      <div class="d1-econ c${i} has-flyers">
        <div class="d1-cell sb-workers"><span class="d1-ml">Workers</span><span class="d1-mv">92</span></div>
        <div class="d1-cell sb-soldiers"><span class="d1-ml">Soldiers</span><span class="d1-mv">190</span></div>
        <div class="d1-cell sb-flyers"><span class="d1-ml">Flyers</span><span class="d1-mv">0</span></div>
        <div class="d1-cell sb-food"><span class="d1-ml">Food</span><span class="d1-mv">2,035</span></div>
        <div class="d1-cell sb-next"><span class="d1-ml">Next spawn</span><span class="d1-next">—</span></div>
        <div class="d1-cell sb-ants"><span class="d1-ml">Ants</span><span class="d1-mv">282/512</span></div>
        <div class="d1-cell sb-queens"><span class="d1-ml">Queens</span><div class="sb-queen-value"><span class="d1-mv">2</span><span class="d1-lamps c${i}"><span class="d1-lamp"><span class="d1-lamp-fill"></span><span class="d1-lamp-hp">100</span></span></span></div></div>
        <div class="d1-cell sb-queen-kills"><span class="d1-ml">Queen kills</span><span class="d1-mv">—</span></div>
      </div>
      <button class="sb-history" type="button" aria-controls="colony-history-${i}" aria-expanded="${i < openCount ? "true" : "false"}">≡</button>
    </section>
  `;
  }).join("");

  const stripCols = COLONIES.map((col, i) => {
    const filler = Array.from({ length: extraRows }, (_, k) =>
      `<li class="d1-tl-entry d1-log"><span class="d1-when">${9 - Math.floor(k / 10)}:${String(59 - (k % 60)).padStart(2, "0")}</span><span class="d1-log-who"></span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">Queen 2 founded</span></span></li>`
    ).join("");
    return `
      <section class="d1-timeline c${i}" id="colony-history-${i}" tabindex="0" style="--sb-ink:${col.ink}" ${i < openCount ? "" : "hidden"}>
        <header class="sb-history-head">
          <h4 class="sb-history-col-name">${col.name}</h4>
          <h3 class="d1-kicker sb-history-kicker">History</h3>
          <dl class="sb-detail-stat"><dt class="d1-ml">Hatched</dt><dd class="d1-mv">${col.hatched}</dd></dl>
        </header>
        <ol class="d1-tl">
          <li class="d1-tl-entry d1-log"><span class="d1-when">10:05</span><span class="d1-log-who" style="color:${col.ink}">${BADGE_SVG}</span><span class="d1-log-icon">${ORDER_SVG}</span><span class="d1-tl-what"><span class="d1-log-text">DEFEND · soldier · 30 requested · 30 answered</span></span></li>
          <li class="d1-tl-entry d1-log is-refused"><span class="d1-when">10:04</span><span class="d1-log-who" style="color:${col.ink}">${BADGE_SVG}</span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">count mark</span></span><span class="d1-log-refused">refused</span></li>
          <li class="d1-tl-entry d1-log"><span class="d1-when">10:00</span><span class="d1-log-who"></span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">First contact</span></span></li>
          <li class="d1-tl-entry d1-log"><span class="d1-when">5:28</span><span class="d1-log-who"></span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">Queen 2 founded</span></span></li>
          ${filler}
        </ol>
      </section>
    `;
  }).join("");

  return `
    <style>${ROBOTO_FACES}${ROOT_TOKENS}${TOKENS}html,body{margin:0;height:100%;overflow:hidden;background:var(--aw-bg);color:var(--aw-ink)}:root{--aw-sans:'${font}',sans-serif;--aw-k0:#ffb000;--aw-k1:#00c2ff;--aw-k2:#ff1e1e;--aw-k3:#009078}${CSS}</style>
    <div class="d1 d1-hud score-band">
      <header class="d1-top"><div class="d1-brand"><a class="d1-home" href="/"><span class="d2-wordmark">Antwars</span></a><span class="d1-top-credit">AI vs AI</span></div></header>
      <div class="d1-below">
        <section class="d1-deck">
          <div class="sb-band">
            <header class="sb-clock-map"><p class="d1-clock">10:08 · 19:52 left</p><p class="d1-map"><span class="d1-glabel">Map</span><span class="d1-map-name">Strait</span></p></header>
            <section class="d1-score sb-comparison">
              <div class="sb-gauge"><h3 class="d1-ml">Kills</h3><div class="sb-bar"></div><div class="sb-values"><span class="sb-figure">1</span></div></div>
              <div class="sb-gauge"><h3 class="d1-ml">Territory</h3><div class="sb-bar"></div><div class="sb-values"><span class="sb-figure">25%</span></div></div>
              <div class="sb-gauge"><h3 class="d1-ml">Ants</h3><div class="sb-bar"></div><div class="sb-values"><span class="sb-figure">282</span></div></div>
              <section class="sb-hold"><h3 class="d1-ml">Territory hold</h3><div class="sb-hold-value">—</div></section>
            </section>
          </div>
          <div class="sb-deck-table">
            <div class="sb-columns"><span class="d1-ml">Colony</span><span class="d1-ml">Workers</span><span class="d1-ml">Soldiers</span><span class="d1-ml">Flyers</span><span class="d1-ml">Food</span><span class="d1-ml">Next spawn</span><span class="d1-ml">Ants</span><span class="d1-ml">Queens</span><span class="d1-ml">Queen kills</span><span class="d1-ml">History</span></div>
            ${teams}
          </div>
          <div class="sb-history-strip" role="region" aria-label="History" ${openCount === 0 ? "hidden" : ""}>
            <h3 class="d1-kicker sb-history-strip-title">History</h3>
            <div class="sb-history-cols">${stripCols}</div>
          </div>
        </section>
      </div>
      <section class="d1-frame"><p class="d1-legend"><span class="d1-mode">RECORDING</span></p><div class="sb-metadata"><span class="sb-meta-item">Free-for-all</span></div><div class="d1-window"></div><div class="d1-lane"><div class="d1-caption" data-kind="none"></div><div class="d1-controls"></div></div></section>
      <footer class="d1-foot"><span class="sb-rules-key"><a class="d2-link" href="/rules">Rules</a></span></footer>
    </div>
  `;
}

function narrowHistoryHtml(font: string, repeatRows = 0): string {
  const longIntent = "“clean up nearby enemy clusters at 24,25 and 26,26 instead of overextending west”";
  const unspaced = `“${"@".repeat(80)}”`;
  const filler = Array.from({ length: repeatRows }, (_, k) =>
    `<li class="d1-tl-entry d1-log"><span class="d1-when">${Math.floor(k / 60)}:${String(k % 60).padStart(2, "0")}</span><span class="d1-log-who"></span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">Queen 2 founded</span></span></li>`
  ).join("");
  return `
    <style>${ROBOTO_FACES}${ROOT_TOKENS}${TOKENS}html,body{margin:0;height:100%;overflow:hidden;background:var(--aw-bg);color:var(--aw-ink)}:root{--aw-sans:'${font}',sans-serif;--aw-k0:#ffb000;--aw-k1:#00c2ff;--aw-k2:#ff1e1e;--aw-k3:#009078}${CSS}</style>
    <div class="d1 d1-hud score-band">
      <header class="d1-top"><div class="d1-brand"><a class="d1-home" href="/"><span class="d2-wordmark">Antwars</span></a></div></header>
      <section class="d1-frame"><div class="d1-window"></div><div class="d1-lane"></div></section>
      <div class="d1-below">
        <section class="d1-deck">
          <section class="d1-team c0 is-history-open" style="--sb-ink:#ffb000">
            <div class="sb-sticky-bar">
              <header class="d1-team-head"><h2 class="d1-name c0">Very Large Colony</h2><span class="d1-team-members"><button class="d1-member" type="button"><span class="sb-seat-badge">${BADGE_SVG}</span><span class="sb-idle"></span></button></span></header>
              <button class="sb-history" type="button" aria-controls="colony-history-0" aria-expanded="true">≡</button>
            </div>
            <div class="sb-identity"><ol class="d1-agents"><li class="d1-agent-item c0"><button class="d1-agent" type="button"><span class="d1-who"><span class="d1-title-box"><span class="d1-title">FernGully</span></span></span></button></li></ol></div>
            <div class="d1-econ c0"><div class="d1-cell sb-workers"><span class="d1-ml">Workers</span><span class="d1-mv">92</span></div></div>
            <section class="d1-timeline c0" id="colony-history-0" tabindex="0" style="--sb-ink:#ffb000">
              <header class="sb-history-head">
                <h4 class="sb-history-col-name">Very Large Colony</h4>
                <h3 class="d1-kicker sb-history-kicker">History</h3>
                <dl class="sb-detail-stat"><dt class="d1-ml">Hatched</dt><dd class="d1-mv">1,378</dd></dl>
              </header>
              <ol class="d1-tl">
                <li class="d1-tl-entry d1-log" data-kind="defend"><span class="d1-when">10:05</span><span class="d1-log-who" style="color:#ffb000">${BADGE_SVG}</span><span class="d1-log-icon">${ORDER_SVG}</span><span class="d1-tl-what"><span class="d1-log-text">DEFEND · soldier · 30 requested · 30 answered</span></span></li>
                <li class="d1-tl-entry d1-log" data-kind="intent"><span class="d1-when">10:04</span><span class="d1-log-who" style="color:#ffb000">${BADGE_SVG}</span><span class="d1-log-icon">${ORDER_SVG}</span><span class="d1-tl-what"><span class="d1-log-text">attack Lake Hodges Colony's Queen 10</span> <span class="d1-log-intent">${longIntent}</span></span></li>
                <li class="d1-tl-entry d1-log is-refused" data-kind="refused"><span class="d1-when">10:03</span><span class="d1-log-who" style="color:#ffb000">${BADGE_SVG}</span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">count mark</span></span><span class="d1-log-refused">refused</span></li>
                <li class="d1-tl-entry d1-log is-arrival" data-kind="arrival"><span class="d1-when"></span><span class="d1-log-who" style="color:#ffb000">${BADGE_SVG}</span><span class="d1-log-icon">${ORDER_SVG}</span><span class="d1-tl-what"><span class="d1-log-lead">On arrival</span><span class="d1-log-text">attack</span> <span class="d1-log-intent">“rally at the nest”</span> <span class="d1-log-mark"><span class="d1-log-mark-word">mark</span><span class="d1-log-icon">${ORDER_SVG}</span><span class="d1-log-text">GATHER · any · 4 requested · 4 answered</span></span></span></li>
                <li class="d1-tl-entry d1-log" data-kind="unspaced"><span class="d1-when">9:58</span><span class="d1-log-who" style="color:#ffb000">${BADGE_SVG}</span><span class="d1-log-icon">${ORDER_SVG}</span><span class="d1-tl-what"><span class="d1-log-text">attack</span> <span class="d1-log-intent">${unspaced}</span></span></li>
                ${filler}
              </ol>
            </section>
          </section>
        </section>
      </div>
    </div>
  `;
}

describe("Score Band side-by-side History ledger", () => {
  it("renders open Histories in one strip at 1200 and 1280 px, keeping the 244 px board floor, intact four-digit headers, sticky scroll, adjacent refused, and distinct open button state", async () => {
    for (const defaultFontSize of [16, 32]) {
      const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", `--blink-settings=defaultFontSize=${defaultFontSize}`] });
      try {
        for (const width of [1200, 1280]) for (const font of ["Roboto", "Liberation Sans"]) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          try {
            await page.setContent(desktopPageHtml(font, 4, 24));
            await page.evaluate(() => document.fonts.ready);
            const m = await page.evaluate(() => {
              const table = document.querySelector<HTMLElement>(".sb-deck-table")!;
              const strip = document.querySelector<HTMLElement>(".sb-history-strip")!;
              const frame = document.querySelector<HTMLElement>(".d1-frame")!;
              const legend = document.querySelector<HTMLElement>(".d1-legend")!;
              const openBtn = document.querySelector<HTMLElement>("button.sb-history[aria-expanded='true']")!;
              const closedClone = openBtn.cloneNode(true) as HTMLElement;
              closedClone.setAttribute("aria-expanded", "false");
              openBtn.parentElement!.append(closedClone);
              const openBg = getComputedStyle(openBtn).backgroundColor;
              const openInk = getComputedStyle(openBtn).color;
              const closedBg = getComputedStyle(closedClone).backgroundColor;
              closedClone.remove();

              const stripRect = strip.getBoundingClientRect();
              const frameRect = frame.getBoundingClientRect();
              const legendRect = legend.getBoundingClientRect();
              const tableRect = table.getBoundingClientRect();

              const heads = [...strip.querySelectorAll<HTMLElement>(".sb-history-head")].map(h => {
                const name = h.querySelector<HTMLElement>(".sb-history-col-name")!;
                const dt = h.querySelector<HTMLElement>(".sb-detail-stat > dt")!;
                const dd = h.querySelector<HTMLElement>(".sb-detail-stat > dd")!;
                const nr = name.getBoundingClientRect(), dr = dt.getBoundingClientRect(), vr = dd.getBoundingClientRect();
                const statR = h.querySelector<HTMLElement>(".sb-detail-stat")!.getBoundingClientRect();
                const overlap = Math.min(nr.right, statR.right) - Math.max(nr.left, statR.left) > 0.5
                  && Math.min(nr.bottom, statR.bottom) - Math.max(nr.top, statR.top) > 0.5;
                return {
                  nameColor: getComputedStyle(name).color,
                  nameCut: name.scrollWidth > name.clientWidth + 1,
                  nameLines: new Set([...document.createRange ? (() => { const r = document.createRange(); r.selectNodeContents(name); return r.getClientRects(); })() : []].map(x => Math.round(x.top))).size,
                  dtCut: dt.scrollWidth > dt.clientWidth + 1,
                  ddCut: dd.scrollWidth > dd.clientWidth + 1,
                  overlap,
                  topBefore: Math.round(h.getBoundingClientRect().top),
                  colRight: Math.round(h.closest(".d1-timeline")!.getBoundingClientRect().right),
                  statRight: Math.round(statR.right),
                  nameRight: Math.round(nr.right),
                  dtHeight: Math.round(dr.height),
                  ddHeight: Math.round(vr.height),
                };
              });

              const refusedRow = strip.querySelector<HTMLElement>(".d1-tl-entry.is-refused")!;
              const refWhat = refusedRow.querySelector<HTMLElement>(".d1-tl-what")!.getBoundingClientRect();
              const refTag = refusedRow.querySelector<HTMLElement>(".d1-log-refused")!.getBoundingClientRect();
              const lists = [...strip.querySelectorAll<HTMLElement>(".d1-tl")].map(el => Math.round(el.getBoundingClientRect().height));

              strip.scrollTop = 120;
              const stickyTopAfter = Math.round(strip.querySelector<HTMLElement>(".sb-history-head")!.getBoundingClientRect().top);

              return {
                frameH: Math.round(frameRect.height),
                stripTop: Math.round(stripRect.top),
                stripBottom: Math.round(stripRect.bottom),
                tableBottom: Math.round(tableRect.bottom),
                legendTop: Math.round(legendRect.top),
                openBg, openInk, closedBg,
                heads, lists,
                refusedGap: Math.round(refTag.left - refWhat.right),
                stickyTopAfter,
                pageW: document.documentElement.scrollWidth,
              };
            });

            expect(m.frameH, `${width}px ${font} df=${defaultFontSize}: board floor`).toBeGreaterThanOrEqual(244);
            expect(m.stripTop).toBeGreaterThanOrEqual(m.tableBottom - 1);
            expect(m.stripBottom).toBeLessThanOrEqual(m.legendTop + 1);
            expect(m.openBg).not.toBe(m.closedBg);
            expect(m.openBg).toBe("rgb(248, 252, 252)");
            expect(m.openInk).toBe("rgb(18, 23, 25)");
            expect(m.lists.every(h => h > 0)).toBe(true);
            expect(m.refusedGap).toBeGreaterThanOrEqual(0);
            expect(m.refusedGap).toBeLessThanOrEqual(12);
            expect(m.pageW).toBe(width);
            expect(Math.abs(m.stickyTopAfter - m.stripTop)).toBeLessThanOrEqual(2);
            for (const h of m.heads) {
              expect(h.nameColor).toBe("rgb(233, 239, 240)");
              expect(h.nameCut).toBe(false);
              expect(h.dtCut).toBe(false);
              expect(h.ddCut).toBe(false);
              expect(h.overlap).toBe(false);
              expect(h.nameLines).toBe(1);
              expect(h.nameRight).toBeLessThanOrEqual(h.colRight + 1);
              expect(h.statRight).toBeLessThanOrEqual(h.colRight + 1);
            }
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
    }
  }, 60_000);

  it("keeps a usable scrollable desktop History strip and 244 px board floor when two colonies have 3–4 long multi-agent rows", async () => {
    for (const defaultFontSize of [16, 32]) {
      const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", `--blink-settings=defaultFontSize=${defaultFontSize}`] });
      try {
        for (const agentsPerColony of [3, 4]) for (const width of [1200, 1280]) for (const font of ["Roboto", "Liberation Sans"]) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          try {
            await page.setContent(desktopPageHtml(font, 2, 24, { visibleColonies: 2, agentsPerColony, longAgents: true }));
            await page.evaluate(() => document.fonts.ready);
            const m = await page.evaluate(() => {
              const table = document.querySelector<HTMLElement>(".sb-deck-table")!;
              const strip = document.querySelector<HTMLElement>(".sb-history-strip")!;
              const frame = document.querySelector<HTMLElement>(".d1-frame")!;
              const legend = document.querySelector<HTMLElement>(".d1-legend")!;
              const teams = [...table.querySelectorAll<HTMLElement>(".d1-team:not([hidden])")];
              const teamOverlap = teams.some((t, i) => i > 0 && t.getBoundingClientRect().top < teams[i - 1]!.getBoundingClientRect().bottom - 0.5);
              const colsLeft = table.querySelectorAll<HTMLElement>(".sb-columns > *")[1]!.getBoundingClientRect().left;
              const cellLeft = teams[0]!.querySelector<HTMLElement>(".sb-workers")!.getBoundingClientRect().left;
              const head = strip.querySelector<HTMLElement>(".sb-history-head")!;
              const stripRect = strip.getBoundingClientRect();
              const tableRect = table.getBoundingClientRect();
              const frameRect = frame.getBoundingClientRect();
              const legendRect = legend.getBoundingClientRect();
              const headH = Math.round(head.getBoundingClientRect().height);

              strip.scrollTop = 120;
              const stripScrolled = strip.scrollTop;
              const stickyAfter = Math.round(head.getBoundingClientRect().top);

              table.scrollTop = table.scrollHeight;
              const lastAgent = teams.at(-1)!.querySelectorAll<HTMLElement>(".d1-agent-item");
              const lastAgentRect = lastAgent[lastAgent.length - 1]!.getBoundingClientRect();
              const lastAgentVisible = lastAgentRect.bottom <= tableRect.bottom + 1 && lastAgentRect.top >= tableRect.top - 1;

              return {
                frameH: Math.round(frameRect.height),
                stripClientH: strip.clientHeight,
                stripScrollH: strip.scrollHeight,
                visibleRowH: strip.clientHeight - headH,
                stripScrolled,
                stickyDelta: Math.abs(stickyAfter - Math.round(stripRect.top)),
                stripTop: Math.round(stripRect.top),
                stripBottom: Math.round(stripRect.bottom),
                tableBottom: Math.round(tableRect.bottom),
                tableScrollable: table.scrollHeight > table.clientHeight,
                tableClientH: table.clientHeight,
                legendTop: Math.round(legendRect.top),
                teamOverlap,
                lastAgentVisible,
                colAlign: Math.abs(Math.round(colsLeft - cellLeft)),
                pageW: document.documentElement.scrollWidth,
              };
            });

            const tag = `${agentsPerColony}a ${width}px ${font} df=${defaultFontSize}`;
            expect(m.frameH, `${tag}: board floor`).toBeGreaterThanOrEqual(244);
            expect(m.stripClientH, `${tag}: usable strip height`).toBeGreaterThanOrEqual(70);
            expect(m.visibleRowH, `${tag}: visible row viewport`).toBeGreaterThanOrEqual(40);
            expect(m.stripScrollH, `${tag}: scrollable history`).toBeGreaterThan(m.stripClientH);
            expect(m.stripScrolled, `${tag}: scrolls history`).toBeGreaterThan(0);
            expect(m.stickyDelta, `${tag}: sticky header`).toBeLessThanOrEqual(2);
            expect(m.stripTop, `${tag}: strip below table`).toBeGreaterThanOrEqual(m.tableBottom - 1);
            expect(m.stripBottom, `${tag}: strip above legend`).toBeLessThanOrEqual(m.legendTop + 1);
            expect(m.tableClientH, `${tag}: table usable`).toBeGreaterThanOrEqual(88);
            expect(m.tableScrollable, `${tag}: table scrolls`).toBe(true);
            expect(m.teamOverlap, `${tag}: no team overlap`).toBe(false);
            expect(m.lastAgentVisible, `${tag}: last agent reachable`).toBe(true);
            expect(m.colAlign, `${tag}: columns aligned`).toBeLessThanOrEqual(1);
            expect(m.pageW, `${tag}: no horizontal overflow`).toBe(width);
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
    }
  }, 60_000);

  it("wraps History rows cleanly at 320, 390, 640, 195 and 160 CSS px with uncapped lists and sticky colony bar", async () => {
    for (const defaultFontSize of [16, 32]) {
      const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", `--blink-settings=defaultFontSize=${defaultFontSize}`] });
      try {
        for (const width of [320, 390, 640, 195, 160]) for (const font of ["Roboto", "Liberation Sans"]) {
          const height = width < 320 ? 900 : width === 640 ? 400 : 844;
          const page = await browser.newPage({ viewport: { width, height } });
          try {
            // At sub-320 CSS px (phone 200% zoom), keep the frame compact inside this isolated harness so History rows are measurable without changing HUD phone-zoom CSS.
            const isolateZoom = width < 240 ? `<style>.score-band .d1-frame{--d1-window-h:60px}</style>` : "";
            await page.setContent(narrowHistoryHtml(font, width >= 320 ? 80 : 0) + isolateZoom);
            await page.evaluate(() => document.fonts.ready);
            const m = await page.evaluate(() => {
              const tl = document.querySelector<HTMLElement>(".d1-tl")!;
              const tlCs = getComputedStyle(tl);
              const rows = [...document.querySelectorAll<HTMLElement>(".d1-tl-entry[data-kind]")].map(li => {
                const kind = li.dataset.kind!;
                const what = li.querySelector<HTMLElement>(".d1-tl-what")!;
                const cs = getComputedStyle(what);
                const brokenWords: string[] = [];
                if (kind !== "unspaced") {
                  const walker = document.createTreeWalker(what, NodeFilter.SHOW_TEXT);
                  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    for (const match of (n.textContent ?? "").matchAll(/\S+/g)) {
                      const range = document.createRange();
                      range.setStart(n, match.index!);
                      range.setEnd(n, match.index! + match[0].length);
                      if (new Set([...range.getClientRects()].map(r => Math.round(r.top))).size > 1) brokenWords.push(match[0]);
                    }
                  }
                }
                const when = li.querySelector<HTMLElement>(".d1-when")!;
                const ref = li.querySelector<HTMLElement>(".d1-log-refused");
                const refOverlap = ref && when.textContent
                  ? Math.min(when.getBoundingClientRect().right, ref.getBoundingClientRect().right) - Math.max(when.getBoundingClientRect().left, ref.getBoundingClientRect().left) > 0.5
                    && Math.min(when.getBoundingClientRect().bottom, ref.getBoundingClientRect().bottom) - Math.max(when.getBoundingClientRect().top, ref.getBoundingClientRect().top) > 0.5
                  : false;
                const refGap = ref ? Math.round(ref.getBoundingClientRect().left - what.getBoundingClientRect().right) : null;
                return {
                  kind,
                  cut: what.scrollWidth > what.clientWidth + 1,
                  ellipsis: cs.textOverflow === "ellipsis" && cs.overflowX === "hidden",
                  brokenWords,
                  refOverlap,
                  refGap,
                  right: Math.round(what.getBoundingClientRect().right),
                };
              });

              const kicker = document.querySelector<HTMLElement>(".sb-history-kicker")!.getBoundingClientRect();
              const stat = document.querySelector<HTMLElement>(".sb-detail-stat")!.getBoundingClientRect();
              const headOverlap = Math.min(kicker.right, stat.right) - Math.max(kicker.left, stat.left) > 0.5
                && Math.min(kicker.bottom, stat.bottom) - Math.max(kicker.top, stat.top) > 0.5;

              const below = document.querySelector<HTMLElement>(".d1-below")!;
              const bar = document.querySelector<HTMLElement>(".sb-sticky-bar")!;
              const btn = bar.querySelector<HTMLElement>(".sb-history")!.getBoundingClientRect();
              let stickyPinned = true;
              if (below.scrollHeight > below.clientHeight + 200) {
                below.scrollTop = 1200;
                const br = below.getBoundingClientRect();
                const barR = bar.getBoundingClientRect();
                stickyPinned = Math.abs(barR.top - br.top) <= 2;
              }
              return {
                maxHeight: tlCs.maxHeight,
                overflowY: tlCs.overflowY,
                rows, headOverlap, stickyPinned,
                btnW: Math.round(btn.width), btnH: Math.round(btn.height),
                pageW: document.documentElement.scrollWidth,
              };
            });

            expect(m.maxHeight).toBe("none");
            expect(m.overflowY).toBe("visible");
            expect(m.headOverlap).toBe(false);
            expect(m.stickyPinned).toBe(true);
            expect(m.btnW).toBeGreaterThanOrEqual(44);
            expect(m.btnH).toBeGreaterThanOrEqual(44);
            expect(m.pageW).toBeLessThanOrEqual(width + 1);
            for (const row of m.rows) {
              expect(row.cut, `${width}px ${font} ${row.kind}: cut`).toBe(false);
              expect(row.ellipsis, `${width}px ${font} ${row.kind}: ellipsis`).toBe(false);
              expect(row.brokenWords, `${width}px ${font} ${row.kind}: broken words`).toEqual([]);
              expect(row.refOverlap, `${width}px ${font} ${row.kind}: refused overlap`).toBe(false);
              expect(row.right, `${width}px ${font} ${row.kind}: right`).toBeLessThanOrEqual(width + 1);
              if (row.kind === "refused" && width >= 240) {
                expect(row.refGap).toBeGreaterThanOrEqual(0);
                expect(row.refGap).toBeLessThanOrEqual(12);
              }
            }
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
    }
  }, 60_000);

  it("renders First contact without an agent badge, resets desktop strip scroll on open, recovers narrow deep-scroll collapse, and anchors playback prepends", () => {
    const port = dom({ search: "", wide: false });
    Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
    const scroller = port.doc.createElement("div") as unknown as ElementPort & { scrollTop: number };
    scroller.scrollTop = 0;
    const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
    const economy = [0, 1].map(() => port.doc.createElement("div")) as unknown as HTMLElement[];
    const teams = mountTeams(port.doc, actions, { search: () => "", economy, narrowScroller: scroller as unknown as HTMLElement });
    for (const t of teams.teams) scroller.append(t as unknown as ElementPort);
    port.body.append(scroller, teams.historyStrip as unknown as ElementPort);
    teams.setWide(false);

    const makeFrame = (storyCount: number): Frame => {
      const f = new Frame();
      f.match = 1;
      f.tick = 100 + storyCount * 10;
      f.story = Array.from({ length: storyCount }, (_, i) => ({
        id: i + 1,
        kind: i === 0 ? "contact" : "queen_founded",
        tick: 10 + i * 10,
        colony: 0,
        agent: -1,
        x: 0,
        y: 0,
        queenId: i + 1,
      })) as unknown as Frame["story"];
      f.board = {
        setup: { mapW: 16, mapH: 16, ticksPerSecond: 10, matchTicks: 600, idleTicks: 300, overrunRadiusTiles: 2, queens: [[0, 0], [1, 1]], rated: true },
        queens: [{ id: 0, colony: 0, x: 0, y: 0, foundedTick: 0, lostTick: null, overrun: 0, hp: 100 }, { id: 0, colony: 1, x: 1, y: 1, foundedTick: 0, lostTick: null, overrun: 0, hp: 100 }],
        territory: new Uint8Array(0), held: [0, 0], marks: [], agents: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], hatched: [5, 3], result: null,
        food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 }, stores: [{ food: 0, nextHatchTick: 0, nextCost: 3 }, { food: 0, nextHatchTick: 0, nextCost: 3 }],
      } as unknown as Board;
      return f;
    };
    const show = (f: Frame) => teams.update({ frame: f, connection: "live", board: "3d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView, false);

    show(makeFrame(2));
    const team0 = teams.teams[0] as unknown as ElementPort;
    const btn0 = team0.byClass("sb-history")[0]!;
    btn0.click();

    // First contact event row has no agent badge SVG.
    const rows = team0.byClass("d1-tl-entry");
    const contactRow = rows.find(r => (r.getAttribute("aria-label") ?? "").includes("First contact"))!;
    expect(contactRow).toBeDefined();
    expect(contactRow.byClass("d1-log-who")[0]!.innerHTML ?? "").toBe("");

    // Playback prepend while scrolled down adjusts scroller.scrollTop by the anchor's top delta.
    scroller.scrollTop = 300;
    let anchorTop = 120;
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 390, width: 390, height: 500 });
    for (const r of rows) {
      r.getBoundingClientRect = () => ({ top: anchorTop, bottom: anchorTop + 28, left: 0, right: 374, width: 374, height: 28 });
    }
    const origInsert = team0.byClass("d1-tl")[0]!.insertBefore.bind(team0.byClass("d1-tl")[0]!);
    team0.byClass("d1-tl")[0]!.insertBefore = (node: ElementPort, ref: ElementPort | null) => {
      anchorTop += 28;
      return origInsert(node, ref);
    };
    show(makeFrame(3));
    expect(scroller.scrollTop).toBe(328);

    // Deep-scroll collapse pulls the collapsed colony back to the top of the narrow scroller.
    team0.getBoundingClientRect = () => ({ top: -250, bottom: 100, left: 0, right: 390, width: 390, height: 350 });
    btn0.click();
    expect(scroller.scrollTop).toBe(78);

    // Desktop strip resets scrollTop to 0 when a colony's History opens.
    teams.setWide(true);
    const strip = teams.historyStrip as unknown as ElementPort & { scrollTop: number };
    strip.scrollTop = 140;
    btn0.click();
    expect(strip.scrollTop).toBe(0);
    expect(strip.hidden).toBe(false);

    // Mounted HUD switches cleanly between wide and narrow modes via mountDeckHud.
    const hudPort = dom({ search: "", wide: true });
    Object.assign(hudPort.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
    const host = hudPort.doc.createElement("div") as unknown as ElementPort;
    hudPort.body.append(host);
    const hud = mountDeckHud({ doc: hudPort.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
    hud.update({ frame: makeFrame(1), connection: "live", board: "3d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView);
    expect(host.byClass("sb-history-strip")).toHaveLength(1);
    expect(host.byClass("sb-deck-table")).toHaveLength(1);
    expect(host.byClass("sb-deck-table")[0]!.byClass("sb-columns")).toHaveLength(1);
    expect(host.byClass("sb-deck-table")[0]!.byClass("d1-team")).toHaveLength(4);
    hud.destroy();
    teams.destroy();
  });
});
