import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { payload } from "../mcp/replies.js";

/**
 * Seat client 1.0.0 cannot wait out a server handover, so the entry server
 * refuses it on the six calls every seat-client flow starts with (queue_status,
 * read_lobby, locate_match, join_queue, join_lobby, create_lobby), before it can queue,
 * pair, seat or create anything. Every 1.0.0 copy identifies itself in MCP initialize
 * as exactly this clientInfo; later seat-client versions and other MCP clients are
 * answered as before. The match server's join and the HTTP /api route never refuse it.
 */
const REFUSED = { name: "antwars-seat", version: "1.0.0" } as const;

export const UPDATE_SEAT_CLIENT = "update_seat_client";
const HOW_TO_FIX = "Copy the seat client again from origin/main into ./.antwars-seat as packages/antwars-seat/README.md describes, then run your command again.";
/** The seat client shows the top-level or nested message, so it carries the copy instruction itself. */
export const UPDATE_SEAT_CLIENT_MESSAGE = `This server no longer accepts seat client 1.0.0, which cannot wait out a server handover. ${HOW_TO_FIX}`;

/** The account tools that refuse seat client 1.0.0 on the entry server; locate_match is the sixth call. */
export const SEAT_CLIENT_ENTRY_TOOLS: ReadonlySet<string> = new Set(["queue_status", "read_lobby", "join_queue", "join_lobby", "create_lobby"]);

/** True when this session's initialize reported seat client 1.0.0. */
export function refusesSeatClient(server: McpServer): boolean {
  const client = server.server.getClientVersion();
  return client?.name === REFUSED.name && client.version === REFUSED.version;
}

/** The refusal in the account tools' reply family, { error, message }. */
export function accountRefusal(): CallToolResult {
  return payload({ error: UPDATE_SEAT_CLIENT, message: UPDATE_SEAT_CLIENT_MESSAGE }, true);
}

/** The refusal in locate_match's reply family, { error: { code, message, howToFix }, tick }. */
export function locatorRefusal(): CallToolResult {
  return payload({ error: { code: UPDATE_SEAT_CLIENT, message: UPDATE_SEAT_CLIENT_MESSAGE, howToFix: HOW_TO_FIX }, tick: null }, true);
}
