// entry-read: one read-only entry call, read_lobby or queue_status, for the key
// a name in the house key file holds. It needs no seat setup, keeps no seat
// state and writes no file. The key is read with readKey, which registers it
// for redaction, so it never appears in anything printed. No message echoes
// the tool or key name it was given: either could be a key typed in the wrong place.
import { readFileSync } from "node:fs";
import { ALLOW_HTTP_ENV, McpClient } from "./mcp.mjs";
import { MIN_SECRET_LENGTH, addSecret } from "./redact.mjs";
import { DEFAULT_ENTRY_URL, keyFilePath, parseKeyValue, readKey } from "./state.mjs";

export const ENTRY_READ_TOOLS = Object.freeze(["read_lobby", "queue_status"]);
const KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENTRY_READ_USAGE = "usage: antwars-seat entry-read <read_lobby|queue_status> --key-name NAME ['<json args>']";

/** readKey's failures for the named key, reworded without the name. */
const KEY_FAILURES = {
  KEY_NOT_FOUND: "the named key is not in the house key file; nothing was sent",
  KEY_NOT_JSON: "the named key's line is not a JSON string; nothing was sent",
  KEY_EMPTY: "the named key is empty; nothing was sent",
};

/**
 * Registers for redaction every value readKey would return for a name entry-read takes: lines
 * NAME=value with NAME a plain identifier, value parsed exactly as readKey parses it. Comments and
 * other lines are not keys entry-read can read, so their text is never redacted from real output.
 * An unreadable file is left to readKey.
 */
function redactKeyFileValues(env, cwd) {
  let text;
  try {
    text = readFileSync(keyFilePath(env, cwd), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0 || !KEY_NAME_PATTERN.test(line.slice(0, at).trim())) continue;
    const parsed = parseKeyValue(line.slice(at + 1).trim());
    if (parsed.value !== undefined) addSecret(parsed.value);
  }
}

/** Reads the named key; every failure is reported without the name. */
function readNamedKey(keyName, env, cwd) {
  if (!KEY_NAME_PATTERN.test(keyName)) throw new Error("a key name is letters, digits and _ only, not starting with a digit; nothing was sent");
  // Before the lookup, so any value in the file is redacted from everything printed after it.
  redactKeyFileValues(env, cwd);
  let key;
  try {
    key = readKey(keyName, env, cwd);
  } catch (error) {
    if (error && KEY_FAILURES[error.code]) throw new Error(KEY_FAILURES[error.code]);
    throw error;
  }
  // Redaction covers values of MIN_SECRET_LENGTH or more, so a shorter key is never sent: no reply can echo it.
  if (key.length < MIN_SECRET_LENGTH) throw new Error(`the named key is shorter than ${MIN_SECRET_LENGTH} characters, too short to keep out of output; nothing was sent`);
  return key;
}

/** One entry call with the named key as `key`. Returns { ok, data }; throws before sending on any local problem. */
export async function entryRead({ tool, keyName, argsText, env, clock, cwd = process.cwd() }) {
  if (typeof tool !== "string" || typeof keyName !== "string" || keyName === "") throw new Error(ENTRY_READ_USAGE);
  if (!ENTRY_READ_TOOLS.includes(tool)) throw new Error(`entry-read reads only ${ENTRY_READ_TOOLS.join(" and ")}; that tool is refused and nothing was sent`);
  const key = readNamedKey(keyName, env, cwd);
  let args = {};
  if (argsText !== undefined) {
    try {
      args = JSON.parse(argsText);
    } catch {
      throw new Error("entry-read arguments are not valid JSON");
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("entry-read arguments must be a JSON object");
  }
  // No limiter, log or session file: nothing is written.
  const client = new McpClient({ url: env.ANTWARS_ENTRY_URL || DEFAULT_ENTRY_URL, clock, allowHttp: env[ALLOW_HTTP_ENV] === "1" });
  return client.callTool(tool, { ...args, key });
}
