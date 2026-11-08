// Marks replay bar.
// Replays the recorded inputs of real matches with each colony's marks live or inert, plus 20
// paired replays per variant that each delay one of 20 evenly spaced recorded orders by one tick.
// Every match is built from DEFAULT_CONFIG at this head, at grid scale 2, never from the log header's config;
// the log is read here rather than through parseLog, so only its seed and inputs are used.
// No model calls; read-only on the logs.
//
//   node --import ./src/ts-resolve.mjs test/marks-replay/replay.ts \
//     [--variants all-live,vlc-inert,lhc-inert,all-inert] [--workers 5] [--out result.json] log.jsonl [log.jsonl ...]
//
// At least one log is required (the old-rules logs it used to default to are deleted). Inert = the colony's
// mark words replaced by FEW (steers nothing), tile and call unchanged. A colony that laid no
// marks has its inert variant equal to the live one, so that variant is not replayed twice.
// Overrun: the match ended by overrun against the colony (or a double overrun).
// Steered share (all-live exact replay only): per colony, ant-ticks of non-squad ants whose velocity
// differs from a twin step of the same tick with every mark's words made inert (FEW), over all
// non-squad ant-ticks. Only ants present after both steps are compared.
import { writeFileSync } from "node:fs";
import { loadReplayFile } from "../../src/live/replayOptions.js";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { DEFAULT_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { ColonyId, SimInput, SimState } from "../../src/sim/types.js";

export const VARIANTS = ["all-live", "vlc-inert", "lhc-inert", "all-inert"] as const;
export type Variant = (typeof VARIANTS)[number];
const INERT: Record<Variant, readonly ColonyId[]> = { "all-live": [], "vlc-inert": [0], "lhc-inert": [1], "all-inert": [0, 1] };
const PERTURBATIONS = 20;

type Ticks = Map<number, SimInput[]>;
interface OrderRef {
  readonly tick: number;
  readonly idx: number;
}
export interface RunResult {
  readonly winner: ColonyId | null;
  readonly reason: string;
  readonly endTick: number;
  readonly overrun: readonly [boolean, boolean];
  /** Steered and total non-squad ant-ticks per colony. */
  readonly steered: readonly [number, number];
  readonly free: readonly [number, number];
}
interface Job {
  readonly log: string;
  readonly variant: Variant;
  /** -1 = exact replay, else the index of the delayed order among the 20 picks. */
  readonly pick: number;
}

function readLog(path: string): { seed: number; ticks: Ticks } {
  const lines = loadReplayFile(path).lines.filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]!) as { type: string; seed: number };
  if (header.type !== "header") throw new Error(`${path}: no header`);
  const ticks: Ticks = new Map();
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as { tick: number; inputs: SimInput[] };
    ticks.set(entry.tick, entry.inputs);
  }
  return { seed: header.seed, ticks };
}

function colonyOf(seed: number, config: SimConfig, ticks: Ticks): Map<string, ColonyId> {
  const s0 = step(createMatch(seed, config), ticks.get(0) ?? []).state;
  return new Map(s0.agents.map((a) => [a.id, a.colony]));
}

function hasMark(input: SimInput): boolean {
  return input.type === "mark" || (input.type === "order" && input.mark !== undefined);
}

/** Colonies whose agents sent at least one mark. */
export function markingColonies(path: string): ColonyId[] {
  const { seed, ticks } = readLog(path);
  const of = colonyOf(seed, withGridScale(DEFAULT_CONFIG), ticks);
  const out = new Set<ColonyId>();
  for (const list of ticks.values()) for (const input of list) if (hasMark(input)) out.add(of.get(input.agentId)!);
  return [...out].sort();
}

function inertInput(input: SimInput): SimInput {
  if (input.type === "mark") return { ...input, words: ["FEW"] };
  if (input.type === "order" && input.mark !== undefined) return { ...input, mark: { ...input.mark, words: ["FEW"] } };
  return input;
}

function inert(ticks: Ticks, colonies: readonly ColonyId[], of: Map<string, ColonyId>): Ticks {
  const out: Ticks = new Map();
  for (const [t, list] of ticks) {
    out.set(
      t,
      list.map((input) => (colonies.includes(of.get(input.agentId) ?? (-1 as ColonyId)) ? inertInput(input) : input)),
    );
  }
  return out;
}

/** The same tick stepped with every mark, standing and new, made inert. */
function inertTwin(state: SimState, inputs: readonly SimInput[]): SimState {
  const twin: SimState = { ...state, marks: state.marks.map((m) => ({ ...m, words: ["FEW"] })) };
  return step(twin, inputs.map(inertInput)).state;
}

/** The 20 evenly spaced recorded orders, the same in every variant. */
function picks(ticks: Ticks): OrderRef[] {
  const orders: OrderRef[] = [];
  for (const [t, list] of [...ticks].sort((a, b) => a[0] - b[0])) list.forEach((input, idx) => input.type === "order" && orders.push({ tick: t, idx }));
  return Array.from({ length: PERTURBATIONS }, (_, i) => orders[Math.floor(((i + 0.5) * orders.length) / PERTURBATIONS)]!);
}

/** Delay one order by one tick, appended after the next tick's inputs. */
function delayed(ticks: Ticks, o: OrderRef): Ticks {
  const m = new Map(ticks);
  const src = [...(m.get(o.tick) ?? [])];
  const [moved] = src.splice(o.idx, 1);
  if (src.length > 0) m.set(o.tick, src);
  else m.delete(o.tick);
  m.set(o.tick + 1, [...(m.get(o.tick + 1) ?? []), moved!]);
  return m;
}

export function runJob(job: Job): RunResult {
  const { seed, ticks } = readLog(job.log);
  // This counterfactual analysis uses today's config, not the log's rules.
  const config = withGridScale(DEFAULT_CONFIG);
  const of = colonyOf(seed, config, ticks);
  let inputs = inert(ticks, INERT[job.variant], of);
  if (job.pick >= 0) inputs = delayed(inputs, picks(ticks)[job.pick]!);
  let state = createMatch(seed, config);
  const steered: [number, number] = [0, 0];
  const free: [number, number] = [0, 0];
  const measure = job.variant === "all-live" && job.pick === -1;
  while (state.tick < config.matchTicks && state.result === null) {
    const tickInputs = inputs.get(state.tick) ?? [];
    const twin = measure ? new Map(inertTwin(state, tickInputs).ants.map((a) => [a.id, a])) : null;
    state = step(state, tickInputs).state;
    if (twin === null) continue;
    for (const ant of state.ants) {
      const other = twin.get(ant.id);
      if (ant.squad !== null || other === undefined || other.squad !== null) continue;
      free[ant.colony] += 1;
      if (ant.vx !== other.vx || ant.vy !== other.vy) steered[ant.colony] += 1;
    }
  }
  const r = state.result;
  const overrunOf = (c: ColonyId): boolean => r !== null && (r.reason === "double_overrun" || (r.reason === "overrun" && r.winner !== c));
  return {
    winner: r?.winner ?? null,
    reason: r === null ? "none" : `${r.reason}/${r.decidedBy}`,
    endTick: r?.tick ?? state.tick,
    overrun: [overrunOf(0), overrunOf(1)],
    steered,
    free,
  };
}

/** Variants that need a replay of their own; the rest equal another one (a colony without marks). */
function distinctVariant(v: Variant, marking: readonly ColonyId[]): Variant {
  const set = INERT[v].filter((c) => marking.includes(c));
  return VARIANTS.find((w) => INERT[w].length === set.length && INERT[w].every((c) => set.includes(c)))!;
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  for (const job of jobs) parentPort!.postMessage({ job, result: runJob(job) });
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const wanted = (opt("--variants")?.split(",") ?? [...VARIANTS]) as Variant[];
  const workers = Number(opt("--workers") ?? "5");
  const out = opt("--out");
  const logs = args;
  if (logs.length === 0) {
    console.error("usage: node --import ./src/ts-resolve.mjs test/marks-replay/replay.ts [--variants ...] [--workers N] [--out FILE] log.jsonl [log.jsonl ...]");
    process.exit(2);
  }

  const jobs: Job[] = [];
  const marking = new Map(logs.map((log) => [log, markingColonies(log)]));
  for (const log of logs) {
    const own = new Set(wanted.map((v) => distinctVariant(v, marking.get(log)!)));
    for (const variant of own) for (let pick = -1; pick < PERTURBATIONS; pick += 1) jobs.push({ log, variant, pick });
  }
  const buckets: Job[][] = Array.from({ length: Math.min(workers, jobs.length) }, () => []);
  jobs.forEach((j, i) => buckets[i % buckets.length]!.push(j));
  const done: { job: Job; result: RunResult }[] = [];
  const t0 = Date.now();
  await Promise.all(
    buckets.map(
      (bucket) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(fileURLToPath(import.meta.url), { workerData: bucket });
          w.on("message", (d: { job: Job; result: RunResult }) => done.push(d));
          w.on("error", reject);
          w.on("exit", () => resolve());
        }),
    ),
  );

  const report: Record<string, unknown> = { seconds: (Date.now() - t0) / 1000, replays: jobs.length, logs: {} };
  for (const log of logs) {
    const variants: Record<string, unknown> = {};
    for (const v of wanted) {
      const src = distinctVariant(v, marking.get(log)!);
      const mine = done.filter((d) => d.job.log === log && d.job.variant === src);
      const exact = mine.find((d) => d.job.pick === -1)!.result;
      const perturbed = mine.filter((d) => d.job.pick >= 0).sort((a, b) => a.job.pick - b.job.pick).map((d) => d.result);
      const share = (c: ColonyId): number => (exact.free[c] === 0 ? 0 : exact.steered[c] / exact.free[c]);
      variants[v] = {
        sameAs: src === v ? null : src,
        exact: { winner: exact.winner, reason: exact.reason, endTick: exact.endTick },
        overruns: [perturbed.filter((p) => p.overrun[0]).length, perturbed.filter((p) => p.overrun[1]).length],
        steeredShare: v === "all-live" ? [share(0), share(1)] : null,
        perturbed: perturbed.map((p) => `${p.winner ?? "draw"} ${p.reason} ${p.endTick}`),
      };
    }
    // Own marks live are overrun at most once more in 20 than own marks inert,
    // with the other colony's marks live and with them inert.
    const bar: Record<string, unknown> = {};
    if (VARIANTS.every((v) => wanted.includes(v))) {
      const n = (v: Variant, c: ColonyId): number => (variants[v] as { overruns: number[] }).overruns[c]!;
      for (const c of marking.get(log)!) {
        const [ownLive, ownInert, otherInert] = c === 0 ? (["all-live", "vlc-inert", "lhc-inert"] as const) : (["all-live", "lhc-inert", "vlc-inert"] as const);
        const pairs = [
          { other: "live", live: n(ownLive, c), inert: n(ownInert, c) },
          { other: "inert", live: n(otherInert, c), inert: n("all-inert", c) },
        ];
        bar[c] = { pairs, pass: pairs.every((p) => p.live <= p.inert + 1) };
      }
    }
    (report.logs as Record<string, unknown>)[log] = { markingColonies: marking.get(log), variants, bar };
  }
  const text = JSON.stringify(report, null, 1);
  if (out !== undefined) writeFileSync(out, text);
  else console.log(text);
}
