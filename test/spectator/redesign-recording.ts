/**
 * A scripted redesign match for the spectator tests: the public redesign rules
 * (count marks, autonomous free ants, queens with HP) with the queen shield shortened, so the
 * match reaches bites on a queen and a colony's fall within a few thousand ticks. The agents
 * join at tick 0 (more on colony 0, so colony 1's queen falls), lay count marks and attack the
 * enemy queen at the rules' command rate, as src/live/record.ts's scripted agents do. Messages
 * are encoded with the live stream's recorder and decoded again, so they are exactly what the
 * client receives: the first a full snapshot.
 */
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { agentId } from "../../src/live/record.ts";
import type { HatchTimingRules, SimConfig, TerrainRules } from "../../src/sim/config.ts";
import { HISTORICAL_CASTE_CONFIG, HISTORICAL_PUBLIC_CONFIG, PRE_FRONTLINE_CONFIGS } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";
import { createMatch } from "../../src/sim/map.ts";
import { SUB } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import { COUNT_VERBS, type ColonyId, type SimInput, type SimState } from "../../src/sim/types.ts";

export interface RedesignScript {
  readonly seed: number;
  /** Agents joining at tick 0: the first two thirds on colony 0, the rest on colony 1. */
  readonly agents: number;
  readonly ticks: number;
  /** Ticks before a queen can be bitten (the public rules' 3000 shortened for the tests). */
  readonly shieldTicks?: number;
  /** Explicit scene settings; omitted keeps every historical recording default. */
  readonly sceneSettings?: {
    readonly terrain: TerrainRules;
    readonly hatchTiming: HatchTimingRules;
  };
  /** Record from this tick on, as a recording captured mid-match is: its first message a full snapshot at that tick. */
  readonly startAt?: number;
}

/** The stored pre-frontline redesign recipe on its original controls, with uncapped count marks: the
 * recorded queen-hit/fall scene. The live DEFEND change has its own behavior coverage.
 */
export function redesignConfig(shieldTicks = 300): SimConfig {
  const { adjudication: _adjudication, controlRevision: _controlRevision, hatchTiming: _hatchTiming, softSeparation: _softSeparation, patrolLinkTiles: _patrol, ...recorded } = PRE_FRONTLINE_CONFIGS.redesign;
  const base: SimConfig = {
    ...HISTORICAL_CASTE_CONFIG, ...recorded,
    terrain: { ...recorded.terrain!, rocks: undefined },
    queenFounding: HISTORICAL_PUBLIC_CONFIG.queenFounding,
    countMarks: { recruitTiles: 8, defendTiles: 3, recruitColonyWide: true, placement: "colony_sight", reportClaimAvailability: true },
  };
  return { ...base, players: 2, queenHp: { ...base.queenHp!, shieldTicks } };
}

const WORD_MARKS = [["GATHER", "NEST"], ["ENEMY", "MANY", "E"], ["ATTACK", "QUEEN"]] as const;

/** The scripted agents' calls for the step about to run: every commandFloorTicks a count mark, every third command an attack order with a word mark. */
function inputs(state: SimState, o: RedesignScript): SimInput[] {
  const tick = state.tick;
  const c = state.config;
  if (tick === 0) {
    return Array.from({ length: o.agents }, (_, i): SimInput => ({ type: "join", agentId: agentId(i), placement: (i < Math.ceil((2 * o.agents) / 3) ? 0 : 1) as ColonyId, modelLabel: `scripted-${i}` }));
  }
  const out: SimInput[] = [];
  for (let i = 0; i < o.agents; i++) {
    const id = agentId(i);
    const agent = state.agents.find((a) => a.id === id);
    if (agent === undefined) continue;
    if ((tick - 1 - 3 * i) % c.commandFloorTicks !== 0) {
      if ((tick + 7 * i) % 60 === 0) out.push({ type: "observe", agentId: id });
      continue;
    }
    const k = Math.floor(tick / c.commandFloorTicks);
    if (k % 3 === 0) {
      const enemy = state.colonies[(1 - agent.colony) as ColonyId];
      out.push({ type: "order", agentId: id, order: { kind: "attack", tileX: Math.floor(enemy.queenX / SUB), tileY: Math.floor(enemy.queenY / SUB) }, intent: `push on their queen (${i})`, mark: { words: WORD_MARKS[(i + k) % WORD_MARKS.length]! } });
    } else {
      out.push({ type: "count_mark", agentId: id, verb: COUNT_VERBS[(i + k) % COUNT_VERBS.length]!, count: 4 + ((i + k) % 9) });
    }
  }
  return out;
}

/** Play the scripted match and return its stream, decoded as the client decodes it. */
export function playRedesign(o: RedesignScript): StreamMessage[] {
  const config = redesignConfig(o.shieldTicks);
  const scene = o.sceneSettings;
  let state = createMatch(o.seed, playable(scene === undefined ? config : {
    ...config, terrain: scene.terrain, hatchTiming: scene.hatchTiming,
  }));
  const roundTrip = (m: StreamMessage) => decodeMessage(encodeMessage(m));
  const out: StreamMessage[] = [];
  // The recorder opens with a full snapshot of the state it is made at: the start, or startAt for a mid-match capture.
  const open = (): SpectatorRecorder => {
    const r = new SpectatorRecorder(state);
    out.push(roundTrip({ ...r.initial(), full: r.initialFull() }));
    return r;
  };
  let recorder: SpectatorRecorder | null = o.startAt ? null : open();
  while (state.tick < o.ticks && state.result === null) {
    const result = step(state, inputs(state, o));
    state = result.state;
    if (recorder === null) {
      if (state.tick >= o.startAt!) recorder = open();
      continue;
    }
    const rec = recorder.record(result);
    out.push(roundTrip({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events }));
  }
  return out;
}
