/// <reference types="node" />
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isJsonContentType } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import { isInitializeRequest, isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Game } from "./game.js";
import { sessionExpiryText } from "./config.js";
import { FIRESTORE_RPC_TIMEOUT_MS } from "../store/firestore.js";
import { clientSource } from "../server/clientSource.js";
import { registerTools, type SessionState } from "./tools.js";
import { createAdmissionCap } from "../net/admission.js";

/** Largest request body accepted, so one client cannot buffer unbounded memory. */
export const MAX_BODY_BYTES = 1024 * 1024;

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly state: SessionState;
  lastSeen: number;
  /**
   * The account identity id a successful keyed call proved while shielded
   * places (overall and for that identity) were free; such a session is never
   * evicted for room. Null when unprotected. The identity, not the key, so a
   * rotated key still counts against the same identity's share.
   */
  protectedBy: string | null;
  /**
   * Calls in flight that hold a shielded place (holdForCall), so the call cannot be evicted mid-way:
   * each lasts until its response closes or the call throws, and never past its deadline unless pinned.
   */
  readonly holds: Set<Hold>;
  /**
   * The key this session's latest key-issuing call committed but could not deliver, as its verifier, for
   * recover_key; null when none. One-shot: cleared when recovered, when a later key-issuing call's reply is
   * delivered, and with the session. A later undelivered key replaces it.
   */
  lostKey: LostKey | null;
}

/**
 * A committed key whose reply never finished writing, held only as what proves it: never the key itself.
 */
export interface LostKey {
  /** The issued key's verifier (SHA-256, lowercase hex), as the store keeps it. */
  readonly verifier: string;
  /** SHA-256 of the key argument the issuing call presented, or null when it presented none (a new username). */
  readonly proof: string | null;
}

/**
 * One request's shielded place. It is on its session's holds only while it shields the session; a
 * pinned hold no longer lapses. It ends, for good, when its response closes.
 */
interface Hold {
  readonly until: number;
  pinned: boolean;
  ended: boolean;
  /** The key its key-issuing call committed, decided at the response's close: delivered, or lost (Session.lostKey). */
  issued?: LostKey;
}

/** The hold of the HTTP request whose handling is running, so a call can check its own hold and no other. */
const requestHold = new AsyncLocalStorage<Hold | undefined>();

/** What a key-issuing call checks as the last step before its commit. */
export interface KeyIssuingHold {
  /**
   * Checked at the commit point: true when the session is joined to a seat or the call's own request
   * holds a live place, and its response is still open. A held place is then pinned, so it cannot
   * lapse or be evicted while the commit is in flight and until the reply, nor an unjoined session be
   * swept (a joined session keeps its idle expiry); the pin ends when the response closes. It is also
   * false unless more than the store's RPC timeout remains of the idle window the request reset, so
   * the commit ends before that window does. False aborts the commit: no key is issued.
   */
  mayCommit(): boolean;
  /**
   * The end of the idle window the request reset (epoch ms, the handler's clock, which in service is
   * the store's): the store launches the commit only before it and cuts the commit off at it.
   */
  readonly commitBy: number;
  /**
   * Called once the call's commit has issued a key, before its reply. If the call's response has already closed,
   * or closes before the reply finishes writing, the key is kept on the session as lost (recover_key); once the
   * reply has finished writing, any lost key the session held is cleared.
   */
  issued(lost: LostKey): void;
}

/**
 * The account calls that issue a one-time key, held on every server so the reply carrying the key
 * cannot be lost to an eviction mid-call.
 */
export const KEY_ISSUING_TOOLS: ReadonlySet<string> = new Set(["claim_username", "rotate_key", "create_handle", "reissue_handle_key", "recover_key"]);
/** On a server hosting matches, the seat join is held too; the entry service registers no join. */
const MATCH_HOST_HELD_TOOLS: ReadonlySet<string> = new Set(["join", ...KEY_ISSUING_TOOLS]);

/** Whether a JSON-RPC body (one message or a batch) calls one of these tools. */
function callsTool(body: unknown, names: ReadonlySet<string>): boolean {
  return (Array.isArray(body) ? body : [body]).some((message: unknown) => {
    if (typeof message !== "object" || message === null) return false;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== "tools/call" || typeof params !== "object" || params === null) return false;
    const name = (params as { name?: unknown }).name;
    return typeof name === "string" && names.has(name);
  });
}

/** What extraTools may do to the session whose server it registers tools on. */
export interface SessionAccess {
  /**
   * Whether protect could grant now: the entry service, a session still open
   * and unprotected, and room in maxProtectedSessions. Lets the caller skip
   * resolving the key's identity when nothing could come of it.
   */
  mayProtect(): boolean;
  /**
   * Mark the session protected for the account identity id one of its calls
   * proved. Granted only when mayProtect() and while that identity protects
   * fewer than maxProtectedSessionsPerIdentity sessions; idempotent.
   */
  protect(identityId: string): void;
  /**
   * For the key-issuing call now running on this session: its guard while the session is joined to a
   * seat or the call's own request holds a live place; undefined when that request got none (the
   * shielded share was full) or its hold has ended or lapsed. A hold on another request of the same
   * session never counts. The same on every server.
   */
  keyIssuingHold(): KeyIssuingHold | undefined;
  /** The key this session's latest key-issuing call committed but could not deliver, if one is still pending. */
  lostKey(): LostKey | undefined;
  /** Clear that pending lost key, only if it is still this one. */
  clearLostKey(lost: LostKey): void;
}

export interface McpHandler {
  /** Serve one request addressed to /mcp; the server member mounts it there. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Close and remove sessions idle longer than the configured timeout. Also runs on a timer. */
  sweep(): Promise<void>;
  hasSession(sessionId: string): boolean;
  readonly sessionCount: number;
  /** Bodies being read now for requests not from a joined seat. */
  readonly unadmittedBodyReads: number;
  /** Close every session and stop the sweep timer. */
  close(): Promise<void>;
}

function jsonRpcError(res: ServerResponse, status: number, message: string, code = -32000, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Why the SDK transport would reject this initialize before creating a session,
 * with its status, code and message, or undefined when it would accept it. The
 * same checks the transport runs (Accept, Content-Type, JSON-RPC shape), made
 * before any eviction so only a valid initialize can evict a session.
 * The caller has already checked isInitializeRequest, so the body is one message.
 */
export function initializeRejection(req: IncomingMessage, body: unknown): { status: number; code: number; message: string } | undefined {
  const accept = req.headers.accept;
  if (accept === undefined || !accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return { status: 406, code: -32000, message: "Not Acceptable: Client must accept both application/json and text/event-stream" };
  }
  if (!isJsonContentType(req.headers["content-type"])) {
    return { status: 415, code: -32000, message: "Unsupported Media Type: Content-Type must be application/json" };
  }
  if (!isJSONRPCRequest(body)) return { status: 400, code: -32700, message: "Parse error: Invalid JSON-RPC message" };
  return undefined;
}

/** A request body that did not finish arriving within its read deadline. */
export class BodyTimeoutError extends Error {
  constructor() {
    super("request body read deadline passed");
    this.name = "BodyTimeoutError";
  }
}

/**
 * The body as JSON, undefined when empty; throws RangeError when too large, SyntaxError when not
 * JSON, and, with a deadline, BodyTimeoutError when the whole body has not arrived within deadlineMs.
 * The size is the bytes actually read, never a Content-Length header: a chunked body with no
 * Content-Length is refused the moment it passes maxBytes, without waiting for it to end.
 * A body past its deadline is left unread, not destroyed, so the caller can still answer; it should
 * close the connection with that answer.
 */
export async function readBody(req: IncomingMessage, deadlineMs?: number, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reading = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let timer: NodeJS.Timeout | undefined;
  const expired = deadlineMs === undefined ? null : new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeoutError()), deadlineMs);
  });
  try {
    for (;;) {
      const next = expired === null ? await reading.next() : await Promise.race([reading.next(), expired]);
      if (next.done === true) break;
      size += next.value.length;
      if (size > maxBytes) {
        // As a for-await loop leaving early does: the rest of the body is discarded.
        await reading.return?.();
        throw new RangeError("body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Streamable HTTP MCP on plain node:http: stateful
 * sessions, one McpServer per session, one session per agent. The app keeps
 * the session map, answers unknown or missing session ids itself
 * and expires idle sessions. Ending a session never touches the
 * agent: its squad timer is the sim's.
 *
 * At the open-session cap a new initialize evicts the oldest session that is
 * neither joined to a seat nor shielded (protected, or with a seat join or a
 * key-issuing call in flight), so sessions that never join cannot
 * hold the cap however often they send requests. Creation order
 * decides "oldest": requests never change it. Only when every open session is
 * joined or protected is the initialize refused. An initialize the transport
 * would reject is answered first and evicts nothing. Besides mcp-session-id, the
 * only header an admission decision reads is X-Forwarded-For, through
 * clientSource and only with perSourceInitializeLimit (match slots): each client
 * source may evict at most initializeBurstPerSource sessions at once, refilled
 * one per initializeRefillMsPerSource, and over that is refused 429 with nothing
 * evicted. Accept and Content-Type are checked only for validity, as
 * the transport does.
 */
export function createMcpHandler(
  game: Game,
  /**
   * extraTools registers tools beside the match tools on each session's server. perSourceInitializeLimit
   * bounds how many sessions one client source may evict at the cap; a match slot sets it. localBriefing
   * marks a server that serves no accounts, whose briefings omit account and lobby text; it defaults to off.
   */
  options: { now?: () => number; gameplay?: boolean; localBriefing?: boolean; perSourceInitializeLimit?: boolean; extraTools?: (server: McpServer, session: SessionAccess) => void } = {},
): McpHandler {
  const { maxOpenSessions, maxProtectedSessions } = game.mcpConfig;
  // Fail at startup: with the shielded share at or above the cap, every place could be shielded and admission would close.
  if (!(maxProtectedSessions < maxOpenSessions)) {
    throw new Error(`maxProtectedSessions (${maxProtectedSessions}) must be less than maxOpenSessions (${maxOpenSessions})`);
  }
  // Fail at startup: a key-issuing commit needs the store's RPC bound left inside the idle window, or no key could ever be issued.
  if (!(game.mcpConfig.sessionIdleMs > FIRESTORE_RPC_TIMEOUT_MS)) {
    throw new Error(`sessionIdleMs (${game.mcpConfig.sessionIdleMs}) must exceed the store's RPC timeout (${FIRESTORE_RPC_TIMEOUT_MS})`);
  }
  const now = options.now ?? Date.now;
  const unknownSession = `Unknown session. ${sessionExpiryText(game.mcpConfig)}`;
  const sessions = new Map<string, Session>();
  /** Bodies being read at once for requests not from a joined seat, overall and per source. */
  const bodyReads = createAdmissionCap("mcp body reads", { max: game.mcpConfig.maxUnadmittedBodies, perSource: game.mcpConfig.maxUnadmittedBodiesPerSource });
  /** Initializes admitted but not yet stored as sessions; they count against the cap so concurrent initializes cannot overshoot it. */
  let opening = 0;
  /** Each client source's eviction allowance (a token bucket); a full one is not kept. Keys are client addresses: never logged. */
  const allowances = new Map<string, { tokens: number; at: number }>();
  /** The key for requests with no client hop: never a valid address, so it collides with none. */
  const NO_SOURCE = "missing";

  /** A source's allowance refilled to now. */
  function allowanceOf(source: string): { tokens: number; at: number } {
    const { initializeBurstPerSource: burst, initializeRefillMsPerSource: refillMs } = game.mcpConfig;
    const t = now();
    const a = allowances.get(source) ?? { tokens: burst, at: t };
    a.tokens = Math.min(burst, a.tokens + Math.max(0, t - a.at) / refillMs);
    a.at = t;
    return a;
  }

  /** Charge one eviction to this request's client source; false, charging nothing, when its allowance is spent. */
  function chargeEviction(req: IncomingMessage): boolean {
    const source = clientSource(req.headers) ?? NO_SOURCE;
    const a = allowanceOf(source);
    if (a.tokens < 1) return false;
    a.tokens -= 1;
    allowances.set(source, a);
    return true;
  }

  /** A hold still in place on its session: pinned, or its deadline has not passed. */
  const holdLive = (s: Session, hold: Hold): boolean => s.holds.has(hold) && (hold.pinned || hold.until > now());

  /** Whether a call in flight holds a place for this session. */
  function liveHold(s: Session): boolean {
    for (const hold of s.holds) if (holdLive(s, hold)) return true;
    return false;
  }

  /** Shielded from eviction: protected, or holding a live place for a call in flight. */
  const shielded = (s: Session): boolean => s.protectedBy !== null || liveHold(s);

  /** The oldest stored session that is neither joined nor shielded; the map keeps creation order. */
  function oldestEvictable(): [string, Session] | undefined {
    for (const entry of sessions) {
      if (entry[1].state.agentId === null && !shielded(entry[1])) return entry;
    }
    return undefined;
  }

  /** A session already shielded keeps its place; another is shielded only while fewer than maxProtectedSessions are. */
  function mayShield(session: Session): boolean {
    if (shielded(session)) return true;
    let count = 0;
    for (const s of sessions.values()) if (shielded(s)) count += 1;
    return count < game.mcpConfig.maxProtectedSessions;
  }

  /**
   * Shield an unjoined session while one call is in flight, within the shielded share. Returns the
   * release, which runs at most once: on the response's close, which follows every end of the
   * response (a reply, an error result, a 500 for a thrown exception, a client disconnect or an
   * aborted request), or directly when handling the request throws. The hold also lapses at the
   * idle expiry (sessionIdleMs), unless a key-issuing commit pinned it: a stalled call never keeps a
   * shielded place longer than an idle session keeps its slot, even when the client keeps the session
   * alive with other requests. A joined session, or one finding the share full, takes no place now;
   * its request still carries the hold, so a key-issuing call can tell its own response has closed.
   */
  function holdForCall(session: Session, res: ServerResponse): { hold: Hold; release: () => void } {
    // The deadline is the end of the idle window this request itself just reset.
    const hold: Hold = { until: session.lastSeen + game.mcpConfig.sessionIdleMs, pinned: false, ended: false };
    if (session.state.agentId === null && mayShield(session)) session.holds.add(hold);
    const release = (): void => {
      if (hold.ended) return;
      hold.ended = true;
      session.holds.delete(hold);
      // A key this call issued: delivered only when its reply finished writing; otherwise it is the session's lost key.
      if (hold.issued !== undefined) session.lostKey = res.writableFinished ? null : hold.issued;
    };
    res.once("close", release);
    return { hold, release };
  }

  /** How many open sessions this account identity protects. */
  function protectedFor(identityId: string): number {
    let count = 0;
    for (const s of sessions.values()) if (s.protectedBy === identityId) count += 1;
    return count;
  }

  async function open(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    // Validated before the cap: an initialize that would be rejected must not evict anyone.
    const rejection = initializeRejection(req, body);
    if (rejection !== undefined) {
      jsonRpcError(res, rejection.status, rejection.message, rejection.code);
      return;
    }
    if (sessions.size + opening >= game.mcpConfig.maxOpenSessions) {
      const evictable = oldestEvictable();
      if (evictable === undefined) {
        jsonRpcError(res, 503, "Server is full: too many open sessions. Retry later.");
        return;
      }
      // Only an initialize that would evict is charged; over its source's allowance it evicts nothing.
      if (options.perSourceInitializeLimit === true && !chargeEviction(req)) {
        jsonRpcError(res, 429, "Too many new sessions from this client. Retry later.");
        return;
      }
      // Removed before any await, so concurrent initializes cannot overshoot the cap; its own onclose delete is then a no-op.
      sessions.delete(evictable[0]);
      void closeSession(evictable[1]);
    }
    // The in-flight slot is released exactly once: when the session is stored, or on any other exit.
    opening += 1;
    let inFlight = true;
    const release = (): void => {
      if (inFlight) {
        inFlight = false;
        opening -= 1;
      }
    };
    try {
      const state: SessionState = { agentId: null };
      let stored: Session | undefined;
      const server = new McpServer({ name: "antwars", version: "0.1.0" });
      registerTools(server, game, state, { gameplay: options.gameplay, localBriefing: options.localBriefing });
      const mayProtect = (): boolean =>
        // Key protection serves waits on the entry service only (no gameplay there). A server hosting
        // matches keeps its whole shielded share for seat joins in flight, which key holders cannot fill.
        options.gameplay === false &&
        // Only a session still open can be protected, and never past the protected share.
        stored !== undefined && stored.protectedBy === null && transport.sessionId !== undefined &&
        sessions.get(transport.sessionId) === stored && mayShield(stored);
      options.extraTools?.(server, {
        mayProtect,
        protect(identityId) {
          // Never past one identity's share either, counted by identity so rotating a key does not reset it.
          if (mayProtect() && protectedFor(identityId) < game.mcpConfig.maxProtectedSessionsPerIdentity) stored!.protectedBy = identityId;
        },
        lostKey: () => stored?.lostKey ?? undefined,
        clearLostKey(lost) {
          if (stored !== undefined && stored.lostKey === lost) stored.lostKey = null;
        },
        keyIssuingHold() {
          const session = stored;
          if (session === undefined) return undefined;
          const own = requestHold.getStore();
          // Joined, or this request's own live place; another request's hold never counts.
          const held = (): boolean => own !== undefined && !own.ended && (session.state.agentId !== null || holdLive(session, own));
          if (!held()) return undefined;
          return {
            commitBy: own!.until,
            mayCommit() {
              if (!held()) return false;
              // The commit RPC must end inside the idle window the call reset: it is bounded by the store's
              // RPC timeout, and every retried attempt asks again, so no commit outlasts that window.
              if (!(own!.until - now() > FIRESTORE_RPC_TIMEOUT_MS)) return false;
              // A joined seat's call holds no place (it is never evicted); a held call's place is pinned.
              own!.pinned = true;
              return true;
            },
            issued(lost) {
              // Its response already closed: the reply cannot be written, so the key is lost now.
              if (own!.ended) session.lostKey = lost;
              else own!.issued = lost;
            },
          };
        },
      });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          release();
          stored = { transport, server, state, lastSeen: now(), protectedBy: null, holds: new Set(), lostKey: null };
          sessions.set(id, stored);
        },
      });
      transport.onclose = () => {
        if (stored !== undefined) stored.lostKey = null;
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers["mcp-session-id"];
    const sid = typeof header === "string" ? header : undefined;
    const session = sid === undefined ? undefined : sessions.get(sid);
    try {
      if (req.method === "POST") {
        // A joined seat's bodies are never counted; every other body being read holds a place,
        // taken before the read and given back once the body is read or abandoned.
        const joined = session !== undefined && session.state.agentId !== null;
        const reading = joined ? undefined : bodyReads.take(clientSource(req.headers));
        if (reading === null) {
          // Refused before any of the body is read; closing the connection discards the rest unread.
          jsonRpcError(res, 503, "Server busy: too many requests being read. Retry shortly.", -32000, { "retry-after": "1", connection: "close" });
          return;
        }
        let body: unknown;
        try {
          body = await readBody(req, game.mcpConfig.bodyReadMs);
        } catch (err) {
          if (err instanceof BodyTimeoutError) jsonRpcError(res, 408, "Request body not received in time", -32000, { connection: "close" });
          else jsonRpcError(res, err instanceof RangeError ? 413 : 400, err instanceof RangeError ? "Request body too large" : "Parse error: body is not JSON");
          return;
        } finally {
          reading?.();
        }
        if (session !== undefined) {
          session.lastSeen = now();
          // Only a server hosting matches registers join; the entry service never shields a join call.
          // Key-issuing calls are held on every server, under one rule: no hold, no key.
          const held = options.gameplay === false ? KEY_ISSUING_TOOLS : MATCH_HOST_HELD_TOOLS;
          const taken = callsTool(body, held) ? holdForCall(session, res) : undefined;
          try {
            // The request's own hold travels with its handling, so its calls check that hold and no other.
            await requestHold.run(taken?.hold, () => session.transport.handleRequest(req, res, body));
          } catch (err) {
            taken?.release();
            throw err;
          }
        } else if (sid === undefined && isInitializeRequest(body)) {
          await open(req, res, body);
        } else {
          jsonRpcError(res, sid === undefined ? 400 : 404, sid === undefined ? "Missing session id" : unknownSession);
        }
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        if (session === undefined) {
          jsonRpcError(res, sid === undefined ? 400 : 404, sid === undefined ? "Missing session id" : unknownSession);
          return;
        }
        session.lastSeen = now();
        await session.transport.handleRequest(req, res);
        return;
      }
      res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
    } catch (err) {
      // Method, route class and cause only: never the URL, which can carry a seat token or a query.
      const routeClass = (req.url ?? "").startsWith("/mcp/") ? "/mcp/:seat" : "/mcp";
      console.error(`antwar 500 ${req.method} ${routeClass}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  /** Close one session; a failure is logged, never thrown, so it cannot reject a sweep or close nor crash the server. */
  async function closeSession(s: Session): Promise<void> {
    try {
      await s.transport.close();
    } catch (err) {
      // Cause only: the session id is a bearer credential for that session.
      console.error(`antwar mcp session close failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  async function sweep(): Promise<void> {
    const cutoff = now() - game.mcpConfig.sessionIdleMs;
    // An unjoined session holding a place (a pinned key-issuing commit) is not closed under its call.
    // A joined session keeps its idle expiry whatever it holds.
    const idle = [...sessions.values()].filter((s) => s.lastSeen < cutoff && (s.state.agentId !== null || !liveHold(s)));
    // An allowance refilled to the burst is the same as none.
    for (const source of allowances.keys()) {
      if (allowanceOf(source).tokens >= game.mcpConfig.initializeBurstPerSource) allowances.delete(source);
    }
    await Promise.all(idle.map(closeSession));
  }

  const timer = setInterval(() => void sweep(), game.mcpConfig.sessionSweepMs);
  timer.unref();

  return {
    handle,
    sweep,
    hasSession: (id) => sessions.has(id),
    get sessionCount() {
      return sessions.size;
    },
    get unadmittedBodyReads() {
      return bodyReads.open;
    },
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map(closeSession));
    },
  };
}
