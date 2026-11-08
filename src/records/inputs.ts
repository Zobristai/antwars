import { isReplayId } from "../replays/access.js";

/**
 * One finished match's private inputs, stored by the game server as `<id>.input` in the private
 * input bucket and read by the record service. The rules version is not carried here: the log
 * header owns it and parseLog checks it. codeVersion is the full commit the game server ran.
 */
export interface RecordInput {
  id: string;
  codeVersion: string;
  /** Observed match end, epoch milliseconds. */
  endedAt: number;
  /** Private lobby id, or null for a public match. Required: absence is never read as public. */
  lobbyId: string | null;
  logLines: readonly string[];
  /**
   * The seats' call reply lines in call order (src/replays/recording.ts replyLine), each served text once before the
   * first entry naming it (textLine), when the match recorded them; absent in inputs that predate them. Stored, sealed
   * and retained with the rest of this input. Each line is one JSON object, stored as that object, not as a string,
   * so its stored bytes are the line's own (the entry cap holds on final bytes).
   */
  replyLines?: readonly string[];
  binary: Uint8Array;
  /** Version 2: never publish before actual match end plus its spectator delay. */
  publishAfter?: number;
  /** Required with publishAfter; distinguishes missing rated outcomes from unrated matches. */
  rated?: boolean;
}

const FORMAT = "antwar.input";
const VERSION = 1;
const PUBLICATION_KEYS = ["publishAfter", "rated"] as const;
const HEADER_KEYS = ["format", "version", "id", "codeVersion", "endedAt", "lobbyId", "logLines"] as const;
/** Optional in either version. */
const OPTIONAL_KEYS = ["replyLines"] as const;
const PREFIX_BYTES = 4;

export function inputName(id: string): string {
  if (!isReplayId(id)) throw new Error("invalid replay id");
  return `${id}.input`;
}

/**
 * Layout: uint32 big-endian header length, UTF-8 JSON header, then the replay binary. Reply lines are written into the
 * header verbatim as its replyLines array of objects, never serialized a second time as strings, which would escape
 * every quote and backslash again and push an entry past its cap.
 */
export function encodeInput(input: RecordInput): Uint8Array {
  const header = checkedHeader({ format: FORMAT, version: input.publishAfter === undefined ? VERSION : 2, id: input.id, codeVersion: input.codeVersion,
    endedAt: input.endedAt, lobbyId: input.lobbyId, logLines: [...input.logLines],
    ...(input.publishAfter === undefined && input.rated === undefined ? {} : { publishAfter: input.publishAfter, rated: input.rated }) });
  const json = new TextEncoder().encode(withJsonArray(JSON.stringify(header), "replyLines", input.replyLines));
  const out = new Uint8Array(PREFIX_BYTES + json.byteLength + input.binary.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength);
  out.set(json, PREFIX_BYTES);
  out.set(input.binary, PREFIX_BYTES + json.byteLength);
  return out;
}

export function decodeInput(bytes: Uint8Array): RecordInput {
  if (bytes.byteLength < PREFIX_BYTES) throw new Error("record input truncated");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (PREFIX_BYTES + length > bytes.byteLength) throw new Error("record input header truncated");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + length)));
  } catch (error) {
    throw new Error(`record input header unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const header = checkedHeader(parsed);
  return { id: header.id, codeVersion: header.codeVersion, endedAt: header.endedAt, lobbyId: header.lobbyId,
    logLines: header.logLines, ...(header.replyLines === undefined ? {} : { replyLines: header.replyLines.map(line => JSON.stringify(line)) }),
    binary: bytes.slice(PREFIX_BYTES + length),
    ...(header.version === 1 ? {} : { publishAfter: header.publishAfter!, rated: header.rated! }) };
}

interface Header {
  format: typeof FORMAT; version: 1 | 2; id: string; codeVersion: string;
  endedAt: number; lobbyId: string | null; logLines: string[]; replyLines?: Record<string, unknown>[]; publishAfter?: number; rated?: boolean;
}

function checkedHeader(value: unknown): Header {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("record input header is not an object");
  const header = value as Record<string, unknown>;
  const required = header.version === 2 ? [...HEADER_KEYS, ...PUBLICATION_KEYS] : HEADER_KEYS;
  const keys = Object.keys(header);
  const unknown = keys.filter(key => !(required as readonly string[]).includes(key) && !(OPTIONAL_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new Error(`record input has unknown fields: ${unknown.join(", ")}`);
  const missing = required.filter(key => !Object.hasOwn(header, key));
  if (missing.length > 0) throw new Error(`record input is missing fields: ${missing.join(", ")}`);
  if (header.format !== FORMAT || (header.version !== 1 && header.version !== 2)) throw new Error("record input format or version unsupported");
  if (typeof header.id !== "string" || !isReplayId(header.id)) throw new Error("record input id invalid");
  if (typeof header.codeVersion !== "string" || !/^[0-9a-f]{40}$/.test(header.codeVersion)) throw new Error("record input codeVersion must be a full commit SHA");
  if (typeof header.endedAt !== "number" || !Number.isSafeInteger(header.endedAt) || header.endedAt < 0) throw new Error("record input endedAt invalid");
  if (header.lobbyId !== null && (typeof header.lobbyId !== "string" || header.lobbyId === "")) throw new Error("record input lobbyId must be a non-empty string or null");
  if (!Array.isArray(header.logLines) || !header.logLines.every(line => typeof line === "string")) throw new Error("record input logLines must be strings");
  if (header.replyLines !== undefined && (!Array.isArray(header.replyLines) ||
      !header.replyLines.every(line => typeof line === "object" && line !== null && !Array.isArray(line)))) {
    throw new Error("record input replyLines must be JSON objects");
  }
  if (header.version === 2) {
    if (typeof header.publishAfter !== "number" || !Number.isSafeInteger(header.publishAfter) || header.publishAfter < header.endedAt) throw new Error("record input publishAfter invalid");
    if (typeof header.rated !== "boolean") throw new Error("record input rated invalid");
  }
  return header as unknown as Header;
}

/**
 * json, one serialized JSON object, with key added last as an array of lines, each a serialized JSON object written
 * verbatim; json unchanged when lines is undefined. Each line is parsed once to check it is one JSON object, one at a
 * time so none is held, and a line that is not is refused rather than corrupting the object around it.
 */
export function withJsonArray(json: string, key: string, lines: readonly string[] | undefined): string {
  if (lines === undefined) return json;
  if (!json.endsWith("}")) throw new Error("not a serialized JSON object");
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { value = undefined; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} must each be one JSON object`);
  }
  return `${json.slice(0, -1)}${json === "{}" ? "" : ","}${JSON.stringify(key)}:[${lines.join(",")}]}`;
}
