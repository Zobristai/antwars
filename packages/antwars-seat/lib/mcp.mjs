// Raw Streamable-HTTP MCP client over fetch, after deploy/cloud-run/probe.mjs:
// initialize -> notifications/initialized, then Mcp-Session-Id and
// MCP-Protocol-Version on every request; replies may be JSON or SSE.
// No dependencies, so it runs from an empty seat folder.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export const PROTOCOL_VERSION = "2025-06-18";
/**
 * What initialize reports as clientInfo: the seat client's name and its package.json
 * version, so the entry server can tell this copy from 1.0.0, which it refuses.
 */
export const CLIENT_INFO = Object.freeze({ name: "antwars-seat", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version });
/** The tools/call params._meta key carrying the command's call id: one id per command, the same on every send of it. */
export const CALL_ID_META = "antwars/callId";
const REQUEST_TIMEOUT_MS = 30_000;
/** How long one match command rides out a server handover, from its first send. */
export const HANDOVER_RETRY_MS = 60_000;
const RETRY_DELAY_MS = 1_000;
// A handover, seen from here: the retiring server's or Cloud Run's own 503 and 429, a request that gets no
// answer in time, and connections refused or cut while one server replaces another.
const TRANSIENT_STATUSES = new Set([429, 503]);
const TRANSIENT_CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"]);
/** Match-server answers that mean the call was not applied and may be sent again after retryAfterMs. */
const RESEND_CODES = new Set(["call_rate", "not_applied"]);

export class McpHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The opt-in that lets the seat send to a plain-http server that is not this machine. */
export const ALLOW_HTTP_ENV = "ANTWARS_ALLOW_HTTP";

/** True for a hostname that names this machine: localhost, 127.0.0.0/8 or ::1. */
function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The server address the seat may send its key to: https, or plain http to this
 * machine, or plain http anywhere when allowHttp is set. Anything else throws
 * before a request is made. The error names only the address's host.
 */
export function checkServerUrl(url, { allowHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refusing to connect: the server address is not a valid URL.");
  }
  if (parsed.protocol === "https:") return parsed.href;
  if (parsed.protocol === "http:") {
    if (allowHttp || isLoopback(parsed.hostname)) return parsed.href;
    throw new Error(`Refusing to send the seat key over plain http to ${parsed.host}: use an https address, or set ${ALLOW_HTTP_ENV}=1 to allow plain http.`);
  }
  throw new Error(`Refusing to connect to ${parsed.host || "the server"}: only https (or plain http to this machine) is supported.`);
}

/** A 3xx answer: the seat never follows a redirect, so nothing is sent to the address it names. */
function redirectRefused(url, response) {
  const location = response.headers.get("location");
  let target = null;
  try {
    target = location === null ? null : new URL(location, url).host;
  } catch {
    // An unparseable Location names no host.
  }
  const to = target === null ? "" : ` to ${target}`;
  return new McpHttpError(response.status, `Refusing to follow a redirect from ${new URL(url).host}${to} (HTTP ${response.status}): the seat sends its key only to the address it was given. Set the server address to the final https address.`);
}

/** Every complete `data:` payload in an SSE body, joined per frame. */
export function sseMessages(text) {
  const messages = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data.trim() === "") continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A non-JSON frame (keepalive text) carries no reply.
    }
  }
  return messages;
}

/** The JSON-RPC reply with this id from a JSON or SSE response body. */
export function rpcReply(contentType, text, id) {
  const messages = (contentType ?? "").includes("text/event-stream") ? sseMessages(text) : [JSON.parse(text)].flat();
  return messages.find((message) => message && message.id === id && ("result" in message || "error" in message)) ?? null;
}

/** A tool result's data object: structuredContent, else the JSON text content, else { text }. */
export function toolData(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Plain text reply.
  }
  return { text };
}

/** True for a send that failed the way a handover fails: a timeout, or a connection refused or cut. */
function transientFailure(error) {
  if (error?.name === "TimeoutError") return true;
  return [error?.cause, ...(error?.cause?.errors ?? [])].some((cause) => TRANSIENT_CONNECTION_CODES.has(cause?.code));
}

/** The error fetch rejects with when an attempt's timeout fires: what a send the deadline stops reports. */
function deadlineTimeout() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** A refusal code from either reply family: { error: "code" } or { error: { code } }. */
export function errorCode(data) {
  if (!data || data.error === undefined || data.error === null) return null;
  return typeof data.error === "string" ? data.error : (data.error.code ?? "error");
}

/**
 * One MCP endpoint. `session` ({ sessionId, protocolVersion }) may be restored
 * from state so a later process reuses it; onSession persists a new one.
 * When the server forgets the session (HTTP 404), the client initializes
 * again, runs onReinit (a match client re-joins its seat there) and retries
 * the request once.
 * With retryWindowMs (the match client), each command (callTool, listTools)
 * fixes a deadline that far after its first send, and every send inside it,
 * including a reconnect's initialize and re-join, retries 503, 429, timeouts
 * and refused or cut connections until then (see post).
 */
export class McpClient {
  constructor({ url, clock, limiter = async () => {}, session = null, onSession = () => {}, onReinit = async () => {}, log = () => {}, fetchImpl = globalThis.fetch, retryWindowMs = 0, allowHttp = false }) {
    this.url = checkServerUrl(url, { allowHttp });
    this.clock = clock;
    this.limiter = limiter;
    this.session = session;
    this.onSession = onSession;
    this.onReinit = onReinit;
    this.log = log;
    this.fetch = fetchImpl;
    this.nextId = 1;
    this.reinitializing = false;
    this.retryWindowMs = retryWindowMs;
    this.inCommand = false;
    this.deadline = null;
    this.resendAsked = false;
    this.rejoinLoaded = false;
    this.transientMet = false;
  }

  /** One command: its first send fixes the retry deadline; a command run inside it (the re-join's join) shares it. */
  async command(run) {
    if (this.retryWindowMs <= 0 || this.inCommand) return run();
    this.inCommand = true;
    try {
      return await run();
    } finally {
      this.inCommand = false;
      this.deadline = null;
      this.resendAsked = false;
      this.rejoinLoaded = false;
      this.transientMet = false;
    }
  }

  /**
   * The server has asked for the next send (a call_rate, not_applied or
   * lobby_loading resend): wait ms, then send. That one send keeps the answer's
   * own bound, so it is made even past the command's deadline. A
   * lobby_loading answer to a reconnect's re-join also lets the call that
   * completes that reconnect go. Once the command has met a 503, 429, timeout or
   * refused or cut connection, lobby_loading lifts nothing: the 60 s deadline
   * stays, and the wait ends at it, where the call reports the error.
   */
  async resendAfter(ms, { loading = false } = {}) {
    if (this.inCommand && loading && this.transientMet) {
      await this.clock.sleep(Math.max(0, Math.min(ms, this.deadline - this.clock.now())));
      return;
    }
    if (this.inCommand) {
      this.resendAsked = true;
      if (loading && this.reinitializing) this.rejoinLoaded = true;
    }
    await this.clock.sleep(ms);
  }

  /**
   * One HTTP send. Inside a command's retry window a 503, 429, timeout or
   * refused or cut connection is sent again every second while the deadline
   * has not passed; then the last answer or error is reported exactly as
   * without retrying. An attempt times out at min(30 s, time left). Once the
   * deadline has passed (checked after call spacing), nothing more is sent: a
   * retry reports the last answer or error, and a new send (a reconnect's
   * initialize or re-join, or the call after it) fails with fetch's own
   * timeout error. The one exception is a send the server asked for
   * (resendAfter): it keeps that answer's own bound past the deadline,
   * as a single 30 s attempt, as today; the sends after it do not. A lobby_loading
   * answer met after a 503, 429, timeout or refused or cut connection in the
   * same command is no such exception.
   */
  async post(body, { withSession = true } = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (withSession && this.session) {
      headers["mcp-session-id"] = this.session.sessionId;
      headers["mcp-protocol-version"] = this.session.protocolVersion;
    }
    const asked = this.resendAsked;
    this.resendAsked = false;
    let unavailableSince = null;
    let last = null;
    const report = () => {
      if (last.failure !== null) throw last.failure;
      return { response: last.response, text: last.text };
    };
    for (;;) {
      await this.limiter();
      if (this.inCommand && this.deadline === null) this.deadline = this.clock.now() + this.retryWindowMs;
      if (this.deadline !== null && this.clock.now() >= this.deadline) {
        if (last !== null) return report();
        if (!asked) throw deadlineTimeout();
      }
      let response = null;
      let text = null;
      let failure = null;
      try {
        response = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: this.attemptSignal() });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw redirectRefused(this.url, response);
        }
        text = await response.text();
      } catch (error) {
        if (!transientFailure(error)) throw error;
        failure = error;
      }
      if (failure === null && !TRANSIENT_STATUSES.has(response.status)) {
        if (unavailableSince !== null) this.log("server_available", { method: body.method, waitedMs: this.clock.now() - unavailableSince });
        return { response, text };
      }
      last = { response, text, failure };
      if (this.inCommand) this.transientMet = true;
      if (this.deadline === null || this.clock.now() >= this.deadline) return report();
      if (unavailableSince === null) {
        unavailableSince = this.clock.now();
        this.log("server_unavailable", { method: body.method, reason: failure === null ? `HTTP ${response.status}` : (failure.cause?.code ?? failure.name) });
      }
      await this.clock.sleep(Math.min(RETRY_DELAY_MS, this.deadline - this.clock.now()));
    }
  }

  attemptSignal() {
    const left = this.deadline === null ? 0 : Math.ceil(this.deadline - this.clock.now());
    const ms = left > 0 ? Math.min(REQUEST_TIMEOUT_MS, left) : REQUEST_TIMEOUT_MS;
    return this.clock.timeout ? this.clock.timeout(ms) : AbortSignal.timeout(ms);
  }

  async initialize() {
    const id = this.nextId++;
    const { response, text } = await this.post({ jsonrpc: "2.0", id, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, { withSession: false });
    const sessionId = response.headers.get("mcp-session-id");
    if (!response.ok || sessionId === null) throw new McpHttpError(response.status, `initialize failed: HTTP ${response.status}`);
    const reply = rpcReply(response.headers.get("content-type"), text, id);
    this.session = { sessionId, protocolVersion: reply?.result?.protocolVersion ?? PROTOCOL_VERSION };
    const { response: ack } = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (!ack.ok && ack.status !== 202) throw new McpHttpError(ack.status, `initialized notification failed: HTTP ${ack.status}`);
    this.onSession(this.session);
    return this.session;
  }

  async request(method, params, { recover = true } = {}) {
    if (!this.session) await this.initialize();
    const id = this.nextId++;
    const { response, text } = await this.post({ jsonrpc: "2.0", id, method, params });
    if (response.status === 404 && recover && !this.reinitializing) {
      this.log("session_gone", { method });
      this.reinitializing = true;
      this.rejoinLoaded = false;
      try {
        this.session = null;
        await this.initialize();
        await this.onReinit(this);
      } finally {
        this.reinitializing = false;
      }
      // A loading re-join lets this call go past the deadline, unless the command has also met a transient failure.
      if (this.rejoinLoaded && !this.transientMet) this.resendAsked = true;
      this.rejoinLoaded = false;
      return this.request(method, params, { recover: false });
    }
    if (!response.ok) throw new McpHttpError(response.status, `${method} failed: HTTP ${response.status}`);
    const reply = rpcReply(response.headers.get("content-type"), text, id);
    if (reply === null) throw new Error(`${method}: no JSON-RPC reply in response`);
    if (reply.error) throw new Error(`${method}: JSON-RPC error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  /**
   * One tool call: one command. Its call id is fixed here and sent unchanged on
   * every send of it (transient retry, call_rate and not_applied resends, 404
   * recovery), so a send the server already applied takes no second effect. A
   * call_rate refusal, or a not_applied answer (a handover stopped the server
   * before it applied the call), waits retryAfterMs (1 s if absent) and sends the
   * call again, up to 5 times, inside the command's retry window. Returns { ok, data }.
   */
  callTool(name, args = {}, options = {}) {
    return this.command(() => this.#callTool(name, args, options));
  }

  async #callTool(name, args, { recover = true }) {
    const params = { name, arguments: args, _meta: { [CALL_ID_META]: randomUUID() } };
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.request("tools/call", params, { recover });
      const data = toolData(result);
      const ok = result?.isError !== true && errorCode(data) === null;
      if (!ok && RESEND_CODES.has(errorCode(data)) && attempt < 5) {
        await this.resendAfter(Number(data.retryAfterMs) > 0 ? Number(data.retryAfterMs) : 1000);
        continue;
      }
      return { ok, data };
    }
  }

  async listTools() {
    const result = await this.command(() => this.request("tools/list", {}));
    return result?.tools ?? [];
  }
}
