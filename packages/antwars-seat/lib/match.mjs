// Clients for the entry point and the seat's match server, built from state.
// The match client's MCP session is shared through state/match-session.json so
// separate commands reuse it; when it is gone the client re-joins the seat.
// Only the match client rides out a server handover (HANDOVER_RETRY_MS per
// command); the entry client reports a failed send at once, as before.
import { ALLOW_HTTP_ENV, HANDOVER_RETRY_MS, McpClient, errorCode } from "./mcp.mjs";
import { dropped, envNumber, makeLimiter, progress, readJson, readKey, statePath, writeJson } from "./state.mjs";

export const DEFAULT_MIN_CALL_MS = 600;

export function seatContext({ config, env = process.env, clock, cwd = process.cwd() }) {
  const key = readKey(config.keyName, env, cwd);
  const limiter = makeLimiter({ file: statePath("last-call", env), minIntervalMs: envNumber(env, "ANTWARS_MIN_CALL_MS", DEFAULT_MIN_CALL_MS), clock });
  return { config, env, clock, key, limiter };
}

/** True when the builder opted in to plain http to a host other than this machine. */
function allowHttp(ctx) {
  return ctx.env?.[ALLOW_HTTP_ENV] === "1";
}

/** The join arguments for this seat: always the seat number (a key holding several seats must name one); labels are self-reported; serviceTier only when set (fast). */
export function joinArgs({ config, key }) {
  const args = { key, seat: Number(config.seat) };
  if (config.modelLabel) args.modelLabel = config.modelLabel;
  if (config.thinkingLevel) args.thinkingLevel = config.thinkingLevel;
  if (config.serviceTier) args.serviceTier = config.serviceTier;
  return args;
}

export function entryClient(ctx) {
  return new McpClient({ url: ctx.config.entryUrl, clock: ctx.clock, limiter: ctx.limiter, allowHttp: allowHttp(ctx),
    log: (step, detail) => progress(step, { server: "entry", ...detail }, ctx.env) });
}

/** Join once, retrying lobby_loading after its retryAfterMs. Returns { ok, data }. */
export async function joinSeat(client, ctx, { maxLoadingRetries = 300, recover = true } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const reply = await client.callTool("join", joinArgs(ctx), { recover });
    if (!reply.ok && errorCode(reply.data) === "lobby_loading" && attempt < maxLoadingRetries) {
      progress("join_lobby_loading", { retryAfterMs: reply.data.retryAfterMs ?? null }, ctx.env);
      await client.resendAfter(Number(reply.data.retryAfterMs) > 0 ? Number(reply.data.retryAfterMs) : 1000, { loading: true });
      continue;
    }
    return reply;
  }
}

export function matchClient(ctx, mcpUrl) {
  const sessionFile = statePath("match-session.json", ctx.env);
  const saved = readJson(sessionFile);
  const client = new McpClient({
    url: mcpUrl, clock: ctx.clock, limiter: ctx.limiter, retryWindowMs: HANDOVER_RETRY_MS, allowHttp: allowHttp(ctx),
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

/**
 * The server's own pre-start facts in a join or observe reply, copied as the server gave them: matchStarts and its
 * message (e.g. "Call observe until it starts"). from names the reply, at when it was received. Null when it gave none.
 */
export function serverStartFacts(data, from, clock) {
  if (data?.matchStarts === undefined && typeof data?.message !== "string") return null;
  return { from, at: new Date(clock.now()).toISOString(), matchStarts: data.matchStarts ?? null, message: data.message ?? null };
}

/** Status fields that hold only before the match starts: the nest window, the pick instruction and the server's pre-start facts. */
const PRE_START_FIELDS = ["closesAt", "box", "next", "fromServer"];

/**
 * Keeps status current from a reply to a call the seat itself made (a match command or the observer's observe); it
 * never makes a call of its own. An accepted pick_nest writes nest_picked and drops the pick instruction; an observe
 * answered "not started" writes waiting_for_start with the server's facts; the first observe of a started match
 * writes match_started and drops every pre-start field. Repeats of an unchanged state add no log line.
 */
export function noteMatchReply(name, args, reply, { env, clock }) {
  const data = reply?.data;
  if (!reply?.ok || !data || isMatchOver(data)) return;
  const current = readJson(statePath("status.json", env), {});
  if (name === "pick_nest" && data.accepted === true) {
    progress("nest_picked", { pick: { tileX: args?.tileX ?? null, tileY: args?.tileY ?? null },
      closesAt: data.nestSelection?.closesAt ?? current.closesAt ?? null, next: undefined }, env);
    return;
  }
  if (name !== "observe") return;
  if (data.waiting === true) {
    const facts = serverStartFacts(data, "observe", clock);
    if (current.step === "waiting_for_start" && current.fromServer?.matchStarts === facts?.matchStarts && current.fromServer?.message === facts?.message) return;
    progress("waiting_for_start", { fromServer: facts }, env);
    return;
  }
  if (data.view && data.view.tick > 0 && current.startSeenTick === undefined) {
    progress("match_started", { startSeenTick: data.view.tick, ...dropped(PRE_START_FIELDS) }, env);
  }
}
