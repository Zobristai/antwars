// Clients for the entry point and the seat's match server, built from state.
// The match client's MCP session is shared through state/match-session.json so
// separate commands reuse it; when it is gone the client re-joins the seat.
import { McpClient, errorCode } from "./mcp.mjs";
import { envNumber, makeLimiter, progress, readJson, readKey, statePath, writeJson } from "./state.mjs";

export const DEFAULT_MIN_CALL_MS = 600;

export function seatContext({ config, env = process.env, clock, cwd = process.cwd() }) {
  const key = readKey(config.keyName, env, cwd);
  const limiter = makeLimiter({ file: statePath("last-call", env), minIntervalMs: envNumber(env, "ANTWARS_MIN_CALL_MS", DEFAULT_MIN_CALL_MS), clock });
  return { config, env, clock, key, limiter };
}

/** The join arguments for this seat: labels are self-reported; serviceTier only when set (fast). */
export function joinArgs({ config, key }) {
  const args = { key };
  if (Number(config.seat) > 1) args.seat = Number(config.seat);
  if (config.modelLabel) args.modelLabel = config.modelLabel;
  if (config.thinkingLevel) args.thinkingLevel = config.thinkingLevel;
  if (config.serviceTier) args.serviceTier = config.serviceTier;
  return args;
}

export function entryClient(ctx) {
  return new McpClient({ url: ctx.config.entryUrl, clock: ctx.clock, limiter: ctx.limiter,
    log: (step, detail) => progress(step, { server: "entry", ...detail }, ctx.env) });
}

/** Join once, retrying lobby_loading after its retryAfterMs. Returns { ok, data }. */
export async function joinSeat(client, ctx, { maxLoadingRetries = 300, recover = true } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const reply = await client.callTool("join", joinArgs(ctx), { recover });
    if (!reply.ok && errorCode(reply.data) === "lobby_loading" && attempt < maxLoadingRetries) {
      progress("join_lobby_loading", { retryAfterMs: reply.data.retryAfterMs ?? null }, ctx.env);
      await ctx.clock.sleep(Number(reply.data.retryAfterMs) > 0 ? Number(reply.data.retryAfterMs) : 1000);
      continue;
    }
    return reply;
  }
}

export function matchClient(ctx, mcpUrl) {
  const sessionFile = statePath("match-session.json", ctx.env);
  const saved = readJson(sessionFile);
  const client = new McpClient({
    url: mcpUrl, clock: ctx.clock, limiter: ctx.limiter,
    session: saved && saved.mcpUrl === mcpUrl ? { sessionId: saved.sessionId, protocolVersion: saved.protocolVersion } : null,
    onSession: (session) => writeJson(sessionFile, { mcpUrl, ...session }),
    log: (step, detail) => progress(step, { server: "match", ...detail }, ctx.env),
    onReinit: async (fresh) => {
      const joined = await joinSeat(fresh, ctx, { recover: false });
      progress(joined.ok ? "rejoined" : "rejoin_refused", joined.ok ? {} : { error: errorCode(joined.data) }, ctx.env);
    },
  });
  return client;
}

/** The match this seat joined, from go. */
export function savedMatch(env = process.env) {
  const match = readJson(statePath("match.json", env));
  if (match === null || !match.mcpUrl) throw new Error("No match located yet. Run: antwars-seat go (or check: antwars-seat status)");
  return match;
}

export function isMatchOver(data) {
  return data?.matchOver === true || (data?.view && data.view.result !== null && data.view.result !== undefined)
    || errorCode(data) === "match_over" || errorCode(data) === "match_not_played";
}
