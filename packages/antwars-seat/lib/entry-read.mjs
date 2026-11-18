// entry-read: one read-only entry call, read_lobby or queue_status, for the key
// a name in the house key file holds. It needs no seat setup, keeps no seat
// state and writes no file. The key is read with readKey, which registers it
// for redaction, so it never appears in anything printed.
import { readFileSync } from "node:fs";
import { ALLOW_HTTP_ENV, McpClient } from "./mcp.mjs";
import { addSecret } from "./redact.mjs";
import { DEFAULT_ENTRY_URL, keyFilePath, readKey } from "./state.mjs";

export const ENTRY_READ_TOOLS = Object.freeze(["read_lobby", "queue_status"]);
export const ENTRY_READ_USAGE = "usage: antwars-seat entry-read <read_lobby|queue_status> --key-name NAME ['<json args>']";

/**
 * Registers every value in the key file for redaction, so a value typed where a name belongs
 * (--key-name) is never echoed by the missing-key message. An unreadable file is left to readKey.
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
    if (at <= 0) continue;
    const raw = line.slice(at + 1).trim();
    addSecret(raw);
    addSecret(raw.replace(/^"|"$/g, ""));
    try {
      addSecret(JSON.parse(raw));
    } catch {
      // Not JSON: its raw and unquoted forms are registered above.
    }
  }
}

/** One entry call with the named key as `key`. Returns { ok, data }; throws before sending on any local problem. */
export async function entryRead({ tool, keyName, argsText, env, clock, cwd = process.cwd() }) {
  if (typeof tool !== "string" || typeof keyName !== "string" || keyName === "") throw new Error(ENTRY_READ_USAGE);
  // The refused argument is not echoed: it is untrusted and could be a key typed in the wrong place.
  if (!ENTRY_READ_TOOLS.includes(tool)) throw new Error(`entry-read reads only ${ENTRY_READ_TOOLS.join(" and ")}; that tool is refused and nothing was sent`);
  // Read the key first: any later message that could carry it, or any other value in the file, is redacted from here on.
  redactKeyFileValues(env, cwd);
  const key = readKey(keyName, env, cwd);
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
