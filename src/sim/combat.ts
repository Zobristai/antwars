import { damagePerTick, SUB } from "./config.js";
import { withinTiles } from "./geometry.js";
import { gridScaleOf } from "./gridScale.js";
import { activeQueens, clearLostQueenSpawn, forEachNear, gridBuckets, noEnemyNear, tileIndex, type Grid } from "./map.js";
import type { Ant, Mark, QueenState, SimEvent, SimState } from "./types.js";

/** Telemetry only: null is a queen, which wins equal-damage ties against ants. */
interface DamageSource {
  readonly damage: number;
  readonly ant: Ant | null;
}

function recordSource(sources: Map<number, DamageSource>, targetId: number, damage: number, ant: Ant | null): void {
  const previous = sources.get(targetId);
  if (previous === undefined || damage > previous.damage || (damage === previous.damage &&
    (ant === null || (previous.ant !== null && ant.id < previous.ant.id)))) {
    sources.set(targetId, { damage, ant });
  }
}

function claimedMark(marks: ReadonlyMap<number, Mark>, ant: Ant): Mark | undefined {
  const mark = ant.squad === null && ant.claim !== undefined ? marks.get(ant.claim) : undefined;
  return mark?.colony === ant.colony ? mark : undefined;
}

/** The adjacent enemy this ant hits: lowest HP, then lowest id. */
function pickTarget(state: SimState, grid: Grid, ant: Ant): Ant | null {
  if (noEnemyNear(state, grid, ant.colony, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), gridScaleOf(state.config))) return null;
  const dense = gridBuckets(grid);
  if (dense !== undefined) {
    // The same tiles as forEachNear; the lowest (HP, id) does not depend on the order they are read in.
    const { mapWidth, mapHeight } = state.config, r = gridScaleOf(state.config);
    const tx = Math.floor(ant.x / SUB), ty = Math.floor(ant.y / SUB);
    const x0 = Math.max(0, tx - r), x1 = Math.min(mapWidth - 1, tx + r), y1 = Math.min(mapHeight - 1, ty + r);
    let best: Ant | null = null;
    for (let y = Math.max(0, ty - r); y <= y1; y += 1) {
      const row = y * mapWidth;
      for (let x = x0; x <= x1; x += 1) {
        const bucket = dense[row + x];
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const other = bucket[i]!;
          if (other.colony === ant.colony) continue;
          if (best === null || other.hp < best.hp || (other.hp === best.hp && other.id < best.id)) best = other;
        }
      }
    }
    return best;
  }
  let target: Ant | null = null;
  forEachNear(state, grid, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), gridScaleOf(state.config), (other) => {
    if (other.colony === ant.colony) return;
    if (target === null || other.hp < target.hp || (other.hp === target.hp && other.id < target.id)) {
      target = other;
    }
  });
  return target;
}

/**
 * Attrition combat. After the grace period every ant deals one tick of
 * damage to one adjacent enemy, x bonus on its own colony's territory. All damage
 * lands together, then the dead are removed and each leaves corpse food.
 */
export function resolveCombat(state: SimState, grid: Grid, tick: number, events: SimEvent[]): void {
  const { config } = state;
  if (tick < config.combatGraceTicks) {
    for (const ant of state.ants) ant.lastTargetId = -1;
    return;
  }
  const worker = damagePerTick(config);
  // A soldier hits harder; the defender bonus applies on top.
  const soldier = config.castes === undefined ? worker : Math.trunc((worker * config.castes.soldierDamagePermille) / 1000);
  const bonusOf = (hit: number): number => Math.trunc((hit * config.defenderBonusPermille) / 1000);
  const workerBonus = bonusOf(worker);
  const soldierBonus = bonusOf(soldier);
  const damage = new Map<number, number>();
  const queenDamage = new Map<QueenState, number>();
  // Do not track damage sources in historical rules or when there is no live count mark.
  const marks = config.countMarks?.combatTotals ? new Map(state.marks
    .filter(mark => mark.verb !== undefined && mark.count !== undefined && mark.laidTick <= tick && tick - mark.laidTick < config.markLifetimeTicks)
    .map(mark => [mark.id, mark])) : undefined;
  const sources = marks !== undefined && marks.size > 0 ? new Map<number, DamageSource>() : undefined;
  // Ants of one colony on one tile have the same adjacent enemies, and no HP changes until all have chosen.
  // The key leaves room for four colonies per tile.
  const targets = new Map<number, Ant | null>(), width = config.mapWidth;
  for (const ant of state.ants) {
    // Rules 25 carriers deliver instead of biting, even under a squad or mark.
    if (ant.carrying) {
      ant.lastTargetId = -1;
      continue;
    }
    const key = (Math.floor(ant.y / SUB) * width + Math.floor(ant.x / SUB)) * 4 + ant.colony;
    let target = targets.get(key);
    if (target === undefined) { target = pickTarget(state, grid, ant); targets.set(key, target); }
    if (target === null) {
      ant.lastTargetId = -1;
      // With no enemy ant in reach, an ant bites an adjacent enemy queen,
      // at today's per-tick damage with no territory bonus, and never before the shield ends.
      if (config.queenHp !== undefined && tick >= config.queenHp.shieldTicks) {
        const queen = adjacentEnemyQueen(state, ant);
        if (queen !== null) queenDamage.set(queen, (queenDamage.get(queen) ?? 0) + (ant.caste === "soldier" ? soldier : worker));
      }
      continue;
    }
    const tx = Math.floor(ant.x / SUB);
    const ty = Math.floor(ant.y / SUB);
    const onOwn = state.owner[tileIndex(config, tx, ty)] === ant.colony;
    if (onOwn) state.stats.bonusHits[ant.colony] += 1;
    const isSoldier = ant.caste === "soldier";
    const hit = onOwn ? (isSoldier ? soldierBonus : workerBonus) : isSoldier ? soldier : worker;
    damage.set(target.id, (damage.get(target.id) ?? 0) + hit);
    if (sources !== undefined) recordSource(sources, target.id, hit, ant);
    if (ant.lastTargetId !== target.id) {
      state.stats.fights += 1;
      events.push({ type: "fight", tick, antId: ant.id, targetId: target.id, colony: ant.colony, tileX: tx, tileY: ty });
    }
    ant.lastTargetId = target.id;
  }
  if (config.queenHp !== undefined) resolveQueens(state, grid, tick, events, damage, queenDamage, sources);
  if (damage.size === 0) return;
  const survivors: Ant[] = [];
  for (const ant of state.ants) {
    ant.hp -= damage.get(ant.id) ?? 0;
    if (ant.hp > 0) {
      survivors.push(ant);
      continue;
    }
    const tx = Math.floor(ant.x / SUB);
    const ty = Math.floor(ant.y / SUB);
    const i = tileIndex(config, tx, ty);
    state.food[i] += config.corpseFood;
    state.stats.deaths[ant.colony] += 1;
    if (sources !== undefined && marks !== undefined) {
      const lost = claimedMark(marks, ant);
      if (lost !== undefined) lost.antsLost = (lost.antsLost ?? 0) + 1;
      const killer = sources.get(ant.id)?.ant;
      const credited = killer == null ? undefined : claimedMark(marks, killer);
      if (credited !== undefined) credited.enemiesKilled = (credited.enemiesKilled ?? 0) + 1;
    }
    events.push({ type: "death", tick, antId: ant.id, colony: ant.colony, tileX: tx, tileY: ty });
  }
  state.ants = survivors;
}

/** The live enemy queen whose tile is within one tile of this ant's (lowest HP, then colony, then id), or null. */
export function adjacentEnemyQueen(state: SimState, ant: Ant): QueenState | null {
  const tx = Math.floor(ant.x / SUB);
  const ty = Math.floor(ant.y / SUB);
  let best: QueenState | null = null;
  const reach = gridScaleOf(state.config);
  // Every other colony, in colony order, so an equal-HP queen of a lower colony stays ahead.
  for (const enemy of state.colonies) {
    if (enemy.id === ant.colony) continue;
    let colonyBest: QueenState | null = null;
    // The live queens in activeQueens order, read in place rather than through a filtered copy.
    for (const q of enemy.queens ?? activeQueens(enemy)) {
      if (q.lostTick !== null) continue;
      if (Math.abs(Math.floor(q.queenX / SUB) - tx) > reach || Math.abs(Math.floor(q.queenY / SUB) - ty) > reach) continue;
      if (colonyBest === null || (q.hp ?? 0) < (colonyBest.hp ?? 0) || ((q.hp ?? 0) === (colonyBest.hp ?? 0) && q.id < colonyBest.id)) colonyBest = q;
    }
    if (colonyBest !== null && (best === null || (colonyBest.hp ?? 0) < (best.hp ?? 0))) best = colonyBest;
  }
  return best;
}

/**
 * Queens with HP, after the combat grace. Each live queen bites the adjacent enemy ant
 * with the lowest HP (lowest id on ties) for biteDamage once every
 * biteIntervalTicks; her bite lands with the ants' damage. Bites on her land,
 * and at zero HP she is lost. While no enemy is within regenClearTiles she
 * regains regenHp each regenIntervalTicks, up to her full HP.
 */
function resolveQueens(state: SimState, grid: Grid, tick: number, events: SimEvent[], damage: Map<number, number>, queenDamage: ReadonlyMap<QueenState, number>, sources?: Map<number, DamageSource>): void {
  const rules = state.config.queenHp!;
  for (const colony of state.colonies) {
    for (const q of activeQueens(colony)) {
      const qx = Math.floor(q.queenX / SUB);
      const qy = Math.floor(q.queenY / SUB);
      const before = q.hp ?? rules.hp;
      if (tick - (q.lastBiteTick ?? -rules.biteIntervalTicks) >= rules.biteIntervalTicks) {
        let target: Ant | null = null;
        forEachNear(state, grid, qx, qy, gridScaleOf(state.config), (other) => {
          if (other.colony === colony.id) return;
          if (target === null || other.hp < target.hp || (other.hp === target.hp && other.id < target.id)) target = other;
        });
        if (target !== null) {
          const hit: Ant = target;
          damage.set(hit.id, (damage.get(hit.id) ?? 0) + rules.biteDamage);
          if (sources !== undefined) recordSource(sources, hit.id, rules.biteDamage, null);
          q.lastBiteTick = tick;
        }
      }
      let hp = before - (queenDamage.get(q) ?? 0);
      let enemyNear = false;
      forEachNear(state, grid, qx, qy, rules.regenClearTiles, (other) => {
        if (other.colony !== colony.id && withinTiles(qx, qy, Math.floor(other.x / SUB), Math.floor(other.y / SUB), rules.regenClearTiles)) enemyNear = true;
      });
      if (enemyNear || hp >= rules.hp) q.regenFromTick = tick;
      else if (tick - (q.regenFromTick ?? tick) >= rules.regenIntervalTicks) {
        hp = Math.min(rules.hp, hp + rules.regenHp);
        q.regenFromTick = tick;
      }
      if (hp === before) continue;
      q.hp = Math.max(0, hp);
      events.push({ type: "queen_hp", tick, colony: colony.id, queenId: q.id, hp: q.hp, tileX: qx, tileY: qy });
      if (q.hp === 0) {
        q.lostTick = tick;
        events.push({ type: "queen_lost", tick, colony: colony.id, queenId: q.id, tileX: qx, tileY: qy });
        clearLostQueenSpawn(state, colony.id, q);
      }
    }
  }
}
