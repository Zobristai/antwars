import { isDeepStrictEqual } from "node:util";
import { historyBytes, REPLIES_NOT_RETAINED, unavailableRecord, type HistoryInput, type MatchRecord } from "../replays/history.js";
import { decodeInput, inputName, withJsonArray } from "./inputs.js";
import { markerName, parseInputObjectName, parseRunningBuildName, type InputObjectName, type InputStore } from "./input-store.js";
import type { RecordReplayStore } from "./replay-store.js";
import { recordStatus, type RecordStore, type RecordTarget } from "./record-store.js";
import { refitEntry } from "../mcp/replies.js";
import { CLOSING_STUB_RESERVE_BYTES, entryCode, SEAT_RECORD_BUDGET_BYTES } from "../replays/recording.js";

/** 30 minutes: 3.08x the 584 s production build (232.3 s locally). */
export const RECORD_TIMEOUT_MS = 1_800_000;
/** Failed builds per service code version before pausing, with input retained for a later version. */
export const MAX_FAILURES = 3;
/** Two normal rating reads, upload, and pacing/retry headroom; never an unbounded ratings wait. */
export const RECOVERY_GRACE_MS = 120_000;
export const RATINGS_UNAVAILABLE = "Rating changes were unavailable when this record was published from saved match-end inputs.";

export interface RecordServiceDeps {
  inputs: InputStore;
  /** Required for version-2 match-end inputs; owns create-only replay recovery. */
  replays?: RecordReplayStore;
  /** Record-only persistence, including sealed private records and conditional unavailable replacement. */
  records: RecordStore;
  /** Full commit this service runs (ANTWAR_CODE_VERSION). */
  codeVersion: string;
  log: (line: string) => void;
  /** Optional phase-timing lines, kept apart from `log`; absent, none are written. */
  timing?: (line: string) => void;
  now?: () => number;
  build?: (input: HistoryInput, timeoutMs: number) => Promise<Uint8Array>;
}

export interface RecordService {
  /**
   * One pass over every stored input, oldest first, one attempt each. Never throws.
   *
   * Deploy overlap: while the input bucket holds `running/<commit>` for a build other than this
   * service's own, that build's inputs are left untouched here: not built, no failure counted, no unavailable
   * record saved, so its own builder verifies them with its own simulation. The deploy writes the object when
   * it runs two builders side by side and removes it once that build's builder has stopped; the next sweep
   * then builds any leftovers as usual. With no such object (one builder, no deploy) every input is built as
   * before. A declaration for this service's own build changes nothing.
   */
  sweep(): Promise<void>;
}

/**
 * carries: for a reply-bearing input, whether a complete record already stored carries its replies, so the input is
 * deleted only once a stored record is confirmed to carry them.
 */
interface Built { target: RecordTarget; body: Uint8Array; saved: boolean; endedAt: number; carries?: (stored: Uint8Array) => boolean }
type Marker = Extract<InputObjectName, { kind: "marker" }>;

export function createRecordService(deps: RecordServiceDeps): RecordService {
  const build = deps.build ?? historyBytes;
  const now = deps.now ?? Date.now;
  const records = deps.records;
  const note = (id: string, text: string, at: number) =>
    deps.timing?.(`antwar record ${id} timing: ${text} at ${new Date(at).toISOString()}`);
  /** Elapsed from the observed match end carried in the input, not from the public release. */
  const sinceEnd = (at: number, endedAt: number) =>
    `${((at - endedAt) / 1000).toFixed(3)} s after actual match end ${new Date(endedAt).toISOString()}`;
  /** Built bytes whose save or cleanup has not finished; retried without a rebuild. */
  const built = new Map<string, Built>();
  /** Inputs that cannot be decoded or routed in this process: logged once and kept. */
  const held = new Set<string>();
  /** Unsuccessful records already persisted this process; a new version gets a fresh budget. */
  const paused = new Set<string>();
  /** publishAfter of inputs already read before it passed: not read again until then. */
  const due = new Map<string, number>();
  /** Each read input's code version; inputs are create-only, so a deferred input is not read again. */
  const versions = new Map<string, string>();
  /** Other builds declared running in the latest listing, and those already logged as deferred. */
  let running = new Set<string>();
  const deferring = new Set<string>();
  const deferred = (codeVersion: string) => codeVersion !== deps.codeVersion && running.has(codeVersion);

  function hold(id: string, reason: string) {
    if (held.has(id)) return;
    held.add(id);
    deps.log(`antwar record ${id} input kept, no record written: ${reason}`);
  }

  function failureReason(body: Uint8Array, id: string): string | null {
    const status = recordStatus(body, id);
    const record = JSON.parse(new TextDecoder().decode(body)) as MatchRecord;
    if (status === "complete") return null;
    return record.unavailable.join("; ") || `record status ${record.status}`;
  }

  async function save(id: string, entry: Built): Promise<void> {
    const result = await entry.target.save(entry.body);
    // A record this save wrote is entry.body, replies and all. A complete record already present was written by another
    // save: a reply-bearing input is deleted only when that stored record carries its replies, else kept and reported.
    // The stored record is never logged.
    const missing = result.outcome === "complete record already present" && entry.carries !== undefined &&
      !(() => { try { return entry.carries(result.stored); } catch { return false; } })();
    entry.saved = result.complete && !missing;
    const at = now();
    note(id, `${result.outcome} ${sinceEnd(at, entry.endedAt)}`, at);
    if (missing) hold(id, "a complete record is already stored without this input's call replies");
  }

  async function cleanup(id: string, markers: readonly Marker[]): Promise<void> {
    for (const marker of markers) await deps.inputs.delete(markerName(id, marker.n, marker.codeVersion));
    await deps.inputs.delete(inputName(id));
    built.delete(id);
    due.delete(id);
    versions.delete(id);
  }

  async function finish(id: string, entry: Built, markers: Marker[]): Promise<void> {
    built.set(id, entry);
    if (!entry.saved) await save(id, entry);
    if (entry.saved) await cleanup(id, markers);
    else { built.delete(id); paused.add(id); }
  }

  async function attempt(id: string, markers: Marker[]): Promise<void> {
    const pending = built.get(id);
    if (pending !== undefined) return finish(id, pending, markers);
    if (held.has(id) || paused.has(id)) return;
    const known = versions.get(id);
    if (known !== undefined && deferred(known)) return;
    const waitUntil = due.get(id);
    if (waitUntil !== undefined && now() < waitUntil) return;
    const readStart = now();
    note(id, "input read started", readStart);
    const bytes = await deps.inputs.get(inputName(id));
    const readEnd = now();
    if (bytes === null) return;
    let input;
    try { input = decodeInput(bytes); }
    catch (error) { return hold(id, error instanceof Error ? error.message : String(error)); }
    if (input.id !== id) return hold(id, `input names ${input.id}`);
    note(id, `input read ${bytes.byteLength} B in ${readEnd - readStart} ms, ${sinceEnd(readEnd, input.endedAt)}`, readEnd);
    versions.set(id, input.codeVersion);
    if (deferred(input.codeVersion)) return;
    if (input.publishAfter !== undefined) {
      // Inputs are create-only, so the deadline read once holds until the input is gone.
      if (now() < input.publishAfter) { due.set(id, input.publishAfter); return; }
      const replay = deps.replays?.forMatch(id, input.lobbyId);
      if (replay === undefined) return hold(id, "replay recovery storage is not configured");
      // A normal release may be used immediately after the delay; a missing replay gets bounded grace.
      const binary = await replay.resolve(input.binary, now() >= input.publishAfter + RECOVERY_GRACE_MS);
      if (binary === null) return;
      input = { ...input, binary };
    }
    const target = records.forMatch(id, input.lobbyId);
    if (target === undefined) return hold(id, "private archive is not configured");
    // What a stored record must carry for this input to be deleted, as withReplies writes it: the reply lines (a sealed
    // private record's as recorded, a public record's in the public form of that record's own seats), this input's
    // codeVersion, and a sealed private record's agentSeats.
    const { lobbyId, logLines, replyLines, codeVersion } = input;
    const carries = replyLines === undefined ? undefined : (stored: Uint8Array) => lobbyId !== null
      ? carriesReplies(stored, replyLines, codeVersion, privateAgentSeats(replyLines, logLines, stored))
      : carriesReplies(stored, publicReplyLines(replyLines, logLines, stored), codeVersion);

    const unavailable = (reason: string): Built => {
      // Failure is visible to readers, but its private input remains available for a later verifier. It carries no
      // replies, so a reply-bearing input is kept after it is saved; a complete record already stored deletes the input
      // only when it carries the replies (save).
      const record = { ...unavailableRecord(id, reason), endedAt: new Date(input.endedAt).toISOString() };
      return { target, body: new TextEncoder().encode(JSON.stringify(record) + "\n"), saved: false, endedAt: input.endedAt, carries };
    };
    // Match code version is provenance, not a veto: today's verifier must prove log/binary agreement
    // (unless that build's own builder is declared running, above).
    const current = markers.filter(marker => marker.codeVersion === deps.codeVersion);
    let last = current.length === 0 ? 0 : Math.max(...current.map(marker => marker.n));
    if (last >= MAX_FAILURES) {
      const reason = await deps.inputs.markerReason(id, last, deps.codeVersion) ?? "match record build kept failing";
      deps.log(`antwar record ${id} saved unavailable after ${last} failed builds: ${reason}`);
      return finish(id, unavailable(reason), markers);
    }

    let reason: string | null;
    let body: Uint8Array | undefined;
    const buildStart = now();
    note(id, `build started ${sinceEnd(buildStart, input.endedAt)}`, buildStart);
    try {
      // A public record carries what re-running its match needs; a sealed private record is unchanged.
      body = await build({ id, binary: input.binary, logLines: input.logLines, endedAt: input.endedAt, ...(input.lobbyId === null ? { rerun: true } : {}) },
        RECORD_TIMEOUT_MS);
      reason = failureReason(body, id);
      if (input.rated === true) {
        const record = JSON.parse(new TextDecoder().decode(body)) as MatchRecord;
        if (record.result?.ratingChanges === undefined) {
          record.unavailable.push(RATINGS_UNAVAILABLE);
          body = new TextEncoder().encode(JSON.stringify(record) + "\n");
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    const buildEnd = now();
    note(id, `build ended in ${buildEnd - buildStart} ms (${body === undefined ? "threw" : reason === null ? "complete" : "not complete"})`, buildEnd);
    if (reason === null) {
      // The input is deleted once this record is saved, so the record carries its reply lines: public, every private
      // agent id in them in its public form,
      // or sealed with the rest of a private record as recorded, with each agent id's seat.
      try {
        const lines = replyLines === undefined || input.lobbyId !== null ? replyLines : publicReplyLines(replyLines, input.logLines, body!);
        const agentSeats = replyLines === undefined || input.lobbyId === null ? undefined : privateAgentSeats(replyLines, input.logLines, body!);
        body = withReplies(body!, lines, input.codeVersion, agentSeats);
      } catch (error) { return hold(id, `reply lines not carried: ${error instanceof Error ? error.message : String(error)}`); }
      return finish(id, { target, body, saved: false, endedAt: input.endedAt, carries }, markers);
    }

    // Logged before counting, so a failed marker write (reported by sweep) never hides the real reason.
    deps.log(`antwar record ${id} build failed: ${reason}`);
    // Counted only after completion; shared create-only markers bound retries across restarts/replicas.
    while (last < MAX_FAILURES) {
      last += 1;
      if (await deps.inputs.createMarker(id, last, reason, deps.codeVersion)) {
        markers.push({ kind: "marker", id, n: last, codeVersion: deps.codeVersion });
        break;
      }
    }
    deps.log(`antwar record ${id} failure ${last} of ${MAX_FAILURES} counted`);
    if (last >= MAX_FAILURES) {
      deps.log(`antwar record ${id} saved unavailable after ${last} failed builds: ${reason}`);
      await finish(id, unavailable(reason), markers);
    }
  }

  return {
    async sweep() {
      let names: string[];
      try { names = await deps.inputs.list(); }
      catch (error) { deps.log(`antwar record sweep could not list inputs: ${error instanceof Error ? error.message : String(error)}`); return; }
      const inputs: string[] = [];
      const markers = new Map<string, Marker[]>();
      const declared = new Set<string>();
      for (const name of names) {
        const build = parseRunningBuildName(name);
        if (build !== null) { if (build !== deps.codeVersion) declared.add(build); continue; }
        const parsed = parseInputObjectName(name);
        if (parsed === null) continue;
        if (parsed.kind === "input") inputs.push(parsed.id);
        else markers.set(parsed.id, [...markers.get(parsed.id) ?? [], parsed]);
      }
      running = declared;
      for (const build of running) {
        if (deferring.has(build)) continue;
        deferring.add(build);
        deps.log(`antwar record inputs of build ${build} deferred: running/${build} declares its own records builder running`);
      }
      for (const build of deferring) {
        if (running.has(build)) continue;
        deferring.delete(build);
        deps.log(`antwar record inputs of build ${build} no longer deferred: running/${build} removed`);
      }
      const present = new Set(inputs);
      for (const id of due.keys()) if (!present.has(id)) due.delete(id);
      for (const id of versions.keys()) if (!present.has(id)) versions.delete(id);
      for (const [id, ns] of markers) {
        if (present.has(id)) continue;
        try { for (const marker of ns) await deps.inputs.delete(markerName(id, marker.n, marker.codeVersion)); }
        catch (error) { deps.log(`antwar record ${id} orphan marker cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      // Replay ids start with the match start time, so sorted names are oldest first.
      for (const id of inputs.sort()) {
        try { await attempt(id, markers.get(id) ?? []); }
        catch (error) { deps.log(`antwar record ${id} attempt failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    },
  };
}

/**
 * A complete built record as published: the build commit the match ran (codeVersion), a sealed private
 * record's agentSeats, then the input's reply lines last as replies, each line written verbatim as its JSON object
 * (src/replays/recording.ts replyLine, stubLine, textLine), so an entry's stored bytes are the bytes its cap was measured
 * on, and REPLIES_NOT_RETAINED no longer among its unavailable reasons. An input that carries none gives replies null,
 * with that reason kept.
 */
export function withReplies(body: Uint8Array, replyLines: readonly string[] | undefined, codeVersion: string,
  agentSeats?: Readonly<Record<string, number | null>>): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const json = text.trimEnd();
  const record = JSON.parse(json) as MatchRecord;
  if (Object.hasOwn(record, "replies")) throw new Error("the built record already has replies");
  const unavailable = record.unavailable.filter(reason => reason !== REPLIES_NOT_RETAINED);
  if (replyLines === undefined) unavailable.unshift(REPLIES_NOT_RETAINED);
  const out = JSON.stringify({ ...record, unavailable, codeVersion, ...(agentSeats === undefined ? {} : { agentSeats }) });
  const published = replyLines === undefined ? `${out.slice(0, -1)},"replies":null}` : withJsonArray(out, "replies", replyLines);
  return new TextEncoder().encode(published + text.slice(json.length));
}

/**
 * A sealed private record's agentSeats: each of the match's agent ids (each reply line's own and each log input's
 * agentId and parentAgentId) as the seat the record numbers it (logSeats), or null for an agent of no seat.
 */
export function privateAgentSeats(replyLines: readonly string[], logLines: readonly string[], body: Uint8Array): Record<string, number | null> {
  // No prototype, so an agent-sent id such as "__proto__" is an ordinary key.
  const agentSeats: Record<string, number | null> = Object.assign(Object.create(null) as Record<string, number | null>, Object.fromEntries(logSeats(logLines, body)));
  const note = (agentId: unknown) => { if (typeof agentId === "string" && agentId !== "" && !Object.hasOwn(agentSeats, agentId)) agentSeats[agentId] = null; };
  for (const line of replyLines) note((JSON.parse(line) as { agentId?: unknown }).agentId);
  for (const line of logLines) {
    const entry = (() => { try { return JSON.parse(line) as { inputs?: unknown }; } catch { return {}; } })();
    if (Array.isArray(entry.inputs)) for (const input of entry.inputs as { parentAgentId?: unknown }[]) note(input?.parentAgentId);
  }
  return agentSeats;
}

/**
 * Whether a stored record is published as withReplies writes it for these inputs: replies exactly these reply lines,
 * this codeVersion, agentSeats exactly these (absent when none are given), and REPLIES_NOT_RETAINED not among its
 * unavailable reasons. A record saved before records carried a codeVersion carries the replies alone, so it does not.
 */
export function carriesReplies(stored: Uint8Array, replyLines: readonly string[], codeVersion: string,
  agentSeats?: Readonly<Record<string, number | null>>): boolean {
  const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored)) as Partial<MatchRecord>;
  // Compared as JSON, as stored: agentSeats is built with no prototype.
  const seats = agentSeats === undefined ? undefined : JSON.parse(JSON.stringify(agentSeats)) as unknown;
  return isDeepStrictEqual(record.replies, replyLines.map(line => JSON.parse(line) as unknown)) &&
    record.codeVersion === codeVersion && isDeepStrictEqual(record.agentSeats, seats) &&
    Array.isArray(record.unavailable) && !record.unavailable.includes(REPLIES_NOT_RETAINED);
}

/**
 * Each agent id of a public record's reply lines, as that record names the agent: its match-local seat, the order of
 * the agent's first join among the match log's inputs, as src/replays/history.ts numbers seats. Checked against the
 * built record's seats, each holding exactly the calls (tick and type) its agent made in the log; a log that does not
 * account for them throws rather than guess.
 */
export function logSeats(logLines: readonly string[], body: Uint8Array): ReadonlyMap<string, number> {
  const ticks: { tick: number; inputs: readonly { readonly type?: unknown; readonly agentId?: unknown }[] }[] = [];
  for (const line of logLines) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { tick?: unknown; inputs?: unknown };
    if (typeof entry.tick === "number" && Array.isArray(entry.inputs)) ticks.push({ tick: entry.tick, inputs: entry.inputs as never });
  }
  ticks.sort((a, b) => a.tick - b.tick);
  const seats = new Map<string, number>();
  const calls: string[][] = [];
  for (const { tick, inputs } of ticks) {
    for (const input of inputs) {
      if (typeof input.agentId !== "string") continue;
      if (!seats.has(input.agentId)) {
        if (input.type !== "join") throw new Error("a log call comes before its agent's join");
        seats.set(input.agentId, seats.size);
        calls.push([]);
      }
      calls[seats.get(input.agentId)!]!.push(`${tick}:${String(input.type)}`);
    }
  }
  const record = JSON.parse(new TextDecoder().decode(body)) as { seats?: readonly { readonly commands?: readonly { tick: number; type: string }[] }[] };
  const recorded = (record.seats ?? []).map(seat => (seat.commands ?? []).map(command => `${command.tick}:${command.type}`));
  if (JSON.stringify(recorded) !== JSON.stringify(calls)) throw new Error("the match log's agents do not match the record's seats");
  return seats;
}

/** The named marker for an agent id inside a public record's stored argument or reply: its seat, or its order among agents of no seat. */
const agentMarker = (seat: number | null, unseated: number): string => seat === null ? `[agent unseated ${unseated}]` : `[agent seat ${seat}]`;

/** A field holding an agent id: agentId, parentAgentId and the like. */
const agentIdField = (key: string): boolean => /agentid$/i.test(key);

/**
 * A public record's reply lines with no private agent id. Each line's
 * own agentId becomes seat, the seat as the record numbers it (logSeats), or, for an agent of no seat, seat null and
 * agent, a named marker. The match's agent ids (each line's own and each log input's agentId and parentAgentId) become
 * their marker wherever they appear in a stored argument or reply, as a whole string or within one. Any value under an
 * agent id field (agentId, parentAgentId and the like), at any depth and of any type, an object or array included, as
 * an agent may send one, becomes a marker as a whole value: its agent's when it is one of the match's agent ids, else
 * a named marker of its own. An entry those markers grow past STORED_ENTRY_BYTES is fitted again (refitEntry), and each
 * seat's published lines are held to its budget (withinSeatBudgets). Text lines stay as served. A line still holding a
 * known id afterwards throws, so the record is not published and its input is kept.
 */
export function publicReplyLines(replyLines: readonly string[], logLines: readonly string[], body: Uint8Array): readonly string[] {
  const seats = logSeats(logLines, body);
  const markers = new Map<string, string>();
  for (const [agentId, seat] of seats) markers.set(agentId, agentMarker(seat, 0));
  let unseated = 0;
  const note = (agentId: unknown) => {
    if (typeof agentId === "string" && agentId !== "" && !markers.has(agentId)) markers.set(agentId, agentMarker(null, unseated += 1));
  };
  /** Each other value under an agent id field, by its JSON, and its marker. */
  const fielded = new Map<string, string>();
  const parsed = replyLines.map(line => JSON.parse(line) as Record<string, unknown>);
  for (const line of parsed) note(line.agentId);
  for (const line of logLines) {
    const entry = (() => { try { return JSON.parse(line) as { inputs?: unknown }; } catch { return {}; } })();
    if (Array.isArray(entry.inputs)) for (const input of entry.inputs as { parentAgentId?: unknown }[]) note(input?.parentAgentId);
  }
  const known = (value: unknown): value is string => typeof value === "string" && markers.has(value);
  const named = (value: unknown, key: string): void => {
    if (agentIdField(key)) {
      const json = JSON.stringify(value);
      if (!known(value) && !fielded.has(json)) fielded.set(json, agentMarker(null, unseated += 1));
      return;
    }
    if (Array.isArray(value)) { for (const item of value) named(item, key); return; }
    if (typeof value === "object" && value !== null) for (const [field, item] of Object.entries(value)) named(item, field);
  };
  const rests = parsed.map(line => { const { type: _type, agentId: _agentId, ...rest } = line; return rest; });
  parsed.forEach((line, index) => { if (line.type !== "text") named(rests[index], ""); });
  // Longest first, so an id within a longer one is not replaced before it.
  const ids = [...markers.keys()].sort((a, b) => b.length - a.length);
  const pattern = ids.length === 0 ? null : new RegExp(ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const scrub = (value: unknown, key: string): unknown => {
    if (agentIdField(key)) return known(value) ? markers.get(value)! : fielded.get(JSON.stringify(value))!;
    if (typeof value === "string") return pattern === null ? value : value.replace(pattern, id => markers.get(id)!);
    if (Array.isArray(value)) return value.map(item => scrub(item, key));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [scrub(field, "") as string, scrub(item, field)]));
    }
    return value;
  };
  const lines = parsed.map((line, index) => {
    // A served text is stored as served, named by its digest; one naming an agent is not published.
    if (line.type === "text") return replyLines[index]!;
    const agentId = line.agentId;
    const seat = typeof agentId === "string" ? seats.get(agentId) : undefined;
    const own = seat !== undefined ? { seat } : { seat: null, agent: known(agentId) ? markers.get(agentId)! : null };
    const out = { type: line.type, ...own, ...scrub(rests[index], "") as object };
    return JSON.stringify(line.type === "reply" ? refitEntry(out) : out);
  });
  const published = withinSeatBudgets(lines);
  for (const out of published) if (ids.some(id => out.includes(id))) throw new Error("a reply line still names a private agent id");
  return published;
}

/**
 * Each seat's published entry and stub lines within SEAT_RECORD_BUDGET_BYTES,
 * counted as the recording counts them (each line's UTF-8 bytes and its separator) on the lines as published, after
 * credential redaction and agent markers, with CLOSING_STUB_RESERVE_BYTES kept free. The first line that does not fit
 * spends the seat: it and every later line of the seat are left out and counted (an entry as one call, a stub as one
 * plus its omitted), and the seat closes with one final stub, its last call left out, carrying the count of the rest.
 * Text lines are the match's, once each, outside every seat's budget.
 */
function withinSeatBudgets(lines: readonly string[]): string[] {
  const seats = new Map<string, { bytes: number; omitted: number; last: Record<string, unknown> | null }>();
  const kept: string[] = [];
  for (const line of lines) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type !== "reply" && value.type !== "stub") { kept.push(line); continue; }
    const key = JSON.stringify([value.seat ?? null, value.agent ?? null]);
    let seat = seats.get(key);
    if (seat === undefined) seats.set(key, seat = { bytes: 0, omitted: 0, last: null });
    const cost = Buffer.byteLength(line) + 1;
    if (seat.last === null && seat.bytes + cost + CLOSING_STUB_RESERVE_BYTES <= SEAT_RECORD_BUDGET_BYTES) {
      kept.push(line);
      seat.bytes += cost;
      continue;
    }
    seat.omitted += 1 + (value.type === "stub" && typeof value.omitted === "number" ? value.omitted : 0);
    seat.last = value;
  }
  for (const { omitted, last } of seats.values()) {
    if (last === null) continue;
    const { type: _type, seat, agent, tick, tool, receivedAt, answeredAt } = last;
    const code = last.type === "stub" ? last.code : entryCode(last);
    kept.push(JSON.stringify({ type: "stub", seat, ...(agent === undefined ? {} : { agent }), tick, tool, receivedAt, answeredAt, code, omitted: omitted - 1 }));
  }
  return kept;
}
