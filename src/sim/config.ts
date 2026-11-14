import { HOUSE_PAUSED_MAP_IDS, newMatchMaps } from "./mapShapes.js";
import { gridScaleOf, type GridScale } from "./gridScale.js";

/**
 * The one config module for the simulation. Every number here is an untested
 * starting value; the
 * benchmark and playtests tune them. Quantities use integer counts, permille
 * or sub-tile units. Explicit finer-grid configs may use half-tile coordinates
 * for reference-cell centres; their simulation positions remain integer sub-units.
 */

/** Sub-tile units per tile: positions are integers in these units. */
export const SUB = 1000;

/**
 * The one rules generation every config plays, written in each log header (older
 * generations were removed). Bump it when a rule changes so a log of other rules is refused.
 */
export const RULES_VERSION = 27;

/** The rules-generation markers every config carries, with their one value each (SimConfig.rules25 and on). */
export const RULES_MARKERS = {
  rules25: true, rules26: true, rules27: true, queenBrood: true, colonyMirror: true, forageTieBreak: "mirrored", groundIncomeRevision: 1,
} as const;

/** The soldier caste's numbers; workers are today's ant. */
export interface CasteRules {
  readonly soldierCost: number;
  /** Soldier HP as a permille of antHp. */
  readonly soldierHpPermille: number;
  /** Soldier damage as a permille of a worker's. */
  readonly soldierDamagePermille: number;
}

/** Stored in match configs; absent preserves historical hatch timing. */
export interface HatchTimingRules {
  readonly soldierIntervalMultiplier: number;
}

export const SOLDIER_HATCH_TIMING: HatchTimingRules = { soldierIntervalMultiplier: 2 };

/** Queen founding changes no food, hatch or match-length tuning. */
export interface QueenRules {
  readonly cost: number;
  readonly cooldownTicks: number;
  /** Euclidean tile distance. Historical configs also blocked lost nests. */
  readonly minDistanceTiles: number;
  readonly costMultiplier?: number;
  /** Stored in the match header so historical pricing remains replayable. */
  readonly costBasis?: "historical" | "live" | "founded-live";
  readonly maxLiveQueens?: number;
  readonly firstFoundTick?: number;
  readonly houseReserveFood?: number;
  readonly standingNestsOnly?: boolean;
  /** Absent preserves historical division of one colony-wide guard budget. */
  readonly guardsPerQueen?: boolean;
  /** Hard ceiling on total house guards; absent preserves recorded uncapped rules. */
  readonly totalGuardSharePermille?: number;
}

export const QUEEN_RULES: QueenRules = {
  cost: 400, costMultiplier: 2, costBasis: "founded-live",
  firstFoundTick: 3000, cooldownTicks: 1800, minDistanceTiles: 16,
  houseReserveFood: 200, standingNestsOnly: true,
  guardsPerQueen: true, totalGuardSharePermille: 600,
};

export interface FoodPatch {
  /** Centre tile on the left half; the map mirrors it to the right half. */
  readonly tileX: number;
  readonly tileY: number;
  /** Radius in tiles (Euclidean). */
  readonly radius: number;
  /** Food per tile at match start and the regrowth ceiling. */
  readonly perTile: number;
}

/** Half-open tile rectangle: x <= tileX < x + width, likewise y. */
export interface WaterRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** A map's own board. Every value is in reference tiles (grid scale 1); a match
 * multiplies them by its grid scale. Supported sizes: src/sim/mapBoard.ts. */
export interface MapBoard {
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  /** Colony 0's default nest; colony 1's is its mirror. */
  readonly nestTileX: number;
  readonly nestTileY: number;
  /** Left-half food templates, mirrored like the config's. One list serves every rules config. */
  readonly foodPatches: readonly FoodPatch[];
}
export interface MapDefinition {
  readonly id: string;
  readonly name: string;
  /** With a board, rectangles are in that board's reference tiles. */
  readonly water: readonly WaterRect[];
  /** Absent: the config's size, nest and food, as every recorded map plays. */
  readonly board?: MapBoard;
  /** The one grid scale this map plays at; absent on every recorded map. */
  readonly gridScale?: GridScale;
  /** Living ants per colony on this map; absent: the config's colonyCap. */
  readonly colonyCap?: number;
  /** This map's match length in ticks; absent: the config's matchTicks. */
  readonly matchTicks?: number;
}
export interface RockRules {
  readonly minPairs: number;
  readonly maxPairs: number;
  readonly minClusterTiles: number;
  readonly maxClusterTiles: number;
  readonly nestClearanceTiles: number;
  readonly placementAttempts: number;
}
export const ROCK_RULES: RockRules = {
  minPairs: 6, maxPairs: 8, minClusterTiles: 1, maxClusterTiles: 3,
  nestClearanceTiles: 3, placementAttempts: 128,
};
export interface TerrainRules {
  /** Absent preserves historical water-only maps and replay hashes. */
  readonly rocks?: RockRules;
  readonly maps: readonly MapDefinition[];
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  /** Explicit fixture/sweep selection; normal matches select from the seed. */
  readonly mapId?: string;
}
export const MAPS: readonly MapDefinition[] = [
  { id: "open-field", name: "Open Field", water: [] },
  { id: "three-crossings", name: "Three Crossings", water: [
    { x: 30, y: 0, width: 4, height: 8 },
    { x: 30, y: 12, width: 4, height: 10 },
    { x: 30, y: 26, width: 4, height: 10 },
    { x: 30, y: 40, width: 4, height: 8 },
  ] },
  { id: "central-lake", name: "Central Lake", water: [
    { x: 27, y: 15, width: 10, height: 18 },
    // Shore pools leave three-tile flanking pinch points on rows 12–14 and 33–35.
    { x: 27, y: 0, width: 10, height: 12 },
    { x: 27, y: 36, width: 10, height: 12 },
  ] },
];
export const TERRAIN_RULES: TerrainRules = { maps: MAPS, referenceWidth: 64, referenceHeight: 48, rocks: ROCK_RULES };

/** Explicit new-match opt-in, applied after physical-grid conversion. Store the
 * resulting native rectangles in the config; never regenerate saved geometry. */
export function withDistinctMaps(config: SimConfig): SimConfig {
  const scale = gridScaleOf(config);
  if (config.mapWidth !== 64 * scale || config.mapHeight !== 48 * scale) {
    throw new Error("distinct maps require dimensions matching the explicit scale");
  }
  if (config.terrain === undefined) throw new Error("distinct maps require terrain rules");
  return { ...config, terrain: { ...config.terrain, maps: newMatchMaps(),
    referenceWidth: config.mapWidth, referenceHeight: config.mapHeight } };
}

/** A house-mode lobby's draw config: the same config without HOUSE_PAUSED_MAP_IDS in
 * terrain.maps. Unchanged when there is no terrain, no paused map, or nothing would remain. */
export function withoutHousePausedMaps(config: SimConfig): SimConfig {
  const terrain = config.terrain;
  if (terrain === undefined) return config;
  const maps = terrain.maps.filter(map => !HOUSE_PAUSED_MAP_IDS.includes(map.id));
  if (maps.length === terrain.maps.length || maps.length === 0) return config;
  return { ...config, terrain: { ...terrain, maps } };
}

/** Seeded placement bounds, saved in each log; foodPatches holds resolved centres. */
export interface FoodLayoutRules {
  readonly patches: readonly FoodPatch[];
  readonly positionJitterTiles: number;
  readonly radiusJitterTiles: number;
  readonly richnessJitter: number;
  /** Euclidean clearance from the patch edge to either nest tile centre. */
  readonly nestClearanceTiles: number;
  /** Euclidean clearance between patch edges, including their mirrors. */
  readonly patchClearanceTiles: number;
  readonly minStartingFood: number;
  readonly maxStartingFood: number;
  readonly placementAttempts: number;
  readonly layoutAttempts: number;
  /** New-economy frontline templates may be omitted only as whole mirrored pairs. */
  readonly optionalPatchIndices?: readonly number[];
}

/** A sustained territorial advantage, not an elimination or time-up. */
export interface EarlyWinRules {
  readonly minTick: number;
  readonly holdTicks: number;
  readonly territoryRatioPermille: number;
  readonly minHeldTiles: number;
}

/** Finalized lobby starting nest in the shipped tile coordinates, stored for replay. */
export interface InitialQueen { readonly tileX: number; readonly tileY: number }

export interface PointArrivalRules {
  readonly variant: "organic-cluster";
  readonly pitch: number;
  readonly jitter: number;
  readonly minimumSpacing: number;
}
export const POINT_ARRIVAL_RULES: PointArrivalRules = {
  variant: "organic-cluster", pitch: 800, jitter: 70, minimumSpacing: 600,
};
export interface SimConfig {
  /**
   * The rules-generation markers every config carries (RULES_VERSION 27). They have one value each, are
   * written in every log header and save, and a header without them is refused (parseLog).
   */
  readonly rules25: true;
  readonly rules26: true;
  readonly rules27: true;
  readonly queenBrood: true;
  readonly colonyMirror: true;
  readonly forageTieBreak: "mirrored";
  /** New-match scoring; absence preserves recorded territory-first adjudication. */
  readonly adjudication?: "kills-first";
  /** Fine terrain tiles per original tile edge. Every playable config carries 2; only a rules
   * template (the input to withGridScale) omits it. */
  readonly gridScale?: GridScale;
  /** New-match nest-pick geometry; absence preserves historical 12x24 boxes. */
  readonly startArea?: "back-quarter";
  /** Lobby-only finalized layout. Absence preserves historical/local one-nest starts. */
  readonly initialQueens?: readonly [readonly InitialQueen[], readonly InitialQueen[]];
  /** Absent in recorded matches: preserve historical movement and state shape. */
  readonly pointArrival?: PointArrivalRules;
  /** Rules 25: a forager walks on until its food cell is within reach; absent keeps the recorded soft arrival stop. */
  readonly forageReachArrival?: true;
  readonly softSeparation?: { /** Absent on stored matches: all pairs use radius. */ readonly soldierRadius?: number;
    /** Absent on stored matches. A local guard settled at its queen feels only radius, and so do same-colony workers meeting it. */ readonly guardSettle?: true;
    /** Absent on stored matches. A worker meeting its own colony's point-resting soldier feels only radius. */ readonly restPass?: true; readonly radius: number; readonly strength: number; readonly maxStep: number; readonly arrivalSubunits: number; readonly epsilon: number; readonly arrivalLinkRadius: number };
  /** Explicit live control revision; absent preserves historical header versions. */
  readonly controlRevision?: 1;
  /** New-match command surface; absent preserves recorded word marks and trail orders. */
  readonly wordMarksDisabled?: true;
  readonly ticksPerSecond: number;
  /** 30 minutes of 10 Hz ticks in the default match. */
  readonly matchTicks: number;

  // Map
  /** Absent preserves historical state, PRNG draws, movement and replay. */
  readonly terrain?: TerrainRules;
  readonly mapWidth: number;
  readonly mapHeight: number;
  /** Set only on a config derived for a map with its own board: the size, in the same
   * tiles as mapWidth/mapHeight, that the rotation's maps without a board play at. */
  readonly rotationSize?: { readonly width: number; readonly height: number };
  /** Colony 0's nest centre in tile-centre coordinates (may be half-integral on a finer grid);
   * colony 1's nest is its mirror (x -> width - 1 - x). */
  readonly nestTileX: number;
  readonly nestTileY: number;
  /** An ant within this many tiles (Chebyshev) of its nest delivers food. */
  readonly nestDeliverTiles: number;
  readonly foodPatches: readonly FoodPatch[];
  /** Absent preserves fixed patch geometry, RNG consumption and historical hashes. */
  readonly foodLayout?: FoodLayoutRules;
  /** Each food tile below its ceiling regrows 1 food this often. */
  readonly foodRegrowTicks: number;
  /**
   * Frozen RULES_VERSION 27 generation marker: the layout's optional patches may be left out. Its name and value are
   * written in every log header, private input and public match record, so both stay fixed; only parseLog's generic
   * marker check reads it, and nothing in the simulation does.
   */
  readonly groundIncomeRevision: 1;
  /** Absent preserves historical matches and replay state. */
  readonly earlyWin?: EarlyWinRules;
  /** Per-tile jitter applied to patch food from the seeded PRNG (mirrored). */
  readonly foodJitter: number;

  // Ants
  readonly antSpeedTilesPerSecond: number;
  readonly startAnts: number;
  /** Tuning map only: start ants fill each colony's start-area land tiles nearest its nest first,
   * one ant per tile, so up to 10,000 per side start on the tuning board. Absent: the historical 5 x 7 block
   * and rows, as every recorded match starts. */
  readonly startAntLayout?: "fill-start-area";
  readonly colonyCap: number;
  readonly hatchCost: number;
  readonly hatchIntervalTicks: number;
  /** Each soldier takes this many base hatch intervals at its queen. */
  readonly hatchTiming?: HatchTimingRules;
  readonly corpseFood: number;
  readonly sightTiles: number;
  readonly smellTiles: number;

  // Combat: HP and damage in milli-HP
  readonly antHp: number;
  readonly damagePerSecond: number;
  readonly defenderBonusPermille: number;
  readonly combatGraceTicks: number;

  // Queen overrun
  readonly overrunRadiusTiles: number;
  readonly overrunTicks: number;
  readonly overrunGraceTicks: number;

  // Territory
  readonly territoryDecayTicks: number;

  // Marks and steering
  readonly markStrengthPermille: number;
  readonly markReachTiles: number;
  readonly markLifetimeTicks: number;
  /** Explicit limits are retained for historical log headers; absent means no mark-slot ceiling. */
  readonly marksPerAgent?: number;
  readonly markMaxWords: number;

  // Agents and squad supply
  readonly squadSize: number;
  readonly squadSupplyPermille: number;
  readonly squadTimerTicks: number;
  /** Accepted-command seat timeout; absent preserves historical call-based squad expiry. */
  readonly commandIdleTicks?: number;
  readonly commandFloorTicks: number;
  readonly intentMaxChars: number;
  /** Attack order: within this many tiles of the target a squad ant engages enemies within it of the target. */
  readonly attackRadiusTiles: number;

  // House bot
  readonly guardCount: number;
  /** Colony-wide guard share; absent preserves the legacy fixed-count budget. */
  readonly guardSharePermille?: number;
  /** Guards engage enemies this close (tiles) to their queen. */
  readonly guardEngageTiles: number;
  /** Share of non-squad, non-guard ants that fight, rising over the match. */
  readonly fighterShareStartPermille: number;
  readonly fighterShareEndPermille: number;
  /** Rally line position along nest-to-enemy-nest, rising over the match. */
  readonly rallyStartPermille: number;
  readonly rallyEndPermille: number;
  /** A fighter pushes when own * 1000 >= enemy * this, counted within sight. */
  readonly pushRatioPermille: number;

  /**
   * The caste switch. Present: the soldier caste and the brood
   * choice; absent: workers only.
   */
  readonly castes?: CasteRules;
  /** Absent in historical rules: preserves old logs and deterministic goldens. */
  readonly queenFounding?: QueenRules;
  /**
   * Private comparison: the ANTWAR_RULES value the server
   * started with. Absent when ANTWAR_RULES is unset, so today's public config and
   * logs are unchanged; "v4" marks an explicit comparison run of today's rules.
   */
  readonly rules?: RulesName;
  /** Players the comparison join barrier waits for (ANTWAR_PLAYERS); set only with rules. */
  readonly players?: 2 | 4;
  /** Count marks; present in count-marks and redesign only. */
  readonly countMarks?: CountMarkRules;
  /** Opt-in patrol count marks; Euclidean linking distance in this config's tiles. */
  readonly patrolLinkTiles?: number;
  /** Local ant rules for seated sides; redesign only. */
  readonly localAnts?: LocalAntRules;
  /** Queens with HP instead of the overrun timer; redesign only. */
  readonly queenHp?: QueenHpRules;
}

/** ANTWAR_RULES values. */
export const RULES_NAMES = ["v4", "count-marks", "redesign"] as const;
export type RulesName = (typeof RULES_NAMES)[number];

/** Count-mark numbers. Experimental defaults. */
export interface CountMarkRules {
  /** Count-mark combat accounting only; absent preserves recorded state and MCP contracts. */
  readonly combatTotals?: true;
  /** New contract marker; absent preserves recorded tool, event and rules identities. */
  readonly casteSelection?: true;
  /** Live DEFEND walks to the mark and holds; absent preserves recorded pursuit. */
  readonly defendHolds?: boolean;
  /** A group below its count recruits free ants this close (tiles) to a member, or to the mark when empty. */
  readonly recruitTiles: number;
  /** Opt-in so old count-mark log headers retain their reach and placement. */
  readonly recruitColonyWide?: boolean;
  readonly placement?: "colony_sight";
  /** Report currently free ants in each accepted count-mark response. */
  readonly reportClaimAvailability?: boolean;
  /** DEFEND holds and fights within this many tiles of the mark. */
  readonly defendTiles: number;
}

/** Local ant rules. */
export interface LocalAntRules {
  /** Free ants this close to their own queen defend her from enemies this close to her. */
  readonly defendTiles: number;
  /** Share sent to the front; the rest remain queen defenders. */
  readonly soldierFrontSharePermille?: number;
  /** Absent retains historical per-ID sampling; live_share maintains the share among surviving free soldiers. */
  readonly soldierAllocation?: "live_share";
  /** Share of those front soldiers assigned to food patches instead of the rally line. */
  readonly soldierPatchSharePermille?: number;
  /** False keeps patch details on their home-side flank; absent preserves historical advance to the mirrored patch. */
  readonly soldierPatchAdvance?: boolean;
  /** When no remembered food is available, free workers scout home-side patches instead of waiting at the queen. */
  readonly workerIdlePatchPatrol?: boolean;
  /** Extra home workers only when no free soldier is assigned to queen defence; always leave a worker available to forage. */
  readonly workerHomeGuardCount?: number;
  /** A standing worker guard also targets this share of free workers, including carriers in the denominator. */
  readonly workerHomeGuardSharePermille?: number;
  /** Keep the standing worker guard on the queen rather than dispatching it or chasing distant intruders. */
  readonly workerHomeGuardHold?: boolean;
  /** Rules 25, absent on stored matches: a held worker guard arrives within the soft arrival radius of its queen,
   * or within the arrival link radius of an arrived worker guard of the same queen, and then stands still. */
  readonly workerGuardSettle?: true;
  /** Free-forager share that keeps a home-side patch assignment even when closer remembered food is available. */
  readonly workerPatchDispatchSharePermille?: number;
  /** Enemy-soldier distance from a live queen that activates the worker defence recall. */
  readonly workerQueenThreatTiles?: number;
  /** Maximum free, non-carrying dispatched/idle workers recalled per colony, including its worker home guard. */
  readonly workerQueenRecallCount?: number;
  /**
   * No bot moves for a player. Present on every new match: every colony's free ants follow these local rules from
   * the first tick, whether or not its seat has joined or is active, and the house never founds a queen. Absent on
   * matches recorded before it, which keep their recorded house planning and founding for a colony with no active seat.
   */
  readonly everyColony?: true;
}

/** Queen HP numbers, in milli-HP and ticks. */
export interface QueenHpRules {
  readonly hp: number;
  readonly biteDamage: number;
  readonly biteIntervalTicks: number;
  readonly regenHp: number;
  readonly regenIntervalTicks: number;
  /** She regains HP only while no enemy is within this many tiles. */
  readonly regenClearTiles: number;
  /** She takes no damage before this tick. */
  readonly shieldTicks: number;
}

/**
 * The largest count a count mark may request. A count claims only free living ants of one colony, which never
 * exceed its ant cap: 512, 768 or 1,024 on the selectable maps and at most 10,000 on the tuning map
 * (TUNING_MAP_MAX_ANTS_PER_SIDE), so no count that could ever be filled is refused. A fixed number, so agents
 * read it before the map is drawn. A larger count is refused, never clamped.
 */
export const COUNT_MARK_MAX_COUNT = 10_000;
/** COUNT_MARK_MAX_COUNT as agents read it: "10,000". */
export const COUNT_MARK_MAX_COUNT_TEXT = COUNT_MARK_MAX_COUNT.toLocaleString("en-US");

export const COUNT_MARK_RULES: CountMarkRules = { recruitTiles: 8, defendTiles: 3, defendHolds: true, casteSelection: true, combatTotals: true };
export const LOCAL_ANT_RULES: LocalAntRules = { defendTiles: 3 };
export const BALANCED_LOCAL_ANT_RULES: LocalAntRules = {
  ...LOCAL_ANT_RULES, soldierFrontSharePermille: 500, soldierPatchSharePermille: 900, soldierAllocation: "live_share", soldierPatchAdvance: false, workerIdlePatchPatrol: true, workerHomeGuardCount: 32, workerHomeGuardSharePermille: 250, workerHomeGuardHold: true, workerPatchDispatchSharePermille: 400, workerQueenThreatTiles: 12, workerQueenRecallCount: 32,
};
export const EARLY_WIN_RULES: EarlyWinRules = {
  minTick: 10 * 60 * 10, holdTicks: 5 * 60 * 10, territoryRatioPermille: 6000, minHeldTiles: 100,
};
export const QUEEN_HP_RULES: QueenHpRules = {
  hp: 40_000,
  biteDamage: 4_000,
  biteIntervalTicks: 20,
  regenHp: 1_000,
  regenIntervalTicks: 100,
  regenClearTiles: 3,
  shieldTicks: 3000,
};

export const DEFAULT_CONFIG: SimConfig = {
  rules25: true,
  rules26: true,
  rules27: true,
  queenBrood: true,
  colonyMirror: true,
  forageTieBreak: "mirrored",
  ticksPerSecond: 10,
  matchTicks: 30 * 60 * 10,

  mapWidth: 64,
  mapHeight: 48,
  nestTileX: 8,
  nestTileY: 24,
  nestDeliverTiles: 1,
  foodPatches: [
    { tileX: 12, tileY: 24, radius: 2, perTile: 2 },
    { tileX: 18, tileY: 9, radius: 2, perTile: 3 },
    { tileX: 18, tileY: 39, radius: 2, perTile: 3 },
    { tileX: 30, tileY: 24, radius: 3, perTile: 8 },
  ],
  foodRegrowTicks: 150,
  groundIncomeRevision: 1,
  foodJitter: 1,

  antSpeedTilesPerSecond: 2,
  startAnts: 30,
  colonyCap: 512,
  hatchCost: 3,
  hatchIntervalTicks: 10,
  corpseFood: 1,
  sightTiles: 6,
  smellTiles: 8,

  antHp: 4000,
  damagePerSecond: 1000,
  defenderBonusPermille: 1250,
  combatGraceTicks: 600,

  overrunRadiusTiles: 2,
  overrunTicks: 60 * 10,
  // Match-global grace: founded queens use the same match-start clock.
  overrunGraceTicks: 12 * 60 * 10,

  territoryDecayTicks: 200,

  markStrengthPermille: 700,
  markReachTiles: 10,
  markLifetimeTicks: 1800,
  marksPerAgent: 3,
  markMaxWords: 3,

  squadSize: 6,
  squadSupplyPermille: 500,
  squadTimerTicks: 900,
  commandFloorTicks: 100,
  intentMaxChars: 80,
  attackRadiusTiles: 3,

  guardCount: 2,
  guardEngageTiles: 6,
  fighterShareStartPermille: 600,
  fighterShareEndPermille: 900,
  rallyStartPermille: 300,
  rallyEndPermille: 1000,
  pushRatioPermille: 600,
};

export const CASTE_RULES: CasteRules = {
  soldierCost: 6,
  soldierHpPermille: 2000,
  soldierDamagePermille: 1500,
};

/** The default config with the caste switch on. */
export const RULES_V4_CONFIG: SimConfig = { ...DEFAULT_CONFIG, castes: CASTE_RULES };

/**
 * The rules a public server's matches run (the Game's default). Switching the
 * public game to the caste switch is this one line: RULES_V4_CONFIG.
 */
/** Bounds retain the historical possible food range, including per-tile jitter. */
function foodLayoutRules(patches: readonly FoodPatch[], minStartingFood: number, maxStartingFood: number): FoodLayoutRules {
  return { patches, positionJitterTiles: 2, radiusJitterTiles: 1, richnessJitter: 1,
    nestClearanceTiles: 2, patchClearanceTiles: 1, minStartingFood, maxStartingFood,
    placementAttempts: 128, layoutAttempts: 1024, optionalPatchIndices: [4, 5] };
}

const REDESIGN_FOOD_PATCHES: readonly FoodPatch[] = DEFAULT_CONFIG.foodPatches.map((patch) => patch.tileY !== DEFAULT_CONFIG.nestTileY
  ? { ...patch, perTile: 6 }
  : patch.tileX > DEFAULT_CONFIG.mapWidth / 3 ? { ...patch, radius: 1, perTile: 1 }
    : { ...patch, tileX: 10, tileY: 10, radius: 5 });

/** Left-half templates: the existing layout mirrors these to four frontline circles. */
const FRONTLINE_FOOD_PATCHES: readonly FoodPatch[] = [
  { tileX: 28, tileY: 10, radius: 1, perTile: 1 },
  { tileX: 28, tileY: 38, radius: 1, perTile: 1 },
];
const PUBLIC_FOOD_PATCHES = [...DEFAULT_CONFIG.foodPatches, ...FRONTLINE_FOOD_PATCHES];
// Append after the historical richness transform so frontline food stays at one.
const LIVE_REDESIGN_FOOD_PATCHES = [...REDESIGN_FOOD_PATCHES, ...FRONTLINE_FOOD_PATCHES];

const { marksPerAgent: _historicalMarkSlots, ...UNCAPPED_PUBLIC_BASE } = RULES_V4_CONFIG;
export const PUBLIC_CONFIG: SimConfig = { ...UNCAPPED_PUBLIC_BASE, adjudication: "kills-first", controlRevision: 1, guardSharePermille: 400, queenFounding: QUEEN_RULES,
  terrain: TERRAIN_RULES, foodPatches: PUBLIC_FOOD_PATCHES, foodLayout: foodLayoutRules(PUBLIC_FOOD_PATCHES, 452, 1026) };

/**
 * The config an ANTWAR_RULES value plays. Unset is today's public
 * config, unchanged; v4 is the same rules marked as an explicit comparison run;
 * any other value throws, so the server refuses to start.
 */
export function rulesConfig(value: string | undefined): SimConfig {
  switch (value) {
    case undefined:
      return PUBLIC_CONFIG;
    case "v4":
      return { ...PUBLIC_CONFIG, rules: "v4" };
    case "count-marks":
      return { ...PUBLIC_CONFIG, rules: "count-marks", countMarks: COUNT_MARK_RULES };
    case "redesign":
      return { ...PUBLIC_CONFIG, rules: "redesign", wordMarksDisabled: true, pointArrival: POINT_ARRIVAL_RULES, forageReachArrival: true, softSeparation: { soldierRadius: 800, guardSettle: true, restPass: true, radius: 100, strength: 1600, maxStep: 200, arrivalSubunits: 300, epsilon: 1, arrivalLinkRadius: 150 }, hatchTiming: SOLDIER_HATCH_TIMING,
        // The near-home patch is visible to the opening block's northern ants at the sight boundary.
        // Its nearest edge is row 15, so collecting food takes workers outside the lane, not just to row 19.
        foodPatches: LIVE_REDESIGN_FOOD_PATCHES,
        foodLayout: foodLayoutRules(LIVE_REDESIGN_FOOD_PATCHES, 452, 1026),
        countMarks: { ...COUNT_MARK_RULES, recruitColonyWide: true, placement: "colony_sight", reportClaimAvailability: true },
        patrolLinkTiles: 6,
        localAnts: { ...BALANCED_LOCAL_ANT_RULES, workerGuardSettle: true }, queenHp: QUEEN_HP_RULES,
        earlyWin: EARLY_WIN_RULES, commandIdleTicks: 180 * PUBLIC_CONFIG.ticksPerSecond };
    default:
      throw new Error(`ANTWAR_RULES must be unset or one of ${RULES_NAMES.join(", ")}; got ${JSON.stringify(value)}`);
  }
}

/** Final colony names. Index = colony id. */
export const COLONY_NAMES = ["Very Large Colony", "Lake Hodges Colony"] as const;

/**
 * Death-counter copy.
 * The measured figure carries its source; '30M a year' appears only as the post's claim.
 */
export const DEATH_COUNTER_COPY = {
  measured:
    "At least 15 million ants died in six months on one border (Lake Hodges, April to September 2004; Thomas et al. 2006, Molecular Ecology).",
  postClaim: "The viral post claims \"30M a year\"; that figure is the post's, not the study's.",
} as const;

/** Per-tick ant speed in sub-tile units. */
export function speedPerTick(config: SimConfig): number {
  return Math.trunc((config.antSpeedTilesPerSecond * SUB) / config.ticksPerSecond);
}

/** Per-tick damage in milli-HP before any bonus. */
export function damagePerTick(config: SimConfig): number {
  return Math.trunc(config.damagePerSecond / config.ticksPerSecond);
}
