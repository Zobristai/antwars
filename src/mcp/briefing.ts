import { COLONY_NAMES, COUNT_MARK_MAX_COUNT_TEXT, damagePerTick, type SimConfig } from "../sim/config.js";
import { countMarkVerbs, lineMarksEnabled } from "../sim/patrol.js";
import { COUNT_CASTES, WORDS } from "../sim/types.js";
import { hasDistinctMapLayouts, mapLayoutDescription } from "../sim/mapShapes.js";
import { undrawnBoardSize, undrawnBoardSizes, undrawnColonyCaps, undrawnMatchTicks, type BoardSize } from "../sim/mapBoard.js";
import { agentLimitText, DEFAULT_MCP_CONFIG, MAX_OBSERVE_WAIT_SECONDS, sessionExpiryText, houseIdleSecondsOf, type McpConfig } from "./config.js";
import { CELL_ENCODING } from "../sim/view.js";
import { TERRITORY_TEXT } from "./territory.js";
import { MARK_TABLE_TEXT } from "./markTable.js";
import { USERNAME_RETENTION_TEXT } from "../identity/retention.js";
import { gridScaleOf } from "../sim/gridScale.js";

/** The grid scale the text describes: every playable config carries 2. */
export function gridScaleForText(config: SimConfig): number {
  return gridScaleOf(config);
}

/** Area thresholds and income retain original-tile units, unlike coordinate distances. */
/** Say "in reach" where the reply defines bite reach once. */
function reachDefinedOnce(config: SimConfig): boolean {
  return lineMarksEnabled(config);
}

export function tileAreaUnit(_config: SimConfig, plural = true): string {
  return plural ? "original-size tile areas" : "original-size tile area";
}

export function colonyVisibilityText(config: SimConfig): string {
  return `observe shows what any living ant of your colony currently sees (${config.sightTiles} tiles around each colony ant).`;
}

export function usesCompactAgentText(config: SimConfig): boolean {
  return config.countMarks?.combatTotals === true;
}

// Account instructions are prose only; keep ownership wording separate for later edits.
const IDENTITY_GUIDANCE = `Accounts are required and agent-created: claim exactly one username, never extra or speculative names. Keep and reuse its key; ${USERNAME_RETENTION_TEXT}`;
const KEY_OWNERSHIP_GUIDANCE = "First agent claims a username. Its key holder: create_handle per extra agent; each gets only its own handle key. Humans see no keys.";
const KEY_HANDLING_GUIDANCE = `Shown once: store privately same turn; never show/hand keys to humans. Secret: harness secret store if available; else file outside repositories readable only by you (~/.antwars/key) or ANTWARS_KEY. Never commit keys or put them in match chat/public output/another tool/site; only Antwars tools requiring keys. Later: read ANTWARS_KEY/file first; missing: ask operator, never claim a new username. Leak: rotate_key at once. ${KEY_OWNERSHIP_GUIDANCE} Server reads neither ANTWARS_KEY nor ~/.antwars/key.`;
const LOBBY_GUIDANCE = "No human account/lobby page controls; agents manage both. Private: give humans inviteLink to share/watch, never keys or spectatorUrl. list_lobbies/create_lobby: public/private, 1-4 agents/colony. Creation never seats you; join_lobby {key,colony?}, colony 0/1 (full: colony_full). Private: inviteToken, not keys. Open lobby TTL: 12 h. Last seat starts; creator start_lobby: both colonies seated. read_lobby waiting for a slot->locate_match->mcpUrl->connect, join with seated key. Ranked 2v2-4v4: one agent plays every colony seat, one session/seat. Only ranked-queue games are rated; lobby games are unrated. join_queue {key,mode:\"1v1\"}: random different-owner waiting opponent, else wait; one entry/identity. Handle owner=username owner; no exemption, even antwars. queue_status {key}: waiting, matched (lobbyId; read_lobby -> locate_match) or expired. leave_queue {key} leaves. Unpaired TTL: 12 h, no game/rating change. Before joining, have a way to notice the match: antwars-seat `go` (queue) or `join-lobby <lobbyId>` (public lobby; private: join_lobby yourself) joins for you; stay in turn on it or run it as a background job that wakes you. Or wait for done on your waitUrl (SSE; see join_queue). Matched: 2 min to pick a nest; idle rule (300 s by default). Natural results: Glicko 1500±350, team means. Ranked 1v1-4v4 ratings are separate; results affect only their mode. rating: username[/handle], mode. leaderboard: mode, at least one rated match in that mode. Both default to 1v1; everyone includes antwars-owned agents; scope house: only antwars-owned identities (the ranked ladder's house-models table). Index matches, modes house-1v1..house-4v4: only antwars-owned handles join; each has its own rating; unpaired TTL: 15 min.";
const HOUSE_MODE_GUIDANCE = "Index matches, modes house-1v1..house-4v4: only antwars-owned handles join; each has its own rating; unpaired TTL: 15 min. Lobby slot: locate_match with lobbyId, then connect and join with your seated key. Joining never creates a seat.";
const REJOIN_GUIDANCE = "Lobby slot servers: join {key}, seated key; reuse to rejoin, no reconnectToken. Ranked 2v2-4v4, several seats: each session joins {key, seat}, seat 1..team size, one seat per session; rejoin with the same key and seat. seat may be omitted only when you hold one seat. Explicit private test harnesses only: rejoin with join {reconnectToken}; token is an alias. No join at the entry point.";

export const FOOD_RADIX_TEXT = `Read cells.foodRadix anew per reply. ${CELL_ENCODING}`;

export const CELL_PAGING_TEXT = "First: all squad-visible cells, then colony cells if space. While cellsMore: observe {cellsCursor:view.cellsCursor}; event since is separate. cellsTick stays fixed. No cellsCursor replaces the snapshot. Reconnect keeps it; stale: restart.";

export const ENEMY_QUEENS_TEXT = "view.enemyQueens [{tileX,tileY,hp}]: enemy queens in this reply's cells only, same tick; hp=queenHp milli-HP, absent if cells omit it. Fogged queens never appear.";

export const COMPACT_VIEW_TEXT = "Decode via observe tool. map:true territory: base64-bitset-lsb0; marks/myMarks: columnar-v1.";

/** Rules 27: no colony brood vote, so squad_replaced is the one seat-private notice. */
export const SEAT_NOTICE_TEXT = "Seat-private priority event: squad_replaced (tick) means no ant from your last nonempty squad remains and other ants now fill it; initial assignment and partial changes do not count. It survives reconnects and match end in since:0 history, and reaches you outside squad sight, like own-queen events.";

/** Reconnect replies also carry a full view: keep the join explanation compact. */
export const SEAT_NOTICE_BRIEF = "Seat priority: squad_replaced = last nonempty squad wholly replaced, never initial/partial.";

/** Availability precedes the command; answered claims come from the resulting mark. */
export function countMarkReplyText(config: SimConfig): string {
  const merged = lineMarksEnabled(config) && config.countMarks?.reportClaimAvailability === true;
  return `${merged ? "mark.claimed and countMark.claimed count this mark's own answered ants in the resulting view, not the colony total." : "mark.claimed is this mark's own answered ants in the command's resulting view, not the colony total."}${config.countMarks?.reportClaimAvailability ? `${merged ? "" : " countMark.claimed reports the same own-mark count."} countMark.claimedAnts is the colony-wide total already answering count marks before this command; freeAntsNow is eligible free colony ants before this command.` : ""}${config.countMarks?.casteSelection ? ` Replies, notices and history include caste only for worker or soldier${lineMarksEnabled(config) ? "" : "; omitted means any"}.` : ""}`;
}

/** Whole seconds for a tick count, as the agent sees time. */
function seconds(config: SimConfig, ticks: number): number {
  return ticks / config.ticksPerSecond;
}

/** The commands admitted through the sim's shared lastCommandTick check. */
export function commandLimitText(config: SimConfig): string {
  const names = ["order", ...(config.wordMarksDisabled ? [] : ["mark"]), ...(config.countMarks === undefined ? [] : ["count_mark"]), ...(config.queenFounding === undefined ? [] : ["found_queen"])];
  const commands = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `One command per ${seconds(config, config.commandFloorTicks)} s: ${commands} share one allowance per agent${config.wordMarksDisabled ? "." : "; an order and the mark it carries count as one command."} observe does not use this allowance.`;
}

/** Admission policy, distinct from the simulation's command allowance. */
function callLimitText(config: McpConfig): string {
  return `Call limit: at most ${config.callsPerSecond} calls per agent in any sliding one-second window; join (including reconnectToken reconnect), rules and observe count, as do commands. On call_rate wait retryAfterMs before retrying. Rate refusals do not reset the idle timer.`;
}

/** Shared by the observe legend, briefings and spectator rules; the wire stays positional. */
export const IDLE_COUNTDOWN_TEXT = "idleSecondsLeft: seconds left before the seat goes idle and its colony loses (index match: the match is abandoned); null unseated or match ended";

/** undrawn: the seed has not yet drawn the map, so config is the rotation's, not the match's.
 * local: the server serves no accounts (the local route), so no account, key or lobby text. */
export interface BriefingContext { readonly house: boolean; readonly undrawn?: boolean; readonly local?: boolean }

/** The board size a reply may state: the drawn match's, or before the draw the size every
 * selectable map shares. Null when those sizes differ: no single size is stated. */
export function statedBoardSize(config: SimConfig, context: Pick<BriefingContext, "undrawn"> = {}): BoardSize | null {
  return context.undrawn === true ? undrawnBoardSize(config) : { width: config.mapWidth, height: config.mapHeight };
}

/** The ant cap a reply may state: the drawn match's, or before the draw the cap every
 * selectable map shares. Null when those caps differ: no single cap is stated. */
export function statedColonyCap(config: SimConfig, context: Pick<BriefingContext, "undrawn"> = {}): number | null {
  if (context.undrawn !== true) return config.colonyCap;
  const caps = undrawnColonyCaps(config);
  return caps.length === 1 ? caps[0]! : null;
}

/** The match length in ticks a reply may state, as statedColonyCap. */
export function statedMatchTicks(config: SimConfig, context: Pick<BriefingContext, "undrawn"> = {}): number | null {
  if (context.undrawn !== true) return config.matchTicks;
  const ticks = undrawnMatchTicks(config);
  return ticks.length === 1 ? ticks[0]! : null;
}

/** The numeric ant cap, stated once. */
function antCapText(config: SimConfig, context: Pick<BriefingContext, "undrawn">): string {
  const cap = statedColonyCap(config, context);
  return cap === null ? ` Ant cap ${undrawnColonyCaps(config).join(" or ")}/colony, set by the seed's map.` : ` Ant cap ${cap}/colony.`;
}

/** The join briefing's match length: the stated length, or before the draw every selectable length. */
function joinLengthText(config: SimConfig, context: Pick<BriefingContext, "undrawn">): string {
  const ticks = statedMatchTicks(config, context);
  return ticks === null ? `${undrawnMatchTicks(config).map(t => seconds(config, t)).join(" or ")} s, set by the seed's map` : `${seconds(config, ticks)} s`;
}

/** Before the draw, when maps differ in size: every size the seed can select. */
export function boardSizeChoices(config: SimConfig): string {
  return undrawnBoardSizes(config).map(size => `${size.width}x${size.height}`).join(" or ");
}

/** The one idle rule of every live match, with the live limit. */
export function houseIdleText(mcpConfig: McpConfig = DEFAULT_MCP_CONFIG): string {
  return `Idle, every match: a seat with no accepted authenticated game-tool call (observe, rules, join count; refusals do not) for ${houseIdleSecondsOf(mcpConfig)} s is idle; no bot takeover. Index match (house-*), or a seat not joined by the limit from match start or an earlier end: match abandoned, unrated. Other matches: the idle seat's colony loses (rated if ranked); both colonies idle on one tick: draw.`;
}

export const HOUSE_IDLE_PROMPT_TEXT = "Idle rule, every match: any seat with no accepted authenticated game-tool call (observe, rules and join included) for the server's configured idle limit is idle, with no bot takeover. In index matches an idle seat abandons the match, unrated; in any match a seat that has not joined by the idle limit, counted from match start, or by an earlier end, abandons the match, unrated; in every other match the idle seat's colony loses, and both colonies idle on the same tick is a draw. Read the live limit in briefing and observe.";

export const POST_MATCH_OBSERVE_TEXT = "Match over: matchOver:true, winner/draw, result; no match clocks.";

/** Command-idle timing before the first accepted command, not time spent waiting for a match. */
export const IDLE_CLOCK_START_TEXT = "Idle clock and first-command window start at match start if queued, or at join in a running match.";

/** The briefings open with the idle rule, so they pass withIdleRule=false; the observe tool description keeps it. */
export function observeDetailText(config: SimConfig, mcpConfig: McpConfig = DEFAULT_MCP_CONFIG, context: BriefingContext = { house: false }, withIdleRule = true): string {
  return `observe status: [${context.house ? "idleSecondsLeft: seconds to abandonment, null unseated or match ended" : IDLE_COUNTDOWN_TEXT}, space-separated resetting tools${config.rules === "redesign" ? ", enemy share" : ""}]. Shares: whole-map permille (1000=map). territoryTiles counts original-size tile areas, not fine tiles.${config.rules === "redesign" ? " Enemy share: your tick/sight; enemy map fogged." : " Enemy share/map hidden."} ${POST_MATCH_OBSERVE_TEXT} houseIdleSeconds is the live server limit.${withIdleRule ? ` ${houseIdleText(mcpConfig)}` : ""}${config.countMarks?.combatTotals ? " Unspent colony food: view.queenFounding.foodStore. Each listed count mark in marks/myMarks shows lost (ants that died while claimed) and kills (enemy ants killed by its claimed ants), since the mark was laid. A kill is credited to one ant, never shared: the biggest hit on the death tick wins, lowest ant id on ties; a queen's bigger or equal hit wins instead. Only that ant's current mark gets the kill, even if the ant also dies. Released ants no longer add to that mark. Totals survive count/caste changes and observes, and end with expiry or replacement." : ""}${config.patrolLinkTiles === undefined ? "" : " Patrol marks: chain=oldest mark id; position=zero-based laid-order loop index."}`;
}

/** The line that starts the caste sentences (rules switch on only). */
export const CASTES_LEAD = "- Castes:";

/**
 * The castes in at most three sentences, only with the caste switch on.
 */
function casteLines(config: SimConfig, hp: (milli: number) => number, callsPerSecond: number): string[] {
  const compact = usesCompactAgentText(config);
  if (config.castes === undefined) return [];
  const { soldierCost, soldierHpPermille, soldierDamagePermille } = config.castes;
  const soldierHp = hp(Math.trunc((config.antHp * soldierHpPermille) / 1000));
  const soldierDps = hp(Math.trunc((damagePerTick(config) * soldierDamagePermille) / 1000) * config.ticksPerSecond);
  // Rules 27: each agent sets its own queens' brood with set_brood.
  const brood = queenBroodText(config, callsPerSecond);
  return [
    compact ? `${CASTES_LEAD} worker: ${config.hatchCost} food, stats above; soldier: ${soldierCost} food, ${soldierHp} HP, ${soldierDps} HP/s plus territory bonus, carries no food${config.hatchTiming === undefined ? "" : `; at each queen a worker takes one hatch interval (${seconds(config, config.hatchIntervalTicks)} s), a soldier takes ${config.hatchTiming.soldierIntervalMultiplier} hatch intervals (${seconds(config, config.hatchIntervalTicks * config.hatchTiming.soldierIntervalMultiplier)} s)`}. ${brood}` : `${CASTES_LEAD} a worker costs ${config.hatchCost} food and is the ant above; a soldier costs ${soldierCost} food, has ${soldierHp} HP, deals ${soldierDps} HP per second (plus the territory bonus) and carries no food${config.hatchTiming === undefined ? "" : `; at each queen a worker takes one hatch interval (${seconds(config, config.hatchIntervalTicks)} s), a soldier takes ${config.hatchTiming.soldierIntervalMultiplier} hatch intervals (${seconds(config, config.hatchIntervalTicks * config.hatchTiming.soldierIntervalMultiplier)} s)`}. ${brood}`,
  ];
}

/**
 * Count marks: present only when the match has them, so
 * today's briefing is unchanged.
 */
/** Rules 26 LINE job; the caste and placement lines already state FORAGE's workers-only rule and where ends may go. */
export const LINE_JOB_TEXT = "LINE runs tileX/tileY to toTileX/toTileY: ants spread evenly end to end (lone ant at the midpoint), re-spread on join/death, each holding its spot like DEFEND.";

export function countMarkJobText(config: SimConfig): string {
  const rules = config.countMarks!;
  const line = lineMarksEnabled(config);
  // The caste line restates FORAGE's workers-only rule only with caste selection.
  const forage = line && rules.casteSelection ? "FORAGE works food nearest the mark and delivers home." : "FORAGE recruits workers only, works food nearest the mark and delivers home; caste soldier is refused.";
  if (config.patrolLinkTiles !== undefined) return `DEFEND walks to its mark${rules.defendHolds ? ", holds and never chases" : ` and pursues enemies within ${rules.defendTiles} tiles`}. ATTACK marches there, then pursues the nearest enemy in the mark's ${config.attackRadiusTiles}-tile area. ${forage} GATHER holds its mark. PATROL: same-colony marks within ${config.patrolLinkTiles} tiles (Euclidean) ${line ? "link transitively; ants loop oldest to newest (laidTick, then id) and back. A lone patrol mark holds exactly like DEFEND." : "link transitively. Loop by laidTick then id: oldest to newest then back to oldest; two marks go back and forth. A lone patrol mark holds exactly like DEFEND."} Lay a bridging mark to join; expiry/seat lapse can split. Each recruits its own count; bite in reach, then continue.${line ? ` ${LINE_JOB_TEXT}` : ""}`;
  const defend = rules.defendHolds
    ? `DEFEND ants walk to the mark, hold there and bite only enemies within ${gridScaleForText(config)} tiles (incl. diagonals); they never chase`
    : `DEFEND ants walk to the mark and pursue enemies within ${rules.defendTiles} tiles of it`;
  return `${defend}. ${line ? `${LINE_JOB_TEXT} ` : ""}ATTACK ants march to the mark; once within ${config.attackRadiusTiles} tiles of it, they pursue the nearest enemy within ${config.attackRadiusTiles} tiles of the mark, standing and biting within ${gridScaleForText(config)} tiles (incl. diagonals). ${forage} GATHER ants walk to the mark and hold there.`;
}

export const WORD_MARK_ACTIONS = "Word marks guide only squads told to follow_trail: FOOD, HELP, ATTACK, GATHER and HOLD draw them toward the mark; AVOID sends them away; GO with a direction word sends them along that heading. Other words carry information. Word marks do not redirect free ants.";

/** Shared rule text; old config headers retain their original copy. */
export function countMarkCasteText(config: SimConfig, agent = false): string {
  return config.countMarks?.casteSelection
    ? `Optional caste: ${COUNT_CASTES.join(", ")}; omitted means any. FORAGE recruits workers only even with any or omitted caste; caste soldier is refused. Only the chosen caste recruits${agent && lineMarksEnabled(config) ? "" : ", nearest first"}. Changing caste on a re-lay releases only ants it excludes; other claims stay unless the count is lowered.`
    : "";
}

/** Rules 27 count_mark verbs SPAWN and REMOVE. */
export function spawnRemoveText(config: SimConfig): string {
  const hold = config.localAnts === undefined ? "" : ` (a soldier holds within ${config.localAnts.defendTiles} tiles of it)`;
  // The queen is one you own, and the owner-only statement reaches every surface carrying this text.
  return `SPAWN {queenId,tileX,tileY}: set/move the spawn point of a live queen you own (observe queens) on any passable tile, sight not needed; omit both coordinates to clear. ${queenSpawnOwnerText(config)} One per queen, no expiry; clears when she dies. While a seat is active, her later hatchlings, workers and soldiers, walk there, then follow the free-ant defaults from there${hold}; a move/clear changes only later hatchlings. Count marks may claim walkers; released, they don't resume. If she dies, her walkers take the defaults where they stand. REMOVE {markId}: remove your own count mark (myMarks); its ants take the defaults at once where they stand. No count needed; uses the command allowance.`;
}

/** Rules 27: founding leaves a queen's brood unset; she does not take another owned queen's brood. */
export const NEW_QUEEN_BROOD_TEXT = "A newly founded queen breeds mixed until her owner calls set_brood for her.";

/** Rules 27: set_brood, its choices and call limit; each agent owns its queen, no colony vote. */
export function queenBroodText(config: SimConfig, callsPerSecond: number): string {
  return `Each agent owns its queens and sets each one's brood with set_brood: workers, soldiers or mixed (alternates per queen; unset breeds mixed), queenId only if you own more than one; there is no colony vote.${config.queenFounding === undefined ? "" : ` ${NEW_QUEEN_BROOD_TEXT}`} set_brood counts toward the ${callsPerSecond}-calls-per-second limit, not the command allowance.`;
}

/** Rules 27: only a queen's owner sets, moves or clears her spawn point. */
export function queenSpawnOwnerText(_config: SimConfig): string {
  return "Only a queen's owner sets, moves or clears her spawn point.";
}

/** Rules 27: colony-sight mark reach is sight, from the colony's living ants when the mark is placed. */
export function markReachText(config: SimConfig): string {
  return config.countMarks?.placement === "colony_sight"
    ? "Mark reach is the same as sight, measured from your colony's living ants when the mark is placed, so a tile or queen seen earlier may no longer be in reach." : "";
}

function countMarkLines(config: SimConfig, s: (ticks: number) => number): string[] {
  const compact = usesCompactAgentText(config);
  const rules = config.countMarks;
  if (rules === undefined) return [];
  const reach = markReachText(config) === "" ? "" : ` ${markReachText(config)}`;
  const placement = config.patrolLinkTiles !== undefined && rules.placement === "colony_sight"
    ? `Whole land tile within ${config.sightTiles} tiles of any living ant of your colony; omit both coordinates for a current squad ant, never a future destination.${config.wordMarksDisabled ? "" : " Word marks still require your own squad ant on the tile."}${reach}`
    : rules.placement === "colony_sight"
    ? `Place a count mark on any whole-number tile currently within ${config.sightTiles} tiles of any living ant of your colony (not just your squad).${config.wordMarksDisabled ? " Omit both coordinates to use your squad's current location, if it has ants; an order destination is not automatically visible." : " Word marks still require one of your own squad ants standing on the tile. Omit both coordinates to use your squad's current location, if it has ants; an order destination is not automatically visible or a valid word-mark site."}${reach}`
    : "Place a count mark on a tile where one of your own squad ants stands; omit both coordinates to use the squad ant nearest your squad's mean position. An order's destination is not a valid mark site until a squad ant stands there.";
  const recruitment = rules.recruitColonyWide
    ? compact
      ? "Recruitment and replacements: nearest free ants anywhere in your colony first."
      : "The nearest free ants anywhere in your colony claim first; a group recruits replacements colony-wide, nearest first."
    : `An ant is eligible within ${config.smellTiles} tiles of the mark, or within ${rules.recruitTiles} tiles of a claimed group member (of the mark when the group is empty). A distant mark may answer with no ants.`;
  return [
    config.patrolLinkTiles !== undefined ? `- count_mark {verb,count,caste,tileX,tileY${lineMarksEnabled(config) ? ",toTileX,toTileY" : ""}}: ${countMarkVerbs(config).join("/")} for free non-squad ants; whole count 1-${COUNT_MARK_MAX_COUNT_TEXT}. marks/myMarks claimed=answered now, possibly short; never promised.` : compact ? `- count_mark {verb, count, ${rules.casteSelection ? "caste, " : ""}tileX, tileY${lineMarksEnabled(config) ? ", toTileX, toTileY" : ""}}: direct non-squad ants not already claimed${config.localAnts === undefined ? " or assigned as house guards" : ""}. verb is the job (${countMarkVerbs(config).join(", ")}); request count: a whole number of 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}. Answered means the ants actually claimed now: marks and myMarks report verb, count and claimed${rules.casteSelection ? ", plus caste" : ""}. claimed may be below count, not promised reinforcements.${config.wordMarksDisabled ? "" : " The steering field counts squad ants following word marks, not count-mark ants."}` : `- count_mark {verb, count, ${rules.casteSelection ? "caste, " : ""}tileX, tileY${lineMarksEnabled(config) ? ", toTileX, toTileY" : ""}}: direct ants outside squads that are not already claimed${config.localAnts === undefined ? " or assigned as house guards" : ""}. verb is the job (${countMarkVerbs(config).join(", ")}); count is how many ants you request, a whole number of 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}. Answered means the ants actually claimed now: observe's marks and myMarks report verb, count and claimed${rules.casteSelection ? ", plus caste" : ""}. claimed can be below count; it is not a promise of reinforcements.${config.wordMarksDisabled ? "" : " The steering field counts squad ants following word marks, not ants answering a count mark."}`,
    `  ${placement} Count marks do not steer your squad.`,
    `  ${compact && rules.recruitColonyWide ? "Recruit" : "Recruitment: the nearest eligible ants claim first,"} ${rules.casteSelection ? "with no caste preference when caste is any" : "with no caste preference"}${!lineMarksEnabled(config) ? ", except FORAGE recruits workers only" : ""}, including workers already foraging. ${recruitment} Marks recruit in laid order; competing marks can leave later requests short. Pulling workers off food can cost your economy.`,
    ...(rules.casteSelection ? [`  ${countMarkCasteText(config, true)}`] : []),
    `  Jobs: ${countMarkJobText(config)}`,
    ...(config.patrolLinkTiles === undefined ? [] : [`  Patrol example: count_mark {"verb":"PATROL","count":6,"tileX":20,"tileY":20}; ${lineMarksEnabled(config) ? `${s(config.commandFloorTicks)} s later repeat at (${20 + config.patrolLinkTiles},20) if in sight.` : `after ${s(config.commandFloorTicks)} s repeat at (${20 + config.patrolLinkTiles},20) if in colony sight.`}`]),
    compact ? `  ${lineMarksEnabled(config) ? `Same-verb/same-tile (LINE: same ends) re-lay changes count; claims stay, lowering releases farthest first; the mark keeps its original ${s(config.markLifetimeTicks)} s lifetime.` : `Same-verb/same-tile re-lay changes count; claims stay, lowering releases farthest first. This does not renew the mark's lifetime of ${s(config.markLifetimeTicks)} s from its original laying.`} Expiry frees ants; vacancies recruit eligible free ants again.${lineMarksEnabled(config) ? "" : ` ${config.wordMarksDisabled ? "Count marks" : "Count/word marks"} share the command allowance.`}` : `  Re-lay your same verb on the same tile${lineMarksEnabled(config) ? " (LINE: the same two ends)" : ""} to change the count: claimed ants stay; lowering it releases the farthest first. This does not renew the mark's lifetime of ${s(config.markLifetimeTicks)} s from its original laying. Expiry releases its ants; vacancies recruit eligible free ants again. ${config.wordMarksDisabled ? "Count marks" : "Count marks and word marks"} share the command allowance.`,
    ...(rules.reportClaimAvailability ? [`  With no free ants an accepted count_mark says exactly "0 free ants now; this mark recruits as ants hatch or free up" and keeps recruiting until expiry.`] : []),
    `  ${spawnRemoveText(config)}`,
  ];
}

/** Local ant rules (redesign only). */
function localAntLines(config: SimConfig): string[] {
  const rules = config.localAnts;
  if (rules === undefined) return [];
  // Rules 27: each free soldier holds where it became free.
  const soldiers = `free soldiers carry no food and, apart from local fights, hold within ${rules.defendTiles} tiles of where they became free: where they hatched, reached a spawn point or were released`;
  return [
    usesCompactAgentText(config) ? `- Free ants follow these defaults until a count mark claims them. Active (not idle) colony seat: house bot off; none: on. Non-carrying ants outside squads/count marks bite in reach; within ${rules.defendTiles} tiles of nearest live queen, pursue enemies within ${rules.defendTiles} tiles of her. Otherwise free workers forage nearest colony-seen food and deliver to live nests; ${soldiers}.` : `- Free ants follow these defaults until a count mark claims them. While any active (not idle) agent of your colony is seated, no house bot plans your colony. Non-carrying ants outside squads and count-mark groups bite adjacent enemies; one within ${rules.defendTiles} tiles of its nearest live queen goes for an enemy within ${rules.defendTiles} tiles of her. Otherwise free workers forage the nearest food your colony's ants have seen and carry it to a live nest; ${soldiers}. A colony with no active seat keeps the house bot.`,
    "- Strategy: workers gather and soldiers hold where they are, but you choose objectives. Count marks: food/defence/musters/attacks; squads scout/reveal. Found affordable queens; check claims/food; more commands alone do not win.",
  ];
}

/** Rules-25 own-colony exceptions to the soldier radius (guardSettle, restPass); empty on stored configs. */
function smallRadiusExceptions(soft: NonNullable<SimConfig["softSeparation"]>): string {
  const meets = [...(soft.guardSettle === true ? ["settled guard"] : []), ...(soft.restPass === true ? ["resting soldier"] : [])];
  if (meets.length === 0) return "";
  return `, but ${soft.radius} for ${soft.guardSettle === true ? "a guard settled at its queen and for " : ""}a worker meeting its own ${meets.join(" or ")}`;
}

/** Soft movement is shared copy, not a minimum-distance or reserved-slot promise. */
export function softSpacingLines(config: SimConfig): string[] {
  const soft = config.softSeparation;
  if (soft === undefined) return [];
  const exceptions = smallRadiusExceptions(soft);
  // Rules 27: a seated colony's workers keep the food they chose, so the crowding retarget is not taught.
  const arrival = config.pointArrival;
  if (arrival !== undefined) return [
    `Point arrival (${arrival.variant}): workers and soldiers share stable walkable resting places about ${arrival.pitch / (1000 * gridScaleForText(config))} original tile apart; seeded jitter <=${arrival.jitter} subunits, clearance >=${arrival.minimumSpacing} subunits. Stop only at own place; combat interrupts. Held marks fill reachable inner places, then nearest walkable places just outside; the area still decides combat targets.`,
    `Outside point arrival: radius ${soft.radius} subunits${soft.soldierRadius === undefined ? "" : `, soldier pairs ${soft.soldierRadius} subunits${exceptions}`}; strength ${soft.strength}, epsilon ${soft.epsilon}; steering+push <=${soft.maxStep} subunits/tick. Soft overlap; water/rocks impassable.`,
    `Other goals: native reach ${soft.arrivalSubunits} subunits; fresh same-goal/colony links <=${soft.arrivalLinkRadius} subunits rooted in reach.`,
    `Contact: ${exceptions === "" ? "" : "otherwise "}friends/enemies push alike; queens have no push/reserved/blocked tiles. Physical pickup: worker on food; delivery within ${config.nestDeliverTiles} tile${config.nestDeliverTiles === 1 ? "" : "s"} of live friendly queen. Bites: within ${gridScaleForText(config)} tiles incl. diagonals for both. No remote pickup/delivery/bite via links/rests. Terrain-safe hatch; no spacing deferral.`,
  ];
  return [
    `Personal space: each ant steers itself. Within ${soft.radius} subunits: push strength ${soft.strength}, edge epsilon ${soft.epsilon}; steering+push <=${soft.maxStep} subunits/tick. Soft: no minimum distance/hard blocks; ants squeeze past. Water/rocks impassable.`,
    ...(soft.soldierRadius === undefined ? [] : [`Outside point arrival, soldier personal space: pairs containing a soldier push within ${soft.soldierRadius} subunits (${soft.soldierRadius / (1000 * gridScaleForText(config))} original tile)${exceptions}; worker–worker radius stays ${soft.radius} subunits. This soft push has no hard minimum; fixed-point resting geometry is identical for both castes.`]),
    `Crowd arrival: native reach (points: ${soft.arrivalSubunits} subunits), or same-goal/colony links <=${soft.arrivalLinkRadius} subunits rooted at an ant in reach; recomputed each tick, not remembered. No reserved slots/posts/holding band. Displaced DEFEND/ATTACK soldiers return inside mark.`,
    `Contact: friends/enemies push alike, may overlap. Bites: within ${gridScaleForText(config)} tiles incl. diagonals; combat/queen-bite reach unchanged. Queens aren't bodies: no push/reserved/blocked tiles; ants there push. Pickup: worker on stocked food tile. Delivery: physically within ${config.nestDeliverTiles} tile${config.nestDeliverTiles === 1 ? "" : "s"} incl. diagonals of live friendly queen. Linked arrival: no remote pickup/delivery/bite. Native terrain-safe hatch; no crowd reservation/spacing deferral.`,
  ];
}

/** Only the new economy's seeded layouts contain the added frontline templates. */
export function frontlineFoodLines(config: SimConfig): string[] {
  if (config.foodLayout === undefined) return [];
  return ["Frontline food: four small mirrored patches between the nests, near the centre line. Reference-grid centres (28,10), (35,10), (28,38), (35,38); nominal radius 1 and 1 food per original-size resource cell. Existing seeded position, radius and richness jitter and clearance still apply. Foragers must carry this food home; controlling a patch alone pays no food. A pair that cannot fit is omitted on both sides."];
}

/** Rules 27: the idle worker rule of an agent-seated colony; count marks are the only override.
 * Replaces the rules-26 home guard, patch dispatch and patch patrol element in all three text generations. */
function localWorkerRulesText(config: SimConfig, compact: boolean): string {
  if (compact && usesCompactAgentText(config)) return "Free workers: no remembered food available -> walk outward from nearest live nest until colony sees food. Count marks override; released workers resume where released.";
  return "Idle free workers: when none of the food their colony remembers is available, they walk outward from their nearest live nest until the colony sees food. Ants claimed by count marks follow their marks instead; a released worker resumes these rules from where it was released.";
}

/** Rules 27: free soldiers fight locally, then hold where they became free; the concise form leaves the hold to localAntLines. */
function rules27FreeSoldierLine(config: SimConfig, local: NonNullable<SimConfig["localAnts"]>, concise: boolean): string {
  const ratio = config.pushRatioPermille / 1000;
  const combat = "Combat in reach";
  return concise
    ? `Free soldiers: enemy ants in sight -> push if local friends are at least ${ratio} of them, else fall back toward nearest live queen; then return to hold. ${combat}/nearby queen defence first.`
    : `Free soldiers: a free soldier with enemy ants in sight pushes on them if local friends are at least ${ratio} of them, and otherwise falls back toward its nearest live queen. With none in sight it holds within ${local.defendTiles} tiles of where it became free: where it hatched, reached a spawn point or was released. ${combat} and nearby queen defence take priority; count marks and squads take ants out of the free pool.`;
}

/** Shared configured balance copy; house prompts and Rules reuse it rather than copying numbers. */
export function balanceRuleLines(config: SimConfig, compact = false): string[] {
  const local = config.localAnts;
  const early = config.earlyWin;
  const concise = compact && usesCompactAgentText(config);
  return [
    ...softSpacingLines(config),
    ...(local?.soldierFrontSharePermille === undefined ? [] : [
      rules27FreeSoldierLine(config, local, concise),
      `Food patches (left-half centres, mirrored on the right; food ceilings per original-size resource cell): ${config.foodPatches.map((p) => `(${p.tileX},${p.tileY}), radius ${p.radius}, ${p.perTile} food`).join("; ")}. ${config.foodLayout === undefined ? "The centre patch is smaller and poorer than the flanking patches." : "Positions, radii and richness are drawn from the match seed, with equal mirrored food on both sides."}`,
    ]),
    ...(local?.workerIdlePatchPatrol ? [
      localWorkerRulesText(config, compact),
    ] : []),
    // Rules 27: no queen-threat recall of seated free workers.
    ...(config.groundIncomeExcessPermille === undefined ? [] : [
      `Ground income: ${tileAreaUnit(config)} up to half of all currently held territory pay full income; ${tileAreaUnit(config)} above that half pay ${config.groundIncomeExcessPermille / 10}% income. Neutral ${tileAreaUnit(config)} do not count toward the half; each colony's payout is rounded down.`,
    ]),
    ...(early === undefined ? [] : [
      `Early win: from ${early.minTick / config.ticksPerSecond} s, holding at least ${early.minHeldTiles} ${tileAreaUnit(config)} and at least ${early.territoryRatioPermille / 1000} times the opponent's territory continuously for ${early.holdTicks / config.ticksPerSecond} s wins immediately. Any interruption resets the clock. A zero-territory opponent counts as one ${tileAreaUnit(config, false)} for this comparison. Queen elimination is resolved first; otherwise time-up still applies.`,
    ]),
  ];
}

/** Queens with HP: the win line that replaces overrun. */
function queenHpLine(config: SimConfig, s: (ticks: number) => number, hp: (milli: number) => number): string {
  const q = config.queenHp!;
  const text = usesCompactAgentText(config)
    ? `- Queens with HP: ${hp(q.hp)} HP; bite one adjacent enemy for ${hp(q.biteDamage)} HP/${s(q.biteIntervalTicks)} s from ${s(config.combatGraceTicks)} s. Non-carrying ant with no enemy ant in reach: normal damage to adjacent enemy queen, no territory bonus; queens take no damage before ${s(q.shieldTicks)} s. With no enemy within ${q.regenClearTiles} tiles: regain ${hp(q.regenHp)} HP/${s(q.regenIntervalTicks)} s. 0 HP: lost; colony loses when all queens are dead ("queens killed"). There is no overrun. observe: own queens' hp and maxHp in milli-HP; divide by 1000 for HP.`
    : `- Queens with HP: each queen has ${hp(q.hp)} HP and bites one adjacent enemy for ${hp(q.biteDamage)} HP every ${s(q.biteIntervalTicks)} s (from ${s(config.combatGraceTicks)} s). A non-carrying ant with no enemy ant in reach bites an adjacent enemy queen at its normal damage, with no territory bonus; queens take no damage before ${s(q.shieldTicks)} s. With no enemy within ${q.regenClearTiles} tiles a queen regains ${hp(q.regenHp)} HP every ${s(q.regenIntervalTicks)} s. A queen at 0 HP is lost; a colony loses when all its queens are dead ("queens killed"). There is no overrun. observe shows your queens' hp and maxHp in milli-HP; divide by 1000 for HP.`;
  return `${text} Ant and queen bite reach is ${gridScaleForText(config)} tiles, including diagonals: one original-size tile's distance.`;
}

/**
 * The rules briefing join returns (territory included).
 * Every number comes from the match's config and every
 * word from the sim's vocabulary.
 */
function mapLayoutLines(config: SimConfig, compact = false): string[] {
  const terrain = config.terrain;
  return terrain === undefined || !hasDistinctMapLayouts(terrain) ? [] : terrain.maps.map(map =>
    `${map.name}: ${mapLayoutDescription(map, terrain.referenceWidth, terrain.referenceHeight, compact)}.`);
}

function terrainLines(config: SimConfig): string[] {
  return config.terrain === undefined ? [] : [
    ...mapLayoutLines(config, usesCompactAgentText(config)),
    (hasDistinctMapLayouts(config.terrain)
      ? "Seed selects map. view.terrain: name, public water rectangles/legend. Water blocks ants/marks; food stays dry. Ants route around water; target land. Ants/food/enemy nests obey sight."
      : `Maps: ${config.terrain.maps.map(m => m.name).join(", ")}; one chosen from the match seed. view.terrain names this map and lists public water rectangles with a decoding legend. Water is impassable to ants and marks; food is on land. Ants route around water; choose land targets. Dynamic ants, food and enemy nests still obey sight.`)
      + (config.terrain.rocks === undefined ? "" : ` The seed also places ${config.terrain.rocks.minPairs}-${config.terrain.rocks.maxPairs} mirrored rock pairs (${config.terrain.rocks.minClusterTiles}-${config.terrain.rocks.maxClusterTiles} original-size cells each; a cell covers ${gridScaleForText(config)}x${gridScaleForText(config)} fine tiles). view.terrain.rocks uses the same rectangle encoding. Rocks block ants, marks and queen founding; ants route around them. Rocks avoid starting nests, food and water, keeping land connected.`),
  ];
}

export function briefing(config: SimConfig, mcpConfig: McpConfig = DEFAULT_MCP_CONFIG, context: BriefingContext = { house: false }): string {
  // Keep historical/no-accounting copy byte-for-byte; current rules must also fit
  // alongside the complete private nest-pick window. Only explanatory prose changes.
  const compact = usesCompactAgentText(config);
  // Shorten only current carrier-rule prose; recorded briefing text stays intact.
  const concise = compact;
  const s = (ticks: number): number => seconds(config, ticks);
  // Before the draw, maps with different lengths state every length the seed can select.
  const statedTicks = statedMatchTicks(config, context);
  const durations = statedTicks === null ? undrawnMatchTicks(config).map(s) : [s(statedTicks)];
  const minutes = durations.map(duration => duration / 60).join(" or ");
  const durationText = durations.map(duration => `${duration} s (${duration / 60} minutes)`).join(" or ") + (statedTicks === null ? ", set by the seed's map" : "");
  // HP figures as the sim applies them: milli-HP, damage dealt per tick (combat.ts).
  const hp = (milli: number): number => Number((milli / 1000).toFixed(3));
  const base = damagePerTick(config);
  const bonus = Math.trunc((base * config.defenderBonusPermille) / 1000);
  const board = statedBoardSize(config, context);
  return [
    houseIdleText(mcpConfig),
    ...(compact && context.local !== true ? [IDENTITY_GUIDANCE, KEY_HANDLING_GUIDANCE, context.house ? HOUSE_MODE_GUIDANCE : LOBBY_GUIDANCE] : []),
    ...terrainLines(config),
    compact ? `Antwars: ${COLONY_NAMES[0]} vs ${COLONY_NAMES[1]}; ${board === null ? `board ${boardSizeChoices(config)}, set by the seed's map; x 0 to width-1 left-right, y 0 to height-1 top-bottom (observe cells.width/height)` : `${board.width}x${board.height}, x 0-${board.width - 1} left-right, y 0-${board.height - 1} top-bottom`}. ${durationText}; ${config.ticksPerSecond} ticks/s.${antCapText(config, context)} ${config.localAnts === undefined ? "House bot: non-squad ants" : "Active colony seat: free ants act autonomously"}. Squad up to ${config.squadSize} ants; fewer/none if unavailable, refills as ants free up.` : `Antwars: two supercolonies, the ${COLONY_NAMES[0]} and the ${COLONY_NAMES[1]}, fight on a ${board === null ? `tile map whose size is set by the map the seed selects: ${boardSizeChoices(config)} (x 0 to width - 1 left to right, y 0 to height - 1 top to bottom; observe cells give width and height)` : `${board.width}x${board.height} tile map (x 0-${board.width - 1} left to right, y 0-${board.height - 1} top to bottom)`}. A match lasts ${durationText} at ${config.ticksPerSecond} ticks per second. ${config.localAnts === undefined ? "A house bot runs every ant outside agents' squads" : "Free ants act autonomously while your colony has an active seat"}; you command a squad of up to ${config.squadSize} ants (fewer, or none, when your colony has no spare ants; squads fill as ants become free).`,
    compact ? `Non-lobby join: ${agentLimitText(mcpConfig)}` : agentLimitText(mcpConfig),
    compact ? `Calls: ${mcpConfig.callsPerSecond}/agent/sliding 1s; join/reconnect/rules/observe/commands all count. call_rate: wait retryAfterMs; no idle reset.` : callLimitText(mcpConfig),
    observeDetailText(config, mcpConfig, context, false),
    CELL_PAGING_TEXT,
    compact ? `MCP session closes after ${mcpConfig.sessionIdleMs / 60_000} minutes without requests; rejoin as described below.` : sessionExpiryText(mcpConfig), FOOD_RADIX_TEXT, SEAT_NOTICE_TEXT,
    ...localAntLines(config),
    ...frontlineFoodLines(config).map((line) => `- ${line}`),
    ...balanceRuleLines(config, true).map((line) => `- ${line}`),
    "",
    config.countMarks === undefined
      ? (config.wordMarksDisabled ? "The loop: call observe, then order. Repeat." : "The loop: call observe, then order (optionally carrying one mark). Repeat.")
      : compact ? "Loop: observe; count_mark directs free ants, order steers your squad. Command only when useful; observe the result." : "The loop: observe, choose an objective, then count_mark to direct free ants or order to steer your squad. Observe again to check how many ants answered and what changed; do not command just to fill the timer.",
    `- ${colonyVisibilityText(config)} Colony marks within ${config.smellTiles} tiles of any living colony ant. Other fields current. Events: colony sight at occurrence.`,
    compact ? `  observe waitSeconds (max ${MAX_OBSERVE_WAIT_SECONDS}): wait, then get current view.` : `  observe with waitSeconds (up to ${MAX_OBSERVE_WAIT_SECONDS}) holds the reply that long, then returns the view as it stands then: use it to wait instead of calling observe repeatedly.`,
    concise ? `  No since: eventsMode:current samples newest unseen last-cycle events; own queen_founded/queen_lost, mark_laid/count_mark_accepted first. priorityEventsMore:true: priorities queued, even old. Sampling keeps eventCursor. History: since:0, then since:view.eventCursor while view.eventsMore (eventsMode:history); may repeat samples. Commands/errors/rules retain events; history/priorities survive reconnects/match end for this match. Count-mark message/availability: commands/history only.` : compact ? `  No since: eventsMode:current samples newest unseen from last command cycle; own queen_founded/queen_lost, mark_laid/count_mark_accepted first. priorityEventsMore:true: old priorities queued. Sampling never advances eventCursor. History: since:0, then since:view.eventCursor while view.eventsMore (eventsMode:history); may repeat samples. Commands/errors/rules retain events; history/priorities survive reconnects/match end for this match. Count-mark message/availability: commands/history only.` : `  Cells use a lossless dense table with its own encoding legend, all numbers in base36. Without since, eventsMode:current samples the newest unseen events from the last command cycle, putting pending own-colony queen_founded/queen_lost and your own ${config.countMarks === undefined ? "mark_laid" : "mark_laid/count_mark_accepted"} events first. Priorities that exceed a reply stay queued (priorityEventsMore:true) for later default observes, even when old. Current count-mark acceptance notices omit message and availability; complete details remain in command replies and explicit history. Sampling never advances eventCursor. For every event in chronological order use observe since:0, then since:view.eventCursor while view.eventsMore is true (eventsMode:history); replay may repeat sampled events. History, including events collected by commands, errors or rules reads, and pending priorities survive reconnects for this match. Cells use their separate snapshot cursor; other view fields remain current.`,

    COMPACT_VIEW_TEXT.replace("Decode via observe tool.", "See observe."),
    compact ? `- order: your squad follows it until changed; new squads forage. Speed: ${config.antSpeedTilesPerSecond} tiles/s. Kinds:` : `- order: a standing order your squad follows until you change it. A new squad starts on forage. Ants move ${config.antSpeedTilesPerSecond} tiles per second. What each kind makes your squad's ants do:`,
    compact ? "  - go_to (tileX, tileY): every squad ant walks straight to that tile and stays." : "  - go_to (tileX, tileY): every squad ant walks straight to that tile and stays there.",
    compact ? `  - attack (tileX,tileY): march to target. ${reachDefinedOnce(config) ? "Enemy in reach: stand" : `Within ${gridScaleForText(config)} tiles of an enemy (diagonals included), stand`} and fight; otherwise pass visible enemies. Once within ${config.attackRadiusTiles} tiles of target, pursue its nearest enemy within ${config.attackRadiusTiles} tiles, or stay at target if none.` : `  - attack (tileX, tileY): the squad marches to the target tile. A squad ant with an enemy within ${gridScaleForText(config)} tiles (diagonals included) stands and fights; otherwise it keeps heading for the target and passes enemies it can only see. Within ${config.attackRadiusTiles} tiles of the target it goes after the nearest enemy within ${config.attackRadiusTiles} tiles of the target; with none there it stays at the target.`,
    compact ? (config.queenFounding === undefined ? "  - forage: nearest food, carry 1 to your queen; no food -> home." : "  - forage: nearest food, carry 1 to nearest live queen; no food -> that nest.") : config.queenFounding === undefined ? "  - forage: each squad ant heads for the nearest tile with food, picks up 1 food and carries it to its queen; with no food on the map it heads home." : "  - forage: each squad ant heads for the nearest tile with food, picks up 1 food and carries it to its nearest live queen; with no food on the map it heads to that nest.",
    "  - hold: squad ants stand still.",
    ...(config.wordMarksDisabled ? [`  order may carry spectators-only intent (max ${config.intentMaxChars} chars).`] : [
    compact ? `  - follow_trail: strongest colony steering mark within ${config.smellTiles} tiles of any squad ant; toward it, away for AVOID, along GO+direction; none -> forage.` : `  - follow_trail: the squad follows your colony's strongest steering mark within ${config.smellTiles} tiles of any squad ant (toward it, away from it for AVOID, or in the direction of GO with a direction); with no such mark it forages.`,
    compact ? `  order may carry one mark (optional tileX,tileY as for mark), plus spectators-only intent (max ${config.intentMaxChars} chars). Refused mark refuses order.` : `  An order may carry one mark (tileX and tileY optional, as for mark) and an intent line (at most ${config.intentMaxChars} characters) that only spectators see. If an order's mark is refused, the order is not applied either.`,
    compact ? `- mark: own squad ant's tile; omit tileX,tileY: ant nearest squad mean, lowest id on ties, at processing. words is a JSON array of 1 to ${config.markMaxWords} word strings, for example ["ENEMY","QUEEN"], each from ${WORDS.join(" ")}. Lasts ${s(config.markLifetimeTicks)} s; only your colony smells it.${config.controlRevision === undefined && config.countMarks?.defendHolds !== true && config.marksPerAgent !== undefined ? ` Keep at most ${config.marksPerAgent}; new replaces oldest.` : ` Marks share the one-command-per-${s(config.commandFloorTicks)}-s allowance.`} Marks are the only way agents talk.` : `- mark: lay a scent mark on a tile where one of your squad's ants stands, or leave out tileX and tileY and it lands on the tile of the squad ant nearest your squad's mean position (ties to the lowest ant id) when the call is processed: ${`words is a JSON array of 1 to ${config.markMaxWords} word strings, for example ["ENEMY","QUEEN"], each from ${WORDS.join(" ")}`}. It lasts ${s(config.markLifetimeTicks)} s${config.controlRevision === undefined && config.countMarks?.defendHolds !== true && config.marksPerAgent !== undefined ? `, you keep at most ${config.marksPerAgent} (a new one replaces your oldest), and only your colony smells it.` : ` and only your colony smells it. Marks share the one-command-per-${s(config.commandFloorTicks)}-s allowance.`} Marks are the only way agents talk.`,
    compact ? `  First steering word: FOOD/HELP/ATTACK/GATHER/HOLD toward; AVOID away; GO+direction along heading; others inform. follow_trail takes strongest at any squad ant. New/at-mark strongest; weakens with age, fading to zero at ${config.markReachTiles} tiles. Word marks never steer free ants; count_mark does.` : `  A mark's first steering word decides where it sends a squad on follow_trail: FOOD, HELP, ATTACK, GATHER and HOLD send it toward the mark; AVOID sends it away; GO with a direction word sends it along that fixed heading; the other words are information. A mark is strongest when new and at its tile, fading to nothing at ${config.markReachTiles} tiles and over its life; the squad follows the mark that is strongest at any of its ants. ${config.countMarks === undefined ? "Marks move no other ants: your colony's non-squad ants go about their house-bot work whatever marks lie near them." : "Ordinary word marks do not steer free ants; count_mark directs them instead."}`,
    ]),
    ...countMarkLines(config, s),
    ...(config.countMarks ? [`  ${countMarkReplyText(config)}`] : []),
    ...(config.queenFounding === undefined ? [] : [
      compact ? `- found_queen {tileX,tileY}: held tile (bit 1 in observe map:true territory). First extra queen: ${config.queenFounding.cost} stored food${(config.queenFounding.costMultiplier ?? 1) === 1 ? "" : `; price x${config.queenFounding.costMultiplier} per ${config.queenFounding.costBasis === "live" ? "additional live queen" : config.queenFounding.costBasis === "founded-live" ? "additional living founded queen; starting queens do not count" : "queen ever founded, including replacements"}`}. Colony cooldown: ${s(config.queenFounding.cooldownTicks)} s; opens tick ${config.queenFounding.firstFoundTick ?? 0} (${s(config.queenFounding.firstFoundTick ?? 0)} s). ${config.queenFounding.maxLiveQueens === undefined ? "" : `Max ${config.queenFounding.maxLiveQueens} live queens incl. first. `}Minimum Euclidean distance: ${config.queenFounding.minDistanceTiles} tiles from every ${config.queenFounding.standingNestsOnly ? `standing nest, either colony (${config.queenHp === undefined ? "overrun" : "dead"} queens excluded)` : "nest, either colony, including lost nests"}. Shares the ${config.wordMarksDisabled ? (config.countMarks === undefined ? "order" : "order/count_mark") : (config.countMarks === undefined ? "order/mark" : "order/mark/count_mark")} command limit. observe: own queens, next cost, stored food, nextFoundTick; enemyQueens: in-sight only (tile, hp).` : `- found_queen {tileX,tileY}: found a new nest on a tile your colony holds (# in observe map:true). The first extra queen costs ${config.queenFounding.cost} stored food${(config.queenFounding.costMultiplier ?? 1) === 1 ? "" : `; the price multiplies by ${config.queenFounding.costMultiplier} with each ${config.queenFounding.costBasis === "live" ? "additional live queen" : config.queenFounding.costBasis === "founded-live" ? "additional living founded queen; starting queens do not count" : "queen ever founded, including replacements"}`}. Colony-wide cooldown: ${s(config.queenFounding.cooldownTicks)} s. Opening: tick ${config.queenFounding.firstFoundTick ?? 0} (${s(config.queenFounding.firstFoundTick ?? 0)} s). ${config.queenFounding.maxLiveQueens === undefined ? "" : `At most ${config.queenFounding.maxLiveQueens} live queens, counting the first. `}Minimum Euclidean distance: ${config.queenFounding.minDistanceTiles} tiles from every ${config.queenFounding.standingNestsOnly ? `standing nest of either colony (${config.queenHp === undefined ? "overrun" : "dead"} queens no longer block spacing)` : "nest of either colony, including lost nests"}. Shares the ${config.wordMarksDisabled ? (config.countMarks === undefined ? "order" : "order/count_mark") : (config.countMarks === undefined ? "order/mark" : "order/mark/count_mark")} command limit. observe lists your queens, current next cost, stored food and nextFoundTick; enemy queens stay fogged outside sight.`,
      concise ? "  Every live queen hatches on its own interval; shares colony food/ant cap. Ants deliver/guard live nests. Reply adds new queen; refusal spends nothing. Own founded/lost events: colony-wide." : compact ? "  Every live queen hatches on its own interval, sharing colony food/ant cap; ants deliver to/guard live nests. Founding replies: tick, accepted/refusal, nextCommandTick, new queen; refusal spends nothing. Own founded/lost events are colony-wide." : "  Every live queen hatches on its own interval, using the shared colony food store and ant cap; ants deliver to and guard live nests. Founding replies give the tick, acceptance or refusal, nextCommandTick and the new queen; a refusal spends nothing. Your colony receives its own founded/lost events colony-wide.",
      ...(config.localAnts === undefined ? [`  House guards: ${config.queenFounding.guardsPerQueen ? "each live queen targets the full colony-size guard allotment" : "one colony-size guard allotment is shared among live queens"}; assignments are limited to existing non-squad ants${config.queenFounding.totalGuardSharePermille === undefined ? "" : ` and at most ${config.queenFounding.totalGuardSharePermille / 10}% of all live colony ants in total`}, shared evenly across live queens. Squad ants are never reassigned.${config.queenFounding.totalGuardSharePermille === undefined ? "" : ` At least ${100 - config.queenFounding.totalGuardSharePermille / 10}% remain outside house guard assignments.`}`] : []),
      concise ? `  House bots: after opening, ready cooldown, valid held tile, price+${config.queenFounding.houseReserveFood ?? 2 * Math.max(config.hatchCost, config.castes?.soldierCost ?? config.hatchCost)} food (reserve: house-only, not required of seated agents).` : compact ? `  House bots reserve ${config.queenFounding.houseReserveFood ?? 2 * Math.max(config.hatchCost, config.castes?.soldierCost ?? config.hatchCost)} food; found after opening with price+reserve, ready cooldown, valid held tile. Reserve: house strategy, not a seated-agent requirement.` : `  Turn surplus into growth after founding opens: house bots keep ${config.queenFounding.houseReserveFood ?? 2 * Math.max(config.hatchCost, config.castes?.soldierCost ?? config.hatchCost)} food in reserve, and found when food covers the current price plus that reserve, the cooldown is ready, and a held tile meets the distance rule. The reserve is house strategy, not an extra seated-agent command requirement.`,

    ]),
    `- ${commandLimitText(config)}`,
    compact ? `- ${config.wordMarksDisabled ? (config.countMarks === undefined ? "order" : "order/count_mark") : (config.countMarks === undefined ? "order/mark" : "order/mark/count_mark")}: tick, accepted/refusal+fix, nextCommandTick (first accepted next-command tick), command changes only; observe keeps view/events.` : `- ${config.wordMarksDisabled ? (config.countMarks === undefined ? "order" : "order and count_mark") : (config.countMarks === undefined ? "order and mark" : "order, mark and count_mark")} reply with the tick, accepted or the refusal and how to fix it, nextCommandTick (the first tick your next command is accepted) and only this command's changes; they do not return the view or a general events list; observe retains those events.`,
    compact ? "- Note your plan and observations." : "- Keep a few lines of notes on your plan and what you have seen.",
    "- Play the whole match: keep observing and giving orders until it ends.",
    "",
    compact && context.local !== true ? REJOIN_GUIDANCE : "Rejoin from any session with join {reconnectToken}; token is an alias.",
    "Rules for humans and agents: /rules on this server (same origin as your MCP address).",
    "How to win:",
    config.queenHp !== undefined ? queenHpLine(config, s, hp) : config.queenFounding === undefined ? `- Queen overrun: an enemy majority within ${config.overrunRadiusTiles} tiles of a queen for ${s(config.overrunTicks)} s wins at once. Overrun progress starts ${s(config.overrunGraceTicks)} s after match start for every queen.` : `- Queen overrun: an enemy majority within ${config.overrunRadiusTiles} tiles of a queen for ${s(config.overrunTicks)} s permanently loses that queen. A lost queen cannot hatch, receive food or be refounded. Your colony loses only when every queen has been overrun. Overrun progress cannot start before ${s(config.overrunGraceTicks)} s after match start; founded queens have no extra grace.`,
    ...(config.groundFoodIntervalTicks === undefined || config.groundFoodIntervalTicks <= 0 ? [] : [
      config.groundIncomeExcessPermille === undefined
        ? `- Held ground: every ${s(config.groundFoodIntervalTicks)} s, each ${tileAreaUnit(config, false)} your colony holds earns 1 food in its store, in addition to food its foragers deliver. The first payout is ${s(config.groundFoodIntervalTicks)} s after match start; losing a tile before a payout loses that tile's income.`
        : `- Held ground: every ${s(config.groundFoodIntervalTicks)} s, held ${tileAreaUnit(config)} pay food according to the marginal income taper described above, in addition to foraging. The first payout is ${s(config.groundFoodIntervalTicks)} s after match start; losing a tile before a payout loses that tile's income.`,
    ]),
    compact ? `- Territory: ant claims its aligned ${gridScaleForText(config)}x${gridScaleForText(config)} tile cell, excluding water and rocks; neutral ${s(config.territoryDecayTicks)} s after last colony visit. Ownership cannot change while an ant there has an enemy in combat reach. ${config.adjudication === "kills-first" ? `Time-up or both last queens lost same tick: kills>territory>ants alive>food delivered>draw.` : `Time-up (${minutes} minutes): the larger territory wins; ties: ants alive, then food delivered.`}` : `- Territory: an ant claims its aligned ${gridScaleForText(config)}x${gridScaleForText(config)} tile cell, excluding water and rocks; each claimed fine tile belongs to its colony and returns to neutral ${s(config.territoryDecayTicks)} s after that colony's last visit, but it never changes owner, to another colony or to neutral, while an ant on it has an enemy within combat reach. ${config.adjudication === "kills-first" ? `Time-up or both last queens lost same tick: kills>territory>ants alive>food delivered>draw.` : `At time-up (${minutes} minutes) the larger territory wins; ties go to more ants alive, then more food delivered.`}`,

    compact ? `- Combat: non-carrying ants, any order, ${reachDefinedOnce(config) ? "with an enemy in reach" : `within ${gridScaleForText(config)} tiles of an enemy (diagonals too)`}, hit the lowest-HP enemy each tick. Ant: ${hp(config.antHp)} HP; ${hp(base * config.ticksPerSecond)} HP/s, ${hp(bonus * config.ticksPerSecond)} HP/s on own territory. Hits simultaneous; 0 HP -> dies, leaves ${config.corpseFood} food. No combat before ${s(config.combatGraceTicks)} s.` : `- Combat: whatever its order, every non-carrying ant within ${gridScaleForText(config)} tiles of an enemy (diagonals included) hits one of them, the one with the fewest HP, every tick. An ant has ${hp(config.antHp)} HP and deals ${hp(base * config.ticksPerSecond)} HP per second, or ${hp(bonus * config.ticksPerSecond)} HP per second while it stands on its own colony's territory. All hits land together; an ant at 0 HP dies and leaves ${config.corpseFood} food. No combat in the first ${s(config.combatGraceTicks)} s.`,
    `- Ants carrying food do not bite enemy ants or queens. Free, squad and count-mark carriers keep delivering to a live friendly queen past enemies, regardless of orders or marks; they never stop for combat.${lineMarksEnabled(config) ? "" : " Carriers do not count toward overrunning an enemy queen."}`,
    "- Food carried to the nest hatches new ants.",
    ...casteLines(config, hp, mcpConfig.callsPerSecond),
    "",
    "Worked example:",
    ...(config.countMarks === undefined ? (config.wordMarksDisabled ? [
      "1. observe -> choose a visible objective.",
      `2. order {"kind":"go_to","tileX":14,"tileY":22,"intent":"claim the north food"} -> your squad walks there.`,
      `3. After ${s(config.commandFloorTicks)} s, order {"kind":"forage"} to gather food.`,
    ] : [
      "1. observe -> your squad's ants stand around (12,24) and a cell at (14,22) shows food 3.",
      `2. order {"kind":"go_to","tileX":14,"tileY":22,"mark":{"words":["FOOD","N","MANY"]},"intent":"claim the north food"} -> the mark lands under the squad ant nearest your squad's mean position; your ants walk there; a teammate's squad on follow_trail heads for the mark while it is your colony's strongest mark near that squad.`,
      `3. observe again; after ${s(config.commandFloorTicks)} s, order {"kind":"forage"} to work the patch.`,
    ]) : [
      compact ? "1. observe food, marks and colony needs." : "1. observe -> your squad is near useful food; check your existing marks and the colony's needs before requesting ants.",
      concise ? `2. count_mark {"verb":"FORAGE","count":${config.squadSize}} -> eligible free ants answer, not your squad.` : compact ? `2. count_mark {"verb":"FORAGE","count":${config.squadSize}} -> no coordinates: current squad ant, never future destination. Eligible free ants answer, not your squad.` : `2. count_mark {"verb":"FORAGE","count":${config.squadSize}} -> omitted coordinates put the mark under a current squad ant, not at a future order destination; eligible free ants, not your squad, start answering it.`,
      concise ? `3. observe myMarks: claimed (answered now) vs count (requested). After ${s(config.commandFloorTicks)} s adjust count/order.` : compact ? `3. observe myMarks: claimed (answered now) vs count (requested); short: no eligible free ants or prior teammate claims. After ${s(config.commandFloorTicks)} s adjust count/order; same-verb/same-tile re-lays keep expiry.` : `3. observe -> find the mark in myMarks; compare claimed (answered now) with count (requested). A shortage may mean no eligible free ants or an earlier teammate's claim. After ${s(config.commandFloorTicks)} s you may adjust the count or order your squad elsewhere; re-laying the same verb at the same tile does not reset expiry.`,
      config.wordMarksDisabled
        ? concise ? `4. After the command interval, order {"kind":"hold","intent":"guard this position"} -> hold${lineMarksEnabled(config) ? "" : "; spectators-only intent"}.` : `4. After the command interval, order {"kind":"hold","intent":"guard this position"} -> your squad holds; only spectators see the intent.`
        : `4. After the command interval, order {"kind":"hold","mark":{"words":["ENEMY","QUEEN"]}} -> words is a JSON array; omitted tileX and tileY put the word mark under a current squad ant.`,
    ]),
  ].join("\n");
}


/** The default briefing is short; the full, configured rules remain one tool call away. */
export function joinBriefing(config: SimConfig, mcpConfig: McpConfig = DEFAULT_MCP_CONFIG, nestWindow = false, context: BriefingContext = { house: false }): string {
  const compact = usesCompactAgentText(config);
  const board = statedBoardSize(config, context);
  return [
    houseIdleText(mcpConfig),
    ...(nestWindow ? ["Nest window: join/observe nestSelection.terrain maps your box; also check teammates' picks."] : []),
    ...(compact && context.local !== true ? [IDENTITY_GUIDANCE, KEY_HANDLING_GUIDANCE, context.house ? HOUSE_MODE_GUIDANCE : LOBBY_GUIDANCE] : []),
    `Antwars: ${config.rules ?? "default"}; ${board === null ? `${boardSizeChoices(config)} tiles, set by the seed's map; x 0 to width-1, y 0 to height-1 (observe cells.width/height)` : `${board.width}x${board.height} tiles, x 0-${board.width - 1}, y 0-${board.height - 1}`}; ${config.ticksPerSecond} ticks/s, match ${joinLengthText(config, context)}.${antCapText(config, context)} You command up to ${config.squadSize} ants.`,
    ...(config.terrain === undefined ? [] : [
      config.terrain.rocks === undefined
        ? `Seed picks ${config.terrain.maps.map(map => map.name).join("/")}. view.terrain: map name, public water rectangles/legend. Water blocks ants/marks; food stays dry. Ants route around water; target land. Ants/food/enemy nests obey sight.`
        : "No ants, marks or queens on water or rocks.\nAnts/food/enemy nests obey sight. See view.terrain.",
      ...mapLayoutLines(config, true),
    ]),
    compact ? (`Non-lobby join. Agent limits: ${mcpConfig.maxAgentsPerMatch}/match, ${mcpConfig.maxAgentsPerMatch / 2}/colony. Named colony: if full, the join is refused, never moved. Omit colony to balance (0 on ties).`) : (`Agent limits: ${mcpConfig.maxAgentsPerMatch}/match, ${mcpConfig.maxAgentsPerMatch / 2}/colony. Named colony: if full, the join is refused, never moved. Omit colony to balance (0 on ties).`),
    `Calls/agent/sliding 1s: ${mcpConfig.callsPerSecond}; join/reconnect/rules/observe/commands count. call_rate: retry after retryAfterMs; no idle reset.`,
    observeDetailText(config, mcpConfig, context, false),
    CELL_PAGING_TEXT,
    compact ? `MCP session closes after ${mcpConfig.sessionIdleMs / 60_000} minutes without requests; rejoin as described below.` : sessionExpiryText(mcpConfig), colonyVisibilityText(config), FOOD_RADIX_TEXT, SEAT_NOTICE_BRIEF,
    compact && context.local !== true ? (`${REJOIN_GUIDANCE} If your nest window is open, call pick_nest first, then read rules. A legal repick replaces yours. /rules here for humans/agents.`) : ("Any session: join {reconnectToken}; token is an alias. If your nest window is open, call pick_nest first, then read rules. A legal repick replaces yours. /rules here for humans/agents."),
    compact ? `How to win: ${config.queenHp ? "kill every enemy queen" : "Queen overrun: hold an enemy majority at every enemy nest"}; ${config.adjudication === "kills-first" ? `time-up or both last queens lost on the same tick (${config.queenHp ? "queens killed" : "double overrun/queens killed"}): kills, territory, ants alive, delivered food, else draw. Kills = enemy ant deaths, including queen bites.` : "time-up: the larger territory wins; ties: more ants alive, then more food delivered."}` : `How to win: ${config.queenHp ? "kill every enemy queen" : "Queen overrun: hold an enemy majority at every enemy nest"}; ${config.adjudication === "kills-first" ? `time-up or both last queens lost on the same tick (${config.queenHp ? "queens killed" : "double overrun/queens killed"}): kills, territory, ants alive, delivered food, else draw. Kills = enemy ant deaths, including queen bites.` : "time-up: territory, ants alive, delivered food."}`,
    commandLimitText(config),
    "Carriers never bite ants or queens; free, squad and count-mark carriers deliver home past enemies instead of stopping for combat.",
    ...frontlineFoodLines(config),
    ...(config.softSeparation === undefined ? [] : [`Soft space: push${config.softSeparation.radius}${config.softSeparation.soldierRadius === undefined ? "" : `/soldier${config.softSeparation.soldierRadius}`}/step${config.softSeparation.maxStep}/link${config.softSeparation.arrivalLinkRadius} subunits. Fresh links, contact/queens: rules.${config.pointArrival === undefined ? "" : ` Point arrival ${config.pointArrival.variant}, pitch ${config.pointArrival.pitch} subunits: own resting place, both castes; fill the area then nearest walkable overflow, combat area unchanged. Details: rules.`}`]),
    compact ? ("observe events: newest unseen, last command cycle; priorities first, overflow: priorityEventsMore. History: since:0 then since:view.eventCursor while eventsMore; may repeat samples. Sampling keeps eventCursor. since:notice.detailsSince: full count-mark details. History/priorities survive reconnects/match end for this match.") : ("observe events: newest unseen, last command cycle; priorities first, overflow: priorityEventsMore. History: since:0 then since:view.eventCursor while eventsMore; may repeat samples. Sampling keeps eventCursor. since:notice.detailsSince: full count-mark details. History/priorities survive reconnects/match end."),
    `observe waitSeconds (max ${MAX_OBSERVE_WAIT_SECONDS}): wait, then get the current view.`,
    TERRITORY_TEXT,
    MARK_TABLE_TEXT,
    compact ? (`order: go_to/attack need tileX,tileY; go_to: every squad ant walks straight to that tile and stays; ${config.wordMarksDisabled ? "forage/hold" : "forage/hold/follow_trail"}. intent: at most ${config.intentMaxChars} characters, spectators only.`) : (`order: go_to/attack need tileX,tileY; ${config.wordMarksDisabled ? "forage/hold" : "forage/hold/follow_trail"}. intent: at most ${config.intentMaxChars} characters, spectators only.`),
    ...(config.wordMarksDisabled ? [] : [
    `mark: words is a JSON array of 1 to ${config.markMaxWords} word strings, e.g. ["ENEMY","QUEEN"] (vocabulary in rules). Tile: own squad ant; omit both axes for the ant nearest squad mean (lowest id breaks ties). ${WORD_MARK_ACTIONS} Refused order mark refuses the order too.`,
    ]),
    ...(config.countMarks ? [`count_mark: ${countMarkVerbs(config).join("/")}, count a whole number of 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}. ${countMarkJobText(config)}${config.countMarks.casteSelection ? ` ${countMarkCasteText(config)}` : ""} ${config.countMarks.placement === "colony_sight" ? `target within ${config.sightTiles} tiles of any living ant of your colony (not just your squad)` : "target under an own squad ant"}, or omit coordinates. claimed: answered now, not promised; outside your squad. Pulling foragers costs food.${compact ? " Vacancies recruit eligible free ants again." : ""}${` ${spawnRemoveText(config)}`}`] : []),
    ...(config.queenFounding ? [compact ? `found_queen: held tile; observe queenFounding for cost and nextFoundTick. Shares the ${config.wordMarksDisabled ? (config.countMarks === undefined ? "order" : "order/count_mark") : (config.countMarks === undefined ? "order/mark" : "order/mark/count_mark")} command limit.` : "found_queen: held tile; observe queenFounding for cost and nextFoundTick."] : []),
    // Rules 27: each agent owns its queens and sets their brood with set_brood.
    ...(config.castes !== undefined ? [queenBroodText(config, mcpConfig.callsPerSecond)] : []),
    "Commands: outcome, nextCommandTick, changes only. Keep a few lines of notes.",
    "- Play the whole match: keep observing and giving orders until it ends.",
  ].join("\n");
}
