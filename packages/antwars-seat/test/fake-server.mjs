// A local fake of the Antwars entry point (/mcp) and one match server
// (/match/mcp), speaking just enough Streamable-HTTP MCP for the harness.
// Its time is the test's clock, so pairings can arrive "after 130 s" instantly.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export function fakeClock(start = 1_800_000_000_000) {
  const advanced = [];
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += Math.max(0, ms);
      for (const run of advanced) await run();
    },
    /** run after every sleep (the fake server ends a connection outage there). */
    onAdvance: (run) => advanced.push(run),
    /** A client attempt's timeout on fake time: it fires only when the fake server holds that request (expireTimeout). */
    timeout: (ms) => {
      const controller = new AbortController();
      clock.pendingTimeout = { at: clock.t + ms, controller };
      return controller.signal;
    },
    pendingTimeout: null,
    expireTimeout: () => {
      const pending = clock.pendingTimeout;
      clock.pendingTimeout = null;
      clock.t = Math.max(clock.t, pending.at);
      pending.controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    },
  };
  return clock;
}

const MATCH_TOOLS = [
  { name: "join", description: "Join this lobby slot server.", inputSchema: { type: "object", properties: { key: {}, seat: {}, modelLabel: {}, thinkingLevel: {}, serviceTier: {} } } },
  { name: "pick_nest", description: "Pick your nest.", inputSchema: { type: "object", properties: { tileX: {}, tileY: {} } } },
  { name: "observe", description: "Observe the match.", inputSchema: { type: "object", properties: { since: {}, waitSeconds: {}, map: {} } } },
  { name: "rules", description: "Read the rules.", inputSchema: { type: "object", properties: {} } },
  { name: "order", description: "Order ants. Moves a group.", inputSchema: { type: "object", properties: { ants: {}, tileX: {}, tileY: {} }, required: ["ants"] } },
];
/** Match tools whose applied call is remembered by its call id. */
const MUTATING = new Set(["pick_nest", "order"]);
const CALL_ID = "antwars/callId";

/** The entry calls that refuse seat client 1.0.0, and the refusal's wording. */
export const SEAT_CLIENT_REFUSED_TOOLS = ["queue_status", "read_lobby", "locate_match", "join_queue", "join_lobby", "create_lobby"];
export const UPDATE_SEAT_CLIENT_FIX = "Copy the seat client again from origin/main into ./.antwars-seat as packages/antwars-seat/README.md describes, then run your command again.";
export const UPDATE_SEAT_CLIENT_MESSAGE = `This server no longer accepts seat client 1.0.0, which cannot wait out a server handover. ${UPDATE_SEAT_CLIENT_FIX}`;

/**
 * options:
 *   key            the valid seat key
 *   clock          shared fake clock (default real Date.now)
 *   pairAfterMs    a waiting entry pairs this long after its join (null: never)
 *   baseline       initial queue entry, e.g. { state: "matched", lobbyId: "old", matchedAt: n }
 *   lobbies        initial lobby states by id, e.g. { old: "ended" }
 *   sse            reply to tool calls as SSE (with a keepalive frame first)
 *   lobbyLoading   how many joins answer lobby_loading first
 *   box, terrain   the nest selection offered on join
 *   cellsMore      observe replies that more cells follow (cellsCursor snap:2)
 *   matchOverAfterObserves  observe replies matchOver from this call number on
 *   refuseReadLobby how many read_lobby calls are refused (unavailable) first
 *   failReadLobbyHttp how many read_lobby calls then fail with HTTP 503
 *   refuseJoinLobby error code every join_lobby is refused with (e.g. "full"); with "already_seated" the key
 *                  counts as seated in that lobby, so read_lobby returns its wait link
 *   lobbyHoldsAfterLocates a joined lobby stays "open" (locate_match null) for this many locate_match calls
 *   distinctLobbies each pairing gets its own lobby (fresh-lobby-1, -2, ...) and match URL /match/<lobbyId>/mcp
 *   noNestWindow   join replies without nestSelection and observe shows a started match (tick > 0)
 *   seatsHeld      seats the key holds in the match (default 1); above 1 a join without seat is refused seat_required
 *   notApplied     { tool, times, retryAfterMs }: the next `times` calls of that match tool answer
 *                  not_applied (with retryAfterMs unless it is null) and are not applied
 *   loseReplyAfterApply tool name: its first applied call loses its reply — the fake applies and
 *                  remembers it, forgets every MCP session and answers HTTP 404 instead
 *   refuseOldSeatClient the entry server refuses a session whose initialize clientInfo is antwars-seat 1.0.0
 *                  on SEAT_CLIENT_REFUSED_TOOLS with update_seat_client, in each tool's reply family; join is never refused
 *
 * The match server remembers each applied mutating call that carries a call id
 * (params._meta["antwars/callId"]) per seat with its result; a repeat of that id
 * returns the original result with no second effect.
 *
 * fake.outage({ status | hold | refuse, ms, on }) queues a server outage (needs the fake clock). It starts at
 * the next request matching `on` (an MCP method or tool name; any request when omitted) and lasts ms of fake
 * time, during which every request is: answered HTTP `status` (503, 429, or any other); held unanswered
 * (`hold`: an attempt whose timeout falls inside the span times out, a later one is answered at the span's
 * end); or cut, with new connections refused until the span ends (`refuse`). Queued outages run one after
 * another; fake.outageHits lists every request an outage took.
 *
 * Every initialize call and session records its clientInfo; every answered tool call records its result.
 *
 * Wait links, as the entry server returns them: join_queue's reply carries waitToken queue-wait-<n> and its waitUrl
 * (<url>/wait/<token>), and queue_status carries the same while that join's entry is waiting or matched (a baseline
 * entry has one only when given waitToken); join_lobby's carries lobby-wait-<lobbyId>, and read_lobby carries it to a key seated there.
 */
export async function startFake(options = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const calls = [];
  const sessions = new Map();
  const lobbies = new Map(Object.entries(options.lobbies ?? {}));
  let entry = options.baseline ? { ...options.baseline } : { state: "none" };
  let lobbyLoading = options.lobbyLoading ?? 0;
  let refuseReadLobby = options.refuseReadLobby ?? 0;
  let failReadLobbyHttp = options.failReadLobbyHttp ?? 0;
  let observes = 0;
  let createdLobbies = 0;
  let pairings = 0;
  let queueJoins = 0;
  const seatedLobbies = new Set();
  let openLocates = options.lobbyHoldsAfterLocates ?? 0;
  let picked = null;
  const notApplied = { times: 0, ...options.notApplied };
  let lostReply = false;
  const orders = [];
  const appliedCalls = new Map();
  const box = options.box ?? { x: 2, y: 0, width: 3, height: 3 };
  let base = "";
  let port = 0;
  const outages = [];
  const outageHits = [];
  let refusingUntil = null;

  /** The outage this request falls in, starting a queued one on its first matching request. */
  function outageFor(body) {
    const outage = outages[0];
    if (outage === undefined) return null;
    if (outage.until === undefined) {
      if (outage.on !== undefined && body?.method !== outage.on && body?.params?.name !== outage.on) return null;
      outage.until = clock.now() + outage.ms;
    }
    if (clock.now() < outage.until) return outage;
    outages.shift();
    return outageFor(body);
  }

  let closed = false;
  clock.onAdvance?.(async () => {
    // A closed fake stays closed: a command still running against it fails instead of reopening it.
    if (closed || refusingUntil === null || clock.now() < refusingUntil) return;
    refusingUntil = null;
    outages.shift();
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  });

  const text = (data, isError = false, structured = false) => ({ content: [{ type: "text", text: JSON.stringify(data) }], ...(structured ? { structuredContent: data } : {}), ...(isError ? { isError: true } : {}) });

  /** The entry server's refusal of seat client 1.0.0, or null when this call is answered as today. */
  function seatClientRefusal(name, session) {
    const info = session.clientInfo;
    if (!options.refuseOldSeatClient || info?.name !== "antwars-seat" || info?.version !== "1.0.0" || !SEAT_CLIENT_REFUSED_TOOLS.includes(name)) return null;
    // locate_match answers in the locator family; the five account tools in theirs.
    if (name === "locate_match") return text({ error: { code: "update_seat_client", message: UPDATE_SEAT_CLIENT_MESSAGE, howToFix: UPDATE_SEAT_CLIENT_FIX }, tick: null }, true, true);
    return text({ error: "update_seat_client", message: UPDATE_SEAT_CLIENT_MESSAGE }, true);
  }

  function queueNow() {
    if (entry.state === "waiting" && options.pairAfterMs != null && clock.now() >= entry.joinedAt + options.pairAfterMs) {
      pairings += 1;
      const lobbyId = options.distinctLobbies ? `fresh-lobby-${pairings}` : "fresh-lobby";
      lobbies.set(lobbyId, "holding");
      entry = { state: "matched", mode: entry.mode, lobbyId, matchedAt: entry.joinedAt + options.pairAfterMs, ...(entry.waitToken ? { waitToken: entry.waitToken } : {}) };
    }
    return entry;
  }

  const waitLink = (waitToken) => ({ waitToken, waitUrl: `${base}/wait/${waitToken}` });
  /** The entry as the server shows it: without the fake's own waitToken bookkeeping. */
  const queueView = () => {
    const { waitToken: _token, ...shown } = queueNow();
    return shown;
  };

  function entryTool(name, args) {
    if (args.key !== undefined && args.key !== options.key) return text({ error: "invalid_key", message: "Unknown key." }, true);
    switch (name) {
      case "queue_status": {
        const now = queueNow();
        return text({ queue: queueView(), ...(entry.waitToken && (now.state === "waiting" || now.state === "matched") ? waitLink(entry.waitToken) : {}) });
      }
      case "join_queue": {
        if (queueNow().state === "waiting") return text({ error: "already_queued", message: "Already queued." }, true);
        queueJoins += 1;
        const waitToken = `queue-wait-${queueJoins}`;
        entry = { state: "waiting", mode: args.mode, joinedAt: clock.now(), expiresAt: clock.now() + (String(args.mode).startsWith("house-") ? 900_000 : 43_200_000) };
        if (options.pairAfterMs === 0) queueNow();
        entry.waitToken = waitToken;
        return text({ queue: queueView(), ...waitLink(waitToken) });
      }
      case "leave_queue":
        if (queueNow().state === "waiting") entry = { state: "none" };
        return text({ queue: queueView() });
      case "read_lobby": {
        if (refuseReadLobby > 0) {
          refuseReadLobby -= 1;
          return text({ error: "unavailable", message: "Try again." }, true);
        }
        const state = lobbies.get(args.lobbyId);
        if (state === undefined) return text({ error: "no_such_lobby", message: "No lobby." }, true);
        return text({ lobby: { id: args.lobbyId, state }, ...(seatedLobbies.has(args.lobbyId) ? waitLink(`lobby-wait-${args.lobbyId}`) : {}) });
      }
      case "create_lobby": {
        createdLobbies += 1;
        const id = `lobby-${createdLobbies}`;
        lobbies.set(id, "open");
        return text({ lobby: { id, size: args.size, kind: args.kind, state: "open", seats: [] } });
      }
      case "join_lobby": {
        if (options.refuseJoinLobby === "already_seated") seatedLobbies.add(args.lobbyId);
        if (options.refuseJoinLobby) return text({ error: options.refuseJoinLobby, message: "Refused." }, true);
        if (!lobbies.has(args.lobbyId)) return text({ error: "no_such_lobby", message: "No lobby." }, true);
        if (openLocates === 0) lobbies.set(args.lobbyId, "holding");
        seatedLobbies.add(args.lobbyId);
        return text({ lobby: { id: args.lobbyId, state: lobbies.get(args.lobbyId) }, ...waitLink(`lobby-wait-${args.lobbyId}`) });
      }
      case "locate_match":
        if (lobbies.get(args.lobbyId) === "open") {
          openLocates -= 1;
          if (openLocates <= 0) lobbies.set(args.lobbyId, "holding");
          return text({ slot: null, mcpUrl: null, spectatorUrl: null }, false, true);
        }
        return text({ slot: "public-0", mcpUrl: options.distinctLobbies ? `${base}/match/${args.lobbyId}/mcp` : `${base}/match/mcp`, spectatorUrl: `${base}/watch` }, false, true);
      default: return null;
    }
  }

  function matchTool(name, args, session) {
    const err = (code, extra = {}) => text({ error: { code, message: code, howToFix: "fix" }, ...extra }, true, true);
    const ok = (data) => text(data, false, true);
    if (name === "join") {
      if (args.key !== options.key) return err("not_seated");
      if ((options.seatsHeld ?? 1) > 1 && args.seat === undefined) return err("seat_required");
      if (lobbyLoading > 0) {
        lobbyLoading -= 1;
        return err("lobby_loading", { retryAfterMs: 1000 });
      }
      session.joined = true;
      session.seat = `${args.key}#${args.seat ?? 1}`;
      if (options.noNestWindow) return ok({ agentId: "agent-1", colony: "red", briefing: "long briefing text" });
      return ok({ agentId: "agent-1", colony: "red", briefing: "long briefing text", nestSelection: { required: true, box, closesAt: new Date(clock.now() + 120_000).toISOString(),
        ...(options.terrain ? { terrain: { rows: options.terrain, legend: "." } } : {}), picks: [] } });
    }
    if (!session.joined) return err("not_joined");
    if (name === notApplied.tool && notApplied.times > 0) {
      notApplied.times -= 1;
      return err("not_applied", { ...(notApplied.retryAfterMs != null ? { retryAfterMs: notApplied.retryAfterMs } : {}), tick: 10 + observes });
    }
    switch (name) {
      case "pick_nest": {
        const { tileX, tileY } = args;
        if (!(tileX >= box.x && tileX < box.x + box.width && tileY >= box.y && tileY < box.y + box.height)) return err("nest_outside_box");
        if (options.terrain && options.terrain[tileY - box.y][tileX - box.x] !== ".") return err("nest_water");
        picked = { tileX, tileY };
        return ok({ accepted: true });
      }
      case "observe": {
        observes += 1;
        if (observes <= (options.failObserves ?? 0)) return err("unavailable");
        if (options.matchOverAfterObserves != null && observes >= options.matchOverAfterObserves) return ok({ matchOver: true, winner: "red", result: { winner: 0 } });
        // Cells and territory as the server encodes them (denseCells, packTerritory) for a 8x2 board.
        return ok({ view: { tick: 10 + observes, colony: 0, secondsLeft: 900, squad: [{ antId: 7, tileX: 5, tileY: 1, hp: 4000 }], events: [],
          cells: { width: 8, height: 2, encoding: "base36 …", foodRadix: 4, data: "7*2;18,0,n5c:7.iiq/8.bkt" },
          cellsTick: 10 + observes, cellsMore: options.cellsMore === true, cellsCursor: options.cellsMore === true ? "snap:2" : null,
          marks: { encoding: "columnar-v1", fields: ["markId", "tileX", "tileY", "verb"], rows: [[3, 5, 1, null]] }, myMarks: [],
          ...(args.map === true ? { territory: { encoding: "base64-bitset-lsb0", width: 8, height: 2, data: "A3A=" } } : {}) } });
      }
      case "rules": return ok({ rules: "the rules" });
      case "order":
        orders.push(args);
        return ok({ accepted: true, echo: args, orderNo: orders.length });
      default: return null;
    }
  }

  /** A joined seat's repeat of an applied call id returns the remembered result; otherwise the tool runs. */
  function matchCall(name, args, session, callId) {
    const remembered = session.joined && callId !== undefined ? appliedCalls.get(session.seat)?.get(callId) : undefined;
    if (remembered !== undefined) return { result: remembered, applied: false };
    const result = matchTool(name, args, session);
    const applied = result !== null && result.isError !== true && session.joined && MUTATING.has(name);
    if (applied && callId !== undefined) {
      if (!appliedCalls.has(session.seat)) appliedCalls.set(session.seat, new Map());
      appliedCalls.get(session.seat).set(callId, result);
    }
    return { result, applied };
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const isMatch = req.url.startsWith("/match/");
    const sid = req.headers["mcp-session-id"];
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const outage = outageFor(body);
    if (outage !== null) {
      outageHits.push({ server: isMatch ? "match" : "entry", kind: outage.refuse ? "refuse" : outage.hold ? "hold" : outage.status, method: body?.method, tool: body?.params?.name, at: clock.now() });
      if (outage.refuse) {
        refusingUntil = outage.until;
        server.close();
        server.closeAllConnections();
        return;
      }
      if (!outage.hold) return send(outage.status, { jsonrpc: "2.0", error: { code: -32000, message: `HTTP ${outage.status}` }, id: null });
      if (clock.pendingTimeout && clock.pendingTimeout.at <= outage.until) return clock.expireTimeout();
      clock.t = Math.max(clock.t, outage.until);
      outages.shift();
    }
    if (body?.method === "initialize") {
      const id = randomUUID();
      const clientInfo = body.params?.clientInfo ?? null;
      sessions.set(id, { match: isMatch, joined: false, clientInfo });
      calls.push({ server: isMatch ? "match" : "entry", method: "initialize", clientInfo });
      return send(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }, { "mcp-session-id": id });
    }
    const session = sessions.get(sid);
    if (session === undefined) return send(404, { jsonrpc: "2.0", error: { code: -32000, message: "Unknown session." }, id: null });
    if (req.headers["mcp-protocol-version"] === undefined) return send(400, { jsonrpc: "2.0", error: { code: -32000, message: "missing protocol version" }, id: null });
    if (body.id === undefined) return send(202);
    let result;
    if (body.method === "tools/list") result = { tools: isMatch ? MATCH_TOOLS : [] };
    else if (body.method === "tools/call") {
      const { name, arguments: args = {} } = body.params;
      const callId = body.params._meta?.[CALL_ID];
      const call = { server: isMatch ? "match" : "entry", tool: name, args, callId, at: clock.now(), path: req.url };
      calls.push(call);
      if (!isMatch && name === "read_lobby" && refuseReadLobby === 0 && failReadLobbyHttp > 0) {
        failReadLobbyHttp -= 1;
        return send(503, { error: "unavailable" });
      }
      let applied = false;
      if (isMatch) ({ result, applied } = matchCall(name, args, session, callId));
      else result = seatClientRefusal(name, session) ?? entryTool(name, args);
      if (applied && options.loseReplyAfterApply === name && !lostReply) {
        lostReply = true;
        sessions.clear();
        return send(404, { jsonrpc: "2.0", error: { code: -32000, message: "Unknown session." }, id: null });
      }
      call.result = result;
      if (result === null) return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Tool ${name} not found` } });
    } else return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    const reply = { jsonrpc: "2.0", id: body.id, result };
    if (options.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } else send(200, reply);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/mcp`,
    calls,
    toolCalls: (tool) => calls.filter((c) => c.tool === tool),
    expireSessions: () => sessions.clear(),
    picked: () => picked,
    orders: () => orders,
    outage: (outage) => outages.push({ ...outage }),
    outageHits,
    /** The next n joins answer lobby_loading, as the lobbyLoading option does from the start. */
    setLobbyLoading: (n) => { lobbyLoading = n; },
    close: () => new Promise((resolve) => {
      closed = true;
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** One /proc/<pid>/stat line: pid, session id and start time (field 22); the other fields are filler. */
export function statLine({ pid, sid, start }) {
  const fields = ["S", "1", String(sid), String(sid), "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", String(start), "0", "0"];
  return `${pid} (node) ${fields.join(" ")}\n`;
}

let shells = 1_000_000;
/**
 * A readStat for main() that puts the command in a shell command of its own: a fresh
 * live session whose leader is itself. The in-process tests pass one per cli() call.
 */
export function freshShell() {
  const sid = (shells += 1);
  return (pid) => {
    if (pid === "self" || pid === sid) return statLine({ pid: sid, sid, start: 1 });
    throw new Error("no such process");
  };
}
