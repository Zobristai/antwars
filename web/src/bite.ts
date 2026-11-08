/** Event-confirmed combat with a readable visual chomp, independent of hit rate.
 * Drawing offsets never change stream/simulation coordinates. Missing hit attribution stays missing. */
import type { Frame } from "./buffer.ts";
import { SUB_TILE, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { gridScale } from "./grid-scale.ts";

export interface Engagement {
  readonly a: number;
  readonly b: number;
  /** Latest target-change tick, not the hit timer. */
  readonly tick: number;
  /** Only this tick may show the identifiable final hit. */
  readonly terminalTick?: number;
  readonly caste?: number;
}

/** One raw stream rounding unit either side of each coordinate. This tests
 * possible tiles within the match's bite reach, not an extra whole tile. */
export function adjacentWithSlack(ax: number, ay: number, bx: number, by: number, reach = 1): boolean {
  const near = (a: number, b: number) => Math.max(0,
    Math.floor((a - 1) / SUB_TILE) - Math.floor((b + 1) / SUB_TILE),
    Math.floor((b - 1) / SUB_TILE) - Math.floor((a + 1) / SUB_TILE)) <= reach;
  return near(ax, bx) && near(ay, by);
}

export class EngagementTracker {
  private pairs = new Map<number, Engagement>();
  private lastTick: number | null = null;
  private castes = new Map<number, number>();

  observe(m: StreamMessage, reach = 1): readonly Engagement[] {
    if (m.full || this.lastTick === null || m.tick !== this.lastTick + 1) {
      this.pairs.clear(); this.castes.clear();
    }
    this.lastTick = m.tick;
    const index = new Map<number, number>();
    for (let i = 0; i < m.ants.count; i++) index.set(m.ants.id[i]!, i);
    const dead = new Set(m.events.filter((e) => e.kind === "death").map((e) => e.antId));
    const fresh = new Set<number>();
    for (const e of m.events) if (e.kind === "fight") {
      fresh.add(e.antId);
      this.pairs.set(e.antId, { a: e.antId, b: e.targetId, tick: m.tick });
    }
    const shown: Engagement[] = [];
    for (const [id, pair] of this.pairs) {
      const a = index.get(pair.a), b = index.get(pair.b);
      if (pair.a === pair.b) { this.pairs.delete(id); continue; }
      const terminal = dead.has(pair.a) || dead.has(pair.b);
      if (terminal) {
        // Live attackers retain the authorized fixed-interval killing hit.
        // Dead attackers require this tick's explicit fight; previous corpse
        // coordinates do NOT prove a dying ant's final movement or attack.
        if ((a !== undefined && dead.has(pair.b)) || (dead.has(pair.a) && fresh.has(pair.a) && (b !== undefined || dead.has(pair.b)))) {
          shown.push({ ...pair, terminalTick: m.tick, caste: a === undefined ? this.castes.get(id) ?? 0 : m.ants.caste?.[a] ?? 0 });
        }
        this.pairs.delete(id);
      } else if (a === undefined || b === undefined || m.ants.colony[a] === m.ants.colony[b] ||
        !adjacentWithSlack(m.ants.x[a]!, m.ants.y[a]!, m.ants.x[b]!, m.ants.y[b]!, reach)) {
        this.pairs.delete(id);
      } else shown.push(pair);
    }
    this.castes = new Map(Array.from(index, ([id, i]) => [id, m.ants.caste?.[i] ?? 0]));
    return shown;
  }
}

/** Drawing only: four chomps/second, not the simulation's ten hits/second. */
export const BITE_MS = 250;
/** Representative still times within one visual cycle. */
export const BITE_OPEN_MS = 50;
export const BITE_CONTACT_MS = 150;
export const BITE_CONTACT_END_MS = 175;
export const BITE_RECOVERED_MS = 249;
export const BITE_BODY_REACH = 0.3;
export const BITE_HEAD_REACH = 0.15;
/** A bounded continuous offset, not a teleport when an engagement changes. */
export const BITE_BODY_SPEED = 0.0036; // tiles per playback millisecond
export type BiteModel = "2d" | "3d";
export interface BitePose {
  x: number; y: number; rotation: number; jawOpen: number;
  /** Head displacement from the leaned body, in local forward/left tiles. */
  headOffset: number;
  headSideOffset: number;
  /** Resting drawn head to solved target boundary, including model size. */
  gap: number;
  contact: { x: number; y: number };
  contacting: boolean;
}
interface Actor { x: number; y: number; rotation: number; drawRotation?: number; caste: number; dead: boolean; alpha: number; ageMs?: number }
interface Lean {
  x: number; y: number; at: number; since: number;
  fromX: number; fromY: number; event: string | null;
}
const drawnContacts = new WeakMap<Frame, { renderMs: number; points: readonly { x: number; y: number }[] }>();
/** The ant renderer publishes its exact head contacts before the battle layer draws. */
export function renderedBiteContacts(frame: Frame): readonly { x: number; y: number }[] {
  const drawn = drawnContacts.get(frame);
  return drawn?.renderMs === frame.renderMs ? drawn.points : [];
}
const smooth = (t: number) => t * t * (3 - 2 * t);
export const headFront = (model: BiteModel, caste: number) => model === "2d" ? (caste ? 20.3 : 22.8) / 64 : caste ? 0.41 : 0.37;

/** Stateless in playback time: a shared 250 ms visual clock keeps reciprocal
 * heads in phase. Confirmed pairs alone gate biting, without resetting the
 * chomp on target changes. Underrun holds the clock; seeks stay deterministic. */
export class Bites {
  private frame: Frame | null = null;
  private actors = new Map<number, Actor>();
  private pairs = new Map<number, Engagement>();
  private poses = new Map<number, BitePose>();
  private key = "";
  private leans = new Map<string, Map<number, Lean>>();
  private positions = new Map<number, { x: number; y: number }>();
  private builtAt = new Map<string, number>();
  private previousBuildMs: number | undefined;
  private lastRenderMs = -Infinity;
  private setup: object | undefined;

  update(frame: Frame): void {
    const setup = frame.board?.setup;
    if (frame.renderMs < this.lastRenderMs || setup !== this.setup) { this.leans.clear(); this.builtAt.clear(); }
    this.lastRenderMs = frame.renderMs; this.setup = setup;
    this.frame = frame; this.actors.clear(); this.pairs.clear(); this.poses.clear(); this.positions.clear(); this.key = "";
    const period = 1000 / (frame.board?.setup.ticksPerSecond ?? 10);
    const reach = gridScale(frame.board?.setup ?? {});
    for (const c of frame.corpses) if (c.ageMs >= 0) {
      this.actors.set(c.antId, { x: c.x, y: c.y, rotation: c.heading, caste: 0, dead: true, alpha: 1, ageMs: c.ageMs });
    }
    for (let i = 0; i < frame.count; i++) this.actors.set(frame.id[i]!, {
      x: frame.x[i]!, y: frame.y[i]!, rotation: frame.rotation[i]!, drawRotation: frame.drawRotation?.[i], caste: frame.caste[i]!, dead: false, alpha: frame.alpha[i]!,
    });
    for (const p of frame.engagements) {
      const a = this.actors.get(p.a), b = this.actors.get(p.b);
      if (!a || !b || p.a === p.b || (p.terminalTick !== undefined && p.terminalTick !== frame.tick)) continue;
      if (a.dead && (p.terminalTick === undefined || a.ageMs! >= period)) continue;
      if (p.terminalTick === undefined && !adjacentWithSlack(a.x * SUB_TILE, a.y * SUB_TILE, b.x * SUB_TILE, b.y * SUB_TILE, reach)) continue;
      if (a.dead) a.caste = p.caste ?? 0;
      this.pairs.set(p.a, p);
    }
    if (this.actors.size === 0) { this.leans.clear(); this.builtAt.clear(); }
  }

  private lean(states: Map<number, Lean>, id: number, goalX: number, goalY: number, pair?: Engagement): { x: number; y: number } {
    const f = this.frame!, event = pair ? `${pair.tick}:${pair.b}` : null;
    let state = states.get(id);
    if (!state) {
      if (!pair) return { x: 0, y: 0 };
      state = { x: 0, y: 0, at: f.renderMs, since: this.previousBuildMs === undefined ? pair.tick * TICK_MS : f.renderMs, fromX: 0, fromY: 0, event };
      const u = smooth(Math.min(1, Math.max(0, (f.renderMs - state.since) / 100)));
      state.x = goalX * u; state.y = goalY * u;
      states.set(id, state);
    } else if (f.renderMs > state.at) {
      if (event !== state.event) {
        state.fromX = state.x; state.fromY = state.y;
        state.since = f.renderMs; state.event = event;
      }
      const u = smooth(Math.min(1, (f.renderMs - state.since) / 100));
      const x = state.fromX + (goalX - state.fromX) * u, y = state.fromY + (goalY - state.fromY) * u;
      const dx = x - state.x, dy = y - state.y, d = Math.hypot(dx, dy);
      const step = BITE_BODY_SPEED * (f.renderMs - state.at), scale = d > step ? step / d : 1;
      state.x += dx * scale; state.y += dy * scale; state.at = f.renderMs;
    }
    if (!pair && Math.hypot(state.x, state.y) < 1e-9) states.delete(id);
    return { x: state.x, y: state.y };
  }

  private build(workerLength: number, model: BiteModel): void {
    const key = `${workerLength}:${model}`;
    if (this.key === key) return;
    this.key = key; this.poses.clear(); this.positions.clear();
    const f = this.frame;
    if (!f) return;
    this.previousBuildMs = this.builtAt.get(key); this.builtAt.set(key, f.renderMs);
    let states = this.leans.get(key);
    if (!states) { states = new Map(); this.leans.set(key, states); }
    for (const id of states.keys()) if (!this.actors.has(id)) states.delete(id);
    const age = ((f.renderMs % BITE_MS) + BITE_MS) % BITE_MS;
    const reach = age < 125 ? smooth(age / 125) : age < BITE_CONTACT_END_MS ? 1 : 1 - smooth((age - BITE_CONTACT_END_MS) / (BITE_MS - BITE_CONTACT_END_MS));
    // A 75 ms plateau guarantees at least two fully-open frames at 30 fps,
    // regardless of frame alignment. Neither hits nor retargets reset it.
    const jawOpen = age < 25 ? smooth(age / 25) : age < 100 ? 1 : age < 125 ? 1 - smooth((age - 100) / 25) : 0;
    const visiting = new Set<number>();
    for (const id of states.keys()) if (!this.pairs.has(id)) {
      const a = this.actors.get(id)!;
      const lean = this.lean(states, id, 0, 0);
      this.positions.set(id, { x: a.x + lean.x, y: a.y + lean.y });
    }
    const tip = (a: Actor) => {
      // Existing 3D corpses use the worker mesh; preserve that geometry even
      // during an explicit final bite. Live spawn scale affects the boundary.
      const caste = model === "3d" && a.dead ? 0 : a.caste;
      return headFront(model, caste) * workerLength * (caste ? 2 : 1) * (model === "3d" && !a.dead ? 0.35 + 0.65 * a.alpha : 1);
    };
    const resolve = (id: number): BitePose | null => {
      const cached = this.poses.get(id); if (cached) return cached;
      const p = this.pairs.get(id), a = this.actors.get(id);
      if (!p || !a || visiting.has(id)) return null;
      const b = this.actors.get(p.b)!;
      visiting.add(id);
      let cx: number, cy: number;
      if (this.pairs.get(p.b)?.b === id) {
        // Reciprocal heads meet at one exact shared boundary, independently
        // of different worker/soldier sizes and travel headings.
        cx = (a.x + b.x) / 2; cy = (a.y + b.y) / 2;
      } else {
        const targetPose = resolve(p.b);
        const angle = targetPose?.rotation ?? b.drawRotation ?? b.rotation;
        const targetPosition = targetPose ?? this.positions.get(p.b);
        cx = (targetPosition?.x ?? b.x) + Math.cos(angle) * (tip(b) + (targetPose?.headOffset ?? 0)) - Math.sin(angle) * (targetPose?.headSideOffset ?? 0);
        cy = (targetPosition?.y ?? b.y) + Math.sin(angle) * (tip(b) + (targetPose?.headOffset ?? 0)) + Math.cos(angle) * (targetPose?.headSideOffset ?? 0);
      }
      visiting.delete(id);
      const dx = cx - a.x, dy = cy - a.y, d = Math.hypot(dx, dy);
      if (!Number.isFinite(d)) return null;
      const rotation = a.drawRotation ?? (d < 1e-6 ? (id < p.b ? 0 : Math.PI) : Math.atan2(dy, dx));
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      // The gap is measured from the RESTING drawn head to this boundary,
      // not between body centres. The head's cap is relative to the leaned body.
      const gx = cx - a.x - cos * tip(a), gy = cy - a.y - sin * tip(a), gap = Math.hypot(gx, gy);
      const bodyReach = Math.min(BITE_BODY_REACH, Math.max(0, gap - BITE_HEAD_REACH)) * reach;
      const lean = this.lean(states!, id, gap ? gx / gap * bodyReach : 0, gap ? gy / gap * bodyReach : 0, p);
      const x = a.x + lean.x, y = a.y + lean.y;
      const hx = cx - x - cos * tip(a), hy = cy - y - sin * tip(a), remaining = Math.hypot(hx, hy);
      const headScale = remaining ? Math.min(1, BITE_HEAD_REACH / remaining) * reach : 0;
      const wx = hx * headScale, wy = hy * headScale;
      const pose: BitePose = { x, y, rotation, headOffset: wx * cos + wy * sin, headSideOffset: -wx * sin + wy * cos,
        gap, jawOpen, contact: { x: cx, y: cy }, contacting: age >= 125 && age < BITE_CONTACT_END_MS && remaining <= BITE_HEAD_REACH + 1e-6 };
      this.positions.set(id, { x, y });
      this.poses.set(id, pose); return pose;
    };
    for (const id of this.pairs.keys()) resolve(id);
    // A shared boundary is a real contact only when both reciprocal heads reach it.
    for (const [id, pose] of this.poses) {
      const target = this.pairs.get(id)!.b;
      if (this.pairs.get(target)?.b === id && !this.poses.get(target)?.contacting) pose.contacting = false;
    }
    // A walking ant can finish a short body recovery without inventing a bite.
    for (const id of states.keys()) if (!this.poses.has(id)) {
      const a = this.actors.get(id)!;
      const lean = this.lean(states, id, 0, 0);
      this.positions.set(id, { x: a.x + lean.x, y: a.y + lean.y });
    }
  }

  bodyPosition(index: number, bodyLength: number, model: BiteModel = "3d"): { x: number; y: number } | null {
    const f = this.frame;
    if (!f || index < 0 || index >= f.count) return null;
    this.build(bodyLength / (f.caste[index] === 1 ? 2 : 1), model);
    return this.positions.get(f.id[index]!) ?? null;
  }

  corpsePosition(id: number, workerLength: number, model: BiteModel = "3d"): { x: number; y: number } | null {
    this.build(workerLength, model); return this.positions.get(id) ?? null;
  }

  pose(index: number, bodyLength: number, model: BiteModel = "3d"): BitePose | null {
    const f = this.frame;
    if (!f || index < 0 || index >= f.count) return null;
    this.build(bodyLength / (f.caste[index] === 1 ? 2 : 1), model);
    return this.poses.get(f.id[index]!) ?? null;
  }

  corpsePose(id: number, workerLength: number, model: BiteModel = "3d"): BitePose | null {
    this.build(workerLength, model);
    return this.poses.get(id) ?? null;
  }

  publishContacts(workerLength: number, model: BiteModel): void {
    if (this.frame) drawnContacts.set(this.frame, { renderMs: this.frame.renderMs, points: this.contacts(workerLength, model) });
  }

  contacts(workerLength: number, model: BiteModel): readonly { x: number; y: number }[] {
    this.build(workerLength, model);
    const out: { x: number; y: number }[] = [];
    for (const [id, p] of this.poses) if (p.contacting) {
      const target = this.pairs.get(id)!.b;
      if (this.pairs.get(target)?.b === id && id > target) continue;
      out.push(p.contact);
    }
    return out;
  }
}
