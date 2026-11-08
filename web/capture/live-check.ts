/**
 * The page on a live match stream, on the capture host's
 * SwiftShader WebGL2, in real time: a scripted match runs on the real sim and
 * is pushed tick by tick into src/live/hub.ts, served over real SSE beside the
 * built client (web/dist) by one local HTTP server.
 *
 *   node web/capture/live-check.ts --serve [--size large|default] [--delay S] [--port N]
 *       serve a scripted match and the client until stopped; open the printed URL
 *   node web/capture/live-check.ts [--keep DIR]
 *       build the client, run the checks, keep screenshots and results in DIR
 *
 * Until the game server mounts the stream, this is the locally
 * running match stream the browser checks run against.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import type { Browser, Page } from "playwright-core";
import type { SimConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "../../src/live/config.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { LARGE_CONFIG, RECORD_CONFIG, scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import type { MatchAccess } from "../../src/live/match-access.ts";
import { matchWatchStatus, publicMatchCatalog, type PublicColonies, type PublicSeat } from "../../src/live/match-catalog.ts";
import type { RecordHandoff } from "../../src/records/handoff.ts";
import { historyBytes, type MatchRecord } from "../../src/replays/history.ts";
import type { HistorySummary } from "../../src/replays/history-source.ts";
import type { ReplayStore } from "../../src/replays/store.ts";
import { tickLine } from "../../src/sim/log.ts";
import { OUT_DIR, REPO_ROOT, WEB_DIR, addCaptureReaders, checkRenderer, launchBrowser, scalePng } from "./browser.ts";
import type { ClientInfo, FrameResult } from "../src/main.ts";

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const TICK_MS = 100;
/** An agent that joins and never calls again, so the roster shows it idle after 90 s. */
export const LAZY_AGENT = "agent-lazy";

export interface LiveMatch {
  seq: number;
  /** The public lobby the match is watched and listed under (/watch/*). */
  lobbyId: string;
  script: ScriptOptions;
  state: SimState;
  /** Set when the sim reports a result: the final tick. */
  finalTick: number | null;
}

/** A scripted match pushed in real time into a hub served with the client. */
export class LiveServer {
  readonly hub: LiveHub;
  private server: Server;
  private timer: NodeJS.Timeout | null = null;
  port = 0;
  match: LiveMatch | null = null;
  /** Fired after every pushed tick. */
  onTick: ((m: LiveMatch) => void) | null = null;
  /** Every lobby this server has played, with its access; matches still held by the hub, for their seats. */
  private readonly lobbies = new Map<string, MatchAccess>();
  private readonly live = new Map<string, LiveMatch>();
  /** What the hub saved of each finished match, by replay id: its recording (gzip) and its built record. */
  private readonly replays = new Map<string, Uint8Array>();
  private readonly records = new Map<string, { record: MatchRecord; body: Uint8Array }>();
  private readonly building = new Set<NodeJS.Timeout>();

  constructor(config: LiveConfig) {
    // Recorded as a slot server records: the hub's replay upload and match-end inputs land here,
    // and each record is built by the record service's own builder once match end plus the delay has passed.
    const replayStore: ReplayStore = { create: async (o) => { if (o.name.endsWith(".bin")) this.replays.set(o.name.slice(0, -4), o.body); } };
    const recordHandoff: RecordHandoff = {
      submit: (inputs) => {
        const timer = setTimeout(() => {
          this.building.delete(timer);
          void historyBytes({ id: inputs.id, binary: inputs.binary, logLines: inputs.logLines, endedAt: inputs.endedAt }).then((body) => {
            this.records.set(inputs.id, { record: JSON.parse(new TextDecoder().decode(body)) as MatchRecord, body });
          }, (error: unknown) => console.error(`match record ${inputs.id} not built: ${error instanceof Error ? error.message : String(error)}`));
        }, Math.max(0, (inputs.publishAfter ?? 0) - Date.now()));
        this.building.add(timer);
      },
    };
    this.hub = new LiveHub({ config, replayStore, recordHandoff, captureMatchLogs: true });
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path.startsWith("/live/") || path.startsWith("/watch/live/")) {
        this.hub.handle(req, res);
        return;
      }
      if (path.startsWith("/watch/") || path === "/matches" || path.startsWith("/matches/") || path.startsWith("/replays/")) {
        this.routes(path, res);
        return;
      }
      const file = join(WEB_DIR, normalize(path === "/" ? "/index.html" : path));
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
  }

  /** The game server's /watch/* and /matches answers (src/live/watch-routes.ts, src/replays/history-routes.ts) from what this server played. */
  private routes(path: string, res: ServerResponse): void {
    const json = (status: number, value?: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (path === "/watch/catalog") {
      const matches = this.hub.catalogMatches();
      for (const lobbyId of this.live.keys()) if (!matches.some((m) => m.lobbyId === lobbyId)) this.live.delete(lobbyId);
      const players = new Map([...this.live].map(([lobbyId, m]) => [lobbyId, seats(m.state)] as const));
      return json(200, publicMatchCatalog(matches, [], players));
    }
    if (path === "/matches") {
      const recorded = [...this.records.values()].sort((a, b) => (a.record.id < b.record.id ? 1 : -1));
      return json(200, { matches: recorded.map(({ record }) => summary(record)), nextPageToken: null });
    }
    const status = /^\/watch\/status\/([^/]+)$/.exec(path);
    if (status) {
      const lobbyId = decodeURIComponent(status[1]!);
      const access = this.lobbies.get(lobbyId);
      // A lobby no longer held by the hub has finished its delayed playback.
      return access ? json(200, this.hub.watchStatus(lobbyId) ?? matchWatchStatus(access, "finished")) : json(404);
    }
    const ratings = /^\/watch\/ratings\/([^/]+)$/.exec(path);
    // Scripted matches are unrated: a recorded one has no stored rating changes.
    if (ratings) return this.records.has(decodeURIComponent(ratings[1]!)) ? json(200, { ratings: [] }) : json(404);
    const record = /^\/matches\/([^/]+)$/.exec(path);
    const stored = record && this.records.get(decodeURIComponent(record[1]!));
    if (stored) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(stored.body);
      return;
    }
    const replay = /^\/replays\/([^/]+)$/.exec(path);
    const bytes = replay && this.replays.get(decodeURIComponent(replay[1]!));
    if (bytes) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "gzip", "cache-control": "no-store" }).end(bytes);
      return;
    }
    json(404);
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  /** Start a match now, one tick every 100 ms of real time; the lazy agent joins with the scripted ones, or at the tick given. */
  start(seq: number, script: ScriptOptions, lazy: boolean | number = false): LiveMatch {
    let state = createMatch(script.seed, script.config);
    // A public, unrated lobby; at no delay the game's zero-delay class, since the hub holds every other public match at least 60 s.
    const lobbyId = randomUUID();
    const access: MatchAccess = this.hub.config.delaySeconds === 0
      ? { lobbyId, visibility: "public", rated: false, mode: "house-1v1" }
      : { lobbyId, visibility: "public", rated: false };
    this.hub.startMatch(seq, state, access);
    const m: LiveMatch = { seq, lobbyId, script, state, finalTick: null };
    this.lobbies.set(lobbyId, access);
    this.live.set(lobbyId, m);
    this.match = m;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (state.result !== null) return;
      const inputs: SimInput[] = scriptedInputs(state, script);
      if (state.tick === (lazy === true ? 0 : lazy)) inputs.push({ type: "join", agentId: LAZY_AGENT, modelLabel: "lazy-model" });
      this.hub.appendLog(seq, tickLine(state.tick, inputs));
      const out = step(state, inputs);
      state = out.state;
      m.state = state;
      this.hub.pushTick(seq, out);
      if (state.result !== null) m.finalTick = state.tick;
      this.onTick?.(m);
    }, TICK_MS);
    return m;
  }

  /** Drop every open stream connection, as a network interruption would. */
  interrupt(): void {
    this.server.closeAllConnections();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.building) clearTimeout(timer);
    this.hub.close();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
/** A running match's seats by colony as the Matches page's Live now row names them: each agent's model label, unrated. */
function seats(state: SimState): PublicColonies {
  const colonies: [PublicSeat[], PublicSeat[]] = [[], []];
  for (const agent of [...state.agents].sort((a, b) => a.joinSeq - b.joinSeq)) {
    colonies[agent.colony].push({ displayName: agent.modelLabel || agent.id, rating: null, rd: null, ratedMatches: null });
  }
  return colonies;
}

/** The public summary /matches lists for a built record (src/replays/history-source.ts HistorySummary). */
function summary(r: MatchRecord): HistorySummary {
  return {
    id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, simulationEndedAt: r.simulationEndedAt,
    winner: r.result?.winner ?? null, reason: r.result?.reason ?? null, decidedBy: r.result?.decidedBy ?? null,
    seats: r.seats.map(({ seat, colony, modelLabel, thinkingLevel, serviceTier, handle }) => ({ seat, colony, modelLabel, thinkingLevel, serviceTier, handle })),
    status: r.status, unavailable: r.unavailable,
  };
}

export function scripts(size: string): ScriptOptions {
  const large = size === "large";
  const config: SimConfig = large ? LARGE_CONFIG : RECORD_CONFIG;
  return { seed: 6006, config, agents: large ? 50 : 10, ticks: config.matchTicks, attack: true };
}

async function serve(size: string, delay: number, port: number) {
  const server = new LiveServer({ ...DEFAULT_LIVE_CONFIG, delaySeconds: delay });
  const url = await server.listen(port);
  let seq = 1;
  const run = () => {
    const m = server.start(seq, scripts(size), true);
    server.onTick = (x) => {
      if (x.finalTick === null || x !== m) return;
      server.hub.setNextStart(seq, null);
      seq++;
      setTimeout(run, delay * 1000 + 30_000);
    };
  };
  run();
  // A public match's delay is at least 60 s unless it is the zero-delay class (LiveServer.start).
  console.log(`serving a scripted ${size} match at ${url}/index.html (delay ${delay === 0 ? 0 : Math.max(delay, 60)} s); Ctrl-C to stop`);
}

// ------------------------------------------------------------------ checks

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openPage(base: string, width: number, height: number, query: string): Promise<{ page: Page; info: ClientInfo; browser: Browser; close(): Promise<void> }> {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await addCaptureReaders(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[page] ${e.message}`));
  // These checks exercise the established 2D capture contract, not the public renderer default.
  const params = new URLSearchParams(query);
  params.set("board", "2d");
  await page.goto(`${base}/index.html?${params}`);
  await page.waitForFunction(() => window.__antwar !== undefined);
  // The client reloads itself once when a delayed live match goes live (web/src/source.ts).
  const info = await acrossOneReload(page, () => page.evaluate(() => window.__antwar.ready));
  const mismatch = checkRenderer(info.rendererString);
  if (mismatch) {
    await browser.close();
    throw mismatch;
  }
  return { page, info, browser, close: () => browser.close() };
}

/** Run read; if the client's own one reload destroys its context, wait for the reloaded page and run it once more. */
async function acrossOneReload<T>(page: Page, read: () => Promise<T>): Promise<T> {
  return read().catch(async (e: unknown) => {
    if (!String(e).includes("Execution context was destroyed")) throw e;
    await page.waitForLoadState("load");
    await page.waitForFunction(() => window.__antwar !== undefined);
    await page.evaluate(() => window.__antwar.ready);
    return read();
  });
}

async function waitFor<T>(page: Page, what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
    void page;
  }
}

const frameOf = (page: Page) => page.evaluate(() => window.__antwar.frame()) as Promise<FrameResult>;

const api = <T>(page: Page, fn: () => T) => page.evaluate(fn) as Promise<Awaited<T>>;

/** One look at the page's result panel: the playback tick, whether the result shows, its text, and whether "wins" is anywhere on the page. */
export interface ResultPoll {
  tick: number;
  final: number | null;
  shown: boolean;
  text: string;
  wins: boolean;
}

/**
 * Poll the page every 250 ms until its result panel shows, recording each poll with
 * the final tick the caller knows at that moment (from the match, never the page).
 * The caller judges the polls.
 */
export async function pollResult(page: Page, finalTick: () => number | null, timeoutMs: number): Promise<ResultPoll[]> {
  const polls: ResultPoll[] = [];
  await waitFor(page, "the result", async () => {
    const r = await page.evaluate(() => {
      const f = window.__antwar.frame();
      const res = document.querySelector(".d1-result") as HTMLElement;
      return { tick: f.playbackTick, shown: !res.hidden, text: res.innerText, wins: /\bwins\b/.test(document.body.innerText) };
    });
    polls.push({ ...r, final: finalTick() });
    return r.shown ? r : null;
  }, timeoutMs);
  return polls;
}

async function checks(keep: string) {
  mkdirSync(keep, { recursive: true });
  await build({ configFile: join(REPO_ROOT, "web/vite.config.ts"), logLevel: "warn" });
  const results: Check[] = [];
  const record = (name: string, pass: boolean, detail?: unknown) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
  };
  const shot = async (page: Page, name: string) => {
    const file = join(keep, `${name}.png`);
    writeFileSync(file, await page.screenshot({ type: "png" }));
    return file;
  };
  let rendererString = "";

  // ---- 1. The crowded 2,000-ant match with 50 agents, no delay: board, look, labels, squads, roster.
  {
    const server = new LiveServer({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    const base = await server.listen();
    const match = server.start(1, scripts("large"), true);
    const p = await openPage(base, 1920, 1080, "");
    rendererString = p.info.rendererString;
    const { page } = p;
    try {
      record("renderer is SwiftShader on WebGL2", p.info.rendererString.includes("SwiftShader") && p.info.webgl2, p.info.rendererString);
      // Whole board by default.
      const corners = await page.evaluate(([w, h]) => [window.__antwar.tileToScreen(0, 0), window.__antwar.tileToScreen(w, h)], [p.info.mapW, p.info.mapH]);
      const whole = corners[0]![0] >= 0 && corners[0]![1] >= 0 && corners[1]![0] <= 1920 && corners[1]![1] <= 1080;
      record("the whole board shows by default", whole, corners);
      // Look elements once the battle is on: fights, corpses, marks as markers, chat lines.
      const battle = await waitFor(page, "a battle with corpses", async () => {
        const f = await frameOf(page);
        return f.fights > 0 && f.corpses > 0 && f.marks.markers > 0 && f.chat > 0 ? f : null;
      }, 150_000);
      record("battle shockwaves and particles, corpses fading, marks as markers and chat lines are on screen", true, { fights: battle.fights, corpses: battle.corpses, marks: battle.marks, chat: battle.chat });
      await shot(page, "look-battle-1080p");
      // Defaults with no URL parameter: trails on, tilt-shift off so the board is sharp.
      const defaults = await api(page, () => window.__antwar.options());
      record("trails on and tilt-shift off by default", defaults.trails === true && defaults.tilt === false, defaults);
      // The crowded scene: every live mark drawn as a marker, no overlapping badges.
      const crowded = await waitFor(page, "every agent's marks live", async () => {
        const f = await frameOf(page);
        return f.marks.marks >= 150 ? f : null;
      }, 120_000);
      await sleep(1500);
      // One frame, read in one task so the page cannot lay out again in between: what is drawn (not
      // what the placer reserved) for every visible squad badge, and the roster.
      // A badge is never dropped (words.ts placeBadges): with no free spot beside its ant it may overlap
      // another, so an overlap counts only where the later-placed badge had a free spot. Copied from words.ts
      // (BADGE_SPOTS, the placer's GAP, markerRect's MARK_DOT.ring + 3), which the harness cannot import.
      const layout = { spots: [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1], [0, -2], [0, 2], [2, 0], [-2, 0]], gap: 4, markerHalf: 13 };
      const peak = await page.evaluate(({ spots, gap, markerHalf }) => {
        const frame = window.__antwar.frame();
        const drawn = window.__antwar.drawnLabels();
        // The HUD's agent rows: each row's title (its handle, else its model) and its order (the order icon's title).
        const roster = [...document.querySelectorAll<HTMLElement>(".d2-agent-item")].map((r) => ({ name: r.querySelector(".d2-agent-title")?.textContent ?? "", order: r.querySelector(".d2-order")?.getAttribute("title") ?? "" }));
        type R = { x0: number; y0: number; x1: number; y1: number };
        const hit = (a: R, b: R) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        // Each squad's anchor (the ant nearest its mean, compose.ts badgeAnchors), in placement order: larger squads, then agent index.
        const anchors: { agent: number; n: number; x: number; y: number }[] = [];
        for (let agent = 0; agent < frame.agents; agent++) {
          const ants = window.__antwar.squadAnts(agent);
          if (!ants.length) continue;
          const mx = ants.reduce((s, a) => s + a[0], 0) / ants.length;
          const my = ants.reduce((s, a) => s + a[1], 0) / ants.length;
          const [x, y] = ants.reduce((b, a) => ((a[0] - mx) ** 2 + (a[1] - my) ** 2 < (b[0] - mx) ** 2 + (b[1] - my) ** 2 ? a : b));
          anchors.push({ agent, n: ants.length, x, y });
        }
        anchors.sort((a, b) => b.n - a.n || a.agent - b.agent);
        // Each drawn badge, matched to the anchor it sits beside at one of placeBadges' spots.
        const tags = drawn.filter((d) => d.kind === "tag").map((d) => d.rect);
        const r = tags.length ? (tags[0]!.x1 - tags[0]!.x0) / 2 : 0;
        const spotsOf = (x: number, y: number): R[] => spots.map(([dx, dy]) => {
          const cx = Math.round(x + dx! * (r + 6));
          const cy = Math.round(y + dy! * (r + 6));
          return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
        });
        // One badge per squad: each candidate (badge, anchor) pair within 1 px of a spot, closest first, each used once.
        const badges = tags.map((rect) => ({ rect, rank: -1 }));
        const pairs: { tag: number; rank: number; err: number }[] = [];
        tags.forEach((rect, tag) => {
          const cx = (rect.x0 + rect.x1) / 2;
          const cy = (rect.y0 + rect.y1) / 2;
          anchors.forEach((a, rank) => {
            for (const [dx, dy] of spots) {
              const err = Math.max(Math.abs(cx - a.x - dx! * (r + 6)), Math.abs(cy - a.y - dy! * (r + 6)));
              if (err <= 1) pairs.push({ tag, rank, err });
            }
          });
        });
        const taken = new Set<number>();
        for (const p of pairs.sort((a, b) => a.err - b.err)) {
          if (badges[p.tag]!.rank >= 0 || taken.has(p.rank)) continue;
          badges[p.tag]!.rank = p.rank;
          taken.add(p.rank);
        }
        // What the placer holds before the badges: markers, mark labels, the visible panels and the nests.
        const fixed: R[] = [
          ...window.__antwar.markers().map((m) => ({ x0: m.x - markerHalf, y0: m.y - markerHalf, x1: m.x + markerHalf, y1: m.y + markerHalf })),
          ...window.__antwar.markLabels().map((l) => l.rect),
          ...window.__antwar.nests().map((n) => n.rect),
        ];
        const free = (s: R, before: R[]) => {
          if (s.x0 < 0 || s.y0 < 0 || s.x1 > innerWidth || s.y1 > innerHeight) return false;
          const g = { x0: s.x0 - gap, y0: s.y0 - gap, x1: s.x1 + gap, y1: s.y1 + gap };
          return !fixed.some((o) => hit(g, o)) && !before.some((o) => hit(g, o));
        };
        let raw = 0;
        const counted: { later: R; other: R; freeSpot: R }[] = [];
        for (let i = 0; i < badges.length; i++) for (let j = i + 1; j < badges.length; j++) {
          if (!hit(badges[i]!.rect, badges[j]!.rect)) continue;
          raw++;
          const [early, later] = badges[i]!.rank <= badges[j]!.rank ? [badges[i]!, badges[j]!] : [badges[j]!, badges[i]!];
          // An unmatched badge cannot show it had no free spot, so its overlap counts.
          const anchor = early.rank < 0 ? undefined : anchors[later.rank];
          const before = badges.filter((b) => b !== later && b.rank >= 0 && b.rank < later.rank).map((b) => b.rect);
          const freeSpot = anchor ? spotsOf(anchor.x, anchor.y).find((s) => free(s, before)) : later.rect;
          if (freeSpot) counted.push({ later: later.rect, other: early.rect, freeSpot });
        }
        const overlap = { raw, counted: counted.length, unmatched: badges.filter((b) => b.rank < 0).length, examples: counted.slice(0, 4) };
        return { frame, drawn, roster, overlap };
      }, layout);
      const f = peak.frame;
      // Tooltips may cover the board by design: only what is drawn unasked is checked.
      const drawn = peak.drawn.filter((d) => d.kind !== "tooltip");
      const peakRoster = peak.roster;
      const overlap = peak.overlap;
      const full = await shot(page, "crowded-1080p");
      writeFileSync(join(keep, "crowded-640w.png"), await scalePng(p.browser, readFileSync(full), 640, 1920, 1080));
      record("crowded scene: every live mark drawn as a marker", f.marks.markers === f.marks.marks, { marks: f.marks, at640: "crowded-640w.png", first150At: crowded.playbackTick });
      record("crowded scene: no drawn squad badge overlaps another where a free spot beside its ant existed", overlap.counted === 0 && drawn.some((d) => d.kind === "tag"), { drawn: drawn.length, tags: drawn.filter((d) => d.kind === "tag").length, ...overlap });
      // An agent's row carries its order; its thoughts are the feed's alone, so none shows twice with Agents open.
      record("crowded scene: the roster lists every agent with its model label and order", peakRoster.length === f.agents && peakRoster.every((r) => r.name.length > 0 && r.order.length > 0), { rows: peakRoster.length, agents: f.agents, intentLines: f.intentLines });
      const badges = drawn.filter((d) => d.kind === "tag").length;
      record("crowded scene: every squad with ants has exactly one badge drawn", badges === f.squadTags.squads && f.squadTags.full === f.squadTags.squads, { badges, squads: f.squadTags.squads, drawnBadges: f.squadTags.full });
      // Zoom and pan, then back to the whole board.
      const v0 = await api(page, () => window.__antwar.view());
      await page.mouse.move(960, 560);
      await page.mouse.wheel(0, -600);
      await sleep(200);
      const v1 = await api(page, () => window.__antwar.view());
      await page.mouse.move(900, 500);
      await page.mouse.down();
      await page.mouse.move(800, 420, { steps: 5 });
      await page.mouse.up();
      await sleep(200);
      const v2 = await api(page, () => window.__antwar.view());
      await shot(page, "zoomed-panned");
      await page.mouse.dblclick(900, 500);
      await sleep(200);
      const v3 = await api(page, () => window.__antwar.view());
      record("the viewer can zoom and pan, and double-click returns to the whole board", v1.tilePx > v0.tilePx && (v2.ox !== v1.ox || v2.oy !== v1.oy) && v3.tilePx === v0.tilePx && v3.ox === v0.ox, { v0, v1, v2, v3 });
      const agent = await waitFor(page, "a squad on the board", async () => {
        for (let a = 0; a < 10; a++) if (await page.evaluate((x) => window.__antwar.squadAnts(x).length > 0, a)) return a + 1;
        return null;
      }, 30_000);
      // Each squad's model label and order: the roster carries every agent (its thoughts are the feed's); tags sit beside the squads.
      const roster = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".d2-agent-item")].map((r) => ({ name: r.querySelector(".d2-agent-title")?.textContent ?? "", order: r.querySelector(".d2-order")?.getAttribute("title") ?? "" })));
      const g = await frameOf(page);
      record("each squad shows its model label and order (roster rows; a badge on the board for each squad)", roster.length === g.agents && roster.every((r) => r.name.length > 0 && r.order.length > 0) && g.squadTags.full > 0, { rows: roster.length, intentLines: g.intentLines, tags: g.squadTags });
      // Clicking an ant opens its agent's row in the HUD: its agent, model, squad order and the agent's call interval.
      // A point whose click picks one of the squad's own ants, not a free ant beside it in the crowd.
      const at = await page.evaluate((x) => {
        window.__antwar.hover(x);
        window.__antwar.frame();
        const own = new Set(window.__antwar.highlighted().squad);
        window.__antwar.hover(-1);
        window.__antwar.frame();
        const ants = window.__antwar.squadAnts(x);
        return ants.find(([sx, sy]) => own.has(window.__antwar.antAt(sx, sy) ?? -1)) ?? ants[0] ?? null;
      }, agent - 1);
      await page.mouse.click(at![0], at![1]);
      await sleep(300);
      const panel = await page.evaluate(() => (document.querySelector<HTMLElement>(".d2-agent-item.is-open")?.innerText ?? ""));
      // The open row carries the agent's handle: the roster row's name.
      record("clicking an ant shows its agent, model and squad order", panel.includes(roster[agent - 1]!.name) && /Model: /.test(panel) && /Squad order: /.test(panel), panel);
      record("the card shows the agent's call interval as the interval between consecutive calls", /Call interval: \d+\.\d s/.test(panel), panel);
      // Idle: the lazy agent has made no call for 90 s.
      await waitFor(page, "90 s of match", async () => (match.state.tick >= 920 ? true : null), 120_000);
      await sleep(500);
      // A row's title is the agent's handle, with its model label under it; without a handle the title is the model.
      const idle = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".d2-agent-item")].map((r) => ({
        model: r.querySelector(".d2-agent-sub")?.textContent || (r.querySelector(".d2-agent-title")?.textContent ?? ""),
        idle: r.classList.contains("is-idle"),
      })));
      const idleRows = idle.filter((r) => r.idle);
      record("an agent with no call in the last 90 s shows as idle, and the others do not", idleRows.length === 1 && idleRows[0]!.model === "lazy-model" && idle.length > 1, idleRows);
      // Deaths rise, and the bars track the board. Deaths are per colony (e7d651b): a colony's losses are the other's
      // kills on the HUD's score plate, read in the same frame as the board's count; its territory row shows each share.
      const sample = () => page.evaluate(() => {
        window.__antwar.frame();
        const [kills, territory] = [...document.querySelectorAll<HTMLElement>(".d2-plate .d2-srow")];
        const figure = (row: HTMLElement | undefined, c: number) => row?.querySelector(`.d2-fig.c${c}`)?.textContent ?? null;
        const lost = ([0, 1] as const).map((c) => ({ board: window.__antwar.board()?.deaths[c] ?? null, text: figure(kills, 1 - c) }));
        return { board: window.__antwar.board(), lost, share: [figure(territory, 0), figure(territory, 1)] };
      });
      const d1 = await sample();
      await sleep(5000);
      const d2 = await sample();
      const total = (d: typeof d1) => d.lost.reduce((s, l) => s + (l.board ?? 0), 0);
      const lostOk = (d: typeof d1) => d.lost.every((l) => l.board !== null && l.text === l.board.toLocaleString("en"));
      const shareOk = (d: typeof d1) => d.board !== null && d.share[0] === `${Math.round((100 * d.board.held[0]) / Math.max(1, d.board.held[0] + d.board.held[1]))}%`;
      record("the death counter rises as ants die and shows the board's count", total(d2) > total(d1) && lostOk(d1) && lostOk(d2), { before: d1.lost, after: d2.lost });
      record("the tug-of-war bar tracks the board's territory", shareOk(d1) && shareOk(d2), { d1: d1.share, d2: d2.share });
    } finally {
      await p.close();
      await server.close();
    }
  }

  // ---- 2. The default map with a 20 s delay and the frame-time flag: timeline, overrun bar, reconnect, result.
  {
    const delay = 20;
    const server = new LiveServer({ ...DEFAULT_LIVE_CONFIG, delaySeconds: delay });
    const base = await server.listen();
    const match = server.start(1, scripts("default"));
    const nextStart = Date.UTC(2026, 9, 15, 9, 0, 0);
    server.onTick = (m) => {
      if (m.finalTick !== null) server.hub.setNextStart(1, new Date(nextStart));
    };
    const p = await openPage(base, 1920, 1080, "?frametime=1");
    const { page } = p;
    try {
      await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42));
      // Frame times.
      await sleep(3000);
      const ft = (await api(page, () => window.__antwarCapture.frameTimes())) ?? "";
      record("with the frame-time flag set, the client reports its frame times", /frame \d+\.\d ms/.test(ft), ft);
      // Reconnect without a reload.
      const before = await api(page, () => window.__antwar.playback());
      server.interrupt();
      const reconnecting = await waitFor(page, "the page to notice", async () => (/reconnecting/i.test(await page.$eval(".d2-connection", (e) => e.textContent ?? "")) ? true : null), 10_000).catch(() => false);
      const resumed = await waitFor(page, "a fresh full snapshot", async () => {
        const pb = await api(page, () => window.__antwar.playback());
        return pb.resets > before.resets && pb.newestTick > before.newestTick ? pb : null;
      }, 20_000);
      const marker = await page.evaluate(() => (window as unknown as { __marker?: number }).__marker);
      record("after the stream is interrupted the page reconnects without a reload and resumes from the next full snapshot", marker === 42 && resumed.resets === before.resets + 1, { before, resumed, reconnectingShown: reconnecting });
      // Result: hidden until delayed playback reaches the final tick, then the winner and next start time.
      const polls = await pollResult(page, () => match.finalTick, 240_000);
      const final = match.finalTick!;
      const early = polls.filter((x) => x.tick < final && (x.shown || x.wins));
      const last = polls.at(-1)!;
      const winner = match.state.result!.winner;
      await shot(page, "result");
      record(
        "the page shows the winning colony and the next start only once delayed playback reaches the final tick, and never earlier",
        early.length === 0 && last.tick === final && (winner === null || last.text.includes(["Very Large Colony", "Lake Hodges Colony"][winner]!)) && /Next match · \d{1,2}:\d{2}/.test(last.text),
        { final, polls: polls.length, early: early.length, shownAt: last.tick, text: last.text },
      );
    } finally {
      await p.close();
      await server.close();
    }
  }

  // ---- 3. The next match has fewer agents: /live/current moves on, the roster drops the old rows, then a join.
  {
    const server = new LiveServer({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    const base = await server.listen();
    const short = (agents: number, ticks: number): ScriptOptions => ({ seed: 6007, config: { ...RECORD_CONFIG, matchTicks: ticks }, agents, ticks, attack: true });
    server.start(1, short(3, 60), true);
    server.onTick = (m) => {
      if (m.seq !== 1 || m.finalTick === null) return;
      server.hub.setNextStart(1, null);
      server.onTick = null;
      // Match 2 opens with no agents; the page moves on to it 30 s after match 1's result, and the
      // lazy agent joins 50 s in, after that.
      server.start(2, short(0, 1200), 500);
    };
    const p = await openPage(base, 1920, 1080, "");
    const { page } = p;
    // The HUD's agent rows: each row's title (its handle, else its model) and its model label.
    const rows = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".d2-agent-item")].map((r) => ({ name: r.querySelector(".d2-agent-title")?.textContent ?? "", model: r.querySelector(".d2-agent-sub")?.textContent || (r.querySelector(".d2-agent-title")?.textContent ?? "") })));
    try {
      await waitFor(page, "match 1's roster", async () => {
        const r = await rows();
        return r.length === 4 ? r : null;
      }, 30_000);
      // The page moves on to match 2 by reloading (web/src/source.ts nextMatch).
      const joined = await acrossOneReload(page, () => waitFor(page, "the join in match 2", async () => {
        const f = await frameOf(page);
        return f.agents === 1 ? { rows: await rows(), agents: f.agents } : null;
      }, 60_000));
      await sleep(300);
      const after = await rows();
      record("an agent joining after that gets a fresh row with its own model label", after.length === 1 && after[0]!.name.length > 0 && after[0]!.model === "lazy-model", { joined: joined.rows, after });
    } finally {
      await p.close();
      await server.close();
    }
  }

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim() !== "";
  writeFileSync(join(keep, "live-check.json"), JSON.stringify({ task: "live-check", commit, dirty, rendererString, results }, null, 1));
  console.log(`${results.filter((r) => r.pass).length}/${results.length} passed; kept in ${keep}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      serve: { type: "boolean", default: false },
      size: { type: "string", default: "large" },
      delay: { type: "string", default: "0" },
      port: { type: "string", default: "4719" },
      keep: { type: "string", default: join(OUT_DIR, "live-check") },
    },
  });
  if (values.serve) await serve(values.size!, Number(values.delay), Number(values.port));
  else await checks(values.keep!);
}

export { openPage, waitFor, frameOf };
