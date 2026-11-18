// entry-read: one read-only entry call, read_lobby or queue_status, for the key
// a name in the house key file holds. It needs no seat setup, keeps no seat
// state and writes no file. The key file is read once; that one read gives the
// selected key, the redaction set and the argument check, and the command
// refuses before sending unless every value in it can be redacted. No message
// echoes the tool, key name or any value: any of them could be a key.
import { readFileSync } from "node:fs";
import { ALLOW_HTTP_ENV, McpClient } from "./mcp.mjs";
import { MIN_SECRET_LENGTH, addSecret } from "./redact.mjs";
import { DEFAULT_ENTRY_URL, keyFilePath, parseKeyValue } from "./state.mjs";

export const ENTRY_READ_TOOLS = Object.freeze(["read_lobby", "queue_status"]);
const KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENTRY_READ_USAGE = "usage: antwars-seat entry-read <read_lobby|queue_status> --key-name NAME ['<json args>']";

const UNREADABLE = "the house key file is not readable; nothing was sent";
const UNSAFE_FILE = `the house key file has a line entry-read cannot keep out of output (a name that is not letters, digits and _, or a value shorter than ${MIN_SECRET_LENGTH} characters); nothing was sent`;
const KEY_FAILURES = {
  not_found: "the named key is not in the house key file; nothing was sent",
  not_json: "the named key's line is not a JSON string; nothing was sent",
  empty: "the named key is empty; nothing was sent",
};

/**
 * Reads the house key file once and returns { key, values }: the named key and every value in the
 * file. Key lines are NAME=value lines that are not comments (first non-space character #); lines
 * without = hold nothing. A value is parsed as the harness key reader parses it, or kept as its raw
 * text where it does not parse; empty values hold nothing. Unless every key line has a plain
 * identifier name and every value is long enough to redact, the command is refused, so every value
 * it can meet is registered for redaction. Any failure refuses before anything is sent.
 */
function readKeyFile(keyName, env, cwd) {
  const path = keyFilePath(env, cwd);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(UNREADABLE);
  }
  const values = new Set();
  let selected;
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at < 0 || line.trimStart().startsWith("#")) continue;
    const name = line.slice(0, at).trim();
    if (!KEY_NAME_PATTERN.test(name)) throw new Error(UNSAFE_FILE);
    const raw = line.slice(at + 1).trim();
    const parsed = parseKeyValue(raw);
    if (selected === undefined && name === keyName) selected = parsed;
    if (parsed.error === "empty") continue;
    const value = parsed.value ?? raw;
    if (value.length < MIN_SECRET_LENGTH) throw new Error(UNSAFE_FILE);
    values.add(value);
  }
  for (const value of values) addSecret(value);
  if (selected === undefined) throw new Error(KEY_FAILURES.not_found);
  if (selected.error) throw new Error(KEY_FAILURES[selected.error]);
  return { key: selected.value, values };
}

/** Whether any string, property name or scalar anywhere in `args` contains one of `values`. */
function carriesAny(args, values) {
  const has = (text) => [...values].some((value) => text.includes(value));
  const walk = (node) => {
    if (typeof node === "string") return has(node);
    if (node === null || typeof node === "number" || typeof node === "boolean") return has(String(node));
    if (typeof node !== "object") return false;
    return Object.entries(node).some(([name, child]) => has(name) || walk(child));
  };
  return walk(args);
}

/** One entry call with the named key as `key`. Returns { ok, data }; throws before sending on any local problem. */
export async function entryRead({ tool, keyName, argsText, env, clock, cwd = process.cwd() }) {
  if (typeof tool !== "string" || typeof keyName !== "string" || keyName === "") throw new Error(ENTRY_READ_USAGE);
  if (!ENTRY_READ_TOOLS.includes(tool)) throw new Error(`entry-read reads only ${ENTRY_READ_TOOLS.join(" and ")}; that tool is refused and nothing was sent`);
  if (!KEY_NAME_PATTERN.test(keyName)) throw new Error("a key name is letters, digits and _ only, not starting with a digit; nothing was sent");
  const { key, values } = readKeyFile(keyName, env, cwd);
  let args = {};
  if (argsText !== undefined) {
    try {
      args = JSON.parse(argsText);
    } catch {
      throw new Error("entry-read arguments are not valid JSON");
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("entry-read arguments must be a JSON object");
    // A server may echo its arguments, so no argument may carry any value from the key file.
    if (carriesAny(args, values)) throw new Error("entry-read arguments contain a value from the house key file; nothing was sent");
  }
  // No limiter, log or session file: nothing is written.
  const client = new McpClient({ url: env.ANTWARS_ENTRY_URL || DEFAULT_ENTRY_URL, clock, allowHttp: env[ALLOW_HTTP_ENV] === "1" });
  return client.callTool(tool, { ...args, key });
}
