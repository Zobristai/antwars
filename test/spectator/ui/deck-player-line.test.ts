// The watch and replay screen's colony panels, mounted in the test DOM port: each agent row and the one-player heading
// read one player line in the Matches order, the rating is the cyan figure with its "± RD" in the tip on hover, tap or
// focus, and the colony's result joins the line once the match has ended. Not rendering evidence.
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUB_TILE, type StreamAgent, type StreamResult } from "../../../src/live/format.ts";
import { mountTeams } from "../../../web/src/ui/deck/pane.ts";
import type { HudActions, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const TICK = 600;
function agent(colony: 0 | 1, identity: StreamAgent["identity"] | null, model: string, extra: Partial<StreamAgent> = {}): StreamAgent {
  return { ...(identity === null ? {} : { identity }), colony, modelLabel: model, joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 40,
    order: "forage", orderX: 0, orderY: 0, intent: "", ...extra };
}
function frameOf(agents: StreamAgent[], result: StreamResult | null = null): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = TICK * 100;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: true, rules: "redesign" },
    queens: [], territory: new Uint8Array(0), held: [0, 0], marks: [], agents, overrun: [0, 0], overrunRequired: 100, deaths: [0, 0],
    result, food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 0, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 0, nextHatchTick: TICK + 10, nextCost: 3 }],
  } as unknown as Board;
  f.board = b;
  return f;
}

function mounted() {
  const port = dom();
  const picked: number[] = [];
  const actions = { hover() {}, pointOrder() {}, select() {}, selectAgent: (index: number) => picked.push(index), focusMark() {} } as unknown as HudActions;
  const economy = [port.doc.createElement("div"), port.doc.createElement("div")] as unknown as [HTMLElement, HTMLElement];
  const teams = mountTeams(port.doc, actions, { search: () => "", economy });
  for (const team of teams.teams) port.body.append(team as unknown as ElementPort);
  const update = (frame: Frame) => teams.update({ frame, connection: "live", board: "3d", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView, false);
  const team = (colony: 0 | 1) => teams.teams[colony] as unknown as ElementPort;
  /** A part's visible words: hidden parts and screen-reader-only text left out. */
  const parts = (node: ElementPort): string => node.hidden ? "" : node.tag === "#text" ? node.textContent
    : node.children.length === 0 ? node.textContent : node.children.map(parts).filter(Boolean).join(" ");
  const shown = (node: ElementPort): string => parts(node).replace(/\s+/g, " ").trim();
  const tip = () => team(0).byClass("d1-tip")[0]!;
  return { port, update, team, shown, tip, picked };
}

const kite = { displayName: "kite", elo: 1540.4, rd: 87.2 };
const house = { displayName: "antwars/gpt-6-luna", elo: 1979 };

describe("a colony panel's player line", () => {
  it("reads name, model, level and Fast, then the cyan figure alone, in each agent row; no Rating word, no quiet level", () => {
    const m = mounted();
    m.update(frameOf([agent(0, house, "openai/gpt-6-luna"), agent(1, kite, "openai/gpt-6.1-terra", { thinkingLevel: "high", serviceTier: "fast" })]));
    const rows = [0, 1].map(colony => m.team(colony as 0 | 1).byClass("d1-who")[0]!);
    expect(rows.map(m.shown)).toEqual(["GPT-6 Luna max Fast 1979", "kite GPT-6.1 Terra high Fast 1540"]);
    expect(rows[1]!.children.filter(part => !part.hidden).map(part => part.className)).toEqual(["d1-title-box", "d1-model-box", "d1-tag d1-elo"]);
    const all = m.team(0).textContent + m.team(1).textContent;
    expect(all).not.toContain("Rating");
    expect(all).not.toContain("(high)");
    // One seat a colony: no heading line, from the first frame on.
    expect([0, 1].map(colony => m.team(colony as 0 | 1).byClass("d1-team-player")[0]!.hidden)).toEqual([true, true]);
  });

  it("shows the rating's ± RD in the tip on a pointer, a tap that opens no card, and the row's keyboard focus", () => {
    const m = mounted();
    m.update(frameOf([agent(0, house, "openai/gpt-6-luna"), agent(1, kite, "openai/gpt-6.1-terra")]));
    const rowElo = (colony: 0 | 1) => m.team(colony).byClass("d1-who")[0]!.byClass("d1-elo")[0]!;
    const elo = rowElo(1);
    expect(elo.getAttribute("data-rd")).toBe("");
    elo.fire("pointerenter", { pointerType: "mouse" });
    expect([m.tip().hidden, m.tip().textContent]).toEqual([false, "± 87"]);
    elo.fire("pointerleave", { pointerType: "mouse", relatedTarget: null });
    expect(m.tip().hidden).toBe(true);
    let stopped = false;
    elo.fire("click", { stopPropagation: () => { stopped = true; } });
    expect([stopped, m.tip().hidden, m.picked]).toEqual([true, false, []]);
    const row = m.team(1).byClass("d1-agent")[0]! as ElementPort & { matches(selector: string): boolean };
    row.matches = selector => selector === ":focus-visible";
    row.fire("blur"); expect(m.tip().hidden).toBe(true);
    row.fire("focus");
    expect([m.tip().hidden, m.tip().textContent]).toEqual([false, "± 87"]);
    // A rating without an RD (an older stream) shows the figure with no tip.
    const plain = rowElo(0);
    expect(plain.getAttribute("data-rd")).toBeNull();
    row.fire("blur");
    plain.fire("pointerenter", { pointerType: "mouse" });
    expect(m.tip().hidden).toBe(true);
  });

  it("gives one player holding every seat its line once in the heading: name, model, badges, rating, ×N, its rating focusable", () => {
    const m = mounted();
    const seats = (colony: 0 | 1, name: string, identity: { elo: number; rd?: number }, model: string, extra: Partial<StreamAgent> = {}) =>
      [1, 2, 3, 4].map(seat => agent(colony, { elo: identity.elo, ...(identity.rd === undefined ? {} : { rd: identity.rd }), displayName: `${name} #${seat}` }, model, extra));
    m.update(frameOf([...seats(0, "antwars/k3-1-pro-highspeed", { elo: 1662, rd: 60 }, "k"), ...seats(1, "kite", kite, "openai/gpt-6.1-terra", { thinkingLevel: "max" })]));
    const head = (colony: 0 | 1) => m.team(colony).byClass("d1-team-player")[0]!;
    expect([m.shown(head(0)), m.shown(head(1))]).toEqual(["K3.1 Pro Highspeed high 1662 ×4", "kite GPT-6.1 Terra max 1540 ×4"]);
    expect(m.team(0).byClass("d1-agent")).toHaveLength(0);
    expect(m.team(0).byClass("d1-member")).toHaveLength(4);
    const elo = head(1).byClass("d1-elo")[0]!;
    expect([elo.tabIndex, elo.getAttribute("aria-label")]).toEqual([0, "Rating 1540 ± 87"]);
    elo.fire("focus");
    expect([m.tip().hidden, m.tip().textContent]).toEqual([false, "± 87"]);
  });

  it("adds WINNER, DRAW or ABANDONED in the colony's ink once the match has ended, and nothing before", () => {
    const m = mounted();
    const agents = [agent(0, house, "openai/gpt-6-luna"), agent(1, kite, "openai/gpt-6.1-terra")];
    const results = (colony: 0 | 1) => m.team(colony).byClass("d1-who")[0]!.byClass("d1-outcome").filter(node => !node.hidden).map(node => [node.textContent, node.className]);
    m.update(frameOf(agents));
    expect([results(0), results(1)]).toEqual([[], []]);
    const end = (result: Partial<StreamResult>) => ({ winner: null, reason: "time_up", decidedBy: "territory", tick: TICK, nextStartMs: null, ...result }) as StreamResult;
    m.update(frameOf(agents, end({ winner: 1 })));
    expect([results(0), results(1)]).toEqual([[], [["Winner", "d1-tag d1-outcome c1"]]]);
    m.update(frameOf(agents, end({ decidedBy: "draw" })));
    expect([results(0), results(1)]).toEqual([[["Draw", "d1-tag d1-outcome c0"]], [["Draw", "d1-tag d1-outcome c1"]]]);
    m.update(frameOf(agents, end({ winner: 0, reason: "abandoned" })));
    expect([results(0), results(1)]).toEqual([[["Abandoned", "d1-tag d1-outcome c0"]], [["Abandoned", "d1-tag d1-outcome c1"]]]);
  });

  it("shows a builder whose label only repeats its own name by its name alone, as a Matches line does", () => {
    const m = mounted();
    m.update(frameOf([agent(0, { displayName: "omp-dolphin", elo: 1351 }, "omp-dolphin/local"), agent(1, kite, "x")]));
    expect(m.shown(m.team(0).byClass("d1-who")[0]!)).toBe("omp-dolphin 1351");
  });

  it("keeps the asterisk after a self-reported model and the seat icons' tips", () => {
    const m = mounted();
    m.update(frameOf([agent(0, null, "anthropic/claude-haiku-5-5", { thinkingLevel: "medium" }), agent(1, kite, "x")]));
    const who = m.team(0).byClass("d1-who")[0]!;
    expect(m.shown(who)).toBe("Claude Haiku 5.5 medium *");
    const icon = m.team(1).byClass("d1-member")[0]!;
    icon.fire("pointerenter", { pointerType: "mouse" });
    expect(m.tip().textContent).toContain("Rating 1540");
  });
});
