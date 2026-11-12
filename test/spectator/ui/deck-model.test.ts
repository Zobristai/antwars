// The 3D board's HUD, the Instrument deck (ported): what the deck reads from a frame
// and the page's mode line. Unit data only; visual evidence comes from the served build's captures, never these tests.
import { describe, expect, it } from "vitest";
import { Frame, type Board, type CommandEntry, type StoryEntry } from "../../../web/src/buffer.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { modeCopy, setFallback, type Fallback } from "../../../web/src/replay.ts";
import { linkLine, modelLine } from "../../../web/src/compose.ts";
import { MODEL_LABEL, agentCard } from "../../../web/src/overlays.ts";
import { recordedIdentity } from "../../../web/src/pages/model.ts";
import { squadTipText } from "../../../web/src/squads.ts";
import { agentEntries } from "../../../web/src/ui/hud-model.ts";
import {
  D1_COPY, arrival, arrivalRows, balance, caption, clock, colonyName, colonyNote, dials, eloText, history, isBenchmark, legend, mapName, resultView, roster, rowName, selected,
  shareText, teamPlayer,
  winConditions, type ModeText,
} from "../../../web/src/ui/deck/model.ts";

const TICK = 7540;
const NBSP = "\u00a0";

function queen(id: number, colony: 0 | 1, tile: number, hp: number | undefined, lostTick: number | null = null, overrun = 0): StreamQueen {
  return { id, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: id * 3000, lostTick, overrun, ...(hp === undefined ? {} : { hp }) };
}

function agent(colony: 0 | 1, name: string | null, elo: number, model: string, order: StreamAgent["order"] = "forage", orderX = 0, orderY = 0, lastCommandTick = TICK - 30): StreamAgent {
  return { ...(name === null ? {} : { identity: { displayName: name, elo } }), colony, modelLabel: model, joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick, order, orderX, orderY, intent: "" };
}

/** A ranked 4v4 at 12:34 on the redesign rules: one player holds every seat of each colony. */
function frameOf(edit: (b: Board, f: Frame) => void = () => {}): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100;
  const castes: [number, number][] = [[180, 32], [150, 30]];
  const n = castes.flat().reduce((a, b) => a + b, 0);
  f.ensure(n); f.count = n;
  let i = 0;
  for (const c of [0, 1] as const) for (let k = 0; k < castes[c]![0] + castes[c]![1]; k++, i++) { f.colony[i] = c; f.caste[i] = k < castes[c]![0] ? 0 : 1; f.agent[i] = -1; }
  const agents = [
    ...[1, 2, 3, 4].map(seat => agent(0, `fennec/forager #${seat}`, 1512.37, "anthropic/claude-sonnet-5-5")),
    ...[1, 2, 3, 4].map(seat => agent(1, `tidewater #${seat}`, 1488.6, "openai/gpt-6-luna")),
  ];
  agents[0] = agent(0, "fennec/forager #1", 1512.37, "anthropic/claude-sonnet-5-5", "attack", 50, 20);
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: true, rules: "redesign" },
    territoryWin: { colony: 0, startTick: TICK - 2200, winTick: TICK + 799 },
    queens: [queen(0, 0, 8, 40000), queen(1, 0, 14, 40000), queen(2, 0, 20, 22000), queen(0, 1, 50, 40000), queen(1, 1, 44, 0, 6470)],
    territory: new Uint8Array(0), held: [870, 130], marks: [], agents, overrun: [0, 0], overrunRequired: 100, deaths: [31, 48],
    result: null, food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 57, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 2, nextHatchTick: TICK - 10, nextCost: 6 }],
  };
  f.board = b;
  edit(b, f);
  return f;
}

const live: ModeText = { label: "LIVE · rated match", detail: `300${NBSP}s behind the match` };
/** The board's own line for each mode (replay.ts modeCopy), as the 3D page hands it to the HUD. */
const STORED = "2026-10-25T18-00-00-000Z-2";
function copyOf(mode: "live" | "replay", agents: number, stand: Fallback | null = null, storedId: string | null = null) {
  setFallback(stand);
  try { return modeCopy(mode, agents, false, "/", storedId, true, 300); } finally { setFallback(null); }
}

describe("the frame's legend", () => {
  it("reads the page's mode line, wording the delay as policy, and says the rule again as a solid line (live)", () => {
    expect(legend(true, 8, "", copyOf("live", 8), false)).toEqual({ dot: "live", words: ["LIVE", "rated match", `300${NBSP}s policy delay`], rule: "solid", back: null });
    expect(legend(true, 8, "", live, false).words).toEqual(["LIVE", "rated match", `300${NBSP}s policy delay`]);
  });
  it("says No agents from the frame shown, before the delay, once, and leaves the recording's offer to the footer (live, no agents)", () => {
    expect(legend(true, 0, "", copyOf("live", 0), false)).toEqual({ dot: "live", words: ["LIVE", "rated match", "No agents", `300${NBSP}s policy delay`], rule: "solid", back: null });
    expect(legend(true, 0, "", live, false).words).toEqual(["LIVE", "rated match", "No agents", `300${NBSP}s policy delay`]);
  });
  it("dashes the rule while playback has run out of data, from the board's own underrun (stalled)", () => {
    expect(legend(true, 8, "", copyOf("live", 8), true)).toMatchObject({ rule: "dashed", words: ["LIVE", "rated match", `300${NBSP}s policy delay`, "Waiting for new data"] });
  });
  it("dashes the rule for a reconnect and leaves out Match ended, which the clock says (reconnecting)", () => {
    expect(legend(true, 8, linkLine("reconnecting", false), copyOf("live", 8), false)).toMatchObject({ rule: "dashed", words: ["LIVE", "rated match", `300${NBSP}s policy delay`, "Reconnecting…"] });
    expect(legend(true, 8, linkLine("open", true), copyOf("live", 8), false)).toMatchObject({ rule: "solid", words: ["LIVE", "rated match", `300${NBSP}s policy delay`] });
  });
  it("doubles the rule for a stored stand-in with its reason, rating, the agents shown and its date (recording, stored)", () => {
    expect(legend(true, 3, "", copyOf("replay", 4, "idle", STORED), false)).toEqual({ dot: "recording", words: ["RECORDING", "no live match", "rated match", "3 agents", "25 Oct 2026"], rule: "double", back: null });
  });
  // The bundled legacy recording and its "older rules" label are deleted: no stand-in or replay says it.
  it("doubles the rule for a stand-in with its reason and rating, never older rules (recording, no stored date)", () => {
    expect(legend(true, 4, "", copyOf("replay", 4, "starting"), false)).toEqual({ dot: "recording", words: ["RECORDING", "live match starting", "rated match", "4 agents"], rule: "double", back: null });
  });
  it("offers Back to live on an explicit stored replay, as today's HUD does, never older rules", () => {
    expect(legend(true, 4, "", copyOf("replay", 4, null, STORED), false)).toEqual({ dot: "recording", words: ["RECORDING", "not live", "rated match", "4 agents", "25 Oct 2026"], rule: "double", back: { text: "Back to live", href: "/?watch=1" } });
  });
  it("draws a hairline while connecting or with no match, with no stall before a frame (connecting, no match)", () => {
    expect(legend(false, null, linkLine("connecting", false), null, true)).toEqual({ dot: null, words: ["Connecting…"], rule: "hairline", back: null });
    expect(legend(false, null, "", null, false)).toEqual({ dot: null, words: ["No live match"], rule: "hairline", back: null });
  });
});

describe("the deck", () => {
  it("reads the clock, and ended once the stream carries the result", () => {
    expect(clock(null)).toBe("—");
    expect(clock(frameOf())).toBe("12:34 · 17:26 left");
    expect(clock(frameOf(b => { b.result = { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK, nextStartMs: null }; }))).toBe("12:34 · ended");
  });
  it("fills each half-track with the colony's share from its own end, the 6:1 line only where the rules give one", () => {
    const bal = balance(frameOf());
    expect(bal.kills.figures).toEqual(["48", "31"]);
    expect(bal.kills.fill[0]).toBeCloseTo(60.76, 1);
    expect(bal.territory.figures).toEqual(["87%", "13%"]);
    expect(bal.lead).toBeCloseTo(85.71, 1);
    expect(balance(frameOf(b => { delete b.setup.rules; b.queens = b.queens!.map(q => ({ ...q, hp: undefined })); })).lead).toBeNull();
    expect(balance(null)).toMatchObject({ kills: { figures: ["—", "—"] }, lead: null });
  });
  it("totals each colony's living ants, as the economy's Ants cell counts them, filled to its share", () => {
    const bal = balance(frameOf());
    expect(bal.ants.figures).toEqual(["212", "180"]);
    expect(bal.ants.fill[0]).toBeCloseTo(54.08, 1);
    expect(bal.ants.fill[1]).toBeCloseTo(45.92, 1);
    const [vlc, lhc] = dials(frameOf());
    expect([vlc.ants, lhc.ants]).toEqual([`${bal.ants.figures[0]}/512`, `${bal.ants.figures[1]}/512`]);
    expect(balance(frameOf((_, f) => { f.count = 0; })).ants).toEqual({ figures: ["0", "0"], fill: [0, 0] });
    expect(balance(null).ants).toEqual({ figures: ["—", "—"], fill: [0, 0] });
  });
  it("explains the 6:1 line in plain words while it shows, and never names where a value comes from", () => {
    expect(balance(frameOf()).leadText).toBe("Dotted line: a 6:1 territory lead, which ends the match early if held");
    expect(balance(frameOf(b => { delete b.setup.rules; b.queens = b.queens!.map(q => ({ ...q, hp: undefined })); })).leadText).toBe("");
    expect(balance(frameOf(b => { b.result = { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK, nextStartMs: null }; })).leadText).toBe("");
    expect(balance(null).leadText).toBe("");
    expect(Object.keys(D1_COPY)).not.toContain("dotted");
    const words = Object.values(D1_COPY).map(v => (typeof v === "function" ? v("6") : v)).join("\n");
    expect(words).not.toMatch(/stream|this page|rules this page knows|placeholder/i);
  });
  it("keeps a lamp per queen, a lost one marked lost, her HP against the rules' maximum, and rings one under attack", () => {
    const story: StoryEntry[] = [{ id: 1, kind: "queen_attack", queenId: 2, tick: TICK - 10, colony: 0, agent: -1, x: 20, y: 20 }];
    const win = winConditions(frameOf((_, f) => { f.story = story; }));
    expect(win.standing).toEqual(["3", "1"]);
    expect(win.lamps[0].map(l => [l.hp, l.attacked, l.inferred])).toEqual([["40", false, true], ["40", false, true], ["22", true, true]]);
    expect(win.lamps[0][2]!.fill).toBeCloseTo(0.55, 2);
    expect(win.lamps[1].map(l => l.lost)).toEqual([false, true]);
    expect(win.lamps[1][1]!.label).toBe("Lake Hodges Colony Queen 2: lost");
    expect(win.lamps[0][2]!.label).toBe("Very Large Colony Queen 3: 22 HP, under attack");
  });
  it("fills a lamp without HP with her safety from overrun, the stream's own figures, and no inferred maximum", () => {
    const win = winConditions(frameOf(b => { delete b.setup.rules; b.queens = [queen(0, 0, 8, undefined), queen(0, 1, 50, undefined, null, 25)]; }));
    expect(win.lamps[1][0]).toMatchObject({ hp: "", fill: 0.75, attacked: true, inferred: false, label: "Lake Hodges Colony Queen 1: overrun 25%, under attack" });
  });
  it("shows the hold on the holder's side only, its ring in quarters and its time to win", () => {
    const win = winConditions(frameOf());
    expect(win.hold).toEqual([{ fill: 0.5, text: "win in 1:20" }, null]);
    expect(win.holdText).toBe("Very Large Colony · win in 1:20");
    expect(winConditions(frameOf(b => { b.territoryWin = undefined; })).hold).toEqual([null, null]);
  });
  it("counts each colony's castes, its food short of the next ant, and its ants over the cap", () => {
    const [vlc, lhc] = dials(frameOf());
    expect([vlc.workers, vlc.soldiers, vlc.food, vlc.ants]).toEqual(["180", "32", "57", "212/512"]);
    expect([lhc.food, lhc.ants]).toEqual(["2/6", "180/512"]);
    expect(lhc.next).toEqual({ kind: "food" });
    expect(vlc.next).toMatchObject({ kind: "waiting", caste: "worker" });
    expect(vlc.next).not.toHaveProperty("text");
    expect(lhc.nextText).toContain("needs 6 food, has 2");
    expect(dials(frameOf(b => { b.hatch = null; }))[0].ants).toBe("212");
  });
  it("reads a hatch due now as the full ring at no wait, never a word", () => {
    const [vlc] = dials(frameOf(b => { b.stores = [{ food: 57, nextHatchTick: TICK, nextCost: 3 }, b.stores[1]]; }));
    expect(vlc.next).toEqual({ kind: "waiting", fill: 1, caste: "worker" });
  });
});

describe("a match's own colony names", () => {
  const drawn = ["Kobe A Colony", "Catalonian Colony"] as const;
  it("names the colonies as the match carries them in the caption, result, roster and share text, with each name's source note", () => {
    const story: StoryEntry[] = [{ id: 1, kind: "queen_attack", queenId: 2, tick: TICK - 10, colony: 0, agent: -1, x: 20, y: 20 }];
    expect(caption(frameOf((b, f) => { b.setup = { ...b.setup, rated: false, colonyNames: drawn }; f.story = story; }))!.who).toBe("Kobe A Colony");
    const ended = frameOf((b, f) => {
      b.setup = { ...b.setup, rated: false, colonyNames: drawn };
      b.result = { winner: 1, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK - 100, nextStartMs: null };
      f.targetMs = TICK * 100 + 10_000;
    });
    expect(resultView(ended)!.headline).toBe("Catalonian Colony wins");
    expect(roster(frameOf(b => { b.setup = { ...b.setup, colonyNames: drawn }; })).groups.map(g => g.heading.split(" · ")[0])).toEqual([...drawn]);
    // A side with no named player is named by its colony, as the match names it.
    const shared = shareText(frameOf((b, f) => {
      b.setup = { ...b.setup, colonyNames: drawn }; b.agents = b.agents.filter(a => a.colony === 0);
      b.result = { winner: 1, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK - 100, nextStartMs: null };
      f.targetMs = TICK * 100 + 10_000;
    }), "https://example.test/r");
    expect(shared).toMatch(/^Catalonian Colony beat /);
    expect(colonyName(0, { colonyNames: drawn })).toBe("Kobe A Colony");
    expect(colonyNote(1, { colonyNames: drawn })).toBe("Eastern Spain (Giraud, Pedersen and Keller 2002, PNAS)");
  });
  it("keeps the rated names, shown as they were with no note, where the match carries none", () => {
    expect([colonyName(0), colonyName(1), colonyName(0, {})]).toEqual(["Very Large Colony", "Lake Hodges Colony", "Very Large Colony"]);
    expect([colonyNote(0), colonyNote(1), colonyNote(1, {})]).toEqual(["", "", ""]);
    expect(colonyNote(1, { colonyNames: ["Sweetwater Colony", "Lake Hodges Colony"] })).toBe("Southern California, about 11 km² (Thomas et al. 2006, Molecular Ecology)");
  });
});

describe("the lane and the result", () => {
  it("captions the one event without the HP tail the lamp shows", () => {
    const story: StoryEntry[] = [{ id: 1, kind: "queen_attack", queenId: 2, tick: TICK - 10, colony: 0, agent: -1, x: 20, y: 20 }];
    expect(caption(frameOf((_, f) => { f.story = story; }))).toEqual({ kind: "event", colony: 0, when: "12:33", what: "Queen 3 under attack", who: "Very Large Colony" });
    expect(caption(frameOf())).toBeNull();
  });
  it("captions a colony's fall large, then nothing once the result shows", () => {
    const fall = frameOf(b => { b.queens = [...b.queens!.slice(0, 3), queen(0, 1, 50, 0, TICK - 5), queen(1, 1, 44, 0, 6470)]; });
    expect(caption(fall)).toEqual({ kind: "fall", colony: 1, when: "", what: "Queen 1 lost", who: "Lake Hodges Colony · 12:33" });
    const shown = frameOf((b, f) => { b.result = { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK - 100, nextStartMs: null }; f.targetMs = TICK * 100 + 10_000; });
    expect(caption(shown)).toBeNull();
  });
  it("tells the winner, how, the rating changes, the decisive moments and the next start once the result shows", () => {
    const changes = [{ agent: 0, before: 1512.37, after: 1527.15 }];
    const story: StoryEntry[] = [{ id: 3, kind: "queen_attack", queenId: 1, tick: 6200, endTick: 6470, outcome: "took", colony: 1, agent: -1, x: 44, y: 20 }];
    const f = frameOf((b, fr) => {
      b.result = { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK - 100, nextStartMs: null, ratingChanges: changes };
      fr.targetMs = TICK * 100 + 10_000; fr.story = story;
    });
    expect(resultView(f)).toEqual({
      headline: "Very Large Colony wins", winner: 0, how: "Queens killed",
      ratings: [{ name: "fennec/forager #1", badges: [], text: "Rating 1512 → 1527 (+15)" }],
      moments: [{ when: "10:47", what: "Queen 2 lost", who: "Lake Hodges Colony", colony: 1 }],
      next: "Next match · not announced",
    });
    expect(resultView(frameOf())).toBeNull();
  });
  it("names each rating line's player as the Leaderboard does, with a Benchmark name's level and Fast badges, never its antwars/ handle", () => {
    const f = frameOf((b, fr) => {
      b.agents = [agent(0, "antwars/gpt-6-luna", 1198.33, "openai/gpt-6-luna"), agent(1, "antwars/claude-opus-5-5 #2", 1500, "c"), agent(1, "tidewater", 1400, "x")];
      b.result = { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: TICK - 100, nextStartMs: null,
        ratingChanges: [{ agent: 0, before: 1198.33, after: 1144.46 }, { agent: 1, before: 1500, after: 1510 }, { agent: 2, before: 1400, after: 1400 }] };
      fr.targetMs = TICK * 100 + 10_000;
    });
    expect(resultView(f)!.ratings).toEqual([
      { name: "GPT-6 Luna", badges: ["max", "Fast"], text: "Rating 1198 → 1144 (-54)" },
      { name: "Claude Opus 5.5 #2", badges: ["high"], text: "Rating 1500 → 1510 (+10)" },
      { name: "tidewater", badges: [], text: "Rating 1400 → 1400 (0)" },
    ]);
    expect(JSON.stringify(resultView(f))).not.toContain("antwars/");
  });
});

describe("a team's game history", () => {
  const story: StoryEntry[] = [
    { id: 1, kind: "contact", tick: 3000, colony: 0, agent: 0, x: 30, y: 20 },
    { id: 2, kind: "lead", tick: 4200, colony: 1, agent: 5, x: 40, y: 20 },
    { id: 3, kind: "queen_attack", queenId: 2, tick: TICK - 10, colony: 0, agent: -1, x: 20, y: 20 },
  ];
  const cmd = (id: number, tick: number, agent: number, colony: 0 | 1, rest: Partial<CommandEntry> = {}): CommandEntry =>
    ({ id, tick, agent, colony, call: "order", accepted: true, ...rest });
  const commands: CommandEntry[] = [
    cmd(1, 2990, 0, 0, { order: { kind: "attack", tileX: 50, tileY: 20, intent: "take their queen" } }),
    cmd(2, 3000, 1, 0, { call: "observe" }),
    cmd(3, 3000, 2, 0, { call: "count_mark", mark: { id: 9, agent: 2, colony: 0, tileX: 12, tileY: 30, words: [], laidTick: 2999, answered: 0, verb: "FORAGE", count: 6 } }),
    cmd(4, 4300, 5, 1, { call: "order", accepted: false }),
    cmd(5, 4400, 6, 1, { call: "found_queen" }),
  ];
  const withAll = () => frameOf((_, fr) => { fr.story = story; fr.commands = commands; });
  const shape = (rows: ReturnType<typeof history>) => rows.map(r => [r.key, r.when, r.member?.index ?? null, r.what, r.intent, r.refused]);

  it("merges every command and every entry of its colony, newest first, each with its time and the member who acted", () => {
    const f = withAll();
    expect(shape(history(f, 0))).toEqual([
      ["s3", "12:33", null, "Queen 3 under attack", "", false],
      // Within one tick the event follows the command that led to it.
      ["s1", "5:00", 0, "First contact", "", false],
      ["c3", "5:00", 2, "FORAGE · 6 requested", "", false],
      ["c1", "4:59", 0, "attack Lake Hodges Colony's Queen 1", "“take their queen”", false],
    ]);
    expect(shape(history(f, 1))).toEqual([
      ["c5", "7:20", 6, "found a queen", "", false],
      ["c4", "7:10", 5, "order", "", true],
      ["s2", "7:00", 5, "Took the territory lead", "", false],
    ]);
    expect(history(null, 0)).toEqual([]);
  });

  it("ties a multi-agent team's rows to each member by its badge, and a 1v1's to its one agent", () => {
    const team = history(withAll(), 0);
    expect(new Set(team.map(r => r.member?.index).filter(i => i !== undefined))).toEqual(new Set([0, 2]));
    expect(team.find(r => r.key === "c3")!.member!.badge).toContain("<svg");
    expect(team.find(r => r.key === "c1")!.member!.name).toBe("fennec/forager #1");
    // A 1v1: the same rows, the one agent each, so the history shows in every match.
    const duel = frameOf((b, fr) => {
      b.agents = [b.agents[0]!, b.agents[4]!];
      fr.commands = [cmd(1, 2990, 0, 0), cmd(2, 3100, 1, 1, { call: "mark", mark: { id: 3, agent: 1, colony: 1, tileX: 1, tileY: 1, words: [0, 1], laidTick: 3099, answered: 0 } })];
    });
    expect(history(duel, 0).map(r => [r.member?.name, r.what])).toEqual([["fennec/forager #1", "order"]]);
    expect(history(duel, 1).map(r => r.member?.index)).toEqual([1]);
    expect(history(duel, 1)[0]!.glyph).toEqual({ kind: "mark", verb: undefined });
    // A Benchmark agent's rows name it by its display name, never its antwars/ handle.
    const benchmark = frameOf((b, fr) => {
      b.agents = [agent(0, "antwars/gpt-6-luna #1", 1500, "g"), b.agents[4]!];
      fr.commands = [cmd(1, 2990, 0, 0)];
    });
    expect(history(benchmark, 0).map(r => [r.member?.name, r.reading.includes("antwars/")])).toEqual([["GPT-6 Luna #1", false]]);
  });

  it("leaves an observe out (a board read, not a command) and keeps a refused command, marked", () => {
    const rows = history(withAll(), 0).concat(history(withAll(), 1));
    expect(rows.some(r => r.key === "c2")).toBe(false);
    const refused = rows.find(r => r.key === "c4")!;
    expect(refused.refused).toBe(true);
    expect(refused.reading).toBe(`7:10, tidewater #2: order, ${D1_COPY.refused}`);
  });

  it("reads each row whole for assistive technology, an order with its symbol and intent", () => {
    const order = history(withAll(), 0).find(r => r.key === "c1")!;
    expect(order.glyph).toEqual({ kind: "order", order: "attack", guard: false });
    expect(order.reading).toBe("4:59, fennec/forager #1: attack Lake Hodges Colony's Queen 1 “take their queen”");
    expect(history(withAll(), 0)[0]!.reading).toBe("12:33, Very Large Colony: Queen 3 under attack");
  });
});

describe("the team section's agents", () => {
  it("gives a one-player team no agent rows: its heading carries the player's line once, its member icons the player icons", () => {
    const r = roster(frameOf());
    expect(r.groups.map(g => [g.heading, g.player, g.rows.length])).toEqual([
      ["Very Large Colony · 4 agents", { name: "fennec/forager", model: "Claude Sonnet 5.5", badges: [], elo: "1512", rd: "", seats: 4, result: null }, 0],
      ["Lake Hodges Colony · 4 agents", { name: "tidewater", model: "GPT-6 Luna", badges: [], elo: "1489", rd: "", seats: 4, result: null }, 0],
    ]);
    expect(r.groups.map(g => g.members.map(m => m.index))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    expect(r.count).toBe(0);
  });
  it("gives every other team one small row per agent with its name, model and Rating, and nothing of its order or calls", () => {
    const r = roster(frameOf(b => { b.agents = [agent(0, "ana", 1600, "anthropic/claude-sonnet-5-5"), agent(0, "bo", 1500, ""), agent(1, "cy #1", 1400, "x"), agent(1, "cy #2", 1401, "x")]; }));
    expect(r.groups.map(g => g.player)).toEqual([null, null]);
    expect(r.groups[0]!.rows.map(row => [row.index, row.title, row.model, row.elo])).toEqual([[0, "ana", "Claude Sonnet 5.5", "1600"], [1, "bo", "", "1500"]]);
    expect(r.groups[1]!.rows.map(row => [row.title, row.elo])).toEqual([["cy #1", "1400"], ["cy #2", "1401"]]);
    expect(r.count).toBe(4);
    // The row's badge is the one its history rows and its member icon carry.
    expect(r.groups[0]!.rows[0]!.badge).toContain("<svg");
    const row = r.groups[0]!.rows[0]! as unknown as Record<string, unknown>;
    for (const gone of ["order", "latest", "idle"]) expect(row).not.toHaveProperty(gone);
    // A builder outside the Model Index: name, Rating and this match's model, with no asterisk and no thinking level.
    expect(r.groups[0]!.rows[0]!.label).toBe("ana · Rating 1600 · Very Large Colony · Claude Sonnet 5.5 · badge Diamond");
  });
  it("gives a single-agent team its one row (a 1v1)", () => {
    const r = roster(frameOf(b => { b.agents = [agent(0, "ana", 1600, "anthropic/claude-sonnet-5-5"), agent(1, "cy", 1400, "x")]; }));
    expect(r.groups.map(g => g.rows.map(row => [row.title, row.elo]))).toEqual([[["ana", "1600"]], [["cy", "1400"]]]);
  });
  it("titles a row by its model where the stream carries no identity, its asterisk only outside the Antwars Model Index; a builder's row carries none", () => {
    const recording = roster(frameOf(b => { b.agents = [agent(0, null, 0, "anthropic/claude-haiku-5-5"), agent(1, null, 0, "")]; }));
    expect(recording.groups.map(g => g.rows.map(row => [row.title, row.model, row.asterisk, row.elo]))).toEqual([[["Claude Haiku 5.5", "", true, null]], [["", "", false, null]]]);
    expect(recording.groups[0]!.rows[0]!.label).toBe("Claude Haiku 5.5 · Very Large Colony · self-reported · badge Diamond");
    expect(recording.groups[1]!.rows[0]!.label.startsWith("Triangle · Lake Hodges Colony")).toBe(true);
    const split = (edit: (b: Board) => void = () => {}) => roster(frameOf(b => { b.agents = [agent(0, "ana", 1600, "anthropic/claude-sonnet-5-5"), agent(1, "bo", 1500, "")]; edit(b); }));
    // A builder's row names this match's model with no asterisk, inside the Model Index or out.
    expect(split().groups.map(g => g.rows[0]!.asterisk)).toEqual([false, false]);
    expect(split().groups[0]!.rows[0]!.label).not.toContain("self-reported");
    // Every live match carries the idle clock; only the explicit Model Index marker makes it an Index match. Neither
    // shows a quiet "(not recorded)": a level is a badge, and only where the stream carries one.
    expect(split(b => { b.setup.houseIdleTicks = 1800; }).groups[0]!.rows[0]!.badges).toEqual([]);
    const modelIndex = split(b => { b.setup.houseIdleTicks = 1800; b.setup.modelIndex = true; });
    expect(modelIndex.groups[0]!.rows[0]!.asterisk).toBe(false);
    expect(modelIndex.groups[0]!.rows[0]!.badges).toEqual([]);
    expect(modelIndex.groups[0]!.rows[0]!.label).toBe("ana · Rating 1600 · Very Large Colony · Claude Sonnet 5.5 · badge Diamond");
  });
  it("names a Benchmark handle as the Leaderboard does: its house display name with its fixed level and Fast badges, no model or asterisk beside it", () => {
    const r = roster(frameOf(b => {
      b.agents = [
        { ...agent(0, "antwars/claude-opus-5-5-xhigh", 1600, "anthropic/claude-opus-5-5"), thinkingLevel: "low" },
        agent(0, "antwars/gpt-6-luna", 1500, "openai/gpt-6-luna"),
        agent(1, "antwars/some-new-handle", 1400, "x"),
        agent(1, "ANTWARS/glm-5-3-highspeed", 1401, "glm"),
      ];
    }));
    // The handle's fixed level wins over the seat's reported one, as the Leaderboard's server substitutes it (houseLabel).
    expect(r.groups.flatMap(g => g.rows).map(row => [row.title, row.badges, row.model, row.asterisk])).toEqual([
      ["Claude Opus 5.5", ["xhigh"], "", false],
      ["GPT-6 Luna", ["max", "Fast"], "", false],
      // An unlisted handle shows "Unlisted model" with no badges, never its slug.
      ["Unlisted model", [], "", false],
      ["GLM-5.3 Highspeed", [], "", false],
    ]);
    expect(r.groups[0]!.rows[1]!.label).toBe("GPT-6 Luna max Fast · Rating 1500 · Very Large Colony · badge Triangle");
    // The member icons and the 2D HUD's rows show the same display name; the rows above still knew each Benchmark
    // from its raw identity, so its badges survive the shown name.
    expect(r.groups.map(g => g.members.map(m => m.lines[0]))).toEqual([["Claude Opus 5.5", "GPT-6 Luna"], ["Unlisted model", "GLM-5.3 Highspeed"]]);
    expect(r.groups[0]!.members[1]!.label).toBe("GPT-6 Luna · GPT-6 Luna (max · Fast) · Rating 1500 · badge Triangle");
    // No row, icon or label shows a slug or a provider/model key.
    const shown = JSON.stringify(r);
    expect(shown).not.toMatch(/some-new-handle|openai\/|anthropic\/|antwars\//i);
    const f = frameOf(b => { b.agents = [agent(0, "antwars/gpt-6-luna #1", 1500, "openai/gpt-6-luna"), agent(1, "tidewater", 1400, "x")]; });
    expect(agentEntries(f).map(e => e.name)).toEqual(["GPT-6 Luna #1", "tidewater"]);
    expect(agentEntries(f)[0]!.label.startsWith("GPT-6 Luna #1 · Rating 1500 · Very Large Colony")).toBe(true);
    expect(agentEntries(f).some(e => e.label.includes("antwars/"))).toBe(false);
  });
  it("shows the deck badge, team heading and Selected card ratings as whole numbers", () => {
    const f = frameOf(b => { b.agents = [agent(0, "ana", 1577.27, "anthropic/claude-sonnet-5-5"), agent(1, "tidewater", 1488.5, "x")]; });
    expect(agentEntries(f).map(e => e.elo)).toEqual(["1577", "1489"]);
    expect(agentEntries(f)[0]!.label).toContain("Rating 1577 ·");
    expect(eloText(1577.27)).toBe("1577");
    expect(eloText(1500.46)).toBe("1500");
    expect(eloText(1488.5)).toBe("1489");
  });
  it("names every other row by its own name and model; a level is a badge, never quiet text", () => {
    const rows = (index: boolean) => roster(frameOf(b => {
      b.agents = [
        { ...agent(0, "ana", 1600, "anthropic/claude-sonnet-5-5"), thinkingLevel: "high" },
        agent(0, "bo", 1500, ""),
        { ...agent(1, null, 0, "anthropic/claude-haiku-5-5"), thinkingLevel: "medium" },
        agent(1, null, 0, "gpt"),
      ];
      if (index) b.setup.modelIndex = true;
    })).groups.flatMap(g => g.rows).map(row => [row.title, row.badges, row.model, row.modelBadges]);
    // An Index match: the model's level a badge after the model, never also a quiet "(high)" after the name.
    expect(rows(true)).toEqual([
      ["ana", [], "Claude Sonnet 5.5", ["high"]],
      ["bo", [], "", []],
      // Without an identity the model is the title, its recorded level a badge after it; a builder's own label as reported.
      ["Claude Haiku 5.5", ["medium"], "", []],
      ["gpt", [], "", []],
    ]);
    // A challenge or other non-Index match: a builder's line as on a Matches row; a row without an identity is unchanged.
    expect(rows(false)).toEqual([
      ["ana", [], "Claude Sonnet 5.5", ["high"]],
      ["bo", [], "", []],
      ["Claude Haiku 5.5", ["medium"], "", []],
      ["gpt", [], "", []],
    ]);
    // A level the stream carries with no model to badge it: a badge after the name in an Index match.
    const levelOnly = roster(frameOf(b => { b.agents = [{ ...agent(0, "bo", 1500, ""), thinkingLevel: "high" }, agent(1, "x", 1, "y")]; b.setup.modelIndex = true; }));
    expect(levelOnly.groups[0]!.rows[0]!.badges).toEqual(["high"]);
    expect(JSON.stringify(levelOnly)).not.toContain("(high)");
  });
  it("keeps a seat's number with a Benchmark name, and gives a Benchmark player's team its heading alone", () => {
    expect(rowName("antwars/claude-opus-5-5 #2", undefined)).toEqual({ name: "Claude Opus 5.5 #2", benchmark: true, badges: ["high"], quiet: "" });
    expect(rowName("tidewater #1", "low")).toEqual({ name: "tidewater #1", benchmark: false, badges: [], quiet: "(low)" });
    const r = roster(frameOf(b => { b.agents = [1, 2].map(seat => agent(0, `antwars/claude-opus-5-5-max #${seat}`, 1500, "c")).concat(agent(1, "x", 1, "y")); }));
    expect(r.groups[0]!.player).toEqual({ name: "Claude Opus 5.5", model: "", badges: ["max"], elo: "1500", rd: "", seats: 2, result: null });
    expect(r.groups[0]!.rows).toEqual([]);
    expect(isBenchmark("antwarsfan/x")).toBe(false);
  });
  it("gives the head one icon per member, in seat order, its tip the handle, model and rating", () => {
    const r = roster(frameOf());
    expect(r.groups.map(g => g.members.map(m => m.index))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    expect(r.groups[0]!.members[1]!.lines).toEqual(["fennec/forager #2", "Claude Sonnet 5.5", "Rating 1512"]);
    expect(r.groups[1]!.members[0]!.lines).toEqual(["tidewater #1", "GPT-6 Luna", "Rating 1489"]);
    expect(r.groups[0]!.members[0]!.label).toBe("fennec/forager #1 · Claude Sonnet 5.5 · Rating 1512 · badge Diamond");
    expect(r.groups[0]!.members[0]!.badge).toContain('width="16"');
    // The one player keeps its name, model and rating in the head.
    expect(r.groups[0]!.player).toMatchObject({ name: "fennec/forager", model: "Claude Sonnet 5.5", elo: "1512", seats: 4 });
  });
  it("shows a house challenge seat the Index has not rated with no rating badge and no Rating text, never a 1500 default", () => {
    // A challenge match: the house seat carries its name and no rating, the builder its public 1v1 rating.
    const unrated = (b: Board) => { b.agents = [{ ...agent(0, "antwars/gpt-6-luna", 0, "openai/gpt-6-luna"), identity: { displayName: "antwars/gpt-6-luna" } }, agent(1, "kite", 1500, "anthropic/claude-sonnet-5-5")]; };
    const entries = agentEntries(frameOf(unrated));
    expect(entries.map(e => [e.name, e.elo])).toEqual([["GPT-6 Luna", null], ["kite", "1500"]]);
    expect(entries[0]!.label).not.toContain("Rating");
    const r = roster(frameOf(unrated));
    expect(r.groups.map(g => g.rows.map(row => [row.title, row.elo]))).toEqual([[["GPT-6 Luna", null]], [["kite", "1500"]]]);
    expect(r.groups[0]!.rows[0]!.label).not.toContain("Rating");
    expect(r.groups[0]!.members[0]!.lines).toEqual(["GPT-6 Luna", "GPT-6 Luna (max · Fast)"]);
    const card = selected(frameOf(unrated), null, 0);
    expect(card).toMatchObject({ kind: "agent", title: "GPT-6 Luna", sub: "" });
    // Every seat of a team without a rating names no rating in its heading either.
    const team = roster(frameOf(b => { b.agents = [1, 2].map((seat): StreamAgent => ({ ...agent(0, "", 0, "g"), identity: { displayName: `antwars/gpt-6-luna #${seat}` } })).concat([agent(1, "x", 1, "y")]); }));
    expect(team.groups[0]!.player).toBeNull();
  });
  it("shows only what the stream carries for a member: no rating without an identity, the badge's shape word where nothing is carried", () => {
    const r = roster(frameOf(b => { b.agents = [agent(0, "ana", 1600, ""), agent(0, null, 0, "anthropic/claude-haiku-5-5"), agent(1, null, 0, "")]; }));
    expect(r.groups.map(g => g.members.map(m => m.lines))).toEqual([
      [["ana", "Rating 1600"], ["Claude Haiku 5.5"]],
      [["badge Square"]],
    ]);
    expect(r.groups[1]!.members[0]!.label).toBe("badge Square");
  });
  it("names a one-player heading as its rows would name it: a Benchmark handle's house display name, its Elo once", () => {
    const r = roster(frameOf(b => {
      b.agents = [1, 2].map(seat => agent(0, `antwars/claude-opus-5-5-xhigh #${seat}`, 1600, "anthropic/claude-opus-5-5"))
        .concat([1, 2].map(seat => agent(1, `ANTWARS/gpt-6-luna #${seat}`, 1500.456, "openai/gpt-6-luna")));
    }));
    expect(r.groups.map(g => [g.player, g.rows.length])).toEqual([
      [{ name: "Claude Opus 5.5", model: "", badges: ["xhigh"], elo: "1600", rd: "", seats: 2, result: null }, 0],
      [{ name: "GPT-6 Luna", model: "", badges: ["max", "Fast"], elo: "1500", rd: "", seats: 2, result: null }, 0],
    ]);
    // Any other player keeps its own name, as the Leaderboard shows it; split seats still name no player and keep their rows.
    expect(roster(frameOf()).groups.map(g => g.player?.name)).toEqual(["fennec/forager", "tidewater"]);
    const split = roster(frameOf(b => { b.agents = [agent(0, "antwars/claude-opus-5-5 #1", 1500, "c"), agent(0, "antwars/gpt-6-luna #1", 1500, "g"), agent(1, "x", 1, "y")]; }));
    expect(split.groups.map(g => g.player)).toEqual([null, null]);
    expect(split.groups[0]!.rows.map(row => row.title)).toEqual(["Claude Opus 5.5 #1", "GPT-6 Luna #1"]);
  });
  it("finds one player only across two seats or more, one name and one Elo", () => {
    const seat = (name: string, elo = 1500) => ({ identity: { displayName: name, elo }, modelLabel: "" });
    expect(teamPlayer([seat("a #1"), seat("a #2")])).toEqual({ name: "a", elo: "1500" });
    expect(teamPlayer([seat("a #1")])).toBeNull();
    expect(teamPlayer([seat("a #1"), seat("b #2")])).toBeNull();
    expect(teamPlayer([seat("a #1"), seat("a #2", 1501)])).toBeNull();
    expect(teamPlayer([seat("a"), seat("a")])).toBeNull();
    // Each seat joins with its own report: one player only where model, level and Fast match on every seat.
    const reported = (name: string, modelLabel: string, thinkingLevel?: string, serviceTier?: string) => ({ ...seat(name), modelLabel, thinkingLevel, serviceTier });
    expect(teamPlayer([reported("a #1", "openai/gpt-6.1-terra", "high", "fast"), reported("a #2", "openai/gpt-6.1-terra", "high", "fast")])).toEqual({ name: "a", elo: "1500" });
    expect(teamPlayer([reported("a #1", "openai/gpt-6.1-terra", "high"), reported("a #2", "anthropic/claude-sonnet-5-5", "high")])).toBeNull();
    expect(teamPlayer([reported("a #1", "openai/gpt-6.1-terra", "high"), reported("a #2", "openai/gpt-6.1-terra", "low")])).toBeNull();
    expect(teamPlayer([reported("a #1", "openai/gpt-6.1-terra", "high", "fast"), reported("a #2", "openai/gpt-6.1-terra", "high")])).toBeNull();
  });
  it("keeps one row per seat when one player's seats report different models, levels or Fast, in either join order", () => {
    const seats = (reports: [string, string | undefined, string | undefined][]) => roster(frameOf(b => {
      b.agents = reports.map(([model, thinkingLevel, serviceTier], i): StreamAgent => ({ ...agent(0, `alice #${i + 1}`, 1540, model), thinkingLevel, serviceTier }))
        .concat(agent(1, "x", 1, "y"));
    }));
    const gpt: [string, string, string] = ["openai/gpt-6.1-terra", "high", "fast"], claude: [string, string, undefined] = ["anthropic/claude-sonnet-5-5", "low", undefined];
    const line = (r: ReturnType<typeof roster>) => r.groups[0]!.rows.map(row => [row.title, row.model, row.modelBadges]);
    // GPT/high/Fast and Claude/low under one identity: no "×2" heading naming the first seat's model for both.
    const mixed = seats([gpt, claude]);
    expect(mixed.groups[0]!.player).toBeNull();
    expect(line(mixed)).toEqual([["alice #1", "GPT-6.1 Terra", ["high", "Fast"]], ["alice #2", "Claude Sonnet 5.5", ["low"]]]);
    // The reversed join order: still each seat's own report, never the first joined seat's.
    const reversed = seats([claude, gpt]);
    expect(reversed.groups[0]!.player).toBeNull();
    expect(line(reversed)).toEqual([["alice #1", "Claude Sonnet 5.5", ["low"]], ["alice #2", "GPT-6.1 Terra", ["high", "Fast"]]]);
    // A level or Fast alone differing keeps the rows too.
    expect(seats([gpt, [gpt[0], "low", "fast"]]).groups[0]!.player).toBeNull();
    expect(seats([gpt, [gpt[0], "high", undefined]]).groups[0]!.player).toBeNull();
    // Matching reports on every seat: the one line with ×N, the shared model and badges.
    const same = seats([gpt, gpt, gpt]);
    expect(same.groups[0]!.player).toMatchObject({ name: "alice", model: "GPT-6.1 Terra", badges: ["high", "Fast"], elo: "1540", seats: 3 });
    expect(same.groups[0]!.rows).toEqual([]);
  });
});

describe("what a live viewer arriving mid-match missed", () => {
  const LIVE: ModeText = { label: "LIVE · rated match", detail: "" };
  const REPLAY: ModeText = { label: "RECORDING · rated match", detail: "" };
  const wordMark = { id: 7, agent: 0, colony: 0 as const, tileX: 3, tileY: 3, words: [1, 2], laidTick: TICK - 400, answered: 0 };
  const countMark = { id: 8, agent: 0, colony: 0 as const, tileX: 4, tileY: 4, words: [], laidTick: TICK - 100, answered: 0, verb: "FORAGE" as const, count: 6 };
  const arrived = (edit: (b: Board, f: Frame) => void = () => {}) => frameOf((b, f) => {
    b.agents = [{ ...agent(0, "fennec/forager #1", 1512.37, "anthropic/claude-sonnet-5-5", "attack", 50, 20), intent: "take their queen" }, ...b.agents.slice(1)];
    b.marks = [wordMark, countMark, { ...countMark, id: 9, agent: 1, laidTick: TICK - 50 }];
    edit(b, f);
  });

  it("holds one row per agent with its standing order, its intent and its newest live mark, worded as the state at arrival", () => {
    const held = arrival(null, arrived())!;
    expect(held.tick).toBe(TICK);
    expect(held.rows.map(r => [r.key, r.member?.index, r.when, r.what, r.intent, r.arrival, r.mark?.text ?? null])).toEqual([
      ["a0", 0, "", "attack Lake Hodges Colony's Queen 1", "“take their queen”", true, "FORAGE · 6 requested"],
      ["a1", 1, "", "forage", "", true, "FORAGE · 6 requested"],
      ...[2, 3, 4, 5, 6, 7].map(i => [`a${i}`, i, "", "forage", "", true, null]),
    ]);
    expect(held.rows[0]!.glyph).toEqual({ kind: "order", order: "attack", guard: false });
    expect(held.rows[0]!.mark).toEqual({ verb: "FORAGE", text: "FORAGE · 6 requested" });
    expect(held.rows[0]!.reading).toBe(`${D1_COPY.onArrival}, fennec/forager #1: attack Lake Hodges Colony's Queen 1 “take their queen”, ${D1_COPY.arrivalMark} FORAGE · 6 requested`);
  });

  it("puts the arrival rows at the oldest end of each team's history, under every later row", () => {
    const f = arrived((_, fr) => { fr.commands = [{ id: 1, tick: TICK, agent: 0, colony: 0, call: "order", accepted: false }]; });
    const seed = arrivalRows(arrival(null, f), LIVE);
    expect(history(f, 0, seed).map(r => r.key)).toEqual(["c1", "a0", "a1", "a2", "a3"]);
    expect(history(f, 1, seed).map(r => r.key)).toEqual(["a4", "a5", "a6", "a7"]);
    expect(history(f, 0).map(r => r.key)).toEqual(["c1"]);
  });

  it("keeps the rows of the first board it saw as play goes on and through a reconnect to the same match", () => {
    const first = arrival(null, arrived())!;
    const later = arrived((b, f) => { f.tick = TICK + 600; b.agents = b.agents.map(a => ({ ...a, order: "hold" as const, intent: "" })); b.marks = []; });
    expect(arrival(first, later)).toBe(first);
    // A reconnect brings a fresh board of the same match: the same rows.
    const reconnect = arrived((_, f) => { f.tick = TICK + 900; });
    expect(arrival(first, reconnect)).toBe(first);
    expect(arrival(first, null)).toBe(first);
    // A viewer there from the first tick keeps that arrival as agents join: the joins are its history.
    const start = arrival(null, arrived((b, f) => { f.tick = 0; b.agents = []; b.marks = []; }))!;
    expect(arrival(start, arrived((_, f) => { f.tick = 12; }))).toBe(start);
    expect(arrivalRows(arrival(start, arrived((_, f) => { f.tick = 12; })), { label: "LIVE", detail: "" })).toEqual([]);
  });

  it("takes a new arrival for another match", () => {
    const first = arrival(null, arrived())!;
    const next = arrival(first, arrived((b, f) => { f.tick = 40; b.agents = [agent(0, "ana", 1600, "x"), agent(1, "bo", 1500, "y")]; }))!;
    // Another map is another match whatever its tick.
    expect(arrival(first, arrived((b, f) => { f.tick = TICK + 5; b.setup = { ...b.setup, mapW: 80 }; }))).not.toBe(first);
    expect(next).not.toBe(first);
    expect([next.tick, next.rows.map(r => r.key)]).toEqual([40, ["a0", "a1"]]);
    // The same seats on a restarted clock are another match too.
    expect(arrival(first, arrived((_, f) => { f.tick = TICK - 1; }))).not.toBe(first);
  });

  it("shows the rows only to a live viewer who arrived after the start: never on a replay, nor from the first tick", () => {
    const held = arrival(null, arrived());
    expect(arrivalRows(held, LIVE)).toHaveLength(8);
    expect(arrivalRows(held, REPLAY)).toEqual([]);
    expect(arrivalRows(held, null)).toEqual([]);
    expect(arrivalRows(arrival(null, arrived((_, f) => { f.tick = 0; })), LIVE)).toEqual([]);
    expect(arrivalRows(null, LIVE)).toEqual([]);
    // The same empty list each time, so the panel can tell nothing changed.
    expect(arrivalRows(held, REPLAY)).toBe(arrivalRows(null, LIVE));
  });
});

describe("the Selected card", () => {
  it("shows an agent's card lines without the self-reported editorial or the order the panel shows itself", () => {
    const sel = selected(frameOf(), null, 0);
    expect(sel).toMatchObject({ kind: "agent", index: 0, title: "fennec/forager #1", model: "Claude Sonnet 5.5", asterisk: true,
      sub: "Rating 1512", order: "Squad order: attack Lake Hodges Colony's Queen 1", target: true });
    if (sel.kind !== "agent") throw new Error("agent expected");
    expect(sel.lines).toEqual(["Call interval: 4.2 s"]);
    expect(sel.lines.some(line => line.includes("self-reported"))).toBe(false);
  });
  it("names an agent as its row names it, the model beside it and its asterisk unchanged", () => {
    const picked = (first: StreamAgent, edit: (b: Board) => void = () => {}) =>
      selected(frameOf(b => { b.agents = [first, ...b.agents.slice(1)]; edit(b); }), null, 0);
    expect(picked(agent(0, "antwars/claude-opus-5-5-xhigh #1", 1600, "anthropic/claude-opus-5-5")))
      .toMatchObject({ kind: "agent", title: "Claude Opus 5.5 #1", model: "Claude Opus 5.5", asterisk: true, sub: "Rating 1600" });
    expect(picked(agent(0, "ANTWARS/gpt-6-luna", 1500, "openai/gpt-6-luna"), b => { b.setup.modelIndex = true; }))
      .toMatchObject({ title: "GPT-6 Luna", model: "GPT-6 Luna", badges: ["max", "Fast"], asterisk: false });
    // Any other identity keeps its own name, with no thinking level in the title; without one, the model or the handle.
    expect(picked({ ...agent(0, "ana", 1600, "anthropic/claude-sonnet-5-5"), thinkingLevel: "high" }))
      .toMatchObject({ title: "ana", model: "Claude Sonnet 5.5", asterisk: true });
    expect(picked(agent(0, null, 0, "anthropic/claude-haiku-5-5"))).toMatchObject({ title: "Claude Haiku 5.5", model: "", asterisk: true });
    expect(picked(agent(0, null, 0, ""))).toMatchObject({ title: "Diamond", model: "", asterisk: false });
  });
  it("names an ant outside a squad as today's card does, and nothing when nothing is picked", () => {
    expect(selected(frameOf(), { antId: 2381, colony: 0, agent: -1 }, -1)).toEqual({ kind: "ant", key: "ant:2381", colony: 0, title: "Ant 2381 · Very Large Colony", line: "No squad" });
    expect(selected(frameOf(), null, -1)).toEqual({ kind: "none" });
    expect(selected(null, null, 0)).toEqual({ kind: "none" });
  });
});

describe("the map", () => {
  const terrain = (name: string) => ({ mapId: name.toLowerCase().replace(/ /g, "-"), mapName: name, water: [] });
  it("names the match's map from the stream's setup, the one place live and replay both read it", () => {
    expect(mapName(frameOf(b => { b.setup = { ...b.setup, terrain: terrain("Three Crossings") }; }))).toBe("Three Crossings");
    expect(mapName(frameOf(b => { b.setup = { ...b.setup, terrain: terrain("Wide Plain") }; }))).toBe("Wide Plain");
  });
  it("names no map where the stream carries none, rather than a wrong or placeholder one", () => {
    expect(mapName(frameOf())).toBeNull();
    expect(mapName(frameOf(b => { b.setup = { ...b.setup, terrain: terrain(" ") }; }))).toBeNull();
    expect(mapName(null)).toBeNull();
    expect(mapName(new Frame())).toBeNull();
  });
  it("labels the row Map", () => {
    expect(D1_COPY.map).toBe("Map");
  });
});

// No house slug and no provider/model key in the HUD.
describe("no house slug or provider/model key in the HUD", () => {
  const KEY = /not-a-row|abliterated-model-large-v2|openai\/|anthropic\/|abliteration\/|antwars\//i;
  const board = (b: Board) => {
    b.agents = [
      agent(0, "antwars/abliterated-large-v2", 1600, "abliteration/abliterated-model-large-v2"),
      agent(0, "antwars/not-a-row", 1500, "openai/gpt-6.1-sol"),
      { ...agent(1, "kite", 1500, "anthropic/claude-opus-5-5"), thinkingLevel: "xhigh" },
      { ...agent(1, null, 0, "openai/gpt-6.1-sol"), thinkingLevel: "high", serviceTier: "fast" },
    ];
  };
  it("names each seat and its model by display name with badges, an unlisted handle Unlisted model with none", () => {
    const f = frameOf(board);
    const rows = roster(f).groups.flatMap(g => g.rows);
    expect(rows.map(row => [row.title, row.badges, row.model, row.modelBadges])).toEqual([
      ["Abliterated GLM-5.3", ["max"], "", []],
      ["Unlisted model", [], "", []],
      ["kite", [], "Claude Opus 5.5", ["xhigh"]],
      ["GPT-6.1 Sol", ["high", "Fast"], "", []],
    ]);
    expect(selected(f, null, 1)).toMatchObject({ title: "Unlisted model", model: "Unlisted model", badges: [] });
    expect(selected(f, null, 2)).toMatchObject({ title: "kite", model: "Claude Opus 5.5", badges: ["xhigh"] });
    expect(selected(f, null, 3)).toMatchObject({ title: "GPT-6.1 Sol", model: "", badges: ["high", "Fast"] });
    expect(agentEntries(f).map(e => e.model)).toEqual(["Abliterated GLM-5.3 (max)", "Unlisted model", "Claude Opus 5.5 (xhigh)", "GPT-6.1 Sol (high · Fast)"]);
    for (const shown of [roster(f), [0, 1, 2, 3].map(i => selected(f, null, i)), agentEntries(f)]) expect(JSON.stringify(shown)).not.toMatch(KEY);
  });
});

// "Unlisted model" is for house seats only; a builder's
// self-reported model keeps today's display.
describe("a builder's self-reported model", () => {
  const LABEL = "Claude Code sonnet";
  const board = (b: Board) => {
    b.agents = [agent(0, "kite", 1500, LABEL), agent(0, null, 0, LABEL), agent(1, "antwars/not-a-row", 1500, LABEL), agent(1, "tidewater", 1400, "")];
  };
  it("renders \"Claude Code sonnet\" unchanged on Recordings, the deck rows, the Selected card and the HUD model line; only a house seat shows Unlisted model", () => {
    const f = frameOf(board);
    // Recordings: a builder's seat (no handle, or another owner's) as reported; an unlisted antwars/ seat Unlisted model.
    expect(recordedIdentity({ modelLabel: LABEL, thinkingLevel: null, serviceTier: null, handle: null }).name).toBe(LABEL);
    expect(recordedIdentity({ modelLabel: LABEL, thinkingLevel: null, serviceTier: null, handle: "kite/agent" }).name).toBe(LABEL);
    expect(recordedIdentity({ modelLabel: LABEL, thinkingLevel: null, serviceTier: null, handle: "antwars/not-a-row" }).name).toBe("Unlisted model");
    // Deck rows and the Selected card.
    const rows = roster(f).groups.flatMap(g => g.rows);
    expect(rows.slice(0, 3).map(row => [row.title, row.model])).toEqual([["kite", LABEL], [LABEL, ""], ["Unlisted model", ""]]);
    expect(selected(f, null, 0)).toMatchObject({ title: "kite", model: LABEL });
    expect(selected(f, null, 1)).toMatchObject({ title: LABEL, model: "" });
    expect(selected(f, null, 2)).toMatchObject({ title: "Unlisted model" });
    // The HUD's plain-text model line, its tooltip and the agent card.
    expect(agentEntries(f).slice(0, 3).map(e => e.model)).toEqual([LABEL, LABEL, "Unlisted model"]);
    expect(modelLine(f.board!.agents[0]!, MODEL_LABEL)).toBe(`${MODEL_LABEL}: ${LABEL}`);
    expect(squadTipText(0, f.board!.agents[0]!)).toContain(`${MODEL_LABEL}: ${LABEL}`);
    expect(agentCard(1, f.board!.agents[1]!, [], TICK, 10)).toContain(`${MODEL_LABEL}: ${LABEL}`);
    expect(JSON.stringify(rows)).not.toContain("not-a-row");
  });
});
