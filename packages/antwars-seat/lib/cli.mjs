// antwars-seat command line. Every printed line passes through redact().
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderView } from "./board.mjs";
import { entryRead } from "./entry-read.mjs";
import { claimGameCommand, isGameCommand, procStat, refusalMessage } from "./guard.mjs";
import { matchClient, noteMatchReply, savedMatch, seatContext } from "./match.mjs";
import { observerSettings, observerStatus, runObserver } from "./observer.mjs";
import { err, out, redact } from "./redact.mjs";
import { STALE_WAIT_FIELDS, createLobby, go, joinLobby, leaveQueue, savedWaitLink } from "./seat.mjs";
import { alive, ensureReadyAt, progress, readConfig, readJson, readKey, realClock, stateDir, statePath, writeConfig, writeJson } from "./state.mjs";

const BIN = fileURLToPath(new URL("../bin/antwars-seat", import.meta.url));

export const HELP = `antwars-seat — Antwars seat harness (state in ./.antwars-seat/state/)

  setup --handle <antwars/handle> --key-name <KEY_NAME> --mode <house-1v1..house-4v4>
        --model-label <label> --thinking-level <level> [--seat N] [--service-tier fast]
        [--queuing | --no-queuing]          seat 1 queues by default; seats 2..N do not
        [--parallel]                        queuing seat may queue while another run of its handle plays
  go [--detach]                             queue once, wait for pairing, join; stops in the nest window
                                            (step joined with closesAt and box); then send your own pick_nest
  status                                    the seat's latest known state, no server call: go or join-lobby
                                            progress, then nest_picked, waiting_for_start and match_started
                                            from this seat's own pick_nest and observe replies, with the
                                            server's own matchStarts and message (fromServer); then the
                                            last log lines as history, superseded by that state
  wait-url                                  the waitUrl go or join-lobby saved (printed when saved): GET it and wait
                                            for the event done, whose data.state is slot_ready or expired
  leave                                     leave the queue only if this seat is waiting
  entry-read <read_lobby|queue_status> --key-name <KEY_NAME> ['<json args>']
                                            one read-only entry call with the named key; needs no setup,
                                            writes nothing, never prints the key; fails, without naming
                                            it, when the named key is absent (a key presence check)
  create-lobby                              create an unrated public lobby, 1 per colony; prints lobbyId
  join-lobby <lobbyId> [--detach]           take a seat in that lobby (no queue), join; stops in the nest window like go
  observe [--raw] [--since N] [--wait S] [--cellsCursor C] [--map]
                                            read-only, one observe call (sent with map:true): the decoded map —
                                            cells (food, queens with hp, ants by colony/caste/hp), own territory
                                            rows, squad, queens, marks — nothing cut; says when more cells follow.
                                            --raw prints the server reply unchanged (map only with --map)
  board                                     read-only, exactly one observe call (map:true): the same decoded view
  rules
  tools [name]                              tools the match server lists, with arguments
  call <tool> ['<json args>']               any match tool, one call
  <tool> [--arg value ...]                  any match tool by name, e.g. order --json '{...}'
                                            game commands (any match tool but observe and rules): at most one per
                                            shell command; a further one started by the same shell command (chain,
                                            loop, background job, script) is refused, not sent
  observer start [--interval S] [--retry S] | stop | status
  help

Environment: ANTWARS_KEY_FILE (house key file) or ANTWARS_SEAT_STORE (.git dir holding
antwars-house-keys.env), needed outside a checkout that has the key file;
ANTWARS_ENTRY_URL, ANTWARS_SEAT_STATE override defaults. Servers must be https (plain http
only to this machine, unless ANTWARS_ALLOW_HTTP=1); redirects are never followed.`;

/** --name value pairs; a flag with no value is true. Positionals are returned in order. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[name] = true;
      else {
        flags[name] = next;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { flags, positional };
}

/** Flag text to a JSON value: numbers, booleans, null, JSON objects/arrays; otherwise the string. */
export function coerce(value) {
  if (value === true) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false" || value === "null") return JSON.parse(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      // Leave as text.
    }
  }
  return value;
}

function print(value) {
  out(typeof value === "string" ? value : JSON.stringify(value));
}

function setup(flags, env, clock) {
  const missing = ["handle", "key-name", "mode", "model-label", "thinking-level"].filter((name) => typeof flags[name] !== "string");
  if (missing.length) throw new Error(`setup needs --${missing.join(", --")}`);
  const seat = flags.seat === undefined ? 1 : Number(flags.seat);
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > 4) throw new Error("--seat must be 1 to 4");
  const queuing = flags["no-queuing"] === true ? false : flags.queuing === true ? true : seat === 1;
  if (flags.parallel === true && !queuing) throw new Error("--parallel is for a queuing seat only");
  readKey(flags["key-name"], env); // Fails now if the key is missing; the value is never stored.
  const config = writeConfig({
    handle: flags.handle, keyName: flags["key-name"], mode: flags.mode, seat, queuing,
    parallel: flags.parallel === true ? true : undefined,
    modelLabel: flags["model-label"], thinkingLevel: flags["thinking-level"],
    serviceTier: typeof flags["service-tier"] === "string" ? flags["service-tier"] : undefined,
    entryUrl: typeof flags.entry === "string" ? flags.entry : undefined,
  }, env);
  const readyAt = ensureReadyAt(env, clock);
  progress("setup", { handle: config.handle, mode: config.mode, seat: config.seat, queuing: config.queuing, readyAt }, env);
  return config;
}

function detach(args, logName, env) {
  mkdirSync(stateDir(env), { recursive: true });
  const fd = openSync(statePath(logName, env), "a");
  const child = spawn(process.execPath, [BIN, ...args], { detached: true, stdio: ["ignore", fd, fd], env: { ...env, ANTWARS_DETACHED: "1" }, cwd: process.cwd() });
  child.unref();
  return child.pid;
}

/** go and join-lobby: one run per seat (go.lock), --detach re-spawns the same command, progress in status. */
async function runSeat(argv, flags, env, clock, flow) {
  const config = readConfig(env);
  const lock = statePath("go.lock", env);
  const running = () => {
    const holder = Number(readJson(lock)?.pid);
    return holder && holder !== process.pid && alive(holder) ? holder : null;
  };
  if (running()) throw new Error(`go is already running (pid ${running()}); read progress with: antwars-seat status`);
  if (flags.detach === true && env.ANTWARS_DETACHED !== "1") {
    const pid = detach(argv, "go.log", env);
    print(`${argv[0]} started detached (pid ${pid}). Progress: antwars-seat status`);
    return 0;
  }
  // Exclusive create: two go processes of one seat can never both proceed (no crossed re-queue).
  mkdirSync(stateDir(env), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt > 0) throw error;
      const holder = running();
      if (holder) throw new Error(`go is already running (pid ${holder}); read progress with: antwars-seat status`);
      rmSync(lock, { force: true }); // Left by a dead run.
    }
  }
  try {
    // A new run's status never shows an earlier run's (or setup's) fields; taken only while holding go.lock.
    progress("started", { command: argv[0] }, env, { fresh: true });
    ensureReadyAt(env, clock);
    const ctx = seatContext({ config, env, clock });
    const result = await flow(ctx);
    print(result);
    return 0;
  } catch (error) {
    progress("failed", { error: error instanceof Error ? error.message : String(error) }, env);
    throw error;
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Says beside the server's own facts whether its matchStarts time has passed by this machine's clock; not a confirmed start. */
export const MATCH_STARTS_PASSED_NOTE = "the server's matchStarts time has passed by this machine's clock; that is not a confirmed start: observe shows whether the match is running";

/** True or false once matchStarts is a time and the match is not yet seen started; null when unknown (e.g. "when its caller starts it"). */
function matchStartsPassed(current, clock) {
  const at = Date.parse(current.fromServer?.matchStarts ?? "");
  return Number.isFinite(at) ? clock.now() >= at : null;
}

function status(env, clock) {
  const current = readJson(statePath("status.json", env), { step: "not_started" });
  const passed = matchStartsPassed(current, clock);
  const timing = passed === null ? {} : { matchStartsPassed: passed, ...(passed ? { matchStartsNote: MATCH_STARTS_PASSED_NOTE } : {}) };
  let tail = [];
  try {
    tail = readFileSync(statePath("progress.log", env), "utf8").trim().split("\n").slice(-8);
  } catch {
    // No progress yet.
  }
  print({ ...current, ...timing, goRunning: alive(Number(readJson(statePath("go.lock", env))?.pid)), observer: observerStatus(env, alive).state });
  if (tail.length === 0) return 0;
  print({ history: HISTORY_NOTE });
  for (const line of tail) print(historyLine(line));
  return 0;
}

/** Heads the log lines status prints after the current status. */
export const HISTORY_NOTE = "earlier progress.log lines, oldest first: superseded by the status above, not the current state; their instructions and lobby and queue states are left out";
/** Left out of the history lines: a superseded instruction and the lobby and queue states read while pairing. */
const HISTORY_OMITTED = ["next", ...STALE_WAIT_FIELDS];

function historyLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }
  for (const field of HISTORY_OMITTED) delete entry[field];
  return entry;
}

async function matchCall(name, args, env, clock, { raw = false, readStat = procStat } = {}) {
  const ctx = seatContext({ config: readConfig(env), env, clock });
  const client = matchClient(ctx, savedMatch(env).mcpUrl);
  if (isGameCommand(name)) {
    // One game command per shell command: claimed before anything is sent.
    const claim = claimGameCommand(env, readStat);
    if (!claim.allowed) {
      progress("game_command_refused", { tool: name, reason: claim.reason }, env);
      throw new Error(refusalMessage(name, claim.reason));
    }
  }
  const reply = await client.callTool(name, args);
  noteMatchReply(name, args, reply, ctx);
  print(reply.data?.view && typeof reply.data.view === "object" && !raw ? renderView(reply.data) : reply.data);
  return reply.ok ? 0 : 2;
}

async function listTools(name, env, clock) {
  const ctx = seatContext({ config: readConfig(env), env, clock });
  const tools = await matchClient(ctx, savedMatch(env).mcpUrl).listTools();
  for (const tool of tools) {
    if (name && tool.name !== name) continue;
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    const args = Object.keys(props).map((arg) => `--${arg}${required.has(arg) ? "" : "?"}`).join(" ");
    print(name ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema } : `${tool.name} ${args}  — ${String(tool.description ?? "").split(". ")[0]}`);
  }
  return 0;
}

async function observer(sub, flags, env, clock) {
  if (sub === "start") {
    const settings = observerSettings(env, flags);
    if (env.ANTWARS_DETACHED === "1") {
      const ctx = seatContext({ config: readConfig(env), env, clock });
      print(await runObserver(ctx, settings));
      return 0;
    }
    savedMatch(env);
    const current = observerStatus(env, alive);
    if (current.state === "running") throw new Error(`observer already running (pid ${current.pid})`);
    rmSync(statePath("observer.stop", env), { force: true });
    const args = ["observer", "start", "--interval", String(settings.intervalMs / 1000), "--retry", String(settings.retryMs / 1000)];
    const pid = detach(args, "observer.log", env);
    print(`observer started detached (pid ${pid}), observe every ${settings.intervalMs / 1000} s. Status: antwars-seat observer status`);
    return 0;
  }
  if (sub === "stop") {
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(statePath("observer.stop", env), "stop\n");
    print("observer stop requested; it exits within a second");
    return 0;
  }
  if (sub === "status") {
    print(observerStatus(env, alive));
    return 0;
  }
  throw new Error("usage: antwars-seat observer start [--interval S] [--retry S] | stop | status");
}

/** readStat reads /proc/<pid>/stat for the one-game-command-per-shell-command guard (tests pass their own). */
export async function main(argv, { env = process.env, clock = realClock, readStat = procStat } = {}) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
        print(HELP);
        return 0;
      case "setup":
        print({ setup: setup(flags, env, clock), stateDir: stateDir(env) });
        return 0;
      case "go":
        return await runSeat(["go"], flags, env, clock, go);
      case "create-lobby":
        print(await createLobby(seatContext({ config: readConfig(env), env, clock })));
        return 0;
      case "join-lobby": {
        const lobbyId = positional[0];
        if (typeof lobbyId !== "string" || lobbyId === "") throw new Error("usage: antwars-seat join-lobby <lobbyId> [--detach]");
        return await runSeat(["join-lobby", lobbyId], flags, env, clock, (ctx) => joinLobby(ctx, lobbyId));
      }
      case "status":
        return status(env, clock);
      case "wait-url":
        print(savedWaitLink(env));
        return 0;
      case "leave":
        print(await leaveQueue(seatContext({ config: readConfig(env), env, clock })));
        return 0;
      case "entry-read": {
        const reply = await entryRead({ tool: positional[0], keyName: flags["key-name"], argsText: positional[1], env, clock });
        print(reply.data);
        return reply.ok ? 0 : 2;
      }
      case "observe": {
        const args = {};
        if (flags.since !== undefined) args.since = Number(flags.since);
        if (flags.wait !== undefined) args.waitSeconds = Number(flags.wait);
        // The readable view shows territory, which the server sends only with map:true.
        if (flags.map === true || flags.raw !== true) args.map = true;
        if (typeof flags.cellsCursor === "string") args.cellsCursor = flags.cellsCursor;
        return await matchCall("observe", args, env, clock, { raw: flags.raw === true });
      }
      case "board":
        return await matchCall("observe", { map: true }, env, clock);
      case "rules":
        return await matchCall("rules", {}, env, clock, { raw: true });
      case "tools":
        return await listTools(positional[0], env, clock);
      case "call": {
        if (!positional[0]) throw new Error("usage: antwars-seat call <tool> ['<json args>']");
        const args = positional[1] === undefined ? {} : JSON.parse(positional[1]);
        return await matchCall(positional[0], args, env, clock, { raw: flags.raw === true, readStat });
      }
      case "observer":
        return await observer(positional[0], flags, env, clock);
      default: {
        const { raw, json, ...named } = flags;
        const args = { ...(typeof json === "string" ? JSON.parse(json) : {}), ...Object.fromEntries(Object.entries(named).map(([k, v]) => [k, coerce(v)])) };
        return await matchCall(command, args, env, clock, { raw: raw === true, readStat });
      }
    }
  } catch (error) {
    err(`antwars-seat ${command ?? ""}: ${redact(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

