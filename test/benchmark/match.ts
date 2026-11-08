import { defaultAllocator, type Allocator } from "../../src/sim/agents.js";
import { DEFAULT_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { territoryCounts } from "../../src/sim/territory.js";
import type { ColonyId, MatchResult, Order, SimInput, SimState } from "../../src/sim/types.js";
import type { AgentView } from "../../src/sim/view.js";

/** One command an agent sends: an order (optionally carrying a mark) or a standalone mark. */
export type Command =
  | {
      readonly type: "order";
      readonly order: Order;
      readonly mark?: { readonly tileX: number; readonly tileY: number; readonly words: readonly string[] };
    }
  | { readonly type: "mark"; readonly tileX: number; readonly tileY: number; readonly words: readonly string[] };

/** A deterministic agent: sees only its own view, answers with at most one command. */
export interface Brain {
  /**
   * Called with the view its observe returned. `landTick` is the tick the
   * command would take effect (one delay later), so the brain can respect the
   * shared command floor (view.nextCommandTick).
   */
  decide(view: AgentView, landTick: number): Command | null;
}

export interface AgentSpec {
  readonly id: string;
  readonly brain: Brain;
  /**
   * Fixed observe cadence in ticks for agents that never act (idle join).
   * When absent the agent runs the per-call delay loop.
   */
  readonly observeEveryTicks?: number;
}

export interface MatchSpec {
  readonly seed: number;
  readonly config?: SimConfig;
  /** Colony the agents join; null for a house-only match. */
  readonly agentColony: ColonyId | null;
  readonly agents: readonly AgentSpec[];
  /** Decision delay per call, in ticks. */
  readonly delayTicks: number;
}

/** How a match ended: a double overrun is classified by what decided it. */
export type EndType = "overrun" | "territory" | "tiebreak" | "draw";

export interface MatchRecord {
  readonly seed: number;
  readonly agentColony: ColonyId | null;
  readonly result: MatchResult;
  readonly endType: EndType;
  readonly doubleOverrun: boolean;
  /** Final tiles held, per colony. */
  readonly tiles: readonly [number, number];
  /** Tick from which the eventual winner led on territory to the end; null if it never did. */
  readonly lastingLeadTick: number | null;
  /** Deaths of ants that were in an agent squad, per colony. */
  readonly squadDeaths: readonly [number, number];
  readonly minutes: number;
  /** Agent commands the sim rejected (rate limit, mark tile without an own ant, ...). */
  readonly rejectedCommands: number;
  readonly acceptedCommands: number;
  /** Times an agent's squad lapsed to idle on the squad timer. */
  readonly squadLapses: number;
}

export function endTypeOf(result: MatchResult): EndType {
  if (result.reason === "overrun") return "overrun";
  switch (result.decidedBy) {
    case "territory":
      return "territory";
    case "draw":
      return "draw";
    default:
      return "tiebreak";
  }
}

/**
 * Allocator that honours the colony an agent names. The default allocator keeps
 * colonies within one agent of each other, which would split the two scripted
 * agents; the benchmark needs both on one colony. Squad drafting is unchanged.
 */
export const namedColonyAllocator: Allocator = {
  chooseColony(state, join) {
    return join.colony ?? defaultAllocator.chooseColony(state, join);
  },
  rankSpare: defaultAllocator.rankSpare,
};

interface Loop {
  readonly spec: AgentSpec;
  nextObserve: number;
  pending: { readonly tick: number; readonly command: Command } | null;
}

function leaderOf(tiles: readonly [number, number]): ColonyId | null {
  return tiles[0] > tiles[1] ? 0 : tiles[1] > tiles[0] ? 1 : null;
}

/** Play one match straight through the simulation. */
export function playMatch(spec: MatchSpec): MatchRecord {
  const config = spec.config ?? DEFAULT_CONFIG;
  const delay = Math.max(1, spec.delayTicks);
  let state: SimState = createMatch(spec.seed, config);
  const loops: Loop[] = spec.agents.map((a) => ({ spec: a, nextObserve: 1, pending: null }));

  let leader: ColonyId | null = null;
  let leaderSince = 0;
  const squadDeaths: [number, number] = [0, 0];
  let rejected = 0;
  let accepted = 0;
  let lapses = 0;

  while (state.result === null) {
    const tick = state.tick;
    const inputs: SimInput[] = [];
    const kinds: ("join" | "observe" | "command")[] = [];
    const owners: Loop[] = [];
    if (tick === 0 && spec.agentColony !== null) {
      for (const loop of loops) {
        inputs.push({ type: "join", agentId: loop.spec.id, colony: spec.agentColony });
        kinds.push("join");
        owners.push(loop);
      }
    }
    for (const loop of loops) {
      if (loop.pending !== null && loop.pending.tick === tick) {
        const c = loop.pending.command;
        inputs.push(
          c.type === "order"
            ? c.mark === undefined
              ? { type: "order", agentId: loop.spec.id, order: c.order }
              : { type: "order", agentId: loop.spec.id, order: c.order, mark: c.mark }
            : { type: "mark", agentId: loop.spec.id, tileX: c.tileX, tileY: c.tileY, words: c.words },
        );
        kinds.push("command");
        owners.push(loop);
        loop.pending = null;
      }
      if (loop.nextObserve === tick) {
        inputs.push({ type: "observe", agentId: loop.spec.id });
        kinds.push("observe");
        owners.push(loop);
      }
    }

    const inSquad = new Map<number, ColonyId>();
    if (loops.length > 0) for (const ant of state.ants) if (ant.squad !== null) inSquad.set(ant.id, ant.colony);

    const out = step(state, inputs, namedColonyAllocator);
    state = out.state;

    for (const event of out.events) {
      if (event.type === "death") {
        const colony = inSquad.get(event.antId);
        if (colony !== undefined) squadDeaths[colony] += 1;
      } else if (event.type === "squad_released") {
        const agent = state.agents.find((a) => a.id === event.agentId);
        if (agent?.idle === true) lapses += 1;
      }
    }

    out.results.forEach((result, i) => {
      const loop = owners[i]!;
      const kind = kinds[i];
      if (kind === "command") {
        if (result.ok) accepted += 1;
        else rejected += 1;
        return;
      }
      if (kind !== "observe" || result.view === null) return;
      const every = loop.spec.observeEveryTicks;
      if (every !== undefined) {
        loop.nextObserve = tick + every;
        return;
      }
      const landTick = tick + delay;
      const command = loop.spec.brain.decide(result.view, landTick);
      if (command === null) {
        loop.nextObserve = tick + delay;
      } else {
        loop.pending = { tick: landTick, command };
        loop.nextObserve = landTick + delay;
      }
    });

    const now = leaderOf(territoryCounts(state));
    if (now !== leader) {
      leader = now;
      leaderSince = state.tick;
    }
  }

  const result = state.result;
  const tiles = territoryCounts(state);
  return {
    seed: spec.seed,
    agentColony: spec.agentColony,
    result,
    endType: endTypeOf(result),
    doubleOverrun: result.reason === "double_overrun",
    tiles,
    lastingLeadTick: result.winner !== null && leader === result.winner ? leaderSince : null,
    squadDeaths,
    minutes: state.tick / config.ticksPerSecond / 60,
    rejectedCommands: rejected,
    acceptedCommands: accepted,
    squadLapses: lapses,
  };
}
