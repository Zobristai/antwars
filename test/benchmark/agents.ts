import { DEFAULT_CONFIG } from "../../src/sim/config.js";
import { createRng, type Rng } from "../../src/sim/rng.js";
import { WORDS, type ColonyId, type Order } from "../../src/sim/types.js";
import type { AgentView } from "../../src/sim/view.js";
import type { Brain, Command } from "./match.js";

/**
 * The scripted agents. Each sees only its own view
 * (its fog), issues at most one command per shared command floor, and lays
 * marks only where one of its squad's ants stands (the sim's rule), so it moves
 * its squad first and marks once the squad has arrived and stands still.
 */

/** Every kept mark is re-laid once it is this old (150 s), until a newer mark evicts it. */
const REFRESH_TICKS = 1500;
/** Ticks per tile of squad travel, for scheduling a refresh trip early enough. */
const TICKS_PER_TILE = Math.ceil(DEFAULT_CONFIG.ticksPerSecond / DEFAULT_CONFIG.antSpeedTilesPerSecond);
/** Chebyshev radius for local strength counts. */
const LOCAL = 3;
/** The scout's waypoints sit this many tiles inside its colony's territory edge. */
const SCOUT_INSET = 2;
/** The control agent gives up a go_to target its squad has not reached in this long (60 s). */
const GIVE_UP_TICKS = 600;
/** Foraging time between the economy agent's scouting trips (120 s). */
const SCOUT_EVERY_TICKS = 1200;

interface Tile {
  readonly tileX: number;
  readonly tileY: number;
}

function cheb(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

function enemyOf(colony: ColonyId): ColonyId {
  return colony === 0 ? 1 : 0;
}

/** Own and enemy ants the view shows within r tiles (Chebyshev) of a tile. */
function localCounts(view: AgentView, at: Tile, r: number): { own: number; enemy: number } {
  let own = 0;
  let enemy = 0;
  for (const cell of view.cells) {
    if (cheb(cell, at) > r) continue;
    for (const ant of cell.ants) {
      if (ant.colony === view.colony) own += 1;
      else enemy += 1;
    }
  }
  return { own, enemy };
}

function ownTile(view: AgentView, t: Tile): boolean {
  return view.territoryRows[t.tileY]?.[t.tileX] === "#";
}

/** The squad ant's tile nearest a point, and its distance. */
function nearestSquadTile(view: AgentView, to: Tile): { tile: Tile; d: number } | null {
  let best: { tile: Tile; d: number } | null = null;
  for (const ant of view.squad) {
    const d = cheb(ant, to);
    if (best === null || d < best.d || (d === best.d && (ant.tileY < best.tile.tileY || (ant.tileY === best.tile.tileY && ant.tileX < best.tile.tileX)))) {
      best = { tile: { tileX: ant.tileX, tileY: ant.tileY }, d };
    }
  }
  return best;
}

/** The tile a go_to or attack order sends the squad to, or null for other orders. */
function targetOf(order: Order): Tile | null {
  return order.kind === "go_to" || order.kind === "attack" ? order : null;
}

/**
 * The squad ant standing on (or next to) its go_to/attack target, or null when
 * none has reached it yet. One ant is enough, so a lagging, fighting or newly
 * drafted ant cannot hold the brain off its next step.
 */
function reachedTile(view: AgentView): Tile | null {
  const target = targetOf(view.order);
  if (target === null) return null;
  const at = nearestSquadTile(view, target);
  return at !== null && at.d <= 1 ? at.tile : null;
}

function sameOrder(a: Order, b: Order): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** An order (kept or changed) carrying an optional mark, or null when neither changes. */
function command(view: AgentView, order: Order, mark: (Tile & { words: string[] }) | null): Command | null {
  if (mark !== null) {
    return { type: "order", order, mark: { tileX: mark.tileX, tileY: mark.tileY, words: mark.words } };
  }
  return sameOrder(view.order, order) ? null : { type: "order", order };
}

/**
 * Lay a mark where the squad stands near a point. The squad must stand still
 * through the decision delay for the mark's tile to still hold one of its ants,
 * so the agent first orders hold, and on its next turn (the squad now held)
 * lays the mark carried by its next order. Undefined when the squad is not
 * within LOCAL tiles of the point.
 */
function markThere(view: AgentView, point: Tile, words: string[], then: Order): Command | null | undefined {
  const at = nearestSquadTile(view, point);
  if (at === null || at.d > LOCAL) return undefined;
  if (view.order.kind !== "hold") return { type: "order", order: { kind: "hold" } };
  return command(view, then, { ...at.tile, words });
}

interface KeptMark {
  readonly tileX: number;
  readonly tileY: number;
  readonly words: readonly string[];
  readonly laidTick: number;
}

/**
 * The agent's record of its own live marks, built only from its view: marks it
 * sees (view.marks, mine) and the marks it sent, matched to the new id that
 * appears in view.myMarks once the command has landed (a rejected mark gains no
 * id and is dropped). Ids that leave view.myMarks (evicted or expired) are dropped.
 */
class MarkBook {
  private readonly known = new Map<number, KeptMark>();
  private pending: { readonly mark: KeptMark; readonly before: ReadonlySet<number> } | null = null;

  constructor(private readonly lifetime: number) {}

  sync(view: AgentView): void {
    const live = new Set(view.myMarks.map((m) => m.markId));
    if (this.pending !== null && view.tick >= this.pending.mark.laidTick) {
      const before = this.pending.before;
      const id = view.myMarks.map((m) => m.markId).find((i) => !before.has(i) && !this.known.has(i));
      if (id !== undefined) this.known.set(id, this.pending.mark);
      this.pending = null;
    }
    for (const m of view.marks) {
      if (m.mine) this.known.set(m.markId, { tileX: m.tileX, tileY: m.tileY, words: m.words, laidTick: view.tick - (this.lifetime - m.ticksLeft) });
    }
    for (const id of [...this.known.keys()]) if (!live.has(id)) this.known.delete(id);
  }

  /** Note a command carrying a mark, sent to land at landTick. */
  sent(view: AgentView, command: Command | null, landTick: number): void {
    const mark = command === null ? undefined : command.type === "mark" ? command : command.mark;
    if (mark === undefined) return;
    this.pending = { mark: { tileX: mark.tileX, tileY: mark.tileY, words: mark.words, laidTick: landTick }, before: new Set(view.myMarks.map((m) => m.markId)) };
  }

  /** Kept marks, oldest first, leaving out any already re-laid by a newer mark with the same words within 1 tile. */
  kept(): KeptMark[] {
    const all = [...this.known.values()].sort((a, b) => a.laidTick - b.laidTick);
    return all.filter((m) => !all.some((n) => n.laidTick > m.laidTick && n.words.join(" ") === m.words.join(" ") && cheb(n, m) <= 1));
  }

  /** True when a kept mark with this first word lies within r tiles (it is refreshed, so it stays). */
  has(word: string, at: Tile, r: number): boolean {
    return this.kept().some((m) => m.words[0] === word && cheb(m, at) <= r);
  }

  /**
   * Refresh scheduling: the oldest kept mark whose refresh is near goes first.
   * The squad goes to the mark, holds within 1 tile of it, and re-lays the same
   * words so the new mark lands at 150 s of age (or, at the last landing before
   * it would expire, earlier). The trip starts early enough to cover the travel
   * and the go/hold/mark commands at this delay. Undefined when no refresh is due.
   */
  refresh(view: AgentView, landTick: number): Command | null | undefined {
    const delay = landTick - view.tick;
    const cadence = Math.max(2 * delay, DEFAULT_CONFIG.commandFloorTicks);
    for (const m of this.kept()) {
      const age = landTick - m.laidTick;
      const at = nearestSquadTile(view, m);
      if (at === null) return undefined;
      // Go (travel), see the squad arrive (one observe), then lay: start in time to lay by 150 s.
      if (age + at.d * TICKS_PER_TILE + 2 * cadence + delay < REFRESH_TICKS) continue;
      const go: Order = { kind: "go_to", tileX: m.tileX, tileY: m.tileY };
      // An ant on the mark's tile that stays there through the delay: the squad holds, or has arrived at the mark.
      const standing = at.d <= 1 && (view.order.kind === "hold" || (sameOrder(view.order, go) && at.d === 0));
      if (standing) {
        if (age >= REFRESH_TICKS || age + delay >= this.lifetime) return command(view, { kind: "hold" }, { ...at.tile, words: [...m.words] });
        return null;
      }
      if (at.d <= 1) {
        // Hold first, unless holding would leave no landing before the mark expires: then lay now.
        if (age + cadence >= this.lifetime) return command(view, { kind: "hold" }, { ...at.tile, words: [...m.words] });
        return { type: "order", order: { kind: "hold" } };
      }
      return sameOrder(view.order, go) ? null : { type: "order", order: go };
    }
    return undefined;
  }
}

/** Wrap a brain with its mark book: sync the book, refresh due marks first, record any mark sent. */
function withMarkBook(lifetime: number, inner: (view: AgentView, landTick: number, book: MarkBook) => Command | null): Brain {
  const book = new MarkBook(lifetime);
  return {
    decide(view, landTick) {
      book.sync(view);
      if (view.squad.length === 0 || landTick < view.nextCommandTick) return null;
      const refresh = book.refresh(view, landTick);
      const out = refresh !== undefined ? refresh : inner(view, landTick, book);
      book.sent(view, out, landTick);
      return out;
    },
  };
}

/**
 * Front agent: marks ATTACK at the visible front tile where its side has the
 * largest local majority and sends its squad to that point (go_to: the squad
 * fights what it meets there; the attack order would chase every enemy in
 * sight, away from the point, and bleed the colony); marks GATHER on a
 * home tile where the enemy is locally stronger; when the enemy queen is visible
 * and its side is at least 1.5 times stronger near it, marks ATTACK QUEEN.
 */
export function frontAgent(markLifetimeTicks: number, mapWidth: number, mapHeight: number): Brain {
  return withMarkBook(markLifetimeTicks, (view, _landTick, book) => {
      const enemy = enemyOf(view.colony);

      // Enemy queen in sight and our side at least 1.5 times stronger near it.
      const queen = view.cells.find((c) => c.queen === enemy);
      if (queen !== undefined) {
        const near = localCounts(view, queen, LOCAL);
        if (near.own > 0 && near.own * 2 >= near.enemy * 3) {
          const order: Order = { kind: "go_to", tileX: queen.tileX, tileY: queen.tileY };
          if (!book.has("ATTACK", queen, LOCAL)) {
            const marked = markThere(view, queen, ["ATTACK", "QUEEN"], order);
            if (marked !== undefined) return marked;
          }
          return command(view, order, null);
        }
      }

      // A home tile where the enemy is locally stronger: GATHER there.
      let threat: { tile: Tile; gap: number } | null = null;
      for (const cell of view.cells) {
        if (!cell.ants.some((a) => a.colony === enemy) || !ownTile(view, cell)) continue;
        const c = localCounts(view, cell, LOCAL);
        const gap = c.enemy - c.own;
        if (gap > 0 && (threat === null || gap > threat.gap)) threat = { tile: cell, gap };
      }
      if (threat !== null) {
        if (!book.has("GATHER", threat.tile, LOCAL)) {
          const order: Order = { kind: "go_to", tileX: threat.tile.tileX, tileY: threat.tile.tileY };
          const marked = markThere(view, threat.tile, ["GATHER"], order);
          if (marked !== undefined) return marked;
        }
      }

      // The front: the visible enemy tile where our local majority is largest.
      let front: { tile: Tile; lead: number } | null = null;
      for (const cell of view.cells) {
        if (!cell.ants.some((a) => a.colony === enemy)) continue;
        const c = localCounts(view, cell, LOCAL);
        const lead = c.own - c.enemy;
        if (lead > 0 && (front === null || lead > front.lead)) front = { tile: cell, lead };
      }
      if (front !== null) {
        const order: Order = { kind: "go_to", tileX: front.tile.tileX, tileY: front.tile.tileY };
        if (!book.has("ATTACK", front.tile, LOCAL)) {
          const marked = markThere(view, front.tile, ["ATTACK"], order);
          if (marked !== undefined) return marked;
        }
        // Keep to the same area rather than re-ordering for every small shift.
        if (view.order.kind === "go_to" && cheb(view.order, front.tile) <= LOCAL) return null;
        return command(view, order, null);
      }

      // No enemy in sight: hold the middle of the map until the front shows (a squad that has
      // reached an old front point, or holds after a mark, goes back to the middle).
      const mid: Order = { kind: "go_to", tileX: Math.floor(mapWidth / 2), tileY: Math.floor(mapHeight / 2) };
      if (sameOrder(view.order, mid) || (view.order.kind === "go_to" && reachedTile(view) === null)) return null;
      return command(view, mid, null);
  });
}

/**
 * Economy-and-scout agent: its squad forages, and every 120 s makes a scouting
 * trip to the edge of its fog (just inside its colony's territory edge, in
 * three bands in turn); marks FOOD MANY on food clusters
 * and ENEMY MANY with a direction on incoming masses; when it sees its
 * partner's ATTACK mark, it backs it with GATHER nearby.
 */
export function economyScoutAgent(markLifetimeTicks: number, mapWidth: number, mapHeight: number): Brain {
  let band = 0;
  /** The tick from which the squad leaves foraging for its next scouting trip. */
  let scoutDue = 0;
  const bands = [Math.floor(mapHeight / 6), Math.floor(mapHeight / 2), Math.floor((mapHeight * 5) / 6)];

  function scoutPoint(view: AgentView): Tile {
    const y = bands[band % bands.length]!;
    const row = view.territoryRows[y] ?? "";
    // The furthest own tile toward the enemy on this row, one step beyond it.
    let x = view.colony === 0 ? 0 : mapWidth - 1;
    for (let tx = 0; tx < row.length; tx += 1) {
      if (row[tx] !== "#") continue;
      if (view.colony === 0 ? tx > x : tx < x) x = tx;
    }
    if (!row.includes("#")) x = view.colony === 0 ? Math.floor(mapWidth / 4) : mapWidth - 1 - Math.floor(mapWidth / 4);
    // Two tiles inside the edge: the squad scouts the edge of its fog without walking into the enemy.
    x = Math.max(0, Math.min(mapWidth - 1, x - (view.colony === 0 ? SCOUT_INSET : -SCOUT_INSET)));
    return { tileX: x, tileY: y };
  }

  function next(view: AgentView): Order {
    band += 1;
    const p = scoutPoint(view);
    return { kind: "go_to", tileX: p.tileX, tileY: p.tileY };
  }

  return withMarkBook(markLifetimeTicks, (view, landTick, book) => {
      const here = reachedTile(view);

      // Back the partner's ATTACK mark with GATHER nearby.
      const partner = view.marks.find((m) => !m.mine && m.words[0] === "ATTACK");
      if (partner !== undefined && !book.has("GATHER", partner, LOCAL + 1)) {
        if (here !== null && cheb(here, partner) <= LOCAL + 1) return command(view, { kind: "forage" }, { ...here, words: ["GATHER"] });
        const back = view.colony === 0 ? -2 : 2;
        const target = { kind: "go_to", tileX: Math.max(0, Math.min(mapWidth - 1, partner.tileX + back)), tileY: partner.tileY } as const;
        return sameOrder(view.order, target) ? null : command(view, target, null);
      }

      // Between scouting trips the squad forages: a scouting squad delivers no food.
      if (view.tick < scoutDue) return command(view, { kind: "forage" }, null);
      // Foraging, or held after a mark refresh: the stint is over, start the scouting trip.
      if (view.order.kind === "forage" || view.order.kind === "follow_trail" || view.order.kind === "hold") return command(view, next(view), null);
      if (here === null) return null;
      const done = (mark: (Tile & { words: string[] }) | null): Command | null => {
        scoutDue = landTick + SCOUT_EVERY_TICKS;
        return command(view, { kind: "forage" }, mark);
      };

      // An incoming enemy mass in sight: ENEMY MANY with the direction it is in.
      const enemy = enemyOf(view.colony);
      let count = 0;
      let sx = 0;
      let sy = 0;
      for (const cell of view.cells) {
        for (const ant of cell.ants) {
          if (ant.colony !== enemy) continue;
          count += 1;
          sx += cell.tileX;
          sy += cell.tileY;
        }
      }
      if (count >= 6 && !book.has("ENEMY", here, LOCAL + 1)) {
        const dx = sx / count - here.tileX;
        const dy = sy / count - here.tileY;
        const dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "E" : "W") : dy >= 0 ? "S" : "N";
        return done({ ...here, words: ["ENEMY", "MANY", dir] });
      }

      // A food cluster: go to its richest tile, then mark FOOD MANY there.
      let rich: { tile: Tile; food: number } | null = null;
      for (const cell of view.cells) {
        if (cell.food <= 0) continue;
        let sum = 0;
        for (const other of view.cells) if (cheb(other, cell) <= 1) sum += other.food;
        if (rich === null || sum > rich.food) rich = { tile: cell, food: sum };
      }
      // Only a safe cluster: on home ground with no enemy in sight, so the mark draws foragers, not the front line.
      if (rich !== null && rich.food >= 10 && count === 0 && ownTile(view, rich.tile) && !book.has("FOOD", rich.tile, LOCAL)) {
        if (cheb(here, rich.tile) <= 1) return done({ ...here, words: ["FOOD", "MANY"] });
        return command(view, { kind: "go_to", tileX: rich.tile.tileX, tileY: rich.tile.tileY }, null);
      }

      return done(null);
  });
}

/**
 * Control agent: no deliberate play. Sends its
 * squad to random tiles and, once one of its ants is there, lays a mark of 1 to
 * 3 random words and picks the next tile; a tile not reached in 60 s is dropped
 * for a new one. Seeded from the sim's PRNG, so every run is reproducible.
 */
export function randomMarkAgent(seed: number, mapWidth: number, mapHeight: number): Brain {
  const rng: Rng = createRng(seed);
  const pick = (n: number): number => Math.floor(rng.next() * n);
  const randomGoTo = (): Order => ({ kind: "go_to", tileX: pick(mapWidth), tileY: pick(mapHeight) });
  /** Landing tick of the current go_to; a target not reached within GIVE_UP_TICKS is dropped for a new one. */
  let sentTick = 0;
  return {
    decide(view, landTick) {
      if (view.squad.length === 0 || landTick < view.nextCommandTick) return null;
      const at = reachedTile(view);
      if (view.order.kind !== "go_to" || (at === null && landTick - sentTick >= GIVE_UP_TICKS)) {
        sentTick = landTick;
        return { type: "order", order: randomGoTo() };
      }
      if (at === null) return null;
      const words = Array.from({ length: 1 + pick(3) }, () => WORDS[pick(WORDS.length)]!);
      sentTick = landTick;
      return { type: "order", order: randomGoTo(), mark: { tileX: at.tileX, tileY: at.tileY, words } };
    },
  };
}

/** Idle joiner: observes on its cadence and never orders or marks. */
export const idleAgent: Brain = {
  decide() {
    return null;
  },
};
