import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import { balance, winConditions } from "../../../web/src/ui/deck/model.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { scoreFrame } from "./score-band-frame.ts";

const visible = (n: ElementPort): boolean => !n.hidden && (!n.parent || visible(n.parent));
function mount(board: "2d" | "3d") {
  const port = dom({ wide: true });
  Object.assign(port.win.location, { href: `https://antwars.example/?board=${board}`, pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort; port.body.append(host);
  const actions = { select() {}, selectAgent() {}, pointOrder() {}, hover() {}, focusMark() {}, openSheet() {} } as unknown as HudActions;
  const hud = mountDeckHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  return { host, show: (frame: ReturnType<typeof scoreFrame>) => hud.update({ frame, board, connection: "live", selected: null, selectedAgent: -1, mode: null, stalled: false } as HudView) };
}

describe("one Score Band for every match", () => {
  for (const board of ["2d", "3d"] as const) {
    it(`shows all eight distinct agents and their badges in ${board}`, () => {
      const { host, show } = mount(board); show(scoreFrame(2, 8));
      expect(host.byClass("d1-team").filter(visible)).toHaveLength(2);
      const rows = host.byClass("d1-agent").filter(visible);
      expect(rows).toHaveLength(8);
      for (let i = 0; i < 8; i++) expect(rows.some(r => r.getAttribute("aria-label")?.includes(`player-${i}`))).toBe(true);
      expect(host.byClass("d1-member").filter(visible)).toHaveLength(8);
      expect(host.byClass("sb-gauge").filter(visible)).toHaveLength(3);
      expect(host.byClass("d1-btn-board")[0]!.textContent).toBe(board === "2d" ? "3D" : "2D");
    });
  }
  it("keeps complete field-limit names and models in the text, hover titles and row accessibility", () => {
    const name = "N".repeat(32), model = "W".repeat(64);
    for (const seats of [4, 8]) {
      const { host, show } = mount("2d"), frame = scoreFrame(4, seats);
      frame.board!.agents[0]!.identity = { displayName: name, elo: 1500 };
      frame.board!.agents[0]!.modelLabel = model;
      show(frame);
      const names = host.byClass("d1-title").filter(visible), models = host.byClass("d1-model").filter(visible);
      expect(names.some(n => n.textContent === name && n.title === name)).toBe(true);
      expect(models.some(n => n.textContent === model && n.title === model)).toBe(true);
      if (seats === 8) expect(host.byClass("d1-agent").some(n => n.getAttribute("aria-label")?.includes(model))).toBe(true);
    }
  });
  it("retains full hover text when one player owns all four team seats", () => {
    const name = "N".repeat(32), model = "W".repeat(64);
    const { host, show } = mount("3d"), frame = scoreFrame(2, 8);
    frame.board!.agents.forEach((a, i) => {
      a.identity = { displayName: `${i % 2 ? "OtherPlayer" : name} #${Math.floor(i / 2) + 1}`, elo: 1500 };
      a.modelLabel = model;
    });
    show(frame);
    const players = host.byClass("d1-team-player").filter(visible);
    expect(players).toHaveLength(2);
    expect(players[0]!.byClass("d1-title")[0]!.title).toBe(name);
    expect(players[0]!.byClass("d1-model")[0]!.title).toBe(model);
    expect(players[0]!.byClass("d1-team-player-name")[0]!.title).toBe(`${name} ${model}`);
  });
  it("routes both actual board hosts to the shared component", () => {
    const source = readFileSync(new URL("../../../web/src/overlays.ts", import.meta.url), "utf8");
    expect(source).toContain("this.hud = mountDeckHud({");
    expect(source).not.toContain("board.deck ? mountDeckHud : mountHud");
  });
  it("uses the server's four-colony majority hold, never a pair's 6:1 marker or a made-up countdown", () => {
    const f = scoreFrame(4); f.board!.held = [10, 10, 60, 20];
    expect(balance(f).lead).toBeNull();
    expect(balance(f).leadText).toContain("More than half of all owned territory");
    expect(winConditions(f).hold).toEqual([null, null, null, null]);
    f.board!.territoryWin = { colony: 2, startTick: 5900, winTick: 6100 };
    expect(winConditions(f).hold[2]).toMatchObject({ text: "win in 0:11" });
    expect(winConditions(f).hold.filter(h => h !== null)).toHaveLength(1);
    f.board!.territoryWin = { colony: 3, startTick: 6000, winTick: 6200 };
    expect(winConditions(f).hold.every(h => h === null)).toBe(true);
  });
  it("does not infer four-colony kills from death counts", () => {
    const f = scoreFrame(4); f.board!.deaths = [100, 300, 200, 50];
    expect(balance(f).kills.figures).toEqual(["—", "—", "—", "—"]);
    f.board!.kills = [1, 5, 3, 7];
    expect(balance(f).kills.figures).toEqual(["1", "5", "3", "7"]);
  });
});
