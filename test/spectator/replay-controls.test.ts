import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { packMessages, TICK_MS } from "../../src/live/snapshot.ts";
import { openRecording, PLAYBACK_RATES, SCAN_RETRY_MS, serveMarks, type MarksPort, type MarksWorker, type Recording } from "../../web/src/recording.ts";
import { groupMarks, markWords, mountReplayControls, replayTime } from "../../web/src/replay-controls.ts";
import { colonyNameNote, type ColonyNamePair } from "../../src/sim/colonyNames.ts";
import type { ReplayEvent } from "../../web/src/replay-events.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

/** Only the external DOM port. Production Recording and all control handlers run unchanged. */
class Element {
  className = ""; textContent = ""; value = ""; type = ""; min = ""; max = ""; step = ""; disabled = false; hidden = false; innerHTML = "";
  attrs: Record<string, string> = {}; children: Element[] = []; parent: Element | null = null;
  style: Record<string, string> & { setProperty(name: string, value: string): void } =
    Object.assign(Object.create({ setProperty(this: Record<string, string>, name: string, value: string) { this[name] = value; } }) as Record<string, string>, {}) as never;
  // Layout as the 3D deck's desktop row measures it (capture of the replay screen at 1280px).
  offsetLeft = 111.4; offsetTop = 4; offsetWidth = 230.4; offsetHeight = 28; clientWidth = 419.7;
  /** The box's top in the window: the deck's replay row sits at the foot of an 800px desktop window. */
  rectTop = 756; scrollTop = 0;
  getBoundingClientRect() { return { top: this.rectTop }; }
  closest(selectors: string): Element | null {
    const names = selectors.split(",").map(s => s.trim().replace(/^\./, ""));
    for (let e: Element | null = this; e; e = e.parent) if (e.className.split(" ").some(c => names.includes(c))) return e;
    return null;
  }
  onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  onpointerdown: (() => void) | null = null; onpointerup: (() => void) | null = null;
  onpointercancel: (() => void) | null = null; onblur: (() => void) | null = null;
  onclick: ((event: { detail: number }) => void) | null = null; onfocus: (() => void) | null = null;
  onpointerenter: ((event: { pointerType: string }) => void) | null = null; onpointerleave: ((event: { pointerType: string }) => void) | null = null;
  focused = false;
  /** Set on a document that follows focus as a browser does: one focused element, with blur and focus handlers run. */
  owner: { activeElement: Element | null; tracksFocus: boolean } | null = null;
  readonly classes = new Set<string>();
  classList = { toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); } };
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes: Element[]) { this.children = []; this.append(...nodes); }
  contains(node: Element | null): boolean { return node === this || this.children.some(c => c.contains(node)); }
  focus() {
    this.focused = true;
    const doc = this.owner;
    if (!doc?.tracksFocus || doc.activeElement === this) return;
    const was = doc.activeElement;
    doc.activeElement = this;
    if (was) { was.focused = false; was.onblur?.(); }
    this.onfocus?.();
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  get text(): string { return this.textContent + this.children.map(c => c.text).join(""); }
}
const fakeDoc = (tracksFocus = false) => {
  const doc = { activeElement: null as Element | null, tracksFocus,
    createElement: (tag: string) => Object.assign(new Element(tag), { owner: doc }),
    createTextNode: (text: string) => Object.assign(new Element("#text"), { textContent: text }) };
  return doc as unknown as Document;
};
const packets = scale2Packets(45);
const bytes = packMessages(packets);
const active: Recording[] = [];
afterEach(() => { for (const r of active.splice(0)) r.close(); });
async function page() {
  const recording = openRecording("/replay", undefined, async () => new Response(new Uint8Array(bytes)),  {
    controls: true, endTick: async () => decodeMessage(packets.at(-1)!).tick,
  });
  active.push(recording);
  await recording.first;
  await vi.waitFor(() => expect(recording.duration).toBe(4400));
  const doc = fakeDoc();
  const status = new Element("div");
  const controls = mountReplayControls(doc, recording);
  status.append(controls.el as unknown as Element);
  const el = status.children[0]!;
  const [label, seek, output, state] = el.children as [Element, Element, Element, Element];
  return { recording, controls, status, el, seek, speed: label.children[0]!, output, state };
}

it("labels native keyboard/touch controls, supports every speed including return to normal, and seeks on change", async () => {
  const p = await page();
  expect(p.el.attrs).toMatchObject({ role: "group", "aria-label": "Replay playback" });
  expect(p.speed.attrs["aria-label"]).toBe("Replay speed");
  expect(p.speed.children.map(e => e.value)).toEqual(["0.5", "1", "2", "4"]);
  for (const rate of [4, 0.5, 2, 1]) {
    p.speed.value = String(rate); p.speed.onchange!();
    expect(p.recording.rate).toBe(rate);
  }
  expect(p.seek.type).toBe("range");
  expect(p.seek.attrs["aria-label"]).toBe("Replay position");
  expect(p.seek.disabled).toBe(false);
  expect(p.seek.max).toBe("4400");
  p.seek.onpointerdown!(); p.seek.value = "3000"; p.seek.oninput!(); p.controls.update();
  expect(p.output.textContent).toBe("0:03 / 0:04");
  expect(p.recording.generation).toBe(0); // Previewing never repeatedly restarts a download.
  p.seek.onchange!(); p.controls.update();
  expect(p.recording.generation).toBe(1);
  expect(p.state.textContent).toBe("Seeking…");
  expect(p.el.attrs["aria-busy"]).toBe("true");
  p.controls.close();
  expect(p.status.children).toHaveLength(0);
});

it.each(PLAYBACK_RATES)("scales recorded time at %sx, bounds hidden-tab catch-up, and returns to normal without a jump", async rate => {
  const p = await page();
  p.recording.setRate(rate);
  p.recording.take(0); p.recording.take(100);
  expect(p.recording.time).toBe(100 * rate);
  p.recording.take(1e9);
  expect(p.recording.time).toBe(350 * rate);
  const before = p.recording.time;
  p.recording.setRate(1);
  p.recording.take(1e9 + 100);
  expect(p.recording.time).toBe(before);
  p.recording.take(1e9 + 200);
  expect(p.recording.time).toBe(before + 100);
});

it("formats elapsed/total times without wrapping minutes", () => {
  expect(replayTime(0)).toBe("0:00"); expect(replayTime(65000)).toBe("1:05"); expect(replayTime(3600000)).toBe("60:00");
});

it("wires the shared controls and fresh playback into 2D, 3D and boardless loops, only for explicit replays", () => {
  for (const file of ["main.ts", "board3d/main3d.ts"]) {
    const source = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
    const count = file === "main.ts" ? 2 : 1;
    expect(source.match(/params\.has\("replay"\) && input\.recording/g)).toHaveLength(count);
    // Marks name colonies by the match's own names, read from its setup.
    expect(source.match(/mountReplayControls\(document, input\.recording, colonyNamesOf\(head\.full!\.setup\)\)/g)).toHaveLength(count);
    // The HUD is given the controls themselves (HudHost.replay), never left to find them.
    expect(source.match(/replay: controls\?\.el \?\? null/g)).toHaveLength(count);
    expect(source.match(/input\.recording\.generation !== replayGeneration/g)).toHaveLength(count);
    expect(source.match(/playback = new Playback\(\);\s*frame = new Frame\(\);/g)).toHaveLength(count);
    expect(source).toContain("endedAt = resultShownAt = null;");
    expect(source).toContain("fallTurned = false;");
  }
  const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  expect(html).toMatch(/\.aw-replay-controls select \{[^}]*min-height: 44px/);
  expect(html).toMatch(/\.aw-replay-controls input \{[^}]*min-height: 44px/);
  expect(html).toMatch(/\.aw-replay-controls \{[^}]*grid-area: transport;[^}]*pointer-events: auto/);
  // Controls participate in the measured header; no fixed/absolute layer covers the status or stage.
  expect(html).not.toMatch(/\.aw-replay-controls[^{}]*\{[^}]*(?:position: fixed|position: absolute)/);
});

it("keeps speed usable while duration is loading or unavailable, but never offers an unbounded seek", async () => {
  let finish!: (value: number | null) => void;
  let requests = 0;
  const r = openRecording("/replay", undefined, async () => ++requests === 1
    ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 503 }), {
    controls: true, endTick: () => new Promise(resolve => { finish = resolve; }),
  });
  active.push(r);
  await r.first;
  const doc = fakeDoc();
  const status = new Element("div");
  const controls = mountReplayControls(doc, r);
  status.append(controls.el as unknown as Element);
  const [label, seek, , state] = status.children[0]!.children as [Element, Element, Element, Element];
  expect(seek.disabled).toBe(true);
  expect(label.children[0]!.disabled).toBe(false);
  expect(state.textContent).toBe("Loading replay duration…");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(null);
  await vi.waitFor(() => expect(r.durationError).not.toBeNull());
  controls.update();
  expect(state.textContent).toBe("Duration unavailable — playback continues");
  expect(seek.disabled).toBe(true);
  expect(label.children[0]!.disabled).toBe(false);
  r.take(0); r.take(100);
  expect(r.time).toBe(100);
});

// The real match on the signed-off drawing: the house 4v4 of 31 Oct 2026, 13:04 long, read with the marks' rules.
const DRAWN: ReplayEvent[] = [
  { kind: "fight", tick: 1338, ms: 133_800, colony: null },
  { kind: "food", tick: 2050, ms: 205_000, colony: 0 },
  { kind: "fight", tick: 5194, ms: 519_400, colony: null },
  { kind: "fight", tick: 5537, ms: 553_700, colony: null },
  { kind: "nest", tick: 7204, ms: 720_400, colony: 1 },
  { kind: "nest", tick: 7275, ms: 727_500, colony: 1 },
  { kind: "nest", tick: 7767, ms: 776_700, colony: 1 },
  { kind: "nest", tick: 7841, ms: 784_100, colony: 1 },
];
const DRAWN_MS = 784_100;

describe("marks on the scrubber", () => {
  function marked(events: readonly ReplayEvent[] | null = DRAWN, position = 391_600, names?: ColonyNamePair) {
    const seeks: number[] = [];
    const recording = { rate: 1, duration: DRAWN_MS, position, error: null, durationError: null, seeking: false, events,
      setRate() {}, seek(ms: number) { seeks.push(ms); } } as unknown as Recording;
    const controls = mountReplayControls(fakeDoc(), recording, names);
    const el = controls.el as unknown as Element;
    const layer = el.children.find(c => c.className === "aw-marks");
    const chip = el.children.find(c => c.className === "aw-mark-label");
    const list = el.children.find(c => c.className === "aw-mark-list");
    return { controls, el, layer, chip, list, seeks, recording, marks: layer?.children ?? [] };
  }

  it("groups as drawn: desktop and phone tracks", () => {
    const words = (groups: ReturnType<typeof groupMarks>) => groups.map(g => g.events.map(e => `${e.kind}@${replayTime(e.ms)}`).join(" "));
    // 3D deck at 1280: a 230px slider, marks closer than 18px join.
    expect(words(groupMarks(DRAWN, DRAWN_MS, 230.4, 18))).toEqual(["fight@2:13", "food@3:25", "fight@8:39 fight@9:13", "nest@12:00 nest@12:07 nest@12:56 nest@13:04"]);
    // 2D board at 390: a 185px slider, marks closer than 28px join.
    expect(words(groupMarks(DRAWN, DRAWN_MS, 184.7, 28))).toEqual(["fight@2:13 food@3:25", "fight@8:39 fight@9:13", "nest@12:00 nest@12:07 nest@12:56 nest@13:04"]);
    // The thumb's travel: the first mark's centre 8px in, the last at the far end less 8px.
    const at = groupMarks([DRAWN[0]!, DRAWN[7]!], DRAWN_MS, 230.4, 18);
    expect(at[0]!.x).toBeCloseTo(8 + (133_800 / DRAWN_MS) * 214.4, 5);
    expect(at[1]!.x).toBeCloseTo(222.4, 5);
  });

  it("draws nothing before the marks are read, and adds no control to the row", () => {
    const m = marked(null);
    expect(m.layer).toBeUndefined();
    expect(m.el.children.map(c => c.tagName)).toEqual(["label", "input", "output", "span"]);
  });

  it("names each mark by kind, colony and time, and a group by its count and span", () => {
    const m = marked();
    expect(m.marks.map(b => b.attrs["aria-label"])).toEqual([
      "Fight, 2:13", "Food lead, Very Large Colony, 3:25", "2 marks, 8:39 to 9:13", "4 marks, 12:00 to 13:04",
    ]);
    expect(m.marks.map(b => b.className)).toEqual(["aw-mark fight", "aw-mark food c0", "aw-mark group", "aw-mark group"]);
    expect(m.marks.every(b => b.tagName === "button")).toBe(true);
    expect(m.marks[3]!.attrs).toMatchObject({ "aria-haspopup": "menu", "aria-expanded": "false" });
  });

  it("jumps to a mark's exact time on click or tap and shows its label", () => {
    const m = marked();
    m.marks[1]!.onclick!({ detail: 1 });
    expect(m.seeks).toEqual([205_000]);
    expect(m.chip!.hidden).toBe(false);
    expect(m.chip!.text).toBe("Food lead · Very Large Colony · 3:25");
    m.controls.close();
  });

  it("shows the label on hover or focus without seeking, and hides it after", () => {
    const m = marked();
    m.marks[0]!.onfocus!();
    expect(m.chip!.text).toBe("Fight · 2:13");
    expect(m.seeks).toEqual([]);
    m.marks[0]!.onblur!();
    expect(m.chip!.hidden).toBe(true);
  });

  it("opens a group's list, jumps from a line, and closes it", () => {
    const m = marked();
    m.marks[3]!.onclick!({ detail: 0 }); // Enter on the focused group
    expect(m.list!.hidden).toBe(false);
    expect(m.list!.children[0]!.focused).toBe(true);
    expect(m.marks[3]!.attrs["aria-expanded"]).toBe("true");
    expect(m.list!.children.map(r => r.attrs["aria-label"])).toEqual([
      "Nest lost, Lake Hodges Colony, 12:00", "Nest lost, Lake Hodges Colony, 12:07",
      "Nest lost, Lake Hodges Colony, 12:56", "Nest lost, Lake Hodges Colony, 13:04",
    ]);
    m.list!.children[1]!.onclick!({ detail: 1 });
    expect(m.seeks).toEqual([727_500]);
    expect(m.list!.hidden).toBe(true);
    expect(m.marks[3]!.attrs["aria-expanded"]).toBe("false");
    expect(m.chip!.text).toBe("Nest lost · Lake Hodges Colony · 12:07");
    m.controls.close();
  });

  it("names colonies by the match's drawn names in every mark's label and accessibility text", () => {
    const drawn: ColonyNamePair = ["Sweetwater Colony", "Lake Skinner Colony"];
    expect(markWords(DRAWN[1]!, drawn)).toEqual(["Food lead", "Sweetwater Colony", "3:25"]);
    expect(markWords(DRAWN[0]!, drawn)).toEqual(["Fight", "2:13"]);
    const m = marked(DRAWN, 391_600, drawn);
    expect(m.marks.map(b => b.attrs["aria-label"])).toEqual([
      "Fight, 2:13", "Food lead, Sweetwater Colony, 3:25", "2 marks, 8:39 to 9:13", "4 marks, 12:00 to 13:04",
    ]);
    m.marks[1]!.onclick!({ detail: 1 });
    expect(m.chip!.text).toBe("Food lead · Sweetwater Colony · 3:25");
    m.marks[3]!.onclick!({ detail: 0 });
    expect(m.list!.children.map(r => r.attrs["aria-label"])).toEqual([
      "Nest lost, Lake Skinner Colony, 12:00", "Nest lost, Lake Skinner Colony, 12:07",
      "Nest lost, Lake Skinner Colony, 12:56", "Nest lost, Lake Skinner Colony, 13:04",
    ]);
    expect(m.list!.children[0]!.text).toBe("Nest lost · Lake Skinner Colony · 12:00");
    // No drawn names (a rated match): the classic names, as before.
    expect(markWords(DRAWN[1]!)).toEqual(["Food lead", "Very Large Colony", "3:25"]);
    m.controls.close();
  });

  it("gives a drawn name its source note in labels and list lines, keeps a pointed label for the mouse to reach it, and leaves rated marks as they were", () => {
    vi.useFakeTimers();
    try {
      const colonyWords = (node: Element): Element[] => node.className.startsWith("aw-mark-colony") ? [node] : node.children.flatMap(colonyWords);
      const drawn: ColonyNamePair = ["Sweetwater Colony", "Lake Skinner Colony"];
      const m = marked(DRAWN, 391_600, drawn);
      // A label: the drawn name in its colony's class (replay-marks.css colours it) with its note.
      m.marks[1]!.onpointerenter!({ pointerType: "mouse" });
      expect(colonyWords(m.chip!).map(w => [w.className, w.textContent, w.attrs.title])).toEqual([
        ["aw-mark-colony c0", "Sweetwater Colony", colonyNameNote("Sweetwater Colony")],
      ]);
      // The mouse leaves the mark for the label: the label waits, and stays while the mouse is on it.
      m.marks[1]!.onpointerleave!({ pointerType: "mouse" });
      expect(m.chip!.hidden).toBe(false);
      m.chip!.onpointerenter!({ pointerType: "mouse" });
      vi.advanceTimersByTime(1000);
      expect(m.chip!.hidden).toBe(false);
      m.chip!.onpointerleave!({ pointerType: "mouse" });
      expect(m.chip!.hidden).toBe(true);
      // Left for anywhere else, it goes after the wait.
      m.marks[1]!.onpointerenter!({ pointerType: "mouse" });
      m.marks[1]!.onpointerleave!({ pointerType: "mouse" });
      vi.advanceTimersByTime(200);
      expect(m.chip!.hidden).toBe(true);
      // A mark naming no colony hides its label at once.
      m.marks[0]!.onpointerenter!({ pointerType: "mouse" });
      m.marks[0]!.onpointerleave!({ pointerType: "mouse" });
      expect(m.chip!.hidden).toBe(true);
      // A group's list: every drawn name with its note.
      m.marks[3]!.onclick!({ detail: 1 });
      expect(m.list!.children.flatMap(colonyWords).map(w => [w.className, w.attrs.title])).toEqual(
        Array(4).fill(["aw-mark-colony c1", colonyNameNote("Lake Skinner Colony")]));
      m.controls.close();

      // Rated (the classic names): no notes, and a pointed label hides as soon as the mouse leaves its mark.
      const r = marked();
      r.marks[1]!.onpointerenter!({ pointerType: "mouse" });
      expect(colonyWords(r.chip!).map(w => [w.textContent, w.attrs.title])).toEqual([["Very Large Colony", undefined]]);
      r.marks[1]!.onpointerleave!({ pointerType: "mouse" });
      expect(r.chip!.hidden).toBe(true);
      r.marks[3]!.onclick!({ detail: 1 });
      expect(r.list!.children.flatMap(colonyWords).every(w => w.attrs.title === undefined)).toBe(true);
      r.controls.close();
    } finally { vi.useRealTimers(); }
  });

  it("colours marks, labels and list names by each colony's name, falling back to the classic colours", () => {
    const css = readFileSync(new URL("../../web/src/replay-marks.css", import.meta.url), "utf8");
    for (const c of [0, 1]) {
      const ink = `color: var(--aw-k${c}, var(--aw-c${c}));`;
      expect(css).toContain(`:is(.aw-mark, .aw-mark-icon).c${c} { ${ink} }`);
      expect(css).toContain(`.aw-mark-colony.c${c} { ${ink} }`);
    }
    // No mark rule names a colony's classic colour on its own any more.
    expect(css).not.toMatch(/color: var\(--aw-c[01]\)/);
  });

  it("keeps every line of a long group's list reachable: the list holds to the board's room over the row and scrolls", () => {
    // Twenty fights 30 s apart on the phone's 2D board: one group whose 44px lines, stacked, are taller than the window.
    const dense: ReplayEvent[] = Array.from({ length: 20 }, (_, i) => ({ kind: "fight", tick: 600 + 300 * i, ms: 60_000 + 30_000 * i, colony: null }));
    const phone: Record<string, string> = { "--aw-mark-gap": "28px", "--aw-mark-row": "44px", "--aw-mark-size": "20px", "--aw-mark-count-width": "26px" };
    const doc = Object.assign(fakeDoc(true), { defaultView: { getComputedStyle: () => ({ getPropertyValue: (name: string) => phone[name] ?? "" }) } }) as unknown as Document;
    const recording = { rate: 1, duration: DRAWN_MS, position: 0, error: null, durationError: null, seeking: false, events: dense,
      setRate() {}, seek() {} } as unknown as Recording;
    const controls = mountReplayControls(doc, recording);
    const el = controls.el as unknown as Element;
    // As the 2D board lays out a 390 x 844 phone: the board's stage below the score panel, the row at its foot.
    const stage = Object.assign(new Element("div"), { className: "d2-stage", rectTop: 270 });
    stage.append(el);
    el.rectTop = 540;
    const marks = el.children.find(c => c.className === "aw-marks")!.children;
    expect(marks.map(b => b.attrs["aria-label"])).toEqual(["20 marks, 1:00 to 10:30"]);
    marks[0]!.onclick!({ detail: 0 }); // Enter on the focused group
    const list = el.children.find(c => c.className === "aw-mark-list")!;
    const rows = list.children;
    expect(rows).toHaveLength(20);
    expect(rows.every(r => r.tagName === "button")).toBe(true);
    expect(rows[0]!.focused).toBe(true);
    // The list stands 6px over the row and grows upward over the board. Laid out as replay-marks.css lays it, its lines
    // keep their 44px and it scrolls inside its height, so a line is reachable when the list's height fits in the board's
    // room over the row (above the stage, the score panel would cover it).
    const css = readFileSync(new URL("../../web/src/replay-marks.css", import.meta.url), "utf8");
    const rule = css.match(/^\.aw-mark-list \{([^}]*)\}/m)![1]!;
    expect(rule).toMatch(/overflow-y: auto/);
    expect(rule).toMatch(/grid-auto-rows: var\(--aw-mark-row\)/);
    const natural = 20 * 44 + 8;
    const max = parseFloat(list.style.maxHeight ?? "");
    const height = Number.isFinite(max) ? Math.min(natural, max) : natural;
    const room = el.rectTop - stage.rectTop - 6;
    expect(natural).toBeGreaterThan(room);
    expect(height).toBeLessThanOrEqual(room);
    // Every line, scrolled to, stands wholly inside the list's height.
    for (let i = 0; i < rows.length; i++) {
      const scroll = Math.min(Math.max(0, 4 + 44 * (i + 1) - (height - 4)), natural - height);
      expect(4 + 44 * i - scroll).toBeGreaterThanOrEqual(0);
      expect(4 + 44 * (i + 1) - scroll).toBeLessThanOrEqual(height);
    }
    // Opened again, the list starts at its first line.
    list.scrollTop = 300;
    marks[0]!.onclick!({ detail: 1 });
    marks[0]!.onclick!({ detail: 0 });
    expect(list.scrollTop).toBe(0);
    controls.close();
  });

  it("opens a group's list when a mouse points at it, but not when a tap reports entering it", () => {
    const m = marked();
    m.marks[2]!.onpointerenter!({ pointerType: "touch" });
    expect(m.list!.hidden).toBe(true);
    m.marks[2]!.onclick!({ detail: 1 }); // the tap itself
    expect(m.list!.hidden).toBe(false);
    expect(m.list!.children[0]!.focused).toBe(false);
    m.marks[2]!.onclick!({ detail: 1 });
    expect(m.list!.hidden).toBe(true);
    m.marks[2]!.onpointerenter!({ pointerType: "mouse" });
    expect(m.list!.children).toHaveLength(2);
    m.controls.close();
  });

  it("keeps a group open when a mouse that opened it by pointing then clicks it", () => {
    const m = marked();
    m.marks[3]!.onpointerenter!({ pointerType: "mouse" });
    expect(m.list!.hidden).toBe(false);
    m.marks[3]!.onclick!({ detail: 1 }); // the click that follows the pointing
    expect(m.list!.hidden).toBe(false);
    m.list!.children[2]!.onclick!({ detail: 1 });
    expect(m.seeks).toEqual([776_700]);
    m.controls.close();
  });

  it("draws marks under the thumb as on the sheet: covered ones take no pointer but keep keyboard focus, and none move", () => {
    const words = (marks: Element[]) => marks.map(b => b.attrs["aria-label"]);
    const covered = (marks: Element[]) => marks.filter(b => b.classes.has("is-covered")).map(b => b.attrs["aria-label"]);
    const drawn = ["Fight, 2:13", "Food lead, Very Large Colony, 3:25", "2 marks, 8:39 to 9:13", "4 marks, 12:00 to 13:04"];
    // Playback at 3:25: the food mark lies under the thumb; the layer is cut away there, and nothing regroups.
    const m = marked(DRAWN, 205_000);
    expect(words(m.marks)).toEqual(drawn);
    expect(covered(m.marks)).toEqual(["Food lead, Very Large Colony, 3:25"]);
    expect(m.layer!.style["--aw-thumb-x"]).toBe(`${(8 + (205_000 / DRAWN_MS) * 214.4).toFixed(1)}px`);
    // Keyboard focus still reaches it and names it.
    m.marks[1]!.onfocus!();
    expect(m.chip!.text).toBe("Food lead · Very Large Colony · 3:25");
    m.marks[1]!.onclick!({ detail: 0 });
    expect(m.seeks).toEqual([205_000]);
    m.controls.close();
    // After 9:13 is chosen, the 8:39 to 9:13 group lies under the thumb until playback moves it off.
    const g = marked(DRAWN, 553_700);
    expect(words(g.marks)).toEqual(drawn);
    expect(covered(g.marks)).toEqual(["2 marks, 8:39 to 9:13"]);
    (g.recording as { position: number }).position = 650_000;
    g.controls.update();
    expect(words(g.marks)).toEqual(drawn);
    expect(covered(g.marks)).toEqual([]);
    g.controls.close();
    // Playback between marks: nothing is covered.
    const between = marked(DRAWN, 391_600);
    expect(covered(between.marks)).toEqual([]);
    between.controls.close();
  });

  describe("when the row changes width during playback", () => {
    // The page's ResizeObserver, fired by hand: the row and the slider are what the controls watch.
    function resizable(position = 391_600) {
      const fired: (() => void)[] = [];
      const doc = Object.assign(fakeDoc(true), { defaultView: {
        ResizeObserver: class { constructor(cb: () => void) { fired.push(cb); } observe() {} disconnect() {} },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
      } }) as unknown as Document;
      const seeks: number[] = [];
      const recording = { rate: 1, duration: DRAWN_MS, position, error: null, durationError: null, seeking: false, events: DRAWN,
        setRate() {}, seek(ms: number) { seeks.push(ms); } } as unknown as Recording;
      const controls = mountReplayControls(doc, recording);
      const el = controls.el as unknown as Element;
      const part = (name: string) => el.children.find(c => c.className === name)!;
      const resize = () => { for (const cb of fired) cb(); controls.update(); };
      return { controls, el, seek: el.children[1]!, layer: part("aw-marks"), chip: part("aw-mark-label"), list: part("aw-mark-list"), seeks, resize,
        focusedNow: () => (doc as unknown as { activeElement: Element | null }).activeElement };
    }

    it("keeps the marks, an open list and a shown label when only the time grows a digit's width", () => {
      const r = resizable();
      const before = [...r.layer.children];
      r.layer.children[0]!.onclick!({ detail: 1 }); // the 2:13 fight: its label shows for a while
      expect(r.chip.hidden).toBe(false);
      r.el.clientWidth += 1; // a wider digit in the time; the slider's box is unchanged
      r.resize();
      expect(r.chip.hidden).toBe(false);
      expect(r.chip.text).toBe("Fight · 2:13");
      expect(r.layer.children).toEqual(before);
      before[3]!.onclick!({ detail: 1 }); // the 4-mark group's list
      r.el.clientWidth += 1;
      r.resize();
      expect(r.list.hidden).toBe(false);
      expect(before[3]!.attrs["aria-expanded"]).toBe("true");
      expect(r.layer.children).toEqual(before);
      r.controls.close();
    });

    it("moves an open list and a shown label with their marks when the slider narrows as the time reaches 10:00", () => {
      const r = resizable(599_000);
      r.list.offsetWidth = r.chip.offsetWidth = 120; // as wide as the drawn list and label, not the whole row
      r.layer.children[2]!.onclick!({ detail: 1 }); // the 2-mark group's list, 8:39 to 9:13
      const listLeft = r.list.style.left;
      r.seek.offsetWidth -= 7; // "10:00" is wider than "9:59", so the slider gives up the width
      r.resize();
      const group = r.layer.children[2]!;
      expect(group.attrs["aria-label"]).toBe("2 marks, 8:39 to 9:13");
      expect(group.attrs["aria-expanded"]).toBe("true");
      expect(r.list.hidden).toBe(false);
      expect(r.list.style.left).not.toBe(listLeft);
      // A line chosen from the moved list jumps there and labels it beside the moved group.
      r.list.children[1]!.onclick!({ detail: 1 });
      expect(r.seeks).toEqual([553_700]);
      expect(r.list.hidden).toBe(true);
      expect(group.attrs["aria-expanded"]).toBe("false");
      expect(r.chip.text).toBe("Fight · 9:13");
      const chipLeft = r.chip.style.left;
      r.seek.offsetWidth -= 7;
      r.resize();
      expect(r.chip.hidden).toBe(false);
      expect(r.chip.text).toBe("Fight · 9:13");
      expect(r.chip.style.left).not.toBe(chipLeft);
      r.controls.close();
    });

    it("keeps a list the mouse opened, and keyboard focus on another mark, when the slider then resizes", () => {
      const r = resizable();
      r.layer.children[0]!.focus(); // keyboard focus on the single 2:13 fight: its label shows
      expect(r.chip.text).toBe("Fight · 2:13");
      r.layer.children[3]!.onpointerenter!({ pointerType: "mouse" }); // the mouse opens the 4-mark group's list
      expect(r.chip.hidden).toBe(true);
      const lines = r.list.children.map(c => c.attrs["aria-label"]);
      expect(lines).toHaveLength(4);
      r.seek.offsetWidth -= 7;
      r.resize();
      // Focus is back on the fight, and the group's list is still open with its moments, not just marked open.
      const [fight, , , group] = r.layer.children as [Element, Element, Element, Element];
      expect(r.focusedNow()).toBe(fight);
      expect(group.attrs["aria-label"]).toBe("4 marks, 12:00 to 13:04");
      expect(group.attrs["aria-expanded"]).toBe("true");
      expect(r.list.hidden).toBe(false);
      expect(r.list.children.map(c => c.attrs["aria-label"])).toEqual(lines);
      expect(r.chip.hidden).toBe(true);
      r.list.children[2]!.onclick!({ detail: 1 });
      expect(r.seeks).toEqual([776_700]);
      r.controls.close();
    });
  });
});

it("reads the marks only for explicit replays: a recording without controls makes no second request and has none", async () => {
  let requests = 0;
  const live = openRecording("/replay", undefined, async () => { requests++; return new Response(new Uint8Array(bytes)); });
  active.push(live);
  await live.first;
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(requests).toBe(1);
  expect(live.events).toBeNull();
  const replay = openRecording("/replay", undefined, async () => { requests++; return new Response(new Uint8Array(bytes)); },
    { controls: true, endTick: async () => decodeMessage(packets.at(-1)!).tick });
  active.push(replay);
  await replay.first;
  await vi.waitFor(() => expect(replay.events).not.toBeNull());
  expect(requests).toBe(3);
});

it("settles an unknown end with the end-only read first, so the slider is usable before the marks' read finishes", async () => {
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const r = openRecording("/replay", undefined, async () => {
    if (++requests === 3) await held; // the marks' read
    return new Response(new Uint8Array(bytes));
  }, { controls: true, endTick: async () => null });
  active.push(r);
  await r.first;
  await vi.waitFor(() => expect(requests).toBe(3));
  expect(r.duration).toBe((decodeMessage(packets.at(-1)!).tick - decodeMessage(packets[0]!).tick) * TICK_MS);
  expect(r.durationError).toBeNull();
  expect(r.events).toBeNull();
  release();
  await vi.waitFor(() => expect(r.events).not.toBeNull());
  expect(requests).toBe(3);
});

it("tries the marks' read again after a failed request, so a passing fault does not leave the replay without marks", async () => {
  let requests = 0;
  const r = openRecording("/replay", undefined, async () => ++requests === 2 ? new Response(null, { status: 503 }) : new Response(new Uint8Array(bytes)),
    { controls: true, endTick: async () => decodeMessage(packets.at(-1)!).tick });
  active.push(r);
  await r.first;
  await vi.waitFor(() => expect(requests).toBe(2));
  expect(r.events).toBeNull();
  expect(r.durationError).toBeNull(); // the stored record gave the end, so the slider works meanwhile
  await vi.waitFor(() => expect(r.events).not.toBeNull(), { timeout: SCAN_RETRY_MS[0]! + 2000 });
  expect(requests).toBe(3);
}, 10_000);

it("keeps trying the marks' read after the listed waits, and at once when the browser is back online", async () => {
  const browser = new EventTarget();
  vi.stubGlobal("addEventListener", browser.addEventListener.bind(browser));
  vi.stubGlobal("removeEventListener", browser.removeEventListener.bind(browser));
  try {
    let requests = 0;
    let online = false;
    const r = openRecording("/replay", undefined, async () => ++requests === 1 || online ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 503 }),
      { controls: true, endTick: async () => decodeMessage(packets.at(-1)!).tick });
    active.push(r);
    await r.first;
    // Every listed wait and one more past the last: each failure waits, and coming back online ends the wait.
    for (let failed = 1; failed <= SCAN_RETRY_MS.length + 1; failed++) {
      await vi.waitFor(() => expect(requests).toBe(1 + failed));
      for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(requests).toBe(1 + failed);
      browser.dispatchEvent(new Event("online"));
    }
    await vi.waitFor(() => expect(requests).toBe(SCAN_RETRY_MS.length + 3));
    expect(r.events).toBeNull();
    online = true;
    browser.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(r.events).not.toBeNull());
    expect(requests).toBe(SCAN_RETRY_MS.length + 4);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("the marks' read in a background worker", () => {
  const end = async () => decodeMessage(packets.at(-1)!).tick;
  // The real worker side (serveMarks) on the far end of a message channel, as replay-events.worker.ts runs it.
  function channelWorker(log: { made: number; terminated: number }): MarksWorker {
    log.made++;
    const { port1, port2 } = new MessageChannel();
    serveMarks(port2 as unknown as MarksPort);
    const worker: MarksWorker = {
      onmessage: null, onerror: null,
      postMessage: (request, transfer) => port1.postMessage(request, transfer),
      terminate() { log.terminated++; port1.close(); port2.close(); },
    };
    port1.onmessage = event => worker.onmessage?.(event as MessageEvent);
    return worker;
  }
  // The recording in many small network chunks, so the hand-over to the worker is paced.
  const chunked = (size = 512) => new ReadableStream<Uint8Array>({
    start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size)); controller.close(); },
  });

  it("gives the marks the page would, from the same one read of the recording, and ends the worker", async () => {
    const onPage = openRecording("/replay", undefined, async () => new Response(new Uint8Array(bytes)), { controls: true, endTick: end, marksWorker: null });
    active.push(onPage);
    await vi.waitFor(() => expect(onPage.events).not.toBeNull());
    const log = { made: 0, terminated: 0 };
    let requests = 0;
    const r = openRecording("/replay", undefined, async () => { requests++; return new Response(chunked()); },
      { controls: true, endTick: end, marksWorker: () => channelWorker(log) });
    active.push(r);
    await vi.waitFor(() => expect(r.events).not.toBeNull());
    expect(r.events).toEqual(onPage.events);
    expect(requests).toBe(2); // playback, then the marks' read: the worker fetches nothing itself
    expect(log).toEqual({ made: 1, terminated: 1 });
  });

  it("hands the worker at most four chunks it has not read yet", async () => {
    const posted: string[] = [];
    let worker!: MarksWorker;
    const r = openRecording("/replay", undefined, async () => new Response(chunked(64)), {
      controls: true, endTick: end,
      marksWorker: () => (worker = { onmessage: null, onerror: null, postMessage: request => { posted.push(request.kind); }, terminate() {} }),
    });
    active.push(r);
    await vi.waitFor(() => expect(posted.filter(k => k === "chunk")).toHaveLength(4));
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(posted.filter(k => k === "chunk")).toHaveLength(4);
    worker.onmessage!({ data: { kind: "ack" } } as MessageEvent);
    await vi.waitFor(() => expect(posted.filter(k => k === "chunk")).toHaveLength(5));
  });

  it("does not read a corrupt recording again, in the worker as on the page", async () => {
    const log = { made: 0, terminated: 0 };
    let requests = 0;
    const gap = packMessages([packets[0]!, ...packets.slice(2)]);
    const r = openRecording("/replay", undefined, async () => ++requests === 1 ? new Response(new Uint8Array(bytes)) : new Response(new Uint8Array(gap)),
      { controls: true, endTick: end, marksWorker: () => channelWorker(log) });
    active.push(r);
    await vi.waitFor(() => expect(log.terminated).toBe(1));
    await new Promise(resolve => setTimeout(resolve, SCAN_RETRY_MS[0]! + 500));
    expect(requests).toBe(2);
    expect(r.events).toBeNull();
  }, 10_000);

  it("reads the marks on the page after the worker fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let made = 0;
      let requests = 0;
      const r = openRecording("/replay", undefined, async () => { requests++; return new Response(new Uint8Array(bytes)); }, {
        controls: true, endTick: end,
        marksWorker: () => {
          made++;
          const worker: MarksWorker = { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
          setTimeout(() => worker.onerror?.({ message: "load failed" } as ErrorEvent), 0);
          return worker;
        },
      });
      active.push(r);
      await vi.waitFor(() => expect(r.events).not.toBeNull(), { timeout: SCAN_RETRY_MS[0]! + 2000 });
      expect(made).toBe(1);
      expect(requests).toBe(3);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/marks worker failed/), expect.anything());
    } finally { error.mockRestore(); }
  }, 10_000);

  it("ends the worker when the replay closes mid-read", async () => {
    let terminated = 0;
    let started = false;
    const r = openRecording("/replay", undefined, async () => new Response(chunked(64)), {
      controls: true, endTick: end,
      marksWorker: () => ({ onmessage: null, onerror: null, postMessage: request => { if (request.kind === "start") started = true; }, terminate() { terminated++; } }),
    });
    await vi.waitFor(() => expect(started).toBe(true));
    r.close();
    expect(terminated).toBe(1);
    expect(r.events).toBeNull();
  });
});
