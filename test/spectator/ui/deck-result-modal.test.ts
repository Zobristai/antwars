// The match result as a modal over the whole screen, not under the score. The DOM half mounts the deck's score and team pane on the test port and drives them
// with frames; the stylesheet half reads deck.css's contracts. Neither is visual evidence: browser captures are that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { mountDeck } from "../../../web/src/ui/deck/deck.ts";
import { mountTeams } from "../../../web/src/ui/deck/pane.ts";
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
    const { dialog, score, show } = mount();
    show(frameOf({ ended: false }));
    expect(dialog.tag).toBe("dialog");
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(true);
    const head = dialog.byClass("d1-result-head")[0]!;
    // The headline names the winning model, not the colony; the colony and whom it beat stand under it.
    expect(head.textContent).toBe("fennec/forager wins");
    expect(dialog.byClass("d1-result-detail")[0]!.textContent).toBe("Very Large Colony · beat tidewater");
    expect((head.style as unknown as { color: string }).color).toBe("var(--aw-c0)");
    expect(dialog.byClass("d1-result-how")[0]!.textContent).toBe("Queens killed");
    expect(dialog.byClass("d1-ratings")[0]!.textContent).toBe("Unrated match · no rating change");
    expect(dialog.getAttribute("aria-labelledby")).toBe(head.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(dialog.byClass("d1-result-how")[0]!.id);
    expect(closeButton(dialog).getAttribute("aria-label")).toBe("Close");
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
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toBe("tidewater wins");
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
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toBe("fennec/forager wins");
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

  it("draws Share in the site's cyan button, with no grey treatment of its own", () => {
    const { dialog } = shareDialog(frameOf({ ended: true }));
    expect(dialog.byClass("d1-share")[0]!.classes()).toEqual(["d1-agent-button", "d1-share"]);
    // .d1-share only places it; the button's look is .d1-agent-button's alone.
    expect(CSS).toContain(".d1-share { justify-self: start; margin-top: 8px; }");
    expect(CSS).not.toMatch(/\.d1-share[^{]*\{[^}]*(background|color|border-radius|padding)/);
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

// The result stays on the plate after the card is closed: a WINNER badge on the winning colony's head, or DRAW on both.
describe("the plate's result badge", () => {
  const badges = (teams: ElementPort[]) => teams.map(team => team.byClass("d1-plate-badge")[0]!)
    .map(node => [node.hidden, node.textContent, node.classes().includes("is-draw")]);
  function mountWithTeams() {
    const port = dom();
    const deck = mountDeck(port.doc);
    const teams = mountTeams(port.doc, actions, { search: () => "", economy: deck.economy });
    port.body.append(...teams.teams as unknown as ElementPort[], teams.result as unknown as ElementPort);
    const show = (frame: Frame) => { deck.update(frame); teams.update(view(frame), false); };
    return { teams: teams.teams as unknown as ElementPort[], dialog: teams.result as unknown as ElementPort, show };
  }

  it("shows nothing before the result, WINNER on the winning colony once it shows, and keeps it after Close", () => {
    const { teams, dialog, show } = mountWithTeams();
    show(frameOf({ ended: false }));
    expect(badges(teams)).toEqual([[true, "", false], [true, "", false]]);
    show(frameOf({ ended: true, winner: 1 }));
    expect(badges(teams)).toEqual([[true, "", false], [false, "Winner", false]]);
    closeButton(dialog).click();
    show(frameOf({ ended: true, winner: 1 }));
    expect(dialog.open).toBe(false);
    expect(badges(teams)).toEqual([[true, "", false], [false, "Winner", false]]);
    // In the colony's head, right after its name.
    expect(teams[1]!.byClass("d1-team-head")[0]!.children.map(node => node.className).slice(0, 2)).toEqual(["d1-name c1", "d1-plate-badge c1"]);
  });

  it("shows DRAW on both colonies for a draw, and names neither side as winner in the card", () => {
    const { teams, dialog, show } = mountWithTeams();
    const draw = frameOf({ ended: true });
    draw.board!.result = { winner: null, reason: "time_up", decidedBy: "draw", tick: END, nextStartMs: null };
    show(draw);
    expect(badges(teams)).toEqual([[false, "Draw", true], [false, "Draw", true]]);
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toBe("Draw");
    expect(dialog.byClass("d1-result-detail")[0]!.textContent).toBe("fennec/forager drew with tidewater");
    expect(dialog.textContent).not.toMatch(/ wins| beat /);
  });

  it("draws the badge and every line of the result card at 16 px or more", () => {
    expect(CSS).toMatch(/\.d1-plate-badge \{[^}]*font-size: 16px;/);
    expect(CSS).toMatch(/\.d1-result \{[^}]*font-size: 16px;/);
    const result = CSS.slice(CSS.indexOf(".d1-result {"), CSS.indexOf("/* Share on X"));
    for (const size of result.matchAll(/font-size: (\d+)px/g)) expect(Number(size[1])).toBeGreaterThanOrEqual(16);
  });
});
