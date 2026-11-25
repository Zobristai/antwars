import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountDeckHud } from "../../../web/src/ui/deck/hud.ts";
import { balance, winConditions } from "../../../web/src/ui/deck/model.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { scoreFrame } from "./score-band-frame.ts";

const visible = (n: ElementPort): boolean => !n.hidden && (!n.parent || visible(n.parent));
function evalMedia(query: string, width: number, height: number, rootPx: number): boolean {
  const parts = query.split(/\s+and\s+/i);
  return parts.every(part => {
    const m = /\((min|max)-(width|height):\s*([\d.]+)(px|em)\)/i.exec(part);
    if (!m) return false;
    const bound = m[1]!.toLowerCase(), axis = m[2]!.toLowerCase();
    const limit = Number(m[3]) * (m[4]!.toLowerCase() === "em" ? rootPx : 1);
    const value = axis === "width" ? width : height;
    return bound === "min" ? value >= limit : value <= limit;
  });
}
function mount(board: "2d" | "3d", width = 1280, height = 800, rootPx = 16) {
  const port = dom({ wide: true });
  let curW = width, curH = height, curRoot = rootPx;
  const queries: { query: string; matches: boolean; listeners: Set<(e: Event) => void> }[] = [];
  port.win.matchMedia = (query = "") => {
    const entry = { query, matches: evalMedia(query, curW, curH, curRoot), listeners: new Set<(e: Event) => void>() };
    queries.push(entry);
    return {
      media: query,
      get matches() { return entry.matches; },
      onchange: null,
      addEventListener(_type: string, fn: (e: Event) => void) { entry.listeners.add(fn); },
      removeEventListener(_type: string, fn: (e: Event) => void) { entry.listeners.delete(fn); },
      addListener() {}, removeListener() {}, dispatchEvent() { return true; },
    } as unknown as MediaQueryList;
  };
  const resizeTo = (nextW: number, nextH = curH, nextRoot = curRoot) => {
    curW = nextW; curH = nextH; curRoot = nextRoot;
    for (const entry of queries) {
      const next = evalMedia(entry.query, curW, curH, curRoot);
      if (next !== entry.matches) {
        entry.matches = next;
        for (const fn of [...entry.listeners]) fn(new Event("change"));
      }
    }
  };
  Object.assign(port.win.location, { href: `https://antwars.example/?board=${board}`, pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort; port.body.append(host);
  let selectedAgent = -1;
  const actions = { select() {}, selectAgent(index: number) { selectedAgent = index; }, pointOrder() {}, hover() {}, focusMark() {}, openSheet() {} } as unknown as HudActions;
  const hud = mountDeckHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
  return { host, doc: port.doc, events: port.events, hud, resizeTo, chosen: () => selectedAgent,
    show: (frame: ReturnType<typeof scoreFrame> | null) => hud.update({ frame, board, connection: "live", selected: null, selectedAgent, mode: null, stalled: false } as HudView) };
}

describe("one Score Band for every match", () => {
  it("keeps the ordered figures and their accessible names as the colony count changes", () => {
    const { host, show } = mount("2d");
    for (const count of [2, 3, 4, 2]) {
      const frame = scoreFrame(count, count * 2);
      frame.board!.kills = Array.from({ length: count }, (_, i) => 10 + i);
      show(frame);
      const scores = balance(frame);
      const gauges = host.byClass("sb-gauge");
      expect(gauges.map(g => g.byClass("d1-ml")[0]!.textContent)).toEqual(["Kills", "Territory", "Ants"]);
      for (const [index, gauge] of gauges.entries()) {
        const figures = gauge.byClass("sb-figure").filter(visible);
        expect(figures).toHaveLength(count);
        expect(figures.map(f => f.byClass("sb-value")[0]!.textContent)).toEqual([scores.kills, scores.territory, scores.ants][index]!.figures);
        for (const f of figures) {
          expect(f.byClass("sb-swatch")[0]!.getAttribute("aria-hidden")).toBe("true");
          expect(f.byClass("d1-sr")[0]!.textContent).toMatch(/.+: /);
        }
      }
    }
    show(scoreFrame(4)); // No explicit kills on this older frame.
    expect(host.byClass("sb-gauge")[0]!.byClass("sb-figure").filter(visible)).toHaveLength(0);
  });
  for (const width of [390, 1100, 1180, 1199, 1200, 1280]) {
    it(`keeps reading order consistent with the ${width}px layout`, () => {
      const { host, show } = mount("2d", width); show(scoreFrame(4));
      const root = host.byClass("d1-hud")[0]!, frame = host.byClass("d1-frame")[0]!, below = host.byClass("d1-below")[0]!;
      expect(root.children.indexOf(below) < root.children.indexOf(frame)).toBe(width >= 1200);
      expect(host.byClass("d1-foot")[0]!.parent).toBe(width >= 1200 ? root : below);
    });
  }
  for (const board of ["2d", "3d"] as const) for (const grouped of [false, true]) {
    it(`keeps each ${grouped ? "grouped" : "individual"} seat's identity and idle state in ${board}`, () => {
      const { host, doc, show, chosen } = mount(board), frame = scoreFrame(2, 8);
      if (grouped) frame.board!.agents.forEach((a, index) => {
        a.identity = { displayName: `player-${index % 2} #${Math.floor(index / 2) + 1}`, elo: 1500 };
      });
      show(frame);
      const members = host.byClass("d1-member").filter(visible);
      expect(members).toHaveLength(8);
      const first = members[0]!, label = first.getAttribute("aria-label")!;
      const idle = first.byClass("sb-idle")[0]!;
      expect(idle, "every seat reserves an idle slot").toBeDefined();
      expect(idle.getAttribute("aria-hidden")).toBe("true");
      expect(idle.hidden).toBe(false);
      expect(idle.classList.contains("is-idle")).toBe(false);
      if (grouped) first.focus();
      frame.tick = 9000; show(frame);
      expect(host.byClass("d1-member").filter(visible)[0]).toBe(first);
      expect(first.getAttribute("aria-label")).toBe(`${label} · idle`);
      expect(idle.classList.contains("is-idle")).toBe(true);
      if (grouped) {
        expect(doc.activeElement).toBe(first);
        first.click(); show(frame); expect(chosen()).toBe(0);
        const selected = host.byClass("d1-selected")[0]!;
        selected.fire("keydown", { key: "Escape", preventDefault() {} }); show(frame);
        expect(doc.activeElement).toBe(first);
      } else {
        const picks = host.byClass("d1-agent-pick").filter(visible);
        expect(picks).toHaveLength(8);
        for (const row of picks) {
          expect(row.tag).toBe("button");
          expect(row.getAttribute("aria-label")).toContain("player-");
          expect(row.getAttribute("aria-label")).toMatch(/ · idle$/);
        }
      }
      frame.board!.agents.forEach(a => { a.lastCallTick = frame.tick; a.lastCommandTick = frame.tick; });
      frame.tick += 10; show(frame);
      expect(first.getAttribute("aria-label")).toBe(label);
      expect(idle.classList.contains("is-idle")).toBe(false);
      expect(idle.hidden).toBe(false);
    });
  }
  for (const board of ["2d", "3d"] as const) {
    it(`offers the existing match Key beside Rules in ${board}`, () => {
      const { host, show } = mount(board); show(scoreFrame(2));
      const button = host.byClass("sb-key-toggle")[0]!, key = host.byClass("sb-key")[0]!;
      expect(button, "Key toggle exists").toBeDefined();
      expect(button.tag).toBe("button"); expect(button.type).toBe("button");
      expect(button.getAttribute("aria-label")).toBe("Key");
      expect(button.getAttribute("aria-controls")).toBe(key.id);
      expect(button.getAttribute("aria-expanded")).toBe("false"); expect(key.hidden).toBe(true);
      const group = host.byClass("sb-rules-key")[0]!;
      expect(group.children[0]!.textContent).toBe("Rules"); expect(group.children[1]).toBe(button);
      button.click(); expect(button.getAttribute("aria-expanded")).toBe("true"); expect(visible(key)).toBe(true);
      expect(key.textContent.replaceAll("\u00a0", " ")).toContain("colour and shape = agent");
      expect(key.textContent).toContain("Thoughts: an agent's stated intent, not observed action");
      expect(key.textContent).toContain("Agents direct squads with orders and free ants with count marks.");
      show(null); expect(key.textContent).toContain("Marks are the only messages between teammates");
      button.click(); expect(key.hidden).toBe(true); expect(button.getAttribute("aria-expanded")).toBe("false");
    });
  }

  for (const board of ["2d", "3d"] as const) {
    it(`shows all eight distinct agents and their badges in ${board}`, () => {
      const { host, show } = mount(board); show(scoreFrame(2, 8));
      expect(host.byClass("d1-team").filter(visible)).toHaveLength(2);
      const rows = host.byClass("d1-agent-pick").filter(visible);
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
      if (seats === 8) {
        const pick = host.byClass("d1-agent-pick").find(n => n.getAttribute("aria-label")?.includes(name));
        expect(pick?.getAttribute("aria-label")).toContain(model);
      }
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
  for (const board of ["2d", "3d"] as const) {
    it(`restores cumulative hatched totals only inside expanded colony details in ${board}`, () => {
      const { host, show } = mount(board), frame = scoreFrame(2);
      frame.ensure(2); frame.count = 2; frame.colony[0] = 0; frame.colony[1] = 1;
      frame.board!.deaths = [1248, 60]; frame.board!.hatched = [2, 3];
      show(frame);
      const details = host.byClass("sb-detail-stat");
      expect(details.filter(visible)).toHaveLength(0);
      const button = host.byClass("sb-history")[0]!; button.click();
      expect(details.filter(visible)).toHaveLength(1);
      expect(details[0]!.textContent).toBe("Hatched1,249"); // includes starting ants, as the former drawer did
      expect(host.byClass("sb-columns")[0]!.textContent).not.toContain("Hatched");
      frame.board!.deaths = [1250, 60]; frame.tick++;
      show(frame); expect(details[0]!.textContent).toBe("Hatched1,251");
      button.click(); expect(details.filter(visible)).toHaveLength(0);
      show(null); expect(details[0]!.textContent).toBe("Hatched—");
      show(scoreFrame(4)); expect(host.byClass("d1-team").filter(visible)).toHaveLength(4);
    });
    it(`opens every grouped seat's own thoughts, marks and orders in ${board} in numbered seat order`, () => {
      const { host, doc, show, chosen } = mount(board), frame = scoreFrame(2, 8);
      const seats = [1, 1, 2, 4, 4, 3, 3, 2];
      frame.board!.agents.forEach((a, index) => {
        a.identity = { displayName: `player-${index % 2} #${seats[index]}`, elo: 1500 };
        a.order = index % 2 ? "hold" : "forage";
        frame.chat.push({ kind: "intent", agent: index, colony: a.colony, tick: 5900, text: `seat-thought-${index}`,
          words: [], markId: -1, tileX: 0, tileY: 0, laidTick: -1 },
          { kind: "mark", agent: index, colony: a.colony, tick: 5910, text: "", words: [], verb: "need", count: index + 7,
            markId: index, tileX: index, tileY: 1, laidTick: 5910 });
      });
      show(frame);
      expect(host.byClass("d1-agent").filter(visible)).toHaveLength(0);
      expect(host.byClass("d1-team-player").filter(visible)).toHaveLength(2);
      const controls = host.byClass("d1-member").filter(visible);
      expect(controls).toHaveLength(8);
      expect(controls.map(c => c.getAttribute("aria-label")!.split(" · ")[0])).toEqual(
        [0, 1].flatMap(colony => [1, 2, 3, 4].map(seat => `player-${colony} #${seat}`)));
      for (const control of controls) {
        expect(control.tag).toBe("button"); expect(control.type).toBe("button");
        expect(control.getAttribute("aria-label")).toContain("badge");
        expect(control.getAttribute("aria-controls")).toBe("score-band-selected");
        control.click(); show(frame);
        const index = chosen(), selected = host.byClass("d1-selected")[0]!;
        expect(visible(selected)).toBe(true);
        expect(doc.activeElement).toBe(selected);
        expect(control.getAttribute("aria-expanded")).toBe("true");
        const glyph = (html: string) => /<polygon points="([^"]+)"/.exec(html)?.[1];
        const rowGlyph = glyph(control.byClass("sb-seat-badge")[0]!.html);
        expect(rowGlyph).toBeDefined();
        expect(glyph(selected.byClass("d1-badge")[0]!.html)).toBe(rowGlyph);
        expect(control.getAttribute("aria-label")).toContain(selected.byClass("d1-sel-name")[0]!.textContent);
        expect(controls.filter(c => c.getAttribute("aria-expanded") === "true")).toEqual([control]);
        expect(selected.textContent).toContain(`seat-thought-${index}`);
        expect(selected.textContent).toContain(`Squad order: ${index % 2 ? "hold" : "forage"}`);
        expect(selected.byClass("d1-history-line").some(line => line.getAttribute("aria-label")?.includes("Mark,"))).toBe(true);
        expect(selected.textContent).not.toContain(`seat-thought-${(index + 1) % 8}`);
        selected.fire("keydown", { key: "Escape", preventDefault() {} }); show(frame);
        expect(chosen()).toBe(-1); expect(doc.activeElement).toBe(control);
        expect(control.getAttribute("aria-expanded")).toBe("false");
        expect(host.byClass("d1-agent").filter(visible)).toHaveLength(0);
      }
    });
  }
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
  it("opens and closes the Site pages menu by click, Escape, outside pointerdown and wide resize", () => {
    const { host, doc, events, resizeTo, hud } = mount("3d", 390, 844);
    const root = host.byClass("d1-hud")[0]!;
    const top = host.byClass("d1-top")[0]!;
    const pages = host.byClass("d1-pages")[0]!;
    const nav = host.byClass("d2-nav")[0]!;
    expect(pages.tag).toBe("button");
    expect(pages.type).toBe("button");
    expect(pages.textContent).toBe("Site pages");
    expect(pages.getAttribute("aria-expanded")).toBe("false");
    expect(pages.getAttribute("aria-controls")).toBe(nav.id);
    expect(pages.byClass("d1-pages-chevron")[0]!.getAttribute("aria-hidden")).toBe("true");
    // Tab order: Site pages sits directly before the page links, with Watch marked current.
    expect(top.children.indexOf(pages) + 1).toBe(top.children.indexOf(nav));
    expect(nav.children.map(link => [link.textContent, link.getAttribute("aria-current")])).toEqual([
      ["Watch", "page"], ["Matches", null], ["Leaderboard", null], ["Users", null],
    ]);
    pages.click();
    expect(root.dataset.menu).toBe("open");
    expect(pages.getAttribute("aria-expanded")).toBe("true");
    // Pointerdown inside the bar keeps the menu open; outside closes it.
    events.fire("pointerdown", { target: nav });
    expect(root.dataset.menu).toBe("open");
    events.fire("pointerdown", { target: root });
    expect(root.dataset.menu).toBeUndefined();
    expect(pages.getAttribute("aria-expanded")).toBe("false");
    // Escape closes and returns focus to the Site pages button.
    pages.click();
    nav.children[0]!.focus();
    root.fire("keydown", { key: "Escape" });
    expect(root.dataset.menu).toBeUndefined();
    expect(pages.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(pages);
    // Crossing wider than 32.5em closes the menu automatically.
    pages.click();
    expect(root.dataset.menu).toBe("open");
    resizeTo(1280, 800, 16);
    expect(root.dataset.menu).toBeUndefined();
    expect(pages.getAttribute("aria-expanded")).toBe("false");
    hud.destroy();
  });
  it("moves metadata and board controls into the scroller under 75em, joins the window on short narrow screens, and restores cleanly", () => {
    const { host, doc, resizeTo, hud } = mount("3d", 1280, 800, 16);
    const root = host.byClass("d1-hud")[0]!;
    const frame = host.byClass("d1-frame")[0]!;
    const below = host.byClass("d1-below")[0]!;
    const metadata = host.byClass("sb-metadata")[0]!;
    const lane = host.byClass("d1-lane")[0]!;
    const hole = host.byClass("d1-window")[0]!;
    // Wide desktop: metadata and lane stand in the frame around the board window.
    expect(frame.children.map(c => c.className)).toEqual(["d1-legend", "sb-metadata", "d1-window", "d1-lane"]);
    expect(root.classList.contains("d1-joined")).toBe(false);
    // Doubled text at 1280x800 (40em < 75em): stacks metadata and lane at the start of the scroller.
    const boardToggle = host.byClass("d1-btn-board")[0]!;
    boardToggle.focus();
    resizeTo(1280, 800, 32);
    expect(frame.children.map(c => c.className)).toEqual(["d1-legend", "d1-window"]);
    expect(below.children[0]).toBe(metadata);
    expect(below.children[1]).toBe(lane);
    expect(root.classList.contains("d1-joined")).toBe(false);
    expect(doc.activeElement).toBe(boardToggle);
    // Short narrow screen (320x568 at doubled text: 10em x 17.75em): window joins scroller first.
    resizeTo(320, 568, 32);
    expect(root.classList.contains("d1-joined")).toBe(true);
    expect(below.children[0]).toBe(frame);
    expect(below.children[1]).toBe(metadata);
    expect(below.children[2]).toBe(lane);
    expect(hole.parent).toBe(frame);
    // Returning to tall phone restores frame outside the scroller.
    resizeTo(320, 844, 32);
    expect(root.classList.contains("d1-joined")).toBe(false);
    expect(frame.parent).toBe(root);
    expect(below.children[0]).toBe(metadata);
    expect(below.children[1]).toBe(lane);
    // Returning to desktop restores metadata and lane inside the frame.
    resizeTo(1280, 800, 16);
    expect(frame.children.map(c => c.className)).toEqual(["d1-legend", "sb-metadata", "d1-window", "d1-lane"]);
    hud.destroy();
  });
});
