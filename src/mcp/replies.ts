import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SimConfig } from "../sim/config.js";
import type { AgentView, ViewCell } from "../sim/view.js";
import { VISIBLE_EVENT_KINDS, denseCells } from "../sim/view.js";
import type { Game, ObserveEvent } from "./game.js";
import { packTerritory } from "./territory.js";
import { packMarks } from "./markTable.js";
import { cellContinuation } from "./cellPages.js";
import { usesCompactAgentText } from "./briefing.js";

/** Command replies (not rules, join or observe) retain their existing budgets. Both MCP copies are preserved. */
export const MAX_REPLY_BYTES = 40_960;
export const MAX_TEXT_CHARS = 20_000;
/** Fixed budgets, including both MCP copies; never increased for caste metadata.
 * 49,000 text characters stays under Claude Code's measured 50,000-character
 * inline limit; bytes keep the previous 68,950 / 33,000 ratio (102,380 bytes).
 * The event page stays at 20 as a paging choice; history remains losslessly cursor-paged.
 * Join/reconnect share these budgets.
 */
export const MAX_OBSERVE_TEXT_CHARS = 49_000;
export const MAX_OBSERVE_REPLY_BYTES = 102_380;
/** Rules replies share the join/observe budget: 49,000 characters / 102,380 bytes, no headroom.
 * Test-enforced; the rules tool has no runtime size check. */
export const MAX_RULES_TEXT_CHARS = MAX_OBSERVE_TEXT_CHARS;
export const MAX_RULES_REPLY_BYTES = MAX_OBSERVE_REPLY_BYTES;
export const MAX_EVENT_PAGE = 20;
export interface ReplyLimits { readonly textChars: number; readonly bytes: number }
export const DEFAULT_REPLY_LIMITS: ReplyLimits = { textChars: MAX_TEXT_CHARS, bytes: MAX_REPLY_BYTES };
export const OBSERVE_REPLY_LIMITS: ReplyLimits = { textChars: MAX_OBSERVE_TEXT_CHARS, bytes: MAX_OBSERVE_REPLY_BYTES };
export const RULES_REPLY_LIMITS: ReplyLimits = { textChars: MAX_RULES_TEXT_CHARS, bytes: MAX_RULES_REPLY_BYTES };

export function payload(data: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

/** Only explicit caste restrictions cross the MCP boundary. Never mutate the sim view or history. */
export function publicCountCaste<T extends { readonly caste?: string }>(value: T): Omit<T, "caste"> & { caste?: "worker" | "soldier" } {
  const { caste, ...fields } = value;
  return caste === "worker" || caste === "soldier" ? { ...fields, caste } : fields;
}

/** Rules 27: a queen entry names her owner as the caller reads it, never as an agentId:
 * "you", else the teammate's display name, else its model label, else "a teammate". */
export function publicQueen<T extends { readonly owner?: string }>(game: Game, agentId: string, queen: T): T {
  if (queen.owner === undefined) return queen;
  const info = queen.owner === agentId ? undefined : game.agentInfo(queen.owner);
  return { ...queen, owner: queen.owner === agentId ? "you" : info?.displayName ?? info?.modelLabel ?? "a teammate" };
}

/** Whether VISIBLE_EVENT_KINDS restricts this event's caste at the MCP boundary; seat notices carry none. */
function restrictsCaste(event: ObserveEvent): event is ObserveEvent & { readonly caste?: string } {
  return Object.hasOwn(VISIBLE_EVENT_KINDS, event.type) && VISIBLE_EVENT_KINDS[event.type as keyof typeof VISIBLE_EVENT_KINDS].publicCaste;
}

export function publicEvent(event: ObserveEvent): ObserveEvent {
  return restrictsCaste(event) ? publicCountCaste(event) as ObserveEvent : event;
}

export function fitsReply(reply: CallToolResult, limits: ReplyLimits = DEFAULT_REPLY_LIMITS): boolean {
  return Buffer.byteLength(JSON.stringify(reply)) <= limits.bytes && reply.content.every(c => c.type !== "text" || c.text.length <= limits.textChars);
}

type CountMarkNotice = Omit<Extract<ObserveEvent, { type: "count_mark_accepted" }>, "message" | "availability"> & {
  /** Pass to observe since to replay this event with its complete details. */
  readonly detailsSince: number;
};
type CurrentEvent = Exclude<ObserveEvent, { type: "count_mark_accepted" }> | CountMarkNotice;

/** Current notices identify accepted count marks without repeating verbose command
 * details. Their original message/availability remain in lossless since history. */
export function currentEvent(event: ObserveEvent, index: number): CurrentEvent {
  if (event.type !== "count_mark_accepted") return publicEvent(event) as CurrentEvent;
  const { message: _message, availability: _availability, ...notice } = event;
  return { ...(restrictsCaste(event) ? publicCountCaste(notice) : notice), detailsSince: index };
}

/** Enemy queens restated from exactly the cells this reply encodes: same page,
 * same cellsTick, same sight and the same milli-HP; nothing the cells omit. */
function enemyQueensOf(cells: readonly ViewCell[], colony: AgentView["colony"]): { tileX: number; tileY: number; hp?: number }[] {
  return cells.filter(cell => cell.queen !== undefined && cell.queen !== colony)
    .map(cell => ({ tileX: cell.tileX, tileY: cell.tileY, ...(cell.queenHp === undefined ? {} : { hp: cell.queenHp }) }));
}

/** Full current view; default events are a live sample, explicit since is lossless replay. */
export function pagedView(game: Game, config: SimConfig, view: AgentView, withMap: boolean,
  extra: Record<string, unknown> = {}, since?: number, limits: ReplyLimits = DEFAULT_REPLY_LIMITS, cellsCursor?: string, freshCells = true): CallToolResult {
  // The sim names colonies by id; the match may have drawn its own names (an unrated lobby).
  const publicView = { ...view, colonyName: game.colonyNames(view.agentId)[view.colony], marks: view.marks.map(publicCountCaste), myMarks: view.myMarks.map(publicCountCaste),
    ...(view.queens === undefined ? {} : { queens: view.queens.map(queen => publicQueen(game, view.agentId, queen)) }) };
  const page = game.cellsFor(view, config, cellsCursor, freshCells);
  const cellError = (code: string, message: string) => payload({ error: { code, message, howToFix: "Omit cellsCursor to start a fresh cell traversal; keep event since separate." }, tick: view.tick }, true);
  if (page === null) return cellError("bad_cells_cursor", "Cell cursor is stale, foreign, malformed or no longer retained.");
  const { snapshot, offset } = page;
  let end = offset === 0 ? Math.max(snapshot.squadCells, Math.min(1, snapshot.cells.length)) : Math.min(offset + 1, snapshot.cells.length);
  const { cells: _cells, events: _events, territoryRows, ...rest } = publicView;
  const { secondsLeft: _secondsLeft, ticksLeft: _ticksLeft, ...ended } = rest;
  const compact = { ...(view.result === null ? rest : ended), ...(withMap ? { territory: packTerritory(territoryRows, config.mapWidth, config.mapHeight) } : {}) };
  const history = game.eventHistory(view.agentId);
  let cursor = since ?? game.eventCursor(view.agentId);
  const indices: number[] = [];
  const priorities = game.pendingPriorityEvents(view.agentId);
  let priorityCount = 0;
  let markTables: { marks: ReturnType<typeof packMarks>; myMarks: ReturnType<typeof packMarks> } | undefined;
  // Built inside result() so the page-fit search measures the list with its cells.
  const listsEnemyQueens = usesCompactAgentText(config);
  const result = () => cellPage(payload({ ...extra, view: { ...compact, ...markTables,
    cells: denseCells(snapshot.cells.slice(offset, end), config.mapWidth, config.mapHeight), ...cellContinuation(snapshot, end),
    ...(listsEnemyQueens ? { enemyQueens: enemyQueensOf(snapshot.cells.slice(offset, end), view.colony) } : {}),
    events: indices.toSorted((a, b) => a - b).map(i => since === undefined ? currentEvent(history[i]!, i) : publicEvent(history[i]!)),
    eventsMode: since === undefined ? "current" : "history",
    eventCursor: cursor, eventsMore: cursor < history.length,
    ...(since === undefined ? { priorityEventsMore: priorityCount < priorities.length } : {}),
  } }), offset, end - offset);

  // Prefer the established object arrays. Compact only when the full view or
  // its first event cannot fit: otherwise ordinary event paging is sufficient.
  const fitsCurrent = () => {
    if (fitsReply(result(), limits)) return true;
    if (markTables === undefined) {
      markTables = { marks: packMarks(publicView.marks), myMarks: packMarks(publicView.myMarks) };
      return fitsReply(result(), limits);
    }
    return false;
  };
  if (!fitsCurrent()) return cellError("observe_reply_too_large", "Mandatory squad cells and metadata exceed the reply limits.");

  const finish = (): CallToolResult => {
    let low = end, high = snapshot.cells.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      end = middle;
      if (fitsCurrent()) low = middle;
      else high = middle - 1;
    }
    end = low;
    if (!fitsCurrent()) return cellError("observe_reply_too_large", "Cell page cannot fit within the reply limits.");
    if (end < snapshot.cells.length) snapshot.offsets.add(end);
    return result();
  };

  if (since !== undefined) {
    // Only explicit replay advances the chronological continuation. No sampled
    // event can cause older, unsent history to be skipped by this cursor.
    for (; cursor < history.length && indices.length < MAX_EVENT_PAGE;) {
      indices.push(cursor++);
      if (!fitsCurrent()) { indices.pop(); cursor -= 1; break; }
    }
    const reply = finish();
    if (reply.isError !== true) game.acknowledgeEvents(view.agentId, cursor);
    return reply;
  } else {
    // Critical events survive indefinitely and drain before any fight traffic.
    // If a burst exceeds either cap, the unsent suffix remains queued.
    for (const index of priorities) {
      if (indices.length >= MAX_EVENT_PAGE) break;
      indices.push(index);
      priorityCount += 1;
      if (!fitsCurrent()) { indices.pop(); priorityCount -= 1; break; }
    }
    const pending = new Set(priorities);
    const oldestTick = view.tick - config.commandFloorTicks;
    for (let i = history.length - 1; i >= game.currentEventCursor(view.agentId) && indices.length < MAX_EVENT_PAGE; i--) {
      if (pending.has(i) || history[i]!.tick < oldestTick) continue;
      indices.push(i);
      if (!fitsCurrent()) { indices.pop(); break; }
    }
    // Build before acknowledgement: priorities is a live reference to the queue.
    const reply = finish();
    if (reply.isError !== true) game.acknowledgeCurrentEvents(view.agentId, history.length, priorityCount);
    return reply;
  }
}

/**
 * Match recording: a stored entry's arguments and reply together
 * are at most this many bytes of JSON.
 */
export const STORED_ENTRY_BYTES = 8_192;
/** Replies stored trimmed; every other tool's reply is a command reply, stored in full. join covers reconnect (join with a token). */
const TRIMMED_REPLY_TOOLS: ReadonlySet<string> = new Set(["observe", "join", "rules"]);
/** Map state the record's replay rebuilds at any tick: never stored. */
const DROPPED_VIEW_FIELDS = ["cells", "territory", "enemyQueens"] as const;
/**
 * Every field that carries a credential in a recorded tool's arguments or reply,
 * matched by name at any depth and stored as redactedMarker(name). Enumerated from the source of every tool a match
 * server registers (game tools and the 21 account tools) at main 6b06ecf0:
 * - reconnectToken, token: entry-server join arguments; join reply reconnectToken.
 * - key: slot join argument and every account tool's key argument; claim_username, rotate_key, create_handle,
 *   reissue_handle_key and recover_key replies (recover_key added since that enumeration).
 * - inviteToken: join_lobby and read_lobby arguments; create_lobby and issue_invite replies.
 * - inviteLink: create_lobby and issue_invite replies (the invite token is its #invite= fragment).
 */
export const CREDENTIAL_FIELDS: ReadonlySet<string> = new Set(["reconnectToken", "token", "key", "inviteToken", "inviteLink"]);
/** The fixed value a credential field is stored as. */
export const redactedMarker = (field: string): string => `[redacted ${field}]`;

/**
 * Text served to agents that the match recording carries whole, once per match, uncapped: the rules text, the join
 * briefing and the tool descriptions. Entries name it by digest.
 */
export interface ServedText {
  readonly kind: "rules" | "briefing" | "tools";
  /** SHA-256 of text, lowercase hex. */
  readonly digest: string;
  readonly text: string;
}

export function servedText(kind: ServedText["kind"], text: string): ServedText {
  return { kind, digest: createHash("sha256").update(text, "utf8").digest("hex"), text };
}

/** The reply field each tool's served text travels in: stored as served text, the reply naming its digest in textRefs. */
const TEXT_FIELDS: Readonly<Record<string, { readonly field: string; readonly kind: ServedText["kind"] }>> = {
  rules: { field: "rules", kind: "rules" },
  join: { field: "briefing", kind: "briefing" },
};

/**
 * The cell page a pagedView reply encodes, kept beside its view object, never in what the agent receives. Keyed by the
 * view, not the reply: the SDK re-parses a tool's result into a new object, but keeps structuredContent's values as they are.
 */
const cellPages = new WeakMap<object, { readonly cellsOffset: number; readonly cellsCount: number }>();

function cellPage(reply: CallToolResult, cellsOffset: number, cellsCount: number): CallToolResult {
  const view = reply.structuredContent?.view;
  if (typeof view === "object" && view !== null) cellPages.set(view, { cellsOffset, cellsCount });
  return reply;
}

/** One call as the match recording stores it, in field order; tool and times are added by the caller. */
export interface StoredCall {
  /** The arguments exactly as sent, credentials replaced. Absent when none were sent. */
  readonly arguments?: unknown;
  /** structuredContent as the agent received it, else its content blocks (an SDK-formed error has no structuredContent). */
  readonly reply: unknown;
  readonly isError?: true;
  /**
   * Fields dropped so arguments and reply fit STORED_ENTRY_BYTES together, largest first: arguments.<name>,
   * reply.<name> or reply.view.<name>, or arguments or reply whole when not an object.
   */
  readonly trimmed?: readonly string[];
  /** How many more fields were dropped than trimmed names, past STORED_NAMES_BYTES. */
  readonly trimmedMore?: number;
  /** Paths of the credential fields stored as redactedMarker, such as arguments.key or reply.reconnectToken, within STORED_NAMES_BYTES. */
  readonly redacted?: readonly string[];
  /** How many more credential fields were redacted than redacted names. */
  readonly redactedMore?: number;
  /** Reply fields carried as served text, each with its digest: the text is in the recording's text line, not here. */
  readonly textRefs?: Readonly<Record<string, string>>;
}

/** A call's stored form, and the served text its reply carried, for the recording's text lines. */
export function storedCall(tool: string, args: unknown, result: CallToolResult): { readonly call: StoredCall; readonly texts: readonly ServedText[] } {
  const redacted: string[] = [];
  const { arguments: storedArgs, dropped } = storableArguments(args, redacted);
  const { reply, texts, textRefs } = storedReply(tool, result, redacted);
  const fitted = fitEntry(storedArgs, reply);
  if (dropped) fitted.trimmed.unshift("arguments");
  const trimmed = namesWithin(fitted.trimmed), redactedNames = namesWithin(redacted);
  return { call: { ...(args === undefined ? {} : { arguments: fitted.arguments }),
    reply: fitted.reply, ...(result.isError === true ? { isError: true as const } : {}),
    ...(fitted.trimmed.length === 0 ? {} : { trimmed: trimmed.names }), ...(trimmed.more === 0 ? {} : { trimmedMore: trimmed.more }),
    ...(redacted.length === 0 ? {} : { redacted: redactedNames.names }), ...(redactedNames.more === 0 ? {} : { redactedMore: redactedNames.more }),
    ...(textRefs === undefined ? {} : { textRefs }) }, texts };
}

/**
 * The arguments as stored, credentials redacted (paths pushed to redacted). Arguments nested too deep to redact or
 * measure (a crafted request some thousands of levels deep overflows the stack) are dropped whole, stored as null and
 * named in trimmed, so the call stays a full entry.
 */
function storableArguments(args: unknown, redacted: string[]): { readonly arguments: unknown; readonly dropped: boolean } {
  if (args === undefined) return { arguments: undefined, dropped: false };
  const found: string[] = [];
  try {
    const stored = redact(args, "arguments", found);
    jsonBytes(stored);
    redacted.push(...found);
    return { arguments: stored, dropped: false };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { arguments: null, dropped: true };
  }
}

/** A copy of value with every CREDENTIAL_FIELDS field replaced by its marker and its path named; value itself when none is present. */
function redact(value: unknown, path: string, redacted: string[]): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, i) => {
      const r = redact(item, `${path}.${i}`, redacted);
      changed ||= r !== item;
      return r;
    });
    return changed ? out : value;
  }
  if (typeof value !== "object" || value === null) return value;
  let out: Record<string, unknown> | undefined;
  for (const [key, field] of Object.entries(value)) {
    let r: unknown;
    if (CREDENTIAL_FIELDS.has(key) && field !== undefined) {
      r = redactedMarker(key);
      redacted.push(`${path}.${key}`);
    } else {
      r = redact(field, `${path}.${key}`, redacted);
    }
    if (r !== field) (out ??= { ...value as Record<string, unknown> })[key] = r;
  }
  return out ?? value;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * arguments and reply within STORED_ENTRY_BYTES of JSON together: the largest field among arguments.*, reply.* and
 * reply.view.* is dropped, then the next, until they fit; arguments or reply that is not an object is dropped whole
 * (stored as null). Every dropped field is named, largest first. Each pass measures every field once and drops in size
 * order, so a call of many small fields costs a sort, not a measurement per field dropped; a pass that leaves the entry
 * over (an estimate off by its last comma) is followed by another.
 */
function fitEntry(args: unknown, reply: unknown): { arguments: unknown; reply: unknown; trimmed: string[] } {
  const entry: { arguments?: unknown; reply: unknown } = { ...(args === undefined ? {} : { arguments: plainObject(args) ? { ...args } : args }),
    reply: plainObject(reply) ? { ...reply } : reply };
  const view = plainObject(entry.reply) && plainObject(entry.reply.view) ? { ...entry.reply.view } : undefined;
  if (view !== undefined) (entry.reply as Record<string, unknown>).view = view;
  const trimmed: string[] = [];
  for (let total = jsonBytes(entry); total > STORED_ENTRY_BYTES; total = jsonBytes(entry)) {
    const candidates: { path: string; bytes: number; saves: number; drop: () => void }[] = [];
    const field = (container: Record<string, unknown>, prefix: string, key: string) => {
      const bytes = jsonBytes(container[key]);
      candidates.push({ path: `${prefix}.${key}`, bytes, saves: bytes + jsonBytes(key) + 2, drop: () => { delete container[key]; } });
    };
    for (const name of ["arguments", "reply"] as const) {
      if (!(name in entry)) continue;
      const value = entry[name];
      if (!plainObject(value)) {
        if (value !== null) candidates.push({ path: name, bytes: jsonBytes(value), saves: jsonBytes(value) - 4, drop: () => { entry[name] = null; } });
        continue;
      }
      for (const key of Object.keys(value)) if (!(name === "reply" && key === "view" && view !== undefined)) field(value, name, key);
    }
    if (view !== undefined) for (const key of Object.keys(view)) field(view, "reply.view", key);
    if (candidates.length === 0) break;
    candidates.sort((x, y) => y.bytes - x.bytes);
    for (const candidate of candidates) {
      if (total <= STORED_ENTRY_BYTES) break;
      candidate.drop();
      trimmed.push(candidate.path);
      total -= candidate.saves;
    }
  }
  return { arguments: entry.arguments, reply: entry.reply, trimmed };
}

/**
 * An entry line's fields with its arguments and reply fitted again within STORED_ENTRY_BYTES (fitEntry) after a later
 * rewrite has grown them (a public record's agent markers, src/records/service.ts publicReplyLines); the fields newly
 * dropped are named after those already trimmed. Unchanged when they still fit.
 */
export function refitEntry(entry: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { trimmed: priorNames, trimmedMore: priorMore, ...rest } = entry;
  const stored = { ...("arguments" in entry ? { arguments: entry.arguments } : {}), reply: entry.reply };
  if (jsonBytes(stored) <= STORED_ENTRY_BYTES) return entry;
  const fitted = fitEntry(stored.arguments, stored.reply);
  const names = namesWithin([...(Array.isArray(priorNames) ? priorNames as string[] : []), ...fitted.trimmed]);
  const more = names.more + (typeof priorMore === "number" ? priorMore : 0);
  return { ...rest, ...("arguments" in entry ? { arguments: fitted.arguments } : {}), reply: fitted.reply,
    trimmed: names.names, ...(more === 0 ? {} : { trimmedMore: more }) };
}

/**
 * At most this many bytes of JSON of the names in an entry's trimmed or redacted list; the names beyond are counted,
 * not named, so a call of many fields keeps its entry within the size bound.
 */
export const STORED_NAMES_BYTES = 256;

/** names within STORED_NAMES_BYTES, in order, and how many were left out. */
function namesWithin(names: readonly string[]): { readonly names: readonly string[]; readonly more: number } {
  let bytes = 2;
  let kept = 0;
  for (const name of names) {
    bytes += jsonBytes(name) + 1;
    if (bytes > STORED_NAMES_BYTES) break;
    kept += 1;
  }
  return { names: names.slice(0, kept), more: names.length - kept };
}

/**
 * A call's reply as stored, before the entry cap (fitEntry): credentials redacted (paths pushed to redacted); a rules or
 * join reply's text carried as served text; observe, join and rules replies without the map page; command replies whole.
 */
export function storedReply(tool: string, result: CallToolResult, redacted: string[] = []): {
  readonly reply: unknown; readonly texts: readonly ServedText[]; readonly textRefs?: Readonly<Record<string, string>>;
} {
  const original: unknown = result.structuredContent ?? result.content;
  const page = typeof result.structuredContent?.view === "object" && result.structuredContent.view !== null ? cellPages.get(result.structuredContent.view) : undefined;
  let reply = redact(original, "reply", redacted);
  if (!TRIMMED_REPLY_TOOLS.has(tool)) return { reply, texts: [] };
  const texts: ServedText[] = [];
  let textRefs: Record<string, string> | undefined;
  if (typeof reply === "object" && reply !== null && !Array.isArray(reply)) {
    const top: Record<string, unknown> = { ...reply as Record<string, unknown> };
    const served = TEXT_FIELDS[tool];
    if (served !== undefined && typeof top[served.field] === "string") {
      const text = servedText(served.kind, top[served.field] as string);
      texts.push(text);
      textRefs = { [served.field]: text.digest };
      delete top[served.field];
    }
    if (typeof top.view === "object" && top.view !== null && !Array.isArray(top.view)) {
      const view: Record<string, unknown> = { ...top.view as Record<string, unknown> };
      for (const field of DROPPED_VIEW_FIELDS) delete view[field];
      if (page !== undefined) Object.assign(view, page);
      top.view = view;
    }
    reply = top;
  }
  return { reply, texts, ...(textRefs === undefined ? {} : { textRefs }) };
}
