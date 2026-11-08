/** Local, read-only portrait-fit capture. Synthetic transport follows the locked lobby-dock capture;
 * it is not genuine-live, real-store, WebKit or physical-device evidence. No product server or joins. */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { chromium, webkit, type Page } from "playwright-core";
import { unpackMessages } from "../../src/live/snapshot.ts";

export type Box = { x: number; y: number; width: number; height: number };
export type Target = { label: string; box: Box; visible: boolean; centerHits: boolean; interceptedByEntry: boolean };
export type PortraitFit = {
  targets: Target[];
  landmarks: Record<string, Box>;
  scroll: { name: string; width: number; height: number; scrollWidth: number; scrollHeight: number; x: number; y: number }[];
};

export function portraitFitProblems(snapshot: PortraitFit, width = 393, height = 659): string[] {
  const problems: string[] = [];
  for (const target of snapshot.targets.filter(target => target.visible)) {
    const { x, y, width: w, height: h } = target.box;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h < 44) problems.push(`${target.label}: invalid or short target`);
    if (x < 0 || y < 0 || x + w > width || y + h > height) problems.push(`${target.label}: outside viewport`);
    // Only the separate entry checks own a directory/lobby hit. All other interception fails this check.
    if (!target.centerHits && !target.interceptedByEntry) problems.push(`${target.label}: intrinsic centre interception`);
  }
  for (const root of snapshot.scroll) {
    if (root.scrollHeight > root.height || root.scrollWidth > root.width || root.x !== 0 || root.y !== 0) problems.push(`${root.name}: scroll overflow`);
  }
  return problems;
}

export function portraitMovement(before: PortraitFit, after: PortraitFit): string[] {
  const problems: string[] = [];
  for (const name of ["stage"] as const) {
    for (const key of ["x", "y", "width", "height"] as const) {
      if (!before.landmarks[name] || !after.landmarks[name]
        || Math.abs(before.landmarks[name]![key] - after.landmarks[name]![key]) > 1) problems.push(`${name} ${key} moved`);
    }
  }
  return problems;
}

export async function measurePortraitFit(page: Page): Promise<PortraitFit> {
  return page.evaluate(() => {
    const box = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    // Every control of the HUD: its buttons and links.
    const targets = [...document.querySelectorAll<HTMLElement>(".aw-hud :is(button, [role=button], a[href])")].map(node => {
      const rect = box(node), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { label: node.getAttribute("aria-label") || node.textContent!.trim(), box: rect,
        visible: node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && rect.width > 0 && rect.height > 0,
        centerHits: hit === node || (!!hit && node.contains(hit)),
        interceptedByEntry: !!hit?.closest("#aw-match-directory,.aw-lobby-open,#aw-lobby-controls") };
    });
    // The board's area: the host's (window.__antwar.boardArea()).
    const area = (window as any).__antwar.boardArea();
    const landmarks: Record<string, { x: number; y: number; width: number; height: number }> = { stage: { x: area.x0, y: area.y0, width: area.x1 - area.x0, height: area.y1 - area.y0 } };
    const scroll = [document.documentElement, document.body].map(node => ({
      name: node.className || node.tagName, width: node.clientWidth, height: node.clientHeight,
      scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, x: node.scrollLeft, y: node.scrollTop,
    }));
    return { targets, landmarks, scroll };
  });
}

async function capture() {
  const root = resolve(import.meta.dirname, "../.."), dist = resolve(root, "web/dist");
  const replayId = "2026-10-15T18-00-00-000Z-2";
  const bytes = readFileSync(resolve(root, "web/public/replays/agents.bin"));
  const messages = unpackMessages(bytes).slice(0, 20);
  const fixtures: Record<string, unknown> = {
    "/matches": { matches: [{ id: replayId }], nextPageToken: null },
    "/live/replays": { replays: [] }, "/live/status": { kind: "playing", match: 1 },
    "/watch/catalog": { matches: [], lobbies: [] },
  };
  const responses = new Set<import("node:http").ServerResponse>();
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    if (path === "/live/current") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      responses.add(res); req.on("close", () => responses.delete(res));
      for (const message of messages) res.write(`data: ${deflateRawSync(message).toString("base64")}\n\n`);
      return;
    }
    if (path in fixtures) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(fixtures[path])); return; }
    if (path === `/replays/${replayId}`) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(bytes); return; }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${dist}/`) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    let data = readFileSync(file);
    if (path === "/") data = Buffer.from(data.toString().replace("<head>", '<head><meta name="antwar-lobbies" content="true"><meta name="antwar-public-matches" content="true">'));
    const ext = file.split(".").at(-1)!;
    res.writeHead(200, { "Content-Type": ({ html: "text/html", js: "text/javascript", css: "text/css", woff2: "font/woff2" } as Record<string, string>)[ext] || "application/octet-stream" }); res.end(data);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const engine = process.env.PORTRAIT_ENGINE === "webkit" ? "webkit" : "chromium";
  const output: { engine: string; startedAt: string; fixture: string; scenes: unknown[]; problems: string[]; finishedAt?: string } = {
    engine, startedAt: new Date().toISOString(), fixture: "Synthetic live SSE / named stored replay using locked historical agents.bin; not genuine live or real server storage", scenes: [], problems: [],
  };
  let browser;
  try {
    browser = await (engine === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] }));
    for (const board of ["2d", "3d"] as const) for (const mode of ["live", "replay"] as const) {
      const context = await browser.newContext({ viewport: { width: 393, height: 659 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      const errors: string[] = [];
      await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) && route.request().method() === "GET" ? route.continue() : route.abort());
      const page = await context.newPage(); page.on("pageerror", e => errors.push(String(e)));
      try {
        await page.goto(`${origin}/?${mode === "replay" ? "replay&" : ""}board=${board}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => !!(window as any).__antwar, { timeout: 30000 });
        const ready = await page.evaluate(() => (window as any).__antwar.ready);
        await page.evaluate(() => document.fonts.ready);
        if (board === "2d") await page.waitForSelector(".d2-btn-board", { state: "attached" });
        await page.waitForTimeout(1300);
        const snapshots: PortraitFit[] = [];
        for (let i = 0; i < 3; i++) { snapshots.push(await measurePortraitFit(page)); await page.waitForTimeout(250); }
        const problems = snapshots.flatMap(portraitFit => portraitFitProblems(portraitFit));
        for (const snapshot of snapshots.slice(1)) problems.push(...portraitMovement(snapshots[0]!, snapshot));
        const visible = snapshots[0]!.targets.filter(target => target.visible).map(target => target.label);
        if (board === "3d" && !String(ready.rendererName).includes("babylon")) problems.push("3D renderer unavailable");
        await page.evaluate(() => { window.scrollTo(200, 200); for (const node of [document.documentElement, document.body]) node.scrollTo(200, 200); });
        const afterScroll = await measurePortraitFit(page); problems.push(...portraitFitProblems(afterScroll));
        problems.push(...errors);
        output.scenes.push({ board, mode, ready, snapshots, afterScroll, problems });
        output.problems.push(...problems.map(problem => `${board}/${mode}: ${problem}`));
        console.log(board, mode, JSON.stringify({ visible, landmarks: snapshots[0]!.landmarks, problems }));
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close(); for (const response of responses) response.end(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    output.finishedAt = new Date().toISOString();
    writeFileSync(process.env.PORTRAIT_OUTPUT || "/tmp/portrait-fit.json", JSON.stringify(output, null, 2));
  }
  if (output.problems.length) throw new Error(output.problems.join("\n"));
}
if (import.meta.main) await capture();
