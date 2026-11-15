import type { SimConfig, WaterRect } from "./config.js";
import type { AgentView } from "./view.js";

/**
 * Colony index, 0 to 3: 0 = Very Large Colony, 1 = Lake Hodges Colony. A
 * two-colony match uses 0 and 1 only; a four-colony match also uses 2 and 3.
 */
export type ColonyId = number;

/** A colony index in a two-colony match. */
export type TwoColonyId = 0 | 1;

/**
 * Narrows a colony to a two-colony match's 0 or 1, for code that still
 * supports two colonies only. Throws on any other colony.
 */
export function asTwoColony(colony: ColonyId): TwoColonyId {
  if (colony !== 0 && colony !== 1) throw new Error(`colony ${colony} is outside a two-colony match`);
  return colony;
}

/** Tile owner: a colony, or -1 for neutral. */
export type TileOwner = ColonyId | -1;

/** Ant caste (caste switch on only). */
export type Caste = "worker" | "soldier";

/** What an agent asks its colony to breed (caste switch on only). */
export const BROODS = ["workers", "soldiers", "mixed"] as const;
export type Brood = (typeof BROODS)[number];

/** House-bot role. Kept on the ant and rebalanced each tick. */
export type Role = "forager" | "guard" | "fighter";

export interface Ant {
  /** Stable id, never reused within a match. */
  readonly id: number;
  readonly colony: ColonyId;
  /** Position in sub-tile units. */
  x: number;
  y: number;
  /** Hit points in milli-HP. */
  hp: number;
  carrying: boolean;
  role: Role;
  /** House guard's nest, present only with multi-queen rules. */
  guardQueenId?: number;
  /** Agent holding this ant in its squad, or null. */
  squad: string | null;
  /** Velocity actually applied on the last tick, in sub-tile units. */
  vx: number;
  vy: number;
  /** Food tile index this ant is foraging toward, or -1. */
  foodTarget: number;
  /** Immutable own resting destination, present only in point-arrival opt-in matches. */
  pointRest?: { readonly key: string; readonly x: number; readonly y: number };
  /** Rules 27: the spawn point this newborn is walking to and the queen that set it; absent otherwise. */
  spawnWalk?: { readonly queenId: number; readonly tileX: number; readonly tileY: number };
  /** Explicit cluster-only food retarget, not arrival history. */
  softFoodTarget?: number;
  /** Id of the enemy this ant hit last tick, or -1 (for fight-start events). */
  lastTargetId: number;
  /** Present only with the rules switch on. */
  caste?: Caste;
  /** The count mark this ant has claimed; absent when free and outside the variant. */
  claim?: number;
  /** Next patrol mark id; present only in patrol-enabled matches while claimed. */
  patrolWaypoint?: number;
  /** Rules 27: where a free soldier of an agent-seated colony holds (config-grid tile); absent otherwise. */
  holdPoint?: { readonly tileX: number; readonly tileY: number };
}

/** The sixteen-word mark vocabulary. */
export const WORDS = [
  "FOOD", "ENEMY", "QUEEN", "NEST", "HELP",
  "GO", "HOLD", "ATTACK", "AVOID", "GATHER",
  "FEW", "MANY",
  "N", "S", "E", "W",
] as const;
export type Word = (typeof WORDS)[number];

/** Count-mark verbs, separate from the public vocabulary so today's briefing and tools are unchanged. */
export const COUNT_VERBS = ["DEFEND", "FORAGE", "ATTACK", "GATHER"] as const;
export type CountVerb = (typeof COUNT_VERBS)[number];
/** New jobs do not extend the recorded legacy vocabulary or its four board symbols. */
export type CountMarkVerb = CountVerb | "PATROL" | "LINE";

export const COUNT_CASTES = ["any", "worker", "soldier"] as const;
export type CountCaste = (typeof COUNT_CASTES)[number];

/** Standing orders. Tile coordinates. */
export type Order =
  | { readonly kind: "go_to"; readonly tileX: number; readonly tileY: number }
  | { readonly kind: "forage" }
  | { readonly kind: "hold" }
  | { readonly kind: "attack"; readonly tileX: number; readonly tileY: number }
  | { readonly kind: "follow_trail" };

export interface CountMarkAvailability {
  readonly claimedAnts: number;
  readonly freeAntsNow: number;
}

export interface Mark {
  readonly id: number;
  readonly agentId: string;
  readonly colony: ColonyId;
  readonly tileX: number;
  readonly tileY: number;
  readonly words: readonly Word[];
  readonly laidTick: number;
  /** Squad ants following this mark under follow_trail now (marks steer no non-squad ants). */
  steering: number;
  /** A count mark's verb and count; absent on word marks. A count mark has no words. */
  verb?: CountMarkVerb;
  count?: number;
  /** Absent is any: preserve the exact state shape of unfiltered marks. */
  caste?: Caste;
  /** Times this count mark was re-laid in place to change its count; 0 when first laid. */
  revision?: number;
  /** Cumulative deaths while claimed by this mark; absent in recorded pre-accounting rules. */
  antsLost?: number;
  /** Enemy ant deaths credited to this mark's current ants, one killer per death. */
  enemiesKilled?: number;
  /** Rules 26 LINE marks only: the second endpoint; absent on every other mark. */
  readonly toTileX?: number;
  readonly toTileY?: number;
}

export interface Agent {
  readonly id: string;
  readonly colony: ColonyId;
  /** Join order across the match; squads fill in this order. */
  readonly joinSeq: number;
  readonly modelLabel: string | null;
  /** Absent on historical states so their hashes remain unchanged. */
  readonly thinkingLevel?: string;
  /** Self-reported service tier; absent on historical states and when not given, so their hashes remain unchanged. */
  readonly serviceTier?: string;
  readonly parentAgentId: string | null;
  /** Ant ids in the squad, in draft order. */
  squad: number[];
  order: Order;
  lastCallTick: number;
  lastCommandTick: number | null;
  /** Seat timeout starts here until the first accepted command; absent in historical states. */
  joinedTick?: number;
  /** True after expiry; command-idle rules wake only on an accepted command, historical rules on any call. */
  idle: boolean;
  /** Fogged events seen since the agent's previous call. */
  pendingEvents: VisibleEvent[];
  /** The brood this agent chose; absent until it sets one (rules switch on only). */
  brood?: Brood;
}

/** Agent inputs, applied in the given order at the tick boundary. Every one is an agent call. */
export type SimInput =
  | {
      readonly type: "join";
      readonly agentId: string;
      readonly colony?: ColonyId;
      /**
       * Operator placement: the colony this agent is put
       * on, whatever the balance. Only the server sets it, for a colony a playtest
       * lineup declares; the MCP join tool never accepts it.
       */
      readonly placement?: ColonyId;
      readonly modelLabel?: string;
      readonly thinkingLevel?: string;
      readonly serviceTier?: string;
      readonly parentAgentId?: string;
      /** Rules 27, lobby seats only: the starting queen this seat picked, which its agent owns. Only the server sets it; the MCP join tool never accepts it. */
      readonly queenId?: number;
    }
  | { readonly type: "rejoin"; readonly agentId: string }
  | { readonly type: "observe"; readonly agentId: string }
  | { readonly type: "found_queen"; readonly agentId: string; readonly tileX: number; readonly tileY: number }
  | { /** Rules 27: set the brood of one live queen this agent owns; queenId is needed only when it owns more than one. Outside the shared command floor. */ readonly type: "set_brood"; readonly agentId: string; readonly brood: string; readonly queenId?: number }
  | {
      readonly type: "order";
      readonly agentId: string;
      readonly order: Order;
      readonly mark?: MarkSpec;
      readonly intent?: string;
      /** The squad's brood choice; read only with the rules switch on. */
      readonly brood?: Brood;
    }
  | {
      readonly type: "mark";
      readonly agentId: string;
      readonly tileX?: number;
      readonly tileY?: number;
      readonly words: readonly string[];
    }
  | {
      /** Count mark; accepted only when the config has countMarks. */
      readonly type: "count_mark";
      readonly agentId: string;
      readonly tileX?: number;
      readonly tileY?: number;
      readonly verb: string;
      readonly count: number;
      readonly caste?: string;
      /** Rules 27, verb REMOVE: the id of the agent's own count mark to remove. */
      readonly markId?: number;
      /** Rules 26: a LINE mark's second endpoint; refused on every other verb. */
      readonly toTileX?: number;
      readonly toTileY?: number;
      /** Rules 27, verb SPAWN: the own live queen whose spawn point is set (tileX, tileY) or cleared (both omitted). */ readonly queenId?: number;
    };

/**
 * A mark as sent. With tileX and tileY both left out
 * it is laid where one of the agent's squad ants stands when it is processed;
 * otherwise it goes on the named tile, which one of those ants must stand on.
 */
export interface MarkSpec {
  readonly tileX?: number;
  readonly tileY?: number;
  readonly words: readonly string[];
}

export type InputErrorCode =
  | "unknown_agent"
  | "duplicate_agent"
  | "match_over"
  | "rate_limited"
  | "bad_order"
  | "intent_too_long"
  | "bad_mark_words"
  | "no_own_ant_on_tile"
  | "count_mark_not_visible"
  | "queen_disabled"
  | "queen_tile_not_held"
  | "queen_too_close"
  | "queen_cooldown"
  | "queen_too_early"
  | "queen_limit"
  | "queen_food"
  | "no_active_queen"
  /** Rules 27 set_brood: unavailable, an unknown brood, or no queenId while the caller owns several live queens. */
  | "bad_brood"
  /** Rules 27 set_brood: the caller owns no live queen, or none with the given queenId. */
  | "no_owned_queen"
  | "count_marks_disabled"
  | "bad_count_mark"
  | "bad_mark_removal"
  | "water_tile"
  | "rock_tile"
  | "bad_spawn_point"
  | "queen_not_owned";

export interface InputError {
  readonly code: InputErrorCode;
  readonly message: string;
  /** For rate_limited: the first tick a command is accepted. */
  readonly nextAllowedTick?: number;
  /**
   * For count_mark_not_visible with both coordinates given or both omitted, and
   * for water_tile and rock_tile: the nearest tile the same command's tile
   * rules accept at this tick, or null when none does.
   */
  readonly nearestTile?: { readonly tileX: number; readonly tileY: number } | null;
}

/** A stable nest identity within its colony. Lost queens remain in history; never hatch again. */
export interface QueenState {
  readonly id: number;
  /** Explicit lobby-start identity; absent on founded queens and historical states. */
  readonly starting?: true;
  readonly queenX: number;
  readonly queenY: number;
  readonly foundedTick: number;
  lastHatchTick: number;
  overrunTicks: number;
  lostTick: number | null;
  /** Queen HP in milli-HP; absent outside the redesign variant. */
  hp?: number;
  /** Last tick she bit, and the tick her regeneration clock last restarted. */
  lastBiteTick?: number;
  regenFromTick?: number;
  /** Rules 27: the player's spawn point for this queen's new ants (config-grid tile); absent when unset. */
  spawnPoint?: { readonly tileX: number; readonly tileY: number };
  /** Rules 27: the agentId of the agent that owns this queen; absent until assigned, and in every other rules version. */
  owner?: string;
  /** Rules 27: the brood her owner last set with set_brood; absent breeds mixed. */
  brood?: Brood;
  /** Rules 27, colony with an agent: the caste her mixed brood hatches next; absent is worker. */
  mixedNext?: Caste;
}

export interface ColonyState {
  /** Authoritative nests with queen rules enabled; absent in historical rules. */
  queens?: QueenState[];
  lastQueenFoundedTick?: number;
  readonly id: ColonyId;
  /** Original nest position; historical rules use the legacy timing/progress below. */
  readonly queenX: number;
  readonly queenY: number;
  /** Delivered food not yet spent on hatching. */
  foodStore: number;
  lastHatchTick: number;
  /** Consecutive ticks with an enemy majority near the queen. */
  overrunTicks: number;
  /** The caste a mixed brood hatches next (rules switch on only). */
  mixedNext?: Caste;
  /** Tile indexes holding food the colony's ants have seen; redesign only. */
  seenFood?: number[];
  /** Four-colony matches only: kills credited to this colony (the last hit on an ant or queen). */
  kills?: number;
  /** Four-colony matches only: set once, on the tick the colony left the match. */
  eliminated?: Elimination;
}

/** Why a four-colony colony left the match: its last queen died, or the server found its seats idle. */
export type EliminationReason = "queens_killed" | "idle";

/** A colony's time-up scores, in time-up order. */
export interface ColonyScores {
  readonly kills: number;
  /** Physical original-tile area held. */
  readonly territory: number;
  readonly ants: number;
  readonly delivered: number;
}

export interface Elimination {
  readonly tick: number;
  readonly reason: EliminationReason;
  /** The colony's scores just before that tick removed its ants and neutralised its tiles. */
  readonly scores: ColonyScores;
}

export interface MatchStats {
  /** One entry per colony, in colony order. */
  delivered: number[];
  hatched: number[];
  deaths: number[];
  /** Fight starts (an ant attacking a new target). */
  fights: number;
  /** Tiles that went straight from one colony to the other. */
  ownerChanges: number;
  /** Hits that carried the defender bonus, per attacking colony. */
  bonusHits: number[];
}

export type WinReason = "overrun" | "time_up" | "double_overrun" | "queens_killed" | "sustained_territory" | "abandoned" | "idle";

export interface MatchResult {
  /** Winning colony, or null for a draw. */
  readonly winner: ColonyId | null;
  readonly reason: WinReason;
  /** Which tiebreak decided a time-up result; "idle" for an idle loss, "draw" when both colonies idled. */
  readonly decidedBy: "overrun" | "territory" | "ants_alive" | "food_delivered" | "draw" | "queens_killed" | "kills" | "idle";
  readonly tick: number;
}

/** Public appearance byte: low five bits rotation, next two size, high bit mirrored. */
export interface Rock extends WaterRect {
  readonly appearance: number;
}

/** Static public geography; shared unchanged by cloneState. */
export interface Terrain {
  readonly mapId: string;
  readonly mapName: string;
  readonly water: readonly WaterRect[];
  /** Static impassable footprints; absent on historical water-only terrain. */
  readonly rocks?: readonly Rock[];
}
export interface SimState {
  readonly terrain?: Terrain;
  readonly config: SimConfig;
  readonly seed: number;
  /** Ticks completed so far. */
  tick: number;
  rngState: number;
  nextAntId: number;
  ants: Ant[];
  /** One entry per colony, indexed by colony id. */
  colonies: ColonyState[];
  /** Food per tile, row-major. */
  food: number[];
  /** Per-tile regrowth ceiling, row-major. Never mutated. */
  readonly foodCap: readonly number[];
  /** Owner per tile, row-major. */
  owner: TileOwner[];
  /** Last tick an ant of the owner stood on the tile (or the tile was locked). */
  lastVisit: number[];
  stats: MatchStats;
  result: MatchResult | null;
  agents: Agent[];
  marks: Mark[];
  nextMarkId: number;
  /** Consecutive qualifying ticks; absent in historical configurations. */
  earlyWinProgress?: { leader: ColonyId | null; ticks: number };
}

interface AntEventBase {
  readonly tick: number;
  /** Tile where it happened. */
  readonly tileX: number;
  readonly tileY: number;
}

/** Renderer-neutral step events. Every event about an ant carries its id. */
export type SimEvent =
  | (AntEventBase & { readonly type: "hatch"; readonly antId: number; readonly colony: ColonyId; readonly caste?: Caste })
  | (AntEventBase & {
      readonly type: "fight";
      readonly antId: number;
      readonly targetId: number;
      readonly colony: ColonyId;
    })
  | (AntEventBase & { readonly type: "death"; readonly antId: number; readonly colony: ColonyId })
  | {
      readonly type: "overrun_progress";
      readonly tick: number;
      readonly queenId?: number;
      /** The colony whose queen is being overrun. */
      readonly colony: ColonyId;
      readonly progressTicks: number;
      readonly requiredTicks: number;
    }
  | (AntEventBase & { readonly type: "queen_founded" | "queen_lost"; readonly colony: ColonyId; readonly queenId: number; readonly foodCost?: number })
  /** A queen's HP changed (redesign only). */
  | (AntEventBase & { readonly type: "queen_hp"; readonly colony: ColonyId; readonly queenId: number; readonly hp: number })
  | { readonly type: "match_end"; readonly tick: number; readonly result: MatchResult }
  | (AntEventBase & {
      readonly type: "mark_laid";
      readonly markId: number;
      readonly agentId: string;
      readonly colony: ColonyId;
      readonly words: readonly Word[];
      /** Count marks only. */
      readonly verb?: CountMarkVerb;
      readonly count?: number;
      readonly caste?: CountCaste;
      /** LINE marks only (rules 26). */
      readonly toTileX?: number;
      readonly toTileY?: number;
    })
  | (AntEventBase & {
      readonly type: "count_mark_accepted";
      readonly markId: number;
      readonly agentId: string;
      readonly colony: ColonyId;
      readonly verb: CountMarkVerb;
      readonly count: number;
      readonly caste?: CountCaste;
      /** LINE marks only (rules 26). */
      readonly toTileX?: number;
      readonly toTileY?: number;
      readonly availability: CountMarkAvailability;
      readonly message: string;
    })
  | {
      readonly type: "agent_join";
      readonly tick: number;
      readonly agentId: string;
      readonly colony: ColonyId;
      readonly modelLabel: string | null;
      readonly thinkingLevel?: string;
      readonly serviceTier?: string;
      readonly parentAgentId: string | null;
    }
  | {
      readonly type: "agent_call";
      readonly tick: number;
      readonly agentId: string;
      readonly call: SimInput["type"];
      readonly accepted: boolean;
    }
  | {
      readonly type: "order";
      readonly tick: number;
      readonly agentId: string;
      readonly order: Order;
      /** Spectator-only intent line; never shown in an agent view. */
      readonly intent: string | null;
    }
  | {
      readonly type: "squad_filled" | "squad_released";
      readonly tick: number;
      readonly agentId: string;
      readonly antIds: readonly number[];
    };

/** Fogged events and private count-mark acceptance notices. Joins, calls, orders and intent lines never appear. */
export type VisibleEvent = Extract<SimEvent, { type: "hatch" | "fight" | "death" | "mark_laid" | "queen_founded" | "queen_lost" | "count_mark_accepted" }>;

/** The result of one input, aligned with the inputs passed to step. */
export type InputResult =
  | { readonly ok: true; readonly view: AgentView; /** Rules 27: the queen an accepted set_brood changed, and her brood. */ readonly broodSet?: BroodSet }
  | { readonly ok: false; readonly error: InputError; readonly view: AgentView | null };

/** Rules 27: what an accepted set_brood set. */
export interface BroodSet {
  readonly queenId: number;
  readonly brood: Brood;
}

export interface StepOutput {
  readonly state: SimState;
  readonly events: SimEvent[];
  readonly results: InputResult[];
}
