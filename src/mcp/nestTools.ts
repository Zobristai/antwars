import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Game, NestPickOutcome } from "./game.js";
import { payload } from "./replies.js";

/** foundingBriefed: the same reply's briefing already states that starting queens do not count toward founding prices. */
function windowRules(required: boolean, foundingBriefed: boolean): string {
  return "Call pick_nest {tileX,tileY} before closesAt. Whole tiles in your team's half-open box: a mirrored full-height strip in each colony's back quarter (smaller historical boxes). Water, rock, food and teammates' picks are refused. No nest-spacing rule. A legal repick replaces yours; refusal keeps it. "
    + (required
      ? "In index matches every seat must pick before closesAt: any missing pick ends the match as not played, with no rating change and no default nests. "
      : "Unpicked seats get distinct legal defaults, nearest the default nest first, ties by row then column from your colony's back edge. ")
    + `No ticks run in this 120-second window. Only teammates see picks; outsiders see finalized nests on the ${required ? "feed" : "delayed feed"} or through normal ant sight after play starts.${foundingBriefed ? "" : " Starting queens never raise founding prices."}`;
}

/** Only the bound seated agent's team. No identity keys, opponent picks or defaults. */
export function nestFields(game: Game, agentId: string | null, includeTerrain = false, foundingBriefed = false): Record<string, unknown> {
  const selection = agentId === null ? null : game.nestSelection(agentId, includeTerrain);
  return selection === null ? {} : { nestSelection: { ...selection, closesAt: new Date(selection.closesAt).toISOString(),
    rules: windowRules(selection.required, foundingBriefed) + (selection.terrain === undefined ? "" : " Terrain: join/observe nestSelection.terrain; also check teammates' picks.") } };
}

const REFUSALS: Record<Extract<NestPickOutcome, { ok: false }>["reason"], [string, string]> = {
  not_seated: ["This session has no seat in this lobby.", "Join this slot with your seated identity key first."],
  window_closed: ["The nest-pick window is not open.", "Picks are accepted only during your lobby's 120-second window; call observe for match timing."],
  invalid_tile: ["A nest needs whole-number tileX and tileY coordinates.", "Send pick_nest with two whole-number tile coordinates inside your team's reported start area (a full-height back-quarter strip in new matches)."],
  outside_box: ["That tile is outside your team's start area (a full-height back-quarter strip in new matches).", "Choose x from box.x through box.x+box.width-1, and y from box.y through box.y+box.height-1."],
  water: ["That tile is water.", "Choose a land tile inside your team's reported start area."],
  rock: ["That tile contains rock.", "Choose a tile without rock inside your team's reported start area."],
  food: ["That tile contains food.", "Choose a tile without food inside your team's reported start area."],
  occupied: ["A teammate already picked that tile.", "Choose another tile; adjacent starting nests are allowed."],
  call_rate: ["Too many calls from this seat.", "Wait for retryAfterMs before retrying."],
  match_not_played: ["This match was not played.", "Join a new lobby; no result or rating is awarded for this match."],
};

/** Bound diagnostics before serializing: input may be arbitrarily large or nested. */
function receivedCoordinate(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 64)) + (value.length > 64 ? "…" : "");
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "[array]" : "{object}";
}

/** The session's existing identity binding is the sole authority for a pick. */
export function registerNestTool(server: McpServer, game: Game, session: { agentId: string | null }): void {
  if (game.slot === undefined) return;
  server.registerTool("pick_nest", {
    description: "Pick or replace your own queen's starting nest during your lobby's fixed 120-second window. New matches allow the full-height back-quarter strip on your colony's side; use your reported half-open box bounds. Join with your identity key first. In index matches every seat must pick or the match is not played, with no rating change; other modes keep default nests for unpicked seats. In ranked matches a seat that has not joined the match by the idle limit, counted from match start, ends it abandoned, with no rating change. Only teammates see current picks. Refusals keep your earlier pick. Shares your seat's call-rate limit; spends no food or in-match command allowance.",
    inputSchema: {
      tileX: z.unknown().optional().describe("Whole-number tile column in your colony's back quarter for new matches; use the reported box.x and box.width bounds."),
      tileY: z.unknown().optional().describe("Whole-number tile row across the full map height for new matches; use the reported box.y and box.height bounds."),
    },
  }, ({ tileX, tileY }) => {
    const result = game.pickNest(session.agentId ?? "", typeof tileX === "number" ? tileX : Number.NaN, typeof tileY === "number" ? tileY : Number.NaN);
    const selection = nestFields(game, session.agentId);
    if (result.ok) return payload({ accepted: true, ...selection });
    const [message, howToFix] = REFUSALS[result.reason];
    return payload({ error: { code: result.reason === "call_rate" || result.reason === "match_not_played" ? result.reason : `nest_${result.reason}`, message: result.reason === "invalid_tile"
        ? `${message} Received tileX=${receivedCoordinate(tileX)}, tileY=${receivedCoordinate(tileY)}.` : message, howToFix },
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }), ...selection }, true);
  });
}
