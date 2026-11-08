/**
 * The match's story as the page tells it (web/src/story.ts):
 * the bug's clock, the lower third's one significant event, the finale's
 * deciding moments, and the win rules quoted from the briefing.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { briefing } from "../../src/mcp/briefing.ts";
import type { StreamMessage, StreamResult } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, type StoryEntry } from "../../web/src/buffer.ts";
import { LOWER_THIRD_S, OPEN_COPY, PAGE_COPY, SCORE_COPY, INSPIRED_BY_URL, decisive, matchClock, resultHow, significant, winRules, queenSafety, visibleStory } from "../../web/src/story.ts";
import { playable } from "../playable.ts";

// The stream carries the playable (grid scale 2) match config's overrun radius.
const setup = { ticksPerSecond: DEFAULT_CONFIG.ticksPerSecond, matchTicks: DEFAULT_CONFIG.matchTicks, overrunRadiusTiles: playable(DEFAULT_CONFIG).overrunRadiusTiles };

function entry(id: number, kind: StoryEntry["kind"], tick: number, extra: Partial<StoryEntry> = {}): StoryEntry {
  return { id, kind, tick, colony: 0, agent: -1, x: 10, y: 10, ...extra };
}

describe("the clock", () => {
  // Regression caught: a clock read from anything but the playback tick, or a time left that does not add up to the match length.
  it("reads the playback tick: the match time reached and the time left until time-up", () => {
    expect(matchClock(0, setup, false)).toEqual({ elapsed: "0:00", left: "30:00 time left" });
    expect(matchClock(3585, setup, false)).toEqual({ elapsed: "5:58", left: "24:02 time left" });
    expect(matchClock(17999, setup, false).left).toBe("0:01 time left");
    expect(matchClock(18000, setup, false).left).toBe("0:00 time left");
  });

  // Regression caught: a finished match still reading "0:00 time left", or its final time without
  // "ended".
  it("once the match has ended, shows the final match time and \"ended\", no time left", () => {
    expect(matchClock(5741, setup, true)).toEqual({ elapsed: "9:34", left: "ended" });
    expect(matchClock(18000, setup, true)).toEqual({ elapsed: "30:00", left: "ended" });
  });
});

describe("the one significant event", () => {
  // Regression caught: a queen under attack hidden behind the lead changes that keep coming during the attempt.
  it("an overrun attempt under way leads, even over a later lead change", () => {
    const attempt = entry(2, "overrun", 3000, { colony: 1, peak: 10, required: 100 });
    const lead = entry(3, "lead", 3200);
    expect(significant([entry(1, "contact", 600), attempt, lead], 3300)).toBe(attempt);
  });

  it("an attempt whose end playback has reached gives way to the newest entry", () => {
    const attempt = entry(2, "overrun", 3000, { colony: 1, endTick: 3100, outcome: "repelled", peak: 40, required: 100 });
    const lead = entry(3, "lead", 3200);
    expect(significant([attempt, lead], 3250)).toBe(lead);
    // Before playback reaches its end, it is still under way; just after it, its ending is the latest moment.
    expect(significant([attempt], 3050)).toBe(attempt);
    expect(significant([attempt, entry(3, "lead", 3080)], 3150)).toBe(attempt);
  });

  // Regression caught: "17:43 Queen 3 founded" still captioning the board at 20:08.
  it("clears a few seconds after the event, so the lower third never goes stale; an attempt under way stays as long as it lasts", () => {
    const founded = entry(4, "queen_founded", 10_630, { queenId: 2 });
    expect(LOWER_THIRD_S).toBeGreaterThanOrEqual(5);
    expect(LOWER_THIRD_S).toBeLessThanOrEqual(10);
    expect(significant([founded], 10_630)).toBe(founded);
    expect(significant([founded], 10_630 + LOWER_THIRD_S * 10 - 1)).toBe(founded);
    expect(significant([founded], 10_630 + LOWER_THIRD_S * 10)).toBeNull();
    expect(significant([founded], 12_080)).toBeNull();
    // At another tick rate the hold is the same number of seconds.
    expect(significant([founded], 10_630 + LOWER_THIRD_S * 20 - 1, 20)).toBe(founded);
    expect(significant([founded], 10_630 + LOWER_THIRD_S * 20, 20)).toBeNull();
    // An attempt's ending holds for the same time after its end, not its start.
    const attempt = entry(5, "overrun", 3000, { colony: 1, endTick: 3100, outcome: "repelled", peak: 40, required: 100 });
    expect(significant([attempt], 3100 + LOWER_THIRD_S * 10 - 1)).toBe(attempt);
    expect(significant([attempt], 3100 + LOWER_THIRD_S * 10)).toBeNull();
    // Under way, it stays however long it runs.
    expect(significant([entry(6, "overrun", 3000, { colony: 1, peak: 10, required: 100 })], 9000)).not.toBeNull();
  });

  it("is nothing before first contact", () => {
    expect(significant([], 0)).toBeNull();
  });
});

describe("the finale's deciding moments", () => {
  it("are the attempts that took a queen", () => {
    const took = entry(4, "overrun", 5600, { colony: 1, endTick: 5741, outcome: "took" });
    expect(decisive([entry(1, "contact", 600), entry(2, "lead", 900, { colony: 1 }), took], "overrun", 1)).toEqual([took]);
  });

  it("at time-up, the winner's last lead change; nothing for a draw", () => {
    const lead = entry(5, "lead", 6000, { colony: 0 });
    expect(decisive([entry(2, "lead", 900, { colony: 1 }), lead], "time_up", 0)).toEqual([lead]);
    expect(decisive([lead], "time_up", null)).toEqual([]);
  });

  // Regression caught: an end this client does not know (an early end main may add) told as a colony falling.
  it("for an end that took no queen and was not time-up, nothing: no attempt or attack is told as taking a queen", () => {
    const lead = entry(5, "lead", 6000, { colony: 0 });
    const attack = entry(6, "queen_attack", 6100, { colony: 1, queenId: 0, endTick: 6200, outcome: "unfinished", lowHp: 12_000 });
    expect(decisive([lead, attack], "early_end" as StreamResult["reason"], 0)).toEqual([]);
  });
});

describe("how the match ended, under the winner", () => {
  const r = (reason: string, decidedBy: string) => ({ reason, decidedBy }) as Pick<StreamResult, "reason" | "decidedBy">;
  it("labels the ends it knows, no sentences", () => {
    expect(resultHow(r("queens_killed", "queens_killed"), true)).toBe("Queens killed");
    expect(resultHow(r("queens_killed", "ants_alive"), true)).toBe("Queens killed on both sides · decided on ants alive");
    expect(resultHow(r("overrun", "overrun"), false)).toBe("Queen overrun");
    expect(resultHow(r("overrun", "overrun"), true)).toBe("Last queen overrun");
    expect(resultHow(r("double_overrun", "draw"), false)).toBe("Both queens fell");
    expect(resultHow(r("time_up", "territory"), true)).toBe("Time-up · decided on territory");
    // The sustained-territory early end (main's 069957e); the stills' early-end scene reads the same label.
    expect(resultHow(r("sustained_territory", "territory"), true)).toBe("Sustained territory lead");
  });

  // Regression caught: a reason the client does not know read as time-up, or as a queen taken.
  it("says an end it does not know in the words the stream names it by, with what it was decided on, never as a fall", () => {
    expect(resultHow(r("early_end", "territory"), true)).toBe("Early end · decided on territory");
    expect(resultHow(r("early_end", "early_end"), true)).toBe("Early end");
    for (const how of [resultHow(r("early_end", "territory"), true), resultHow(r("early_end", "early_end"), false)]) {
      expect(how).not.toMatch(/queen|fell|overrun|time-up/);
    }
  });

  it("leaves an overrun attempt open at such an end unfinished, not taken", () => {
    const ants = { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) };
    const full: StreamMessage["full"] = { setup: { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2, queens: [[16, 16], [100, 100]] }, territory: new Uint8Array(64), marks: [], agents: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null };
    const end = (reason: string, winner: 0 | 1 | null): StreamResult => ({ winner, reason: reason as StreamResult["reason"], decidedBy: "territory", tick: 30, nextStartMs: null });
    const play = (result: StreamResult) => {
      const p = new Playback();
      p.push({ tick: 0, ants, full, events: [] }, 0);
      p.push({ tick: 10, ants, full: null, events: [{ kind: "overrun", colony: 1, progress: 40, required: 100 }] }, 1000);
      p.push({ tick: 31, ants, full: null, events: [{ kind: "end", result }] }, 3100);
      const f = new Frame();
      p.sample(31 * TICK_MS + 1000, f);
      return f.story.find((e) => e.kind === "overrun")!;
    };
    expect(play(end("early_end", 0))).toMatchObject({ colony: 0, endTick: 31, outcome: "unfinished", peak: 40 });
    expect(play(end("time_up", 0)).outcome).toBe("unfinished");
    expect(play(end("overrun", 0))).toMatchObject({ outcome: "took", peak: 100 });
    expect(play(end("overrun", 1)).outcome).toBe("repelled");
  });
});

describe("the win rules", () => {
  // Regression caught: the page's win copy drifting from the rules the agents are briefed with.
  it("quote the briefing's queen overrun and territory rules word for word, under its heading", () => {
    const { heading, rules } = winRules(setup, DEFAULT_CONFIG.overrunTicks);
    expect(heading).toBe("How to win");
    const lines = briefing(playable(DEFAULT_CONFIG)).split("\n");
    expect(rules).toEqual(lines.filter((l) => l.startsWith("- Queen overrun:") || l.startsWith("- Territory:")).map((l) => l.slice(2)));
    expect(rules).toHaveLength(2);
    expect(rules[1]).toContain("At time-up (30 minutes)");
  });

  it("carry this match's numbers where the stream gives them", () => {
    const { rules } = winRules({ ...setup, overrunRadiusTiles: 3 }, 50);
    expect(rules[0]).toContain("within 3 tiles of a queen for 5 s");
  });
});

describe("the page's own words", () => {
  it("uses the inspiration tweet", () => {
    expect(INSPIRED_BY_URL).toBe("https://x.com/LambethEthan/status/2108791452163875012");
  });
  it("are the fixed name, credit and premise, verbatim", () => {
    expect(PAGE_COPY.name).toBe("Antwars");
    expect(PAGE_COPY.credit).toBe("Built with Zobrist");
    // No premise on the page: the wordmark and the credit only.
    expect(PAGE_COPY).not.toHaveProperty("premise");
  });

  // Regression caught: a settled label drifting back to a rejected one ("Overview", "Locate").
  it("name the board controls as settled", () => {
    expect([PAGE_COPY.zoomOut, PAGE_COPY.zoomIn, PAGE_COPY.wholeBoard]).toEqual(["Zoom out", "Zoom in", "Whole board"]);
  });
});

// Moved from the retired dock.test.ts: the copy constants the visible HUD and the board's mark words read.
describe("the page's copy constants", () => {
  // "Ants outside squads" (with what they carry) and "Biting" are cut from the page in every state.
  it("keep the cut words out", () => {
    expect(Object.values(OPEN_COPY).filter((t) => /outside squads|carrying food|biting|near the queen/i.test(t))).toEqual([]);
  });

  // Capitals in either bar's label would widen "Territory · win in m:ss" past the room its fit allows.
  it("name both bars in sentence case", () => {
    expect([SCORE_COPY.territory, SCORE_COPY.ants]).toEqual(["Territory", "Ants"]);
  });
});

describe("queen protection", () => {
  const config = { ...DEFAULT_CONFIG, ticksPerSecond: 10, overrunGraceTicks: 7200 };
  it("derives the label from config, including nondefault tick rates and windows", () => {
    expect(queenSafety(0, 10, config)).toBe("protected until 12:00");
    expect(queenSafety(7199, 10, config)).toBe("protected until 12:00");
    expect(queenSafety(7200, 10, config)).toBe("safe");
    expect(queenSafety(8100, 10, config)).toBe("safe");
    expect(queenSafety(7199, 20, { ...config, ticksPerSecond: 20 })).toBe("protected until 6:00");
    expect(queenSafety(7200, 20, { ...config, ticksPerSecond: 20 })).toBe("safe");
  });
});

describe("visible events", () => {
  it("omits first contact from the timeline and significant-event selection, including old recordings", () => {
    const contact = entry(1, "contact", 600);
    expect(visibleStory([contact])).toEqual([]);
    expect(significant([contact], 700)).toBeNull();
    const lead = entry(2, "lead", 650);
    expect(visibleStory([lead, contact])).toEqual([lead]);
    expect(significant([lead, contact], 700)).toBe(lead);
  });
});

it("shows kills as the deciding criterion for time-up and both simultaneous queen-loss endings", () => {
  expect(resultHow({ reason: "time_up", decidedBy: "kills" }, true)).toBe("Time-up · decided on kills");
  expect(resultHow({ reason: "double_overrun", decidedBy: "kills" }, true)).toBe("Both last queens fell · decided on kills");
  expect(resultHow({ reason: "queens_killed", decidedBy: "kills" }, true)).toBe("Queens killed on both sides · decided on kills");
});

it("labels an abandoned match as idle and unrated rather than a time-up decision", () => {
  expect(resultHow({ reason: "abandoned", decidedBy: "draw" }, true)).toBe("Seat inactive · unrated");
  expect(decisive([], "abandoned", null)).toEqual([]);
});
