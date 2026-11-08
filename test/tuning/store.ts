// The tuning loop's shared store ("Shared lane store"): one directory, given to every
// agent as --store, that 30 or more agents on one host read and write at once.
//
// It holds each agent's lane binding, the shared checkpoint, the once-only noise check
// (arrivals, runs and verdict), one baseline chain per lane, and every agent's try records.
// There is no lock, queue or server: every record is a file created once (written in full to a
// scratch file, then hard-linked into place, so a reader never sees a partial record and a
// second writer cannot replace the first). A lane's baseline is the newest version in its chain,
// read by every agent in that lane; there is no per-agent baseline. A kept edit advances its lane
// by compare-and-swap: it creates the version after the one it was timed against, and a keep
// that finds that version already taken gets "stale".
//
// Layout under the store directory:
//   bindings/<agentId>.json        { agentId, lane }
//   checkpoints/<name>             checkpoint text
//   noise/arrivals/<position>      agentId, positions 000001.. in arrival order
//   noise/runs/<agentId>.json      { agentId, medianTickMs, workload? }
//   noise/verdict.json             { verdict, baseCommit }
//   lanes/<lane>/<version>.json    one lane version: version 0 from the noise check, then one per kept edit
//   tries/<agentId>/<seq>.json     one TryRecord, seq 000000.. in the agent's own order
//   .scratch/                      partly written files before they are linked into place

import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { median } from "../../src/tickStats.ts";
import { laneById, LANES, type Lane, type LaneId } from "./lanes.ts";

/**
 * What a try or the noise check timed: the checkpoint (the SHA-256 of its text), the ticks timed from it, and the
 * timing method: the discarded warm-up runs and the timed runs whose median is the tick time.
 */
export interface TryWorkload {
  readonly checkpoint: string;
  readonly ticks: number;
  readonly warmup: number;
  readonly repeats: number;
}

/** One agent's noise-check run and the workload it timed. */
export interface NoiseRun {
  readonly agentId: string;
  readonly medianTickMs: number;
  readonly workload?: TryWorkload;
}

export interface NoiseVerdict {
  readonly runs: readonly { agentId: string; medianTickMs: number }[];
  readonly spread: number;
  readonly limit: number;
  readonly pass: boolean;
  readonly at: string;
  /** The workload the four runs timed; a keep judges only tries of this same workload, and refuses every try without it. */
  readonly workload?: TryWorkload;
}

/** One version of a lane: the lane's base commit plus its kept patches, in order, and its tick time. */
export interface LaneBaseline {
  readonly lane: LaneId;
  /** 0 is the unchanged code, timed by the noise check; each kept edit adds one. */
  readonly version: number;
  readonly baseCommit: string;
  readonly patches: readonly string[];
  /** Version 0: the median of the noise check's runs. Later versions: the kept candidate's measured median. */
  readonly medianTickMs: number;
  /** The workload, timing method included, medianTickMs was measured on: the noise check's for version 0, the kept try's after. */
  readonly workload?: TryWorkload;
  /** The agent whose edit made this version; "noise-check" for version 0. */
  readonly agentId: string;
  readonly at: string;
}

export interface TryRecord {
  readonly agentId: string;
  readonly lane: LaneId;
  readonly baselineVersion: number;
  readonly medianTickMs: number;
  readonly baselineMedianTickMs: number;
  readonly relative: number;
  readonly noise: number;
  /** The workload, timing method included, the try's medianTickMs was measured on. */
  readonly workload?: TryWorkload;
  readonly decision: "keep" | "drop";
  readonly reasons: readonly string[];
  readonly patch?: string;
  readonly at: string;
}

export interface Store {
  /** Binds the agent to its one lane and returns it. The first binding wins; binding the agent to another lane is refused. */
  bindAgent(agentId: string, lane: LaneId): Lane;
  /** Stores the named checkpoint once; true for the writer that stored it, false when it already existed. */
  putCheckpoint(name: string, text: string): boolean;
  checkpoint(name: string): string | null;
  /** Records the agent's arrival for the noise check and returns its 1-based arrival position; arriving again returns the same position. */
  arriveForNoise(agentId: string): number;
  /** Arrived agents in arrival order. */
  noiseArrivals(): readonly string[];
  /** Stores the agent's noise-check run, with the workload it timed, once; a second run for the same agent is refused. */
  writeNoiseRun(agentId: string, medianTickMs: number, workload?: TryWorkload): void;
  /** Stored noise-check runs, ordered by agent id. */
  noiseRuns(): readonly NoiseRun[];
  /** Stores the verdict once and returns the stored one (first writer wins). A passing verdict writes version 0 of every lane. */
  settleNoise(verdict: NoiseVerdict, baseCommit: string): NoiseVerdict;
  noise(): NoiseVerdict | null;
  /** The lane's current baseline: its newest version, or null before a passing noise check. */
  baseline(lane: LaneId): LaneBaseline | null;
  /** One stored version of the lane, as baseline() returns it when that version is the newest; null when the lane has no such version. */
  laneVersion(lane: LaneId, version: number): LaneBaseline | null;
  /** Compare-and-swap: makes the kept edit the lane's next version if fromVersion is still its newest version, else "stale". */
  advanceLane(lane: LaneId, fromVersion: number, kept: { patch: string; medianTickMs: number; agentId: string; workload?: TryWorkload }): LaneBaseline | "stale";
  /** Stores one try record; its agent must be bound to the record's lane. */
  recordTry(record: TryRecord): void;
  /** Stored try records, ordered by agent id, then each agent's own order. */
  tries(filter?: { lane?: LaneId; agentId?: string }): readonly TryRecord[];
  /** The lane's kept edits: its versions from 1, in order. */
  keptEdits(lane: LaneId): readonly LaneBaseline[];
}

/** Agent id given to version 0 of every lane, which the noise check timed rather than one agent's edit. */
export const NOISE_CHECK_AGENT = "noise-check";

interface StoredVersion {
  readonly lane: LaneId;
  readonly version: number;
  readonly baseCommit: string;
  /** null for version 0. */
  readonly patch: string | null;
  readonly medianTickMs: number;
  readonly workload?: TryWorkload;
  readonly agentId: string;
  readonly at: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function checkName(kind: string, value: string): string {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error(`invalid ${kind} "${value}": use letters, digits, ".", "_" or "-"`);
  return value;
}

function checkTime(kind: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`invalid ${kind} ${value}: a positive finite number of milliseconds`);
  return value;
}

const pad = (n: number): string => String(n).padStart(6, "0");

/** Numbers of the files in dir named <6 digits><suffix>, ascending; [] when dir is missing. */
function numbered(dir: string, suffix: string): number[] {
  const pattern = new RegExp(`^\\d{6}${suffix.replace(".", "\\.")}$`);
  return list(dir).filter((name) => pattern.test(name)).map((name) => Number(name.slice(0, 6))).sort((a, b) => a - b);
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readJson<T>(path: string): T | null {
  const text = readText(path);
  return text === null ? null : (JSON.parse(text) as T);
}

/** Opens (creating if needed) the store directory dir. Every agent opens the same directory. */
export function openStore(dir: string): Store {
  const scratch = join(dir, ".scratch");
  const bindings = join(dir, "bindings");
  const checkpoints = join(dir, "checkpoints");
  const arrivals = join(dir, "noise", "arrivals");
  const runs = join(dir, "noise", "runs");
  const verdictPath = join(dir, "noise", "verdict.json");
  const lanesDir = join(dir, "lanes");
  const triesDir = join(dir, "tries");
  for (const path of [scratch, bindings, checkpoints, arrivals, runs, triesDir, ...LANES.map((lane) => join(lanesDir, lane.id))]) {
    mkdirSync(path, { recursive: true });
  }

  /** Creates path with exactly text unless it exists; true when this call created it. */
  function createOnce(path: string, text: string): boolean {
    const temp = join(scratch, `${process.pid}-${randomUUID()}`);
    writeFileSync(temp, text);
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      unlinkSync(temp);
    }
  }

  function boundLane(agentId: string): LaneId | null {
    return readJson<{ lane: LaneId }>(join(bindings, `${checkName("agent id", agentId)}.json`))?.lane ?? null;
  }

  function requireBound(agentId: string, lane: LaneId, action: string): void {
    const bound = boundLane(agentId);
    if (bound === null) throw new Error(`agent ${agentId} is not bound to a lane; it cannot ${action}`);
    if (bound !== lane) throw new Error(`agent ${agentId} is bound to lane ${bound}; it cannot ${action} in lane ${lane}`);
  }

  function versionPath(lane: LaneId, version: number): string {
    return join(lanesDir, lane, `${pad(version)}.json`);
  }

  /** The lane's stored versions 0..n in order. */
  function chain(lane: LaneId): StoredVersion[] {
    laneById(lane);
    const versions = numbered(join(lanesDir, lane), ".json");
    const stored: StoredVersion[] = [];
    for (const [index, version] of versions.entries()) {
      if (version !== index) throw new Error(`lane ${lane} is missing version ${index}`);
      stored.push(readJson<StoredVersion>(versionPath(lane, version))!);
    }
    return stored;
  }

  /** Each stored version as a LaneBaseline, carrying every kept patch up to and including it. */
  function baselines(lane: LaneId): LaneBaseline[] {
    const patches: string[] = [];
    return chain(lane).map((v) => {
      if (v.patch !== null) patches.push(v.patch);
      return Object.freeze({
        lane: v.lane, version: v.version, baseCommit: v.baseCommit, patches: Object.freeze([...patches]),
        medianTickMs: v.medianTickMs, ...(v.workload === undefined ? {} : { workload: v.workload }), agentId: v.agentId, at: v.at,
      });
    });
  }

  /**
   * The stored verdict, or null. When it passed, every lane's version 0 is made to exist before it
   * is returned: the settler writes the verdict first (so the first verdict wins) and version 0 just
   * after, so any reader that sees a passing verdict before then completes version 0 itself, from
   * that same stored verdict.
   */
  function storedVerdict(): NoiseVerdict | null {
    const stored = readJson<{ verdict: NoiseVerdict; baseCommit: string }>(verdictPath);
    if (stored === null) return null;
    if (stored.verdict.pass) writeVersionZero(stored);
    return stored.verdict;
  }

  function writeVersionZero(stored: { verdict: NoiseVerdict; baseCommit: string }): void {
    const times = stored.verdict.runs.map((run) => run.medianTickMs).sort((a, b) => a - b);
    for (const lane of LANES) {
      if (existsSync(versionPath(lane.id, 0))) continue;
      const v0: StoredVersion = {
        lane: lane.id, version: 0, baseCommit: stored.baseCommit, patch: null, medianTickMs: median(times),
        ...(stored.verdict.workload === undefined ? {} : { workload: stored.verdict.workload }), agentId: NOISE_CHECK_AGENT, at: stored.verdict.at,
      };
      createOnce(versionPath(lane.id, 0), JSON.stringify(v0));
    }
  }

  return {
    bindAgent(agentId, lane) {
      const chosen = laneById(lane);
      createOnce(join(bindings, `${checkName("agent id", agentId)}.json`), JSON.stringify({ agentId, lane: chosen.id }));
      const bound = boundLane(agentId)!;
      if (bound !== chosen.id) throw new Error(`agent ${agentId} is already bound to lane ${bound}; it cannot join lane ${chosen.id}`);
      return chosen;
    },

    putCheckpoint(name, text) {
      return createOnce(join(checkpoints, checkName("checkpoint name", name)), text);
    },

    checkpoint(name) {
      return readText(join(checkpoints, checkName("checkpoint name", name)));
    },

    arriveForNoise(agentId) {
      checkName("agent id", agentId);
      const taken = numbered(arrivals, "");
      for (const position of taken) if (readText(join(arrivals, pad(position))) === agentId) return position;
      for (let position = (taken.at(-1) ?? 0) + 1; ; position++) {
        if (createOnce(join(arrivals, pad(position)), agentId)) return position;
      }
    },

    noiseArrivals() {
      const seen = new Set<string>();
      for (const position of numbered(arrivals, "")) seen.add(readText(join(arrivals, pad(position)))!);
      return [...seen];
    },

    writeNoiseRun(agentId, medianTickMs, workload) {
      checkTime("noise-run median", medianTickMs);
      const path = join(runs, `${checkName("agent id", agentId)}.json`);
      const run: NoiseRun = workload === undefined ? { agentId, medianTickMs } : { agentId, medianTickMs, workload };
      if (!createOnce(path, JSON.stringify(run))) throw new Error(`agent ${agentId} has already written its noise-check run`);
    },

    noiseRuns() {
      return list(runs).filter((name) => name.endsWith(".json"))
        .map((name) => readJson<NoiseRun>(join(runs, name))!)
        .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
    },

    settleNoise(verdict, baseCommit) {
      if (typeof baseCommit !== "string" || baseCommit.length === 0) throw new Error("settleNoise needs the base commit the noise check timed");
      if (verdict.pass && verdict.runs.length === 0) throw new Error("a passing noise verdict needs its runs");
      for (const run of verdict.runs) checkTime("noise-run median", run.medianTickMs);
      createOnce(verdictPath, JSON.stringify({ verdict, baseCommit }));
      return storedVerdict()!;
    },

    noise() {
      return storedVerdict();
    },

    baseline(lane) {
      const head = baselines(lane).at(-1);
      if (head !== undefined) return head;
      return storedVerdict()?.pass === true ? baselines(lane)[0]! : null;
    },

    laneVersion(lane, version) {
      if (!Number.isInteger(version) || version < 0) return null;
      storedVerdict(); // a passing verdict completes version 0 before it is read
      return baselines(lane)[version] ?? null;
    },

    advanceLane(lane, fromVersion, kept) {
      laneById(lane);
      requireBound(kept.agentId, lane, "keep an edit");
      if (typeof kept.patch !== "string" || kept.patch.length === 0) throw new Error("a kept edit needs its patch");
      checkTime("kept median", kept.medianTickMs);
      const from = Number.isInteger(fromVersion) && fromVersion >= 0 ? readJson<StoredVersion>(versionPath(lane, fromVersion)) : null;
      if (from === null) throw new Error(`lane ${lane} has no version ${fromVersion}`);
      const next: StoredVersion = {
        lane, version: fromVersion + 1, baseCommit: from.baseCommit, patch: kept.patch, medianTickMs: kept.medianTickMs,
        ...(kept.workload === undefined ? {} : { workload: kept.workload }), agentId: kept.agentId, at: new Date().toISOString(),
      };
      if (!createOnce(versionPath(lane, next.version), JSON.stringify(next))) return "stale";
      return baselines(lane)[next.version]!;
    },

    recordTry(record) {
      requireBound(record.agentId, record.lane, "record a try");
      if (record.decision !== "keep" && record.decision !== "drop") throw new Error(`invalid try decision "${String(record.decision)}"`);
      const dir = join(triesDir, record.agentId);
      mkdirSync(dir, { recursive: true });
      const text = JSON.stringify(record);
      for (let seq = numbered(dir, ".json").length; ; seq++) {
        if (createOnce(join(dir, `${pad(seq)}.json`), text)) return;
      }
    },

    tries(filter = {}) {
      const agents = filter.agentId === undefined ? list(triesDir).sort() : [checkName("agent id", filter.agentId)];
      const records: TryRecord[] = [];
      for (const agentId of agents) {
        const dir = join(triesDir, agentId);
        for (const seq of numbered(dir, ".json")) {
          const record = readJson<TryRecord>(join(dir, `${pad(seq)}.json`))!;
          if (filter.lane === undefined || record.lane === filter.lane) records.push(record);
        }
      }
      return records;
    },

    keptEdits(lane) {
      return baselines(lane).slice(1);
    },
  };
}
