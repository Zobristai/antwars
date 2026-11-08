// Raw Streamable-HTTP MCP client over fetch, after deploy/cloud-run/probe.mjs:
// initialize -> notifications/initialized, then Mcp-Session-Id and
// MCP-Protocol-Version on every request; replies may be JSON or SSE.
// No dependencies, so it runs from an empty seat folder.

export const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 30_000;

export class McpHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
 */
export class McpClient {
  constructor({ url, clock, limiter = async () => {}, session = null, onSession = () => {}, onReinit = async () => {}, log = () => {}, fetchImpl = globalThis.fetch }) {
    this.url = url;
    this.clock = clock;
    this.limiter = limiter;
    this.session = session;
    this.onSession = onSession;
    this.onReinit = onReinit;
    this.log = log;
    this.fetch = fetchImpl;
    this.nextId = 1;
    this.reinitializing = false;
  }

  async post(body, { withSession = true } = {}) {
    await this.limiter();
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (withSession && this.session) {
      headers["mcp-session-id"] = this.session.sessionId;
      headers["mcp-protocol-version"] = this.session.protocolVersion;
    }
    const response = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    return { response, text };
  }

  async initialize() {
    const id = this.nextId++;
    const { response, text } = await this.post({ jsonrpc: "2.0", id, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "antwars-seat", version: "1.0.0" } } }, { withSession: false });
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
      try {
        this.session = null;
        await this.initialize();
        await this.onReinit(this);
      } finally {
        this.reinitializing = false;
      }
      return this.request(method, params, { recover: false });
    }
    if (!response.ok) throw new McpHttpError(response.status, `${method} failed: HTTP ${response.status}`);
    const reply = rpcReply(response.headers.get("content-type"), text, id);
    if (reply === null) throw new Error(`${method}: no JSON-RPC reply in response`);
    if (reply.error) throw new Error(`${method}: JSON-RPC error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  /** One tool call. A call_rate refusal waits retryAfterMs and retries (bounded). Returns { ok, data }. */
  async callTool(name, args = {}, { recover = true } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.request("tools/call", { name, arguments: args }, { recover });
      const data = toolData(result);
      const ok = result?.isError !== true && errorCode(data) === null;
      if (!ok && errorCode(data) === "call_rate" && attempt < 5) {
        await this.clock.sleep(Number(data.retryAfterMs) > 0 ? Number(data.retryAfterMs) : 1000);
        continue;
      }
      return { ok, data };
    }
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result?.tools ?? [];
  }
}
