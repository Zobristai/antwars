// Summary parser worker for the saved-match history list (src/replays/history-source.ts).
// It starts once per record read, so it imports nothing at runtime beyond worker_threads:
// loading zod and the history-source module graph made each start several times slower
// than the parse itself. The checks below are the public summary boundary.
import { parentPort, workerData } from "node:worker_threads";
import type { HistorySummary } from "./history-source.ts";

type Json = unknown;
const invalid = (): never => { throw new Error("Invalid match record."); };
const object = (value: Json): Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, Json> : invalid();
/** Length in code points, as zod's string max counts it. */
const text = (value: Json, max = Infinity): string =>
  typeof value === "string" && (value.length <= max || Array.from(value).length <= max) ? value : invalid();
const nullableText = (value: Json, max?: number): string | null => value === null ? null : text(value, max);
/** Absent reads as null: older records predate these seat fields. */
const optionalText = (value: Json): string | null => value === undefined ? null : nullableText(value);
const list = (value: Json, max: number): Json[] => Array.isArray(value) && value.length <= max ? value : invalid();
const oneOf = <T extends Json>(value: Json, allowed: readonly T[]): T => allowed.includes(value as T) ? value as T : invalid();
const optionalFlag = (value: Json): boolean | undefined => value === undefined || typeof value === "boolean" ? value : invalid();
const clip = (value: string | null, max: number): string | null => value === null ? null : Array.from(value).slice(0, max).join("");
/** A seat's stored start rating (src/replays/history.ts StartRating); absent, or anything not exactly one, reads as null. */
const startRating = (value: Json): { rating: number; rd: number; ratedMatches: number } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { rating, rd, ratedMatches } = value as Record<string, Json>;
  return typeof rating === "number" && Number.isFinite(rating) && typeof rd === "number" && Number.isFinite(rd) && rd >= 0 &&
    typeof ratedMatches === "number" && Number.isSafeInteger(ratedMatches) && ratedMatches >= 0 ? { rating, rd, ratedMatches } : null;
};

/** A record's drawn colony names (setup.colonyNames); absent, or anything not exactly two names, reads as null. */
const colonyNames = (value: Json): [string, string] | null =>
  Array.isArray(value) && value.length === 2 && value.every(name => typeof name === "string" && name.length > 0)
    ? [clip(value[0] as string, 64)!, clip(value[1] as string, 64)!] : null;

export function parseSummary(id: string, bytes: Uint8Array): HistorySummary {
  const record = object(JSON.parse(new TextDecoder().decode(bytes)));
  oneOf(record.format, ["antwar.match"]); oneOf(record.version, [1]);
  if (text(record.id) !== id) throw new Error("record identity mismatch");
  const startedAt = text(record.startedAt, 64), endedAt = nullableText(record.endedAt, 64), simulationEndedAt = nullableText(record.simulationEndedAt, 64);
  const result = record.result === null ? null : object(record.result);
  const winner = result === null ? null : oneOf(result.winner, [0, 1, null] as const);
  const reason = result === null ? null : text(result.reason, 64), decidedBy = result === null ? null : text(result.decidedBy, 64);
  const seats = list(record.seats, 64).map(value => {
    const seat = object(value);
    const index = typeof seat.seat === "number" && Number.isSafeInteger(seat.seat) && seat.seat >= 0 ? seat.seat : invalid();
    return { seat: index, colony: oneOf(seat.colony, [0, 1] as const), modelLabel: nullableText(seat.modelLabel),
      thinkingLevel: optionalText(seat.thinkingLevel), serviceTier: optionalText(seat.serviceTier), handle: optionalText(seat.handle),
      startRating: startRating(seat.startRating) };
  });
  const status = oneOf(record.status, ["complete", "partial", "unavailable"] as const);
  const unavailable = list(record.unavailable, 32).map(reason => text(reason));
  const setup = record.setup === undefined || record.setup === null ? null : object(record.setup);
  const rated = setup === null ? undefined : optionalFlag(setup.rated), modelIndex = setup === null ? undefined : optionalFlag(setup.modelIndex);
  const names = setup === null ? null : colonyNames(setup.colonyNames);
  return { id, startedAt, endedAt, simulationEndedAt, winner, reason, decidedBy,
    seats: seats.map(seat => ({ ...seat, modelLabel: clip(seat.modelLabel, 64), thinkingLevel: clip(seat.thinkingLevel, 32),
      serviceTier: clip(seat.serviceTier, 32), handle: clip(seat.handle, 256) })),
    status, unavailable: unavailable.map(reason => clip(reason, 256)!),
    rated: setup === null ? null : rated === true, modelIndex: modelIndex === true,
    ...(names === null ? {} : { colonyNames: names }) };
}

if (parentPort !== null && workerData?.kind === "match-summary") {
  try { parentPort.postMessage({ summary: parseSummary(workerData.id, workerData.bytes) }); }
  catch { parentPort.postMessage({ error: "Invalid match record." }); }
}
