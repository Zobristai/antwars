// One game command per shell command. A game command is any match tool call
// other than observe and rules. Every process one shell command starts (a
// chain, a loop, a background job, a wrapper shell, a script and its children)
// shares that shell command's process session, so the harness keys each game
// command on the session id plus its leader's start time (safe against pid
// reuse) and sends at most one game command per key. The record is an empty
// file in the seat's state dir named by the key (state/game-command.<session
// id>.<leader start time>), made by one exclusive create, so two processes of
// one shell command can never both send. A record is dropped once its session
// leader has exited.
//
// The unit is the process session: a shell that starts each command in a new
// session gives each command its own game command. Commands typed one after
// another into one long-lived shell share that shell's session, so after its
// first game command that shell's further game commands are refused until it
// exits.
//
// Where the key cannot be read:
// - no /proc (not Linux): the harness cannot tell shell commands apart and
//   sends the command;
// - the session leader is gone (the shell command that started this process
//   has already ended): the command is refused.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.mjs";

const RECORD = /^game-command\.(\d+)\.(\d+)$/;

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

/** Drop records whose session leader is no longer the live process they were made for. A live session's record always matches, so it is never dropped. */
function pruneEnded(dir, readStat) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = RECORD.exec(name);
    if (match && leaderStart(Number(match[1]), readStat) !== match[2]) rmSync(join(dir, name), { force: true });
  }
}

/**
 * Claims this shell command's one game command. Returns { allowed: true } or
 * { allowed: false, reason: "second_in_shell_command" | "shell_command_ended" }.
 * The whole key is the record's name and the record is made by one exclusive create,
 * so exactly one process of a shell command can make it, and no other process ever
 * reads, rewrites or replaces a record of a live session.
 */
export function claimGameCommand(env, readStat = procStat) {
  const key = shellCommandKey(readStat);
  if (key.status === "no_proc") return { allowed: true };
  if (key.status === "leader_gone") return { allowed: false, reason: "shell_command_ended" };
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  pruneEnded(dir, readStat);
  try {
    writeFileSync(join(dir, `game-command.${key.sid}.${key.start}`), "", { flag: "wx" });
    return { allowed: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { allowed: false, reason: "second_in_shell_command" };
  }
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
