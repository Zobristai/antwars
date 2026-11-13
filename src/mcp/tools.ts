import { setTimeout as sleep } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { COLONY_NAMES, COUNT_MARK_MAX_COUNT_TEXT, type SimConfig } from "../sim/config.js";
import type { ColonyNamePair } from "../sim/colonyNames.js";
import { countMarkVerbs, lineMarksEnabled } from "../sim/patrol.js";
import { BROODS, COUNT_CASTES, COUNT_VERBS, WORDS, type Brood, type ColonyId, type MatchResult, type Order, type SimInput } from "../sim/types.js";
import type { AgentView } from "../sim/view.js";
import { EMPTY_SQUAD_COUNT_MARK, FOUNDING_CHECKS, LINE_FROM_END_NOT_VISIBLE, LINE_TO_END_NOT_VISIBLE, type FoundingCheck } from "../sim/agents.js";
import { briefing, countMarkJobText, WORD_MARK_ACTIONS, countMarkReplyText, FOOD_RADIX_TEXT, CELL_PAGING_TEXT, IDLE_COUNTDOWN_TEXT, joinBriefing, observeDetailText, POST_MATCH_OBSERVE_TEXT, SEAT_NOTICE_TEXT, colonyVisibilityText, usesCompactAgentText, ENEMY_QUEENS_TEXT, MY_MARKS_TEXT, spawnRemoveText, queenBroodText, queenSpawnOwnerText, NEW_QUEEN_BROOD_TEXT, markReachText } from "./briefing.js";
import { OBSERVE_REPLY_LIMITS, fitsReply, payload, pagedView, publicCountCaste, publicQueen, servedText, storedCall, type ServedText } from "./replies.js";
import { TERRITORY_TEXT } from "./territory.js";
import { MARK_TABLE_TEXT } from "./markTable.js";
import { agentLimitText, agentsPerColony, MAX_OBSERVE_WAIT_SECONDS, sessionExpiryText, type McpConfig } from "./config.js";
import { nestFields, registerNestTool } from "./nestTools.js";
import { locatorRefusal, refusesSeatClient } from "../accounts/seatClientAdmission.js";
import { observeInfo, type FinalResultReceipt, type Game, type GameErrorCode, type NextStart, type Outcome, type SlotAccess } from "./game.js";
import { keyVerifier } from "../identity/identities.js";

/** Which agent this MCP session plays; set by join. One session is one agent. */
export interface SessionState {
  agentId: string | null;
  /** The bound seat's result only; no match state, history or token retention. */
  finalResult?: FinalResultReceipt;
  /** Slot servers: the key that joined this session, so a replaced key ends the session's seat. */
  admission?: KeyAdmission;
  /** Slot servers: joins refused since the last successful one because their key holds no usable seat here. */
  failedJoins?: number;
  /** Slot servers: joins in flight, which count toward that limit until they answer. */
  joinsInFlight?: number;
}

/**
 * How long a key-joined slot session plays on one check of its key, in wall-clock milliseconds; its next call
 * after that reads the key's holder again. Bounds how long a replaced key keeps playing.
 */
export const KEY_RECHECK_MS = 10_000;

/** The key that joined a slot session, held only as its verifier, never the key itself. */
interface KeyAdmission {
  readonly identityId: string;
  readonly verifier: string;
  /** game.wallClock() when the key was last found holding identityId. */
  checkedAt: number;
  /** The re-check in flight, shared by concurrent calls. */
  pending?: Promise<boolean>;
}

export const ORDER_KINDS = ["go_to", "forage", "hold", "attack", "follow_trail"] as const satisfies readonly Order["kind"][];
// Every order kind the sim knows is offered.
const allKinds: Exclude<Order["kind"], (typeof ORDER_KINDS)[number]> extends never ? true : never = true;
void allKinds;

/**
 * Every field falls back to null instead of failing the SDK's validation, so
 * the handler always runs and the call still reaches the sim. No field accepts
 * null, so a null is a caught wrong-typed field. tools/list keeps the types.
 */
/** Fall back to null instead of failing; the output type stays the schema's own, and handlers check for null at run time. */
function orNull<T extends z.ZodType>(schema: T) {
  return schema.catch(null as unknown as z.output<T>);
}

const tile = (axis: "column" | "row") => z.number().describe(`Whole tile ${axis}.`);
const words = z.array(z.string()).describe(`Mark words, each one of: ${WORDS.join(", ")}.`);
const markTile = (axis: "column" | "row") =>
  tile(axis).optional().describe(`Whole tile ${axis}. Leave out tileX and tileY and the mark lands on the tile of the squad ant nearest your squad's mean position (ties to the lowest ant id).`);
const markShape = {
  tileX: orNull(markTile("column")),
  tileY: orNull(markTile("row")),
  words: orNull(words),
};

/** The tile fields to send: both, or neither for a mark laid where the squad stands. */
function markTileOf(mark: { tileX?: number; tileY?: number }): { tileX?: number; tileY?: number } {
  return mark.tileX === undefined || mark.tileY === undefined ? {} : { tileX: mark.tileX, tileY: mark.tileY };
}

/** A mark's tile is both axes or neither: one axis alone is caught as the missing other. */
function missingMarkAxis(mark: { tileX?: number; tileY?: number } | undefined, prefix: string): string[] {
  if (mark === undefined || (mark.tileX === undefined) === (mark.tileY === undefined)) return [];
  return [prefix + (mark.tileX === undefined ? "tileX" : "tileY")];
}

/** A field's wrong-type text, kept on the field itself; a private registry, so tools/list is unchanged. */
const expectedText = z.registry<{ expected: string }>();
function expects<T extends z.ZodType>(schema: T, expected: string): T {
  expectedText.add(schema as z.ZodType, { expected });
  return schema;
}

/** Argument names outside a tool's own schema. */
export function unknownFields(schema: z.ZodObject, args: Record<string, unknown>): string[] {
  return Object.keys(args).filter((name) => !Object.hasOwn(schema.shape, name));
}

const EXPECTED: Readonly<Record<string, string>> = {
  kind: `one of ${ORDER_KINDS.join(", ")}`,
  tileX: "a number: a whole tile column",
  tileY: "a number: a whole tile row",
  toTileX: "a number: a LINE mark's second-end tile column",
  toTileY: "a number: a LINE mark's second-end tile row",
  intent: "a string",
  mark: 'an object with words and optional tileX and tileY, for example {"words":["ENEMY","QUEEN"]}',
  words: 'an array of word strings, for example ["ENEMY","QUEEN"]',
  map: "a boolean: true to include the territory map",
  waitSeconds: "a number: seconds to hold the reply, 0-10",
  since: "a non-negative integer event cursor from this seat (0 replays all retained events)",
  brood: `one of ${BROODS.join(", ")}`,
  verb: `one of ${COUNT_VERBS.join(", ")}`,
  count: "a number: a whole count of ants",
  caste: `one of ${COUNT_CASTES.join(", ")}; omitted means any`,
  queenId: "a number: the queenId of one of your colony's live queens",
  markId: "a number: the markId of your own count mark",
};

/** Rules 27: a re-lay keeps the original lifetime; anything else is a new mark. Same words as web/rules.ts. */
function relayLifetimeText(config: SimConfig): string {
  return lineMarksEnabled(config)
    ? " A re-lay keeps the lifetime from when the mark was first laid; for LINE the two ends must match in the same order. A different verb, tile or ends makes a new mark with its own lifetime."
    : " A re-lay keeps the lifetime from when the mark was first laid. A different verb or tile makes a new mark with its own lifetime.";
}

/** Rules 27 count_mark verbs that are commands, not mark jobs. */
const SPAWN_REMOVE_VERBS: readonly string[] = ["SPAWN", "REMOVE"];

/** Paths of caught (null) fields, nested objects included. */
function caughtPaths(value: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (v === null) paths.push(prefix + key);
    else if (typeof v === "object" && !Array.isArray(v)) paths.push(...caughtPaths(v as Record<string, unknown>, `${prefix}${key}.`));
  }
  return paths;
}

function expected(path: string, config: SimConfig, schema?: z.ZodObject): string {
  const tagged = schema !== undefined && Object.hasOwn(schema.shape, path) ? expectedText.get(schema.shape[path]!)?.expected : undefined;
  if (tagged !== undefined) return tagged;
  const field = path.slice(path.lastIndexOf(".") + 1);
  if (field === "kind" && config.wordMarksDisabled) return "one of go_to, forage, hold, attack";
  if (field === "verb" && config.patrolLinkTiles !== undefined) return `one of ${[...countMarkVerbs(config), ...SPAWN_REMOVE_VERBS].join(", ")}`;
  // Rules 27: a queenId names a live queen the caller owns.
  if (field === "queenId") return "a number: the queenId of a live queen you own";
  return EXPECTED[field] ?? "a value of the advertised type";
}

/** Bounded, printable text: no control or format characters. */
function validText(text: string, max: number): boolean {
  return text.trim().length > 0 && [...text].length <= max && !/\p{C}/u.test(text);
}

/** Errors carry the outcome only; all sighted events remain reachable through observe. */
function errorResult(code: string, message: string, howToFix: string, view: AgentView | null, extra: Record<string, unknown> = {}): CallToolResult {
  const data = { error: { code, message, howToFix }, tick: view?.tick ?? null, ...extra };
  return payload(data, true);
}

function startText(next: NextStart): string {
  if (next === null) return "not scheduled yet";
  return next.kind === "held" ? "when its caller starts it" : next.at.toISOString();
}

function squadTiles(view: AgentView | null): string {
  const tiles = [...new Set((view?.squad ?? []).map((a) => `(${a.tileX},${a.tileY})`))];
  return tiles.length === 0
    ? "Your squad is empty. Send an order without a mark (for example order {kind:\"forage\"}) to refill from available free ants. Retry the mark once your squad has ants."
    : `Leave out tileX and tileY to mark under the squad ant nearest your squad's mean position, or use a tile one of them stands on: ${tiles.join(", ")}.`;
}

/** The winner fields of an ended match, as observe reports them. */
/** names: the result's own match's colony names where the caller has them (a viewless refusal); else the agent's match's. */
function winnerFields(game: Game, agentId: string | null, result: MatchResult, names = game.colonyNames(agentId)): Record<string, unknown> {
  return { matchOver: true, winner: result.reason === "abandoned" ? "abandoned" : result.winner === null ? "draw" : names[result.winner], result };
}

/** The re-lay hint; nearestTile is the sim's read-only answer for the refused tick. */
function nearestTileText(code: GameErrorCode, tile: unknown, lineEnd = false): string {
  const named = tile !== null && typeof tile === "object" && "tileX" in tile && "tileY" in tile;
  // Rules 27: a LINE end's tile is only a candidate; the two ends must still differ.
  if (lineEnd) {
    return named ? `Nearest in-reach tile for that end now: (${tile.tileX},${tile.tileY}) (nearestTile), a candidate only: the two LINE ends must still be different tiles and the other checks still apply.`
      : "No tile within sight of your colony is in reach for that end now (nearestTile null).";
  }
  if (code === "count_mark_not_visible") {
    return named ? `Nearest tile this count mark would be accepted on now: (${tile.tileX},${tile.tileY}) (nearestTile).`
      : "No tile within sight of your colony would accept this count mark now (nearestTile null).";
  }
  return named ? `Nearest tile this command's tile rules accept now: (${tile.tileX},${tile.tileY}) (nearestTile).`
    : "No tile passes this command's tile rules now (nearestTile null).";
}

/** Count-mark sight stated as the circle the sim checks. */
function sightCircleText(config: SimConfig): string {
  return `a circle of radius ${config.sightTiles} tiles around any living ant of your colony (dx²+dy² ≤ ${config.sightTiles ** 2}, from the ant's tile)`;
}

/** Fix-it text for each error code. Sim messages already say what is wrong; only the agent's own view is quoted. */
function explain(
  game: Game,
  config: SimConfig,
  code: GameErrorCode,
  simMessage: string | undefined,
  view: AgentView | null,
  matchResult: MatchResult | null = null,
  extra: Record<string, unknown> = {},
  command?: SimInput["type"],
  /** With matchResult: the colony names of that result's match, from the refused outcome. */
  colonyNames?: ColonyNamePair,
): CallToolResult {
  // The sim's empty-squad omission message is the true cause; range is not.
  const emptySquadOmission = code === "count_mark_not_visible" && simMessage === EMPTY_SQUAD_COUNT_MARK;
  // Rules 27: the sim names which LINE end is out of reach; keep that message.
  const lineEnd = code === "count_mark_not_visible" && (simMessage === LINE_FROM_END_NOT_VISIBLE || simMessage === LINE_TO_END_NOT_VISIBLE);
  const [message, howToFix] = fixText(game, config, code, view, command, emptySquadOmission, lineEnd);
  const result = code === "match_over" || code === "call_rate" ? (matchResult ?? view?.result ?? null) : null;
  const canonicalMessage = code === "match_over" || (code === "count_mark_not_visible" && !emptySquadOmission && !lineEnd) || (code === "no_own_ant_on_tile" && view?.squad.length === 0);
  const fix = code === "call_rate" && typeof extra.retryAfterMs === "number"
    ? `Retry after ${extra.retryAfterMs} ms (retryAfterMs). This refusal does not reset your idle timer.`
    : code === "not_applied" && typeof extra.retryAfterMs === "number"
      ? `${howToFix} Wait ${extra.retryAfterMs} ms (retryAfterMs) first.`
    : (code === "count_mark_not_visible" || code === "water_tile" || code === "rock_tile") && "nearestTile" in extra
      ? `${howToFix} ${nearestTileText(code, extra.nearestTile, lineEnd)}` : howToFix;
  return errorResult(code, canonicalMessage ? message : simMessage ?? message, fix, view, { ...extra, ...(result === null ? {} : winnerFields(game, view?.agentId ?? null, result, colonyNames ?? game.colonyNames(view?.agentId ?? null))) });
}

/** Each founding refusal names the checks that still follow it, in foundQueen's order (FOUNDING_CHECKS). */
function foundingChecksAfter(config: SimConfig, code: FoundingCheck): string {
  const rules = config.queenFounding;
  if (rules === undefined) return "";
  const describe: Record<FoundingCheck, string | null> = {
    queen_tile_not_held: null,
    queen_too_early: (rules.firstFoundTick ?? 0) > 0 ? `opening (tick ${rules.firstFoundTick})` : null,
    queen_limit: rules.maxLiveQueens === undefined ? null : `live-queen limit ${rules.maxLiveQueens} (queenFounding.slotsRemaining)`,
    queen_cooldown: `colony cooldown ${rules.cooldownTicks} ticks (wait for queenFounding.nextFoundTick)`,
    queen_too_close: `spacing: at least ${rules.minDistanceTiles} tiles (Euclidean) from every ${rules.standingNestsOnly ? "standing nest" : "nest, including lost nests,"} of either colony`,
    queen_food: "stored food: queenFounding.foodStore at least queenFounding.cost",
  };
  const next = FOUNDING_CHECKS.slice(FOUNDING_CHECKS.indexOf(code) + 1).map(check => describe[check]).filter(text => text !== null);
  return next.length === 0 ? " Stored food is the last founding check." : ` Checked next, in order: ${next.join("; ")}.`;
}

/** A lobby slot server joins by key (and seat), never by reconnectToken, and its next match is a new lobby. */
const SLOT_NEXT_MATCH_TEXT = "Join a new lobby at the entry point (list_lobbies and join_lobby, or join_queue), then locate_match and join its mcpUrl with your key.";

function fixText(game: Game, config: SimConfig, code: GameErrorCode, view: AgentView | null, command?: SimInput["type"], emptySquadOmission = false, lineEnd = false): [string, string] {
  const mcp = game.mcpConfig;
  const fixes: Record<GameErrorCode, [string, string]> = {
    queen_disabled: ["Founding is not enabled in these rules.", "Play using the commands in this match's briefing."],
    queen_tile_not_held: ["Your colony does not hold that tile.", `Choose a tile whose bit is 1 in observe map:true territory (base64-bitset-lsb0, index y*width+x; observe's description decodes it).${foundingChecksAfter(config, "queen_tile_not_held")}`],
    queen_too_close: ["That tile is too close to a nest.", `Choose a tile at least ${config.queenFounding?.minDistanceTiles ?? 0} tiles from each nest covered by this match's spacing rule.${foundingChecksAfter(config, "queen_too_close")}`],
    queen_too_early: ["Founding has not opened yet.", `Founding opens at tick ${config.queenFounding?.firstFoundTick ?? 0}; wait until queenFounding.nextFoundTick.${foundingChecksAfter(config, "queen_too_early")}`],
    queen_limit: ["Your colony is at its live-queen limit.", `Live queen limit: ${config.queenFounding?.maxLiveQueens ?? "unlimited"}; observe shows queenFounding.slotsRemaining. No food was spent. A lost queen frees a live slot.${foundingChecksAfter(config, "queen_limit")}`],
    queen_cooldown: ["Your colony founded a queen too recently.", `Colony founding cooldown: ${config.queenFounding?.cooldownTicks ?? 0} ticks; wait until tick ${view?.queenFounding?.nextFoundTick ?? "shown by observe"} (queenFounding.nextFoundTick).${foundingChecksAfter(config, "queen_cooldown")}`],
    queen_food: ["Your colony has too little stored food.", `Required stored food: ${view?.queenFounding?.cost ?? config.queenFounding?.cost ?? 0}; available: ${view?.queenFounding?.foodStore ?? "shown by observe"}. Forage and deliver food.${foundingChecksAfter(config, "queen_food")}`],
    no_active_queen: ["Your colony has lost every queen.", "Call observe for the match result, then join the next match."],
    bad_brood: config.castes === undefined ? ["set_brood is not available in these rules.", "Play using the commands in this match's briefing."]
      : ["Bad brood.", `Send set_brood with brood ${BROODS.join(", ")}, and queenId when you own more than one live queen (observe queens). Nothing changed; set_brood never uses the command allowance.`],
    no_owned_queen: ["You own no live queen with that queenId.", "set_brood sets only a live queen you own (observe queens). Found a queen of your own with found_queen. Nothing changed; set_brood never uses the command allowance."],
    unknown_agent: ["You have not joined this match.", "Call join."],
    duplicate_agent: ["That agent has already joined.", "Call join with your reconnectToken."],
    match_over: ["This match has ended.", `Call observe for the final result and view; ${game.slot === undefined ? "call join without reconnectToken (or its token alias) to play the next match." : SLOT_NEXT_MATCH_TEXT} ${POST_MATCH_OBSERVE_TEXT} ${IDLE_COUNTDOWN_TEXT}`],
    rate_limited: ["Too soon for another command.", `Command interval: ${config.commandFloorTicks} ticks; next allowed tick ${view?.nextCommandTick ?? "shown by observe"}. Observe in the meantime.`],
    bad_order: command === "found_queen"
      ? ["The founding tile is outside the map.", `Send found_queen with whole-number tileX 0-${config.mapWidth - 1} and tileY 0-${config.mapHeight - 1} on a tile your colony holds.`]
      : [
        "Unknown order or target tile outside the map.",
        `Send go_to or attack with whole-number tileX 0-${config.mapWidth - 1} and tileY 0-${config.mapHeight - 1}, or ${config.wordMarksDisabled ? "forage or hold" : "forage, hold or follow_trail"}.`,
      ],
    intent_too_long: ["The intent line is too long.", `Shorten it to at most ${config.intentMaxChars} characters, or leave it out.`],
    water_tile: ["Water is impassable.", "Choose a dry land tile from the public terrain rectangles. Refused commands do not spend the command allowance."],
    rock_tile: ["Rocks are impassable.", config.wordMarksDisabled
      ? "Use observe and view.terrain.rocks to choose clear land outside rocks and water. Count marks require the command's visibility or own-squad tile; founding requires held land and nest spacing. Refused commands spend no food or command allowance."
      : "Use observe and view.terrain.rocks to choose clear land outside rocks and water. Marks still require the command's visibility or own-squad tile; founding requires held land and nest spacing. Refused commands spend no food or command allowance."],
    bad_mark_words: config.wordMarksDisabled ? ["This command is not available in these rules.", "Use count_mark or an order with only the advertised fields."]
      : ["Bad mark words.", `Send 1 to ${config.markMaxWords} words as a JSON array; each one of: ${WORDS.join(", ")}.`],
    no_own_ant_on_tile: ["No ant of your own squad stands on that tile.", config.wordMarksDisabled
      ? "Give count_mark a tile currently visible to a living ant of your colony, or wait until your squad has ants before omitting coordinates."
      : `Word marks (including an order's mark) require an own squad ant on the tile. ${squadTiles(view)}`],
    count_mark_not_visible: emptySquadOmission
      ? [EMPTY_SQUAD_COUNT_MARK, `Give tileX and tileY of a whole-number tile currently inside ${sightCircleText(config)}, or send an order (for example order {kind:"forage"}) to refill your squad from available free ants.`]
      // Only colony-sight placement refuses a tile as out of sight, so markReachText always states its reach here.
      : ["That count-mark tile is out of reach of your colony's living ants now.",
        `${markReachText(config)} Count marks may target any whole-number tile currently inside ${sightCircleText(config)}, including free ants and teammates' squads.${config.wordMarksDisabled ? "" : " Word marks still require one of your own squad ants standing on the tile."}${(view?.squad.length ?? 0) > 0 && !lineEnd ? " Omit both coordinates to use your squad's position." : ""}`],
    unknown_token: ["That reconnect token is not known.", "Check the reconnectToken join gave you, or call join without reconnectToken (or its token alias) to join as a new agent."],
    agent_cap: [`This match already has its ${mcp.maxAgentsPerMatch} agents.`, "Call join again after this match ends."],
    colony_full: [`The named colony is full: limit ${agentsPerColony(mcp)} agents per colony (${mcp.maxAgentsPerMatch} per match).`, "No seat was taken. Choose the other colony, omit colony for balancing, or wait for the next match."],
    call_rate: [`At most ${mcp.callsPerSecond} calls per second per agent.`, `Wait ${Math.ceil(1000 / mcp.callsPerSecond)} ms between calls.`],
    not_started: ["Your match has not started yet.", `Call observe until it starts (starts: ${startText(game.nextStart)}).`],
    match_not_played: ["This match was not played: its server was replaced or the match could not start. It has no winner and changes no rating.", "Your lobby records the outcome not_played. Join a new lobby to play again."],
    not_applied: ["This call was not applied: the match stopped on this server at the tick shown, to continue on another server.", "Make the same call again: the server that takes the match over applies it once. Until that server is ready this address may answer HTTP 503, and join with your key may answer lobby_loading; your seat is kept."],
    count_marks_disabled: ["Count marks are not part of these rules.", "Play using the commands in this match's briefing."],
    bad_count_mark: ["Bad count mark.", `Send one verb from ${countMarkVerbs(config).join(", ")} and a whole count of 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}. FORAGE recruits workers only; leave caste out or use worker, never soldier.${lineMarksEnabled(config) ? " Only LINE takes toTileX/toTileY; LINE needs whole-number tileX, tileY, toTileX and toTileY inside the map, two different end tiles, each clear land placed like any count mark." : ""}`],
    bad_spawn_point: ["Bad spawn point.", `Send verb SPAWN with queenId naming a live queen you own, and either whole-number tileX 0-${config.mapWidth - 1} and tileY 0-${config.mapHeight - 1} on a passable tile (not water or rock; no sight needed) to set or move her spawn point, or neither to clear it. Refused commands do not spend the command allowance.`],
    queen_not_owned: ["That queen belongs to a teammate.", "Only a queen's owner sets, moves or clears her spawn point: send SPAWN with the queenId of a live queen you own. Refused commands do not spend the command allowance."],
    bad_mark_removal: ["No count mark of yours has that markId.", "REMOVE takes markId: one of your own count marks still on the map, as listed in view.myMarks. Refused commands do not spend the command allowance."],
  };
  return fixes[code];
}

/** observe's hold in ms: the asked seconds, clamped to 0..MAX_OBSERVE_WAIT_SECONDS; none when not asked. */
export function observeWaitMs(waitSeconds: number | undefined): number {
  if (waitSeconds === undefined || !Number.isFinite(waitSeconds)) return 0;
  return Math.round(Math.min(Math.max(waitSeconds, 0), MAX_OBSERVE_WAIT_SECONDS) * 1000);
}

function observeResult(game: Game, config: SimConfig, outcome: Outcome, withMap: boolean, since?: number, queuedExtra: Record<string, unknown> = {}, cellsCursor?: string): CallToolResult {
  // A session whose old seat was retired still gets truthful unavailable timing.
  outcome = { ...outcome, observeInfo: outcome.observeInfo ?? observeInfo(null, "", config) };
  if (outcome.kind !== "view") return viewResult(game, config, outcome, queuedExtra);
  const { result } = outcome.view;
  const final = result === null ? {} : { message: "This match has ended.", ...winnerFields(game, outcome.view.agentId, result) };
  if (since !== undefined && since > game.eventHistory(outcome.view.agentId).length) {
    return errorResult("bad_event_cursor", "Event cursor exceeds this seat's retained event count.",
      `Use a cursor from 0 to ${game.eventHistory(outcome.view.agentId).length}; observe returns eventCursor.${result === null ? "" : ` ${POST_MATCH_OBSERVE_TEXT} ${IDLE_COUNTDOWN_TEXT}`}`, outcome.view, { ...outcome.observeInfo, ...final });
  }
  return pagedView(game, config, outcome.view, withMap, { ...outcome.observeInfo, ...final }, since, OBSERVE_REPLY_LIMITS, cellsCursor);
}

/** Rules 27: an accepted SPAWN or REMOVE names what it changed; no mark, event or view field carries it. */
export function spawnRemoveReply(config: SimConfig, input: SimInput | undefined): Record<string, unknown> {
  if (input?.type !== "count_mark") return {};
  if (input.verb === "SPAWN") return { spawnPoint: input.tileX === undefined || input.tileY === undefined
    ? { queenId: input.queenId, cleared: true } : { queenId: input.queenId, tileX: input.tileX, tileY: input.tileY } };
  return input.verb === "REMOVE" ? { removedMark: { markId: input.markId } } : {};
}

/** Outcome and this command's own changes only, never the general event list. */
function commandResult(game: Game, config: SimConfig, outcome: Outcome, input?: SimInput, intentLength?: number): CallToolResult {
  switch (outcome.kind) {
    case "view": {
      const { view } = outcome;
      const ownMark = view.events.findLast(event => event.type === "mark_laid" && event.agentId === view.agentId && event.tick === view.tick - 1);
      const notice = input?.type === "count_mark" ? view.events.findLast(event => event.type === "count_mark_accepted" && event.tick === view.tick - 1) : undefined;
      const newQueen = input?.type === "found_queen" ? view.queens?.find(q => q.foundedTick === view.tick - 1) : undefined;
      const reply = { tick: view.tick, accepted: true, nextCommandTick: view.nextCommandTick,
        ...(input?.type === "order" ? { order: view.order } : {}),
        ...(ownMark?.type === "mark_laid" && (input?.type === "mark" || input?.type === "count_mark" || (input?.type === "order" && input.mark !== undefined))
          ? { mark: publicCountCaste({ markId: ownMark.markId, tileX: ownMark.tileX, tileY: ownMark.tileY, words: ownMark.words,
              ...view.myMarks.find(mark => mark.markId === ownMark.markId) }) } : {}),
        ...(notice?.type === "count_mark_accepted" ? { countMark: publicCountCaste({ markId: notice.markId,
          ...(notice.caste === undefined ? {} : { caste: notice.caste }),
          claimed: view.myMarks.find(mark => mark.markId === notice.markId)?.claimed ?? 0,
          ...notice.availability, message: notice.message }) } : {}),
        ...spawnRemoveReply(config, input),
        ...(outcome.broodSet === undefined ? {} : { queenId: outcome.broodSet.queenId, brood: outcome.broodSet.brood }),
        ...(newQueen === undefined ? {} : { queen: publicQueen(game, view.agentId, newQueen), foodStore: view.queenFounding?.foodStore, nextFoundTick: view.queenFounding?.nextFoundTick,
          ...(config.castes !== undefined ? { broodNote: NEW_QUEEN_BROOD_TEXT } : {}) }) };
      return payload(view.result === null ? reply : { ...winnerFields(game, view.agentId, view.result), ...reply });
    }
    case "queued": return viewResult(game, config, outcome);
    case "error": return explain(game, config, outcome.code,
      outcome.code === "intent_too_long" && intentLength !== undefined
        ? `Intent length ${intentLength} exceeds the ${config.intentMaxChars}-character limit.` : outcome.simMessage,
      outcome.view, outcome.result ?? null, { ...nextCommandTick(outcome.view), ...outcome.timing,
        ...(outcome.nearestTile === undefined ? {} : { nearestTile: outcome.nearestTile }) }, input?.type, outcome.colonyNames);
  }
}

/**
 * The request _meta key of a tools/call's call id. The seat client sends one
 * per command and the same one on every resend of that command.
 */
export const CALL_ID_META_KEY = "antwars/callId";
/** Longest call id kept; the seat client sends a UUID. */
const MAX_CALL_ID_CHARS = 128;

/** A tools/call's call id; absent, empty, over-long or non-string ids leave the call as it is today. */
export function callIdOf(extra: { readonly _meta?: Readonly<Record<string, unknown>> }): string | undefined {
  const id = extra._meta?.[CALL_ID_META_KEY];
  return typeof id === "string" && id.length > 0 && id.length <= MAX_CALL_ID_CHARS ? id : undefined;
}

/**
 * One mutating command. A call id this seat's match has already applied gets that call's
 * original reply and no second effect; any other call is made as today, and its reply is remembered
 * under its call id if the match applies it. Refused, rate-limited or unapplied ids stay unremembered.
 */
async function applyCommand(game: Game, agentId: string, callId: string | undefined, input: SimInput,
  reply: (outcome: Outcome) => CallToolResult): Promise<CallToolResult> {
  const repeat = callId === undefined ? undefined : game.appliedCall(agentId, callId);
  if (repeat !== undefined) return repeat;
  const outcome = await game.call(agentId, input, true, callId === undefined ? undefined : { callId, reply });
  return (callId === undefined ? undefined : game.appliedCall(agentId, callId)) ?? reply(outcome);
}

/** A refused command also says when the next command is allowed: null when the call produced no view. */
function nextCommandTick(view: AgentView | null): { nextCommandTick: number | null } {
  return { nextCommandTick: view?.nextCommandTick ?? null };
}

function viewResult(game: Game, config: SimConfig, outcome: Outcome, queuedExtra: Record<string, unknown> = {}): CallToolResult {
  switch (outcome.kind) {
    case "view": {
      const { view } = outcome;
      return pagedView(game, config, view, false, { ...outcome.observeInfo, ...(view.result === null ? {} : winnerFields(game, view.agentId, view.result)) }, undefined, OBSERVE_REPLY_LIMITS, undefined, false);
    }
    case "queued":
      return payload({ waiting: true, matchStarts: startText(outcome.nextStart), message: "Your match has not started; keep calling observe.", ...outcome.observeInfo, ...queuedExtra });
    case "error":
      return explain(game, config, outcome.code, outcome.simMessage, outcome.view, outcome.result ?? null, { ...outcome.timing, ...outcome.observeInfo }, undefined, outcome.colonyNames);
  }
}

/**
 * A call the adapter refuses itself: wrong-typed arguments, or an invalid join from a
 * bound session. From a joined agent it goes through game.call as an observe input, so
 * the rate limit applies; when admitted it keeps the squad timer and carries the
 * agent's events, and when refused it gets game.call's error instead. After the agent's
 * match has ended, an order or mark gets the match-ended error, and a join is a fresh
 * join that does not touch the ended agent. An over-long intent or invalid mark words
 * are not refused here: they are clamped and reach the sim, which refuses them.
 * A refused order or mark ("command") also carries nextCommandTick, as its short reply does.
 */
async function adapterRefusal(
  game: Game,
  session: SessionState,
  caller: Caller,
  code: string,
  message: string,
  howToFix: string,
): Promise<CallToolResult> {
  const { agentId, finalResult } = session;
  if (agentId === null || (caller === "join" && game.status(agentId) === "ended")) return errorResult(code, message, howToFix, null);
  const config = game.configForAgent(agentId);
  const outcome = await sessionObserve(game, agentId, finalResult, false);
  if (outcome.kind === "error") return caller === "command" ? commandResult(game, config, outcome)
    : caller === "observe" ? observeResult(game, config, outcome, false) : viewResult(game, config, outcome);
  const view = outcome.kind === "queued" ? null : outcome.view;
  const extra = caller === "command" ? nextCommandTick(view) : caller === "observe" ? { ...outcome.observeInfo } : {};
  if (view !== null && view.result !== null) return explain(game, config, "match_over", undefined, view, null, extra);
  return errorResult(code, message, howToFix, view, extra);
}

/** Preserve a bound seat's result after the game's ordinary match/agent cleanup. */
async function sessionObserve(game: Game, agentId: string, receipt: FinalResultReceipt | undefined, countsAsHouseActivity = true): Promise<Outcome> {
  if (receipt?.notPlayed) return { kind: "error", code: "match_not_played", view: null, observeInfo: observeInfo(null, "", game.simConfig) };
  const outcome = await game.call(agentId, { type: "observe", agentId }, countsAsHouseActivity);
  const result = receipt?.result;
  if (outcome.kind === "error" && outcome.code === "unknown_agent" && result != null) {
    return { kind: "error", code: "match_over", view: null, result, ...(receipt?.colonyNames === undefined ? {} : { colonyNames: receipt.colonyNames }),
      observeInfo: observeInfo(null, "", game.simConfig) };
  }
  return outcome;
}

function bindSession(game: Game, session: SessionState, agentId: string, admission?: KeyAdmission): void {
  session.agentId = agentId;
  session.finalResult = game.finalResultReceipt(agentId);
  session.admission = admission;
}

/** Which tool a refused call came through: join, observe, or a command (order or mark). */
type Caller = "join" | "observe" | "command";

/** Cut text to at most max code points, counted as the sim counts them. */
function cutChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

const LONGEST_WORD = Math.max(...WORDS.map((w) => [...w].length));

/**
 * Agent text is clamped before game.call so every sim input and log line stays
 * bounded. Each cut keeps one unit over the sim's limit, so
 * the sim accepts and refuses exactly as it would the full text, with the same
 * fix-it error, and the call keeps the squad timer as any agent call does. Text
 * within the limits passes unchanged.
 */
export function clampIntent(config: SimConfig, intent: string): string {
  return cutChars(intent, config.intentMaxChars + 1);
}

/** Mark words cut to markMaxWords + 1 entries, each at most one character longer than the longest vocabulary word. */
export function clampWords(config: SimConfig, words: readonly string[]): string[] {
  return words.slice(0, config.markMaxWords + 1).map((w) => cutChars(w, LONGEST_WORD + 1));
}

/** A call with wrong-typed fields: the adapter's own error, and an observe input for the sim. */
function typeError(game: Game, session: SessionState, caller: Caller, paths: readonly string[], schema?: z.ZodObject): Promise<CallToolResult> {
  const callerConfig = session.agentId === null ? game.simConfig : game.configForAgent(session.agentId);
  const config = { ...game.simConfig, wordMarksDisabled: callerConfig.wordMarksDisabled };
  const message = paths.map((p) => `${p} must be ${expected(p, config, schema)}.`).join(" ");
  return adapterRefusal(game, session, caller, "bad_arguments", message, "Resend the call with these fields corrected.");
}

function notJoined(game: Game, extra: Record<string, unknown> = {}): CallToolResult {
  return errorResult("not_joined", "This session has not joined.", game.slot === undefined
    ? "Call join first (with your reconnectToken to rejoin as the same agent)."
    : "Call join first with your seated key (and seat, when your key holds several seats); the same key and seat return you to your seat.", null, extra);
}

/** Rules 27 with castes: each queen's owner sets her brood with set_brood, so order carries no brood. */
function orderBroodRetired(config: SimConfig): boolean {
  return config.castes !== undefined;
}

/**
 * The order tool's kind field. In rules 27 with castes, kind "brood" survives parsing so the
 * handler refuses it by name; any other value outside the enum is caught as null, as
 * orNull does, and the advertised schema is the same.
 */
function orderKind(config: SimConfig) {
  const kinds = z.enum(config.wordMarksDisabled ? ["go_to", "forage", "hold", "attack"] : ORDER_KINDS).describe("go_to and attack need tileX and tileY.");
  if (!orderBroodRetired(config)) return orNull(kinds);
  return kinds.catch((ctx) => (ctx?.input === "brood" ? "brood" : null) as unknown as z.output<typeof kinds>);
}

/** Only oversized diagnostics abbreviate names; ordinary calls report every name exactly. */
function unknownJoinArguments(names: readonly string[]): [string, string] {
  const diagnostic = (shown: readonly string[], omitted = 0, truncated = 0): [string, string] => {
    const bounded = omitted === 0 && truncated === 0 ? "" : ` ${omitted} names omitted; ${truncated} displayed names truncated.`;
    const list = shown.join(", ");
    return [`Unknown join arguments: ${list}.${bounded}`, `Remove unknown arguments: ${list}.${bounded} Use reconnectToken to rejoin; token is its alias.`];
  };
  const full = diagnostic(names.map(name => JSON.stringify(name)));
  // Use the largest possible tick when measuring both complete reply copies.
  if (fitsReply(errorResult("bad_arguments", ...full, null, { tick: Number.MAX_SAFE_INTEGER }))) return full;
  const shown = names.slice(0, 8);
  let truncated = 0;
  const labels = shown.map(name => {
    const prefix = cutChars(name, 40);
    if (prefix !== name) truncated += 1;
    return JSON.stringify(prefix) + (prefix === name ? "" : "…");
  });
  return diagnostic(labels, names.length - shown.length, truncated);
}

/** Join fields a slot server refuses by name: its seats and colonies come only from the lobby, and rejoin is by key. */
const SLOT_REFUSED_JOIN_FIELDS = ["reconnectToken", "token", "colony"];
/** A slot server seats its assigned lobby at its next one-second poll. */
const LOBBY_LOADING_RETRY_MS = 1000;

/** The slot join's fields: the only join arguments a slot server accepts. */
export function slotJoinSchema(mcp: McpConfig) {
  return z.looseObject({
    key: orNull(z.string().optional().describe("The same username or handle key used to take your lobby seat; not an invite token.")),
    seat: orNull(z.number().optional().describe("Which of your key's seats this session plays, 1 to N, when the key holds N > 1 seats (ranked 2v2 to 4v4); required then, one session per seat. Leave out, or send 1, for a single seat.")),
    modelLabel: expects(orNull(z.string().optional().describe("Optional self-reported model label, shown to spectators.")), "a string"),
    thinkingLevel: expects(orNull(z.string().optional().describe(`Optional self-reported thinking level, 1 to ${mcp.thinkingLevelMaxChars} printable characters; recorded with your seat, never inferred.`)), "a string"),
    serviceTier: expects(orNull(z.string().optional().describe(`Optional self-reported service tier, for example fast, 1 to ${mcp.serviceTierMaxChars} printable characters; recorded with your seat, never inferred.`)), "a string"),
  });
}

/**
 * A slot server's join and locate_match. Only identities seated in the
 * lobby this server plays join, each by its own key, on its lobby colony; the same
 * key again returns it to its seat. An identity holding several seats (ranked team
 * modes) joins each seat by key and seat number, one session per seat. No reconnect
 * token is issued or accepted.
 */
function registerSlotTools(server: McpServer, game: Game, slot: SlotAccess, session: SessionState): void {
  const schema = slotJoinSchema(game.mcpConfig);
  const optional = Object.keys(schema.shape).filter((name) => name !== "key");
  server.registerTool(
    "join",
    {
      description: `Join this lobby slot server with the username or handle key that holds your seat (the key you used in join_lobby or join_queue), not an invite token or reconnectToken. Only identities seated in this server's lobby may join, on their assigned colony. First use locate_match with your lobbyId and connect to its mcpUrl. In ranked 2v2, 3v3 and 4v4 one agent plays every seat of its colony: its key holds 2, 3 or 4 seats, and it joins each from its own session with join {key, seat}, seat 1 to N; with one seat, leave seat out. Reuse the same seated identity key, with the same seat, to return to your seat; never claim a new username to reconnect. Returns agentId, colony, squad and the rules briefing.`,
      inputSchema: schema,
    },
    async (args) => {
      const refused = Object.keys(args).filter((name) => SLOT_REFUSED_JOIN_FIELDS.includes(name));
      if (refused.length > 0) {
        return adapterRefusal(game, session, "join", "bad_arguments", `This server does not accept ${refused.join(", ")}.`,
          "Join with key (and seat, when your key holds several seats): your seats and colony come from your lobby, and joining again with the same key and seat returns you to that seat.");
      }
      const unknown = unknownFields(schema, args);
      if (unknown.length > 0) {
        const list = unknown.slice(0, 8).map((name) => JSON.stringify(cutChars(name, 40))).join(", ");
        return adapterRefusal(game, session, "join", "bad_arguments", `Unknown join arguments: ${list}.`, `Join with key, and optionally ${optional.slice(0, -1).join(", ")} and ${optional.at(-1)}.`);
      }
      const caught = caughtPaths(args);
      if (caught.length > 0) return typeError(game, session, "join", caught, schema);
      const { key, seat, modelLabel, thinkingLevel, serviceTier } = args as { key?: string; seat?: number; modelLabel?: string; thinkingLevel?: string; serviceTier?: string };
      if (key === undefined) {
        return adapterRefusal(game, session, "join", "key_required", "Matches here are played only by the lobby's seated identities.", "Call join with key: your identity key.");
      }
      if (modelLabel !== undefined && !validText(modelLabel, game.mcpConfig.modelLabelMaxChars)) {
        return adapterRefusal(game, session, "join", "bad_model_label", "Invalid model label.", `Use 1 to ${game.mcpConfig.modelLabelMaxChars} printable characters, or leave modelLabel out.`);
      }
      if (thinkingLevel !== undefined && !validText(thinkingLevel, game.mcpConfig.thinkingLevelMaxChars)) {
        return adapterRefusal(game, session, "join", "bad_thinking_level", "Invalid thinking level.", `Use 1 to ${game.mcpConfig.thinkingLevelMaxChars} printable characters, or leave thinkingLevel out.`);
      }
      if (serviceTier !== undefined && !validText(serviceTier, game.mcpConfig.serviceTierMaxChars)) {
        return adapterRefusal(game, session, "join", "bad_service_tier", "Invalid service tier.", `Use 1 to ${game.mcpConfig.serviceTierMaxChars} printable characters, or leave serviceTier out.`);
      }
      // Past the limit the key is never looked up: a session cannot keep trying keys against the store.
      if (joinLimitReached(game, session)) return tooManyFailedJoins(game, session);
      let failed = false;
      const joinSeat = async (): Promise<CallToolResult> => {
        // The key's check time, not the join's end: a join can wait (on its tick and the join record) past a rotation.
        const keyCheckedAt = game.wallClock();
        const identityId = await slot.identityOf(key);
        // The lobby seating this identity holds the slot but is not seated here yet; nothing touches an older seat.
        if (identityId !== undefined && await game.lobbyLoading(identityId)) {
          return errorResult("lobby_loading", "Your lobby holds this slot, but this server has not loaded it yet.",
            `Call join again with the same key${seat === undefined ? "" : " and seat"} after retryAfterMs; your seat is kept.`, null, { retryAfterMs: LOBBY_LOADING_RETRY_MS });
        }
        const held = identityId === undefined ? 0 : game.seatsHeld(identityId);
        if (held > 1 && seat === undefined) {
          failed = true;
          return adapterRefusal(game, session, "join", "seat_required", `This key holds ${held} seats in this lobby's match, each played from its own session.`,
            `Call join with key and seat, a number from 1 to ${held}; join each seat from a separate session.`);
        }
        if (held > 0 && seat !== undefined && !(Number.isSafeInteger(seat) && seat >= 1 && seat <= held)) {
          failed = true;
          return adapterRefusal(game, session, "join", "no_such_seat", `This key holds ${held === 1 ? "one seat" : `${held} seats`} in this lobby's match; seat ${cutChars(String(seat), 20)} is not one of them.`,
            held === 1 ? "Leave seat out, or send seat 1." : `Use a seat number from 1 to ${held}.`);
        }
        const joined = identityId === undefined ? null : await game.joinSeated(identityId, modelLabel, seat ?? 1, thinkingLevel, serviceTier);
        if (joined === null) {
          failed = true;
          return adapterRefusal(game, session, "join", "not_seated", "That key is not seated in the lobby this server is playing.",
            "Call locate_match with your lobby id and join at the mcpUrl it returns, with the key of an identity seated in that lobby.");
        }
        const { outcome } = joined;
        // Re-checked by verifier while the session plays (guardKeyAdmission); the key itself is not kept.
        const admission = slot.holderOfVerifier === undefined ? undefined
          : { identityId: identityId!, verifier: keyVerifier(key), checkedAt: keyCheckedAt };
        // A join that finished KEY_RECHECK_MS or more after its key was checked binds only if the key is still current.
        if (admission !== undefined && !await keyStillHeld(game, slot, admission)) {
          // That key's own earlier binding in this session ends with it; a binding by another key stays.
          if (session.admission?.verifier === admission.verifier) unbindSession(session);
          failed = true;
          return keyRevoked();
        }
        // An ended lobby seat remains identifiable even when its key rejoin hits the rate limit.
        if (joined.agentId !== null && outcome.kind === "error" &&
          (outcome.code === "match_over" || (outcome.code === "call_rate" && game.status(joined.agentId) === "ended"))) bindSession(game, session, joined.agentId, admission);
        if (outcome.kind === "error" || joined.agentId === null) return viewResult(game, joined.config, outcome);
        bindSession(game, session, joined.agentId, admission);
        // A join by a current key starts the count again.
        session.failedJoins = 0;
        const nest = nestFields(game, joined.agentId, true);
        const base = { agentId: joined.agentId, briefing: joinBriefing(joined.config, game.mcpConfig, "nestSelection" in nest, { house: game.isHouseMatch(joined.agentId), undrawn: !game.mapDrawnFor(joined.agentId), colonyNames: game.colonyNames(joined.agentId) }) };
        if (outcome.kind === "queued") {
          return payload({ ...base, ...nest, matchStarts: startText(outcome.nextStart), message: "Your lobby's match has not started; you are seated in it. Call observe until it starts." });
        }
        const { view } = outcome;
        if (view.result !== null) return viewResult(game, joined.config, outcome);
        return pagedView(game, joined.config, view, false, { ...base, colony: game.colonyNames(joined.agentId)[view.colony], squad: view.squad }, undefined, OBSERVE_REPLY_LIMITS, undefined, false);
      };
      // A join in flight counts toward the limit until it answers, so concurrent joins cannot pass it together.
      session.joinsInFlight = (session.joinsInFlight ?? 0) + 1;
      try {
        return await joinSeat();
      } finally {
        session.joinsInFlight = (session.joinsInFlight ?? 1) - 1;
        if (failed) session.failedJoins = (session.failedJoins ?? 0) + 1;
      }
    },
  );

  registerMatchLocator(server, (lobbyId) => slot.locate(lobbyId));
}

/**
 * Register the same public match lookup on slot servers and accounts-enabled root servers.
 * On the entry server (seatClientAdmission), a seat client 1.0.0 session is refused first.
 */
export function registerMatchLocator(server: McpServer, locate: SlotAccess["locate"], options: { seatClientAdmission?: boolean } = {}): void {
  server.registerTool(
    "locate_match",
    {
      description: "After list_lobbies/create_lobby and join_lobby, use read_lobby to follow your lobby. Once holding a slot, locate_match returns its slot, mcpUrl and spectatorUrl (the match's antwars.ai page); all are null until it holds one. For a private lobby, share its inviteLink with humans, not spectatorUrl: only the invite opens a private match. No key needed here. Connect to that mcpUrl and call join with the same identity key used in join_lobby; an invite token cannot take a match seat.",
      inputSchema: { lobbyId: orNull(z.string().describe("Your lobby id from create_lobby, list_lobbies or read_lobby; not a key or invite token.")) },
    },
    async (args) => {
      if (options.seatClientAdmission === true && refusesSeatClient(server)) return locatorRefusal();
      if (args.lobbyId === null) return errorResult("bad_arguments", "lobbyId must be a string.", "Resend locate_match with your lobby's id.", null);
      const location = await locate(args.lobbyId);
      if (location === undefined) return errorResult("no_such_lobby", "No lobby has that id.", "Use the lobbyId that create_lobby, list_lobbies or read_lobby returned.", null);
      return payload({ ...location });
    },
  );
}

/** The root join's fields: the only join arguments the root server accepts. */
export function rootJoinSchema(mcp: McpConfig) {
  return z.looseObject({
    reconnectToken: expects(orNull(z.string().optional().describe("Your reconnectToken, to rejoin as the same agent from any session.")), "a string: the reconnectToken join gave you"),
    token: expects(orNull(z.string().optional().describe("Alias for reconnectToken. If both are sent, their values must match.")), "a string: alias for reconnectToken"),
    displayName: expects(orNull(z.string().optional().describe("Optional display name.")), "a string"),
    modelLabel: expects(orNull(z.string().optional().describe("Optional self-reported model label, shown to spectators.")), "a string"),
    thinkingLevel: expects(orNull(z.string().optional().describe(`Optional self-reported thinking level, 1 to ${mcp.thinkingLevelMaxChars} printable characters; recorded with your seat, never inferred.`)), "a string"),
    colony: expects(orNull(z.enum(COLONY_NAMES).optional().describe(`Optional colony to join; honoured below the ${agentsPerColony(mcp)}-agent colony limit, otherwise refused. Omit to balance.`)), `one of ${COLONY_NAMES.map((n) => `"${n}"`).join(", ")}`),
  });
}

/** A recorded call's tool name is at most this many characters, then an ellipsis. */
const MAX_STORED_TOOL_CHARS = 100;

/** A stub's code for an error result the MCP SDK formed itself (schema refusal, throwing handler): it has no structuredContent. */
const SDK_ERROR = "sdk_error";

/** The reply's error code as the agent saw it: a game error's error.code, an account refusal's error; null for a success. */
function stubCode(reply: CallToolResult): string | null {
  if (reply.isError !== true) return null;
  const error = (reply.structuredContent as { readonly error?: unknown } | undefined)?.error;
  if (reply.structuredContent === undefined) return SDK_ERROR;
  if (typeof error === "string") return error;
  const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

type RequestHandler = (request: { readonly params?: { readonly name?: unknown; readonly arguments?: unknown } }, extra: unknown) => Promise<unknown>;

/** Whether the session's joining key still holds its identity: read again once KEY_RECHECK_MS has passed since the last check. */
function keyStillHeld(game: Game, slot: SlotAccess, admission: KeyAdmission): Promise<boolean> | boolean {
  const holderOf = slot.holderOfVerifier;
  if (holderOf === undefined || game.wallClock() - admission.checkedAt < KEY_RECHECK_MS) return true;
  admission.pending ??= (async () => {
    const at = game.wallClock();
    try {
      const held = await holderOf(admission.verifier) === admission.identityId;
      if (held) admission.checkedAt = at;
      return held;
    } catch (error) {
      // An unreadable store is not a revoked key: play on, and read again on the next call.
      console.warn(`antwar session key re-check failed; retrying on the next call: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    } finally {
      admission.pending = undefined;
    }
  })();
  return admission.pending;
}

/**
 * A slot session joined by key plays its seat only while that key still holds the seat's identity. Before each
 * call, once KEY_RECHECK_MS has passed since the key was last found current, its holder is read again by
 * verifier. A replaced key (rotate_key, reissue_handle_key) ends the session's seat binding, and the call is
 * refused with key_revoked; a join or recover_key instead runs unbound, so the current key can rejoin in the same
 * session, or a key whose reply this session lost can be recovered first.
 * Installed beneath recordCalls, as it wraps the same SDK tools/call handler.
 */
function guardKeyAdmission(server: McpServer, game: Game, slot: SlotAccess, session: SessionState): void {
  const handlers = (server.server as unknown as { readonly _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
  const answer = handlers?.get("tools/call");
  if (handlers === undefined || answer === undefined) {
    throw new Error("the MCP SDK's tools/call handler was not found, so a replaced key could not end its sessions");
  }
  handlers.set("tools/call", async (request, extra) => {
    // A join past the failed-join limit is refused without reading the store, so it skips the key re-check too.
    if (request.params?.name === "join" && joinLimitReached(game, session)) return tooManyFailedJoins(game, session);
    const admission = session.admission;
    if (admission === undefined || await keyStillHeld(game, slot, admission) || session.admission !== admission) return answer(request, extra);
    unbindSession(session);
    // join lets the current key rejoin here; recover_key lets a session whose key-issuing reply was lost (the
    // replacing rotation's, say) recover that key, keeping its pending recovery. Every other call is refused.
    const name = request.params?.name;
    if (name === "join" || name === "recover_key") return answer(request, extra);
    return keyRevoked();
  });
}

/** A slot session's failed joins, with those in flight, have reached the limit: its joins are refused unread. */
function joinLimitReached(game: Game, session: SessionState): boolean {
  return (session.failedJoins ?? 0) + (session.joinsInFlight ?? 0) >= game.mcpConfig.maxFailedJoinsPerSession;
}

/**
 * The refusal for a join past that limit. Terminal once the failures alone reach it: it is answered without the
 * session's seat (no observe, so no rate limit), since another join from this session can only be refused the same
 * way. When joins still in flight make up the rest, it says to wait for them: one that succeeds starts the count again.
 */
function tooManyFailedJoins(game: Game, session: SessionState): CallToolResult {
  const limit = game.mcpConfig.maxFailedJoinsPerSession;
  const failed = session.failedJoins ?? 0;
  if (failed < limit) {
    return errorResult("too_many_failed_joins",
      `This session already has ${limit} joins pending or refused (${failed} refused because their key holds no seat here), so it takes no more joins until the pending ones answer.`,
      "Wait for your pending joins to answer, then call join again only if none of them joined your seat.", null);
  }
  return errorResult("too_many_failed_joins",
    `This session has had ${limit} joins refused because their key holds no seat here, so it takes no more joins.`,
    "Check your key and seat (locate_match gives your lobby's mcpUrl), then start a new MCP session and call join from it.", null);
}

/** Ends the session's seat binding: it plays no seat until it joins again. */
function unbindSession(session: SessionState): void {
  session.agentId = null;
  session.finalResult = undefined;
  session.admission = undefined;
}

/** The refusal for a call whose joining key has been replaced. */
function keyRevoked(): CallToolResult {
  return errorResult("key_revoked", "The key this session joined with has been replaced, so this session no longer plays its seat.",
    "Call join with your seat's current key (and seat, when your key holds several seats). If this session lost the reply that carried that key, call recover_key first.", null);
}

/**
 * Records every call this session makes for the seat it plays, game and account tools alike, in full or as a
 * stub (Game.recordReply): the received
 * and answered times, the arguments exactly as sent, before the SDK's schema parsing (which nulls wrong-typed fields
 * and strips unknown ones), and the reply exactly as answered, including the SDK's own error results for arguments it
 * refuses and handlers that throw. The tool descriptions this session was last served (tools/list) travel with each
 * call as served text, which the recording keeps once per match. That needs the SDK's tools/call and tools/list
 * handlers themselves, which McpServer installs on its first registerTool; the SDK offers no public hook for them, so
 * a missing handler fails the session's setup loudly rather than recording nothing. The seat is the one bound after
 * the call, so a successful join is recorded for the seat it binds.
 */
function recordCalls(server: McpServer, game: Game, session: SessionState): void {
  const handlers = (server.server as unknown as { readonly _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
  const answer = handlers?.get("tools/call");
  const list = handlers?.get("tools/list");
  if (handlers === undefined || answer === undefined || list === undefined) {
    throw new Error("the MCP SDK's tools/call or tools/list handler was not found, so tool calls cannot be recorded");
  }
  let tools: ServedText | undefined;
  handlers.set("tools/list", async (request, extra) => {
    const listed = await list(request, extra);
    try {
      tools = servedText("tools", JSON.stringify((listed as { readonly tools?: unknown }).tools ?? null));
    } catch (error) {
      console.error(`antwar served tool descriptions not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    return listed;
  });
  handlers.set("tools/call", async (request, extra) => {
    const receivedAt = game.wallClock();
    const tool = request.params?.name;
    // Only an unknown tool's name can be long; the SDK refuses it, so it is a stub carrying the name's start. A request
    // naming no string tool records an empty name.
    const name = typeof tool !== "string" ? "" : tool.length > MAX_STORED_TOOL_CHARS ? `${tool.slice(0, MAX_STORED_TOOL_CHARS)}…` : tool;
    let result: unknown;
    try {
      result = await answer(request, extra);
    } catch (error) {
      // The SDK refused the request itself (its params fail the tools/call schema: a tool name that is not a string,
      // arguments that are not an object) or passed a handler's error through: the agent gets a protocol error and no
      // tool result exists to build an entry from, so the call is a stub, as every SDK-formed error is.
      if (session.agentId !== null) {
        game.recordReply(session.agentId, { tool: name, receivedAt, answeredAt: game.wallClock(), code: SDK_ERROR, alwaysStub: true }, () => {
          throw new Error("a refused request has no entry");
        });
      }
      throw error;
    }
    const answeredAt = game.wallClock();
    if (typeof tool === "string" && session.agentId !== null) {
      const reply = result as CallToolResult;
      const code = stubCode(reply);
      // Calls outside the seat's admitted window are always stubs: rate-limited refusals and the SDK's own errors.
      game.recordReply(session.agentId, { tool: name, receivedAt, answeredAt, code, alwaysStub: code === "call_rate" || code === SDK_ERROR }, () => {
        const { call, texts } = storedCall(tool, request.params?.arguments, reply);
        return { entry: { tool: name, receivedAt, answeredAt, ...call }, texts: tools === undefined ? texts : [tools, ...texts] };
      });
    }
    return result;
  });
}

/** Rules stay readable at the entry point; gameplay belongs to slots and the comparison run.
 * localBriefing: this server serves no accounts (the local route), so its briefings omit account and lobby text. */
export function registerTools(server: McpServer, game: Game, session: SessionState, options: { gameplay?: boolean; localBriefing?: boolean } = {}): void {
  const local = options.localBriefing === true ? { local: true } : {};
  if (options.gameplay !== false) registerNestTool(server, game, session);
  server.registerTool("rules", {
    description: "Read the complete rules and worked examples for your match in one call. If your nest window is open, call pick_nest first, then read this. A legal repick replaces yours. Otherwise read this after the concise join briefing.",
    inputSchema: {},
  }, async () => {
    const agentId = session.agentId;
    if (agentId === null) return payload({ rules: briefing(game.undrawnConfig, game.mcpConfig, { house: game.isHouseMatch(), undrawn: true, colonyNames: game.colonyNames(), ...local }) });
    // A rules read is an ordinary admitted observe call for rate limits and seat timers.
    const outcome = await game.call(agentId, { type: "observe", agentId });
    if (outcome.kind === "error") return viewResult(game, game.simConfig, outcome);
    const result = outcome.kind === "view" ? outcome.view.result : null;
    const rules = briefing(game.configForAgent(agentId), game.mcpConfig, { house: game.isHouseMatch(agentId), undrawn: !game.mapDrawnFor(agentId), colonyNames: game.colonyNames(agentId), ...local });
    // The window text omits its founding-price sentence only where this briefing already states it.
    return payload({ rules, ...nestFields(game, agentId, false, rules.includes("starting queens do not count")), ...(result === null ? {} : winnerFields(game, agentId, result)) });
  });
  if (game.slot !== undefined) guardKeyAdmission(server, game, game.slot, session);
  recordCalls(server, game, session);
  if (options.gameplay === false) return;
  const rootSchema = rootJoinSchema(game.mcpConfig);
  if (game.slot !== undefined) registerSlotTools(server, game, game.slot, session);
  else server.registerTool(
    "join",
    {
      description: `Join Antwars, or rejoin as the same agent with reconnectToken (token is an alias). Unknown arguments are refused by name. Queued join returns agentId, reconnectToken, colony, briefing, matchStarts and message; no squad exists yet. Once the match starts, observe shows your squad. Running-match join returns agentId, reconnectToken, colony, squad, briefing and view. ${agentLimitText(game.mcpConfig)}`,
      // Keep unknown keys until the handler can refuse them by name, rather than silently stripping them.
      inputSchema: rootSchema,
    },
    async (args) => {
      const unknown = unknownFields(rootSchema, args);
      if (unknown.length > 0) return adapterRefusal(game, session, "join", "bad_arguments", ...unknownJoinArguments(unknown));
      const caught = caughtPaths(args);
      if (caught.length > 0) return typeError(game, session, "join", caught, rootSchema);
      const { reconnectToken, token: alias, displayName, modelLabel, thinkingLevel, colony } = args as { reconnectToken?: string; token?: string; displayName?: string; modelLabel?: string; thinkingLevel?: string; colony?: (typeof COLONY_NAMES)[number] };
      if (reconnectToken !== undefined && alias !== undefined && reconnectToken !== alias) {
        return adapterRefusal(game, session, "join", "bad_arguments", "reconnectToken and token must match.", "Send reconnectToken alone, or send the same value for reconnectToken and its token alias.");
      }
      const token = reconnectToken ?? alias;
      const mcp = game.mcpConfig;
      if (displayName !== undefined && !validText(displayName, mcp.displayNameMaxChars)) {
        return adapterRefusal(game, session, "join", "bad_display_name", "Invalid display name.", `Use 1 to ${mcp.displayNameMaxChars} printable characters, or leave displayName out.`);
      }
      if (modelLabel !== undefined && !validText(modelLabel, mcp.modelLabelMaxChars)) {
        return adapterRefusal(game, session, "join", "bad_model_label", "Invalid model label.", `Use 1 to ${mcp.modelLabelMaxChars} printable characters, or leave modelLabel out.`);
      }
      if (thinkingLevel !== undefined && !validText(thinkingLevel, mcp.thinkingLevelMaxChars)) {
        return adapterRefusal(game, session, "join", "bad_thinking_level", "Invalid thinking level.", `Use 1 to ${mcp.thinkingLevelMaxChars} printable characters, or leave thinkingLevel out.`);
      }
      const bound = game.status(session.agentId);
      if (token === undefined && (bound === "live" || bound === "queued")) {
        return adapterRefusal(
          game,
          session,
          "join",
          "already_joined",
          `This session already plays agent ${session.agentId}.`,
          "Call observe, order or mark; to rejoin from a new session, call join there with your reconnectToken.",
        );
      }
      const joined = await game.join({
        ...(token === undefined ? {} : { token }),
        ...(displayName === undefined ? {} : { displayName }),
        ...(modelLabel === undefined ? {} : { modelLabel }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(colony === undefined ? {} : { colony: COLONY_NAMES.indexOf(colony) as ColonyId }),
      });
      const { outcome } = joined;
      if (outcome.kind === "error" && outcome.code === "unknown_token" && session.agentId !== null) {
        // From a bound session this is a call by that agent: admitted or refused like any other.
        return adapterRefusal(game, session, "join", "unknown_token", ...fixText(game, joined.config, "unknown_token", null));
      }
      // A known ended token still identifies its original seat, even if the rejoin is refused.
      // Bind only that case, never an unknown token or a live rate-refused rejoin.
      if (joined.agentId !== null && outcome.kind === "error" &&
        (outcome.code === "match_over" || (outcome.code === "call_rate" && game.status(joined.agentId) === "ended"))) bindSession(game, session, joined.agentId);
      if (outcome.kind === "error" || joined.agentId === null) return viewResult(game, joined.config, outcome);
      bindSession(game, session, joined.agentId);
      const base = { agentId: joined.agentId, reconnectToken: joined.token, briefing: joinBriefing(joined.config, game.mcpConfig, false, { house: game.isHouseMatch(joined.agentId), undrawn: !game.mapDrawnFor(joined.agentId), colonyNames: game.colonyNames(joined.agentId), ...local }) };
      if (outcome.kind === "queued") {
        const placement = game.queuedLineup().find(seat => seat.agentId === joined.agentId);
        if (placement === undefined) throw new Error("Queued join has no colony placement");
        return payload({ ...base, colony: game.colonyNames(joined.agentId)[placement.colony], matchStarts: startText(outcome.nextStart),
          message: `No match is running; you are in the next one. Call observe until it starts. ${sessionExpiryText(game.mcpConfig)}` });
      }
      const { view } = outcome;
      if (view.result !== null) return viewResult(game, joined.config, outcome);
      return pagedView(game, joined.config, view, false, { ...base, colony: game.colonyNames(joined.agentId)[view.colony], squad: view.squad }, undefined, OBSERVE_REPLY_LIMITS, undefined, false);
    },
  );

  server.registerTool(
    "observe",
    {
      description:
        `${observeDetailText(game.simConfig, game.mcpConfig, { house: game.isHouseMatch(session.agentId) })} ${colonyVisibilityText(game.simConfig)} ${FOOD_RADIX_TEXT} ${CELL_PAGING_TEXT}${usesCompactAgentText(game.simConfig) ? ` ${ENEMY_QUEENS_TEXT}` : ""} ${SEAT_NOTICE_TEXT} Full current view with lossless dense cells, squad, marks and territory counts. ${MY_MARKS_TEXT} Without since, eventsMode:current samples newest unseen events from the last command cycle, prioritizing pending own-queen and own mark/count-mark events; priorityEventsMore means priorities remain queued. Current count-mark acceptance notices omit message and availability; command replies and explicit history retain full details. Default sampling never advances eventCursor. For complete chronological history use since:0, then since:view.eventCursor while eventsMore; eventsMode:history may repeat sampled events. History and pending priorities survive reconnects. ${TERRITORY_TEXT} ${MARK_TABLE_TEXT} waitSeconds holds up to 10 s.`,
      inputSchema: {
        cellsCursor: orNull(z.string().min(1).max(128).optional().describe("Omit to capture current colony sight, squad cells first. While view.cellsMore, pass view.cellsCursor to fetch the next frozen cellsTick page. A fresh observe replaces this cell snapshot; event since is independent.")),
        since: orNull(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe("Omit for current-event sampling with own-queen/own-mark priority. Set 0 to replay every seat event from join, then continue with view.eventCursor while eventsMore. Explicit replay alone advances that cursor; it may repeat sampled events. History survives commands, refusals and reconnects for this match.")),
        map: orNull(z.boolean().optional().describe("true to include territory, your colony's lossless base64-bitset-lsb0 ownership map; leave it out unless you need the map.")),
        waitSeconds: orNull(
          z
            .number()
            .optional()
            .describe(
              `Hold the reply this many seconds (0-${MAX_OBSERVE_WAIT_SECONDS}; more counts as ${MAX_OBSERVE_WAIT_SECONDS}), then return the view as it stands then. Use it instead of calling observe repeatedly.`,
            ),
        ),
      },
    },
    async (args) => {
      const { agentId, finalResult } = session;
      if (agentId === null) return notJoined(game, { ...observeInfo(null, "", game.simConfig) });
      const caught = caughtPaths(args);
      if (caught.length > 0) return typeError(game, session, "observe", caught);
      const { map, waitSeconds, since, cellsCursor } = args as { map?: boolean; waitSeconds?: number; since?: number; cellsCursor?: string };
      const holdMs = observeWaitMs(waitSeconds);
      if (holdMs > 0) await sleep(holdMs);
      const eligible = (since === undefined || since <= game.eventHistory(agentId).length) && game.validCellsCursor(agentId, cellsCursor);
      const outcome = await sessionObserve(game, agentId, finalResult, eligible);
      return observeResult(game, game.configForAgent(agentId), outcome, map === true, since, nestFields(game, agentId, true), cellsCursor);
    },
  );

  const orderShape = {
    kind: orderKind(game.simConfig),
    tileX: orNull(tile("column").optional()),
    tileY: orNull(tile("row").optional()),
    ...(game.simConfig.wordMarksDisabled ? {} : { mark: orNull(z.object(markShape).optional().describe(
      "A mark to lay with this order, on a tile one of your squad's ants stands on. Leave out tileX and tileY and it lands on the tile of the squad ant nearest your squad's mean position (ties to the lowest ant id). If the mark is refused, the order is not applied either.",
    )) }),
    intent: orNull(z.string().optional().describe("What you intend, for spectators only.")),
  };
  const broodRetired = orderBroodRetired(game.simConfig);
  server.registerTool(
    "order",
    {
      description:
        `Give your squad a standing order, ${game.simConfig.wordMarksDisabled ? "optionally carrying a spectator-only intent line" : "optionally carrying one mark and a spectator-only intent line"}. One command per ${game.simConfig.commandFloorTicks / game.simConfig.ticksPerSecond} s (by default). Replies with the tick, accepted or the refusal and how to fix it, nextCommandTick and only this command's changes; call observe for the view and paged events.${broodRetired ? ` Orders carry no brood. ${queenBroodText(game.simConfig, game.mcpConfig.callsPerSecond)} ${queenSpawnOwnerText(game.simConfig)}` : ""}`,
      // Preserve unadvertised fields for an explicit refusal, never silently strip
      // a retired attached command or the retired brood and apply the rest of the order.
      inputSchema: game.simConfig.wordMarksDisabled || broodRetired ? z.object(orderShape).passthrough() : z.object(orderShape),
    },
    async (args, extra) => {
      const agentId = session.agentId;
      if (agentId === null) return notJoined(game, nextCommandTick(null));
      if (broodRetired && (Object.hasOwn(args, "brood") || (args.kind as string) === "brood")) {
        return adapterRefusal(game, session, "command", "bad_arguments", "Orders carry no brood in these rules: each queen's owner sets her brood with set_brood.",
          "Resend the order without a brood field or kind \"brood\", and call set_brood with brood workers, soldiers or mixed to set your queen's brood.");
      }
      if (game.configForAgent(agentId).wordMarksDisabled && Object.hasOwn(args, "mark")) {
        return adapterRefusal(game, session, "command", "bad_arguments", "This order contains an unavailable field.", "Send an order using only the fields in tools/list.");
      }
      // Rules 27 with word marks keeps unadvertised fields only to see brood; the rest are dropped, as the strict schema does.
      const caught = caughtPaths(game.simConfig.wordMarksDisabled ? args : Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(orderShape, key))));
      const { kind, tileX, tileY, mark, intent, brood } = args as {
        kind: Order["kind"];
        tileX?: number;
        tileY?: number;
        mark?: { tileX?: number; tileY?: number; words: string[] };
        intent?: string;
        brood?: Brood;
      };
      if (caught.length === 0) caught.push(...missingMarkAxis(mark, "mark."));
      if (caught.length === 0 && (kind === "go_to" || kind === "attack")) {
        if (tileX === undefined) caught.push("tileX");
        if (tileY === undefined) caught.push("tileY");
      }
      if (caught.length > 0) return typeError(game, session, "command", caught);
      const config = game.configForAgent(agentId);
      const order: Order = kind === "go_to" || kind === "attack" ? { kind, tileX: tileX!, tileY: tileY! } : { kind };
      const input: SimInput = {
        type: "order",
        agentId,
        order,
        ...(mark === undefined ? {} : { mark: { ...markTileOf(mark), words: clampWords(config, mark.words) } }),
        ...(intent === undefined ? {} : { intent: clampIntent(config, intent) }),
        ...(brood === undefined ? {} : { brood }),
      };
      return applyCommand(game, agentId, callIdOf(extra), input, (outcome) => commandResult(game, config, outcome, input, intent === undefined ? undefined : [...intent].length));
    },
  );

  // Rules 27: set_brood exists only with castes on.
  const queenBrood = game.simConfig.castes === undefined ? "" : queenBroodText(game.simConfig, game.mcpConfig.callsPerSecond);
  if (game.simConfig.queenFounding !== undefined) server.registerTool(
    "found_queen",
    {
      description: `Found a queen on a tile your colony holds, spending its stored food. Every nest can hatch, accept food and be overrun independently; the colony loses only when all queens are lost. Shares ${game.simConfig.wordMarksDisabled ? "the" : "order/mark's"} command limit; observe shows queens and queenFounding rules, food and cooldown. Replies as order does.${queenBrood === "" ? "" : ` ${queenBrood}`} ${queenSpawnOwnerText(game.simConfig)}`,
      inputSchema: { tileX: orNull(tile("column")), tileY: orNull(tile("row")) },
    },
    async (args, extra) => {
      const agentId = session.agentId;
      if (agentId === null) return notJoined(game, nextCommandTick(null));
      const caught = caughtPaths(args);
      if (caught.length > 0) return typeError(game, session, "command", caught);
      const config = game.configForAgent(agentId);
      const input: SimInput = { type: "found_queen", agentId, tileX: args.tileX, tileY: args.tileY };
      return applyCommand(game, agentId, callIdOf(extra), input, (outcome) => commandResult(game, config, outcome, input));
    },
  );

  // Rules 27: each agent sets its own queens' brood, outside the command allowance.
  const castes = game.simConfig.castes;
  if (castes !== undefined) server.registerTool(
    "set_brood",
    {
      description: `Set the brood of one live queen you own. ${queenBroodText(game.simConfig, game.mcpConfig.callsPerSecond)} ${queenSpawnOwnerText(game.simConfig)} Accepted at any tick: it neither waits for nor moves nextCommandTick. Replies with tick, accepted or the refusal and how to fix it, the queenId and brood set, and nextCommandTick.`,
      inputSchema: {
        brood: orNull(z.enum(BROODS).describe(`workers (${game.simConfig.hatchCost} food, carry food), soldiers (${castes.soldierCost} food, stronger, carry nothing) or mixed (this queen alternates worker and soldier).`)),
        queenId: orNull(z.number().optional().describe("The queenId of the live queen you own whose brood this sets (observe queens); needed only when you own more than one.")),
      },
    },
    async (args, extra) => {
      const agentId = session.agentId;
      if (agentId === null) return notJoined(game, nextCommandTick(null));
      const caught = caughtPaths(args);
      if (caught.length > 0) return typeError(game, session, "command", caught);
      const config = game.configForAgent(agentId);
      const input: SimInput = { type: "set_brood", agentId, brood: args.brood, ...(args.queenId === undefined ? {} : { queenId: args.queenId }) };
      return applyCommand(game, agentId, callIdOf(extra), input, (outcome) => commandResult(game, config, outcome, input));
    },
  );

  if (!game.simConfig.wordMarksDisabled) server.registerTool(
    "mark",
    {
      description:
        `Lay a scent mark on a tile one of your squad's ants stands on. ${WORD_MARK_ACTIONS} Leave out tileX and tileY and it lands on the tile of the squad ant nearest your squad's mean position (ties to the lowest ant id). Marks share the command allowance and last ${game.simConfig.markLifetimeTicks / game.simConfig.ticksPerSecond} seconds. When a mark carried by an order is refused, that order is not applied either. Replies give tick, accepted or refusal and recovery guidance, nextCommandTick and only this command's changes. Observe returns paged events.`,
      inputSchema: markShape,
    },
    async (args, extra) => {
      const agentId = session.agentId;
      if (agentId === null) return notJoined(game, nextCommandTick(null));
      const caught = caughtPaths(args);
      const spec = args as { tileX?: number; tileY?: number; words: string[] };
      if (caught.length === 0) caught.push(...missingMarkAxis(spec, ""));
      if (caught.length > 0) return typeError(game, session, "command", caught);
      const config = game.configForAgent(agentId);
      const input: SimInput = { type: "mark", agentId, ...markTileOf(spec), words: clampWords(config, spec.words) };
      return applyCommand(game, agentId, callIdOf(extra), input, (outcome) => commandResult(game, config, outcome, input));
    },
  );

  // Count marks: offered only when this match's rules have them.
  const countRules = game.simConfig.countMarks;
  if (countRules !== undefined) server.registerTool(
    "count_mark",
    {
      description: `Lay a count mark: a verb and a requested whole count of 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}, of free ants; a larger count is refused, not reduced. ${countMarkJobText(game.simConfig)} Re-lay the same verb on the same tile${lineMarksEnabled(game.simConfig) ? " (LINE: the same two ends)" : ""} to change the count; claimed ants stay.${relayLifetimeText(game.simConfig)}${countRules.casteSelection ? ` Optional caste is ${COUNT_CASTES.join(", ")}; omitted means any. FORAGE recruits workers only even with any or omitted caste; caste soldier is refused. Only the chosen caste recruits. Changing caste releases only ants it excludes; keeping or raising the count retains the others.` : ""} ${countRules.placement === "colony_sight" ? `Place it on a whole-number tile currently within ${game.simConfig.sightTiles} tiles of any living ant of your colony${game.simConfig.wordMarksDisabled ? "." : "; word marks still need your own squad ant standing on the tile."}` : "Place it on a tile where one of your squad ants stands."}${lineMarksEnabled(game.simConfig) ? " LINE: both ends must be in reach under that same placement rule, each like a single tile." : ""} Omit both coordinates to use your squad's position, if it has ants. Shares the command allowance; marks last ${game.simConfig.markLifetimeTicks / game.simConfig.ticksPerSecond} seconds. Replies give tick, accepted or refusal, recovery guidance, nextCommandTick and this command's changes.${countRules.reportClaimAvailability ? ` Accepted responses give freeAntsNow and a zero-free-pool explanation; the mark stays to recruit as ants hatch or free up.` : ""} ${countMarkReplyText(game.simConfig)} ${spawnRemoveText(game.simConfig)} Accepted SPAWN replies give spawnPoint {queenId,tileX,tileY} or {queenId,cleared:true}; REMOVE gives removedMark {markId}.${queenBrood === "" ? "" : ` ${queenBrood}`}`,
      inputSchema: {
        tileX: orNull(markTile("column")),
        tileY: orNull(markTile("row")),
        verb: orNull(z.string().describe(`One of ${countMarkVerbs(game.simConfig).join(", ")}. Or SPAWN (set, move or clear a queen's spawn point) or REMOVE (remove your own count mark).`)),
        count: orNull(z.number().optional().describe(`Whole number of ants, 1 or more, at most ${COUNT_MARK_MAX_COUNT_TEXT}; not needed for SPAWN or REMOVE.`)),
        ...(countRules.casteSelection ? { caste: orNull(z.enum(COUNT_CASTES).optional().describe("Which caste to recruit; omitted means any. FORAGE recruits workers only; soldier is refused.")) } : {}),
        ...(lineMarksEnabled(game.simConfig) ? {
          toTileX: orNull(tile("column").optional().describe("LINE only: the second end's whole tile column; other verbs refuse it.")),
          toTileY: orNull(tile("row").optional().describe("LINE only: the second end's whole tile row; other verbs refuse it.")),
        } : {}),
        queenId: orNull(z.number().optional().describe("SPAWN only: the queenId of a live queen you own (observe queens).")),
        markId: orNull(z.number().optional().describe("REMOVE only: the markId of your own count mark (myMarks).")),
      },
    },
    async (args, extra) => {
      const agentId = session.agentId;
      if (agentId === null) return notJoined(game, nextCommandTick(null));
      const caught = caughtPaths(args);
      const spec = args as { tileX?: number; tileY?: number; verb: string; count?: number; caste?: string; toTileX?: number; toTileY?: number; markId?: number; queenId?: number };
      // Rules 27: SPAWN and REMOVE take no count (the input carries 0); every mark verb still needs one.
      const command = caught.length === 0 && SPAWN_REMOVE_VERBS.includes(spec.verb);
      if (caught.length === 0 && spec.count === undefined && !command) caught.push("count");
      if (caught.length === 0) caught.push(...missingMarkAxis(spec, ""));
      if (caught.length > 0) return typeError(game, session, "command", caught);
      const config = game.configForAgent(agentId);
      const input: SimInput = { type: "count_mark", agentId, ...markTileOf(spec), verb: spec.verb.slice(0, 16), count: command ? 0 : spec.count!,
        ...(spec.caste === undefined ? {} : { caste: spec.caste }),
        ...(spec.markId === undefined ? {} : { markId: spec.markId }),
        ...(spec.toTileX === undefined ? {} : { toTileX: spec.toTileX }), ...(spec.toTileY === undefined ? {} : { toTileY: spec.toTileY }),
        ...(spec.queenId === undefined ? {} : { queenId: spec.queenId }) };
      return applyCommand(game, agentId, callIdOf(extra), input, (outcome) => commandResult(game, config, outcome, input));
    },
  );
}
