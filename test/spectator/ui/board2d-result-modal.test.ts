// The 2D board's match result is the deck's modal over the whole screen, not a card under the score:
// one shared modal (deck/result-modal.ts), and the old
// result card in the pane is gone. Mounts the 2D HUD on the test port and drives it with frames; not visual evidence:
// browser captures are that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Frame, type Board } from "../../../web/src/buffer.ts";
import { SUB_TILE, type StreamAgent, type StreamQueen } from "../../../src/live/format.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import type { HudActions, HudHost, HudView } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const UI_CSS = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8");
const DECK_CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const TICK = 7540;
const END = TICK - 100;

function queen(id: number, colony: 0 | 1, tile: number, hp: number, lostTick: number | null = null): StreamQueen {
  return { id, colony, x: tile * SUB_TILE + 2, y: 20 * SUB_TILE + 2, foundedTick: 0, lostTick, overrun: 0, hp };
}
function agent(colony: 0 | 1, name: string, elo: number): StreamAgent {
  return { identity: { displayName: name, elo }, colony, modelLabel: "claude-sonnet-5", joinTick: 0, lastCallTick: TICK - 20, prevCallTick: TICK - 62, lastCommandTick: TICK - 30, order: "forage", orderX: 0, orderY: 0, intent: "" };
}

/** A 1v1 on the redesign rules, ended at END by queens killed when `ended`; `match` as Playback counts it (Frame.match). */
function frameOf(o: { ended: boolean; atMs?: number; match?: number }): Frame {
  const f = new Frame();
  f.tick = TICK; f.targetMs = o.atMs ?? TICK * 100 + 10_000; f.match = o.match ?? 1;
  f.ensure(0); f.count = 0;
  const b: Board = {
    setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 1800, overrunRadiusTiles: 3,
      queens: [[8 * SUB_TILE, 20 * SUB_TILE], [50 * SUB_TILE, 20 * SUB_TILE]], rated: false, rules: "redesign" },
    queens: [queen(0, 0, 8, 40000), queen(0, 1, 50, 0, END)],
    territory: new Uint8Array(0), held: [870, 130], marks: [], agents: [agent(0, "fennec/forager", 1512.37), agent(1, "tidewater", 1488.6)],
    overrun: [0, 0], overrunRequired: 100, deaths: [31, 48],
    result: o.ended ? { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: END, nextStartMs: null } : null,
    food: new Uint32Array(0), hatch: { cost: 3, intervalTicks: 20, cap: 512 },
    stores: [{ food: 57, nextHatchTick: TICK + 10, nextCost: 3 }, { food: 2, nextHatchTick: TICK - 10, nextCost: 6 }],
  };
  f.board = b;
  return f;
}

const actions = { select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
const view = (frame: Frame | null): HudView => ({ frame, connection: "live", board: "2d", selected: null, selectedAgent: -1, mode: null, stalled: false });

function mount() {
  const port = dom({ search: "?board=2d" });
  // The 2D board's toggle links back to the 3D view from the page's own address.
  Object.assign(port.win.location, { href: "https://antwars.example/?board=2d", pathname: "/" });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  // None of the board's own live controls here.
  const context = { doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost;
  const hud = mountHud(context);
  const dialogs = () => host.all().filter(node => node.tag === "dialog" && node.classes().includes("d1-result-dialog"));
  return { host, hud, dialogs, show: (frame: Frame | null) => hud.update(view(frame)) };
}

describe("the 2D board's match result as the deck's modal over the screen", () => {
  it("opens the shared result modal at the end, with no result card in the pane", () => {
    const { host, dialogs, show } = mount();
    show(frameOf({ ended: false }));
    expect(dialogs()).toHaveLength(1);
    const dialog = dialogs()[0]!;
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true }));
    expect(dialog.open).toBe(true);
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toBe("Very Large Colony wins");
    expect(dialog.byClass("d1-result-how")[0]!.textContent).toBe("Queens killed");
    expect(dialog.byClass("d1-ratings")[0]!.textContent).toBe("Unrated match · no rating change");
    expect(host.byClass("d2-result")).toHaveLength(0);
    expect(host.byClass("d2-pane")[0]!.byClass("d1-result")).toHaveLength(0);
  });

  it("closes and stays closed for that match, and opens again for the next match with the same result", () => {
    const { dialogs, show } = mount();
    show(frameOf({ ended: true }));
    const dialog = dialogs()[0]!;
    dialog.byClass("d1-close")[0]!.click();
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: true, atMs: TICK * 100 + 11_000 }));
    expect(dialog.open).toBe(false);
    show(frameOf({ ended: false, match: 2 }));
    show(frameOf({ ended: true, match: 2 }));
    expect(dialog.open).toBe(true);
  });

  it("names each rating line's player by its display name, its level and Fast badges as tags, then the change; no antwars/ handle", () => {
    const { dialogs, show } = mount();
    const f = frameOf({ ended: true });
    f.board!.setup.rated = true;
    f.board!.agents = [agent(0, "antwars/gpt-6-luna", 1198.33), agent(1, "tidewater", 1488.6)];
    f.board!.result = { ...f.board!.result!, ratingChanges: [{ agent: 0, before: 1198.33, after: 1144.46 }, { agent: 1, before: 1488.6, after: 1542.47 }] };
    show(f);
    const ratings = dialogs()[0]!.byClass("d1-ratings")[0]!;
    const [luna, tide] = ratings.children;
    expect(luna!.byClass("d1-rating-name")[0]!.textContent).toBe("GPT-6 Luna");
    expect(luna!.byClass("d1-tag").map(tag => tag.textContent)).toEqual(["max", "Fast"]);
    expect(luna!.byClass("d1-rating-change")[0]!.textContent).toBe("· Rating 1198 → 1144 (-54)");
    // Read whole, as assistive technology hears it.
    expect(luna!.textContent).toBe("GPT-6 Luna max Fast · Rating 1198 → 1144 (-54)");
    expect(tide!.byClass("d1-tag")).toHaveLength(0);
    expect(tide!.textContent).toBe("tidewater · Rating 1489 → 1542 (+53)");
    expect(ratings.textContent).not.toContain("antwars/");
  });

  it("closes with no frame and leaves with the HUD", () => {
    const { host, hud, dialogs, show } = mount();
    show(frameOf({ ended: true }));
    const dialog = dialogs()[0]!;
    show(null);
    expect(dialog.open).toBe(false);
    hud.destroy();
    expect(host.all().some(node => node === dialog)).toBe(false);
  });

  it("carries the deck's text resets on the modal itself, so it reads the same outside the deck", () => {
    expect(DECK_CSS).toContain(".d1-result-dialog :where(p, ol, ul) { margin: 0; padding: 0; }");
    expect(DECK_CSS).toContain(".d1-result-dialog :where(ol, ul) { list-style: none; }");
    // Before the modal's own rules, which set their margins over it.
    expect(DECK_CSS.indexOf(".d1-result-dialog :where(p, ol, ul)")).toBeLessThan(DECK_CSS.indexOf(".d1-ratings {"));
  });

  it("keeps none of the old card's styles", () => {
    expect(UI_CSS).not.toMatch(/\.d2-result/);
    expect(UI_CSS).not.toMatch(/\.d2-moment/);
  });
});

describe("Share on X in the result modal", () => {
  const LOBBY = "https://antwars.example/?lobby=public-3";
  const shareOf = (dialog: ElementPort) => dialog.byClass("d1-share")[0]!;
  const posted = (href: string) => new URL(href).searchParams.get("text");

  it("links a public match's result to an X post intent in a new tab, with the approved win wording", () => {
    const { hud, dialogs } = mount();
    hud.update({ ...view(frameOf({ ended: true })), share: LOBBY });
    const link = shareOf(dialogs()[0]!);
    expect(link.tag).toBe("a");
    expect(link.hidden).toBe(false);
    expect(link.textContent).toBe("Share on X");
    // The site's cyan button; its dark text holds under the dialog in the 2D board's .d2 root, whose links inherit.
    expect(link.classes()).toEqual(["d1-agent-button", "d1-share"]);
    expect(UI_CSS).toContain(".d2 a { color: inherit; }");
    expect(DECK_CSS).toContain(".d1-dialog .d1-agent-button { color: var(--aw-bg); }");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const href = link.getAttribute("href")!;
    expect(href.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(posted(href)).toBe(`fennec/forager beat tidewater on Antwars — Queens killed. Watch: ${LOBBY}`);
  });

  it("shows no Share link for a private match, nor before the end", () => {
    const { hud, dialogs, show } = mount();
    hud.update({ ...view(frameOf({ ended: false })), share: LOBBY });
    show(frameOf({ ended: true }));
    const link = shareOf(dialogs()[0]!);
    expect(dialogs()[0]!.open).toBe(true);
    expect(link.hidden).toBe(true);
    expect(link.getAttribute("href")).toBeNull();
  });
});
