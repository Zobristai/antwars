/**
 * The Antwars Model Index harness phases: which version of the index's player harness a match was played on, decided
 * by the match's time alone. This table is the one source the matches page, the replay and the public API read; it
 * labels matches and never changes a rating.
 *
 * Each phase starts at its instant and runs until the next phase's start. The first phase has no lower bound. The last
 * phase, from the pin onward, is committed with its start left open (null) until that boundary is set; while it is open,
 * a match after round 30 closed is labelled rounds 26-30 with pinBoundaryOpen true.
 */

export type HarnessPhaseName = "rounds 1-7" | "rounds 8-10" | "rounds 11-25" | "rounds 26-30" | "from the pin onward";

export interface HarnessPhaseRow {
  readonly phase: HarnessPhaseName;
  /** Milliseconds since the epoch; null for the first phase (no lower bound) and for a boundary not yet set. */
  readonly startsAt: number | null;
}

/** Oldest first. */
export const HARNESS_PHASES: readonly HarnessPhaseRow[] = Object.freeze([
  { phase: "rounds 1-7", startsAt: null },
  { phase: "rounds 8-10", startsAt: Date.parse("2026-10-27T03:56:59Z") },
  { phase: "rounds 11-25", startsAt: Date.parse("2026-10-28T00:32:01Z") },
  { phase: "rounds 26-30", startsAt: Date.parse("2026-11-07T03:34:52Z") },
  { phase: "from the pin onward", startsAt: null },
] as const satisfies readonly HarnessPhaseRow[]);

/** When the last round-30 match had closed; a later match is after round 30. */
export const ROUND_30_CLOSED_AT = Date.parse("2026-11-09T06:26:00Z");

/** Matches before this instant carry the possible effort mismatch flag. */
export const EFFORT_MISMATCH_UNTIL = Date.parse("2026-10-26T03:02:42.158Z");

/** One index match's label: unknown, with the flag null, when the match has no readable time. */
export interface HarnessPhase {
  readonly phase: HarnessPhaseName | "unknown";
  readonly possibleEffortMismatch: boolean | null;
  /** True for a match after round 30 while the from-the-pin-onward boundary is not yet set. */
  readonly pinBoundaryOpen: boolean;
}

const UNKNOWN: HarnessPhase = Object.freeze({ phase: "unknown", possibleEffortMismatch: null, pinBoundaryOpen: false });

/** The phase of a match played at `at` (milliseconds since the epoch); unknown for null or a non-finite time. */
export function harnessPhaseAt(at: number | null | undefined, table: readonly HarnessPhaseRow[] = HARNESS_PHASES): HarnessPhase {
  if (typeof at !== "number" || !Number.isFinite(at)) return UNKNOWN;
  const possibleEffortMismatch = at < EFFORT_MISMATCH_UNTIL;
  let phase = table[0]!.phase;
  for (const row of table) if (row.startsAt !== null && at >= row.startsAt) phase = row.phase;
  const pinOpen = table.at(-1)!.startsAt === null;
  return { phase, possibleEffortMismatch, pinBoundaryOpen: pinOpen && phase === "rounds 26-30" && at >= ROUND_30_CLOSED_AT };
}

/** The Model Index's ranked modes: house-1v1 to house-4v4. */
const INDEX_MODES: readonly string[] = ["house-1v1", "house-2v2", "house-3v3", "house-4v4"];
export const isIndexMode = (mode: string | null | undefined): boolean => typeof mode === "string" && INDEX_MODES.includes(mode);
