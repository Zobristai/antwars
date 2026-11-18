// entry-read: one read-only entry call, read_lobby or queue_status, for the key
// a name in the house key file holds. It needs no seat setup, keeps no seat
// state and writes no file. The key is read with readKey, which registers it
// for redaction, so it never appears in anything printed.
import { ALLOW_HTTP_ENV, McpClient } from "./mcp.mjs";
import { DEFAULT_ENTRY_URL, readKey } from "./state.mjs";

export const ENTRY_READ_TOOLS = Object.freeze(["read_lobby", "queue_status"]);
export const ENTRY_READ_USAGE = "usage: antwars-seat entry-read <read_lobby|queue_status> --key-name NAME ['<json args>']";

/** One entry call with the named key as `key`. Returns { ok, data }; throws before sending on any local problem. */
export async function entryRead({ tool, keyName, argsText, env, clock, cwd = process.cwd() }) {
  if (typeof tool !== "string" || typeof keyName !== "string" || keyName === "") throw new Error(ENTRY_READ_USAGE);
  // The refused argument is not echoed: it is untrusted and could be a key typed in the wrong place.
  if (!ENTRY_READ_TOOLS.includes(tool)) throw new Error(`entry-read reads only ${ENTRY_READ_TOOLS.join(" and ")}; that tool is refused and nothing was sent`);
  // Read the key first: any later message that could carry it is redacted from here on.
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
