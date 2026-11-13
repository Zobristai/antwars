import { mountHud } from "./ui/hud.ts";
import { mountDeckHud } from "./ui/deck/hud.ts";
import type { HudView, Mounted } from "./ui/types.ts";
import type { ModeCopy } from "./replay.ts";
/**
 * The spectator page's host for its HUD (the 3D board's deck, web/src/ui/deck/hud.ts; the 2D board's web/src/ui/hud.ts),
 * and the words both HUDs share: the score's figures, the timeline's entries, the agents' cards. The host mounts the HUD,
 * hands it the board's live controls and tooltips, publishes what it draws (HudView), and keeps the viewer's selection,
 * hover and pointed order for the board, with the board's area and what the board labels keep clear of.
 */
import { COLONY_NAMES, RULES_NAMES, rulesConfig } from "../../src/sim/config.ts";
import { colonyNamesOf, type ColonyNamePair } from "../../src/sim/colonyNames.ts";
import { SUB_TILE, streamQueens, type StreamQueen, type StreamAgent, type StreamHatch, type StreamMark, type StreamStore } from "../../src/live/format.ts";
import type { Board, Frame, StoryEntry } from "./buffer.ts";
import { MODEL_LABEL, agentShade } from "./squads.ts";
import { markAge, markReading, type Rect } from "./words.ts";
import { agentHandle, modelLine, playerLabel } from "./compose.ts";
import { OPEN_COPY, SCORE_COPY, clockTime, underWay } from "./story.ts";
import { Tooltip } from "./tip.ts";
import { boardQueenHp } from "./variant.ts";

/** Under the log's heading, in one line; the Rules page carries the whole explainer. */
export { LOG_EXPLAINER, VISUAL_KEY } from "../rules.ts";
import { count } from "../rules.ts";
export { MODEL_LABEL } from "./squads.ts";
/** How an intent is labelled on the agent's detail card: the agent's thought, seen by spectators only. */
export const THOUGHT_LABEL = "Thought";

export interface OverlayHandlers {
  /** The squad to highlight: the hovered agent, else the selected one, else -1. */
  hover(agent: number): void;
  /** The viewer chose a live mark's log line: show that mark on the board. */
  focusMark(markId: number, tileX: number, tileY: number): void;
  /** The zoom buttons, by a factor about the board's centre. A board without them (no camera) leaves them off the page. */
  zoom?(factor: number): void;
  /** The whole-board button. */
  wholeBoard?(): void;
  /** The whole board from straight above, on a board that can look down on it (3D). */
  overview?(): void;
  /** Show on board: show board tile (x, y) up close. */
  locate?(x: number, y: number): void;
  /** The board tile an order the viewer points at (a HUD's Agents row) is for, to light on the board in its agent's hue (`colour`); null for none. */
  target?(tile: [number, number] | null, colour: number): void;
}

export interface AntInfo {
  antId: number;
  colony: number;
  agent: number;
}

/** Match time m:ss from a tick. */
export function matchTime(tick: number, tps: number): string {
  const s = Math.floor(tick / tps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** follow_trail steers by colony marks (src/mcp/briefing.ts). */
const ORDER_TEXT: Record<string, string> = { go_to: "go to", forage: "forage", hold: "hold", attack: "attack", follow_trail: "follow the colony's strongest mark" };

/** The target's identity stays separate from its words, so guard never depends on parsing a label. */
export interface OrderTarget {
  readonly label: string;
  readonly colony: 0 | 1;
  readonly liveQueen: boolean;
}

/** Name the colony and queen (or lost nest) at the order's tile; no tile coordinates in spectator copy. */
export function orderTarget(x: number, y: number, b: Pick<Board, "queens" | "setup">): OrderTarget | null {
  for (const q of streamQueens(b)) {
    if (Math.floor(q.x / SUB_TILE) !== x || Math.floor(q.y / SUB_TILE) !== y) continue;
    return { label: `${colonyNamesOf(b.setup)[q.colony]}'s ${q.lostTick === null ? `Queen ${q.id + 1}` : "nest"}`, colony: q.colony, liveQueen: q.lostTick === null };
  }
  return null;
}

/** Only the display verb changes: an order at a friendly living queen reads guard. */
export function orderText(a: Pick<StreamAgent, "colony" | "order" | "orderX" | "orderY">, target: OrderTarget | null = null): string {
  const directed = a.order === "go_to" || a.order === "attack";
  const verb = directed && target?.liveQueen && target.colony === a.colony ? "guard" : ORDER_TEXT[a.order]!;
  return directed && target ? `${verb} ${target.label}` : verb;
}

/**
 * A server lead, aged on delayed match playback rather than the wall clock, as a label and a figure for its colony.
 * A win due by the final simulation step reads "win in" with the time to it. A later win meets time-up first, where
 * the colony with more territory wins (the Rules page), so it reads "match ends in" with the time left to match end.
 * The countdown never runs past the match's end.
 */
function territoryWin(b: Pick<Board, "territoryWin" | "result" | "setup">, tick: number): { leader: 0 | 1; label: string; figure: string } | null {
  const lead = b.territoryWin;
  if (lead === undefined || b.result !== null || tick < lead.startTick + 1) return null;
  const tps = b.setup.ticksPerSecond;
  // The sim's last step is matchTicks - 1, which decides a sustained lead before time-up (src/sim/step.ts).
  if (lead.winTick >= b.setup.matchTicks) return { leader: lead.colony, label: SCORE_COPY.matchEndsIn, figure: clockTime(Math.ceil(Math.max(0, b.setup.matchTicks - tick) / tps) * tps, tps) };
  // winTick is a simulation step; its result appears in completed state winTick + 1.
  const seconds = Math.max(0, Math.ceil((lead.winTick + 1 - tick) / tps));
  return { leader: lead.colony, label: SCORE_COPY.winIn, figure: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` };
}

export function territoryWinText(b: Pick<Board, "territoryWin" | "result" | "setup">, tick: number): string | null {
  const win = territoryWin(b, tick);
  return win === null ? null : `${colonyNamesOf(b.setup)[win.leader]} · ${win.label} ${win.figure}`;
}

/**
 * The territory row's countdown chip and its leader: the territory countdown's label and
 * figure with the colony it favours, else no countdown and the colony holding more territory (none when level or none
 * is held); nothing once the result is in, which the result card tells.
 */
export function headline(b: Pick<Board, "territoryWin" | "result" | "setup" | "held">, tick: number): { leader: 0 | 1 | null; label: string; figure: string } {
  if (b.result !== null) return { leader: null, label: "", figure: "" };
  const win = territoryWin(b, tick);
  if (win !== null) return win;
  const [a, c] = b.held;
  return { leader: a === c ? null : a > c ? 0 : 1, label: "", figure: "" };
}

/**
 * A colony's ledger for its card: every term of alive = started with + hatched − lost, so no figure
 * reads as a contradiction. The stream carries hatched, lost, the living ants and the cap; the ants it started with
 * are what those leave, never a number from this client's config, since a recording
 * may play older rules. Unknown where the stream carries no hatch totals (a version-4 recording) or no cap, and where
 * the stream's own totals leave less than none, which no colony starts with: no figure may read as a contradiction.
 */
export function colonyLedger(stats: Pick<ColonyStats, "hatched" | "lost">, alive: number, hatch: Pick<StreamHatch, "cap"> | null): { start: number | null; hatched: number | null; lost: number; alive: number; cap: number | null } {
  const start = stats.hatched === null ? null : alive + stats.lost - stats.hatched;
  return { start: start !== null && start >= 0 ? start : null, hatched: stats.hatched, lost: stats.lost, alive, cap: hatch !== null && hatch.cap > 0 ? hatch.cap : null };
}

/**
 * The key with every space inside a term made a no-break space, so a line breaks only between its terms ("square badge"
 * stays whole), and the space before each separator too, so a line ends on its separator and never starts with one (the
 * Marks panel's narrow column broke "agent / · square badge").
 */
export function keyText(key: string): string {
  return key.split(" · ").map((term) => term.replace(/ /g, "\u00a0")).join("\u00a0· ");
}

/** Whole HP, rounded up so a living queen never reads 0. */
export function hpText(milliHp: number): string {
  return `${Math.ceil(milliHp / 1000)} HP`;
}

/**
 * The tick a timeline entry is timed at, as of playback tick `now`: an attack or attempt that took a queen,
 * once its end is reached, is timed at the end the data gives it — her loss — not at its first bite (as
 * the result card shows it, traced to the data, not the label).
 */
export function storyWhen(e: Pick<StoryEntry, "kind" | "tick" | "endTick" | "outcome">, now: number): number {
  const took = (e.kind === "queen_attack" || e.kind === "overrun") && e.outcome === "took" && e.endTick !== undefined && e.endTick <= now;
  return took ? e.endTick! : e.tick;
}

/**
 * What a timeline entry says, as of playback tick `now`; an attempt's ending is told only once
 * reached. A queen attacked carries her HP now, read from the board's queens, while
 * the attack is under way, and the HP it brought her to once it has ended. A lead change reads
 * "Takes the territory lead" as the lower third tells it, and as past (`past`) in the timeline
 * and the result card, where it is history.
 */
export function storyText(e: StoryEntry, _agents: readonly StreamAgent[], now: number, queens: readonly StreamQueen[] = [], past = false,
  names: ColonyNamePair = COLONY_NAMES): { what: string; who: string } {
  const colony = names[e.colony];
  const squad = e.agent >= 0 ? ` — squad ${agentHandle(e.agent)}` : "";
  const who = `${colony}${squad}`;
  switch (e.kind) {
    case "contact":
      return { what: "First contact", who };
    case "lead":
      return { what: past ? OPEN_COPY.tookLead : OPEN_COPY.takesLead, who };
    case "queen_founded":
      return { what: `Queen ${(e.queenId ?? 0) + 1} founded`, who: colony };
    case "queen_lost":
      return { what: `Queen ${(e.queenId ?? 0) + 1} lost`, who: colony };
    case "queen_attack": {
      const queen = `Queen ${(e.queenId ?? 0) + 1}${OPEN_COPY.underAttack ? ` ${OPEN_COPY.underAttack}` : ""}`;
      if (e.endTick === undefined || e.endTick > now) {
        const hp = queens.find((q) => q.colony === e.colony && q.id === e.queenId)?.hp ?? e.lowHp ?? 0;
        return { what: `${queen} — ${hpText(hp)}`, who: colony };
      }
      // Her fall reads as main's queen_lost entry does.
      if (e.outcome === "took") return { what: `Queen ${(e.queenId ?? 0) + 1} lost`, who: colony };
      if (e.outcome === "unfinished") return { what: `${queen} — ${hpText(e.lowHp ?? 0)} at time-up`, who: colony };
      return { what: `${queen} — repelled at ${hpText(e.lowHp ?? 0)}`, who: colony };
    }
    case "overrun": {
      const target = names[(1 - e.colony) as 0 | 1];
      if (e.endTick === undefined || e.endTick > now) return { what: `Overrun attempt on the ${target} queen — under way`, who };
      const pct = Math.round((100 * (e.peak ?? 0)) / Math.max(1, e.required ?? 1));
      if (e.outcome === "took") return { what: `Overrun attempt on the ${target} queen — took the queen`, who };
      if (e.outcome === "unfinished") return { what: `Overrun attempt on the ${target} queen — reached ${pct}% at time-up`, who };
      return { what: `Overrun attempt on the ${target} queen — repelled at ${pct}%`, who };
    }
  }
}

/**
 * An agent's lines on the card, as of playback tick `now`: "Squad order" (with the name of what its tile holds,
 * `target`, from orderTarget), "Latest active mark" or "No active marks", and the agent's call interval as a
 * detail here rather than on the roster. No tile
 * coordinates: the board lights the order's tile while the card is pointed at.
 */
export function agentCard(agent: number, a: StreamAgent, marks: readonly StreamMark[], now: number, tps: number, target: OrderTarget | null = null,
  names: ColonyNamePair = COLONY_NAMES): string[] {
  const last = marks.filter((m) => m.agent === agent).sort((x, y) => y.laidTick - x.laidTick)[0];
  return [
    `${playerLabel(agent, a)} · ${names[a.colony]}`,
    ...(a.modelLabel ? [modelLine(a, MODEL_LABEL)] : []),
    `Squad order: ${orderText(a, target)}`,
    ...(a.intent ? [`${THOUGHT_LABEL}: “${a.intent}”`] : []),
    last ? `Latest active mark: ${[markReading(last), markAge(last.laidTick, now, tps)].filter(Boolean).join(", ")}` : "No active marks",
    callsLine(a, tps),
  ];
}

/** The interval between the agent's two most recent calls, a detail of the card ("Agent calls", not "API"). */
export function callsLine(a: Pick<StreamAgent, "lastCallTick" | "prevCallTick">, tps: number): string {
  return a.prevCallTick >= 0 ? `Call interval: ${((a.lastCallTick - a.prevCallTick) / tps).toFixed(1)} s` : "Calls: 1";
}

/**
 * Whom the card is about: the agent selected most recently, by a badge, a roster row or an
 * ant (an ant tap selects its agent too), with the clicked ant only while it belongs to that
 * agent; with no agent selected, a clicked ant and its agent. A badge tap keeps the ant
 * selected but the card follows the badge's agent.
 */
export function cardSubject<T extends { agent: number }>(ant: T | null, selectedAgent: number): { ant: T | null; agent: number } {
  const agent = selectedAgent >= 0 ? selectedAgent : (ant?.agent ?? -1);
  return { ant: ant && ant.agent === agent ? ant : null, agent };
}

export type NextAnt = { kind: "unknown" | "full" | "ready" } | { kind: "food" | "waiting"; value: number };

/**
 * One state decision for every place the next ant is worded. Reads cost and next eligible
 * hatch tick from delayed playback, never the wall clock.
 */
export function nextAntState(store: StreamStore, hatch: StreamHatch | null, living: number, tick: number, tps: number): NextAnt {
  if (hatch === null) return { kind: "unknown" };
  if (living >= hatch.cap) return { kind: "full" };
  if (store.food < store.nextCost) return { kind: "food", value: store.nextCost };
  const seconds = Math.ceil(Math.max(0, store.nextHatchTick - tick) / tps);
  return seconds > 0 ? { kind: "waiting", value: seconds } : { kind: "ready" };
}

/** Only positively identified rules support caste inference; unnamed non-HP legacy data is ambiguous. */
export function nextHatchCaste(b: Pick<Board, "setup" | "queens" | "hatch">, cost: number): "worker" | "soldier" | null {
  const name = b.setup.rules ?? (boardQueenHp(b) !== undefined ? "redesign" : null);
  if (name === null || !(RULES_NAMES as readonly string[]).includes(name) || b.hatch === null) return null;
  const config = rulesConfig(name);
  const worker = b.hatch.cost, soldier = config.castes?.soldierCost;
  // A different base cost is not proof this recording used today's caste prices.
  if (worker !== config.hatchCost || soldier === undefined || worker === soldier) return null;
  return cost === worker ? "worker" : cost === soldier ? "soldier" : null;
}

/** Soonest eligibility from delayed playback, never a promise of a future birth. */
export function scoreHatchStatus(b: Pick<Board, "setup" | "queens" | "hatch" | "stores" | "result" | "overrun" | "overrunRequired">, colony: 0 | 1, living: number, tick: number): { text: string; description: string } {
  const label = (text: string, detail = text) => ({ text, description: `${colonyNamesOf(b.setup)[colony]}: ${detail}` });
  if (b.result !== null || tick >= b.setup.matchTicks) return label("Ended", "Match ended; no upcoming hatch");
  if (!streamQueens(b).some(q => q.colony === colony && q.lostTick === null && !(boardQueenHp(b) === undefined && b.overrunRequired > 0 && q.overrun >= b.overrunRequired))) return label("No queens", "No live queens; no upcoming hatch");
  const store = b.stores[colony], hatch = b.hatch;
  const tps = b.setup.ticksPerSecond;
  if (hatch === null || hatch.cap <= 0 || !(tps > 0) || ![store.food, store.nextCost, store.nextHatchTick].every(Number.isFinite) || store.nextCost <= 0) return label("Hatch unknown");
  const state = nextAntState(store, hatch, living, tick, tps);
  const caste = nextHatchCaste(b, store.nextCost);
  const icon = caste === "worker" ? "⛏ " : caste === "soldier" ? "⚔ " : "";
  const detail = caste === null ? "Next hatch; caste unknown" : `Next ${caste} hatch`;
  switch (state.kind) {
    case "unknown": return label("Hatch unknown");
    case "full": return label("Cap reached", "Hatching blocked: colony cap reached");
    case "food": return label(`${icon}Needs food`, `${detail}; blocked: needs ${state.value} food, has ${store.food}`);
    case "waiting": return label(`${icon}${state.value} s`, `${detail}; eligible in ${state.value} seconds if food and capacity permit`);
    case "ready": return label(`${icon}Eligible`, `${detail}; eligible now, not a guaranteed birth`);
  }
}

/** The next ant as the colony card's food line ends: "· Next ant 4 s". */
function nextAntText(state: NextAnt): string {
  switch (state.kind) {
    case "unknown": return "";
    case "full": return "· Cap reached";
    case "food": return "· Next ant";
    case "waiting": return `· Next ant ${state.value} s`;
    case "ready": return "· Next ant ready";
  }
}

/** The food line's two figures' cells: the stock, with the next ant's cost while it is short of it ("2/6"), and the next ant. */
export function nextAntCells(store: StreamStore, hatch: StreamHatch | null, living: number, tick: number, tps: number): readonly [string, string] | null {
  const state = nextAntState(store, hatch, living, tick, tps);
  if (state.kind === "unknown") return null;
  const food = store.food.toLocaleString("en");
  return [state.kind === "food" ? `${food}/${state.value.toLocaleString("en")}` : food, nextAntText(state)];
}

export interface ColonyStats {
  hatched: number | null;
  lost: number;
  workers: number;
  soldiers: number;
}

/** Counts living ants at the board's delayed tick, excluding corpse/fade effects. */
export function colonyStats(frame: Pick<Frame, "board" | "count" | "colony" | "caste">): [ColonyStats, ColonyStats] {
  const stats = ([0, 1] as const).map((c) => ({ hatched: frame.board?.hatched?.[c] ?? null, lost: frame.board?.deaths[c] ?? 0, workers: 0, soldiers: 0 })) as [ColonyStats, ColonyStats];
  for (let i = 0; i < frame.count; i++) {
    const colony = stats[frame.colony[i]!]!;
    if (frame.caste?.[i] === 1) colony.soldiers++;
    else colony.workers++;
  }
  return stats;
}

/**
 * A colony's card in words, every figure from the stream: the ledger, signed as it adds up
 * (started with + hatched − lost = alive now), alive with the cap beside it; one line saying what the start and the
 * cap are; the castes; and the food toward its next ant (nextAntLine: "colony full" only ever beside the cap). Its ants
 * outside squads, and what they carry and bite, are cut from the page. Unknown terms read "—" and
 * leave the note out.
 */
export function colonyCardLines(ledger: ReturnType<typeof colonyLedger>, stats: Pick<ColonyStats, "workers" | "soldiers">, food: string): { start: string; hatched: string; lost: string; alive: string; cap: string; castes: string; food: string } {
  // A minus sign, not a hyphen, wherever a figure is negative.
  const n = (v: number) => (v < 0 ? `\u2212${(-v).toLocaleString("en")}` : v.toLocaleString("en"));
  return {
    start: ledger.start === null ? "—" : n(ledger.start),
    // Display includes the starting cohort, even without historical hatch-event totals.
    hatched: n(ledger.alive + ledger.lost),
    lost: ledger.lost === 0 ? "0" : `−${n(ledger.lost)}`,
    alive: n(ledger.alive),
    cap: ledger.cap === null ? "—" : n(ledger.cap),
    // Each count with its noun agreeing in number, as the Rules page's figures do (count): never "1 soldiers".
    castes: `${count(stats.workers, "worker")} · ${count(stats.soldiers, "soldier")}`,
    food,
  };
}

/**
 * The queens under attack at playback tick `now`, as "colony:id": an attack on a queen with HP, or an overrun attempt
 * on her, still under way — the lower third's own reading (story.ts underWay). An attempt's entry is the attacker's.
 */
export function queensUnderAttack(story: readonly StoryEntry[], now: number): Set<string> {
  const keys = new Set<string>();
  for (const e of story) if (underWay(e, now)) keys.add(`${e.kind === "overrun" ? 1 - e.colony : e.colony}:${e.queenId ?? 0}`);
  return keys;
}


/** The board's live controls the HUD takes in at mount, listeners and all (HudHost). */
export interface HudControls {
  /** The 3D board mounts the Instrument deck; the 2D board and the page without one, today's HUD. */
  deck: boolean;
  replay: HTMLElement | null;
  teamView: HTMLElement | null;
  waiting: HTMLElement | null;
}

export class Overlays {
  private hud: Mounted<HudView> | null = null;
  /** The HUD's own host, appended to the page's parent at mount. */
  private hudHost: HTMLElement | null = null;
  private hudFrame: Frame | null = null;
  private hudConnection = "";
  private readonly hudBoard: HudView["board"];
  private hudMode: ModeCopy | null = null;
  private hudStalled = false;
  private hudShare: string | null = null;
  /** The scene option `overlays`: whether the HUD shows. */
  private visible = true;
  private hudView(): HudView {
    return {
      frame: this.hudFrame, connection: this.hudConnection, board: this.hudBoard, selected: this.selected, selectedAgent: this.selectedAgent,
      mode: this.hudMode, stalled: this.hudStalled, share: this.hudShare,
    };
  }
  private publishHud(): void {
    this.hud?.update(this.hudView());
  }
  /**
   * The hover and tap details: the focused mark's and squad's tooltips, in the page's type above every panel. Built on
   * an element that never enters the page, so neither shows before the HUD takes them in at mount.
   */
  readonly tips: { mark: Tooltip; squad: Tooltip };
  private hovered = -1;
  /** The agent whose order the viewer points at in a HUD's Agents row, whose tile the board lights (handlers.target); null for none. */
  private pointed: number | null = null;
  /** The last tile sent to the board for the pointed order, as "x,y,colour", or "" for none. */
  private targetSent = "";
  /** The board of the last update, which the pointed order's tile is read from. */
  private boardNow: Board | null = null;
  /** How many agents the last board listed: one past a later board's count has left, its hover and selection with it. */
  private agentCount = 0;
  /** The agent the viewer selected (a HUD's Agents row, a badge or squad ant tap), or -1. */
  selectedAgent = -1;
  private selected: AntInfo | null = null;
  private blockedCache: Rect[] | null = null;
  /** The board's area on screen, as last measured. */
  private stageRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private boardAspect: number | null = null;
  private readonly parent: HTMLElement;
  private readonly handlers: OverlayHandlers;

  constructor(parent: HTMLElement, handlers: OverlayHandlers, board: HudView["board"]) {
    this.parent = parent;
    this.handlers = handlers;
    this.hudBoard = board;
    const shelf = document.createElement("div");
    this.tips = { mark: new Tooltip(shelf), squad: new Tooltip(shelf) };
  }

  /**
   * Mount the HUD with the board's own live controls (HudHost), which it takes in with their listeners. The 3D
   * board mounts the Instrument deck (ui/deck/hud.ts); the 2D board keeps today's HUD (ui/hud.ts).
   */
  mountHud(board: HudControls): void {
    if (this.hud) return;
    const doc = this.parent.ownerDocument;
    const host = doc.createElement("div");
    host.className = "aw-hud";
    host.hidden = !this.visible;
    this.hudHost = host;
    this.parent.append(host);
    this.hud = (board.deck ? mountDeckHud : mountHud)({
      doc, host, tips: [this.tips.mark.el, this.tips.squad.el],
      replay: board.replay, teamView: board.teamView, waiting: board.waiting, boardAspect: this.boardAspect,
      actions: { ...this.handlers, select: info => this.select(info), selectAgent: agent => this.selectAgent(agent), pointOrder: agent => this.pointOrder(agent) },
    });
    this.publishHud();
    const win = doc.defaultView;
    win?.dispatchEvent(new Event("resize"));
    // The board's labels keep clear of the HUD from the first frame.
    if (win) this.boardArea(win.innerWidth, win.innerHeight);
  }

  /** The page's live/recorded line (replay.ts modeCopy), as the board sets it. */
  setMode(copy: ModeCopy): void {
    const was = this.hudMode;
    if (was && was.label === copy.label && was.detail === copy.detail && was.link?.text === copy.link?.text && was.link?.href === copy.link?.href) return;
    this.hudMode = copy; this.publishHud();
  }

  /** Whether playback has run out of data while the match still runs (Playback.underrun), reported by the board. */
  setStalled(on: boolean): void {
    if (on === this.hudStalled) return;
    this.hudStalled = on; this.publishHud();
  }

  /** The public link the result's Share on X names (source.ts watchUrl), as the board's source gives it. */
  setShare(url: string | null): void {
    if (url === this.hudShare) return;
    this.hudShare = url; this.publishHud();
  }

  /**
   * Show or hide the whole spectator interface (the scene option `overlays`): the HUD with its controls and tooltips.
   * Hiding keeps every state, listener and the board look.
   */
  setVisible(on: boolean): void {
    this.visible = on;
    if (this.hudHost) this.hudHost.hidden = !on;
  }

  /** The tooltips shown now, for checks of what is on screen. */
  tipRects(): Rect[] {
    return [this.tips.mark.rect, this.tips.squad.rect].filter((r): r is Rect => r !== null);
  }

  /** The board's stable frame ratio, which sizes the 2D HUD's window when it mounts (HudHost.boardAspect). */
  setBoardAspect(aspect: number | null): void {
    if (aspect !== null && (!Number.isFinite(aspect) || aspect <= 0)) throw new RangeError("Board aspect must be finite and positive, or null");
    this.boardAspect = aspect;
  }

  /** The screen area the whole board is shown in by default: the HUD's window, or the whole screen before it mounts. */
  area(w = window.innerWidth, h = window.innerHeight): Rect {
    return this.hud?.boardArea?.() ?? { x0: 0, y0: 0, x1: w, y1: h };
  }

  /** That area, also kept as the one the board labels stay inside (blocked()). */
  boardArea(w: number, h: number): Rect {
    const area = this.area(w, h);
    this.stageRect = area;
    this.blockedCache = null;
    return area;
  }

  /** Screen areas the board labels avoid: everything outside the board's area. */
  blocked(): Rect[] {
    if (this.blockedCache) return this.blockedCache;
    const out: Rect[] = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = this.stageRect;
    if (s.x1 > s.x0) {
      for (const r of [
        { x0: 0, y0: 0, x1: w, y1: s.y0 },
        { x0: 0, y0: s.y1, x1: w, y1: h },
        { x0: 0, y0: s.y0, x1: s.x0, y1: s.y1 },
        { x0: s.x1, y0: s.y0, x1: w, y1: s.y1 },
      ])
        if (r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5) out.push(r);
    }
    this.blockedCache = out;
    return out;
  }

  /** The stream line, as compose.ts linkLine words it. The board sets it every frame; the HUD hears only a change. */
  setLink(text: string): void {
    if (text !== this.hudConnection) { this.hudConnection = text; this.publishHud(); }
  }

  select(info: AntInfo | null): void {
    this.selected = info;
  }

  /** Select one agent (-1 for none): its squad stays highlighted while nothing else is hovered. */
  selectAgent(agent: number): void {
    this.selectedAgent = agent;
    this.handlers.hover(this.highlight());
  }

  private highlight(): number {
    return this.hovered >= 0 ? this.hovered : this.selectedAgent;
  }

  update(frame: Frame): void {
    this.hudFrame = frame; this.publishHud();
    const b = frame.board;
    // The pointed order goes with its agent or the board: a removed row never sees the pointer leave.
    if (this.pointed !== null && !b?.agents[this.pointed]) this.pointed = null;
    if (!b) {
      this.boardNow = null;
      this.syncTarget();
      return;
    }
    // A new match (or a reconnect) can carry fewer agents: one that has left takes its hover and selection with it, the
    // last first.
    for (let i = this.agentCount - 1; i >= b.agents.length; i--) {
      if (this.hovered === i) this.setHover(-1);
      if (this.selectedAgent === i) this.selectAgent(-1);
    }
    this.agentCount = b.agents.length;
    // The pointed order's tile follows the order as it changes.
    this.boardNow = b;
    this.syncTarget();
  }

  /** A HUD's Agents row points at an agent's order (-1: the pointer left it); the board's tile follows each frame. */
  pointOrder(agent: number): void {
    if (agent >= 0) this.pointed = agent;
    else if (this.pointed === null) return;
    else this.pointed = null;
    this.syncTarget();
  }

  /** Send the board the pointed order's tile as it stands on the current board, and its agent's hue, when they changed. */
  private syncTarget(): void {
    const pointed = this.pointed;
    const agents = this.boardNow?.agents ?? [];
    const a = pointed === null ? undefined : agents[pointed];
    const tile: [number, number] | null = a && (a.order === "go_to" || a.order === "attack" || a.order === "hold") ? [a.orderX, a.orderY] : null;
    const colour = a && pointed !== null ? agentShade(a.colony, pointed, agents) : 0xffffff;
    const key = tile === null ? "" : `${tile[0]},${tile[1]},${colour}`;
    if (key === this.targetSent) return;
    this.targetSent = key;
    this.handlers.target?.(tile, colour);
  }

  /** Highlight one agent's squad (-1 for none), as hovering its row does; with none hovered, the selected agent's. */
  setHover(agent: number) {
    this.hovered = agent;
    this.handlers.hover(this.highlight());
  }
}
