import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { openRecording, PLAYBACK_RATES, SCAN_RETRY_MS, type Recording } from "../../web/src/recording.ts";
import { groupMarks, mountReplayControls, replayTime } from "../../web/src/replay-controls.ts";
import type { ReplayEvent } from "../../web/src/replay-events.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

/** Only the external DOM port. Production Recording and all control handlers run unchanged. */
class Element {
  className = ""; textContent = ""; value = ""; type = ""; min = ""; max = ""; step = ""; disabled = false; hidden = false; innerHTML = "";
  attrs: Record<string, string> = {}; children: Element[] = []; parent: Element | null = null; style: Record<string, string> = {};
  // Layout as the 3D deck's desktop row measures it (capture of the replay screen at 1280px).
  offsetLeft = 111.4; offsetTop = 4; offsetWidth = 230.4; offsetHeight = 28; clientWidth = 419.7;
  onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  onpointerdown: (() => void) | null = null; onpointerup: (() => void) | null = null;
  onpointercancel: (() => void) | null = null; onblur: (() => void) | null = null;
  onclick: ((event: { detail: number }) => void) | null = null; onfocus: (() => void) | null = null;
  onpointerenter: ((event: { pointerType: string }) => void) | null = null; onpointerleave: ((event: { pointerType: string }) => void) | null = null;
  focused = false;
  readonly classes = new Set<string>();
  classList = { toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); } };
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes: Element[]) { this.children = []; this.append(...nodes); }
  contains(node: Element | null): boolean { return node === this || this.children.some(c => c.contains(node)); }
  focus() { this.focused = true; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  get text(): string { return this.textContent + this.children.map(c => c.text).join(""); }
}
const fakeDoc = () => ({ createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element("#text"), { textContent: text }) }) as unknown as Document;
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
    expect(source.match(/mountReplayControls\(document, input\.recording\)/g)).toHaveLength(count);
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
  function marked(events: readonly ReplayEvent[] | null = DRAWN, position = 391_600) {
    const seeks: number[] = [];
    const recording = { rate: 1, duration: DRAWN_MS, position, error: null, durationError: null, seeking: false, events,
      setRate() {}, seek(ms: number) { seeks.push(ms); } } as unknown as Recording;
    const controls = mountReplayControls(fakeDoc(), recording);
    const el = controls.el as unknown as Element;
    const layer = el.children.find(c => c.className === "aw-marks");
    const chip = el.children.find(c => c.className === "aw-mark-label");
    const list = el.children.find(c => c.className === "aw-mark-list");
    return { controls, el, layer, chip, list, seeks, marks: layer?.children ?? [] };
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

  it("does not draw a mark under the thumb, and keeps the rest of its group", () => {
    const words = (marks: Element[]) => marks.map(b => b.attrs["aria-label"]);
    // Playback at 3:25: the food mark sits under the thumb; the others stay.
    expect(words(marked(DRAWN, 205_000).marks)).toEqual(["Fight, 2:13", "2 marks, 8:39 to 9:13", "4 marks, 12:00 to 13:04"]);
    // Playback at 12:00: the thumb covers 12:00 and 12:07; 12:56 and 13:04 stay a group to choose from.
    const m = marked(DRAWN, 720_400);
    expect(words(m.marks)).toEqual(["Fight, 2:13", "Food lead, Very Large Colony, 3:25", "2 marks, 8:39 to 9:13", "2 marks, 12:56 to 13:04"]);
    m.marks[3]!.onclick!({ detail: 1 });
    m.list!.children[0]!.onclick!({ detail: 1 });
    expect(m.seeks).toEqual([776_700]);
    m.controls.close();
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
