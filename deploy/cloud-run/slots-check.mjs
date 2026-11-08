// Scripted-bot check of a deployed slot-services preview.
// Plain Node, no Google credential, no LLM: run it from anywhere.
//
//   node deploy/cloud-run/slots-check.mjs <any slot service url> [<lobby size 1-4>=1] [<watch seconds>=480]
//
// Bots claim fresh usernames, then fill one public and one private lobby of
// <size> agents per colony at the same time. For each lobby it reads the slot it
// holds, and the slot's MCP and spectator addresses, from the lobby's state
// (GET /lobbies/<id>/match on the given service), and requires the two lobbies to
// play on different slots at different addresses. Every seated bot then joins its
// match over MCP at that address with its own key, and both matches must be live
// and advancing at once. A spectator then reaches each match at its spectator
// address: the private one only with its invite (refused without it), the public
// one without; each live stream must deliver match data within <watch seconds>
// (rated matches are delayed 300 s). Bots keep observing throughout and leave
// their matches running. Exit 0 only if every step passes.
//
// Every line starts with a complete UTC timestamp. Keys and invite tokens are never printed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import "../../src/ts-resolve.mjs";

const [{ COUNTDOWN_MS }, { START_PICK_WINDOW_MS }] = await Promise.all([
  import("../../src/lobby/lobbies.ts"),
  import("../../src/sim/startPlacement.ts"),
]);
const BOTH_MATCHES_LIVE_TIMEOUT_MS = Math.max(180_000, COUNTDOWN_MS + START_PICK_WINDOW_MS + 60_000);

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const fail = (message) => { throw new Error(message); };

async function until(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) fail(`timed out after ${timeoutMs / 1000} s: ${what}`);
    await sleep(500);
  }
}

async function api(base, operation, body) {
  const res = await fetch(new URL(`/api/${operation}`, base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const reply = await res.json();
  if (!res.ok) fail(`${operation}: ${res.status} ${reply.error}`);
  return reply;
}

async function mcp(url) {
  const client = new Client({ name: "antwar-slots-check", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, data: r.structuredContent };
  };
  return { call, close: () => client.close().catch(() => {}) };
}

/** A seat's observe while its match runs: a view with no result yet. */
async function liveView(seat) {
  const reply = await seat.call("observe");
  return !reply.isError && reply.data?.view !== undefined && reply.data.view.result === null ? reply.data.view : undefined;
}

/** Opens the delayed live stream and resolves with the first `data:` line's arrival, or rejects. */
async function firstMatchData(url, headers, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: abort.signal });
    if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/event-stream")) fail(`live stream ${url}: ${res.status}`);
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of res.body) {
      text += decoder.decode(chunk, { stream: true });
      if (/^data:/m.test(text)) return;
    }
    fail(`live stream ${url} ended before any match data`);
  } catch (err) {
    if (abort.signal.aborted) fail(`no match data on ${url} within ${timeoutMs / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

export async function check(base, size = 1, watchSeconds = 480) {
  const tag = randomBytes(3).toString("hex");
  const seats = 2 * size;
  const claim = async (name) => ({ name, key: (await api(base, "claim_username", { name })).key });
  const bots = await Promise.all(["p", "q"].flatMap((kind) => Array.from({ length: seats }, (_, i) => claim(`bot${tag}${kind}${i}`))));
  const lobbyBots = { public: bots.slice(0, seats), private: bots.slice(seats) };
  log("claimed", bots.length, "bot usernames", bots.map((b) => b.name).join(" "));

  const lobbies = {};
  for (const kind of ["public", "private"]) {
    const created = await api(base, "create_lobby", { key: lobbyBots[kind][0].key, size, kind });
    lobbies[kind] = { id: created.lobby.id, inviteToken: created.inviteToken, bots: lobbyBots[kind] };
    log("created", kind, "lobby", created.lobby.id, kind === "private" ? `with invite link: ${created.inviteLink !== undefined}` : "");
  }
  // Every seat but the last of each lobby, then both last seats together, so both start at once.
  const join = (kind, bot) => api(base, "join_lobby", { key: bot.key, lobbyId: lobbies[kind].id, inviteToken: lobbies[kind].inviteToken ?? null });
  for (const kind of ["public", "private"]) for (const bot of lobbies[kind].bots.slice(0, -1)) await join(kind, bot);
  await Promise.all(["public", "private"].map((kind) => join(kind, lobbies[kind].bots.at(-1))));
  log("filled both lobbies");

  for (const kind of ["public", "private"]) {
    const lobby = lobbies[kind];
    const held = await until(`${kind} lobby to hold a slot`, async () => {
      const read = await api(base, "read_lobby", { lobbyId: lobby.id, key: lobby.bots[0].key, inviteToken: null });
      return read.lobby.state === "holding" ? read.lobby : undefined;
    }, 60_000);
    const res = await fetch(new URL(`/lobbies/${lobby.id}/match`, base));
    if (res.status !== 200) fail(`GET /lobbies/${lobby.id}/match: ${res.status}`);
    lobby.located = await res.json();
    if (lobby.located.slot !== held.slot || !lobby.located.slot.startsWith(`${kind}-`)) fail(`${kind} lobby located at slot ${lobby.located.slot}, holds ${held.slot}`);
    log(kind, "lobby", lobby.id, "holds", held.slot, "rated", held.rated, "mcp", lobby.located.mcpUrl, "spectator", lobby.located.spectatorUrl);
  }
  const [pub, priv] = [lobbies.public, lobbies.private];
  if (new URL(pub.located.mcpUrl).origin === new URL(priv.located.mcpUrl).origin) fail("both lobbies resolve to the same instance address");
  log("PASS the lobbies hold different slots on different instance addresses");

  const seated = [];
  try {
    for (const lobby of [pub, priv]) {
      for (const bot of lobby.bots) {
        const seat = await mcp(lobby.located.mcpUrl);
        seated.push(seat);
        await until(`${bot.name} to join its match`, async () => !(await seat.call("join", { key: bot.key })).isError, 120_000);
        lobby.seat ??= seat;
      }
    }
    log("PASS every seated bot joined its match over MCP from the lobby's state");
    const views = await until("both matches to be live", async () => {
      const both = [await liveView(pub.seat), await liveView(priv.seat)];
      return both.every(Boolean) ? both : undefined;
    }, BOTH_MATCHES_LIVE_TIMEOUT_MS);
    await until("both matches to advance", async () => {
      const both = [await liveView(pub.seat), await liveView(priv.seat)];
      return both.every((view, i) => view !== undefined && view.tick > views[i].tick) || undefined;
    }, 60_000);
    log("PASS both matches are live and advancing at the same time");

    // Bots keep observing so their sessions stay inside the server's idle expiry.
    const keepAlive = setInterval(() => { for (const seat of seated) void seat.call("observe").catch(() => {}); }, 20_000);
    try {
      for (const lobby of [pub, priv]) {
        const status = (headers) => fetch(new URL(`/watch/status/${lobby.id}`, lobby.located.spectatorUrl), { headers });
        const invite = lobby === priv ? { "x-antwar-invite": priv.inviteToken } : {};
        if (lobby === priv) {
          const refused = await status({});
          if (refused.status === 200) fail("the private match's status was served without its invite");
        }
        const page = await fetch(lobby.located.spectatorUrl);
        if (page.status !== 200) fail(`spectator page ${lobby.located.spectatorUrl}: ${page.status}`);
        const res = await status(invite);
        if (res.status !== 200) fail(`watch status for the ${lobby === pub ? "public" : "private"} match: ${res.status}`);
        log("spectator status", lobby === pub ? "public" : "private", JSON.stringify(await res.json()));
      }
      log(`waiting up to ${watchSeconds} s for each delayed live stream to deliver match data`);
      await Promise.all([pub, priv].map((lobby) => firstMatchData(
        new URL(`/watch/live/${lobby.id}`, lobby.located.spectatorUrl), lobby === priv ? { "x-antwar-invite": priv.inviteToken } : {}, watchSeconds * 1000,
      ).then(() => log("spectator received match data", lobby === pub ? "public" : "private"))));
      log("PASS a spectator reached each match (the private one only with its invite)");
    } finally {
      clearInterval(keepAlive);
    }
  } finally {
    for (const seat of seated) await seat.close();
  }
}

if (import.meta.main) {
  const [base, size = "1", watch = "480"] = process.argv.slice(2);
  if (!base || !/^[1-4]$/.test(size) || !/^[1-9][0-9]*$/.test(watch)) {
    console.error("usage: node deploy/cloud-run/slots-check.mjs <any slot service url> [<lobby size 1-4>] [<watch seconds>]");
    process.exit(2);
  }
  try {
    await check(base, Number(size), Number(watch));
    log("RESULT slots check: PASS");
  } catch (err) {
    log("RESULT slots check: FAIL", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
