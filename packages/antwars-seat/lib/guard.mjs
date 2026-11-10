// One game command per shell command. A game command is any match tool call
// other than observe and rules. Every process one shell command starts (a
// chain, a loop, a background job, a wrapper shell, a script and its children)
// shares that shell command's process session, so the harness keys each game
// command on the session id plus its leader's start time (safe against pid
// reuse) and sends at most one game command per key. The record lives in the
// seat's state dir (state/game-command.<session id>, holding the leader's
// start time) and is created exclusively, so two processes of one shell
// command can never both send. A record is dropped once its session leader has
// exited.
//
// Where the key cannot be read:
// - no /proc (not Linux): the harness cannot tell shell commands apart and
//   sends the command;
// - the session leader is gone (the shell command that started this process
//   has already ended): the command is refused.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.mjs";

const RECORD = /^game-command\.(\d+)$/;

/** Match tools that are never counted and never refused by this guard. */
export const UNCOUNTED_TOOLS = Object.freeze(new Set(["observe", "rules"]));

export function isGameCommand(tool) {
  return !UNCOUNTED_TOOLS.has(tool);
}

/** Reads /proc/<pid>/stat ("self" for this process). Throws when it cannot. */
export function procStat(pid) {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

/** The fields after the command name: index 0 is field 3 (state), 3 is field 6 (session), 19 is field 22 (starttime). */
function statFields(text) {
  return text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
}

/** Start time of session sid's leader, or null when no live process is that session's leader. */
function leaderStart(sid, readStat) {
  let fields;
  try {
    fields = statFields(readStat(sid));
  } catch {
    return null;
  }
  // A zombie leader has exited: its shell command has ended.
  return fields[0] !== "Z" && Number(fields[3]) === sid && fields[19] ? fields[19] : null;
}

/**
 * The shell command this process belongs to:
 * { status: "ok", sid, start } | { status: "no_proc" } | { status: "leader_gone" }.
 */
export function shellCommandKey(readStat = procStat) {
  let fields;
  try {
    fields = statFields(readStat("self"));
  } catch {
    return { status: "no_proc" };
  }
  const sid = Number(fields[3]);
  if (!Number.isSafeInteger(sid) || sid <= 0) return { status: "no_proc" };
  const start = leaderStart(sid, readStat);
  return start === null ? { status: "leader_gone" } : { status: "ok", sid, start };
}

/** Drop records whose session leader is no longer the live process that started it. */
function pruneEnded(dir, readStat, keep) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const sid = Number(RECORD.exec(name)?.[1]);
    if (!sid || sid === keep) continue;
    let recorded;
    try {
      recorded = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (leaderStart(sid, readStat) !== recorded) rmSync(join(dir, name), { force: true });
  }
}

/** Exclusive create of this session's record; true when this process made it. */
function claim(file, start) {
  try {
    writeFileSync(file, start, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Claims this shell command's one game command. Returns { allowed: true } or
 * { allowed: false, reason: "second_in_shell_command" | "shell_command_ended" }.
 */
export function claimGameCommand(env, readStat = procStat) {
  const key = shellCommandKey(readStat);
  if (key.status === "no_proc") return { allowed: true };
  if (key.status === "leader_gone") return { allowed: false, reason: "shell_command_ended" };
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  pruneEnded(dir, readStat, key.sid);
  const file = join(dir, `game-command.${key.sid}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (claim(file, key.start)) return { allowed: true };
    let recorded = null;
    try {
      recorded = readFileSync(file, "utf8");
    } catch {
      // Removed meanwhile: try again.
    }
    if (recorded === key.start) return { allowed: false, reason: "second_in_shell_command" };
    // A record from an earlier session whose leader had this pid: it has ended.
    if (recorded !== null) rmSync(file, { force: true });
  }
  return { allowed: false, reason: "second_in_shell_command" };
}

const WHY = {
  second_in_shell_command: "this shell command has already sent a game command",
  shell_command_ended: "the shell command that started it has already ended",
};

/** The refusal printed to the seat. */
export function refusalMessage(tool, reason) {
  return `${tool} refused, not sent: ${WHY[reason]}. The harness sends at most one game command `
    + "(any match tool other than observe and rules) per shell command; send the next game command in its own shell command.";
}
