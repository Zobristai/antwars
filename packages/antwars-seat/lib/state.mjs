// Seat state lives in <cwd>/.antwars-seat/state/ (ANTWARS_SEAT_STATE overrides).
// Nothing written here ever contains the seat key: config.json names the key,
// and every write passes through redact().
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSecret, redact } from "./redact.mjs";

export const DEFAULT_ENTRY_URL = "https://antwars.ai/mcp";
export const KEY_FILE_NAME = "antwars-house-keys.env";
export const NO_KEY_FILE = `No house key file. Set ANTWARS_KEY_FILE to your key file, or ANTWARS_SEAT_STORE to the .git directory of an antwar checkout that holds ${KEY_FILE_NAME} (see .antwars-seat/README.md).`;

export function stateDir(env = process.env, cwd = process.cwd()) {
  return env.ANTWARS_SEAT_STATE || join(cwd, ".antwars-seat", "state");
}

export function statePath(name, env = process.env, cwd = process.cwd()) {
  return join(stateDir(env, cwd), name);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, redact(JSON.stringify(value, null, 2)) + "\n");
  renameSync(tmp, path);
}

/**
 * One timestamped line in progress.log; also mirrored to status.json, which keeps the
 * earlier fields of the current run. fresh starts status.json over (a new go or join-lobby run).
 */
export function progress(step, detail = {}, env = process.env, { fresh = false } = {}) {
  const at = new Date().toISOString();
  const line = redact(JSON.stringify({ at, step, ...detail }));
  mkdirSync(stateDir(env), { recursive: true });
  appendFileSync(statePath("progress.log", env), line + "\n");
  const status = fresh ? {} : readJson(statePath("status.json", env), {});
  writeJson(statePath("status.json", env), { ...status, step, at, ...detail });
  return line;
}

const CONFIG_FIELDS = ["handle", "keyName", "mode", "seat", "queuing", "parallel", "modelLabel", "thinkingLevel", "serviceTier", "entryUrl"];

export function readConfig(env = process.env) {
  const config = readJson(statePath("config.json", env));
  if (config === null) throw new Error("No seat setup found. Run: antwars-seat setup --handle <h> --key-name <NAME> --mode <mode> --model-label <label> --thinking-level <level> [--seat N] [--service-tier fast]");
  return { ...config, entryUrl: env.ANTWARS_ENTRY_URL || config.entryUrl || DEFAULT_ENTRY_URL };
}

export function writeConfig(fields, env = process.env) {
  const config = Object.fromEntries(CONFIG_FIELDS.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]]));
  writeJson(statePath("config.json", env), config);
  return config;
}

/** state/seat.json: readyAt (ms, written once) and ownJoinedAt (joinedAt of this seat's own join_queue). */
export function readSeat(env = process.env) {
  return readJson(statePath("seat.json", env), {});
}

export function updateSeat(fields, env = process.env) {
  const seat = { ...readSeat(env), ...fields };
  writeJson(statePath("seat.json", env), seat);
  return seat;
}

/** The seat's ready time: recorded by the first setup or go, never overwritten. */
export function ensureReadyAt(env, clock) {
  const seat = readSeat(env);
  if (Number.isFinite(seat.readyAt)) return seat.readyAt;
  return updateSeat({ readyAt: clock.now() }, env).readyAt;
}

/**
 * Key file: ANTWARS_KEY_FILE, else <ANTWARS_SEAT_STORE>/antwars-house-keys.env, else
 * <git common dir>/antwars-house-keys.env when it exists. Otherwise there is no default:
 * it throws NO_KEY_FILE, naming both settings.
 */
export function keyFilePath(env = process.env, cwd = process.cwd()) {
  if (env.ANTWARS_KEY_FILE) return env.ANTWARS_KEY_FILE;
  if (env.ANTWARS_SEAT_STORE) return join(env.ANTWARS_SEAT_STORE, KEY_FILE_NAME);
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const local = join(common, KEY_FILE_NAME);
    if (existsSync(local)) return local;
  } catch {
    // Not a git checkout: only the settings above can name the key file.
  }
  throw new Error(NO_KEY_FILE);
}

/** Read one key by name (lines NAME=<JSON string>). The value is registered for redaction and never returned to output. */
export function readKey(keyName, env = process.env, cwd = process.cwd()) {
  const file = keyFilePath(env, cwd);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`House key file not readable: ${file}`);
  }
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0 || line.slice(0, at).trim() !== keyName) continue;
    const raw = line.slice(at + 1).trim();
    let value;
    try {
      value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch {
      throw new Error(`Key ${keyName} in ${file} is not a JSON string`);
    }
    if (typeof value !== "string" || value === "") throw new Error(`Key ${keyName} in ${file} is empty`);
    addSecret(value);
    return value;
  }
  throw new Error(`Key ${keyName} not found in ${file}`);
}

/**
 * Seat-wide call spacing shared by every harness process of this seat (go,
 * commands, observer) through a timestamp file: the server allows about 2 calls/s.
 */
export function makeLimiter({ file, minIntervalMs, clock }) {
  return async function waitTurn() {
    if (minIntervalMs <= 0) return;
    let last = 0;
    try {
      last = Number(readFileSync(file, "utf8")) || 0;
    } catch {
      // First call of this seat.
    }
    const wait = last + minIntervalMs - clock.now();
    if (wait > 0) await clock.sleep(wait);
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, String(clock.now()));
    } catch {
      // Spacing is best effort; the server's call_rate refusal is retried anyway.
    }
  };
}

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) ? value : fallback;
}

/** True when a process with this pid is alive. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
