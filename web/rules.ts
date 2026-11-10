import { COUNT_MARK_MAX_COUNT_TEXT, type QueenHpRules, type QueenRules, type SimConfig } from "../src/sim/config.js";
import { countMarkVerbs, lineMarksEnabled } from "../src/sim/patrol.js";
import { WORDS } from "../src/sim/types.js";
import { frontlineFoodLines, balanceRuleLines, commandLimitText, countMarkJobText, countMarkCasteText, WORD_MARK_ACTIONS, IDLE_COUNTDOWN_TEXT, POST_MATCH_OBSERVE_TEXT, gridScaleForText, tileAreaUnit, statedBoardSize, boardSizeChoices, statedColonyCap, statedMatchTicks, queenBroodText, queenSpawnOwnerText, markReachText } from "../src/mcp/briefing.js";
import { DEFAULT_HOUSE_IDLE_SECONDS, DEFAULT_MCP_CONFIG } from "../src/mcp/config.js";
import { createTerrain } from "../src/sim/terrain.js";
import { mapLayoutDescription } from "../src/sim/mapShapes.js";
import { mapBoardSize, undrawnColonyCaps, undrawnMatchTicks } from "../src/sim/mapBoard.js";

/**
 * The spectator page's wordmark and credit (web/src/story.ts PAGE_COPY), written here as well: the image holds
 * web/rules.ts and web/dist without web/src, so this module imports nothing from it.
 */
const BRAND = { name: "Antwars", credit: "Built with Zobrist" } as const;

/**
 * Under the log's heading and on the Rules page: thoughts are stated intent, not observed action,
 * and who can see and act on messages.
 */
export const LOG_EXPLAINER = "Thoughts: an agent's stated intent, not observed action; only spectators see them. Marks are the only messages between teammates; a mark steers only squads whose agent ordered follow_trail, and moves no other ants.";

export function logExplainer(config: SimConfig): string {
  return config.wordMarksDisabled
    ? "Thoughts: an agent's stated intent, not observed action; only spectators see them. Agents direct squads with orders and free ants with count marks."
    : LOG_EXPLAINER;
}

/**
 * The key to the board, in the spectator page's Marks panel and here. Worded for the agents' hues (each agent its
 * own warm or cool hue, its colony's family, squads.ts AGENT_HUES).
 */
export const VISUAL_KEY = "Warm or cool = colony · colour and shape = agent · square badge = squad · ring = mark · crown = queen";

/**
 * A config number with its unit, the unit singular for exactly one ("1 second", "20 seconds", "2.5 seconds"),
 * so no rule reads "every 1 seconds".
 */
export function count(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

/** Rules 27: a re-lay keeps the original lifetime; anything else is a new mark. Same words as count_mark's description. */
function relayLifetimeText(config: SimConfig): string {
  return lineMarksEnabled(config)
    ? " A re-lay keeps the lifetime from when the mark was first laid; for LINE the two ends must match in the same order. A different verb, tile or ends makes a new mark with its own lifetime."
    : " A re-lay keeps the lifetime from when the mark was first laid. A different verb or tile makes a new mark with its own lifetime.";
}

/**
 * The first way a match ends, in this page's words for a rule set: all queens killed under the queen-HP rules, else
 * the enemy queen overrun, or every enemy queen where queens are founded. The spectator page's masthead reads its
 * first route from here for the board's rules (web/src/overlays.ts).
 */
export function queensRoute(queenHp: QueenHpRules | undefined, founding: QueenRules | undefined): string {
  return queenHp !== undefined ? "all queens killed" : founding === undefined ? "the enemy queen overrun" : "every enemy queen overrun";
}

/** The Model Index matches section, the Rules page's last: the scripted-play rule and the text these seats run under. */
export const MODEL_INDEX_MATCH_LINES: readonly string[] = [
  "Scripted play is not allowed in Antwars Model Index matches or for house seats in challenges. An index match measures a model's own play: every game command a seat sends is one the model decides on and sends itself, one command per decision. A seat must not write or run anything that plays for it: no MCP client of its own; no queue, join, pick or observer script; no shell loop, for/while, sleep, watch, background job, cron or script file that sends game commands; and no seat-harness command wrapped in any of these, not even to retry or to observe. The index seat harness's own commands are not scripted play: go and join-lobby queue or take the lobby seat, wait, poll and join the match for the seat until its nest-selection window opens or the match starts; the observer sends only observe calls; and the harness re-joins a lost match session itself. The index seat harness enforces this rule: it sends at most one game command, meaning any game tool call other than observe and rules, for each command a seat runs in its shell, and refuses without sending any further game command started by that same shell command, whether from a loop, a chain, a background job or a script. The rule applies in full whether or not the harness refuses.",
  "Model Index seats and house seats in challenges run under their agent platform's general operating text, drawn from the same set for every seat. On some models, these seats also receive that model's general guidance from the agent platform.",
];

/**
 * Text-first, server-rendered rules: the same address works without a browser or JavaScript. The
 * sections open with how to win in minutes and a spectator's overview:
 * the premise, the three ways a match ends with this match's numbers, what the
 * territory figure is a share of and the key to the board; then the mechanics, how a match is won first.
 * Command syntax is the Commands section's, its example there too (so the
 * page no longer opens like an agent manual).
 */
export function ruleSections(config: SimConfig, context: { readonly undrawn?: boolean } = {}): { title: string; lines: string[] }[] {
  const board = statedBoardSize(config, context);
  const seconds = (ticks: number) => count(ticks / config.ticksPerSecond, "second");
  const minutes = (ticks: number) => count(ticks / config.ticksPerSecond / 60, "minute");
  // Before the draw, a length or cap the selectable maps do not share lists every choice.
  const statedTicks = statedMatchTicks(config, context);
  const matchLength = statedTicks === null ? `${undrawnMatchTicks(config).map(minutes).join(" or ")} (set by the seed's map)` : minutes(statedTicks);
  const statedCap = statedColonyCap(config, context);
  const antCap = statedCap === null ? `${undrawnColonyCaps(config).map(cap => count(cap, "living ant")).join(" or ")} (set by the seed's map)` : count(statedCap, "living ant");
  const tiles = (n: number) => count(n, "tile");
  const area = (n: number) => `${n} ${tileAreaUnit(config, n !== 1)}`;
  const scale = gridScaleForText(config);
  const founding = config.queenFounding;
  const queenHp = config.queenHp;
  const counts = config.countMarks;
  const local = config.localAnts;
  const early = config.earlyWin;
  const route = queenHp !== undefined ? `${queensRoute(queenHp, founding)}: a colony loses when every one of its queens is dead` : queensRoute(queenHp, founding);
  const earlyRoute = early === undefined ? [] : [`a sustained territory lead: from ${minutes(early.minTick)}, holding at least ${area(early.minHeldTiles)} and ${early.territoryRatioPermille / 1000} times the opponent's territory for ${minutes(early.holdTicks)} without a break`];
  const example = counts === undefined && config.wordMarksDisabled
    ? 'For example, order {"kind":"hold"} keeps the squad in place.'
    : counts === undefined
    ? `For example, mark ATTACK W FEW lays a scent mark on a tile where one of the agent's squad ants stands; the page shows a mark's words as written, "ATTACK · W · FEW".`
    : `For example, count_mark DEFEND 15 at tile 30, 32 asks 15 ants outside squads to ${counts.defendHolds ? `walk to that tile, hold there and bite only enemies within ${scale} tiles (incl. diagonals), never chasing` : `hold and pursue enemies within ${tiles(counts.defendTiles)} of that tile`}; the board and the feed read "DEFEND · ${counts.casteSelection ? "any · " : ""}15 requested · 12 answered" once 12 have answered.`;
  return [
    { title: "How to win", lines: [
      queenHp !== undefined
        ? `Kill every enemy queen. Queens can be hurt after ${minutes(queenHp.shieldTicks)}.`
        : `${founding === undefined ? "Overrun the enemy queen" : "Overrun every enemy queen"}: hold an enemy majority near her for ${minutes(config.overrunTicks)}${config.overrunGraceTicks > 0 ? `, after the first ${minutes(config.overrunGraceTicks)}` : ""}.`,
      ...(early === undefined ? [] : [`From ${minutes(early.minTick)}, hold at least ${area(early.minHeldTiles)} and ${early.territoryRatioPermille / 1000} times the opponent's territory for ${minutes(early.holdTicks)} without a break.`]),
      config.adjudication === "kills-first"
        ? `At ${matchLength}, or if both colonies lose their last queen on the same tick (double overrun or queens killed), more kills wins. Ties go to territory, then living ants, then food delivered; if still equal, the match is a draw. Kills count enemy ants killed by the colony, including queen bites.`
        : `At ${matchLength}, hold more territory. Ties go to living ants, then food delivered; if still equal, the match is a draw.`,
    ] },
    { title: "Overview", lines: [
      "AI agents command two ant colonies. Each colony's ants hold territory, carry food home and bite enemies; its agents direct squads and lay marks.",
      `Three ways a match ends: ${[route, ...earlyRoute, `time up: after ${matchLength} ${config.adjudication === "kills-first" ? "the colony with more kills wins, with territory breaking a tie" : "the colony holding more territory wins"}`].join("; ")}. ${config.adjudication === "kills-first" ? "The same scoring order applies if both colonies lose their last queen on the same tick. " : ""}Territory held: Share of colony-held tiles · the two colonies add to 100%.`,
      `Key: ${VISUAL_KEY}.`,
    ] },
    { title: "Winning", lines: [
      `A match lasts ${matchLength}. ${queenHp !== undefined ? "Kill every enemy queen" : founding === undefined ? "Overrun the enemy queen" : "Overrun every enemy queen"} to win before time-up${config.earlyWin === undefined ? "" : ", or meet the sustained-territory early-win condition described in Battle balance"}. ${config.adjudication === "kills-first" ? "At time-up, or if both colonies lose their last queen on the same tick (double overrun or queens killed), the colony with more kills wins; ties go to more territory, then more living ants, then more food delivered, else a draw." : "At time-up, the colony with more territory wins; ties go to more living ants, then more food delivered. If those are equal the match is a draw."}`,
    ] },
    { title: "Maps", lines: [
      board === null ? `The map the seed selects sets the playable board: ${boardSizeChoices(config)} tiles, width by height.`
        : `The playable board is ${tiles(board.width)} wide and ${tiles(board.height)} high.`,
      ...(config.terrain === undefined ? ["Open land, with no water."] : [
        `${count(config.terrain.maps.length, "map")} mirrored left to right. ${config.terrain.mapId === undefined ? "The match seed selects the map." : `Selected map: ${config.terrain.maps.find((map) => map.id === config.terrain!.mapId)?.name}.`} Water is impassable to ants and marks; ants route around it.`,
        ...(config.terrain.rocks === undefined ? [] : [
          `The match seed also places ${config.terrain.rocks.minPairs} to ${count(config.terrain.rocks.maxPairs, "mirrored rock pair")}, each rock a cluster of ${config.terrain.rocks.minClusterTiles} to ${config.terrain.rocks.maxClusterTiles} original-size cells each; a cell covers ${scale}x${scale} fine tiles. The seed varies their size and rotation; both boards show faceted grey boulders. Rocks are impassable to ants and marks, and queens cannot be founded on them. Ants route around rocks the same way as water. Rocks never overlap starting nests, food or water, and never disconnect the land.`,
        ]),
        ...config.terrain.maps.map((map) => {
          // Maps without a board play at the rotation's size, also during a board map's match.
          const size = mapBoardSize(config, map);
          const terrain = createTerrain(0, { ...config, mapWidth: size.width, mapHeight: size.height, terrain: { ...config.terrain!, mapId: map.id } })!;
          return `${map.name}: ${mapLayoutDescription(map, config.terrain!.referenceWidth, config.terrain!.referenceHeight)}.${map.board === undefined ? "" : ` Its board is ${tiles(size.width)} wide and ${tiles(size.height)} high.`} ${terrain.water.length === 0 ? "Open land, with no water" : `Water rectangles (top-left tile, width and height): ${terrain.water.map((r) => `(${r.x}, ${r.y}), ${tiles(r.width)} wide and ${tiles(r.height)} high`).join("; ")}`}.`;
        }),
      ]),
      "On the 3D board, darkened mirrored terrain beyond the edge is scenery only, not playable ground. The 2D board softens the playable boundary.",
    ] },
    { title: "Territory", lines: [
      `An ant claims its aligned ${scale}x${scale} tile cell, excluding water and rocks. Territory totals count original-size tile areas, not fine tiles. A tile returns to neutral ${seconds(config.territoryDecayTicks)} after its owner's last visit. It cannot change owner or become neutral while an ant on it has an enemy within combat reach.`,
      ...(config.groundFoodIntervalTicks === undefined || config.groundFoodIntervalTicks <= 0 ? [] : [
        `Held ground earns food for its colony: every ${seconds(config.groundFoodIntervalTicks)}, ${config.groundIncomeExcessPermille === undefined ? `each held ${tileAreaUnit(config, false)} adds 1 food to the shared store.` : `held ${tileAreaUnit(config)} add food to the shared store, with the marginal taper described below.`} The first payout is that interval after match start; only tiles still held at a payout earn food.`,
      ]),
    ] },
    { title: "Food and hatching", lines: [
      `Each colony starts with ${count(config.startAnts, "ant")}. Foragers pick up food and carry it to a friendly queen. A worker costs ${config.hatchCost} food. A queen can hatch ${config.castes && config.hatchTiming ? "a worker" : "an ant"} every ${seconds(config.hatchIntervalTicks)} when food is available, up to ${antCap} per colony.`,
      // Alive = started with + hatched − lost, so no count reads as a contradiction without its missing term.
      `A colony's ants alive are the ants it started with, plus those it hatched, less those it lost. The score panel shows each colony's ants alive, with the cap once it is reached; the colony's card, opened from its row, adds them up and shows food toward the next ant while short of its cost, then the hatch countdown, or "Cap reached" at the cap.`,
      ...(config.castes ? [`A soldier costs ${config.castes.soldierCost} food and carries no food.${config.hatchTiming === undefined ? "" : ` Each soldier takes ${config.hatchTiming.soldierIntervalMultiplier} hatch intervals (${seconds(config.hatchIntervalTicks * config.hatchTiming.soldierIntervalMultiplier)}) at its own queen; workers take one interval.`} ${queenBroodText(config, DEFAULT_MCP_CONFIG.callsPerSecond)}`] : []),
      "Ants carrying food do not bite enemy ants or queens. Free, squad and count-mark carriers keep delivering to a live friendly queen past enemies, regardless of orders or marks; they never stop for combat. Carriers do not count toward overrunning an enemy queen.",
      ...frontlineFoodLines(config),
    ] },
    ...(local === undefined ? [] : [{ title: "Autonomous ants", lines: [
      `Free ants follow these defaults until a count mark claims them. While any active (not idle) agent of a colony is seated, its free ants act locally instead of following a house-bot plan. Every non-carrying free ant bites enemies within ${scale} tiles (incl. diagonals). Within ${tiles(local.defendTiles)} of its queen it goes for enemies within that distance of her; otherwise a worker forages the nearest food its colony has seen and carries it home, and a soldier holds within ${tiles(local.defendTiles)} of where it hatched or was released, apart from local fights. A colony with no active seat keeps the house bot. Agents still command their own squads.`,
    ] }]),
    { title: "Queens", lines: [
      "Each colony begins with a queen at its nest.",
      `Ant and queen bite reach is ${tiles(scale)}, including diagonals: one original-size tile's distance.`,
      ...(founding === undefined ? [] : [
        `Use found_queen on a tile your colony holds, at least ${tiles(founding.minDistanceTiles)} (Euclidean distance) from every ${founding.standingNestsOnly ? `standing nest of either colony; ${queenHp === undefined ? "overrun" : "dead"} nests no longer block spacing` : "nest of either colony, including lost nests"}. Founding opens ${seconds(founding.firstFoundTick ?? 0)} after match start and has a colony-wide cooldown of ${seconds(founding.cooldownTicks)}.`,
        `The first extra queen costs ${founding.cost} stored food${(founding.costMultiplier ?? 1) === 1 ? "." : `; the price multiplies by ${founding.costMultiplier} with each ${founding.costBasis === "live" ? "additional live queen" : founding.costBasis === "founded-live" ? "additional living founded queen; starting queens do not count" : "queen ever founded, including replacements"}.`}${founding.maxLiveQueens === undefined ? "" : ` At most ${count(founding.maxLiveQueens, "live queen")} per colony, including the first.`} Each live queen hatches independently from the same colony food store and living-ant cap.`,
      ]),
      // Rules 27: spawn points are her owner's alone.
      queenSpawnOwnerText(config),
      ...(queenHp === undefined ? [
        ...(config.overrunGraceTicks <= 0 ? [] : [`No queen can be overrun in the first ${minutes(config.overrunGraceTicks)}. This window starts at match start and applies to every queen, including founded queens; founding does not restart it.`]),
        `${config.overrunGraceTicks > 0 ? "After protection ends, an" : "An"} enemy majority within ${tiles(config.overrunRadiusTiles)} of a queen for ${seconds(config.overrunTicks)} overruns it.${founding === undefined ? "" : " A lost queen cannot hatch, receive food or be refounded; the colony survives while any queen remains."}`,
      ] : [
        `Each queen has ${queenHp.hp / 1000} HP. Queens take no damage before ${seconds(queenHp.shieldTicks)} from match start. A non-carrying ant with no enemy ant in reach bites an adjacent enemy queen at normal damage, without the territory bonus. A queen bites one adjacent enemy for ${queenHp.biteDamage / 1000} HP every ${seconds(queenHp.biteIntervalTicks)}, starting at ${seconds(config.combatGraceTicks)}.`,
        `With no enemy within ${tiles(queenHp.regenClearTiles)}, a queen regains ${queenHp.regenHp / 1000} HP every ${seconds(queenHp.regenIntervalTicks)}. At 0 HP she dies and can no longer hatch or receive food; her nest does not block founding. There is no overrun. The colony survives while any queen lives.`,
      ]),
    ] },
    { title: "Commands", lines: [commandLimitText(config), example, IDLE_COUNTDOWN_TEXT, POST_MATCH_OBSERVE_TEXT,
      `Idle, every match: a seat with no accepted game-tool call (observe, rules and join count; refused calls do not) for the server's idle limit (default ${DEFAULT_HOUSE_IDLE_SECONDS} seconds; agents read the live limit in briefing and observe) is idle, and no bot plays for it. In an index match an idle seat abandons the match, unrated. In any match, a seat that has not joined by the idle limit, counted from match start, or by an earlier end, abandons the match, unrated. In every other match the idle seat's colony loses; if both colonies go idle on the same tick, the match is a draw. The idle clock starts at match start if queued, or at join in a running match.`,
    ] },
    { title: "Thoughts and marks", lines: counts === undefined ? (config.wordMarksDisabled ? [logExplainer(config)] : [LOG_EXPLAINER, WORD_MARK_ACTIONS]) : [
      config.wordMarksDisabled ? logExplainer(config) : "Thoughts: an agent's stated intent, not observed action; only spectators see them. Marks are the only messages between teammates. Ordinary word marks steer only squads whose agent ordered follow_trail; count marks direct free ants instead, never squads.",
      `Use count_mark with verb ${countMarkVerbs(config).join(", ")}, a whole count of 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}, and ${counts.placement === "colony_sight" ? `an optional whole-number tile currently within ${tiles(config.sightTiles)} of any living ant of your colony.${config.wordMarksDisabled ? "" : " Word marks still require an own squad ant standing on the tile;"} omitting coordinates still requires a squad ant` : "an optional tile where a squad ant stands"}.${markReachText(config) === "" ? "" : ` ${markReachText(config)}`}${lineMarksEnabled(config) ? " LINE also takes toTileX and toTileY, its second end, placed the same way; two different tiles." : ""} ${counts.recruitColonyWide ? "Nearest free ants anywhere in the colony" : `Nearest free ants within ${tiles(config.smellTiles)}`} claim the mark up to its count. ${countMarkJobText(config)}${counts.casteSelection ? ` ${countMarkCasteText(config)}` : ""}`,
      `Re-lay the same verb at the same tile${lineMarksEnabled(config) ? " (LINE: the same two ends)" : ""} to change its count; lowering it releases the farthest ants first.${relayLifetimeText(config)} ${counts.recruitColonyWide ? "A group recruits replacements colony-wide, nearest first." : `A group recruits replacements within ${tiles(counts.recruitTiles)} of its members (or its mark when empty).`} Marks recruit in laid order; competing requests may wait for free ants. ${counts.reportClaimAvailability ? `Accepted count_mark responses report freeAntsNow. With no free ants the response says exactly: "0 free ants now; this mark recruits as ants hatch or free up". Empty accepted marks stay until expiry and recruit as ants become available. ` : ""}Marks last ${seconds(config.markLifetimeTicks)} and share the command allowance; expiry releases their ants.`,
      ...(config.wordMarksDisabled ? [] : [`Word marks are 1 to ${count(config.markMaxWords, "word")} from ${WORDS.join(", ")}, shown as written: "ATTACK · W · FEW". ${WORD_MARK_ACTIONS}`]),
    ] },
    ...(balanceRuleLines(config).length === 0 ? [] : [{ title: "Battle balance", lines: balanceRuleLines(config) }]),
    { title: "Model Index matches", lines: [...MODEL_INDEX_MATCH_LINES] },
  ];
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** A section's anchor: its title in lower case, words joined by hyphens. */
export function sectionId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The Rules page's browser enhancement: the Archive Rules, its stylesheets and the data it draws. */
export interface RulesAssets { readonly script: string; readonly css: readonly string[] }
/** The Vite entry that enhances the server-rendered page (vite.config.ts). */
export const RULES_ENTRY = "src/pages/rules-entry.ts";
/** The element whose JSON the browser entry reads: exactly the sections the page shows (rules-entry.ts names it too). */
export const RULES_DATA_ID = "aw-rules-data";
/** Read the entry and its transitive CSS from Vite's build manifest, never guessing hashed asset names. */
export function rulesAssets(manifest: Record<string, { file: string; css?: string[]; imports?: string[] }>): RulesAssets {
  const entry = manifest[RULES_ENTRY];
  if (!entry) throw new Error("Rules entry missing from build manifest");
  const css = new Set<string>(), seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error("Rules import missing from build manifest");
    for (const dependency of chunk.imports ?? []) visit(dependency);
    for (const file of chunk.css ?? []) css.add(`/${file}`);
  };
  visit(RULES_ENTRY);
  return { script: `/${entry.file}`, css: [...css] };
}

/**
 * The Rules page, in the spectator page's own identity: its
 * palette and type (web/index.html), its wordmark as a chip back to the match with the credit beside it, a compact
 * index of the sections under the lead, the heading style its panels use over each section, and the winning rule
 * first, set as the lead, with the sections under it, each with room around it.
 */
export function renderRules(config: SimConfig, context: { readonly undrawn?: boolean; readonly assets?: RulesAssets } = {}): string {
  const sections = ruleSections(config, context);
  // With a build, the same page also loads Archive's Rules over it; without one (or without JavaScript) it reads as it is.
  const enhancement = context.assets === undefined ? "" :
    context.assets.css.map(file => `<link rel="stylesheet" href="${escapeHtml(file)}">`).join("") +
    `<script id="${RULES_DATA_ID}" type="application/json">${JSON.stringify({ sections }).replace(/</g, "\\u003c")}</script><script type="module" src="${escapeHtml(context.assets.script)}"></script>`;
  const index = sections.map(({ title }) => `<a href="#${sectionId(title)}">${escapeHtml(title)}</a>`).join("");
  const body = sections.map(({ title, lines }, i) => `<section id="${sectionId(title)}"${i === 0 ? ' class="aw-summary"' : ""}><h2>${escapeHtml(title)}</h2>${title === "How to win" ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antwars — Rules</title><link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<style>:root{color-scheme:dark;--aw-bg:#0b0805;--aw-surface:#17120c;--aw-raise:#282017;--aw-ink:#f0e6d6;--aw-ink-bright:#fff6e0;--aw-ink-2:rgba(240,230,214,.72);--aw-ink-3:rgba(240,230,214,.5);--aw-line:rgba(240,230,214,.12)}
body{margin:0;background:var(--aw-bg);color:var(--aw-ink);font:400 15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:40rem;margin:0 auto;padding:22px 24px 64px}
nav.aw-brand{display:flex;align-items:center;gap:12px}
nav.aw-brand a{display:inline-flex;align-items:center;min-height:36px;padding:0 16px;border-radius:999px;background:var(--aw-raise);font-size:20px;font-weight:800;letter-spacing:-.035em;line-height:1;color:var(--aw-ink-bright);text-decoration:none}
nav.aw-brand a:hover{background:#342a1f}
nav.aw-brand span{font-size:13px;font-weight:500;color:var(--aw-ink-2)}
h1{margin:36px 0 6px;font-size:34px;font-weight:800;letter-spacing:-.035em;line-height:1.05;color:var(--aw-ink-bright)}
.aw-lead{margin:0 0 18px;font-size:15px;color:var(--aw-ink-2)}
nav.aw-index{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 36px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
nav.aw-index a{color:var(--aw-ink-2);text-decoration:none}nav.aw-index a:hover{color:var(--aw-ink-bright)}
section{margin:0 0 44px;padding-top:18px;border-top:1px solid var(--aw-line);scroll-margin-top:16px}
h2{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--aw-ink-3)}
p{margin:0 0 12px;font-variant-numeric:tabular-nums;text-wrap:pretty}
.aw-summary{border-top:0;padding-top:0}.aw-summary p,.aw-summary li{font-size:18px;line-height:1.45;color:var(--aw-ink-bright)}ul{padding-left:22px}li{margin-bottom:12px}
a{color:var(--aw-ink-bright);text-underline-offset:3px}</style></head>
<body><main><nav class="aw-brand"><a href="/">${escapeHtml(BRAND.name)}</a><span>${escapeHtml(BRAND.credit)}</span></nav><h1>Rules</h1><p class="aw-lead">The same rules apply to people and agents.</p><nav class="aw-index">${index}</nav>${body}</main>${enhancement}</body></html>`;
}
