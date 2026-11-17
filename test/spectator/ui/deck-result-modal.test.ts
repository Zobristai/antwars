// The match result as a modal over the whole screen, not under the score. The DOM half mounts the deck's score and team pane on the test port and drives them
// with frames; the stylesheet half reads deck.css's contracts. Neither is visual evidence: browser captures are that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Frame, type Board, type StoryEntry } from "../../../web/src/buffer.ts";
import { colonyNameNote } from "../../../src/sim/colonyNames.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { mountDeck } from "../../../web/src/ui/deck/deck.ts";
import { mountTeams } from "../../../web/src/ui/deck/pane.ts";
import { mountResultModal } from "../../../web/src/ui/deck/result-modal.ts";
import type { HudActions, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const HUD = readFileSync(new URL("../../../web/src/ui/deck/hud.ts", import.meta.url), "utf8");
const TICK = 7540;
const END = TICK - 100;

function queen(id: number, colony: 0 | 1, tile: number, hp: number, lostTick: number | null = null): StreamQueen {
  return { id, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick, overrun: 0, hp };
}
function agent(colony: 0 | 1, name: string, elo: number): StreamAgent {
  return { identity: { displayName: name, elo }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" };
}

/**
 * A 1v1 on the redesign rules; ended at END by queens killed when `ended`, `atMs` past the end's beat. `match` is
 * Playback's count of matches this page has seen (Frame.match): 1, the first, unless said.
 */
function frameOf(o: { ended: boolean; atMs?: number; winner?: 0 | 1; rated?: boolean; name?: string; match?: number } = { ended: false }): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = o.atMs ?? TICK * 100 + 10_000; f.match = o.match ?? 1;
  f.ensure(0); f.count = 0;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: o.rated ?? false, rules: "redesign" },
    queens: [queen(0, 0, 8, 40000), queen(0, 1, 50, 0, END)],
    territory: new Uint8Array(0), held: [870, 130], marks: [], agents: [agent(0, o.name ?? "fennec/forager", 1512.37), agent(1, "tidewater", 1488.6)],
    overrun: [0, 0], overrunRequired: 100, deaths: [31, 48],
    result: o.ended ? { winner: o.winner ?? 0, reason: "queens_killed", decidedBy: "queens_killed", tick: END, nextStartMs: null } : null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 57, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 2, nextHatchTick: TICK - 10, nextCost: 6 }],
  };
  f.board = b;
  return f;
}

const actions = { select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
const view = (frame: Frame): HudView => ({ frame, connection: "live", board: "3d", selected: null, selectedAgent: -1, mode: null, stalled: false });

function mount() {
  const port = dom();
  const deck = mountDeck(port.doc);
  const teams = mountTeams(port.doc, actions, { search: () => "", economy: deck.economy });
  // As the HUD places them: the score in the deck, the result's dialog at the page's root.
  port.body.append(deck.score as unknown as ElementPort, teams.result as unknown as ElementPort);
  const dialog = teams.result as unknown as ElementPort;
  const score = deck.score as unknown as ElementPort;
  const show = (frame: Frame) => { deck.update(frame); teams.update(view(frame), false); };
  return { dialog, score, show };
}
const closeButton = (dialog: ElementPort) => dialog.byClass("d1-close")[0]!;

describe("the match result as a modal over the screen", () => {
  it("opens a modal dialog at the end with the winner in team colour, how it ended and the rating line, named by its headline", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: false }));
    expect(dialog.tag).toBe("dialog");
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(true);
    const head = dialog.byClass("d1-result-head")[0]!;
    expect(head.textContent).toBe("Very Large wins");
    expect((head.style as unknown as { color: string }).color).toBe("var(--aw-k0, var(--aw-c0))");
    expect(dialog.byClass("d1-result-how")[0]!.textContent).toBe("Queens killed");
    expect(dialog.byClass("rd-note")[0]!.textContent).toBe("Unrated match · no rating changes");
    expect(dialog.getAttribute("aria-labelledby")).toBe(head.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(dialog.byClass("d1-result-how")[0]!.id);
    expect(closeButton(dialog).getAttribute("aria-label")).toBe("Close");
  });

  it("shows a drawn name in the result in its colony's colour with its source note, and a rated result as it always was", () => {
    const took: StoryEntry = { id: 1, kind: "queen_attack", queenId: 0, tick: END - 5, colony: 0, agent: -1, x: 50, y: 20, outcome: "took" };
    const ended = (drawn: readonly [string, string] | null) => {
      const f = frameOf({ ended: true, rated: drawn === null });
      if (drawn) f.board!.setup = { ...f.board!.setup, colonyNames: drawn };
      f.story = [took];
      return f;
    };
    // The dialog alone, as the deck's pane mounts it (its history list needs more of a page than this port has).
    const modal = () => {
      const port = dom();
      const result = mountResultModal(port.doc);
      port.body.append(result.dialog as unknown as ElementPort);
      return { dialog: result.dialog as unknown as ElementPort, show: (frame: Frame) => result.update(frame) };
    };
    const drawn = modal();
    drawn.show(ended(["Sweetwater Colony", "Lake Skinner Colony"]));
    const head = drawn.dialog.byClass("d1-result-head")[0]!;
    expect(head.textContent).toBe("Sweetwater wins");
    expect(head.getAttribute("title")).toBe(colonyNameNote("Sweetwater Colony"));
    const who = drawn.dialog.byClass("d1-moment-who")[0]!;
    expect(who.textContent).toBe("Sweetwater");
    const name = who.children.find(c => c.tag === "span")!;
    expect(name.getAttribute("title")).toBe(colonyNameNote("Sweetwater Colony"));
    expect((name.style as unknown as { color: string }).color).toBe("var(--aw-k0, var(--aw-c0))");

    // An overrun names the colony whose queen it took: that name in its own colony's colour with its note, the rest of
    // the moment in the attacker's.
    const overrun = modal();
    const f = ended(["Sweetwater Colony", "Lake Skinner Colony"]);
    f.story = [{ id: 2, kind: "overrun", queenId: 0, tick: END - 50, endTick: END - 10, colony: 0, agent: -1, x: 50, y: 20, outcome: "took", peak: 100, required: 100 }];
    overrun.show(f);
    const what = overrun.dialog.byClass("d1-moment-what")[0]!;
    expect(what.textContent).toBe("Overrun attempt on the Lake Skinner Colony queen — took the queen");
    expect(what.title).toBe(what.textContent);
    expect((what.style as unknown as { color: string }).color).toBe("var(--aw-k0, var(--aw-c0))");
    const target = what.children.find(c => c.tag === "span")!;
    expect(target.textContent).toBe("Lake Skinner Colony");
    expect(target.getAttribute("title")).toBe(colonyNameNote("Lake Skinner Colony"));
    expect((target.style as unknown as { color: string }).color).toBe("var(--aw-k1, var(--aw-c1))");

    const rated = modal();
    rated.show(ended(null));
    const ratedHead = rated.dialog.byClass("d1-result-head")[0]!;
    expect(ratedHead.textContent).toBe("Very Large wins");
    expect(ratedHead.getAttribute("title")).toBeNull();
    const ratedWho = rated.dialog.byClass("d1-moment-who")[0]!;
    expect(ratedWho.textContent).toBe("Very Large");
    expect(ratedWho.children).toHaveLength(0);
    expect(rated.dialog.byClass("d1-moment-what")[0]!.children).toHaveLength(0);
  });

  it("names a four-colony winner, or a draw, in its own colour with its source note, and how it ended", () => {
    const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
    // A finished four-colony match: one queen per colony, every queen but the winner's lost (all four in a same-tick
    // all-idle end), the four names its setup carries; winner 0 to 3 or null.
    const ended = (winner: number | null, reason: string, decidedBy: string, allLost = false) => {
      const f = frameOf({ ended: true });
      const b = f.board!;
      b.setup = { ...b.setup, queens: [[8, 8], [56, 8], [8, 40], [56, 40]].map(([x, y]) => [x! * SUB_TILE, y! * SUB_TILE]), colonyNames: NAMES } as unknown as Board["setup"];
      b.queens = [8, 56, 8, 56].map((tile, colony) => ({ ...queen(colony, 0, tile, 0, allLost || colony !== winner ? END : null), colony }) as unknown as StreamQueen);
      b.agents = NAMES.map((_, colony) => ({ ...agent(0, `seat-${colony}`, 1500), colony }) as unknown as StreamAgent);
      b.result = { winner, reason, decidedBy, tick: END, nextStartMs: null } as unknown as Board["result"];
      // The queen colony 3 took from colony 1.
      f.story = [{ id: 1, kind: "queen_attack", queenId: 1, tick: END - 5, colony: 3, agent: -1, x: 56, y: 8, outcome: "took" } as unknown as StoryEntry];
      return f;
    };
    const modal = () => {
      const port = dom();
      const result = mountResultModal(port.doc);
      port.body.append(result.dialog as unknown as ElementPort);
      return { dialog: result.dialog as unknown as ElementPort, show: (frame: Frame) => result.update(frame) };
    };
    const won = modal();
    won.show(ended(2, "queens_killed", "queens_killed"));
    expect(won.dialog.open).toBe(true);
    const head = won.dialog.byClass("d1-result-head")[0]!;
    expect(head.textContent).toBe("Sweetwater wins");
    expect((head.style as unknown as { color: string }).color).toBe("var(--aw-k2)");
    expect(head.classes()).toEqual(["d1-result-head", "c2"]);
    expect(head.getAttribute("title")).toBe(colonyNameNote("Sweetwater Colony"));
    expect(won.dialog.byClass("d1-result-how")[0]!.textContent).toBe("Last colony standing · queens killed");
    expect(won.dialog.byClass("rd-note")[0]!.textContent).toBe("Unrated match · no rating changes");
    // The moment in its colony's colour, the colony it names in that colony's own.
    const what = won.dialog.byClass("d1-moment-what")[0]!;
    expect((what.style as unknown as { color: string }).color).toBe("var(--aw-k3)");
    const who = won.dialog.byClass("d1-moment-who")[0]!;
    expect(who.textContent).toBe("Lake Skinner");
    const name = who.children.find(c => c.tag === "span")!;
    expect((name.style as unknown as { color: string }).color).toBe("var(--aw-k3)");
    expect(name.getAttribute("title")).toBe(colonyNameNote("Lake Skinner Colony"));

    // A same-tick all-idle end: every queen lost at the result tick, the time-up winner still shown as the winner.
    const idle = modal();
    idle.show(ended(3, "idle", "territory", true));
    const idleHead = idle.dialog.byClass("d1-result-head")[0]!;
    expect(idleHead.textContent).toBe("Lake Skinner wins");
    expect((idleHead.style as unknown as { color: string }).color).toBe("var(--aw-k3)");
    expect(idle.dialog.byClass("d1-result-how")[0]!.textContent).toBe("Seats inactive · decided on territory");

    const drawn = modal();
    drawn.show(ended(null, "time_up", "draw"));
    const drawHead = drawn.dialog.byClass("d1-result-head")[0]!;
    expect(drawHead.textContent).toBe("Match drawn");
    expect(drawHead.getAttribute("title")).toBeNull();
    expect(drawn.dialog.byClass("d1-result-how")[0]!.textContent).toBe("Time-up · decided on draw");
    for (const dialog of [won.dialog, idle.dialog, drawn.dialog]) expect(dialog.textContent).not.toMatch(/both sides|opponent/i);
  });

  it("keeps the Abandoned headline instead of describing an abandoned match as a draw", () => {
    const { dialog, show } = mount();
    const f = frameOf({ ended: true, rated: false });
    f.board!.result = { winner: null, reason: "abandoned", decidedBy: "draw", tick: END, nextStartMs: null };
    show(f);
    const head = dialog.byClass("d1-result-head")[0]!;
    expect(head.textContent).toBe("Abandoned");
    expect(head.getAttribute("aria-label")).toBe("Abandoned");
    expect(dialog.byClass("d1-result-how")[0]!.textContent).toBe("Seat inactive · unrated");
    expect(dialog.byClass("rd-outcome")).toHaveLength(0);
  });

  it("bounds decisive text to two wrapping lines rather than an unshrinkable column", () => {
    expect(CSS).toContain("grid-template-columns: 36px minmax(0,max-content) minmax(max-content,1fr)");
    const rule = CSS.match(/\.d1-result-dialog \.d1-moment-what \{([^}]+)\}/)![1];
    expect(rule).toContain("white-space: normal");
    expect(rule).toContain("min-width: 0");
    expect(rule).toContain("-webkit-line-clamp: 2");
    expect(rule).toContain("overflow: hidden");
  });

  it("shows one final Rating column with signed changes between rounded displayed ratings", () => {
    const { dialog, show } = mount();
    const f = frameOf({ ended: true, rated: true });
    f.board!.result!.ratingChanges = [{ agent: 0, before: 1850.2, after: 1860.3 }, { agent: 1, before: 1850.4, after: 1830.1 }];
    show(f);
    expect(dialog.byClass("rd-columns")[0]!.textContent).toBe("PlayersRating");
    expect(dialog.byClass("rd-numbers").map(n => n.textContent)).toEqual(["1860 (+10)", "1830 (−20)"]);
    expect(dialog.byClass("d1-ratings")[0]!.textContent).not.toMatch(/1850|→/);
    expect(dialog.byClass("d1-result-head")[0]!.getAttribute("aria-label")).toBe("Very Large Colony wins");
    f.board!.result!.ratingChanges = [{ agent: 0, before: 1860.1, after: 1860.4 }];
    show(f);
    expect(dialog.byClass("rd-numbers").map(n => n.textContent)).toEqual(["1860 (0)", ""]);
  });

  it("keeps the existing pending-rating message until the played result supplies changes", () => {
    const { dialog, show } = mount();
    const f = frameOf({ ended: true, rated: true });
    show(f);
    expect(dialog.byClass("rd-note")[0]!.textContent).toBe("Rated match · rating update pending");
    expect(dialog.byClass("rd-rating-label")[0]!.hidden).toBe(true);
    expect(dialog.byClass("rd-numbers")).toHaveLength(0);
    expect(dialog.byClass("d1-rating")).toHaveLength(2);
    f.board!.result!.ratingChanges = [{ agent: 0, before: 1500, after: 1510 }];
    show(f);
    expect(dialog.byClass("rd-note")[0]!.hidden).toBe(true);
    expect(dialog.byClass("rd-rating-label")[0]!.hidden).toBe(false);
    expect(dialog.byClass("rd-numbers")[0]!.textContent).toBe("1510 (+10)");
  });

  it("keeps the shown roster nodes stable when only live agent activity changes", () => {
    const { dialog, show } = mount();
    const f = frameOf({ ended: true, rated: false });
    show(f);
    const firstRow = dialog.byClass("d1-rating")[0];
    f.board!.agents = f.board!.agents.map(agent => ({ ...agent, lastCallTick: TICK + 1, intent: "explore" }));
    show(f);
    expect(dialog.byClass("d1-rating")[0]).toBe(firstRow);
  });

  it("never shows rating changes for an unrated match, even if the result carries numbers", () => {
    const { dialog, show } = mount();
    const f = frameOf({ ended: true, rated: false });
    f.board!.result!.ratingChanges = [{ agent: 0, before: 1850, after: 1860 }];
    show(f);
    expect(dialog.byClass("rd-rating-label")[0]!.hidden).toBe(true);
    expect(dialog.byClass("rd-numbers")).toHaveLength(0);
    expect(dialog.byClass("rd-note")[0]!.textContent).toBe("Unrated match · no rating changes");
    expect(dialog.byClass("d1-rating")).toHaveLength(2);
    f.board!.setup = { ...f.board!.setup, rated: undefined };
    show(f);
    expect(dialog.byClass("rd-note")[0]!.hidden).toBe(true);
  });

  it("leaves no result card in the score: the score keeps its clock and Balance, Win conditions give way at the end", () => {
    const { score, show } = mount();
    show(frameOf({ ended: true }));
    expect(score.byClass("d1-result")).toHaveLength(0);
    expect(score.byClass("d1-gauge")).toHaveLength(3);
    expect(score.byClass("d1-clock")[0]!.textContent).toMatch(/ended/i);
    expect(score.classes()).toContain("is-ended");
    show(frameOf({ ended: false }));
    expect(score.classes()).not.toContain("is-ended");
  });

  it("closes with its Close button and stays closed on the frames that follow", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: true }));
    closeButton(dialog).click();
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true, atMs: TICK * 100 + 11_000 }));
    expect(dialog.open).toBe(false);
  });

  it("closes with Escape, the dialog's own cancel alongside the Close button, and stays closed", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: true }));
    let prevented = false;
    dialog.fire("cancel", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(false);
  });

  it("closes on a click on the dimmed page, not on a click inside it", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: true }));
    dialog.fire("click", { target: dialog.byClass("d1-result-how")[0] });
    expect(dialog.open).toBe(true);
    dialog.fire("click");
    expect(dialog.open).toBe(false);
  });

  it("in a replay, opens when playback reaches the end and hides when seeked back before it", () => {
    const { dialog, show } = mount();
    // Seeked before the end's beat: the board has its result, playback has not reached it.
    show(frameOf({ ended: true, atMs: END * 100 - 5_000 }));
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(true);
    show(frameOf({ ended: true, atMs: END * 100 - 5_000 }));
    expect(dialog.open).toBe(false);
    expect(dialog.byClass("d1-result")[0]!.hidden).toBe(true);
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(true);
  });

  it("once closed stays closed for that match's end, even seeked back and played to the end again", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: true }));
    closeButton(dialog).click();
    show(frameOf({ ended: false }));
    show(frameOf({ ended: true, atMs: END * 100 - 5_000 }));
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(false);
  });

  it("opens again for the next match's result", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: true }));
    closeButton(dialog).click();
    show(frameOf({ ended: false, name: "next/match" }));
    show(frameOf({ ended: true, winner: 1, name: "next/match" }));
    expect(dialog.open).toBe(true);
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toBe("Lake Hodges wins");
  });

  it("opens again for the next match even when its result reads exactly as the one just closed", () => {
    const { dialog, show } = mount();
    show(frameOf({ ended: true, match: 1 }));
    closeButton(dialog).click();
    expect(dialog.open).toBe(false);
    // The next match in the same page view: the same time, winner, reason and rating lines.
    show(frameOf({ ended: false, match: 2 }));
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true, match: 2 }));
    expect(dialog.open).toBe(true);
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toBe("Very Large wins");
    // And that match's own Close holds for it, as the first match's did.
    closeButton(dialog).click();
    show(frameOf({ ended: true, match: 2 }));
    expect(dialog.open).toBe(false);
  });

  it("is placed at the page's root by the HUD, not in the score", () => {
    expect(HUD).not.toMatch(/deck\.score\.append\(teams\.result/);
    expect(HUD).toMatch(/root\.append\([^)]*teams\.result\)/);
  });

  it("is centred and fits a 390 px phone at every width: no bottom sheet, inner scroll when taller than the screen", () => {
    const at = CSS.indexOf(".d1-dialog.d1-result-dialog {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    expect(rule).toMatch(/width: min\(440px, calc\(100vw - 24px\)\)/);
    expect(rule).toMatch(/max-height: calc\(100dvh - 24px\)/);
    expect(rule).toMatch(/margin: auto;/);
    expect(rule).toMatch(/overflow: auto/);
    expect(CSS).toContain(".d1-score.is-ended > .d1-win { display: none; }");
    expect(CSS).not.toContain(":has(> .d1-result");
  });
});

describe("Share on X in the deck's result modal", () => {
  it("carries the page's share link from the HUD view into the modal, and none without one", () => {
    const port = dom();
    const deck = mountDeck(port.doc);
    const teams = mountTeams(port.doc, actions, { search: () => "", economy: deck.economy });
    port.body.append(teams.result as unknown as ElementPort);
    const dialog = teams.result as unknown as ElementPort;
    const ended = frameOf({ ended: true });
    teams.update({ ...view(ended), share: "https://antwars.example/?replay=2026-10-28-12" }, false);
    const link = dialog.byClass("d1-share")[0]!;
    expect(link.hidden).toBe(false);
    expect(new URL(link.getAttribute("href")!).searchParams.get("text"))
      .toBe("fennec/forager beat tidewater on Antwars — Queens killed. Watch: https://antwars.example/?replay=2026-10-28-12");
    teams.update({ ...view(ended), share: null }, false);
    expect(link.hidden).toBe(true);
  });

  it("draws Share with the same winning-colony banner colour", () => {
    const { dialog } = shareDialog(frameOf({ ended: true }));
    expect(dialog.byClass("d1-share")[0]!.classes()).toEqual(["d1-agent-button", "d1-share"]);
    // The banner and share button use the same winning-colony token.
    expect(CSS).toContain(".d1-share { justify-self: start; margin-top: 8px; }");
    expect(CSS).toMatch(/\.d1-result-dialog \.d1-share \{[^}]*background: var\(--d1-side\)/);
    expect(CSS).toMatch(/\.d1-result-dialog \.d1-result-top \{[^}]*background: var\(--d1-side\)/);
    expect(CSS).not.toContain(".d1-share:hover");
    // The shared button works in any root: its tap height falls back, its dark text holds under the dialog, and a
    // disabled one says so.
    expect(CSS).toMatch(/\.d1-agent-button \{[^}]*min-height: var\(--d1-tap, 36px\);/);
    expect(CSS).toContain(".d1-dialog .d1-agent-button { color: var(--aw-bg); }");
    expect(CSS).toContain(".d1-agent-button:disabled { opacity: 0.45; cursor: default; }");
  });

  it("shows no house slug on Share, its post or the result beside it", () => {
    const { dialog, link } = shareDialog(frameOf({ ended: true, name: "antwars/mistral-large-4" }));
    expect(link.hidden).toBe(false);
    const posted = new URL(link.getAttribute("href")!).searchParams.get("text")!;
    expect(posted).toContain("Mistral Large 4");
    for (const shown of [posted, link.textContent, link.getAttribute("aria-label") ?? "", dialog.textContent]) {
      expect(shown).not.toMatch(/mistral-large-4|antwars\//);
    }
  });
});

function shareDialog(frame: Frame) {
  const port = dom();
  const deck = mountDeck(port.doc);
  const teams = mountTeams(port.doc, actions, { search: () => "", economy: deck.economy });
  port.body.append(teams.result as unknown as ElementPort);
  const dialog = teams.result as unknown as ElementPort;
  teams.update({ ...view(frame), share: "https://antwars.example/?replay=2026-10-28-12" }, false);
  return { dialog, link: dialog.byClass("d1-share")[0]! };
}
