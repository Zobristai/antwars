import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { packMessages, TICK_MS } from "../../src/live/snapshot.ts";
import { openRecording, PLAYBACK_RATES, SCAN_RETRY_MS, serveMarks, type MarksPort, type MarksWorker, type Recording } from "../../web/src/recording.ts";
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

  it("does not draw the mark playback is at under the thumb, and keeps every other moment the thumb covers to choose", () => {
    const words = (marks: Element[]) => marks.map(b => b.attrs["aria-label"]);
    // Playback at 3:25: the food mark sits under the thumb; the others stay.
    expect(words(marked(DRAWN, 205_000).marks)).toEqual(["Fight, 2:13", "2 marks, 8:39 to 9:13", "4 marks, 12:00 to 13:04"]);
    // Playback at 12:00: 12:00 is under the thumb; 12:07, under it too, stands beside it and joins 12:56 and 13:04.
    const m = marked(DRAWN, 720_400);
    expect(words(m.marks)).toEqual(["Fight, 2:13", "Food lead, Very Large Colony, 3:25", "2 marks, 8:39 to 9:13", "3 marks, 12:07 to 13:04"]);
    m.marks[3]!.onclick!({ detail: 1 });
    m.list!.children[0]!.onclick!({ detail: 1 });
    expect(m.seeks).toEqual([727_500]);
    m.controls.close();
    // Playback at 12:03: the thumb covers 12:00 and 12:07, neither at its moment; each stands beside it, on its own side.
    const between = marked(DRAWN, 723_000);
    expect(words(between.marks)).toEqual([
      "Fight, 2:13", "Food lead, Very Large Colony, 3:25", "2 marks, 8:39 to 9:13", "Nest lost, Lake Hodges Colony, 12:00", "3 marks, 12:07 to 13:04",
    ]);
    between.marks[3]!.onclick!({ detail: 1 });
    expect(between.seeks).toEqual([720_400]);
    between.controls.close();
    // Playback at the end: 13:04 is under the thumb; 12:56, covered with no room after it, stands before it with 12:00 and 12:07.
    expect(words(marked(DRAWN, DRAWN_MS).marks)).toEqual(["Fight, 2:13", "Food lead, Very Large Colony, 3:25", "2 marks, 8:39 to 9:13", "3 marks, 12:00 to 12:56"]);
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
