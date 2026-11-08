/**
 * The "empty server, cold load" scene: the live page opened on a server with no match.
 * Connecting gives way to the newest stored recording (the bundled one is deleted, the server here holds one
 * in-process grid-scale-2 match), playing from its first frame under one line saying it is a
 * recording and that live matches start when the operator starts one; no notice, and nothing masks the page (an
 * earlier preview turned the whole page into an agent row's idle chip, with near-black status text).
 *
 * The scene also opens the recording state: a viewer-opened finished-match recording (?replay), with its date and Back
 * to live in the HUD's status line. In both states the mode line, the date and Back to live are whole on screen, none
 * over another, Back to live uncovered, and they hold their place through ten seconds of play (statusRowProblems).
 * Besides the given sizes it runs at the iPhone's own 393x659, and at the smaller landscape phone's 667x375.
 *
 * Writes DIR/<board>-<viewport>-empty-server-cold.jpg (before the first frame), DIR/<board>-<viewport>-empty-server.jpg
 * (the recording's first frame), DIR/<board>-<viewport>-empty-server-recording.jpg (the viewer-opened recording) and
 * DIR/<board>-empty-server.json, each with the webkit- prefix in the WebKit pass; every failed check goes to problems.
 *
 * Also the feed-drop scene, at 1080p and phone: a live viewer whose feed drops keeps the
 * last live frame with a readable Reconnecting… line, and the recording stands in only once /live/status says no
 * match is running. Writes DIR/<board>-<viewport>-feed-drop.jpg, DIR/<board>-<viewport>-feed-drop-no-match.jpg and
 * DIR/<board>-feed-drop.json.
 */
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Browser, Page } from "playwright-core";
import { decodeMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { RENDER_DELAY_MS } from "../src/buffer.ts";
import { RECONNECTING_LINE } from "../src/compose.ts";
import { FALLBACK_LABEL } from "../src/replay.ts";
import { WEB_DIR, defaultStoredRecording, enginePrefix, openClient, type ClientPage } from "./browser.ts";
import { scale2Packets, storedHistory } from "./scale2-recording.ts";

type Viewport = readonly [string, readonly [number, number], boolean];

/** What a mask or a lost class would change: the body's own box, the waiting panel, the notice and the page's line. */
function pageState(c: ClientPage) {
  return c.page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const waiting = document.getElementById("aw-waiting");
    return {
      body: { radius: body.borderTopLeftRadius, padding: body.paddingLeft, classes: document.body.className },
      waiting: waiting && !waiting.hidden ? waiting.textContent?.replace(/\s+/g, " ").trim() ?? "" : null,
      notice: document.getElementById("aw-match-status")?.textContent ?? null,
      // The HUD's status line: the 2D board's, or the deck's legend.
      line: document.querySelector(".d2-status, .d1-legend")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    };
  });
}

/** A server that has played lists its finished-match recordings (/live/replays): the scene serves two, as the live server would. */
export const STORED_REPLAYS = [{ seq: 12, match: 12, replayId: "2026-10-18T21-00-00-000Z-12" }, { seq: 13, match: 13, replayId: "2026-10-19T02-00-00-000Z-13" }] as const;
/**
 * The iPhone's own viewport, where the overlaps showed: Playwright's iPhone 15 profile, whose
 * Safari bars leave 393x659 of the screen. A page too short for its content is where rows give way.
 */
export const IPHONE_VIEWPORT: Viewport = ["iphone15", [393, 659], true];
/**
 * The smaller landscape phone (667x375, an iPhone SE turned), under 701 px wide, where a portrait rule later in the page
 * once pulled the status out of the landscape column and past the screen's edge, Back to live with it.
 */
export const LANDSCAPE_SMALL_VIEWPORT: Viewport = ["landscape667", [667, 375], true];

export interface Rect { x0: number; y0: number; x1: number; y1: number }
/**
 * The status line's items as laid out, each as its line boxes (an item may wrap): the mode line, the recording's date
 * and Back to live. On the 2D board they are .d2-mode-label, .d2-mode-detail and .d2-back; on the deck the mode line is
 * the legend's words (.d1-legend), whose last item is the date, and Back to live is .d1-back. An item not laid out, or
 * cut to no width, is null.
 */
export interface StatusRows {
  label: Rect[] | null;
  date: Rect[] | null;
  dateText: string;
  /** The deck: the date is the mode line's last item, laid out with it, so it has no box of its own. */
  dateInLine: boolean;
  back: Rect[] | null;
  /** Whether the topmost element at Back to live's centre is Back to live; null when it is not laid out. */
  backUncovered: boolean | null;
  screen: Rect;
}

function statusRows(c: ClientPage): Promise<StatusRows> {
  return c.page.evaluate(() => {
    const boxes = (...es: (Element | null)[]) => {
      const rs = es.flatMap((e) => (e ? [...e.getClientRects()] : [])).filter((r) => r.width > 0.5 && r.height > 0.5);
      return rs.length ? rs.map((r) => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom })) : null;
    };
    const legend = document.querySelector(".d1-legend");
    const link = document.querySelector<HTMLElement>(legend ? ".d1-back" : ".d2-back");
    const back = link && !link.hidden ? boxes(link) : null;
    const top = back ? document.elementFromPoint((back[0]!.x0 + back[0]!.x1) / 2, (back[0]!.y0 + back[0]!.y1) / 2) : null;
    const rest = legend?.querySelector(".d1-legend-rest")?.textContent ?? "";
    return {
      label: legend ? boxes(legend.querySelector(".d1-mode"), legend.querySelector(".d1-legend-rest")) : boxes(document.querySelector(".d2-mode-label")),
      date: legend ? null : boxes(document.querySelector(".d2-mode-detail")),
      dateText: legend ? (rest.split("·").at(-1) ?? "").trim() : document.querySelector(".d2-mode-detail")?.textContent ?? "",
      dateInLine: legend !== null,
      back,
      backUncovered: back === null ? null : top !== null && link!.contains(top),
      screen: { x0: 0, y0: 0, x1: window.innerWidth, y1: window.innerHeight },
    };
  });
}

const overlap = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
const onScreen = (a: Rect, s: Rect) => a.x0 >= s.x0 - 0.5 && a.y0 >= s.y0 - 0.5 && a.x1 <= s.x1 + 0.5 && a.y1 <= s.y1 + 0.5;

/**
 * The status line's failures, for the idle line or a viewer-opened recording: the mode line laid out; a recording's
 * date (on the deck, the legend's last item) and Back to live laid out, Back to live uncovered at its centre; the idle
 * line without Back to live; each item whole on screen; and none of them over another.
 */
export function statusRowProblems(s: StatusRows, recording: boolean): string[] {
  const found: string[] = [];
  if (s.label === null) found.push("no mode line");
  if (recording) {
    // The date alone, "15 Oct 2026" ("— Recorded match" dropped).
    const laidOut = s.dateInLine ? s.label !== null : s.date !== null;
    if (!laidOut || !/^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(s.dateText)) found.push(`no date line (it reads "${s.dateText}")`);
    if (s.back === null) found.push("no Back to live");
    else if (s.backUncovered === false) found.push("Back to live is covered at its centre");
  } else if (s.back !== null) found.push("the idle line shows Back to live");
  const items = [["the mode line", s.label], ["the date", s.date], ["Back to live", s.back]] as const;
  for (const [name, r] of items) if (r !== null && !r.every((b) => onScreen(b, s.screen))) found.push(`${name} is not whole on screen`);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [a, ra] = items[i]!;
      const [b, rb] = items[j]!;
      if (ra !== null && rb !== null && ra.some((x) => rb.some((y) => overlap(x, y)))) found.push(`${a} overlaps ${b}`);
    }
  }
  return found;
}

export async function captureEmptyServer(browser: Browser, board: "2d" | "3d", viewports: readonly Viewport[], out: string, webDir: string | undefined, problems: string[]): Promise<void> {
  const pre = enginePrefix(browser);
  const results: unknown[] = [];
  for (const [label, vp, phone] of [...viewports, IPHONE_VIEWPORT, LANDSCAPE_SMALL_VIEWPORT]) {
    const name = `${pre}${board}-${label}-empty-server`;
    let c: ClientPage | undefined;
    try {
      // The idle state. The page's clock stays paused until advanced (browser.ts), so a page that is ready here left
      // Connecting on the idle status, not on its time limit.
      c = await openClient(browser, { recording: "", emptyServer: true, replays: STORED_REPLAYS, width: vp[0], height: vp[1], tilt: false, webDir, board, phone });
      const cold = await pageState(c);
      writeFileSync(join(out, `${name}-cold.jpg`), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      await c.advance(RENDER_DELAY_MS);
      const frame = await c.frame();
      const playing = await pageState(c);
      const idleRows = await statusRows(c);
      await settle(c);
      writeFileSync(join(out, `${name}.jpg`), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      // Ten seconds on, the rows hold: the status keeps its place all through.
      await advanceFor(c, 10_000);
      const idleLater = await statusRows(c);
      const found: string[] = [];
      const stored = defaultStoredRecording(), firstTick = decodeMessage(unpackMessages(stored.bytes)[0]!).tick;
      if (!c.info.source.startsWith(`replay /replays/${stored.id}`)) found.push(`the page did not fall back to the newest stored recording (source ${c.info.source})`);
      for (const [when, state] of [["cold", cold], ["playing", playing]] as const) {
        if (state.body.radius !== "0px" || state.body.padding !== "0px") found.push(`${when}: the page body is shaped (radius ${state.body.radius}, padding ${state.body.padding}, class "${state.body.classes}")`);
        if (state.notice !== null) found.push(`${when}: the no-match notice shows over the recording`);
      }
      if (cold.waiting !== "Antwars Connecting…") found.push(`cold: the waiting panel says "${cold.waiting}", not the wordmark and Connecting…`);
      if (playing.waiting !== null) found.push("playing: the waiting panel is still up");
      if (!playing.line?.includes(FALLBACK_LABEL.idle)) found.push(`playing: the page's line is "${playing.line}", not the no-match recording line`);
      if (frame.playbackTick > firstTick + 1) found.push(`playing: the recording opened at tick ${frame.playbackTick}, not its first (${firstTick})`);
      found.push(...statusRowProblems(idleRows, false).map((p) => `idle: ${p}`), ...held(idleRows, idleLater).map((p) => `idle: ${p}`));
      await c.close();
      c = undefined;
      // The recording state: the viewer opens a finished match's recording (?replay), with its date and Back to live.
      c = await openClient(browser, { recording: "", replay: true, replays: STORED_REPLAYS, width: vp[0], height: vp[1], tilt: false, webDir, board, phone });
      await c.advance(RENDER_DELAY_MS);
      await c.frame();
      const recordingRows = await statusRows(c);
      await settle(c);
      writeFileSync(join(out, `${name}-recording.jpg`), await c.page.screenshot({ type: "jpeg", quality: 82, scale: "css" }));
      await advanceFor(c, 10_000);
      const recordingLater = await statusRows(c);
      found.push(...statusRowProblems(recordingRows, true).map((p) => `recording: ${p}`), ...held(recordingRows, recordingLater).map((p) => `recording: ${p}`));
      problems.push(...found.map((problem) => `${name}: ${problem}`));
      results.push({ name, viewport: vp, source: c.info.source, playbackTick: frame.playbackTick, cold, playing, idle: idleRows, recording: recordingRows, problems: found });
    } catch (e) {
      problems.push(`${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    } finally {
      if (c) {
        try { await c.close(); }
        catch (e) { problems.push(`${name}: closing client: ${String(e)}`); }
      }
    }
  }
  writeFileSync(join(out, `${pre}${board}-empty-server.json`), `${JSON.stringify(results, null, 2)}\n`);
}

/** Before a still: the page's CSS transitions (the bars' fills) run in real time, and WebKit paints the board a moment after its frame. */
async function settle(c: ClientPage): Promise<void> {
  await c.page.waitForTimeout(600);
  await c.frame();
}

/** Playback moved on by ms, a second at a time, the board drawn once at the end. */
async function advanceFor(c: ClientPage, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 1000) {
    await c.advance(Math.min(1000, ms - done));
    await c.frame(false);
  }
  await c.frame();
}

/** The status line's items where they were (1 px, as the motion check). */
function held(before: StatusRows, after: StatusRows): string[] {
  const moved: string[] = [];
  for (const key of ["label", "date", "back"] as const) {
    const a = before[key];
    const b = after[key];
    if ((a === null) !== (b === null)) moved.push(`${key} ${a === null ? "appeared" : "went"} during play`);
    else if (a !== null && b !== null && (a.length !== b.length || a.some((r, i) => [r.x0 - b[i]!.x0, r.y0 - b[i]!.y0, r.x1 - b[i]!.x1, r.y1 - b[i]!.y1].some((d) => Math.abs(d) > 1)))) moved.push(`${key} moved during play (top ${a[0]!.y0.toFixed(1)} to ${b[0]!.y0.toFixed(1)})`);
  }
  return moved;
}

type Status = { kind: "idle"; match: null } | { kind: "playing"; match: number };
/** Two seconds of play before the drop, so the board has drawn live frames when the feed goes; under the live inbox's cap (INBOX_CAP 30), since a fixture sends them at once. */
const PLAYED_TICKS = 20;

/**
 * A live server from one real origin, as page-polish.ts serves its stream: while `live` holds, /live/current sends an
 * in-process grid-scale-2 recording's first PLAYED_TICKS messages (a full snapshot, then play) and closes (the drop), asking the browser
 * not to retry for ten minutes; afterwards it has no match (404). /live/status answers `status`.
 */
async function startDropServer(webDir: string) {
  const root = resolve(webDir);
  const played = scale2Packets(PLAYED_TICKS).map((m) => `data: ${deflateRawSync(m).toString("base64")}\n\n`).join("");
  const stored = defaultStoredRecording();
  const state: { live: boolean; status: Status } = { live: true, status: { kind: "playing", match: 1 } };
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".bin": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path === "/live/status" || path === "/live/replays") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(path === "/live/status" ? JSON.stringify(state.status) : JSON.stringify({ replays: [] }));
      return;
    }
    // After the drop the page stands in with the newest stored match: the server holds one.
    const history = storedHistory(path, stored);
    if (history) { response.writeHead(200, { "content-type": history.type, "cache-control": "no-store" }); response.end(history.body); return; }
    if (path === "/live/current") {
      if (!state.live) { response.writeHead(404).end("not found"); return; }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(`retry: 600000\n${played}`);
      return;
    }
    const file = resolve(root, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      response.end(bytes);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  return {
    state,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

/** Node's clock is real here: a client that never gets ready fails the scene instead of hanging the run. */
async function within<T>(work: Promise<T>, what: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_done, fail) => { timer = setTimeout(() => fail(new Error(`${what} timed out after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** The dropped live page: its connection line, that line's contrast on the page, and anything covering the last frame. */
function dropState(page: Page) {
  return page.evaluate(() => {
    // The HUD's connection line: the 2D board's, or the deck's legend.
    const link = document.querySelector<HTMLElement>(".d2-connection") ?? document.querySelector<HTMLElement>(".d1-legend");
    const waiting = document.getElementById("aw-waiting");
    const rgba = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
    const channel = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const luminance = (c: number[]) => 0.2126 * channel(c[0] ?? 0) + 0.7152 * channel(c[1] ?? 0) + 0.0722 * channel(c[2] ?? 0);
    const page = rgba(getComputedStyle(document.body).backgroundColor);
    const ink = link ? rgba(getComputedStyle(link).color) : [0, 0, 0];
    const alpha = ink[3] ?? 1;
    const seen = [0, 1, 2].map((i) => (ink[i] ?? 0) * alpha + (page[i] ?? 0) * (1 - alpha));
    const [light, dark] = [luminance(seen), luminance(page)].sort((a, b) => b - a);
    return {
      link: link?.textContent ?? null,
      linkShown: !!link && link.getClientRects().length > 0 && getComputedStyle(link).visibility !== "hidden",
      contrast: (light! + 0.05) / (dark! + 0.05),
      waiting: !!waiting && !waiting.hidden,
      notice: document.getElementById("aw-match-status") !== null,
      recording: document.querySelector(".d2-status.is-replay") !== null || document.querySelector(".d1-mode")?.textContent === "RECORDING",
    };
  });
}

export async function captureFeedDrop(browser: Browser, board: "2d" | "3d", viewports: readonly Viewport[], out: string, webDir: string | undefined, problems: string[]): Promise<void> {
  const results: unknown[] = [];
  for (const [label, vp, phone] of viewports.filter(([name]) => name === "1080p" || name === "phone")) {
    const name = `${enginePrefix(browser)}${board}-${label}-feed-drop`;
    const found: string[] = [];
    const errors: string[] = [];
    const server = await startDropServer(webDir ?? WEB_DIR);
    const context = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, deviceScaleFactor: 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    try {
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${server.origin}/index.html?capture=1&tilt=0&board=${board}`);
      const live = await within(page.evaluate(() => window.__antwar.ready), `${name}: the live page`);
      server.state.live = false;
      if (live.source !== "/live/current") found.push(`the page did not open live (source ${live.source})`);
      await page.waitForTimeout(RENDER_DELAY_MS + 1500);
      await page.evaluate(() => window.__antwar.frame());
      const drop = await dropState(page);
      writeFileSync(join(out, `${name}.jpg`), await page.screenshot({ type: "jpeg", quality: 82 }));
      if (!drop.link?.includes(RECONNECTING_LINE) || !drop.linkShown) found.push(`the dropped feed's line is ${JSON.stringify(drop.link)} (shown: ${drop.linkShown}), not ${RECONNECTING_LINE}`);
      if (drop.contrast < 4.5) found.push(`the ${RECONNECTING_LINE} line's contrast is ${drop.contrast.toFixed(2)}:1, under 4.5:1`);
      if (drop.waiting || drop.notice || drop.recording) found.push(`the last live frame is covered or replaced (waiting ${drop.waiting}, notice ${drop.notice}, recording ${drop.recording})`);
      // The server now says no match is running: after a few answers (source.ts DROP_CHECKS) the page reloads into the recording.
      const reloaded = page.waitForEvent("load", { timeout: 10_000 });
      server.state.status = { kind: "idle", match: null };
      await reloaded;
      const after = await within(page.evaluate(() => window.__antwar.ready), `${name}: the recording`);
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__antwar.frame());
      const line = await page.evaluate(() => document.querySelector(".d2-status, .d1-legend")?.textContent?.replace(/\s+/g, " ").trim() ?? null);
      writeFileSync(join(out, `${name}-no-match.jpg`), await page.screenshot({ type: "jpeg", quality: 82 }));
      if (!after.source.startsWith(`replay /replays/${defaultStoredRecording().id}`)) found.push(`with no match running, the page did not play the recording (source ${after.source})`);
      if (!line?.includes(FALLBACK_LABEL.idle)) found.push(`with no match running, the line is ${JSON.stringify(line)}`);
      results.push({ name, viewport: vp, drop, recording: { source: after.source, line } });
    } catch (e) {
      found.push(e instanceof Error ? e.stack ?? e.message : String(e));
    } finally {
      found.push(...errors.map((e) => `page error: ${e}`));
      problems.push(...found.map((problem) => `${name}: ${problem}`));
      await context.close().catch(() => undefined);
      await server.close();
    }
  }
  writeFileSync(join(out, `${enginePrefix(browser)}${board}-feed-drop.json`), `${JSON.stringify(results, null, 2)}\n`);
}
