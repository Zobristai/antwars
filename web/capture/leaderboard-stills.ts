/** Standalone table captures only. All API replies are fake; every request is intercepted. */
import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import type { LeaderboardMode } from "../src/leaderboard.ts";
import { C } from "../src/leaderboard-page/copy.ts";
import { WEB_DIR, launchBrowser } from "./browser.ts";
import { provenance } from "./capture.ts";

export const LEADERBOARD_VIEWPORTS = [[1920, 1080], [390, 844], [844, 390], [360, 800]] as const;
/** A phone viewport: emulated with touch and held to the 44 px tap height. Desktop is exempt from the height
 * rule only; every viewport keeps the on-screen and unobstructed checks. */
export const touchViewport = (width: number): boolean => width < 900;
/** At 360x800 the top bar's Leaderboard link stays 14 px clipped and is exempt from the on-screen check only. Its height and
 * unobstructed checks still apply. */
export const navReachExempt = (width: number, height: number): boolean => width === 360 && height === 800;
export const LEADERBOARD_SCENES = ["populated", "partial", "paginated", "empty", "failure", "loading", "disabled", "mode-switch", "house-mode"] as const;
export type LeaderboardScene = typeof LEADERBOARD_SCENES[number];
export const LEADERBOARD_MODES: readonly LeaderboardMode[] = ["1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"];
/** The page's three kinds of read: a public mode's house scope, a public mode's everyone ranking, a house-mode size. */
export type FakeRead = "house" | "everyone" | "house-mode";
export const FIXTURE_CURSOR = "capture-only-next-snapshot";
/** The board choices in page order: the Antwars Model Index sizes (the opening board), the Ranked sizes, then Challenge. */
export const MODE_LABELS = [...LEADERBOARD_MODES.filter(mode => mode.startsWith("house-")).map(mode => `Antwars Model Index ${mode.slice(6)}`),
  ...LEADERBOARD_MODES.filter(mode => !mode.startsWith("house-")).map(mode => `Ranked ${mode}`), "Challenge 1v1"];
const ORIGIN = "http://localhost:4718";
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };

type FakeRow = { displayName: string; rating: number; ratedMatches: number; wins?: null | number; losses?: null | number; draws?: null | number;
  form?: { result: "W" | "L" | "D"; replayId: string | null }[] };
/**
 * A fake row with a record: letters newest first, "*" after a letter giving it a fake replay id.
 * Without letters the row has no reconciled record and shows an empty Record and Last 5.
 */
function fake(displayName: string, rating: number, ratedMatches: number, letters = ""): FakeRow {
  if (!letters) return { displayName, rating, ratedMatches, wins: null, losses: null, draws: null, form: [] };
  const results = [...letters.replaceAll("*", "")] as ("W" | "L" | "D")[];
  const linked = [...letters].flatMap((char, at) => char === "*" ? [] : [letters[at + 1] === "*"]);
  const recent = results.slice(0, 5);
  // The counts cover every rated match; letters are only the newest five, so extra wins fill the difference.
  const draws = results.filter(r => r === "D").length, losses = results.filter(r => r === "L").length;
  return { displayName, rating, ratedMatches, wins: ratedMatches - losses - draws, losses, draws,
    form: recent.map((result, at) => ({ result, replayId: linked[at] ? `2026-10-26T08-0${at}-00-000Z-${ratedMatches}` : null })) };
}
/** Explicitly fake rows. The house read is what the server's ownership scope would return, not a name filter. */
const FAKES: Record<FakeRead, readonly [FakeRow[], FakeRow[]]> = {
  house: [
    [fake("antwars/capture-model-one", 1700.5, 10, "W*W*LW*D"), fake("antwars/capture-model-two", 1560, 3, "W*LW")],
    [fake("antwars/capture-model-three", 1490, 2, "L*W")],
  ],
  everyone: [
    [
      fake("capture-player", 1740.25, 12, "W*W*W*LW*"),
      fake("antwars/capture-model-one", 1700.5, 10, "W*W*LW*D"),
      fake("capture-owner/capture-agent", 1600, 4, "WLWW"),
      fake("antwars/capture-model-two", 1560, 3, "W*LW"),
    ],
    [
      fake("antwars/capture-model-three", 1490, 2, "L*W"),
      fake("<img onerror=alert(1)>", 1400, 1, "L"),
      fake("capture-long-owner/capture-long-handle", 1300.75, 1),
    ],
  ],
  "house-mode": [
    [fake("antwars/capture-model-two", 1620, 6, "W*DW*LW"), fake("antwars/capture-model-one", 1580.5, 5, "L*WLW*D*")],
    [fake("antwars/capture-model-three", 1500, 1, "W*")],
  ],
};

export function fakeLeaderboardPage(read: FakeRead, cursor?: string) {
  if (cursor !== undefined && cursor !== FIXTURE_CURSOR) throw new Error("Unexpected fake cursor");
  return cursor === undefined ? { entries: FAKES[read][0], next: FIXTURE_CURSOR } : { entries: FAKES[read][1] };
}
export const fakeLeaderboardRanking = (read: FakeRead) => ({ entries: [...FAKES[read][0], ...FAKES[read][1]] });

/** Only this exact public anonymous read is permitted; no write, credential, extra field or live route. */
export function allowedLeaderboardRequest(url: string, method: string, body: string | null, headers: Record<string, string>): boolean {
  let target: URL, payload: unknown;
  try { target = new URL(url); payload = JSON.parse(body ?? "null"); } catch { return false; }
  if (target.origin !== ORIGIN || target.pathname !== "/api/leaderboard" || target.search || target.hash || method !== "POST") return false;
  if (Object.keys(headers).some(name => ["authorization", "cookie", "x-api-key"].includes(name.toLowerCase()))) return false;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  const mode = LEADERBOARD_MODES.find(known => known === value.mode);
  return Object.keys(value).every(key => ["limit", "mode", "scope", "cursor"].includes(key)) && value.limit === 50 && mode !== undefined
    && (value.scope === undefined || (value.scope === "house" && !mode.startsWith("house-")))
    && (value.cursor === undefined || value.cursor === FIXTURE_CURSOR);
}

/** Which fake read an allowed request asks for. */
export function fakeReadOf(payload: { mode: string; scope?: string }): FakeRead {
  return payload.scope === "house" ? "house" : payload.mode.startsWith("house-") ? "house-mode" : "everyone";
}

/** The page opens on the Antwars Model Index 1v1 board (one table); mode-switch and failure choose a Ranked size (two tables). */
export function expectedView(scene: LeaderboardScene): { headings: string; pressed: string | null; rows: number } {
  if (scene === "disabled") return { headings: "", pressed: null, rows: 0 };
  if (scene === "mode-switch" || scene === "failure") {
    const size = scene === "mode-switch" ? "4v4" : "1v1";
    return { headings: `Ranked · ${size} · house models|Ranked · ${size}`, pressed: `Ranked ${size}`, rows: scene === "failure" ? 7 : 10 };
  }
  const size = scene === "house-mode" ? "2v2" : "1v1";
  const rows = { populated: 3, paginated: 3, "house-mode": 3, partial: 2, empty: 0, loading: 0 }[scene];
  return { headings: `Antwars Model Index · ${size}`, pressed: `Antwars Model Index ${size}`, rows };
}

export async function captureLeaderboardStills(out: string, webDir = WEB_DIR): Promise<void> {
  const directory = await realpath(resolve(webDir));
  const output = resolve(out); await mkdir(output, { recursive: true });
  const browser = await launchBrowser();
  const problems: string[] = [], scenes: unknown[] = [];
  try {
    for (const [width, height] of LEADERBOARD_VIEWPORTS) for (const scene of LEADERBOARD_SCENES) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: touchViewport(width), hasTouch: touchViewport(width), serviceWorkers: "block" });
      const page = await context.newPage();
      const requests: string[] = [], reads: string[] = [], errors: string[] = [];
      let release!: () => void;
      const held = new Promise<void>(done => { release = done; });
      const file = `leaderboard-${width}x${height}-${scene}.png`;
      try {
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        await page.clock.install({ time: 0 }); await page.clock.pauseAt(1);
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push(`${request.method()} ${url.pathname}`);
          const refuse = async () => { errors.push(`Blocked unexpected request: ${request.method()} ${url.pathname}`); await route.abort("blockedbyclient"); };
          if (url.pathname === "/api/leaderboard") {
            if (!allowedLeaderboardRequest(request.url(), request.method(), request.postData(), request.headers()) || scene === "disabled") return refuse();
            reads.push(request.postData() ?? "");
            if (scene === "loading") await held;
            const payload = request.postDataJSON() as { mode: string; scope?: string; cursor?: string };
            const read = fakeReadOf(payload);
            const body = scene === "failure" && read === "house" ? { entries: "malformed fake response" }
              : scene === "empty" || scene === "loading" ? { entries: [] }
              : scene === "populated" || scene === "mode-switch" || scene === "failure" ? fakeLeaderboardRanking(read)
              : fakeLeaderboardPage(read, payload.cursor);
            return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
          }
          if (url.origin !== ORIGIN || request.method() !== "GET" || (url.pathname !== "/" && !/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname))) return refuse();
          if (url.pathname === "/" && url.search !== "?page=leaderboard") return refuse();
          const path = join(directory, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
          try {
            const real = await realpath(path);
            if (!real.startsWith(directory + sep) || !types[extname(real)]) return refuse();
            let bytes: Buffer | string = await readFile(real);
            if (url.pathname === "/") bytes = bytes.toString("utf8").replace("<head>", `<head><meta name="antwar-public-matches" content="${scene === "disabled" ? "false" : "true"}"><meta name="antwar-lobbies" content="false">`);
            return route.fulfill({ status: 200, contentType: types[extname(real)], body: bytes });
          } catch { return refuse(); }
        });
        const settled = () => page.waitForFunction(() => {
          const tables = document.querySelectorAll("#aw-leaderboard-page section");
          return tables.length > 0 && Array.from(tables).every(table => table.getAttribute("aria-busy") === "false");
        });
        await page.goto(`${ORIGIN}/?page=leaderboard`);
        await page.waitForSelector("#aw-leaderboard-page");
        if (scene === "loading") await page.waitForFunction(() => document.querySelectorAll('#aw-leaderboard-page section[aria-busy="true"]').length === 1);
        else if (scene !== "disabled") await settled();
        if (scene === "paginated") {
          // Each table pages on its own; a table's Load more hides once its last page is shown.
          const more = page.getByRole("button", { name: "Load more", exact: true });
          for (let tables = 2; tables > 0 && await more.count(); tables--) { await more.first().click(); await settled(); }
        }
        if (scene === "failure") { await page.getByRole("button", { name: "Ranked 1v1", exact: true }).click(); await settled(); }
        if (scene === "mode-switch") { await page.getByRole("button", { name: "Ranked 4v4", exact: true }).click(); await settled(); }
        if (scene === "house-mode") {
          await page.getByRole("button", { name: "Antwars Model Index 2v2", exact: true }).click(); await settled();
          await page.getByRole("button", { name: "Load more", exact: true }).click(); await settled();
        }
        const measured = await page.evaluate(({ touch, navExempt }) => {
          // A loading table's skeleton is aria-hidden and holds no rows.
          const tables = Array.from(document.querySelectorAll('#aw-leaderboard-page table:not([aria-hidden="true"])'));
          const controls = Array.from(document.querySelectorAll<HTMLElement>("#aw-leaderboard-page a, #aw-leaderboard-page button:not([hidden])")).filter(node => node.checkVisibility());
          const before = window.scrollY;
          const obstructed: string[] = [];
          for (const node of controls) {
            node.scrollIntoView({ block: "center" });
            const box = node.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const reachExempt = navExempt && node.matches(".d1-top .d2-nav-link") && node.textContent === "Leaderboard";
            const offScreen = !reachExempt && (box.left < 0 || box.right > innerWidth);
            if ((touch && box.height < 44) || offScreen || !hit || !node.contains(hit)) obstructed.push(node.textContent ?? "control");
          }
          window.scrollTo(0, before);
          return {
            // A heading's title is its own text; the count beside it is its .d1p-count.
            headings: Array.from(document.querySelectorAll("#aw-leaderboard-page .d1p-card-title")).map(node => node.firstChild?.textContent),
            counts: Array.from(document.querySelectorAll("#aw-leaderboard-page section .d1p-card-title .d1p-count")).map(node => node.textContent),
            more: document.querySelectorAll('#aw-leaderboard-page button[data-key^="more-"]').length,
            modes: Array.from(document.querySelectorAll<HTMLElement>(".d1p-boards button")).filter(node => node.checkVisibility()).map(node => node.getAttribute("aria-label")),
            pressed: Array.from(document.querySelectorAll<HTMLElement>('.d1p-boards button[aria-pressed="true"]')).find(node => node.checkVisibility())?.getAttribute("aria-label") ?? null,
            // Only a loading, failed or empty table has a state line; a ready table with rows shows only its count.
            tableStates: Array.from(document.querySelectorAll("#aw-leaderboard-page section .d1p-state")).map(node => node.textContent),
            columns: tables.map(table => Array.from(table.querySelectorAll("thead th")).map(node => node.textContent)),
            rows: tables.map(table => Array.from(table.querySelectorAll("tbody tr")).map(row => Array.from(row.children).map(cell => cell.textContent))),
            status: document.querySelector("#aw-leaderboard-status")?.textContent,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            clippedCells: Array.from(document.querySelectorAll<HTMLElement>("th,td")).filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
            obstructed, boards: document.querySelectorAll("canvas").length,
            lobbyControls: document.querySelectorAll("#aw-lobby-controls").length,
            coarsePointer: matchMedia("(pointer: coarse)").matches,
          };
        }, { touch: touchViewport(width), navExempt: navReachExempt(width, height) });
        const expected = expectedView(scene);
        if (measured.headings.join("|") !== expected.headings) errors.push(`Wrong tables: ${measured.headings.join("|")}`);
        if (measured.headings.some(heading => heading?.includes("Everyone else"))) errors.push("Everyone heading still says Everyone else");
        if (measured.modes.join("|") !== (scene === "disabled" ? "" : MODE_LABELS.join("|"))) errors.push("Mode choice missing or incomplete");
        if (measured.pressed !== expected.pressed) errors.push(`Wrong mode chosen: ${measured.pressed}`);
        if (measured.columns.some(columns => columns.join("|") !== "#Rank|Name|Rating|Rated matches|Record|Last 5")) errors.push("Wrong table columns");
        if (measured.boards || measured.lobbyControls) errors.push("Standalone route started spectator/lobby UI");
        if (measured.horizontalOverflow || measured.clippedCells.length || measured.obstructed.length) errors.push("Table or controls overflow, clip or cannot be reached by scrolling");
        if (measured.rows.flat().length !== expected.rows) errors.push(`Expected ${expected.rows} fake rows`);
        if ((scene === "populated" || scene === "paginated" || scene === "mode-switch" || scene === "house-mode") && (measured.tableStates.length > 0 || measured.more > 0)) errors.push("A table did not reach its last entry");
        if (scene === "failure" && (measured.tableStates.join("|") !== C.tableFailed || measured.more > 0)) errors.push("A failed house read did not leave the everyone table complete");
        if (scene === "house-mode" && !reads.includes('{"limit":50,"mode":"house-2v2","cursor":"capture-only-next-snapshot"}')) errors.push("House-mode table did not page its own read");
        if (scene === "mode-switch" && !reads.includes('{"limit":50,"mode":"4v4","scope":"house"}')) errors.push("Mode switch did not read 4v4 house rankings");
        await page.screenshot({ path: join(output, file), fullPage: true, animations: "disabled" });
        scenes.push({ file, width, height, scene, fakeResponses: true, ...measured, requests, reads, errors: [...errors] });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        scenes.push({ file, width, height, scene, fakeResponses: true, requests, reads, errors: [...errors] });
      } finally {
        release(); await context.close();
        problems.push(...errors.map(error => `${file}: ${error}`));
      }
    }
    await writeFile(join(output, "stills.json"), JSON.stringify({ kind: "standalone-leaderboard", ...provenance(browser), webDir: directory, fixtureSha256: createHash("sha256").update(JSON.stringify(FAKES)).digest("hex"), fakeResponses: true, scenes, problems }, null, 2));
    await writeFile(join(output, "summary.txt"), problems.length ? problems.join("\n") : "All standalone leaderboard captures passed. Fake responses only.\n");
  } finally { await browser.close(); }
  if (problems.length) throw new Error(`Leaderboard captures failed: ${problems.join("; ")}`);
}
