// What the board hands the visible HUDs at mount (ui/types.ts HudHost) and what the 2D HUD paints from the shared view,
// now that neither HUD reads or borrows from the board's hidden overlay root. Mounted on the test port; not visual
// evidence (the served build's captures are that).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamAgent, StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { Overlays } from "../../web/src/overlays.ts";
import { agentShade } from "../../web/src/squads.ts";
import { COPIED, mcpAddress } from "../../web/src/agent.ts";
import { BACK_TEXT, OFFER_TEXT, modeCopy } from "../../web/src/replay.ts";
import { mountHud } from "../../web/src/ui/hud.ts";
import { mountDeckHud } from "../../web/src/ui/deck/hud.ts";
import type { HudActions, HudHost, HudView } from "../../web/src/ui/types.ts";
import type { ModeCopy } from "../../web/src/replay.ts";
import { dom, type ElementPort } from "./pages/dom.ts";

/**
 * The real HUDs by default. With `fake.on`, a mount records what the host handed it and every view it published
 * instead, so the host's own wiring (Overlays) is observed without drawing a HUD.
 */
const fake = vi.hoisted(() => ({
  on: false,
  /** The window the next recorded HUD reports from the moment it mounts. */
  nextArea: null as { x0: number; y0: number; x1: number; y1: number } | null,
  mounted: [] as { context: unknown; deck: boolean; update: ReturnType<typeof import("vitest").vi.fn>; destroy: ReturnType<typeof import("vitest").vi.fn>; area: { x0: number; y0: number; x1: number; y1: number } | null }[],
}));
vi.mock("../../web/src/ui/hud.ts", async (original) => {
  const real = await original<typeof import("../../web/src/ui/hud.ts")>();
  return { ...real, mountHud: (context: HudHost) => fake.on ? recordMount(context, false) : real.mountHud(context) };
});
vi.mock("../../web/src/ui/deck/hud.ts", async (original) => {
  const real = await original<typeof import("../../web/src/ui/deck/hud.ts")>();
  return { ...real, mountDeckHud: (context: HudHost) => fake.on ? recordMount(context, true) : real.mountDeckHud(context) };
});
function recordMount(context: HudHost, deck: boolean) {
  const mounted = { context, deck, update: vi.fn(), destroy: vi.fn(), area: fake.nextArea };
  fake.nextArea = null;
  fake.mounted.push(mounted);
  return { update: mounted.update, destroy: mounted.destroy, boardArea: () => mounted.area ?? undefined };
}

const actions = { hover() {}, trails() {}, tilt() {}, focusMark() {}, select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;
const view = (mode: ModeCopy | null, frame: Frame | null = new Frame()): HudView => ({ frame, connection: "live", board: "2d", selected: null, selectedAgent: -1, mode, stalled: false });

type Parts = Partial<Pick<HudHost, "tips" | "replay" | "teamView" | "waiting" | "boardAspect">>;
function mount(deck: boolean, parts: Parts = {}, size?: { w: number; h: number }) {
  const port = dom({ search: "" });
  Object.assign(port.win.location, { href: "https://antwars.example/?watch=1", pathname: "/" });
  if (size) Object.assign(port.win, { innerWidth: size.w, innerHeight: size.h });
  const host = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(host);
  const context = { doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions, ...parts } as unknown as HudHost;
  const hud = (deck ? mountDeckHud : mountHud)(context);
  return { port, host, hud, root: host.children[0]! };
}
const part = (port: ReturnType<typeof dom>, cls: string) => {
  const node = port.doc.createElement("div") as unknown as ElementPort;
  node.className = cls;
  return node;
};

afterEach(() => { vi.unstubAllGlobals(); fake.on = false; fake.mounted.length = 0; fake.nextArea = null; });

describe("the 2D HUD's status line from the shared view", () => {
  // Catches: the 2D line going blank or losing Back to live once no hidden mode line exists to read.
  it("paints the label, the detail, the recording style and Back to live from view.mode", () => {
    const { hud, host } = mount(false);
    const line = () => {
      const status = host.byClass("d2-status")[0]!, back = host.byClass("d2-back")[0]!;
      return { label: host.byClass("d2-mode-label")[0]!.textContent, detail: host.byClass("d2-mode-detail")[0]!.textContent,
        recorded: status.classList.contains("is-replay"), back: back.hidden ? null : [back.textContent, back.getAttribute("href")] };
    };
    const recording = modeCopy("replay", 4, false, "/", null, true);
    hud.update(view(recording));
    expect(line()).toEqual({ label: "RECORDING · not live · rated match · 4 agents", detail: "", recorded: true, back: [BACK_TEXT, "/?watch=1"] });
    const live = modeCopy("live", 2, false, "/", null, true);
    hud.update(view(live));
    expect(line()).toMatchObject({ label: "LIVE · rated match", recorded: false, back: null });
    expect(line().detail).toContain("behind the match");
    // Live with no agents offers the recording in the pane, never on the line.
    const empty = modeCopy("live", 0, false, "/", null, false);
    expect(empty.link).toEqual({ text: OFFER_TEXT, href: "?replay" });
    hud.update(view(empty));
    expect(line()).toMatchObject({ label: "LIVE · unrated match", recorded: false, back: null });
    // No match yet: the line says so, styled as not live, whatever the mode says.
    hud.update(view(recording, null));
    expect(line()).toEqual({ label: "No live match", detail: "", recorded: true, back: null });
  });

  // Catches: a recording's harness phase cut with its date on the wide line (it rode the detail, the one part an ellipsis
  // shortens), or broken inside itself on a phone.
  it("paints a recording's harness phase as a part of its own after the date, and none without one", () => {
    const { hud, host } = mount(false);
    const part = (cls: string) => host.byClass(cls)[0]!;
    const phased = modeCopy("replay", 2, false, "/", "2026-10-26T01-38-33-692Z-1", true, undefined, ["Harness: rounds 1-7", "Possible effort mismatch"]);
    hud.update(view(phased));
    expect(part("d2-mode-detail").textContent).toBe("26 Oct 2026");
    expect(part("d2-mode-phase").textContent).toBe(phased.phase);
    expect(part("d2-status").classList.contains("has-phase")).toBe(true);
    // The parts in order: the label, the date, the phase, then Back to live.
    expect(part("d2-status").children.map(node => node.className)).toEqual(["d2-mode-label", "d2-mode-detail", "d2-mode-phase", "d2-connection", "d2-back"]);
    hud.update(view(modeCopy("replay", 2, false, "/", "2026-10-26T01-38-33-692Z-1", true)));
    expect([part("d2-mode-detail").textContent, part("d2-mode-phase").textContent]).toEqual(["26 Oct 2026", ""]);
    expect(part("d2-status").classList.contains("has-phase")).toBe(false);
  });
});

describe("the board's live controls handed to each HUD", () => {
  // Catches: a control, the tooltips or the no-board message lost once the HUDs no longer find them in the overlay root.
  it("places the tooltips at its root, the transport, the point-of-view choice first among the controls, and the no-board message in the window", () => {
    for (const deck of [false, true]) {
      const port = dom();
      const tips = [part(port, "aw-tip"), part(port, "aw-tip")];
      const replay = part(port, "aw-replay-controls"), teamView = part(port, "aw-team-view"), waiting = part(port, "aw-waiting");
      const { root, host } = mount(deck, { tips, replay, teamView, waiting } as unknown as Parts);
      expect(tips.map(t => t.parentElement)).toEqual([root, root]);
      const transport = host.byClass(deck ? "d1-transport" : "d2-transport")[0]!;
      expect(replay.parentElement).toBe(transport);
      expect(transport.hidden).toBe(false);
      const controls = host.byClass(deck ? "d1-controls" : "d2-cluster")[0]!;
      expect(controls.children[0]).toBe(teamView);
      if (!deck) {
        expect(root.classList.contains("has-transport")).toBe(true);
        expect(waiting.parentElement).toBe(host.byClass("d2-stage")[0]);
      }
    }
  });

  it("shows no transport where no replay controls are given", () => {
    for (const deck of [false, true]) {
      const { host, root } = mount(deck);
      if (deck) expect(host.byClass("d1-transport")[0]!.hidden).toBe(true);
      else expect(root.classList.contains("has-transport")).toBe(false);
    }
  });

  // Catches: Bring your agent losing its address and Copy in 2D and with no board, once nothing is borrowed.
  it("builds the 2D HUD's own address row, whose Copy copies the page's MCP address and says so", async () => {
    const writes: string[] = [];
    const port = dom();
    Object.assign(port.win.navigator, { clipboard: { writeText: async (text: string) => { writes.push(text); } } });
    const host = port.doc.createElement("div") as unknown as ElementPort;
    port.body.append(host);
    mountHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
    const join = host.byClass("d2-join")[0]!;
    expect(join.hidden).toBe(false);
    const row = join.byClass("aw-byoa-address")[0]!;
    expect(row.byClass("aw-byoa-url")[0]!.textContent).toBe(mcpAddress("https://antwars.example"));
    row.byClass("aw-byoa-copy")[0]!.click();
    await vi.waitFor(() => expect(row.byClass("aw-byoa-note")[0]!.textContent).toBe(COPIED));
    expect(writes).toEqual(["https://antwars.example/mcp"]);
  });

  // Catches: the 2D window sized by the setup's ratio instead of the board's frame once no hidden root carries it.
  it("sizes the narrow 2D window by the given board aspect, and by the setup's ratio only without one", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    const height = (boardAspect: number | null) => {
      const { root } = mount(false, { boardAspect }, { w: 390, h: 844 });
      return (root.style.getPropertyValue as (k: string) => string)("--d2-window-h");
    };
    expect(height(2)).toBe("195px");
    expect(height(1.318407960199005)).toBe(`${Math.round(390 / 1.318407960199005)}px`);
    // Without one, and before any frame: the page's 4 / 3.
    expect(height(null)).toBe(`${Math.round(390 / (4 / 3))}px`);
  });
});

// The host's own wiring, moved from the retired dock.test.ts (its host groups) and stage-sizing.test.ts: what Overlays
// hands a HUD, publishes to it, and keeps for the board, observed through recorded mounts.
const SUB = 256;
const hudAgent = (colony: 0 | 1, order: StreamAgent["order"], x: number, y: number): StreamAgent =>
  ({ colony, modelLabel: "", joinTick: 0, lastCallTick: 1000, prevCallTick: -1, order, orderX: x, orderY: y, intent: "" });
const AGENTS = [hudAgent(0, "attack", 50, 24), hudAgent(0, "forage", 0, 0), hudAgent(1, "hold", 10, 10)];
function match(tick: number, agents: StreamAgent[] = AGENTS): StreamMessage {
  return {
    tick,
    ants: { count: 0, id: new Uint32Array(0), x: new Uint16Array(0), y: new Uint16Array(0), heading: new Uint8Array(0), colony: new Uint8Array(0), agent: new Int16Array(0) },
    full: {
      match: 1,
      setup: { mapW: 64, mapH: 48, ticksPerSecond: 10, matchTicks: 18000, idleTicks: 300, overrunRadiusTiles: 2, queens: [[8 * SUB, 24 * SUB], [55 * SUB, 24 * SUB]] },
      territory: new Uint8Array(64 * 48), agents, marks: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null,
    },
    events: [],
  };
}
/** A host on the test port with recorded HUDs, the board's handlers recorded, shown the opening board. */
function host(board: "2d" | "3d" | "unavailable" = "2d") {
  fake.on = true;
  const port = dom();
  vi.stubGlobal("document", port.doc);
  vi.stubGlobal("window", port.win);
  const parent = port.doc.createElement("div") as unknown as ElementPort;
  port.body.append(parent);
  // The port's elements carry no ownerDocument; the page's parent is body.
  Object.assign(parent, { ownerDocument: port.doc });
  const targets: ([number, number] | null)[] = [], colours: number[] = [], hovers: number[] = [], calls: string[] = [];
  const overlays = new Overlays(parent as unknown as HTMLElement, {
    hover: (agent) => { hovers.push(agent); calls.push(`hover ${agent}`); },
    focusMark() {},
    target: (tile, colour) => { targets.push(tile); colours.push(colour); calls.push(`target ${tile}`); },
  }, board);
  const playback = new Playback();
  const frame = new Frame();
  const show = (m: StreamMessage) => {
    playback.push(m, m.tick * TICK_MS);
    expect(playback.sample(m.tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
    overlays.update(frame);
    return frame;
  };
  show(match(1000));
  const mount = (deck = false) => {
    overlays.mountHud({ deck, replay: null, teamView: null, waiting: null });
    return fake.mounted.at(-1)!;
  };
  return { port, parent, overlays, show, frame, mount, targets, colours, hovers, calls };
}
const lastView = (m: { update: ReturnType<typeof vi.fn> }) => m.update.mock.calls.at(-1)![0] as HudView;

describe("the HUD's host", () => {
  // The HUD's Agents rows lit an order only on pointer enter/leave, so a pointer held still
  // over a row kept an old tile lit. One owner (Overlays) holds the pointed agent and reads its tile from every frame.
  it("keeps the HUD's pointed order on the order each frame shows, and lets it go with its agent, the board or the pointer", () => {
    const { overlays, mount, show, targets, colours, frame } = host();
    const { pointOrder } = (mount().context as HudHost).actions;
    pointOrder(0);
    expect(targets.at(-1)).toEqual([50, 24]);
    // Lit in its agent's hue, not the page's ink.
    expect(colours.at(-1)).toBe(agentShade(0, 0, frame.board!.agents));
    expect(colours.at(-1)).not.toBe(0xffffff);
    // The pointer stays still while the order moves, then changes to one that goes nowhere, then targets again.
    show(match(1001, [hudAgent(0, "go_to", 40, 30), AGENTS[1]!, AGENTS[2]!]));
    expect(targets.at(-1)).toEqual([40, 30]);
    show(match(1002, [hudAgent(0, "forage", 0, 0), AGENTS[1]!, AGENTS[2]!]));
    expect(targets.at(-1)).toBeNull();
    show(match(1003, [hudAgent(0, "hold", 12, 13), AGENTS[1]!, AGENTS[2]!]));
    expect(targets.at(-1)).toEqual([12, 13]);
    pointOrder(-1);
    expect(targets.at(-1)).toBeNull();
    // Its agent leaves the stream: the light goes and does not come back with a later agent at that place.
    pointOrder(2);
    expect(targets.at(-1)).toEqual([10, 10]);
    show(match(1004, [AGENTS[0]!, AGENTS[1]!]));
    expect(targets.at(-1)).toBeNull();
    show(match(1005));
    expect(targets.at(-1)).toBeNull();
    // The board goes (stream lost): the light goes with it.
    pointOrder(2);
    expect(targets.at(-1)).toEqual([10, 10]);
    overlays.update(new Frame());
    expect(targets.at(-1)).toBeNull();
  });

  // Catches: a removed agent's squad left highlighted, or its selection kept, once no hidden roster rebuild clears them.
  it("lets a removed agent's hover and selection go with it, hover first, before the board's tile is sent", () => {
    const { overlays, mount, show, hovers, calls } = host();
    const { pointOrder } = (mount().context as HudHost).actions;
    overlays.selectAgent(2);
    overlays.setHover(2);
    pointOrder(2);
    expect(overlays.selectedAgent).toBe(2);
    calls.length = 0;
    // Agents 1 and 2 leave, 2 hovered, selected and pointed: its hover goes (the selection still lit), then its selection.
    show(match(1001, [AGENTS[0]!]));
    expect(overlays.selectedAgent).toBe(-1);
    expect(calls).toEqual(["hover 2", "hover -1", "target null"]);
    expect(hovers.at(-1)).toBe(-1);
    // An agent that stays keeps both.
    overlays.selectAgent(0);
    overlays.setHover(0);
    calls.length = 0;
    show(match(1002, [AGENTS[0]!]));
    expect(overlays.selectedAgent).toBe(0);
    expect(calls).toEqual([]);
  });

  // Regression caught: setOptions({ overlays: false }) hid only the overlay root, leaving the visible HUD showing.
  it("hides and shows the HUD with its controls, without unmounting it", () => {
    const { overlays, mount } = host();
    const mounted = mount();
    const node = (mounted.context as HudHost).host as unknown as ElementPort;
    expect(node.className).toBe("aw-hud");
    overlays.setVisible(false);
    expect(node.hidden).toBe(true);
    overlays.setVisible(true);
    expect(node.hidden).toBe(false);
    expect(mounted.destroy).not.toHaveBeenCalled();
    overlays.mountHud({ deck: false, replay: null, teamView: null, waiting: null });
    expect(fake.mounted).toHaveLength(1);
  });

  // The 3D board mounts the Instrument deck in place of today's HUD, and hands it the page's mode line and
  // playback stall from the board's own state; the 2D board keeps today's HUD.
  it("mounts the deck when the 3D board asks, today's HUD otherwise, and publishes the mode line and stall on change", () => {
    const { overlays, mount } = host("3d");
    const m = mount(true);
    expect(m.deck).toBe(true);
    expect(lastView(m)).toMatchObject({ mode: null, stalled: false, board: "3d" });
    const copy = { label: "LIVE · rated match", detail: "300 s behind the match", link: null };
    overlays.setMode(copy);
    expect(lastView(m)).toMatchObject({ mode: copy, stalled: false });
    const calls = m.update.mock.calls.length;
    overlays.setMode({ ...copy });
    overlays.setStalled(false);
    expect(m.update.mock.calls).toHaveLength(calls);
    overlays.setStalled(true);
    expect(lastView(m)).toMatchObject({ mode: copy, stalled: true });

    expect(host("2d").mount(false).deck).toBe(false);
  });

  // The board sets the stream line every frame; the HUD hears it only on a change,
  // while every frame still reaches the HUD through update.
  it("publishes the stream line to the HUD only when it changes, and every frame regardless", () => {
    const { overlays, mount, frame } = host();
    const { update } = mount(true);
    overlays.setLink("connecting");
    expect(update.mock.calls.at(-1)![0]).toMatchObject({ connection: "connecting" });
    const calls = update.mock.calls.length;
    overlays.setLink("connecting");
    expect(update.mock.calls).toHaveLength(calls);
    overlays.setLink("open");
    expect(update.mock.calls).toHaveLength(calls + 1);
    expect(update.mock.calls.at(-1)![0]).toMatchObject({ connection: "open" });
    overlays.update(frame);
    expect(update.mock.calls).toHaveLength(calls + 2);
    expect(update.mock.calls.at(-1)![0]).toMatchObject({ frame, connection: "open" });
  });

  // Catches: the stable frame ratio not reaching the 2D HUD (its window falling back to the setup's ratio), or an
  // invalid ratio accepted, once no hidden stage allocation carries it.
  it("hands the HUD the board's frame ratio at mount, and refuses an invalid one without changing it", () => {
    const { overlays, mount } = host();
    overlays.setBoardAspect(4 / 3);
    for (const invalid of [0, -1, NaN, Infinity, -Infinity]) expect(() => overlays.setBoardAspect(invalid)).toThrow(RangeError);
    expect((mount().context as HudHost).boardAspect).toBe(4 / 3);
    const other = host();
    other.overlays.setBoardAspect(null);
    expect((other.mount().context as HudHost).boardAspect).toBeNull();
  });

  // Catches: the board fitted to, or its labels kept clear of, the wrong area: the whole screen once a HUD has its
  // window, or a stale area after the HUD's window changes.
  it("gives the board the whole screen before the HUD mounts and the HUD's window after, with every other part blocked", () => {
    const { overlays, mount } = host();
    expect(overlays.boardArea(1440, 900)).toEqual({ x0: 0, y0: 0, x1: 1440, y1: 900 });
    expect(overlays.blocked()).toEqual([]);
    const mounted = mount();
    mounted.area = { x0: 24, y0: 100, x1: 1000, y1: 800 };
    expect(overlays.boardArea(1440, 900)).toEqual(mounted.area);
    expect(overlays.blocked()).toEqual([
      { x0: 0, y0: 0, x1: 1440, y1: 100 },
      { x0: 0, y0: 800, x1: 1440, y1: 900 },
      { x0: 0, y0: 100, x1: 24, y1: 800 },
      { x0: 1000, y0: 100, x1: 1440, y1: 800 },
    ]);
    mounted.area = { x0: 0, y0: 0, x1: 1440, y1: 700 };
    overlays.boardArea(1440, 900);
    expect(overlays.blocked()).toEqual([{ x0: 0, y0: 700, x1: 1440, y1: 900 }]);
  });

  // Catches: the first frame's labels placed under the HUD because its window is measured only on a later resize.
  it("measures the HUD's window as it mounts, so the first frame's labels keep clear of it", () => {
    const { overlays, mount } = host();
    overlays.boardArea(1440, 900);
    fake.nextArea = { x0: 0, y0: 50, x1: 1440, y1: 850 };
    mount();
    expect(overlays.blocked()).toEqual([{ x0: 0, y0: 0, x1: 1440, y1: 50 }, { x0: 0, y0: 850, x1: 1440, y1: 900 }]);
  });
});
