import { WORD_MARK_ACTIONS, houseIdleText } from "../../src/mcp/briefing.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG, rulesConfig as rulesTemplate } from "../../src/sim/config.ts";
import { createMapShapes } from "../../src/sim/mapShapes.js";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { comparisonOptions } from "../../src/server.ts";
import { briefing, joinBriefing } from "../../src/mcp/briefing.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { readRulesAssets, startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { PAGE_COPY } from "../../web/src/story.ts";
import { PRE_FRONTLINE_PUBLIC_CONFIG } from "../sim/fixtures.js";
import { playable } from "../playable.ts";
import { LOG_EXPLAINER, VISUAL_KEY, count, queensRoute, renderRules, ruleSections, sectionId } from "../../web/rules.ts";
import { keyText } from "../../web/src/overlays.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { COMPARISON_SEED } from "../../src/server.ts";
import { QUEEN_HP_RULES } from "../../src/sim/config.ts";
import { NEW_MATCH_GRID_SCALE } from "../../src/sim/gridScale.ts";
import { Game } from "../../src/mcp/game.ts";
import { createMatch } from "../../src/sim/map.ts";
import { createTerrain } from "../../src/sim/terrain.ts";
import { LANES_BOARD, WIDE_BOARD, boardRotation } from "../sim/map-board-fixtures.js";

// Rules text describes a playable config, and every match plays at grid scale 2: the reference
// rules templates are built at grid scale 2 once, here, through the one template constructor.
const rulesConfig = (name: string | undefined) => playable(rulesTemplate(name));
const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG);

describe("the runtime image", () => {
  // Regression caught: the c969822 preview failed to start with "Cannot find module
  // '/app/web/src/story.ts' imported from /app/web/rules.ts" — the image holds web/rules.ts and web/dist from web/,
  // never web/src, so web/rules.ts may import only the server's src/.
  it("web/rules.ts imports only from src/, which the image holds, never from web/src", () => {
    const source = readFileSync(new URL("../../web/rules.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^import\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^\.\.\/src\//);
  });

  it("the Rules page's wordmark and credit are the spectator page's own", () => {
    const html = renderRules({ ...PUBLIC_CONFIG });
    expect(html).toContain(`<a href="/">${PAGE_COPY.name}</a><span>${PAGE_COPY.credit}</span>`);
  });
});

let server: SpectatedServer | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

const config = { ...PUBLIC_CONFIG, ticksPerSecond: 20, matchTicks: 36000, overrunGraceTicks: 14400, overrunTicks: 160, overrunRadiusTiles: 3, territoryDecayTicks: 300, hatchCost: 9, hatchIntervalTicks: 40, colonyCap: 321 };

describe("configured maps", () => {
  it("describes the real native-grid routes at grid scale 2", () => {
    const base = rulesConfig("redesign");
    const text = ruleSections({ ...base, terrain: { ...base.terrain!, maps: createMapShapes(), referenceWidth: 128, referenceHeight: 96 } })
      .find(section => section.title === "Maps")!.lines.join(" ");
    expect(text).toContain("Open Field: open ground with no water.");
    expect(text).toContain("Three Crossings: a north-south river with three land crossings.");
    expect(text).toContain("Central Lake: one stepped central lake with land routes north and south.");
  });
  it("describes configured seeded rock counts and cluster sizes, never historical water-only rules", () => {
    const base = rulesConfig("redesign");
    const text = ruleSections(base).find(s => s.title === "Maps")!.lines.join(" ");
    expect(text).toContain("6 to 8 mirrored rock pairs");
    expect(text).toContain("1 to 3 original-size cells each; a cell covers 2x2 fine tiles");
    expect(text).toContain("faceted grey boulders"); expect(text).toContain("queens cannot be founded on them");
    const altered = { ...base, terrain: { ...base.terrain!, rocks: { ...base.terrain!.rocks!, minPairs: 2, maxPairs: 4, maxClusterTiles: 2 } } };
    const changed = ruleSections(altered).find(s => s.title === "Maps")!.lines.join(" ");
    expect(changed).toContain("2 to 4 mirrored rock pairs"); expect(changed).toContain("1 to 2 original-size cells each");
    const legacy = ruleSections({ ...base, terrain: { ...base.terrain!, rocks: undefined } }).find(s => s.title === "Maps")!.lines.join(" ");
    expect(legacy).not.toContain("rock");
  });
  it("lists the supplied names, map dimensions and scaled water rectangles, never copied map numbers", () => {
    const base = rulesConfig("redesign");
    const maps = ruleSections(base).find((section) => section.title === "Maps")!.lines.join(" ");
    for (const map of base.terrain!.maps) expect(maps).toContain(`${map.name}:`);
    expect(maps).toContain("128 tiles wide and 96 tiles high");
    expect(maps).toContain("(60, 0), 8 tiles wide and 16 tiles high");
    expect(maps).toContain("Water is impassable to ants and marks");
    expect(maps).toContain("darkened mirrored terrain beyond the edge is scenery only");
    const altered = { ...base, mapWidth: 20, mapHeight: 12, terrain: {
      referenceWidth: 40, referenceHeight: 24,
      maps: [{ id: "changed", name: "A <changed> shore", water: [{ x: 16, y: 4, width: 8, height: 6 }] }],
    } };
    const changed = renderRules(altered);
    expect(changed).toContain("20 tiles wide and 12 tiles high");
    expect(changed).toContain("1 map mirrored left to right");
    expect(changed).toContain("A &lt;changed&gt; shore:");
    expect(changed).toContain("(8, 2), 4 tiles wide and 3 tiles high");
    for (const map of base.terrain!.maps) expect(changed).not.toContain(`${map.name}:`);
    const fixed = renderRules({ ...base, terrain: { ...base.terrain!, mapId: base.terrain!.maps[1]!.id } });
    expect(fixed).toContain(`Selected map: ${base.terrain!.maps[1]!.name}`);
    expect(fixed).not.toContain("The match seed selects the map");
    expect(renderRules({ ...base, terrain: undefined })).toContain("Open land, with no water");
  });
});

describe("shared rules", () => {
  it("teaches worker and soldier hatch intervals from the live config", () => {
    const live = rulesConfig("redesign");
    const text = renderRules(live);
    expect(text).toContain("hatch a worker every 1 second when food is available");
    expect(text).toContain("Each soldier takes 2 hatch intervals (2 seconds) at its own queen; workers take one interval.");
    expect(text).toContain("Each live queen hatches independently");
    const changed = renderRules({ ...live, ticksPerSecond: 20, hatchIntervalTicks: 30,
      hatchTiming: { soldierIntervalMultiplier: 3 } });
    expect(changed).toContain("hatch a worker every 1.5 seconds");
    expect(changed).toContain("Each soldier takes 3 hatch intervals (4.5 seconds)");
    expect(renderRules({ ...live, hatchTiming: undefined })).toContain("hatch an ant every 1 second");
  });
  it.each(["v4", "count-marks", "redesign"] as const)("explains the %s idle countdown with the same words as the agent rules", rules => {
    const config = rulesConfig(rules);
    const countdown = "idleSecondsLeft: seconds left before the seat goes idle and its colony loses (index match: the match is abandoned); null unseated or match ended";
    const postMatch = "Match over: matchOver:true, winner/draw, result; no match clocks.";
    for (const text of [briefing(config), joinBriefing(config), renderRules(config)]) {
      expect(text).toContain(countdown);
      expect(text).toContain(postMatch);
    }
  });

  it.each([
    { ...PUBLIC_CONFIG, ticksPerSecond: 10, commandFloorTicks: 100 },
    { ...PUBLIC_CONFIG, ticksPerSecond: 20, commandFloorTicks: 140 },
  ])("names the complete shared command budget using configured timing (%#)", (rules) => {
    const lines = ruleSections(rules).find((section) => section.title === "Commands")!.lines;
    // The command example follows the budget here, out of the overview, then the idle countdown, main's post-match line and the one idle rule.
    expect(lines).toEqual([`One command per ${rules.commandFloorTicks / rules.ticksPerSecond} s: order, mark and found_queen share one allowance per agent; an order and the mark it carries count as one command. observe does not use this allowance.`,
      'For example, mark ATTACK W FEW lays a scent mark on a tile where one of the agent\'s squad ants stands; the page shows a mark\'s words as written, "ATTACK · W · FEW".',
      "idleSecondsLeft: seconds left before the seat goes idle and its colony loses (index match: the match is abandoned); null unseated or match ended",
      "Match over: matchOver:true, winner/draw, result; no match clocks.",
      "Idle, every match: a seat with no accepted game-tool call (observe, rules and join count; refused calls do not) for the server's idle limit (default 300 seconds; agents read the live limit in briefing and observe) is idle, and no bot plays for it. In an index match an idle seat abandons the match, unrated. In a ranked match, a seat that has not joined by the idle limit, counted from match start, abandons the match, unrated. In every other match the idle seat's colony loses; if both colonies go idle on the same tick, the match is a draw. The idle clock starts at match start if queued, or at join in a running match."]);
  });

  it("follows the landed founding, ground income and all-queens win rules", () => {
    const text = ruleSections(PUBLIC_CONFIG).flatMap((s) => s.lines).join(" ");
    expect(text).not.toContain("Held ground earns food");
    expect(text).toContain("Frontline food: four small mirrored patches");
    expect(text).toContain("Founding opens 300 seconds after match start");
    expect(text).toContain("cooldown of 180 seconds");
    expect(text).toContain("at least 32 tiles (Euclidean distance)");
    expect(text).toContain("standing nest of either colony; overrun nests no longer block spacing");
    expect(text).toContain("costs 400 stored food; the price multiplies by 2 with each additional living founded queen; starting queens do not count");
    expect(text).not.toContain("At most 4 live queens per colony");
    expect(text).toContain("Each live queen hatches independently");
    expect(text).toContain("A lost queen cannot hatch, receive food or be refounded");
    expect(text).toContain("Overrun every enemy queen");
    const historical = ruleSections({ ...PUBLIC_CONFIG, queenFounding: undefined, groundFoodIntervalTicks: undefined, overrunGraceTicks: 0 }).flatMap((s) => s.lines).join(" ");
    expect(historical).not.toContain("found_queen");
    expect(historical).not.toContain("Held ground earns food");
    expect(historical).not.toContain("protection");
    expect(historical).toContain("Overrun the enemy queen");
  });
  it("uses the supplied config rather than copied rule numbers", () => {
    const text = ruleSections(config).flatMap((section) => section.lines).join(" ");
    expect(text).toContain("No queen can be overrun in the first 12 minutes");
    expect(text).toContain("including founded queens; founding does not restart it");
    expect(text).toContain("A match lasts 30 minutes");
    expect(text).toContain("neutral 15 seconds");
    expect(text).toContain("worker costs 9 food");
    expect(text).toContain("every 2 seconds");
    expect(text).toContain("321 living ants");
    expect(text).toContain("within 3 tiles of a queen for 8 seconds");
    expect(ruleSections({ ...config, overrunGraceTicks: 3600 }).flatMap((section) => section.lines).join(" ")).toContain("first 3 minutes");
  });

  it("describes redesign count marks, autonomous ants and queen HP from the live config", () => {
    const rules = rulesConfig("redesign");
    const text = ruleSections(rules).flatMap((section) => section.lines).join(" ");
    expect(text).toContain("free ants act locally");
    expect(text).toContain("count_mark with verb DEFEND, FORAGE, ATTACK, GATHER");
    expect(text).toContain("order, count_mark and found_queen share one allowance");
    expect(text).toContain("Each queen has 40 HP");
    expect(text).toContain("no damage before 300 seconds");
    expect(text).toContain("Kill every enemy queen");
    expect(text).not.toContain("enemy majority");
    expect(text).not.toContain("moves no other ants");
    const altered = { ...rules, queenHp: { ...rules.queenHp!, hp: 71_000, shieldTicks: 120 } };
    const changed = renderRules(altered);
    expect(changed).toContain("Each queen has 71 HP");
    expect(changed).toContain("no damage before 12 seconds");
    expect(changed).toContain("a whole count of 1 or more, at most 10,000,");
  });

  it("takes soldier defaults, taper and early-win numbers from the same config as the agent briefing", () => {
    const rules = rulesConfig("redesign");
    const altered = { ...rules, groundIncomeExcessPermille: 125, localAnts: { ...rules.localAnts!, defendTiles: 5 },
      earlyWin: { ...rules.earlyWin!, territoryRatioPermille: 7000, holdTicks: 2100 } };
    const text = renderRules(altered);
    expect(text).toContain("With none in sight it holds within 5 tiles of where it became free");
    expect(text).toContain("walk outward from their nearest live nest until the colony sees food");
    expect(text).toContain("above that half pay 12.5% income");
    expect(text).toContain("7 times the opponent");
    expect(text).toContain("continuously for 210 s");
    expect(text).toContain("replacements colony-wide");
    expect(text).toContain("any living ant of your colony");
    expect(text).not.toContain("replacements within 8 tiles");
    expect(text).not.toContain("a soldier stays near its queen");
  });

  it("agent rules state the one idle rule, not command-idle takeover", () => {
    const redesign = rulesConfig("redesign");
    for (const rules of [redesign, { ...redesign, commandIdleTicks: 370 }, PUBLIC_CONFIG]) {
      const brief = briefing(rules);
      expect(brief.split("\n")[0]).toBe(houseIdleText());
      expect(brief).not.toMatch(/without accepted commands|counts (?:as )?unseated|first-command window|without a call/);
    }
  });

  // The human /rules page states the same one idle rule, whatever the rules config's commandIdleTicks.
  it("the human rules page states the one idle rule, not command-idle takeover", () => {
    const redesign = rulesConfig("redesign");
    for (const rules of [redesign, { ...redesign, commandIdleTicks: 370 }, PUBLIC_CONFIG]) {
      const page = renderRules(rules);
      expect(page).toContain("Idle, every match: a seat with no accepted game-tool call (observe, rules and join count; refused calls do not) for the server&#39;s idle limit (default 300 seconds");
      expect(page).toContain("In an index match an idle seat abandons the match, unrated. In a ranked match, a seat that has not joined by the idle limit, counted from match start, abandons the match, unrated. In every other match the idle seat&#39;s colony loses; if both colonies go idle on the same tick, the match is a draw.");
      expect(page).not.toMatch(/without an accepted command|counts as unseated|first-command window|180 seconds without/);
    }
  });

  it("serves the public redesign rules before the first scheduled match", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "antwar-rules-"));
    server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, ...comparisonOptions({}, DEFAULT_MCP_CONFIG), breakMs: 60_000 });
    const url = `http://127.0.0.1:${server.port}/rules`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    // Before the first match the seed has drawn no map: the page states every size the rotation may play at.
    expect(await response.text()).toBe(renderRules(newMatchConfig(rulesTemplate("redesign")), { undrawn: true, assets: readRulesAssets() }));
  });

  it("renders readable semantic HTML without requiring JavaScript", () => {
    const html = renderRules(config);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<h1>Rules</h1>");
    for (const title of ["Overview", "Territory", "Food and hatching", "Queens", "Commands", "Thoughts and marks", "Winning"]) expect(html).toContain(`<h2>${title}</h2>`);
    expect(html).not.toContain("<script");
    expect(ruleSections(config).find((section) => section.title === "Thoughts and marks")!.lines).toEqual([LOG_EXPLAINER, WORD_MARK_ACTIONS]);
    expect(LOG_EXPLAINER).toContain("only spectators see them");
    // Thoughts are explained as stated intent, not observed action.
    expect(LOG_EXPLAINER).toContain("stated intent, not observed action");
    expect(LOG_EXPLAINER).toContain("only squads whose agent ordered follow_trail");
  });

  // Regression caught: "A queen can hatch an ant every 1 seconds" on the public page.
  it("gives each config number its unit in the singular for exactly one, so no rule reads '1 seconds'", () => {
    expect(count(1, "second")).toBe("1 second");
    expect(count(2, "second")).toBe("2 seconds");
    expect(count(0.5, "tile")).toBe("0.5 tiles");
    const redesign = rulesConfig("redesign");
    expect(redesign.hatchIntervalTicks / redesign.ticksPerSecond).toBe(1);
    const page = renderRules(redesign);
    expect(page).toContain("hatch a worker every 1 second when food is available");
    expect(page).not.toMatch(/\b1 (seconds|minutes|tiles|living ants|live queens)\b/);
    const ones = ruleSections({ ...redesign, overrunGraceTicks: 600, queenHp: undefined, matchTicks: 600, colonyCap: 1, overrunRadiusTiles: 1 }).flatMap((s) => s.lines).join(" ");
    for (const text of ["A match lasts 1 minute.", "in the first 1 minute.", "within 1 tile of a queen", "up to 1 living ant per colony"]) expect(ones).toContain(text);
    for (const text of ruleSections(config).flatMap((s) => s.lines)) expect(text).not.toMatch(/\b1 (seconds|minutes|tiles)\b/);
  });

  // Regression caught: a plain wall of text in another face, with no summary first; then
  // no spectator's overview before the mechanics.
  // Regression caught in review (the built-status check at 0072af0): command syntax right after the
  // How to win bullets, so the page opened like an agent manual. The example is the Commands section's.
  it("opens with a spectator's overview as its summary — the premise, the ways a match ends with this match's numbers, what territory held is a share of and the key, no command syntax — then how a match is won, in the spectator page's own identity", () => {
    const sections = ruleSections(config).slice(1);
    expect(sections[0]!.title).toBe("Overview");
    expect(sections[0]!.lines).toHaveLength(3);
    expect(sections[0]!.lines.join(" ")).not.toMatch(/count_mark|mark ATTACK|For example/);
    expect(sections[0]!.lines[0]).toMatch(/^AI agents command two ant colonies\./);
    expect(sections[0]!.lines[1]).toBe("Three ways a match ends: every enemy queen overrun; time up: after 30 minutes the colony with more kills wins, with territory breaking a tie. The same scoring order applies if both colonies lose their last queen on the same tick. Territory held: Share of colony-held tiles · the two colonies add to 100%.");
    // The first route's words by rule set, which the spectator page's masthead reads too (web/src/overlays.ts).
    expect(queensRoute(undefined, undefined)).toBe("the enemy queen overrun");
    expect(queensRoute(undefined, PUBLIC_CONFIG.queenFounding)).toBe("every enemy queen overrun");
    expect(queensRoute(rulesConfig("redesign").queenHp, undefined)).toBe("all queens killed");
    expect(sections[0]!.lines[2]).toBe(`Key: ${VISUAL_KEY}.`);
    expect(VISUAL_KEY).toBe("Warm or cool = colony · colour and shape = agent · square badge = squad · ring = mark · crown = queen");
    expect(ruleSections(config).find((s) => s.title === "Commands")!.lines[1]).toBe('For example, mark ATTACK W FEW lays a scent mark on a tile where one of the agent\'s squad ants stands; the page shows a mark\'s words as written, "ATTACK · W · FEW".');
    expect(sections[1]!.title).toBe("Winning");
    expect(sections[1]!.lines[0]).toMatch(/^A match lasts 30 minutes\. Overrun every enemy queen to win before time-up\./);
    // The public rules: all queens killed and the sustained territory lead, with the config's numbers, and the count-mark example.
    const redesign = ruleSections(rulesConfig("redesign")).find((s) => s.title === "Overview")!.lines;
    expect(redesign[1]).toBe("Three ways a match ends: all queens killed: a colony loses when every one of its queens is dead; a sustained territory lead: from 10 minutes, holding at least 100 original-size tile areas and 6 times the opponent's territory for 5 minutes without a break; time up: after 30 minutes the colony with more kills wins, with territory breaking a tie. The same scoring order applies if both colonies lose their last queen on the same tick. Territory held: Share of colony-held tiles · the two colonies add to 100%.");
    expect(redesign).toHaveLength(3);
    expect(ruleSections(rulesConfig("redesign")).find((s) => s.title === "Commands")!.lines[1]).toBe('For example, count_mark DEFEND 15 at tile 30, 32 asks 15 ants outside squads to walk to that tile, hold there and bite only enemies within 2 tiles (incl. diagonals), never chasing; the board and the feed read "DEFEND · any · 15 requested · 12 answered" once 12 have answered.');
    // The starting ants and the cap from config, and alive = started with + hatched − lost, one step from the page.
    expect(ruleSections(rulesConfig("redesign")).find((s) => s.title === "Food and hatching")!.lines.slice(0, 2)).toEqual([
      `Each colony starts with ${rulesConfig("redesign").startAnts} ants. Foragers pick up food and carry it to a friendly queen. A worker costs ${rulesConfig("redesign").hatchCost} food. A queen can hatch a worker every ${count(rulesConfig("redesign").hatchIntervalTicks / rulesConfig("redesign").ticksPerSecond, "second")} when food is available, up to ${rulesConfig("redesign").colonyCap} living ants per colony.`,
      "A colony's ants alive are the ants it started with, plus those it hatched, less those it lost. The score panel shows each colony's ants alive, with the cap once it is reached; the colony's card, opened from its row, adds them up and shows food toward the next ant while short of its cost, then the hatch countdown, or \"Cap reached\" at the cap.",
    ]);
    // Live rules retire the old vocabulary; old recordings still use it.
    expect(ruleSections(rulesConfig("redesign")).flatMap(s => s.lines).join(" ")).not.toMatch(/Word marks|follow_trail/);
    const html = renderRules(config);
    // The wordmark, a chip back to the match, with the credit; the lead; a compact index of the sections; then the
    // overview first and set as the summary, the winning rule next.
    expect(html).toMatch(/<nav class="aw-brand"><a href="\/">Antwars<\/a><span>Built with Zobrist<\/span><\/nav><h1>Rules<\/h1><p class="aw-lead">The same rules apply to people and agents\.<\/p><nav class="aw-index">(<a href="#[a-z-]+">[^<]+<\/a>)+<\/nav><section id="how-to-win" class="aw-summary"><h2>How to win<\/h2>/);
    for (const title of sections.map((s) => s.title)) {
      expect(html).toContain(`<a href="#${sectionId(title)}">${title}</a>`);
      expect(html).toContain(`<section id="${sectionId(title)}"`);
    }
    expect(sectionId("Food and hatching")).toBe("food-and-hatching");
    expect(html.indexOf("<h2>Overview</h2>")).toBeLessThan(html.indexOf("<h2>Winning</h2>"));
    expect(html.indexOf("<h2>Winning</h2>")).toBeLessThan(html.indexOf("<h2>Territory</h2>"));
    // The page's palette, type and heading style, from web/index.html; the brand chip as the page's chips are made.
    for (const token of ["--aw-bg:#0b0805", "--aw-ink:#f0e6d6", "--aw-ink-bright:#fff6e0", "--aw-raise:#282017", "system-ui", "letter-spacing:.14em;text-transform:uppercase", "font-weight:800;letter-spacing:-.035em", "border-radius:999px;background:var(--aw-raise)", "section{margin:0 0 44px"]) expect(html).toContain(token);
    expect(html).not.toContain("monospace");
  });

  it("serves GET and HEAD at the same /rules address before a match; rejects other methods and subpaths", async () => {
    // A custom reference-grid HTTP scenario, built at grid scale 2 like every match.
    const config = playable({ ...PRE_FRONTLINE_PUBLIC_CONFIG, ticksPerSecond: 20, matchTicks: 36000,
      overrunGraceTicks: 14400, overrunTicks: 160, overrunRadiusTiles: 3,
      territoryDecayTicks: 300, hatchCost: 9, hatchIntervalTicks: 40, colonyCap: 321 });
    dataDir = mkdtempSync(join(tmpdir(), "antwar-rules-"));
    server = await startSpectatedServer({ port: 0, host: "127.0.0.1", match: "held", dataDir, simConfig: config });
    const url = `http://127.0.0.1:${server.port}/rules`;
    const get = await fetch(url);
    const html = await get.text();
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // With a build present, the page also names the Archive enhancement it was served with.
    expect(html).toBe(renderRules(config, { assets: readRulesAssets() }));
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect(await head.text()).toBe("");
    const post = await fetch(url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/missing`)).status).toBe(404);
    // Same route continues to use the actual match's configuration once it starts.
    server.startMatch();
    expect(await (await fetch(url)).text()).toBe(renderRules(server.game.match!.state.config, { assets: readRulesAssets() }));
  });
});

// The first section is for viewers, before command syntax; historical rules keep only their actual routes.
it("leads with the configured win routes as minutes-based bullets", () => {
  const config = rulesConfig("redesign");
  const first = ruleSections(config)[0]!;
  expect(first.title).toBe("How to win");
  expect(first.lines).toEqual([
    "Kill every enemy queen. Queens can be hurt after 5 minutes.",
    "From 10 minutes, hold at least 100 original-size tile areas and 6 times the opponent's territory for 5 minutes without a break.",
    "At 30 minutes, or if both colonies lose their last queen on the same tick (double overrun or queens killed), more kills wins. Ties go to territory, then living ants, then food delivered; if still equal, the match is a draw. Kills count enemy ants killed by the colony, including queen bites.",
  ]);
  const html = renderRules(config);
  const lead = html.slice(html.indexOf('<section id="how-to-win"'), html.indexOf('<section id="overview"'));
  expect(lead.match(/<li>/g)).toHaveLength(3);
  expect(lead).not.toContain("seconds");
  expect(lead).not.toContain("count_mark");
  expect(ruleSections(PUBLIC_CONFIG)[0]!.lines).toHaveLength(2);
  expect(ruleSections({ ...config, ticksPerSecond: 20 })[0]!.lines[1]).toContain("From 5 minutes");
});

describe("soft movement Rules copy", () => {
  it("shares the configured movement, queen-tile and physical receipt rules with the agent briefing", () => {
    const config = { ...rulesConfig("redesign"), pointArrival: undefined, nestDeliverTiles: 2,
      softSeparation: { radius: 80, strength: 1200, maxStep: 170, epsilon: 2, arrivalSubunits: 250, arrivalLinkRadius: 130 } };
    const text = ruleSections(config).flatMap(section => section.lines).join(" ");
    expect(text).toContain("Within 80 subunits");
    expect(text).toContain("strength 1200, edge epsilon 2");
    expect(text).toContain("steering+push <=170 subunits/tick");
    expect(text).toContain("points: 250 subunits");
    expect(text).toContain("links <=130 subunits");
    expect(text).toContain("Queens aren't bodies: no push/reserved/blocked tiles");
    expect(text).toContain("ants there push");
    expect(text).toContain("physically within 2 tiles");
    expect(text).toContain("Bites: within 2 tiles incl. diagonals");
    expect(text).toContain("Pickup: worker on stocked food tile");
    expect(text).toContain("Linked arrival: no remote pickup/delivery/bite");
    expect(ruleSections(rulesConfig("v4")).flatMap(section => section.lines).join(" ")).not.toContain("Personal space:");
    expect(ruleSections(rulesConfig("count-marks")).flatMap(section => section.lines).join(" ")).not.toContain("Personal space:");
  });
});

it.each([undefined, "redesign"] as const)("describes kills-first scoring for both endings in %s rules and full/compact briefing", rules => {
  const config = rulesConfig(rules);
  for (const text of [briefing(config), joinBriefing(config), ruleSections(config).flatMap(s => s.lines).join(" ")]) {
    expect(text).toMatch(/time-up/i);
    expect(text).toMatch(/both (?:colonies lose their last queen|last queens lost) (?:on the )?same tick/);
    // The same-tick last-queen phrase covers both double-overrun and HP endings.
    expect(text).toMatch(/kills.*territory.*(?:ants alive|living ants).*(?:food delivered|delivered food).*draw/s);
  }
  const { adjudication: _adjudication, ...recorded } = config;
  expect(briefing(recorded)).toContain("the larger territory wins");
  expect(joinBriefing(recorded)).toMatch(/time-up: (?:territory, ants alive, delivered food|the larger territory wins; ties: more ants alive, then more food delivered)/);
  expect(ruleSections(recorded)[0]!.lines.at(-1)).toContain("hold more territory");
});

it.each(["count-marks", "redesign"])("shares the FORAGE copy (%s)", name => {
  const config = rulesConfig(name);
  expect(renderRules(config)).toContain("FORAGE recruits workers only");
  expect(renderRules(config)).toContain("caste soldier is refused");
});

it("renders organic arrival values and walkable overflow without expanding combat selection", () => {
  const config = rulesConfig("redesign"), text = renderRules(config);
  expect(text).toContain("organic-cluster");
  expect(text).toContain("0.8 original tile");
  expect(text).toContain("workers and soldiers");
  expect(text).toContain(`${config.pointArrival!.jitter} subunits`);
  expect(text).toContain(`${config.pointArrival!.minimumSpacing} subunits`);
  expect(text).toContain("nearest walkable places just outside");
  expect(text).toContain("the area still decides combat targets");
});

describe("the /rules page follows the drawn map", () => {
  it("serves a running match, else an open start window's map, else the ended match, else the undrawn rotation", async () => {
    const rotation = newMatchConfig(boardRotation(2, [LANES_BOARD, WIDE_BOARD]));
    const seedFor = (id: string) => { for (let seed = 0; ; seed++) if (createTerrain(seed, rotation)!.mapId === id) return seed; };
    dataDir = mkdtempSync(join(tmpdir(), "antwar-rules-"));
    server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: rotation });
    // The entry-point server schedules nothing; its in-memory Game gets a synthetic slot lookup and clock,
    // so its public lobby lifecycle sets each state (as the seven-map capture's routes.mjs did).
    const game = server.game as unknown as Game;
    let clock = 0;
    const roster = Array.from({ length: 8 }, (_, i) => ({ identityId: `identity-${i}`, displayName: `Seat ${i}`, colony: (i % 2) as 0 | 1 }));
    Object.assign(game, { now: () => clock, onLogLine: () => {},
      slot: { identityOf: async (key: string) => roster.find(s => `key-${s.identityId}` === key)?.identityId, locate: async () => undefined } });
    const page = async () => (await fetch(`http://127.0.0.1:${server!.port}/rules`)).text();
    const lanes = createMatch(seedFor(LANES_BOARD.id), rotation).config, wide = createMatch(seedFor(WIDE_BOARD.id), rotation).config;
    // The server page carries the build's assets when a web build is present (main's Rules page).
    const assets = readRulesAssets();
    const lanesPage = renderRules(lanes, { assets }), widePage = renderRules(wide, { assets }), undrawnPage = renderRules(rotation, { undrawn: true, assets });
    expect(new Set([lanesPage, widePage, undrawnPage]).size).toBe(3);
    expect(lanesPage).toContain("The playable board is 128 tiles wide and 128 tiles high.");
    expect(widePage).toContain("The playable board is 256 tiles wide and 92 tiles high.");

    expect(await page()).toBe(undrawnPage);
    game.seatLobby("first", roster, "4v4");
    const closes = game.beginLobbyStart(seedFor(LANES_BOARD.id));
    expect(await page()).toBe(lanesPage);
    clock = closes;
    game.finishLobbyStart();
    expect(game.match!.result).toBeNull();
    expect(await page()).toBe(lanesPage);
    game.tick(true);
    expect(game.match!.result).not.toBeNull();
    expect(await page()).toBe(lanesPage);
    game.seatLobby("second", roster, "4v4");
    game.beginLobbyStart(seedFor(WIDE_BOARD.id));
    // The second window's map outranks the retained ended match.
    expect(await page()).toBe(widePage);
  });
});

// Moved from the retired dock.test.ts: the key the Agents panel shows (ui/agents.ts) and the public server's route.
describe("the key and the public route, as the spectator page shows them", () => {
  // A line breaks only after a separator: inside a term and before its separator the spaces are no-break spaces.
  it("keeps each term of the key whole and every separator at a line's end", () => {
    const text = keyText(VISUAL_KEY);
    expect(text.split("\u00a0· ").map((term) => term.includes(" "))).toEqual([false, false, false, false, false]);
    expect(text.replace(/\u00a0/g, " ")).toBe(VISUAL_KEY);
  });

  // Public setup metadata is withheld: the queen HP mode, not the private comparison name, carries the route.
  it("withholds the comparison setup from the public stream while the Rules page names the HP route", () => {
    const { simConfig, includeComparisonSetup } = comparisonOptions({}, DEFAULT_MCP_CONFIG);
    expect(simConfig).toMatchObject({ rules: "redesign", queenHp: {
      ...QUEEN_HP_RULES, regenClearTiles: QUEEN_HP_RULES.regenClearTiles * NEW_MATCH_GRID_SCALE,
    } });
    const recorder = new SpectatorRecorder(createMatch(COMPARISON_SEED, simConfig!));
    const hub = new LiveHub({ includeComparisonSetup });
    const first = decodeMessage(hub.payload({ ...recorder.initial(), full: recorder.initialFull() }));
    for (const field of ["rules", "seed", "players"]) expect(first.full!.setup).not.toHaveProperty(field);
    const route = queensRoute(simConfig!.queenHp, simConfig!.queenFounding);
    expect(route).toBe("all queens killed");
    expect(renderRules(simConfig!)).toContain(`Three ways a match ends: ${route}`);
  });
});
