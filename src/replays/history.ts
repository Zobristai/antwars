import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { decodeMessage, type StreamIdentity, type StreamMessage, type StreamEvent, type StreamResult, type StreamSetup } from "../live/format.js";
import { isReplayId } from "./access.js";
import { parseLog, terminalAt, type ParsedLog } from "../sim/log.js";
import { HOLD_BEHAVIOUR } from "../sim/holdBehaviour.js";
import { createMatch } from "../sim/map.js";
import { advance } from "../sim/step.js";
import type { ColonyId, SimInput } from "../sim/types.js";
import { SpectatorRecorder, cutUtf8, LABEL_BYTES, SERVICE_TIER_BYTES, THINKING_LEVEL_BYTES } from "../live/model.js";

export interface CommandRecord {
  tick: number;
  type: string;
  accepted: boolean;
  /** null means the recording did not retain the request, not an empty request. */
  request: Readonly<Record<string, unknown>> | null;
  error: { code: string; message: string; nextAllowedTick?: number } | null;
}
export interface SeatRecord {
  seat: number;
  colony: 0 | 1;
  modelLabel: string | null;
  /** null when omitted, including recordings made before this metadata existed. */
  thinkingLevel: string | null;
  /** The seat's self-reported join service tier; null when omitted, including recordings made before this metadata existed. */
  serviceTier: string | null;
  /** The seated identity's owner/handle name from the recording stream, without a " #n" seat suffix; null when the
   * stream carries no identity, including recordings made before this field existed. */
  handle: string | null;
  joinedTick: number;
  commands: CommandRecord[];
}
export interface MatchRecord {
  format: "antwar.match";
  version: 1;
  id: string;
  source: "match-log" | "binary" | "unavailable";
  status: "complete" | "partial" | "unavailable";
  unavailable: string[];
  startedAt: string;
  endedAt: string | null;
  /** Estimated from the recorded simulation clock, never presented as observed wall time. */
  simulationEndedAt: string | null;
  rules: { version: number; holdBehaviour: string; config: unknown } | null;
  setup: StreamSetup | null;
  result: Omit<StreamResult, "nextStartMs"> | null;
  seats: SeatRecord[];
  /** Events as recorded, with simulation-step ticks; no invented causal attribution. */
  events: { tick: number; event: StreamEvent }[];
  /**
   * Full commit the game server ran this match on (the record input's codeVersion), added by the record service; absent
   * in records built before it was carried.
   */
  codeVersion?: string;
  /**
   * Every seat's calls in call order across the match, each entry naming its seat, and each text served to the match's
   * agents once, before the first entry naming it (src/replays/recording.ts replyLine, stubLine, textLine). Added last by
   * the record service. null: the match's replies were not retained (unavailable says so); absent: a record built before
   * replies were carried, which retained none either.
   */
  replies?: CallLine[] | null;
  /**
   * A sealed private record only: each of the match's agent ids (each agent joined in its match log, each reply line's
   * own agentId and each log input's parentAgentId; src/records/service.ts privateAgentSeats), as the seat this record
   * numbers it, or null for an agent of no seat. A public record's replies name seats and carry no agent id.
   */
  agentSeats?: Record<string, number | null>;
  /**
   * A public record verified against its match log only: what re-running the match needs beside rules.config
   * and the seats' requests, so each agent's cell page can be rebuilt. The log's seed, and the ticks of each server
   * control step was given (src/sim/log.ts terminalAt and houseActive); houseActive as inclusive [first, last] tick
   * ranges. Built only after the match is released (src/records/service.ts publishAfter), never on the live stream.
   * Absent from a record not verified against its log (source "binary" or "unavailable"), which says nothing about
   * stops, and from every sealed private record.
   */
  rerun?: RerunInputs;
}
export interface RerunInputs {
  seed: number;
  stops: number[];
  abandonments: number[];
  idle: { tick: number; colonies: ColonyId[] }[];
  houseActive: [number, number][];
}
/**
 * One line of MatchRecord.replies. A public record names the caller by seat (null with agent, a named marker, for an
 * agent of no seat); a sealed private record by agentId. tick is null before the match began.
 */
export type CallLine =
  | ({ type: "reply"; tick: number | null; tool: string; receivedAt: number; answeredAt: number;
      /** As the agent sent them, credentials as their redaction markers; absent when none were sent. */
      arguments?: unknown;
      /** As the agent received it, stored in the form src/mcp/replies.ts storedCall describes. */
      reply: unknown;
      isError?: true; trimmed?: string[]; trimmedMore?: number; redacted?: string[]; redactedMore?: number;
      /** Reply fields carried as a text line, by that line's digest. */
      textRefs?: Record<string, string> } & CallerOf)
  | ({ type: "stub"; tick: number | null; tool: string; receivedAt: number; answeredAt: number; code: string | null;
      /** The seat's calls left out since its previous stub. */
      omitted?: number } & CallerOf)
  | { type: "text"; digest: string; kind: "rules" | "briefing" | "tools"; text: string };
type CallerOf = { seat: number | null; agent?: string } | { agentId: string };
/** The record's statement that it carries no call replies, so none of the calls refused before simulation either. */
export const REPLIES_NOT_RETAINED = "Call replies were not retained, including calls refused before simulation (adapter validation, rate limits, post-match calls).";
export interface HistoryInput {
  id: string;
  binary: Uint8Array;
  /** Plain match JSONL, already admitted through loadReplayFile for historical files. */
  logLines?: readonly string[];
  endedAt?: number;
  /** Add rerun to a record verified against logLines: public records only (src/records/service.ts). */
  rerun?: boolean;
}

export function recordStart(id: string): string {
  if (!isReplayId(id)) throw new Error("invalid replay id");
  return id.slice(0, 10) + "T" + id.slice(11, 13) + ":" + id.slice(14, 16) + ":" + id.slice(17, 19) + "." + id.slice(20, 23) + "Z";
}
export function unavailableRecord(id: string, reason: string): MatchRecord {
  return { format: "antwar.match", version: 1, id, source: "unavailable", status: "unavailable", unavailable: [reason],
    startedAt: recordStart(id), endedAt: null, simulationEndedAt: null, rules: null, setup: null, result: null, seats: [], events: [] };
}

function* messagesOf(binary: Uint8Array): Generator<StreamMessage> {
  const raw = binary[0] === 0x1f && binary[1] === 0x8b ? gunzipSync(binary) : binary;
  // Buffer views serialize differently from the simulation's Uint8Array fields.
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("truncated replay length prefix");
    const length = view.getUint32(offset, true); offset += 4;
    if (length === 0 || offset + length > bytes.length) throw new Error("truncated replay message");
    const message = decodeMessage(bytes.subarray(offset, offset + length)); offset += length;
    yield message;
  }
}

/** Decode recorded facts only. Stream versions select their own decoder; no current sim rules run. */
/** "name #seat" is one identity holding several seats (web/src/compose.ts SEAT); the handle is the name alone. */
const SEAT_SUFFIX = /^(.+) #\d+$/;
function handleOf(identity: StreamIdentity | undefined): string | null {
  if (identity === undefined) return null;
  return SEAT_SUFFIX.exec(identity.displayName)?.[1] ?? identity.displayName;
}

export function binaryRecord(input: HistoryInput): MatchRecord {
  const record = unavailableRecord(input.id, "");
  record.source = "binary"; record.status = "partial";
  record.unavailable = ["Full rules config and hold behaviour are absent from spectator binaries.",
    "Refused command requests and refusal reasons are absent; accepted requests may omit fields.",
    REPLIES_NOT_RETAINED];
  let previous = -1;
  for (const message of messagesOf(input.binary)) {
    if (message.tick <= previous) throw new Error("replay ticks are not increasing");
    if (previous === -1) {
      if (message.full === null) throw new Error("replay has no opening snapshot");
      if (message.tick !== 0) record.unavailable.push(`History before completed tick ${message.tick} was not retained.`);
      const { seed: _seed, players: _players, ...setup } = message.full.setup;
      record.setup = setup;
      record.result = message.full.result;
      record.seats = message.full.agents.map((agent, seat) => ({ seat, colony: agent.colony, modelLabel: agent.modelLabel || null, thinkingLevel: agent.thinkingLevel ?? null,
        serviceTier: agent.serviceTier ?? null, handle: handleOf(agent.identity),
        joinedTick: agent.joinTick, commands: [] }));
    }
    previous = message.tick;
    const tick = Math.max(0, message.tick - 1);
    for (const event of message.events) {
      if (event.kind === "join") {
        if (event.agent !== record.seats.length) throw new Error("replay seat sequence is invalid");
        record.seats.push({ seat: event.agent, colony: event.colony, modelLabel: event.modelLabel || null, thinkingLevel: event.thinkingLevel ?? null,
          serviceTier: event.serviceTier ?? null, handle: handleOf(event.identity), joinedTick: tick, commands: [] });
      }
      if (event.kind === "call") {
        const seat = record.seats[event.agent];
        if (seat === undefined) throw new Error("replay call has no seat");
        seat.commands.push({ tick, type: event.call, accepted: event.accepted, request: null, error: null });
      }
      if (event.kind === "end") {
        const { nextStartMs: _next, ...result } = event.result;
        record.result = result;
        if (result.tick + 1 !== message.tick) throw new Error("replay terminal tick mismatch");
      }
      // Movement/food/territory bulk arrays are not command outcomes. Keep the
      // tactical events, including mark answers, combat, queens and final result.
      if (!["food", "territory", "store"].includes(event.kind)) record.events.push({ tick, event });
    }
    // Order effects precede their call receipts in the wire event sequence.
    for (const event of message.events) {
      if (event.kind !== "order") continue;
      const call = record.seats[event.agent]?.commands.find(command => command.tick === tick && command.type === "order" && command.accepted && command.request === null);
      if (call) call.request = { type: "order", order: { kind: event.order, tileX: event.tileX, tileY: event.tileY }, intent: event.intent };
    }
  }
  if (record.setup === null) throw new Error("empty replay");
  if (record.result?.reason === "abandoned") record.setup.rated = false;
  if (record.result !== null) {
    if (record.result.tick + 1 !== previous) throw new Error("replay continues after result");
    record.simulationEndedAt = new Date(Date.parse(record.startedAt) + (record.result.tick + 1) * 1000 / record.setup.ticksPerSecond).toISOString();
  } else record.unavailable.push("No terminal result was retained.");
  if (input.endedAt !== undefined) record.endedAt = new Date(input.endedAt).toISOString();
  else record.unavailable.push("Actual wall-clock end time was not retained; simulationEndedAt is an estimate.");
  return record;
}

/** A parsed log's seed and server control ticks, in tick order; houseActive as inclusive tick ranges. */
export function rerunInputs(log: ParsedLog): RerunInputs {
  const ascending = (ticks: Iterable<number>) => [...ticks].sort((a, b) => a - b);
  const houseActive: [number, number][] = [];
  for (const tick of ascending(log.houseActive)) {
    const last = houseActive[houseActive.length - 1];
    if (last !== undefined && last[1] + 1 === tick) last[1] = tick;
    else houseActive.push([tick, tick]);
  }
  return { seed: log.header.seed, stops: ascending(log.stops), abandonments: ascending(log.abandonments),
    idle: ascending(log.idle.keys()).map(tick => ({ tick, colonies: [...log.idle.get(tick)!] })), houseActive };
}

/** Use the same recorded-config/hold-behaviour replay boundary as the existing replay tools. */
export function matchRecord(input: HistoryInput): MatchRecord {
  const record = binaryRecord(input);
  if (input.logLines === undefined) return record;
  const seen = new Set<number>();
  const lines = input.logLines.filter(line => line.trim() !== "");
  // Native JSON errors can quote the input. Never publish raw log fragments in
  // a public reason stub (the header includes a deliberately private seed).
  try { for (const line of lines) JSON.parse(line); }
  catch { throw new Error("Match log JSON is invalid."); }
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as { tick?: unknown; inputs?: unknown };
    if (typeof entry.tick !== "number" || seen.has(entry.tick) || !Array.isArray(entry.inputs)) throw new Error("invalid or duplicate log tick");
    seen.add(entry.tick);
  }
  const log = parseLog(input.logLines);
  const { header, ticks, houseActive } = log;
  const config = header.config;
  if (!Number.isSafeInteger(config.matchTicks) || config.matchTicks <= 0 || config.matchTicks > 10_000_000 ||
      !Number.isFinite(config.ticksPerSecond) || config.ticksPerSecond <= 0) throw new Error("invalid recorded match clock");
  if (record.result === null) throw new Error("cannot verify log against a binary without a terminal result");
  if (config.ticksPerSecond !== record.setup!.ticksPerSecond || config.mapWidth !== record.setup!.mapW || config.mapHeight !== record.setup!.mapH) {
    throw new Error("log setup does not match binary");
  }
  for (const [tick, inputs] of ticks) {
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > record.result.tick || !Array.isArray(inputs)) throw new Error("invalid or out-of-range log tick");
  }
  const seats: SeatRecord[] = [];
  const seatIds = new Map<string, number>();
  let state = createMatch(header.seed, config);
  const spectator = new SpectatorRecorder(state);
  const recorded = messagesOf(input.binary);
  const opening = recorded.next().value;
  if (opening?.tick !== 0) throw new Error("log verification requires a binary starting at tick zero");
  function verifyAnts(expected: StreamMessage["ants"], actual: StreamMessage["ants"]): void {
    for (const key of ["count", "id", "x", "y", "heading", "colony", "agent", "caste", "carrying"] as const) {
      // Optional extensions absent in the historical version are not invented.
      if (expected[key] !== undefined && JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) throw new Error(`log ant ${key} does not match binary under recorded rules`);
    }
  }
  verifyAnts(opening.ants, spectator.initial().ants);
  while (state.result === null && state.tick <= record.result.tick) {
    const tick = state.tick, inputs = ticks.get(tick) ?? [];
    const out = advance(state, inputs, undefined, undefined, undefined, terminalAt(log, tick), houseActive.has(tick));
    const expected = recorded.next().value;
    if (expected?.tick !== out.state.tick) throw new Error("log/binary tick sequence does not match");
    verifyAnts(expected.ants, spectator.record(out).ants);
    for (const event of out.events) {
      if (event.type === "agent_join") {
        seatIds.set(event.agentId, seats.length);
        seats.push({ seat: seats.length, colony: event.colony, modelLabel: event.modelLabel, thinkingLevel: event.thinkingLevel ?? null,
          serviceTier: event.serviceTier ?? null, handle: null, joinedTick: event.tick, commands: [] });
      }
    }
    inputs.forEach((input: SimInput, index) => {
      const seat = seatIds.get(input.agentId), result = out.results[index];
      if (seat === undefined || result === undefined) throw new Error("log command cannot be aligned to a seat/result");
      const { agentId: _id, ...request } = input;
      // Join parent ids are not reconnect credentials, but still need not leave
      // the server. All references in this public record use match-local seats.
      if (request.type === "join" && "parentAgentId" in request) delete request.parentAgentId;
      seats[seat]!.commands.push({ tick, type: input.type, accepted: result.ok, request, error: result.ok ? null : result.error });
    });
    state = out.state;
  }
  // A rated match's recorded result also carries its delayed rating changes, which the simulation
  // never produces. They are left out of this comparison only; the record keeps them.
  const { ratingChanges: _ratings, ...recordedResult } = record.result;
  if (JSON.stringify(state.result) !== JSON.stringify(recordedResult)) throw new Error("log result does not match binary under recorded rules");
  const callFacts = (list: readonly SeatRecord[]) => list.map(seat => ({ seat: seat.seat, colony: seat.colony,
    modelLabel: cutUtf8(seat.modelLabel ?? "", LABEL_BYTES),
    thinkingLevel: cutUtf8(seat.thinkingLevel ?? "", THINKING_LEVEL_BYTES),
    serviceTier: cutUtf8(seat.serviceTier ?? "", SERVICE_TIER_BYTES),
    joinedTick: seat.joinedTick, commands: seat.commands.map(({ tick, type, accepted }) => ({ tick, type, accepted })) }));
  if (JSON.stringify(callFacts(seats)) !== JSON.stringify(callFacts(record.seats))) throw new Error("log calls do not match binary");
  record.source = "match-log";
  record.status = "complete";
  record.rules = { version: header.rulesVersion, holdBehaviour: HOLD_BEHAVIOUR, config: JSON.parse(JSON.stringify(config)) as unknown };
  // A match log carries no identities; each seat keeps the handle its binary seat recorded.
  record.seats = seats.map((seat, index) => ({ ...seat, handle: record.seats[index]?.handle ?? null }));
  if (input.rerun === true) record.rerun = rerunInputs(log);
  // The record service removes this once it adds the match's replies (src/records/service.ts withReplies).
  record.unavailable = [REPLIES_NOT_RETAINED];
  if (record.endedAt === null) record.unavailable.push("Actual wall-clock end time was not retained; simulationEndedAt is an estimate.");
  return record;
}

/** The game server's in-process limit; the record service passes its own. */
export const HISTORY_TIMEOUT_MS = 300_000;

/** CPU-heavy decoding, historical simulation and JSON serialization never own the match timer. */
export function historyBytes(input: HistoryInput, timeoutMs = HISTORY_TIMEOUT_MS): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./history-worker.ts", import.meta.url), {
      workerData: input, execArgv: ["--import", new URL("../ts-resolve.mjs", import.meta.url).href],
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("match record worker timed out")); }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    worker.once("message", (message: { bytes?: Uint8Array; error?: string }) => {
      cleanup();
      if (message.bytes !== undefined) resolve(message.bytes);
      else reject(new Error(message.error ?? "match record worker failed"));
    });
    worker.once("error", error => { cleanup(); reject(error); });
    worker.once("exit", code => { cleanup(); reject(new Error(`match record worker exited ${code} before returning data`)); });
  });
}
