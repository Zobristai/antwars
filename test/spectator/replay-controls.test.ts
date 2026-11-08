import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { openRecording, PLAYBACK_RATES, type Recording } from "../../web/src/recording.ts";
import { mountReplayControls, replayTime } from "../../web/src/replay-controls.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

/** Only the external DOM port. Production Recording and all control handlers run unchanged. */
class Element {
  className = ""; textContent = ""; value = ""; type = ""; min = ""; max = ""; step = ""; disabled = false;
  attrs: Record<string, string> = {}; children: Element[] = []; parent: Element | null = null;
  onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  onpointerdown: (() => void) | null = null; onpointerup: (() => void) | null = null;
  onpointercancel: (() => void) | null = null; onblur: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
}
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
  const doc = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
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
  const doc = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
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
