// antwars-seat command line. Every printed line passes through redact().
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderView } from "./board.mjs";
import { isMatchOver, matchClient, savedMatch, seatContext } from "./match.mjs";
import { observerSettings, observerStatus, runObserver } from "./observer.mjs";
import { err, out, redact } from "./redact.mjs";
import { createLobby, go, joinLobby, leaveQueue } from "./seat.mjs";
import { alive, ensureReadyAt, progress, readConfig, readJson, readKey, realClock, stateDir, statePath, writeConfig, writeJson } from "./state.mjs";

const BIN = fileURLToPath(new URL("../bin/antwars-seat", import.meta.url));

export const HELP = `antwars-seat — Antwars seat harness (state in ./.antwars-seat/state/)

  setup --handle <antwars/handle> --key-name <KEY_NAME> --mode <house-1v1..house-4v4>
        --model-label <label> --thinking-level <level> [--seat N] [--service-tier fast]
        [--queuing | --no-queuing]          seat 1 queues by default; seats 2..N do not
        [--parallel]                        queuing seat may queue while another run of its handle plays
  go [--detach]                             queue once, wait for pairing, join; stops in the nest window
                                            (step joined with closesAt and box); then send your own pick_nest
  status                                    progress of go or join-lobby (status.json + log tail)
  leave                                     leave the queue only if this seat is waiting
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
  observer start [--interval S] [--retry S] | stop | status
  help

Environment: ANTWARS_KEY_FILE (house key file) or ANTWARS_SEAT_STORE (.git dir holding
antwars-house-keys.env), needed outside a checkout that has the key file;
ANTWARS_ENTRY_URL, ANTWARS_SEAT_STATE override defaults.`;

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

function status(env) {
  const current = readJson(statePath("status.json", env), { step: "not_started" });
  let tail = [];
  try {
    tail = readFileSync(statePath("progress.log", env), "utf8").trim().split("\n").slice(-8);
  } catch {
    // No progress yet.
  }
  print({ ...current, goRunning: alive(Number(readJson(statePath("go.lock", env))?.pid)), observer: observerStatus(env, alive).state });
  for (const line of tail) print(line);
  return 0;
}

async function matchCall(name, args, env, clock, { raw = false } = {}) {
  const ctx = seatContext({ config: readConfig(env), env, clock });
  const client = matchClient(ctx, savedMatch(env).mcpUrl);
  const reply = await client.callTool(name, args);
  print(reply.data?.view && typeof reply.data.view === "object" && !raw ? renderView(reply.data) : reply.data);
  if (isMatchOver(reply.data)) progress("match_over", { winner: reply.data.winner ?? null }, env);
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

export async function main(argv, { env = process.env, clock = realClock } = {}) {
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
        return status(env);
      case "leave":
        print(await leaveQueue(seatContext({ config: readConfig(env), env, clock })));
        return 0;
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
        return await matchCall(positional[0], args, env, clock, { raw: flags.raw === true });
      }
      case "observer":
        return await observer(positional[0], flags, env, clock);
      default: {
        const { raw, json, ...named } = flags;
        const args = { ...(typeof json === "string" ? JSON.parse(json) : {}), ...Object.fromEntries(Object.entries(named).map(([k, v]) => [k, coerce(v)])) };
        return await matchCall(command, args, env, clock, { raw: raw === true });
      }
    }
  } catch (error) {
    err(`antwars-seat ${command ?? ""}: ${redact(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

