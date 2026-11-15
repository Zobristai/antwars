import type { SimConfig } from "../src/sim/config.ts";

/**
 * The redesign rules as rules-27 matches carry them: a literal copy of rulesConfig("redesign") taken before the
 * rules-28 unit numbers, independent of today's config. Tests whose subject is not the unit numbers or the hatch
 * clock pin this config, so a later change to the live numbers leaves them as they are; test/rules27.test.ts
 * checks it against the configs that committed rules-27 recordings carry in their headers, not the live config.
 */
const RULES27_REDESIGN: SimConfig = {
  rules25: true,
  rules26: true,
  rules27: true,
  queenBrood: true,
  colonyMirror: true,
  forageTieBreak: "mirrored",
  ticksPerSecond: 10,
  matchTicks: 18000,
  mapWidth: 64,
  mapHeight: 48,
  nestTileX: 8,
  nestTileY: 24,
  nestDeliverTiles: 1,
  foodPatches: [
    {
      tileX: 10,
      tileY: 10,
      radius: 5,
      perTile: 2
    },
    {
      tileX: 18,
      tileY: 9,
      radius: 2,
      perTile: 6
    },
    {
      tileX: 18,
      tileY: 39,
      radius: 2,
      perTile: 6
    },
    {
      tileX: 30,
      tileY: 24,
      radius: 1,
      perTile: 1
    },
    {
      tileX: 28,
      tileY: 10,
      radius: 1,
      perTile: 1
    },
    {
      tileX: 28,
      tileY: 38,
      radius: 1,
      perTile: 1
    }
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
  overrunTicks: 600,
  overrunGraceTicks: 7200,
  territoryDecayTicks: 200,
  markStrengthPermille: 700,
  markReachTiles: 10,
  markLifetimeTicks: 1800,
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
  castes: {
    soldierCost: 6,
    soldierHpPermille: 2000,
    soldierDamagePermille: 1500
  },
  adjudication: "kills-first",
  controlRevision: 1,
  guardSharePermille: 400,
  queenFounding: {
    cost: 400,
    costMultiplier: 2,
    costBasis: "founded-live",
    firstFoundTick: 3000,
    cooldownTicks: 1800,
    minDistanceTiles: 16,
    houseReserveFood: 200,
    standingNestsOnly: true,
    guardsPerQueen: true,
    totalGuardSharePermille: 600
  },
  terrain: {
    maps: [
      {
        id: "open-field",
        name: "Open Field",
        water: []
      },
      {
        id: "three-crossings",
        name: "Three Crossings",
        water: [
          {
            x: 30,
            y: 0,
            width: 4,
            height: 8
          },
          {
            x: 30,
            y: 12,
            width: 4,
            height: 10
          },
          {
            x: 30,
            y: 26,
            width: 4,
            height: 10
          },
          {
            x: 30,
            y: 40,
            width: 4,
            height: 8
          }
        ]
      },
      {
        id: "central-lake",
        name: "Central Lake",
        water: [
          {
            x: 27,
            y: 15,
            width: 10,
            height: 18
          },
          {
            x: 27,
            y: 0,
            width: 10,
            height: 12
          },
          {
            x: 27,
            y: 36,
            width: 10,
            height: 12
          }
        ]
      }
    ],
    referenceWidth: 64,
    referenceHeight: 48,
    rocks: {
      minPairs: 6,
      maxPairs: 8,
      minClusterTiles: 1,
      maxClusterTiles: 3,
      nestClearanceTiles: 3,
      placementAttempts: 128
    }
  },
  foodLayout: {
    patches: [
      {
        tileX: 10,
        tileY: 10,
        radius: 5,
        perTile: 2
      },
      {
        tileX: 18,
        tileY: 9,
        radius: 2,
        perTile: 6
      },
      {
        tileX: 18,
        tileY: 39,
        radius: 2,
        perTile: 6
      },
      {
        tileX: 30,
        tileY: 24,
        radius: 1,
        perTile: 1
      },
      {
        tileX: 28,
        tileY: 10,
        radius: 1,
        perTile: 1
      },
      {
        tileX: 28,
        tileY: 38,
        radius: 1,
        perTile: 1
      }
    ],
    positionJitterTiles: 2,
    radiusJitterTiles: 1,
    richnessJitter: 1,
    nestClearanceTiles: 2,
    patchClearanceTiles: 1,
    minStartingFood: 452,
    maxStartingFood: 1026,
    placementAttempts: 128,
    layoutAttempts: 1024,
    optionalPatchIndices: [
      4,
      5
    ]
  },
  rules: "redesign",
  wordMarksDisabled: true,
  pointArrival: {
    variant: "organic-cluster",
    pitch: 800,
    jitter: 70,
    minimumSpacing: 600
  },
  forageReachArrival: true,
  softSeparation: {
    soldierRadius: 800,
    guardSettle: true,
    restPass: true,
    radius: 100,
    strength: 1600,
    maxStep: 200,
    arrivalSubunits: 300,
    epsilon: 1,
    arrivalLinkRadius: 150
  },
  hatchTiming: {
    soldierIntervalMultiplier: 2
  },
  countMarks: {
    recruitTiles: 8,
    defendTiles: 3,
    defendHolds: true,
    casteSelection: true,
    combatTotals: true,
    recruitColonyWide: true,
    placement: "colony_sight",
    reportClaimAvailability: true
  },
  patrolLinkTiles: 6,
  localAnts: {
    defendTiles: 3,
    soldierFrontSharePermille: 500,
    soldierPatchSharePermille: 900,
    soldierAllocation: "live_share",
    soldierPatchAdvance: false,
    workerIdlePatchPatrol: true,
    workerHomeGuardCount: 32,
    workerHomeGuardSharePermille: 250,
    workerHomeGuardHold: true,
    workerPatchDispatchSharePermille: 400,
    workerQueenThreatTiles: 12,
    workerQueenRecallCount: 32,
    workerGuardSettle: true,
    everyColony: true
  },
  queenHp: {
    hp: 40000,
    biteDamage: 4000,
    biteIntervalTicks: 20,
    regenHp: 1000,
    regenIntervalTicks: 100,
    regenClearTiles: 3,
    shieldTicks: 3000
  },
  earlyWin: {
    minTick: 6000,
    holdTicks: 3000,
    territoryRatioPermille: 6000,
    minHeldTiles: 100
  },
  commandIdleTicks: 1800
};

/** A fresh copy of the rules-27 redesign config, so a test may spread or change it freely. */
export function rules27Redesign(): SimConfig {
  return structuredClone(RULES27_REDESIGN);
}
