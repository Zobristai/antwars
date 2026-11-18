// Seat state lives in <cwd>/.antwars-seat/state/ (ANTWARS_SEAT_STATE overrides).
// Nothing written here ever contains the seat key: config.json names the key,
// and every write passes through redact().
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

/** Creates path holding token, its content complete the moment it exists; false when path already exists. */
function createOwned(path, token) {
  const tmp = `${path}.${token}.tmp`;
  writeFileSync(tmp, token);
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The token a lock file holds, or null when there is none. */
function readToken(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** A lock token names its owner's pid first. */
function ownerAlive(token) {
  return alive(Number.parseInt(token, 10));
}

/**
 * Removes the lock at path only while it still holds deadToken, the token of an owner that died. The right to remove
 * that one lock is itself an owned file, path.takeover.<deadToken>, created exclusively: of several processes
 * recovering it at once exactly one removes it, and none can ever remove a later lock, which holds another token. A
 * lock with deadToken is removed by nothing else, so it cannot change between the check and the removal. A recoverer
 * that died holding the right is recovered the same way.
 */
export function removeDeadLock(path, deadToken, token) {
  const claim = `${path}.takeover.${deadToken}`;
  while (!createOwned(claim, token)) {
    const holder = readToken(claim);
    if (holder === null) continue;
    if (ownerAlive(holder)) return;
    removeDeadLock(claim, holder, token);
  }
  try {
    if (readToken(path) === deadToken) rmSync(path);
  } finally {
    rmSync(claim, { force: true });
  }
}

/**
 * Runs fn holding state/status.lock, so the read, merge and write of status.json by this seat's processes (go, match
 * commands, the observer) never interleave and one cannot overwrite another's fields. The lock holds its owner's token
 * (pid and a random part); it is released only by that owner, and taken over through removeDeadLock only once the
 * owner's pid is no longer running. A live owner's lock is never taken, however long it is held.
 */
function withStatusLock(env, fn) {
  mkdirSync(stateDir(env), { recursive: true });
  const lock = statePath("status.lock", env);
  const token = `${process.pid}-${randomUUID()}`;
  while (!createOwned(lock, token)) {
    const holder = readToken(lock);
    if (holder === null) continue;
    if (ownerAlive(holder)) Atomics.wait(LOCK_WAIT, 0, 0, 5);
    else removeDeadLock(lock, holder, token);
  }
  try {
    return fn();
  } finally {
    if (readToken(lock) === token) rmSync(lock, { force: true });
  }
}

function writeProgress(step, detail, env, status) {
  const at = new Date().toISOString();
  const line = redact(JSON.stringify({ at, step, ...detail }));
  appendFileSync(statePath("progress.log", env), line + "\n");
  writeJson(statePath("status.json", env), { ...status, step, at, ...detail });
  return line;
}

/**
 * One timestamped line in progress.log; also mirrored to status.json, which keeps the
 * earlier fields of the current run. fresh starts status.json over (a new go or join-lobby run).
 */
export function progress(step, detail = {}, env = process.env, { fresh = false } = {}) {
  return withStatusLock(env, () => writeProgress(step, detail, env, fresh ? {} : readJson(statePath("status.json", env), {})));
}

/**
 * progress() decided from the current status under the same lock: decide(current) returns { step, detail } to write,
 * or null to write nothing. Returns the logged line, or null.
 */
export function progressFrom(decide, env = process.env) {
  return withStatusLock(env, () => {
    const current = readJson(statePath("status.json", env), {});
    const next = decide(current);
    return next === null ? null : writeProgress(next.step, next.detail, env, current);
  });
}

/** progress() detail that removes these fields from status.json: a field set to undefined is not written. */
export function dropped(fields) {
  return Object.fromEntries(fields.map((field) => [field, undefined]));
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

/**
 * state/seat.json: readyAt (ms, written once), ownJoinedAt (joinedAt of this seat's own join_queue), and the wait link of
 * the latest go or join-lobby: waitUrl, waitToken (not a secret), waitFrom (the reply it came from) and waitSavedAt.
 */
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
