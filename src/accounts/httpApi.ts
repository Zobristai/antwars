/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_MCP_CONFIG } from "../mcp/config.js";
import { BodyTimeoutError, readBody } from "../mcp/http.js";
import { createAdmissionCap } from "../net/admission.js";
import { clientSource } from "../server/clientSource.js";
import { ACCOUNT_OPERATIONS, type AccountStores } from "./service.js";

const OPERATIONS = new Map(ACCOUNT_OPERATIONS.map((op) => [op.name, op]));

/**
 * Largest /api request body, in bytes actually read. The largest body any schema-valid
 * call can send is about 6 KB (leaderboard, a 1,000-character cursor with every character escaped);
 * real bodies are under 1 KB. A test keeps every operation's largest body within half of this.
 */
export const API_MAX_BODY_BYTES = 16 * 1024;

/**
 * How /api reads bodies: the MCP body deadline, and its own count of bodies being read at
 * once, overall and per clientSource, apart from MCP's so an /api flood cannot delay MCP joins.
 */
export interface AccountApiOptions {
  /** Longest a body may take to arrive; past it the request is answered 408 and its connection closed. */
  readonly bodyReadMs: number;
  /** Most /api bodies read at once on this server; past it a request gets a retryable 503 unread. */
  readonly maxBodies: number;
  /** Most of those one source (clientSource) has in flight at once. */
  readonly maxBodiesPerSource: number;
}

/** The same values as MCP's: 10 s, 128 at once, 4 per source. */
export const DEFAULT_ACCOUNT_API_OPTIONS: AccountApiOptions = {
  bodyReadMs: DEFAULT_MCP_CONFIG.bodyReadMs,
  maxBodies: DEFAULT_MCP_CONFIG.maxUnadmittedBodies,
  maxBodiesPerSource: DEFAULT_MCP_CONFIG.maxUnadmittedBodiesPerSource,
};

export interface AccountApi {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** /api bodies being read now. */
  readonly bodyReads: number;
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * POST /api/<operation> with a JSON object body: the same operations, inputs and
 * replies as the MCP tools of that name. Keys travel only in bodies, never URLs.
 * A malformed or oversized body is answered without logging the parser's message,
 * which can quote the body. A store failure propagates to the server's 500
 * handler, which logs the route class and cause, never the request.
 *
 * A body is read only while it holds a place in the /api body-read cap, and is refused 408 past
 * the read deadline and 413 past API_MAX_BODY_BYTES read. Each refusal closes the
 * connection, so the unread rest of the body is never drained.
 */
export function createAccountApi(stores: AccountStores, options: AccountApiOptions = DEFAULT_ACCOUNT_API_OPTIONS): AccountApi {
  const bodyReads = createAdmissionCap("api body reads", { max: options.maxBodies, perSource: options.maxBodiesPerSource });
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const op = OPERATIONS.get(path.slice("/api/".length));
    if (!path.startsWith("/api/") || op === undefined) return reply(res, 404, { error: "no_such_operation", message: "Unknown API operation." });
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return reply(res, 405, { error: "method_not_allowed", message: "Use POST with a JSON body." });
    }
    // The place is taken before any of the body is read and given back once it is read or abandoned.
    const reading = bodyReads.take(clientSource(req.headers));
    if (reading === null) {
      return reply(res, 503, { error: "server_busy", message: "Too many requests being read. Retry shortly." }, { "retry-after": "1", connection: "close" });
    }
    let body: unknown;
    try {
      body = await readBody(req, options.bodyReadMs, API_MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTimeoutError) return reply(res, 408, { error: "body_timeout", message: "Request body not received in time." }, { connection: "close" });
      return err instanceof RangeError
        ? reply(res, 413, { error: "body_too_large", message: "Request body too large." }, { connection: "close" })
        : reply(res, 400, { error: "bad_json", message: "The body is not JSON." });
    } finally {
      reading();
    }
    const parsed = op.input.safeParse(body ?? {});
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))].join(", ");
      return reply(res, 400, { error: "bad_arguments", message: `Invalid arguments: ${fields}.` });
    }
    const result = await op.run(stores, parsed.data, req.headers);
    reply(res, result.ok ? 200 : result.status, result.body);
  };
  return Object.defineProperty(handle, "bodyReads", { get: () => bodyReads.open }) as AccountApi;
}
