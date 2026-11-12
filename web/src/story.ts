/**
 * The match's story as the page tells it: the clock, the one significant event, and the win rules. Pure: every
 * value is read from the delayed playback's board and story, so nothing here
 * runs ahead of what the page shows.
 *
 * The page's new words live in PAGE_COPY, in one place, so a change to any of
 * them changes one line. Every other string is the client's or the briefing's.
 */
import { DEFAULT_CONFIG, PUBLIC_CONFIG, QUEEN_RULES, type SimConfig } from "../../src/sim/config.ts";
import type { StreamResult, StreamSetup } from "../../src/live/format.ts";
import { briefing } from "../../src/mcp/briefing.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import type { StoryEntry } from "./buffer.ts";

/**
 * The page's own strings: name, credit, the zoom names, "Whole board", and "ended", in place of the time left once the
 * match has ended. "Agents · N", "How to win" and "time left" are the briefing's words.
 */
/**
 * How a match ends, open on first view under the key (the Rules page carries each
 * route with this match's numbers): its first route is the Rules page's own words for the board's rules
 * (web/rules.ts queensRoute), the other two fixed.
 */
export function howToWinLine(queensRoute: string): string {
  return `Three ways a match ends: ${queensRoute} · a sustained territory lead · time up`;
}

export const PAGE_COPY = {
  name: "Antwars",
  credit: "Built with Zobrist",
  /** The emblem and wordmark link's accessible name: it goes to the home page. */
  home: "Antwars home",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  wholeBoard: "Whole board",
  ended: "ended",
} as const;

/** Inspiration tweet. */
export const INSPIRED_BY_URL = "https://x.com/LambethEthan/status/2108791452163875012";

/**
 * Copy for count marks: a mark reads "<VERB> <count> · <claimed> answered",
 * for example "DEFEND 15 · 12 answered", every number from the stream; anything a viewer reads
 * says "answered", never "claimed". A raw identifier is never copy, so a count mark from a stream
 * that carries no verb (an older recording) has no reading and no gloss. On the board, only this
 * form is drawn beside a count mark's marker; all other text stays off the board.
 */
export const OPEN_COPY = {
  /** How many free ants a count mark has, after its count. */
  answered: "answered",
  /** A queen being bitten, on the lower third and in the timeline. */
  underAttack: "under attack",
  /** A count mark's count, in the feed and tooltip: "ATTACK · 20 requested · 12 answered". */
  requested: "requested",
  /** Under a mark's detail when the recording carries no verb or count for it, and only then. */
  noDetails: "Command details unavailable in this recording",
  /** A lead change: the lower third's words, and the timeline's, which tells it as past (historical events read as past). */
  takesLead: "Takes the territory lead",
  tookLead: "Took the territory lead",
} as const;

/**
 * The score panel's words, in one place: the countdown chip's
 * label (its words with the figure are territoryWinText's), the living row's cap mark (its castes' nouns are the Rules
 * page's "soldier" and "worker"), each row's label, the hatched-and-lost row's label, and a colony card's ledger, where every term of alive = started with + hatched − lost
 * shows, the cap beside alive. Every number in them comes from the stream.
 */
export const SCORE_COPY = {
  /** The countdown chip's label, before its figure ("win in m:ss": a label and a figure, no sentence). */
  winIn: "win in",
  /** A sustained lead due after the final simulation step counts down to time-up, not a territory victory. */
  matchEndsIn: "match ends in",
  /** Beside a colony's ants alive once they reach the stream's cap (the alive figure with "full" at the cap). */
  full: "full",
  /** In a fallen queen's slot in the queens row (a fallen queen's slot reads "lost"). */
  queenLost: "lost",
  /** Each row's label (every row labelled, "Territory held" gone): inside the territory bar and the
   * living ants' bar, and between the two colonies' queens on their slots' line. */
  territory: "Territory",
  ants: "Ants",
  queens: "Queens",
  /** The hatched-and-lost row's one label, between its mirrored figures. */
  hatchedLost: "hatched · lost",
  startedWith: "Started",
  hatched: "Hatched",
  lost: "Lost",
  aliveNow: "Alive",
  /** The ledger's last row: the stream's colony cap. */
  max: "Cap",
} as const;

/** All queens share one deadline measured from match start, never their founding tick. */
export function queenSafety(tick: number, tps: number, config: Pick<SimConfig, "overrunGraceTicks" | "ticksPerSecond"> = PUBLIC_CONFIG): string {
  const graceSeconds = config.overrunGraceTicks / config.ticksPerSecond;
  return tick / tps < graceSeconds ? `protected until ${clockTime(config.overrunGraceTicks, config.ticksPerSecond)}` : "safe";
}

/** First contact is not a spectator event; old recording data stays compatible. */
export function visibleStory(story: readonly StoryEntry[]): StoryEntry[] {
  return story.filter((entry) => entry.kind !== "contact");
}

/** Match time m:ss for a number of ticks. */
export function clockTime(ticks: number, tps: number): string {
  const s = Math.max(0, Math.floor(ticks / tps));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The bug's clock at playback tick `tick`: the match time reached, and the time
 * left until time-up (the briefing's "time left"), counted down from the match
 * length the stream's setup carries. Once the match has ended there is no time
 * left: "ended" stands beside the final match time, and the result says how.
 */
export function matchClock(tick: number, setup: Pick<StreamSetup, "ticksPerSecond" | "matchTicks">, ended: boolean): { elapsed: string; left: string } {
  const tps = setup.ticksPerSecond || 10;
  const elapsed = clockTime(Math.min(tick, setup.matchTicks), tps);
  if (ended) return { elapsed, left: PAGE_COPY.ended };
  // Whole seconds left, rounded up, so the clock reads 0:00 only at time-up.
  const leftTicks = Math.max(0, setup.matchTicks - tick);
  const left = clockTime(Math.ceil(leftTicks / tps) * tps, tps);
  return { elapsed, left: `${left} time left` };
}

/** Whether an overrun attempt, or an attack on a queen with HP, is still under way at playback tick now. */
export function underWay(e: StoryEntry, now: number): boolean {
  return (e.kind === "overrun" || e.kind === "queen_attack") && (e.endTick === undefined || e.endTick > now);
}

/**
 * The lower third holds an event this many match seconds after it happened (an attempt's or an attack's
 * ending: after its end), then clears (a stale caption must clear
 * after a few seconds); an attempt under way stays as long as it lasts.
 */
export const LOWER_THIRD_S = 8;

/**
 * The one significant event the lower third shows: an overrun attempt, or an attack on a queen,
 * under way (the newest, if both queens are under attack), since a queen can fall at once;
 * otherwise the entry whose moment (its tick, or an attempt's end) is the latest playback has
 * reached, while that moment is less than LOWER_THIRD_S ago. Null before first contact, and
 * once the latest moment is older than that.
 */
export function significant(story: readonly StoryEntry[], now: number, tps = 10): StoryEntry | null {
  for (let i = story.length - 1; i >= 0; i--) if (underWay(story[i]!, now)) return story[i]!;
  let best: StoryEntry | null = null;
  for (const e of visibleStory(story)) {
    const at = e.endTick ?? e.tick;
    if (now < at + LOWER_THIRD_S * tps && (best === null || at >= (best.endTick ?? best.tick))) best = e;
  }
  return best;
}

/**
 * How the match ended, as the result card labels it under the winner (labels, not sentences):
 * the ends this client knows by name, and any other end main may add (an early end with one side
 * clearly ahead) by the stream's own name for it, with what it was decided on; such an end is never told as a
 * colony falling.
 */
export function resultHow(r: { reason: StreamResult["reason"] | string; decidedBy: StreamResult["decidedBy"] | string }, multipleQueens: boolean): string {
  const reason: string = r.reason;
  const on = r.decidedBy.replace(/_/g, " ");
  switch (reason) {
    case "queens_killed":
      return r.decidedBy === "queens_killed" ? "Queens killed" : `Queens killed on both sides · decided on ${on}`;
    case "overrun":
      return multipleQueens ? "Last queen overrun" : "Queen overrun";
    case "double_overrun":
      return `${multipleQueens ? "Both last queens fell" : "Both queens fell"}${r.decidedBy === "draw" ? "" : ` · decided on ${on}`}`;
    case "abandoned":
      return "Seat inactive · unrated";
    case "idle":
      return r.decidedBy === "draw" ? "Seats inactive on both sides" : "Seat inactive";
    case "time_up":
      return `Time-up · decided on ${on}`;
    case "sustained_territory":
      return "Sustained territory lead";
    default: {
      const name = reason.replace(/_/g, " ");
      const label = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      return reason === r.decidedBy ? label : `${label} · decided on ${on}`;
    }
  }
}

/**
 * The entries that decided a finished match: the attempts, or the attacks on a queen with HP,
 * that took a queen, or at time-up the last lead change (the lead that held). Empty for a draw on
 * time, and for an end that took no queen and was not time-up.
 */
export function decisive(story: readonly StoryEntry[], reason: string, winner: 0 | 1 | null): StoryEntry[] {
  const took = story.filter((e) => (e.kind === "overrun" || e.kind === "queen_attack") && e.outcome === "took");
  if (took.length > 0) return took;
  if (reason !== "time_up" || winner === null) return [];
  for (let i = story.length - 1; i >= 0; i--) if (story[i]!.kind === "lead") return story[i]!.colony === winner ? [story[i]!] : [];
  return [];
}

/**
 * The briefing's win rules, word for word, with the numbers of this match where
 * the stream carries them: its "How to win:" heading and the queen overrun and
 * territory rules that follow it.
 */
export function winRules(setup: Pick<StreamSetup, "ticksPerSecond" | "matchTicks" | "overrunRadiusTiles">, overrunRequired: number, multipleQueens = false): { heading: string; rules: string[] } {
  const text = briefing({ ...withGridScale(DEFAULT_CONFIG), ticksPerSecond: setup.ticksPerSecond, matchTicks: setup.matchTicks, overrunRadiusTiles: setup.overrunRadiusTiles, overrunTicks: overrunRequired, ...(multipleQueens ? { queenFounding: QUEEN_RULES } : {}) });
  const lines = text.split("\n");
  const at = lines.indexOf("How to win:");
  const rules = lines.slice(at + 1).filter((l) => l.startsWith("- Queen overrun:") || l.startsWith("- Territory:")).map((l) => l.slice(2));
  return { heading: lines[at]!.replace(/:$/, ""), rules };
}
